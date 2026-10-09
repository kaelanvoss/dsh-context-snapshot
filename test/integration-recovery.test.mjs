import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import * as Cordis from '@deepseek-ai/cordis';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { attachSnapshotDurably } from '../src/draft.mjs';
import { createSnapshotStore } from '../src/snapshot-store.mjs';
import { installSnapshotSubmission } from '../src/submission.mjs';
import { DRAFT_LEASE_MS, SnapshotDraftArchive } from '../src/draft-persistence.mjs';
import { createDraftPersistence } from '../src/draft-recovery.mjs';

const require = createRequire(import.meta.url);
const capture = () => ({ pngBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', snapshotId: randomUUID(),
  appName: 'Fixture', title: 'Saved before closing', text: 'button Run (disabled)', capturedAt: '2026-10-09T05:00:00Z',
  captureQuality: { status: 'available', reasons: [], textSource: 'ax', nodeCount: 2 }, source: {}, timing: {} });

class FixtureFileReader {
  readAsDataURL(file) {
    void file.arrayBuffer().then(bytes => { this.result = `data:${file.type};base64,${Buffer.from(bytes).toString('base64')}`; this.onload?.(); }, error => { this.error = error; this.onerror?.(); });
  }
}
function officialRuntime() {
  let loaded;
  const source = readFileSync(new URL('../.fixtures/ui-conversation/client.js', import.meta.url), 'utf8')
    .replace('exports.ConversationController = ConversationController;', 'exports.ContractSessionInputShell = SessionInputShell; exports.ConversationController = ConversationController;');
  const observable = initial => {
    let value = initial;
    const listeners = new Set();
    return { getSnapshot: () => value, set: next => { value = next; for (const listener of listeners) listener(); }, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } };
  };
  runInNewContext(source, { window: { __ModuleLoader__: { load: value => { loaded = value; } } }, console, URL, URLSearchParams, Blob, File, AbortController,
    crypto: webcrypto, setTimeout, clearTimeout, queueMicrotask, performance, TextEncoder, TextDecoder, FileReader: FixtureFileReader });
  return loaded.factory(id => {
    if (id === '@deepseek-ai/cordis') return Cordis;
    if (id === 'react' || id === 'react/jsx-runtime') return require(id);
    if (id === 'react-dom' || id === '@deepseek-ai/dsh-client-ui-primitives' || id === '@deepseek-ai/dsh-client-ui-slots') return {};
    if (id === '@deepseek-ai/dsh-client-store') return { createSnapshotStore: observable };
    throw new Error(`Unexpected official import ${id}`);
  });
}
const runtime = officialRuntime();
const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/SnapshotAttachments.jsx', import.meta.url))], bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react', 'react-dom'], logLevel: 'silent' });
const module = { exports: {} };
runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require, console, setTimeout, clearTimeout, atob, btoa });
const { SnapshotAttachments } = module.exports;

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-integration-recovery-'));
  const archive = new SnapshotDraftArchive({ directory });
  const persistence = createDraftPersistence(body => {
    if (body.op === 'draftSave') return archive.save(body.ownerId, body.sessionId, body.capture);
    if (body.op === 'draftClaim') return archive.claim(body.ownerId, body.sessionId, body.knownIds);
    if (body.op === 'draftRenew') return archive.renew(body.ownerId, body.sessionId, body.snapshotIds);
    if (body.op === 'draftBeginSend') return archive.beginSend(body.ownerId, body.sessionId, body.snapshotIds, body.attemptId);
    if (body.op === 'draftRejectSend') return archive.rejectSend(body.ownerId, body.sessionId, body.snapshotIds, body.attemptId, body.rejectionCode);
    if (body.op === 'draftRelease') return archive.release(body.ownerId, body.sessionId);
    if (body.op === 'draftDelete') return archive.delete(body.ownerId, body.snapshotId);
    if (body.op === 'draftRebind') return archive.rebindMany(body.ownerId, body.snapshotIds, body.sessionId);
    throw new Error(`Unexpected transport ${body.op}`);
  }, { ownerId: 'window-a' });
  const ctx = new Cordis.Context(), store = createSnapshotStore(), prompts = [];
  let echo;
  const session = { sessionId: 'session-a', getSnapshot: () => ({ subagent: null }), beginSubmission: value => { echo = value; return { requestId: randomUUID(), abandon() {} }; },
    async prompt(content) { prompts.push(content); echo?.onRetire({ reason: 'observed', attachments: content.filter(block => block.type === 'image').map(() => ({ mediaType: 'image/png' })) }); return { ok: true }; } };
  const input = new runtime.ContractSessionInputShell({ actx: ctx, defaultSink: (text, ids, mode, signal) => ctx.conversation.sendSession(session, text, ids, mode, signal) });
  new runtime.ConversationController(ctx, { input: { for: () => input }, blocks: {}, maxConcurrentFileUploads: 2 });
  ctx.provide('sessions', { binding: () => ({ ctx }) });
  const stop = installSnapshotSubmission(ctx, store, persistence);
  t.after(async () => { input.dispose(); await stop(); await persistence.dispose(); await ctx.fiber.dispose(); await archive.dispose(); await rm(directory, { recursive: true, force: true }); });
  const target = { alive: true, phase: 'plain', sessionId: 'session-a', inputActions: input.actions };
  return { archive, directory, persistence, ctx, conversation: ctx.conversation, input, store, target, session, prompts, stop };
}

