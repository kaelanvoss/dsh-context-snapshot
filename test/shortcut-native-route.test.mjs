import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../src/index.mjs';

const token = '10000000-0000-4000-8000-000000000001';
const frame = { token, state: 'waiting', current: [], peak: [] };
function fixture() {
  const calls = [], broker = { status: { supportsShortcutRecording: true } };
  const settings = Object.fromEntries(['beginRecording', 'recordingState', 'endRecording', 'save'].map(method => [method, async (...args) => { calls.push([method, ...args]); return frame; }]));
  const handler = createHandler(broker, {}, settings);
  const send = async body => handler(new Request('http://localhost/api/context-snapshot', { method: 'POST', body: JSON.stringify(body) }));
  return { calls, broker, send };
}

test('native recording operations route exact window and token identities without draft fields', async () => {
  const f = fixture();
  for (const op of ['beginShortcutRecording', 'shortcutRecordingState', 'endShortcutRecording']) {
    const response = await f.send({ op, recorderId: 'window-one', token });
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { recordingState: frame });
  }
  assert.deepEqual(f.calls, [['beginRecording', 'window-one', token], ['recordingState', 'window-one', token], ['endRecording', 'window-one', token]]);
  assert.equal(f.broker.status.shortcutRecordingApiVersion, 1);
});

test('malformed native identities and unbound modern saves cannot reach the helper', async () => {
  const f = fixture(), shortcut = { version: 1, codes: ['KeyJ', 'KeyK'] };
  for (const body of [{ op: 'beginShortcutRecording', recorderId: 'window-one', token: 'old-token' }, { op: 'shortcutRecordingState', token }, { op: 'setShortcut', revision: 'revision', shortcut }]) {
    assert.equal((await f.send(body)).status, 400);
  }
  assert.deepEqual(f.calls, []);
  assert.equal((await f.send({ op: 'setShortcut', revision: 'revision', shortcut, recorderId: 'window-one', token })).status, 200);
  assert.deepEqual(f.calls[0], ['save', shortcut, 'revision', { owner: 'window-one', token, reset: false }]);
});
