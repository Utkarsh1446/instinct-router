import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityRegistry } from '../dist/capabilities.js';
import { DynamicRouter } from '../dist/router.js';
import { createRelayAdapter } from '../dist/provider-adapters.js';
import { createNearIntentsOneClickAdapter, nearIntentsQuoteCanonical, nearIntentsQuoteHash, NEAR_INTENTS_ADAPTER_ID, NEAR_INTENTS_QUOTE_ORIGIN } from '../dist/near-intents-provider.js';
import type { NearIntentsOneClickOptions, OneClickToken } from '../dist/near-intents-provider.js';
import type { QuoteContext } from '../dist/router.js';
import type { Asset, RouteCapability, RouterRequest } from '../dist/types.js';

const now = 1_800_000_000_000;
const source: Asset = { chainId: 'eip155:1', address: '0x0000000000000000000000000000000000000000', decimals: 18 };
const destination: Asset = { chainId: 'eip155:8453', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 };
const sender = '0x1111111111111111111111111111111111111111';
const recipient = '0x2222222222222222222222222222222222222222';
const originAsset = 'nep141:eth.omft.near';
const destinationAsset = 'nep141:base-usdc.omft.near';
const chains = [
  { chainId: source.chainId, blockchain: 'eth', sourceConfirmationMs: 1000 },
  { chainId: destination.chainId, blockchain: 'base', destinationVerificationMs: 24000 },
];
const tokens: OneClickToken[] = [
  { assetId: originAsset, blockchain: 'eth', decimals: 18, symbol: 'ETH', contractAddress: null },
  { assetId: destinationAsset, blockchain: 'base', decimals: 6, symbol: 'USDC', contractAddress: destination.address },
];
function context(amount = '1000'): QuoteContext {
  const request: RouterRequest = {
    requestId: 'near-1', source, destination, amountRaw: amount, sender, recipient, slippageBps: 100,
    maxFeeBps: 100, maxPriceImpactBps: 500, maxCompletionMs: 120000, deadlineMs: now + 120000,
    optimization: { objective: 'BALANCED', maxOutputShortfallBps: 50 },
  };
  return {
    request, amountRaw: amount, sender, recipient, slippageBps: 100, deadlineMs: now + 120000,
    transportDeadlineMs: now + 20000, signal: new AbortController().signal,
    leg: { index: 0, adapterId: NEAR_INTENTS_ADAPTER_ID, capabilityId: 'near-intents-1click:eth-usdc', kind: 'SWAP_BRIDGE',
      source, destination, validationTier: 'QUOTE_VALIDATED', executionTier: 'NONE', quoteProbe: true,
      amountSource: 'REQUEST_AMOUNT', requiresRequoteAfterSettlement: false },
  };
}
function oneClick(sent: Record<string, unknown>, mutate?: (raw: Record<string, unknown>) => void) {
  const raw: Record<string, unknown> = {
    correlationId: 'corr-1', timestamp: new Date(now).toISOString(), signature: 'ed25519:public-signature',
    quoteRequest: { ...sent, confidentiality: 'public', insured: false, appFees: [{ recipient: 'ab'.repeat(32), fee: 20 }] },
    quote: { amountIn: sent.amount, minAmountIn: sent.amount, amountOut: '2100', minAmountOut: '2079', amountInUsd: '100',
      amountOutUsd: '99.8', timeEstimate: 20 },
  };
  mutate?.(raw);
  return raw;
}
function response(value: unknown) { return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } }); }
function options(mutate?: (raw: Record<string, unknown>) => void, extra: Partial<NearIntentsOneClickOptions> = {}): { calls: { url: string; init: RequestInit }[]; options: NearIntentsOneClickOptions } {
  const calls: { url: string; init: RequestInit }[] = [];
  return { calls, options: { chains, clock: () => now, assets: [{ asset: source, assetId: originAsset }, { asset: destination, assetId: destinationAsset }],
    fetch: async (url, init) => {
      calls.push({ url, init });
      const sent = init.body ? JSON.parse(init.body as string) as Record<string, unknown> : {};
      return response(oneClick(sent, mutate));
    }, ...extra } };
}
test('1Click dry quote binds output, the injected 20 bps fee, ETA and a withheld deposit address', async () => {
  const fixture = options();
  const quote = await createNearIntentsOneClickAdapter({ ...fixture.options, apiKey: 'partner-key' }).quote(context());
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0]!.url, `${NEAR_INTENTS_QUOTE_ORIGIN}/v0/quote`);
  const init = fixture.calls[0]!.init;
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error');
  assert.equal((init.headers as Record<string, string>)['x-api-key'], 'partner-key');
  assert.equal(fixture.calls[0]!.url.includes('partner-key'), false);
  const sent = JSON.parse(init.body as string);
  assert.equal(sent.dry, true);
  assert.equal(sent.swapType, 'EXACT_INPUT');
  assert.equal(sent.depositType, 'ORIGIN_CHAIN');
  assert.equal(sent.originAsset, originAsset);
  assert.equal(sent.destinationAsset, destinationAsset);
  assert.equal(sent.quoteWaitingTimeMs, 0);
  assert.equal(quote.dryQuote, true);
  assert.equal(quote.conditional, true);
  assert.equal(quote.executableRecipeId, undefined);
  assert.equal(quote.expectedOutRaw, '2100');
  assert.equal(quote.minimumOutRaw, '2079');
  assert.equal(quote.protocolFeeBps, 20);
  assert.equal(quote.feeBps, 20);
  assert.equal(quote.priceImpactBps, 0);
  assert.equal(quote.estimatedCompletionMs, 45000);
  assert.equal(quote.expiresAtMs, now + 20000);
  assert.equal(quote.dryDeposit.mode, 'DRY');
  assert.equal(quote.dryDeposit.spendable, false);
  assert.equal(quote.dryDeposit.depositAddress, null);
  assert.equal(quote.dryDeposit.steps[1]!.state, 'withheld');
  assert.equal(quote.dryDeposit.steps[2]!.state, 'blocked');
  const canonical = nearIntentsQuoteCanonical({ amountIn: '1000', amountOut: '2100', correlationId: 'corr-1',
    destinationAsset, minAmountOut: '2079', originAsset });
  assert.equal(canonical, '{"amountIn":"1000","amountOut":"2100","correlationId":"corr-1","destinationAsset":"nep141:base-usdc.omft.near","minAmountOut":"2079","originAsset":"nep141:eth.omft.near"}');
  assert.equal(await nearIntentsQuoteHash(canonical), '92d58abe82db7e7ba35951f78c62d92703b7cecfa5b7105e33edbc6c25b3e693');
  assert.equal(quote.quoteHash, '92d58abe82db7e7ba35951f78c62d92703b7cecfa5b7105e33edbc6c25b3e693');
  assert.equal(quote.quoteId, `1click:${quote.quoteHash}`);
});
test('USD shortfall above the protocol fee is the residual price impact', async () => {
  const quote = await createNearIntentsOneClickAdapter(options(raw => { (raw.quote as Record<string, unknown>).amountOutUsd = '90'; }).options).quote(context());
  assert.equal(quote.feeBps, 20);
  assert.equal(quote.priceImpactBps, 980);
  assert.equal(quote.economicsBasis, 'PROTOCOL_APP_FEE_PLUS_USD_RESIDUAL');
});
test('a catalog match is used only for an explicit contract address', async () => {
  const fixture = options();
  const quote = await createNearIntentsOneClickAdapter({ ...fixture.options, assets: [{ asset: source, assetId: originAsset }],
    fetch: async (url, init) => {
      fixture.calls.push({ url, init });
      if (url.endsWith('/v0/tokens')) return response(tokens);
      return response(oneClick(JSON.parse(init.body as string)));
    } }).quote(context());
  assert.equal(quote.dryDeposit.destinationAssetId, destinationAsset);
  assert.equal(fixture.calls[0]!.url, `${NEAR_INTENTS_QUOTE_ORIGIN}/v0/tokens`);
  await assert.rejects(createNearIntentsOneClickAdapter({ chains, clock: () => now, fetch: async () => response(tokens) }).quote(context()), /ASSET_UNSUPPORTED/);
});
test('dry mode cannot be turned off, and a deposit address or unreviewed fee is rejected', async () => {
  assert.throws(() => createNearIntentsOneClickAdapter({ ...options().options, dry: false as unknown as true }), /DRY_MODE_REQUIRED/);
  const rejected = [
    (raw: Record<string, unknown>) => { (raw.quote as Record<string, unknown>).depositAddress = sender; },
    (raw: Record<string, unknown>) => { (raw.quote as Record<string, unknown>).deadline = new Date(now + 10000).toISOString(); },
    (raw: Record<string, unknown>) => { (raw.quote as Record<string, unknown>).depositMemo = '111'; },
    (raw: Record<string, unknown>) => { (raw.quoteRequest as Record<string, unknown>).appFees = [{ recipient: 'ab'.repeat(32), fee: 51 }]; },
    (raw: Record<string, unknown>) => { (raw.quoteRequest as Record<string, unknown>).appFees = [{ recipient: 'ab'.repeat(32), fee: 20 }, { recipient: 'cd'.repeat(32), fee: 1 }]; },
    (raw: Record<string, unknown>) => { (raw.quoteRequest as Record<string, unknown>).confidentiality = 'advanced'; },
    (raw: Record<string, unknown>) => { (raw.quoteRequest as Record<string, unknown>).insured = true; },
    (raw: Record<string, unknown>) => { (raw.quoteRequest as Record<string, unknown>).amount = '999'; },
    (raw: Record<string, unknown>) => { (raw.quote as Record<string, unknown>).minAmountOut = '2000'; },
    (raw: Record<string, unknown>) => { (raw.quote as Record<string, unknown>).minAmountOut = '1800'; },
    (raw: Record<string, unknown>) => { raw.timestamp = new Date(now - 300001).toISOString(); },
  ];
  for (const mutate of rejected) await assert.rejects(createNearIntentsOneClickAdapter(options(mutate).options).quote(context()));
});
test('empty app fees fall back to the USD shortfall and do not invent a protocol fee', async () => {
  const quote = await createNearIntentsOneClickAdapter(options(raw => { (raw.quoteRequest as Record<string, unknown>).appFees = []; }).options).quote(context());
  assert.equal(quote.protocolFeeBps, 0);
  assert.equal(quote.feeBps, 20);
  assert.equal(quote.priceImpactBps, 0);
  assert.equal(quote.economicsBasis, 'USD_SHORTFALL');
});

