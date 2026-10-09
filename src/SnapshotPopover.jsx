import React, { useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { SnapshotIcon } from './SnapshotIcon.jsx';
import { defaultShortcut, shortcutLabels, validateShortcut } from './shortcuts.mjs';
import { installPopoverDismiss } from './popover-dismiss.mjs';
import { validateNativeRecordingState } from './shortcut-native-state.mjs';
import { watchNativeRecording } from './native-recording-poll.mjs';

const foreground = 'var(--dsw-alias-label-primary, CanvasText)';
const secondary = 'var(--dsw-alias-label-secondary, color-mix(in srgb, CanvasText 65%, transparent))';
const border = 'var(--dsw-alias-border-l1, color-mix(in srgb, CanvasText 12%, transparent))';
const keyStyle = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minHeight: 30, padding: '0 10px', border: `1px solid ${border}`, borderRadius: 5, background: 'transparent', color: foreground, font: '500 12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace', whiteSpace: 'nowrap' };
const errorColor = 'var(--dsw-alias-state-error-primary, light-dark(#b42318, #ff9999))';

function ShortcutKeys({ shortcut, platform, framed = true }) {
  const labels = shortcutLabels(shortcut, platform);
  return <div aria-label={labels.join(' + ')} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
    {labels.map((label, index) => <React.Fragment key={`${index}-${label}`}>
      {index > 0 && <span aria-hidden="true" style={{ color: secondary }}>+</span>}
      <kbd style={framed ? keyStyle : { ...keyStyle, minHeight: 24, padding: '0 3px', border: 0 }}>{label}</kbd>
    </React.Fragment>)}
  </div>;
}

function ActionIcon({ restart }) {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" style={{ flexShrink: 0 }}>
    {restart ? <path d="M20 10a8 8 0 1 0-1.7 7M20 4v6h-6" /> : <><circle cx="12" cy="12" r="8.5" /><path d="m8 12 2.5 2.5L16 9" /></>}
  </svg>;
}

