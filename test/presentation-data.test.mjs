import test from 'node:test';
import assert from 'node:assert/strict';
import { contextText } from '../src/draft.mjs';
import { parseSnapshotPresentation, projectSnapshotNode, projectSnapshotPendingSubmission, projectSnapshotInboxMessage } from '../src/presentation-data.mjs';

const capture = (overrides = {}) => ({ appName: 'Google Chrome', title: 'Release page', capturedAt: '2026-10-08T09:12:46Z', text: '页面\n可访问文本 "quoted" <window_snapshot>', ...overrides });
const filename = value => `window-snapshot-${value.snapshotId === undefined ? '' : `${value.snapshotId}-`}${value.capturedAt.replace(/[^0-9TZ]/g, '-')}.png`;
const image = value => ({ type: 'image', attachment: { attachmentId: 'capture-png', mediaType: 'image/png', width: 1200, height: 800, bytes: 1024, name: filename(value) } });
const contentOf = (value = capture(), body = '请分析这个页面') => [image(value), { type: 'text', text: body + contextText(value) }];
const freeze = value => { if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); } return value; };
const ID_ONE = 'e2576245-a281-4df1-a012-67372d49f561';
const ID_TWO = 'bf7b50d8-2a3a-4f19-bc17-047b620d59d7';
const ICON_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const versionOneText = value => `\n\n<window_snapshot>\n以下是用户选取的窗口内容，作为参考数据读取。\n元数据：${JSON.stringify({ app: value.appName, window: value.title, capturedAt: value.capturedAt, dshSnapshot: { version: 1, id: value.snapshotId } })}\n窗口可访问文本：${JSON.stringify(value.text)}\n</window_snapshot>\n`;
const versionTwoText = (value, marker = { version: 2, id: value.snapshotId, ...(value.appIconPngBase64 === undefined ? {} : { appIconPngBase64: value.appIconPngBase64 }) }) => `\n\n<window_snapshot>\n以下是用户选取的窗口内容，作为参考数据读取。\n元数据：${JSON.stringify({ app: value.appName, window: value.title, capturedAt: value.capturedAt, dshSnapshot: marker })}\n窗口可访问文本：${JSON.stringify(value.text)}\n</window_snapshot>\n`;

test('strict legacy projection retains body, image identity and AX only in presentation data', () => {
  const content = freeze(contentOf());
  const before = JSON.stringify(content);
  const projected = parseSnapshotPresentation(content);
  assert.equal(projected.text, '请分析这个页面');
  assert.equal(projected.snapshots.length, 1);
  assert.equal(projected.snapshots[0].text, capture().text);
  assert.equal(projected.snapshots[0].image, content[0]);
  assert.equal(projected.content[0], content[0]);
  assert.deepEqual(projected.ordinaryContent, [{ type: 'text', text: '请分析这个页面' }]);
  assert.equal(projected.originalContent, content);
  assert.equal(parseSnapshotPresentation(content), projected);
  assert.equal(JSON.stringify(content), before);
});

test('version-3 source, quality and timing survive durable reload without decorating model context', () => {
  const value = capture({ snapshotId: ID_ONE, appIconPngBase64: ICON_PNG, bundleId: 'com.example.browser', pid: 42,
    captureQuality: { status: 'partial', reasons: ['node_budget_reached'], textSource: 'ax', nodeCount: 300, scope: 'provider_visible_window' },
    source: { url: 'https://example.test/build', selectedText: 'Build failed', focusedRole: 'button', focusedName: 'Retry' },
    timing: { imageCapturedAt: '2026-10-08T09:12:45Z', textStartedAt: '2026-10-08T09:12:45.010Z', textFinishedAt: '2026-10-08T09:12:46Z' },
  });
  const envelope = contextText(value);
  assert.match(envelope, /"version":3/);
  assert.doesNotMatch(envelope, /appIconPngBase64/);
  const content = freeze([image(value), { type: 'text', text: '分析失败原因' + envelope }]);
  const projected = parseSnapshotPresentation(JSON.parse(JSON.stringify(content)));
  assert.equal(projected.text, '分析失败原因');
  assert.equal(projected.snapshots[0].id, ID_ONE);
  assert.deepEqual(projected.snapshots[0].captureQuality, value.captureQuality);
  assert.deepEqual(projected.snapshots[0].source, value.source);
  assert.deepEqual(projected.snapshots[0].timing, value.timing);
  assert.equal(projected.snapshots[0].bundleId, value.bundleId);
  assert.equal(projected.snapshots[0].pid, 42);
  assert.equal(projected.snapshots[0].appIconPngBase64, undefined);
  assert.equal(content.at(-1).text, '分析失败原因' + envelope);
});

