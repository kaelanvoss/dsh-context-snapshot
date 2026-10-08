import React, { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

const localStyles = `
.dsh-context-snapshot-card:focus-within { outline: 2px solid currentColor; outline-offset: 2px; }
.dsh-context-snapshot-preview-button:hover { background: color-mix(in srgb, currentColor 5%, transparent); }
.dsh-context-snapshot-icon-button:hover:not(:disabled) { background: color-mix(in srgb, currentColor 10%, transparent); }
.dsh-context-snapshot-icon-button:focus-visible, .dsh-context-snapshot-preview-button:focus-visible, .dsh-context-snapshot-text-summary:focus-visible { outline: 2px solid currentColor; outline-offset: -3px; }
.dsh-context-snapshot-icon-button:disabled { opacity: .35; cursor: default; }
@media (max-width: 520px) { .dsh-context-snapshot-card { width: 100% !important; } }
`;

const iconButtonStyle = { display: 'grid', placeItems: 'center', flexShrink: 0, width: 28, height: 28, padding: 0, border: 0, borderRadius: 7, background: 'transparent', color: 'inherit', cursor: 'pointer' };

function WindowIcon({ size = 14 }) {
  return <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="2.5" y="3.5" width="15" height="13" rx="2.5" stroke="currentColor" strokeWidth="1.4" /><path d="M3 7.5h14" stroke="currentColor" strokeWidth="1.4" /><path d="M5 5.5h.01m2 0h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>;
}

function CloseIcon() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>;
}

function readableTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value || '未知时间' : date.toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function SnapshotPreview({ entry, attachment, onClose, restoreTarget }) {
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  const titleId = useId();
  const sourceId = useId();
  const { capture } = entry;
  const src = attachment.previewUrl || `data:image/png;base64,${capture.pngBase64}`;

  useEffect(() => {
    const previousFocus = document.activeElement;
    closeRef.current?.focus();
    return () => {
      const target = previousFocus?.isConnected ? previousFocus : restoreTarget.current;
      target?.focus?.({ preventScroll: true });
    };
  }, [restoreTarget]);

  function handleKeyDown(event) {
    // A portal still bubbles through its React parent: keep preview keystrokes
    // inside the dialog instead of reaching the composer's keyboard handlers.
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'Tab') {
      const focusable = [...dialogRef.current.querySelectorAll('button:not(:disabled), a[href], summary, [tabindex="0"]')].filter(element => element.getClientRects().length);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }

  return createPortal(<div onKeyDown={handleKeyDown} onClick={event => { if (event.target === event.currentTarget) onClose(); }} style={{ position: 'fixed', inset: 0, zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, background: 'rgb(0 0 0 / .55)', color: 'CanvasText' }}>
    <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={sourceId} style={{ display: 'flex', flexDirection: 'column', width: 'min(1100px, 100%)', maxHeight: 'calc(100dvh - 40px)', minHeight: 0, border: '1px solid color-mix(in srgb, CanvasText 18%, Canvas)', borderRadius: 16, background: 'Canvas', boxShadow: '0 20px 70px rgb(0 0 0 / .3)', overflow: 'hidden' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 18px', borderBottom: '1px solid color-mix(in srgb, currentColor 13%, transparent)' }}>
        <WindowIcon size={20} />
        <div style={{ flex: 1, minWidth: 0 }}><h2 id={titleId} style={{ margin: 0, fontSize: 15, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{capture.title || '窗口快照'}</h2><p id={sourceId} style={{ margin: '4px 0 0', fontSize: 12, opacity: .62 }}>{capture.appName || '未知应用'} · {readableTime(capture.capturedAt)}</p></div>
        <button ref={closeRef} type="button" className="dsh-context-snapshot-icon-button" style={iconButtonStyle} aria-label="关闭快照预览" title="关闭（Esc）" onClick={onClose}><CloseIcon /></button>
      </header>
      <div style={{ overflow: 'auto', minHeight: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 18, background: 'color-mix(in srgb, CanvasText 4%, Canvas)' }}><img src={src} alt={`${capture.appName || '应用'}：${capture.title || '窗口快照'}`} style={{ display: 'block', maxWidth: '100%', maxHeight: '62dvh', width: 'auto', height: 'auto', borderRadius: 6, boxShadow: '0 2px 12px rgb(0 0 0 / .1)' }} /></div>
        <div style={{ padding: '14px 18px 18px', fontSize: 13, lineHeight: 1.6 }}>
          {capture.url && <p style={{ margin: '0 0 10px', overflowWrap: 'anywhere' }}><span style={{ opacity: .6 }}>页面地址：</span>{capture.url}</p>}
          <details key={entry.id} style={{ border: '1px solid color-mix(in srgb, currentColor 14%, transparent)', borderRadius: 9, overflow: 'hidden' }}>
            <summary className="dsh-context-snapshot-text-summary" style={{ padding: '9px 12px', cursor: 'pointer', userSelect: 'none' }}>可访问文本<span style={{ marginLeft: 8, fontSize: 12, opacity: .55 }}>{capture.text ? `${capture.text.length.toLocaleString()} 字符` : '此窗口未提供文本'}</span></summary>
            <pre style={{ margin: 0, padding: '10px 12px 12px', maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: 'inherit', borderTop: '1px solid color-mix(in srgb, currentColor 10%, transparent)', background: 'color-mix(in srgb, CanvasText 3%, Canvas)' }}>{capture.text || '此窗口未提供可访问文本，请查看图片。'}</pre>
          </details>
          <p style={{ margin: '10px 0 0', fontSize: 12, opacity: .55 }}>图片、来源信息和可访问文本会随这张快照一起发送。</p>
        </div>
      </div>
    </section>
  </div>, document.body);
}

/** A presentation slot: attachment ownership and release stay with Harness. */
export function SnapshotAttachments({ snapshots, Fallback, attachments, sessionId, canAcceptDrop, onRemoveAttachment, ...ownerProps }) {
  const subscribe = useCallback(listener => snapshots.subscribe(listener), [snapshots]);
  const getVersion = useCallback(() => snapshots.getVersion(), [snapshots]);
  const version = useSyncExternalStore(subscribe, getVersion, getVersion);
  const [previewId, setPreviewId] = useState(null);
  const containerRef = useRef(null);
  const cards = [];
  const ordinaryAttachments = [];
  for (const attachment of attachments) {
    const entry = snapshots.get(attachment.id);
    if (attachment.kind === 'image' && entry && entry.sessionId === sessionId) cards.push({ attachment, entry });
    else ordinaryAttachments.push(attachment);
  }
  const preview = cards.find(({ attachment }) => attachment.id === previewId);
  useEffect(() => { if (previewId !== null && !preview) setPreviewId(null); }, [attachments, previewId, preview, version]);
  const closePreview = useCallback(() => setPreviewId(null), []);

  return <>
    <style>{localStyles}</style>
    {cards.length > 0 && <div ref={containerRef} tabIndex={-1} role="group" aria-label="草稿中的窗口快照" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '4px 10px 0', minWidth: 0, outline: 'none' }}>
      {cards.map(({ attachment, entry }) => {
        const { capture } = entry;
        const title = capture.title || '窗口快照';
        return <div key={attachment.id} className="dsh-context-snapshot-card" style={{ display: 'flex', alignItems: 'center', gap: 0, width: 294, maxWidth: '100%', minWidth: 0, border: '1px solid color-mix(in srgb, currentColor 15%, transparent)', borderRadius: 11, background: 'color-mix(in srgb, CanvasText 3%, Canvas)', color: 'CanvasText', overflow: 'hidden' }}>
          <button type="button" className="dsh-context-snapshot-preview-button" onClick={() => setPreviewId(attachment.id)} aria-label={`预览快照：${capture.appName || '应用'}，${title}`} title={`预览快照：${title}`} style={{ display: 'flex', alignItems: 'center', gap: 11, flex: 1, minWidth: 0, padding: 9, border: 0, borderRadius: 0, background: 'transparent', color: 'inherit', textAlign: 'left', cursor: 'zoom-in' }}>
            <img src={attachment.previewUrl || `data:image/png;base64,${capture.pngBase64}`} alt="" style={{ display: 'block', width: 58, height: 44, flexShrink: 0, objectFit: 'cover', objectPosition: 'top left', border: '1px solid color-mix(in srgb, currentColor 10%, transparent)', borderRadius: 5, background: 'Canvas' }} />
            <span style={{ display: 'block', flex: 1, minWidth: 0 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 3, fontSize: 11, lineHeight: 1.3, opacity: .65 }}><WindowIcon size={12} /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{capture.appName || '未知应用'}</span><span style={{ flexShrink: 0, marginLeft: 'auto', fontSize: 10, padding: '1px 4px', borderRadius: 4, background: 'color-mix(in srgb, currentColor 7%, transparent)' }}>快照</span></span>
              <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, lineHeight: 1.5, fontWeight: 500 }}>{title}</span>
            </span>
          </button>
          <button type="button" className="dsh-context-snapshot-icon-button" style={{ ...iconButtonStyle, marginRight: 5 }} disabled={!canAcceptDrop} title="移除整张快照" aria-label={`移除快照：${title}`} onClick={() => onRemoveAttachment(attachment.id)}><CloseIcon /></button>
        </div>;
      })}
    </div>}
    {Fallback && <Fallback {...ownerProps} attachments={ordinaryAttachments} sessionId={sessionId} canAcceptDrop={canAcceptDrop} onRemoveAttachment={onRemoveAttachment} />}
    {preview && <SnapshotPreview key={preview.attachment.id} {...preview} onClose={closePreview} restoreTarget={containerRef} />}
  </>;
}
