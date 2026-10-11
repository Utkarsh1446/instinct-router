/** Offline dispatch checks: public structural evidence, no listener, wallet or network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createExecutionEngine} from '../src/execution-engine.mjs';
import {fixture as providerFixture} from './fixtures/relay-provider.mjs';
import {fixture as baseFixture,pins,input} from './fixtures/base-execution.mjs';
import {relayPrepared,relayPins} from './fixtures/relay-execution.mjs';
import {SOLANA_USDC} from '../src/relay-base-sol-execution.mjs';
const RECIPE='relay-provider-managed-v1';
function catalog(f){return f.chains.map(c=>({...c,rpcUrl:c.providerChainId===8453?'https://base.drpc.org/':'https://ethereum.publicnode.com/'}));}
function external(f){const r=f.request;return {source:r.source,destination:r.destination,amount:r.source.decimals===6?'0.1':'0.0001',sender:r.sender,recipient:r.recipient,slippageBps:r.slippageBps,maxFeeBps:null,maxPriceImpactBps:r.maxPriceImpactBps,nativeFeeBudgets:r.nativeFeeBudgets};}
function publicWire(f){return (url,init)=>{const call=JSON.parse(init.body);if(call.method==='eth_chainId'&&url.includes('ethereum.publicnode'))return Promise.resolve(new Response(JSON.stringify({jsonrpc:'2.0',id:call.id,result:'0x1'})));return f.wire(url,init);};}
test('operator opt-in dispatches arbitrary token and configured EVM destination through the generic recipe',async()=>{
 for(const options of [{},{token:true,approval:true},{cross:true}]){
  const f=providerFixture(options),engine=createExecutionEngine({fetch:publicWire(f),now:f.now,executionPins:{providerManaged:{enabled:true}},providerExecutionChains:catalog(f)});
  const result=await engine.prepare(external(f));assert.equal(result.candidate.legQuotes[0].executableRecipeId,RECIPE);
  assert.equal(result.candidate.executionReady,true);const recipe=engine.recipes.find(r=>r.id===RECIPE),plan=await recipe.verify(result.request,result.candidate);
  assert.equal(plan.providerRoute.mode,'PROVIDER_MANAGED');assert.equal(plan.source.chainId,f.request.source.chainId);assert.equal(plan.destination.chainId,f.request.destination.chainId);
  assert.equal((await engine.verifier.preflight(plan,plan.actions[0])).ready,true);assert.equal(f.rfqs(),1);
  await assert.rejects(recipe.verify(result.request,result.candidate),/BINDING_MISMATCH/);
 }
});
test('generic execution remains operator opt-in and excluded from independent scope',async()=>{
 const f=providerFixture(),config={fetch:publicWire(f),now:f.now,providerExecutionChains:catalog(f)};
 await assert.rejects(createExecutionEngine(config).prepare(external(f)),/ADAPTER_UNAVAILABLE/);
 await assert.rejects(createExecutionEngine({...config,executionPins:{providerManaged:{enabled:true}}}).prepare({...external(f),routeScope:'INDEPENDENT'}),/ADAPTER_UNAVAILABLE/);
 assert.equal(f.rfqs(),0);
});
test('provider opt-in preserves the independently reconstructed Base local recipe',async()=>{
 const base=baseFixture(),f=providerFixture(),engine=createExecutionEngine({fetch:base.wire,now:base.now,executionPins:{...pins,providerManaged:{enabled:true}},providerExecutionChains:catalog(f)});
 const result=await engine.prepare(input());assert.equal(result.candidate.legQuotes[0].executableRecipeId,'base-native-uniswap-v1');
});
test('provider opt-in preserves both original Base to Solana USDC protocol recipes',async()=>{
 for(const sourceUsdc of [false,true]){
  const x=await relayPrepared({sourceUsdc}),f=providerFixture(),chain=catalog(f)[0],sol={chainId:SOLANA_USDC.chainId,providerChainId:792703809,protocolChainId:'solana',vm:'SOLANA',rpcUrl:'https://solana-rpc.publicnode.com/',nativeCurrency:{address:'11111111111111111111111111111111',decimals:9,symbol:'SOL'},contracts:{},solverAddresses:[],confirmations:1,feeModel:'STANDARD'};
  const engine=createExecutionEngine({fetch:x.wire,now:x.f.now,executionPins:{...pins,relay:{...relayPins,solanaSolverSigners:['47YyVUMwerrz76mCrpgFP3iDva1Vt4ZxpSuxo6AhwabT']},providerManaged:{enabled:true}},providerExecutionChains:[chain,sol]});
  const result=await engine.prepare({...input(),source:{chainId:chain.chainId,address:sourceUsdc?'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913':'0x'+'00'.repeat(20),decimals:sourceUsdc?6:18},destination:SOLANA_USDC,recipient:'47YyVUMwerrz76mCrpgFP3iDva1Vt4ZxpSuxo6AhwabT',amount:sourceUsdc?'0.1':'0.00005',maxFeeBps:9999,maxPriceImpactBps:9999});
  assert.equal(result.candidate.legQuotes[0].executableRecipeId,sourceUsdc?'relay-base-usdc-solana-usdc-v1':'relay-base-native-solana-usdc-v1');
 }
});
