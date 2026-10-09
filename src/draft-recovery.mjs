import { captureFile } from './draft.mjs';
import { parseSnapshotPresentation } from './presentation-data.mjs';
import { UNCONFIRMED_SEND_NOTICE } from './send-intent.mjs';

/** Small browser transport; Host owns the atomic files and window leases. */
export function createDraftPersistence(send, options = {}) {
  if (typeof send !== 'function') throw new TypeError('Snapshot persistence requires a request transport');
  const ownerId = options.ownerId ?? globalThis.crypto.randomUUID();
  const sessions = new Set();
  let queue = Promise.resolve(), closing = false;
  const mutation = body => {
    const task = queue.then(() => send({ ...body, ownerId }));
    queue = task.catch(() => {});
    return task;
  };
  return {
    ownerId,
    async save(sessionId, capture) {
      if (closing) throw new Error('快照草稿窗口已关闭，保存已取消。');
      sessions.add(sessionId);
      const result = await mutation({ op: 'draftSave', sessionId, capture });
      if (result?.saved !== true) throw new Error('快照草稿保存未确认，请重试。');
      sessions.add(sessionId);
      return result;
    },
    async claim(sessionId, knownIds = []) {
      if (closing) throw new Error('快照草稿窗口已关闭，恢复已取消。');
      // Claims also mutate Host leases. Serialize them with release/dispose
      // so a late network reply cannot reopen a closed window's ownership.
      const result = await mutation({ op: 'draftClaim', sessionId, knownIds });
      if (!Array.isArray(result?.records)) throw new Error('快照草稿恢复接口不兼容，请重启插件。');
      if (result.retryAt == null) sessions.add(sessionId);
      return result;
    },
    async renew(sessionId, snapshotIds) {
      if (closing) throw new Error('快照草稿窗口已关闭，发送确认已取消。');
      return mutation({ op: 'draftRenew', sessionId, ...(snapshotIds ? { snapshotIds } : {}) });
    },
    async beginSend(sessionId, snapshotIds, attemptId) {
      if (closing) throw new Error('快照草稿窗口已关闭，发送确认已取消。');
      const result = await mutation({ op: 'draftBeginSend', sessionId, snapshotIds, attemptId });
      if (result?.begun !== true) throw new Error('快照发送状态持久化未确认，尚未发起发送。');
      sessions.add(sessionId);
      return result;
    },
    async rejectSend(sessionId, snapshotIds, attemptId, rejectionCode) {
      const result = await mutation({ op: 'draftRejectSend', sessionId, snapshotIds, attemptId, rejectionCode });
      if (result?.rejected !== true) throw new Error('快照发送拒绝状态未确认，原草稿已保留。');
      return result;
    },
    async remove(snapshotId) {
      const result = await mutation({ op: 'draftDelete', snapshotId });
      if (result?.deleted !== true) throw new Error('快照草稿清理未确认，请重试。');
      return result;
    },
    async rebind(snapshotId, sessionId) {
      if (closing) throw new Error('快照草稿窗口已关闭，迁移已取消。');
      const result = await mutation({ op: 'draftRebind', snapshotId, sessionId });
      if (result?.rebound !== true) throw new Error('快照草稿迁移未确认，请重试。');
      sessions.add(sessionId);
      return result;
    },
    async rebindMany(snapshotIds, sessionId) {
      if (closing) throw new Error('快照草稿窗口已关闭，迁移已取消。');
      const result = await mutation({ op: 'draftRebind', snapshotIds, sessionId });
      if (result?.rebound !== true) throw new Error('快照草稿迁移未确认，请重试。');
      sessions.add(sessionId);
      return result;
    },
    async release(sessionId) {
      const result = await mutation({ op: 'draftRelease', sessionId });
      sessions.delete(sessionId);
      return result;
    },
    async metadata(snapshotIds) {
      const result = await send({ op: 'snapshotMetadata', snapshotIds });
      if (!result?.metadata || typeof result.metadata !== 'object' || Array.isArray(result.metadata)) throw new Error('快照来源图标读取未确认。');
      return result.metadata;
    },
    flush: () => queue,
    releaseOnPageHide(fetcher = globalThis.fetch, canRelease = () => true) {
      if (typeof fetcher !== 'function') return;
      // Small lease-only frames can outlive document teardown. Bytes and all
      // saved metadata remain on Host; no asynchronous deletion happens here.
      for (const sessionId of sessions) {
        // The send may already be admitted while its response is still in
        // flight. Let the existing bounded lease expire after page exit;
        // releasing it immediately lets another window revive that capture.
        if (!canRelease(sessionId)) continue;
        void Promise.resolve(fetcher('api/context-snapshot', { method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' }, keepalive: true,
          body: JSON.stringify({ op: 'draftRelease', ownerId, sessionId }) })).catch(() => {});
      }
    },
    async dispose() {
      closing = true;
      let observed;
      do { observed = queue; await observed; } while (observed !== queue);
      const results = await Promise.allSettled([...sessions].map(sessionId => send({ op: 'draftRelease', ownerId, sessionId })));
      sessions.clear();
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
    },
  };
}

