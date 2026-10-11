import test from 'node:test';
import assert from 'node:assert/strict';
import { settlementProgress } from '../src/settlement-progress.mjs';
import { createExecutionApi } from '../src/execution-api.mjs';
import { reviewHash } from '@instinct/router-core';
const now = 200000;
const hash = '0x' + 'a1'.repeat(32);
const asset = { chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 };
const signature = '4LobeBPHwLz4nCWse5N8g2kxp97LwTWenFXztFeTH2aiMnkXx3irbwwdF2PPeaUNmnvAhqJqTR1gYHeATRUD7Pnv';
const row = () => ({ status: 'SUBMITTED', nextAction: 0, timeline: { submittedAtMs: now - 1000 },
  plan: { routeId: 'relay:order', source: { chainId: 'eip155:8453' }, destination: asset,
    recipient: '47YyVUMwerrz76mCrpgFP3iDva1Vt4ZxpSuxo6AhwabT', minimumOutRaw: '900000', actions: [{ id: 'relay-usdc-deposit' }] },
  submissions: [{ actionId: 'relay-usdc-deposit', hash }] });
const sourceProgress = () => ({ routeId: 'relay:order', actionId: 'relay-usdc-deposit', sourceTransactionHash: hash,
  stage: 'SOURCE_CONFIRMED', observedAtMs: now, sourceConfirmations: 1, requiredSourceConfirmations: 12 });
const deliveryProgress = () => ({ ...sourceProgress(), stage: 'DESTINATION_CONFIRMED', destination: {
  chainId: asset.chainId, transactionHash: signature, asset, recipient: row().plan.recipient, amountRaw: '999000', commitment: 'confirmed' } });

test('fresh independently verified progress is cloned without changing the pending execution', () => {
  for (const value of [sourceProgress(), deliveryProgress(), { ...deliveryProgress(), sourceConfirmations: 12,
    destination: { ...deliveryProgress().destination, commitment: 'finalized' } }]) {
    const record = row(), original = structuredClone(record), result = settlementProgress(value, record, now);
    assert.deepEqual(result, value); assert.notEqual(result, value); assert.deepEqual(record, original);
    assert.equal(record.status, 'SUBMITTED');
  }
});
test('unbound, stale, unconfirmed or extra progress evidence is omitted rather than claiming delivery', () => {
  const variants = [undefined, null, {}, { ...sourceProgress(), stage: 'COMPLETE' },
    { ...sourceProgress(), routeId: 'relay:other' }, { ...sourceProgress(), sourceTransactionHash: '0x' + 'a2'.repeat(32) },
    { ...sourceProgress(), actionId: 'relay-usdc-approve' }, { ...sourceProgress(), sourceConfirmations: 0 },
    { ...sourceProgress(), requiredSourceConfirmations: 1 }, { ...sourceProgress(), sourceConfirmations: Infinity },
    { ...sourceProgress(), observedAtMs: now + 2001 }, { ...sourceProgress(), observedAtMs: now - 15001 },
    { ...sourceProgress(), observedAtMs: now - 1001 }, { ...sourceProgress(), providerRaw: 'private response' },
    { ...sourceProgress(), destination: deliveryProgress().destination }, { ...deliveryProgress(), destination: undefined }];
  for (const patch of [{ chainId: 'eip155:8453' }, { transactionHash: '1'.repeat(65) }, { recipient: 'wrong' },
    { amountRaw: '899999' }, { amountRaw: '-1' }, { amountRaw: (2n ** 256n).toString() }, { commitment: 'processed' },
    { asset: { ...asset, decimals: 18 } }, { asset: { ...asset, address: 'other' } }, { asset: { ...asset, providerRaw: 'private' } },
    { providerRaw: 'private' }]) variants.push({ ...deliveryProgress(), destination: { ...deliveryProgress().destination, ...patch } });
  for (const value of variants) assert.equal(settlementProgress(value, row(), now), undefined);
});
test('progress cannot decorate approvals, terminal, advanced or unrelated execution records', () => {
  for (const change of [record => { record.status = 'COMPLETE'; }, record => { record.status = 'EXPIRED'; },
    record => { record.status = 'READY'; }, record => { record.nextAction = 1; },
    record => { record.plan.actions[0].id = 'relay-usdc-approve'; }, record => { record.plan.source.chainId = 'eip155:1'; },
    record => { record.plan.routeId = 'other'; }, record => { record.submissions = []; }]) {
    const record = row(); change(record); assert.equal(settlementProgress(deliveryProgress(), record, now), undefined);
  }
});

async function apiFixture(status = 'SUBMITTED') {
  const wallet = { ownerId: 'wallet-owner', chainId: 'eip155:8453', address: '0x' + '12'.repeat(20) };
  const record = { ...row(), id: 'ex_test', ownerId: wallet.ownerId, status, revision: 2,
    request: { source: { chainId: wallet.chainId }, sender: wallet.address },
    timeline: { submittedAtMs: Date.now() - 1000 } };
  record.plan.actions[0] = { id: 'relay-usdc-deposit', chainId: wallet.chainId, payload: { type: 'EVM_TRANSACTION' } };
  record.reviewHash = await reviewHash({ request: record.request, plan: record.plan });
  let confirms = 0, writes = 0;
  const store = { get: async () => structuredClone(record), findActive: async () => structuredClone(record),
    insert: async () => { writes++; return true; }, compareAndSwap: async () => { writes++; return true; } };
  const engine = { prepare: async () => {}, recipes: [], verifier: { confirm: async () => { confirms++;
    throw Object.assign(new Error('private upstream data'), { code: 'DESTINATION_RECEIPT_PENDING',
      progress: { ...deliveryProgress(), observedAtMs: Date.now() } }); } } };
  return { api: createExecutionApi({ engine, store }), wallet, record, counts: () => ({ confirms, writes }) };
}
test('pending refresh returns bound display evidence without journal writes or wallet actions', async () => {
  for (const status of ['SUBMITTED', 'RECOVERY_REQUIRED']) {
    const f = await apiFixture(status), result = await f.api.mutate('ex_test', 'refresh', {}, f.wallet, new AbortController().signal);
    assert.equal(result.receiptStatus, 'PENDING'); assert.equal(result.execution.status, status);
    assert.equal(result.progress.stage, 'DESTINATION_CONFIRMED'); assert.equal(result.progress.destination.amountRaw, '999000');
    assert.equal(result.execution.progress, undefined); assert.deepEqual(f.counts(), { confirms: 1, writes: 0 });
    assert.equal(JSON.stringify(result).includes('private upstream'), false);
  }
});
test('direct terminal refresh is idempotent, authenticates ownership, and performs no RPC or journal mutation', async () => {
  for (const status of ['COMPLETE', 'FAILED', 'EXPIRED']) {
    const f = await apiFixture(status);
    const first = await f.api.mutate('ex_test', 'refresh', {}, f.wallet, new AbortController().signal);
    const again = await f.api.mutate('ex_test', 'refresh', {}, f.wallet, new AbortController().signal);
    assert.deepEqual(again, first); assert.equal(first.progress, undefined); assert.equal(first.execution.status, status);
    await assert.rejects(f.api.mutate('ex_test', 'refresh', {}, { ...f.wallet, ownerId: 'another-owner' }, new AbortController().signal),
      error => error.code === 'EXECUTION_NOT_FOUND');
    assert.deepEqual(f.counts(), { confirms: 0, writes: 0 });
  }
});
