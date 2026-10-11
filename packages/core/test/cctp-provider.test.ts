import assert from 'node:assert/strict';
import test from 'node:test';
import { createCctpAdapter, createCctpDiscovery } from '../dist/cctp-provider.js';
import type { CctpGasEvidence, CctpLegQuote, CctpOptions } from '../dist/cctp-provider.js';
import { CapabilityRegistry } from '../dist/capabilities.js';
import { planRoutes } from '../dist/planner.js';
import type { Asset, RouterRequest } from '../dist/types.js';
import type { QuoteContext } from '../dist/router.js';

const NOW = 1_800_000_000_000;
const SOL: Asset = { chainId: 'solana:mainnet', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 };
const BASE: Asset = { chainId: 'eip155:8453', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 };
const OWNER = '11111111111111111111111111111112', EVM = '0x' + '11'.repeat(20);
const FEES = [{ finalityThreshold: 1000, minimumFee: '1.3' }, { finalityThreshold: 2000, minimumFee: '0' }];

function context(mode: 'FAST' | 'STANDARD' = 'FAST', reverse = false, amountRaw = '1000000'): QuoteContext {
  const source = reverse ? BASE : SOL, destination = reverse ? SOL : BASE;
  const id = mode === 'FAST' ? 'cctp-fast' : 'cctp-standard';
  const request: RouterRequest = { requestId: 'cctp-request', source, destination, amountRaw,
    sender: reverse ? EVM : OWNER, recipient: reverse ? OWNER : EVM, slippageBps: 50, maxFeeBps: 100,
    maxPriceImpactBps: 500, maxCompletionMs: 1_800_000, deadlineMs: NOW + 600_000,
    optimization: { objective: 'BALANCED', maxOutputShortfallBps: 50 } };
  const registry = new CapabilityRegistry([{ id: 'native-usdc', adapterId: id, source, destination, kind: 'BRIDGE',
    validationTier: 'QUOTE_VALIDATED', executionTier: 'NONE', liquidity: 'UNKNOWN', validUntilMs: NOW + 600_000 }]);
  const path = planRoutes(request, registry, { nowMs: NOW }).paths[0]!;
  return { request, leg: path.legs[0]!, amountRaw, sender: request.sender, recipient: request.recipient,
    slippageBps: 50, deadlineMs: request.deadlineMs, transportDeadlineMs: NOW + 2000, signal: new AbortController().signal };
}

function fixture(patch: Partial<CctpOptions> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  let fees: unknown = FEES, allowance: unknown = { allowance: '10000000000', lastUpdated: new Date(NOW).toISOString() };
  let rawFees: string | undefined;
  const options: CctpOptions = { mode: 'FAST', assets: [{ asset: SOL, domain: 5 }, { asset: BASE, domain: 6 }],
    clock: () => NOW, fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(url.includes('/fees/') && rawFees !== undefined ? rawFees : JSON.stringify(url.includes('/fees/') ? fees : allowance),
        { headers: { 'content-type': 'application/json' } });
    }, ...patch };
  return { calls, options, fees: (value: unknown) => { fees = value; }, allowance: (value: unknown) => { allowance = value; },
    rawFees: (value: string) => { rawFees = value; } };
}

async function quote(options: CctpOptions, ctx = context(options.mode)): Promise<CctpLegQuote> {
  return await createCctpAdapter(options).quote(ctx) as CctpLegQuote;
}

function gas(ctx: QuoteContext, patch: Partial<CctpGasEvidence> = {}): CctpGasEvidence {
  return { feeBps: 10, verifiedAtMs: NOW, nativeCosts: [{ chainId: ctx.leg.source.chainId, amountRaw: '10000' },
    { chainId: ctx.leg.destination.chainId, amountRaw: '20000' }], ...patch };
}
test('known CCTP gas above input value is preserved rather than imposing a hidden fee ceiling', async () => {
  const f = fixture({ gasEvidence: async ctx => gas(ctx, { feeBps: 15000 }) });
  const result = await quote(f.options);
  assert.equal(result.feeBps, 15002);
  assert.equal(result.nativeCosts?.length, 2);
  await assert.rejects(quote(fixture({ gasEvidence: async ctx => gas(ctx, { feeBps: Number.MAX_SAFE_INTEGER }) }).options));
});

