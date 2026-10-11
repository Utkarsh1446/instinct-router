import { assetKey, rawAmount, sameAsset, validateRequest, validationRank, CapabilityRegistry, RouterCoreError } from './capabilities.js';
import { planRoutes } from './planner.js';
import type { PlannerOptions } from './planner.js';
import { QuoteFault, QuoteScheduler } from './scheduler.js';
import { rankCandidates } from './ranking.js';
import { TimingHistory } from './telemetry.js';
import type { Asset, LegQuote, PlannedLeg, PlannedPath, RouteCandidate, RouterRequest, ValidationTier } from './types.js';

export interface QuoteContext {
  readonly request: RouterRequest;
  readonly leg: PlannedLeg;
  readonly amountRaw: string;
  readonly sender: string;
  readonly recipient: string;
  readonly slippageBps: number;
  readonly deadlineMs: number;
  readonly transportDeadlineMs: number;
  readonly signal: AbortSignal;
}
/** Trusted amount-independent preparation. Evidence stays inside its closure. */
export type PreparationContext = Omit<QuoteContext, 'amountRaw'>;
export interface PreparedQuote { quote(context: QuoteContext): Promise<LegQuote> }
export interface ProviderAdapter {
  readonly id: string;
  quote(context: QuoteContext): Promise<LegQuote>;
  prepare?(context: PreparationContext): Promise<PreparedQuote>;
}
export interface RouterOptions {
  readonly planner?: PlannerOptions;
  readonly quoteBudgetMs?: number;
  readonly providerTimeoutMs?: number;
  readonly scheduler?: QuoteScheduler;
  readonly timingHistory?: TimingHistory;
  /** Trusted host benchmark/control; never accepted from quote request JSON. */
  readonly disablePreparation?: boolean;
  /** Supplied by a trusted host price verifier, never inferred from token symbols. */
  readonly verifiedValuation?: (request: RouterRequest) => { amountUsdMicros: bigint; verifiedAtMs: number } | null;
}
export interface QuoteFailure { readonly pathId: string; readonly code: string }

function owner(request: RouterRequest, asset: Asset): string {
  if (asset.chainId === request.source.chainId) return request.sender;
  if (asset.chainId === request.destination.chainId) return request.recipient;
  const address = request.wallets?.find(wallet => wallet.chainId === asset.chainId)?.address;
  if (!address) throw new RouterCoreError('MISSING_INTERMEDIATE_WALLET');
  return address;
}

function legContext(request: RouterRequest, path: PlannedPath, leg: PlannedLeg, deadlineMs: number): Omit<PreparationContext, 'signal'> {
  const priceChanging = path.legs.filter(item => item.kind !== 'BRIDGE');
  return { request, leg, sender: leg.index === 0 ? request.sender : owner(request, leg.source),
    recipient: leg.index === path.legs.length - 1 ? request.recipient : owner(request, leg.destination),
    slippageBps: leg.kind === 'BRIDGE' ? 0 : Math.floor(request.slippageBps / priceChanging.length) +
      (leg.index === priceChanging.at(-1)?.index ? request.slippageBps % priceChanging.length : 0),
    deadlineMs: request.deadlineMs, transportDeadlineMs: deadlineMs };
}
function preparationKey(context: Omit<PreparationContext, 'signal'>): string {
  return JSON.stringify([context.leg, context.sender, context.recipient, context.slippageBps,
    context.deadlineMs, context.transportDeadlineMs]);
}

function verifyLeg(quote: LegQuote, context: QuoteContext, nowMs: number): LegQuote {
  if (quote.adapterId !== context.leg.adapterId || quote.capabilityId !== context.leg.capabilityId ||
    !sameAsset(quote.source, context.leg.source) || !sameAsset(quote.destination, context.leg.destination) ||
    quote.amountInRaw !== context.amountRaw) throw new RouterCoreError('QUOTE_BINDING_MISMATCH');
  const expected = BigInt(rawAmount(quote.expectedOutRaw, true));
  const minimum = BigInt(rawAmount(quote.minimumOutRaw, true));
  if (minimum > expected || minimum < expected * BigInt(10_000 - context.slippageBps) / 10_000n)
    throw new RouterCoreError('QUOTE_SLIPPAGE');
  if (!Number.isSafeInteger(quote.expiresAtMs) || quote.expiresAtMs <= nowMs ||
    typeof quote.quoteId !== 'string' || !quote.quoteId.length || quote.quoteId.length > 512 ||
    quote.liquidityConfirmed !== true) throw new RouterCoreError('QUOTE_UNAVAILABLE');
  if (quote.pricingValidUntilMs !== undefined && (!Number.isSafeInteger(quote.pricingValidUntilMs) ||
    quote.pricingValidUntilMs <= nowMs || quote.pricingValidUntilMs > quote.expiresAtMs))
    throw new RouterCoreError('QUOTE_PRICING_EXPIRED');
  for (const [metric, maximum] of [[quote.feeBps, Number.MAX_SAFE_INTEGER], [quote.priceImpactBps, 10_000]] as const)
    if (metric !== null && (!Number.isSafeInteger(metric) || metric < 0 || metric > maximum))
      throw new RouterCoreError('INVALID_QUOTE_ECONOMICS');
  if (quote.estimatedCompletionMs !== null && (!Number.isSafeInteger(quote.estimatedCompletionMs) || quote.estimatedCompletionMs <= 0))
    throw new RouterCoreError('INVALID_QUOTE_TIMING');
  return Object.freeze({ ...structuredClone(quote), conditional: quote.conditional || context.leg.requiresRequoteAfterSettlement });
}

