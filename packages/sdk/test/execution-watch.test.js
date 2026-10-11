import test from 'node:test';
import assert from 'node:assert/strict';
import {createRouterClient,createExecutionController,RouterSdkError} from '../src/index.js';
import {encodeBase58} from '../src/wallets.js';
const token='t'.repeat(43),BASE='eip155:8453',SOL='solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const sender='0x'+'1'.repeat(40),hash='0x'+'a'.repeat(64),recipient='47YyVUMwerrz76mCrpgFP3iDva1Vt4ZxpSuxo6AhwabT';
const source={chainId:BASE,address:'0x'+'0'.repeat(40),decimals:18},destination={chainId:SOL,address:'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',decimals:6};
const code=expected=>error=>error instanceof RouterSdkError&&error.code===expected;
function fixture(){const now=Date.now(),actionId='relay-native-deposit';
 const record={id:'execution-1',revision:2,status:'SUBMITTED',reviewHash:'b'.repeat(64),request:{},nextAction:0,claimedActionId:actionId,submissions:[{actionId,hash}],
  plan:{routeId:'route-1',quoteIds:['relay:0x'+'d'.repeat(64)],source,destination,sender,recipient,amountRaw:'1000',minimumOutRaw:'1',expiresAtMs:now+60000,nativeCosts:[{chainId:BASE,amountRaw:'100'}],actions:[{id:actionId,chainId:BASE,payloadHash:'c'.repeat(64)}]}};
 const progress={routeId:record.plan.routeId,actionId,sourceTransactionHash:hash,stage:'DESTINATION_CONFIRMED',observedAtMs:now,sourceConfirmations:2,requiredSourceConfirmations:12,destination:{chainId:SOL,transactionHash:encodeBase58(new Uint8Array(64).fill(2)),asset:destination,recipient,amountRaw:'1',commitment:'confirmed'}};
 const common={apiVersion:'1',requestId:'request-1',appId:'app-1',executionId:record.id,sentAtMs:now};
 const frames=[{...common,sequence:0,type:'START'},{...common,sequence:1,type:'UPDATE',execution:record,receiptStatus:'PENDING',progress},{...common,sequence:2,type:'END',reason:'TIMEOUT'}];
 return {record,progress,frames};}
