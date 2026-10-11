import { ServiceError, ExecutionEngineError } from '@instinct/router-engine';
import { randomUUID } from 'node:crypto';
import { WalletExecutionCoordinator, reviewHash } from '@instinct/router-core';
import { ApiError, fault } from './security.mjs';
import { walletIdentity } from './wallet-auth.mjs';
import { settlementProgress } from './settlement-progress.mjs';

const exact = (body, keys, optional = []) => {
  if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).some(k => ![...keys, ...optional].includes(k)) || keys.some(k => !Object.hasOwn(body, k)))
    fault(400, 'INVALID_REQUEST', 'Use the exact execution request fields.');
};
const errors = new Set(['EXECUTION_ALREADY_ACTIVE', 'EXECUTION_CONFLICT', 'EXECUTION_CLAIM_BLOCKED', 'FRESH_PREFLIGHT_REQUIRED',
  'EXECUTION_RECOVERY_BLOCKED',
  'EXECUTION_CANCEL_BLOCKED', 'EXECUTION_EXPIRY_BLOCKED', 'INVALID_SUBMISSION', 'INVALID_RECOVERY_STATE', 'INVALID_CONFIRMATION_STATE', 'ORIGINAL_HASH_REQUIRED', 'EXECUTION_NOT_FOUND',
  'RECEIPT_BINDING_MISMATCH', 'DESTINATION_CREDIT_REQUIRED', 'EXECUTION_REVIEW_CORRUPTED', 'EXECUTION_TRANSACTION_REUSED', 'EXECUTION_ORDER_REUSED', 'EXECUTION_DELIVERY_REUSED', 'DESTINATION_RECEIPT_BINDING_MISMATCH']);
