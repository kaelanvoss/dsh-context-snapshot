import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installSnapshotTitles } from '../src/snapshot-titles.mjs';
import { MAX_SNAPSHOT_TITLE_INPUT_BYTES } from '../src/title-input.mjs';
import { officialTitleRuntime, snapshotContent, appendHuman, appendRoute, framedMessages, deferred,
  eventually, settle, TITLE_PROVIDER } from './helpers/title-runtime.mjs';

function install(f) {
  const stop = installSnapshotTitles(f.ctx);
  f.setStop(stop);
  return stop;
}

test('published title service immediately logs a readable snapshot fallback and asynchronously accepts its bounded summary', async t => {
  const answer = deferred();
  const f = await officialTitleRuntime(t, { respond: () => answer.promise });
  install(f);
  const session = f.create('snapshot-title'), fixture = snapshotContent({ text: '公开页面文字。'.repeat(1500) });
  const original = JSON.stringify(fixture.content), message = appendHuman(session, fixture.content);
  await eventually(() => assert.equal(f.ctx.sessionTitle.get(session)?.title, fixture.capture.title));
  assert.deepEqual(f.ctx.sessionTitle.get(session).source, { kind: 'fallback' });
  assert.equal(f.requests.length, 0, 'fallback appears before any main route or auxiliary transport');
  appendRoute(session);
  await eventually(() => assert.equal(f.requests.length, 1));
  const request = f.requests[0], messages = framedMessages(request);
  assert.ok(Buffer.byteLength(request.messages[0].content[0].text, 'utf8') <= MAX_SNAPSHOT_TITLE_INPUT_BYTES,
    'the actual official JSON-framed wire input, including its prefix, owns the budget');
  assert.equal(request.purpose, 'session-title');
  assert.equal(request.provider, 'fixture-route');
  assert.equal(request.model, 'fixture-model');
  assert.equal(messages[0].seq, message.seq);
  assert.match(messages[0].text, /公开快照验收页|Fixture Browser/);
  assert.doesNotMatch(messages[0].text, /window_snapshot|"dshSnapshot"|imageCapturedAt/);
  assert.equal(f.ctx.sessionTitle.get(session).title, fixture.capture.title, 'pending summary retains the source fallback');
  answer.resolve('公开页面提交状态');
  await eventually(() => assert.equal(f.ctx.sessionTitle.get(session)?.title, '公开页面提交状态'));
  assert.deepEqual(f.ctx.sessionTitle.get(session).messageSeqs, [message.seq]);
  assert.deepEqual(f.ctx.sessionTitle.get(session).source, { kind: 'provider', provider: TITLE_PROVIDER,
    model: { provider: 'fixture-route', model: 'fixture-model' } });
  assert.equal(f.ctx.sessionProjections.snapshot(session).values.title, '公开页面提交状态');
  assert.equal(JSON.stringify(message.data.content), original, 'logged Agent image and AX payload are never rewritten');
  assert.equal(JSON.stringify(session.deriveMessages()[0].content), original, 'Agent-derived message content remains byte-for-byte identical');
});

test('published provider receives actual user intent ahead of snapshot data without flattening leading text blocks', async t => {
  const f = await officialTitleRuntime(t, { respond: async () => '排查公开按钮状态' });
  install(f);
  const session = f.create('mixed-title');
  const fixture = snapshotContent({ body: '为什么无法提交？', before: [{ type: 'text', text: '帮我排查公开页面的按钮状态。' }] });
  const original = JSON.stringify(fixture.content), message = appendHuman(session, fixture.content);
  await eventually(() => assert.match(f.ctx.sessionTitle.get(session)?.title ?? '', /^帮我排查公开页面/));
  appendRoute(session);
  await eventually(() => assert.equal(f.requests.length, 1));
  assert.match(framedMessages(f.requests[0])[0].text, /^帮我排查公开页面的按钮状态。 为什么无法提交？\n/);
  assert.equal(JSON.stringify(message.data.content), original);
});

test('published title service preserves a manual rename made while the snapshot summary is pending', async t => {
  const answer = deferred(), f = await officialTitleRuntime(t, { respond: () => answer.promise });
  install(f);
  const session = f.create('manual-title');
  appendHuman(session, snapshotContent().content);
  appendRoute(session);
  await eventually(() => assert.equal(f.requests.length, 1));
  const renamed = f.ctx.sessionTitle.rename(session, '我的公开页面验收');
  assert.equal(f.requests[0].signal.aborted, true, 'official manual rename cancels the old auxiliary request');
  answer.resolve('不应覆盖的旧摘要');
  await settle();
  assert.deepEqual(f.ctx.sessionTitle.get(session), renamed);
  assert.equal(f.ctx.sessionProjections.snapshot(session).values.title, renamed.title);
  appendHuman(session, [{ type: 'text', text: '后续问题也不覆盖手动命名' }]);
  appendRoute(session);
  await settle();
  assert.equal(f.requests.length, 1);
});