test('official session shell teardown releases runtime images while preserving complete durable drafts', async t => {
  const f = await fixture(t), saved = capture();
  await attachSnapshotDurably(f.conversation, f.target, saved, f.store, f.persistence);
  const ids = f.input.dispose();
  assert.equal(ids.length, 1);
  for (const id of ids) f.conversation.releaseDraftAttachment(id);
  await f.store.flushPersistence();
  await f.persistence.release('session-a');
  assert.equal(f.store.entries().length, 0, 'retired browser identity must not suppress restoration');
  const restored = await f.archive.claim('reopened-window', 'session-a');
  assert.equal(restored.records.length, 1);
  assert.equal(restored.records[0].capture.pngBase64, saved.pngBase64);
  assert.equal(restored.records[0].capture.text, saved.text);
  assert.equal(restored.records[0].snapshotId, saved.snapshotId);
});

test('snapshot card removal explicitly retires disk context through the real Host action', async t => {
  const f = await fixture(t), saved = capture();
  await attachSnapshotDurably(f.conversation, f.target, saved, f.store, f.persistence);
  const attachments = f.conversation.resolveDraftAttachments(f.input.state.getSnapshot().attachmentIds);
  let view;
  t.after(async () => { await act(async () => view?.unmount()); });
  await act(async () => { view = TestRenderer.create(React.createElement(SnapshotAttachments, { snapshots: f.store, attachments, sessionId: 'session-a', canAcceptDrop: true,
    onRemoveAttachment: id => { if (f.input.removeAttachment(id)) f.conversation.releaseDraftAttachment(id); } })); });
  const remove = view.root.find(node => node.type === 'button' && node.props['aria-label']?.startsWith('移除快照：'));
  await act(async () => remove.props.onClick());
  await f.store.flushPersistence();
  assert.equal(f.input.state.getSnapshot().attachmentIds.length, 0);
  assert.equal(f.store.entries().length, 0);
  assert.equal(f.store.removalIntents.size, 0);
  assert.equal((await f.archive.claim('window-a', 'session-a')).records.length, 0, 'explicit removal must not resurrect on the next controller claim');
});

