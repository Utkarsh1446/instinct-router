import test from 'node:test';
import assert from 'node:assert/strict';
import { createRouterClient, createExecutionController, createEvmWallet, createPhantomWallet, RouterSdkError } from '../src/index.js';
import { payloadHash, evmTransaction, validateRecord, validateProgress } from '../src/execution-validation.js';
import { encodeBase58 } from '../src/wallets.js';
const wallet = {chainId:'eip155:8453',address:'0x'+'11'.repeat(20)}, token='a'.repeat(43);
const source={...wallet,address:'0x'+'0'.repeat(40),decimals:18}, destination={...source,address:'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',decimals:6};
const input={source,destination,amount:'0.00005',sender:wallet.address,recipient:wallet.address,nativeFeeBudgets:[{chainId:wallet.chainId,maxAmountRaw:'20000000000000'}]};
const envelope = value => ({apiVersion:'1',requestId:'request-1',...value});
const response = value => new Response(JSON.stringify(envelope(value)), {headers:{'content-type':'application/json'}});
const code = expected => error => error instanceof RouterSdkError && error.code===expected;
async function fixture() {
  const payload={type:'EVM_TRANSACTION',transaction:{chainId:'0x2105',type:'0x2',from:wallet.address,to:'0x'+'22'.repeat(20),data:'0x12345678',value:'0x2d79883d2000',gas:'0x186a0',maxFeePerGas:'0x64',maxPriorityFeePerGas:'0x1',accessList:[]}};
  const action={id:'action-1',chainId:wallet.chainId,payload};
  const record={id:'execution-1',revision:0,status:'READY',reviewHash:'ab'.repeat(32),request:{source,destination,amountRaw:'50000000000000',sender:wallet.address,recipient:wallet.address,slippageBps:50,maxFeeBps:500,maxPriceImpactBps:500,optimization:{objective:'BALANCED',maxOutputShortfallBps:50},nativeFeeBudgets:input.nativeFeeBudgets,deadlineMs:Date.now()+90000},plan:{routeId:'route-1',quoteIds:['q-1'],source,destination,sender:wallet.address,recipient:wallet.address,amountRaw:'50000000000000',minimumOutRaw:'1',expiresAtMs:Date.now()+60000,nativeCosts:[{chainId:wallet.chainId,amountRaw:'10000000'}],actions:[{id:action.id,chainId:wallet.chainId,payloadHash:await payloadHash(payload)}]},nextAction:0,claimedActionId:null,submissions:[]};
  const data=new Map();const storage={getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)};
  const client={
    createWalletChallenge:async()=>({wallet,message:'challenge',challengeId:'wc_'+ 'ab'.repeat(24),expiresAtMs:Date.now()+60000}),
    verifyWallet:async()=>({wallet,walletToken:token,expiresAtMs:Date.now()+60000}),
    prepareExecution:async()=>({execution:structuredClone(record)}),
    claimExecution:async()=>{record.status='CLAIMED';record.claimedActionId=action.id;record.revision++;return {execution:structuredClone(record),action:structuredClone(action)};},
    submitExecution:async(_,{transactionHash})=>{record.status='SUBMITTED';record.revision++;record.submissions=[{actionId:action.id,hash:transactionHash}];return {execution:structuredClone(record)};},
    getExecution:async()=>({execution:structuredClone(record)}),
    refreshExecution:async()=>{record.status='COMPLETE';record.receipt={chainId:wallet.chainId,transactionHash:record.submissions[0].hash,blockNumberRaw:'1000',blockHash:'0x'+'bb'.repeat(32),observedAtMs:Date.now(),confirmations:12,destinationCredit:{asset:destination,recipient:wallet.address,amountRaw:'1'}};record.nextAction=1;record.claimedActionId=null;record.revision++;return {execution:structuredClone(record)};},
    markExecutionUncertain:async()=>{record.status='RECOVERY_REQUIRED';record.revision++;return {execution:structuredClone(record)};},
    cancelExecution:async()=>{record.status='CANCELLED';record.revision++;return {execution:structuredClone(record)};},
    getActiveExecution:async()=>({execution:structuredClone(record)}),
  };
  let sends=0;
  const adapter={getAccount:async()=>({...wallet}),signMessage:async()=> '0x'+'aa'.repeat(65),sendTransaction:async()=>{sends++;return '0x'+'aa'.repeat(32);}};
  const controller=()=>createExecutionController({client,wallet:adapter,storage});
  return {action,record,storage,client,adapter,controller,sends:()=>sends};
}
test('ownership proof never sends a transaction; execute requires exact reviewed confirmation and saves recovery first', async()=>{
  const f=await fixture(), c=f.controller(); await c.proveOwnership();assert.equal(f.sends(),0);
  const review=await c.prepare(input);assert.equal(c.getRecovery().phase,'REVIEW');
  await c.execute(review,async(record,action)=>{assert.equal(c.getRecovery().phase,'CLAIMED');assert.equal(record.reviewHash,review.reviewHash);action.payload.transaction.value='0x0';return true;});
  assert.equal(f.sends(),1);assert.equal(c.getRecovery().phase,'SUBMITTED');assert.equal((await c.resume()).status,'COMPLETE');assert.equal(c.getRecovery().transactionHash,'0x'+'aa'.repeat(32));assert.equal(typeof c.getRecovery().walletRttMs,'number');
});
test('wallet/storage/consent changes fail before broadcast and reserve recovery',async()=>{
  for(const scenario of ['wallet','storage','decline','mutation']){
    const f=await fixture(),c=f.controller();await c.proveOwnership();const review=await c.prepare(input);
    if(scenario==='wallet')f.adapter.getAccount=async()=>({...wallet,address:'0x'+'33'.repeat(20)});
    if(scenario==='storage')f.storage.setItem=()=>{throw Error('diskfull');};
    if(scenario==='mutation')review.plan.amountRaw='1';
    await assert.rejects(c.execute(review,()=>scenario!=='decline'));
    assert.equal(f.sends(),0);
  }
});
test('lost wallet response blocks another execution and never retries signing',async()=>{
  const f=await fixture(), c=f.controller();await c.proveOwnership();const review=await c.prepare(input);
  let calls=0;f.adapter.sendTransaction=async()=>{calls++;throw Error('unknown');};
  await assert.rejects(c.execute(review,()=>true));assert.equal(c.getRecovery().phase,'RECOVERY_REQUIRED');
  await assert.rejects(c.prepare(input),code('RECOVERY_REQUIRED'));await assert.rejects(c.execute(review,()=>true),code('RECOVERY_REQUIRED'));
  await c.resume();assert.equal(calls,1);
});
test('known hash survives report failure and resumes durable status without wallet resend',async()=>{
  const f=await fixture(), c=f.controller();await c.proveOwnership();const review=await c.prepare(input),submit=f.client.submitExecution;
  f.client.submitExecution=async()=>{throw Error('network');};await assert.rejects(c.execute(review,()=>true));
  assert.equal(c.getRecovery().phase,'SUBMIT_PENDING');assert.ok(c.getRecovery().transactionHash);
  f.client.submitExecution=submit;const resumed=f.controller();await resumed.proveOwnership();assert.equal((await resumed.resume()).status,'COMPLETE');assert.equal(f.sends(),1);
});
test('prepare response loss recovers active execution and never auto prepares again',async()=>{
  const f=await fixture(), c=f.controller();await c.proveOwnership();let prepares=0;
  f.client.prepareExecution=async()=>{prepares++;throw Error('network');};await assert.rejects(c.prepare(input));
  assert.equal(c.getRecovery().phase,'PREPARE_PENDING');await assert.rejects(c.prepare(input),code('RECOVERY_REQUIRED'));
  assert.equal((await c.resume()).id,f.record.id);assert.equal(prepares,1);
});
const recoveryKey = 'instinct-router-recovery-v1';
function ageRecovery(f, changes = {}) {
  const saved = JSON.parse(f.storage.getItem(recoveryKey));
  f.storage.setItem(recoveryKey, JSON.stringify({...saved, savedAtMs:Date.now()-31000, expiresAtMs:Date.now()-1000, ...changes}));
}
test('aged unsent prepare reconciles an empty authenticated queue before preparing again',async()=>{
  const f=await fixture(),c=f.controller();await c.proveOwnership();
  f.client.prepareExecution=async()=>{throw Error('lost response');};await assert.rejects(c.prepare(input));
  assert.ok(c.getRecovery().expiresAtMs>c.getRecovery().savedAtMs);ageRecovery(f);
  let reads=0,prepares=0;
  f.client.getActiveExecution=async auth=>{assert.equal(auth.walletToken,token);reads++;return {execution:null};};
  f.client.prepareExecution=async()=>{prepares++;assert.equal(c.getRecovery().phase,'PREPARE_PENDING');return {execution:structuredClone(f.record)};};
  assert.equal((await c.prepare(input)).status,'READY');assert.equal(reads,1);assert.equal(prepares,1);assert.equal(f.sends(),0);
});
test('aged unsent prepare recovers a late active review without duplicating it',async()=>{
  const f=await fixture(),c=f.controller();await c.proveOwnership();let prepares=0;
  f.client.prepareExecution=async()=>{prepares++;throw Error('lost response');};await assert.rejects(c.prepare(input));ageRecovery(f);
  await assert.rejects(c.prepare(input),code('RECOVERY_REQUIRED'));
  assert.equal(c.getRecovery().phase,'REVIEW');assert.equal(c.getRecovery().record.id,f.record.id);assert.equal(prepares,1);assert.equal(f.sends(),0);
});
test('expired initial review only releases after the server confirms its terminal status',async()=>{
  for (const status of ['EXPIRED','FAILED']) {
    const f=await fixture(),c=f.controller();await c.proveOwnership();
    f.record.plan.expiresAtMs=Date.now()-1000;await c.prepare(input);
    const fresh=structuredClone(f.record);fresh.id='execution-2';fresh.plan.expiresAtMs=Date.now()+60000;
    let reads=0,prepares=0;
    f.client.getExecution=async()=>{
      reads++;f.record.status=status;f.record.revision++;
      if(status==='FAILED') {
        const hash='0x'+'aa'.repeat(32);f.record.submissions=[{actionId:f.action.id,hash}];f.record.claimedActionId=f.action.id;
        f.record.receipt={chainId:wallet.chainId,transactionHash:hash,blockNumberRaw:'1000',blockHash:'0x'+'bb'.repeat(32),observedAtMs:Date.now(),confirmations:12};
      }
      return {execution:structuredClone(f.record)};
    };
    f.client.prepareExecution=async()=>{prepares++;return {execution:fresh};};
    assert.equal((await c.prepare(input)).id,'execution-2');assert.equal(reads,1);assert.equal(prepares,1);assert.equal(f.sends(),0);
  }
});
test('local review expiry cannot release a review still reported active by the server',async()=>{
  const f=await fixture(),c=f.controller();await c.proveOwnership();f.record.plan.expiresAtMs=Date.now()-1000;await c.prepare(input);
  let prepares=0;f.client.prepareExecution=async()=>{prepares++;return {execution:f.record};};
  await assert.rejects(c.prepare(input),code('RECOVERY_REQUIRED'));
  assert.equal(c.getRecovery().phase,'REVIEW');assert.equal(c.getRecovery().record.id,f.record.id);assert.equal(prepares,0);assert.equal(f.sends(),0);
});
test('expiry or failed reconciliation cannot discard a claimed or ambiguous transaction',async()=>{
  for(const phase of ['CLAIM_PENDING','CLAIMED','WALLET_PENDING','SUBMIT_PENDING','SUBMITTED','RECOVERY_REQUIRED','REVIEW']) {
    const f=await fixture(),c=f.controller();await c.proveOwnership();f.record.plan.expiresAtMs=Date.now()-1000;await c.prepare(input);
    ageRecovery(f,{phase,...(phase==='REVIEW'?{transactionHash:'0x'+'aa'.repeat(32)}:{})});
    const before=f.storage.getItem(recoveryKey);let reads=0,prepares=0;
    f.client.getActiveExecution=f.client.getExecution=async()=>{reads++;return {execution:null};};
    f.client.prepareExecution=async()=>{prepares++;return {execution:f.record};};
    await assert.rejects(c.prepare(input),code('RECOVERY_REQUIRED'));
    assert.equal(f.storage.getItem(recoveryKey),before);assert.equal(reads,0);assert.equal(prepares,0);assert.equal(f.sends(),0);
  }
  const f=await fixture(),c=f.controller();await c.proveOwnership();
  f.client.prepareExecution=async()=>{throw Error('network');};await assert.rejects(c.prepare(input));ageRecovery(f);
  const before=f.storage.getItem(recoveryKey);f.client.getActiveExecution=async()=>{throw Error('offline');};
  await assert.rejects(c.prepare(input),/offline/);assert.equal(f.storage.getItem(recoveryKey),before);
});
test('definitive prepare rejection reconciles immediately while unknown failures remain pending',async()=>{
  for(const status of [400,422,408,409,429,500]) {
    const f=await fixture(),c=f.controller();await c.proveOwnership();let reads=0;
    f.client.getActiveExecution=async()=>{reads++;return {execution:null};};
    f.client.prepareExecution=async()=>{throw new RouterSdkError('REJECTED','prepare failed',{status});};
    await assert.rejects(c.prepare(input),code('REJECTED'));
    assert.equal(reads,[400,422].includes(status)?1:0);
    assert.equal(c.getRecovery().phase,[400,422].includes(status)?'CANCELLED':'PREPARE_PENDING');
  }
});
test('recordless ambiguous phases and a different authenticated wallet cannot clear recovery',async()=>{
  const f=await fixture(),c=f.controller();await c.proveOwnership();
  f.storage.setItem(recoveryKey,JSON.stringify({version:1,phase:'WALLET_PENDING',savedAtMs:0}));
  await assert.rejects(c.resume(),code('RECOVERY_REQUIRED'));assert.equal(c.getRecovery().phase,'WALLET_PENDING');
  f.storage.setItem(recoveryKey,JSON.stringify({version:1,phase:'PREPARE_PENDING',savedAtMs:0,wallet:{...wallet,address:'0x'+'33'.repeat(20)}}));
  let reads=0;f.client.getActiveExecution=async()=>{reads++;return {execution:null};};
  await assert.rejects(c.resume(),code('WALLET_CHANGED'));assert.equal(reads,0);assert.equal(c.getRecovery().phase,'PREPARE_PENDING');
});
test('payload digest and reviewed terms cannot change in claim',async()=>{
  const f=await fixture(), c=f.controller();await c.proveOwnership();const review=await c.prepare(input),claim=f.client.claimExecution;
  f.client.claimExecution=async()=>{const data=await claim();data.action.payload.transaction.to=wallet.address;return data;};
  await assert.rejects(c.execute(review,()=>true),code('PROTOCOL_ERROR'));assert.equal(f.sends(),0);assert.equal(c.getRecovery().phase,'CLAIM_PENDING');
});
test('execution transport token auth, request budgets, and response bindings fail closed',async()=>{
  const f=await fixture();let calls=0;
  const sdk=createRouterClient({baseUrl:'https://router.example',publishableKey:'pk_public_123456789',fetch:async(_,init)=>{calls++;assert.equal(init.headers['X-Router-Wallet-Token'],token);assert.equal(init.credentials,'omit');return response({execution:f.record});}});
  await sdk.prepareExecution(input,{walletToken:token});assert.equal(calls,1);
  for(const bad of [{...input,nativeFeeBudgets:[]},{...input,nativeFeeBudgets:[{chainId:wallet.chainId,maxAmountRaw:'0'}]}])await assert.rejects(sdk.prepareExecution(bad,{walletToken:token}),code('INVALID_INPUT'));
  await assert.rejects(sdk.getExecution('other',{walletToken:token}),code('PROTOCOL_ERROR'));
  await assert.rejects(sdk.getExecution(f.record.id),code('INVALID_INPUT'));
  await assert.rejects(sdk.getConfig({walletToken:token}),code('INVALID_INPUT'));
});
test('wallet token in remote errors is redacted and execution is never retried',async()=>{
  let calls=0;const sdk=createRouterClient({baseUrl:'https://router.example',publishableKey:'pk_public_123456789',fetch:async()=>{calls++;return new Response(JSON.stringify(envelope({error:{code:'DENIED',message:token,retryable:false}})),{status:403,headers:{'content-type':'application/json'}});}});
  await assert.rejects(sdk.getExecution('exec-1',{walletToken:token}),error=>error.code==='DENIED'&&!error.message.includes(token));assert.equal(calls,1);
});
test('EVM adapter connects without signing; explicit account selection and chain binding required',async()=>{
  const calls=[],provider={request:async({method,params})=>{calls.push(method);if(method==='eth_accounts')return [wallet.address,'0x'+'22'.repeat(20)];if(method==='eth_chainId')return '0x2105';if(method==='personal_sign')return '0x'+'aa'.repeat(65);if(method==='eth_sendTransaction')return '0x'+'aa'.repeat(32);},on:()=>{}};
  const adapter=createEvmWallet(provider);await assert.rejects(adapter.connect(),code('ACCOUNT_SELECTION_REQUIRED'));
  await adapter.connect(accounts=>accounts[0]);assert.ok(!calls.includes('personal_sign'));assert.ok(!calls.includes('eth_sendTransaction'));
  await assert.rejects(adapter.signMessage('challenge',{...wallet,chainId:'eip155:1'}),code('WALLET_CHANGED'));
  await adapter.signMessage('challenge',wallet);assert.ok(calls.includes('personal_sign'));
});
test('EVM calldata quantities and Phantom unsupported execution stay blocked',async()=>{
  const f=await fixture();assert.equal(evmTransaction(f.action,f.record).type,'0x2');
  for(const key of ['value','gas','chainId']){const action=structuredClone(f.action);action.payload.transaction[key]='0x0';assert.throws(()=>evmTransaction(action,f.record),code('PROTOCOL_ERROR'));}
  const address='11111111111111111111111111111112',phantom=createPhantomWallet({connect:async()=>({publicKey:{toString:()=>address}}),publicKey:{toString:()=>address},signMessage:async()=>({signature:new Uint8Array(64)})});
  const selected=await phantom.connect();assert.equal(selected.address,address);assert.equal((await phantom.signMessage('challenge',selected)).length,64);
  await assert.rejects(phantom.sendTransaction(),code('WALLET_ACTION_UNSUPPORTED'));
});
test('ownership challenge binds app, origin, wallet, nonce, expiry and rejects appended signing instructions',async()=>{
  const expiresAtMs=Date.now()+60000, challengeId='wc_'+'ab'.repeat(24), appId='app-test';
  const message=['Instinct Router wallet-control proof','This proves wallet control only. It does not authorize a transaction or transfer.',
    'App: '+appId,'Origin: server','Chain: '+wallet.chainId,'Wallet: '+wallet.address,'Nonce: '+challengeId,'Expires: '+expiresAtMs].join('\n');
  for(const mutation of [null,'suffix','origin','wallet','app']) {
    const value={appId,challengeId,message,expiresAtMs,wallet};
    if(mutation==='suffix')value.message+='\nSign another transaction';
    if(mutation==='origin')value.message=value.message.replace('Origin: server','Origin: https://other.example');
    if(mutation==='wallet')value.wallet={...wallet,address:'0x'+'22'.repeat(20)};
    if(mutation==='app')value.appId='app-other';
    const sdk=createRouterClient({baseUrl:'https://router.example',publishableKey:'pk_public_123456789',fetch:async()=>response(value)});
    if(mutation)await assert.rejects(sdk.createWalletChallenge(wallet),code('PROTOCOL_ERROR'));
    else assert.equal((await sdk.createWalletChallenge(wallet)).message,message);
  }
});
test('receipt credits, transaction identity and observation timeline remain execution-bound',async()=>{
  const f=await fixture(),hash='0x'+'aa'.repeat(32),now=Date.now();
  f.record.status='COMPLETE';f.record.nextAction=1;f.record.submissions=[{actionId:f.action.id,hash}];
  f.record.timeline={preparedAtMs:now-1000,claimedAtMs:now-800,submittedAtMs:now-600,completedAtMs:now};
  f.record.receipt={chainId:wallet.chainId,transactionHash:hash,blockNumberRaw:'1000',blockHash:'0x'+'bb'.repeat(32),observedAtMs:now,confirmations:12,destinationCredit:{asset:destination,recipient:wallet.address,amountRaw:'1'},actualNativeFeeRaw:'100'};
  for(const mutation of [null,'hash','recipient','credit','timeline','failedMissingReceipt']) {
    const row=structuredClone(f.record);
    if(mutation==='hash')row.receipt.transactionHash='0x'+'cc'.repeat(32);
    if(mutation==='recipient')row.receipt.destinationCredit.recipient='0x'+'33'.repeat(20);
    if(mutation==='credit')row.receipt.destinationCredit.amountRaw='0';
    if(mutation==='timeline')row.timeline.completedAtMs=now-1000;
    if(mutation==='failedMissingReceipt'){row.status='FAILED';delete row.receipt;}
    const sdk=createRouterClient({baseUrl:'https://router.example',publishableKey:'pk_public_123456789',fetch:async()=>response({execution:row})});
    if(mutation)await assert.rejects(sdk.getExecution(row.id,{walletToken:token}),code('PROTOCOL_ERROR'));
    else assert.equal((await sdk.getExecution(row.id,{walletToken:token})).execution.receipt.destinationCredit.amountRaw,'1');
  }
});

