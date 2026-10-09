import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const require = createRequire(import.meta.url);
const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/SnapshotPopover.jsx', import.meta.url))], bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react'], logLevel: 'silent' });
const module = { exports: {} };
const windowListeners = new Map();
const documentListeners = new Map();
const browserDocument = { hidden: false, documentElement: { clientWidth: 1024 }, addEventListener: (name, callback) => documentListeners.set(name, callback), removeEventListener: name => documentListeners.delete(name) };
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, require, console, queueMicrotask,
  window: { addEventListener: (name, callback) => windowListeners.set(name, callback), removeEventListener: name => windowListeners.delete(name) },
  document: browserDocument,
});
const { SnapshotPopover } = module.exports;
const shortcut = codes => ({ version: 1, codes });

async function fixture(overrides = {}) {
  const recordings = [], saved = [], closedWith = [];
  let closed = 0;
  const props = {
    status: { ready: true, shortcut: shortcut(['MetaLeft', 'MetaRight']) }, pending: null, isWindows: false,
    onPermissions() {}, onRestart() {}, onClose(restoreFocus) { closed += 1; closedWith.push(restoreFocus); },
    onRecordingChange: async value => { recordings.push(value); },
    onShortcutChange: async value => { saved.push(value); },
    checkShortcut: () => ({ conflicts: [] }),
    ...overrides,
  };
  let view;
  await act(async () => { view = TestRenderer.create(React.createElement(SnapshotPopover, props), { createNodeMock: element => element.props.role === 'dialog' ? overrides.panelNode ?? null : element.props['aria-label'] === '快捷键录入' ? { focus() {} } : element.type === 'button' && element.props.children === '修改快捷键' ? overrides.editNode ?? null : null }); });
  const text = () => JSON.stringify(view.toJSON());
  const button = label => view.root.findAll(node => node.type === 'button' && node.children.includes(label))[0];
  const click = async label => { const target = button(label); assert.ok(target, `button ${label} exists`); assert.equal(target.props.disabled, false, `button ${label} is enabled`); await act(async () => { await target.props.onClick(); }); };
  const key = async (code, up = false, extra = {}) => {
    let prevented = false, stopped = false;
    const event = { code, repeat: false, preventDefault() { prevented = true; }, stopPropagation() { stopped = true; }, ...extra };
    await act(async () => { view.root.findByProps({ role: 'dialog' }).props[up ? 'onKeyUp' : 'onKeyDown'](event); });
    return { prevented, stopped };
  };
  const chord = async codes => { for (const code of codes) await key(code); await key(codes[0], true); };
  const dispose = async () => { await act(async () => { view.unmount(); }); };
  const update = async next => { Object.assign(props, next); await act(async () => { view.update(React.createElement(SnapshotPopover, props)); }); };
  return { view, text, button, click, key, chord, dispose, update, recordings, saved, closedWith, get closed() { return closed; } };
}

async function outsideFixture(overrides = {}) {
  const inside = {}, outside = {}, trigger = { contains: target => target === trigger };
  const panelNode = { ownerDocument: browserDocument, contains: target => target === inside || target === panelNode, getBoundingClientRect: () => ({ width: 340 }), parentElement: { getBoundingClientRect: () => ({ left: 100 }) } };
  const f = await fixture({ panelNode, triggerRef: { current: trigger }, ...overrides });
  const pointer = async target => { await act(async () => { documentListeners.get('pointerdown')({ target, composedPath: () => [target] }); }); };
  return { ...f, inside, outside, trigger, pointer, get closed() { return f.closed; } };
}

