import { isIP } from 'node:net';
import pins from '../config/base-execution-pins.json' with { type: 'json' };
import { createQuoteService, createExecutionEngine, discoverQuoteCatalog, discoverProviderExecutionChains, createAssetBalanceReader } from '../packages/engine/src/index.mjs';
import { createRouterHandler, createRedisWalletAuthStore, createRedisPublicRateLimit } from '../packages/server/src/index.mjs';
import { createRecoverableRedisExecutionStore } from '../packages/server/src/recoverable-redis-execution-store.mjs';
import { createRedisRestCommand } from '../packages/server/src/redis-rest.mjs';
import { single } from '../packages/server/src/security.mjs';

const SOL = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
function credential(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{24,256}$/.test(value) || /REPLACE|EXAMPLE|CHANGEME/.test(value)) throw new Error('PUBLIC_RUNTIME_CONFIGURATION_REQUIRED');
  return value;
}
function json(value, fallback) {
  if (!value) return fallback;
  if (value.length > 65536) throw new Error('PUBLIC_RUNTIME_CONFIGURATION_INVALID');
  const parsed = JSON.parse(value);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('PUBLIC_RUNTIME_CONFIGURATION_INVALID');
  return parsed;
}
function origin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password || url.hostname.includes('*')) throw new Error('PUBLIC_ORIGIN_REQUIRED');
  return value;
}
export function loadPublicRuntimeConfig(env = process.env) {
  // Preview deployments must never reuse production execution state or credentials.
  if (env.VERCEL !== '1' || env.VERCEL_ENV !== 'production') throw new Error('PRODUCTION_RUNTIME_REQUIRED');
  const allowedOrigins = [origin(env.ROUTER_PUBLIC_ORIGIN)];
  if (env.VERCEL_URL) allowedOrigins.push(origin('https://' + env.VERCEL_URL));
  if (env.ROUTER_ALLOWED_ORIGINS_JSON !== undefined) {
    const raw = env.ROUTER_ALLOWED_ORIGINS_JSON;
    if (typeof raw !== 'string' || raw.length > 8192) throw new Error('PUBLIC_ORIGINS_INVALID');
    const additional = JSON.parse(raw);
    if (!Array.isArray(additional) || additional.length > 16 || additional.some(value => typeof value !== 'string')) throw new Error('PUBLIC_ORIGINS_INVALID');
    allowedOrigins.push(...additional.map(origin));
  }
  const namespace = env.ROUTER_REDIS_NAMESPACE;
  if (typeof namespace !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(namespace)) throw new Error('DURABLE_NAMESPACE_REQUIRED');
  const publishableKey = credential(env.ROUTER_PUBLIC_APP_KEY), serverKey = credential(env.ROUTER_SERVER_KEY);
  if (publishableKey === serverKey) throw new Error('SEPARATE_CREDENTIALS_REQUIRED');
  const rpcEndpoints = json(env.ROUTER_EXECUTION_RPC_JSON, undefined);
  const rpcOverrides = json(env.ROUTER_PROVIDER_EXECUTION_RPC_JSON, {});
  const providerKeys = Object.fromEntries(['RELAY_API_KEY', 'AURORA_API_KEY'].filter(key => env[key]).map(key => [key, env[key]]));
  return { allowedOrigins: [...new Set(allowedOrigins)], namespace, providerKeys, rpcEndpoints, rpcOverrides,
    redis: { url: env.UPSTASH_REDIS_REST_URL ?? env.KV_REST_API_URL, token: env.UPSTASH_REDIS_REST_TOKEN ?? env.KV_REST_API_TOKEN },
    apps: [{ id: 'router-public', publishableKey, serverKey, allowedOrigins: [...new Set(allowedOrigins)], rateLimitPerMinute: 100000, maxConcurrent: 32 }] };
}

/** Only trusted on Vercel: its edge overwrites X-Forwarded-For. */
export function vercelClientKey({ req }) {
  const value = single(req, 'x-forwarded-for');
  if (typeof value !== 'string' || !isIP(value.trim())) throw new Error('TRUSTED_CLIENT_ADDRESS_REQUIRED');
  return value.trim();
}

/** Same-origin browser GETs omit Origin. Derive it only from an allowed host and
 * a same-origin Fetch Metadata request, never for server-key authentication. */
export function normalizePublicRequest(req, allowedOrigins) {
  if (req.method !== 'GET' || single(req, 'origin') !== undefined || single(req, 'authorization') !== undefined ||
      single(req, 'sec-fetch-site') !== 'same-origin') return;
  const host = single(req, 'host');
  const value = allowedOrigins.find(item => new URL(item).host === host);
  if (!value) return;
  req.rawHeaders.push('Origin', value);
  req.headers.origin = value;
}

