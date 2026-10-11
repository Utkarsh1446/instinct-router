import test from 'node:test';
import assert from 'node:assert/strict';
import { createRouterClient, RouterSdkError } from '../src/index.js';
import { createRouterServerClient } from '../src/server.js';
const baseUrl = 'https://router.example', publishableKey = 'pk_public_audit_test_123';
const source = { chainId: 'eip155:8453', address: '0x0000000000000000000000000000000000000000', decimals: 18 };
const destination = { chainId: source.chainId, address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 };
const input = { source, destination, amount: '0.01', sender: '0x1111111111111111111111111111111111111111', recipient: '0x1111111111111111111111111111111111111111' };
const envelope = value => ({ apiVersion: '1', requestId: 'req-audit', ...value });
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const sdk = (fetch, timeoutMs = 10000) => createRouterClient({ baseUrl, publishableKey, fetch, timeoutMs });
const code = value => error => error instanceof RouterSdkError && error.code === value;
const quote = () => envelope({ appId: 'app-audit', quoteId: 'quote-audit', request: input, readOnly: true, execution: { enabled: false }, winner: 'route-audit',
  candidates: [{ id: 'route-audit', providers: ['relay'], executionReady: false, eligible: true, conditional: true, feeBps: 10, priceImpactBps: 20, expectedOutputRaw: '100', minimumOutputRaw: '99', estimatedCompletionMs: 500 }],
  excluded: [], failures: [], providerTimings: [], quoteRttMs: 1, comparisonComplete: true });

test('unread bodies are cancelled on MIME, size, HTTP status, redirect and response-origin failures', async () => {
  for (const variant of [{ mime: 'text/plain' }, { length: '2097153' }, { status: 0 }, { redirected: true }, { url: 'https://other.example/v1/config' }]) {
    let cancelled = 0, opened = 0;
    const response = { status: variant.status ?? 200, redirected: variant.redirected ?? false, url: variant.url ?? '',
      headers: new Headers({ 'Content-Type': variant.mime ?? 'application/json', ...(variant.length ? { 'Content-Length': variant.length } : {}) }),
      body: { cancel: () => { cancelled++; return Promise.resolve(); }, getReader: () => { opened++; throw new Error(); } } };
    await assert.rejects(sdk(async () => response).getConfig(), code(variant.length ? 'RESPONSE_TOO_LARGE' : 'PROTOCOL_ERROR'));
    assert.equal(cancelled, 1); assert.equal(opened, 0);
  }
});

test('UTF-8 decoder failures cancel and release the response stream', async () => {
  let cancelled = 0, released = 0, reads = 0;
  const reader = { read: async () => { reads++; return { done: false, value: new Uint8Array([0xc3, 0x28]) }; },
    cancel: async () => { cancelled++; }, releaseLock: () => { released++; } };
  await assert.rejects(sdk(async () => ({ status: 200, headers: new Headers({ 'Content-Type': 'application/json' }), body: { getReader: () => reader } })).getConfig(), code('PROTOCOL_ERROR'));
  assert.equal(reads, 1); assert.equal(cancelled, 1); assert.equal(released, 1);
});

test('resolved asset metadata is bound to requested chain, address, verified decimals', async () => {
  const valid = envelope({ ...destination, metadataVerified: true });
  for (const change of [value => { value.address = source.address; }, value => { value.chainId = 'eip155:1'; }, value => { value.decimals = '6'; }, value => { value.decimals = 256; }, value => { value.metadataVerified = false; }]) {
    const value = structuredClone(valid); change(value);
    await assert.rejects(sdk(async () => json(value)).resolveAsset({ chainId: destination.chainId, address: destination.address }), code('PROTOCOL_ERROR'));
  }
  assert.deepEqual(await sdk(async () => json(valid)).resolveAsset({ chainId: destination.chainId, address: destination.address }), valid);
});

test('only eligible winners with known costs and completion pass, including conditional previews', async () => {
  assert.equal((await sdk(async () => json(quote())).quote(input)).candidates[0].conditional, true);
  for (const change of [value => { value.eligible = false; }, value => { delete value.eligible; }, value => { value.feeBps = null; }, value => { value.priceImpactBps = null; }, value => { value.estimatedCompletionMs = null; }, value => { value.estimatedCompletionMs = -1; }, value => { value.estimatedCompletionMs = 0; }, value => { value.estimatedCompletionMs = 0.5; }, value => { value.feeBps = 501; }, value => { value.priceImpactBps = 501; }, value => { value.feeBps = 1e30; }]) {
    const value = quote(); change(value.candidates[0]);
    await assert.rejects(sdk(async () => json(value)).quote(input), code('PROTOCOL_ERROR'));
  }
});

