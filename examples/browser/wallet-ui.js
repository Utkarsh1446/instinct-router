import { canonical } from '/sdk/execution-validation.js';
import { pollSettlement } from './settlement-poller.js';
import { renderTradeProgress } from './trade-progress.js';
import { initWalletConnections } from './wallet-connections.js';
import { reviewMatchesInputs } from './wallet-addresses.js';
import { createEvmWallet, createPhantomWallet, createExecutionController } from '/sdk/index.js';
const $ = id => document.getElementById(id);
let connections, controller, review, operation = false, supportedRoutes = [], currentConfig, polling, ownershipUntil = 0, primaryAction;
let progressHidden = false, activeConsent, showCardNotice = false;
const consentFields=['source','destination','source-chain','destination-chain','source-address','destination-address','source-decimals','destination-decimals','amount','sender','recipient','route-scope','objective','slippage','max-fee','native-budget'];
const inputSnapshot=()=>JSON.stringify(consentFields.map(id=>$(id).value));
const consentCurrent=consent=>activeConsent===consent && !consent.cancelled && consent.controller===controller && consent.inputs===inputSnapshot();
function clearConsent() { if (activeConsent) activeConsent.cancelled = true; activeConsent = null; }
const visibleProgress = () => progressHidden ? null : controller?.getProgress();
let recoveryTimer, recoveryKey, recoveryAttempts = 0, recoveryRetryAt = 0, scheduleTimer = setTimeout, cancelTimer = clearTimeout;
const terminal = saved => !saved || ['COMPLETE','CANCELLED','EXPIRED','FAILED'].includes(saved.record?.status ?? saved.phase);
// Only untouched preparation/review may expire automatically. A wallet request,
// claim or known hash always needs authoritative transaction recovery.
function unsentDeadline(saved) {
  if (terminal(saved) || saved.transactionHash) return null;
  if (saved.phase === 'PREPARE_PENDING' && !saved.record) {
    const expires = saved.expiresAtMs ?? saved.savedAtMs + 30000;
    return Number.isSafeInteger(expires) ? expires : null;
  }
  const record = saved.record;
  return saved.phase === 'REVIEW' && record?.status === 'READY' && record.nextAction === 0 &&
    record.claimedActionId === null && record.submissions.length === 0 ? record.plan.expiresAtMs : null;
}
function scheduleUnsentRecovery() {
  if (recoveryTimer !== undefined) cancelTimer(recoveryTimer);
  recoveryTimer = undefined;
  let saved; try { saved = controller?.getRecovery(); } catch { return; }
  const deadline = unsentDeadline(saved), key = deadline === null ? null : `${saved.phase}:${saved.record?.id ?? saved.savedAtMs}:${deadline}`;
  if (key !== recoveryKey) { recoveryKey = key; recoveryAttempts = 0; recoveryRetryAt = 0; }
  if (deadline === null || operation || !connections?.sourceIsReady() || ownershipUntil <= Date.now() || recoveryAttempts >= 3) return;
  const activeController = controller;
  recoveryTimer = scheduleTimer(async () => {
    recoveryTimer = undefined;
    if (activeController !== controller || operation || ownershipUntil <= Date.now()) return;
    const currentDeadline = unsentDeadline(activeController.getRecovery());
    if (currentDeadline === null || currentDeadline > Date.now()) { update(); return; }
    recoveryAttempts++; recoveryRetryAt = Date.now() + 5000 * recoveryAttempts;
    await run(async () => {
      message('The unsent request expired. Checking whether it can be cleared…');
      const result = await activeController.resume();
      if (activeController !== controller) return;
      render(result);
      message(terminal(activeController.getRecovery()) ? 'The expired request was cleared. You can review a new swap.' :
        'The saved request was recovered. Review its current status before continuing.');
    });
  }, Math.max(0, deadline - Date.now(), recoveryRetryAt - Date.now()));
  recoveryTimer?.unref?.();
}
function message(text, error = false, attention = false) {
  const status=$('wallet-status');status.textContent=text;status.dataset.error=String(error);
  showCardNotice=error || attention;
  paintProgress();
}
function paintProgress() {
  const status=$('wallet-status'),container=$('execution-review');
  renderTradeProgress({document,container,record:review,progress:visibleProgress(),config:currentConfig});
  status.hidden=!!review || !status.textContent;
  if(review && showCardNotice && status.textContent) {
    const notice=node('p',status.textContent);notice.className='trade-notice';notice.dataset.error=status.dataset.error;(container.children[0] ?? container).append(notice);
  }
}
function node(tag, text) { const value = document.createElement(tag); value.textContent = text; return value; }
function currentAsset(side) {
  const selected = currentConfig?.assets.find(row => row.id === $(side).value);
  return selected ?? {chainId:$(side+'-chain').value,address:$(side+'-address').value.trim(),decimals:Number($(side+'-decimals').value)};
}
function sameAsset(a,b) { return a.chainId === b.chainId && a.decimals === b.decimals &&
  (a.chainId.startsWith('eip155:') ? a.address.toLowerCase() === b.address.toLowerCase() : a.address === b.address); }
