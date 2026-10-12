/** Bounded receipt binding: reviewed instructions may only gain explicit, non-CPI account assertions. */
import {fail} from './base-execution-checks.mjs';
import {decodeBase58,encodeBase58} from './solana-message-codec.mjs';
const LIGHTHOUSE='L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95';
const mismatch=()=>fail('EXECUTION_RECEIPT_BINDING_MISMATCH');
const equal=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
function parse(bytes){
 if(!(bytes instanceof Uint8Array)||bytes.length>1232)mismatch();
 let at=0;const take=n=>{if(n<0||at+n>bytes.length)mismatch();const value=bytes.slice(at,at+n);at+=n;return value;};
 const short=()=>{let value=0,shift=0,b,count=0;do{b=take(1)[0];value+=(b&127)*2**shift;shift+=7;if(++count>3)mismatch();}while(b&128);if(value>1232||count>1&&(b&127)===0)mismatch();return value;};
 if(short()!==1)mismatch();const signature=take(64),message=bytes.slice(at);
 let version='legacy',header=take(1)[0];if(header&128){if(header!==128)mismatch();version=0;header=take(1)[0];}
 const readonlySigned=take(1)[0],readonlyUnsigned=take(1)[0],count=short();
 if(header!==1||readonlySigned!==0||count<1||count>64||readonlyUnsigned>count-1)mismatch();
 const staticKeys=Array.from({length:count},(_,i)=>({pubkey:encodeBase58(take(32)),isSigner:i===0,isWritable:i<count-readonlyUnsigned}));
 const blockhash=encodeBase58(take(32)),instructionCount=short();if(!instructionCount||instructionCount>32)mismatch();
 const instructions=Array.from({length:instructionCount},()=>{const program=take(1)[0],length=short();if(length>64)mismatch();const accounts=[...take(length)],size=short();return{program,accounts,data:take(size)};});
 const lookups=[];if(version===0){const length=short();if(length>32)mismatch();for(let i=0;i<length;i++){const address=encodeBase58(take(32)),w=short();if(w>64)mismatch();const writable=[...take(w)],r=short();if(r>64)mismatch();lookups.push({address,writable,readonly:[...take(r)]});}}
 const total=count+lookups.reduce((n,l)=>n+l.writable.length+l.readonly.length,0);
 if(at!==bytes.length||total>64||new Set(staticKeys.map(k=>k.pubkey)).size!==count||new Set(lookups.map(l=>l.address)).size!==lookups.length||instructions.some(ix=>ix.program>=total||ix.accounts.some(i=>i>=total)))mismatch();
 return{signature,message,version,staticKeys,blockhash,instructions,lookups};
}
function resolve(parsed,tables){
 if(!Array.isArray(tables)||tables.length>32)mismatch();const byAddress=new Map();
 for(const table of tables){decodeBase58(table.address,32);if(byAddress.has(table.address)||!Array.isArray(table.addresses)||table.addresses.length>256)mismatch();table.addresses.forEach(a=>decodeBase58(a,32));byAddress.set(table.address,table.addresses);}
 const loaded={writable:[],readonly:[]};
 for(const lookup of parsed.lookups){const addresses=byAddress.get(lookup.address);if(!addresses||new Set([...lookup.writable,...lookup.readonly]).size!==lookup.writable.length+lookup.readonly.length)mismatch();for(const kind of ['writable','readonly'])for(const i of lookup[kind]){if(i>=addresses.length)mismatch();loaded[kind].push(addresses[i]);}}
 const keys=[...parsed.staticKeys,...loaded.writable.map(pubkey=>({pubkey,isSigner:false,isWritable:true})),...loaded.readonly.map(pubkey=>({pubkey,isSigner:false,isWritable:false}))];
 if(new Set(keys.map(k=>k.pubkey)).size!==keys.length)mismatch();
 return{loaded,keys,instructions:parsed.instructions.map(ix=>({program:keys[ix.program],accounts:ix.accounts.map(i=>keys[i]),data:ix.data}))};
}
const sameKey=(a,b)=>a.pubkey===b.pubkey&&a.isSigner===b.isSigner&&a.isWritable===b.isWritable;
function assertion(data,target,sender,sourceIdentity){
 // Pin the observed Lighthouse multi-assertion schemas, including operators and values.
 // u64 lamports threshold may vary with the wallet balance; it only asserts a lower bound.
 if(data[0]===6&&target===sender&&data.length===26&&equal(data.slice(0,4),[6,4,3,0])&&equal(data.slice(12),[4,3,0,0,1,0,0,0,0,0,0,0,0,0]))return;
 if(data[0]===10&&target===sourceIdentity?.tokenAccount&&data.length===17&&equal(data,[10,4,3,3,0,0,6,0,0,0,0,0,0,0,0,5,8]))return;
 mismatch();
}
export function verifySolanaReceiptBinding({transaction,actualBytes,signature,sender,meta,sourceIdentity}={}){
 try{
  if(!transaction||transaction.feePayer!==sender)mismatch();decodeBase58(sender,32);decodeBase58(signature,64);
  const expected=parse(decodeBase58(transaction.serialized)),actual=parse(actualBytes);
  if(expected.signature.some(v=>v!==0)||encodeBase58(actual.signature)!==signature||expected.staticKeys[0].pubkey!==sender||actual.staticKeys[0].pubkey!==sender||expected.blockhash!==transaction.blockhash||actual.blockhash!==expected.blockhash||actual.version!==expected.version)mismatch();
  // Metadata is unnecessary when the entire message is unchanged.
  if(equal(actual.message,expected.message))return{binding:'EXACT_MESSAGE'};
  const reviewed=resolve(expected,transaction.addressLookupTables??[]),signed=resolve(actual,transaction.addressLookupTables??[]);
  if(!meta?.loadedAddresses||!Array.isArray(meta.loadedAddresses.writable)||!Array.isArray(meta.loadedAddresses.readonly)||!equal(meta.loadedAddresses.writable,signed.loaded.writable)||!equal(meta.loadedAddresses.readonly,signed.loaded.readonly)||!Array.isArray(meta.innerInstructions))mismatch();
  const original=new Map(reviewed.keys.map(k=>[k.pubkey,k]));for(const k of reviewed.keys){const other=signed.keys.find(a=>a.pubkey===k.pubkey);if(!other||!sameKey(k,other))mismatch();}
  for(const k of signed.keys)if(!original.has(k.pubkey)&&(k.pubkey!==LIGHTHOUSE||k.isSigner||k.isWritable))mismatch();
  const count=reviewed.instructions.length,guards=signed.instructions.slice(count);if(guards.length>2)mismatch();
  for(let i=0;i<count;i++){const a=reviewed.instructions[i],b=signed.instructions[i];if(!b||!sameKey(a.program,b.program)||a.accounts.length!==b.accounts.length||!a.accounts.every((k,j)=>sameKey(k,b.accounts[j]))||!equal(a.data,b.data))mismatch();}
  const seen=new Set();for(const guard of guards){if(guard.program.pubkey!==LIGHTHOUSE||guard.program.isSigner||guard.program.isWritable||guard.accounts.length!==1||!original.has(guard.accounts[0].pubkey))mismatch();assertion(guard.data,guard.accounts[0].pubkey,sender,sourceIdentity);if(seen.has(guard.accounts[0].pubkey))mismatch();seen.add(guard.accounts[0].pubkey);}
  const innerSeen=new Set();for(const inner of meta.innerInstructions){if(!Number.isSafeInteger(inner?.index)||inner.index<0||inner.index>=signed.instructions.length||innerSeen.has(inner.index)||!Array.isArray(inner.instructions)||inner.instructions.length>64||inner.index>=count&&inner.instructions.length)mismatch();innerSeen.add(inner.index);}
  return{binding:'LIGHTHOUSE_GUARDS',guardCount:guards.length,accounts:signed.keys.map(k=>k.pubkey)};
 }catch(error){if(error?.code==='EXECUTION_RECEIPT_BINDING_MISMATCH')throw error;mismatch();}
}
