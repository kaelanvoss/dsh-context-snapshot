import test from 'node:test';
import assert from 'node:assert/strict';
import { watch, unlinkSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { prepareWindowsHelper } from '../src/helper-cache.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-helper-cache-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'installed', 'win-x64'), cacheRoot = join(root, 'cache');
  await mkdir(join(source, 'third-party'), { recursive: true });
  await writeFile(join(source, 'ContextSnapshot.exe'), 'test helper executable');
  await writeFile(join(source, 'runtime.dll'), 'required runtime contents');
  await writeFile(join(source, 'third-party', 'LICENSE.txt'), 'third-party license');
  await writeFile(join(source, 'third-party', 'manifest.json'), '{"runtime":"test"}');
  return { source, cacheRoot, exe: join(source, 'ContextSnapshot.exe'), options: { cacheRoot, version: '0.4.3', arch: 'x64' } };
}

async function noStaging(cacheRoot) {
  assert.deepEqual((await readdir(cacheRoot)).filter(name => name.startsWith('.staging-')), []);
}

test('Windows runtime cache copies the entire runtime as independent files and survives package removal', async t => {
  const f = await fixture(t), cached = await prepareWindowsHelper(f.exe, f.options);
  assert.equal(basename(cached), 'ContextSnapshot.exe');
  assert.equal(dirname(dirname(cached)), await realpath(f.cacheRoot));
  const originalInfo = await stat(f.exe), cachedInfo = await stat(cached);
  assert.notEqual(originalInfo.ino, cachedInfo.ino, 'copy must not hardlink the package executable');
  assert.equal((await lstat(cached)).isSymbolicLink(), false);
  assert.equal(await readFile(join(dirname(cached), 'third-party', 'LICENSE.txt'), 'utf8'), 'third-party license');
  await rm(f.source, { recursive: true });
  assert.equal(await readFile(cached, 'utf8'), 'test helper executable');
  assert.equal(await readFile(join(dirname(cached), 'runtime.dll'), 'utf8'), 'required runtime contents');
  await assert.rejects(prepareWindowsHelper(f.exe, f.options), { code: 'ENOENT' });
  await noStaging(f.cacheRoot);
});

test('identical builds reuse a complete cache, concurrent starts publish safely', async t => {
  const f = await fixture(t);
  const paths = await Promise.all(Array.from({ length: 6 }, () => prepareWindowsHelper(f.exe, f.options)));
  assert.equal(new Set(paths).size, 1);
  assert.equal(await prepareWindowsHelper(f.exe, f.options), paths[0]);
  assert.equal((await readdir(f.cacheRoot)).length, 1);
  await noStaging(f.cacheRoot);
});

test('changing any runtime content creates a new cache even at the same package version', async t => {
  const f = await fixture(t), first = await prepareWindowsHelper(f.exe, f.options);
  await writeFile(join(f.source, 'third-party', 'LICENSE.txt'), 'updated third-party license');
  const second = await prepareWindowsHelper(f.exe, f.options);
  assert.notEqual(first, second);
  assert.equal(await readFile(join(dirname(first), 'third-party', 'LICENSE.txt'), 'utf8'), 'third-party license');
  assert.equal(await readFile(join(dirname(second), 'third-party', 'LICENSE.txt'), 'utf8'), 'updated third-party license');
  await writeFile(join(f.source, 'runtime.dll'), 'changed runtime contents');
  assert.notEqual(await prepareWindowsHelper(f.exe, f.options), second);
});

test('missing cached dependencies are repaired without overwriting the existing runtime', async t => {
  const f = await fixture(t), first = await prepareWindowsHelper(f.exe, f.options);
  await rm(join(dirname(first), 'runtime.dll'));
  const repaired = await prepareWindowsHelper(f.exe, f.options);
  assert.notEqual(repaired, first);
  assert.match(dirname(repaired), /-repair-/);
  assert.equal(await readFile(join(dirname(repaired), 'runtime.dll'), 'utf8'), 'required runtime contents');
  await assert.rejects(stat(join(dirname(first), 'runtime.dll')), { code: 'ENOENT' });
  assert.equal(await prepareWindowsHelper(f.exe, f.options), repaired);
});

