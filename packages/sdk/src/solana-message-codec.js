/** Browser-compatible, bounded legacy Solana messages. No signing or network. */
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const fail = () => { throw new Error('INVALID_SOLANA_MESSAGE'); };
export function encodeBase58(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > 1232) fail();
  let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
  let out = ''; while (n) { out = alphabet[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = '1' + out; }
  return out;
}
export function decodeBase58(text, expectedLength) {
  if (typeof text !== 'string' || !text.length || text.length > 1800) fail();
  let n = 0n; for (const c of text) { const d = alphabet.indexOf(c); if (d < 0) fail(); n = n * 58n + BigInt(d); }
  const out = []; while (n) { out.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of text) { if (c !== '1') break; out.unshift(0); }
  if (out.length > 1232 || expectedLength !== undefined && out.length !== expectedLength) fail();
  const bytes = Uint8Array.from(out); if (encodeBase58(bytes) !== text) fail(); return bytes;
}
const compact = n => { if (!Number.isSafeInteger(n) || n < 0 || n > 1232) fail(); const bytes = []; do { let b = n & 127; n >>= 7; if (n) b |= 128; bytes.push(b); } while (n); return bytes; };
export function encodeLegacyMessage({ feePayer, blockhash, instructions }) {
  decodeBase58(feePayer, 32); decodeBase58(blockhash, 32);
  if (!Array.isArray(instructions) || !instructions.length || instructions.length > 16) fail();
  const accounts = new Map([[feePayer, { pubkey: feePayer, isSigner: true, isWritable: true }]]);
  const add = key => { decodeBase58(key.pubkey, 32); if (typeof key.isSigner !== 'boolean' || typeof key.isWritable !== 'boolean') fail();
    const old = accounts.get(key.pubkey); accounts.set(key.pubkey, { ...key, isSigner: key.isSigner || !!old?.isSigner, isWritable: key.isWritable || !!old?.isWritable }); };
  for (const ix of instructions) { if (!Array.isArray(ix.keys) || ix.keys.length > 32 || !(ix.data instanceof Uint8Array) || ix.data.length > 512) fail();
    ix.keys.forEach(add); add({ pubkey: ix.programId, isSigner: false, isWritable: false }); }
  const keys = [...accounts.values()].sort((a,b) => a.pubkey === feePayer ? -1 : b.pubkey === feePayer ? 1 : Number(b.isSigner)-Number(a.isSigner) || Number(b.isWritable)-Number(a.isWritable));
  if (keys.length > 32) fail();
  const signers = keys.filter(k => k.isSigner);
  const bytes = [signers.length, signers.filter(k => !k.isWritable).length, keys.filter(k => !k.isSigner && !k.isWritable).length,
    ...compact(keys.length), ...keys.flatMap(k => [...decodeBase58(k.pubkey,32)]), ...decodeBase58(blockhash,32), ...compact(instructions.length)];
  for (const ix of instructions) bytes.push(keys.findIndex(k => k.pubkey === ix.programId), ...compact(ix.keys.length),
    ...ix.keys.map(k => keys.findIndex(v => v.pubkey === k.pubkey)), ...compact(ix.data.length), ...ix.data);
  if (bytes.length + 65 > 1232) fail(); return encodeBase58(Uint8Array.from(bytes));
}
export function decodeLegacyMessage(message) {
  const bytes = decodeBase58(message); let at = 0;
  const take = n => { if (at+n > bytes.length) fail(); const out = bytes.slice(at,at+n); at += n; return out; };
  const short = () => { const start = at; let n=0, shift=0, b; do { b=take(1)[0]; n |= (b&127)<<shift; shift+=7; if (shift>21) fail(); } while(b&128);
    if (compact(n).length !== at-start) fail(); return n; };
  const [requiredSignatures, readonlySigned, readonlyUnsigned] = take(3), length=short();
  if (requiredSignatures !== 1 || readonlySigned !== 0 || length < 2 || length > 32 || readonlyUnsigned > length-requiredSignatures) fail();
  const accountKeys = Array.from({length},(_,i)=>({pubkey:encodeBase58(take(32)),isSigner:i<requiredSignatures,isWritable:i<requiredSignatures?i<requiredSignatures-readonlySigned:i<length-readonlyUnsigned}));
  if (new Set(accountKeys.map(k=>k.pubkey)).size !== length) fail();
  const blockhash=encodeBase58(take(32)), count=short(); if (!count || count>16) fail();
  const instructions=Array.from({length:count},()=>{const index=take(1)[0], n=short();if(index>=length||n>32)fail();
    const keys=[...take(n)].map(i=>{if(i>=length)fail();return {...accountKeys[i]};}), size=short();if(size>512)fail();
    return {programId:accountKeys[index].pubkey,keys,data:take(size)};});
  if(at!==bytes.length || bytes.length+65>1232)fail();
  return {feePayer:accountKeys[0].pubkey,blockhash,requiredSignatures,accountKeys,instructions};
}
export function serializeUnsignedTransaction(message) { decodeLegacyMessage(message); return Uint8Array.from([1,...new Uint8Array(64),...decodeBase58(message)]); }
const P=(1n<<255n)-19n;
const mod = n => (n%P+P)%P;
const pow = (n,e) => { let out=1n; for(n=mod(n);e;e>>=1n,n=mod(n*n))if(e&1n)out=mod(out*n);return out; };
const D=mod(-121665n*pow(121666n,P-2n));
const onCurve = bytes => {let y=0n;for(let i=31;i>=0;i--)y=y*256n+BigInt(i===31?bytes[i]&127:bytes[i]);if(y>=P)return false;
  const y2=mod(y*y), x2=mod((y2-1n)*pow(D*y2+1n,P-2n)); return x2===0n || pow(x2,(P-1n)/2n)===1n;};
export async function deriveProgramAddress(seeds, programId) {
  if(!Array.isArray(seeds)||seeds.length>15||seeds.some(s=>!(s instanceof Uint8Array)||s.length>32))fail();
  const program=decodeBase58(programId,32), suffix=new TextEncoder().encode('ProgramDerivedAddress');
  for(let bump=255;bump>=0;bump--){const data=Uint8Array.from([...seeds.flatMap(s=>[...s]),bump,...program,...suffix]);
    const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',data));if(!onCurve(hash))return{address:encodeBase58(hash),bump};}fail();
}
export const TOKEN_PROGRAM='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const ASSOCIATED_TOKEN_PROGRAM='ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const SYSTEM_PROGRAM='11111111111111111111111111111111';
export async function deriveAssociatedTokenAddress(owner,mint){return(await deriveProgramAddress([decodeBase58(owner,32),decodeBase58(TOKEN_PROGRAM,32),decodeBase58(mint,32)],ASSOCIATED_TOKEN_PROGRAM)).address;}
