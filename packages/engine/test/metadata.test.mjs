import test from 'node:test';
import assert from 'node:assert/strict';
import { createMetadataResolver } from '../src/metadata.mjs';

const asset = { chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', address: 'F6EDRhRzXGmkBabhSHdAnqx26XLhG6NCa83wwuqFpump' };
const genesis = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const program = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
function snapshot() {
  return [{ jsonrpc: '2.0', id: 2, result: { context: { slot: 123 }, value: {
    owner: program, executable: false, data: { program: 'spl-token-2022', parsed: { type: 'mint', info: {
      isInitialized: true, decimals: 6, extensions: [{ extension: 'tokenMetadata', state: {
        mint: asset.address, name: 'ECSTASY', symbol: 'ECSTASY', uri: 'https://untrusted.example/token' } }],
    } } },
  } } }, { jsonrpc: '2.0', id: 1, result: genesis }];
}
const json = value => new Response(JSON.stringify(value));

test('fixed mainnet finalized mint lookup binds token identity and never follows token metadata URLs', async () => {
  const calls = [];
  const resolver = createMetadataResolver({ fetch: async (url, init) => { calls.push({ url, init }); return json(snapshot()); } });
  const result = await resolver.resolveAsset(asset);
  assert.equal(result.decimals, 6);
  assert.equal(result.symbol, 'ECSTASY');
  assert.equal(result.tokenProgram, program);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.metadataVerified, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.mainnet-beta.solana.com');
  assert.equal(calls[0].init.redirect, 'error');
  assert.deepEqual(JSON.parse(calls[0].init.body).map(row => row.method), ['getGenesisHash', 'getAccountInfo']);
  assert.equal(JSON.parse(calls[0].init.body)[1].params[1].commitment, 'finalized');
  assert.equal(result.uri, undefined);
  assert.equal(calls[0].init.signal.aborted, true);
});
test('initialized mint decimals use the full uint8 range and reject values above it', async () => {
  for (const decimals of [255, 256]) {
    const rows = snapshot(); rows[0].result.value.data.parsed.info.decimals = decimals;
    const resolver = createMetadataResolver({ fetch: async () => json(rows) });
    if (decimals === 255) assert.equal((await resolver.resolveAsset(asset)).decimals, 255);
    else await assert.rejects(resolver.resolveAsset(asset));
  }
});

test('cached metadata is cloned, bounded in time, and never changes another mint', async () => {
  let clock = 1000;
  let count = 0;
  const resolver = createMetadataResolver({ now: () => clock, fetch: async () => { count++; return json(snapshot()); } });
  const first = await resolver.resolveAsset(asset);
  first.decimals = 9;
  assert.equal((await resolver.resolveAsset(asset)).decimals, 6);
  assert.equal(count, 1);
  clock += 60000;
  await resolver.resolveAsset(asset);
  assert.equal(count, 2);
});

test('untrusted request fields, unsupported chain and invalid mint bytes never make RPC calls', async () => {
  let count = 0;
  const resolver = createMetadataResolver({ fetch: async () => { count++; throw new Error(); } });
  for (const input of [{ ...asset, url: 'https://evil.example' }, { ...asset, chainId: 'eip155:8453' },
    { ...asset, address: 'https://evil.example' }, { ...asset, address: '1'.repeat(44) }, [asset]])
    await assert.rejects(resolver.resolveAsset(input), error => error.status === 400);
  assert.equal(count, 0);
});

test('wrong network, invalid programs, nonexistent accounts and token-account metadata fail closed', async () => {
  const variants = [
    rows => { rows[1].result = 'wrong-chain'; },
    rows => { rows[0].result.value = null; },
    rows => { rows[0].result.value.owner = '11111111111111111111111111111111'; },
    rows => { rows[0].result.value.executable = true; },
    rows => { rows[0].result.value.data.parsed.type = 'account'; },
    rows => { rows[0].result.value.data.parsed.info.decimals = 9.5; },
    rows => { rows[0].result.value.data.parsed.info.extensions[0].state.mint = '11111111111111111111111111111111'; },
    rows => { rows[0].id = 1; },
  ];
  for (const change of variants) {
    const rows = snapshot(); change(rows);
    const resolver = createMetadataResolver({ fetch: async () => json(rows) });
    await assert.rejects(resolver.resolveAsset(asset), error => /^TOKEN_/.test(error.code));
  }
});

test('errors and oversized or redirected RPC responses cannot leak upstream details or populate cache', async () => {
  for (const wire of [async () => { throw new Error('provider-secret hidden upstream'); },
    async () => new Response('x'.repeat(65537)),
    async () => new Response(JSON.stringify(snapshot()), { headers: { 'Content-Length': '65537' } }),
    async () => ({ ok: true, redirected: true }), async () => new Response('unavailable', { status: 429 })]) {
    const resolver = createMetadataResolver({ fetch: wire });
    await assert.rejects(resolver.resolveAsset(asset), error => error.code === 'TOKEN_METADATA_UNAVAILABLE' && !/secret|upstream/.test(error.message));
  }
});

test('cancelling lookup aborts RPC work and returns no metadata', async () => {
  const controller = new AbortController();
  let start;
  const started = new Promise(resolve => { start = resolve; });
  const resolver = createMetadataResolver({ fetch: async (_url, init) => {
    start();
    await new Promise(resolve => init.signal.addEventListener('abort', resolve, { once: true }));
    throw new Error('aborted');
  } });
  const request = resolver.resolveAsset(asset, controller.signal);
  await started;
  controller.abort();
  await assert.rejects(request, error => error.code === 'CANCELLED');
  await assert.rejects(resolver.resolveAsset(asset, AbortSignal.abort()), error => error.code === 'CANCELLED');
});

test('a burst for one mint makes one RPC and serves every caller with independent clones', async () => {
  let calls = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  const resolver = createMetadataResolver({ fetch: async () => { calls++; await barrier; return json(snapshot()); } });
  const requests = Array.from({ length: 12 }, () => resolver.resolveAsset(asset));
  await Promise.resolve(); assert.equal(calls, 1); release();
  const rows = await Promise.all(requests);
  rows[0].decimals = 9; assert.ok(rows.slice(1).every(row => row.decimals === 6)); assert.equal(calls, 1);
});

test('one caller cancellation does not cancel another caller mint lookup', async () => {
  let shared, release;
  const barrier = new Promise(resolve => { release = resolve; });
  const resolver = createMetadataResolver({ fetch: async (_url, init) => { shared = init.signal; await barrier; return json(snapshot()); } });
  const controller = new AbortController();
  const a = resolver.resolveAsset(asset, controller.signal), b = resolver.resolveAsset(asset);
  await Promise.resolve(); controller.abort(); await assert.rejects(a, error => error.code === 'CANCELLED');
  assert.equal(shared.aborted, false); release(); assert.equal((await b).decimals, 6);
});

test('deadline remains bounded if RPC ignores abort and late bodies are discarded', async () => {
  let calls = 0, finish, disposed = 0;
  const resolver = createMetadataResolver({ timeoutMs: 15, fetch: async () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  await assert.rejects(resolver.resolveAsset(asset), error => error.code === 'TOKEN_METADATA_UNAVAILABLE');
  await assert.rejects(resolver.resolveAsset(asset), error => error.code === 'TOKEN_METADATA_UNAVAILABLE');
  assert.equal(calls, 1);
  finish({ ok: true, body: { cancel() { disposed++; } } });
  await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(disposed, 1);
});
