import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WalletExecutionCoordinator, reviewHash } from '../dist/execution.js';
import type { ExecutionRecord, ExecutionStore, ExecutionVerifier, VerifiedWalletPlan } from '../dist/execution.js';
import type { RouteCandidate, RouterRequest } from '../dist/types.js';

function fixtures() {
  const source = { chainId: 'eip155:8453' as const, address: '0x0000000000000000000000000000000000000000', decimals: 18 };
  const destination = { chainId: 'eip155:8453' as const, address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 };
  const request: RouterRequest = { requestId: 'r1', source, destination, sender: '0x1111111111111111111111111111111111111111', recipient: '0x2222222222222222222222222222222222222222', amountRaw: '1000',
    slippageBps: 100, maxFeeBps: 100, maxPriceImpactBps: 100, maxCompletionMs: 10000, deadlineMs: Date.now() + 60000,
    optimization: { objective: 'BALANCED', maxOutputShortfallBps: 50 }, nativeFeeBudgets: [{ chainId: source.chainId, maxAmountRaw: '10' }] };
  const leg = { index: 0, capabilityId: 'cap', adapterId: 'local', kind: 'BRIDGE' as const, source, destination,
    validationTier: 'EXECUTION_VALIDATED' as const, executionTier: 'WALLET_SIGNED' as const, quoteProbe: false,
    amountSource: 'REQUEST_AMOUNT' as const, requiresRequoteAfterSettlement: false };
  const quote = { capabilityId: 'cap', adapterId: 'local', source, destination, amountInRaw: '1000', expectedOutRaw: '1000', minimumOutRaw: '995',
    feeBps: 5, priceImpactBps: 0, estimatedCompletionMs: 1000, expiresAtMs: request.deadlineMs, quoteId: 'q1', executableRecipeId: 'recipe',
    conditional: false, liquidityConfirmed: true, nativeCosts: [{ chainId: source.chainId, amountRaw: '5' }] };
  const candidate: RouteCandidate = { id: 'route1', requestId: 'r1', source, destination, inputAmountRaw: '1000', expectedOutputRaw: '1000', minimumOutputRaw: '995',
    feeBps: 5, priceImpactBps: 0, completionMs: 1000, deadlineMs: request.deadlineMs, quotedAtMs: Date.now(), conditional: false,
    executionReady: true, validationTier: 'EXECUTION_VALIDATED', legQuotes: [quote], path: { id: 'route1', kind: 'DIRECT', source, destination,
      legs: [leg], quoteBasis: 'FIRM_FIRST_LEG', quoteProbe: false, executionReady: false } };
  const plan: VerifiedWalletPlan = { routeId: candidate.id, quoteIds: ['q1'], source, destination, sender: request.sender, recipient: request.recipient,
    amountRaw: '1000', minimumOutRaw: '995', expiresAtMs: request.deadlineMs, nativeCosts: quote.nativeCosts,
    actions: [{ id: 'deposit', chainId: source.chainId, payload: { to: 'pinned', amountRaw: '1000' } }] };
  return { request, candidate, plan: structuredClone(plan) };
}
class TestStore implements ExecutionStore {
  rows = new Map<string, ExecutionRecord>();
  async insert(record: ExecutionRecord) { if (this.rows.has(record.id)) return false; this.rows.set(record.id, structuredClone(record)); return true; }
  async get(id: string) { return structuredClone(this.rows.get(id) ?? null); }
  async compareAndSwap(id: string, revision: number, next: ExecutionRecord) {
    if (this.rows.get(id)?.revision !== revision) return false; this.rows.set(id, structuredClone(next)); return true;
  }
}
const tx = '0x' + 'a1'.repeat(32);
function setup() {
  const f = fixtures(), store = new TestStore();
  const verifier: ExecutionVerifier = { isValidTransactionHash: (_chain, hash) => /^0x[0-9a-f]{64}$/.test(hash),
    preflight: async () => ({ ready: true }), confirm: async (plan, action, hash) => ({
    success: true, routeId: plan.routeId, actionId: action.id, transactionHash: hash,
    destinationCredit: { asset: plan.destination, recipient: plan.recipient, amountRaw: '995' },
  }) };
  const coordinator = new WalletExecutionCoordinator(store, [{ id: 'recipe', verify: async () => f.plan }], verifier);
  return { ...f, store, verifier, coordinator };
}
test('canonical exact plan is consent-bound and concurrent claims only return one wallet action', async () => {
  const f = setup(); const record = await f.coordinator.prepare('p1', 'owner', f.request, f.candidate);
  const results = await Promise.allSettled([0, 1].map(() => f.coordinator.claim('p1', 'owner', record.reviewHash, 0)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  await f.coordinator.submitted('p1', 'owner', tx);
  assert.equal((await f.coordinator.confirmed('p1', 'owner')).status, 'COMPLETE');
});
test('null fee and native preferences bind finite review terms without authorizing unlisted chains', async () => {
  const f = setup();
  const request = { ...f.request, maxFeeBps: null,
    nativeFeeBudgets: [{ chainId: f.request.source.chainId, maxAmountRaw: null }] };
  const review = await f.coordinator.prepare('no-caps', 'owner', request, f.candidate);
  assert.equal(review.request.maxFeeBps, null);
  assert.equal(review.request.nativeFeeBudgets![0]!.maxAmountRaw, null);
  assert.equal(review.plan.nativeCosts[0]!.amountRaw, '5');
  assert.notEqual(review.reviewHash, await reviewHash({ request: f.request, plan: review.plan }));
  await f.coordinator.claim(review.id, 'owner', review.reviewHash, 0);
  const g = setup();
  Object.assign(g.plan, { nativeCosts: [{ chainId: 'eip155:1', amountRaw: '5' }, ...g.plan.nativeCosts] });
  await assert.rejects(g.coordinator.prepare('bad-chain', 'owner', { ...g.request, maxFeeBps: null,
    nativeFeeBudgets: request.nativeFeeBudgets }, g.candidate), /NATIVE_BUDGET_EXCEEDED/);
});
test('unknown wallet result cannot be claimed again; a late original hash remains recoverable', async () => {
  const f = setup(); const record = await f.coordinator.prepare('p1', 'owner', f.request, f.candidate);
  await f.coordinator.claim('p1', 'owner', record.reviewHash, 0); await f.coordinator.signingUncertain('p1', 'owner');
  await assert.rejects(f.coordinator.claim('p1', 'owner', record.reviewHash, 2), /CLAIM_BLOCKED/);
  await assert.rejects(f.coordinator.confirmed('p1', 'owner'), /ORIGINAL_HASH_REQUIRED/);
  const saved = await f.coordinator.submitted('p1', 'owner', tx);
  assert.equal((await f.coordinator.submitted('p1', 'owner', tx)).revision, saved.revision);
  await assert.rejects(f.coordinator.submitted('p1', 'owner', '0x' + 'b2'.repeat(32)), /INVALID_SUBMISSION/);
  assert.equal((await f.coordinator.confirmed('p1', 'owner')).status, 'COMPLETE');
});
test('an expired unclaimed action is not mistaken for an ambiguous wallet submission', async t => {
  const f = setup();
  (f.plan as any).actions = [{ id: 'approve', chainId: f.request.source.chainId, payload: { amountRaw: '1000' } }, ...f.plan.actions];
  const r = await f.coordinator.prepare('p1', 'owner', f.request, f.candidate);
  await f.coordinator.claim('p1', 'owner', r.reviewHash, 0); await f.coordinator.submitted('p1', 'owner', tx);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() }); t.mock.timers.tick(65000);
  const row = await f.coordinator.confirmed('p1', 'owner');
  assert.equal(row.status, 'READY'); assert.equal(row.nextAction, 1); assert.equal(row.claimedActionId, null);
  await assert.rejects(f.coordinator.claim('p1', 'owner', row.reviewHash, row.revision), /CLAIM_BLOCKED/);
  await assert.rejects(f.coordinator.cancel('p1', 'owner', row.reviewHash, row.revision), /CANCEL_BLOCKED/);
  await assert.rejects(f.coordinator.submitted('p1', 'owner', '0x' + 'b2'.repeat(32)), /INVALID_SUBMISSION/);
});

