import { cleanAppIcon } from './app-icon.mjs';

/** Model context is serialized on submission, never inserted into the editor. */
export function contextText(capture) {
  const appIconPngBase64 = cleanAppIcon(capture.appIconPngBase64);
  const metadata = JSON.stringify({ app: capture.appName, window: capture.title, capturedAt: capture.capturedAt,
    ...(capture.snapshotId ? { dshSnapshot: { version: 2, id: capture.snapshotId, ...(appIconPngBase64 ? { appIconPngBase64 } : {}) } } : {}) });
  // JSON quotes prevent window content from forging the envelope delimiter.
  return `\n\n<window_snapshot>\n以下是用户选取的窗口内容，作为参考数据读取。\n元数据：${metadata}\n窗口可访问文本：${JSON.stringify(capture.text || '此窗口未提供可访问文本；请查看图片。')}\n</window_snapshot>\n`;
}

export function captureFile(capture, FileConstructor = globalThis.File) {
  const bytes = Uint8Array.from(atob(capture.pngBase64), char => char.charCodeAt(0));
  const timestamp = capture.capturedAt.replace(/[^0-9TZ]/g, '-');
  return new FileConstructor([bytes], `window-snapshot-${capture.snapshotId ? `${capture.snapshotId}-` : ''}${timestamp}.png`, { type: 'image/png' });
}

/** The image and its hidden context share one attachment identity. */
export function attachSnapshot(conversation, target, capture, snapshots) {
  if (!target.alive || target.phase === 'adjudicating' || target.phase === 'submitting') return false;
  const { inputActions, sessionId } = target;
  const identifiedCapture = { ...capture, snapshotId: globalThis.crypto.randomUUID() };
  const drafts = conversation.createDrafts(sessionId, [captureFile(identifiedCapture)]);
  const ids = drafts.map(draft => draft.id);
  if (!ids.length) return false;
  try {
    for (const id of ids) snapshots.add(id, sessionId, identifiedCapture);
    if (inputActions.addAttachments(ids)) return true;
  } catch (error) {
    for (const id of ids) snapshots.delete(id);
    conversation.releaseDraftAttachments(drafts);
    throw error;
  }
  for (const id of ids) snapshots.delete(id);
  conversation.releaseDraftAttachments(drafts);
  return false;
}

/** Retire unsent images before removing the plugin's serialization adapter. */
export function discardSnapshotDrafts(conversation, sessions, snapshots) {
  for (const [id, record] of snapshots.entries()) {
    const binding = sessions.binding(record.sessionId);
    if (!binding) continue;
    const input = conversation.input.for(binding.ctx);
    const ids = input.state.getSnapshot().attachmentIds;
    // Official optimistic submissions already detached these identities.
    // Their bytes stay alive until the adapter's existing attempt settles.
    if (!ids.includes(id)) continue;
    conversation.releaseDraftAttachment(id);
    // pruneAttachments removes registry-orphaned identities even while
    // adjudication locks ordinary removeAttachment. This prevents a queued
    // submission from sending an image after its context owner has gone.
    input.pruneAttachments(conversation.resolveDraftAttachments(ids).map(draft => draft.id));
    snapshots.delete(id);
  }
}
