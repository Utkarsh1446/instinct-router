import { sameAsset, validateRequest as canonicalRequest, validationRank } from './capabilities.js';
import type { Asset, RouteCandidate, RouterRequest } from './types.js';

export interface RankingOptions { nowMs: number; requireExecutable?: boolean }
export interface RankingResult {
  winner: RouteCandidate | null;
  eligible: readonly RouteCandidate[];
  excluded: readonly { id: string; reasons: readonly string[] }[];
  bestMinimumOutputRaw: string | null;
  selectionReason: string;
}
const MAX = (1n << 256n) - 1n;
const raw = (s: unknown): bigint => {
  if (typeof s !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(s)) throw new Error('INVALID_AMOUNT');
  const n = BigInt(s); if (n > MAX) throw new Error('INVALID_AMOUNT'); return n;
};
const text = (s: unknown): boolean => typeof s === 'string' && s.length > 0 && s.length <= 512;
const bps = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= 10000;
// Source gas can cost more than a small trade's input value.
const feeBps = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const ms = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER;
const duration = (n: unknown): n is number => ms(n) && Number.isSafeInteger(n) && n > 0;
const same = (a: Asset, b: Asset): boolean => sameAsset(a, b);
const compareId = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

/** Provider floors already include quoted fees/impact. Only an explicit additional debit is subtracted. */
export function deliveredMinimumRaw(candidate: RouteCandidate): bigint {
  const minimum = raw(candidate.minimumOutputRaw), debit = raw(candidate.finalOutputDebitRaw ?? '0');
  if (minimum <= debit) throw new Error('NONPOSITIVE_OUTPUT');
  return minimum - debit;
}
function validateRequest(request: RouterRequest, options: RankingOptions): void {
  canonicalRequest(request, options.nowMs);
  if (options.requireExecutable !== undefined && typeof options.requireExecutable !== 'boolean') throw new Error('INVALID_REQUEST');
}
function reasons(request: RouterRequest, c: RouteCandidate, options: RankingOptions): string[] {
  try {
    if (!c || !text(c.id) || c.requestId !== request.requestId || !same(c.source, request.source) ||
        !same(c.destination, request.destination) || c.inputAmountRaw !== request.amountRaw) return ['REQUEST_BINDING_MISMATCH'];
    if (!['QUOTE_VALIDATED', 'EXECUTION_VALIDATED'].includes(c.validationTier)) return ['UNVALIDATED_QUOTE'];
    if (typeof c.conditional !== 'boolean' || typeof c.executionReady !== 'boolean') return ['INVALID_EXECUTION_FLAGS'];
    if (options.requireExecutable && (c.validationTier !== 'EXECUTION_VALIDATED' || !c.executionReady || c.conditional)) return ['NOT_EXECUTABLE'];
    if (!feeBps(c.feeBps) || !bps(c.priceImpactBps)) return ['UNKNOWN_COSTS'];
    const expected = raw(c.expectedOutputRaw), minimum = raw(c.minimumOutputRaw), delivered = deliveredMinimumRaw(c);
    if (minimum > expected || expected === 0n) return ['INVALID_OUTPUT'];
    if (minimum < expected * BigInt(10000 - request.slippageBps) / 10000n) return ['SLIPPAGE_LIMIT'];
    if (request.maxFeeBps !== null && c.feeBps > request.maxFeeBps) return ['FEE_LIMIT'];
    if (c.priceImpactBps > request.maxPriceImpactBps) return ['PRICE_IMPACT_LIMIT'];
    if (!ms(c.quotedAtMs) || c.quotedAtMs > options.nowMs || !ms(c.deadlineMs) ||
        c.deadlineMs <= options.nowMs || c.deadlineMs > request.deadlineMs) return ['QUOTE_EXPIRED_OR_INVALID_CLOCK'];
    // Timing-only previews must still pass every economic and binding check.
    let knownCompletion = duration(c.completionMs);
    if (knownCompletion && (c.completionMs! > request.maxCompletionMs || options.nowMs + c.completionMs! > request.deadlineMs)) return ['COMPLETION_LIMIT'];
    const path = c.path;
    if (!path || !text(path.id) || !same(path.source, c.source) || !same(path.destination, c.destination) ||
        path.executionReady !== false || !Array.isArray(path.legs) || path.legs.length < 1 || path.legs.length > 8 ||
        !Array.isArray(c.legQuotes) || c.legQuotes.length !== path.legs.length ||
        path.kind !== (path.legs.length === 1 ? 'DIRECT' : 'COMPOSED') ||
        path.quoteBasis !== (path.legs.length === 1 ? 'FIRM_FIRST_LEG' : 'CONDITIONAL_FUTURE_LEGS')) return ['PATH_BINDING_MISMATCH'];
    let input = raw(request.amountRaw), previous = request.source, fees = 0, impact = 0, totalDuration = 0;
    const native = new Map<string, bigint>();
    for (let i = 0; i < path.legs.length; i++) {
      const leg = path.legs[i]!, quote = c.legQuotes[i]!;
      if (path.legs.length > 1 && (!quote.costDenominator ||
        !same(quote.costDenominator.source, request.source) || quote.costDenominator.amountRaw !== request.amountRaw))
        return ['UNKNOWN_COST_DENOMINATOR'];
      if (leg.index !== i || !text(leg.capabilityId) || !text(leg.adapterId) ||
          validationRank(leg.validationTier) < validationRank(c.validationTier) ||
          quote.capabilityId !== leg.capabilityId || quote.adapterId !== leg.adapterId || !text(quote.quoteId) ||
          !same(leg.source, previous) || !same(quote.source, leg.source) || !same(quote.destination, leg.destination) ||
          raw(quote.amountInRaw) !== input || leg.amountSource !== (i ? 'ACTUAL_PREVIOUS_SETTLED_OUTPUT' : 'REQUEST_AMOUNT') ||
          leg.requiresRequoteAfterSettlement !== (i > 0) || typeof quote.conditional !== 'boolean' ||
          (i > 0 && (!quote.conditional || !c.conditional)) ||
          (quote.conditional && !c.conditional)) return ['LEG_BINDING_MISMATCH'];
      if (quote.liquidityConfirmed !== true) return ['LIQUIDITY_NOT_CONFIRMED'];
      if (!feeBps(quote.feeBps) || !bps(quote.priceImpactBps)) return ['UNKNOWN_COSTS'];
      if (!duration(quote.estimatedCompletionMs)) knownCompletion = false;
      if (!ms(quote.expiresAtMs) || quote.expiresAtMs < c.deadlineMs) return ['LEG_EXPIRY_MISMATCH'];
      if (quote.pricingValidUntilMs !== undefined && (!ms(quote.pricingValidUntilMs) ||
          quote.pricingValidUntilMs <= options.nowMs || quote.pricingValidUntilMs > quote.expiresAtMs)) return ['STALE_PRICING_EVIDENCE'];
      const out = raw(quote.minimumOutRaw), estimated = raw(quote.expectedOutRaw);
      if (out <= 0n || out > estimated) return ['INVALID_OUTPUT'];
      if (out < estimated * BigInt(10000 - request.slippageBps) / 10000n) return ['SLIPPAGE_LIMIT'];
      if (options.requireExecutable && (!text(quote.executableRecipeId) || quote.conditional || leg.executionTier !== 'WALLET_SIGNED')) return ['NOT_EXECUTABLE'];
      fees += quote.feeBps; impact += quote.priceImpactBps; totalDuration += duration(quote.estimatedCompletionMs) ? quote.estimatedCompletionMs : 0;
      input = out; previous = leg.destination;
      if (request.nativeFeeBudgets !== undefined && !Array.isArray(quote.nativeCosts)) return ['NATIVE_COST_UNKNOWN'];
      if (quote.nativeCosts !== undefined) {
        if (!Array.isArray(quote.nativeCosts) || quote.nativeCosts.length > 32) return ['INVALID_NATIVE_COST'];
        for (const cost of quote.nativeCosts) {
          if (!text(cost.chainId)) return ['INVALID_NATIVE_COST'];
          native.set(cost.chainId, (native.get(cost.chainId) ?? 0n) + raw(cost.amountRaw));
        }
      }
    }
    const last = c.legQuotes[c.legQuotes.length - 1]!;
    if (!same(previous, c.destination) || last.minimumOutRaw !== c.minimumOutputRaw || last.expectedOutRaw !== c.expectedOutputRaw ||
        c.feeBps < fees || c.priceImpactBps < impact || duration(c.completionMs) && c.completionMs < totalDuration) return ['AGGREGATE_UNDERSTATEMENT'];
    if (c.timing) {
      const t = c.timing;
      if (!['CONFIGURED', 'OBSERVED_CLEAN_NETWORK'].includes(t.basis) || !ms(t.uncertaintyMs) ||
          [t.protocolMs, t.walletMs, t.observationMs].some(n => n !== null && !ms(n)) ||
          (t.protocolMs !== null && duration(c.completionMs) && c.completionMs < t.protocolMs + t.uncertaintyMs)) return ['INVALID_TIMING_BREAKDOWN'];
    }
    if (request.nativeFeeBudgets !== undefined) {
      const budgets = new Map(request.nativeFeeBudgets.map(b => [b.chainId as string, b.maxAmountRaw === null ? null : raw(b.maxAmountRaw)]));
      for (const [chain, cost] of native) {
        const cap = budgets.get(chain);
        if (cap === undefined || cap !== null && cost > cap) return ['NATIVE_FEE_LIMIT'];
      }
    }
    if (delivered <= 0n) return ['NONPOSITIVE_OUTPUT'];
    if (!knownCompletion) return ['UNKNOWN_COMPLETION_TIME'];
    return [];
  } catch { return ['INVALID_CANDIDATE']; }
}