function usdcApprovalSetup() {
  const f = setup();
  const usdc = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', spender = '0x4cd00e387622c35bddb9b4c962c136462338bc31';
  Object.assign(f.request.source, { address: usdc, decimals: 6 });
  Object.assign(f.request.destination, { chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 });
  (f.request as any).recipient = '47YyVUMwerrz76mCrpgFP3iDva1Vt4ZxpSuxo6AhwabT';
  Object.assign(f.plan, { source: structuredClone(f.request.source), destination: structuredClone(f.request.destination), recipient: f.request.recipient,
    actions: [{ id: 'relay-usdc-approve', chainId: f.request.source.chainId,
      payload: { type: 'EVM_TRANSACTION', transaction: { chainId: '0x2105', from: f.request.sender, to: usdc, value: '0x0',
        data: '0x095ea7b3' + spender.slice(2).padStart(64, '0') + BigInt(f.plan.amountRaw).toString(16).padStart(64, '0') } } },
      { id: 'relay-usdc-deposit', chainId: f.request.source.chainId, payload: { type: 'EVM_TRANSACTION' } }] });
  return f;
}
test('only independently rechecked exact approvals allow cancellation after confirmation, including expired reviews', async t => {
  const f = usdcApprovalSetup(), review = await f.coordinator.prepare('p1', 'owner', f.request, f.candidate);
  let releaseCalls = 0;
  f.verifier.release = async ({ record }) => { releaseCalls++; assert.equal(record.submissions[0]?.hash, tx); return { ready: true }; };
  await f.coordinator.claim('p1', 'owner', review.reviewHash, 0);
  await assert.rejects(f.coordinator.cancel('p1', 'owner', review.reviewHash, 1), /CANCEL_BLOCKED/);
  await f.coordinator.submitted('p1', 'owner', tx);
  await assert.rejects(f.coordinator.cancel('p1', 'owner', review.reviewHash, 2), /CANCEL_BLOCKED/);
  assert.equal(releaseCalls, 0);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() }); t.mock.timers.tick(65000);
  const approved = await f.coordinator.confirmed('p1', 'owner');
  assert.equal(approved.status, 'READY');
  await assert.rejects(f.coordinator.claim('p1', 'owner', approved.reviewHash, approved.revision), /CLAIM_BLOCKED/);
  const cancelled = await f.coordinator.cancel('p1', 'owner', approved.reviewHash, approved.revision);
  assert.equal(cancelled.status, 'CANCELLED'); assert.equal(cancelled.nextAction, 1);
  assert.deepEqual(cancelled.submissions, [{ actionId: 'relay-usdc-approve', hash: tx }]); assert.equal(releaseCalls, 1);
});
test('missing or negative release proof, changed approval, and any claimed deposit preserve reservation', async () => {
  for (const variant of ['absent', 'negative', 'wrong-spender', 'native-value', 'infinite', 'claimed-deposit']) {
    const f = usdcApprovalSetup();
    const transaction = (f.plan.actions[0]!.payload as any).transaction;
    if (variant === 'wrong-spender') transaction.data = transaction.data.replace('4cd00e387622c35bddb9b4c962c136462338bc31', '11'.repeat(20));
    if (variant === 'native-value') transaction.value = '0x1';
    if (variant === 'infinite') transaction.data = transaction.data.slice(0, -64) + 'f'.repeat(64);
    if (variant !== 'absent') f.verifier.release = async () => ({ ready: variant !== 'negative' });
    const review = await f.coordinator.prepare('p1', 'owner', f.request, f.candidate);
    await f.coordinator.claim('p1', 'owner', review.reviewHash, 0); await f.coordinator.submitted('p1', 'owner', tx);
    let approved = await f.coordinator.confirmed('p1', 'owner');
    if (variant === 'claimed-deposit') approved = (await f.coordinator.claim('p1', 'owner', approved.reviewHash, approved.revision)).record;
    await assert.rejects(f.coordinator.cancel('p1', 'owner', approved.reviewHash, approved.revision), /CANCEL_BLOCKED/);
    assert.equal((await f.store.get('p1'))?.status, approved.status);
  }
});
test('approval release cannot race a deposit claim and discard its reservation', async () => {
  const f = usdcApprovalSetup(); let release!: () => void, entered!: () => void;
  const began = new Promise<void>(resolve => { entered = resolve; });
  f.verifier.release = async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); return { ready: true }; };
  const review = await f.coordinator.prepare('p1', 'owner', f.request, f.candidate);
  await f.coordinator.claim('p1', 'owner', review.reviewHash, 0); await f.coordinator.submitted('p1', 'owner', tx);
  const approved = await f.coordinator.confirmed('p1', 'owner');
  const cancel = f.coordinator.cancel('p1', 'owner', approved.reviewHash, approved.revision);
  await began; await f.coordinator.claim('p1', 'owner', approved.reviewHash, approved.revision); release();
  await assert.rejects(cancel, /EXECUTION_CONFLICT/);
  assert.equal((await f.store.get('p1'))?.claimedActionId, 'relay-usdc-deposit');
});
test('recipient/asset/amount/minimum/gas mutations from local recipe fail before journal creation', async () => {
  for (const mutate of [(p: any) => p.recipient = 'other', (p: any) => p.minimumOutRaw = '994',
    (p: any) => p.source.decimals = 6, (p: any) => p.amountRaw = '1001',
    (p: any) => p.nativeCosts[0].amountRaw = '11', (p: any) => p.actions[0].chainId = 'eip155:1']) {
    const f = setup(); mutate(f.plan);
    await assert.rejects(f.coordinator.prepare('p1', 'owner', f.request, f.candidate)); assert.equal(f.store.rows.size, 0);
  }
});
test('prepare uses saved candidate snapshot while recipe awaits', async () => {
  const f = setup(); let done!: () => void;
  const coordinator = new WalletExecutionCoordinator(f.store, [{ id: 'recipe', verify: async () => {
    await new Promise<void>(resolve => { done = resolve; }); return f.plan;
  } }], f.verifier);
  const pending = coordinator.prepare('p1', 'owner', f.request, f.candidate);
  (f.candidate as any).minimumOutputRaw = '999'; (f.candidate as any).id = 'tampered';
  done(); const saved = await pending; assert.equal(saved.plan.routeId, 'route1'); assert.equal(saved.plan.minimumOutRaw, '995');
});
test('fresh per-action preflight blocks stale funds and owner/review/revision mismatches', async () => {
  const f = setup(); const r = await f.coordinator.prepare('p1', 'owner', f.request, f.candidate);
  await assert.rejects(f.coordinator.claim('p1', 'other', r.reviewHash, 0), /NOT_FOUND/);
  await assert.rejects(f.coordinator.claim('p1', 'owner', 'different', 0), /CLAIM_BLOCKED/);
  await assert.rejects(f.coordinator.claim('p1', 'owner', r.reviewHash, 1), /CLAIM_BLOCKED/);
  f.verifier.preflight = async () => ({ ready: false });
  await assert.rejects(f.coordinator.claim('p1', 'owner', r.reviewHash, 0), /FRESH_PREFLIGHT_REQUIRED/);
  assert.equal((await f.store.get('p1'))?.status, 'READY');
});
test('canonical receipt must bind saved transaction and exact destination credit', async () => {
  for (const mutate of [(e: any) => e.transactionHash = 'other', (e: any) => e.routeId = 'other',
    (e: any) => e.destinationCredit.recipient = 'other', (e: any) => e.destinationCredit.amountRaw = '994']) {
    const f = setup(), baseConfirm = f.verifier.confirm;
    f.verifier.confirm = async (...args) => { const evidence = await baseConfirm(...args); mutate(evidence); return evidence; };
    const r = await f.coordinator.prepare('p1', 'owner', f.request, f.candidate);
    await f.coordinator.claim('p1', 'owner', r.reviewHash, 0); await f.coordinator.submitted('p1', 'owner', tx);
    await assert.rejects(f.coordinator.confirmed('p1', 'owner')); assert.equal((await f.store.get('p1'))?.status, 'SUBMITTED');
  }
});
test('conditional quote is never turned into an action and unknown gas requires a real budget', async () => {
  const f = setup();
  await assert.rejects(f.coordinator.prepare('p1', 'owner', f.request, { ...f.candidate, conditional: true }), /NOT_EXECUTABLE/);
  await assert.rejects(f.coordinator.prepare('p1', 'owner', { ...f.request, nativeFeeBudgets: undefined }, f.candidate), /NATIVE_BUDGET_REQUIRED/);
});
test('review digest is order-independent and rejects non-JSON hidden data', async () => {
  assert.equal(await reviewHash({ b: 2, a: 1 }), await reviewHash({ a: 1, b: 2 }));
  assert.notEqual(await reviewHash({ amount: '1' }), await reviewHash({ amount: '2' }));
  for (const input of [{ value: NaN }, { value: undefined }, new Date()]) await assert.rejects(reviewHash(input), /INVALID_REVIEW_PAYLOAD/);
});

