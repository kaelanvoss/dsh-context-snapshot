import test from 'node:test';
import assert from 'node:assert/strict';
import { setShortcutRecording } from '../src/shortcut-backend.mjs';

const ready = { ready: true, shortcutApiVersion: 1, shortcutRevision: 'revision', shortcut: { version: 1, codes: ['F8', 'F9'] }, supportedCodes: ['F8', 'F9'] };
function fixture(status) {
  const events = [];
  const recorder = { async update(owner, active) { events.push(['recording', owner, active]); } };
  const send = async body => { events.push(['request', body]); return { status }; };
  const onStatus = value => events.push(['status', value]);
  const update = active => setShortcutRecording(recorder, 'panel', active, send, onStatus);
  return { events, recorder, send, onStatus, update };
}

test('a live Host status handshake completes before the keyboard dispatcher can pause', async () => {
  const f = fixture(ready);
  await f.update(true);
  assert.deepEqual(f.events, [['request', { op: 'status' }], ['status', ready], ['recording', 'panel', true]]);
});

test('an older running Host is rejected with restart guidance without pausing Harness', async () => {
  const f = fixture({ running: true, ready: true, permissions: { inputMonitoring: true } });
  await assert.rejects(f.update(true), /完整退出并重新打开 Harness/);
  assert.deepEqual(f.events, [['request', { op: 'status' }]]);
});

test('previous shortcut-capable Hosts remain compatible while unknown API versions fail closed', async () => {
  const legacy = { ...ready }; delete legacy.shortcutApiVersion;
  const f = fixture(legacy);
  await f.update(true);
  assert.deepEqual(f.events.at(-1), ['recording', 'panel', true]);
  const future = fixture({ ...ready, shortcutApiVersion: 2 });
  await assert.rejects(future.update(true), /快照后台尚未加载快捷键设置/);
  assert.equal(future.events.length, 1);
});

test('an unready new Host and malformed responses do not pause the keyboard dispatcher', async () => {
  const f = fixture({ shortcutApiVersion: 1, ready: false });
  await assert.rejects(f.update(true), /采集程序尚未就绪/);
  assert.equal(f.events.some(x => x[0] === 'recording'), false);
  const malformed = fixture(null);
  await assert.rejects(malformed.update(true), /无法确认快照后台状态/);
  assert.equal(malformed.events.length, 1);
});

test('status transport failure never pauses Harness, while cancellation bypasses the handshake', async () => {
  const f = fixture(ready);
  const failedSend = async () => { throw new Error('Host unavailable'); };
  await assert.rejects(setShortcutRecording(f.recorder, 'panel', true, failedSend), /Host unavailable/);
  assert.deepEqual(f.events, []);
  await setShortcutRecording(f.recorder, 'panel', false, failedSend);
  assert.deepEqual(f.events, [['recording', 'panel', false]]);
});
