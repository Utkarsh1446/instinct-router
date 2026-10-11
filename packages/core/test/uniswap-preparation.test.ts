import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Build-generated runtime artifact; bind its source declaration below.
import * as runtime from '../dist/uniswap-v3-provider.js';
const { createUniswapV3Adapter, BASE_V3 }: typeof import('../src/uniswap-v3-provider.ts') = runtime;
import type { QuoteContext, PreparationContext } from '../src/router.ts';
import type { UniswapV3LegQuote } from '../src/uniswap-v3-provider.ts';
const NOW = 1800000000000, HASH = '0x' + '12'.repeat(32);
const usdc = { chainId: BASE_V3.chainId, address: '0x' + '22'.repeat(20), decimals: 6 };
const eth = { chainId: BASE_V3.chainId, address: BASE_V3.native, decimals: 18 };
const word = (n: number | bigint) => BigInt(n).toString(16).padStart(64, '0');
const abi = (...n: (number | bigint)[]) => '0x' + n.map(word).join('');
function context(): QuoteContext {
  const owner = '0x' + '11'.repeat(20), request = { requestId: 'scoped', source: usdc, destination: eth,
    amountRaw: '1000000', sender: owner, recipient: owner, slippageBps: 50, maxFeeBps: 500, maxPriceImpactBps: 500,
    maxCompletionMs: 100000, deadlineMs: NOW + 60000, optimization: { objective: 'BALANCED' as const, maxOutputShortfallBps: 50 } };
  return { request, leg: { index: 2, capabilityId: 'usdc-eth', adapterId: 'uniswap-v3', kind: 'SWAP', source: usdc, destination: eth,
    validationTier: 'QUOTE_VALIDATED', executionTier: 'NONE', quoteProbe: true, amountSource: 'ACTUAL_PREVIOUS_SETTLED_OUTPUT', requiresRequoteAfterSettlement: true },
    amountRaw: '999999', sender: owner, recipient: owner, slippageBps: 25, deadlineMs: NOW + 60000,
    transportDeadlineMs: NOW + 30000, signal: new AbortController().signal };
}
function prepareContext(ctx: QuoteContext): PreparationContext {
  const { amountRaw: _amount, ...rest } = ctx; return rest;
}
function fixture() {
  let now = NOW, round = 0;
  const batches: any[][] = [];
  let mutate: (rows: any[], batch: any[]) => void = () => {};
  const options = { clock: () => now, fetch: async (_url: string, init: RequestInit) => {
    const batch = JSON.parse(init.body as string); batches.push(batch);
    if (batch[0]?.method === 'eth_chainId') round++;
    const rows = batch.map((call: any) => {
      let result;
      if (call.method === 'eth_chainId') result = '0x2105';
      else if (call.method === 'eth_getBlockByNumber') result = { number: '0x' + (100 + round).toString(16), hash: HASH, timestamp: '0x' + Math.floor(now / 1000).toString(16) };
      else {
        assert.equal(call.method, 'eth_call'); assert.deepEqual(call.params[1], { blockHash: HASH, requireCanonical: true });
        const data = call.params[0].data;
        if (data === '0x313ce567') result = abi(call.params[0].to === usdc.address ? 6 : 18);
        else if (data.startsWith('0x1698ee82')) result = abi(1);
        else { assert.ok(data.startsWith('0xc6a5026a')); result = abi(100003, 1n << 96n, 0, 40000); }
      }
      return { jsonrpc: '2.0', id: call.id, result };
    });
    mutate(rows, batch); return new Response(JSON.stringify(rows));
  } };
  return { options, batches, clock: (value: number) => { now = value; }, mutate: (fn: typeof mutate) => { mutate = fn; } };
}

