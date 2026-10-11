import { assetKey, chainId, sameAsset, validateRequest, CapabilityRegistry, RouterCoreError } from './capabilities.js';
import { reviewHash } from './execution.js';
import { DynamicRouter } from './router.js';
import type { ProviderAdapter, RouterOptions } from './router.js';
import { QuoteFault, QuoteScheduler } from './scheduler.js';
import type { Asset, ChainId, LegKind, RouteCapability, RouterRequest } from './types.js';

/** These chains accept queries. A successful bound RFQ still has to establish
 * actual liquidity; this configuration grants no wallet or token permission. */
export interface QuoteProviderRegistration {
  readonly adapter: ProviderAdapter;
  readonly queryChains: readonly ChainId[];
  readonly kinds: readonly LegKind[];
  /** A transport such as CCTP must declare exact native USDC assets. */
  readonly exactAssets?: readonly Asset[];
  /** Aggregated end-to-end providers need not become intermediate graph edges. */
  readonly directOnly?: boolean;
}
export interface RuntimeOptions extends RouterOptions {
  readonly intermediates?: readonly Asset[];
  readonly reviewedCapabilities?: readonly RouteCapability[];
}

/** One long-lived instance shares discovery caches, circuit state and transport
 * limits across pairs. Reversing a pair obtains new quotes and new reviews. */
export class RouterRuntime {
  private registrations: readonly QuoteProviderRegistration[];
  private options: RuntimeOptions;
  private scheduler: QuoteScheduler;
  constructor(registrations: readonly QuoteProviderRegistration[], options: RuntimeOptions = {}) {
    if (!registrations.length || registrations.length > 16 || new Set(registrations.map(r => r.adapter.id)).size !== registrations.length)
      throw new RouterCoreError('INVALID_PROVIDER_REGISTRATIONS');
    this.registrations = registrations.map(r => {
      if (!Array.isArray(r.queryChains) || !r.queryChains.length || r.queryChains.length > 256 ||
        !Array.isArray(r.kinds) || !r.kinds.length || r.kinds.some(kind => !['SWAP', 'BRIDGE', 'SWAP_BRIDGE'].includes(kind)))
        throw new RouterCoreError('INVALID_PROVIDER_REGISTRATION');
      if (r.directOnly !== undefined && typeof r.directOnly !== 'boolean')
        throw new RouterCoreError('INVALID_PROVIDER_REGISTRATION');
      if (r.exactAssets && (!Array.isArray(r.exactAssets) || r.exactAssets.length > 64))
        throw new RouterCoreError('INVALID_PROVIDER_ASSETS');
      return { ...r, queryChains: r.queryChains.map(chainId), kinds: [...r.kinds],
        ...(r.exactAssets ? { exactAssets: structuredClone(r.exactAssets) } : {}) };
    });
    this.options = { ...options, intermediates: structuredClone(options.intermediates ?? []),
      reviewedCapabilities: structuredClone(options.reviewedCapabilities ?? []) };
    this.scheduler = options.scheduler ?? new QuoteScheduler();
  }
  async quote(raw: RouterRequest, controls: Parameters<DynamicRouter['quote']>[1] = {}) {
    const request = validateRequest(raw);
    const assets = [...new Map([request.source, request.destination, ...(this.options.intermediates ?? [])]
      .map(a => [assetKey(a), a])).values()];
    if (assets.length > 10) throw new RouterCoreError('TOO_MANY_ROUTE_ASSETS');
    const builds: (() => Promise<RouteCapability>)[] = [];
    const reviewed = this.options.reviewedCapabilities ?? [];
    for (const registration of this.registrations) {
      for (const source of assets) for (const destination of assets) {
        if (sameAsset(source, destination) || !registration.queryChains.includes(source.chainId) ||
          !registration.queryChains.includes(destination.chainId)) continue;
        if (registration.directOnly && (!sameAsset(source, request.source) || !sameAsset(destination, request.destination))) continue;
        if (registration.exactAssets && (!registration.exactAssets.some(a => sameAsset(a, source)) ||
          !registration.exactAssets.some(a => sameAsset(a, destination)))) continue;
        const kind = source.chainId === destination.chainId ? 'SWAP' : registration.kinds.includes('SWAP_BRIDGE') ? 'SWAP_BRIDGE' : 'BRIDGE';
        if (!registration.kinds.includes(kind)) continue;
        const existing = reviewed.find(c => c.adapterId === registration.adapter.id && sameAsset(c.source, source) && sameAsset(c.destination, destination));
        if (existing) { builds.push(async () => existing); continue; }
        builds.push(async () => ({ id: 'probe:' + await reviewHash({ adapterId: registration.adapter.id,
          source: assetKey(source), destination: assetKey(destination) }), adapterId: registration.adapter.id, kind, source, destination,
          validationTier: 'QUOTE_VALIDATED', executionTier: 'NONE', liquidity: 'UNKNOWN', validUntilMs: request.deadlineMs }));
      }
    }
    if (builds.length > 512) throw new RouterCoreError('TOO_MANY_ROUTE_CAPABILITIES');
    const capabilities: RouteCapability[] = [];
    for (let offset = 0; offset < builds.length; offset += 16) {
      if (controls.signal?.aborted) throw new QuoteFault('CANCELLED', false);
      capabilities.push(...await Promise.all(builds.slice(offset, offset + 16).map(build => build())));
    }
    if (controls.signal?.aborted) throw new QuoteFault('CANCELLED', false);
    const router = new DynamicRouter(new CapabilityRegistry(capabilities), this.registrations.map(r => r.adapter), {
      ...this.options, scheduler: this.scheduler,
      planner: { ...this.options.planner, intermediates: this.options.intermediates },
    });
    return router.quote(request, controls);
  }
}
