import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShortcutFileStore, ShortcutSettings, shortcutSettingsPath } from '../src/shortcut-settings.mjs';
import { defaultShortcut, normalizeShortcut, supportedShortcutCodes } from '../src/shortcuts.mjs';

const shortcut = (...codes) => normalizeShortcut({ version: 1, codes });
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const recordingToken = number => `10000000-0000-4000-8000-${String(number).padStart(12, '0')}`;

async function fixture(options = {}) {
  const broker = { status: {} };
  let now = 1_000, nextTimer = 0;
  const timers = new Map(), calls = [], faults = [], stopped = [];
  const store = {
    value: clone(options.stored), writes: [], failure: null,
    async load() { if (options.loadFailure) throw options.loadFailure; return clone(this.value); },
    async save(value) { if (this.failure) throw this.failure; this.value = clone(value); this.writes.push(clone(value)); },
  };
  const native = {
    options: {}, child: null, shortcut: defaultShortcut(), paused: false, recordingState: null,
    async waitReady() { if (!broker.status.ready || !this.child) throw new Error('Helper not ready'); },
    async request(method, params) {
      calls.push({ method, ...clone(params) });
      if (!this.child) throw new Error('Helper stopped');
      if (method === 'setShortcut') this.shortcut = clone(params.shortcut);
      else if (method === 'setRecording') { this.paused = params.active; if (!params.active) this.recordingState = null; }
      else if (method === 'beginShortcutRecording' && options.nativeRecording) this.recordingState = { token: params.token, state: 'waiting', current: [], peak: [] };
      else if (method === 'shortcutRecordingState' && options.nativeRecording) { if (this.recordingState?.token !== params.token) throw new Error('Invalid native token'); }
      else if (method === 'endShortcutRecording' && options.nativeRecording) this.recordingState = { token: params.token, state: 'ended', current: [], peak: [] };
      else throw new Error('Unexpected request');
      const fault = faults[0]?.method === method ? faults.shift() : null;
      if (fault?.gate) await fault.gate;
      if (fault?.error) throw fault.error;
      return fault?.reply ?? (method === 'setShortcut' ? { shortcut: clone(this.shortcut) } : method === 'setRecording' ? { recording: this.paused } : { recordingState: clone(this.recordingState) });
    },
    stop(message) { stopped.push(message); this.child = null; broker.status.ready = false; },
    async restart(frame = {}) {
      this.child = {}; this.shortcut = defaultShortcut(); this.paused = false; this.recordingState = null; broker.status.ready = false;
      await this.options.onReady({ supportedCodes: supportedShortcutCodes(), shortcut: clone(this.shortcut), supportsShortcutRecording: options.nativeRecording === true, ...frame });
      broker.status.ready = true;
    },
  };
  const settings = new ShortcutSettings(native, broker, {
    platform: 'darwin', store, now: () => now,
    schedule(callback, delay) { const token = { id: ++nextTimer, unref() {} }; timers.set(token.id, { callback, at: now + delay }); return token; },
    cancel(token) { timers.delete(token.id); },
  });
  if (!options.skipBoot) await native.restart();
  async function advance(milliseconds) {
    now += milliseconds;
    for (let remaining = 20; remaining > 0; remaining -= 1) {
      const due = [...timers].filter(([, value]) => value.at <= now);
      if (!due.length) return;
      for (const [id, value] of due) { timers.delete(id); value.callback(); }
      await settings.queue;
    }
    throw new Error('Unexpected timer loop');
  }
  return { broker, native, settings, store, calls, faults, stopped, timers, advance };
}

test('native recording requires a paused owner, fresh token and exact ownership for every operation', async t => {
  const f = await fixture({ nativeRecording: true }); t.after(() => f.settings.dispose());
  const token = recordingToken(1);
  await assert.rejects(f.settings.beginRecording('window-a', token), /已暂停/);
  await f.settings.recording('window-a', true);
  assert.deepEqual(await f.settings.beginRecording('window-a', token), { token, state: 'waiting', current: [], peak: [] });
  await f.settings.recording('window-b', true);
  await assert.rejects(f.settings.beginRecording('window-b', recordingToken(2)), /另一窗口/);
  await assert.rejects(f.settings.recordingState('window-b', token), /已失效/);
  await assert.rejects(f.settings.endRecording('window-b', token), /已失效/);
  assert.deepEqual(await f.settings.endRecording('window-a', token), { token, state: 'ended', current: [], peak: [] });
  await assert.rejects(f.settings.beginRecording('window-a', token), /标识已失效/);
  await f.settings.beginRecording('window-b', recordingToken(2));
  await f.settings.recording('window-b', false);
  assert.equal(f.settings.nativeRecording, null);
  assert.ok(f.calls.some(call => call.method === 'endShortcutRecording' && call.token === recordingToken(2)));
});

