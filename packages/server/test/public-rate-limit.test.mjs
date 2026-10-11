import test from 'node:test';
import assert from 'node:assert/strict';
import { createRedisPublicRateLimit } from '../src/index.mjs';

function fixture() {
  let now = 1000; const rows = new Map(), seen = [];
  const command = async parts => {
    seen.push(parts); const key = parts[3]; let row = rows.get(key);
    if (!row || row.expires <= now) { row = { count: 0, expires: now + Number(parts[4]) }; rows.set(key, row); }
    return [++row.count, row.expires - now];
  };
  return { command, seen, advance: ms => { now += ms; } };
}
const context = (path, client = '203.0.113.10') => ({ req: { trustedClient: client }, app: { id: 'public-app' }, path });
const clientKey = ({ req }) => req.trustedClient;
test('public client limits are shared, hash identifiers, give reset hints and isolate recovery budgets', async () => {
  const f = fixture();
  const make = () => createRedisPublicRateLimit({ command: f.command, clientKey, limits: { quotes: 1, wallet: 1, recovery: 2 } });
  const first = make(), second = make();
  await first(context('/v1/quotes'));
  await assert.rejects(second(context('/v1/quotes/stream')), error => error.code === 'RATE_LIMITED' && error.retryAfterMs === 60000);
  await second(context('/v1/wallets/challenge'));
  await assert.rejects(first(context('/v1/wallets/verify')), { code: 'RATE_LIMITED' });
  await first(context('/v1/executions/active'));
  await second(context('/v1/executions/ex_1/refresh'));
  await assert.rejects(first(context('/v1/executions/ex_1/watch')), { code: 'RATE_LIMITED' });
  await first(context('/v1/quotes', '203.0.113.11'));
  assert.equal(JSON.stringify(f.seen).includes('203.0.113.'), false);
  assert.equal(JSON.stringify(f.seen).includes('public-app'), false);
  f.advance(60000);
  await second(context('/v1/quotes'));
});
test('global limits constrain distributed clients separately from recovery', async () => {
  const f = fixture(), limit = createRedisPublicRateLimit({ command: f.command, clientKey, globalLimits: { quotes: 1 } });
  await limit(context('/v1/quotes', 'client-a'));
  await assert.rejects(limit(context('/v1/quotes', 'client-b')), { code: 'RATE_LIMITED' });
  await limit(context('/v1/executions/active', 'client-b'));
});
test('missing client identity, invalid command results and unavailable Redis all fail closed', async () => {
  for (const options of [
    { command: async () => [1, 60000], clientKey: () => undefined },
    { command: async () => { throw new Error('private Redis URL'); }, clientKey },
    { command: async () => [1, -1], clientKey },
    { command: async () => 'unexpected', clientKey },
  ]) {
    await assert.rejects(createRedisPublicRateLimit(options)(context('/v1/quotes')), error => error.code === 'RATE_LIMIT_UNAVAILABLE' && !error.message.includes('private'));
  }
});
