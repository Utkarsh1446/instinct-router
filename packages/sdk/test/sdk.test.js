import test from 'node:test';
import assert from 'node:assert/strict';
import { createRouterClient, RouterSdkError } from '../src/index.js';
import { createRouterServerClient } from '../src/server.js';
const publicKey = 'pk_public_test_123456';
const secretKey = 'sk_confidential_test_123456';
const baseUrl = 'https://router.example';
const source = { chainId: 'eip155:8453', address: '0x0000000000000000000000000000000000000000', decimals: 18 };
const destination = { chainId: 'eip155:8453', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 };
const wallet = '0x1111111111111111111111111111111111111111';
const input = () => ({ source: { ...source }, destination: { ...destination }, amount: '0.00001', sender: wallet, recipient: wallet });
const normalized = () => ({ ...input(), objective: 'BALANCED', maxOutputShortfallBps: 50, slippageBps: 50, maxFeeBps: 500, maxPriceImpactBps: 500 });
const envelope = value => ({ apiVersion: '1', requestId: 'request-test', ...value });
const quote = () => envelope({ quoteId: 'quote-test', appId: 'app-test', request: normalized(), readOnly: true, execution: { enabled: false }, winner: null,
  candidates: [{ id: 'route-1', providers: ['relay'], expectedOutputRaw: '150', minimumOutputRaw: '140', feeBps: null, priceImpactBps: null, executionReady: false, eligible: false, conditional: false, estimatedCompletionMs: null }],
  excluded: [], failures: [], providerTimings: [], quoteRttMs: 10, comparisonComplete: true });
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const client = fetch => createRouterClient({ baseUrl, publishableKey: publicKey, fetch });
const code = expected => error => error instanceof RouterSdkError && error.code === expected;

test('public key is scoped to origin; request defaults and nullable costs remain intact', async () => {
  let calls = 0;
  const sdk = client(async (url, init) => {
    calls++; assert.equal(url, `${baseUrl}/v1/quotes`);
    assert.equal(init.headers['X-Router-App-Key'], publicKey);
    assert.equal(init.headers.Authorization, undefined); assert.equal(init.headers.Origin, undefined);
    assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error');
    assert.equal(init.headers['Idempotency-Key'], 'quote-first-1');
    assert.deepEqual(JSON.parse(init.body), normalized());
    return json(quote());
  });
  const before = input(), result = await sdk.quote(before, { idempotencyKey: 'quote-first-1' });
  assert.deepEqual(before, input()); assert.equal(result.candidates[0].feeBps, null);
  assert.equal(result.candidates[0].priceImpactBps, null); assert.equal(calls, 1);
});

test('server entry uses only Bearer and rejects browser construction', async () => {
  const sdk = createRouterServerClient({ baseUrl, serverKey: secretKey, fetch: async (_, init) => {
    assert.equal(init.headers.Authorization, `Bearer ${secretKey}`); assert.equal(init.headers['X-Router-App-Key'], undefined);
    return json(envelope({ execution: { enabled: false } }));
  } });
  await sdk.getCapabilities();
  globalThis.window = {};
  try { assert.throws(() => createRouterServerClient({ baseUrl, serverKey: secretKey }), code('SERVER_ONLY')); }
  finally { delete globalThis.window; }
  assert.throws(() => createRouterClient({ baseUrl, publishableKey: publicKey, serverKey: secretKey }), code('INVALID_INPUT'));
  assert.throws(() => createRouterServerClient({ baseUrl, serverKey: secretKey, publishableKey: publicKey }), code('INVALID_INPUT'));
});

test('all endpoint paths use expected methods; retrieval never posts', async () => {
  const seen = [];
  const sdk = client(async (url, init) => {
    seen.push([url.slice(baseUrl.length), init.method]);
    if (url.endsWith('/prepare')) return json(envelope({ error: { code: 'EXECUTION_ADAPTER_UNAVAILABLE', message: 'Not enabled.', retryable: false } }), 501);
    if (url.endsWith('/resolve')) return json(envelope({ ...source, metadataVerified: true }));
    return json(url.includes('/quotes/') ? quote() : envelope({ execution: { enabled: false } }));
  });
  await sdk.getConfig(); await sdk.getCapabilities();
  await sdk.resolveAsset({ chainId: source.chainId, address: source.address });
  await sdk.getQuote('quote-test'); await assert.rejects(sdk.prepareExecution({ quoteId: 'quote-test', candidateId: 'route-1' }), code('EXECUTION_ADAPTER_UNAVAILABLE'));
  assert.deepEqual(seen, [['/v1/config', 'GET'], ['/v1/capabilities', 'GET'], ['/v1/assets/resolve', 'POST'], ['/v1/quotes/quote-test', 'GET'], ['/v1/executions/prepare', 'POST']]);
});

