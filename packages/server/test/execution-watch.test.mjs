import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { privateKeyToAccount } from 'viem/accounts';
import { createRouterApi, createRouterHandler } from '../src/index.mjs';
import { ApiError } from '../src/security.mjs';
import { createExecutionStream, createExecutionWatchPool, executionWatchLimits, watchExecution } from '../src/execution-watch.mjs';

class Response extends EventEmitter {
  headers = {}; chunks = []; destroyed = false; writableEnded = false; headersSent = false; blocked = false;
  setHeader(name, value) { this.headers[name] = value; }
  writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); this.headersSent = true; }
  flushHeaders() { this.flushed = true; }
  write(raw) { this.chunks.push(Buffer.from(raw)); return !this.blocked; }
  end(raw) { if (raw) this.chunks.push(Buffer.from(raw)); this.writableEnded = true; this.emit('finish'); }
  destroy() { this.destroyed = true; this.emit('close'); }
  text() { return Buffer.concat(this.chunks).toString(); }
  frames() { return this.text().trim().split('\n').map(JSON.parse); }
}
function writer(options = {}) {
  const res = new Response(), cancelled = [];
  const stream = createExecutionStream(res, { origin: 'https://a.example', requestId: 'req_1', appId: 'app-a', executionId: 'ex_1',
    cancel: reason => cancelled.push(reason), ...options });
  return { res, stream, cancelled };
}
const result = (status = 'SUBMITTED') => ({ execution: { id: 'ex_1', status }, receiptStatus: status === 'COMPLETE' ? 'CONFIRMED' : 'PENDING' });

