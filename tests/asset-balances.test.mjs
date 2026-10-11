import test from 'node:test';
import assert from 'node:assert/strict';
import {initAssetBalances,formatBalance} from '../examples/browser/asset-balances.js';
const EVM='eip155:8453',SOL='solana:mainnet',OWNER='0x'+'a'.repeat(40),SOL_OWNER='47YyVUMwerrz76mCrpgFP3iDva1Vt4ZxpSuxo6AhwabT';
class Element extends EventTarget {value='';textContent='';dataset={};title='';}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(getBalance) {
  const fields=new Map(); const $=id=>{if(!fields.has(id))fields.set(id,new Element());return fields.get(id);};
  const document=Object.assign(new EventTarget(),{hidden:false,getElementById:$}),window=new EventTarget();
  const assets=[{id:'eth',chainId:EVM,address:'0x'+'0'.repeat(40),decimals:18,symbol:'ETH'}, {id:'usdc',chainId:EVM,address:'0x'+'b'.repeat(40),decimals:6,symbol:'USDC'}, {id:'sol',chainId:SOL,address:'11111111111111111111111111111111',decimals:9,symbol:'SOL'}];
  $('source').value='eth';$('destination').value='sol';$('sender').value=OWNER;$('recipient').value=SOL_OWNER;
  let clock=100000;const scheduled=new Map();let id=0;
  const timers={setTimeout(fn,delay){scheduled.set(++id,{fn,delay});return id;},clearTimeout(id){scheduled.delete(id);}};
  const calls=[];
  const client={getAssetBalance(input,options){calls.push({input,signal:options.signal});return getBalance(input,options);}};
  const ui=initAssetBalances({client,document,window,config:{assets,chains:[{chainId:EVM},{chainId:SOL}]},timers,now:()=>clock});
  return {$,ui,calls,document,window,scheduled,advance:()=>{clock+=16000;},change(id,value){$(id).value=value;$('quote-form').dispatchEvent(new Event('input'));}};
}
const result=(input,balanceRaw='1234567')=>({...input,balanceRaw,decimals:6,observedAtMs:Date.now()});
test('formats tiny and huge balances without precision loss or rounding up',()=>{
  assert.deepEqual(formatBalance('1',18),{compact:'<0.000001',exact:'0.000000000000000001'});
  assert.deepEqual(formatBalance('123456789012345678901234567891',18),{compact:'123456789012.345678…',exact:'123456789012.345678901234567891'});
  assert.deepEqual(formatBalance('0',6),{compact:'0',exact:'0'});
  assert.deepEqual(formatBalance('234',0),{compact:'234',exact:'234'});
});
test('loads selected source and destination wallets; amount changes reuse fresh observations',async()=>{
  const f=fixture(async input=>result(input));await tick();
  assert.equal(f.calls.length,2);assert.equal(f.calls[0].input.owner,OWNER);assert.equal(f.calls[1].input.owner,SOL_OWNER);
  assert.equal(f.$('source-balance').textContent,'Balance: 1.234567 ETH');
  f.change('amount','0.01');await tick();assert.equal(f.calls.length,2);
  f.advance();await f.ui.refresh();assert.equal(f.calls.length,4);f.ui.dispose();
});
test('late balance cannot overwrite a different selected asset or owner',async()=>{
  const pending=[];const f=fixture(input=>new Promise(resolve=>pending.push(()=>resolve(result(input)))));
  await tick();assert.equal(f.calls.length,1,'Balance reads leave capacity for quotes');
  f.change('source','usdc');assert.equal(f.calls[0].signal.aborted,true);assert.equal(f.$('source-balance').textContent,'Balance: checking…');
  pending[0]();await tick();assert.equal(f.$('source-balance').textContent,'Balance: checking…');
  pending[1]();await tick();
  pending[2]();await tick();assert.equal(f.$('source-balance').textContent,'Balance: 1.234567 USDC');
  f.change('sender','0x'+'c'.repeat(40));await tick();pending[3]();await tick();assert.match(f.$('source-balance').title,/0xcccc/);f.ui.dispose();
});
test('missing or wrong-family wallets show guidance and never query a meaningless balance',async()=>{
  const f=fixture(async input=>result(input));await tick();
  f.change('sender',SOL_OWNER);f.change('recipient',OWNER);await tick();assert.equal(f.calls.length,2);
  assert.match(f.$('source-balance').textContent,/Connect your wallet/);assert.match(f.$('destination-balance').textContent,/receiving address/);f.ui.dispose();
});
test('custom tokens query exact selected network and mint without trusting manual decimals',async()=>{
  const f=fixture(async input=>result(input));await tick();
  f.$('source-chain').value=EVM;f.$('source-address').value='0x'+'C'.repeat(40);f.$('source-decimals').value='18';f.change('source','custom');await tick();
  assert.deepEqual(f.calls[2].input,{chainId:EVM,address:'0x'+'c'.repeat(40),owner:OWNER});assert.equal(f.$('source-balance').textContent,'Balance: 1.234567');f.ui.dispose();
});
test('RPC failure and stalled requests become unavailable, never zero; force refresh is read-only',async()=>{
  let fail=false;const f=fixture(async input=>{if(fail)throw Error('RPC unavailable');return result(input,'0');});await tick();
  assert.equal(f.$('source-balance').textContent,'Balance: 0 ETH');fail=true;
  f.$('quote-form').dispatchEvent(new Event('swapend'));await tick();assert.match(f.$('source-balance').textContent,/unable to refresh/);assert.equal(f.$('source-balance').dataset.state,'unavailable');
  f.change('source','usdc');await tick();assert.match(f.$('source-balance').textContent,/Balance unavailable/);f.ui.dispose();
  const stalled=fixture(()=>new Promise(()=>{}));await tick();for(const {fn,delay} of [...stalled.scheduled.values()])if(delay===10000)fn();await tick();
  assert.equal(stalled.calls[0].signal.aborted,true);assert.match(stalled.$('source-balance').textContent,/Balance unavailable/);stalled.ui.dispose();
});
test('only visible idle periodic refreshes run; dispose removes listeners',async()=>{
  const f=fixture(async input=>result(input));await tick();f.advance();f.document.hidden=true;
  const scheduled=[...f.scheduled.values()].find(row=>row.delay===15000);scheduled.fn();await tick();assert.equal(f.calls.length,2);
  f.document.hidden=false;f.document.dispatchEvent(new Event('visibilitychange'));await tick();assert.equal(f.calls.length,4);
  f.ui.dispose();f.window.dispatchEvent(new Event('focus'));await tick();assert.equal(f.calls.length,4);
});
