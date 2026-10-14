import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { encodeBase58 } from '../packages/sdk/src/wallets.js';
import { payloadHash } from '../packages/sdk/src/execution-validation.js';

// Exercise the browser entry with its real SDK, without a server, extension or funds.
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === '/sdk/execution-validation.js') return { url: new URL('../packages/sdk/src/execution-validation.js', import.meta.url).href, shortCircuit: true };
  if (specifier === '/sdk/index.js') return { url: new URL('../packages/sdk/src/index.js', import.meta.url).href, shortCircuit: true };
  return nextResolve(specifier, context);
} });
const BASE = 'eip155:8453', SOL = 'solana:mainnet';
const SENDER = '0xd627e435b88c1bf00244f7f3acd14b7f6db64b2e';
const RECIPIENT = '47YyVUMwerrz76mCrpgFP3iDva1Vt4ZxpSuxo6AhwabT';
const OTHER_RECIPIENT = 'So11111111111111111111111111111111111111112';
const HASH = '0x' + 'a'.repeat(64);
const SOURCE = {chainId:BASE,address:'0x'+'0'.repeat(40),decimals:18};
const DESTINATION = {chainId:SOL,address:'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',decimals:6};
class Element {
  value = ''; dataset = {}; options = []; children = []; hidden = false; disabled = false; textContent = ''; handlers = new Map();
  append(...children) { for (const child of children) { this.children.push(child); this.options.push(child); if (this.options.length === 1) this.value = child.value; } }
  replaceChildren() { this.children = []; this.options = []; this.value = ''; }
  addEventListener(name, fn) { this.handlers.set(name, [...(this.handlers.get(name) ?? []), fn]); }
  dispatchEvent(event) { for (const fn of this.handlers.get(event.type) ?? []) fn(event); }
  setCustomValidity(text) { this.validationMessage = text; }
  reportValidity() { return !this.validationMessage; }
  setAttribute(name,value) { (this.attributes??={})[name]=value; }
  focus() { this.focused = true; }
  scrollIntoView() {}
  click() { assert.equal(this.disabled,false,'Control should be enabled'); return this.onclick?.(); }
}
const flatten=node=>[node,...node.children.flatMap(flatten)];
const reviewNodes=f=>flatten(f.$('execution-review'));
const reviewText=f=>reviewNodes(f).map(row=>row.textContent).join(' ');
const reviewTitle=f=>reviewNodes(f).find(row=>row.className==='trade-progress-title')?.textContent;
let fixtureNumber = 0;
async function setup({supported = true, storage = new Map(), usdc = false, noPresetCaps = false, settlementProgress = false, genericToken = false, profileOnly = false, solanaSource = false, providerManaged = false, providerSwap = false} = {}) {
  if(providerManaged){genericToken=true;profileOnly=true;}
  if (genericToken) usdc = true;
  const fields = new Map(), $ = id => { if (!fields.has(id)) fields.set(id,new Element()); return fields.get(id); };
  const calls = [], apiCalls = [], host = new Element();
  host.ethereum = {isMetaMask:true,on() {}, async request(request) {
    calls.push(request);
    if (['eth_requestAccounts','eth_accounts'].includes(request.method)) return [SENDER];
    if (request.method === 'eth_chainId') return '0x2105';
    if (request.method === 'personal_sign') return '0x'+'b'.repeat(130);
    if (request.method === 'eth_sendTransaction') return calls.filter(row=>row.method==='eth_sendTransaction').length===1?HASH:'0x'+'c'.repeat(64);
    throw Error('Unexpected wallet request: '+request.method);
  }};
  host.phantom = {solana:{isPhantom:true,publicKey:{toString:()=>RECIPIENT},on(){},
    async connect() { return {publicKey:this.publicKey}; },
    async signMessage() { throw Error('Destination must not sign'); }}};
  globalThis.document = {getElementById:$,createElement:()=>new Element()};
  globalThis.window = host;
  const locks = new Set();
  host.navigator={locks:{async request(name,options,callback){assert.equal(options.ifAvailable,true);if(locks.has(name))return callback(null);locks.add(name);try{return await callback({name});}finally{locks.delete(name);}}}};
  globalThis.localStorage = {getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)};
  const source = solanaSource ? {chainId:'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',address:'11111111111111111111111111111111',decimals:9} : usdc ? {...SOURCE,address:genericToken?'0x'+'3'.repeat(40):'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',decimals:6} : SOURCE;
  const destination = solanaSource ? SOURCE : usdc ? {...DESTINATION,chainId:'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'} : DESTINATION;
  $('source').value='base-eth'; $('destination').value='sol-usdc'; $('amount').value=solanaSource?'0.000001':usdc?'0.1':'0.00005';
  $('route-scope').value='ALL'; $('objective').value='BALANCED'; $('slippage').value='0.5'; $('max-fee').value=noPresetCaps?'':'5'; $('native-budget').value=noPresetCaps?'':'0.00002';
  $('exact-action').hidden=true; $('settlement-stop').hidden=true;
  const config = {chains:[{chainId:BASE,name:'Base'},{chainId:solanaSource?source.chainId:SOL,name:'Solana'}],
    assets:[{id:'base-eth',symbol:solanaSource?'SOL':genericToken?'TKN':usdc?'USDC':'ETH',...source},{id:'sol-usdc',symbol:solanaSource?'ETH':'USDC',...destination}],
    capabilities:{walletExecution:true},execution:{enabled:true,...(profileOnly?{executionProfiles:[{recipeId:'relay-base-direct-v1',sourceChainId:BASE,destinationChainId:destination.chainId,sourceAssetTypes:['ERC20'],destinationAssetTypes:['NATIVE','SPL'],requiresFreshValidation:true}]}:{}),supportedRoutes:supported&&!profileOnly?[{recipeId:'relay-base-solana',source,destination}]:[]}};
  const transaction = {chainId:'0x2105',type:'0x2',from:SENDER,to:'0x'+'c'.repeat(40),data:'0x12345678',
    value:'0x2d79883d2000',gas:'0x5208',maxFeePerGas:'0x1',maxPriorityFeePerGas:'0x1',accessList:[]};
  const word = value => value.replace(/^0x/,'').padStart(64,'0');
  const meta = {requestId:'0x'+'d'.repeat(64),orderId:'0x'+'e'.repeat(64),...(genericToken?{tokenIdentity:{address:source.address,decimals:source.decimals,codeSha256:'c'.repeat(64)}}:{})};
  const approval = {...transaction,to:source.address,value:'0x0',data:'0x095ea7b3'+word('0x4cd00e387622c35bddb9b4c962c136462338bc31')+word('186a0')};
  const deposit = {...transaction,to:'0x4cd00e387622c35bddb9b4c962c136462338bc31',value:'0x0',data:'0xe8017952'+word(SENDER)+word(source.address)+word('186a0')+meta.orderId.slice(2)};
  const actions = usdc ? [{id:genericToken?'relay-token-approve':'relay-usdc-approve',chainId:BASE,payload:{type:'EVM_TRANSACTION',transaction:approval,relay:meta}},
    {id:genericToken?'relay-token-deposit':'relay-usdc-deposit',chainId:BASE,payload:{type:'EVM_TRANSACTION',transaction:deposit,relay:meta}}] : [{id:settlementProgress?'relay-native-deposit':'action-1',chainId:BASE,payload:{type:'EVM_TRANSACTION',transaction}}];
  if(providerManaged){
    const expiresAtMs=Date.now()+60000;
    actions.forEach((action,index)=>{action.id=index===0?'relay-provider-approve':providerSwap?'relay-provider-swap':'relay-provider-deposit';action.payload={type:'PROVIDER_REVIEWED_TRANSACTION',version:1,vm:'EVM',providerId:'relay',verification:'TRUSTED_SERVER_FRESH_RFQ',kind:index===0?'TOKEN_APPROVAL':providerSwap?'SWAP':'FUNDING',rfq:{requestId:meta.requestId,commitmentHash:'a'.repeat(64),expiresAtMs},spending:{asset:source,amountRaw:'100000',nativeValueRaw:'0',nativeFeeCapRaw:'21000',...(index===0?{approval:{spender:'0x4cd00e387622c35bddb9b4c962c136462338bc31',amountRaw:'100000'}}:{})},transaction:action.payload.transaction};});
    config.execution.executionProfiles=[{recipeId:'relay-provider-managed-v1',sourceChainIds:[BASE],destinationChainIds:[destination.chainId],sourceAssetTypes:['NATIVE','ERC20','SPL'],destinationAssetTypes:['NATIVE','ERC20','SPL'],requiresFreshValidation:true,verification:'PROVIDER_MANAGED'}];
  }
  if(providerManaged)for(const action of actions)action.payload.bindings={requestId:meta.requestId,quoteHash:'a'.repeat(64),source,destination,sender:SENDER,recipient:RECIPIENT,amountRaw:'100000',minimumOutRaw:'100000',slippageBps:50,expiresAtMs:action.payload.rfq.expiresAtMs,transactionHash:await payloadHash(action.payload.transaction)};
  const publicActions=[];
  for (const action of actions) publicActions.push({id:action.id,chainId:source.chainId,payloadHash:await payloadHash(action.payload)});
  let record, approvalConfirmed = false, observedProgress;
  const getInput = async () => ({source,destination,amount:$('amount').value,sender:$('sender').value,
    recipient:$('recipient').value,slippageBps:50,maxFeeBps:$('max-fee').value.trim()===''?null:500,objective:'BALANCED'});
  const client = {
    async createWalletChallenge(wallet) { apiCalls.push('challenge'); return {wallet,challengeId:'challenge-1',message:'Prove wallet ownership',expiresAtMs:Date.now()+60000}; },
    async verifyWallet() { apiCalls.push('verify'); return {wallet:solanaSource?{chainId:source.chainId,address:RECIPIENT}:{chainId:BASE,address:SENDER},walletToken:'t'.repeat(43),expiresAtMs:Date.now()+60000}; },
    async prepareExecution(input) {
      apiCalls.push('prepare'); const expiresAtMs=providerManaged?actions[0].payload.rfq.expiresAtMs:Date.now()+60000;
      record={id:'execution-1',reviewHash:'d'.repeat(64),revision:0,status:'READY',nextAction:0,claimedActionId:null,submissions:[],
        request:{source,destination,sender:input.sender,recipient:input.recipient,amountRaw:solanaSource?'1000':usdc?'100000':'50000000000000',
          slippageBps:50,maxFeeBps:input.maxFeeBps,optimization:{objective:input.objective},nativeFeeBudgets:input.nativeFeeBudgets},
        plan:{...(providerManaged?{providerRoute:{provider:'relay',mode:'PROVIDER_MANAGED',requestId:meta.requestId,quoteHash:'a'.repeat(64),sourceVm:'EVM',destinationVm:'SOLANA',sourceConfirmations:12,destinationConfirmations:1}}:{}),source,destination,sender:input.sender,recipient:input.recipient,amountRaw:solanaSource?'1000':usdc?'100000':'50000000000000',minimumOutRaw:'100000',
          expiresAtMs,routeId:'route-1',quoteIds:usdc||settlementProgress?['relay:'+meta.requestId]:['quote-1'],nativeCosts:[{chainId:source.chainId,amountRaw:'21000'}],
          actions:publicActions}};
      return {execution:structuredClone(record)};
    },
    async claimExecution() { apiCalls.push('claim'); const action=actions[record.nextAction]; record={...record,status:'CLAIMED',revision:record.revision+1,claimedActionId:action.id}; return {execution:structuredClone(record),action}; },
    async submitExecution(id,input) { apiCalls.push('submit'); assert.equal(input.transactionHash,record.nextAction===0?HASH:'0x'+'c'.repeat(64)); record={...record,status:'SUBMITTED',revision:record.revision+1,submissions:[...record.submissions,{actionId:record.claimedActionId,hash:input.transactionHash}]}; return {execution:structuredClone(record)}; },
    async getExecution() { apiCalls.push('get'); return {execution:structuredClone(record)}; },
    async refreshExecution() { apiCalls.push('refresh'); if(usdc && approvalConfirmed && record.nextAction===0) record={...record,status:'READY',revision:record.revision+1,nextAction:1,claimedActionId:null}; return {execution:structuredClone(record),...(observedProgress?{progress:observedProgress}:{})}; },
    async markExecutionUncertain() { apiCalls.push('uncertain'); record={...record,status:'RECOVERY_REQUIRED',revision:2}; return {execution:structuredClone(record)}; },
    async cancelExecution() { apiCalls.push('cancel'); record={...record,status:'CANCELLED',revision:record.revision+1}; return {execution:structuredClone(record)}; },
  };
  const {initWalletUi} = await import('../examples/browser/wallet-ui.js?fixture='+ ++fixtureNumber);
  const scheduled = new Map(); let nextTimer = 0;
  const timers = {setTimeout(fn, delay) { const id=++nextTimer; scheduled.set(id,{fn,delay}); return id; },clearTimeout(id) { scheduled.delete(id); }};
  initWalletUi(client,getInput,config,timers);
  return {$,calls,apiCalls,storage,client,config,host,confirmApproval:()=>{approvalConfirmed=true;},setProgress:stage=>{observedProgress={routeId:record.plan.routeId,actionId:actions[record.nextAction].id,sourceTransactionHash:record.submissions.at(-1)?.hash??HASH,stage,observedAtMs:Date.now(),sourceConfirmations:2,requiredSourceConfirmations:12,...(stage==='DESTINATION_CONFIRMED'?{destination:{chainId:record.plan.destination.chainId,transactionHash:encodeBase58(new Uint8Array(64).fill(2)),asset:record.plan.destination,recipient:record.plan.recipient,amountRaw:record.plan.minimumOutRaw,commitment:'confirmed'}}:{})};}, enter(id,value) { $(id).value=value; $(id).dispatchEvent(new Event('input')); $('quote-form').dispatchEvent(new Event('input')); },
    progress:()=>structuredClone(observedProgress),
    saved:()=>JSON.parse(storage.get('instinct-router-recovery-v1')??'null'),
    scheduled,
    async fireRecovery() { const [id,timer]=scheduled.entries().next().value; scheduled.delete(id); await timer.fn(); },
    sends:()=>calls.filter(row=>row.method==='eth_sendTransaction'),
    async reload() {
      // Keep only browser storage and the server's original execution across the page reload.
      for(const field of fields.values()) { field.handlers.clear(); field.onclick=null; }
      const fresh=await import('../examples/browser/wallet-ui.js?fixture='+ ++fixtureNumber);
      scheduled.clear(); fresh.initWalletUi(client,getInput,config,timers);
    }};
}
const tick = () => new Promise(resolve=>setImmediate(resolve));
async function until(predicate) {
  // Crypto work and browser state transitions may complete on worker threads.
  // Yield real time rather than limiting them to a machine-dependent spin count.
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    const remaining = deadline - performance.now();
    assert.ok(remaining > 0, 'Expected UI state did not arrive within 5000 ms');
    await delay(Math.min(10, remaining));
  }
}
async function stopAfterSubmission(f,pending) { await until(()=>f.saved()?.phase === 'SUBMITTED' && !f.$('settlement-stop').hidden); f.$('settlement-stop').click(); await pending; }