test('persisted request supports independent review verification and corrupted recovery fails closed', async () => {
  const f = setup(); const record = await f.coordinator.prepare('p1', 'owner', f.request, f.candidate);
  assert.equal(record.reviewHash, await reviewHash({ request: record.request, plan: record.plan }));
  (f.request as any).amountRaw = '123';
  assert.equal(record.request.amountRaw, '1000');
  const saved = f.store.rows.get('p1')!;
  f.store.rows.set('p1', { ...saved, request: { ...saved.request, recipient: 'other' } });
  await assert.rejects(f.coordinator.claim('p1', 'owner', record.reviewHash, 0), /EXECUTION_REVIEW_CORRUPTED/);
  assert.equal(f.store.rows.get('p1')?.status, 'READY');
});

test('verified plans cannot outlive firm pricing or omit action-chain gas evidence', async () => {
  const f = setup(); (f.candidate.legQuotes[0] as any).pricingValidUntilMs = Date.now() + 1000;
  await assert.rejects(f.coordinator.prepare('p1', 'owner', f.request, f.candidate), /EXECUTION_BINDING_MISMATCH/);
  const missing = setup(); (missing.plan as any).nativeCosts = [];
  await assert.rejects(missing.coordinator.prepare('p1', 'owner', missing.request, missing.candidate), /NATIVE_BUDGET_REQUIRED/);
  const wrong = setup(); (wrong.plan as any).nativeCosts = [{ chainId: 'eip155:1', amountRaw: '0' }];
  await assert.rejects(wrong.coordinator.prepare('p1', 'owner', wrong.request, wrong.candidate), /NATIVE_COST_EVIDENCE_REQUIRED/);
});