test('version-3 image-only status pairs with the image and preserves permission reasons', () => {
  const value = capture({ snapshotId: ID_TWO, text: '',
    captureQuality: { status: 'image_only', reasons: ['accessibility_permission_denied'], textSource: 'ax', nodeCount: 0, scope: 'provider_visible_window' }, source: {}, timing: {} });
  const projected = parseSnapshotPresentation(contentOf(value, ''));
  assert.ok(projected);
  assert.equal(projected.snapshots[0].text, '');
  assert.deepEqual(projected.snapshots[0].captureQuality.reasons, ['accessibility_permission_denied']);
  assert.deepEqual(projected.ordinaryContent, []);
});

test('Swift uppercase snapshot UUIDs retain exact identity and millisecond filename pairing', () => {
  const value = capture({ snapshotId: 'BA57E563-9FFE-42F5-89D9-9C8F59AB48B5', capturedAt: '2026-10-09T11:02:19.777Z',
    captureQuality: { status: 'partial', reasons: ['provider_read_failed'], textSource: 'ax', nodeCount: 7 }, source: {},
    timing: { imageCapturedAt: '2026-10-09T11:02:19.777Z', textStartedAt: '2026-10-09T11:02:19.778Z', textFinishedAt: '2026-10-09T11:02:19.780Z' } });
  const content = freeze(contentOf(value)), before = JSON.stringify(content);
  const projected = parseSnapshotPresentation(JSON.parse(JSON.stringify(content)));
  assert.ok(projected);
  assert.equal(projected.snapshots[0].id, value.snapshotId);
  assert.equal(projected.snapshots[0].filename, 'window-snapshot-BA57E563-9FFE-42F5-89D9-9C8F59AB48B5-2026-10-09T11-02-19-777Z.png');
  assert.deepEqual(projected.snapshots[0].captureQuality, value.captureQuality);
  assert.deepEqual(projected.snapshots[0].timing, value.timing);
  assert.equal(projected.text, '请分析这个页面');
  assert.equal(JSON.stringify(content), before);
  const mismatched = { ...image(value), attachment: { ...image(value).attachment, name: filename({ ...value, snapshotId: value.snapshotId.toLowerCase() }) } };
  assert.equal(parseSnapshotPresentation([mismatched, content.at(-1)]), null, 'identity spelling in the exact attachment filename must still match');
  for (const id of [value.snapshotId.replace('BA57', 'GA57'), value.snapshotId.replace('42F5', '52F5')]) {
    assert.equal(parseSnapshotPresentation(contentOf({ ...value, snapshotId: id })), null, 'non-UUID or wrong version cannot hide user text');
  }
});

