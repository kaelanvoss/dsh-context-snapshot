import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SnapshotDraftArchive, DRAFT_LEASE_MS, draftArchivePath } from '../src/draft-persistence.mjs';
import { createDraftPersistence, restoreSnapshotDrafts, hasSentSnapshot } from '../src/draft-recovery.mjs';
import { createSnapshotStore } from '../src/snapshot-store.mjs';
import { validateCapture } from '../src/protocol.mjs';
import { createHandler } from '../src/index.mjs';
import { SnapshotBroker } from '../src/broker.mjs';
import { contextText } from '../src/draft.mjs';
import { createController } from '../src/controller.mjs';

const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
const captureOf = (overrides = {}) => ({
  pngBase64, snapshotId: randomUUID(), appName: 'Fixture browser', title: 'Current selected dialog',
  text: 'button (enabled) Run\ncheckbox (checked) Save settings', capturedAt: '2026-10-09T00:00:00Z',
  bundleId: 'example.fixture.browser', appIconPngBase64: pngBase64,
  captureQuality: { status: 'partial', reasons: ['node_budget_reached'], textSource: 'ax', nodeCount: 300, scope: 'provider_visible_window' },
  source: { url: 'https://example.test/current', selectedText: 'selected value', focusedRole: 'text field', focusedName: 'Name' },
  timing: { imageCapturedAt: '2026-10-09T00:00:00Z', textStartedAt: '2026-10-09T00:00:00Z', textFinishedAt: '2026-10-09T00:00:00.500Z' },
  ...overrides,
});
async function archiveFixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-draft-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archive = new SnapshotDraftArchive({ directory, ...options });
  t.after(() => archive.dispose());
  return { directory, archive };
}
function recoveryFixture(archive, ownerId = 'window-a') {
  const calls = [];
  const send = body => {
    calls.push(body);
    if (body.op === 'draftSave') return archive.save(body.ownerId, body.sessionId, body.capture);
    if (body.op === 'draftClaim') return archive.claim(body.ownerId, body.sessionId, body.knownIds);
    if (body.op === 'draftRenew') return archive.renew(body.ownerId, body.sessionId, body.snapshotIds);
    if (body.op === 'draftBeginSend') return archive.beginSend(body.ownerId, body.sessionId, body.snapshotIds, body.attemptId);
    if (body.op === 'draftRejectSend') return archive.rejectSend(body.ownerId, body.sessionId, body.snapshotIds, body.attemptId, body.rejectionCode);
    if (body.op === 'draftRelease') return archive.release(body.ownerId, body.sessionId);
    if (body.op === 'draftDelete') return archive.delete(body.ownerId, body.snapshotId);
    if (body.op === 'draftRebind') return body.snapshotIds ? archive.rebindMany(body.ownerId, body.snapshotIds, body.sessionId) : archive.rebind(body.ownerId, body.snapshotId, body.sessionId);
    if (body.op === 'snapshotMetadata') return archive.metadata(body.snapshotIds);
    throw new Error(`Unknown operation ${body.op}`);
  };
  const persistence = createDraftPersistence(send, { ownerId });
  const snapshots = createSnapshotStore(), registry = new Map(), rail = [];
  const conversation = {
    createDrafts(sessionId, files) {
      return files.map(file => {
        const draft = { id: randomUUID(), kind: 'image', file, previewUrl: `blob:${sessionId}/${file.name}` };
        registry.set(draft.id, draft); return draft;
      });
    },
    releaseDraftAttachments(drafts) { for (const draft of drafts) registry.delete(draft.id); },
  };
  const target = { sessionId: 'session-a', phase: 'plain', alive: true,
    inputActions: { addAttachments(ids) { rail.push(...ids); return true; } } };
  return { persistence, snapshots, registry, rail, target, conversation, calls };
}

test('atomic record restores image, text, source, timing and stable identity only to the owning session', async t => {
  const { archive, directory } = await archiveFixture(t);
  const capture = captureOf();
  await archive.save('old-window', 'session-a', capture);
  const stored = JSON.parse(await readFile(join(directory, `${capture.snapshotId}.json`), 'utf8'));
  assert.equal(stored.capture.pngBase64, pngBase64);
  assert.deepEqual(stored.capture.source, capture.source);
  assert.deepEqual(stored.capture.captureQuality, capture.captureQuality);
  assert.deepEqual(stored.capture.timing, capture.timing);
  const restarted = new SnapshotDraftArchive({ directory }); t.after(() => restarted.dispose());
  const f = recoveryFixture(restarted, 'new-window');
  assert.equal((await restarted.claim('new-window', 'session-b')).records.length, 0);
  const restored = await restoreSnapshotDrafts(f.conversation, f.target, f.snapshots, f.persistence);
  assert.equal(restored.restored, 1);
  const entry = f.snapshots.get(f.rail[0]);
  assert.equal(entry.sessionId, 'session-a');
  assert.equal(entry.capture.snapshotId, capture.snapshotId);
  assert.notEqual(entry.id, capture.snapshotId, 'runtime draft identity is recreated by Host');
  assert.equal(entry.capture.text, capture.text);
  assert.deepEqual(entry.capture.source, capture.source);
  assert.equal(Buffer.from(await f.registry.get(entry.id).file.arrayBuffer()).toString('base64'), pngBase64);
  assert.equal((await restoreSnapshotDrafts(f.conversation, f.target, f.snapshots, f.persistence)).restored, 0);
  assert.equal(f.rail.length, 1, 'repeat recovery cannot duplicate cards');
});

