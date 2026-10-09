import test from 'node:test';
import assert from 'node:assert/strict';
import { createShortcutRecording } from '../src/shortcut-recording.mjs';
const token = number => `10000000-0000-4000-8000-${String(number).padStart(12, '0')}`;

function fixture() {
  const harness = [], requests = [], faults = [], timers = new Map();
  const service = { async recording(active) { harness.push(active); } };
  const send = async body => { requests.push(body); if (faults.length) throw faults.shift(); return { status: { recording: body.active } }; };
  const recorder = createShortcutRecording(service, send, { id: 'window-one', schedule: fn => { const id = Symbol(); timers.set(id, fn); return id; }, cancel: id => timers.delete(id) });
  return { service, recorder, harness, requests, faults, timers };
}
function nativeFixture() {
  const requests = [], harness = [], timers = new Map();
  let state, count = 0, readFailure, endFailure;
  const service = { async recording(active) { harness.push(active); } };
  const send = async body => {
    requests.push(body);
    if (body.op === 'recording') { if (!body.active) state = null; return { status: { recording: body.active } }; }
    if (body.op === 'beginShortcutRecording') state = { token: body.token, state: 'waiting', current: [], peak: [] };
    if (body.op === 'shortcutRecordingState' && readFailure) throw readFailure;
    if (body.op === 'endShortcutRecording') { if (endFailure) { const error = endFailure; endFailure = null; throw error; } state = { token: body.token, state: 'ended', current: [], peak: [] }; }
    return { recordingState: state };
  };
  const recorder = createShortcutRecording(service, send, { id: 'window-one', randomUUID: () => token(++count), schedule: fn => { const id = Symbol(); timers.set(id, fn); return id; }, cancel: id => timers.delete(id) });
  return { recorder, requests, harness, timers, setState(value) { state = value; }, failRead(error) { readFailure = error; }, failEnd(error) { endFailure = error; } };
}

test('native recorder begins only after pause acknowledgement and gives every attempt a fresh token', async () => {
  const f = nativeFixture(), codes = ['ControlLeft', 'KeyK'];
  const first = await f.recorder.begin('panel', codes);
  assert.equal(first.token, token(1));
  assert.deepEqual(f.requests.map(item => item.op), ['recording', 'beginShortcutRecording']);
  const second = await f.recorder.begin('panel', codes);
  assert.equal(second.token, token(2));
  assert.deepEqual(f.requests.slice(-2).map(item => [item.op, item.token]), [['endShortcutRecording', token(1)], ['beginShortcutRecording', token(2)]]);
  await assert.rejects(f.recorder.read('panel', token(1)), /已失效/);
  f.setState({ token: token(2), state: 'complete', current: [], peak: codes });
  assert.deepEqual((await f.recorder.read('panel', token(2))).peak, codes);
  await f.recorder.update('panel', false);
  assert.deepEqual(f.requests.slice(-2).map(item => item.op), ['endShortcutRecording', 'recording']);
  assert.deepEqual(f.harness, [true, false]);
  await f.recorder.dispose();
});

test('one physical recorder cannot be read or replaced by another panel in the same window', async () => {
  const f = nativeFixture(), codes = ['KeyJ', 'KeyK'];
  await f.recorder.begin('first', codes);
  await assert.rejects(f.recorder.read('second', token(1)), /已失效/);
  await assert.rejects(f.recorder.begin('second', codes), /另一面板/);
  assert.equal(f.requests.filter(item => item.op === 'beginShortcutRecording').length, 1);
  await f.recorder.update('second', false);
  await f.recorder.dispose();
  assert.deepEqual(f.requests.slice(-2).map(item => item.op), ['endShortcutRecording', 'recording']);
  assert.equal(f.timers.size, 0);
});

