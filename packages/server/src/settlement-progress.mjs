/** Display evidence only. Never persisted as settlement or used to authorize a wallet action. */
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const raw = value => typeof value === 'string' && /^[1-9][0-9]{0,77}$/.test(value) && BigInt(value) < 2n ** 256n;
const signature = value => {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value)) return false;
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n, bytes = 0;
  for (const char of value) n = n * 58n + BigInt(alphabet.indexOf(char));
  while (n) { bytes++; n >>= 8n; }
  return bytes + (value.match(/^1*/)?.[0].length ?? 0) === 64;
};
export function settlementProgress(value, row, now = Date.now()) {
  const fields = ['routeId', 'actionId', 'sourceTransactionHash', 'stage', 'observedAtMs', 'sourceConfirmations', 'requiredSourceConfirmations'];
  const destinationSeen = value?.stage === 'DESTINATION_CONFIRMED';
  const action = row.plan.actions[row.nextAction];
  const managed = row.plan.providerRoute?.mode === 'PROVIDER_MANAGED';
  const reverse = row.plan.source.chainId === 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' && row.plan.destination.chainId === 'eip155:8453';
  if (!['SUBMITTED', 'RECOVERY_REQUIRED'].includes(row.status) ||
    !(managed ? ['relay-provider-deposit', 'relay-provider-swap'].includes(action?.id) : reverse ? action?.id === 'relay-solana-deposit' : ['relay-native-deposit', 'relay-usdc-deposit', 'relay-token-deposit'].includes(action?.id)) ||
    (!managed && !reverse && row.plan.source.chainId !== 'eip155:8453') || !row.plan.routeId.startsWith(managed ? 'relay-provider:' : 'relay:') ||
    !exact(value, destinationSeen ? [...fields, 'destination'] : fields) ||
    !['SOURCE_CONFIRMED', 'DESTINATION_CONFIRMED'].includes(value.stage) ||
    value.routeId !== row.plan.routeId || value.actionId !== action.id ||
    !row.submissions.some(submission => submission.actionId === action.id && submission.hash === value.sourceTransactionHash) ||
    !Number.isSafeInteger(value.observedAtMs) || value.observedAtMs < (row.timeline?.submittedAtMs ?? 0) ||
    value.observedAtMs > now + 2000 || value.observedAtMs < now - 15000 ||
    !Number.isSafeInteger(value.sourceConfirmations) || value.sourceConfirmations < 1 || value.requiredSourceConfirmations !== (managed ? row.plan.providerRoute.sourceConfirmations : reverse ? 1 : 12))
    return undefined;
  if (destinationSeen) {
    const destination = value.destination, expected = row.plan.destination;
    const evmDestination = managed ? expected.chainId.startsWith('eip155:') : reverse;
    if (!exact(destination, ['chainId', 'transactionHash', 'asset', 'recipient', 'amountRaw', 'commitment']) ||
      (!managed && !reverse && expected.chainId !== 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp') || destination.chainId !== expected.chainId ||
      !(evmDestination ? /^0x[0-9a-fA-F]{64}$/.test(destination.transactionHash) : signature(destination.transactionHash)) || !exact(destination.asset, ['chainId', 'address', 'decimals']) ||
      ['chainId', 'address', 'decimals'].some(field => destination.asset[field] !== expected[field]) ||
      destination.recipient !== row.plan.recipient || !raw(destination.amountRaw) ||
      BigInt(destination.amountRaw) < BigInt(row.plan.minimumOutRaw) || !(evmDestination ? ['confirmed','canonical'] : ['confirmed', 'finalized']).includes(destination.commitment))
      return undefined;
  }
  return structuredClone(value);
}
