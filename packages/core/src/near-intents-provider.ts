import type { Asset, ChainId, LegQuote } from './types.js';
import type { ProviderAdapter, QuoteContext } from './router.js';
import { assetKey, boundedInteger, chainId, normalizeAsset, rawAmount, sameAsset } from './capabilities.js';
import { QuoteFault } from './scheduler.js';

/**
 * NEAR Intents 1Click quotes for ranking only.
 * `dry` is always true. A response that includes a deposit address is rejected.
 * Nothing in this adapter signs, submits, or asks 1Click to open a swap.
 */
export const NEAR_INTENTS_ADAPTER_ID = 'near-intents-1click';
export const NEAR_INTENTS_QUOTE_ORIGIN = 'https://1click.chaindefuser.com';

export interface OneClickChain {
  chainId: ChainId;
  /** 1Click `blockchain` name, for example `eth`, `base`, `sol`, or `near`. */
  blockchain: string;
  sourceConfirmationMs?: number;
  destinationVerificationMs?: number;
}
export interface OneClickAssetPin { asset: Asset; assetId: string }
export interface OneClickToken {
  assetId: string;
  blockchain: string;
  decimals: number;
  symbol: string;
  contractAddress?: string | null;
}
export type OneClickFetch = (url: string, init: RequestInit) => Promise<Response>;
export interface NearIntentsOneClickOptions {
  chains: readonly OneClickChain[];
  fetch: OneClickFetch;
  clock?: () => number;
  previewTtlMs?: number;
  assets?: readonly OneClickAssetPin[];
  tokenCatalog?: (signal: AbortSignal) => Promise<readonly OneClickToken[]>;
  /** Optional partner key. Sent only as a header. Never required and never placed in the URL. */
  apiKey?: string;
  referral?: string;
  /**
   * Accepted only as `true`. `false` is rejected so a caller cannot open a live deposit address.
   * Omitting it still sends `dry: true`.
   */
  dry?: true;
}
export interface DryDepositStep {
  readonly id: 'quote' | 'deposit-address' | 'send' | 'audit';
  readonly state: 'complete' | 'withheld' | 'blocked' | 'ready';
  readonly title: string;
  readonly detail: string;
}
export interface DryDepositFlow {
  readonly mode: 'DRY';
  readonly spendable: false;
  readonly depositAddress: null;
  readonly depositType: 'ORIGIN_CHAIN';
  readonly originAssetId: string;
  readonly destinationAssetId: string;
  readonly amountInRaw: string;
  readonly quoteHash: string;
  readonly steps: readonly DryDepositStep[];
}
export interface NearIntentsLegQuote extends LegQuote {
  readonly dryQuote: true;
  readonly quoteHash: string;
  readonly correlationId: string;
  readonly protocolFeeBps: number;
  readonly amountInUsd: string;
  readonly amountOutUsd: string;
  readonly economicsBasis: 'PROTOCOL_APP_FEE_PLUS_USD_RESIDUAL' | 'USD_SHORTFALL';
  readonly dryDeposit: DryDepositFlow;
  readonly refundFeeRaw?: string;
  readonly withdrawFeeRaw?: string;
}

const MAX_RESPONSE = 2 * 1024 * 1024;
const TOKENS_PATH = '/v0/tokens';
const QUOTE_PATH = '/v0/quote';

