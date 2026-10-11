import test from 'node:test';
import assert from 'node:assert/strict';
import {createReceiptIo} from '../src/relay-provider-receipt-io.mjs';
const chain={rpcUrl:'https://rpc.example/'};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
for(const phase of ['fetch','body'])test(`ignored abort during ${phase} retains actual leases until underlying work settles`,async()=>{
 let calls=0,blocked=true;const finish=[];
 const wire=async(_url,init)=>{calls++;const q=JSON.parse(init.body);if(!blocked)return new Response(JSON.stringify({jsonrpc:'2.0',id:q.id,result:'ok'}));
  if(phase==='fetch')return new Promise(resolve=>finish.push(()=>resolve(new Response('{}'))));
  return{ok:true,redirected:false,url:chain.rpcUrl,headers:new Headers(),body:{getReader:()=>({read:()=>new Promise(resolve=>finish.push(()=>resolve({done:true}))),cancel:async()=>{},releaseLock:()=>{}})}};
 };
 const io=createReceiptIo(wire);
 for(let i=0;i<8;i++){const controller=new AbortController(),pending=io.rpc(chain,'eth_chainId',[],controller.signal);await tick();controller.abort();await assert.rejects(pending,e=>e.code==='EXECUTION_CANCELLED');}
 assert.equal(calls,8);for(let i=0;i<5;i++)await assert.rejects(io.rpc(chain,'eth_chainId',[],new AbortController().signal),e=>e.code==='EXECUTION_BUSY');assert.equal(calls,8);
 blocked=false;finish.forEach(resolve=>resolve());await tick();await tick();assert.equal(await io.rpc(chain,'eth_chainId',[],new AbortController().signal),'ok');assert.equal(calls,9);
});
test('sibling reads settle before a semantic failure is returned',async()=>{const io=createReceiptIo(async()=>{});let finish;const sibling=new Promise(resolve=>finish=resolve);let returned=false;const p=io.settled([Promise.reject(Object.assign(new Error('wrong chain'),{code:'EXECUTION_CHAIN_MISMATCH'})),sibling]).catch(e=>{returned=true;return e;});await tick();assert.equal(returned,false);finish('done');assert.equal((await p).code,'EXECUTION_CHAIN_MISMATCH');});
