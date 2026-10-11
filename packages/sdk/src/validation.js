import { invalid, RouterSdkError } from './errors.js';
export const API_VERSION = '1';
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const own = (value, key) => Object.hasOwn(value, key);
export function object(value, allowed, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.getOwnPropertySymbols(value).length || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !own(value, key))) invalid();
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) if (descriptor.get || descriptor.set) invalid();
  return value;
}
export function identifier(value, label = 'identifier') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) invalid(`Invalid ${label}.`);
  return value;
}
export function baseUrl(value) {
  if (typeof value !== 'string' || value !== value.trim() || /[\u0000-\u0020\u007f\\]/.test(value) || !/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]+\/?$/.test(value)) invalid('Use an HTTPS router origin, or HTTP on loopback.');
  let url;
  try { url = new URL(value); } catch { invalid('Invalid router base URL.'); }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !(url.protocol === 'https:' || url.protocol === 'http:' && loopback)) invalid('Use an HTTPS router origin, or HTTP on loopback, without paths or credentials.');
  return url.origin;
}
export function timeout(value = 10000) {
  if (!Number.isInteger(value) || value < 1 || value > 30000) invalid('Timeout must be an integer from 1 to 30000 milliseconds.');
  return value;
}
export function credential(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(value)) invalid('Invalid app credential.');
  return value;
}
function chain(value) {
  if (typeof value !== 'string' || !/^(?:eip155:[1-9][0-9]*|solana:[1-9A-HJ-NP-Za-km-z]{1,64})$/.test(value)) invalid('Invalid canonical chain ID.');
  return value;
}
function address(chainId, value) {
  const solana = chainId.startsWith('solana:');
  if (typeof value !== 'string' || !(solana ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ : /^0x[0-9a-fA-F]{40}$/).test(value)) invalid('Address does not match its chain.');
  if (solana) {
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let number = 0n;
    for (const char of value) number = number * 58n + BigInt(alphabet.indexOf(char));
    let bytes = 0;
    while (number > 0n) { bytes++; number >>= 8n; }
    if (bytes + (value.match(/^1*/)?.[0].length ?? 0) !== 32) invalid('Invalid Solana address.');
  }
  return solana ? value : value.toLowerCase();
}
export function assetRequest(value, withDecimals = false) {
  const fields = withDecimals ? ['chainId', 'address', 'decimals'] : ['chainId', 'address'];
  object(value, fields, fields);
  const chainId = chain(value.chainId);
  const result = { chainId, address: address(chainId, value.address) };
  if (withDecimals) {
    if (!Number.isInteger(value.decimals) || value.decimals < 0 || value.decimals > 255) invalid('Decimals must be an integer from 0 to 255.');
    result.decimals = value.decimals;
  }
  return result;
}
export function balanceRequest(value){
  object(value,['chainId','address','owner'],['chainId','address','owner']);
  const asset=assetRequest({chainId:value.chainId,address:value.address});return{...asset,owner:address(asset.chainId,value.owner)};
}
export function validateBalance(value,input){
  const protocol=()=>{throw new RouterSdkError('PROTOCOL_ERROR','The router returned an invalid or mismatched balance observation.');};
  const keys=['apiVersion','requestId','appId','chainId','address','owner','decimals','balanceRaw','observedAtMs'];
  if(!value||typeof value.appId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value.appId)||Object.keys(value).sort().join(',')!==keys.sort().join(',')||value.chainId!==input.chainId||value.address!==input.address||value.owner!==input.owner||!Number.isInteger(value.decimals)||value.decimals<0||value.decimals>255||typeof value.balanceRaw!=='string'||!/^(0|[1-9][0-9]{0,77})$/.test(value.balanceRaw)||BigInt(value.balanceRaw)>=(1n<<256n)||!Number.isSafeInteger(value.observedAtMs)||value.observedAtMs<Date.now()-15000||value.observedAtMs>Date.now()+2000)protocol();
}
function bps(value, max, label) {
  if (!Number.isInteger(value) || value < 0 || value > max) invalid(`Invalid ${label}.`);
  return value;
}
export function quoteRequest(value) {
  object(value, ['source', 'destination', 'amount', 'sender', 'recipient', 'slippageBps', 'objective', 'maxOutputShortfallBps', 'maxFeeBps', 'maxPriceImpactBps', 'routeScope'], ['source', 'destination', 'amount', 'sender', 'recipient']);
  const source = assetRequest(value.source, true), destination = assetRequest(value.destination, true);
  if (source.chainId === destination.chainId && source.address === destination.address) invalid('Choose different source and destination assets.');
  const amount = value.amount;
  if (typeof amount !== 'string' || amount.length > 334 || !/^(0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(amount) || !/[1-9]/.test(amount)) invalid('Amount must be a positive decimal string.');
  const [whole, fraction = ''] = amount.split('.');
  if (fraction.length > source.decimals || BigInt(whole + fraction.padEnd(source.decimals, '0')) > (1n << 256n) - 1n) invalid('Amount exceeds source token precision or size.');
  const sender = address(source.chainId, value.sender), recipient = address(destination.chainId, value.recipient);
  if (/^(?:0x0{40}|1{32})$/.test(sender) || /^(?:0x0{40}|1{32})$/.test(recipient)) invalid('Provide an explicit wallet address, not a native token sentinel.');
  const objective = own(value, 'objective') ? value.objective : 'BALANCED';
  if (!['BALANCED', 'FASTEST', 'BEST_OUTPUT'].includes(objective)) invalid('Invalid objective.');
  const maxOutputShortfallBps = bps(own(value, 'maxOutputShortfallBps') ? value.maxOutputShortfallBps : objective === 'BEST_OUTPUT' ? 0 : 50, 500, 'output shortfall');
  if (objective === 'BEST_OUTPUT' && maxOutputShortfallBps !== 0) invalid('BEST_OUTPUT requires zero output shortfall.');
  if (own(value, 'routeScope') && !['ALL', 'INDEPENDENT'].includes(value.routeScope)) invalid('Invalid route scope.');
  return { source, destination, amount, sender, recipient, objective, maxOutputShortfallBps,
    slippageBps: bps(own(value, 'slippageBps') ? value.slippageBps : 50, 500, 'slippage'),
    maxFeeBps: own(value, 'maxFeeBps') && value.maxFeeBps === null ? null : bps(own(value, 'maxFeeBps') ? value.maxFeeBps : 500, 10000, 'fee limit'),
    maxPriceImpactBps: bps(own(value, 'maxPriceImpactBps') ? value.maxPriceImpactBps : 500, 10000, 'price impact limit'),
    ...(own(value, 'routeScope') ? { routeScope: value.routeScope } : {}) };
}
/** A read-only wallet check. No signing artifacts or execution consent are accepted. */
export function inspectionRequest(value) {
  object(value, ['source', 'destination', 'amount', 'sender', 'recipient', 'slippageBps'], ['source', 'destination', 'amount', 'sender', 'recipient']);
  const normalized = quoteRequest(value);
  return { source: normalized.source, destination: normalized.destination, amount: normalized.amount,
    sender: normalized.sender, recipient: normalized.recipient, slippageBps: normalized.slippageBps };
}
export function validateInspection(value, request) {
  const allowed = ['apiVersion', 'requestId', 'appId', 'readOnly', 'executionReady', 'requiresWalletSignature', 'request', 'amountRaw',
    'status', 'checkedAtMs', 'validUntilMs', 'quote', 'fees', 'evidence', 'transactionPrepared', 'blockers', 'inspectionRttMs', 'execution'];
  if (Object.keys(value).some(key => !allowed.includes(key)) || typeof value.appId !== 'string' ||
    value.readOnly !== true || value.executionReady !== false || value.requiresWalletSignature !== true || value.execution?.enabled !== false ||
    !['READY_FOR_REVIEW', 'BLOCKED'].includes(value.status) || typeof value.transactionPrepared !== 'boolean' ||
    !Number.isSafeInteger(value.checkedAtMs) || value.checkedAtMs < 0 || !Number.isSafeInteger(value.validUntilMs) || value.validUntilMs < value.checkedAtMs ||
    !Number.isSafeInteger(value.inspectionRttMs) || value.inspectionRttMs < 0 ||
    !Array.isArray(value.blockers) || value.blockers.length > 32 || value.blockers.some(row => !row || typeof row.code !== 'string' ||
      !/^[A-Z][A-Z0-9_]{0,95}$/.test(row.code) || typeof row.message !== 'string' || row.message.length > 512)) protocol();
  let echo;
  try { echo = inspectionRequest(value.request); } catch { protocol(); }
  if (JSON.stringify(echo) !== JSON.stringify(request)) protocol();
  const [whole, fraction = ''] = request.amount.split('.');
  if (value.amountRaw !== BigInt(whole + fraction.padEnd(request.source.decimals, '0')).toString()) protocol();
  const raw = input => typeof input === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(input) && BigInt(input) < (1n << 256n);
  if (value.quote !== null && (!value.quote || !raw(value.quote.expectedOutputRaw) || !raw(value.quote.minimumOutputRaw) ||
    BigInt(value.quote.minimumOutputRaw) <= 0n || BigInt(value.quote.minimumOutputRaw) > BigInt(value.quote.expectedOutputRaw) ||
    BigInt(value.quote.minimumOutputRaw) < BigInt(value.quote.expectedOutputRaw) * BigInt(10000 - request.slippageBps) / 10000n)) protocol();
  if (value.fees !== null && (!value.fees || typeof value.fees.complete !== 'boolean' ||
    Object.entries(value.fees).some(([key, amount]) => key.endsWith('Raw') && amount !== null && !raw(amount)))) protocol();
  if (value.status === 'BLOCKED') { if (!value.blockers.length || value.transactionPrepared) protocol(); return; }
  if (value.blockers.length || !value.transactionPrepared || !value.quote || !value.evidence || value.fees?.complete !== true || value.fees.estimateOnly !== true || value.evidence.canonicalRecheck !== true ||
    value.evidence.routerArtifactVerified !== true || value.evidence.calldataBuiltLocally !== true ||
    value.evidence.simulationOutputRaw !== value.quote.expectedOutputRaw ||
    value.validUntilMs <= Date.now() || value.checkedAtMs > Date.now() + 2000 ||
    !Number.isSafeInteger(value.quote.pricingValidUntilMs) || value.validUntilMs > value.quote.pricingValidUntilMs) protocol();
  const fees = value.fees;
  for (const key of ['gasEstimateRaw', 'gasLimitRaw', 'maxFeePerGasRaw', 'maxPriorityFeePerGasRaw', 'l2BudgetRaw',
    'l1FeeUpperBoundRaw', 'l1BudgetRaw', 'operatorFeeBudgetRaw', 'totalNativeBudgetRaw', 'balanceRaw']) if (!raw(fees[key])) protocol();
  if (BigInt(fees.gasEstimateRaw) <= 0n || BigInt(fees.gasLimitRaw) < BigInt(fees.gasEstimateRaw) ||
    BigInt(fees.maxFeePerGasRaw) < BigInt(fees.maxPriorityFeePerGasRaw) ||
    BigInt(fees.l2BudgetRaw) !== BigInt(fees.gasLimitRaw) * BigInt(fees.maxFeePerGasRaw) ||
    BigInt(fees.l1BudgetRaw) < BigInt(fees.l1FeeUpperBoundRaw) ||
    BigInt(fees.totalNativeBudgetRaw) !== BigInt(fees.l2BudgetRaw) + BigInt(fees.l1BudgetRaw) + BigInt(fees.operatorFeeBudgetRaw) ||
    BigInt(fees.balanceRaw) < BigInt(value.amountRaw) + BigInt(fees.totalNativeBudgetRaw)) protocol();
}
export function prepareRequest(value) {
  object(value, ['quoteId', 'candidateId'], ['quoteId']);
  const result = { quoteId: identifier(value.quoteId, 'quote ID') };
  if (own(value, 'candidateId')) result.candidateId = identifier(value.candidateId, 'candidate ID');
  return result;
}
function protocol() { throw new RouterSdkError('PROTOCOL_ERROR', 'The router returned an invalid API response.'); }
export function responseEnvelope(value, status, kind) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.apiVersion !== API_VERSION ||
      typeof value.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value.requestId)) protocol();
  if (status < 200 || status >= 300) {
    if (!value.error || typeof value.error !== 'object' || !/^[A-Z][A-Z0-9_]{0,95}$/.test(value.error.code) ||
        typeof value.error.message !== 'string' || typeof value.error.retryable !== 'boolean' ||
        value.error.retryAfterMs !== undefined && (!Number.isFinite(value.error.retryAfterMs) || value.error.retryAfterMs < 0)) protocol();
    return value;
  }
  if (own(value, 'error')) protocol();
  if (kind === 'prepare') protocol();
  if (kind === 'quote') {
    if (typeof value.quoteId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value.quoteId) ||
        typeof value.appId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value.appId) || !value.request || typeof value.request !== 'object' ||
        value.readOnly !== true || !(value.execution === false || value.execution?.enabled === false) ||
        !Array.isArray(value.candidates) || !(value.winner === null || typeof value.winner === 'string')) protocol();
    const ids = new Set();
    for (const candidate of value.candidates) {
      validateCandidate(candidate);
      if (ids.has(candidate.id)) protocol();
      ids.add(candidate.id);
    }
    if (value.winner !== null && !ids.has(value.winner)) protocol();
    const winner = value.winner === null ? null : value.candidates.find(candidate => candidate.id === value.winner);
    if (winner && (!winner.eligible || !Number.isInteger(winner.feeBps) || !Number.isInteger(winner.priceImpactBps) ||
        !Number.isSafeInteger(winner.estimatedCompletionMs) || winner.estimatedCompletionMs <= 0)) protocol();
  }
  return value;
}

