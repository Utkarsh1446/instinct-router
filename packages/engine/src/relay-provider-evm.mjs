/** Fresh canonical EVM readiness for explicitly provider-managed calldata. Never signs/sends. */
import {createHash} from 'node:crypto';
import {fail} from './base-execution-checks.mjs';
import {ZERO,plain,address,eq,sha,hex,word,units,quantity,amount,ceil,canonical,sameAsset} from './relay-provider-terms.mjs';
const MAX_GAS=5000000n,MAX_PRICE=100000000000000n;
const SLOT='0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const codeHash=v=>{if(typeof v!=='string'||!/^0x(?:[a-f0-9]{2}){1,32768}$/i.test(v))fail('RELAY_PROVIDER_CODE_UNSUPPORTED');return createHash('sha256').update(Buffer.from(v.slice(2),'hex')).digest('hex');};
function uintWord(v){if(typeof v!=='string'||!/^0x[a-f0-9]{64}$/i.test(v))fail('RELAY_PROVIDER_EVIDENCE_INVALID');return BigInt(v);}
const call=(to,data,block)=>({to,data,gas:hex(MAX_GAS)});
function freshHeader(h,now){if(!plain(h)||!/^0x[0-9a-f]{64}$/.test(h.hash)||BigInt(h.hash)===0n||quantity(h.number)===0n)fail('RELAY_PROVIDER_EVIDENCE_INVALID');const ms=Number(quantity(h.timestamp))*1000;if(!Number.isSafeInteger(ms)||ms>now+2000||now-ms>60000)fail('RELAY_PROVIDER_STALE');return {hash:h.hash,number:h.number,timestamp:h.timestamp,baseFee:h.baseFeePerGas===undefined?null:quantity(h.baseFeePerGas)};}
async function together(tasks){const rows=await Promise.allSettled(tasks);const bad=rows.find(r=>r.status==='rejected');if(bad)throw bad.reason;return rows.map(r=>r.value);}
async function identity(read,to,block,signal){
 const [code,storage]=await together([read('eth_getCode',[to,block],signal),read('eth_getStorageAt',[to,SLOT,block],signal)]);
 if(typeof storage!=='string'||!/^0x0{24}[0-9a-f]{40}$/i.test(storage))fail('RELAY_PROVIDER_CODE_UNSUPPORTED');
 const out={address:to.toLowerCase(),codeSha256:codeHash(code)},impl='0x'+storage.slice(-40).toLowerCase();
 if(BigInt(impl))out.implementation={slot:SLOT,address:impl,codeSha256:codeHash(await read('eth_getCode',[impl,block],signal))};return out;
}
function providerTx(raw,request,chain){
 if(!plain(raw)||Object.keys(raw).some(k=>!['from','to','data','value','chainId','gas','gasLimit','gasPrice','maxFeePerGas','maxPriorityFeePerGas','type'].includes(k))||
  !eq(raw.from,request.sender)||raw.chainId!==chain.providerChainId||!address(raw.to)||!chain.allowedTargets.includes(raw.to.toLowerCase())||
  typeof raw.data!=='string'||!/^0x(?:[0-9a-fA-F]{2}){0,65536}$/.test(raw.data))fail('RELAY_PROVIDER_TRANSACTION_UNSUPPORTED');
 const value=amount(raw.value??'0');
 if(eq(request.source.address,ZERO)?value!==units(request.amountRaw):value!==0n)fail('RELAY_PROVIDER_SPENDING_MISMATCH');
 return {from:request.sender,to:raw.to.toLowerCase(),chainId:hex(BigInt(chain.providerChainId)),data:raw.data.toLowerCase(),value:hex(value)};
}
export async function prepareEvm({request,terms,chain,read,signal,now}){
 const tx=providerTx(terms.funding.data,request,chain),native=eq(request.source.address,ZERO);
 if(!address(request.sender)||!address(request.source.address)||native&&request.source.decimals!==chain.nativeCurrency.decimals)fail('RELAY_PROVIDER_BINDING_MISMATCH');
 const [network,latest]=await together([read('eth_chainId',[],signal),read('eth_getBlockByNumber',['latest',false],signal)]);
 if(quantity(network)!==BigInt(chain.providerChainId))fail('RELAY_PROVIDER_CHAIN_MISMATCH');
 const header=freshHeader(latest,now()),block={blockHash:header.hash,requireCanonical:true};
 const [walletCode,balance,targetIdentity]=await together([read('eth_getCode',[request.sender,block],signal),read('eth_getBalance',[request.sender,block],signal),identity(read,tx.to,block,signal)]);
 if(walletCode!=='0x')fail('RELAY_PROVIDER_WALLET_UNSUPPORTED');
 let sourceIdentity,spenderIdentity,needsApproval=false,spender;
 if(!native){
  sourceIdentity=await identity(read,request.source.address,block,signal);
  const [decimals,tokenBalance]=await together([read('eth_call',[call(request.source.address,'0x313ce567',block),block],signal),read('eth_call',[call(request.source.address,'0x70a08231'+word(request.sender),block),block],signal)]);
  if(uintWord(decimals)!==BigInt(request.source.decimals))fail('RELAY_PROVIDER_TOKEN_UNSUPPORTED');
  if(uintWord(tokenBalance)<units(request.amountRaw))fail('EXECUTION_TOKEN_BALANCE_INSUFFICIENT');
  if(terms.approval){const a=terms.approval;
   if(!eq(a.from,request.sender)||a.chainId!==chain.providerChainId||!eq(a.to,request.source.address)||amount(a.value??'0')!==0n||typeof a.data!=='string'||!/^0x095ea7b30{24}[0-9a-fA-F]{40}[0-9a-fA-F]{64}$/.test(a.data))fail('RELAY_PROVIDER_APPROVAL_UNSUPPORTED');
   spender='0x'+a.data.slice(34,74).toLowerCase();
   if(!chain.allowedTargets.includes(spender))fail('RELAY_PROVIDER_APPROVAL_UNSUPPORTED');
  }else spender=tx.to;
  spenderIdentity=eq(spender,tx.to)?targetIdentity:await identity(read,spender,block,signal);
  const allowance=uintWord(await read('eth_call',[call(request.source.address,'0xdd62ed3e'+word(request.sender)+word(spender),block),block],signal));
  needsApproval=allowance<units(request.amountRaw);
  if(needsApproval&&!terms.approval)fail('EXECUTION_APPROVAL_REQUIRED');
 }else if(terms.approval)fail('RELAY_PROVIDER_APPROVAL_UNSUPPORTED');
 let priceFields;
 if(header.baseFee!==null){const tip=quantity(await read('eth_maxPriorityFeePerGas',[],signal)),max=header.baseFee*2n+tip;if(!max||max>MAX_PRICE||tip>max)fail('RELAY_PROVIDER_FEES_UNKNOWN');priceFields={type:'0x2',maxFeePerGas:hex(max),maxPriorityFeePerGas:hex(tip),accessList:[]};}
 else{const price=quantity(await read('eth_gasPrice',[],signal));if(!price||price>MAX_PRICE)fail('RELAY_PROVIDER_FEES_UNKNOWN');priceFields={type:'0x0',gasPrice:hex(price)};}
 Object.assign(tx,priceFields);
 const actions=[];
 if(needsApproval)actions.push({id:'relay-provider-approve',kind:'TOKEN_APPROVAL',transaction:{...tx,to:request.source.address,data:'0x095ea7b3'+word(spender)+word(request.amountRaw),value:'0x0'},approval:{spender,amountRaw:request.amountRaw}});
 actions.push({id:terms.funding.kind==='SWAP'?'relay-provider-swap':'relay-provider-deposit',kind:terms.funding.kind,transaction:tx});
 for(const action of actions){
  const canSimulate=action.kind==='TOKEN_APPROVAL'||!needsApproval;
  let estimate;
  if(canSimulate)estimate=quantity(await read('eth_estimateGas',[action.transaction,block],signal));
  else estimate=amount(terms.funding.data.gas??terms.funding.data.gasLimit??'0');
  if(estimate<21000n||ceil(estimate*3n,2n)>MAX_GAS)fail('RELAY_PROVIDER_GAS_UNKNOWN');
  action.transaction.gas=hex(ceil(estimate*3n,2n));
  // Simulate the exact bounded gas limit offered to the wallet. An omitted
  // limit lets nodes charge the entire block gas limit against the balance.
  const [fee,simulation]=await together([reserve(chain,read,action.transaction,block,signal),
   ...(canSimulate?[read('eth_call',[action.transaction,block],signal)]:[])]);
  if(canSimulate&&(typeof simulation!=='string'||!/^0x(?:[0-9a-fA-F]{2})*$/.test(simulation)||action.kind==='TOKEN_APPROVAL'&&!['0x','0x'+word(1)].includes(simulation)))fail('RELAY_PROVIDER_SIMULATION_FAILED');
  action.estimateRaw=fee.toString();
  action.validation={targetIdentity:action.kind==='TOKEN_APPROVAL'?sourceIdentity:targetIdentity,...(sourceIdentity?{sourceIdentity,spender,spenderIdentity}:{}),simulationVerified:canSimulate,feeModel:chain.feeModel};
 }
 // Provider full-route gas is an explicit API estimate, not independent surcharge attestation.
 const providerFull=units(terms.providerFullGasEstimateRaw),prior=actions.slice(0,-1).reduce((n,a)=>n+BigInt(a.estimateRaw),0n),funding=actions.at(-1);
 if(!providerFull)fail('RELAY_PROVIDER_FEES_UNKNOWN');
 const providerFloor=providerFull>prior?providerFull-prior:0n;
 if(BigInt(funding.estimateRaw)<providerFloor)funding.estimateRaw=providerFloor.toString();
 for(const a of actions)a.validation.evidence={providerFullGasEstimateRaw:providerFull.toString(),providerGasFloorRaw:a===funding?providerFloor.toString():'0',feeTrust:chain.feeModel==='PROVIDER_ESTIMATE'?'PROVIDER_FULL_GAS_ESTIMATE':'RPC_AND_PROVIDER_ESTIMATE'};
 const measured=actions.reduce((n,a)=>n+BigInt(a.estimateRaw),0n),budget=request.nativeFeeBudgets?.find(b=>b.chainId===chain.chainId);
 if(!budget||budget.maxAmountRaw!==null&&units(budget.maxAmountRaw)<measured)fail('EXECUTION_NATIVE_BUDGET_EXCEEDED');
 const padded=ceil(measured*125n,100n),cap=budget.maxAmountRaw===null?padded:units(budget.maxAmountRaw)<padded?units(budget.maxAmountRaw):padded;
 let assigned=0n;for(let i=0;i<actions.length;i++){const raw=BigInt(actions[i].estimateRaw),allocation=i===actions.length-1?cap-assigned:raw+(cap-measured)*raw/measured;actions[i].feeCapRaw=allocation.toString();assigned+=allocation;}
 if(quantity(balance)<(native?units(request.amountRaw):0n)+cap)fail('EXECUTION_NATIVE_BALANCE_INSUFFICIENT');
 await canonicalEnd(read,header,signal,now);
 return {actions,feeCapRaw:cap.toString()};
}
async function reserve(chain,read,tx,block,signal){
 let total=quantity(tx.gas)*quantity(tx.maxFeePerGas??tx.gasPrice);
 if(chain.feeModel==='OPSTACK'){
  codeHash(await read('eth_getCode',[chain.gasOracle,block],signal));
  const values=await together([read('eth_call',[call(chain.gasOracle,'0x960e3a23',block),block],signal),read('eth_call',[call(chain.gasOracle,'0x105d0b81',block),block],signal),
   read('eth_call',[call(chain.gasOracle,'0xf1c7a58b'+word((tx.data.length-2)/2+512),block),block],signal),read('eth_call',[call(chain.gasOracle,'0x275aedd2'+word(quantity(tx.gas)),block),block],signal)]);
  if(uintWord(values[0])!==1n||uintWord(values[1])!==1n||uintWord(values[2])===0n)fail('RELAY_PROVIDER_FEES_UNKNOWN');total+=2n*uintWord(values[2])+uintWord(values[3]);
 }return total;
}
async function canonicalEnd(read,header,signal,now){const end=await read('eth_getBlockByNumber',[header.number,false],signal);freshHeader(end,now());if(end.hash!==header.hash||end.number!==header.number||end.timestamp!==header.timestamp)fail('RELAY_PROVIDER_REORG');}
export async function preflightEvm({plan,action,chain,read,signal,now}){
 const tx=action.payload.transaction,v=action.payload.validation,native=eq(plan.source.address,ZERO),approval=action.payload.kind==='TOKEN_APPROVAL';
 const [network,latest]=await together([read('eth_chainId',[],signal),read('eth_getBlockByNumber',['latest',false],signal)]);
 if(quantity(network)!==BigInt(chain.providerChainId))fail('RELAY_PROVIDER_CHAIN_MISMATCH');const header=freshHeader(latest,now()),block={blockHash:header.hash,requireCanonical:true};
 if(header.baseFee!==null&&header.baseFee+quantity(tx.maxPriorityFeePerGas??'0x0')>quantity(tx.maxFeePerGas??tx.gasPrice))fail('EXECUTION_REVIEW_GAS_RESERVE_EXCEEDED');
 const [walletCode,balance,currentIdentity]=await together([read('eth_getCode',[plan.sender,block],signal),read('eth_getBalance',[plan.sender,block],signal),identity(read,tx.to,block,signal)]);
 if(walletCode!=='0x'||canonical(currentIdentity)!==canonical(v?.targetIdentity))fail('RELAY_PROVIDER_IDENTITY_CHANGED');
 if(!native){const sourceIdentity=eq(tx.to,plan.source.address)?currentIdentity:await identity(read,plan.source.address,block,signal);
  if(canonical(sourceIdentity)!==canonical(v.sourceIdentity))fail('RELAY_PROVIDER_IDENTITY_CHANGED');
  const spender=v.spender;if(!chain.allowedTargets.includes(spender))fail('RELAY_PROVIDER_BINDING_MISMATCH');
  const spenderIdentity=eq(spender,tx.to)?currentIdentity:await identity(read,spender,block,signal);
  if(canonical(spenderIdentity)!==canonical(v.spenderIdentity))fail('RELAY_PROVIDER_IDENTITY_CHANGED');
  const [decimals,tokenBalance,allowance]=await together([read('eth_call',[call(plan.source.address,'0x313ce567',block),block],signal),read('eth_call',[call(plan.source.address,'0x70a08231'+word(plan.sender),block),block],signal),read('eth_call',[call(plan.source.address,'0xdd62ed3e'+word(plan.sender)+word(spender),block),block],signal)]);
  if(uintWord(decimals)!==BigInt(plan.source.decimals)||uintWord(tokenBalance)<units(plan.amountRaw))fail('EXECUTION_TOKEN_BALANCE_INSUFFICIENT');
  if(!approval&&uintWord(allowance)<units(plan.amountRaw))fail('EXECUTION_APPROVAL_REQUIRED');
 }
 const [simulation,estimate]=await together([read('eth_call',[tx,block],signal),read('eth_estimateGas',[tx,block],signal)]);
 if(typeof simulation!=='string'||!/^0x(?:[0-9a-fA-F]{2})*$/.test(simulation)||approval&&!['0x','0x'+word(1)].includes(simulation)||quantity(estimate)<21000n||quantity(estimate)>quantity(tx.gas))fail('RELAY_PROVIDER_SIMULATION_FAILED');
 const rpcFee=await reserve(chain,read,tx,block,signal),floor=amount(v?.evidence?.providerGasFloorRaw),full=units(v?.evidence?.providerFullGasEstimateRaw),cap=units(action.payload.spending.nativeFeeCapRaw);
 if(floor>full||full===0n||v.feeModel!==chain.feeModel)fail('RELAY_PROVIDER_BINDING_MISMATCH');
 const fee=rpcFee>floor?rpcFee:floor;
 if(fee>cap)fail('EXECUTION_REVIEW_GAS_RESERVE_EXCEEDED');
 const position=plan.actions.findIndex(a=>a.id===action.id),remaining=plan.actions.slice(position).reduce((n,a)=>n+units(a.payload.spending.nativeFeeCapRaw),0n);
 if(quantity(balance)<remaining+(native?units(plan.amountRaw):0n))fail('EXECUTION_NATIVE_BALANCE_INSUFFICIENT');
 await canonicalEnd(read,header,signal,now);return {ready:true};
}
