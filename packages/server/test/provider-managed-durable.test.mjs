import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {WalletExecutionCoordinator} from '@instinct/router-core';
import {createFileExecutionStore} from '../src/execution-store.mjs';
import {settlementProgress} from '../src/settlement-progress.mjs';
const sender='0x'+'11'.repeat(20),recipient='0x'+'22'.repeat(20),requestId='0x'+'33'.repeat(32),quoteHash='44'.repeat(32);
const tx='0x'+'55'.repeat(32),payout='0x'+'ab'.repeat(32),block='0x'+'77'.repeat(32);
function fixture(sameChain=false){
 const source={chainId:'eip155:42161',address:'0x'+'00'.repeat(20),decimals:18},destination={chainId:sameChain?source.chainId:'eip155:10',address:'0x'+'88'.repeat(20),decimals:6},deadlineMs=Date.now()+60000;
 const request={requestId:'input',source,destination,sender,recipient,amountRaw:'100000',slippageBps:50,maxFeeBps:null,maxPriceImpactBps:500,maxCompletionMs:90000,deadlineMs,optimization:{objective:'BALANCED',maxOutputShortfallBps:50},nativeFeeBudgets:[{chainId:source.chainId,maxAmountRaw:null}]};
 const routeId='relay-provider:fixture',quoteId='relay:'+requestId,recipeId='relay-provider-managed-v1';
 const plan={routeId,quoteIds:[quoteId],source,destination,sender,recipient,amountRaw:request.amountRaw,minimumOutRaw:'995',expiresAtMs:deadlineMs,nativeCosts:[{chainId:source.chainId,amountRaw:'10'}],providerRoute:{provider:'relay',mode:'PROVIDER_MANAGED',requestId,quoteHash,sourceVm:'EVM',destinationVm:'EVM',sourceConfirmations:12,destinationConfirmations:12},actions:[{id:'relay-provider-deposit',chainId:source.chainId,payload:{type:'PROVIDER_REVIEWED_TRANSACTION',version:1,vm:'EVM',providerId:'relay',verification:'TRUSTED_SERVER_FRESH_RFQ',kind:'FUNDING',rfq:{requestId,commitmentHash:quoteHash,expiresAtMs:deadlineMs}}}]};
 const leg={index:0,capabilityId:recipeId,adapterId:'relay',kind:'SWAP_BRIDGE',source,destination,validationTier:'EXECUTION_VALIDATED',executionTier:'WALLET_SIGNED',quoteProbe:false,amountSource:'REQUEST_AMOUNT',requiresRequoteAfterSettlement:false};
 const q={capabilityId:recipeId,adapterId:'relay',source,destination,amountInRaw:request.amountRaw,expectedOutRaw:'1000',minimumOutRaw:'995',feeBps:5,priceImpactBps:1,estimatedCompletionMs:5000,expiresAtMs:deadlineMs,pricingValidUntilMs:deadlineMs,quoteId,executableRecipeId:recipeId,conditional:false,liquidityConfirmed:true,nativeCosts:plan.nativeCosts};
 const candidate={id:routeId,requestId:request.requestId,path:{id:routeId,kind:'DIRECT',source,destination,legs:[leg],quoteBasis:'FIRM_FIRST_LEG',quoteProbe:false,executionReady:false},legQuotes:[q],source,destination,inputAmountRaw:request.amountRaw,expectedOutputRaw:'1000',minimumOutputRaw:'995',feeBps:5,priceImpactBps:1,completionMs:5000,deadlineMs,quotedAtMs:Date.now(),conditional:false,validationTier:'EXECUTION_VALIDATED',executionReady:true};
 const credit={asset:destination,recipient,amountRaw:'995'},receipt={chainId:source.chainId,transactionHash:tx,blockNumberRaw:'100',blockHash:block,observedAtMs:Date.now(),confirmations:12,actualNativeFeeRaw:'5'},destinationReceipt={chainId:destination.chainId,transactionHash:payout,blockNumberRaw:'200',blockHash:block,observedAtMs:Date.now(),confirmations:12,commitment:'canonical',destinationCredit:credit,attribution:{provider:'relay',requestId,sourceTransactionHash:tx,basis:'PROVIDER_STATUS_AND_CHAIN_CREDIT'}};
 const evidence={success:true,routeId,actionId:plan.actions[0].id,transactionHash:tx,receipt,destinationCredit:credit,destinationReceipt};
 const verifier={isValidTransactionHash:(_,h)=>/^0x[0-9a-f]{64}$/.test(h),preflight:async()=>({ready:true}),confirm:async()=>structuredClone(evidence)};
 return {plan,request,candidate,evidence,verifier,recipes:[{id:recipeId,maxReviewLifetimeMs:90000,verify:async()=>structuredClone(plan)}]};
}
async function temporary(t){const root=await fs.mkdtemp(path.join(await fs.realpath(tmpdir()),'router-provider-store-')),directory=path.join(root,'journal'),stores=[];t.after(async()=>{for(const s of stores)await s.close().catch(()=>{});await fs.rm(root,{recursive:true,force:true});});return{async open(){const s=await createFileExecutionStore({directory});stores.push(s);return s;}};}
async function submit(f,store,id='p1'){const coordinator=new WalletExecutionCoordinator(store,f.recipes,f.verifier),r=await coordinator.prepare(id,'owner',f.request,f.candidate);await coordinator.claim(id,'owner',r.reviewHash,0);await coordinator.submitted(id,'owner',tx);return coordinator;}
test('provider-managed cross-chain and same-chain separate payouts survive durable restart',async t=>{
 for(const sameChain of [false,true]){const temp=await temporary(t),store=await temp.open(),f=fixture(sameChain),c=await submit(f,store),done=await c.confirmed('p1','owner');assert.equal(done.status,'COMPLETE');assert.equal(done.destinationReceipt.transactionHash,payout);await store.close();const reopened=await temp.open();assert.deepEqual(await reopened.get('p1'),done);}
});
test('provider trust cannot downgrade confirmation, attribution, exact credit or immutable quote',async t=>{
 for(const mutate of [e=>delete e.receipt,e=>e.receipt.confirmations=1,e=>delete e.destinationReceipt,e=>delete e.destinationReceipt.attribution.basis,e=>e.destinationReceipt.attribution.requestId=tx,e=>e.destinationReceipt.confirmations=1,e=>e.destinationReceipt.destinationCredit.amountRaw='994']){
  const temp=await temporary(t),store=await temp.open(),f=fixture(),c=await submit(f,store);mutate(f.evidence);await assert.rejects(c.confirmed('p1','owner'));assert.equal((await store.get('p1')).status,'SUBMITTED');
 }
 for(const mutate of [p=>delete p.providerRoute,p=>p.providerRoute.sourceConfirmations=1,p=>p.actions[0].payload.rfq.commitmentHash='99'.repeat(32),p=>p.routeId='local:spoof']){const temp=await temporary(t),store=await temp.open(),f=fixture();mutate(f.plan);const c=new WalletExecutionCoordinator(store,f.recipes,f.verifier);await assert.rejects(c.prepare('p1','owner',f.request,f.candidate));assert.equal(await store.get('p1'),null);}
});
test('provider-managed same-chain atomic payout and failed original transaction require source proof',async t=>{
 for(const failed of [false,true]){const temp=await temporary(t),store=await temp.open(),f=fixture(true);delete f.evidence.destinationReceipt;if(failed){f.evidence.success=false;f.evidence.confirmedFailure=true;delete f.evidence.destinationCredit;}else f.evidence.receipt.destinationCredit=f.evidence.destinationCredit;
 const c=await submit(f,store);assert.equal((await c.confirmed('p1','owner')).status,failed?'FAILED':'COMPLETE');}
});

