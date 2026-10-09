import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { NativeBridge } from '../src/native.mjs';
import { SnapshotBroker } from '../src/broker.mjs';
import { ShortcutSettings } from '../src/shortcut-settings.mjs';
import { defaultShortcut, normalizeShortcut, supportedShortcutCodes } from '../src/shortcuts.mjs';
import { createHandler } from '../src/index.mjs';

function childFixture() {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.kill = () => { child.emit('close'); };
  return child;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

test('spawn failure clears readiness and permits an explicit restart', () => {
  const broker = new SnapshotBroker(), first = childFixture(), second = childFixture();
  let starts = 0;
  const native = new NativeBridge(broker, { helperPath: fileURLToPath(import.meta.url), spawn: () => ++starts === 1 ? first : second });
  native.start();
  first.emit('error', new Error('EACCES'));
  assert.equal(native.child, null);
  assert.equal(broker.status.running, false);
  native.start();
  assert.equal(native.child, second);
  second.stdout.write('{"type":"ready","protocol":1,"platform":"darwin"}\n');
  assert.equal(broker.status.ready, true);
  second.emit('close');
  native.dispose();
});

test('stdin EPIPE rejects outstanding requests without an unhandled stream error', async () => {
  const broker = new SnapshotBroker(), child = childFixture();
  const native = new NativeBridge(broker, { helperPath: fileURLToPath(import.meta.url), spawn: () => child });
  const pending = native.request('permissions');
  const rejected = assert.rejects(pending, /EPIPE/);
  child.stdin.emit('error', new Error('EPIPE'));
  await rejected;
  assert.equal(native.pending.size, 0);
  assert.equal(broker.status.running, false);
  native.dispose();
});

test('native request errors preserve a bounded protocol code for safe retry decisions', async () => {
  const child = childFixture(); let attempt = 0;
  child.stdin.on('data', chunk => {
    const request = JSON.parse(chunk.toString());
    if (request.method === 'shutdown') return;
    child.stdout.write(JSON.stringify({ type: 'result', id: request.id, ok: false, error: {
      code: ++attempt === 1 ? 'KEYS_ALREADY_HELD' : 'KEYS_ALREADY_HELD\nunsafe', message: 'Release all keys',
    } }) + '\n');
  });
  const native = new NativeBridge(new SnapshotBroker(), { helperPath: fileURLToPath(import.meta.url), spawn: () => child });
  await assert.rejects(native.request('beginShortcutRecording'), error => error.code === 'KEYS_ALREADY_HELD' && error.message === 'Release all keys');
  await assert.rejects(native.request('beginShortcutRecording'), error => error.code === undefined && error.message === 'Release all keys');
  child.emit('close'); native.dispose();
});

test('concurrent starts prepare one cached helper and spawn only the cached path', async () => {
  const preparation = deferred(), broker = new SnapshotBroker(), child = childFixture();
  const commands = []; let prepares = 0;
  const native = new NativeBridge(broker, {
    helperPath: fileURLToPath(import.meta.url),
    prepareHelper: () => { prepares++; return preparation.promise; },
    spawn: command => { commands.push(command); return child; },
  });
  const first = native.start(), second = native.start();
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(prepares, 1);
  assert.equal(native.child, null);
  preparation.resolve('cached/ContextSnapshot.exe');
  await first;
  assert.deepEqual(commands, ['cached/ContextSnapshot.exe']);
  child.emit('close'); native.dispose();
});

test('unloading during cache preparation cannot start a late helper', async () => {
  const preparation = deferred(), broker = new SnapshotBroker(); let starts = 0;
  const native = new NativeBridge(broker, {
    helperPath: fileURLToPath(import.meta.url), prepareHelper: () => preparation.promise,
    spawn: () => { starts++; return childFixture(); },
  });
  const pending = native.request('permissions');
  const rejected = assert.rejects(pending, /启动已取消/);
  native.dispose();
  preparation.resolve('cached/ContextSnapshot.exe');
  await rejected;
  assert.equal(starts, 0);
  assert.equal(native.pending.size, 0);
});

test('restart supersedes an unfinished preparation without letting it spawn later', async () => {
  const old = deferred(), fresh = deferred(), child = childFixture(), commands = [];
  let prepares = 0;
  const native = new NativeBridge(new SnapshotBroker(), {
    helperPath: fileURLToPath(import.meta.url), prepareHelper: () => (++prepares === 1 ? old : fresh).promise,
    spawn: command => { commands.push(command); return child; },
  });
  const previous = native.start();
  await Promise.resolve();
  const restarted = native.restart();
  await Promise.resolve();
  fresh.resolve('fresh/ContextSnapshot.exe');
  await restarted;
  old.resolve('old/ContextSnapshot.exe');
  await previous;
  assert.deepEqual(commands, ['fresh/ContextSnapshot.exe']);
  assert.equal(native.child, child);
  child.emit('close'); native.dispose();
});

test('cache preparation failure is visible and never falls back to the package executable', async () => {
  const broker = new SnapshotBroker(); let starts = 0;
  const native = new NativeBridge(broker, {
    helperPath: fileURLToPath(import.meta.url),
    prepareHelper: async () => { throw new Error('cache copy denied'); },
    spawn: () => { starts++; return childFixture(); },
  });
  await assert.rejects(native.request('permissions'), /cache copy denied/);
  assert.equal(starts, 0);
  assert.equal(broker.status.ready, false);
  assert.equal(broker.status.running, false);
  assert.equal(broker.status.error, 'cache copy denied');
  native.dispose();
});

test('permissions requests wait for preparation before writing to the cached helper', async () => {
  const preparation = deferred(), child = childFixture(); let request;
  child.stdin.on('data', chunk => {
    request = JSON.parse(chunk.toString());
    child.stdout.write(JSON.stringify({ type: 'result', id: request.id, ok: true, permissions: { screenRecording: true } }) + '\n');
  });
  const native = new NativeBridge(new SnapshotBroker(), {
    helperPath: fileURLToPath(import.meta.url), prepareHelper: () => preparation.promise, spawn: () => child,
  });
  const pending = native.request('permissions');
  await Promise.resolve();
  assert.equal(request, undefined);
  preparation.resolve('cached/ContextSnapshot.exe');
  assert.deepEqual(await pending, { screenRecording: true });
  assert.equal(request.method, 'permissions');
  child.emit('close'); native.dispose();
});

test('buffered frames from replaced or disposed helpers cannot affect the active broker', async () => {
  const preparation = deferred(), broker = new SnapshotBroker(), old = childFixture(), fresh = childFixture();
  let prepares = 0, starts = 0;
  const native = new NativeBridge(broker, {
    helperPath: fileURLToPath(import.meta.url),
    prepareHelper: () => ++prepares === 1 ? Promise.resolve('old/ContextSnapshot.exe') : preparation.promise,
    spawn: () => ++starts === 1 ? old : fresh,
  });
  await native.start();
  old.stdout.write('{"type":"ready","protocol":1}\n');
  assert.equal(broker.status.ready, true);
  const restarting = native.restart();
  const preparingStatus = { ...broker.status };
  old.stdout.write('{"type":"ready","protocol":1}\n{"type":"error","error":{"message":"stale failure"}}\n{"type":"trigger","captureId":"stale"}\ninvalid-json\n');
  assert.deepEqual(broker.status, preparingStatus);
  assert.equal(broker.items.size, 0);
  preparation.resolve('fresh/ContextSnapshot.exe');
  await restarting;
  native.dispose();
  const disposedStatus = { ...broker.status };
  fresh.stdout.write('{"type":"ready","protocol":1}\n{"type":"trigger","captureId":"disposed"}\ninvalid-json\n');
  assert.deepEqual(broker.status, disposedStatus);
  assert.equal(broker.items.size, 0);
  fresh.emit('close');
});

function configuredFixture({ holdApply = false } = {}) {
  const broker = new SnapshotBroker(), children = [], commands = [], release = deferred();
  let saved = { version: 1, codes: ['AltRight', 'KeyS'] };
  const native = new NativeBridge(broker, { helperPath: fileURLToPath(import.meta.url), spawn: () => {
    const child = childFixture(); children.push(child);
    child.stdin.on('data', chunk => {
      const frame = JSON.parse(chunk.toString()); commands.push(frame);
      const reply = () => child.stdout.write(JSON.stringify({ type: 'result', id: frame.id, ok: true,
        ...(frame.method === 'setShortcut' ? { shortcut: frame.shortcut } : frame.method === 'setRecording' ? { recording: frame.active } : { permissions: { inputMonitoring: true } }) }) + '\n');
      if (holdApply && frame.method === 'setShortcut') void release.promise.then(reply); else reply();
    });
    queueMicrotask(() => child.stdout.write(JSON.stringify({ type: 'ready', protocol: 1, ready: true, recording: true, shortcut: defaultShortcut(), supportedCodes: supportedShortcutCodes() }) + '\n'));
    return child;
  } });
  const settings = new ShortcutSettings(native, broker, { platform: 'darwin', store: { async load() { return saved; }, async save(value) { saved = value; } } });
  return { broker, native, settings, children, commands, release, get saved() { return saved; }, dispose() { settings.dispose(); native.stop(); native.dispose(); } };
}

test('native handshake applies saved settings before readiness and fences early capture frames', async t => {
  const f = configuredFixture({ holdApply: true }); t.after(() => f.dispose());
  await f.native.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.broker.status.ready, false);
  f.broker.poll('client', 'session', true);
  f.children[0].stdout.write('{"type":"trigger","captureId":"too-early"}\n');
  assert.equal(f.broker.items.size, 0);
  f.release.resolve(); await f.native.waitReady();
  assert.equal(f.broker.status.ready, true);
  assert.deepEqual(f.broker.status.shortcut.codes, ['AltRight', 'KeyS']);
  assert.deepEqual(f.commands.map(x => x.method), ['setRecording', 'setShortcut', 'setRecording']);
  f.children[0].stdout.write('{"type":"trigger","captureId":"confirmed"}\n');
  assert.equal(f.broker.items.size, 1);
});

