import type { Asset, ChainId, RouteCapability, RouterRequest, ValidationTier } from './types.js';

const TIERS: readonly ValidationTier[] = ['UNVERIFIED', 'QUOTE_VALIDATED', 'EXECUTION_VALIDATED'];
const MAX_AMOUNT = (1n << 256n) - 1n;

export class RouterCoreError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'RouterCoreError'; this.code = code; }
}

function fail(code: string): never { throw new RouterCoreError(code); }

export function chainId(value: unknown): ChainId {
  if (typeof value !== 'string' || !/^[a-z0-9-]{3,8}:[A-Za-z0-9_-]{1,64}$/.test(value)) fail('INVALID_CHAIN_ID');
  if (value.startsWith('eip155:') && !/^[1-9][0-9]*$/.test(value.slice(7))) fail('INVALID_CHAIN_ID');
  return value as ChainId;
}

export function boundedInteger(value: unknown, min: number, max: number, code = 'INVALID_INTEGER'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail(code);
  return value;
}

export function rawAmount(value: unknown, positive = false): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value)
      || BigInt(value) > MAX_AMOUNT || (positive && value === '0')) fail('INVALID_RAW_AMOUNT');
  return value;
}

function object(value: unknown, fields: readonly string[], code: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !fields.includes(key))) fail(code);
  return record;
}

export function normalizeAsset(value: unknown): Asset {
  const asset = object(value, ['chainId', 'address', 'decimals'], 'INVALID_ASSET');
  const chain = chainId(asset.chainId);
  if (typeof asset.address !== 'string' || !asset.address.length || asset.address.length > 256
      || /[\s\x00-\x1f\x7f]/.test(asset.address)) fail('INVALID_ASSET_ADDRESS');
  let address = asset.address;
  if (chain.startsWith('eip155:')) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) fail('INVALID_ASSET_ADDRESS');
    address = address.toLowerCase();
  }
  return Object.freeze({ chainId: chain, address, decimals: boundedInteger(asset.decimals, 0, 255, 'INVALID_DECIMALS') });
}

/** Includes decimals so raw-unit boundaries cannot silently change. */
export function assetKey(asset: Asset): string {
  const value = normalizeAsset(asset);
  return JSON.stringify([value.chainId, value.address, value.decimals]);
}

export function sameAsset(left: Asset, right: Asset): boolean { return assetKey(left) === assetKey(right); }

export function validationRank(tier: ValidationTier): number {
  const rank = TIERS.indexOf(tier);
  if (rank < 0) fail('INVALID_VALIDATION_TIER');
  return rank;
}

export function validateRequest(raw: unknown, nowMs = Date.now()): RouterRequest {
  const request = object(raw, ['requestId', 'source', 'destination', 'amountRaw', 'sender', 'recipient', 'slippageBps',
    'maxFeeBps', 'maxPriceImpactBps', 'maxCompletionMs', 'deadlineMs', 'optimization', 'nativeFeeBudgets', 'wallets'], 'INVALID_REQUEST');
  boundedInteger(nowMs, 0, Number.MAX_SAFE_INTEGER, 'INVALID_CLOCK');
  if (typeof request.requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(request.requestId)) fail('INVALID_REQUEST_ID');
  for (const key of ['sender', 'recipient']) {
    if (typeof request[key] !== 'string' || !(request[key] as string).length || (request[key] as string).length > 256
        || /[\s\x00-\x1f\x7f]/.test(request[key] as string)) fail('INVALID_WALLET');
  }
  const source = normalizeAsset(request.source), destination = normalizeAsset(request.destination);
  const sender = normalizeAsset({ chainId: source.chainId, address: request.sender, decimals: 0 }).address;
  const recipient = normalizeAsset({ chainId: destination.chainId, address: request.recipient, decimals: 0 }).address;
  if (sameAsset(source, destination)) fail('IDENTICAL_ASSETS');
  const policy = object(request.optimization, ['objective', 'maxOutputShortfallBps'], 'INVALID_OPTIMIZATION');
  if (!['BALANCED', 'BEST_OUTPUT', 'FASTEST'].includes(policy.objective as string)) fail('INVALID_OPTIMIZATION');
  const band = boundedInteger(policy.maxOutputShortfallBps, 0, 10000, 'INVALID_OUTPUT_BAND');
  if (policy.objective === 'BEST_OUTPUT' && band !== 0) fail('INVALID_OUTPUT_BAND');
  const deadlineMs = boundedInteger(request.deadlineMs, 1, Number.MAX_SAFE_INTEGER, 'INVALID_DEADLINE');
  if (deadlineMs <= nowMs) fail('REQUEST_EXPIRED');
  let nativeFeeBudgets: RouterRequest['nativeFeeBudgets'];
  if (request.nativeFeeBudgets !== undefined) {
    if (!Array.isArray(request.nativeFeeBudgets) || request.nativeFeeBudgets.length > 8) fail('INVALID_NATIVE_BUDGET');
    const seen = new Set<string>();
    nativeFeeBudgets = Object.freeze(request.nativeFeeBudgets.map(rawBudget => {
      const budget = object(rawBudget, ['chainId', 'maxAmountRaw'], 'INVALID_NATIVE_BUDGET');
      const chain = chainId(budget.chainId);
      if (seen.has(chain)) fail('DUPLICATE_NATIVE_BUDGET');
      seen.add(chain);
      return Object.freeze({ chainId: chain, maxAmountRaw: budget.maxAmountRaw === null ? null : rawAmount(budget.maxAmountRaw) });
    }));
  }
  let wallets: RouterRequest['wallets'];
  if (request.wallets !== undefined) {
    if (!Array.isArray(request.wallets) || request.wallets.length > 8) fail('INVALID_WALLETS');
    const seen = new Set<string>();
    wallets = Object.freeze(request.wallets.map(rawWallet => {
      const wallet = object(rawWallet, ['chainId', 'address'], 'INVALID_WALLETS');
      const value = normalizeAsset({ chainId: wallet.chainId, address: wallet.address, decimals: 0 });
      if (seen.has(value.chainId)) fail('DUPLICATE_WALLET');
      if (value.chainId === source.chainId && value.address !== sender
          || value.chainId !== source.chainId && value.chainId === destination.chainId && value.address !== recipient) fail('CONFLICTING_WALLET');
      seen.add(value.chainId);
      return Object.freeze({ chainId: value.chainId, address: value.address });
    }));
  }
  return Object.freeze({ requestId: request.requestId, source, destination, amountRaw: rawAmount(request.amountRaw, true),
    sender, recipient,
    slippageBps: boundedInteger(request.slippageBps, 0, 10000, 'INVALID_SLIPPAGE'),
    maxFeeBps: request.maxFeeBps === null ? null : boundedInteger(request.maxFeeBps, 0, 10000, 'INVALID_FEE_LIMIT'),
    maxPriceImpactBps: boundedInteger(request.maxPriceImpactBps, 0, 10000, 'INVALID_IMPACT_LIMIT'),
    maxCompletionMs: boundedInteger(request.maxCompletionMs, 1, Number.MAX_SAFE_INTEGER, 'INVALID_COMPLETION_LIMIT'),
    deadlineMs, optimization: Object.freeze({ objective: policy.objective as RouterRequest['optimization']['objective'], maxOutputShortfallBps: band }),
    ...(nativeFeeBudgets === undefined ? {} : { nativeFeeBudgets }), ...(wallets === undefined ? {} : { wallets }) });
}

