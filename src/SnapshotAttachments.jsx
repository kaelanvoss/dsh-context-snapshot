import React, { useCallback, useSyncExternalStore } from 'react';
import { SnapshotCard } from './SnapshotCard.jsx';

/** Attachment ownership stays with Harness; previews read the saved capture. */
export function SnapshotAttachments({ snapshots, Fallback, attachments, sessionId, canAcceptDrop, onRemoveAttachment, ...ownerProps }) {
  const subscribe = useCallback(listener => snapshots.subscribe(listener), [snapshots]);
  const getVersion = useCallback(() => snapshots.getVersion(), [snapshots]);
  useSyncExternalStore(subscribe, getVersion, getVersion);
  const cards = [], ordinaryAttachments = [];
  for (const attachment of attachments) {
    const entry = snapshots.get(attachment.id);
    if (attachment.kind === 'image' && entry && entry.sessionId === sessionId) cards.push({ attachment, entry });
    else ordinaryAttachments.push(attachment);
  }
  const previewItems = cards.map(({ attachment, entry }) => ({ capture: entry.capture, src: attachment.previewUrl }));
  return <>
    {cards.length > 0 && <div role="group" aria-label="草稿中的窗口快照" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '4px 10px 0', minWidth: 0 }}>
      {cards.map(({ attachment, entry }, index) => <SnapshotCard key={attachment.id} capture={entry.capture} src={attachment.previewUrl} previewItems={previewItems} previewIndex={index} canRemove={canAcceptDrop} onRemove={() => onRemoveAttachment(attachment.id)} />)}
    </div>}
    {Fallback && <Fallback {...ownerProps} attachments={ordinaryAttachments} sessionId={sessionId} canAcceptDrop={canAcceptDrop} onRemoveAttachment={onRemoveAttachment} />}
  </>;
}
