import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { privateKeyToAccount } from 'viem/accounts';
import { reviewHash } from '@instinct/router-core';
import { createRouterApi, createFileExecutionStore } from '../src/index.mjs';
import { executionError } from '../src/execution-api.mjs';
import { ExecutionEngineError } from '@instinct/router-engine';
import { enforceEconomicLimits } from '../../engine/src/base-execution-checks.mjs';
const account = privateKeyToAccount('0x' + '03'.repeat(32));
const app = { id: 'app-a', publishableKey: 'pk_a_01234567890123456789', serverKey: 'sk_a_01234567890123456789', allowedOrigins: ['https://a.example'], rateLimitPerMinute: 1000 };
const other = { id: 'app-b', publishableKey: 'pk_b_01234567890123456789', serverKey: 'sk_b_01234567890123456789', allowedOrigins: ['https://b.example'], rateLimitPerMinute: 1000 };
const source = { chainId: 'eip155:8453', address: '0x' + '0'.repeat(40), decimals: 18 }, destination = { ...source, address: '0x' + '1'.repeat(40), decimals: 6 };
const input = { source, destination, sender: account.address, recipient: account.address, amount: '0.000000000000001', slippageBps: 100,
  nativeFeeBudgets: [{ chainId: source.chainId, maxAmountRaw: '10' }] };