test('authenticated host configuration route saves valid chords and reapplies them on restart', async t => {
  const f = configuredFixture(); t.after(() => f.dispose()); await f.native.waitReady();
  const handler = createHandler(f.broker, f.native, f.settings);
  const call = body => handler(new Request('https://fixture/api/context-snapshot', { method: 'POST', body: JSON.stringify(body) }));
  const single = await call({ op: 'setShortcut', revision: f.broker.status.shortcutRevision, shortcut: { version: 1, codes: ['F8'] } });
  assert.equal(single.status, 400);
  const chord = normalizeShortcut({ version: 1, codes: ['F9', 'F8'] });
  const response = await call({ op: 'setShortcut', revision: f.broker.status.shortcutRevision, shortcut: chord });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).status.shortcut, chord);
  assert.deepEqual(f.saved, chord);
  await f.native.restart(); await f.native.waitReady();
  assert.equal(f.children.length, 2);
  assert.deepEqual(f.broker.status.shortcut, chord);
  assert.equal((await call({ op: 'recording', recorderId: 'editor', active: true })).status, 200);
  assert.equal(f.broker.status.recording, true);
  assert.equal((await call({ op: 'recording', recorderId: 'editor', active: false })).status, 200);
  assert.equal(f.broker.status.recording, false);
});

test('a helper with an unavailable keyboard tap never reports a configured ready state', async t => {
  const broker = new SnapshotBroker(), child = childFixture();
  const native = new NativeBridge(broker, { helperPath: fileURLToPath(import.meta.url), spawn: () => child });
  t.after(() => { native.stop(); native.dispose(); });
  await native.start(); child.stdout.write('{"type":"ready","protocol":1,"ready":false}\n');
  await assert.rejects(native.waitReady(), /监听尚未就绪/);
  assert.equal(broker.status.ready, false);
});

test('a ready frame queued before restart cannot initialize the replacement helper', async t => {
  const first = childFixture(), second = childFixture(), calls = [];
  let count = 0;
  const native = new NativeBridge(new SnapshotBroker(), { helperPath: fileURLToPath(import.meta.url), spawn: () => ++count === 1 ? first : second,
    onReady: async frame => { calls.push(frame.marker); } });
  t.after(() => { native.stop(); native.dispose(); });
  await native.start();
  first.stdout.write('{"type":"ready","protocol":1,"marker":"old"}\n');
  await native.restart();
  second.stdout.write('{"type":"ready","protocol":1,"marker":"new"}\n');
  await native.waitReady();
  assert.deepEqual(calls, ['new']);
});
