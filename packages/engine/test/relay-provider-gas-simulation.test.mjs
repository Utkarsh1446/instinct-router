/** Offline RPC compatibility regressions; no wallet or live API. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRelayProviderExecution} from '../src/relay-provider-execution.mjs';
import {fixture,HASH} from './fixtures/relay-provider.mjs';

function guardedFixture(options={},override=()=>undefined){
 const f=fixture(options),calls=[];
 const wire=async(url,init)=>{
  const q=JSON.parse(init.body);calls.push(q);
  const replacement=override(q);
  if(replacement!==undefined)return new Response(JSON.stringify({jsonrpc:'2.0',id:q.id,...replacement}));
  // Some RPCs choose an unaffordable block-sized gas limit when gas is omitted.
  if(q.method==='eth_call'&&q.params[0].from&&(!q.params[0].gas||BigInt(q.params[0].gas)>5000000n))
   return new Response(JSON.stringify({jsonrpc:'2.0',id:q.id,error:{code:-32000,message:'insufficient funds for default gas limit'}}));
  return f.wire(url,init);
 };
 return {...f,calls,engine:createRelayProviderExecution({fetch:wire,now:f.now,chains:f.chains,receiptVerifier:f.verifier})};
}

test('prepare and preflight simulate the reviewed bounded transaction with its real fees',async()=>{
 for(const options of [{},{legacy:true},{op:true},{token:true,approval:true}]){
  const f=guardedFixture(options),q=await f.engine.prepare(f.request),a=q.plan.actions[0],tx=a.payload.transaction;
  assert.equal(tx.gas,'0x249f0'); // 150% of the independently estimated 100,000 gas.
  const simulation=f.calls.find(c=>c.method==='eth_call'&&c.params[0].from);
  assert.ok(simulation);
  assert.deepEqual(simulation.params[0],tx);
  assert.deepEqual(simulation.params[1],{blockHash:HASH,requireCanonical:true});
  assert.ok(f.calls.findIndex(c=>c.method==='eth_estimateGas')<f.calls.indexOf(simulation));
  if(options.legacy){assert.equal(tx.gasPrice,'0x1406f40');assert.equal(tx.type,'0x0');}
  else{assert.equal(tx.maxFeePerGas,'0x1406f40');assert.equal(tx.maxPriorityFeePerGas,'0xf4240');assert.equal(tx.type,'0x2');assert.equal(tx.gasPrice,undefined);}
  const before=f.calls.length;
  assert.equal((await f.engine.preflight(q.plan,a)).ready,true);
  const fresh=f.calls.slice(before).find(c=>c.method==='eth_call'&&c.params[0].from);
  assert.deepEqual(fresh.params,simulation.params);
 }
});

test('actual RPC simulation reverts still reject prepare and fresh preflight',async()=>{
 for(const phase of ['prepare','preflight']){
  let revert=false;
  const f=guardedFixture({},q=>revert&&q.method==='eth_call'&&q.params[0].from?{error:{code:3,message:'execution reverted: private detail'}}:undefined);
  let action;
  if(phase==='preflight'){const q=await f.engine.prepare(f.request);action={plan:q.plan,action:q.plan.actions[0]};}
  revert=true;
  await assert.rejects(phase==='prepare'?f.engine.prepare(f.request):f.engine.preflight(action.plan,action.action),e=>e.code==='RELAY_PROVIDER_READ_UNAVAILABLE'&&!e.message.includes('private detail'));
 }
});

test('invalid gas estimates fail before attempting a transaction simulation',async()=>{
 for(const [estimate,code] of [['0x5207','RELAY_PROVIDER_GAS_UNKNOWN'],['0x32dcd6','RELAY_PROVIDER_GAS_UNKNOWN'],['0x0','RELAY_PROVIDER_GAS_UNKNOWN'],['0x01','RELAY_PROVIDER_EVIDENCE_INVALID']]){
  const f=guardedFixture({},q=>q.method==='eth_estimateGas'?{result:estimate}:undefined);
  await assert.rejects(f.engine.prepare(f.request),e=>e.code===code);
  assert.equal(f.calls.filter(c=>c.method==='eth_call'&&c.params[0].from).length,0);
 }
});

test('bounded simulation still rejects a changed canonical block',async()=>{
 const f=guardedFixture();f.reorg();
 await assert.rejects(f.engine.prepare(f.request),e=>e.code==='RELAY_PROVIDER_REORG');
 assert.ok(f.calls.some(c=>c.method==='eth_call'&&c.params[0].from&&c.params[0].gas==='0x249f0'));
});
