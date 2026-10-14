import test from 'node:test';
import assert from 'node:assert/strict';
import { Context, Service } from '@deepseek-ai/cordis';
import { installSnapshotTitles } from '../src/snapshot-titles.mjs';
import { contextText } from '../src/draft.mjs';
import { framedTitleInputBytes } from '../src/title-input.mjs';

const providerId = 'session-title-first-prompt-llm';
const capture = {
  appName: 'Google Chrome', title: '流水线构建详情', capturedAt: '2026-10-14T00:00:00.000Z',
  snapshotId: '12345678-1234-4234-8234-123456789abc', text: 'Build running\n'.repeat(800),
};
const snapshotContent = body => [{ type: 'image', attachment: {
  attachmentId: 'accepted-synthetic-image', mediaType: 'image/webp', width: 10, height: 10,
  name: `window-snapshot-${capture.snapshotId}-${capture.capturedAt.replace(/[^0-9TZ]/g, '-')}.png`,
} }, { type: 'text', text: body + contextText(capture) }];
const messageOf = event => ({ seq: event.seq,
  text: event.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n') });
const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture({ knownProvider = true, provider = true, input = snapshotContent(''), beforeTitle, header = {} } = {}) {
  const handlers = [], warnings = [], sessions = new Map(), requests = [];
  const ctx = {
    logger: { warn: value => warnings.push(value) },
    get: name => name === 'sessionTitle' ? titles : name === 'sessions' ? { get: id => sessions.get(id) } : undefined,
    on(name, listener, options) {
      const entry = { name, listener };
      options?.prepend ? handlers.unshift(entry) : handlers.push(entry);
      return () => { const index = handlers.indexOf(entry); if (index >= 0) handlers.splice(index, 1); };
    },
    effect: setup => setup(),
  };
  class Titles {
    registration;
    get(session) { return session.events.findLast(event => event.type === 'session/title')?.data; }
    register(value) {
      if (this.registration) throw new Error('title provider is already registered');
      this.registration = { provider: value, closing: false };
      const receiver = this;
      const dispose = async () => { receiver.registration = undefined; };
      this.lastDisposer = dispose;
      return dispose;
    }
  }
  const titles = new Titles();
  const titleProvider = {
    id: knownProvider ? providerId : 'custom-provider', automatic: 'first-prompt',
    async generate(request) {
      requests.push({ request, receiver: this });
      return { title: '构建流水线状态', messageSeqs: [request.messages[0].seq], model: request.route };
    },
  };
  if (provider) titles.register(titleProvider);
  const session = {
    id: 'synthetic-title-session', header, events: [], publishing: false, pending: false,
    snapshotEvents() { return this.events.slice(); },
    append(type, data) {
      if (this.publishing) throw new Error('session append cannot reenter');
      const event = { type, data: structuredClone(data), seq: this.events.length };
      this.events.push(event); this.publishing = true;
      try { for (const entry of handlers.slice()) if (entry.name === 'session/event') entry.listener(this, event); }
      finally { this.publishing = false; }
      return event;
    },
  };
  sessions.set(session.id, session);
  if (beforeTitle) session.append('session/title', beforeTitle);
  // Synthetic seat reproduces the official scheduling order and the session's
  // append publication restriction. Real service composition is tested separately.
  ctx.on('session/event', (current, event) => {
    if (event.type !== 'user/message' || event.data.source.kind !== 'user') return;
    const humans = current.events.filter(item => item.type === 'user/message' && item.data.source.kind === 'user');
    if (humans.length === 1 && titles.get(current) === undefined && !current.header.parentSession) current.pending = true;
    queueMicrotask(() => {
      if (sessions.get(current.id) !== current || titles.get(current) !== undefined) return;
      current.append('session/title', { title: messageOf(humans[0]).text.trim().slice(0, 30),
        messageSeqs: [humans[0].seq], source: { kind: 'fallback' } });
    });
  });
  const stop = installSnapshotTitles(ctx);
  const appendHuman = (content = input) => session.append('user/message', { source: { kind: 'user' }, content });
  const request = event => ({ session, messages: [messageOf(event)],
    route: { provider: 'synthetic-route', model: 'synthetic-model' }, signal: new AbortController().signal });
  const announceCreated = () => { for (const entry of handlers.slice()) if (entry.name === 'session/created') entry.listener(session); };
  return { ctx, titles, titleProvider, session, requests, warnings, sessions, handlers, stop, appendHuman, request, announceCreated };
}

test('source fallback queues after publication without suppressing first-prompt scheduling', async () => {
  const f = fixture();
  const event = f.appendHuman();
  assert.equal(f.session.pending, true);
  assert.equal(f.titles.get(f.session), undefined);
  await settle();
  assert.deepEqual(f.titles.get(f.session), {
    title: '流水线构建详情', messageSeqs: [event.seq], source: { kind: 'fallback' },
  });
  assert.equal(f.session.events.filter(item => item.type === 'session/title').length, 1);
  assert.deepEqual(f.warnings, []);
  await f.stop();
});

test('only the auxiliary first message is projected and exact Agent data stays unchanged', async () => {
  const f = fixture();
  const event = f.appendHuman();
  const request = f.request(event);
  request.messages.push({ seq: 900, text: 'Later unchanged message' });
  const before = structuredClone(event.data);
  const result = await f.titleProvider.generate(request);
  const delegated = f.requests[0].request;
  assert.notEqual(delegated, request);
  assert.match(delegated.messages[0].text, /流水线构建详情/);
  assert.doesNotMatch(delegated.messages[0].text, /<window_snapshot>/);
  assert.ok(framedTitleInputBytes([delegated.messages[0]]) <= 3072);
  assert.equal(delegated.messages[0].seq, event.seq);
  assert.equal(delegated.messages[1], request.messages[1]);
  assert.equal(delegated.session, request.session);
  assert.equal(delegated.route, request.route);
  assert.equal(f.requests[0].receiver, f.titleProvider);
  assert.deepEqual(event.data, before);
  assert.match(request.messages[0].text, /<window_snapshot>/);
  assert.deepEqual(result, { title: '构建流水线状态', messageSeqs: [event.seq], model: request.route });
  await f.stop();
});

test('typed user intent supplies fallback and precedes reference data in the auxiliary request', async () => {
  const f = fixture({ input: snapshotContent('分析前端编译为何运行缓慢') });
  const event = f.appendHuman();
  await f.titleProvider.generate(f.request(event));
  assert.match(f.requests[0].request.messages[0].text, /^分析前端编译为何运行缓慢/);
  await settle();
  assert.equal(f.titles.get(f.session).title, '分析前端编译为何运行缓慢');
  await f.stop();
});

test('normal and unpaired messages preserve exact provider request object and signal', async () => {
  for (const content of [[{ type: 'text', text: 'Ordinary user request' }],
    [{ type: 'text', text: contextText(capture) }]]) {
    const f = fixture({ input: content });
    const event = f.appendHuman();
    const request = f.request(event);
    await f.titleProvider.generate(request);
    assert.equal(f.requests[0].request, request);
    assert.equal(f.requests[0].request.signal, request.signal);
    await f.stop();
  }
});

test('custom providers are never wrapped or replaced', async () => {
  const f = fixture({ knownProvider: false });
  const generate = f.titleProvider.generate;
  const event = f.appendHuman();
  const request = f.request(event);
  await f.titleProvider.generate(request);
  assert.equal(f.titleProvider.generate, generate);
  assert.equal(f.requests[0].request, request);
  assert.equal(f.titles.registration.provider, f.titleProvider);
  await f.stop();
});

test('user titles and accepted provider titles survive queued fallback work', async () => {
  for (const source of [{ kind: 'user' }, { kind: 'provider', provider: providerId }]) {
    const f = fixture();
    const event = f.appendHuman();
    const title = { title: '已选标题', messageSeqs: source.kind === 'user' ? [] : [event.seq], source };
    f.session.append('session/title', title);
    await settle();
    assert.deepEqual(f.titles.get(f.session), title);
    await f.stop();
  }
});

test('a standing manual title, fork, or preceding ordinary prompt is never retitled', async () => {
  const manual = { title: 'My manual title', messageSeqs: [], source: { kind: 'user' } };
  const pinned = fixture({ beforeTitle: manual });
  pinned.appendHuman(); await settle();
  assert.deepEqual(pinned.titles.get(pinned.session), manual);
  await pinned.stop();
  const fork = fixture({ header: { parentSession: 'synthetic-parent' }, beforeTitle: {
    title: 'Inherited title', messageSeqs: [0], source: { kind: 'fallback' },
  } });
  fork.appendHuman(); await settle();
  assert.equal(fork.titles.get(fork.session).title, 'Inherited title');
  await fork.stop();
  const ordinary = fixture();
  ordinary.appendHuman([{ type: 'text', text: 'Earlier ordinary task' }]);
  await settle(); ordinary.appendHuman(); await settle();
  assert.equal(ordinary.titles.get(ordinary.session).title, 'Earlier ordinary task');
  await ordinary.stop();
});

test('raw official fallback is corrected only for its exact first snapshot message', async () => {
  const f = fixture();
  const event = f.appendHuman();
  f.session.append('session/title', { title: '<window_snapshot> 以下是用户选取',
    messageSeqs: [event.seq], source: { kind: 'fallback' } });
  await settle();
  assert.equal(f.titles.get(f.session).title, '流水线构建详情');
  assert.equal(f.session.events.filter(item => item.type === 'session/title').length, 2);
  f.session.append('session/title', { title: 'A later automatic revision',
    messageSeqs: [event.seq + 100], source: { kind: 'fallback' } });
  await settle();
  assert.equal(f.titles.get(f.session).title, 'A later automatic revision');
  await f.stop();
});

test('a future official provider retains its register receiver and exact disposer', async () => {
  const f = fixture({ provider: false });
  const receiver = Object.create(f.titles);
  const dispose = Reflect.apply(f.titles.register, receiver, [f.titleProvider]);
  assert.equal(dispose, receiver.lastDisposer);
  assert.equal(f.titles.registration, undefined);
  assert.equal(receiver.registration.provider, f.titleProvider);
  const event = f.appendHuman();
  await f.titleProvider.generate(f.request(event));
  assert.doesNotMatch(f.requests[0].request.messages[0].text, /<window_snapshot>/);
  await dispose(); assert.equal(receiver.registration, undefined);
  await f.stop();
});

test('disposed adapters restore owned descriptors and cancel queued fallback work', async () => {
  const f = fixture();
  const rawGenerate = f.requests.length;
  const wrapped = f.titleProvider.generate;
  f.appendHuman();
  await f.stop(); await settle();
  assert.notEqual(f.titleProvider.generate, wrapped);
  assert.equal(Object.hasOwn(f.titles, 'register'), false);
  assert.equal(f.handlers.length, 1);
  assert.equal(f.requests.length, rawGenerate);
  assert.doesNotMatch(f.titles.get(f.session)?.title ?? '', /流水线构建详情/);
  const next = installSnapshotTitles(f.ctx);
  assert.notEqual(f.titleProvider.generate, wrapped);
  await next();
});

test('disposal waits for a settling delegate and rejects late projected results', async () => {
  const f = fixture({ provider: false });
  let resolve, delegatedSignal;
  f.titleProvider.generate = request => { delegatedSignal = request.signal; return new Promise(done => { resolve = done; }); };
  f.titles.register(f.titleProvider);
  const event = f.appendHuman();
  const task = f.titleProvider.generate(f.request(event));
  await settle();
  let disposed = false;
  const stopping = f.stop().then(() => { disposed = true; });
  assert.equal(delegatedSignal.aborted, true);
  await settle(); assert.equal(disposed, false);
  const rejected = assert.rejects(task, /snapshot title adapter disposed/);
  resolve({ title: 'Late title', messageSeqs: [event.seq] });
  await rejected; await stopping;
  assert.equal(disposed, true);
});

test('original service cancellation propagates through a projected request', async () => {
  const f = fixture({ provider: false });
  let resolve, delegatedSignal;
  f.titleProvider.generate = request => { delegatedSignal = request.signal; return new Promise(done => { resolve = done; }); };
  f.titles.register(f.titleProvider);
  const event = f.appendHuman(), request = f.request(event), caller = new AbortController();
  request.signal = caller.signal;
  const task = f.titleProvider.generate(request);
  await settle();
  caller.abort(new Error('manual rename superseded generation'));
  assert.equal(delegatedSignal.aborted, true);
  const rejected = assert.rejects(task, /manual rename superseded/);
  resolve({ title: 'Late title', messageSeqs: [event.seq] });
  await rejected; await f.stop();
});

test('cleanup does not overwrite a later method decorator', async () => {
  const f = fixture();
  const laterGenerate = () => Promise.resolve({ title: 'Later wrapper' });
  const laterRegister = () => 'later register';
  f.titleProvider.generate = laterGenerate;
  f.titles.register = laterRegister;
  await f.stop();
  assert.equal(f.titleProvider.generate, laterGenerate);
  assert.equal(f.titles.register, laterRegister);
});

test('missing private registration warns once while public fallback remains available', async () => {
  const f = fixture({ provider: false });
  await f.stop(); delete f.titles.registration;
  const stop = installSnapshotTitles(f.ctx);
  f.appendHuman(); await settle();
  assert.equal(f.titles.get(f.session).title, '流水线构建详情');
  assert.equal(f.warnings.length, 1);
  await stop();
});

test('opening a historical raw snapshot fallback repairs its durable title without generation', async () => {
  const f = fixture();
  await f.stop();
  const event = f.appendHuman(); await settle();
  assert.match(f.titles.get(f.session).title, /^<window_snapshot>/);
  const saved = structuredClone(event.data);
  const stop = installSnapshotTitles(f.ctx);
  f.announceCreated(); await settle();
  assert.equal(f.titles.get(f.session).title, '流水线构建详情');
  assert.deepEqual(event.data, saved);
  assert.equal(f.requests.length, 0);
  const count = f.session.events.length;
  f.announceCreated(); await settle();
  assert.equal(f.session.events.length, count);
  await stop();
});

test('historical repair preserves manual, provider, normal fallback and retired-session titles', async () => {
  for (const source of [{ kind: 'user' }, { kind: 'provider', provider: providerId }, { kind: 'fallback' }]) {
    const f = fixture();
    const event = f.appendHuman();
    const title = { title: source.kind === 'fallback' ? '已有来源标题' : '<window_snapshot> User chosen words',
      messageSeqs: source.kind === 'user' ? [] : [event.seq], source };
    f.session.append('session/title', title);
    await settle(); f.announceCreated(); await settle();
    assert.deepEqual(f.titles.get(f.session), title);
    assert.equal(f.requests.length, 0);
    await f.stop();
  }
  const f = fixture();
  f.appendHuman(); f.sessions.delete(f.session.id); f.announceCreated();
  await settle(); assert.equal(f.titles.get(f.session), undefined);
  await f.stop();
});

test('Cordis traceable service delegates future registration effects to the provider fiber', async () => {
  class TraceableTitles extends Service {
    registration;
    constructor(ctx) { super(ctx, 'sessionTitle'); }
    get() { return undefined; }
    register(provider) {
      return this.ctx.effect(() => {
        this.registration = { provider, closing: false };
        return () => { this.registration = undefined; };
      }, 'synthetic provider registration');
    }
  }
  const ctx = new Context();
  const serviceFiber = ctx.plugin(TraceableTitles);
  await serviceFiber;
  ctx.provide('sessions', { get: () => undefined });
  let stop, disposer, providerCtx;
  const adapterFiber = ctx.plugin({ name: 'synthetic-title-adapter', apply(current) { stop = installSnapshotTitles(current); } });
  await adapterFiber;
  const providerFiber = ctx.plugin({ name: 'synthetic-title-provider', apply(current) {
    providerCtx = current;
    disposer = current.get('sessionTitle').register({ id: providerId, automatic: 'first-prompt', async generate() {} });
  } });
  await providerFiber;
  const originalRegistration = providerCtx.get('sessionTitle').registration;
  assert.equal(originalRegistration.provider.id, providerId);
  await adapterFiber.dispose();
  assert.equal(providerCtx.get('sessionTitle').registration, originalRegistration);
  await providerFiber.dispose();
  assert.equal(providerCtx.get('sessionTitle').registration, undefined);
  await stop(); await disposer();
  await ctx.fiber.dispose();
});
