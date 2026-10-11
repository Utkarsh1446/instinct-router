import { assetKey, boundedInteger, normalizeAsset, rawAmount, sameAsset } from './capabilities.js';
import { MetadataCache, QuoteFault } from './scheduler.js';
import type { Asset, LegQuote, NativeCost } from './types.js';
import type { ProviderAdapter, QuoteContext } from './router.js';
import type { ProviderFetch } from './provider-adapters.js';

export interface CctpUsdcMapping { readonly asset: Asset; readonly domain: number }
export interface CctpGasEvidence {
  /** Gas-only cost, independently valued relative to the original USDC input. */
  readonly feeBps: number;
  readonly nativeCosts: readonly NativeCost[];
  readonly verifiedAtMs: number;
}
export interface CctpDiscoveryOptions {
  readonly fetch: ProviderFetch;
  readonly clock?: () => number;
  readonly metadataTtlMs?: number;
}
export interface CctpMetadataSnapshot { readonly raw: unknown; readonly observedAtMs: number }
export interface CctpDiscoveryRequest { readonly signal: AbortSignal; readonly timeoutMs: number }
/** Shared protocol metadata only; amounts, wallet reviews and gas are never cached. */
export interface CctpDiscovery {
  readonly metadataTtlMs: number;
  fees(sourceDomain: number, destinationDomain: number, request: CctpDiscoveryRequest): Promise<CctpMetadataSnapshot>;
  fastAllowance(request: CctpDiscoveryRequest): Promise<CctpMetadataSnapshot>;
  clear(): void;
}
export interface CctpOptions {
  readonly id?: 'cctp-fast' | 'cctp-standard';
  readonly mode: 'FAST' | 'STANDARD';
  readonly assets: readonly CctpUsdcMapping[];
  readonly fetch: ProviderFetch;
  readonly clock?: () => number;
  readonly metadataTtlMs?: number;
  readonly discovery?: CctpDiscovery;
  readonly attestationMs?: number;
  readonly verificationMs?: { readonly sourceConfirmationMs: number; readonly destinationVerificationMs: number };
  readonly gasEvidence?: (context: QuoteContext) => Promise<CctpGasEvidence>;
}
export interface CctpLegQuote extends LegQuote {
  readonly mode: 'FAST' | 'STANDARD';
  readonly sourceDomain: number;
  readonly destinationDomain: number;
  readonly protocolFeeRaw: string;
  readonly pricingValidUntilMs: number;
  readonly pricingBasis: 'EXACT_NATIVE_USDC_PROTOCOL_UNITS_NOT_USD';
  readonly executionBasis: 'PRICING_PREVIEW_REQUIRES_CANONICAL_BURN_AND_MINT_PREFLIGHT';
}

function fail(code: string): never { throw new QuoteFault(code, false); }
const MAX_BODY = 262144;
const MAX_CHUNKS = 4096;
const discoveries = new WeakSet<object>();
const ZERO = '0x' + '0'.repeat(40);
const SYSTEM = '11111111111111111111111111111111';