test('altered version-3 schemas and ambiguous image pairing cannot hide user content', () => {
  const value = capture({ snapshotId: ID_ONE, captureQuality: { status: 'available', reasons: [], textSource: 'ax', nodeCount: 10 }, source: {}, timing: {} });
  const envelope = contextText(value);
  const invalid = [
    envelope.replace('"version":3', '"version":4'),
    envelope.replace('"version":3', '"version":3,"extra":true'),
    envelope.replace('"version":3', `"version":3,"appIconPngBase64":"${ICON_PNG}"`),
    envelope.replace('"status":"available"', '"status":"complete"'),
    envelope.replace('"reasons":[]', '"reasons":["unrecognized_reason"]'),
    envelope.replace('"source":{}', '"source":{"private":true}'),
    envelope.replace('"timing":{}', '"timing":{"imageCapturedAt":"2026-02-30T00:00:00Z"}'),
    envelope.replace('"captureQuality":', '"extra":true,"captureQuality":'),
    envelope.replace('"nodeCount":10', '"nodeCount":301'),
  ];
  for (const text of invalid) assert.equal(parseSnapshotPresentation([image(value), { type: 'text', text }]), null);
  assert.equal(parseSnapshotPresentation([image(value), image(value), { type: 'text', text: envelope }]), null);
  assert.equal(parseSnapshotPresentation([image(value), { type: 'text', text: envelope + '后续正文' }]), null);
});

test('snapshot-only send has no visible text and keeps the image outside ordinary content', () => {
  const projected = parseSnapshotPresentation(contentOf(capture(), ''));
  assert.equal(projected.text, '');
  assert.equal(projected.content.length, 1);
  assert.deepEqual(projected.ordinaryContent, []);
});

test('ordinary attachments and reference syntax are preserved around ordered multiple snapshots', () => {
  const first = capture(), second = capture({ capturedAt: '2026-10-08T09:12:47.1234567Z', title: 'Second window' });
  const ordinary = { type: 'image', attachment: { ...image(first).attachment, name: 'diagram.png' } };
  const file = { type: 'file', attachment: { attachmentId: 'file', name: 'requirements.md', bytes: 25 } };
  const body = '请参考 @[任务](session:123) 和 /literal\n\n保留原格式。';
  const content = freeze([ordinary, image(first), file, image(second), { type: 'text', text: body + contextText(first) + contextText(second) }]);
  const projected = parseSnapshotPresentation(content);
  assert.equal(projected.text, body);
  assert.deepEqual(projected.snapshots.map(item => item.imageIndex), [1, 3]);
  assert.equal(projected.ordinaryContent[0], ordinary);
  assert.equal(projected.ordinaryContent[1], file);
  assert.equal(projected.ordinaryContent[2].text, body);
  assert.deepEqual(content.slice(0, 4), projected.content.slice(0, 4));
});

test('same-second captures require the complete number of images and retain their order', () => {
  const first = capture(), second = capture({ title: 'Another window' });
  const images = [image(first), image(second)];
  const text = contextText(first) + contextText(second);
  const projected = parseSnapshotPresentation(text, images);
  assert.equal(projected.snapshots[0].image, images[0]);
  assert.equal(projected.snapshots[1].image, images[1]);
  assert.equal(parseSnapshotPresentation(text, [images[0]]), null);
  assert.equal(parseSnapshotPresentation(text, [...images, image(first)]), null);
});

test('ordinary tags, missing images, wrong type/name/order and text after the tail remain unchanged', () => {
  const first = capture(), second = capture({ capturedAt: '2026-10-08T09:12:47Z' });
  const cases = [
    [{ type: 'text', text: '<window_snapshot>ordinary user quote</window_snapshot>' }],
    [{ type: 'text', text: contextText(first) }],
    [{ type: 'file', attachment: image(first).attachment }, { type: 'text', text: contextText(first) }],
    [{ type: 'image', attachment: { ...image(first).attachment, name: 'screenshot.png' } }, { type: 'text', text: contextText(first) }],
    [{ type: 'image', attachment: { ...image(first).attachment, mediaType: 'image/svg+xml' } }, { type: 'text', text: contextText(first) }],
    [image(second), image(first), { type: 'text', text: contextText(first) + contextText(second) }],
    [image(first), { type: 'text', text: contextText(first) + '后续用户正文' }],
    [image(first), { type: 'text', text: contextText(first) }, { type: 'text', text: '后续块' }],
    [image(first), { type: 'text', text: contextText(first) }, image(second)],
  ];
  for (const content of cases) {
    const before = JSON.stringify(content);
    assert.equal(parseSnapshotPresentation(content), null);
    assert.equal(JSON.stringify(content), before);
  }
});