test('rejects credential forwarding URLs and arbitrary headers', () => {
  for (const url of ['http://router.example', 'https://user:secret@router.example', `${baseUrl}/v1`, `${baseUrl}/v1/..`, `${baseUrl}/?key=secret`, `${baseUrl}/?`, `${baseUrl}/#token`, 'ftp://127.0.0.1', 'http://127.0.0.2', 'https://router.example\\evil']) {
    assert.throws(() => createRouterClient({ baseUrl: url, publishableKey: publicKey }), code('INVALID_INPUT'));
  }
  for (const url of ['http://localhost:8790', 'http://127.0.0.1:8790', 'http://[::1]:8790']) assert.ok(createRouterClient({ baseUrl: url, publishableKey: publicKey }));
  assert.throws(() => createRouterClient({ baseUrl, publishableKey: publicKey, headers: { Origin: 'https://evil.example' } }), code('INVALID_INPUT'));
  assert.throws(() => createRouterClient({ baseUrl, publishableKey: publicKey, timeoutMs: 30001 }), code('INVALID_INPUT'));
});

test('invalid request boundaries do not invoke fetch', async () => {
  let calls = 0; const sdk = client(async () => { calls++; return json(quote()); });
  const bad = [ { ...input(), sender: undefined }, { ...input(), recipient: null }, { ...input(), amount: 1 }, { ...input(), amount: '1e-5' },
    { ...input(), amount: '0.0000000000000000001' }, { ...input(), amount: '0' }, { ...input(), destination: source },
    { ...input(), tenantId: 'other-app' }, { ...input(), executionReady: true },
    { ...input(), source: { ...source, metadataVerified: true } }, { ...input(), objective: 'BEST_OUTPUT', maxOutputShortfallBps: 50 },
    { ...input(), maxFeeBps: 10001 }, { ...input(), source: { ...source, decimals: -1 } },
    JSON.parse(JSON.stringify(input()).replace('"amount":', '"__proto__":{},"amount":')) ];
  for (const value of bad) await assert.rejects(sdk.quote(value), code('INVALID_INPUT'));
  await assert.rejects(sdk.prepareExecution({ quoteId: 'quote-test', sender: wallet }), code('INVALID_INPUT'));
  await assert.rejects(sdk.getQuote('../other-owner'), code('INVALID_INPUT'));
  await assert.rejects(sdk.getConfig({ headers: { Authorization: 'other' } }), code('INVALID_INPUT'));
  await assert.rejects(sdk.resolveAsset({ chainId: source.chainId, address: source.address }, { idempotencyKey: 'lookup-1' }), code('INVALID_INPUT'));
  await assert.rejects(sdk.prepareExecution({ quoteId: 'quote-test' }, { idempotencyKey: 'prepare-1' }), code('INVALID_INPUT'));
  assert.equal(calls, 0);
});

test('BEST_OUTPUT defaults to zero and same-chain different assets remain valid', async () => {
  const sdk = client(async (_, init) => {
    const data = JSON.parse(init.body); assert.equal(data.maxOutputShortfallBps, 0); assert.equal(data.maxFeeBps, 2500);
    const result = quote(); result.request = data; return json(result);
  });
  await sdk.quote({ ...input(), objective: 'BEST_OUTPUT', maxFeeBps: 2500 });
});
test('independent-only requests are exact-bound and cannot silently return aggregator routes', async () => {
  let corrupt = null, echoDrift = false;
  const sdk = client(async (_, init) => {
    const request = JSON.parse(init.body), result = quote();
    assert.equal(request.routeScope, 'INDEPENDENT');
    result.request = { ...request, ...(echoDrift ? { routeScope: 'ALL' } : {}) };
    result.candidates[0].providers = corrupt ? [corrupt] : ['raydium', 'cctp-fast', 'uniswap-v3'];
    result.candidates[0].routingFamily = 'INDEPENDENT';
    return json(result);
  });
  await sdk.quote({ ...input(), routeScope: 'INDEPENDENT' });
  for (const provider of ['relay', 'aurora', 'debridge']) { corrupt = provider; await assert.rejects(sdk.quote({ ...input(), routeScope: 'INDEPENDENT' }), code('PROTOCOL_ERROR')); }
  corrupt = false; echoDrift = true; await assert.rejects(sdk.quote({ ...input(), routeScope: 'INDEPENDENT' }), code('PROTOCOL_ERROR'));
  await assert.rejects(sdk.quote({ ...input(), routeScope: 'INDEPENDENT_FASTEST_ALWAYS' }), code('INVALID_INPUT'));
});

