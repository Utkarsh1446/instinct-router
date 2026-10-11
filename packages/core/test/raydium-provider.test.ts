import test from 'node:test';
import assert from 'node:assert/strict';
import { createRaydiumAdapter } from '../dist/raydium-provider.js';
import type { QuoteContext } from '../dist/router.js';
import type { RaydiumOptions } from '../dist/raydium-provider.js';

const SOL = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' as const;
const NATIVE = '11111111111111111111111111111111';
const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const CUSTOM = 'F6EDRhRzXGmkBabhSHdAnqx26XLhG6NCa83wwuqFpump';
const wallet = '11111111111111111111111111111112';
const now = 1800000000000;
function context(): QuoteContext {
  const source = { chainId: SOL, address: NATIVE, decimals: 9 }, destination = { chainId: SOL, address: USDC, decimals: 6 };
  const request = { requestId: 'r1', source, destination, amountRaw: '10000000', sender: wallet, recipient: wallet,
    slippageBps: 50, maxFeeBps: 500, maxPriceImpactBps: 500, maxCompletionMs: 60000, deadlineMs: now + 60000,
    optimization: { objective: 'BALANCED' as const, maxOutputShortfallBps: 50 } };
  return { request, leg: { index: 0, adapterId: 'raydium', capabilityId: 'raydium:route', kind: 'SWAP', source, destination,
    validationTier: 'QUOTE_VALIDATED', executionTier: 'NONE', quoteProbe: true, amountSource: 'REQUEST_AMOUNT', requiresRequoteAfterSettlement: false },
    amountRaw: request.amountRaw, sender: wallet, recipient: wallet, slippageBps: 50, deadlineMs: now + 60000,
    transportDeadlineMs: now + 5000, signal: new AbortController().signal };
}
function payload() {
  return { id: 'public-rfq', success: true, version: 'V1', data: { swapType: 'BaseIn', inputMint: WSOL,
    inputAmount: '10000000', actualInputAmount: '10000000', outputMint: USDC, outputAmount: '1000000',
    otherAmountThreshold: '995000', slippageBps: 50, priceImpactPct: 0.05, referrerAmount: '0',
    routePlan: [{ poolId: WSOL, inputMint: WSOL, outputMint: USDC, feeMint: WSOL, feeRate: 25, feeAmount: '25000', remainingAccounts: [] as string[] }] } };
}
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const fake = (body: unknown = payload()): RaydiumOptions => ({ clock: () => now, fetch: async () => response(body) });

