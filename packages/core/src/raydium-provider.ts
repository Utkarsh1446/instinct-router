import type { ProviderAdapter, QuoteContext } from './router.js';
import type { LegQuote } from './types.js';
import type { ProviderFetch } from './provider-adapters.js';
import { boundedInteger, normalizeAsset, rawAmount, sameAsset } from './capabilities.js';
import { QuoteFault } from './scheduler.js';

const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const NATIVE = '11111111111111111111111111111111';
const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const ENDPOINT = 'https://transaction-v1.raydium.io/compute/swap-base-in';
const MAX_BYTES = 131072;

export interface RaydiumOptions {
  fetch: ProviderFetch;
  clock?: () => number;
  /** Local pricing snapshot lifetime, not an on-chain/provider expiry promise. */
  pricingTtlMs?: number;
  /** Trusted unmeasured one-chain completion policy; absent means unknown. */
  estimatedCompletionMs?: number;
}
function fail(code: string): never { throw new QuoteFault(code, false); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('PROVIDER_INVALID_RESPONSE');
  return value as Record<string, unknown>;
}
function mint(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) fail('PROVIDER_INVALID_MINT');
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const char of value) n = n * 58n + BigInt(alphabet.indexOf(char));
  let bytes = 0;
  while (n) { bytes++; n >>= 8n; }
  if (bytes + (value.match(/^1*/)?.[0].length ?? 0) !== 32) fail('PROVIDER_INVALID_MINT');
  return value;
}
function token(value: QuoteContext['leg']['source']): string {
  const asset = normalizeAsset(value);
  if (asset.chainId !== SOLANA) fail('PROVIDER_CHAIN_UNSUPPORTED');
  const address = mint(asset.address);
  if ((address === NATIVE || address === WSOL) && asset.decimals !== 9 || address === USDC && asset.decimals !== 6)
    fail('PROVIDER_ASSET_MISMATCH');
  return address === NATIVE ? WSOL : address;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) fail('PROVIDER_INVALID_ID');
  return value;
}
/** The API reports percentage units: 0.05 percent is 5 bps. Round risk upward. */
function impact(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) fail('PROVIDER_INVALID_ECONOMICS');
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(value));
  if (!match) fail('PROVIDER_INVALID_ECONOMICS');
  const fraction = match[2] ?? '', exponent = Number(match[3] ?? 0);
  const digits = BigInt(match[1]! + fraction), scale = fraction.length - exponent;
  if (scale < 0) return boundedInteger(Number(digits * 100n * 10n ** BigInt(-scale)), 0, 10000);
  const denominator = 10n ** BigInt(scale);
  return boundedInteger(Number((digits * 100n + denominator - 1n) / denominator), 0, 10000);
}
function context(ctx: QuoteContext, now: number): { inputMint: string; outputMint: string } {
  boundedInteger(now, 0, Number.MAX_SAFE_INTEGER, 'INVALID_CLOCK');
  if (ctx.signal.aborted) fail('CANCELLED');
  if (ctx.leg.adapterId !== 'raydium' || ctx.leg.kind !== 'SWAP' ||
      ctx.leg.index === 0 && (!sameAsset(ctx.leg.source, ctx.request.source) || ctx.amountRaw !== ctx.request.amountRaw) ||
      ctx.slippageBps > ctx.request.slippageBps || ctx.deadlineMs > ctx.request.deadlineMs) fail('PROVIDER_CONTEXT_MISMATCH');
  if (!Number.isSafeInteger(ctx.deadlineMs) || !Number.isSafeInteger(ctx.transportDeadlineMs) ||
      now >= Math.min(ctx.deadlineMs, ctx.transportDeadlineMs)) fail('QUOTE_DEADLINE');
  rawAmount(ctx.amountRaw, true); boundedInteger(ctx.slippageBps, 0, 10000);
  boundedInteger(ctx.request.slippageBps, 0, 10000);
  identifier(ctx.request.requestId); identifier(ctx.leg.capabilityId);
  if (mint(ctx.sender) === NATIVE || mint(ctx.recipient) === NATIVE) fail('PROVIDER_INVALID_WALLET');
  if (ctx.request.source.chainId === SOLANA && ctx.request.destination.chainId === SOLANA &&
      (ctx.sender !== ctx.request.sender || ctx.recipient !== ctx.request.recipient)) fail('PROVIDER_IDENTITY_MISMATCH');
  const inputMint = token(ctx.leg.source), outputMint = token(ctx.leg.destination);
  if (inputMint === outputMint) fail('PROVIDER_IDENTICAL_MINT');
  return { inputMint, outputMint };
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

/** Independent Solana DEX pricing only. This never calls transaction/build endpoints. */
export function createRaydiumAdapter(options: RaydiumOptions): ProviderAdapter {
  if (!options || typeof options.fetch !== 'function' || options.clock !== undefined && typeof options.clock !== 'function') fail('INVALID_PROVIDER_CONFIG');
  const clock = options.clock ?? Date.now;
  const ttl = boundedInteger(options.pricingTtlMs ?? 15000, 1, 30000, 'INVALID_PROVIDER_CONFIG');
  const completion = options.estimatedCompletionMs === undefined ? null : boundedInteger(options.estimatedCompletionMs, 0, 604800000, 'INVALID_PROVIDER_CONFIG');
  return { id: 'raydium', async quote(input): Promise<LegQuote> {
    const ctx = { ...input, request: structuredClone(input.request), leg: structuredClone(input.leg) };
    const started = clock(), binding = context(ctx, started);
    const deadline = Math.min(ctx.deadlineMs, ctx.transportDeadlineMs);
    const controller = new AbortController();
    const abort = () => controller.abort('cancelled');
    ctx.signal.addEventListener('abort', abort, { once: true });
    const monotonicDeadline = performance.now() + deadline - started;
    const timer = setTimeout(() => controller.abort('deadline'), deadline - started);
    const gate = () => {
      if (ctx.signal.aborted) fail('CANCELLED');
      if (controller.signal.aborted || clock() >= deadline || performance.now() >= monotonicDeadline) fail('QUOTE_DEADLINE');
    };
    const url = new URL(ENDPOINT);
    url.search = new URLSearchParams({ ...binding, amount: ctx.amountRaw, slippageBps: String(ctx.slippageBps), txVersion: 'V0' }).toString();
    let response: Response | undefined;
    try {
      response = await options.fetch(url.href, { method: 'GET', redirect: 'error', signal: controller.signal, headers: { accept: 'application/json' } });
      gate();
      const raw = await read(response, url.href, controller.signal); gate();
      if (raw.success !== true) {
        if (raw.success === false && raw.msg === 'ROUTE_NOT_FOUND') fail('PROVIDER_NO_ROUTE');
        fail('PROVIDER_QUOTE_REJECTED');
      }
      const id = identifier(raw.id);
      if (raw.version !== 'V1') fail('PROVIDER_INVALID_RESPONSE');
      const data = object(raw.data);
      if (data.swapType !== 'BaseIn' || data.inputMint !== binding.inputMint || data.outputMint !== binding.outputMint ||
          data.inputAmount !== ctx.amountRaw || data.slippageBps !== ctx.slippageBps ||
          data.actualInputAmount !== undefined && data.actualInputAmount !== ctx.amountRaw) fail('PROVIDER_ASSET_MISMATCH');
      const expected = rawAmount(data.outputAmount, true), minimum = rawAmount(data.otherAmountThreshold, true);
      if (BigInt(minimum) > BigInt(expected) || BigInt(minimum) < BigInt(expected) * BigInt(10000 - ctx.slippageBps) / 10000n)
        fail('PROVIDER_OUTPUT_BOUND');
      if (!Array.isArray(data.routePlan) || !data.routePlan.length || data.routePlan.length > 8) fail('PROVIDER_INVALID_ROUTE');
      let previous = binding.inputMint;
      for (const rawHop of data.routePlan) {
        const hop = object(rawHop);
        mint(hop.poolId);
        if (mint(hop.inputMint) !== previous || hop.inputMint === hop.outputMint) fail('PROVIDER_INVALID_ROUTE');
        previous = mint(hop.outputMint);
        if (![hop.inputMint, hop.outputMint].includes(mint(hop.feeMint))) fail('PROVIDER_INVALID_ECONOMICS');
        boundedInteger(hop.feeRate, 0, 10000, 'PROVIDER_INVALID_ECONOMICS'); rawAmount(hop.feeAmount);
        if (hop.remainingAccounts !== undefined && (!Array.isArray(hop.remainingAccounts) || hop.remainingAccounts.length > 64)) fail('PROVIDER_INVALID_ROUTE');
        for (const account of (hop.remainingAccounts ?? []) as unknown[]) mint(account);
      }
      if (previous !== binding.outputMint) fail('PROVIDER_INVALID_ROUTE');
      if (data.referrerAmount !== undefined && rawAmount(data.referrerAmount) !== '0') fail('PROVIDER_INVALID_ECONOMICS');
      const priceImpactBps = impact(data.priceImpactPct);
      // Compute does not verify wallets, mint decimals, network fees or rent. The host
      // verifies token metadata; local identity binding grants no execution authority.
      const evidence = { id, requestId: ctx.request.requestId, ...binding, source: ctx.leg.source, destination: ctx.leg.destination,
        sender: ctx.sender, recipient: ctx.recipient, amountRaw: ctx.amountRaw, slippageBps: ctx.slippageBps, expected, minimum, priceImpactBps };
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(evidence))));
      gate();
      const expiresAtMs = Math.min(started + ttl, ctx.deadlineMs);
      if (clock() >= expiresAtMs) fail('PROVIDER_QUOTE_EXPIRED');
      return Object.freeze({ adapterId: 'raydium', capabilityId: ctx.leg.capabilityId,
        source: normalizeAsset(ctx.leg.source), destination: normalizeAsset(ctx.leg.destination), amountInRaw: ctx.amountRaw,
        expectedOutRaw: expected, minimumOutRaw: minimum, feeBps: null, priceImpactBps,
        costDenominator: { source: normalizeAsset(ctx.leg.source), amountRaw: ctx.amountRaw },
        estimatedCompletionMs: completion, protocolEstimateMs: null, expiresAtMs, pricingValidUntilMs: expiresAtMs,
        quoteId: 'raydium:preview:' + [...digest].map(byte => byte.toString(16).padStart(2, '0')).join(''),
        conditional: true, liquidityConfirmed: true });
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
