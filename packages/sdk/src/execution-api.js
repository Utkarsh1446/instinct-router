import { RouterSdkError, invalid } from './errors.js';
import { object, identifier, quoteRequest, prepareRequest } from './validation.js';
import { walletRequest, validateRecord, validateAction, validatePreparedRequest, validateProgress, same } from './execution-validation.js';
const fail = () => { throw new RouterSdkError('PROTOCOL_ERROR', 'The router returned an invalid wallet response.'); };
export function executionRequest(input) {
  if (Object.hasOwn(input ?? {}, 'quoteId')) return prepareRequest(input);
  object(input, ['source','destination','amount','sender','recipient','slippageBps','objective','maxOutputShortfallBps','maxFeeBps','maxPriceImpactBps','routeScope','nativeFeeBudgets'], ['nativeFeeBudgets']);
  const { nativeFeeBudgets, ...quote } = input, normalized = quoteRequest(quote);
  if (!Array.isArray(nativeFeeBudgets) || nativeFeeBudgets.length < 1 || nativeFeeBudgets.length > 8) invalid('Provide a native fee budget.');
  const seen = new Set();
  const budgets = nativeFeeBudgets.map(row => {
    object(row, ['chainId','maxAmountRaw'], ['chainId','maxAmountRaw']);
    if (row.chainId !== normalized.source.chainId || seen.has(row.chainId) || row.maxAmountRaw !== null && (typeof row.maxAmountRaw !== 'string' ||
      !/^[1-9][0-9]{0,77}$/.test(row.maxAmountRaw) || BigInt(row.maxAmountRaw) >= (1n << 256n))) invalid('Invalid native fee budget.');
    seen.add(row.chainId); return { ...row };
  });
  return { ...normalized, nativeFeeBudgets: budgets };
}
export function executionMethods(request) {
  async function record(path, body, options, expected) {
    const data = await request(path, body === undefined ? 'GET' : 'POST', body, options, 'walletExecution');
    validateRecord(data.execution, expected); return data;
  }
  const path = id => '/v1/executions/' + encodeURIComponent(identifier(id));
  const consent = value => {
    object(value, ['reviewHash','revision'], ['reviewHash','revision']);
    if (!/^[0-9a-f]{64}$/.test(value.reviewHash) || !Number.isSafeInteger(value.revision) || value.revision < 0) invalid('Invalid review consent.');
    return { ...value };
  };
  return {
    async createWalletChallenge(input, options) {
      const wallet = walletRequest(input), data = await request('/v1/wallets/challenge', 'POST', wallet, options, 'walletChallenge');
      if (!/^wc_[0-9a-f]{48}$/.test(data.challengeId) || !same(data.wallet, wallet) || typeof data.message !== 'string' || data.message.length > 4096 ||
        !Number.isSafeInteger(data.expiresAtMs) || data.expiresAtMs <= Date.now() || data.expiresAtMs > Date.now() + 302000 ||
        !data.message.startsWith('Instinct Router wallet-control proof\nThis proves wallet control only. It does not authorize a transaction or transfer.\n') ||
        !data.message.includes('\nChain: ' + wallet.chainId + '\nWallet: ' + wallet.address + '\nNonce: ' + data.challengeId + '\nExpires: ' + data.expiresAtMs)) fail();
      if (typeof data.appId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(data.appId)) fail();
      const origin = globalThis.window?.location?.origin ?? 'server';
      const exactMessage = ['Instinct Router wallet-control proof',
        'This proves wallet control only. It does not authorize a transaction or transfer.',
        'App: ' + data.appId, 'Origin: ' + origin, 'Chain: ' + wallet.chainId, 'Wallet: ' + wallet.address,
        'Nonce: ' + data.challengeId, 'Expires: ' + data.expiresAtMs].join('\n');
      if (data.message !== exactMessage) fail();
      return data;
    },
    async verifyWallet(input, options) {
      object(input, ['challengeId','signature'], ['challengeId','signature']);
      if (!/^wc_[0-9a-f]{48}$/.test(input.challengeId) || typeof input.signature !== 'string' || input.signature.length > 256 ||
        !/^(?:0x[0-9a-fA-F]{130}|[1-9A-HJ-NP-Za-km-z]{64,88})$/.test(input.signature)) invalid('Invalid ownership signature.');
      const data = await request('/v1/wallets/verify', 'POST', input, options, 'walletVerify');
      if (!/^[A-Za-z0-9_-]{43}$/.test(data.walletToken) || !Number.isSafeInteger(data.expiresAtMs) || data.expiresAtMs <= Date.now() ||
        data.expiresAtMs > Date.now() + 902000) fail();
      try { walletRequest(data.wallet); } catch { fail(); } return data;
    },
    async prepareExecution(input, options) {
      if (!options?.walletToken) return request('/v1/executions/prepare', 'POST', prepareRequest(input), options, 'prepare');
      if (Object.hasOwn(input ?? {}, 'quoteId')) invalid('Execution needs fresh direct inputs and explicit native fee budgets.');
      const normalized = executionRequest(input);
      const data = await record('/v1/executions/prepare', normalized, options);
      validatePreparedRequest(data.execution, normalized);
      if (data.execution.status !== 'READY' || data.execution.plan.expiresAtMs <= Date.now() || data.execution.plan.expiresAtMs > Date.now() + 92000) fail();
      return data;
    },
    async getActiveExecution(options) {
      const data = await request('/v1/executions/active', 'GET', undefined, options, 'walletExecution');
      if (data.execution !== null) validateRecord(data.execution); return data;
    },
    getExecution: (id, options) => record(path(id), undefined, options).then(data => { if (data.execution.id !== id) fail(); return data; }),
    async claimExecution(id, input, options) {
      const data = await record(path(id) + '/claim', consent(input), options);
      if (data.execution.id !== id || data.execution.reviewHash !== input.reviewHash || data.execution.revision !== input.revision + 1 || data.execution.status !== 'CLAIMED') fail();
      await validateAction(data.action, data.execution); return data;
    },
    async submitExecution(id, input, options) {
      object(input, ['transactionHash'], ['transactionHash']);
      if (typeof input.transactionHash !== 'string' || !/^(?:0x[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{64,88})$/.test(input.transactionHash)) invalid('Invalid transaction hash.');
      const data = await record(path(id) + '/submit', input, options);
      if (data.execution.id !== id || data.execution.status !== 'SUBMITTED' || !data.execution.submissions.some(row => row.hash === input.transactionHash)) fail(); return data;
    },
    markExecutionUncertain: (id, options) => record(path(id) + '/uncertain', {}, options).then(data => { if (data.execution.id !== id || data.execution.status !== 'RECOVERY_REQUIRED') fail(); return data; }),
    watchExecution: (id, options) => request(path(id) + '/watch','POST',{},options,'walletWatch'),
    refreshExecution: (id, options) => record(path(id) + '/refresh', {}, options).then(data => { if (data.execution.id !== id) fail(); validateProgress(data.progress,data.execution); return data; }),
    cancelExecution: (id, input, options) => record(path(id) + '/cancel', consent(input), options).then(data => { if (data.execution.id !== id || !['CANCELLED','EXPIRED'].includes(data.execution.status)) fail(); return data; }),
  };
}