test('snapshot removal keeps the Host image and disables repeat removal until durable deletion is acknowledged', async t => {
  const f = await fixture(t), saved = capture();
  await attachSnapshotDurably(f.conversation, f.target, saved, f.store, f.persistence);
  assert.equal(typeof f.store.removeDurably, 'function');
  const [id] = f.input.state.getSnapshot().attachmentIds;
  const attachments = f.conversation.resolveDraftAttachments([id]);
  let announce, acknowledge, view, removing, hostRemovals = 0;
  const started = new Promise(resolve => { announce = resolve; });
  const ack = new Promise(resolve => { acknowledge = resolve; });
  const original = f.persistence.remove.bind(f.persistence);
  f.persistence.remove = async value => { announce(); await ack; return original(value); };
  t.after(async () => { await act(async () => view?.unmount()); });
  await act(async () => { view = TestRenderer.create(React.createElement(SnapshotAttachments, { snapshots: f.store, attachments, sessionId: 'session-a', canAcceptDrop: true,
    onRemoveAttachment: value => { hostRemovals += 1; if (f.input.removeAttachment(value)) f.conversation.releaseDraftAttachment(value); } })); });
  const remove = () => view.root.find(node => node.type === 'button' && node.props['aria-label']?.startsWith('移除快照：'));
  await act(async () => { removing = remove().props.onClick(); await started; });
  assert.equal(remove().props.disabled, true);
  assert.equal(hostRemovals, 0);
  assert.equal(f.store.removalIntents.size, 0, 'waiting for disk acknowledgement is not a Host removal action');
  assert.deepEqual([...f.input.state.getSnapshot().attachmentIds], [id]);
  assert.equal(f.conversation.resolveDraftAttachments([id]).length, 1);
  try {
    await assert.rejects(f.conversation.sendSession(f.session, 'Do not send a deleting snapshot', [id], 'default'), /移除|删除/);
    assert.equal(f.prompts.length, 0);
  } finally {
    await act(async () => { acknowledge(); await removing; });
  }
  assert.equal(hostRemovals, 1);
  assert.equal(f.input.state.getSnapshot().attachmentIds.length, 0);
  assert.equal(f.store.entries().length, 0);
  assert.equal(f.store.removalPending.size, 0);
  assert.equal((await f.archive.claim('window-a', 'session-a')).records.length, 0);
});

test('a failed durable card removal retains the exact Host image and context and can be retried', async t => {
  const f = await fixture(t), saved = capture();
  await attachSnapshotDurably(f.conversation, f.target, saved, f.store, f.persistence);
  assert.equal(typeof f.store.removeDurably, 'function');
  const [id] = f.input.state.getSnapshot().attachmentIds;
  const attachments = f.conversation.resolveDraftAttachments([id]);
  let announce, reject, view, removing, hostRemovals = 0;
  const started = new Promise(resolve => { announce = resolve; });
  const ack = new Promise((resolve, fail) => { reject = fail; });
  const original = f.persistence.remove.bind(f.persistence), errors = [];
  f.persistence.onError = error => errors.push(error.message);
  f.persistence.remove = async () => { announce(); await ack; };
  t.after(async () => { await act(async () => view?.unmount()); });
  await act(async () => { view = TestRenderer.create(React.createElement(SnapshotAttachments, { snapshots: f.store, attachments, sessionId: 'session-a', canAcceptDrop: true,
    onRemoveAttachment: value => { hostRemovals += 1; if (f.input.removeAttachment(value)) f.conversation.releaseDraftAttachment(value); } })); });
  const remove = () => view.root.find(node => node.type === 'button' && node.props['aria-label']?.startsWith('移除快照：'));
  await act(async () => { removing = remove().props.onClick(); await started; });
  assert.equal(remove().props.disabled, true);
  await act(async () => { reject(new Error('disk unavailable')); await removing; });
  assert.equal(hostRemovals, 0);
  assert.equal(remove().props.disabled, false);
  assert.equal(f.store.removalPending.size, 0);
  assert.equal(f.store.removalIntents.size, 0);
  assert.deepEqual([...f.input.state.getSnapshot().attachmentIds], [id]);
  assert.equal(f.conversation.resolveDraftAttachments([id])[0], attachments[0]);
  assert.equal(f.store.get(id).capture.text, saved.text);
  const retained = await f.archive.claim('window-a', 'session-a');
  assert.equal(retained.records.length, 1);
  assert.equal(retained.records[0].capture.pngBase64, saved.pngBase64);
  assert.deepEqual(errors, ['disk unavailable']);
  f.persistence.remove = original;
  await act(async () => { await remove().props.onClick(); });
  assert.equal(hostRemovals, 1);
  assert.equal(f.store.entries().length, 0);
  assert.equal((await f.archive.claim('window-a', 'session-a')).records.length, 0);
});