const canRestore = target => target?.alive && (!target.isEligible || target.isEligible())
  && target.phase !== 'adjudicating' && target.phase !== 'submitting';

function messageHasSnapshot(message, snapshotId) {
  if (message?.source?.kind !== 'user') return false;
  return parseSnapshotPresentation(message.content)?.snapshots.some(capture => capture.id === snapshotId) ?? false;
}

/** Tri-state reconciliation against public, durable Session history. */
export async function hasSentSnapshot(sessions, sessionId, snapshotId, capturedAt, options = {}) {
  const binding = sessions?.binding?.(sessionId);
  const session = binding?.session;
  if (!session || typeof binding?.eventSource?.getSnapshot !== 'function' || typeof session.getSnapshot !== 'function') return null;
  const captureTime = Date.parse(capturedAt);
  if (!Number.isFinite(captureTime)) return null;
  for (let page = 0; page <= (options.maxPagesPerCheck ?? 4); page += 1) {
    if (sessions.binding(sessionId) !== binding) return null;
    const state = session.getSnapshot();
    if (state.openState !== 'open') return null;
    const window = binding.eventSource.getSnapshot();
    if (!Array.isArray(window?.entries)) return null;
    const inbox = session.projections?.faceOf?.('inbox')?.getSnapshot?.();
    for (const target of ['next-turn', 'next-step']) {
      if (Array.isArray(inbox?.[target]) && inbox[target].some(message => messageHasSnapshot(message, snapshotId))) return true;
    }
    let earliest = Infinity;
    for (const entry of window.entries) {
      if (entry?.type !== 'event') continue;
      const event = entry.event;
      if (Number.isFinite(event?.time)) earliest = Math.min(earliest, event.time);
      if (event?.type === 'user/message' && messageHasSnapshot(event.data, snapshotId)) return true;
      // Queued input can be accepted durably before it reaches user/message.
      if (event?.type === 'agent/inbox/spliced' && Array.isArray(event.data?.inserted)
        && event.data.inserted.some(message => messageHasSnapshot(message, snapshotId))) return true;
    }
    if (window.hasMore === false || earliest <= captureTime) return false;
    if (state.loadingOlder || typeof session.loadOlder !== 'function' || page === (options.maxPagesPerCheck ?? 4)) return null;
    const revision = window.revision;
    await session.loadOlder();
    // loadOlder may fail softly or share another page operation. Never treat
    // its lack of progress as evidence that an accepted message does not exist.
    if (binding.eventSource.getSnapshot().revision === revision) return null;
  }
  return null;
}

async function retireConfirmedSnapshot(snapshotId, conversation, target, snapshots, persistence) {
  const local = snapshots.entries().find(([, entry]) => entry.capture.snapshotId === snapshotId)?.[1];
  if (local && snapshots.removeDurably) await snapshots.removeDurably(local.id,
    () => target.inputActions.removeAttachment?.(local.id));
  else {
    await persistence.remove(snapshotId);
    if (local) {
      if (!target.inputActions.removeAttachment) throw new Error('当前 Harness 无法移除已确认发送的快照，请刷新原会话。');
      target.inputActions.removeAttachment(local.id);
      if (conversation.releaseDraftAttachment) conversation.releaseDraftAttachment(local.id);
      else conversation.releaseDraftAttachments([{ id: local.id }]);
      snapshots.delete(local.id);
    }
  }
  snapshots.unconfirmedSends?.delete(snapshotId);
  snapshots.unconfirmedRecords?.delete(snapshotId);
}

