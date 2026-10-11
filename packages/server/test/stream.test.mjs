import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { EventEmitter } from 'node:events';
import { createRouterApi } from '../src/index.mjs';
import { createQuoteStream, streamLimits } from '../src/io.mjs';
const app = { id: 'stream-app', publishableKey: 'pk_stream_01234567890123456789', serverKey: 'sk_stream_01234567890123456789', allowedOrigins: ['https://stream.example'] };
const other = { id: 'other-app', publishableKey: 'pk_other_01234567890123456789', serverKey: 'sk_other_01234567890123456789', allowedOrigins: ['https://other.example'] };
const input = { source: { chainId: 'eip155:8453', address: '0x' + '0'.repeat(40), decimals: 18 },
  destination: { chainId: 'eip155:8453', address: '0x' + '1'.repeat(40), decimals: 6 }, amount: '0.00005',
  sender: '0x' + '2'.repeat(40), recipient: '0x' + '3'.repeat(40) };
const candidate = { id: 'route', provider: 'relay', minimumOutputRaw: '100', expectedOutputRaw: '101', eligible: true, executionReady: false };
const result = () => ({ requestId: 'engine-request', candidates: [candidate], winner: 'route', validUntilMs: Date.now() + 15000, comparisonComplete: true });
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
async function fixture(t, quote, options = {}) {
  const server = createRouterApi({ service: { config: () => ({}), resolveAsset: async () => ({}), quote }, apps: [app, other], ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { port: server.address().port };
}
function call(f, { path = '/v1/quotes/stream', value = input, account = app, headers = {}, onEvent = () => {}, method = 'POST' } = {}) {
  const body = JSON.stringify(value);
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: f.port, path, method, headers: {
      Origin: account.allowedOrigins[0], 'X-Router-App-Key': account.publishableKey,
      ...(method === 'POST' ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}), ...headers,
    } }, res => {
      let raw = '', buffered = ''; const events = [], ended = deferred();
      res.setEncoding('utf8');
      res.on('data', chunk => {
        raw += chunk;
        if (!res.headers['content-type']?.startsWith('application/x-ndjson')) return;
        buffered += chunk;
        while (buffered.includes('\n')) {
          const split = buffered.indexOf('\n'), row = JSON.parse(buffered.slice(0, split));
          buffered = buffered.slice(split + 1); events.push(row); onEvent(row);
        }
      });
      res.once('end', () => ended.resolve({ raw, events, body: events.length ? null : raw ? JSON.parse(raw) : null }));
      res.on('error', () => ended.resolve({ raw, events, disconnected: true }));
      resolve({ req, res, status: res.statusCode, headers: res.headers, events, ended: ended.promise });
    });
    req.once('error', reject); req.end(method === 'POST' ? body : undefined);
  });
}

test('first provisional result precedes slow-provider completion and final snapshot is owned, stable and not replayed', async t => {
  const release = deferred(), arrived = deferred(); let invocations = 0, complete = false;
  const f = await fixture(t, async (_body, _signal, emit) => {
    invocations++; emit?.(structuredClone(candidate)); await release.promise; complete = true; return result();
  });
  const response = await call(f, { onEvent: row => { if (row.type === 'CANDIDATE') arrived.resolve(row); } });
  const first = await arrived.promise;
  assert.equal(complete, false); assert.equal(first.provisional, true); assert.equal(first.comparisonComplete, false);
  assert.equal(response.status, 200); assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.equal(response.headers['x-accel-buffering'], 'no');
  assert.equal(response.headers['access-control-allow-origin'], app.allowedOrigins[0]);
  release.resolve(); const { events } = await response.ended;
  assert.deepEqual(events.map(row => row.type), ['START', 'CANDIDATE', 'COMPLETE']);
  assert.deepEqual(events.map(row => row.sequence), [0, 1, 2]);
  for (const row of events) {
    assert.equal(row.apiVersion, '1'); assert.equal(row.appId, app.id); assert.equal(row.requestId, first.requestId);
    assert.deepEqual(row.request, input);
  }
  const last = events.at(-1), quote = last.quote;
  assert.equal(last.provisional, false); assert.equal(last.comparisonComplete, true);
  assert.match(quote.quoteId, /^q_/); assert.match(quote.requestHash, /^[a-f0-9]{64}$/);
  assert.equal(quote.providerRequestId, 'engine-request'); assert.equal(quote.requestId, first.requestId);
  assert.equal(quote.execution.enabled, false); assert.deepEqual(quote.candidates[0], first.candidate);
  const saved = await call(f, { path: '/v1/quotes/' + quote.quoteId, method: 'GET' });
  assert.deepEqual((await saved.ended).body, quote);
  const denied = await call(f, { path: '/v1/quotes/' + quote.quoteId, method: 'GET', account: other });
  assert.equal(denied.status, 404);
  const again = await call(f); const next = await again.ended; assert.equal(invocations, 2);
  assert.notEqual(next.events.at(-1).quote.quoteId, quote.quoteId);
  const normal = await call(f, { path: '/v1/quotes' }); const normalQuote = (await normal.ended).body;
  assert.equal(normalQuote.requestHash, quote.requestHash); assert.deepEqual(normalQuote.candidates, quote.candidates);
  assert.equal(invocations, 3);
});