test('direct pricing uses only fixed compute GET, binds native units and grants no execution authority', async () => {
  let calls = 0;
  const adapter = createRaydiumAdapter({ ...fake(), estimatedCompletionMs: 24000, fetch: async (url, init) => {
    calls++; const parsed = new URL(url);
    assert.equal(parsed.origin + parsed.pathname, 'https://transaction-v1.raydium.io/compute/swap-base-in');
    assert.deepEqual(Object.fromEntries(parsed.searchParams), { inputMint: WSOL, outputMint: USDC, amount: '10000000', slippageBps: '50', txVersion: 'V0' });
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error'); assert.equal(init.body, undefined);
    return response(payload());
  } });
  const quote = await adapter.quote(context()); assert.equal(calls, 1);
  assert.equal(quote.source.address, NATIVE); assert.equal(quote.minimumOutRaw, '995000');
  assert.equal(quote.feeBps, null); assert.equal(quote.priceImpactBps, 5);
  assert.equal(quote.conditional, true); assert.equal(quote.liquidityConfirmed, true);
  assert.equal(quote.estimatedCompletionMs, 24000); assert.equal(quote.protocolEstimateMs, null);
  assert.equal(quote.expiresAtMs, now + 15000); assert.equal(quote.pricingValidUntilMs, quote.expiresAtMs);
  assert.equal(quote.executableRecipeId, undefined); assert.match(quote.quoteId, /^raydium:preview:[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(quote), /routePlan|remainingAccounts|transaction|signature/);
  const repeat = await adapter.quote(context()); assert.equal(repeat.quoteId, quote.quoteId);
  const changed = context(); Object.assign(changed.request, { requestId: 'r2' });
  assert.notEqual((await adapter.quote(changed)).quoteId, quote.quoteId);
});
test('supports reverse direction, verified custom tokens and continuous multi-hop routes', async () => {
  for (const output of [NATIVE, CUSTOM]) {
    const ctx = context();
    const source = { chainId: SOL, address: USDC, decimals: 6 }, destination = { chainId: SOL, address: output, decimals: output === NATIVE ? 9 : 6 };
    Object.assign(ctx.request, { source, destination }); Object.assign(ctx.leg, { source, destination });
    const raw = payload(); raw.data.inputMint = USDC; raw.data.outputMint = output === NATIVE ? WSOL : output;
    raw.data.routePlan = [{ ...raw.data.routePlan[0]!, inputMint: USDC, outputMint: raw.data.outputMint, feeMint: USDC }];
    const quote = await createRaydiumAdapter(fake(raw)).quote(ctx); assert.equal(quote.destination.address, output);
    assert.equal(quote.estimatedCompletionMs, null);
  }
  const raw = payload(); raw.data.routePlan = [{ ...raw.data.routePlan[0]!, outputMint: CUSTOM },
    { ...raw.data.routePlan[0]!, inputMint: CUSTOM, feeMint: CUSTOM }];
  assert.equal((await createRaydiumAdapter(fake(raw)).quote(context())).expectedOutRaw, '1000000');
});
test('composed legs bind their own amount/assets, while caller mutation cannot change an in-flight quote', async () => {
  const ctx = context(); Object.assign(ctx.leg, { index: 1 });
  Object.assign(ctx, { slippageBps: 25 });
  Object.assign(ctx.request, { source: { chainId: 'eip155:8453', address: '0x' + '0'.repeat(40), decimals: 18 }, amountRaw: '200' });
  const adapter = createRaydiumAdapter({ ...fake(), fetch: async () => {
    Object.assign(ctx.leg.source, { decimals: 1 }); Object.assign(ctx, { amountRaw: '1' });
    const raw = payload(); raw.data.slippageBps = 25; raw.data.otherAmountThreshold = '997500'; return response(raw);
  } });
  const quote = await adapter.quote(ctx); assert.equal(quote.source.decimals, 9); assert.equal(quote.amountInRaw, '10000000');
});
test('input identity, exact amount, output floors, hop continuity and fee fields reject drift', async () => {
  const mutations: ((raw: ReturnType<typeof payload>) => void)[] = [
    raw => { raw.data.inputMint = USDC; }, raw => { raw.data.outputMint = WSOL; },
    raw => { raw.data.inputAmount = '999'; }, raw => { raw.data.actualInputAmount = '999'; },
    raw => { raw.data.swapType = 'BaseOut'; }, raw => { raw.data.slippageBps = 51; },
    raw => { raw.data.otherAmountThreshold = '994999'; }, raw => { raw.data.otherAmountThreshold = '1000001'; },
    raw => { raw.data.routePlan = []; }, raw => { raw.data.routePlan[0]!.inputMint = USDC; },
    raw => { raw.data.routePlan[0]!.outputMint = CUSTOM; }, raw => { raw.data.routePlan[0]!.poolId = 'invalid'; },
    raw => { raw.data.routePlan[0]!.feeMint = CUSTOM; }, raw => { raw.data.routePlan[0]!.feeRate = -1; },
    raw => { raw.data.routePlan[0]!.feeAmount = '-1'; }, raw => { raw.data.routePlan[0]!.remainingAccounts = ['bad']; },
    raw => { raw.data.referrerAmount = '1'; }, raw => { raw.id = ''; }, raw => { raw.version = 'bad'; },
  ];
  for (const mutate of mutations) { const raw = payload(); mutate(raw); await assert.rejects(createRaydiumAdapter(fake(raw)).quote(context())); }
});
test('impact percentage conversion rounds upward, remains unknown if absent and rejects malformed values', async () => {
  for (const [value, bps] of [[0.05, 5], [0.05001, 6], [1e-8, 1], [100, 10000], [null, null]] as const) {
    const raw = payload(); Object.assign(raw.data, { priceImpactPct: value });
    assert.equal((await createRaydiumAdapter(fake(raw)).quote(context())).priceImpactBps, bps);
  }
  const raw = payload(); delete (raw.data as Partial<typeof raw.data>).priceImpactPct;
  assert.equal((await createRaydiumAdapter(fake(raw)).quote(context())).priceImpactBps, null);
  for (const value of [-1, 101, '0.05']) {
    const raw = payload(); Object.assign(raw.data, { priceImpactPct: value }); await assert.rejects(createRaydiumAdapter(fake(raw)).quote(context()));
  }
});
test('logical route failures and transport errors expose safe codes without upstream text', async () => {
  await assert.rejects(createRaydiumAdapter(fake({ id: 'r', success: false, msg: 'ROUTE_NOT_FOUND' })).quote(context()), error => error.code === 'PROVIDER_NO_ROUTE');
  await assert.rejects(createRaydiumAdapter(fake({ success: false, msg: 'secret upstream' })).quote(context()), error => error.code === 'PROVIDER_QUOTE_REJECTED');
  for (const status of [429, 503]) await assert.rejects(createRaydiumAdapter({ ...fake(), fetch: async () => new Response('secret upstream', { status }) }).quote(context()),
    error => error.code === (status === 429 ? 'PROVIDER_RATE_LIMIT' : 'PROVIDER_HTTP_ERROR') && error.retryable === true);
  await assert.rejects(createRaydiumAdapter({ ...fake(), fetch: async () => { throw new Error('secret upstream'); } }).quote(context()),
    error => error.code === 'PROVIDER_FETCH_OR_PARSE_FAILED' && !error.message.includes('secret'));
});
test('rejects malformed/oversized/deep JSON, invalid content types and redirects', async () => {
  const responses = [new Response('{', { headers: { 'content-type': 'application/json' } }),
    new Response('{"id":"first","i\\u0064":"second"}', { headers: { 'content-type': 'application/json' } }),
    new Response('{"data":{"inputAmount":"1","inputAmount":"2"}}', { headers: { 'content-type': 'application/json' } }),
    new Response('x'.repeat(131073), { headers: { 'content-type': 'application/json' } }),
    new Response('{}', { headers: { 'content-type': 'text/html' } }),
    new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '131073' } }),
    response(JSON.parse('{"a":'.repeat(14) + '0' + '}'.repeat(14))),
    response(JSON.parse('{"__proto__":{}}'))];
  const redirected = response(payload()); Object.defineProperty(redirected, 'redirected', { value: true }); responses.push(redirected);
  for (const row of responses) await assert.rejects(createRaydiumAdapter({ ...fake(), fetch: async () => row }).quote(context()));
  let fragments = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) {
    if (++fragments > 2049) controller.close(); else controller.enqueue(new Uint8Array([32]));
  } });
  await assert.rejects(createRaydiumAdapter({ ...fake(), fetch: async () => new Response(stream, { headers: { 'content-type': 'application/json' } }) }).quote(context()),
    error => error.code === 'PROVIDER_RESPONSE_TOO_FRAGMENTED');
});
test('chain/wallet/context mismatches reject before any public request', async () => {
  let calls = 0; const adapter = createRaydiumAdapter({ ...fake(), fetch: async () => { calls++; return response(payload()); } });
  for (const mutate of [ctx => { Object.assign(ctx.leg, { kind: 'SWAP_BRIDGE' }); },
    ctx => { Object.assign(ctx.leg.destination, { chainId: 'eip155:8453' }); },
    ctx => { Object.assign(ctx.leg.source, { decimals: 18 }); },
    ctx => { Object.assign(ctx, { sender: NATIVE }); }, ctx => { Object.assign(ctx, { amountRaw: '1' }); },
    ctx => { Object.assign(ctx, { recipient: '11111111111111111111111111111113' }); } ] as ((ctx: QuoteContext) => void)[]) {
    const ctx = context(); mutate(ctx); await assert.rejects(adapter.quote(ctx));
  }
  assert.equal(calls, 0);
});
test('cancellation, transport deadline, late results and local pricing expiry cannot produce previews', async () => {
  const cancelled = new AbortController(); cancelled.abort(); const ctx = context(); Object.assign(ctx, { signal: cancelled.signal });
  await assert.rejects(createRaydiumAdapter(fake()).quote(ctx), error => error.code === 'CANCELLED');
  let stamp = now;
  await assert.rejects(createRaydiumAdapter({ clock: () => stamp, fetch: async () => { stamp += 6000; return response(payload()); } }).quote(context()), error => error.code === 'QUOTE_DEADLINE');
  stamp = now;
  await assert.rejects(createRaydiumAdapter({ pricingTtlMs: 5, clock: () => stamp, fetch: async () => { stamp += 6; return response(payload()); } }).quote(context()), error => error.code === 'PROVIDER_QUOTE_EXPIRED');
  const body = new ReadableStream<Uint8Array>({ start() {} }); const slow = context(); Object.assign(slow, { transportDeadlineMs: now + 10 });
  await assert.rejects(createRaydiumAdapter({ ...fake(), fetch: async () => new Response(body, { headers: { 'content-type': 'application/json' } }) }).quote(slow), error => error.code === 'QUOTE_DEADLINE');
  const abort = new AbortController(), during = context(); Object.assign(during, { signal: abort.signal });
  const pending = createRaydiumAdapter({ ...fake(), fetch: async () => { abort.abort(); return response(payload()); } }).quote(during);
  await assert.rejects(pending, error => error.code === 'CANCELLED');
});
test('trusted policy bounds reject invalid options', () => {
  for (const options of [{ ...fake(), pricingTtlMs: 0 }, { ...fake(), pricingTtlMs: 30001 },
    { ...fake(), estimatedCompletionMs: -1 }, { ...fake(), clock: 1 }]) assert.throws(() => createRaydiumAdapter(options as RaydiumOptions));
});
test('a fetch that ignores abort keeps the adapter pending until actual transport settlement', async () => {
  let entered!: () => void, release!: () => void, settled = false;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const abort = new AbortController(), ctx = context(); Object.assign(ctx, { signal: abort.signal });
  const pending = createRaydiumAdapter({ ...fake(), fetch: async () => { entered(); await waiting; return response(payload()); } }).quote(ctx);
  const outcome = pending.then(() => { settled = true; return ''; }, error => { settled = true; return error.code; });
  await started; abort.abort(); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(settled, false); release(); assert.equal(await outcome, 'CANCELLED');
});