test('preparation binds every requested policy and sums native cost components',async()=>{
  const mutations=[
    row=>{row.request.slippageBps=100;},row=>{row.request.maxFeeBps=1000;},row=>{row.request.maxPriceImpactBps=1000;},
    row=>{row.request.optimization.objective='FASTEST';},row=>{row.request.optimization.maxOutputShortfallBps=100;},
    row=>{row.request.nativeFeeBudgets[0].maxAmountRaw='30000000000000';},row=>{row.request.amountRaw='50000000000001';},
    row=>{row.request.recipient='0x'+'33'.repeat(20);},row=>{row.request.source.decimals=17;},
    row=>{row.plan.nativeCosts=[{chainId:wallet.chainId,amountRaw:'11000000000000'},{chainId:wallet.chainId,amountRaw:'11000000000000'}];},
  ];
  for(const mutate of mutations){const f=await fixture(),row=structuredClone(f.record);mutate(row);
    const sdk=createRouterClient({baseUrl:'https://router.example',publishableKey:'pk_public_123456789',fetch:async()=>response({execution:row})});
    await assert.rejects(sdk.prepareExecution(input,{walletToken:token}),code('PROTOCOL_ERROR'));
  }
});
test('terminal receipt is required; failed proof cannot claim successful credit',async()=>{
  const f=await fixture(),hash='0x'+'aa'.repeat(32);f.record.status='COMPLETE';f.record.nextAction=1;f.record.submissions=[{actionId:f.action.id,hash}];
  assert.throws(()=>validateRecord(f.record),code('PROTOCOL_ERROR'));
  const receipt={chainId:wallet.chainId,transactionHash:hash,blockNumberRaw:'100',blockHash:'0x'+'bb'.repeat(32),observedAtMs:Date.now(),confirmations:12,destinationCredit:{asset:destination,recipient:wallet.address,amountRaw:'1'}};
  f.record.receipt=receipt;validateRecord(f.record);
  f.record.status='FAILED';f.record.nextAction=0;assert.throws(()=>validateRecord(f.record),code('PROTOCOL_ERROR'));
  delete receipt.destinationCredit;validateRecord(f.record);
});
test('recovery revisions never erase or rewrite submissions, receipt or timeline evidence',async()=>{
  const f=await fixture(),hash='0x'+'aa'.repeat(32),now=Date.now();
  const prior={...structuredClone(f.record),revision:2,status:'SUBMITTED',claimedActionId:f.action.id,
    submissions:[{actionId:f.action.id,hash}],timeline:{preparedAtMs:now-1000,claimedAtMs:now-800,submittedAtMs:now-600}};
  const complete={...structuredClone(prior),revision:3,status:'COMPLETE',nextAction:1,claimedActionId:null,
    timeline:{...prior.timeline,completedAtMs:now},receipt:{chainId:wallet.chainId,transactionHash:hash,blockNumberRaw:'100',blockHash:'0x'+'bb'.repeat(32),observedAtMs:now,confirmations:12,destinationCredit:{asset:destination,recipient:wallet.address,amountRaw:'1'}}};
  validateRecord(complete,prior);
  const mutations=[row=>{delete row.timeline;},row=>{delete row.timeline.submittedAtMs;},row=>{row.timeline.claimedAtMs++;},
    row=>{row.submissions=[];},row=>{row.submissions[0].hash='0x'+'cc'.repeat(32);},row=>{row.status='READY';row.nextAction=0;row.claimedActionId=null;delete row.receipt;},
    row=>{row.revision=2;}];
  for(const mutate of mutations){const row=structuredClone(complete);mutate(row);assert.throws(()=>validateRecord(row,prior),code('PROTOCOL_ERROR'));}
  const late=structuredClone(complete);late.revision++;
  for(const mutate of [row=>{delete row.receipt;},row=>{row.receipt.blockHash='0x'+'cc'.repeat(32);},row=>{row.receipt.actualNativeFeeRaw='1';}]){
    const row=structuredClone(late);mutate(row);assert.throws(()=>validateRecord(row,complete),code('PROTOCOL_ERROR'));
  }
});

