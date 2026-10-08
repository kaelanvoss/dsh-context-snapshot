import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { NativeBridge } from '../src/native.mjs';
import { SnapshotBroker } from '../src/broker.mjs';

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