const approvalId=id=>['relay-usdc-approve','relay-token-approve','relay-provider-approve'].includes(id);
const approvalPair=(from,to)=>from==='relay-usdc-approve'&&to==='relay-usdc-deposit'||from==='relay-token-approve'&&to==='relay-token-deposit'||from==='relay-provider-approve'&&['relay-provider-deposit','relay-provider-swap'].includes(to);
function nativeCurrency(chainId=currentAsset('source').chainId) {
  const chain=currentConfig.chains.find(row=>row.chainId===chainId),configured=chain?.nativeCurrency;
  if(configured && Number.isInteger(configured.decimals) && configured.decimals>=0 && configured.decimals<=255 && typeof configured.symbol==='string')return configured;
  const native=currentConfig.assets.find(row=>row.chainId===chainId && (row.native || row.address==='0x'+'0'.repeat(40) || row.address==='11111111111111111111111111111111'));
  return native ? {decimals:native.decimals,symbol:native.symbol} : chainId.startsWith('solana:') ? {decimals:9,symbol:'SOL'} : {decimals:18,symbol:chainId==='eip155:8453'?'ETH':'native token'};
}
function executableRoute() {
  const source=currentAsset('source'),destination=currentAsset('destination');
  const exact=supportedRoutes.find(route=>sameAsset(route.source,source)&&sameAsset(route.destination,destination));
  if(exact)return exact;
  const type=asset=>asset.chainId.startsWith('eip155:') ? asset.address==='0x'+'0'.repeat(40)?'NATIVE':'ERC20' : asset.address==='11111111111111111111111111111111'?'NATIVE':'SPL';
  if(currentConfig.execution?.enabled!==true || currentConfig.capabilities?.walletExecution!==true)return null;
  return currentConfig.execution.executionProfiles?.find(profile=>profile.requiresFreshValidation===true && typeof profile.recipeId==='string' &&
    (profile.sourceChainId===source.chainId || Array.isArray(profile.sourceChainIds)&&profile.sourceChainIds.includes(source.chainId)) && (profile.destinationChainId===destination.chainId || Array.isArray(profile.destinationChainIds)&&profile.destinationChainIds.includes(destination.chainId)) &&
    Array.isArray(profile.sourceAssetTypes)&&profile.sourceAssetTypes.includes(type(source)) && Array.isArray(profile.destinationAssetTypes)&&profile.destinationAssetTypes.includes(type(destination))) ?? null;
}
function nativeBudgetRaw() {
  const value = $('native-budget').value.trim();
  if (value === '') return null;
  if (!/^(0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value) || value.length>334 || (value.split('.')[1]?.length ?? 0)>nativeCurrency().decimals || !/[1-9]/.test(value)) throw Error('Enter a positive native fee cap.');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole + fraction.padEnd(nativeCurrency().decimals, '0')).toString();
}
function reviewIsCurrent() {
  try {
    return connections?.sourceIsReady() && reviewMatchesInputs(review, {
      source: currentAsset('source'), destination: currentAsset('destination'), amount: $('amount').value.trim(),
      sender: $('sender').value, recipient: $('recipient').value, objective: $('objective').value,
      slippageBps: Math.round(Number($('slippage').value) * 100), maxFeeBps: $('max-fee').value.trim() === '' ? null : Math.round(Number($('max-fee').value) * 100),
      nativeBudgetRaw: nativeBudgetRaw(),
    });
  } catch { return false; }
}
function update() {
  $('settlement-stop').textContent = activeConsent ? 'Stop swap flow' : 'Stop status checks';
  connections?.setBusy(operation);
  $('quote-form').inert = operation;
  $('native-budget').disabled = operation;
  $('wallet-verify').disabled = !connections?.sourceIsReady() || operation;
  $('execution-prepare').disabled = !controller || !connections?.sourceIsReady() || !connections?.addressesValid() || operation || !executableRoute();
  const changedReview = review?.status === 'READY' && !reviewIsCurrent();
  $('review-input-warning').hidden = !changedReview;
  $('execution-continue').disabled = !review || review.status !== 'READY' || changedReview || operation;
  $('execution-resume').disabled = !controller || operation;
  $('execution-cancel').disabled = !controller || !review || review.status !== 'READY' || operation;
  updatePrimary();
  scheduleUnsentRecovery();
}
function updatePrimary() {
  const show = (label, detail, action) => { $('swap-primary').textContent = label; $('swap-primary').disabled = !action;
    $('swap-next-step').textContent = detail; $('swap-next-step').hidden = !!review || !detail; primaryAction = action; };
  const chain = currentConfig.chains.find(row => row.chainId === currentAsset('source').chainId)?.name ?? 'the source network';
  let saved;
  try { saved = controller?.getRecovery(); } catch { return show('Saved trade needs recovery', 'Recovery data could not be read. Keep this browser data and resolve the saved trade before sending again.'); }
  if (!operation && connections?.sourceState().busy) return show('Connecting wallet…', '');
  if (operation) {
    const progress = visibleProgress();
    if (saved?.record?.status === 'COMPLETE') return show('Swap complete', 'Your funds have arrived and final confirmation is complete.');
    if (progress?.stage === 'DESTINATION_CONFIRMED') return show('Funds received · finalizing', 'Your funds have arrived. Waiting for final network confirmations.');
    if (approvalPending(saved?.record) || saved?.transactionHash && approvalId(saved.record?.plan.actions[saved.record.nextAction]?.id)) return show(`Confirming ${approvalName()} approval`, `Checking your ${approvalName()} approval. No swap funds were sent.`);
    if (saved?.record?.submissions.some(row=>row.actionId===saved.record.plan.actions[saved.record.nextAction]?.id) || saved?.transactionHash)
      return show('Swap sent · checking delivery', 'Your swap was submitted. Checking delivery and network confirmations.');
    return show('Waiting for wallet or router…', 'Finish the current step before starting another. No second trade will be sent.');
  }
  const active = saved && !['COMPLETE','CANCELLED','EXPIRED','FAILED'].includes(saved.record?.status ?? saved.phase);
  const route = executableRoute();
  if (!active && (!route || $('route-scope').value === 'INDEPENDENT' && route.recipeId.startsWith('relay-')))
    return show('Preview only for this pair', route ? 'Select “All sources” in Settings to use this Relay route.' : 'No executable route is available for this pair. Choose another token or network.');
  const source = connections?.sourceState();
  if (!source?.available) return show('Connect wallet', '');
  if (!source.connected) return show('Connect wallet', '', 'CONNECT');
  if (!source.chainMatches) return show(`Switch wallet to ${chain}`, `Approve the network switch in your source wallet. No funds are sent.`, 'SWITCH');
  if (!source.addressMatches) return show('Connect wallet', '', 'CONNECT');
  const amount = $('amount').value.trim();
  if (!active && (!/^(0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(amount) || amount.length > 334 || !/[1-9]/.test(amount)))
    return show('Enter an amount', 'Choose how much to swap. No amount is selected for you.');
  if (!active && !connections.addressesValid()) return show('Enter destination address', 'Connect the receiving wallet or paste a valid address for the destination chain. It does not need to sign this swap.');
  if (active) {
    const expires = unsentDeadline(saved);
    if (expires !== null && expires <= Date.now()) return show($('execution-prepare').disabled ? 'Clear expired request' : 'Swap',
      'The unsent request expired. We will check and clear it before preparing fresh terms.', $('execution-prepare').disabled ? 'RESUME' : 'SWAP');
    if (saved.phase === 'REVIEW' && review?.status === 'READY') {
      if (review.plan.expiresAtMs <= Date.now() || !reviewIsCurrent()) return show('Cancel old review', approvalReady(review) && review.plan.expiresAtMs <= Date.now() ? approvalNextStep(review) : 'The unsubmitted review expired or its inputs changed. Cancel it before requesting fresh terms.', 'CANCEL');
      const approval = approvalId(review.plan.actions[review.nextAction]?.id);
      return show(approval ? `Approve ${approvalName()}` : 'Swap', approval ? `Approve only the exact ${approvalName()} amount for Relay. After confirmation, review and select Swap to send it.` : approvalReady(review) ? approvalNextStep(review) : 'Check the amount and receiving address above. Your source wallet will ask you to approve the trade.', 'EXECUTE');
    }
    if (approvalPending(saved.record)) return show(`Check ${approvalName()} approval`, `${approvalName()} approval was submitted. No swap funds were sent. Check its original transaction for confirmation before continuing.`, 'RESUME');
    return show('Resume saved trade', saved.phase === 'PREPARE_PENDING' && !saved.record ?
      'The route request did not finish. It expires after 30 seconds and is checked automatically while your wallet login is active. No wallet transaction was requested.' :
      'A trade is already in progress or needs recovery. Check its original submission; do not send it again.', 'RESUME');
  }
  show('Swap', '', 'SWAP');
}
async function ensureOwnership(activeController) {
  if (!activeController || activeController !== controller || !connections.sourceIsReady()) throw Error('Reconnect the source wallet before continuing.');
  if (ownershipUntil > Date.now()) return;
  message('Confirm the sign-in message in your wallet.',false,true);
  const verified = await activeController.proveOwnership();
  if (activeController !== controller || !connections.sourceIsReady()) throw Error('The source wallet changed. Reconnect before continuing.');
  ownershipUntil = verified.expiresAtMs;
}
function approvalName(record = review ?? controller?.getRecovery()?.record) { return (record?.plan.source ? currentConfig?.assets?.find(asset=>sameAsset(asset,record.plan.source))?.symbol : undefined) ?? (record?.plan.actions.some(action=>action.id==='relay-usdc-approve') ? 'USDC' : 'Token'); }
function approvalPending(record) {
  return ['SUBMITTED','RECOVERY_REQUIRED'].includes(record?.status) && approvalId(record.plan.actions[record.nextAction]?.id) &&
    record.submissions.some(row=>approvalId(row.actionId));
}
function approvalReady(record) {
  return record?.status === 'READY' && record.nextAction > 0 && record.submissions.some(row=>approvalId(row.actionId));
}
function approvalNextStep(record) {
  return record.plan.expiresAtMs <= Date.now() ? `${approvalName()} approval confirmed, but the quote expired. No swap funds were sent. Cancel the old review for fresh terms.` : activeConsent && consentCurrent(activeConsent) ? `${approvalName()} approval confirmed. Confirm the swap transaction in your wallet to continue this request.` :
    `${approvalName()} approval confirmed. No swap funds were sent. Review the next step, then select Swap to send the swap. Your wallet will only open after that click.`;
}
function render(record) {
  review=record;showCardNotice=false;
  if (!record) $('wallet-status').textContent='';
  paintProgress();update();
}

async function run(fn) {
  if (operation) return; operation = true; $('quote-form').dispatchEvent(new Event('swapstart')); update();
  try { await fn(); } catch (error) {
    const guidance = { EXECUTION_ECONOMIC_LIMIT: 'Current fees or price impact exceed your limits. Check the route fees below and your Swap settings before requesting fresh terms.',
      EXECUTION_NATIVE_BUDGET_EXCEEDED: 'The estimated gas reserve is above your configured native fee limit. Review Swap settings before requesting fresh terms.',
      EXECUTION_NATIVE_BALANCE_INSUFFICIENT: `The source wallet does not have enough ${nativeCurrency().symbol} for this amount plus gas. Check the input amount and source balance.`,
      EXECUTION_REVIEW_GAS_RESERVE_EXCEEDED: 'Gas costs moved beyond this review’s reserve. Request fresh terms; your configured fee limit has not changed.',
      WALLET_SESSION_REQUIRED: 'Select the swap button again to verify source wallet ownership.',
      WALLET_AUTH_REQUIRED: 'Your wallet login expired or the router restarted. Select the swap button again to verify ownership and recover any saved request.',
      EXECUTION_EVIDENCE_UNAVAILABLE: 'Fresh network checks could not finish. Check the saved request before continuing.' };
    if (['WALLET_AUTH_REQUIRED','WALLET_SESSION_REQUIRED','WALLET_SESSION_EXPIRED','WALLET_TOKEN_INVALID'].includes(error.code)) ownershipUntil = 0;
    let saved, recoveryReadable = false; try { saved = controller?.getRecovery(); recoveryReadable = true; } catch { /* Preserve unreadable recovery. */ }
    if (saved?.record) render(saved.record);
    const evidenceFailed = ['EXECUTION_EVIDENCE_UNAVAILABLE','EXECUTION_UNAVAILABLE','EXECUTION_TIMEOUT','QUOTE_TIMEOUT'].includes(error.code);
    message(evidenceFailed && approvalPending(saved?.record) ? `${approvalName()} approval was submitted, but fresh confirmation checks could not finish. No swap funds were sent. Check the original approval again; do not approve it again.` : evidenceFailed && recoveryReadable && terminal(saved) ? 'Fresh network checks did not finish. The unsent request was cleared. Select Review swap to try again.' :
      `${guidance[error.code] ?? error.message ?? 'Wallet operation failed.'}`, true);
  }
  finally { clearConsent(); operation = false; if (!polling) $('settlement-stop').hidden=true; update(); $('quote-form').dispatchEvent(new Event('swapend')); }
}
async function watchSettlement(record, activeController = controller) {
  if (!(record?.status === 'SUBMITTED' || record?.status === 'RECOVERY_REQUIRED' && activeController.getProgress()) || polling) return;
  progressHidden = false;
  polling = new AbortController(); $('settlement-stop').hidden = false;
  const started=performance.now();
  const renderUpdate=updated=>render(updated);
  let outcome;
  try {
    message(approvalPending(record)?`Tracking ${approvalName()} approval confirmation. No swap funds were sent.`:'Tracking delivery updates. Your wallet will not open again.');
    const result=await activeController.watch({signal:polling.signal,onUpdate:renderUpdate});
    outcome={reason:result.reason==='SETTLED'?result.execution.status:result.reason==='STATE_CHANGED'?'USER_ACTION_REQUIRED':'TIMEOUT',record:result.execution};
  } catch(error) {
    if (polling.signal.aborted) outcome={reason:'STOPPED'};
    else {
      const saved=activeController.getRecovery(),known=saved?.record?.submissions.some(row=>row.actionId===saved.record.plan.actions[saved.record.nextAction]?.id && (!saved.transactionHash||row.hash===saved.transactionHash));
      const fallback=['NETWORK_ERROR'].includes(error.code)||[404,405,501].includes(error.status);
      const remaining=120000-(performance.now()-started);
      if (fallback && known && remaining>0) { clearConsent(); outcome=await pollSettlement({resume:()=>activeController.resume(),hasProgress:()=>activeController.getProgress() !== null,signal:polling.signal,durationMs:remaining,
        onUpdate:renderUpdate,onStatus:state=>message(state==='BACKOFF'?'The status service is busy. Waiting briefly before another check…':approvalPending(record)?`Waiting for ${approvalName()} approval confirmation. No swap funds were sent.`:'Checking delivery and final network confirmations.')}); }
      else outcome={reason:'ERROR',error};
    }
  }
  polling = null; $('settlement-stop').hidden = !activeConsent;
  const texts = {COMPLETE:'Settlement confirmed with matching recipient credit.',FAILED:'The transaction was independently confirmed as failed. Review its receipt before another trade.',
    STOPPED:'Automatic checks stopped. The saved trade remains recoverable with Resume status.',TIMEOUT:'Automatic checks ended after two minutes. Use Resume status later; do not send the trade again.',
    USER_ACTION_REQUIRED:approvalReady(outcome.record) ? approvalNextStep(outcome.record) : 'The saved trade requires your attention. Review its status before another action.'};
  if (['ERROR','STOPPED','TIMEOUT'].includes(outcome.reason)) { progressHidden = true; render(activeController.getRecovery()?.record ?? record); }
  message(outcome.reason === 'ERROR' && approvalPending(record) ? `${approvalName()} approval was submitted, but confirmation checks could not finish. No swap funds were sent. Select Check ${approvalName()} approval to check its original transaction again.` : outcome.reason === 'ERROR' ? `Status checks stopped: ${outcome.error?.code ?? 'REQUEST_FAILED'}. Use Resume status after resolving the issue.` : texts[outcome.reason],outcome.reason==='ERROR',['STOPPED','TIMEOUT'].includes(outcome.reason));
  return outcome;
}
export function initWalletUi(client, getInput, config, timers = {}) {
  scheduleTimer = timers.setTimeout ?? setTimeout; cancelTimer = timers.clearTimeout ?? clearTimeout;
  $('settlement-stop').onclick = () => { clearConsent(); polling?.abort(); message('Stopping status checks. Your submitted swap remains saved.',false,true); };
  currentConfig = config; supportedRoutes = config.execution?.enabled === true && config.capabilities?.walletExecution === true ? config.execution.supportedRoutes ?? [] : [];
  const inputsChanged = () => {
    clearConsent();
    // Clear only the presentation of an old terminal request. Durable recovery
    // and warnings for submitted or uncertain transactions remain untouched.
    if (!operation) {
      try {
        if (terminal(controller?.getRecovery())) {
          message('');
          if (review && terminal({record:review})) { review=null; $('execution-review').replaceChildren(); }
        }
      } catch { /* Unreadable recovery must remain visible and blocking. */ }
    }
    update();
  };
  $('quote-form').addEventListener('input', inputsChanged); $('quote-form').addEventListener('change', inputsChanged);
  $('execution-support').textContent=''; $('execution-support').hidden=true;
  $('execution-prepare').hidden = true;
  connections = initWalletConnections({ config, getChain: side => currentAsset(side).chainId,
    makeEvmWallet: createEvmWallet, makeSolanaWallet: createPhantomWallet, storage:localStorage,
    onSourceChanged(wallet, account) {
      clearConsent();
      $('exact-action').hidden = true;
      ownershipUntil = 0; review = null; $('execution-review').replaceChildren();
      controller = wallet ? createExecutionController({client,wallet,storage:localStorage}) : null;
      if (!account) { message(''); return; }
      message('');
      const saved = controller.getRecovery(); if (saved?.record) render(saved.record);
      else if (saved && !['COMPLETE','CANCELLED','EXPIRED','FAILED'].includes(saved.phase)) message('A prior request needs recovery. Verify source ownership, then resume before another trade.');
    },
    onInputsChanged() { $('quote-form').dispatchEvent(new Event('input', {bubbles:true})); },
    onUpdate: update,
  });
  $('native-budget').placeholder='Automatic fresh '+nativeCurrency().symbol+' reserve';
  $('native-budget').addEventListener('input', () => { clearConsent(); update(); });
  $('wallet-verify').onclick = () => run(async () => {
    await ensureOwnership(controller); message('Source wallet verified.');
  });
  async function prepareReview(activeController, consent) {
    connections.assertAddresses();
    await ensureOwnership(activeController);
    if (consent && !consentCurrent(consent)) return;
    const input = await getInput();
    if (consent && !consentCurrent(consent)) return;
    if (activeController !== controller || !connections.sourceIsReady()) throw Error('The source wallet changed. Reconnect before preparing.');
    input.nativeFeeBudgets = [{chainId:input.source.chainId,maxAmountRaw:nativeBudgetRaw()}];
    message('Preparing your swap…');
    try { render(await activeController.prepare(input)); }
    catch (error) {
      clearConsent();
      // Recover a lost prepare response or clear a rejected request through the
      // authenticated active lookup. Never clear a claimed/unknown submission.
      const saved = activeController.getRecovery();
      if (saved?.phase === 'PREPARE_PENDING' && !saved.record) {
        try { const recovered = await activeController.resume(); render(recovered);
          if (recovered?.status === 'READY') { message('Prepared review recovered. Check its exact terms before continuing.'); return; }
        } catch { /* Keep the durable pending record for explicit recovery. */ }
      }
      else if (saved?.phase === 'REVIEW' && saved.record?.status === 'READY') render(saved.record);
      throw error;
    }
    message('Confirm the swap in your wallet.',false,true);
    return review;
  }
  async function executeReview(activeController, consent) {
    if (!reviewIsCurrent()) throw Error('The inputs or source wallet changed. Prepare a new review before continuing.');
    await ensureOwnership(activeController);
    if (consent && !consentCurrent(consent)) return;
    message('Confirm the swap in your wallet.',false,true);
    let result;
    try {
      result = await activeController.execute(review, async (record, action) => {
        // Clicking Swap confirms the displayed immutable review. The SDK verifies
        // that this claimed action matches it before the wallet's final approval.
        return activeController === controller && record.reviewHash === review?.reviewHash && reviewIsCurrent() &&
          (!consent || consentCurrent(consent) && consent.reviewHash === record.reviewHash && canonical(record.plan) === consent.plan && record.plan.expiresAtMs > Date.now());
      });
    } catch (error) {
      // A failed claim has not opened the wallet. Reconcile its server status;
      // never infer that a late claim or submission failed from a timeout alone.
      if (activeController.getRecovery()?.phase === 'CLAIM_PENDING') {
        try {
          const recovered = await activeController.resume();
          if (activeController === controller) {
            render(recovered);
            if (error.code === 'EXECUTION_REVIEW_GAS_RESERVE_EXCEEDED' && recovered?.status === 'READY' &&
              recovered.nextAction === 0 && recovered.claimedActionId === null && recovered.submissions.length === 0)
              render(await activeController.cancel());
          }
        }
        catch { /* Keep the pending claim if the server cannot resolve it. */ }
      }
      throw error;
    }
    render(result); message(approvalPending(result) ? `${approvalName()} approval submitted. Checking approval confirmation; no swap funds were sent.` : 'Transaction hash recorded. Checking settlement; do not send it again.');
    if (consent && !consentCurrent(consent)) return {reason:'STOPPED',record:result};
    return watchSettlement(result, activeController);
  }
  $('execution-prepare').onclick = () => run(() => prepareReview(controller));
  $('execution-continue').onclick = () => run(() => executeReview(controller));
  async function singleSwap() {
    const activeController = controller;
    const consent = {controller:activeController,cancelled:false,inputs:inputSnapshot()}; activeConsent = consent;
    $('settlement-stop').hidden=false; $('settlement-stop').textContent='Stop swap flow';
    const saved=activeController.getRecovery();
    if (!saved?.record || ['COMPLETE','CANCELLED','EXPIRED','FAILED'].includes(saved.record.status) || unsentDeadline(saved) !== null && unsentDeadline(saved) <= Date.now()) {
      if (terminal(saved)) { review=null; $('execution-review').replaceChildren(); }
      message('Preparing your swap…');
      await prepareReview(activeController,consent);
    }
    if (!consentCurrent(consent)) return;
    if (!reviewIsCurrent() || review?.status !== 'READY' || review.plan.expiresAtMs <= Date.now()) throw Error('Fresh swap terms are required before wallet confirmation.');
    consent.executionId=review.id;consent.reviewHash=review.reviewHash;consent.plan=canonical(review.plan);
    for (let step=review.nextAction;step<review.plan.actions.length;step++) {
      if (!consentCurrent(consent) || !reviewIsCurrent() || review.plan.expiresAtMs <= Date.now()) return;
      const sentAction=review.plan.actions[step]?.id;
      const outcome=await executeReview(activeController,consent);
      if (!outcome || !approvalPair(sentAction,outcome.record?.plan.actions[outcome.record.nextAction]?.id) || outcome.record?.id !== consent.executionId || outcome.reason !== 'USER_ACTION_REQUIRED' || outcome.record?.status !== 'READY' || outcome.record.nextAction !== step+1 || outcome.record.reviewHash !== consent.reviewHash || canonical(outcome.record.plan) !== consent.plan) return;
      if (!consentCurrent(consent) || !reviewIsCurrent() || review.plan.expiresAtMs <= Date.now()) return;
      message(`${approvalName()} approval confirmed. Confirm the swap transaction in your wallet.`);
    }
  }
  $('execution-resume').onclick = () => run(async () => {
    const activeController = controller;
    await ensureOwnership(activeController);
    message('Checking your saved trade…');
    const result = await activeController.resume();
    if (activeController !== controller) return;
    render(result);
    if (!result) return;
    if (['EXPIRED','CANCELLED'].includes(result.status))
      message(`The previous ${result.submissions.length ? 'review' : 'unsent request'} ${result.status.toLowerCase()}. You can start a new swap.`);
    else if (result.status === 'COMPLETE') message('Swap complete. You can start a new swap.');
    else if (result.status === 'FAILED') message('The previous transaction failed on-chain. You can review a new swap.');
    else if (result.status === 'READY') message(approvalReady(result) ? approvalNextStep(result) : 'Your saved swap review is ready. Check the terms, then select Swap.');
    else if (['CLAIMED','RECOVERY_REQUIRED'].includes(result.status))
      message(result.submissions.length ? 'The saved transaction still needs verification. Use Resume saved trade to check it again.' :
        'No transaction hash is recorded. Recovery is still required; check your wallet activity before starting another swap.');
    await watchSettlement(result, activeController);
  });
  $('execution-cancel').onclick = () => run(async () => { const activeController = controller; await ensureOwnership(activeController); render(await activeController.cancel()); message('Old review cancelled. You can request fresh terms.'); });
  $('swap-primary').onclick = async () => {
    update();
    if ($('swap-primary').disabled) return;
    if (primaryAction === 'CONNECT') return connections.connectSource();
    if (primaryAction === 'SWITCH') return connections.switchSourceChain();
    if (['SWAP','EXECUTE'].includes(primaryAction)) return run(singleSwap);
    const target = { VERIFY:'wallet-verify', PREPARE:'execution-prepare', EXECUTE:'execution-continue', RESUME:'execution-resume', CANCEL:'execution-cancel' }[primaryAction];
    if (target && !$(target).disabled) return $(target).onclick();
  };
  update();
  return {assertAddresses: () => connections.assertAddresses(), addressesValid: () => connections.addressesValid()};
}