test('bounded fixed-term review outlives price observation only with trusted recipe and fresh claim simulation', async t => {
  const f = setup(), start = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now: start });
  (f.candidate.legQuotes[0] as any).pricingValidUntilMs = start + 1000;
  const coordinator = new WalletExecutionCoordinator(f.store,
    [{ id: 'recipe', maxReviewLifetimeMs: 90000, verify: async () => f.plan }], f.verifier);
  const review = await coordinator.prepare('p1', 'owner', f.request, f.candidate);
  assert.equal(review.plan.minimumOutRaw, f.candidate.minimumOutputRaw);
  t.mock.timers.tick(1500);
  f.verifier.preflight = async () => ({ ready: false });
  await assert.rejects(coordinator.claim('p1', 'owner', review.reviewHash, 0), /FRESH_PREFLIGHT_REQUIRED/);
  assert.equal((await f.store.get('p1'))?.status, 'READY');
  f.verifier.preflight = async () => ({ ready: true });
  assert.equal((await coordinator.claim('p1', 'owner', review.reviewHash, 0)).action.payload.amountRaw, '1000');
});

test('fixed-term recipe cannot revive expired pricing or opt into unbounded review time', async t => {
  const f = setup(), start = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now: start });
  for (const maxReviewLifetimeMs of [0, -1, 90001, NaN]) assert.throws(() => new WalletExecutionCoordinator(f.store,
    [{ id: 'recipe', maxReviewLifetimeMs, verify: async () => f.plan }], f.verifier), /INVALID_EXECUTION_RECIPE/);
  (f.candidate.legQuotes[0] as any).pricingValidUntilMs = start + 1000;
  const coordinator = new WalletExecutionCoordinator(f.store,
    [{ id: 'recipe', maxReviewLifetimeMs: 90000, verify: async () => { t.mock.timers.tick(1000); return f.plan; } }], f.verifier);
  await assert.rejects(coordinator.prepare('p1', 'owner', f.request, f.candidate), /EXECUTION_PRICING_EXPIRED/);
  assert.equal(f.store.rows.size, 0);
});

