import { validateCapture } from './protocol.mjs';

/** One recently active composer receives a gesture, pinned at the trigger. */
export class SnapshotBroker {
  lease = null;
  items = new Map();
  generations = new Map();
  status = { running: false, ready: false, platform: process.platform, error: '' };
  constructor(now = () => Date.now()) { this.now = now; }
  sweep() {
    const now = this.now();
    for (const [id, item] of this.items) if (now - item.createdAt > 60_000) this.items.delete(id);
    if (this.lease && now - this.lease.updatedAt > 15_000) this.lease = null;
  }
  poll(clientId, sessionId, claim = false, viewId = clientId, generation = 0) {
    this.sweep();
    const latest = this.generations.get(viewId) ?? -1;
    if (generation >= latest) {
      this.generations.set(viewId, generation);
      if (this.generations.size > 128) this.generations.delete(this.generations.keys().next().value);
      if (!this.lease || this.lease.clientId === clientId || claim) this.lease = { clientId, sessionId, viewId, generation, updatedAt: this.now() };
    }
    return { status: { ...this.status }, owner: this.lease?.clientId === clientId,
      items: [...this.items.values()].filter(x => x.clientId === clientId && x.sessionId === sessionId && x.state !== 'pending') };
  }
  trigger(captureId) {
    this.sweep();
    if (this.items.has(captureId)) return;
    if (!this.lease) { this.status.error = '请先在 Harness 中打开一个会话，再按快照快捷键。'; return; }
    if (this.items.size >= 4) { this.status.error = '待处理快照过多，请返回 Harness 处理当前草稿。'; return; }
    this.items.set(captureId, { captureId, clientId: this.lease.clientId, sessionId: this.lease.sessionId, createdAt: this.now(), state: 'pending' });
  }
  capture(captureId, capture) {
    const item = this.items.get(captureId);
    if (!item || item.state !== 'pending') return;
    try { item.capture = validateCapture(capture); item.state = 'ready'; this.status.error = ''; }
    catch (e) { this.fail(captureId, e.message); }
  }
  fail(captureId, message) {
    const item = this.items.get(captureId);
    if (item) { item.state = 'error'; item.error = String(message).slice(0, 512); }
    else this.status.error = String(message).slice(0, 512);
  }
  acknowledge(clientId, sessionId, captureId) {
    const item = this.items.get(captureId);
    if (!item || item.clientId !== clientId || item.sessionId !== sessionId) return false;
    this.items.delete(captureId); return true;
  }
  release(clientId, sessionId, generation = 0) {
    if (this.lease?.clientId === clientId && this.lease.sessionId === sessionId && this.lease.generation === generation) {
      this.generations.set(this.lease.viewId, Math.max(this.generations.get(this.lease.viewId) ?? 0, generation + 1));
      this.lease = null;
    }
  }
  dispose() { this.lease = null; this.items.clear(); this.generations.clear(); }
}
