/** Redis REST transport. Never retry an ambiguous mutation. Server-only. */
export function createRedisRestCommand({ url, token, fetch: fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  let endpoint;
  try { endpoint = new URL(url); } catch { throw new Error('REDIS_REST_CONFIG_INVALID'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      typeof token !== 'string' || !token.length || /[\r\n]/.test(token) || typeof fetchImpl !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('REDIS_REST_CONFIG_INVALID');
  return async args => {
    if (!Array.isArray(args) || !args.length || args.some(value => !['string', 'number'].includes(typeof value))) throw new Error('REDIS_REST_COMMAND_INVALID');
    try {
      const response = await fetchImpl(endpoint.href, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args), signal: AbortSignal.timeout(timeoutMs), redirect: 'error', cache: 'no-store',
      });
      if (!response.ok) throw new Error();
      const payload = await response.json();
      if (!payload || typeof payload !== 'object' || payload.error || !Object.hasOwn(payload, 'result')) throw new Error();
      return payload.result;
    } catch { throw new Error('REDIS_REST_UNAVAILABLE'); }
  };
}
