import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import * as Cordis from '@deepseek-ai/cordis';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { contextText } from '../src/draft.mjs';
import { createSnapshotStore } from '../src/snapshot-store.mjs';

const require = createRequire(import.meta.url);
const Slots = await import(new URL('../.fixtures/ui-slots/index.js', import.meta.url));
const bundled = await build({ entryPoints: [fileURLToPath(new URL('../src/presentation.jsx', import.meta.url))], bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react', 'react-dom'], logLevel: 'silent' });
const presentationModule = { exports: {} };
runInNewContext(bundled.outputFiles[0].text, { module: presentationModule, exports: presentationModule.exports, require, console, setTimeout, clearTimeout, atob, btoa });
const { installSnapshotPresentation } = presentationModule.exports;
const attachmentsBundle = await build({ entryPoints: [fileURLToPath(new URL('../src/SnapshotAttachments.jsx', import.meta.url))], bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react', 'react-dom'], logLevel: 'silent' });
const attachmentsModule = { exports: {} };
runInNewContext(attachmentsBundle.outputFiles[0].text, { module: attachmentsModule, exports: attachmentsModule.exports, require, console, setTimeout, clearTimeout, atob, btoa });
const { SnapshotAttachments } = attachmentsModule.exports;

function officialModule(relative, expose, dependencies) {
  let loaded;
  const source = readFileSync(new URL(`../.fixtures/${relative}`, import.meta.url), 'utf8').replace('return module.exports;', `${expose} return module.exports;`);
  runInNewContext(source, { window: { __ModuleLoader__: { load: item => { loaded = item; } }, setTimeout, clearTimeout }, console, setTimeout, clearTimeout, queueMicrotask, URL, performance });
  return loaded.factory(id => {
    if (id.startsWith('react')) return require(id);
    if (id === '@deepseek-ai/cordis') return Cordis;
    if (id === '@deepseek-ai/dsh-client-ui-slots') return Slots;
    if (id in dependencies) return dependencies[id];
    throw new Error(`Unexpected official import ${id}`);
  });
}

const runtime = officialModule('ui-renderer/client.js', 'exports.ContractCreateSlotRenderer = createSlotRenderer;', {});
const copiedTexts = [];
const primitives = new Proxy({ writeClipboard: text => { copiedTexts.push(text); return Promise.resolve(true); }, projectUserText: text => text, fileExtension: () => '.txt', fileSizeText: () => '', JsonBlock: ({ payload }) => React.createElement('code', {}, JSON.stringify(payload)) }, { get: (target, key) => target[key] ?? (({ children }) => React.createElement(React.Fragment, {}, children)) });
const chat = officialModule('ui-chat/client.js', 'exports.ContractUser = UserMessageNodeView; exports.ContractPending = PendingSubmissionBubble; exports.ContractSteering = PendingSteeringBubble;', { '@deepseek-ai/dsh-client-store': {}, '@deepseek-ai/dsh-client-ui-primitives': primitives });
const conversation = officialModule('ui-conversation/client.js', 'exports.ContractQueue = QueueDock;', { '@deepseek-ai/dsh-client-store': {}, '@deepseek-ai/dsh-client-ui-primitives': primitives });
const icon = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN8sAAAAASUVORK5CYII=';
const capture = { appName: 'Google Chrome', title: 'Example page', text: 'PRIVATE AX CONTEXT', capturedAt: '2026-10-08T09:13:37.889Z', snapshotId: '12345678-1234-4234-8234-123456789abc', appIconPngBase64: icon };
const filename = `window-snapshot-${capture.snapshotId}-${capture.capturedAt.replace(/[^0-9TZ]/g, '-')}.png`;
const durableImage = { type: 'image', attachment: { attachmentId: 'own-image', mediaType: 'image/png', bytes: 80, width: 1, height: 1, name: filename } };
const ordinaryImage = { type: 'image', attachment: { ...durableImage.attachment, name: 'ordinary.png' } };
const text = `User body${contextText(capture)}`;
const source = { kind: 'user', rpcId: 'request-one' };
const content = [ordinaryImage, durableImage, { type: 'text', text }];
const pending = { requestId: 'request-one', placement: 'transcript', time: 1, text, attachments: [{ type: 'image', value: { previewUrl: 'blob:own-preview', name: filename, width: 1, height: 1 } }, { type: 'image', value: { previewUrl: 'blob:ordinary-preview', name: 'ordinary.png' } }] };
const inboxMessage = { id: 'message-one', role: 'user', source, content };
const observation = value => ({ getSnapshot: () => value, subscribe: () => () => {} });
const t = (key, params) => key === 'clock.time' ? '' : key;

function fixture({ mode = 'history', defer = false, durableMediaType = 'image/png', messageContent, pendingSubmission = pending, loadImage = async () => 'blob:loaded' } = {}) {
  const fixtureDurableImage = durableMediaType === durableImage.attachment.mediaType ? durableImage : { ...durableImage, attachment: { ...durableImage.attachment, mediaType: durableMediaType } };
  const fixtureOrdinaryImage = durableMediaType === ordinaryImage.attachment.mediaType ? ordinaryImage : { ...ordinaryImage, attachment: { ...ordinaryImage.attachment, mediaType: durableMediaType } };
  const fixtureContent = messageContent ?? (fixtureDurableImage === durableImage ? content : [fixtureOrdinaryImage, fixtureDurableImage, content.at(-1)]);
  const fixtureInboxMessage = fixtureContent === content ? inboxMessage : { ...inboxMessage, content: fixtureContent };
  const ctx = new Cordis.Context();
  const registry = new runtime.SlotRegistry(ctx);
  registry.install(runtime.ContractCreateSlotRenderer());
  registry.installLocale({ bind: () => t, getSnapshot: () => ({ revision: 0 }), subscribe: () => () => {} });
  const owner = new Cordis.Context();
  const session = { pendingSubmissions: mode === 'queue' ? [] : [mode === 'queuepending' ? { ...pendingSubmission, requestId: 'queued-new', placement: 'queued' } : pendingSubmission], running: false, openState: 'open', subagent: null };
  const inbox = { 'next-turn': [fixtureInboxMessage], 'next-step': [fixtureInboxMessage], unchangedClaim: 'keep' };
  const binding = { key: 'session-a', ctx: owner, hooks: { session: observation(session) }, keyedHooks: { projection: key => observation(key === 'inbox' ? inbox : undefined) }, props: { sessionId: 'session-a' } };
  const bindingSource = observation(binding);
  registry.installScope('session', { current: bindingSource, bindingSource: () => bindingSource, renderArea: (_binding, props) => props.children?.({}) });
  registry.register({ name: 'root', children: { 'conversation.view': { kind: 'list', scope: 'session' }, 'conversation.input.dock': { kind: 'list', scope: 'session' } } }, ({ renderSlot }) => React.createElement(React.Fragment, {}, renderSlot('conversation.view', {}), renderSlot('conversation.input.dock', {})));
  const storeInstance = { ...observation({ marker: 'original-store' }), actions: {} };
  let creates = 0;
  const store = { create: () => { creates += 1; return storeInstance; } };
  let received, renderSlotBinding, galleryImages;
  function OriginalView(props) {
    received = props;
    renderSlotBinding = props.renderSlot;
    assert.equal(props.useStore(snapshot => snapshot.marker), 'original-store');
    assert.equal(props.injectedMarker, 'original-inject');
    if (mode.startsWith('queue')) return null;
    const renderMessageImages = images => props.renderSlot('conversation.message.images', { ...images, loadImage });
    if (mode === 'pending') return React.createElement(chat.ContractPending, { submission: props.useSession(snapshot => snapshot.pendingSubmissions[0]), renderMessageImages, t });
    if (mode === 'steering') return React.createElement(chat.ContractSteering, { content: props.useProjection('inbox')['next-step'][0].content, renderMessageImages, t });
    return props.renderSlot('conversation.chat.node', { node: { kind: 'user', data: { kind: 'user', time: 1, content: fixtureContent, source } }, renderMessageImages, loadImage, openFile() {}, openSkill() {} }, { entryKey: 'user' });
  }
  const viewOptions = { name: 'conversation.view', id: 'chat', order: 0, label: 'Chat', locale: 'chat', store, inject: () => ({ injectedMarker: 'original-inject' }), children: { 'conversation.chat.node': { kind: 'keyed', scope: 'session' }, 'conversation.message.images': { kind: 'single', scope: 'session' } } };
  let disposeView;
  function registerView() {
    disposeView = registry.register(viewOptions, OriginalView);
    registry.register({ name: 'conversation.chat.node', key: 'user', locale: 'chat' }, chat.ContractUser);
    registry.register({ name: 'conversation.chat.node', key: 'steering', locale: 'chat' }, chat.ContractUser);
    registry.register({ name: 'conversation.message.images' }, ({ images }) => {
      galleryImages = images;
      return React.createElement('button', { 'data-ordinary-gallery': true }, images.map(image => image.attachment?.name ?? image.preview?.name).join(','));
    });
  }
  if (!defer) registerView();
  let queueProps, queueProjection, queueSession;
  registry.register({ name: 'conversation.input.dock', id: 'queue', order: 20, locale: 'conversation', inject: () => ({ updateQueue: () => Promise.resolve(), notify() {}, loadImage: async () => 'blob:queue' }) }, props => {
    queueProps = props;
    queueProjection = props.useProjection('inbox');
    queueSession = props.useSession(snapshot => snapshot);
    return React.createElement(conversation.ContractQueue, props);
  });
  let view;
  const render = async () => {
    await act(async () => { if (view) view.update(registry.renderSlot('root', {})); else view = TestRenderer.create(registry.renderSlot('root', {})); });
    return JSON.stringify(view.toJSON());
  };
  return { ctx, registry, session, inbox, content: fixtureContent, durableImage: fixtureDurableImage, ordinaryImage: fixtureOrdinaryImage, store, storeInstance, viewOptions, registerView, get disposeView() { return disposeView; }, OriginalView, render, get view() { return view; }, get received() { return received; }, get galleryImages() { return galleryImages; }, get queueProps() { return queueProps; }, get queueProjection() { return queueProjection; }, get queueSession() { return queueSession; }, get creates() { return creates; }, get renderSlotBinding() { return renderSlotBinding; }, async dispose() { await act(async () => { view?.unmount(); await ctx.fiber.dispose(); await owner.fiber.dispose(); }); } };
}

test('official registry retains one Chat cell, its child authorization, inject and store while projecting history', async () => {
  const f = fixture();
  const original = f.registry.entries('conversation.view')[0];
  const children = original.children, inject = original.inject, store = original.store;
  const before = await f.render();
  assert.match(before, /window_snapshot/);
  const stop = installSnapshotPresentation(f.ctx);
  await Promise.resolve();
  const markup = await f.render();
  assert.doesNotMatch(markup, /window_snapshot|PRIVATE AX CONTEXT|role="dialog"/);
  assert.match(markup, /data-snapshot-message-card/);
  assert.ok(markup.includes(`data:image/png;base64,${icon}`), 'durable source app icon reaches the history card');
  assert.match(markup, /Example page/);
  assert.match(markup, /User body/);
  assert.match(markup, /data-ordinary-gallery/);
  assert.match(markup, /ordinary.png/);
  assert.equal(f.registry.entriesOfSlot('conversation.view').length, 1);
  assert.equal(f.registry.entries('conversation.view').length, 1);
  assert.equal(f.registry.entries('conversation.view')[0], original);
  assert.equal(original.children, children);
  assert.equal(original.inject, inject);
  assert.equal(original.store, store);
  assert.equal(f.creates, 1);
  assert.equal(f.session.pendingSubmissions[0].text, text);
  assert.equal(f.inbox['next-turn'][0].content, content);
  const copy = f.view.root.findAll(node => node.type === 'button' && node.props['aria-label'] === 'copy')[0];
  await act(async () => { copy.props.onClick(); });
  assert.equal(copiedTexts.at(-1), 'User body');
  const bound = f.renderSlotBinding;
  assert.doesNotThrow(() => bound('conversation.chat.node', {}, { entryKey: 'user' }));
  stop();
  await Promise.resolve();
  assert.equal(original.component, f.OriginalView);
  assert.match(await f.render(), /window_snapshot/);
  assert.equal(f.creates, 1);
  assert.equal(f.registry.entries('conversation.view').length, 1);
  assert.doesNotThrow(() => bound('conversation.chat.node', {}, { entryKey: 'user' }));
  await f.dispose();
});

test('official user renderer projects a Host-transcoded WebP snapshot while ordinary WebP keeps its gallery', async t => {
  const f = fixture({ durableMediaType: 'image/webp' });
  let stop;
  t.after(async () => { stop?.(); await f.dispose(); });
  const originalContent = f.content, originalAttachment = f.durableImage.attachment;
  const originalValue = structuredClone(originalContent);
  assert.equal(f.durableImage.attachment.name, filename, 'Host preserves the original PNG capture filename');
  assert.equal(f.ordinaryImage.attachment.attachmentId, originalAttachment.attachmentId);
  assert.equal(f.ordinaryImage.attachment.bytes, originalAttachment.bytes);
  assert.match(await f.render(), /window_snapshot/);
  stop = installSnapshotPresentation(f.ctx);
  const markup = await f.render();
  assert.doesNotMatch(markup, /window_snapshot|PRIVATE AX CONTEXT|role="dialog"/);
  assert.match(markup, /data-snapshot-message-card/);
  assert.match(markup, /Example page/);
  assert.match(markup, /User body/);
  assert.ok(markup.includes(`data:image/png;base64,${icon}`));
  const galleries = f.view.root.findAll(node => node.type === 'button' && node.props['data-ordinary-gallery'] === true);
  assert.equal(galleries.length, 1);
  assert.deepEqual(galleries[0].children, ['ordinary.png']);
  assert.equal(f.galleryImages.length, 1);
  assert.equal(f.galleryImages[0].attachment, f.ordinaryImage.attachment);
  assert.equal(f.galleryImages[0].attachment.mediaType, 'image/webp');
  const copy = f.view.root.findAll(node => node.type === 'button' && node.props['aria-label'] === 'copy')[0];
  await act(async () => { copy.props.onClick(); });
  assert.equal(copiedTexts.at(-1), 'User body');
  assert.equal(f.inbox['next-turn'][0].content, originalContent);
  assert.equal(f.inbox['next-turn'][0].source, source);
  assert.equal(f.content[1].attachment, originalAttachment);
  assert.equal(originalAttachment.mediaType, 'image/webp');
  assert.deepEqual(f.content, originalValue);
});

for (const mode of ['pending', 'steering']) test(`official ${mode} component hides AX text and leaves ordinary galleries interactive`, async () => {
  const f = fixture({ mode });
  const stop = installSnapshotPresentation(f.ctx);
  await Promise.resolve();
  const markup = await f.render();
  assert.doesNotMatch(markup, /window_snapshot|PRIVATE AX CONTEXT|role="dialog"/);
  assert.match(markup, /data-snapshot-message-card/);
  assert.ok(markup.includes(`data:image/png;base64,${icon}`), 'source app icon reaches pending and steering cards');
  assert.match(markup, /Example page/);
  assert.match(markup, /ordinary.png/);
  assert.match(markup, /User body/);
  if (mode === 'steering') {
    // Same bytes/id in the original ordinary reference must not inherit cards.
    const images = f.registry.entries('conversation.message.images')[0].component;
    const ordinary = renderToStaticMarkup(React.createElement(images, { sessionId: 'session-a', images: [{ attachment: durableImage.attachment }] }));
    assert.match(ordinary, /data-ordinary-gallery/);
    assert.doesNotMatch(ordinary, /data-snapshot-message-card/);
  }
  stop();
  await f.dispose();
});

test('official slot declaration reload installs the adapters on fresh entries and restores after unload', async () => {
  const f = fixture({ defer: true });
  const stop = installSnapshotPresentation(f.ctx);
  f.registerView();
  await Promise.resolve();
  await Promise.resolve();
  assert.doesNotMatch(await f.render(), /window_snapshot/);
  const first = f.registry.entries('conversation.view')[0];
  await f.disposeView();
  f.registerView();
  await Promise.resolve();
  await Promise.resolve();
  const replacement = f.registry.entries('conversation.view')[0];
  assert.notEqual(replacement, first);
  assert.doesNotMatch(await f.render(), /window_snapshot/);
  assert.equal(f.registry.entriesOfSlot('conversation.view').length, 1);
  assert.equal(f.registry.entries('conversation.view').length, 1);
  stop();
  await Promise.resolve();
  assert.equal(replacement.component, f.OriginalView);
  assert.match(await f.render(), /window_snapshot/);
  await f.dispose();
});

for (const mode of ['queue', 'queuepending']) test(`official QueueDock ${mode} hides AX text without enabling image-message editing`, async () => {
  const f = fixture({ mode });
  const stop = installSnapshotPresentation(f.ctx);
  let markup = await f.render();
  assert.match(markup, /data-queue-dock/);
  assert.doesNotMatch(markup, /window_snapshot|PRIVATE AX CONTEXT/);
  if (mode === 'queuepending') {
    const header = f.view.root.find(node => node.type === 'button' && node.props['aria-expanded'] === false && node.props['aria-controls']);
    await act(async () => { header.props.onClick(); });
    markup = JSON.stringify(f.view.toJSON());
  }
  assert.match(markup, /User body/);
  assert.doesNotMatch(markup, /window_snapshot|PRIVATE AX CONTEXT/);
  const edit = f.view.root.findAll(node => node.type === 'button' && node.props['aria-label'] === 'queue.edit');
  assert.ok(edit.length > 0);
  assert.ok(edit.every(button => button.props.disabled === true));
  assert.equal(f.queueProjection.unchangedClaim, 'keep');
  assert.equal(f.queueProjection['next-turn'][0].content.filter(block => block.type === 'image').length, 2);
  assert.equal(f.inbox['next-turn'][0].content, content);
  assert.equal(f.inbox['next-turn'][0].source, source);
  if (mode === 'queuepending') {
    assert.equal(f.queueSession.pendingSubmissions[0].attachments, f.session.pendingSubmissions[0].attachments);
    assert.equal(f.queueSession.pendingSubmissions[0].text, 'User body');
    assert.equal(f.session.pendingSubmissions[0].text, text);
  }
  stop();
  await f.dispose();
});

test('real Cordis plugin unload restores mounted UI without new effects, extra tabs or collapsed children', async () => {
  const f = fixture();
  const original = f.registry.entries('conversation.view')[0];
  const fiber = await f.ctx.plugin({ name: 'snapshot-presentation-probe', inject: ['slots'], apply: ctx => { installSnapshotPresentation(ctx); } });
  assert.doesNotMatch(await f.render(), /window_snapshot/);
  assert.equal(f.registry.entries('conversation.view').length, 1);
  await act(async () => { await fiber.dispose(); });
  assert.equal(original.component, f.OriginalView);
  assert.equal(f.registry.entries('conversation.view').length, 1);
  assert.equal(f.registry.entries('conversation.chat.node').length, 2);
  assert.equal(f.creates, 1);
  // This is the already-mounted tree; no manual official refresh is needed.
  assert.match(JSON.stringify(f.view.toJSON()), /window_snapshot/);
  await f.dispose();
});

test('another component decorator survives unload and a retained adapter becomes transparent', async () => {
  const f = fixture();
  const stop = installSnapshotPresentation(f.ctx);
  const entry = f.registry.entries('conversation.view')[0];
  const retained = entry.component;
  const other = props => React.createElement(retained, props);
  entry.component = other;
  stop();
  assert.equal(entry.component, other);
  assert.match(await f.render(), /window_snapshot/);
  await f.dispose();
});

function previewButton(view, index = 0) {
  return view.root.findAll(node => node.type === 'button' && node.props['aria-label']?.startsWith('预览快照：'))[index];
}

function dialog(view) {
  return view.root.find(node => node.type === 'div' && node.props.role === 'dialog');
}

function button(view, label) {
  return view.root.find(node => node.type === 'button' && (node.props['aria-label'] === label || node.children.includes(label)));
}

async function click(node) {
  assert.ok(node, 'the requested action must be available');
  await act(async () => { node.props.onClick({ preventDefault() {}, stopPropagation() {} }); });
}

function outsidePreviewMarkup(view) {
  const omit = value => {
    if (Array.isArray(value)) return value.map(omit).filter(item => item !== null);
    if (!value || typeof value !== 'object') return value;
    if (value.props?.role === 'dialog') return null;
    return { ...value, children: value.children ? omit(value.children) : value.children };
  };
  return JSON.stringify(omit(view.toJSON()));
}

test('official WebP history preview loads through its authorized attachment loader and keeps AX out of the body', async t => {
  const loads = [];
  const f = fixture({ durableMediaType: 'image/webp', loadImage: reference => new Promise(resolve => loads.push({ reference, resolve })) });
  const originalContent = structuredClone(f.content);
  const stop = installSnapshotPresentation(f.ctx);
  t.after(async () => { stop(); await f.dispose(); });
  await f.render();
  assert.equal(loads.length, 1, 'thumbnail acquisition uses the Host attachment loader');
  await click(previewButton(f.view));
  assert.equal(loads.length, 2, 'preview can load before the thumbnail has completed');
  assert.ok(loads.every(load => load.reference === f.durableImage.attachment));
  assert.equal(f.durableImage.attachment.mediaType, 'image/webp');
  assert.match(dialog(f.view).findByProps({ role: 'status' }).children.join(''), /正在加载/);
  await act(async () => { loads[1].resolve('blob:authorized-webp'); });
  assert.equal(dialog(f.view).findByType('img').props.src, 'blob:authorized-webp');
  assert.equal(dialog(f.view).findByType('a').props.download, filename.replace(/\.png$/, '.webp'), 'download extension follows the admitted image format without renaming stored metadata');
  await click(button(f.view, '查看文本'));
  const plain = dialog(f.view).findByType('pre').children.join('');
  assert.match(plain, /Window: "Example page", App: Google Chrome/);
  assert.match(plain, /PRIVATE AX CONTEXT/);
  assert.doesNotMatch(plain, /window_snapshot|元数据：|窗口可访问文本：/);
  assert.doesNotMatch(outsidePreviewMarkup(f.view), /window_snapshot|PRIVATE AX CONTEXT/);
  await click(button(f.view, '关闭快照预览'));
  assert.equal(f.view.root.findAllByProps({ role: 'dialog' }).length, 0);
  await act(async () => { loads[0].resolve('blob:authorized-thumbnail'); });
  assert.equal(f.view.root.findAllByProps({ role: 'dialog' }).length, 0, 'late image completion must not reopen a closed preview');
  assert.deepEqual(f.content, originalContent);
  assert.equal(f.inbox['next-turn'][0].content, f.content);
  await click(button(f.view, 'copy'));
  assert.equal(copiedTexts.at(-1), 'User body');
});

for (const mode of ['pending', 'steering']) test(`official ${mode} preview reveals saved AX only inside the modal`, async t => {
  const f = fixture({ mode });
  const stop = installSnapshotPresentation(f.ctx);
  t.after(async () => { stop(); await f.dispose(); });
  await f.render();
  await click(previewButton(f.view));
  assert.ok(dialog(f.view).findByType('img').props.src.startsWith('blob:'));
  assert.equal(button(f.view, '查看文本').props['aria-pressed'], false);
  await click(button(f.view, '查看文本'));
  assert.match(dialog(f.view).findByType('pre').children.join(''), /PRIVATE AX CONTEXT/);
  assert.doesNotMatch(outsidePreviewMarkup(f.view), /window_snapshot|PRIVATE AX CONTEXT/);
  assert.equal(f.session.pendingSubmissions[0].text, text);
  assert.equal(f.inbox['next-step'][0].content, content);
  await click(button(f.view, '关闭快照预览'));
  assert.doesNotMatch(JSON.stringify(f.view.toJSON()), /window_snapshot|PRIVATE AX CONTEXT/);
});

test('multiple official history snapshots navigate, close with Escape and reopen in image mode', async t => {
  const secondCapture = { ...capture, title: 'Second page', text: 'SECOND SAVED AX', snapshotId: '22345678-1234-4234-8234-123456789abc' };
  const secondFilename = `window-snapshot-${secondCapture.snapshotId}-${secondCapture.capturedAt.replace(/[^0-9TZ]/g, '-')}.png`;
  const secondImage = { type: 'image', attachment: { ...durableImage.attachment, attachmentId: 'second-image', name: secondFilename } };
  const messageContent = [durableImage, secondImage, { type: 'text', text: `User body${contextText(capture)}${contextText(secondCapture)}` }];
  const f = fixture({ messageContent, loadImage: async reference => `blob:${reference.attachmentId}` });
  const stop = installSnapshotPresentation(f.ctx);
  t.after(async () => { stop(); await f.dispose(); });
  await f.render();
  await click(previewButton(f.view, 1));
  assert.equal(dialog(f.view).findByType('img').props.src, 'blob:second-image');
  await click(button(f.view, '查看文本'));
  assert.match(dialog(f.view).findByType('pre').children.join(''), /SECOND SAVED AX/);
  await click(button(f.view, '上一张快照'));
  assert.equal(dialog(f.view).findAllByType('pre').length, 0, 'navigation returns to the new image');
  assert.equal(dialog(f.view).findByType('img').props.src, 'blob:own-image');
  await click(button(f.view, '放大图片'));
  assert.notEqual(button(f.view, '适应窗口').children.join(''), '100%');
  await act(async () => { dialog(f.view).props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} }); });
  assert.equal(f.view.root.findAllByProps({ role: 'dialog' }).length, 0);
  await click(previewButton(f.view, 1));
  assert.equal(dialog(f.view).findByType('img').props.src, 'blob:second-image');
  assert.equal(dialog(f.view).findAllByType('pre').length, 0);
  assert.equal(button(f.view, '查看文本').props['aria-pressed'], false);
  assert.equal(button(f.view, '适应窗口').children.join(''), '100%', 'closing discards the previous zoom');
  assert.doesNotMatch(outsidePreviewMarkup(f.view), /window_snapshot|PRIVATE AX CONTEXT|SECOND SAVED AX/);
});

test('a late authorized image from the previous snapshot cannot replace the active preview', async t => {
  const secondCapture = { ...capture, title: 'Next page', text: 'NEXT AX', snapshotId: '32345678-1234-4234-8234-123456789abc' };
  const secondFilename = `window-snapshot-${secondCapture.snapshotId}-${secondCapture.capturedAt.replace(/[^0-9TZ]/g, '-')}.png`;
  const secondImage = { type: 'image', attachment: { ...durableImage.attachment, attachmentId: 'next-image', name: secondFilename } };
  const messageContent = [durableImage, secondImage, { type: 'text', text: `${contextText(capture)}${contextText(secondCapture)}` }];
  const loads = [];
  const f = fixture({ messageContent, loadImage: reference => new Promise(resolve => loads.push({ reference, resolve })) });
  const stop = installSnapshotPresentation(f.ctx);
  t.after(async () => { stop(); await f.dispose(); });
  await f.render();
  await click(previewButton(f.view));
  const firstPreviewLoad = loads.filter(load => load.reference === durableImage.attachment).at(-1);
  await click(button(f.view, '下一张快照'));
  const nextPreviewLoad = loads.filter(load => load.reference === secondImage.attachment).at(-1);
  await act(async () => { firstPreviewLoad.resolve('blob:late-first'); });
  assert.equal(dialog(f.view).findAllByType('img').length, 0);
  assert.match(dialog(f.view).props['aria-label'], /Next page/);
  await act(async () => { nextPreviewLoad.resolve('blob:active-next'); });
  assert.equal(dialog(f.view).findByType('img').props.src, 'blob:active-next');
  assert.equal(dialog(f.view).findByType('img').props.alt, 'Google Chrome：Next page');
});

test('legacy snapshots without AX show image preview without a text toggle', async t => {
  const legacyCapture = { ...capture, text: '', snapshotId: undefined, appIconPngBase64: undefined };
  const legacyFilename = `window-snapshot-${legacyCapture.capturedAt.replace(/[^0-9TZ]/g, '-')}.png`;
  const legacyImage = { type: 'image', attachment: { ...durableImage.attachment, name: legacyFilename } };
  const messageContent = [legacyImage, { type: 'text', text: `Legacy body${contextText(legacyCapture)}` }];
  const f = fixture({ messageContent });
  const stop = installSnapshotPresentation(f.ctx);
  t.after(async () => { stop(); await f.dispose(); });
  await f.render();
  await click(previewButton(f.view));
  assert.equal(dialog(f.view).findByType('img').props.src, 'blob:loaded');
  assert.equal(dialog(f.view).findAll(node => node.type === 'button' && node.children.includes('查看文本')).length, 0);
  assert.equal(dialog(f.view).findAllByType('pre').length, 0);
  assert.doesNotMatch(outsidePreviewMarkup(f.view), /window_snapshot|此窗口未提供可访问文本/);
});

test('draft preview and removal are independent actions and the ordinary attachment renderer survives', async t => {
  const snapshots = createSnapshotStore();
  snapshots.add('draft-one', 'session-a', capture);
  snapshots.add('draft-two', 'session-a', { ...capture, title: 'Second draft', text: 'SECOND DRAFT AX' });
  const attachments = [
    { id: 'draft-one', kind: 'image', previewUrl: 'blob:draft-one' },
    { id: 'draft-two', kind: 'image', previewUrl: 'blob:draft-two' },
    { id: 'ordinary-file', kind: 'file', name: 'ordinary.txt' },
  ];
  const removed = [];
  function DraftOwner() {
    const [current, setCurrent] = React.useState(attachments);
    return React.createElement(SnapshotAttachments, { snapshots, attachments: current, sessionId: 'session-a', canAcceptDrop: true,
      Fallback: ({ attachments: ordinary }) => React.createElement('button', { 'data-ordinary-file': true }, ordinary.map(item => item.name).join(',')),
      onRemoveAttachment: id => { removed.push(id); snapshots.delete(id); setCurrent(items => items.filter(item => item.id !== id)); },
    });
  }
  let view;
  t.after(async () => { await act(async () => { view?.unmount(); }); });
  await act(async () => { view = TestRenderer.create(React.createElement(DraftOwner)); });
  await click(previewButton(view));
  assert.equal(dialog(view).findByType('img').props.src, 'blob:draft-one');
  assert.deepEqual(removed, []);
  await click(button(view, '查看文本'));
  assert.match(dialog(view).findByType('pre').children.join(''), /PRIVATE AX CONTEXT/);
  await click(button(view, '下一张快照'));
  assert.equal(dialog(view).findByType('img').props.src, 'blob:draft-two');
  assert.equal(button(view, '查看文本').props['aria-pressed'], false);
  assert.deepEqual(removed, [], 'navigating the draft gallery must not remove an attachment');
  await click(button(view, '关闭快照预览'));
  await click(button(view, '移除快照：Second draft'));
  assert.deepEqual(removed, ['draft-two']);
  assert.equal(view.root.findAllByProps({ role: 'dialog' }).length, 0, 'removing a card never opens its preview');
  assert.ok(snapshots.get('draft-one'));
  assert.equal(snapshots.get('draft-two'), undefined);
  assert.deepEqual(view.root.findByProps({ 'data-ordinary-file': true }).children, ['ordinary.txt']);
  await click(previewButton(view));
  assert.equal(dialog(view).findAll(node => node.type === 'button' && node.props['aria-label'] === '下一张快照').length, 0);
  assert.equal(button(view, '查看文本').props['aria-pressed'], false);
});

test('an authorized image load failure retains saved text without leaking it into the official message', async t => {
  const f = fixture({ loadImage: async () => { throw new Error('attachment access denied'); } });
  const stop = installSnapshotPresentation(f.ctx);
  t.after(async () => { stop(); await f.dispose(); });
  await f.render();
  await click(previewButton(f.view));
  assert.match(dialog(f.view).findByProps({ role: 'status' }).children.join(''), /快照图片无法加载/);
  assert.equal(dialog(f.view).findAllByType('a').length, 0, 'failed loads do not offer an invalid download');
  await click(button(f.view, '查看文本'));
  assert.match(dialog(f.view).findByType('pre').children.join(''), /PRIVATE AX CONTEXT/);
  assert.doesNotMatch(outsidePreviewMarkup(f.view), /window_snapshot|PRIVATE AX CONTEXT/);
});

test('unloading the real Cordis presentation plugin dismisses an open preview and restores the official renderer', async t => {
  const f = fixture();
  t.after(async () => { await f.dispose(); });
  const original = f.registry.entries('conversation.view')[0];
  const fiber = await f.ctx.plugin({ name: 'snapshot-preview-unload-probe', inject: ['slots'], apply: ctx => { installSnapshotPresentation(ctx); } });
  await f.render();
  await click(previewButton(f.view));
  await click(button(f.view, '查看文本'));
  assert.equal(f.view.root.findAllByProps({ role: 'dialog' }).length, 1);
  await act(async () => { await fiber.dispose(); });
  assert.equal(f.view.root.findAllByProps({ role: 'dialog' }).length, 0);
  assert.equal(original.component, f.OriginalView);
  assert.equal(f.registry.entries('conversation.view').length, 1);
  assert.match(JSON.stringify(f.view.toJSON()), /window_snapshot/);
  assert.equal(f.content, content);
});