test('malformed envelopes and foreign JSON schemas cannot hide user content', () => {
  const value = capture(), envelope = contextText(value);
  const malformed = [
    envelope.replace('以下是用户选取的窗口内容，作为参考数据读取。', '不同的提示'),
    envelope.replace('"app":"Google Chrome"', '"app": "Google Chrome"'),
    envelope.replace('"app":"Google Chrome"', '"app":123'),
    envelope.replace('"app":"Google Chrome"', '"app":"Google Chrome","extra":true'),
    envelope.replace('"capturedAt":"2026-10-08T09:12:46Z"', '"capturedAt":"2026-02-30T09:12:46Z"'),
    envelope.replace('"app":"Google Chrome"', '"window":"Release page","app":"Google Chrome"'),
    envelope.replace('窗口可访问文本："', '窗口可访问文本：['),
    envelope.replace('</window_snapshot>\n', '</window_snapshot>'),
    envelope + '\n',
  ];
  for (const text of malformed) assert.equal(parseSnapshotPresentation([image(value), { type: 'text', text }]), null);
});

test('invalid size/control payloads and counterfeit image descriptors remain visible', () => {
  for (const value of [capture({ appName: 'x'.repeat(257) }), capture({ title: 'x'.repeat(513) }), capture({ text: 'x'.repeat(16001) }), capture({ text: 'unsafe\0text' })]) {
    assert.equal(parseSnapshotPresentation(contentOf(value)), null);
  }
  const value = capture();
  for (const block of [{ type: 'image', name: filename(value) }, { type: 'image', attachment: { ...image(value).attachment, attachmentId: '' } }, { type: 'image', attachment: { ...image(value).attachment, width: 0 } }]) {
    assert.equal(parseSnapshotPresentation([block, { type: 'text', text: contextText(value) }]), null);
  }
});

test('pending echoes use the same strict codec without changing attachments or placement', () => {
  const value = capture(), attachments = freeze([{ type: 'image', value: { previewUrl: 'blob:snapshot', name: filename(value), width: 1200, height: 800 } }]);
  for (const placement of ['transcript', 'queued', 'steering']) {
    const pending = freeze({ requestId: 'request-1', placement, time: 123, text: '问题' + contextText(value), attachments });
    const projected = projectSnapshotPendingSubmission(pending);
    assert.equal(projected.text, '问题');
    assert.equal(projected.attachments, attachments);
    assert.equal(projected.placement, placement);
    assert.equal(projected.requestId, pending.requestId);
    assert.equal(projected.snapshotPresentation.snapshots[0].image, attachments[0]);
    assert.equal(projectSnapshotPendingSubmission(pending), projected);
    assert.equal(parseSnapshotPresentation(pending), projected.snapshotPresentation);
    assert.equal(pending.text, '问题' + contextText(value));
  }
});

test('message/node projections retain source correlation and ignore other context owners', () => {
  const source = freeze({ kind: 'user', rpcId: 'request-1', clientTimeZone: 'Asia/Shanghai' });
  const content = freeze(contentOf());
  const message = freeze({ id: 'message-1', role: 'user', source, content });
  const projected = projectSnapshotInboxMessage(message);
  assert.equal(projected.id, message.id);
  assert.equal(projected.role, message.role);
  assert.equal(projected.source, source);
  assert.equal(projected.content[0], content[0]);
  assert.equal(projectSnapshotInboxMessage(message), projected);
  for (const kind of ['user', 'steering']) {
    const node = freeze({ kind, seq: 15, time: 123, source, content, referenceLabels: ['reference'] });
    const view = projectSnapshotNode(node);
    assert.equal(view.source, source);
    assert.equal(view.referenceLabels, node.referenceLabels);
    assert.equal(view.seq, node.seq);
    assert.equal(projectSnapshotNode(node), view);
  }
  for (const kind of ['context', 'assistant', 'tool']) {
    const node = { kind, source, content };
    assert.equal(projectSnapshotNode(node), node);
  }
  const foreign = { id: 'notice', role: 'user', source: { kind: 'file-reference' }, content };
  assert.equal(projectSnapshotInboxMessage(foreign), foreign);
  const foreignNode = { kind: 'user', source: foreign.source, content };
  assert.equal(projectSnapshotNode(foreignNode), foreignNode);
});

