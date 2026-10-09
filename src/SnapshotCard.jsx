import React, { useEffect, useState } from 'react';
import { cleanAppIcon } from './app-icon.mjs';
import { SnapshotPreview, snapshotQualityLabel } from './SnapshotPreview.jsx';
import { loadSnapshotAppIcon } from './snapshot-display.mjs';

// Inherit Harness' resolved palette so manual, system and custom themes all
// update mounted draft/history cards through CSS without a separate listener.
const surface = 'var(--dsw-alias-bg-module-platform, color-mix(in srgb, Canvas 96%, CanvasText))';
const foreground = 'var(--dsw-alias-label-primary, CanvasText)';
const secondary = 'var(--dsw-alias-label-secondary, CanvasText)';

/** One saved snapshot: preview is separate from its optional draft removal. */
export function SnapshotCard({ capture, src, onRemove, canRemove = true, previewItems, previewIndex = 0 }) {
  const [preview, setPreview] = useState(null);
  const title = capture.title || '窗口快照';
  const appName = capture.appName || '未知应用';
  const providedIcon = cleanAppIcon(capture.appIconPngBase64);
  const snapshotId = capture.snapshotId || capture.id;
  const [loadedIcon, setLoadedIcon] = useState(null);
  useEffect(() => {
    if (providedIcon || !snapshotId) return undefined;
    let alive = true;
    loadSnapshotAppIcon(snapshotId).then(icon => { if (alive && icon) setLoadedIcon({ snapshotId, icon }); });
    return () => { alive = false; };
  }, [snapshotId, providedIcon]);
  const icon = providedIcon || (loadedIcon && loadedIcon.snapshotId === snapshotId ? loadedIcon.icon : undefined);
  const qualityLabel = snapshotQualityLabel(capture);
  return <><div role="group" data-snapshot-style="codex" aria-label={`窗口快照：${appName}，${title}`} title={`${appName} · ${title}`} style={{ '--dsh-snapshot-surface': surface, '--dsh-snapshot-foreground': foreground, '--dsh-snapshot-secondary': secondary, position: 'relative', width: 250, maxWidth: '100%', aspectRatio: '250 / 177', flexShrink: 0, minWidth: 0, borderRadius: 10, background: 'var(--dsh-snapshot-surface)', color: 'var(--dsh-snapshot-foreground)', boxShadow: 'inset 0 0 0 1px var(--dsw-alias-border-l1, color-mix(in srgb, CanvasText 6%, transparent))', overflow: 'hidden', isolation: 'isolate' }}>
    <button type="button" aria-label={`预览快照：${appName}，${title}`} onClick={() => setPreview({ items: previewItems?.length ? previewItems : [{ capture, src }], index: previewIndex, src })} style={{ position: 'absolute', inset: 0, zIndex: 1, padding: 0, border: 0, borderRadius: 'inherit', background: 'transparent', cursor: 'pointer' }} />
    <div aria-hidden="true" style={{ position: 'absolute', top: '13%', left: '9.6%', width: '76.4%', height: '61%', overflow: 'hidden', borderRadius: '2px 2px 0 0' }}>
      {src ? <img src={src} alt="" draggable={false} style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'top center' }} /> : <span style={{ display: 'grid', placeItems: 'center', width: '100%', height: '100%', background: 'color-mix(in srgb, var(--dsh-snapshot-surface) 88%, var(--dsh-snapshot-foreground))', color: 'var(--dsh-snapshot-secondary)', opacity: .5 }}><svg width="36" height="36" viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" /><path d="M3 8h18" stroke="currentColor" /></svg></span>}
      <span style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, color-mix(in srgb, var(--dsh-snapshot-surface) 0%, transparent) 10%, color-mix(in srgb, var(--dsh-snapshot-surface) 18%, transparent) 40%, var(--dsh-snapshot-surface) 100%)' }} />
    </div>
    <span aria-hidden="true" style={{ position: 'absolute', top: '61.3%', left: '50%', transform: 'translateX(-50%)', display: 'grid', placeItems: 'center', width: 26, height: 26 }}>
      {icon ? <img src={`data:image/png;base64,${icon}`} alt="" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'contain' }} /> : <svg width="20" height="20" viewBox="0 0 24 24" fill="none" style={{ color: 'var(--dsh-snapshot-secondary)' }}><rect x="2.5" y="3.5" width="19" height="17" rx="4" fill="var(--dsh-snapshot-surface)" stroke="currentColor" /><path d="M3 8h18" stroke="currentColor" /><circle cx="6" cy="5.8" r=".7" fill="currentColor" /><circle cx="8.5" cy="5.8" r=".7" fill="currentColor" /></svg>}
    </span>
    <span style={{ position: 'absolute', top: '83%', left: '6%', width: '88%', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'center', fontSize: 14, lineHeight: 1.4, fontWeight: 500 }}>{title}</span>
    {qualityLabel && <span data-snapshot-quality={capture.captureQuality?.status || 'image_only'} style={{ position: 'absolute', zIndex: 2, top: 7, left: 9, fontSize: 11, lineHeight: 1.5, color: 'var(--dsh-snapshot-secondary)', pointerEvents: 'none' }}>{qualityLabel}</span>}
    {onRemove && <button type="button" disabled={!canRemove} title="移除整张快照" aria-label={`移除快照：${title}`} onClick={onRemove} style={{ position: 'absolute', zIndex: 2, top: 6, right: 6, display: 'grid', placeItems: 'center', width: 22, height: 22, padding: 0, border: 0, borderRadius: '50%', background: 'var(--dsw-alias-button-floating-fill, var(--dsh-snapshot-surface))', color: 'var(--dsh-snapshot-foreground)', boxShadow: '0 0 0 1px var(--dsw-alias-border-l1, color-mix(in srgb, CanvasText 6%, transparent))', cursor: canRemove ? 'pointer' : 'default', opacity: canRemove ? 1 : .35 }}><svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg></button>}
  </div>{preview && <SnapshotPreview items={preview.items} initialIndex={preview.index} initialSrc={preview.src} onClose={() => setPreview(null)} />}</>;
}
