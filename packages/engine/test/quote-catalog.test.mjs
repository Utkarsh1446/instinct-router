import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverQuoteCatalog, createQuoteService, createExecutionEngine } from '../src/index.mjs';
import { chains, assets, ZERO } from '../src/registry.mjs';
import { fixtureWire, input, evmWallet } from '../../../tests/fixtures/provider.mjs';
const json = value => new Response(JSON.stringify(value));
const ca = '0x2222222222222222222222222222222222222222';
const polygon = { id: 'relay-chain-137', name: 'Polygon', chainId: 'eip155:137', relayChainId: 137, relayProtocolChainId: 'polygon' };
const native = { id: 'relay-native-137', chainId: polygon.chainId, address: ZERO, decimals: 18, symbol: 'POL', native: true, decimalsSource: 'PROVIDER_CATALOG' };
const catalog = { additionalChains: [polygon], additionalAssets: [native] };
const chainRow = (id = 137) => ({ id, name: 'Polygon', vmType: 'evm', disabled: false, depositEnabled: true,
  protocol: { v2: { chainId: 'polygon', depository: 'untrusted-execution-contract' } },
  currency: { address: ZERO, decimals: 18, symbol: 'POL' }, httpRpcUrl: 'https://untrusted.invalid/', solverAddresses: ['attacker'] });