test('genuine fixed GET fee/allowance pricing preserves exact Circle net units without signing authority', async () => {
  const f = fixture(); const result = await quote(f.options);
  assert.equal(result.protocolFeeRaw, '130'); assert.equal(result.minimumOutRaw, '999870');
  assert.equal(result.expectedOutRaw, '999870'); assert.equal(result.protocolFeeBps, 2);
  assert.equal(result.feeBps, null); assert.equal(result.estimatedCompletionMs, null);
  assert.equal(result.protocolEstimateMs, null); assert.equal(result.conditional, true);
  assert.equal(result.executableRecipeId, undefined);
  assert.equal(result.pricingBasis, 'EXACT_NATIVE_USDC_PROTOCOL_UNITS_NOT_USD');
  assert.equal(result.expiresAtMs, NOW + 600000); assert.equal(result.pricingValidUntilMs, NOW + 5000);
  assert.deepEqual(f.calls.map(call => call.url), ['https://iris-api.circle.com/v2/burn/USDC/fees/5/6',
    'https://iris-api.circle.com/v2/fastBurn/USDC/allowance']);
  assert.ok(f.calls.every(call => call.init.method === 'GET' && call.init.body === undefined && call.init.redirect === 'error'));
});

test('Standard mode does not fetch fast allowance and no unavailable mode downgrade is allowed', async () => {
  const standard = fixture({ mode: 'STANDARD' }); const result = await quote(standard.options);
  assert.equal(result.protocolFeeRaw, '0'); assert.equal(result.minimumOutRaw, '1000000'); assert.equal(standard.calls.length, 1);
  const fast = fixture(); fast.fees([FEES[1]]);
  await assert.rejects(quote(fast.options), /CCTP_MODE_UNAVAILABLE/);
});

test('independently configured reverse pair uses6/5 and exact final asset boundaries', async () => {
  const f = fixture(); const result = await quote(f.options, context('FAST', true));
  assert.equal(result.sourceDomain, 6); assert.equal(result.destinationDomain, 5);
  assert.equal(result.destination.address, SOL.address);
  assert.equal(f.calls[0]!.url, 'https://iris-api.circle.com/v2/burn/USDC/fees/6/5');
  const ctx = context();
  await assert.rejects(quote(f.options, { ...ctx, leg: { ...ctx.leg, destination: { ...BASE, address: '0x' + '22'.repeat(20) } } }), /CCTP_PAIR_UNSUPPORTED/);
  assert.throws(() => createCctpAdapter({ ...f.options, assets: [{ asset: SOL, domain: 5 }, { asset: BASE, domain: 5 }] }), /CCTP_INVALID_CONFIG/);
  assert.throws(() => createCctpAdapter({ ...f.options, assets: [{ asset: SOL, domain: 5 }, { asset: { ...BASE, address: '0x' + '0'.repeat(40) }, domain: 6 }] }), /CCTP_INVALID_CONFIG/);
});

test('fractional numeric bps preserve the exact JSON lexeme rather than rounding away one atomic fee', async () => {
  const f = fixture();
  f.rawFees('[{"finalityThreshold":1000,"minimumFee":1.00000000000000001}]');
  const result = await quote(f.options, context('FAST', false, '1000000000000000'));
  assert.equal(result.protocolFeeRaw, '100000000001');
  assert.equal(result.minimumOutRaw, '999899999999999');
  await assert.rejects(quote(f.options, context('FAST', false, '18446744073709551616')), /CCTP_AMOUNT_UNSUPPORTED/);
});

test('fast allowance must be recent, positive enough in atomic units and never substituted by Standard', async () => {
  for (const value of [{ allowance: '0.999999', lastUpdated: new Date(NOW).toISOString() },
    { allowance: '1', lastUpdated: new Date(NOW - 60001).toISOString() },
    { allowance: '1', lastUpdated: new Date(NOW + 1).toISOString() }]) {
    const f = fixture(); f.allowance(value);
    await assert.rejects(quote(f.options), /CCTP_(FAST_ALLOWANCE|ALLOWANCE_STALE)/);
  }
  const f = fixture(); f.allowance({ allowance: '0.000001', lastUpdated: new Date(NOW).toISOString() });
  f.fees([{ finalityThreshold: 1000, minimumFee: '0' }]);
  assert.equal((await quote(f.options, context('FAST', false, '1'))).minimumOutRaw, '1');
});