async function crossChainFixture() {
  const f = await fixture(), requestId = '0x'+'dd'.repeat(32);
  const solana = {chainId:'solana:mainnet',address:'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',decimals:6};
  const recipient = '47YyVUMwerrz76mCrpgFP3iDva1Vt4ZxpSuxo6AhwabT';
  f.record.plan.destination = solana; f.record.request.destination = solana;
  f.record.plan.recipient = recipient; f.record.request.recipient = recipient;
  f.record.plan.quoteIds = ['relay:'+requestId];
  const hash = '0x'+'aa'.repeat(32), observedAtMs = Date.now();
  f.record.status = 'SUBMITTED'; f.record.revision = 2; f.record.claimedActionId = f.action.id;
  f.record.submissions = [{actionId:f.action.id,hash}];
  f.record.receipt = {chainId:wallet.chainId,transactionHash:hash,blockNumberRaw:'1000',blockHash:'0x'+'bb'.repeat(32),observedAtMs,confirmations:12};
  const delivery = {chainId:solana.chainId,transactionHash:encodeBase58(new Uint8Array(64).fill(2)),blockNumberRaw:'123456',blockHash:recipient,
    observedAtMs,commitment:'finalized',destinationCredit:{asset:solana,recipient,amountRaw:'1'},
    attribution:{provider:'relay',requestId,sourceTransactionHash:hash}};
  return {...f,delivery};
}
test('cross-chain completion needs independently finalized destination proof; source-only confirmation stays pending',async()=>{
  const f = await crossChainFixture(); validateRecord(f.record);
  const complete = {...structuredClone(f.record),revision:3,status:'COMPLETE',nextAction:1,claimedActionId:null};
  assert.throws(()=>validateRecord(complete),code('PROTOCOL_ERROR'));
  complete.receipt.destinationCredit = f.delivery.destinationCredit;
  assert.throws(()=>validateRecord(complete),code('PROTOCOL_ERROR'));
  delete complete.receipt.destinationCredit;
  complete.destinationReceipt = f.delivery; validateRecord(complete,f.record);
  const failed = {...structuredClone(f.record),status:'FAILED'};validateRecord(failed);
  failed.destinationReceipt = f.delivery;assert.throws(()=>validateRecord(failed),code('PROTOCOL_ERROR'));
});
test('Solana delivery binds chain, signature, block, finality, asset, recipient, amount and bridge attribution',async()=>{
  const f = await crossChainFixture();
  const complete = {...structuredClone(f.record),revision:3,status:'COMPLETE',nextAction:1,claimedActionId:null,destinationReceipt:f.delivery};
  const mutations = [
    row=>{row.destinationReceipt.chainId=wallet.chainId;},
    row=>{row.destinationReceipt.transactionHash='0x'+'cc'.repeat(32);},
    row=>{row.destinationReceipt.transactionHash='2'.repeat(64);},
    row=>{row.destinationReceipt.blockNumberRaw='-1';},row=>{row.destinationReceipt.blockHash='2'.repeat(32);},
    row=>{row.destinationReceipt.commitment='confirmed';},row=>{row.destinationReceipt.observedAtMs=Date.now()+10000;},
    row=>{row.destinationReceipt.destinationCredit.asset=destination;},
    row=>{row.destinationReceipt.destinationCredit.recipient=wallet.address;},
    row=>{row.destinationReceipt.destinationCredit.amountRaw='0';},row=>{delete row.destinationReceipt.destinationCredit;},
    row=>{row.destinationReceipt.attribution.provider='untrusted';},
    row=>{row.destinationReceipt.attribution.basis='PROVIDER_STATUS_AND_CHAIN_CREDIT';},
    row=>{row.destinationReceipt.attribution.unexpected=true;},
    row=>{row.destinationReceipt.attribution.requestId='0x'+'ee'.repeat(32);},
    row=>{row.destinationReceipt.attribution.sourceTransactionHash='0x'+'ee'.repeat(32);},
    row=>{delete row.receipt;},row=>{row.receipt.destinationCredit=f.delivery.destinationCredit;},
  ];
  for (const mutate of mutations) { const row=structuredClone(complete);mutate(row);assert.throws(()=>validateRecord(row),code('PROTOCOL_ERROR')); }
  validateRecord(complete);
  for (const mutate of [row=>{delete row.destinationReceipt;},row=>{row.destinationReceipt.blockNumberRaw='123457';},row=>{row.destinationReceipt.transactionHash='3'.repeat(87);}]) {
    const row=structuredClone(complete);row.revision++;mutate(row);assert.throws(()=>validateRecord(row,complete),code('PROTOCOL_ERROR'));
  }
});
test('cross-chain recovery waits for destination delivery without another wallet send',async()=>{
  const f = await crossChainFixture();
  f.record.status='READY';f.record.revision=0;f.record.claimedActionId=null;f.record.submissions=[];delete f.record.receipt;
  let refreshes=0;
  f.client.refreshExecution=async()=>{
    if (!f.record.receipt) f.record.receipt={chainId:wallet.chainId,transactionHash:f.delivery.attribution.sourceTransactionHash,
      blockNumberRaw:'1000',blockHash:'0x'+'bb'.repeat(32),observedAtMs:Date.now(),confirmations:12};
    if (++refreshes===2) { f.record.status='COMPLETE';f.record.nextAction=1;f.record.claimedActionId=null;f.record.destinationReceipt=f.delivery; }
    f.record.revision++;return {execution:structuredClone(f.record)};
  };
  const c=f.controller();await c.proveOwnership();
  const review=await c.prepare({...input,destination:f.record.plan.destination,recipient:f.record.plan.recipient});
  await c.execute(review,()=>true);assert.equal(f.sends(),1);
  const sourceConfirmed=await c.resume();assert.equal(sourceConfirmed.status,'SUBMITTED');assert.ok(sourceConfirmed.receipt);assert.equal(sourceConfirmed.destinationReceipt,undefined);
  assert.equal(c.getRecovery().phase,'SUBMITTED');
  const complete=await c.resume();assert.equal(complete.status,'COMPLETE');assert.deepEqual(complete.destinationReceipt,f.delivery);assert.equal(f.sends(),1);
});

