import type { Asset, ChainId, LegQuote } from './types.js';
import type { ProviderAdapter, QuoteContext } from './router.js';
import { assetKey, boundedInteger, chainId, normalizeAsset, rawAmount, sameAsset } from './capabilities.js';
import { MetadataCache, QuoteFault } from './scheduler.js';

/** Provider identifiers are explicit trusted configuration, never inferred from symbols. */
export interface ChainMapping {
  chainId: ChainId;
  relayChainId?: number;
  relayProtocolChainId?: string;
  auroraBlockchain?: string;
  cctpDomain?: number;
  sourceConfirmationMs?: number;
  destinationVerificationMs?: number;
}
export interface AuroraAssetMapping { asset: Asset; assetId: string; native: boolean }
export type ProviderFetch = (url: string, init: RequestInit) => Promise<Response>;
export interface ProviderOptions {
  chains: readonly ChainMapping[];
  fetch: ProviderFetch;
  apiKey?: string;
  relayApiKey?: string;
  auroraApiKey?: string;
  relayMaxOrderLifetimeMs?: number;
  /** Explicit read-only self-executed same-chain previews; disabled by default. */
  relaySameChainPreviewTtlMs?: number;
  clock?: () => number;
  metadataTtlMs?: number;
}
export interface RelayChain {
  id: number; name: string; vmType: string; disabled: boolean; depositEnabled: boolean;
  protocolChainId?: string;
  currency?: { address: string; decimals: number; symbol: string };
}
export interface DiscoveredAsset { asset: Asset; providerAssetId: string; symbol: string; native: boolean | null }
export interface AuroraToken { assetId: string; blockchain: string; decimals: number; symbol: string; contractAddress?: string }
export interface QuoteEconomics { feeBps: number | null; priceImpactBps: number | null; nativeCosts?: LegQuote['nativeCosts'] }
export interface AuroraOptions extends ProviderOptions {
  assets?: readonly AuroraAssetMapping[];
  dryRun?: boolean;
  previewTtlMs?: number;
  appFees?: readonly { recipient: string; fee: number }[];
  referral?: string;
  economicsVerifier?: (raw: Readonly<Record<string, unknown>>, context: QuoteContext) => QuoteEconomics;
  /** Trusted, validated discovery source, shareable across fee-policy variants. */
  tokenCatalog?: (signal: AbortSignal) => Promise<readonly AuroraToken[]>;
}
export const PROVIDER_DOCS = Object.freeze({
  relayChains: 'https://docs.relay.link/references/api/get-chains',
  relayCurrencies: 'https://docs.relay.link/references/api/get-currencies-v2',
  relayQuote: 'https://docs.relay.link/references/api/get-quote-v2',
  relayVerification: 'https://docs.relay.link/references/api/api_core_concepts/input-validation',
  auroraTokens: 'https://docs.intents.aurora.dev/api-reference/swap-api-reference/get-supported-tokens',
  auroraQuote: 'https://docs.intents.aurora.dev/api-reference/swap-api-reference/request-a-quote',
  cctpDomains: 'https://developers.circle.com/cctp/concepts/supported-chains-and-domains',
});
const MAX_RESPONSE = 2 * 1024 * 1024;
function fail(code: string): never { throw new QuoteFault(code, false); }
function obj(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('PROVIDER_INVALID_RESPONSE');
  return value as Record<string, unknown>;
}
function str(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value.length || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail('PROVIDER_INVALID_STRING');
  return value;
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail('PROVIDER_INVALID_CATALOG');
  return value;
}
function equal(value: unknown, expected: string, chain: ChainId): boolean {
  return typeof value === 'string' && (chain.startsWith('eip155:') ? value.toLowerCase() === expected.toLowerCase() : value === expected);
}
function validateOptions(options: ProviderOptions): Map<ChainId, ChainMapping> {
  if (typeof options.fetch !== 'function' || !Array.isArray(options.chains) || options.chains.length > 256) fail('INVALID_PROVIDER_CONFIG');
  for (const key of [options.apiKey, options.relayApiKey, options.auroraApiKey])
    if (key !== undefined && (typeof key !== 'string' || !key.length || key.length > 512 || /[\s\x00-\x1f\x7f]/.test(key))) fail('INVALID_PROVIDER_CONFIG');
  if (options.relayMaxOrderLifetimeMs !== undefined) boundedInteger(options.relayMaxOrderLifetimeMs, 1, 365 * 86400000);
  if (options.relaySameChainPreviewTtlMs !== undefined) boundedInteger(options.relaySameChainPreviewTtlMs, 1, 60000);
  const mappings = new Map<ChainId, ChainMapping>();
  const relay = new Set<number>(), aurora = new Set<string>();
  for (const raw of options.chains) {
    const id = chainId(raw.chainId);
    if (mappings.has(id)) fail('DUPLICATE_CHAIN_MAPPING');
    if (raw.relayChainId !== undefined) {
      boundedInteger(raw.relayChainId, 1, Number.MAX_SAFE_INTEGER);
      if (relay.has(raw.relayChainId)) fail('DUPLICATE_CHAIN_MAPPING');
      relay.add(raw.relayChainId);
    }
    if (raw.relayProtocolChainId !== undefined && !/^[a-z0-9_-]{1,64}$/.test(raw.relayProtocolChainId)) fail('INVALID_PROVIDER_CONFIG');
    for (const value of [raw.sourceConfirmationMs, raw.destinationVerificationMs]) if (value !== undefined) boundedInteger(value, 0, 604800000);
    if (raw.auroraBlockchain !== undefined) {
      if (!/^[a-z0-9_-]{1,64}$/.test(raw.auroraBlockchain) || aurora.has(raw.auroraBlockchain)) fail('DUPLICATE_CHAIN_MAPPING');
      aurora.add(raw.auroraBlockchain);
    }
    mappings.set(id, Object.freeze({ ...raw, chainId: id }));
  }
  return mappings;
}
/** Legacy apiKey is only allowed at a single-provider entry point. */
function scoped(options: ProviderOptions, provider: 'relay' | 'aurora'): ProviderOptions {
  const key = provider === 'relay' ? 'relayApiKey' : 'auroraApiKey';
  if (options.apiKey !== undefined && options[key] !== undefined && options.apiKey !== options[key]) fail('INVALID_PROVIDER_CONFIG');
  return { ...options, [key]: options[key] ?? options.apiKey, apiKey: undefined };
}
/** No redirects, endpoint substitution, retries, provider error bodies, or key-bearing URLs escape. */
async function json(options: ProviderOptions, endpoint: 'relayChains' | 'relayCurrencies' | 'relayQuote' | 'auroraTokens' | 'auroraQuote', signal: AbortSignal, body?: unknown): Promise<unknown> {
  if (signal.aborted) fail('CANCELLED');
  const relay = endpoint.startsWith('relay');
  const apiKey = relay ? options.relayApiKey : options.auroraApiKey;
  if (!relay && !apiKey) fail('PROVIDER_KEY_REQUIRED');
  const paths = { relayChains: '/chains', relayCurrencies: '/currencies/v2', relayQuote: '/quote/v2', auroraTokens: '/api/tokens/', auroraQuote: '/api/quote/' };
  const origin = relay ? 'https://api.relay.link' : 'https://intents-api.aurora.dev';
  const url = origin + paths[endpoint] + (relay ? '' : encodeURIComponent(apiKey!));
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  if (encoded && new TextEncoder().encode(encoded).length > 65536) fail('PROVIDER_REQUEST_TOO_LARGE');
  try {
    const response = await options.fetch(url, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal,
      headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(relay && apiKey ? { 'x-api-key': apiKey } : {}) }, body: encoded });
    if (signal.aborted) { void response.body?.cancel().catch(() => {}); fail('CANCELLED'); }
    if (response.redirected || response.url && response.url !== url) { await response.body?.cancel(); fail('PROVIDER_REDIRECT'); }
    if (!response.ok) { await response.body?.cancel(); throw new QuoteFault(response.status === 429 ? 'PROVIDER_RATE_LIMIT' : 'PROVIDER_HTTP_ERROR', response.status === 429 || response.status >= 500); }
    const length = response.headers.get('content-length');
    if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > MAX_RESPONSE)) { await response.body?.cancel(); fail('PROVIDER_RESPONSE_TOO_LARGE'); }
    if (!response.body) fail('PROVIDER_INVALID_RESPONSE');
    const reader = response.body.getReader();
    const stop = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', stop, { once: true });
    const chunks: Uint8Array[] = []; let size = 0, parts = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (signal.aborted) fail('CANCELLED');
        if (part.done) break;
        if (++parts > 16384) fail('PROVIDER_RESPONSE_TOO_FRAGMENTED');
        size += part.value.length;
        if (size > MAX_RESPONSE) fail('PROVIDER_RESPONSE_TOO_LARGE');
        chunks.push(part.value);
        if (parts % 128 === 0) await new Promise(resolve => setTimeout(resolve, 0));
      }
    } finally { signal.removeEventListener('abort', stop); await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const bytes = new Uint8Array(size); let at = 0;
    for (const part of chunks) { bytes.set(part, at); at += part.length; }
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { fail('PROVIDER_INVALID_JSON'); }
    let nodes = 0;
    const inspect = (item: unknown, depth: number): void => {
      if (++nodes > 100000 || depth > 32 || typeof item === 'number' && !Number.isFinite(item)) fail('PROVIDER_INVALID_JSON');
      if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('PROVIDER_INVALID_JSON');
        inspect(child, depth + 1);
      }
    };
    inspect(value, 0); return value;
  } catch (error) {
    if (error instanceof QuoteFault) throw error;
    if (signal.aborted) throw new QuoteFault('CANCELLED', false);
    throw new QuoteFault('PROVIDER_FETCH_OR_PARSE_FAILED');
  }
}
export async function discoverRelayChains(options: ProviderOptions, signal: AbortSignal): Promise<RelayChain[]> {
  options = scoped(options, 'relay');
  validateOptions(options);
  const seen = new Set<number>();
  return list(obj(await json(options, 'relayChains', signal)).chains, 1000).map(raw => {
    const row = obj(raw), id = boundedInteger(row.id, 1, Number.MAX_SAFE_INTEGER);
    if (seen.has(id) || typeof row.disabled !== 'boolean' || typeof row.depositEnabled !== 'boolean') fail('PROVIDER_INVALID_CATALOG');
    seen.add(id);
    const protocol = row.protocol == null ? undefined : obj(row.protocol);
    const v2 = protocol?.v2 == null ? undefined : obj(protocol.v2);
    const protocolChainId = v2?.chainId == null ? undefined : str(v2.chainId, 64);
    if (protocolChainId !== undefined && !/^[a-z0-9_-]{1,64}$/.test(protocolChainId)) fail('PROVIDER_INVALID_CATALOG');
    const currency = row.currency == null ? undefined : obj(row.currency);
    return { id, name: str(row.name), vmType: str(row.vmType, 32), disabled: row.disabled, depositEnabled: row.depositEnabled,
      ...(protocolChainId === undefined ? {} : { protocolChainId }),
      ...(currency === undefined ? {} : { currency: { address: str(currency.address),
        decimals: boundedInteger(currency.decimals, 0, 255), symbol: str(currency.symbol, 64) } }) };
  });
}
export async function discoverRelayCurrencies(options: ProviderOptions, signal: AbortSignal, query: { chainIds?: number[]; term?: string; address?: string; useExternalSearch?: boolean; limit?: number } = {}): Promise<DiscoveredAsset[]> {
  options = scoped(options, 'relay');
  const mappings = validateOptions(options);
  const body = { ...query, limit: boundedInteger(query.limit ?? 100, 1, 100), ...(query.term === undefined && query.address === undefined ? { defaultList: true } : {}) };
  if (query.term !== undefined) str(query.term, 128);
  if (query.address !== undefined) str(query.address, 128);
  if (query.useExternalSearch !== undefined && typeof query.useExternalSearch !== 'boolean') fail('PROVIDER_INVALID_CATALOG');
  if (query.chainIds) query.chainIds.forEach(id => boundedInteger(id, 1, Number.MAX_SAFE_INTEGER));
  const seen = new Set<string>();
  const result: DiscoveredAsset[] = [];
  for (const raw of list(await json(options, 'relayCurrencies', signal, body), 100)) {
    const row = obj(raw), id = boundedInteger(row.chainId, 1, Number.MAX_SAFE_INTEGER);
    if (query.address !== undefined && query.chainIds?.length === 1 &&
      (id !== query.chainIds[0] || typeof row.address !== 'string' || row.address.toLowerCase() !== query.address.toLowerCase()))
      fail('PROVIDER_ASSET_MISMATCH');
    const mapping = [...mappings.values()].find(item => item.relayChainId === id);
    if (!mapping) continue;
    const asset = normalizeAsset({ chainId: mapping.chainId, address: str(row.address), decimals: row.decimals });
    if (seen.has(assetKey(asset))) fail('PROVIDER_DUPLICATE_ASSET'); seen.add(assetKey(asset));
    const metadata = row.metadata == null ? {} : obj(row.metadata);
    if (metadata.isNative != null && typeof metadata.isNative !== 'boolean') fail('PROVIDER_INVALID_CATALOG');
    result.push({ asset, providerAssetId: `${id}:${asset.address}`, symbol: str(row.symbol, 64), native: typeof metadata.isNative === 'boolean' ? metadata.isNative : null });
  }
  return result;
}
export async function discoverAuroraTokens(options: ProviderOptions, signal: AbortSignal): Promise<AuroraToken[]> {
  options = scoped(options, 'aurora');
  validateOptions(options);
  const response = await json(options, 'auroraTokens', signal);
  const rows = Array.isArray(response) ? response : obj(response).tokens;
  const seen = new Set<string>();
  return list(rows, 10000).map(raw => {
    const row = obj(raw), assetId = str(row.assetId);
    if (seen.has(assetId)) fail('PROVIDER_DUPLICATE_ASSET'); seen.add(assetId);
    return { assetId, blockchain: str(row.blockchain, 64), decimals: boundedInteger(row.decimals, 0, 255),
      symbol: str(row.symbol, 64), ...(row.contractAddress === undefined ? {} : { contractAddress: str(row.contractAddress) }) };
  });
}
/** Only catalogs are TTL cached; no firm quote or execution authorization is retained. */
export function createProviderDiscovery(options: ProviderOptions) {
  if (options.apiKey !== undefined) fail('PROVIDER_KEYS_REQUIRE_EXPLICIT_SCOPE');
  validateOptions(options);
  const chains = new MetadataCache<RelayChain[]>(options.metadataTtlMs ?? 30000);
  const currencies = new MetadataCache<DiscoveredAsset[]>(options.metadataTtlMs ?? 30000);
  const tokens = new MetadataCache<AuroraToken[]>(options.metadataTtlMs ?? 30000);
  return {
    relayChains: (signal: AbortSignal) => chains.get('chains', shared => discoverRelayChains(options, shared), { signal }),
    relayCurrencies: (signal: AbortSignal, query: Parameters<typeof discoverRelayCurrencies>[2] = {}) =>
      currencies.get(JSON.stringify(query), shared => discoverRelayCurrencies(options, shared, query), { signal }),
    auroraTokens: (signal: AbortSignal) => tokens.get('tokens', shared => discoverAuroraTokens(options, shared), { signal }),
    clear: () => { chains.clear(); currencies.clear(); tokens.clear(); },
  };
}
function context(ctx: QuoteContext, id: string, mappings: Map<ChainId, ChainMapping>, now: number) {
  if (ctx.signal.aborted) fail('CANCELLED');
  if (ctx.leg.adapterId !== id || !sameAsset(ctx.leg.source, ctx.request.source) && ctx.leg.index === 0) fail('PROVIDER_CONTEXT_MISMATCH');
  rawAmount(ctx.amountRaw, true); boundedInteger(ctx.slippageBps, 0, 10000);
  if (!Number.isSafeInteger(ctx.deadlineMs) || ctx.deadlineMs <= now) fail('QUOTE_DEADLINE');
  if (!Number.isSafeInteger(ctx.transportDeadlineMs) || ctx.transportDeadlineMs <= now) fail('QUOTE_DEADLINE');
  str(ctx.sender); str(ctx.recipient);
  const source = mappings.get(ctx.leg.source.chainId), destination = mappings.get(ctx.leg.destination.chainId);
  if (!source || !destination) fail('PROVIDER_CHAIN_UNSUPPORTED');
  return { source, destination };
}
function snapshotContext(ctx: QuoteContext): QuoteContext {
  return { ...ctx, request: structuredClone(ctx.request), leg: structuredClone(ctx.leg) };
}
function outputs(expected: unknown, minimum: unknown, slippage: number): { expectedOutRaw: string; minimumOutRaw: string } {
  const out = rawAmount(expected, true), floor = rawAmount(minimum, true);
  if (BigInt(floor) > BigInt(out) || BigInt(floor) < BigInt(out) * BigInt(10000 - slippage) / 10000n) fail('PROVIDER_OUTPUT_BOUND');
  return { expectedOutRaw: out, minimumOutRaw: floor };
}
function epoch(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) fail('PROVIDER_INVALID_DEADLINE');
  const time = Date.parse(value); if (!Number.isSafeInteger(time)) fail('PROVIDER_INVALID_DEADLINE'); return time;
}
function estimate(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 604800) fail('PROVIDER_INVALID_ESTIMATE');
  return Math.ceil(value * 1000);
}
function completion(protocol: number | null, source: ChainMapping, destination: ChainMapping): number | null {
  return protocol === null || source.sourceConfirmationMs === undefined || destination.destinationVerificationMs === undefined
    ? null : protocol + source.sourceConfirmationMs + destination.destinationVerificationMs;
}
function decimal(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,30})(?:\.[0-9]{1,18})?$/.test(value)) fail('PROVIDER_INVALID_DECIMAL');
  const [whole, fraction = ''] = value.split('.'); return BigInt(whole!) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
}
function absoluteDecimal(value: unknown): bigint {
  if (typeof value !== 'string') fail('PROVIDER_INVALID_DECIMAL');
  return decimal(value.startsWith('-') ? value.slice(1) : value);
}
function bps(value: bigint, denominator: bigint, maximum = 10000n): number {
  if (denominator <= 0n) fail('PROVIDER_INVALID_ECONOMICS');
  const result = (value * 10000n + denominator - 1n) / denominator;
  if (result > maximum) fail('PROVIDER_INVALID_ECONOMICS'); return Number(result);
}
function relayEconomics(raw: Record<string, unknown>, details: Record<string, unknown>): QuoteEconomics {
  let feeBps: number | null = null, priceImpactBps: number | null = null;
  if (details.swapImpact !== undefined) {
    const percent = obj(details.swapImpact).percent;
    if (typeof percent !== 'string') fail('PROVIDER_INVALID_DECIMAL');
    priceImpactBps = bps(absoluteDecimal(percent), 100n * 10n ** 18n);
  }
  if (details.expandedPriceImpact !== undefined && raw.fees !== undefined) {
    const expanded = obj(details.expandedPriceImpact), fees = obj(raw.fees);
    // Expanded execution/relay/app are disjoint; gas is separate. Do not add relayer aggregates again.
    // Relay represents fee debit impacts as negative USD. Absolute components
    // conservatively count their full cost; never credit a negative fee as zero.
    const sum = ['execution', 'relay', 'app'].reduce((total, key) => total + absoluteDecimal(obj(expanded[key]).usd), 0n);
    feeBps = bps(sum + decimal(obj(fees.gas).amountUsd), decimal(obj(details.currencyIn).amountUsd), BigInt(Number.MAX_SAFE_INTEGER));
  }
  return { feeBps, priceImpactBps };
}
function envelope(ctx: QuoteContext, id: string, out: ReturnType<typeof outputs>, expiry: number, quoteId: string, economics: QuoteEconomics, protocolEstimateMs: number | null, source: ChainMapping, destination: ChainMapping, conditional = false): LegQuote {
  if (economics.feeBps !== null) boundedInteger(economics.feeBps, 0, Number.MAX_SAFE_INTEGER);
  if (economics.priceImpactBps !== null) boundedInteger(economics.priceImpactBps, 0, 10000);
  return Object.freeze({ capabilityId: ctx.leg.capabilityId, adapterId: id, source: normalizeAsset(ctx.leg.source), destination: normalizeAsset(ctx.leg.destination),
    amountInRaw: ctx.amountRaw, ...out, ...economics,
    costDenominator: { source: normalizeAsset(ctx.leg.source), amountRaw: ctx.amountRaw },
    estimatedCompletionMs: completion(protocolEstimateMs, source, destination), protocolEstimateMs,
    ...(source.sourceConfirmationMs === undefined || destination.destinationVerificationMs === undefined ? {} : {
      verificationMs: { sourceConfirmationMs: source.sourceConfirmationMs, destinationVerificationMs: destination.destinationVerificationMs } }),
    expiresAtMs: Math.min(expiry, ctx.deadlineMs), quoteId,
    conditional, liquidityConfirmed: true });
}
export function createRelayAdapter(options: ProviderOptions): ProviderAdapter {
  options = scoped(options, 'relay');
  const mappings = validateOptions(options), clock = options.clock ?? Date.now;
  return { id: 'relay', async quote(inputContext) {
    const ctx = snapshotContext(inputContext);
    const now = clock(), { source, destination } = context(ctx, 'relay', mappings, now);
    if (source.relayChainId === undefined || destination.relayChainId === undefined) fail('PROVIDER_CHAIN_UNSUPPORTED');
    const raw = obj(await json(options, 'relayQuote', ctx.signal, { user: ctx.sender, recipient: ctx.recipient, refundTo: ctx.sender,
      originChainId: source.relayChainId, destinationChainId: destination.relayChainId, originCurrency: ctx.leg.source.address,
      destinationCurrency: ctx.leg.destination.address, amount: ctx.amountRaw, tradeType: 'EXACT_INPUT', slippageTolerance: String(ctx.slippageBps),
      indicativeQuote: false, useDepositAddress: false, includeProtocolData: true }));
    const details = obj(raw.details), input = obj(details.currencyIn), output = obj(details.currencyOut);
    for (const [item, asset, mapping] of [[input, ctx.leg.source, source], [output, ctx.leg.destination, destination]] as const) {
      const currency = obj(item.currency);
      if (currency.chainId !== mapping.relayChainId || currency.decimals !== asset.decimals || !equal(currency.address, asset.address, asset.chainId)) fail('PROVIDER_ASSET_MISMATCH');
    }
    if (input.amount !== ctx.amountRaw || !equal(details.sender, ctx.sender, ctx.leg.source.chainId) || !equal(details.recipient, ctx.recipient, ctx.leg.destination.chainId)) fail('PROVIDER_IDENTITY_MISMATCH');
    if (raw.protocol === undefined && options.relaySameChainPreviewTtlMs !== undefined &&
        ctx.leg.kind === 'SWAP' && ctx.leg.source.chainId === ctx.leg.destination.chainId) {
      const requestId = str(raw.requestId, 128);
      if (!/^[A-Za-z0-9_.:-]+$/.test(requestId)) fail('PROVIDER_INVALID_STRING');
      verifyRelayPreviewSteps(raw.steps, ctx, source);
      const out = outputs(output.amount, output.minimumAmount, ctx.slippageBps);
      const economics = relayEconomics(raw, details), protocolMs = estimate(details.timeEstimate);
      const expiry = Math.min(now + options.relaySameChainPreviewTtlMs, ctx.deadlineMs);
      context(ctx, 'relay', mappings, clock());
      if (clock() >= expiry) fail('PROVIDER_QUOTE_EXPIRED');
      const binding = { requestId, source: normalizeAsset(ctx.leg.source), destination: normalizeAsset(ctx.leg.destination),
        sender: ctx.sender, recipient: ctx.recipient, amountRaw: ctx.amountRaw, slippageBps: ctx.slippageBps, ...out, ...economics, protocolMs };
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(binding))));
      context(ctx, 'relay', mappings, clock());
      if (clock() >= expiry) fail('PROVIDER_QUOTE_EXPIRED');
      const quote = envelope(ctx, 'relay', out, expiry, 'relay:preview:' + [...hash].map(byte => byte.toString(16).padStart(2, '0')).join(''),
        economics, protocolMs, source, { ...destination, destinationVerificationMs: 0 }, true);
      return Object.freeze({ ...quote, pricingValidUntilMs: expiry });
    }
    const protocol = obj(obj(raw.protocol).v2), order = obj(protocol.orderData), orderOut = obj(order.output);
    if (!source.relayProtocolChainId || !destination.relayProtocolChainId) fail('PROVIDER_PROTOCOL_CHAIN_UNCONFIGURED');
    const inputs = list(order.inputs, 1), payments = list(orderOut.payments, 1);
    if (inputs.length !== 1 || payments.length !== 1) fail('PROVIDER_UNSUPPORTED_RECIPE');
    const payment = obj(obj(inputs[0]).payment), delivered = obj(payments[0]);
    if (payment.chainId !== source.relayProtocolChainId || orderOut.chainId !== destination.relayProtocolChainId ||
        payment.amount !== ctx.amountRaw || !equal(payment.currency, ctx.leg.source.address, ctx.leg.source.chainId) ||
        !equal(delivered.currency, ctx.leg.destination.address, ctx.leg.destination.chainId) || !equal(delivered.recipient, ctx.recipient, ctx.leg.destination.chainId) ||
        delivered.minimumAmount !== output.minimumAmount || delivered.expectedAmount !== output.amount || list(orderOut.calls, 0).length !== 0) fail('PROVIDER_ORDER_MISMATCH');
    const expiry = boundedInteger(orderOut.deadline, 1, 0xffffffff, 'PROVIDER_INVALID_DEADLINE') * 1000;
    if (expiry <= clock() || clock() >= ctx.deadlineMs || clock() >= ctx.transportDeadlineMs ||
        options.relayMaxOrderLifetimeMs !== undefined && expiry > now + options.relayMaxOrderLifetimeMs) fail('PROVIDER_QUOTE_EXPIRED');
    const out = outputs(output.amount, output.minimumAmount, ctx.slippageBps);
    return envelope(ctx, 'relay', out, expiry, str(protocol.orderId), relayEconomics(raw, details), estimate(details.timeEstimate), source, destination);
  } };
}
/** Exact assets bind through details. DEX payloads may use token accounts/ALTs
 * instead of explicit mint keys; their shape never validates execution. */
