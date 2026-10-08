import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as Cordis from '@deepseek-ai/cordis';
import { attachSnapshot, discardSnapshotDrafts } from '../src/draft.mjs';
import { createSnapshotStore } from '../src/snapshot-store.mjs';
import { installSnapshotSubmission } from '../src/submission.mjs';
import { apply as applyHost } from '../src/index.mjs';
import { SnapshotBroker } from '../src/broker.mjs';
import { NativeBridge } from '../src/native.mjs';
import { parseSnapshotPresentation } from '../src/presentation-data.mjs';

const require = createRequire(import.meta.url);
const portableFixture = new URL('../.fixtures/ui-conversation/client.js', import.meta.url);
const fixture = portableFixture;
const hasOfficialFixture = existsSync(fixture);
const portableConnection = new URL('../.fixtures/connection/rpc.d.ts', import.meta.url);
const connectionFixture = portableConnection;

// The official browser image encoder remains under test. This only supplies
// its FileReader platform seat in Node; no plugin or official encoder is mocked.
class FixtureFileReader {
  readAsDataURL(file) {
    void file.arrayBuffer().then(bytes => {
      this.result = `data:${file.type};base64,${Buffer.from(bytes).toString('base64')}`;
      this.onload?.();
    }, error => { this.error = error; this.onerror?.(); });
  }
}

// Load the published 0.2.0-rc.2 implementation, including its actual Lexical
// editor and input actions. Only peripheral Store/React presentation seats are
// doubles. Exposing this existing class in the VM avoids copying its behavior
// into a test and does not modify the artifact on disk.
function officialRuntime() {
  let loaded;
  const source = readFileSync(fixture, 'utf8').replace(
    'exports.ConversationController = ConversationController;',
    'exports.ContractSessionInputShell = SessionInputShell; exports.ConversationController = ConversationController;'
  );
  const store = initial => {
    let value = initial;
    const listeners = new Set();
    return {
      getSnapshot: () => value,
      set: next => { value = next; for (const listener of listeners) listener(); },
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    };
  };
  runInNewContext(source, {
    window: { __ModuleLoader__: { load: value => { loaded = value; } } },
    console, URL, URLSearchParams, Blob, File, AbortController,
    crypto: webcrypto, setTimeout, clearTimeout, queueMicrotask,
    performance, TextEncoder, TextDecoder, FileReader: FixtureFileReader,
  });
  assert.equal(loaded.id, '@deepseek-ai/dsh-client-ui-conversation');
  const exports = loaded.factory(id => {
    if (id === '@deepseek-ai/cordis') return Cordis;
    if (id === 'react' || id === 'react/jsx-runtime') return require(id);
    if (id === 'react-dom' || id === '@deepseek-ai/dsh-client-ui-primitives' || id === '@deepseek-ai/dsh-client-ui-slots') return {};
    if (id === '@deepseek-ai/dsh-client-store') return { createSnapshotStore: store };
    throw new Error(`Unexpected official browser import: ${id}`);
  });
  assert.equal(typeof exports.ContractSessionInputShell, 'function');
  return exports;
}

