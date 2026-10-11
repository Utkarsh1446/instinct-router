import {decodeBase58,encodeBase58} from './solana-message-codec.js';
const fail=()=>{throw Error('INVALID_UNSIGNED_SOLANA_TRANSACTION');};
/** Parse a full unsigned legacy/v0 transaction. No signing, RPC or arbitrary execution. */
export function decodeUnsignedSolanaTransaction(transaction){
 if(!transaction||Object.keys(transaction).some(key=>!['serialized','blockhash','lastValidBlockHeight','feePayer','addressLookupTables'].includes(key))||!Number.isSafeInteger(transaction.lastValidBlockHeight)||transaction.lastValidBlockHeight<1)fail();
 const bytes=decodeBase58(transaction.serialized);let at=0;
 const take=n=>{if(at+n>bytes.length)fail();const out=bytes.slice(at,at+n);at+=n;return out;};
 const short=()=>{let n=0,shift=0,count=0,b;do{b=take(1)[0];n|=(b&127)<<shift;shift+=7;count++;if(count>3)fail();}while(b&128);if(n>1232||count>1&&n<128**(count-1))fail();return n;};
 if(short()!==1||take(64).some(byte=>byte!==0))fail();
 const first=take(1)[0],version=first===128?0:'legacy';if(first&128&&first!==128)fail();
 const signatures=version===0?take(1)[0]:first,readonlySigned=take(1)[0],readonlyUnsigned=take(1)[0],length=short();
 if(signatures!==1||readonlySigned!==0||length<1||length>64||readonlyUnsigned>=length)fail();
 const accounts=Array.from({length},()=>encodeBase58(take(32)));if(new Set(accounts).size!==length)fail();
 const blockhash=encodeBase58(take(32)),count=short();if(!count||count>32)fail();
 const instructions=Array.from({length:count},()=>{const programIdIndex=take(1)[0],n=short();if(n>64)fail();const accountIndices=[...take(n)],size=short();return{programIdIndex,accountIndices,data:take(size)};});
 const tables=transaction.addressLookupTables??[],lookups=[];let loaded=0;
 if(!Array.isArray(tables)||tables.length>32)fail();
 if(version===0){const n=short();if(n!==tables.length)fail();for(let i=0;i<n;i++){
  const address=encodeBase58(take(32)),writable=[...take(short())],readonly=[...take(short())],table=tables[i];
  if(!table||Object.keys(table).sort().join(',')!=='address,addresses'||table.address!==address||!Array.isArray(table.addresses)||table.addresses.length>256||new Set([...writable,...readonly]).size!==writable.length+readonly.length)fail();
  table.addresses.forEach(key=>decodeBase58(key,32));if([...writable,...readonly].some(index=>index>=table.addresses.length))fail();
  loaded+=writable.length+readonly.length;lookups.push({address,writable,readonly});
 }}else if(tables.length)fail();
 if(at!==bytes.length||length+loaded>64||instructions.some(ix=>ix.programIdIndex>=length+loaded||ix.accountIndices.some(index=>index>=length+loaded))||accounts[0]!==transaction.feePayer||blockhash!==transaction.blockhash)fail();
 return{version,feePayer:accounts[0],blockhash,accounts,instructions,lookups};
}
