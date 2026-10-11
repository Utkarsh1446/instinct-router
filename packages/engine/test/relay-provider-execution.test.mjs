/** Offline public structural fixtures; no wallet or live API. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRelayProviderExecution} from '../src/relay-provider-execution.mjs';
import {createProviderTransport} from '../src/relay-provider-transport.mjs';
import {canonical,sha,word} from '../src/relay-provider-terms.mjs';
import {fixture,OWNER,ROUTER,TOKEN,ZERO,HASH} from './fixtures/relay-provider.mjs';
test('provider-managed EVM same/cross-chain exact immutable actions and fresh claim use one RFQ',async()=>{
 for(const cross of [false,true]){const f=fixture({cross}),q=await f.engine.prepare(f.request),a=q.plan.actions[0];
  assert.equal(a.payload.type,'PROVIDER_REVIEWED_TRANSACTION');assert.equal(q.plan.providerRoute.mode,'PROVIDER_MANAGED');assert.equal(a.payload.spending.nativeValueRaw,f.request.amountRaw);
  assert.equal(a.payload.rfq.commitmentHash,sha(f.raw));assert.equal((await f.engine.preflight(q.plan,a)).ready,true);assert.equal(f.rfqs(),1);assert.equal(f.inspections(),2);
  assert.ok(f.calls.some(c=>c.method==='eth_call'&&c.params[1]?.requireCanonical));
  assert.equal((await f.engine.confirm(q.plan,a,HASH)).success,true);
 }
});
test('finite exact approval precedes funding; no fictional deposit simulation before actual allowance',async()=>{
 const f=fixture({token:true,approval:true}),q=await f.engine.prepare(f.request),[a,d]=q.plan.actions;
 assert.deepEqual(q.plan.actions.map(a=>a.id),['relay-provider-approve','relay-provider-deposit']);
 assert.equal(a.payload.transaction.data,'0x095ea7b3'+word(ROUTER)+word(f.request.amountRaw));
 assert.equal(d.payload.validation.simulationVerified,false);
 assert.equal(f.calls.filter(c=>c.method==='eth_call'&&c.params[0].data==='0x12345678').length,0);
 assert.equal(q.plan.actions.reduce((n,a)=>n+BigInt(a.payload.spending.nativeFeeCapRaw),0n).toString(),q.plan.nativeCosts[0].amountRaw);
 await assert.rejects(f.engine.preflight(q.plan,d),e=>e.code==='EXECUTION_APPROVAL_REQUIRED');
 f.allowance(100000n);assert.equal((await f.engine.preflight(q.plan,d)).ready,true);assert.equal(f.rfqs(),1);
});
test('legacy and OP fee modes are explicit and reserve all observed components',async()=>{
 const standard=fixture(),base=await standard.engine.prepare(standard.request);
 const op=fixture({op:true}),rollup=await op.engine.prepare(op.request);
 assert.ok(BigInt(rollup.plan.nativeCosts[0].amountRaw)>BigInt(base.plan.nativeCosts[0].amountRaw));
 const legacy=fixture({legacy:true}),q=await legacy.engine.prepare(legacy.request);
 assert.equal(q.plan.actions[0].payload.transaction.type,'0x0');assert.ok(q.plan.actions[0].payload.transaction.gasPrice);assert.equal((await legacy.engine.preflight(q.plan,q.plan.actions[0])).ready,true);
});
test('untrusted targets, signature steps, deposit addresses and changed RFQ economics fail closed',async()=>{
 for(const mutate of [f=>f.raw.steps[0].items[0].data.to=TOKEN,f=>f.raw.steps[0].kind='signature',f=>f.raw.steps[0].depositAddress=ROUTER,f=>f.raw.details.currencyOut.currency.address=ZERO,f=>f.raw.details.currencyOut.minimumAmount='99499',f=>f.raw.fees.gas.currency.address=TOKEN,f=>f.raw.steps[0].items[0].data.value='1']){
  const f=fixture();mutate(f);await assert.rejects(f.engine.prepare(f.request));
 }
});
test('preflight rejects altered payload/metadata, upgraded code, expiration, real revert and insufficient balance',async()=>{
 for(const mutate of [q=>q.plan.actions[0].payload.transaction.data='0x1234',q=>q.plan.actions[0].payload.spending.amountRaw='1',q=>q.plan.actions[0].payload.rfq.requestId='other',q=>q.plan.providerRoute.quoteHash='0'.repeat(64)]){
  const f=fixture(),q=await f.engine.prepare(f.request);mutate(q);await assert.rejects(f.engine.preflight(q.plan,q.plan.actions[0]));
 }
 for(const change of [f=>f.code('0x60016001'),f=>f.advance(60001),f=>f.failSim(),f=>f.balance(0n),f=>f.reorg()]){
  const f=fixture(),q=await f.engine.prepare(f.request);change(f);await assert.rejects(f.engine.preflight(q.plan,q.plan.actions[0]));assert.equal(f.rfqs(),1);
 }
});
test('approval-only release uses fresh canonical receipt, permits expired review, refuses funding claims',async()=>{
 const f=fixture({token:true,approval:true}),q=await f.engine.prepare(f.request),record={plan:q.plan,nextAction:1,claimedActionId:null,submissions:[{actionId:'relay-provider-approve',hash:HASH}]};
 f.advance(61000);assert.equal((await f.engine.release({record})).ready,true);
 assert.equal((await f.engine.release({record:{...record,claimedActionId:'relay-provider-deposit'}})).ready,false);
 f.evidence({success:true,receipt:{},destinationCredit:{}});assert.equal((await f.engine.release({record})).ready,false);
});
test('shared transport retains fetch leases after cancellation and rejects malformed JSON/RPC without echoing',async()=>{
 let active=0;const transport=createProviderTransport(async()=>{active++;return new Promise(()=>{});});
 for(let i=0;i<6;i++){const c=new AbortController(),job=transport.run(s=>transport.read('https://rpc.example/','eth_chainId',[],s),c.signal);await new Promise(r=>setImmediate(r));c.abort();await assert.rejects(job);}
 await assert.rejects(transport.run(s=>transport.read('https://rpc.example/','eth_chainId',[],s)),e=>e.code==='EXECUTION_BUSY');assert.equal(active,6);
 for(const body of ['{"jsonrpc":"2.0","id":1,"result":"0x1","result":"0x2"}', '{"jsonrpc":"2.0","id":999,"result":"0x1"}', '{"jsonrpc":"2.0","id":1,"error":{"message":"private garbage"}}']){
  const t=createProviderTransport(async()=>new Response(body));await assert.rejects(t.run(s=>t.read('https://rpc.example/','eth_chainId',[],s)),e=>!e.message.includes('garbage'));
 }
});

test('existing allowance preserves an independently configured spender different from funding target',async()=>{
 const f=fixture({token:true,approval:true});const spender='0x'+'66'.repeat(20);f.chain.contracts.approvalProxy=spender;
 f.raw.steps[0].items[0].data.data='0x095ea7b3'+word(spender)+word(100000);
 const engine=createRelayProviderExecution({fetch:f.wire,now:f.now,chains:f.chains,receiptVerifier:f.verifier});
 f.allowance(100000n);const q=await engine.prepare(f.request),a=q.plan.actions[0];
 assert.equal(q.plan.actions.length,1);assert.equal(a.payload.validation.spender,spender);
 assert.equal((await engine.preflight(q.plan,a)).ready,true);
 const reads=f.calls.filter(c=>c.method==='eth_call'&&c.params[0].data.startsWith('0xdd62ed3e'));
 assert.ok(reads.length>=2);assert.ok(reads.every(c=>c.params[0].data.endsWith(word(spender))));
});

test('provider full gas estimate is a bound reserve floor, retained at fresh claim without RFQ',async()=>{
 const f=fixture();f.chain.feeModel='PROVIDER_ESTIMATE';f.raw.fees.gas.amount='100000000000000';
 const engine=createRelayProviderExecution({fetch:f.wire,now:f.now,chains:f.chains,receiptVerifier:f.verifier});
 const q=await engine.prepare(f.request),a=q.plan.actions[0];
 assert.equal(a.payload.validation.feeModel,'PROVIDER_ESTIMATE');
 assert.equal(a.payload.validation.evidence.feeTrust,'PROVIDER_FULL_GAS_ESTIMATE');
 assert.equal(a.payload.validation.evidence.providerGasFloorRaw,f.raw.fees.gas.amount);
 assert.ok(BigInt(a.payload.spending.nativeFeeCapRaw)>=BigInt(f.raw.fees.gas.amount));
 assert.equal((await engine.preflight(q.plan,a)).ready,true);assert.equal(f.rfqs(),1);
 const changed=structuredClone(q);changed.plan.actions[0].payload.spending.nativeFeeCapRaw='1';changed.plan.nativeCosts[0].amountRaw='1';
 await assert.rejects(engine.preflight(changed.plan,changed.plan.actions[0]),/GAS_RESERVE_EXCEEDED/);
 const capped=fixture();capped.raw.fees.gas.amount='100000000000000';capped.request.nativeFeeBudgets[0].maxAmountRaw='99999999999999';
 await assert.rejects(capped.engine.prepare(capped.request),/NATIVE_BUDGET_EXCEEDED/);
});
test('known provider quote rejections expose only safe literal error codes',async()=>{
 for(const code of ['AMOUNT_TOO_LOW','malicious-secret']){
  const t=createProviderTransport(async()=>new Response(JSON.stringify({errorCode:code,message:'private-secret'}),{status:400}));
  await assert.rejects(t.run(s=>t.json('https://api.relay.link/quote/v2',{},s)),e=>!e.message.includes('secret')&&(code==='AMOUNT_TOO_LOW'?e.code==='RELAY_AMOUNT_TOO_LOW':true));
 }
});