test('popover waits for capture pause acknowledgement, records physical sides, and saves only after release', async t => {
  let acknowledge;
  const recordings = [];
  const f = await fixture({ onRecordingChange: value => { recordings.push(value); return value ? new Promise(resolve => { acknowledge = resolve; }) : Promise.resolve(); } });
  t.after(f.dispose);
  assert.match(f.text(), /left Command/);
  await act(async () => { f.button('修改快捷键').props.onClick(); });
  assert.match(f.text(), /正在暂停采集/);
  assert.deepEqual(await f.key('AltRight'), { prevented: false, stopped: false });
  await act(async () => { acknowledge(); });
  assert.deepEqual(await f.key('AltRight'), { prevented: true, stopped: true });
  await f.key('KeyS');
  assert.equal(f.button('保存快捷键').props.disabled, true, 'still held: recording is incomplete');
  await f.key('KeyS', true);
  assert.equal(f.button('保存快捷键').props.disabled, false);
  await f.click('保存快捷键');
  assert.deepEqual(JSON.parse(JSON.stringify(f.saved)), [shortcut(['AltRight', 'KeyS'])]);
  assert.deepEqual(recordings, [true, false]);
  assert.doesNotMatch(f.text(), /设置快捷键/);
});

test('single and sequential keys cannot be saved; repeat never adds a second key', async t => {
  const f = await fixture();
  t.after(f.dispose);
  await f.click('修改快捷键');
  await f.key('F8');
  await f.key('F8', false, { repeat: true });
  await f.key('F8', true);
  assert.equal(f.button('保存快捷键').props.disabled, true);
  await f.key('F9');
  await f.key('F9', true);
  assert.equal(f.button('保存快捷键').props.disabled, true);
  assert.match(f.text(), /单键不能保存|至少两个/);
  assert.equal(f.saved.length, 0);
  await f.chord(['F8', 'F9', 'F10']);
  assert.equal(f.button('保存快捷键').props.disabled, false, 'three simultaneously held keys remain supported');
});

test('a rejected pause cannot start recording or apply a default shortcut', async t => {
  const recordings = [];
  const f = await fixture({ onRecordingChange: async value => { recordings.push(value); if (value) throw new Error('采集程序无法暂停'); } });
  t.after(f.dispose);
  await f.click('修改快捷键');
  assert.match(f.text(), /采集程序无法暂停/);
  assert.equal(f.button('恢复默认').props.disabled, true);
  assert.equal(f.button('保存快捷键').props.disabled, true);
  assert.deepEqual(await f.key('ControlLeft'), { prevented: false, stopped: false });
  assert.equal(f.saved.length, 0);
  await f.click('取消');
  assert.deepEqual(recordings, [true, false]);
});

test('cancel leaves the original shortcut and resumes monitoring without saving', async t => {
  const f = await fixture();
  t.after(f.dispose);
  await f.click('修改快捷键');
  await f.chord(['ControlLeft', 'KeyS']);
  await f.click('取消');
  assert.deepEqual(f.recordings, [true, false]);
  assert.equal(f.saved.length, 0);
  assert.match(f.text(), /left Command/);
  assert.doesNotMatch(f.text(), /设置快捷键/);
});

test('known Harness conflicts block saving and identify the conflicting command', async t => {
  const f = await fixture({ checkShortcut: () => ({ conflicts: [{ id: 'conversation.save', label: '保存会话' }] }) });
  t.after(f.dispose);
  await f.click('修改快捷键');
  await f.chord(['ControlLeft', 'KeyS']);
  assert.equal(f.button('保存快捷键').props.disabled, true);
  assert.match(f.text(), /保存会话/);
  await f.click('恢复默认');
  assert.equal(f.saved.length, 0, 'restore default uses the same conflict guard');
});

test('a failed save stays in the panel, retaining the candidate until retry or cancel', async t => {
  const f = await fixture({ onShortcutChange: async () => { throw new Error('采集程序未确认配置'); } });
  t.after(f.dispose);
  await f.click('修改快捷键');
  await f.chord(['AltLeft', 'KeyS']);
  await f.click('保存快捷键');
  assert.match(f.text(), /采集程序未确认配置/);
  assert.match(f.text(), /设置快捷键/);
  assert.deepEqual(f.recordings, [true]);
  assert.equal(f.button('保存快捷键').props.disabled, false, 'retry is available');
  await f.click('取消');
  assert.deepEqual(f.recordings, [true, false]);
});