test('duplicate JSON keys including escaped aliases and reserved prototype fields are rejected', async () => {
  for (const text of ['{"apiVersion":"1","apiVersion":"1","requestId":"req-1"}',
    '{"apiVersion":"1","\\u0061piVersion":"1","requestId":"req-1"}',
    '{"apiVersion":"1","requestId":"req-1","nested":{"amount":"1","amount":"2"}}',
    '{"apiVersion":"1","requestId":"req-1","nested":{"__proto__":{"polluted":true}}}']) {
    await assert.rejects(sdk(async () => new Response(text, { headers: { 'Content-Type': 'application/json' } })).getConfig(), code('PROTOCOL_ERROR'));
  }
  assert.equal({}.polluted, undefined);
  const escaped = envelope({ nested: { label: 'quotes: "{ }" \\ path', unicode: 'é' }, empty: [], count: 1e3 });
  assert.deepEqual(await sdk(async () => json(escaped)).getConfig(), escaped);
});

test('JSON depth and node budgets stop excessive structures before returning them', async () => {
  let deep = 0; for (let index = 0; index < 65; index++) deep = [deep];
  await assert.rejects(sdk(async () => json(envelope({ deep }))).getConfig(), code('PROTOCOL_ERROR'));
  await assert.rejects(sdk(async () => json(envelope({ nodes: Array(100001).fill(0) }))).getConfig(), code('PROTOCOL_ERROR'));
});

test('immediate empty chunks cannot starve cancellation or exceed the chunk budget', async () => {
  let reads = 0, cancelled = 0;
  const reader = { read: async () => { reads++; return { done: false, value: new Uint8Array() }; }, cancel: async () => { cancelled++; }, releaseLock() {} };
  const fetch = async () => ({ status: 200, headers: new Headers({ 'Content-Type': 'application/json' }), body: { getReader: () => reader } });
  const controller = new AbortController();
  const pending = sdk(fetch).getConfig({ signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 1);
  await assert.rejects(pending, code('ABORTED')); clearTimeout(timer);
  assert.ok(reads <= 256); assert.equal(cancelled, 1);
  reads = 0; cancelled = 0;
  await assert.rejects(sdk(fetch, 1000).getConfig(), code('PROTOCOL_ERROR'));
  assert.equal(reads, 16385); assert.equal(cancelled, 1);
});

test('error code cannot echo a confidential credential', async () => {
  const serverKey = 'SERVER_SECRET_KEY_AUDIT';
  const client = createRouterServerClient({ baseUrl, serverKey, fetch: async () => new Response(JSON.stringify(envelope({ error: { code: serverKey, message: serverKey, retryable: false } })), { status: 403, headers: { 'Content-Type': 'application/json' } }) });
  await assert.rejects(client.getConfig(), error => { assert.equal(error.code, 'PROTOCOL_ERROR'); assert.ok(!JSON.stringify(error).includes(serverKey)); assert.ok(!error.message.includes(serverKey)); return true; });
});

test('monotonic deadline catches a blocked event loop before late fetch data is read', async () => {
  let cancelled = 0, read = 0;
  const response = { status: 200, headers: new Headers({ 'Content-Type': 'application/json' }), body: {
    cancel: async () => { cancelled++; }, getReader: () => { read++; throw new Error('Expired response'); },
  } };
  const client = sdk(async () => {
    const end = performance.now() + 15;
    while (performance.now() < end) { /* Reproduce a fetch implementation blocking timer callbacks. */ }
    return response;
  }, 5);
  await assert.rejects(client.getConfig(), code('TIMEOUT'));
  assert.equal(cancelled, 1); assert.equal(read, 0);
});

test('prototype-inherited credentials, wallet fields and options cannot become explicit input', async () => {
  let calls = 0;
  const fetch = async (_, init) => { calls++; assert.equal(init.headers['Idempotency-Key'], undefined); return json(quote()); };
  const client = sdk(fetch);
  const descriptors = Object.getOwnPropertyDescriptors(Object.prototype);
  try {
    Object.defineProperties(Object.prototype, {
      sender: { value: input.sender, configurable: true },
      publishableKey: { value: publishableKey, configurable: true },
      idempotencyKey: { value: 'inherited-replay-key', configurable: true },
    });
    const missing = { ...input }; delete missing.sender;
    await assert.rejects(client.quote(missing), code('INVALID_INPUT'));
    assert.throws(() => createRouterClient({ baseUrl, fetch }), code('INVALID_INPUT'));
    assert.equal(calls, 0);
    await client.quote(input);
    assert.equal(calls, 1);
  } finally {
    for (const key of ['sender', 'publishableKey', 'idempotencyKey']) {
      delete Object.prototype[key]; if (descriptors[key]) Object.defineProperty(Object.prototype, key, descriptors[key]);
    }
  }
});

test('nonstreaming custom fetch responses fail closed without materializing text', async () => {
  for (const body of [undefined, {}, { getReader: null }, { getReader: () => undefined }]) {
    let textCalls = 0;
    const response = { status: 200, headers: new Headers({ 'Content-Type': 'application/json' }), body,
      text: async () => { textCalls++; return JSON.stringify(envelope({})); } };
    await assert.rejects(sdk(async () => response).getConfig(), error => {
      assert.equal(error.code, 'PROTOCOL_ERROR'); assert.match(error.message, /standard streaming Response/); return true;
    });
    assert.equal(textCalls, 0);
  }
});
