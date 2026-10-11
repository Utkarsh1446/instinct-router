import { open, constants } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Read credentials without following links or accepting shared-readable files. */
export async function readOwnedJson(path) {
  const file = await open(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 65536 || (info.mode & 0o077) || info.uid !== process.getuid())
      throw new Error('Use an owner-only JSON configuration file of at most 64 KiB.');
    return JSON.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
}

export async function loadRuntimeConfig(env = process.env) {
  const settings = await readOwnedJson(env.ROUTER_APPS_FILE ?? new URL('../.dev/apps.json', import.meta.url).pathname);
  if (!settings || Object.keys(settings).some(key => key !== 'apps') || !Array.isArray(settings.apps) ||
      settings.apps.some(app => /REPLACE|EXAMPLE|CHANGEME/i.test(app.serverKey ?? '')))
    throw new Error('Configure actual app credentials before starting the router.');
  const providerKeys = env.ROUTER_PROVIDER_KEYS_FILE ? await readOwnedJson(env.ROUTER_PROVIDER_KEYS_FILE) : {};
  if (!providerKeys || Array.isArray(providerKeys) || Object.keys(providerKeys).some(key => !['RELAY_API_KEY', 'AURORA_API_KEY'].includes(key)))
    throw new Error('Provider credentials must contain only RELAY_API_KEY and AURORA_API_KEY.');
  for (const field of ['RELAY_API_KEY', 'AURORA_API_KEY']) if (env[field]) providerKeys[field] = env[field];
  const policy = env.ROUTER_POLICY_FILE ? await readOwnedJson(env.ROUTER_POLICY_FILE) : {};
  if (!policy || Array.isArray(policy) || Object.keys(policy).some(key => !['auroraPolicy', 'chainTiming', 'independentRoutes', 'debridgeRoutes', 'discoverChains'].includes(key)) ||
      policy.discoverChains !== undefined && typeof policy.discoverChains !== 'boolean')
    throw new Error('Provider policy supports auroraPolicy, chainTiming, independentRoutes, debridgeRoutes and boolean discoverChains.');
  const executionPins = env.ROUTER_EXECUTION_PINS_FILE ? await readOwnedJson(env.ROUTER_EXECUTION_PINS_FILE) : null;
  if (env.ROUTER_EXECUTION_STORE_DIR && !executionPins) throw new Error('Execution storage requires reviewed execution pins.');
  if (env.ROUTER_EXECUTION_RPC_FILE && !executionPins) throw new Error('Execution RPC configuration requires reviewed execution pins.');
  if (env.ROUTER_PROVIDER_EXECUTION_RPC_FILE && executionPins?.providerManaged?.enabled !== true) throw new Error('Provider execution RPC configuration requires explicit providerManaged enablement.');
  const providerExecutionRpcOverrides = env.ROUTER_PROVIDER_EXECUTION_RPC_FILE ? await readOwnedJson(env.ROUTER_PROVIDER_EXECUTION_RPC_FILE) : undefined;
  if (providerExecutionRpcOverrides !== undefined && (!providerExecutionRpcOverrides || Array.isArray(providerExecutionRpcOverrides) || Object.keys(providerExecutionRpcOverrides).length > 128 || Object.entries(providerExecutionRpcOverrides).some(([chainId,url]) => !/^(?:eip155:[1-9][0-9]*|solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp)$/.test(chainId) || typeof url !== 'string'))) throw new Error('Provider RPC overrides require a chain-to-HTTPS endpoint mapping.');
  const executionRpcEndpoints = env.ROUTER_EXECUTION_RPC_FILE ? await readOwnedJson(env.ROUTER_EXECUTION_RPC_FILE) : undefined;
  return { apps: settings.apps, providerKeys, ...policy, ...(executionPins ? { executionPins,
    ...(env.ROUTER_EXECUTION_RPC_FILE ? { executionRpcEndpoints } : {}),
    ...(providerExecutionRpcOverrides ? { providerExecutionRpcOverrides } : {}),
    executionStoreDirectory: resolve(env.ROUTER_EXECUTION_STORE_DIR ?? new URL('../.dev/executions', import.meta.url).pathname) } : {}) };
}

export function port(value, fallback) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1024 || parsed > 65535) throw new Error('Choose a port from 1024 to 65535.');
  return parsed;
}
