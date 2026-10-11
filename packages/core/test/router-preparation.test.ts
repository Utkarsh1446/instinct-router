import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Build-generated runtime artifact; bind its source declaration below.
import { CapabilityRegistry as RuntimeCapabilityRegistry } from '../dist/capabilities.js';
// @ts-expect-error Build-generated runtime artifact; bind its source declaration below.
import { DynamicRouter as RuntimeDynamicRouter } from '../dist/router.js';
// @ts-expect-error Build-generated runtime artifact; bind its source declaration below.
import { QuoteScheduler as RuntimeQuoteScheduler } from '../dist/scheduler.js';
import type { ProviderAdapter, QuoteContext, PreparationContext } from '../src/router.ts';
import type { Asset, LegQuote, RouteCapability, RouterRequest } from '../src/types.ts';
const CapabilityRegistry: typeof import('../src/capabilities.ts').CapabilityRegistry = RuntimeCapabilityRegistry;
const DynamicRouter: typeof import('../src/router.ts').DynamicRouter = RuntimeDynamicRouter;
const QuoteScheduler: typeof import('../src/scheduler.ts').QuoteScheduler = RuntimeQuoteScheduler;

const source: Asset = { chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', address: '11111111111111111111111111111111', decimals: 9 };
const middle: Asset = { chainId: 'eip155:8453', address: '0x' + '22'.repeat(20), decimals: 6 };
const target: Asset = { ...middle, address: '0x' + '33'.repeat(20), decimals: 18 };
function request(): RouterRequest {
  return { requestId: 'prepare', source, destination: target, amountRaw: '1000', sender: 'solOwner', recipient: '0x' + '11'.repeat(20),
    slippageBps: 100, maxFeeBps: 1000, maxPriceImpactBps: 1000, maxCompletionMs: 100000, deadlineMs: Date.now() + 60000,
    optimization: { objective: 'BALANCED', maxOutputShortfallBps: 50 } };
}
function edge(id: string, adapterId: string, from = source, to = middle): RouteCapability {
  return { id, adapterId, source: from, destination: to, kind: from.chainId === to.chainId ? 'SWAP' : 'BRIDGE',
    validationTier: 'QUOTE_VALIDATED', executionTier: 'NONE', liquidity: 'UNKNOWN', validUntilMs: Date.now() + 60000 };
}
function quoted(ctx: QuoteContext, output = '800'): LegQuote {
  return { capabilityId: ctx.leg.capabilityId, adapterId: ctx.leg.adapterId, source: ctx.leg.source, destination: ctx.leg.destination,
    amountInRaw: ctx.amountRaw, expectedOutRaw: output, minimumOutRaw: output, feeBps: 0, priceImpactBps: 0,
    estimatedCompletionMs: 1000, expiresAtMs: Date.now() + 30000, quoteId: `${ctx.leg.adapterId}:${ctx.amountRaw}`,
    conditional: true, liquidityConfirmed: true, costDenominator: { source: ctx.request.source, amountRaw: ctx.request.amountRaw } };
}
function gate() {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), release: () => resolve() };
}
const until = async (predicate: () => boolean) => {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise(done => setTimeout(done, 1));
  assert.ok(predicate(), 'Expected deterministic work boundary was not reached');
};

test('future preparation overlaps both first legs, shares exact context, and quotes only settled floors', async () => {
  const first = gate(), prepared = gate(), events: string[] = [], amounts: string[] = [];
  let preparation: PreparationContext | undefined;
  const adapters: ProviderAdapter[] = ['fast', 'standard'].map(id => ({ id, quote: async ctx => {
    events.push(id); await first.promise; return quoted(ctx, id === 'fast' ? '900' : '800');
  } }));
  adapters.push({ id: 'dex', quote: async () => assert.fail('Prepared path must use the bound closure'), prepare: async ctx => {
    preparation = ctx; events.push('prepare'); await prepared.promise;
    return { quote: async actual => { amounts.push(actual.amountRaw); return quoted(actual, '700'); } };
  } });
  const router = new DynamicRouter(new CapabilityRegistry([edge('fast', 'fast'), edge('standard', 'standard'), edge('dex', 'dex', middle, target)]),
    adapters, { planner: { intermediates: [middle] } });
  const pending = router.quote(request());
  await until(() => events.includes('prepare'));
  assert.deepEqual(events, ['fast', 'standard', 'prepare']); assert.deepEqual(amounts, []);
  assert.equal(Object.hasOwn(preparation!, 'amountRaw'), false); assert.equal(preparation!.leg.index, 1);
  prepared.release(); first.release();
  const result = await pending;
  assert.deepEqual(amounts.sort(), ['800', '900']); assert.equal(result.candidates.length, 2);
  assert.equal(events.filter(event => event === 'prepare').length, 1);
  assert.ok(result.candidates.every(candidate => candidate.executionReady === false && candidate.minimumOutputRaw === '700'));
  await router.quote(request()); assert.equal(events.filter(event => event === 'prepare').length, 2); // Never cross-request.
});