test('cancel and expiry release only untouched READY reviews and never an uncertain wallet action', async t => {
  const f = setup(), review = await f.coordinator.prepare('p1', 'owner', f.request, f.candidate);
  await assert.rejects(f.coordinator.cancel('p1', 'other', review.reviewHash, 0), /NOT_FOUND/);
  await assert.rejects(f.coordinator.cancel('p1', 'owner', 'wrong', 0), /CANCEL_BLOCKED/);
  await assert.rejects(f.coordinator.expire('p1', 'owner'), /EXPIRY_BLOCKED/);
  assert.equal((await f.coordinator.cancel('p1', 'owner', review.reviewHash, 0)).status, 'CANCELLED');
  await assert.rejects(f.coordinator.claim('p1', 'owner', review.reviewHash, 1), /CLAIM_BLOCKED/);
  const other = setup(), claimed = await other.coordinator.prepare('p2', 'owner', other.request, other.candidate);
  await other.coordinator.claim('p2', 'owner', claimed.reviewHash, 0);
  await assert.rejects(other.coordinator.cancel('p2', 'owner', claimed.reviewHash, 1), /CANCEL_BLOCKED/);
  await other.coordinator.signingUncertain('p2', 'owner');
  const expiring = setup(); await expiring.coordinator.prepare('p3', 'owner', expiring.request, expiring.candidate);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() }); t.mock.timers.tick(65000);
  assert.equal((await expiring.coordinator.expire('p3', 'owner')).status, 'EXPIRED');
  await assert.rejects(other.coordinator.expire('p2', 'owner'), /EXPIRY_BLOCKED/);
});

