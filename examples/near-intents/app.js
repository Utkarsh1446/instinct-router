import { CapabilityRegistry, DynamicRouter, createNearIntentsOneClickAdapter, createRelayAdapter, rankCandidates } from './core/index.js';
import { PRESETS, previewBand } from './presets.js';
import { TESTNET_AUDIT } from './audit.js';
import { formatDuration, formatRawAmount, parseDecimalAmount } from './units.js';

const COMPARISON_FILE = './data/route-comparison-2026-11-14.json';

const $ = (id) => document.getElementById(id);
let presetId = PRESETS[0].id;
let objectiveName = 'BALANCED';
let last = null;
let onChain = null;

function preset() {
  return PRESETS.find(item => item.id === presetId) ?? PRESETS[0];
}

function objectiveLabel(name = objectiveName) {
  if (name === 'BEST_OUTPUT') return 'Best output';
  if (name === 'FASTEST') return 'Fastest';
  return 'Balanced';
}

function chainLabel(asset) {
  if (asset.blockchain === 'eth') return 'Ethereum';
  if (asset.blockchain === 'base') return 'Base';
  if (asset.blockchain === 'near') return 'NEAR';
  return asset.blockchain;
}

function whereLabel(asset) {
  return `on ${chainLabel(asset)}`;
}