const tx = '0x' + 'a1'.repeat(32);
test('gas and asset errors distinguish balances, limits and stale reviews without exposing upstream details', () => {
  for (const [code, detail] of [
    ['EXECUTION_NATIVE_BALANCE_INSUFFICIENT', /wallet does not have enough native currency/],
    ['EXECUTION_NATIVE_BUDGET_EXCEEDED', /configured native fee limit/],
    ['EXECUTION_REVIEW_GAS_RESERVE_EXCEEDED', /fixed review reserve/],
    ['EXECUTION_TOKEN_IDENTITY_MISMATCH', /source asset no longer matches the saved review/],
  ]) {
    const error=new ExecutionEngineError(code); error.message='private provider response';
    const visible=executionError(error);
    assert.equal(visible.code,code); assert.equal(visible.status,409); assert.match(visible.message,detail);
    assert.equal(visible.message.includes('private'),false);
  }
});
test('economic errors distinguish fees and impact and expose only checked numeric limits', () => {
  for (const [fees, impact, code] of [[3000, 0, 'EXECUTION_FEE_LIMIT'], [100, 600, 'EXECUTION_PRICE_IMPACT_LIMIT'], [3000, 600, 'EXECUTION_FEE_AND_IMPACT_LIMIT']]) {
    let blocked;
    try { enforceEconomicLimits({ maxFeeBps: 500, maxPriceImpactBps: 500 }, fees, impact); } catch (error) { blocked = error; }
    blocked.message = 'secret upstream payload';
    const visible = executionError(blocked);
    assert.equal(visible.code, code); assert.equal(visible.status, 409); assert.equal(visible.retryable, false);
    assert.match(visible.message, /fee limit: 5\.00%/); assert.match(visible.message, /impact limit: 5\.00%/);
    assert.equal(visible.message.includes('secret'), false);
  }
  for (const limits of [undefined, { feeBps: 'secret', maxFeeBps: 500, priceImpactBps: 0, maxPriceImpactBps: 500 },
    { feeBps: NaN, maxFeeBps: 500, priceImpactBps: 0, maxPriceImpactBps: 500 },
    { feeBps: 500, maxFeeBps: 500, priceImpactBps: 0, maxPriceImpactBps: 500 },
    { feeBps: 3000, maxFeeBps: 500, priceImpactBps: 0, maxPriceImpactBps: 500, providerResponse: 'secret' }]) {
    const error = new ExecutionEngineError('EXECUTION_ECONOMIC_LIMIT'); error.economicLimits = limits;
    const visible = executionError(error);
    assert.equal(visible.code, 'EXECUTION_ECONOMIC_LIMIT'); assert.equal(visible.message.includes('secret'), false);
  }
});
function engineFixture() {
  let issued, pending = true, failed = false, provenFailure = false, waitPreflight;
  const engine = { capabilities: () => ({ walletExecution: true, supportedRoutes: [{ recipeId: 'recipe', source, destination, walletActions: 1 }] }), recipes: [{ id: 'recipe', verify: async () => structuredClone(issued.plan) }],
    verifier: { isValidTransactionHash: (_chain, hash) => /^0x[0-9a-f]{64}$/.test(hash),
      preflight: async () => { if (waitPreflight) await waitPreflight; return { ready: true }; },
      confirm: async (plan, action, hash) => {
        if (pending) throw Object.assign(new Error('private provider detail'), { code: 'RECEIPT_PENDING' });
        if (provenFailure) return { success: false, confirmedFailure: true, routeId: plan.routeId, actionId: action.id, transactionHash: hash, receipt: { chainId: plan.source.chainId, transactionHash: hash, blockNumberRaw: '100', blockHash: '0x' + 'bc'.repeat(32), observedAtMs: Date.now(), confirmations: 12 } };
        return { success: !failed, routeId: plan.routeId, actionId: action.id, transactionHash: hash,
          destinationCredit: { asset: destination, recipient: plan.recipient, amountRaw: '995' } };
      } },
    prepare: async body => {
      const request = { requestId: 'r1', source, destination, sender: body.sender.toLowerCase(), recipient: body.recipient.toLowerCase(), amountRaw: '1000',
        slippageBps: 100, maxFeeBps: Object.hasOwn(body, 'maxFeeBps') ? body.maxFeeBps : 100, maxPriceImpactBps: 100, maxCompletionMs: 10000, deadlineMs: Date.now() + 60000,
        optimization: { objective: 'BALANCED', maxOutputShortfallBps: 50 }, nativeFeeBudgets: body.nativeFeeBudgets };
      const leg = { index: 0, capabilityId: 'cap', adapterId: 'local', kind: 'SWAP', source, destination, validationTier: 'EXECUTION_VALIDATED',
        executionTier: 'WALLET_SIGNED', quoteProbe: false, amountSource: 'REQUEST_AMOUNT', requiresRequoteAfterSettlement: false };
      const quote = { capabilityId: 'cap', adapterId: 'local', source, destination, amountInRaw: '1000', expectedOutRaw: '1000', minimumOutRaw: '995',
        feeBps: 5, priceImpactBps: 0, estimatedCompletionMs: 1000, expiresAtMs: request.deadlineMs, quoteId: 'q1', executableRecipeId: 'recipe',
        conditional: false, liquidityConfirmed: true, nativeCosts: [{ chainId: source.chainId, amountRaw: '5' }] };
      const candidate = { id: 'route1', requestId: 'r1', source, destination, inputAmountRaw: '1000', expectedOutputRaw: '1000', minimumOutputRaw: '995',
        feeBps: 5, priceImpactBps: 0, completionMs: 1000, deadlineMs: request.deadlineMs, quotedAtMs: Date.now(), conditional: false,
        executionReady: true, validationTier: 'EXECUTION_VALIDATED', legQuotes: [quote], path: { id: 'route1', kind: 'DIRECT', source, destination,
          legs: [leg], quoteBasis: 'FIRM_FIRST_LEG', quoteProbe: false, executionReady: false } };
      const plan = { routeId: candidate.id, quoteIds: ['q1'], source, destination, sender: request.sender, recipient: request.recipient,
        amountRaw: '1000', minimumOutRaw: '995', expiresAtMs: request.deadlineMs, nativeCosts: quote.nativeCosts,
        actions: [{ id: 'swap', chainId: source.chainId, payload: { to: 'pinned', data: '0x1234', value: '1000' } }] };
      issued = { request, candidate, plan }; return { request, candidate };
    } };
  return { engine, setProvenFailure: value => provenFailure = value, setPending: value => pending = value, setFailed: value => failed = value, setWait: value => waitPreflight = value };
}
async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), 'router-api-exec-'));
  const store = await createFileExecutionStore({ directory: path.join(dir, 'journal') }), f = engineFixture();
  const service = { config: () => ({ execution: { enabled: false } }), quote: async () => ({}), resolveAsset: async () => ({}) };
  const server = createRouterApi({ service, apps: [app, other], execution: { engine: f.engine, store }, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const call = async (route, body, token, credential = app, extra = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: credential.allowedOrigins[0], 'X-Router-App-Key': credential.publishableKey, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { 'X-Router-Wallet-Token': token } : {}), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, value: await response.json() };
  };
  const auth = async () => {
    const challenge = await call('/v1/wallets/challenge', { chainId: source.chainId, address: account.address });
    assert.equal(challenge.status, 200);
    const session = await call('/v1/wallets/verify', { challengeId: challenge.value.challengeId, signature: await account.signMessage({ message: challenge.value.message }) });
    assert.equal(session.status, 200); return session.value.walletToken;
  };
  return { ...f, call, auth, store };
}
test('over-limit preparation returns exact economics without creating an execution or changing requested limits', async t => {
  const f = await fixture(t), token = await f.auth();
  f.engine.prepare = async body => {
    assert.equal(body.maxFeeBps, 500);
    enforceEconomicLimits({ maxFeeBps: body.maxFeeBps, maxPriceImpactBps: 500 }, 3058, 0);
  };
  const result = await f.call('/v1/executions/prepare', { ...input, maxFeeBps: 500 }, token);
  assert.equal(result.status, 409);
  assert.equal(result.value.error.code, 'EXECUTION_FEE_LIMIT');
  assert.match(result.value.error.message, /30\.58%.*5\.00%/);
  assert.match(result.value.error.message, /Price impact: 0\.00%/);
  assert.equal((await f.call('/v1/executions/active', undefined, token)).value.execution, null);
});
test('explicit null fee/gas preferences reach an authenticated finite review and survive retrieval', async t => {
  const f = await fixture(t), token = await f.auth();
  const result = await f.call('/v1/executions/prepare', { ...input, maxFeeBps: null,
    nativeFeeBudgets: [{ chainId: source.chainId, maxAmountRaw: null }] }, token);
  assert.equal(result.status, 200);
  const row = result.value.execution;
  assert.equal(row.request.maxFeeBps, null);
  assert.equal(row.request.nativeFeeBudgets[0].maxAmountRaw, null);
  assert.equal(row.plan.nativeCosts[0].amountRaw, '5');
  assert.deepEqual((await f.call(`/v1/executions/${row.id}`, undefined, token)).value.execution, row);
  await f.call(`/v1/executions/${row.id}/cancel`, { reviewHash: row.reviewHash, revision: 0 }, token);
  for (const maxAmountRaw of [undefined, 'null', false]) {
    const invalid = await f.call('/v1/executions/prepare', { ...input, maxFeeBps: null,
      nativeFeeBudgets: [{ chainId: source.chainId, maxAmountRaw }] }, token);
    assert.equal(invalid.status, 400);
  }
});
test('price impact remains readable and blocking when fee ceiling is null', () => {
  const error = new ExecutionEngineError('EXECUTION_ECONOMIC_LIMIT');
  error.economicLimits = { feeBps: 15000, maxFeeBps: null, priceImpactBps: 600, maxPriceImpactBps: 500 };
  const visible = executionError(error);
  assert.equal(visible.code, 'EXECUTION_PRICE_IMPACT_LIMIT');
  assert.match(visible.message, /150.00%.*fee limit: none/);
});
test('app credentials alone cannot write, wallet proof scoped ownership and payload digest bind fresh claim', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/v1/executions/prepare', input)).status, 401);
  const token = await f.auth(), prepared = await f.call('/v1/executions/prepare', input, token);
  assert.equal(prepared.status, 200); const row = prepared.value.execution;
  assert.equal(row.ownerId, undefined); assert.equal(row.plan.actions[0].payload, undefined);
  assert.equal((await f.call('/v1/executions/active', undefined, token)).value.execution.id, row.id);
  assert.equal((await f.call(`/v1/executions/${row.id}`, undefined, token, other)).status, 401);
  assert.equal((await f.call(`/v1/executions/${row.id}/claim`, { reviewHash: '0'.repeat(64), revision: 0 }, token)).status, 409);
  const claim = await f.call(`/v1/executions/${row.id}/claim`, { reviewHash: row.reviewHash, revision: row.revision }, token);
  assert.equal(claim.status, 200); assert.equal(await reviewHash(claim.value.action.payload), row.plan.actions[0].payloadHash);
  assert.equal((await f.call(`/v1/executions/${row.id}/claim`, { reviewHash: row.reviewHash, revision: row.revision }, token)).status, 409);
  assert.equal((await f.call(`/v1/executions/${row.id}/cancel`, { reviewHash: row.reviewHash, revision: 1 }, token)).status, 409);
});
test('pending receipts preserve submission; uncertain claim recovers original hash; confirmed credit completes', async t => {
  const f = await fixture(t), token = await f.auth(), row = (await f.call('/v1/executions/prepare', input, token)).value.execution;
  await f.call(`/v1/executions/${row.id}/claim`, { reviewHash: row.reviewHash, revision: 0 }, token);
  assert.equal((await f.call(`/v1/executions/${row.id}/uncertain`, {}, token)).value.execution.status, 'RECOVERY_REQUIRED');
  assert.equal((await f.call(`/v1/executions/${row.id}/submit`, { transactionHash: tx }, token)).value.execution.status, 'SUBMITTED');
  const pending = await f.call(`/v1/executions/${row.id}/refresh`, {}, token);
  assert.equal(pending.value.receiptStatus, 'PENDING'); assert.equal(pending.value.execution.status, 'SUBMITTED');
  assert.equal(JSON.stringify(pending.value).includes('private provider'), false);
  f.setPending(false); const confirmed = await f.call(`/v1/executions/${row.id}/refresh`, {}, token);
  assert.equal(confirmed.value.execution.status, 'COMPLETE'); assert.equal(confirmed.value.receiptStatus, 'CONFIRMED');
  assert.equal((await f.call('/v1/executions/active', undefined, token)).value.execution, null);
});
test('neverclaimed preview cancellation releases reservation; wrong sender and arbitrary preparation fields rejected', async t => {
  const f = await fixture(t), token = await f.auth();
  assert.equal((await f.call('/v1/executions/prepare', { ...input, sender: '0x' + '4'.repeat(40) }, token)).status, 403);
  assert.equal((await f.call('/v1/executions/prepare', { ...input, providerUrl: 'https://evil.example' }, token)).status, 400);
  const row = (await f.call('/v1/executions/prepare', input, token)).value.execution;
  const cancelled = await f.call(`/v1/executions/${row.id}/cancel`, { reviewHash: row.reviewHash, revision: 0 }, token);
  assert.equal(cancelled.status, 200); assert.equal(cancelled.value.execution.status, 'CANCELLED');
  assert.equal((await f.call('/v1/executions/active', undefined, token)).value.execution, null);
  assert.equal((await f.call('/v1/executions/prepare', input, token)).status, 200);
});
test('confirmed unsuccessful receipt stays reserved and never grants another action', async t => {
  const f = await fixture(t), token = await f.auth(), row = (await f.call('/v1/executions/prepare', input, token)).value.execution;
  await f.call(`/v1/executions/${row.id}/claim`, { reviewHash: row.reviewHash, revision: 0 }, token);
  await f.call(`/v1/executions/${row.id}/submit`, { transactionHash: tx }, token); f.setPending(false); f.setFailed(true);
  const result = await f.call(`/v1/executions/${row.id}/refresh`, {}, token);
  assert.equal(result.value.receiptStatus, 'RECOVERY_REQUIRED'); assert.equal(result.value.execution.status, 'RECOVERY_REQUIRED');
  assert.equal((await f.call('/v1/executions/prepare', input, token)).status, 409);
});
test('timed out claim retains transport capacity and cannot return or persist a late wallet action', async t => {
  const f = await fixture(t, { quoteTimeoutMs: 100, maxConcurrent: 1 }), token = await f.auth();
  const row = (await f.call('/v1/executions/prepare', input, token)).value.execution;
  let release; f.setWait(new Promise(resolve => { release = resolve; }));
  const timed = await f.call(`/v1/executions/${row.id}/claim`, { reviewHash: row.reviewHash, revision: 0 }, token);
  assert.equal(timed.status, 504); assert.equal(timed.value.action, undefined);
  assert.equal((await f.call(`/v1/executions/${row.id}`, undefined, token)).status, 429);
  release(); await new Promise(resolve => setTimeout(resolve, 20));
  const recovered = await f.call(`/v1/executions/${row.id}`, undefined, token);
  assert.equal(recovered.value.execution.status, 'READY');
});
test('expiry only releases neverclaimed READY and preserves the immutable expired record', async t => {
  const f = await fixture(t), token = await f.auth(), row = (await f.call('/v1/executions/prepare', input, token)).value.execution;
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() }); t.mock.timers.tick(65000);
  const expired = await f.call(`/v1/executions/${row.id}`, undefined, token);
  assert.equal(expired.status, 200); assert.equal(expired.value.execution.status, 'EXPIRED');
  assert.equal(expired.value.execution.reviewHash, row.reviewHash);
  assert.equal((await f.call('/v1/executions/active', undefined, token)).value.execution, null);
  assert.equal((await f.call('/v1/executions/prepare', input, token)).status, 200);
});

