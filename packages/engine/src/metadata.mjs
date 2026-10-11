/** Fixed, read-only Solana mint lookup. Never fetches token URLs or grants execution. */
import { MetadataCache } from '@instinct/router-core';
const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const ENDPOINT = 'https://api.mainnet-beta.solana.com';
const PROGRAMS = new Map([
  ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'spl-token'],
  ['TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', 'spl-token-2022'],
]);
export class MetadataError extends Error {
  constructor(code, message, status = 503) { super(message); this.name = 'MetadataError'; this.code = code; this.status = status; }
}
const unavailable = () => new MetadataError('TOKEN_METADATA_UNAVAILABLE', 'Token details could not be verified. Retry the lookup.');
function publicKey(value) {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let decoded = 0n;
  for (const char of value) decoded = decoded * 58n + BigInt(alphabet.indexOf(char));
  let bytes = 0;
  while (decoded) { bytes++; decoded >>= 8n; }
  return bytes + value.match(/^1*/)[0].length === 32;
}
function validate(body) {
  if (!body || Object.getPrototypeOf(body) !== Object.prototype ||
    Object.keys(body).length !== 2 || !Object.hasOwn(body, 'chainId') || !Object.hasOwn(body, 'address') ||
    !publicKey(body.address)) throw new MetadataError('INVALID_ASSET', 'Enter a valid Solana mint address.', 400);
  if (body.chainId !== SOLANA) throw new MetadataError('UNSUPPORTED_CHAIN', 'Automatic custom-token lookup currently supports Solana.', 400);
  return { chainId: body.chainId, address: body.address };
}
function display(value, max, fallback) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max &&
    !/[\x00-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/u.test(value) ? value.trim() : fallback;
}
function cancel(stream) { try { Promise.resolve(stream?.cancel?.()).catch(() => {}); } catch {} }
async function boundedJson(response, signal) {
  const length = response.headers.get('content-length');
  if (signal.aborted || length && (!/^\d+$/.test(length) || Number(length) > 65536) || !response.body) {
    cancel(response.body); throw unavailable();
  }
  const reader = response.body.getReader();
  const stop = () => cancel(reader);
  signal.addEventListener('abort', stop, { once: true });
  const chunks = []; let total = 0, parts = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (signal.aborted) throw unavailable();
      if (done) break;
      if (++parts > 4096) throw unavailable();
      total += value.byteLength;
      if (total > 65536) throw unavailable();
      chunks.push(value);
      if (parts % 128 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally { signal.removeEventListener('abort', stop); stop(); reader.releaseLock(); }
}
function parse(rows, asset, now) {
  if (!Array.isArray(rows) || rows.length !== 2 || new Set(rows.map(row => row?.id)).size !== 2 ||
    rows.some(row => row?.jsonrpc !== '2.0' || row.error || ![1, 2].includes(row.id))) throw unavailable();
  if (rows.find(row => row.id === 1).result !== GENESIS)
    throw new MetadataError('TOKEN_METADATA_WRONG_CHAIN', 'The token lookup did not confirm Solana mainnet.');
  const result = rows.find(row => row.id === 2).result;
  if (!Number.isSafeInteger(result?.context?.slot) || result.context.slot <= 0) throw unavailable();
  if (result.value === null) throw new MetadataError('TOKEN_NOT_FOUND', 'This mint was not found on Solana mainnet.', 400);
  const account = result.value;
  const parsed = account?.data?.parsed;
  const info = parsed?.info;
  if (account?.executable !== false || !PROGRAMS.has(account?.owner) ||
    account.data.program !== PROGRAMS.get(account.owner) || parsed.type !== 'mint' || info?.isInitialized !== true)
    throw new MetadataError('TOKEN_NOT_MINT', 'This address is not an initialized supported token mint.', 400);
  if (!Number.isInteger(info.decimals) || info.decimals < 0 || info.decimals > 255) throw unavailable();
  const extensions = info.extensions;
  if (extensions !== undefined && (!Array.isArray(extensions) || extensions.length > 64)) throw unavailable();
  const labels = (extensions ?? []).filter(extension => extension?.extension === 'tokenMetadata');
  if (labels.length > 1 || labels.length && labels[0].state?.mint !== asset.address) throw unavailable();
  const label = labels[0]?.state;
  return { ...asset, decimals: info.decimals, symbol: display(label?.symbol, 32, 'TOKEN'),
    name: display(label?.name, 80, 'Custom token'), tokenProgram: account.owner,
    decimalsSource: 'FINALIZED_CHAIN', metadataVerified: true, metadataSlot: result.context.slot,
    verifiedAtMs: now, metadataValidUntilMs: now + 60000, native: false, executionAuthorized: false };
}

export function createMetadataResolver({ fetch: wire = globalThis.fetch, now = Date.now, timeoutMs = 6000 } = {}) {
  const cache = new MetadataCache(60000, 128, { maxPending: 4, loadTimeoutMs: timeoutMs, clock: now });
  return { async resolveAsset(body, signal) {
    const asset = validate(body);
    if (signal?.aborted) throw new MetadataError('CANCELLED', 'Token lookup was cancelled.', 499);
    try {
      const result = await cache.get(asset.chainId + ':' + asset.address, async boundSignal => {
        const response = await wire(ENDPOINT, { method: 'POST', redirect: 'error', signal: boundSignal,
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([
            { jsonrpc: '2.0', id: 1, method: 'getGenesisHash', params: [] },
            { jsonrpc: '2.0', id: 2, method: 'getAccountInfo', params: [asset.address, { encoding: 'jsonParsed', commitment: 'finalized' }] },
          ]) });
        if (boundSignal.aborted || !response.ok || response.redirected || response.url && response.url !== ENDPOINT && response.url !== ENDPOINT + '/') {
          cancel(response.body); throw unavailable();
        }
        return parse(await boundedJson(response, boundSignal), asset, now());
      }, { signal });
      if (result.metadataValidUntilMs <= now()) throw unavailable();
      return result;
    } catch (error) {
      if (signal?.aborted) throw new MetadataError('CANCELLED', 'Token lookup was cancelled.', 499);
      if (error instanceof MetadataError) throw error;
      throw unavailable();
    }
  } };
}
