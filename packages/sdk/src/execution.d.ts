import type { Asset, ApiEnvelope, RouterClient, QuoteRequest, RequestOptions } from './index.js';
export interface WalletAccount { readonly chainId: string; readonly address: string }
export interface WalletSession extends ApiEnvelope { readonly walletToken: string; readonly expiresAtMs: number; readonly wallet: WalletAccount }
export interface WalletChallenge extends ApiEnvelope { readonly appId:string; readonly challengeId: string; readonly message: string; readonly wallet: WalletAccount; readonly expiresAtMs: number }
export interface WalletRequestOptions extends Omit<RequestOptions, 'idempotencyKey'> { readonly walletToken: string }
export interface ExecutionInput extends QuoteRequest { readonly nativeFeeBudgets: readonly { readonly chainId: string; readonly maxAmountRaw: string | null }[] }
export type EvmTransaction = { readonly chainId:string;readonly from:string;readonly to:string;readonly data:string;readonly value:string;readonly gas:string } & (
 {readonly type:'0x2';readonly maxFeePerGas:string;readonly maxPriorityFeePerGas:string;readonly accessList:readonly []} |
 {readonly type:'0x0';readonly gasPrice:string});
export interface ProviderRoute {readonly provider:'relay';readonly mode:'PROVIDER_MANAGED';readonly requestId:string;readonly quoteHash:string;readonly sourceVm:'EVM'|'SOLANA';readonly destinationVm:'EVM'|'SOLANA';readonly sourceConfirmations:number;readonly destinationConfirmations:number}
export interface ProviderSolanaTransaction {readonly serialized:string;readonly blockhash:string;readonly lastValidBlockHeight:number;readonly feePayer:string;readonly addressLookupTables?:readonly {readonly address:string;readonly addresses:readonly string[]}[]}
export interface ProviderReviewedTransaction {readonly type:'PROVIDER_REVIEWED_TRANSACTION';readonly version:1;readonly vm:'EVM'|'SOLANA';readonly providerId:'relay';readonly verification:'TRUSTED_SERVER_FRESH_RFQ';readonly kind:'TOKEN_APPROVAL'|'FUNDING'|'SWAP';readonly rfq:{readonly requestId:string;readonly commitmentHash:string;readonly expiresAtMs:number};readonly spending:{readonly asset:Asset;readonly amountRaw:string;readonly nativeValueRaw:string;readonly nativeFeeCapRaw:string;readonly approval?:{readonly spender:string;readonly amountRaw:string}};readonly transaction:EvmTransaction|ProviderSolanaTransaction;readonly bindings:Readonly<Record<string,unknown>>;readonly validation?:Readonly<Record<string,unknown>>}

export interface SolanaTransaction { readonly message:string; readonly blockhash:string; readonly lastValidBlockHeight:number; readonly feePayer:string }
export interface RelayTokenIdentity { readonly address:string; readonly decimals:number; readonly codeSha256:string; readonly implementation?:{readonly slot:string;readonly address:string;readonly codeSha256:string} }
export interface RelayActionMetadata { readonly requestId:string; readonly orderId:string; readonly orderData:Readonly<Record<string,unknown>>; readonly tokenIdentity?:RelayTokenIdentity; readonly computeBudget?:{readonly units:200000;readonly microLamports:string} }
export interface CanonicalAction { readonly id:string; readonly chainId:string; readonly payload:
  {readonly type:'EVM_TRANSACTION';readonly transaction:EvmTransaction;readonly relay?:RelayActionMetadata;readonly nativeFeeCapRaw?:string} |
  {readonly type:'SOLANA_TRANSACTION';readonly transaction:SolanaTransaction;readonly relay:RelayActionMetadata;readonly nativeFeeCapRaw:string} | ProviderReviewedTransaction }
export interface DestinationReceiptEvidence {
  readonly transactionHash:string;readonly blockNumberRaw:string;readonly blockHash:string;readonly observedAtMs:number;
  readonly destinationCredit:{readonly asset:Asset;readonly recipient:string;readonly amountRaw:string};
  readonly attribution:{readonly provider:'relay';readonly requestId:string;readonly sourceTransactionHash:string;readonly basis?:'PROVIDER_STATUS_AND_CHAIN_CREDIT'};
}
export type DestinationReceipt = DestinationReceiptEvidence & (
  {readonly chainId:`solana:${string}`;readonly commitment:'finalized';readonly confirmations?:never} |
  {readonly chainId:`eip155:${string}`;readonly commitment:'canonical';readonly confirmations:number});
