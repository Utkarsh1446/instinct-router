import { rankCandidates } from './ranking.js';
import { rawAmount, sameAsset, validateRequest, RouterCoreError } from './capabilities.js';
import type { Asset, NativeCost, RouteCandidate, RouterRequest } from './types.js';

export interface CanonicalAction {
  readonly id: string;
  readonly chainId: string;
  /** Bound by a registered recipe. Provider-built transactions explicitly identify their trust mode. */
  readonly payload: Readonly<Record<string, unknown>>;
}
export interface VerifiedWalletPlan {
  readonly routeId: string;
  readonly quoteIds: readonly string[];
  readonly source: Asset;
  readonly destination: Asset;
  readonly sender: string;
  readonly recipient: string;
  readonly amountRaw: string;
  readonly minimumOutRaw: string;
  readonly expiresAtMs: number;
  readonly nativeCosts: readonly NativeCost[];
  readonly actions: readonly CanonicalAction[];
  readonly providerRoute?: ProviderManagedRoute;
}
export interface ProviderManagedRoute {
  readonly provider: 'relay'; readonly mode: 'PROVIDER_MANAGED';
  readonly requestId: string; readonly quoteHash: string;
  readonly sourceConfirmations: number; readonly destinationConfirmations: number;
  readonly sourceVm: 'EVM' | 'SOLANA'; readonly destinationVm: 'EVM' | 'SOLANA';
}
export interface ExecutionRecipe {
  readonly id: string;
  /** Only for immutable contract terms re-simulated at claim. Does not extend a provider's firm offer. */
  readonly maxReviewLifetimeMs?: number;
  /** Independently checks identities/order signature, token behavior, gas,
   * balances/allowance and exact calls against fresh canonical chain evidence. */
  verify(request: RouterRequest, candidate: RouteCandidate): Promise<VerifiedWalletPlan>;
}
export interface ExecutionVerifier {
  isValidTransactionHash(chainId: string, hash: string): boolean;
  /** Recheck canonical approval evidence before abandoning an unfunded plan.
   * Never authorizes release of a claimed or submitted funding action. */
  release?(input: { record: ExecutionRecord }): Promise<{ ready: boolean }>;
  recoverUnsubmitted?(input: { record: ExecutionRecord }): Promise<{ ready: boolean; evidence?: SolanaClaimExpiryEvidence }>;
  preflight(plan: VerifiedWalletPlan, action: CanonicalAction): Promise<{ ready: boolean }>;
  confirm(plan: VerifiedWalletPlan, action: CanonicalAction, hash: string): Promise<{
    success: boolean; routeId: string; actionId: string; transactionHash: string;
    destinationCredit?: { asset: Asset; recipient: string; amountRaw: string };
    confirmedFailure?: boolean;
    receipt?: CanonicalExecutionReceipt;
    destinationReceipt?: CanonicalDestinationReceipt;
  }>;
}
export interface CanonicalExecutionReceipt {
  readonly chainId: string;
  readonly transactionHash: string;
  readonly blockNumberRaw: string;
  readonly blockHash: string;
  readonly observedAtMs: number;
  readonly confirmations: number;
  readonly actualNativeFeeRaw?: string;
  readonly destinationCredit?: { readonly asset: Asset; readonly recipient: string; readonly amountRaw: string };
}
/** Separate chain evidence; source inclusion alone never proves delivery. */
export interface CanonicalDestinationReceipt {
  readonly chainId: string;
  readonly transactionHash: string;
  readonly blockNumberRaw: string;
  readonly blockHash: string;
  readonly observedAtMs: number;
  readonly commitment: 'finalized' | 'canonical';
  /** Canonical Base depth is distinct from L1 finality. Required for Base. */
  readonly confirmations?: number;
  readonly destinationCredit: { readonly asset: Asset; readonly recipient: string; readonly amountRaw: string };
  readonly attribution: { readonly provider: 'relay'; readonly requestId: string; readonly sourceTransactionHash: string;
    readonly basis?: 'PROVIDER_STATUS_AND_CHAIN_CREDIT' };
}
export interface ExecutionTimeline {
  /** Server observations, not source broadcast or cross-chain RTT. */
  readonly preparedAtMs: number;
  readonly claimedAtMs?: number;
  readonly submittedAtMs?: number;
  readonly completedAtMs?: number;
  readonly failedAtMs?: number;
}
export interface ExecutionRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly revision: number;
  readonly status: 'READY' | 'CLAIMED' | 'SUBMITTED' | 'COMPLETE' | 'RECOVERY_REQUIRED' | 'CANCELLED' | 'EXPIRED' | 'FAILED';
  readonly reviewHash: string;
  /** Approved request retained so restart/recovery can verify the review binding. */
  readonly request: RouterRequest;
  readonly plan: VerifiedWalletPlan;
  readonly nextAction: number;
  readonly claimedActionId: string | null;
  readonly submissions: readonly { actionId: string; hash: string }[];
  readonly timeline?: ExecutionTimeline;
  readonly receipt?: CanonicalExecutionReceipt;
  readonly destinationReceipt?: CanonicalDestinationReceipt;
  readonly unsubmittedExpiry?: SolanaClaimExpiryEvidence;
}
/** Finalized expiry plus retained address history, verified independently by the host. */
export interface SolanaClaimExpiryEvidence {
  readonly chainId:string; readonly feePayer:string; readonly blockhash:string;
  readonly preparedSlot:number; readonly lastValidBlockHeight:number;
  readonly finalizedSlot:number; readonly finalizedBlockHeight:number; readonly finalizedBlockHash:string;
  readonly observedAtMs:number; readonly minimumLedgerSlot:number; readonly firstAvailableBlock:number;
  readonly latestSignatureSlot:number;
}
export function isRecoverableUnsubmittedSolanaClaim(row: ExecutionRecord): boolean {
  try { validateProviderManagedPlan(row.plan); } catch { return false; }
  const action=row.plan.actions[0],p=action?.payload as any;
  return ['CLAIMED','RECOVERY_REQUIRED'].includes(row.status) && row.plan.providerRoute?.sourceVm==='SOLANA' &&
    row.plan.source.chainId==='solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' && row.plan.actions.length===1 &&
    ['relay-provider-deposit','relay-provider-swap'].includes(action?.id??'') && ['FUNDING','SWAP'].includes(p?.kind) &&
    row.nextAction===0 && row.claimedActionId===action?.id && row.submissions.length===0 &&
    row.receipt===undefined && row.destinationReceipt===undefined && row.unsubmittedExpiry===undefined;
}
export function validateSolanaClaimExpiryEvidence(row: ExecutionRecord, proof: SolanaClaimExpiryEvidence, nowMs=Date.now(), fresh=false): void {
  const fields=['chainId','feePayer','blockhash','preparedSlot','lastValidBlockHeight','finalizedSlot','finalizedBlockHeight','finalizedBlockHash','observedAtMs','minimumLedgerSlot','firstAvailableBlock','latestSignatureSlot'];
  const action=row.plan.actions[0],p=action?.payload as any,tx=p?.transaction;
  const n=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0;
  const eligible={...row,status:'CLAIMED' as const,claimedActionId:action?.id??null,unsubmittedExpiry:undefined};
  if(!isRecoverableUnsubmittedSolanaClaim(eligible)||!proof||Object.keys(proof).length!==fields.length||fields.some(key=>!Object.hasOwn(proof,key))||
    proof.chainId!==row.plan.source.chainId||proof.feePayer!==row.plan.sender||proof.feePayer!==tx?.feePayer||proof.blockhash!==tx?.blockhash||
    !executionHash(proof.chainId,proof.blockhash,'block')||!executionHash(proof.chainId,proof.finalizedBlockHash,'block')||
    fields.filter(key=>!['chainId','feePayer','blockhash','finalizedBlockHash','latestSignatureSlot'].includes(key)).some(key=>!n((proof as any)[key]))||
    proof.preparedSlot!==p.validation?.evidence?.slot||proof.lastValidBlockHeight!==tx.lastValidBlockHeight||proof.finalizedSlot<proof.preparedSlot||
    proof.finalizedBlockHeight<=proof.lastValidBlockHeight||proof.minimumLedgerSlot>proof.preparedSlot||proof.firstAvailableBlock>proof.preparedSlot||
    !(n(proof.latestSignatureSlot)&&proof.latestSignatureSlot<proof.preparedSlot)||
    proof.observedAtMs<row.plan.expiresAtMs||proof.observedAtMs>nowMs+2000||fresh&&proof.observedAtMs<nowMs-15000)
    fail('INVALID_UNSUBMITTED_EXPIRY_EVIDENCE');
}
/** Host storage must be durable: atomic insert, owner/source-wallet exclusion,
 * and CAS survive restarts. No production in-memory store is provided. */
