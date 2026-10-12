import { createAssetPicker } from './asset-picker.js';
/** Token presets are convenience choices. Every server-listed chain also accepts a contract or mint. */
export function initTokenSelection({config, document, client}) {
  const $ = id => document.getElementById(id);
  const emit=(node,type)=>node.dispatchEvent?.(new (document.defaultView?.Event ?? Event)(type,{bubbles:true}));
  const picker=createAssetPicker({config,document,client,onSelect(side,asset,custom) {
    if (!custom) {$(side).value=asset.id;emit($(side),'change');}
    else {
      $(side).value='custom';$(side+'-chain').value=asset.chainId;$(side+'-address').value=asset.address;
      emit($(side),'change');emit($(side+'-chain'),'change');emit($(side+'-address'),'input');
      $(side+'-decimals').value=Number.isInteger(asset.decimals)?String(asset.decimals):'';emit($(side+'-decimals'),'input');
      displaySelectedToken({side,config,document,asset});
      $(side+'-custom').hidden=asset.metadataVerified===true;
    }
  }});
  const option = (value, label) => { const node=document.createElement('option');node.value=value;node.textContent=label;return node; };
  for (const side of ['source','destination']) {
    $(side).replaceChildren();$(side+'-chain').replaceChildren();
    for (const item of config.assets ?? []) $(side).append(option(item.id, `${item.symbol ?? 'Token'} · ${config.chains.find(chain=>chain.chainId===item.chainId)?.name ?? item.chainId}`));
    $(side).append(option('custom','Paste contract or mint address'));
    for (const chain of config.chains) $(side+'-chain').append(option(chain.chainId,chain.name ?? chain.chainId));
    const sync=()=>{ const custom=$(side).value==='custom';$(side+'-custom').hidden=!custom;
      displaySelectedToken({side,config,document});
      $(side+'-token-help').textContent=$(side+'-chain').value.startsWith('solana:') ? 'Paste a token mint. The router verifies token decimals before pricing.' : 'Paste a token contract. Token presets do not limit your choices.'; };
    const resetPrecision=()=>{ $(side+'-decimals').value='';sync(); };
    $(side+'-token-picker')?.addEventListener('click',()=> {const selected=config.assets.find(asset=>asset.id===$(side).value) ?? {chainId:$(side+'-chain').value};picker.open(side,$(side+'-token-picker'),selected);});
    $(side).addEventListener('change',resetPrecision);$(side+'-chain').addEventListener('change',resetPrecision);
    $(side+'-address').addEventListener('input',resetPrecision);sync();
  }
  const routes=config.execution?.enabled && config.capabilities?.walletExecution ? config.execution.supportedRoutes ?? [] : [];
  const initialRoute=routes.find(route=>route.source.chainId!==route.destination.chainId) ?? routes[0];
  const same=(a,b)=>a.chainId===b.chainId && (a.chainId.startsWith('eip155:') ? a.address.toLowerCase()===b.address.toLowerCase() : a.address===b.address);
  for(const side of ['source','destination']) {
    const preset=config.assets.find(asset=>initialRoute?.[side] && same(asset,initialRoute[side])) ??
      config.assets.find(asset=>asset.id===config.defaults?.[side+'AssetId']) ?? config.assets[side==='source'?0:1] ?? config.assets[0];
    $(side).value=preset?.id ?? 'custom';$(side+'-custom').hidden=!!preset;displaySelectedToken({side,config,document});
  }
  $('swap-direction')?.addEventListener('click',()=>{if (!$('quote-form')?.inert) reverseTokenSelection({config,document});});
  return picker;
}
export function displaySelectedToken({side,config,document,asset}) {
  const $=id=>document.getElementById(id);
  const selected=asset ?? config.assets.find(row=>row.id===$(side).value);
  const chainId=selected?.chainId ?? $(side+'-chain').value;
  const address=selected?.address ?? $(side+'-address').value.trim();
  const chain=config.chains.find(row=>row.chainId===chainId)?.name ?? chainId;
  const symbol=selected?.symbol ?? (address ? address.slice(0,5)+'…'+address.slice(-4) : 'Select token');
  $(side+'-token-symbol').textContent=symbol;$(side+'-token-name').textContent=selected?.name ?? (selected ? selected.symbol ?? '' : 'Custom token');
  $(side+'-token-icon')?.setAttribute?.('data-symbol',selected?.symbol ?? '');
  $(side+'-token-chain').textContent=chain;$(side+'-token-icon').textContent=(selected?.symbol ?? 'T').slice(0,2).toUpperCase();
  $(side+'-token-picker')?.setAttribute?.('aria-label',`Select ${side==='source'?'payment':'receiving'} token. ${symbol} on ${chain}`);
}
export async function selectedToken({side,config,client,document,signal}) {
  const $=id=>document.getElementById(id);
  const selected=config.assets.find(row=>row.id===$(side).value);
  if(selected)return {chainId:selected.chainId,address:selected.address,decimals:selected.decimals};
  const chainId=$(side+'-chain').value,address=$(side+'-address').value.trim();
  if(!config.chains.some(chain=>chain.chainId===chainId))throw Error('Choose a chain available from this router.');
  let resolved;
  try { resolved=await client.resolveAsset({chainId,address},{signal}); }
  catch(error) {
    if(error.code!=='TOKEN_METADATA_UNSUPPORTED')throw error;
    if($(side).value!=='custom'||$(side+'-chain').value!==chainId||$(side+'-address').value.trim()!==address)throw Error('The selected token changed during lookup. Request fresh prices.');
    const decimals=$(side+'-decimals').value.trim();
    if(!/^(?:0|[1-9][0-9]{0,2})$/.test(decimals)||Number(decimals)>255)throw Error('Automatic token lookup is unavailable for this chain. Enter the token’s exact decimals to compare prices.');
    $(side+'-token-help').textContent='Token decimals were entered manually. Price previews use this precision; executable trades require server verification.';
    return {chainId,address,decimals:Number(decimals)};
  }
  if($(side).value!=='custom'||$(side+'-chain').value!==chainId||$(side+'-address').value.trim()!==address)throw Error('The selected token changed during lookup. Request fresh prices.');
  $(side+'-decimals').value=String(resolved.decimals);displaySelectedToken({side,config,document,asset:resolved});
  const provenance = resolved.decimalsSource === 'FINALIZED_CHAIN' ? 'finalized chain metadata' :
    resolved.decimalsSource === 'PROVIDER_CATALOG' ? 'provider token catalog' : resolved.decimalsSource === 'PINNED_CONFIG' ? 'configured token metadata' : 'router token metadata';
  $(side+'-token-help').textContent=`Token decimals: ${resolved.decimals} from ${provenance}. Available prices depend on provider coverage.`;
  return {chainId,address:resolved.address,decimals:resolved.decimals};
}

/** Swap both asset selections atomically; wallet ownership is handled by the existing role manager. */
export function reverseTokenSelection({config,document}) {
  const $=id=>document.getElementById(id);
  const fields=['','-chain','-address','-decimals'];
  const snapshot=side=>({values:fields.map(field=>$(side+field).value),hidden:$(side+'-custom').hidden});
  const source=snapshot('source'),destination=snapshot('destination');
  for(const [side,saved] of [['source',destination],['destination',source]])
    fields.forEach((field,index)=>{$(side+field).value=saved.values[index];});
  $('amount').value='';
  const emit=(node,type)=>node.dispatchEvent?.(new (document.defaultView?.Event ?? Event)(type,{bubbles:true}));
  // Dispatch after both sides change so wallet/network listeners never see a partial reversal.
  for(const side of ['source','destination'])emit($(side),'change');
  for(const [side,saved] of [['source',destination],['destination',source]]) {
    $(side+'-decimals').value=saved.values[3];$(side+'-custom').hidden=saved.hidden;
    displaySelectedToken({side,config,document});
  }
  emit($('amount'),'input');
}