function verifyRelayPreviewSteps(raw: unknown, ctx: QuoteContext, chain: ChainMapping): void {
  let swap = false, signer = false;
  const publicKey = (value: unknown): string => {
    const key = str(value, 44);
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(key)) fail('PROVIDER_UNSUPPORTED_RECIPE');
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let decoded = 0n, bytes = 0;
    for (const char of key) decoded = decoded * 58n + BigInt(alphabet.indexOf(char));
    while (decoded > 0n) { bytes++; decoded >>= 8n; }
    if (bytes + key.match(/^1*/)![0].length !== 32) fail('PROVIDER_UNSUPPORTED_RECIPE');
    return key;
  };
  const steps = list(raw, 8);
  if (!steps.length) fail('PROVIDER_UNSUPPORTED_RECIPE');
  for (const item of steps) {
    const step = obj(item), items = list(step.items, 8);
    if (!['swap', 'approve'].includes(step.id as string) || step.kind !== 'transaction' || !items.length) fail('PROVIDER_UNSUPPORTED_RECIPE');
    swap ||= step.id === 'swap';
    for (const rawItem of items) {
      const data = obj(obj(rawItem).data);
      if (ctx.leg.source.chainId.startsWith('eip155:')) {
        if (data.chainId !== chain.relayChainId || !equal(data.from, ctx.sender, ctx.leg.source.chainId) ||
            typeof data.to !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(data.to) ||
            typeof data.data !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(data.data)) fail('PROVIDER_ORDER_MISMATCH');
        rawAmount(data.value);
        if (step.id === 'swap' && ctx.leg.source.address === '0x' + '0'.repeat(40) && data.value !== ctx.amountRaw) fail('PROVIDER_INPUT_MISMATCH');
      } else if (ctx.leg.source.chainId.startsWith('solana:')) {
        if (data.chainId !== undefined && data.chainId !== chain.relayChainId) fail('PROVIDER_ORDER_MISMATCH');
        const instructions = list(data.instructions, 128);
        if (!instructions.length) fail('PROVIDER_UNSUPPORTED_RECIPE');
        for (const rawInstruction of instructions) {
          const instruction = obj(rawInstruction); publicKey(instruction.programId); str(instruction.data, 65536);
          for (const rawKey of list(instruction.keys, 256)) {
            const key = obj(rawKey), pubkey = publicKey(key.pubkey);
            if (typeof key.isSigner !== 'boolean' || typeof key.isWritable !== 'boolean' || key.isSigner && pubkey !== ctx.sender) fail('PROVIDER_IDENTITY_MISMATCH');
            signer ||= key.isSigner === true && pubkey === ctx.sender;
          }
        }
        for (const table of list(data.addressLookupTableAddresses, 64)) publicKey(table);
      } else fail('PROVIDER_CHAIN_UNSUPPORTED');
    }
  }
  if (!swap) fail('PROVIDER_UNSUPPORTED_RECIPE');
  if (ctx.leg.source.chainId.startsWith('solana:') && !signer) fail('PROVIDER_IDENTITY_MISMATCH');
}
export function createAuroraAdapter(options: AuroraOptions): ProviderAdapter {
  options = { ...options, ...scoped(options, 'aurora') };
  const mappings = validateOptions(options), clock = options.clock ?? Date.now;
  const cache = new MetadataCache<AuroraToken[]>(options.metadataTtlMs ?? 30000);
  if (options.tokenCatalog !== undefined && typeof options.tokenCatalog !== 'function') fail('INVALID_PROVIDER_CONFIG');
  const dry = options.dryRun ?? true;
  if (typeof dry !== 'boolean') fail('INVALID_PROVIDER_CONFIG');
  const ttl = boundedInteger(options.previewTtlMs ?? 15000, 1, 60000);
  const appFees = (options.appFees ?? []).map(row => ({ recipient: str(row.recipient), fee: boundedInteger(row.fee, 1, 500) }));
  if (appFees.length > 8) fail('INVALID_PROVIDER_CONFIG');
  const referral = options.referral === undefined ? undefined : str(options.referral, 128);
  const pinned = new Map<string, AuroraAssetMapping>();
  for (const item of options.assets ?? []) {
    const asset = normalizeAsset(item.asset);
    if (typeof item.native !== 'boolean' || pinned.has(assetKey(asset))) fail('INVALID_PROVIDER_CONFIG');
    pinned.set(assetKey(asset), { asset, assetId: str(item.assetId), native: item.native });
  }
  return { id: 'aurora', async quote(inputContext) {
    const ctx = snapshotContext(inputContext);
    const now = clock(), { source, destination } = context(ctx, 'aurora', mappings, now);
    const tokens = options.tokenCatalog ? await options.tokenCatalog(ctx.signal) :
      await cache.get('tokens', shared => discoverAuroraTokens(options, shared),
        { signal: ctx.signal, timeoutMs: Math.min(10000, ctx.transportDeadlineMs - clock()) });
    context(ctx, 'aurora', mappings, clock());
    const resolve = (asset: Asset, mapping: ChainMapping): string => {
      const explicit = pinned.get(assetKey(asset));
      const rows = tokens.filter(token => token.blockchain === mapping.auroraBlockchain && token.decimals === asset.decimals &&
        (explicit ? token.assetId === explicit.assetId && (explicit.native || equal(token.contractAddress, asset.address, asset.chainId)) : equal(token.contractAddress, asset.address, asset.chainId)));
      if (rows.length !== 1) fail('PROVIDER_ASSET_UNSUPPORTED'); return rows[0]!.assetId;
    };
    const body = { dry, swapType: 'EXACT_INPUT', depositType: 'ORIGIN_CHAIN', depositMode: 'SIMPLE', confidentiality: 'public',
      amount: ctx.amountRaw, originAsset: resolve(ctx.leg.source, source), destinationAsset: resolve(ctx.leg.destination, destination),
      slippageTolerance: ctx.slippageBps, refundTo: ctx.sender, refundType: 'ORIGIN_CHAIN', recipient: ctx.recipient, recipientType: 'DESTINATION_CHAIN',
      deadline: new Date(ctx.deadlineMs).toISOString(), quoteWaitingTimeMs: 0 };
    const raw = obj(await json(options, 'auroraQuote', ctx.signal, body)), echo = obj(raw.quoteRequest), quote = obj(raw.quote);
    for (const [key, value] of Object.entries(body)) if (echo[key] !== value) fail('PROVIDER_REQUEST_MISMATCH');
    const actualFees = list(echo.appFees ?? [], 8);
    if (actualFees.length !== appFees.length || actualFees.some((raw, index) => {
      const fee = obj(raw), expected = appFees[index]!;
      return Object.keys(fee).length !== 2 || fee.recipient !== expected.recipient || fee.fee !== expected.fee;
    })) fail('PROVIDER_UNREVIEWED_ENRICHMENT');
    if (referral !== undefined ? echo.referral !== referral : echo.referral !== undefined && echo.referral !== null && echo.referral !== '') fail('PROVIDER_UNREVIEWED_ENRICHMENT');
    for (const key of Object.keys(echo)) if (!(key in body) && !['appFees', 'referral'].includes(key) && echo[key] !== null && echo[key] !== '' && !(Array.isArray(echo[key]) && (echo[key] as unknown[]).length === 0)) fail('PROVIDER_UNREVIEWED_ENRICHMENT');
    const timestamp = epoch(raw.timestamp);
    if (timestamp < now - 300000 || timestamp > clock() + 5000 || clock() >= ctx.deadlineMs || clock() >= ctx.transportDeadlineMs) fail('PROVIDER_QUOTE_EXPIRED');
    str(raw.signature, 2048);
    if (quote.amountIn !== ctx.amountRaw || quote.minAmountIn !== undefined && BigInt(rawAmount(quote.minAmountIn, true)) > BigInt(ctx.amountRaw)) fail('PROVIDER_INPUT_MISMATCH');
    if (quote.maxAmountIn !== undefined && BigInt(rawAmount(quote.maxAmountIn, true)) < BigInt(ctx.amountRaw)) fail('PROVIDER_INPUT_MISMATCH');
    if (quote.depositMemo || quote.chainDepositAddresses || quote.virtualChainRecipient || quote.virtualChainRefundRecipient || quote.customRecipientMsg) fail('PROVIDER_UNSUPPORTED_RECIPE');
    let expiry = Math.min(now + ttl, ctx.deadlineMs);
    if (!dry) {
      str(quote.depositAddress); expiry = Math.min(epoch(quote.deadline), epoch(quote.timeWhenInactive));
      if (expiry <= clock()) fail('PROVIDER_QUOTE_EXPIRED');
    } else if (quote.depositAddress !== undefined || quote.deadline !== undefined || quote.timeWhenInactive !== undefined) fail('PROVIDER_DRY_RESPONSE_MISMATCH');
    const out = outputs(quote.amountOut, quote.minAmountOut, ctx.slippageBps);
    const economics = options.economicsVerifier?.(structuredClone(raw), ctx) ?? { feeBps: null, priceImpactBps: null };
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(raw))));
    const quoteId = 'aurora:' + [...hash].map(byte => byte.toString(16).padStart(2, '0')).join('');
    return envelope(ctx, 'aurora', out, expiry, quoteId, economics, estimate(quote.timeEstimate), source, destination, dry);
  } };
}

export { createDeBridgeAdapter } from './debridge-provider.js';
export type { DeBridgeOptions } from './debridge-provider.js';
