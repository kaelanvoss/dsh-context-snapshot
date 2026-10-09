import { SnapshotBroker } from './broker.mjs';
import { NativeBridge } from './native.mjs';
import { ShortcutSettings } from './shortcut-settings.mjs';
export const name = 'dsh-context-snapshot';
export const inject = ['connection'];

const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f]/.test(value);
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
async function readBody(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing request body');
  const chunks = []; let size = 0;
  try { while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 4096) { await reader.cancel(); throw new Error('Request too large'); } chunks.push(value); } }
  finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createHandler(broker, native, shortcuts) {
  if (shortcuts) broker.status.shortcutApiVersion = 1;
  return async request => {
    try {
      const body = await readBody(request);
      if (!body || typeof body !== 'object') return json({ error: 'Invalid request' }, 400);
      if (body.op === 'status') return json({ status: broker.status });
      if (body.op === 'start') { await native.start(); return json({ status: broker.status }); }
      if (body.op === 'restart') { await native.restart(); return json({ status: broker.status }); }
      if (body.op === 'permissions' || body.op === 'requestPermissions') return json({ permissions: await native.request(body.op), status: broker.status });
      if (body.op === 'setShortcut') {
        if (!shortcuts || typeof body.revision !== 'string') return json({ error: '快捷键设置不可用，请重启插件。' }, 400);
        return json({ status: await shortcuts.save(body.shortcut, body.revision) });
      }
      if (body.op === 'recording') {
        if (!shortcuts || !validId(body.recorderId) || typeof body.active !== 'boolean') return json({ error: 'Invalid shortcut recorder' }, 400);
        return json({ status: await shortcuts.recording(body.recorderId, body.active) });
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
  ctx.connection.fetch.register({ path: '/api/context-snapshot', methods: ['POST'], requestBody: 'buffered', fetch: createHandler(broker, native, shortcuts) });
  ctx.effect(() => () => { shortcuts.dispose(); native.dispose(); broker.dispose(); });
  if (config.autoStart !== false) native.start();
}