test('a manual title created before the first snapshot remains pinned and starts no summary request', async t => {
  const f = await officialTitleRuntime(t);
  install(f);
  const session = f.create('already-named');
  const renamed = f.ctx.sessionTitle.rename(session, '已命名的公开任务');
  appendHuman(session, snapshotContent().content);
  appendRoute(session);
  await settle();
  assert.deepEqual(f.ctx.sessionTitle.get(session), renamed);
  assert.equal(f.requests.length, 0);
});

for (const failure of ['transport', 'timeout', 'empty', 'tool-calls', 'xml', 'json']) {
  test(`published auxiliary ${failure} failure leaves the source fallback and original Agent input intact`, async t => {
    const config = failure === 'timeout' ? { timeoutMs: 20 } : {};
    const respond = failure === 'timeout' ? () => new Promise(() => {})
      : failure === 'transport' ? async () => new Error('synthetic title transport refusal')
        : failure === 'empty' ? async () => ''
          : failure === 'xml' ? async () => '<window_snapshot>不应作为标题</window_snapshot>'
            : failure === 'json' ? async () => '{"title":"不应展示序列化数据"}'
          : async () => [{ type: 'finish', reason: { kind: 'tool-calls' } }];
    const f = await officialTitleRuntime(t, { respond, config });
    install(f);
    const session = f.create(`failure-${failure}`), fixture = snapshotContent();
    const message = appendHuman(session, fixture.content), original = JSON.stringify(message.data.content);
    appendRoute(session);
    await eventually(() => assert.equal(f.requests.length, 1));
    if (failure === 'timeout') await eventually(() => assert.equal(f.requests[0].signal.aborted, true));
    else await settle();
    assert.equal(f.ctx.sessionTitle.get(session)?.title, fixture.capture.title);
    assert.equal(f.ctx.sessionTitle.get(session)?.source.kind, 'fallback');
    assert.equal(JSON.stringify(message.data.content), original);
    assert.equal(session.snapshotEvents().filter(event => event.type === 'session/title' && event.data.source.kind === 'provider').length, 0);
  });
}

test('published LLM helper normalizes multiline transport text before the adapter receives the single-line title result', async t => {
  const f = await officialTitleRuntime(t, { respond: async () => '公开页面\n按钮状态' });
  install(f);
  const session = f.create('official-multiline-normalization');
  const message = appendHuman(session, snapshotContent().content), original = JSON.stringify(message.data.content);
  appendRoute(session);
  await eventually(() => assert.equal(f.ctx.sessionTitle.get(session)?.title, '公开页面 按钮状态'));
  assert.doesNotMatch(f.ctx.sessionTitle.get(session).title, /[\r\n]/);
  assert.equal(JSON.stringify(message.data.content), original);
  // The upstream helper already collapses line breaks. Its original transport
  // formatting cannot be recovered or claimed rejected by a result adapter.
});

test('two real sessions accept out-of-order summaries without cross-session title or route contamination', async t => {
  const pending = new Map(), f = await officialTitleRuntime(t, { respond: options => {
    const answer = deferred(); pending.set(options.sessionId, answer); return answer.promise;
  } });
  install(f);
  const first = f.create('session-first'), second = f.create('session-second');
  appendHuman(first, snapshotContent({ title: '公开页面甲' }).content); appendRoute(first);
  appendHuman(second, snapshotContent({ title: '公开页面乙' }).content); appendRoute(second);
  await eventually(() => assert.equal(pending.size, 2));
  pending.get(second.id).resolve('页面乙提交说明');
  await eventually(() => assert.equal(f.ctx.sessionTitle.get(second)?.title, '页面乙提交说明'));
  assert.equal(f.ctx.sessionTitle.get(first).title, '公开页面甲');
  pending.get(first.id).resolve('页面甲验收状态');
  await eventually(() => assert.equal(f.ctx.sessionTitle.get(first)?.title, '页面甲验收状态'));
  assert.equal(f.ctx.sessionProjections.snapshot(first).values.title, '页面甲验收状态');
  assert.equal(f.ctx.sessionProjections.snapshot(second).values.title, '页面乙提交说明');
  for (const request of f.requests) assert.match(framedMessages(request)[0].text,
    request.sessionId === first.id ? /公开页面甲/ : /公开页面乙/);
});