async function twoActionFixture() {
  const f = await fixture();
  const approve = {id:'relay-usdc-approve',chainId:wallet.chainId,payload:structuredClone(f.action.payload)};
  const deposit = {id:'relay-usdc-deposit',chainId:wallet.chainId,payload:structuredClone(f.action.payload)};
  const usdc = {...destination};
  const solana = {chainId:'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',address:'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',decimals:6};
  const word = value => value.replace(/^0x/,'').padStart(64,'0');
  approve.payload.transaction = {...approve.payload.transaction,to:usdc.address,value:'0x0',data:'0x095ea7b3'+word('0x4cd00e387622c35bddb9b4c962c136462338bc31')+word('186a0')};
  deposit.payload.transaction = {...deposit.payload.transaction,to:'0x4cd00e387622c35bddb9b4c962c136462338bc31',value:'0x0',data:'0xe8017952'+word(wallet.address)+word(usdc.address)+word('186a0')+'dd'.repeat(32)};
  for (const action of [approve,deposit]) action.payload.relay = {requestId:'0x'+'ee'.repeat(32),orderId:'0x'+'dd'.repeat(32)};
  f.record.plan.quoteIds = ['relay:0x'+'ee'.repeat(32)];
  f.record.plan = {...f.record.plan,source:usdc,destination:solana,recipient:'47YyVUMwerrz76mCrpgFP3iDva1Vt4ZxpSuxo6AhwabT',amountRaw:'100000',actions:[]};
  for (const action of [approve,deposit]) f.record.plan.actions.push({id:action.id,chainId:action.chainId,payloadHash:await payloadHash(action.payload)});
  f.client.claimExecution=async()=>{const action=[approve,deposit][f.record.nextAction];f.record.status='CLAIMED';f.record.claimedActionId=action.id;f.record.revision++;return {execution:structuredClone(f.record),action};};
  f.client.submitExecution=async(_,{transactionHash})=>{f.record.status='SUBMITTED';f.record.revision++;f.record.submissions.push({actionId:f.record.claimedActionId,hash:transactionHash});return {execution:structuredClone(f.record)};};
  f.client.refreshExecution=async()=>{f.record.status='READY';f.record.nextAction=1;f.record.claimedActionId=null;f.record.revision++;return {execution:structuredClone(f.record)};};
  let sends=0;
  f.adapter.sendTransaction=async()=>{sends++;return '0x'+(sends===1?'aa':'cc').repeat(32);};
  return {...f,approve,deposit,sends:()=>sends};
}