test('delete atomically retires all model content while keeping bounded display decoration for history', async t => {
  const { archive, directory } = await archiveFixture(t);
  const capture = captureOf();
  await archive.save('owner', 'session-a', capture);
  await archive.delete('owner', capture.snapshotId);
  const raw = await readFile(join(directory, `${capture.snapshotId}.json`), 'utf8');
  assert.doesNotMatch(raw, /Current selected dialog|selected value|button \(enabled\)|"pngBase64"|"sessionId"/);
  assert.deepEqual((await archive.metadata([capture.snapshotId])).metadata[capture.snapshotId], { appIconPngBase64: pngBase64 });
  const restarted = new SnapshotDraftArchive({ directory }); t.after(() => restarted.dispose());
  assert.equal((await restarted.claim('owner', 'session-a')).records.length, 0);
  assert.deepEqual((await restarted.metadata([capture.snapshotId])).metadata[capture.snapshotId], { appIconPngBase64: pngBase64 });
  await assert.rejects(restarted.save('owner', 'session-a', capture), /已经发送或移除/);
});

test('one live window owns the session, with immediate release and bounded crash takeover', async t => {
  let now = 1000;
  const { archive } = await archiveFixture(t, { now: () => now });
  const capture = captureOf();
  await archive.save('window-a', 'session-a', capture);
  const blocked = await archive.claim('window-b', 'session-a');
  assert.equal(blocked.records.length, 0); assert.equal(blocked.retryAt, now + DRAFT_LEASE_MS);
  await assert.rejects(archive.save('window-b', 'session-a', captureOf()), /另一窗口/);
  await assert.rejects(archive.delete('window-b', capture.snapshotId), /另一窗口/);
  await archive.renew('window-a', 'session-a');
  now += DRAFT_LEASE_MS + 1;
  assert.equal((await archive.claim('window-b', 'session-a')).records.length, 1);
  await assert.rejects(archive.delete('window-a', capture.snapshotId), /另一窗口/);
  await archive.release('window-b', 'session-a');
  assert.equal((await archive.claim('window-a', 'session-a')).records.length, 1);
});

test('known restored identities suppress PNG retransmission without releasing ownership', async t => {
  const { archive } = await archiveFixture(t);
  const capture = captureOf(); await archive.save('owner', 'session-a', capture);
  assert.deepEqual(await archive.claim('owner', 'session-a', [capture.snapshotId]), { records: [], retryAt: null });
  assert.equal((await archive.renew('owner', 'session-a')).renewed, 1);
  assert.equal((await archive.claim('other', 'session-a')).records.length, 0);
});

test('one atomic intent covers every snapshot and fences retries and migration until confirmed rejection', async t => {
  const { archive, directory } = await archiveFixture(t);
  const captures = [captureOf(), captureOf()], ids = captures.map(capture => capture.snapshotId), attemptId = randomUUID();
  for (const capture of captures) await archive.save('window-a', 'session-a', capture);
  await archive.beginSend('window-a', 'session-a', ids, attemptId);
  await archive.beginSend('window-a', 'session-a', ids, attemptId);
  const journal = JSON.parse(await readFile(join(directory, 'dispatch.json'), 'utf8'));
  assert.deepEqual(Object.keys(journal.intents).sort(), ids.sort());
  const claimed = await archive.claim('window-a', 'session-a');
  assert.ok(claimed.records.every(record => record.submissionIntent.attemptId === attemptId));
  await assert.rejects(archive.beginSend('window-a', 'session-a', ids, randomUUID()), /状态尚未确认/);
  await assert.rejects(archive.rebindMany('window-a', ids, 'session-b'), /状态尚未确认/);
  await assert.rejects(archive.rejectSend('window-a', 'session-a', ids, attemptId, 'gateway/cancelled'), /尚未确认 Host/);
  await assert.rejects(archive.rejectSend('window-a', 'session-a', ids, randomUUID(), 'session/attachment-invalid'), /身份不一致/);
  await archive.rejectSend('window-a', 'session-a', ids, attemptId, 'session/attachment-invalid');
  assert.ok((await archive.claim('window-a', 'session-a')).records.every(record => !record.submissionIntent));
  await archive.beginSend('window-a', 'session-a', ids, randomUUID());
});

test('intent journal write failure preserves all original drafts and never partially marks a sibling', async t => {
  const { archive } = await archiveFixture(t);
  const captures = [captureOf(), captureOf()];
  for (const capture of captures) await archive.save('window-a', 'session-a', capture);
  const write = archive.atomicFile.bind(archive);
  archive.atomicFile = async (path, ...args) => { if (path.endsWith('dispatch.json')) throw new Error('disk full'); return write(path, ...args); };
  await assert.rejects(archive.beginSend('window-a', 'session-a', captures.map(capture => capture.snapshotId), randomUUID()), /disk full/);
  const result = await archive.claim('window-a', 'session-a');
  assert.equal(result.records.length, 2); assert.ok(result.records.every(record => !record.submissionIntent));
});

test('a durable tombstone wins over the old intent journal after process restart', async t => {
  const { archive, directory } = await archiveFixture(t), capture = captureOf();
  await archive.save('window-a', 'session-a', capture);
  await archive.beginSend('window-a', 'session-a', [capture.snapshotId], randomUUID());
  await archive.delete('window-a', capture.snapshotId);
  const restarted = new SnapshotDraftArchive({ directory }); t.after(() => restarted.dispose());
  assert.equal((await restarted.claim('new-window', 'session-a')).records.length, 0);
  await assert.rejects(restarted.beginSend('new-window', 'session-a', [capture.snapshotId], randomUUID()), /已发送、移除或迁移/);
});

test('capacity failures leave every existing draft intact without eviction or incomplete new record', async t => {
  const { archive, directory } = await archiveFixture(t, { maxDrafts: 1 });
  const first = captureOf(), second = captureOf();
  await archive.save('owner', 'session-a', first);
  await assert.rejects(archive.save('owner', 'session-a', second), /达到上限/);
  assert.deepEqual((await archive.claim('owner', 'session-a')).records.map(x => x.snapshotId), [first.snapshotId]);
  assert.deepEqual((await readdir(directory)).filter(x => x.endsWith('.json')), [`${first.snapshotId}.json`]);
  await archive.delete('owner', first.snapshotId);
  await archive.save('owner', 'session-a', second);
  assert.equal((await archive.claim('owner', 'session-a')).records[0].snapshotId, second.snapshotId);
});