async function reachReview(f) {
  assert.equal(f.$('swap-primary').textContent,'Connect wallet');
  await f.$('swap-primary').click();
  assert.equal(f.$('swap-primary').textContent,'Enter destination address');
  assert.equal(f.$('swap-primary').disabled,true);
  f.enter('recipient',RECIPIENT);
  assert.equal(f.$('swap-primary').textContent,'Swap');
  await f.$('execution-prepare').click();
  assert.deepEqual(f.apiCalls,['challenge','verify','prepare']);
  assert.equal(f.saved().record.status,'READY');
  assert(reviewNodes(f).some(row=>row.title===RECIPIENT || row.textContent.includes(RECIPIENT)), 'The recipient must appear in the displayed review');
  assert.equal(f.$('swap-primary').textContent,'Swap');
  assert.equal(f.sends().length,0,'Connection, proof and preparation never submit');
}

test('primary Base ETH to Solana USDC flow requires proof, fresh review and explicit Swap click', async () => {
  const f=await setup(); await reachReview(f);
  assert.match(f.$('swap-next-step').textContent,/review|confirm|wallet/i);
  const executing=f.$('swap-primary').click();
  await stopAfterSubmission(f,executing);
  assert.equal(f.sends().length,1);
  assert.equal(f.sends()[0].params[0].from,SENDER);
  assert.equal(f.sends()[0].params[0].chainId,'0x2105');
  assert.equal(f.saved().phase,'SUBMITTED');
  assert.equal(f.saved().record.status,'SUBMITTED');
  assert.equal(f.saved().transactionHash,HASH);
  assert.deepEqual(f.apiCalls,['challenge','verify','prepare','claim','submit','refresh']);
  assert.equal(f.calls.filter(row=>row.method==='personal_sign').length,1);
  assert.equal(f.$('swap-primary').textContent,'Resume saved trade');
});