test('remote typed errors are redacted and quotes never retry', async () => {
  let calls = 0;
  const sdk = createRouterServerClient({ baseUrl, serverKey: secretKey, fetch: async () => { calls++; return json(envelope({ error: { code: 'RATE_LIMITED', message: `Do not expose ${secretKey}`, retryable: true, retryAfterMs: 200 } }), 429); } });
  await assert.rejects(sdk.quote(input()), error => {
    assert.equal(error.code, 'RATE_LIMITED'); assert.equal(error.status, 429); assert.equal(error.requestId, 'request-test');
    assert.equal(error.retryAfterMs, 200); assert.equal(error.retryable, true); assert.ok(!error.message.includes(secretKey));
    assert.ok(!JSON.stringify(error).includes(secretKey)); return true;
  });
  assert.equal(calls, 1);
  await assert.rejects(client(async () => { throw new Error(secretKey); }).getConfig(), error => error.code === 'NETWORK_ERROR' && !error.message.includes(secretKey));
});

test('execution unavailable is a typed 501 error, not a successful trade', async () => {
  await assert.rejects(client(async () => json(envelope({ error: { code: 'EXECUTION_ADAPTER_UNAVAILABLE', message: 'No canonical execution adapter.', retryable: false } }), 501)).prepareExecution({ quoteId: 'quote-test' }), error => error.code === 'EXECUTION_ADAPTER_UNAVAILABLE' && error.status === 501);
});

test('timeout and caller cancellation terminate even an uncooperative fetch', async () => {
  let calls = 0; const wire = () => { calls++; return new Promise(() => {}); };
  const sdk = createRouterClient({ baseUrl, publishableKey: publicKey, fetch: wire, timeoutMs: 10 });
  await assert.rejects(sdk.getConfig(), code('TIMEOUT')); assert.equal(calls, 1);
  const controller = new AbortController(); const result = sdk.getConfig({ signal: controller.signal, timeoutMs: 1000 });
  controller.abort(); await assert.rejects(result, code('ABORTED')); assert.equal(calls, 2);
  await assert.rejects(sdk.getConfig({ signal: controller.signal }), code('ABORTED')); assert.equal(calls, 2);
});

test('malformed and incompatible response boundaries fail closed', async () => {
  for (const body of [envelope({ apiVersion: '2' }), envelope({ requestId: null }), envelope({ error: { code: 'oops', message: 'wrong', retryable: false } })]) {
    const status = body.error ? 400 : 200;
    await assert.rejects(client(async () => json(body, status)).getConfig(), code('PROTOCOL_ERROR'));
  }
  for (const change of [value => { value.winner = 'missing'; }, value => { value.candidates[0].expectedOutputRaw = 5; }, value => { value.candidates[0].feeBps = undefined; }, value => { value.execution.enabled = true; }, value => { value.candidates.push(value.candidates[0]); }, value => { value.candidates[0].executionReady = true; }, value => { value.candidates[0].minimumOutputRaw = '151'; }]) {
    const value = quote(); change(value);
    await assert.rejects(client(async () => json(value)).quote(input()), code('PROTOCOL_ERROR'));
  }
  await assert.rejects(client(async () => new Response('bad JSON', { headers: { 'Content-Type': 'application/json' } })).getConfig(), code('PROTOCOL_ERROR'));
  await assert.rejects(client(async () => new Response('<html/>')).getConfig(), code('PROTOCOL_ERROR'));
});

test('large response streams and declared bodies are bounded to 2 MiB', async () => {
  const big = 'x'.repeat(2 * 1024 * 1024 + 1);
  await assert.rejects(client(async () => new Response(big, { headers: { 'Content-Type': 'application/json' } })).getConfig(), code('RESPONSE_TOO_LARGE'));
  await assert.rejects(client(async () => json(envelope({}), 200, { 'Content-Length': String(big.length) })).getConfig(), code('RESPONSE_TOO_LARGE'));
});

