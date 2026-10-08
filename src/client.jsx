import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createController, request } from './controller.mjs';
import { createSnapshotStore } from './snapshot-store.mjs';
import { installSnapshotSubmission } from './submission.mjs';
import { SnapshotAttachments } from './SnapshotAttachments.jsx';
import { discardSnapshotDrafts } from './draft.mjs';
import { installSnapshotPresentation } from './presentation.jsx';
import { SnapshotIcon } from './SnapshotIcon.jsx';
import { SnapshotPopover } from './SnapshotPopover.jsx';

export const inject = ['slots', 'conversation', 'sessions'];

function SnapshotControl({ ctx, controller, sessionId, inputActions, useInput }) {
  const phase = useInput(state => state.phase);
  const [status, setStatus] = useState({});
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(null);
  const targetRef = useRef();
  const controlRef = useRef();
  useEffect(() => {
    const target = { sessionId, inputActions, phase, alive: true,
      isEligible: () => (ctx.sessions.list.getSnapshot().byId[sessionId]?.retainedBy.mainView ?? 0) > 0,
      onStatus: value => setStatus(previous => ({ ...previous, ...value })) };
    targetRef.current = target;
    return controller.register(target);
  }, [sessionId, inputActions, controller]);
  if (targetRef.current) targetRef.current.phase = phase;
  const isWindows = /Win/.test(navigator.platform);
  const shortcut = isWindows ? '左右 Ctrl' : '左右 Command';
  function close() { setOpen(false); controlRef.current?.focus(); }
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
  return <span onKeyDown={event => { if (open && event.key === 'Escape') { event.stopPropagation(); close(); } }} style={{ position: 'relative', display: 'inline-flex' }}>
    <button ref={controlRef} type="button" title={`同时按下${shortcut}，将前台窗口加入草稿`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: 'none', background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer', padding: '4px 8px' }}><SnapshotIcon /><span>快照</span></button>
    {open && <SnapshotPopover status={status} pending={pending} isWindows={isWindows} onPermissions={permissions} onRestart={restart} onClose={close} />}
  </span>;
}

export function apply(ctx) {
  const stopPresentation = installSnapshotPresentation(ctx);
  const snapshots = createSnapshotStore();
  const stopSubmission = installSnapshotSubmission(ctx, snapshots);
  const controller = createController(ctx.conversation, request, {}, snapshots);
  const factory = props => <SnapshotControl {...props} ctx={ctx} controller={controller} />;
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
    controller.dispose();
    discardSnapshotDrafts(ctx.conversation, ctx.sessions, snapshots);
    await stopSubmission();
    stopPresentation();
  });
}
