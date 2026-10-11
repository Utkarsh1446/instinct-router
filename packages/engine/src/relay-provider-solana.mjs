/** Provider-managed Solana source preparation. No signing or broadcasting. */
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {encodeBase58,decodeBase58,deriveProgramAddress,SYSTEM_PROGRAM,TOKEN_PROGRAM,ASSOCIATED_TOKEN_PROGRAM} from './solana-message-codec.mjs';
import {ExecutionEngineError} from './base-execution-checks.mjs';
const TOKEN2022='TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',ALT='AddressLookupTab1e1111111111111111111111111',COMPUTE='ComputeBudget111111111111111111111111111111';
function computeBudgetInstructions({units,microLamports}){const limit=Buffer.alloc(5),price=Buffer.alloc(9);limit[0]=2;limit.writeUInt32LE(units,1);price[0]=3;price.writeBigUInt64LE(BigInt(microLamports),1);return[limit,price].map(data=>({programId:COMPUTE,keys:[],data}));}
const fail=code=>{throw new ExecutionEngineError(code??'EXECUTION_EVIDENCE_INVALID');};
const integer=n=>{if(!Number.isSafeInteger(n)||n<0)fail();return n;};
const data=account=>{if(!account||account.executable!==false||!Array.isArray(account.data)||account.data.length!==2||account.data[1]!=='base64'||typeof account.data[0]!=='string')fail();const b=Buffer.from(account.data[0],'base64');if(b.length>16384||b.toString('base64')!==account.data[0])fail();return b;};
async function accountRead(read,address,slot,signal){const result=await read('getAccountInfo',[address,{encoding:'base64',commitment:'finalized',minContextSlot:slot}],signal);if(integer(result?.context?.slot)<slot)fail('EXECUTION_EVIDENCE_STALE');return result.value;}
const short=n=>{const out=[];do{let b=n&127;n>>=7;if(n)b|=128;out.push(b);}while(n);return out;};
const u64=n=>{if(typeof n!=='string'||!/^[1-9][0-9]{0,19}$/.test(n)||BigInt(n)>=(1n<<64n))fail('INVALID_EXECUTION_INPUT');return BigInt(n);};
const sha=b=>createHash('sha256').update(b).digest('hex');
// Mint supply (bytes36..43) changes on ordinary mint/burn activity. Authorities,
// precision, initialized state and all extension bytes remain review-bound.
const mintIdentityHash=bytes=>{const immutable=Buffer.from(bytes);immutable.fill(0,36,44);return sha(immutable);};
function extensions(bytes,kind){
 const size=kind==='mint'?82:165;
 if(bytes.length===size)return [];
 if(bytes.length<166||bytes[165]!== (kind==='mint'?1:2))fail('EXECUTION_TOKEN_BEHAVIOR_UNSUPPORTED');
 const allowed=kind==='mint'?new Set([3,18,19,20,21,22,23]):new Set([7]);
 const result=[];let at=166;
 while(at<bytes.length){if(bytes.subarray(at).every(x=>x===0))break;if(at+4>bytes.length)fail('EXECUTION_TOKEN_BEHAVIOR_UNSUPPORTED');const type=bytes.readUInt16LE(at),length=bytes.readUInt16LE(at+2);at+=4;if(at+length>bytes.length||!allowed.has(type)||result.includes(type))fail('EXECUTION_TOKEN_BEHAVIOR_UNSUPPORTED');if(type===3&&(length!==32||bytes.subarray(at,at+length).some(x=>x!==0)))fail('EXECUTION_TOKEN_BEHAVIOR_UNSUPPORTED');if(type===7&&length!==0)fail('EXECUTION_TOKEN_BEHAVIOR_UNSUPPORTED');result.push(type);at+=length;}
 return result;
}
export function compileProviderSolanaMessage({feePayer,blockhash,instructions,addressLookupTables=[]}){
 decodeBase58(feePayer,32);decodeBase58(blockhash,32);
 if(!Array.isArray(instructions)||!instructions.length||instructions.length>32||!Array.isArray(addressLookupTables)||addressLookupTables.length>32)fail('EXECUTION_PAYLOAD_INVALID');
 const accounts=new Map([[feePayer,{pubkey:feePayer,isSigner:true,isWritable:true}]]),programs=new Set();
 const add=k=>{decodeBase58(k.pubkey,32);if(typeof k.isSigner!=='boolean'||typeof k.isWritable!=='boolean'||k.isSigner&&k.pubkey!==feePayer)fail('EXECUTION_PAYLOAD_INVALID');const old=accounts.get(k.pubkey);accounts.set(k.pubkey,{pubkey:k.pubkey,isSigner:k.isSigner||!!old?.isSigner,isWritable:k.isWritable||!!old?.isWritable});};
 for(const ix of instructions){if(!Array.isArray(ix.keys)||ix.keys.length>64||!(ix.data instanceof Uint8Array)||ix.data.length>1024)fail('EXECUTION_PAYLOAD_INVALID');programs.add(ix.programId);ix.keys.forEach(add);add({pubkey:ix.programId,isSigner:false,isWritable:false});}
 if(accounts.size>64)fail('EXECUTION_PAYLOAD_INVALID');
 const loaded=new Set(),lookups=[];
 for(const table of addressLookupTables){decodeBase58(table.address,32);if(!Array.isArray(table.addresses)||table.addresses.length>256)fail('EXECUTION_PAYLOAD_INVALID');table.addresses.forEach(a=>decodeBase58(a,32));const writable=[],readonly=[];
  table.addresses.forEach((pubkey,index)=>{const key=accounts.get(pubkey);if(key&&!key.isSigner&&!programs.has(pubkey)&&!loaded.has(pubkey)){(key.isWritable?writable:readonly).push(index);loaded.add(pubkey);}});
  if(writable.length||readonly.length)lookups.push({table,writable,readonly});
 }
 const keys=[...accounts.values()].filter(k=>!loaded.has(k.pubkey)).sort((a,b)=>a.pubkey===feePayer?-1:b.pubkey===feePayer?1:Number(b.isWritable)-Number(a.isWritable));
 const resolved=[...keys.map(k=>k.pubkey),...lookups.flatMap(l=>l.writable.map(i=>l.table.addresses[i])),...lookups.flatMap(l=>l.readonly.map(i=>l.table.addresses[i]))];
 const message=[...(lookups.length?[128]:[]),1,0,keys.filter(k=>!k.isSigner&&!k.isWritable).length,...short(keys.length),...keys.flatMap(k=>[...decodeBase58(k.pubkey,32)]),...decodeBase58(blockhash,32),...short(instructions.length)];
 for(const ix of instructions)message.push(resolved.indexOf(ix.programId),...short(ix.keys.length),...ix.keys.map(k=>resolved.indexOf(k.pubkey)),...short(ix.data.length),...ix.data);
 if(lookups.length){message.push(...short(lookups.length));for(const l of lookups)message.push(...decodeBase58(l.table.address,32),...short(l.writable.length),...l.writable,...short(l.readonly.length),...l.readonly);}
 const serialized=Uint8Array.from([1,...new Uint8Array(64),...message]);if(serialized.length>1232)fail('EXECUTION_PAYLOAD_TOO_LARGE');
 return{serialized:encodeBase58(serialized),message:Uint8Array.from(message),addressLookupTables:lookups.map(l=>structuredClone(l.table))};
}
async function snapshot({request,chain,read,signal,now,transaction}){
 const [genesis,latest]=await Promise.all([read('getGenesisHash',[],signal),read('getLatestBlockhash',[{commitment:'finalized'}],signal)]);
 const expected=typeof chain==='string'?chain.slice(7):chain.genesisHash??chain.chainId?.slice(7);if(typeof expected!=='string'||!genesis.startsWith(expected)||expected.length<32)fail('EXECUTION_CHAIN_MISMATCH');
 const slot=integer(latest?.context?.slot),lastValidBlockHeight=integer(latest?.value?.lastValidBlockHeight),blockhash=latest?.value?.blockhash;decodeBase58(blockhash,32);
 const time=integer(await read('getBlockTime',[slot],signal));if(time*1000<now()-90000||time*1000>now()+15000)fail('EXECUTION_EVIDENCE_STALE');
 const wallet=await accountRead(read,request.sender,slot,signal);
 if(!wallet||wallet.owner!==SYSTEM_PROGRAM||data(wallet).length!==0)fail('EXECUTION_WALLET_UNSUPPORTED');const balance=BigInt(integer(wallet.lamports));
 let identity={kind:'NATIVE',address:request.source.address,decimals:9},tokenAddress,tokenBalance;
 if(request.source.address===SYSTEM_PROGRAM){if(request.source.decimals!==9)fail('EXECUTION_BINDING_MISMATCH');}
 else {
  const mint=await accountRead(read,request.source.address,slot,signal),bytes=data(mint);
  if(![TOKEN_PROGRAM,TOKEN2022].includes(mint.owner)||bytes.length<82||bytes[45]!==1||bytes[44]!==request.source.decimals)fail('EXECUTION_TOKEN_BEHAVIOR_UNSUPPORTED');
  const mintExtensions=mint.owner===TOKEN2022?extensions(bytes,'mint'):bytes.length===82?[]:fail('EXECUTION_TOKEN_BEHAVIOR_UNSUPPORTED');
  tokenAddress=(await deriveProgramAddress([decodeBase58(request.sender,32),decodeBase58(mint.owner,32),decodeBase58(request.source.address,32)],ASSOCIATED_TOKEN_PROGRAM)).address;
  const token=await accountRead(read,tokenAddress,slot,signal),t=data(token);
  if(token.owner!==mint.owner||t.length<165||encodeBase58(t.subarray(0,32))!==request.source.address||encodeBase58(t.subarray(32,64))!==request.sender||t[108]!==1||t.readUInt32LE(72)!==0||t.readUInt32LE(109)!==0||t.readUInt32LE(129)!==0||t.readBigUInt64LE(64)<u64(request.amountRaw))fail('EXECUTION_TOKEN_BALANCE_INSUFFICIENT');
  tokenBalance=t.readBigUInt64LE(64);
  const accountExtensions=mint.owner===TOKEN2022?extensions(t,'account'):t.length===165?[]:fail('EXECUTION_TOKEN_BEHAVIOR_UNSUPPORTED');
  identity={kind:'TOKEN',address:request.source.address,decimals:request.source.decimals,tokenProgram:mint.owner,mintSha256:mintIdentityHash(bytes),mintExtensions,accountExtensions,tokenAccount:tokenAddress};
 }
 return{slot,blockhash,lastValidBlockHeight,balance,identity,tokenAddress,tokenBalance};
}
async function simulation({request,transaction,state,read,signal}){
 const wire=decodeBase58(transaction.serialized),message=wire.slice(65),config={commitment:'finalized',minContextSlot:state.slot};
 const [fee,sim,valid,height]=await Promise.all([read('getFeeForMessage',[Buffer.from(message).toString('base64'),config],signal),read('simulateTransaction',[Buffer.from(wire).toString('base64'),{...config,encoding:'base64',sigVerify:false,replaceRecentBlockhash:false,accounts:{encoding:'base64',addresses:[request.sender,...(state.tokenAddress?[state.tokenAddress]:[])]}}],signal),read('isBlockhashValid',[transaction.blockhash,config],signal),read('getBlockHeight',[config],signal)]);
 if(valid?.value!==true||integer(height)>transaction.lastValidBlockHeight)fail('EXECUTION_REVIEW_EXPIRED');if(fee?.value===null||integer(fee?.context?.slot)<state.slot||integer(sim?.context?.slot)<state.slot||sim.value?.err!==null)fail('EXECUTION_SIMULATION_FAILED');
 const amount=u64(request.amountRaw),feeRaw=BigInt(integer(fee.value)),post=sim.value.accounts;
 if(!Array.isArray(post)||post.length!==(state.tokenAddress?2:1)||!post[0])fail('EXECUTION_SIMULATION_FAILED');
 const after=BigInt(integer(post[0].lamports));if(after>state.balance)fail('EXECUTION_SPENDING_MISMATCH');const loss=state.balance-after,sourceNative=request.source.address===SYSTEM_PROGRAM;
 if(sourceNative&&loss<amount)fail('EXECUTION_SPENDING_MISMATCH');
 if(state.tokenAddress){const t=post[1]&&data(post[1]);if(!t||t.length<165||post[1].owner!==state.identity.tokenProgram||t[108]!==1||t.readUInt32LE(72)!==0||t.readUInt32LE(109)!==0||t.readUInt32LE(129)!==0||encodeBase58(t.subarray(0,32))!==request.source.address||encodeBase58(t.subarray(32,64))!==request.sender)fail('EXECUTION_SPENDING_MISMATCH');if(state.tokenBalance-t.readBigUInt64LE(64)!==amount)fail('EXECUTION_SPENDING_MISMATCH');}
 const costs=loss-(sourceNative?amount:0n);if(costs<0n||costs<feeRaw)fail('EXECUTION_SPENDING_MISMATCH');const reserve=(costs*125n+99n)/100n;
 if(state.balance<(sourceNative?amount:0n)+reserve)fail('EXECUTION_NATIVE_BALANCE_INSUFFICIENT');return{feeCapRaw:reserve.toString(),nativeValueRaw:sourceNative?request.amountRaw:'0',evidence:{slot:state.slot,feeRaw:feeRaw.toString(),simulatedNativeCostRaw:costs.toString(),unitsConsumed:integer(sim.value.unitsConsumed)}};
}
export async function prepareSolana({request,rawTransaction,chain,read,signal,now=Date.now,expiresAtMs}){
 if(typeof read!=='function'||now()>=expiresAtMs||!rawTransaction||Object.keys(rawTransaction).some(key=>!['instructions','addressLookupTableAddresses'].includes(key))||!Array.isArray(rawTransaction.instructions)||rawTransaction.instructions.length>30)fail('EXECUTION_PAYLOAD_INVALID');u64(request.amountRaw);
 let instructions=rawTransaction.instructions.map(ix=>{if(!ix||Object.keys(ix).sort().join(',')!=='data,keys,programId'||typeof ix.data!=='string'||! /^(?:[0-9a-fA-F]{2}){0,1024}$/.test(ix.data))fail('EXECUTION_PAYLOAD_INVALID');return{programId:ix.programId,keys:structuredClone(ix.keys),data:Uint8Array.from(Buffer.from(ix.data,'hex'))};});
 const state=await snapshot({request,chain,read,signal,now});
 const priorities=instructions.filter(ix=>ix.programId===COMPUTE),automaticBudget=!priorities.length;let automaticPrice='0';if(automaticBudget){const fees=await read('getRecentPrioritizationFees',[[]],signal);if(!Array.isArray(fees)||fees.length>256)fail();const recent=fees.filter(row=>integer(row.slot)>=state.slot-200).map(row=>integer(row.prioritizationFee)).sort((a,b)=>a-b),price=recent.length?recent[Math.floor((recent.length-1)*.75)]:0;automaticPrice=String(price);instructions=[...computeBudgetInstructions({units:1400000,microLamports:automaticPrice}),...instructions];}
 else if(priorities.length!==2||priorities.some(ix=>ix.keys.length!==0)||priorities.filter(ix=>ix.data[0]===2&&ix.data.length===5&&Buffer.from(ix.data).readUInt32LE(1)>0&&Buffer.from(ix.data).readUInt32LE(1)<=1400000).length!==1||priorities.filter(ix=>ix.data[0]===3&&ix.data.length===9).length!==1)fail('EXECUTION_PAYLOAD_INVALID');
 const addresses=rawTransaction.addressLookupTableAddresses??[];if(!Array.isArray(addresses)||addresses.length>32||new Set(addresses).size!==addresses.length)fail('EXECUTION_PAYLOAD_INVALID');
 const tables=[];for(const address of addresses){decodeBase58(address,32);const value=await accountRead(read,address,state.slot,signal),bytes=data(value);if(value.owner!==ALT||bytes.length<56||(bytes.length-56)%32||bytes.readUInt32LE(0)!==1||bytes.readBigUInt64LE(4)!==((1n<<64n)-1n)||bytes.readBigUInt64LE(12)>=BigInt(state.slot))fail('EXECUTION_LOOKUP_TABLE_INVALID');tables.push({address,addresses:Array.from({length:(bytes.length-56)/32},(_,i)=>encodeBase58(bytes.subarray(56+i*32,88+i*32)))});}
 const build=()=>{const compiled=compileProviderSolanaMessage({feePayer:request.sender,blockhash:state.blockhash,instructions,addressLookupTables:tables});return{serialized:compiled.serialized,feePayer:request.sender,blockhash:state.blockhash,lastValidBlockHeight:state.lastValidBlockHeight,...(compiled.addressLookupTables.length?{addressLookupTables:compiled.addressLookupTables}:{})};};
 let transaction=build(),checked=await simulation({request,transaction,state,read,signal});
 if(automaticBudget){const consumed=checked.evidence.unitsConsumed;if(consumed<=0||consumed>1400000)fail('EXECUTION_SIMULATION_FAILED');const units=Math.min(1400000,Math.ceil(consumed*1.2)+10000);instructions=[...computeBudgetInstructions({units,microLamports:automaticPrice}),...instructions.slice(2)];transaction=build();checked=await simulation({request,transaction,state,read,signal});if(checked.evidence.unitsConsumed>units)fail('EXECUTION_SIMULATION_FAILED');}
 const budget=request.nativeFeeBudgets?.find(row=>row.chainId===request.source.chainId);if(!budget||budget.maxAmountRaw!==null&&(typeof budget.maxAmountRaw!=='string'||! /^[0-9]+$/.test(budget.maxAmountRaw)||BigInt(budget.maxAmountRaw)<BigInt(checked.evidence.simulatedNativeCostRaw)))fail('EXECUTION_NATIVE_BUDGET_EXCEEDED');if(budget.maxAmountRaw!==null&&BigInt(budget.maxAmountRaw)<BigInt(checked.feeCapRaw))checked.feeCapRaw=budget.maxAmountRaw;return{transaction,...checked,sourceIdentity:state.identity};
}
export async function preflightSolana({plan,action,chain,read,signal,now=Date.now}){
 if(now()>=plan.expiresAtMs)fail('EXECUTION_REVIEW_EXPIRED');const transaction=action.payload.transaction,state=await snapshot({request:plan,chain,read,signal,now});
 if(!isDeepStrictEqual(state.identity,action.payload.validation?.sourceIdentity))fail('EXECUTION_TOKEN_IDENTITY_MISMATCH');
 for(const table of transaction.addressLookupTables??[]){const value=await accountRead(read,table.address,state.slot,signal),bytes=data(value);if(value.owner!==ALT||bytes.length<56||(bytes.length-56)%32||bytes.readUInt32LE(0)!==1||bytes.readBigUInt64LE(12)>=BigInt(state.slot)||bytes.readBigUInt64LE(4)!==((1n<<64n)-1n)||table.addresses.some((address,i)=>encodeBase58(bytes.subarray(56+32*i,88+32*i))!==address))fail('EXECUTION_LOOKUP_TABLE_INVALID');}
 const fresh=await simulation({request:plan,transaction,state,read,signal});if(BigInt(fresh.evidence.simulatedNativeCostRaw)>BigInt(action.payload.spending.nativeFeeCapRaw))fail('EXECUTION_REVIEW_GAS_RESERVE_EXCEEDED');return{ready:true};
}
