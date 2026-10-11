/** Explicit provider-managed execution configuration, separate from price discovery.
 * Operators opt into Relay's deployment/RPC metadata trust boundary at startup.
 * Quote responses and API callers can never supply this configuration. */
import { isIP } from 'node:net';
import { baseExecutionPrimitives as p } from './base-readiness.mjs';
import { ExecutionEngineError } from './base-execution-checks.mjs';

const SOL = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const ZERO = '0x' + '0'.repeat(40);
const ORACLE = '0x420000000000000000000000000000000000000f';
// Mainnet chain IDs checked against the Optimism superchain registry on
// 2026-10-10, plus the independently checked Base deployment used by this host.
const OP_STACK = new Set([8453, 65536, 60808, 624, 7560, 183, 252, 33979, 177, 57073,
  1135, 957, 1750, 185, 34443, 10, 291, 8008, 6805, 690, 5371, 360, 1868, 5330,
  254, 130, 480, 2702128, 7777777, 288, 42220, 380929]);
const CONTRACTS = ['multicall3', 'multicaller', 'onlyOwnerMulticaller', 'relayReceiver', 'erc20Router', 'approvalProxy'];
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const evmAddress = value => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
const solAddress = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
const fail = () => { throw new ExecutionEngineError('INVALID_PROVIDER_EXECUTION_CATALOG'); };

export function publicExecutionRpc(value) {
  let url;
  try { url = new URL(value); } catch { fail(); }
  const host = url.hostname.toLowerCase();
  if (typeof value !== 'string' || value.length > 2048 || url.protocol !== 'https:' || url.username || url.password || url.hash ||
    url.port && url.port !== '443' || isIP(host.replace(/^\[|\]$/g, '')) || !host.includes('.') ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(host)) fail();
  return url.href;
}

export function validateProviderExecutionChains(chains) {
  if (!Array.isArray(chains) || chains.length > 128) fail();
  const ids = new Set(), providers = new Set(), protocols = new Set();
  for (const chain of chains) {
    if (!plain(chain) || !['EVM', 'SOLANA'].includes(chain.vm) || !Number.isSafeInteger(chain.providerChainId) || chain.providerChainId <= 0 ||
      chain.chainId !== (chain.vm === 'EVM' ? 'eip155:' + chain.providerChainId : SOL) ||
      chain.vm === 'SOLANA' && chain.providerChainId !== 792703809 || ids.has(chain.chainId) || providers.has(chain.providerChainId) ||
      typeof chain.protocolChainId !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(chain.protocolChainId) || protocols.has(chain.protocolChainId) ||
      !plain(chain.nativeCurrency) || !Number.isSafeInteger(chain.nativeCurrency.decimals) || chain.nativeCurrency.decimals < 0 || chain.nativeCurrency.decimals > 255 ||
      typeof chain.nativeCurrency.symbol !== 'string' || !/^[^\x00-\x1f\x7f]{1,32}$/.test(chain.nativeCurrency.symbol) ||
      chain.nativeCurrency.address !== (chain.vm === 'EVM' ? ZERO : '11111111111111111111111111111111') ||
      chain.confirmations !== (chain.vm === 'EVM' ? 12 : 1) || !['STANDARD', 'OPSTACK', 'PROVIDER_ESTIMATE'].includes(chain.feeModel) ||
      chain.feeModel === 'OPSTACK' && (chain.vm !== 'EVM' || chain.gasOracle !== ORACLE) || !plain(chain.contracts) ||
      Object.keys(chain.contracts).some(key => !CONTRACTS.includes(key)) ||
      Object.values(chain.contracts).some(value => !evmAddress(value) || value === ZERO) ||
      chain.depository !== undefined && !(chain.vm === 'EVM' ? evmAddress(chain.depository) && chain.depository !== ZERO : solAddress(chain.depository)) ||
      !Array.isArray(chain.solverAddresses) || chain.solverAddresses.length > 128 ||
      chain.solverAddresses.some(address => !(chain.vm === 'EVM' ? evmAddress(address) && address !== ZERO : solAddress(address)))) fail();
    publicExecutionRpc(chain.rpcUrl);
    ids.add(chain.chainId); providers.add(chain.providerChainId); protocols.add(chain.protocolChainId);
  }
  return structuredClone(chains);
}