function shorten(value, head = 8, tail = 12) {
  if (typeof value !== 'string' || value.length <= head + tail + 1) return value || '';
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function fillChrome() {
  const current = preset();
  $('source-chain').textContent = chainLabel(current.source);
  $('source-symbol').textContent = current.source.symbol;
  $('dest-chain').textContent = chainLabel(current.destination);
  $('dest-symbol').textContent = current.destination.symbol;
  $('dest-where').textContent = whereLabel(current.destination);
  $('provider-count').textContent = `${current.relay ? '2 providers' : '1 provider'} · ranked by output, fee, ETA`;
  $('pair-note').textContent = current.relay
    ? 'Switch the pair to USDC on NEAR: Relay is not registered there, so only the 1Click dry quote returns.'
    : 'USDC on NEAR is selected. Relay is not registered, so only the 1Click dry quote returns. Switch back to USDC on Base.';
  const amount = $('amount').value.trim() || current.amount;
  $('pair-tag').textContent = `${current.source.symbol} (${chainLabel(current.source)}) → ${current.destination.symbol} (${chainLabel(current.destination)}) · ${amount}`;
  for (const button of document.querySelectorAll('[data-objective]')) {
    button.classList.toggle('on', button.dataset.objective === objectiveName);
  }
}

function chainConfig(asset) {
  return {
    chainId: asset.chainId, blockchain: asset.blockchain,
    sourceConfirmationMs: asset.confirmationMs, destinationVerificationMs: asset.confirmationMs,
  };
}

function relayChain(asset) {
  return {
    chainId: asset.chainId, relayChainId: asset.relayChainId, relayProtocolChainId: asset.relayProtocolChainId,
    sourceConfirmationMs: asset.confirmationMs, destinationVerificationMs: asset.confirmationMs,
  };
}

function capability(adapterId, source, destination) {
  return {
    id: `${adapterId}:direct`, adapterId, source, destination, kind: 'SWAP_BRIDGE',
    validationTier: 'QUOTE_VALIDATED', executionTier: 'NONE', liquidity: 'UNKNOWN', validUntilMs: Date.now() + 600_000,
  };
}

function assetOf(endpoint) {
  return { chainId: endpoint.chainId, address: endpoint.address, decimals: endpoint.decimals };
}

function buildRequest(current) {
  return {
    requestId: `demo-${Date.now()}`,
    source: assetOf(current.source),
    destination: assetOf(current.destination),
    amountRaw: parseDecimalAmount($('amount').value.trim(), current.source.decimals),
    sender: current.sender,
    recipient: current.recipient,
    slippageBps: 50,
    maxFeeBps: 100,
    maxPriceImpactBps: 500,
    maxCompletionMs: 600_000,
    deadlineMs: Date.now() + 60 * 60 * 1000,
    optimization: { objective: objectiveName, maxOutputShortfallBps: previewBand(objectiveName) },
  };
}

function ordered(ranked, candidates) {
  const ids = new Set((ranked.eligible ?? []).map(candidate => candidate.id));
  return [...(ranked.eligible ?? []), ...candidates.filter(candidate => !ids.has(candidate.id))];
}

function deltaText(candidate, winner, decimals) {
  if (!winner || candidate.id === winner.id) return '';
  const diff = BigInt(candidate.expectedOutputRaw) - BigInt(winner.expectedOutputRaw);
  if (diff === 0n) return ' · same output as #1';
  const negative = diff < 0n;
  const text = formatRawAmount((negative ? -diff : diff).toString(), decimals);
  return ` · ${negative ? '−' : '+'}${text} vs #1`;
}

function selectionWhy(winner, rows) {
  if (!winner) return 'No route cleared the output, fee, and ETA limits.';
  const rest = rows.filter(row => row.id !== winner.id && row.expectedOutputRaw && row.completionMs);
  const higherOutput = rest.every(row => BigInt(winner.expectedOutputRaw) >= BigInt(row.expectedOutputRaw));
  const shorterEta = winner.completionMs != null && rest.every(row => row.completionMs == null || winner.completionMs <= row.completionMs);
  if (!rest.length) return 'Selected: only quoted route';
  if (higherOutput && shorterEta) return 'Selected: higher output and shorter ETA on this comparison';
  if (objectiveName === 'BEST_OUTPUT') return 'Selected: highest output';
  if (objectiveName === 'FASTEST') return 'Selected: shortest ETA inside the 2% output band';
  return 'Selected: shortest ETA inside the 0.50% output band';
}

function metric(label, value) {
  const node = document.createElement('div');
  node.append(label);
  const strong = document.createElement('b');
  strong.textContent = value;
  node.append(strong);
  return node;
}

function renderRoutes(ranked, candidates, decimals) {
  const rows = ordered(ranked, candidates);
  const winner = ranked.winner;
  const excluded = new Map((ranked.excluded ?? []).map(row => [row.id, row.reasons]));
  $('receive').textContent = winner ? formatRawAmount(winner.expectedOutputRaw, decimals) : '—';
  if (!rows.length) {
    $('route-list').replaceChildren(Object.assign(document.createElement('p'), { className: 'empty', textContent: 'No provider returned a quote.' }));
    $('cmp').hidden = true;
    return;
  }
  const why = selectionWhy(winner, rows);
  $('route-list').replaceChildren(...rows.map((candidate, index) => {
    const leg = candidate.legQuotes[0];
    const card = document.createElement('article');
    const selected = candidate.id === winner?.id;
    const reasons = excluded.get(candidate.id) ?? [];
    card.className = `route${selected ? ' sel' : ''}`;
    const rank = document.createElement('div');
    rank.className = 'rk';
    rank.textContent = String(index + 1);
    const body = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'pv';
    title.append(leg.adapterId === 'relay' ? 'Relay' : leg.adapterId === 'near-intents-1click' ? 'NEAR Intents 1Click' : leg.adapterId);
    if (leg.adapterId === 'relay') {
      const note = document.createElement('small');
      note.textContent = 'existing adapter · useDepositAddress: false';
      title.append(note);
    }
    if (leg.dryQuote === true) {
      const badge = document.createElement('span');
      badge.className = 'dry';
      badge.textContent = 'DRY QUOTE';
      title.append(badge);
    }
    const stats = document.createElement('div');
    stats.className = 'sp';
    stats.append(
      metric('Output', formatRawAmount(candidate.expectedOutputRaw, decimals)),
      metric('Fee', Number.isInteger(candidate.feeBps) ? `${candidate.feeBps} bps` : 'Unknown'),
      metric('ETA', formatDuration(candidate.completionMs)),
    );
    if (leg.adapterId === 'relay') stats.append(metric('Status', 'quoted · unsigned'));
    if (leg.dryQuote === true) stats.append(metric('Objective', objectiveName));
    body.append(title, stats);
    if (selected) {
      const reason = document.createElement('div');
      reason.className = 'why';
      reason.textContent = why;
      body.append(reason);
    } else if (reasons.length) {
      const reason = document.createElement('div');
      reason.className = 'why';
      reason.textContent = `Excluded: ${reasons.join(', ')}`;
      body.append(reason);
    }
    const output = document.createElement('div');
    output.className = 'out';
    const number = document.createElement('div');
    number.className = 'n';
    number.textContent = formatRawAmount(candidate.expectedOutputRaw, decimals);
    const unit = document.createElement('div');
    unit.className = 'u';
    unit.textContent = `${preset().destination.symbol}${deltaText(candidate, winner, decimals)}`;
    output.append(number, unit);
    card.append(rank, body, output);
    if (leg.dryQuote === true) {
      const deposit = document.createElement('div');
      deposit.className = 'deposit';
      const addr = document.createElement('div');
      addr.className = 'addr';
      addr.append('Deposit address ');
      const issued = document.createElement('b');
      issued.textContent = leg.dryDeposit?.depositAddress ? 'issued' : 'not issued';
      addr.append(issued, ' · response with depositAddress, deadline or timeWhenInactive is rejected');
      const send = document.createElement('button');
      send.type = 'button';
      send.className = 'send';
      send.disabled = true;
      send.textContent = '🔒 Send disabled';
      deposit.append(addr, send);
      const hash = document.createElement('div');
      hash.className = 'hashrow';
      hash.textContent = `quote hash sha256 · ${leg.quoteHash}`;
      card.append(deposit, hash);
    }
    return card;
  }));
  renderComparison(rows, decimals);
}

function barRow(label, values, text) {
  const row = document.createElement('div');
  row.className = 'm';
  const name = document.createElement('span');
  name.textContent = label;
  const bars = document.createElement('div');
  bars.className = 'bars';
  const max = Math.max(...values.map(value => value ?? 0), 0);
  for (const [index, value] of values.entries()) {
    const bar = document.createElement('i');
    if (index === 0) bar.className = 'a';
    const width = value == null || max <= 0 ? 0 : Math.max(value === 0 ? 0 : 4, Math.round((value / max) * 100));
    bar.style.width = `${width}%`;
    bars.append(bar);
  }
  const aside = document.createElement('div');
  aside.className = 'v';
  aside.textContent = text;
  row.append(name, bars, aside);
  return row;
}

function renderComparison(rows, decimals) {
  const box = $('cmp');
  if (rows.length < 1) { box.hidden = true; return; }
  box.hidden = false;
  box.replaceChildren();
  const legend = document.createElement('div');
  legend.className = 'lg';
  rows.forEach((candidate, index) => {
    const item = document.createElement('span');
    const swatch = document.createElement('i');
    swatch.style.background = index === 0 ? 'var(--acc)' : '#d9d8d2';
    const leg = candidate.legQuotes[0];
    item.append(swatch, leg.adapterId === 'relay' ? 'Relay' : 'NEAR Intents 1Click (dry)');
    legend.append(item);
  });
  const spacer = document.createElement('div');
  spacer.className = 'grow';
  const mode = document.createElement('span');
  mode.className = 'mono';
  mode.textContent = `objective: ${objectiveLabel()}`;
  legend.append(spacer, mode);
  const outputs = rows.map(row => Number(row.expectedOutputRaw));
  const fees = rows.map(row => Number.isInteger(row.feeBps) ? row.feeBps : null);
  const etas = rows.map(row => Number.isInteger(row.completionMs) ? row.completionMs : null);
  const outputText = rows.map(row => formatRawAmount(row.expectedOutputRaw, decimals)).join(' / ');
  const feeText = fees.map(fee => fee == null ? 'unknown' : `${fee} bps`).join(' / ');
  const etaText = etas.map(eta => formatDuration(eta)).join(' / ');
  box.append(
    legend,
    barRow('Expected output', outputs, outputText),
    barRow('Fee', fees.map(fee => fee ?? 0), feeText),
    barRow('ETA', etas.map(eta => eta ?? 0), etaText),
  );
  const send = document.createElement('div');
  send.className = 'm';
  const label = document.createElement('span');
  label.textContent = 'Can send now';
  const note = document.createElement('div');
  note.className = 'note';
  note.textContent = rows.length > 1
    ? 'no · no. Both are previews; the 1Click route has no address to fund.'
    : 'no. This quote is a preview; the 1Click route has no address to fund.';
  const value = document.createElement('div');
  value.className = 'v';
  const strong = document.createElement('b');
  strong.textContent = 'quote-only';
  value.append(strong);
  send.append(label, note, value);
  box.append(send);
}

function auditCell(label, value, title) {
  const div = document.createElement('div');
  const span = document.createElement('span');
  span.textContent = label;
  const strong = document.createElement('b');
  strong.textContent = value;
  if (title) strong.title = title;
  div.append(span, strong);
  return div;
}

function renderAudit() {
  const row = $('audit-row');
  if (!onChain) {
    row.replaceChildren(auditCell('route id', 'Reading testnet…'));
    return;
  }
  if (onChain.error) {
    row.replaceChildren(auditCell('route id', onChain.error));
    return;
  }
  row.replaceChildren(
    auditCell('route id', onChain.route_id),
    auditCell('provider', onChain.provider_id),
    auditCell('quote hash', shorten(onChain.quote_hash, 8, 7), onChain.quote_hash),
    auditCell('output', onChain.expected_out),
    auditCell('fee', `${onChain.fee_bps} bps`),
    auditCell('eta', `${onChain.eta_ms} ms`),
    auditCell('objective', onChain.objective),
  );
}

async function readAudit() {
  if (!TESTNET_AUDIT.accountId || !TESTNET_AUDIT.sampleRouteId) {
    onChain = { error: 'Contract id is not configured.' };
    renderAudit();
    return;
  }
  const body = {
    jsonrpc: '2.0', id: 'audit', method: 'query',
    params: {
      request_type: 'call_function', finality: 'final',
      account_id: TESTNET_AUDIT.accountId, method_name: 'get_decision',
      args_base64: btoa(JSON.stringify({ route_id: TESTNET_AUDIT.sampleRouteId })),
    },
  };
  try {
    const response = await fetch(TESTNET_AUDIT.rpcUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const payload = await response.json();
    const bytes = payload?.result?.result;
    if (!Array.isArray(bytes)) throw new Error(payload?.error?.message || 'RPC_ERROR');
    const decoded = JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes)));
    onChain = decoded ?? { error: `No decision stored for ${TESTNET_AUDIT.sampleRouteId}.` };
  } catch (error) {
    onChain = { error: error?.message || 'RPC_ERROR' };
  }
  renderAudit();
}

