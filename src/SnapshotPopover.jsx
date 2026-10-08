import React, { useLayoutEffect, useRef, useState } from 'react';
import { SnapshotIcon } from './SnapshotIcon.jsx';

const foreground = 'var(--dsw-alias-label-primary, CanvasText)';
const secondary = 'var(--dsw-alias-label-secondary, color-mix(in srgb, CanvasText 65%, transparent))';
const border = 'var(--dsw-alias-border-l1, color-mix(in srgb, CanvasText 12%, transparent))';
const subtle = 'var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, CanvasText 4%, Canvas))';
const keyStyle = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minHeight: 30, padding: '0 10px', border: `1px solid ${border}`, borderBottomWidth: 2, borderRadius: 6, background: subtle, color: foreground, font: '500 12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace', whiteSpace: 'nowrap' };

function ActionIcon({ restart }) {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" style={{ flexShrink: 0 }}>
    {restart ? <path d="M20 10a8 8 0 1 0-1.7 7M20 4v6h-6" /> : <><circle cx="12" cy="12" r="8.5" /><path d="m8 12 2.5 2.5L16 9" /></>}
  </svg>;
}

export function SnapshotPopover({ status, pending, isWindows, onPermissions, onRestart, onClose }) {
  const panelRef = useRef();
  const [left, setLeft] = useState(0);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const fit = () => {
      const anchor = panel.parentElement.getBoundingClientRect();
      const width = panel.getBoundingClientRect().width;
      const viewport = document.documentElement.clientWidth;
      setLeft(Math.max(16, Math.min(anchor.left, viewport - width - 16)) - anchor.left);
    };
    fit();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
    observer?.observe(panel);
    // Sidebar and split-pane changes can move the anchor without resizing the popup.
    for (let ancestor = panel.parentElement; ancestor; ancestor = ancestor.parentElement) observer?.observe(ancestor);
    window.addEventListener('resize', fit);
    return () => { observer?.disconnect(); window.removeEventListener('resize', fit); };
  }, []);
  const ownedElsewhere = status.owner === false;
  const ready = status.ready === true;
  const label = ownedElsewhere ? '另一窗口正在接收快照' : ready ? '已就绪' : status.error ? '连接异常' : status.ready === false ? '尚未就绪' : '正在连接…';
  const dot = status.error && !ready ? '#e06464' : ownedElsewhere || !ready ? '#d99a25' : '#22a864';
  const message = status.message?.startsWith('快照卡片已加入草稿') ? '快照已加入草稿' : status.message;
  const buttonStyle = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, flex: 1, minHeight: 32, padding: '6px 8px', border: `1px solid ${border}`, borderRadius: 8, background: 'var(--dsw-alias-button-floating-fill, Canvas)', color: foreground, font: 'inherit', cursor: pending ? 'wait' : 'pointer', opacity: pending ? .6 : 1 };
  const permissionItems = [
    ['截图', status.permissions?.screenRecording],
    ['文字', status.permissions?.accessibility],
    ['快捷键', status.permissions?.inputMonitoring || status.permissions?.accessibility],
  ];
  return <div ref={panelRef} role="dialog" aria-label="窗口快照" style={{ position: 'absolute', bottom: 38, left, width: 320, maxWidth: 'calc(100vw - 32px)', boxSizing: 'border-box', padding: 16, border: `1px solid ${border}`, borderRadius: 'var(--dsw-radius-lg, 12px)', background: 'var(--dsw-specific-menu, Canvas)', backdropFilter: 'var(--dsw-menu-backdrop-filter, blur(16px))', WebkitBackdropFilter: 'var(--dsw-menu-backdrop-filter, blur(16px))', color: foreground, boxShadow: 'var(--dsw-elevation-prominent, 0 8px 28px rgb(0 0 0 / .14))', zIndex: 30, fontSize: 13, lineHeight: 1.5 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
      <SnapshotIcon /><strong style={{ fontSize: 14, fontWeight: 600 }}>窗口快照</strong>
      <button type="button" title="关闭" aria-label="关闭快照说明" onClick={onClose} style={{ display: 'grid', placeItems: 'center', marginLeft: 'auto', width: 24, height: 24, padding: 0, border: 0, borderRadius: 5, background: 'transparent', color: secondary, cursor: 'pointer' }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true" focusable="false"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
    </div>
    <p style={{ margin: '0 0 9px' }}>切换到要引用的窗口，同时按住</p>
    <div aria-label={isWindows ? '左 Ctrl 加右 Ctrl' : '左 Command 加右 Command'} style={{ display: 'flex', alignItems: 'center', gap: 8 }}><kbd style={keyStyle}>{isWindows ? 'left Ctrl' : 'left Command'}</kbd><span aria-hidden="true" style={{ color: secondary }}>+</span><kbd style={keyStyle}>{isWindows ? 'right Ctrl' : 'right Command'}</kbd></div>
    <p style={{ margin: '10px 0 14px', color: secondary, fontSize: 12 }}>截图与窗口文字将加入当前草稿。</p>
    <div role="status" aria-live="polite" style={{ padding: '10px 12px', borderRadius: 8, background: subtle }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}><span aria-hidden="true" style={{ width: 6, height: 6, flexShrink: 0, borderRadius: '50%', background: dot }} /><span style={{ fontWeight: 500 }}>{label}</span></div>
      {ownedElsewhere && <p style={{ margin: '5px 0 0', fontSize: 12, color: secondary }}>切回此会话后再捕获窗口。</p>}
      {!status.error && message && <p style={{ margin: '5px 0 0', fontSize: 12, color: secondary }}>{message}</p>}
      {!isWindows && status.permissions && <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px', marginTop: 7, color: secondary, fontSize: 11 }}>{permissionItems.map(([name, granted]) => <span key={name}>{name} · {granted ? '可用' : '待授权'}</span>)}</div>}
    </div>
    {status.error && <p role="alert" style={{ margin: '10px 0 0', color: 'var(--dsw-alias-state-error-primary, #c24141)', fontSize: 12, overflowWrap: 'anywhere' }}>{status.error}</p>}
    <div style={{ display: 'flex', gap: 8, marginTop: 14, paddingTop: 12, borderTop: `1px solid ${border}` }}>
      <button type="button" disabled={!!pending} aria-busy={pending === 'permissions'} onClick={onPermissions} style={buttonStyle}><ActionIcon />{pending === 'permissions' ? '检查中…' : isWindows ? '检查状态' : '检查权限'}</button>
      <button type="button" disabled={!!pending} aria-busy={pending === 'restart'} onClick={onRestart} style={buttonStyle}><ActionIcon restart />{pending === 'restart' ? '重启中…' : '重启采集'}</button>
    </div>
  </div>;
}
