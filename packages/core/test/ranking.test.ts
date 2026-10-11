import assert from 'node:assert/strict';
import test from 'node:test';
import { rankCandidates, deliveredMinimumRaw } from '../dist/ranking.js';
import type { Asset, RouteCandidate, RouterRequest } from '../dist/types.js';
const source: Asset = { chainId: 'solana:mainnet', address: 'SOL', decimals: 9 };
const destination: Asset = { chainId: 'eip155:8453', address: '0x0000000000000000000000000000000000000000', decimals: 18 };
const request = (change: Partial<RouterRequest> = {}): RouterRequest => ({ requestId: 'r', source, destination,
  amountRaw: '1000', sender: 'sender', recipient: '0x1111111111111111111111111111111111111111', slippageBps: 1000, maxFeeBps: 100,
  maxPriceImpactBps: 100, maxCompletionMs: 10000, deadlineMs: 20000,
  optimization: { objective: 'BALANCED', maxOutputShortfallBps: 50 }, ...change });
function candidate(id = 'a', min = '1000', duration = 1000): RouteCandidate {
  return { id, requestId: 'r', source, destination, inputAmountRaw: '1000', expectedOutputRaw: min, minimumOutputRaw: min,
    feeBps: 10, priceImpactBps: 10, completionMs: duration, deadlineMs: 15000, quotedAtMs: 500,
    conditional: false, executionReady: false, validationTier: 'QUOTE_VALIDATED',
    path: { id: 'p', kind: 'DIRECT', source, destination, executionReady: false, quoteBasis: 'FIRM_FIRST_LEG', quoteProbe: false,
      legs: [{ index: 0, capabilityId: 'c', adapterId: 'adapter', kind: 'BRIDGE', source, destination,
        validationTier: 'QUOTE_VALIDATED', executionTier: 'NONE', quoteProbe: false, amountSource: 'REQUEST_AMOUNT', requiresRequoteAfterSettlement: false }] },
    legQuotes: [{ capabilityId: 'c', adapterId: 'adapter', source, destination, amountInRaw: '1000', expectedOutRaw: min,
      minimumOutRaw: min, feeBps: 10, priceImpactBps: 10, estimatedCompletionMs: duration, expiresAtMs: 15000,
      quoteId: id, conditional: false, liquidityConfirmed: true }] };
}
const rank = (cs: RouteCandidate[], req = request(), executable = false) => rankCandidates(req, cs, { nowMs: 1000, requireExecutable: executable });
const why = (c: RouteCandidate, req = request()) => rank([c], req).excluded[0]?.reasons[0];
test('exact bigint output band and FASTEST never silently widen policy', () => {
  const best = candidate('best', '10000000000000000000000', 2000);
  const boundary = candidate('boundary', '9950000000000000000000', 1000);
  const outside = candidate('outside', '9949999999999999999999', 500);
  assert.equal(rank([best, boundary, outside]).winner?.id, 'boundary');
  assert.equal(rank([outside, best], request({ optimization: { objective: 'FASTEST', maxOutputShortfallBps: 50 } })).winner?.id, 'best');
  assert.equal(rank([best, boundary], request({ optimization: { objective: 'BEST_OUTPUT', maxOutputShortfallBps: 0 } })).winner?.id, 'best');
});
test('unvalidated, expired, illiquid or overcost quotes do not raise benchmark', () => {
  for (const mutate of [(c: RouteCandidate) => ({ ...c, validationTier: 'UNVERIFIED' as const }),
    (c: RouteCandidate) => ({ ...c, deadlineMs: 999 }), (c: RouteCandidate) => ({ ...c, feeBps: 101 }),
    (c: RouteCandidate) => ({ ...c, legQuotes: [{ ...c.legQuotes[0]!, liquidityConfirmed: false }] })]) {
    const result = rank([mutate(candidate('bad', '999999')), candidate('good')]);
    assert.equal(result.winner?.id, 'good'); assert.equal(result.bestMinimumOutputRaw, '1000');
  }
});
test('planning can choose conditional previews; action requires validated recipe', () => {
  const c = { ...candidate(), conditional: true, legQuotes: [{ ...candidate().legQuotes[0]!, conditional: true }] };
  assert.equal(rank([c]).winner?.id, 'a'); assert.equal(rank([c], request(), true).winner, null);
  const executable = { ...candidate(), executionReady: true };
  const ready = { ...executable, validationTier: 'EXECUTION_VALIDATED' as const,
    path: { ...executable.path, legs: [{ ...executable.path.legs[0]!, executionTier: 'WALLET_SIGNED' as const, validationTier: 'EXECUTION_VALIDATED' as const }] },
    legQuotes: [{ ...executable.legQuotes[0]!, executableRecipeId: 'recipe' }] };
  assert.equal(rank([ready], request(), true).winner?.id, 'a');
});
test('fees are cost-limit metadata; only additional destination debit reduces floor', () => {
  const c = candidate(); assert.equal(deliveredMinimumRaw(c), 1000n);
  const debited = { ...c, id: 'debit', finalOutputDebitRaw: '6', completionMs: 500 };
  assert.equal(rank([c, debited]).winner?.id, 'a'); assert.equal(deliveredMinimumRaw(debited), 994n);
  assert.throws(() => deliveredMinimumRaw({ ...c, finalOutputDebitRaw: '1000' }));
});
test('binding mutations fail closed including asset decimals and amount provenance', () => {
  for (const c of [{ ...candidate(), destination: { ...destination, decimals: 6 } },
    { ...candidate(), inputAmountRaw: '1001' },
    { ...candidate(), legQuotes: [{ ...candidate().legQuotes[0]!, adapterId: 'other' }] },
    { ...candidate(), legQuotes: [{ ...candidate().legQuotes[0]!, amountInRaw: '999' }] },
    { ...candidate(), minimumOutputRaw: '999' }]) assert.equal(rank([c]).winner, null);
});
test('completion uncertainty, unknown costs and clocks remain honest', () => {
  assert.equal(why({ ...candidate(), completionMs: null }), 'UNKNOWN_COMPLETION_TIME');
  assert.equal(why({ ...candidate(), feeBps: null }), 'UNKNOWN_COSTS');
  assert.equal(why({ ...candidate(), quotedAtMs: 1001 }), 'QUOTE_EXPIRED_OR_INVALID_CLOCK');
  assert.equal(why({ ...candidate(), timing: { protocolMs: 1000, walletMs: null, observationMs: null,
    uncertaintyMs: 1, basis: 'CONFIGURED' } }), 'INVALID_TIMING_BREAKDOWN');
  assert.equal(rank([{ ...candidate(), timing: { protocolMs: 900, walletMs: null, observationMs: null,
    uncertaintyMs: 100, basis: 'CONFIGURED' } }]).winner?.id, 'a');
  for (const value of [0, -1, 0.5, Infinity]) {
    assert.equal(why({ ...candidate(), completionMs: value }), 'UNKNOWN_COMPLETION_TIME');
    assert.equal(why({ ...candidate(), legQuotes: [{ ...candidate().legQuotes[0]!, estimatedCompletionMs: value }] }), 'UNKNOWN_COMPLETION_TIME');
  }
});
test('slippage, impact, leg expiry and native fee budgets are enforced', () => {
  assert.equal(why({ ...candidate(), expectedOutputRaw: '1200' }), 'SLIPPAGE_LIMIT');
  assert.equal(why({ ...candidate(), priceImpactBps: 101 }), 'PRICE_IMPACT_LIMIT');
  assert.equal(why({ ...candidate(), legQuotes: [{ ...candidate().legQuotes[0]!, expiresAtMs: 14999 }] }), 'LEG_EXPIRY_MISMATCH');
  const req = request({ nativeFeeBudgets: [{ chainId: source.chainId, maxAmountRaw: '10' }] });
  assert.equal(why(candidate(), req), 'NATIVE_COST_UNKNOWN');
  const withCost = (amountRaw: string) => ({ ...candidate(), legQuotes: [{ ...candidate().legQuotes[0]!, nativeCosts: [{ chainId: source.chainId, amountRaw }] }] });
  assert.equal(rank([withCost('10')], req).winner?.id, 'a'); assert.equal(why(withCost('11'), req), 'NATIVE_FEE_LIMIT');
});
test('explicit null removes fee and native ceilings without waiving evidence, impact or output floors', () => {
  const req = request({ maxFeeBps: null, nativeFeeBudgets: [{ chainId: source.chainId, maxAmountRaw: null }] });
  const c = { ...candidate(), feeBps: 15000, legQuotes: [{ ...candidate().legQuotes[0]!, feeBps: 15000,
    nativeCosts: [{ chainId: source.chainId, amountRaw: '99999999999999999999' }] }] };
  assert.equal(rank([c], req).winner?.id, 'a');
  assert.equal(why(c, { ...req, maxFeeBps: 10000 }), 'FEE_LIMIT');
  assert.equal(why({ ...c, feeBps: null }, req), 'UNKNOWN_COSTS');
  assert.equal(why({ ...c, legQuotes: [{ ...c.legQuotes[0]!, nativeCosts: undefined }] }, req), 'NATIVE_COST_UNKNOWN');
  assert.equal(why(c, { ...req, nativeFeeBudgets: [{ chainId: destination.chainId, maxAmountRaw: null }] }), 'NATIVE_FEE_LIMIT');
  assert.equal(why({ ...c, priceImpactBps: 101 }, req), 'PRICE_IMPACT_LIMIT');
  assert.equal(why({ ...c, expectedOutputRaw: '1200' }, req), 'SLIPPAGE_LIMIT');
  for (const value of [undefined, 'null', -1, Infinity]) {
    assert.throws(() => rank([c], { ...req, maxFeeBps: value as any }));
    assert.throws(() => rank([c], { ...req, nativeFeeBudgets: [{ chainId: source.chainId, maxAmountRaw: value as any }] }));
  }
});
test('deterministic ties, duplicate identities and immutable inputs', () => {
  const cs = [candidate('z'), candidate('a')], before = JSON.stringify(cs);
  assert.equal(rank(cs).winner?.id, 'a'); assert.equal(JSON.stringify(cs), before);
  assert.equal(rank([candidate(), candidate()]).excluded.length, 2);
  assert.throws(() => rank([], request({ optimization: { objective: 'FASTEST', maxOutputShortfallBps: 10001 } })));
});

