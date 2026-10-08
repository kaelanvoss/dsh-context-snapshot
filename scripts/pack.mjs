import { access, cp, mkdir, mkdtemp, readFile, writeFile, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const platform = process.argv[2];
if (!['macos', 'windows-x64', 'windows-arm64'].includes(platform)) throw new Error('Usage: node scripts/pack.mjs macos|windows-x64|windows-arm64');
const root = resolve('.'), output = resolve(process.argv[3] ?? process.env.DSH_SNAPSHOT_OUTPUT ?? 'artifacts');
await mkdir(output, { recursive: true });
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const directory = await mkdtemp(join(tmpdir(), 'dsh-snapshot-package-'));
try {
  for (const path of ['dist', 'docs', 'README.md', 'VALIDATION.md', 'LICENSE', 'cordis.patch.yml']) await cp(join(root, path), join(directory, path), { recursive: true });
  const nativePath = platform === 'macos' ? 'native/macos/build/ContextSnapshot.app' : `native/windows/publish/win-${platform.split('-')[1]}`;
  if (platform !== 'macos') {
    for (const name of ['DOTNET-LICENSE.txt', 'DOTNET-THIRD-PARTY-NOTICES.txt', 'WINDOWSDESKTOP-LICENSE.txt', 'WPF-THIRD-PARTY-NOTICES.txt', 'manifest.json']) {
      await access(join(root, nativePath, 'third-party', name));
    }
  }
  await mkdir(join(directory, nativePath, '..'), { recursive: true });
  await cp(join(root, nativePath), join(directory, nativePath), { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  // Invoke npm's JS entry with Node, avoiding .cmd shell parsing on Windows.
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('Run through npm: npm run pack:macos / pack:windows-x64 / pack:windows-arm64');
  const result = spawnSync(process.execPath, [npmCli, 'pack', '--json', '--ignore-scripts', '--pack-destination', output], { cwd: directory, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  const packed = JSON.parse(result.stdout)[0];
  const target = join(output, `dsh-context-snapshot-${manifest.version}-${platform}.tgz`);
  await rename(join(output, packed.filename), target);
  console.log(`${target} (${packed.size} bytes)`);
} finally { await rm(directory, { recursive: true, force: true }); }