test('durable removal follows a snapshot carried to another Host input while its acknowledgement is pending', async t => {
  const f = await fixture(t), saved = capture(), nextScope = new Cordis.Context();
  const next = new runtime.ContractSessionInputShell({ actx: nextScope, defaultSink: async () => ({ kind: 'success' }) });
  f.conversation.input.for = scope => scope === nextScope ? next : f.input;
  f.ctx.sessions.binding = sessionId => ({ ctx: sessionId === 'session-b' ? nextScope : f.ctx });
  t.after(async () => { next.dispose(); await nextScope.fiber.dispose(); });
  await attachSnapshotDurably(f.conversation, f.target, saved, f.store, f.persistence);
  const [id] = f.input.state.getSnapshot().attachmentIds;
  const attachments = f.conversation.resolveDraftAttachments([id]);
  let announce, acknowledge, view, removing;
  const started = new Promise(resolve => { announce = resolve; });
  const ack = new Promise(resolve => { acknowledge = resolve; });
  const original = f.persistence.remove.bind(f.persistence);
  f.persistence.remove = async value => { announce(); await ack; return original(value); };
  t.after(async () => { await act(async () => view?.unmount()); });
  await act(async () => { view = TestRenderer.create(React.createElement(SnapshotAttachments, { snapshots: f.store, attachments, sessionId: 'session-a', canAcceptDrop: true,
    onRemoveAttachment: value => { if (f.input.removeAttachment(value)) f.conversation.releaseDraftAttachment(value); } })); });
  const remove = view.root.find(node => node.type === 'button' && node.props['aria-label']?.startsWith('移除快照：'));
  await act(async () => { removing = remove.props.onClick(); await started; });
  try {
    // Published workspace selection carries ids before rebinding their
    // registry owner, then removes them from the old input shell.
    assert.equal(next.addAttachments([id]), true);
    f.conversation.rebindDraftFiles('session-b', [id]);
    assert.equal(f.input.removeAttachment(id), true);
    await Promise.resolve(); await f.persistence.flush();
  } finally {
    await act(async () => { acknowledge(); await removing; });
  }
  assert.equal(next.state.getSnapshot().attachmentIds.length, 0, 'the retired snapshot must not remain in the destination composer');
  assert.equal(f.conversation.resolveDraftAttachments([id]).length, 0);
  assert.equal(f.store.entries().length, 0);
  assert.equal((await f.archive.claim('window-a', 'session-b')).records.length, 0);
});