test('byte budget rejects oversized record before committing and never truncates context to fit', async t => {
  const { archive, directory } = await archiveFixture(t, { maxDraftBytes: 100 });
  await assert.rejects(archive.save('owner', 'session-a', captureOf()), /达到上限/);
  assert.equal((await readdir(directory)).length, 0);
});

test('atomic multi-snapshot migration survives reload without split-session ownership', async t => {
  const { archive, directory } = await archiveFixture(t);
  const captures = [captureOf(), captureOf()];
  for (const capture of captures) await archive.save('owner', 'session-a', capture);
  await archive.rebindMany('owner', captures.map(x => x.snapshotId), 'session-b');
  assert.equal((await archive.claim('owner', 'session-a')).records.length, 0);
  assert.equal((await archive.claim('owner', 'session-b')).records.length, 2);
  assert.equal(JSON.parse(await readFile(join(directory, `${captures[0].snapshotId}.json`), 'utf8')).sessionId, 'session-a', 'immutable capture files remain intact');
  const routing = JSON.parse(await readFile(join(directory, 'routing.json'), 'utf8'));
  assert.ok(captures.every(x => routing.sessions[x.snapshotId] === 'session-b'));
  const restarted = new SnapshotDraftArchive({ directory }); t.after(() => restarted.dispose());
  assert.equal((await restarted.claim('new-window', 'session-a')).records.length, 0);
  assert.equal((await restarted.claim('new-window', 'session-b')).records.length, 2);
  await assert.rejects(restarted.save('new-window', 'session-a', captures[0]), /所属会话已变更/);
});

test('invalid batch migration cannot move even the first valid snapshot', async t => {
  const { archive, directory } = await archiveFixture(t);
  const capture = captureOf(); await archive.save('owner', 'session-a', capture);
  await assert.rejects(archive.rebindMany('owner', [capture.snapshotId, randomUUID()], 'session-b'), /已不存在/);
  assert.equal((await archive.claim('owner', 'session-a')).records.length, 1);
  assert.equal((await readdir(directory)).includes('routing.json'), false);
});

test('blank Session durability is acknowledged before writing a draft or committing its migration', async t => {
  const calls = [], { archive, directory } = await archiveFixture(t, { ensureSession: async sessionId => { calls.push(sessionId); } });
  const capture = captureOf();
  await archive.save('owner', 'blank-a', capture);
  assert.deepEqual(calls, ['blank-a']);
  archive.ensureSession = async sessionId => { calls.push(sessionId); throw new Error('destination Session not durable'); };
  await assert.rejects(archive.rebind('owner', capture.snapshotId, 'blank-b'), /not durable/);
  assert.equal((await archive.claim('owner', 'blank-a')).records.length, 1);
  assert.equal((await archive.claim('owner', 'blank-b')).records.length, 0);
  assert.equal((await readdir(directory)).includes('routing.json'), false);
  await assert.rejects(archive.save('owner', 'blank-a', captureOf()), /not durable/);
  assert.equal((await archive.claim('owner', 'blank-a')).records.length, 1, 'failed save preserves the original complete capture');
});

test('session migration refuses a target currently owned by another window', async t => {
  const { archive } = await archiveFixture(t);
  const capture = captureOf(); await archive.save('window-a', 'session-a', capture);
  await archive.save('window-b', 'session-b', captureOf());
  await assert.rejects(archive.rebind('window-a', capture.snapshotId, 'session-b'), /另一窗口/);
  assert.equal((await archive.claim('window-a', 'session-a')).records.length, 1);
});

test('unfinished atomic temporary files never become recoverable attachments', async t => {
  const { archive, directory } = await archiveFixture(t);
  await writeFile(join(directory, `${randomUUID()}.json.abandoned.tmp`), '{"capture":{"pngBase64":"image-without-context"');
  assert.deepEqual(await archive.claim('owner', 'session-a'), { records: [], retryAt: null });
});

test('unknown archive schema is visible and preserved rather than migrated to an image-only attachment', async t => {
  const { archive, directory } = await archiveFixture(t);
  const snapshotId = randomUUID(), raw = JSON.stringify({ version: 99, snapshotId, pngBase64 });
  const path = join(directory, `${snapshotId}.json`); await writeFile(path, raw);
  await assert.rejects(archive.claim('owner', 'session-a'), /无法识别/);
  assert.equal(await readFile(path, 'utf8'), raw);
});

test('corrupt image-context association is rejected and kept for explicit repair', async t => {
  const { archive, directory } = await archiveFixture(t);
  const capture = captureOf();
  await writeFile(join(directory, `${capture.snapshotId}.json`), JSON.stringify({ version: 1, kind: 'draft', snapshotId: capture.snapshotId, sessionId: 'session-a', capture: { ...validateCapture(capture), snapshotId: randomUUID() } }));
  await assert.rejects(archive.claim('owner', 'session-a'), /标识不一致/);
  assert.equal((await readdir(directory)).length, 1);
});

test('save is idempotent after a lost response, but cannot overwrite the captured scene', async t => {
  const { archive } = await archiveFixture(t);
  const capture = captureOf();
  await archive.save('owner', 'session-a', capture);
  await archive.save('owner', 'session-a', capture);
  assert.equal((await archive.claim('owner', 'session-a')).records.length, 1);
  await assert.rejects(archive.save('owner', 'session-a', { ...capture, text: 'Changed content' }), /不可覆盖/);
  assert.equal((await archive.claim('owner', 'session-a')).records[0].capture.text, capture.text);
});

