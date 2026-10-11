/** Offline durable claim regression: temporary files and synthetic chain reads only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {WalletExecutionCoordinator,executionHash} from '@instinct/router-core';
import {createFileExecutionStore} from '../src/execution-store.mjs';
import {prepareSolana,preflightSolana} from '../../engine/src/relay-provider-solana.mjs';
import {encodeBase58,SYSTEM_PROGRAM,TOKEN_PROGRAM} from '../../engine/src/solana-message-codec.mjs';
import {sha} from '../../engine/src/relay-provider-terms.mjs';
const SOL='solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',BASE='eip155:8453';
const pub=n=>encodeBase58(new Uint8Array(32).fill(n)),sender=pub(2),mintAddress=pub(6),blockhash=pub(4),recipient='0x'+'22'.repeat(20);
const chain={chainId:SOL},recipeId='relay-provider-managed-v1',providerId='0x'+'33'.repeat(32),quoteHash='44'.repeat(32);
function account(bytes,owner,lamports=100000){return{owner,executable:false,lamports,data:[Buffer.from(bytes).toString('base64'),'base64']};}
async function fixture(token){
 const deadlineMs=Date.now()+60000,source={chainId:SOL,address:token?mintAddress:SYSTEM_PROGRAM,decimals:token?6:9},destination={chainId:BASE,address:'0x'+'00'.repeat(20),decimals:18};
 const request={requestId:'durable-solana',source,destination,sender,recipient,amountRaw:'1000',slippageBps:50,maxFeeBps:null,maxPriceImpactBps:500,maxCompletionMs:90000,deadlineMs,optimization:{objective:'BALANCED',maxOutputShortfallBps:50},nativeFeeBudgets:[{chainId:SOL,maxAmountRaw:null}]};
 const mint=Buffer.alloc(82);mint[44]=6;mint[45]=1;mint.writeBigUInt64LE(1000000n,36);
 const ata=Buffer.alloc(165);ata.set(new Uint8Array(32).fill(6));ata.set(new Uint8Array(32).fill(2),32);ata.writeBigUInt64LE(5000n,64);ata[108]=1;const post=Buffer.from(ata);post.writeBigUInt64LE(4000n,64);
 let simulations=0;
 const read=async(method,params)=>{
  if(method==='getGenesisHash')return'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
  if(method==='getLatestBlockhash')return{context:{slot:100},value:{blockhash,lastValidBlockHeight:200}};
  if(method==='getBlockTime')return Math.floor(Date.now()/1000);
  if(method==='getAccountInfo')return{context:{slot:100},value:params[0]===sender?account([],SYSTEM_PROGRAM):params[0]===mintAddress?account(mint,TOKEN_PROGRAM):account(ata,TOKEN_PROGRAM)};
  if(method==='getRecentPrioritizationFees')return[];
  if(method==='getFeeForMessage')return{context:{slot:100},value:5000};
  if(method==='isBlockhashValid')return{context:{slot:100},value:true};
  if(method==='getBlockHeight')return 100;
  if(method==='simulateTransaction'){simulations++;return{context:{slot:100},value:{err:null,unitsConsumed:1000,accounts:[account([],SYSTEM_PROGRAM,token?95000:94000),...(token?[account(post,TOKEN_PROGRAM)]:[])]}};}
  assert.fail('Unexpected RPC '+method);
 };
 const rawTransaction={instructions:[{programId:SYSTEM_PROGRAM,keys:[{pubkey:sender,isSigner:true,isWritable:true},{pubkey:pub(3),isSigner:false,isWritable:true}],data:'02000000e803000000000000'}],addressLookupTableAddresses:[]};
 const prepared=await prepareSolana({request,rawTransaction,chain,read,expiresAtMs:deadlineMs});
 const routeId='relay-provider:durable',quoteId='relay:'+providerId,nativeCosts=[{chainId:SOL,amountRaw:prepared.feeCapRaw}];
 const payload={type:'PROVIDER_REVIEWED_TRANSACTION',version:1,vm:'SOLANA',providerId:'relay',verification:'TRUSTED_SERVER_FRESH_RFQ',kind:'FUNDING',rfq:{requestId:providerId,commitmentHash:quoteHash,expiresAtMs:deadlineMs},spending:{asset:source,amountRaw:'1000',nativeValueRaw:prepared.nativeValueRaw,nativeFeeCapRaw:prepared.feeCapRaw},transaction:prepared.transaction,validation:{sourceIdentity:prepared.sourceIdentity,evidence:prepared.evidence},bindings:{requestId:providerId,quoteHash,source,destination,sender,recipient,amountRaw:'1000',minimumOutRaw:'995',slippageBps:50,expiresAtMs:deadlineMs,transactionHash:sha(prepared.transaction)}};
 const plan={routeId,quoteIds:[quoteId],source,destination,sender,recipient,amountRaw:'1000',minimumOutRaw:'995',expiresAtMs:deadlineMs,nativeCosts,providerRoute:{provider:'relay',mode:'PROVIDER_MANAGED',requestId:providerId,quoteHash,sourceVm:'SOLANA',destinationVm:'EVM',sourceConfirmations:1,destinationConfirmations:12},actions:[{id:'relay-provider-deposit',chainId:SOL,payload}]};
 const leg={index:0,capabilityId:recipeId,adapterId:'relay',kind:'SWAP_BRIDGE',source,destination,validationTier:'EXECUTION_VALIDATED',executionTier:'WALLET_SIGNED',quoteProbe:false,amountSource:'REQUEST_AMOUNT',requiresRequoteAfterSettlement:false};
 const quote={capabilityId:recipeId,adapterId:'relay',source,destination,amountInRaw:'1000',expectedOutRaw:'1000',minimumOutRaw:'995',feeBps:5,priceImpactBps:1,estimatedCompletionMs:5000,expiresAtMs:deadlineMs,pricingValidUntilMs:deadlineMs,quoteId,executableRecipeId:recipeId,conditional:false,liquidityConfirmed:true,nativeCosts};
 const candidate={id:routeId,requestId:request.requestId,path:{id:routeId,kind:'DIRECT',source,destination,legs:[leg],quoteBasis:'FIRM_FIRST_LEG',quoteProbe:false,executionReady:false},legQuotes:[quote],source,destination,inputAmountRaw:'1000',expectedOutputRaw:'1000',minimumOutputRaw:'995',feeBps:5,priceImpactBps:1,completionMs:5000,deadlineMs,quotedAtMs:Date.now(),conditional:false,validationTier:'EXECUTION_VALIDATED',executionReady:true};
 const recipes=[{id:recipeId,maxReviewLifetimeMs:90000,verify:async()=>structuredClone(plan)}],verifier={isValidTransactionHash:(chain,hash)=>executionHash(chain,hash,'transaction'),preflight:(plan,action)=>preflightSolana({plan,action,chain,read}),confirm:async()=>assert.fail('No submission expected')};
 return{request,candidate,plan,recipes,verifier,mint,simulations:()=>simulations};
}
async function temporary(t){const root=await fs.mkdtemp(path.join(await fs.realpath(tmpdir()),'router-solana-identity-')),directory=path.join(root,'journal'),stores=[];t.after(async()=>{for(const store of stores)await store.close().catch(()=>{});await fs.rm(root,{recursive:true,force:true});});return async()=>{const store=await createFileExecutionStore({directory});stores.push(store);return store;};}
test('native and SPL full unsigned plans survive file-store reopen and claim through real Solana preflight',async t=>{
 for(const token of [false,true]){const open=await temporary(t),f=await fixture(token),store=await open(),coordinator=new WalletExecutionCoordinator(store,f.recipes,f.verifier),record=await coordinator.prepare('durable','owner',f.request,f.candidate);await store.close();const reopened=await open(),saved=await reopened.get(record.id);assert.notEqual(JSON.stringify(saved.plan.actions[0].payload.validation.sourceIdentity),JSON.stringify(f.plan.actions[0].payload.validation.sourceIdentity));if(token)f.mint.writeBigUInt64LE(1000001n,36);const before=f.simulations(),next=new WalletExecutionCoordinator(reopened,f.recipes,f.verifier),claimed=await next.claim(record.id,'owner',record.reviewHash,0);assert.equal(claimed.record.status,'CLAIMED');assert.equal(f.simulations(),before+1);assert.deepEqual(claimed.record.submissions,[]);assert.equal(claimed.record.plan.actions[0].payload.transaction.serialized,f.plan.actions[0].payload.transaction.serialized);}
});
test('changed SPL authority after durable reopen cannot claim or submit',async t=>{
 const open=await temporary(t),f=await fixture(true),store=await open(),coordinator=new WalletExecutionCoordinator(store,f.recipes,f.verifier),record=await coordinator.prepare('durable','owner',f.request,f.candidate);await store.close();const reopened=await open(),saved=await reopened.get(record.id);f.mint.writeUInt32LE(1,0);f.mint[4]=9;const next=new WalletExecutionCoordinator(reopened,f.recipes,f.verifier);await assert.rejects(next.claim(record.id,'owner',record.reviewHash,0),{code:'EXECUTION_TOKEN_IDENTITY_MISMATCH'});assert.deepEqual(await reopened.get(record.id),saved);assert.equal(saved.status,'READY');assert.equal(saved.claimedActionId,null);assert.deepEqual(saved.submissions,[]);
});

function expiryProof(record){const p=record.plan.actions[0].payload;return{chainId:SOL,feePayer:record.plan.sender,blockhash:p.transaction.blockhash,preparedSlot:p.validation.evidence.slot,lastValidBlockHeight:p.transaction.lastValidBlockHeight,finalizedSlot:120,finalizedBlockHeight:201,finalizedBlockHash:pub(9),observedAtMs:Date.now(),minimumLedgerSlot:50,firstAvailableBlock:40,latestSignatureSlot:99};}
async function publicRecord(record){const {ownerId,...result}=structuredClone(record);const {payloadHash}=await import('../../sdk/src/execution-validation.js');result.plan.actions=await Promise.all(result.plan.actions.map(async({payload,...action})=>({...action,payloadHash:await payloadHash(payload)})));return result;}
async function claimedFixture(t,uncertain=false){let clock=Date.now();t.mock.method(Date,'now',()=>clock);const open=await temporary(t),f=await fixture(true),store=await open(),coordinator=new WalletExecutionCoordinator(store,f.recipes,f.verifier),review=await coordinator.prepare('durable','owner',f.request,f.candidate);await coordinator.claim(review.id,'owner',review.reviewHash,0);if(uncertain)await coordinator.signingUncertain(review.id,'owner');await store.close();const reopened=await open(),before=await reopened.get(review.id),next=new WalletExecutionCoordinator(reopened,f.recipes,f.verifier);return{...f,open,store:reopened,coordinator:next,before,expire:()=>{clock=f.plan.expiresAtMs+1;},advance:ms=>{clock+=ms;}};}
test('expired provider Solana claims recover only with durable finalized no-submission proof',async t=>{
 const {validateRecord}=await import('../../sdk/src/execution-validation.js');
 for(const uncertain of [false,true]){const f=await claimedFixture(t,uncertain);await assert.rejects(f.coordinator.recoverUnsubmitted('durable','owner'),{code:'EXECUTION_RECOVERY_BLOCKED'});f.expire();f.verifier.recoverUnsubmitted=async()=>({ready:true,evidence:expiryProof(f.before)});const expired=await f.coordinator.recoverUnsubmitted('durable','owner');assert.equal(expired.status,'EXPIRED');assert.equal(expired.claimedActionId,null);assert.equal(expired.revision,f.before.revision+1);assert.deepEqual(expired.submissions,[]);assert.deepEqual(expired.plan,f.before.plan);validateRecord(await publicRecord(expired),await publicRecord(f.before));await f.store.close();const reopened=await f.open();assert.deepEqual(await reopened.get('durable'),expired);const removed=await publicRecord(expired);delete removed.unsubmittedExpiry;const expected=await publicRecord(f.before);assert.throws(()=>validateRecord(removed,expected),{code:'PROTOCOL_ERROR'});const altered=await publicRecord(expired);altered.unsubmittedExpiry.finalizedSlot++;const terminal=await publicRecord(expired);assert.throws(()=>validateRecord(altered,terminal),{code:'PROTOCOL_ERROR'});t.mock.restoreAll();}
});
test('unsubmitted recovery rejects malformed, stale, pruned or unsigned-history evidence and direct store bypass',async t=>{
 const f=await claimedFixture(t,true);f.expire();const valid=expiryProof(f.before);
 for(const mutate of [p=>p.latestSignatureSlot=null,p=>p.latestSignatureSlot=100,p=>p.finalizedBlockHeight=200,p=>p.finalizedSlot=99,p=>p.minimumLedgerSlot=101,p=>p.firstAvailableBlock=101,p=>p.feePayer=pub(3),p=>p.blockhash=pub(3),p=>p.preparedSlot=101,p=>p.lastValidBlockHeight=199,p=>p.extra=true,p=>p.observedAtMs=Date.now()-15001]){const proof=structuredClone(valid);mutate(proof);f.verifier.recoverUnsubmitted=async()=>({ready:true,evidence:proof});await assert.rejects(f.coordinator.recoverUnsubmitted('durable','owner'),{code:'INVALID_UNSUBMITTED_EXPIRY_EVIDENCE'});assert.deepEqual(await f.store.get('durable'),f.before);}
 const forged={...structuredClone(f.before),revision:f.before.revision+1,status:'EXPIRED',claimedActionId:null};await assert.rejects(f.store.compareAndSwap('durable',f.before.revision,forged),{code:'EXECUTION_TRANSITION_INVALID'});assert.deepEqual(await f.store.get('durable'),f.before);
});
test('a submission racing finalized expiry evidence cannot be cleared by recovery CAS',async t=>{
 const f=await claimedFixture(t,true);f.expire();let reached,finish;const entered=new Promise(resolve=>reached=resolve),wait=new Promise(resolve=>finish=resolve);f.verifier.recoverUnsubmitted=async()=>{reached();await wait;return{ready:true,evidence:expiryProof(f.before)};};const pending=f.coordinator.recoverUnsubmitted('durable','owner');await entered;const hash=encodeBase58(new Uint8Array(64).fill(7)),submitted=await f.coordinator.submitted('durable','owner',hash);finish();await assert.rejects(pending,{code:'EXECUTION_CONFLICT'});assert.deepEqual(await f.store.get('durable'),submitted);assert.equal(submitted.submissions[0].hash,hash);
});

async function apiFixture(f){const {createExecutionApi}=await import('../src/execution-api.mjs');return createExecutionApi({engine:{prepare:async()=>assert.fail('Read-only recovery must not prepare or submit a transaction'),recipes:f.recipes,verifier:f.verifier},store:f.store});}
const authenticatedWallet={ownerId:'owner',chainId:SOL,address:sender};
test('authenticated get, active and refresh recover expired unsigned claims through the durable coordinator',async t=>{
 const {validateRecord}=await import('../../sdk/src/execution-validation.js');
 for(const operation of ['get','active','refresh']){const f=await claimedFixture(t,true);f.expire();let checks=0;f.verifier.recoverUnsubmitted=async()=>{checks++;return{ready:true,evidence:expiryProof(f.before)};};const api=await apiFixture(f),signal=new AbortController().signal;const response=operation==='get'?await api.get('durable',authenticatedWallet,signal):operation==='active'?await api.active(authenticatedWallet,signal):await api.mutate('durable','refresh',{},authenticatedWallet,signal);assert.equal(checks,1);const stored=await f.store.get('durable');assert.equal(stored.status,'EXPIRED');assert.deepEqual(stored.submissions,[]);if(operation==='active')assert.equal(response.execution,null);else{assert.equal(response.execution.status,'EXPIRED');assert.equal(Object.hasOwn(response.execution,'ownerId'),false);validateRecord(response.execution,await publicRecord(f.before));}t.mock.restoreAll();}
});
test('wallet authentication precedes recovery evidence reads and unavailable evidence preserves the claim',async t=>{
 const f=await claimedFixture(t,true);f.expire();let checks=0;f.verifier.recoverUnsubmitted=async()=>{checks++;return{ready:false};};const api=await apiFixture(f);
 for(const wallet of [{...authenticatedWallet,ownerId:'different-owner'},{...authenticatedWallet,address:pub(3)},{...authenticatedWallet,chainId:BASE}])await assert.rejects(api.get('durable',wallet),{code:'EXECUTION_NOT_FOUND'});assert.equal(checks,0);const unavailable=await api.get('durable',authenticatedWallet);assert.equal(unavailable.execution.status,'RECOVERY_REQUIRED');assert.equal(checks,1);assert.deepEqual(await f.store.get('durable'),f.before);f.verifier.recoverUnsubmitted=async()=>{throw Object.assign(Error('network unavailable'),{code:'EXECUTION_EVIDENCE_UNAVAILABLE'});};await assert.rejects(api.get('durable',authenticatedWallet),{code:'EXECUTION_EVIDENCE_UNAVAILABLE'});assert.deepEqual(await f.store.get('durable'),f.before);
});
test('aborting authenticated recovery while its verifier is pending retains the exact claimed record',async t=>{
 const f=await claimedFixture(t,true);f.expire();let entered,finish;const started=new Promise(resolve=>entered=resolve),waiting=new Promise(resolve=>finish=resolve),controller=new AbortController();f.verifier.recoverUnsubmitted=async(input,signal)=>{assert.equal(signal,controller.signal);entered();await waiting;return{ready:true,evidence:expiryProof(input.record)};};const api=await apiFixture(f),pending=api.get('durable',authenticatedWallet,controller.signal);await started;controller.abort();finish();await assert.rejects(pending,{code:'CANCELLED'});assert.deepEqual(await f.store.get('durable'),f.before);
});
