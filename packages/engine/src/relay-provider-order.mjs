/** Optional protocol terms strengthen provider-managed reviews without pretending to decode origin DEX logic. */
import {recoverMessageAddress,hashStruct} from 'viem';
import {fail} from './base-execution-checks.mjs';
import {eq,units,address,ZERO,word,amount} from './relay-provider-terms.mjs';
import {solanaBytes} from './relay-order.mjs';
const types={Order:[['version','string'],['solverChainId','string'],['solver','address'],['salt','uint256'],['inputs','Input[]'],['output','Output'],['fees','Fee[]']],Input:[['payment','InputPayment'],['refunds','InputRefund[]']],InputPayment:[['chainId','string'],['currency','bytes'],['amount','uint256'],['weight','uint256']],InputRefund:[['chainId','string'],['recipient','bytes'],['currency','bytes'],['minimumAmount','uint256'],['deadline','uint32'],['extraData','bytes']],Output:[['chainId','string'],['payments','OutputPayment[]'],['deadline','uint32'],['calls','bytes[]'],['extraData','bytes']],OutputPayment:[['recipient','bytes'],['currency','bytes'],['minimumAmount','uint256'],['expectedAmount','uint256']],Fee:[['recipientChainId','string'],['recipient','bytes'],['currencyChainId','string'],['currency','bytes'],['amount','uint256']]};
const ABI=Object.fromEntries(Object.entries(types).map(([k,v])=>[k,v.map(([name,type])=>({name,type}))]));
export function providerOrderId(order,catalog){
 const chains=new Map([...catalog.values()].map(c=>[c.protocolChainId,c.vm]));
 const bytes=(v,chain)=>{if(chains.get(chain)==='SOLANA')return solanaBytes(v);if(chains.get(chain)==='EVM'&&address(v))return v.toLowerCase();fail('RELAY_PROVIDER_PROTOCOL_MISMATCH');};
 try{return hashStruct({types:ABI,primaryType:'Order',data:{...order,salt:BigInt(order.salt),inputs:order.inputs.map(i=>({payment:{...i.payment,currency:bytes(i.payment.currency,i.payment.chainId),amount:BigInt(i.payment.amount),weight:BigInt(i.payment.weight)},refunds:i.refunds.map(r=>({...r,recipient:bytes(r.recipient,r.chainId),currency:bytes(r.currency,r.chainId),minimumAmount:BigInt(r.minimumAmount)}))})),output:{...order.output,payments:order.output.payments.map(p=>({...p,recipient:bytes(p.recipient,order.output.chainId),currency:bytes(p.currency,order.output.chainId),minimumAmount:BigInt(p.minimumAmount),expectedAmount:BigInt(p.expectedAmount)}))}}});}catch{fail('RELAY_PROVIDER_PROTOCOL_MISMATCH');}
}
const safeKeys=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).every(k=>keys.includes(k));
export async function protocolReview(raw,request,source,destination,catalog){
 const protocol=raw.protocol?.v2;if(protocol===undefined)return null;
 const order=protocol.orderData,out=order?.output,pay=order?.inputs?.[0]?.payment,output=out?.payments?.[0];
 if(!safeKeys(order,['version','solverChainId','solver','salt','inputs','output','fees'])||order.version!=='v1'||!/^0x[0-9a-fA-F]{64}$/.test(protocol.orderId)||!address(order.solver)||
  !Array.isArray(order.inputs)||order.inputs.length!==1||!safeKeys(order.inputs[0],['payment','refunds'])||!safeKeys(pay,['chainId','currency','amount','weight'])||pay.chainId!==source.protocolChainId||pay.weight!=='1'||units(pay.amount)===0n||
  !Array.isArray(order.fees)||order.fees.length||!safeKeys(out,['chainId','payments','deadline','calls','extraData'])||out.chainId!==destination.protocolChainId||!Array.isArray(out.payments)||out.payments.length!==1||!Array.isArray(out.calls)||out.calls.length||
  !safeKeys(output,['recipient','currency','minimumAmount','expectedAmount'])||!(destination.vm==='EVM'?eq(output.recipient,request.recipient)&&eq(output.currency,request.destination.address):output.recipient===request.recipient&&output.currency===request.destination.address)||
  output.minimumAmount!==raw.details.currencyOut.minimumAmount||output.expectedAmount!==raw.details.currencyOut.amount||!Number.isSafeInteger(out.deadline)||typeof out.extraData!=='string'||!/^0x(?:[a-f0-9]{2}){0,256}$/i.test(out.extraData))fail('RELAY_PROVIDER_PROTOCOL_MISMATCH');
 const refunds=order.inputs[0].refunds;
 if(!Array.isArray(refunds)||refunds.length!==2)fail('RELAY_PROVIDER_REFUND_MISMATCH');
 // Same-chain orders contain two legs on the same chain; recipient and currency remain explicit in the reviewed snapshot.
 for(const r of refunds){
  const src=r.chainId===source.protocolChainId,dst=r.chainId===destination.protocolChainId;
  if(!safeKeys(r,['chainId','recipient','currency','minimumAmount','deadline','extraData'])||!src&&!dst||r.minimumAmount!=='0'||r.deadline!==out.deadline||
   typeof r.extraData!=='string'||!/^0x(?:[a-f0-9]{2}){0,256}$/i.test(r.extraData)||
   !(src&&(source.vm==='EVM'?eq(r.recipient,request.sender):r.recipient===request.sender)||dst&&(destination.vm==='EVM'?eq(r.recipient,request.recipient):r.recipient===request.recipient)))fail('RELAY_PROVIDER_REFUND_MISMATCH');
 }
 if(source.protocolChainId!==destination.protocolChainId&&new Set(refunds.map(r=>r.chainId)).size!==2)fail('RELAY_PROVIDER_REFUND_MISMATCH');
 if(providerOrderId(order,catalog).toLowerCase()!==protocol.orderId.toLowerCase())fail('RELAY_PROVIDER_PROTOCOL_MISMATCH');
 const funding=raw.steps.find(s=>['deposit','swap'].includes(s.id))?.items?.[0]?.data;
 if(source.vm==='EVM'&&source.depository&&eq(funding?.to,source.depository)){
  const native=eq(request.source.address,ZERO),expected='0x'+(native?'49290c1c'+word(request.sender):'e8017952'+word(request.sender)+word(request.source.address)+word(request.amountRaw))+protocol.orderId.slice(2);
  if(!eq(pay.currency,request.source.address)||pay.amount!==request.amountRaw||!eq(protocol.paymentDetails?.depository,source.depository)||protocol.paymentDetails.currency.toLowerCase()!==request.source.address.toLowerCase()||protocol.paymentDetails.amount!==request.amountRaw||funding.data.toLowerCase()!==expected.toLowerCase()||amount(funding.value??'0')!==(native?units(request.amountRaw):0n))fail('RELAY_PROVIDER_PROTOCOL_MISMATCH');
 }
 if(protocol.orderSignature!==undefined){
  const trusted=[...catalog.values()].flatMap(c=>c.solverAddresses??[]);
  if(typeof protocol.orderSignature!=='string'||!/^0x[0-9a-fA-F]{130}$/.test(protocol.orderSignature)||!trusted.some(a=>eq(a,order.solver)))fail('RELAY_PROVIDER_SIGNATURE_INVALID');
  let signer;try{signer=await recoverMessageAddress({message:{raw:protocol.orderId},signature:protocol.orderSignature});}catch{fail('RELAY_PROVIDER_SIGNATURE_INVALID');}
  if(!eq(signer,order.solver))fail('RELAY_PROVIDER_SIGNATURE_INVALID');
 }
 return {orderId:protocol.orderId,orderData:structuredClone(order),...(protocol.paymentDetails?{paymentDetails:structuredClone(protocol.paymentDetails)}:{}),...(protocol.orderSignature?{orderSignature:protocol.orderSignature}:{})};
}