/** Preserve financial numeric lexemes and reject duplicate fields before JS rounding. */
function exactJson(text: string): unknown {
  let at = 0, nodes = 0;
  const white = () => { while (/^[ \t\r\n]$/.test(text[at] ?? '')) at++; };
  const string = (): string => {
    const start = at++;
    while (at < text.length) {
      const char = text[at++];
      if (char === '\\') at++;
      else if (char === '"') return JSON.parse(text.slice(start, at)) as string;
    }
    return fail('CCTP_INVALID_JSON');
  };
  const value = (depth: number, key = ''): unknown => {
    white();
    if (++nodes > 5000 || depth > 16) fail('CCTP_INVALID_JSON');
    if (text[at] === '"') return string();
    if (text[at] === '{') {
      at++; white(); const output: Record<string, unknown> = Object.create(null);
      if (text[at] === '}') { at++; return output; }
      while (true) {
        white(); if (text[at] !== '"') fail('CCTP_INVALID_JSON');
        const name = string();
        if (Object.hasOwn(output, name) || ['__proto__', 'constructor', 'prototype'].includes(name)) fail('CCTP_INVALID_JSON');
        white(); if (text[at++] !== ':') fail('CCTP_INVALID_JSON');
        output[name] = value(depth + 1, name); white();
        const end = text[at++];
        if (end === '}') return output;
        if (end !== ',') fail('CCTP_INVALID_JSON');
      }
    }
    if (text[at] === '[') {
      at++; white(); const output: unknown[] = [];
      if (text[at] === ']') { at++; return output; }
      while (true) {
        output.push(value(depth + 1)); white();
        const end = text[at++];
        if (end === ']') return output;
        if (end !== ',') fail('CCTP_INVALID_JSON');
      }
    }
    for (const [word, result] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(word, at)) { at += word.length; return result; }
    }
    const token = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(at))?.[0];
    if (!token || token.length > 96) fail('CCTP_INVALID_JSON');
    at += token.length;
    if (key === 'minimumFee' || key === 'allowance') return token;
    const number = Number(token); if (!Number.isFinite(number)) fail('CCTP_INVALID_JSON'); return number;
  };
  const parsed = value(0); white();
  if (at !== text.length) fail('CCTP_INVALID_JSON');
  return parsed;
}

function record(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('CCTP_INVALID_RESPONSE');
  return raw as Record<string, unknown>;
}

function decimal(raw: unknown): { numerator: bigint; denominator: bigint } {
  if (typeof raw !== 'string' || !/^(0|[1-9][0-9]{0,30})(?:\.[0-9]{1,36})?$/.test(raw)) fail('CCTP_INVALID_DECIMAL');
  const [whole, fraction = ''] = raw.split('.');
  return { numerator: BigInt(whole! + fraction), denominator: 10n ** BigInt(fraction.length) };
}

function cancelBody(body: ReadableStream<Uint8Array> | null | undefined): void {
  try { void body?.cancel().catch(() => {}); } catch { /* No transport details escape cleanup. */ }
}

async function read(options: Pick<CctpDiscoveryOptions, 'fetch'>, path: string, signal: AbortSignal): Promise<unknown> {
  const url = 'https://iris-api.circle.com' + path;
  try {
    const response = await options.fetch(url, { method: 'GET', redirect: 'error', signal, headers: { accept: 'application/json' } });
    if (signal.aborted) { cancelBody(response.body); fail('CANCELLED'); }
    if (response.redirected || response.url && response.url !== url) { cancelBody(response.body); fail('CCTP_REDIRECT'); }
    if (!response.ok) {
      cancelBody(response.body);
      throw new QuoteFault(response.status === 429 ? 'CCTP_RATE_LIMIT' : 'CCTP_HTTP_ERROR', response.status === 429 || response.status >= 500);
    }
    const length = response.headers.get('content-length');
    if (length !== null && (!/^[0-9]{1,8}$/.test(length) || Number(length) > MAX_BODY)) {
      cancelBody(response.body); fail('CCTP_RESPONSE_TOO_LARGE');
    }
    if (!response.body) fail('CCTP_INVALID_RESPONSE');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0, count = 0;
    const cancel = () => { try { void reader.cancel().catch(() => {}); } catch { /* Safe cleanup. */ } };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      while (true) {
        if (signal.aborted) fail('CANCELLED');
        const part = await reader.read();
        if (signal.aborted) fail('CANCELLED');
        if (part.done) break;
        if (++count > MAX_CHUNKS) fail('CCTP_RESPONSE_TOO_LARGE');
        size += part.value.length; if (size > MAX_BODY) fail('CCTP_RESPONSE_TOO_LARGE'); chunks.push(part.value);
      }
    } finally { signal.removeEventListener('abort', cancel); cancel(); reader.releaseLock(); }
    if (length !== null && Number(length) !== size) fail('CCTP_INVALID_RESPONSE');
    const bytes = new Uint8Array(size); let index = 0;
    for (const chunk of chunks) { bytes.set(chunk, index); index += chunk.length; }
    return exactJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof QuoteFault) throw error;
    if (signal.aborted) fail('CANCELLED');
    throw new QuoteFault('CCTP_FETCH_OR_PARSE_FAILED');
  }
}