test('only independently bound canonical revert receipt releases reservation as FAILED and persists evidence', async t => {
  const f = await fixture(t), token = await f.auth(), row = (await f.call('/v1/executions/prepare', input, token)).value.execution;
  await f.call(`/v1/executions/${row.id}/claim`, { reviewHash: row.reviewHash, revision: 0 }, token);
  await f.call(`/v1/executions/${row.id}/submit`, { transactionHash: tx }, token); f.setPending(false); f.setProvenFailure(true);
  const result = await f.call(`/v1/executions/${row.id}/refresh`, {}, token);
  assert.equal(result.status, 200); assert.equal(result.value.receiptStatus, 'FAILED'); assert.equal(result.value.execution.status, 'FAILED');
  assert.equal(result.value.execution.receipt.transactionHash, tx);
  assert.equal(result.value.execution.receipt.destinationCredit, undefined);
  assert.ok(result.value.execution.timeline.failedAtMs >= result.value.execution.timeline.submittedAtMs);
  assert.equal((await f.call('/v1/executions/active', undefined, token)).value.execution, null);
  assert.equal((await f.call('/v1/executions/prepare', input, token)).status, 200);
});

test('refresh is idempotent after a saved submission reaches a terminal state and remains owner protected', async t => {
  const f = await fixture(t), token = await f.auth(), row = (await f.call('/v1/executions/prepare', input, token)).value.execution;
  await f.call(`/v1/executions/${row.id}/claim`, { reviewHash: row.reviewHash, revision: 0 }, token);
  await f.call(`/v1/executions/${row.id}/submit`, { transactionHash: tx }, token);
  f.setPending(false); f.setProvenFailure(true);
  const first = await f.call(`/v1/executions/${row.id}/refresh`, {}, token);
  assert.equal(first.value.execution.status, 'FAILED');
  f.engine.verifier.confirm = async () => { throw Error('Terminal records must not query the network again'); };
  const again = await f.call(`/v1/executions/${row.id}/refresh`, {}, token);
  assert.equal(again.status, 200); assert.deepEqual(again.value.execution, first.value.execution);
  assert.equal(again.value.receiptStatus, 'FAILED'); assert.equal(again.value.progress, undefined);
  assert.notEqual((await f.call(`/v1/executions/${row.id}/refresh`, {})).status, 200);
});

