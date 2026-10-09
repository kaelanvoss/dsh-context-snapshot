import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSnapshotAppIcon } from '../src/snapshot-display.mjs';

const icon = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN8sAAAAASUVORK5CYII=';
const ids = ['12345678-1234-4234-8234-123456789aaa', '12345678-1234-4234-8234-123456789aab', '12345678-1234-4234-8234-123456789aac'];

test('display icon lookup is local, bounded to a snapshot identity and shared between mounted cards', async () => {
  const calls = [];
  const fetcher = async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ metadata: { [ids[0]]: { appIconPngBase64: icon } } }) }; };
  const first = loadSnapshotAppIcon(ids[0], fetcher), second = loadSnapshotAppIcon(ids[0], fetcher);
  assert.equal(first, second);
  assert.equal(await first, icon);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/context-snapshot');
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(calls[0].options.body), { op: 'snapshotMetadata', snapshotIds: [ids[0]] });
  assert.equal(await loadSnapshotAppIcon(ids[0], fetcher), icon);
  assert.equal(calls.length, 1);
});

test('uppercase Swift identities use canonical response keys and share the lowercase icon cache', async () => {
  const id = 'BA57E563-9FFE-42F5-89D9-9C8F59AB48B5', canonical = id.toLowerCase(), calls = [];
  const fetcher = async (url, options) => {
    calls.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ metadata: { [canonical]: { appIconPngBase64: icon } } }) };
  };
  const uppercase = loadSnapshotAppIcon(id, fetcher), lowercase = loadSnapshotAppIcon(canonical, fetcher);
  assert.equal(uppercase, lowercase, 'one snapshot shares the in-flight request across UUID spellings');
  assert.equal(await uppercase, icon);
  assert.deepEqual(calls, [{ op: 'snapshotMetadata', snapshotIds: [id] }], 'the request retains the caller identity spelling');
  assert.equal(await loadSnapshotAppIcon(canonical, fetcher), icon);
  assert.equal(await loadSnapshotAppIcon(id, fetcher), icon);
  assert.equal(calls.length, 1);
});

test('an uppercase identity also resolves an icon returned under its original requested key', async () => {
  const id = '32345678-1234-4234-A234-123456789ABC'; let calls = 0;
  const fetcher = async () => { calls += 1; return { ok: true, json: async () => ({ metadata: { [id]: { appIconPngBase64: icon } } }) }; };
  assert.equal(await loadSnapshotAppIcon(id, fetcher), icon);
  assert.equal(await loadSnapshotAppIcon(id.toLowerCase(), fetcher), icon);
  assert.equal(calls, 1);
});

test('failed uppercase icon lookups can be retried through the lowercase identity', async () => {
  const id = '42345678-1234-4234-B234-123456789ABC', canonical = id.toLowerCase(); let calls = 0;
  assert.equal(await loadSnapshotAppIcon(id, async () => { calls += 1; throw new Error('Host restarting'); }), undefined);
  assert.equal(await loadSnapshotAppIcon(canonical, async (url, options) => {
    calls += 1;
    assert.deepEqual(JSON.parse(options.body).snapshotIds, [canonical]);
    return { ok: true, json: async () => ({ metadata: { [canonical]: { appIconPngBase64: icon } } }) };
  }), icon);
  assert.equal(calls, 2);
});

test('failed or not-yet-saved icon metadata falls back and can be retried', async () => {
  let calls = 0;
  const failed = async () => { calls += 1; throw new Error('temporary restart'); };
  assert.equal(await loadSnapshotAppIcon(ids[1], failed), undefined);
  const recovered = async () => { calls += 1; return { ok: true, json: async () => ({ metadata: { [ids[1]]: { appIconPngBase64: icon } } }) }; };
  assert.equal(await loadSnapshotAppIcon(ids[1], recovered), icon);
  assert.equal(calls, 2);
  let saved = false;
  const delayed = async () => ({ ok: true, json: async () => ({ metadata: { [ids[2]]: saved ? { appIconPngBase64: icon } : {} } }) });
  assert.equal(await loadSnapshotAppIcon(ids[2], delayed), undefined);
  saved = true;
  assert.equal(await loadSnapshotAppIcon(ids[2], delayed), icon);
});

test('malformed identities and remote icon payloads never become image sources', async () => {
  let calls = 0;
  const malicious = async () => { calls += 1; return { ok: true, json: async () => ({ metadata: { [ids[2]]: { appIconPngBase64: 'https://example.test/tracker.png' } } }) }; };
  assert.equal(await loadSnapshotAppIcon('https://example.test/capture', malicious), undefined);
  assert.equal(calls, 0);
  const id = '12345678-1234-4234-8234-123456789aad';
  assert.equal(await loadSnapshotAppIcon(id, async () => ({ ok: true, json: async () => ({ metadata: { [id]: { appIconPngBase64: 'https://example.test/tracker.png' } } }) })), undefined);
});
