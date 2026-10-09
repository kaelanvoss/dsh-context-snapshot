import { SnapshotBroker } from './broker.mjs';
import { NativeBridge } from './native.mjs';
import { ShortcutSettings } from './shortcut-settings.mjs';
import { MAX_LINE_BYTES } from './protocol.mjs';
import { SnapshotDraftArchive } from './draft-persistence.mjs';
import { createDraftSessionEnsurer } from './draft-session.mjs';
import { validRecordingToken } from './shortcut-native-state.mjs';
export const name = 'dsh-context-snapshot';
export const inject = ['connection', 'sessions', 'sessionPersistence', 'workspaceRegistry'];

const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f]/.test(value);
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
async function readBody(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing request body');
  const chunks = []; let size = 0;
  try { while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > MAX_LINE_BYTES) { await reader.cancel(); throw new Error('Request too large'); } chunks.push(value); } }
  finally { reader.releaseLock(); }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (body?.op !== 'draftSave' && size > 4096) throw new Error('Request too large');
  return body;
}

export function createHandler(broker, native, shortcuts, drafts) {
  if (shortcuts) { broker.status.shortcutApiVersion = 1; broker.status.shortcutRecordingApiVersion = 1; }
  return async request => {
    try {
      const body = await readBody(request);
      if (!body || typeof body !== 'object') return json({ error: 'Invalid request' }, 400);
      if (body.op === 'snapshotMetadata') {
        if (!drafts || !Array.isArray(body.snapshotIds) || body.snapshotIds.length > 32) return json({ error: 'Invalid snapshot metadata request' }, 400);
        return json(await drafts.metadata(body.snapshotIds));
      }
      if (['draftSave', 'draftClaim', 'draftRenew', 'draftRelease', 'draftDelete', 'draftRebind', 'draftBeginSend', 'draftRejectSend'].includes(body.op)) {
        if (!drafts || !validId(body.ownerId)) return json({ error: '快照草稿恢复服务不可用，请重启插件。' }, 400);
        if (body.op === 'draftSave') return json(await drafts.save(body.ownerId, body.sessionId, body.capture));
        if (body.op === 'draftClaim') return json(await drafts.claim(body.ownerId, body.sessionId, body.knownIds));
        if (body.op === 'draftRenew') return json(await drafts.renew(body.ownerId, body.sessionId, body.snapshotIds));
        if (body.op === 'draftRelease') return json(await drafts.release(body.ownerId, body.sessionId));
        if (body.op === 'draftDelete') return json(await drafts.delete(body.ownerId, body.snapshotId));
        if (body.op === 'draftRebind') return json(await (body.snapshotIds ? drafts.rebindMany(body.ownerId, body.snapshotIds, body.sessionId) : drafts.rebind(body.ownerId, body.snapshotId, body.sessionId)));
        if (body.op === 'draftBeginSend') return json(await drafts.beginSend(body.ownerId, body.sessionId, body.snapshotIds, body.attemptId));
        if (body.op === 'draftRejectSend') return json(await drafts.rejectSend(body.ownerId, body.sessionId, body.snapshotIds, body.attemptId, body.rejectionCode));
      }
      if (body.op === 'status') return json({ status: broker.status });
      if (body.op === 'start') { await native.start(); return json({ status: broker.status }); }
      if (body.op === 'restart') { await native.restart(); return json({ status: broker.status }); }
      if (body.op === 'permissions' || body.op === 'requestPermissions') return json({ permissions: await native.request(body.op), status: broker.status });
      if (body.op === 'setShortcut') {
        if (!shortcuts || typeof body.revision !== 'string') return json({ error: '快捷键设置不可用，请重启插件。' }, 400);
        const nativeEditor = broker.status.supportsShortcutRecording === true;
        if (nativeEditor && (!validId(body.recorderId) || body.reset !== true && !validRecordingToken(body.token))) return json({ error: '请通过原生快捷键录入面板保存组合。' }, 400);
        return json({ status: await shortcuts.save(body.shortcut, body.revision, nativeEditor ? { owner: body.recorderId, token: body.token, reset: body.reset === true } : undefined) });
      }
      if (body.op === 'recording') {
        if (!shortcuts || !validId(body.recorderId) || typeof body.active !== 'boolean') return json({ error: 'Invalid shortcut recorder' }, 400);
        return json({ status: await shortcuts.recording(body.recorderId, body.active) });
      }
      if (['beginShortcutRecording', 'shortcutRecordingState', 'endShortcutRecording'].includes(body.op)) {
        if (!shortcuts || !validId(body.recorderId) || !validRecordingToken(body.token)) return json({ error: 'Invalid native shortcut recorder' }, 400);
        const method = body.op === 'beginShortcutRecording' ? 'beginRecording' : body.op === 'shortcutRecordingState' ? 'recordingState' : 'endRecording';
        return json({ recordingState: await shortcuts[method](body.recorderId, body.token) });
      }
      if (!validId(body.clientId) || !validId(body.sessionId)) return json({ error: 'Invalid draft identity' }, 400);
      if (body.op === 'poll') {
        if (!validId(body.viewId ?? body.clientId) || !Number.isSafeInteger(body.generation ?? 0) || (body.generation ?? 0) < 0) return json({ error: 'Invalid draft generation' }, 400);
        return json(broker.poll(body.clientId, body.sessionId, body.claim === true, body.viewId ?? body.clientId, body.generation ?? 0));
      }
      if (body.op === 'ack' && validId(body.captureId)) return json({ acknowledged: broker.acknowledge(body.clientId, body.sessionId, body.captureId) });
      if (body.op === 'release') { broker.release(body.clientId, body.sessionId, body.generation); return json({ ok: true }); }
      return json({ error: 'Unknown operation' }, 400);
    } catch (e) { return json({ error: String(e.message).slice(0, 512) }, 400); }
  };
}

/** Fetch registry inherits Harness authentication, Origin checks and Desktop bridge. */
export function apply(ctx, config = {}) {
  const broker = new SnapshotBroker();
  const native = new NativeBridge(broker, { helperPath: config.helperPath });
  const shortcuts = new ShortcutSettings(native, broker);
  const drafts = new SnapshotDraftArchive({ ensureSession: createDraftSessionEnsurer(ctx) });
  broker.status.draftApiVersion = 1;
  ctx.connection.fetch.register({ path: '/api/context-snapshot', methods: ['POST'], requestBody: 'buffered', fetch: createHandler(broker, native, shortcuts, drafts) });
  ctx.effect(() => async () => { shortcuts.dispose(); native.dispose(); broker.dispose(); await drafts.dispose(); });
  if (config.autoStart !== false) native.start();
}
