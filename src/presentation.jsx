import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { projectSnapshotInboxMessage, projectSnapshotNode, projectSnapshotPendingSubmission } from './presentation-data.mjs';
import { SnapshotCard } from './SnapshotCard.jsx';

const TARGETS = [
  ['conversation.view', entry => entry.options.id === 'chat', 'view'],
  ['conversation.input.dock', entry => entry.options.id === 'queue', 'view'],
  ['conversation.chat.node', entry => ['user', 'steering'].includes(entry.options.key), 'node'],
  ['conversation.message.images', () => true, 'images'],
];

function imageSource(block) {
  if (block.attachment) return { attachment: block.attachment };
  if (block.value) return { preview: { url: block.value.previewUrl, name: block.value.name } };
  return block;
}

function imageKey(sessionId, image) {
  return image.attachment?.attachmentId ? `${sessionId}:attachment:${image.attachment.attachmentId}`
    : image.preview?.url ? `${sessionId}:preview:${image.preview.url}` : null;
}

function previewItem(snapshot, image, loadImage) {
  return { capture: snapshot, src: image.preview?.url, mediaType: image.attachment?.mediaType,
    ...(image.attachment && typeof loadImage === 'function' ? { loadSrc: () => loadImage(image.attachment) } : {}) };
}

/** Saved snapshot preview; attachment loading remains session-authorized. */
export function StaticSnapshotCard({ snapshot, image, loadImage, previewItems, previewIndex }) {
  const preview = image.preview?.url;
  const [loaded, setLoaded] = useState(null);
  useEffect(() => {
    if (preview || !image.attachment || typeof loadImage !== 'function') return undefined;
    let alive = true;
    Promise.resolve().then(() => loadImage(image.attachment)).then(
      url => { if (alive) setLoaded({ attachment: image.attachment, url }); },
      () => { /* The source label remains available when its image cannot load. */ },
    );
    return () => { alive = false; };
  }, [preview, image.attachment, loadImage]);
  const src = preview || (loaded?.attachment === image.attachment ? loaded.url : null);
  return <span data-snapshot-message-card><SnapshotCard capture={snapshot} src={src} previewItems={previewItems || [previewItem(snapshot, image, loadImage)]} previewIndex={previewIndex} /></span>;
}

/**
 * Presentation adapter for the two supported Harness releases. The original
 * registration identity owns its child-slot authorization and store; decorating
 * its component avoids redeclaring those children. Every change is reversible.
 */
