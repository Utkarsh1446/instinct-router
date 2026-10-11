import assert from 'node:assert/strict';
import test from 'node:test';
import { assetKey, CapabilityRegistry, normalizeAsset, RouterCoreError, validateRequest } from '../dist/capabilities.js';
import { planRoutes } from '../dist/planner.js';
import type { Asset, RouteCapability, RouterRequest } from '../dist/types.js';

const NOW = 1_000;
const BASE = 'eip155:8453', ETH = 'eip155:1', SOL = 'solana:mainnet';
const baseUsdc: Asset = { chainId: BASE, address: '0x' + 'a1'.repeat(20), decimals: 6 };
const baseTarget: Asset = { chainId: BASE, address: '0x' + 'a2'.repeat(20), decimals: 18 };
const ethUsdc: Asset = { chainId: ETH, address: '0x' + 'a3'.repeat(20), decimals: 6 };
const solUsdc: Asset = { chainId: SOL, address: 'SolUsdcFixture', decimals: 6 };
const solTarget: Asset = { chainId: SOL, address: 'FreshSolTargetFixture', decimals: 9 };
const extra: Asset = { chainId: SOL, address: 'AnotherFixture', decimals: 6 };

function request(patch: Partial<RouterRequest> = {}): RouterRequest {
  return { requestId: 'request-1', source: baseUsdc, destination: solTarget, amountRaw: '1000000',
    sender: '0x' + '11'.repeat(20), recipient: 'UserSolFixture', slippageBps: 50, maxFeeBps: 100,
    maxPriceImpactBps: 500, maxCompletionMs: 180000, deadlineMs: 600000,
    optimization: { objective: 'BALANCED', maxOutputShortfallBps: 50 }, ...patch };
}

function edge(id: string, source: Asset, destination: Asset, patch: Partial<RouteCapability> = {}): RouteCapability {
  return { id, adapterId: 'provider', source, destination, kind: source.chainId === destination.chainId ? 'SWAP' : 'BRIDGE',
    validationTier: 'QUOTE_VALIDATED', executionTier: 'NONE', liquidity: 'AVAILABLE', validUntilMs: 500000, ...patch };
}

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, error => error instanceof RouterCoreError && error.code === code);
}

test('discovers direct and three-stage exact-token routes without requiring target bridge catalog membership', () => {
  const registry = new CapabilityRegistry([
    edge('destination-buy', solUsdc, solTarget), edge('source-convert', baseUsdc, ethUsdc),
    edge('bridge', ethUsdc, solUsdc), edge('direct', baseUsdc, solTarget),
  ]);
  const result = planRoutes(request(), registry, { nowMs: NOW, intermediates: [ethUsdc, solUsdc] });
  assert.equal(result.paths.length, 2);
  assert.deepEqual(result.paths.map(path => path.kind), ['DIRECT', 'COMPOSED']);
  const composed = result.paths[1];
  assert.ok(composed);
  assert.deepEqual(composed.legs.map(leg => leg.capabilityId), ['source-convert', 'bridge', 'destination-buy']);
  assert.deepEqual(composed.legs.map(leg => leg.amountSource), ['REQUEST_AMOUNT', 'ACTUAL_PREVIOUS_SETTLED_OUTPUT', 'ACTUAL_PREVIOUS_SETTLED_OUTPUT']);
  assert.deepEqual(composed.legs.map(leg => leg.requiresRequoteAfterSettlement), [false, true, true]);
  assert.equal(composed.quoteBasis, 'CONDITIONAL_FUTURE_LEGS');
  assert.ok(result.paths.every(path => path.executionReady === false));
});

test('unknown liquidity remains an explicitly non-executable quote probe; unavailable liquidity is excluded', () => {
  const registry = new CapabilityRegistry([
    edge('unknown', baseUsdc, solTarget, { liquidity: 'UNKNOWN' }),
    edge('empty', baseUsdc, solTarget, { liquidity: 'UNAVAILABLE' }),
  ]);
  const result = planRoutes(request(), registry, { nowMs: NOW });
  assert.equal(result.paths.length, 1);
  assert.equal(result.paths[0]!.quoteProbe, true);
  assert.equal(result.paths[0]!.legs[0]!.quoteProbe, true);
  assert.equal(result.paths[0]!.executionReady, false);
  assert.deepEqual(result.exclusions, [{ capabilityId: 'empty', reason: 'LIQUIDITY_UNAVAILABLE' }]);
});

test('unsupported pairs, unapproved intermediates and raw-decimal mismatches never imply a route', () => {
  const registry = new CapabilityRegistry([edge('bridge', baseUsdc, solUsdc), edge('buy', solUsdc, solTarget)]);
  assert.equal(planRoutes(request(), registry, { nowMs: NOW }).paths.length, 0);
  assert.equal(planRoutes(request({ destination: extra }), registry, { nowMs: NOW, intermediates: [solUsdc] }).paths.length, 0);
  assert.equal(planRoutes(request({ source: { ...baseUsdc, decimals: 18 } }), registry,
    { nowMs: NOW, intermediates: [solUsdc] }).paths.length, 0);
});

