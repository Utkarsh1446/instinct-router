/** Conservative no-send proof for an expired, unsubmitted Solana wallet envelope.
 * RPC history is trusted canonical evidence, as with transaction reconciliation.
 * Empty/pruned history is not absence proof: an older finalized anchor is required.
 */
import {createReceiptIo} from './relay-provider-receipt-io.mjs';
import {decodeBase58,encodeBase58} from './solana-message-codec.mjs';
import {fail} from './base-execution-checks.mjs';
import {canonical,sha} from './relay-provider-terms.mjs';
const CHAIN='solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',GENESIS='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const integer=n=>Number.isSafeInteger(n)&&n>=0;
function boundEnvelope(transaction,sender){
 try{const bytes=decodeBase58(transaction.serialized);if(bytes.length>1232||bytes[0]!==1||bytes.subarray(1,65).some(b=>b!==0))return false;const message=bytes.subarray(65);let at=message[0]===128?1:0;if(message[0]&128&&at!==1||message[at]!==1)return false;at+=3;let count=0,shift=0,b;do{if(at>=message.length||shift>14)return false;b=message[at++];count|=(b&127)<<shift;shift+=7;}while(b&128);if(count<1||count>256||at+count*32+32>message.length)return false;return encodeBase58(message.subarray(at,at+32))===sender&&encodeBase58(message.subarray(at+count*32,at+count*32+32))===transaction.blockhash;}catch{return false;}
}
export function createRelayProviderSolanaClaimRecovery({fetch:wire=globalThis.fetch,now=Date.now,chains}={}){
 if(typeof wire!=='function'||typeof now!=='function'||!Array.isArray(chains))fail('INVALID_EXECUTION_CONFIG');const profile=chains.find(row=>row.chainId===CHAIN&&row.vm==='SOLANA');let chain;
 if(profile){let url;try{url=new URL(profile.rpcUrl);}catch{fail('INVALID_EXECUTION_CONFIG');}if(url.protocol!=='https:'||url.username||url.password||url.hash)fail('INVALID_EXECUTION_CONFIG');chain={...profile,rpcUrl:url.href};}
 const {rpc,settled}=createReceiptIo(wire);
 return{async release({record},signal){
  record=structuredClone(record);const plan=record?.plan,action=plan?.actions?.[record.nextAction],payload=action?.payload,t=payload?.transaction,slot=payload?.validation?.evidence?.slot;
  if(!chain||!['CLAIMED','RECOVERY_REQUIRED'].includes(record?.status)||record.nextAction!==0||!Array.isArray(record.submissions)||record.submissions.length!==0||plan?.actions?.length!==1||record.claimedActionId!==action?.id||action?.chainId!==CHAIN||plan?.source?.chainId!==CHAIN||plan?.providerRoute?.provider!=='relay'||plan.providerRoute.mode!=='PROVIDER_MANAGED'||plan.providerRoute.sourceVm!=='SOLANA'||payload?.type!=='PROVIDER_REVIEWED_TRANSACTION'||payload.version!==1||payload.vm!=='SOLANA'||payload.providerId!=='relay'||payload.verification!=='TRUSTED_SERVER_FRESH_RFQ'||!['FUNDING','SWAP'].includes(payload.kind)||payload.rfq?.requestId!==plan.providerRoute.requestId||payload.rfq?.commitmentHash!==plan.providerRoute.quoteHash||!integer(slot)||slot<1||!integer(t?.lastValidBlockHeight)||t.feePayer!==plan.sender||!boundEnvelope(t,plan.sender))return{ready:false};
  const expectedBindings={requestId:plan.providerRoute.requestId,quoteHash:plan.providerRoute.quoteHash,transactionHash:sha(t),source:plan.source,destination:plan.destination,sender:plan.sender,recipient:plan.recipient,amountRaw:plan.amountRaw,minimumOutRaw:plan.minimumOutRaw,slippageBps:record.request?.slippageBps,expiresAtMs:plan.expiresAtMs};
  if(!record.request||!payload.bindings||payload.rfq.expiresAtMs!==plan.expiresAtMs||canonical(payload.bindings)!==canonical(expectedBindings))return{ready:false};
  const inner=signal?AbortSignal.any([signal,AbortSignal.timeout(8000)]):AbortSignal.timeout(8000),read=(method,params)=>rpc(chain,method,params,inner);
  const [genesis,currentSlot,first,minimum]=await settled([read('getGenesisHash',[]),read('getSlot',[{commitment:'finalized',minContextSlot:slot}]),read('getFirstAvailableBlock',[]),read('minimumLedgerSlot',[])]);
  if(genesis!==GENESIS)fail('EXECUTION_CHAIN_MISMATCH');if(!integer(currentSlot)||currentSlot<slot||!integer(first)||first>slot||!integer(minimum)||minimum>slot)return{ready:false};
  const block=await read('getBlock',[currentSlot,{commitment:'finalized',transactionDetails:'none',rewards:false}]);
  if(!block||!integer(block.blockHeight)||!integer(block.blockTime)||block.blockTime*1000<now()-90000||block.blockTime*1000>now()+15000)fail('EXECUTION_EVIDENCE_STALE');try{decodeBase58(block.blockhash,32);}catch{fail('EXECUTION_EVIDENCE_INVALID');}
  if(!integer(plan.expiresAtMs)||now()<plan.expiresAtMs||block.blockHeight<=t.lastValidBlockHeight)return{ready:false};
  const config={commitment:'finalized',minContextSlot:currentSlot};const [valid,history]=await settled([read('isBlockhashValid',[t.blockhash,config]),read('getSignaturesForAddress',[plan.sender,{...config,limit:1000}])]);
  if(!integer(valid?.context?.slot)||valid.context.slot<currentSlot||valid.value!==false||!Array.isArray(history)||history.length<1||history.length>1000)return{ready:false};
  let previous=Number.MAX_SAFE_INTEGER;const seen=new Set();for(const row of history){try{decodeBase58(row.signature,64);}catch{return{ready:false};}if(!integer(row.slot)||row.slot>previous||seen.has(row.signature)||row.confirmationStatus!=='finalized')return{ready:false};previous=row.slot;seen.add(row.signature);if(row.slot>=slot)return{ready:false};}
  // A finalized older signature anchors the history boundary. No pagination or
  // transaction matching is needed because ANY activity in the interval blocks.
  const again=await read('getBlock',[currentSlot,{commitment:'finalized',transactionDetails:'none',rewards:false}]);if(again?.blockhash!==block.blockhash||again?.blockHeight!==block.blockHeight)fail('EXECUTION_REORG');
  return{ready:true,evidence:{chainId:CHAIN,feePayer:plan.sender,blockhash:t.blockhash,preparedSlot:slot,lastValidBlockHeight:t.lastValidBlockHeight,finalizedSlot:currentSlot,finalizedBlockHeight:block.blockHeight,finalizedBlockHash:block.blockhash,observedAtMs:now(),minimumLedgerSlot:minimum,firstAvailableBlock:first,latestSignatureSlot:history[0].slot}};
 }};
}
