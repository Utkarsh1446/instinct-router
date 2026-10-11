import { createBaseReadiness } from './base-readiness.mjs';
/** Hosted pricing engine; all request wallets and provider policy are explicit. */
import { randomUUID, createHash } from 'node:crypto';
import * as core from '@instinct/router-core';
import { createMetadataResolver, MetadataError } from './metadata.mjs';
import { SOL, ZERO, SYSTEM, chains as pinnedChains, assets as pinnedAssets, auroraNativeAssetIds, assetClasses } from './registry.mjs';
import { validateQuoteCatalog } from './quote-catalog.mjs';
const assetOnly = ({ chainId, address, decimals }) => ({ chainId, address, decimals });
const execution = { enabled: false, reason: 'Live execution requires a registered canonical wallet-plan recipe and independent receipt verifier. This API currently provides route pricing.' };
const providerNames = { relay: 'Relay', aurora: 'Aurora Intents', debridge: 'deBridge DLN', 'cctp-fast': 'CCTP Fast', 'cctp-standard': 'CCTP Standard', raydium: 'Raydium', 'uniswap-v3': 'Uniswap V3' };
const hashId = value => 'route-' + createHash('sha256').update(value).digest('hex').slice(0, 24);
const safeCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(value) ? value : 'PROVIDER_UNAVAILABLE';

/** The only public candidate projection: no provider orders or wallet payloads. */
function candidateDTO(candidate, eligible) {
  return {
  id: hashId(candidate.id), provider: candidate.legQuotes[0].adapterId, providers: candidate.legQuotes.map(leg => leg.adapterId),
  providerName: candidate.legQuotes.map(leg => providerNames[leg.adapterId]).join(' → '), expectedOutputRaw: candidate.expectedOutputRaw,
  routeKind: candidate.path.kind,
          routingFamily: candidate.legQuotes.some(leg => ['relay', 'aurora', 'debridge'].includes(leg.adapterId)) ? 'AGGREGATOR' : 'INDEPENDENT',
  steps: candidate.legQuotes.map((leg, index) => ({ provider: leg.adapterId, kind: candidate.path.legs[index].kind,
    source: leg.source, destination: leg.destination, amountInRaw: leg.amountInRaw,
    expectedOutputRaw: leg.expectedOutRaw, minimumOutputRaw: leg.minimumOutRaw,
    requiresRequoteAfterSettlement: candidate.path.legs[index].requiresRequoteAfterSettlement,
    conditional: leg.conditional, executionReady: false })),
  minimumOutputRaw: candidate.minimumOutputRaw, feeBps: candidate.feeBps, priceImpactBps: candidate.priceImpactBps,
  estimatedCompletionMs: candidate.completionMs, protocolEstimateMs: candidate.legQuotes[0].protocolEstimateMs ?? null,
  protocolFeeBps: candidate.legQuotes[0].protocolFeeBps ?? null, conditional: candidate.conditional,
  executionReady: false, timingBasis: 'CONFIGURED_ESTIMATE', validationTier: candidate.validationTier,
  quotedAtMs: candidate.quotedAtMs, deadlineMs: candidate.deadlineMs,
  validUntilMs: Math.min(candidate.deadlineMs, ...candidate.legQuotes.map(leg => leg.pricingValidUntilMs ?? leg.expiresAtMs)),
  eligible,
  };
}

