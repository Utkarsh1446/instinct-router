import { CapabilityRegistry, DynamicRouter, createNearIntentsOneClickAdapter, createRelayAdapter, rankCandidates } from './core/index.js';
import { PRESETS, previewBand } from './presets.js';
import { TESTNET_AUDIT } from './audit.js';
import { formatBps, formatDuration, formatRawAmount, parseDecimalAmount } from './units.js';

const $ = (id) => document.getElementById(id);
const pairSelect = $('pair');
const DRY_STEPS = [
  { id: 'quote', state: 'complete', title: 'Dry quote', detail: 'Ask 1Click with dry:true. No swap is opened.' },
  { id: 'deposit-address', state: 'withheld', title: 'Deposit address', detail: 'Withheld. A live quote would return an origin-chain address. This demo rejects one if it appears.' },
  { id: 'send', state: 'blocked', title: 'Send funds', detail: 'Blocked. There is no address, and this page cannot submit a transfer.' },
  { id: 'audit', state: 'ready', title: 'Audit hash', detail: 'The quote hash can be written to the NEAR testnet contract. That write does not settle the swap.' },
];
let last = null;

function selectedPreset() {
  return PRESETS.find(preset => preset.id === pairSelect.value) ?? PRESETS[0];
}

function fillPreset() {
  const preset = selectedPreset();
  $('amount').value = preset.amount;
  $('sender').value = preset.sender;
  $('recipient').value = preset.recipient;
  $('pair-note').textContent = preset.note;
}

function objective() {
  return $('objective').value;
}

function chainConfig(asset) {
  return {
    chainId: asset.chainId,
    blockchain: asset.blockchain,
    sourceConfirmationMs: asset.confirmationMs,
    destinationVerificationMs: asset.confirmationMs,
  };
}

