/** Pure ranking summary for a stored 1Click vs Relay snapshot. No network. */

export const PROVIDERS = ['near-intents-1click', 'relay'];

export const PROVIDER_NAMES = {
  'near-intents-1click': 'NEAR Intents 1Click',
  relay: 'Relay',
};

export const COMPARISON_POLICY = Object.freeze({
  objective: 'BALANCED',
  maxOutputShortfallBps: 50,
  slippageBps: 50,
  maxFeeBps: 100,
  maxPriceImpactBps: 500,
  maxCompletionMs: 600_000,
});

function nameOf(id) {
  return PROVIDER_NAMES[id] ?? id;
}

function excludedMap(pair) {
  return new Map((pair.excluded ?? []).map(row => [row.provider, row.reasons ?? []]));
}

function failureMap(pair) {
  return new Map((pair.failures ?? []).map(row => [row.provider, row.code]));
}

/** Winner under the stored policy. Excluded quotes stay out. Expiry is not rechecked. */
export function deriveWinner(pair, policy = COMPARISON_POLICY) {
  const excluded = excludedMap(pair);
  const eligible = PROVIDERS.filter(id => pair.quotes?.[id] && !excluded.has(id));
  if (!eligible.length) return null;
  const minimum = Object.fromEntries(eligible.map(id => [id, BigInt(pair.quotes[id].minimumOutRaw)]));
  const best = eligible.reduce((out, id) => minimum[id] > out ? minimum[id] : out, 0n);
  const band = BigInt(10000 - policy.maxOutputShortfallBps);
  const inBand = eligible.filter(id => minimum[id] * 10000n >= best * band);
  const valueFirst = policy.objective === 'BEST_OUTPUT';
  inBand.sort((left, right) => {
    const a = pair.quotes[left];
    const b = pair.quotes[right];
    const speed = a.completionMs - b.completionMs;
    const value = minimum[left] > minimum[right] ? -1 : minimum[left] < minimum[right] ? 1 : 0;
    return (valueFirst ? value || speed : speed || value)
      || a.feeBps - b.feeBps
      || a.priceImpactBps - b.priceImpactBps
      || (left < right ? -1 : left > right ? 1 : 0);
  });
  return inBand[0] ?? null;
}

export function explainPair(pair, policy = COMPARISON_POLICY) {
  const quotes = pair.quotes ?? {};
  const excluded = excludedMap(pair);
  const failures = failureMap(pair);
  const winner = pair.winner ?? null;
  const symbol = pair.destinationSymbol;
  if (!winner) {
    const bits = [];
    for (const id of PROVIDERS) {
      if (failures.has(id)) bits.push(`${nameOf(id)} failed (${failures.get(id)})`);
      else if (excluded.has(id)) bits.push(`${nameOf(id)} excluded (${excluded.get(id).join(', ')})`);
      else if (!quotes[id]) bits.push(`${nameOf(id)} was not quoted`);
    }
    return { reasonCode: 'NO_ELIGIBLE', why: `No eligible route. ${bits.join('. ')}.` };
  }
  const winnerName = nameOf(winner);
  const other = PROVIDERS.find(id => id !== winner);
  const win = quotes[winner];
  const rest = quotes[other];
  if (!rest) {
    if (failures.has(other)) {
      return {
        reasonCode: 'OTHER_FAILED',
        why: `${winnerName} won. ${nameOf(other)} returned no quote (${failures.get(other)}).`,
      };
    }
    if (other === 'relay' && pair.relayRegistered === false) {
      return {
        reasonCode: 'ONLY_QUOTE',
        why: `${winnerName} won. Relay is not registered for this destination, so only the 1Click dry quote was requested.`,
      };
    }
    return { reasonCode: 'ONLY_QUOTE', why: `${winnerName} won. It was the only quote returned.` };
  }
  if (excluded.has(other)) {
    return {
      reasonCode: 'OTHER_EXCLUDED',
      why: `${winnerName} won. ${nameOf(other)} was excluded (${excluded.get(other).join(', ')}). ${winnerName} minimum output ${win.minimumOut} ${symbol}, fee ${win.feeBps} bps, ETA ${win.completionMs} ms.`,
    };
  }
  const winMin = BigInt(win.minimumOutRaw);
  const otherMin = BigInt(rest.minimumOutRaw);
  const best = winMin > otherMin ? winMin : otherMin;
  const band = BigInt(10000 - policy.maxOutputShortfallBps);
  const otherInBand = otherMin * 10000n >= best * band;
  if (!otherInBand) {
    return {
      reasonCode: 'OUTSIDE_BAND',
      why: `${winnerName} won under ${policy.objective}. ${nameOf(other)} minimum output ${rest.minimumOut} ${symbol} was outside the ${policy.maxOutputShortfallBps} bps band around the best minimum ${win.minimumOut} ${symbol}.`,
    };
  }
  if (win.completionMs < rest.completionMs) {
    return {
      reasonCode: 'SHORTER_ETA',
      why: `${winnerName} won under ${policy.objective}. Both minimum outputs were inside the ${policy.maxOutputShortfallBps} bps band (${winnerName} ${win.minimumOut} ${symbol}, ${nameOf(other)} ${rest.minimumOut} ${symbol}). ${winnerName} ETA ${win.completionMs} ms was shorter than ${nameOf(other)} ${rest.completionMs} ms.`,
    };
  }
  if (win.completionMs === rest.completionMs && winMin > otherMin) {
    return {
      reasonCode: 'HIGHER_MINIMUM',
      why: `${winnerName} won under ${policy.objective}. ETAs matched at ${win.completionMs} ms, and its minimum output ${win.minimumOut} ${symbol} was higher than ${rest.minimumOut}.`,
    };
  }
  if (win.completionMs === rest.completionMs && winMin === otherMin && win.feeBps < rest.feeBps) {
    return {
      reasonCode: 'LOWER_FEE',
      why: `${winnerName} won under ${policy.objective}. Output and ETA matched. Its fee ${win.feeBps} bps was lower than ${rest.feeBps} bps.`,
    };
  }
  if (win.completionMs === rest.completionMs && winMin === otherMin && win.feeBps === rest.feeBps && win.priceImpactBps < rest.priceImpactBps) {
    return {
      reasonCode: 'LOWER_IMPACT',
      why: `${winnerName} won under ${policy.objective}. Output, ETA, and fee matched. Its price impact ${win.priceImpactBps} bps was lower than ${rest.priceImpactBps} bps.`,
    };
  }
  return {
    reasonCode: 'RANKER_TIEBREAK',
    why: `${winnerName} won under ${policy.objective} (${pair.selectionReason}). Minimum output ${win.minimumOut} vs ${rest.minimumOut} ${symbol}. ETA ${win.completionMs} ms vs ${rest.completionMs} ms. Fee ${win.feeBps} bps vs ${rest.feeBps} bps.`,
  };
}

