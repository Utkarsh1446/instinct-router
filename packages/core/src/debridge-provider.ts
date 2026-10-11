import type { Asset, ChainId, LegQuote } from './types.js';
import type { ProviderAdapter } from './router.js';
import type { ProviderFetch } from './provider-adapters.js';
import { boundedInteger, normalizeAsset, rawAmount, sameAsset } from './capabilities.js';
import { QuoteFault } from './scheduler.js';

const ENDPOINT = 'https://dln.debridge.finance/v1.0/dln/order/create-tx';
const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const ZERO = '0x0000000000000000000000000000000000000000';
const SOL_NATIVE = '11111111111111111111111111111111';
const MAX_BYTES = 131072;
export interface DeBridgeOptions {
  fetch: ProviderFetch;
  chains: readonly { chainId: ChainId; debridgeChainId: number }[];
  clock?: () => number;
  /** Local freshness cutoff; DLN estimates have no explicit protocol expiry. */
  pricingTtlMs?: number;
  /** Trusted unmeasured completion policy; absent remains unknown. */
  estimatedCompletionMs?: number;
}
function fail(code: string): never { throw new QuoteFault(code, false); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('PROVIDER_INVALID_RESPONSE');
  return value as Record<string, unknown>;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) fail('PROVIDER_INVALID_ID');
  return value;
}
function solAddress(value: string): void {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) fail('PROVIDER_INVALID_ADDRESS');
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n, size = 0;
  for (const char of value) n = n * 58n + BigInt(alphabet.indexOf(char));
  while (n) { size++; n >>= 8n; }
  if (size + (value.match(/^1*/)?.[0].length ?? 0) !== 32) fail('PROVIDER_INVALID_ADDRESS');
}
function asset(value: Asset): Asset {
  const result = normalizeAsset(value);
  if (result.chainId === SOLANA) {
    solAddress(result.address);
    if (result.address === SOL_NATIVE && result.decimals !== 9) fail('PROVIDER_ASSET_MISMATCH');
  } else if (!result.chainId.startsWith('eip155:')) fail('PROVIDER_CHAIN_UNSUPPORTED');
  else if (result.address === ZERO && result.decimals !== 18) fail('PROVIDER_ASSET_MISMATCH');
  return result;
}
function wallet(value: string, token: Asset): void {
  const normalized = normalizeAsset({ ...token, address: value });
  if (token.chainId === SOLANA) solAddress(normalized.address);
  if (normalized.address === ZERO || normalized.address === SOL_NATIVE) fail('PROVIDER_INVALID_WALLET');
}
function echoedToken(value: unknown, expected: Asset, id: number): Record<string, unknown> {
  const row = object(value);
  if (row.chainId !== id || !sameAsset(asset({ chainId: expected.chainId, address: row.address as string,
      decimals: boundedInteger(row.decimals, 0, 255) }), expected)) fail('PROVIDER_ASSET_MISMATCH');
  return row;
}
function parse(text: string): unknown {
  let position = 0, nodes = 0;
  const whitespace = () => { while (/[\t\n\r ]/.test(text[position] ?? '\0')) position++; };
  const string = (): string => {
    if (text[position] !== '"') fail('PROVIDER_INVALID_JSON');
    const start = position++;
    while (position < text.length) {
      const char = text[position++];
      if (char === '"') return JSON.parse(text.slice(start, position)) as string;
      if (char === '\\') position++;
    }
    fail('PROVIDER_INVALID_JSON');
  };
  const value = (depth: number): void => {
    if (++nodes > 4096 || depth > 12) fail('PROVIDER_INVALID_JSON');
    whitespace(); const char = text[position];
    if (char === '{' || char === '[') {
      const isObject = char === '{', closing = isObject ? '}' : ']';
      const keys = new Set<string>(); position++; whitespace();
      if (text[position] === closing) { position++; return; }
      while (position < text.length) {
        if (isObject) {
          whitespace(); const key = string();
          if (keys.has(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) fail('PROVIDER_INVALID_JSON');
          keys.add(key); whitespace(); if (text[position++] !== ':') fail('PROVIDER_INVALID_JSON');
        }
        value(depth + 1); whitespace();
        if (text[position] === closing) { position++; return; }
        if (text[position++] !== ',') fail('PROVIDER_INVALID_JSON');
      }
      fail('PROVIDER_INVALID_JSON');
    }
    if (char === '"') { string(); return; }
    const match = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(position));
    if (!match) fail('PROVIDER_INVALID_JSON'); position += match[0].length;
  };
  value(0); whitespace(); if (position !== text.length) fail('PROVIDER_INVALID_JSON');
  return JSON.parse(text);
}
async function read(response: Response, url: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (signal.aborted) { await response.body?.cancel(); fail('CANCELLED'); }
  if (response.redirected || response.url && response.url !== url) { await response.body?.cancel(); fail('PROVIDER_REDIRECT'); }
  if (!response.ok) {
    await response.body?.cancel();
    throw new QuoteFault(response.status === 429 ? 'PROVIDER_RATE_LIMIT' : 'PROVIDER_HTTP_ERROR', response.status === 429 || response.status >= 500);
  }
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') { await response.body?.cancel(); fail('PROVIDER_INVALID_JSON'); }
  const length = response.headers.get('content-length');
  if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > MAX_BYTES)) {
    await response.body?.cancel(); fail('PROVIDER_RESPONSE_TOO_LARGE');
  }
  if (!response.body) fail('PROVIDER_INVALID_RESPONSE');
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const row = await reader.read();
      if (signal.aborted) fail('CANCELLED');
      if (row.done) break;
      size += row.value.length;
      if (size > MAX_BYTES) fail('PROVIDER_RESPONSE_TOO_LARGE');
      if (chunks.length >= 2048) fail('PROVIDER_RESPONSE_TOO_FRAGMENTED');
      chunks.push(row.value);
    }
  } finally { signal.removeEventListener('abort', cancel); await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let parsed: unknown;
  try { parsed = parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('PROVIDER_INVALID_JSON'); }
  let nodes = 0;
  const inspect = (value: unknown, depth: number): void => {
    if (++nodes > 4096 || depth > 12 || typeof value === 'number' && !Number.isFinite(value)) fail('PROVIDER_INVALID_JSON');
    if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('PROVIDER_INVALID_JSON');
      inspect(child, depth + 1);
    }
  };
  inspect(parsed, 0); return object(parsed);
}


