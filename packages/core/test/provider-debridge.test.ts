import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeBridgeAdapter } from '../dist/provider-adapters.js';
import type { QuoteContext } from '../src/router.js';
import type { DeBridgeOptions } from '../src/debridge-provider.js';
const now = 1800000000000;
const base = 'eip155:8453' as const, arb = 'eip155:42161' as const;
const zero = '0x0000000000000000000000000000000000000000';
const usdc = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const wallet = '0x1111111111111111111111111111111111111111';
function context(): QuoteContext {
  const source = { chainId: base, address: zero, decimals: 18 }, destination = { chainId: arb, address: usdc, decimals: 6 };
  const request = { requestId: 'r1', source, destination, amountRaw: '1000000000000000', sender: wallet, recipient: wallet,
    slippageBps: 50, maxFeeBps: 500, maxPriceImpactBps: 500, maxCompletionMs: 60000, deadlineMs: now + 60000,
    optimization: { objective: 'BALANCED' as const, maxOutputShortfallBps: 50 } };
  return { request, leg: { index: 0, adapterId: 'debridge', capabilityId: 'debridge:direct', kind: 'SWAP_BRIDGE', source, destination,
    validationTier: 'QUOTE_VALIDATED', executionTier: 'NONE', quoteProbe: true, amountSource: 'REQUEST_AMOUNT', requiresRequoteAfterSettlement: false },
    amountRaw: request.amountRaw, sender: wallet, recipient: wallet, slippageBps: 50, deadlineMs: now + 60000,
    transportDeadlineMs: now + 5000, signal: new AbortController().signal };
}
// Sanitized public 2026-10-09 Base ETH0.001 -> Arbitrum USDC estimation shape.
function payload(): any {
  return { estimation: { srcChainTokenIn: { chainId: 8453, address: zero, decimals: 18, amount: '1000000000000000',
    approximateOperatingExpense: '129512976597972', mutatedWithOperatingExpense: false },
    dstChainTokenOut: { chainId: 42161, address: usdc, decimals: 6, amount: '2146997', recommendedAmount: '2146997', maxTheoreticalAmount: '2153457' },
    recommendedSlippage: 0.3, costsDetails: [{ type: 'DlnProtocolFee', payload: { feeBps: '4' } }] },
    tx: { data: 'secret-artifact' }, order: { receiverDst: 'unbound' }, protocolFee: '400000000000' };
}
function options(raw: unknown = payload()): DeBridgeOptions {
  return { chains: [{ chainId: base, debridgeChainId: 8453 }, { chainId: arb, debridgeChainId: 42161 }],
    clock: () => now, estimatedCompletionMs: 10000, fetch: async () => Response.json(raw) };
}
test('public quote-only request omits every wallet/construction field and returns conditional bound pricing', async () => {
  const opt = options(); let address = '';
  opt.fetch = async (url, init) => {
    address = url; assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error'); assert.equal(init.body, undefined);
    assert.deepEqual(init.headers, { accept: 'application/json' }); return Response.json(payload());
  };
  const quote = await createDeBridgeAdapter(opt).quote(context());
  const url = new URL(address);
  assert.equal(url.origin, 'https://dln.debridge.finance');
  assert.deepEqual([...url.searchParams.keys()].sort(), ['srcChainId','srcChainTokenIn','srcChainTokenInAmount','dstChainId','dstChainTokenOut','dstChainTokenOutAmount','prependOperatingExpenses'].sort());
  assert.equal(url.searchParams.get('prependOperatingExpenses'), 'false');
  assert.equal(quote.expectedOutRaw, '2146997'); assert.equal(quote.minimumOutRaw, '2146997');
  assert.equal(quote.feeBps, null); assert.equal(quote.priceImpactBps, null); assert.equal(quote.nativeCosts, undefined);
  assert.equal(quote.conditional, true); assert.equal(quote.executableRecipeId, undefined);
  assert.equal(quote.expiresAtMs, now + 15000); assert.equal(quote.protocolEstimateMs, null);
  assert.ok(!JSON.stringify(quote).includes('secret-artifact'));
  const second = context(); second.request = { ...second.request, requestId: 'r2' };
  assert.notEqual(quote.quoteId, (await createDeBridgeAdapter(options()).quote(second)).quoteId);
});
test('chain/token/decimals/input mutation, output floors and malformed slippage fail closed', async () => {
  const mutations = [
    (p: any) => p.estimation.srcChainTokenIn.chainId = 1,
    (p: any) => p.estimation.dstChainTokenOut.chainId = '42161',
    (p: any) => p.estimation.srcChainTokenIn.decimals = 9,
    (p: any) => p.estimation.dstChainTokenOut.decimals = 18,
    (p: any) => p.estimation.dstChainTokenOut.address = wallet,
    (p: any) => p.estimation.srcChainTokenIn.amount = '999',
    (p: any) => p.estimation.srcChainTokenIn.mutatedWithOperatingExpense = true,
    (p: any) => p.estimation.dstChainTokenOut.amount = '2e6',
    (p: any) => p.estimation.dstChainTokenOut.recommendedAmount = '2146998',
    (p: any) => p.estimation.dstChainTokenOut.recommendedAmount = '1',
    (p: any) => p.estimation.dstChainTokenOut.maxTheoreticalAmount = '1',
    (p: any) => p.estimation.recommendedSlippage = '0.3',
    (p: any) => p.errorId = 'ERROR_LOW_GIVE_AMOUNT',
  ];
  for (const mutate of mutations) { const p = payload(); mutate(p); await assert.rejects(createDeBridgeAdapter(options(p)).quote(context())); }
});
test('partial or missing economic fields never become full known cost or impact', async () => {
  for (const economic of [{ protocolFee: '0', usdPriceImpact: 0 }, { costsDetails: [], feeBps: 0 }]) {
    const p = payload(); Object.assign(p, economic); delete p.estimation.costsDetails;
    const q = await createDeBridgeAdapter(options(p)).quote(context());
    assert.equal(q.feeBps, null); assert.equal(q.priceImpactBps, null);
  }
});
test('direct-only identity/config bounds reject before any public fetch', async () => {
  const opt = options(); opt.fetch = async () => { assert.fail('must not fetch'); };
  for (const mutate of [(c: any) => c.leg.index = 1, (c: any) => c.sender = wallet.replace(/1/g, '2'),
    (c: any) => c.request.destination = c.request.source, (c: any) => c.slippageBps = 51,
    (c: any) => c.recipient = zero, (c: any) => c.transportDeadlineMs = now]) {
    const c = context(); mutate(c); await assert.rejects(createDeBridgeAdapter(opt).quote(c));
  }
  assert.throws(() => createDeBridgeAdapter({ ...opt, chains: [{ chainId: base, debridgeChainId: 1 }] }));
  assert.throws(() => createDeBridgeAdapter({ ...opt, pricingTtlMs: 60001 }));
});
test('duplicate keys, prototypes, invalid content, oversized bodies and HTTP errors are sanitized', async () => {
  for (const text of ['{"estimation":{},"estimation":{}}', '{"__proto__":{}}', '{', 'x'.repeat(131073)]) {
    const opt = options(); opt.fetch = async () => new Response(text, { headers: { 'content-type': 'application/json' } });
    await assert.rejects(createDeBridgeAdapter(opt).quote(context()));
  }
  const opt = options(); opt.fetch = async () => new Response('private upstream error', { status: 429 });
  await assert.rejects(createDeBridgeAdapter(opt).quote(context()), (e: any) => e.code === 'PROVIDER_RATE_LIMIT' && !String(e).includes('private'));
});
test('abort-ignoring fetch retains transport work until settled and cannot return a late quote', async () => {
  let settle!: (r: Response) => void; const opt = options();
  opt.fetch = () => new Promise(resolve => { settle = resolve; });
  const abort = new AbortController(), c = context(); c.signal = abort.signal;
  let finished = false; const work = createDeBridgeAdapter(opt).quote(c).finally(() => { finished = true; });
  abort.abort(); await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(finished, false);
  settle(Response.json(payload())); await assert.rejects(work, (e: any) => e.code === 'CANCELLED');
});
test('response clock deadline and local TTL are enforced, including event-loop delayed timers', async () => {
  const opt = options(); let tick = now; opt.clock = () => tick;
  opt.fetch = async () => { tick = now + 6000; return Response.json(payload()); };
  await assert.rejects(createDeBridgeAdapter(opt).quote(context()), (e: any) => e.code === 'QUOTE_DEADLINE');
  const ttl = options(); ttl.pricingTtlMs = 1; ttl.fetch = async () => { await new Promise(r => setTimeout(r, 3)); return Response.json(payload()); };
  ttl.clock = () => Date.now(); const c = context(); const live = Date.now(); c.deadlineMs = live + 5000; c.transportDeadlineMs = live + 5000; c.request = { ...c.request, deadlineMs: live + 5000 };
  await assert.rejects(createDeBridgeAdapter(ttl).quote(c), (e: any) => e.code === 'PROVIDER_QUOTE_EXPIRED');
});
test('Solana mainnet native mapping verifies exact decimals and keeps wallet sentinels invalid', async () => {
  const sol = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' as const;
  const c = context(); const destination = { chainId: sol, address: '11111111111111111111111111111111', decimals: 9 };
  const recipient = '11111111111111111111111111111112';
  c.request = { ...c.request, destination, recipient }; c.leg = { ...c.leg, destination }; c.recipient = recipient;
  const p = payload(); p.estimation.dstChainTokenOut = { chainId: 7565164, address: destination.address, decimals: 9,
    amount: '10000000', recommendedAmount: '9950000' };
  const opt = options(p); opt.chains = [{ chainId: base, debridgeChainId: 8453 }, { chainId: sol, debridgeChainId: 7565164 }];
  const q = await createDeBridgeAdapter(opt).quote(c); assert.equal(q.minimumOutRaw, '9950000');
  p.estimation.dstChainTokenOut.decimals = 6;
  await assert.rejects(createDeBridgeAdapter(opt).quote(c));
  c.recipient = destination.address; c.request = { ...c.request, recipient: c.recipient };
  await assert.rejects(createDeBridgeAdapter(opt).quote(c), (e: any) => e.code === 'PROVIDER_INVALID_WALLET');
});
test('wrong response URL, non-JSON MIME and oversized declared response fail without retaining artifacts', async () => {
  const responses = [new Response('{}', { headers: { 'content-type': 'text/html' } }),
    new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '131073' } }),
    Object.assign(Response.json(payload()), {})];
  Object.defineProperty(responses[2], 'url', { value: 'https://attacker.invalid/' });
  for (const response of responses) {
    const opt = options(); opt.fetch = async () => response;
    await assert.rejects(createDeBridgeAdapter(opt).quote(context()));
  }
});
