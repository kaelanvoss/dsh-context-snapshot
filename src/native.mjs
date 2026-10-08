import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { LineDecoder } from './protocol.mjs';
import { prepareWindowsHelper } from './helper-cache.mjs';

export function helperPath(platform = process.platform, arch = process.arch) {
  if (platform === 'darwin') return fileURLToPath(new URL('../native/macos/build/ContextSnapshot.app/Contents/MacOS/ContextSnapshot', import.meta.url));
  if (platform === 'win32') return fileURLToPath(new URL(`../native/windows/publish/win-${arch === 'arm64' ? 'arm64' : 'x64'}/ContextSnapshot.exe`, import.meta.url));
  throw new Error('快照插件仅支持 macOS 与 Windows。');
}

export class NativeBridge {
  child = null;
  pending = new Map();
  disposed = false;
  starting = null;
  generation = 0;
  constructor(broker, options = {}) { this.broker = broker; this.options = options; }
  start() {
    if (this.child || this.disposed) return Promise.resolve();
    if (this.starting) return this.starting;
    try {
      const source = this.options.helperPath || helperPath();
      if (!existsSync(source)) throw new Error('未找到原生采集程序，请重新安装对应系统的 Release 安装包。');
      // An explicit helperPath remains an advanced override. The bundled Windows
      // helper always runs outside node_modules, including its worker processes.
      const prepare = this.options.prepareHelper ?? (!this.options.helperPath && process.platform === 'win32' ? prepareWindowsHelper : null);
      if (!prepare) { this.spawnHelper(source); return Promise.resolve(); }
      const generation = this.generation;
      this.broker.status = { ...this.broker.status, running: false, ready: false, error: '' };
      const task = Promise.resolve().then(() => prepare(source)).then(command => {
        if (!this.disposed && this.generation === generation) this.spawnHelper(command);
      }).catch(e => {
        if (!this.disposed && this.generation === generation) this.failStart(e);
      }).finally(() => { if (this.starting === task) this.starting = null; });
      this.starting = task;
      return task;
    } catch (e) { this.failStart(e); return Promise.resolve(); }
  }
  failStart(error) {
    this.broker.status.error = error.message;
    this.broker.status.running = false;
    this.broker.status.ready = false;
  }
  spawnHelper(command) {
    const child = (this.options.spawn ?? spawn)(command, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
    this.child = child;
    this.broker.status = { ...this.broker.status, running: true, ready: false, error: '' };
    const active = () => !this.disposed && this.child === child;
    const decoder = new LineDecoder(frame => { if (active()) this.frame(frame); }, e => { if (active()) this.broker.fail('', e.message); });
    child.stdout.on('data', chunk => decoder.push(chunk));
    // Native diagnostics do not contain screenshots or window text.
    child.stderr.on('data', () => {});
    const finish = message => {
      if (this.child !== child) return;
      this.child = null; this.broker.status.running = false; this.broker.status.ready = false;
      if (message) this.broker.fail('', message);
      for (const task of this.pending.values()) task.reject(new Error(message || '原生快照程序已退出。'));
      this.pending.clear();
    };
    child.on('error', e => finish(e.message));
    child.stdin.on('error', e => { finish(e.message); child.kill(); });
    child.on('close', () => finish(''));
  }
  frame(frame) {
    if (!frame || typeof frame !== 'object') return;
    if (frame.type === 'ready' && frame.protocol === 1) { this.broker.status.ready = true; return; }
    if (frame.type === 'trigger' && typeof frame.captureId === 'string') this.broker.trigger(frame.captureId);
    if (frame.type === 'capture' && typeof frame.captureId === 'string') this.broker.capture(frame.captureId, frame.capture);
    if (frame.type === 'error') this.broker.fail(frame.captureId ?? '', frame.error?.message ?? '截图失败');
    if (frame.type === 'result') {
      if (frame.ok && frame.permissions) this.broker.status.permissions = frame.permissions;
      const task = this.pending.get(frame.id);
      if (task) { this.pending.delete(frame.id); frame.ok ? task.resolve(frame.permissions ?? {}) : task.reject(new Error(frame.error?.message ?? '原生请求失败')); }
    }
  }
  async request(method) {
    const generation = this.generation;
    await this.start();
    if (this.disposed || generation !== this.generation) throw new Error('原生采集程序启动已取消，请重新检查状态。');
    if (!this.child?.stdin.writable) throw new Error(this.broker.status.error || '原生程序不可用');
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('原生权限检查超时，请检查系统设置。')); }, 8000);
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: e => { clearTimeout(timer); reject(e); } });
      try { this.child.stdin.write(JSON.stringify({ id, method }) + '\n'); }
      catch (e) { this.pending.get(id)?.reject(e); this.pending.delete(id); }
    });
  }
  restart() {
    this.generation++;
    this.starting = null;
    const child = this.child;
    if (child) { this.child = null; child.kill(); for (const task of this.pending.values()) task.reject(new Error('原生快照程序正在重启。')); this.pending.clear(); }
    return this.start();
  }
  dispose() {
    this.disposed = true;
    this.generation++;
    if (this.child) { const child = this.child; try { child.stdin.end(JSON.stringify({ id: randomUUID(), method: 'shutdown' }) + '\n'); } catch { child.kill(); } const timer = setTimeout(() => child.kill(), 1000); timer.unref(); child.once('close', () => clearTimeout(timer)); }
  }
}