test('a carried snapshot remains sendable when its pending deletion fails', async t => {
  const f = await fixture(t), saved = capture(), nextScope = new Cordis.Context();
  const next = new runtime.ContractSessionInputShell({ actx: nextScope, defaultSink: async () => ({ kind: 'success' }) });
  f.conversation.input.for = scope => scope === nextScope ? next : f.input;
  f.ctx.sessions.binding = sessionId => ({ ctx: sessionId === 'session-b' ? nextScope : f.ctx });
  t.after(async () => { next.dispose(); await nextScope.fiber.dispose(); });
  await attachSnapshotDurably(f.conversation, f.target, saved, f.store, f.persistence);
  const [id] = f.input.state.getSnapshot().attachmentIds;
  const attachments = f.conversation.resolveDraftAttachments([id]);
  let announce, reject, view, removing;
  const started = new Promise(resolve => { announce = resolve; });
  const decision = new Promise((resolve, fail) => { reject = fail; });
  const original = f.persistence.remove.bind(f.persistence);
  f.persistence.remove = async () => { announce(); await decision; };
  t.after(async () => { await act(async () => view?.unmount()); });
  await act(async () => { view = TestRenderer.create(React.createElement(SnapshotAttachments, { snapshots: f.store, attachments, sessionId: 'session-a', canAcceptDrop: true,
    onRemoveAttachment: value => { if (f.input.removeAttachment(value)) f.conversation.releaseDraftAttachment(value); } })); });
  const remove = view.root.find(node => node.type === 'button' && node.props['aria-label']?.startsWith('移除快照：'));
  await act(async () => { removing = remove.props.onClick(); await started; });
  next.addAttachments([id]);
  f.conversation.rebindDraftFiles('session-b', [id]);
  f.input.removeAttachment(id);
  await act(async () => { reject(new Error('deletion not committed')); await removing; });
  f.persistence.remove = original;
  await f.store.flushPersistence();
  assert.equal(f.store.get(id).sessionId, 'session-b');
  assert.equal(f.conversation.resolveDraftAttachments([id])[0], attachments[0]);
  assert.equal((await f.archive.claim('window-a', 'session-a')).records.length, 0);
  assert.equal((await f.archive.claim('window-a', 'session-b')).records.length, 1);
  const result = await f.conversation.sendSession({ ...f.session, sessionId: 'session-b' }, 'Inspect the retained snapshot', [id], 'default');
  assert.equal(result.kind, 'success');
  assert.equal(f.prompts.length, 1);
});

test('a migration arriving after deletion commits does not create a permanent archive rebind failure', async t => {
  const f = await fixture(t), saved = capture(), nextScope = new Cordis.Context();
  const next = new runtime.ContractSessionInputShell({ actx: nextScope, defaultSink: async () => ({ kind: 'success' }) });
  f.conversation.input.for = scope => scope === nextScope ? next : f.input;
  f.ctx.sessions.binding = sessionId => ({ ctx: sessionId === 'session-b' ? nextScope : f.ctx });
  t.after(async () => { next.dispose(); await nextScope.fiber.dispose(); });
  await attachSnapshotDurably(f.conversation, f.target, saved, f.store, f.persistence);
  const [id] = f.input.state.getSnapshot().attachmentIds;
  let committed, acknowledge, removing;
  const retired = new Promise(resolve => { committed = resolve; });
  const ack = new Promise(resolve => { acknowledge = resolve; });
  const original = f.persistence.remove.bind(f.persistence);
  f.persistence.remove = async value => { const result = await original(value); committed(); await ack; return result; };
  removing = f.store.removeDurably(id, () => { if (f.input.removeAttachment(id)) f.conversation.releaseDraftAttachment(id); });
  await retired;
  try {
    next.addAttachments([id]);
    f.conversation.rebindDraftFiles('session-b', [id]);
    f.input.removeAttachment(id);
  } finally { acknowledge(); await removing; }
  await f.store.flushPersistence();
  assert.equal(next.state.getSnapshot().attachmentIds.length, 0);
  assert.equal(f.store.entries().length, 0);
  assert.equal((await f.archive.claim('window-a', 'session-b')).records.length, 0);
});

test('carried snapshot survives runtime retirement and recovers only in its migrated session', async t => {
  const f = await fixture(t), saved = capture();
  await attachSnapshotDurably(f.conversation, f.target, saved, f.store, f.persistence);
  const [id] = f.input.state.getSnapshot().attachmentIds;
  f.conversation.rebindDraftFiles('session-b', [id]);
  f.input.removeAttachment(id);
  await f.store.flushPersistence();
  f.conversation.releaseDraftAttachment(id);
  await f.store.flushPersistence();
  assert.equal((await f.archive.claim('window-a', 'session-a')).records.length, 0);
  const restored = await f.archive.claim('window-a', 'session-b');
  assert.equal(restored.records.length, 1);
  assert.equal(restored.records[0].snapshotId, saved.snapshotId);
});

