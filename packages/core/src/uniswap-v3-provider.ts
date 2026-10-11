import type { Asset, LegQuote } from './types.js';
import type { ProviderAdapter, QuoteContext, PreparationContext, PreparedQuote } from './router.js';
import { boundedInteger, normalizeAsset, rawAmount, sameAsset } from './capabilities.js';
import { QuoteFault } from './scheduler.js';
import { MULTICALL3_ADDRESS, MULTICALL3_RUNTIME, encodeAggregate3, decodeAggregate3, isSolidityRevert } from './multicall3.js';

/** Official Base deployment pins; callers cannot substitute endpoints/contracts. */
export const BASE_V3 = Object.freeze({
  chainId: 'eip155:8453' as const, rpc: 'https://mainnet.base.org',
  factory: '0x33128a8fc17869897dce68ed026d694621f6fdfd',
  quoter: '0x3d4e44eb1374240ce5f1b871ab261cd16335b76a',
  weth: '0x4200000000000000000000000000000000000006',
  usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  native: '0x0000000000000000000000000000000000000000',
});
const TIERS = [100, 200, 300, 400, 500, 3000, 10000] as const;
const SELECTOR = { pool: '1698ee82', quote: 'c6a5026a', decimals: '313ce567' };
const MAX_BODY = 65536;
export interface UniswapV3Options {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  clock?: () => number;
  feeTiers?: readonly number[];
  pricingTtlMs?: number;
  /** Trusted configured full completion estimate, never inferred from quote RTT. */
  estimatedCompletionMs?: number;
}
export interface UniswapV3LegQuote extends LegQuote {
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly poolAddress: string;
  /** Millionths, not bps. LP fee already reflected in expectedOutRaw. */
  readonly poolFeePips: number;
  readonly simulatedSwapGasUnits: string;
  readonly initializedTicksCrossed: number;
  readonly sqrtPriceX96After: string;
  readonly pricingBasis: 'PINNED_BLOCK_V3_POOL_SIMULATION';
}
function fail(code: string): never { throw new QuoteFault(code, false); }
function word(value: bigint | string): string {
  return (typeof value === 'bigint' ? value.toString(16) : value.slice(2)).padStart(64, '0');
}
function words(value: unknown, count: number): bigint[] {
  if (typeof value !== 'string' || !new RegExp(`^0x[0-9a-fA-F]{${count * 64}}$`).test(value)) fail('V3_INVALID_ABI');
  return Array.from({ length: count }, (_, i) => BigInt('0x' + value.slice(2 + i * 64, 66 + i * 64)));
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('V3_INVALID_RPC');
  return value as Record<string, unknown>;
}
/** Reject duplicate decoded keys before JSON.parse can erase ambiguity. */
function parse(text: string): unknown {
  const stack: (Set<string> | null)[] = [];
  const tokens = /"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|[{}\[\]]/g;
  for (const match of text.matchAll(tokens)) {
    const token = match[0];
    if (token === '{' || token === '[') {
      if (stack.length >= 16) fail('V3_INVALID_JSON');
      stack.push(token === '{' ? new Set() : null);
    } else if (token === '}' || token === ']') stack.pop();
    else if (/^\s*:/.test(text.slice(match.index! + token.length))) {
      const key = JSON.parse(token), keys = stack[stack.length - 1];
      if (!keys || keys.has(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) fail('V3_INVALID_JSON');
      keys.add(key);
    }
  }
  try { return JSON.parse(text); } catch { fail('V3_INVALID_JSON'); }
}
interface Call { method: 'eth_chainId' | 'eth_getBlockByNumber' | 'eth_getCode' | 'eth_call'; params: unknown[] }
interface RpcResult { result?: unknown; executionReverted?: true; revertData?: string }
async function rpc(options: UniswapV3Options, calls: Call[], signal: AbortSignal, serial: number): Promise<RpcResult[]> {
  if (signal.aborted) fail('CANCELLED');
  const batch = calls.map((call, i) => ({ jsonrpc: '2.0', id: `v3-${serial}-${i}`, ...call }));
  let response: Response | undefined;
  try {
    response = await options.fetch(BASE_V3.rpc, { method: 'POST', redirect: 'error', credentials: 'omit', signal,
      headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(batch) });
    if (signal.aborted) fail('CANCELLED');
    if (response.redirected || response.url && response.url !== BASE_V3.rpc && response.url !== BASE_V3.rpc + '/') fail('V3_REDIRECT');
    if (!response.ok) throw new QuoteFault(response.status === 429 ? 'V3_RATE_LIMIT' : 'V3_HTTP_ERROR', response.status === 429 || response.status >= 500);
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY)) fail('V3_RESPONSE_TOO_LARGE');
    if (!response.body?.getReader) fail('V3_INVALID_RESPONSE');
    const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
    let text = '', bytes = 0, chunks = 0;
    const cancel = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      while (true) {
        if (signal.aborted) fail('CANCELLED');
        const part = await reader.read();
        if (signal.aborted) fail('CANCELLED');
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MAX_BODY || ++chunks > 1024) fail('V3_RESPONSE_TOO_LARGE');
        text += decoder.decode(part.value, { stream: true });
        if (chunks % 64 === 0) await new Promise(resolve => setTimeout(resolve, 0));
      }
      text += decoder.decode();
    } finally { signal.removeEventListener('abort', cancel); void reader.cancel().catch(() => {}); reader.releaseLock(); }
    const raw = parse(text);
    if (!Array.isArray(raw) || raw.length !== batch.length) fail('V3_INVALID_RPC');
    const results = new Map<string, RpcResult>();
    for (const item of raw) {
      const row = object(item);
      if (row.jsonrpc !== '2.0' || typeof row.id !== 'string' || !batch.some(call => call.id === row.id) || results.has(row.id)) fail('V3_RPC_BINDING');
      if (Object.hasOwn(row, 'result') === Object.hasOwn(row, 'error')) fail('V3_INVALID_RPC');
      if (Object.hasOwn(row, 'error')) {
        const error = object(row.error);
        if (!Number.isSafeInteger(error.code) || typeof error.message !== 'string' || error.message.length > 512) fail('V3_INVALID_RPC');
        const request = calls[batch.findIndex(call => call.id === row.id)]!;
        const payload = request.params[0] as { to?: string; data?: string } | undefined;
        const poolQuote = request.method === 'eth_call' && payload?.to === BASE_V3.quoter && payload.data?.startsWith('0x' + SELECTOR.quote);
        const revertData = !Object.hasOwn(error, 'data') || typeof error.data === 'string' && /^0x(?:[0-9a-fA-F]{2}){0,4096}$/.test(error.data);
        const explicitRevert = (error.code === 3 || error.code === -32000) &&
          /^execution reverted(?:: [^\x00-\x1f\x7f]{1,240})?$/.test(error.message) && revertData;
        // Only a recognized Quoter simulation revert means unusable pool liquidity.
        // A transient failure could conceal the best pool; never publish a partial comparison.
        if (!poolQuote || !explicitRevert) throw new QuoteFault('V3_RPC_UNAVAILABLE', true);
        results.set(row.id, { executionReverted: true, revertData: typeof error.data === 'string' ? error.data.toLowerCase() : '0x' }); // Never surface upstream messages/data.
      } else results.set(row.id, { result: row.result });
    }
    return batch.map(call => results.get(call.id)!);
  } catch (error) {
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
    if (signal.aborted) fail('CANCELLED');
    if (error instanceof QuoteFault) throw error;
    throw new QuoteFault('V3_RPC_UNAVAILABLE');
  }
}
function call(to: string, data: string, block: { blockHash: string; requireCanonical: true }): Call {
  return { method: 'eth_call', params: [{ to, data: '0x' + data, gas: '0x4c4b40' }, block] };
}
function token(asset: Asset): string {
  if (asset.chainId !== BASE_V3.chainId) fail('V3_CHAIN_UNSUPPORTED');
  return asset.address === BASE_V3.native ? BASE_V3.weth : asset.address;
}
export function createUniswapV3Adapter(input: UniswapV3Options): ProviderAdapter {
  const options = { ...input }, clock = options.clock ?? Date.now;
  if (typeof options.fetch !== 'function' || typeof clock !== 'function') fail('V3_INVALID_CONFIG');
  const tiers = [...(options.feeTiers ?? TIERS)];
  if (!tiers.length || tiers.length > TIERS.length || new Set(tiers).size !== tiers.length || tiers.some(fee => !(TIERS as readonly number[]).includes(fee))) fail('V3_INVALID_CONFIG');
  const ttl = boundedInteger(options.pricingTtlMs ?? 5000, 1, 10000, 'V3_INVALID_CONFIG');
  if (options.estimatedCompletionMs !== undefined) boundedInteger(options.estimatedCompletionMs, 1, 604800000, 'V3_INVALID_CONFIG');
  let serial = 0;
  interface Header { number: string; hash: string; blockMs: number; started: number }
  interface Preparation { header: Header; refreshed?: Promise<Header> }
  const validateContext = (ctx: PreparationContext, started: number) => {
    if (ctx.signal.aborted) fail('CANCELLED');
    if (ctx.leg.adapterId !== 'uniswap-v3' || ctx.leg.kind !== 'SWAP' || ctx.leg.index === 0 && !sameAsset(ctx.leg.source, ctx.request.source)) fail('V3_CONTEXT_MISMATCH');
    const source = normalizeAsset(ctx.leg.source), destination = normalizeAsset(ctx.leg.destination);
    const tokenIn = token(source), tokenOut = token(destination);
    if (tokenIn === tokenOut) fail('V3_IDENTICAL_TOKENS');
    boundedInteger(ctx.slippageBps, 0, 10000, 'V3_INVALID_SLIPPAGE');
    for (const owner of [ctx.sender, ctx.recipient]) if (!/^0x[0-9a-fA-F]{40}$/.test(owner) || /^0x0{40}$/i.test(owner)) fail('V3_INVALID_OWNER');
    for (const deadline of [ctx.deadlineMs, ctx.transportDeadlineMs]) if (!Number.isSafeInteger(deadline) || deadline <= started) fail('V3_QUOTE_DEADLINE');
    return { source, destination, tokenIn, tokenOut };
  };
  const binding = (ctx: PreparationContext) => JSON.stringify([ctx.request, ctx.leg, ctx.sender, ctx.recipient,
    ctx.slippageBps, ctx.deadlineMs, ctx.transportDeadlineMs]);
  const readHeader = async (signal: AbortSignal, started: number): Promise<Header> => {
    const network = await rpc(options, [{ method: 'eth_chainId', params: [] }, { method: 'eth_getBlockByNumber', params: ['latest', false] }], signal, ++serial);
    if (network[0]!.result !== '0x2105') fail('V3_CHAIN_MISMATCH');
    const header = object(network[1]!.result), number = header.number, hash = header.hash, timestamp = header.timestamp;
    if (typeof number !== 'string' || !/^0x[1-9a-f][0-9a-f]{0,15}$/.test(number) ||
      typeof hash !== 'string' || !/^0x[0-9a-f]{64}$/.test(hash) || /^0x0{64}$/.test(hash) ||
      typeof timestamp !== 'string' || !/^0x[1-9a-f][0-9a-f]{0,11}$/.test(timestamp)) fail('V3_INVALID_BLOCK');
    const blockMs = Number(BigInt(timestamp)) * 1000;
    const observed = boundedInteger(clock(), 0, Number.MAX_SAFE_INTEGER, 'V3_INVALID_CLOCK');
    if (observed < started || !Number.isSafeInteger(blockMs) || blockMs > observed + 2000 || observed - blockMs > 12000) fail('V3_STALE_BLOCK');
    return Object.freeze({ number, hash, blockMs, started });
  };
  const guarded = async <T>(ctx: PreparationContext, started: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    let timedOut = false;
    const cancel = () => controller.abort();
    ctx.signal.addEventListener('abort', cancel, { once: true });
    if (ctx.signal.aborted) controller.abort();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.min(30000, ctx.transportDeadlineMs - started, ctx.deadlineMs - started));
    try {
      const result = await run(controller.signal);
      const now = boundedInteger(clock(), 0, Number.MAX_SAFE_INTEGER, 'V3_INVALID_CLOCK');
      if (timedOut || now < started || now >= ctx.transportDeadlineMs || now >= ctx.deadlineMs) fail('V3_QUOTE_DEADLINE');
      if (controller.signal.aborted) fail('CANCELLED');
      return result;
    } catch (error) { if (timedOut) fail('V3_QUOTE_DEADLINE'); throw error; }
    finally { clearTimeout(timer); ctx.signal.removeEventListener('abort', cancel); }
  };
  const quote = async (inputContext: QuoteContext, prepared?: Preparation): Promise<UniswapV3LegQuote> => {
    const ctx: QuoteContext = { ...inputContext, request: structuredClone(inputContext.request), leg: structuredClone(inputContext.leg) };
    const started = boundedInteger(clock(), 0, Number.MAX_SAFE_INTEGER, 'V3_INVALID_CLOCK');
    const { source, destination, tokenIn, tokenOut } = validateContext(ctx, started);
    const amount = BigInt(rawAmount(ctx.amountRaw, true));
    if (amount >= 1n << 255n) fail('V3_AMOUNT_UNSUPPORTED');
    return guarded(ctx, started, async signal => {
      let header: Header;
      if (!prepared) header = await readHeader(signal, started);
      else {
        header = prepared.header;
        if (started < header.started) fail('V3_INVALID_CLOCK');
        if (started >= Math.min(header.started + ttl, header.blockMs + 12000)) {
          if (!prepared.refreshed) {
            prepared.refreshed = readHeader(signal, started);
            prepared.refreshed.catch(() => {});
          }
          header = await prepared.refreshed;
          if (started >= Math.min(header.started + ttl, header.blockMs + 12000)) fail('V3_QUOTE_DEADLINE');
        }
      }
      const { number, hash } = header;
      const block = { blockHash: hash, requireCanonical: true as const };
      const reads = [call(tokenIn, SELECTOR.decimals, block), call(tokenOut, SELECTOR.decimals, block),
        ...tiers.map(fee => call(BASE_V3.factory, SELECTOR.pool + word(tokenIn) + word(tokenOut) + word(BigInt(fee)), block)),
        ...tiers.map(fee => call(BASE_V3.quoter, SELECTOR.quote + word(tokenIn) + word(tokenOut) + word(amount) + word(BigInt(fee)) + word(0n), block))];
      let discovered: RpcResult[];
      if (tokenIn === BASE_V3.weth && tokenOut === BASE_V3.usdc || tokenIn === BASE_V3.usdc && tokenOut === BASE_V3.weth) {
        // aggregate3 uses CALL. Only these pinned tokens' decimals are read-only;
        // factory getters are pure reads and Quoter swap effects revert internally.
        // Arbitrary ERC20 calls stay isolated so simulated mutations cannot leak.
        const data = encodeAggregate3(reads.map(read => {
          const payload = read.params[0] as { to: string; data: string };
          return { target: payload.to, data: payload.data, allowFailure: payload.to === BASE_V3.quoter };
        }));
        const response = await rpc(options, [{ method: 'eth_getCode', params: [MULTICALL3_ADDRESS, block] },
          call(MULTICALL3_ADDRESS, data.slice(2), block)], signal, ++serial);
        if (response[0]!.result !== MULTICALL3_RUNTIME) fail('V3_MULTICALL_CODE_MISMATCH');
        discovered = decodeAggregate3(response[1]!.result, reads.length).map((result, index) => {
          if (result.success) return { result: result.data };
          if (index < 2 + tiers.length) throw new QuoteFault('V3_RPC_UNAVAILABLE', true);
          return { executionReverted: true, revertData: result.data };
        });
      } else discovered = await rpc(options, reads, signal, ++serial);
      for (const [index, asset] of [source, destination].entries()) {
        const decimals = words(discovered[index]!.result, 1)[0]!;
        if (decimals > 255n || decimals !== BigInt(asset.decimals) ||
          (asset.address === BASE_V3.native || asset.address === BASE_V3.weth) && decimals !== 18n ||
          asset.address === BASE_V3.usdc && decimals !== 6n) fail('TOKEN_DECIMALS_MISMATCH');
      }
      const pools = tiers.flatMap((fee, i) => {
        const result = discovered[i + 2]!;
        const address = words(result.result, 1)[0]!;
        if (address >= 1n << 160n) fail('V3_INVALID_ABI');
        return address === 0n ? [] : [{ fee, index: i, address: '0x' + address.toString(16).padStart(40, '0') }];
      });
      if (!pools.length) fail('V3_NO_POOL');
      let best: { pool: typeof pools[number]; data: bigint[] } | undefined;
      for (const pool of pools) {
        const result = discovered[2 + tiers.length + pool.index]!;
        if (result.executionReverted) {
          if (result.revertData !== undefined && !isSolidityRevert(result.revertData)) throw new QuoteFault('V3_RPC_UNAVAILABLE', true);
          continue; // Explicit simulation revert only; empty/OOG never hides a real pool.
        }
        const data = words(result.result, 4);
        if (data[1]! === 0n || data[1]! >= 1n << 160n || data[2]! >= 1n << 32n || data[3]! === 0n || data[3]! > 5000000n) fail('V3_INVALID_ABI');
        if (data[0]! > 0n && (!best || data[0]! > best.data[0]!)) best = { pool, data };
      }
      if (!best) fail('V3_NO_LIQUIDITY');
      const now = clock(), pricingValidUntilMs = Math.min(header.started + ttl, header.blockMs + 12000, ctx.deadlineMs);
      if (!Number.isSafeInteger(now) || header.blockMs > now + 2000 || now - header.blockMs > 12000) fail('V3_STALE_BLOCK');
      if (!Number.isSafeInteger(now) || now < started || signal.aborted || now >= ctx.transportDeadlineMs || now >= pricingValidUntilMs) fail('V3_QUOTE_DEADLINE');
      const minimum = best.data[0]! * BigInt(10000 - ctx.slippageBps) / 10000n;
      if (minimum === 0n) fail('V3_NONPOSITIVE_MINIMUM');
      return Object.freeze({ capabilityId: ctx.leg.capabilityId, adapterId: 'uniswap-v3', source, destination, amountInRaw: ctx.amountRaw,
        expectedOutRaw: best.data[0]!.toString(), minimumOutRaw: minimum.toString(),
        feeBps: null, priceImpactBps: null, estimatedCompletionMs: options.estimatedCompletionMs ?? null,
        expiresAtMs: pricingValidUntilMs, pricingValidUntilMs, quoteId: `v3:${ctx.request.requestId}:${number}:${++serial}`,
        conditional: true, liquidityConfirmed: true, blockNumber: number, blockHash: hash, poolAddress: best.pool.address,
        poolFeePips: best.pool.fee, simulatedSwapGasUnits: best.data[3]!.toString(), initializedTicksCrossed: Number(best.data[2]),
        sqrtPriceX96After: best.data[1]!.toString(), pricingBasis: 'PINNED_BLOCK_V3_POOL_SIMULATION' });
    });
  };
  return { id: 'uniswap-v3', quote, async prepare(inputContext): Promise<PreparedQuote> {
    const requestIdentity = inputContext.request, scopeSignal = inputContext.signal;
    const ctx: PreparationContext = { ...inputContext, request: structuredClone(inputContext.request), leg: structuredClone(inputContext.leg) };
    const started = boundedInteger(clock(), 0, Number.MAX_SAFE_INTEGER, 'V3_INVALID_CLOCK');
    validateContext(ctx, started);
    const contextBinding = binding(ctx);
    const header = await guarded(ctx, started, signal => readHeader(signal, started));
    const prepared: Preparation = { header };
    // The evidence is private, not a JSON token. A new comparison's cloned
    // request cannot reuse it, even with an identical caller request ID.
    return Object.freeze({ quote: async (actualContext: QuoteContext) => {
      if (scopeSignal.aborted) fail('CANCELLED');
      if (actualContext.request !== requestIdentity || binding(actualContext) !== contextBinding) fail('V3_PREPARATION_CONTEXT_MISMATCH');
      return quote(actualContext, prepared);
    } });
  } };
}
