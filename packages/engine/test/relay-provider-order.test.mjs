/** Public structural signed-order fixtures, no live RFQs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {privateKeyToAccount} from 'viem/accounts';
import {protocolReview,providerOrderId} from '../src/relay-provider-order.mjs';
import {validateChains} from '../src/relay-provider-terms.mjs';
import {fixture,OWNER} from './fixtures/base-execution.mjs';
import {relayQuote,relayRequest} from './fixtures/relay-execution.mjs';
const account=privateKeyToAccount('0x'+'01'.repeat(32)); // Public test vector.
async function setup(){
 const f=fixture(),request=relayRequest(f),raw=relayQuote(f);
 const catalog=validateChains([{chainId:request.source.chainId,providerChainId:8453,vm:'EVM',rpcUrl:'https://rpc.example/',protocolChainId:'base',nativeCurrency:{address:request.source.address,decimals:18,symbol:'ETH'},contracts:{},depository:'0x4cd00e387622c35bddb9b4c962c136462338bc31',solverAddresses:[account.address],confirmations:12},
 {chainId:request.destination.chainId,providerChainId:792703809,vm:'SOLANA',rpcUrl:'https://sol.example/',protocolChainId:'solana',nativeCurrency:{address:'11111111111111111111111111111111',decimals:9,symbol:'SOL'},confirmations:1}]);
 const protocol=raw.protocol.v2;protocol.orderData.solver=account.address;protocol.orderId=providerOrderId(protocol.orderData,catalog);
 protocol.orderSignature=await account.signMessage({message:{raw:protocol.orderId}});
 raw.steps[0].items[0].data.data='0x49290c1c'+request.sender.slice(2).padStart(64,'0')+protocol.orderId.slice(2);
 return {request,raw,catalog,source:catalog.get(request.source.chainId),destination:catalog.get(request.destination.chainId)};
}
test('generic protocol hash matches configured EVM/Solana mapping and pinned signature',async()=>{
 const f=await setup(),review=await protocolReview(f.raw,f.request,f.source,f.destination,f.catalog);
 assert.equal(review.orderId,f.raw.protocol.v2.orderId);assert.equal(review.orderSignature,f.raw.protocol.v2.orderSignature);
 assert.equal(review.paymentDetails.depository,'0x4cd00e387622c35bddb9b4c962c136462338bc31');
});
test('available protocol cannot conceal changed output, hash, signature, calls, fees or refund ownership',async()=>{
 for(const mutate of [f=>f.raw.protocol.v2.orderData.output.payments[0].recipient=f.request.sender,
  f=>f.raw.protocol.v2.orderId='0x'+'00'.repeat(32),f=>f.raw.protocol.v2.orderSignature='0x'+'00'.repeat(65),
  f=>f.raw.protocol.v2.orderData.output.calls=['0x'],f=>f.raw.protocol.v2.orderData.fees=[{}],
  f=>f.raw.protocol.v2.orderData.inputs[0].refunds[0].recipient='0x'+'22'.repeat(20),
  f=>f.raw.protocol.v2.orderData.output.payments[0].unknown='malicious']){
  const f=await setup();mutate(f);await assert.rejects(protocolReview(f.raw,f.request,f.source,f.destination,f.catalog));
 }
});
test('direct canonical depository payment additionally binds exact currency, value, calldata and paymentDetails',async()=>{
 for(const mutate of [f=>f.raw.steps[0].items[0].data.value='1',f=>f.raw.steps[0].items[0].data.data+='00',
  f=>f.raw.protocol.v2.paymentDetails.depository='0x'+'22'.repeat(20),f=>f.raw.protocol.v2.paymentDetails.amount='1']){
  const f=await setup();mutate(f);await assert.rejects(protocolReview(f.raw,f.request,f.source,f.destination,f.catalog));
 }
});
