import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const foreground = 'var(--dsw-alias-label-primary, CanvasText)';
const surface = 'var(--dsw-alias-bg-module-platform, Canvas)';
const control = { display: 'grid', placeItems: 'center', minWidth: 36, height: 36, padding: '0 12px', border: 0, borderRadius: 24, background: surface, color: foreground, cursor: 'pointer', font: 'inherit', fontSize: 13 };
const EMPTY_TEXT = '此窗口未提供可访问文本；请查看图片。';

/** Saved accessibility data only: opening a preview never captures the window again. */
export function snapshotPreviewText(capture) {
  const text = typeof capture.text === 'string' ? capture.text.trim() : '';
  if (!text || text === EMPTY_TEXT) return '';
  return `Window: ${JSON.stringify(capture.title || '窗口快照')}, App: ${capture.appName || '未知应用'}\nCaptured: ${capture.capturedAt || '未知时间'}\n\n${text}`;
}

function downloadName(capture, src, mediaType) {
  const extension = ({ 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/png': 'png' })[mediaType || /^data:([^;,]+)/.exec(src)?.[1]];
  const name = capture.filename || `window-snapshot-${(capture.capturedAt || 'image').replace(/[^0-9TZ]/g, '-')}.png`;
  return extension ? name.replace(/\.(png|jpe?g|webp|gif)$/i, `.${extension}`) : name;
}

export function SnapshotPreview({ items, initialIndex = 0, initialSrc, onClose }) {
  const [index, setIndex] = useState(initialIndex);
  const [textView, setTextView] = useState(false);
  const [loaded, setLoaded] = useState(null);
  const [failed, setFailed] = useState(false);
  const [size, setSize] = useState(null);
  const [viewport, setViewport] = useState({ width: 1, height: 1 });
  const [zoom, setZoom] = useState(null);
  const root = useRef(null), stage = useRef(null), closeButton = useRef(null), drag = useRef(null);
  const item = items[index], capture = item.capture;
  const immediateSrc = item.src || (index === initialIndex ? initialSrc : null);
  const src = immediateSrc || (loaded?.item === item ? loaded.src : null);
  const text = snapshotPreviewText(capture);
  const fit = size ? Math.min(1, viewport.width / size.width, viewport.height / size.height) : 1;
  const scale = zoom ?? fit;
  const navigate = delta => {
    setIndex(current => Math.max(0, Math.min(items.length - 1, current + delta)));
    setTextView(false); setZoom(null); setSize(null); setFailed(false);
  };

  useEffect(() => {
    if (immediateSrc || !item.loadSrc) return undefined;
    let alive = true;
    Promise.resolve().then(item.loadSrc).then(value => {
      if (!alive) return;
      if (value) setLoaded({ item, src: value });
      else setFailed(true);
    }, () => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [item, immediateSrc]);

  useEffect(() => {
    if (textView || !stage.current) return undefined;
    const element = stage.current;
    const measure = () => setViewport({ width: Math.max(1, element.clientWidth - 32), height: Math.max(1, element.clientHeight - 32) });
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [textView]);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const previous = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButton.current?.focus();
    return () => {
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus?.();
    };
  }, []);

  useEffect(() => { closeButton.current?.focus(); }, [index]);

  useEffect(() => {
    if (textView || !stage.current) return undefined;
    const element = stage.current;
    const wheel = event => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      setZoom(current => Math.max(.1, Math.min(5, (current ?? fit) * (event.deltaY < 0 ? 1.1 : 1 / 1.1))));
    };
    // React delegates wheel as passive; use a scoped listener so browser zoom
    // does not compete with the saved-image zoom or produce console warnings.
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [fit, textView]);

  const adjustZoom = factor => setZoom(current => Math.max(.1, Math.min(5, (current ?? fit) * factor)));
  const onKeyDown = event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
    if (event.key === 'ArrowLeft' && !textView && index > 0) { event.preventDefault(); navigate(-1); }
    if (event.key === 'ArrowRight' && !textView && index < items.length - 1) { event.preventDefault(); navigate(1); }
    if (event.key === 'Tab') {
      const buttons = [...root.current.querySelectorAll('button:not(:disabled), a[href], [tabindex="0"]')];
      const position = buttons.indexOf(document.activeElement);
      if (event.shiftKey && position <= 0) { event.preventDefault(); buttons.at(-1)?.focus(); }
      else if (!event.shiftKey && (position < 0 || position === buttons.length - 1)) { event.preventDefault(); buttons[0]?.focus(); }
    }
  };
  const dialog = <div ref={root} role="dialog" tabIndex={-1} aria-modal="true" aria-label={`快照预览：${capture.title || '窗口快照'}`} data-snapshot-preview onKeyDown={onKeyDown} onClick={event => { if (event.target === event.currentTarget) onClose(); }} style={{ position: 'fixed', inset: 0, zIndex: 2147483000, display: 'flex', flexDirection: 'column', background: 'rgb(0 0 0 / .86)', color: foreground, fontFamily: 'inherit' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', flexShrink: 0 }}>
      <span style={{ color: '#fff', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, opacity: .8 }}>{capture.title || '窗口快照'} · {capture.appName || '未知应用'}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto', flexShrink: 0 }}>
        {text && <button type="button" aria-pressed={textView} onClick={() => setTextView(current => !current)} style={{ ...control, ...(textView ? { background: 'var(--dsw-alias-brand-primary-new-colorprimary-new-color, #3977ee)', color: '#fff' } : {}) }}>查看文本</button>}
        {src && !failed && <a aria-label="下载快照图片" title="下载快照图片" href={src} download={downloadName(capture, src, item.mediaType)} style={{ ...control, padding: 0, width: 36, textDecoration: 'none' }}><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M12 3v12m-4-4 4 4 4-4M5 15v5h14v-5" /></svg></a>}
        <button ref={closeButton} type="button" aria-label="关闭快照预览" title="关闭快照预览" onClick={onClose} style={{ ...control, padding: 0, width: 36 }}><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
      </div>
    </div>
    {textView ? <div onClick={event => { if (event.target === event.currentTarget) onClose(); }} style={{ display: 'grid', placeItems: 'center', flex: 1, minHeight: 0, padding: '16px clamp(12px, 4vw, 56px) 64px' }}>
      <section aria-label="快照可访问性文本" style={{ display: 'flex', flexDirection: 'column', width: 'min(78vw, 896px)', maxWidth: '100%', height: 'min(72vh, 704px)', maxHeight: '100%', borderRadius: 16, overflow: 'hidden', background: surface, color: foreground, border: '1px solid var(--dsw-alias-border-l1, color-mix(in srgb, CanvasText 15%, transparent))' }}>
        <div style={{ padding: '14px 20px', flexShrink: 0, color: 'var(--dsw-alias-label-secondary, CanvasText)', borderBottom: '1px solid var(--dsw-alias-border-l1, color-mix(in srgb, CanvasText 12%, transparent))', fontSize: 13 }}>纯文本</div>
        <pre tabIndex={0} style={{ margin: 0, padding: '18px 20px', overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: '13px/1.65 ui-monospace, SFMono-Regular, Consolas, monospace' }}>{text}</pre>
      </section>
    </div> : <>
      <div ref={stage} onClick={event => { if (event.target === event.currentTarget) onClose(); }} onPointerDown={event => { if (!src || !stage.current || (event.pointerType === 'mouse' && event.button !== 0)) return; if (event.target.tagName !== 'IMG') return; drag.current = { x: event.clientX, y: event.clientY, left: stage.current.scrollLeft, top: stage.current.scrollTop }; root.current?.focus({ preventScroll: true }); event.target.setPointerCapture?.(event.pointerId); }} onPointerMove={event => { if (!drag.current) return; stage.current.scrollLeft = drag.current.left - (event.clientX - drag.current.x); stage.current.scrollTop = drag.current.top - (event.clientY - drag.current.y); }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 16, touchAction: 'pan-x pan-y' }}>
        {src && !failed ? <div onClick={event => { if (event.target === event.currentTarget) onClose(); }} style={{ display: 'flex', minWidth: '100%', minHeight: '100%', width: size ? Math.max(size.width * scale, viewport.width) : '100%', alignItems: 'center', justifyContent: 'center' }}><img src={src} alt={`${capture.appName || '未知应用'}：${capture.title || '窗口快照'}`} draggable={false} onLoad={event => { const image = event.currentTarget; if (image.naturalWidth && image.naturalHeight) setSize({ width: image.naturalWidth, height: image.naturalHeight }); }} onError={() => setFailed(true)} style={{ display: 'block', borderRadius: 8, width: size ? size.width * scale : 'auto', height: size ? size.height * scale : 'auto', maxWidth: size ? 'none' : '100%', maxHeight: size ? 'none' : '100%', flexShrink: 0, cursor: size && scale > fit ? 'grab' : 'default' }} /></div> : <p role="status" style={{ color: '#fff', textAlign: 'center', paddingTop: '25vh' }}>{failed || (!src && !item.loadSrc) ? '快照图片无法加载；已有文字仍可查看。' : '正在加载快照图片…'}</p>}
      </div>
      {src && !failed && <div role="group" aria-label="图片缩放" style={{ display: 'flex', justifyContent: 'center', gap: 4, padding: '12px 16px 18px', flexShrink: 0 }}><button type="button" aria-label="缩小图片" onClick={() => adjustZoom(1 / 1.2)} style={control}>−</button><button type="button" aria-label="适应窗口" title="适应窗口" onClick={() => setZoom(null)} style={control}>{Math.round(scale * 100)}%</button><button type="button" aria-label="放大图片" onClick={() => adjustZoom(1.2)} style={control}>＋</button></div>}
    </>}
    {items.length > 1 && <>
      {index > 0 && <button type="button" aria-label="上一张快照" onClick={() => navigate(-1)} style={{ ...control, position: 'absolute', left: 14, top: '50%', padding: 0, width: 36 }}>←</button>}
      {index < items.length - 1 && <button type="button" aria-label="下一张快照" onClick={() => navigate(1)} style={{ ...control, position: 'absolute', right: 14, top: '50%', padding: 0, width: 36 }}>→</button>}
    </>}
  </div>;
  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}