test('unsupported preview route visibly blocks execution and never requests proof or sends funds', async () => {
  const f=await setup({supported:false});
  await f.$('source-wallet-connect').click(); f.enter('recipient',RECIPIENT);
  assert.equal(f.$('swap-primary').disabled,true);
  assert.match(f.$('swap-next-step').textContent,/No executable route is available/i);
  assert.equal(f.apiCalls.length,0); assert.equal(f.sends().length,0);
});
test('fee-limit failure displays actual percentages without raising settings or sending a wallet transaction', async () => {
  const f=await setup({usdc:true});
  const message='Estimated total fees (including source gas reserve): 30.58%; your fee limit: 5.00%. Price impact: 0.00%; your impact limit: 5.00%. No transaction was prepared. Review the amount and Swap settings before trying again.';
  f.client.prepareExecution=async()=>{throw Object.assign(new Error(message),{code:'EXECUTION_FEE_LIMIT'});};
  f.client.getActiveExecution=async()=>({execution:null});
  await f.$('swap-primary').click(); f.enter('recipient',RECIPIENT); await f.$('execution-prepare').click();
  assert.equal(f.$('wallet-status').textContent,message); assert.equal(f.$('wallet-status').dataset.error,'true');
  assert.equal(f.$('max-fee').value,'5'); assert.equal(f.$('slippage').value,'0.5'); assert.equal(f.$('amount').value,'0.1');
  assert.equal(f.$('swap-primary').textContent,'Swap'); assert.equal(f.sends().length,0);
  assert.equal(f.saved().phase,'CANCELLED'); assert.equal(f.apiCalls.includes('claim'),false);
});
test('a router restart invalidates the UI login timer and the next recovery click requests fresh ownership proof', async () => {
  const f=await setup({usdc:true});
  const authError=()=>Object.assign(new Error('Prove source wallet control before continuing.'),{code:'WALLET_AUTH_REQUIRED'});
  f.client.prepareExecution=async()=>{throw authError();};
  f.client.getActiveExecution=async()=>{throw authError();};
  await f.$('swap-primary').click(); f.enter('recipient',RECIPIENT); await f.$('execution-prepare').click();
  assert.equal(f.$('swap-primary').textContent,'Resume saved trade');
  assert.equal(f.calls.filter(row=>row.method==='personal_sign').length,1);
  f.client.getActiveExecution=async()=>({execution:null});
  await f.$('swap-primary').click();
  assert.equal(f.calls.filter(row=>row.method==='personal_sign').length,2);
  assert.equal(f.$('swap-primary').textContent,'Swap'); assert.equal(f.sends().length,0);
});

test('failed network preparation clears an empty queue and tells the user to review a new swap', async () => {
  const f=await setup({usdc:true});
  f.client.prepareExecution=async()=>{throw Object.assign(new Error('unavailable'),{code:'EXECUTION_EVIDENCE_UNAVAILABLE'});};
  f.client.getActiveExecution=async()=>({execution:null});
  await f.$('swap-primary').click(); f.enter('recipient',RECIPIENT); await f.$('execution-prepare').click();
  assert.match(f.$('wallet-status').textContent,/unsent request was cleared/);
  assert.doesNotMatch(f.$('wallet-status').textContent,/Resume/);
  assert.equal(f.$('swap-primary').textContent,'Swap'); assert.equal(f.sends().length,0);
  assert.equal(f.scheduled.size,0);
});

test('an aged unsent request automatically reconciles and releases the button without signing again', async () => {
  const f=await setup({usdc:true});
  const timeout=()=>Object.assign(new Error('unavailable'),{code:'EXECUTION_TIMEOUT'});
  f.client.prepareExecution=async()=>{throw timeout();};
  f.client.getActiveExecution=async()=>{throw timeout();};
  await f.$('swap-primary').click(); f.enter('recipient',RECIPIENT); await f.$('execution-prepare').click();
  assert.equal(f.saved().phase,'PREPARE_PENDING'); assert.equal(f.scheduled.size,1);
  assert.ok([...f.scheduled.values()][0].delay<=30000);
  f.storage.set('instinct-router-recovery-v1',JSON.stringify({...f.saved(),savedAtMs:Date.now()-31000,expiresAtMs:Date.now()-1000}));
  f.client.getActiveExecution=async()=>({execution:null});
  await f.fireRecovery();
  assert.equal(f.saved().phase,'CANCELLED'); assert.equal(f.$('swap-primary').textContent,'Swap');
  assert.match(f.$('wallet-status').textContent,/expired request was cleared/);
  assert.equal(f.scheduled.size,0); assert.equal(f.calls.filter(row=>row.method==='personal_sign').length,1); assert.equal(f.sends().length,0);
});

