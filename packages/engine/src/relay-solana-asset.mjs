/** Pre-funding classic mint inspection; never treats token metadata as executable code. */
import { fail } from './base-execution-checks.mjs';
const GENESIS='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const SYSTEM='11111111111111111111111111111111';
const TOKEN='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export async function inspectSolanaAsset(request,read,validateAddress,signal) {
  signal=signal?AbortSignal.any([signal,AbortSignal.timeout(8000)]):AbortSignal.timeout(8000);
  const asset=structuredClone(request.destination);
  if(asset?.chainId!=='solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'||!Number.isSafeInteger(asset.decimals)||asset.decimals<0||asset.decimals>255)
    fail('DESTINATION_TOKEN_UNSUPPORTED');
  validateAddress(asset.address,32);
  const genesis=await read('getGenesisHash',[],signal);
  if(genesis!==GENESIS)fail('DESTINATION_CHAIN_MISMATCH');
  if(asset.address===SYSTEM){if(asset.decimals!==9)fail('DESTINATION_TOKEN_UNSUPPORTED');return {ready:true,asset};}
  const mint=await read('getAccountInfo',[asset.address,{encoding:'jsonParsed',commitment:'finalized'}],signal);
  if(!Number.isSafeInteger(mint?.context?.slot)||mint.context.slot<0||mint.value?.owner!==TOKEN||mint.value.executable!==false||
    mint.value.data?.program!=='spl-token'||mint.value.data?.parsed?.type!=='mint'||
    mint.value.data.parsed.info?.isInitialized!==true||mint.value.data.parsed.info.decimals!==asset.decimals)
    fail('DESTINATION_TOKEN_UNSUPPORTED');
  return {ready:true,asset,slot:mint.context.slot};
}