test('snapshot ownership boundary rejects mismatched quotes and unexpected executable preparation', async () => {
  const wrong = quote(); wrong.request.amount = '0.002';
  await assert.rejects(client(async () => json(wrong)).quote(input()), code('PROTOCOL_ERROR'));
  await assert.rejects(client(async () => json(quote())).getQuote('other-quote'), code('PROTOCOL_ERROR'));
  await assert.rejects(client(async () => json(envelope({ execution: { enabled: true }, transaction: 'unsigned-bytes' }))).prepareExecution({ quoteId: 'quote-test' }), code('PROTOCOL_ERROR'));
  await assert.rejects(client(async () => json(envelope({ execution: { enabled: false } }))).prepareExecution({ quoteId: 'quote-test' }), code('PROTOCOL_ERROR'));
});

test('late fetch resolution after timeout cancels the body without starting a read', async () => {
  let resolveFetch, cancelled = 0, opened = 0;
  const sdk = createRouterClient({ baseUrl, publishableKey: publicKey, timeoutMs: 10, fetch: () => new Promise(resolve => { resolveFetch = resolve; }) });
  await assert.rejects(sdk.getConfig(), code('TIMEOUT'));
  resolveFetch({ status: 200, headers: new Headers({ 'Content-Type': 'application/json' }), body: {
    cancel: () => { cancelled++; return Promise.resolve(); },
    getReader: () => { opened++; throw new Error('A timed-out request must not start reading.'); },
  } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, 1); assert.equal(opened, 0);
});

test('late stream chunks cannot continue reading after timeout or caller abort', async () => {
  for (const mode of ['timeout', 'abort']) {
    let resolveRead, reads = 0, cancelled = 0, released = 0;
    const reader = {
      read: () => { reads++; return new Promise(resolve => { resolveRead = resolve; }); },
      cancel: () => { cancelled++; return Promise.resolve(); },
      releaseLock: () => { released++; },
    };
    const sdk = createRouterClient({ baseUrl, publishableKey: publicKey, timeoutMs: mode === 'timeout' ? 10 : 1000,
      fetch: async () => ({ status: 200, headers: new Headers({ 'Content-Type': 'application/json' }), body: { getReader: () => reader } }) });
    const controller = new AbortController();
    const pending = sdk.getConfig({ signal: controller.signal });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, 1);
    if (mode === 'abort') controller.abort();
    await assert.rejects(pending, code(mode === 'timeout' ? 'TIMEOUT' : 'ABORTED'));
    assert.ok(cancelled >= 1);
    resolveRead({ done: false, value: new TextEncoder().encode(JSON.stringify(envelope({}))) });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, 1, 'No additional read after a late chunk'); assert.equal(released, 1);
  }
});

const inspectInput = () => ({ ...input(), slippageBps: 50 });
const inspection = () => envelope({ appId: 'app-test', readOnly: true, executionReady: false, requiresWalletSignature: true,
  request: inspectInput(), amountRaw: '10000000000000', status: 'READY_FOR_REVIEW', checkedAtMs: Date.now(), validUntilMs: Date.now() + 4000,
  quote: { expectedOutputRaw: '1000', minimumOutputRaw: '995', pricingValidUntilMs: Date.now() + 8000 },
  evidence: { canonicalRecheck: true, routerArtifactVerified: true, calldataBuiltLocally: true, simulationOutputRaw: '1000' },
  fees: { complete: true, estimateOnly: true, gasEstimateRaw: '21000', gasLimitRaw: '31500', maxFeePerGasRaw: '2',
    maxPriorityFeePerGasRaw: '1', l2BudgetRaw: '63000', l1FeeUpperBoundRaw: '100', l1BudgetRaw: '200', operatorFeeBudgetRaw: '0',
    totalNativeBudgetRaw: '63200', balanceRaw: '10000000063200' },
  transactionPrepared: true, blockers: [], inspectionRttMs: 5, execution: { enabled: false } });