test('expired untouched review is reconciled without another wallet action', async () => {
  const f=await setup(); await reachReview(f);
  const old=f.saved(); old.record.plan.expiresAtMs=Date.now()-1;
  f.storage.set('instinct-router-recovery-v1',JSON.stringify(old));
  f.client.getExecution=async()=>({execution:{...structuredClone(old.record),status:'EXPIRED',revision:old.record.revision+1}});
  await f.fireRecovery();
  assert.equal(f.saved().phase,'EXPIRED'); assert.equal(f.$('swap-primary').textContent,'Swap'); assert.equal(f.sends().length,0);
  assert.equal(f.$('execution-review').children.length,1);
  assert.equal(reviewTitle(f),'Quote expired');
  assert.equal(f.calls.filter(row=>row.method==='personal_sign').length,1);
});

test('unavailable expiry checks stop after three attempts and keep recovery without wallet prompts', async () => {
  const f=await setup({usdc:true});
  f.client.prepareExecution=async()=>{throw Object.assign(new Error('timeout'),{code:'EXECUTION_TIMEOUT'});};
  let reads=0;
  f.client.getActiveExecution=async()=>{reads++;throw Object.assign(new Error('offline'),{code:'EXECUTION_UNAVAILABLE'});};
  await f.$('swap-primary').click(); f.enter('recipient',RECIPIENT); await f.$('execution-prepare').click();
  const old={...f.saved(),savedAtMs:Date.now()-31000,expiresAtMs:Date.now()-1000};
  f.storage.set('instinct-router-recovery-v1',JSON.stringify(old));
  f.$('quote-form').dispatchEvent(new Event('input'));
  for(let i=0;i<3;i++) await f.fireRecovery();
  assert.equal(reads,4); assert.equal(f.scheduled.size,0); assert.equal(f.saved().phase,'PREPARE_PENDING');
  assert.equal(f.calls.filter(row=>row.method==='personal_sign').length,1); assert.equal(f.sends().length,0);
});

test('recipient change invalidates the saved review before any transaction can be sent', async () => {
  const f=await setup(); await reachReview(f); f.enter('recipient',OTHER_RECIPIENT);
  assert.equal(f.$('review-input-warning').hidden,false);
  assert.equal(f.$('execution-continue').disabled,true);
  assert.equal(f.$('swap-primary').textContent,'Cancel old review');
  await f.$('swap-primary').click();
  assert.equal(f.saved().record.status,'CANCELLED');
  assert.equal(f.sends().length,0);
  assert.equal(f.apiCalls.includes('claim'),false);
  assert.equal(f.$('swap-primary').textContent,'Swap');
});

test('recipient mutation while claiming declines the reviewed action without submission', async () => {
  const f=await setup(); await reachReview(f);
  const original=f.client.claimExecution;
  f.client.claimExecution=async (...args) => { const result=await original(...args); f.enter('recipient',OTHER_RECIPIENT); return result; };
  await f.$('swap-primary').click();
  assert.equal(f.sends().length,0); assert.equal(f.saved().phase,'RECOVERY_REQUIRED');
  assert.equal(f.$('swap-primary').textContent,'Resume saved trade');
});

test('claim preflight failure recovers the untouched review and keeps its expiry check scheduled', async () => {
  const f=await setup(); await reachReview(f);
  f.client.claimExecution=async()=>{throw Object.assign(new Error('timeout'),{code:'EXECUTION_TIMEOUT'});};
  await f.$('swap-primary').click();
  assert.equal(f.saved().phase,'REVIEW'); assert.equal(f.saved().record.status,'READY');
  assert.equal(f.scheduled.size,1); assert.equal(f.sends().length,0);
  assert.equal(f.$('swap-primary').textContent,'Swap');
});

test('gas drift cancels only an untouched review and requests fresh terms without raising the user cap', async () => {
  const f=await setup(); await reachReview(f);
  f.client.claimExecution=async()=>{throw Object.assign(new Error('reserve moved'),{code:'EXECUTION_REVIEW_GAS_RESERVE_EXCEEDED'});};
  await f.$('swap-primary').click();
  assert.equal(f.saved().phase,'CANCELLED'); assert.equal(f.$('swap-primary').textContent,'Swap');
  assert.match(f.$('wallet-status').textContent,/Gas costs moved/);
  assert.equal(f.$('native-budget').value,'0.00002'); assert.equal(f.$('max-fee').value,'5'); assert.equal(f.sends().length,0);
});

test('gas drift error cannot cancel a claim that the server already saved', async () => {
  const f=await setup(); await reachReview(f); const claim=f.client.claimExecution;
  f.client.claimExecution=async(...args)=>{await claim(...args);throw Object.assign(new Error('reserve moved'),{code:'EXECUTION_REVIEW_GAS_RESERVE_EXCEEDED'});};
  await f.$('swap-primary').click();
  assert.equal(f.saved().phase,'CLAIMED'); assert.equal(f.apiCalls.includes('cancel'),false); assert.equal(f.sends().length,0);
});

test('lost claim response preserves a claimed record and never schedules queue expiry', async () => {
  const f=await setup(); await reachReview(f); const claim=f.client.claimExecution;
  f.client.claimExecution=async(...args)=>{await claim(...args);throw Object.assign(new Error('timeout'),{code:'EXECUTION_TIMEOUT'});};
  await f.$('swap-primary').click();
  assert.equal(f.saved().phase,'CLAIMED'); assert.equal(f.scheduled.size,0); assert.equal(f.sends().length,0);
  assert.equal(f.$('swap-primary').textContent,'Resume saved trade');
});

test('repeat actions and recovery only check saved status and never duplicate wallet submission', async () => {
  const f=await setup(); await reachReview(f);
  const executing=f.$('swap-primary').click();
  // Invoke the handler as well as the disabled state: async operation guard must prevent duplicate claims.
  await f.$('swap-primary').onclick(); await f.$('execution-continue').onclick();
  await until(()=>f.apiCalls.includes('claim'));
  assert.equal(f.apiCalls.filter(row=>row==='claim').length,1);
  await stopAfterSubmission(f,executing);
  for(let i=0;i<2;i++) { const resume=f.$('swap-primary').click(); await stopAfterSubmission(f,resume); }
  assert.equal(f.sends().length,1);
  assert.equal(f.apiCalls.filter(row=>row==='claim').length,1);
  assert.equal(f.apiCalls.filter(row=>row==='prepare').length,1);
  assert.equal(f.saved().record.status,'SUBMITTED');
  assert.equal(f.apiCalls.filter(row=>row==='refresh').length,5);
  assert.equal(f.scheduled.size,0,'Submitted transactions cannot be cleared by the unsent expiry timer');
});

test('a saved submitted trade survives page reload and ownership recheck without a replacement trade', async () => {
  const f=await setup(); await reachReview(f);
  const executing=f.$('swap-primary').click();
  await stopAfterSubmission(f,executing);
  await f.reload();
  await until(()=>f.$('swap-primary').textContent==='Resume saved trade' && !f.$('swap-primary').disabled);
  assert.equal(f.calls.filter(row=>row.method==='eth_requestAccounts').length,1,'Reload reuses existing wallet permission');
  const resume=f.$('swap-primary').click(); await stopAfterSubmission(f,resume);
  assert.equal(f.sends().length,1);
  assert.equal(f.apiCalls.filter(row=>row==='prepare').length,1);
  assert.equal(f.apiCalls.filter(row=>row==='claim').length,1);
  assert.equal(f.saved().transactionHash,HASH);
});

