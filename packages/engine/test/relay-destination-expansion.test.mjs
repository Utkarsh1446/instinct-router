import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyRelaySolanaDelivery,createRelayDestinationVerifier } from '../src/relay-destination.mjs';
const solver='F7p3dFrjRTbtRp8FRF6qHLomXbKRBzpvBLjtQcfcgmNe',recipient='47YyVUMwerrz76mCrpgFP3iDva1Vt4ZxpSuxo6AhwabT';
const source='Q4UmPB9hKMw3ERqksavS9oEpNo2eWG4ffkWg7wHa9j6',destination='FZeGx9mDteLt17pYM6iYmHBmRVn2joyDeqexC1qSxT54';
const signature='4LobeBPHwLz4nCWse5N8g2kxp97LwTWenFXztFeTH2aiMnkXx3irbwwdF2PPeaUNmnvAhqJqTR1gYHeATRUD7Pnv';
const TOKEN='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',SYSTEM='11111111111111111111111111111111';
const MINT='So11111111111111111111111111111111111111112',MEMO='MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
function fixture(native=false){
 const orderId='0x'+'12'.repeat(32),requestId='0x'+'34'.repeat(32);
 const plan={recipient,minimumOutRaw:'90',destination:{chainId:'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',address:native?SYSTEM:MINT,decimals:9},quoteIds:['relay:'+requestId],actions:[{payload:{relay:{orderId,requestId}}}]};
 const balance=(accountIndex,owner,amount)=>({accountIndex,owner,mint:MINT,programId:TOKEN,uiTokenAmount:{decimals:9,amount}});
 const tx={slot:100,transaction:{signatures:[signature],message:{accountKeys:[{pubkey:solver,signer:true},{pubkey:native?recipient:source,signer:false},{pubkey:destination,signer:false}],instructions:[
 native?{programId:SYSTEM,parsed:{type:'transfer',info:{source:solver,destination:recipient,lamports:100}}}:
 {programId:TOKEN,parsed:{type:'transferChecked',info:{source,destination,authority:solver,mint:MINT,tokenAmount:{decimals:9,amount:'100'}}}},
 {programId:MEMO,parsed:orderId}]}},meta:{err:null,preBalances:[10000,0,0],postBalances:[9900,100,0],preTokenBalances:[balance(1,solver,'1000'),balance(2,recipient,'0')],postTokenBalances:[balance(1,solver,'900'),balance(2,recipient,'100')]}};
 return {plan,tx,status:{err:null,confirmations:null,slot:100,confirmationStatus:'finalized'}};
}
test('custom classic SPL credit binds mint, decimals, solver and net balance',()=>{
 const f=fixture();assert.equal(verifyRelaySolanaDelivery(f.plan,signature,f.tx,f.status,[solver]).amountRaw,'100');
 for(const mutate of [f=>f.tx.meta.postTokenBalances[1].uiTokenAmount.decimals=6,
 f=>f.tx.meta.postTokenBalances[1].programId=SYSTEM,f=>f.tx.transaction.message.instructions[0].parsed.info.mint=recipient,
 f=>f.tx.transaction.message.instructions[0].parsed.info.authority=recipient,f=>f.tx.meta.postTokenBalances[1].uiTokenAmount.amount='89']){
 const bad=fixture();mutate(bad);assert.throws(()=>verifyRelaySolanaDelivery(bad.plan,signature,bad.tx,bad.status,[solver]));}
});
test('native SOL requires exact System transfer from signed solver and actual recipient lamport credit',()=>{
 const f=fixture(true);assert.equal(verifyRelaySolanaDelivery(f.plan,signature,f.tx,f.status,[solver]).amountRaw,'100');
 for(const mutate of [f=>f.plan.destination.decimals=6,f=>f.tx.meta.postBalances[1]=89,
 f=>f.tx.transaction.message.instructions[0].programId=TOKEN,f=>f.tx.transaction.message.instructions[0].parsed.info.source=recipient,
 f=>f.tx.transaction.message.instructions[0].parsed.info.lamports=Number.MAX_SAFE_INTEGER+1,
 f=>f.tx.meta.postBalances[0]=10000,f=>f.tx.transaction.message.instructions[1].parsed='0x'+'00'.repeat(32)]){
 const bad=fixture(true);mutate(bad);assert.throws(()=>verifyRelaySolanaDelivery(bad.plan,signature,bad.tx,bad.status,[solver]));}
});
test('custom mint factory reads classic initialized mint at receipt context and rejects Token2022 or stale context',async()=>{
 for(const invalid of [null,'owner','decimals','slot','initialized']){
 const f=fixture(),calls=[];
 const verifier=createRelayDestinationVerifier({pins:{solanaSolverSigners:[solver]},fetch:async(_url,init)=>{
 const c=JSON.parse(init.body);calls.push(c);let result;
 if(c.method==='getGenesisHash')result='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
 else if(c.method==='getTransaction')result=f.tx;
 else if(c.method==='getSignatureStatuses')result={value:[f.status]};
 else if(c.method==='getBlock')result={blockhash:source,signatures:[signature]};
 else if(c.method==='getAccountInfo')result={context:{slot:invalid==='slot'?99:100},value:{owner:invalid==='owner'?SYSTEM:TOKEN,executable:false,data:{program:'spl-token',parsed:{type:'mint',info:{isInitialized:invalid!=='initialized',decimals:invalid==='decimals'?6:9}}}}};
 else assert.fail(c.method);
 return new Response(JSON.stringify({jsonrpc:'2.0',id:c.id,result}));
 }});
 const work=verifier.confirm(f.plan,'0x'+'11'.repeat(32),signature);
 if(invalid)await assert.rejects(work,e=>e.code==='DESTINATION_TOKEN_UNSUPPORTED');else assert.equal((await work).success,true);
 const mint=calls.find(c=>c.method==='getAccountInfo');assert.equal(mint.params[0],MINT);assert.equal(mint.params[1].minContextSlot,100);
 }
});

test('pre-funding inspection rejects Token2022, wrong decimals, uninitialized mint and wrong genesis',async()=>{
 for(const invalid of [null,'owner','decimals','initialized','genesis']){
  const f=fixture();const verifier=createRelayDestinationVerifier({fetch:async(_url,init)=>{
   const c=JSON.parse(init.body);const result=c.method==='getGenesisHash'?(invalid==='genesis'?'wrong':'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'):
    {context:{slot:100},value:{owner:invalid==='owner'?SYSTEM:TOKEN,executable:false,data:{program:'spl-token',parsed:{type:'mint',info:{decimals:invalid==='decimals'?6:9,isInitialized:invalid!=='initialized'}}}}};
   return new Response(JSON.stringify({jsonrpc:'2.0',id:c.id,result}));
  }});
  if(invalid)await assert.rejects(verifier.inspect(f.plan));else assert.equal((await verifier.inspect(f.plan)).ready,true);
 }
});
