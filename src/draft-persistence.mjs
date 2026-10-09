import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { shortcutSettingsPath } from './shortcut-settings.mjs';
import { validateCapture, MAX_LINE_BYTES } from './protocol.mjs';
import { cleanAppIcon } from './app-icon.mjs';
import { validateCaptureContext } from './capture-context.mjs';
import { isCaptureTime } from './capture-context.mjs';
import { VALID_INTENT_REJECTIONS, UNCONFIRMED_SEND_NOTICE } from './send-intent.mjs';

export const DRAFT_ARCHIVE_VERSION = 1;
export const DRAFT_LEASE_MS = 15_000;
export const MAX_DRAFTS = 16;
export const MAX_DRAFT_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const MAX_DECORATIONS = 2048;
export const MAX_DECORATION_BYTES = 24 * 1024 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validIdentity = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f]/.test(value);
const checksumOf = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sealRecord = value => {
  const { checksum: _, ...record } = value;
  return { ...record, checksum: checksumOf(record) };
};
const keyOf = value => {
  if (!uuid.test(value ?? '')) throw new Error('快照标识无效，草稿未保存。');
  return value.toLowerCase();
};
function identity(value) {
  if (!validIdentity(value)) throw new Error('快照草稿缺少有效的会话或窗口标识。');
  return value;
}
export function draftArchivePath(platform = process.platform, environment = process.env, home) {
  return join(dirname(shortcutSettingsPath(platform, environment, home)), 'drafts-v1');
}

function sendIntent(value) {
  if (!value || value.status !== 'unconfirmed' || !isCaptureTime(value.startedAt)
    || Object.keys(value).some(key => !['status', 'attemptId', 'startedAt'].includes(key))) throw new Error('快照发送确认记录无效，原草稿已保留。');
  return { status: 'unconfirmed', attemptId: keyOf(value.attemptId), startedAt: value.startedAt };
}
function fullRecord(sessionId, capture, submissionIntent) {
  identity(sessionId);
  if (!capture || !Number.isFinite(Date.parse(capture.capturedAt))) throw new Error('快照时间无效，草稿未保存。');
  const snapshotId = keyOf(capture.snapshotId);
  const validated = validateCapture(capture);
  const record = { version: DRAFT_ARCHIVE_VERSION, kind: 'draft', snapshotId, sessionId,
    capture: { ...validated, snapshotId }, ...(submissionIntent ? { submissionIntent: sendIntent(submissionIntent) } : {}) };
  return sealRecord(record);
}
function decorationRecord(record) {
  const appIconPngBase64 = cleanAppIcon(record.capture?.appIconPngBase64 ?? record.decoration?.appIconPngBase64);
  return { version: DRAFT_ARCHIVE_VERSION, kind: 'decoration', snapshotId: record.snapshotId,
    decoration: appIconPngBase64 ? { appIconPngBase64 } : {} };
}
function parseStored(value, expectedId) {
  if (value?.version !== DRAFT_ARCHIVE_VERSION) throw new Error('存在无法识别的快照草稿版本，原文件已保留。');
  if (keyOf(value.snapshotId) !== expectedId) throw new Error('已保存快照的文件与标识不一致，原文件已保留。');
  if (value.kind === 'draft') {
    if (!validateCaptureContext(value.capture, value.capture?.text)) throw new Error('已保存快照的质量或来源字段无效，原文件已保留。');
    const record = fullRecord(value.sessionId, value.capture, value.submissionIntent);
    if (record.snapshotId !== expectedId) throw new Error('已保存快照图片与上下文标识不一致，原文件已保留。');
    if (value.checksum !== record.checksum) throw new Error('已保存快照的图片或上下文校验失败，原文件已保留。');
    return record;
  }
  if (value.kind === 'decoration') return decorationRecord(value);
  throw new Error('已保存快照记录格式无效，原文件已保留。');
}

