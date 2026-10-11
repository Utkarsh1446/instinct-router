import test from "node:test";
import assert from "node:assert/strict";
import { BASE_V3 } from '@instinct/router-core';
import { createBaseExecutionTransport } from '../src/base-execution-transport.mjs';
import { BaseReadinessError } from '../src/base-readiness.mjs';
import {
  fixture,
  pins as basePins,
  OWNER,
  BLOCKHASH,
  TXHASH,
  abi,
} from "./fixtures/base-execution.mjs";
import {
  createRelayBaseSolExecution,
  SOLANA_USDC,
  relayDepositData,
} from "../src/relay-base-sol-execution.mjs";
import {
  relayPrepared,
  relayPins,
  relayRequest,
} from "./fixtures/relay-execution.mjs";
test('preflight settles sibling snapshots before fallback and semantic fee failures win', async () => {
  for (const semantic of [false, true]) {
    const x = await relayPrepared({ sourceUsdc: true });
    const endpoints = ['https://primary.example/', 'https://alternate.example/'];
    const held = []; let entered, alternate = 0, released = false;
    const barrier = new Promise(resolve => { entered = resolve; });
    const transport = createBaseExecutionTransport(async (url, init) => {
      const batch = JSON.parse(init.body);
      if (url === endpoints[1]) { assert.equal(released, true); alternate++; return x.wire(BASE_V3.rpc, init); }
      // Fresh preflight serial 2 is identities and serial 3 is fee reserves.
      if (batch[0].id.startsWith('ready-2-')) return new Response('', { status: 503 });
      if (batch[0].id.startsWith('ready-3-')) return new Promise(resolve => {
        held.push(async () => {
          const response = await x.wire(BASE_V3.rpc, init);
          const rows = await response.json();
          if (semantic) rows.forEach(row => {
            const call = batch.find(call => call.id === row.id);
            if (call.params[0]?.data === '0x960e3a23') row.result = abi(0);
          });
          resolve(new Response(JSON.stringify(rows)));
        });
        if (held.length === 2) entered();
      });
      return x.wire(BASE_V3.rpc, init);
    }, endpoints);
    const bundles = transport.transports.map(fetch => createRelayBaseSolExecution({
      fetch, now: x.f.now, pins: x.pins, basePins: x.basePins,
    }));
    const pending = transport.run((index, signal) => bundles[index].preflight(x.plan, x.action, signal));
    const rejection = semantic ? assert.rejects(pending, /EXECUTION_FEES_UNKNOWN/) : null;
    await barrier; await new Promise(resolve => setImmediate(resolve));
    assert.equal(alternate, 0);
    released = true; await Promise.all(held.map(release => release()));
    if (semantic) { await rejection; assert.equal(alternate, 0); }
    else { assert.equal((await pending).ready, true); assert.ok(alternate > 0); }
  }
});
test('insufficient native input balance fails before deposit simulation and never falls back', async () => {
  const x = await relayPrepared(), before = x.calls.length;
  x.f.mutate((rows, calls) => rows.map((row, index) => calls[index].method === 'eth_getBalance'
    ? { ...row, result: '0x1' } : row));
  let alternate = 0;
  const transport = createBaseExecutionTransport(async (url, init) => {
    if (url === 'https://base.drpc.org/') alternate++;
    return x.wire(BASE_V3.rpc, init);
  }, [BASE_V3.rpc, 'https://base.drpc.org']);
  const bundles = transport.transports.map(fetch => createRelayBaseSolExecution({
    fetch: (url, init) => url === BASE_V3.rpc ? fetch(url, init) : x.wire(url, init),
    now: x.f.now, pins: x.pins, basePins: x.basePins,
  }));
  await assert.rejects(transport.run((index, signal) => bundles[index].prepare(relayRequest(x.f), signal)),
    /EXECUTION_NATIVE_BALANCE_INSUFFICIENT/);
  const observed = x.calls.slice(before);
  assert.ok(observed.some(call => call.method === 'eth_getBalance'));
  assert.ok(observed.every(call => call.method !== 'eth_estimateGas' &&
    !(call.method === 'eth_call' && call.params[0]?.data?.startsWith('0x49290c1c'))));
  assert.equal(alternate, 0);
});
test('Relay execution reports measured fee and impact limits without relaxing them', async () => {
  const x = await relayPrepared({sourceUsdc:true});
  x.setApi(raw => ({...raw, details:{...raw.details,swapImpact:{percent:'0'}}}));
  const request = { ...relayRequest(x.f,{sourceUsdc:true}), maxFeeBps:0 };
  await assert.rejects(x.engine.prepare(request), error => {
    assert.equal(error.code, 'EXECUTION_ECONOMIC_LIMIT');
    assert(error.economicLimits.feeBps > 0); assert.equal(error.economicLimits.maxFeeBps,0);
    assert.equal(error.economicLimits.priceImpactBps,0); return true;
  });
  x.setApi(raw => ({...raw, details:{...raw.details,swapImpact:{percent:'2'}}}));
  await assert.rejects(x.engine.prepare({...request,maxFeeBps:9999,maxPriceImpactBps:0}), error => {
    assert.equal(error.code,'EXECUTION_ECONOMIC_LIMIT'); assert.equal(error.economicLimits.priceImpactBps,200);
    assert.equal(error.economicLimits.maxPriceImpactBps,0); return true;
  });
});
test("source prepare and preflight reconstruct canonical deposit, preserve 60s review and enforce gas funds", async () => {
  const x = await relayPrepared();
  assert.equal(x.plan.expiresAtMs - x.f.now(), 60000);
  assert.equal(x.result.pricingValidUntilMs - x.f.now(), 15000);
  const check = await x.engine.preflight(x.plan, x.action);
  assert.equal(check.ready, true);
  assert.ok(BigInt(check.nativeFeeReserveRaw) > 0n);
  assert.ok(x.calls.every((c) => !/send|sign|broadcast/i.test(c.method)));
  x.f.mutate((rows, calls) =>
    rows.map((r, i) =>
      calls[i].method === "eth_getBalance" ? { ...r, result: "0x1" } : r,
    ),
  );
  await assert.rejects(x.engine.preflight(x.plan, x.action), /EXECUTION_NATIVE_BALANCE_INSUFFICIENT/);
});
test("source exact event plus 12 canonical confirmations permits independent destination verifier", async () => {
  const x = await relayPrepared();
  const evidence = await x.engine.confirm(x.plan, x.action, TXHASH);
  assert.equal(evidence.success, true);
  assert.equal(evidence.receipt.confirmations, 12);
  assert.equal(evidence.destinationCredit.amountRaw, "99500");
  assert.ok(BigInt(evidence.receipt.actualNativeFeeRaw) > 0n);
});
test("missing deposit, wrong order ID and different source transaction cannot complete", async () => {
  for (const mutate of [
    (r) => ({ ...r, logs: [] }),
    (r) => ({
      ...r,
      logs: r.logs.map((l) => ({
        ...l,
        data: abi(BigInt(OWNER), 50000000000000n, 1n),
      })),
    }),
  ]) {
    const x = await relayPrepared();
    x.setReceipt(mutate);
    await assert.rejects(
      x.engine.confirm(x.plan, x.action, TXHASH),
      /DEPOSIT_EVENT_REQUIRED/,
    );
  }
  const x = await relayPrepared();
  x.f.setTransaction({
    ...x.action.payload.transaction,
    data: relayDepositData(OWNER, "0x" + "11".repeat(32)),
  });
  await assert.rejects(
    x.engine.confirm(x.plan, x.action, TXHASH),
    /BINDING_MISMATCH/,
  );
});
test("canonical source revert is terminal; reorg and fewer confirmations stay uncompleted", async () => {
  const x = await relayPrepared();
  x.setReceipt((r) => ({ ...r, status: "0x0", logs: [] }));
  const result = await x.engine.confirm(x.plan, x.action, TXHASH);
  assert.equal(result.confirmedFailure, true);
  assert.equal(result.success, false);
  const y = await relayPrepared();
  y.f.mutate((rows, calls) =>
    rows.map((r, i) =>
      calls[i].method === "eth_blockNumber" ? { ...r, result: "0x123e" } : r,
    ),
  );
  await assert.rejects(
    y.engine.confirm(y.plan, y.action, TXHASH),
    /RECEIPT_PENDING/,
  );
  const z = await relayPrepared();
  z.f.mutate((rows, calls) =>
    rows.map((r, i) =>
      calls[i].method === "eth_getBlockByNumber"
        ? { ...r, result: { ...r.result, hash: "0x" + "99".repeat(32) } }
        : r,
    ),
  );
  await assert.rejects(z.engine.confirm(z.plan, z.action, TXHASH), /REORG/);
});
test("oversized API response is rejected by bounded reader before quote interpretation", async () => {
  const f = fixture(),
    wire = async () => new Response(" ".repeat(262145));
  const engine = createRelayBaseSolExecution({
    fetch: wire,
    now: f.now,
    pins: relayPins,
    basePins: basePins.base,
    destinationVerifier: { confirm() {} },
  });
  await assert.rejects(engine.prepare(relayRequest(f)), /EVIDENCE_UNAVAILABLE/);
});