function response(frames){return new Response(frames.map(frame=>JSON.stringify(frame)+'\n').join(''),{headers:{'content-type':'application/x-ndjson'}});}
function sdk(fetch){return createRouterClient({baseUrl:'https://router.example',publishableKey:'pk_public_123456789',fetch});}
test('authenticated execution watch delivers bound proof immediately with honest receipt timing',async()=>{
 const f=fixture(),seen=[];const client=sdk(async(url,init)=>{assert.equal(url,'https://router.example/v1/executions/execution-1/watch');assert.equal(init.method,'POST');assert.equal(init.body,'{}');assert.equal(init.headers['X-Router-Wallet-Token'],token);assert.equal(init.headers.Accept,'application/x-ndjson');return response(f.frames);});
 const result=await client.watchExecution(f.record.id,{walletToken:token,onUpdate:(data,timing)=>{seen.push(data);assert.equal(data.execution.status,'SUBMITTED');assert.equal(timing.observedToSentMs,0);assert(Number.isFinite(timing.receivedAtMonoMs));assert(Number.isFinite(timing.serverToReceiptMs));}});
 assert.equal(result.reason,'TIMEOUT');assert.equal(seen.length,1);assert.deepEqual(seen[0].progress,f.progress);
});
test('watch rejects sequence, identity, record, progress and terminal binding changes',async()=>{
 const mutations=[rows=>{rows[0].extra=true;},rows=>{rows[1].sequence=2;},rows=>{rows[1].appId='other';},rows=>{rows[1].executionId='other';},rows=>{rows[1].requestId='other';},rows=>{rows[1].progress.routeId='other';},rows=>{rows[1].progress.observedAtMs=rows[1].sentAtMs+1;},rows=>{rows[2].reason='SETTLED';},rows=>{rows[2].extra=true;},rows=>{rows[2].sentAtMs--;},rows=>{rows[1].receiptStatus='UNKNOWN';}];
 for(const mutate of mutations){const f=fixture();mutate(f.frames);await assert.rejects(sdk(async()=>response(f.frames)).watchExecution(f.record.id,{walletToken:token}),code('PROTOCOL_ERROR'));}
 const f=fixture();const changed=structuredClone(f.frames[1]);changed.sequence=2;changed.execution.plan.amountRaw='1001';f.frames.splice(2,0,changed);f.frames[3].sequence=3;
 await assert.rejects(sdk(async()=>response(f.frames)).watchExecution(f.record.id,{walletToken:token}),code('PROTOCOL_ERROR'));
});
test('execution stream clean disconnect permits recovery but malformed/truncated frames never do',async()=>{
 const f=fixture();await assert.rejects(sdk(async()=>response(f.frames.slice(0,2))).watchExecution(f.record.id,{walletToken:token}),code('NETWORK_ERROR'));
 for(const text of ['{bad}\n',JSON.stringify(f.frames[0]),'\uFEFF'+JSON.stringify(f.frames[0])+'\n'])await assert.rejects(sdk(async()=>new Response(text,{headers:{'content-type':'application/x-ndjson'}})).watchExecution(f.record.id,{walletToken:token}),code('PROTOCOL_ERROR'));
});
test('watch bounds frames and individual line size, requires auth and redacts remote errors',async()=>{
 const f=fixture();const many=[f.frames[0],...Array.from({length:1023},(_,i)=>({...f.frames[1],sequence:i+1})),{...f.frames[2],sequence:1024}];
 await assert.rejects(sdk(async()=>response(many)).watchExecution(f.record.id,{walletToken:token}),code('PROTOCOL_ERROR'));
 await assert.rejects(sdk(async()=>new Response(' '.repeat(262144)+'\n',{headers:{'content-type':'application/x-ndjson'}})).watchExecution(f.record.id,{walletToken:token}),code('PROTOCOL_ERROR'));
 await assert.rejects(sdk(async()=>response(f.frames)).watchExecution(f.record.id,{}),code('INVALID_INPUT'));
 const error={...f.frames[2],type:'ERROR',error:{code:'DENIED',message:token,retryable:false}};delete error.reason;
 await assert.rejects(sdk(async()=>response([f.frames[0],f.frames[1],error])).watchExecution(f.record.id,{walletToken:token}),error=>error.code==='DENIED'&&!error.message.includes(token));
});
test('controller watch persists authoritative updates but proof remains transient and never resends',async()=>{
 const f=fixture(),data=new Map([['instinct-router-recovery-v1',JSON.stringify({version:1,phase:'SUBMITTED',record:f.record,transactionHash:hash})]]),storage={getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)};
 let sends=0;const wallet={getAccount:async()=>({chainId:BASE,address:sender}),signMessage:async()=>'',sendTransaction:async()=>{sends++;throw Error('Never');}};
 const client={createWalletChallenge:async()=>({wallet:{chainId:BASE,address:sender},message:'proof',expiresAtMs:Date.now()+60000}),verifyWallet:async()=>({wallet:{chainId:BASE,address:sender},walletToken:token,expiresAtMs:Date.now()+60000}),watchExecution:async(id,options)=>{await options.onUpdate({execution:f.record,progress:f.progress,receiptStatus:'PENDING'},{receivedAtMonoMs:performance.now()});return {reason:'TIMEOUT',execution:f.record};}};
 const c=createExecutionController({client,wallet,storage});await c.proveOwnership();await c.watch({onUpdate:()=>{assert.deepEqual(c.getProgress(),f.progress);assert.equal(c.getRecovery().progress,undefined);}});assert.equal(sends,0);
 const fresh=createExecutionController({client,wallet,storage});assert.equal(fresh.getProgress(),null);
 client.watchExecution=async(id,options)=>options.onUpdate({execution:{...f.record,plan:{...f.record.plan,amountRaw:'999'}},receiptStatus:'PENDING'});
 await assert.rejects(c.watch({onUpdate:()=>{}}),code('PROTOCOL_ERROR'));assert.equal(c.getProgress(),null);assert.equal(sends,0);
});
test('watch enforces total bytes and aborts a stalled stream without later callbacks',async()=>{
 const f=fixture();await assert.rejects(sdk(async()=>new Response(' '.repeat(8388609),{headers:{'content-type':'application/x-ndjson'}})).watchExecution(f.record.id,{walletToken:token}),code('RESPONSE_TOO_LARGE'));
 let cancelled=false,updates=0;
 const body=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(f.frames.slice(0,2).map(row=>JSON.stringify(row)+'\n').join('')));},cancel(){cancelled=true;}});
 await assert.rejects(sdk(async()=>new Response(body,{headers:{'content-type':'application/x-ndjson'}})).watchExecution(f.record.id,{walletToken:token,timeoutMs:20,onUpdate:()=>{updates++;}}),code('TIMEOUT'));
 assert.equal(updates,1);assert.equal(cancelled,true);
});