test('canonical receipt and first observation times survive retries without inventing broadcast timing', async t => {
  const f = setup(), start = Date.now(), original = f.verifier.confirm;
  t.mock.timers.enable({ apis: ['Date'], now: start });
  f.verifier.confirm = async (...args) => {
    const evidence = await original(...args);
    return { ...evidence, receipt: { chainId: f.plan.source.chainId, transactionHash: tx, blockNumberRaw: '123',
      blockHash: '0x' + 'b2'.repeat(32), observedAtMs: Date.now(), confirmations: 12, actualNativeFeeRaw: '4',
      destinationCredit: evidence.destinationCredit } };
  };
  const prepared = await f.coordinator.prepare('p1', 'owner', f.request, f.candidate);
  assert.deepEqual(prepared.timeline, { preparedAtMs: start });
  t.mock.timers.tick(1000);
  await f.coordinator.claim('p1', 'owner', prepared.reviewHash, 0);
  t.mock.timers.tick(2000);
  const submitted = await f.coordinator.submitted('p1', 'owner', tx);
  t.mock.timers.tick(3000);
  assert.equal((await f.coordinator.submitted('p1', 'owner', tx)).revision, submitted.revision);
  const complete = await f.coordinator.confirmed('p1', 'owner');
  assert.deepEqual(complete.timeline, { preparedAtMs: start, claimedAtMs: start + 1000, submittedAtMs: start + 3000,
    completedAtMs: start + 6000 });
  assert.equal(complete.receipt?.actualNativeFeeRaw, '4');
  assert.equal(complete.receipt?.transactionHash, tx);
  assert.equal(complete.receipt?.destinationCredit?.amountRaw, '995');
  assert.equal((await f.store.get('p1'))?.receipt?.blockNumberRaw, '123');
});

