const addressQuery = value => /^0x[0-9a-fA-F]{40}$/.test(value) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
export function filterAssets(assets, query, chainId = '') {
  const text = query.trim(), lower = text.toLowerCase();
  return assets.filter(asset => (!chainId || asset.chainId === chainId) && (!text ||
    [asset.symbol,asset.name].some(value => String(value ?? '').toLowerCase().includes(lower)) ||
    (asset.chainId.startsWith('eip155:') ? asset.address.toLowerCase().includes(lower) : asset.address.includes(text))));
}
const sameAddress = (chainId,a,b) => chainId.startsWith('eip155:') ? a.toLowerCase() === b.toLowerCase() : a === b;
export function createAssetPicker({config,document,client,onSelect}) {
  if (!document.body?.append) return {open(){},close(){}};
  const make = (tag,className,text) => { const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node; };
  const dialog=make('dialog','asset-dialog'), heading=make('h2','','Select a token'), closeButton=make('button','asset-close','×');
  dialog.id='asset-picker-dialog';dialog.setAttribute('aria-labelledby','asset-picker-heading');heading.id='asset-picker-heading';
  closeButton.type='button';closeButton.setAttribute('aria-label','Close token picker');
  const top=make('div','asset-dialog-heading');top.append(heading,closeButton);
  const label=make('label','asset-search-label','Search tokens');label.htmlFor='asset-picker-search';
  const search=make('input','asset-search');search.id='asset-picker-search';search.placeholder='Search name, symbol or contract address';search.autocomplete='off';search.spellcheck=false;
  const chips=make('div','asset-chain-filters');chips.setAttribute('role','group');chips.setAttribute('aria-label','Filter tokens by network');
  const networkLabel=make('label','asset-network-label','Network');networkLabel.htmlFor='asset-picker-network';
  const networkSelect=make('select','asset-network-select');networkSelect.id='asset-picker-network';
  for(const chain of [{chainId:'',name:'All networks'},...config.chains]) {const option=make('option','',chain.name ?? chain.chainId);option.value=chain.chainId;networkSelect.append(option);}
  const status=make('p','asset-picker-status'), list=make('div','asset-list');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  list.setAttribute('aria-label','Matching tokens');const hint=make('p','asset-picker-hint','Token names can be copied. Check the network and contract address before choosing.');
  dialog.append(top,label,search,networkLabel,networkSelect,chips,status,list,hint);document.body.append(dialog);
  let side, chainId='', returnFocus, controller, revision=0, opened=false;
  const chainName = id => config.chains.find(row=>row.chainId===id)?.name ?? id;
  const stop = () => {revision++;controller?.abort();controller=null;};
  function close() {stop();opened=false;if(dialog.open)dialog.close();returnFocus?.focus();returnFocus?.setAttribute('aria-expanded','false');}
  function choose(asset, custom=false) {if(!opened)return;onSelect(side,asset,custom);close();}
  function row(asset, custom=false) {
    const button=make('button','asset-token-row');button.type='button';
    const icon=make('span','asset-token-icon',(asset.symbol ?? 'T').slice(0,2).toUpperCase());icon.setAttribute('aria-hidden','true');icon.setAttribute('data-symbol',asset.symbol ?? '');
    const details=make('span','asset-token-details'), symbol=make('strong','',asset.symbol ?? 'Token'), name=make('span','asset-token-name',asset.name ?? asset.symbol ?? (custom?'Custom token':'Token'));
    const network=make('span','asset-network-badge',chainName(asset.chainId));
    const contract=make('span','asset-token-address',asset.address);
    details.append(symbol,name,contract);button.append(icon,details,network);button.setAttribute('aria-label',`${asset.symbol ?? 'Token'}, ${asset.name ?? asset.symbol ?? (custom?'Custom token':'Token')}, ${chainName(asset.chainId)}, ${asset.address}`);
    button.addEventListener('click',()=>choose(asset,custom));return button;
  }
  function renderChips() {
    chips.replaceChildren();
    networkSelect.value=chainId;
    const quick=config.chains.slice(0,5);if(chainId&&!quick.some(chain=>chain.chainId===chainId))quick.push(config.chains.find(chain=>chain.chainId===chainId));
    for(const chain of [{chainId:'',name:'All networks'},...quick.filter(Boolean)]) {
      const chip=make('button','asset-chain-chip',chain.name ?? chain.chainId);chip.type='button';chip.setAttribute('aria-pressed',String(chain.chainId===chainId));
      chip.addEventListener('click',()=>{stop();chainId=chain.chainId;render();});chips.append(chip);
    }
  }
  function render() {
    renderChips();list.replaceChildren();
    const query=search.value.trim(), matches=filterAssets(config.assets ?? [],query,chainId);
    status.textContent=matches.length ? `${matches.length} token${matches.length===1?'':'s'}${matches.length>100?' · showing the first 100':''}` : 'No matching tokens.';
    for(const asset of matches.slice(0,100))list.append(row(asset));
    if(addressQuery(query) && !matches.some(asset=>sameAddress(asset.chainId,asset.address,query))) {
      if(!chainId) {status.textContent='Choose the network for this contract or mint address.';return;}
      const lookup=make('button','asset-lookup','Look up token on '+chainName(chainId));lookup.type='button';lookup.disabled=typeof client?.resolveAsset!=='function';
      lookup.addEventListener('click',()=>lookupToken(query,chainId));list.append(lookup);
      if(lookup.disabled)status.textContent='Token lookup is unavailable. Use the custom address fields below the selected token.';
    }
    const manual=make('button','asset-manual','Enter a contract or mint manually');manual.type='button';manual.addEventListener('click',()=>choose({chainId:chainId || config.chains[0]?.chainId,address:addressQuery(query)?query:''},true));list.append(manual);
  }
  async function lookupToken(address, network) {
    stop();const version=revision;controller=new AbortController();const signal=controller.signal;
    status.textContent='Looking up token details…';list.replaceChildren();
    try {
      const asset=await client.resolveAsset({chainId:network,address},{signal});
      if(!opened||signal.aborted||version!==revision||search.value.trim()!==address||chainId!==network)return;
      if(asset.chainId!==network||typeof asset.address!=='string'||!sameAddress(network,asset.address,address)||!Number.isInteger(asset.decimals)||asset.decimals<0||asset.decimals>255||asset.metadataVerified!==true)throw Error('Token details could not be verified.');
      status.textContent=`Token details found · ${asset.decimals} decimals. Check the contract before selecting.`;list.replaceChildren(row(asset,true));
    } catch(error) {
      if(!opened||signal.aborted||version!==revision)return;
      status.textContent=error.code==='TOKEN_METADATA_UNSUPPORTED'?'Automatic lookup is unavailable on this network. You can enter exact decimals in the custom fields.':'Token lookup failed. Check the network and address, then try again.';
      const retry=make('button','asset-lookup','Try token lookup again');retry.type='button';retry.addEventListener('click',()=>lookupToken(address,network));list.replaceChildren(retry);
      const manual=make('button','asset-manual','Use custom address fields');manual.type='button';manual.addEventListener('click',()=>choose({chainId:network,address},true));list.append(manual);
    }
  }
  networkSelect.addEventListener('change',()=>{stop();chainId=networkSelect.value;render();});
  search.addEventListener('input',()=>{stop();render();});closeButton.addEventListener('click',close);
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  dialog.addEventListener('click',event=>{if(event.target!==dialog)return;const box=dialog.getBoundingClientRect();if(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom)close();});
  dialog.addEventListener('keydown',event=>{
    if(event.key==='Escape'){event.preventDefault();close();return;}
    if(event.key!=='Tab')return;
    const nodes=[...dialog.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled])')];
    const first=nodes[0],last=nodes.at(-1);
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  });
  return {open(selectedSide,trigger,selected) {
    stop();side=selectedSide;returnFocus=trigger;chainId=selected?.chainId ?? '';search.value='';opened=true;
    heading.textContent=side==='source'?'Select token to pay':'Select token to receive';render();
    if(!dialog.open)dialog.showModal();trigger?.setAttribute('aria-expanded','true');search.focus();
  },close};
}