function setStatus(text, error = false) {
  const node = $('form-status');
  node.textContent = text;
  node.dataset.error = error ? 'true' : 'false';
}

async function compare(event) {
  event.preventDefault();
  const button = $('compare');
  const current = preset();
  button.disabled = true;
  setStatus('Requesting dry quotes…');
  try {
    const request = buildRequest(current);
    const source = assetOf(current.source);
    const destination = assetOf(current.destination);
    const capabilities = [capability('near-intents-1click', source, destination)];
    const adapters = [createNearIntentsOneClickAdapter({
      chains: [chainConfig(current.source), chainConfig(current.destination)],
      assets: [
        { asset: source, assetId: current.source.assetId },
        { asset: destination, assetId: current.destination.assetId },
      ],
      fetch: (...args) => fetch(...args),
      previewTtlMs: 20_000,
    })];
    if (current.relay) {
      capabilities.push(capability('relay', source, destination));
      adapters.push(createRelayAdapter({
        chains: [relayChain(current.source), relayChain(current.destination)],
        fetch: (...args) => fetch(...args),
      }));
    }
    const result = await new DynamicRouter(new CapabilityRegistry(capabilities), adapters, {
      quoteBudgetMs: 8_000, providerTimeoutMs: 7_000,
    }).quote(request);
    last = { request, result, ranked: result, preset: current };
    setStatus(result.failures.length ? `Finished with ${result.failures.map(failure => failure.code).join(', ')}.` : '', result.failures.length > 0);
    renderRoutes(result, result.candidates, current.destination.decimals);
  } catch (error) {
    setStatus(error?.code || error?.message || 'QUOTE_FAILED', true);
  } finally {
    button.disabled = false;
  }
}

