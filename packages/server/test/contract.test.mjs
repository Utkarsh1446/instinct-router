import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { createRouterApi } from '../src/index.mjs';
import { createQuoteService } from '@instinct/router-engine';
import { fixtureWire, input as realInput } from '../../../tests/fixtures/provider.mjs';

const spec = JSON.parse(await readFile(new URL('../../../docs/openapi.json', import.meta.url)));
const schemas = spec.components.schemas;
const app = { id: 'contract-app', publishableKey: 'pk_contract_0123456789', serverKey: 'sk_contract_0123456789', allowedOrigins: ['https://contract.example'] };
const quote = { source: { chainId: 'eip155:8453', address: '0x' + '0'.repeat(40), decimals: 18 },
  destination: { chainId: 'eip155:8453', address: '0x' + '1'.repeat(40), decimals: 6 },
  sender: '0x' + '2'.repeat(40), recipient: '0x' + '3'.repeat(40), amount: '0.01',
  slippageBps: 50, objective: 'BALANCED', maxOutputShortfallBps: 50, maxFeeBps: 500, maxPriceImpactBps: 500, routeScope: 'ALL' };

test('OpenAPI describes shipped endpoints, canonical strict inputs and pricing-only authority', () => {
  assert.equal(spec.openapi, '3.1.0');
  assert.deepEqual(Object.keys(spec.paths).sort(), ['/healthz', '/v1/assets/balance', '/v1/assets/resolve', '/v1/capabilities', '/v1/config',
    '/v1/executions/prepare', '/v1/executions/inspect', '/v1/quotes', '/v1/quotes/stream', '/v1/quotes/{quoteId}',
    '/v1/wallets/challenge', '/v1/wallets/verify', '/v1/executions/active', '/v1/executions/{executionId}',
    ...['claim', 'submit', 'uncertain', 'refresh', 'cancel', 'watch'].map(action => '/v1/executions/{executionId}/' + action)].sort());
  assert.deepEqual(spec.paths['/healthz'].get.security, []);
  assert.deepEqual(spec.security, [{ PublishableKey: [], AppOrigin: [] }, { ServerBearer: [] }]);
  assert.match(spec.components.securitySchemes.ServerBearer.description, /no Origin/);
  assert.equal(schemas.QuoteInput.additionalProperties, false);
  assert.deepEqual(Object.keys(schemas.QuoteInput.properties).sort(), Object.keys(quote).sort());
  assert.deepEqual(schemas.Asset.required, ['chainId', 'address', 'decimals']);
  assert.equal(schemas.Asset.additionalProperties, false);
  assert.equal(schemas.AssetBalanceInput.additionalProperties,false);
  assert.deepEqual(schemas.AssetBalanceInput.required,['chainId','address','owner']);
  assert.equal(schemas.AssetBalanceObservation.additionalProperties,false);
  assert.equal(schemas.AssetBalanceObservation.properties.balanceRaw.type,'string');
  assert.equal(spec.paths['/v1/assets/balance'].post.operationId,'getAssetBalance');
  assert.ok(spec.paths['/v1/assets/balance'].post.responses['503']);
  assert.equal(schemas.Asset.properties.decimals.maximum, 255);
  const amount = new RegExp(schemas.QuoteInput.properties.amount.pattern);
  assert.equal(amount.test('0.00005'), true); assert.equal(amount.test('1.25'), true);
  for (const value of ['1e-5', '01', '+1', '-1', '1\\25']) assert.equal(amount.test(value), false);
  assert.equal(Object.hasOwn(schemas.QuoteInput.properties.maxOutputShortfallBps, 'default'), false);
  assert.match(schemas.QuoteInput.properties.sender.description, /sentinels.*forbidden/);
  assert.deepEqual(schemas.QuoteSnapshot.properties.winner.type, ['string', 'null']);
  assert.equal(schemas.QuoteSnapshot.properties.quoteRttMs.type, 'number');
  for (const field of ['executionReady', 'conditional', 'eligible', 'providers', 'expectedOutputRaw', 'minimumOutputRaw', 'feeBps', 'priceImpactBps'])
    assert.ok(schemas.Candidate.required.includes(field));
  assert.deepEqual(schemas.PrepareInput.required, ['source', 'destination', 'amount', 'sender', 'recipient', 'nativeFeeBudgets']);
  assert.equal(schemas.Execution.properties.enabled.const, false);
  assert.equal(schemas.InspectionInput.additionalProperties, false);
  assert.equal(schemas.InspectionReport.additionalProperties, false);
  assert.equal(schemas.InspectionReport.properties.executionReady.const, false);
  assert.equal(schemas.InspectionReport.properties.transaction, undefined);
  assert.match(schemas.QuoteSnapshot.description, /unmeasured/);
  assert.ok(spec.paths['/v1/executions/prepare'].post.responses['501']);
  assert.equal(spec.paths['/v1/executions/prepare'].post.responses['200'].content['application/json'].schema.$ref, '#/components/schemas/ExecutionResponse');
  const streaming = spec.paths['/v1/quotes/stream'].post;
  assert.ok(streaming.responses['200'].content['application/x-ndjson']);
  assert.equal(streaming.parameters, undefined);
  assert.equal(schemas.QuoteStreamEvent.additionalProperties, false);
  assert.deepEqual(schemas.QuoteStreamEvent.properties.type.enum, ['START', 'CANDIDATE', 'COMPLETE', 'ERROR']);
  assert.equal(schemas.QuoteStreamEvent.properties.quote.$ref, '#/components/schemas/QuoteSnapshot');
});