test('directed capabilities cannot silently authorize reverse routing', () => {
  const registry = new CapabilityRegistry([edge('forward', baseUsdc, solTarget)]);
  assert.equal(planRoutes(request({ source: solTarget, destination: baseUsdc, sender: 'UserSolFixture',
    recipient: '0x' + '11'.repeat(20) }), registry, { nowMs: NOW }).paths.length, 0);
});

test('path IDs and limits are stable across registry order, with no asset cycles', () => {
  const entries = [edge('a-bridge', baseUsdc, solUsdc), edge('b-buy', solUsdc, solTarget),
    edge('loop', solUsdc, baseUsdc), edge('c-direct', baseUsdc, solTarget), edge('d-direct', baseUsdc, solTarget)];
  const options = { nowMs: NOW, intermediates: [solUsdc], maxPaths: 2 };
  const left = planRoutes(request(), new CapabilityRegistry(entries), options);
  const right = planRoutes(request(), new CapabilityRegistry([...entries].reverse()), options);
  assert.deepEqual(left, right);
  assert.equal(left.paths.length, 2); assert.equal(left.truncated, true);
  for (const path of left.paths) {
    const vertices = [path.source, ...path.legs.map(leg => leg.destination)].map(assetKey);
    assert.equal(new Set(vertices).size, vertices.length);
  }
  assert.notEqual(left.paths[0]!.id, left.paths[1]!.id);
});

test('a fourth leg cannot pass the hard hop limit and edge truncation is explicit', () => {
  const registry = new CapabilityRegistry([edge('a', baseUsdc, ethUsdc), edge('b', ethUsdc, solUsdc),
    edge('c', solUsdc, extra), edge('d', extra, solTarget)]);
  assert.equal(planRoutes(request(), registry, { nowMs: NOW, intermediates: [ethUsdc, solUsdc, extra] }).paths.length, 0);
  const limited = planRoutes(request(), registry, { nowMs: NOW, intermediates: [ethUsdc, solUsdc, extra], maxEdges: 1 });
  assert.equal(limited.truncated, true); assert.equal(limited.exclusions.length, 3);
  expectCode(() => planRoutes(request(), registry, { nowMs: NOW, maxHops: 4 }), 'INVALID_HOP_LIMIT');
  expectCode(() => planRoutes(request(), registry, { nowMs: NOW, maxPaths: 65 }), 'INVALID_PATH_LIMIT');
});

test('adapter allowlists, validation tiers and capability expiry are enforced before quoting', () => {
  const registry = new CapabilityRegistry([
    edge('expired', baseUsdc, solTarget, { validUntilMs: NOW }),
    edge('unverified', baseUsdc, solTarget, { validationTier: 'UNVERIFIED' }),
    edge('other', baseUsdc, solTarget, { adapterId: 'other' }),
    edge('allowed', baseUsdc, solTarget, { validationTier: 'EXECUTION_VALIDATED', executionTier: 'WALLET_SIGNED' }),
  ]);
  const result = planRoutes(request(), registry, { nowMs: NOW, allowedAdapterIds: ['provider'] });
  assert.equal(result.paths.length, 1);
  assert.equal(result.paths[0]!.legs[0]!.capabilityId, 'allowed');
  assert.deepEqual(new Set(result.exclusions.map(item => item.reason)), new Set(['ADAPTER_NOT_ALLOWED', 'CAPABILITY_EXPIRED', 'VALIDATION_TIER_INSUFFICIENT']));
  assert.equal(planRoutes(request(), registry, { nowMs: NOW, allowedAdapterIds: [] }).paths.length, 0);
});

test('registry validates boundaries and decimals, and failed registration does not poison later registrations', () => {
  const registry = new CapabilityRegistry([edge('first', baseUsdc, solTarget)]);
  expectCode(() => registry.register(edge('first', baseUsdc, solTarget)), 'DUPLICATE_CAPABILITY');
  expectCode(() => registry.register(edge('wrong', baseUsdc, solTarget, { kind: 'SWAP' })), 'INVALID_CAPABILITY_BOUNDARY');
  expectCode(() => registry.register(edge('wrong-decimals', { ...baseUsdc, decimals: 18 }, solTarget)), 'CONFLICTING_ASSET_DECIMALS');
  registry.register(edge('later', baseUsdc, solUsdc));
  assert.equal(registry.list().length, 2);
  expectCode(() => registry.register({ ...edge('invalid', baseUsdc, solTarget), liquidity: 'MAYBE' } as unknown as RouteCapability), 'INVALID_LIQUIDITY_STATUS');
});