function rerank() {
  if (!last) return;
  const request = { ...last.request, optimization: { objective: objectiveName, maxOutputShortfallBps: previewBand(objectiveName) } };
  try {
    const ranked = { ...last.result, ...rankCandidates(request, last.result.candidates, { nowMs: Date.now() }), request };
    last = { ...last, ranked, request };
    renderRoutes(ranked, last.result.candidates, last.preset.destination.decimals);
    setStatus('');
  } catch (error) {
    setStatus(error?.message || 'RANK_FAILED', true);
  }
}

function switchPair() {
  presetId = presetId === 'eth-base-usdc' ? 'eth-near-usdc' : 'eth-base-usdc';
  last = null;
  $('amount').value = preset().amount;
  $('receive').textContent = '—';
  $('route-list').replaceChildren(Object.assign(document.createElement('p'), { className: 'empty', textContent: 'No quotes yet. Compare to rank this pair.' }));
  $('cmp').hidden = true;
  setStatus('');
  fillChrome();
}

$('amount').addEventListener('input', fillChrome);
$('pair-note').addEventListener('click', switchPair);
for (const button of document.querySelectorAll('[data-objective]')) {
  button.addEventListener('click', () => {
    objectiveName = button.dataset.objective;
    fillChrome();
    rerank();
  });
}
for (const button of document.querySelectorAll('[data-jump]')) {
  button.addEventListener('click', () => {
    document.getElementById(button.dataset.jump)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}
function quoteLines(quote, failure, excluded, symbol) {
  const cell = document.createElement('td');
  if (!quote) {
    cell.textContent = failure ? `no quote (${failure})` : 'not asked';
    return cell;
  }
  const main = document.createElement('div');
  main.className = 'q';
  main.textContent = `${quote.expectedOut} ${symbol}`;
  const sub = document.createElement('div');
  sub.className = 'sub';
  const fee = Number.isInteger(quote.feeBps) ? `${quote.feeBps} bps` : 'fee unknown';
  sub.textContent = `${fee} · ${formatDuration(quote.completionMs)}`;
  cell.append(main, sub);
  if (excluded?.length) {
    const note = document.createElement('div');
    note.className = 'sub';
    note.textContent = `excluded: ${excluded.join(', ')}`;
    cell.append(note);
  }
  cell.title = `minimum ${quote.minimumOut} ${symbol}`;
  return cell;
}

function renderBoard(documentData) {
  const when = $('board-when');
  const summary = $('board-summary');
  const body = document.querySelector('#board-table tbody');
  if (!documentData?.pairs || !documentData.collectedAt) {
    when.textContent = 'unavailable';
    summary.textContent = 'Stored comparison did not load.';
    return;
  }
  when.dateTime = documentData.collectedAt;
  when.textContent = documentData.collectedAt;
  summary.textContent = documentData.summary || '';
  body.replaceChildren(...documentData.pairs.map(row => {
    const tr = document.createElement('tr');
    const pairCell = document.createElement('td');
    const title = document.createElement('div');
    title.className = 'pair';
    title.textContent = `${row.sourceSymbol} on ${row.sourceChain} → ${row.destinationSymbol} on ${row.destinationChain}`;
    const amount = document.createElement('div');
    amount.className = 'sub';
    amount.textContent = row.amount;
    pairCell.append(title, amount);
    const excluded = new Map((row.excluded ?? []).map(item => [item.provider, item.reasons]));
    const failures = new Map((row.failures ?? []).map(item => [item.provider, item.code]));
    const winner = document.createElement('td');
    winner.className = row.winner ? 'win' : 'none';
    winner.textContent = row.winner === 'near-intents-1click' ? '1Click' : row.winner === 'relay' ? 'Relay' : 'None';
    const why = document.createElement('td');
    why.className = 'why';
    why.textContent = row.why || '';
    tr.append(
      pairCell,
      quoteLines(row.quotes?.['near-intents-1click'], failures.get('near-intents-1click'), excluded.get('near-intents-1click'), row.destinationSymbol),
      quoteLines(row.quotes?.relay, failures.get('relay'), excluded.get('relay'), row.destinationSymbol),
      winner,
      why,
    );
    return tr;
  }));
}

async function loadBoard() {
  try {
    const response = await fetch(COMPARISON_FILE);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    renderBoard(await response.json());
  } catch (error) {
    renderBoard(null);
    $('board-summary').textContent = `Stored comparison did not load (${error?.message || 'FETCH_FAILED'}).`;
  }
}

$('quote-form').addEventListener('submit', compare);
fillChrome();
readAudit();
loadBoard();