test('independent-source scope visibly blocks the Relay execution route', async () => {
  const f=await setup(); f.$('route-scope').value='INDEPENDENT';
  f.$('quote-form').dispatchEvent(new Event('change'));
  assert.equal(f.$('swap-primary').disabled,true);
  assert.equal(f.$('swap-primary').textContent,'Preview only for this pair');
  assert.match(f.$('swap-next-step').textContent,/All sources.*Relay/);
  assert.equal(f.apiCalls.length,0); assert.equal(f.sends().length,0);
});

test('empty amount asks for an amount and never starts preparation or signing', async () => {
  const f=await setup(); await f.$('source-wallet-connect').click(); f.enter('recipient',RECIPIENT); f.enter('amount','');
  assert.equal(f.$('swap-primary').disabled,true);
  assert.equal(f.$('swap-primary').textContent,'Enter an amount');
  assert.equal(f.apiCalls.length,0); assert.equal(f.sends().length,0);
});

test('USDC approval confirmation presents a second explicit Swap step without another wallet send',async()=>{
  const f=await setup({usdc:true});
  await f.$('swap-primary').click();f.enter('recipient',RECIPIENT);await f.$('execution-prepare').click();
  assert.equal(f.$('swap-primary').textContent,'Approve USDC');
  const approval=f.$('swap-primary').click();await stopAfterSubmission(f,approval);
  assert.equal(f.sends().length,1);assert.equal(f.sends()[0].params[0].value,'0x0');
  assert.equal(f.$('swap-primary').textContent,'Check USDC approval');assert.match(f.$('swap-next-step').textContent,/approval was submitted.*No swap funds were sent/);
  assert(reviewNodes(f).some(row=>/Approving USDC/.test(row.textContent)));
  f.confirmApproval();const resume=f.$('swap-primary').click();await resume;
  assert.equal(f.saved().phase,'REVIEW');assert.equal(f.saved().record.nextAction,1);assert.equal(f.saved().transactionHash,undefined);
  assert.equal(f.$('swap-primary').textContent,'Swap');assert.equal(f.sends().length,1);assert.match(f.$('wallet-status').textContent,/approval confirmed.*No swap funds were sent/);
  const swap=f.$('swap-primary').click();await stopAfterSubmission(f,swap);
  assert.equal(f.sends().length,2);assert.match(f.sends()[1].params[0].data,/^0xe8017952/);
});

test('expired approved but unfunded USDC review offers cancellation and never deposits',async()=>{
  const f=await setup({usdc:true});await f.$('swap-primary').click();f.enter('recipient',RECIPIENT);await f.$('execution-prepare').click();
  const executing=f.$('swap-primary').click();await stopAfterSubmission(f,executing);
  f.confirmApproval();const result=await f.client.refreshExecution();
  result.execution.plan.expiresAtMs=Date.now()-1;
  // Reconnect with a durable expired intermediate review, preserving its exact server terms.
  f.storage.set('instinct-router-recovery-v1',JSON.stringify({version:1,phase:'REVIEW',record:result.execution}));
  await f.reload();await until(()=>f.$('swap-primary').textContent==='Cancel old review' && !f.$('swap-primary').disabled);
  assert.equal(f.$('swap-primary').textContent,'Cancel old review');assert.equal(f.$('execution-cancel').disabled,false);
  assert.match(f.$('swap-next-step').textContent,/approval confirmed.*quote expired.*No swap funds were sent.*fresh terms/);
  assert.equal(f.sends().length,1);
});

test('cancelled prepare recovery does not tell a reconnecting user a prior request needs recovery',async()=>{
  const storage=new Map([['instinct-router-recovery-v1',JSON.stringify({version:1,phase:'CANCELLED'})]]);
  const f=await setup({storage});await f.$('source-wallet-connect').click();f.enter('recipient',RECIPIENT);
  assert.equal(f.$('swap-primary').textContent,'Swap');assert.doesNotMatch(f.$('wallet-status').textContent,/prior request needs recovery/);
});

test('blank optional fee settings create a null-bound review with automatic finite gas reserve',async()=>{
  const f=await setup({noPresetCaps:true});await reachReview(f);
  assert.equal(f.saved().record.request.maxFeeBps,null);assert.equal(f.saved().record.request.nativeFeeBudgets[0].maxAmountRaw,null);
  assert.doesNotMatch(reviewText(f),/Gas policy|Estimated source gas reserve|Fee limit/);
  assert.match(reviewText(f),/Minimum received/);
  f.enter('max-fee','5');assert.equal(f.$('execution-continue').disabled,true);
});

test('browser defaults leave amount and optional fee settings blank while retaining slippage',async()=>{
  const {readFile}=await import('node:fs/promises');
  const html=await readFile(new URL('../examples/browser/index.html',import.meta.url),'utf8');
  for(const id of ['amount','max-fee','native-budget']) {
    const tag=html.match(new RegExp('<input[^>]*id="'+id+'"[^>]*>'))?.[0];
    assert(tag);assert.doesNotMatch(tag,/value="[^\"]+"/);
  }
  assert.match(html,/<input[^>]*id="slippage"[^>]*value="0\.50"/);
});

test('approval confirmation lookup failure explains the pending approval without claiming swap submission',async()=>{
  const f=await setup({usdc:true});await f.$('swap-primary').click();f.enter('recipient',RECIPIENT);await f.$('execution-prepare').click();
  const executing=f.$('swap-primary').click();await stopAfterSubmission(f,executing);
  f.client.refreshExecution=async()=>{throw Object.assign(Error('Evidence unavailable'),{code:'EXECUTION_EVIDENCE_UNAVAILABLE'});};
  await f.$('swap-primary').click();assert.match(f.$('wallet-status').textContent,/approval was submitted.*confirmation checks could not finish.*No swap funds were sent/);
  assert.equal(f.$('swap-primary').textContent,'Check USDC approval');assert.equal(f.sends().length,1);
});

test('display-only destination progress shows received funds while final settlement remains pending',async()=>{
  const f=await setup({settlementProgress:true});await reachReview(f);
  const execute=f.$('swap-primary').click();await stopAfterSubmission(f,execute);
  f.setProgress('SOURCE_CONFIRMED');const sourceCheck=f.$('swap-primary').click();
  await until(()=>f.$('settlement-stop').hidden===false && f.apiCalls.filter(call=>call==='refresh').length>=2);await tick();
  assert.equal(f.$('swap-primary').textContent,'Swap sent · checking delivery');
  assert.match(reviewText(f),/Bridging & swapping/);assert.doesNotMatch(reviewText(f),/Source confirmations/);
  assert(!reviewNodes(f).some(row=>/Funds received/.test(row.textContent)));
  await stopAfterSubmission(f,sourceCheck);
  f.setProgress('DESTINATION_CONFIRMED');const destinationCheck=f.$('swap-primary').click();
  await until(()=>reviewNodes(f).some(row=>/Funds received/.test(row.textContent)));
  assert.equal(reviewTitle(f),'Funds received');
  assert.equal(f.$('swap-primary').textContent,'Funds received · finalizing');
  assert.equal(f.$('swap-next-step').textContent,'Your funds have arrived. Waiting for final network confirmations.');
  assert(reviewNodes(f).some(row=>/Funds received/.test(row.textContent)));
  assert.match(reviewText(f),/Finalizing/);assert.doesNotMatch(reviewText(f),/Status checks elapsed/);
  assert.equal(f.saved().record.status,'SUBMITTED');assert.equal(f.sends().length,1);
  await stopAfterSubmission(f,destinationCheck);
  assert(!reviewNodes(f).some(row=>/Funds received/.test(row.textContent)));
  f.client.refreshExecution=async()=>{throw Object.assign(Error('Offline'),{code:'EXECUTION_EVIDENCE_UNAVAILABLE'});};await f.$('swap-primary').click();
  assert(!reviewNodes(f).some(row=>/Funds received/.test(row.textContent)));assert.equal(f.sends().length,1);
});

