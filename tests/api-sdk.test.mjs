import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuoteService } from '@instinct/router-engine';
import { createRouterApi } from '@instinct/router-server';
import { createRouterClient } from '@instinct/router-sdk';
import { createRouterServerClient } from '@instinct/router-sdk/server';
import { fixtureWire, input } from './fixtures/provider.mjs';

test('external SDK and real API/engine agree on quotes, app ownership, capabilities, expiry and execution-unavailable', async t => {
  const calls = []; let offset = 0;
  // Keep the engine clock advancing with the core during a real HTTP request;
  // only move it ahead when exercising cached snapshot expiry below.
  const clock = () => Date.now() + offset;
  const apps = ['instinct', 'third-party'].map(id => ({ id, publishableKey: 'public_key_for_' + id, serverKey: 'server_key_for_' + id,
    allowedOrigins: ['https://' + id + '.example'], rateLimitPerMinute: 100, maxConcurrent: 2 }));
  const service = createQuoteService({ fetch: fixtureWire({ calls, now: clock }), now: clock });
  const api = createRouterApi({ service, apps, now: clock });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  t.after(() => { api.close(); api.closeAllConnections(); });
  const baseUrl = 'http://127.0.0.1:' + api.address().port;
  const client = createRouterServerClient({ baseUrl, serverKey: apps[0].serverKey });
  const thirdParty = createRouterServerClient({ baseUrl, serverKey: apps[1].serverKey });
  const browser = createRouterClient({ baseUrl, publishableKey: apps[0].publishableKey,
    fetch: (url, init) => fetch(url, { ...init, headers: { ...init.headers, Origin: apps[0].allowedOrigins[0] } }) });
  const config = await browser.getConfig();
  assert.equal(config.execution.enabled, false); assert.equal(config.assets.length, 8);
  const cap = await client.getCapabilities();
  assert.equal(cap.capabilities.walletExecution, false);
  assert.equal(cap.assetClasses.find(row => row.id === 'prediction_position').pricing, false);
  const quote = await client.quote(input, { idempotencyKey: 'integration-quote' });
  assert.equal(quote.appId, 'instinct'); assert.ok(quote.winner);
  assert.equal(quote.request.sender, input.sender); assert.equal(quote.request.amount, '1');
  assert.match(quote.requestHash, /^[a-f0-9]{64}$/); assert.ok(quote.providerRequestId);
  const count = calls.length;
  assert.deepEqual(await browser.getQuote(quote.quoteId), quote);
  assert.deepEqual(await client.quote(input, { idempotencyKey: 'integration-quote' }), quote);
  assert.equal(calls.length, count);
  await assert.rejects(thirdParty.getQuote(quote.quoteId), error => error.code === 'QUOTE_NOT_FOUND');
  await assert.rejects(client.prepareExecution({ quoteId: quote.quoteId, candidateId: quote.winner }), error => error.status === 501 && error.code === 'EXECUTION_ADAPTER_UNAVAILABLE');
  offset = quote.snapshotExpiresAtMs - Date.now() + 1;
  await assert.rejects(client.getQuote(quote.quoteId), error => error.status === 410 && error.code === 'QUOTE_EXPIRED');
  await assert.rejects(client.quote(input, { idempotencyKey: 'integration-quote' }), error => error.code === 'IDEMPOTENCY_EXPIRED');
});
