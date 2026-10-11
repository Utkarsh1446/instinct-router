import test from 'node:test';
import assert from 'node:assert/strict';
import {tradeProgressModel,renderTradeProgress} from '../examples/browser/trade-progress.js';
const BASE='eip155:8453',SOL='solana:mainnet',recipient='47YyVUMwerrz76mCrpgFP3iDva1Vt4ZxpSuxo6AhwabT';
const source={chainId:BASE,address:'0x'+'a'.repeat(40),decimals:6},destination={chainId:SOL,address:'So11111111111111111111111111111111111111112',decimals:9};
const config={chains:[{chainId:BASE,name:'Base'},{chainId:SOL,name:'Solana'}],assets:[{...source,symbol:'USDC'},{...destination,symbol:'SOL'}]};
function record(status='READY') {return {status,nextAction:0,submissions:[],plan:{source,destination,recipient,amountRaw:'1234567',minimumOutRaw:'3000000000',routeId:'route-1',actions:[{id:'relay-provider-deposit'}]}};}
const model=(row,progress)=>tradeProgressModel({record:row,progress,config});
const fund=row=>{row.submissions=[{actionId:'relay-provider-deposit',hash:'hash-1'}];return row;};
const progress=stage=>({routeId:'route-1',actionId:'relay-provider-deposit',sourceTransactionHash:'hash-1',stage,destination:{asset:destination,recipient,amountRaw:'3500000000'}});
test('READY retains exact amount, minimum output, networks and full recipient',()=>{
 const value=model(record());assert.equal(value.title,'Review swap');assert.equal(value.review.input,'1.234567 USDC');assert.equal(value.review.minimumOutput,'3 SOL');
 assert.equal(value.review.recipient,recipient);assert.equal(value.review.sourceChain,'Base');assert.equal(value.review.destinationChain,'Solana');assert(value.steps.every(step=>step.state==='pending'));
});
test('cross-chain source confirmation keeps combined bridging and swapping active',()=>{
 const value=model(fund(record('SUBMITTED')),progress('SOURCE_CONFIRMED'));assert.equal(value.title,'Swap in progress');
 assert.deepEqual(value.steps,[{label:'Swap initiated',state:'complete'},{label:'Bridging & swapping',state:'active'},{label:'Finalizing',state:'pending'}]);
});
test('observed destination credit shows Funds received and Finalizing, never final completion',()=>{
 const value=model(fund(record('SUBMITTED')),progress('DESTINATION_CONFIRMED'));assert.equal(value.title,'Funds received');assert.equal(value.summary,'1.234567 USDC → 3.5 SOL');
 assert.equal(value.steps[2].label,'Finalizing');assert.equal(value.steps[2].state,'active');assert.notEqual(value.icon,'complete');
});
test('stale or mismatched progress cannot invent received funds',()=>{
 for(const mutate of [p=>{p.routeId='other';},p=>{p.sourceTransactionHash='other';},p=>{p.actionId='other';},p=>{p.destination.recipient='other';},p=>{p.destination.asset={...destination,chainId:BASE};},p=>{p.destination.amountRaw='1';}]){
  const update=structuredClone(progress('DESTINATION_CONFIRMED'));mutate(update);const value=model(fund(record('SUBMITTED')),update);assert.notEqual(value.title,'Funds received');assert.match(value.summary,/≥ 3 SOL/);
 }
});
test('only COMPLETE sets the last step complete; matching actual credits replace minimum summary',()=>{
 for(const location of ['receipt','destinationReceipt']){const row=fund(record('COMPLETE'));row[location]={destinationCredit:{asset:destination,recipient,amountRaw:'4000000000'}};
  const value=model(row);assert.equal(value.title,'Swap complete');assert(value.steps.every(step=>step.state==='complete'));assert.equal(value.summary,'1.234567 USDC → 4 SOL');
  row[location].destinationCredit.recipient='other';assert.match(model(row).summary,/≥ 3 SOL/);
 }
 assert.match(model(fund(record('COMPLETE'))).summary,/≥ 3 SOL/);
});
test('same-chain routes never label a bridge stage',()=>{
 const row=fund(record('SUBMITTED'));row.plan.destination={...destination,chainId:BASE};const value=model(row);
 assert.equal(value.steps[1].label,'Swapping');assert(value.steps.every(step=>!/bridg/i.test(step.label)));
});
test('approval claim and approval-only hash never mark the swap initiated',()=>{
 for(const id of ['relay-usdc-approve','relay-token-approve','relay-provider-approve']){
  for(const status of ['CLAIMED','SUBMITTED']){const row=record(status);row.plan.actions.unshift({id});if(status==='SUBMITTED')row.submissions=[{actionId:id,hash:'approval-hash'}];
   const value=model(row);assert.equal(value.steps[0].state,'pending');assert.match(value.title,/Approv/);
  }
 }
 const row=record('SUBMITTED');row.plan.actions.unshift({id:'relay-provider-approve'});row.submissions=[{actionId:'relay-provider-approve',hash:'approval-hash'},{actionId:'relay-provider-deposit',hash:'hash-1'}];
 assert.equal(model(row).steps[0].state,'complete');
});
test('terminal and recovery states use concise titles without inventing successful completion',()=>{
 for(const [status,title] of [['EXPIRED','Quote expired'],['CANCELLED','Swap cancelled'],['FAILED','Swap failed'],['RECOVERY_REQUIRED','Checking swap status']]){
  const value=model(fund(record(status)),progress('DESTINATION_CONFIRMED'));assert.equal(value.title,title);assert.notEqual(value.icon,'complete');if(status!=='RECOVERY_REQUIRED')assert.equal(value.steps.length,0);
 }
});
test('asset labels bind EVM address case and exact Solana mint/network identity',()=>{
 const row=record();row.plan.source={...source,address:source.address.toUpperCase()};assert.match(model(row).summary,/USDC/);
 row.plan.destination={...destination,address:destination.address.toLowerCase()};assert.match(model(row).summary,/3 tokens/);
 row.plan.source={...source,chainId:'eip155:1'};assert.match(model(row).summary,/1.234567 tokens/);
});
class Element{children=[];attributes={};textContent='';append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=nodes;}setAttribute(k,v){this.attributes[k]=v;}set innerHTML(_){throw Error('Unsafe HTML');}}
const flatten=node=>[node,...node.children.flatMap(flatten)];
test('renderer is compact, text-only, accessible and clears absent record',()=>{
 const document={createElement:()=>new Element()},container=new Element(),metadata={...config,assets:config.assets.map(asset=>({...asset,symbol:asset.chainId===BASE?'<img>':'SOL'}))};
 const rendered=renderTradeProgress({document,container,record:record(),config:metadata});assert.equal(rendered.review.input,'1.234567 <img>');
 const nodes=flatten(container),recipientNode=nodes.find(node=>node.title===recipient);assert(recipientNode);assert.equal(recipientNode.attributes['aria-label'],recipient);
 assert(nodes.some(node=>node.textContent==='1.234567 <img> · Base'));assert.equal(nodes.filter(node=>node.className?.startsWith('trade-progress-step ')).length,3);
 assert(!nodes.some(node=>/block|fee|hash|wall.clock|milliseconds/i.test(node.textContent)));
 for(const absent of [null,false]){assert.equal(renderTradeProgress({document,container,record:absent}),null);assert.equal(container.children.length,0);}
});