export class ServiceError extends Error {
  constructor(code, message = 'Invalid quote request.', status = 400) {
    super(message); this.name = 'ServiceError'; this.code = code; this.status = status;
  }
}
const invalid = (code, message) => { throw new ServiceError(code, message); };
function object(value, allowed, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some(key => !allowed.includes(key))) invalid(code);
  return value;
}
function solAddress(value) {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let decoded = 0n;
  for (const char of value) decoded = decoded * 58n + BigInt(alphabet.indexOf(char));
  let bytes = 0;
  while (decoded > 0n) { bytes++; decoded >>= 8n; }
  return bytes + (value.match(/^1*/)?.[0].length ?? 0) === 32;
}
function address(chainId, value) {
  if (chainId === SOL ? !solAddress(value) : typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) invalid('INVALID_ADDRESS');
  return chainId === SOL ? value : value.toLowerCase();
}
function validateAsset(value, chains = pinnedChains, assets = pinnedAssets) {
  const row = object(value, ['chainId', 'address', 'decimals'], 'INVALID_ASSET');
  if (!chains.some(chain => chain.chainId === row.chainId)) invalid('UNSUPPORTED_CHAIN');
  const normalized = { chainId: row.chainId, address: address(row.chainId, row.address), decimals: row.decimals };
  if (!Number.isInteger(row.decimals) || row.decimals < 0 || row.decimals > 255) invalid('INVALID_DECIMALS');
  const pinned = assets.find(asset => asset.chainId === normalized.chainId && asset.address === normalized.address);
  if (pinned && pinned.decimals !== row.decimals) invalid('CANONICAL_DECIMALS_MISMATCH');
  return { ...normalized, decimalsSource: pinned?.decimalsSource ?? 'USER_PROVIDED', metadataVerified: !!pinned, symbol: pinned?.symbol ?? 'TOKEN', native: pinned?.native ?? false };
}
function decimalAmount(value, decimals) {
  if (typeof value !== 'string' || value.length > 334 || !/^(0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) invalid('INVALID_AMOUNT', 'Amount must be a positive decimal string.');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) invalid('AMOUNT_PRECISION', 'Amount exceeds source token precision.');
  const raw = BigInt(whole + fraction.padEnd(decimals, '0'));
  if (raw <= 0n || raw > (1n << 256n) - 1n) invalid('INVALID_AMOUNT');
  return raw.toString();
}

