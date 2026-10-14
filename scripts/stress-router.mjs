/** Bounded offline HTTP stress. All upstream traffic uses deterministic local fixtures. */
import { pathToFileURL } from 'node:url';
import { createQuoteService, ServiceError } from '@instinct/router-engine';
import { createRouterApi } from '@instinct/router-server';
import { createRouterClient } from '@instinct/router-sdk';
import { fixtureWire, input } from '../tests/fixtures/provider.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
export function percentiles(values) {
 const sorted = [...values].sort((a,b)=>a-b);
 const at = p => sorted.length ? Math.round(sorted[Math.max(0,Math.ceil(sorted.length*p)-1)]*100)/100 : null;
 return { p50Ms:at(.5),p95Ms:at(.95),maxMs:at(1) };
}
async function pool(count, concurrency, operation) {
 let next=0;
 const outcomes=await Promise.allSettled(Array.from({length:Math.min(count,concurrency)},async()=>{for(;;){const index=next++;if(index>=count)return;await operation(index);}}));
 const failed=outcomes.find(row=>row.status==='rejected');if(failed)throw failed.reason;
}
export async function runOfflineStress({concurrency=16}={}) {
 if(!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>16)throw Error('Concurrency must be 1..16.');
 let activeProvider=0,peakProvider=0,activeService=0,peakService=0,cancelledService=0,closed=false;
 const upstream=fixtureWire();
 const wire=async(url,init)=>{
  activeProvider++;peakProvider=Math.max(peakProvider,activeProvider);
  try {await wait(2);if(url==='https://api.relay.link/quote/v2'&&JSON.parse(init.body).amount==='2000000')throw Error('injected fixture failure');return await upstream(url,init);}
  finally {activeProvider--;}
 };
 const engine=createQuoteService({fetch:wire});
 const service={config:()=>engine.config(),resolveAsset:(...args)=>engine.resolveAsset(...args),async quote(request,signal,callback){
  activeService++;peakService=Math.max(peakService,activeService);
  try {
   if(request.amount==='3')return await new Promise((_,reject)=>{
    const cancel=()=>{cancelledService++;reject(new ServiceError('QUOTE_CANCELLED','Fixture canceled.',499));};
    if(signal.aborted)cancel();else signal.addEventListener('abort',cancel,{once:true});
   });
   return await engine.quote(request,signal,callback);
  } finally {activeService--;}
 }};
 const app={id:'stress',publishableKey:'pk_offline_stress_example',serverKey:'sk_offline_stress_example',allowedOrigins:['https://stress.example'],maxConcurrent:16,rateLimitPerMinute:1000};
 const api=createRouterApi({service,apps:[app],maxConcurrent:16,globalRateLimitPerMinute:1000,quoteTimeoutMs:3000});
 const sockets=new Set();api.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
 await new Promise((resolve,reject)=>{api.once('error',reject);api.listen(0,'127.0.0.1',resolve);});
 const baseUrl=`http://127.0.0.1:${api.address().port}`,headers={'Origin':app.allowedOrigins[0],'X-Router-App-Key':app.publishableKey,'Content-Type':'application/json'};
 const client=createRouterClient({baseUrl,publishableKey:app.publishableKey,fetch:(url,init)=>fetch(url,{...init,headers:{...init.headers,Origin:app.allowedOrigins[0]}})});
 const phases={},latencies=[],errors={};let requests=0;
 const record=async(phase,fn)=>{const start=performance.now();requests++;try{const value=await fn();phases[phase]=(phases[phase]??0)+1;return value;}catch(error){errors[error.code??error.name]=(errors[error.code??error.name]??0)+1;throw error;}finally{latencies.push(performance.now()-start);}};
 try {
  await pool(144,concurrency,()=>record('healthy',async()=>{const quote=await client.quote(input);if(!quote.winner)throw Error('Healthy fixture lost its winner.');}));
  const bad=[{...input,amount:'-1'},{...input,extra:'injected'},{...input,amount:'0.0000001'},{...input,sender:'invalid'}];
  await pool(24,concurrency,i=>record('malformedRejected',async()=>{const response=await fetch(baseUrl+'/v1/quotes',{method:'POST',headers,body:JSON.stringify(bad[i%bad.length])});const result=await response.json();if(response.status!==400||!result.error?.code)throw Error('Malformed request escaped validation.');errors[result.error.code]=(errors[result.error.code]??0)+1;}));
  await pool(8,concurrency,()=>record('streamCancelled',async()=>{
   const controller=new AbortController();const response=await fetch(baseUrl+'/v1/quotes/stream',{method:'POST',headers,body:JSON.stringify({...input,amount:'3'}),signal:controller.signal});
   if(response.status!==200)throw Error('Stream admission failed.');const reader=response.body.getReader();try{const first=await reader.read();if(first.done)throw Error('Missing stream start.');controller.abort();await reader.cancel().catch(()=>{});}finally{reader.releaseLock();}
  }));
  for(let attempt=0;activeService&&attempt<100;attempt++)await wait(5);
  if(activeService||cancelledService!==8)throw Error('Canceled streams retained service work.');
  await pool(8,concurrency,()=>record('recovery',async()=>{if(!(await client.quote(input)).winner)throw Error('Recovery quote failed.');}));
  await pool(16,concurrency,()=>record('providerFailureContained',async()=>{const quote=await client.quote({...input,amount:'2'});if(quote.winner)throw Error('Failed provider fabricated a winner.');for(const error of quote.failures??[])errors[error.code]=(errors[error.code]??0)+1;}));
 } finally {
  api.closeAllConnections();await new Promise(resolve=>api.close(resolve));closed=true;
  for(let attempt=0;sockets.size&&attempt<100;attempt++)await wait(5);
 }
 return {mode:'OFFLINE_FIXTURE_HTTP',requests,concurrency,phases,errors,latency:percentiles(latencies),peakProvider,peakService,cancelledService,resources:{activeProvider,activeService,openSockets:sockets.size,serverClosed:closed}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{console.log(JSON.stringify(await runOfflineStress(),null,2));}catch(error){console.error(error);process.exitCode=1;}
}