/** Planning selection is not wallet authorization. Action callers must explicitly requireExecutable. */
export function rankCandidates(request: RouterRequest, candidates: readonly RouteCandidate[], options: RankingOptions): RankingResult {
  validateRequest(request, options);
  if (!Array.isArray(candidates) || candidates.length > 256) throw new Error('INVALID_CANDIDATE_SET');
  const counts = new Map<string, number>();
  for (const candidate of candidates) if (candidate && typeof candidate.id === 'string') counts.set(candidate.id, (counts.get(candidate.id) ?? 0) + 1);
  const eligible: RouteCandidate[] = [], excluded: { id: string; reasons: string[] }[] = [];
  for (const c of candidates) {
    const why = (counts.get(c?.id) ?? 0) > 1 ? ['DUPLICATE_CANDIDATE_ID'] : reasons(request, c, options);
    if (why.length) excluded.push({ id: typeof c?.id === 'string' ? c.id : 'INVALID', reasons: why }); else eligible.push(c);
  }
  const best = eligible.reduce((out, c) => { const value = deliveredMinimumRaw(c); return value > out ? value : out; }, 0n);
  const band = BigInt(10000 - request.optimization.maxOutputShortfallBps);
  const inBand = eligible.filter(c => deliveredMinimumRaw(c) * 10000n >= best * band);
  const compare = (a: RouteCandidate, b: RouteCandidate): number => {
    const av = deliveredMinimumRaw(a), bv = deliveredMinimumRaw(b);
    const value = av > bv ? -1 : av < bv ? 1 : 0;
    const speed = a.completionMs! - b.completionMs!;
    return (request.optimization.objective === 'BEST_OUTPUT' ? value || speed : speed || value) ||
      a.feeBps! - b.feeBps! || a.priceImpactBps! - b.priceImpactBps! || compareId(a.id, b.id);
  };
  inBand.sort(compare);
  return { winner: inBand[0] ?? null, eligible: [...eligible].sort(compare), excluded,
    bestMinimumOutputRaw: best ? best.toString() : null,
    selectionReason: inBand.length ? `${request.optimization.objective}_WITHIN_OUTPUT_BAND` : 'NO_ELIGIBLE_ROUTE' };
}
