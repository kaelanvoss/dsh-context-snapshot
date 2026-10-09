import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as Cordis from '@deepseek-ai/cordis';
import {
  defaultShortcut, inspectHarnessConflicts, normalizeShortcut, shortcutLabels,
  supportedShortcutCodes, validateShortcut,
} from '../src/shortcuts.mjs';

// Use the hash-verified, published Harness 0.2.0-rc.2 implementation. The
// service's actual describeBinding performs its own normalization, admission,
// and overlap checks; only the observable directory/config seats are doubles.
function officialServiceClass() {
  let loaded;
  runInNewContext(readFileSync(new URL('../.fixtures/shortcuts/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: value => { loaded = value; } } },
    console, setTimeout, clearTimeout, queueMicrotask,
  });
  assert.equal(loaded.id, '@deepseek-ai/dsh-client-shortcuts');
  const Service = loaded.factory(id => {
    if (id === '@deepseek-ai/cordis') return Cordis;
    if (id === '@deepseek-ai/dsh-client-store' || id === '@deepseek-ai/dsh-client-ui-primitives') return {};
    throw new Error(`Unexpected official shortcut import: ${id}`);
  });
  assert.equal(typeof Service.prototype.describeBinding, 'function');
  return Service;
}
const OfficialShortcuts = officialServiceClass();
function seat(initial) {
  let value = initial;
  const listeners = new Set();
  return {
    getSnapshot: () => value,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    set: next => { value = next; for (const listener of listeners) listener(); },
  };
}
function service({ platform = 'macos', runtime = 'desktop', editable = [], fixed = [], status = 'ready' } = {}) {
  // Avoid constructing the real UI/Electron service or touching live settings.
  // Its real prototype is still responsible for every describeBinding call.
  return Object.assign(Object.create(OfficialShortcuts.prototype), {
    platform, runtime, catalog: seat(editable), fixedCatalog: seat(fixed),
    config: seat({ status, revision: 'fixture', sequence: 1 }),
  });
}
function snapshot(...codes) { return { version: 1, codes }; }
function command(id, binding, extra = {}) { return { id, label: `命令 ${id}`, binding, modified: false, conflicts: [], issue: null, ...extra }; }
function fixedCommand(id, ...bindings) { return { id, label: `固定 ${id}`, bindings, keys: [], group: 'input' }; }
function ids(result) { return result.conflicts.map(row => row.id).sort(); }
function officialIds(fixture, binding) { return Array.from(fixture.describeBinding(binding).conflicts).sort(); }

test('shortcut configuration requires exactly two distinct supported physical keys', () => {
  for (const candidate of [null, {}, { version: 2, codes: ['F8', 'F9'] }, { version: 1, codes: 'F8+F9' }, snapshot(), snapshot('F8'), snapshot('F8', 'F8'), snapshot('KeyA', 'KeyB', 'KeyC'), snapshot('ControlLeft', 'ShiftLeft', 'KeyA', 'KeyB')]) {
    assert.equal(typeof validateShortcut(candidate), 'string');
    assert.throws(() => normalizeShortcut(candidate));
  }
  for (const candidate of [snapshot('MetaLeft', 'KeyS'), snapshot('F8', 'F9'), snapshot('ControlLeft', 'ControlRight')]) {
    assert.equal(validateShortcut(candidate), null);
  }
  assert.match(validateShortcut(snapshot('F8', 'F8')), /重复/);
  assert.match(validateShortcut(snapshot('F8', 'F9', 'F10')), /只支持两个键/);
  assert.match(validateShortcut(snapshot('F8', null)), /不支持/);
  assert.match(validateShortcut(snapshot('F8', 'Unknown')), /不支持/);
  assert.match(validateShortcut(snapshot('F8', 'CapsLock')), /不支持/);
  assert.equal(validateShortcut(snapshot('F8', 'F9'), { supportedCodes: ['F8', 'F9'] }), null);
  assert.match(validateShortcut(snapshot('F8', 'F9'), { supportedCodes: ['F8'] }), /不支持/);
});

test('normalization retains physical sides and never truncates an oversized combination', () => {
  const original = snapshot('MetaRight', 'ControlLeft');
  const normalized = normalizeShortcut(original);
  assert.deepEqual(normalized, snapshot('ControlLeft', 'MetaRight'));
  assert.deepEqual(original.codes, ['MetaRight', 'ControlLeft']);
  const many = snapshot(...'ABCDEFGHI'.split('').map(letter => `Key${letter}`));
  assert.match(validateShortcut(many), /只支持两个键/);
  assert.throws(() => normalizeShortcut(many), /只支持两个键/);
});

test('platform defaults and labels preserve left/right Command, Ctrl, Option, and Win', () => {
  assert.deepEqual(defaultShortcut('darwin'), snapshot('MetaLeft', 'MetaRight'));
  assert.deepEqual(defaultShortcut('win32'), snapshot('ControlLeft', 'ControlRight'));
  assert.deepEqual(shortcutLabels(snapshot('MetaLeft', 'MetaRight', 'AltLeft', 'ControlRight', 'ShiftLeft', 'KeyS', 'Digit9', 'NumpadEnter', 'ArrowDown'), 'darwin'),
    ['left Command', 'right Command', 'left Option', 'right Ctrl', 'left Shift', 'S', '9', 'Num Enter', '↓']);
  assert.deepEqual(shortcutLabels(snapshot('MetaRight', 'AltRight', 'ControlLeft'), 'win32'), ['right Win', 'right Alt', 'left Ctrl']);
  for (const platform of ['darwin', 'win32']) {
    const supported = supportedShortcutCodes(platform);
    assert.equal(supported.length, new Set(supported).size);
    for (const code of ['ControlLeft', 'ControlRight', 'MetaLeft', 'MetaRight', 'KeyA', 'Digit0', 'Numpad0', 'NumpadEnter', 'Home', 'Slash', 'F20']) assert.ok(supported.includes(code), `${platform} ${code}`);
    for (const code of ['Pause', 'CapsLock', 'NumLock', 'ScrollLock', 'PrintScreen']) assert.ok(!supported.includes(code), `${platform} excludes ${code}`);
  }
  assert.ok(supportedShortcutCodes('win32').includes('F24'));
  assert.ok(!supportedShortcutCodes('darwin').includes('F21'));
  assert.ok(supportedShortcutCodes('darwin').includes('IntlYen'));
  assert.ok(!supportedShortcutCodes('win32').includes('IntlYen'));
});

test('official editable conflicts honor effective user overrides, unbound commands, and exact modifiers', () => {
  const fixture = service({ editable: [
    command('save', { code: 'KeyS', modifiers: ['meta'] }, { modified: true }),
    command('old-default', { code: 'KeyO', modifiers: ['meta'] }),
    command('shift-save', { code: 'KeyS', modifiers: ['meta', 'shift'] }),
    command('unbound', null, { modified: true }),
  ] });
  const result = inspectHarnessConflicts(snapshot('MetaRight', 'KeyS'), fixture);
  assert.equal(result.issue, null);
  assert.deepEqual(ids(result), officialIds(fixture, { code: 'KeyS', modifiers: ['meta'] }));
  assert.deepEqual(result.conflicts, [{ id: 'save', label: '命令 save' }]);
  assert.deepEqual(ids(inspectHarnessConflicts(snapshot('ShiftLeft', 'KeyS'), fixture)), [], 'Shift alone does not match a Meta+Shift binding');
  assert.deepEqual(ids(inspectHarnessConflicts(snapshot('ControlLeft', 'KeyS'), fixture)), []);
  fixture.catalog.set([command('save', { code: 'KeyP', modifiers: ['meta'] }, { modified: true }), command('unbound', null)]);
  assert.deepEqual(ids(inspectHarnessConflicts(snapshot('MetaRight', 'KeyS'), fixture)), []);
  assert.deepEqual(ids(inspectHarnessConflicts(snapshot('MetaRight', 'KeyP'), fixture)), ['save']);
});

test('official two-key overlap handles single-versus-pair conflicts and reversed ordinary-key order', () => {
  const fixture = service({ editable: [
    command('single-f8', { code: 'F8', modifiers: [] }),
    command('pair-f8-f9', { code: 'F8', secondCode: 'F9', modifiers: [] }),
    command('different-pair', { code: 'F8', secondCode: 'F10', modifiers: [] }),
    command('different-modifiers', { code: 'F8', secondCode: 'F9', modifiers: ['shift'] }),
  ] });
  const result = inspectHarnessConflicts(snapshot('F9', 'F8'), fixture);
  assert.equal(result.issue, null);
  assert.equal(result.limited, false);
  assert.deepEqual(ids(result), officialIds(fixture, { code: 'F9', secondCode: 'F8', modifiers: [] }));
  assert.deepEqual(ids(result), ['pair-f8-f9', 'single-f8']);
  const single = inspectHarnessConflicts(snapshot('ShiftRight', 'F8'), service({ editable: [
    command('shift-pair', { code: 'F8', secondCode: 'F9', modifiers: ['shift'] }),
  ] }));
  assert.deepEqual(ids(single), ['shift-pair']);
});

test('fixed directory bindings participate in the actual official checker and refresh dynamically', () => {
  const fixture = service({ platform: 'windows', editable: [command('copy-settings', { code: 'KeyC', modifiers: ['control'] })], fixed: [
    fixedCommand('copy', { code: 'KeyC', modifiers: ['control'] }, { code: 'KeyV', modifiers: ['control'] }),
    fixedCommand('other', { code: 'KeyC', modifiers: ['alt'] }),
  ] });
  const result = inspectHarnessConflicts(snapshot('ControlRight', 'KeyC'), fixture, 'win32');
  assert.deepEqual(ids(result), officialIds(fixture, { code: 'KeyC', modifiers: ['control'] }));
  assert.deepEqual(ids(result), ['copy', 'copy-settings']);
  assert.equal(result.conflicts.find(row => row.id === 'copy').label, '固定 copy');
  fixture.fixedCatalog.set([fixedCommand('replacement', { code: 'KeyC', modifiers: ['control'] })]);
  assert.deepEqual(ids(inspectHarnessConflicts(snapshot('ControlLeft', 'KeyC'), fixture, 'win32')), ['copy-settings', 'replacement']);
});

test('logical primary bindings use the actual receiving service platform', () => {
  const mac = service({ editable: [command('primary-save', { code: 'KeyS', modifiers: ['primary'] })] });
  const windows = service({ platform: 'windows', editable: [command('primary-save', { code: 'KeyS', modifiers: ['primary'] })] });
  // Public catalogs normally already normalize primary; this seat also checks
  // that a declaration supplied by another plugin is conservatively detected.
  assert.deepEqual(ids(inspectHarnessConflicts(snapshot('MetaLeft', 'KeyS'), mac)), ['primary-save']);
  assert.deepEqual(ids(inspectHarnessConflicts(snapshot('ControlLeft', 'KeyS'), windows, 'win32')), ['primary-save']);
  assert.deepEqual(ids(inspectHarnessConflicts(snapshot('MetaLeft', 'KeyS'), windows, 'win32')), []);
});

test('both physical modifier sides retain partial conflict detection', () => {
  const fixture = service({ editable: [command('save', { code: 'KeyS', modifiers: ['meta'] })] });
  const pure = inspectHarnessConflicts(snapshot('MetaLeft', 'MetaRight'), fixture);
  assert.equal(pure.issue, null);
  assert.equal(pure.limited, true);
  assert.deepEqual(pure.conflicts, []);
  assert.match(pure.message, /部分检测/);
  assert.match(pure.message, /系统及其他应用/);
});

test('native-supported keys beyond the official binding alphabet retain partial detection', () => {
  const result = inspectHarnessConflicts(snapshot('ControlLeft', 'NumpadEnter'), service());
  assert.equal(result.issue, null);
  assert.equal(result.limited, true);
  assert.deepEqual(result.conflicts, []);
});

test('actual official runtime admission issues are not reported as conflict-free', () => {
  const fixture = service({ runtime: 'web' });
  assert.ok(fixture.describeBinding({ code: 'F8', secondCode: 'F9', modifiers: [] }).issue);
  const result = inspectHarnessConflicts(snapshot('F8', 'F9'), fixture);
  assert.match(result.issue, /不支持/);
  assert.equal(result.limited, true);
});

test('missing, loading, unreadable, or throwing directories fail closed with an explicit issue', () => {
  const candidate = snapshot('MetaLeft', 'KeyS');
  for (const absent of [undefined, {}, { catalog: seat([]) }, { catalog: seat([]), fixedCatalog: seat([]) }]) {
    const result = inspectHarnessConflicts(candidate, absent);
    assert.equal(result.limited, true);
    assert.match(result.issue, /不可用/);
  }
  const fixture = service({ editable: [command('save', { code: 'KeyS', modifiers: ['meta'] })] });
  fixture.config.set({ status: 'loading' });
  assert.match(inspectHarnessConflicts(candidate, fixture).issue, /加载/);
  fixture.config.set({ status: 'unreadable' });
  assert.match(inspectHarnessConflicts(candidate, fixture).issue, /无法读取/);
  fixture.config.set({ status: 'ready' });
  fixture.catalog.getSnapshot = () => { throw new Error('catalog unavailable'); };
  assert.match(inspectHarnessConflicts(candidate, fixture).issue, /不可用/);
  const brokenConfig = service();
  brokenConfig.config.getSnapshot = () => { throw new Error('configuration unavailable'); };
  const result = inspectHarnessConflicts(candidate, brokenConfig);
  assert.match(result.issue, /不可用/);
  assert.equal(result.limited, true);
});

test('invalid one-key and oversized input are rejected before inspecting the Harness directory', () => {
  const fixture = service();
  fixture.catalog.getSnapshot = () => { throw new Error('should not inspect'); };
  for (const candidate of [snapshot('F8'), snapshot('F8', 'F9', 'F10')]) {
    const result = inspectHarnessConflicts(candidate, fixture);
    assert.match(result.issue, /只支持两个键/);
    assert.equal(result.limited, false);
    assert.deepEqual(result.conflicts, []);
  }
});
