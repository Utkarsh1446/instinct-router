import test from 'node:test';
import assert from 'node:assert/strict';
import { pollSettlement } from '../../../examples/browser/settlement-poller.js';
function clock() { let time=0;const waits=[];return {now:()=>time,sleep:async ms=>{waits.push(ms);time+=ms;},advance:ms=>{time+=ms;},waits}; }
test('settlement checks are sequential, stop at confirmed credit, and cannot invoke wallets',async()=>{
  const c=clock(),seen=[];let inFlight=0,calls=0;
  const result=await pollSettlement({...c,resume:async()=>{assert.equal(inFlight++,0);calls++;c.advance(500);inFlight--;return {status:calls===3?'COMPLETE':'SUBMITTED'};},onUpdate:value=>seen.push(value.status)});
  assert.equal(result.reason,'COMPLETE');assert.deepEqual(seen,['SUBMITTED','SUBMITTED','COMPLETE']);assert.deepEqual(c.waits,[500,500]);
});
test('only temporary busy/rate errors back off with bounded consecutive attempts',async()=>{
  const c=clock(),statuses=[];let calls=0;
  const result=await pollSettlement({...c,resume:async()=>{calls++;throw Object.assign(Error(),{code:'ROUTER_BUSY',retryAfterMs:200000});},onStatus:value=>statuses.push(value)});
  assert.equal(result.reason,'ERROR');assert.equal(calls,4);assert.deepEqual(c.waits,[10000,10000,10000]);assert.equal(statuses.filter(row=>row==='BACKOFF').length,3);
  const auth=await pollSettlement({...clock(),resume:async()=>{throw {code:'WALLET_AUTH_REQUIRED'};}});assert.equal(auth.reason,'ERROR');
});
test('stop, timeout and recovery preserve the saved execution without new actions',async()=>{
  for(const status of ['RECOVERY_REQUIRED','READY','CLAIMED','FAILED']) {
    let calls=0;const result=await pollSettlement({...clock(),resume:async()=>{calls++;return {status};}});
    assert.equal(result.reason,status==='FAILED'?'FAILED':'USER_ACTION_REQUIRED');assert.equal(calls,1);
  }
  const c=clock(),abort=new AbortController();let calls=0;
  const stopped=await pollSettlement({...c,signal:abort.signal,resume:async()=>{calls++;abort.abort();return {status:'SUBMITTED'};}});
  assert.equal(stopped.reason,'STOPPED');assert.equal(calls,1);
  const timeoutClock=clock();let timedCalls=0;
  const timeout=await pollSettlement({...timeoutClock,durationMs:5000,resume:async()=>{timedCalls++;return {status:'SUBMITTED'};}});
  assert.equal(timeout.reason,'TIMEOUT');assert.equal(timedCalls,5);assert.equal(timeoutClock.now(),5000);
});
test('delayed reads never overlap; stopped reads stay hidden and late terminal replies are rendered',async()=>{
  const c=clock(),abort=new AbortController();let updates=0,calls=0,release;
  const pending=pollSettlement({...c,signal:abort.signal,resume:()=>{calls++;return new Promise(resolve=>{release=resolve;});},onUpdate:()=>updates++});
  await Promise.resolve();await Promise.resolve();abort.abort();release({status:'COMPLETE'});
  assert.equal((await pending).reason,'STOPPED');assert.equal(calls,1);assert.equal(updates,0);
  const late=clock();const result=await pollSettlement({...late,durationMs:5000,resume:async()=>{late.advance(5000);return {status:'COMPLETE'};},onUpdate:()=>updates++});
  assert.equal(result.reason,'COMPLETE');assert.equal(updates,1);
});

test('confirmed cross-chain source keeps polling until independent destination delivery is complete',async()=>{
  const c=clock(),updates=[];let checks=0;
  const outcome=await pollSettlement({...c,resume:async()=>++checks===1
    ? {status:'SUBMITTED',receipt:{chainId:'eip155:8453'},destinationReceipt:undefined}
    : {status:'COMPLETE',receipt:{chainId:'eip155:8453'},destinationReceipt:{chainId:'solana:mainnet',commitment:'finalized'}},
    onUpdate:record=>updates.push(record)});
  assert.equal(outcome.reason,'COMPLETE');assert.equal(checks,2);
  assert.equal(updates[0].status,'SUBMITTED');assert.equal(updates[1].destinationReceipt.commitment,'finalized');
});

test('poll starts immediately and subtracts request time with minimum recovery rest',async()=>{
  const c=clock(),starts=[];let calls=0;
  await pollSettlement({...c,resume:async()=>{starts.push(c.now());c.advance(++calls===1?200:1300);return {status:calls===3?'COMPLETE':'SUBMITTED'};}});
  assert.deepEqual(starts,[0,1000,2550]);assert.deepEqual(c.waits,[800,250]);
});

test('recovery polling continues only with fresh bound progress supplied by the controller',async()=>{
  let calls=0;const result=await pollSettlement({...clock(),hasProgress:()=>true,resume:async()=>({status:++calls===1?'RECOVERY_REQUIRED':'COMPLETE'})});assert.equal(result.reason,'COMPLETE');assert.equal(calls,2);
  const blocked=await pollSettlement({...clock(),hasProgress:()=>false,resume:async()=>({status:'RECOVERY_REQUIRED'})});assert.equal(blocked.reason,'USER_ACTION_REQUIRED');
});