/** A single trusted instance can serve all modes and directed asset mappings. */
export function createCctpDiscovery(options: CctpDiscoveryOptions): CctpDiscovery {
  if (!options || typeof options.fetch !== 'function' || options.clock !== undefined && typeof options.clock !== 'function')
    fail('CCTP_INVALID_CONFIG');
  const now = options.clock ?? Date.now, ttl = boundedInteger(options.metadataTtlMs ?? 5000, 1, 5000);
  const transport = Object.freeze({ fetch: options.fetch });
  const fees = new MetadataCache<CctpMetadataSnapshot>(ttl, 64, { clock: now });
  const allowance = new MetadataCache<CctpMetadataSnapshot>(ttl, 1, { clock: now });
  const get = (cache: MetadataCache<CctpMetadataSnapshot>, key: string, path: string, request: CctpDiscoveryRequest) =>
    cache.get(key, async signal => ({ raw: await read(transport, path, signal),
      observedAtMs: boundedInteger(now(), 0, Number.MAX_SAFE_INTEGER) }), request);
  const discovery = Object.freeze({ metadataTtlMs: ttl,
    fees(sourceDomain: number, destinationDomain: number, request: CctpDiscoveryRequest) {
      const source = boundedInteger(sourceDomain, 0, 0xffffffff), destination = boundedInteger(destinationDomain, 0, 0xffffffff);
      if (source === destination) fail('CCTP_PAIR_UNSUPPORTED');
      return get(fees, `${source}/${destination}`, `/v2/burn/USDC/fees/${source}/${destination}`, request);
    },
    fastAllowance(request: CctpDiscoveryRequest) { return get(allowance, 'fast', '/v2/fastBurn/USDC/allowance', request); },
    clear() { fees.clear(); allowance.clear(); },
  });
  discoveries.add(discovery);
  return discovery;
}

