/** Address format checks only; a valid address does not prove wallet control. */
export const walletFamily = chainId => chainId?.startsWith('eip155:') ? 'evm' : chainId?.startsWith('solana:') ? 'solana' : null;
export function normalizeWalletAddress(chainId, value) {
  if (typeof value !== 'string') return null;
  value = value.trim();
  if (walletFamily(chainId) === 'evm') return /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/.test(value) ? value.toLowerCase() : null;
  if (walletFamily(chainId) !== 'solana' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) || value === '1'.repeat(32)) return null;
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let number = 0n, bytes = 0;
  for (const char of value) number = number * 58n + BigInt(alphabet.indexOf(char));
  while (number) { bytes++; number >>= 8n; }
  return bytes + (value.match(/^1*/)?.[0].length ?? 0) === 32 ? value : null;
}

/** A saved execution cannot be approved using changed form inputs. */
export function reviewMatchesInputs(record, input) {
  try {
    const request = record.request;
    const assetMatches = (a, b) => a.chainId === b.chainId && a.decimals === b.decimals &&
      (walletFamily(a.chainId) === 'evm' ? a.address.toLowerCase() === b.address.toLowerCase() : a.address === b.address);
    if (!assetMatches(request.source, input.source) || !assetMatches(request.destination, input.destination) ||
      normalizeWalletAddress(input.source.chainId, input.sender) !== request.sender ||
      normalizeWalletAddress(input.destination.chainId, input.recipient) !== request.recipient ||
      !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(input.amount)) return false;
    const [whole, fraction = ''] = input.amount.split('.');
    if (fraction.length > input.source.decimals || BigInt(whole + fraction.padEnd(input.source.decimals, '0')).toString() !== request.amountRaw) return false;
    return input.slippageBps === request.slippageBps && input.maxFeeBps === request.maxFeeBps &&
      input.objective === request.optimization.objective && input.nativeBudgetRaw === request.nativeFeeBudgets?.find(row => row.chainId === input.source.chainId)?.maxAmountRaw;
  } catch { return false; }
}
