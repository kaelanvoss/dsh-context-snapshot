const modifierGroups = { Control: 'control', Alt: 'alt', Shift: 'shift', Meta: 'meta' };
const names = { Enter: 'Enter', Tab: 'Tab', Space: 'Space', Escape: 'Esc', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'Page Up', PageDown: 'Page Down', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', IntlBackslash: 'Intl \\', IntlYen: '¥', IntlRo: 'Intl Ro' };
const numpadNames = ['Decimal', 'Multiply', 'Add', 'Divide', 'Enter', 'Subtract', 'Equal', 'Comma'];
const ordinaryCodes = [...Object.keys(names), ...numpadNames.map(x => `Numpad${x}`), ...Array.from({ length: 26 }, (_, i) => `Key${String.fromCharCode(65 + i)}`), ...Array.from({ length: 10 }, (_, i) => `Digit${i}`), ...Array.from({ length: 10 }, (_, i) => `Numpad${i}`)];
const modifiers = Object.keys(modifierGroups).flatMap(x => [`${x}Left`, `${x}Right`]);
export function supportedShortcutCodes(platform = 'darwin') {
  return [...modifiers, ...ordinaryCodes.filter(x => platform !== 'win32' || !['IntlYen', 'IntlRo', 'NumpadEqual', 'NumpadComma'].includes(x)), ...Array.from({ length: platform === 'win32' ? 24 : 20 }, (_, i) => `F${i + 1}`)];
}
function modifierOf(code) { return modifierGroups[code.replace(/(Left|Right)$/, '')] ?? null; }
function compare(a, b) { const left = modifiers.indexOf(a), right = modifiers.indexOf(b); return (left < 0 ? 100 : left) - (right < 0 ? 100 : right) || a.localeCompare(b); }
export function validateShortcut(value, { platform = 'darwin', supportedCodes } = {}) {
  if (!value || value.version !== 1 || !Array.isArray(value.codes)) return '快捷键格式无效，请重新录入。';
  if (value.codes.length < 2 || new Set(value.codes).size < 2) return '请同时按住至少两个不同的按键。';
  if (new Set(value.codes).size !== value.codes.length) return '快捷键中不能重复同一个按键。';
  const supported = new Set(supportedCodes ?? supportedShortcutCodes(platform));
  if (value.codes.some(code => typeof code !== 'string' || !supported.has(code))) return '这个组合包含当前系统不支持的按键，请重新录入。';
  return null;
}
export function normalizeShortcut(value, options) {
  const issue = validateShortcut(value, options);
  if (issue) throw new Error(issue);
  return { version: 1, codes: [...value.codes].sort(compare) };
}
export function defaultShortcut(platform = 'darwin') { return { version: 1, codes: platform === 'win32' || platform === 'windows' ? ['ControlLeft', 'ControlRight'] : ['MetaLeft', 'MetaRight'] }; }
export function shortcutLabels(value, platform = 'darwin') {
  return (value?.codes ?? []).map(code => {
    const modifier = modifierOf(code);
    if (modifier) return `${code.endsWith('Left') ? 'left' : 'right'} ${modifier === 'meta' ? platform === 'win32' || platform === 'windows' ? 'Win' : 'Command' : modifier === 'control' ? 'Ctrl' : modifier === 'alt' ? platform === 'win32' || platform === 'windows' ? 'Alt' : 'Option' : 'Shift'}`;
    return names[code] ?? (code.startsWith('Numpad') ? `Num ${code.slice(6)}` : code.replace(/^(Key|Digit)/, ''));
  });
}
function parts(value) {
  return { keys: value.codes.filter(code => !modifierOf(code)).sort(), modifiers: [...new Set(value.codes.map(modifierOf).filter(Boolean))].sort() };
}
function overlap(candidate, binding, platform) {
  const mods = [...new Set((binding.modifiers ?? []).map(x => x === 'primary' ? platform === 'macos' ? 'meta' : 'control' : x))].sort();
  if (mods.join('+') !== candidate.modifiers.join('+')) return false;
  const keys = [binding.code, binding.secondCode].filter(Boolean);
  if (!candidate.keys.length) return false;
  if (candidate.keys.length === 2 && keys.length === 2) return keys.every(x => candidate.keys.includes(x));
  if (candidate.keys.length === 1 || keys.length === 1) return keys.some(x => candidate.keys.includes(x));
  return keys.every(x => candidate.keys.includes(x));
}
/** Read the public, window-local catalog; never call the internal Desktop bridge. */
export function inspectHarnessConflicts(value, service, platform = 'darwin') {
  const invalid = validateShortcut(value, { platform });
  if (invalid) return { issue: invalid, conflicts: [], limited: false };
  const unavailable = '当前 Harness 快捷键目录不可用，暂时无法检查冲突。';
  if (!service?.catalog?.getSnapshot || !service?.fixedCatalog?.getSnapshot || typeof service.describeBinding !== 'function') return { issue: unavailable, conflicts: [], limited: true };
  try {
    const configStatus = service.config?.getSnapshot?.().status;
    if (configStatus === 'loading') return { issue: 'Harness 快捷键目录正在加载，请稍后再试。', conflicts: [], limited: true };
    if (configStatus === 'unreadable') return { issue: 'Harness 快捷键配置无法读取，暂时无法确认冲突。', conflicts: [], limited: true };
    const editable = service.catalog.getSnapshot(), fixed = service.fixedCatalog.getSnapshot();
    const candidate = parts(value), rows = [...editable, ...fixed];
    const found = new Set();
    for (const row of rows) if ((row.bindings ?? [row.binding]).filter(Boolean).some(binding => overlap(candidate, binding, service.platform ?? (platform === 'win32' ? 'windows' : 'macos')))) found.add(row.id);
    let limited = !candidate.keys.length || candidate.keys.length > 2 || value.codes.filter(x => modifierOf(x)).length > candidate.modifiers.length;
    if (candidate.keys.length > 0 && candidate.keys.length <= 2) {
      try {
        const result = service.describeBinding({ code: candidate.keys[0], ...(candidate.keys[1] ? { secondCode: candidate.keys[1] } : {}), modifiers: candidate.modifiers });
        for (const id of result.conflicts ?? []) found.add(id);
        if (result.issue) return { issue: 'Harness 不支持这个快捷键组合，请选择其他按键。', conflicts: [], limited: true };
      } catch { limited = true; }
    }
    const conflicts = [...found].map(id => ({ id, label: rows.find(row => row.id === id)?.label || id }));
    return { issue: null, conflicts, limited, message: limited ? '此组合只能部分检测 Harness 冲突；系统及其他应用的快捷键不在检测范围内。' : '仅检查 Harness 已登记快捷键；系统及其他应用的快捷键不在检测范围内。' };
  } catch { return { issue: unavailable, conflicts: [], limited: true }; }
}
