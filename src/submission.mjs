import { contextText } from './draft.mjs';
import { confirmedPromptRejection, UNCONFIRMED_SEND_NOTICE } from './send-intent.mjs';

const COMMAND_NOTICE = '窗口快照请作为普通消息发送，先移除当前 / 指令。';

/**
 * Version-fenced adapter over the published ConversationController methods.
 * Cordis accessors preserve the caller's service receiver and automatically
 * retire with the installing plugin fiber; no editor or prototype mutation.
 */
export function installSnapshotSubmission(ctx, store, persistence) {
  if (typeof ctx?.reflect?.accessor !== 'function' || typeof ctx?.effect !== 'function') throw new Error('当前 Harness 不支持快照发送适配，请使用插件支持的 Harness 版本。');
  if (!store || ['get', 'add', 'delete'].some(key => typeof store[key] !== 'function')) throw new Error('快照上下文存储不可用。');
  const conversation = ctx.conversation;
  const sessions = ctx.sessions;
  const methodNames = ['sendSession', 'serializeDraftAttachments', 'releaseDraftAttachment', 'resolveDraftAttachments', 'rebindDraftFiles'];
  const originals = Object.fromEntries(methodNames.map(name => [name, conversation?.[name]]));
  if (methodNames.some(name => typeof originals[name] !== 'function')) throw new Error('当前 Harness 的附件发送接口不兼容，请使用插件支持的 Harness 版本。');

  const disposers = [], flights = new Map(), flightSessions = new Map(), flightTasks = new Set();
  const removals = new Map(), acknowledgedRemovals = new Set();
  let disposed = false, released = false;
  const persistenceTasks = new Set();
  const pendingPersistence = new Map();
  let persistenceError;
  const track = (key, action) => {
    pendingPersistence.set(key, action);
    const promise = Promise.resolve().then(action);
    persistenceTasks.add(promise);
    promise.then(() => { if (pendingPersistence.get(key) === action) pendingPersistence.delete(key); }, error => {
      persistenceError = error;
      persistence?.onError?.(error);
    }).finally(() => persistenceTasks.delete(promise));
    return promise;
  };
  const flush = async () => {
    await Promise.allSettled([...persistenceTasks]);
    for (const [key, action] of [...pendingPersistence]) await track(key, action).catch(() => {});
    await persistence?.flush();
    if (pendingPersistence.size) throw new Error(`快照草稿存储未确认：${persistenceError?.message || '请重试'}`);
    persistenceError = undefined;
  };
  store.removalPending = new Set();
  if (persistence) {
    store.flushPersistence = flush;
    store.removeDurably = async (id, removeAction) => {
      const entry = store.get(id);
      if (!entry) return removeAction();
      if (store.removalPending.has(id)) return;
      store.removalPending.add(id);
      let finish;
      const removal = { acknowledged: false, decision: new Promise(resolve => { finish = resolve; }) };
      removals.set(id, removal);
      const key = `user-remove:${entry.capture.snapshotId}`;
      try {
        await track(key, () => persistence.remove(entry.capture.snapshotId));
        removal.acknowledged = true;
        acknowledgedRemovals.add(entry.capture.snapshotId);
        if (acknowledgedRemovals.size > 128) acknowledgedRemovals.delete(acknowledgedRemovals.values().next().value);
        finish();
        let actionCalled = false;
        while (true) {
          // Workspace selection can carry this same registry id while the
          // Host deletion is awaiting its reply. Follow the latest binding.
          const current = store.get(id);
          if (!current) { if (!actionCalled) removeAction(); break; }
          const binding = sessions?.binding?.(current.sessionId);
          const input = binding ? conversation.input.for(binding.ctx) : undefined;
          if (input && ['adjudicating', 'submitting'].includes(input.state.getSnapshot().phase)) {
            await new Promise(resolve => {
              let unsubscribeInput = () => {}, unsubscribeStore = () => {};
              const check = () => {
                if (store.get(id) === current && ['adjudicating', 'submitting'].includes(input.state.getSnapshot().phase)) return;
                unsubscribeInput(); unsubscribeStore(); resolve();
              };
              unsubscribeInput = input.state.subscribe(check);
              unsubscribeStore = store.subscribe(check);
              check();
            });
            continue;
          }
          if (input) {
            input.removeAttachment(id);
            if (input.state.getSnapshot().attachmentIds.includes(id)) throw new Error('当前会话尚未移除快照图片，请稍后重试。');
          }
          if (!actionCalled) { actionCalled = true; removeAction(); }
          if (store.get(id) && store.get(id) !== current) continue;
          conversation.releaseDraftAttachment(id);
          if (Reflect.apply(originals.resolveDraftAttachments, conversation, [[id]]).length === 0 && store.get(id) === current) store.delete(id);
          break;
        }
      } catch (error) {
        // Storage failures are already surfaced by track. A Host cleanup
        // failure after acknowledgement must use that same status surface.
        if (removal.acknowledged) persistence.onError?.(error);
        throw error;
      } finally {
        // A failed explicit removal leaves its card for a user retry. Accepted
        // sends have their own automatic cleanup reconciliation above.
        pendingPersistence.delete(key);
        store.removalPending.delete(id);
        removals.delete(id);
        finish();
      }
    };
  }
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
  store.hasInFlightSession = sessionId => (flightSessions.get(sessionId) ?? 0) > 0;
  store.getInFlightSessions = () => [...flightSessions.keys()];
  store.waitForInFlight = async () => { while (flightTasks.size) await Promise.all([...flightTasks]); };
  const startFlight = (entries, sessionId) => {
    let finish;
    const settled = new Promise(resolve => { finish = resolve; });
    flightTasks.add(settled);
    flightSessions.set(sessionId, (flightSessions.get(sessionId) ?? 0) + 1);
    markFlight(entries, 1);
    return () => {
      markFlight(entries, -1);
      const count = flightSessions.get(sessionId) - 1;
      if (count) flightSessions.set(sessionId, count);
      else flightSessions.delete(sessionId);
      flightTasks.delete(settled);
      finish();
    };
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
      if (ids.some(id => store.removalPending.has(id))) throw new Error('正在移除快照，请等待完成后再发送。');
      if (!entries.length) return Reflect.apply(originals.sendSession, receiver, args);
      if (disposed) throw new Error('快照插件已停用，未开始新的快照发送。');
      if (entries.some(entry => entry.sessionId !== session?.sessionId)) throw new Error('快照所属会话与发送会话不一致，请回到原会话发送或移除此快照。');
      if (typeof text !== 'string') throw new Error('当前 Harness 的消息文本接口不兼容，快照未发送。');
      // Capture this attempt before an asynchronous image encoder or a
      // subsequent composer change can alter its image-context association.
      const payload = args.slice();
      payload[1] = text + entries.map(entry => contextText(entry.capture)).join('');
      // Reserve the session before any Host round trip. Runtime scope teardown
      // may retire live metadata while this already-started send still owns it.
      const finishFlight = startFlight(entries, session.sessionId);
      let leaseTimer, leaseTask;
      const snapshotIds = entries.map(entry => entry.capture.snapshotId);
      const attemptId = persistence ? globalThis.crypto.randomUUID() : undefined;
      let intentRequested = false, intentAcknowledged = false, promptInvoked = false, promptReceipt;
      if (persistence) {
        // Observe this attempt's actual RemoteResult, never the Session's
        // mutable last-error slot. Another composer can change that slot.
        payload[0] = new Proxy(session, { get(target, key) {
          const value = Reflect.get(target, key, target);
          if (key === 'prompt') return async (...promptArgs) => {
            promptInvoked = true;
            const receipt = await Reflect.apply(value, target, promptArgs);
            promptReceipt = receipt;
            return receipt;
          };
          return typeof value === 'function' ? value.bind(target) : value;
        } });
      }
      const clearConfirmedIntent = async rejectionCode => {
        await persistence.rejectSend(session.sessionId, snapshotIds, attemptId, rejectionCode);
        for (const id of snapshotIds) { store.unconfirmedSends?.delete(id); store.unconfirmedRecords?.delete(id); }
      };
      const leaseAbort = persistence ? new AbortController() : null;
      const originalSignal = args[4];
      const abortOriginal = () => leaseAbort?.abort(originalSignal.reason);
      const stopLease = async () => {
        if (leaseTimer) { clearInterval(leaseTimer); leaseTimer = undefined; }
        originalSignal?.removeEventListener('abort', abortOriginal);
        await leaseTask;
      };
      try {
        if (persistence) {
          await flush();
          if (snapshotIds.some(id => store.unconfirmedSends?.has(id))) throw new Error(UNCONFIRMED_SEND_NOTICE);
          await persistence.renew(session.sessionId, snapshotIds);
          originalSignal?.throwIfAborted?.();
          intentRequested = true;
          await persistence.beginSend(session.sessionId, snapshotIds, attemptId);
          intentAcknowledged = true;
          for (const entry of entries) {
            store.unconfirmedSends?.add(entry.capture.snapshotId);
            store.unconfirmedRecords?.set(entry.capture.snapshotId,
              { sessionId: session.sessionId, capturedAt: entry.capture.capturedAt });
          }
        }
        if (leaseAbort) {
          if (originalSignal?.aborted) abortOriginal();
          else originalSignal?.addEventListener('abort', abortOriginal, { once: true });
          payload[4] = leaseAbort.signal;
          leaseTimer = setInterval(() => {
            if (leaseTask) return;
            leaseTask = persistence.renew(session.sessionId, snapshotIds).catch(error => {
              persistence.onError?.(error);
              leaseAbort.abort(error);
            }).finally(() => { leaseTask = undefined; });
          }, 3500);
        }
        const outcome = await Reflect.apply(originals.sendSession, receiver, payload);
        await stopLease();
        if (outcome?.kind === 'success') for (const entry of entries) {
          if (persistence && entry.capture.snapshotId) {
            // The Host already accepted the send. Never turn a local cleanup
            // failure into a failed send that would duplicate the model request.
            await track(`remove:${entry.capture.snapshotId}`, () => persistence.remove(entry.capture.snapshotId)).catch(() => {});
          }
          store.unconfirmedSends?.delete(entry.capture.snapshotId);
          store.unconfirmedRecords?.delete(entry.capture.snapshotId);
          deleteIfCurrent(entry);
        }
        else {
          if (persistence) {
            const rejectionCode = promptInvoked ? confirmedPromptRejection(promptReceipt) : 'client/not-dispatched';
            if (rejectionCode) await track(`reject:${attemptId}`, () => clearConfirmedIntent(rejectionCode)).catch(() => {});
            else persistence.onError?.(new Error(UNCONFIRMED_SEND_NOTICE));
          }
          cleanAfterFailure(entries, receiver);
        }
        return outcome;
      } catch (error) {
        await stopLease();
        if (persistence && intentRequested && !promptInvoked) {
          // The official original method has not invoked Session.prompt.
          // Intent ACK loss or failed local image encoding cannot have
          // admitted this attempt's payload to the Host.
          if (intentAcknowledged) await track(`reject:${attemptId}`, () => clearConfirmedIntent('client/not-dispatched')).catch(() => {});
          else await clearConfirmedIntent('client/not-dispatched').catch(() => {});
        } else if (persistence && promptInvoked) persistence.onError?.(new Error(UNCONFIRMED_SEND_NOTICE));
        cleanAfterFailure(entries, receiver);
        throw error;
      } finally { finishFlight(); }
    });

    install('serializeDraftAttachments', receiver => function (...args) {
      if (entriesFor(args[0]).length) throw new Error(COMMAND_NOTICE);
      return Reflect.apply(originals.serializeDraftAttachments, receiver, args);
    });

    install('releaseDraftAttachment', receiver => function (...args) {
      const entry = store.get(args[0]);
      const result = Reflect.apply(originals.releaseDraftAttachment, receiver, args);
      if (entry && Reflect.apply(originals.resolveDraftAttachments, receiver, [[entry.id]]).length === 0) {
        const explicitRemoval = store.removalIntents?.delete(entry.id) === true;
        if (persistence && explicitRemoval && !store.removalPending.has(entry.id) && !disposed && !store.preserveDrafts && !flights.has(entry.id) && entry.capture.snapshotId) track(`remove:${entry.capture.snapshotId}`, () => persistence.remove(entry.capture.snapshotId));
        deleteIfCurrent(entry);
      }
      return result;
    });

    install('rebindDraftFiles', receiver => function (...args) {
      const [sessionId, ids] = args;
      const entries = entriesFor(ids);
      if (entries.length && (typeof sessionId !== 'string' || !sessionId)) throw new Error('快照迁移缺少目标会话标识。');
      if (persistence && entries.some(entry => flights.has(entry.id) || store.unconfirmedSends?.has(entry.capture.snapshotId))) throw new Error(UNCONFIRMED_SEND_NOTICE);
      const result = Reflect.apply(originals.rebindDraftFiles, receiver, args);
      if (persistence && entries.length) {
        const snapshotIds = entries.map(entry => entry.capture.snapshotId);
        const pendingRemovals = entries.map(entry => removals.get(entry.id)).filter(Boolean);
        track(`rebind:${snapshotIds.join(',')}`, async () => {
          await Promise.all(pendingRemovals.map(removal => removal.decision));
          const retained = snapshotIds.filter(snapshotId => !acknowledgedRemovals.has(snapshotId));
          if (retained.length) await persistence.rebindMany(retained, sessionId);
        });
      }
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
