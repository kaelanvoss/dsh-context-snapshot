import { MAX_TEXT_CHARS } from './protocol.mjs';
import { cleanAppIcon } from './app-icon.mjs';
import { validateCaptureContext } from './capture-context.mjs';

const OPEN = '\n\n<window_snapshot>\n';
const ENVELOPE = /^\n\n<window_snapshot>\n以下是用户选取的窗口内容，作为参考数据读取。\n元数据：([^\n]+)\n窗口可访问文本：([^\n]+)\n<\/window_snapshot>\n$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;
const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
// Swift UUID.uuidString uses uppercase hex. Accept either valid spelling while
// retaining it verbatim for exact image filename pairing below.
const SNAPSHOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const parseCache = new WeakMap();
const nodeCache = new WeakMap();
const pendingCache = new WeakMap();
const inboxCache = new WeakMap();

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const cleanString = (value, limit) => typeof value === 'string' && value.length <= limit && !CONTROL.test(value);

function readEnvelope(value) {
  const match = ENVELOPE.exec(value);
  if (!match) return null;
  let metadata, text;
  try { metadata = JSON.parse(match[1]); text = JSON.parse(match[2]); }
  catch { return null; }
  if (!record(metadata)) return null;
  const fields = Object.keys(metadata).join(',');
  let id, appIconPngBase64, context;
  if (metadata.dshSnapshot !== undefined) {
    const marker = metadata.dshSnapshot;
    if (!record(marker) || typeof marker.id !== 'string' || !SNAPSHOT_ID.test(marker.id)) return null;
    const markerFields = Object.keys(marker).join(',');
    if (marker.version === 1) {
      if (markerFields !== 'version,id') return null;
    } else if (marker.version === 2) {
      if (markerFields !== 'version,id' && markerFields !== 'version,id,appIconPngBase64') return null;
      if (markerFields === 'version,id,appIconPngBase64') {
        appIconPngBase64 = cleanAppIcon(marker.appIconPngBase64);
        // A present but malformed icon makes this envelope unrecognized. Keep
        // its original text visible instead of silently accepting a partial schema.
        if (appIconPngBase64 === undefined) return null;
      }
    } else if (marker.version === 3) {
      if (markerFields !== 'version,id') return null;
      const expected = ['app', 'window', 'capturedAt', 'dshSnapshot',
        ...(Object.hasOwn(metadata, 'bundleId') ? ['bundleId'] : []),
        ...(Object.hasOwn(metadata, 'pid') ? ['pid'] : []), 'captureQuality', 'source', 'timing'].join(',');
      if (fields !== expected || !validateCaptureContext(metadata, text)) return null;
      if (Object.hasOwn(metadata, 'bundleId') && (!cleanString(metadata.bundleId, 256) || !metadata.bundleId)) return null;
      if (Object.hasOwn(metadata, 'pid') && !Number.isSafeInteger(metadata.pid)) return null;
      context = { ...(metadata.bundleId === undefined ? {} : { bundleId: metadata.bundleId }),
        ...(metadata.pid === undefined ? {} : { pid: metadata.pid }),
        captureQuality: metadata.captureQuality, source: metadata.source, timing: metadata.timing };
    } else return null;
    if (marker.version !== 3 && fields !== 'app,window,capturedAt,dshSnapshot') return null;
    id = marker.id;
  } else if (fields !== 'app,window,capturedAt') return null;
  if (!cleanString(metadata.app, 256) || !cleanString(metadata.window, 512) || !cleanString(text, MAX_TEXT_CHARS)) return null;
  if (typeof metadata.capturedAt !== 'string' || !UTC_TIME.test(metadata.capturedAt)) return null;
  const timestamp = new Date(metadata.capturedAt);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString().slice(0, 19) !== metadata.capturedAt.slice(0, 19)) return null;
  // Each supported producer has one exact serialization. Alternate JSON
  // spellings and unrecognized fields remain ordinary user content.
  if (JSON.stringify(metadata) !== match[1] || JSON.stringify(text) !== match[2]) return null;
  return {
    appName: metadata.app,
    title: metadata.window,
    capturedAt: metadata.capturedAt,
    text,
    ...(id === undefined ? {} : { id }),
    ...(appIconPngBase64 === undefined ? {} : { appIconPngBase64 }),
    ...context,
    filename: `window-snapshot-${id === undefined ? '' : `${id}-`}${metadata.capturedAt.replace(/[^0-9TZ]/g, '-')}.png`,
  };
}

