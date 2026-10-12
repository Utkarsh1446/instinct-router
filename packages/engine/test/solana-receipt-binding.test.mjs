import test from 'node:test';
import assert from 'node:assert/strict';
import {verifySolanaReceiptBinding as verify} from '../src/solana-receipt-binding.mjs';
import {compileProviderSolanaMessage as compile} from '../src/relay-provider-solana.mjs';
import {encodeBase58,decodeBase58} from '../src/solana-message-codec.mjs';
const key=n=>encodeBase58(new Uint8Array(32).fill(n));
const sender=key(1),token=key(2),program=key(3),blockhash=key(4),table=key(5),lighthouse='L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95';
const native=Buffer.from('06040300b032df00000000000403000001000000000000000000','hex'),spl=Buffer.from('0a04030300000600000000000000000508','hex');
const k=(pubkey,isWritable=false,isSigner=false)=>({pubkey,isWritable,isSigner});
const trade={programId:program,keys:[k(sender,true,true),k(token,true)],data:Uint8Array.of(11,22,33)};
const guard=(pubkey,data)=>({programId:lighthouse,keys:[k(pubkey,pubkey===token,pubkey===sender)],data});
function fixture(v0=false,guards=true){
 const tables=v0?[{address:table,addresses:[token,key(7),key(8)]}]:[];
 const reviewed=compile({feePayer:sender,blockhash,instructions:[trade],addressLookupTables:tables});
 const actual=compile({feePayer:sender,blockhash,instructions:[trade,...(guards?[guard(sender,native),guard(token,spl)]:[])],addressLookupTables:tables});
 const actualBytes=decodeBase58(actual.serialized);actualBytes.fill(9,1,65);
 return{transaction:{...reviewed,feePayer:sender,blockhash},actualBytes,signature:encodeBase58(actualBytes.slice(1,65)),sender,sourceIdentity:{tokenAccount:token},meta:{loadedAddresses:{writable:v0?[token]:[],readonly:[]},innerInstructions:[]}};
}
const rejects=f=>assert.throws(()=>verify(f),e=>e.code==='EXECUTION_RECEIPT_BINDING_MISMATCH');
for(const v0 of [false,true]){
 test(`accepts ${v0?'v0':'legacy'} reviewed message fast path without metadata`,()=>{const f=fixture(v0,false);delete f.meta;assert.equal(verify(f).binding,'EXACT_MESSAGE');});
 test(`accepts ${v0?'v0':'legacy'} narrow sender and token guards`,()=>{const result=verify(fixture(v0));assert.equal(result.guardCount,2);assert.ok(result.accounts.includes(token));});
}
test('rejects missing or mismatched metadata on semantic path',()=>{for(const mutation of [f=>delete f.meta.innerInstructions,f=>f.meta.innerInstructions=null,f=>f.meta.loadedAddresses.writable.push(key(6)),f=>f.meta.innerInstructions=[{index:1,instructions:[{}]}],f=>f.meta.innerInstructions=[{index:100,instructions:[]}]]){const f=fixture();mutation(f);rejects(f);}});
test('rejects modified signatures, payer, blockhash, trade, and malformed envelopes',()=>{for(const mutation of [f=>f.actualBytes[1]^=1,f=>f.transaction.feePayer=token,f=>f.transaction.blockhash=token,f=>f.actualBytes[69]^=1,f=>f.actualBytes=f.actualBytes.slice(0,-1),f=>f.actualBytes=Uint8Array.from([...f.actualBytes,0]),f=>f.actualBytes=Uint8Array.from([129,0,...f.actualBytes.slice(1)]),f=>f.transaction.serialized=encodeBase58(Uint8Array.from([1,...new Uint8Array(64).fill(1),...decodeBase58(f.transaction.serialized).slice(65)]))]){const f=fixture();mutation(f);rejects(f);}});
test('rejects altered reviewed instructions and account privileges',()=>{for(const changed of [{...trade,data:Uint8Array.of(11,22,34)},{...trade,keys:[k(sender,true,true),k(token,false)]},{...trade,programId:key(8)},{...trade,keys:[k(sender,true,true),k(key(8),true)]}]){const f=fixture(),built=compile({feePayer:sender,blockhash,instructions:[changed,guard(sender,native)]});f.actualBytes=decodeBase58(built.serialized);f.actualBytes.fill(9,1,65);rejects(f);}});
test('rejects unknown guards, wrong targets, excess and trailing guard data',()=>{for(const extra of [[guard(token,native)],[guard(sender,spl)],[guard(sender,Uint8Array.from([...native,0]))],[guard(sender,Uint8Array.from([5,...native.slice(1)]))],[guard(sender,native),guard(sender,native)],[guard(sender,native),guard(token,spl),guard(sender,native)],[{...guard(sender,native),keys:[k(sender,true,true),k(token,true)]}]]){const f=fixture(),built=compile({feePayer:sender,blockhash,instructions:[trade,...extra]});f.actualBytes=decodeBase58(built.serialized);f.actualBytes.fill(9,1,65);rejects(f);}});
test('rejects unreviewed ALT and false RPC loaded address mapping',()=>{const f=fixture(true);f.transaction.addressLookupTables[0].addresses[0]=key(8);rejects(f);const g=fixture(true);g.meta.loadedAddresses.writable=[key(8)];rejects(g);});
test('accepts v0 readonly ALT reindexing only when resolved instructions are identical',()=>{
 const wire=reversed=>Uint8Array.from([1,...new Uint8Array(64),128,1,0,1,2,...decodeBase58(sender),...decodeBase58(program),...decodeBase58(blockhash),1,1,4,0,2,...(reversed?[4,3]:[3,4]),3,11,22,33,1,...decodeBase58(table),1,0,2,...(reversed?[2,1]:[1,2])]);
 const actualBytes=wire(true);actualBytes.fill(9,1,65);
 const f={transaction:{serialized:encodeBase58(wire(false)),feePayer:sender,blockhash,addressLookupTables:[{address:table,addresses:[token,key(7),key(8)]}]},actualBytes,signature:encodeBase58(actualBytes.slice(1,65)),sender,meta:{loadedAddresses:{writable:[token],readonly:[key(8),key(7)]},innerInstructions:[]}};
 assert.equal(verify(f).binding,'LIGHTHOUSE_GUARDS');f.actualBytes[171]=3;rejects(f);
});
test('rejects changed compute-budget price despite otherwise valid guard suffix',()=>{
 const f=fixture(),budget='ComputeBudget111111111111111111111111111111';
 const ix=data=>({programId:budget,keys:[],data:Uint8Array.from(data)});
 const reviewed=compile({feePayer:sender,blockhash,instructions:[ix([3,0,0,0,0,0,0,0,0]),trade]});
 f.transaction={...reviewed,feePayer:sender,blockhash};f.actualBytes=decodeBase58(compile({feePayer:sender,blockhash,instructions:[ix([3,1,0,0,0,0,0,0,0]),trade,guard(sender,native)]}).serialized);f.actualBytes.fill(9,1,65);rejects(f);
});
test('rejects altered assertion operators, token authority checks, and assertion counts',()=>{
 for(const [original,index,value,target] of [[native,12,0,sender],[native,14,1,sender],[native,17,1,sender],[native,2,4,sender],[spl,4,1,token],[spl,7,1,token],[spl,15,0,token],[spl,16,7,token]]){
  const f=fixture(),data=Uint8Array.from(original);data[index]=value;f.actualBytes=decodeBase58(compile({feePayer:sender,blockhash,instructions:[trade,guard(target,data)]}).serialized);f.actualBytes.fill(9,1,65);rejects(f);
 }
});
test('enforces transaction size, account count, signer count, version, and instruction bounds',()=>{
 for(const mutation of [f=>f.actualBytes=new Uint8Array(1233),f=>f.actualBytes[0]=2,f=>f.actualBytes[65]=129,f=>f.actualBytes[66]=1,f=>f.actualBytes[68]=65]){const f=fixture();mutation(f);rejects(f);}
});