test('transient removal failure reconciles before the next snapshot send instead of poisoning all future sends', async t => {
  const f = await fixture(t), first = capture();
  await attachSnapshotDurably(f.conversation, f.target, first, f.store, f.persistence);
  const [id] = f.input.state.getSnapshot().attachmentIds;
  const original = f.persistence.remove.bind(f.persistence);
  let attempts = 0;
  f.persistence.remove = async value => { if (value === first.snapshotId && ++attempts === 1) throw new Error('transient Host restart'); return original(value); };
  f.store.removalIntents.add(id);
  f.input.removeAttachment(id);
  f.conversation.releaseDraftAttachment(id);
  await f.persistence.flush();
  await f.store.flushPersistence();
  assert.equal(attempts, 2);
  assert.equal((await f.archive.claim('window-a', 'session-a')).records.length, 0);
  const second = capture();
  await attachSnapshotDurably(f.conversation, f.target, second, f.store, f.persistence);
  const result = await f.conversation.sendSession(f.session, 'Inspect the new snapshot', f.input.state.getSnapshot().attachmentIds, 'default');
  assert.equal(result.kind, 'success');
  assert.equal(f.prompts.length, 1);
  assert.match(f.prompts[0].find(block => block.type === 'text').text, new RegExp(second.snapshotId));
  assert.doesNotMatch(f.prompts[0].find(block => block.type === 'text').text, new RegExp(first.snapshotId));
});