test('unproven failure keeps reservation while an exact canonical revert becomes FAILED', async () => {
  for (const confirmedFailure of [false, true]) {
    const f = setup();
    f.verifier.confirm = async (plan, action, hash) => ({ success: false, routeId: plan.routeId,
      actionId: action.id, transactionHash: hash, confirmedFailure,
      ...(confirmedFailure ? { receipt: { chainId: action.chainId, transactionHash: hash, blockNumberRaw: '123',
        blockHash: '0x' + 'b2'.repeat(32), observedAtMs: Date.now(), confirmations: 12, actualNativeFeeRaw: '3' } } : {}) });
    const r = await f.coordinator.prepare('p1', 'owner', f.request, f.candidate);
    await f.coordinator.claim('p1', 'owner', r.reviewHash, 0);
    await f.coordinator.submitted('p1', 'owner', tx);
    const result = await f.coordinator.confirmed('p1', 'owner');
    assert.equal(result.status, confirmedFailure ? 'FAILED' : 'RECOVERY_REQUIRED');
    assert.equal(result.claimedActionId, 'deposit');
    assert.deepEqual(result.submissions, [{ actionId: 'deposit', hash: tx }]);
    assert.equal(result.timeline?.failedAtMs !== undefined, confirmedFailure);
  }
});

test('malformed or unrelated failure receipts never release the pending trade', async () => {
  for (const mutate of [(e: any) => delete e.receipt, (e: any) => e.receipt.chainId = 'eip155:1',
    (e: any) => e.receipt.transactionHash = '0x' + 'c3'.repeat(32), (e: any) => e.receipt.confirmations = 0,
    (e: any) => e.receipt.observedAtMs = Date.now() + 10000, (e: any) => e.receipt.actualNativeFeeRaw = '-1',
    (e: any) => e.destinationCredit = { asset: {}, amountRaw: '1' }, (e: any) => e.success = true]) {
    const f = setup();
    f.verifier.confirm = async (plan, action, hash) => {
      const evidence: any = { success: false, confirmedFailure: true, routeId: plan.routeId, actionId: action.id,
        transactionHash: hash, receipt: { chainId: action.chainId, transactionHash: hash, blockNumberRaw: '123',
          blockHash: '0x' + 'b2'.repeat(32), observedAtMs: Date.now(), confirmations: 12 } };
      mutate(evidence); return evidence;
    };
    const r = await f.coordinator.prepare('p1', 'owner', f.request, f.candidate);
    await f.coordinator.claim('p1', 'owner', r.reviewHash, 0); await f.coordinator.submitted('p1', 'owner', tx);
    await assert.rejects(f.coordinator.confirmed('p1', 'owner'));
    assert.equal((await f.store.get('p1'))?.status, 'SUBMITTED');
  }
});

