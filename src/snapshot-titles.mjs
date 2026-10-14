import { snapshotTitleInput, firstSnapshotTitleInput } from './title-input.mjs';

const PROVIDER_ID = 'session-title-first-prompt-llm';

function methodDescriptor(object, name) {
  for (let current = object; current; current = Object.getPrototypeOf(current)) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor) return descriptor;
  }
  return undefined;
}

function restoreOwnedMethod(object, name, wrapper, previous) {
  // Cordis returns fresh traceable method proxies on reads. Inspect the own
  // descriptor instead of comparing object[name] with the installed function.
  if (Object.getOwnPropertyDescriptor(object, name)?.value !== wrapper) return;
  if (previous) Object.defineProperty(object, name, previous);
  else delete object[name];
}

/**
 * Adapt the verified Harness title provider without changing Agent input.
 * The registration field is a version-limited implementation adapter for
 * Harness 0.2.0-rc.2 / 0.2.1-alpha.1, not a public title service API.
 * Automatic title events retain their source-message seq and never pin a
 * user title. The caller owns the returned asynchronous effect disposer.
 */
export function installSnapshotTitles(ctx) {
  let warned = false;
  const warn = error => {
    if (warned) return;
    warned = true;
    ctx.logger?.warn?.(`快照自动标题适配未完全启用：${String(error?.message ?? error)}`);
  };
  const titles = ctx.get?.('sessionTitle');
  const sessions = ctx.get?.('sessions');
  if (typeof titles?.get !== 'function' || typeof sessions?.get !== 'function'
    || typeof ctx.on !== 'function' || typeof ctx.effect !== 'function') {
    warn('当前 Harness 未提供兼容的标题服务');
    return async () => {};
  }

  const lifetime = new AbortController();
  const activeCalls = new Set();
  const patches = new Map();
  let active = false;
  let registerWrapper, previousRegister;

  function wrapProvider(registration) {
    const provider = registration?.provider;
    if (registration?.closing || !provider || patches.has(provider)) return;
    if (provider.id !== PROVIDER_ID || provider.automatic !== 'first-prompt') return;
    const descriptor = methodDescriptor(provider, 'generate');
    if (typeof descriptor?.value !== 'function') { warn('标题提供方接口发生变化'); return; }
    const original = descriptor.value;
    const previous = Object.getOwnPropertyDescriptor(provider, 'generate');
    function generate(request, ...rest) {
      if (!active || request?.messages?.length === 0) return Reflect.apply(original, this, [request, ...rest]);
      let input;
      try { input = snapshotTitleInput(request.session, request.messages[0]); }
      catch (error) { warn(error); return Reflect.apply(original, this, [request, ...rest]); }
      if (input === null) return Reflect.apply(original, this, [request, ...rest]);
      const signal = AbortSignal.any([request.signal, lifetime.signal]);
      const projected = {
        ...request,
        signal,
        messages: [{ ...request.messages[0], text: input.text }, ...request.messages.slice(1)],
      };
      const receiver = this;
      const task = Promise.resolve().then(async () => {
        signal.throwIfAborted();
        const result = await Reflect.apply(original, receiver, [projected, ...rest]);
        signal.throwIfAborted();
        // A title response is a label, never serialized window context or an
        // explanation. Reject an invalid summary and retain the source title.
        if (typeof result?.title !== 'string' || /[\r\n]/.test(result.title)
          || /<\/?[a-z][^>]*>|^\s*(?:[\[{]|```|元数据：|窗口可访问文本：)/i.test(result.title)) {
          throw new Error('快照标题摘要格式无效，已保留来源标题');
        }
        return result;
      });
      activeCalls.add(task);
      const settled = () => activeCalls.delete(task);
      void task.then(settled, settled);
      return task;
    }
    try {
      Object.defineProperty(provider, 'generate', { ...descriptor, value: generate });
      patches.set(provider, { wrapper: generate, previous });
    } catch (error) { warn(error); }
  }

  function appendFallback(session, expectedSeq) {
    if (!active || sessions.get(session.id) !== session || session.header?.parentSession !== undefined) return;
    const input = firstSnapshotTitleInput(session);
    if (input === null || input.seq !== expectedSeq) return;
    const current = titles.get(session);
    if (current !== undefined && (current.source?.kind !== 'fallback'
      || current.messageSeqs?.length !== 1 || current.messageSeqs[0] !== input.seq)) return;
    if (current?.title === input.fallbackTitle) return;
    if (current !== undefined && !/^\s*<window_snapshot>/.test(current.title)) return;
    // Run after the originating append publishes: Session.append rejects
    // observer reentry. This event is log-only and does not affect model input.
    session.append('session/title', {
      title: input.fallbackTitle,
      messageSeqs: [input.seq],
      source: { kind: 'fallback' },
    });
  }

  function onEvent(session, event) {
    if (!active) return;
    const human = event.type === 'user/message' && event.data.source?.kind === 'user';
    const fallback = event.type === 'session/title' && event.data.source?.kind === 'fallback';
    if (!human && !fallback) return;
    let input;
    try { input = firstSnapshotTitleInput(session); }
    catch (error) { warn(error); return; }
    if (input === null || (human ? event.seq !== input.seq
      : event.data.messageSeqs?.length !== 1 || event.data.messageSeqs[0] !== input.seq
        || event.data.title === input.fallbackTitle)) return;
    queueMicrotask(() => {
      try { appendFallback(session, input.seq); }
      catch (error) { warn(error); }
    });
  }

  function onCreated(session) {
    if (!active || sessions.get(session.id) !== session) return;
    const current = titles.get(session);
    // Repair only an already-opened historical automatic XML fallback. Never
    // enumerate persisted sessions or request a second model summary on open.
    if (current?.source?.kind !== 'fallback' || !/^\s*<window_snapshot>/.test(current.title)) return;
    let input;
    try { input = firstSnapshotTitleInput(session); }
    catch (error) { warn(error); return; }
    if (input === null || current.messageSeqs?.length !== 1 || current.messageSeqs[0] !== input.seq) return;
    queueMicrotask(() => {
      try { appendFallback(session, input.seq); }
      catch (error) { warn(error); }
    });
  }

  return ctx.effect(() => {
    active = true;
    // A prepended observer queues the readable source title before the
    // official deferred fallback, while its synchronous scheduler still sees
    // no title and reserves the normal first-prompt model generation.
    const removeObserver = ctx.on('session/event', onEvent, { prepend: true });
    const removeCreated = ctx.on('session/created', onCreated);
    const register = methodDescriptor(titles, 'register');
    if (typeof register?.value !== 'function' || !Object.hasOwn(titles, 'registration')) {
      warn('当前 Harness 的标题注册接口不兼容，保留来源标题');
    } else {
      const originalRegister = register.value;
      previousRegister = Object.getOwnPropertyDescriptor(titles, 'register');
      registerWrapper = function (...args) {
        // Preserve the caller's Cordis shadow context and exact disposer. The
        // original provider continues to own registration and cancellation.
        const disposer = Reflect.apply(originalRegister, this, args);
        if (active) wrapProvider(this.registration);
        return disposer;
      };
      try {
        Object.defineProperty(titles, 'register', {
          value: registerWrapper, configurable: true, writable: true,
          enumerable: previousRegister?.enumerable ?? false,
        });
        wrapProvider(titles.registration);
      } catch (error) { warn(error); }
    }
    return async () => {
      active = false;
      removeObserver();
      removeCreated();
      lifetime.abort(new Error('snapshot title adapter disposed'));
      if (registerWrapper) restoreOwnedMethod(titles, 'register', registerWrapper, previousRegister);
      for (const [provider, patch] of patches) restoreOwnedMethod(provider, 'generate', patch.wrapper, patch.previous);
      patches.clear();
      while (activeCalls.size > 0) await Promise.allSettled([...activeCalls]);
    };
  }, 'snapshot title input adapter');
}