function relayChain(asset) {
  return {
    chainId: asset.chainId,
    relayChainId: asset.relayChainId,
    relayProtocolChainId: asset.relayProtocolChainId,
    sourceConfirmationMs: asset.confirmationMs,
    destinationVerificationMs: asset.confirmationMs,
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

function buildRequest(preset) {
  const amountRaw = parseDecimalAmount($('amount').value.trim(), preset.source.decimals);
  const sender = $('sender').value.trim();
  const recipient = $('recipient').value.trim();
  const band = previewBand(objective());
  return {
    requestId: `demo-${Date.now()}`,
    source: assetOf(preset.source),
    destination: assetOf(preset.destination),
    amountRaw, sender, recipient,
    slippageBps: 50,
    maxFeeBps: 100,
    maxPriceImpactBps: 500,
    maxCompletionMs: 600_000,
    deadlineMs: Date.now() + 60 * 60 * 1000,
    optimization: { objective: objective(), maxOutputShortfallBps: band },
  };
}

function renderSteps(steps) {
  $('steps').replaceChildren(...steps.map(step => {
    const node = document.createElement('article');
    node.className = 'step';
    node.dataset.state = step.state;
    const title = document.createElement('strong');
    title.textContent = step.title;
    const detail = document.createElement('p');
    detail.textContent = step.detail;
    node.append(title, detail);
    return node;
  }));
}

function providerName(id) {
  if (id === 'near-intents-1click') return 'NEAR Intents 1Click';
  if (id === 'relay') return 'Relay';
  return id;
}

function renderRoutes(ranked, candidates, decimals) {
  const excluded = new Map((ranked.excluded ?? []).map(row => [row.id, row.reasons]));
  $('selection').textContent = ranked.selectionReason === 'NO_ELIGIBLE_ROUTE'
    ? 'No route cleared the limits'
    : ranked.selectionReason.replaceAll('_', ' ').toLowerCase();
  if (!candidates.length) {
    $('routes').replaceChildren(Object.assign(document.createElement('p'), { className: 'empty', textContent: 'No provider returned a quote.' }));
    return;
  }
  const ordered = [...candidates].sort((a, b) => {
    if (a.id === ranked.winner?.id) return -1;
    if (b.id === ranked.winner?.id) return 1;
    return a.id.localeCompare(b.id);
  });
  $('routes').replaceChildren(...ordered.map(candidate => {
    const leg = candidate.legQuotes[0];
    const card = document.createElement('article');
    const reasons = excluded.get(candidate.id) ?? [];
    const selected = candidate.id === ranked.winner?.id;
    card.className = `route${selected ? ' selected' : ''}${reasons.length ? ' excluded' : ''}`;
    const heading = document.createElement('h2');
    heading.textContent = providerName(leg.adapterId);
    if (leg.dryQuote === true) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'DRY QUOTE';
      heading.append(badge);
    }
    const output = document.createElement('p');
    output.className = 'meta';
    output.textContent = `Expected ${formatRawAmount(candidate.expectedOutputRaw, decimals)} · minimum ${formatRawAmount(candidate.minimumOutputRaw, decimals)}`;
    const costs = document.createElement('p');
    costs.className = 'meta';
    costs.textContent = `Fee ${formatBps(candidate.feeBps)} · impact ${formatBps(candidate.priceImpactBps)} · ETA ${formatDuration(candidate.completionMs)}`;
    const status = document.createElement('p');
    status.className = 'status';
    status.textContent = selected ? 'Selected' : reasons.length ? `Excluded: ${reasons.join(', ')}` : 'Eligible, not selected';
    card.append(heading, output, costs, status);
    return card;
  }));
}

function renderDeposit(candidate) {
  const leg = candidate?.legQuotes?.[0];
  if (!leg?.dryDeposit) {
    $('deposit-address').textContent = 'Not issued — dry mode';
    renderSteps(DRY_STEPS);
    return;
  }
  $('deposit-address').textContent = 'Not issued — dry mode';
  renderSteps(leg.dryDeposit.steps);
}

function auditArgs(ranked) {
  const candidate = ranked?.candidates?.find(row => row.legQuotes[0]?.adapterId === 'near-intents-1click')
    ?? last?.result?.candidates?.find(row => row.legQuotes[0]?.adapterId === 'near-intents-1click');
  const leg = candidate?.legQuotes?.[0];
  if (!leg?.quoteHash) return null;
  return {
    route_id: candidate.requestId,
    quote_hash: leg.quoteHash,
    provider_id: 'near-intents-1click',
    expected_out: leg.expectedOutRaw,
    minimum_out: leg.minimumOutRaw,
    fee_bps: leg.feeBps,
    eta_ms: candidate.completionMs,
    objective: objective(),
  };
}

function renderAudit(extra) {
  const args = auditArgs(last?.ranked);
  const lines = [];
  if (!TESTNET_AUDIT.accountId) lines.push('Contract id is printed in the README after deploy.');
  else {
    const account = document.createElement('div');
    account.append('Contract ');
    const link = document.createElement('a');
    link.href = TESTNET_AUDIT.explorerAccount + TESTNET_AUDIT.accountId;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = TESTNET_AUDIT.accountId;
    account.append(link);
    if (TESTNET_AUDIT.recordTxHash) {
      const tx = document.createElement('div');
      tx.append('Sample record ');
      const txLink = document.createElement('a');
      txLink.href = TESTNET_AUDIT.explorerTx + TESTNET_AUDIT.recordTxHash;
      txLink.target = '_blank';
      txLink.rel = 'noreferrer';
      txLink.className = 'hash';
      txLink.textContent = TESTNET_AUDIT.recordTxHash;
      tx.append(txLink);
      account.append(tx);
    }
    if (extra) {
      const recorded = document.createElement('div');
      recorded.className = 'hash';
      recorded.textContent = extra;
      $('audit-body').replaceChildren(account, recorded);
    } else $('audit-body').replaceChildren(account);
    if (args) {
      const block = document.createElement('pre');
      block.className = 'hash';
      block.textContent = `Current dry quote (not submitted by this page)\n${JSON.stringify(args, null, 2)}`;
      $('audit-body').append(block);
    }
    return;
  }
  const node = document.createElement('div');
  node.textContent = lines[0];
  $('audit-body').replaceChildren(node);
  if (args) {
    const block = document.createElement('pre');
    block.className = 'hash';
    block.textContent = JSON.stringify(args, null, 2);
    $('audit-body').append(block);
  }
}

async function readAudit() {
  if (!TESTNET_AUDIT.accountId || !TESTNET_AUDIT.sampleRouteId) return;
  const body = {
    jsonrpc: '2.0', id: 'audit', method: 'query',
    params: {
      request_type: 'call_function', finality: 'final',
      account_id: TESTNET_AUDIT.accountId, method_name: 'get_decision',
      args_base64: btoa(JSON.stringify({ route_id: TESTNET_AUDIT.sampleRouteId })),
    },
  };
  try {
    const response = await fetch(TESTNET_AUDIT.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const payload = await response.json();
    const bytes = payload?.result?.result;
    if (!Array.isArray(bytes)) throw new Error(payload?.error?.message || 'RPC_ERROR');
    const decoded = JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes)));
    const tx = TESTNET_AUDIT.recordTxHash
      ? ` Recorded in ${TESTNET_AUDIT.recordTxHash}.`
      : '';
    renderAudit(decoded
      ? `On-chain sample ${decoded.route_id}: provider ${decoded.provider_id}, hash ${decoded.quote_hash}, output ${decoded.expected_out}.${tx}`
      : `No decision stored for ${TESTNET_AUDIT.sampleRouteId}.`);
  } catch (error) {
    renderAudit(`Could not read the audit contract (${error.message || 'RPC_ERROR'}).`);
  }
}

