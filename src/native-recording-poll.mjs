/** Poll only while a native gesture is being collected; native retains the peak. */
export function watchNativeRecording(read, token, onState, onError, options = {}) {
  const schedule = options.schedule ?? setTimeout, cancel = options.cancel ?? clearTimeout;
  let active = true, timer = null;
  async function poll() {
    timer = null;
    try {
      const state = await read(token);
      if (!active || options.isCurrent?.() === false) return;
      onState(state);
      if (!active || ['complete', 'too_many', 'interrupted', 'expired', 'ended'].includes(state.state)) { active = false; return; }
      timer = schedule(poll, 100);
    } catch (error) {
      if (active && options.isCurrent?.() !== false) { active = false; onError(error); }
    }
  }
  void poll();
  return () => { active = false; if (timer !== null) cancel(timer); };
}
