import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createController, request } from './controller.mjs';
import { createSnapshotStore } from './snapshot-store.mjs';
import { installSnapshotSubmission } from './submission.mjs';
import { SnapshotAttachments } from './SnapshotAttachments.jsx';
import { discardSnapshotDrafts } from './draft.mjs';
import { installSnapshotPresentation } from './presentation.jsx';
import { SnapshotIcon } from './SnapshotIcon.jsx';
import { SnapshotPopover } from './SnapshotPopover.jsx';
import { defaultShortcut, normalizeShortcut, shortcutLabels, inspectHarnessConflicts } from './shortcuts.mjs';
import { createShortcutRecording } from './shortcut-recording.mjs';
import { setShortcutRecording } from './shortcut-backend.mjs';
import { createDraftPersistence, hasSentSnapshot } from './draft-recovery.mjs';

export const inject = ['slots', 'conversation', 'sessions', 'shortcuts'];

function SnapshotControl({ ctx, controller, recorder, sessionId, inputActions, useInput }) {
  const phase = useInput(state => state.phase);
  const [status, setStatus] = useState({});
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(null);
  const recordingError = useSyncExternalStore(recorder.subscribe, recorder.getError, recorder.getError);
  const targetRef = useRef();
  const controlRef = useRef();
  const popoverCloseRef = useRef();
  const recorderOwner = useRef(Symbol('snapshot-shortcut-editor'));
  const [, refreshShortcuts] = useState(0);
  useEffect(() => {
    const refresh = () => refreshShortcuts(value => value + 1);
    const off = [ctx.shortcuts.catalog, ctx.shortcuts.fixedCatalog, ctx.shortcuts.config].map(store => store.subscribe(refresh));
    return () => { for (const stop of off) stop(); };
  }, [ctx.shortcuts]);
  useEffect(() => () => { void recorder.update(recorderOwner.current, false).catch(() => {}); }, [recorder]);
  useEffect(() => {
    const target = { sessionId, inputActions, phase, alive: true,
      isEligible: () => (ctx.sessions.list.getSnapshot().byId[sessionId]?.retainedBy.mainView ?? 0) > 0,
      hasSentSnapshot: (snapshotId, capturedAt) => hasSentSnapshot(ctx.sessions, sessionId, snapshotId, capturedAt),
      onStatus: value => setStatus(previous => ({ ...previous, ...value })) };
    targetRef.current = target;
    return controller.register(target);
  }, [sessionId, inputActions, controller]);
  if (targetRef.current) targetRef.current.phase = phase;
  const isWindows = /Win/.test(navigator.platform);
  const platform = isWindows ? 'win32' : 'darwin';
  const shortcut = shortcutLabels(status.shortcut ?? defaultShortcut(platform), platform).join(' + ');
  function close(restoreFocus = true) { setOpen(false); if (restoreFocus) controlRef.current?.focus(); }
  async function permissions() {
    setPending('permissions');
    try { const data = await request({ op: 'requestPermissions' }); setStatus({ ...data.status, permissions: data.permissions }); }
    catch (e) { setStatus({ error: e.message }); }
    finally { setPending(null); }
  }
  async function restart() {
    setPending('restart');
    try { setStatus((await request({ op: 'restart' })).status); }
    catch (e) { setStatus({ error: e.message }); }
    finally { setPending(null); }
  }
  function checkShortcut(value) { return inspectHarnessConflicts(value, ctx.shortcuts, platform); }
  async function changeShortcut(value, nativeRecording) {
    const normalized = normalizeShortcut(value, { platform, supportedCodes: status.supportedCodes });
    const check = checkShortcut(normalized);
    if (check.issue) throw new Error(check.issue);
    if (check.conflicts.length) throw new Error(`与 Harness 快捷键冲突：${check.conflicts.map(x => x.label).join('、')}`);
    const data = await request({ op: 'setShortcut', shortcut: normalized, revision: status.shortcutRevision,
      recorderId: recorder.id, ...(nativeRecording?.reset ? { reset: true } : { token: nativeRecording?.token }) });
    setStatus(data.status);
  }
  async function recording(active) {
    return setShortcutRecording(recorder, recorderOwner.current, active, request,
      value => setStatus(previous => ({ ...previous, ...value })));
  }
  return <span onKeyDown={event => {
    if (open && event.key === 'Escape' && !event.defaultPrevented) {
      event.preventDefault();
      event.stopPropagation();
      popoverCloseRef.current?.(true);
    }
  }} style={{ position: 'relative', display: 'inline-flex' }}>
    <button ref={controlRef} type="button" title={`同时按下${shortcut}，将前台窗口加入草稿`} aria-haspopup="dialog" aria-expanded={open} onClick={() => open ? popoverCloseRef.current?.(true) : setOpen(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: 'none', background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer', padding: '4px 8px' }}><SnapshotIcon /><span>快照</span></button>
    {open && <SnapshotPopover triggerRef={controlRef} dismissRef={popoverCloseRef} status={status} pending={pending} isWindows={isWindows} recordingError={recordingError} nativeRecording onRecordingState={token => recorder.read(recorderOwner.current, token)} onRecordingEnd={token => recorder.end(recorderOwner.current, token)} onPermissions={permissions} onRestart={restart} onClose={close} onShortcutChange={changeShortcut} onRecordingChange={recording} checkShortcut={checkShortcut} />}
  </span>;
}

export function apply(ctx) {
  const stopPresentation = installSnapshotPresentation(ctx);
  const snapshots = createSnapshotStore();
  const persistence = createDraftPersistence(request);
  const stopSubmission = installSnapshotSubmission(ctx, snapshots, persistence);
  const controller = createController(ctx.conversation, request, {}, snapshots, persistence);
  persistence.onError = error => controller.reportError(error);
  const recorder = createShortcutRecording(ctx.shortcuts, request);
  const pageHide = () => persistence.releaseOnPageHide(undefined,
    sessionId => !snapshots.hasInFlightSession?.(sessionId));
  window.addEventListener('pagehide', pageHide);
  const factory = props => <SnapshotControl {...props} ctx={ctx} controller={controller} recorder={recorder} />;
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({ name: 'conversation.input.left', id: 'context-snapshot', order: 70 }, factory));
  const attachmentsFactory = props => {
    useSyncExternalStore(listener => ctx.slots.subscribe('conversation.input.attachments', listener),
      () => ctx.slots.getVersion('conversation.input.attachments'),
      () => ctx.slots.getVersion('conversation.input.attachments'));
    // The official attachment renderer keeps its drop intake, ordinary file
    // uploads and lightbox. Render it as a React element to preserve its Hooks.
    const fallback = ctx.slots.entries('conversation.input.attachments')
      .find(entry => entry.options.priority !== -100);
    return <SnapshotAttachments {...props} snapshots={snapshots} Fallback={fallback?.component} />;
  };
  ctx.slots.inject('conversation.input.attachments', () => ctx.slots.register({
    name: 'conversation.input.attachments', priority: -100, locale: 'conversation',
  }, attachmentsFactory));
  ctx.effect(() => async () => {
    snapshots.preserveDrafts = true;
    window.removeEventListener('pagehide', pageHide);
    controller.dispose();
    await recorder.dispose().catch(() => {});
    discardSnapshotDrafts(ctx.conversation, ctx.sessions, snapshots);
    await stopSubmission();
    // A detached send still owns its disk drafts and must be allowed to
    // settle before persistence closes and its heartbeat loses that lease.
    await snapshots.waitForInFlight?.();
    await snapshots.flushPersistence?.().catch(error => console.error('快照草稿清理未确认，原记录已保留。', error));
    await persistence.dispose().catch(error => console.error('快照草稿窗口租约释放失败。', error));
    stopPresentation();
  });
}