test('confirmed intermediate action saves a fresh review and clears prior hash only after advancement',async()=>{
  const f=await twoActionFixture(),c=f.controller();await c.proveOwnership();const review=await c.prepare(input);
  await c.execute(review,()=>true);assert.equal(c.getRecovery().transactionHash,'0x'+'aa'.repeat(32));
  const next=await c.resume();assert.equal(next.status,'READY');assert.equal(next.nextAction,1);
  assert.equal(c.getRecovery().phase,'REVIEW');assert.equal(c.getRecovery().transactionHash,undefined);assert.equal(c.getRecovery().walletRttMs,undefined);assert.equal(f.sends(),1);
  const fresh=f.controller();await fresh.proveOwnership();await fresh.resume();assert.equal(f.sends(),1);
  await fresh.execute(fresh.getRecovery().record,()=>true);assert.equal(f.sends(),2);assert.equal(fresh.getRecovery().transactionHash,'0x'+'cc'.repeat(32));
});

test('USDC wallet actions reject unlimited approvals, other spenders, token changes and altered deposits',async()=>{
  const f=await twoActionFixture();
  const mutations=[
    action=>{action.payload.transaction.value='0x1';},action=>{action.payload.transaction.to=wallet.address;},
    action=>{action.payload.transaction.data+='00';},
    action=>{action.payload.transaction.data=action.payload.transaction.data.slice(0,-64)+'f'.repeat(64);},
    action=>{action.payload.transaction.data=action.payload.transaction.data.replace('4cd00e387622c35bddb9b4c962c136462338bc31','1'.repeat(40));},
  ];
  evmTransaction(f.approve,f.record);
  for(const mutate of mutations){const action=structuredClone(f.approve);mutate(action);assert.throws(()=>evmTransaction(action,f.record),code('PROTOCOL_ERROR'));}
  f.record.nextAction=1;evmTransaction(f.deposit,f.record);
  for(const mutate of [action=>{action.payload.relay.orderId='0x'+'ee'.repeat(32);},action=>{action.payload.transaction.data=action.payload.transaction.data.replace(wallet.address.slice(2),'2'.repeat(40));},action=>{action.payload.transaction.data=action.payload.transaction.data.replace('186a0','186a1');}]){
    const action=structuredClone(f.deposit);mutate(action);assert.throws(()=>evmTransaction(action,f.record),code('PROTOCOL_ERROR'));
  }
  const row=structuredClone(f.record);row.plan.source.address=wallet.address;assert.throws(()=>evmTransaction(f.deposit,row),code('PROTOCOL_ERROR'));
});

