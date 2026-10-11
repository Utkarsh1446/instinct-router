/** Network-only estimates. Caller measurements must come from completed, clean observations. */
export type TimingBasis = 'CONFIGURED' | 'OBSERVED_CLEAN_NETWORK';
export interface TimingParts {
  protocolMs: number | null;
  walletMs: number | null;
  observationMs: number | null;
  uncertaintyMs: number;
}
export interface TimingEstimate extends TimingParts {
  basis: TimingBasis;
  completionMs: number | null;
  cleanSamples: number;
  sampleP95Ms: number | null;
  ewmaP95Ms: number | null;
  cold: boolean;
}
export interface NetworkSample {
  measurementId: string;
  routeId: string;
  amountUsdMicros: bigint;
  outcome: 'SUCCESS' | 'REFUND' | 'FAILED' | 'INCOMPLETE';
  complete: boolean;
  measurement: 'MONOTONIC_NETWORK_INTERVAL';
  networkStartMs: number;
  networkEndMs: number;
  humanDelayed: boolean;
  debugDelayed: boolean;
  observationDelayed: boolean;
}
interface History { values: number[]; ids: Set<string>; ewmaP95: number; }
const MAX_MS = 86_400_000;
const MAX_USD_MICROS = 10n ** 30n;
const bounded = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= MAX_MS;
const label = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 512;

/** Dollar buckets use exact micro-USD amounts; no asset-price assumption is made here. */
export function dollarBucket(amountUsdMicros: bigint): string {
  if (typeof amountUsdMicros !== 'bigint' || amountUsdMicros <= 0n || amountUsdMicros > MAX_USD_MICROS) {
    throw new RangeError('A positive bounded micro-USD valuation is required.');
  }
  for (const dollars of [1n, 10n, 100n, 1_000n, 10_000n, 100_000n]) {
    if (amountUsdMicros <= dollars * 1_000_000n) return `USD_LE_${dollars}`;
  }
  return 'USD_GT_100000';
}
function key(routeId: string, amount: bigint): string {
  if (!label(routeId)) throw new RangeError('A bounded route identity is required.');
  return `${routeId.length}:${routeId}:${dollarBucket(amount)}`;
}
function percentile95(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1]!;
}
function partsValid(parts: TimingParts): boolean {
  return parts !== null && typeof parts === 'object' &&
    [parts.protocolMs, parts.walletMs, parts.observationMs].every(n => n === null || bounded(n)) && bounded(parts.uncertaintyMs);
}

export class TimingHistory {
  private readonly histories = new Map<string, History>();
  private readonly windowSize: number;
  private readonly minimumSamples: number;
  private readonly maximumKeys: number;
  constructor(options: { windowSize?: number; minimumSamples?: number; maximumKeys?: number } = {}) {
    this.windowSize = options.windowSize ?? 64;
    this.minimumSamples = options.minimumSamples ?? 8;
    this.maximumKeys = options.maximumKeys ?? 512;
    if (![this.windowSize, this.minimumSamples, this.maximumKeys].every(Number.isSafeInteger) ||
        this.windowSize < 8 || this.windowSize > 256 || this.minimumSamples < 2 || this.minimumSamples > this.windowSize ||
        this.maximumKeys < 1 || this.maximumKeys > 4096) throw new RangeError('Timing history bounds are invalid.');
  }
  record(sample: NetworkSample): { accepted: boolean; reason: string } {
    if (!sample || sample.outcome !== 'SUCCESS' || sample.complete !== true ||
        sample.measurement !== 'MONOTONIC_NETWORK_INTERVAL' || sample.humanDelayed !== false ||
        sample.debugDelayed !== false || sample.observationDelayed !== false) {
      return { accepted: false, reason: 'NOT_A_COMPLETE_CLEAN_NETWORK_SAMPLE' };
    }
    if (!label(sample.measurementId) || typeof sample.networkStartMs !== 'number' ||
        typeof sample.networkEndMs !== 'number' || !Number.isFinite(sample.networkStartMs) ||
        !Number.isFinite(sample.networkEndMs) || sample.networkStartMs < 0 || sample.networkEndMs <= sample.networkStartMs ||
        !bounded(sample.networkEndMs - sample.networkStartMs)) return { accepted: false, reason: 'INVALID_MEASUREMENT' };
    let identity: string;
    try { identity = key(sample.routeId, sample.amountUsdMicros); }
    catch { return { accepted: false, reason: 'INVALID_ROUTE_OR_VALUATION' }; }
    let history = this.histories.get(identity);
    if (history?.ids.has(sample.measurementId)) return { accepted: false, reason: 'DUPLICATE_MEASUREMENT' };
    if (!history) {
      if (this.histories.size >= this.maximumKeys) this.histories.delete(this.histories.keys().next().value!);
      history = { values: [], ids: new Set(), ewmaP95: 0 };
      this.histories.set(identity, history);
    }
    // Keep an exact one-observation-per-measurement bounded window.
    history.values.push(Math.ceil(sample.networkEndMs - sample.networkStartMs));
    history.ids.add(sample.measurementId);
    if (history.values.length > this.windowSize) {
      history.values.shift();
      history.ids.delete(history.ids.values().next().value!);
    }
    const p95 = percentile95(history.values);
    history.ewmaP95 = history.values.length === 1 ? p95 : Math.ceil((history.ewmaP95 * 3 + p95) / 4);
    return { accepted: true, reason: 'RECORDED_CLEAN_NETWORK_INTERVAL' };
  }
  estimate(routeId: string, amountUsdMicros: bigint, configured: TimingParts): TimingEstimate {
    if (!partsValid(configured)) throw new RangeError('Explicit bounded timing components are required.');
    const history = this.histories.get(key(routeId, amountUsdMicros));
    const count = history?.values.length ?? 0;
    const p95 = count ? percentile95(history!.values) : null;
    const cold = count < this.minimumSamples;
    const observed = cold ? null : Math.max(p95!, history!.ewmaP95);
    // Measurements cannot undercut a provider/configuration's conservative estimate.
    const protocolMs = observed === null ? configured.protocolMs : Math.max(configured.protocolMs ?? 0, observed);
    const spread = cold || !history ? 0 : Math.max(0, observed! - Math.min(...history.values));
    const uncertaintyMs = Math.max(configured.uncertaintyMs, spread);
    const complete = protocolMs !== null && configured.walletMs !== null && configured.observationMs !== null;
    const completionMs = complete ? Math.ceil(protocolMs + configured.walletMs! + configured.observationMs! + uncertaintyMs) : null;
    return { protocolMs, walletMs: configured.walletMs, observationMs: configured.observationMs, uncertaintyMs,
      completionMs, basis: cold ? 'CONFIGURED' : 'OBSERVED_CLEAN_NETWORK', cleanSamples: count,
      sampleP95Ms: p95, ewmaP95Ms: history?.ewmaP95 ?? null, cold };
  }
}
