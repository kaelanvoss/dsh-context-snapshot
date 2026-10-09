import { validateNativeRecordingState } from './shortcut-native-state.mjs';

/** Pause both dispatchers and bind native physical recording to one editor. */
export function createShortcutRecording(service, send, options = {}) {
  const id = options.id ?? crypto.randomUUID();
  const owners = new Set();
  const listeners = new Set();
  const schedule = options.schedule ?? setInterval, cancel = options.cancel ?? clearInterval;
  let queue = Promise.resolve(), heartbeat = null, disposed = false, errorMessage = '';
  let nativeSession = null;
  function error(value) { errorMessage = value; for (const listener of listeners) listener(); }
  function enqueue(action) { const task = queue.then(action); queue = task.catch(() => {}); return task; }
  function stopHeartbeat() { if (heartbeat !== null) cancel(heartbeat); heartbeat = null; }
  async function resume() {
    let failed = false, failure;
    // A confirmed recording(false) also clears a recorder whose explicit end
    // response was lost. Keep trying resume rather than stranding the editor.
    if (nativeSession) {
      try { await send({ op: 'endShortcutRecording', recorderId: id, token: nativeSession.token }); nativeSession = null; }
      catch {};
    }
    try { await send({ op: 'recording', recorderId: id, active: false }); nativeSession = null; }
    catch (error) { failed = true; failure = error; }
    // A rejected Host request must never skip restoring the local dispatcher.
    try { await service?.recording?.(false); }
    catch (error) { if (!failed) { failed = true; failure = error; } }
    if (failed) throw failure;
  }
  function keepAlive() {
    if (heartbeat !== null) return;
    heartbeat = schedule(() => {
      void enqueue(async () => {
        if (!owners.size || disposed) return;
        try { await send({ op: 'recording', recorderId: id, active: true }); }
        catch (failure) {
          stopHeartbeat(); error(`录入连接已中断：${failure.message}`); options.onError?.(failure);
          try { await resume(); }
          catch {} // The host's recording lease also expires if this window disappears.
        }
      });
    }, 5000);
  }
  async function update(owner, active) {
    return enqueue(async () => {
      if (active && disposed) throw new Error('快捷键录入已结束。');
      if (active && owners.has(owner) && heartbeat !== null) return;
      if (!active && !owners.has(owner)) return;
      if (active) {
        if (!owners.size || heartbeat === null) {
          if (typeof service?.recording !== 'function') throw new Error('当前 Harness 不支持安全录入快捷键，请使用支持的 Desktop 版本。');
          try { await service.recording(true); await send({ op: 'recording', recorderId: id, active: true }); }
          catch (error) {
            try { await resume(); }
            catch { owners.add(owner); }
            throw error;
          }
        }
        owners.add(owner); error(''); keepAlive();
      } else {
        if (nativeSession?.owner === owner && owners.size > 1) {
          await send({ op: 'endShortcutRecording', recorderId: id, token: nativeSession.token }); nativeSession = null;
        }
        if (owners.size === 1) {
          stopHeartbeat();
          await resume();
        }
        owners.delete(owner);
      }
    });
  }
  async function begin(owner, supportedCodes) {
    await update(owner, true);
    return enqueue(async () => {
      if (disposed || !owners.has(owner)) throw new Error('快捷键录入已结束。');
      if (nativeSession && nativeSession.owner !== owner) throw new Error('此窗口已有另一面板正在录入快捷键。');
      if (nativeSession) {
        try { await send({ op: 'endShortcutRecording', recorderId: id, token: nativeSession.token }); }
        catch {} // A restarted Host has already retired it; begin rechecks ownership and clears any surviving recorder.
        nativeSession = null;
      }
      const token = (options.randomUUID ?? (() => crypto.randomUUID()))();
      const session = { owner, token, supportedCodes: [...supportedCodes] };
      nativeSession = session;
      try {
        const data = await send({ op: 'beginShortcutRecording', recorderId: id, token });
        return validateNativeRecordingState(data.recordingState, token, session.supportedCodes);
      } catch (failure) {
        try { await send({ op: 'endShortcutRecording', recorderId: id, token }); }
        catch {};
        nativeSession = null;
        throw failure;
      }
    });
  }
  async function read(owner, token) {
    return enqueue(async () => {
      const session = nativeSession;
      if (disposed || !session || session.owner !== owner || session.token !== token) throw new Error('录入连接已失效，请重新录入。');
      const data = await send({ op: 'shortcutRecordingState', recorderId: id, token });
      return validateNativeRecordingState(data.recordingState, token, session.supportedCodes);
    });
  }
  async function end(owner, token) {
    return enqueue(async () => {
      const session = nativeSession;
      if (!session || session.owner !== owner || session.token !== token) return;
      await send({ op: 'endShortcutRecording', recorderId: id, token });
      if (nativeSession === session) nativeSession = null;
    });
  }
  return { id, update, begin, read, end, getError: () => errorMessage, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }, dispose() {
    disposed = true;
    return enqueue(async () => {
      const active = owners.size > 0; owners.clear(); stopHeartbeat(); listeners.clear();
      if (!active) return;
      await resume();
    });
  } };
}