test('provider destination hash casing cannot bypass durable delivery replay protection',async t=>{
 const temp=await temporary(t),store=await temp.open(),f=fixture(),c=await submit(f,store);await c.confirmed('p1','owner');
 const g=fixture(),id='p2',second='0x'+'99'.repeat(32),order='0x'+'aa'.repeat(32);
 g.plan.quoteIds=['relay:'+order];g.plan.providerRoute.requestId=order;g.plan.actions[0].payload.rfq.requestId=order;g.candidate.legQuotes[0].quoteId='relay:'+order;
 g.evidence.transactionHash=second;g.evidence.receipt.transactionHash=second;g.evidence.destinationReceipt.attribution.sourceTransactionHash=second;g.evidence.destinationReceipt.attribution.requestId=order;g.evidence.destinationReceipt.transactionHash='0x'+payout.slice(2).toUpperCase();
 const next=new WalletExecutionCoordinator(store,g.recipes,g.verifier),r=await next.prepare(id,'owner',g.request,g.candidate);await next.claim(id,'owner',r.reviewHash,0);await next.submitted(id,'owner',second);
 await assert.rejects(next.confirmed(id,'owner'),/EXECUTION_DELIVERY_REUSED/);assert.equal((await store.get(id)).status,'SUBMITTED');
});
test('provider observation is display only, exact hash bound and expires independently of saved trade',async t=>{
 const temp=await temporary(t),store=await temp.open(),f=fixture(true);await submit(f,store);const row=await store.get('p1'),time=Date.now();
 const progress={routeId:row.plan.routeId,actionId:'relay-provider-deposit',sourceTransactionHash:tx,stage:'DESTINATION_CONFIRMED',observedAtMs:time,sourceConfirmations:1,requiredSourceConfirmations:12,destination:{chainId:f.plan.destination.chainId,transactionHash:payout,asset:f.plan.destination,recipient,amountRaw:'995',commitment:'confirmed'}};
 assert.deepEqual(settlementProgress(progress,row,time),progress);assert.equal(settlementProgress({...progress,sourceTransactionHash:payout},row,time),undefined);assert.equal(settlementProgress(progress,row,time+15001),undefined);assert.equal((await store.get('p1')).status,'SUBMITTED');
});

