import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRelayAdapter, createAuroraAdapter, createProviderDiscovery, discoverRelayChains, discoverRelayCurrencies, discoverAuroraTokens } from '../dist/provider-adapters.js';
import type { QuoteContext } from '../dist/router.js';
import type { ProviderOptions } from '../dist/provider-adapters.js';
import type { Asset } from '../dist/types.js';

const now = 1800000000000;
const source = { chainId: 'eip155:1' as const, address: '0x0000000000000000000000000000000000000000', decimals: 18 };
const destination = { chainId: 'eip155:8453' as const, address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 };
const sender = '0x1111111111111111111111111111111111111111', recipient = '0x2222222222222222222222222222222222222222';
const chains = [{ chainId: source.chainId, relayChainId: 1, relayProtocolChainId: 'ethereum', sourceConfirmationMs: 1000, auroraBlockchain: 'eth' },
  { chainId: destination.chainId, relayChainId: 8453, relayProtocolChainId: 'base', destinationVerificationMs: 24000, auroraBlockchain: 'base' }];
function context(id = 'relay'): QuoteContext {
  const request = { requestId: 'r1', source, destination, amountRaw: '1000', sender, recipient,
    slippageBps: 100, maxFeeBps: 100, maxPriceImpactBps: 100, maxCompletionMs: 60000, deadlineMs: now + 60000,
    optimization: { objective: 'BALANCED' as const, maxOutputShortfallBps: 50 } };
  return { request, leg: { index: 0, adapterId: id, capabilityId: `${id}:route`, kind: 'SWAP_BRIDGE', source, destination,
    validationTier: 'QUOTE_VALIDATED', executionTier: 'NONE', quoteProbe: true, amountSource: 'REQUEST_AMOUNT', requiresRequoteAfterSettlement: false },
    amountRaw: '1000', sender, recipient, slippageBps: 100, deadlineMs: now + 60000, transportDeadlineMs: now + 5000, signal: new AbortController().signal };
}
function relay() {
  return { details: { sender, recipient, currencyIn: { currency: { chainId: 1, address: source.address, decimals: 18 }, amount: '1000', amountUsd: '100' },
    currencyOut: { currency: { chainId: 8453, address: destination.address, decimals: 6 }, amount: '2000', minimumAmount: '1980' },
    timeEstimate: 12, swapImpact: { percent: '0.15' }, expandedPriceImpact: { execution: { usd: '0.1' }, relay: { usd: '0.2' }, app: { usd: '0.05' } } },
    fees: { gas: { amountUsd: '0.05' }, relayer: { amountUsd: '9999' } },
    protocol: { v2: { orderId: '0x' + '11'.repeat(32), orderData: { inputs: [{ payment: { chainId: 'ethereum', currency: source.address, amount: '1000' } }], output: { chainId: 'base', calls: [], payments: [{ recipient, currency: destination.address, expectedAmount: '2000', minimumAmount: '1980' }], deadline: (now + 30000) / 1000 } } } } };
}
const tokens = [{ assetId: 'nep141:eth.omft.near', blockchain: 'eth', decimals: 18, symbol: 'ETH' },
  { assetId: 'nep141:base-usdc.omft.near', blockchain: 'base', decimals: 6, symbol: 'USDC', contractAddress: destination.address }];
