/** Explicit provider construction trust. These checks do not independently decode arbitrary DEX calls. */
import {createHash} from 'node:crypto';
import {fail,enforceEconomicLimits} from './base-execution-checks.mjs';
import {canonical,https} from './relay-provider-transport.mjs';
export {canonical} from './relay-provider-transport.mjs';
export const ZERO='0x0000000000000000000000000000000000000000';
export const plain=v=>v&&Object.getPrototypeOf(v)===Object.prototype;
export const address=v=>typeof v==='string'&&/^0x[0-9a-fA-F]{40}$/.test(v);
export const eq=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
export const sha=v=>createHash('sha256').update(typeof v==='string'?v:canonical(v)).digest('hex');
export const hex=v=>'0x'+v.toString(16);
export const word=v=>(typeof v==='string'&&v.startsWith('0x')?v.slice(2):BigInt(v).toString(16)).padStart(64,'0');
export function units(v){if(typeof v!=='string'||!/^(0|[1-9][0-9]{0,77})$/.test(v)||BigInt(v)>=(1n<<256n))fail('RELAY_PROVIDER_BINDING_MISMATCH');return BigInt(v);}
export function quantity(v){if(typeof v!=='string'||!/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/.test(v))fail('RELAY_PROVIDER_EVIDENCE_INVALID');return BigInt(v);}
export const amount=v=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?BigInt(v):typeof v==='string'&&/^0x/.test(v)?quantity(v):units(v);
export const sameAsset=(a,b)=>a?.chainId===b?.chainId&&a.decimals===b.decimals&&(a.chainId.startsWith('eip155:')?eq(a.address,b.address):a.address===b.address);
const KEYS=['multicaller','onlyOwnerMulticaller','relayReceiver','erc20Router','approvalProxy'];
export function validateChains(input){
 if(!Array.isArray(input)||!input.length||input.length>256)fail('INVALID_EXECUTION_CONFIG');const map=new Map(),providerIds=new Set();
 for(const raw of structuredClone(input)){
  if(!plain(raw)||!['EVM','SOLANA'].includes(raw.vm)||typeof raw.chainId!=='string'||!Number.isSafeInteger(raw.providerChainId)||raw.providerChainId<1||map.has(raw.chainId)||providerIds.has(raw.providerChainId)||
   !plain(raw.nativeCurrency)||!Number.isInteger(raw.nativeCurrency.decimals)||raw.nativeCurrency.decimals<0||raw.nativeCurrency.decimals>255||typeof raw.protocolChainId!=='string'||raw.protocolChainId.length>64||
   !Number.isSafeInteger(raw.confirmations)||raw.confirmations<1||raw.confirmations>2048)fail('INVALID_EXECUTION_CONFIG');
  raw.rpcUrl=https(raw.rpcUrl);
  if(raw.vm==='EVM'&&(!/^eip155:[1-9][0-9]{0,15}$/.test(raw.chainId)||Number(raw.chainId.slice(7))!==raw.providerChainId||!eq(raw.nativeCurrency.address,ZERO)))fail('INVALID_EXECUTION_CONFIG');
  if(raw.vm==='SOLANA'&&(!raw.chainId.startsWith('solana:')||raw.nativeCurrency.address!=='11111111111111111111111111111111'||raw.nativeCurrency.decimals!==9))fail('INVALID_EXECUTION_CONFIG');
  if(raw.vm==='EVM'){
   if(!plain(raw.contracts)||Object.entries(raw.contracts).some(([key,v])=>!['multicall3',...KEYS].includes(key)||!address(v)||BigInt(v)<=2n)||raw.depository!==undefined&&(!address(raw.depository)||BigInt(raw.depository)<=2n))fail('INVALID_EXECUTION_CONFIG');
   raw.allowedTargets=[...new Set([...KEYS.map(k=>raw.contracts[k]).filter(Boolean),raw.depository].filter(Boolean).map(v=>v.toLowerCase()))];
   if(!raw.allowedTargets.length)fail('INVALID_EXECUTION_CONFIG');
   raw.feeModel??=[8453,10].includes(raw.providerChainId)?'OPSTACK':[1,42161].includes(raw.providerChainId)?'STANDARD':'PROVIDER_ESTIMATE';
   if(!['STANDARD','OPSTACK','PROVIDER_ESTIMATE'].includes(raw.feeModel)||raw.feeModel==='OPSTACK'&&raw.gasOracle!==undefined&&!address(raw.gasOracle))fail('INVALID_EXECUTION_CONFIG');
   if(raw.feeModel==='OPSTACK')raw.gasOracle??='0x420000000000000000000000000000000000000f';
  }
  map.set(raw.chainId,raw);providerIds.add(raw.providerChainId);
 }return map;
}
function currency(value,asset,chain){return value?.chainId===chain.providerChainId&&value.decimals===asset.decimals&&(chain.vm==='EVM'?eq(value.address,asset.address):value.address===asset.address);}
export function quoteTerms(request,raw,source,destination,started){
 const d=raw?.details;
 if(!plain(raw)||!plain(d)||!Array.isArray(raw.steps)||!raw.steps.length||raw.steps.length>2||!(source.vm==='EVM'?eq(d.sender,request.sender):d.sender===request.sender)||!(destination.vm==='EVM'?eq(d.recipient,request.recipient):d.recipient===request.recipient)||
  d.slippageTolerance?.total!==String(request.slippageBps)||!currency(d.currencyIn?.currency,request.source,source)||!currency(d.currencyOut?.currency,request.destination,destination)||
  d.currencyIn.amount!==request.amountRaw||d.currencyIn.minimumAmount!==undefined&&d.currencyIn.minimumAmount!==request.amountRaw)fail('RELAY_PROVIDER_QUOTE_MISMATCH');
 const expected=units(d.currencyOut.amount),minimum=units(d.currencyOut.minimumAmount);
 if(!minimum||expected<minimum||minimum<expected*BigInt(10000-request.slippageBps)/10000n)fail('RELAY_PROVIDER_QUOTE_MISMATCH');
 let requestId,approval=null,funding=null;
 for(const step of raw.steps){
  if(!plain(step)||step.kind!=='transaction'||!['approve','approval','deposit','swap'].includes(step.id)||!Array.isArray(step.items)||step.items.length!==1||step.items[0]?.status!=='incomplete'||!plain(step.items[0].data)||step.depositAddress)fail('RELAY_PROVIDER_STEP_UNSUPPORTED');
  if(step.requestId!==undefined){if(typeof step.requestId!=='string'||!/^0x[0-9a-f]{64}$/.test(step.requestId)||requestId&&requestId!==step.requestId)fail('RELAY_PROVIDER_QUOTE_MISMATCH');requestId=step.requestId;}
  if(['approve','approval'].includes(step.id)){if(approval||funding)fail('RELAY_PROVIDER_STEP_UNSUPPORTED');approval=step.items[0].data;}
  else {if(funding)fail('RELAY_PROVIDER_STEP_UNSUPPORTED');funding={kind:step.id==='swap'?'SWAP':'FUNDING',data:step.items[0].data};}
 }
 if(!funding||!requestId)fail('RELAY_PROVIDER_STEP_UNSUPPORTED');
 const protocolDeadline=raw.protocol?.v2?.orderData?.output?.deadline;
 if(protocolDeadline!==undefined&&(!Number.isSafeInteger(protocolDeadline)||protocolDeadline*1000<=started))fail('RELAY_PROVIDER_QUOTE_EXPIRED');
 const expiresAtMs=Math.min(started+60000,request.deadlineMs,protocolDeadline===undefined?Infinity:protocolDeadline*1000);
 if(!Number.isSafeInteger(expiresAtMs)||expiresAtMs<=started)fail('RELAY_PROVIDER_QUOTE_EXPIRED');
 const seconds=d.timeEstimate;
 if(!Number.isFinite(seconds)||seconds<=0||seconds>86400)fail('RELAY_PROVIDER_ECONOMICS_INVALID');
 return {requestId,approval,funding,providerFullGasEstimateRaw:units(raw.fees?.gas?.amount).toString(),quoteHash:sha(raw),minimumOutRaw:minimum.toString(),expectedOutRaw:expected.toString(),expiresAtMs,estimatedCompletionMs:Math.ceil(seconds*1000)};
}
const scale=10n**18n;
function decimal(v){if(typeof v!=='string'||! /^(?:0|[1-9][0-9]{0,18})(?:\.[0-9]{1,18})?$/.test(v))fail('RELAY_PROVIDER_ECONOMICS_INVALID');const [a,b='']=v.split('.');return BigInt(a)*scale+BigInt(b.padEnd(18,'0'));}
export const ceil=(n,d)=>(n+d-1n)/d;
export function economics(request,raw,source,totalNative){
 const gas=raw.fees?.gas,input=decimal(raw.details.currencyIn.amountUsd),gasAmount=units(gas?.amount),gasUsd=decimal(gas?.amountUsd);
 if(!currency(gas?.currency,{chainId:source.chainId,...source.nativeCurrency},source)||!input||!gasAmount||!gasUsd||raw.fees?.app?.amount!=='0')fail('RELAY_PROVIDER_ECONOMICS_INVALID');
 const abs=v=>typeof v==='string'&&v.startsWith('-')?decimal(v.slice(1)):decimal(v);
 const fee=['execution','relay','app'].reduce((n,k)=>n+abs(raw.details.expandedPriceImpact?.[k]?.usd),0n)+ceil(gasUsd*totalNative,gasAmount);
 const feeBps=Number(ceil(fee*10000n,input)),priceImpactBps=Number(ceil(abs(raw.details.swapImpact?.percent)*100n,scale));
 enforceEconomicLimits(request,feeBps,priceImpactBps);return {feeBps,priceImpactBps};
}
