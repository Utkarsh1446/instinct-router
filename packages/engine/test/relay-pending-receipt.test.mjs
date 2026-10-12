/** Offline mined-receipt/pending-transaction RPC snapshot regressions. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRelayBaseSolExecution,SOLANA_USDC} from '../src/relay-base-sol-execution.mjs';
import {relayPrepared} from './fixtures/relay-execution.mjs';
import {TXHASH} from './fixtures/base-execution.mjs';

async function snapshotFixture(sourceUsdc){
 const x=await relayPrepared({sourceUsdc,allowance:'100000'});
 let alter=tx=>tx;
 // relayPrepared restores its transaction archive after the base fixture's
 // mutation hook, so transaction snapshots must be adjusted at the wire edge.
 const wire=async(url,init)=>{
  const response=await x.wire(url,init);
  if(url.startsWith('https://api.relay.link'))return response;
  const calls=JSON.parse(init.body),rows=await response.json();
  for(const row of rows)if(calls.find(c=>c.id===row.id)?.method==='eth_getTransactionByHash')row.result=alter(row.result);
  return new Response(JSON.stringify(rows));
 };
 const engine=createRelayBaseSolExecution({fetch:wire,now:x.f.now,pins:x.pins,basePins:x.basePins,
  destinationVerifier:{confirm:async(_plan,_hash,signature)=>({
   destinationCredit:{asset:SOLANA_USDC,recipient:x.plan.recipient,amountRaw:'99500'},
   destinationReceipt:{transactionHash:signature,commitment:'finalized'},
  })},
 });
 return {...x,engine,alter:fn=>{alter=fn;}};
}
const pendingTx=tx=>({...tx,blockHash:null,blockNumber:null,transactionIndex:null});

for(const sourceUsdc of [false,true]){
 const label=sourceUsdc?'USDC':'native ETH';
 test(`${label}: mined receipt with pending transaction stays retryable and later completes`,async()=>{
  const x=await snapshotFixture(sourceUsdc),before=x.calls.length;
  x.alter(pendingTx);
  await assert.rejects(x.engine.confirm(x.plan,x.action,TXHASH),e=>e.code==='RECEIPT_PENDING'&&e.status===202);
  x.alter(tx=>tx);
  const result=await x.engine.confirm(x.plan,x.action,TXHASH);
  assert.equal(result.success,true);
  assert.equal(result.transactionHash,TXHASH);
  assert.ok(x.calls.slice(before).every(c=>! /send|sign|broadcast/i.test(c.method)));
 });

 test(`${label}: pending placement never masks immutable transaction mismatch`,async()=>{
  for(const mutate of [tx=>({...tx,input:'0x1234'}),tx=>({...tx,value:'0x1'}),tx=>({...tx,hash:'0x'+'99'.repeat(32)})]){
   const x=await snapshotFixture(sourceUsdc);
   x.alter(tx=>pendingTx(mutate(tx)));
   await assert.rejects(x.engine.confirm(x.plan,x.action,TXHASH),e=>e.code==='EXECUTION_RECEIPT_BINDING_MISMATCH');
  }
 });

 test(`${label}: populated conflicting block placement still rejects`,async()=>{
  for(const mutate of [tx=>({...tx,blockHash:'0x'+'99'.repeat(32)}),tx=>({...tx,blockNumber:'0x1235'})]){
   const x=await snapshotFixture(sourceUsdc);x.alter(mutate);
   await assert.rejects(x.engine.confirm(x.plan,x.action,TXHASH),e=>e.code==='EXECUTION_RECEIPT_BINDING_MISMATCH');
  }
 });

 test(`${label}: absent placement fields are not treated as an explicit pending snapshot`,async()=>{
  const x=await snapshotFixture(sourceUsdc);
  x.alter(tx=>{const copy={...tx};delete copy.blockHash;delete copy.blockNumber;delete copy.transactionIndex;return copy;});
  await assert.rejects(x.engine.confirm(x.plan,x.action,TXHASH),e=>e.code==='EXECUTION_RECEIPT_BINDING_MISMATCH');
 });

 test(`${label}: head behind mined receipt stays pending until a fresh snapshot catches up`,async()=>{
  const x=await snapshotFixture(sourceUsdc);
  x.f.mutate((rows,calls)=>rows.map((row,i)=>calls[i].method==='eth_blockNumber'?{...row,result:'0x1233'}:row));
  await assert.rejects(x.engine.confirm(x.plan,x.action,TXHASH),e=>e.code==='RECEIPT_PENDING'&&e.status===202);
  x.f.mutate(rows=>rows);
  assert.equal((await x.engine.confirm(x.plan,x.action,TXHASH)).success,true);
 });
}