test('independently complete swap leads with Swap complete',async()=>{
  const f=await setup({settlementProgress:true});await reachReview(f);const execute=f.$('swap-primary').click();await stopAfterSubmission(f,execute);
  const original=f.client.refreshExecution;
  f.client.refreshExecution=async()=>{const data=await original();const record=data.execution,now=Date.now();
    record.revision++;record.status='COMPLETE';record.nextAction=record.plan.actions.length;record.claimedActionId=null;
    record.receipt={chainId:BASE,transactionHash:HASH,blockNumberRaw:'100',blockHash:'0x'+'f'.repeat(64),observedAtMs:now,confirmations:12};
    record.destinationReceipt={chainId:SOL,transactionHash:encodeBase58(new Uint8Array(64).fill(2)),blockNumberRaw:'101',blockHash:RECIPIENT,observedAtMs:now,commitment:'finalized',destinationCredit:{asset:record.plan.destination,recipient:record.plan.recipient,amountRaw:record.plan.minimumOutRaw},attribution:{provider:'relay',requestId:record.plan.quoteIds[0].slice(6),sourceTransactionHash:HASH}};
    return data;
  };
  await f.$('swap-primary').click();assert.equal(reviewTitle(f),'Swap complete');assert.equal(f.saved().record.status,'COMPLETE');assert.equal(f.sends().length,1);
  assert.equal(f.$('wallet-status').hidden,true);assert.equal(f.$('swap-next-step').hidden,true);
  assert.equal(f.$('swap-next-step').textContent,'');
  assert.doesNotMatch(reviewText(f),/Wallet response|Source confirmations|Actual native fee|Review expires|Relay manages|Submission to confirmed settlement/);
});

test('push delivery proof updates the prominent headline immediately without browser status polling',async()=>{
  const f=await setup({settlementProgress:true});await reachReview(f);let receivedAt;
  f.client.watchExecution=async(id,{onUpdate,signal})=>{
    f.apiCalls.push('watch');f.setProgress('DESTINATION_CONFIRMED');receivedAt=performance.now();
    await onUpdate({execution:f.saved().record,progress:f.progress(),receiptStatus:'PENDING'},{receivedAtMonoMs:receivedAt,receivedAtMs:Date.now(),sentAtMs:Date.now(),observedToSentMs:0,serverToReceiptMs:0});
    return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(Error('Stopped'),{code:'ABORTED'})),{once:true}));
  };
  const execute=f.$('swap-primary').click();await until(()=>f.$('swap-primary').textContent==='Funds received · finalizing');
  assert(performance.now()-receivedAt<1000);assert.equal(reviewTitle(f),'Funds received');
  assert.doesNotMatch(reviewText(f),/Update receipt to display|clock alignment/);
  assert.equal(f.$('wallet-status').hidden,true);assert.equal(f.$('swap-next-step').hidden,true);
  assert.equal(f.apiCalls.filter(row=>row==='refresh').length,0);assert.equal(f.saved().record.status,'SUBMITTED');assert.equal(f.sends().length,1);
  f.$('settlement-stop').click();await execute;assert(!reviewNodes(f).some(row=>/Funds received/.test(row.textContent)));
});
test('push protocol and ownership failures never fall back to polling or resend the swap',async()=>{
  for(const code of ['PROTOCOL_ERROR','WALLET_AUTH_REQUIRED']){
    const f=await setup();await reachReview(f);f.client.watchExecution=async()=>{throw Object.assign(Error('Rejected'),{code,status:code==='WALLET_AUTH_REQUIRED'?401:null});};
    await f.$('swap-primary').click();assert.equal(f.apiCalls.filter(row=>row==='refresh').length,0);assert.equal(f.sends().length,1);assert.match(f.$('wallet-status').textContent,/Status checks stopped/);
  }
});
test('push endpoint absence or network disconnect can fall back to read-only known-hash checks',async()=>{
  for(const failure of [{code:'WATCH_UNAVAILABLE',status:404},{code:'NETWORK_ERROR'}]){
    const f=await setup();await reachReview(f);f.client.watchExecution=async()=>{throw Object.assign(Error('Unavailable'),failure);};
    const execute=f.$('swap-primary').click();await stopAfterSubmission(f,execute);assert.equal(f.apiCalls.filter(row=>row==='refresh').length,1);assert.equal(f.sends().length,1);
  }
});

