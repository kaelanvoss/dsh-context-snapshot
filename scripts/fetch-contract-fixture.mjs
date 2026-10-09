import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
async function fetchFixture(name, sourcePath, destination) {
  const metadataResponse = await fetch(`https://registry.npmjs.org/@deepseek-ai%2F${name}/0.2.0-rc.2`);
  if (!metadataResponse.ok) throw new Error(`Registry HTTP ${metadataResponse.status}`);
  const metadata = await metadataResponse.json();
  const response = await fetch(metadata.dist.tarball);
  if (!response.ok) throw new Error(`Package HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  const [algorithm, expected] = metadata.dist.integrity.split('-');
  if (createHash(algorithm).update(data).digest('base64') !== expected) throw new Error('Official fixture integrity mismatch');
  const directory = await mkdtemp(join(tmpdir(), 'dsh-contract-'));
  try {
    const archive = join(directory, 'official.tgz');
    await writeFile(archive, data);
    execFileSync('tar', ['-xzf', archive, '-C', directory]);
    await mkdir(join(destination, '..'), { recursive: true });
    await writeFile(destination, await readFile(join(directory, 'package', sourcePath)));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
await Promise.all([
  fetchFixture('dsh-client-ui-conversation', 'lib/client.js', '.fixtures/ui-conversation/client.js'),
  fetchFixture('dsh-client-connection', 'lib/types/rpc.d.ts', '.fixtures/connection/rpc.d.ts'),
  fetchFixture('dsh-client-ui-slots', 'lib/index.js', '.fixtures/ui-slots/index.js'),
  fetchFixture('dsh-client-ui-renderer', 'lib/client.js', '.fixtures/ui-renderer/client.js'),
  fetchFixture('dsh-client-ui-chat', 'lib/client.js', '.fixtures/ui-chat/client.js'),
  fetchFixture('dsh-client-shortcuts', 'lib/client.js', '.fixtures/shortcuts/client.js'),
]);
console.log('Fetched integrity-checked official 0.2.0-rc.2 input, chat, slots, renderer, shortcuts and Connection contracts.');
