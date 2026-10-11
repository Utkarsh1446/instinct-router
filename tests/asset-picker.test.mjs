import test from 'node:test';
import assert from 'node:assert/strict';
import {filterAssets,createAssetPicker} from '../examples/browser/asset-picker.js';
import {initTokenSelection,selectedToken} from '../examples/browser/token-selection.js';
const BASE='eip155:8453',SOL='solana:mainnet',ADDRESS='0x'+'a'.repeat(40),MINT='So11111111111111111111111111111111111111112';
const config={chains:[{chainId:BASE,name:'Base'},{chainId:SOL,name:'Solana'}],assets:[
 {id:'base-eth',chainId:BASE,address:'0x'+'0'.repeat(40),decimals:18,symbol:'ETH',name:'Ether'},
 {id:'base-usdc',chainId:BASE,address:ADDRESS,decimals:6,symbol:'USDC',name:'USD Coin'},
 {id:'sol-sol',chainId:SOL,address:MINT,decimals:9,symbol:'SOL',name:'Wrapped Solana'}]};
class Element {
 constructor(tag,document){this.tagName=tag.toUpperCase();this.document=document;this.children=[];this.handlers=new Map();this.attributes={};this.value='';this.textContent='';this.disabled=false;this.hidden=false;this.open=false;}
 set id(value){this._id=value;this.document.nodes.set(value,this);}get id(){return this._id;}
 set innerHTML(value){throw Error('Unsafe HTML insertion: '+value);}
 append(...nodes){for(const node of nodes){node.parent=this;this.children.push(node);if(node.tagName==='OPTION'&&this.children.length===1)this.value=node.value;}}
 replaceChildren(...nodes){this.children=[];this.value='';this.append(...nodes);}
 addEventListener(name,fn){this.handlers.set(name,[...(this.handlers.get(name)??[]),fn]);}
 dispatchEvent(event){for(const fn of this.handlers.get(event.type)??[])fn(event);if(event.bubbles)this.parent?.dispatchEvent(event);return true;}
 fire(type,fields={}){const event={type,target:this,...fields,preventDefault(){this.defaultPrevented=true;}};this.dispatchEvent(event);return event;}
 click(){if(!this.disabled)this.fire('click');}
 setAttribute(key,value){this.attributes[key]=value;}getAttribute(key){return this.attributes[key];}
 focus(){this.document.activeElement=this;}
 showModal(){this.open=true;}close(){this.open=false;}
 querySelectorAll(){return this.descendants().filter(node=>['BUTTON','INPUT','SELECT'].includes(node.tagName)&&!node.disabled);}
 descendants(){return this.children.flatMap(child=>[child,...child.descendants()]);}
}
function documentFixture(){const document={nodes:new Map(),createElement(tag){return new Element(tag,this);},getElementById(id){if(!this.nodes.has(id)){const node=this.createElement(id.includes('chain')||['source','destination'].includes(id)?'select':'div');node.id=id;this.form?.append(node);}return this.nodes.get(id);}};
 document.body=document.createElement('body');document.form=document.createElement('form');document.body.append(document.form);return document;}
