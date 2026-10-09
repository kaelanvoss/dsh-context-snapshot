import { attachSnapshotDurably } from './draft.mjs';
import { restoreSnapshotDrafts } from './draft-recovery.mjs';
import { createSnapshotStore } from './snapshot-store.mjs';

export async function request(body, signal) {
  const response = await fetch('api/context-snapshot', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

export function createController(conversation, send = request, environment = {}, snapshots = createSnapshotStore(), persistence) {
  const hasFocus = environment.hasFocus ?? (() => document.hasFocus() && document.visibilityState === 'visible');
  const schedule = environment.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = environment.cancel ?? (timer => clearTimeout(timer));
  const makeId = environment.makeId ?? (() => crypto.randomUUID());
  const clients = new Map(), groups = new Map(), applied = new Set();
  const viewId = makeId();
  let stopped = false, generation = 0;
  const eligible = target => target?.alive && (!target.isEligible || target.isEligible());
  function makeGroup(sessionId) {
    if (!clients.has(sessionId)) clients.set(sessionId, makeId());
    const group = { sessionId, clientId: clients.get(sessionId), members: new Set(), active: null, generation: 0, disposed: false, timer: null, abort: null };
    const status = value => { if (!stopped && !group.disposed) for (const member of group.members) if (member.alive) member.onStatus?.(value); };
    const release = () => send({ op: 'release', clientId: group.clientId, sessionId, generation: group.generation }).catch(() => {});
    async function poll() {
      if (stopped || group.disposed) return;
      const target = eligible(group.active) ? group.active : [...group.members].find(eligible);
      if (!target) { if (group.active) { void release(); group.active = null; } group.timer = schedule(poll, 750); return; }
      if (group.active !== target) { group.active = target; group.generation = ++generation; }
      group.abort = new AbortController();
      const timeout = schedule(() => group.abort.abort(), 10_000);
      try {
        let recoveryWarning;
        const hasDrafts = snapshots.entries().some(([, entry]) => entry.sessionId === sessionId);
        if (persistence && (hasFocus() || hasDrafts)) {
          await snapshots.flushPersistence?.();
          const recovered = await restoreSnapshotDrafts(conversation, target, snapshots, persistence);
          if (recovered.retryAt != null) {
            status({ error: '此会话的快照草稿正在另一窗口使用，请回到原窗口操作。' });
            return;
          }
          if (recovered.unconfirmed) {
            recoveryWarning = recovered.notice;
            status({ error: recoveryWarning });
          }
          if (recovered.restored) status({ message: `已恢复 ${recovered.restored} 张未发送快照。`, error: undefined });
          else if (recovered.pending) status({ message: '正在核对会话记录，确认发送状态后恢复快照。' });
          if (stopped || group.disposed || !eligible(target) || group.active !== target) return;
        }
        const data = await send({ op: 'poll', clientId: group.clientId, sessionId, viewId, generation: group.generation, claim: hasFocus() }, group.abort.signal);
        if (stopped || group.disposed || !eligible(target) || group.active !== target) return;
        status({ ...data.status, owner: data.owner });
        for (const item of data.items ?? []) {
          if (item.sessionId !== sessionId || item.clientId !== group.clientId) continue;
          if (item.state === 'error') status({ ...data.status, error: item.error });
          else if (!applied.has(item.captureId)) {
            const capture = persistence ? { ...item.capture, snapshotId: item.captureId } : item.capture;
            if (!await attachSnapshotDurably(conversation, target, capture, snapshots, persistence)) continue;
            applied.add(item.captureId);
            if (applied.size > 128) applied.delete(applied.values().next().value);
            status({ ...data.status, message: '快照卡片已加入草稿；填写说明后发送。' });
          }
          await send({ op: 'ack', clientId: group.clientId, sessionId, captureId: item.captureId }, group.abort.signal);
        }
        if (recoveryWarning) status({ error: recoveryWarning });
      } catch (e) { if (e.name !== 'AbortError') status({ error: `快照连接失败：${e.message}` }); }
      finally { cancel(timeout); if (!group.disposed && !stopped) group.timer = schedule(poll, 750); }
    }
    group.dispose = () => {
      group.disposed = true; cancel(group.timer); group.abort?.abort(); void release();
      groups.delete(sessionId);
      if (!persistence) return;
      if (!snapshots.hasInFlightSession?.(sessionId)) void persistence.release(sessionId).catch(() => {});
      else void snapshots.waitForInFlight?.().then(() => {
        // The user may return to this session before its detached send ends.
        // Its new view retains the same ownership instead of receiving a
        // late release from the retired composer.
        if (!groups.has(sessionId) && !snapshots.hasInFlightSession?.(sessionId)) return persistence.release(sessionId);
      }).catch(() => {});
    };
    group.poll = poll;
    return group;
  }
  return {
    snapshots,
    reportError(error) { for (const group of groups.values()) for (const target of group.members) target.onStatus?.({ error: error.message || String(error) }); },
    register(target) {
      if (stopped) return () => { target.alive = false; };
      let group = groups.get(target.sessionId);
      const first = !group;
      if (!group) { group = makeGroup(target.sessionId); groups.set(target.sessionId, group); }
      target.clientId = group.clientId;
      group.members.add(target);
      if (first) void group.poll();
      return () => { target.alive = false; group.members.delete(target); if (!group.members.size) group.dispose(); };
    },
    dispose() { stopped = true; for (const group of [...groups.values()]) { for (const member of group.members) member.alive = false; group.dispose(); } clients.clear(); applied.clear(); },
  };
}