test('USDC review requires exact approval, reserves both actions, and never simulates an unapproved deposit', async () => {
  const x = await relayPrepared({sourceUsdc:true, allowance:'0'});
  assert.equal(x.plan.expiresAtMs - x.f.now(), 90000);
  assert.deepEqual(x.plan.actions.map(a=>a.id), ['relay-usdc-approve','relay-usdc-deposit']);
  assert.equal(x.plan.actions[1].payload.transaction.gas, '0x493e0');
  assert.equal(x.action.payload.transaction.value, '0x0');
  assert.equal(x.action.payload.relay.orderId, x.plan.actions[1].payload.relay.orderId);
  assert.ok(!x.calls.some(c => ['eth_call','eth_estimateGas'].includes(c.method) && c.params[0].data?.startsWith('0xe8017952')));
  await x.engine.preflight(x.plan,x.action);
  const approval = await x.engine.confirm(x.plan,x.action,TXHASH);
  assert.equal(approval.success,true);
  assert.equal(approval.destinationCredit,undefined);
  await assert.rejects(x.engine.preflight(x.plan,x.plan.actions[1]),/APPROVAL_REQUIRED/);
  x.setAllowance('100000');
  await x.engine.preflight(x.plan,x.plan.actions[1]);
  assert.ok(x.calls.some(c=>c.method==='eth_call' && c.params[0].data?.startsWith('0xe8017952') && c.params.length===2));
  assert.ok(x.calls.some(c=>c.method==='eth_estimateGas' && c.params[0].data?.startsWith('0xe8017952')));
  const depositHash='0x'+'57'.repeat(32);
  x.setTransaction(x.plan.actions[1].payload.transaction,depositHash);
  // Relay API binds original TXHASH; exact source succeeds but destination stays pending.
  await assert.rejects(x.engine.confirm(x.plan,x.plan.actions[1],depositHash),/DESTINATION_RECEIPT_PENDING/);
});
test('existing finite allowance skips approval; exact calldata, allowance, balance and USDC implementation remain bound', async () => {
  const x = await relayPrepared({sourceUsdc:true,allowance:'100000'});
  assert.deepEqual(x.plan.actions.map(a=>a.id),['relay-usdc-deposit']);
  await x.engine.preflight(x.plan,x.action);
  const result=await x.engine.confirm(x.plan,x.action,TXHASH);
  assert.equal(result.success,true);
  x.setTokenBalance('99999');
  await assert.rejects(x.engine.preflight(x.plan,x.action),/TOKEN_BALANCE_INSUFFICIENT/);
  x.setTokenBalance('100000');
  x.f.mutate((rows,calls)=>rows.map((r,i)=>calls[i].method==='eth_getStorageAt' && calls[i].params[0]===x.plan.source.address ? {...r,result:abi(1)} :r));
  await assert.rejects(x.engine.preflight(x.plan,x.action),/CODE_MISMATCH/);
});
test('release only revalidates a confirmed approval prefix and rejects changed spender/amount/event or any deposit claim',async()=>{
  const x=await relayPrepared({sourceUsdc:true});
  const record={plan:x.plan,nextAction:1,claimedActionId:null,submissions:[{actionId:'relay-usdc-approve',hash:TXHASH}]};
  x.f.advance(91000);
  assert.deepEqual(await x.engine.release({record}),{ready:true});
  assert.deepEqual(await x.engine.release({record:{...record,claimedActionId:'relay-usdc-deposit'}}),{ready:false});
  assert.deepEqual(await x.engine.release({record:{...record,submissions:[...record.submissions,{actionId:'relay-usdc-deposit',hash:TXHASH}]}}),{ready:false});
  x.setReceipt(r=>({...r,logs:r.logs.map(l=>({...l,data:abi(100001)}))}));
  await assert.rejects(x.engine.release({record}),/APPROVAL_EVENT_REQUIRED/);
  x.setReceipt(r=>({...r,logs:[]}));
  await assert.rejects(x.engine.confirm(x.plan,x.action,TXHASH),/APPROVAL_EVENT_REQUIRED/);
  const forged=structuredClone(x.plan);
  forged.actions[0].payload.transaction.data='0x095ea7b3'+abi(BigInt(OWNER),(1n<<256n)-1n).slice(2);
  await assert.rejects(x.engine.release({record:{...record,plan:forged}}),/BINDING_MISMATCH/);
});