test('documented inputs and auth/prepare response statuses agree with the HTTP boundary', async t => {
  let seen;
  const server = createRouterApi({ apps: [app], service: {
    config: () => ({ readOnly: true, execution: { enabled: false }, assetClasses: [], providers: [] }),
    resolveAsset: async input => ({ ...input, decimals: 6 }),
    quote: async input => { seen = input; return { requestId: 'rfq', candidates: [{ id: 'route', executionReady: false }],
      quotedAtMs: Date.now(), validUntilMs: Date.now() + 15000, execution: { enabled: false }, source: input.source,
      destination: input.destination, amountRaw: '100', quoteRttMs: 1, serviceRttMs: 1,
      comparisonComplete: true, winner: 'route', excluded: [], failures: [], providerTimings: [] }; },
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const call = (path, body, mode = 'browser') => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method: payload ? 'POST' : 'GET',
      headers: { ...(mode === 'browser' ? { Origin: app.allowedOrigins[0], 'X-Router-App-Key': app.publishableKey } :
        mode === 'server' ? { Authorization: 'Bearer ' + app.serverKey } :
        mode === 'server-browser' ? { Authorization: 'Bearer ' + app.serverKey, Origin: app.allowedOrigins[0] } : {}),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) } }, res => {
      let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject); req.end(payload);
  });
  assert.equal((await call('/healthz', undefined, 'none')).status, 200);
  assert.equal((await call('/v1/config', undefined, 'none')).status, 401);
  assert.equal((await call('/v1/config', undefined, 'server')).status, 200);
  assert.equal((await call('/v1/config', undefined, 'server-browser')).status, 403);
  const created = await call('/v1/quotes', quote); assert.equal(created.status, 200); assert.deepEqual(seen, quote);
  for (const name of schemas.QuoteSnapshot.required) assert.ok(Object.hasOwn(created.body, name));
  assert.equal((await call('/v1/quotes', { ...quote, tenantId: 'foreign' })).status, 400);
  assert.equal((await call('/v1/assets/resolve', { chainId: quote.destination.chainId, address: quote.destination.address })).status, 200);
  assert.equal((await call('/v1/executions/prepare', {})).status, 400);
  assert.equal((await call('/v1/executions/prepare', { quoteId: 'foreign' })).status, 404);
  const prepared = await call('/v1/executions/prepare', { quoteId: created.body.quoteId, candidateId: 'route' });
  assert.equal(prepared.status, 501); assert.equal(prepared.body.error.code, 'EXECUTION_ADAPTER_UNAVAILABLE');
  for (const name of schemas.Error.required) assert.ok(Object.hasOwn(prepared.body, name));
});

// A small structural assertion for the JSON Schema keywords used in output schemas.
// This is not a substitute for a general-purpose JSON Schema validator.
function conforms(value, schema) {
  if (schema.$ref) return conforms(value, schemas[schema.$ref.split('/').at(-1)]);
  if (Object.hasOwn(schema, 'const')) assert.deepEqual(value, schema.const);
  if (schema.type) {
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    assert.ok(allowed.includes(actual) || actual === 'number' && allowed.includes('integer') && Number.isInteger(value));
  }
  if (typeof value === 'string' && schema.pattern) assert.match(value, new RegExp(schema.pattern));
  if (typeof value === 'number' && schema.minimum !== undefined) assert.ok(value >= schema.minimum);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) assert.ok(Object.hasOwn(value, key), 'Missing ' + key);
    for (const [key, child] of Object.entries(schema.properties ?? {})) if (Object.hasOwn(value, key)) conforms(value[key], child);
  }
  if (Array.isArray(value) && schema.items) for (const child of value) conforms(child, schema.items);
}
test('real engine candidates and quote fields conform, including unknown costs and winner ID', async () => {
  const result = await createQuoteService({ fetch: fixtureWire() }).quote(realInput);
  assert.ok(result.candidates.length > 0); assert.ok(result.candidates.some(row => row.feeBps === null));
  const snapshot = { ...result, providerRequestId: result.requestId, apiVersion: '1', requestId: 'req_test', appId: app.id,
    quoteId: 'q_00000000-0000-4000-8000-000000000000', request: realInput, requestHash: '0'.repeat(64), snapshotExpiresAtMs: result.validUntilMs };
  conforms(snapshot, schemas.QuoteSnapshot);
  for (const row of result.candidates) {
    assert.throws(() => conforms({ ...row, expectedOutputRaw: null }, schemas.Candidate));
    assert.throws(() => conforms({ ...row, feeBps: 0.5 }, schemas.Candidate));
    assert.throws(() => conforms({ ...row, executionReady: true }, schemas.Candidate));
  }
  assert.throws(() => conforms({ ...snapshot, winner: result.candidates[0] }, schemas.QuoteSnapshot));
  assert.throws(() => conforms({ ...snapshot, quoteRttMs: null }, schemas.QuoteSnapshot));
});