test('inspection is request-bound, read-only and includes all native gas components without calldata', async () => {
  const sdk = client(async (url, init) => { assert.equal(url, `${baseUrl}/v1/executions/inspect`); assert.deepEqual(JSON.parse(init.body), inspectInput()); return json(inspection()); });
  const result = await sdk.inspectExecution(input()); assert.equal(result.status, 'READY_FOR_REVIEW'); assert.equal(result.executionReady, false); assert.equal(result.transaction, undefined);
  const blocked = inspection(); blocked.status = 'BLOCKED'; blocked.transactionPrepared = false; blocked.fees.complete = false;
  blocked.fees.l1BudgetRaw = null; blocked.blockers = [{ code: 'READINESS_FEES_UNKNOWN', message: 'Fee unavailable.' }];
  assert.equal((await client(async () => json(blocked)).inspectExecution(input())).status, 'BLOCKED');
});
test('inspection rejects changed wallets, fake ready status, fee understatement and signing artifact injection', async () => {
  for (const mutate of [r => r.request.recipient = '0x' + '2'.repeat(40), r => r.amountRaw = '1', r => r.readOnly = false,
    r => r.executionReady = true, r => r.execution.enabled = true, r => r.transaction = { data: '0x00' },
    r => r.transactionPrepared = false, r => r.quote.minimumOutputRaw = '990', r => r.fees.complete = false,
    r => r.fees.estimateOnly = false, r => r.fees.totalNativeBudgetRaw = '63000', r => r.fees.operatorFeeBudgetRaw = null,
    r => r.fees.balanceRaw = '10000000000000', r => r.fees.gasLimitRaw = '1', r => r.evidence.canonicalRecheck = false,
    r => r.evidence.simulationOutputRaw = '1001', r => r.validUntilMs = Date.now() - 1,
    r => r.blockers = [{ code: 'READINESS_FEES_UNKNOWN', message: 'Unknown.' }]]) {
    const result = inspection(); mutate(result);
    await assert.rejects(client(async () => json(result)).inspectExecution(input()), code('PROTOCOL_ERROR'));
  }
});
test('inspection rejects execution policy overrides before transport', async () => {
  let calls = 0; const sdk = client(async () => { calls++; return json(inspection()); });
  for (const field of ['quoteId', 'candidateId', 'routeScope', 'data', 'gas', 'objective', 'executionReady'])
    await assert.rejects(sdk.inspectExecution({ ...input(), [field]: 'anything' }), code('INVALID_INPUT'));
  await assert.rejects(sdk.inspectExecution(input(), { idempotencyKey: 'replay-inspect' }), code('INVALID_INPUT'));
  assert.equal(calls, 0);
});

test('explicit null fee ceiling accepts known fees above 100 percent while omitted retains legacy default',async()=>{
  const value=quote();value.request.maxFeeBps=null;value.winner='route-1';
  Object.assign(value.candidates[0],{feeBps:15000,priceImpactBps:1,estimatedCompletionMs:1000,eligible:true});
  let sent;
  const sdk=client(async(_,init)=>{sent=JSON.parse(init.body);return json(value);});
  await sdk.quote({...input(),maxFeeBps:null});assert.equal(sent.maxFeeBps,null);
  value.candidates[0].feeBps=null;
  await assert.rejects(sdk.quote({...input(),maxFeeBps:null}),code('PROTOCOL_ERROR'));
  value.candidates[0].feeBps=15000;value.request.maxFeeBps=500;
  await assert.rejects(sdk.quote({...input(),maxFeeBps:null}),code('PROTOCOL_ERROR'));
  for(const bad of ['',false,'null',undefined,-1,10001])await assert.rejects(sdk.quote({...input(),maxFeeBps:bad}),code('INVALID_INPUT'));
});

test('uint8 token decimals preserve exact fractional raw amounts up to 255',async()=>{
  const {quoteRequest}=await import('../src/validation.js');
  for(const decimals of [77,255]){
    const amount='0.'+'0'.repeat(decimals-1)+'1';
    const value=quoteRequest({...input(),source:{...source,decimals},amount});
    assert.equal(value.source.decimals,decimals);assert.equal(value.amount,amount);
    assert.equal(BigInt(value.amount.replace('.','')),1n);
    assert.throws(()=>quoteRequest({...input(),source:{...source,decimals},amount:'2'}),code('INVALID_INPUT'));
  }
  for(const decimals of [256,1.5,-1,'255'])assert.throws(()=>quoteRequest({...input(),source:{...source,decimals}}),code('INVALID_INPUT'));
  assert.throws(()=>quoteRequest({...input(),source:{...source,decimals:255},amount:'0.'+'0'.repeat(255)+'1'}),code('INVALID_INPUT'));
});
