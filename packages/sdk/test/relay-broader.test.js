import test from 'node:test';
import assert from 'node:assert/strict';
import { walletTransaction, evmTransaction, payloadHash, validateRecord } from '../src/execution-validation.js';
import { createPhantomWallet, createExecutionController } from '../src/index.js';
import { encodeBase58, decodeBase58, encodeLegacyMessage, SYSTEM_PROGRAM } from '../src/solana-message-codec.js';
import { relaySolanaInstruction, computeBudgetInstructions, SOLANA_CHAIN } from '../src/relay-solana-message.js';
const BASE='eip155:8453',sender=encodeBase58(new Uint8Array(32).fill(7)),recipient='0x'+'11'.repeat(20),blockhash=encodeBase58(new Uint8Array(32).fill(8));
const signature=encodeBase58(new Uint8Array(64).fill(9)),requestId='0x'+'a'.repeat(64),orderId='0x'+'b'.repeat(64);
async function fixture(mint=SYSTEM_PROGRAM){
 const source={chainId:SOLANA_CHAIN,address:mint,decimals:mint===SYSTEM_PROGRAM?9:6},destination={chainId:BASE,address:'0x'+'0'.repeat(40),decimals:18},expiresAtMs=Date.now()+30000;
 const output={chainId:'base',payments:[{recipient,currency:destination.address,minimumAmount:'1',expectedAmount:'2'}],calls:[],deadline:Math.ceil(expiresAtMs/1000)+10,extraData:'0x000000000000000000000000b92fe925dc43a0ecde6c8b1a2709c170ec4fff4f'};
 const orderData={version:'v1',solverChainId:'base',solver:recipient,inputs:[{payment:{chainId:'solana',currency:mint,amount:'1000',weight:'1'},refunds:[{chainId:'solana',recipient:sender,currency:mint,minimumAmount:'0',deadline:output.deadline,extraData:'0x'},{chainId:'base',recipient,currency:destination.address,minimumAmount:'0',deadline:output.deadline,extraData:output.extraData}]}],output,fees:[]};
 const computeBudget={units:200000,microLamports:'123'},priorities=computeBudgetInstructions(computeBudget);
 const instruction=await relaySolanaInstruction({sender,mint,amountRaw:'1000',orderId});
 const transaction={message:encodeLegacyMessage({feePayer:sender,blockhash,instructions:[...priorities,instruction]}),blockhash,lastValidBlockHeight:100,feePayer:sender};
 const action={id:'relay-solana-deposit',chainId:SOLANA_CHAIN,payload:{type:'SOLANA_TRANSACTION',nativeFeeCapRaw:'6000',transaction,relay:{requestId,orderId,orderData,computeBudget}}};
 const record={id:'execution-sol',revision:0,reviewHash:'a'.repeat(64),status:'READY',claimedActionId:null,nextAction:0,submissions:[],request:{},plan:{source,destination,sender,recipient,amountRaw:'1000',minimumOutRaw:'1',expiresAtMs,routeId:'relay:'+requestId,quoteIds:['relay:'+requestId],nativeCosts:[{chainId:SOLANA_CHAIN,amountRaw:'6000'}],actions:[{id:action.id,chainId:action.chainId,payloadHash:await payloadHash(action.payload)}]}};
 return {record,action,instruction,priorities};
}
test('Sol native and classic SPL permit only the exact reconstructed Relay instruction and reviewed order terms',async()=>{
 for(const mint of [SYSTEM_PROGRAM,'So11111111111111111111111111111111111111112']){
  const {record,action,instruction,priorities}=await fixture(mint);assert.deepEqual(await walletTransaction(action,record),action.payload.transaction);
  const mutations=[a=>a.payload.relay.computeBudget.units=200001,a=>a.payload.relay.computeBudget.microLamports='124',a=>a.payload.nativeFeeCapRaw='4999',a=>a.payload.transaction.feePayer=blockhash,a=>a.payload.transaction.blockhash=sender,a=>a.payload.relay.orderId='0x'+'0'.repeat(64),a=>a.payload.relay.orderData.output.payments[0].recipient='0x'+'22'.repeat(20),a=>a.payload.relay.orderData.inputs[0].payment.amount='1001',a=>a.payload.relay.orderData.output.calls=['0x1234'],a=>a.payload.transaction.message=encodeLegacyMessage({feePayer:sender,blockhash,instructions:[...priorities,instruction,instruction]}),a=>{const ix=structuredClone(instruction);ix.data[8]++;a.payload.transaction.message=encodeLegacyMessage({feePayer:sender,blockhash,instructions:[...priorities,ix]});},a=>{const ix=structuredClone(instruction);ix.programId=blockhash;a.payload.transaction.message=encodeLegacyMessage({feePayer:sender,blockhash,instructions:[...priorities,ix]});}];
  for(const mutate of mutations){const bad=structuredClone(action);mutate(bad);await assert.rejects(walletTransaction(bad,record),{code:'PROTOCOL_ERROR'});}
 }
});
test('Phantom binds before handoff and preserves a returned signature when accounts change after submission',async()=>{
 const {action}=await fixture();let calls=0;const provider={publicKey:{toString:()=>sender},connect:async()=>({publicKey:provider.publicKey}),signMessage:async()=>{},request:async args=>{calls++;assert.equal(args.method,'signAndSendTransaction');const wire=decodeBase58(args.params.message);assert.equal(wire[0],1);assert.deepEqual(wire.slice(1,65),new Uint8Array(64));assert.deepEqual(wire.slice(65),decodeBase58(action.payload.transaction.message));assert.notEqual(args.params.message,action.payload.transaction.message);return{signature};}};
 const wallet=createPhantomWallet(provider,SOLANA_CHAIN),account=await wallet.connect();assert.equal(await wallet.sendTransaction(action.payload.transaction,account),signature);assert.equal(calls,1);
 provider.publicKey={toString:()=>blockhash};await assert.rejects(wallet.sendTransaction(action.payload.transaction,account),{code:'WALLET_CHANGED'});assert.equal(calls,1);
 provider.publicKey={toString:()=>sender};provider.request=async()=>{calls++;provider.publicKey={toString:()=>blockhash};return{signature};};assert.equal(await wallet.sendTransaction(action.payload.transaction,account),signature);assert.equal(calls,2);
 await assert.rejects(wallet.sendTransaction(action.payload.transaction,account),{code:'WALLET_CHANGED'});assert.equal(calls,2);
});
test('real execution controller sends Solana once and retains original signature through read-only recovery',async()=>{
 const {record,action}=await fixture();let sends=0;const data=new Map(),account={chainId:SOLANA_CHAIN,address:sender};
 const wallet={getAccount:async()=>account,signMessage:async()=>signature,sendTransaction:async tx=>{sends++;assert.deepEqual(tx,action.payload.transaction);return signature;}};
 const client={createWalletChallenge:async()=>({wallet:account,message:'challenge',challengeId:'challenge'}),verifyWallet:async()=>({wallet:account,walletToken:'a'.repeat(43),expiresAtMs:Date.now()+60000}),prepareExecution:async()=>({execution:structuredClone(record)}),claimExecution:async()=>{record.status='CLAIMED';record.claimedActionId=action.id;record.revision++;return{execution:structuredClone(record),action};},submitExecution:async(_,{transactionHash})=>{assert.equal(transactionHash,signature);record.status='SUBMITTED';record.submissions=[{actionId:action.id,hash:signature}];record.revision++;return{execution:structuredClone(record)};},refreshExecution:async()=>({execution:structuredClone(record)})};
 const controller=createExecutionController({client,wallet,storage:{getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)}});await controller.proveOwnership();const review=await controller.prepare({source:record.plan.source,destination:record.plan.destination,amount:'0.000001',sender,recipient,nativeFeeBudgets:[{chainId:SOLANA_CHAIN,maxAmountRaw:null}]});await controller.execute(review,()=>true);assert.equal(sends,1);await controller.resume();assert.equal(sends,1);assert.equal(controller.getRecovery().transactionHash,signature);
});
test('Phantom account switch after wallet handoff retains its known hash through failed reporting and recovery',async()=>{
 const {record,action}=await fixture(),data=new Map();let sends=0,offline=true,uncertain=0;
 const provider={publicKey:{toString:()=>sender},connect:async()=>({publicKey:provider.publicKey}),signMessage:async()=>({signature:new Uint8Array(64).fill(9)}),request:async()=>{sends++;provider.publicKey={toString:()=>blockhash};return {signature};}};
 const wallet=createPhantomWallet(provider,SOLANA_CHAIN),account=await wallet.connect();
 const client={createWalletChallenge:async()=>({wallet:account,message:'challenge',expiresAtMs:Date.now()+60000}),verifyWallet:async()=>({wallet:account,walletToken:'a'.repeat(43),expiresAtMs:Date.now()+60000}),prepareExecution:async()=>({execution:structuredClone(record)}),claimExecution:async()=>{record.status='CLAIMED';record.claimedActionId=action.id;record.revision++;return {execution:structuredClone(record),action};},submitExecution:async(_,{transactionHash})=>{assert.equal(transactionHash,signature);if(offline)throw Error('report offline');record.status='SUBMITTED';record.revision++;record.submissions=[{actionId:action.id,hash:signature}];return {execution:structuredClone(record)};},getExecution:async()=>({execution:structuredClone(record)}),refreshExecution:async()=>({execution:structuredClone(record)}),markExecutionUncertain:async()=>{uncertain++;throw Error('must preserve known signature');}};
 const controller=createExecutionController({client,wallet,storage:{getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)}});
 await controller.proveOwnership();const review=await controller.prepare({source:record.plan.source,destination:record.plan.destination,amount:'0.000001',sender,recipient,nativeFeeBudgets:[{chainId:SOLANA_CHAIN,maxAmountRaw:null}]});
 await assert.rejects(controller.execute(review,()=>true),/report offline/);
 assert.equal(controller.getRecovery().transactionHash,signature);assert.equal(controller.getRecovery().phase,'SUBMIT_PENDING');assert.equal(uncertain,0);assert.equal(sends,1);
 provider.publicKey={toString:()=>sender};await wallet.connect();await controller.proveOwnership();offline=false;
 assert.equal((await controller.resume()).status,'SUBMITTED');assert.equal(sends,1);assert.equal(controller.getRecovery().transactionHash,signature);
});
test('Base destination accepts twelve canonical confirmations and rejects a fabricated finalized or underconfirmed receipt',async()=>{
 const {record,action}=await fixture();record.status='COMPLETE';record.nextAction=1;record.submissions=[{actionId:action.id,hash:signature}];record.receipt={chainId:SOLANA_CHAIN,transactionHash:signature,blockNumberRaw:'100',blockHash:blockhash,observedAtMs:Date.now(),confirmations:1};record.destinationReceipt={chainId:BASE,transactionHash:'0x'+'c'.repeat(64),blockNumberRaw:'200',blockHash:'0x'+'d'.repeat(64),commitment:'canonical',confirmations:12,observedAtMs:Date.now(),destinationCredit:{asset:record.plan.destination,recipient,amountRaw:'1'},attribution:{provider:'relay',requestId,sourceTransactionHash:signature}};validateRecord(record);
 for(const patch of [{commitment:'finalized'},{confirmations:11},{blockHash:blockhash},{transactionHash:signature}]){const bad=structuredClone(record);Object.assign(bad.destinationReceipt,patch);assert.throws(()=>validateRecord(bad),{code:'PROTOCOL_ERROR'});}
});
test('generic Base token action requires exact token identity, finite approval and deposit arguments, while canonical USDC can target native SOL',()=>{
 const token='0x'+'33'.repeat(20),depository='0x4cd00e387622c35bddb9b4c962c136462338bc31',word=x=>x.replace(/^0x/,'').padStart(64,'0');
 for(const usdc of [false,true]){
  const source={chainId:BASE,address:usdc?'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913':token,decimals:6},ids=usdc?['relay-usdc-approve','relay-usdc-deposit']:['relay-token-approve','relay-token-deposit'];
  const record={nextAction:0,plan:{source,destination:{chainId:SOLANA_CHAIN,address:SYSTEM_PROGRAM,decimals:9},sender:recipient,amountRaw:'1000',quoteIds:['relay:'+requestId],actions:ids.map(id=>({id})),nativeCosts:[{chainId:BASE,amountRaw:'100000'}]}};
  const tx={chainId:'0x2105',type:'0x2',from:recipient,to:source.address,data:'0x095ea7b3'+word(depository)+word('3e8'),value:'0x0',gas:'0x5208',maxFeePerGas:'0x1',maxPriorityFeePerGas:'0x1',accessList:[]};const action={id:ids[0],chainId:BASE,payload:{type:'EVM_TRANSACTION',transaction:tx,relay:{requestId,orderId,tokenIdentity:{address:token,decimals:6,codeSha256:'a'.repeat(64)}}}};assert.deepEqual(evmTransaction(action,record),tx);
  for(const data of ['0x095ea7b3'+word(depository)+'f'.repeat(64),'0x095ea7b3'+word(token)+word('3e8')]){const bad=structuredClone(action);bad.payload.transaction.data=data;assert.throws(()=>evmTransaction(bad,record),{code:'PROTOCOL_ERROR'});}
  record.nextAction=1;action.id=ids[1];tx.to=depository;tx.data='0xe8017952'+word(recipient)+word(source.address)+word('3e8')+orderId.slice(2);assert.deepEqual(evmTransaction(action,record),tx);
  if(!usdc){const bad=structuredClone(action);bad.payload.relay.tokenIdentity.decimals=18;assert.throws(()=>evmTransaction(bad,record),{code:'PROTOCOL_ERROR'});}
 }
});

test('priority instruction bytes are canonical and cannot be omitted, reordered, or replaced',async()=>{
 const budget={units:200000,microLamports:'123'},ix=computeBudgetInstructions(budget);
 assert.deepEqual([...ix[0].data],[2,64,13,3,0]);assert.deepEqual([...ix[1].data],[3,123,0,0,0,0,0,0,0]);assert.equal(ix[0].programId,'ComputeBudget111111111111111111111111111111');assert.deepEqual(ix[0].keys,[]);
 const {record,action,instruction,priorities}=await fixture();
 for(const instructions of [[instruction],[priorities[1],priorities[0],instruction],[...priorities,instruction,instruction]]){
  const bad=structuredClone(action);bad.payload.transaction.message=encodeLegacyMessage({feePayer:sender,blockhash,instructions});await assert.rejects(walletTransaction(bad,record),{code:'PROTOCOL_ERROR'});
 }
});