test('unmatched views keep stable original references; persisted reloads need no draft metadata', () => {
  const pending = { requestId: 'ordinary', placement: 'queued', text: 'ordinary', attachments: [] };
  const message = { id: 'ordinary', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'ordinary' }] };
  const node = { kind: 'user', source: message.source, content: message.content };
  assert.equal(projectSnapshotPendingSubmission(pending), pending);
  assert.equal(projectSnapshotInboxMessage(message), message);
  assert.equal(projectSnapshotNode(node), node);
  const durable = freeze({ id: 'restored', role: 'user', source: { kind: 'user', rpcId: 'restored-rpc' }, content: contentOf() });
  const restored = JSON.parse(JSON.stringify(durable));
  const projected = projectSnapshotInboxMessage(restored);
  assert.equal(projected.snapshotPresentation.snapshots[0].title, capture().title);
  assert.equal(projected.content.at(-1).text, '请分析这个页面');
  assert.equal(restored.content.at(-1).text.includes('<window_snapshot>'), true);
  assert.equal(parseSnapshotPresentation(null), null);
  assert.equal(parseSnapshotPresentation({ text: 'ordinary' }), null);
});

test('version-1 persisted identity pairs metadata with its unique image filename', () => {
  const value = capture({ snapshotId: ID_ONE });
  const content = freeze([image(value), { type: 'text', text: '请分析' + versionOneText(value) }]);
  const projected = parseSnapshotPresentation(content);
  assert.equal(projected.text, '请分析');
  assert.equal(projected.snapshots[0].id, ID_ONE);
  assert.equal(projected.snapshots[0].image, content[0]);
  assert.equal(projected.snapshots[0].appName, value.appName);
  assert.equal(projected.snapshots[0].title, value.title);
  assert.equal(projected.snapshots[0].text, value.text);
  const restored = JSON.parse(JSON.stringify(content));
  assert.equal(parseSnapshotPresentation(restored).snapshots[0].id, ID_ONE);
  assert.equal(restored[1].text, content[1].text);
});

test('version-1 unknown versions, invalid ids, marker spelling and image mismatches stay visible', () => {
  const value = capture({ snapshotId: ID_ONE });
  const envelope = versionOneText(value);
  const invalid = [
    envelope.replace('"version":1', '"version":3'),
    envelope.replace('"version":1', '"version":"1"'),
    envelope.replace(ID_ONE, ID_ONE.toUpperCase()),
    envelope.replace(ID_ONE, ID_ONE.replace('-4df1-', '-1df1-')),
    envelope.replace(ID_ONE, 'ordinary-string'),
    envelope.replace('"version":1,"id"', '"version":1,"extra":true,"id"'),
    envelope.replace('"version":1,"id"', '"version": 1,"id"'),
    envelope.replace(`"version":1,"id":"${ID_ONE}"`, `"id":"${ID_ONE}","version":1`),
    envelope.replace(`"id":"${ID_ONE}"`, `"id":"${ID_ONE}","appIconPngBase64":"${ICON_PNG}"`),
  ];
  for (const text of invalid) assert.equal(parseSnapshotPresentation([image(value), { type: 'text', text }]), null);
  assert.equal(parseSnapshotPresentation([image(capture()), { type: 'text', text: envelope }]), null);
  assert.equal(parseSnapshotPresentation([image(capture({ snapshotId: ID_TWO })), { type: 'text', text: envelope }]), null);
  assert.equal(parseSnapshotPresentation([image(value), { type: 'text', text: contextText(capture()) }]), null);
});