async function readyForSingleSwap(f) {await f.$('source-wallet-connect').click();f.enter('recipient',RECIPIENT);assert.equal(f.$('swap-primary').textContent,'Swap');}
test('connected native swap prepares and opens its wallet from one Swap click, guarded against double clicks',async()=>{
  const f=await setup();await readyForSingleSwap(f);const execute=f.$('swap-primary').click();await f.$('swap-primary').onclick();await f.$('execution-continue').onclick();
  await stopAfterSubmission(f,execute);assert.equal(f.sends().length,1);assert.equal(f.apiCalls.filter(row=>row==='prepare').length,1);assert.equal(f.apiCalls.filter(row=>row==='claim').length,1);assert.equal(f.calls.filter(row=>row.method==='personal_sign').length,1);
});
test('one Swap click completes USDC approval then requests its deposit wallet confirmation',async()=>{
  const f=await setup({usdc:true});await readyForSingleSwap(f);f.confirmApproval();
  f.client.watchExecution=async(id,{onUpdate,signal})=>{const data=await f.client.refreshExecution();await onUpdate(data,{});if(data.execution.status==='READY')return {reason:'STATE_CHANGED',execution:data.execution};return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(Error('Stopped'),{code:'ABORTED'})),{once:true}));};
  const execute=f.$('swap-primary').click();
  await until(()=>f.sends().length===2 && f.saved().record.nextAction===1 && f.saved().phase==='SUBMITTED');f.$('settlement-stop').click();await execute;
  assert.equal(f.apiCalls.filter(row=>row==='prepare').length,1);assert.equal(f.apiCalls.filter(row=>row==='claim').length,2);assert.match(f.sends()[0].params[0].data,/^0x095ea7b3/);assert.match(f.sends()[1].params[0].data,/^0xe8017952/);assert.equal(f.saved().record.submissions.length,2);
});
test('single-click consent rejects programmatic changes during preparation or ownership',async()=>{
  for(const change of ['recipient','route-scope','source-decimals','max-fee']){
    const f=await setup();await readyForSingleSwap(f);const prepare=f.client.prepareExecution;f.client.prepareExecution=async(...args)=>{const result=await prepare(...args);f.$(change).value=change==='recipient'?OTHER_RECIPIENT:change==='route-scope'?'INDEPENDENT':'9';return result;};
    await f.$('swap-primary').click();assert.equal(f.sends().length,0);assert.equal(f.apiCalls.includes('claim'),false);
  }
  const f=await setup();await readyForSingleSwap(f);const verify=f.client.verifyWallet;f.client.verifyWallet=async()=>{const result=await verify();f.$('amount').value='0.01';return result;};await f.$('swap-primary').click();assert.equal(f.apiCalls.includes('prepare'),false);assert.equal(f.sends().length,0);
});
test('single-click flow does not send an expired fresh plan or a changed source account',async()=>{
  for(const scenario of ['expired','account']){
    const f=await setup();await readyForSingleSwap(f);const prepare=f.client.prepareExecution;f.client.prepareExecution=async(...args)=>{const result=await prepare(...args);if(scenario==='expired')result.execution.plan.expiresAtMs=Date.now()-1;else{const request=f.host.ethereum.request;f.host.ethereum.request=async input=>input.method==='eth_accounts'?['0x'+'f'.repeat(40)]:request(input);}return result;};
    await f.$('swap-primary').click();assert.equal(f.sends().length,0);
  }
});
test('stop after approval submission cancels deposit continuation and Resume remains read only',async()=>{
  const f=await setup({usdc:true});await readyForSingleSwap(f);const execute=f.$('swap-primary').click();await stopAfterSubmission(f,execute);assert.equal(f.sends().length,1);
  f.confirmApproval();await f.$('swap-primary').click();assert.equal(f.saved().phase,'REVIEW');assert.equal(f.saved().record.nextAction,1);assert.equal(f.sends().length,1);
});
test('wallet rejection and an ambiguous approval response end single-click consent without retry',async()=>{
  for(const scenario of ['rejected','unknown']){
    const f=await setup({usdc:true});await readyForSingleSwap(f);const request=f.host.ethereum.request;let attempts=0;f.host.ethereum.request=async input=>{if(input.method==='eth_sendTransaction'){attempts++;if(scenario==='rejected')throw Object.assign(Error('Rejected'),{code:4001});throw Error('Connection lost after wallet request');}return request(input);};
    await f.$('swap-primary').click();assert.equal(attempts,1);assert.equal(f.saved().phase,'RECOVERY_REQUIRED');await f.$('swap-primary').click();assert.equal(attempts,1);assert.equal(f.apiCalls.filter(row=>row==='claim').length,1);
  }
});
test('approval confirmation after quote expiry cannot auto-requote or request a deposit',async()=>{
  const f=await setup({usdc:true});await readyForSingleSwap(f);f.confirmApproval();const refresh=f.client.refreshExecution,clock=Date.now;
  f.client.refreshExecution=async()=>{const result=await refresh();if(result.execution.status==='READY')Date.now=()=>result.execution.plan.expiresAtMs+1;return result;};
  f.client.watchExecution=async(id,{onUpdate})=>{const data=await f.client.refreshExecution();await onUpdate(data,{});return {reason:'STATE_CHANGED',execution:data.execution};};
  try{await f.$('swap-primary').click();assert.equal(f.sends().length,1);assert.equal(f.apiCalls.filter(row=>row==='prepare').length,1);assert.equal(f.apiCalls.filter(row=>row==='claim').length,1);assert.equal(f.$('swap-primary').textContent,'Cancel old review');}finally{Date.now=clock;}
});

test('Stop while the approval wallet is open still records its returned hash without tracking or advancing',async()=>{
  const f=await setup({usdc:true});await readyForSingleSwap(f);const request=f.host.ethereum.request;let release,attempts=0,watches=0;
  f.host.ethereum.request=async input=>{if(input.method==='eth_sendTransaction'){attempts++;await new Promise(resolve=>{release=resolve;});}return request(input);};
  f.client.watchExecution=async()=>{watches++;throw Error('Stopped consent must not start tracking');};
  const execute=f.$('swap-primary').click();await until(()=>attempts===1);assert.equal(f.$('settlement-stop').hidden,false);assert.equal(f.$('settlement-stop').textContent,'Stop swap flow');f.$('settlement-stop').click();release();await execute;
  assert.equal(f.saved().phase,'SUBMITTED');assert.equal(f.saved().transactionHash,HASH);assert.equal(f.apiCalls.filter(row=>row==='submit').length,1);assert.equal(watches,0);assert.equal(attempts,1);
});
test('loss of the approval push connection clears continuation before read-only fallback confirms it',async()=>{
  const f=await setup({usdc:true});await readyForSingleSwap(f);f.confirmApproval();f.client.watchExecution=async()=>{throw Object.assign(Error('Lost stream'),{code:'NETWORK_ERROR'});};
  await f.$('swap-primary').click();assert.equal(f.saved().phase,'REVIEW');assert.equal(f.saved().record.nextAction,1);assert.equal(f.sends().length,1);assert.equal(f.apiCalls.filter(row=>row==='claim').length,1);
  await f.reload();await until(()=>!f.$('source-wallet-connect').disabled);assert.equal(f.sends().length,1);
});
test('changed inputs after approval proof prevent the automatic deposit request',async()=>{
  const f=await setup({usdc:true});await readyForSingleSwap(f);f.confirmApproval();
  f.client.watchExecution=async(id,{onUpdate})=>{const data=await f.client.refreshExecution();await onUpdate(data,{});f.$('route-scope').value='INDEPENDENT';return {reason:'STATE_CHANGED',execution:data.execution};};
  await f.$('swap-primary').click();assert.equal(f.sends().length,1);assert.equal(f.apiCalls.filter(row=>row==='claim').length,1);assert.equal(f.saved().record.nextAction,1);
});

test('profile-authorized arbitrary Base token completes exact approval and deposit from one click',async()=>{
 const f=await setup({genericToken:true,profileOnly:true});await readyForSingleSwap(f);f.confirmApproval();
 f.client.watchExecution=async(id,{onUpdate,signal})=>{const data=await f.client.refreshExecution();await onUpdate(data,{});if(data.execution.status==='READY')return{reason:'STATE_CHANGED',execution:data.execution};return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(Error('Stopped'),{code:'ABORTED'})),{once:true}));};
 const execute=f.$('swap-primary').click();await until(()=>f.sends().length===2&&f.saved().phase==='SUBMITTED');f.$('settlement-stop').click();await execute;
 assert.equal(f.saved().record.submissions[0].actionId,'relay-token-approve');assert.equal(f.saved().record.submissions[1].actionId,'relay-token-deposit');assert.match(f.sends()[0].params[0].data,/^0x095ea7b3/);assert.match(f.sends()[1].params[0].data,/^0xe8017952/);assert.match(reviewText(f),/TKN/);assert.equal(f.apiCalls.filter(call=>call==='prepare').length,1);
});
test('execution profiles bind both chains, asset classes and fresh validation; unsupported pairs remain previews',async()=>{
 for(const patch of [{sourceChainId:'eip155:1'},{destinationChainId:'eip155:1'},{sourceAssetTypes:['NATIVE']},{destinationAssetTypes:['NATIVE']},{requiresFreshValidation:false}]){
  const f=await setup({genericToken:true,profileOnly:true});Object.assign(f.config.execution.executionProfiles[0],patch);await f.$('source-wallet-connect').click();f.enter('recipient',RECIPIENT);assert.equal(f.$('swap-primary').disabled,true);assert.equal(f.sends().length,0);assert.equal(f.apiCalls.includes('prepare'),false);
 }
});