test('POSIX draft records use private file permissions', async t => {
  if (process.platform === 'win32') return;
  const { archive, directory } = await archiveFixture(t);
  const capture = captureOf(); await archive.save('owner', 'session-a', capture);
  assert.equal((await stat(join(directory, `${capture.snapshotId}.json`))).mode & 0o777, 0o600);
});

test('invalid identities and non-PNG content never become disk paths or saved records', async t => {
  const { archive, directory } = await archiveFixture(t);
  await assert.rejects(archive.save('owner', 'session-a', captureOf({ snapshotId: '../escape' })), /标识无效/);
  await assert.rejects(archive.save('owner', 'session-a', captureOf({ pngBase64: 'AAAA' })), /PNG/);
  await assert.rejects(archive.save('owner', 'session\u0000-a', captureOf()), /标识/);
  assert.equal((await readdir(directory)).length, 0);
});

test('display metadata responses contain no model text, source or screenshot bytes', async t => {
  const { archive } = await archiveFixture(t);
  const capture = captureOf(); await archive.save('owner', 'session-a', capture);
  const result = await archive.metadata([capture.snapshotId]);
  assert.deepEqual(Object.keys(result.metadata[capture.snapshotId]), ['appIconPngBase64']);
  assert.doesNotMatch(JSON.stringify(result), /selected value|https:\/\/example|pngBase64|Current selected/);
});

test('filesystem failures are reported and never acknowledged as durable success', async t => {
  const { directory } = await archiveFixture(t);
  const path = join(directory, 'not-a-directory'); await writeFile(path, 'occupied');
  const archive = new SnapshotDraftArchive({ directory: path }); t.after(() => archive.dispose());
  await assert.rejects(archive.save('owner', 'session-a', captureOf()), /无法恢复/);
  assert.equal(await readFile(path, 'utf8'), 'occupied');
});

test('recovery refused by locked intake releases runtime bytes but retains the complete disk draft', async t => {
  const { archive } = await archiveFixture(t);
  const capture = captureOf(); await archive.save('window-a', 'session-a', capture);
  const f = recoveryFixture(archive); f.target.inputActions.addAttachments = () => false;
  assert.equal((await restoreSnapshotDrafts(f.conversation, f.target, f.snapshots, f.persistence)).restored, 0);
  assert.equal(f.registry.size, 0); assert.equal(f.snapshots.entries().length, 0);
  assert.equal((await archive.claim('window-a', 'session-a')).records[0].capture.pngBase64, pngBase64);
});

test('unmounted target during restore cannot receive attachments', async t => {
  const { archive } = await archiveFixture(t);
  const capture = captureOf(); await archive.save('window-a', 'session-a', capture);
  const f = recoveryFixture(archive), original = f.persistence.claim;
  f.persistence.claim = async (...args) => { const value = await original(...args); f.target.alive = false; return value; };
  assert.equal((await restoreSnapshotDrafts(f.conversation, f.target, f.snapshots, f.persistence)).restored, 0);
  assert.equal(f.registry.size, 0); assert.equal(f.rail.length, 0);
});

test('fresh intake during recovery does not create a duplicate stable snapshot', async t => {
  const { archive } = await archiveFixture(t);
  const capture = captureOf(); await archive.save('window-a', 'session-a', capture);
  const f = recoveryFixture(archive), original = f.persistence.claim;
  f.persistence.claim = async (...args) => { const value = await original(...args); f.snapshots.add('live-draft', 'session-a', capture); return value; };
  assert.equal((await restoreSnapshotDrafts(f.conversation, f.target, f.snapshots, f.persistence)).restored, 0);
  assert.equal(f.registry.size, 0); assert.equal(f.snapshots.entries().length, 1);
});

test('wrong-session or incomplete remote records fail before any image enters the Host registry', async () => {
  const capture = captureOf(), snapshots = createSnapshotStore(); let createCalls = 0;
  const conversation = { createDrafts() { createCalls += 1; return []; } };
  const target = { alive: true, phase: 'plain', sessionId: 'session-a' };
  for (const record of [{ version: 1, kind: 'draft', sessionId: 'session-b', snapshotId: capture.snapshotId, capture },
    { version: 1, kind: 'draft', sessionId: 'session-a', snapshotId: capture.snapshotId, capture: { ...capture, pngBase64: undefined } }]) {
    await assert.rejects(restoreSnapshotDrafts(conversation, target, snapshots, { claim: async () => ({ records: [record] }) }), /不完整/);
  }
  assert.equal(createCalls, 0);
});

test('live metadata makes a deeply immutable copy of quality, source and timing', () => {
  const capture = captureOf(), snapshots = createSnapshotStore();
  const record = snapshots.add('runtime-id', 'session-a', capture);
  capture.source.selectedText = 'mutated'; capture.captureQuality.reasons.push('provider_read_failed');
  assert.equal(record.capture.source.selectedText, 'selected value');
  assert.deepEqual(record.capture.captureQuality.reasons, ['node_budget_reached']);
  assert.throws(() => record.capture.captureQuality.reasons.push('provider_read_failed'), TypeError);
  assert.equal(record.capture.pngBase64, undefined, 'large image stays in Host registry, not UI metadata');
});

test('browser mutation queue orders save, migration and cleanup and resumes after failure', async t => {
  const { archive } = await archiveFixture(t);
  const f = recoveryFixture(archive), capture = captureOf();
  const saved = f.persistence.save('session-a', capture);
  const moved = f.persistence.rebindMany([capture.snapshotId], 'session-b');
  const deleted = f.persistence.remove(capture.snapshotId);
  await Promise.all([saved, moved, deleted]);
  assert.deepEqual(f.calls.map(x => x.op), ['draftSave', 'draftRebind', 'draftDelete']);
  assert.equal((await archive.claim('window-a', 'session-b')).records.length, 0);
  await assert.rejects(f.persistence.save('session-a', captureOf({ pngBase64: 'AAAA' })), /PNG/);
  await f.persistence.save('session-a', captureOf());
  assert.equal((await archive.claim('window-a', 'session-a')).records.length, 1);
});