test('USDC quote binds protocol payment and both refunds, and rejects infinite/provider approval recipes', async()=>{
  const {BASE_V3}=await import('@instinct/router-core');
  const {verifyRelayOrder,relayUsdcApprovalData}=await import('../src/relay-base-sol-execution.mjs');
  const {relayQuote}=await import('./fixtures/relay-execution.mjs');
  const f=fixture(),request=relayRequest(f,{sourceUsdc:true}),raw=relayQuote(f,{sourceUsdc:true});
  assert.ok(verifyRelayOrder(raw,request,relayPins,f.now()).orderId);
  for(const change of [
    q=>{q.protocol.v2.paymentDetails.currency=BASE_V3.native;},
    q=>{q.protocol.v2.orderData.inputs[0].payment.currency=BASE_V3.native;},
    q=>{q.protocol.v2.orderData.inputs[0].refunds[0].currency=BASE_V3.native;},
    q=>{q.details.currencyIn.currency.decimals=18;},
    q=>{q.steps[0].items[0].data.value='100000';},
  ]) {
    const bad=structuredClone(raw);change(bad);
    assert.throws(()=>verifyRelayOrder(bad,request,relayPins,f.now()),/MISMATCH/);
  }
  const approval={id:'approve',kind:'transaction',items:[{status:'incomplete',data:{chainId:8453,from:OWNER,to:BASE_V3.usdc,value:'0',data:relayUsdcApprovalData('100000')}}]};
  raw.steps.unshift(approval);
  assert.ok(verifyRelayOrder(raw,request,relayPins,f.now()).orderId);
  approval.items[0].data.data=relayUsdcApprovalData(((1n<<256n)-1n).toString());
  assert.throws(()=>verifyRelayOrder(raw,request,relayPins,f.now()),/APPROVAL_MISMATCH/);
});