test('two version-1 captures in the same second keep distinct ids and pair in order', () => {
  const first = capture({ snapshotId: ID_ONE }), second = capture({ snapshotId: ID_TWO, title: 'Other window' });
  const firstImage = image(first), secondImage = image(second);
  const text = versionOneText(first) + versionOneText(second);
  const projected = parseSnapshotPresentation(text, [firstImage, secondImage]);
  assert.deepEqual(projected.snapshots.map(value => value.id), [ID_ONE, ID_TWO]);
  assert.equal(projected.snapshots[0].image, firstImage);
  assert.equal(projected.snapshots[1].image, secondImage);
  assert.notEqual(projected.snapshots[0].filename, projected.snapshots[1].filename);
  assert.equal(parseSnapshotPresentation(text, [secondImage, firstImage]), null);
  assert.equal(parseSnapshotPresentation(text, [firstImage, firstImage]), null);
});

test('legacy and version-1 captures can share one message without rewriting either source', () => {
  const legacy = capture(), current = capture({ snapshotId: ID_ONE, title: 'New capture' });
  const body = '保留用户问题';
  for (const values of [[legacy, current], [current, legacy]]) {
    const text = body + values.map(value => value.snapshotId ? versionOneText(value) : contextText(value)).join('');
    const content = freeze([...values.map(image), { type: 'text', text }]);
    const projected = parseSnapshotPresentation(content);
    assert.equal(projected.text, body);
    assert.deepEqual(projected.snapshots.map(value => value.id), values.map(value => value.snapshotId));
    assert.deepEqual(projected.snapshots.map(value => value.title), values.map(value => value.title));
    assert.equal(content.at(-1).text, text);
    assert.deepEqual(projected.snapshots.map(value => value.imageIndex), [0, 1]);
  }
});

test('version-2 icon persists across history reload without altering model content', () => {
  const value = capture({ snapshotId: ID_ONE, appIconPngBase64: ICON_PNG });
  const content = freeze(contentOf(value, '保留正文'));
  const before = JSON.stringify(content);
  assert.equal(content.at(-1).text, '保留正文' + versionTwoText(value));
  const projected = parseSnapshotPresentation(content);
  assert.equal(projected.text, '保留正文');
  assert.equal(projected.snapshots[0].id, ID_ONE);
  assert.equal(projected.snapshots[0].appIconPngBase64, ICON_PNG);
  assert.equal(projected.snapshots[0].image, content[0]);
  assert.equal(projected.originalContent, content);
  assert.equal(JSON.stringify(content), before);
  const restored = JSON.parse(before);
  const replayed = projectSnapshotInboxMessage({ id: 'restored-icon', role: 'user', source: { kind: 'user' }, content: restored });
  assert.equal(replayed.snapshotPresentation.snapshots[0].appIconPngBase64, ICON_PNG);
  assert.equal(JSON.stringify(restored), before);
});

