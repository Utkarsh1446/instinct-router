import { decodeUnsignedSolanaTransaction } from './solana-transaction.js';
import { decodeLegacyMessage, decodeBase58, serializeUnsignedTransaction } from './solana-message-codec.js';
import { RouterSdkError, invalid } from './errors.js';
import { assetRequest } from './validation.js';
const fail = (code, message) => { throw new RouterSdkError(code, message); };
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function encodeBase58(bytes) {
  let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
  let text = ''; while (n) { text = alphabet[Number(n % 58n)] + text; n /= 58n; }
  let zero = 0; while (zero < bytes.length && bytes[zero] === 0) zero++;
  return '1'.repeat(zero) + text;
}
function walletAddress(chainId, address) {
  const value = assetRequest({ chainId, address });
  if (/^(?:0x0{40}|1{32})$/.test(value.address)) invalid('Choose a wallet account.');
  return value;
}
/** Connect only until the caller explicitly invokes signMessage or sendTransaction. */
export function createEvmWallet(provider) {
  if (typeof provider?.request !== 'function') invalid('Choose an injected Ethereum wallet.');
  let revision = 0, attempts = 0, current = null;
  const clear = () => { revision++; current = null; };
  provider.on?.('accountsChanged', accounts => {
    try {
      const addresses = Array.isArray(accounts) && accounts.length <= 100 ? accounts.map(address => walletAddress(current?.chainId, address).address) : null;
      if (current && addresses?.includes(current.address)) return;
    } catch { /* Invalid event data invalidates the selection. */ }
    clear();
  });
  provider.on?.('chainChanged', chain => {
    if (current && typeof chain === 'string' && /^0x[0-9a-f]+$/i.test(chain) && current.chainId === 'eip155:' + BigInt(chain).toString()) return;
    clear();
  });
  provider.on?.('disconnect', clear);
  async function state() {
    const version = revision;
    const [accounts, chain] = await Promise.all([provider.request({ method: 'eth_accounts' }), provider.request({ method: 'eth_chainId' })]);
    if (version !== revision) fail('WALLET_CHANGED', 'The wallet account or network changed. Connect again.');
    if (!Array.isArray(accounts) || accounts.length > 100 || !accounts.length || typeof chain !== 'string' || !/^0x[0-9a-f]+$/i.test(chain))
      fail('WALLET_UNAVAILABLE', 'Select an account and network in your wallet.');
    const chainId = 'eip155:' + BigInt(chain).toString();
    return accounts.map(address => walletAddress(chainId, address));
  }
  async function bound(expected) {
    const version = revision, selected = current;
    const accounts = await state(), normalized = walletAddress(expected.chainId, expected.address);
    if (version !== revision || !selected || selected.address !== normalized.address || selected.chainId !== normalized.chainId)
      fail('WALLET_CHANGED', 'The reviewed account and network must be selected in your wallet.');
    if (!accounts.some(account => account.chainId === normalized.chainId && account.address === normalized.address))
      fail('WALLET_CHANGED', 'The reviewed account and network must be selected in your wallet.');
    return normalized;
  }
  return Object.freeze({
    async resume(expected) {
      const attempt = ++attempts, version = ++revision; current = null;
      try {
        const normalized = expected === undefined ? null : walletAddress(expected.chainId, expected.address);
        if (normalized && !normalized.chainId.startsWith('eip155:')) return null;
        const accounts = await state();
        const selected = normalized ? accounts.find(account => account.address === normalized.address) : accounts.length === 1 ? accounts[0] : null;
        if (!selected || attempt !== attempts || version !== revision) return null;
        current = selected; return { ...selected };
      } catch { return null; }
    },
    async connect(selectAccount) {
      const attempt = ++attempts; revision++; current = null;
      await provider.request({ method: 'eth_requestAccounts' });
      if (attempt !== attempts) fail('WALLET_CHANGED', 'Wallet selection changed. Connect again.');
      const accounts = await state(), version = revision;
      const selected = accounts.length === 1 ? accounts[0] : typeof selectAccount === 'function' ? await selectAccount(structuredClone(accounts)) : null;
      if (!selected || !accounts.some(row => row.address === selected.address && row.chainId === selected.chainId))
        fail('ACCOUNT_SELECTION_REQUIRED', 'Choose the account to connect.');
      if (version !== revision) fail('WALLET_CHANGED', 'Wallet selection changed. Connect again.');
      if (attempt !== attempts) fail('WALLET_CHANGED', 'Wallet selection changed. Connect again.');
      current = selected; return { ...selected };
    },
    async getAccount() { if (!current) fail('WALLET_UNAVAILABLE', 'Connect a wallet first.'); return bound(current); },
    async signMessage(message, expected) {
      if (typeof message !== 'string' || message.length < 1 || new TextEncoder().encode(message).length > 4096) invalid('Invalid ownership challenge.');
      const account = await bound(expected);
      const hex = '0x' + [...new TextEncoder().encode(message)].map(b => b.toString(16).padStart(2, '0')).join('');
      const signature = await provider.request({ method: 'personal_sign', params: [hex, account.address] });
      await bound(account);
      if (typeof signature !== 'string' || !/^0x[0-9a-f]{130}$/i.test(signature)) fail('WALLET_RESPONSE_INVALID', 'The wallet returned an invalid signature.');
      return signature;
    },
    async sendTransaction(transaction, expected) {
      const account = await bound(expected);
      if (transaction.from !== account.address || transaction.chainId !== '0x' + BigInt(account.chainId.slice(7)).toString(16))
        fail('WALLET_CHANGED', 'The transaction does not match the selected wallet.');
      // Wallet owns the final confirmation, signing and network submission.
      const hash = await provider.request({ method: 'eth_sendTransaction', params: [structuredClone(transaction)] });
      if (typeof hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(hash)) fail('WALLET_RESPONSE_INVALID', 'Submission status is unknown. Keep the recovery record.');
      return hash;
    },
    disconnect() { attempts++; clear(); },
  });
}
export function createPhantomWallet(provider, chainId = 'solana:mainnet') {
  if (typeof provider?.connect !== 'function' || typeof provider?.signMessage !== 'function') invalid('Choose Phantom for Solana.');
  let revision = 0, attempts = 0, current = null;
  const clear = () => { revision++; current = null; };
  provider.on?.('accountChanged', publicKey => {
    if (current && publicKey?.toString() === current.address && provider.publicKey?.toString() === current.address) return;
    clear();
  });
  provider.on?.('disconnect', clear);
  async function bound(expected) {
    const address = provider.publicKey?.toString();
    const account = walletAddress(chainId, address);
    if (!current || current.address !== account.address || expected.chainId !== chainId || expected.address !== account.address) fail('WALLET_CHANGED', 'The Solana account changed. Connect again.');
    return account;
  }
  return Object.freeze({
    async resume(expected) {
      const attempt = ++attempts, version = ++revision; current = null;
      try {
        const normalized = expected === undefined ? null : walletAddress(expected.chainId, expected.address);
        if (normalized && normalized.chainId !== chainId) return null;
        const result = await provider.connect({ onlyIfTrusted: true });
        if (attempt !== attempts || version !== revision) return null;
        const account = walletAddress(chainId, provider.publicKey?.toString());
        if (result?.publicKey?.toString() !== account.address || normalized && normalized.address !== account.address) return null;
        current = account; return { ...account };
      } catch { return null; }
    },
    async connect() {
      const attempt = ++attempts, version = ++revision; current = null;
      const result = await provider.connect();
      if (attempt !== attempts || version !== revision) fail('WALLET_CHANGED', 'Wallet selection changed. Connect again.');
      const account = walletAddress(chainId, provider.publicKey?.toString());
      if (result?.publicKey?.toString() !== account.address) fail('WALLET_CHANGED', 'The Solana account changed. Connect again.');
      current = account; return { ...current };
    },
    async getAccount() { return bound(current ?? {}); },
    async signMessage(message, expected) {
      if (typeof message !== 'string' || !message.length || new TextEncoder().encode(message).length > 4096) invalid('Invalid ownership challenge.');
      const account = await bound(expected), result = await provider.signMessage(new TextEncoder().encode(message), 'utf8');
      await bound(account);
      if (!(result.signature instanceof Uint8Array) || result.signature.length !== 64) fail('WALLET_RESPONSE_INVALID', 'The wallet returned an invalid signature.');
      return encodeBase58(result.signature);
    },
    async sendTransaction(transaction, expected) {
      if (typeof provider.request !== 'function') fail('WALLET_ACTION_UNSUPPORTED', 'This wallet cannot submit the reviewed Solana transaction.');
      const account = await bound(expected);
      try {
        if(transaction?.serialized){const decoded=decodeUnsignedSolanaTransaction(transaction);if(decoded.feePayer!==account.address)throw Error();}
        else { if (!transaction || Object.keys(transaction).sort().join(',') !== 'blockhash,feePayer,lastValidBlockHeight,message' ||
          transaction.feePayer !== account.address || !Number.isSafeInteger(transaction.lastValidBlockHeight) || transaction.lastValidBlockHeight < 1) throw Error();
        const decoded=decodeLegacyMessage(transaction.message);
        if (decoded.feePayer !== account.address || decoded.blockhash !== transaction.blockhash || decoded.requiredSignatures !== 1) throw Error(); }
      } catch { fail('WALLET_RESPONSE_INVALID', 'The reviewed Solana transaction is invalid.'); }
      // Installed Phantom expects a complete unsigned transaction, including its empty signature slot.
      // Send the reviewed bytes unchanged. The receipt verifier separately
      // checks any safety assertions added by the wallet; never retry submission.
      const result=await provider.request({method:'signAndSendTransaction',params:{message:transaction.serialized ?? encodeBase58(serializeUnsignedTransaction(transaction.message))}});
      // The wallet may switch accounts or disconnect after broadcasting. Preserve
      // its returned hash for recovery; account binding applies before handoff.
      try { decodeBase58(result?.signature,64); } catch { fail('WALLET_RESPONSE_INVALID', 'Submission status is unknown. Keep the recovery record.'); }
      return result.signature;
    },
    disconnect() { attempts++; clear(); },
  });
}