function sumKnown(values: readonly (number | null)[]): number | null {
  if (values.some(value => value === null)) return null;
  const sum = values.reduce<number>((sum, value) => sum + value!, 0);
  if (!Number.isSafeInteger(sum)) throw new RouterCoreError('INVALID_QUOTE_TOTAL');
  return sum;
}

/** Portable RFQ engine. It never accesses a wallet, journal or private key. */
export class DynamicRouter {
  private registry: CapabilityRegistry;
  private adapters = new Map<string, ProviderAdapter>();
  private options: RouterOptions;
  private scheduler: QuoteScheduler;

  constructor(registry: CapabilityRegistry, adapters: readonly ProviderAdapter[], options: RouterOptions = {}) {
    this.registry = registry;
    this.options = options;
    this.scheduler = options.scheduler ?? new QuoteScheduler();
    if (options.disablePreparation !== undefined && typeof options.disablePreparation !== 'boolean')
      throw new RouterCoreError('INVALID_PREPARATION_OPTION');
    for (const adapter of adapters) {
      if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(adapter.id) || this.adapters.has(adapter.id))
        throw new RouterCoreError('INVALID_ADAPTER');
      this.adapters.set(adapter.id, adapter);
    }
    for (const value of [options.quoteBudgetMs ?? 2500, options.providerTimeoutMs ?? 2000])
      if (!Number.isSafeInteger(value) || value <= 0 || value > 10_000) throw new RouterCoreError('INVALID_QUOTE_BUDGET');
  }

  async quote(rawRequest: RouterRequest, options: {
    signal?: AbortSignal; onCandidate?: (candidate: RouteCandidate) => void;
  } = {}) {
    const startedAt = Date.now();
    const request = validateRequest(rawRequest, startedAt);
    const planning = planRoutes(request, this.registry, { ...this.options.planner, nowMs: startedAt });
    const deadlineMs = Math.min(request.deadlineMs, startedAt + (this.options.quoteBudgetMs ?? 2500));
    // This map exists only during one comparison. Shared source legs coalesce;
    // completed quotes are never carried into another request or wallet review.
    const inFlight = new Map<string, Promise<LegQuote>>();
    const preparations = new Map<string, Promise<PreparedQuote>>();
    const controller = new AbortController();
    const cancel = () => controller.abort();
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) controller.abort();
    const failures: QuoteFailure[] = [];
    const candidates: RouteCandidate[] = [];
    const quoteLeg = async (context: Omit<QuoteContext, 'signal'>) => {
      const adapter = this.adapters.get(context.leg.adapterId);
      if (!adapter) throw new RouterCoreError('ADAPTER_UNAVAILABLE');
      const key = JSON.stringify([adapter.id, context.leg.capabilityId, assetKey(context.leg.source),
        assetKey(context.leg.destination), context.amountRaw, context.sender, context.recipient,
        context.slippageBps, context.leg.requiresRequoteAfterSettlement]);
      let work = inFlight.get(key);
      if (!work) {
        work = (async () => {
          // Never occupy a scheduler slot while waiting for another queued job.
          const preparation = preparations.get(preparationKey(context));
          const prepared = preparation ? await preparation : undefined;
          return this.scheduler.schedule(adapter.id, async signal => {
            const bound = Object.freeze({ ...context, signal });
            return verifyLeg(await (prepared ? prepared.quote(bound) : adapter.quote(bound)), bound, Date.now());
          }, { deadlineMs, timeoutMs: this.options.providerTimeoutMs ?? 2000, signal: controller.signal });
        })();
        inFlight.set(key, work);
      }
      return structuredClone(await work);
    };
    const pathWork = planning.paths.map(async path => {
      try {
        let candidate = await this.quotePath(request, path, deadlineMs, quoteLeg);
        const valuation = this.options.verifiedValuation?.(request);
        if (this.options.timingHistory && valuation) {
          if (!Number.isSafeInteger(valuation.verifiedAtMs) || valuation.verifiedAtMs > Date.now() ||
            Date.now() - valuation.verifiedAtMs > 5000) throw new RouterCoreError('VALUATION_EXPIRED');
          const timing = this.options.timingHistory.estimate(candidate.id, valuation.amountUsdMicros,
            { protocolMs: candidate.completionMs, walletMs: null, observationMs: null, uncertaintyMs: 0 });
          candidate = Object.freeze({ ...candidate, timing,
            completionMs: timing.protocolMs === null ? null : timing.protocolMs + timing.uncertaintyMs });
        }
        candidates.push(candidate);
        try { options.onCandidate?.(structuredClone(candidate)); } catch { /* View listeners do not change RFQ results. */ }
      } catch (error) {
        failures.push({ pathId: path.id, code: error instanceof QuoteFault || error instanceof RouterCoreError
          ? error.code : 'PROVIDER_UNAVAILABLE' });
      }
    });
    // All required first-leg jobs are enqueued before optional work. Limit the
    // extra workload and coalesce exact future contexts across route branches.
    if (!this.options.disablePreparation) for (const path of planning.paths) for (const leg of path.legs) {
      const adapter = this.adapters.get(leg.adapterId);
      if (leg.index === 0 || !adapter?.prepare || preparations.size >= 4) continue;
      try {
        const context = legContext(request, path, leg, deadlineMs), key = preparationKey(context);
        if (preparations.has(key)) continue;
        const prepare = adapter.prepare.bind(adapter);
        const work = this.scheduler.schedule(adapter.id, signal => prepare(Object.freeze({ ...context, signal })),
          { deadlineMs, timeoutMs: this.options.providerTimeoutMs ?? 2000, signal: controller.signal });
        work.catch(() => {}); // Its dependent path consumes the rejection.
        preparations.set(key, work);
      } catch { /* Ordinary quote retains the original context validation. */ }
    }
    try { await Promise.all(pathWork); }
    finally { options.signal?.removeEventListener('abort', cancel); controller.abort(); }
    candidates.sort((a, b) => a.id.localeCompare(b.id));
    failures.sort((a, b) => a.pathId.localeCompare(b.pathId));
    return Object.freeze({ request, ...rankCandidates(request, candidates, { nowMs: Date.now() }),
      candidates: Object.freeze(candidates), failures: Object.freeze(failures), planning,
      quoteRttMs: Date.now() - startedAt,
      comparisonComplete: failures.length === 0 && !planning.truncated,
      executionAuthorized: false as const });
  }

  private async quotePath(request: RouterRequest, path: PlannedPath, deadlineMs: number,
    quoteLeg: (context: Omit<QuoteContext, 'signal'>) => Promise<LegQuote>): Promise<RouteCandidate> {
    const quotes: LegQuote[] = [];
    let amount = request.amountRaw;
    let tier: ValidationTier = 'EXECUTION_VALIDATED';
    for (const leg of path.legs) {
      const quote = await quoteLeg({ ...legContext(request, path, leg, deadlineMs), amountRaw: amount });
      quotes.push(quote);
      amount = quote.minimumOutRaw;
      if (validationRank(leg.validationTier) < validationRank(tier)) tier = leg.validationTier;
    }
    const last = quotes.at(-1)!;
    const conditional = quotes.some(quote => quote.conditional);
    const commonCostBasis = quotes.length === 1 || quotes.every(quote => quote.costDenominator &&
      sameAsset(quote.costDenominator.source, request.source) && quote.costDenominator.amountRaw === request.amountRaw);
    return Object.freeze({ id: path.id, requestId: request.requestId, path, legQuotes: Object.freeze(quotes),
      source: request.source, destination: request.destination, inputAmountRaw: request.amountRaw,
      expectedOutputRaw: last.expectedOutRaw, minimumOutputRaw: last.minimumOutRaw,
      feeBps: commonCostBasis ? sumKnown(quotes.map(quote => quote.feeBps)) : null,
      priceImpactBps: commonCostBasis ? sumKnown(quotes.map(quote => quote.priceImpactBps)) : null,
      completionMs: sumKnown(quotes.map(quote => quote.estimatedCompletionMs)),
      deadlineMs: Math.min(request.deadlineMs, ...quotes.map(quote => quote.expiresAtMs)), quotedAtMs: Date.now(),
      conditional, validationTier: tier,
      executionReady: !conditional && tier === 'EXECUTION_VALIDATED' &&
        path.legs.every(leg => leg.executionTier === 'WALLET_SIGNED') && quotes.every(quote => Boolean(quote.executableRecipeId)) });
  }
}