/** Restore complete saved captures into the public Host registry, never text. */
export async function restoreSnapshotDrafts(conversation, target, snapshots, persistence) {
  if (!canRestore(target)) return { restored: 0, retryAt: null };
  const cached = [...(snapshots.unconfirmedRecords ?? [])].filter(([, record]) => record.sessionId === target.sessionId);
  const known = snapshots.entries().filter(([, entry]) => entry.sessionId === target.sessionId)
    .map(([, entry]) => entry.capture.snapshotId).filter(Boolean);
  const result = await persistence.claim(target.sessionId, [...new Set([...known, ...cached.map(([id]) => id)])]);
  if (!canRestore(target)) return { restored: 0, retryAt: result.retryAt ?? null };
  if (result.retryAt != null) return { restored: 0, retryAt: result.retryAt };
  let restored = 0, pending = 0, unconfirmed = 0;
  const missing = new Set(result.missingIds ?? []);
  for (const id of missing) if (known.includes(id) || cached.some(([key]) => key === id)) {
    await retireConfirmedSnapshot(id, conversation, target, snapshots, persistence);
  }
  for (const [id, record] of cached) {
    if (missing.has(id)) continue;
    const sent = await target.hasSentSnapshot?.(id, record.capturedAt);
    if (sent === true) await retireConfirmedSnapshot(id, conversation, target, snapshots, persistence);
    else unconfirmed += 1;
  }
  for (const record of result.records) {
    if (record?.version !== 1 || record.kind !== 'draft' || record.sessionId !== target.sessionId
      || record.snapshotId !== record.capture?.snapshotId || typeof record.capture?.pngBase64 !== 'string'
      || !Number.isFinite(Date.parse(record.capture?.capturedAt))) throw new Error('快照草稿图片与上下文不完整，未导入会话。');
    if (typeof target.hasSentSnapshot === 'function') {
      const sent = await target.hasSentSnapshot(record.snapshotId, record.capture.capturedAt);
      if (sent === true) {
        await retireConfirmedSnapshot(record.snapshotId, conversation, target, snapshots, persistence);
        continue;
      }
      if (sent !== false && !record.submissionIntent) { pending += 1; continue; }
    }
    if (record.submissionIntent) {
      // Complete, currently empty history is not evidence that an old Host
      // admission will never finish after its originating page disappeared.
      snapshots.unconfirmedSends?.add(record.snapshotId);
      snapshots.unconfirmedRecords?.set(record.snapshotId,
        { sessionId: record.sessionId, capturedAt: record.capture.capturedAt });
      unconfirmed += 1;
      continue;
    }
    // A fresh capture may have arrived while the Host claim was in flight.
    if (snapshots.entries().some(([, entry]) => entry.capture.snapshotId === record.snapshotId)) continue;
    if (!canRestore(target)) break;
    const drafts = conversation.createDrafts(target.sessionId, [captureFile(record.capture)]);
    if (drafts.length !== 1 || drafts[0].kind !== 'image') {
      conversation.releaseDraftAttachments(drafts);
      throw new Error('当前 Harness 未恢复完整图片附件；草稿仍保留在磁盘。');
    }
    const id = drafts[0].id;
    try {
      snapshots.add(id, target.sessionId, record.capture);
      if (!target.inputActions.addAttachments([id])) {
        snapshots.delete(id);
        conversation.releaseDraftAttachments(drafts);
        break;
      }
      restored += 1;
    } catch (error) {
      snapshots.delete(id);
      conversation.releaseDraftAttachments(drafts);
      throw error;
    }
  }
  return { restored, retryAt: result.retryAt ?? null, pending, unconfirmed,
    ...(unconfirmed ? { notice: UNCONFIRMED_SEND_NOTICE } : {}) };
}
