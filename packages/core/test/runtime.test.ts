import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RouterRuntime } from '../dist/runtime.js';
import type { QuoteProviderRegistration } from '../dist/runtime.js';
import type { QuoteContext } from '../dist/router.js';
import type { Asset, RouterRequest } from '../dist/types.js';
const base: Asset = { chainId: 'eip155:8453', address: '0x0000000000000000000000000000000000000000', decimals: 18 };
const arb: Asset = { ...base, chainId: 'eip155:42161' };
const sourceWallet = '0x1111111111111111111111111111111111111111';
const destinationWallet = '0x2222222222222222222222222222222222222222';
const request = (source = base, destination = arb): RouterRequest => ({ requestId: 'runtime', source, destination, amountRaw: '1000',
  sender: sourceWallet, recipient: destinationWallet, slippageBps: 100, maxFeeBps: 100, maxPriceImpactBps: 100, maxCompletionMs: 10000,
  deadlineMs: Date.now() + 60000, optimization: { objective: 'BALANCED', maxOutputShortfallBps: 50 } });
function quote(ctx: QuoteContext) { return Promise.resolve({ capabilityId: ctx.leg.capabilityId, adapterId: ctx.leg.adapterId,
  source: ctx.leg.source, destination: ctx.leg.destination, amountInRaw: ctx.amountRaw, expectedOutRaw: '1000', minimumOutRaw: '999',
  feeBps: 5, priceImpactBps: 0, estimatedCompletionMs: 1000, expiresAtMs: ctx.deadlineMs, quoteId: 'quote', conditional: false, liquidityConfirmed: true }); }
test('runtime creates exact directed probes automatically and never grants execution permission', async () => {
  const runtime = new RouterRuntime([{ adapter: { id: 'provider', quote }, queryChains: [base.chainId, arb.chainId], kinds: ['SWAP_BRIDGE'] }]);
  const forward = await runtime.quote(request()), reverse = await runtime.quote(request(arb, base));
  assert.equal(forward.winner?.executionReady, false); assert.equal(reverse.winner?.executionReady, false);
  assert.notEqual(forward.winner?.id, reverse.winner?.id);
  assert.equal((await runtime.quote(request())).winner?.id, forward.winner?.id);
});
test('new token on a configured chain is independently quoted without requiring a global bridge token list', async () => {
  const runtime = new RouterRuntime([{ adapter: { id: 'provider', quote }, queryChains: [base.chainId, arb.chainId], kinds: ['SWAP_BRIDGE'] }]);
  const token: Asset = { ...arb, address: '0x3333333333333333333333333333333333333333', decimals: 6 };
  const result = await runtime.quote(request(base, token));
  assert.equal(result.winner?.destination.address, token.address); assert.equal(result.winner?.executionReady, false);
});
test('unsupported chains and exact-asset transport restrictions do not invent routes', async () => {
  const runtime = new RouterRuntime([{ adapter: { id: 'bridge', quote }, queryChains: [base.chainId, arb.chainId], kinds: ['BRIDGE'], exactAssets: [base, arb] }]);
  const token = { ...arb, address: '0x3333333333333333333333333333333333333333' };
  assert.equal((await runtime.quote(request(base, token))).candidates.length, 0);
  assert.equal((await runtime.quote(request(base, { ...arb, chainId: 'eip155:10' }))).candidates.length, 0);
});
test('adding irrelevant intermediate assets never changes a direct route identity', async () => {
  const registrations = [{ adapter: { id: 'provider', quote }, queryChains: [base.chainId, arb.chainId], kinds: ['SWAP_BRIDGE' as const] }];
  const a = await new RouterRuntime(registrations).quote(request());
  const b = await new RouterRuntime(registrations, { intermediates: [{ ...arb, address: '0x3333333333333333333333333333333333333333' }] }).quote(request());
  assert.equal(a.winner?.id, b.winner?.id);
});