test('published alpha Host keeps readable fallback, summary, manual-pin cancellation and adapter disposal behavior', async t => {
  const pending = deferred(), f = await officialTitleRuntime(t, { version: '0.2.1-alpha.1',
    respond: (_options, count) => count === 1 ? 'Alpha公开页面摘要' : pending.promise });
  const originalGenerate = Object.getOwnPropertyDescriptor(f.provider, 'generate');
  const originalRegister = Object.getOwnPropertyDescriptor(f.ctx.sessionTitle, 'register');
  const stop = install(f), first = f.create('alpha-summary');
  appendHuman(first, snapshotContent({ title: 'Alpha来源窗口' }).content);
  await eventually(() => assert.equal(f.ctx.sessionTitle.get(first)?.title, 'Alpha来源窗口'));
  appendRoute(first);
  await eventually(() => assert.equal(f.ctx.sessionTitle.get(first)?.title, 'Alpha公开页面摘要'));
  assert.equal(f.ctx.sessionProjections.snapshot(first).values.title, 'Alpha公开页面摘要');
  assert.ok(Buffer.byteLength(f.requests[0].messages[0].content[0].text, 'utf8') <= MAX_SNAPSHOT_TITLE_INPUT_BYTES);
  const renamed = f.create('alpha-manual');
  appendHuman(renamed, snapshotContent().content); appendRoute(renamed);
  await eventually(() => assert.equal(f.requests.length, 2));
  const pinned = f.ctx.sessionTitle.rename(renamed, 'Alpha手动命名');
  assert.equal(f.requests[1].signal.aborted, true);
  const unloading = f.create('alpha-unload');
  appendHuman(unloading, snapshotContent().content); appendRoute(unloading);
  await eventually(() => assert.equal(f.requests.length, 3));
  await stop();
  assert.equal(f.requests[2].signal.aborted, true);
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.provider, 'generate'), originalGenerate);
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.ctx.sessionTitle, 'register'), originalRegister);
  pending.resolve('Alpha晚到摘要');
  await settle();
  assert.deepEqual(f.ctx.sessionTitle.get(renamed), pinned);
  assert.equal(f.ctx.sessionTitle.get(unloading).source.kind, 'fallback');
});

test('serialized real Session logs replay the accepted automatic title and projection without a second request', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-snapshot-title-replay-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const writer = await officialTitleRuntime(t, { respond: async () => '持久化公开页面标题' });
  install(writer);
  const original = writer.create('persisted-title');
  appendHuman(original, snapshotContent().content); appendRoute(original);
  await eventually(() => assert.equal(writer.ctx.sessionTitle.get(original)?.source.kind, 'provider'));
  const expected = writer.ctx.sessionTitle.get(original), path = join(directory, 'public-session.json');
  await writeFile(path, JSON.stringify({ header: original.header, events: original.snapshotEvents() }));
  const stored = JSON.parse(await readFile(path, 'utf8'));
  const reader = await officialTitleRuntime(t);
  install(reader);
  const restored = reader.create(original.id, { seed: stored.events, meta: stored.header });
  assert.deepEqual(reader.ctx.sessionTitle.get(restored), expected);
  assert.equal(reader.ctx.sessionProjections.snapshot(restored).values.title, expected.title);
  appendHuman(restored, [{ type: 'text', text: '重启后的后续问题' }]); appendRoute(restored);
  await settle();
  assert.equal(reader.requests.length, 0, 'replayed first-prompt title is not regenerated');
});

test('opening a real historical snapshot session repairs only its raw XML fallback without requesting another summary', async t => {
  const writer = await officialTitleRuntime(t), original = writer.create('historical-xml-title');
  const message = appendHuman(original, snapshotContent({ title: '历史公开页面验收' }).content);
  await eventually(() => assert.match(writer.ctx.sessionTitle.get(original)?.title ?? '', /^<window_snapshot>/));
  const storedEvents = JSON.parse(JSON.stringify(original.snapshotEvents()));
  const reader = await officialTitleRuntime(t);
  install(reader);
  const restored = reader.create(original.id, { seed: storedEvents, meta: original.header });
  await eventually(() => assert.equal(reader.ctx.sessionTitle.get(restored)?.title, '历史公开页面验收'));
  assert.deepEqual(reader.ctx.sessionTitle.get(restored).messageSeqs, [message.seq]);
  assert.equal(reader.ctx.sessionTitle.get(restored).source.kind, 'fallback');
  assert.equal(reader.ctx.sessionProjections.snapshot(restored).values.title, '历史公开页面验收');
  assert.equal(reader.requests.length, 0);
  assert.deepEqual(restored.snapshotEvents().filter(event => event.type === 'user/message'),
    storedEvents.filter(event => event.type === 'user/message'), 'restoring the title never rewrites historical Agent content');
});