export function executionError(error) {
  if (error instanceof ApiError) return error;
  const code = error?.code;
  if (error instanceof ExecutionEngineError) {
    const message = {
      RELAY_AMOUNT_TOO_LOW: 'This amount is below the route provider’s minimum. Try a larger amount or another pair.',
      RELAY_NO_SWAP_ROUTES_FOUND: 'No liquid route is available for this exact token pair and amount right now.',
      RELAY_UNSUPPORTED_ROUTE: 'The provider cannot execute this exact route right now. Try another token or network.',
      RELAY_UNSUPPORTED_CURRENCY: 'The provider does not currently have a route for this token.',
      RELAY_INSUFFICIENT_FUNDS: 'The provider could not build the route with the available source funds.',
      RELAY_SWAP_IMPACT_TOO_HIGH: 'Available liquidity would cause excessive price impact for this amount.',
      RELAY_PROVIDER_READ_UNAVAILABLE: 'A network endpoint could not supply the fresh checks for this route. Try again shortly.',
      RELAY_PROVIDER_UNAVAILABLE: 'The route provider is temporarily unavailable. Try again shortly.',
      RELAY_PROVIDER_TOKEN_UNSUPPORTED: 'The token metadata did not match the selected asset. Resolve its contract address again.',
      RELAY_PROVIDER_FEES_UNKNOWN: 'The network fees could not be verified for this route. No wallet action was created.',
      RELAY_PROVIDER_STEP_UNSUPPORTED: 'This route requires wallet steps that are not supported yet. No wallet action was created.',
      EXECUTION_NATIVE_BALANCE_INSUFFICIENT: 'The source wallet does not have enough native currency for the input amount plus network fees.',
      DESTINATION_RECIPE_UNSUPPORTED: 'This destination needs a delivery verifier that is not enabled yet. No funds were sent.',
      DESTINATION_WALLET_UNSUPPORTED: 'This route currently requires a regular receiving wallet. No funds were sent.',
      RELAY_SOURCE_RECIPE_UNSUPPORTED: 'This token needs an additional swap step that has not yet passed execution validation. No funds were sent.',
      EXECUTION_TOKEN_BEHAVIOR_UNSUPPORTED: 'This token uses transfer behavior that this execution route cannot verify. No funds were sent.',
      EXECUTION_TOKEN_BALANCE_INSUFFICIENT: 'The source wallet does not have enough of the selected token.',
      EXECUTION_TOKEN_IDENTITY_MISMATCH: 'The source asset no longer matches the saved review. Request a fresh review before approving the swap.',
      RELAY_ORDER_SIGNATURE_INVALID: 'The route signature could not be verified. Request a fresh route.',
      EXECUTION_REVIEW_GAS_RESERVE_EXCEEDED: 'Fresh gas costs exceed this fixed review reserve. Request a new review for an updated estimate.',
      EXECUTION_NATIVE_BUDGET_EXCEEDED: 'The estimated gas reserve exceeds the configured native fee limit. Review the limit before preparing again.',
    }[code];
    if (message) return new ApiError(409, code, message);
  }
  if (error instanceof ExecutionEngineError && code === 'EXECUTION_ECONOMIC_LIMIT') {
    const limits = error.economicLimits, keys = ['feeBps', 'maxFeeBps', 'priceImpactBps', 'maxPriceImpactBps'];
    if (limits && Object.getPrototypeOf(limits) === Object.prototype && Object.keys(limits).length === keys.length &&
      keys.every(key => Object.hasOwn(limits, key) && (key === 'maxFeeBps' && limits[key] === null || Number.isSafeInteger(limits[key]) && limits[key] >= 0)) &&
      (limits.maxFeeBps === null || limits.maxFeeBps <= 10000) && limits.maxPriceImpactBps <= 10000) {
      const feesExceeded = limits.maxFeeBps !== null && limits.feeBps > limits.maxFeeBps, impactExceeded = limits.priceImpactBps > limits.maxPriceImpactBps;
      if (feesExceeded || impactExceeded) {
        const percent = bps => (bps / 100).toFixed(2) + '%';
        return new ApiError(409, feesExceeded && impactExceeded ? 'EXECUTION_FEE_AND_IMPACT_LIMIT' :
          feesExceeded ? 'EXECUTION_FEE_LIMIT' : 'EXECUTION_PRICE_IMPACT_LIMIT',
          `Estimated total fees (including source gas reserve): ${percent(limits.feeBps)}; your fee limit: ${limits.maxFeeBps === null ? 'none' : percent(limits.maxFeeBps)}. ` +
          `Price impact: ${percent(limits.priceImpactBps)}; your impact limit: ${percent(limits.maxPriceImpactBps)}. ` +
          'No transaction was prepared. Review the amount and Swap settings before trying again.');
      }
    }
  }
  if ((error instanceof ServiceError || error instanceof ExecutionEngineError) && typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(code) && [400, 409, 422, 501].includes(error.status))
    return new ApiError(error.status, code, 'Check execution preparation details and supported routes.');
  if (errors.has(code)) return new ApiError(code === 'EXECUTION_NOT_FOUND' ? 404 : 409, code, 'The execution cannot advance. Check its latest state before continuing.');
  if (['RECEIPT_PENDING','DESTINATION_RECEIPT_PENDING'].includes(code)) return new ApiError(409, code, 'The transaction receipt is not confirmed yet.', true, 2000);
  return new ApiError(503, 'EXECUTION_UNAVAILABLE', 'Execution evidence could not be verified. No new wallet action is authorized.', true);
}
export function createExecutionApi({ engine, store }) {
  if (!engine || typeof engine.prepare !== 'function' || !Array.isArray(engine.recipes) || !engine.verifier ||
    !store || ['get', 'insert', 'compareAndSwap', 'findActive'].some(k => typeof store[k] !== 'function')) throw new Error('A verified execution engine and durable store are required.');
  const owned = async (id, wallet) => {
    const row = await store.get(id);
    if (!row || row.ownerId !== wallet.ownerId) fault(404, 'EXECUTION_NOT_FOUND', 'Execution not found.');
    const identity = walletIdentity(row.request.source.chainId, row.request.sender);
    if (identity.chainId !== wallet.chainId || identity.address !== wallet.address) fault(404, 'EXECUTION_NOT_FOUND', 'Execution not found.');
    return row;
  };
  const publicRecord = async row => {
    const { ownerId, ...value } = structuredClone(row);
    value.plan.actions = await Promise.all(row.plan.actions.map(async action => ({ id: action.id, chainId: action.chainId, payloadHash: await reviewHash(action.payload) })));
    return value;
  };
  const refreshed = async row => ({ execution: await publicRecord(row), receiptStatus:
    row.status === 'COMPLETE' || row.status === 'READY' && row.nextAction > 0 ? 'CONFIRMED' :
      row.status === 'FAILED' ? 'FAILED' : 'RECOVERY_REQUIRED' });
  const coordinator = signal => new WalletExecutionCoordinator(store, engine.recipes,
    { isValidTransactionHash: (...args) => engine.verifier.isValidTransactionHash(...args),
      ...(engine.verifier.recoverUnsubmitted ? { recoverUnsubmitted: async input => { const value = await engine.verifier.recoverUnsubmitted(input, signal); if (signal.aborted) fault(499, 'CANCELLED', 'The recovery check was cancelled.'); return value; } } : {}),
      ...(engine.verifier.release ? { release: async input => { const value = await engine.verifier.release(input, signal); if (signal.aborted) fault(499, 'CANCELLED', 'The execution check was cancelled.'); return value; } } : {}),
      preflight: async (...args) => { const value = await engine.verifier.preflight(...args, signal); if (signal.aborted) fault(499, 'CANCELLED', 'The execution check was cancelled.'); return value; }, confirm: (...args) => engine.verifier.confirm(...args, signal) });
  const recoverExpired = async (row, signal) => {
    if (!row || signal.aborted) return row;
    const host=coordinator(signal);
    if (row.status==='READY' && row.nextAction===0 && row.plan.expiresAtMs<=Date.now()) return host.expire(row.id,row.ownerId);
    if (!engine.verifier.recoverUnsubmitted || !['CLAIMED','RECOVERY_REQUIRED'].includes(row.status) || row.nextAction!==0 ||
      row.submissions.length || row.plan.actions.length!==1 || row.plan.providerRoute?.sourceVm!=='SOLANA' || row.plan.expiresAtMs>Date.now()) return row;
    try { return await host.recoverUnsubmitted(row.id,row.ownerId); }
    catch (error) {
      if (error?.code==='EXECUTION_RECOVERY_BLOCKED' || error?.code==='EXECUTION_CONFLICT') return await store.get(row.id);
      throw error;
    }
  };
  return {
    async get(id, wallet, signal=new AbortController().signal) { const row = await recoverExpired(await owned(id, wallet),signal); return { execution: await publicRecord(row) }; },
    async active(wallet, signal=new AbortController().signal) {
      let row = await store.findActive(wallet.ownerId);
      if (row) { row=await recoverExpired(await owned(row.id,wallet),signal); if (['EXPIRED','COMPLETE','FAILED','CANCELLED'].includes(row.status)) row=null; }
      return { execution: row ? await publicRecord(await owned(row.id, wallet)) : null };
    },
    async prepare(body, wallet, signal) {
      const inputWallet = walletIdentity(body?.source?.chainId, body?.sender);
      if (inputWallet.chainId !== wallet.chainId || inputWallet.address !== wallet.address) fault(403, 'WALLET_BINDING_MISMATCH', 'The verified wallet must match the source sender.');
      const saved = await store.findActive(wallet.ownerId);
      const active = saved ? await recoverExpired(await owned(saved.id,wallet),signal) : null;
      if (active && !['EXPIRED','COMPLETE','FAILED','CANCELLED'].includes(active.status)) fault(409, 'EXECUTION_ALREADY_ACTIVE', 'Recover or cancel the existing execution before preparing another.');
      const prepared = await engine.prepare(structuredClone(body), signal);
      if (signal.aborted) fault(499, 'CANCELLED', 'The execution preparation was cancelled.');
      const identity = walletIdentity(prepared.request.source.chainId, prepared.request.sender);
      if (identity.chainId !== wallet.chainId || identity.address !== wallet.address) fault(403, 'WALLET_BINDING_MISMATCH', 'The verified wallet must match the source sender.');
      const row = await coordinator(signal).prepare('ex_' + randomUUID(), wallet.ownerId, prepared.request, prepared.candidate);
      return { execution: await publicRecord(row) };
    },
    async mutate(id, operation, body, wallet, signal) {
      await owned(id, wallet); const host = coordinator(signal);
      if (signal.aborted) fault(499, 'CANCELLED', 'The execution request was cancelled.');
      if (['claim', 'cancel'].includes(operation)) {
        exact(body, ['reviewHash', 'revision']);
        if (typeof body.reviewHash !== 'string' || !/^[0-9a-f]{64}$/.test(body.reviewHash) || !Number.isSafeInteger(body.revision) || body.revision < 0)
          fault(400, 'INVALID_REQUEST', 'Use the exact reviewed hash and revision.');
        if (operation === 'cancel') return { execution: await publicRecord(await host.cancel(id, wallet.ownerId, body.reviewHash, body.revision)) };
        const value = await host.claim(id, wallet.ownerId, body.reviewHash, body.revision);
        return { execution: await publicRecord(value.record), action: value.action };
      }
      if (operation === 'submit') {
        exact(body, ['transactionHash']);
        return { execution: await publicRecord(await host.submitted(id, wallet.ownerId, body.transactionHash)) };
      }
      exact(body, []);
      if (operation === 'uncertain') return { execution: await publicRecord(await host.signingUncertain(id, wallet.ownerId)) };
      // A saved submission can poll directly: completed or advanced records do
      // not need a preceding GET and never repeat their receipt verification.
      const current = await recoverExpired(await owned(id, wallet),signal);
      if (!['SUBMITTED', 'RECOVERY_REQUIRED'].includes(current.status)) return refreshed(current);
      try {
        const row = await host.confirmed(id, wallet.ownerId);
        return refreshed(row);
      } catch (error) {
        if (error?.code === 'EXECUTION_CONFLICT') {
          const latest = await owned(id, wallet);
          if (!['SUBMITTED', 'RECOVERY_REQUIRED'].includes(latest.status)) return refreshed(latest);
        }
        if (!['RECEIPT_PENDING','DESTINATION_RECEIPT_PENDING'].includes(error?.code)) throw error;
        const latest = await owned(id, wallet);
        if (!['SUBMITTED', 'RECOVERY_REQUIRED'].includes(latest.status)) return refreshed(latest);
        const progress = settlementProgress(error.progress, latest);
        return { execution: await publicRecord(latest), receiptStatus: 'PENDING', ...(progress ? { progress } : {}) };
      }
    },
  };
}
