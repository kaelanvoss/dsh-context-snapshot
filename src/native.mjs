import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { LineDecoder } from './protocol.mjs';

export function helperPath(platform = process.platform, arch = process.arch) {
  if (platform === 'darwin') return fileURLToPath(new URL('../native/macos/build/ContextSnapshot.app/Contents/MacOS/ContextSnapshot', import.meta.url));
  if (platform === 'win32') return fileURLToPath(new URL(`../native/windows/publish/win-${arch === 'arm64' ? 'arm64' : 'x64'}/ContextSnapshot.exe`, import.meta.url));
  throw new Error('快照插件仅支持 macOS 与 Windows。');
}

export class NativeBridge {
  child = null;
  pending = new Map();
  disposed = false;
  constructor(broker, options = {}) { this.broker = broker; this.options = options; }
  start() {
    if (this.child || this.disposed) return;
    try {
      const command = this.options.helperPath || helperPath();
      if (!existsSync(command)) throw new Error('未找到原生快照程序，请先按 README 构建当前平台的 helper。');
      const child = (this.options.spawn ?? spawn)(command, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
      this.child = child;
      this.broker.status = { ...this.broker.status, running: true, ready: false, error: '' };
      const decoder = new LineDecoder(frame => this.frame(frame), e => this.broker.fail('', e.message));
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
    } catch (e) { this.broker.status.error = e.message; this.broker.status.running = false; }
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
  request(method) {
    this.start();
    if (!this.child?.stdin.writable) return Promise.reject(new Error(this.broker.status.error || '原生程序不可用'));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('原生权限检查超时，请检查系统设置。')); }, 8000);
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: e => { clearTimeout(timer); reject(e); } });
      try { this.child.stdin.write(JSON.stringify({ id, method }) + '\n'); }
      catch (e) { this.pending.get(id)?.reject(e); this.pending.delete(id); }
    });
  }
  restart() {
    const child = this.child;
    if (child) { this.child = null; child.kill(); for (const task of this.pending.values()) task.reject(new Error('原生快照程序正在重启。')); this.pending.clear(); }
    this.start();
  }
  dispose() {
    this.disposed = true;
    if (this.child) { const child = this.child; try { child.stdin.end(JSON.stringify({ id: randomUUID(), method: 'shutdown' }) + '\n'); } catch { child.kill(); } const timer = setTimeout(() => child.kill(), 1000); timer.unref(); }
  }
}