function response(value: unknown) { return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } }); }
function fake(body: unknown): ProviderOptions {
  return { chains, clock: () => now, fetch: async () => response(body) };
}
function auroraFixture(body: Record<string, unknown>) {
  return { timestamp: new Date(now).toISOString(), signature: 'public-signature', quoteRequest: body,
    quote: { amountIn: '1000', minAmountIn: '1000', amountOut: '2000', minAmountOut: '1980', timeEstimate: 20 } };
}
function auroraOptions(mutate?: (raw: ReturnType<typeof auroraFixture>) => void) {
  const calls: { url: string; init: RequestInit }[] = [];
  return { calls, options: { chains, clock: () => now, apiKey: 'secret-key',
    assets: [{ asset: source, assetId: tokens[0]!.assetId, native: true }],
    fetch: async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('/tokens/')) return response(tokens);
      const raw = auroraFixture(JSON.parse(init.body as string)); mutate?.(raw); return response(raw);
    } } };
}
test('Relay fresh quote binds exact identity, floors and genuine order expiry without execution permission', async () => {
  let count = 0;
  const adapter = createRelayAdapter({ ...fake(relay()), fetch: async (url, init) => {
    count++; assert.equal(url, 'https://api.relay.link/quote/v2'); assert.equal(init.redirect, 'error');
    const sent = JSON.parse(init.body as string); assert.equal(sent.includeProtocolData, true); assert.equal(sent.useDepositAddress, false);
    assert.equal(sent.originChainId, 1); assert.equal(sent.amount, '1000'); return response(relay());
  } });
  const quote = await adapter.quote(context()); await adapter.quote(context());
  assert.equal(count, 2); assert.equal(quote.minimumOutRaw, '1980'); assert.equal(quote.expiresAtMs, now + 30000);
  assert.equal(quote.executableRecipeId, undefined); assert.equal(quote.feeBps, 40); assert.equal(quote.priceImpactBps, 15);
  assert.equal(quote.conditional, false); assert.equal(quote.estimatedCompletionMs, 37000);
});
test('Relay absent economics remain unknown rather than invented zero', async () => {
  const raw = relay(); delete (raw.details as any).expandedPriceImpact; delete (raw.details as any).swapImpact;
  const quote = await createRelayAdapter(fake(raw)).quote(context());
  assert.equal(quote.feeBps, null); assert.equal(quote.priceImpactBps, null);
});
test('Relay rejects changed assets, decimals, sender, recipient, amount, floor and deadline', async () => {
  const mutations = [
    (r: any) => r.details.currencyIn.currency.chainId = 2,
    (r: any) => r.details.currencyOut.currency.address = sender,
    (r: any) => r.details.currencyOut.currency.decimals = 18,
    (r: any) => r.details.sender = recipient,
    (r: any) => r.details.recipient = sender,
    (r: any) => r.details.currencyIn.amount = '999',
    (r: any) => r.details.currencyOut.minimumAmount = '1900',
    (r: any) => r.details.currencyOut.minimumAmount = '2001',
    (r: any) => r.protocol.v2.orderData.output.deadline = now / 1000,
    (r: any) => r.protocol.v2.orderData.output.deadline = undefined,
    (r: any) => r.details.swapImpact.percent = 'NaN',
  ];
  for (const mutate of mutations) { const raw = relay(); mutate(raw); await assert.rejects(createRelayAdapter(fake(raw)).quote(context())); }
});
test('Aurora exact catalog matching, native pin, request echo and dry preview have no execution authority', async () => {
  const { options, calls } = auroraOptions(); const adapter = createAuroraAdapter(options);
  const quote = await adapter.quote(context('aurora')); await adapter.quote(context('aurora'));
  assert.equal(calls.filter(call => call.url.includes('/tokens/')).length, 1);
  assert.equal(calls.filter(call => call.url.includes('/quote/')).length, 2);
  const sent = JSON.parse(calls[1]!.init.body as string);
  assert.equal(sent.originAsset, tokens[0]!.assetId); assert.equal(sent.quoteWaitingTimeMs, 0); assert.equal(sent.dry, true);
  assert.equal(quote.conditional, true); assert.equal(quote.expiresAtMs, now + 15000); assert.equal(quote.executableRecipeId, undefined);
  assert.equal(quote.feeBps, null); assert.equal(quote.priceImpactBps, null); assert.match(quote.quoteId, /^aurora:[0-9a-f]{64}$/);
  await assert.rejects(createAuroraAdapter({ ...options, assets: [] }).quote(context('aurora')), /ASSET_UNSUPPORTED/);
});
test('Aurora rejects echo changes, unreviewed enrichment, low floors, stale timestamps, memo and dry deposits', async () => {
  const mutations = [(r: any) => r.quoteRequest.recipient = sender, (r: any) => r.quoteRequest.appFees = [{ recipient: sender, fee: 10 }],
    (r: any) => r.quote.minAmountOut = '1979', (r: any) => r.quote.amountIn = '1001',
    (r: any) => r.timestamp = new Date(now - 300001).toISOString(), (r: any) => r.quote.depositMemo = 'memo',
    (r: any) => r.quote.depositAddress = sender];
  for (const mutate of mutations) await assert.rejects(createAuroraAdapter(auroraOptions(mutate).options).quote(context('aurora')));
});
test('Aurora firm address quote checks both inactivity and deadline but remains recipe-unverified', async () => {
  const { options } = auroraOptions((raw: any) => Object.assign(raw.quote, { depositAddress: recipient,
    deadline: new Date(now + 50000).toISOString(), timeWhenInactive: new Date(now + 30000).toISOString() }));
  const quote = await createAuroraAdapter({ ...options, dryRun: false }).quote(context('aurora'));
  assert.equal(quote.expiresAtMs, now + 30000); assert.equal(quote.executableRecipeId, undefined); assert.equal(quote.conditional, false);
});
test('discovery maps only trusted chain identifiers and does not infer native from absent contracts', async () => {
  const assets = await discoverRelayCurrencies(fake([{ chainId: 8453, address: destination.address, decimals: 6, symbol: 'USDC', metadata: { isNative: false } },
    { chainId: 999, address: sender, decimals: 18, symbol: 'OTHER', metadata: { isNative: false } }]), new AbortController().signal);
  assert.equal(assets.length, 1); assert.deepEqual(assets[0]!.asset, destination);
  const chainList = await discoverRelayChains(fake({ chains: [{ id: 8453, name: 'base', vmType: 'evm', disabled: false, depositEnabled: true }] }), new AbortController().signal);
  assert.equal(chainList[0]!.id, 8453);
  assert.equal((await discoverAuroraTokens({ ...fake(tokens), apiKey: 'private' }, new AbortController().signal))[0]!.contractAddress, undefined);
});
test('provider errors redact key and upstream response; redirects, oversized and malformed JSON fail', async () => {
  for (const make of [() => new Response('SECRET upstream', { status: 403 }), () => new Response('{'),
    () => new Response('{}', { headers: { 'content-length': '2097153' } }),
    () => new Response('x'.repeat(2097153))]) {
    try { await discoverAuroraTokens({ chains, apiKey: 'secret-key', fetch: async () => make() }, new AbortController().signal); assert.fail('must reject'); }
    catch (error) { assert.doesNotMatch(String(error), /secret-key|SECRET|aurora.dev/); }
  }
  const redirected = new Response('{}'); Object.defineProperty(redirected, 'redirected', { value: true });
  await assert.rejects(discoverRelayChains({ chains, fetch: async () => redirected }, new AbortController().signal), /REDIRECT/);
});
test('cancelled/deadline-expired calls do not invoke fetch; transport receives original signal', async () => {
  let count = 0;
  const adapter = createRelayAdapter({ ...fake(relay()), fetch: async (_url, init) => { count++; assert.equal(init.signal, live.signal); return response(relay()); } });
  const controller = new AbortController(); controller.abort(); const dead = { ...context(), signal: controller.signal };
  await assert.rejects(adapter.quote(dead), /CANCELLED/);
  const expired = { ...context(), deadlineMs: now }; await assert.rejects(adapter.quote(expired), /DEADLINE/); assert.equal(count, 0);
  const live = context(); await adapter.quote(live); assert.equal(count, 1);
});
test('signed Relay price loss uses absolute bounded percent; missing full verification timing stays unknown', async () => {
  const raw = relay(); raw.details.swapImpact.percent = '-0.15';
  const quote = await createRelayAdapter({ ...fake(raw), chains: chains.map(({ sourceConfirmationMs, destinationVerificationMs, ...mapping }) => mapping) }).quote(context());
  assert.equal(quote.priceImpactBps, 15); assert.equal(quote.estimatedCompletionMs, null);
});
test('Relay protocol recipient, chain, floor, currency and destination call drift are rejected', async () => {
  for (const mutate of [(r: any) => r.protocol.v2.orderData.inputs[0].payment.currency = recipient,
    (r: any) => r.protocol.v2.orderData.output.chainId = 'ethereum',
    (r: any) => r.protocol.v2.orderData.output.payments[0].recipient = sender,
    (r: any) => r.protocol.v2.orderData.output.payments[0].minimumAmount = '1',
    (r: any) => r.protocol.v2.orderData.output.calls = [{ to: sender }]]) {
    const raw = relay(); mutate(raw); await assert.rejects(createRelayAdapter(fake(raw)).quote(context()));
  }
  await assert.rejects(createRelayAdapter({ ...fake(relay()), chains: chains.map(({ relayProtocolChainId, ...mapping }) => mapping) }).quote(context()), /UNCONFIGURED/);
});
test('integer rounding floor is accepted but one unit below is rejected', async () => {
  const raw = relay(); raw.details.currencyOut.amount = '2001'; raw.details.currencyOut.minimumAmount = '1980';
  raw.protocol.v2.orderData.output.payments[0]!.expectedAmount = '2001';
  assert.equal((await createRelayAdapter(fake(raw)).quote(context())).minimumOutRaw, '1980');
  raw.details.currencyOut.minimumAmount = '1979'; raw.protocol.v2.orderData.output.payments[0]!.minimumAmount = '1979';
  await assert.rejects(createRelayAdapter(fake(raw)).quote(context()), /OUTPUT_BOUND/);
});
test('Aurora independently configured enrichment exact-match passes; changed policy does not', async () => {
  const { options } = auroraOptions((raw: any) => { raw.quoteRequest.appFees = [{ fee: 10, recipient: sender }]; raw.quoteRequest.referral = 'reviewed'; delete raw.quote.minAmountIn; });
  const quote = await createAuroraAdapter({ ...options, appFees: [{ recipient: sender, fee: 10 }], referral: 'reviewed' }).quote(context('aurora'));
  assert.equal(quote.feeBps, null);
  await assert.rejects(createAuroraAdapter({ ...options, appFees: [{ recipient: sender, fee: 11 }], referral: 'reviewed' }).quote(context('aurora')), /ENRICHMENT/);
});
test('catalog TTL cache clones discovery values and coalesces reads without authorizing every pair', async () => {
  let count = 0;
  const discovery = createProviderDiscovery({ ...fake(tokens), auroraApiKey: 'private', fetch: async () => { count++; return response(tokens); } });
  const signal = new AbortController().signal;
  const [a, b] = await Promise.all([discovery.auroraTokens(signal), discovery.auroraTokens(signal)]);
  a[0]!.symbol = 'changed'; assert.equal(b[0]!.symbol, 'ETH'); assert.equal(count, 1);
  await discovery.auroraTokens(signal); assert.equal(count, 1); discovery.clear(); await discovery.auroraTokens(signal); assert.equal(count, 2);
});
test('Aurora fee variants share catalog transport while cancelled quotes leave other callers running', async () => {
  let release!: () => void, shared: AbortSignal | undefined;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const observedFees: number[] = [];
  const { options, calls } = auroraOptions(raw => {
    const fee = observedFees.length === 0 ? 10 : 2; observedFees.push(fee);
    raw.quoteRequest.appFees = [{ recipient: sender, fee }];
  });
  const fetch: ProviderOptions['fetch'] = async (url, init) => {
    if (url.includes('/tokens/')) { shared = init.signal as AbortSignal; await barrier; }
    return options.fetch(url, init);
  };
  const discovery = createProviderDiscovery({ chains, fetch, clock: () => now, auroraApiKey: options.apiKey });
  const adapters = [2, 10].map(fee => createAuroraAdapter({ ...options, fetch,
    tokenCatalog: signal => discovery.auroraTokens(signal), appFees: [{ recipient: sender, fee }] }));
  const first = new AbortController();
  const abandoned = adapters[0]!.quote({ ...context('aurora'), signal: first.signal });
  const live = adapters[1]!.quote(context('aurora'));
  await Promise.resolve(); first.abort();
  await assert.rejects(abandoned, /CANCELLED/); assert.equal(shared?.aborted, false);
  release(); await live; await adapters[0]!.quote(context('aurora'));
  assert.equal(calls.filter(call => call.url.includes('/tokens/')).length, 1);
  assert.equal(calls.filter(call => call.url.includes('/quote/')).length, 2);
  assert.deepEqual(observedFees, [10, 2]);
});
test('duplicate catalog identities and nonfinite JSON cannot become asset mappings', async () => {
  await assert.rejects(discoverAuroraTokens({ ...fake([tokens[0], tokens[0]]), apiKey: 'private' }, new AbortController().signal), /DUPLICATE/);
  await assert.rejects(discoverRelayChains({ chains, fetch: async () => new Response('{"chains":[],"value":1e400}') }, new AbortController().signal), /INVALID_JSON/);
});
test('Relay seven-day provider expiry cannot extend the reviewed request deadline', async () => {
  const raw = relay(); raw.protocol.v2.orderData.output.deadline = (now + 7 * 86400000) / 1000;
  const quote = await createRelayAdapter(fake(raw)).quote(context());
  assert.equal(quote.expiresAtMs, context().deadlineMs);
  await assert.rejects(createRelayAdapter({ ...fake(raw), relayMaxOrderLifetimeMs: 86400000 }).quote(context()), /EXPIRED/);
  raw.protocol.v2.orderData.output.deadline = 0x100000000;
  await assert.rejects(createRelayAdapter(fake(raw)).quote(context()), /INVALID_DEADLINE/);
  raw.protocol.v2.orderData.output.deadline = now / 1000 - 1;
  await assert.rejects(createRelayAdapter(fake(raw)).quote(context()), /EXPIRED/);
});
test('live Relay catalog omission or null native metadata remains unknown', async () => {
  const rows = [{ chainId: 8453, address: destination.address, decimals: 6, symbol: 'USDC', metadata: { verified: true } }];
  assert.equal((await discoverRelayCurrencies(fake(rows), new AbortController().signal))[0]!.native, null);
  for (const metadata of [null, { isNative: null }]) {
    const row = { ...rows[0], metadata };
    assert.equal((await discoverRelayCurrencies(fake([row]), new AbortController().signal))[0]!.native, null);
  }
  await assert.rejects(discoverRelayCurrencies(fake([{ ...rows[0], metadata: { isNative: 'false' } }]), new AbortController().signal), /INVALID_CATALOG/);
});
test('combined discovery credentials remain provider-scoped; ambiguous legacy key is rejected', async () => {
  const discovery = createProviderDiscovery({ chains, relayApiKey: 'relay-private', auroraApiKey: 'aurora-private',
    fetch: async (url, init) => {
      if (url.includes('relay.link')) {
        assert.equal((init.headers as Record<string, string>)['x-api-key'], 'relay-private'); assert.doesNotMatch(url, /aurora-private/);
        return response({ chains: [{ id: 8453, name: 'base', vmType: 'evm', disabled: false, depositEnabled: true }] });
      }
      assert.match(url, /\/tokens\/aurora-private$/); assert.equal((init.headers as Record<string, string>)['x-api-key'], undefined); return response(tokens);
    } });
  await discovery.relayChains(new AbortController().signal); await discovery.auroraTokens(new AbortController().signal);
  assert.throws(() => createProviderDiscovery({ ...fake(tokens), apiKey: 'ambiguous' }), /EXPLICIT_SCOPE/);
});
test('live signed Relay fee debits count absolute costs while input USD and gas cannot be negative', async () => {
  const raw = relay(); raw.details.currencyIn.amountUsd = '0.128453'; raw.details.swapImpact.percent = '-0.37';
  raw.details.expandedPriceImpact = { execution: { usd: '-0.020107' }, relay: { usd: '-0.000077' }, app: { usd: '0' } };
  raw.fees.gas.amountUsd = '0.000551';
  const quote = await createRelayAdapter(fake(raw)).quote(context());
  assert.equal(quote.feeBps, Number((20735n * 10000n + 128453n - 1n) / 128453n)); assert.equal(quote.priceImpactBps, 37);
  raw.fees.gas.amountUsd = '-0.000551'; await assert.rejects(createRelayAdapter(fake(raw)).quote(context()), /INVALID_DECIMAL/);
  raw.fees.gas.amountUsd = '0.000551'; raw.details.currencyIn.amountUsd = '-0.128453';
  await assert.rejects(createRelayAdapter(fake(raw)).quote(context()), /INVALID_DECIMAL/);
});