test('version-2 icon is optional and reaches pending/steering presentation only', () => {
  const withoutIcon = capture({ snapshotId: ID_ONE });
  const plain = parseSnapshotPresentation(contentOf(withoutIcon));
  assert.equal(plain.snapshots[0].id, ID_ONE);
  assert.equal(Object.hasOwn(plain.snapshots[0], 'appIconPngBase64'), false);
  const value = capture({ snapshotId: ID_TWO, appIconPngBase64: ICON_PNG });
  const pending = freeze({ requestId: 'icon-pending', placement: 'steering', text: '问题' + versionTwoText(value), attachments: [{ type: 'image', value: { previewUrl: 'blob:icon-pending', name: filename(value) } }] });
  const echo = projectSnapshotPendingSubmission(pending);
  assert.equal(echo.snapshotPresentation.snapshots[0].appIconPngBase64, ICON_PNG);
  assert.equal(echo.attachments, pending.attachments);
  assert.equal(echo.text, '问题');
  assert.equal(pending.text, '问题' + versionTwoText(value));
  const node = freeze({ kind: 'steering', source: { kind: 'user' }, content: contentOf(value) });
  assert.equal(projectSnapshotNode(node).snapshotPresentation.snapshots[0].appIconPngBase64, ICON_PNG);
  assert.equal(node.content.at(-1).text, '请分析这个页面' + versionTwoText(value));
});

test('malformed version-2 icons and unrecognized marker schemas stay fully visible', () => {
  const value = capture({ snapshotId: ID_ONE });
  const pngWithWidth = width => {
    const bytes = Buffer.from(ICON_PNG, 'base64');
    bytes.writeUInt32BE(width, 16);
    return bytes.toString('base64');
  };
  const invalidIcons = [undefined, null, 123, {}, '', 'https://example.com/icon.png', '/tmp/icon.png', 'data:image/png;base64,' + ICON_PNG, '<svg />', Buffer.from('<svg />').toString('base64'), ICON_PNG.slice(0, -1), ICON_PNG + '\n', pngWithWidth(0), pngWithWidth(129), Buffer.concat([Buffer.from(ICON_PNG, 'base64'), Buffer.alloc(8192)]).toString('base64')];
  for (const appIconPngBase64 of invalidIcons) {
    // JSON omits undefined: an explicit missing key is the valid optional form.
    if (appIconPngBase64 === undefined) continue;
    const content = freeze([image(value), { type: 'text', text: versionTwoText(value, { version: 2, id: ID_ONE, appIconPngBase64 }) }]);
    const before = JSON.stringify(content);
    assert.equal(parseSnapshotPresentation(content), null);
    assert.equal(JSON.stringify(content), before);
  }
  for (const marker of [
    { version: 3, id: ID_ONE },
    { version: '2', id: ID_ONE },
    { id: ID_ONE, version: 2 },
    { version: 2, appIconPngBase64: ICON_PNG, id: ID_ONE },
    { version: 2, id: ID_ONE, appIconPngBase64: ICON_PNG, extra: true },
    { version: 2, id: ID_ONE.toUpperCase(), appIconPngBase64: ICON_PNG },
  ]) assert.equal(parseSnapshotPresentation([image(value), { type: 'text', text: versionTwoText(value, marker) }]), null);
  const valid = versionTwoText(value, { version: 2, id: ID_ONE, appIconPngBase64: ICON_PNG });
  assert.equal(parseSnapshotPresentation([image(value), { type: 'text', text: valid.replace('"version":2', '"version": 2') }]), null);
  assert.equal(parseSnapshotPresentation([image(capture({ snapshotId: ID_TWO })), { type: 'text', text: valid }]), null);
});

test('legacy, version-1 and version-2 records coexist with exact image pairing', () => {
  const values = [capture(), capture({ snapshotId: ID_ONE, title: 'Version one' }), capture({ snapshotId: ID_TWO, title: 'Version two', appIconPngBase64: ICON_PNG })];
  const body = '用户正文';
  const serialized = contextText(values[0]) + versionOneText(values[1]) + versionTwoText(values[2]);
  const content = freeze([...values.map(image), { type: 'text', text: body + serialized }]);
  const projected = parseSnapshotPresentation(content);
  assert.equal(projected.text, body);
  assert.deepEqual(projected.snapshots.map(item => item.id), [undefined, ID_ONE, ID_TWO]);
  assert.deepEqual(projected.snapshots.map(item => item.appIconPngBase64), [undefined, undefined, ICON_PNG]);
  assert.deepEqual(projected.snapshots.map(item => item.imageIndex), [0, 1, 2]);
  assert.equal(content.at(-1).text, body + serialized);
  assert.equal(parseSnapshotPresentation(body + serialized, [image(values[0]), image(values[2]), image(values[1])]), null);
});

