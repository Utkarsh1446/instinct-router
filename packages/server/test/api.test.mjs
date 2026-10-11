import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent, request } from 'node:http';
import { performance } from 'node:perf_hooks';
import { createRouterApi } from '../src/index.mjs';
import { ServiceError } from '@instinct/router-engine';
import { createState } from '../src/state.mjs';

const appA = { id: 'app-a', publishableKey: 'pk_a_01234567890123456789', serverKey: 'sk_a_01234567890123456789', allowedOrigins: ['https://a.example'] };
const appB = { id: 'app-b', publishableKey: 'pk_b_01234567890123456789', serverKey: 'sk_b_01234567890123456789', allowedOrigins: ['https://b.example'] };
const input = { source: { chainId: 'eip155:8453', address: '0x' + '0'.repeat(40), decimals: 18 },
  destination: { chainId: 'eip155:8453', address: '0x' + '1'.repeat(40), decimals: 6 }, amount: '0.00005',
  sender: '0x' + '2'.repeat(40), recipient: '0x' + '3'.repeat(40) };
function result(now = Date.now()) {
  return { requestId: 'engine-request', source: input.source, destination: input.destination, amountRaw: '50000000000000',
    candidates: [{ id: 'stable-route', provider: 'relay', executionReady: false }], winner: 'stable-route', validUntilMs: now + 15000,
    execution: { enabled: false, reason: 'No execution recipes.' }, comparisonComplete: true };
}
async function fixture(t, { service = {}, apps = [appA, appB], ...options } = {}) {
  const stub = { config: () => ({ execution: { enabled: false }, capabilities: { pricing: true, walletExecution: false } }),
    resolveAsset: async value => ({ ...value, decimals: 6 }), quote: async () => result(), ...service };
  const server = createRouterApi({ service: stub, apps, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { server, port: server.address().port };
}
function call(f, { path = '/v1/quotes', method = 'POST', value = input, raw, headers = {}, app = appA, auth = 'browser', agent } = {}) {
  const body = raw ?? JSON.stringify(value);
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: f.port, path, method, agent, headers: {
      ...(auth === 'browser' ? { Origin: app.allowedOrigins[0], 'X-Router-App-Key': app.publishableKey } :
        auth === 'server' ? { Authorization: 'Bearer ' + app.serverKey } : {}),
      ...(method === 'POST' ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}), ...headers,
    } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject); req.end(method === 'POST' ? body : undefined);
  });
}
test('health is public while config and browser/server credentials remain distinct and tenant scoped', async t => {
  const f = await fixture(t);
  assert.equal((await call(f, { path: '/healthz', method: 'GET', auth: 'none' })).status, 200);
  assert.equal((await call(f, { path: '/v1/config', method: 'GET', auth: 'none' })).status, 401);
  const config = await call(f, { path: '/v1/config', method: 'GET' });
  assert.equal(config.body.appId, appA.id);
  assert.equal(config.headers['access-control-allow-origin'], appA.allowedOrigins[0]);
  assert.equal(config.headers['access-control-allow-credentials'], undefined);
  assert.equal(config.headers['cache-control'], 'private, no-store');
  assert.equal(config.headers.vary, 'Origin');
  assert.equal((await call(f, { auth: 'server' })).status, 200);
  assert.equal((await call(f, { auth: 'server', headers: { Origin: appA.allowedOrigins[0] } })).status, 403);
  assert.equal((await call(f, { headers: { Origin: appB.allowedOrigins[0] } })).status, 403);
  assert.equal((await call(f, { headers: { Origin: 'null' } })).status, 403);
  assert.equal((await call(f, { headers: { 'X-Router-App-Key': 'unknown_key_012345678901234' } })).status, 401);
  assert.equal((await call(f, { headers: { Authorization: 'Bearer ' + appA.serverKey } })).status, 400);
  assert.equal((await call(f, { headers: { Origin: [appA.allowedOrigins[0], appA.allowedOrigins[0]] } })).status, 400);
  assert.equal((await call(f, { auth: 'none', headers: { Authorization: ['Bearer ' + appA.serverKey, 'Bearer ' + appA.serverKey] } })).status, 400);
  assert.equal((await call(f, { headers: { 'Idempotency-Key': ['one', 'two'] } })).status, 400);
});
test('rate-limit retry hints match the actual app and global rolling-window reset', async t => {
  let stamp = 100000;
  const f = await fixture(t, { now: () => stamp, globalRateLimitPerMinute: 2, apps: [{ ...appA, rateLimitPerMinute: 1 }, appB] });
  assert.equal((await call(f)).status, 200); assert.equal((await call(f, { app: appB })).status, 200);
  stamp += 10000;
  for (const app of [appA, appB]) {
    const blocked = await call(f, { app });
    assert.equal(blocked.status, 429); assert.equal(blocked.body.error.retryAfterMs, 50000);
    assert.equal(blocked.headers['retry-after'], '50');
  }
  stamp += 50000; assert.equal((await call(f)).status, 200);
});
test('large rate windows expire and compact correctly without shifting every timestamp', () => {
  let stamp = 100000;
  const state = createState({ now: () => stamp, maxConcurrent: 1, globalRateLimitPerMinute: 2000,
    quoteTimeoutMs: 1000, maxSnapshots: 1, maxIdempotencyEntries: 1 });
  const app = { id: 'queue', rateLimit: 1500, maxConcurrent: 1 };
  for (let i = 0; i < 1500; i++) { stamp = 100000 + i; state.rate(app); }
  assert.throws(() => state.rate(app), error => error.retryAfterMs === 58501);
  stamp = 161200;
  for (let i = 0; i < 1201; i++) state.rate(app);
  assert.throws(() => state.rate(app), error => error.retryAfterMs === 1);
  stamp++; assert.doesNotThrow(() => state.rate(app));
});
test('a slow body cannot occupy another app body-reader capacity', async t => {
  const f = await fixture(t, { bodyTimeoutMs: 1000, maxConcurrent: 1, apps: [{ ...appA, maxConcurrent: 1 }, appB] });
  const started = new Promise(resolve => f.server.once('request', resolve));
  const slow = request({ hostname: '127.0.0.1', port: f.port, path: '/v1/quotes', method: 'POST',
    headers: { Origin: appA.allowedOrigins[0], 'X-Router-App-Key': appA.publishableKey,
      'Content-Type': 'application/json', 'Content-Length': 100 } }, res => res.resume());
  slow.on('error', () => {}); t.after(() => slow.destroy()); slow.write('{'); await started;
  assert.equal((await call(f)).status, 429);
  assert.equal((await call(f, { app: appB })).status, 200);
  slow.destroy();
});
test('bounded keep-alive reuses a connection after a frontend pause longer than one second', async t => {
  const f = await fixture(t); let connections = 0;
  f.server.on('connection', () => connections++);
  const agent = new Agent({ keepAlive: true, maxSockets: 1 }); t.after(() => agent.destroy());
  assert.equal((await call(f, { path: '/v1/config', method: 'GET', agent })).status, 200);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal((await call(f, { path: '/v1/config', method: 'GET', agent })).status, 200);
  assert.equal(connections, 1); assert.equal(f.server.keepAliveTimeout, 5000); assert.equal(f.server.maxConnections, 128);
});
test('constructor rejects non-string app IDs and non-function clocks before accepting HTTP', () => {
  const service = { config: () => ({}), quote: async () => ({}), resolveAsset: async () => ({}) };
  assert.throws(() => createRouterApi({ service, apps: [{ ...appA, id: 123 }] }), /configuration/);
  assert.throws(() => createRouterApi({ service, apps: [appA], now: 123 }), /clock/);
});
test('an overdue result cannot outrun its timeout timer after event-loop blocking', async t => {
  let count = 0, signal;
  const f = await fixture(t, { quoteTimeoutMs: 10, service: { quote: async (_body, observed) => {
    count++; signal = observed;
    // This deliberately prevents the timeout callback from running. Promise settlement
    // resumes in a microtask before timers, so only the monotonic result gate can win.
    const until = performance.now() + 25;
    while (performance.now() < until) { /* bounded fixture-only event-loop blocking */ }
    assert.equal(signal.aborted, false); return result();
  } } });
  const response = await call(f, { headers: { 'Idempotency-Key': 'overdue-result' } });
  assert.equal(response.status, 504); assert.equal(response.body.error.code, 'QUOTE_TIMEOUT');
  assert.equal(signal.aborted, true); assert.equal(response.body.quoteId, undefined); assert.equal(count, 1);
  // The operation actually settled, so its app slot is available for the next request.
  assert.equal((await call(f)).status, 504); assert.equal(count, 2);
});
test('preflight permits only known app origins and the publishable-key header contract', async t => {
  const f = await fixture(t);
  const headers = { Origin: appA.allowedOrigins[0], 'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type,x-router-app-key,idempotency-key' };
  assert.equal((await call(f, { method: 'OPTIONS', auth: 'none', headers })).status, 204);
  assert.equal((await call(f, { method: 'OPTIONS', auth: 'none', headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call(f, { method: 'OPTIONS', auth: 'none', headers: { ...headers, 'Access-Control-Request-Headers': 'authorization' } })).status, 403);
  assert.equal((await call(f, { method: 'OPTIONS', auth: 'none', headers: { ...headers, 'Access-Control-Request-Method': 'DELETE' } })).status, 403);
});
test('capabilities expose configured asset classes and provider coverage without execution authority', async t => {
  const coverage = [{ id: 'relay', name: 'Relay', enabled: true, reason: null }];
  const classes = ['NATIVE', 'CANONICAL_USDC', 'CUSTOM_TOKEN'];
  const f = await fixture(t, { service: { config: () => ({ providers: coverage, assetClasses: classes,
    capabilities: { pricing: true, walletExecution: false, providerDiscoveryIsAuthorization: false }, execution: { enabled: false } }) } });
  const output = await call(f, { path: '/v1/capabilities', method: 'GET' });
  assert.deepEqual(output.body.providers, coverage); assert.deepEqual(output.body.assetClasses, classes);
  assert.equal(output.body.readOnly, true); assert.equal(output.body.execution.enabled, false);
  assert.equal(output.body.capabilities.walletExecution, false);
  assert.equal(output.body.capabilities.providerDiscoveryIsAuthorization, false);
});
test('quote snapshots bind exact requests, remain owned, and expire without repricing or execution authority', async t => {
  let stamp = 100000, count = 0;
  const returned = result(stamp);
  const f = await fixture(t, { now: () => stamp, service: { quote: async () => { count++; return returned; } } });
  const quote = await call(f);
  assert.equal(quote.status, 200); assert.equal(quote.body.apiVersion, '1'); assert.equal(quote.body.appId, appA.id);
  assert.equal(quote.body.providerRequestId, 'engine-request'); assert.match(quote.body.requestId, /^req_/);
  assert.deepEqual(quote.body.request, input); assert.match(quote.body.requestHash, /^[a-f0-9]{64}$/);
  assert.equal(quote.body.execution.enabled, false); assert.match(quote.body.quoteId, /^q_/);
  returned.candidates[0].id = 'mutated';
  const path = '/v1/quotes/' + quote.body.quoteId;
  assert.deepEqual((await call(f, { path, method: 'GET' })).body, quote.body);
  assert.equal((await call(f, { path, method: 'GET', app: appB })).status, 404);
  assert.equal((await call(f, { path: '/v1/executions/prepare', value: { quoteId: quote.body.quoteId }, app: appB })).status, 404);
  assert.equal((await call(f, { path: '/v1/executions/prepare', value: { quoteId: quote.body.quoteId, candidateId: 'stable-route' } })).status, 501);
  assert.equal((await call(f, { path: '/v1/executions/prepare', value: { quoteId: quote.body.quoteId, candidateId: 'wrong' } })).status, 404);
  stamp += 15001;
  assert.equal((await call(f, { path, method: 'GET' })).status, 410);
  assert.equal(count, 1);
});
test('idempotency coalesces concurrent RFQs, rejects payload changes, namespaces apps and refuses stale replay', async t => {
  let stamp = 100000, count = 0, enter, release;
  const entered = new Promise(resolve => enter = resolve), waiting = new Promise(resolve => release = resolve);
  const f = await fixture(t, { now: () => stamp, apps: [{ ...appA, maxConcurrent: 1 }, appB],
    service: { quote: async () => { count++; enter(); await waiting; return result(stamp); } } });
  const headers = { 'Idempotency-Key': 'logical-quote-1' };
  const first = call(f, { headers }); await entered;
  const second = call(f, { headers });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(count, 1); release();
  const [a, b] = await Promise.all([first, second]); assert.deepEqual(a.body, b.body);
  assert.deepEqual((await call(f, { headers })).body, a.body);
  assert.equal((await call(f, { headers, value: { ...input, amount: '0.1' } })).status, 409);
  assert.equal((await call(f, { headers, app: appB })).status, 200); assert.equal(count, 2);
  stamp += 15001;
  assert.equal((await call(f, { headers })).body.error.code, 'IDEMPOTENCY_EXPIRED');
});
test('unexpected routes, fields, wallets, oversized and malformed bodies never reach the engine', async t => {
  let count = 0;
  const f = await fixture(t, { service: { quote: async () => { count++; return result(); } } });
  for (const path of ['/v1/quotes?url=evil', '/api/quote', '/v1/broadcast', '/v1/quotes/../../secret'])
    assert.equal((await call(f, { path })).status, 404);
  for (const value of [{ ...input, tenantId: 'app-b' }, { ...input, providerURL: 'https://evil.example' },
    { ...input, sender: undefined }, { ...input, source: { ...input.source, url: 'https://evil.example' } }])
    assert.equal((await call(f, { value })).status, 400);
  assert.equal((await call(f, { raw: '[' })).status, 400);
  assert.equal((await call(f, { raw: 'x'.repeat(8193) })).status, 400);
  assert.equal((await call(f, { headers: { 'Content-Type': 'text/plain' } })).status, 400);
  assert.equal((await call(f, { headers: { 'Idempotency-Key': 'x'.repeat(129) } })).status, 400);
  assert.equal(count, 0);
});
test('replay capacity preserves live keys and only forgets expired completed keys', async t => {
  let stamp = 100000, count = 0;
  const f = await fixture(t, { now: () => stamp, maxIdempotencyEntries: 1,
    service: { quote: async () => { count++; return result(stamp); } } });
  const a = { 'Idempotency-Key': 'key-a' }, b = { 'Idempotency-Key': 'key-b' };
  const first = await call(f, { headers: a });
  assert.equal(first.status, 200);
  assert.equal((await call(f, { headers: b })).status, 429);
  assert.deepEqual((await call(f, { headers: a })).body, first.body); assert.equal(count, 1);
  stamp += 15001;
  assert.equal((await call(f, { headers: b })).status, 200); assert.equal(count, 2);
});
test('tenant and global quotas bound work, and timeout does not release a still-running engine operation', async t => {
  let release, count = 0, seenSignal;
  const waiting = new Promise(resolve => release = resolve);
  const f = await fixture(t, { quoteTimeoutMs: 20, maxConcurrent: 1, service: { quote: async (_body, signal) => {
    count++; seenSignal = signal; await waiting; return result();
  } } });
  const timed = await call(f); assert.equal(timed.status, 504); assert.equal(seenSignal.aborted, true);
  assert.equal((await call(f, { app: appB })).status, 429); assert.equal(count, 1);
  release(); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await call(f, { app: appB })).status, 200);
  const limited = await fixture(t, { apps: [{ ...appA, rateLimitPerMinute: 1 }, appB] });
  assert.equal((await call(limited)).status, 200);
  assert.equal((await call(limited)).body.error.code, 'RATE_LIMITED');
  assert.equal((await call(limited, { app: appB })).status, 200);
});
test('engine and internal errors never expose credential or upstream text', async t => {
  for (const error of [new Error('secret-key https://upstream.invalid'), new ServiceError('TOKEN_NOT_FOUND', 'secret-key https://upstream.invalid', 400)]) {
    const f = await fixture(t, { service: { quote: async () => { throw error; } } });
    const output = await call(f);
    assert.doesNotMatch(output.text, /secret-key|upstream.invalid/);
    assert.equal(output.body.apiVersion, '1'); assert.match(output.body.requestId, /^req_/);
  }
});
test('disconnecting the last subscriber aborts the underlying RFQ', async t => {
  let entered, count = 0, observed;
  const started = new Promise(resolve => entered = resolve);
  const f = await fixture(t, { service: { quote: async (_body, signal) => {
    count++; observed = signal; entered();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); return result();
  } } });
  const req = request({ hostname: '127.0.0.1', port: f.port, path: '/v1/quotes', method: 'POST',
    headers: { Origin: appA.allowedOrigins[0], 'X-Router-App-Key': appA.publishableKey,
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(JSON.stringify(input)) } });
  req.on('error', () => {}); req.end(JSON.stringify(input)); await started;
  const aborted = new Promise(resolve => observed.addEventListener('abort', resolve, { once: true }));
  req.destroy(); await aborted; assert.equal(observed.aborted, true); assert.equal(count, 1);
});
test('duplicate JSON fields, including escaped and nested keys, are rejected before provider work', async t => {
  let count = 0;
  const f = await fixture(t, { service: { quote: async () => { count++; return result(); } } });
  const valid = JSON.stringify(input);
  for (const raw of [valid.slice(0, -1) + ',"sender":"other"}',
    valid.slice(0, -1) + ',"sen\\u0064er":"other"}',
    valid.replace('"decimals":18', '"decimals":18,"decimals":6'),
    valid.slice(0, -1) + ',"__proto__":{}}', '{"a":'.repeat(12) + '0' + '}'.repeat(12),
    Buffer.from([0xff])]) assert.equal((await call(f, { raw })).status, 400);
  assert.equal(count, 0);
});
test('an incomplete body times out without invoking the engine or consuming RFQ capacity', async t => {
  let count = 0;
  const f = await fixture(t, { bodyTimeoutMs: 20, maxConcurrent: 1, service: { quote: async () => { count++; return result(); } } });
  const response = await new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: f.port, path: '/v1/quotes', method: 'POST',
      headers: { Origin: appA.allowedOrigins[0], 'X-Router-App-Key': appA.publishableKey,
        'Content-Type': 'application/json', 'Content-Length': 100 } }, res => {
      res.resume(); res.on('end', () => { req.destroy(); resolve(res.statusCode); });
    });
    req.on('error', reject); req.write('{');
  });
  assert.equal(response, 408); assert.equal(count, 0);
  assert.equal((await call(f, { app: appB })).status, 200);
});
test('one disconnected idempotency subscriber does not cancel the remaining subscriber', async t => {
  let entered, release, count = 0, signal;
  const started = new Promise(resolve => entered = resolve), waiting = new Promise(resolve => release = resolve);
  const f = await fixture(t, { service: { quote: async (_body, observed) => {
    count++; signal = observed; entered(); await waiting; return result();
  } } });
  const headers = { 'Idempotency-Key': 'shared-disconnect' };
  const req = request({ hostname: '127.0.0.1', port: f.port, path: '/v1/quotes', method: 'POST',
    headers: { Origin: appA.allowedOrigins[0], 'X-Router-App-Key': appA.publishableKey, ...headers,
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(JSON.stringify(input)) } });
  req.on('error', () => {}); req.end(JSON.stringify(input)); await started;
  const second = call(f, { headers });
  await new Promise(resolve => setTimeout(resolve, 10));
  req.destroy(); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(signal.aborted, false); assert.equal(count, 1);
  release(); assert.equal((await second).status, 200);
});

test('injected asynchronous auth and public limiter are awaited and failures prevent provider work', async t => {
  let quoted = 0, challenges = 0, limits = 0, fail = false;
  const f = await fixture(t, { service: { quote: async () => { quoted++; return result(); } },
    globalRateLimitPerMinute: 1, apps: [{ ...appA, rateLimitPerMinute: 1 }],
    walletAuthentication: { challenge: async () => { await Promise.resolve(); challenges++; return { challengeId: 'test-shared-proof' }; }, verify: async () => ({}), authenticate: async () => ({}) },
    rateLimit: async () => { await Promise.resolve(); limits++; if (fail) throw new Error('private limiter error'); } });
  const proof = await call(f, { path: '/v1/wallets/challenge', value: {} });
  assert.equal(proof.body.challengeId, 'test-shared-proof'); assert.equal(challenges, 1);
  assert.equal((await call(f)).status, 200); assert.equal(quoted, 1);
  fail = true;
  const blocked = await call(f); assert.equal(blocked.status, 503); assert.equal(quoted, 1); assert.equal(limits, 3);
  assert.equal(blocked.text.includes('private'), false);
});