test('browser transport rejects missing acknowledgments instead of reporting storage success', async () => {
  const persistence = createDraftPersistence(async () => ({}), { ownerId: 'window' });
  await assert.rejects(persistence.save('session', captureOf()), /保存未确认/);
  await assert.rejects(persistence.remove(randomUUID()), /清理未确认/);
  await assert.rejects(persistence.rebind(randomUUID(), 'session'), /迁移未确认/);
  await assert.rejects(persistence.claim('session'), /恢复接口不兼容/);
  await assert.rejects(persistence.beginSend('session', [randomUUID()], randomUUID()), /持久化未确认/);
  await assert.rejects(persistence.rejectSend('session', [randomUUID()], randomUUID(), 'session/attachment-invalid'), /拒绝状态未确认/);
});

test('plugin cleanup releases owned session leases while keeping durable drafts recoverable', async t => {
  const { archive } = await archiveFixture(t);
  const f = recoveryFixture(archive), capture = captureOf();
  await f.persistence.save('session-a', capture);
  await f.persistence.dispose();
  assert.equal((await archive.claim('new-window', 'session-a')).records.length, 1);
});

test('archive location uses the existing platform app-data root', () => {
  assert.equal(draftArchivePath('darwin', {}, '/Users/fixture'), '/Users/fixture/Library/Application Support/dsh-context-snapshot/drafts-v1');
  assert.match(draftArchivePath('win32', { LOCALAPPDATA: '/local-data' }, '/Users/fixture'), /local-data\/dsh-context-snapshot\/drafts-v1$/);
});

test('archive validation preserves the same native quality facts used by the model context', async t => {
  const { archive } = await archiveFixture(t);
  const capture = captureOf({ captureQuality: { status: 'image_only', reasons: ['accessibility_permission_denied'], textSource: 'ax', scope: 'provider_visible_window' }, text: '' });
  await archive.save('owner', 'session-a', capture);
  const stored = (await archive.claim('owner', 'session-a')).records[0].capture;
  assert.deepEqual(stored.captureQuality, validateCapture(capture).captureQuality);
});

test('reload rejects altered quality/source schemas instead of quietly rewriting captured facts', async t => {
  const { archive, directory } = await archiveFixture(t);
  const capture = captureOf(); await archive.save('owner', 'session-a', capture);
  const path = join(directory, `${capture.snapshotId}.json`);
  const altered = JSON.parse(await readFile(path, 'utf8'));
  altered.capture.captureQuality.reasons.push('invented_reason');
  await writeFile(path, JSON.stringify(altered));
  const restarted = new SnapshotDraftArchive({ directory }); t.after(() => restarted.dispose());
  await assert.rejects(restarted.claim('new-owner', 'session-a'), /质量或来源字段无效/);
  assert.ok(JSON.parse(await readFile(path, 'utf8')).capture.captureQuality.reasons.includes('invented_reason'));
});

test('valid-looking corrupted PNG or metadata is detected by the paired-record checksum', async t => {
  const { archive, directory } = await archiveFixture(t);
  const capture = captureOf(); await archive.save('owner', 'session-a', capture);
  const path = join(directory, `${capture.snapshotId}.json`);
  const altered = JSON.parse(await readFile(path, 'utf8'));
  altered.capture.title = 'A different but syntactically valid window';
  await writeFile(path, JSON.stringify(altered));
  const restarted = new SnapshotDraftArchive({ directory }); t.after(() => restarted.dispose());
  await assert.rejects(restarted.claim('new-owner', 'session-a'), /校验失败/);
});

test('real HTTP handler accepts complete archive frames larger than legacy 4KiB and retains small-operation cap', async t => {
  const { archive } = await archiveFixture(t);
  const handler = createHandler(new SnapshotBroker(), {}, undefined, archive);
  const requestOf = value => new Request('http://localhost/api/context-snapshot', { method: 'POST', body: JSON.stringify(value) });
  const capture = captureOf({ text: 'Structured accessible state\n'.repeat(220) });
  const saveRequest = requestOf({ op: 'draftSave', ownerId: 'owner', sessionId: 'session-a', capture });
  assert.ok(Number(saveRequest.headers.get('content-length') ?? 0) === 0);
  assert.ok(JSON.stringify(capture).length > 4096);
  const saved = await handler(saveRequest);
  assert.equal(saved.status, 200); assert.deepEqual(await saved.json(), { saved: true });
  const restored = await handler(requestOf({ op: 'draftClaim', ownerId: 'owner', sessionId: 'session-a' }));
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).records[0].capture.text, capture.text);
  const attemptId = randomUUID();
  const begun = await handler(requestOf({ op: 'draftBeginSend', ownerId: 'owner', sessionId: 'session-a', snapshotIds: [capture.snapshotId], attemptId }));
  assert.equal(begun.status, 200); assert.deepEqual(await begun.json(), { begun: true });
  const unclear = await handler(requestOf({ op: 'draftRejectSend', ownerId: 'owner', sessionId: 'session-a', snapshotIds: [capture.snapshotId], attemptId, rejectionCode: 'gateway/cancelled' }));
  assert.equal(unclear.status, 400);
  const rejected = await handler(requestOf({ op: 'draftRejectSend', ownerId: 'owner', sessionId: 'session-a', snapshotIds: [capture.snapshotId], attemptId, rejectionCode: 'session/attachment-invalid' }));
  assert.equal(rejected.status, 200); assert.deepEqual(await rejected.json(), { rejected: true });
  const legacyOversize = await handler(requestOf({ op: 'status', padding: 'x'.repeat(5000) }));
  assert.equal(legacyOversize.status, 400); assert.match((await legacyOversize.json()).error, /Request too large/);
  const metadata = await handler(requestOf({ op: 'snapshotMetadata', snapshotIds: [capture.snapshotId] }));
  assert.equal(metadata.status, 200);
  assert.deepEqual((await metadata.json()).metadata[capture.snapshotId], { appIconPngBase64: pngBase64 });
});

