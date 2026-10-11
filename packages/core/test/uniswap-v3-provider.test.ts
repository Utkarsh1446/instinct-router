import test from 'node:test';
import assert from 'node:assert/strict';
import { BASE_V3, createUniswapV3Adapter } from '../dist/uniswap-v3-provider.js';
import type { UniswapV3Options, UniswapV3LegQuote } from '../dist/uniswap-v3-provider.js';
import type { QuoteContext } from '../src/router.ts';
const NOW = 1800000000000;
const ETH = { chainId: BASE_V3.chainId, address: BASE_V3.native, decimals: 18 };
// Exercise isolated custom-token path; pinned WETH/USDC Multicall has its own suite.
const USDC = { chainId: BASE_V3.chainId, address: '0x' + '22'.repeat(20), decimals: 6 };
const word = (value: bigint | number) => BigInt(value).toString(16).padStart(64, '0');
const abi = (...values: (bigint | number)[]) => '0x' + values.map(word).join('');
const REVERT = '0x08c379a0' + word(32) + word(2) + '4949'.padEnd(64, '0');
function context(): QuoteContext {
  const owner = '0x' + '11'.repeat(20);
  const request = { requestId: 'dex-test', source: ETH, destination: USDC, amountRaw: '50000000000000',
    sender: owner, recipient: owner, slippageBps: 50, maxFeeBps: 500, maxPriceImpactBps: 500,
    maxCompletionMs: 100000, deadlineMs: NOW + 60000, optimization: { objective: 'BALANCED' as const, maxOutputShortfallBps: 50 } };
  return { request, leg: { index: 0, capabilityId: 'eth-usdc', adapterId: 'uniswap-v3', kind: 'SWAP',
    source: ETH, destination: USDC, validationTier: 'QUOTE_VALIDATED', executionTier: 'NONE', quoteProbe: true,
    amountSource: 'REQUEST_AMOUNT', requiresRequoteAfterSettlement: false }, amountRaw: request.amountRaw,
    sender: owner, recipient: owner, slippageBps: 50, deadlineMs: NOW + 60000,
    transportDeadlineMs: NOW + 2000, signal: new AbortController().signal };
}
type Batch = { id: string; method: string; params: any[] }[];
function fixture(patch: Partial<UniswapV3Options> = {}) {
  const batches: Batch[] = [];
  let mutate: (rows: any[], calls: Batch) => unknown = rows => rows;
  const options: UniswapV3Options = { clock: () => NOW, fetch: async (url, init) => {
    assert.equal(url, BASE_V3.rpc); assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
    const batch = JSON.parse(init.body as string) as Batch; batches.push(batch);
    const rows = batch.map(call => {
      let result: unknown;
      if (call.method === 'eth_chainId') result = '0x2105';
      else if (call.method === 'eth_getBlockByNumber') result = { number: '0x1234', hash: '0x' + '12'.repeat(32), timestamp: '0x' + (NOW / 1000).toString(16) };
      else {
        const data = call.params[0].data as string;
        if (data === '0x313ce567') result = abi(call.params[0].to === USDC.address ? 6 : 18);
        else if (data.startsWith('0x1698ee82')) result = abi(BigInt('0x' + data.slice(-64)) + 1n);
        else if (data.startsWith('0xc6a5026a')) {
          const fee = BigInt('0x' + data.slice(10 + 3 * 64, 10 + 4 * 64));
          result = abi(fee === 500n ? 100003 : 90000, 1n << 96n, 0, 40000);
        } else assert.fail('Unexpected mutating or non-pinned method');
      }
      return { jsonrpc: '2.0', id: call.id, result };
    });
    return new Response(JSON.stringify(mutate(rows, batch)));
  }, ...patch };
  return { options, batches, mutate: (fn: typeof mutate) => { mutate = fn; } };
}
async function quote(options: UniswapV3Options, ctx = context()) {
  return await createUniswapV3Adapter(options).quote(ctx) as UniswapV3LegQuote;
}
test('compares pools at one block; native wrapping, exact tuple, floor and unknown costs preserved', async () => {
  const f = fixture(); const result = await quote(f.options);
  assert.equal(result.expectedOutRaw, '100003'); assert.equal(result.minimumOutRaw, '99502');
  assert.equal(result.poolFeePips, 500); assert.equal(result.simulatedSwapGasUnits, '40000');
  assert.equal(result.feeBps, null); assert.equal(result.priceImpactBps, null); assert.equal(result.estimatedCompletionMs, null);
  assert.equal(result.conditional, true); assert.equal(result.executableRecipeId, undefined);
  assert.equal(result.source.address, BASE_V3.native); assert.equal(result.pricingValidUntilMs, NOW + 5000);
  assert.equal(f.batches.length, 2);
  assert.equal(f.batches[1]!.length, 16); // Two decimals, seven factories, seven simulations.
  for (const call of f.batches.flat()) {
    assert.ok(['eth_chainId', 'eth_getBlockByNumber', 'eth_call'].includes(call.method));
    if (call.method === 'eth_call') assert.deepEqual(call.params[1], { blockHash: '0x' + '12'.repeat(32), requireCanonical: true });
  }
  const data = f.batches[1]!.find(call => call.params[0].data.startsWith('0xc6a5026a'))!.params[0].data;
  assert.equal(data.slice(10, 74), BASE_V3.weth.slice(2).padStart(64, '0'));
  assert.equal(BigInt('0x' + data.slice(138, 202)), BigInt(context().amountRaw));
  assert.equal(data.length, 330); // selector plus five static tuple words; no tuple offset.
});
test('response order independent; exact composed leg amount and asset binding', async () => {
  const f = fixture(); f.mutate(rows => rows.reverse());
  const base = context(); const ctx = { ...base, leg: { ...base.leg, index: 1, source: USDC, destination: ETH }, amountRaw: '1000000' };
  const result = await quote({ ...f.options, estimatedCompletionMs: 2000 }, ctx);
  assert.equal(result.source.address, USDC.address); assert.equal(result.destination.address, ETH.address);
  assert.equal(result.amountInRaw, '1000000'); assert.equal(result.estimatedCompletionMs, 2000);
});
test('rejects wrong chain, decimals, ABI widths and wrong/duplicate RPC IDs', async () => {
  for (const type of ['chain', 'decimals', 'width', 'id', 'duplicate', 'both']) {
    const f = fixture();
    f.mutate((rows, calls) => {
      if (type === 'chain' && calls[0]?.method === 'eth_chainId') rows[0].result = '0x1';
      if (type === 'decimals' && calls[0]?.params[0]?.data === '0x313ce567') rows[0].result = abi(9);
      if (type === 'width') { const i = calls.findIndex(call => call.params[0]?.data?.startsWith('0xc6a5026a')); if (i >= 0) rows[i].result = abi(1, 1n << 160n, 0, 1); }
      if (type === 'id') rows[0].id = 'foreign';
      if (type === 'duplicate') rows[1].id = rows[0].id;
      if (type === 'both') rows[0].error = { code: -1, message: 'secret' };
      return rows;
    });
    await assert.rejects(quote(f.options), /V3_|TOKEN_DECIMALS_MISMATCH/);
  }
});
test('pool absence and per-pool reverts are honest; no retry or zero output fabrication', async () => {
  const f = fixture(); f.mutate((rows, calls) => {
    return rows.map((row, i) => !calls[i]?.params[0]?.data?.startsWith('0xc6a5026a') ||
      BigInt('0x' + calls[i]!.params[0].data.slice(202, 266)) === 200n ? row :
      { jsonrpc: '2.0', id: row.id, error: { code: -32000, message: 'execution reverted', data: REVERT } });
  });
  assert.equal((await quote(f.options)).poolFeePips, 200);
  const empty = fixture(); empty.mutate((rows, calls) => rows.map((row, i) =>
    calls[i]?.params[0]?.data?.startsWith('0x1698ee82') ? { ...row, result: abi(0) } : row));
  await assert.rejects(quote(empty.options), /V3_NO_POOL/); assert.equal(empty.batches.length, 2);
  // An absent factory pool cannot grant liquidity even if its simulation claims better output.
  const absent = fixture(); absent.mutate((rows, calls) => rows.map((row, i) =>
    calls[i]?.params[0]?.data?.startsWith('0x1698ee82') && BigInt('0x' + calls[i]!.params[0].data.slice(-64)) === 500n ?
      { ...row, result: abi(0) } : row));
  const result = await quote(absent.options);
  assert.equal(result.poolFeePips, 100); assert.equal(result.expectedOutRaw, '90000');
  assert.equal(absent.batches.length, 2);
});
test('successful lower tier plus unavailable best tier rejects the whole comparison with redacted retryable error', async () => {
  for (const error of [
    { code: -32603, message: 'internal error private-secret' },
    { code: -32000, message: 'execution reverted' },
    { code: -32000, message: 'execution reverted', data: '0x' },
    { code: -32000, message: 'execution reverted', data: '0x4e487b71' + word(65) },
    { code: -32005, message: 'rate limited private-secret' },
    { code: -32000, message: 'upstream unavailable private-secret' },
    { code: 3, message: 'execution reverted', data: { secret: 'private-secret' } },
    { code: -32000, message: 'execution reverted', data: '0x1' },
    { code: -32000, message: 'execution reverted', data: '0x' + '00'.repeat(4097) },
    { code: -32603, message: 'execution reverted' },
    { code: -32000, message: 'execution reverted but node is unavailable' },
  ]) {
    const f = fixture();
    f.mutate((rows, calls) => {
      const bestIndex = calls.findIndex(call => call.params[0]?.data?.startsWith('0xc6a5026a') && BigInt('0x' + call.params[0].data.slice(202, 266)) === 500n);
      if (bestIndex < 0) return rows;
      rows[bestIndex] = { jsonrpc: '2.0', id: rows[bestIndex].id, error };
      return rows;
    });
    await assert.rejects(quote(f.options), error => {
      const fault = error as { code: string; retryable: boolean };
      return fault.code === 'V3_RPC_UNAVAILABLE' && fault.retryable === true && !String(error).includes('private-secret');
    });
    assert.equal(f.batches.length, 2); // No retry or lower-tier fallback.
  }
  const metadata = fixture(); metadata.mutate((rows, calls) => {
    if (calls[0]?.params[0]?.data === '0x313ce567') rows[0] = { jsonrpc: '2.0', id: rows[0].id,
      error: { code: 3, message: 'execution reverted', data: '0x' } };
    return rows;
  });
  await assert.rejects(quote(metadata.options), /V3_RPC_UNAVAILABLE/);
});
test('fixed URL configuration, raw bounds, identical wrapped tokens and pre-cancel do no network work', async () => {
  const f = fixture();
  assert.throws(() => createUniswapV3Adapter({ ...f.options, feeTiers: [500, 500] }));
  assert.throws(() => createUniswapV3Adapter({ ...f.options, feeTiers: [999] }));
  assert.throws(() => createUniswapV3Adapter({ ...f.options, estimatedCompletionMs: 0 }));
  const ctx = context(); const controller = new AbortController(); controller.abort();
  await assert.rejects(quote(f.options, { ...ctx, signal: controller.signal }), /CANCELLED/);
  await assert.rejects(quote(f.options, { ...ctx, amountRaw: (1n << 255n).toString() }), /V3_AMOUNT_UNSUPPORTED/);
  await assert.rejects(quote(f.options, { ...ctx, leg: { ...ctx.leg, destination: { ...ETH, address: BASE_V3.weth } } }), /V3_IDENTICAL_TOKENS/);
  assert.equal(f.batches.length, 0);
});
test('bounded streaming rejects oversized, duplicate JSON, redirects, HTTP errors and no-stream responses', async () => {
  for (const body of [' '.repeat(65537), '[{"jsonrpc":"2.0","id":"a","id":"b","result":"0x2105"}]']) {
    const f = fixture({ fetch: async () => new Response(body) });
    await assert.rejects(quote(f.options), /V3_RESPONSE_TOO_LARGE|V3_INVALID_JSON/);
  }
  for (const response of [{ redirected: true }, new Response('secret', { status: 429 }),
    { ok: true, headers: new Headers(), text: () => assert.fail('Unbounded fallback') }]) {
    const f = fixture({ fetch: async () => response as Response });
    await assert.rejects(quote(f.options), /V3_REDIRECT|V3_RATE_LIMIT|V3_INVALID_RESPONSE/);
  }
});
test('deadline bounds custom fetch ignoring cancellation and cancels late body without reading', async () => {
  let resolve!: (value: Response) => void, cancelled = 0, reads = 0;
  const gate = new Promise<Response>(done => { resolve = done; });
  const f = fixture({ fetch: () => gate });
  let settled = false;
  const pending = quote(f.options, { ...context(), transportDeadlineMs: NOW + 10 });
  pending.finally(() => { settled = true; }).catch(() => {});
  await new Promise(done => setTimeout(done, 20));
  assert.equal(settled, false); // Scheduler slot stays owned until actual fetch exits.
  resolve(new Response(new ReadableStream({ pull() { reads++; }, cancel() { cancelled++; } }, { highWaterMark: 0 })));
  await assert.rejects(pending, /V3_QUOTE_DEADLINE/);
  await new Promise(done => setTimeout(done, 10));
  assert.equal(cancelled, 1); assert.equal(reads, 0);
});
test('caller cancellation releases pending stream and stale metadata latency cannot extend pricing TTL', async () => {
  let started!: () => void, closed = 0;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const f = fixture({ fetch: async () => new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode('[')); started(); }, cancel() { closed++; },
  })) });
  const controller = new AbortController(); const pending = quote(f.options, { ...context(), signal: controller.signal });
  await entered; controller.abort(); await assert.rejects(pending, /CANCELLED/);
  await new Promise(done => setTimeout(done, 0)); assert.equal(closed, 1);
  let stamp = NOW;
  const stale = fixture({ clock: () => stamp }); stale.mutate(rows => { stamp += 3000; return rows; });
  await assert.rejects(quote(stale.options, { ...context(), transportDeadlineMs: NOW + 10000 }), /V3_QUOTE_DEADLINE/);
});
test('official deployment pins are exact 20-byte addresses; stale headers and non-swap/zero-owner rejected', async () => {
  assert.equal(BASE_V3.factory, '0x33128a8fC17869897dcE68Ed026d694621f6FDfD'.toLowerCase());
  assert.equal(BASE_V3.quoter, '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a'.toLowerCase());
  for (const key of ['factory', 'quoter', 'weth', 'usdc', 'native'] as const) assert.match(BASE_V3[key], /^0x[0-9a-f]{40}$/);
  for (const age of [-3000, 13000]) {
    const f = fixture(); f.mutate((rows, calls) => {
      if (calls[0]?.method === 'eth_chainId') rows[1].result.timestamp = '0x' + ((NOW - age) / 1000).toString(16);
      return rows;
    });
    await assert.rejects(quote(f.options), /V3_STALE_BLOCK/); assert.equal(f.batches.length, 1);
  }
  const f = fixture(), ctx = context();
  await assert.rejects(quote(f.options, { ...ctx, sender: BASE_V3.native }), /V3_INVALID_OWNER/);
  await assert.rejects(quote(f.options, { ...ctx, leg: { ...ctx.leg, kind: 'BRIDGE' } }), /V3_CONTEXT_MISMATCH/);
  assert.equal(f.batches.length, 0);
  await assert.rejects(quote(f.options, { ...ctx, slippageBps: 10000 }), /V3_NONPOSITIVE_MINIMUM/);
});