test('all required first-leg jobs precede optional preparation in a one-slot scheduler', async () => {
  const events: string[] = [];
  const adapters: ProviderAdapter[] = ['bridge', 'relay', 'aurora', 'debridge'].map(id => ({ id, quote: async ctx => { events.push(id); return quoted(ctx); } }));
  adapters.push({ id: 'dex', quote: async ctx => quoted(ctx), prepare: async () => {
    events.push('prepare'); return { quote: async ctx => { events.push('destination'); return quoted(ctx); } };
  } });
  const registry = new CapabilityRegistry([edge('bridge', 'bridge'), edge('dex', 'dex', middle, target),
    ...['relay', 'aurora', 'debridge'].map(id => edge(id, id, source, target))]);
  const result = await new DynamicRouter(registry, adapters, { planner: { intermediates: [middle] }, scheduler: new QuoteScheduler({ maxConcurrency: 1 }) }).quote(request());
  const prepareIndex = events.indexOf('prepare');
  for (const id of ['bridge', 'relay', 'aurora', 'debridge']) assert.ok(events.indexOf(id) < prepareIndex);
  assert.equal(result.failures.length, 0); assert.equal(events.at(-1), 'destination');
});

test('trusted preparation control is strict; disabled and unsupported adapters retain normal quote behavior', async () => {
  let prepares = 0, calls = 0;
  const dex: ProviderAdapter = { id: 'dex', prepare: async () => { prepares++; return { quote: async ctx => quoted(ctx) }; },
    quote: async ctx => { calls++; return quoted(ctx); } };
  const registry = new CapabilityRegistry([edge('first', 'bridge'), edge('dex', 'dex', middle, target)]);
  const adapters = [{ id: 'bridge', quote: async (ctx: QuoteContext) => quoted(ctx) }, dex];
  const result = await new DynamicRouter(registry, adapters, { planner: { intermediates: [middle] }, disablePreparation: true }).quote(request());
  assert.equal(prepares, 0); assert.equal(calls, 1); assert.equal(result.failures.length, 0);
  assert.throws(() => new DynamicRouter(registry, adapters, { disablePreparation: 1 as unknown as boolean }), /INVALID_PREPARATION_OPTION/);
});

test('preparation failure rejects the path without fabricating liquidity or an ordinary fallback', async () => {
  let calls = 0;
  const result = await new DynamicRouter(new CapabilityRegistry([edge('bridge', 'bridge'), edge('dex', 'dex', middle, target)]),
    [{ id: 'bridge', quote: async ctx => quoted(ctx) }, { id: 'dex', prepare: async () => { throw new Error('bad header'); },
      quote: async ctx => { calls++; return quoted(ctx); } }], { planner: { intermediates: [middle] } }).quote(request());
  assert.equal(result.candidates.length, 0); assert.equal(calls, 0); assert.equal(result.comparisonComplete, false);
});

test('cancelled preparation retains scheduler slot until ignored-abort work actually settles', async () => {
  const held = gate(), events: string[] = [], controller = new AbortController(), scheduler = new QuoteScheduler({ maxConcurrency: 2 });
  const registry = new CapabilityRegistry([edge('bridge', 'bridge'), edge('dex', 'dex', middle, target)]);
  const pending = new DynamicRouter(registry, [{ id: 'bridge', quote: async ctx => {
    events.push('source'); return new Promise((_resolve, reject) => ctx.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }));
  } }, { id: 'dex', prepare: async () => { events.push('prepare'); await held.promise; return { quote: async ctx => quoted(ctx) }; },
    quote: async ctx => quoted(ctx) }], { planner: { intermediates: [middle] }, scheduler }).quote(request(), { signal: controller.signal });
  await until(() => events.includes('prepare')); controller.abort();
  const result = await pending; assert.equal(result.candidates.length, 0);
  await until(() => scheduler.snapshot().active === 1);
  assert.equal(scheduler.snapshot().active, 1); held.release(); await until(() => scheduler.snapshot().active === 0);
});

test('unused optional preparation is canceled when its source path has already failed', async () => {
  let cancelled = false, entered = false;
  const registry = new CapabilityRegistry([edge('bridge', 'bridge'), edge('dex', 'dex', middle, target)]);
  await new DynamicRouter(registry, [{ id: 'bridge', quote: async () => { await new Promise(done => setTimeout(done, 1)); throw new Error('unavailable'); } },
    { id: 'dex', prepare: async ctx => { entered = true; return new Promise((_resolve, reject) => ctx.signal.addEventListener('abort', () => { cancelled = true; reject(new Error('cancel')); }, { once: true })); }, quote: async ctx => quoted(ctx) }],
    { planner: { intermediates: [middle] } }).quote(request());
  assert.equal(entered, true); assert.equal(cancelled, true);
});