test('pagehide sends only small keepalive lease release frames and keeps disk drafts intact', async t => {
  const { archive } = await archiveFixture(t);
  const f = recoveryFixture(archive), capture = captureOf();
  await f.persistence.save('session-a', capture);
  const requests = [];
  f.persistence.releaseOnPageHide((url, options) => { requests.push({ url, options }); return Promise.resolve(); });
  assert.equal(requests.length, 1); assert.equal(requests[0].options.keepalive, true);
  assert.deepEqual(JSON.parse(requests[0].options.body), { op: 'draftRelease', ownerId: 'window-a', sessionId: 'session-a' });
  assert.equal((await archive.claim('window-a', 'session-a')).records.length, 1);
});

test('pagehide preserves an unconfirmed send lease while releasing idle session leases', async t => {
  let now = 1000;
  const { archive } = await archiveFixture(t, { now: () => now });
  const f = recoveryFixture(archive), active = captureOf(), idle = captureOf();
  await f.persistence.save('sending-session', active);
  await f.persistence.save('idle-session', idle);
  const requests = [];
  f.persistence.releaseOnPageHide((url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    return archive.release(body.ownerId, body.sessionId);
  }, sessionId => sessionId !== 'sending-session');
  await archive.queue;
  assert.deepEqual(requests.map(body => body.sessionId), ['idle-session']);
  assert.notEqual((await archive.claim('another-window', 'sending-session')).retryAt, null);
  assert.equal((await archive.claim('another-window', 'idle-session')).records.length, 1);
  now += DRAFT_LEASE_MS + 1;
  assert.equal((await archive.claim('another-window', 'sending-session')).records.length, 1,
    'page exit preserves only the bounded lease, without promising permanent renewal');
});

test('a main-view change during history reconciliation cannot restore into a retired composer', async t => {
  const { archive } = await archiveFixture(t);
  const f = recoveryFixture(archive), capture = captureOf();
  await archive.save('window-a', 'session-a', capture);
  let eligible = true, reconcile;
  f.target.isEligible = () => eligible;
  f.target.hasSentSnapshot = () => new Promise(resolve => { reconcile = resolve; });
  const restoring = restoreSnapshotDrafts(f.conversation, f.target, f.snapshots, f.persistence);
  while (!reconcile) await new Promise(resolve => setImmediate(resolve));
  eligible = false;
  reconcile(false);
  assert.equal((await restoring).restored, 0);
  assert.equal(f.rail.length, 0);
  assert.equal(f.registry.size, 0);
  assert.equal((await archive.claim('window-a', 'session-a')).records.length, 1);
});

test('a retired composer releases its lease only after detached snapshot sends settle', async () => {
  let inFlight = true, settle;
  const settled = new Promise(resolve => { settle = resolve; }), released = [];
  const snapshots = { entries: () => [], hasInFlightSession: () => inFlight, waitForInFlight: () => settled };
  const persistence = { release: async sessionId => { released.push(sessionId); } };
  const environment = { hasFocus: () => false, schedule: () => 1, cancel: () => {}, makeId: () => randomUUID() };
  const controller = createController({}, async () => ({}), environment, snapshots, persistence);
  const leave = controller.register({ sessionId: 'session-a', alive: true, isEligible: () => false });
  leave();
  await Promise.resolve();
  assert.deepEqual(released, []);
  inFlight = false; settle();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(released, ['session-a']);
  controller.dispose();
});

test('returning to a session before its send settles cancels the old composer delayed release', async () => {
  let inFlight = true, settle;
  const settled = new Promise(resolve => { settle = resolve; }), released = [];
  const snapshots = { entries: () => [], hasInFlightSession: () => inFlight, waitForInFlight: () => settled };
  const persistence = { release: async sessionId => { released.push(sessionId); } };
  const environment = { hasFocus: () => false, schedule: () => 1, cancel: () => {}, makeId: () => randomUUID() };
  const controller = createController({}, async () => ({}), environment, snapshots, persistence);
  const target = () => ({ sessionId: 'session-a', alive: true, isEligible: () => false });
  controller.register(target())();
  const leaveAgain = controller.register(target());
  inFlight = false; settle();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(released, []);
  leaveAgain();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(released, ['session-a']);
  controller.dispose();
});

function durableMessage(capture) {
  const filename = `window-snapshot-${capture.snapshotId}-${capture.capturedAt.replace(/[^0-9TZ]/g, '-')}.png`;
  return { source: { kind: 'user', rpcId: 'accepted-request' }, content: [
    { type: 'image', attachment: { attachmentId: 'sha256:fixture', mediaType: 'image/png', width: 1, height: 1, name: filename } },
    { type: 'text', text: 'User explanation' + contextText({ ...validateCapture(capture), snapshotId: capture.snapshotId }) },
  ] };
}
function historyFixture(entries = [], options = {}) {
  let window = { entries, hasMore: options.hasMore ?? false, revision: 1 };
  let state = { openState: options.openState ?? 'open', loadingOlder: false };
  let loadCalls = 0;
  const session = { getSnapshot: () => state,
    projections: { faceOf: () => ({ getSnapshot: () => options.inbox }) },
    async loadOlder() { loadCalls += 1; if (options.loadOlder) window = await options.loadOlder(window, loadCalls); } };
  const binding = { session, eventSource: { getSnapshot: () => window } };
  const sessions = { binding: id => id === 'session-a' ? binding : undefined };
  return { sessions, session, binding, setState(value) { state = { ...state, ...value }; }, get loadCalls() { return loadCalls; } };
}
const eventOf = (type, data, time = Date.parse('2026-10-09T00:00:10Z')) => ({ type: 'event', event: { type, data, time, seq: 1 } });

