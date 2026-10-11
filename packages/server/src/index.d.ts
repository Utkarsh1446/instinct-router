import type { ExecutionStore, ExecutionRecord, ExecutionRecipe, ExecutionVerifier, RouterRequest, RouteCandidate } from '@instinct/router-core';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import type { QuoteInput, QuoteService } from '@instinct/router-engine';

/** POST /v1/quotes/stream, application/x-ndjson. Sequence starts at zero.
 * At most 128 candidates, 262144 bytes per line and 2097152 bytes per stream.
 * Writer lifetime is quoteTimeoutMs + 2000ms; each blocked write is bounded to 2000ms.
 * Arrival eligibility is provisional. Only COMPLETE supplies an owned snapshot.
 * Streams reject Idempotency-Key and never retry an RFQ automatically. */
export interface QuoteStreamContext {
  apiVersion: '1'; sequence: number; requestId: string; appId: string; request: QuoteInput;
}
export type QuoteStreamEvent = QuoteStreamContext & (
  { type: 'START'; provisional: true; comparisonComplete: false } |
  { type: 'CANDIDATE'; provisional: true; comparisonComplete: false; candidate: Record<string, unknown> } |
  { type: 'COMPLETE'; provisional: false; comparisonComplete: boolean; quote: Record<string, unknown> } |
  { type: 'ERROR'; provisional: true; comparisonComplete: false;
    error: { code: string; message: string; retryable: boolean; retryAfterMs?: number } }
);

/** Credentials identify an app, not ownership or control of a wallet. */
export interface RouterApp {
  id: string;
  /** Browser credential, accepted only with an exact allowed Origin. */
  publishableKey: string;
  /** Server credential, rejected on requests that contain Origin. */
  serverKey: string;
  allowedOrigins: string[];
  /** Defaults to 60; bounded from 1 to 100000. */
  rateLimitPerMinute?: number;
  /** Defaults to 2; bounded from 1 to 64. */
  maxConcurrent?: number;
}

export interface RouterApiOptions {
  service: QuoteService;
  /** Public observations only; configured RPCs, no wallet session or financial writes. */
  balances?: {getAssetBalance(input:{chainId:string;address:string;owner:string},signal?:AbortSignal):Promise<{chainId:string;address:string;owner:string;decimals:number;balanceRaw:string;observedAtMs:number}>};
  /** Enables only recipes exposed by this trusted engine and durable journal. */
  execution?: { engine: RouterExecutionEngine; store: DurableExecutionStore };
  apps: RouterApp[];
  walletAuthentication?: WalletAuthentication;
  walletAuthStore?: WalletAuthStore;
  /** Replaces the local request-rate window; in-flight work quotas still apply. */
  rateLimit?: (context: PublicRateLimitContext) => void | Promise<void>;
  /** Clock in milliseconds, primarily for deterministic tests. */
  now?: () => number;
  /** Global in-flight operation limit. Default 8, maximum 64. */
  maxConcurrent?: number;
  /** Global authenticated request limit per rolling minute. Default 120. */
  globalRateLimitPerMinute?: number;
  /** Operation deadline; aborted transports retain capacity until settled. Default 12000. */
  quoteTimeoutMs?: number;
  /** Deadline for a complete bounded JSON body. Default 3000. */
  bodyTimeoutMs?: number;
  /** Maximum ephemeral owned snapshots. Default 1000, maximum 10000. */
  maxSnapshots?: number;
  /** Maximum ephemeral replay entries. Live entries never evict; expired entries may evict,
   * after which a previously used key is no longer remembered. Default 1000, maximum 10000. */
  maxIdempotencyEntries?: number;
}

/** Creates an unstarted HTTP server. It never signs or broadcasts wallet transactions. */
export function createRouterApi(options: RouterApiOptions): Server;

