import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyRelayBaseNativeDelivery, createRelayBaseDestinationVerifier } from '../src/relay-base-destination.mjs';
import { computeRelayOrderId } from '../src/relay-order.mjs';
import { validateDestinationReceipt, executionHash } from '@instinct/router-core';

const SOL='solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', BASE='eip155:8453';
const native={chainId:BASE,address:'0x'+'0'.repeat(40),decimals:18};
const recipient='0x'+'12'.repeat(20), sender='47YyVUMwerrz76mCrpgFP3iDva1Vt4ZxpSuxo6AhwabT';
const signature='3TJyaMhSC9s59FWjsP5RHtsS4BsTBP42ALyRtzvww8kfEoMJyHSz3SceyBzgN7aSEnW1Wak7xH6UWY98iE4LAzND';
const transactionHash='0x'+'ab'.repeat(32),blockHash='0x'+'cd'.repeat(32),requestId='0x'+'ef'.repeat(32);
function fixture(){
  const now=Date.now(),extraData='0x000000000000000000000000b92fe925dc43a0ecde6c8b1a2709c170ec4fff4f';
  const order={version:'v1',solverChainId:'base',solver:'0x'+'34'.repeat(20),salt:'0x'+'56'.repeat(32),
    inputs:[{payment:{chainId:'solana',currency:'11111111111111111111111111111111',amount:'1000000',weight:'1'},refunds:[]}],
    output:{chainId:'base',payments:[{recipient,currency:native.address,minimumAmount:'900',expectedAmount:'1000'}],deadline:Math.floor(now/1000)+100,calls:[],extraData},fees:[]};
  const orderId=computeRelayOrderId(order),meta={orderId,requestId,orderData:order};
  const plan={source:{chainId:SOL,address:'11111111111111111111111111111111',decimals:9},destination:native,sender,recipient,
    minimumOutRaw:'900',quoteIds:['relay:'+requestId],actions:[{payload:{relay:meta}}]};
  const tx={hash:transactionHash,chainId:'0x2105',from:'0x'+'78'.repeat(20),to:recipient,input:orderId,value:'0x3e8',blockHash,blockNumber:'0x64',transactionIndex:'0x0'};
  const receipt={transactionHash,from:tx.from,to:recipient,blockHash,blockNumber:'0x64',transactionIndex:'0x0',status:'0x1'};
  const block={hash:blockHash,number:'0x64',timestamp:'0x'+Math.floor(now/1000).toString(16),transactions:[transactionHash]};
  const latest={...block,hash:'0x'+'ee'.repeat(32),number:'0x6f'};
  return {plan,tx,receipt,block,latest,now,orderId};
}
test('native payout proves exact order and recipient independently of provider status',()=>{
  const f=fixture(),p=verifyRelayBaseNativeDelivery(f.plan,transactionHash,f.tx,f.receipt,f.block,f.latest,'0x',f.now);
  assert.equal(p.confirmations,12);assert.equal(p.destinationCredit.amountRaw,'1000');
});
test('unrelated payout, malformed order, reorg, wrong network and contract receiver cannot count as delivery',()=>{
  const changes=[f=>f.tx.input=requestId,f=>f.tx.to=f.tx.from,f=>f.tx.value='0x1',f=>f.tx.chainId='0x1',
    f=>f.receipt.status='0x0',f=>f.receipt.blockHash=transactionHash,f=>f.block.transactions=[],f=>f.latest.number='0x63',
    f=>f.plan.actions[0].payload.relay.orderData.output.payments[0].minimumAmount='1',f=>f.plan.destination={...native,address:recipient}];
  for(const mutate of changes){const f=fixture();mutate(f);assert.throws(()=>verifyRelayBaseNativeDelivery(f.plan,transactionHash,f.tx,f.receipt,f.block,f.latest,'0x',f.now));}
  const f=fixture();assert.throws(()=>verifyRelayBaseNativeDelivery(f.plan,transactionHash,f.tx,f.receipt,f.block,f.latest,'0xef0100',f.now));
});
test('Solana source and canonical Base destination receipts preserve chain-specific formats and depth',()=>{
  const f=fixture(),source={chainId:SOL,transactionHash:signature,blockHash:sender,blockNumberRaw:'100',observedAtMs:f.now,confirmations:1};
  const proof={chainId:BASE,transactionHash,blockHash,blockNumberRaw:'100',observedAtMs:f.now,commitment:'canonical',confirmations:12,
    destinationCredit:{asset:native,recipient,amountRaw:'1000'},attribution:{provider:'relay',requestId,sourceTransactionHash:signature}};
  assert.deepEqual(validateDestinationReceipt(proof,f.plan,source),proof);
  for(const patch of [{confirmations:11},{commitment:'finalized'},{blockHash:sender},{transactionHash:signature}])
    assert.throws(()=>validateDestinationReceipt({...proof,...patch},f.plan,source));
  assert.equal(executionHash(SOL,signature,'transaction'),true);assert.equal(executionHash(SOL,transactionHash,'transaction'),false);
  assert.equal(executionHash(BASE,signature,'transaction'),false);
});
test('unverifiable ERC20 destination is rejected before a quote or wallet action',async()=>{
  let calls=0;const verifier=createRelayBaseDestinationVerifier({fetch:async()=>{calls++;throw new Error('must not fetch');}});
  await assert.rejects(verifier.inspect({...fixture().plan,destination:{...native,address:recipient}},new AbortController().signal),/DESTINATION_RECIPE_UNSUPPORTED/);
  assert.equal(calls,0);
});
