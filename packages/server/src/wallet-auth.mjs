import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { fault, single } from './security.mjs';

const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(value, size) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) return null;
  let n = 0n;
  for (const character of value) { const digit = alphabet.indexOf(character); if (digit < 0) return null; n = n * 58n + BigInt(digit); }
  const bytes = []; while (n) { bytes.unshift(Number(n & 255n)); n >>= 8n; }
  for (const character of value) { if (character !== '1') break; bytes.unshift(0); }
  return bytes.length === size ? Buffer.from(bytes) : null;
}
export function walletIdentity(chainId, address) {
  if (typeof chainId !== 'string' || typeof address !== 'string') fault(400, 'INVALID_WALLET', 'Use a supported chain and wallet address.');
  if (/^eip155:[1-9][0-9]{0,15}$/.test(chainId) && /^0x[0-9a-fA-F]{40}$/.test(address) && !/^0x0{40}$/.test(address))
    return { chainId, address: address.toLowerCase() };
  if (['solana:mainnet', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'].includes(chainId) && base58(address, 32) && address !== '11111111111111111111111111111111') return { chainId, address };
  fault(400, 'INVALID_WALLET', 'Use a supported chain and wallet address.');
}
export const walletOwner = (appId, wallet) => 'w_' + createHash('sha256').update(JSON.stringify([appId, wallet.chainId, wallet.address])).digest('hex');
const strict = (body, fields) => {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== fields.length || fields.some(key => !Object.hasOwn(body, key)))
    fault(400, 'INVALID_REQUEST', 'Use the exact wallet proof fields.');
};
/** A synchronous local store preserves the development/server API. Shared stores may be async. */
export function createMemoryWalletAuthStore({ now = Date.now, maxEntries = 1024 } = {}) {
  const challenges = new Map(), sessions = new Map();
  const put = (map, key, row) => {
    for (const [id, value] of map) if (value.expiresAtMs <= now()) map.delete(id);
    if (map.size >= maxEntries) fault(429, 'WALLET_AUTH_BUSY', 'Wallet proof capacity is full.', true, 1000);
    map.set(key, structuredClone(row));
  };
  return {
    putChallenge: (id, row) => put(challenges, id, row),
    consumeChallenge(id, scope, stamp) {
      const row = challenges.get(id);
      if (!row || row.scope !== scope || row.expiresAtMs <= stamp) return null;
      challenges.delete(id); return structuredClone(row);
    },
    putSession: (id, row) => put(sessions, id, row),
    getSession: id => sessions.get(id),
  };
}
const storageUnavailable = () => fault(503, 'WALLET_AUTH_UNAVAILABLE', 'Wallet proof storage is unavailable. Try again shortly.', true);
// Wrong-scope requests cannot destroy another app/origin's challenge. Consumption
// is atomic across instances, before asynchronous signature verification.
const consumeScript = `local raw = redis.call('GET', KEYS[1])
if not raw then return false end
local row = cjson.decode(raw)
if row.scope ~= ARGV[1] or row.expiresAtMs <= tonumber(ARGV[2]) then return false end
redis.call('DEL', KEYS[1])
return raw`;
export function createRedisWalletAuthStore({ command, prefix = 'instinct:wallet:', now = Date.now } = {}) {
  if (typeof command !== 'function' || typeof prefix !== 'string' || !prefix.length || prefix.length > 128) throw new Error('A Redis wallet storage command and prefix are required.');
  const put = async (kind, id, row) => {
    const ttl = Math.ceil(row.expiresAtMs - now());
    if (ttl <= 0) storageUnavailable();
    if (await command(['SET', prefix + kind + ':' + id, JSON.stringify(row), 'PX', String(ttl), 'NX']) !== 'OK') storageUnavailable();
  };
  const decode = value => value == null || value === false ? null : JSON.parse(value);
  return {
    putChallenge: (id, row) => put('challenge', id, row),
    consumeChallenge: async (id, scope, stamp) => decode(await command(['EVAL', consumeScript, '1', prefix + 'challenge:' + id, scope, String(stamp)])),
    putSession: (id, row) => put('session', id, row),
    getSession: async id => decode(await command(['GET', prefix + 'session:' + id])),
  };
}
const mapResult = (value, use) => value && typeof value.then === 'function' ? value.then(use) : use(value);
/** Short-lived, app/origin-bound wallet-control proofs. No signing authority or funds are held. */
export function createWalletAuthentication({ now = Date.now, maxEntries = 1024, store = createMemoryWalletAuthStore({ now, maxEntries }) } = {}) {
  for (const method of ['putChallenge', 'consumeChallenge', 'putSession', 'getSession']) if (typeof store?.[method] !== 'function') throw new Error('Invalid wallet auth store.');
  const scope = (app, origin) => JSON.stringify([app.id, origin ?? null]);
  const stored = (method, ...args) => {
    try {
      const value = store[method](...args);
      return value && typeof value.then === 'function' ? value.catch(error => { if (error?.code === 'WALLET_AUTH_BUSY') throw error; storageUnavailable(); }) : value;
    } catch (error) { if (error?.code === 'WALLET_AUTH_BUSY') throw error; storageUnavailable(); }
  };
  return {
    challenge(app, origin, body) {
      strict(body, ['chainId', 'address']); const wallet = walletIdentity(body.chainId, body.address);
      const challengeId = 'wc_' + randomBytes(24).toString('hex'), expiresAtMs = now() + 300000;
      const message = ['Instinct Router wallet-control proof', 'This proves wallet control only. It does not authorize a transaction or transfer.',
        `App: ${app.id}`, `Origin: ${origin ?? 'server'}`, `Chain: ${wallet.chainId}`, `Wallet: ${wallet.address}`,
        `Nonce: ${challengeId}`, `Expires: ${expiresAtMs}`].join('\n');
      return mapResult(stored('putChallenge', challengeId, { scope: scope(app, origin), wallet, message, expiresAtMs }),
        () => ({ challengeId, message, expiresAtMs, wallet }));
    },
    async verify(app, origin, body) {
      strict(body, ['challengeId', 'signature']);
      if (typeof body.challengeId !== 'string' || !/^wc_[0-9a-f]{48}$/.test(body.challengeId)) fault(401, 'WALLET_PROOF_INVALID', 'Request a fresh wallet-control proof.');
      const row = await stored('consumeChallenge', body.challengeId, scope(app, origin), now());
      if (!row || row.scope !== scope(app, origin) || row.expiresAtMs <= now()) fault(401, 'WALLET_PROOF_INVALID', 'Request a fresh wallet-control proof.');
      let valid = false;
      try {
        if (row.wallet.chainId.startsWith('eip155:')) {
          if (/^0x[0-9a-fA-F]{130}$/.test(body.signature)) {
            const { verifyMessage } = await import('viem');
            valid = await verifyMessage({ address: row.wallet.address, message: row.message, signature: body.signature });
          }
        } else {
          const signature = base58(body.signature, 64), publicBytes = base58(row.wallet.address, 32);
          if (signature) valid = verify(null, Buffer.from(row.message), createPublicKey({ format: 'der', type: 'spki',
            key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicBytes]) }), signature);
        }
      } catch { valid = false; }
      if (!valid || row.expiresAtMs <= now()) fault(401, 'WALLET_PROOF_INVALID', 'The wallet signature could not be verified.');
      const walletToken = randomBytes(32).toString('base64url'), expiresAtMs = now() + 900000;
      await stored('putSession', createHash('sha256').update(walletToken).digest('hex'), { scope: row.scope, wallet: row.wallet, expiresAtMs });
      return { walletToken, expiresAtMs, wallet: row.wallet };
    },
    authenticate(req, app, origin) {
      const token = single(req, 'x-router-wallet-token');
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) fault(401, 'WALLET_AUTH_REQUIRED', 'Prove source wallet control before continuing.');
      return mapResult(stored('getSession', createHash('sha256').update(token).digest('hex')), row => {
        if (!row || row.scope !== scope(app, origin) || row.expiresAtMs <= now()) fault(401, 'WALLET_AUTH_REQUIRED', 'Prove source wallet control before continuing.');
        return { ...row.wallet, ownerId: walletOwner(app.id, row.wallet) };
      });
    },
  };
}
