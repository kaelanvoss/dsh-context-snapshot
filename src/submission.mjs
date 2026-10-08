import { contextText } from './draft.mjs';

const COMMAND_NOTICE = '窗口快照请作为普通消息发送，先移除当前 / 指令。';

/**
 * Version-fenced adapter over the published ConversationController methods.
 * Cordis accessors preserve the caller's service receiver and automatically
 * retire with the installing plugin fiber; no editor or prototype mutation.
 */
export function installSnapshotSubmission(ctx, store) {
  if (typeof ctx?.reflect?.accessor !== 'function' || typeof ctx?.effect !== 'function') throw new Error('当前 Harness 不支持快照发送适配，请使用插件支持的 Harness 版本。');
  if (!store || ['get', 'add', 'delete'].some(key => typeof store[key] !== 'function')) throw new Error('快照上下文存储不可用。');
  const conversation = ctx.conversation;
  const sessions = ctx.sessions;
  const methodNames = ['sendSession', 'serializeDraftAttachments', 'releaseDraftAttachment', 'resolveDraftAttachments', 'rebindDraftFiles'];
  const originals = Object.fromEntries(methodNames.map(name => [name, conversation?.[name]]));
  if (methodNames.some(name => typeof originals[name] !== 'function')) throw new Error('当前 Harness 的附件发送接口不兼容，请使用插件支持的 Harness 版本。');

  const disposers = [], flights = new Map();
  let disposed = false, released = false;
  const entriesFor = ids => {
    if (!Array.isArray(ids)) throw new Error('当前 Harness 的快照附件接口不兼容，请使用插件支持的 Harness 版本。');
    return [...new Set(ids)].map(id => store.get(id)).filter(Boolean);
  };
  const deleteIfCurrent = entry => { if (store.get(entry.id) === entry) store.delete(entry.id); };
  const markFlight = (entries, delta) => {
    for (const entry of entries) {
      const count = (flights.get(entry.id) ?? 0) + delta;
      if (count > 0) flights.set(entry.id, count);
      else flights.delete(entry.id);
    }
  };
  function cleanupRestored(entry, receiver) {
    if (store.get(entry.id) !== entry || flights.has(entry.id)) return;
    const binding = sessions?.binding?.(entry.sessionId);
    const input = binding ? conversation.input.for(binding.ctx) : undefined;
    if (input) {
      const state = input.state.getSnapshot();
      if (state.phase === 'adjudicating' || state.phase === 'submitting') {
        const unsubscribe = input.state.subscribe(() => {
          const phase = input.state.getSnapshot().phase;
          if (phase === 'adjudicating' || phase === 'submitting') return;
          unsubscribe();
          cleanupRestored(entry, receiver);
        });
        return;
      }
      input.removeAttachment(entry.id);
      // A refused removal must never free bytes that the composer retains.
      if (input.state.getSnapshot().attachmentIds.includes(entry.id)) return;
    }
    Reflect.apply(originals.releaseDraftAttachment, receiver, [entry.id]);
    if (Reflect.apply(originals.resolveDraftAttachments, receiver, [[entry.id]]).length === 0) deleteIfCurrent(entry);
  }
  const cleanAfterFailure = (entries, receiver) => {
    if (!disposed) return;
    // The submit shell restores attachments in its own promise continuation.
    // A timer runs after those continuations, including an empty-text send.
    setTimeout(() => {
      for (const entry of entries) {
        try { cleanupRestored(entry, receiver); }
        catch (error) { console.error('快照插件停用后的附件清理失败。', error); }
      }
    }, 0);
  };
  const install = (name, create) => {
    disposers.push(ctx.reflect.accessor(`conversation.${name}`, {
      get(receiver) {
        if (!receiver) throw new Error('快照发送缺少会话服务，无法继续。');
        return create(receiver);
      },
    }));
  };

  try {
    install('sendSession', receiver => async function (...args) {
      const [session, text, ids] = args;
      const entries = entriesFor(ids);
      if (!entries.length) return Reflect.apply(originals.sendSession, receiver, args);
      if (entries.some(entry => entry.sessionId !== session?.sessionId)) throw new Error('快照所属会话与发送会话不一致，请回到原会话发送或移除此快照。');
      if (typeof text !== 'string') throw new Error('当前 Harness 的消息文本接口不兼容，快照未发送。');
      // Capture this attempt before an asynchronous image encoder or a
      // subsequent composer change can alter its image-context association.
      const payload = args.slice();
      payload[1] = text + entries.map(entry => contextText(entry.capture)).join('');
      markFlight(entries, 1);
      let result;
      try { result = Reflect.apply(originals.sendSession, receiver, payload); }
      catch (error) { markFlight(entries, -1); cleanAfterFailure(entries, receiver); throw error; }
      return Promise.resolve(result).then(outcome => {
        markFlight(entries, -1);
        if (outcome?.kind === 'success') for (const entry of entries) deleteIfCurrent(entry);
        else cleanAfterFailure(entries, receiver);
        return outcome;
      }, error => {
        markFlight(entries, -1);
        cleanAfterFailure(entries, receiver);
        throw error;
      });
    });

    install('serializeDraftAttachments', receiver => function (...args) {
      if (entriesFor(args[0]).length) throw new Error(COMMAND_NOTICE);
      return Reflect.apply(originals.serializeDraftAttachments, receiver, args);
    });

    install('releaseDraftAttachment', receiver => function (...args) {
      const entry = store.get(args[0]);
      const result = Reflect.apply(originals.releaseDraftAttachment, receiver, args);
      if (entry && Reflect.apply(originals.resolveDraftAttachments, receiver, [[entry.id]]).length === 0) deleteIfCurrent(entry);
      return result;
    });

    install('rebindDraftFiles', receiver => function (...args) {
      const [sessionId, ids] = args;
      const entries = entriesFor(ids);
      if (entries.length && (typeof sessionId !== 'string' || !sessionId)) throw new Error('快照迁移缺少目标会话标识。');
      const result = Reflect.apply(originals.rebindDraftFiles, receiver, args);
      for (const entry of entries) {
        if (store.get(entry.id) === entry) store.add(entry.id, sessionId, entry.capture);
      }
      return result;
    });
    // Reflection accessors already follow the fiber; this state marker also
    // protects detached sends when the caller relies on automatic unloading.
    disposers.push(ctx.effect(() => () => { disposed = true; }, 'snapshot submission lifecycle'));
  } catch (error) {
    for (const dispose of [...disposers].reverse()) void dispose();
    throw error;
  }

  return async () => {
    if (released) return;
    released = true;
    disposed = true;
    for (const dispose of [...disposers].reverse()) await dispose();
  };
}