/** Pricing only. Signing stays in independently reviewed canonical host recipes. */
export function createCctpAdapter(options: CctpOptions): ProviderAdapter {
  if (!['FAST', 'STANDARD'].includes(options.mode) || typeof options.fetch !== 'function'
      || !Array.isArray(options.assets) || options.assets.length < 2 || options.assets.length > 64) fail('CCTP_INVALID_CONFIG');
  const id = options.mode === 'FAST' ? 'cctp-fast' : 'cctp-standard';
  if (options.id !== undefined && options.id !== id) fail('CCTP_INVALID_CONFIG');
  if (options.discovery !== undefined && (!options.discovery || !discoveries.has(options.discovery))) fail('CCTP_INVALID_CONFIG');
  const now = options.clock ?? Date.now;
  const discovery = options.discovery ?? createCctpDiscovery(options);
  const ttl = Math.min(boundedInteger(options.metadataTtlMs ?? 5000, 1, 5000), discovery.metadataTtlMs);
  const domains = new Set<number>(), chains = new Set<string>(), mappings = new Map<string, CctpUsdcMapping>();
  for (const input of options.assets) {
    const asset = normalizeAsset(input.asset), domain = boundedInteger(input.domain, 0, 0xffffffff);
    if (asset.decimals !== 6 || asset.address === ZERO || asset.address === SYSTEM
        || domains.has(domain) || chains.has(asset.chainId)) fail('CCTP_INVALID_CONFIG');
    domains.add(domain); chains.add(asset.chainId); mappings.set(assetKey(asset), Object.freeze({ asset, domain }));
  }
  const attestationMs = options.attestationMs === undefined ? null : boundedInteger(options.attestationMs, 1, 604800000);
  const verification = options.verificationMs === undefined ? undefined : Object.freeze({
    sourceConfirmationMs: boundedInteger(options.verificationMs.sourceConfirmationMs, 1, 604800000),
    destinationVerificationMs: boundedInteger(options.verificationMs.destinationVerificationMs, 1, 604800000),
  });
  return { id, async quote(ctx): Promise<CctpLegQuote> {
    const started = now();
    boundedInteger(started, 0, Number.MAX_SAFE_INTEGER);
    if (ctx.signal.aborted) fail('CANCELLED');
    if (ctx.leg.adapterId !== id || ctx.leg.kind !== 'BRIDGE' || ctx.deadlineMs > ctx.request.deadlineMs
        || !Number.isSafeInteger(ctx.deadlineMs) || ctx.deadlineMs <= started
        || ctx.leg.index === 0 && (!sameAsset(ctx.leg.source, ctx.request.source) || ctx.amountRaw !== ctx.request.amountRaw)) fail('CCTP_CONTEXT_MISMATCH');
    const source = mappings.get(assetKey(ctx.leg.source)), destination = mappings.get(assetKey(ctx.leg.destination));
    if (!source || !destination || source.domain === destination.domain || source.asset.chainId === destination.asset.chainId) fail('CCTP_PAIR_UNSUPPORTED');
    const amount = BigInt(rawAmount(ctx.amountRaw, true));
    if (source.asset.chainId.startsWith('solana:') && amount > 0xffffffffffffffffn) fail('CCTP_AMOUNT_UNSUPPORTED');
    const metadata = async (load: (request: CctpDiscoveryRequest) => Promise<CctpMetadataSnapshot>) => {
      const remaining = Math.min(10000, ctx.transportDeadlineMs - now());
      if (!Number.isSafeInteger(remaining) || remaining <= 0) fail('CCTP_QUOTE_DEADLINE');
      try {
        return await load({ signal: ctx.signal, timeoutMs: remaining });
      } catch (error) { if (error instanceof QuoteFault && error.code === 'METADATA_TIMEOUT') fail('CCTP_QUOTE_DEADLINE'); throw error; }
    };
    const [rows, captured] = await Promise.all([
      metadata(request => discovery.fees(source.domain, destination.domain, request)),
      options.mode === 'FAST' ? metadata(request => discovery.fastAllowance(request)) : Promise.resolve(undefined),
    ]);
    if (rows.observedAtMs > now()) fail('CCTP_QUOTE_DEADLINE');
    if (!Array.isArray(rows.raw) || rows.raw.length < 1 || rows.raw.length > 8) fail('CCTP_INVALID_FEES');
    const threshold = options.mode === 'FAST' ? 1000 : 2000;
    const selected = rows.raw.map(record).filter(row => row.finalityThreshold === threshold);
    if (selected.length !== 1) fail('CCTP_MODE_UNAVAILABLE');
    const rate = decimal(selected[0]!.minimumFee);
    if (rate.numerator >= 10000n * rate.denominator) fail('CCTP_INVALID_FEES');
    const divisor = 10000n * rate.denominator;
    const feeRaw = (amount * rate.numerator + divisor - 1n) / divisor;
    const output = amount - feeRaw; if (output <= 0n) fail('CCTP_NONPOSITIVE_OUTPUT');
    let pricedAt = rows.observedAtMs;
    if (options.mode === 'FAST') {
      if (!captured) fail('CCTP_INVALID_RESPONSE');
      if (captured.observedAtMs > now()) fail('CCTP_QUOTE_DEADLINE');
      const raw = record(captured.raw), stamp = typeof raw.lastUpdated === 'string' ? Date.parse(raw.lastUpdated) : NaN;
      if (!Number.isSafeInteger(stamp) || now() - stamp < 0 || now() - stamp > 60000) fail('CCTP_ALLOWANCE_STALE');
      const available = decimal(raw.allowance);
      if (available.numerator * 1000000n < amount * available.denominator) fail('CCTP_FAST_ALLOWANCE');
      pricedAt = Math.min(pricedAt, captured.observedAtMs);
    }
    const protocolFeeBps = Number((feeRaw * 10000n + amount - 1n) / amount);
    let feeBps: number | null = null, nativeCosts: readonly NativeCost[] | undefined;
    if (options.gasEvidence) {
      let evidence: CctpGasEvidence;
      try { evidence = await options.gasEvidence(ctx); }
      catch { return fail('CCTP_GAS_EVIDENCE_UNAVAILABLE'); }
      boundedInteger(evidence.verifiedAtMs, 0, Number.MAX_SAFE_INTEGER);
      if (now() - evidence.verifiedAtMs < 0 || now() - evidence.verifiedAtMs > 5000) fail('CCTP_GAS_EVIDENCE_STALE');
      boundedInteger(evidence.feeBps, 1, Number.MAX_SAFE_INTEGER);
      if (!Array.isArray(evidence.nativeCosts) || evidence.nativeCosts.length !== 2) fail('CCTP_GAS_EVIDENCE_INVALID');
      const seen = new Set<string>();
      nativeCosts = Object.freeze(evidence.nativeCosts.map(cost => {
        if (![source.asset.chainId, destination.asset.chainId].includes(cost.chainId) || seen.has(cost.chainId)) fail('CCTP_GAS_EVIDENCE_INVALID');
        seen.add(cost.chainId); return Object.freeze({ chainId: cost.chainId, amountRaw: rawAmount(cost.amountRaw, true) });
      }));
      feeBps = protocolFeeBps + evidence.feeBps;
      boundedInteger(feeBps, 1, Number.MAX_SAFE_INTEGER, 'CCTP_FEE_LIMIT');
    }
    if (ctx.signal.aborted) fail('CANCELLED');
    if (now() >= ctx.transportDeadlineMs || now() >= ctx.deadlineMs || now() >= pricedAt + ttl) fail('CCTP_QUOTE_DEADLINE');
    const key = JSON.stringify([id, source, destination, ctx.sender, ctx.recipient, ctx.amountRaw, threshold, feeRaw.toString(), pricedAt]);
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)));
    if (ctx.signal.aborted) fail('CANCELLED');
    if (now() >= ctx.transportDeadlineMs || now() >= ctx.deadlineMs || now() >= pricedAt + ttl) fail('CCTP_QUOTE_DEADLINE');
    const quoteId = `${id}:pricing:` + [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const complete = attestationMs !== null && verification ? attestationMs + verification.sourceConfirmationMs + verification.destinationVerificationMs : null;
    return Object.freeze({ capabilityId: ctx.leg.capabilityId, adapterId: id, source: source.asset, destination: destination.asset,
      amountInRaw: ctx.amountRaw, expectedOutRaw: output.toString(), minimumOutRaw: output.toString(), feeBps,
      protocolFeeBps, priceImpactBps: 0, estimatedCompletionMs: complete, protocolEstimateMs: attestationMs,
      ...(verification ? { verificationMs: verification } : {}), expiresAtMs: ctx.deadlineMs, quoteId,
      conditional: true, liquidityConfirmed: true, ...(nativeCosts ? { nativeCosts } : {}), mode: options.mode,
      sourceDomain: source.domain, destinationDomain: destination.domain, protocolFeeRaw: feeRaw.toString(),
      pricingValidUntilMs: Math.min(pricedAt + ttl, ctx.deadlineMs), pricingBasis: 'EXACT_NATIVE_USDC_PROTOCOL_UNITS_NOT_USD',
      executionBasis: 'PRICING_PREVIEW_REQUIRES_CANONICAL_BURN_AND_MINT_PREFLIGHT' });
  } };
}