export function SnapshotPopover({ status, pending, isWindows, onPermissions, onRestart, onClose, onShortcutChange, onRecordingChange, onRecordingState, onRecordingEnd, nativeRecording = false, checkShortcut, triggerRef, dismissRef, recordingError = '' }) {
  const panelRef = useRef();
  const recorderRef = useRef();
  const editButtonRef = useRef();
  const instructionsId = useId();
  const mounted = useRef(true);
  const operation = useRef(0);
  const recording = useRef(false);
  const recordingCallback = useRef(onRecordingChange);
  const keyHandlers = useRef();
  const nativeState = useRef(null);
  const nativeCodes = useRef([]);
  const nativeSupported = useRef(status.supportedCodes);
  const nativePoll = useRef(onRecordingState);
  const nativeEnd = useRef(onRecordingEnd);
  const [nativeToken, setNativeToken] = useState(null);
  const held = useRef(new Set());
  const peak = useRef([]);
  const dismissCallback = useRef();
  const pendingClose = useRef(null);
  const closeBlocked = useRef(false);
  const [left, setLeft] = useState(0);
  const [editing, setEditing] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [recordingReady, setRecordingReady] = useState(false);
  const [candidate, setCandidate] = useState({ version: 1, codes: [] });
  const [busy, setBusy] = useState(null);
  const [shortcutError, setShortcutError] = useState('');
  const [releaseFailed, setReleaseFailed] = useState(false);
  const [savedAwaitingResume, setSavedAwaitingResume] = useState(false);
  const platform = isWindows ? 'win32' : 'darwin';
  const currentShortcut = status.shortcut ?? defaultShortcut(platform);
  recordingCallback.current = onRecordingChange;
  nativeSupported.current = status.supportedCodes;
  nativePoll.current = onRecordingState;
  nativeEnd.current = onRecordingEnd;
  dismissCallback.current = requestClose;
  useImperativeHandle(dismissRef, () => requestClose);
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    return installPopoverDismiss(panel, () => triggerRef?.current, () => dismissCallback.current(false));
  }, [triggerRef]);
  useEffect(() => {
    if (!busy && pendingClose.current && !closeBlocked.current) {
      const { restoreFocus } = pendingClose.current;
      pendingClose.current = null;
      requestClose(restoreFocus);
    }
  }, [busy]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operation.current += 1;
      held.current.clear();
      if (recording.current) {
        recording.current = false;
        Promise.resolve(recordingCallback.current?.(false)).catch(() => {});
      }
    };
  }, []);
  useEffect(() => {
    if (!editing || !recordingError) return;
    held.current.clear();
    peak.current = [];
    setCapturing(false);
    setRecordingReady(false);
    setCandidate({ version: 1, codes: [] });
    setShortcutError(`录入连接已中断，请重新录入。${typeof recordingError === 'string' ? ` ${recordingError.slice(0, 120)}` : ''}`);
  }, [recordingError, editing]);
  useEffect(() => {
    if (!nativeRecording || !capturing || !nativeToken) return;
    const generation = operation.current;
    return watchNativeRecording(token => nativePoll.current(token), nativeToken,
      value => applyNativeState(value, nativeToken), failNativeRecording,
      { isCurrent: () => mounted.current && operation.current === generation && nativeState.current?.token === nativeToken });
  }, [nativeRecording, capturing, nativeToken]);
  useEffect(() => {
    if (!capturing) return;
    recorderRef.current?.focus();
    // Desktop command handlers and the composer can consume ordinary keys
    // before a React bubble handler sees them. Own the recording at the
    // window capture boundary, after both dispatchers have confirmed pause.
    const keyDown = event => keyHandlers.current.down(event);
    const keyUp = event => keyHandlers.current.up(event);
    const interrupt = () => {
      if (nativeRecording) {
        held.current.clear(); setCapturing(false);
        const state = nativeState.current, generation = operation.current;
        if (state?.state === 'complete') return;
        setRecordingReady(false);
        if (!state?.token) { failNativeRecording(new Error('录入已中断，请重新录入。')); return; }
        // The final release may already have completed in native while its
        // last poll is still in transit. Confirm that exact token once; a
        // waiting/interrupted recorder never continues collecting here.
        Promise.resolve().then(() => nativePoll.current(state.token)).then(value => {
          if (!mounted.current || operation.current !== generation || nativeState.current?.token !== state.token) return;
          const confirmed = validateNativeRecordingState(value, state.token, nativeCodes.current);
          if (['too_many', 'interrupted', 'expired', 'ended'].includes(confirmed.state)) { applyNativeState(confirmed, state.token); return; }
          if (confirmed.state !== 'complete') { failNativeRecording(new Error('录入已中断，请重新录入。')); return; }
          applyNativeState(confirmed, state.token); setRecordingReady(true);
        }, error => {
          if (mounted.current && operation.current === generation && nativeState.current?.token === state.token) failNativeRecording(error);
        }).catch(error => {
          if (mounted.current && operation.current === generation && nativeState.current?.token === state.token) failNativeRecording(error);
        });
        return;
      }
      held.current.clear();
      peak.current = [];
      setCapturing(false);
      setCandidate({ version: 1, codes: [] });
      if (nativeRecording) setRecordingReady(false);
      setShortcutError('录入已中断，请重新录入。');
    };
    const visibility = () => { if (document.hidden) interrupt(); };
    window.addEventListener('keydown', keyDown, true);
    window.addEventListener('keyup', keyUp, true);
    window.addEventListener('blur', interrupt);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('keydown', keyDown, true);
      window.removeEventListener('keyup', keyUp, true);
      window.removeEventListener('blur', interrupt);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [capturing]);
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
  function requestClose(restoreFocus = true) {
    held.current.clear();
    peak.current = [];
    setCapturing(false);
    closeBlocked.current = false;
    if (busy) {
      pendingClose.current = { restoreFocus };
      return;
    }
    pendingClose.current = { restoreFocus };
    if (editing) void stopEditing(true, restoreFocus);
    else {
      pendingClose.current = null;
      onClose(restoreFocus);
    }
  }
  function failNativeRecording(error) {
    const token = nativeState.current?.token, generation = operation.current;
    held.current.clear(); peak.current = []; nativeState.current = null;
    setNativeToken(null); setCapturing(false); setRecordingReady(false);
    setCandidate({ version: 1, codes: [] });
    setShortcutError(error.message || '原生录入已中断，请重新录入。');
    if (token && nativeEnd.current) Promise.resolve().then(() => nativeEnd.current(token)).catch(failure => {
      if (mounted.current && operation.current === generation && !nativeState.current) setShortcutError(`原生录入结束未确认，请重新录入或重启采集。${failure.message ? ` ${failure.message}` : ''}`);
    });
  }
  function applyNativeState(value, token) {
    const state = validateNativeRecordingState(value, token, nativeCodes.current);
    nativeState.current = state;
    if (['too_many', 'interrupted', 'expired', 'ended'].includes(state.state)) {
      failNativeRecording(new Error(state.state === 'too_many' ? '请只同时按住两个不同按键，重新录入。' : state.state === 'expired' ? '录入已超时，请重新录入。' : '录入已中断，请重新录入。'));
      return;
    }
    setCandidate({ version: 1, codes: state.peak });
    if (state.state === 'complete') {
      held.current.clear(); setCapturing(false);
      if (state.peak.length !== 2) setShortcutError('请同时按住两个不同的按键，单键不能保存。');
    }
  }
  async function beginRecording() {
    if (busy || pending) return;
    pendingClose.current = null;
    closeBlocked.current = false;
    const token = ++operation.current;
    held.current.clear();
    peak.current = [];
    nativeState.current = null; setNativeToken(null);
    setEditing(true);
    setCapturing(false);
    setRecordingReady(false);
    setCandidate({ version: 1, codes: [] });
    setShortcutError('');
    setReleaseFailed(false);
    setSavedAwaitingResume(false);
    setBusy('recording');
    recording.current = true;
    try {
      const confirmed = await onRecordingChange?.(true);
      if (mounted.current && token === operation.current) {
        if (nativeRecording) {
          if (typeof nativePoll.current !== 'function' || typeof nativeEnd.current !== 'function' || !Array.isArray(nativeSupported.current) || !nativeSupported.current.length) throw new Error('原生录入接口尚未就绪，请完整退出并重新打开 Harness。');
          nativeCodes.current = [...nativeSupported.current];
          const state = validateNativeRecordingState(confirmed, confirmed?.token, nativeCodes.current);
          nativeState.current = state; setNativeToken(state.token);
          applyNativeState(state, state.token);
          if (!nativeState.current) return;
        }
        setRecordingReady(true);
        if (!pendingClose.current && (!nativeRecording || ['waiting', 'holding'].includes(nativeState.current.state))) setCapturing(true);
      }
    } catch (error) {
      if (mounted.current && token === operation.current) {
        closeBlocked.current = true;
        setShortcutError(error.message || '无法暂停采集，请重试。');
      }
    } finally {
      if (mounted.current && token === operation.current) setBusy(null);
    }
  }
  async function stopEditing(close = false, restoreFocus = true) {
    if (busy === 'saving' || busy === 'finishing') return;
    const token = ++operation.current;
    held.current.clear();
    peak.current = [];
    nativeState.current = null; setNativeToken(null);
    setCapturing(false);
    setBusy('finishing');
    try {
      if (recording.current) await onRecordingChange?.(false);
      recording.current = false;
      if (mounted.current && token === operation.current) {
        setEditing(false);
        setRecordingReady(false);
        setShortcutError('');
        setReleaseFailed(false);
        setSavedAwaitingResume(false);
        const queuedClose = pendingClose.current;
        pendingClose.current = null;
        closeBlocked.current = false;
        if (close || queuedClose) onClose(queuedClose?.restoreFocus ?? restoreFocus);
        else queueMicrotask(() => editButtonRef.current?.focus());
      }
    } catch (error) {
      if (mounted.current && token === operation.current) {
        closeBlocked.current = true;
        setReleaseFailed(true);
        setShortcutError(`恢复快捷键监听失败，请重试。${error.message ? ` ${error.message}` : ''}`);
      }
    } finally {
      if (mounted.current && token === operation.current) setBusy(null);
    }
  }
  function inspect(shortcut) {
    const issue = validateShortcut(shortcut, { platform, supportedCodes: status.supportedCodes });
    if (issue) return { issue, conflicts: [] };
    try { return checkShortcut?.(shortcut) ?? { conflicts: [], limited: true, message: '当前无法查询 Harness 快捷键，仅检查按键格式。' }; }
    catch (error) { return { issue: error.message || '快捷键冲突检查失败。', conflicts: [] }; }
  }
  async function saveShortcut(shortcut = candidate, reset = false) {
    if (busy || pending || !recordingReady || savedAwaitingResume || recordingError) return;
    const checked = inspect(shortcut);
    if (checked.issue || checked.conflicts?.length) {
      setShortcutError(checked.issue || `与 Harness 快捷键冲突：${checked.conflicts.map(item => item.label || item.id).join('、')}`);
      return;
    }
    const token = ++operation.current;
    setCapturing(false);
    setCandidate(shortcut);
    setShortcutError('');
    closeBlocked.current = false;
    setBusy('saving');
    let saved = false;
    try {
      if (nativeRecording && !reset && nativeState.current?.state !== 'complete') throw new Error('原生录入尚未完整确认，请重新录入。');
      await onShortcutChange(shortcut, nativeRecording ? { token: nativeToken, reset } : undefined);
      saved = true;
      if (mounted.current && token === operation.current) setSavedAwaitingResume(true);
      if (recording.current) await onRecordingChange?.(false);
      recording.current = false;
      if (mounted.current && token === operation.current) {
        setEditing(false);
        setRecordingReady(false);
        setSavedAwaitingResume(false);
        setReleaseFailed(false);
        if (!pendingClose.current) queueMicrotask(() => editButtonRef.current?.focus());
      }
    } catch (error) {
      if (mounted.current && token === operation.current) {
        closeBlocked.current = true;
        setReleaseFailed(saved);
        if (nativeRecording && !saved) { nativeState.current = null; setNativeToken(null); setCandidate({ version: 1, codes: [] }); setRecordingReady(false); }
        setShortcutError(saved ? `快捷键已保存，但恢复监听失败，请重试。${error.message ? ` ${error.message}` : ''}` : error.message || '快捷键保存失败，请重试。');
      }
    } finally {
      if (mounted.current && token === operation.current) setBusy(null);
    }
  }
  function captureKeyDown(event) {
    if (!capturing) {
      if (event.code === 'Escape' || event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        requestClose();
      }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (nativeRecording) {
      // DOM events arbitrate Escape and prevent product shortcuts only. They
      // never contribute a key to the native-authoritative candidate.
      if (event.code === 'Escape' && held.current.size === 0 && !nativeState.current?.current.length && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) { void stopEditing(); return; }
      if (!event.repeat && event.code) held.current.add(event.code);
      return;
    }
    if (event.code === 'Escape' && held.current.size === 0) { void stopEditing(); return; }
    if (event.repeat || !event.code) return;
    if (held.current.size === 0) { peak.current = []; setShortcutError(''); }
    held.current.add(event.code);
    if (held.current.size > 2) {
      held.current.clear(); peak.current = [];
      setCapturing(false); setRecordingReady(false);
      setCandidate({ version: 1, codes: [] });
      setShortcutError('请只同时按住两个不同按键，重新录入。');
      return;
    }
    if (held.current.size > peak.current.length) {
      peak.current = Array.from(held.current);
      setCandidate({ version: 1, codes: peak.current });
    }
  }
  function captureKeyUp(event) {
    if (!capturing) return;
    event.preventDefault();
    event.stopPropagation();
    if (nativeRecording) { held.current.delete(event.code); return; }
    if (!held.current.delete(event.code)) return;
    // A partial release must not finish the gesture: the remaining physical
    // keys still belong to this recording. Keep the largest simultaneous set
    // until every observed key is released; never join sequential presses.
    if (held.current.size !== 0) return;
    if (peak.current.length === 2) {
      setCandidate({ version: 1, codes: peak.current });
      held.current.clear();
      setCapturing(false);
    } else {
      peak.current = [];
      setShortcutError('请同时按住两个不同的按键，单键不能保存。');
    }
  }
  keyHandlers.current = { down: captureKeyDown, up: captureKeyUp };
  const checked = inspect(editing ? candidate : currentShortcut);
  const candidateProblem = candidate.codes.length ? checked.issue : '';
  const conflictText = checked.conflicts?.length ? `与 Harness 快捷键冲突：${checked.conflicts.map(item => item.label || item.id).join('、')}` : '';
  const canSave = editing && recordingReady && !recordingError && !savedAwaitingResume && !capturing && !busy && !pending && candidate.codes.length === 2 && !checked.issue && !checked.conflicts?.length;
  const ownedElsewhere = status.owner === false;
  const ready = status.ready === true;
  const paused = editing && recordingReady || status.recording === true;
  const label = editing && recordingError ? '录入已中断' : paused ? capturing ? '录入中，采集已暂停' : '快捷键设置中，采集已暂停' : ownedElsewhere ? '另一窗口正在接收快照' : ready ? '已就绪' : status.error ? '连接异常' : status.ready === false ? '尚未就绪' : '正在连接…';
  const dot = editing && recordingError || status.error && !ready ? '#e06464' : paused || ownedElsewhere || !ready ? '#d99a25' : '#22a864';
  const message = status.message?.startsWith('快照卡片已加入草稿') ? '快照已加入草稿' : status.message;
  const buttonStyle = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, flex: 1, minHeight: 32, padding: '6px 8px', border: `1px solid ${border}`, borderRadius: 6, background: 'transparent', color: foreground, font: 'inherit', cursor: pending ? 'wait' : 'pointer', opacity: pending ? .6 : 1 };
  const textButtonStyle = { ...buttonStyle, flex: '0 1 auto', minHeight: 26, padding: 0, border: 0, borderRadius: 3, color: secondary };
  const permissionItems = [
    ['截图', status.permissions?.screenRecording],
    ['文字', status.permissions?.accessibility],
    ['快捷键', status.permissions?.inputMonitoring || status.permissions?.accessibility],
  ];
  return <div ref={panelRef} role="dialog" aria-label="窗口快照" onKeyDown={captureKeyDown} onKeyUp={captureKeyUp} style={{ position: 'absolute', bottom: 38, left, width: 340, maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 72px)', overflowY: 'auto', boxSizing: 'border-box', padding: 18, border: `1px solid ${border}`, borderRadius: 'var(--dsw-radius-lg, 12px)', background: 'var(--dsw-specific-menu, Canvas)', backdropFilter: 'var(--dsw-menu-backdrop-filter, blur(16px))', WebkitBackdropFilter: 'var(--dsw-menu-backdrop-filter, blur(16px))', color: foreground, boxShadow: 'var(--dsw-elevation-prominent, 0 8px 28px rgb(0 0 0 / .14))', zIndex: 30, fontSize: 13, lineHeight: 1.5 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18 }}>
      <SnapshotIcon /><strong style={{ fontSize: 14, fontWeight: 600 }}>窗口快照</strong>
      <button type="button" title="关闭" aria-label="关闭快照说明" onClick={() => requestClose()} style={{ display: 'grid', placeItems: 'center', marginLeft: 'auto', width: 24, height: 24, padding: 0, border: 0, borderRadius: 5, background: 'transparent', color: secondary, cursor: 'pointer' }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true" focusable="false"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
    </div>
    {!editing && <>
      <p style={{ margin: '0 0 10px' }}>切换到要引用的窗口，同时按住</p>
      <ShortcutKeys shortcut={currentShortcut} platform={platform} />
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '4px 12px', marginTop: 10 }}>
        <p style={{ margin: 0, flex: '1 1 auto', color: secondary, fontSize: 12 }}>截图与窗口文字将加入当前草稿。</p>
        <button ref={editButtonRef} type="button" disabled={!!pending || !onShortcutChange} onClick={beginRecording} style={{ ...textButtonStyle, color: foreground, opacity: pending || !onShortcutChange ? .6 : 1 }}>修改快捷键</button>
      </div>
    </>}
    {!editing && (checked.issue || conflictText) && <p role="alert" style={{ margin: '8px 0 0', fontSize: 12, color: errorColor, overflowWrap: 'anywhere' }}>{conflictText || checked.issue} 当前组合仍保留，可修改快捷键。</p>}
    {editing && <section aria-label="快捷键设置">
      <div style={{ fontWeight: 500, marginBottom: 10 }}>设置快捷键</div>
      <div ref={recorderRef} tabIndex={0} aria-label="快捷键录入" aria-describedby={instructionsId} style={{ display: 'flex', alignItems: 'center', minHeight: 48, padding: 8, border: `1px solid ${capturing ? 'var(--dsw-alias-state-primary-primary, #3973d6)' : border}`, borderRadius: 6, background: 'transparent', outlineOffset: 2 }}>
        {candidate.codes.length ? <ShortcutKeys shortcut={candidate} platform={platform} framed={false} /> : <span style={{ color: secondary }}>{busy === 'recording' ? '正在暂停采集…' : capturing ? '请同时按住两个不同键' : '尚未录入快捷键'}</span>}
      </div>
      <p id={instructionsId} style={{ margin: '8px 0', fontSize: 11, color: secondary }}>{capturing ? '只同时按住两个不同键，全部松开后完成录入。单独按 Esc 取消；Tab 也算按键。' : busy === 'saving' ? '正在保存并确认采集程序生效…' : recordingReady ? '快捷键由两个不同键组成。编辑期间已暂停快照快捷键。' : busy === 'recording' ? '确认暂停采集后，才开始录入。' : '请先重新录入，确认采集程序就绪。'}</p>
      {(shortcutError || candidateProblem || conflictText) && <p role="alert" style={{ margin: '7px 0', fontSize: 12, color: errorColor, overflowWrap: 'anywhere' }}>{shortcutError || candidateProblem || conflictText}</p>}
      {!checked.issue && !checked.conflicts?.length && candidate.codes.length === 2 && <p style={{ margin: '7px 0', color: secondary, fontSize: 11 }}>{checked.message || (checked.limited ? '此组合仅能进行部分 Harness 冲突检测。' : '未发现 Harness 已登记快捷键冲突。系统和其他应用的冲突无法全面检测。')}</p>}
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 12, marginTop: 9 }}>
        <button type="button" disabled={!!busy || !!pending || savedAwaitingResume} onClick={beginRecording} style={textButtonStyle}>重新录入</button>
        <button type="button" disabled={!!busy || !!pending || !recordingReady || !!recordingError || savedAwaitingResume} onClick={() => saveShortcut(defaultShortcut(platform), true)} style={textButtonStyle}>恢复默认</button>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button type="button" disabled={busy === 'saving' || busy === 'finishing'} onClick={() => stopEditing()} style={buttonStyle}>{busy === 'finishing' ? '恢复监听…' : releaseFailed ? '重试恢复监听' : '取消'}</button>
        <button type="button" disabled={!canSave} aria-busy={busy === 'saving'} onClick={() => saveShortcut()} style={{ ...buttonStyle, fontWeight: 500, opacity: canSave ? 1 : .5 }}>{busy === 'saving' ? '保存中…' : '保存快捷键'}</button>
      </div>
    </section>}
    <div role="status" aria-live="polite" style={{ marginTop: 18, paddingTop: 14, borderTop: `1px solid ${border}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}><span aria-hidden="true" style={{ width: 6, height: 6, flexShrink: 0, borderRadius: '50%', background: dot }} /><span style={{ fontWeight: 500 }}>{label}</span></div>
      {ownedElsewhere && <p style={{ margin: '5px 0 0', fontSize: 12, color: secondary }}>切回此会话后再捕获窗口。</p>}
      {!status.error && message && <p style={{ margin: '5px 0 0', fontSize: 12, color: secondary }}>{message}</p>}
      {!isWindows && status.permissions && <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px', marginTop: 6, color: secondary, fontSize: 11 }}>{permissionItems.map(([name, granted]) => <span key={name}>{name} · {granted ? '可用' : '待授权'}</span>)}</div>}
    </div>
    {status.settingsError && <p role="alert" style={{ margin: '10px 0 0', color: errorColor, fontSize: 12, overflowWrap: 'anywhere' }}>{typeof status.settingsError === 'string' ? status.settingsError : '快捷键配置未能恢复；当前使用默认组合，可重新保存设置。'}</p>}
    {status.error && <p role="alert" style={{ margin: '10px 0 0', color: 'var(--dsw-alias-state-error-primary, #c24141)', fontSize: 12, overflowWrap: 'anywhere' }}>{status.error}</p>}
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginTop: 12 }}>
      <button type="button" disabled={!!pending || editing} aria-busy={pending === 'permissions'} onClick={onPermissions} style={{ ...textButtonStyle, opacity: pending || editing ? .5 : 1 }}><ActionIcon />{pending === 'permissions' ? '检查中…' : isWindows ? '检查状态' : '检查权限'}</button>
      <button type="button" disabled={!!pending || editing} aria-busy={pending === 'restart'} onClick={onRestart} style={{ ...textButtonStyle, opacity: pending || editing ? .5 : 1 }}><ActionIcon restart />{pending === 'restart' ? '重启中…' : '重启采集'}</button>
    </div>
  </div>;
}