test('waiting capture expires after 15 seconds even if the pause owner keeps renewing', async t => {
  const f = await fixture({ nativeRecording: true }); t.after(() => f.settings.dispose());
  const token = recordingToken(1);
  await f.settings.recording('window-a', true); await f.settings.beginRecording('window-a', token);
  await f.advance(10_000); await f.settings.recording('window-a', true); await f.advance(5_000);
  assert.deepEqual(await f.settings.recordingState('window-a', token), { token, state: 'expired', current: [], peak: [] });
  await assert.rejects(f.settings.save(shortcut('KeyJ', 'KeyK'), f.settings.revision, { owner: 'window-a', token }), /尚未完整确认/);
  assert.equal(f.store.writes.length, 0);
});

test('completed physical peak remains reviewable and is rechecked before saving', async t => {
  const f = await fixture({ nativeRecording: true }); t.after(() => f.settings.dispose());
  const token = recordingToken(1), peak = ['ControlLeft', 'KeyK'];
  await f.settings.recording('window-a', true); await f.settings.beginRecording('window-a', token);
  f.native.recordingState = { token, state: 'complete', current: [], peak };
  await f.advance(10_000); await f.settings.recording('window-a', true); await f.advance(10_000);
  assert.equal((await f.settings.recordingState('window-a', token)).state, 'complete');
  await assert.rejects(f.settings.save(shortcut('ControlLeft', 'ShiftLeft'), f.settings.revision, { owner: 'window-a', token }), /本次原生录入不一致/);
  assert.equal(f.store.writes.length, 0);
  await f.settings.save(shortcut(...peak), f.settings.revision, { owner: 'window-a', token });
  assert.deepEqual(f.store.value, shortcut(...peak));
});

test('restart invalidates a completed token and default reset requires an owned pause', async t => {
  const f = await fixture({ nativeRecording: true }); t.after(() => f.settings.dispose());
  const token = recordingToken(1);
  await f.settings.recording('window-a', true); await f.settings.beginRecording('window-a', token);
  f.native.recordingState = { token, state: 'complete', current: [], peak: ['KeyJ', 'KeyK'] };
  await f.native.restart();
  await assert.rejects(f.settings.save(shortcut('KeyJ', 'KeyK'), f.settings.revision, { owner: 'window-a', token }), /已失效/);
  await assert.rejects(f.settings.save(defaultShortcut(), f.settings.revision, { owner: 'window-b', reset: true }), /已失效/);
  await f.settings.save(defaultShortcut(), f.settings.revision, { owner: 'window-a', reset: true });
  assert.deepEqual(f.store.value, defaultShortcut());
});

test('malformed or foreign native recording state is rejected before it reaches the UI', async t => {
  const f = await fixture({ nativeRecording: true }); t.after(() => f.settings.dispose());
  const token = recordingToken(1);
  await f.settings.recording('window-a', true); await f.settings.beginRecording('window-a', token);
  f.native.recordingState = { token, state: 'complete', current: [], peak: ['KeyJ', 'KeyJ'] };
  await assert.rejects(f.settings.recordingState('window-a', token), /按键无效/);
  f.native.recordingState = { token, state: 'complete', current: [], peak: ['KeyJ', 'KeyK'] };
  f.faults.push({ method: 'shortcutRecordingState', reply: { recordingState: { ...f.native.recordingState, token: recordingToken(2) } } });
  await assert.rejects(f.settings.recordingState('window-a', token), /状态未确认/);
});

test('an uncertain native end stops collection and retains identity until a confirmed restart', async t => {
  const f = await fixture({ nativeRecording: true }); t.after(() => f.settings.dispose());
  const token = recordingToken(1);
  await f.settings.recording('window-a', true); await f.settings.beginRecording('window-a', token);
  f.faults.push({ method: 'endShortcutRecording', error: new Error('End ACK lost') });
  await assert.rejects(f.settings.endRecording('window-a', token), /End ACK lost/);
  assert.equal(f.native.child, null);
  assert.equal(f.settings.nativeRecording.token, token);
  assert.match(f.stopped.at(-1), /清理未确认/);
  await f.native.restart();
  assert.equal(f.settings.nativeRecording, null);
  assert.equal((await f.settings.beginRecording('window-a', recordingToken(2))).state, 'waiting');
});