test('independent DEX-CCTP-DEX comparisons bind both owned wallets and quote each shared source once in either direction', async () => {
  const sol: Asset = { chainId: 'solana:mainnet', address: '11111111111111111111111111111111', decimals: 9 };
  const solUsdc: Asset = { ...sol, address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 };
  const baseUsdc: Asset = { ...base, address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 };
  const solWallet = '11111111111111111111111111111112';
  for (const reverse of [false, true]) {
    const source = reverse ? base : sol, destination = reverse ? sol : base;
    const sender = reverse ? sourceWallet : solWallet, recipient = reverse ? solWallet : destinationWallet;
    const req = { ...request(source, destination), sender, recipient,
      wallets: [{ chainId: source.chainId, address: sender }, { chainId: destination.chainId, address: recipient }] };
    const calls: QuoteContext[] = [];
    const rfq = async (ctx: QuoteContext) => {
      calls.push(ctx);
      const amount = ctx.leg.adapterId === 'aggregate' ? '1699' : ctx.leg.kind === 'BRIDGE'
        ? ctx.leg.adapterId === 'cctp-fast' ? '800' : '850'
        : ctx.leg.source.address === source.address ? '900' : String(BigInt(ctx.amountRaw) * 2n);
      return { ...await quote(ctx), expectedOutRaw: amount, minimumOutRaw: amount,
        quoteId: ctx.leg.adapterId + ':' + ctx.amountRaw,
        costDenominator: { source: ctx.request.source, amountRaw: ctx.request.amountRaw } };
    };
    const registrations: QuoteProviderRegistration[] = [
      { adapter: { id: 'sol-dex', quote: rfq }, queryChains: [sol.chainId], kinds: ['SWAP'], exactAssets: [sol, solUsdc] },
      { adapter: { id: 'base-dex', quote: rfq }, queryChains: [base.chainId], kinds: ['SWAP'], exactAssets: [base, baseUsdc] },
      ...['cctp-fast', 'cctp-standard'].map(id => ({ adapter: { id, quote: rfq },
        queryChains: [sol.chainId, base.chainId], kinds: ['BRIDGE' as const], exactAssets: [solUsdc, baseUsdc] })),
      { adapter: { id: 'aggregate', quote: rfq }, queryChains: [sol.chainId, base.chainId],
        kinds: ['SWAP', 'SWAP_BRIDGE'], directOnly: true },
    ];
    const result = await new RouterRuntime(registrations, { intermediates: [solUsdc, baseUsdc] }).quote(req);
    assert.equal(result.candidates.length, 3);
    assert.equal(calls.filter(call => call.leg.adapterId === 'aggregate').length, 1);
    const sourceCalls = calls.filter(call => call.leg.kind === 'SWAP' && call.leg.source.address === source.address);
    assert.equal(sourceCalls.length, 1);
    assert.equal(sourceCalls[0]!.sender, sender); assert.equal(sourceCalls[0]!.recipient, sender);
    for (const candidate of result.candidates.filter(candidate => candidate.path.kind === 'COMPOSED')) {
      assert.deepEqual(candidate.path.legs.map(leg => leg.kind), ['SWAP', 'BRIDGE', 'SWAP']);
      assert.equal(candidate.conditional, true); assert.equal(candidate.executionReady, false);
      assert.equal(candidate.legQuotes[1]!.amountInRaw, candidate.legQuotes[0]!.minimumOutRaw);
      assert.equal(candidate.legQuotes[2]!.amountInRaw, candidate.legQuotes[1]!.minimumOutRaw);
    }
    const bridges = calls.filter(call => call.leg.kind === 'BRIDGE');
    assert.equal(bridges.length, 2);
    assert.ok(bridges.every(call => call.sender === sender && call.recipient === recipient && call.slippageBps === 0));
    assert.ok(calls.filter(call => call.leg.kind === 'SWAP' && call.leg.source.chainId === destination.chainId)
      .every(call => call.sender === recipient && call.recipient === recipient));
  }
});

test('direct-only is explicit trusted configuration and cannot override missing intermediate ownership', async () => {
  const registration = { adapter: { id: 'provider', quote }, queryChains: [base.chainId, arb.chainId], kinds: ['SWAP_BRIDGE' as const] };
  for (const value of ['true', 1, null])
    assert.throws(() => new RouterRuntime([{ ...registration, directOnly: value as unknown as boolean }]), /INVALID_PROVIDER_REGISTRATION/);
  const direct = await new RouterRuntime([{ ...registration, directOnly: true }]).quote(request());
  assert.equal(direct.candidates.length, 1);
  const third = { ...arb, chainId: 'eip155:10' as const };
  const calls: QuoteContext[] = [];
  const runtime = new RouterRuntime([{ adapter: { id: 'bridge', quote: async ctx => {
    calls.push(ctx); return { ...await quote(ctx), minimumOutRaw: '1000',
      costDenominator: { source: ctx.request.source, amountRaw: ctx.request.amountRaw } };
  } }, queryChains: [base.chainId, third.chainId, arb.chainId], kinds: ['BRIDGE'] }], { intermediates: [third] });
  const result = await runtime.quote(request());
  assert.ok(result.failures.some(failure => failure.code === 'MISSING_INTERMEDIATE_WALLET'));
  const intermediateWallet = '0x3333333333333333333333333333333333333333';
  const owned = await runtime.quote({ ...request(), wallets: [{ chainId: third.chainId, address: intermediateWallet }] });
  assert.ok(owned.candidates.some(candidate => candidate.path.kind === 'COMPOSED'));
  assert.equal(calls.find(call => call.leg.destination.chainId === third.chainId)!.recipient, intermediateWallet);
  assert.equal(calls.find(call => call.leg.source.chainId === third.chainId)!.sender, intermediateWallet);
});

test('capability digests run in bounded parallel batches without changing direct identities', async () => {
  const digest = crypto.subtle.digest; let active = 0, peak = 0;
  crypto.subtle.digest = async (algorithm, data) => {
    active++; peak = Math.max(peak, active);
    try { await new Promise<void>(resolve => { setImmediate(resolve); }); return await digest.call(crypto.subtle, algorithm, data); }
    finally { active--; }
  };
  try {
    const intermediates = Array.from({ length: 4 }, (_, i) => ({ ...base, address: '0x' + String(i + 3).padStart(40, '0') }));
    const result = await new RouterRuntime([{ adapter: { id: 'provider', quote },
      queryChains: [base.chainId, arb.chainId], kinds: ['SWAP', 'SWAP_BRIDGE'] }], { intermediates }).quote(request());
    assert.ok(result.candidates.some(candidate => candidate.path.kind === 'DIRECT'));
    assert.ok(peak > 1 && peak <= 16);
  } finally { crypto.subtle.digest = digest; }
});