function reasonSentence(counts) {
  const parts = [];
  const add = (code, text) => { if (counts[code]) parts.push(`${counts[code]} ${text}`); };
  add('SHORTER_ETA', 'by a shorter ETA inside the output band');
  add('OUTSIDE_BAND', 'because the other minimum was outside the output band');
  add('OTHER_EXCLUDED', 'because the other quote was outside the fee, impact, or ETA limit');
  add('OTHER_FAILED', 'because the other provider returned no quote');
  add('ONLY_QUOTE', 'with only one provider quoted');
  add('HIGHER_MINIMUM', 'by a higher minimum output at the same ETA');
  add('LOWER_FEE', 'by a lower fee after output and ETA tied');
  add('LOWER_IMPACT', 'by a lower price impact after output, ETA, and fee tied');
  add('NO_ELIGIBLE', 'with no eligible route');
  add('RANKER_TIEBREAK', 'on the remaining ranker tie-break');
  return parts.length ? `Decisions: ${parts.join('; ')}.` : 'No decisions recorded.';
}

export function buildDocument(pairs, collectedAt, policy = COMPARISON_POLICY) {
  const counts = { pairs: pairs.length, oneClickWins: 0, relayWins: 0, noWinner: 0 };
  const reasonCounts = {};
  for (const pair of pairs) {
    if (pair.winner === 'near-intents-1click') counts.oneClickWins += 1;
    else if (pair.winner === 'relay') counts.relayWins += 1;
    else counts.noWinner += 1;
    reasonCounts[pair.reasonCode] = (reasonCounts[pair.reasonCode] ?? 0) + 1;
  }
  const summary = [
    `Collected ${collectedAt}.`,
    `${counts.pairs} pairs ranked with objective ${policy.objective}.`,
    `A route must clear fee ${policy.maxFeeBps} bps, price impact ${policy.maxPriceImpactBps} bps, and ETA ${policy.maxCompletionMs} ms.`,
    `Inside a ${policy.maxOutputShortfallBps} bps minimum-output band the shorter ETA wins. Outside that band the higher minimum wins.`,
    `NEAR Intents 1Click won ${counts.oneClickWins}. Relay won ${counts.relayWins}. No eligible winner on ${counts.noWinner}.`,
    reasonSentence(reasonCounts),
  ].join(' ');
  return { counts, reasonCounts, summary };
}
