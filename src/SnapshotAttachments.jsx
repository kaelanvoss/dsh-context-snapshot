import React, { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import { SnapshotCard } from './SnapshotCard.jsx';

/** Attachment ownership stays with Harness; previews read the saved capture. */
export function SnapshotAttachments({ snapshots, Fallback, attachments, sessionId, canAcceptDrop, onRemoveAttachment, ...ownerProps }) {
  const subscribe = useCallback(listener => snapshots.subscribe(listener), [snapshots]);
  const getVersion = useCallback(() => snapshots.getVersion(), [snapshots]);
  useSyncExternalStore(subscribe, getVersion, getVersion);
  const pending = useRef(new Set());
  const [pendingIds, setPendingIds] = useState(pending.current);
  const remove = useCallback(async id => {
    if (pending.current.has(id)) return;
    pending.current.add(id);
    setPendingIds(new Set(pending.current));
    const removeAction = () => {
      // Scope teardown also releases Host images. Mark only the actual card
      // action, after durable removal is confirmed, as intentional deletion.
      snapshots.removalIntents.add(id);
      try { onRemoveAttachment(id); }
      finally { snapshots.removalIntents.delete(id); }
    };
    try {
      if (typeof snapshots.removeDurably === 'function') await snapshots.removeDurably(id, removeAction);
      else removeAction();
    } catch {
      // The durable owner reports the failure through the existing status
      // panel. Retain the card and let the user retry without another layer.
    } finally {
      snapshots.removalIntents.delete(id);
      pending.current.delete(id);
      setPendingIds(new Set(pending.current));
    }
  }, [snapshots, onRemoveAttachment]);
  const cards = [], ordinaryAttachments = [];
  for (const attachment of attachments) {
    const entry = snapshots.get(attachment.id);
    if (attachment.kind === 'image' && entry && entry.sessionId === sessionId) cards.push({ attachment, entry });
    else ordinaryAttachments.push(attachment);
  }
  const previewItems = cards.map(({ attachment, entry }) => ({ capture: entry.capture, src: attachment.previewUrl }));
  return <>
    {cards.length > 0 && <div role="group" aria-label="草稿中的窗口快照" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '4px 10px 0', minWidth: 0 }}>
      {cards.map(({ attachment, entry }, index) => <SnapshotCard key={attachment.id} capture={entry.capture} src={attachment.previewUrl} previewItems={previewItems} previewIndex={index} canRemove={canAcceptDrop && !pendingIds.has(attachment.id)} onRemove={() => remove(attachment.id)} />)}
    </div>}
    {Fallback && <Fallback {...ownerProps} attachments={ordinaryAttachments} sessionId={sessionId} canAcceptDrop={canAcceptDrop} onRemoveAttachment={onRemoveAttachment} />}
  </>;
}
