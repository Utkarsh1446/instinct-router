import test from 'node:test';
import assert from 'node:assert/strict';
import { initWalletConnections } from '../examples/browser/wallet-connections.js';
import { normalizeWalletAddress, reviewMatchesInputs } from '../examples/browser/wallet-addresses.js';
import { createEvmWallet, createPhantomWallet } from '../packages/sdk/src/wallets.js';

const BASE = 'eip155:8453', SOL = 'solana:mainnet';
const EVM = '0xd627e435b88c1bf00244f7f3acd14b7f6db64b2e', OTHER = '0x706f21e8366e601645affda4d414787497ad2280';
const SOLANA = '47YyVUMwerrz76mCrpgFP3iDva1Vt4ZxpSuxo6AhwabT';
class Element {
  value = ''; options = []; hidden = false; disabled = false; textContent = ''; handlers = new Map();
  append(option) { this.options.push(option); if (this.options.length === 1) this.value = option.value; }
  replaceChildren() { this.options = []; this.value = ''; }
  addEventListener(name, callback) { const list = this.handlers.get(name) ?? []; list.push(callback); this.handlers.set(name, list); }
  dispatchEvent(event) { for (const callback of this.handlers.get(event.type) ?? []) callback(event); }
  emit(type, detail) { this.dispatchEvent({ type, detail }); }
  setCustomValidity(message) { this.validationMessage = message; }
  reportValidity() { return !this.validationMessage; }
  click() { assert.equal(this.disabled, false, 'Control should be enabled'); return this.onclick(); }
}
function ethereum(accounts = [EVM]) {
  const events = new Element(), calls = [];
  return { calls, accounts, chain: '0x2105', isMetaMask: true,
    on: (event, fn) => events.addEventListener(event, e => fn(e.detail)), emit: (event,value) => events.emit(event,value),
    async request({method}) {
      calls.push(method);
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return this.accounts;
      if (method === 'eth_chainId') return this.chain;
      throw Error('Unexpected signing or submission: ' + method);
    },
  };
}
function phantom() {
  const events = new Element();
  return { calls: [], publicKey: {toString: () => SOLANA}, isPhantom: true,
    on: (event, fn) => events.addEventListener(event, e => fn(e.detail)), emit: (event,value) => events.emit(event,value),
    async connect(options) { this.calls.push(options?.onlyIfTrusted?'resume':'connect'); return {publicKey:this.publicKey}; },
    async signMessage() { throw Error('Destination must never sign'); },
  };
}
function setup({ source = BASE, destination = SOL, evm = ethereum(), solana = phantom(), storage, initial={} } = {}) {
  const fields = new Map(), $ = id => { if (!fields.has(id)) fields.set(id, new Element()); return fields.get(id); };
  for(const [id,value] of Object.entries(initial))$(id).value=value;
  const host = new Element(); host.ethereum = evm; host.phantom = {solana};
  const chains = {source,destination}, sourceChanges = []; let inputChanges = 0;
  const manager = initWalletConnections({
    config: {chains:[{chainId:BASE,name:'Base'},{chainId:SOL,name:'Solana'},{chainId:'eip155:1',name:'Ethereum'}]},
    getChain: side => chains[side], makeEvmWallet:createEvmWallet, makeSolanaWallet:createPhantomWallet,
    onSourceChanged: (adapter,account) => sourceChanges.push({adapter,account}),
    onInputsChanged: () => inputChanges++, onUpdate: () => {},
    document: {getElementById:$,createElement:() => new Element()}, window:host, storage,
  });
  return { $, chains, evm, solana, host, manager, sourceChanges, changes:()=>inputChanges,
    connect: side => $(side + '-wallet-connect').click(),
    changeChain(side,chain) { chains[side] = chain; $(side).emit('change'); },
    enter(id,value) { $(id).value=value; $(id).emit('input'); },
  };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('Base sender and Phantom recipient are independent; neither connection signs', async () => {
  const f = setup(); await f.connect('source');
  assert.equal(f.$('sender').value,EVM); assert.equal(f.$('recipient').value,'');
  const sender = f.sourceChanges[0].adapter;
  await f.connect('destination');
  assert.equal(f.$('sender').value,EVM); assert.equal(f.$('recipient').value,SOLANA);
  assert.equal(f.sourceChanges.length,1); assert.equal((await sender.getAccount()).address,EVM);
  assert.equal(f.manager.sourceIsReady(),true); assert.equal(f.manager.addressesValid(),true);
  assert.deepEqual(f.solana.calls,['connect']); assert(f.evm.calls.every(method=>['eth_requestAccounts','eth_accounts','eth_chainId'].includes(method)));
});

test('switching destination to Solana clears copied EVM address and offers only Solana wallets', async () => {
  const f = setup({destination:BASE}); await f.connect('source');
  f.$('destination-use-source').click(); assert.equal(f.$('recipient').value,EVM);
  f.changeChain('destination',SOL);
  assert.equal(f.$('recipient').value,''); assert.equal(f.$('sender').value,EVM);
  assert.equal(f.$('destination-use-source').disabled,true);
  assert(f.$('destination-wallet-provider').options.every(row=>row.value.startsWith('solana:')));
  await f.connect('destination'); assert.equal(f.$('recipient').value,SOLANA);
});

test('Solana sender and EVM recipient work in reverse without switching EVM network', async () => {
  const f = setup({source:SOL,destination:BASE}); await f.connect('source'); await f.connect('destination');
  assert.equal(f.$('sender').value,SOLANA); assert.equal(f.$('recipient').value,EVM);
  assert.equal(f.sourceChanges.length,1); assert.equal(f.manager.sourceIsReady(),true);
  assert(!f.evm.calls.includes('wallet_switchEthereumChain'));
});

test('manual destination survives source reconnection and is validated for its chain', async () => {
  const f = setup(); f.enter('recipient',SOLANA); await f.connect('source'); await f.connect('source');
  assert.equal(f.$('recipient').value,SOLANA); f.manager.assertAddresses();
  f.enter('recipient',EVM); assert.equal(f.manager.addressesValid(),false);
  assert.throws(()=>f.manager.assertAddresses(),/recipient address for Solana/);
  assert.match(f.$('recipient').validationMessage,/Solana/);
});

test('different accounts from one EVM provider retain distinct source and destination adapters', async () => {
  const f = setup({destination:BASE,evm:ethereum([EVM,OTHER])});
  const first = f.connect('source'); await tick();
  f.$('source-wallet-account').value='0'; f.$('source-wallet-select-account').click(); await first;
  const source = f.sourceChanges[0].adapter;
  const second = f.connect('destination'); await tick();
  f.$('destination-wallet-account').value='1'; f.$('destination-wallet-select-account').click(); await second;
  assert.equal(f.$('sender').value,EVM); assert.equal(f.$('recipient').value,OTHER);
  assert.equal((await source.getAccount()).address,EVM); assert.equal(f.sourceChanges.length,1);
});

test('destination network selection preserves compatible EVM address without switching the sending wallet', async () => {
  const f = setup({destination:BASE}); await f.connect('source'); await f.connect('destination');
  f.changeChain('destination','eip155:1');
  assert.equal(f.$('recipient').value,EVM); assert.equal(f.manager.sourceIsReady(),true);
  assert(!f.evm.calls.includes('wallet_switchEthereumChain'));
});

test('source on the wrong network cannot verify or prepare even though its address is valid', async () => {
  const evm = ethereum(); evm.chain='0x1'; const f = setup({evm}); await f.connect('source');
  assert.equal(f.$('sender').value,EVM); assert.equal(f.manager.sourceIsReady(),false);
  assert.match(f.$('source-wallet-status').textContent,/Switch MetaMask to Base/);
});

test('account changes invalidate the source connection and leave manual destination untouched', async () => {
  const f = setup(); await f.connect('source'); f.enter('recipient',SOLANA); f.evm.emit('accountsChanged');
  assert.equal(f.$('sender').value,''); assert.equal(f.$('recipient').value,SOLANA);
  assert.equal(f.manager.sourceIsReady(),false); assert.equal(f.sourceChanges.at(-1).adapter,null);
});

test('destination disconnect clears its connected address without affecting the source', async () => {
  const f = setup(); await f.connect('source'); await f.connect('destination'); f.solana.emit('disconnect');
  assert.equal(f.$('recipient').value,''); assert.equal(f.$('sender').value,EVM); assert.equal(f.manager.sourceIsReady(),true);
});

test('chain change during connection cannot install an obsolete account', async () => {
  const f = setup(); let resolve;
  f.solana.connect = () => new Promise(done=>{resolve=done;});
  const pending = f.connect('destination'); f.changeChain('destination',BASE);
  resolve({publicKey:f.solana.publicKey}); await pending;
  assert.equal(f.$('recipient').value,''); assert.match(f.$('destination-wallet-status').textContent,/chain or wallet changed/);
});

test('chain change dismisses an outstanding account selector', async () => {
  const f = setup({evm:ethereum([EVM,OTHER])}); const pending = f.connect('source'); await tick();
  f.changeChain('source',SOL); await pending;
  assert.equal(f.$('source-wallet-account').hidden,true); assert.equal(f.$('sender').value,'');
  assert.equal(f.manager.sourceIsReady(),false);
});

test('failed reconnection leaves no stale connected account eligible to trade', async () => {
  const f = setup(); await f.connect('source');
  f.evm.request = async () => { throw Error('User rejected connection'); }; await f.connect('source');
  assert.equal(f.manager.sourceIsReady(),false); assert.equal(f.sourceChanges.at(-1).adapter,null);
});

test('manual entry works without extensions; late discovery preserves both addresses', () => {
  const f = setup({evm:null,solana:null}); f.enter('sender',EVM); f.enter('recipient',SOLANA);
  assert.equal(f.$('source-wallet-connect').disabled,true); f.manager.assertAddresses();
  f.host.emit('eip6963:announceProvider',{info:{uuid:'test',name:'Test wallet'},provider:ethereum()});
  assert.equal(f.$('source-wallet-connect').disabled,false);
  assert.equal(f.$('sender').value,EVM); assert.equal(f.$('recipient').value,SOLANA);
});

test('address checks reject wrong-chain, zero and invalid-length public keys', () => {
  assert.equal(normalizeWalletAddress(BASE,EVM.toUpperCase().replace('0X','0x')),EVM);
  assert.equal(normalizeWalletAddress(SOL,SOLANA),SOLANA);
  for (const [chain,address] of [[SOL,EVM],[BASE,SOLANA],[BASE,'0x'+'0'.repeat(40)],[SOL,'1'.repeat(32)],[SOL,'z'.repeat(44)],[SOL,'a'.repeat(32)]])
    assert.equal(normalizeWalletAddress(chain,address),null,address);
});

test('changed recipient, sender, assets, amount or limits block reuse of a saved review', () => {
  const source = {chainId:BASE,address:'0x'+'0'.repeat(40),decimals:18};
  const destination = {chainId:BASE,address:'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',decimals:6};
  const input = {source,destination,sender:EVM,recipient:OTHER,amount:'0.00005',slippageBps:50,maxFeeBps:500,objective:'BALANCED',nativeBudgetRaw:'20000000000000'};
  const record = {request:{source,destination,sender:EVM,recipient:OTHER,amountRaw:'50000000000000',slippageBps:50,maxFeeBps:500,
    optimization:{objective:'BALANCED'},nativeFeeBudgets:[{chainId:BASE,maxAmountRaw:input.nativeBudgetRaw}]}};
  assert.equal(reviewMatchesInputs(record,input),true);
  assert.equal(reviewMatchesInputs(record,{...input,recipient:OTHER.toUpperCase().replace('0X','0x')}),true);
  for (const mutation of [{recipient:EVM},{sender:OTHER},{destination:{...destination,chainId:SOL}},{amount:'0.00006'},
    {slippageBps:100},{maxFeeBps:1000},{objective:'FASTEST'},{nativeBudgetRaw:'30000000000000'},{amount:'invalid'}])
    assert.equal(reviewMatchesInputs(record,{...input,...mutation}),false,JSON.stringify(mutation));
});

test('an explicit source network switch reconnects the sender without requesting a transaction', async () => {
  const evm = ethereum(); evm.chain = '0x1';
  const original = evm.request.bind(evm);
  evm.request = async request => {
    if (request.method !== 'wallet_switchEthereumChain') return original(request);
    evm.calls.push(request.method);
    assert.deepEqual(request.params, [{chainId:'0x2105'}]);
    evm.chain = '0x2105'; evm.emit('chainChanged');
  };
  const f = setup({evm}); f.enter('recipient',SOLANA); await f.connect('source');
  assert.equal(f.manager.sourceIsReady(),false);
  await f.manager.switchSourceChain();
  assert.equal(f.manager.sourceIsReady(),true);
  assert.equal(f.$('recipient').value,SOLANA);
  assert.equal(evm.calls.filter(method=>method==='wallet_switchEthereumChain').length,1);
  assert.equal(evm.calls.includes('eth_sendTransaction'),false);
});

test('declining a source network switch keeps trade preparation blocked', async () => {
  const evm=ethereum(); evm.chain='0x1'; const original=evm.request.bind(evm);
  evm.request=async request=>{if(request.method==='wallet_switchEthereumChain') throw Error('Switch declined'); return original(request);};
  const f=setup({evm}); await f.connect('source'); await f.manager.switchSourceChain();
  assert.equal(f.manager.sourceIsReady(),false); assert.match(f.$('source-wallet-status').textContent,/Switch declined/);
});

test('choosing another source provider clears the old signing account before a swap', async () => {
  const f=setup(); await f.connect('source'); f.enter('recipient',SOLANA);
  f.host.emit('eip6963:announceProvider',{info:{uuid:'second',name:'Second wallet'},provider:ethereum([OTHER])});
  f.$('source-wallet-provider').value='evm:second'; f.$('source-wallet-provider').emit('change');
  assert.equal(f.manager.sourceIsReady(),false); assert.equal(f.sourceChanges.at(-1).adapter,null);
  assert.equal(f.$('sender').value,''); assert.equal(f.$('recipient').value,SOLANA);
  await f.manager.connectSource(); assert.equal(f.manager.sourceIsReady(),true); assert.equal(f.$('sender').value,OTHER);
});

const memoryStorage = () => {const data=new Map();return {data,getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)};};
const settled = async () => {for(let index=0;index<5;index++)await tick();};
test('reload restores both wallet roles using public preferences and existing permission only',async()=>{
 const storage=memoryStorage(),first=setup({storage});await first.connect('source');await first.connect('destination');
 const saved=JSON.parse(storage.getItem('instinct-router-wallets-v1'));
 assert.deepEqual(Object.keys(saved.source.evm).sort(),['address','chainId','providerKey']);
 const second=setup({storage});await settled();
 assert.equal(second.$('sender').value,EVM);assert.equal(second.$('recipient').value,SOLANA);assert(second.manager.sourceIsReady());
 assert(!second.evm.calls.includes('eth_requestAccounts'));assert.deepEqual(second.solana.calls,['resume']);
 assert.equal(second.sourceChanges.length,1);assert.equal((await second.sourceChanges[0].adapter.getAccount()).address,EVM);
});
test('same-account notifications and tab focus retain wallet selection without invalidating input consent',async()=>{
 const f=setup({source:SOL,destination:BASE});await f.connect('source');await f.connect('destination');const count=f.changes();
 f.solana.emit('accountChanged',f.solana.publicKey);f.evm.emit('accountsChanged',[EVM]);f.evm.emit('chainChanged','0x2105');
 assert.equal(f.changes(),count);assert.equal(f.sourceChanges.length,1);assert(f.manager.sourceIsReady());
 f.host.emit('focus');await settled();
 assert.equal(f.changes(),count);assert.equal(f.sourceChanges.length,1);assert(f.manager.sourceIsReady());
 assert.equal(f.solana.calls.filter(row=>row==='connect').length,1);
});
test('changing source EVM network retains the wallet and switches without a second access prompt',async()=>{
 const f=setup();await f.connect('source');f.changeChain('source','eip155:1');
 assert(f.manager.sourceState().connected);assert.equal(f.manager.sourceIsReady(),false);assert.equal(f.$('sender').value,EVM);
 const original=f.evm.request.bind(f.evm);f.evm.request=async request=>{if(request.method!=='wallet_switchEthereumChain')return original(request);f.evm.chain='0x1';f.evm.emit('chainChanged','0x1');};
 await f.manager.switchSourceChain();assert(f.manager.sourceIsReady());assert.equal(f.evm.calls.filter(row=>row==='eth_requestAccounts').length,1);
});
test('changing wallet network from the extension rebinds automatically and keeps receiver untouched',async()=>{
 const f=setup();await f.connect('source');f.enter('recipient',SOLANA);f.evm.chain='0x1';f.evm.emit('chainChanged','0x1');
 assert.equal(f.manager.sourceIsReady(),false);await settled();assert(f.manager.sourceState().connected);assert.equal(f.manager.sourceState().chainMatches,false);
 f.evm.chain='0x2105';f.evm.emit('chainChanged','0x2105');await settled();assert(f.manager.sourceIsReady());assert.equal(f.$('recipient').value,SOLANA);
 assert.equal(f.evm.calls.filter(row=>row==='eth_requestAccounts').length,1);
});
test('reversing chain families restores the previously connected compatible wallets',async()=>{
 const f=setup();await f.connect('source');await f.connect('destination');f.changeChain('source',SOL);f.changeChain('destination',BASE);await settled();
 assert.equal(f.$('sender').value,SOLANA);assert.equal(f.$('recipient').value,EVM);assert(f.manager.sourceIsReady());
 assert.equal(f.evm.calls.filter(row=>row==='eth_requestAccounts').length,1);assert.equal(f.solana.calls.filter(row=>row==='connect').length,1);
});
test('a real authorized account switch invalidates the previous signer before restoring the new account',async()=>{
 const f=setup();await f.connect('source');f.evm.accounts=[OTHER];f.evm.emit('accountsChanged',[OTHER]);
 assert.equal(f.manager.sourceIsReady(),false);assert.equal(f.sourceChanges.at(-1).adapter,null);await settled();
 assert.equal(f.$('sender').value,OTHER);assert(f.manager.sourceIsReady());assert.equal(f.sourceChanges.at(-1).account.address,OTHER);
 assert.equal(f.evm.calls.filter(row=>row==='eth_requestAccounts').length,1);
});
test('locked or revoked account permission cannot become a connected signer from saved storage',async()=>{
 const storage=memoryStorage(),first=setup({storage});await first.connect('source');
 const evm=ethereum([]),second=setup({storage,evm});await settled();assert.equal(second.manager.sourceIsReady(),false);assert.equal(second.sourceChanges.length,0);
 evm.accounts=[EVM];second.host.emit('focus');await settled();assert(second.manager.sourceIsReady());assert(!evm.calls.includes('eth_requestAccounts'));
});
test('explicit Phantom disconnect is respected on focus and reload even with both role preferences',async()=>{
 const storage=memoryStorage(),f=setup({storage,source:SOL,destination:SOL});await f.connect('source');await f.connect('destination');
 f.solana.emit('disconnect');await settled();f.host.emit('focus');await settled();
 assert.equal(f.manager.sourceIsReady(),false);assert.equal(f.$('recipient').value,'');assert.equal(f.solana.calls.filter(row=>row==='resume').length,0);
 const second=setup({storage,source:SOL,destination:SOL});await settled();assert.equal(second.manager.sourceIsReady(),false);assert.equal(second.solana.calls.length,0);
});
test('late provider discovery restores by stable identity, not the announcement UUID or option order',async()=>{
 const storage=memoryStorage(),evm=ethereum(),first=setup({storage,evm:null});
 first.host.emit('eip6963:announceProvider',{info:{uuid:'first-runtime',rdns:'io.metamask',name:'MetaMask'},provider:evm});await first.connect('source');
 const second=setup({storage,evm:null});await settled();assert.equal(second.manager.sourceIsReady(),false);
 const other=ethereum([OTHER]);second.host.emit('eip6963:announceProvider',{info:{uuid:'wrong',rdns:'io.other',name:'Other'},provider:other});
 const chosen=ethereum();second.host.emit('eip6963:announceProvider',{info:{uuid:'new-runtime',rdns:'io.metamask',name:'MetaMask'},provider:chosen});await settled();
 assert.equal(second.$('sender').value,EVM);assert(second.manager.sourceIsReady());assert.equal(other.calls.length,0);assert(!chosen.calls.includes('eth_requestAccounts'));
});
test('manual receiver input during an in-flight restore wins over the stored wallet address',async()=>{
 const storage=memoryStorage(),first=setup({storage,destination:BASE});await first.connect('destination');
 const evm=ethereum(),request=evm.request.bind(evm);let release;
 evm.request=async input=>input.method==='eth_accounts'?new Promise(resolve=>{release=resolve;}):request(input);
 const second=setup({storage,destination:BASE,source:SOL,evm});await tick();second.enter('recipient',OTHER);release([EVM]);await settled();
 assert.equal(second.$('recipient').value,OTHER);assert.equal(second.sourceChanges.length,0);
});
test('changing the provider during restore cannot install the old signer',async()=>{
 const storage=memoryStorage(),first=setup({storage});await first.connect('source');
 const evm=ethereum(),request=evm.request.bind(evm);let release;
 evm.request=async input=>input.method==='eth_accounts'?new Promise(resolve=>{release=resolve;}):request(input);
 const second=setup({storage,evm});await tick();second.host.emit('eip6963:announceProvider',{info:{uuid:'second',rdns:'io.other',name:'Other'},provider:ethereum([OTHER])});
 second.$('source-wallet-provider').value='evm:second';second.$('source-wallet-provider').emit('change');release([EVM]);await settled();
 assert.equal(second.$('sender').value,'');assert.equal(second.manager.sourceIsReady(),false);second.host.emit('focus');await settled();assert.equal(second.manager.sourceIsReady(),false);
});
test('focus revalidation does not run while a wallet trade action is active',async()=>{
 const f=setup();await f.connect('source');const before=f.evm.calls.length;f.manager.setBusy(true);f.host.emit('focus');await settled();assert.equal(f.evm.calls.length,before);
 f.manager.setBusy(false);await settled();assert(f.manager.sourceIsReady());assert.equal(f.sourceChanges.length,1);assert.equal(f.evm.calls.filter(row=>row==='eth_requestAccounts').length,1);
});
test('unavailable local storage still allows normal wallet connection',async()=>{
 const storage={getItem(){throw Error('Blocked storage');},setItem(){throw Error('Blocked storage');}};
 const f=setup({storage});await f.connect('source');assert(f.manager.sourceIsReady());f.host.emit('focus');await settled();assert(f.manager.sourceIsReady());
});
