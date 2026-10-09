import test from 'node:test';
import assert from 'node:assert/strict';
import { validRecordingToken, validateNativeRecordingState } from '../src/shortcut-native-state.mjs';
import { watchNativeRecording } from '../src/native-recording-poll.mjs';

const token = '10000000-0000-4000-8000-000000000001';
const codes = ['MetaLeft', 'ShiftLeft', 'KeyJ', 'KeyK'];
const pair = ['KeyJ', 'KeyK'];
const frame = (state, current = [], peak = []) => ({ token, state, current, peak });

test('native candidates require exact fresh identity and known unique physical keys', () => {
  assert.equal(validRecordingToken(token), true);
  assert.equal(validRecordingToken('old-recorder'), false);
  assert.deepEqual(validateNativeRecordingState(frame('complete', [], pair), token, codes), frame('complete', [], pair));
  assert.deepEqual(validateNativeRecordingState(frame('too_many'), token, codes), frame('too_many'));
  for (const invalid of [frame('complete', [], ['KeyJ', 'KeyJ']), frame('holding', ['KeyJ'], ['KeyK']), frame('complete', ['KeyJ'], pair), frame('expired', [], pair), frame('too_many', [], pair), frame('complete', [], codes), frame('holding', codes, codes), { ...frame('waiting'), text: 'keylog' }, { ...frame('waiting'), token: '10000000-0000-4000-8000-000000000002' }, frame('complete', [], ['KeyZ'])]) {
    assert.throws(() => validateNativeRecordingState(invalid, token, codes), /原生录入/);
  }
});

test('poll consumes a retained two-key peak even when the physical press finished between reads', async () => {
  const timers = new Map(), received = [], errors = [];
  let next = 0, calls = 0;
  const stop = watchNativeRecording(async () => ++calls === 1 ? frame('waiting') : frame('complete', [], pair), token,
    state => received.push(state), error => errors.push(error),
    { schedule(callback) { timers.set(++next, callback); return next; }, cancel(id) { timers.delete(id); } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(timers.size, 1);
  const [id, callback] = [...timers][0]; timers.delete(id); await callback();
  assert.deepEqual(received, [frame('waiting'), frame('complete', [], pair)]);
  assert.equal(timers.size, 0, 'complete freezes the candidate and stops polling');
  assert.deepEqual(errors, []);
  stop();
});

test('too_many clears the candidate and terminates native polling', async () => {
  const received = [], errors = [];
  const stop = watchNativeRecording(async () => frame('too_many'), token, state => received.push(state), error => errors.push(error),
    { schedule() { assert.fail('a rejected third key must not continue polling'); } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(received, [frame('too_many')]); assert.deepEqual(errors, []); stop();
});

test('old polling responses cannot replace a new recording or revive an unmounted control', async () => {
  let resolve, current = true;
  const received = [], errors = [];
  const stop = watchNativeRecording(() => new Promise(done => { resolve = done; }), token,
    value => received.push(value), error => errors.push(error), { isCurrent: () => current });
  current = false; stop(); resolve(frame('complete', [], pair));
  await new Promise(done => setImmediate(done));
  assert.deepEqual(received, []); assert.deepEqual(errors, []);
});
