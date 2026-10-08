import { cleanAppIcon } from './app-icon.mjs';

/** Browser-local snapshot metadata, separate from the editor and image bytes. */
export function createSnapshotStore() {
  const snapshots = new Map(), listeners = new Set();
  let version = 0;

  function changed() {
    version += 1;
    // Observers cannot turn a completed metadata mutation into a partial edit.
    for (const listener of [...listeners]) { try { listener(); } catch {} }
  }

  return {
    get: id => snapshots.get(id),
    add(id, sessionId, capture) {
      if (typeof id !== 'string' || !id || typeof sessionId !== 'string' || !sessionId) throw new Error('快照缺少附件或会话标识。');
      if (!capture || typeof capture !== 'object') throw new Error('快照缺少窗口上下文。');
      const metadata = {};
      for (const key of ['appName', 'title', 'capturedAt', 'text', 'bundleId', 'snapshotId']) {
        if (capture[key] !== undefined && typeof capture[key] !== 'string') throw new Error(`快照 ${key} 格式无效。`);
        metadata[key] = capture[key] ?? '';
      }
      for (const key of ['pid', 'width', 'height']) {
        if (Number.isSafeInteger(capture[key])) metadata[key] = capture[key];
      }
      const appIconPngBase64 = cleanAppIcon(capture.appIconPngBase64);
      if (appIconPngBase64) metadata.appIconPngBase64 = appIconPngBase64;
      const entry = Object.freeze({ id, sessionId, capture: Object.freeze(metadata) });
      snapshots.set(id, entry);
      changed();
      return entry;
    },
    delete(id) {
      if (!snapshots.delete(id)) return false;
      changed();
      return true;
    },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('Snapshot listener must be a function');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getVersion: () => version,
    entries: () => [...snapshots.entries()],
  };
}