function crossFixture() {
  const f = setup();
  const destination = {chainId:'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',address:'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',decimals:6};
  const recipient = '47YyVUMwerrz76mCrpgFP3iDva1Vt4ZxpSuxo6AhwabT', requestId = '0x'+'ab'.repeat(32);
  for (const row of [f.request,f.plan,f.candidate,f.candidate.path,f.candidate.path.legs[0],f.candidate.legQuotes[0]] as any[]) row.destination=destination;
  (f.request as any).recipient=recipient; (f.plan as any).recipient=recipient;
  (f.plan as any).quoteIds=['relay:'+requestId]; (f.candidate.legQuotes[0] as any).quoteId='relay:'+requestId;
  const encode = (length:number) => { let number=BigInt('0x'+'ab'.repeat(length)), text=''; const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    while(number) { text=alphabet[Number(number%58n)]+text; number/=58n; } return text; };
  f.verifier.confirm=async(plan,action,hash)=>({success:true,routeId:plan.routeId,actionId:action.id,transactionHash:hash,
    receipt:{chainId:plan.source.chainId,transactionHash:hash,blockNumberRaw:'100',blockHash:'0x'+'ef'.repeat(32),observedAtMs:Date.now(),confirmations:12},
    destinationCredit:{asset:destination,recipient,amountRaw:'995'},destinationReceipt:{chainId:destination.chainId,transactionHash:encode(64),
      blockNumberRaw:'200',blockHash:encode(32),observedAtMs:Date.now(),commitment:'finalized',destinationCredit:{asset:destination,recipient,amountRaw:'995'},
      attribution:{provider:'relay',requestId,sourceTransactionHash:hash}}});
  return f;
}
test('cross-chain completion requires finalized destination proof tied to source and reviewed order', async()=>{
  const f=crossFixture(), ready=await f.coordinator.prepare('cross','owner',f.request,f.candidate);
  await f.coordinator.claim('cross','owner',ready.reviewHash,0); await f.coordinator.submitted('cross','owner',tx);
  const completed=await f.coordinator.confirmed('cross','owner');
  assert.equal(completed.status,'COMPLETE'); assert.equal(completed.receipt?.destinationCredit,undefined);
  assert.equal(completed.destinationReceipt?.destinationCredit.recipient,f.plan.recipient);
  assert.equal(completed.destinationReceipt?.attribution.sourceTransactionHash,tx);
});
test('source-only and unrelated Solana proofs never complete or release a cross-chain execution',async()=>{
  const changes=[(e:any)=>delete e.destinationReceipt,(e:any)=>delete e.receipt,
    (e:any)=>e.receipt.destinationCredit=e.destinationCredit,(e:any)=>e.destinationReceipt.commitment='confirmed',
    (e:any)=>e.destinationReceipt.attribution.requestId='0x'+'12'.repeat(32),
    (e:any)=>e.destinationReceipt.attribution.sourceTransactionHash='0x'+'12'.repeat(32),
    (e:any)=>e.destinationReceipt.destinationCredit.recipient='other',(e:any)=>e.destinationReceipt.destinationCredit.amountRaw='994',
    (e:any)=>e.destinationReceipt.transactionHash='1'.repeat(64),(e:any)=>e.destinationReceipt.blockHash='z'.repeat(44),
    (e:any)=>e.destinationReceipt.observedAtMs=Date.now()+10000];
  for(const mutate of changes){
    const f=crossFixture(), original=f.verifier.confirm;
    f.verifier.confirm=async(...args)=>{const result=await original(...args);mutate(result);return result;};
    const ready=await f.coordinator.prepare('cross','owner',f.request,f.candidate);
    await f.coordinator.claim('cross','owner',ready.reviewHash,0); await f.coordinator.submitted('cross','owner',tx);
    await assert.rejects(f.coordinator.confirmed('cross','owner'));
    assert.equal((await f.store.get('cross'))?.status,'SUBMITTED');
  }
});