export function createQuoteService({ providerKeys = {}, fetch: wire = globalThis.fetch, now = Date.now, resolveAsset: injectedResolver, auroraPolicy = {}, chainTiming = {}, independentRoutes = false, debridgeRoutes = false, additionalChains = [], additionalAssets = [] } = {}) {
  const { chains, assets } = validateQuoteCatalog(additionalChains, additionalAssets);
  object(providerKeys, ['RELAY_API_KEY', 'AURORA_API_KEY'], 'INVALID_PROVIDER_CONFIG');
  if (typeof wire !== 'function' || typeof now !== 'function' || typeof independentRoutes !== 'boolean' || typeof debridgeRoutes !== 'boolean' || injectedResolver !== undefined && typeof injectedResolver !== 'function') invalid('INVALID_PROVIDER_CONFIG');
  for (const value of Object.values(providerKeys)) if (typeof value !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(value)) invalid('INVALID_PROVIDER_CONFIG');
  object(auroraPolicy, ['feeRecipient', 'referral', 'tokenFeeBps', 'nativeFeeBps'], 'INVALID_PROVIDER_CONFIG');
  if (auroraPolicy.feeRecipient !== undefined && (typeof auroraPolicy.feeRecipient !== 'string' || !/^[A-Za-z0-9_.:-]{1,256}$/.test(auroraPolicy.feeRecipient))) invalid('INVALID_PROVIDER_CONFIG');
  if (auroraPolicy.referral !== undefined && (typeof auroraPolicy.referral !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(auroraPolicy.referral))) invalid('INVALID_PROVIDER_CONFIG');
  for (const field of ['nativeFeeBps', 'tokenFeeBps']) if (auroraPolicy[field] !== undefined && (!Number.isInteger(auroraPolicy[field]) || auroraPolicy[field] < 1 || auroraPolicy[field] > 500)) invalid('INVALID_PROVIDER_CONFIG');
  object(chainTiming, chains.map(chain => chain.chainId), 'INVALID_TIMING_POLICY');
  const runtimeChains = chains.map(chain => {
    const override = chainTiming[chain.chainId] ?? {};
    object(override, ['sourceConfirmationMs', 'destinationVerificationMs'], 'INVALID_TIMING_POLICY');
    for (const value of Object.values(override)) if (!Number.isSafeInteger(value) || value < 0 || value > 604800000) invalid('INVALID_TIMING_POLICY');
    return { ...chain, ...override };
  });
  const metadata = injectedResolver ?? createMetadataResolver({ fetch: wire, now }).resolveAsset;
  const evmMetadata = new core.MetadataCache(60000, 128, { maxPending: 4, loadTimeoutMs: 6000, clock: now });
  const resolveMetadata = async (body, signal) => {
    if (signal?.aborted) throw new ServiceError('CANCELLED', 'Token lookup was cancelled.', 499);
    const row = object(body, ['chainId', 'address'], 'INVALID_ASSET');
    if (!chains.some(chain => chain.chainId === row.chainId)) invalid('UNSUPPORTED_CHAIN');
    const normalized = { chainId: row.chainId, address: address(row.chainId, row.address) };
    const pinned = assets.find(asset => asset.chainId === normalized.chainId && asset.address === normalized.address);
    if (pinned) return { ...pinned, metadataVerified: true, executionAuthorized: false };
    let result;
    try {
      if (row.chainId === SOL || injectedResolver) result = await metadata(normalized, signal);
      else result = await evmMetadata.get(`${normalized.chainId}:${normalized.address}`, async boundSignal => {
        const chain = chains.find(chain => chain.chainId === normalized.chainId);
        if (chain.relayChainId === undefined) invalid('TOKEN_METADATA_UNSUPPORTED');
        const tokens = await discovery.relayCurrencies(boundSignal, { chainIds: [chain.relayChainId],
          address: normalized.address, useExternalSearch: true, limit: 1 });
        if (!tokens.length) invalid('TOKEN_METADATA_UNSUPPORTED', 'No token metadata is available for this address. Enter verified decimals manually.');
        if (tokens.length !== 1 || tokens[0].asset.chainId !== normalized.chainId || tokens[0].asset.address !== normalized.address)
          throw new ServiceError('TOKEN_METADATA_UNAVAILABLE', 'Token identity could not be verified.', 503);
        return { ...tokens[0].asset, symbol: tokens[0].symbol, native: tokens[0].native === true,
          decimalsSource: 'PROVIDER_CATALOG', metadataVerified: true, metadataValidUntilMs: now() + 60000 };
      }, { signal });
    }
    catch (error) {
      if (signal?.aborted) throw new ServiceError('CANCELLED', 'Token lookup was cancelled.', 499);
      if (error instanceof ServiceError) throw error;
      if (error instanceof MetadataError) throw new ServiceError(error.code, error.message, error.status);
      throw new ServiceError('TOKEN_METADATA_UNAVAILABLE', 'Unable to verify this token. Check the contract address and try again.', 503);
    }
    if (signal?.aborted) throw new ServiceError('CANCELLED', 'Token lookup was cancelled.', 499);
    if (!result || result.chainId !== normalized.chainId || result.address !== normalized.address ||
        !Number.isInteger(result.decimals) || result.decimals < 0 || result.decimals > 255 || result.metadataVerified !== true ||
        (row.chainId === SOL ? result.decimalsSource !== 'FINALIZED_CHAIN' || typeof result.tokenProgram !== 'string' :
          !['PROVIDER_CATALOG', 'FINALIZED_CHAIN'].includes(result.decimalsSource)) ||
        result.metadataValidUntilMs !== undefined && result.metadataValidUntilMs <= now())
      throw new ServiceError('TOKEN_METADATA_UNAVAILABLE', 'Unable to verify this token.', 503);
    return { ...normalized, decimals: result.decimals, metadataVerified: true, decimalsSource: result.decimalsSource,
      ...(row.chainId === SOL ? { tokenProgram: result.tokenProgram } : {}), executionAuthorized: false,
      symbol: typeof result.symbol === 'string' ? result.symbol.slice(0, 64) : 'TOKEN',
      name: typeof result.name === 'string' ? result.name.slice(0, 128) : 'Custom token', native: false };
  };
  const baseReadiness = independentRoutes ? createBaseReadiness({ fetch: wire, now }) : null;
  const scheduler = new core.QuoteScheduler();
  const timingHistory = new core.TimingHistory();
  const timingRows = new Map();
  const providerOptions = { chains: runtimeChains, fetch: wire, clock: now };
  const discovery = core.createProviderDiscovery({ ...providerOptions, ...(providerKeys.AURORA_API_KEY ? { auroraApiKey: providerKeys.AURORA_API_KEY } : {}),
    ...(providerKeys.RELAY_API_KEY ? { relayApiKey: providerKeys.RELAY_API_KEY } : {}) });
  const relay = core.createRelayAdapter({ ...providerOptions, apiKey: providerKeys.RELAY_API_KEY, relaySameChainPreviewTtlMs: 15000 });
  const nativePins = [
    { asset: assetOnly(assets[0]), assetId: auroraNativeAssetIds.base, native: true },
    { asset: assetOnly(assets[1]), assetId: auroraNativeAssetIds.solana, native: true },
  ];
  const auroras = providerKeys.AURORA_API_KEY ? [auroraPolicy.tokenFeeBps ?? 2, auroraPolicy.nativeFeeBps ?? 10].map(fee => core.createAuroraAdapter({
    ...providerOptions, apiKey: providerKeys.AURORA_API_KEY, assets: nativePins, dryRun: true, previewTtlMs: 60000,
    tokenCatalog: signal => discovery.auroraTokens(signal),
    appFees: auroraPolicy.feeRecipient ? [{ recipient: auroraPolicy.feeRecipient, fee }] : [], referral: auroraPolicy.referral,
  })) : [];
  const cctpAssets = [{ asset: assetOnly(assets[2]), domain: 6 }, { asset: assetOnly(assets[3]), domain: 5 }];
  const cctpDiscovery = core.createCctpDiscovery({ fetch: wire, clock: now });
  const cctp = (mode, attestationMs, sourceId) => core.createCctpAdapter({ mode, assets: cctpAssets, fetch: wire, clock: now, attestationMs, discovery: cctpDiscovery,
    verificationMs: { sourceConfirmationMs: runtimeChains.find(chain => chain.chainId === sourceId).sourceConfirmationMs,
      destinationVerificationMs: runtimeChains.find(chain => chain.chainId === (sourceId === SOL ? chains[0].chainId : SOL)).destinationVerificationMs } });
  const fastSol = cctp('FAST', 8000, SOL), fastBase = cctp('FAST', 8000, chains[0].chainId);
  const fast = { id: 'cctp-fast', quote: ctx => (ctx.leg.source.chainId === SOL ? fastSol : fastBase).quote(ctx) };
  const standardSol = cctp('STANDARD', 25000, SOL), standardBase = cctp('STANDARD', 1140000, chains[0].chainId);
  const standard = { id: 'cctp-standard', quote: ctx => (ctx.leg.source.chainId === SOL ? standardSol : standardBase).quote(ctx) };
  const dexes = independentRoutes ? [
    core.createRaydiumAdapter({ fetch: wire, clock: now, estimatedCompletionMs: Math.max(1, runtimeChains[1].destinationVerificationMs) }),
    core.createUniswapV3Adapter({ fetch: wire, clock: now, estimatedCompletionMs: Math.max(1, runtimeChains[0].destinationVerificationMs) }),
  ] : [];
  const debridge = debridgeRoutes ? core.createDeBridgeAdapter({ fetch: wire, clock: now,
    chains: chains.map(chain => ({ chainId: chain.chainId, debridgeChainId: chain.chainId === SOL ? 7565164 : Number(chain.chainId.slice(7)) })) }) : null;
  const measure = async (adapter, ctx, phase, operation) => {
    const started = performance.now(); let outcome = 'SUCCESS';
    try { return await operation(); }
    catch (error) { outcome = safeCode(error?.code); throw error; }
    finally { timingRows.get(ctx.request.requestId)?.push({ provider: adapter.id, providerName: providerNames[adapter.id], phase, rttMs: Math.round(performance.now() - started), outcome }); }
  };
  const measured = adapter => ({ id: adapter.id,
    quote: ctx => measure(adapter, ctx, 'QUOTE', () => adapter.quote(ctx)),
    ...(adapter.prepare ? { async prepare(ctx) {
      const prepared = await measure(adapter, ctx, 'PREPARATION', () => adapter.prepare(ctx));
      return Object.freeze({ quote: actual => measure(adapter, actual, 'QUOTE', () => prepared.quote(actual)) });
    } } : {}),
  });
  const runtime = (aurora, ownRoutesOnly = false) => new core.RouterRuntime([...(ownRoutesOnly ? [] : [relay, ...(aurora ? [aurora] : []), ...(debridge ? [debridge] : [])]), fast, standard, ...dexes].map(adapter => ({
    adapter: measured(adapter), queryChains: adapter.id === 'raydium' ? [SOL] : adapter.id === 'uniswap-v3' ? [chains[0].chainId] : chains.map(chain => chain.chainId),
    kinds: adapter.id.startsWith('cctp-') ? ['BRIDGE'] : adapter.id === 'debridge' ? ['SWAP_BRIDGE'] : dexes.includes(adapter) ? ['SWAP'] : ['SWAP', 'SWAP_BRIDGE'],
    directOnly: ['relay', 'aurora', 'debridge'].includes(adapter.id),
    ...(adapter.id.startsWith('cctp-') ? { exactAssets: cctpAssets.map(row => row.asset) } : {}),
  })), { quoteBudgetMs: 4000, providerTimeoutMs: 3500, scheduler, timingHistory,
    intermediates: independentRoutes ? cctpAssets.map(row => row.asset) : [] });
  const ordinaryRuntime = runtime(auroras[0]);
  const nativeRuntime = auroras.length ? runtime(auroras[1]) : ordinaryRuntime;
  const independentRuntime = independentRoutes ? runtime(undefined, true) : null;
  return {
    config() {
      return structuredClone({ version: 1, apiVersion: '1', assetClasses, readOnly: true, capabilities: { pricing: true, walletExecution: false, providerDiscoveryIsAuthorization: false, independentRoutes, debridgeRoutes, executionInspection: independentRoutes }, chains: runtimeChains.map(({ id, name, chainId, sourceConfirmationMs, destinationVerificationMs }) => ({ id, name, chainId, sourceConfirmationMs: sourceConfirmationMs ?? null, destinationVerificationMs: destinationVerificationMs ?? null, timingBasis: sourceConfirmationMs === undefined || destinationVerificationMs === undefined ? 'UNKNOWN' : 'CONFIGURED_UNMEASURED_POLICY' })), assets,
        defaults: { source: assetOnly(assets[0]), destination: assetOnly(assets[1]), sourceAssetId: assets[0].id,
          destinationAssetId: assets[1].id, amount: '0.00005', slippageBps: 50, objective: 'BALANCED', maxFeeBps: 500, maxPriceImpactBps: 500 },
        providers: Object.entries(providerNames).filter(([id]) => (independentRoutes || !['raydium', 'uniswap-v3'].includes(id)) && (debridgeRoutes || id !== 'debridge')).map(([id, name]) => ({ id, name,
          available: id !== 'aurora' || !!providerKeys.AURORA_API_KEY,
          enabled: id !== 'aurora' || !!providerKeys.AURORA_API_KEY,
          quoteMode: id === 'aurora' ? 'DRY_PREVIEW' : id.startsWith('cctp') ? 'PROTOCOL_PRICING' : ['raydium', 'uniswap-v3'].includes(id) ? 'DEX_PREVIEW' : 'PROVIDER_QUOTE',
          fullCostVerification: id === 'relay' ? 'PROVIDER_FIELDS_REQUIRED' : 'NOT_CONFIGURED',
          chainIds: id === 'raydium' ? [SOL] : id === 'uniswap-v3' ? [chains[0].chainId] : id.startsWith('cctp') ? [chains[0].chainId, SOL] : chains.map(chain => chain.chainId),
          exactAssets: id.startsWith('cctp') ? cctpAssets.map(item => item.asset) : undefined,
          nativeAssetPins: id === 'aurora' ? nativePins.map(item => item.asset) : undefined,
          reason: id === 'aurora' && !providerKeys.AURORA_API_KEY ? 'Aurora quotes are unavailable until its provider key is configured.' :
            id === 'relay' && !providerKeys.RELAY_API_KEY ? 'Relay requests use public rate limits until a provider key is configured.' :
            id === 'debridge' ? 'Public development pricing only. Full costs and signed output protection are unverified; commercial use requires a provider key integration.' : null })),
        execution, maxSlippageBps: 500, maxQuoteFeeBps: 10000, maxQuotePriceImpactBps: 10000,
        timingBasis: 'MEASURED_QUOTE_RTT; COMPLETION_TIMES_ARE_CONFIGURED_ESTIMATES',
        unknownTokenPolicy: 'Solana decimals are verified on chain; EVM CA lookup uses provider catalog metadata. Manual EVM decimals remain unverified. Token discovery does not authorize execution.' });
    },
    resolveAsset: resolveMetadata,
    async inspectExecution(body, signal) {
      if (!baseReadiness) throw new ServiceError('INSPECTION_UNAVAILABLE', 'Execution inspection is not enabled.', 503);
      const started = performance.now();
      const row = object(body, ['source', 'destination', 'amount', 'sender', 'recipient', 'slippageBps'], 'INVALID_REQUEST');
      const source = assetOnly(validateAsset(row.source, chains, assets)), destination = assetOnly(validateAsset(row.destination, chains, assets));
      if (!core.sameAsset(source, assetOnly(assets[0])) || !core.sameAsset(destination, assetOnly(assets[2])))
        throw new ServiceError('INSPECTION_PAIR_UNSUPPORTED', 'Execution inspection currently supports Base ETH to Base USDC.', 422);
      const sender = address(source.chainId, row.sender), recipient = address(destination.chainId, row.recipient);
      if (sender === ZERO || recipient === ZERO) invalid('INVALID_WALLET');
      const amountRaw = decimalAmount(row.amount, source.decimals), slippageBps = Object.hasOwn(row, 'slippageBps') ? row.slippageBps : 50;
      if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 500) invalid('INVALID_SLIPPAGE');
      if (signal?.aborted) throw new ServiceError('CANCELLED', 'Inspection was cancelled.', 499);
      let result;
      try { result = await baseReadiness.inspect({ source, destination, amountRaw, sender, recipient, slippageBps }, signal); }
      catch (error) {
        if (signal?.aborted) throw new ServiceError('CANCELLED', 'Inspection was cancelled.', 499);
        const code = /^[A-Z][A-Z0-9_]{0,95}$/.test(error?.code ?? '') ? error.code : 'INSPECTION_UNAVAILABLE';
        throw new ServiceError(code, 'The wallet readiness check could not complete.', 503);
      }
      if (signal?.aborted) throw new ServiceError('CANCELLED', 'Inspection was cancelled.', 499);
      // A public read-only report does not expose locally prepared calldata or a wallet action.
      return { status: result.status, readOnly: true, executionReady: false, requiresWalletSignature: true,
        request: { source, destination, amount: row.amount, sender, recipient, slippageBps }, amountRaw,
        checkedAtMs: result.checkedAtMs, validUntilMs: result.validUntilMs,
        quote: result.quote ?? null, fees: result.fees ?? null, evidence: result.evidence ?? null,
        transactionPrepared: !!result.transaction, blockers: result.blockers,
        inspectionRttMs: Math.round(performance.now() - started), execution: { ...execution } };
    },
    async quote(body, signal, onCandidate) {
      if (onCandidate !== undefined && typeof onCandidate !== 'function') invalid('INVALID_CALLBACK');
      const serviceStarted = performance.now();
      const row = object(body, ['source', 'destination', 'amount', 'slippageBps', 'objective', 'maxOutputShortfallBps', 'sender', 'recipient', 'maxFeeBps', 'maxPriceImpactBps', 'routeScope'], 'INVALID_REQUEST');
      const routeScope = Object.hasOwn(row, 'routeScope') ? row.routeScope : 'ALL';
      if (!['ALL', 'INDEPENDENT'].includes(routeScope)) invalid('INVALID_ROUTE_SCOPE');
      if (routeScope === 'INDEPENDENT' && !independentRuntime) throw new ServiceError('INDEPENDENT_ROUTES_UNAVAILABLE', 'Independent DEX routes are not enabled on this server.', 503);
      let source = validateAsset(row.source, chains, assets), destination = validateAsset(row.destination, chains, assets);
      if (core.sameAsset(assetOnly(source), assetOnly(destination))) invalid('IDENTICAL_ASSETS', 'Choose a different destination token. The same token on the same chain does not need a swap.');
      const slippageBps = Object.hasOwn(row, 'slippageBps') ? row.slippageBps : 50;
      const objective = Object.hasOwn(row, 'objective') ? row.objective : 'BALANCED';
      if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 500) invalid('INVALID_SLIPPAGE');
      if (!['BALANCED', 'FASTEST', 'BEST_OUTPUT'].includes(objective)) invalid('INVALID_OBJECTIVE');
      const maxOutputShortfallBps = Object.hasOwn(row, 'maxOutputShortfallBps') ? row.maxOutputShortfallBps : (objective === 'BEST_OUTPUT' ? 0 : 50);
      if (!Number.isInteger(maxOutputShortfallBps) || maxOutputShortfallBps < 0 || maxOutputShortfallBps > 500 ||
          objective === 'BEST_OUTPUT' && maxOutputShortfallBps !== 0) invalid('INVALID_OUTPUT_BAND');
      const maxFeeBps = Object.hasOwn(row, 'maxFeeBps') ? row.maxFeeBps : 500;
      const maxPriceImpactBps = Object.hasOwn(row, 'maxPriceImpactBps') ? row.maxPriceImpactBps : 500;
      if (maxFeeBps !== null && (!Number.isInteger(maxFeeBps) || maxFeeBps < 0 || maxFeeBps > 10000)) invalid('INVALID_FEE_LIMIT');
      if (!Number.isInteger(maxPriceImpactBps) || maxPriceImpactBps < 0 || maxPriceImpactBps > 10000) invalid('INVALID_PRICE_IMPACT_LIMIT');
      if (signal?.aborted) throw new ServiceError('CANCELLED', 'Quote request was cancelled.', 499);
      if (!Object.hasOwn(row, 'sender') || !Object.hasOwn(row, 'recipient')) invalid('WALLETS_REQUIRED', 'Provide the source sender and destination recipient wallet addresses.');
      const sender = address(source.chainId, row.sender);
      const recipient = address(destination.chainId, row.recipient);
      if (sender === ZERO || sender === SYSTEM || recipient === ZERO || recipient === SYSTEM) invalid('INVALID_WALLET');
      const enrich = async asset => {
        if (asset.chainId !== SOL || asset.metadataVerified) return asset;
        const verified = await resolveMetadata({ chainId: asset.chainId, address: asset.address }, signal);
        if (verified.decimals !== asset.decimals) invalid('TOKEN_DECIMALS_MISMATCH', `This token uses ${verified.decimals} decimals. Update the token decimals and request another quote.`);
        return verified;
      };
      [source, destination] = await Promise.all([enrich(source), enrich(destination)]);
      const amountRaw = decimalAmount(row.amount, source.decimals);
      const requestId = `preview-${randomUUID()}`;
      const request = { requestId, source: assetOnly(source), destination: assetOnly(destination), amountRaw, sender, recipient, slippageBps,
        maxFeeBps, maxPriceImpactBps, maxCompletionMs: 1800000, deadlineMs: now() + 2400000,
        optimization: { objective, maxOutputShortfallBps } };
      const timings = []; timingRows.set(requestId, timings);
      try {
        const result = await (routeScope === 'INDEPENDENT' ? independentRuntime : source.native || destination.native ? nativeRuntime : ordinaryRuntime).quote(request, { signal, ...(onCandidate ? { onCandidate(candidate) {
          if (signal?.aborted) return;
          const ranked = core.rankCandidates(request, [candidate], { nowMs: now() });
          onCandidate(candidateDTO(candidate, ranked.eligible.some(eligible => eligible.id === candidate.id)));
        } } : {}) });
        if (signal?.aborted) throw new ServiceError('CANCELLED', 'Quote request was cancelled.', 499);
        const providerDetails = legs => {
          const providers = (legs ?? []).map(leg => leg.adapterId).filter(id => Object.hasOwn(providerNames, id));
          return { providers, ...(providers[0] ? { provider: providers[0], providerName: providerNames[providers[0]] } : {}) };
        };
        // Re-check clocks and every bound route at the public projection boundary.
        const ranked = core.rankCandidates(request, result.candidates, { nowMs: now() });
        const candidates = result.candidates.map(candidate => candidateDTO(candidate,
          ranked.eligible.some(eligible => eligible.id === candidate.id)));
        const winner = ranked.winner ? hashId(ranked.winner.id) : null;
        // A diagnostic preview never shortens the selected route's pricing validity.
        // Without a winner, this is only the last remaining preview cutoff, not execution authority.
        const validUntilMs = winner ? candidates.find(candidate => candidate.id === winner).validUntilMs :
          candidates.length ? Math.max(...candidates.map(candidate => candidate.validUntilMs)) : null;
        return { requestId, quoteRttMs: result.quoteRttMs, serviceRttMs: Math.round(performance.now() - serviceStarted), comparisonComplete: result.comparisonComplete,
          winner, candidates,
          quotedAtMs: Math.max(0, ...candidates.map(candidate => candidate.quotedAtMs)) || now(),
          validUntilMs,
          excluded: ranked.excluded.map(item => ({ id: hashId(item.id), reasons: item.reasons.map(safeCode),
            ...providerDetails(result.candidates.find(candidate => candidate.id === item.id)?.path.legs) })),
          failures: result.failures.map(item => ({ id: hashId(item.pathId), code: safeCode(item.code),
            ...providerDetails(result.planning.paths.find(path => path.id === item.pathId)?.legs) })),
          providerTimings: timings.sort((a, b) => a.provider.localeCompare(b.provider)), source, destination, amount: row.amount, amountRaw,
          objective, slippageBps, maxOutputShortfallBps, maxFeeBps, maxPriceImpactBps, routeScope,
          wallets: { sender, recipient, senderBasis: 'USER_PROVIDED', recipientBasis: 'USER_PROVIDED' }, execution: { ...execution }, readOnly: true,
          timingBasis: 'MEASURED_QUOTE_RTT; COMPLETION_TIMES_ARE_CONFIGURED_ESTIMATES',
          costBasis: 'Provider-validated full costs only. Missing full costs remain unknown and are excluded from ranking.' };
      } catch (error) {
        if (error instanceof ServiceError) throw error;
        throw new ServiceError('QUOTE_UNAVAILABLE', 'The quote comparison could not complete.', 503);
      } finally { timingRows.delete(requestId); }
    },
  };
}