test('full fee/time eligibility requires separately priced gas and both configured verification stages', async () => {
  const f = fixture({ gasEvidence: async ctx => gas(ctx), attestationMs: 20000,
    verificationMs: { sourceConfirmationMs: 15000, destinationVerificationMs: 24000 } });
  const result = await quote(f.options);
  assert.equal(result.feeBps, 12); assert.equal(result.estimatedCompletionMs, 59000);
  assert.equal(result.protocolEstimateMs, 20000); assert.equal(result.nativeCosts!.length, 2);
  const protocolOnly = await quote({ ...f.options, gasEvidence: undefined, verificationMs: undefined });
  assert.equal(protocolOnly.feeBps, null); assert.equal(protocolOnly.estimatedCompletionMs, null);
  assert.equal(protocolOnly.protocolEstimateMs, 20000);
});

test('gas evidence rejects missing destination funding, stale valuation and zero/unbounded native costs', async () => {
  for (const changed of [{ nativeCosts: [{ chainId: SOL.chainId, amountRaw: '10000' }] },
    { nativeCosts: [{ chainId: SOL.chainId, amountRaw: '0' }, { chainId: BASE.chainId, amountRaw: '10000' }] },
    { verifiedAtMs: NOW - 5001 }, { verifiedAtMs: NOW + 1 }, { feeBps: 0 }, { feeBps: Number.MAX_SAFE_INTEGER }]) {
    const f = fixture({ gasEvidence: async ctx => gas(ctx, changed) });
    await assert.rejects(quote(f.options));
  }
  const f = fixture({ gasEvidence: async () => { throw new Error('private URL or credentials'); } });
  await assert.rejects(quote(f.options), error => String(error).includes('CCTP_GAS_EVIDENCE_UNAVAILABLE') && !String(error).includes('private URL'));
});

test('metadata single-flight/cache never caches a firm signing quote or swaps owner/amount bindings', async () => {
  const f = fixture(), adapter = createCctpAdapter(f.options);
  const [a, b] = await Promise.all([adapter.quote(context()), adapter.quote(context())]);
  assert.equal(f.calls.length, 2); assert.equal(a.quoteId, b.quoteId);
  const changed = context('FAST', false, '2000000');
  const c = await adapter.quote(changed);
  assert.equal(f.calls.length, 2); assert.notEqual(c.quoteId, a.quoteId); assert.equal(c.minimumOutRaw, '1999740');
  const other = { ...changed, sender: '11111111111111111111111111111113' };
  const d = await adapter.quote(other); assert.notEqual(d.quoteId, c.quoteId);
  assert.equal(d.executableRecipeId, undefined); assert.equal(d.conditional, true);
});

test('invalid decimals, duplicates, type confusion, nonpositive outputs and response framing fail closed', async () => {
  const invalid = [
    '[{"finalityThreshold":1000,"minimumFee":"1","minimumFee":"0"}]',
    '[{"finalityThreshold":1000,"minimumFee":true}]',
    '[{"finalityThreshold":1000,"minimumFee":"-1"}]',
    '[{"finalityThreshold":1000,"minimumFee":"10000"}]',
    '[{"finalityThreshold":1000,"minimumFee":"1"},{"finalityThreshold":1000,"minimumFee":"2"}]',
    '[{"finalityThreshold":1000,"minimumFee":"NaN"}]',
  ];
  for (const raw of invalid) { const f = fixture(); f.rawFees(raw); await assert.rejects(quote(f.options)); }
  const f = fixture(); await assert.rejects(quote(f.options, context('FAST', false, '1')), /CCTP_NONPOSITIVE_OUTPUT/);
  const framing = fixture({ fetch: async () => new Response(JSON.stringify(FEES), { headers: { 'content-length': '1000' } }) });
  await assert.rejects(quote(framing.options), /CCTP_INVALID_RESPONSE/);
});

test('abort, redirects, body limits and request deadline prevent late or arbitrary HTTP work', async () => {
  const ctx = context(); const controller = new AbortController(); controller.abort();
  const f = fixture(); await assert.rejects(quote(f.options, { ...ctx, signal: controller.signal }), /CANCELLED/); assert.equal(f.calls.length, 0);
  const redirect = fixture({ fetch: async () => ({ ok: true, redirected: true, url: 'https://elsewhere.example' }) as Response });
  await assert.rejects(quote(redirect.options), /CCTP_REDIRECT/);
  const large = fixture({ fetch: async () => new Response(' '.repeat(262145)) });
  await assert.rejects(quote(large.options), /CCTP_RESPONSE_TOO_LARGE/);
  await assert.rejects(quote(f.options, { ...ctx, transportDeadlineMs: NOW }), /CCTP_QUOTE_DEADLINE/);
});

