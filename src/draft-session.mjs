import { realpath, stat } from 'node:fs/promises';
import { posix, win32 } from 'node:path';

function fullyQualified(path, platform) {
  if (typeof path !== 'string' || !path) return false;
  if (platform !== 'win32') return posix.isAbsolute(path);
  const root = win32.parse(path).root;
  return win32.isAbsolute(path) && root !== '\\' && root !== '/';
}

/** Make the exact live Session recoverable before saving a snapshot draft. */
export function createDraftSessionEnsurer(ctx, options = {}) {
  const platform = options.platform ?? process.platform;
  const resolvePath = options.realpath ?? realpath;
  const inspectPath = options.stat ?? stat;
  return async sessionId => {
    const sessions = ctx.sessions, persistence = ctx.sessionPersistence, registry = ctx.workspaceRegistry;
    if (typeof sessions?.get !== 'function' || typeof persistence?.flush !== 'function'
      || typeof persistence?.stat !== 'function' || typeof registry?.list !== 'function'
      || typeof registry?.get !== 'function') throw new Error('当前 Harness 缺少会话草稿持久化接口，快照未保存。');
    const live = sessions.get(sessionId);
    if (!live || live.id !== sessionId || live.header?.id !== sessionId) throw new Error('快照所属会话已关闭，未保存到其他会话。');
    const cwd = live.header.cwd;
    if (!fullyQualified(cwd, platform)) throw new Error('快照所属会话缺少完整工作目录，草稿未保存。');
    let canonical;
    try {
      // This mirrors Host workspace identity: native realpath string equality.
      // Do not lowercase Windows paths or resolve drive-relative paths.
      canonical = await resolvePath(cwd);
      if (!(await inspectPath(canonical)).isDirectory()) throw new Error('路径不是目录');
    } catch (error) { throw new Error(`快照所属工作目录无法确认：${error.message}`); }
    const workspaces = registry.list();
    if (!Array.isArray(workspaces)) throw new Error('当前 Harness 的工作区接口不兼容，草稿未保存。');
    const matches = workspaces.filter(workspace => workspace.path === canonical);
    if (matches.length > 1) throw new Error('快照所属工作区存在重复目录，未选择其他工作区。');
    const workspace = matches[0];
    if (workspace && typeof workspace.attachSession !== 'function') throw new Error('当前 Harness 无法登记快照所属会话，草稿未保存。');
    // Newly created blank sessions have an unmaterialized write handle. The
    // public barrier drains active handles and makes their exact ids durable.
    await persistence.flush();
    const stored = await persistence.stat(sessionId);
    if (!stored || stored.header?.id !== sessionId || stored.header.cwd !== cwd) throw new Error('快照所属会话持久化未确认，草稿未保存。');
    if (sessions.get(sessionId) !== live) throw new Error('快照所属会话已切换，草稿未保存。');
    if (workspace) {
      if (registry.get(workspace.id) !== workspace) throw new Error('快照所属工作区已关闭，草稿未保存。');
      // attachSession validates the same canonical cwd and writes membership
      // atomically; it never changes another Session's ownership or location.
      await workspace.attachSession(sessionId);
      if (!workspace.sessionIds?.includes(sessionId)) throw new Error('快照所属工作区登记未确认，草稿未保存。');
    }
  };
}
