/** Registered wallet recipes only. This engine never signs or broadcasts. */
import { randomUUID } from 'node:crypto';
import { BASE_V3, validateRequest, reviewHash, rankCandidates } from '@instinct/router-core';
import { createBaseReadiness, baseExecutionPrimitives as p } from './base-readiness.mjs';
import { createBaseExecutionChecks, ExecutionEngineError, fail, enforceEconomicLimits } from './base-execution-checks.mjs';
import { createBaseReceiptVerifier } from './base-execution-receipts.mjs';
import { createBaseExecutionTransport, TRANSIENT_READ_CODES } from './base-execution-transport.mjs';
import { createRelayBaseSolExecution, RELAY_RECIPE, RELAY_USDC_RECIPE, RELAY_DIRECT_RECIPE, SOLANA_USDC } from './relay-base-sol-execution.mjs';
import { createRelayDestinationVerifier } from './relay-destination.mjs';
import { solanaBytes } from './relay-order.mjs';
import { createRelaySolanaExecution, RELAY_SOLANA_RECIPE } from './relay-solana-execution.mjs';
import { createRelayBaseDestinationVerifier } from './relay-base-destination.mjs';
import { executionHash } from '@instinct/router-core';
import { createRelayProviderExecution, RELAY_PROVIDER_RECIPE } from './relay-provider-execution.mjs';
import { createRelayProviderReceiptVerifier } from './relay-provider-receipts.mjs';
import { validateProviderExecutionChains } from './relay-provider-catalog.mjs';
import { createRelayProviderSolanaClaimRecovery } from './relay-provider-solana-claim-recovery.mjs';
const RECIPE = 'base-native-uniswap-v1';
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const bigint = value => {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,77}$/.test(value) || BigInt(value) >= 1n << 256n) fail('INVALID_EXECUTION_INPUT');
  return BigInt(value);
};
const ceil = (n, d) => (n + d - 1n) / d;
function requestFor(input, started, relayEnabled = false, solanaEnabled = false, providerChains = []) {
  const fields = ['source', 'destination', 'amount', 'sender', 'recipient', 'slippageBps', 'objective',
    'maxOutputShortfallBps', 'maxFeeBps', 'maxPriceImpactBps', 'routeScope', 'nativeFeeBudgets'];
  if (!plain(input) || Object.keys(input).some(key => !fields.includes(key)) || !Array.isArray(input.nativeFeeBudgets) ||
    !input.nativeFeeBudgets.length || typeof input.amount !== 'string' || !/^(?:0|[1-9][0-9]{0,76})(?:\.[0-9]{1,77})?$/.test(input.amount))
    fail('INVALID_EXECUTION_INPUT');
  if (!plain(input.source) || !plain(input.destination) || typeof input.source.address !== 'string' ||
    typeof input.destination.address !== 'string' || input.routeScope !== undefined && !['ALL', 'INDEPENDENT'].includes(input.routeScope))
    fail('INVALID_EXECUTION_INPUT');
  const nativeSource = input.source.address.toLowerCase() === BASE_V3.native && input.source.decimals === 18;
  const baseSwap = input.source.chainId === BASE_V3.chainId && nativeSource && input.destination.chainId === BASE_V3.chainId &&
    input.destination.address.toLowerCase() === BASE_V3.usdc && input.destination.decimals === 6;
  const relayRoute = relayEnabled && input.routeScope !== 'INDEPENDENT' && input.source.chainId === BASE_V3.chainId &&
    input.destination.chainId === SOLANA_USDC.chainId;
  const solanaRoute = solanaEnabled && input.routeScope !== 'INDEPENDENT' && input.source.chainId === SOLANA_USDC.chainId &&
    input.destination.chainId === BASE_V3.chainId && input.destination.address.toLowerCase() === BASE_V3.native && input.destination.decimals === 18;
  const providerRoute = input.routeScope !== 'INDEPENDENT' && providerChains.includes(input.source.chainId) && providerChains.includes(input.destination.chainId);
  if (!baseSwap && !relayRoute && !solanaRoute && !providerRoute) throw new ExecutionEngineError('EXECUTION_ADAPTER_UNAVAILABLE', 501);
  const decimals = input.source.decimals;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) fail('INVALID_EXECUTION_INPUT');
  const [whole, fractional = ''] = input.amount.split('.');
  if (fractional.length > decimals) fail('INVALID_EXECUTION_INPUT');
  const amountRaw = (BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fractional.padEnd(decimals, '0'))).toString();
  bigint(amountRaw);
  const objective = input.objective ?? 'BALANCED';
  return validateRequest({ requestId: randomUUID(), source: input.source, destination: input.destination, amountRaw,
    sender: input.sender, recipient: input.recipient, slippageBps: input.slippageBps ?? 50,
    maxFeeBps: input.maxFeeBps === null ? null : input.maxFeeBps ?? 100, maxPriceImpactBps: input.maxPriceImpactBps ?? 500,
    maxCompletionMs: 90000, deadlineMs: started + 90000,
    optimization: { objective, maxOutputShortfallBps: input.maxOutputShortfallBps ?? (objective === 'BEST_OUTPUT' ? 0 : 50) },
    nativeFeeBudgets: input.nativeFeeBudgets }, started);
}
export function createExecutionEngine({ fetch: wire = globalThis.fetch, now = Date.now, executionPins = {}, rpcEndpoints, providerKeys = {}, providerExecutionChains = [] } = {}) {
  if (typeof wire !== 'function' || typeof now !== 'function') fail('INVALID_EXECUTION_CONFIG');
  executionPins = structuredClone(executionPins);
  if (rpcEndpoints !== undefined && (!plain(rpcEndpoints) || Object.keys(rpcEndpoints).some(key => !['base','solana'].includes(key)))) fail('INVALID_EXECUTION_CONFIG');
  if (!plain(providerKeys) || Object.keys(providerKeys).some(key => !['RELAY_API_KEY','AURORA_API_KEY'].includes(key))) fail('INVALID_EXECUTION_CONFIG');
  if (executionPins.providerManaged !== undefined && (!plain(executionPins.providerManaged) || Object.keys(executionPins.providerManaged).some(k => k !== 'enabled') || typeof executionPins.providerManaged.enabled !== 'boolean')) fail('INVALID_EXECUTION_CONFIG');
  const providerChains = executionPins.providerManaged?.enabled === true ? validateProviderExecutionChains(providerExecutionChains) : [];
  const providerChainIds = providerChains.map(chain => chain.chainId);
  // Recovery needs retained address history. The public quote/simulation RPC can
  // omit that history, so use Solana's pinned mainnet endpoint for this check.
  const providerClaimRecovery = createRelayProviderSolanaClaimRecovery({fetch:wire,now,
    chains:providerChains.filter(chain=>chain.vm==='SOLANA').map(chain=>({...chain,rpcUrl:'https://api.mainnet-beta.solana.com'}))});
  const providerRelay = providerChains.length ? createRelayProviderExecution({fetch:wire,now,chains:providerChains,apiKey:providerKeys.RELAY_API_KEY,
    receiptVerifier:createRelayProviderReceiptVerifier({fetch:wire,now,chains:providerChains,apiKey:providerKeys.RELAY_API_KEY})}) : null;
  const providerAction = action => action?.payload?.type === 'PROVIDER_REVIEWED_TRANSACTION';
  const solanaEndpoints = rpcEndpoints?.solana ?? ['https://api.mainnet-beta.solana.com'];
  if (!Array.isArray(solanaEndpoints) || solanaEndpoints.length !== 1) fail('INVALID_EXECUTION_CONFIG');
  let destinationVerifier;
  if (executionPins.relay) {
    const signers = executionPins.relay.solanaSolverSigners;
    if (!Array.isArray(signers) || !signers.length || signers.length > 16 || new Set(signers).size !== signers.length) fail('EXECUTION_PINS_REQUIRED');
    for (const signer of signers) if (solanaBytes(signer) === '0x'+'00'.repeat(32)) fail('EXECUTION_PINS_REQUIRED');
    destinationVerifier = createRelayDestinationVerifier({fetch:wire,now,rpcEndpoint:solanaEndpoints[0],pins:executionPins.relay});
  }
  const transport = createBaseExecutionTransport(wire, rpcEndpoints?.base), issued = new Map();
  const bundles = transport.transports.map(fetch => {
    const checks = createBaseExecutionChecks({ fetch, now, pins: executionPins.base });
    const relay = destinationVerifier ? createRelayBaseSolExecution({ fetch: (url,init) => url === BASE_V3.rpc ? fetch(url,init) : wire(url,init), now, pins: executionPins.relay, basePins: executionPins.base, destinationVerifier, apiKey:providerKeys.RELAY_API_KEY }) : null;
    if (relay) { checks.validatePins(); relay.validatePins(); }
    return { checks, receipts: createBaseReceiptVerifier(checks, { now }), relay };
  });
  const checks = bundles[0].checks;
  const solanaRelay = executionPins.solanaRelay ? createRelaySolanaExecution({fetch:wire,now,pins:executionPins.solanaRelay,
    rpcEndpoint:solanaEndpoints[0],apiKey:providerKeys.RELAY_API_KEY,
    destinationVerifier:createRelayBaseDestinationVerifier({fetch:wire,now,rpcEndpoints:rpcEndpoints?.base})}) : null;
  if (solanaRelay) solanaRelay.validatePins();
  const relayAction = action => ['relay-native-deposit','relay-usdc-approve','relay-usdc-deposit','relay-token-approve','relay-token-deposit'].includes(action.id);
  const verifyIssued = async (request, candidate) => {
    const saved = issued.get(candidate.id);
    if (!saved || saved.until <= now() || saved.digest !== await reviewHash({ request, candidate })) fail('EXECUTION_RECIPE_BINDING_MISMATCH');
    if (issued.get(candidate.id) !== saved) fail('EXECUTION_RECIPE_BINDING_MISMATCH');
    issued.delete(candidate.id); return structuredClone(saved.plan);
  };
  const recipes = Object.freeze([Object.freeze({id:RECIPE,maxReviewLifetimeMs:90000,verify:verifyIssued}),
    ...(destinationVerifier ? [Object.freeze({id:RELAY_RECIPE,maxReviewLifetimeMs:60000,verify:verifyIssued}),Object.freeze({id:RELAY_USDC_RECIPE,maxReviewLifetimeMs:90000,verify:verifyIssued}),Object.freeze({id:RELAY_DIRECT_RECIPE,maxReviewLifetimeMs:90000,verify:verifyIssued})] : []),
    ...(solanaRelay ? [Object.freeze({id:RELAY_SOLANA_RECIPE,maxReviewLifetimeMs:60000,verify:verifyIssued})] : []),
    ...(providerRelay ? [Object.freeze({id:RELAY_PROVIDER_RECIPE,maxReviewLifetimeMs:90000,verify:verifyIssued})] : [])]);
  const verifier = Object.freeze({
    isValidTransactionHash: (chainId, hash) => (chainId === BASE_V3.chainId || !!solanaRelay && chainId === SOLANA_USDC.chainId || providerChainIds.includes(chainId)) && executionHash(chainId,hash,'transaction'),
    recoverUnsubmitted: (input, signal) => providerClaimRecovery.release(input,signal),
    async preflight(plan, action, signal) {
      plan = structuredClone(plan); action = structuredClone(action);
      if (providerAction(action)) { if (!providerRelay) fail('EXECUTION_ADAPTER_UNAVAILABLE'); return providerRelay.preflight(plan,action,signal); }
      if (action.chainId === SOLANA_USDC.chainId) { if (!solanaRelay) fail('EXECUTION_ADAPTER_UNAVAILABLE'); return solanaRelay.preflight(plan,action,signal); }
      return transport.run((i, inner) => relayAction(action) && bundles[i].relay ? bundles[i].relay.preflight(plan,action,inner) : bundles[i].checks.preflight(plan, action, inner), signal);
    },
    async release({ record }, signal) {
      record = structuredClone(record);
      if (record.plan?.providerRoute) { if (!providerRelay) fail('EXECUTION_ADAPTER_UNAVAILABLE'); return providerRelay.release({record},signal); }
      return transport.run((i, inner) => bundles[i].relay ? bundles[i].relay.release({ record }, inner) : Promise.resolve({ready:false}), signal);
    },
    async confirm(plan, action, hash, signal) {
      plan = structuredClone(plan); action = structuredClone(action);
      if (providerAction(action)) { if (!providerRelay) fail('EXECUTION_ADAPTER_UNAVAILABLE'); return providerRelay.confirm(plan,action,hash,signal); }
      if (action.chainId === SOLANA_USDC.chainId) { if (!solanaRelay) fail('EXECUTION_ADAPTER_UNAVAILABLE'); return solanaRelay.confirm(plan,action,hash,signal); }
      return transport.run((i, inner) => relayAction(action) && bundles[i].relay ? bundles[i].relay.confirm(plan,action,hash,inner) : bundles[i].receipts.confirm(plan, action, hash, inner), signal);
    },
  });
  async function registerRelay(request,prepared,recipeId,signal) {
    const {plan} = prepared;
        const leg = {index:0,capabilityId:recipeId,adapterId:'relay',kind:'SWAP_BRIDGE',source:request.source,destination:request.destination,
          validationTier:'EXECUTION_VALIDATED',executionTier:'WALLET_SIGNED',quoteProbe:false,amountSource:'REQUEST_AMOUNT',requiresRequoteAfterSettlement:false};
        const quote = {capabilityId:recipeId,adapterId:'relay',source:request.source,destination:request.destination,amountInRaw:request.amountRaw,
          expectedOutRaw:prepared.expectedOutRaw,minimumOutRaw:plan.minimumOutRaw,feeBps:prepared.feeBps,priceImpactBps:prepared.priceImpactBps,
          estimatedCompletionMs:prepared.estimatedCompletionMs,expiresAtMs:prepared.pricingValidUntilMs,pricingValidUntilMs:prepared.pricingValidUntilMs,
          quoteId:prepared.quoteId,executableRecipeId:recipeId,conditional:false,liquidityConfirmed:true,nativeCosts:plan.nativeCosts,
          costDenominator:{source:request.source,amountRaw:request.amountRaw}};
        const candidate = {id:plan.routeId,requestId:request.requestId,path:{id:plan.routeId,kind:'DIRECT',source:request.source,destination:request.destination,
          legs:[leg],quoteBasis:'FIRM_FIRST_LEG',quoteProbe:false,executionReady:false},legQuotes:[quote],source:request.source,destination:request.destination,
          inputAmountRaw:request.amountRaw,expectedOutputRaw:quote.expectedOutRaw,minimumOutputRaw:quote.minimumOutRaw,feeBps:quote.feeBps,priceImpactBps:quote.priceImpactBps,
          completionMs:quote.estimatedCompletionMs,deadlineMs:quote.expiresAtMs,quotedAtMs:now(),conditional:false,validationTier:'EXECUTION_VALIDATED',executionReady:true};
        if (rankCandidates(request,[candidate],{nowMs:now(),requireExecutable:true}).winner===null) fail('EXECUTION_QUOTE_EXPIRED');
        if (signal.aborted) fail('EXECUTION_CANCELLED'); if (issued.size>=128) fail('EXECUTION_BUSY');
        issued.set(candidate.id,{until:Math.min(plan.expiresAtMs,quote.pricingValidUntilMs),digest:await reviewHash({request,candidate}),plan:structuredClone(plan)});
        return {request:structuredClone(request),candidate:structuredClone(candidate)};
  }
  return { recipes, verifier,
    capabilities() {
      let valid = true; try { checks.validatePins(); } catch { valid = false; }
      return { walletExecution: valid || !!providerRelay, signing: 'USER_WALLET_ONLY', broadcastsTransactions: false,
        supportedRoutes: valid ? [{ recipeId: RECIPE, source: { chainId: BASE_V3.chainId, address: BASE_V3.native, decimals: 18 },
          destination: { chainId: BASE_V3.chainId, address: BASE_V3.usdc, decimals: 6 }, walletActions: 1,
          confirmationPolicy: 'TWELVE_CANONICAL_BASE_CONFIRMATIONS_AND_EXACT_RECIPIENT_CREDIT' },
          ...(destinationVerifier ? [{recipeId:RELAY_RECIPE,source:{chainId:BASE_V3.chainId,address:BASE_V3.native,decimals:18},destination:SOLANA_USDC,walletActions:1,
            confirmationPolicy:'TWELVE_CANONICAL_BASE_CONFIRMATIONS_AND_FINALIZED_SOLANA_PINNED_SOLVER_ORDER_MEMO_CREDIT'},
            {recipeId:RELAY_USDC_RECIPE,source:{chainId:BASE_V3.chainId,address:BASE_V3.usdc,decimals:6},destination:SOLANA_USDC,walletActions:2,
            confirmationPolicy:'TWELVE_CANONICAL_BASE_CONFIRMATIONS_EXACT_APPROVAL_AND_FINALIZED_SOLANA_PINNED_SOLVER_ORDER_MEMO_CREDIT'}] : [])] : [],
        executionProfiles: [ ...(valid ? [
          ...(destinationVerifier ? [{recipeId:RELAY_DIRECT_RECIPE,sourceChainId:BASE_V3.chainId,destinationChainId:SOLANA_USDC.chainId,
            sourceAssetTypes:['NATIVE','ERC20'],destinationAssetTypes:['NATIVE','SPL'],requiresFreshValidation:true}] : []),
          ...(solanaRelay ? [{recipeId:RELAY_SOLANA_RECIPE,sourceChainId:SOLANA_USDC.chainId,destinationChainId:BASE_V3.chainId,
            sourceAssetTypes:['NATIVE','SPL'],destinationAssetTypes:['NATIVE'],requiresFreshValidation:true}] : []),
        ] : []), ...(providerRelay ? [{recipeId:RELAY_PROVIDER_RECIPE,sourceChainIds:providerChainIds,destinationChainIds:providerChainIds,
          sourceAssetTypes:['NATIVE','ERC20','SPL'],destinationAssetTypes:['NATIVE','ERC20','SPL'],requiresFreshValidation:true,verification:'PROVIDER_MANAGED'}] : []) ],
        reason: valid || providerRelay ? null : 'EXECUTION_PINS_REQUIRED',
        blockedRoutes: [...(destinationVerifier ? [] : [{ sourceChainId: 'eip155:8453', destinationChainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', reason: 'RELAY_EXECUTION_PINS_REQUIRED' }]),
          ...(solanaRelay ? [] : [{ sourceChainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', destinationChainId: 'eip155:8453', reason: 'SOLANA_EXECUTION_PINS_REQUIRED' }])] };
    },
    async prepare(input, signal = new AbortController().signal) {
      if (!signal || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' ||
        typeof signal.removeEventListener !== 'function') fail('INVALID_EXECUTION_INPUT');
      const started = now(); if (!Number.isSafeInteger(started) || started < 0) fail('INVALID_EXECUTION_CONFIG');
      const request = requestFor(structuredClone(input), started,!!destinationVerifier,!!solanaRelay,providerChainIds);
      if (signal.aborted) fail('EXECUTION_CANCELLED');
      for (const [key, entry] of issued) if (entry.until <= started) issued.delete(key);
      if (issued.size >= 128) fail('EXECUTION_BUSY');
      const strictBaseSwap = !!executionPins.base && request.source.chainId === BASE_V3.chainId && request.destination.chainId === BASE_V3.chainId && request.source.address === BASE_V3.native && request.destination.address === BASE_V3.usdc;
      const strictBaseSol = !!destinationVerifier && request.source.chainId === BASE_V3.chainId && request.destination.chainId === SOLANA_USDC.chainId && request.destination.address === SOLANA_USDC.address && [BASE_V3.native,BASE_V3.usdc].includes(request.source.address);
      if (providerRelay && input.routeScope !== 'INDEPENDENT' && !strictBaseSwap && !strictBaseSol && providerChainIds.includes(request.source.chainId) && providerChainIds.includes(request.destination.chainId)) {
        const prepared = await providerRelay.prepare(request,signal);
        return registerRelay(request,prepared,RELAY_PROVIDER_RECIPE,signal);
      }
      checks.validatePins();
      if (request.source.chainId === SOLANA_USDC.chainId) {
        const prepared = await solanaRelay.prepare(request,signal);
        // prepare already verifies identities, balances, blockhash, fees and the
        // exact unsigned simulation. Claim rechecks them before the wallet opens.
        return registerRelay(request,prepared,RELAY_SOLANA_RECIPE,signal);
      }
      if (request.destination.chainId === SOLANA_USDC.chainId) return transport.run(async (index, signal) => {
        const relay = bundles[index].relay;
        const prepared = await relay.prepare(request,signal), {plan} = prepared;
        await relay.preflight(plan,plan.actions[0],signal);
        const legacyDestination = request.destination.address === SOLANA_USDC.address && request.destination.decimals === 6;
        const recipeId = legacyDestination && request.source.address === BASE_V3.usdc ? RELAY_USDC_RECIPE : legacyDestination && request.source.address === BASE_V3.native ? RELAY_RECIPE : RELAY_DIRECT_RECIPE;
        return registerRelay(request,prepared,recipeId,signal);
      },signal,{timeoutMs:11000});
      return transport.run(async (index, signal) => {
      let transportFailure;
      const fetch = async (...args) => { try { return await transport.transports[index](...args); } catch (error) { transportFailure = error.code; throw error; } };
      const readiness = createBaseReadiness({ fetch, now });
      const inspection = await readiness.inspect({ source: request.source, destination: request.destination, amountRaw: request.amountRaw,
        sender: request.sender, recipient: request.recipient, slippageBps: request.slippageBps }, signal);
      if (inspection.status !== 'READY_FOR_REVIEW' || !inspection.transactionPrepared || inspection.fees.complete !== true)
        fail(inspection.blockers[0]?.code === 'READINESS_QUOTE_UNAVAILABLE' && TRANSIENT_READ_CODES.has(transportFailure) ? transportFailure : inspection.blockers[0]?.code ?? 'EXECUTION_NOT_READY');
      const expiresAtMs = Math.floor(request.deadlineMs / 1000) * 1000;
      const quoteId = `base-v3:${inspection.quote.poolFeePips}:${inspection.quote.poolAddress}:${started}`;
      const action = { id: 'base-uniswap-swap', chainId: BASE_V3.chainId, payload: { type: 'EVM_TRANSACTION', transaction: {
        ...inspection.transaction, chainId: '0x2105',
        data: p.transactionData(request, { poolFeePips: inspection.quote.poolFeePips, minimumOutRaw: inspection.quote.minimumOutputRaw }, expiresAtMs / 1000),
      } } };
      const plan = { routeId: `base-v3:${randomUUID()}`, quoteIds: [quoteId], source: request.source, destination: request.destination,
        sender: request.sender, recipient: request.recipient, amountRaw: request.amountRaw, minimumOutRaw: inspection.quote.minimumOutputRaw,
        expiresAtMs, nativeCosts: [{ chainId: BASE_V3.chainId, amountRaw: inspection.fees.totalNativeBudgetRaw }], actions: [action] };
      const cap = request.nativeFeeBudgets.find(budget => budget.chainId === BASE_V3.chainId);
      if (!cap || cap.maxAmountRaw !== null && BigInt(plan.nativeCosts[0].amountRaw) > BigInt(cap.maxAmountRaw)) fail('EXECUTION_NATIVE_BUDGET_EXCEEDED');
      const fresh = await bundles[index].checks.preflight(plan, action, signal);
      const native = BigInt(plan.nativeCosts[0].amountRaw), amount = BigInt(request.amountRaw), expected = BigInt(inspection.quote.expectedOutputRaw);
      const spotNumerator = amount * BigInt(fresh.sqrtPriceX96) ** 2n, quotedNumerator = expected * (1n << 192n);
      const feeBps = Number(ceil(native * 10000n, amount)) + Math.ceil(inspection.quote.poolFeePips / 100);
      const priceImpactBps = Number(ceil((spotNumerator > quotedNumerator ? spotNumerator - quotedNumerator : 0n) * 10000n, spotNumerator));
      enforceEconomicLimits(request, feeBps, priceImpactBps);
      const leg = { index: 0, capabilityId: RECIPE, adapterId: 'uniswap-v3', kind: 'SWAP', source: request.source, destination: request.destination,
        validationTier: 'EXECUTION_VALIDATED', executionTier: 'WALLET_SIGNED', quoteProbe: false, amountSource: 'REQUEST_AMOUNT', requiresRequoteAfterSettlement: false };
      const quote = { capabilityId: RECIPE, adapterId: 'uniswap-v3', source: request.source, destination: request.destination,
        amountInRaw: request.amountRaw, expectedOutRaw: inspection.quote.expectedOutputRaw, minimumOutRaw: plan.minimumOutRaw,
        feeBps, priceImpactBps, estimatedCompletionMs: 24000, expiresAtMs: inspection.quote.pricingValidUntilMs,
        pricingValidUntilMs: inspection.quote.pricingValidUntilMs, quoteId, executableRecipeId: RECIPE, conditional: false, liquidityConfirmed: true,
        nativeCosts: plan.nativeCosts, costDenominator: { source: request.source, amountRaw: request.amountRaw } };
      const candidate = { id: plan.routeId, requestId: request.requestId, path: { id: plan.routeId, kind: 'DIRECT', source: request.source,
        destination: request.destination, legs: [leg], quoteBasis: 'FIRM_FIRST_LEG', quoteProbe: false, executionReady: false },
        legQuotes: [quote], source: request.source, destination: request.destination, inputAmountRaw: request.amountRaw,
        expectedOutputRaw: quote.expectedOutRaw, minimumOutputRaw: quote.minimumOutRaw, feeBps, priceImpactBps, completionMs: 24000,
        deadlineMs: quote.expiresAtMs, quotedAtMs: now(), conditional: false, validationTier: 'EXECUTION_VALIDATED', executionReady: true };
      if (rankCandidates(request, [candidate], { nowMs: now(), requireExecutable: true }).winner === null) fail('EXECUTION_QUOTE_EXPIRED');
      if (signal.aborted) fail('EXECUTION_CANCELLED');
      if (issued.size >= 128) fail('EXECUTION_BUSY');
      issued.set(candidate.id, { until: Math.min(plan.expiresAtMs, quote.pricingValidUntilMs), digest: await reviewHash({ request, candidate }), plan: structuredClone(plan) });
      return { request: structuredClone(request), candidate: structuredClone(candidate) };
      }, signal);
    },
    async preflight(record, signal) { return verifier.preflight(record.plan, record.plan.actions[record.nextAction], signal); },
    async verify(record, txHash, signal) { return verifier.confirm(record.plan, record.plan.actions[record.nextAction], txHash, signal); },
  };
}
export { ExecutionEngineError };