test('slow gas proof consumes pricing freshness without extending the original signing deadline', async () => {
  let stamp = NOW;
  const f = fixture({ clock: () => stamp, gasEvidence: async ctx => { stamp += 6000; return gas(ctx, { verifiedAtMs: stamp }); } });
  await assert.rejects(quote(f.options, { ...context(), transportDeadlineMs: NOW + 10000 }), /CCTP_QUOTE_DEADLINE/);
});

test('pricing lifetime cannot exceed a shorter original signing horizon', async () => {
  const f = fixture(), ctx = context();
  const result = await quote(f.options, { ...ctx, deadlineMs: NOW + 3000 });
  assert.equal(result.expiresAtMs, NOW + 3000); assert.equal(result.pricingValidUntilMs, NOW + 3000);
  assert.equal(result.conditional, true); assert.equal(result.executableRecipeId, undefined);
});

test('shared discovery coalesces FAST and STANDARD fees while directions and wallet quotes stay distinct', async () => {
  const f = fixture(), discovery = createCctpDiscovery(f.options);
  const fast = createCctpAdapter({ ...f.options, discovery });
  const standard = createCctpAdapter({ ...f.options, mode: 'STANDARD', discovery });
  const [a, b] = await Promise.all([fast.quote(context()), standard.quote(context('STANDARD'))]);
  assert.equal(f.calls.filter(call => call.url.includes('/fees/')).length, 1);
  assert.equal(f.calls.filter(call => call.url.includes('/allowance')).length, 1);
  assert.notEqual(a.quoteId, b.quoteId);
  const reverse = await fast.quote(context('FAST', true));
  assert.equal(f.calls.filter(call => call.url.includes('/fees/')).length, 2);
  assert.equal(f.calls.filter(call => call.url.includes('/allowance')).length, 1);
  assert.notEqual(reverse.quoteId, a.quoteId);
  assert.equal(reverse.source.chainId, BASE.chainId);
});

test('cancelling the first adapter waiter preserves another adapter and the shared transport', async () => {
  let release!: () => void, entered!: () => void, transportSignal!: AbortSignal;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let calls = 0;
  const f = fixture({ fetch: async (url, init) => {
    if (url.includes('/allowance')) return new Response(JSON.stringify({
      allowance: '10000000000', lastUpdated: new Date(NOW).toISOString(),
    }));
    calls++; transportSignal = init.signal as AbortSignal; entered(); await gate;
    return new Response(JSON.stringify(FEES));
  } });
  const discovery = createCctpDiscovery(f.options);
  const first = createCctpAdapter({ ...f.options, discovery });
  const second = createCctpAdapter({ ...f.options, mode: 'STANDARD', discovery });
  const controller = new AbortController();
  const a = first.quote({ ...context(), signal: controller.signal });
  const b = second.quote(context('STANDARD'));
  await started; controller.abort();
  await assert.rejects(a, /CANCELLED/);
  assert.equal(transportSignal.aborted, false);
  release(); assert.equal((await b).minimumOutRaw, '1000000');
  assert.equal(calls, 1);
});

test('FAST allowance starts while fee response is still withheld; STANDARD remains fees-only', async () => {
  let releaseFees!: () => void, enteredFees!: () => void, allowanceStarted = false;
  const gate = new Promise<void>(resolve => { releaseFees = resolve; });
  const started = new Promise<void>(resolve => { enteredFees = resolve; });
  const f = fixture({ fetch: async url => {
    if (url.includes('/fees/')) { enteredFees(); await gate; return new Response(JSON.stringify(FEES)); }
    allowanceStarted = true;
    return new Response(JSON.stringify({ allowance: '10000000000', lastUpdated: new Date(NOW).toISOString() }));
  } });
  const pending = quote(f.options);
  await started;
  // A turn barrier drains scheduled loaders without releasing the fee response.
  await new Promise<void>(resolve => { setImmediate(resolve); });
  try { assert.equal(allowanceStarted, true); } finally { releaseFees(); }
  assert.equal((await pending).protocolFeeRaw, '130');
  const standard = fixture({ mode: 'STANDARD' }); await quote(standard.options);
  assert.ok(standard.calls.every(call => call.url.includes('/fees/')));
});