test('preparation reads no amount-dependent data; both actual amounts share only the private header', async () => {
  const f = fixture(), ctx = context(), adapter = createUniswapV3Adapter(f.options);
  const prepared = await adapter.prepare!(prepareContext(ctx));
  assert.deepEqual(f.batches.flat().map(call => call.method), ['eth_chainId', 'eth_getBlockByNumber']);
  f.clock(NOW + 1000);
  const first = await prepared.quote(ctx) as UniswapV3LegQuote;
  const second = await prepared.quote({ ...ctx, amountRaw: '888888' }) as UniswapV3LegQuote;
  assert.equal(f.batches.length, 3); assert.equal(first.pricingValidUntilMs, NOW + 5000);
  assert.equal(second.pricingValidUntilMs, NOW + 5000); // Not a new quote-start TTL.
  assert.equal(first.blockHash, second.blockHash); assert.equal(first.minimumOutRaw, '99752');
  const inputAmounts = f.batches.slice(1).map(batch => BigInt('0x' + batch[2 + 7]!.params[0].data.slice(138, 202)).toString());
  assert.deepEqual(inputAmounts, ['999999', '888888']);
  assert.equal(first.conditional, true); assert.equal(first.executableRecipeId, undefined);
});

test('copied request, different pair/decimals/capability/wallet/deadline and forged JSON evidence cannot reuse preparation', async () => {
  const f = fixture(), ctx = context(), adapter = createUniswapV3Adapter(f.options), prepared = await adapter.prepare!(prepareContext(ctx));
  const mutations: QuoteContext[] = [{ ...ctx, request: structuredClone(ctx.request) },
    { ...ctx, leg: { ...ctx.leg, capabilityId: 'changed' } }, { ...ctx, leg: { ...ctx.leg, index: 1 } },
    { ...ctx, leg: { ...ctx.leg, source: { ...usdc, decimals: 7 } } },
    { ...ctx, leg: { ...ctx.leg, destination: { ...eth, address: '0x' + '33'.repeat(20) } } },
    { ...ctx, recipient: '0x' + '44'.repeat(20) }, { ...ctx, slippageBps: 50 },
    { ...ctx, deadlineMs: ctx.deadlineMs + 1 }, { ...ctx, transportDeadlineMs: ctx.transportDeadlineMs + 1 }];
  for (const changed of mutations) await assert.rejects(prepared.quote(changed), /V3_PREPARATION_CONTEXT_MISMATCH/);
  assert.equal(f.batches.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(prepared)), {}); // No serialized header/capability.
  assert.equal(Object.isFrozen(prepared), true);
  // Supplying a forged field to ordinary quote cannot select a header.
  await adapter.quote({ ...ctx, preparedHeader: { hash: '0x' + '00'.repeat(32) } } as QuoteContext);
  assert.equal(f.batches.length, 3);
});

test('original request mutation during or after preparation is rejected, not adopted', async () => {
  const f = fixture(), ctx = context();
  f.mutate((_rows, batch) => { if (batch[0]?.method === 'eth_chainId') (ctx.request as any).requestId = 'mutated'; });
  const prepared = await createUniswapV3Adapter(f.options).prepare!(prepareContext(ctx));
  await assert.rejects(prepared.quote(ctx), /V3_PREPARATION_CONTEXT_MISMATCH/); assert.equal(f.batches.length, 1);
});

test('expired preparation refreshes exactly once; stale refreshed evidence never extends repeatedly', async () => {
  const f = fixture(), ctx = context(), prepared = await createUniswapV3Adapter(f.options).prepare!(prepareContext(ctx));
  f.clock(NOW + 5000);
  const refreshed = await prepared.quote(ctx) as UniswapV3LegQuote;
  assert.equal(f.batches.length, 3); assert.equal(refreshed.blockNumber, '0x66'); assert.equal(refreshed.pricingValidUntilMs, NOW + 10000);
  f.clock(NOW + 6000); await prepared.quote({ ...ctx, amountRaw: '888888' }); assert.equal(f.batches.length, 4);
  f.clock(NOW + 10000); await assert.rejects(prepared.quote(ctx), /V3_QUOTE_DEADLINE/);
  assert.equal(f.batches.length, 4); // No third header, and no amount-dependent request.
});