function fail(code: string): never { throw new QuoteFault(code, false); }
function obj(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('PROVIDER_INVALID_RESPONSE');
  return value as Record<string, unknown>;
}
function str(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value.length || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail('PROVIDER_INVALID_STRING');
  return value;
}
function inspect(value: unknown): void {
  let nodes = 0;
  const walk = (item: unknown, depth: number): void => {
    if (++nodes > 100000 || depth > 32 || typeof item === 'number' && !Number.isFinite(item)) fail('PROVIDER_INVALID_JSON');
    if (!item || typeof item !== 'object') return;
    if (Array.isArray(item)) { for (const child of item) walk(child, depth + 1); return; }
    for (const [key, child] of Object.entries(item)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') fail('PROVIDER_INVALID_JSON');
      walk(child, depth + 1);
    }
  };
  walk(value, 0);
}
function usdScale(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,30})(?:\.[0-9]{1,18})?$/.test(value)) fail('PROVIDER_INVALID_DECIMAL');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
}
function usdShortfallBps(amountInUsd: unknown, amountOutUsd: unknown): number {
  const input = usdScale(amountInUsd), output = usdScale(amountOutUsd);
  if (input <= 0n) fail('PROVIDER_INVALID_ECONOMICS');
  if (output >= input) return 0;
  const bps = ((input - output) * 10000n + input - 1n) / input;
  if (bps > BigInt(Number.MAX_SAFE_INTEGER)) fail('PROVIDER_INVALID_ECONOMICS');
  return Number(bps);
}
/** Canonical economic binding. Key order is the hash preimage; do not reorder. */
export function nearIntentsQuoteCanonical(parts: {
  amountIn: string; amountOut: string; correlationId: string;
  destinationAsset: string; minAmountOut: string; originAsset: string;
}): string {
  return JSON.stringify({
    amountIn: parts.amountIn,
    amountOut: parts.amountOut,
    correlationId: parts.correlationId,
    destinationAsset: parts.destinationAsset,
    minAmountOut: parts.minAmountOut,
    originAsset: parts.originAsset,
  });
}
export async function nearIntentsQuoteHash(canonical: string): Promise<string> {
  if (typeof canonical !== 'string' || !canonical.length || canonical.length > 4096) fail('PROVIDER_INVALID_STRING');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function validateOptions(options: NearIntentsOneClickOptions): Map<ChainId, OneClickChain> {
  if (typeof options.fetch !== 'function' || !Array.isArray(options.chains) || options.chains.length < 1 || options.chains.length > 64)
    fail('INVALID_PROVIDER_CONFIG');
  if ('dry' in options && options.dry !== true) fail('DRY_MODE_REQUIRED');
  if (options.apiKey !== undefined && (typeof options.apiKey !== 'string' || !options.apiKey.length || options.apiKey.length > 512 || /[\s\x00-\x1f\x7f]/.test(options.apiKey)))
    fail('INVALID_PROVIDER_CONFIG');
  if (options.referral !== undefined && !/^[a-z0-9](?:[a-z0-9._-]{0,55}[a-z0-9])?$/.test(options.referral)) fail('INVALID_PROVIDER_CONFIG');
  if (options.previewTtlMs !== undefined) boundedInteger(options.previewTtlMs, 1000, 60000);
  if (options.tokenCatalog !== undefined && typeof options.tokenCatalog !== 'function') fail('INVALID_PROVIDER_CONFIG');
  const chains = new Map<ChainId, OneClickChain>();
  const names = new Set<string>();
  for (const raw of options.chains) {
    const id = chainId(raw.chainId);
    if (chains.has(id) || !/^[a-z0-9]{2,32}$/.test(raw.blockchain) || names.has(raw.blockchain)) fail('INVALID_PROVIDER_CONFIG');
    for (const value of [raw.sourceConfirmationMs, raw.destinationVerificationMs])
      if (value !== undefined) boundedInteger(value, 0, 604800000);
    names.add(raw.blockchain);
    chains.set(id, Object.freeze({ ...raw, chainId: id }));
  }
  return chains;
}

async function readJson(response: Response, url: string, signal: AbortSignal): Promise<unknown> {
  if (response.redirected || response.url && response.url !== url) { await response.body?.cancel(); fail('PROVIDER_REDIRECT'); }
  if (!response.ok) {
    await response.body?.cancel();
    throw new QuoteFault(response.status === 429 ? 'PROVIDER_RATE_LIMIT' : 'PROVIDER_HTTP_ERROR', response.status === 429 || response.status >= 500);
  }
  const length = response.headers.get('content-length');
  if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > MAX_RESPONSE)) { await response.body?.cancel(); fail('PROVIDER_RESPONSE_TOO_LARGE'); }
  if (!response.body) fail('PROVIDER_INVALID_RESPONSE');
  const reader = response.body.getReader();
  const stop = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', stop, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (signal.aborted) fail('CANCELLED');
      if (part.done) break;
      size += part.value.length;
      if (size > MAX_RESPONSE || chunks.length > 16384) fail('PROVIDER_RESPONSE_TOO_LARGE');
      chunks.push(part.value);
    }
  } finally { signal.removeEventListener('abort', stop); await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const part of chunks) { bytes.set(part, at); at += part.length; }
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    inspect(value);
    return value;
  } catch (error) {
    if (error instanceof QuoteFault) throw error;
    fail('PROVIDER_INVALID_JSON');
  }
}

