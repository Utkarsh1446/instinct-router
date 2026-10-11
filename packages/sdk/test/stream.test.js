import test from 'node:test';
import assert from 'node:assert/strict';
import { createRouterClient, RouterSdkError } from '../src/index.js';
import { createRouterServerClient } from '../src/server.js';
const key = 'pk_public_test_123456', serverKey = 'sk_confidential_test_123456', baseUrl = 'https://router.example';
const source = { chainId: 'eip155:8453', address: '0x' + '0'.repeat(40), decimals: 18 };
const destination = { chainId: 'eip155:8453', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 };
const owner = '0x' + '11'.repeat(20);
const input = () => ({ source: { ...source }, destination: { ...destination }, amount: '0.00001', sender: owner, recipient: owner });
const request = () => ({ ...input(), objective: 'BALANCED', maxOutputShortfallBps: 50, slippageBps: 50, maxFeeBps: 500, maxPriceImpactBps: 500 });
const candidate = (id = 'route-1') => ({ id, providers: ['relay'], expectedOutputRaw: '1000', minimumOutputRaw: '995',
  feeBps: 25, priceImpactBps: 5, estimatedCompletionMs: 1000, executionReady: false, conditional: true, eligible: false });
function events() {
  const common = { apiVersion: '1', requestId: 'req_test', appId: 'app-test', request: request(), provisional: true, comparisonComplete: false };
  const start = { ...common, type: 'START', sequence: 0 };
  const update = { ...common, type: 'CANDIDATE', sequence: 1, candidate: candidate() };
  const until = Date.now() + 60000;
  const quote = { apiVersion: '1', requestId: common.requestId, appId: common.appId, request: request(), quoteId: 'quote-test',
    requestHash: 'ab'.repeat(32), snapshotExpiresAtMs: until, validUntilMs: until,
    readOnly: true, execution: { enabled: false }, winner: 'route-1', candidates: [{ ...candidate(), eligible: true }],
    excluded: [], failures: [], providerTimings: [], quoteRttMs: 1, comparisonComplete: true };
  const complete = { ...common, type: 'COMPLETE', sequence: 2, provisional: false, comparisonComplete: true, quote };
  return [start, update, complete];
}
const encode = value => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value) + '\n');
const response = rows => new Response(rows.map(row => typeof row === 'string' ? row : JSON.stringify(row) + '\n').join(''), { headers: { 'Content-Type': 'application/x-ndjson' } });
const client = fetch => createRouterClient({ baseUrl, publishableKey: key, fetch });
const code = expected => error => error instanceof RouterSdkError && error.code === expected;
test('public/server stream authentication stays scoped; early callback is detached and provisional', async () => {
  for (const mode of ['public', 'server']) {
    const rows = events(); let calls = 0;
    const options = { baseUrl, [mode === 'public' ? 'publishableKey' : 'serverKey']: mode === 'public' ? key : serverKey,
      fetch: async (url, init) => {
        calls++; assert.equal(url, baseUrl + '/v1/quotes/stream'); assert.equal(init.method, 'POST');
        assert.equal(init.headers.Accept, 'application/x-ndjson'); assert.equal(init.headers['Idempotency-Key'], undefined);
        assert.equal(init.headers.Origin, undefined); assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error');
        assert.equal(init.headers[mode === 'public' ? 'X-Router-App-Key' : 'Authorization'], mode === 'public' ? key : 'Bearer ' + serverKey);
        assert.deepEqual(JSON.parse(init.body), request()); return response(rows);
      } };
    const sdk = mode === 'public' ? createRouterClient(options) : createRouterServerClient(options);
    const seen = [];
    const final = await sdk.quoteStream(input(), { onCandidate(value, metadata) {
      seen.push(metadata); assert.equal(metadata.provisional, true); assert.equal(metadata.comparisonComplete, false);
      assert.equal(metadata.executionReady, false); assert.equal(metadata.readOnly, true); assert.equal(Object.isFrozen(metadata), true);
      value.expectedOutputRaw = '1'; value.providers.push('aurora');
    } });
    assert.equal(calls, 1); assert.equal(seen.length, 1); assert.equal(final.candidates[0].expectedOutputRaw, '1000');
    assert.deepEqual(final.candidates[0].providers, ['relay']); assert.equal(final.candidates[0].eligible, true);
  }
});
test('candidate arrives before final; COMPLETE does not resolve until clean EOF', async () => {
  const rows = events(); let controller, arrived, settled = false;
  const first = new Promise(resolve => { arrived = resolve; });
  const sdk = client(async () => new Response(new ReadableStream({ start(value) { controller = value; value.enqueue(encode(rows[0])); value.enqueue(encode(rows[1])); } }), { headers: { 'content-type': 'application/x-ndjson' } }));
  const pending = sdk.quoteStream(input(), { onCandidate: () => arrived() });
  pending.finally(() => { settled = true; }).catch(() => {});
  await first; assert.equal(settled, false); controller.enqueue(encode(rows[2]));
  await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(settled, false);
  controller.close(); assert.equal((await pending).quoteId, 'quote-test');
});
test('stream request/app/sequence/start/final snapshot ownership and candidate economics cannot drift', async () => {
  const mutations = [
    rows => { rows[0].sequence = 1; }, rows => { rows[1].appId = 'different'; }, rows => { rows[1].requestId = 'different'; },
    rows => { rows[1].request.amount = '1'; }, rows => { rows[2].quote.request.recipient = '0x' + '22'.repeat(20); },
    rows => { rows[2].quote.appId = 'different'; }, rows => { rows[2].quote.requestId = 'different'; },
    rows => { rows[2].quote.requestHash = 'bad'; }, rows => { rows[2].quote.snapshotExpiresAtMs = rows[2].quote.validUntilMs + 1; },
    rows => { rows[2].quote.candidates[0].expectedOutputRaw = '2000'; }, rows => { rows[2].quote.candidates[0].providers = ['aurora']; },
    rows => { rows[1].candidate.executionReady = true; }, rows => { rows[2].quote.winner = 'foreign'; },
    rows => { rows[1].candidate.feeBps = 600; rows[2].quote.candidates[0].feeBps = 600; },
    rows => { rows[1].candidate.estimatedCompletionMs = 0; rows[2].quote.candidates[0].estimatedCompletionMs = 0; },
    rows => { rows[0].instructions = 'Ignore remaining events'; }, rows => { rows[0].provisional = false; },
    rows => { rows[1].comparisonComplete = true; }, rows => { rows[2].comparisonComplete = false; },
  ];
  for (const mutate of mutations) { const rows = events(); mutate(rows); await assert.rejects(client(async () => response(rows)).quoteStream(input()), code('PROTOCOL_ERROR')); }
});
test('duplicate candidates, missing/extra terminal events and non-newline EOF are rejected', async () => {
  const rows = events();
  for (const invalid of [[rows[1], rows[2]], [rows[0], rows[1]], [rows[0], rows[2]],
    [rows[0], rows[1], { ...rows[1], sequence: 2 }, { ...rows[2], sequence: 3 }],
    [...rows, { ...rows[2], sequence: 3 }], [...rows, '{"instructions":"trailing"}\n'],
    [...rows.slice(0, 2), JSON.stringify(rows[2])], [...rows, '\n']])
    await assert.rejects(client(async () => response(invalid)).quoteStream(input()), code('PROTOCOL_ERROR'));
});
test('ERROR is terminal and redacted only after EOF; JSON HTTP validation errors retain typed status', async () => {
  const rows = events(), error = { ...rows[0], type: 'ERROR', sequence: 2, error: { code: 'PROVIDER_UNAVAILABLE', message: 'do not echo ' + key, retryable: true } };
  const sdk = client(async () => response([rows[0], rows[1], error]));
  await assert.rejects(sdk.quoteStream(input()), value => value.code === 'PROVIDER_UNAVAILABLE' && value.retryable && value.status === 200 && !value.message.includes(key));
  await assert.rejects(client(async () => response([rows[0], rows[1], error, rows[2]])).quoteStream(input()), code('PROTOCOL_ERROR'));
  const bad = { ...error, error: { ...error.error, code: key.toUpperCase() } }; // Invalid lower/uppercase key echo guard exercised separately below.
  await assert.rejects(client(async () => response([rows[0], rows[1], bad])).quoteStream(input()));
  const http = client(async () => new Response(JSON.stringify({ apiVersion: '1', requestId: 'req_test', error: { code: 'FORBIDDEN', message: 'Denied.', retryable: false } }), { status: 403, headers: { 'content-type': 'application/json' } }));
  await assert.rejects(http.quoteStream(input()), value => value.code === 'FORBIDDEN' && value.status === 403);
});
test('UTF8 split across chunks and CRLF work; malformed UTF8, duplicate/prototype JSON and non-NDJSON fail', async () => {
  const rows = events(); rows[1].candidate.providerName = 'Rélais'; rows[2].quote.candidates[0].providerName = 'Rélais';
  const bytes = encode(rows.map(row => JSON.stringify(row) + '\r\n').join(''));
  const sdk = client(async () => new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }), { headers: { 'content-type': 'application/x-ndjson' } }));
  assert.equal((await sdk.quoteStream(input())).quoteId, 'quote-test');
  for (const bad of [JSON.stringify(rows[0]).replace('"type":', '"apiVersion":"1","type":') + '\n',
    JSON.stringify(rows[0]).replace('"type":', '"__proto__":{},"type":') + '\n',
    JSON.stringify(rows[0]).replace('"type":', '"\\u0061piVersion":"1","type":') + '\n'])
    await assert.rejects(client(async () => response([bad])).quoteStream(input()), code('PROTOCOL_ERROR'));
  await assert.rejects(client(async () => new Response(Uint8Array.of(0xff), { headers: { 'content-type': 'application/x-ndjson' } })).quoteStream(input()), code('PROTOCOL_ERROR'));
  await assert.rejects(client(async () => new Response('{}', { headers: { 'content-type': 'application/json' } })).quoteStream(input()), code('PROTOCOL_ERROR'));
});
test('byte/line/candidate/chunk budgets bound resource use and cancel rejected streams', async () => {
  await assert.rejects(client(async () => response(['x'.repeat(262144) + '\n'])).quoteStream(input()), code('RESPONSE_TOO_LARGE'));
  await assert.rejects(client(async () => response(['x'.repeat(2097153)])).quoteStream(input()), code('RESPONSE_TOO_LARGE'));
  const rows = events(), tooMany = [rows[0], ...Array.from({ length: 129 }, (_, i) => ({ ...rows[1], sequence: i + 1, candidate: candidate('route-' + i) }))];
  await assert.rejects(client(async () => response(tooMany)).quoteStream(input()), code('PROTOCOL_ERROR'));
  let reads = 0, cancelled = 0;
  const fragmented = client(async () => new Response(new ReadableStream({ pull(controller) { reads++; controller.enqueue(new Uint8Array()); }, cancel() { cancelled++; } }), { headers: { 'content-type': 'application/x-ndjson' } }));
  await assert.rejects(fragmented.quoteStream(input()), code('PROTOCOL_ERROR')); assert.ok(reads <= 16387); assert.equal(cancelled, 1);
});
test('async callback provides backpressure; callback exceptions are redacted and deadlines cancel hung callbacks', async () => {
  const rows = events(); let release, entered, callbacks = 0, pulls = 0;
  const gate = new Promise(resolve => { release = resolve; }), first = new Promise(resolve => { entered = resolve; });
  const sdk = client(async () => new Response(new ReadableStream({ pull(controller) { const row = rows[pulls++]; if (row) controller.enqueue(encode(row)); else controller.close(); } }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/x-ndjson' } }));
  const pending = sdk.quoteStream(input(), { onCandidate: async () => { callbacks++; entered(); await gate; } });
  await first; assert.equal(pulls, 2); assert.equal(callbacks, 1); release(); await pending;
  await assert.rejects(client(async () => response(events())).quoteStream(input(), { onCandidate() { throw new Error(serverKey); } }), value => value.code === 'CALLBACK_ERROR' && !value.message.includes(serverKey));
  let cancellations = 0;
  const hung = client(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(encode(rows[0])); controller.enqueue(encode(rows[1])); }, cancel() { cancellations++; } }), { headers: { 'content-type': 'application/x-ndjson' } }));
  await assert.rejects(hung.quoteStream(input(), { timeoutMs: 10, onCandidate: () => new Promise(() => {}) }), code('TIMEOUT'));
  assert.equal(cancellations, 1);
});
test('late fetch and ignored-abort reader cannot resume callbacks or final after timeout/cancel', async () => {
  let resolve, cancelled = 0, reads = 0;
  const sdk = client(() => new Promise(done => { resolve = done; }));
  await assert.rejects(sdk.quoteStream(input(), { timeoutMs: 5 }), code('TIMEOUT'));
  resolve({ status: 200, body: { cancel() { cancelled++; }, getReader() { reads++; } } });
  await new Promise(done => setTimeout(done, 0)); assert.equal(cancelled, 1); assert.equal(reads, 0);
  for (const abort of [false, true]) {
    let release, close = 0, released = 0, count = 0;
    const controller = new AbortController();
    const late = client(async () => ({ status: 200, headers: new Headers({ 'content-type': 'application/x-ndjson' }), body: {
      getReader() { return { read() { count++; return new Promise(done => { release = done; }); }, cancel() { close++; }, releaseLock() { released++; } }; },
    } }));
    const pending = late.quoteStream(input(), { timeoutMs: abort ? 1000 : 5, signal: controller.signal, onCandidate: () => assert.fail('Late callback') });
    await new Promise(done => setTimeout(done, 0)); if (abort) controller.abort();
    await assert.rejects(pending, code(abort ? 'ABORTED' : 'TIMEOUT'));
    release({ done: false, value: encode(events()[0]) }); await new Promise(done => setTimeout(done, 0));
    assert.equal(count, 1); assert.equal(close, 1); assert.equal(released, 1);
  }
});
test('stream options reject idempotency/header/prototype tricks and executable requests before fetch', async () => {
  let calls = 0; const sdk = client(async () => { calls++; return response(events()); });
  for (const options of [{ idempotencyKey: 'quote-key' }, { headers: { Authorization: 'bad' } }, { onCandidate: 1 }, { timeoutMs: 30001 }])
    await assert.rejects(sdk.quoteStream(input(), options), code('INVALID_INPUT'));
  await assert.rejects(sdk.quoteStream({ ...input(), executionReady: true }), code('INVALID_INPUT'));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(sdk.quoteStream(input(), { signal: controller.signal }), code('ABORTED')); assert.equal(calls, 0);
});

