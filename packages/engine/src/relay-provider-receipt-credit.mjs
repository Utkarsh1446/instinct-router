/** Canonical transaction-local credits. Provider status supplies association, never the amount. */
import {fail} from './base-execution-checks.mjs';
import {decodeBase58,SYSTEM_PROGRAM,TOKEN_PROGRAM} from './solana-message-codec.mjs';
const TOKEN2022='TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const eq=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
export function quantity(value){if(typeof value!=='string'||!/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)||value.length>66)fail('EXECUTION_EVIDENCE_INVALID');return BigInt(value);}
export function amount(value){if(typeof value!=='string'||!/^(0|[1-9][0-9]{0,77})$/.test(value)||BigInt(value)>=(1n<<256n))fail('EXECUTION_EVIDENCE_INVALID');return BigInt(value);}
export function signature(value,size){try{decodeBase58(value,size);return true;}catch{return false;}}
export function hashFor(vm,value,block=false){return vm==='EVM'?typeof value==='string'&&/^0x[0-9a-f]{64}$/i.test(value):signature(value,block?32:64);}
const addressTopic=v=>'0x'+v.slice(2).toLowerCase().padStart(64,'0');
export function evmTokenCredit(receipt,asset,recipient){
 if(!Array.isArray(receipt.logs)||receipt.logs.length>2048)fail('DESTINATION_EVIDENCE_INVALID');
 let net=0n;const indices=new Set();
 for(const log of receipt.logs){if(!eq(log.address,asset.address))continue;
  if(!Array.isArray(log.topics)||log.topics[0]?.toLowerCase()!=='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef')continue;
  if(log.removed!==false||!eq(log.transactionHash,receipt.transactionHash)||!eq(log.blockHash,receipt.blockHash)||log.blockNumber!==receipt.blockNumber||log.topics.length!==3||log.topics.some(t=>!/^0x[0-9a-f]{64}$/i.test(t))||!/^0x[0-9a-f]{64}$/i.test(log.data))fail('DESTINATION_EVIDENCE_INVALID');
  const index=quantity(log.logIndex);if(indices.has(index))fail('DESTINATION_EVIDENCE_INVALID');indices.add(index);
  const n=BigInt(log.data);if(eq(log.topics[2],addressTopic(recipient)))net+=n;if(eq(log.topics[1],addressTopic(recipient)))net-=n;
 }
 return net;
}
/** Includes only successful value movements; excludes reverted descendants and delegate/static calls. */
export function evmNativeTraceCredit(trace,tx,recipient){
 if(!trace||!eq(trace.from,tx.from)||!eq(trace.to,tx.to)||!eq(trace.input??'0x',tx.input)||quantity(trace.value??'0x0')!==quantity(tx.value))fail('DESTINATION_EVIDENCE_INVALID');
 let seen=0,net=0n;const visit=(node,depth)=>{if(++seen>512||depth>16||!node||typeof node!=='object')fail('DESTINATION_EVIDENCE_INVALID');if(node.error)return;
  const type=String(node.type).toUpperCase();if(['CALL','CREATE','CREATE2','SELFDESTRUCT'].includes(type)){const n=quantity(node.value??'0x0');if(eq(node.to,recipient))net+=n;if(eq(node.from,recipient))net-=n;}
  if(node.calls!==undefined&&!Array.isArray(node.calls))fail('DESTINATION_EVIDENCE_INVALID');for(const child of node.calls??[])visit(child,depth+1);
 };visit(trace,0);return net;
}
export function solanaCredit(transaction,asset,recipient){
 const message=transaction?.transaction?.message,meta=transaction?.meta,keys=message?.accountKeys;
 if(!Array.isArray(keys)||keys.length>256||!meta||meta.err!==null)fail('DESTINATION_EVIDENCE_INVALID');
 const addresses=keys.map(k=>typeof k==='string'?k:k?.pubkey);if(addresses.some(a=>!signature(a,32))||new Set(addresses).size!==addresses.length)fail('DESTINATION_EVIDENCE_INVALID');
 if(asset.address===SYSTEM_PROGRAM){if(asset.decimals!==9)fail('DESTINATION_EVIDENCE_INVALID');const index=addresses.indexOf(recipient);if(index<0)return 0n;const balance=v=>{if(!Number.isSafeInteger(v)||v<0)fail('DESTINATION_EVIDENCE_INVALID');return BigInt(v);};return balance(meta.postBalances?.[index])-balance(meta.preBalances?.[index]);}
 let net=0n;for(const [rows,sign]of[[meta.preTokenBalances,-1n],[meta.postTokenBalances,1n]]){if(!Array.isArray(rows)||rows.length>256)fail('DESTINATION_EVIDENCE_INVALID');const indices=new Set();for(const row of rows){if(!Number.isSafeInteger(row.accountIndex)||row.accountIndex<0||row.accountIndex>=addresses.length||indices.has(row.accountIndex))fail('DESTINATION_EVIDENCE_INVALID');indices.add(row.accountIndex);if(row.mint!==asset.address||row.owner!==recipient)continue;if(![TOKEN_PROGRAM,TOKEN2022].includes(row.programId)||row.uiTokenAmount?.decimals!==asset.decimals)fail('DESTINATION_EVIDENCE_INVALID');const n=amount(row.uiTokenAmount.amount);if(n>=(1n<<64n))fail('DESTINATION_EVIDENCE_INVALID');net+=sign*n;}}
 return net;
}