test('Host-normalized WebP/JPEG snapshots keep their cards after reload across all metadata versions', () => {
  const versions = [
    { value: capture(), serialize: contextText },
    { value: capture({ snapshotId: ID_ONE }), serialize: versionOneText },
    { value: capture({ snapshotId: ID_TWO, appIconPngBase64: ICON_PNG }), serialize: versionTwoText },
  ];
  for (const { value, serialize } of versions) for (const mediaType of ['image/webp', 'image/jpeg']) {
    const normalized = { type: 'image', attachment: { ...image(value).attachment, attachmentId: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', mediaType, width: 800, height: 500, bytes: 741, originalDimensions: { width: 1200, height: 800 } } };
    // The Host can deduplicate two references to the same bytes. Only the
    // reference paired with the snapshot display name belongs to this card.
    const ordinary = { type: 'image', attachment: { ...normalized.attachment, name: 'ordinary-photo.webp' } };
    const original = freeze({ id: 'host-message', role: 'user', source: { kind: 'user', rpcId: 'host-request' }, content: [ordinary, normalized, { type: 'text', text: '用户正文' + serialize(value) }] });
    const before = JSON.stringify(original);
    const projected = projectSnapshotInboxMessage(original);
    assert.notEqual(projected, original);
    assert.equal(projected.snapshotPresentation.text, '用户正文');
    assert.equal(projected.snapshotPresentation.snapshots[0].image, normalized);
    assert.equal(projected.snapshotPresentation.snapshots[0].image.attachment.mediaType, mediaType);
    assert.equal(projected.snapshotPresentation.ordinaryContent[0], ordinary);
    assert.equal(projected.content[0], ordinary);
    assert.equal(projected.content[1], normalized);
    assert.equal(projected.source, original.source);
    assert.equal(projected.snapshotPresentation.snapshots[0].appIconPngBase64, value.appIconPngBase64);
    assert.equal(JSON.stringify(original), before);
    const restored = JSON.parse(before);
    const replayed = projectSnapshotInboxMessage(restored);
    assert.equal(replayed.snapshotPresentation.snapshots[0].filename, filename(value));
    assert.equal(replayed.snapshotPresentation.snapshots[0].image.attachment.mediaType, mediaType);
    assert.equal(replayed.snapshotPresentation.ordinaryContent[0], restored.content[0]);
    assert.equal(JSON.stringify(restored), before);
  }
});

test('admitted GIF references remain paired while unknown MIME and wrong names stay visible', () => {
  const value = capture({ snapshotId: ID_ONE });
  const gif = { type: 'image', attachment: { ...image(value).attachment, mediaType: 'image/gif' } };
  assert.equal(parseSnapshotPresentation([gif, { type: 'text', text: contextText(value) }]).snapshots[0].image, gif);
  for (const mediaType of ['image/svg+xml', 'image/avif', 'application/octet-stream', 'image/PNG', '', undefined]) {
    const content = freeze([{ type: 'image', attachment: { ...image(value).attachment, mediaType } }, { type: 'text', text: contextText(value) }]);
    const before = JSON.stringify(content);
    assert.equal(parseSnapshotPresentation(content), null);
    assert.equal(JSON.stringify(content), before);
  }
  for (const name of ['ordinary-photo.webp', filename(value).replace(ID_ONE, ID_TWO), filename(value).replace('.png', '.webp')]) {
    const content = freeze([{ type: 'image', attachment: { ...gif.attachment, mediaType: 'image/webp', name } }, { type: 'text', text: contextText(value) }]);
    const before = JSON.stringify(content);
    assert.equal(parseSnapshotPresentation(content), null);
    assert.equal(JSON.stringify(content), before);
  }
});
