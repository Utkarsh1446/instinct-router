import { normalizeWalletAddress, walletFamily } from './wallet-addresses.js';

const SESSION_KEY = 'instinct-router-wallets-v1';
const sameAccount = (a,b) => a?.chainId === b?.chainId && a?.address === b?.address;
/** Independent wallet roles. Saved public preferences never prove wallet control. */
export function initWalletConnections({ config, getChain, makeEvmWallet, makeSolanaWallet, onSourceChanged,
  onInputsChanged, onUpdate, document: dom = globalThis.document, window: host = globalThis.window, storage }) {
  const $ = id => dom.getElementById(id), sides = ['source', 'destination'];
  const providers = new Map(), connections = { source: null, destination: null }, adapters = { source: new Map(), destination: new Map() };
  const chainIds = { source: getChain('source'), destination: getChain('destination') };
  const versions = {source:0,destination:0}, pending = {source:null,destination:null}, restoreNeeded = new Set();
  let busy = false, externalBusy = false, selection, queued = false;
  try { storage ??= host.localStorage; } catch { /* Private browsing may deny storage. */ }
  let preferences = {source:{},destination:{}};
  try {
    const saved = JSON.parse(storage?.getItem(SESSION_KEY) ?? 'null');
    if (saved?.version === 1) for (const side of sides) for (const family of ['evm','solana']) {
      const row = saved[side]?.[family];
      if(row===null){preferences[side][family]=null;continue;}
      if (typeof row?.providerKey === 'string' && row.providerKey.length <= 200 && walletFamily(row.chainId) === family && normalizeWalletAddress(row.chainId,row.address))
        preferences[side][family] = {providerKey:row.providerKey,chainId:row.chainId,address:normalizeWalletAddress(row.chainId,row.address)};
    }
  } catch { /* Corrupt preferences cannot establish a wallet session. */ }
  const save = () => { try { storage?.setItem(SESSION_KEY,JSON.stringify({version:1,...preferences})); } catch { /* Keep working in memory. */ } };
  const input = side => $(side === 'source' ? 'sender' : 'recipient');
  const status = (side, text) => { $(side + '-wallet-status').textContent = text; };
  const name = chain => config.chains.find(row => row.chainId === chain)?.name ?? chain;
  const valid = side => normalizeWalletAddress(getChain(side), input(side).value);
  function changed() { onInputsChanged(); onUpdate(); }
  function validate(side) {
    const field = input(side), family = walletFamily(getChain(side));
    field.placeholder = family === 'solana' ? 'Solana address' : 'Wallet address (0x…)';
    field.setCustomValidity(field.value.trim() && !valid(side) ? `Enter a valid ${family === 'solana' ? 'Solana' : 'EVM'} ${side === 'source' ? 'sender' : 'recipient'} address for ${name(getChain(side))}.` : '');
  }
  function invalidatePending(side) { versions[side]++; pending[side]=null; }
  function clearConnection(side, reason='', preserveAddress=false) {
    invalidatePending(side);
    const prior = connections[side];
    if (prior) {
      connections[side] = null; prior.adapter.disconnect();
      if (!preserveAddress && normalizeWalletAddress(prior.account.chainId,input(side).value) === prior.account.address) input(side).value='';
      if (side === 'source') onSourceChanged(null,null);
    }
    status(side,reason); validate(side);
  }
  function remember(side,row) {
    const entry=providers.get(row.id);
    if (!entry?.key) return;
    preferences[side][entry.family]={providerKey:entry.key,...row.account}; save();
  }
  function describe(side,row) {
    const chain=getChain(side),entry=providers.get(row.id),address=row.account.address;
    const short=address.slice(0,6)+'…'+address.slice(-4);
    status(side, side==='source' && row.account.chainId!==chain ? `Switch ${entry.name} to ${name(chain)}.` : `${short} · ${name(chain)}`);
  }
  function install(side,id,adapter,account) {
    const prior=connections[side],row={id,adapter,account};
    connections[side]=row; input(side).value=account.address; $(side+'-wallet-provider').value=id;
    remember(side,row); describe(side,row);
    if (side==='source' && (prior?.adapter!==adapter || !sameAccount(prior?.account,account))) onSourceChanged(adapter,account);
    if (!prior || !sameAccount(prior.account,account) || prior.id!==id) changed();
  }
  function adapterFor(side,id,chain) {
    const entry=providers.get(id),key=id+(entry.family==='solana'?':'+chain:'');
    if (!adapters[side].has(key)) adapters[side].set(key,entry.family==='solana'?makeSolanaWallet(entry.provider,chain):makeEvmWallet(entry.provider));
    return adapters[side].get(key);
  }
  function populate(side) {
    const box=$(side+'-wallet-provider'),previous=box.value; box.replaceChildren();
    for (const [id,entry] of providers) if (entry.family===walletFamily(getChain(side))) {
      const option=dom.createElement('option');option.value=id;option.textContent=entry.name;box.append(option);
    }
    if (providers.get(previous)?.family===walletFamily(getChain(side))) box.value=previous;
    if (!box.options.length) status(side,'');
  }
  function update() {
    for (const side of sides) {
      $(side+'-wallet-connect').disabled=busy || externalBusy || !!pending[side] || !$(side+'-wallet-provider').options.length;
      $(side+'-wallet-provider').disabled=busy || externalBusy;
      if (side==='destination') {
        $(side+'-wallet-connect').hidden=!$(side+'-wallet-provider').options.length;
        $(side+'-wallet-connect').textContent=connections[side]?'Change wallet':'Connect wallet';
      }
      if (side==='source') $(side+'-wallet-status').hidden=!$(side+'-wallet-provider').options.length;
      validate(side);
    }
    $('destination-use-source').disabled=busy || externalBusy || !valid('source') || !normalizeWalletAddress(getChain('destination'),input('source').value);
    $('destination-use-source').hidden=walletFamily(getChain('source'))!==walletFamily(getChain('destination'));
  }
  function preference(side) {
    const family=walletFamily(getChain(side));
    return Object.hasOwn(preferences[side],family)?preferences[side][family]:preferences[side==='source'?'destination':'source'][family];
  }
  // This reads already-authorized accounts only. It never prompts, signs, or resumes a trade.
  async function restore(side) {
    if (busy || externalBusy || pending[side]) return;
    const chain=getChain(side),prior=connections[side],saved=preference(side);
    if (!saved) return;
    const matching=[...providers].filter(([,entry])=>entry.family===walletFamily(chain) && entry.aliases.has(saved.providerKey));
    if (matching.length!==1) return; // Never guess between extensions with the same label.
    const [id]=matching[0],address=valid(side);
    if (input(side).value && address!==saved.address) return; // Respect manual input, including while restoring.
    const version=versions[side],token={},adapter=adapterFor(side,id,chain);
    if (typeof adapter.resume!=='function') return;
    pending[side]=token;update();onUpdate();
    let timer;
    try {
      const account=await Promise.race([adapter.resume({chainId:chain,address:saved.address}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Wallet restore timed out')),5000);timer.unref?.();})]);
      if (versions[side]!==version || getChain(side)!==chain || pending[side]!==token) return;
      if (externalBusy) {restoreNeeded.add(side);return;}
      if (!account || !normalizeWalletAddress(chain,account.address)) {
        if (prior) clearConnection(side,'',true);
        else adapter.disconnect();
        return;
      }
      install(side,id,adapter,account);
    } catch {
      if (versions[side]===version && pending[side]===token) { if (prior) clearConnection(side,'',true); else adapter.disconnect(); }
    } finally {
      clearTimeout(timer);
      if (pending[side]===token) pending[side]=null;
      update();onUpdate();
    }
  }
  function requestRestore(side) {
    if (!preference(side)) return;
    restoreNeeded.add(side);
    if (queued) return;queued=true;
    queueMicrotask(()=>{
      queued=false;if (busy || externalBusy) return;
      const work=[...restoreNeeded];restoreNeeded.clear();
      for (const next of work) void restore(next);
    });
  }
  function syncChains() {
    let modified=false;
    for (const side of sides) {
      const chain=getChain(side);
      if (chain!==chainIds[side]) {
        chainIds[side]=chain;modified=true;selection?.cancel();invalidatePending(side);
        const row=connections[side];
        if (row && (walletFamily(row.account.chainId)!==walletFamily(chain) || walletFamily(chain)==='solana' && row.account.chainId!==chain)) clearConnection(side);
        if (input(side).value && !valid(side)) input(side).value='';
        populate(side);
        if (connections[side]) describe(side,connections[side]); else requestRestore(side);
      }
      validate(side);
    }
    update();if(modified)changed();
  }
  async function chooseAccount(side,accounts) {
    const box=$(side+'-wallet-account'),button=$(side+'-wallet-select-account');box.replaceChildren();box.hidden=false;button.hidden=false;
    for (const [index,account] of accounts.entries()) { const option=dom.createElement('option');option.value=String(index);option.textContent=account.address;box.append(option); }
    return new Promise((resolve,reject)=>{
      const finish=()=>{box.hidden=true;button.hidden=true;button.onclick=null;selection=null;};
      selection={cancel:()=>{finish();reject(Error('Wallet selection changed. Connect again.'));}};
      button.onclick=()=>{const account=accounts[Number(box.value)];finish();resolve(account);};
    });
  }
  async function connect(side) {
    if (busy || externalBusy) return;
    const chain=getChain(side),id=$(side+'-wallet-provider').value,entry=providers.get(id);
    if (!entry || entry.family!==walletFamily(chain)) return;
    busy=true;clearConnection(side);const version=versions[side];changed();update();onUpdate();status(side,`Connecting ${entry.name}…`);
    try {
      const adapter=adapterFor(side,id,chain),account=await adapter.connect(accounts=>chooseAccount(side,accounts));
      if (getChain(side)!==chain || versions[side]!==version) {adapter.disconnect();throw Error('The selected chain or wallet changed. Connect again.');}
      if (!normalizeWalletAddress(chain,account.address)) throw Error('The connected wallet is incompatible with the selected chain.');
      install(side,id,adapter,account);
    } catch (error) {status(side,error.message ?? 'Wallet connection failed.');}
    finally {busy=false;update();onUpdate();if(restoreNeeded.size)requestRestore([...restoreNeeded][0]);}
  }
  async function switchSourceChain() {
    if (busy || externalBusy) return;
    const row=connections.source,entry=providers.get(row?.id),chain=getChain('source');
    if (!row || entry?.family!=='evm' || !/^eip155:[1-9][0-9]*$/.test(chain)) return;
    busy=true;update();onUpdate();status('source',`Switching to ${name(chain)}…`);
    try {
      await entry.provider.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x'+BigInt(chain.slice(7)).toString(16)}]});
      if(getChain('source')!==chain)throw Error('The source network selection changed.');
      // The chainChanged event may invalidate the old account; use existing permission.
      const version=versions.source,adapter=adapterFor('source',row.id,chain),account=await adapter.resume(row.account);
      if (!account || account.chainId!==chain || getChain('source')!==chain || versions.source!==version) throw Error('The wallet network could not be confirmed.');
      install('source',row.id,adapter,account);restoreNeeded.delete('source');
    } catch(error){status('source',error.message ?? 'The network switch was not completed.');}
    finally{busy=false;update();onUpdate();if(restoreNeeded.size)requestRestore([...restoreNeeded][0]);}
  }
  function providerEvent(id,event,value) {
    const entry=providers.get(id);let modified=false;
    if(event==='disconnect' && entry.family==='solana'){
      for(const side of sides)if(entry.aliases.has(preferences[side].solana?.providerKey)){preferences[side].solana=null;restoreNeeded.delete(side);}
      save();
    }
    for (const side of sides) {
      const row=connections[side];
      if (row?.id!==id) continue;
      const same=event==='accountsChanged' && Array.isArray(value) && value.length<=100 && value.every(address=>normalizeWalletAddress(row.account.chainId,address)) && value.some(address=>normalizeWalletAddress(row.account.chainId,address)===row.account.address) ||
        event==='chainChanged' && typeof value==='string' && /^0x[0-9a-f]+$/i.test(value) && 'eip155:'+BigInt(value)===row.account.chainId ||
        event==='accountChanged' && value?.toString?.()===row.account.address && entry.provider.publicKey?.toString?.()===row.account.address;
      if(same)continue;
      // Receiving addresses are independent of the EVM wallet's current network.
      if(event==='chainChanged' && side==='destination')continue;
      modified=true;
      clearConnection(side,'',event==='chainChanged' || event==='disconnect' && entry.family==='evm' || Array.isArray(value) && value.length===0);
      selection?.cancel();
      if(event==='disconnect' && entry.family==='solana') continue;
      // Account switches must use the newly exposed account, never a remembered signer.
      const next=event==='accountChanged'?normalizeWalletAddress(getChain(side),value?.toString?.()):
        event==='accountsChanged' && Array.isArray(value) && value.length===1?normalizeWalletAddress(getChain(side),value[0]):null;
      if(next && entry.key){preferences[side][entry.family]={providerKey:entry.key,chainId:getChain(side),address:next};save();}
      if(event!=='disconnect')requestRestore(side);
    }
    if(modified){update();changed();}
  }
  function addProvider(id,label,family,provider,key) {
    if(!provider)return;
    const duplicate=[...providers].find(([,row])=>row.family===family && row.provider===provider);
    if(duplicate){if(key){duplicate[1].aliases.add(key);if(key.startsWith('rdns:') || !duplicate[1].key)duplicate[1].key=key;for(const side of sides){if(connections[side]?.id===duplicate[0])remember(side,connections[side]);requestRestore(side);}}return;}
    if(providers.size>=32 || providers.has(id))return;
    providers.set(id,{name:label,family,provider,key,aliases:new Set(key?[key]:[])});
    for(const event of family==='evm'?['accountsChanged','chainChanged','disconnect']:['accountChanged','disconnect'])provider.on?.(event,value=>providerEvent(id,event,value));
    provider.on?.('connect',()=>{for(const side of sides)requestRestore(side);});
    for(const side of sides){populate(side);requestRestore(side);}update();onUpdate();
  }
  host.addEventListener('eip6963:announceProvider',event=>{
    const item=event.detail;
    if(typeof item?.info?.uuid==='string' && item.info.uuid.length<=128 && typeof item.info.name==='string' && typeof item.provider?.request==='function')
      addProvider('evm:'+item.info.uuid,item.info.name.slice(0,80),'evm',item.provider,typeof item.info.rdns==='string' && /^[a-z0-9.-]{1,160}$/i.test(item.info.rdns)?'rdns:'+item.info.rdns.toLowerCase():null);
  });
  function discover() {
    for(const [index,provider] of (host.ethereum?.providers ?? (host.ethereum?[host.ethereum]:[])).entries()) {
      const brand=provider.isBraveWallet?'brave':provider.isMetaMask?'metamask':null;
      addProvider('evm:injected-'+index,brand==='brave'?'Brave Wallet':brand==='metamask'?'MetaMask':'Ethereum wallet','evm',provider,brand?'injected:evm:'+brand:null);
    }
    if(host.phantom?.ethereum)addProvider('evm:phantom','Phantom · EVM','evm',host.phantom.ethereum,'injected:evm:phantom');
    const solana=host.phantom?.solana ?? host.solana;
    if(solana?.connect && solana?.signMessage)addProvider('solana:injected',solana.isPhantom || host.phantom?.solana?'Phantom · Solana':'Solana wallet','solana',solana,solana.isPhantom || host.phantom?.solana?'injected:solana:phantom':null);
  }
  discover();
  for(const side of sides){
    populate(side);$(side+'-wallet-connect').onclick=()=>connect(side);
    $(side+'-wallet-provider').addEventListener('change',()=>{
      invalidatePending(side);preferences[side][walletFamily(getChain(side))]=null;save();restoreNeeded.delete(side);
      if(connections[side]?.id!==$(side+'-wallet-provider').value)clearConnection(side);
      selection?.cancel();update();changed();
    });
    input(side).addEventListener('input',()=>{
      invalidatePending(side);
      const row=connections[side];if(row && valid(side)!==row.account.address)status(side,'');
      validate(side);update();onUpdate();
    });
  }
  $('destination-use-source').onclick=()=>{
    if(busy || externalBusy)return;
    const address=normalizeWalletAddress(getChain('destination'),input('source').value);if(!address)return;
    invalidatePending('destination');input('destination').value=address;status('destination','');validate('destination');changed();update();
  };
  for(const id of ['source','destination','source-chain','destination-chain'])$(id).addEventListener('change',syncChains);
  const wake=()=>{if(dom.hidden)return;discover();host.dispatchEvent(new Event('eip6963:requestProvider'));for(const side of sides)requestRestore(side);};
  host.addEventListener('focus',wake);host.addEventListener('pageshow',wake);host.addEventListener('ethereum#initialized',wake);dom.addEventListener?.('visibilitychange',wake);
  host.dispatchEvent(new Event('eip6963:requestProvider'));update();
  return {update,setBusy(value){const wasBusy=externalBusy;externalBusy=value;update();if(wasBusy && !value && restoreNeeded.size)requestRestore([...restoreNeeded][0]);},
    connectSource:()=>connect('source'),switchSourceChain,
    sourceState(){const row=connections.source;return{available:$('source-wallet-provider').options.length>0,busy:busy || !!pending.source,connected:!!row,chainMatches:!!row && row.account.chainId===getChain('source'),addressMatches:!!row && valid('source')===row.account.address};},
    sourceIsReady(){const row=connections.source;return !busy && !pending.source && !!row && row.account.chainId===getChain('source') && valid('source')===row.account.address;},
    addressesValid:()=>!!valid('source') && !!valid('destination'),
    assertAddresses(){for(const side of sides){validate(side);if(!valid(side)){input(side).reportValidity();throw Error(`Enter a valid ${side==='source'?'sender':'recipient'} address for ${name(getChain(side))}.`);}}},
  };
}
