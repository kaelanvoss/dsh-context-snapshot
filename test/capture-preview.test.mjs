import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
async function load(entry, globals = {}) {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL(entry, import.meta.url))], bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react', 'react-dom'], logLevel: 'silent' });
  const module = { exports: {} };
  runInNewContext(bundled.outputFiles[0].text, { module, exports: module.exports, require, console, setTimeout, clearTimeout, atob, btoa, ...globals });
  return module.exports;
}
const { SnapshotCard } = await load('../src/SnapshotCard.jsx');
const { snapshotPreviewText, snapshotQualityLabel } = await load('../src/SnapshotPreview.jsx');
const capture = {
  appName: 'Chrome', title: 'Pipeline', capturedAt: '2026-10-09T05:00:01Z', text: 'button Run (disabled)',
  captureQuality: { status: 'partial', reasons: ['node_limit'], textSource: 'ax', nodeCount: 300, scope: 'foreground_window' },
  source: { url: 'https://example.test/pipeline', selectedText: 'Build failed', focusedRole: 'button', focusedName: 'Run' },
  timing: { imageCapturedAt: '2026-10-09T05:00:00Z', textStartedAt: '2026-10-09T05:00:00.010Z', textFinishedAt: '2026-10-09T05:00:01Z' },
};

test('quality and independently captured source/state appear only in saved preview details', () => {
  const text = snapshotPreviewText(capture);
  assert.match(text, /Window: "Pipeline", App: Chrome/);
  assert.match(text, /URL: https:\/\/example.test\/pipeline/);
  assert.match(text, /选中文字：Build failed/);
  assert.match(text, /聚焦控件：button · Run/);
  assert.match(text, /采集状态：文字部分获取/);
  assert.match(text, /控件数量达到采集上限/);
  assert.match(text, /图片采集：2026-10-09T05:00:00Z/);
  assert.match(text, /文字采集：2026-10-09T05:00:00.010Z → 2026-10-09T05:00:01Z/);
  assert.match(text, /button Run \(disabled\)/);
  const markup = renderToStaticMarkup(React.createElement(SnapshotCard, { capture, src: 'blob:saved' }));
  assert.match(markup, /文字部分获取/);
  assert.doesNotMatch(markup, /Build failed|example\.test|node_limit|button Run/);
  assert.match(markup, /--dsw-alias-bg-module-platform/);
  assert.match(markup, /--dsw-alias-label-primary/);
});

test('successful capture stays compact without a quality badge or a completeness claim', () => {
  const available = { ...capture, captureQuality: { status: 'available', reasons: [], textSource: 'uia', nodeCount: 10 } };
  const markup = renderToStaticMarkup(React.createElement(SnapshotCard, { capture: available, src: 'blob:saved' }));
  assert.doesNotMatch(markup, /data-snapshot-quality|文字已获取|完整/);
  assert.equal(snapshotQualityLabel(available), '');
  assert.match(snapshotPreviewText(available), /文字已获取/);
  assert.match(snapshotPreviewText(available), /Windows UI Automation/);
  assert.equal(snapshotQualityLabel({ text: 'legacy AX' }), '');
  assert.doesNotMatch(snapshotPreviewText({ ...capture, captureQuality: undefined }), /采集状态/);
});

test('image-only capture keeps source, time and reason available in image and text modes', async t => {
  const imageOnly = { ...capture, text: '', captureQuality: { status: 'image_only', reasons: ['ui_automation_timeout'], textSource: 'uia' } };
  let view;
  t.after(async () => { await act(async () => view?.unmount()); });
  await act(async () => { view = TestRenderer.create(React.createElement(SnapshotCard, { capture: imageOnly, src: 'blob:existing-capture' })); });
  const previewButton = view.root.find(node => node.type === 'button' && node.props['aria-label']?.startsWith('预览快照：'));
  await act(async () => previewButton.props.onClick());
  const dialog = view.root.findByProps({ role: 'dialog' });
  const imageMarkup = JSON.stringify(dialog.toJSON?.() ?? view.toJSON());
  assert.ok(dialog.findAll(node => node.type === 'div' && node.children.join('') === 'Pipeline · Chrome').length);
  assert.match(imageMarkup, /2026-10-09T05:00:01Z/);
  assert.match(imageMarkup, /仅图片/);
  assert.equal(dialog.findByType('img').props.src, 'blob:existing-capture');
  const textButton = dialog.find(node => node.type === 'button' && node.children.includes('查看文本'));
  await act(async () => textButton.props.onClick());
  const text = view.root.findByType('pre').children.join('');
  assert.match(text, /本次快照未获取到可访问文字；请查看图片/);
  assert.match(text, /可访问内容采集超时/);
  assert.match(text, /Captured: 2026-10-09T05:00:01Z/);
  assert.match(text, /URL: https:\/\/example.test\/pipeline/);
  assert.doesNotMatch(text, /window_snapshot/);
});

test('legacy image-only previews expose the saved source without inventing a failure cause', () => {
  const text = snapshotPreviewText({ appName: 'Legacy', title: 'Old window', capturedAt: '2026-10-08T05:00:00Z', text: '此窗口未提供可访问文本；请查看图片。' });
  assert.match(text, /Window: "Old window", App: Legacy/);
  assert.match(text, /Captured: 2026-10-08T05:00:00Z/);
  assert.doesNotMatch(text, /权限|超时|采集说明/);
});

test('v3 card restores its app icon from local display metadata without exposing that metadata in text', async t => {
  const id = '12345678-1234-4234-8234-123456789abe';
  const icon = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN8sAAAAASUVORK5CYII=';
  const calls = [];
  const { SnapshotCard: CurrentCard } = await load('../src/SnapshotCard.jsx', {
    fetch: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ metadata: { [id]: { appIconPngBase64: icon } } }) }; },
  });
  let view;
  t.after(async () => { await act(async () => view?.unmount()); });
  await act(async () => { view = TestRenderer.create(React.createElement(CurrentCard, { capture: { ...capture, id }, src: 'blob:saved-v3' })); });
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].options.body), { op: 'snapshotMetadata', snapshotIds: [id] });
  assert.ok(view.root.findAll(node => node.type === 'img' && node.props.src === `data:image/png;base64,${icon}`).length);
  const open = view.root.find(node => node.type === 'button' && node.props['aria-label']?.startsWith('预览快照：'));
  await act(async () => open.props.onClick());
  const textButton = view.root.find(node => node.type === 'button' && node.children.includes('查看文本'));
  await act(async () => textButton.props.onClick());
  assert.doesNotMatch(view.root.findByType('pre').children.join(''), /appIconPngBase64|iVBOR/);
});
