import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import SessionStore, { SessionId } from '../../.fixtures/host/node_modules/@deepseek-ai/dsh-session/lib/index.js';
import SessionProjectionRegistry from '../../.fixtures/host/node_modules/@deepseek-ai/dsh-session-projection/lib/index.js';
import SessionTitleService from '../../.fixtures/host/node_modules/@deepseek-ai/dsh-session-title/lib/index.js';
import LlmRuntime, { LlmAdapter, createUserMessage } from '../../.fixtures/host/node_modules/@deepseek-ai/dsh-llm/lib/index.js';
import { registerSessionTitleLlmProvider } from '../../.fixtures/host/node_modules/@deepseek-ai/dsh-session-title-llm/lib/index.js';
import { contextText } from '../../src/draft.mjs';

export { createUserMessage, SessionId };
export const TITLE_PROVIDER = 'session-title-first-prompt-llm';
export const TITLE_FRAME_PREFIX = 'Generate the session title from this JSON array of human messages:\n';
export const TITLE_CONFIG = Object.freeze({ targetWords: 5, targetCjkCharacters: 10, maxInputBytes: 4096,
  maxOutputTokens: 32, timeoutMs: 1000 });
const defaultRuntime = { SessionStore, SessionId, SessionProjectionRegistry, SessionTitleService, LlmRuntime,
  registerSessionTitleLlmProvider };
let alphaRuntime;
async function officialRuntime(version) {
  if (version === '0.2.0-rc.2') return defaultRuntime;
  if (version !== '0.2.1-alpha.1') throw new Error(`Unsupported fixture version: ${version}`);
  alphaRuntime ??= Promise.all(['dsh-session', 'dsh-session-projection', 'dsh-session-title', 'dsh-llm', 'dsh-session-title-llm']
    .map(name => import(new URL(`../../.fixtures/host-alpha/node_modules/@deepseek-ai/${name}/lib/index.js`, import.meta.url))))
    .then(([session, projection, title, llm, helper]) => ({ SessionStore: session.default, SessionId: session.SessionId,
      SessionProjectionRegistry: projection.default, SessionTitleService: title.default, LlmRuntime: llm.default,
      registerSessionTitleLlmProvider: helper.registerSessionTitleLlmProvider }));
  return alphaRuntime;
}

export function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

function untilAborted(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Real official LLM runtime; only the remote transport is a controlled seat. */
class TitleAdapter extends LlmAdapter {
  constructor(requests, respond) { super(); this.requests = requests; this.respond = respond; }
  async * stream(options) {
    this.requests.push(options);
    const response = await untilAborted(this.respond(options, this.requests.length), options.signal);
    if (response instanceof Error) throw response;
    if (Array.isArray(response)) {
      for (const chunk of response) yield chunk;
      return;
    }
    yield { type: 'text-delta', index: 0, text: response };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

/** Compose published Host services without substituting title/projection logic. */
export async function officialTitleRuntime(t, { respond = async () => '公开窗口内容', providerId = TITLE_PROVIDER,
  automatic = 'first-prompt', config = {}, registerProvider = true, version = '0.2.0-rc.2' } = {}) {
  const runtime = await officialRuntime(version);
  const ctx = new Context(), requests = [];
  await ctx.plugin(runtime.SessionStore);
  await ctx.plugin(runtime.SessionProjectionRegistry);
  await ctx.plugin(runtime.SessionTitleService, { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 });
  await ctx.plugin(runtime.LlmRuntime);
  ctx.llm.registerAdapter(['fixture-route'], new TitleAdapter(requests, respond));
  const register = () => {
    runtime.registerSessionTitleLlmProvider(ctx, { ...TITLE_CONFIG, ...config }, providerId, automatic, messages => [messages[0]]);
    return ctx.sessionTitle.registration.provider;
  };
  const provider = registerProvider ? register() : undefined;
  let stop;
  t?.after(async () => { await stop?.(); await ctx.fiber.dispose(); });
  return { ctx, requests, provider, register,
    setStop(value) { stop = value; },
    create(id = randomUUID(), options) {
      const session = ctx.sessions.create(runtime.SessionId(id), options);
      if (!options?.seed) session.append('turn/start', { turn: 1 });
      return session;
    },
  };
}

/** Saved-attachment-shaped public fixture, matching admitted WebP naming. */
export function snapshotContent({ body = '', title = '公开快照验收页', text = 'button 提交 (enabled=false)',
  source = { url: 'http://127.0.0.1:8769/', selectedText: 'SNAP-TITLE-READY' }, id = randomUUID(),
  before = [], image = true } = {}) {
  const capture = { snapshotId: id, appName: 'Fixture Browser', title, text,
    capturedAt: '2026-10-14T02:45:54.237Z', captureQuality: { status: 'available', reasons: [], textSource: 'ax', nodeCount: 3 },
    source, timing: { imageCapturedAt: '2026-10-14T02:45:54.237Z', textStartedAt: '2026-10-14T02:45:54.200Z', textFinishedAt: '2026-10-14T02:45:54.210Z' } };
  const filename = `window-snapshot-${id}-${capture.capturedAt.replace(/[^0-9TZ]/g, '-')}.png`;
  const content = [...before, ...(image ? [{ type: 'image', attachment: { attachmentId: `fixture-${id}`,
    mediaType: 'image/webp', bytes: 80, width: 1, height: 1, name: filename } }] : []),
    { type: 'text', text: body + contextText(capture) }];
  return { capture, filename, content };
}

export function appendHuman(session, content) {
  return session.append('user/message', createUserMessage({ content, source: { kind: 'user' } }), { surfaceOp: 'append' });
}

export function appendRoute(session) {
  session.append('request/header', { header: { config: { provider: 'fixture-route', model: 'fixture-model' } }, reason: 'initial' });
}

export function framedMessages(request) {
  const text = request.messages[0].content[0].text;
  assert.ok(text.startsWith(TITLE_FRAME_PREFIX));
  return JSON.parse(text.slice(TITLE_FRAME_PREFIX.length));
}

export async function eventually(check, timeoutMs = 1500) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try { return check(); }
    catch (error) { if (Date.now() >= until) throw error; }
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

export const settle = () => new Promise(resolve => setTimeout(resolve, 0));