async function requestJson(options: NearIntentsOneClickOptions, path: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
  if (signal.aborted) fail('CANCELLED');
  const url = NEAR_INTENTS_QUOTE_ORIGIN + path;
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  if (encoded && new TextEncoder().encode(encoded).length > 65536) fail('PROVIDER_REQUEST_TOO_LARGE');
  try {
    const response = await options.fetch(url, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal,
      headers: {
        accept: 'application/json',
        ...(encoded ? { 'content-type': 'application/json' } : {}),
        ...(options.apiKey ? { 'x-api-key': options.apiKey } : {}),
      },
      body: encoded,
    });
    if (signal.aborted) { void response.body?.cancel().catch(() => {}); fail('CANCELLED'); }
    return await readJson(response, url, signal);
  } catch (error) {
    if (error instanceof QuoteFault) throw error;
    if (signal.aborted) throw new QuoteFault('CANCELLED', false);
    throw new QuoteFault('PROVIDER_FETCH_OR_PARSE_FAILED');
  }
}

function addressesEqual(tokenAddress: string, asset: Asset): boolean {
  return asset.chainId.startsWith('eip155:') ? tokenAddress.toLowerCase() === asset.address.toLowerCase() : tokenAddress === asset.address;
}

function readProtocolFee(value: unknown): number {
  if (!Array.isArray(value) || value.length > 1) fail('PROVIDER_UNREVIEWED_ENRICHMENT');
  if (value.length === 0) return 0;
  const fee = obj(value[0]);
  if (Object.keys(fee).length !== 2) fail('PROVIDER_UNREVIEWED_ENRICHMENT');
  const bps = fee.fee;
  // Unauthenticated 1Click adds one 20 bps app fee. Anything above 50 bps is rejected
  // rather than ranked as if the caller had agreed to it.
  if (typeof bps !== 'number' || !Number.isSafeInteger(bps) || bps < 0 || bps > 50) fail('PROVIDER_UNREVIEWED_ENRICHMENT');
  if (typeof fee.recipient !== 'string' || !/^[a-z0-9._-]{2,64}$/.test(fee.recipient)) fail('PROVIDER_UNREVIEWED_ENRICHMENT');
  return bps;
}

function optionalRaw(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return rawAmount(value);
}