test('stream has the same strict auth/body gates, rejects idempotency, and cannot create executions', async t => {
  let calls = 0; const f = await fixture(t, async () => { calls++; return result(); });
  for (const options of [{ headers: { 'X-Router-App-Key': 'bad' } }, { headers: { Origin: other.allowedOrigins[0] } },
    { headers: { 'Idempotency-Key': 'retry' } }, { value: { ...input, providerUrl: 'https://bad.example' } },
    { value: { ...input, sender: undefined } }]) {
    const response = await call(f, options); assert.ok(response.status >= 400); await response.ended;
  }
  assert.equal(calls, 0);
  const stream = await call(f); const { events } = await stream.ended;
  const execution = await call(f, { path: '/v1/executions/prepare', value: { quoteId: events.at(-1).quote.quoteId } });
  assert.equal(execution.status, 501); assert.equal((await execution.ended).body.error.code, 'EXECUTION_ADAPTER_UNAVAILABLE');
});

test('stream consumes the same app rate window as normal quotes', async t => {
  const f = await fixture(t, async () => result(), { apps: [{ ...app, rateLimitPerMinute: 1 }] });
  const first = await call(f); await first.ended;
  const blocked = await call(f, { path: '/v1/quotes' });
  assert.equal(blocked.status, 429); assert.equal((await blocked.ended).body.error.code, 'RATE_LIMITED');
});

test('errors after START are sanitized terminal events with no implicit retry', async t => {
  let calls = 0;
  const f = await fixture(t, async (_body, _signal, emit) => { calls++; emit(candidate); throw new Error('provider-secret URL body'); });
  const response = await call(f), { events, raw } = await response.ended;
  assert.deepEqual(events.map(row => row.type), ['START', 'CANDIDATE', 'ERROR']);
  assert.equal(events.at(-1).error.code, 'ROUTER_UNAVAILABLE'); assert.equal(events.at(-1).provisional, true);
  assert.doesNotMatch(raw, /provider-secret|URL body/); assert.equal(calls, 1);
});

test('deadline and disconnect abort underlying work but ignored abort retains concurrency capacity', async t => {
  const started = deferred(), release = deferred(); let seenSignal;
  const f = await fixture(t, async (_body, signal) => { seenSignal = signal; started.resolve(); await release.promise; return result(); },
    { maxConcurrent: 1, quoteTimeoutMs: 40 });
  const first = await call(f); await started.promise;
  const { events } = await first.ended; assert.equal(events.at(-1).error.code, 'QUOTE_TIMEOUT');
  assert.equal(seenSignal.aborted, true);
  const busy = await call(f); assert.equal(busy.status, 429); await busy.ended;
  release.resolve(); await new Promise(resolve => setImmediate(resolve));
  const next = await call(f); assert.equal(next.status, 200); await next.ended;
  const disconnectStarted = deferred(), disconnected = deferred(), ignored = deferred(); let activeSignal;
  const second = await fixture(t, async (_body, signal) => {
    activeSignal = signal; signal.addEventListener('abort', () => disconnected.resolve(), { once: true });
    disconnectStarted.resolve(); await ignored.promise; return result();
  }, { maxConcurrent: 1, quoteTimeoutMs: 1000 });
  const socket = await call(second); await disconnectStarted.promise; socket.res.destroy(); await disconnected.promise;
  assert.equal(activeSignal.aborted, true);
  const held = await call(second); assert.equal(held.status, 429); await held.ended;
  ignored.resolve();
});