test('verified delivery reaches the stream immediately without waiting for final confirmation', async () => {
  let mono = 0, calls = 0, running = 0; const stamps = [], controller = new AbortController();
  const f = writer({ now: () => 10000 + mono, clock: () => mono });
  const reason = await watchExecution({ signal: controller.signal, clock: () => mono, sleep: async ms => { mono += ms; },
    refresh: async () => {
      assert.equal(++running, 1); mono += 40; running--; calls++;
      return calls === 3 ? result('COMPLETE') : { ...result(), ...(calls === 2 ? { progress: { stage: 'DESTINATION_CONFIRMED', observedAtMs: 10000 + mono } } : {}) };
    }, update: value => { const detected = mono; f.stream.update(value); stamps.push({ detected, written: mono, frame: f.res.frames().at(-1) }); } });
  assert.equal(reason, 'SETTLED'); assert.equal(calls, 3);
  assert.equal(stamps[1].detected, 290); assert.equal(stamps[1].written - stamps[1].detected, 0);
  assert.equal(stamps[1].frame.progress.stage, 'DESTINATION_CONFIRMED');
  assert.equal(stamps[1].frame.execution.status, 'SUBMITTED');
  assert.equal(stamps[1].frame.sentAtMs - stamps[1].frame.progress.observedAtMs, 0);
  f.stream.end(reason); await f.stream.done;
  assert.deepEqual(f.res.frames().map(frame => frame.type), ['START', 'UPDATE', 'UPDATE', 'UPDATE', 'END']);
  assert.deepEqual(f.res.frames().map(frame => frame.sequence), [0, 1, 2, 3, 4]);
  assert.equal(f.res.headers['X-Accel-Buffering'], 'no'); assert.equal(f.res.flushed, true);
  assert.deepEqual(f.cancelled, []);
});
test('slow proofs never overlap and do not add a browser polling interval', async () => {
  let mono = 0, calls = 0; const sleeps = [];
  await watchExecution({ signal: new AbortController().signal, clock: () => mono,
    sleep: async ms => { sleeps.push(ms); mono += ms; },
    refresh: async () => { mono += 1500; return result(++calls === 2 ? 'COMPLETE' : 'SUBMITTED'); }, update: () => {} });
  assert.deepEqual(sleeps, [25]); assert.equal(mono, 3025);
});
test('watch stops on every non-pending state and never requests another wallet action', async () => {
  for (const status of ['READY', 'CLAIMED', 'CANCELLED', 'EXPIRED', 'COMPLETE', 'FAILED']) {
    let calls = 0;
    const reason = await watchExecution({ signal: new AbortController().signal,
      refresh: async () => { calls++; return result(status); }, update: () => {} });
    assert.equal(calls, 1); assert.equal(reason, ['COMPLETE', 'FAILED'].includes(status) ? 'SETTLED' : 'STATE_CHANGED');
  }
});
test('expired authentication or cancelled checks suppress late delivery updates', async () => {
  for (const mode of ['expire', 'abort']) {
    let expired = false, emitted = 0; const controller = new AbortController();
    const run = watchExecution({ signal: controller.signal,
      authenticate: () => { if (expired) throw new ApiError(401, 'WALLET_AUTH_REQUIRED', 'Expired'); },
      refresh: async () => { if (mode === 'expire') expired = true; else controller.abort(); return result('COMPLETE'); },
      update: () => { emitted++; } });
    if (mode === 'expire') await assert.rejects(run, error => error.code === 'WALLET_AUTH_REQUIRED'); else await run;
    assert.equal(emitted, 0);
  }
});
test('read retries are bounded and semantic errors never retry', async () => {
  for (const code of ['EXECUTION_UNAVAILABLE', 'RECEIPT_BINDING_MISMATCH']) {
    let attempts = 0, mono = 0;
    await assert.rejects(watchExecution({ signal: new AbortController().signal, clock: () => mono,
      sleep: async ms => { mono += ms; }, update: () => {},
      refresh: async () => { attempts++; throw new ApiError(503, code, 'Unavailable', true); } }), error => error.code === code);
    assert.equal(attempts, code === 'EXECUTION_UNAVAILABLE' ? 4 : 1);
  }
});
test('watch connection slots are scoped, bounded, released once, and reusable', () => {
  const pool = createExecutionWatchPool(2), app = { id: 'a', maxConcurrent: 1 }, wallet = { ownerId: 'owner' };
  const one = pool.acquire(app, wallet, 'ex_1');
  assert.throws(() => pool.acquire(app, wallet, 'ex_1'), error => error.code === 'EXECUTION_WATCH_BUSY');
  assert.throws(() => pool.acquire(app, wallet, 'ex_2'), error => error.code === 'EXECUTION_WATCH_BUSY');
  const two = pool.acquire({ ...app, id: 'b' }, wallet, 'ex_1');
  assert.throws(() => pool.acquire({ ...app, id: 'c' }, wallet, 'ex_1'), error => error.code === 'EXECUTION_WATCH_BUSY');
  one(); one(); const next = pool.acquire(app, wallet, 'ex_1'); next(); two();
});
test('disconnect, slow-reader, queue and byte limits abort producer work', async () => {
  for (const mode of ['disconnect', 'drain', 'queue', 'bytes']) {
    const f = writer({ limits: { ...executionWatchLimits, drainMs: 5, ...(mode === 'bytes' ? { totalBytes: 500 } : {}) } });
    if (mode === 'disconnect') f.res.destroy();
    if (mode === 'bytes') f.stream.update({ ...result(), execution: { detail: 'x'.repeat(1000) } });
    if (mode === 'drain' || mode === 'queue') { f.res.blocked = true; f.stream.update(result()); }
    if (mode === 'queue') for (let i = 0; i < 10; i++) f.stream.update(result());
    await assert.rejects(f.stream.done); assert.equal(f.res.destroyed, true); assert.equal(f.cancelled.length, 1);
    assert.equal(f.res.listenerCount('close'), 0); assert.equal(f.res.listenerCount('error'), 0);
  }
});