test('restoring the platform default applies it before ending the recording session', async t => {
  const f = await fixture({ isWindows: true, status: { shortcut: shortcut(['AltLeft', 'KeyS']) } });
  t.after(f.dispose);
  await f.click('修改快捷键');
  await f.click('恢复默认');
  assert.deepEqual(JSON.parse(JSON.stringify(f.saved)), [shortcut(['ControlLeft', 'ControlRight'])]);
  assert.deepEqual(f.recordings, [true, false]);
  assert.doesNotMatch(f.text(), /设置快捷键/);
});

test('closing or unmounting while editing restores monitoring; standalone Escape cancels', async () => {
  const f = await fixture();
  await f.click('修改快捷键');
  await f.key('Escape');
  assert.deepEqual(f.recordings, [true, false]);
  await f.click('修改快捷键');
  await act(async () => { await f.view.root.findByProps({ 'aria-label': '关闭快照说明' }).props.onClick(); });
  assert.equal(f.closed, 1);
  assert.deepEqual(f.recordings, [true, false, true, false]);
  await f.click('修改快捷键');
  await f.dispose();
  assert.deepEqual(f.recordings, [true, false, true, false, true, false]);
});

test('a focus interruption clears held keys instead of combining keys from different apps', async t => {
  const f = await fixture();
  t.after(f.dispose);
  await f.click('修改快捷键');
  await f.key('ControlLeft');
  await act(async () => { windowListeners.get('blur')(); });
  assert.match(f.text(), /录入已中断/);
  assert.equal(f.button('保存快捷键').props.disabled, true);
  await f.click('重新录入');
  await f.key('KeyS');
  await f.key('KeyS', true);
  assert.equal(f.button('保存快捷键').props.disabled, true);
});

test('current shortcuts show newly registered Harness conflicts without changing the binding', async t => {
  let conflict = false;
  const f = await fixture({ checkShortcut: () => ({ conflicts: conflict ? [{ id: 'application.command', label: '新注册命令' }] : [] }) });
  t.after(f.dispose);
  assert.doesNotMatch(f.text(), /新注册命令/);
  conflict = true;
  await f.update({});
  assert.match(f.text(), /与 Harness 快捷键冲突/);
  assert.match(f.text(), /新注册命令/);
  assert.match(f.text(), /left Command/);
  assert.equal(f.saved.length, 0);
});

test('settings restoration errors are visible and unknown error details are not exposed', async t => {
  const f = await fixture({ status: { ready: true, settingsError: '已保存的快捷键配置无法读取；当前使用默认组合，可重新保存设置。' } });
  t.after(f.dispose);
  assert.match(f.text(), /快捷键配置无法读取/);
  await f.update({ status: { ready: true, settingsError: { details: 'PRIVATE FILE CONTENTS' } } });
  assert.match(f.text(), /快捷键配置未能恢复/);
  assert.doesNotMatch(f.text(), /PRIVATE FILE CONTENTS/);
});

test('an editing panel describes paused capture instead of claiming it is ready', async t => {
  const f = await fixture();
  t.after(f.dispose);
  await f.click('修改快捷键');
  assert.match(f.text(), /录入中，采集已暂停/);
  assert.doesNotMatch(f.text(), /已就绪/);
  await f.chord(['AltLeft', 'KeyS']);
  assert.match(f.text(), /快捷键设置中，采集已暂停/);
});

test('failed listener restoration after saving can be retried without saving twice', async t => {
  let restores = 0;
  const recordings = [];
  const f = await fixture({ onRecordingChange: async active => { recordings.push(active); if (!active && ++restores === 1) throw new Error('连接暂时不可用'); } });
  t.after(f.dispose);
  await f.click('修改快捷键');
  await f.chord(['AltLeft', 'KeyS']);
  await f.click('保存快捷键');
  assert.equal(f.saved.length, 1);
  assert.match(f.text(), /快捷键已保存，但恢复监听失败/);
  assert.equal(f.button('保存快捷键').props.disabled, true);
  await f.click('重试恢复监听');
  assert.equal(f.saved.length, 1);
  assert.deepEqual(recordings, [true, false, false]);
  assert.doesNotMatch(f.text(), /设置快捷键/);
});

