import test from 'node:test';
import assert from 'node:assert/strict';
import {initTokenSelection,selectedToken,reverseTokenSelection} from '../examples/browser/token-selection.js';
class Element {value='';textContent='';hidden=false;children=[];events=new Map();append(row){this.children.push(row);if(this.children.length===1)this.value=row.value;}replaceChildren(){this.children=[];this.value='';}addEventListener(name,fn){this.events.set(name,fn);}}
const EVM='eip155:7777777',SOL='solana:mainnet',address='0x'+'a'.repeat(40);
function fixture(){const nodes=new Map();const document={getElementById(id){if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);},createElement(){return new Element();}};
 const config={chains:[{chainId:EVM,name:'Added chain'},{chainId:SOL,name:'Solana'}],assets:[{id:'dynamic-preset',chainId:EVM,address,decimals:18,symbol:'DYN'}],defaults:{sourceAssetId:'dynamic-preset'}};
 initTokenSelection({document,config});return {document,config,$:id=>document.getElementById(id)};}
test('all server chains and presets populate without fixed chain or token identifiers',()=>{const f=fixture();assert.equal(f.$('source').value,'dynamic-preset');assert.equal(f.$('source-chain').children.length,2);assert(f.$('source').children.some(row=>row.value==='custom'));});
test('pasted contracts use verified server decimals rather than preset six decimals',async()=>{const f=fixture();f.$('source').value='custom';f.$('source-address').value=address;f.$('source-decimals').value='6';let lookup;
 const result=await selectedToken({...f,side:'source',client:{async resolveAsset(input){lookup=input;return {...input,decimals:18};}}});assert.equal(result.decimals,18);assert.deepEqual(lookup,{chainId:EVM,address});assert.equal(f.$('source-decimals').value,'18');});
test('manual preview precision only falls back on explicit unsupported metadata, never lookup failures',async()=>{const f=fixture();f.$('source').value='custom';f.$('source-address').value=address;
 const client={async resolveAsset(){throw Object.assign(Error('Unsupported'),{code:'TOKEN_METADATA_UNSUPPORTED'});}};
 await assert.rejects(selectedToken({...f,side:'source',client}),/exact decimals/);f.$('source-decimals').value='18';assert.equal((await selectedToken({...f,side:'source',client})).decimals,18);
 client.resolveAsset=async()=>{throw Object.assign(Error('Unavailable'),{code:'TOKEN_METADATA_UNAVAILABLE'});};await assert.rejects(selectedToken({...f,side:'source',client}),/Unavailable/);});
test('late metadata cannot replace a newly selected token',async()=>{const f=fixture();f.$('source').value='custom';f.$('source-address').value=address;
 await assert.rejects(selectedToken({...f,side:'source',client:{async resolveAsset(input){f.$('source-address').value='0x'+'b'.repeat(40);return {...input,decimals:9};}}}),/changed/);assert.equal(f.$('source-decimals').value,'');});
test('pasted Solana mint uses resolver and destination precision independently',async()=>{const f=fixture();f.$('destination').value='custom';f.$('destination-chain').value=SOL;f.$('destination-address').value='So11111111111111111111111111111111111111112';const result=await selectedToken({...f,side:'destination',client:{async resolveAsset(input){return {...input,decimals:9};}}});assert.equal(result.chainId,SOL);assert.equal(result.decimals,9);assert.equal(f.$('source-decimals').value,'');});

test('preset choices hide custom controls and no-preset configurations expose them',()=>{
  const f=fixture();assert.equal(f.$('source-custom').hidden,true);
  initTokenSelection({document:f.document,config:{...f.config,assets:[]}});assert.equal(f.$('source').value,'custom');assert.equal(f.$('source-custom').hidden,false);
});
test('initial executable route prefers cross-chain coverage without fixed token identifiers',()=>{
  const f=fixture();const solAsset={id:'new-solana-token',chainId:SOL,address:'So11111111111111111111111111111111111111112',decimals:9};
  initTokenSelection({document:f.document,config:{...f.config,assets:[...f.config.assets,solAsset],capabilities:{walletExecution:true},execution:{enabled:true,supportedRoutes:[{source:f.config.assets[0],destination:f.config.assets[0]},{source:f.config.assets[0],destination:solAsset}]}}});
  assert.equal(f.$('destination').value,'new-solana-token');assert.equal(f.$('destination-custom').hidden,true);
});
test('token address or chain changes clear metadata precision before manual fallback',()=>{
  const f=fixture();f.$('source-decimals').value='18';f.$('source-address').events.get('input')();assert.equal(f.$('source-decimals').value,'');
  f.$('source-decimals').value='9';f.$('source-chain').value=SOL;f.$('source-chain').events.get('change')();assert.equal(f.$('source-decimals').value,'');
});
test('catalog decimals are labeled provider catalog rather than chain verified',async()=>{
  const f=fixture();f.$('source').value='custom';f.$('source-address').value=address;
  await selectedToken({...f,side:'source',client:{async resolveAsset(input){return {...input,decimals:18,decimalsSource:'PROVIDER_CATALOG'};}}});
  assert.match(f.$('source-token-help').textContent,/provider token catalog/);assert.doesNotMatch(f.$('source-token-help').textContent,/finalized|verified/i);
  await selectedToken({...f,side:'source',client:{async resolveAsset(input){return {...input,decimals:18,decimalsSource:'FINALIZED_CHAIN'};}}});assert.match(f.$('source-token-help').textContent,/finalized chain metadata/);
});

test('manual preview precision accepts uint8 decimals 255 and rejects 256 or fractional input',async()=>{
  const f=fixture();f.$('source').value='custom';f.$('source-address').value=address;
  const client={async resolveAsset(){throw Object.assign(Error('Unsupported'),{code:'TOKEN_METADATA_UNSUPPORTED'});}};
  f.$('source-decimals').value='255';assert.equal((await selectedToken({...f,side:'source',client})).decimals,255);
  for(const precision of ['256','1.5','-1']){f.$('source-decimals').value=precision;await assert.rejects(selectedToken({...f,side:'source',client}),/exact decimals/);}
});

test('reversing assets preserves custom precision, clears amount, and never copies wallet addresses',()=>{
  const f=fixture();f.$('destination').value='custom';f.$('destination-chain').value=SOL;
  f.$('destination-address').value='So11111111111111111111111111111111111111112';f.$('destination-decimals').value='9';f.$('destination-custom').hidden=false;
  f.$('amount').value='2';f.$('sender').value='source-wallet';f.$('recipient').value='receiving-wallet';
  const observed=[];
  for(const side of ['source','destination'])f.$(side).dispatchEvent=event=>{
    observed.push([f.$('source').value,f.$('destination').value]);
    f.$(side).events.get(event.type)?.(event);
  };
  reverseTokenSelection(f);
  assert.deepEqual(observed,[['custom','dynamic-preset'],['custom','dynamic-preset']]);
  assert.equal(f.$('source-chain').value,SOL);assert.equal(f.$('source-decimals').value,'9');
  assert.equal(f.$('source-address').value,'So11111111111111111111111111111111111111112');
  assert.equal(f.$('destination-custom').hidden,true);assert.equal(f.$('source-custom').hidden,false);
  assert.equal(f.$('amount').value,'');assert.equal(f.$('sender').value,'source-wallet');assert.equal(f.$('recipient').value,'receiving-wallet');
});