export interface ExecutionStore {
  insert(record: ExecutionRecord): Promise<boolean>;
  get(id: string): Promise<ExecutionRecord | null>;
  compareAndSwap(id: string, revision: number, next: ExecutionRecord): Promise<boolean>;
}
/** Structural guard shared with durable storage, not a substitute for receipt
 * verification. Only an exact, finite approval may precede release. */
export function isConfirmedBaseUsdcApprovalPrefix(row: ExecutionRecord): boolean {
  if (row.plan.providerRoute) {
    try { validateProviderManagedPlan(row.plan); } catch { return false; }
    const [approval, funding] = row.plan.actions;
    const payload = approval?.payload as any, tx = payload?.transaction, spend = payload?.spending;
    const token = row.plan.source.address, amount = row.plan.amountRaw;
    return row.plan.source.chainId.startsWith('eip155:') && row.nextAction === 1 && row.claimedActionId === null &&
      row.submissions.length === 1 && row.plan.actions.length === 2 && row.submissions[0]?.actionId === 'relay-provider-approve' &&
      approval?.id === 'relay-provider-approve' && ['relay-provider-deposit', 'relay-provider-swap'].includes(funding?.id ?? '') &&
      payload.kind === 'TOKEN_APPROVAL' && /^0x[0-9a-f]{40}$/.test(token) && !/^0x0{40}$/.test(token) &&
      typeof spend?.approval?.spender === 'string' && /^0x[0-9a-f]{40}$/.test(spend.approval.spender) &&
      !/^0x0{40}$/.test(spend.approval.spender) && spend.approval.amountRaw === amount &&
      typeof amount === 'string' && /^[1-9][0-9]{0,77}$/.test(amount) && BigInt(amount) < 2n ** 256n &&
      tx?.chainId === '0x' + BigInt(row.plan.source.chainId.slice(7)).toString(16) && tx.from === row.plan.sender &&
      tx.to === token && tx.value === '0x0' && tx.data === '0x095ea7b3' + spend.approval.spender.slice(2).padStart(64, '0') +
        BigInt(amount).toString(16).padStart(64, '0');
  }
  const base = 'eip155:8453', usdc = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
  const depository = '0x4cd00e387622c35bddb9b4c962c136462338bc31';
  const plan = row.plan, approval = plan.actions[0], deposit = plan.actions[1];
  const tx = approval?.payload.transaction as Record<string, unknown> | undefined;
  const generic = approval?.id === 'relay-token-approve';
  const token = generic ? plan.source.address.toLowerCase() : usdc;
  if (row.nextAction !== 1 || row.claimedActionId !== null || row.submissions.length !== 1 ||
    row.submissions[0]?.actionId !== (generic ? 'relay-token-approve' : 'relay-usdc-approve') || plan.actions.length !== 2 ||
    approval?.id !== (generic ? 'relay-token-approve' : 'relay-usdc-approve') || deposit?.id !== (generic ? 'relay-token-deposit' : 'relay-usdc-deposit') ||
    approval.chainId !== base || deposit.chainId !== base || plan.source.chainId !== base ||
    !/^0x[0-9a-f]{40}$/.test(token) || /^0x0{40}$/.test(token) || plan.source.address.toLowerCase() !== token || (!generic && plan.source.decimals !== 6) ||
    plan.destination.chainId !== 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' ||
    approval.payload.type !== 'EVM_TRANSACTION' || !tx || tx.chainId !== '0x2105' ||
    typeof tx.to !== 'string' || tx.to.toLowerCase() !== token ||
    typeof tx.from !== 'string' || tx.from.toLowerCase() !== plan.sender.toLowerCase() ||
    tx.value !== '0x0' || typeof tx.data !== 'string' || !/^[1-9][0-9]{0,77}$/.test(plan.amountRaw)) return false;
  const amount = BigInt(plan.amountRaw);
  return amount < 2n ** 256n && tx.data.toLowerCase() === '0x095ea7b3' +
    depository.slice(2).padStart(64, '0') + amount.toString(16).padStart(64, '0');
}
function canonical(value: unknown, depth = 0): string {
  if (depth > 32) fail('INVALID_REVIEW_PAYLOAD');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object') fail('INVALID_REVIEW_PAYLOAD');
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, depth + 1)).join(',')}]`;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail('INVALID_REVIEW_PAYLOAD');
  return `{${Object.keys(value).sort().map(key => {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('INVALID_REVIEW_PAYLOAD');
    return `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], depth + 1)}`;
  }).join(',')}}`;
}
export async function reviewHash(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return [...new Uint8Array(hash)].map(n => n.toString(16).padStart(2, '0')).join('');
}
function fail(code: string): never { throw new RouterCoreError(code); }
const clean = (text: unknown) => typeof text === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(text);

function base58Length(value: unknown, size: number) {
  if (typeof value !== 'string' || value.length < size || value.length > Math.ceil(size * 1.38) || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(value)) return false;
  let number = 0n, bytes = 0;
  for (const char of value) number = number * 58n + BigInt('123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'.indexOf(char));
  while (number) { bytes++; number >>= 8n; }
  return bytes + (value.match(/^1*/)?.[0].length ?? 0) === size && !/^1+$/.test(value);
}
/** Hash encodings are chain-specific; a Solana signature is not an EVM hash. */
export function executionHash(chainId: string, value: unknown, kind: 'transaction' | 'block'): boolean {
  return chainId.startsWith('eip155:') ? typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value) && !/^0x0{64}$/.test(value)
    : chainId === 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' && base58Length(value, kind === 'transaction' ? 64 : 32);
}
/** The explicit mode is durable consent data; a quote cannot opt a legacy plan into it. */
export function validateProviderManagedPlan(plan: VerifiedWalletPlan): void {
  const policy = plan.providerRoute;
  if (!policy) {
    if (plan.actions?.some(action => action.payload?.type === 'PROVIDER_REVIEWED_TRANSACTION')) fail('PROVIDER_ROUTE_BINDING_MISMATCH');
    return;
  }
  const keys = ['provider', 'mode', 'requestId', 'quoteHash', 'sourceConfirmations', 'destinationConfirmations', 'sourceVm', 'destinationVm'];
  const vm = (chain: string) => chain.startsWith('eip155:') ? 'EVM' : chain === 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' ? 'SOLANA' : null;
  if (Object.getPrototypeOf(policy) !== Object.prototype || Object.keys(policy).length !== keys.length || keys.some(key => !Object.hasOwn(policy, key)) ||
    policy.provider !== 'relay' || policy.mode !== 'PROVIDER_MANAGED' || !/^0x[0-9a-f]{64}$/.test(policy.requestId) ||
    !/^[0-9a-f]{64}$/.test(policy.quoteHash) || policy.sourceVm !== vm(plan.source.chainId) || policy.destinationVm !== vm(plan.destination.chainId) ||
    policy.sourceConfirmations !== (policy.sourceVm === 'EVM' ? 12 : 1) || policy.destinationConfirmations !== (policy.destinationVm === 'EVM' ? 12 : 1) ||
    plan.quoteIds.length !== 1 || plan.quoteIds[0] !== 'relay:' + policy.requestId || !plan.routeId.startsWith('relay-provider:') ||
    plan.actions.some(action => {
      const payload = action.payload as any;
      return action.chainId !== plan.source.chainId || payload.type !== 'PROVIDER_REVIEWED_TRANSACTION' || payload.version !== 1 ||
        payload.providerId !== 'relay' || payload.vm !== policy.sourceVm || payload.verification !== 'TRUSTED_SERVER_FRESH_RFQ' ||
        payload.rfq?.requestId !== policy.requestId || payload.rfq?.commitmentHash !== policy.quoteHash || payload.rfq?.expiresAtMs !== plan.expiresAtMs;
    })) fail('PROVIDER_ROUTE_BINDING_MISMATCH');
}
export function validateDestinationReceipt(proof: CanonicalDestinationReceipt | undefined, plan: VerifiedWalletPlan,
  source: CanonicalExecutionReceipt | undefined, nowMs = Date.now()): CanonicalDestinationReceipt {
  const exact = (value: unknown, keys: string[]) => !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
  validateProviderManagedPlan(plan);
  const providerManaged = !!plan.providerRoute;
  const baseDestination = plan.destination.chainId === 'eip155:8453' || providerManaged && plan.destination.chainId.startsWith('eip155:');
  if (!source || source.destinationCredit || source.chainId !== plan.source.chainId || !providerManaged && plan.source.chainId === plan.destination.chainId ||
    !proof || !exact(proof, ['chainId','transactionHash','blockNumberRaw','blockHash','observedAtMs','commitment','destinationCredit','attribution', ...(baseDestination ? ['confirmations'] : [])]) ||
    proof.chainId !== plan.destination.chainId || (baseDestination ? proof.commitment !== 'canonical' || !Number.isSafeInteger(proof.confirmations) || proof.confirmations! < 12 :
      !proof.chainId.startsWith('solana:') || proof.commitment !== 'finalized') ||
    !executionHash(proof.chainId,proof.transactionHash,'transaction') || !executionHash(proof.chainId,proof.blockHash,'block') ||
    !Number.isSafeInteger(proof.observedAtMs) || proof.observedAtMs < 0 || proof.observedAtMs > nowMs + 2000 ||
    !exact(proof.attribution,['provider','requestId','sourceTransactionHash', ...(providerManaged ? ['basis'] : [])]) || proof.attribution.provider !== 'relay' ||
    providerManaged && proof.attribution.basis !== 'PROVIDER_STATUS_AND_CHAIN_CREDIT' ||
    !/^0x[0-9a-f]{64}$/.test(proof.attribution.requestId) || plan.quoteIds[0] !== 'relay:' + proof.attribution.requestId ||
    proof.attribution.sourceTransactionHash !== source.transactionHash) fail('DESTINATION_RECEIPT_BINDING_MISMATCH');
  rawAmount(proof.blockNumberRaw);
  const credit = proof.destinationCredit;
  if (!exact(credit,['asset','recipient','amountRaw']) || !sameAsset(credit.asset,plan.destination) || credit.recipient !== plan.recipient ||
    BigInt(rawAmount(credit.amountRaw,true)) < BigInt(plan.minimumOutRaw)) fail('DESTINATION_CREDIT_REQUIRED');
  return structuredClone(proof);
}

/** Produces reviewed wallet actions and journals user-reported hashes. It cannot
 * sign or broadcast. Conditional future steps remain in the staged host flow. */
export class WalletExecutionCoordinator {
  private store: ExecutionStore;
  private recipes: Map<string, ExecutionRecipe>;
  private verifier: ExecutionVerifier;
  constructor(store: ExecutionStore, recipes: readonly ExecutionRecipe[], verifier: ExecutionVerifier) {
    this.store = store;
    this.verifier = verifier;
    this.recipes = new Map();
    for (const recipe of recipes) {
      if (!clean(recipe.id) || this.recipes.has(recipe.id)) fail('INVALID_EXECUTION_RECIPE');
      if (recipe.maxReviewLifetimeMs !== undefined && (!Number.isSafeInteger(recipe.maxReviewLifetimeMs) ||
        recipe.maxReviewLifetimeMs < 1 || recipe.maxReviewLifetimeMs > 90000)) fail('INVALID_EXECUTION_RECIPE');
      this.recipes.set(recipe.id, recipe);
    }
  }

  async prepare(id: string, ownerId: string, rawRequest: RouterRequest, candidate: RouteCandidate) {
    const started = Date.now();
    if (!clean(id) || !clean(ownerId)) fail('INVALID_EXECUTION_ID');
    const request = validateRequest(rawRequest);
    candidate = structuredClone(candidate);
    if (rankCandidates(request, [candidate], { nowMs: Date.now(), requireExecutable: true }).winner === null)
      fail('ROUTE_NOT_EXECUTABLE');
    const recipeId = candidate.legQuotes[0]?.executableRecipeId;
    const recipe = recipeId && this.recipes.get(recipeId);
    if (!recipe || candidate.path.legs.length !== 1) fail('RECIPE_NOT_CONFIGURED');
    // Copy across the plugin boundary so a recipe cannot alter approved terms.
    const pricingCutoff = Math.min(candidate.deadlineMs, ...candidate.legQuotes.map(quote => quote.pricingValidUntilMs ?? quote.expiresAtMs));
    const plan = structuredClone(await recipe.verify(structuredClone(request), structuredClone(candidate)));
    validateProviderManagedPlan(plan);
    // Only a trusted recipe for fixed, contract-enforced terms can allow wallet
    // review beyond the pricing observation. Claim always checks the same terms
    // again. Expired pricing cannot be accepted while preparing the review.
    const reviewCutoff = recipe.maxReviewLifetimeMs === undefined ? pricingCutoff :
      Math.min(request.deadlineMs, started + recipe.maxReviewLifetimeMs);
    if (Date.now() >= pricingCutoff) fail('EXECUTION_PRICING_EXPIRED');
    if (plan.routeId !== candidate.id || JSON.stringify(plan.quoteIds) !== JSON.stringify(candidate.legQuotes.map(q => q.quoteId)) ||
      !sameAsset(plan.source, request.source) || !sameAsset(plan.destination, request.destination) ||
      plan.sender !== request.sender || plan.recipient !== request.recipient || plan.amountRaw !== request.amountRaw ||
      BigInt(rawAmount(plan.minimumOutRaw, true)) < BigInt(candidate.minimumOutputRaw) ||
      !Number.isSafeInteger(plan.expiresAtMs) || plan.expiresAtMs > reviewCutoff || plan.expiresAtMs <= Date.now())
      fail('EXECUTION_BINDING_MISMATCH');
    if (!Array.isArray(plan.actions) || plan.actions.length < 1 || plan.actions.length > 8 ||
      new Set(plan.actions.map(a => a.id)).size !== plan.actions.length ||
      plan.actions.some(a => !clean(a.id) || a.chainId !== request.source.chainId || !a.payload || typeof a.payload !== 'object' || Array.isArray(a.payload)))
      fail('INVALID_CANONICAL_ACTION');
    if (!request.nativeFeeBudgets?.length || !Array.isArray(plan.nativeCosts) || !plan.nativeCosts.length || plan.nativeCosts.length > 8) fail('NATIVE_BUDGET_REQUIRED');
    const costs = new Map<string, bigint>();
    for (const cost of plan.nativeCosts) costs.set(cost.chainId, (costs.get(cost.chainId) ?? 0n) + BigInt(rawAmount(cost.amountRaw)));
    if (plan.actions.some(action => !costs.has(action.chainId))) fail('NATIVE_COST_EVIDENCE_REQUIRED');
    for (const [chain, amount] of costs) {
      const cap = request.nativeFeeBudgets.find(b => b.chainId === chain);
      if (!cap || cap.maxAmountRaw !== null && amount > BigInt(cap.maxAmountRaw)) fail('NATIVE_BUDGET_EXCEEDED');
    }
    const record: ExecutionRecord = { id, ownerId, revision: 0, status: 'READY', reviewHash: await reviewHash({ request, plan }),
      request: structuredClone(request), plan, nextAction: 0, claimedActionId: null, submissions: [], timeline: { preparedAtMs: Date.now() } };
    if (!await this.store.insert(structuredClone(record))) fail('EXECUTION_ALREADY_ACTIVE');
    return structuredClone(record);
  }

  private async load(id: string, owner: string) {
    const row = await this.store.get(id);
    if (!row || row.ownerId !== owner) fail('EXECUTION_NOT_FOUND');
    if (!row.request || row.reviewHash !== await reviewHash({ request: row.request, plan: row.plan }))
      fail('EXECUTION_REVIEW_CORRUPTED');
    return row;
  }
  private async update(row: ExecutionRecord, changes: Partial<ExecutionRecord>) {
    if (row.timeline) {
      const field: keyof ExecutionTimeline | undefined = changes.status === 'CLAIMED' ? 'claimedAtMs' :
        changes.status === 'SUBMITTED' ? 'submittedAtMs' : changes.status === 'COMPLETE' ? 'completedAtMs' :
          changes.status === 'FAILED' ? 'failedAtMs' : undefined;
      if (field && row.timeline[field] === undefined) {
        const now = Date.now();
        if (!Number.isSafeInteger(now) || now < Math.max(...Object.values(row.timeline))) fail('INVALID_EXECUTION_CLOCK');
        changes = { ...changes, timeline: { ...row.timeline, [field]: now } };
      }
    }
    const next = { ...row, ...changes, revision: row.revision + 1 };
    if (!await this.store.compareAndSwap(row.id, row.revision, structuredClone(next))) fail('EXECUTION_CONFLICT');
    return structuredClone(next);
  }
  async claim(id: string, owner: string, hash: string, revision: number) {
    const row = await this.load(id, owner);
    if (row.status !== 'READY' || row.revision !== revision || row.reviewHash !== hash || row.plan.expiresAtMs <= Date.now())
      fail('EXECUTION_CLAIM_BLOCKED');
    const evidence = await this.verifier.preflight(structuredClone(row.plan), structuredClone(row.plan.actions[row.nextAction]!));
    if (evidence.ready !== true || row.plan.expiresAtMs <= Date.now()) fail('FRESH_PREFLIGHT_REQUIRED');
    const claimed = await this.update(row, { status: 'CLAIMED', claimedActionId: row.plan.actions[row.nextAction]!.id });
    return { record: claimed, action: structuredClone(row.plan.actions[row.nextAction]!) };
  }
  async submitted(id: string, owner: string, hash: string) {
    const row = await this.load(id, owner);
    const action = row.plan.actions[row.nextAction]!;
    const existing = row.submissions.find(s => s.actionId === action?.id);
    if (existing && existing.hash === hash && ['SUBMITTED', 'RECOVERY_REQUIRED'].includes(row.status)) return row;
    if (!['CLAIMED', 'RECOVERY_REQUIRED'].includes(row.status) || row.claimedActionId !== action?.id || existing ||
      typeof hash !== 'string' || hash.length < 1 || hash.length > 256 || /[\s\x00-\x1f\x7f]/.test(hash) ||
      !this.verifier.isValidTransactionHash(action.chainId, hash))
      fail('INVALID_SUBMISSION');
    return this.update(row, { status: 'SUBMITTED', submissions: [...row.submissions, { actionId: action.id, hash }] });
  }
  async signingUncertain(id: string, owner: string) {
    const row = await this.load(id, owner);
    if (row.status !== 'CLAIMED') fail('INVALID_RECOVERY_STATE');
    return this.update(row, { status: 'RECOVERY_REQUIRED' });
  }
  async recoverUnsubmitted(id: string, owner: string) {
    const row=await this.load(id,owner);
    if(!isRecoverableUnsubmittedSolanaClaim(row)||row.plan.expiresAtMs>Date.now()||!this.verifier.recoverUnsubmitted) fail('EXECUTION_RECOVERY_BLOCKED');
    const result=await this.verifier.recoverUnsubmitted({record:structuredClone(row)});
    if(result.ready!==true||!result.evidence) fail('EXECUTION_RECOVERY_BLOCKED');
    validateSolanaClaimExpiryEvidence(row,result.evidence,Date.now(),true);
    return this.update(row,{status:'EXPIRED',claimedActionId:null,unsubmittedExpiry:structuredClone(result.evidence)});
  }
  private async canRelease(row: ExecutionRecord) {
    if (row.status !== 'READY' || row.claimedActionId !== null) return false;
    if (row.nextAction === 0 && row.submissions.length === 0) return true;
    if (!isConfirmedBaseUsdcApprovalPrefix(row) || !this.verifier.release) return false;
    return (await this.verifier.release({ record: structuredClone(row) })).ready === true;
  }
  /** Release untouched reviews, or a canonically rechecked approval-only prefix. */
  async cancel(id: string, owner: string, hash: string, revision: number) {
    const row = await this.load(id, owner);
    if (row.reviewHash !== hash || row.revision !== revision || !await this.canRelease(row)) fail('EXECUTION_CANCEL_BLOCKED');
    return this.update(row, { status: 'CANCELLED' });
  }
  async expire(id: string, owner: string) {
    const row = await this.load(id, owner);
    if (row.plan.expiresAtMs > Date.now() || !await this.canRelease(row)) fail('EXECUTION_EXPIRY_BLOCKED');
    return this.update(row, { status: 'EXPIRED' });
  }
  /** Only a host's independent canonical receipt verifier may call this.
   * The exact stored hash must be successful; provider status is insufficient. */
  async confirmed(id: string, owner: string) {
    const row = await this.load(id, owner);
    if (!['SUBMITTED', 'RECOVERY_REQUIRED'].includes(row.status)) fail('INVALID_CONFIRMATION_STATE');
    const action = row.plan.actions[row.nextAction]!;
    const submission = row.submissions.find(s => s.actionId === action?.id);
    if (!submission) fail('ORIGINAL_HASH_REQUIRED');
    const evidence = await this.verifier.confirm(structuredClone(row.plan), structuredClone(action), submission.hash);
    if (evidence.routeId !== row.plan.routeId || evidence.actionId !== action.id || evidence.transactionHash !== submission.hash)
      fail('RECEIPT_BINDING_MISMATCH');
    const receipt = evidence.receipt && structuredClone(evidence.receipt);
    validateProviderManagedPlan(row.plan);
    if (row.plan.providerRoute && (!receipt || receipt.confirmations < row.plan.providerRoute.sourceConfirmations)) fail('RECEIPT_BINDING_MISMATCH');
    if (receipt && (receipt.chainId !== action.chainId || receipt.transactionHash !== submission.hash ||
      !executionHash(receipt.chainId,receipt.blockHash,'block') || !executionHash(receipt.chainId,receipt.transactionHash,'transaction') ||
      !Number.isSafeInteger(receipt.confirmations) || receipt.confirmations < 1 ||
      !Number.isSafeInteger(receipt.observedAtMs) || receipt.observedAtMs < 0 || receipt.observedAtMs > Date.now() + 2000))
      fail('RECEIPT_BINDING_MISMATCH');
    if (receipt) {
      rawAmount(receipt.blockNumberRaw);
      if (receipt.actualNativeFeeRaw !== undefined) rawAmount(receipt.actualNativeFeeRaw);
    }
    if (evidence.confirmedFailure === true) {
      if (evidence.success !== false || !receipt || evidence.destinationCredit || receipt.destinationCredit || evidence.destinationReceipt)
        fail('RECEIPT_BINDING_MISMATCH');
      return this.update(row, { status: 'FAILED', receipt });
    }
    if (evidence.success !== true) return this.update(row, { status: 'RECOVERY_REQUIRED' });
    const nextAction = row.nextAction + 1;
    if (nextAction === row.plan.actions.length) {
      const credit = evidence.destinationCredit;
      if (!credit || !sameAsset(credit.asset, row.plan.destination) || credit.recipient !== row.plan.recipient ||
        BigInt(rawAmount(credit.amountRaw, true)) < BigInt(row.plan.minimumOutRaw))
        fail('DESTINATION_CREDIT_REQUIRED');
      const crossChain = row.plan.source.chainId !== row.plan.destination.chainId || !!row.plan.providerRoute && evidence.destinationReceipt !== undefined;
      if (!crossChain && (evidence.destinationReceipt || receipt && (!receipt.destinationCredit || !sameAsset(receipt.destinationCredit.asset, credit.asset) ||
        receipt.destinationCredit.recipient !== credit.recipient || receipt.destinationCredit.amountRaw !== credit.amountRaw))) fail('RECEIPT_BINDING_MISMATCH');
      const destinationReceipt = crossChain ? validateDestinationReceipt(evidence.destinationReceipt,row.plan,receipt) : undefined;
      if (destinationReceipt && destinationReceipt.destinationCredit.amountRaw !== credit.amountRaw) fail('RECEIPT_BINDING_MISMATCH');
      return this.update(row, { status: 'COMPLETE', nextAction, claimedActionId: null, ...(receipt ? { receipt } : {}),
        ...(destinationReceipt ? {destinationReceipt} : {}) });
    }
    // An unclaimed next action is safe to review or cancel; expiry still blocks
    // claim. It must not be mistaken for an ambiguous wallet submission.
    return this.update(row, { status: 'READY', nextAction, claimedActionId: null });
  }
}
