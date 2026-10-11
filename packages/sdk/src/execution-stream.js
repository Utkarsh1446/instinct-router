import { RouterSdkError } from './errors.js';
import { parseJson } from './json.js';
import { validateRecord, validateProgress } from './execution-validation.js';
const fail=()=>{throw new RouterSdkError('PROTOCOL_ERROR','The router returned an invalid execution stream.');};
const identity=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const cancel=value=>{try{Promise.resolve(value?.cancel?.()).catch(()=>{});}catch{}};
/** Status observations only. Never claims, signs or submits a transaction. */
export async function readExecutionStream(response,signal,checkDeadline,executionId,onUpdate,remoteError) {
  const check=()=>{checkDeadline();if(signal.aborted)throw new RouterSdkError('ABORTED','The status stream was stopped.');};
  const declared=response.headers?.get('content-length');
  if(declared!=null&&(!/^\d+$/.test(declared)||Number(declared)>8388608)){cancel(response.body);fail();}
  if(!/^application\/x-ndjson(?:\s*;|$)/i.test(response.headers?.get('content-type')||'')||typeof response.body?.getReader!=='function'){cancel(response.body);fail();}
  const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}),encoder=new TextEncoder();
  let sequence=0,bytes=0,chunks=0,buffer='',start,last,terminal,lastSent=0,finished=false;
  const stop=()=>cancel(reader);signal.addEventListener('abort',stop,{once:true});
  async function event(line,receivedAtMonoMs,receivedAtMs) {
    check();if(terminal||sequence>=1024)fail();
    const frame=parseJson(line),common=['apiVersion','requestId','appId','executionId','sequence','sentAtMs','type'];
    const extra=frame?.type==='UPDATE'?['execution','receiptStatus','progress']:frame?.type==='END'?['reason']:frame?.type==='ERROR'?['error']:[];
    const required=common.concat(extra.filter(key=>key!=='progress'));
    if(!frame||typeof frame!=='object'||Array.isArray(frame)||frame.apiVersion!=='1'||!identity(frame.requestId)||!identity(frame.appId)||
      frame.executionId!==executionId||frame.sequence!==sequence||!Number.isSafeInteger(frame.sentAtMs)||frame.sentAtMs<lastSent||frame.sentAtMs>Date.now()+2000||
      !['START','UPDATE','END','ERROR'].includes(frame.type)||Object.keys(frame).some(key=>!common.concat(extra).includes(key))||required.some(key=>!Object.hasOwn(frame,key)))fail();
    if(frame.type==='START'){if(sequence!==0)fail();start=frame;}
    else {
      if(!start||frame.requestId!==start.requestId||frame.appId!==start.appId)fail();
      if(frame.type==='UPDATE'){
        validateRecord(frame.execution,last);
        if(frame.execution.id!==executionId||!['PENDING','FAILED','CONFIRMED','RECOVERY_REQUIRED'].includes(frame.receiptStatus))fail();
        validateProgress(frame.progress,frame.execution);
        if(frame.progress&&frame.progress.observedAtMs>frame.sentAtMs)fail();
        last=structuredClone(frame.execution);
        const timing=Object.freeze({receivedAtMonoMs,receivedAtMs,sentAtMs:frame.sentAtMs,
          ...(frame.progress?{observedToSentMs:frame.sentAtMs-frame.progress.observedAtMs}:{}),serverToReceiptMs:receivedAtMs-frame.sentAtMs});
        if(onUpdate){
          let abort;const stopped=new Promise((_,reject)=>{abort=()=>reject(new RouterSdkError('ABORTED','The status stream was stopped.'));signal.addEventListener('abort',abort,{once:true});});
          try{await Promise.race([Promise.resolve().then(()=>onUpdate(structuredClone({execution:frame.execution,receiptStatus:frame.receiptStatus,...(frame.progress?{progress:frame.progress}:{})}),timing)),stopped]);}
          catch(error){if(error instanceof RouterSdkError)throw error;throw new RouterSdkError('CALLBACK_ERROR','The execution update callback failed.');}
          finally{signal.removeEventListener('abort',abort);}
          check();
        }
      } else if(frame.type==='END'){
        if(!last||!['TIMEOUT','SETTLED','STATE_CHANGED'].includes(frame.reason)||frame.reason==='SETTLED'&&!['COMPLETE','FAILED'].includes(last.status)||
          frame.reason==='STATE_CHANGED'&&['SUBMITTED','RECOVERY_REQUIRED'].includes(last.status)||frame.reason==='TIMEOUT'&&!['SUBMITTED','RECOVERY_REQUIRED'].includes(last.status))fail();
        terminal={reason:frame.reason,execution:last};
      } else {
        const error=frame.error;
        if(!error||typeof error!=='object'||Object.keys(error).some(key=>!['code','message','retryable','retryAfterMs'].includes(key))||
          !/^[A-Z][A-Z0-9_]{0,95}$/.test(error.code)||typeof error.message!=='string'||error.message.length>4096||typeof error.retryable!=='boolean'||
          error.retryAfterMs!==undefined&&(!Number.isFinite(error.retryAfterMs)||error.retryAfterMs<0))fail();
        terminal={error,requestId:frame.requestId};
      }
    }
    lastSent=frame.sentAtMs;sequence++;
  }
  try {
    while(true){check();let chunk;try{chunk=await reader.read();}catch{throw new RouterSdkError('NETWORK_ERROR','The status connection was interrupted.',{retryable:true});}check();
      const receivedAtMonoMs=performance.now(),receivedAtMs=Date.now();if(chunk.done)break;
      if(++chunks>32768||!(chunk.value instanceof Uint8Array))fail();bytes+=chunk.value.byteLength;
      if(bytes>8388608)throw new RouterSdkError('RESPONSE_TOO_LARGE','The execution stream exceeds 8 MiB.');
      buffer+=decoder.decode(chunk.value,{stream:true});let newline;
      while((newline=buffer.indexOf('\n'))!==-1){const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);if(encoder.encode(line).byteLength+1>262144)fail();await event(line.endsWith('\r')?line.slice(0,-1):line,receivedAtMonoMs,receivedAtMs);}
      if(encoder.encode(buffer).byteLength>262144)fail();if(chunks%128===0)await new Promise(resolve=>setTimeout(resolve,0));
    }
    buffer+=decoder.decode();check();if(buffer.length)fail();
    if(!terminal)throw new RouterSdkError('NETWORK_ERROR','The status stream ended before its final frame.',{retryable:true});
    finished=true;if(terminal.error)throw remoteError(terminal.error,terminal.requestId,response.status);return terminal;
  }catch(error){if(error instanceof RouterSdkError)throw error;fail();}
  finally{signal.removeEventListener('abort',stop);if(!finished)stop();try{reader.releaseLock();}catch{}}
}
