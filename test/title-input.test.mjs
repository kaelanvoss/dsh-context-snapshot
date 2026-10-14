import test from 'node:test';
import assert from 'node:assert/strict';
import { contextText, captureFile } from '../src/draft.mjs';
import { firstSnapshotTitleInput, snapshotTitleInput, framedTitleInputBytes, MAX_SNAPSHOT_TITLE_INPUT_BYTES, truncateTitleText } from '../src/title-input.mjs';

const capture = (patch = {}) => ({ snapshotId: 'D35CBB02-C228-4C46-9B25-4014DA56FEAE', appName: 'Browser', title: 'Public acceptance page',
  capturedAt: '2026-10-14T04:00:00.000Z', pngBase64: 'aQ==', text: 'heading Build details; checkbox Restore (checked); button Submit (disabled)',
  captureQuality: { status: 'available', reasons: [], textSource: 'ax', nodeCount: 3 },
  source: { url: 'https://example.com/builds?secret=omitted#fragment', selectedText: 'A selected caption', focusedName: 'Build number' }, timing: {}, ...patch });

function message(body = '', saved = capture(), seq = 2, before = []) {
  const image = { type: 'image', attachment: { attachmentId: 'image-identity', mediaType: 'image/webp', width: 600, height: 400, name: captureFile(saved).name } };
  const content = [...before, image, { type: 'text', text: body + contextText(saved) }];
  const event = { type: 'user/message', seq, data: { source: { kind: 'user' }, content } };
  const input = { seq, text: content.filter(block => block.type === 'text').map(block => block.text).join('\n') };
  return { event, input, session: { header: {}, snapshotEvents: () => [event] } };
}

test('snapshot-only titles use the saved source and provide a bounded semantic auxiliary input', () => {
  const f = message(), before = structuredClone(f.event), result = snapshotTitleInput(f.session, f.input);
  assert.equal(result.fallbackTitle, 'Public acceptance page');
  assert.equal(result.seq, f.input.seq);
  assert.ok(result.text.includes('Build details'));
  assert.ok(result.text.includes('https://example.com/builds'));
  assert.ok(!result.text.includes('secret=') && !result.text.includes('#fragment'));
  assert.ok(!result.text.includes('window_snapshot') && !result.text.includes('pngBase64') && !result.text.includes('capturedAt'));
  assert.ok(framedTitleInputBytes([{ seq: result.seq, text: result.text }]) <= MAX_SNAPSHOT_TITLE_INPUT_BYTES);
  assert.deepEqual(f.event, before, 'title projection leaves the actual Agent image and text unchanged');
});

test('all ordinary text blocks take precedence over snapshot data, including prefix blocks', () => {
  const f = message('Explain the state', capture(), 6, [{ type: 'text', text: 'Investigate the failed build' }]);
  const result = snapshotTitleInput(f.session, f.input);
  assert.equal(result.fallbackTitle, 'Investigate the failed build Explain');
  assert.ok(result.text.startsWith('Investigate the failed build Explain the state\n'));
});

test('escaped and multibyte inputs obey the complete official JSON-framing budget', () => {
  for (const text of ['"\\'.repeat(7000), '图😀"\\'.repeat(2500)]) {
    const f = message('用户请求：'.repeat(500), capture({ text, title: '标题😀'.repeat(50) }));
    const result = snapshotTitleInput(f.session, f.input);
    assert.ok(result);
    assert.ok(result.text.startsWith('用户请求：'));
    assert.ok(framedTitleInputBytes([{ seq: result.seq, text: result.text }]) <= MAX_SNAPSHOT_TITLE_INPUT_BYTES);
    assert.ok(Buffer.byteLength(result.fallbackTitle) <= 40);
    assert.ok(!result.fallbackTitle.endsWith('\ud83d'));
  }
});

test('missing or invalid image/context pairing and forged message seqs remain ordinary title inputs', () => {
  const f = message();
  assert.equal(snapshotTitleInput(f.session, { ...f.input, seq: 7 }), null);
  assert.equal(snapshotTitleInput(f.session, { ...f.input, text: 'a different message' }), null);
  f.event.data.content[0].attachment.name = 'ordinary-image.png';
  assert.equal(snapshotTitleInput(f.session, f.input), null);
  const other = message();
  other.event.data.source.kind = 'plugin';
  assert.equal(snapshotTitleInput(other.session, other.input), null);
  const plain = { type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Discuss <window_snapshot> as a literal format' }] } };
  assert.equal(snapshotTitleInput({ snapshotEvents: () => [plain] }, { seq: 1, text: plain.data.content[0].text }), null);
});

test('only a new unforked conversation whose first eligible user prompt has paired snapshots receives a source fallback', () => {
  const f = message();
  const injected = { type: 'user/message', seq: 0, data: { source: { kind: 'plugin' }, content: [{ type: 'text', text: 'Injected setup' }] } };
  f.session.snapshotEvents = () => [injected, f.event];
  assert.equal(firstSnapshotTitleInput(f.session).seq, f.event.seq);
  const earlier = { type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'The original task' }] } };
  f.session.snapshotEvents = () => [earlier, f.event];
  assert.equal(firstSnapshotTitleInput(f.session), null);
  f.session.snapshotEvents = () => [f.event];
  f.session.header.parentSession = 'a-parent';
  assert.equal(firstSnapshotTitleInput(f.session), null);
});

test('source labels are terminal-safe, use image-only fallback and keep complete Unicode code points', () => {
  const f = message('', capture({ title: '新窗口\n\u202e标题😀', text: '', captureQuality: { status: 'image_only', reasons: ['provider_read_failed'], textSource: 'none', nodeCount: 0 } }));
  assert.equal(snapshotTitleInput(f.session, f.input).fallbackTitle, '新窗口 标题😀');
  const body = message('\u001b[31m用户问题\u001b[0m\n\u202e现在的状态');
  assert.equal(snapshotTitleInput(body.session, body.input).fallbackTitle, '用户问题 现在的状态');
  const empty = message('', capture({ title: '' }));
  assert.equal(snapshotTitleInput(empty.session, empty.input).fallbackTitle, 'Browser窗口快照');
  assert.equal(truncateTitleText('测试😀', 8), '测试');
  assert.equal(truncateTitleText('测试😀', 10), '测试😀');
});

test('multiple snapshots have a single bounded source title and input, without serializing icons', () => {
  const f = message(), second = capture({ snapshotId: '37a57b77-565a-4f15-9e20-3deedbf5e1b5', title: 'Other page' });
  const image = { ...f.event.data.content[0], attachment: { ...f.event.data.content[0].attachment, attachmentId: 'second-image', name: captureFile(second).name } };
  f.event.data.content.splice(1, 0, image);
  f.event.data.content.at(-1).text += contextText(second);
  f.input.text = f.event.data.content.at(-1).text;
  const result = snapshotTitleInput(f.session, f.input);
  assert.ok(result.fallbackTitle.endsWith(' 等2个窗口'));
  assert.ok(result.text.includes('Other page'));
  assert.ok(Buffer.byteLength(result.fallbackTitle) <= 40);
  assert.ok(framedTitleInputBytes([{ seq: result.seq, text: result.text }]) <= MAX_SNAPSHOT_TITLE_INPUT_BYTES);
});
