import { cleanAppIcon } from './app-icon.mjs';

const SNAPSHOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const iconRequests = new Map();
const MAX_CACHED_ICONS = 256;

/** Icons are local display metadata; never read them from model context v3. */
export function loadSnapshotAppIcon(id, fetcher = globalThis.fetch) {
  if (!SNAPSHOT_ID.test(id) || typeof fetcher !== 'function') return Promise.resolve(undefined);
  // Durable display records use canonical UUID keys. Keep the capture/request
  // spelling intact, but share this local icon lookup across equivalent IDs.
  const cacheKey = id.toLowerCase();
  if (iconRequests.has(cacheKey)) return iconRequests.get(cacheKey);
  const pending = Promise.resolve().then(async () => {
    const controller = typeof globalThis.AbortController === 'function' ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), 5000) : null;
    try {
      const response = await fetcher('/api/context-snapshot', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'snapshotMetadata', snapshotIds: [id] }), ...(controller ? { signal: controller.signal } : {}) });
      if (!response.ok) throw new Error('Snapshot display metadata is unavailable');
      const value = await response.json();
      const icon = cleanAppIcon(value?.metadata?.[id]?.appIconPngBase64 ?? value?.metadata?.[cacheKey]?.appIconPngBase64);
      if (!icon && iconRequests.get(cacheKey) === pending) iconRequests.delete(cacheKey);
      return icon;
    } finally { if (timeout !== null) clearTimeout(timeout); }
  }).catch(() => {
    // A failed lookup must be retryable on a later mount, while the current
    // card keeps its generic icon and the saved context remains inspectable.
    if (iconRequests.get(cacheKey) === pending) iconRequests.delete(cacheKey);
    return undefined;
  });
  iconRequests.set(cacheKey, pending);
  if (iconRequests.size > MAX_CACHED_ICONS) iconRequests.delete(iconRequests.keys().next().value);
  return pending;
}
