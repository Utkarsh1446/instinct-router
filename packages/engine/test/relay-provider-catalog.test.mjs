import test from 'node:test';
import assert from 'node:assert/strict';
import {providerExecutionChainsFromCatalog,discoverProviderExecutionChains,publicExecutionRpc,validateProviderExecutionChains} from '../src/relay-provider-catalog.mjs';
const zero='0x'+'00'.repeat(20),target='0x'+'11'.repeat(20);
const row=(id=8453)=>({id,vmType:'evm',depositEnabled:true,httpRpcUrl:'https://rpc.example.com/',currency:{address:zero,decimals:18,symbol:'ETH'},protocol:{v2:{chainId:'chain-'+id,depository:target}},contracts:{approvalProxy:target},solverAddresses:[target]});
test('provider execution discovery is separate, explicitly filtered and bounded operator configuration',()=>{
 const catalog={chains:[row(),row(42161),{...row(1),disabled:true},{...row(2),depositEnabled:false},{...row(3),vmType:'bvm'}]},chains=providerExecutionChainsFromCatalog(catalog);
 assert.deepEqual(chains.map(c=>c.chainId),['eip155:8453','eip155:42161']);assert.equal(chains[0].feeModel,'OPSTACK');assert.equal(chains[1].feeModel,'STANDARD');assert.equal(chains[0].confirmations,12);assert.equal(providerExecutionChainsFromCatalog({chains:[row(169)]})[0].feeModel,'PROVIDER_ESTIMATE');
 const overrides=providerExecutionChainsFromCatalog(catalog,{rpcOverrides:{'eip155:8453':'https://operator.example.com/'}});assert.equal(overrides[0].rpcUrl,'https://operator.example.com/');
 assert.throws(()=>validateProviderExecutionChains([...chains,chains[0]]));assert.throws(()=>validateProviderExecutionChains([{...chains[0],confirmations:1}]));
});
test('quote supplied/private/redirected/oversized chain discovery is rejected',async()=>{
 for(const url of ['http://rpc.example.com','https://user:password@rpc.example.com','https://localhost','https://10.0.0.1','https://[::1]','https://metadata.internal','https://rpc.example.com:8080','https://rpc.example.com/#secret'])assert.throws(()=>publicExecutionRpc(url));
 for(const data of [{chains:[row(),row()]},{chains:[{...row(),httpRpcUrl:'https://localhost'}]},{chains:Array.from({length:129},(_,i)=>row(i+1))}])assert.throws(()=>providerExecutionChainsFromCatalog(data));
 for(const response of [new Response('{"chains":[],"chains":[]}'),new Response('x'.repeat(2097153)),new Response('{}',{status:302})])await assert.rejects(discoverProviderExecutionChains({fetch:async()=>response}));
 let asked;const chains=await discoverProviderExecutionChains({fetch:async(url,init)=>{asked={url,init};return new Response(JSON.stringify({chains:[row()]}));}});assert.equal(chains.length,1);assert.equal(asked.url,'https://api.relay.link/chains');assert.equal(asked.init.redirect,'error');assert.equal(asked.init.headers,undefined);
});
test('discovery returns cancellation promptly even when external fetch ignores it',async()=>{
 const controller=new AbortController(),pending=discoverProviderExecutionChains({fetch:async()=>new Promise(()=>{}),signal:controller.signal});controller.abort();await assert.rejects(pending,/PROVIDER_EXECUTION_DISCOVERY_TIMEOUT/);
});