export class CapabilityRegistry {
  #capabilities = new Map<string, RouteCapability>();
  #decimals = new Map<string, number>();

  constructor(capabilities: readonly RouteCapability[] = []) {
    for (const capability of capabilities) this.register(capability);
  }

  register(raw: RouteCapability): void {
    if (this.#capabilities.size >= 4096) fail('CAPABILITY_REGISTRY_LIMIT');
    const input = object(raw, ['id', 'adapterId', 'kind', 'source', 'destination', 'validationTier',
      'executionTier', 'liquidity', 'validUntilMs'], 'INVALID_CAPABILITY');
    for (const name of ['id', 'adapterId']) {
      if (typeof input[name] !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(input[name] as string)) fail('INVALID_CAPABILITY_ID');
    }
    const key = JSON.stringify([input.adapterId, input.id]);
    if (this.#capabilities.has(key)) fail('DUPLICATE_CAPABILITY');
    const source = normalizeAsset(input.source), destination = normalizeAsset(input.destination);
    if (sameAsset(source, destination)) fail('INVALID_CAPABILITY_BOUNDARY');
    if (!['SWAP', 'BRIDGE', 'SWAP_BRIDGE'].includes(input.kind as string)) fail('INVALID_CAPABILITY_KIND');
    if ((input.kind === 'SWAP') !== (source.chainId === destination.chainId)) fail('INVALID_CAPABILITY_BOUNDARY');
    validationRank(input.validationTier as ValidationTier);
    if (!['NONE', 'WALLET_SIGNED'].includes(input.executionTier as string)) fail('INVALID_EXECUTION_TIER');
    if (!['UNKNOWN', 'AVAILABLE', 'UNAVAILABLE'].includes(input.liquidity as string)) fail('INVALID_LIQUIDITY_STATUS');
    const validUntilMs = boundedInteger(input.validUntilMs, 1, Number.MAX_SAFE_INTEGER, 'INVALID_CAPABILITY_EXPIRY');
    for (const asset of [source, destination]) {
      const identity = JSON.stringify([asset.chainId, asset.address]);
      if (this.#decimals.has(identity) && this.#decimals.get(identity) !== asset.decimals) fail('CONFLICTING_ASSET_DECIMALS');
    }
    for (const asset of [source, destination]) this.#decimals.set(JSON.stringify([asset.chainId, asset.address]), asset.decimals);
    this.#capabilities.set(key, Object.freeze({ id: input.id as string, adapterId: input.adapterId as string,
      kind: input.kind as RouteCapability['kind'], source, destination, validationTier: input.validationTier as ValidationTier,
      executionTier: input.executionTier as RouteCapability['executionTier'], liquidity: input.liquidity as RouteCapability['liquidity'], validUntilMs }));
  }

  list(): readonly RouteCapability[] {
    return Object.freeze([...this.#capabilities.values()].sort((a, b) => {
      const left = `${a.adapterId}\0${a.id}`, right = `${b.adapterId}\0${b.id}`;
      return left < right ? -1 : left > right ? 1 : 0;
    }));
  }
}
