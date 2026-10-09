import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDraftSessionEnsurer } from '../src/draft-session.mjs';
import { inject } from '../src/index.mjs';

function host(cwd, canonical = cwd) {
  const calls = [], live = { id: 'blank-session', header: { id: 'blank-session', cwd } };
  let stored, materialized = false;
  const workspace = { id: 'exact-workspace', path: canonical, sessionIds: [], async attachSession(id) {
    calls.push(['attach', id]);
    assert.equal(materialized, true, 'membership follows durable Session identity');
    this.sessionIds.push(id);
  } };
  const ctx = {
    sessions: { get: id => id === live.id ? live : undefined },
    sessionPersistence: { async flush() { calls.push(['flush']); materialized = true; stored = { header: live.header }; }, async stat(id) { calls.push(['stat', id]); return stored; } },
    workspaceRegistry: { list: () => [workspace], get: id => id === workspace.id ? workspace : undefined },
  };
  return { ctx, calls, live, workspace };
}
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'dsh-session-durable-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return realpath(path);
}

test('default Host registration waits for every service needed to preserve exact Session identity', () => {
  assert.deepEqual(inject, ['connection', 'sessions', 'sessionPersistence', 'workspaceRegistry']);
});

test('a blank Session is durably materialized and registered before its exact workspace is acknowledged', async t => {
  const cwd = await directory(t), f = host(cwd);
  const headerFile = join(cwd, 'blank-session-header.json');
  const original = f.ctx.sessionPersistence.flush;
  f.ctx.sessionPersistence.flush = async () => { await writeFile(headerFile, JSON.stringify(f.live.header)); await original(); };
  await createDraftSessionEnsurer(f.ctx)('blank-session');
  assert.deepEqual(JSON.parse(await readFile(headerFile, 'utf8')), f.live.header);
  assert.deepEqual(f.calls, [['flush'], ['stat', 'blank-session'], ['attach', 'blank-session']]);
  assert.deepEqual(f.workspace.sessionIds, ['blank-session']);
});

test('native realpath binds a symlink cwd to only its canonical workspace', async t => {
  const canonical = await directory(t), parent = await directory(t), alias = join(parent, 'project-alias');
  await symlink(canonical, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const f = host(alias, canonical);
  const unrelated = { id: 'unrelated', path: parent, sessionIds: [], async attachSession() { throw new Error('wrong workspace selected'); } };
  f.ctx.workspaceRegistry.list = () => [unrelated, f.workspace];
  await createDraftSessionEnsurer(f.ctx)('blank-session');
  assert.deepEqual(f.workspace.sessionIds, ['blank-session']);
  assert.deepEqual(unrelated.sessionIds, []);
});

test('an exact ungrouped Session materializes without guessing another workspace', async t => {
  const cwd = await directory(t), f = host(cwd);
  f.workspace.path = await directory(t);
  await createDraftSessionEnsurer(f.ctx)('blank-session');
  assert.deepEqual(f.calls, [['flush'], ['stat', 'blank-session']]);
  assert.deepEqual(f.workspace.sessionIds, []);
});

test('Windows canonical paths use native realpath equality and reject current-drive paths', async () => {
  const f = host('C:/Users/example/project-alias', 'C:\\Users\\example\\Project');
  let requested;
  const ensure = createDraftSessionEnsurer(f.ctx, { platform: 'win32', realpath: async value => { requested = value; return f.workspace.path; }, stat: async () => ({ isDirectory: () => true }) });
  await ensure('blank-session');
  assert.equal(requested, 'C:/Users/example/project-alias');
  assert.deepEqual(f.workspace.sessionIds, ['blank-session']);
  for (const cwd of ['C:project', '\\project', '/project', 'relative']) {
    f.live.header.cwd = cwd;
    await assert.rejects(ensure('blank-session'), /完整工作目录/);
  }
});

test('UNC identities remain exact and are not rewritten or matched by case folding', async () => {
  const cwd = '\\\\server\\share\\Project', f = host(cwd);
  await createDraftSessionEnsurer(f.ctx, { platform: 'win32', realpath: async value => value, stat: async () => ({ isDirectory: () => true }) })('blank-session');
  assert.deepEqual(f.workspace.sessionIds, ['blank-session']);
  const different = host(cwd, '\\\\server\\share\\project');
  await createDraftSessionEnsurer(different.ctx, { platform: 'win32', realpath: async value => value, stat: async () => ({ isDirectory: () => true }) })('blank-session');
  assert.deepEqual(different.workspace.sessionIds, []);
});

test('missing services, retired sessions and unavailable directories fail visibly before persistence', async t => {
  const cwd = await directory(t), f = host(cwd);
  await assert.rejects(createDraftSessionEnsurer({ ...f.ctx, sessionPersistence: {} })('blank-session'), /持久化接口/);
  await assert.rejects(createDraftSessionEnsurer(f.ctx)('another-session'), /所属会话已关闭/);
  f.live.header.cwd = join(cwd, 'missing');
  await assert.rejects(createDraftSessionEnsurer(f.ctx)('blank-session'), /工作目录无法确认/);
  assert.deepEqual(f.calls, []);
});

test('a failed flush or unconfirmed materialization never attaches the blank Session to a workspace', async t => {
  const cwd = await directory(t), f = host(cwd);
  f.ctx.sessionPersistence.flush = async () => { throw new Error('disk unavailable'); };
  await assert.rejects(createDraftSessionEnsurer(f.ctx)('blank-session'), /disk unavailable/);
  assert.deepEqual(f.workspace.sessionIds, []);
  f.ctx.sessionPersistence.flush = async () => {};
  await assert.rejects(createDraftSessionEnsurer(f.ctx)('blank-session'), /持久化未确认/);
  assert.deepEqual(f.workspace.sessionIds, []);
});

test('membership storage failure is propagated instead of acknowledged as a recoverable draft', async t => {
  const cwd = await directory(t), f = host(cwd);
  f.workspace.attachSession = async () => { throw new Error('workspace storage unavailable'); };
  await assert.rejects(createDraftSessionEnsurer(f.ctx)('blank-session'), /workspace storage unavailable/);
  assert.deepEqual(f.workspace.sessionIds, []);
});

test('retirement during the barrier cannot attach a replacement Session or workspace', async t => {
  const cwd = await directory(t), f = host(cwd), original = f.ctx.sessionPersistence.flush;
  f.ctx.sessionPersistence.flush = async () => { await original(); f.ctx.sessions.get = () => ({ ...f.live }); };
  await assert.rejects(createDraftSessionEnsurer(f.ctx)('blank-session'), /会话已切换/);
  assert.deepEqual(f.workspace.sessionIds, []);
  f.ctx.sessions.get = () => f.live;
  f.ctx.sessionPersistence.flush = original;
  f.ctx.workspaceRegistry.get = () => undefined;
  await assert.rejects(createDraftSessionEnsurer(f.ctx)('blank-session'), /工作区已关闭/);
  assert.deepEqual(f.workspace.sessionIds, []);
});