test('an explicitly rejected begin creates no recorder and allows a fresh retry without restarting', async t => {
  const f = await fixture({ nativeRecording: true }); t.after(() => f.settings.dispose());
  await f.settings.recording('window-a', true);
  const request = f.native.request.bind(f.native); let rejected = false;
  f.native.request = async (method, params) => {
    if (method === 'beginShortcutRecording' && !rejected) {
      rejected = true; f.calls.push({ method, ...clone(params) });
      throw Object.assign(new Error('Keys already held'), { code: 'KEYS_ALREADY_HELD' });
    }
    return request(method, params);
  };
  await assert.rejects(f.settings.beginRecording('window-a', recordingToken(1)), /先松开所有按键/);
  assert.equal(f.settings.nativeRecording, null);
  assert.equal(f.native.recordingState, null);
  assert.equal(f.stopped.length, 0);
  assert.equal(f.calls.filter(call => call.method === 'endShortcutRecording').length, 0);
  assert.equal((await f.settings.beginRecording('window-a', recordingToken(2))).state, 'waiting');
});

test('device preferences apply before readiness and survive native restart', async t => {
  const saved = shortcut('AltRight', 'KeyS');
  const f = await fixture({ stored: saved }); t.after(() => f.settings.dispose());
  assert.deepEqual(f.calls.slice(0, 3), [
    { method: 'setRecording', active: true }, { method: 'setShortcut', shortcut: saved }, { method: 'setRecording', active: false },
  ]);
  assert.deepEqual(f.native.shortcut, saved);
  await f.settings.save(shortcut('F8', 'F9'), f.settings.revision);
  const revision = f.settings.revision;
  await f.native.restart();
  assert.deepEqual(f.native.shortcut, shortcut('F8', 'F9'));
  assert.deepEqual(f.store.value, f.native.shortcut);
  assert.equal(f.settings.revision, revision);
  assert.equal(f.native.paused, false);
});

test('a delayed native ACK cannot persist or report a shortcut early', async t => {
  const f = await fixture(); t.after(() => f.settings.dispose());
  const gate = deferred(), previous = clone(f.broker.status.shortcut), revision = f.settings.revision;
  f.faults.push({ method: 'setShortcut', gate: gate.promise });
  const saving = f.settings.save(shortcut('F8', 'F9'), revision);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.store.writes.length, 0);
  assert.deepEqual(f.broker.status.shortcut, previous);
  assert.equal(f.settings.revision, revision);
  gate.resolve(); await saving;
  assert.deepEqual(f.store.value, shortcut('F8', 'F9'));
  assert.notEqual(f.settings.revision, revision);
});

test('lost or incorrect configuration ACK restores the previous binding without persisting', async t => {
  for (const fault of [{ error: new Error('ACK timeout') }, { reply: { shortcut: shortcut('F10', 'F11') } }]) {
    const f = await fixture(); t.after(() => f.settings.dispose());
    const previous = clone(f.native.shortcut), revision = f.settings.revision;
    f.faults.push({ method: 'setShortcut', ...fault });
    await assert.rejects(f.settings.save(shortcut('F8', 'F9'), revision), /快捷键未保存/);
    assert.deepEqual(f.native.shortcut, previous);
    assert.deepEqual(f.broker.status.shortcut, previous);
    assert.equal(f.store.writes.length, 0);
    assert.equal(f.settings.revision, revision);
    assert.equal(f.stopped.length, 0);
  }
});

test('disk write failure rolls back native state; unconfirmed rollback stops capture', async t => {
  const f = await fixture(); t.after(() => f.settings.dispose());
  const previous = clone(f.native.shortcut);
  f.store.failure = new Error('Read-only volume');
  await assert.rejects(f.settings.save(shortcut('F8', 'F9'), f.settings.revision), /Read-only volume/);
  assert.deepEqual(f.native.shortcut, previous);
  assert.equal(f.stopped.length, 0);
  f.store.failure = null;
  f.faults.push({ method: 'setShortcut', error: new Error('Save ACK lost') }, { method: 'setShortcut', error: new Error('Rollback ACK lost') });
  await assert.rejects(f.settings.save(shortcut('F8', 'F9'), f.settings.revision), /快捷键未保存/);
  assert.equal(f.native.child, null);
  assert.equal(f.broker.status.ready, false);
  assert.match(f.broker.status.error, /无法确认旧快捷键/);
  await f.native.restart();
  assert.deepEqual(f.native.shortcut, previous);
});