/** Vercel invokes the rewritten function URL. Recover only the exact API path
 * placed in its rewrite query, rejecting extra/duplicate query parameters. */
export function restorePublicApiPath(req) {
  const url = new URL(req.url, 'https://router.invalid');
  const entries = [...url.searchParams];
  if (url.searchParams.getAll('__router_path').length !== 1) return;
  const path = url.searchParams.get('__router_path');
  // Vercel also forwards the named wildcard capture as `path`. Accept only
  // that exact matching capture, never caller-supplied extra query fields.
  const capture = entries.length === 2 && url.searchParams.getAll('path').length === 1 &&
    path.startsWith('/v1/') && url.searchParams.get('path') === path.slice(4);
  if (!(entries.length === 1 || capture)) return;
  if (url.pathname !== '/api/router' && url.pathname !== path) return;
  if (path !== '/healthz' && !/^\/v1\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+){0,2}$/.test(path)) return;
  req.url = path;
}

export async function createPublicRuntime(env = process.env) {
  const config = loadPublicRuntimeConfig(env);
  const command = createRedisRestCommand({ ...config.redis, timeoutMs: 3000 });
  if (await command(['PING']) !== 'PONG') throw new Error('DURABLE_STORAGE_UNAVAILABLE');
  const results = await Promise.allSettled([
    discoverQuoteCatalog({ providerKeys: config.providerKeys }),
    discoverProviderExecutionChains({ rpcOverrides: {
      ...(config.rpcEndpoints?.base?.[0] ? { 'eip155:8453': config.rpcEndpoints.base[0] } : {}),
      ...(config.rpcEndpoints?.solana?.[0] ? { [SOL]: config.rpcEndpoints.solana[0] } : {}), ...config.rpcOverrides } }),
    createRecoverableRedisExecutionStore({ command, namespace: config.namespace + '-executions' }),
  ]);
  if (results[2].status !== 'fulfilled') throw new Error('DURABLE_STORAGE_UNAVAILABLE');
  // Discovery outages must not hide an existing trade. Saved trade reads and
  // pinned recovery recipes remain available; retry discovery on a later request.
  const catalog = results[0].status === 'fulfilled' ? results[0].value : {};
  const providerExecutionChains = results[1].status === 'fulfilled' ? results[1].value : [];
  const store = results[2].value;
  const service = createQuoteService({ ...catalog, providerKeys: config.providerKeys, independentRoutes: true, debridgeRoutes: false });
  const engine = createExecutionEngine({ providerExecutionChains, executionPins: pins, rpcEndpoints: config.rpcEndpoints, providerKeys: config.providerKeys });
  if (!engine.capabilities().walletExecution) throw new Error('EXECUTION_UNAVAILABLE');
  const balanceChains = structuredClone(providerExecutionChains);
  for (const chain of [
    { chainId: 'eip155:8453', vm: 'EVM', rpcUrl: config.rpcEndpoints?.base?.[0] ?? 'https://base-rpc.publicnode.com', nativeCurrency: { address: '0x' + '0'.repeat(40), decimals: 18 } },
    { chainId: SOL, vm: 'SOLANA', rpcUrl: config.rpcEndpoints?.solana?.[0] ?? 'https://solana-rpc.publicnode.com', nativeCurrency: { address: '11111111111111111111111111111111', decimals: 9 } },
  ]) if (!balanceChains.some(value => value.chainId === chain.chainId)) balanceChains.push(chain);
  for (const chain of balanceChains) if (chain.vm === 'SOLANA') chain.rpcUrls = [...new Set([chain.rpcUrl, ...(config.rpcEndpoints?.solana ?? []), 'https://api.mainnet-beta.solana.com'])].slice(0, 3);
  const handler = createRouterHandler({ service, apps: config.apps, execution: { engine, store },
    balances: createAssetBalanceReader({ chains: balanceChains }), maxConcurrent: 32, quoteTimeoutMs: 30000,
    walletAuthStore: createRedisWalletAuthStore({ command, prefix: config.namespace + ':wallet:' }),
    rateLimit: createRedisPublicRateLimit({ command, prefix: config.namespace + ':rate:', clientKey: vercelClientKey }),
  });
  const publicHandler = (req, res) => { restorePublicApiPath(req); normalizePublicRequest(req, config.allowedOrigins); return handler(req, res); };
  publicHandler.refreshAfterMs = Date.now() + (results.some(result => result.status === 'rejected') ? 60000 : 600000);
  return publicHandler;
}
