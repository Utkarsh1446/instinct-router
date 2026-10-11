/** Pure local Relay Solana deposit recipe. Source ABI: relayprotocol/relay-settlement,
 * programs/relay-depository/src/lib.rs (deposit_native / deposit_token). */
import { encodeBase58,decodeBase58,encodeLegacyMessage,decodeLegacyMessage,deriveProgramAddress,deriveAssociatedTokenAddress,TOKEN_PROGRAM,ASSOCIATED_TOKEN_PROGRAM,SYSTEM_PROGRAM } from './solana-message-codec.js';
export const RELAY_SOLANA_PROGRAM='99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2';
export const SOLANA_CHAIN='solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const fail=()=>{throw new Error('RELAY_SOLANA_MESSAGE_MISMATCH');};
export async function relaySolanaInstruction({sender,mint,amountRaw,orderId}){
  decodeBase58(sender,32);decodeBase58(mint,32);
  if(typeof amountRaw!=='string'||!/^[1-9][0-9]{0,19}$/.test(amountRaw)||BigInt(amountRaw)>=(1n<<64n)||!/^0x[0-9a-f]{64}$/.test(orderId))fail();
  const config=await deriveProgramAddress([new TextEncoder().encode('relay_depository')],RELAY_SOLANA_PROGRAM);
  const vault=await deriveProgramAddress([new TextEncoder().encode('vault')],RELAY_SOLANA_PROGRAM);
  const native=mint===SYSTEM_PROGRAM, keys=[];
  const add=(pubkey,isWritable=false,isSigner=false)=>keys.push({pubkey,isWritable,isSigner});
  add(config.address);add(sender,true,true);add(sender);add(vault.address,native);
  if(!native){add(mint);add(await deriveAssociatedTokenAddress(sender,mint),true);add(await deriveAssociatedTokenAddress(vault.address,mint),true);add(TOKEN_PROGRAM);add(ASSOCIATED_TOKEN_PROGRAM);}
  add(SYSTEM_PROGRAM);
  const data=new Uint8Array(48), discriminator=native?'0d9e0ddf5fd51c06':'0b9c60da27a3b413';
  data.set(discriminator.match(/../g).map(v=>parseInt(v,16)));let n=BigInt(amountRaw);for(let i=8;i<16;i++){data[i]=Number(n&255n);n>>=8n;}
  data.set(orderId.slice(2).match(/../g).map(v=>parseInt(v,16)),16);
  return{programId:RELAY_SOLANA_PROGRAM,keys,data};
}
export function computeBudgetInstructions(budget){
  if(!budget||Object.keys(budget).sort().join(',')!=='microLamports,units'||budget.units!==200000||typeof budget.microLamports!=='string'||!/^(0|[1-9][0-9]{0,15})$/.test(budget.microLamports)||!Number.isSafeInteger(Number(budget.microLamports)))fail();
  const limit=new Uint8Array(5);limit[0]=2;new DataView(limit.buffer).setUint32(1,budget.units,true);
  const price=new Uint8Array(9);price[0]=3;new DataView(price.buffer).setBigUint64(1,BigInt(budget.microLamports),true);
  return [limit,price].map(data=>({programId:'ComputeBudget111111111111111111111111111111',keys:[],data}));
}
export async function validateRelaySolanaAction(plan,action){
  if(plan.source?.chainId!==SOLANA_CHAIN||action.id!=='relay-solana-deposit'||action.chainId!==SOLANA_CHAIN||action.payload?.type!=='SOLANA_TRANSACTION'||plan.actions?.length!==1||plan.actions[0].id!==action.id)fail();
  const t=action.payload.transaction,meta=action.payload.relay;
  if(!t||Object.keys(t).sort().join(',')!=='blockhash,feePayer,lastValidBlockHeight,message'||t.feePayer!==plan.sender||!Number.isSafeInteger(t.lastValidBlockHeight)||t.lastValidBlockHeight<1||!meta||!/^0x[0-9a-f]{64}$/.test(meta.orderId)||typeof meta.requestId!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(meta.requestId)||plan.quoteIds?.length!==1||plan.quoteIds[0]!=='relay:'+meta.requestId)fail();
  const ix=await relaySolanaInstruction({sender:plan.sender,mint:plan.source.address,amountRaw:plan.amountRaw,orderId:meta.orderId});
  if(encodeLegacyMessage({feePayer:plan.sender,blockhash:t.blockhash,instructions:[...computeBudgetInstructions(meta.computeBudget),ix]})!==t.message)fail();
  return decodeLegacyMessage(t.message);
}