test('restart cannot revive an unconfirmed admission after lease expiry and later durable history retires it', async t => {
  let now = Date.parse('2026-10-09T00:00:01Z');
  const { archive, directory } = await archiveFixture(t, { now: () => now }), capture = captureOf();
  await archive.save('old-page', 'session-a', capture);
  await archive.beginSend('old-page', 'session-a', [capture.snapshotId], randomUUID());
  let admit;
  const lateAdmission = new Promise(resolve => { admit = resolve; });
  const historyEvents = [];
  const hostWork = lateAdmission.then(() => { historyEvents.push(eventOf('user/message', durableMessage(capture), now)); });
  now += DRAFT_LEASE_MS + 1;
  await archive.dispose();
  const restarted = new SnapshotDraftArchive({ directory, now: () => now }); t.after(() => restarted.dispose());
  const f = recoveryFixture(restarted, 'new-page'), history = historyFixture(historyEvents);
  f.target.hasSentSnapshot = (id, time) => hasSentSnapshot(history.sessions, 'session-a', id, time);
  const waiting = await restoreSnapshotDrafts(f.conversation, f.target, f.snapshots, f.persistence);
  assert.equal(waiting.restored, 0); assert.equal(waiting.unconfirmed, 1);
  assert.match(waiting.notice, /状态尚未确认/);
  assert.equal(f.registry.size, 0);
  assert.equal((await restarted.claim('new-page', 'session-a')).records[0].capture.pngBase64, pngBase64);
  const again = await restoreSnapshotDrafts(f.conversation, f.target, f.snapshots, f.persistence);
  assert.equal(again.unconfirmed, 1);
  assert.deepEqual(f.calls.at(-1).knownIds, [capture.snapshotId]);
  assert.deepEqual(f.snapshots.unconfirmedRecords.get(capture.snapshotId), { sessionId: 'session-a', capturedAt: capture.capturedAt });
  await assert.rejects(restarted.beginSend('new-page', 'session-a', [capture.snapshotId], randomUUID()), /状态尚未确认/);
  admit(); await hostWork;
  const accepted = await restoreSnapshotDrafts(f.conversation, f.target, f.snapshots, f.persistence);
  assert.equal(accepted.restored, 0); assert.equal(accepted.unconfirmed, 0);
  assert.equal((await restarted.claim('new-page', 'session-a')).records.length, 0);
});

test('a cached unconfirmed intent clears when Host proves its full draft was explicitly retired elsewhere', async t => {
  const { archive } = await archiveFixture(t), capture = captureOf();
  await archive.save('old-page', 'session-a', capture);
  await archive.beginSend('old-page', 'session-a', [capture.snapshotId], randomUUID());
  await archive.release('old-page', 'session-a');
  const f = recoveryFixture(archive, 'new-page'), history = historyFixture([]);
  f.target.hasSentSnapshot = (id, time) => hasSentSnapshot(history.sessions, 'session-a', id, time);
  assert.equal((await restoreSnapshotDrafts(f.conversation, f.target, f.snapshots, f.persistence)).unconfirmed, 1);
  await archive.delete('new-page', capture.snapshotId);
  const cleared = await restoreSnapshotDrafts(f.conversation, f.target, f.snapshots, f.persistence);
  assert.equal(cleared.unconfirmed, 0); assert.equal(f.snapshots.unconfirmedRecords.size, 0);
  assert.equal(f.snapshots.unconfirmedSends.size, 0);
});

test('a confirmed pre-admission business rejection restores normally on the next process', async t => {
  const { archive, directory } = await archiveFixture(t), capture = captureOf(), attemptId = randomUUID();
  await archive.save('old-page', 'session-a', capture);
  await archive.beginSend('old-page', 'session-a', [capture.snapshotId], attemptId);
  await archive.rejectSend('old-page', 'session-a', [capture.snapshotId], attemptId, 'session/attachment-invalid');
  const restarted = new SnapshotDraftArchive({ directory }); t.after(() => restarted.dispose());
  const f = recoveryFixture(restarted, 'new-page'), history = historyFixture([]);
  f.target.hasSentSnapshot = (id, time) => hasSentSnapshot(history.sessions, 'session-a', id, time);
  const result = await restoreSnapshotDrafts(f.conversation, f.target, f.snapshots, f.persistence);
  assert.equal(result.restored, 1); assert.equal(result.unconfirmed, 0);
});

test('corrupt dispatch metadata fails visibly without importing or discarding the full capture', async t => {
  const { archive, directory } = await archiveFixture(t), capture = captureOf();
  await archive.save('old-page', 'session-a', capture);
  await archive.beginSend('old-page', 'session-a', [capture.snapshotId], randomUUID());
  const path = join(directory, 'dispatch.json'), journal = JSON.parse(await readFile(path, 'utf8'));
  journal.intents[capture.snapshotId].attemptId = randomUUID();
  await writeFile(path, JSON.stringify(journal));
  const restarted = new SnapshotDraftArchive({ directory }); t.after(() => restarted.dispose());
  await assert.rejects(restarted.claim('new-page', 'session-a'), /发送确认记录校验失败/);
  assert.equal(JSON.parse(await readFile(join(directory, `${capture.snapshotId}.json`), 'utf8')).capture.pngBase64, pngBase64);
});

test('recovery reconciles accepted snapshot history before reattaching after a crash between send and cleanup', async t => {
  const { archive } = await archiveFixture(t);
  const capture = captureOf(); await archive.save('window-a', 'session-a', capture);
  const history = historyFixture([eventOf('user/message', durableMessage(capture))]);
  const f = recoveryFixture(archive);
  f.target.hasSentSnapshot = (id, time) => hasSentSnapshot(history.sessions, 'session-a', id, time);
  const result = await restoreSnapshotDrafts(f.conversation, f.target, f.snapshots, f.persistence);
  assert.equal(result.restored, 0); assert.equal(result.pending, 0);
  assert.equal(f.rail.length, 0); assert.equal(f.registry.size, 0);
  assert.equal((await archive.claim('window-a', 'session-a')).records.length, 0);
});