/** Public estimation only: omit ALL construction recipient/authority/sender fields.
 * https://docs.debridge.com/dln-details/integration-guidelines/order-creation/creating-order/api-parameters/api-parameters
 * Returned tx/order artifacts grant no authority and are never retained or returned. */
export function createDeBridgeAdapter(options: DeBridgeOptions): ProviderAdapter {
  if (!options || typeof options.fetch !== 'function' || options.clock !== undefined && typeof options.clock !== 'function' ||
      !Array.isArray(options.chains) || !options.chains.length || options.chains.length > 64) fail('INVALID_PROVIDER_CONFIG');
  const chains = new Map<ChainId, number>(), ids = new Set<number>();
  for (const row of options.chains) {
    const id = boundedInteger(row.debridgeChainId, 1, Number.MAX_SAFE_INTEGER, 'INVALID_PROVIDER_CONFIG');
    if (chains.has(row.chainId) || ids.has(id) ||
        (row.chainId === SOLANA ? id !== 7565164 : !/^eip155:[1-9][0-9]*$/.test(row.chainId) || String(id) !== row.chainId.slice(7)))
      fail('INVALID_PROVIDER_CONFIG');
    chains.set(row.chainId, id); ids.add(id);
  }
  const clock = options.clock ?? Date.now;
  const ttl = boundedInteger(options.pricingTtlMs ?? 15000, 1, 60000, 'INVALID_PROVIDER_CONFIG');
  const completion = options.estimatedCompletionMs === undefined ? null : boundedInteger(options.estimatedCompletionMs, 1, 604800000, 'INVALID_PROVIDER_CONFIG');
  return { id: 'debridge', async quote(input): Promise<LegQuote> {
    const ctx = { ...input, request: structuredClone(input.request), leg: structuredClone(input.leg) };
    const started = boundedInteger(clock(), 0, Number.MAX_SAFE_INTEGER, 'INVALID_CLOCK');
    if (ctx.signal.aborted) fail('CANCELLED');
    const source = asset(ctx.leg.source), destination = asset(ctx.leg.destination);
    if (ctx.leg.adapterId !== 'debridge' || !['BRIDGE', 'SWAP_BRIDGE'].includes(ctx.leg.kind) ||
        ctx.leg.index !== 0 || source.chainId === destination.chainId ||
        !sameAsset(source, ctx.request.source) || !sameAsset(destination, ctx.request.destination) ||
        ctx.sender !== ctx.request.sender || ctx.recipient !== ctx.request.recipient || ctx.amountRaw !== ctx.request.amountRaw ||
        ctx.slippageBps !== ctx.request.slippageBps || ctx.deadlineMs > ctx.request.deadlineMs) fail('PROVIDER_CONTEXT_MISMATCH');
    wallet(ctx.sender, source); wallet(ctx.recipient, destination);
    identifier(ctx.request.requestId); identifier(ctx.leg.capabilityId);
    rawAmount(ctx.amountRaw, true); boundedInteger(ctx.slippageBps, 0, 10000);
    const from = chains.get(source.chainId), to = chains.get(destination.chainId);
    if (from === undefined || to === undefined) fail('PROVIDER_CHAIN_UNSUPPORTED');
    boundedInteger(ctx.deadlineMs, 0, Number.MAX_SAFE_INTEGER); boundedInteger(ctx.transportDeadlineMs, 0, Number.MAX_SAFE_INTEGER);
    const deadline = Math.min(ctx.deadlineMs, ctx.transportDeadlineMs);
    if (started >= deadline) fail('QUOTE_DEADLINE');
    const controller = new AbortController(), abort = () => controller.abort();
    ctx.signal.addEventListener('abort', abort, { once: true });
    const monotonicDeadline = performance.now() + deadline - started;
    const timer = setTimeout(abort, deadline - started);
    const gate = () => {
      if (ctx.signal.aborted) fail('CANCELLED');
      if (controller.signal.aborted || clock() >= deadline || performance.now() >= monotonicDeadline) fail('QUOTE_DEADLINE');
    };
    const url = new URL(ENDPOINT);
    url.search = new URLSearchParams({ srcChainId: String(from), srcChainTokenIn: source.address,
      srcChainTokenInAmount: ctx.amountRaw, dstChainId: String(to), dstChainTokenOut: destination.address,
      dstChainTokenOutAmount: 'auto', prependOperatingExpenses: 'false' }).toString();
    let response: Response | undefined;
    try {
      gate();
      response = await options.fetch(url.href, { method: 'GET', redirect: 'error', signal: controller.signal, headers: { accept: 'application/json' } });
      gate(); const raw = await read(response, url.href, controller.signal); gate();
      if (raw.errorCode !== undefined || raw.errorId !== undefined || raw.error !== undefined) fail('PROVIDER_QUOTE_REJECTED');
      const estimation = object(raw.estimation);
      if (estimation.recommendedSlippage !== undefined && (typeof estimation.recommendedSlippage !== 'number' ||
          !Number.isFinite(estimation.recommendedSlippage) || estimation.recommendedSlippage < 0 || estimation.recommendedSlippage > 100)) fail('PROVIDER_INVALID_SLIPPAGE');
      const inToken = echoedToken(estimation.srcChainTokenIn, source, from);
      const outToken = echoedToken(estimation.dstChainTokenOut, destination, to);
      if (inToken.amount !== ctx.amountRaw || inToken.mutatedWithOperatingExpense !== false) fail('PROVIDER_INPUT_MISMATCH');
      const expected = rawAmount(outToken.amount, true), minimum = rawAmount(outToken.recommendedAmount, true);
      if (BigInt(minimum) > BigInt(expected) || BigInt(minimum) < BigInt(expected) * BigInt(10000 - ctx.slippageBps) / 10000n)
        fail('PROVIDER_OUTPUT_BOUND');
      if (outToken.maxTheoreticalAmount !== undefined && BigInt(rawAmount(outToken.maxTheoreticalAmount, true)) < BigInt(expected)) fail('PROVIDER_OUTPUT_BOUND');
      // Recommended amount is a market estimate, NOT a signed/contract-enforced floor.
      // Gas, rent, total fees and impact cannot be proven by partial costsDetails.
      const evidence = { requestId: ctx.request.requestId, source, destination, sender: ctx.sender, recipient: ctx.recipient,
        amountRaw: ctx.amountRaw, slippageBps: ctx.slippageBps, expected, minimum };
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(evidence))));
      gate(); const expiresAtMs = Math.min(started + ttl, ctx.deadlineMs);
      if (clock() >= expiresAtMs) fail('PROVIDER_QUOTE_EXPIRED');
      return Object.freeze({ adapterId: 'debridge', capabilityId: ctx.leg.capabilityId, source, destination,
        amountInRaw: ctx.amountRaw, expectedOutRaw: expected, minimumOutRaw: minimum, feeBps: null, priceImpactBps: null,
        costDenominator: { source, amountRaw: ctx.amountRaw }, estimatedCompletionMs: completion, protocolEstimateMs: null,
        expiresAtMs, pricingValidUntilMs: expiresAtMs,
        quoteId: 'debridge:preview:' + [...digest].map(byte => byte.toString(16).padStart(2, '0')).join(''), conditional: true, liquidityConfirmed: true });
    } catch (error) {
      if (ctx.signal.aborted) fail('CANCELLED');
      if (controller.signal.aborted || clock() >= deadline || performance.now() >= monotonicDeadline) fail('QUOTE_DEADLINE');
      if (error instanceof QuoteFault) throw error;
      fail('PROVIDER_FETCH_OR_PARSE_FAILED');
    } finally {
      clearTimeout(timer); ctx.signal.removeEventListener('abort', abort);
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    }
  } };
}
