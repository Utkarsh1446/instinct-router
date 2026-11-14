/** Decimal token amounts as integer strings. No floating point. */

export function parseDecimalAmount(value, decimals) {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) throw new Error('INVALID_DECIMALS');
  if (typeof value !== 'string') throw new Error('INVALID_AMOUNT');
  const text = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) throw new Error('INVALID_AMOUNT');
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > decimals) throw new Error('INVALID_AMOUNT');
  const raw = `${whole}${fraction.padEnd(decimals, '0')}`.replace(/^0+(?=\d)/, '');
  if (raw === '0') throw new Error('INVALID_AMOUNT');
  return raw;
}

export function formatRawAmount(raw, decimals) {
  if (typeof raw !== 'string' || !/^(?:0|[1-9]\d*)$/.test(raw)) throw new Error('INVALID_AMOUNT');
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) throw new Error('INVALID_DECIMALS');
  if (decimals === 0) return raw;
  const padded = raw.padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

export function formatDuration(ms) {
  if (!Number.isSafeInteger(ms) || ms < 0) return 'Unknown';
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  return seconds >= 10 ? `${Math.round(seconds)} s` : `${seconds.toFixed(1)} s`;
}

export function formatBps(bps) {
  if (!Number.isSafeInteger(bps) || bps < 0) return 'Unknown';
  const percent = bps / 100;
  return `${Number.isInteger(percent) ? percent.toFixed(0) : percent.toFixed(2)}% (${bps} bps)`;
}
