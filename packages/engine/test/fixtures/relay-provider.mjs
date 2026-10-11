/** Offline public structural fixture; imports register no tests. */
import assert from 'node:assert/strict';
import {createRelayProviderExecution} from '../../src/relay-provider-execution.mjs';
import {word} from '../../src/relay-provider-terms.mjs';
export const OWNER='0x'+'11'.repeat(20),ROUTER='0x'+'22'.repeat(20),TOKEN='0x'+'33'.repeat(20),ZERO='0x'+'00'.repeat(20),HASH='0x'+'44'.repeat(32);
export function fixture({token=false,approval=false,legacy=false,op=false,cross=false}={}){
 let time=1800000000000,allowance=approval?0n:1000000000000000n,code='0x60006000',balance=10n**20n,failSim=false,reorg=false,calls=[],rfqs=0;
 const chain={chainId:'eip155:8453',providerChainId:8453,vm:'EVM',rpcUrl:'https://base.example/',protocolChainId:'base',nativeCurrency:{address:ZERO,decimals:18,symbol:'ETH'},contracts:{erc20Router:ROUTER},solverAddresses:[OWNER],confirmations:12,feeModel:op?'OPSTACK':'STANDARD'};
 const chains=[chain,...(cross?[{...chain,chainId:'eip155:1',providerChainId:1,protocolChainId:'ethereum',rpcUrl:'https://eth.example/'}]:[])];
 const request={requestId:'fixture',source:{chainId:chain.chainId,address:token?TOKEN:ZERO,decimals:token?6:18},destination:{chainId:cross?'eip155:1':chain.chainId,address:token?ZERO:TOKEN,decimals:token?18:6},amountRaw:token?'100000':'100000000000000',sender:OWNER,recipient:OWNER,slippageBps:50,maxFeeBps:null,maxPriceImpactBps:500,maxCompletionMs:90000,deadlineMs:time+90000,optimization:{objective:'FASTEST',maxOutputShortfallBps:50},nativeFeeBudgets:[{chainId:chain.chainId,maxAmountRaw:null}]};
 const tx={from:OWNER,to:ROUTER,data:'0x12345678',value:token?'0':request.amountRaw,chainId:8453,gas:'100000'};
 const step=data=>({id:'deposit',kind:'transaction',requestId:'0x'+'99'.repeat(32),items:[{status:'incomplete',data}]});
 const raw={details:{sender:OWNER,recipient:OWNER,slippageTolerance:{total:'50'},currencyIn:{currency:{chainId:8453,address:request.source.address,decimals:request.source.decimals},amount:request.amountRaw,minimumAmount:request.amountRaw,amountUsd:'1'},currencyOut:{currency:{chainId:cross?1:8453,address:request.destination.address,decimals:request.destination.decimals},amount:'100000',minimumAmount:'99500'},timeEstimate:5,expandedPriceImpact:{execution:{usd:'0.001'},relay:{usd:'0.001'},app:{usd:'0'}},swapImpact:{percent:'0.1'}},fees:{gas:{currency:{chainId:8453,address:ZERO,decimals:18},amount:'1000000000000',amountUsd:'0.001'},app:{amount:'0'}},steps:[...(approval?[{id:'approve',kind:'transaction',items:[{status:'incomplete',data:{from:OWNER,to:TOKEN,value:'0',chainId:8453,data:'0x095ea7b3'+word(ROUTER)+word((1n<<256n)-1n)}}]}]:[]),step(tx)]};
 let evidence={success:true,receipt:{chainId:chain.chainId,transactionHash:HASH,confirmations:12}},inspections=0;
 const verifier={inspect:async()=>{inspections++;},confirm:async()=>structuredClone(evidence)};
 const wire=async(url,init)=>{
  const c=JSON.parse(init.body);calls.push(c);
  if(url==='https://api.relay.link/quote/v2'){rfqs++;return new Response(JSON.stringify(raw));}
  let result;
  if(c.method==='eth_chainId')result='0x2105';
  else if(c.method==='eth_getBlockByNumber')result={hash:reorg&&c.params[0]!=='latest'?'0x'+'55'.repeat(32):HASH,number:'0x64',timestamp:'0x'+BigInt(Math.floor(time/1000)).toString(16),...(legacy?{}:{baseFeePerGas:'0x989680'})};
  else if(c.method==='eth_getCode')result=c.params[0]===OWNER?'0x':code;
  else if(c.method==='eth_getStorageAt')result='0x'+word(0);
  else if(c.method==='eth_getBalance')result='0x'+balance.toString(16);
  else if(c.method==='eth_maxPriorityFeePerGas')result='0xf4240';
  else if(c.method==='eth_gasPrice')result='0x1406f40';
  else if(c.method==='eth_estimateGas')result='0x186a0';
  else if(c.method==='eth_call'){
   const data=c.params[0].data;
   if(data==='0x313ce567')result='0x'+word(6);
   else if(data.startsWith('0x70a08231'))result='0x'+word(1000000);
   else if(data.startsWith('0xdd62ed3e'))result='0x'+word(allowance);
   else if(data.startsWith('0x095ea7b3'))result='0x'+word(1);
   else if(data==='0x960e3a23'||data==='0x105d0b81')result='0x'+word(1);
   else if(data.startsWith('0xf1c7a58b'))result='0x'+word(1000);
   else if(data.startsWith('0x275aedd2'))result='0x'+word(10);
   else if(failSim)return new Response(JSON.stringify({jsonrpc:'2.0',id:c.id,error:{code:-32000,message:'secret provider data'}}));
   else result='0x';
  }else assert.fail(c.method);
  return new Response(JSON.stringify({jsonrpc:'2.0',id:c.id,result}));
 };
 const engine=createRelayProviderExecution({fetch:wire,now:()=>time,chains,receiptVerifier:verifier});
 return {engine,request,raw,calls,chain,chains,wire,verifier,now:()=>time,advance:n=>time+=n,allowance:n=>allowance=n,code:v=>code=v,balance:n=>balance=n,failSim:()=>failSim=true,reorg:()=>reorg=true,evidence:v=>evidence=v,rfqs:()=>rfqs,inspections:()=>inspections};
}