export function createNearIntentsOneClickAdapter(options: NearIntentsOneClickOptions): ProviderAdapter {
  const chains = validateOptions(options);
  const clock = options.clock ?? Date.now;
  const ttl = options.previewTtlMs ?? 20_000;
  const pins = new Map<string, string>();
  for (const pin of options.assets ?? []) {
    const asset = normalizeAsset(pin.asset);
    const assetId = str(pin.assetId, 220);
    if (!/^[A-Za-z0-9_.:-]{3,220}$/.test(assetId) || pins.has(assetKey(asset))) fail('INVALID_PROVIDER_CONFIG');
    pins.set(assetKey(asset), assetId);
  }
  let catalog: Promise<readonly OneClickToken[]> | undefined;
  const tokens = (signal: AbortSignal): Promise<readonly OneClickToken[]> => {
    if (options.tokenCatalog) return options.tokenCatalog(signal);
    catalog ??= (async () => {
      const rows = await requestJson(options, TOKENS_PATH, signal);
      if (!Array.isArray(rows) || rows.length > 20000) fail('PROVIDER_INVALID_CATALOG');
      const seen = new Set<string>();
      return rows.map(raw => {
        const row = obj(raw);
        const assetId = str(row.assetId, 220);
        if (seen.has(assetId) || !/^[a-z0-9]{2,32}$/.test(str(row.blockchain, 32))) fail('PROVIDER_INVALID_CATALOG');
        seen.add(assetId);
        const contract = row.contractAddress;
        if (contract !== undefined && contract !== null && typeof contract !== 'string') fail('PROVIDER_INVALID_CATALOG');
        return {
          assetId, blockchain: row.blockchain as string, decimals: boundedInteger(row.decimals, 0, 255),
          symbol: str(row.symbol, 64), ...(contract ? { contractAddress: contract } : {}),
        };
      });
    })();
    return catalog;
  };
  return { id: NEAR_INTENTS_ADAPTER_ID, async quote(input) {
    if (input.signal.aborted) fail('CANCELLED');
    const now = clock();
    if (input.leg.adapterId !== NEAR_INTENTS_ADAPTER_ID) fail('PROVIDER_CONTEXT_MISMATCH');
    rawAmount(input.amountRaw, true);
    boundedInteger(input.slippageBps, 0, 10000);
    if (!Number.isSafeInteger(input.deadlineMs) || input.deadlineMs <= now) fail('QUOTE_DEADLINE');
    if (!Number.isSafeInteger(input.transportDeadlineMs) || input.transportDeadlineMs <= now) fail('QUOTE_DEADLINE');
    str(input.sender); str(input.recipient);
    const source = chains.get(input.leg.source.chainId), destination = chains.get(input.leg.destination.chainId);
    if (!source || !destination || source.chainId === destination.chainId) fail('PROVIDER_CHAIN_UNSUPPORTED');
    const listed = pins.has(assetKey(input.leg.source)) && pins.has(assetKey(input.leg.destination))
      ? undefined : await tokens(input.signal);
    if (clock() >= input.deadlineMs || clock() >= input.transportDeadlineMs) fail('QUOTE_DEADLINE');
    const resolve = (asset: Asset, chain: OneClickChain): string => {
      const pinned = pins.get(assetKey(asset));
      if (pinned) return pinned;
      const rows = (listed ?? []).filter(token => token.blockchain === chain.blockchain && token.decimals === asset.decimals
        && typeof token.contractAddress === 'string' && token.contractAddress.length > 0 && addressesEqual(token.contractAddress, asset));
      if (rows.length !== 1) fail('PROVIDER_ASSET_UNSUPPORTED');
      return rows[0]!.assetId;
    };
    const originAsset = resolve(input.leg.source, source);
    const destinationAsset = resolve(input.leg.destination, destination);
    const sent: Record<string, unknown> = {
      dry: true, depositMode: 'SIMPLE', swapType: 'EXACT_INPUT', slippageTolerance: input.slippageBps,
      originAsset, depositType: 'ORIGIN_CHAIN', destinationAsset, amount: input.amountRaw,
      refundTo: input.sender, refundType: 'ORIGIN_CHAIN', recipient: input.recipient, recipientType: 'DESTINATION_CHAIN',
      deadline: new Date(input.deadlineMs).toISOString(), quoteWaitingTimeMs: 0,
    };
    if (options.referral !== undefined) sent.referral = options.referral;
    const raw = obj(await requestJson(options, QUOTE_PATH, input.signal, sent));
    const echo = obj(raw.quoteRequest), quote = obj(raw.quote);
    for (const [key, value] of Object.entries(sent)) if (echo[key] !== value) fail('PROVIDER_REQUEST_MISMATCH');
    let protocolFeeBps = 0;
    for (const key of Object.keys(echo)) {
      if (key in sent) continue;
      const value = echo[key];
      if (value == null || value === '') continue;
      if (key === 'confidentiality') { if (value !== 'public') fail('PROVIDER_UNREVIEWED_ENRICHMENT'); continue; }
      if (key === 'insured') { if (value !== false) fail('PROVIDER_UNREVIEWED_ENRICHMENT'); continue; }
      if (key === 'appFees') { protocolFeeBps = readProtocolFee(value); continue; }
      if (Array.isArray(value) && value.length === 0) continue;
      fail('PROVIDER_UNREVIEWED_ENRICHMENT');
    }
    if (echo.dry !== true) fail('DRY_MODE_REQUIRED');
    for (const key of ['depositAddress', 'depositMemo', 'deadline', 'timeWhenInactive', 'chainDepositAddresses',
      'virtualChainRecipient', 'virtualChainRefundRecipient', 'customRecipientMsg']) {
      if (quote[key] !== undefined && quote[key] !== null) fail('PROVIDER_DRY_RESPONSE_MISMATCH');
    }
    const correlationId = str(raw.correlationId, 128);
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(correlationId)) fail('PROVIDER_INVALID_STRING');
    str(raw.signature, 512);
    const timestamp = Date.parse(str(raw.timestamp, 40));
    if (!Number.isSafeInteger(timestamp) || timestamp < now - 300000 || timestamp > clock() + 5000) fail('PROVIDER_QUOTE_EXPIRED');
    if (quote.amountIn !== input.amountRaw) fail('PROVIDER_INPUT_MISMATCH');
    if (quote.minAmountIn !== undefined && rawAmount(quote.minAmountIn, true) !== input.amountRaw) fail('PROVIDER_INPUT_MISMATCH');
    const expectedOutRaw = rawAmount(quote.amountOut, true);
    const minimumOutRaw = rawAmount(quote.minAmountOut, true);
    if (BigInt(minimumOutRaw) > BigInt(expectedOutRaw)
      || BigInt(minimumOutRaw) < BigInt(expectedOutRaw) * BigInt(10000 - input.slippageBps) / 10000n) fail('PROVIDER_OUTPUT_BOUND');
    const shortfall = usdShortfallBps(quote.amountInUsd, quote.amountOutUsd);
    const amountInUsd = str(quote.amountInUsd, 64), amountOutUsd = str(quote.amountOutUsd, 64);
    let feeBps: number, priceImpactBps: number;
    let economicsBasis: NearIntentsLegQuote['economicsBasis'];
    if (protocolFeeBps > 0) {
      const residual = shortfall > protocolFeeBps ? shortfall - protocolFeeBps : 0;
      if (residual > 10000) fail('PROVIDER_INVALID_ECONOMICS');
      feeBps = protocolFeeBps; priceImpactBps = residual; economicsBasis = 'PROTOCOL_APP_FEE_PLUS_USD_RESIDUAL';
    } else {
      if (shortfall > 10000) fail('PROVIDER_INVALID_ECONOMICS');
      feeBps = shortfall; priceImpactBps = 0; economicsBasis = 'USD_SHORTFALL';
    }
    if (typeof quote.timeEstimate !== 'number' || !Number.isFinite(quote.timeEstimate) || quote.timeEstimate <= 0 || quote.timeEstimate > 604800)
      fail('PROVIDER_INVALID_ESTIMATE');
    const protocolMs = Math.ceil(quote.timeEstimate * 1000);
    const estimatedCompletionMs = protocolMs + (source.sourceConfirmationMs ?? 0) + (destination.destinationVerificationMs ?? 0);
    if (!Number.isSafeInteger(estimatedCompletionMs) || estimatedCompletionMs <= 0) fail('PROVIDER_INVALID_ESTIMATE');
    const expiry = Math.min(now + ttl, input.deadlineMs);
    if (expiry <= clock() || clock() >= input.transportDeadlineMs) fail('PROVIDER_QUOTE_EXPIRED');
    const canonical = nearIntentsQuoteCanonical({
      amountIn: input.amountRaw, amountOut: expectedOutRaw, correlationId,
      destinationAsset, minAmountOut: minimumOutRaw, originAsset,
    });
    const quoteHash = await nearIntentsQuoteHash(canonical);
    if (clock() >= expiry) fail('PROVIDER_QUOTE_EXPIRED');
    const refundFeeRaw = optionalRaw(quote.refundFee), withdrawFeeRaw = optionalRaw(quote.withdrawFee);
    const dryDeposit: DryDepositFlow = Object.freeze({
      mode: 'DRY', spendable: false, depositAddress: null, depositType: 'ORIGIN_CHAIN',
      originAssetId: originAsset, destinationAssetId: destinationAsset, amountInRaw: input.amountRaw, quoteHash,
      steps: Object.freeze([
        Object.freeze({ id: 'quote', state: 'complete', title: 'Dry quote', detail: '1Click accepted dry:true. No swap was opened.' }),
        Object.freeze({ id: 'deposit-address', state: 'withheld', title: 'Deposit address',
          detail: `A live ${source.blockchain} quote would return an origin-chain deposit address. Dry quotes omit it. A response that includes one is rejected.` }),
        Object.freeze({ id: 'send', state: 'blocked', title: 'Send funds', detail: 'Nothing is sent. There is no address to fund.' }),
        Object.freeze({ id: 'audit', state: 'ready', title: 'Audit hash',
          detail: 'This quote hash can be recorded on the NEAR testnet route-audit contract. Recording does not settle the swap.' }),
      ]),
    });
    const leg: NearIntentsLegQuote = {
      capabilityId: input.leg.capabilityId, adapterId: NEAR_INTENTS_ADAPTER_ID,
      source: normalizeAsset(input.leg.source), destination: normalizeAsset(input.leg.destination),
      amountInRaw: input.amountRaw, expectedOutRaw, minimumOutRaw, feeBps, protocolFeeBps, priceImpactBps,
      costDenominator: { source: normalizeAsset(input.leg.source), amountRaw: input.amountRaw },
      estimatedCompletionMs, protocolEstimateMs: protocolMs,
      ...(source.sourceConfirmationMs === undefined || destination.destinationVerificationMs === undefined ? {} : {
        verificationMs: { sourceConfirmationMs: source.sourceConfirmationMs, destinationVerificationMs: destination.destinationVerificationMs } }),
      expiresAtMs: expiry, pricingValidUntilMs: expiry, quoteId: `1click:${quoteHash}`, conditional: true, liquidityConfirmed: true,
      dryQuote: true, quoteHash, correlationId, amountInUsd, amountOutUsd, economicsBasis, dryDeposit,
      ...(refundFeeRaw === undefined ? {} : { refundFeeRaw }), ...(withdrawFeeRaw === undefined ? {} : { withdrawFeeRaw }),
    };
    if (!sameAsset(leg.source, input.leg.source) || !sameAsset(leg.destination, input.leg.destination)) fail('PROVIDER_ASSET_MISMATCH');
    return Object.freeze(leg);
  } };
}