/** Shared by provisional events and ordinary/final quote response validation. */
export function validateCandidate(candidate) {
  if (!candidate || typeof candidate.id !== 'string' ||
      candidate.executionReady !== false || typeof candidate.eligible !== 'boolean' || typeof candidate.conditional !== 'boolean' ||
      typeof candidate.expectedOutputRaw !== 'string' || !/^\d{1,78}$/.test(candidate.expectedOutputRaw) ||
      typeof candidate.minimumOutputRaw !== 'string' || !/^\d{1,78}$/.test(candidate.minimumOutputRaw) ||
      BigInt(candidate.minimumOutputRaw) > BigInt(candidate.expectedOutputRaw) ||
      candidate.feeBps !== null && (!Number.isSafeInteger(candidate.feeBps) || candidate.feeBps < 0) ||
      candidate.priceImpactBps !== null && (!Number.isSafeInteger(candidate.priceImpactBps) || candidate.priceImpactBps < 0)) protocol();
  return candidate;
}
export function validateQuoteBinding(data, request, quoteId) {
  let snapshot;
  try { snapshot = quoteRequest(data.request); }
  catch { throw new RouterSdkError('PROTOCOL_ERROR', 'The router returned an invalid quote request snapshot.'); }
  if (request !== undefined && JSON.stringify(snapshot) !== JSON.stringify(request) || quoteId !== undefined && data.quoteId !== quoteId)
    throw new RouterSdkError('PROTOCOL_ERROR', 'The router returned a quote for a different request.');
  const winner = data.candidates.find(candidate => candidate.id === data.winner);
  if (winner && (snapshot.maxFeeBps !== null && winner.feeBps > snapshot.maxFeeBps || winner.priceImpactBps > snapshot.maxPriceImpactBps))
    throw new RouterSdkError('PROTOCOL_ERROR', 'The router selected a quote outside the requested cost limits.');
  if (snapshot.routeScope === 'INDEPENDENT' && data.candidates.some(candidate => candidate.routingFamily !== 'INDEPENDENT' ||
      !Array.isArray(candidate.providers) || candidate.providers.some(provider => ['relay', 'aurora', 'debridge'].includes(provider))))
    throw new RouterSdkError('PROTOCOL_ERROR', 'The router returned an aggregator route for an independent-only request.');
  return data;
}
