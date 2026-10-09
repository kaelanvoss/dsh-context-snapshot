/** Pause both the Harness dispatcher and the device-wide native listener while editing. */
export function createShortcutRecording(service, send, options = {}) {
  const id = options.id ?? crypto.randomUUID();
  const owners = new Set();
  const listeners = new Set();
  const schedule = options.schedule ?? setInterval, cancel = options.cancel ?? clearInterval;
  let queue = Promise.resolve(), heartbeat = null, disposed = false, errorMessage = '';
  function error(value) { errorMessage = value; for (const listener of listeners) listener(); }
  function enqueue(action) { const task = queue.then(action); queue = task.catch(() => {}); return task; }
  function stopHeartbeat() { if (heartbeat !== null) cancel(heartbeat); heartbeat = null; }
  async function resume() {
    let failed = false, failure;
    try { await send({ op: 'recording', recorderId: id, active: false }); }
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
        if (owners.size === 1) {
          stopHeartbeat();
          await resume();
        }
        owners.delete(owner);
      }
    });
  }
  return { update, getError: () => errorMessage, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }, dispose() {
    disposed = true;
    return enqueue(async () => {
      const active = owners.size > 0; owners.clear(); stopHeartbeat(); listeners.clear();
      if (!active) return;
      await resume();
    });
  } };
}