function createOfficialInput(runtime, { onPrompt = async () => ({ ok: true }), inputTriggers, observeRetirement = true } = {}) {
  const ctx = new Cordis.Context();
  const store = createSnapshotStore();
  const calls = [], echoes = [];
  const session = {
    sessionId: 'session-a',
    getSnapshot: () => ({ subagent: null }),
    beginSubmission(echo) {
      const requestId = `request-${echoes.length + 1}`;
      echoes.push({ ...echo, requestId, abandoned: false });
      return { requestId, abandon: () => { echoes.find(item => item.requestId === requestId).abandoned = true; } };
    },
    async prompt(content, mode, signal, requestId) {
      const call = { content, mode, signal, requestId };
      calls.push(call);
      const result = await onPrompt(call, calls.length);
      if (result.ok && observeRetirement) echoes.find(item => item.requestId === requestId)?.onRetire({
        reason: 'observed', attachments: content.filter(item => item.type === 'image').map(() => ({ mediaType: 'image/png' })),
      });
      return result;
    },
  };
  const input = new runtime.ContractSessionInputShell({
    actx: ctx,
    defaultSink: (text, ids, mode, signal) => ctx.conversation.sendSession(session, text, ids, mode, signal),
    commandAttachments: {
      serialize: async ids => (await ctx.conversation.serializeDraftAttachments(ids)).attachments,
      release: ids => { for (const id of ids) ctx.conversation.releaseDraftAttachment(id); },
      unsupportedNotice: () => 'This command does not accept attachments',
    },
    ...(inputTriggers === undefined ? {} : { inputTriggers: () => inputTriggers }),
  });
  const conversation = new runtime.ConversationController(ctx, {
    input: { for: () => input }, blocks: {}, maxConcurrentFileUploads: 2,
  });
  // Only the binding seat is doubled. The adapter resolves the real official
  // input through conversation.input when an in-flight send outlives unload.
  ctx.provide('sessions', { binding: id => id === session.sessionId ? { ctx } : undefined });
  const disposeAdapter = installSnapshotSubmission(ctx, store);
  const target = { alive: true, phase: 'plain', sessionId: session.sessionId, inputActions: input.actions };
  return { ctx, store, calls, echoes, session, input, conversation: ctx.conversation, target, disposeAdapter, async dispose() {
    input.dispose();
    await disposeAdapter();
    await ctx.fiber.dispose();
  } };
}