class FakeResponse extends EventEmitter {
  rows = []; destroyed = false; writableEnded = false; blocked = false;
  writeHead(status, headers) { this.status = status; this.headers = headers; }
  flushHeaders() {}
  write(raw) { this.rows.push(JSON.parse(raw.toString())); return !this.blocked; }
  end() { this.writableEnded = true; }
  destroy() { this.destroyed = true; this.emit('close'); }
}
function writer(res, extra = {}) {
  const cancelled = [];
  const stream = createQuoteStream(res, { requestId: 'req_test', appId: app.id, request: input,
    cancel: value => cancelled.push(value), ...extra });
  return { stream, cancelled };
}
test('candidate and byte bounds emit contiguous sanitized error, never publish oversized data', async () => {
  for (const large of [true, false]) {
    const res = new FakeResponse(), { stream, cancelled } = writer(res);
    if (large) stream.candidate({ payload: 'x'.repeat(streamLimits.lineBytes) });
    else for (let i = 0; i < streamLimits.candidates + 1; i++) stream.candidate(candidate);
    await stream.done;
    assert.equal(res.rows.at(-1).type, 'ERROR'); assert.equal(res.rows.at(-1).error.code, 'STREAM_LIMIT');
    assert.deepEqual(res.rows.map(row => row.sequence), res.rows.map((_row, index) => index));
    assert.deepEqual(cancelled, ['STREAM_LIMIT']); assert.equal(res.rows.some(row => row.candidate?.payload), false);
  }
});
test('bounded backpressure queue discards unpublished events without sequence gaps and cancels producer', async () => {
  const res = new FakeResponse(); res.blocked = true;
  const { stream, cancelled } = writer(res);
  for (let i = 0; i < streamLimits.queuedEvents + 1; i++) stream.candidate(candidate);
  assert.deepEqual(cancelled, ['STREAM_LIMIT']);
  res.blocked = false; res.emit('drain'); await stream.done;
  assert.deepEqual(res.rows.map(row => [row.type, row.sequence]), [['START', 0], ['ERROR', 1]]);
});
test('slow readers have a bounded drain timeout and total bytes remain bounded', async () => {
  const blocked = new FakeResponse(); blocked.blocked = true;
  const { stream, cancelled } = writer(blocked, { limits: { ...streamLimits, drainMs: 10 } });
  await assert.rejects(stream.done, error => error.code === 'STREAM_BACKPRESSURE');
  assert.equal(blocked.destroyed, true); assert.deepEqual(cancelled, ['STREAM_BACKPRESSURE']);
  const res = new FakeResponse(), large = writer(res);
  for (let i = 0; i < 20; i++) large.stream.candidate({ text: 'x'.repeat(120000) });
  await large.stream.done;
  assert.equal(res.rows.at(-1).error.code, 'STREAM_LIMIT');
  assert.ok(res.rows.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row) + '\n'), 0) <= streamLimits.totalBytes);
});

test('repeated short drains cannot extend the absolute writer deadline or emit late COMPLETE', async () => {
  let stamp = 0;
  const res = new FakeResponse(); res.blocked = true;
  const { stream, cancelled } = writer(res, { lifetimeMs: 20, clock: () => stamp, limits: { ...streamLimits, drainMs: 1000 } });
  for (let i = 0; i < 10; i++) stream.candidate(candidate);
  stream.complete({ comparisonComplete: true });
  for (let i = 0; i < 4; i++) {
    stamp += 5; res.emit('drain'); await new Promise(resolve => setImmediate(resolve));
  }
  await assert.rejects(stream.done, error => error.code === 'STREAM_TIMEOUT');
  assert.equal(res.destroyed, true); assert.deepEqual(cancelled, ['STREAM_TIMEOUT']);
  assert.ok(res.rows.some(row => row.type === 'CANDIDATE'));
  assert.equal(res.rows.some(row => row.type === 'COMPLETE'), false);
  assert.equal(res.listenerCount('close'), 0); assert.equal(res.listenerCount('error'), 0);
});

test('clean completion clears writer lifetime and transport listeners', async () => {
  const res = new FakeResponse(), { stream, cancelled } = writer(res, { lifetimeMs: 10 });
  stream.complete({ comparisonComplete: true }); await stream.done;
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(res.destroyed, false); assert.deepEqual(cancelled, []);
  assert.equal(res.listenerCount('close'), 0); assert.equal(res.listenerCount('error'), 0);
});