/** One Host-owned atomic record contains both image bytes and all context. */
export class SnapshotDraftArchive {
  constructor(options = {}) {
    this.directory = options.directory ?? draftArchivePath();
    this.now = options.now ?? Date.now;
    this.maxDrafts = options.maxDrafts ?? MAX_DRAFTS;
    this.maxDraftBytes = options.maxDraftBytes ?? MAX_DRAFT_ARCHIVE_BYTES;
    this.maxDecorations = options.maxDecorations ?? MAX_DECORATIONS;
    this.maxDecorationBytes = options.maxDecorationBytes ?? MAX_DECORATION_BYTES;
    this.ensureSession = options.ensureSession;
    this.records = new Map();
    this.routes = new Map();
    this.sendIntents = new Map();
    this.leases = new Map();
    this.sessionLeases = new Map();
    this.queue = Promise.resolve();
    this.loaded = false;
    this.loadError = null;
    this.disposed = false;
  }
  enqueue(action) {
    const task = this.queue.then(async () => {
      if (this.disposed) throw new Error('快照草稿存储已停用。');
      await this.load();
      return action();
    });
    this.queue = task.catch(() => {});
    return task;
  }
  async load() {
    if (this.loaded) { if (this.loadError) throw this.loadError; return; }
    this.loaded = true;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const names = await readdir(this.directory);
      if (names.filter(name => name.endsWith('.json') && name !== 'routing.json').length > this.maxDrafts + this.maxDecorations) throw new Error('已保存快照记录数量超过限制，原文件已保留。');
      if (names.includes('routing.json')) {
        const routePath = join(this.directory, 'routing.json');
        const routeSize = await stat(routePath);
        if (!routeSize.isFile() || routeSize.size > 512 * 1024) throw new Error('快照会话迁移记录超过限制，原文件已保留。');
        const routes = JSON.parse(await readFile(routePath, 'utf8'));
        if (routes?.version !== 1 || !routes.sessions || typeof routes.sessions !== 'object' || Array.isArray(routes.sessions)) throw new Error('快照会话迁移记录格式无效，原文件已保留。');
        if (routes.checksum !== checksumOf({ version: 1, sessions: routes.sessions })) throw new Error('快照会话迁移记录校验失败，原文件已保留。');
        const entries = Object.entries(routes.sessions);
        if (entries.length > this.maxDrafts + this.maxDecorations) throw new Error('快照会话迁移记录数量超过限制，原文件已保留。');
        for (const [snapshotId, sessionId] of entries) this.routes.set(keyOf(snapshotId), identity(sessionId));
      }
      let totalBytes = 0;
      for (const name of names) {
        // Incomplete writes are never imported as an image-only draft.
        if (name.endsWith('.tmp')) continue;
        if (!name.endsWith('.json') || name === 'routing.json' || name === 'dispatch.json') continue;
        const snapshotId = keyOf(name.slice(0, -5));
        const path = join(this.directory, name);
        const info = await stat(path);
        if (!info.isFile() || info.size > MAX_LINE_BYTES) throw new Error('已保存快照超出大小限制，原文件已保留。');
        totalBytes += info.size;
        if (totalBytes > this.maxDraftBytes + this.maxDecorationBytes) throw new Error('已保存快照总大小超过限制，原文件已保留。');
        const raw = JSON.parse(await readFile(path, 'utf8'));
        let record = parseStored(raw, snapshotId);
        if (record.kind === 'draft' && this.routes.has(snapshotId)) record = sealRecord({ ...record, sessionId: this.routes.get(snapshotId) });
        this.records.set(snapshotId, { record, bytes: Buffer.byteLength(JSON.stringify(record)) });
      }
      if (names.includes('dispatch.json')) {
        const info = await stat(join(this.directory, 'dispatch.json'));
        if (!info.isFile() || info.size > 64 * 1024) throw new Error('快照发送确认记录超过限制，原草稿已保留。');
        const journal = JSON.parse(await readFile(join(this.directory, 'dispatch.json'), 'utf8'));
        if (journal?.version !== 1 || !journal.intents || typeof journal.intents !== 'object' || Array.isArray(journal.intents)
          || journal.checksum !== checksumOf({ version: 1, intents: journal.intents })) throw new Error('快照发送确认记录校验失败，原草稿已保留。');
        const entries = Object.entries(journal.intents);
        if (entries.length > this.maxDrafts) throw new Error('快照发送确认记录数量超过限制，原草稿已保留。');
        for (const [id, raw] of entries) {
          const snapshotId = keyOf(id), stored = this.records.get(snapshotId)?.record;
          if (!stored) throw new Error('快照发送确认缺少完整图片与上下文，未恢复。');
          // A committed tombstone is authoritative even if cleanup did not
          // compact the intent journal before the process stopped.
          if (stored.kind !== 'draft') continue;
          if (identity(raw?.sessionId) !== stored.sessionId) throw new Error('快照发送确认的所属会话不一致，未恢复。');
          const { sessionId: _, ...intent } = raw;
          const normalized = sendIntent(intent);
          const record = fullRecord(stored.sessionId, stored.capture, normalized);
          this.sendIntents.set(snapshotId, { sessionId: stored.sessionId, ...normalized });
          this.records.set(snapshotId, { record, bytes: Buffer.byteLength(JSON.stringify(record)) });
        }
      }
      this.assertQuota(this.records);
    } catch (error) {
      this.records.clear();
      this.loadError = new Error(`快照草稿无法恢复：${error.message}`);
      throw this.loadError;
    }
  }
  assertQuota(records) {
    let drafts = 0, draftBytes = 0, decorations = 0, decorationBytes = 0;
    for (const { record, bytes } of records.values()) {
      if (record.kind === 'draft') { drafts += 1; draftBytes += bytes; }
      else { decorations += 1; decorationBytes += bytes; }
    }
    if (drafts > this.maxDrafts || draftBytes > this.maxDraftBytes) throw new Error('快照草稿存储已达到上限，请先发送或移除已有快照；已有草稿未被删除。');
    if (decorations > this.maxDecorations || decorationBytes > this.maxDecorationBytes) throw new Error('快照来源图标存储已达到上限；已有记录未被删除。');
  }
  expire() {
    for (const [snapshotId, lease] of this.leases) if (lease.until <= this.now()) this.leases.delete(snapshotId);
    for (const [sessionId, lease] of this.sessionLeases) if (lease.until <= this.now()) this.sessionLeases.delete(sessionId);
  }
  sessionOwner(sessionId, ownerId) {
    this.expire();
    const lease = this.sessionLeases.get(sessionId);
    if (lease && lease.ownerId !== ownerId) throw new Error('此会话的快照草稿正在另一窗口使用，请回到原窗口操作。');
  }
  owner(snapshotId, ownerId) {
    this.expire();
    const lease = this.leases.get(snapshotId);
    if (lease && lease.ownerId !== ownerId) throw new Error('此快照草稿正在另一窗口使用，请回到原窗口操作。');
    return lease;
  }
  lease(snapshotId, ownerId, sessionId) {
    this.leases.set(snapshotId, { ownerId, sessionId, until: this.now() + DRAFT_LEASE_MS });
    this.sessionLeases.set(sessionId, { ownerId, until: this.now() + DRAFT_LEASE_MS });
  }
  async atomicFile(destination, content, committed) {
    const temporary = `${destination}.${randomUUID()}.tmp`;
    let file;
    try {
      file = await open(temporary, 'wx', 0o600);
      await file.writeFile(content);
      await file.sync();
      await file.close(); file = null;
      await rename(temporary, destination);
      committed();
      // Sync the rename on filesystems supporting directory fsync. The
      // atomic record is already committed if the platform rejects this seat.
      let directory;
      try { directory = await open(this.directory, 'r'); await directory.sync(); }
      catch (error) { if (!['EINVAL', 'EISDIR', 'EPERM', 'ENOTSUP', 'EBADF'].includes(error.code)) throw error; }
      finally { await directory?.close().catch(() => {}); }
    } finally {
      await file?.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
  async write(record) {
    const content = JSON.stringify(record) + '\n';
    const proposed = new Map(this.records);
    proposed.set(record.snapshotId, { record, bytes: Buffer.byteLength(content) });
    this.assertQuota(proposed);
    await this.atomicFile(join(this.directory, `${record.snapshotId}.json`), content, () => { this.records = proposed; });
  }
  async writeSendIntents(intents) {
    const active = new Map([...intents].filter(([id]) => this.records.get(id)?.record.kind === 'draft'));
    const records = new Map(this.records);
    for (const [id, stored] of records) if (stored.record.kind === 'draft') {
      const raw = active.get(id);
      const record = fullRecord(stored.record.sessionId, stored.record.capture,
        raw ? { status: raw.status, attemptId: raw.attemptId, startedAt: raw.startedAt } : undefined);
      records.set(id, { record, bytes: Buffer.byteLength(JSON.stringify(record)) });
    }
    this.assertQuota(records);
    const payload = { version: 1, intents: Object.fromEntries(active) };
    const journal = { ...payload, checksum: checksumOf(payload) };
    // One rename marks every image/context pair before any Host admission.
    // Partial per-image updates must never let an unmarked sibling resurrect.
    await this.atomicFile(join(this.directory, 'dispatch.json'), JSON.stringify(journal) + '\n', () => {
      this.sendIntents = active; this.records = records;
    });
  }
  sendRecords(ownerId, sessionId, snapshotIds) {
    identity(ownerId); identity(sessionId);
    if (!Array.isArray(snapshotIds) || !snapshotIds.length || snapshotIds.length > this.maxDrafts) throw new Error('快照发送确认标识列表无效。');
    const ids = snapshotIds.map(keyOf);
    if (new Set(ids).size !== ids.length) throw new Error('快照发送确认标识重复。');
    this.sessionOwner(sessionId, ownerId);
    return ids.map(id => {
      const record = this.records.get(id)?.record;
      if (record?.kind !== 'draft' || record.sessionId !== sessionId) throw new Error('此快照已发送、移除或迁移，请刷新原会话草稿。');
      this.owner(id, ownerId);
      return record;
    });
  }
  beginSend(ownerId, sessionId, snapshotIds, attemptId) {
    return this.enqueue(async () => {
      const attempt = keyOf(attemptId), records = this.sendRecords(ownerId, sessionId, snapshotIds);
      for (const record of records) if (record.submissionIntent && record.submissionIntent.attemptId !== attempt) throw new Error(UNCONFIRMED_SEND_NOTICE);
      const intents = new Map(this.sendIntents), startedAt = new Date(this.now()).toISOString();
      for (const record of records) if (!intents.has(record.snapshotId)) intents.set(record.snapshotId,
        { sessionId, status: 'unconfirmed', attemptId: attempt, startedAt });
      await this.writeSendIntents(intents);
      for (const record of records) this.lease(record.snapshotId, ownerId, sessionId);
      return { begun: true };
    });
  }
  rejectSend(ownerId, sessionId, snapshotIds, attemptId, rejectionCode) {
    return this.enqueue(async () => {
      if (!VALID_INTENT_REJECTIONS.has(rejectionCode)) throw new Error('尚未确认 Host 拒绝此发送，原草稿状态已保留。');
      const attempt = keyOf(attemptId), records = this.sendRecords(ownerId, sessionId, snapshotIds);
      const intents = new Map(this.sendIntents);
      for (const record of records) {
        if (record.submissionIntent && record.submissionIntent.attemptId !== attempt) throw new Error('快照发送确认身份不一致，原草稿已保留。');
        intents.delete(record.snapshotId);
      }
      await this.writeSendIntents(intents);
      for (const record of records) this.lease(record.snapshotId, ownerId, sessionId);
      return { rejected: true };
    });
  }
  save(ownerId, sessionId, capture) {
    return this.enqueue(async () => {
      identity(ownerId);
      const record = fullRecord(sessionId, capture);
      this.sessionOwner(sessionId, ownerId);
      this.owner(record.snapshotId, ownerId);
      const existing = this.records.get(record.snapshotId)?.record;
      if (existing?.kind === 'decoration') throw new Error('此快照已经发送或移除，不能重新保存为草稿。');
      if (existing && existing.sessionId !== sessionId) throw new Error('快照所属会话已变更，不能写回原会话。');
      if (existing && JSON.stringify(existing.capture) !== JSON.stringify(record.capture)) throw new Error('已保存快照内容不可覆盖，请重新采集新快照。');
      await this.ensureSession?.(sessionId);
      if (!existing) await this.write(record);
      this.lease(record.snapshotId, ownerId, sessionId);
      return { saved: true };
    });
  }
  claim(ownerId, sessionId, knownIds = []) {
    return this.enqueue(() => {
      identity(ownerId); identity(sessionId);
      // A retiring page can briefly retain a cached intent for a tombstone
      // while this same Session already owns its next bounded draft batch.
      if (!Array.isArray(knownIds) || knownIds.length > this.maxDrafts * 2) throw new Error('快照恢复标识列表无效。');
      const known = new Set(knownIds.map(keyOf));
      this.expire();
      const missingIds = [...known].filter(id => {
        const record = this.records.get(id)?.record;
        return record?.kind !== 'draft' || record.sessionId !== sessionId;
      });
      const missing = missingIds.length ? { missingIds } : {};
      const hasDrafts = [...this.records.values()].some(({ record }) => record.kind === 'draft' && record.sessionId === sessionId);
      if (!hasDrafts) return { records: [], retryAt: null, ...missing };
      const sessionLease = this.sessionLeases.get(sessionId);
      if (sessionLease && sessionLease.ownerId !== ownerId) return { records: [], retryAt: sessionLease.until };
      this.sessionLeases.set(sessionId, { ownerId, until: this.now() + DRAFT_LEASE_MS });
      const records = []; let retryAt = null;
      for (const [snapshotId, { record }] of this.records) {
        if (record.kind !== 'draft' || record.sessionId !== sessionId) continue;
        const lease = this.leases.get(snapshotId);
        if (lease && lease.ownerId !== ownerId) {
          retryAt = retryAt === null ? lease.until : Math.min(retryAt, lease.until);
          continue;
        }
        this.lease(snapshotId, ownerId, sessionId);
        if (!known.has(snapshotId)) records.push(record);
      }
      return { records, retryAt, ...missing };
    });
  }
  renew(ownerId, sessionId, snapshotIds) {
    return this.enqueue(() => {
      identity(ownerId); identity(sessionId); this.expire();
      this.sessionOwner(sessionId, ownerId);
      if (snapshotIds !== undefined) {
        if (!Array.isArray(snapshotIds) || !snapshotIds.length || snapshotIds.length > this.maxDrafts) throw new Error('快照发送确认标识列表无效。');
        for (const snapshotId of snapshotIds.map(keyOf)) {
          const record = this.records.get(snapshotId)?.record;
          if (record?.kind !== 'draft' || record.sessionId !== sessionId) throw new Error('此快照已发送、移除或迁移到另一会话，请刷新草稿后重试。');
          this.owner(snapshotId, ownerId);
        }
      }
      if (![...this.records.values()].some(({ record }) => record.kind === 'draft' && record.sessionId === sessionId)) return { renewed: 0 };
      this.sessionLeases.set(sessionId, { ownerId, until: this.now() + DRAFT_LEASE_MS });
      let renewed = 0;
      for (const [snapshotId, lease] of this.leases) if (lease.ownerId === ownerId && lease.sessionId === sessionId) {
        this.lease(snapshotId, ownerId, sessionId); renewed += 1;
      }
      return { renewed };
    });
  }
  release(ownerId, sessionId) {
    return this.enqueue(() => {
      identity(ownerId); identity(sessionId);
      for (const [snapshotId, lease] of this.leases) if (lease.ownerId === ownerId && lease.sessionId === sessionId) this.leases.delete(snapshotId);
      if (this.sessionLeases.get(sessionId)?.ownerId === ownerId) this.sessionLeases.delete(sessionId);
      return { released: true };
    });
  }
  delete(ownerId, snapshotId) {
    return this.enqueue(async () => {
      identity(ownerId); snapshotId = keyOf(snapshotId);
      this.owner(snapshotId, ownerId);
      const record = this.records.get(snapshotId)?.record;
      if (record?.kind === 'draft') this.sessionOwner(record.sessionId, ownerId);
      if (record?.kind === 'draft') await this.write(decorationRecord(record));
      this.leases.delete(snapshotId);
      if (record?.kind === 'draft' && ![...this.records.values()].some(({ record: remaining }) => remaining.kind === 'draft' && remaining.sessionId === record.sessionId)) {
        if (this.sessionLeases.get(record.sessionId)?.ownerId === ownerId) this.sessionLeases.delete(record.sessionId);
      }
      return { deleted: true };
    });
  }
  rebind(ownerId, snapshotId, sessionId) {
    return this.rebindMany(ownerId, [snapshotId], sessionId);
  }
  rebindMany(ownerId, snapshotIds, sessionId) {
    return this.enqueue(async () => {
      identity(ownerId); identity(sessionId);
      if (!Array.isArray(snapshotIds) || !snapshotIds.length || snapshotIds.length > this.maxDrafts) throw new Error('快照迁移标识列表无效。');
      const ids = [...new Set(snapshotIds.map(keyOf))];
      this.sessionOwner(sessionId, ownerId);
      for (const snapshotId of ids) {
        this.owner(snapshotId, ownerId);
        const record = this.records.get(snapshotId)?.record;
        if (record?.kind !== 'draft') throw new Error('要迁移的快照草稿已不存在。');
        if (record.submissionIntent) throw new Error(UNCONFIRMED_SEND_NOTICE);
        this.sessionOwner(record.sessionId, ownerId);
      }
      const routes = new Map([...this.routes].filter(([snapshotId]) => this.records.get(snapshotId)?.record.kind === 'draft'));
      const proposed = new Map(this.records);
      for (const snapshotId of ids) {
        routes.set(snapshotId, sessionId);
        const record = sealRecord({ ...proposed.get(snapshotId).record, sessionId });
        proposed.set(snapshotId, { record, bytes: Buffer.byteLength(JSON.stringify(record)) });
      }
      this.assertQuota(proposed);
      await this.ensureSession?.(sessionId);
      // One small rename commits every carried snapshot's target session.
      // A crash can observe all old owners or all new owners, never a split.
      const routing = { version: 1, sessions: Object.fromEntries(routes) };
      await this.atomicFile(join(this.directory, 'routing.json'), JSON.stringify({ ...routing, checksum: checksumOf(routing) }) + '\n', () => {
        this.routes = routes; this.records = proposed;
      });
      for (const snapshotId of ids) this.lease(snapshotId, ownerId, sessionId);
      return { rebound: true };
    });
  }
  metadata(snapshotIds) {
    return this.enqueue(() => {
      if (!Array.isArray(snapshotIds) || snapshotIds.length > 128) throw new Error('快照来源标识列表无效。');
      const metadata = {};
      for (const snapshotId of snapshotIds.map(keyOf)) {
        const record = this.records.get(snapshotId)?.record;
        if (record) metadata[snapshotId] = decorationRecord(record).decoration;
      }
      return { metadata };
    });
  }
  async dispose() { await this.queue; this.disposed = true; this.leases.clear(); this.sessionLeases.clear(); }
}
