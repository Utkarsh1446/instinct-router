import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuoteService } from '@instinct/router-engine';
import { createRouterApi } from '@instinct/router-server';
import { createRouterServerClient } from '@instinct/router-sdk/server';
import { independentWire } from './fixtures/independent.mjs';
import { BASE, SOL, evmWallet, solWallet, baseUsdc, solUsdc } from './fixtures/provider.mjs';
const eth = { chainId: BASE, address: '0x' + '0'.repeat(40), decimals: 18 };
const sol = { chainId: SOL, address: '11111111111111111111111111111111', decimals: 9 };
const forward = { source: sol, destination: eth, amount: '0.01', sender: solWallet, recipient: evmWallet, routeScope: 'INDEPENDENT' };

test('real SDK/API/engine construct independent DEX-CCTP-DEX previews in both directions without Relay', async t => {
  const calls = [], service = createQuoteService({ independentRoutes: true, fetch: independentWire({ calls }) });
  const app = { id: 'independent-test', serverKey: 'server_independent_test', publishableKey: 'public_independent_test', allowedOrigins: ['https://independent.example'] };
  const api = createRouterApi({ service, apps: [app] });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  t.after(() => { api.close(); api.closeAllConnections(); });
  const client = createRouterServerClient({ baseUrl: 'http://127.0.0.1:' + api.address().port, serverKey: app.serverKey });
  const config = await client.getConfig(); assert.equal(config.capabilities.independentRoutes, true);
  for (const input of [forward, { ...forward, source: eth, destination: sol, amount: '0.001', sender: evmWallet, recipient: solWallet }]) {
    const result = await client.quote(input);
    assert.equal(result.failures.length, 0, JSON.stringify(result.failures));
    assert.equal(result.candidates.length, 2); assert.equal(result.winner, null);
    for (const route of result.candidates) {
      assert.equal(route.routeKind, 'COMPOSED'); assert.equal(route.routingFamily, 'INDEPENDENT');
      assert.equal(route.conditional, true); assert.equal(route.executionReady, false); assert.equal(route.feeBps, null);
      assert.deepEqual(route.steps.map(step => step.kind), ['SWAP', 'BRIDGE', 'SWAP']);
      assert.deepEqual(route.steps.map(step => step.requiresRequoteAfterSettlement), [false, true, true]);
      assert.deepEqual(route.steps[0].source, input.source); assert.deepEqual(route.steps[2].destination, input.destination);
      for (let index = 1; index < 3; index++) assert.equal(route.steps[index].amountInRaw, route.steps[index - 1].minimumOutputRaw);
    }
    assert.ok(result.excluded.every(row => row.reasons.includes('UNKNOWN_COSTS')));
    assert.deepEqual(await client.getQuote(result.quoteId), result);
  }
  assert.ok(calls.every(call => !/relay\.link|aurora\.dev/.test(call.url)));
  const baseBatches = calls.filter(call => call.url === 'https://mainnet.base.org').map(call => JSON.parse(call.init.body));
  assert.ok(baseBatches.length > 0);
  assert.ok(baseBatches.every(batch => batch.length === 2));
  assert.ok(baseBatches.flat().filter(call => call.method === 'eth_call').every(call => call.params[0].data.startsWith('0x82ad56cb')));
  assert.equal(calls.filter(call => call.url.includes('raydium.io') && new URL(call.url).searchParams.get('inputMint').startsWith('So111')).length, 1);
});

test('all-source comparison keeps aggregator direct quotes while independent previews cannot understate costs', async () => {
  const calls = [], service = createQuoteService({ independentRoutes: true, fetch: independentWire({ calls }) });
  const result = await service.quote({ ...forward, routeScope: 'ALL' });
  assert.equal(result.candidates.find(row => row.id === result.winner).provider, 'relay');
  assert.equal(result.candidates.filter(row => row.routingFamily === 'INDEPENDENT').length, 2);
  assert.equal(calls.filter(call => call.url.includes('relay.link')).length, 1);
});

test('engine preserves destination preparation and reports its overlapping work separately', async () => {
  const events = [], wire = independentWire();
  let releaseSource, seeHeader;
  const sourceBarrier = new Promise(resolve => { releaseSource = resolve; });
  const headerSeen = new Promise(resolve => { seeHeader = resolve; });
  const service = createQuoteService({ independentRoutes: true, fetch: async (url, init) => {
    if (url.includes('raydium.io')) {
      events.push('source-start');
      await sourceBarrier;
      events.push('source-end');
    }
    if (url === 'https://mainnet.base.org') {
      const batch = JSON.parse(init.body);
      if (batch.some(call => call.method === 'eth_getBlockByNumber')) {
        events.push('destination-header'); seeHeader();
      } else events.push('destination-amount-pricing');
    }
    return wire(url, init);
  } });
  const work = service.quote(forward);
  try {
    await Promise.race([headerSeen, work.then(() => { throw new Error('Quote ended before destination preparation.'); })]);
    assert.deepEqual(events, ['source-start', 'destination-header']);
  } finally { releaseSource(); }
  const result = await work;
  assert.equal(result.failures.length, 0, JSON.stringify(result.failures));
  assert.equal(events.filter(event => event === 'destination-header').length, 1);
  assert.ok(events.indexOf('source-end') < events.indexOf('destination-amount-pricing'));
  const timings = result.providerTimings.filter(row => row.provider === 'uniswap-v3');
  assert.equal(timings.filter(row => row.phase === 'PREPARATION').length, 1);
  assert.equal(timings.filter(row => row.phase === 'QUOTE').length, 2);
  assert.ok(timings.every(row => row.outcome === 'SUCCESS' && row.rttMs >= 0));
});

test('independent scope also supports direct DEX swaps and native-USDC-only bridges', async () => {
  const service = createQuoteService({ independentRoutes: true, fetch: independentWire() });
  for (const input of [
    { ...forward, destination: solUsdc, recipient: solWallet },
    { ...forward, source: eth, destination: baseUsdc, sender: evmWallet, recipient: evmWallet, amount: '0.001' },
    { ...forward, source: solUsdc, destination: baseUsdc, amount: '1' },
  ]) {
    const result = await service.quote(input);
    assert.ok(result.candidates.length > 0); assert.equal(result.failures.length, 0);
    assert.ok(result.candidates.every(row => row.steps.length === 1 && row.routingFamily === 'INDEPENDENT'));
  }
});