export function installSnapshotPresentation(ctx) {
  const slots = ctx.slots;
  if (['entries', 'register', 'subscribe', 'inject', 'getVersion', 'spec'].some(key => typeof slots?.[key] !== 'function') || typeof ctx.effect !== 'function') throw new Error('当前 Harness 不支持快照消息呈现，请使用插件支持的 Harness 版本。');
  const records = new Map(), previewMetadata = new Map(), sessionCache = new WeakMap(), inboxCache = new WeakMap(), inboxRowCache = new WeakMap(), listeners = new Set();
  let attachmentMetadata = new WeakMap();
  let revision = 0;
  const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
  const getRevision = () => revision;
  const useRevision = () => useSyncExternalStore(subscribe, getRevision, getRevision);
  const subscriptions = [];
  let active = true, released = false;

  const rememberPreviews = (presentation, sessionId) => {
    if (!presentation) return;
    for (const snapshot of presentation.snapshots) {
      const source = imageSource(snapshot.image);
      if (!source.preview?.url) continue;
      previewMetadata.set(imageKey(sessionId, source), { appName: snapshot.appName, title: snapshot.title, capturedAt: snapshot.capturedAt, text: snapshot.text, filename: snapshot.filename, appIconPngBase64: snapshot.appIconPngBase64 });
    }
  };
  const projectSession = (snapshot, sessionId) => {
    if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.pendingSubmissions)) return snapshot;
    let projected = sessionCache.get(snapshot);
    if (!projected) {
      const pendingSubmissions = snapshot.pendingSubmissions.map(projectSnapshotPendingSubmission);
      projected = pendingSubmissions.some((item, index) => item !== snapshot.pendingSubmissions[index]) ? { ...snapshot, pendingSubmissions } : snapshot;
      sessionCache.set(snapshot, projected);
    }
    for (const submission of projected.pendingSubmissions) rememberPreviews(submission.snapshotPresentation, sessionId);
    return projected;
  };
  const projectInbox = (snapshot, sessionId) => {
    if (!snapshot || typeof snapshot !== 'object') return snapshot;
    let projected = inboxCache.get(snapshot);
    if (!projected) {
      projected = snapshot;
      for (const key of ['next-turn', 'next-step']) {
        if (!Array.isArray(snapshot[key])) continue;
        const rows = snapshot[key].map(message => {
          const row = projectSnapshotInboxMessage(message);
          if (!row.snapshotPresentation) return row;
          if (inboxRowCache.has(row)) return inboxRowCache.get(row);
          const captures = new Map(row.snapshotPresentation.snapshots.map(capture => [capture.image, capture]));
          const content = row.content.map(block => {
            const capture = captures.get(block);
            if (!capture || !block.attachment) return block;
            // Only this view's cloned reference is tagged. An ordinary image
            // reusing the same durable bytes never inherits snapshot rendering.
            const attachment = { ...block.attachment };
            attachmentMetadata.set(attachment, { appName: capture.appName, title: capture.title, capturedAt: capture.capturedAt, text: capture.text, filename: capture.filename, appIconPngBase64: capture.appIconPngBase64 });
            return { ...block, attachment };
          });
          const projectedRow = { ...row, content };
          inboxRowCache.set(row, projectedRow);
          return projectedRow;
        });
        if (rows.some((row, index) => row !== snapshot[key][index])) projected = { ...projected, [key]: rows };
      }
      inboxCache.set(snapshot, projected);
    }
    for (const key of ['next-turn', 'next-step']) for (const message of projected[key] ?? []) rememberPreviews(message.snapshotPresentation, sessionId);
    return projected;
  };

  function viewWrapper(Fallback) {
    return function SnapshotViewPresentation(props) {
      const presentationRevision = useRevision();
      const useSession = useMemo(() => (selector, equal) => props.useSession(snapshot => selector(active ? projectSession(snapshot, props.sessionId) : snapshot), equal), [props.useSession, props.sessionId, presentationRevision]);
      const useProjection = useMemo(() => (key, selector, equal) => {
        if (typeof key !== 'string') return props.useProjection(key, selector, equal);
        return props.useProjection(key, snapshot => {
          const projected = active && key === 'inbox' ? projectInbox(snapshot, props.sessionId) : snapshot;
          return typeof selector === 'function' ? selector(projected) : projected;
        }, equal);
      }, [props.useProjection, props.sessionId, presentationRevision]);
      return <Fallback {...props} useSession={useSession} useProjection={useProjection} />;
    };
  }

  function nodeWrapper(Fallback) {
    return function SnapshotNodePresentation(props) {
      useRevision();
      const data = active ? projectSnapshotNode(props.node?.data) : props.node?.data;
      const presentation = data?.snapshotPresentation;
      if (data === props.node?.data || !presentation) return <Fallback {...props} />;
      const node = { ...props.node, data: { ...data, content: presentation.ordinaryContent } };
      const previewItems = presentation.snapshots.map(snapshot => previewItem(snapshot, imageSource(snapshot.image), props.loadImage));
      return <>
        <div data-snapshot-message-cards style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8, margin: '10px 0 6px' }}>{presentation.snapshots.map((snapshot, index) => <StaticSnapshotCard key={`${snapshot.filename}:${index}`} snapshot={snapshot} image={imageSource(snapshot.image)} loadImage={props.loadImage} previewItems={previewItems} previewIndex={index} />)}</div>
        <Fallback {...props} node={node} />
      </>;
    };
  }

  function imagesWrapper(Fallback) {
    return function SnapshotImagesPresentation(props) {
      useRevision();
      const ordinary = [], snapshots = [];
      for (const image of props.images) {
        const snapshot = active ? image.attachment ? attachmentMetadata.get(image.attachment) : previewMetadata.get(imageKey(props.sessionId, image)) : undefined;
        if (snapshot) snapshots.push({ snapshot, image });
        else ordinary.push(image);
      }
      if (!snapshots.length) return <Fallback {...props} />;
      const previewItems = snapshots.map(({ snapshot, image }) => previewItem(snapshot, image, props.loadImage));
      return <>
        {snapshots.map(({ snapshot, image }, index) => <StaticSnapshotCard key={`${imageKey(props.sessionId, image)}:${index}`} snapshot={snapshot} image={image} loadImage={props.loadImage} previewItems={previewItems} previewIndex={index} />)}
        {ordinary.length > 0 && <Fallback {...props} images={ordinary} />}
      </>;
    };
  }

  const wrappers = { view: viewWrapper, node: nodeWrapper, images: imagesWrapper };
  const pulse = name => {
    if (!slots.spec(name)) return;
    const entries = slots.entries(name), first = entries[0];
    if (!first) return;
    const priority = Math.max(0, ...entries.map(entry => entry.options.priority ?? 0)) + 1;
    const dispose = slots.register({ name, ...first.options, priority }, () => null);
    // Dispose synchronously before the ledger publishes its microtask batch;
    // even readers of raw entries see one Chat tab after installation.
    void dispose();
  };
  const refresh = (name, select, kind) => {
    if (!active) return;
    let changed = false;
    for (const entry of slots.entries(name)) {
      if (!select(entry) || records.has(entry)) continue;
      const original = entry.component;
      if (typeof original !== 'function' && !(original && typeof original === 'object' && original.$$typeof)) throw new Error(`Harness ${name} 消息组件不兼容，无法呈现快照。`);
      const wrapped = wrappers[kind](original);
      entry.component = wrapped;
      records.set(entry, { original, wrapped, name });
      changed = true;
    }
    if (changed) pulse(name);
  };

  function stop() {
    if (released) return;
    released = true;
    active = false;
    for (const unsubscribe of subscriptions.splice(0).reverse()) void unsubscribe();
    for (const [entry, record] of records) {
      if (entry.component !== record.wrapped) continue;
      entry.component = record.original;
    }
    records.clear();
    previewMetadata.clear();
    attachmentMetadata = new WeakMap();
    // Mounted wrappers own this notification source. Restore immediately even
    // while Cordis is unloading, when registering a new effect is forbidden.
    revision += 1;
    for (const listener of [...listeners]) listener();
  }

  try {
    for (const [name, select, kind] of TARGETS) subscriptions.push(slots.inject(name, () => {
      const unsubscribe = slots.subscribe(name, () => refresh(name, select, kind));
      refresh(name, select, kind);
      return unsubscribe;
    }));
    ctx.effect(() => stop, 'snapshot message presentation');
  } catch (error) { stop(); throw error; }
  return stop;
}
