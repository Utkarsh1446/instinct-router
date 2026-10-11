import { RouterSdkError, invalid } from './errors.js';
import { parseJson } from './json.js';
import { same, validateRecord, validateAction, walletTransaction, transactionHash, validateProgress } from './execution-validation.js';
const fail = (code, message) => { throw new RouterSdkError(code, message); };
const terminal = status => ['COMPLETE','CANCELLED','EXPIRED','FAILED'].includes(status);
const unsentPrepareTimeoutMs = 30000;
const unsent = saved => saved && !saved.transactionHash && (saved.phase === 'PREPARE_PENDING' && !saved.record ||
  saved.phase === 'REVIEW' && saved.record?.status === 'READY' && saved.record.nextAction === 0 &&
  saved.record.claimedActionId === null && saved.record.submissions.length === 0);
const staleUnsent = saved => unsent(saved) && (saved.record ? saved.record.plan.expiresAtMs <= Date.now() :
  Number.isSafeInteger(saved.savedAtMs) && Date.now() - saved.savedAtMs >= unsentPrepareTimeoutMs);
/** Saves public recovery state only; ownership tokens and private wallet material remain in memory. */
export function createExecutionController({ client, wallet, storage, storageKey = 'instinct-router-recovery-v1' }) {
  if (!client || !wallet || typeof storage?.getItem !== 'function' || typeof storage?.setItem !== 'function' ||
    typeof storageKey !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(storageKey)) invalid('Provide a wallet and durable recovery storage.');
  let session, busy = false, progress = null;
  function load() {
    const text = storage.getItem(storageKey); if (text === null) return null;
    if (typeof text !== 'string' || text.length > 262144) fail('RECOVERY_CORRUPTED', 'Saved recovery data cannot be read.');
    try {
      const row = parseJson(text);
      if (row.version !== 1 || !['PREPARE_PENDING','REVIEW','CLAIM_PENDING','CLAIMED','WALLET_PENDING','SUBMIT_PENDING','SUBMITTED','RECOVERY_REQUIRED','COMPLETE','CANCELLED','EXPIRED','FAILED'].includes(row.phase)) throw Error();
      if (row.record) validateRecord(row.record);
      return row;
    } catch { fail('RECOVERY_CORRUPTED', 'Saved recovery data cannot be read. Do not submit a replacement trade.'); }
  }
  function save(row) {
    const text = JSON.stringify({ version: 1, ...row, savedAtMs: Date.now() });
    if (text.length > 262144) fail('RECOVERY_STORAGE_FAILED', 'Recovery data exceeds the local limit.');
    try { storage.setItem(storageKey, text); if (storage.getItem(storageKey) !== text) throw Error(); }
    catch { fail('RECOVERY_STORAGE_FAILED', 'Recovery could not be saved. Wallet signing is blocked.'); }
  }
  function options() {
    if (!session || session.expiresAtMs <= Date.now()) fail('WALLET_SESSION_REQUIRED', 'Verify wallet ownership again to continue.');
    return { walletToken: session.walletToken };
  }
  async function bound(record) {
    const selected = await wallet.getAccount();
    if (selected.chainId !== record.plan.source.chainId || selected.address !== record.plan.sender || !same(selected, session?.wallet))
      fail('WALLET_CHANGED', 'Select the reviewed wallet account and network before continuing.');
  }
  async function exclusive(fn) {
    if (busy) fail('EXECUTION_BUSY', 'An execution operation is already running.');
    busy = true; progress = null; try { return await fn(); } catch (error) { progress = null; throw error; } finally { busy = false; }
  }
  async function reconcileUnsent(saved, auth) {
    if (!unsent(saved)) fail('RECOVERY_REQUIRED', 'This execution requires transaction recovery.');
    if (saved.wallet && !same(saved.wallet, session.wallet)) fail('WALLET_CHANGED', 'Verify the saved execution wallet before recovery.');
    const result = saved.record ? await client.getExecution(saved.record.id, auth) : await client.getActiveExecution(auth);
    if (!result.execution) {
      if (saved.record) fail('PROTOCOL_ERROR', 'The router did not return the saved execution.');
      save({ phase: 'CANCELLED' }); return null;
    }
    validateRecord(result.execution, saved.record); await bound(result.execution);
    save({ phase: result.execution.status === 'READY' ? 'REVIEW' : result.execution.status, record: result.execution });
    return structuredClone(result.execution);
  }
  return Object.freeze({
    getRecovery: () => structuredClone(load()),
    getProgress: () => { if (progress && Date.now()-progress.observedAtMs > 15000) progress = null; return structuredClone(progress); },
    async proveOwnership() {
      return exclusive(async () => {
        const selected = await wallet.getAccount(), challenge = await client.createWalletChallenge(selected);
        if (!same(challenge.wallet, selected)) fail('WALLET_CHANGED', 'Ownership challenge does not match the connected wallet.');
        const signature = await wallet.signMessage(challenge.message, selected);
        if (challenge.expiresAtMs <= Date.now() || !same(await wallet.getAccount(), selected)) fail('WALLET_CHANGED', 'Wallet or ownership challenge changed.');
        const verified = await client.verifyWallet({ challengeId: challenge.challengeId, signature });
        if (!same(verified.wallet, selected)) fail('PROTOCOL_ERROR', 'Ownership verification returned a different wallet.');
        session = verified; return { wallet: { ...session.wallet }, expiresAtMs: session.expiresAtMs };
      });
    },
    async prepare(input) {
      return exclusive(async () => {
        let prior = load();
        if (staleUnsent(prior)) { await reconcileUnsent(prior, options()); prior = load(); }
        if (prior && !terminal(prior.record?.status ?? prior.phase)) fail('RECOVERY_REQUIRED', 'Resume or cancel the saved execution before starting another trade.');
        const auth = options(), selected = await wallet.getAccount();
        if (!same(selected, session.wallet)) fail('WALLET_CHANGED', 'The wallet changed. Verify ownership again.');
        if (input.source && (input.source.chainId !== selected.chainId || input.sender?.toLowerCase() !== selected.address.toLowerCase()))
          fail('WALLET_CHANGED', 'The source account must match the connected wallet.');
        save({ phase: 'PREPARE_PENDING', wallet: selected, expiresAtMs: Date.now() + unsentPrepareTimeoutMs });
        let data;
        try { data = await client.prepareExecution(input, auth); }
        catch (error) {
          // A definitive request rejection still reconciles against the authenticated server.
          // Timeouts, transport failures and conflicts retain their durable pending marker.
          if (error instanceof RouterSdkError && !error.retryable && [400, 422].includes(error.status)) {
            try { await reconcileUnsent(load(), auth); } catch { /* Keep recovery on reconciliation failure. */ }
          }
          throw error;
        }
        await bound(data.execution);
        save({ phase: 'REVIEW', record: data.execution }); return structuredClone(data.execution);
      });
    },
    async execute(review, confirm) {
      return exclusive(async () => {
        if (typeof confirm !== 'function') invalid('An explicit review confirmation callback is required.');
        const saved = load(), auth = options();
        if (!saved?.record || saved.phase !== 'REVIEW' || !same(saved.record, review) || review.status !== 'READY')
          fail('RECOVERY_REQUIRED', 'The exact saved review must be confirmed.');
        await bound(review);
        if (review.plan.expiresAtMs <= Date.now()) fail('QUOTE_EXPIRED', 'The execution review expired. Cancel and request fresh terms.');
        save({ phase: 'CLAIM_PENDING', record: review });
        const claimed = await client.claimExecution(review.id, { reviewHash: review.reviewHash, revision: review.revision }, auth);
        validateRecord(claimed.execution, review); await validateAction(claimed.action, claimed.execution);
        save({ phase: 'CLAIMED', record: claimed.execution });
        try {
          const tx = await walletTransaction(claimed.action, claimed.execution);
          if (await confirm(structuredClone(claimed.execution), structuredClone(claimed.action)) !== true)
            fail('USER_DECLINED', 'The wallet action was not confirmed. Resume this execution before starting another.');
          await bound(claimed.execution);
          if (claimed.execution.plan.expiresAtMs <= Date.now()) fail('QUOTE_EXPIRED', 'The execution review expired before wallet confirmation.');
          save({ phase: 'WALLET_PENDING', record: claimed.execution });
          const start = performance.now(), hash = await wallet.sendTransaction(tx, session.wallet);
          if (!transactionHash(claimed.action.chainId, hash)) fail('WALLET_RESPONSE_INVALID', 'Submission status is unknown. Keep the recovery record.');
          const walletRttMs = Math.round(performance.now() - start);
          save({ phase: 'SUBMIT_PENDING', record: claimed.execution, transactionHash: hash, walletRttMs });
          const reported = await client.submitExecution(review.id, { transactionHash: hash }, auth);
          validateRecord(reported.execution, claimed.execution);
          save({ phase: 'SUBMITTED', record: reported.execution, transactionHash: hash, walletRttMs });
          return structuredClone(reported.execution);
        } catch (error) {
          // Never retry wallet signing or broadcasting. A known hash stays durable even if reporting failed.
          const current = load();
          if (!current?.transactionHash) {
            save({ phase: 'RECOVERY_REQUIRED', record: claimed.execution });
            try { const result = await client.markExecutionUncertain(review.id, auth); save({ phase: 'RECOVERY_REQUIRED', record: result.execution }); } catch { /* Recovery remains saved. */ }
          }
          throw error;
        }
      });
    },
    async resume() {
      return exclusive(async () => {
        const saved = load(); if (!saved) return null; const auth = options();
        if (!saved.record) {
          if (terminal(saved.phase)) return null;
          return reconcileUnsent(saved, auth);
        }
        const reported = saved.phase === 'SUBMITTED' && saved.record.status === 'SUBMITTED' &&
          saved.record.submissions.some(row=>row.actionId===saved.record.plan.actions[saved.record.nextAction]?.id && (!saved.transactionHash || row.hash===saved.transactionHash));
        let result;
        if (reported) {
          await bound(saved.record);
          result = await client.refreshExecution(saved.record.id, auth);
        } else {
          result = await client.getExecution(saved.record.id, auth); validateRecord(result.execution, saved.record); await bound(result.execution);
          if (saved.transactionHash && !result.execution.submissions.some(row => row.hash === saved.transactionHash))
            result = await client.submitExecution(saved.record.id, { transactionHash: saved.transactionHash }, auth);
          if (result.execution.status === 'SUBMITTED' || result.execution.status === 'RECOVERY_REQUIRED' && result.execution.submissions.length)
            result = await client.refreshExecution(saved.record.id, auth);
        }
        validateRecord(result.execution, saved.record);
        const observedProgress = validateProgress(result.progress,result.execution);
        const advanced = result.execution.nextAction > saved.record.nextAction;
        const nextSaved = { ...saved, phase: result.execution.status === 'READY' ? 'REVIEW' : result.execution.status, record: result.execution };
        // Only verified server progress releases the previous action's durable hash.
        // The next action always waits for a fresh explicit execute call.
        if (advanced && result.execution.status === 'READY') { delete nextSaved.transactionHash; delete nextSaved.walletRttMs; }
        save(nextSaved); progress = terminal(result.execution.status) ? null : structuredClone(observedProgress); return structuredClone(result.execution);
      });
    },
    async watch({signal,onUpdate} = {}) {
      return exclusive(async () => {
        if (typeof onUpdate !== 'function') invalid('An execution update callback is required.');
        const saved=load(),auth=options();
        if (!saved?.record || !['SUBMITTED','RECOVERY_REQUIRED'].includes(saved.record.status) ||
          !saved.record.submissions.some(row=>row.actionId===saved.record.plan.actions[saved.record.nextAction]?.id))
          fail('RECOVERY_REQUIRED','Recover the original submission before watching its status.');
        await bound(saved.record);
        if (typeof client.watchExecution !== 'function') throw new RouterSdkError('WATCH_UNAVAILABLE','Status streaming is unavailable.',{status:501});
        let latest=saved.record;
        return client.watchExecution(saved.record.id,{...auth,signal,onUpdate:async (data,timing)=>{
          validateRecord(data.execution,latest);const observed=validateProgress(data.progress,data.execution);
          const nextSaved={...load(),phase:data.execution.status==='READY'?'REVIEW':data.execution.status,record:data.execution};
          if(data.execution.nextAction>latest.nextAction&&data.execution.status==='READY'){delete nextSaved.transactionHash;delete nextSaved.walletRttMs;}
          save(nextSaved);latest=structuredClone(data.execution);progress=terminal(latest.status)?null:structuredClone(observed);
          await onUpdate(structuredClone(latest),timing);
        }});
      });
    },
    async cancel() {
      return exclusive(async () => {
        const saved = load(); if (!saved?.record || saved.record.status !== 'READY') fail('RECOVERY_REQUIRED', 'Only an unclaimed review can be cancelled.');
        const result = await client.cancelExecution(saved.record.id, { reviewHash: saved.record.reviewHash, revision: saved.record.revision }, options());
        validateRecord(result.execution, saved.record); save({ phase: result.execution.status, record: result.execution }); return structuredClone(result.execution);
      });
    },
  });
}