export function providerExecutionChainsFromCatalog(data, { rpcOverrides = {}, feeModels = {} } = {}) {
  if (!plain(data) || !Array.isArray(data.chains) || data.chains.length > 128 || !plain(rpcOverrides) || !plain(feeModels)) fail();
  const chains = [];
  for (const row of data.chains) {
    if (!plain(row) || row.disabled || row.depositEnabled !== true || !['evm', 'svm'].includes(row.vmType) || !row.protocol?.v2?.chainId) continue;
    const vm = row.vmType === 'evm' ? 'EVM' : 'SOLANA';
    if (vm === 'SOLANA' && row.id !== 792703809) continue;
    if (row.currency?.address !== (vm === 'EVM' ? ZERO : '11111111111111111111111111111111')) continue;
    const chainId = vm === 'EVM' ? `eip155:${row.id}` : SOL;
    const contracts = Object.fromEntries(CONTRACTS.filter(key => evmAddress(row.contracts?.[key]) && row.contracts[key].toLowerCase() !== ZERO)
      .map(key => [key, row.contracts[key].toLowerCase()]));
    const depository = row.protocol.v2.depository;
    const feeModel = feeModels[chainId] ?? (OP_STACK.has(row.id) ? 'OPSTACK' : vm === 'SOLANA' || [1,42161].includes(row.id) ? 'STANDARD' : 'PROVIDER_ESTIMATE');
    chains.push({ chainId, providerChainId: row.id, vm, rpcUrl: publicExecutionRpc(rpcOverrides[chainId] ?? row.httpRpcUrl),
      protocolChainId: row.protocol.v2.chainId, nativeCurrency: { address: row.currency?.address, decimals: row.currency?.decimals, symbol: row.currency?.symbol },
      contracts, ...(depository ? { depository: vm === 'EVM' ? depository.toLowerCase() : depository } : {}),
      solverAddresses: (row.solverAddresses ?? []).map(address => vm === 'EVM' ? address.toLowerCase() : address),
      confirmations: vm === 'EVM' ? 12 : 1, feeModel, ...(feeModel === 'OPSTACK' ? { gasOracle: ORACLE } : {}) });
  }
  return validateProviderExecutionChains(chains);
}

export async function discoverProviderExecutionChains({ fetch: wire = globalThis.fetch, rpcOverrides, feeModels, signal } = {}) {
  const bound = signal ? AbortSignal.any([signal, AbortSignal.timeout(6000)]) : AbortSignal.timeout(6000);
  let stop, reader;
  const cancelled = new Promise((_, reject) => { stop = () => { void reader?.cancel().catch(() => {}); reject(new ExecutionEngineError('PROVIDER_EXECUTION_DISCOVERY_TIMEOUT')); }; bound.addEventListener('abort', stop, {once:true}); if(bound.aborted) stop(); });
  const work = (async () => {
  const response = await wire('https://api.relay.link/chains', { signal: bound, redirect: 'error', credentials: 'omit' });
  if (bound.aborted) { void response.body?.cancel().catch(() => {}); fail(); }
  if (!response.ok || response.redirected || response.url && response.url !== 'https://api.relay.link/chains') fail();
  reader = response.body?.getReader(); if (!reader) fail();
  const chunks = []; let length = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.length; if (length > 2 * 1024 * 1024 || chunks.length >= 4096) fail(); chunks.push(part.value);
    }
    return providerExecutionChainsFromCatalog(p.strictJson(new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(chunks))), { rpcOverrides, feeModels });
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  })();
  try { return await Promise.race([work, cancelled]); } finally { bound.removeEventListener('abort',stop); }
}