test('pending refresh never relays unvalidated progress or raw upstream details', async t => {
  const f = await fixture(t), token = await f.auth(), row = (await f.call('/v1/executions/prepare', input, token)).value.execution;
  await f.call(`/v1/executions/${row.id}/claim`, { reviewHash: row.reviewHash, revision: 0 }, token);
  await f.call(`/v1/executions/${row.id}/submit`, { transactionHash: tx }, token);
  f.engine.verifier.confirm = async () => { throw Object.assign(new Error('private upstream detail'), {
    code: 'DESTINATION_RECEIPT_PENDING', progress: { stage: 'DESTINATION_CONFIRMED', rawProviderResponse: 'private' } }); };
  const response = await f.call(`/v1/executions/${row.id}/refresh`, {}, token);
  assert.equal(response.status, 200); assert.equal(response.value.receiptStatus, 'PENDING');
  assert.equal(response.value.execution.status, 'SUBMITTED'); assert.equal(response.value.progress, undefined);
  assert.equal(JSON.stringify(response.value).includes('private'), false);
});

test('config exposes only trusted configured execution route coverage and explicit wallet-only signing', async t => {
  const f = await fixture(t), response = await f.call('/v1/config');
  assert.equal(response.status, 200); assert.equal(response.value.execution.enabled, true); assert.equal(response.value.execution.signing, 'USER_WALLET_ONLY'); assert.equal(response.value.execution.broadcastsTransactions, false);
  assert.deepEqual(response.value.execution.supportedRoutes[0].source, source);
  assert.deepEqual(response.value.execution.supportedRoutes[0].destination, destination);
  const caps = await f.call('/v1/capabilities'); assert.equal(caps.value.capabilities.walletExecution, true);
  assert.equal(caps.value.readOnly, false);
});

test('profile-only execution coverage uses the same public field in config and capabilities', async t => {
  const f = await fixture(t);
  const profiles = [{ recipeId: 'relay-solana-base-direct-v1',
    sourceChainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', destinationChainId: 'eip155:8453',
    sourceAssetTypes: ['NATIVE', 'SPL'], destinationAssetTypes: ['NATIVE'], requiresFreshValidation: true }];
  f.engine.capabilities = () => ({ walletExecution: true, supportedRoutes: [], executionProfiles: profiles });
  for (const path of ['/v1/config', '/v1/capabilities']) {
    const response = await f.call(path);
    assert.equal(response.status, 200);
    assert.equal(response.value.execution.enabled, true);
    assert.deepEqual(response.value.execution.supportedRoutes, []);
    assert.deepEqual(response.value.execution.executionProfiles, profiles);
    assert.equal(response.value.capabilities.executionProfiles, undefined);
    assert.equal(response.value.capabilities.walletExecution, true);
  }
  f.engine.capabilities = () => ({ walletExecution: false, supportedRoutes: [], executionProfiles: profiles });
  const disabled = await f.call('/v1/config');
  assert.equal(disabled.value.execution.enabled, false);
  assert.deepEqual(disabled.value.execution.executionProfiles, []);
});