test('a stale multi-window revision or malformed single-key binding cannot reach native settings', async t => {
  const f = await fixture(); t.after(() => f.settings.dispose());
  const oldRevision = f.settings.revision;
  await f.settings.save(shortcut('F8', 'F9'), oldRevision);
  const requests = f.calls.length;
  await assert.rejects(f.settings.save(shortcut('F10', 'F11'), oldRevision), /另一窗口更新/);
  await assert.rejects(f.settings.save({ version: 1, codes: ['F8'] }, f.settings.revision), /两个/);
  await assert.rejects(f.settings.save({ version: 1, codes: ['F8', 'F8'] }, f.settings.revision), /两个|重复/);
  await assert.rejects(f.settings.save({ version: 1, codes: ['F8', 'F9', 'F10'] }, f.settings.revision), /只支持两个键/);
  assert.equal(f.calls.length, requests);
});

test('recording owners expire independently, renew leases, and remain paused across native restart', async t => {
  const f = await fixture(); t.after(() => f.settings.dispose());
  await f.settings.recording('window-a', true);
  await f.advance(5_000);
  await f.settings.recording('window-b', true);
  await f.advance(7_000);
  await f.settings.recording('window-a', true);
  await f.native.restart();
  assert.equal(f.native.paused, true);
  await f.settings.recording('window-b', false);
  assert.equal(f.native.paused, true, 'one window cannot resume another recorder');
  await f.advance(14_999);
  assert.equal(f.native.paused, true);
  await f.advance(1);
  assert.equal(f.native.paused, false);
  assert.equal(f.settings.owners.size, 0);
  assert.equal(f.broker.status.recording, false);
  assert.equal(f.timers.size, 0);
});

test('an unacknowledged recording pause is rolled back, avoiding a permanently paused helper', async t => {
  const f = await fixture(); t.after(() => f.settings.dispose());
  f.faults.push({ method: 'setRecording', error: new Error('Pause ACK lost') });
  await assert.rejects(f.settings.recording('window-a', true), /Pause ACK lost/);
  assert.equal(f.settings.owners.size, 0);
  assert.equal(f.native.paused, false);
  assert.equal(f.timers.size, 0);
  await f.settings.recording('window-a', true);
  f.faults.push({ method: 'setRecording', reply: { recording: true } });
  await assert.rejects(f.settings.recording('window-a', false), /未确认录入状态/);
  assert.equal(f.settings.owners.size, 1);
  assert.equal(f.native.paused, true);
  await f.advance(15_000);
  assert.equal(f.native.paused, false);
});

test('unconfirmed recorder rollback or lease-expiry resume stops the helper', async t => {
  const rollback = await fixture(); t.after(() => rollback.settings.dispose());
  rollback.faults.push({ method: 'setRecording', error: new Error('Pause timeout') }, { method: 'setRecording', error: new Error('Resume timeout') });
  await assert.rejects(rollback.settings.recording('window-a', true), /Pause timeout/);
  assert.equal(rollback.native.child, null);
  assert.match(rollback.broker.status.error, /无法恢复监听/);
  const expiry = await fixture(); t.after(() => expiry.settings.dispose());
  await expiry.settings.recording('window-a', true);
  expiry.faults.push({ method: 'setRecording', reply: { recording: true } });
  await expiry.advance(15_000);
  assert.equal(expiry.native.child, null);
  assert.equal(expiry.broker.status.ready, false);
  assert.match(expiry.broker.status.error, /录入状态恢复未确认/);
});

test('unreadable or unsupported preferences use a visible default fallback; failed boot stays stopped', async t => {
  for (const options of [{ loadFailure: new Error('Corrupt preferences') }, { stored: { version: 1, codes: ['F8'] } }]) {
    const f = await fixture(options); t.after(() => f.settings.dispose());
    assert.deepEqual(f.native.shortcut, defaultShortcut());
    assert.ok(f.broker.status.settingsError);
    await f.settings.save(shortcut('F8', 'F9'), f.settings.revision);
    assert.equal(f.broker.status.settingsError, '');
  }
  const unsupported = await fixture({ stored: shortcut('F8', 'F9'), skipBoot: true }); t.after(() => unsupported.settings.dispose());
  await unsupported.native.restart({ supportedCodes: ['MetaLeft', 'MetaRight'] });
  assert.deepEqual(unsupported.native.shortcut, defaultShortcut());
  assert.match(unsupported.broker.status.settingsError, /不支持的按键/);
  const failed = await fixture({ skipBoot: true }); t.after(() => failed.settings.dispose());
  failed.faults.push({ method: 'setRecording', error: new Error('Cannot pause') });
  await assert.rejects(failed.native.restart(), /Cannot pause/);
  assert.equal(failed.native.child, null);
  assert.equal(failed.broker.status.ready, false);
  assert.match(failed.broker.status.error, /配置未确认/);
  assert.equal(failed.calls.filter(row => row.method === 'setShortcut').length, 0);
});

