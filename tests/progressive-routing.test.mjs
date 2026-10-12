import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuoteService } from '@instinct/router-engine';
import { createRouterApi } from '@instinct/router-server';
import { createRouterServerClient } from '@instinct/router-sdk/server';
import { input, BASE, SOL } from './fixtures/provider.mjs';
import { independentWire } from './fixtures/independent.mjs';

function wire(calls, beforeDln = async () => {}) {
  const other = independentWire();
  return async (url, init) => {
    calls.push(url);
    if (!url.startsWith('https://dln.debridge.finance/')) return other(url, init);
    await beforeDln();
    const query = new URL(url).searchParams;
    return Response.json({ estimation: {
      srcChainTokenIn: { chainId: Number(query.get('srcChainId')), address: query.get('srcChainTokenIn'),
        decimals: 6, amount: query.get('srcChainTokenInAmount'), mutatedWithOperatingExpense: false },
      dstChainTokenOut: { chainId: Number(query.get('dstChainId')), address: query.get('dstChainTokenOut'),
        decimals: 6, amount: '1000000', recommendedAmount: '995000', maxTheoreticalAmount: '1005000' },
      recommendedSlippage: 0.5,
    }, tx: { data: 'MUST_NOT_ESCAPE' } });
  };
}

test('DLN is operator opt-in, cross-chain direct-only, and cannot win with unknown economics', async () => {
  const calls = [], fetch = wire(calls);
  const ordinary = createQuoteService({ fetch });
  await ordinary.quote(input);
  assert.equal(calls.some(url => url.includes('debridge')), false);
  assert.equal(ordinary.config().capabilities.debridgeRoutes, false);
  assert.throws(() => createQuoteService({ debridgeRoutes: 'true' }), error => error.code === 'INVALID_PROVIDER_CONFIG');
  const service = createQuoteService({ fetch, debridgeRoutes: true, independentRoutes: true });
  const result = await service.quote(input);
  const preview = result.candidates.find(row => row.provider === 'debridge');
  assert.ok(preview); assert.equal(preview.routingFamily, 'AGGREGATOR');
  assert.equal(preview.conditional, true); assert.equal(preview.eligible, false);
  assert.equal(preview.feeBps, null); assert.equal(preview.priceImpactBps, null);
  assert.equal(preview.estimatedCompletionMs, null); assert.equal(preview.executionReady, false);
  assert.equal(preview.steps.length, 1);
  assert.equal(calls.filter(url => url.includes('debridge')).length, 1);
  assert.notEqual(result.winner, preview.id); assert.doesNotMatch(JSON.stringify(result), /MUST_NOT_ESCAPE/);
  const config = service.config();
  assert.equal(config.capabilities.debridgeRoutes, true);
  assert.ok(config.providers.find(row => row.id === 'debridge').chainIds.includes(SOL));
  calls.length = 0;
  await service.quote({ ...input, routeScope: 'INDEPENDENT' });
  assert.equal(calls.some(url => /debridge|relay/.test(url)), false);
  await service.quote({ ...input, source: { chainId: BASE, address: '0x' + '0'.repeat(40), decimals: 18 },
    destination: input.source, recipient: input.sender, amount: '0.001' });
  assert.equal(calls.some(url => url.includes('debridge')), false);
});

test('real SDK/API/engine exposes early routes and binds final DLN preview to its saved snapshot', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; }); t.after(release);
  const calls = [], service = createQuoteService({ fetch: wire(calls, () => gate), debridgeRoutes: true });
  const app = { id: 'progressive-app', publishableKey: 'pk_progressive_example', serverKey: 'sk_progressive_example', allowedOrigins: ['https://app.example'] };
  const api = createRouterApi({ service, apps: [app] });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  t.after(async () => { api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); });
  const client = createRouterServerClient({ baseUrl: `http://127.0.0.1:${api.address().port}`, serverKey: app.serverKey,
    fetch:async(url,init)=>{const response=await fetch(url,init);assert.match(response.headers.get('access-control-expose-headers'),/\bDate\b/);assert.ok(Number.isFinite(Date.parse(response.headers.get('date'))));return response;} });
  let first; const arrived = new Promise(resolve => { first = resolve; });
  const candidates = []; let complete = false;
  const pending = client.quoteStream(input, { onCandidate(candidate, metadata) {
    assert.equal(metadata.provisional, true); assert.equal(metadata.appId, app.id);
    assert.equal(metadata.executionReady, false); candidates.push(structuredClone(candidate));
    candidate.expectedOutputRaw = '999999'; // A UI callback cannot change final authority.
    first();
  } }).then(value => { complete = true; return value; });
  await arrived;
  assert.equal(complete, false); assert.ok(candidates.length > 0);
  assert.equal(candidates.some(row => row.provider === 'debridge'), false);
  release();
  const result = await pending;
  assert.ok(candidates.some(row => row.provider === 'debridge'));
  assert.equal(result.candidates.length, candidates.length);
  assert.ok(result.candidates.every(row => row.expectedOutputRaw !== '999999'));
  assert.equal(result.execution.enabled, false);
  assert.deepEqual(await client.getQuote(result.quoteId), result);
  assert.equal(calls.filter(url => url.includes('debridge')).length, 1);
});
