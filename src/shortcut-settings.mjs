import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultShortcut, normalizeShortcut } from './shortcuts.mjs';

export function shortcutSettingsPath(platform = process.platform, environment = process.env, home = homedir()) {
  const local = environment.LOCALAPPDATA;
  const root = platform === 'win32' ? typeof local === 'string' && isAbsolute(local) ? local : join(home, 'AppData', 'Local') : join(home, 'Library', 'Application Support');
  return join(root, 'dsh-context-snapshot', 'shortcut.json');
}
export class ShortcutFileStore {
  constructor(path = shortcutSettingsPath()) { this.path = path; }
  async load() {
    try { return JSON.parse(await readFile(this.path, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw new Error('已保存的快捷键配置无法读取；当前使用默认组合，可重新保存设置。'); }
  }
  async save(shortcut) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(shortcut) + '\n', { mode: 0o600, flag: 'wx' }); await rename(temporary, this.path); }
    // A cleanup failure after rename must not report a durable save as failed
    // and roll back only the native binding while disk already holds the new one.
    finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
}

/** One device-wide setting and expiring recorder leases for all Harness windows. */
export class ShortcutSettings {
  owners = new Map();
  queue = Promise.resolve();
  timer = null;
  disposed = false;
  constructor(native, broker, options = {}) {
    this.native = native; this.broker = broker;
    this.platform = options.platform ?? process.platform;
    this.store = options.store ?? new ShortcutFileStore();
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? setTimeout;
    this.cancel = options.cancel ?? clearTimeout;
    this.shortcut = defaultShortcut(this.platform);
    this.revision = randomUUID();
    this.broker.status.shortcut = this.shortcut;
    this.broker.status.shortcutRevision = this.revision;
    this.loaded = null;
    native.options.onReady = frame => {
      const child = native.child;
      return this.enqueue(() => {
        if (!child || native.child !== child) throw new Error('采集初始化已取消，请等待当前采集程序就绪。');
        return this.boot(frame, child);
      });
    };
  }
  enqueue(action) {
    const task = this.queue.then(() => { if (this.disposed) throw new Error('快照插件已停用。'); return action(); });
    this.queue = task.catch(() => {});
    return task;
  }
  async load() {
    if (!this.loaded) this.loaded = (async () => {
      try { const stored = await this.store.load(); if (stored) this.shortcut = normalizeShortcut(stored, { platform: this.platform }); }
      catch (error) { this.broker.status.settingsError = error.message; }
    })();
    await this.loaded;
  }
  async applyNative(shortcut) {
    const result = await this.native.request('setShortcut', { shortcut });
    const confirmed = normalizeShortcut(result.shortcut, { platform: this.platform, supportedCodes: this.broker.status.supportedCodes });
    if (confirmed.codes.join('+') !== shortcut.codes.join('+')) throw new Error('原生程序未确认该快捷键，请重试。');
    return confirmed;
  }
  async applyRecording(active) {
    const result = await this.native.request('setRecording', { active });
    if (result.recording !== active) throw new Error('采集程序未确认录入状态。');
    this.broker.status.recording = active;
  }
  stopUnconfirmed(message) {
    this.native.stop(message);
    Object.assign(this.broker.status, { ready: false, running: false, recording: false, error: message });
  }
  async boot(frame, child = this.native.child) {
    const checkCurrent = () => {
      if (!child || this.native.child !== child) throw new Error('采集初始化已取消，请等待当前采集程序就绪。');
    };
    try {
      checkCurrent();
      if (!Array.isArray(frame.supportedCodes) || !frame.shortcut) throw new Error('采集程序不支持快捷键设置，请重新安装新版插件。');
      this.broker.status.supportedCodes = frame.supportedCodes;
      // Keep capture paused while disk preferences and recorder leases are being
      // restored. The bridge exposes ready only after this callback completes.
      await this.applyRecording(true);
      await this.load();
      checkCurrent();
      try { this.shortcut = normalizeShortcut(this.shortcut, { platform: this.platform, supportedCodes: frame.supportedCodes }); }
      catch {
        this.shortcut = normalizeShortcut(defaultShortcut(this.platform), { platform: this.platform, supportedCodes: frame.supportedCodes });
        this.broker.status.settingsError = '已保存的组合包含当前系统不支持的按键；已使用默认组合，可重新保存设置。';
      }
      const confirmed = await this.applyNative(this.shortcut);
      checkCurrent();
      this.expireOwners();
      const active = this.owners.size > 0;
      await this.applyRecording(active);
      checkCurrent();
      Object.assign(this.broker.status, { shortcut: confirmed, shortcutRevision: this.revision, recording: active });
      this.armExpiry();
    } catch (error) {
      if (this.native.child === child) this.stopUnconfirmed(`采集配置未确认，请重启采集：${error.message}`);
      throw error;
    }
  }
  async save(value, revision) {
    await this.native.waitReady();
    return this.enqueue(async () => {
      if (revision !== this.revision) throw new Error('快捷键设置已在另一窗口更新，请检查最新组合后重试。');
      const shortcut = normalizeShortcut(value, { platform: this.platform, supportedCodes: this.broker.status.supportedCodes });
      const previous = this.shortcut;
      let confirmed;
      try {
        confirmed = await this.applyNative(shortcut);
        await this.store.save(confirmed);
      }
      catch (error) {
        try { await this.applyNative(previous); }
        catch { this.stopUnconfirmed('保存失败且无法确认旧快捷键已恢复，请重启采集。'); }
        throw new Error(`快捷键未保存：${error.message}`);
      }
      this.shortcut = confirmed; this.revision = randomUUID();
      Object.assign(this.broker.status, { shortcut: confirmed, shortcutRevision: this.revision, settingsError: '', error: '' });
      return { ...this.broker.status };
    });
  }
  expireOwners() { for (const [id, expires] of this.owners) if (expires <= this.now()) this.owners.delete(id); }
  armExpiry() {
    if (this.timer) this.cancel(this.timer);
    if (!this.owners.size || this.disposed) { this.timer = null; return; }
    this.timer = this.schedule(() => {
      this.timer = null;
      void this.enqueue(async () => {
        this.expireOwners();
        const active = this.owners.size > 0;
        try {
          if (this.native.child) await this.applyRecording(active);
        } catch (error) {
          this.stopUnconfirmed(`录入状态恢复未确认，请重启采集：${error.message}`);
        } finally {
          this.armExpiry();
        }
      }).catch(error => { if (!this.disposed) this.broker.status.error = error.message; });
    }, Math.max(1, Math.min(...this.owners.values()) - this.now()));
    this.timer?.unref?.();
  }
  async recording(id, active) {
    await this.native.waitReady();
    return this.enqueue(async () => {
      this.expireOwners();
      const previous = new Map(this.owners);
      if (active) this.owners.set(id, this.now() + 15_000); else this.owners.delete(id);
      try {
        await this.applyRecording(this.owners.size > 0);
      } catch (error) {
        this.owners = previous;
        try { await this.applyRecording(previous.size > 0); }
        catch { this.stopUnconfirmed('录入状态未确认且无法恢复监听，请重启采集。'); }
        throw error;
      }
      finally { this.armExpiry(); }
      return { ...this.broker.status };
    });
  }
  dispose() { this.disposed = true; if (this.timer) this.cancel(this.timer); this.owners.clear(); }
}