test('interrupted intermediate confirmation retains hash and cannot sign a new action',async()=>{
  const f=await twoActionFixture(),c=f.controller();await c.proveOwnership();const review=await c.prepare(input);await c.execute(review,()=>true);
  const original=f.client.refreshExecution;f.client.refreshExecution=async()=>{throw Error('offline');};
  await assert.rejects(c.resume());assert.equal(c.getRecovery().phase,'SUBMITTED');assert.equal(c.getRecovery().transactionHash,'0x'+'aa'.repeat(32));
  await assert.rejects(c.execute(review,()=>true),code('RECOVERY_REQUIRED'));assert.equal(f.sends(),1);
  f.client.refreshExecution=original;await c.resume();assert.equal(c.getRecovery().phase,'REVIEW');assert.equal(f.sends(),1);
});

test('existing bounded USDC allowance permits an exact deposit-only fresh plan',async()=>{
  const f=await twoActionFixture();f.record.plan.actions=f.record.plan.actions.slice(1);
  assert.equal(evmTransaction(f.deposit,f.record).value,'0x0');
  const wrong=structuredClone(f.record);wrong.nextAction=1;assert.throws(()=>evmTransaction(f.deposit,wrong),code('PROTOCOL_ERROR'));
});

test('automatic native fee budgets preserve null policy and a finite reviewed reserve',async()=>{
  const f=await fixture();f.record.request.maxFeeBps=null;f.record.request.nativeFeeBudgets=[{chainId:wallet.chainId,maxAmountRaw:null}];
  const automatic={...input,maxFeeBps:null,nativeFeeBudgets:[{chainId:wallet.chainId,maxAmountRaw:null}]};
  let sent;
  const sdk=createRouterClient({baseUrl:'https://router.example',publishableKey:'pk_public_123456789',fetch:async(_,init)=>{sent=JSON.parse(init.body);return response({execution:f.record});}});
  await sdk.prepareExecution(automatic,{walletToken:token});assert.equal(sent.maxFeeBps,null);assert.equal(sent.nativeFeeBudgets[0].maxAmountRaw,null);
  assert.equal(f.record.plan.nativeCosts[0].amountRaw,'10000000');
  for(const maxAmountRaw of [undefined,'',false,0,'0','null','-1'])await assert.rejects(sdk.prepareExecution({...automatic,nativeFeeBudgets:[{chainId:wallet.chainId,maxAmountRaw}]},{walletToken:token}),code('INVALID_INPUT'));
  await assert.rejects(sdk.prepareExecution({...automatic,nativeFeeBudgets:undefined},{walletToken:token}),code('INVALID_INPUT'));
  f.record.request.nativeFeeBudgets=[{chainId:wallet.chainId,maxAmountRaw:'20000000000000'}];
  await assert.rejects(sdk.prepareExecution(automatic,{walletToken:token}),code('PROTOCOL_ERROR'));
  f.record.request.nativeFeeBudgets=automatic.nativeFeeBudgets;f.record.request.maxFeeBps=500;
  await assert.rejects(sdk.prepareExecution(automatic,{walletToken:token}),code('PROTOCOL_ERROR'));
});