test('malformed native peaks and read transport failures never turn into a DOM candidate', async () => {
  const f = nativeFixture(), codes = ['KeyJ', 'KeyK'];
  await f.recorder.begin('panel', codes);
  f.setState({ token: token(1), state: 'complete', current: [], peak: ['KeyJ', 'KeyJ'] });
  await assert.rejects(f.recorder.read('panel', token(1)), /按键无效/);
  f.failRead(new Error('Helper restarted'));
  await assert.rejects(f.recorder.read('panel', token(1)), /Helper restarted/);
  await f.recorder.dispose();
  await assert.rejects(f.recorder.begin('panel', codes), /已结束/);
});

test('a token retired by helper restart does not prevent a fresh owned recording', async () => {
  const f = nativeFixture(), codes = ['KeyJ', 'KeyK'];
  await f.recorder.begin('panel', codes);
  f.failEnd(new Error('录入连接已失效，请重新录入。'));
  const state = await f.recorder.begin('panel', codes);
  assert.equal(state.token, token(2));
  assert.equal(state.state, 'waiting');
  assert.equal(f.requests.at(-1).op, 'beginShortcutRecording');
  await f.recorder.dispose();
});
test('editing pauses Harness and native together, renews lease, and resumes on cancel', async () => {
  const f = fixture();
  await f.recorder.update('panel', true);
  assert.deepEqual(f.harness, [true]);
  assert.deepEqual(f.requests, [{ op: 'recording', recorderId: 'window-one', active: true }]);
  const heartbeat = [...f.timers.values()][0]; heartbeat();
  await f.recorder.update('panel', false);
  assert.deepEqual(f.harness, [true, false]);
  assert.deepEqual(f.requests.map(x => x.active), [true, true, false]);
  assert.equal(f.timers.size, 0);
  await f.recorder.dispose();
});
test('multiple controls in one window share a paused recorder until the last closes', async () => {
  const f = fixture();
  await f.recorder.update('first', true); await f.recorder.update('second', true);
  await f.recorder.update('first', false);
  assert.deepEqual(f.requests.map(x => x.active), [true]);
  assert.equal(f.timers.size, 1);
  await f.recorder.update('second', false);
  assert.deepEqual(f.requests.map(x => x.active), [true, false]);
  await f.recorder.dispose();
});
test('a failed native pause restores Harness interception before permitting another attempt', async () => {
  const f = fixture(); f.faults.push(new Error('Pause failed'));
  await assert.rejects(f.recorder.update('panel', true), /Pause failed/);
  assert.deepEqual(f.harness, [true, false]);
  assert.deepEqual(f.requests.map(x => x.active), [true, false]);
  assert.equal(f.timers.size, 0);
  await f.recorder.update('panel', true); await f.recorder.update('panel', false);
  await f.recorder.dispose();
});
test('failed native pause and rollback still restore Harness and retain cleanup for retry', async () => {
  const f = fixture(), failure = new Error('Pause failed');
  f.faults.push(failure, new Error('Rollback failed'));
  await assert.rejects(f.recorder.update('panel', true), error => error === failure);
  assert.deepEqual(f.harness, [true, false]);
  assert.deepEqual(f.requests.map(x => x.active), [true, false]);
  assert.equal(f.timers.size, 0, 'an unconfirmed pause never starts a recording lease heartbeat');
  await f.recorder.update('panel', false);
  assert.deepEqual(f.requests.map(x => x.active), [true, false, false]);
  assert.deepEqual(f.harness, [true, false, false]);
  await f.recorder.update('panel', false);
  await f.recorder.dispose();
  assert.equal(f.requests.length, 3, 'confirmed cleanup removes the retained owner');
});
test('failed Harness rollback is retryable without replacing the original pause failure', async () => {
  const f = fixture(), failure = new Error('Original pause failure');
  f.faults.push(failure, new Error('Native rollback failure'));
  let resumes = 0;
  f.service.recording = async active => {
    f.harness.push(active);
    if (!active && ++resumes === 1) throw new Error('Harness rollback failure');
  };
  await assert.rejects(f.recorder.update('panel', true), error => error === failure);
  assert.deepEqual(f.harness, [true, false]);
  assert.equal(f.timers.size, 0);
  await f.recorder.update('panel', false);
  assert.deepEqual(f.harness, [true, false, false]);
  assert.deepEqual(f.requests.map(x => x.active), [true, false, false]);
  await f.recorder.update('panel', true);
  assert.equal(f.timers.size, 1, 'a clean retry can enter recording normally');
  await f.recorder.update('panel', false);
  await f.recorder.dispose();
});
test('a failed native resume remains retryable and does not keep renewing a closed panel', async () => {
  const f = fixture(); await f.recorder.update('panel', true);
  f.faults.push(new Error('Resume failed'));
  await assert.rejects(f.recorder.update('panel', false), /Resume failed/);
  assert.equal(f.timers.size, 0);
  await f.recorder.update('panel', false);
  assert.deepEqual(f.requests.map(x => x.active), [true, false, false]);
  assert.deepEqual(f.harness, [true, false, false]);
  await f.recorder.dispose();
});
test('a failed Harness resume can be retried even after native acknowledged it', async () => {
  const f = fixture(); await f.recorder.update('panel', true);
  let failure = true;
  f.service.recording = async active => { if (!active && failure) { failure = false; throw new Error('Harness resume failed'); } };
  await assert.rejects(f.recorder.update('panel', false), /Harness resume failed/);
  await f.recorder.update('panel', false);
  assert.deepEqual(f.requests.map(x => x.active), [true, false, false]);
  await f.recorder.dispose();
});
test('simultaneous native and Harness resume failures preserve the first error and remain retryable', async () => {
  const f = fixture(); await f.recorder.update('panel', true);
  const failure = new Error('Native resume failure');
  f.faults.push(failure);
  let resumes = 0;
  f.service.recording = async active => {
    f.harness.push(active);
    if (!active && ++resumes === 1) throw new Error('Harness resume failure');
  };
  await assert.rejects(f.recorder.update('panel', false), error => error === failure);
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.harness, [true, false]);
  await f.recorder.update('panel', false);
  assert.deepEqual(f.harness, [true, false, false]);
  assert.deepEqual(f.requests.map(x => x.active), [true, false, false]);
  await f.recorder.dispose();
});
test('cancel queued behind an unfinished pause resumes after it completes', async () => {
  const f = fixture(); let release;
  f.service.recording = active => active ? new Promise(resolve => { release = resolve; }) : Promise.resolve();
  const pause = f.recorder.update('panel', true);
  const cancel = f.recorder.update('panel', false);
  await Promise.resolve(); release();
  await Promise.all([pause, cancel]);
  assert.deepEqual(f.requests.map(x => x.active), [true, false]);
  assert.equal(f.timers.size, 0);
  await f.recorder.dispose();
});
test('unload releases active recorders and prevents new recording', async () => {
  const f = fixture(); await f.recorder.update('panel', true); await f.recorder.dispose();
  assert.deepEqual(f.requests.map(x => x.active), [true, false]);
  assert.equal(f.timers.size, 0);
  await assert.rejects(f.recorder.update('new-panel', true), /已结束/);
});

test('heartbeat failure immediately invalidates recording and requires a fresh pause ACK', async () => {
  const f = fixture(), errors = [];
  const off = f.recorder.subscribe(() => errors.push(f.recorder.getError()));
  await f.recorder.update('panel', true);
  const heartbeat = [...f.timers.values()][0];
  f.faults.push(new Error('Connection lost'));
  heartbeat(); await new Promise(resolve => setImmediate(resolve));
  assert.match(f.recorder.getError(), /Connection lost/);
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.requests.map(x => x.active), [true, true, false]);
  assert.deepEqual(f.harness, [true, false]);
  await f.recorder.update('panel', true);
  assert.equal(f.recorder.getError(), '');
  assert.deepEqual(f.harness, [true, false, true]);
  assert.equal(f.timers.size, 1);
  assert.ok(errors.some(x => x.includes('Connection lost')));
  off(); await f.recorder.dispose();
});