export interface FileExecutionStoreOptions {
  /** Dedicated owner-only local directory. Symlink components are rejected. */
  directory: string;
  maxRecords?: number; maxRecordBytes?: number; maxStoreBytes?: number;
}
export interface DurableExecutionStore extends ExecutionStore {
  findActive(ownerId: string): Promise<ExecutionRecord | null>;
  close(): Promise<void>;
}
export interface FileExecutionStore extends DurableExecutionStore {
  findActive(ownerId: string): Promise<ExecutionRecord | null>;
  close(): Promise<void>;
}
export class ExecutionStoreError extends Error { readonly code: string }
/** Single-host journal; explicit recovery is required after an abrupt/uncertain writer exit.
 * App and wallet authorization must be supplied by the API; the store does not authorize actions. */
export function createFileExecutionStore(options: FileExecutionStoreOptions): Promise<FileExecutionStore>;

export interface RedisExecutionStoreOptions {
  /** Private HTTPS Redis REST endpoint and server-only token; omit when command is injected. */
  url?: string; token?: string;
  command?: RedisCommand;
  /** Share one namespace/database across every app using the same source wallets. */
  namespace?: string;
  /** Retained ledger capacity, never eviction. Defaults: 1,000,000 rows / 1 GiB
   * of serialized record payloads; Redis index/storage overhead is additional. */
  maxRecords?: number; maxRecordBytes?: number; maxStoreBytes?: number;
}
export interface RedisRestCommandOptions {
  url: string; token: string;
  fetch?: typeof globalThis.fetch;
  /** One attempt only. Defaults to 10000 ms; maximum 60000 ms. */
  timeoutMs?: number;
}
/** Atomic shared journal. Redis must persist data without TTLs or eviction.
 * An ambiguous write poisons the adapter; reopen and read before recovery. */
export function createRedisExecutionStore(options: RedisExecutionStoreOptions): Promise<DurableExecutionStore>;
/** Discards a poisoned adapter for future calls without retrying the failed operation.
 * Suitable for cached serverless handlers; the shared durable journal is retained. */
export function createRecoverableRedisExecutionStore(options: RedisExecutionStoreOptions): Promise<DurableExecutionStore>;
/** Private server transport; never retries commands or exposes transport secrets in errors. */
export function createRedisRestCommand(options: RedisRestCommandOptions): RedisCommand;

export interface RouterExecutionEngine {
  prepare(input: QuoteInput & { nativeFeeBudgets: { chainId: string; maxAmountRaw: string | null }[] }, signal?: AbortSignal): Promise<{ request: RouterRequest; candidate: RouteCandidate }>;
  capabilities(): { walletExecution: boolean; supportedRoutes: { recipeId: string; source: Record<string, unknown>; destination: Record<string, unknown>; walletActions: number; confirmationPolicy?: string }[]; blockedRoutes?: Record<string, unknown>[];
    executionProfiles?: { recipeId: string; sourceChainId?: string; destinationChainId?: string; sourceChainIds?: string[]; destinationChainIds?: string[]; verification?: 'PROVIDER_MANAGED'; sourceAssetTypes: ('NATIVE'|'ERC20'|'SPL')[]; destinationAssetTypes: ('NATIVE'|'ERC20'|'SPL')[]; requiresFreshValidation: true }[] };
  recipes: readonly ExecutionRecipe[];
  verifier: ExecutionVerifier;
}
export interface WalletChallenge { challengeId: string; message: string; expiresAtMs: number; wallet: { chainId: string; address: string } }
export interface WalletSession { walletToken: string; expiresAtMs: number; wallet: { chainId: string; address: string } }
/** Source wallet proof is bound to app, Origin and chain. Tokens expire after 15 minutes.
 * EVM uses exact UTF8 personal_sign/EIP191; Solana uses base58 Ed25519 signatures. */