async function progressFixture() {
  const f=await crossChainFixture();f.record.plan.actions[0].id='relay-native-deposit';f.record.claimedActionId='relay-native-deposit';f.record.submissions[0].actionId='relay-native-deposit';
  const progress={routeId:f.record.plan.routeId,actionId:'relay-native-deposit',sourceTransactionHash:f.record.submissions[0].hash,stage:'SOURCE_CONFIRMED',observedAtMs:Date.now(),sourceConfirmations:2,requiredSourceConfirmations:12};
  return {...f,progress};
}
test('display-only progress binds action, route, source hash, policy, observation freshness and destination proof',async()=>{
  const f=await progressFixture();validateProgress(f.progress,f.record);
  const destination={chainId:f.record.plan.destination.chainId,transactionHash:f.delivery.transactionHash,asset:f.record.plan.destination,recipient:f.record.plan.recipient,amountRaw:'1',commitment:'confirmed'};
  const progress={...f.progress,stage:'DESTINATION_CONFIRMED',destination};validateProgress(progress,f.record);
  const mutations=[row=>{row.routeId='other';},row=>{row.actionId='relay-usdc-approve';},row=>{row.sourceTransactionHash='0x'+'bb'.repeat(32);},row=>{row.sourceConfirmations=0;},row=>{row.requiredSourceConfirmations=1;},row=>{row.observedAtMs=Date.now()-16000;},row=>{row.observedAtMs=Date.now()+3000;},row=>{row.extra='x';},row=>{row.destination.asset=source;},row=>{row.destination.recipient=wallet.address;},row=>{row.destination.amountRaw='0';},row=>{row.destination.commitment='processed';},row=>{row.destination.transactionHash='0x'+'aa'.repeat(32);},row=>{row.destination.extra=true;}];
  for(const mutate of mutations){const row=structuredClone(progress);mutate(row);assert.throws(()=>validateProgress(row,f.record),code('PROTOCOL_ERROR'));}
  const noAction=structuredClone(f.record);noAction.plan.actions=[];assert.throws(()=>validateProgress(progress,noAction),code('PROTOCOL_ERROR'));
  const stale=structuredClone(f.record);stale.timeline={submittedAtMs:Date.now()+1};assert.throws(()=>validateProgress(progress,stale),code('PROTOCOL_ERROR'));
});
test('reported submissions refresh in one call; progress stays transient and clears on errors and terminal status',async()=>{
  const f=await progressFixture();let gets=0,refreshes=0;
  f.client.getExecution=async()=>{gets++;throw Error('unneeded get');};
  f.client.refreshExecution=async()=>{refreshes++;return {execution:structuredClone(f.record),progress:f.progress};};
  f.storage.setItem('instinct-router-recovery-v1',JSON.stringify({version:1,phase:'SUBMITTED',record:f.record,transactionHash:f.progress.sourceTransactionHash}));
  const c=f.controller();await c.proveOwnership();await c.resume();assert.equal(gets,0);assert.equal(refreshes,1);assert.deepEqual(c.getProgress(),f.progress);assert.equal(c.getRecovery().progress,undefined);
  const fresh=f.controller();assert.equal(fresh.getProgress(),null);
  f.client.refreshExecution=async()=>{throw Error('offline');};await assert.rejects(c.resume());assert.equal(c.getProgress(),null);assert.equal(f.sends(),0);
  f.client.refreshExecution=async()=>({execution:{...structuredClone(f.record),revision:3,status:'COMPLETE',nextAction:1,claimedActionId:null,destinationReceipt:f.delivery}});
  await c.resume();assert.equal(c.getProgress(),null);assert.equal(f.sends(),0);
});
test('mismatched refresh progress is rejected before recovery state changes',async()=>{
  const f=await progressFixture();f.storage.setItem('instinct-router-recovery-v1',JSON.stringify({version:1,phase:'SUBMITTED',record:f.record}));
  f.client.refreshExecution=async()=>({execution:structuredClone(f.record),progress:{...f.progress,routeId:'wrong'}});
  const c=f.controller();await c.proveOwnership();await assert.rejects(c.resume(),code('PROTOCOL_ERROR'));assert.equal(c.getProgress(),null);assert.deepEqual(c.getRecovery().record,f.record);assert.equal(f.sends(),0);
});

