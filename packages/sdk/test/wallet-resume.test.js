import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvmWallet, createPhantomWallet } from '../src/wallets.js';
const A = '0x' + 'ab'.repeat(20), B = '0x' + 'cd'.repeat(20);
const SA = '11111111111111111111111111111112', SB = '11111111111111111111111111111113';
const key = address => ({ toString: () => address });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function evm(accounts = [A], chain = '0x1') {
  const listeners = {}, calls = [];
  const provider = { accounts, chain, on: (event, callback) => { listeners[event] = callback; },
    request: async ({method}) => { calls.push(method); if (method === 'eth_accounts') return provider.accounts; if (method === 'eth_chainId') return provider.chain; if (method === 'personal_sign') return '0x' + '11'.repeat(65); },
  };
  return { provider, calls, emit: (event, value) => listeners[event](value), wallet: createEvmWallet(provider) };
}
function phantom() {
  const listeners = {}, calls = [];
  const provider = { publicKey: key(SA), on: (event, callback) => { listeners[event] = callback; },
    connect: async options => { calls.push(options); return { publicKey: provider.publicKey }; }, signMessage: async () => ({ signature: new Uint8Array(64) }) };
  return { provider, calls, emit: (event, value) => listeners[event](value), wallet: createPhantomWallet(provider) };
}
test('EVM restore uses read-only methods, binds normalized expected account among multiple accounts and live network', async () => {
  const f = evm([B, A.toUpperCase().replace('0X', '0x')], '0x2105');
  assert.equal(await f.wallet.resume(), null);
  const account = await f.wallet.resume({ address: A, chainId: 'eip155:1' });
  assert.deepEqual(account, { address: A, chainId: 'eip155:8453' });
  assert.deepEqual(await f.wallet.getAccount(), account);
  assert.deepEqual(new Set(f.calls), new Set(['eth_accounts', 'eth_chainId']));
  await assert.rejects(f.wallet.signMessage('challenge', { address: B, chainId: account.chainId }), { code: 'WALLET_CHANGED' });
  await assert.rejects(f.wallet.signMessage('challenge', { address: A, chainId: 'eip155:1' }), { code: 'WALLET_CHANGED' });
  assert.ok(!f.calls.includes('personal_sign'));
});
test('EVM revoked, missing, malformed and rejected authorization returns null', async () => {
  const f = evm();
  assert.ok(await f.wallet.resume());
  assert.equal(await f.wallet.resume({address:B,chainId:'eip155:1'}), null);
  for (const accounts of [[], ['bad'], [A, B]]) { f.provider.accounts = accounts; assert.equal(await f.wallet.resume(), null); }
  f.provider.request = async () => { throw Error('revoked'); };
  assert.equal(await f.wallet.resume(), null);
  await assert.rejects(f.wallet.getAccount(), { code: 'WALLET_UNAVAILABLE' });
});
test('EVM stale restore cannot overwrite a newer connect, disconnect or wallet event', async () => {
  for (const action of ['connect', 'resume', 'disconnect', 'event']) {
    const f = evm(), pending = deferred(), original = f.provider.request;
    let first = true;
    f.provider.request = args => args.method === 'eth_accounts' && first ? (first = false, pending.promise) : original(args);
    const restoring = f.wallet.resume();
    if (action === 'connect') { f.provider.accounts = [B]; await f.wallet.connect(); }
    else if (action === 'resume') { f.provider.accounts = [B]; await f.wallet.resume(); }
    else if (action === 'disconnect') f.wallet.disconnect();
    else f.emit('accountsChanged', [B]);
    pending.resolve([A]);
    assert.equal(await restoring, null);
    if (action === 'connect' || action === 'resume') assert.equal((await f.wallet.getAccount()).address, B);
    else await assert.rejects(f.wallet.getAccount(), {code:'WALLET_UNAVAILABLE'});
  }
});
test('EVM confirmed no-op events preserve selection; real events block signing', async () => {
  const f = evm([A,B]);
  const account = await f.wallet.resume({address:A,chainId:'eip155:1'});
  f.emit('accountsChanged', [B,A.toUpperCase().replace('0X','0x')]); f.emit('chainChanged','0x01');
  assert.deepEqual(await f.wallet.getAccount(), account);
  f.provider.accounts = [A]; f.emit('accountsChanged',[A]);
  assert.deepEqual(await f.wallet.getAccount(), account);
  f.provider.accounts = [A,B]; f.emit('accountsChanged',[A,B]);
  assert.deepEqual(await f.wallet.getAccount(), account);
  f.provider.chain = '0x2'; f.emit('chainChanged', '0x2');
  await assert.rejects(f.wallet.signMessage('challenge', account), {code:'WALLET_CHANGED'});
  assert.ok(!f.calls.includes('personal_sign'));
});
test('Phantom restore uses trusted-only connect and binds result to live account', async () => {
  const f = phantom();
  assert.deepEqual(await f.wallet.resume({address:SA,chainId:'solana:mainnet'}), {address:SA,chainId:'solana:mainnet'});
  assert.deepEqual(f.calls, [{onlyIfTrusted:true}]);
  assert.equal(await f.wallet.resume({address:SB,chainId:'solana:mainnet'}), null);
  f.provider.connect = async () => ({publicKey:key(SB)});
  assert.equal(await f.wallet.resume(), null);
  f.provider.connect = async () => { throw Error('untrusted'); };
  assert.equal(await f.wallet.resume(), null);
});
test('Phantom stale restore cannot overwrite newer selection, disconnect or account event', async () => {
  for (const action of ['connect','resume','disconnect','event']) {
    const f = phantom(), pending = deferred(); let first = true;
    f.provider.connect = async () => first ? (first = false, pending.promise) : {publicKey:f.provider.publicKey};
    const restoring = f.wallet.resume();
    if (action === 'connect') { f.provider.publicKey = key(SB); await f.wallet.connect(); }
    else if (action === 'resume') { f.provider.publicKey = key(SB); await f.wallet.resume(); }
    else if (action === 'disconnect') f.wallet.disconnect();
    else { f.provider.publicKey = key(SB); f.emit('accountChanged', f.provider.publicKey); }
    pending.resolve({publicKey:key(SA)});
    assert.equal(await restoring, null);
    if (action === 'connect' || action === 'resume') assert.equal((await f.wallet.getAccount()).address,SB);
    else await assert.rejects(f.wallet.getAccount(),{code:'WALLET_CHANGED'});
  }
});
test('Phantom matching account events preserve selection and changed account blocks signing', async () => {
  const f = phantom(), account = await f.wallet.resume();
  f.emit('accountChanged',key(SA)); assert.deepEqual(await f.wallet.getAccount(),account);
  f.provider.publicKey = key(SB);
  await assert.rejects(f.wallet.signMessage('challenge',{address:SB,chainId:account.chainId}),{code:'WALLET_CHANGED'});
  f.emit('accountChanged',key(SB));
  await assert.rejects(f.wallet.signMessage('challenge',account),{code:'WALLET_CHANGED'});
});
