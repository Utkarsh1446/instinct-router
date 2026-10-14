import { initTokenSelection, selectedToken } from './token-selection.js';
import { initWalletUi } from './wallet-ui.js';
import { initAssetBalances } from './asset-balances.js';
import { createRouterClient } from '/sdk/index.js';
const $ = id => document.getElementById(id);
const status = (message, error = false) => {
  $('status').textContent = message; $('status').dataset.error = String(error);
  $('price-panel').hidden = !error && !$('routes').children.length && $('readiness').hidden;
};
let client, config, active, wallets, previewTimer;
function policy() {
  const bps = (id, maximum) => {
    const value = $(id).value.trim();
    if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/.test(value)) throw Error('Enter a percentage with at most two decimal places.');
    const [whole, fraction = ''] = value.split('.'), result = Number(whole + fraction.padEnd(2, '0'));
    if (!Number.isSafeInteger(result) || result > maximum) throw Error('Choose percentages within the displayed limits.');
    return result;
  };
  return { slippageBps: bps('slippage', 500), maxFeeBps: $('max-fee').value.trim() === '' ? null : bps('max-fee', 10000) };
}
function updateInspection() {
  $('inspect').hidden = true;
  $('inspect').disabled = !!active;
}
function receivingEstimate(route,decimals,priceOnly=false) {
  const output=$('receive-amount');if (!output) return;
  output.textContent=route ? formatUnits(route.expectedOutputRaw,decimals) : '0.00';
  output.dataset.state=route ? priceOnly ? 'estimate' : 'quoted' : 'empty';output.title=route ? 'Estimated receive: '+output.textContent+(priceOnly ? '. Completion time unavailable.' : '.')+' Fresh terms are checked before signing.' : '';
}
function resetInspection() {
  receivingEstimate();
  stopPreview(); $('readiness').hidden = true; $('readiness').replaceChildren(); updateInspection();
  $('routes').replaceChildren(); $('response').textContent = 'Waiting for an amount and wallet addresses.';
  $('timings').textContent = '';
  const amount = $('amount').value.trim();
  if (!client || !wallets?.addressesValid() || !/^(0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(amount) || !/[1-9]/.test(amount)) {
    status(''); return;
  }
  status('Updating route prices…');
  previewTimer = setTimeout(() => {
    if (!$('quote-form').inert) $('quote-form').dispatchEvent(new Event('submit', {cancelable:true}));
  }, 500);
}
function stopPreview() { clearTimeout(previewTimer); active?.abort(); active = null; }
function renderInspection(result) {
  const box = $('readiness'); box.hidden = false; box.replaceChildren();
  const heading = document.createElement('h2'); heading.textContent = 'Wallet readiness'; box.append(heading);
  const card = document.createElement('div'); card.className = 'route';
  const title = document.createElement('strong'); title.textContent = result.status === 'READY_FOR_REVIEW' ? 'Uniswap V3 simulation passed' : 'Readiness check blocked'; card.append(title);
  const lines = [`Checked in ${result.inspectionRttMs} ms. This check does not submit a trade.`];
  if (result.quote) lines.push(`Expected USDC: ${formatUnits(result.quote.expectedOutputRaw, 6)} · Minimum: ${formatUnits(result.quote.minimumOutputRaw, 6)}`);
  if (result.fees?.totalNativeBudgetRaw !== null && result.fees?.totalNativeBudgetRaw !== undefined)
    lines.push(`Estimated gas budget: ${formatUnits(result.fees.totalNativeBudgetRaw, 18)} ETH (execution, L1 data and operator fees).`);
  lines.push(...result.blockers.map(row => row.message));
  if (result.status === 'READY_FOR_REVIEW') lines.push('The entered wallet covered the input and estimated gas at the checked block. Quotes and fees must be refreshed before signing.');
  lines.push('This inspection is read-only. Use Prepare trade review for an enabled wallet route.');
  for (const text of lines) { const line = document.createElement('p'); line.textContent = text; card.append(line); }
  box.append(card); $('response').textContent = JSON.stringify(result, null, 2);
}

function priceOnlyPreview(result) {
  return result.candidates.filter(route=>{
    const reasons=result.excluded?.find(row=>row.id===route.id)?.reasons;
    return !route.eligible && reasons?.length===1 && reasons[0]==='UNKNOWN_COMPLETION_TIME' &&
      ['QUOTE_VALIDATED','EXECUTION_VALIDATED'].includes(route.validationTier) &&
      Number.isSafeInteger(route.feeBps) && route.feeBps>=0 && Number.isSafeInteger(route.priceImpactBps) && route.priceImpactBps>=0 &&
      Number.isSafeInteger(route.validUntilMs) && route.validUntilMs>Date.now() &&
      /^(?:[1-9][0-9]*)$/.test(route.minimumOutputRaw) && /^(?:[1-9][0-9]*)$/.test(route.expectedOutputRaw);
  }).sort((a,b)=>BigInt(a.minimumOutputRaw)>BigInt(b.minimumOutputRaw)?-1:BigInt(a.minimumOutputRaw)<BigInt(b.minimumOutputRaw)?1:a.id.localeCompare(b.id))[0];
}
function render(result, rtt, firstRtt, firstEligibleRtt) {
  const selected=result.candidates.find(route=>route.id===result.winner && route.eligible),preview=selected?undefined:priceOnlyPreview(result);
  receivingEstimate(selected??preview,result.request.destination.decimals,!!preview);
  $('response').textContent = JSON.stringify(result, null, 2);
  $('timings').textContent = `First preview: ${firstRtt === null ? 'none' : Math.round(firstRtt) + ' ms'} · First price-eligible route: ${firstEligibleRtt === null ? 'none' : Math.round(firstEligibleRtt) + ' ms'} · Full response: ${Math.round(rtt)} ms. ${result.comparisonComplete ? 'All planned comparisons finished.' : 'Some routes could not be compared; see provider details.'} Trade completion times are unmeasured.`;
  $('routes').replaceChildren();
  for (const route of [...result.candidates].sort((a, b) => Number(b.id === result.winner) - Number(a.id === result.winner))) {
    $('routes').append(routeCard(route, result.request.destination.decimals, route.id === result.winner));
  }
  if (!result.candidates.length) { const node = document.createElement('p'); node.className = 'empty'; node.textContent = 'No routes found. Try a different amount or token.'; $('routes').append(node); }
  status(preview ? 'Estimated receive shown. Completion time is unavailable, so this route is excluded from speed ranking. Fresh terms are checked in your swap review.' : result.candidates.length ? 'Final price is confirmed in your swap review.' : '');
}
function routeCard(route, decimals, selected = false, provisional = false) {
    const expired = Number.isSafeInteger(route.validUntilMs) && route.validUntilMs <= Date.now();
    const card = document.createElement('div'); card.className = 'route' + (selected ? ' chosen' : '');
    const heading = document.createElement('strong'); heading.textContent = `${route.providerName} ${provisional ? '· Comparing…' : selected ? '· Selected for pricing' : ''}`;
    card.append(heading);
    const values = [`Expected output: ${formatUnits(route.expectedOutputRaw, decimals)}`,
      `Minimum output preview: ${formatUnits(route.minimumOutputRaw, decimals)}`,
      `Fees: ${route.feeBps === null ? 'Unknown full costs' : route.feeBps / 100 + '%'} · Impact: ${route.priceImpactBps === null ? 'Unknown' : route.priceImpactBps / 100 + '%'}`,
      `Completion estimate: ${route.estimatedCompletionMs === null ? 'Unknown' : (route.estimatedCompletionMs / 1000).toFixed(1) + ' s (configured)'}`,
      expired ? 'This preview has expired. Request a new comparison.' : route.eligible ? 'Eligible for price comparison' : 'Excluded from ranking; see the comparison details',
      provisional ? 'Comparing route prices…' : 'Price preview. The swap review above shows the route you will approve.'];
    for (const value of values) { const node = document.createElement('p'); node.textContent = value; card.append(node); }
    if (route.steps?.length > 1) {
      const node = document.createElement('p');
      const symbol = asset => config.assets.find(row => row.chainId === asset.chainId && (asset.chainId.startsWith('solana:') ? row.address === asset.address : row.address.toLowerCase() === asset.address.toLowerCase()))?.symbol ?? 'Token';
      node.textContent = 'Path: ' + route.steps.map(step => `${symbol(step.source)} → ${symbol(step.destination)}`).join(' · ') + '. Later steps are conditional on actual settled output.';
      card.append(node);
    }
    return card;
}
function formatUnits(raw, decimals) {
  if (!decimals) return raw;
  const value = raw.padStart(decimals + 1, '0');
  const fraction = value.slice(-decimals).replace(/0+$/, '');
  return value.slice(0, -decimals) + (fraction ? '.' + fraction : '');
}
const asset = (side,signal) => selectedToken({side,signal,config,client,document});
$('cancel').addEventListener('click', () => active?.abort());
$('quote-form').addEventListener('submit', async event => {
  event.preventDefault();
  if ($('quote-form').inert) return;
  stopPreview(); receivingEstimate(); active = new AbortController();
  const controller = active; $('submit').disabled = true; updateInspection();
  $('routes').replaceChildren(); $('readiness').hidden = true; $('response').textContent = 'Waiting for the completed quote…';
  $('timings').textContent = 'Waiting for the first validated route…';
  status('Comparing routes in parallel. Results will appear as they arrive…'); const start = performance.now(); let firstRtt = null, firstEligibleRtt = null;
  try {
    wallets.assertAddresses();
    const [source, destination] = await Promise.all([asset('source', controller.signal), asset('destination', controller.signal)]);
    const result = await client.quoteStream({ source, destination, amount: $('amount').value.trim(), sender: $('sender').value.trim(), recipient: $('recipient').value.trim(), objective: $('objective').value, routeScope: $('route-scope').value, ...policy() },
      { signal: controller.signal, onCandidate(route) {
        if (active !== controller || controller.signal.aborted) return;
        firstRtt ??= performance.now() - start;
        if (route.eligible && firstEligibleRtt === null) {firstEligibleRtt=performance.now()-start;receivingEstimate(route,destination.decimals);}
        $('routes').append(routeCard(route, destination.decimals, false, true));
        $('timings').textContent = `First preview: ${Math.round(firstRtt)} ms · Full comparison still running…`;
        status('Comparing routes…');
      } });
    if (active === controller && !controller.signal.aborted) render(result, performance.now() - start, firstRtt, firstEligibleRtt);
  } catch (error) {
    if (active === controller) {
      receivingEstimate();
      $('routes').replaceChildren(); $('response').textContent = 'No completed quote was accepted.';
      $('timings').textContent = 'Comparison did not complete. Request fresh routes.';
      status(`${error.code ?? 'REQUEST_FAILED'}: ${error.message}`, true);
    }
  }
  finally { if (active === controller) { active = null; $('submit').disabled = false; $('cancel').hidden = true; updateInspection(); } }
});
$('inspect').addEventListener('click', async () => {
  if (!$('quote-form').reportValidity()) return;
  active?.abort(); active = new AbortController(); const controller = active;
  $('submit').disabled = true; $('cancel').hidden = false; updateInspection(); status('Checking the wallet, swap simulation and gas budget…');
  try {
    wallets.assertAddresses();
    const [source, destination] = await Promise.all([asset('source', controller.signal), asset('destination', controller.signal)]);
    const result = await client.inspectExecution({ source, destination, amount: $('amount').value.trim(), sender: $('sender').value.trim(), recipient: $('recipient').value.trim(), slippageBps: policy().slippageBps }, { signal: controller.signal });
    if (active === controller && !controller.signal.aborted) { renderInspection(result); status('Read-only wallet check complete. No transaction was submitted.'); }
  } catch (error) { if (active === controller) status(`${error.code ?? 'REQUEST_FAILED'}: ${error.message}`, true); }
  finally { if (active === controller) { active = null; $('submit').disabled = false; $('cancel').hidden = true; updateInspection(); } }
});
$('quote-form').addEventListener('input', resetInspection);
$('quote-form').addEventListener('change', resetInspection);
$('quote-form').addEventListener('swapstart', stopPreview);
try {
  const response = await fetch('/demo-config.json', {cache: 'no-store'});
  if (response.ok === false) throw Error('Router configuration is unavailable.');
  const settings = await response.json();
  // A static deployment shares its origin with /v1; local examples use a separate API port.
  client = createRouterClient({...settings, baseUrl: settings.baseUrl === '' ? window.location.origin : settings.baseUrl});
  config = await client.getConfig();
  $('independent-option').disabled = config.capabilities?.independentRoutes !== true;
  initTokenSelection({config,document,client});
  wallets = initWalletUi(client, async () => ({source:await asset('source'),destination:await asset('destination'),amount:$('amount').value.trim(),sender:$('sender').value.trim(),recipient:$('recipient').value.trim(),objective:$('objective').value,routeScope:$('route-scope').value,...policy()}), config);
  initAssetBalances({client,config,document,window});
  $('submit').disabled = false; updateInspection(); status('');
} catch (error) { status(`Router unavailable: ${error.message}`, true); }