test('failed listener restoration keeps the panel open and the close button retries it', async t => {
  let restores = 0;
  const recordings = [];
  const f = await fixture({ onRecordingChange: async active => { recordings.push(active); if (!active && ++restores === 1) throw new Error('请稍后重试'); } });
  t.after(f.dispose);
  await f.click('修改快捷键');
  await act(async () => { await f.view.root.findByProps({ 'aria-label': '关闭快照说明' }).props.onClick(); });
  assert.equal(f.closed, 0);
  assert.match(f.text(), /恢复快捷键监听失败/);
  assert.match(f.text(), /重试恢复监听/);
  await act(async () => { await f.view.root.findByProps({ 'aria-label': '关闭快照说明' }).props.onClick(); });
  assert.equal(f.closed, 1);
  assert.deepEqual(recordings, [true, false, false]);
});

test('a recording heartbeat interruption clears held keys and requires a new pause acknowledgement', async t => {
  const f = await fixture();
  t.after(f.dispose);
  await f.click('修改快捷键');
  await f.key('ControlLeft');
  await f.update({ recordingError: '无法续约录入连接' });
  assert.match(f.text(), /录入连接已中断，请重新录入/);
  assert.match(f.text(), /录入已中断/);
  assert.equal(f.button('保存快捷键').props.disabled, true);
  assert.equal(f.button('恢复默认').props.disabled, true);
  assert.deepEqual(await f.key('KeyS'), { prevented: false, stopped: false });
  await f.key('ControlLeft', true);
  await f.update({ recordingError: '' });
  assert.equal(f.button('保存快捷键').props.disabled, true, 'clearing an error alone does not resume recording');
  await f.click('重新录入');
  await f.key('KeyS');
  await f.key('KeyS', true);
  assert.equal(f.button('保存快捷键').props.disabled, true, 'old Control key is no longer held');
  await f.chord(['AltLeft', 'KeyS']);
  await f.click('保存快捷键');
  assert.deepEqual(JSON.parse(JSON.stringify(f.saved)), [shortcut(['AltLeft', 'KeyS'])]);
  assert.deepEqual(f.recordings, [true, true, false]);
});

test('a completed combination cannot be saved after a recording error, while cancel still releases its owner', async t => {
  const f = await fixture();
  t.after(f.dispose);
  await f.click('修改快捷键');
  await f.chord(['AltLeft', 'KeyS']);
  assert.equal(f.button('保存快捷键').props.disabled, false);
  await f.update({ recordingError: '连接中断' });
  assert.equal(f.button('保存快捷键').props.disabled, true);
  assert.equal(f.button('恢复默认').props.disabled, true);
  await f.click('取消');
  assert.equal(f.saved.length, 0);
  assert.deepEqual(f.recordings, [true, false]);
});

test('outside click closes without restoring trigger focus; inside and trigger clicks stay open', async t => {
  const f = await outsideFixture();
  t.after(f.dispose);
  await f.pointer(f.inside);
  await f.pointer(f.trigger);
  assert.equal(f.closed, 0);
  await f.pointer(f.outside);
  assert.equal(f.closed, 1);
  assert.deepEqual(f.closedWith, [false]);
});

test('outside click during recording waits for monitoring to resume and discards the unsaved candidate', async t => {
  let acknowledge;
  const recordings = [];
  const f = await outsideFixture({ onRecordingChange: active => {
    recordings.push(active);
    return active ? Promise.resolve() : new Promise(resolve => { acknowledge = resolve; });
  } });
  t.after(f.dispose);
  await f.click('修改快捷键');
  await f.chord(['AltLeft', 'KeyS']);
  await f.pointer(f.outside);
  assert.equal(f.closed, 0, 'resume acknowledgement is required');
  assert.deepEqual(recordings, [true, false]);
  assert.deepEqual(await f.key('KeyA'), { prevented: false, stopped: false });
  await act(async () => { acknowledge(); });
  assert.equal(f.closed, 1);
  assert.deepEqual(f.closedWith, [false]);
  assert.equal(f.saved.length, 0);
});