// Real request handler, fake request/response objects: no socket ever listens.
async function dispatch(server, path, body, headers = {}) {
  const req = new EventEmitter(), res = new Response(), raw = JSON.stringify(body);
  req.method = 'POST'; req.url = path; req.resume = () => {};
  req.rawHeaders = Object.entries({ host: 'localhost', origin: 'https://a.example', 'x-router-app-key': 'pk_a_01234567890123456789',
    'content-type': 'application/json', 'content-length': String(Buffer.byteLength(raw)), ...headers }).flat();
  const done = new Promise((resolve, reject) => { res.once('finish', () => resolve(res)); res.once('close', () => reject(new Error('Unexpected close'))); });
  if (typeof server === 'function') void server(req, res); else server.emit('request', req, res);
  queueMicrotask(() => { req.emit('data', Buffer.from(raw)); req.emit('end'); });
  return done;
}
test('unbound HTTP handler authenticates watch owner and emits terminal result without opening a port', { timeout: 5000 }, async () => {
  const account = privateKeyToAccount('0x' + '03'.repeat(32));
  const app = { id: 'app-a', publishableKey: 'pk_a_01234567890123456789', serverKey: 'sk_a_01234567890123456789',
    allowedOrigins: ['https://a.example'], rateLimitPerMinute: 1000 };
  let owned = null, confirms = 0;
  const store = { get: async () => owned, findActive: async () => null, insert: async () => {}, compareAndSwap: async () => {} };
  const server = createRouterApi({ apps: [app], service: { config: () => ({}), quote: async () => ({}), resolveAsset: async () => ({}) },
    execution: { store, engine: { prepare: async () => {}, recipes: [], verifier: { confirm: async () => { confirms++; } } } } });
  const id = 'ex_11111111-1111-4111-8111-111111111111', path = '/v1/executions/' + id + '/watch';
  assert.equal(server.listening, false);
  const missing = await dispatch(server, path, {}); assert.equal(missing.status, 401);
  const challenge = JSON.parse((await dispatch(server, '/v1/wallets/challenge', { chainId: 'eip155:8453', address: account.address })).text());
  const signature = await account.signMessage({ message: challenge.message });
  const session = JSON.parse((await dispatch(server, '/v1/wallets/verify', { challengeId: challenge.challengeId, signature })).text());
  const auth = { 'x-router-wallet-token': session.walletToken };
  const foreign = await dispatch(server, path, {}, auth); assert.equal(foreign.status, 404); assert.equal(foreign.headers['Content-Type'].startsWith('application/json'), true);
  const { walletOwner } = await import('../src/wallet-auth.mjs');
  owned = { id, ownerId: walletOwner(app.id, session.wallet), status: 'COMPLETE', nextAction: 1,
    request: { source: { chainId: 'eip155:8453' }, sender: account.address }, plan: { actions: [] } };
  const extra = await dispatch(server, path, { another: true }, auth); assert.equal(extra.status, 400);
  const ok = await dispatch(server, path, {}, auth);
  assert.deepEqual(ok.frames().map(frame => frame.type), ['START', 'UPDATE', 'END']);
  assert.equal(ok.frames()[1].execution.status, 'COMPLETE'); assert.equal(ok.frames()[1].execution.ownerId, undefined);
  assert.equal(ok.frames()[2].reason, 'SETTLED'); assert.equal(confirms, 0); assert.equal(server.listening, false);
  const again = await dispatch(server, path, {}, auth); assert.equal(again.status, 200);
});

test('asynchronous watch authentication is awaited before refreshing and before publishing', async () => {
  for (const expireAfterRefresh of [false, true]) {
    let checks = 0, reads = 0, updates = 0;
    await assert.rejects(watchExecution({ signal: new AbortController().signal,
      authenticate: async () => { await Promise.resolve(); checks++; if (!expireAfterRefresh || checks > 1) throw new ApiError(401, 'WALLET_AUTH_REQUIRED', 'Expired'); },
      refresh: async () => { reads++; return result('COMPLETE'); }, update: () => { updates++; } }), { code: 'WALLET_AUTH_REQUIRED' });
    assert.equal(reads, expireAfterRefresh ? 1 : 0); assert.equal(updates, 0);
  }
});

test('standalone router handler accepts an async wallet challenge without creating a server', async () => {
  const handler = createRouterHandler({ apps: [{ id: 'app-a', publishableKey: 'pk_a_01234567890123456789', serverKey: 'sk_a_01234567890123456789', allowedOrigins: ['https://a.example'] }],
    service: { config: () => ({}), quote: async () => ({}), resolveAsset: async () => ({}) },
    walletAuthentication: { challenge: async () => { await Promise.resolve(); return { challengeId: 'shared-challenge' }; }, verify: async () => ({}), authenticate: async () => ({}) } });
  assert.equal(typeof handler, 'function');
  const response = await dispatch(handler, '/v1/wallets/challenge', {});
  assert.equal(response.status, 200); assert.equal(JSON.parse(response.text()).challengeId, 'shared-challenge');
});