for (const kind of ['user', 'provider', 'readable-fallback', 'ordinary-first-prompt']) {
  test(`historical ${kind} title stays unchanged when the adapter observes real session restoration`, async t => {
    const writer = await officialTitleRuntime(t), original = writer.create(`historical-${kind}`);
    const first = appendHuman(original, kind === 'ordinary-first-prompt'
      ? [{ type: 'text', text: '已有的普通公开问题' }] : snapshotContent().content);
    if (kind === 'ordinary-first-prompt') appendHuman(original, snapshotContent().content);
    await settle();
    const title = kind === 'readable-fallback' ? '已可读的公开页面标题' : '<window_snapshot> 已有命名';
    if (kind === 'user') writer.ctx.sessionTitle.rename(original, title);
    else original.append('session/title', { title, messageSeqs: [first.seq],
      source: kind === 'provider' ? { kind: 'provider', provider: TITLE_PROVIDER } : { kind: 'fallback' } });
    const expected = writer.ctx.sessionTitle.get(original), events = JSON.parse(JSON.stringify(original.snapshotEvents()));
    const reader = await officialTitleRuntime(t);
    install(reader);
    const restored = reader.create(original.id, { seed: events, meta: original.header });
    await settle();
    assert.deepEqual(reader.ctx.sessionTitle.get(restored), expected);
    assert.deepEqual(restored.snapshotEvents().filter(event => event.type === 'session/title'),
      events.filter(event => event.type === 'session/title'), 'protected historical titles add no replacement title event');
    assert.equal(reader.requests.length, 0);
  });
}

test('adapter disposal cancels its pending summary and restores the existing official provider and registration methods', async t => {
  const pending = deferred(), f = await officialTitleRuntime(t, { respond: (_options, count) => count === 1 ? pending.promise : '原提供方标题' });
  const originalGenerate = Object.getOwnPropertyDescriptor(f.provider, 'generate');
  const originalRegister = Object.getOwnPropertyDescriptor(f.ctx.sessionTitle, 'register');
  const stop = install(f), session = f.create('unload-title');
  appendHuman(session, snapshotContent().content); appendRoute(session);
  await eventually(() => assert.equal(f.requests.length, 1));
  await stop();
  assert.equal(f.requests[0].signal.aborted, true);
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.provider, 'generate'), originalGenerate);
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.ctx.sessionTitle, 'register'), originalRegister);
  pending.resolve('晚到的快照摘要');
  await settle();
  assert.equal(f.ctx.sessionTitle.get(session).source.kind, 'fallback');
  const normal = f.create('plain-after-unload');
  appendHuman(normal, [{ type: 'text', text: '普通问题仍由官方提供方命名' }]); appendRoute(normal);
  await eventually(() => assert.equal(f.ctx.sessionTitle.get(normal)?.title, '原提供方标题'));
  assert.equal(framedMessages(f.requests[1])[0].text, '普通问题仍由官方提供方命名');
});

test('late known provider registration is adapted while unknown providers retain their exact raw request', async t => {
  const known = await officialTitleRuntime(t, { registerProvider: false });
  install(known);
  known.register();
  const session = known.create('late-provider');
  appendHuman(session, snapshotContent().content); appendRoute(session);
  await eventually(() => assert.equal(known.requests.length, 1));
  assert.doesNotMatch(framedMessages(known.requests[0])[0].text, /window_snapshot/);

  const custom = await officialTitleRuntime(t, { providerId: 'custom-title-provider' });
  const generate = Object.getOwnPropertyDescriptor(custom.provider, 'generate');
  install(custom);
  assert.deepEqual(Object.getOwnPropertyDescriptor(custom.provider, 'generate'), generate);
  const other = custom.create('unknown-provider'), fixture = snapshotContent();
  const message = appendHuman(other, fixture.content); appendRoute(other);
  await eventually(() => assert.equal(custom.requests.length, 1));
  assert.equal(framedMessages(custom.requests[0])[0].text, message.data.content.at(-1).text);
});

test('ordinary text and unpaired snapshot-like text are delegated unchanged through the published title helper', async t => {
  const f = await officialTitleRuntime(t);
  install(f);
  const normal = f.create('ordinary-title');
  appendHuman(normal, [{ type: 'text', text: '请说明普通公开页面' }]); appendRoute(normal);
  await eventually(() => assert.equal(f.requests.length, 1));
  assert.equal(framedMessages(f.requests[0])[0].text, '请说明普通公开页面');
  const unpaired = f.create('unpaired-title'), fixture = snapshotContent({ image: false });
  const message = appendHuman(unpaired, fixture.content); appendRoute(unpaired);
  await eventually(() => assert.equal(f.requests.length, 2));
  assert.equal(framedMessages(f.requests[1])[0].text, message.data.content[0].text,
    'text resembling a snapshot must not be interpreted without its admitted image pair');
});
