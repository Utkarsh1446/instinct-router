import { createHash } from 'node:crypto';
import { fault } from './security.mjs';

const script = `local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {count, redis.call('PTTL', KEYS[1])}`;
const digest = value => createHash('sha256').update(value).digest('hex');
const defaults = Object.freeze({ quotes: 30, wallet: 60, recovery: 180, reads: 120 });
/** The caller supplies a trusted client identifier; this module never trusts forwarding headers.
 * Recovery has independent client and global budgets so quote/auth bursts cannot trap a pending trade. */
export function createRedisPublicRateLimit({ command, clientKey, prefix = 'instinct:public-rate:', limits = {}, globalLimits = {} } = {}) {
  if (typeof command !== 'function' || typeof clientKey !== 'function' || typeof prefix !== 'string' || !prefix.length || prefix.length > 128) throw new Error('A Redis command and trusted public client key are required.');
  const client = { ...defaults, ...limits }, global = { quotes: 3000, wallet: 6000, recovery: 18000, reads: 12000, ...globalLimits };
  if (Object.keys(client).some(key => !Object.hasOwn(defaults, key)) || Object.keys(global).some(key => !Object.hasOwn(defaults, key)) ||
      [...Object.values(client), ...Object.values(global)].some(value => !Number.isSafeInteger(value) || value < 1 || value > 1000000)) throw new Error('Invalid public rate limits.');
  return async context => {
    const { app, path } = context;
    const group = path.startsWith('/v1/wallets/') ? 'wallet' : path.startsWith('/v1/quotes') || ['/v1/executions/prepare', '/v1/executions/inspect'].includes(path) ? 'quotes' : path.startsWith('/v1/executions/') ? 'recovery' : 'reads';
    let identity;
    try { identity = await clientKey(context); }
    catch { fault(503, 'RATE_LIMIT_UNAVAILABLE', 'Public request limits are unavailable.', true); }
    if (typeof identity !== 'string' || !identity.length || identity.length > 512) fault(503, 'RATE_LIMIT_UNAVAILABLE', 'Public request limits are unavailable.', true);
    // Only hashes enter the shared store, including app identifiers.
    const keys = [[prefix + group + ':client:' + digest(JSON.stringify([app.id, identity])), client[group]],
      [prefix + group + ':global', global[group]]];
    for (const [key, maximum] of keys) {
      let result;
      try { result = await command(['EVAL', script, '1', key, '60000']); }
      catch { fault(503, 'RATE_LIMIT_UNAVAILABLE', 'Public request limits are unavailable.', true); }
      if (!Array.isArray(result) || result.length !== 2 || !Number.isSafeInteger(result[0]) || result[0] < 1 || !Number.isSafeInteger(result[1]) || result[1] < 0)
        fault(503, 'RATE_LIMIT_UNAVAILABLE', 'Public request limits are unavailable.', true);
      if (result[0] > maximum) fault(429, 'RATE_LIMITED', 'The public request limit has been reached.', true, Math.max(1, result[1]));
    }
  };
}