test('shared metadata preserves original pricing age and reruns gas proofs for every wallet quote', async () => {
  let stamp = NOW, gasCalls = 0;
  const f = fixture({ clock: () => stamp });
  const discovery = createCctpDiscovery(f.options);
  const evidence = async (ctx: QuoteContext) => { gasCalls++; return gas(ctx, { verifiedAtMs: stamp }); };
  const fast = createCctpAdapter({ ...f.options, discovery, gasEvidence: evidence });
  const standard = createCctpAdapter({ ...f.options, mode: 'STANDARD', discovery, gasEvidence: evidence });
  const ctx = (mode: 'FAST' | 'STANDARD') => ({ ...context(mode), transportDeadlineMs: NOW + 10000 });
  const first = await fast.quote(ctx('FAST')) as CctpLegQuote;
  stamp += 4000;
  const second = await standard.quote(ctx('STANDARD')) as CctpLegQuote;
  assert.equal(second.pricingValidUntilMs, first.pricingValidUntilMs);
  assert.equal(second.expiresAtMs, first.expiresAtMs);
  assert.equal(gasCalls, 2); assert.equal(f.calls.length, 2);
  const slow = createCctpAdapter({ ...f.options, mode: 'STANDARD', discovery,
    gasEvidence: async quoteContext => { stamp += 2000; return gas(quoteContext, { verifiedAtMs: stamp }); } });
  await assert.rejects(slow.quote(ctx('STANDARD')), /CCTP_QUOTE_DEADLINE/);
  const refreshed = await standard.quote(ctx('STANDARD')) as CctpLegQuote;
  assert.equal(refreshed.pricingValidUntilMs, stamp + 5000);
  assert.equal(first.pricingValidUntilMs, NOW + 5000);
  assert.equal(f.calls.filter(call => call.url.includes('/fees/')).length, 2);
});

test('discovery accepts only exact directed domains and a factory-created trusted instance', () => {
  const f = fixture(), discovery = createCctpDiscovery(f.options);
  const request = { signal: new AbortController().signal, timeoutMs: 1000 };
  for (const domains of [[-1, 6], [5, 0x100000000], [5.5, 6], [5, 5]])
    assert.throws(() => discovery.fees(domains[0]!, domains[1]!, request));
  assert.throws(() => createCctpDiscovery({ ...f.options, metadataTtlMs: 5001 }));
  assert.throws(() => createCctpAdapter({ ...f.options, discovery: { ...discovery } }), /CCTP_INVALID_CONFIG/);
  assert.equal(f.calls.length, 0);
});

test('cancelling a pending Circle body releases its reader and never caches the incomplete matrix', async () => {
  let started!: () => void, cancelled!: () => void, calls = 0;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const closed = new Promise<void>(resolve => { cancelled = resolve; });
  const f = fixture({ fetch: async () => {
    if (++calls > 1) return new Response(JSON.stringify(FEES));
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('[')); started(); },
      cancel() { cancelled(); },
    }));
  } });
  const discovery = createCctpDiscovery(f.options), controller = new AbortController();
  const pending = discovery.fees(5, 6, { signal: controller.signal, timeoutMs: 1000 });
  await entered; controller.abort(); await assert.rejects(pending, /CANCELLED/); await closed;
  await new Promise<void>(resolve => { setImmediate(resolve); });
  const result = await discovery.fees(5, 6, { signal: new AbortController().signal, timeoutMs: 1000 });
  assert.equal((result.raw as typeof FEES)[0]!.minimumFee, '1.3'); assert.equal(calls, 2);
});

test('empty body chunks are bounded and unread HTTP failures cancel their streams', async () => {
  let chunks = 0, cancellations = 0;
  const endless = fixture({ mode: 'STANDARD', fetch: async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) { chunks++; controller.enqueue(new Uint8Array()); }, cancel() { cancellations++; },
  })) });
  await assert.rejects(quote(endless.options), /CCTP_RESPONSE_TOO_LARGE/);
  assert.ok(chunks <= 4098); assert.equal(cancellations, 1);
  for (const failure of ['redirect', 'status', 'length']) {
    let closed = 0;
    const body = new ReadableStream<Uint8Array>({ cancel() { closed++; } });
    const response = failure === 'redirect' ? { ok: true, redirected: true, body } as Response :
      new Response(body, { status: failure === 'status' ? 429 : 200,
        headers: failure === 'length' ? { 'content-length': '262145' } : {} });
    const f = fixture({ mode: 'STANDARD', fetch: async () => response });
    await assert.rejects(quote(f.options)); assert.equal(closed, 1);
  }
});