test('refresh HTTP response validates progress before exposing it to callers',async()=>{
  const f=await progressFixture();let progress=f.progress;
  const sdk=createRouterClient({baseUrl:'https://router.example',publishableKey:'pk_public_123456789',fetch:async()=>response({execution:f.record,progress})});
  assert.deepEqual((await sdk.refreshExecution(f.record.id,{walletToken:token})).progress,f.progress);
  for(const bad of [null,{...f.progress,stage:'COMPLETE'},{...f.progress,routeId:'wrong'}]){progress=bad;await assert.rejects(sdk.refreshExecution(f.record.id,{walletToken:token}),code('PROTOCOL_ERROR'));}
});

test('known deposit hash recovery can expose fresh progress without signing or resubmission',async()=>{
  const f=await progressFixture();f.record.status='RECOVERY_REQUIRED';validateProgress(f.progress,f.record);
  f.storage.setItem('instinct-router-recovery-v1',JSON.stringify({version:1,phase:'RECOVERY_REQUIRED',record:f.record,transactionHash:f.progress.sourceTransactionHash}));
  let gets=0,refreshes=0,submits=0;
  f.client.getExecution=async()=>{gets++;return {execution:structuredClone(f.record)};};
  f.client.refreshExecution=async()=>{refreshes++;return {execution:structuredClone(f.record),progress:f.progress};};
  f.client.submitExecution=async()=>{submits++;throw Error('Do not submit a known reported hash');};
  const c=f.controller();await c.proveOwnership();await c.resume();assert.equal(c.getProgress().sourceTransactionHash,f.progress.sourceTransactionHash);
  assert.equal(gets,1);assert.equal(refreshes,1);assert.equal(submits,0);assert.equal(f.sends(),0);
  const wrong=structuredClone(f.progress);wrong.sourceTransactionHash='0x'+'cc'.repeat(32);assert.throws(()=>validateProgress(wrong,f.record),code('PROTOCOL_ERROR'));
});