test('Solana source review uses SOL precision for the optional gas budget and gas reserve',async()=>{
 const f=await setup({solanaSource:true});f.host.phantom.solana.signMessage=async()=>({signature:new Uint8Array(64).fill(9)});await f.$('source-wallet-connect').click();f.enter('recipient',SENDER);f.enter('native-budget','0.00002');await f.$('execution-prepare').click();
 assert.equal(f.saved().record.request.nativeFeeBudgets[0].maxAmountRaw,'20000');assert.equal(f.saved().record.request.nativeFeeBudgets[0].chainId,'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');assert.doesNotMatch(reviewText(f),/Estimated source gas reserve/);assert.match(reviewText(f),/0.000001 SOL/);assert.equal(f.sends().length,0);
});

test('compact provider-managed profiles run approval and funding under the same original Swap click',async()=>{
 for(const providerSwap of [false,true]){const f=await setup({providerManaged:true,providerSwap});await readyForSingleSwap(f);f.confirmApproval();
 f.client.watchExecution=async(id,{onUpdate,signal})=>{const data=await f.client.refreshExecution();await onUpdate(data,{});if(data.execution.status==='READY')return{reason:'STATE_CHANGED',execution:data.execution};return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(Error('Stopped'),{code:'ABORTED'})),{once:true}));};
 const execute=f.$('swap-primary').click();await until(()=>f.sends().length===2&&f.saved().phase==='SUBMITTED');f.$('settlement-stop').click();await execute;assert.equal(f.saved().record.submissions[0].actionId,'relay-provider-approve');assert.equal(f.saved().record.submissions[1].actionId,providerSwap?'relay-provider-swap':'relay-provider-deposit');assert.equal(f.$('execution-support').hidden,true);}
});
test('compact profile chain arrays cannot authorize an omitted source or destination network',async()=>{
 for(const field of ['sourceChainIds','destinationChainIds']){const f=await setup({providerManaged:true});f.config.execution.executionProfiles[0][field]=['eip155:1'];await f.$('source-wallet-connect').click();f.enter('recipient',RECIPIENT);assert.equal(f.$('swap-primary').disabled,true);assert.equal(f.apiCalls.includes('prepare'),false);}
});

function reorderObjects(value, reverse = false) {
 if (Array.isArray(value)) return value.map(row => reorderObjects(row,reverse));
 if (!value || typeof value !== 'object') return value;
 const keys=Object.keys(value).sort();if(reverse)keys.reverse();
 return Object.fromEntries(keys.map(key=>[key,reorderObjects(value[key],reverse)]));
}
test('single-click wallet confirmation accepts recursively reordered claim plan keys',async()=>{
 const f=await setup();await readyForSingleSwap(f);const claim=f.client.claimExecution;
 f.client.claimExecution=async(...args)=>{const data=await claim(...args);data.execution.plan=reorderObjects(data.execution.plan);return data;};
 const execute=f.$('swap-primary').click();await stopAfterSubmission(f,execute);
 assert.equal(f.sends().length,1);assert.equal(f.saved().phase,'SUBMITTED');assert.equal(f.apiCalls.includes('uncertain'),false);
});
test('approval continuation preserves consent across recursively reordered claim and refresh plans',async()=>{
 const f=await setup({usdc:true});await readyForSingleSwap(f);f.confirmApproval();const claim=f.client.claimExecution,refresh=f.client.refreshExecution;
 f.client.claimExecution=async(...args)=>{const data=await claim(...args);data.execution.plan=reorderObjects(data.execution.plan);return data;};
 f.client.refreshExecution=async(...args)=>{const data=await refresh(...args);data.execution.plan=reorderObjects(data.execution.plan,true);return data;};
 f.client.watchExecution=async(id,{onUpdate,signal})=>{const data=await f.client.refreshExecution();await onUpdate(data,{});if(data.execution.status==='READY')return{reason:'STATE_CHANGED',execution:data.execution};return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(Error('Stopped'),{code:'ABORTED'})),{once:true}));};
 const execute=f.$('swap-primary').click();await until(()=>f.sends().length===2&&f.saved().phase==='SUBMITTED');f.$('settlement-stop').click();await execute;
 assert.equal(f.apiCalls.filter(row=>row==='claim').length,2);assert.equal(f.saved().record.submissions.length,2);assert.equal(f.apiCalls.includes('uncertain'),false);
});
test('reordered plans with changed values or array order still refuse wallet confirmation',async()=>{
 for(const mutate of [plan=>{plan.recipient=OTHER_RECIPIENT;},plan=>{plan.minimumOutRaw='999999';},plan=>{plan.actions.reverse();}]){
  const f=await setup({usdc:true});await readyForSingleSwap(f);const claim=f.client.claimExecution;
  f.client.claimExecution=async(...args)=>{const data=await claim(...args);data.execution.plan=reorderObjects(data.execution.plan);mutate(data.execution.plan);return data;};
  await f.$('swap-primary').click();assert.equal(f.sends().length,0);assert.equal(f.apiCalls.filter(row=>row==='claim').length,1);
 }
});

test('manual recovery replaces checking text with its result and releases controls without sending',async()=>{
 for(const [status,expected] of [['EXPIRED',/expired.*new swap/i],['CANCELLED',/cancelled.*new swap/i],['READY',/saved.*review.*ready/i],['RECOVERY_REQUIRED',/no transaction hash.*recovery/i]]){
  const f=await setup();await reachReview(f);const before=f.saved().record;
  let finish;const response=new Promise(resolve=>{finish=resolve;});f.client.getExecution=()=>response;
  const pending=f.$('execution-resume').click();await until(()=>f.$('wallet-status').textContent==='Checking your saved trade…');
  assert.equal(f.$('swap-primary').disabled,true);
  finish({execution:{...structuredClone(before),status,revision:before.revision+1,claimedActionId:status==='RECOVERY_REQUIRED'?before.plan.actions[0].id:null}});
  await pending;
  assert.match(f.$('wallet-status').textContent,expected);
  assert.equal(f.$('swap-primary').disabled,false);
  assert.equal(f.$('swap-primary').textContent,status==='RECOVERY_REQUIRED'?'Resume saved trade':'Swap');
  assert.equal(f.sends().length,0);assert.equal(f.apiCalls.includes('claim'),false);
  assert.equal(f.calls.filter(row=>row.method==='personal_sign').length,1);
 }
});

test('changing a new swap clears terminal status presentation without deleting its history',async()=>{
 const f=await setup();await reachReview(f);await f.$('execution-cancel').click();const saved=f.saved();
 f.$('wallet-status').textContent='Checking your saved trade…';f.enter('amount','0.00006');
 assert.equal(f.$('wallet-status').textContent,'');assert.equal(f.$('execution-review').children.length,0);
 assert.deepEqual(f.saved(),saved);assert.equal(f.$('swap-primary').textContent,'Swap');assert.equal(f.sends().length,0);
});
test('changing assets cannot dismiss active transaction recovery or enable a duplicate trade',async()=>{
 const f=await setup();await reachReview(f);await stopAfterSubmission(f,f.$('swap-primary').click());
 const saved=f.saved(),message=f.$('wallet-status').textContent;f.enter('amount','0.00006');
 assert.equal(f.$('wallet-status').textContent,message);assert.deepEqual(f.saved(),saved);
 assert.equal(f.$('swap-primary').textContent,'Resume saved trade');assert.equal(f.sends().length,1);
});