const rows=document=>document.getElementById('asset-picker-dialog').descendants().filter(node=>node.className==='asset-token-row');
const button=(document,text)=>document.getElementById('asset-picker-dialog').descendants().find(node=>node.tagName==='BUTTON'&&node.textContent===text);
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function pickerFixture(options={}){const document=documentFixture(),selected=[];const picker=createAssetPicker({config,document,onSelect:(...args)=>selected.push(args),...options});const trigger=document.getElementById('trigger');return {document,selected,picker,trigger,$:id=>document.getElementById(id)};}
test('search matches token name/symbol and contracts while Solana mint identity stays case-sensitive',()=>{
 assert.equal(filterAssets(config.assets,'usd')[0].id,'base-usdc');assert.equal(filterAssets(config.assets,'ether')[0].id,'base-eth');
 assert.equal(filterAssets(config.assets,ADDRESS.toUpperCase())[0].id,'base-usdc');assert.equal(filterAssets(config.assets,MINT)[0].id,'sol-sol');
 assert.equal(filterAssets(config.assets,MINT.toLowerCase()).length,0);assert.equal(filterAssets(config.assets,'',SOL).length,1);
});
test('all configured networks are reachable without horizontally traversing chips',()=>{
 const many={...config,chains:Array.from({length:53},(_,i)=>({chainId:'eip155:'+String(i+1),name:'Network '+i})),assets:[]};
 const f=pickerFixture({config:many});f.picker.open('source',f.trigger);
 assert.equal(f.$('asset-picker-network').children.length,54);assert(f.$('asset-picker-dialog').descendants().filter(node=>node.className==='asset-chain-chip').length<=7);
 f.$('asset-picker-network').value='eip155:53';f.$('asset-picker-network').fire('change');assert(button(f.document,'Network 52'));
});
test('preset selection keeps the hidden form contract and bubbling change event',()=>{
 const document=documentFixture();let changes=0;document.form.addEventListener('change',()=>changes++);
 initTokenSelection({config,document});const trigger=document.getElementById('destination-token-picker');trigger.click();
 document.getElementById('asset-picker-network').value=SOL;document.getElementById('asset-picker-network').fire('change');rows(document)[0].click();
 assert.equal(document.getElementById('destination').value,'sol-sol');assert.equal(document.getElementById('destination-token-symbol').textContent,'SOL');
 assert.equal(document.getElementById('destination-token-chain').textContent,'Solana');assert.equal(document.getElementById('destination-custom').hidden,true);assert(changes>0);
 assert.equal(document.activeElement,trigger);
});
test('contract lookup is explicitly network-bound and selecting verified metadata updates original fields',async()=>{
 const document=documentFixture(),lookups=[];
 initTokenSelection({config,document,client:{resolveAsset:async(input)=>{lookups.push(input);return {...input,decimals:8,symbol:'NEW',name:'New token',metadataVerified:true};}}});
 document.getElementById('source-token-picker').click();const search=document.getElementById('asset-picker-search');search.value='0x'+'b'.repeat(40);search.fire('input');
 button(document,'Look up token on Base').click();await flush();assert.deepEqual(lookups,[{chainId:BASE,address:search.value}]);rows(document)[0].click();
 assert.equal(document.getElementById('source').value,'custom');assert.equal(document.getElementById('source-chain').value,BASE);
 assert.equal(document.getElementById('source-address').value,search.value);assert.equal(document.getElementById('source-decimals').value,'8');
 assert.equal(document.getElementById('source-token-symbol').textContent,'NEW');assert.equal(document.getElementById('source-custom').hidden,true);
});
test('late lookup responses cannot overwrite changed search, chain or closed dialog',async()=>{
 for(const change of ['query','chain','close']){let release;const f=pickerFixture({client:{resolveAsset:()=>new Promise(resolve=>{release=resolve;})}});
  f.picker.open('source',f.trigger,{chainId:BASE});const address='0x'+'b'.repeat(40);f.$('asset-picker-search').value=address;f.$('asset-picker-search').fire('input');button(f.document,'Look up token on Base').click();
  if(change==='query'){f.$('asset-picker-search').value='ETH';f.$('asset-picker-search').fire('input');}else if(change==='chain'){f.$('asset-picker-network').value=SOL;f.$('asset-picker-network').fire('change');}else f.picker.close();
  release({chainId:BASE,address,decimals:6,symbol:'LATE',metadataVerified:true});await flush();assert.equal(f.selected.length,0);assert(!rows(f.document).some(row=>row.getAttribute('aria-label').startsWith('LATE')));
 }
});
test('unverified or mismatched metadata fails closed and manual fallback never invents decimals',async()=>{
 for(const patch of [{metadataVerified:false},{chainId:SOL},{address:ADDRESS},{decimals:256}]){
  const f=pickerFixture({client:{resolveAsset:async(input)=>({...input,decimals:6,metadataVerified:true,...patch})}});f.picker.open('source',f.trigger,{chainId:BASE});f.$('asset-picker-search').value='0x'+'b'.repeat(40);f.$('asset-picker-search').fire('input');button(f.document,'Look up token on Base').click();await flush();
  assert.equal(rows(f.document).length,0);button(f.document,'Use custom address fields').click();assert.equal(f.selected[0][1].decimals,undefined);assert.equal(f.selected[0][2],true);
 }
});
test('metadata is rendered as text and the token result list has a fixed render bound',()=>{
 const hostile={...config.assets[0],symbol:'<img src=x>',name:'<script>alert(1)</script>'};
 const f=pickerFixture({config:{...config,assets:[hostile,...Array.from({length:200},(_,i)=>({...config.assets[1],id:'token-'+i}))]}});f.picker.open('source',f.trigger);
 assert.equal(rows(f.document).length,100);assert.match(f.$('asset-picker-dialog').descendants().find(node=>node.className==='asset-picker-status').textContent,/first 100/);
 assert.equal(rows(f.document)[0].children[1].children[0].textContent,hostile.symbol);assert.equal(rows(f.document)[0].children[1].children[1].textContent,hostile.name);
});
test('Escape restores trigger focus and Tab wraps inside the dialog',()=>{
 const f=pickerFixture();f.picker.open('source',f.trigger);assert.equal(f.document.activeElement,f.$('asset-picker-search'));
 assert.equal(f.trigger.getAttribute('aria-expanded'),'true');const dialog=f.$('asset-picker-dialog'),nodes=dialog.querySelectorAll();nodes.at(-1).focus();
 assert.equal(dialog.fire('keydown',{key:'Tab'}).defaultPrevented,true);assert.equal(f.document.activeElement,nodes[0]);
 dialog.fire('keydown',{key:'Tab',shiftKey:true});assert.equal(f.document.activeElement,nodes.at(-1));
 dialog.fire('keydown',{key:'Escape'});assert.equal(dialog.open,false);assert.equal(f.document.activeElement,f.trigger);assert.equal(f.trigger.getAttribute('aria-expanded'),'false');
});

