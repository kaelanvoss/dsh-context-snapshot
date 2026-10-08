import { createHash, randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import packageInfo from '../package.json' with { type: 'json' };

const MANIFEST = '.dsh-helper-cache.json';

class InvalidRuntime extends Error {}

function contains(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

function safeLabel(value, name) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value)) {
    throw new Error(`Invalid helper cache ${name}.`);
  }
  return value;
}

function defaultCacheRoot() {
  const local = process.env.LOCALAPPDATA;
  const base = typeof local === 'string' && !local.includes('\0') && isAbsolute(local)
    ? local : join(homedir(), 'AppData', 'Local');
  return join(base, 'dsh-context-snapshot', 'helpers');
}

async function canonicalDestination(path) {
  try { return await realpath(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalDestination(parent), basename(path));
  }
}

// Keep the opened file tied to the entry that was inspected. In particular,
// junctions and symlinks must never bring external files into a runtime copy.
async function openOrdinaryFile(path, root) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || !contains(root, await realpath(path))) {
    throw new InvalidRuntime(`Helper runtime contains an unsafe file: ${path}`);
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new InvalidRuntime(`Helper runtime changed while opening: ${path}`);
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function inventory(root, cache = false) {
  const entries = [];
  async function visit(directory, prefix = '') {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || !contains(root, await realpath(directory))) {
      throw new InvalidRuntime(`Helper runtime contains an unsafe directory: ${directory}`);
    }
    for (const name of (await readdir(directory)).sort()) {
      if (prefix === '' && name === MANIFEST) {
        if (cache) continue;
        throw new InvalidRuntime(`Helper runtime uses the reserved filename ${MANIFEST}.`);
      }
      const path = join(directory, name), entryPath = prefix ? `${prefix}/${name}` : name;
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new InvalidRuntime(`Helper runtime contains a symbolic link: ${path}`);
      if (stat.isDirectory()) {
        entries.push({ path: entryPath, type: 'directory' });
        await visit(path, entryPath);
      } else if (stat.isFile()) {
        const handle = await openOrdinaryFile(path, root), hash = createHash('sha256');
        let size = 0;
        try {
          for await (const chunk of handle.createReadStream({ autoClose: false })) {
            size += chunk.length;
            hash.update(chunk);
          }
        } finally { await handle.close(); }
        entries.push({ path: entryPath, type: 'file', size, sha256: hash.digest('hex') });
      } else throw new InvalidRuntime(`Helper runtime contains a non-regular entry: ${path}`);
    }
  }
  await visit(root);
  return entries;
}

async function completeCache(directory, expected) {
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    const root = await realpath(directory), manifestPath = join(root, MANIFEST);
    const manifestInfo = await lstat(manifestPath);
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()
      || manifestInfo.size > Buffer.byteLength(JSON.stringify(expected)) + 64) return false;
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (JSON.stringify(manifest) !== JSON.stringify(expected)) return false;
    return JSON.stringify(await inventory(root, true)) === JSON.stringify(expected.entries);
  } catch (error) {
    if (error instanceof InvalidRuntime || error instanceof SyntaxError || ['ENOENT', 'ENOTDIR'].includes(error.code)) return false;
    throw error;
  }
}

async function copyFile(source, destination, root, expected) {
  const input = await openOrdinaryFile(source, root), hash = createHash('sha256');
  let size = 0;
  try {
    await pipeline(input.createReadStream({ autoClose: false }), new Transform({
      transform(chunk, encoding, callback) {
        hash.update(chunk);
        size += chunk.length;
        callback(null, chunk);
      },
    }), createWriteStream(destination, { flags: 'wx' }));
    if (size !== expected.size || hash.digest('hex') !== expected.sha256) {
      throw new InvalidRuntime(`Helper runtime changed while copying: ${source}`);
    }
  } finally { await input.close(); }
}

/**
 * Copy the Windows runtime out of the installed package before executing it.
 * Each build gets an immutable content-addressed directory. Existing runtimes
 * are never overwritten or deleted, including those held open by Windows.
 */
export async function prepareWindowsHelper(sourceExePath, options = {}) {
  if (typeof sourceExePath !== 'string' || !isAbsolute(sourceExePath)
    || basename(sourceExePath) !== 'ContextSnapshot.exe') {
    throw new Error('A full path to ContextSnapshot.exe is required.');
  }
  const version = safeLabel(options.version ?? packageInfo.version, 'version');
  const arch = safeLabel(options.arch ?? process.arch, 'architecture');
  const configuredRoot = options.cacheRoot ?? defaultCacheRoot();
  if (typeof configuredRoot !== 'string' || configuredRoot.includes('\0') || !isAbsolute(configuredRoot)) {
    throw new Error('The helper cache root must be an absolute path.');
  }
  const originalSource = dirname(sourceExePath), sourceInfo = await lstat(originalSource);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
    throw new InvalidRuntime('The helper runtime directory must be an ordinary directory.');
  }
  const source = await realpath(originalSource), configured = resolve(configuredRoot);
  if (contains(source, await canonicalDestination(configured))) {
    throw new Error('The helper cache cannot be inside the installed runtime.');
  }
  const entries = await inventory(source);
  if (!entries.some(entry => entry.path === 'ContextSnapshot.exe' && entry.type === 'file')) {
    throw new Error('The installed Windows helper is missing ContextSnapshot.exe.');
  }
  const fingerprint = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  const expected = { schema: 1, version, arch, fingerprint, entries };
  await mkdir(configured, { recursive: true });
  const rootInfo = await lstat(configured);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('The helper cache must be an ordinary directory.');
  const root = await realpath(configured);
  if (contains(source, root)) throw new Error('The helper cache cannot be inside the installed runtime.');
  const key = `${version}-${arch}-${fingerprint}`, primary = join(root, key);
  if (await completeCache(primary, expected)) return join(primary, 'ContextSnapshot.exe');
  const repairs = (await readdir(root)).filter(name => name.startsWith(`${key}-repair-`)).sort();
  for (const name of repairs) {
    const candidate = join(root, name);
    if (await completeCache(candidate, expected)) return join(candidate, 'ContextSnapshot.exe');
  }
  let primaryExists = false;
  try { await lstat(primary); primaryExists = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const destination = primaryExists ? join(root, `${key}-repair-${randomUUID()}`) : primary;
  const staging = await mkdtemp(join(root, '.staging-'));
  try {
    for (const entry of entries) {
      const target = join(staging, ...entry.path.split('/'));
      if (entry.type === 'directory') await mkdir(target);
      else await copyFile(join(source, ...entry.path.split('/')), target, source, entry);
    }
    await writeFile(join(staging, MANIFEST), JSON.stringify(expected) + '\n', { flag: 'wx' });
    if (!await completeCache(staging, expected)) throw new Error('The copied Windows helper failed its integrity check.');
    try { await rename(staging, destination); }
    catch (error) {
      // Windows reports an existing destination as EPERM/EACCES. Only treat it
      // as a successful competing publish when that exact runtime is complete.
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)
        || !await completeCache(destination, expected)) throw error;
    }
    if (!await completeCache(destination, expected)) throw new Error('The cached Windows helper failed its integrity check.');
    return join(destination, 'ContextSnapshot.exe');
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