export interface PublicExecutionRecord extends Omit<ExecutionRecord, 'ownerId' | 'plan'> {
  plan: Omit<ExecutionRecord['plan'], 'actions'> & { actions: { id: string; chainId: string; payloadHash: string }[] };
}
/** Transient display evidence; never authorizes a wallet action or releases an execution. */
export type SettlementProgress = {
  routeId: string; actionId: 'relay-native-deposit' | 'relay-usdc-deposit' | 'relay-token-deposit' | 'relay-solana-deposit' | 'relay-provider-deposit' | 'relay-provider-swap'; sourceTransactionHash: string;
  observedAtMs: number; sourceConfirmations: number; requiredSourceConfirmations: 1 | 12;
} & ({ stage: 'SOURCE_CONFIRMED' } | { stage: 'DESTINATION_CONFIRMED'; destination: {
  chainId: string; transactionHash: string; asset: { chainId: string; address: string; decimals: number };
  recipient: string; amountRaw: string; commitment: 'confirmed' | 'finalized' | 'canonical';
} });

/** Authenticated POST /v1/executions/:id/watch with an empty JSON body.
 * NDJSON: START, UPDATE*, then END or ERROR. Sequence starts at zero.
 * One connection per app/wallet/execution; checks are sequential and share work
 * quotas. At most 120s, 1024 frames, 256KiB per line, 8MiB total and 8 queued
 * events. Disconnect or slow consumption cancels checks, never the transaction.
 * Timestamps are server observations, not exact chain inclusion times. */
export type ExecutionWatchEvent = {
  apiVersion: '1'; requestId: string; appId: string; executionId: string;
  sequence: number; sentAtMs: number;
} & ({ type: 'START' } | { type: 'UPDATE'; execution: PublicExecutionRecord;
  receiptStatus: 'PENDING' | 'CONFIRMED' | 'FAILED' | 'RECOVERY_REQUIRED'; progress?: SettlementProgress;
} | { type: 'END'; reason: 'TIMEOUT' | 'SETTLED' | 'STATE_CHANGED' } |
{ type: 'ERROR'; error: { code: string; message: string; retryable: boolean; retryAfterMs?: number } });

/** Creates a directly callable async Node/Vercel request handler, without opening a port. */
export function createRouterHandler(options: RouterApiOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
export type RedisCommand = (command: string[]) => Promise<unknown>;
type MaybePromise<T> = T | Promise<T>;
export interface WalletAuthRow { scope: string; wallet: { chainId: string; address: string }; expiresAtMs: number }
export interface WalletChallengeRow extends WalletAuthRow { message: string }
export interface WalletAuthStore {
  putChallenge(id: string, row: WalletChallengeRow): MaybePromise<void>;
  /** Must atomically return and remove only an unexpired challenge matching the supplied scope. */
  consumeChallenge(id: string, scope: string, nowMs: number): MaybePromise<WalletChallengeRow | null>;
  putSession(tokenHash: string, row: WalletAuthRow): MaybePromise<void>;
  getSession(tokenHash: string): MaybePromise<WalletAuthRow | null | undefined>;
}
export interface WalletAuthentication {
  challenge(app: Pick<RouterApp, 'id'>, origin: string | undefined, body: { chainId: string; address: string }): MaybePromise<WalletChallenge>;
  verify(app: Pick<RouterApp, 'id'>, origin: string | undefined, body: { challengeId: string; signature: string }): Promise<WalletSession>;
  authenticate(req: IncomingMessage, app: Pick<RouterApp, 'id'>, origin: string | undefined): MaybePromise<{ chainId: string; address: string; ownerId: string }>;
}
export function createWalletAuthentication(options?: { now?: () => number; maxEntries?: number; store?: WalletAuthStore }): WalletAuthentication;
export function createMemoryWalletAuthStore(options?: { now?: () => number; maxEntries?: number }): WalletAuthStore;
export function createRedisWalletAuthStore(options: { command: RedisCommand; prefix?: string; now?: () => number }): WalletAuthStore;
export interface PublicRateLimitContext { req: IncomingMessage; app: RouterApp; origin?: string; path: string }
export type PublicRateLimitBudgets = Partial<Record<'quotes' | 'wallet' | 'recovery' | 'reads', number>>;
export function createRedisPublicRateLimit(options: { command: RedisCommand; clientKey: (context: PublicRateLimitContext) => MaybePromise<string>; prefix?: string; limits?: PublicRateLimitBudgets; globalLimits?: PublicRateLimitBudgets }): (context: PublicRateLimitContext) => Promise<void>;
