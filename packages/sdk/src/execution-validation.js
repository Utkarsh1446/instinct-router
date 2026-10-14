import { decodeUnsignedSolanaTransaction } from './solana-transaction.js';
import { validateRelaySolanaAction } from './relay-solana-message.js';
import { RouterSdkError, invalid } from './errors.js';
import { object, identifier, assetRequest } from './validation.js';
export const same = (a, b) => canonical(a) === canonical(b);
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
export async function payloadHash(value) {
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
const fail = () => { throw new RouterSdkError('PROTOCOL_ERROR', 'The router returned an invalid wallet execution response.'); };
const raw = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) < (1n << 256n);
const base58Bytes = (value, length) => {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(value) || value.length > 88) return false;
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n, bytes = 0;
  for (const char of value) n = n * 58n + BigInt(alphabet.indexOf(char));
  while (n) { bytes++; n >>= 8n; }
  return bytes + (value.match(/^1*/)?.[0].length ?? 0) === length;
};
const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
export function walletRequest(value) {
  object(value, ['chainId', 'address'], ['chainId', 'address']);
  const wallet = assetRequest(value);
  if (/^(?:0x0{40}|1{32})$/.test(wallet.address)) invalid('Choose a real wallet address.');
  return wallet;
}
export function walletToken(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) invalid('Invalid wallet session.');
  return value;
}
function validateUnsubmittedExpiry(value){
 const proof=value.unsubmittedExpiry,plan=value.plan,fields=['chainId','feePayer','blockhash','preparedSlot','lastValidBlockHeight','finalizedSlot','finalizedBlockHeight','finalizedBlockHash','observedAtMs','minimumLedgerSlot','firstAvailableBlock','latestSignatureSlot'];
 const n=v=>Number.isSafeInteger(v)&&v>=0;
 if(!proof||Object.keys(proof).length!==fields.length||fields.some(key=>!Object.hasOwn(proof,key))||value.status!=='EXPIRED'||value.nextAction!==0||value.claimedActionId!==null||value.submissions.length||value.receipt!=null||value.destinationReceipt!=null||plan.providerRoute?.sourceVm!=='SOLANA'||plan.source.chainId!=='solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'||plan.actions.length!==1||!['relay-provider-deposit','relay-provider-swap'].includes(plan.actions[0].id)||proof.chainId!==plan.source.chainId||proof.feePayer!==plan.sender||!base58Bytes(proof.blockhash,32)||!base58Bytes(proof.finalizedBlockHash,32)||fields.filter(key=>!['chainId','feePayer','blockhash','finalizedBlockHash'].includes(key)).some(key=>!n(proof[key]))||proof.finalizedSlot<proof.preparedSlot||proof.finalizedBlockHeight<=proof.lastValidBlockHeight||proof.minimumLedgerSlot>proof.preparedSlot||proof.firstAvailableBlock>proof.preparedSlot||proof.latestSignatureSlot>=proof.preparedSlot||proof.observedAtMs<plan.expiresAtMs||proof.observedAtMs>Date.now()+2000)fail();
}
export function validateRecord(value, expected) {
  if (!value || typeof value !== 'object' || Object.hasOwn(value, 'ownerId') || !digest(value.reviewHash) ||
    !Number.isSafeInteger(value.revision) || value.revision < 0 || !['READY','CLAIMED','SUBMITTED','COMPLETE','RECOVERY_REQUIRED','CANCELLED','EXPIRED','FAILED'].includes(value.status)) fail();
  try { identifier(value.id); } catch { fail(); }
  const plan = value.plan;
  if (!plan || !Number.isSafeInteger(plan.expiresAtMs) || plan.expiresAtMs < 0 || !raw(plan.amountRaw) || !raw(plan.minimumOutRaw) ||
    BigInt(plan.amountRaw) <= 0n || BigInt(plan.minimumOutRaw) <= 0n || !Array.isArray(plan.actions) || !plan.actions.length || plan.actions.length > 8 ||
    !Number.isSafeInteger(value.nextAction) || value.nextAction < 0 || value.nextAction > plan.actions.length ||
    !Array.isArray(value.submissions) || value.submissions.length > plan.actions.length || !Array.isArray(plan.nativeCosts) || !plan.nativeCosts.length || plan.nativeCosts.length > 8) fail();
  try {
    assetRequest(plan.source, true); assetRequest(plan.destination, true);
    walletRequest({ chainId: plan.source.chainId, address: plan.sender }); walletRequest({ chainId: plan.destination.chainId, address: plan.recipient });
    identifier(plan.routeId);
    if (!Array.isArray(plan.quoteIds) || !plan.quoteIds.length || plan.quoteIds.length > 8) fail();
    plan.quoteIds.forEach(id => identifier(id));
  } catch { fail(); }
  const providerRoute=plan.providerRoute;
  if(providerRoute!==undefined){
    const vm=chain=>chain.startsWith('eip155:')?'EVM':'SOLANA';
    if(!providerRoute||Object.keys(providerRoute).sort().join(',')!=='destinationConfirmations,destinationVm,mode,provider,quoteHash,requestId,sourceConfirmations,sourceVm'||providerRoute.provider!=='relay'||providerRoute.mode!=='PROVIDER_MANAGED'||!/^0x[0-9a-f]{64}$/.test(providerRoute.requestId)||!digest(providerRoute.quoteHash)||providerRoute.sourceVm!==vm(plan.source.chainId)||providerRoute.destinationVm!==vm(plan.destination.chainId)||(!Number.isSafeInteger(providerRoute.sourceConfirmations)||providerRoute.sourceConfirmations<(providerRoute.sourceVm==='EVM'?12:1)||providerRoute.sourceVm==='SOLANA'&&providerRoute.sourceConfirmations!==1)||!Number.isSafeInteger(providerRoute.destinationConfirmations)||providerRoute.destinationConfirmations<(providerRoute.destinationVm==='EVM'?12:1)||!same(plan.quoteIds,['relay:'+providerRoute.requestId]))fail();
  }
  if(value.unsubmittedExpiry!==undefined)validateUnsubmittedExpiry(value);
  if(expected?.unsubmittedExpiry!==undefined&&!same(expected.unsubmittedExpiry,value.unsubmittedExpiry))fail();
  if(expected&&['CLAIMED','RECOVERY_REQUIRED'].includes(expected.status)&&value.status==='EXPIRED'&&value.unsubmittedExpiry===undefined)fail();
  const ids = new Set();
  for (const action of plan.actions) {
    if (!action || Object.keys(action).some(key => !['id','chainId','payloadHash'].includes(key)) || !digest(action.payloadHash) ||
      action.chainId !== plan.source.chainId || ids.has(action.id)) fail();
    try { identifier(action.id); } catch { fail(); } ids.add(action.id);
  }
  if (!(value.claimedActionId === null || ids.has(value.claimedActionId)) ||
    ['CLAIMED','SUBMITTED'].includes(value.status) && value.claimedActionId !== plan.actions[value.nextAction]?.id ||
    value.status === 'COMPLETE' && (value.nextAction !== plan.actions.length || value.claimedActionId !== null)) fail();
  const submitted = new Set(), hashes = new Set();
  for (const [index, row] of value.submissions.entries()) {
    if (!row || Object.keys(row).sort().join(',') !== 'actionId,hash' || row.actionId !== plan.actions[index].id || submitted.has(row.actionId) || typeof row.hash !== 'string' || !transactionHash(plan.source.chainId, row.hash)) fail();
    const hash = plan.source.chainId.startsWith('eip155:') ? row.hash.toLowerCase() : row.hash;
    if (hashes.has(hash)) fail();
    submitted.add(row.actionId); hashes.add(hash);
  }
  const current = plan.actions[value.nextAction]?.id, count = value.submissions.length;
  if (['CLAIMED','SUBMITTED','FAILED'].includes(value.status) &&
    (!current || value.claimedActionId !== current || count !== value.nextAction + (value.status === 'CLAIMED' ? 0 : 1))) fail();
  if (value.status === 'RECOVERY_REQUIRED' && (!current || !(value.claimedActionId === null && count === value.nextAction ||
    value.claimedActionId === current && [value.nextAction,value.nextAction+1].includes(count)))) fail();
  if (['CANCELLED','EXPIRED'].includes(value.status) && !count && (value.nextAction !== 0 || value.claimedActionId !== null)) fail();
  if (value.status === 'READY' && (value.claimedActionId !== null || value.nextAction >= plan.actions.length ||
    value.submissions.length !== value.nextAction || value.submissions.some((row,index) => row.actionId !== plan.actions[index].id))) fail();
  if (['CANCELLED','EXPIRED'].includes(value.status) && value.submissions.length) {
    const pair = plan.actions.map(row => row.id);
    const usdc = same(pair,['relay-usdc-approve','relay-usdc-deposit']) && plan.source.address === '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' && plan.source.decimals === 6;
    const provider = providerRoute && (same(pair,['relay-provider-approve','relay-provider-deposit'])||same(pair,['relay-provider-approve','relay-provider-swap'])) && plan.source.chainId.startsWith('eip155:') && !/^0x0{40}$/.test(plan.source.address);
    const token = same(pair,['relay-token-approve','relay-token-deposit']) && !/^0x0{40}$/.test(plan.source.address);
    if (value.nextAction !== 1 || value.claimedActionId !== null || value.submissions.length !== 1 ||
      value.submissions[0].actionId !== pair[0] || !(provider || (usdc || token) && plan.source.chainId === 'eip155:8453' && plan.destination.chainId === 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')) fail();
  }
  for (const cost of plan.nativeCosts) if (!cost || cost.chainId !== plan.source.chainId || !raw(cost.amountRaw)) fail();
  if (value.timeline !== undefined) {
    const fields = ['preparedAtMs','claimedAtMs','submittedAtMs','completedAtMs','failedAtMs'];
    if (!value.timeline || Object.keys(value.timeline).some(key => !fields.includes(key)) || !Number.isSafeInteger(value.timeline.preparedAtMs)) fail();
    let last = 0;
    for (const field of fields) if (Object.hasOwn(value.timeline, field)) {
      const time = value.timeline[field];
      if (!Number.isSafeInteger(time) || time < last || time > Date.now()+2000 || expected?.timeline?.[field] !== undefined && expected.timeline[field] !== time) fail();
      last = time;
    }
  }
  const crossChain = plan.source.chainId !== plan.destination.chainId;
  if (value.receipt !== undefined && value.receipt !== null) {
    const receipt = value.receipt;
    if (receipt.chainId !== plan.source.chainId || value.submissions.at(-1)?.hash !== receipt.transactionHash ||
      !raw(receipt.blockNumberRaw) || !(receipt.chainId.startsWith('eip155:') ? /^0x[0-9a-fA-F]{64}$/.test(receipt.blockHash) : base58Bytes(receipt.blockHash,32)) ||
      !Number.isSafeInteger(receipt.observedAtMs) || receipt.observedAtMs < 0 || receipt.observedAtMs > Date.now()+2000 ||
      !Number.isSafeInteger(receipt.confirmations) || receipt.confirmations < (value.status==='COMPLETE'&&providerRoute ? providerRoute.sourceConfirmations : 1) || receipt.chainId.startsWith('solana:') && receipt.confirmations !== 1 || receipt.actualNativeFeeRaw !== undefined && !raw(receipt.actualNativeFeeRaw)) fail();
    if (crossChain && receipt.destinationCredit != null) fail();
    if (receipt.destinationCredit) {
      const credit = receipt.destinationCredit;
      if (!same(credit.asset,plan.destination) || credit.recipient !== plan.recipient || !raw(credit.amountRaw) || BigInt(credit.amountRaw)<BigInt(plan.minimumOutRaw)) fail();
    }
    const receiptAction = value.status === 'COMPLETE' ? plan.actions.at(-1) : plan.actions[value.nextAction];
    if (['COMPLETE','FAILED'].includes(value.status) && !value.submissions.some(row => row.actionId === receiptAction?.id && row.hash === receipt.transactionHash)) fail();
    if (value.status === 'COMPLETE' && !crossChain && !providerRoute && !receipt.destinationCredit) fail();
  }
  if (value.destinationReceipt !== undefined && value.destinationReceipt !== null) {
    const receipt = value.destinationReceipt, credit = receipt.destinationCredit, attribution = receipt.attribution;
    if ((!crossChain && !providerRoute) || !/^(?:eip155:|solana:)/.test(plan.source.chainId) || !/^(?:eip155:|solana:)/.test(plan.destination.chainId) ||
      !['SUBMITTED','RECOVERY_REQUIRED','COMPLETE'].includes(value.status) || !value.receipt || value.receipt.destinationCredit != null ||
      receipt.chainId !== plan.destination.chainId || !transactionHash(receipt.chainId,receipt.transactionHash) ||
      !raw(receipt.blockNumberRaw) || !(receipt.chainId.startsWith('eip155:') ? /^0x[0-9a-fA-F]{64}$/.test(receipt.blockHash) : base58Bytes(receipt.blockHash,32)) || ((providerRoute ? providerRoute.destinationVm==='EVM' : plan.destination.chainId === 'eip155:8453') ? receipt.commitment !== 'canonical' || !Number.isSafeInteger(receipt.confirmations) || receipt.confirmations < (providerRoute?.destinationConfirmations ?? 12) : !plan.destination.chainId.startsWith('solana:') || receipt.commitment !== 'finalized' || Object.hasOwn(receipt,'confirmations')) ||
      !Number.isSafeInteger(receipt.observedAtMs) || receipt.observedAtMs < 0 || receipt.observedAtMs > Date.now()+2000 ||
      !credit || !same(credit.asset,plan.destination) || credit.recipient !== plan.recipient ||
      !raw(credit.amountRaw) || BigInt(credit.amountRaw) < BigInt(plan.minimumOutRaw) ||
      !attribution || Object.keys(attribution).sort().join(',')!==(providerRoute?'basis,provider,requestId,sourceTransactionHash':'provider,requestId,sourceTransactionHash') || attribution.provider !== 'relay' || providerRoute && attribution.basis!=='PROVIDER_STATUS_AND_CHAIN_CREDIT' || !/^0x[0-9a-fA-F]{64}$/.test(attribution.requestId) ||
      plan.quoteIds[0] !== 'relay:' + attribution.requestId || attribution.sourceTransactionHash !== value.receipt.transactionHash ||
      !value.submissions.some(row => row.hash === attribution.sourceTransactionHash)) fail();
  }
  if (value.status === 'COMPLETE' && (!value.receipt || !(crossChain ? value.destinationReceipt : providerRoute ? value.destinationReceipt || value.receipt.destinationCredit : value.receipt.destinationCredit) || value.submissions.length !== plan.actions.length)) fail();
  if (value.status === 'FAILED' && (!value.receipt || !value.submissions.length || value.receipt.destinationCredit)) fail();
  if (expected && (value.id !== expected.id || value.reviewHash !== expected.reviewHash || value.revision < expected.revision ||
    !same(plan, expected.plan) || !same(value.request, expected.request))) fail();
  if (expected) {
    if (value.nextAction < expected.nextAction || value.submissions.length < expected.submissions.length ||
      expected.submissions.some((row,index) => !same(row,value.submissions[index])) ||
      expected.receipt != null && !same(expected.receipt,value.receipt) ||
      expected.destinationReceipt != null && !same(expected.destinationReceipt,value.destinationReceipt) ||
      expected.timeline && (!value.timeline || Object.entries(expected.timeline).some(([key,time]) => value.timeline[key] !== time)) ||
      value.revision === expected.revision && !same(value,expected)) fail();
    if (['COMPLETE','FAILED','CANCELLED','EXPIRED'].includes(expected.status) && value.status !== expected.status) fail();
    if (value.nextAction === expected.nextAction &&
      (['CLAIMED','SUBMITTED','RECOVERY_REQUIRED'].includes(expected.status) && value.status === 'READY' ||
       expected.status === 'SUBMITTED' && value.status === 'CLAIMED')) fail();
  }
  return value;
}
export function validatePreparedRequest(record, input) {
  const request = record.request, plan = record.plan, [whole,fraction=''] = input.amount.split('.');
  const amountRaw = BigInt(whole+fraction.padEnd(input.source.decimals,'0')).toString();
  if (!request || !same(request.source,input.source) || !same(request.destination,input.destination) ||
    request.amountRaw !== amountRaw || request.sender !== input.sender || request.recipient !== input.recipient ||
    request.slippageBps !== input.slippageBps || request.maxFeeBps !== input.maxFeeBps || request.maxPriceImpactBps !== input.maxPriceImpactBps ||
    !same(request.optimization,{objective:input.objective,maxOutputShortfallBps:input.maxOutputShortfallBps}) ||
    !same(request.nativeFeeBudgets,input.nativeFeeBudgets) || !same(plan.source,input.source) || !same(plan.destination,input.destination) ||
    plan.sender !== input.sender || plan.recipient !== input.recipient || plan.amountRaw !== amountRaw ||
    !Number.isSafeInteger(request.deadlineMs) || request.deadlineMs < plan.expiresAtMs) fail();
  const totals = new Map();
  for (const cost of plan.nativeCosts) totals.set(cost.chainId,(totals.get(cost.chainId)??0n)+BigInt(cost.amountRaw));
  for (const [chainId,total] of totals) {
    const budget = input.nativeFeeBudgets.find(row => row.chainId === chainId);
    if (!budget || budget.maxAmountRaw !== null && total > BigInt(budget.maxAmountRaw)) fail();
  }
}
export function transactionHash(chainId, hash) {
  return typeof hash === 'string' && (chainId.startsWith('eip155:') ? /^0x[0-9a-fA-F]{64}$/.test(hash) : base58Bytes(hash,64));
}
export async function validateAction(action, record) {
  const row = record.plan.actions[record.nextAction];
  if (!action || !row || action.id !== row.id || action.chainId !== row.chainId || action.id !== record.claimedActionId ||
    Object.keys(action).some(key => !['id','chainId','payload'].includes(key)) || !action.payload ||
    await payloadHash(action.payload) !== row.payloadHash) fail();
  return action;
}
export function evmTransaction(action, record) {
  const payload = action.payload;
  // This milestone supports locally reconstructed EVM transactions only.
  if (payload.type !== 'EVM_TRANSACTION') throw new RouterSdkError('WALLET_ACTION_UNSUPPORTED', 'This wallet action is not supported.');
  const tx = payload.transaction;
  if (!tx || Object.keys(tx).some(key => !['chainId','type','from','to','data','value','gas','maxFeePerGas','maxPriorityFeePerGas','accessList'].includes(key))) fail();
  if (tx.type !== '0x2' || !Array.isArray(tx.accessList) || tx.accessList.length !== 0) fail();
  if (tx.chainId !== '0x' + BigInt(action.chainId.slice(7)).toString(16) || tx.from !== record.plan.sender ||
    !/^0x[0-9a-fA-F]{40}$/.test(tx.to) || /^0x0{40}$/.test(tx.to) || !/^0x(?:[0-9a-fA-F]{2}){4,16384}$/.test(tx.data)) fail();
  for (const key of ['value','gas','maxFeePerGas','maxPriorityFeePerGas']) if (!/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i.test(tx[key])) fail();
  const nativeBudget = record.plan.nativeCosts.filter(cost => cost.chainId === action.chainId).reduce((total,cost) => total + BigInt(cost.amountRaw), 0n);
  if (BigInt(tx.gas) * BigInt(tx.maxFeePerGas) > nativeBudget || payload.nativeFeeCapRaw !== undefined &&
    (!raw(payload.nativeFeeCapRaw) || BigInt(payload.nativeFeeCapRaw)<=0n || BigInt(payload.nativeFeeCapRaw)>nativeBudget || BigInt(tx.gas)*BigInt(tx.maxFeePerGas)>BigInt(payload.nativeFeeCapRaw))) fail();
  if (BigInt(tx.gas) <= 0n || BigInt(tx.maxFeePerGas) < BigInt(tx.maxPriorityFeePerGas)) fail();
  const plan = record.plan;
  const native = plan.source.address === '0x' + '0'.repeat(40);
  if (native) {
    if (BigInt(tx.value) !== BigInt(plan.amountRaw)) fail();
  } else {
    const usdc = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
    const generic = ['relay-token-approve','relay-token-deposit'].includes(action.id);
    const token = generic ? plan.source.address : usdc;
    const approvalId = generic ? 'relay-token-approve' : 'relay-usdc-approve', depositId = generic ? 'relay-token-deposit' : 'relay-usdc-deposit';
    const depository = '0x4cd00e387622c35bddb9b4c962c136462338bc31';
    const meta = payload.relay;
    const word = value => value.replace(/^0x/,'').padStart(64,'0');
    if (action.chainId !== 'eip155:8453' || !generic && (plan.source.address !== usdc || plan.source.decimals !== 6) ||
      plan.destination.chainId !== 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' ||
      !(same(plan.actions.map(row => row.id), [approvalId,depositId]) || same(plan.actions.map(row => row.id), [depositId])) || BigInt(tx.value) !== 0n ||
      !meta || !/^0x[0-9a-f]{64}$/.test(meta.orderId) || /^0x0{64}$/.test(meta.orderId) ||
      !/^0x[0-9a-f]{64}$/.test(meta.requestId) || !same(plan.quoteIds,['relay:' + meta.requestId])) fail();
    if (generic) {
      const identity=meta.tokenIdentity, implementation=identity?.implementation;
      if (!identity || Object.keys(identity).some(key=>!['address','decimals','codeSha256','implementation'].includes(key)) ||
        identity.address!==token || identity.decimals!==plan.source.decimals || !digest(identity.codeSha256) ||
        implementation !== undefined && (!implementation || Object.keys(implementation).sort().join(',')!=='address,codeSha256,slot' ||
          !/^0x[0-9a-f]{64}$/.test(implementation.slot) || !/^0x[0-9a-f]{40}$/.test(implementation.address) || !digest(implementation.codeSha256))) fail();
    }
    const amount = BigInt(plan.amountRaw).toString(16);
    const approval = action.id === approvalId && record.nextAction === 0;
    const deposit = action.id === depositId && record.nextAction === plan.actions.length - 1;
    if (!(approval || deposit) || tx.to !== (approval ? token : depository) || tx.data !== (approval ?
      '0x095ea7b3' + word(depository) + word(amount) :
      '0xe8017952' + word(plan.sender) + word(token) + word(amount) + meta.orderId.slice(2))) fail();
  }
  return structuredClone(tx);
}

/** Read-only settlement observations never authorize a wallet action or terminal status. */
export function validateProgress(progress, record) {
  if (progress === undefined) return null;
  if (progress === null) fail();
  const keys=['routeId','actionId','sourceTransactionHash','stage','observedAtMs','sourceConfirmations','requiredSourceConfirmations'];
  const destinationStage=progress.stage==='DESTINATION_CONFIRMED';
  if (!progress || typeof progress!=='object' || Array.isArray(progress) ||
    Object.keys(progress).some(key=>![...keys,...(destinationStage?['destination']:[])].includes(key)) || keys.some(key=>!Object.hasOwn(progress,key)) ||
    !['SOURCE_CONFIRMED','DESTINATION_CONFIRMED'].includes(progress.stage) ||
    !['SUBMITTED','RECOVERY_REQUIRED'].includes(record.status) || !record.plan.providerRoute && !(record.plan.source.chainId==='eip155:8453' && record.plan.destination.chainId.startsWith('solana:') || record.plan.source.chainId.startsWith('solana:') && record.plan.destination.chainId==='eip155:8453') ||
    !['relay-native-deposit','relay-usdc-deposit','relay-token-deposit','relay-solana-deposit','relay-provider-deposit','relay-provider-swap'].includes(progress.actionId) ||
    progress.routeId!==record.plan.routeId || progress.actionId!==record.plan.actions[record.nextAction]?.id ||
    !record.submissions.some(row=>row.actionId===progress.actionId && row.hash===progress.sourceTransactionHash) ||
    !Number.isSafeInteger(progress.observedAtMs) || progress.observedAtMs<Math.max(0,Date.now()-15000,record.timeline?.submittedAtMs ?? 0) || progress.observedAtMs>Date.now()+2000 ||
    !Number.isSafeInteger(progress.sourceConfirmations) || progress.sourceConfirmations<1 || progress.requiredSourceConfirmations!==(record.plan.providerRoute?.sourceConfirmations ?? (record.plan.source.chainId.startsWith('solana:') ? 1 : 12))) fail();
  if (destinationStage) {
    const destination=progress.destination;
    if (!destination || typeof destination!=='object' || Array.isArray(destination) ||
      Object.keys(destination).some(key=>!['chainId','transactionHash','asset','recipient','amountRaw','commitment'].includes(key)) ||
      Object.keys(destination).length!==6 || destination.chainId!==record.plan.destination.chainId ||
      !transactionHash(destination.chainId,destination.transactionHash) ||
      !same(destination.asset,record.plan.destination) || destination.recipient!==record.plan.recipient ||
      !raw(destination.amountRaw) || BigInt(destination.amountRaw)<BigInt(record.plan.minimumOutRaw) ||
      !(destination.chainId.startsWith('eip155:') ? ['confirmed','canonical'].includes(destination.commitment) : ['confirmed','finalized'].includes(destination.commitment))) fail();
  }
  return progress;
}

export async function walletTransaction(action, record) {
  if(action.payload?.type==='PROVIDER_REVIEWED_TRANSACTION'){const tx=providerTransaction(action,record);if(await payloadHash(tx)!==action.payload.bindings.transactionHash)fail();return tx;}
  if (action.payload?.type !== 'SOLANA_TRANSACTION') return evmTransaction(action,record);
  try {
    const plan=record.plan,meta=action.payload.relay,order=meta?.orderData,payment=order?.inputs?.[0]?.payment,output=order?.output,credit=output?.payments?.[0];
    if (!/^0x[0-9a-f]{64}$/.test(meta?.orderId) || /^0x0{64}$/.test(meta.orderId)) fail();
    await validateRelaySolanaAction(plan,action);
    const cap=action.payload.nativeFeeCapRaw,total=plan.nativeCosts.reduce((sum,cost)=>sum+BigInt(cost.amountRaw),0n);
    if (!raw(cap) || BigInt(cap)<=0n || BigInt(cap)!==total) fail();
    const priority=(200000n*BigInt(meta?.computeBudget?.microLamports ?? '-1')+999999n)/1000000n;
    if (priority<0n || BigInt(cap)<5000n+priority) fail();
    if (!/^0x[0-9a-f]{64}$/.test(meta?.requestId) || plan.destination.chainId!=='eip155:8453' || plan.destination.address!=='0x'+'0'.repeat(40) || plan.destination.decimals!==18 ||
      plan.source.address==='11111111111111111111111111111111' && plan.source.decimals!==9 ||
      order?.version!=='v1' || order.solverChainId!=='base' || !/^0x[0-9a-fA-F]{40}$/.test(order.solver) ||
      !Array.isArray(order.inputs) || order.inputs.length!==1 || payment?.chainId!=='solana' || payment.currency!==plan.source.address || payment.amount!==plan.amountRaw || payment.weight!=='1' ||
      output?.chainId!=='base' || !Array.isArray(output.payments) || output.payments.length!==1 || credit?.recipient!==plan.recipient || credit.currency!==plan.destination.address ||
      credit.minimumAmount!==plan.minimumOutRaw || !raw(credit.expectedAmount) || BigInt(credit.expectedAmount)<BigInt(plan.minimumOutRaw) ||
      !Array.isArray(output.calls) || output.calls.length || !Array.isArray(order.fees) || order.fees.length ||
      !Number.isSafeInteger(output.deadline) || output.deadline<Math.ceil(plan.expiresAtMs/1000) ||
      output.extraData!=='0x000000000000000000000000b92fe925dc43a0ecde6c8b1a2709c170ec4fff4f') fail();
    const refunds=order.inputs[0].refunds;
    if (!Array.isArray(refunds) || refunds.length!==2 || !same([...refunds].sort((a,b)=>b.chainId.localeCompare(a.chainId)),[
      {chainId:'solana',recipient:plan.sender,currency:plan.source.address,minimumAmount:'0',deadline:output.deadline,extraData:'0x'},
      {chainId:'base',recipient:plan.recipient,currency:plan.destination.address,minimumAmount:'0',deadline:output.deadline,extraData:output.extraData}
    ])) fail();
  } catch { fail(); }
  return structuredClone(action.payload.transaction);
}

export function providerTransaction(action,record){
 const p=action.payload,plan=record.plan,route=plan.providerRoute,spending=p?.spending,rfq=p?.rfq;
 const fields=['type','version','vm','providerId','verification','kind','rfq','spending','transaction'];
 const optional=Object.hasOwn(p,'validation')?['validation']:[];fields.push('bindings');
 if(!route||Object.keys(p).sort().join(',')!==[...fields,...optional].sort().join(',')||p.type!=='PROVIDER_REVIEWED_TRANSACTION'||p.version!==1||p.vm!==route.sourceVm||p.providerId!=='relay'||p.verification!=='TRUSTED_SERVER_FRESH_RFQ'||!['TOKEN_APPROVAL','FUNDING','SWAP'].includes(p.kind)||!rfq||Object.keys(rfq).sort().join(',')!=='commitmentHash,expiresAtMs,requestId'||rfq.requestId!==route.requestId||rfq.commitmentHash!==route.quoteHash||rfq.expiresAtMs!==plan.expiresAtMs||!spending||Object.keys(spending).some(key=>!['asset','amountRaw','nativeValueRaw','nativeFeeCapRaw','approval'].includes(key))||!same(spending.asset,plan.source)||spending.amountRaw!==plan.amountRaw||!raw(spending.nativeValueRaw)||!raw(spending.nativeFeeCapRaw)||BigInt(spending.nativeFeeCapRaw)<=0n)fail();
 const b=p.bindings;if(!b||Object.keys(b).sort().join(',')!=='amountRaw,destination,expiresAtMs,minimumOutRaw,quoteHash,recipient,requestId,sender,slippageBps,source,transactionHash'||b.requestId!==route.requestId||b.quoteHash!==route.quoteHash||!same(b.source,plan.source)||!same(b.destination,plan.destination)||b.sender!==plan.sender||b.recipient!==plan.recipient||b.amountRaw!==plan.amountRaw||b.minimumOutRaw!==plan.minimumOutRaw||b.slippageBps!==record.request.slippageBps||b.expiresAtMs!==plan.expiresAtMs||!digest(b.transactionHash))fail();
 if(p.validation!==undefined&&(!p.validation||Array.isArray(p.validation)||Object.keys(p.validation).some(key=>!['sourceIdentity','evidence','targetIdentity','spender','spenderIdentity','simulationVerified','feeModel','protocol'].includes(key))||p.validation.spender!==undefined&&!/^0x[0-9a-f]{40}$/.test(p.validation.spender)||p.validation.simulationVerified!==undefined&&typeof p.validation.simulationVerified!=='boolean'))fail();
 const ids=plan.actions.map(row=>row.id),approval=p.kind==='TOKEN_APPROVAL';
 if(!(same(ids,['relay-provider-approve','relay-provider-deposit'])||same(ids,['relay-provider-approve','relay-provider-swap'])||same(ids,['relay-provider-deposit'])||same(ids,['relay-provider-swap']))||action.id!==(approval?'relay-provider-approve':p.kind==='SWAP'?'relay-provider-swap':'relay-provider-deposit')||action.chainId!==plan.source.chainId||record.nextAction!==(approval?0:ids.length-1))fail();
 const total=plan.nativeCosts.reduce((sum,cost)=>sum+BigInt(cost.amountRaw),0n);if(BigInt(spending.nativeFeeCapRaw)>total)fail();
 const native=plan.source.address===(p.vm==='EVM'?'0x'+'0'.repeat(40):'11111111111111111111111111111111');
 if(BigInt(spending.nativeValueRaw)!==(native&&!approval?BigInt(plan.amountRaw):0n))fail();
 const t=p.transaction;
 if(p.vm==='SOLANA'){
  if(approval||spending.approval!==undefined)fail();try{decodeUnsignedSolanaTransaction(t);}catch{fail();}if(t.feePayer!==plan.sender)fail();return structuredClone(t);
 }
 if(!t||Object.keys(t).some(key=>!['chainId','type','from','to','data','value','gas','gasPrice','maxFeePerGas','maxPriorityFeePerGas','accessList'].includes(key))||!['0x0','0x2'].includes(t.type)||t.chainId!=='0x'+BigInt(action.chainId.slice(7)).toString(16)||t.from!==plan.sender||!/^0x[0-9a-f]{40}$/.test(t.to)||/^0x0{40}$/.test(t.to)||!/^0x(?:[0-9a-f]{2}){0,65536}$/.test(t.data)||(t.type==='0x2'? !Array.isArray(t.accessList)||t.accessList.length||t.gasPrice!==undefined : t.accessList!==undefined||t.maxFeePerGas!==undefined||t.maxPriorityFeePerGas!==undefined))fail();
 for(const key of (t.type==='0x2'?['value','gas','maxFeePerGas','maxPriorityFeePerGas']:['value','gas','gasPrice']))if(!/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/.test(t[key]))fail();
 if(BigInt(t.value)!==BigInt(spending.nativeValueRaw)||BigInt(t.gas)<=0n||t.type==='0x2'&&BigInt(t.maxFeePerGas)<BigInt(t.maxPriorityFeePerGas)||BigInt(t.gas)*BigInt(t.type==='0x2'?t.maxFeePerGas:t.gasPrice)>BigInt(spending.nativeFeeCapRaw))fail();
 if(approval){const a=spending.approval,word=x=>x.replace(/^0x/,'').padStart(64,'0');if(native||!a||Object.keys(a).sort().join(',')!=='amountRaw,spender'||!/^0x[0-9a-f]{40}$/.test(a.spender)||/^0x0{40}$/.test(a.spender)||a.amountRaw!==plan.amountRaw||t.to!==plan.source.address||t.data!=='0x095ea7b3'+word(a.spender)+word(BigInt(plan.amountRaw).toString(16)))fail();}else if(spending.approval!==undefined)fail();
 return structuredClone(t);
}
