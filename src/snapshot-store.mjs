import { cleanAppIcon } from './app-icon.mjs';

/** Live attachment metadata; durable records keep their PNG paired separately. */
export function createSnapshotStore() {
  const snapshots = new Map(), listeners = new Set(), unconfirmedSends = new Set(), unconfirmedRecords = new Map();
  let version = 0;

  function changed() {
    version += 1;
    // Observers cannot turn a completed metadata mutation into a partial edit.
    for (const listener of [...listeners]) { try { listener(); } catch {} }
  }

  return {
    // Host also releases registry bytes when a Session scope retires. Only
    // an explicit card removal may retire the matching durable draft.
    removalIntents: new Set(),
    // A retained card must not retry an admission whose outcome is unknown.
    // The durable Host record is authoritative after a page/process restart.
    unconfirmedSends,
    // Only identity/time are cached while history reconciliation waits. This
    // prevents re-downloading the complete private PNG on every poll.
    unconfirmedRecords,
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
      // These fields are validated at native admission. Clone them so later
      // capture mutations cannot alter a saved preview or an in-flight send.
      for (const key of ['captureQuality', 'source', 'timing']) {
        if (capture[key] !== undefined) {
          if (!capture[key] || typeof capture[key] !== 'object' || Array.isArray(capture[key])) throw new Error(`快照 ${key} 格式无效。`);
          metadata[key] = freezeJSON(capture[key]);
        }
      }
      for (const key of ['selectedText', 'focusedElement']) {
        if (capture[key] !== undefined) {
          if (typeof capture[key] !== 'string') throw new Error(`快照 ${key} 格式无效。`);
          metadata[key] = capture[key];
        }
      }
      const entry = Object.freeze({ id, sessionId, capture: Object.freeze(metadata) });
      snapshots.set(id, entry);
      changed();
      return entry;
    },
    delete(id) {
      const snapshotId = snapshots.get(id)?.capture.snapshotId;
      if (!snapshots.delete(id)) return false;
      unconfirmedSends.delete(snapshotId);
      unconfirmedRecords.delete(snapshotId);
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

function freezeJSON(value) {
  const copy = JSON.parse(JSON.stringify(value));
  const freeze = item => {
    if (item && typeof item === 'object') {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
    return item;
  };
  return freeze(copy);
}