test('configured presets without names use their symbol rather than a custom-token label',()=>{
 const {name,...asset}=config.assets[0];const f=pickerFixture({config:{...config,assets:[asset]}});f.picker.open('source',f.trigger);
 assert.equal(rows(f.document)[0].children[1].children[1].textContent,'ETH');assert.doesNotMatch(rows(f.document)[0].getAttribute('aria-label'),/Custom token/);
});

test('verified custom choices hide manual fields but still resolve fresh metadata before quoting',async()=>{
 const document=documentFixture();let calls=0;
 const client={resolveAsset:async input=>({...input,decimals:++calls===1?6:8,symbol:'NEW',name:'New token',metadataVerified:true})};
 initTokenSelection({config,document,client});const trigger=document.getElementById('source-token-picker');trigger.click();
 const search=document.getElementById('asset-picker-search');search.value='0x'+'b'.repeat(40);search.fire('input');button(document,'Look up token on Base').click();await flush();rows(document)[0].click();
 assert.equal(document.getElementById('source-custom').hidden,true);assert.equal(document.getElementById('source').value,'custom');assert.equal(document.getElementById('source-decimals').value,'6');
 const fresh=await selectedToken({side:'source',config,client,document});assert.equal(calls,2);assert.equal(fresh.decimals,8);assert.equal(document.getElementById('source-decimals').value,'8');assert.equal(document.getElementById('source-custom').hidden,true);
 trigger.click();button(document,'Enter a contract or mint manually').click();assert.equal(document.getElementById('source-custom').hidden,false);assert.equal(document.getElementById('source-decimals').value,'');
});