export interface SolanaClaimExpiryEvidence {readonly chainId:string;readonly feePayer:string;readonly blockhash:string;readonly preparedSlot:number;readonly lastValidBlockHeight:number;readonly finalizedSlot:number;readonly finalizedBlockHeight:number;readonly finalizedBlockHash:string;readonly observedAtMs:number;readonly minimumLedgerSlot:number;readonly firstAvailableBlock:number;readonly latestSignatureSlot:number}
export interface ExecutionRecord {
  readonly unsubmittedExpiry?:SolanaClaimExpiryEvidence;
  readonly id: string; readonly revision: number; readonly reviewHash: string;
  readonly status: 'READY'|'CLAIMED'|'SUBMITTED'|'COMPLETE'|'RECOVERY_REQUIRED'|'CANCELLED'|'EXPIRED'|'FAILED';
  readonly request: Readonly<Record<string, unknown>>;
  readonly plan: { readonly providerRoute?:ProviderRoute; readonly routeId: string; readonly quoteIds: readonly string[]; readonly source: Asset; readonly destination: Asset;
    readonly sender: string; readonly recipient: string; readonly amountRaw: string; readonly minimumOutRaw: string; readonly expiresAtMs: number;
    readonly nativeCosts: readonly { readonly chainId: string; readonly amountRaw: string; readonly [key:string]: unknown }[];
    readonly actions: readonly { readonly id: string; readonly chainId: string; readonly payloadHash: string }[] };
  /** Wall-clock observations, not estimates of trade speed. */
  readonly timeline?: {readonly preparedAtMs:number;readonly claimedAtMs?:number;readonly submittedAtMs?:number;readonly completedAtMs?:number;readonly failedAtMs?:number};
  readonly receipt?: {readonly chainId:string;readonly transactionHash:string;readonly blockNumberRaw:string;readonly blockHash:string;
    readonly observedAtMs:number;readonly confirmations:number;readonly actualNativeFeeRaw?:string;
    readonly destinationCredit?:{readonly asset:Asset;readonly recipient:string;readonly amountRaw:string}};
  /** Independent chain-specific destination settlement proof. */
  readonly destinationReceipt?: DestinationReceipt;
  readonly nextAction: number; readonly claimedActionId: string|null;
  readonly submissions: readonly { readonly actionId: string; readonly hash: string }[];
}
export interface ExecutionResponse extends ApiEnvelope { readonly progress?: SettlementProgress; readonly execution: ExecutionRecord; readonly receiptStatus?: 'PENDING'|'FAILED'|'CONFIRMED'|'RECOVERY_REQUIRED' }
export interface ClaimResponse extends ExecutionResponse { readonly action: CanonicalAction }
export interface WalletAdapter {
  /** Restore a trusted live account without requesting account access, signatures, or transactions. */
  resume?(expected?: WalletAccount): Promise<WalletAccount | null>;
  connect(selectAccount?: (accounts: readonly WalletAccount[]) => WalletAccount|Promise<WalletAccount>): Promise<WalletAccount>;
  getAccount(): Promise<WalletAccount>;
  signMessage(message: string, expected: WalletAccount): Promise<string>;
  sendTransaction(transaction: EvmTransaction|SolanaTransaction|ProviderSolanaTransaction, expected: WalletAccount): Promise<string>;
  disconnect(): void;
}
export interface RecoveryRecord { readonly version: 1; readonly phase: string; readonly record?: ExecutionRecord; readonly transactionHash?: string; readonly walletRttMs?: number; readonly savedAtMs: number; /** Unsent prepare reconciliation deadline; expiry never discards a transaction. */ readonly expiresAtMs?: number }
export interface SettlementProgress {
  readonly routeId:string; readonly actionId:string; readonly sourceTransactionHash:string;
  readonly stage:'SOURCE_CONFIRMED'|'DESTINATION_CONFIRMED'; readonly observedAtMs:number;
  readonly sourceConfirmations:number; readonly requiredSourceConfirmations:1|12;
  readonly destination?: {readonly chainId:string;readonly transactionHash:string;readonly asset:Asset;readonly recipient:string;readonly amountRaw:string;readonly commitment:'confirmed'|'finalized'|'canonical'};
}
export interface ExecutionStreamTiming {
  readonly receivedAtMonoMs:number; readonly receivedAtMs:number; readonly sentAtMs:number;
  readonly observedToSentMs?:number; /** Depends on client and server wall-clock alignment. */ readonly serverToReceiptMs:number;
}
export interface ExecutionWatchResult {readonly reason:'TIMEOUT'|'SETTLED'|'STATE_CHANGED';readonly execution:ExecutionRecord}
export interface ExecutionWatchOptions extends WalletRequestOptions {readonly onUpdate:(response:ExecutionResponse,timing:ExecutionStreamTiming)=>void|Promise<void>}
export interface ExecutionController {
  getRecovery(): RecoveryRecord|null;
  /** Transient display-only observations; never restored from browser storage. */
  getProgress(): SettlementProgress|null;
  /** Login proof only; explicitly invokes the wallet message-signing prompt. */
  proveOwnership(): Promise<{readonly wallet: WalletAccount; readonly expiresAtMs:number}>;
  prepare(input: ExecutionInput): Promise<ExecutionRecord>;
  /** Explicit confirmation callback must return true; never invoked by wallet connection. */
  execute(review: ExecutionRecord, confirm: (record: ExecutionRecord, action: CanonicalAction) => boolean|Promise<boolean>): Promise<ExecutionRecord>;
  resume(): Promise<ExecutionRecord|null>;
  /** Read-only authenticated push updates; never claims, signs or broadcasts. */
  watch(options:{readonly signal?:AbortSignal;readonly onUpdate:(record:ExecutionRecord,timing:ExecutionStreamTiming)=>void|Promise<void>}):Promise<ExecutionWatchResult>;
  cancel(): Promise<ExecutionRecord>;
}
export function createExecutionController(options: {client: RouterClient; wallet: WalletAdapter; storage: Pick<Storage,'getItem'|'setItem'>; storageKey?:string}): ExecutionController;
export interface ResumableWalletAdapter extends WalletAdapter {
  resume(expected?: WalletAccount): Promise<WalletAccount | null>;
}
export function createEvmWallet(provider: {request(args:{method:string;params?:unknown[]}):Promise<unknown>;on?(event:string,callback:()=>void):void}): ResumableWalletAdapter;
export function createPhantomWallet(provider: unknown, chainId?:string): ResumableWalletAdapter;
