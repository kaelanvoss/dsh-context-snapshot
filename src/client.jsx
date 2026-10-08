import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createController, request } from './controller.mjs';
import { createSnapshotStore } from './snapshot-store.mjs';
import { installSnapshotSubmission } from './submission.mjs';
import { SnapshotAttachments } from './SnapshotAttachments.jsx';
import { discardSnapshotDrafts } from './draft.mjs';

export const inject = ['slots', 'conversation', 'sessions'];

function SnapshotControl({ ctx, controller, sessionId, inputActions, useInput }) {
  const phase = useInput(state => state.phase);
  const [status, setStatus] = useState({});
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const targetRef = useRef();
  useEffect(() => {
    const target = { sessionId, inputActions, phase, alive: true,
      isEligible: () => (ctx.sessions.list.getSnapshot().byId[sessionId]?.retainedBy.mainView ?? 0) > 0,
      onStatus: value => setStatus(previous => ({ ...previous, ...value })) };
    targetRef.current = target;
    return controller.register(target);
  }, [sessionId, inputActions, controller]);
  if (targetRef.current) targetRef.current.phase = phase;
  const shortcut = /Win/.test(navigator.platform) ? '左右 Ctrl' : '左右 Command';
  async function permissions() {
    setPending(true);
    try { const data = await request({ op: 'requestPermissions' }); setStatus({ ...data.status, permissions: data.permissions }); }
    catch (e) { setStatus({ error: e.message }); }
    finally { setPending(false); }
  }
  async function restart() {
    setPending(true);
    try { setStatus((await request({ op: 'restart' })).status); }
    catch (e) { setStatus({ error: e.message }); }
    finally { setPending(false); }
  }
  return <span style={{ position: 'relative', display: 'inline-flex' }}>
    <button type="button" title={`同时按下${shortcut}，将前台窗口加入草稿`} aria-expanded={open} onClick={() => setOpen(!open)} style={{ border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', padding: '4px 8px' }}>▣ 快照</button>
    {open && <div role="dialog" aria-label="窗口快照" style={{ position: 'absolute', bottom: 36, left: 0, width: 310, padding: 14, border: '1px solid #8886', borderRadius: 12, background: 'var(--dsh-bg, Canvas)', color: 'CanvasText', boxShadow: '0 6px 24px #0003', zIndex: 30, fontSize: 13, lineHeight: 1.6 }}>
      <strong>添加窗口快照</strong>
      <p>确认此会话就绪后，切换到要引用的窗口，同时按住{shortcut}。窗口将以快照卡片加入草稿，发送时附带图片和窗口文字。</p>
      <p>{status.ready ? '原生程序已就绪' : '原生程序尚未就绪'}{status.owner === false ? '；快照目标是另一个 Harness 窗口' : ''}</p>
      {status.permissions && <p>截图：{status.permissions.screenRecording ? '可用' : '待授权'} · 窗口文字：{status.permissions.accessibility ? '可用' : '待授权'} · 快捷键：{status.permissions.inputMonitoring || status.permissions.accessibility ? '可用' : '待授权'}</p>}
      {(status.error || status.message) && <p role="status">{status.error || status.message}</p>}
      <button type="button" disabled={pending} onClick={permissions}>检查 / 授予系统权限</button>{' '}
      <button type="button" disabled={pending} onClick={restart}>重启原生程序</button>
      <p style={{ opacity: .7, marginBottom: 0 }}>快照不会自动发送。点击卡片可预览；移除卡片会同时移除图片和窗口上下文。</p>
    </div>}
  </span>;
}

export function apply(ctx) {
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
  });
}