test('minimum-output slippage floor permits one raw unit integer rounding', () => {
  const c = candidate('rounding', '9');
  const rounded = { ...c, expectedOutputRaw: '10', legQuotes: [{ ...c.legQuotes[0]!, expectedOutRaw: '10' }] };
  assert.equal(rank([rounded], request({ slippageBps: 1 })).winner?.id, 'rounding');
});
test('composed floors retain conditional provenance and aggregate every cost/time leg', () => {
  const middle: Asset = { chainId: source.chainId, address: 'USDC', decimals: 6 };
  const original = candidate();
  const firstLeg = { ...original.path.legs[0]!, kind: 'SWAP' as const, destination: middle };
  const secondLeg = { ...original.path.legs[0]!, index: 1, capabilityId: 'c2', source: middle,
    amountSource: 'ACTUAL_PREVIOUS_SETTLED_OUTPUT' as const, requiresRequoteAfterSettlement: true };
  const costDenominator = { source: request().source, amountRaw: request().amountRaw };
  const firstQuote = { ...original.legQuotes[0]!, destination: middle, minimumOutRaw: '900', expectedOutRaw: '900', costDenominator };
  const secondQuote = { ...original.legQuotes[0]!, capabilityId: 'c2', source: middle, amountInRaw: '900', conditional: true, costDenominator };
  const c: RouteCandidate = { ...original, conditional: true, feeBps: 20, priceImpactBps: 20, completionMs: 2000,
    path: { ...original.path, kind: 'COMPOSED', quoteBasis: 'CONDITIONAL_FUTURE_LEGS', legs: [firstLeg, secondLeg] },
    legQuotes: [firstQuote, secondQuote] };
  assert.equal(rank([c]).winner?.id, 'a');
  assert.equal(rank([c], request(), true).winner, null);
  for (const change of [{ conditional: false }, { feeBps: 10 }, { completionMs: 1000 },
    { legQuotes: [firstQuote, { ...secondQuote, amountInRaw: '901' }] }]) assert.equal(rank([{ ...c, ...change }]).winner, null);
  const elevated = { ...original, validationTier: 'EXECUTION_VALIDATED' as const };
  assert.equal(why(elevated), 'LEG_BINDING_MISMATCH');
});

test('source quote TTL and original settlement horizon are independent', () => {
  const c = { ...candidate(), deadlineMs: 1100 };
  assert.equal(rank([c]).winner?.id, 'a');
  assert.equal(why({ ...c, deadlineMs: 1000 }), 'QUOTE_EXPIRED_OR_INVALID_CLOCK');
  assert.equal(why(c, request({ deadlineMs: 1500 })), 'COMPLETION_LIMIT');
});

test('short pricing-evidence freshness is independent of still-valid signing expiry', () => {
  const c = candidate();
  const withPricing = (pricingValidUntilMs: number) => ({ ...c, legQuotes: [{ ...c.legQuotes[0]!, pricingValidUntilMs }] });
  assert.equal(rankCandidates(request(), [withPricing(5500)], { nowMs: 5499 }).winner?.id, 'a');
  assert.equal(rankCandidates(request(), [withPricing(5500)], { nowMs: 5500 }).excluded[0]?.reasons[0], 'STALE_PRICING_EVIDENCE');
  for (const expiry of [NaN, Infinity, 15001]) assert.equal(why(withPricing(expiry)), 'STALE_PRICING_EVIDENCE');
  assert.equal(rank([c]).winner?.id, 'a');
});
