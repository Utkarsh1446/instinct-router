/** Observed ERC20 identity, not a claim that arbitrary bytecode is trustworthy. */
import { createHash } from 'node:crypto';
import { baseExecutionPrimitives as p } from './base-readiness.mjs';
import { fail } from './base-execution-checks.mjs';
const canonical=value=>value && typeof value==='object' ? Array.isArray(value) ? '['+value.map(canonical).join(',')+']' : '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}' : JSON.stringify(value);
const SLOT='0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const hash=code=>{
  if(typeof code!=='string'||!/^0x(?:[a-f0-9]{2}){1,32768}$/i.test(code))fail('EXECUTION_TOKEN_UNSUPPORTED');
  return createHash('sha256').update(Buffer.from(code.slice(2),'hex')).digest('hex');
};
export async function tokenIdentity(read,source,block,signal,expected) {
  const [code,decimals,implementation]=await read([
    {method:'eth_getCode',params:[source.address,block]},p.call(source.address,'0x313ce567',block),
    {method:'eth_getStorageAt',params:[source.address,SLOT,block]},
  ],signal);
  if(p.integerWord(decimals)!==BigInt(source.decimals)||!/^0x0{24}[a-f0-9]{40}$/i.test(implementation))fail('EXECUTION_TOKEN_UNSUPPORTED');
  const address='0x'+implementation.slice(-40).toLowerCase();
  const identity={address:source.address,decimals:source.decimals,codeSha256:hash(code)};
  if(BigInt(address)!==0n){
    const [implementationCode]=await read([{method:'eth_getCode',params:[address,block]}],signal);
    identity.implementation={slot:SLOT,address,codeSha256:hash(implementationCode)};
  }
  if(expected&&canonical(identity)!==canonical(expected))fail('EXECUTION_TOKEN_IDENTITY_CHANGED');
  return identity;
}
const TRANSFER='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const word=address=>'0x'+address.slice(2).padStart(64,'0').toLowerCase();
export function exactTokenDeposit(logs,receipt,source,sender,depository,amount) {
  const matches=logs.filter(log=>log.address?.toLowerCase()===source.address.toLowerCase() && log.topics?.[0]?.toLowerCase()===TRANSFER);
  const incoming=matches.filter(log=>log.topics?.[2]?.toLowerCase()===word(depository));
  const outgoing=matches.filter(log=>log.topics?.[1]?.toLowerCase()===word(sender));
  if(incoming.length!==1||outgoing.length!==1||incoming[0]!==outgoing[0])fail('EXECUTION_TOKEN_TRANSFER_MISMATCH');
  const log=incoming[0];
  if(log.topics.length!==3||log.removed!==false||log.transactionHash?.toLowerCase()!==receipt.transactionHash.toLowerCase()||
    log.blockHash?.toLowerCase()!==receipt.blockHash.toLowerCase()||log.blockNumber!==receipt.blockNumber||
    !/^0x[a-f0-9]{64}$/i.test(log.data)||BigInt(log.data)!==BigInt(amount))fail('EXECUTION_TOKEN_TRANSFER_MISMATCH');
}
