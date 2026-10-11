import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuoteService } from '@instinct/router-engine';
import { createRouterApi } from '@instinct/router-server';
import { createRouterServerClient } from '@instinct/router-sdk/server';
import { independentWire } from './fixtures/independent.mjs';
import { BASE, SOL, evmWallet, baseUsdc, solUsdc } from './fixtures/provider.mjs';
const input = { source: { chainId: BASE, address: '0x' + '0'.repeat(40), decimals: 18 }, destination: baseUsdc,
  amount: '0.00005', sender: evmWallet, recipient: evmWallet, slippageBps: 50 };
const app = { id: 'inspect-test', serverKey: 'server_inspection_test', publishableKey: 'public_inspection_test', allowedOrigins: ['https://inspect.example'] };
test('real SDK/API inspection preserves partial failure evidence and never releases an execution artifact', async t => {
  const calls = [], service = createQuoteService({ independentRoutes: true, fetch: independentWire({ calls }) });
  const api = createRouterApi({ service, apps: [app] });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve)); t.after(() => { api.close(); api.closeAllConnections(); });
  const client = createRouterServerClient({ baseUrl: 'http://127.0.0.1:' + api.address().port, serverKey: app.serverKey });
  assert.equal((await client.getConfig()).capabilities.executionInspection, true);
  const result = await client.inspectExecution(input);
  assert.equal(result.status, 'BLOCKED'); assert.equal(result.readOnly, true); assert.equal(result.executionReady, false);
  assert.equal(result.transactionPrepared, false); assert.equal(result.transaction, undefined); assert.equal(result.quoteId, undefined);
  assert.deepEqual(result.request, input); assert.ok(result.blockers.length); assert.equal(result.fees.complete, false);
  assert.ok(calls.length > 0); assert.ok(calls.every(call => !/relay\.link|aurora\.dev/.test(call.url)));
  for (const call of calls) if (call.init?.body) assert.ok(JSON.parse(call.init.body).every(item => !/send|sign/i.test(item.method)));
});
test('engine inspection refuses unsupported assets, overrides, invalid metadata and disabled scope before RPC', async () => {
  let calls = 0; const fetch = async () => { calls++; throw new Error('Unexpected RPC'); };
  const service = createQuoteService({ independentRoutes: true, fetch });
  for (const bad of [{ ...input, source: baseUsdc, destination: input.source }, { ...input, destination: solUsdc },
    { ...input, destination: { ...baseUsdc, decimals: 18 } }, { ...input, gas: '0x1' }, { ...input, slippageBps: 501 },
    { ...input, sender: input.source.address }, { ...input, amount: '0' }]) await assert.rejects(service.inspectExecution(bad));
  await assert.rejects(createQuoteService({ fetch }).inspectExecution(input), /not enabled/);
  assert.equal(calls, 0);
});
