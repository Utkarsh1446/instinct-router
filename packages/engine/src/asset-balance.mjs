/** Public balance observations only. Configured RPCs; no wallet auth, signing or writes. */
import {ServiceError} from './service.mjs';
import {createProviderTransport} from './relay-provider-transport.mjs';
import {publicExecutionRpc} from './relay-provider-catalog.mjs';
import {decodeBase58,encodeBase58,SYSTEM_PROGRAM,TOKEN_PROGRAM} from './solana-message-codec.mjs';
const TOKEN2022='TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',SOL='solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',ZERO='0x'+'0'.repeat(40);
const fail=(code='BALANCE_UNAVAILABLE',status=503)=>{throw new ServiceError(code,'Public balance is unavailable.',status);};
const integer=v=>{if(!Number.isSafeInteger(v)||v<0)fail();return v;};
function address(chain,value){if(typeof value!=='string')fail('INVALID_BALANCE_REQUEST',400);if(chain.startsWith('eip155:')){if(!/^0x[0-9a-fA-F]{40}$/.test(value))fail('INVALID_BALANCE_REQUEST',400);return value.toLowerCase();}try{decodeBase58(value,32);}catch{fail('INVALID_BALANCE_REQUEST',400);}return value;}
function quantity(value){if(typeof value!=='string'||!/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i.test(value))fail();return BigInt(value);}
function word(value){if(typeof value!=='string'||!/^0x[0-9a-f]{64}$/i.test(value))fail();return BigInt(value);}
function bytes(account){if(!account||account.executable!==false||!Array.isArray(account.data)||account.data.length!==2||account.data[1]!=='base64'||typeof account.data[0]!=='string')fail();const b=Buffer.from(account.data[0],'base64');if(b.length>16384||b.toString('base64')!==account.data[0])fail();return b;}
export function createAssetBalanceReader({chains=[],fetch:wire=globalThis.fetch,now=Date.now,timeoutMs=5000}={}){
 if(!Array.isArray(chains)||chains.length>128||typeof wire!=='function'||typeof now!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw Error('Invalid balance reader configuration');
 const catalog=new Map();for(const raw of chains){const c=structuredClone(raw);if(catalog.has(c.chainId)||!['EVM','SOLANA'].includes(c.vm)||!(c.vm==='EVM'?/^eip155:[1-9][0-9]{0,15}$/.test(c.chainId):c.chainId===SOL)||!Number.isInteger(c.nativeCurrency?.decimals)||c.nativeCurrency.decimals<0||c.nativeCurrency.decimals>255||c.nativeCurrency.address!==(c.vm==='EVM'?ZERO:SYSTEM_PROGRAM)||c.vm==='SOLANA'&&c.nativeCurrency.decimals!==9)throw Error('Invalid balance chain');c.rpcUrl=publicExecutionRpc(c.rpcUrl);if(c.rpcUrls!==undefined&&(!Array.isArray(c.rpcUrls)||!c.rpcUrls.length||c.rpcUrls.length>3))throw Error('Invalid balance RPC fallback');c.rpcUrls=[...new Set([c.rpcUrl,...(c.rpcUrls??[]).map(publicExecutionRpc)])];if(c.rpcUrls.length>3)throw Error('Invalid balance RPC fallback');catalog.set(c.chainId,c);}
 const io=createProviderTransport(wire);let serial=0;
 return Object.freeze({async getAssetBalance(input,parent=new AbortController().signal){
  if(!input||Object.getPrototypeOf(input)!==Object.prototype||Object.keys(input).sort().join(',')!=='address,chainId,owner'||typeof input.chainId!=='string')fail('INVALID_BALANCE_REQUEST',400);
  const c=catalog.get(input.chainId);if(!c)fail('BALANCE_UNSUPPORTED_CHAIN',422);
  const token=address(c.chainId,input.address),owner=address(c.chainId,input.owner);
  const bound=AbortSignal.any([parent,AbortSignal.timeout(timeoutMs)]);
  const deadline=performance.now()+timeoutMs;
  for(let index=0;index<c.rpcUrls.length;index++){
   if(parent.aborted)fail('BALANCE_CANCELLED',499);if(bound.aborted||performance.now()>=deadline)break;
   const attempt=AbortSignal.any([bound,AbortSignal.timeout(Math.max(1,Math.floor((deadline-performance.now())/(c.rpcUrls.length-index))))]);
   try{return await io.run(async signal=>{
   const read=async(method,params)=>{const id=++serial,r=await io.json(c.rpcUrls[index],{jsonrpc:'2.0',id,method,params},signal);if(r?.jsonrpc!=='2.0'||r.id!==id||Object.hasOwn(r,'error')||!Object.hasOwn(r,'result'))fail();return r.result;};
   let balance,decimals;
   if(c.vm==='EVM'){
    const [network,head]=await Promise.all([read('eth_chainId',[]),read('eth_getBlockByNumber',['latest',false])]);
    if(quantity(network)!==BigInt(c.chainId.slice(7))||!/^0x[0-9a-f]{64}$/i.test(head?.hash)||BigInt(head.hash)===0n)fail();const stamp=Number(quantity(head.timestamp))*1000;if(!Number.isSafeInteger(stamp)||stamp<now()-60000||stamp>now()+2000)fail();const block={blockHash:head.hash,requireCanonical:true};
    if(token===ZERO){balance=quantity(await read('eth_getBalance',[owner,block]));decimals=c.nativeCurrency.decimals;}
    else{const call=data=>read('eth_call',[{to:token,data,gas:'0x186a0'},block]);const [code,d,b]=await Promise.all([read('eth_getCode',[token,block]),call('0x313ce567'),call('0x70a08231'+owner.slice(2).padStart(64,'0'))]);if(typeof code!=='string'||!/^0x(?:[0-9a-f]{2}){1,32768}$/i.test(code)||word(d)>255n)fail();decimals=Number(word(d));balance=word(b);}
   }else{
    const [genesis,info]=await Promise.all([read('getGenesisHash',[]),read('getAccountInfo',[token===SYSTEM_PROGRAM?owner:token,{encoding:'base64',commitment:'confirmed'}])]);
    if(genesis!=='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d')fail();const slot=integer(info?.context?.slot);const stamp=integer(await read('getBlockTime',[slot]))*1000;if(stamp<now()-90000||stamp>now()+2000)fail();
    if(token===SYSTEM_PROGRAM){if(info.value!==null){decodeBase58(info.value?.owner,32);if(typeof info.value?.executable!=='boolean')fail();}balance=info.value===null?0n:BigInt(integer(info.value?.lamports));decimals=9;}
    else{const mint=info.value,m=bytes(mint);if(![TOKEN_PROGRAM,TOKEN2022].includes(mint.owner)||m.length<82||m[45]!==1||mint.owner===TOKEN_PROGRAM&&m.length!==82||mint.owner===TOKEN2022&&m.length!==82&&(m.length<166||m[165]!==1))fail();decimals=m[44];const rows=await read('getTokenAccountsByOwner',[owner,{mint:token},{encoding:'base64',commitment:'confirmed',minContextSlot:slot}]);if(integer(rows?.context?.slot)<slot||!Array.isArray(rows.value)||rows.value.length>128)fail();const seen=new Set();balance=0n;for(const row of rows.value){decodeBase58(row.pubkey,32);if(seen.has(row.pubkey))fail();seen.add(row.pubkey);const a=row.account,b=bytes(a);if(a.owner!==mint.owner||b.length<165||a.owner===TOKEN_PROGRAM&&b.length!==165||a.owner===TOKEN2022&&b.length!==165&&(b.length<166||b[165]!==2)||encodeBase58(b.subarray(0,32))!==token||encodeBase58(b.subarray(32,64))!==owner||![1,2].includes(b[108]))fail();balance+=b.readBigUInt64LE(64);}if(balance>=(1n<<256n))fail();}
   }
   const observedAtMs=integer(now());return{chainId:c.chainId,address:token,owner,decimals,balanceRaw:balance.toString(),observedAtMs};
  },attempt);}catch{if(parent.aborted)fail('BALANCE_CANCELLED',499);}
  }
  fail();
 }});
}