test('reviewed per-action fee reserves prevent approval and deposit from each spending the full combined cap',async()=>{
  const x=await relayPrepared({sourceUsdc:true}), deposit=x.plan.actions[1];
  const approvalCap=BigInt(x.action.payload.nativeFeeCapRaw),depositCap=BigInt(deposit.payload.nativeFeeCapRaw);
  assert.equal(approvalCap+depositCap,BigInt(x.plan.nativeCosts[0].amountRaw));
  x.setReceipt(r=>({...r,l1Fee:'0x'+approvalCap.toString(16)}));
  await assert.rejects(x.engine.confirm(x.plan,x.action,TXHASH),/ACTUAL_FEE_EXCEEDED/);
  x.setReceipt(r=>r);
  x.f.mutate((rows,calls)=>rows.map((r,i)=>calls[i].method==='eth_call' && calls[i].params[0].data.startsWith('0xf1c7a58b')?{...r,result:abi(approvalCap+depositCap)}:r));
  await assert.rejects(x.engine.preflight(x.plan,x.action),/EXECUTION_REVIEW_GAS_RESERVE_EXCEEDED/);
  const bad=structuredClone(x.plan);bad.actions[0].payload.nativeFeeCapRaw=(approvalCap+1n).toString();
  await assert.rejects(x.engine.preflight(bad,bad.actions[0]),/BINDING_MISMATCH/);
});
const fixtureReserve = action => BigInt(action.payload.transaction.gas) * BigInt(action.payload.transaction.maxFeePerGas) + 200000n;
const ceilFee = (n, d) => (n + d - 1n) / d;
const fixtureFeeBps = native => Number(ceilFee((20010000000000000n +
  ceilFee(3000000000000000n * native, 1000000000000n)) * 10000n, 150000000000000000n));