test('outside close restoration failures stay visible and retry closes without taking focus', async t => {
  let restores = 0;
  const recordings = [];
  const f = await outsideFixture({ onRecordingChange: async active => {
    recordings.push(active);
    if (!active && ++restores === 1) throw new Error('监听恢复失败');
  } });
  t.after(f.dispose);
  await f.click('修改快捷键');
  await f.pointer(f.outside);
  assert.equal(f.closed, 0);
  assert.match(f.text(), /监听恢复失败/);
  assert.deepEqual(recordings, [true, false], 'failed close does not retry forever');
  await f.click('重试恢复监听');
  assert.equal(f.closed, 1);
  assert.deepEqual(f.closedWith, [false]);
  assert.deepEqual(recordings, [true, false, false]);
});

test('outside click during the initial pause queues a safe close and never starts capturing', async t => {
  let paused;
  const recordings = [];
  const f = await outsideFixture({ onRecordingChange: active => {
    recordings.push(active);
    return active ? new Promise(resolve => { paused = resolve; }) : Promise.resolve();
  } });
  t.after(f.dispose);
  await act(async () => { f.button('修改快捷键').props.onClick(); });
  await f.pointer(f.outside);
  assert.equal(f.closed, 0);
  await act(async () => { paused(); });
  assert.equal(f.closed, 1);
  assert.deepEqual(recordings, [true, false]);
  assert.deepEqual(f.closedWith, [false]);
  assert.deepEqual(await f.key('KeyA'), { prevented: false, stopped: false });
});

test('outside click while saving defers closure and skips edit-button focus after success', async t => {
  let saved, focused = 0;
  const f = await outsideFixture({ editNode: { focus() { focused += 1; } }, onShortcutChange: () => new Promise(resolve => { saved = resolve; }) });
  t.after(f.dispose);
  await f.click('修改快捷键');
  await f.chord(['AltLeft', 'KeyS']);
  await act(async () => { f.button('保存快捷键').props.onClick(); });
  await f.pointer(f.outside);
  assert.equal(f.closed, 0);
  await act(async () => { saved(); });
  assert.equal(f.closed, 1);
  assert.deepEqual(f.closedWith, [false]);
  assert.equal(focused, 0);
  assert.deepEqual(f.recordings, [true, false]);
});

test('a deferred close keeps a failed save visible until the user retries restoration', async t => {
  let rejectSave;
  const f = await outsideFixture({ onShortcutChange: () => new Promise((resolve, reject) => { rejectSave = reject; }) });
  t.after(f.dispose);
  await f.click('修改快捷键');
  await f.chord(['AltLeft', 'KeyS']);
  await act(async () => { f.button('保存快捷键').props.onClick(); });
  await f.pointer(f.outside);
  await act(async () => { rejectSave(new Error('保存确认失败')); });
  assert.equal(f.closed, 0);
  assert.match(f.text(), /保存确认失败/);
  assert.deepEqual(f.recordings, [true]);
  await f.click('取消');
  assert.equal(f.closed, 1);
  assert.deepEqual(f.closedWith, [false]);
  assert.deepEqual(f.recordings, [true, false]);
});

test('the toolbar close handle waits for resume and idle Escape still closes', async t => {
  let acknowledge;
  const dismissRef = React.createRef();
  const f = await fixture({ dismissRef, onRecordingChange: active => active ? Promise.resolve() : new Promise(resolve => { acknowledge = resolve; }) });
  t.after(f.dispose);
  await f.key('Escape');
  assert.deepEqual(f.closedWith, [true]);
  await f.click('修改快捷键');
  await act(async () => { dismissRef.current(true); });
  assert.equal(f.closed, 1);
  await act(async () => { acknowledge(); });
  assert.equal(f.closed, 2);
  assert.deepEqual(f.closedWith, [true, true]);
});

test('modifier with Escape remains recordable; Escape after recording safely closes', async t => {
  const f = await fixture();
  t.after(f.dispose);
  await f.click('修改快捷键');
  await f.chord(['AltLeft', 'Escape']);
  assert.equal(f.closed, 0);
  assert.equal(f.button('保存快捷键').props.disabled, false);
  await f.key('Escape');
  assert.equal(f.closed, 1);
  assert.deepEqual(f.recordings, [true, false]);
});