async function eventually(assertion) {
  const until = Date.now() + 1500;
  for (;;) {
    try { assertion(); return; }
    catch (error) { if (Date.now() >= until) throw error; }
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

function textOf(call) { return call.content.filter(item => item.type === 'text').map(item => item.text).join('\n'); }
function imageOf(call) { return call.content.find(item => item.type === 'image'); }

const screenshot = {
  // Small valid PNG, not merely a forged header.
  pngBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  appName: 'Contract fixture', title: 'Selection and draft',
  text: 'Accessible reference text', capturedAt: '2026-10-08T00:00:00.000Z',
};

test('official input keeps user text untouched while a snapshot enters the attachment rail', { skip: !hasOfficialFixture }, async () => {
  const runtime = officialRuntime();
  const f = createOfficialInput(runtime);
  const { input, conversation, store, target } = f;
  input.actions.setDraft('User draft that must survive');
  assert.equal(input.actions.persistDraft, undefined);
  const mirrored = [];
  input.bindMirror(text => mirrored.push(text));
  assert.equal(attachSnapshot(conversation, target, screenshot, store), true);
  const state = input.state.getSnapshot();
  assert.equal(state.draft, 'User draft that must survive');
  assert.doesNotMatch(state.draft, /window_snapshot|Accessible reference text/);
  assert.equal(state.attachmentIds.length, 1);
  assert.equal(conversation.resolveDraftAttachments(state.attachmentIds)[0].file.type, 'image/png');
  assert.equal(store.get(state.attachmentIds[0]).capture.text, screenshot.text);
  assert.ok(mirrored.every(text => !text.includes('window_snapshot')), 'editor persistence never receives hidden context');
  await f.dispose();
});

test('snapshot intake preserves an intervening user edit without depending on an editor insertion span', { skip: !hasOfficialFixture }, async () => {
  const runtime = officialRuntime();
  const f = createOfficialInput(runtime);
  const { input, conversation, store, target } = f;
  input.actions.setDraft('Before');
  input.actions.setDraft('Latest user edit');
  const actions = { ...input.actions, captureInsertion: () => { throw new Error('Snapshot intake must not edit the document'); } };
  assert.equal(attachSnapshot(conversation, { ...target, inputActions: actions }, screenshot, store), true);
  assert.equal(input.state.getSnapshot().draft, 'Latest user edit');
  assert.equal(input.state.getSnapshot().attachmentIds.length, 1);
  await f.dispose();
});

test('official editor retains existing structured reference chips when adding a snapshot card', { skip: !hasOfficialFixture }, async () => {
  const runtime = officialRuntime();
  const f = createOfficialInput(runtime);
  const { input, conversation, store, target } = f;
  input.actions.setDraft('Original explanation');
  const span = { ...input.actions.captureInsertion(), start: 0, end: 0 };
  assert.equal(input.insertReference({
    source: 'fixture-reference', ref: 'path/example.ts', label: 'example.ts',
    clipboardText: '@example.ts', appearance: 'file',
  }, span), true);
  assert.equal(input.state.getSnapshot().occurrences.length, 1);
  const before = input.state.getSnapshot().draft;
  assert.equal(attachSnapshot(conversation, target, screenshot, store), true);
  const state = input.state.getSnapshot();
  assert.equal(state.draft, before);
  assert.equal(state.occurrences.length, 1, 'snapshot must not flatten semantic reference chips');
  assert.equal(state.occurrences[0].ref, 'path/example.ts');
  await f.dispose();
});

test('official default submission combines hidden snapshot context with the actual encoded PNG', { skip: !hasOfficialFixture }, async () => {
  const runtime = officialRuntime();
  const f = createOfficialInput(runtime);
  const { input, conversation, store, target, calls } = f;
  input.actions.setDraft('Explain this window');
  assert.equal(attachSnapshot(conversation, target, screenshot, store), true);
  assert.equal(input.state.getSnapshot().draft, 'Explain this window');
  input.actions.submit();
  await eventually(() => { assert.equal(calls.length, 1); assert.equal(store.entries().length, 0); });
  assert.match(textOf(calls[0]), /^Explain this window/);
  assert.match(textOf(calls[0]), /Accessible reference text/);
  assert.equal((textOf(calls[0]).match(/<window_snapshot>/g) ?? []).length, 1);
  assert.equal(imageOf(calls[0]).data, screenshot.pngBase64, 'published FileReader encoder reads the real PNG File');
  assert.equal(imageOf(calls[0]).mediaType, 'image/png');
  assert.equal(input.state.getSnapshot().draft, '');
  await f.dispose();
});

test('attachment-only official Enter submission adds hidden context and preserves steer delivery', { skip: !hasOfficialFixture }, async () => {
  const f = createOfficialInput(officialRuntime());
  assert.equal(attachSnapshot(f.conversation, f.target, screenshot, f.store), true);
  assert.equal(f.input.state.getSnapshot().draft, '');
  f.input.submit('steer', 'enter');
  await eventually(() => { assert.equal(f.calls.length, 1); assert.equal(f.store.entries().length, 0); });
  assert.match(textOf(f.calls[0]), /Accessible reference text/);
  assert.equal(imageOf(f.calls[0]).data, screenshot.pngBase64);
  assert.equal(f.calls[0].mode, 'steer');
  assert.ok(f.calls[0].signal instanceof AbortSignal);
  await f.dispose();
});

test('real official pre-paint echo projects the user body while the model payload retains image, source and AX', { skip: !hasOfficialFixture }, async () => {
  const f = createOfficialInput(officialRuntime());
  attachSnapshot(f.conversation, f.target, screenshot, f.store);
  const ids = [...f.input.state.getSnapshot().attachmentIds];
  const sending = f.conversation.sendSession(f.session, '请检查', ids, 'queue');
  assert.equal(f.echoes.length, 1, 'official optimistic echo is synchronous');
  assert.equal(f.calls.length, 0, 'model transport has not started before nextPaint');
  const echo = f.echoes[0];
  const serialized = JSON.stringify(echo);
  const projection = parseSnapshotPresentation(echo);
  assert.equal(projection.text, '请检查');
  assert.equal(projection.snapshots[0].text, screenshot.text);
  assert.equal(projection.snapshots[0].image, echo.attachments[0]);
  assert.equal(JSON.stringify(echo), serialized, 'view projection leaves the optimistic source untouched');
  await sending;
  assert.equal(imageOf(f.calls[0]).data, screenshot.pngBase64);
  assert.equal(imageOf(f.calls[0]).name, projection.snapshots[0].filename);
  assert.match(textOf(f.calls[0]), /Accessible reference text/);
  assert.match(textOf(f.calls[0]), /Contract fixture/);
  assert.match(textOf(f.calls[0]), /"dshSnapshot":\{"version":2,"id":/);
  await f.dispose();
});

test('official reference serialization still expands existing chips before snapshot submission', { skip: !hasOfficialFixture }, async () => {
  const serializedRefs = [];
  const f = createOfficialInput(officialRuntime(), { inputTriggers: {
    lexicon: { getSnapshot: () => new Map(), subscribe: () => () => {} },
    track() {},
    serializeReference: async (source, ref) => { serializedRefs.push({ source, ref }); return 'Resolved existing reference'; },
  } });
  f.input.actions.setDraft('User explanation');
  const span = { ...f.input.actions.captureInsertion(), start: 0, end: 0 };
  assert.equal(f.input.insertReference({ source: 'fixture-reference', ref: 'original.ts', label: 'original.ts', clipboardText: '@original.ts', appearance: 'file' }, span), true);
  const draft = f.input.state.getSnapshot().draft;
  attachSnapshot(f.conversation, f.target, screenshot, f.store);
  assert.equal(f.input.state.getSnapshot().draft, draft);
  f.input.actions.submit();
  await eventually(() => { assert.equal(f.calls.length, 1); assert.equal(f.store.entries().length, 0); });
  assert.deepEqual(serializedRefs, [{ source: 'fixture-reference', ref: 'original.ts' }]);
  assert.match(textOf(f.calls[0]), /Resolved existing reference/);
  assert.match(textOf(f.calls[0]), /User explanation/);
  assert.match(textOf(f.calls[0]), /Accessible reference text/);
  assert.equal(imageOf(f.calls[0]).data, screenshot.pngBase64);
  await f.dispose();
});

test('official failed send restores the card and retry carries snapshot context exactly once', { skip: !hasOfficialFixture }, async () => {
  const f = createOfficialInput(officialRuntime(), { onPrompt: async (_call, attempt) => ({ ok: attempt > 1 }) });
  f.input.actions.setDraft('Please inspect');
  assert.equal(attachSnapshot(f.conversation, f.target, screenshot, f.store), true);
  const [id] = f.input.state.getSnapshot().attachmentIds;
  f.input.actions.submit();
  await eventually(() => { assert.equal(f.calls.length, 1); assert.deepEqual([...f.input.state.getSnapshot().attachmentIds], [id]); });
  assert.equal(f.input.state.getSnapshot().draft, 'Please inspect');
  assert.ok(f.store.get(id));
  f.input.actions.submit();
  await eventually(() => { assert.equal(f.calls.length, 2); assert.equal(f.store.get(id), undefined); });
  for (const call of f.calls) {
    assert.equal((textOf(call).match(/<window_snapshot>/g) ?? []).length, 1);
    assert.equal(imageOf(call).data, screenshot.pngBase64);
  }
  await f.dispose();
});

test('snapshot context remains live until official admission is observed, beyond the prompt acknowledgement', { skip: !hasOfficialFixture }, async () => {
  const f = createOfficialInput(officialRuntime(), { observeRetirement: false });
  attachSnapshot(f.conversation, f.target, screenshot, f.store);
  const [id] = f.input.state.getSnapshot().attachmentIds;
  f.input.actions.submit();
  await eventually(() => assert.equal(f.calls.length, 1));
  // A successful prompt result alone is not the official completion: the
  // main-session sink still waits for its submission echo to be observed.
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(f.store.get(id));
  assert.equal(f.conversation.resolveDraftAttachments([id]).length, 1);
  f.echoes[0].onRetire({ reason: 'observed', attachments: [{ mediaType: 'image/png' }] });
  await eventually(() => assert.equal(f.store.get(id), undefined));
  assert.equal(f.conversation.resolveDraftAttachments([id]).length, 0);
  await f.dispose();
});

test('transport rejection keeps hidden context without overwriting text typed during the send', { skip: !hasOfficialFixture }, async () => {
  let rejectFirst;
  const f = createOfficialInput(officialRuntime(), { onPrompt: (_call, attempt) => attempt === 1
    ? new Promise((_resolve, reject) => { rejectFirst = reject; }) : Promise.resolve({ ok: true }) });
  f.input.actions.setDraft('First message');
  assert.equal(attachSnapshot(f.conversation, f.target, screenshot, f.store), true);
  const [id] = f.input.state.getSnapshot().attachmentIds;
  f.input.actions.submit();
  await eventually(() => assert.equal(f.calls.length, 1));
  assert.equal(f.input.state.getSnapshot().attachmentIds.length, 0, 'official optimistic send detaches draft ids');
  assert.ok(f.store.get(id), 'optimistic clear must not destroy retry context');
  f.input.actions.setDraft('New work typed while waiting');
  rejectFirst(new Error('offline'));
  await eventually(() => assert.deepEqual([...f.input.state.getSnapshot().attachmentIds], [id]));
  assert.equal(f.input.state.getSnapshot().draft, 'New work typed while waiting');
  assert.ok(f.store.get(id));
  f.input.actions.submit();
  await eventually(() => { assert.equal(f.calls.length, 2); assert.equal(f.store.get(id), undefined); });
  assert.match(textOf(f.calls[1]), /^New work typed while waiting/);
  assert.match(textOf(f.calls[1]), /Accessible reference text/);
  await f.dispose();
});

test('official attachment release removes its card metadata while retaining other attachments', { skip: !hasOfficialFixture }, async () => {
  const f = createOfficialInput(officialRuntime());
  attachSnapshot(f.conversation, f.target, screenshot, f.store);
  attachSnapshot(f.conversation, f.target, { ...screenshot, title: 'Second snapshot' }, f.store);
  const [first, second] = f.input.state.getSnapshot().attachmentIds;
  assert.equal(f.input.removeAttachment(first), true);
  f.conversation.releaseDraftAttachment(first);
  assert.equal(f.store.get(first), undefined);
  assert.equal(f.conversation.resolveDraftAttachments([first]).length, 0);
  assert.equal(f.store.get(second).capture.title, 'Second snapshot');
  assert.deepEqual([...f.input.state.getSnapshot().attachmentIds], [second]);
  await f.dispose();
});

test('scoped adapter preserves the Cordis receiver, delivery mode and cancellation signal', { skip: !hasOfficialFixture }, async () => {
  const f = createOfficialInput(officialRuntime());
  const witnessedScopes = [];
  class ImageCacheWitness extends Cordis.Service {
    constructor(ctx) { super(ctx, 'uiConversation'); }
    seedImageUrl() { witnessedScopes.push(this.ctx.scopeMarker); return true; }
  }
  new ImageCacheWitness(f.ctx);
  attachSnapshot(f.conversation, f.target, screenshot, f.store);
  const ids = [...f.input.state.getSnapshot().attachmentIds];
  const signal = new AbortController().signal;
  const scope = f.ctx.extend({ scopeMarker: 'original-session-scope' });
  const result = await scope.conversation.sendSession(f.session, 'Scoped message', ids, 'steer', signal);
  assert.equal(result.kind, 'success');
  assert.equal(f.calls[0].mode, 'steer');
  assert.equal(f.calls[0].signal, signal);
  assert.deepEqual(witnessedScopes, ['original-session-scope']);
  await f.dispose();
});

test('snapshot session mismatch is refused until official carried-draft rebinding assigns the new session', { skip: !hasOfficialFixture }, async () => {
  const f = createOfficialInput(officialRuntime());
  attachSnapshot(f.conversation, f.target, screenshot, f.store);
  const [id] = f.input.state.getSnapshot().attachmentIds;
  const other = { ...f.session, sessionId: 'session-b' };
  await assert.rejects(async () => f.conversation.sendSession(other, '', [id], 'queue'), /会话|session/i);
  assert.equal(f.calls.length, 0);
  assert.equal(f.store.get(id).sessionId, 'session-a');
  f.conversation.rebindDraftFiles('session-b', [id]);
  assert.equal(f.store.get(id).sessionId, 'session-b');
  const outcome = await f.conversation.sendSession(other, '', [id], 'queue');
  assert.equal(outcome.kind, 'success');
  assert.match(textOf(f.calls[0]), /Accessible reference text/);
  await f.dispose();
});

test('session guard rejection travels through the real official shell and restores its optimistic draft', { skip: !hasOfficialFixture }, async () => {
  const f = createOfficialInput(officialRuntime());
  f.input.actions.setDraft('Wrong-session submission must survive');
  attachSnapshot(f.conversation, f.target, screenshot, f.store);
  const [id] = f.input.state.getSnapshot().attachmentIds;
  // The default sink resolves a different SessionFace after intake. This is
  // the same guard path used by the adapter, exercised through the official
  // shell rather than merely asserting that a direct method call throws.
  f.session.sessionId = 'session-b';
  assert.doesNotThrow(() => f.input.actions.submit(), 'async defaultSink must reject, not throw out of official optimistic commit');
  await eventually(() => {
    assert.equal(f.input.state.getSnapshot().draft, 'Wrong-session submission must survive');
    assert.deepEqual([...f.input.state.getSnapshot().attachmentIds], [id]);
  });
  assert.equal(f.calls.length, 0);
  assert.ok(f.store.get(id));
  assert.equal(f.store.get(id).sessionId, 'session-a');
  assert.equal(f.conversation.resolveDraftAttachments([id]).length, 1);
  await f.dispose();
});

test('snapshot command serialization is refused while ordinary official image serialization stays unchanged', { skip: !hasOfficialFixture }, async () => {
  const f = createOfficialInput(officialRuntime());
  attachSnapshot(f.conversation, f.target, screenshot, f.store);
  const [snapshotId] = f.input.state.getSnapshot().attachmentIds;
  await assert.rejects(async () => f.conversation.serializeDraftAttachments([snapshotId]), /快照|snapshot/i);
  assert.ok(f.store.get(snapshotId));
  const [ordinary] = f.conversation.createDrafts('session-a', [new File([Uint8Array.from(atob(screenshot.pngBase64), c => c.charCodeAt(0))], 'ordinary.png', { type: 'image/png' })]);
  const serialized = await f.conversation.serializeDraftAttachments([ordinary.id]);
  assert.equal(serialized.attachments.length, 1);
  assert.equal(serialized.attachments[0].data, screenshot.pngBase64);
  await f.dispose();
});

test('official claimed-command submission retains the snapshot and refuses to silently omit its context', { skip: !hasOfficialFixture }, async () => {
  const f = createOfficialInput(officialRuntime());
  let commandCalls = 0;
  assert.equal(f.input.beginCommand({ name: 'fixture', token: '/fixture ', attachments: true, submit: async () => {
    commandCalls++; return { kind: 'success' };
  } }, f.input.actions.captureInsertion()), true);
  assert.equal(attachSnapshot(f.conversation, { ...f.target, phase: 'claimed' }, screenshot, f.store), true);
  const [id] = f.input.state.getSnapshot().attachmentIds;
  const before = f.input.state.getSnapshot().draft;
  f.input.actions.submit();
  await eventually(() => assert.equal(f.input.state.getSnapshot().phase, 'claimed'));
  assert.equal(commandCalls, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.input.state.getSnapshot().draft, before);
  assert.deepEqual([...f.input.state.getSnapshot().attachmentIds], [id]);
  assert.ok(f.store.get(id));
  await f.dispose();
});

test('ordinary official submissions do not gain snapshot context and adapter disposal restores methods', { skip: !hasOfficialFixture }, async () => {
  const f = createOfficialInput(officialRuntime());
  const signal = new AbortController().signal;
  await f.conversation.sendSession(f.session, 'Ordinary text', [], 'queue', signal);
  assert.equal(textOf(f.calls[0]), 'Ordinary text');
  assert.equal(f.calls[0].signal, signal);
  await f.disposeAdapter();
  assert.equal(f.ctx.reflect.props['conversation.sendSession'], undefined);
  assert.equal(f.ctx.reflect.props['conversation.serializeDraftAttachments'], undefined);
  assert.equal(f.ctx.reflect.props['conversation.releaseDraftAttachment'], undefined);
  assert.equal(f.ctx.reflect.props['conversation.rebindDraftFiles'], undefined);
  await f.conversation.sendSession(f.session, 'After unload', [], 'steer', signal);
  assert.equal(textOf(f.calls[1]), 'After unload');
  assert.equal(f.calls[1].mode, 'steer');
  await f.dispose();
});

test('adapter unload during a failed official send cleans the later-restored image and context together', { skip: !hasOfficialFixture }, async () => {
  let finish;
  const f = createOfficialInput(officialRuntime(), { onPrompt: () => new Promise(resolve => { finish = resolve; }) });
  attachSnapshot(f.conversation, f.target, screenshot, f.store);
  const [id] = f.input.state.getSnapshot().attachmentIds;
  f.input.actions.submit();
  await eventually(() => assert.equal(f.calls.length, 1));
  assert.equal(f.input.state.getSnapshot().attachmentIds.length, 0);
  await f.disposeAdapter();
  finish({ ok: false });
  await eventually(() => {
    assert.equal(f.store.get(id), undefined);
    assert.equal(f.input.state.getSnapshot().attachmentIds.length, 0);
    assert.equal(f.conversation.resolveDraftAttachments([id]).length, 0);
  });
  await f.dispose();
});

test('unload while official input adjudicates removes its unsent snapshot while preserving ordinary image intake', { skip: !hasOfficialFixture }, async () => {
  let finishAdjudication;
  const f = createOfficialInput(officialRuntime(), { inputTriggers: {
    lexicon: { getSnapshot: () => new Map(), subscribe: () => () => {} },
    track() {},
    adjudicate: () => new Promise(resolve => { finishAdjudication = resolve; }),
  } });
  f.input.actions.setDraft('/unknown original explanation');
  attachSnapshot(f.conversation, f.target, screenshot, f.store);
  const [snapshotId] = f.input.state.getSnapshot().attachmentIds;
  const [ordinary] = f.conversation.createDrafts('session-a', [new File([Uint8Array.from(atob(screenshot.pngBase64), c => c.charCodeAt(0))], 'ordinary-kept.png', { type: 'image/png' })]);
  assert.equal(f.input.actions.addAttachments([ordinary.id]), true);
  f.input.actions.submit();
  assert.equal(f.input.state.getSnapshot().phase, 'adjudicating', 'the real slash pipeline keeps admission busy');
  assert.equal(typeof finishAdjudication, 'function');
  discardSnapshotDrafts(f.conversation, f.ctx.sessions, f.store);
  assert.equal(f.input.state.getSnapshot().phase, 'adjudicating');
  assert.deepEqual([...f.input.state.getSnapshot().attachmentIds], [ordinary.id]);
  assert.equal(f.conversation.resolveDraftAttachments([snapshotId]).length, 0);
  assert.equal(f.conversation.resolveDraftAttachments([ordinary.id]).length, 1);
  assert.equal(f.store.entries().length, 0);
  assert.equal(f.calls.length, 0);
  finishAdjudication(undefined);
  await eventually(() => assert.equal(f.calls.length, 1));
  assert.equal(textOf(f.calls[0]), '/unknown original explanation');
  assert.doesNotMatch(textOf(f.calls[0]), /window_snapshot/);
  const images = f.calls[0].content.filter(item => item.type === 'image');
  assert.equal(images.length, 1);
  assert.equal(images[0].name, 'ordinary-kept.png', 'the post-adjudication send must not contain the orphan snapshot PNG');
  await f.dispose();
});

test('Host registers through the published authenticated Fetch seat rather than raw webServer routes', { skip: !existsSync(connectionFixture) }, () => {
  const published = readFileSync(connectionFixture, 'utf8');
  assert.match(published, /interface HostConnectionFetch[\s\S]*?register\(route: ConnectionFetchRoute\)/);
  assert.match(published, /readonly fetch: \(request: Request\) => Promise<Response>/);
  const routes = [], cleanups = [];
  applyHost({ connection: { fetch: { register: route => { routes.push(route); } } }, effect: setup => { cleanups.push(setup()); } }, { autoStart: false });
  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, '/api/context-snapshot');
  assert.deepEqual(routes[0].methods, ['POST']);
  assert.equal(routes[0].requestBody, 'buffered');
  for (const cleanup of cleanups) cleanup();
});

test('a released composer generation cannot reclaim the lease through an already queued poll', () => {
  const broker = new SnapshotBroker();
  broker.poll('client-a', 'session-a', true, 'window-view', 7);
  broker.release('client-a', 'session-a', 7);
  broker.poll('client-a', 'session-a', true, 'window-view', 7);
  assert.equal(broker.lease, null, 'late pre-release traffic must not resurrect a stale session');
  broker.poll('client-b', 'session-b', true, 'window-view', 8);
  assert.equal(broker.lease.sessionId, 'session-b');
});

test('a native spawn failure clears process ownership and makes the helper restartable', async () => {
  const broker = new SnapshotBroker();
  // A directory is an existing path but cannot be executed. This exercises
  // Node's real spawn error/close path without launching any screenshot code.
  const bridge = new NativeBridge(broker, { helperPath: fileURLToPath(new URL('.', import.meta.url)) });
  bridge.start();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(bridge.child, null);
  assert.equal(broker.status.running, false);
  assert.equal(broker.status.ready, false);
  assert.ok(broker.status.error);
  bridge.dispose();
});