function sameChainPreview(solana = false) {
  const ctx = context();
  const id = solana ? 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' : 'eip155:8453';
  const wallet = solana ? '47YyVUMwerrz76mCrpgFP3iDva1Vt4ZxpSuxo6AhwabT' : sender;
  const src: Asset = { chainId: id, address: solana ? '11111111111111111111111111111111' : source.address, decimals: solana ? 9 : 18 };
  const dst: Asset = { chainId: id, address: solana ? 'F6EDRhRzXGmkBabhSHdAnqx26XLhG6NCa83wwuqFpump' : destination.address, decimals: 6 };
  Object.assign(ctx, { sender: wallet, recipient: wallet,
    leg: { ...ctx.leg, kind: 'SWAP', source: src, destination: dst },
    request: { ...ctx.request, source: src, destination: dst, sender: wallet, recipient: wallet } });
  const mapping = { chainId: id, relayChainId: solana ? 792703809 : 8453,
    relayProtocolChainId: solana ? 'solana' : 'base', sourceConfirmationMs: 24000, destinationVerificationMs: 24000 };
  const raw: any = relay(); delete raw.protocol; raw.requestId = 'public-preview-request';
  raw.details.sender = wallet; raw.details.recipient = wallet;
  raw.details.currencyIn.currency = { chainId: mapping.relayChainId, address: src.address, decimals: src.decimals };
  raw.details.currencyOut.currency = { chainId: mapping.relayChainId, address: dst.address, decimals: dst.decimals };
  raw.steps = [{ id: 'swap', kind: 'transaction', items: [{ status: 'incomplete', data: solana ? {
    instructions: [{ programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', data: 'instruction-preview', keys: [
      { pubkey: wallet, isSigner: true, isWritable: true },
      { pubkey: 'So11111111111111111111111111111111111111112', isSigner: false, isWritable: false },
      { pubkey: dst.address, isSigner: false, isWritable: false },
    ] }], addressLookupTableAddresses: [],
  } : { from: wallet, to: recipient, data: '0x1234', value: '1000', chainId: 8453 } }] }];
  const options = { ...fake(raw), chains: [mapping], relaySameChainPreviewTtlMs: 15000 };
  return { ctx, raw, options };
}
test('same-chain self-executed previews require trusted opt-in, bind EVM and Token-2022 assets, and never authorize execution', async () => {
  for (const solana of [false, true]) {
    const { ctx, raw, options } = sameChainPreview(solana);
    await assert.rejects(createRelayAdapter({ ...options, relaySameChainPreviewTtlMs: undefined }).quote(ctx), /INVALID_RESPONSE/);
    const adapter = createRelayAdapter({ ...options, fetch: async (_url, init) => {
      const body = JSON.parse(init.body as string); assert.equal(body.forceSolverExecution, undefined);
      return response(raw);
    } });
    const quote = await adapter.quote(ctx);
    assert.equal(quote.conditional, true); assert.equal(quote.executableRecipeId, undefined);
    assert.equal(quote.pricingValidUntilMs, now + 15000); assert.equal(quote.expiresAtMs, now + 15000);
    assert.equal(quote.estimatedCompletionMs, 36000); assert.equal(quote.verificationMs?.destinationVerificationMs, 0);
    assert.equal(quote.feeBps, 40); assert.equal(quote.priceImpactBps, 15);
    assert.match(quote.quoteId, /^relay:preview:[0-9a-f]{64}$/);
    assert.doesNotMatch(JSON.stringify(quote), /instructions|0x1234|instruction-preview|steps/);
    raw.details.recipient = solana ? '7NrwM2rVpRuxemiGge1dcFKmT2DavRkPRxPEgeAgd6DK' : recipient;
    const otherRecipient = { ...ctx, recipient: raw.details.recipient, request: { ...ctx.request, recipient: raw.details.recipient } };
    assert.notEqual((await adapter.quote(otherRecipient)).quoteId, quote.quoteId);
  }
});
test('same-chain previews reject asset, wallet, input, floor, economics, steps and request-id drift', async () => {
  const mutations = [
    (r: any) => r.details.currencyOut.currency.decimals = 9,
    (r: any) => r.details.currencyIn.currency.chainId = 1,
    (r: any) => r.details.currencyOut.currency.address = sender,
    (r: any) => r.details.sender = recipient,
    (r: any) => r.details.recipient = recipient,
    (r: any) => r.details.currencyIn.amount = '999',
    (r: any) => r.details.currencyOut.minimumAmount = '1900',
    (r: any) => r.details.currencyOut.amount = '1979',
    (r: any) => r.details.swapImpact.percent = 'NaN',
    (r: any) => r.fees.gas.amountUsd = '-1',
    (r: any) => delete r.requestId,
    (r: any) => r.requestId = 'https://untrusted.invalid',
    (r: any) => r.steps = [],
    (r: any) => r.steps[0].kind = 'signature',
    (r: any) => r.steps[0].id = 'deposit',
    (r: any) => r.steps[0].items = [],
    (r: any) => r.steps[0].items[0].data.chainId = 1,
    (r: any) => r.steps[0].items[0].data.from = recipient,
    (r: any) => r.steps[0].items[0].data.value = '999',
    (r: any) => r.steps[0].items[0].data.data = 'unsigned-string',
  ];
  for (const mutate of mutations) {
    const { ctx, raw, options } = sameChainPreview(); mutate(raw);
    await assert.rejects(createRelayAdapter(options).quote(ctx));
  }
  for (const mutate of [(r: any) => r.steps[0].items[0].data.instructions = [],
    (r: any) => r.steps[0].items[0].data.instructions[0].keys[0].pubkey = r.details.currencyOut.currency.address,
    (r: any) => r.steps[0].items[0].data.instructions[0].keys[0].isSigner = false,
    (r: any) => r.steps[0].items[0].data.addressLookupTableAddresses = ['not-a-public-key']]) {
    const { ctx, raw, options } = sameChainPreview(true); mutate(raw);
    await assert.rejects(createRelayAdapter(options).quote(ctx));
  }
});
test('Solana account/lookup-table route variants need no explicit mint keys but keep exact detail binding', async () => {
  const { ctx, raw, options } = sameChainPreview(true);
  raw.steps[0].items[0].data.instructions[0].keys = [
    { pubkey: ctx.sender, isSigner: true, isWritable: true },
    { pubkey: 'Hm9fUgcn7qwDaiNTFiGh6pNtVATgnaRcmK6Bbx6EMZfP', isSigner: false, isWritable: true },
  ];
  raw.steps[0].items[0].data.addressLookupTableAddresses = ['7NrwM2rVpRuxemiGge1dcFKmT2DavRkPRxPEgeAgd6DK'];
  const quote = await createRelayAdapter(options).quote(ctx);
  assert.equal(quote.conditional, true); assert.equal(quote.executableRecipeId, undefined);
  const original = raw.details.currencyOut.currency.address;
  raw.details.currencyOut.currency.address = ctx.sender;
  await assert.rejects(createRelayAdapter(options).quote(ctx), /ASSET_MISMATCH/);
  raw.details.currencyOut.currency.address = original;
  raw.details.currencyOut.currency.decimals = 9;
  await assert.rejects(createRelayAdapter(options).quote(ctx), /ASSET_MISMATCH/);
});
test('preview costs stay unknown when absent, TTL and transport deadlines are bounded, and cancellation fails closed', async () => {
  const { ctx, raw, options } = sameChainPreview(true);
  delete raw.details.expandedPriceImpact; delete raw.details.swapImpact;
  const unknown = await createRelayAdapter(options).quote(ctx);
  assert.equal(unknown.feeBps, null); assert.equal(unknown.priceImpactBps, null);
  for (const ttl of [0, 60001, null, 1.5]) assert.throws(() => createRelayAdapter({ ...options, relaySameChainPreviewTtlMs: ttl as number }));
  const short = await createRelayAdapter(options).quote({ ...ctx, deadlineMs: now + 1000 });
  assert.equal(short.pricingValidUntilMs, now + 1000);
  let time = now;
  await assert.rejects(createRelayAdapter({ ...options, relaySameChainPreviewTtlMs: 1, clock: () => time,
    fetch: async () => { time = now + 2; return response(raw); } }).quote(ctx), /EXPIRED/);
  time = now;
  await assert.rejects(createRelayAdapter({ ...options, clock: () => time,
    fetch: async () => { time = ctx.transportDeadlineMs; return response(raw); } }).quote(ctx), /DEADLINE/);
  const controller = new AbortController();
  await assert.rejects(createRelayAdapter({ ...options, fetch: async () => { controller.abort(); return response(raw); } })
    .quote({ ...ctx, signal: controller.signal }), /CANCELLED/);
});
test('preview opt-in never permits missing cross-chain protocol, malformed present protocol, or non-swap legs', async () => {
  const cross: any = relay(); delete cross.protocol;
  await assert.rejects(createRelayAdapter({ ...fake(cross), relaySameChainPreviewTtlMs: 15000 }).quote(context()), /INVALID_RESPONSE/);
  for (const protocol of [null, {}, { v2: null }, { v2: { orderData: {} } }]) {
    const { ctx, raw, options } = sameChainPreview(); raw.protocol = protocol;
    await assert.rejects(createRelayAdapter(options).quote(ctx), /INVALID_RESPONSE/);
  }
  const { ctx, options } = sameChainPreview();
  await assert.rejects(createRelayAdapter(options).quote({ ...ctx, leg: { ...ctx.leg, kind: 'SWAP_BRIDGE' } }), /INVALID_RESPONSE/);
});
test('fees exceeding the input value remain explicit without clamping costs or accepting invalid economics', async () => {
  const { ctx, raw, options } = sameChainPreview();
  raw.details.currencyIn.amountUsd = '0.01';
  assert.equal((await createRelayAdapter(options).quote(ctx)).feeBps, 400000);
  raw.details.currencyIn.amountUsd = '0';
  await assert.rejects(createRelayAdapter(options).quote(ctx), /PROVIDER_INVALID_ECONOMICS/);
  raw.details.currencyIn.amountUsd = '100';
  raw.fees.gas.amountUsd = '-0.01';
  await assert.rejects(createRelayAdapter(options).quote(ctx), /PROVIDER_INVALID_DECIMAL/);
});
