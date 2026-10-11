/** Pricing-only provider metadata. Provider URLs and execution pins are never imported. */
import { MetadataCache, createProviderDiscovery } from '@instinct/router-core';
import { chains, assets, ZERO, SOL } from './registry.mjs';
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const fail = () => { throw Object.assign(new Error('INVALID_QUOTE_CATALOG'), { code: 'INVALID_QUOTE_CATALOG' }); };
const label = (value, max = 64) => typeof value === 'string' && value.trim().length > 0 && value.length <= max &&
  !/[\x00-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/u.test(value);
function exact(value, keys) {
  if (!plain(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail();
}
export function validateQuoteCatalog(additionalChains = [], additionalAssets = []) {
  if (!Array.isArray(additionalChains) || additionalChains.length > 252 || !Array.isArray(additionalAssets) || additionalAssets.length > 4096) fail();
  const ids = new Set(chains.map(chain => chain.id)), chainIds = new Set(chains.map(chain => chain.chainId));
  const relayIds = new Set(chains.map(chain => chain.relayChainId)), protocolIds = new Set(chains.map(chain => chain.relayProtocolChainId));
  for (const row of additionalChains) {
    exact(row, ['id', 'name', 'chainId', 'relayChainId', 'relayProtocolChainId']);
    if (typeof row.id !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(row.id) || !label(row.name, 128) || !/^eip155:[1-9][0-9]{0,15}$/.test(row.chainId) ||
      !Number.isSafeInteger(row.relayChainId) || row.relayChainId <= 0 || Number(row.chainId.slice(7)) !== row.relayChainId ||
      typeof row.relayProtocolChainId !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(row.relayProtocolChainId) || ids.has(row.id) || chainIds.has(row.chainId) ||
      relayIds.has(row.relayChainId) || protocolIds.has(row.relayProtocolChainId)) fail();
    ids.add(row.id); chainIds.add(row.chainId); relayIds.add(row.relayChainId); protocolIds.add(row.relayProtocolChainId);
  }
  const assetIds = new Set(assets.map(asset => asset.id)), keys = new Set(assets.map(asset => `${asset.chainId}:${asset.address}`));
  for (const row of additionalAssets) {
    exact(row, ['id', 'chainId', 'address', 'decimals', 'symbol', 'native', 'decimalsSource']);
    if (typeof row.id !== 'string' || !/^[a-z0-9_-]{1,80}$/.test(row.id) || !chainIds.has(row.chainId) || row.chainId === SOL ||
      typeof row.address !== 'string' || !/^0x[0-9a-f]{40}$/.test(row.address) ||
      !Number.isSafeInteger(row.decimals) || row.decimals < 0 || row.decimals > 255 || !label(row.symbol) ||
      typeof row.native !== 'boolean' || row.native && row.address !== ZERO || row.decimalsSource !== 'PROVIDER_CATALOG' ||
      assetIds.has(row.id) || keys.has(`${row.chainId}:${row.address}`)) fail();
    assetIds.add(row.id); keys.add(`${row.chainId}:${row.address}`);
  }
  return { chains: structuredClone([...chains, ...additionalChains]), assets: structuredClone([...assets, ...additionalAssets]) };
}
export async function discoverQuoteCatalog({ fetch: wire = globalThis.fetch, providerKeys = {}, now = Date.now } = {}) {
  if (typeof wire !== 'function' || typeof now !== 'function' || !plain(providerKeys) ||
    Object.keys(providerKeys).some(key => !['RELAY_API_KEY', 'AURORA_API_KEY'].includes(key))) fail();
  const discovery = createProviderDiscovery({ chains, fetch: wire, clock: now,
    ...(providerKeys.RELAY_API_KEY ? { relayApiKey: providerKeys.RELAY_API_KEY } : {}) });
  const cache = new MetadataCache(30000, 1, { maxPending: 1, loadTimeoutMs: 6000, clock: now });
  const rows = await cache.get('chains', signal => discovery.relayChains(signal));
  const additionalChains = [], additionalAssets = [];
  for (const row of rows) {
    if (chains.some(chain => chain.relayChainId === row.id) || row.disabled || row.vmType !== 'evm' ||
      row.protocolChainId === undefined || row.currency === undefined || row.currency.address.toLowerCase() !== ZERO) continue;
    additionalChains.push({ id: `relay-chain-${row.id}`, name: row.name, chainId: `eip155:${row.id}`,
      relayChainId: row.id, relayProtocolChainId: row.protocolChainId });
    additionalAssets.push({ id: `relay-native-${row.id}`, chainId: `eip155:${row.id}`, address: ZERO,
      decimals: row.currency.decimals, symbol: row.currency.symbol, native: true, decimalsSource: 'PROVIDER_CATALOG' });
  }
  validateQuoteCatalog(additionalChains, additionalAssets);
  return { additionalChains, additionalAssets };
}
