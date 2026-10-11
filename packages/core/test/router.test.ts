import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityRegistry } from '../dist/capabilities.js';
import { DynamicRouter } from '../dist/router.js';
import type { ProviderAdapter, QuoteContext } from '../dist/router.js';
import type { Asset, LegQuote, RouteCapability, RouterRequest } from '../dist/types.js';

const sol: Asset = { chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', address: '11111111111111111111111111111111', decimals: 9 };
const solUsdc: Asset = { ...sol, address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 };
const base: Asset = { chainId: 'eip155:8453', address: '0x0000000000000000000000000000000000000000', decimals: 18 };
const baseUsdc: Asset = { ...base, address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 };
const req = (): RouterRequest => ({ requestId: 'roundtrip', source: sol, destination: base, amountRaw: '1000', sender: 'solOwner', recipient: '0x1111111111111111111111111111111111111111',
  slippageBps: 100, maxFeeBps: 1000, maxPriceImpactBps: 1000, maxCompletionMs: 200000, deadlineMs: Date.now() + 600000,
  optimization: { objective: 'BALANCED', maxOutputShortfallBps: 50 } });
const edge = (id: string, adapterId: string, source = sol, destination = base): RouteCapability => ({ id, adapterId, source, destination,
  kind: source.chainId === destination.chainId ? 'SWAP' : 'SWAP_BRIDGE', validationTier: 'QUOTE_VALIDATED', executionTier: 'NONE', liquidity: 'UNKNOWN', validUntilMs: Date.now() + 600000 });
const legQuote = (ctx: QuoteContext, out = '1000', time = 1000): LegQuote => ({ capabilityId: ctx.leg.capabilityId, adapterId: ctx.leg.adapterId,
  source: ctx.leg.source, destination: ctx.leg.destination, amountInRaw: ctx.amountRaw, expectedOutRaw: out, minimumOutRaw: out,
  feeBps: 10, priceImpactBps: 10, estimatedCompletionMs: time, expiresAtMs: Date.now() + 100000, quoteId: `${ctx.leg.adapterId}:${out}`,
  conditional: ctx.leg.index > 0, liquidityConfirmed: true,
  costDenominator: { source: ctx.request.source, amountRaw: ctx.request.amountRaw } });
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('parallel comparison selects fastest inside exact value band while a hung quote is bounded', async () => {
  const registry = new CapabilityRegistry([edge('a', 'fast'), edge('b', 'value'), edge('c', 'hung')]);
  const adapters: ProviderAdapter[] = [{ id: 'fast', quote: async ctx => legQuote(ctx, '996', 1000) },
    { id: 'value', quote: async ctx => legQuote(ctx, '1000', 2000) },
    { id: 'hung', quote: async ctx => new Promise((_resolve, reject) => ctx.signal.addEventListener('abort', () => reject(new Error('stop')), { once: true })) }];
  const router = new DynamicRouter(registry, adapters, { quoteBudgetMs: 100, providerTimeoutMs: 35 });
  const start = performance.now(); const result = await router.quote(req());
  assert.equal(result.winner?.legQuotes[0]?.adapterId, 'fast');
  assert.equal(result.comparisonComplete, false); assert.equal(result.executionAuthorized, false);
  assert.equal(result.failures[0]?.code, 'QUOTE_TIMEOUT'); assert.ok(performance.now() - start < 200);
});
test('three-stage path quotes at preceding floors, shares source legs and splits total slippage', async () => {
  const registry = new CapabilityRegistry([edge('source', 'swap', sol, solUsdc), { ...edge('b1', 'bridge1', solUsdc, baseUsdc), kind: 'BRIDGE' },
    { ...edge('b2', 'bridge2', solUsdc, baseUsdc), kind: 'BRIDGE' }, edge('target', 'target', baseUsdc, base)]);
  const calls: QuoteContext[] = [];
  const adapters = ['swap', 'bridge1', 'bridge2', 'target'].map(id => ({ id, quote: async (ctx: QuoteContext) => {
    calls.push(ctx); await pause(2); const out = id === 'swap' ? '900' : id.startsWith('bridge') ? '800' : '700';
    return legQuote(ctx, out);
  } }));
  const result = await new DynamicRouter(registry, adapters, { planner: { intermediates: [solUsdc, baseUsdc] } }).quote(req());
  assert.equal(result.candidates.length, 2); assert.equal(calls.filter(c => c.leg.adapterId === 'swap').length, 1);
  assert.ok(calls.filter(c => c.leg.adapterId.startsWith('bridge')).every(c => c.amountRaw === '900'));
  assert.ok(calls.filter(c => c.leg.adapterId === 'target').every(c => c.amountRaw === '800'));
  for (const c of result.candidates) {
    assert.equal(c.conditional, true); assert.equal(c.executionReady, false); assert.equal(c.minimumOutputRaw, '700');
    assert.equal(c.completionMs, 3000); assert.equal(c.feeBps, 30);
  }
  assert.deepEqual(calls.filter(c => ['swap', 'bridge1', 'target'].includes(c.leg.adapterId)).map(c => c.slippageBps), [50, 0, 50]);
});
test('signing horizon survives short acquisition deadline and callbacks cannot mutate retained candidates', async () => {
  const request = req(); let seen: QuoteContext | undefined;
  const router = new DynamicRouter(new CapabilityRegistry([edge('a', 'p')]), [{ id: 'p', quote: async ctx => {
    seen = ctx; return legQuote(ctx);
  } }], { quoteBudgetMs: 50 });
  const result = await router.quote(request, { onCandidate: candidate => {
    (candidate.legQuotes[0] as any).minimumOutRaw = '1';
  } });
  assert.equal(seen?.deadlineMs, request.deadlineMs); assert.ok(seen!.transportDeadlineMs < request.deadlineMs);
  assert.equal(result.winner?.minimumOutputRaw, '1000'); assert.equal(result.winner?.legQuotes[0]?.minimumOutRaw, '1000');
});
test('bad bindings/slippage and missing intermediate wallet fail without executable results', async () => {
  for (const mutate of [(q: any) => q.amountInRaw = '999', (q: any) => q.minimumOutRaw = '980', (q: any) => q.liquidityConfirmed = false]) {
    const result = await new DynamicRouter(new CapabilityRegistry([edge('a', 'p')]), [{ id: 'p', quote: async ctx => {
      const q = { ...legQuote(ctx) }; mutate(q); return q;
    } }]).quote(req());
    assert.equal(result.winner, null); assert.equal(result.failures.length, 1);
  }
  const third: Asset = { chainId: 'eip155:42161', address: base.address, decimals: 18 };
  const result = await new DynamicRouter(new CapabilityRegistry([edge('a', 'p', sol, third), edge('b', 'p', third, base)]),
    [{ id: 'p', quote: async ctx => legQuote(ctx) }], { planner: { intermediates: [third] } }).quote(req());
  assert.equal(result.winner, null); assert.equal(result.failures[0]?.code, 'MISSING_INTERMEDIATE_WALLET');
});
test('unknown economics are retained diagnostically and not selected; quotes are fresh across requests', async () => {
  let count = 0;
  const router = new DynamicRouter(new CapabilityRegistry([edge('a', 'p')]), [{ id: 'p', quote: async ctx => {
    count++; return { ...legQuote(ctx), feeBps: null };
  } }]);
  const first = await router.quote(req()); await router.quote(req());
  assert.equal(count, 2); assert.equal(first.winner, null); assert.equal(first.candidates.length, 1);
  assert.deepEqual(first.excluded[0]?.reasons, ['UNKNOWN_COSTS']);
});
test('floor rounding accepts a one raw unit output', async () => {
  const request = { ...req(), slippageBps: 50 };
  const result = await new DynamicRouter(new CapabilityRegistry([edge('a', 'p')]), [{ id: 'p', quote: async ctx => ({
    ...legQuote(ctx, '101'), minimumOutRaw: '100',
  }) }]).quote(request);
  assert.equal(result.winner?.minimumOutputRaw, '100');
});
test('composed fees with different intermediate denominators cannot bypass the original total budget', async () => {
  const registry = new CapabilityRegistry([edge('source', 'swap', sol, solUsdc), edge('bridge', 'bridge', solUsdc, base)]);
  const adapters = ['swap', 'bridge'].map(id => ({ id, quote: async (ctx: QuoteContext) => ({ ...legQuote(ctx),
    costDenominator: { source: ctx.leg.source, amountRaw: ctx.amountRaw },
  }) }));
  const result = await new DynamicRouter(registry, adapters, { planner: { intermediates: [solUsdc] } }).quote(req());
  assert.equal(result.winner, null); assert.equal(result.candidates[0]?.feeBps, null);
  assert.deepEqual(result.excluded[0]?.reasons, ['UNKNOWN_COSTS']);
});

test('price slippage remainder goes to the last swap, while pure bridges get no price allowance', async () => {
  const calls: QuoteContext[] = [];
  const registry = new CapabilityRegistry([edge('source', 'swap', sol, solUsdc),
    { ...edge('bridge', 'bridge', solUsdc, baseUsdc), kind: 'BRIDGE' }]);
  const adapters = ['swap', 'bridge'].map(id => ({ id, quote: async (ctx: QuoteContext) => {
    calls.push(ctx); return legQuote(ctx);
  } }));
  const result = await new DynamicRouter(registry, adapters, { planner: { intermediates: [solUsdc] } })
    .quote({ ...req(), destination: baseUsdc, slippageBps: 101 });
  assert.equal(result.winner?.executionReady, false);
  assert.deepEqual(calls.map(call => call.slippageBps), [101, 0]);
  const bridgeOnly = new DynamicRouter(new CapabilityRegistry([{ ...edge('only', 'bridge', solUsdc, baseUsdc), kind: 'BRIDGE' }]),
    [{ id: 'bridge', quote: async ctx => { calls.push(ctx); return { ...legQuote(ctx), minimumOutRaw: '999' }; } }]);
  const invalid = await bridgeOnly.quote({ ...req(), source: solUsdc, destination: baseUsdc });
  assert.equal(calls.at(-1)!.slippageBps, 0);
  assert.equal(invalid.winner, null); assert.equal(invalid.failures[0]!.code, 'QUOTE_SLIPPAGE');
});
