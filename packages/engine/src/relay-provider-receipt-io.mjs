/** Bounded read-only I/O. An abort race never returns an actual fetch/body lease. */
import {ExecutionEngineError,fail} from './base-execution-checks.mjs';
import {baseExecutionPrimitives as p} from './base-readiness.mjs';
export function createReceiptIo(wire,apiKey){
 let actual=0,serial=0;
 const cancel=signal=>new ExecutionEngineError(signal.reason?.name==='TimeoutError'?'EXECUTION_TIMEOUT':'EXECUTION_CANCELLED');
 async function json(url,init,signal){if(signal.aborted)throw cancel(signal);if(actual>=8)fail('EXECUTION_BUSY');actual++;
  let stop,reader;const cancelled=new Promise((_,reject)=>{stop=()=>{void reader?.cancel().catch(()=>{});reject(cancel(signal));};signal.addEventListener('abort',stop,{once:true});});
  const work=Promise.resolve().then(async()=>{if(signal.aborted)throw cancel(signal);const response=await wire(url,{...init,signal,redirect:'error',credentials:'omit'});
   if(signal.aborted){await response.body?.cancel().catch(()=>{});throw cancel(signal);}const length=response.headers.get('content-length');
   if(!response.ok||response.redirected||response.url&&response.url!==url||length!==null&&(!/^\d+$/.test(length)||Number(length)>2097152)){await response.body?.cancel().catch(()=>{});fail('EXECUTION_EVIDENCE_UNAVAILABLE');}
   reader=response.body?.getReader();if(!reader)fail('EXECUTION_EVIDENCE_INVALID');const chunks=[];let size=0;try{for(;;){const part=await reader.read();if(signal.aborted)throw cancel(signal);if(part.done)break;size+=part.value.length;if(size>2097152||chunks.length>=4096)fail('EXECUTION_EVIDENCE_INVALID');chunks.push(part.value);}return p.strictJson(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  }).finally(()=>actual--);
  try{return await Promise.race([work,cancelled]);}finally{signal.removeEventListener('abort',stop);}
 }
 async function rpc(chain,method,params,signal){const id=++serial,result=await json(chain.rpcUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id,method,params})},signal);
  if(result?.jsonrpc!=='2.0'||result.id!==id||Object.keys(result).some(k=>!['jsonrpc','id','result','error'].includes(k))||Object.hasOwn(result,'result')===Object.hasOwn(result,'error'))fail('EXECUTION_EVIDENCE_INVALID');
  if(result.error){if(method==='debug_traceTransaction'&&result.error.code===-32601)fail('EXECUTION_TRACE_UNSUPPORTED');fail('EXECUTION_EVIDENCE_UNAVAILABLE');}return result.result;
 }
 const status=(requestId,signal)=>json('https://api.relay.link/intents/status/v3?requestId='+requestId,{method:'GET',headers:{...(apiKey?{'x-api-key':apiKey}:{})}},signal);
 async function settled(operations){const rows=await Promise.allSettled(operations),bad=rows.find(r=>r.status==='rejected');if(bad)throw bad.reason;return rows.map(r=>r.value);}
 return{rpc,status,settled};
}