test('modified cached files, extra files and a forged manifest cannot be reused', async t => {
  const f = await fixture(t), first = await prepareWindowsHelper(f.exe, f.options);
  await writeFile(join(dirname(first), 'runtime.dll'), 'tampered runtime contents');
  const second = await prepareWindowsHelper(f.exe, f.options);
  assert.notEqual(first, second);
  await writeFile(join(dirname(second), 'unexpected.dll'), 'extra DLL');
  const third = await prepareWindowsHelper(f.exe, f.options);
  assert.notEqual(second, third);
  await writeFile(join(dirname(third), '.dsh-helper-cache.json'), '{"schema":1}');
  const fourth = await prepareWindowsHelper(f.exe, f.options);
  assert.notEqual(third, fourth);
  assert.equal(await readFile(join(dirname(fourth), 'runtime.dll'), 'utf8'), 'required runtime contents');
});

test('copy failure removes its partial staging runtime and never falls back to the installed executable', async t => {
  const f = await fixture(t);
  await mkdir(f.cacheRoot);
  for (let i = 0; i < 12; i++) await writeFile(join(f.source, `dependency-${i}.dll`), Buffer.alloc(128 * 1024, i));
  await writeFile(join(f.source, 'z-last.dll'), 'must be present');
  let removed = false;
  const watcher = watch(f.cacheRoot, (event, filename) => {
    if (!removed && filename?.toString().startsWith('.staging-')) {
      removed = true;
      unlinkSync(join(f.source, 'z-last.dll'));
    }
  });
  t.after(() => watcher.close());
  await assert.rejects(prepareWindowsHelper(f.exe, f.options), { code: 'ENOENT' });
  assert.equal(removed, true, 'source must disappear after inventory, during staging');
  await noStaging(f.cacheRoot);
  assert.deepEqual(await readdir(f.cacheRoot), []);
});

test('unsafe cache labels and cache directories nested inside the installed runtime are rejected', async t => {
  const f = await fixture(t);
  await assert.rejects(prepareWindowsHelper(f.exe, { ...f.options, version: '../../escape' }), /Invalid helper cache version/);
  await assert.rejects(prepareWindowsHelper(f.exe, { ...f.options, arch: 'x64/escape' }), /Invalid helper cache architecture/);
  await assert.rejects(prepareWindowsHelper(f.exe, { ...f.options, cacheRoot: 'relative/cache' }), /absolute path/);
  await assert.rejects(prepareWindowsHelper(f.exe, { ...f.options, cacheRoot: join(f.source, 'cache') }), /inside the installed runtime/);
  await assert.rejects(prepareWindowsHelper('ContextSnapshot.exe', f.options), /full path/);
});

test('source symlinks are rejected instead of copying external contents', async t => {
  const f = await fixture(t), external = join(dirname(f.source), 'external');
  await mkdir(external);
  await writeFile(join(external, 'secret.txt'), 'outside runtime');
  // Directory junctions do not require Windows Developer Mode/admin rights.
  await symlink(external, join(f.source, 'external-link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(prepareWindowsHelper(f.exe, f.options), /symbolic link/);
  await assert.rejects(stat(f.cacheRoot), { code: 'ENOENT' });
});

test('cache directory aliases cannot bypass source nesting or replace a cache root junction', async t => {
  const f = await fixture(t), alias = join(dirname(f.source), 'source-alias');
  await symlink(f.source, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(prepareWindowsHelper(f.exe, { ...f.options, cacheRoot: join(alias, 'cache') }), /inside the installed runtime/);
  await assert.rejects(stat(join(f.source, 'cache')), { code: 'ENOENT' });
  const target = join(dirname(f.source), 'cache-target');
  await mkdir(target);
  await symlink(target, f.cacheRoot, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(prepareWindowsHelper(f.exe, f.options), /ordinary directory/);
  assert.deepEqual(await readdir(target), []);
});

test('an actual cache IO failure is surfaced without falling back to the package', async t => {
  const f = await fixture(t);
  await writeFile(f.cacheRoot, 'this is not a cache directory');
  await assert.rejects(prepareWindowsHelper(f.exe, f.options), error => ['EEXIST', 'ENOTDIR'].includes(error.code));
  assert.equal(await readFile(f.cacheRoot, 'utf8'), 'this is not a cache directory');
});
