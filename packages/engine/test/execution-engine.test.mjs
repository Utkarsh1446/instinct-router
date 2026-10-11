import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionEngine } from '../src/execution-engine.mjs';
import { createBaseExecutionChecks } from '../src/base-execution-checks.mjs';
import { createBaseReceiptVerifier } from '../src/base-execution-receipts.mjs';
import { WalletExecutionCoordinator } from '@instinct/router-core';
import { fixture, input, pins, TXHASH, BLOCKHASH, POOL, abi, OWNER } from './fixtures/base-execution.mjs';
async function prepared() {
  const f = fixture(), engine = createExecutionEngine({ fetch: f.wire, now: f.now, executionPins: pins });
  const result = await engine.prepare(input());
  const plan = await engine.recipes[0].verify(result.request, result.candidate);
  return { f, engine, result, plan, action: plan.actions[0] };
}
test('fresh prepare creates one fixed local wallet action,90s review and server-only issued recipe binding', async () => {
  const { f, engine, result, plan, action } = await prepared();
  assert.equal(engine.capabilities().walletExecution, true); assert.equal(engine.capabilities().supportedRoutes.length, 1);
  assert.equal(result.candidate.executionReady, true); assert.equal(result.candidate.minimumOutputRaw, '99502');
  assert.equal(plan.minimumOutRaw, '99502'); assert.equal(plan.actions.length, 1);
  assert.ok(plan.expiresAtMs - f.now() > 88000); assert.ok(result.candidate.deadlineMs - f.now() <= 10000);
  assert.equal(action.payload.type, 'EVM_TRANSACTION'); assert.equal(action.payload.transaction.chainId, '0x2105');
  assert.ok(action.payload.transaction.data.includes(abi(BigInt(plan.minimumOutRaw)).slice(2)));
  assert.ok(f.batches.flat().every(call => !/send|sign|broadcast/i.test(call.method)));
  await assert.rejects(engine.recipes[0].verify(result.request, result.candidate), /EXECUTION_RECIPE_BINDING_MISMATCH/);
});
test('coordinator can durably review beyond short pricing TTL and fresh claim leaves all terms fixed', async () => {
  const f = fixture(), engine = createExecutionEngine({ fetch: f.wire, now: f.now, executionPins: pins }), issued = await engine.prepare(input());
  let stored;
  const store = { insert: async row => { stored = structuredClone(row); return true; }, get: async () => structuredClone(stored),
    compareAndSwap: async (_id, revision, next) => { if (stored.revision !== revision) return false; stored = structuredClone(next); return true; } };
  const coordinator = new WalletExecutionCoordinator(store, engine.recipes, engine.verifier);
  const record = await coordinator.prepare('trade1', 'app:wallet', issued.request, issued.candidate);
  f.advance(11000);
  const claimed = await coordinator.claim(record.id, record.ownerId, record.reviewHash, record.revision);
  assert.equal(claimed.record.status, 'CLAIMED'); assert.equal(claimed.action.payload.transaction.data, record.plan.actions[0].payload.transaction.data);
  assert.equal(claimed.record.plan.minimumOutRaw, record.plan.minimumOutRaw);
  assert.equal(claimed.record.plan.expiresAtMs, record.plan.expiresAtMs);
});
test('missing pins, unsupported chains/assets, native cap and actual economic budget fail closed', async () => {
  const f = fixture();
  assert.equal(createExecutionEngine({ fetch: f.wire }).capabilities().walletExecution, false);
  await assert.rejects(createExecutionEngine({ fetch: f.wire }).prepare(input()), /EXECUTION_PINS_REQUIRED/);
  const engine = createExecutionEngine({ fetch: f.wire, now: f.now, executionPins: pins });
  for (const patch of [{ destination: { ...input().destination, address: OWNER } }, { nativeFeeBudgets: [] },
    { nativeFeeBudgets: [{ chainId: input().source.chainId, maxAmountRaw: '1' }] }, { maxFeeBps: 1 }, { maxPriceImpactBps: 1 }])
    await assert.rejects(engine.prepare({ ...input(), ...patch }), /UNAVAILABLE|INVALID_EXECUTION_INPUT|BUDGET_EXCEEDED|ECONOMIC_LIMIT/);
});
test('explicit null removes user fee and native presets while keeping finite reviewed costs and safety checks', async () => {
  const f = fixture(), engine = createExecutionEngine({ fetch: f.wire, now: f.now, executionPins: pins });
  const automatic = { ...input(), maxFeeBps: null,
    nativeFeeBudgets: [{ chainId: input().source.chainId, maxAmountRaw: null }] };
  const prepared = await engine.prepare(automatic);
  assert.equal(prepared.request.maxFeeBps, null);
  assert.equal(prepared.request.nativeFeeBudgets[0].maxAmountRaw, null);
  assert.ok(Number.isSafeInteger(prepared.candidate.feeBps));
  const plan = await engine.recipes[0].verify(prepared.request, prepared.candidate);
  assert.ok(BigInt(plan.nativeCosts[0].amountRaw) > 0n);
  assert.equal((await engine.verifier.preflight(plan, plan.actions[0])).ready, true);
  const tiny = await engine.prepare({ ...automatic, amount: '0.0000001' });
  assert.ok(tiny.candidate.feeBps > 10000 && Number.isSafeInteger(tiny.candidate.feeBps));
  assert.ok(BigInt(tiny.candidate.legQuotes[0].nativeCosts[0].amountRaw) > BigInt(tiny.request.amountRaw));
  await assert.rejects(engine.prepare({ ...automatic, maxPriceImpactBps: 0 }), /EXECUTION_ECONOMIC_LIMIT/);
  await assert.rejects(engine.prepare({ ...automatic, nativeFeeBudgets: [{ chainId: 'eip155:1', maxAmountRaw: null }] }),
    /EXECUTION_NATIVE_BUDGET_EXCEEDED/);
  f.mutate((rows, calls) => rows.map((row, index) => calls[index].method === 'eth_getBalance'
    ? { ...row, result: '0x1' } : row));
  await assert.rejects(engine.prepare(automatic), /READINESS_INSUFFICIENT_FUNDS/);
});
test('omitting the fee preference retains its numeric default', async () => {
  const f = fixture(), engine = createExecutionEngine({ fetch: f.wire, now: f.now, executionPins: pins });
  const request = input(); delete request.maxFeeBps;
  await assert.rejects(engine.prepare(request), error => {
    assert.equal(error.code, 'EXECUTION_ECONOMIC_LIMIT');
    assert.equal(error.economicLimits.maxFeeBps, 100); return true;
  });
});
test('malformed route input and proxy pins cannot enable an execution recipe', async () => {
  const f = fixture(), engine = createExecutionEngine({ fetch: f.wire, now: f.now, executionPins: pins });
  for (const patch of [{ source: { ...input().source, address: 7 } }, { routeScope: 'UNREVIEWED' },
    { amount: '0' }, { amount: '0.0000000000000000001' }, { nativeFeeBudgets: [{ chainId: input().source.chainId, maxAmountRaw: '-1' }] }])
    await assert.rejects(engine.prepare({ ...input(), ...patch }));
  await assert.rejects(engine.prepare(input(), null), /INVALID_EXECUTION_INPUT/);
  const incomplete = structuredClone(pins); delete incomplete.base.oracle.implementation;
  assert.equal(createExecutionEngine({ fetch: f.wire, now: f.now, executionPins: incomplete }).capabilities().walletExecution, false);
  await assert.rejects(createExecutionEngine({ fetch: f.wire, now: f.now, executionPins: incomplete }).prepare(input()), /EXECUTION_PINS_REQUIRED/);
});
test('forged, changed or expired issued recipe cannot return wallet payload', async () => {
  const f = fixture(), engine = createExecutionEngine({ fetch: f.wire, now: f.now, executionPins: pins }), result = await engine.prepare(input());
  const changed = structuredClone(result.candidate); changed.minimumOutputRaw = '1';
  await assert.rejects(engine.recipes[0].verify(result.request, changed), /BINDING_MISMATCH/);
  f.advance(11000); await assert.rejects(engine.recipes[0].verify(result.request, result.candidate), /BINDING_MISMATCH/);
});
test('concurrent verification cannot consume the same server-issued recipe twice', async () => {
  const f = fixture(), engine = createExecutionEngine({ fetch: f.wire, now: f.now, executionPins: pins }), result = await engine.prepare(input());
  const attempts = await Promise.allSettled(Array.from({ length: 2 }, () => engine.recipes[0].verify(result.request, result.candidate)));
  assert.equal(attempts.filter(attempt => attempt.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(attempt => attempt.status === 'rejected' && attempt.reason.code === 'EXECUTION_RECIPE_BINDING_MISMATCH').length, 1);
});
test('claim checks the same fixed min/pool/recipient/calldata with actual funds, fees and runtime pins', async () => {
  for (const fault of ['calldata', 'implementation', 'pool', 'funds', 'gas', 'output', 'reorg']) {
    const { f, engine, plan, action } = await prepared();
    if (fault === 'calldata') action.payload.transaction.data += '00';
    f.mutate((rows, calls) => rows.map((row, i) => {
      const call = calls[i], data = call.params[0]?.data;
      if (fault === 'implementation' && call.method === 'eth_getStorageAt') return { ...row, result: abi(2) };
      if (fault === 'pool' && data?.startsWith('0x1698ee82')) return { ...row, result: abi(99) };
      if (fault === 'funds' && call.method === 'eth_getBalance') return { ...row, result: '0x1' };
      if (fault === 'gas' && call.method === 'eth_estimateGas') return { ...row, result: '0x1e8480' };
      if (fault === 'output' && data?.startsWith('0x5ae401dc')) return { ...row, result: abi(32, 2, 64, 128, 32, 1, 0) };
      if (fault === 'reorg' && call.method === 'eth_getBlockByNumber' && call.params[0] === '0x1234') return { ...row, result: { ...row.result, hash: TXHASH } };
      return row;
    }));
    await assert.rejects(engine.verifier.preflight(plan, action), /EXECUTION_/);
  }
});
test('failed evidence exposes only a safe typed diagnostic code, never raw malformed response content', async () => {
  const { f, engine, plan, action } = await prepared();
  f.mutate((rows, calls) => rows.map((row, i) => calls[i].method === 'eth_estimateGas'
    ? { ...row, result: 'secret https://private.invalid/token' } : row));
  await assert.rejects(engine.verifier.preflight(plan, action), error => {
    assert.equal(error.code, 'EXECUTION_EVIDENCE_UNAVAILABLE'); assert.equal(error.evidenceCode, 'READINESS_INVALID_RPC');
    assert.ok(!JSON.stringify(error).includes('private.invalid')); assert.ok(!error.message.includes('secret')); return true;
  });
});
test('canonical confirmed local receipt attributes exact pool credit and complete actual native fees', async () => {
  const { f, engine, plan, action } = await prepared(); f.setTransaction(action.payload.transaction);
  const proof = await engine.verifier.confirm(plan, action, TXHASH);
  assert.equal(proof.success, true); assert.equal(proof.receipt.blockHash, BLOCKHASH); assert.equal(proof.receipt.confirmations, 12);
  assert.equal(proof.destinationCredit.amountRaw, '100003'); assert.equal(proof.receipt.actualNativeFeeRaw, '600000100000');
  assert.equal(proof.evidence.receivedFromReviewedPoolRaw, '100003'); assert.equal(proof.evidence.canonicalRecheck, true);
});
test('pending canonical receipt does not become failure; confirmed revert is explicit without destination credit', async () => {
  for (const fault of ['pending', 'confirmations', 'revert']) {
    const { f, engine, plan, action } = await prepared(); f.setTransaction(action.payload.transaction);
    f.mutate((rows, calls) => rows.map((row, i) => {
      if (calls[i].method === 'eth_getTransactionReceipt') return { ...row, result: fault === 'pending' ? null : { ...row.result, status: fault === 'revert' ? '0x0' : '0x1' } };
      if (fault === 'confirmations' && calls[i].method === 'eth_blockNumber') return { ...row, result: '0x1235' };
      return row;
    }));
    if (fault !== 'revert') await assert.rejects(engine.verifier.confirm(plan, action, TXHASH), error => error.code === 'RECEIPT_PENDING');
    else { const proof = await engine.verifier.confirm(plan, action, TXHASH); assert.equal(proof.confirmedFailure, true); assert.equal(proof.destinationCredit, undefined); }
  }
});
test('mismatched source, missing L1 fee, forged/unrelated/duplicate/underpaid credit and reorg cannot complete', async () => {
  for (const fault of ['source', 'calldata', 'l1', 'credit', 'underpaid', 'duplicate', 'reorg', 'gas', 'fee', 'zeroFee', 'zeroGas']) {
    const { f, engine, plan, action } = await prepared(); f.setTransaction(action.payload.transaction);
    f.mutate((rows, calls) => rows.map((row, i) => {
      const call = calls[i];
      if (call.method === 'eth_getTransactionByHash' && fault === 'source') return { ...row, result: { ...row.result, from: POOL } };
      if (call.method === 'eth_getTransactionByHash' && fault === 'calldata') return { ...row, result: { ...row.result, input: row.result.input + '00' } };
      if (call.method === 'eth_getTransactionByHash' && fault === 'gas') return { ...row, result: { ...row.result, gas: '0x0' } };
      if (call.method === 'eth_getTransactionByHash' && fault === 'fee') return { ...row, result: { ...row.result, maxFeePerGas: '0x1' } };
      if (fault === 'reorg' && call.method === 'eth_getBlockByNumber') return { ...row, result: { ...row.result, hash: TXHASH } };
      if (call.method === 'eth_getTransactionReceipt') {
        const value = structuredClone(row.result);
        if (fault === 'l1') delete value.l1Fee;
        if (fault === 'credit') value.logs[0].topics[1] = '0x' + OWNER.slice(2).padStart(64, '0');
        if (fault === 'underpaid') value.logs[0].data = abi(1);
        if (fault === 'duplicate') value.logs.push(structuredClone(value.logs[0]));
        if (fault === 'zeroFee') value.effectiveGasPrice = '0x0';
        if (fault === 'zeroGas') value.gasUsed = '0x0';
        return { ...row, result: value };
      }
      return row;
    }));
    await assert.rejects(engine.verifier.confirm(plan, action, TXHASH), /EXECUTION_|DESTINATION_CREDIT_REQUIRED|READINESS_/);
  }
});
test('asynchronous caller mutation cannot change preflight or receipt ownership/minimum terms', async () => {
  const { f, plan, action } = await prepared(); f.setTransaction(action.payload.transaction);
  const originalMinimum = plan.minimumOutRaw, originalData = action.payload.transaction.data;
  let mutate = () => {};
  const checks = createBaseExecutionChecks({ now: f.now, pins: pins.base, fetch: async (url, init) => {
    const callback = mutate; mutate = () => {}; callback(); return f.wire(url, init);
  } });
  mutate = () => { plan.minimumOutRaw = '1'; plan.recipient = OWNER; action.payload.transaction.data += '00'; };
  const fresh = await checks.preflight(plan, action);
  assert.equal(fresh.simulatedOutputRaw, '100003');
  plan.minimumOutRaw = originalMinimum; plan.recipient = input().recipient; action.payload.transaction.data = originalData;
  mutate = () => { plan.recipient = OWNER; plan.minimumOutRaw = '1'; action.payload.transaction.data += '00'; };
  const proof = await createBaseReceiptVerifier(checks, { now: f.now }).confirm(plan, action, TXHASH);
  assert.equal(proof.destinationCredit.recipient, input().recipient); assert.equal(proof.destinationCredit.amountRaw, '100003');
});
test('cancelled checks retain capacity until an abort-ignoring transport settles', async () => {
  const { f, plan, action } = await prepared(), held = [];
  let began;
  const started = new Promise(resolve => { began = resolve; });
  const checks = createBaseExecutionChecks({ now: f.now, pins: pins.base, fetch: (url, init) => new Promise(resolve => {
    held.push(() => { resolve(f.wire(url, init)); }); if (held.length === 4) began();
  }) });
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const pending = controllers.map(controller => checks.preflight(plan, action, controller.signal));
  await started; controllers.forEach(controller => controller.abort());
  for (const check of pending) await assert.rejects(check, /EXECUTION_CANCELLED/);
  await assert.rejects(checks.preflight(plan, action), /EXECUTION_BUSY/);
  held.forEach(resolve => resolve()); await new Promise(resolve => setImmediate(resolve));
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(checks.preflight(plan, action, cancelled.signal), /EXECUTION_CANCELLED/);
});
test('receipt and transaction must occupy the exact canonical block index before success or confirmed failure', async () => {
  for (const fault of ['missing', 'mismatch', 'duplicate', 'index', 'txIndex']) {
    const { f, engine, plan, action } = await prepared(); f.setTransaction(action.payload.transaction);
    f.mutate((rows, calls) => rows.map((row, i) => {
      if (calls[i].method === 'eth_getBlockByNumber') {
        const block = structuredClone(row.result);
        if (fault === 'missing') delete block.transactions;
        if (fault === 'mismatch') block.transactions = [BLOCKHASH];
        if (fault === 'duplicate') block.transactions.push(TXHASH);
        return { ...row, result: block };
      }
      if (fault === 'index' && calls[i].method === 'eth_getTransactionReceipt') return { ...row, result: { ...row.result, transactionIndex: '0x1' } };
      if (fault === 'txIndex' && calls[i].method === 'eth_getTransactionByHash') return { ...row, result: { ...row.result, transactionIndex: '0x1' } };
      return row;
    }));
    await assert.rejects(engine.verifier.confirm(plan, action, TXHASH), /EXECUTION_RECEIPT_BINDING_MISMATCH/);
  }
});
