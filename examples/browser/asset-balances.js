import { normalizeWalletAddress } from './wallet-addresses.js';

// Never round an on-chain amount through Number, including large ERC20 values.
export function formatBalance(raw, decimals) {
  const padded = raw.padStart(decimals + 1, '0');
  const whole = decimals ? padded.slice(0, -decimals) : padded;
  const fraction = decimals ? padded.slice(-decimals).replace(/0+$/, '') : '';
  const exact = whole + (fraction ? '.' + fraction : '');
  if (fraction.length <= 6) return { exact, compact:exact };
  const prefix = fraction.slice(0, 6).replace(/0+$/, '');
  return {exact, compact:whole === '0' && !prefix ? '<0.000001' : whole + (prefix ? '.' + prefix : '') + '…'};
}

export function initAssetBalances({client, config, document, window, timers = {setTimeout:(fn,ms)=>setTimeout(fn,ms), clearTimeout:id=>clearTimeout(id)}, now = Date.now}) {
  const $ = id => document.getElementById(id);
  const states = new Map(['source','destination'].map(side => [side, {key:null, revision:0}]));
  let disposed = false, refreshTimer, reads = Promise.resolve();
  const listeners = [];
  const listen = (target,event,fn) => { target.addEventListener(event,fn); listeners.push(() => target.removeEventListener(event,fn)); };
  function selection(side) {
    const preset = config.assets.find(asset => asset.id === $(side).value);
    const chainId = preset?.chainId ?? $(side+'-chain').value;
    const address = preset?.address ?? $(side+'-address').value.trim();
    const owner = normalizeWalletAddress(chainId, $(side === 'source' ? 'sender' : 'recipient').value);
    const evm = chainId.startsWith('eip155:');
    const validAsset = evm ? /^0x[0-9a-fA-F]{40}$/.test(address) : address === '11111111111111111111111111111111' || normalizeWalletAddress(chainId,address);
    const availableChain = config.chains.some(chain => chain.chainId === chainId);
    if (!availableChain || !validAsset) return {empty:'Select an asset to see its balance.'};
    if (!owner) return {empty:side === 'source' ? 'Connect your wallet to see balance.' : 'Enter a receiving address to see balance.'};
    const input = {chainId,address:evm?address.toLowerCase():address,owner};
    return {input,key:JSON.stringify(input),symbol:preset?.symbol ?? ''};
  }
  function paint(side, text, state, title='') {
    const element = $(side+'-balance'); if (!element) return;
    element.textContent = text; element.dataset.state = state; element.title = title;
  }
  async function refreshSide(side, force) {
    const state = states.get(side), selected = selection(side);
    if (!force && state.key === selected.key && (state.pending || now()-(state.checkedAt ?? 0)<15000)) return;
    const changed = state.key !== selected.key;
    state.controller?.abort(); state.revision++; state.key=selected.key;
    const revision=state.revision;
    if (changed) state.balance=null;
    if (!selected.input) { state.pending=false; paint(side,selected.empty,'empty'); return; }
    const controller = new AbortController(); state.controller=controller; state.pending=true;
    paint(side,state.balance ? `${state.balance.label} · updating…` : 'Balance: checking…','loading',state.balance?.title);
    // Bound both transport and UI waiting even if a custom client ignores abort.
    let timeout;
    try {
      // One read at a time leaves the example app's other API slot available
      // for route prices and recovery. Superseded queued selections never read.
      const pending=reads.then(() => {
        if (controller.signal.aborted) throw Error('Selection changed');
        const deadline = new Promise((_,reject) => { timeout=timers.setTimeout(() => {controller.abort();reject(Error('Balance lookup timed out'));},10000); });
        return Promise.race([client.getAssetBalance(selected.input,{signal:controller.signal}),deadline]);
      });
      reads=pending.catch(()=>{});
      const value = await pending;
      if (disposed || state.revision!==revision || controller.signal.aborted) return;
      const formatted=formatBalance(value.balanceRaw,value.decimals);
      const label=`Balance: ${formatted.compact}${selected.symbol ? ' '+selected.symbol : ''}`;
      const title=`${formatted.exact}${selected.symbol ? ' '+selected.symbol : ''} · ${selected.input.owner} · checked ${new Date(value.observedAtMs).toLocaleTimeString()}`;
      state.balance={label,title}; paint(side,label,'ready',title);
    } catch {
      if (disposed || state.revision!==revision) return;
      // An unavailable or stale observation is never represented as zero.
      paint(side,state.balance ? state.balance.label+' · unable to refresh' : 'Balance unavailable · retrying shortly','unavailable',state.balance?.title);
    } finally {
      timers.clearTimeout(timeout);
      if (state.revision===revision) {state.pending=false;state.checkedAt=now();}
    }
  }
  function refresh(force=false) {
    if (disposed) return Promise.resolve();
    return Promise.all(['source','destination'].map(side=>refreshSide(side,force)));
  }
  const changed=()=>{void refresh();};
  const force=()=>{void refresh(true);};
  const visible=()=>{if (!document.hidden) force();};
  listen($('quote-form'),'input',changed); listen($('quote-form'),'change',changed);
  listen($('quote-form'),'swapend',force); listen(window,'focus',visible); listen(document,'visibilitychange',visible);
  function schedule() {
    refreshTimer=timers.setTimeout(() => { if (!document.hidden && !$('quote-form').inert) void refresh(); schedule(); },15000);
    refreshTimer?.unref?.();
  }
  void refresh(); schedule();
  return {refresh,dispose() {disposed=true;timers.clearTimeout(refreshTimer);for(const state of states.values())state.controller?.abort();for(const stop of listeners)stop();}};
}
