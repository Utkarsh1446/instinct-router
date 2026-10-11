/** Structural, public synthetic evidence only; no live RPC or wallet execution. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import { BASE_V3 } from '@instinct/router-core';
import { fixture, abi, TXHASH, BLOCKHASH, OWNER } from './fixtures/base-execution.mjs';
import { relayPrepared, relayQuote, relayRequest, relayPins } from './fixtures/relay-execution.mjs';
import { createRelayBaseSolExecution, verifyRelayOrderSignature, relayTokenDepositData, RELAY_DEPOSITORY } from '../src/relay-base-sol-execution.mjs';
import { computeRelayOrderId } from '../src/relay-order.mjs';
import { fail } from '../src/base-execution-checks.mjs';
import { tokenIdentity, exactTokenDeposit } from '../src/relay-token-identity.mjs';
const signer=privateKeyToAccount('0x'+'01'.repeat(32)); // Public test vector, never funded.
const TOKEN='0x'+'22'.repeat(20), MINT='So11111111111111111111111111111111111111112';
const SYSTEM='11111111111111111111111111111111';
async function setup({token=false,destination=MINT,inspect=async()=>({ready:true})}={}) {
  const legacy=await relayPrepared(), f=legacy.f, request=relayRequest(f,{sourceUsdc:token});
  request.destination={...request.destination,address:destination,decimals:9};
  if(token)request.source={...request.source,address:TOKEN,decimals:6};
  const raw=relayQuote(f,{sourceUsdc:token}), order=raw.protocol.v2.orderData;
  order.solver=signer.address;order.inputs[0].payment.currency=request.source.address;
  order.inputs[0].refunds[0].currency=request.source.address;
  order.inputs[0].refunds[1].currency=destination;order.output.payments[0].currency=destination;
  raw.protocol.v2.paymentDetails.currency=request.source.address;
  raw.details.currencyIn.currency.address=request.source.address;
  raw.details.currencyOut.currency.address=destination;raw.details.currencyOut.currency.decimals=9;
  raw.protocol.v2.orderId=computeRelayOrderId(order);
  raw.protocol.v2.orderSignature=await signer.signMessage({message:{raw:raw.protocol.v2.orderId}});
  raw.steps[0].items[0].data.data=token?relayTokenDepositData(request.sender,TOKEN,request.amountRaw,raw.protocol.v2.orderId):
    '0x49290c1c'+request.sender.slice(2).padStart(64,'0')+raw.protocol.v2.orderId.slice(2);
  let code='0x'+'60'.repeat(100), allowance=1000000n, rfqs=0;
  const wire=async(url,init)=>{
    if(url.endsWith('/quote/v2')){rfqs++;return new Response(JSON.stringify(raw));}
    if(url.startsWith('https://api.relay.link'))return legacy.wire(url,init);
    const batch=JSON.parse(init.body),custom=batch.filter(c=>c.params[0]===TOKEN||c.params[0]?.to===TOKEN);
    const rest=batch.filter(c=>!custom.includes(c));
    const rows=rest.length?await(await legacy.wire(url,{...init,body:JSON.stringify(rest)})).json():[];
    for(const c of custom){const data=c.params[0]?.data;rows.push({jsonrpc:'2.0',id:c.id,result:c.method==='eth_getCode'?code:
      c.method==='eth_estimateGas'?'0x10000':c.method==='eth_getStorageAt'?abi(0):data==='0x313ce567'?abi(6):data?.startsWith('0x70a08231')?abi(1000000):
      data?.startsWith('0xdd62ed3e')?abi(allowance):data?.startsWith('0x095ea7b3')?abi(1):'0x'});}
    for(const row of rows){
      const call=rest.find(c=>c.id===row.id);
      if(call?.method==='eth_getTransactionReceipt' && row.result?.to===TOKEN){
        row.result.gasUsed='0x10000'; // Approval uses its own reviewed gas limit, not the fixture deposit gas.
        row.result.logs=[{address:TOKEN,removed:false,transactionHash:row.result.transactionHash,blockHash:row.result.blockHash,blockNumber:row.result.blockNumber,
          topics:['0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925',abi(BigInt(request.sender)),abi(BigInt(RELAY_DEPOSITORY))],data:abi(BigInt(request.amountRaw))}];
      }
    }
    return new Response(JSON.stringify(rows));
  };
  const engine=createRelayBaseSolExecution({fetch:wire,now:f.now,pins:{...relayPins,solver:signer.address},basePins:legacy.basePins,
    destinationVerifier:{inspect,confirm:async()=>({})}});
  return {engine,request,raw,f,legacy,rfqs:()=>rfqs,code:value=>code=value,allowance:value=>allowance=value};
}
test('signed native direct output permits classic SPL and SOL, but unsigned expansion is rejected',async()=>{
  for(const destination of [MINT,SYSTEM]){
    const f=await setup({destination}),result=await f.engine.prepare(f.request);
    assert.equal(result.plan.destination.address,destination);
    assert.equal(result.plan.actions[0].id,'relay-native-deposit');
    assert.ok(result.plan.actions[0].payload.relay.orderSignature);
    assert.equal((await f.engine.preflight(result.plan,result.plan.actions[0])).ready,true);
    delete f.raw.protocol.v2.orderSignature;
    await assert.rejects(f.engine.prepare(f.request),e=>e.code==='RELAY_ORDER_SIGNATURE_REQUIRED');
  }
});
test('generic ERC20 uses exact local token ABI and immutable observed identity with fresh code rejection',async()=>{
  const f=await setup({token:true}),result=await f.engine.prepare(f.request),action=result.plan.actions[0];
  assert.equal(action.id,'relay-token-deposit');
  assert.equal(action.payload.transaction.data,relayTokenDepositData(f.request.sender,TOKEN,f.request.amountRaw,action.payload.relay.orderId));
  assert.equal(action.payload.relay.tokenIdentity.address,TOKEN);
  assert.equal((await f.engine.preflight(result.plan,action)).ready,true);
  const reordered=structuredClone(result.plan);
  reordered.actions[0].payload.relay.tokenIdentity=Object.fromEntries(Object.entries(action.payload.relay.tokenIdentity).reverse());
  assert.equal((await f.engine.preflight(reordered,reordered.actions[0])).ready,true);
  const unsigned=structuredClone(result.plan);delete unsigned.actions[0].payload.relay.orderSignature;
  await assert.rejects(f.engine.preflight(unsigned,unsigned.actions[0]),e=>e.code==='RELAY_ORDER_SIGNATURE_REQUIRED');
  f.code('0x'+'61'.repeat(100));
  await assert.rejects(f.engine.preflight(result.plan,action),e=>e.code==='EXECUTION_TOKEN_IDENTITY_CHANGED');
});
test('generic ERC20 missing allowance creates only exact approval then deposit, with finite individual reserves',async()=>{
  const f=await setup({token:true});f.allowance(0n);const {plan}=await f.engine.prepare(f.request);
  assert.deepEqual(plan.actions.map(a=>a.id),['relay-token-approve','relay-token-deposit']);
  assert.equal(plan.actions[0].payload.transaction.to,TOKEN);
  assert.equal(plan.actions[0].payload.transaction.data,'0x095ea7b3'+RELAY_DEPOSITORY.slice(2).padStart(64,'0')+BigInt(f.request.amountRaw).toString(16).padStart(64,'0'));
  assert.equal(plan.actions.reduce((n,a)=>n+BigInt(a.payload.nativeFeeCapRaw),0n),BigInt(plan.nativeCosts[0].amountRaw));
});
test('order signature rejects another solver, changed signed hash and malformed signature',async()=>{
  const f=await setup(),meta=f.raw.protocol.v2;
  await verifyRelayOrderSignature(meta,{solver:signer.address});
  for(const changed of [{...meta,orderId:'0x'+'12'.repeat(32)},{...meta,orderSignature:'0x00'}])
    await assert.rejects(verifyRelayOrderSignature(changed,{solver:signer.address}));
  await assert.rejects(verifyRelayOrderSignature(meta,{solver:OWNER}));
});
test('exact generic receipt token credit rejects taxed, split, or wrong canonical transfers',()=>{
  const word=v=>'0x'+v.slice(2).padStart(64,'0'),receipt={transactionHash:TXHASH,blockHash:BLOCKHASH,blockNumber:'0x1234'};
  const log={address:TOKEN,removed:false,...receipt,topics:['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',word(OWNER),word(RELAY_DEPOSITORY)],data:abi(100)};
  exactTokenDeposit([log],receipt,{address:TOKEN},OWNER,RELAY_DEPOSITORY,'100');
  for(const rows of [[{...log,data:abi(99)}],[log,{...log}],[{...log,blockHash:TXHASH}],[{...log,removed:true}]])
    assert.throws(()=>exactTokenDeposit(rows,receipt,{address:TOKEN},OWNER,RELAY_DEPOSITORY,'100'));
});
test('observed token metadata rejects missing code, wrong decimals and changed implementation',async()=>{
  const source={address:TOKEN,decimals:6},block={blockHash:BLOCKHASH,requireCanonical:true};
  const read=async()=>['0x'+'60'.repeat(100),abi(6),abi(0)];
  const expected=await tokenIdentity(read,source,block);
  await assert.rejects(tokenIdentity(async()=>['0x',abi(6),abi(0)],source,block));
  await assert.rejects(tokenIdentity(async()=>['0x60',abi(7),abi(0)],source,block));
  await assert.rejects(tokenIdentity(read,source,block,undefined,{...expected,codeSha256:'0'.repeat(64)}));
});

test('expanded routes reject destination mutations, callbacks and unapproved token gas before signing',async()=>{
  for(const mutate of [f=>f.raw.protocol.v2.orderData.output.calls.push('0x01'),
    f=>f.raw.details.currencyOut.currency.decimals=6,
    f=>f.raw.steps[0].items[0].data.to=TOKEN,
    f=>f.raw.protocol.v2.orderData.inputs[0].payment.currency=BASE_V3.native]){
    const f=await setup({token:true});mutate(f);await assert.rejects(f.engine.prepare(f.request));
  }
});

test('generic approval-only release verifies exact canonical finite approval, even after review expiry',async()=>{
  const f=await setup({token:true});f.allowance(0n);const {plan}=await f.engine.prepare(f.request);
  f.legacy.setTransaction(plan.actions[0].payload.transaction);
  const record={plan,nextAction:1,claimedActionId:null,submissions:[{actionId:'relay-token-approve',hash:TXHASH}]};
  assert.equal((await f.engine.release({record})).ready,true);
  const expired=structuredClone(record);expired.plan.expiresAtMs=0;
  assert.equal((await f.engine.release({record:expired})).ready,true);
  const forged=structuredClone(record);forged.plan.actions[0].payload.transaction.data='0x095ea7b3'+OWNER.slice(2).padStart(64,'0')+abi(100000).slice(2);
  await assert.rejects(f.engine.release({record:forged}));
  assert.equal((await f.engine.release({record:{...record,claimedActionId:'relay-token-deposit'}})).ready,false);
});

test('unsupported destination mint blocks before RFQ and is freshly inspected before signing',async()=>{
  let blocked=true,checks=0;
  const f=await setup({inspect:async()=>{checks++;if(blocked)fail('DESTINATION_TOKEN_UNSUPPORTED');return {ready:true};}});
  await assert.rejects(f.engine.prepare(f.request),e=>e.code==='DESTINATION_TOKEN_UNSUPPORTED');
  assert.equal(f.rfqs(),0);blocked=false;
  const {plan}=await f.engine.prepare(f.request);assert.equal(f.rfqs(),1);
  blocked=true;await assert.rejects(f.engine.preflight(plan,plan.actions[0]),e=>e.code==='DESTINATION_TOKEN_UNSUPPORTED');
  assert.equal(checks,3);assert.equal(f.rfqs(),1);
});
