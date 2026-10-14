import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { createWalletAuthentication, walletIdentity } from '../src/wallet-auth.mjs';
const app = { id: 'app-a' }, other = { id: 'app-b' }, origin = 'https://app.example';
const account = privateKeyToAccount('0x' + '01'.repeat(32)); // public test fixture only
const req = token => ({ rawHeaders: ['X-Router-Wallet-Token', token] });
const encode58 = buffer => {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; let n = BigInt('0x' + buffer.toString('hex')), out = '';
  while (n) { out = alphabet[Number(n % 58n)] + out; n /= 58n; }
  for (const value of buffer) { if (value) break; out = '1' + out; } return out;
};
test('actual EIP191 wallet signatures are consumed once and sessions bind app, origin, chain and address', async () => {
  let time = Date.now(); const auth = createWalletAuthentication({ now: () => time });
  const proof = auth.challenge(app, origin, { chainId: 'eip155:8453', address: account.address });
  assert.equal(proof.wallet.address, account.address.toLowerCase()); assert.match(proof.message, /does not authorize a transaction/);
  const signature = await account.signMessage({ message: proof.message });
  await assert.rejects(auth.verify(other, origin, { challengeId: proof.challengeId, signature }), /fresh wallet-control/);
  const session = await auth.verify(app, origin, { challengeId: proof.challengeId, signature });
  assert.match(session.walletToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(auth.authenticate(req(session.walletToken), app, origin).address, account.address.toLowerCase());
  assert.throws(() => auth.authenticate(req(session.walletToken), other, origin), /Prove source wallet/);
  assert.throws(() => auth.authenticate(req(session.walletToken), app, 'https://evil.example'), /Prove source wallet/);
  await assert.rejects(auth.verify(app, origin, { challengeId: proof.challengeId, signature }), /fresh wallet-control/);
  time += 900001; assert.throws(() => auth.authenticate(req(session.walletToken), app, origin), /Prove source wallet/);
});
test('wrong EVM signer, expired proof, extra fields and duplicate wallet headers fail closed', async () => {
  let time = Date.now(); const auth = createWalletAuthentication({ now: () => time });
  const stranger = privateKeyToAccount('0x' + '02'.repeat(32));
  const p = auth.challenge(app, origin, { chainId: 'eip155:8453', address: account.address });
  await assert.rejects(auth.verify(app, origin, { challengeId: p.challengeId, signature: await stranger.signMessage({ message: p.message }) }), /could not be verified/);
  await assert.rejects(auth.verify(app, origin, { challengeId: p.challengeId, signature: await account.signMessage({ message: p.message }) }), /fresh wallet-control/);
  const expired = auth.challenge(app, origin, { chainId: 'eip155:8453', address: account.address }); time += 300001;
  await assert.rejects(auth.verify(app, origin, { challengeId: expired.challengeId, signature: '0x' + '00'.repeat(65) }), /fresh wallet-control/);
  assert.throws(() => auth.challenge(app, origin, { chainId: 'eip155:8453', address: account.address, tenant: 'x' }), /exact wallet/);
  assert.throws(() => auth.authenticate({ rawHeaders: ['x-router-wallet-token', 'a', 'X-Router-Wallet-Token', 'b'] }, app, origin), /occur once/);
  assert.throws(() => walletIdentity('eip155:8453', '0x' + '0'.repeat(40)), /supported chain/);
});
test('actual Solana Ed25519 proof validates exact message and source public key', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const address = encode58(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
  const auth = createWalletAuthentication(); const proof = auth.challenge(app, origin, { chainId: 'solana:mainnet', address });
  const signature = encode58(sign(null, Buffer.from(proof.message), privateKey));
  const session = await auth.verify(app, origin, { challengeId: proof.challengeId, signature });
  assert.equal(auth.authenticate(req(session.walletToken), app, origin).address, address);
  const wrong = auth.challenge(app, origin, { chainId: 'solana:mainnet', address });
  await assert.rejects(auth.verify(app, origin, { challengeId: wrong.challengeId, signature }), /could not be verified/);
  assert.throws(() => walletIdentity('solana:mainnet', '11111111111111111111111111111111'), /supported chain/);
});
test('challenge/session storage retains live bounded proofs and rejects exhaustion', () => {
  const auth = createWalletAuthentication({ maxEntries: 1 });
  auth.challenge(app, origin, { chainId: 'eip155:8453', address: account.address });
  assert.throws(() => auth.challenge(app, origin, { chainId: 'eip155:8453', address: account.address }), /capacity is full/);
});

test('valid JSON with a malformed durable wallet session fails closed', () => {
  const row={scope:JSON.stringify([app.id,origin]),wallet:{chainId:'eip155:8453',address:account.address.toLowerCase()},expiresAtMs:Date.now()+60000};
  let saved;
  const auth=createWalletAuthentication({store:{putChallenge(){},consumeChallenge(){},putSession(){},getSession(){return saved;}}});
  for(const mutate of [value=>{delete value.expiresAtMs;},value=>{value.expiresAtMs='tomorrow';},value=>{value.expiresAtMs=Infinity;},value=>{value.wallet.address='not-a-wallet';},value=>{value.wallet.chainId='eip155:0';},value=>{value.wallet.extra=true;}]) {
    saved=structuredClone(row);mutate(saved);
    assert.throws(()=>auth.authenticate(req('a'.repeat(43)),app,origin),{code:'WALLET_AUTH_UNAVAILABLE'});
  }
  saved=row;assert.equal(auth.authenticate(req('a'.repeat(43)),app,origin).address,row.wallet.address);
});

test('shared wallet proof store consumes atomically across instances, preserves scope and expires sessions', async () => {
  const { createRedisWalletAuthStore } = await import('../src/wallet-auth.mjs');
  let time = Date.now(); const rows = new Map(), commands = [];
  // This command fixture models Redis atomic commands; all instances share it.
  const command = async parts => {
    commands.push(parts);
    const [operation, key, raw, , ttl] = parts;
    if (operation === 'SET') {
      if (rows.get(key)?.expires > time) return null;
      rows.set(key, { raw, expires: time + Number(ttl) }); return 'OK';
    }
    const id = operation === 'EVAL' ? parts[3] : key;
    const value = rows.get(id);
    if (!value || value.expires <= time) return null;
    if (operation === 'GET') return value.raw;
    assert.equal(operation, 'EVAL');
    const row = JSON.parse(value.raw);
    if (row.scope !== parts[4] || row.expiresAtMs <= Number(parts[5])) return null;
    rows.delete(id); return value.raw;
  };
  const make = () => createWalletAuthentication({ now: () => time, store: createRedisWalletAuthStore({ command, now: () => time }) });
  const first = make(), second = make();
  const proof = await first.challenge(app, origin, { chainId: 'eip155:8453', address: account.address });
  const signature = await account.signMessage({ message: proof.message });
  await assert.rejects(second.verify(other, origin, { challengeId: proof.challengeId, signature }), { code: 'WALLET_PROOF_INVALID' });
  await assert.rejects(second.verify(app, 'https://evil.example', { challengeId: proof.challengeId, signature }), { code: 'WALLET_PROOF_INVALID' });
  const results = await Promise.allSettled([first.verify(app, origin, { challengeId: proof.challengeId, signature }), second.verify(app, origin, { challengeId: proof.challengeId, signature })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'WALLET_PROOF_INVALID');
  const session = results.find(result => result.status === 'fulfilled').value;
  assert.equal((await second.authenticate(req(session.walletToken), app, origin)).address, account.address.toLowerCase());
  await assert.rejects(second.authenticate(req(session.walletToken), other, origin), { code: 'WALLET_AUTH_REQUIRED' });
  assert.equal(commands.filter(parts => parts[0] === 'SET')[0][4], '300000');
  const sessionWrite = commands.find(parts => parts[0] === 'SET' && parts[1].includes(':session:'));
  assert.equal(sessionWrite[4], '900000');
  assert.equal(sessionWrite[1].includes(session.walletToken), false);
  assert.equal(sessionWrite[2].includes(session.walletToken), false);
  time += 900001;
  await assert.rejects(second.authenticate(req(session.walletToken), app, origin), { code: 'WALLET_AUTH_REQUIRED' });
  const expired = await first.challenge(app, origin, { chainId: 'eip155:8453', address: account.address });
  time += 300001;
  await assert.rejects(second.verify(app, origin, { challengeId: expired.challengeId, signature }), { code: 'WALLET_PROOF_INVALID' });
});

test('shared storage errors and malformed data fail closed without exposing upstream details', async () => {
  const { createRedisWalletAuthStore } = await import('../src/wallet-auth.mjs');
  let fail = false; const rows = new Map();
  const command = async parts => {
    if (fail) throw new Error('secret database credential');
    if (parts[0] === 'SET') { rows.set(parts[1], parts[2]); return 'OK'; }
    if (parts[0] === 'GET') return '{broken';
    const value = rows.get(parts[3]); rows.delete(parts[3]); return value;
  };
  const auth = createWalletAuthentication({ store: createRedisWalletAuthStore({ command }) });
  const proof = await auth.challenge(app, origin, { chainId: 'eip155:8453', address: account.address });
  fail = true;
  const unavailable = error => error.code === 'WALLET_AUTH_UNAVAILABLE' && error.status === 503 && !error.message.includes('secret');
  await assert.rejects(auth.challenge(app, origin, { chainId: 'eip155:8453', address: account.address }), unavailable);
  await assert.rejects(auth.verify(app, origin, { challengeId: proof.challengeId, signature: '0x' + '00'.repeat(65) }), unavailable);
  await assert.rejects(auth.authenticate(req('a'.repeat(43)), app, origin), unavailable);
  fail = false;
  await assert.rejects(auth.authenticate(req('a'.repeat(43)), app, origin), unavailable);
});