function relay(nowMs: number) {
  return {
    details: {
      sender, recipient,
      currencyIn: { currency: { chainId: 1, address: source.address, decimals: 18 }, amount: '1000', amountUsd: '100' },
      currencyOut: { currency: { chainId: 8453, address: destination.address, decimals: 6 }, amount: '2000', minimumAmount: '1980' },
      timeEstimate: 12,
      swapImpact: { percent: '0.15' },
      expandedPriceImpact: { execution: { usd: '0.1' }, relay: { usd: '0.2' }, app: { usd: '0.05' } },
    },
    fees: { gas: { amountUsd: '0.05' } },
    protocol: { v2: { orderId: '0x' + '11'.repeat(32), orderData: {
      inputs: [{ payment: { chainId: 'ethereum', currency: source.address, amount: '1000' } }],
      output: {
        chainId: 'base', calls: [], deadline: Math.floor((nowMs + 30000) / 1000),
        payments: [{ recipient, currency: destination.address, expectedAmount: '2000', minimumAmount: '1980' }],
      },
    } } },
  };
}
function edge(adapterId: string): RouteCapability {
  return { id: `${adapterId}:eth-usdc`, adapterId, source, destination, kind: 'SWAP_BRIDGE', validationTier: 'QUOTE_VALIDATED',
    executionTier: 'NONE', liquidity: 'UNKNOWN', validUntilMs: Date.now() + 600000 };
}
test('DynamicRouter ranks 1Click against Relay on output and ETA without authorizing execution', async () => {
  const clock = Math.floor(Date.now() / 1000) * 1000;
  const request: RouterRequest = { requestId: 'compare-1', source, destination, amountRaw: '1000', sender, recipient, slippageBps: 100,
    maxFeeBps: 100, maxPriceImpactBps: 500, maxCompletionMs: 120000, deadlineMs: clock + 180000,
    optimization: { objective: 'BEST_OUTPUT', maxOutputShortfallBps: 0 } };
  const pinned = options().options;
  const near = createNearIntentsOneClickAdapter({ ...pinned, clock: () => clock, fetch: async (_url, init) => response(oneClick(JSON.parse(init.body as string), raw => {
    raw.timestamp = new Date(clock).toISOString();
    const quoted = raw.quote as Record<string, unknown>;
    quoted.amountOut = '2020'; quoted.minAmountOut = '2000';
  })) });
  const relayAdapter = createRelayAdapter({ clock: () => clock, fetch: async () => response(relay(clock)), chains: [
    { chainId: source.chainId, relayChainId: 1, relayProtocolChainId: 'ethereum', sourceConfirmationMs: 1000 },
    { chainId: destination.chainId, relayChainId: 8453, relayProtocolChainId: 'base', destinationVerificationMs: 24000 }] });
  const router = new DynamicRouter(new CapabilityRegistry([edge(NEAR_INTENTS_ADAPTER_ID), edge('relay')]), [near, relayAdapter],
    { quoteBudgetMs: 2000, providerTimeoutMs: 1500 });
  const best = await router.quote(request);
  assert.equal(best.executionAuthorized, false);
  assert.equal(best.comparisonComplete, true);
  assert.equal(best.winner?.legQuotes[0]?.adapterId, NEAR_INTENTS_ADAPTER_ID);
  assert.equal(best.winner?.executionReady, false);
  assert.equal(best.winner?.conditional, true);
  assert.equal(best.eligible.length, 2);
  const balanced = await router.quote({ ...request, requestId: 'compare-2', optimization: { objective: 'BALANCED', maxOutputShortfallBps: 100 } });
  assert.equal(balanced.winner?.legQuotes[0]?.adapterId, 'relay');
  assert.ok(balanced.eligible.some(candidate => candidate.legQuotes[0]?.adapterId === NEAR_INTENTS_ADAPTER_ID));
  const nearLeg = best.candidates.find(candidate => candidate.legQuotes[0]?.adapterId === NEAR_INTENTS_ADAPTER_ID)!;
  assert.equal(nearLeg.legQuotes[0]?.feeBps, 20);
  assert.equal(nearLeg.expectedOutputRaw, '2020');
  assert.equal(best.candidates.find(candidate => candidate.legQuotes[0]?.adapterId === 'relay')?.expectedOutputRaw, '2000');
});