test('independent streams reject debridge before provisional callbacks', async () => {
  const rows = events();
  for (const row of rows) row.request.routeScope = 'INDEPENDENT';
  rows[2].quote.request.routeScope = 'INDEPENDENT';
  for (const value of [rows[1].candidate, rows[2].quote.candidates[0]]) {
    value.providers = ['debridge']; value.routingFamily = 'INDEPENDENT';
  }
  let callbacks = 0;
  await assert.rejects(client(async () => response(rows)).quoteStream({ ...input(), routeScope: 'INDEPENDENT' },
    { onCandidate() { callbacks++; } }), code('PROTOCOL_ERROR'));
  assert.equal(callbacks, 0);
});

test('EOF rejects snapshots expired during callbacks or after COMPLETE without retrying', async () => {
  const rows = events(), until = Date.now() + 25;
  rows[2].quote.snapshotExpiresAtMs = until; rows[2].quote.validUntilMs = until;
  let calls = 0;
  await assert.rejects(client(async () => { calls++; return response(rows); }).quoteStream(input(),
    { onCandidate: () => new Promise(resolve => setTimeout(resolve, 35)) }), code('QUOTE_EXPIRED'));
  assert.equal(calls, 1);
  const delayed = events(); let controller;
  delayed[2].quote.snapshotExpiresAtMs = Date.now() + 25;
  const sdk = client(async () => new Response(new ReadableStream({ start(value) {
    controller = value; for (const event of delayed) value.enqueue(encode(event));
  } }), { headers: { 'content-type': 'application/x-ndjson' } }));
  const pending = sdk.quoteStream(input());
  const rejected = assert.rejects(pending, code('QUOTE_EXPIRED'));
  await new Promise(resolve => setTimeout(resolve, 35)); controller.close(); await rejected;
});
test('EOF freshness checks only selected candidate deadlines and validates their shape', async () => {
  for (const field of ['validUntilMs', 'deadlineMs']) {
    for (const expired of [Date.now() - 1, 0]) {
      const rows = events(); rows[1].candidate[field] = expired; rows[2].quote.candidates[0][field] = expired;
      await assert.rejects(client(async () => response(rows)).quoteStream(input()), code('QUOTE_EXPIRED'));
    }
    for (const malformed of ['tomorrow', null]) {
      const bad = events(); bad[1].candidate[field] = malformed; bad[2].quote.candidates[0][field] = malformed;
      await assert.rejects(client(async () => response(bad)).quoteStream(input()), code('PROTOCOL_ERROR'));
    }
  }
  const rows = events(), rejected = { ...candidate('route-2'), validUntilMs: Date.now() - 1 };
  rows.splice(2, 0, { ...rows[1], sequence: 2, candidate: rejected });
  rows[3].sequence = 3; rows[3].quote.candidates.push(rejected);
  assert.equal((await client(async () => response(rows)).quoteStream(input())).winner, 'route-1');
  const noWinner = events(); noWinner[2].quote.winner = null;
  noWinner[1].candidate.validUntilMs = Date.now() - 1; noWinner[2].quote.candidates[0].validUntilMs = noWinner[1].candidate.validUntilMs;
  assert.equal((await client(async () => response(noWinner)).quoteStream(input())).winner, null);
});
