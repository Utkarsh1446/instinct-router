/** Opt-in official Relay transaction construction trust. No signing/broadcasting or arbitrary signature steps. */
import {randomUUID} from 'node:crypto';
import {validateRequest} from '@instinct/router-core';
import {fail} from './base-execution-checks.mjs';
import {createProviderTransport,canonical} from './relay-provider-transport.mjs';
import {validateChains,quoteTerms,economics,plain,sameAsset,eq,ZERO,units,quantity,sha,word,hex,address} from './relay-provider-terms.mjs';
import {protocolReview} from './relay-provider-order.mjs';
import {prepareEvm,preflightEvm} from './relay-provider-evm.mjs';
export const RELAY_PROVIDER_RECIPE='relay-provider-managed-v1';
const keys=(value,allowed)=>plain(value)&&Object.keys(value).every(k=>allowed.includes(k));
export function createRelayProviderExecution({fetch:wire=globalThis.fetch,now=Date.now,chains,receiptVerifier,apiKey}={}){
 if(typeof wire!=='function'||typeof now!=='function'||!receiptVerifier||typeof receiptVerifier.confirm!=='function'||apiKey!==undefined&&(typeof apiKey!=='string'||apiKey.length>256||/[\r\n]/.test(apiKey)))fail('INVALID_EXECUTION_CONFIG');
 const catalog=validateChains(chains),transport=createProviderTransport(wire);
 const readFor=chain=>(method,params,signal)=>transport.read(chain.rpcUrl,method,params,signal);
 const pair=request=>{const source=catalog.get(request.source?.chainId),destination=catalog.get(request.destination?.chainId);if(!source||!destination)fail('EXECUTION_ADAPTER_UNAVAILABLE');return {source,destination};};
 const clock=()=>{const value=now();if(!Number.isSafeInteger(value)||value<0)fail('INVALID_EXECUTION_CONFIG');return value;};
 function terms(plan,action){
  const {source,destination}=pair(plan),p=action?.payload,route=plan.providerRoute;
  if(!plain(plan)||!Array.isArray(plan.actions)||!plan.actions.length||plan.actions.length>2||new Set(plan.actions.map(a=>a.id)).size!==plan.actions.length||
   !plain(route)||route.provider!=='relay'||route.mode!=='PROVIDER_MANAGED'||route.sourceVm!==source.vm||route.destinationVm!==destination.vm||!/^([a-f0-9]{64})$/.test(route.quoteHash)||
   !keys(p,['type','version','vm','providerId','verification','kind','rfq','spending','transaction','bindings','validation'])||p.type!=='PROVIDER_REVIEWED_TRANSACTION'||p.version!==1||p.vm!==source.vm||p.providerId!=='relay'||p.verification!=='TRUSTED_SERVER_FRESH_RFQ'||
   action.chainId!==source.chainId||!['TOKEN_APPROVAL','FUNDING','SWAP'].includes(p.kind)||action.id!==(p.kind==='TOKEN_APPROVAL'?'relay-provider-approve':p.kind==='SWAP'?'relay-provider-swap':'relay-provider-deposit')||
   !plan.actions.some(a=>canonical(a)===canonical(action))||!keys(p.rfq,['requestId','commitmentHash','expiresAtMs'])||p.rfq.requestId!==route.requestId||p.rfq.commitmentHash!==route.quoteHash||p.rfq.expiresAtMs!==plan.expiresAtMs||
   !keys(p.spending,['asset','amountRaw','nativeValueRaw','nativeFeeCapRaw','approval'])||!sameAsset(p.spending.asset,plan.source)||p.spending.amountRaw!==plan.amountRaw||
   !Number.isSafeInteger(plan.expiresAtMs)||units(plan.amountRaw)===0n||units(plan.minimumOutRaw)===0n||units(p.spending.nativeFeeCapRaw)===0n||
   !plain(p.bindings)||p.bindings.requestId!==route.requestId||p.bindings.quoteHash!==route.quoteHash||p.bindings.transactionHash!==sha(p.transaction)||
   !sameAsset(p.bindings.source,plan.source)||!sameAsset(p.bindings.destination,plan.destination)||p.bindings.sender!==plan.sender||p.bindings.recipient!==plan.recipient||p.bindings.amountRaw!==plan.amountRaw||p.bindings.minimumOutRaw!==plan.minimumOutRaw||p.bindings.expiresAtMs!==plan.expiresAtMs)
   fail('RELAY_PROVIDER_BINDING_MISMATCH');
  if(plan.quoteIds?.length!==1||plan.quoteIds[0]!=='relay:'+route.requestId||route.sourceConfirmations!==(source.vm==='EVM'?Math.max(12,source.confirmations):1)||route.destinationConfirmations!==destination.confirmations)fail('RELAY_PROVIDER_BINDING_MISMATCH');
  const cap=plan.nativeCosts?.find(c=>c.chainId===source.chainId);
  if(plan.nativeCosts?.length!==1||!cap||units(cap.amountRaw)!==plan.actions.reduce((n,a)=>n+units(a.payload.spending.nativeFeeCapRaw),0n))fail('RELAY_PROVIDER_BINDING_MISMATCH');
  if(source.vm==='EVM'&&!eq(plan.source.address,ZERO)&&(!source.allowedTargets.includes(p.validation?.spender)||p.spending.approval&&p.spending.approval.spender!==p.validation.spender))fail('RELAY_PROVIDER_BINDING_MISMATCH');
  const approval=p.kind==='TOKEN_APPROVAL';
  if(approval&&(plan.actions.length!==2||plan.actions[0].id!==action.id)||!approval&&plan.actions.at(-1).id!==action.id||plan.actions.length===2&&plan.actions[0].payload.kind!=='TOKEN_APPROVAL')fail('RELAY_PROVIDER_BINDING_MISMATCH');
  if(source.vm==='EVM'){
   const tx=p.transaction;
   if(!keys(tx,['from','to','chainId','type','data','value','gas','gasPrice','maxFeePerGas','maxPriorityFeePerGas','accessList'])||tx.chainId!==hex(BigInt(source.providerChainId))||!eq(tx.from,plan.sender)||!address(tx.to)||
    typeof tx.data!=='string'||!/^0x(?:[0-9a-f]{2}){0,65536}$/.test(tx.data)||quantity(tx.gas)<21000n||quantity(tx.gas)>5000000n||
    p.spending.nativeValueRaw!==quantity(tx.value).toString()||quantity(tx.value)!==(eq(plan.source.address,ZERO)&&!approval?units(plan.amountRaw):0n))fail('RELAY_PROVIDER_BINDING_MISMATCH');
   if(tx.type==='0x2'){
    if(Object.hasOwn(tx,'gasPrice')||!Array.isArray(tx.accessList)||tx.accessList.length||quantity(tx.maxFeePerGas)===0n||quantity(tx.maxFeePerGas)>100000000000000n||quantity(tx.maxPriorityFeePerGas)>quantity(tx.maxFeePerGas))fail('RELAY_PROVIDER_BINDING_MISMATCH');
   }else if(tx.type!=='0x0'||Object.hasOwn(tx,'maxFeePerGas')||Object.hasOwn(tx,'maxPriorityFeePerGas')||Object.hasOwn(tx,'accessList')||quantity(tx.gasPrice)===0n||quantity(tx.gasPrice)>100000000000000n)fail('RELAY_PROVIDER_BINDING_MISMATCH');
   if(approval){const a=p.spending.approval;if(!keys(a,['spender','amountRaw'])||!source.allowedTargets.includes(a.spender)||a.amountRaw!==plan.amountRaw||!eq(tx.to,plan.source.address)||tx.data!=='0x095ea7b3'+word(a.spender)+word(plan.amountRaw))fail('RELAY_PROVIDER_APPROVAL_UNSUPPORTED');}
   else if(p.spending.approval!==undefined||!source.allowedTargets.includes(tx.to.toLowerCase()))fail('RELAY_PROVIDER_TRANSACTION_UNSUPPORTED');
  }
  return {source,destination};
 }
 async function validateProtocol(plan,action){
  const protocol=action.payload.validation?.protocol;if(!protocol)return;
  const {source,destination}=pair(plan);
  await protocolReview({protocol:{v2:protocol},details:{currencyOut:{amount:protocol.orderData?.output?.payments?.[0]?.expectedAmount,minimumAmount:plan.minimumOutRaw}},steps:plan.actions.filter(a=>a.payload.kind!=='TOKEN_APPROVAL').map(a=>({id:a.payload.kind==='SWAP'?'swap':'deposit',items:[{data:a.payload.transaction}]}))},plan,source,destination,catalog);
 }
 async function preflight(plan,action,signal){plan=structuredClone(plan);action=structuredClone(action);const {source}=terms(plan,action);
  return transport.run(async inner=>{await validateProtocol(plan,action);if(clock()>=plan.expiresAtMs)fail('EXECUTION_REVIEW_EXPIRED');
   if(typeof receiptVerifier.inspect==='function')await receiptVerifier.inspect(plan,inner);
   const args={plan,action,chain:source,read:readFor(source),signal:inner,now:clock};
   const result=source.vm==='EVM'?await preflightEvm(args):await(await import('./relay-provider-solana.mjs')).preflightSolana(args);
   if(result?.ready!==true||clock()>=plan.expiresAtMs)fail('EXECUTION_REVIEW_EXPIRED');return result;
  },signal);
 }
 return Object.freeze({
  validatePins:()=>true,
  preflight,
  async prepare(request,signal){request=structuredClone(request);const started=clock();validateRequest(request,started);const {source,destination}=pair(request);
   return transport.run(async inner=>{
    if(typeof receiptVerifier.inspect==='function')await receiptVerifier.inspect(request,inner);
    const raw=await transport.json('https://api.relay.link/quote/v2',{user:request.sender,recipient:request.recipient,refundTo:request.sender,originChainId:source.providerChainId,destinationChainId:destination.providerChainId,
     originCurrency:request.source.address,destinationCurrency:request.destination.address,amount:request.amountRaw,tradeType:'EXACT_INPUT',slippageTolerance:String(request.slippageBps),usePermit:false,useDepositAddress:false,explicitDeposit:true,includeProtocolData:true,forceSolverExecution:true},inner,apiKey?{'x-api-key':apiKey}:{});
    const reviewed=quoteTerms(request,raw,source,destination,started),protocol=await protocolReview(raw,request,source,destination,catalog);
    let prepared;
    if(source.vm==='EVM')prepared=await prepareEvm({request,terms:reviewed,chain:source,read:readFor(source),signal:inner,now:clock});
    else{
     if(reviewed.approval)fail('RELAY_PROVIDER_STEP_UNSUPPORTED');
     const result=await(await import('./relay-provider-solana.mjs')).prepareSolana({request,rawTransaction:reviewed.funding.data,chain:source,read:readFor(source),signal:inner,now:clock,expiresAtMs:reviewed.expiresAtMs});
     prepared={feeCapRaw:result.feeCapRaw,actions:[{id:reviewed.funding.kind==='SWAP'?'relay-provider-swap':'relay-provider-deposit',kind:reviewed.funding.kind,transaction:result.transaction,feeCapRaw:result.feeCapRaw,nativeValueRaw:result.nativeValueRaw,
      validation:{...(result.sourceIdentity?{sourceIdentity:result.sourceIdentity}:{}),...(result.evidence?{evidence:result.evidence}:{})}}]};
    }
    const economic=economics(request,raw,source,units(prepared.feeCapRaw));
    const plan={routeId:'relay-provider:'+randomUUID(),quoteIds:['relay:'+reviewed.requestId],source:request.source,destination:request.destination,sender:request.sender,recipient:request.recipient,amountRaw:request.amountRaw,minimumOutRaw:reviewed.minimumOutRaw,
     expiresAtMs:reviewed.expiresAtMs,nativeCosts:[{chainId:source.chainId,amountRaw:prepared.feeCapRaw}],providerRoute:{provider:'relay',mode:'PROVIDER_MANAGED',requestId:reviewed.requestId,quoteHash:reviewed.quoteHash,sourceConfirmations:source.vm==='EVM'?Math.max(12,source.confirmations):1,destinationConfirmations:destination.confirmations,sourceVm:source.vm,destinationVm:destination.vm},actions:[]};
    plan.actions=prepared.actions.map(a=>({id:a.id,chainId:source.chainId,payload:{type:'PROVIDER_REVIEWED_TRANSACTION',version:1,vm:source.vm,providerId:'relay',verification:'TRUSTED_SERVER_FRESH_RFQ',kind:a.kind,
     rfq:{requestId:reviewed.requestId,commitmentHash:reviewed.quoteHash,expiresAtMs:reviewed.expiresAtMs},spending:{asset:request.source,amountRaw:request.amountRaw,nativeValueRaw:source.vm==='EVM'?quantity(a.transaction.value).toString():a.nativeValueRaw,nativeFeeCapRaw:a.feeCapRaw,...(a.approval?{approval:a.approval}:{})},transaction:a.transaction,
     validation:{...a.validation,...(protocol?{protocol}: {})},bindings:{requestId:reviewed.requestId,quoteHash:reviewed.quoteHash,source:request.source,destination:request.destination,sender:request.sender,recipient:request.recipient,amountRaw:request.amountRaw,minimumOutRaw:reviewed.minimumOutRaw,slippageBps:request.slippageBps,expiresAtMs:reviewed.expiresAtMs,transactionHash:sha(a.transaction)}}}));
    for(const action of plan.actions)terms(plan,action);if(clock()>=plan.expiresAtMs)fail('EXECUTION_REVIEW_EXPIRED');
    return {plan,...economic,expectedOutRaw:reviewed.expectedOutRaw,minimumOutRaw:reviewed.minimumOutRaw,estimatedCompletionMs:reviewed.estimatedCompletionMs,pricingValidUntilMs:Math.min(started+15000,plan.expiresAtMs),quoteId:plan.quoteIds[0]};
   },signal);
  },
  async confirm(plan,action,hash,signal){plan=structuredClone(plan);action=structuredClone(action);terms(plan,action);return transport.run(async inner=>{await validateProtocol(plan,action);return receiptVerifier.confirm(plan,action,hash,inner);},signal);},
  async release({record},signal){record=structuredClone(record);
   if(!record||record.claimedActionId!==null||record.nextAction!==1||record.plan?.actions?.length!==2||record.plan.actions[0].id!=='relay-provider-approve'||record.submissions?.length!==1||record.submissions[0].actionId!=='relay-provider-approve')return {ready:false};
   const action=record.plan.actions[0];terms(record.plan,action);
   const evidence=await transport.run(async inner=>{await validateProtocol(record.plan,action);return receiptVerifier.confirm(record.plan,action,record.submissions[0].hash,inner);},signal);
   return {ready:evidence?.success===true&&!!evidence.receipt&&!evidence.confirmedFailure&&!evidence.destinationCredit&&!evidence.destinationReceipt};
  },
 });
}