test('old multi-key preferences fall back visibly without overwriting disk until a valid pair is saved', async t => {
  const stored = { version: 1, codes: ['ControlLeft', 'ShiftLeft', 'F8'] };
  const f = await fixture({ stored }); t.after(() => f.settings.dispose());
  assert.equal(f.broker.status.ready, true);
  assert.equal(f.native.paused, false);
  assert.deepEqual(f.native.shortcut, defaultShortcut());
  assert.deepEqual(f.store.value, stored);
  assert.equal(f.store.writes.length, 0);
  assert.match(f.broker.status.settingsError, /只支持两个键.*默认组合/);
  await f.settings.save(shortcut('ControlLeft', 'F8'), f.settings.revision);
  assert.deepEqual(f.store.value, shortcut('ControlLeft', 'F8'));
  assert.equal(f.broker.status.settingsError, '');
  await f.native.restart();
  assert.deepEqual(f.native.shortcut, shortcut('ControlLeft', 'F8'));
});

test('a third physical key invalidates the entire recording and cannot silently save the first pair', async t => {
  const f = await fixture({ nativeRecording: true }); t.after(() => f.settings.dispose());
  const token = recordingToken(1);
  await f.settings.recording('window-a', true); await f.settings.beginRecording('window-a', token);
  f.native.recordingState = { token, state: 'too_many', current: [], peak: [] };
  assert.deepEqual(await f.settings.recordingState('window-a', token), f.native.recordingState);
  const calls = f.calls.filter(call => call.method === 'setShortcut').length;
  await assert.rejects(f.settings.save(shortcut('ControlLeft', 'ShiftLeft'), f.settings.revision, { owner: 'window-a', token }), /尚未完整确认/);
  assert.equal(f.store.writes.length, 0);
  assert.equal(f.calls.filter(call => call.method === 'setShortcut').length, calls);
  await f.settings.endRecording('window-a', token);
  await f.settings.recording('window-a', false);
  assert.equal(f.native.paused, false);
});

test('a queued stale ready callback cannot restart or configure a stopped helper', async t => {
  const f = await fixture({ skipBoot: true }); t.after(() => f.settings.dispose());
  const gate = deferred();
  const blocked = f.settings.enqueue(() => gate.promise);
  f.native.child = {};
  const initializing = f.native.options.onReady({ supportedCodes: supportedShortcutCodes(), shortcut: defaultShortcut() });
  f.native.stop('Manual stop');
  gate.resolve(); await blocked;
  await assert.rejects(initializing, /初始化已取消/);
  assert.equal(f.native.child, null);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.stopped, ['Manual stop']);
});

test('file preferences round-trip atomically, preserve old data on invalid JSON, and use the device path', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-shortcuts-test-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'settings', 'shortcut.json'), store = new ShortcutFileStore(path);
  assert.equal(await store.load(), null);
  const value = shortcut('AltRight', 'KeyS');
  await store.save(value);
  assert.deepEqual(await store.load(), value);
  await store.save(shortcut('F8', 'F9'));
  assert.deepEqual(await store.load(), shortcut('F8', 'F9'));
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
  await writeFile(path, '{invalid');
  await assert.rejects(store.load(), /无法读取/);
  assert.equal(await readFile(path, 'utf8'), '{invalid');
  assert.equal(shortcutSettingsPath('darwin', {}, directory), join(directory, 'Library', 'Application Support', 'dsh-context-snapshot', 'shortcut.json'));
  assert.equal(shortcutSettingsPath('win32', { LOCALAPPDATA: directory }, directory), join(directory, 'dsh-context-snapshot', 'shortcut.json'));
  assert.equal(shortcutSettingsPath('win32', { LOCALAPPDATA: 'relative-path' }, directory), join(directory, 'AppData', 'Local', 'dsh-context-snapshot', 'shortcut.json'));
});