test('fixed review headroom permits a small fresh L1 increase without changing terms or economics', async () => {
  const x = await relayPrepared({ sourceUsdc: true });
  const raw = x.plan.actions.reduce((sum, action) => sum + fixtureReserve(action), 0n);
  const reviewed = BigInt(x.plan.nativeCosts[0].amountRaw);
  assert.equal(reviewed, ceilFee(raw * 125n, 100n));
  assert.equal(x.plan.actions.reduce((sum, action) => sum + BigInt(action.payload.nativeFeeCapRaw), 0n), reviewed);
  assert.equal(x.result.feeBps, fixtureFeeBps(reviewed));
  const original = JSON.stringify(x.plan);
  x.f.mutate((rows, calls) => rows.map((row, index) => calls[index].method === 'eth_call' &&
    calls[index].params[0].data.startsWith('0xf1c7a58b') ? { ...row, result: abi(100001) } : row));
  assert.equal((await x.engine.preflight(x.plan, x.action)).ready, true);
  assert.equal(JSON.stringify(x.plan), original);
  const legacy = structuredClone(x.plan);
  legacy.actions.forEach(action => { action.payload.nativeFeeCapRaw = fixtureReserve(action).toString(); });
  legacy.nativeCosts[0].amountRaw = raw.toString();
  const legacyOriginal = JSON.stringify(legacy);
  await assert.rejects(x.engine.preflight(legacy, legacy.actions[0]), /EXECUTION_REVIEW_GAS_RESERVE_EXCEEDED/);
  assert.equal(JSON.stringify(legacy), legacyOriginal);
});
test('user budget clips proportional headroom exactly and rejects raw fees above budget', async () => {
  const x = await relayPrepared({ sourceUsdc: true });
  const rawApproval = fixtureReserve(x.plan.actions[0]), rawDeposit = fixtureReserve(x.plan.actions[1]);
  const raw = rawApproval + rawDeposit, budget = raw + 11n;
  const request = relayRequest(x.f, { sourceUsdc: true });
  request.nativeFeeBudgets[0].maxAmountRaw = budget.toString();
  const clipped = await x.engine.prepare(request);
  const [approval, deposit] = clipped.plan.actions;
  assert.equal(BigInt(deposit.payload.nativeFeeCapRaw), rawDeposit + 11n * rawDeposit / raw);
  assert.equal(BigInt(approval.payload.nativeFeeCapRaw), budget - BigInt(deposit.payload.nativeFeeCapRaw));
  assert.equal(BigInt(clipped.plan.nativeCosts[0].amountRaw), budget);
  assert.equal(clipped.feeBps, fixtureFeeBps(budget));
  assert.ok(clipped.feeBps <= x.result.feeBps);
  request.nativeFeeBudgets[0].maxAmountRaw = (raw - 1n).toString();
  await assert.rejects(x.engine.prepare(request), /EXECUTION_NATIVE_BUDGET_EXCEEDED/);
});
test('null user ceilings retain measured fees above 10000 bps and finite fixed action reserves', async () => {
  const x = await relayPrepared({ sourceUsdc: true });
  x.setApi(raw => ({ ...raw, details: { ...raw.details,
    currencyIn: { ...raw.details.currencyIn, amountUsd: '0.000001' } } }));
  const request = { ...relayRequest(x.f, { sourceUsdc: true }), maxFeeBps: null,
    nativeFeeBudgets: [{ chainId: BASE_V3.chainId, maxAmountRaw: null }] };
  const prepared = await x.engine.prepare(request);
  const raw = prepared.plan.actions.reduce((sum, action) => sum + fixtureReserve(action), 0n);
  assert.equal(BigInt(prepared.plan.nativeCosts[0].amountRaw), ceilFee(raw * 125n, 100n));
  assert.equal(prepared.plan.actions.reduce((sum, action) => sum + BigInt(action.payload.nativeFeeCapRaw), 0n),
    BigInt(prepared.plan.nativeCosts[0].amountRaw));
  assert.ok(Number.isSafeInteger(prepared.feeBps) && prepared.feeBps > 10000);
  assert.equal((await x.engine.preflight(prepared.plan, prepared.plan.actions[0])).ready, true);
  await assert.rejects(x.engine.prepare({ ...request, maxFeeBps: 10000 }), /EXECUTION_ECONOMIC_LIMIT/);
  await assert.rejects(x.engine.prepare({ ...request, maxPriceImpactBps: 0 }), /EXECUTION_ECONOMIC_LIMIT/);
  await assert.rejects(x.engine.prepare({ ...request, nativeFeeBudgets: [] }), /EXECUTION_NATIVE_BUDGET_EXCEEDED/);
  x.f.mutate((rows, calls) => rows.map((row, index) => calls[index].method === 'eth_call' &&
    calls[index].params[0].data.startsWith('0xf1c7a58b')
    ? { ...row, result: abi(BigInt(prepared.plan.nativeCosts[0].amountRaw)) } : row));
  await assert.rejects(x.engine.preflight(prepared.plan, prepared.plan.actions[0]), /EXECUTION_REVIEW_GAS_RESERVE_EXCEEDED/);
});
test('an action cannot borrow sibling headroom and insufficient wallet gas has its own error', async () => {
  const x = await relayPrepared({ sourceUsdc: true });
  const approval = x.plan.actions[0], cap = BigInt(approval.payload.nativeFeeCapRaw), tx = approval.payload.transaction;
  const l2 = BigInt(tx.gas) * BigInt(tx.maxFeePerGas), l1 = (cap - l2) / 2n + 1n;
  assert.ok(l2 + 2n * l1 + fixtureReserve(x.plan.actions[1]) < BigInt(x.plan.nativeCosts[0].amountRaw));
  const approvalSize = BigInt((tx.data.length - 2) / 2 + 512);
  x.f.mutate((rows, calls) => rows.map((row, index) => calls[index].method === 'eth_call' &&
    calls[index].params[0].data === '0xf1c7a58b' + abi(approvalSize).slice(2) ? { ...row, result: abi(l1) } : row));
  await assert.rejects(x.engine.preflight(x.plan, x.action), /EXECUTION_REVIEW_GAS_RESERVE_EXCEEDED/);
  x.f.mutate((rows, calls) => rows.map((row, index) => calls[index].method === 'eth_getBalance'
    ? { ...row, result: '0x1' } : row));
  await assert.rejects(x.engine.preflight(x.plan, x.action), /EXECUTION_NATIVE_BALANCE_INSUFFICIENT/);
});
test('Relay native gas pricing cannot be valued as USDC or another chain',async()=>{
  for(const mutate of [gas=>{gas.currency.address='0x'+'11'.repeat(20);}, gas=>{gas.currency.decimals=6;},gas=>{gas.currency.chainId=1;}]){
    const x=await relayPrepared({sourceUsdc:true});
    x.setApi(q=>{const bad=structuredClone(q);mutate(bad.fees.gas);return bad;});
    await assert.rejects(x.engine.prepare(relayRequest(x.f,{sourceUsdc:true})),/ECONOMICS_INVALID/);
  }
});
const displayProof = (plan, signature, commitment) => commitment === null ? { pending: true } : {
  success: commitment === 'finalized',
  destinationCredit: { asset: SOLANA_USDC, recipient: plan.recipient, amountRaw: plan.minimumOutRaw },
  destinationReceipt: { chainId: SOLANA_USDC.chainId, transactionHash: signature, commitment },
};
test('deposit progress requires exact source proof and completion still requires both original finality thresholds', async () => {
  for (const confirmations of [1, 12]) for (const commitment of [null, 'confirmed', 'finalized']) {
    const x = await relayPrepared({ sourceUsdc: true, allowance: '100000' });
    x.f.mutate((rows, calls) => rows.map((row, index) => calls[index].method === 'eth_blockNumber'
      ? { ...row, result: '0x' + (0x1234 + confirmations - 1).toString(16) } : row));
    let observations = 0;
    const verifier = createRelayBaseSolExecution({ fetch: x.wire, now: x.f.now, pins: x.pins, basePins: x.basePins,
      destinationVerifier: { confirm: () => assert.fail('observe must avoid a duplicate finalized proof'),
        observe: async (plan, _sourceHash, signature) => { observations++; return displayProof(plan, signature, commitment); } },
    });
    const pending = verifier.confirm(x.plan, x.action, TXHASH);
    if (confirmations === 12 && commitment === 'finalized') assert.equal((await pending).success, true);
    else await assert.rejects(pending, error => {
      assert.equal(error.code, confirmations < 12 ? 'RECEIPT_PENDING' : 'DESTINATION_RECEIPT_PENDING');
      assert.equal(error.progress.stage, commitment ? 'DESTINATION_CONFIRMED' : 'SOURCE_CONFIRMED');
      assert.equal(error.progress.sourceConfirmations, confirmations);
      assert.equal(error.progress.requiredSourceConfirmations, 12);
      assert.equal(error.progress.sourceTransactionHash, TXHASH);
      assert.equal(error.progress.actionId, x.action.id);
      assert.equal(error.progress.destination?.commitment, commitment ?? undefined);
      assert.equal(error.progress.destination?.amountRaw, commitment ? x.plan.minimumOutRaw : undefined);
      return true;
    });
    assert.equal(observations, 1);
  }
});
test('pending, wrong source, and semantic destination failures cannot expose unverified delivery progress', async () => {
  for (const fault of ['pending-source', 'wrong-source', 'wrong-destination']) {
    const x = await relayPrepared({ sourceUsdc: true, allowance: '100000' });
    if (fault === 'pending-source') x.f.mutate((rows, calls) => rows.map((row, index) => calls[index].method === 'eth_blockNumber'
      ? { ...row, result: '0x1233' } : row));
    if (fault === 'wrong-source') x.setReceipt(receipt => ({ ...receipt, logs: [] }));
    const verifier = createRelayBaseSolExecution({ fetch: x.wire, now: x.f.now, pins: x.pins, basePins: x.basePins,
      destinationVerifier: { confirm: () => assert.fail(), observe: async (plan, _sourceHash, signature) => {
        if (fault === 'wrong-destination') throw Object.assign(new Error('DESTINATION_CREDIT_REQUIRED'), { code: 'DESTINATION_CREDIT_REQUIRED' });
        return displayProof(plan, signature, 'confirmed');
      } },
    });
    await assert.rejects(verifier.confirm(x.plan, x.action, TXHASH), error => {
      assert.equal(error.progress, undefined); return true;
    });
  }
});
test('approval keeps twelve confirmations and never starts an independent destination observation', async () => {
  const x = await relayPrepared({ sourceUsdc: true }); let statusReads = 0;
  x.f.mutate((rows, calls) => rows.map((row, index) => calls[index].method === 'eth_blockNumber'
    ? { ...row, result: '0x1234' } : row));
  const verifier = createRelayBaseSolExecution({ fetch: (url, init) => {
    if (url.includes('/intents/status')) statusReads++;
    return x.wire(url, init);
  }, now: x.f.now, pins: x.pins, basePins: x.basePins,
  destinationVerifier: { confirm: () => assert.fail(), observe: () => assert.fail() } });
  await assert.rejects(verifier.confirm(x.plan, x.action, TXHASH), error => error.code === 'RECEIPT_PENDING' && error.progress === undefined);
  assert.equal(statusReads, 0);
});
test('source and destination start concurrently and all destination work settles before source failover eligibility', async () => {
  const x = await relayPrepared({ sourceUsdc: true, allowance: '100000' });
  for (const semantic of [false, true]) {
    let sourceStarted = false, destinationStarted = false, release, finished = false;
    const verifier = createRelayBaseSolExecution({ fetch: (url, init) => {
      if (url === BASE_V3.rpc) {
        const calls = JSON.parse(init.body);
        if (calls.length === 1 && calls[0].method === 'eth_getTransactionReceipt') return x.wire(url, init);
        sourceStarted = true; throw new BaseReadinessError('READINESS_RPC_HISTORY_UNAVAILABLE');
      }
      destinationStarted = true;
      return new Promise(resolve => { release = async () => resolve(await x.wire(url, init)); });
    }, now: x.f.now, pins: x.pins, basePins: x.basePins,
    destinationVerifier: { confirm: () => assert.fail(), observe: async () => {
      if (semantic) throw Object.assign(new Error('invalid proof'), { code: 'DESTINATION_CREDIT_REQUIRED' });
      return { pending: true };
    } } });
    const operation = verifier.confirm(x.plan, x.action, TXHASH);
    operation.then(() => { finished = true; }, () => { finished = true; });
    const rejection = assert.rejects(operation, error => error.code ===
      (semantic ? 'EXECUTION_EVIDENCE_UNAVAILABLE' : 'READINESS_RPC_HISTORY_UNAVAILABLE'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sourceStarted, true); assert.equal(destinationStarted, true); assert.equal(finished, false);
    await release(); await rejection;
  }
});

test('receipt availability failure starts no Relay status or Solana proof work', async () => {
  const x = await relayPrepared({ sourceUsdc: true, allowance: '100000' });
  const methods = [];
  const verifier = createRelayBaseSolExecution({ fetch: (url, init) => {
    assert.equal(url, BASE_V3.rpc);
    const calls = JSON.parse(init.body); methods.push(...calls.map(call => call.method));
    throw new BaseReadinessError('READINESS_RPC_HISTORY_UNAVAILABLE');
  }, now: x.f.now, pins: x.pins, basePins: x.basePins,
  destinationVerifier: { confirm: () => assert.fail(), observe: () => assert.fail() } });
  await assert.rejects(verifier.confirm(x.plan, x.action, TXHASH), { code: 'READINESS_RPC_HISTORY_UNAVAILABLE' });
  assert.deepEqual(methods, ['eth_getTransactionReceipt']);
});

async function cachedVerifierFixture() {
  const x = await relayPrepared({ sourceUsdc: true, allowance: '100000' });
  const batches = [], urls = [];
  let observations = 0, commitment = 'confirmed', transform = rows => rows;
  const make = () => createRelayBaseSolExecution({ fetch: async (url, init) => {
    urls.push(url);
    if (url === BASE_V3.rpc) batches.push(JSON.parse(init.body));
    const response = await x.wire(url, init);
    return url === BASE_V3.rpc ? new Response(JSON.stringify(transform(await response.json(), JSON.parse(init.body)))) : response;
  }, now: x.f.now, pins: x.pins, basePins: x.basePins,
  destinationVerifier: { confirm: () => assert.fail(), observe: async (plan, _hash, signature) => {
    observations++; return displayProof(plan, signature, commitment);
  } } });
  const verifier = make();
  const poll = (plan = x.plan, action = x.action, signal) => assert.rejects(verifier.confirm(plan, action, TXHASH, signal),
    error => error.code === 'DESTINATION_RECEIPT_PENDING' && error.progress.stage === 'DESTINATION_CONFIRMED');
  return { x, batches, urls, verifier, make, poll, observations: () => observations,
    setCommitment: value => { commitment = value; }, setTransform: value => { transform = value; }, clear: () => { batches.length = 0; urls.length = 0; } };
}
test('repeat deposit refresh reuses immutable historical source proof but freshly proves canonical source and destination', async () => {
  const f = await cachedVerifierFixture();
  await f.poll();
  const initialCalls = f.batches.flat().length, initialBatches = f.batches.length;
  assert.ok(f.batches.flat().some(call => call.method === 'eth_getCode'));
  f.clear(); await f.poll();
  assert.equal(f.batches.length, 4);
  assert.equal(f.batches.flat().length, 6);
  assert.equal(f.batches.flat().filter(call => call.method === 'eth_getBlockByNumber').length, 2);
  assert.equal(f.batches.flat().some(call => ['eth_getCode', 'eth_getStorageAt', 'eth_call'].includes(call.method)), false);
  assert.equal(f.urls.some(url => url.includes('/intents/status')), false);
  assert.equal(f.observations(), 2);
  assert.ok(initialCalls > 6); assert.ok(initialBatches > 4);
  f.setCommitment('finalized'); assert.equal((await f.verifier.confirm(f.x.plan, f.x.action, TXHASH)).success, true);
  console.log(`Offline Relay proof calls: first ${initialCalls} RPC calls/${initialBatches} logical batches; repeat 6 RPC calls/4 batches; fresh independent destination observation each time.`);
});
test('cached source evidence fails closed on changed receipt, transaction, canonical membership or chain', async () => {
  for (const fault of ['receipt', 'transaction', 'canonical', 'chain']) {
    const f = await cachedVerifierFixture(); await f.poll();
    if (fault === 'receipt') f.x.setReceipt(receipt => ({ ...receipt, logs: [] }));
    else f.setTransform((rows, calls) => rows.map((row, index) => {
      const method = calls[index].method;
      if (fault === 'transaction' && method === 'eth_getTransactionByHash')
        return { ...row, result: { ...row.result, input: '0x' } };
      if (fault === 'canonical' && method === 'eth_getBlockByNumber')
        return { ...row, result: { ...row.result, transactions: [] } };
      if (fault === 'chain' && method === 'eth_chainId') return { ...row, result: '0x1' };
      return row;
    }));
    await assert.rejects(f.verifier.confirm(f.x.plan, f.x.action, TXHASH), error => {
      assert.equal(error.progress, undefined);
      assert.equal(error.code, { receipt: 'RELAY_DEPOSIT_EVENT_REQUIRED', transaction: 'EXECUTION_RECEIPT_BINDING_MISMATCH',
        canonical: 'EXECUTION_REORG', chain: 'EXECUTION_CHAIN_MISMATCH' }[fault]); return true;
    });
  }
});
test('historical proof caches are review specific, verifier local, expire and never bypass cancellation', async t => {
  const f = await cachedVerifierFixture();
  let clock = 1000; t.mock.method(performance, 'now', () => clock);
  await f.poll(); f.clear();
  await f.poll({ ...f.x.plan, routeId: 'another-reviewed-route' });
  assert.ok(f.batches.flat().some(call => call.method === 'eth_getCode'));
  f.clear(); await assert.rejects(f.make().confirm(f.x.plan, f.x.action, TXHASH), { code: 'DESTINATION_RECEIPT_PENDING' });
  assert.ok(f.batches.flat().some(call => call.method === 'eth_getCode'));
  f.clear(); clock += 60001; await f.poll();
  assert.ok(f.batches.flat().some(call => call.method === 'eth_getCode'));
  f.clear(); const abort = new AbortController(); abort.abort();
  await assert.rejects(f.verifier.confirm(f.x.plan, f.x.action, TXHASH, abort.signal), { code: 'EXECUTION_CANCELLED' });
  assert.equal(f.urls.length, 0);
});
test('cached source proofs still await independent destination validation and preserve semantic failure precedence', async () => {
  const x = await relayPrepared({ sourceUsdc: true, allowance: '100000' });
  let hold = false, release, entered;
  const verifier = createRelayBaseSolExecution({ fetch: x.wire, now: x.f.now, pins: x.pins, basePins: x.basePins,
    destinationVerifier: { confirm: () => assert.fail(), observe: async (plan, _hash, signature) => {
      if (hold) { entered(); await new Promise(resolve => { release = resolve; });
        throw Object.assign(new Error('invalid destination proof'), { code: 'DESTINATION_CREDIT_REQUIRED' }); }
      return displayProof(plan, signature, 'confirmed');
    } } });
  await assert.rejects(verifier.confirm(x.plan, x.action, TXHASH), { code: 'DESTINATION_RECEIPT_PENDING' });
  hold = true; const started = new Promise(resolve => { entered = resolve; });
  let finished = false;
  const operation = verifier.confirm(x.plan, x.action, TXHASH);
  operation.then(() => { finished = true; }, () => { finished = true; });
  const rejection = assert.rejects(operation, error => error.code === 'EXECUTION_EVIDENCE_UNAVAILABLE' && error.progress === undefined);
  await started; await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false); release(); await rejection;
});
test('historical proof cache has a hard entry bound', async () => {
  const f = await cachedVerifierFixture();
  await f.poll();
  for (let index = 0; index < 32; index++) await f.poll({ ...f.x.plan, routeId: 'bounded-review-' + index });
  f.clear(); await f.poll();
  assert.ok(f.batches.flat().some(call => call.method === 'eth_getCode'));
  assert.ok(f.urls.some(url => url.includes('/intents/status')));
});
