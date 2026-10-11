/** Bounded, configured read endpoints only. Actual fetch/body leases survive ignored aborts. */
import { baseExecutionPrimitives as p } from './base-readiness.mjs';
import { fail,ExecutionEngineError } from './base-execution-checks.mjs';
export const canonical=v=>v && typeof v==='object'?Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
export function https(value){let u;try{u=new URL(value);}catch{fail('INVALID_EXECUTION_CONFIG');}if(u.protocol!=='https:'||u.username||u.password||u.hash)fail('INVALID_EXECUTION_CONFIG');return u.href;}
export function createProviderTransport(wire){
 let actual=0,operations=0,serial=0;
 async function json(url,body,signal,headers={}){
  if(signal.aborted)fail('EXECUTION_CANCELLED');if(actual>=6)fail('EXECUTION_BUSY');actual++;
  let stop,reader;const stopped=new Promise((_,reject)=>{stop=()=>reject(new ExecutionEngineError('EXECUTION_CANCELLED'));signal.addEventListener('abort',stop,{once:true});});
  const work=Promise.resolve().then(async()=>{
   if(signal.aborted)fail('EXECUTION_CANCELLED');
   const response=await wire(url,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body),signal,redirect:'error',credentials:'omit'});
   if(signal.aborted||!response.ok&&!(url==='https://api.relay.link/quote/v2'&&response.status===400)||response.redirected||response.url&&response.url!==url){await response.body?.cancel().catch(()=>{});fail(signal.aborted?'EXECUTION_CANCELLED':'RELAY_PROVIDER_UNAVAILABLE');}
   const length=response.headers.get('content-length');
   if(length!==null&&(!/^\d+$/.test(length)||Number(length)>524288)){await response.body?.cancel().catch(()=>{});fail('RELAY_PROVIDER_EVIDENCE_INVALID');}
   reader=response.body?.getReader();if(!reader)fail('RELAY_PROVIDER_EVIDENCE_INVALID');
   const chunks=[];let size=0;try{for(;;){if(signal.aborted)fail('EXECUTION_CANCELLED');const part=await reader.read();if(signal.aborted)fail('EXECUTION_CANCELLED');if(part.done)break;size+=part.value.length;if(size>524288||chunks.length>=4096)fail('RELAY_PROVIDER_EVIDENCE_INVALID');chunks.push(part.value);}const parsed=p.strictJson(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));if(!response.ok){const allowed=['AMOUNT_TOO_LOW','INSUFFICIENT_FUNDS','UNSUPPORTED_ROUTE','UNSUPPORTED_CURRENCY','NO_SWAP_ROUTES_FOUND','SWAP_IMPACT_TOO_HIGH'];if(allowed.includes(parsed?.errorCode))fail('RELAY_'+parsed.errorCode);fail('RELAY_PROVIDER_UNAVAILABLE');}return parsed;}
   finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  }).finally(()=>{actual--;});
  // Cancellation requests are included in work's final cancellation, retaining the permit.
  const cancel=()=>{if(reader)void reader.cancel().catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
  try{return await Promise.race([work,stopped]);}finally{signal.removeEventListener('abort',stop);signal.removeEventListener('abort',cancel);}
 }
 async function read(url,method,params,signal){
  if(!/^(eth_chainId|eth_getBlockByNumber|eth_getCode|eth_getStorageAt|eth_call|eth_estimateGas|eth_getBalance|eth_maxPriorityFeePerGas|eth_gasPrice|getGenesisHash|getLatestBlockhash|getBlockHeight|getBlockTime|getAccountInfo|getMultipleAccounts|getFeeForMessage|simulateTransaction|isBlockhashValid|getMinimumBalanceForRentExemption|getRecentPrioritizationFees)$/.test(method))fail('RELAY_PROVIDER_READ_UNSUPPORTED');
  const id=++serial,row=await json(url,{jsonrpc:'2.0',id,method,params},signal);
  if(row?.jsonrpc!=='2.0'||row.id!==id||Object.hasOwn(row,'error')||!Object.hasOwn(row,'result'))fail('RELAY_PROVIDER_READ_UNAVAILABLE');
  return row.result;
 }
 async function run(fn,parent=new AbortController().signal){
  if(!parent||typeof parent.addEventListener!=='function')fail('INVALID_EXECUTION_INPUT');if(parent.aborted)fail('EXECUTION_CANCELLED');if(operations>=4)fail('EXECUTION_BUSY');operations++;
  const controller=new AbortController(),cutoff=performance.now()+12000;let reject;
  const stopped=new Promise((_,r)=>reject=r),stop=code=>{controller.abort();reject(new ExecutionEngineError(code));};
  const cancel=()=>stop('EXECUTION_CANCELLED'),timer=setTimeout(()=>stop('EXECUTION_TIMEOUT'),12000);parent.addEventListener('abort',cancel,{once:true});
  const work=Promise.resolve().then(()=>fn(controller.signal)).then(value=>{if(controller.signal.aborted||performance.now()>=cutoff)fail('EXECUTION_TIMEOUT');return value;}).finally(()=>{operations--;});
  try{return await Promise.race([work,stopped]);}catch(error){if(error instanceof ExecutionEngineError)throw error;fail('RELAY_PROVIDER_EVIDENCE_INVALID');}
  finally{clearTimeout(timer);parent.removeEventListener('abort',cancel);}
 }
 return {json,read,run};
}
