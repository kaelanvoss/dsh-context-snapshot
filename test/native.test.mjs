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