test('history not ready is pending evidence, never permission to resurrect a possibly accepted snapshot', async t => {
  const { archive } = await archiveFixture(t);
  const capture = captureOf(); await archive.save('window-a', 'session-a', capture);
  const history = historyFixture([], { openState: 'loading' });
  const f = recoveryFixture(archive);
  f.target.hasSentSnapshot = (id, time) => hasSentSnapshot(history.sessions, 'session-a', id, time);
  const result = await restoreSnapshotDrafts(f.conversation, f.target, f.snapshots, f.persistence);
  assert.equal(result.restored, 0); assert.equal(result.pending, 1); assert.equal(f.registry.size, 0);
  assert.equal((await archive.claim('window-a', 'session-a')).records.length, 1);
  history.setState({ openState: 'open' });
  assert.equal((await restoreSnapshotDrafts(f.conversation, f.target, f.snapshots, f.persistence)).restored, 1);
});

test('unpaired UUID text or assistant echoes cannot falsely retire a draft', async () => {
  const capture = captureOf();
  const history = historyFixture([eventOf('assistant/message', durableMessage(capture)),
    eventOf('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: capture.snapshotId }] })]);
  assert.equal(await hasSentSnapshot(history.sessions, 'session-a', capture.snapshotId, capture.capturedAt), false);
});

test('accepted queued input is reconciled through public Inbox projection and durable splice events', async () => {
  const capture = captureOf(), message = durableMessage(capture);
  const projected = historyFixture([], { inbox: { 'next-turn': [message], 'next-step': [] } });
  assert.equal(await hasSentSnapshot(projected.sessions, 'session-a', capture.snapshotId, capture.capturedAt), true);
  const spliced = historyFixture([eventOf('agent/inbox/spliced', { inserted: [message] })]);
  assert.equal(await hasSentSnapshot(spliced.sessions, 'session-a', capture.snapshotId, capture.capturedAt), true);
});

test('history pages only until the captured time is covered and finds an accepted older snapshot', async () => {
  const capture = captureOf();
  const history = historyFixture([eventOf('assistant/message', {}, Date.parse('2026-10-09T00:01:00Z'))], {
    hasMore: true,
    loadOlder(window) { return { ...window, revision: window.revision + 1, entries: [
      eventOf('user/message', durableMessage(capture)), ...window.entries,
    ] }; },
  });
  assert.equal(await hasSentSnapshot(history.sessions, 'session-a', capture.snapshotId, capture.capturedAt), true);
  assert.equal(history.loadCalls, 1);
  const covered = historyFixture([eventOf('system/message', {}, Date.parse('2026-10-08T23:59:00Z'))], { hasMore: true });
  assert.equal(await hasSentSnapshot(covered.sessions, 'session-a', capture.snapshotId, capture.capturedAt), false);
  assert.equal(covered.loadCalls, 0);
});

test('history paging failure or incomplete bounded pages remain pending instead of false absence', async () => {
  const capture = captureOf();
  const stalled = historyFixture([eventOf('assistant/message', {})], { hasMore: true });
  assert.equal(await hasSentSnapshot(stalled.sessions, 'session-a', capture.snapshotId, capture.capturedAt), null);
  assert.equal(stalled.loadCalls, 1);
  const bounded = historyFixture([eventOf('assistant/message', {})], { hasMore: true,
    loadOlder(window) { return { ...window, revision: window.revision + 1 }; } });
  assert.equal(await hasSentSnapshot(bounded.sessions, 'session-a', capture.snapshotId, capture.capturedAt, { maxPagesPerCheck: 2 }), null);
  assert.equal(bounded.loadCalls, 2);
});

test('empty sessions do not acquire persistence leases or block another window first capture', async t => {
  const { archive } = await archiveFixture(t);
  assert.equal((await archive.claim('window-a', 'session-a')).retryAt, null);
  assert.equal(archive.sessionLeases.has('session-a'), false);
  await archive.renew('window-a', 'session-a');
  assert.equal(archive.sessionLeases.has('session-a'), false);
  await archive.save('window-b', 'session-a', captureOf());
  assert.notEqual((await archive.claim('window-a', 'session-a')).retryAt, null);
});

test('pre-send ownership validation refuses stale cards already sent by a replacement window', async t => {
  let now = 1000;
  const { archive } = await archiveFixture(t, { now: () => now });
  const capture = captureOf(); await archive.save('old-window', 'session-a', capture);
  now += DRAFT_LEASE_MS + 1;
  await archive.claim('new-window', 'session-a');
  await archive.delete('new-window', capture.snapshotId);
  await assert.rejects(archive.renew('old-window', 'session-a', [capture.snapshotId]), /已发送、移除或迁移/);
  assert.equal((await archive.renew('old-window', 'session-a')).renewed, 0);
});

test('dispose waits for an in-flight claim before lease release, and refuses late claims', async () => {
  let resolveClaim;
  const pending = new Promise(resolve => { resolveClaim = resolve; });
  const calls = [];
  const persistence = createDraftPersistence(async body => {
    calls.push(body.op);
    if (body.op === 'draftClaim') return pending;
    if (body.op === 'draftRelease') return { released: true };
    throw new Error(`Unexpected ${body.op}`);
  }, { ownerId: 'old-window' });
  const claiming = persistence.claim('session-a');
  await new Promise(resolve => setImmediate(resolve));
  const disposing = persistence.dispose();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['draftClaim']);
  resolveClaim({ records: [], retryAt: null });
  await claiming; await disposing;
  assert.deepEqual(calls, ['draftClaim', 'draftRelease']);
  await assert.rejects(persistence.claim('session-a'), /窗口已关闭/);
  await assert.rejects(persistence.renew('session-a'), /窗口已关闭/);
});