test('registry and returned plans retain immutable deep copies across caller mutation', () => {
  const input = structuredClone(edge('direct', baseUsdc, solTarget));
  const registry = new CapabilityRegistry([input]);
  (input.source as { address: string }).address = baseTarget.address;
  const result = planRoutes(request(), registry, { nowMs: NOW });
  assert.equal(result.paths.length, 1); assert.equal(result.paths[0]!.source.address, baseUsdc.address);
  assert.throws(() => { (result.paths[0]!.legs[0]!.source as { decimals: number }).decimals = 18; }, TypeError);
  assert.throws(() => { (registry.list() as RouteCapability[]).push(input); }, TypeError);
});

test('EVM case differences normalize without silently changing decimal or non-EVM identity', () => {
  assert.equal(normalizeAsset({ ...baseUsdc, address: '0x' + 'A1'.repeat(20) }).address, baseUsdc.address);
  assert.notEqual(assetKey(solTarget), assetKey({ ...solTarget, address: solTarget.address.toLowerCase() }));
  const registry = new CapabilityRegistry([edge('direct', { ...baseUsdc, address: '0x' + 'A1'.repeat(20) }, solTarget)]);
  assert.equal(planRoutes(request(), registry, { nowMs: NOW }).paths.length, 1);
});

test('request boundaries reject nonfinite, missing, unsafe raw and unexpectedly extended policy fields', () => {
  const changes = [
    { deadlineMs: NaN }, { maxCompletionMs: Infinity }, { slippageBps: -1 }, { maxFeeBps: 10001 },
    { amountRaw: '01' }, { amountRaw: '0' }, { amountRaw: ((1n << 256n)).toString() }, { sender: '' },
    { optimization: undefined }, { source: { ...baseUsdc, chainId: 'base' } },
    { optimization: { objective: 'BEST_OUTPUT', maxOutputShortfallBps: 1 } },
  ];
  for (const change of changes) assert.throws(() => validateRequest({ ...request(), ...change }, NOW), RouterCoreError);
  assert.throws(() => validateRequest({ ...request(), allowAnyCalldata: true }, NOW), RouterCoreError);
  expectCode(() => validateRequest(request({ deadlineMs: NOW }), NOW), 'REQUEST_EXPIRED');
  expectCode(() => validateRequest(request(), NaN), 'INVALID_CLOCK');
  const native = validateRequest(request({ nativeFeeBudgets: [{ chainId: BASE, maxAmountRaw: '20000000000000' },
    { chainId: SOL, maxAmountRaw: '5000000' }] }), NOW);
  assert.equal(native.nativeFeeBudgets?.length, 2);
  expectCode(() => validateRequest(request({ nativeFeeBudgets: [{ chainId: BASE, maxAmountRaw: '1' },
    { chainId: BASE, maxAmountRaw: '2' }] }), NOW), 'DUPLICATE_NATIVE_BUDGET');
  expectCode(() => validateRequest(request({ nativeFeeBudgets: [{ chainId: BASE, maxAmountRaw: '-1' }] }), NOW), 'INVALID_RAW_AMOUNT');
});

test('intermediate wallets are unique and cannot replace the bound source or destination owner', () => {
  const value = validateRequest(request({ wallets: [{ chainId: ETH, address: '0x' + '22'.repeat(20) }] }), NOW);
  assert.equal(value.wallets?.[0]?.chainId, ETH);
  assert.throws(() => { (value.wallets![0]! as { address: string }).address = 'other'; }, TypeError);
  expectCode(() => validateRequest(request({ wallets: [{ chainId: ETH, address: '0x' + '22'.repeat(20) },
    { chainId: ETH, address: '0x' + '33'.repeat(20) }] }), NOW), 'DUPLICATE_WALLET');
  expectCode(() => validateRequest(request({ wallets: [{ chainId: BASE, address: '0x' + '44'.repeat(20) }] }), NOW), 'CONFLICTING_WALLET');
  expectCode(() => validateRequest(request({ wallets: [{ chainId: SOL, address: 'OtherSolWallet' }] }), NOW), 'CONFLICTING_WALLET');
  expectCode(() => validateRequest(request({ wallets: [{ chainId: ETH, address: 'not-an-address' }] }), NOW), 'INVALID_ASSET_ADDRESS');
});

test('discovery remains portable to explicit additional chains instead of hardcoding Base and Solana', () => {
  const native: Asset = { chainId: 'cosmos:cosmoshub-4', address: 'uatom', decimals: 6 };
  const token: Asset = { chainId: 'cosmos:cosmoshub-4', address: 'factory/reviewed/token', decimals: 6 };
  const registry = new CapabilityRegistry([edge('reviewed-dex', native, token)]);
  const result = planRoutes(request({ source: native, destination: token }), registry, { nowMs: NOW });
  assert.equal(result.paths.length, 1);
  assert.equal(result.paths[0]!.legs[0]!.kind, 'SWAP');
});