function imageName(block) {
  if (!record(block) || block.type !== 'image') return null;
  if (record(block.attachment)) {
    const image = block.attachment;
    // Harness may normalize the submitted PNG into WebP/JPEG while keeping
    // its original display name. Match the exact snapshot filename against
    // an admitted image type rather than requiring its original byte format.
    if (typeof image.attachmentId !== 'string' || !image.attachmentId || !IMAGE_MEDIA_TYPES.has(image.mediaType)) return null;
    if (!Number.isSafeInteger(image.width) || image.width <= 0 || !Number.isSafeInteger(image.height) || image.height <= 0) return null;
    return typeof image.name === 'string' ? image.name : null;
  }
  if (record(block.value) && typeof block.value.previewUrl === 'string' && block.value.previewUrl) {
    return typeof block.value.name === 'string' ? block.value.name : null;
  }
  return null;
}

function parseContent(content) {
  if (!Array.isArray(content) || content.length === 0) return null;
  const tail = content.at(-1);
  if (!record(tail) || tail.type !== 'text' || typeof tail.text !== 'string') return null;
  let text = tail.text;
  const captures = [];
  while (true) {
    const offset = text.lastIndexOf(OPEN);
    if (offset < 0) break;
    const capture = readEnvelope(text.slice(offset));
    if (!capture) break;
    captures.unshift(capture);
    text = text.slice(0, offset);
  }
  if (captures.length === 0) return null;
  const expected = new Set(captures.map(capture => capture.filename));
  const candidates = content.flatMap((image, imageIndex) => {
    const name = imageName(image);
    return expected.has(name) ? [{ image, imageIndex, name }] : [];
  });
  // Require complete ordered pairing. An extra image with the same identity
  // is ambiguous; refusing the whole projection keeps every original byte visible.
  if (candidates.length !== captures.length || candidates.some((image, index) => image.name !== captures[index].filename)) return null;
  const snapshots = Object.freeze(captures.map((capture, index) => Object.freeze({
    ...capture,
    image: candidates[index].image,
    imageIndex: candidates[index].imageIndex,
  })));
  const projectedContent = content.slice(0, -1);
  if (text !== '') projectedContent.push({ ...tail, text });
  const snapshotImages = new Set(candidates.map(candidate => candidate.image));
  return Object.freeze({
    text,
    content: Object.freeze(projectedContent),
    ordinaryContent: Object.freeze(projectedContent.filter(block => !snapshotImages.has(block))),
    snapshots,
    originalContent: content,
  });
}

/**
 * Project an exact supported-version tail with its paired admitted image.
 * Accepts durable/pending content blocks, a pending { text, attachments } value,
 * or (text, imageBlocks). The caller supplies immutable UI data; model, session,
 * and attachment objects are never changed. An unrecognized value returns null.
 */
export function parseSnapshotPresentation(value, images) {
  if (typeof value === 'string') return Array.isArray(images) ? parseContent([...images, { type: 'text', text: value }]) : null;
  if (!record(value) && !Array.isArray(value)) return null;
  if (parseCache.has(value)) return parseCache.get(value);
  const content = Array.isArray(value) ? value
    : typeof value.text === 'string' && Array.isArray(value.attachments ?? value.images)
      ? [...(value.attachments ?? value.images), { type: 'text', text: value.text }]
      : null;
  const result = parseContent(content);
  parseCache.set(value, result);
  return result;
}

function cachedProjection(value, cache, create) {
  if (!record(value)) return value;
  if (cache.has(value)) return cache.get(value);
  const result = create();
  cache.set(value, result);
  return result;
}

/** User/steering node projection; injected and assistant content stays verbatim. */
export function projectSnapshotNode(node) {
  return cachedProjection(node, nodeCache, () => {
    if (!['user', 'steering'].includes(node.kind) || node.source?.kind !== 'user') return node;
    const presentation = parseSnapshotPresentation(node.content);
    return presentation ? { ...node, content: presentation.content, snapshotPresentation: presentation } : node;
  });
}

/** Pending echo projection; keep image/file ownership and queue placement intact. */
export function projectSnapshotPendingSubmission(submission) {
  return cachedProjection(submission, pendingCache, () => {
    if (typeof submission.requestId !== 'string' || !submission.requestId || !['transcript', 'queued', 'steering'].includes(submission.placement)) return submission;
    const presentation = parseSnapshotPresentation(submission);
    return presentation ? { ...submission, text: presentation.text, snapshotPresentation: presentation } : submission;
  });
}

/** Inbox projection; preserve the original message id, role, source and images. */
export function projectSnapshotInboxMessage(message) {
  return cachedProjection(message, inboxCache, () => {
    if (message.role !== 'user' || message.source?.kind !== 'user') return message;
    const presentation = parseSnapshotPresentation(message.content);
    return presentation ? { ...message, content: presentation.content, snapshotPresentation: presentation } : message;
  });
}