test('refresh retains exact canonical block guards and refuses wrong chain/partial header', async () => {
  for (const fault of ['chain', 'header']) {
    const f = fixture(), ctx = context(), prepared = await createUniswapV3Adapter(f.options).prepare!(prepareContext(ctx));
    f.clock(NOW + 5000); f.mutate((rows, batch) => {
      if (batch[0]?.method !== 'eth_chainId') return;
      if (fault === 'chain') rows[0].result = '0x1'; else rows[1].result.hash = undefined;
    });
    await assert.rejects(prepared.quote(ctx), /V3_CHAIN_MISMATCH|V3_INVALID_BLOCK/);
    await assert.rejects(prepared.quote(ctx), /V3_CHAIN_MISMATCH|V3_INVALID_BLOCK/);
    assert.equal(f.batches.length, 2); // Failed refresh is not retried or silently ignored.
  }
});

test('preparation cannot extend original deadlines or retain canceled evidence', async () => {
  const f = fixture(), ctx = context(), controller = new AbortController();
  const prepared = await createUniswapV3Adapter(f.options).prepare!(prepareContext({ ...ctx, signal: controller.signal }));
  controller.abort(); await assert.rejects(prepared.quote(ctx), /CANCELLED/); assert.equal(f.batches.length, 1);
  const limited = fixture(), deadlineCtx = { ...context(), transportDeadlineMs: NOW + 3000 };
  const expiring = await createUniswapV3Adapter(limited.options).prepare!(prepareContext(deadlineCtx));
  limited.clock(NOW + 3000); await assert.rejects(expiring.quote(deadlineCtx), /V3_QUOTE_DEADLINE/); assert.equal(limited.batches.length, 1);
});

test('wrong chain, future/stale block in preparation fail before amount reads', async () => {
  for (const fault of ['chain', 'future', 'stale']) {
    const f = fixture(), ctx = context(); f.mutate((rows, batch) => {
      if (batch[0]?.method !== 'eth_chainId') return;
      if (fault === 'chain') rows[0].result = '0x1'; else rows[1].result.timestamp = '0x' + ((NOW + (fault === 'future' ? 3000 : -13000)) / 1000).toString(16);
    });
    await assert.rejects(createUniswapV3Adapter(f.options).prepare!(prepareContext(ctx)), /V3_CHAIN_MISMATCH|V3_STALE_BLOCK/);
    assert.equal(f.batches.length, 1);
  }
});


test('header age is rechecked after simulation in prepared and ordinary quotes', async () => {
  for (const prepare of [false, true]) {
    const f = fixture(), ctx = context();
    f.mutate((rows, batch) => {
      if (batch[0]?.method === 'eth_chainId') rows[1].result.timestamp = '0x' + ((NOW - 11000) / 1000).toString(16);
      else f.clock(NOW + 2000);
    });
    const adapter = createUniswapV3Adapter(f.options);
    const execute = prepare ? await adapter.prepare!(prepareContext(ctx)) : adapter;
    await assert.rejects(execute.quote(ctx), /V3_STALE_BLOCK/);
    assert.equal(f.batches.length, 2);
  }
});

test('valid old header cannot advertise a pricing cutoff beyond remaining block freshness', async () => {
  const f = fixture(), ctx = context();
  f.mutate((rows, batch) => {
    if (batch[0]?.method === 'eth_chainId') rows[1].result.timestamp = '0x' + ((NOW - 10000) / 1000).toString(16);
    else f.clock(NOW + 1000);
  });
  const prepared = await createUniswapV3Adapter(f.options).prepare!(prepareContext(ctx));
  const quote = await prepared.quote(ctx) as UniswapV3LegQuote;
  assert.equal(quote.pricingValidUntilMs, NOW + 2000); assert.equal(quote.expiresAtMs, NOW + 2000);
});