test('provider request commitments cannot be reused after a completed execution',async t=>{
 const temp=await temporary(t),store=await temp.open(),f=fixture(),c=await submit(f,store);await c.confirmed('p1','owner');
 const g=fixture(),next=new WalletExecutionCoordinator(store,g.recipes,g.verifier);
 await assert.rejects(next.prepare('p2','owner',g.request,g.candidate),/EXECUTION_ORDER_REUSED/);
});
test('an atomic same-chain credited transaction cannot be replayed as another provider payout',async t=>{
 const temp=await temporary(t),store=await temp.open(),f=fixture(true);delete f.evidence.destinationReceipt;f.evidence.receipt.destinationCredit=f.evidence.destinationCredit;const c=await submit(f,store);await c.confirmed('p1','owner');
 const g=fixture(true),second='0x'+'99'.repeat(32),order='0x'+'aa'.repeat(32);g.plan.quoteIds=['relay:'+order];g.plan.providerRoute.requestId=order;g.plan.actions[0].payload.rfq.requestId=order;g.candidate.legQuotes[0].quoteId='relay:'+order;
 g.evidence.transactionHash=second;g.evidence.receipt.transactionHash=second;g.evidence.destinationReceipt.transactionHash=tx;g.evidence.destinationReceipt.attribution.requestId=order;g.evidence.destinationReceipt.attribution.sourceTransactionHash=second;
 const next=new WalletExecutionCoordinator(store,g.recipes,g.verifier),r=await next.prepare('p2','owner',g.request,g.candidate);await next.claim('p2','owner',r.reviewHash,0);await next.submitted('p2','owner',second);await assert.rejects(next.confirmed('p2','owner'),/EXECUTION_DELIVERY_REUSED/);
});