test('an outstanding Host submission retains the draft lease until its admission settles', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-09T05:01:00Z') });
  const f = await fixture(t), saved = capture();
  await attachSnapshotDurably(f.conversation, f.target, saved, f.store, f.persistence);
  let announce, release;
  const started = new Promise(resolve => { announce = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  const original = f.session.prompt.bind(f.session);
  f.session.prompt = async (...args) => { announce(); await barrier; return original(...args); };
  const sending = f.conversation.sendSession(f.session, 'Inspect this snapshot', f.input.state.getSnapshot().attachmentIds, 'default');
  await started;
  let contender;
  try {
    t.mock.timers.tick(DRAFT_LEASE_MS + 1);
    // Give any scheduled lease renewals their transport microtasks before the
    // competing window attempts to reconstruct the same unsent attachment.
    await Promise.resolve(); await Promise.resolve();
    await f.persistence.flush();
    contender = await f.archive.claim('window-b', 'session-a');
  } finally {
    release();
    await sending;
  }
  assert.equal(contender.records.length, 0, 'the first send has not yet been admitted; another window must not send its draft again');
  assert.ok(contender.retryAt > Date.now());
});

test('send lifecycle survives runtime metadata retirement and unload and waits for durable success cleanup', async t => {
  const f = await fixture(t), first = capture(), second = capture();
  await attachSnapshotDurably(f.conversation, f.target, first, f.store, f.persistence);
  await attachSnapshotDurably(f.conversation, f.target, second, f.store, f.persistence);
  const [firstId, secondId] = f.input.state.getSnapshot().attachmentIds;
  let announce, admit, cleaning, finishCleanup;
  const started = new Promise(resolve => { announce = resolve; });
  const admission = new Promise(resolve => { admit = resolve; });
  const cleanupStarted = new Promise(resolve => { cleaning = resolve; });
  const cleanup = new Promise(resolve => { finishCleanup = resolve; });
  const originalPrompt = f.session.prompt.bind(f.session), originalRemove = f.persistence.remove.bind(f.persistence);
  f.session.prompt = async (...args) => { announce(); await admission; return originalPrompt(...args); };
  f.persistence.remove = async value => { if (value === first.snapshotId) { cleaning(); await cleanup; } return originalRemove(value); };
  const retainedSend = f.conversation.sendSession;
  const sending = retainedSend(f.session, 'Inspect the first snapshot', [firstId], 'default');
  assert.equal(f.store.hasInFlightSession('session-a'), true, 'preflight round trips already reserve the pending send');
  assert.deepEqual(f.store.getInFlightSessions(), ['session-a']);
  let idle = false;
  const waiting = f.store.waitForInFlight().then(() => { idle = true; });
  await started;
  f.input.removeAttachment(firstId);
  f.conversation.releaseDraftAttachment(firstId);
  assert.equal(f.store.get(firstId), undefined);
  assert.equal(f.store.hasInFlightSession('session-a'), true, 'scope retirement must not erase the pending send owner');
  await f.stop();
  await assert.rejects(retainedSend(f.session, 'Do not start after unload', [secondId], 'default'), /插件已停用/);
  assert.equal(idle, false);
  admit();
  await cleanupStarted;
  assert.equal(idle, false, 'accepted input still owns its durable cleanup attempt');
  assert.equal(f.store.hasInFlightSession('session-a'), true);
  finishCleanup();
  const result = await sending;
  await waiting;
  assert.equal(result.kind, 'success');
  assert.equal(idle, true);
  assert.equal(f.store.hasInFlightSession('session-a'), false);
  assert.deepEqual(f.store.getInFlightSessions(), []);
  assert.equal(f.prompts.length, 1);
});

test('official Host business rejection clears the matching intent and the retained card retries normally', async t => {
  const f = await fixture(t), saved = capture();
  await attachSnapshotDurably(f.conversation, f.target, saved, f.store, f.persistence);
  const ids = f.input.state.getSnapshot().attachmentIds;
  let promptError = null;
  f.session.getSnapshot = () => ({ subagent: null, promptError });
  const prompt = f.session.prompt.bind(f.session);
  f.session.prompt = async () => {
    promptError = { op: 'send', error: { code: 'session/attachment-invalid' } };
    return { ok: false, error: promptError.error };
  };
  const rejected = await f.conversation.sendSession(f.session, 'Inspect', ids, 'default');
  assert.equal(rejected.kind, 'error');
  assert.equal(f.store.unconfirmedSends.has(saved.snapshotId), false);
  assert.equal((await f.archive.claim('window-a', 'session-a')).records[0].submissionIntent, undefined);
  assert.equal(f.conversation.resolveDraftAttachments(ids).length, 1);
  f.session.prompt = async (...args) => { promptError = null; return prompt(...args); };
  assert.equal((await f.conversation.sendSession(f.session, 'Retry inspect', ids, 'default')).kind, 'success');
  assert.equal(f.prompts.length, 1);
});

test('a disconnected or generic-error Host send retains its card but cannot send that capture again', async t => {
  for (const mode of ['structured-cancel', 'throw-after-call']) await t.test(mode, async inner => {
    const f = await fixture(inner), saved = capture();
    await attachSnapshotDurably(f.conversation, f.target, saved, f.store, f.persistence);
    const ids = f.input.state.getSnapshot().attachmentIds, errors = [];
    let promptCalls = 0, promptError = null;
    f.persistence.onError = error => errors.push(error.message);
    f.session.getSnapshot = () => ({ subagent: null, promptError });
    f.session.prompt = async () => {
      promptCalls += 1;
      if (mode === 'throw-after-call') throw new Error('disconnected after request dispatch');
      promptError = { op: 'send', error: { code: 'gateway/cancelled' } };
      return { ok: false, error: promptError.error };
    };
    const first = f.conversation.sendSession(f.session, 'Inspect', ids, 'default');
    if (mode === 'throw-after-call') await assert.rejects(first, /disconnected/);
    else assert.equal((await first).kind, 'error');
    const record = (await f.archive.claim('window-a', 'session-a')).records[0];
    assert.equal(record.submissionIntent.status, 'unconfirmed');
    assert.equal(f.store.unconfirmedSends.has(saved.snapshotId), true);
    assert.equal(f.conversation.resolveDraftAttachments(ids).length, 1);
    await assert.rejects(f.conversation.sendSession(f.session, 'Do not duplicate', ids, 'default'), /状态尚未确认/);
    assert.equal(promptCalls, 1);
    assert.ok(errors.some(message => message.includes('状态尚未确认')));
  });
});

test('a lost begin-intent acknowledgement proves no original send was invoked and leaves the draft retryable', async t => {
  const f = await fixture(t), saved = capture();
  await attachSnapshotDurably(f.conversation, f.target, saved, f.store, f.persistence);
  const ids = f.input.state.getSnapshot().attachmentIds, begin = f.persistence.beginSend.bind(f.persistence);
  let attempts = 0;
  f.persistence.beginSend = async (...args) => {
    const result = await begin(...args);
    if (++attempts === 1) throw new Error('intent reply disconnected');
    return result;
  };
  await assert.rejects(f.conversation.sendSession(f.session, 'Inspect', ids, 'default'), /intent reply/);
  assert.equal(f.prompts.length, 0);
  assert.equal((await f.archive.claim('window-a', 'session-a')).records[0].submissionIntent, undefined);
  assert.equal((await f.conversation.sendSession(f.session, 'Retry', ids, 'default')).kind, 'success');
  assert.equal(f.prompts.length, 1);
});

test('official local image encoding failure before Session.prompt clears its intent without guessing a transport failure', async t => {
  const f = await fixture(t), saved = capture();
  await attachSnapshotDurably(f.conversation, f.target, saved, f.store, f.persistence);
  const ids = f.input.state.getSnapshot().attachmentIds;
  const file = f.conversation.resolveDraftAttachments(ids)[0].file, read = file.arrayBuffer.bind(file);
  file.arrayBuffer = async () => { throw new Error('local image read failed'); };
  await assert.rejects(f.conversation.sendSession(f.session, 'Inspect', ids, 'default'), /local image read failed/);
  assert.equal(f.prompts.length, 0);
  assert.equal((await f.archive.claim('window-a', 'session-a')).records[0].submissionIntent, undefined);
  file.arrayBuffer = read;
  assert.equal((await f.conversation.sendSession(f.session, 'Retry', ids, 'default')).kind, 'success');
});

test('a transient confirmed-rejection cleanup error is retried before the same card sends again', async t => {
  const f = await fixture(t), saved = capture();
  await attachSnapshotDurably(f.conversation, f.target, saved, f.store, f.persistence);
  const ids = f.input.state.getSnapshot().attachmentIds, reject = f.persistence.rejectSend.bind(f.persistence);
  let promptError = null, rejectCalls = 0;
  f.session.getSnapshot = () => ({ subagent: null, promptError });
  const prompt = f.session.prompt.bind(f.session);
  f.session.prompt = async () => {
    promptError = { op: 'send', error: { code: 'session/attachment-invalid' } };
    return { ok: false, error: promptError.error };
  };
  f.persistence.rejectSend = async (...args) => {
    if (++rejectCalls === 1) throw new Error('transient disk failure');
    return reject(...args);
  };
  assert.equal((await f.conversation.sendSession(f.session, 'Inspect', ids, 'default')).kind, 'error');
  assert.equal(f.store.unconfirmedSends.has(saved.snapshotId), true);
  f.session.prompt = async (...args) => { promptError = null; return prompt(...args); };
  assert.equal((await f.conversation.sendSession(f.session, 'Retry', ids, 'default')).kind, 'success');
  assert.equal(rejectCalls, 2); assert.equal(f.prompts.length, 1);
});

test('another composer last-error update cannot clear this attempt with a cancelled RemoteResult', async t => {
  const f = await fixture(t), saved = capture();
  await attachSnapshotDurably(f.conversation, f.target, saved, f.store, f.persistence);
  const ids = f.input.state.getSnapshot().attachmentIds;
  let unrelatedError = null;
  f.session.getSnapshot = () => ({ subagent: null, promptError: unrelatedError });
  f.session.prompt = async () => {
    // A different concurrent composer/lookup publishes a definite rejection,
    // while this identified admission has only a transport cancellation.
    unrelatedError = { op: 'send', error: { code: 'session/attachment-invalid' } };
    return { ok: false, error: { code: 'gateway/cancelled' } };
  };
  assert.equal((await f.conversation.sendSession(f.session, 'Inspect', ids, 'default')).kind, 'error');
  assert.equal((await f.archive.claim('window-a', 'session-a')).records[0].submissionIntent.status, 'unconfirmed');
});