test('fixed provider discovery adds eligible EVM pricing chains without importing execution or RPC policy', async () => {
  const rows = [chainRow(), { ...chainRow(10), disabled: true }, { ...chainRow(11), vmType: 'bvm' },
    { ...chainRow(12), protocol: null }, { ...chainRow(13), currency: null },
    { ...chainRow(8453), name: 'Spoofed Base' }];
  const calls = [];
  const result = await discoverQuoteCatalog({ fetch: async (url, init) => {
    calls.push({ url, init }); return json({ chains: rows });
  } });
  assert.deepEqual(result, catalog);
  assert.equal(calls[0].url, 'https://api.relay.link/chains');
  assert.equal(calls[0].init.redirect, 'error');
  assert.doesNotMatch(JSON.stringify(result), /httpRpcUrl|untrusted|solverAddresses|depository/);
  const service = createQuoteService({ ...result, fetch: fixtureWire() });
  const config = service.config();
  assert.equal(config.chains.length, chains.length + 1);
  assert.deepEqual(config.assets.slice(0, assets.length), assets);
  assert.equal(config.chains.at(-1).sourceConfirmationMs, null);
  assert.equal(config.chains.at(-1).destinationVerificationMs, null);
  assert.equal(config.chains.at(-1).timingBasis, 'UNKNOWN');
  assert.equal(config.capabilities.walletExecution, false);
  assert.equal(config.capabilities.providerDiscoveryIsAuthorization, false);
  assert.deepEqual(createExecutionEngine().capabilities().supportedRoutes, []);
});
test('operator catalogs cannot overwrite pinned identities, mix families, duplicate IDs, or supply URLs', () => {
  for (const additionalChains of [[{ ...polygon, chainId: 'eip155:8453', relayChainId: 8453 }],
    [polygon, polygon], [{ ...polygon, chainId: 'bitcoin:mainnet' }], [{ ...polygon, rpcUrl: 'https://evil.invalid' }]])
    assert.throws(() => createQuoteService({ additionalChains }), /INVALID_QUOTE_CATALOG/);
  for (const additionalAssets of [[{ ...native, id: assets[0].id }], [{ ...native, address: ca }],
    [{ ...native, decimals: 256 }], [{ ...native, address: '0xnot-an-address' }]])
    assert.throws(() => createQuoteService({ additionalChains: [polygon], additionalAssets }), /INVALID_QUOTE_CATALOG/);
});
test('EVM CA metadata binds exact chain/address and separates provider provenance from chain verification', async () => {
  const calls = [];
  const service = createQuoteService({ ...catalog, fetch: async (url, init) => {
    calls.push({ url, init }); return json([{ chainId: 137, address: ca, decimals: 6, symbol: 'CUSTOM', metadata: { isNative: false, logoURI: 'https://evil.invalid' } }]);
  } });
  const resolved = await service.resolveAsset({ chainId: polygon.chainId, address: ca.toUpperCase().replace('0X', '0x') });
  assert.equal(resolved.address, ca); assert.equal(resolved.decimals, 6);
  assert.equal(resolved.decimalsSource, 'PROVIDER_CATALOG');
  assert.equal(resolved.executionAuthorized, false); assert.equal(resolved.tokenProgram, undefined);
  assert.equal(calls[0].url, 'https://api.relay.link/currencies/v2');
  assert.deepEqual(JSON.parse(calls[0].init.body), { chainIds: [137], address: ca, useExternalSearch: true, limit: 1 });
  assert.doesNotMatch(JSON.stringify(resolved), /logoURI|evil.invalid/);
  await service.resolveAsset({ chainId: polygon.chainId, address: ca });
  assert.equal(calls.length, 1);
  await assert.rejects(service.resolveAsset({ chainId: polygon.chainId, address: ca, rpcUrl: 'https://evil.invalid' }), error => error.code === 'INVALID_ASSET');
  assert.equal(calls.length, 1);
});
test('empty metadata allows manual-decimal fallback, but wrong identity, duplicates and transport failure do not', async () => {
  for (const fault of ['empty', 'chain', 'address', 'duplicates', 'transport']) {
    const service = createQuoteService({ ...catalog, fetch: async () => {
      if (fault === 'transport') throw new Error('secret URL https://private.invalid/key');
      const row = { chainId: fault === 'chain' ? 8453 : 137, address: fault === 'address' ? evmWallet : ca, decimals: 6, symbol: 'TOKEN' };
      return json(fault === 'empty' ? [] : fault === 'duplicates' ? [row, row] : [row]);
    } });
    await assert.rejects(service.resolveAsset({ chainId: polygon.chainId, address: ca }), error => {
      assert.equal(error.code, fault === 'empty' ? 'TOKEN_METADATA_UNSUPPORTED' : 'TOKEN_METADATA_UNAVAILABLE');
      assert.doesNotMatch(JSON.stringify(error), /private.invalid|secret/); return true;
    });
  }
});
test('tokens outside the preset list quote on a discovered chain without fabricated settlement timing or execution', async () => {
  const requests = [], fixture = fixtureWire();
  const service = createQuoteService({ ...catalog, fetch: async (url, init) => {
    const sent = JSON.parse(init.body); requests.push(sent);
    const response = await fixture(url, { ...init, body: JSON.stringify({ ...sent, originChainId: 8453 }) });
    const raw = await response.json();
    raw.details.currencyIn.currency.chainId = 137;
    raw.protocol.v2.orderData.inputs[0].payment.chainId = 'polygon';
    return json(raw);
  } });
  const result = await service.quote({ ...input, source: { chainId: polygon.chainId, address: ca, decimals: 6 },
    destination: input.source, recipient: evmWallet });
  assert.equal(requests[0].originChainId, 137);
  assert.equal(result.source.metadataVerified, false);
  assert.equal(result.source.decimalsSource, 'USER_PROVIDED');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].estimatedCompletionMs, null);
  assert.equal(result.candidates[0].executionReady, false);
  assert.equal(result.execution.enabled, false);
});
test('catalog discovery has a caller-visible deadline even when provider fetch ignores cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release;
  const pending = discoverQuoteCatalog({ fetch: () => new Promise(resolve => { release = () => resolve(json({ chains: [chainRow()] })); }) });
  const rejection = assert.rejects(pending);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(6000); await rejection;
  release(); await new Promise(resolve => setImmediate(resolve));
});
test('full uint8 token precision accepts the smallest raw unit while uint256 amounts stay bounded', async () => {
  const fixture = fixtureWire(), calls = [];
  const service = createQuoteService({ ...catalog, fetch: async (url, init) => {
    const sent = JSON.parse(init.body); calls.push(sent);
    const response = await fixture(url, { ...init, body: JSON.stringify({ ...sent, originChainId: 8453 }) });
    const raw = await response.json();
    raw.details.currencyIn.currency.chainId = 137;
    raw.details.currencyIn.currency.decimals = 255;
    raw.protocol.v2.orderData.inputs[0].payment.chainId = 'polygon';
    return json(raw);
  } });
  const request = { ...input, source: { chainId: polygon.chainId, address: ca, decimals: 255 },
    destination: input.source, recipient: evmWallet, amount: '0.' + '0'.repeat(254) + '1' };
  const result = await service.quote(request);
  assert.equal(result.amountRaw, '1'); assert.equal(calls[0].amount, '1');
  await assert.rejects(service.quote({ ...request, amount: '1' }), error => error.code === 'INVALID_AMOUNT');
  assert.equal(calls.length, 1);
});
