import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuoteService } from '../src/index.mjs';
import { fixtureWire, input, SOL, BASE, solWallet, evmWallet } from '../../../tests/fixtures/provider.mjs';
const mint = 'F6EDRhRzXGmkBabhSHdAnqx26XLhG6NCa83wwuqFpump';

test('explicit-wallet engine compares fresh provider costs without exporting transaction or protocol artifacts', async () => {
  const calls = [];
  const service = createQuoteService({ fetch: fixtureWire({ calls }) });
  const result = await service.quote(input);
  assert.equal(result.wallets.sender, evmWallet); assert.equal(result.wallets.recipient, solWallet);
  assert.equal(result.wallets.senderBasis, 'USER_PROVIDED');
  assert.equal(result.execution.enabled, false); assert.equal(result.readOnly, true);
  assert.ok(result.winner); assert.ok(result.candidates.some(row => row.provider === 'relay' && row.eligible));
  assert.ok(result.candidates.filter(row => row.provider.startsWith('cctp')).every(row => row.feeBps === null && !row.eligible));
  assert.ok(result.candidates.every(row => row.executionReady === false));
  assert.doesNotMatch(JSON.stringify(result), /orderData|orderId|calldata|signature|executableRecipeId/);
  const wire = calls.find(row => row.url.includes('relay'));
  assert.equal(JSON.parse(wire.init.body).amount, '1000000');
  assert.equal(JSON.parse(wire.init.body).user, evmWallet);
  assert.ok(result.serviceRttMs >= result.quoteRttMs - 1);
});
test('an explicit null fee preference removes only the user ceiling and keeps unknown costs excluded', async () => {
  const service = createQuoteService({ fetch: fixtureWire() });
  const automatic = await service.quote({ ...input, maxFeeBps: null });
  assert.equal(automatic.maxFeeBps, null);
  assert.ok(automatic.winner);
  assert.ok(automatic.candidates.filter(candidate => candidate.feeBps === null).every(candidate => !candidate.eligible));
  const limited = await service.quote({ ...input, maxFeeBps: 0 });
  assert.equal(limited.maxFeeBps, 0);
  assert.equal(limited.winner, null);
  const omitted = { ...input }; delete omitted.maxFeeBps;
  assert.equal((await service.quote(omitted)).maxFeeBps, 500);
});

test('missing wallets, client execution policy and token decimal drift fail before RFQ', async () => {
  let calls = 0;
  const service = createQuoteService({ fetch: async () => { calls++; throw new Error(); } });
  for (const body of [{ ...input, sender: undefined }, { ...input, recipient: undefined }, { ...input, appId: 'evil' },
    { ...input, executionReady: true }, { ...input, providerUrl: 'https://evil.example' },
    { ...input, source: { ...input.source, decimals: 18 } }])
    await assert.rejects(service.quote(body), error => error.status === 400);
  assert.equal(calls, 0);
  const metadata = createQuoteService({ fetch: async () => { calls++; throw new Error(); },
    resolveAsset: async asset => ({ ...asset, decimals: 6, metadataVerified: true, decimalsSource: 'FINALIZED_CHAIN', tokenProgram: 'TokenProgram' }) });
  await assert.rejects(metadata.quote({ ...input, destination: { chainId: SOL, address: mint, decimals: 9 } }), error => error.code === 'TOKEN_DECIMALS_MISMATCH');
  assert.equal(calls, 0);
});

test('configured direction timings are exposed as unmeasured policies and pricing unknowns do not win', async () => {
  const timing = { [BASE]: { sourceConfirmationMs: 1000, destinationVerificationMs: 2000 }, [SOL]: { sourceConfirmationMs: 3000, destinationVerificationMs: 4000 } };
  const service = createQuoteService({ fetch: fixtureWire(), chainTiming: timing });
  const forward = await service.quote(input);
  assert.equal(forward.candidates.find(row => row.provider === 'relay').estimatedCompletionMs, 17000);
  const reverse = await service.quote({ ...input, source: input.destination, destination: input.source, sender: solWallet, recipient: evmWallet });
  assert.equal(reverse.candidates.find(row => row.provider === 'relay').estimatedCompletionMs, 17000);
  const cfg = service.config();
  assert.equal(cfg.chains[0].sourceConfirmationMs, 1000);
  assert.equal(cfg.chains[0].timingBasis, 'CONFIGURED_UNMEASURED_POLICY');
  assert.equal(cfg.capabilities.walletExecution, false);
  assert.deepEqual(cfg.providers.find(row => row.id === 'cctp-fast').chainIds, [BASE, SOL]);
  assert.equal(cfg.providers.find(row => row.id === 'cctp-fast').fullCostVerification, 'NOT_CONFIGURED');
  assert.equal(cfg.providers.find(row => row.id === 'aurora').quoteMode, 'DRY_PREVIEW');
  assert.equal(cfg.assetClasses.find(row => row.id === 'broker_stock').pricing, false);
  cfg.chains[0].sourceConfirmationMs = 999;
  assert.equal(service.config().chains[0].sourceConfirmationMs, 1000);
});

test('metadata latency is included in service RTT and provider failures contain no credential text', async () => {
  const service = createQuoteService({ fetch: fixtureWire(), resolveAsset: async asset => {
    await new Promise(resolve => setTimeout(resolve, 20));
    return { ...asset, decimals: 6, metadataVerified: true, decimalsSource: 'FINALIZED_CHAIN', tokenProgram: 'TokenProgram' };
  } });
  const result = await service.quote({ ...input, destination: { chainId: SOL, address: mint, decimals: 6 } });
  assert.ok(result.serviceRttMs >= 18);
  assert.ok(result.serviceRttMs >= result.quoteRttMs + 10);
  const unavailable = createQuoteService({ providerKeys: { RELAY_API_KEY: 'hidden-key' }, fetch: async () => { throw new Error('hidden-key upstream'); } });
  const failed = await unavailable.quote(input);
  assert.equal(failed.winner, null);
  assert.doesNotMatch(JSON.stringify(failed), /hidden-key|upstream/);
});

test('trusted provider and timing configuration rejects unknown or malformed policy before work', () => {
  for (const options of [{ providerKeys: { walletSecret: 'bad' } }, { providerKeys: { RELAY_API_KEY: undefined } },
    { providerKeys: { RELAY_API_KEY: 'secret\nheader' } }, { fetch: 'invalid' }, { auroraPolicy: { feeRecipient: '' } },
    { auroraPolicy: { nativeFeeBps: 501 } }, { chainTiming: { 'eip155:999': {} } },
    { chainTiming: { [BASE]: { sourceConfirmationMs: -1 } } }, { independentRoutes: 'yes' }])
    assert.throws(() => createQuoteService(options), error => error.status === 400);
});
test('independent routing is an explicit trusted opt-in and invalid scopes do no provider work', async () => {
  let calls = 0;
  const service = createQuoteService({ fetch: async () => { calls++; throw new Error(); } });
  await assert.rejects(service.quote({ ...input, routeScope: 'INDEPENDENT' }), error => error.code === 'INDEPENDENT_ROUTES_UNAVAILABLE');
  await assert.rejects(service.quote({ ...input, routeScope: 'MAGIC' }), error => error.code === 'INVALID_ROUTE_SCOPE');
  assert.equal(calls, 0); assert.equal(service.config().capabilities.independentRoutes, false);
});