async function compare(event) {
  event.preventDefault();
  const button = $('compare');
  const preset = selectedPreset();
  button.disabled = true;
  $('form-status').textContent = 'Requesting dry quotes…';
  try {
    const request = buildRequest(preset);
    const source = assetOf(preset.source);
    const destination = assetOf(preset.destination);
    const capabilities = [capability('near-intents-1click', source, destination)];
    const adapters = [createNearIntentsOneClickAdapter({
      chains: [chainConfig(preset.source), chainConfig(preset.destination)],
      assets: [
        { asset: source, assetId: preset.source.assetId },
        { asset: destination, assetId: preset.destination.assetId },
      ],
      fetch: (...args) => fetch(...args),
      previewTtlMs: 20_000,
    })];
    if (preset.relay) {
      capabilities.push(capability('relay', source, destination));
      adapters.push(createRelayAdapter({
        chains: [relayChain(preset.source), relayChain(preset.destination)],
        fetch: (...args) => fetch(...args),
      }));
    }
    const result = await new DynamicRouter(new CapabilityRegistry(capabilities), adapters, {
      quoteBudgetMs: 8_000, providerTimeoutMs: 7_000,
    }).quote(request);
    last = { request, result, ranked: result, preset };
    $('form-status').textContent = result.failures.length
      ? `Finished with ${result.failures.map(failure => failure.code).join(', ')}.`
      : 'Dry comparison finished. Nothing was signed or sent.';
    renderRoutes(result, result.candidates, preset.destination.decimals);
    renderDeposit(result.candidates.find(candidate => candidate.legQuotes[0]?.dryQuote === true));
    renderAudit();
    await readAudit();
  } catch (error) {
    $('form-status').textContent = error?.code || error?.message || 'QUOTE_FAILED';
  } finally {
    button.disabled = false;
  }
}

function rerank() {
  if (!last) return;
  const request = { ...last.request, optimization: { objective: objective(), maxOutputShortfallBps: previewBand(objective()) } };
  try {
    const ranked = { ...last.result, ...rankCandidates(request, last.result.candidates, { nowMs: Date.now() }), request };
    last = { ...last, ranked, request };
    renderRoutes(ranked, last.result.candidates, last.preset.destination.decimals);
    renderAudit();
  } catch (error) {
    $('form-status').textContent = error?.message || 'RANK_FAILED';
  }
}

for (const preset of PRESETS) {
  const option = document.createElement('option');
  option.value = preset.id;
  option.textContent = preset.label;
  pairSelect.append(option);
}
fillPreset();
renderSteps(DRY_STEPS);
renderAudit();
readAudit();
pairSelect.addEventListener('change', () => { last = null; fillPreset(); $('routes').replaceChildren(Object.assign(document.createElement('p'), { className: 'empty', textContent: 'No comparison yet.' })); renderSteps(DRY_STEPS); });
$('objective').addEventListener('change', rerank);
$('quote-form').addEventListener('submit', compare);
