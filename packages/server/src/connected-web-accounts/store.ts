import {
  and,
  connectedWebActionOperations,
  connectedWebAccounts,
  connectedWebOperations,
  connectedWebOperationActivityEntries,
  desc,
  eq,
  getSharedDirectDb,
  gt,
  isNotNull,
  isNull,
  lte,
  lt,
  or,
  sql,
  type ConnectedWebAccountExecutionCheckpoint,
  type ConnectedWebActionOperationStatus,
  type ConnectedWebAccountRow,
  type ConnectedWebAccountStatus,
  type ConnectedWebOperationDriver,
  type ConnectedWebOperationLifecycle,
  type ConnectedWebOperationProviderReferences,
  type ConnectedWebOperationSafeActivity,
  type ConnectedWebOperationSafeReceipt,
  type DirectDatabase,
} from "@nautilo/db";
import { createHash, randomUUID } from "node:crypto";
import { connectedWebActivityEntrySchema, connectedWebActivityPageSchema, type ConnectedWebActivityPage } from "@nautilo/types";
import { CONNECTED_WEB_ACTIVITY_PAGE_SIZE, type ConnectedWebActivityWrite } from "./activity-ledger";
import { canReuseConnectedWebBrowser, connectedWebBrowserIdleUntil, CONNECTED_WEB_BROWSER_CLEANUP_RETRY_MS } from "./browser-idle";
import type {
  ConnectedWebAccount,
  ConnectedWebAccountCreateRequest,
} from "@nautilo/types";
import { isConnectedWebOperationSealedEnvelope } from "./operation-secrets";
import {
  parseConnectedWebTerminalReadResult,
  type ConnectedWebTerminalReadResult,
} from "./read-result-contract";

export type ConnectedWebAccountStoreErrorKind =
  | "not_found"
  | "conflict"
  | "provider_unavailable";

/** Typed, non-enumerating store failure for routes and provider orchestration. */
export class ConnectedWebAccountStoreError extends Error {
  constructor(readonly kind: ConnectedWebAccountStoreErrorKind) {
    super(kind);
    this.name = "ConnectedWebAccountStoreError";
  }
}

export type ConnectedWebAccountStaleExecution = Readonly<{
  accountId: string;
  ownerUserId: string;
  checkpoint: ConnectedWebAccountExecutionCheckpoint;
}>;

/** A revoked account whose server-only provider profile still needs deletion. */
export type ConnectedWebAccountProviderCleanupCandidate = Readonly<{
  accountId: string;
  profileRef: string;
}>;

/** Server-only profile/recovery binding for provider orchestration. */
export type ConnectedWebAccountBinding = Readonly<{
  accountId: string;
  ownerUserId: string;
  service: string;
  origin: string;
  status: ConnectedWebAccountStatus;
  profileRef: string | null;
  executionCheckpoint: ConnectedWebAccountExecutionCheckpoint | null;
}>;

export type ConnectedWebAccountExecutionReservation = Readonly<{
  resource: "login" | "read" | "view" | "action";
  phase: "reserving";
  reservationToken: string;
  recordedAt: string;
}>;

export type ConnectedWebActionOperation = Readonly<{
  id: string;
  ownerUserId: string;
  accountId: string;
  deliveryId: string;
  requestDigest: string;
  actionType: "save_item";
  target: string;
  status: ConnectedWebActionOperationStatus;
  opaqueRunRef: string | null;
  receipt: ConnectedWebActionSafeReceipt | null;
}>;

export type ConnectedWebActionSafeReceipt = Readonly<{
  executionRef: string;
  action: "save_item";
  target: string;
  effectState: "observed" | "ambiguous" | "cancelled" | "failed" | "authentication_required";
  postcondition: string | null;
  evidenceCode: string;
  cost: Readonly<{ amountUsd: number | null; state: "actual" | "unknown" }>;
}>;

/** Server-only authority record. Do not project this type past the supervisor. */
export type ConnectedWebOperation = Readonly<{
  id: string;
  ownerUserId: string;
  accountId: string | null;
  initiatingAgentId: string;
  initiatingRoomId: string;
  initiatingThreadId: string;
  initiatingLane: string;
  deliveryId: string;
  requestDigest: string;
  sealedIntent: string;
  actionOperationId: string | null;
  effectIdempotencyKey: string | null;
  driver: ConnectedWebOperationDriver;
  lifecycle: ConnectedWebOperationLifecycle;
  controlEpoch: number;
  controlLeaseToken: string;
  controlLeaseExpiresAt: Date | null;
  sealedProviderRefs: ConnectedWebOperationProviderReferences;
  eventCursor: number;
  safeActivity: ConnectedWebOperationSafeActivity;
  wakeFingerprint: string | null;
  nextCheckAt: Date | null;
  requestedWakeAt?: Date | null;
  supervisorClaimOwner: string | null;
  supervisorClaimExpiresAt: Date | null;
  wakeClaimOwner: string | null;
  wakeClaimExpiresAt: Date | null;
  wakeAttempts: number;
  wakeDeliveredAt: Date | null;
  cumulativeCostUsdMicros: number;
  remainingBudgetUsdMicros: number;
  terminalReceipt: ConnectedWebOperationSafeReceipt | null;
  terminalReadResult?: ConnectedWebTerminalReadResult | null;
  terminalAt: Date | null;
  browserIdleUntil?: Date | null;
  browserCleanupStartedAt?: Date | null;
  activityLog?: ConnectedWebActivityPage;
  createdAt: Date;
  updatedAt: Date;
}>;

export type ConnectedWebOperationAdmission = Readonly<{
  /** Trusted server-minted UUID, bound into every sealed field before insert. */
  id: string;
  ownerUserId: string;
  accountId: string | null;
  initiatingAgentId: string;
  initiatingRoomId: string;
  initiatingThreadId: string;
  initiatingLane: string;
  deliveryId: string;
  requestDigest: string;
  /** Server-encrypted intent envelope; the store never accepts plaintext task text. */
  sealedIntent: string;
  actionOperationId?: string | null;
  effectIdempotencyKey?: string | null;
  driver?: ConnectedWebOperationDriver;
  safeActivity: ConnectedWebOperationSafeActivity;
  remainingBudgetUsdMicros: number;
  nextCheckAt?: Date | null;
}>;

const OPERATION_SAFE_CODE_MAX_CHARS = 128;
const OPERATION_SAFE_SUMMARY_MAX_CHARS = 512;
const OPERATION_PROVIDER_REF_MAX_CHARS = 2_048;
const OPERATION_SEALED_INTENT_MAX_CHARS = 16_384;
const OPERATION_WORKER_ID_MAX_CHARS = 128;
const OPERATION_CLAIM_BATCH_MAX = 32;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function safeOperationText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maximum || /[\r\n]/u.test(trimmed)) return null;
  // Provider coordinates are bearer capabilities, never status prose.
  if (/\b(?:https?|wss?|cdp):\/\/|\b(?:cookie|authorization|bearer)\b/iu.test(trimmed)) return null;
  return trimmed;
}

function opaqueSealedText(value: unknown): string | null {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") === 0 || Buffer.byteLength(value, "utf8") > OPERATION_PROVIDER_REF_MAX_CHARS) return null;
  // This is structural recognition only. AEAD authentication and context
  // binding are verified by the server-only operation secret codec on read.
  return isConnectedWebOperationSealedEnvelope(value) ? value : null;
}

function nonnegativeMicros(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function safeOperationDate(value: Date | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value.getTime())) throw new ConnectedWebAccountStoreError("conflict");
  return value;
}

/** Parse exactly the sealed coordinate envelope accepted by the DB/store boundary. */
export function parseConnectedWebOperationProviderReferences(value: unknown): ConnectedWebOperationProviderReferences | null {
  if (!isPlainRecord(value)) return null;
  const keys = ["version", "sessionRef", "runRef", "workspaceRef", "browserRef"] as const;
  if (!Object.keys(value).every((key) => keys.includes(key as (typeof keys)[number])) || value["version"] !== 1) return null;
  const result: { version: 1; sessionRef?: string; runRef?: string; workspaceRef?: string; browserRef?: string } = { version: 1 };
  for (const key of ["sessionRef", "runRef", "workspaceRef", "browserRef"] as const) {
    if (value[key] === undefined) continue;
    const parsed = opaqueSealedText(value[key]);
    if (parsed === null) return null;
    result[key] = parsed;
  }
  return result;
}

/** Parse activity before it becomes durable or wakes an initiating Genie. */
export function parseConnectedWebOperationSafeActivity(value: unknown): ConnectedWebOperationSafeActivity | null {
  if (!isPlainRecord(value) || !exactKeys(value, ["code", "phase", "summary", "version"]) || value["version"] !== 1) return null;
  const phase = value["phase"];
  if (phase !== "starting" && phase !== "working" && phase !== "checking" && phase !== "attention" && phase !== "finishing") return null;
  const code = safeOperationText(value["code"], OPERATION_SAFE_CODE_MAX_CHARS);
  const summary = safeOperationText(value["summary"], OPERATION_SAFE_SUMMARY_MAX_CHARS);
  return code && summary ? { version: 1, phase, code, summary } : null;
}

/** Terminal receipts contain only the operator-safe fact, never output/page/provider data. */
export function parseConnectedWebOperationSafeReceipt(value: unknown): ConnectedWebOperationSafeReceipt | null {
  if (!isPlainRecord(value)) return null;
  const keys = ["version", "outcome", "code", "summary", "actionOperationId"];
  if (!Object.keys(value).every((key) => keys.includes(key)) || value["version"] !== 1) return null;
  const outcome = value["outcome"];
  if (outcome !== "completed" && outcome !== "cancelled" && outcome !== "failed" && outcome !== "attention_required" && outcome !== "ambiguous") return null;
  const code = safeOperationText(value["code"], OPERATION_SAFE_CODE_MAX_CHARS);
  const summary = safeOperationText(value["summary"], OPERATION_SAFE_SUMMARY_MAX_CHARS);
  if (!code || !summary) return null;
  const actionOperationId = value["actionOperationId"];
  if (actionOperationId !== undefined && (typeof actionOperationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(actionOperationId))) return null;
  return actionOperationId === undefined
    ? { version: 1, outcome, code, summary }
    : { version: 1, outcome, code, summary, actionOperationId };
}

function assertOperationAdmission(input: ConnectedWebOperationAdmission): void {
  const nonempty = [input.id, input.ownerUserId, ...(input.accountId === null ? [] : [input.accountId]), input.initiatingAgentId, input.initiatingRoomId, input.initiatingThreadId, input.initiatingLane, input.deliveryId, input.requestDigest, input.sealedIntent];
  if (nonempty.some((value) => value.trim().length === 0) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(input.id) || Buffer.byteLength(input.initiatingThreadId, "utf8") > 512 || Buffer.byteLength(input.initiatingLane, "utf8") > 128 || Buffer.byteLength(input.deliveryId, "utf8") > 256 || !/^[0-9a-f]{64}$/u.test(input.requestDigest) || Buffer.byteLength(input.sealedIntent, "utf8") > OPERATION_SEALED_INTENT_MAX_CHARS || !isConnectedWebOperationSealedEnvelope(input.sealedIntent) || !nonnegativeMicros(input.remainingBudgetUsdMicros) || !parseConnectedWebOperationSafeActivity(input.safeActivity) || (input.effectIdempotencyKey !== undefined && input.effectIdempotencyKey !== null && (Buffer.byteLength(input.effectIdempotencyKey, "utf8") === 0 || Buffer.byteLength(input.effectIdempotencyKey, "utf8") > 256))) {
    throw new ConnectedWebAccountStoreError("conflict");
  }
  if (input.accountId === null && (input.actionOperationId != null || input.effectIdempotencyKey != null || (input.driver !== undefined && input.driver !== "hosted"))) throw new ConnectedWebAccountStoreError("conflict");
  safeOperationDate(input.nextCheckAt);
}

const RECEIPT_EXECUTION_REF_MAX_CHARS = 128;
const RECEIPT_POSTCONDITION_MAX_CHARS = 2_048;
const RECEIPT_EVIDENCE_CODE_MAX_CHARS = 128;

function safeReceiptText(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max
    ? value.trim()
    : null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

/**
 * JSONB is untrusted at the row boundary. This is the sole receipt parser:
 * it accepts only the deliberately small terminal receipt shape and rejects
 * provider/live/session fields rather than carrying them through a cast.
 */
export function parseConnectedWebActionSafeReceipt(value: unknown): ConnectedWebActionSafeReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!hasExactKeys(record, ["action", "cost", "effectState", "evidenceCode", "executionRef", "postcondition", "target"])) return null;
  if (record["action"] !== "save_item") return null;
  const executionRef = safeReceiptText(record["executionRef"], RECEIPT_EXECUTION_REF_MAX_CHARS);
  const target = safeReceiptText(record["target"], 1_024);
  const evidenceCode = safeReceiptText(record["evidenceCode"], RECEIPT_EVIDENCE_CODE_MAX_CHARS);
  if (!executionRef || !target || !evidenceCode || !record["cost"] || typeof record["cost"] !== "object" || Array.isArray(record["cost"])) return null;
  const cost = record["cost"] as Record<string, unknown>;
  if (!hasExactKeys(cost, ["amountUsd", "state"]) || (cost["state"] !== "actual" && cost["state"] !== "unknown")) return null;
  const amountUsd = cost["amountUsd"];
  if (cost["state"] === "actual" && (typeof amountUsd !== "number" || !Number.isFinite(amountUsd) || amountUsd < 0)) return null;
  if (cost["state"] === "unknown" && amountUsd !== null) return null;
  const effectState = record["effectState"];
  if (effectState !== "observed" && effectState !== "ambiguous" && effectState !== "cancelled"
    && effectState !== "failed" && effectState !== "authentication_required") return null;
  const postcondition = record["postcondition"] === null ? null : safeReceiptText(record["postcondition"], RECEIPT_POSTCONDITION_MAX_CHARS);
  if (record["postcondition"] !== null && postcondition === null) return null;
  if ((effectState === "observed") !== (postcondition !== null)) return null;
  return { executionRef, action: "save_item", target, effectState, postcondition, evidenceCode,
    cost: { amountUsd: amountUsd as number | null, state: cost["state"] } };
}

/** Login remains a Human connection flow; reads and private page views are busy. */
export function executionStatusForCheckpoint(
  checkpoint: ConnectedWebAccountExecutionCheckpoint,
): "connecting" | "busy" {
  return checkpoint.resource === "login" ? "connecting" : "busy";
}

/** Reads and private page views start from connected, then acquire a busy fence. */
export function executionSourceStatusForCheckpoint(
  checkpoint: ConnectedWebAccountExecutionCheckpoint,
): "connecting" | "connected" {
  return checkpoint.resource === "login" ? "connecting" : "connected";
}

/** The source state and empty checkpoint are the single-profile writer fence. */
export function canAcquireExecutionCheckpoint(input: {
  readonly status: ConnectedWebAccountStatus;
  readonly profileRef: string | null;
  readonly executionCheckpoint: ConnectedWebAccountExecutionCheckpoint | null;
  readonly checkpoint: ConnectedWebAccountExecutionReservation;
}): boolean {
  return input.profileRef !== null
    && input.executionCheckpoint === null
    && input.status === executionSourceStatusForCheckpoint(input.checkpoint);
}

/**
 * Internal lifecycle repository. Public routes only ever return
 * `ConnectedWebAccount`, never this repository's opaque references.
 */
export interface ConnectedWebAccountStore {
  createPending(input: {
    readonly ownerUserId: string;
    readonly account: ConnectedWebAccountCreateRequest;
  }): Promise<ConnectedWebAccount>;
  listForOwner(ownerUserId: string): Promise<readonly ConnectedWebAccount[]>;
  getForOwner(input: { readonly ownerUserId: string; readonly accountId: string }): Promise<ConnectedWebAccount | null>;
  getBindingForOwner(input: { readonly ownerUserId: string; readonly accountId: string }): Promise<ConnectedWebAccountBinding>;
  bindProfileReference(input: { readonly ownerUserId: string; readonly accountId: string; readonly profileRef: string }): Promise<void>;
  completeExecution(input: {
    readonly ownerUserId?: string;
    readonly accountId: string;
    readonly reservationToken: string;
    readonly status: Exclude<ConnectedWebAccountStatus, "connecting" | "busy" | "revoked">;
    readonly lastVerifiedAt?: Date | null;
    /** Action Stop binds fence release to the same provider run it cancelled. */
    readonly expectedOpaqueExecutionRef?: string;
  }): Promise<ConnectedWebAccount>;
  releaseExecutionReservation(input: {
    readonly ownerUserId: string;
    readonly accountId: string;
    readonly reservationToken: string;
    readonly status: "connected" | "attention_needed" | "provider_unavailable";
  }): Promise<void>;
  beginReconnect(input: { readonly ownerUserId: string; readonly accountId: string }): Promise<ConnectedWebAccount>;
  revokeForOwner(input: { readonly ownerUserId: string; readonly accountId: string }): Promise<ConnectedWebAccount>;
  reserveExecutionCheckpoint(input: {
    readonly ownerUserId: string;
    readonly accountId: string;
    readonly checkpoint: ConnectedWebAccountExecutionReservation;
  }): Promise<void>;
  activateExecutionCheckpoint(input: {
    readonly ownerUserId: string;
    readonly accountId: string;
    readonly reservationToken: string;
    readonly opaqueExecutionRef: string;
  }): Promise<void>;
  /**
   * Atomically reserves the sole account writer and records one exact read
   * delivery before a billable provider run is created.
   */
  admitReadOperation(input: {
    readonly admission: ConnectedWebOperationAdmission;
    readonly checkpoint: ConnectedWebAccountExecutionReservation;
    /** Pure AEAD rebind, called only for a same-conversation warm row under its DB lock. */
    readonly rebindBrowserSession?: (source: ConnectedWebOperation) => ConnectedWebOperationProviderReferences;
  }): Promise<{ readonly kind: "new" | "existing" | "conflict" | "busy"; readonly operation?: ConnectedWebOperation; readonly retiredBrowsers?: readonly ConnectedWebOperation[] }>;
  /** Cleanup claims are irreversible: retries may stop, but never revive, a claimed session. */
  claimIdleBrowserOperations(input: { readonly now: Date; readonly batch: number }): Promise<readonly ConnectedWebOperation[]>;
  completeIdleBrowserCleanup(input: { readonly operationId: string; readonly now: Date; readonly stopped: boolean }): Promise<void>;
  /**
   * The only initial transition that makes a read operation live. It commits
   * the provider's sealed coordinates and matching account run reference in
   * one transaction, so an admitted row is never a live receipt.
   */
  activateReadOperation(input: {
    readonly ownerUserId: string;
    readonly accountId: string | null;
    readonly operationId: string;
    readonly reservationToken: string;
    readonly opaqueExecutionRef: string;
    readonly sealedProviderRefs: ConnectedWebOperationProviderReferences;
    readonly safeActivity: ConnectedWebOperationSafeActivity;
    readonly now: Date;
  }): Promise<boolean>;
  /**
   * Confirmed pre-activation provider failure. This terminalizes the durable
   * admission and releases only its matching reserving checkpoint together.
   * Unknown create outcomes deliberately do not call this transition.
   */
  failAdmittedReadOperation(input: {
    readonly ownerUserId: string;
    readonly accountId: string | null;
    readonly operationId: string;
    readonly reservationToken: string;
    readonly now: Date;
    readonly receipt: ConnectedWebOperationSafeReceipt;
    /** Known, cancelled provider creation still owns a billable browser. */
    readonly sealedProviderRefs?: ConnectedWebOperationProviderReferences;
  }): Promise<boolean>;
  rotateExecutionCheckpointReference(input: { readonly ownerUserId: string; readonly accountId: string; readonly reservationToken: string; readonly opaqueExecutionRef: string; readonly expectedOpaqueExecutionRef: string }): Promise<void>;
  listStaleExecutions(): Promise<readonly ConnectedWebAccountStaleExecution[]>;
  /** Keep the exact run checkpoint until synchronous browser cleanup succeeds. */
  requestExecutionCleanup(input: {
    readonly ownerUserId?: string;
    readonly accountId: string;
    readonly reservationToken: string;
    readonly expectedOpaqueExecutionRef?: string;
    readonly status: "connected" | "attention_needed";
  }): Promise<string>;
  listPendingExecutionCleanup(): Promise<readonly ConnectedWebAccountStaleExecution[]>;
  /** A durable async read owns its account checkpoint across server restarts. */
  hasNonterminalReadOperation(input: { readonly ownerUserId: string; readonly accountId: string }): Promise<boolean>;
  listRevokedProfilesForCleanup(): Promise<readonly ConnectedWebAccountProviderCleanupCandidate[]>;
  reconcileStaleExecution(input: {
    readonly accountId: string;
    readonly status: "connected" | "attention_needed" | "provider_unavailable" | "error";
  }): Promise<void>;
  markProviderCleanupCompleted(accountId: string): Promise<void>;
  markProviderCleanupFailed(input: { readonly accountId: string; readonly safeFailureCode: string }): Promise<void>;
  /** Creates exactly one durable external-action delivery or returns its receipt-safe prior record. */
  claimActionOperation(input: {
    readonly ownerUserId: string;
    readonly accountId: string;
    readonly deliveryId: string;
    readonly requestDigest: string;
    readonly target: string;
  }): Promise<{ readonly kind: "new" | "existing" | "conflict"; readonly operation?: ConnectedWebActionOperation }>;
  /** CAS rotation keeps the ledger and account checkpoint aligned on the exact live run. */
  activateActionOperation(input: {
    readonly operationId: string;
    readonly opaqueRunRef: string;
    readonly expectedOpaqueRunRef?: string | null;
    /** A resume pre-observation rotates to another running run before the write. */
    readonly nextStatus?: "running" | "verifying";
  }): Promise<void>;
  finishActionOperation(input: {
    readonly operationId: string;
    readonly status: Exclude<ConnectedWebActionOperationStatus, "reserving" | "running" | "verifying">;
    readonly receipt: ConnectedWebActionSafeReceipt;
    /** Terminal truth may only consume the exact provider reference it observed. */
    readonly expectedOpaqueRunRef: string | null;
  }): Promise<void>;
  /** Exact owner + LangGraph delivery lookup; account labels are never an action coordinate. */
  getActionOperationForOwnerDelivery(input: { readonly ownerUserId: string; readonly deliveryId: string }): Promise<ConnectedWebActionOperation>;
  /** Reopens only the exact parked authentication delivery; never creates a second ledger row. */
  resumeActionOperation(input: {
    readonly operationId: string;
    readonly ownerUserId: string;
    readonly accountId: string;
    readonly requestDigest: string;
  }): Promise<void>;
  /** A Human cancellation before resumption is terminal and has no provider side effect. */
  cancelActionAuthentication(input: {
    readonly operationId: string;
    readonly ownerUserId: string;
    readonly receipt: ConnectedWebActionSafeReceipt;
  }): Promise<void>;
  listStaleActionOperations(): Promise<readonly ConnectedWebActionOperation[]>;
  /** Idempotently admits one exact Genie delivery into the supervisor authority. */
  admitOperation(input: ConnectedWebOperationAdmission): Promise<{
    readonly kind: "new" | "existing" | "conflict";
    readonly operation?: ConnectedWebOperation;
  }>;
  getOperationForOwner(input: { readonly ownerUserId: string; readonly operationId: string; readonly activityBefore?: number }): Promise<ConnectedWebOperation>;
  /** Startup recovery inventory; rows stay fenced and are never re-acquired. */
  listDirectOperationsForRecovery(input?: { readonly ownerUserId: string; readonly accountId: string }): Promise<readonly ConnectedWebOperation[]>;
  /** Claims due nonterminal work with a restart-safe lease; the worker must later release or advance it. */
  claimDueOperations(input: {
    readonly workerId: string;
    readonly now: Date;
    readonly batch?: number;
    readonly leaseMs: number;
  }): Promise<readonly ConnectedWebOperation[]>;
  /**
   * Fences an in-flight supervisor before steering or direct takeover.
   * The lease makes a process loss recoverable: once it expires, ordinary
   * due-work supervision may reconcile the still-due hosted operation.
   */
  claimOperationForControl(input: {
    readonly operationId: string;
    readonly ownerUserId: string;
    readonly expectedControlEpoch: number;
    readonly expectedRunRef: string;
    readonly workerId: string;
    readonly now: Date;
    readonly leaseMs: number;
    readonly safeActivity: ConnectedWebOperationSafeActivity;
  }): Promise<number | null>;
  releaseOperationClaim(input: {
    readonly operationId: string;
    readonly workerId: string;
    readonly expectedControlEpoch: number;
    readonly now: Date;
    readonly nextCheckAt: Date | null;
  }): Promise<boolean>;
  /** Atomically commits one cursor delta under the exact current worker/epoch/run fence. */
  recordOperationCheckpoint(input: {
    readonly operationId: string;
    readonly workerId: string;
    readonly now: Date;
    readonly expectedControlEpoch: number;
    readonly expectedEventCursor: number;
    readonly expectedRunRef: string | null;
    readonly sealedProviderRefs: ConnectedWebOperationProviderReferences;
    readonly eventCursor: number;
    readonly safeActivity: ConnectedWebOperationSafeActivity;
    readonly wakeFingerprint?: string | null;
    readonly nextCheckAt: Date | null;
    readonly lifecycle?: Exclude<ConnectedWebOperationLifecycle, "terminal">;
    readonly driver?: ConnectedWebOperationDriver;
    readonly cumulativeCostUsdMicros: number;
    readonly remainingBudgetUsdMicros: number;
    readonly activityEntries?: readonly ConnectedWebActivityWrite[];
  }): Promise<boolean>;
  /** Fences late events from the old run by atomically rotating epoch + sealed run reference. */
  rotateOperationProviderRun(input: {
    readonly operationId: string;
    readonly workerId: string;
    readonly now: Date;
    readonly expectedControlEpoch: number;
    readonly expectedRunRef: string | null;
    readonly sealedProviderRefs: ConnectedWebOperationProviderReferences;
    readonly safeActivity: ConnectedWebOperationSafeActivity;
    readonly nextCheckAt: Date | null;
    readonly cumulativeCostUsdMicros: number;
    readonly remainingBudgetUsdMicros: number;
  }): Promise<number | null>;
  /**
   * Interactive same-session continuation fence. This is intentionally not a
   * general provider mutation API: it accepts only the already-authorized
   * owner, exact old run reference, and current control epoch after the
   * runtime has independently proved the old run is no longer active.
   */
  rotateOperationProviderRunByControl(input: {
    readonly workerId: string;
    readonly expectedOpaqueExecutionRef: string;
    readonly opaqueExecutionRef: string;
    readonly operationId: string;
    readonly ownerUserId: string;
    readonly now: Date;
    readonly expectedControlEpoch: number;
    readonly expectedRunRef: string | null;
    readonly sealedProviderRefs: ConnectedWebOperationProviderReferences;
    readonly safeActivity: ConnectedWebOperationSafeActivity;
    readonly nextCheckAt: Date | null;
    readonly cumulativeCostUsdMicros: number;
    readonly remainingBudgetUsdMicros: number;
  }): Promise<number | null>;
  /** Rotates the single writer lease before hosted/direct/Human handoff. */
  rotateOperationDriver(input: {
    readonly operationId: string;
    readonly expectedControlEpoch: number;
    readonly now: Date;
    readonly driver: ConnectedWebOperationDriver;
    readonly lifecycle: Exclude<ConnectedWebOperationLifecycle, "terminal">;
    readonly safeActivity: ConnectedWebOperationSafeActivity;
    readonly nextCheckAt: Date | null;
    readonly controlLeaseExpiresAt?: Date | null;
  }): Promise<{ readonly controlEpoch: number; readonly controlLeaseToken: string } | null>;
  /**
   * Hosted-read takeover is one transaction: it retains the exact active read
   * writer checkpoint while fencing the hosted supervisor and making the
   * attached browser recoverable through a sealed durable reference.
   */
  takeOverReadOperationForDirect(input: {
    readonly ownerUserId: string;
    readonly accountId: string;
    readonly operationId: string;
    readonly expectedControlEpoch: number;
    readonly expectedRunRef: string;
    readonly opaqueExecutionRef: string;
    readonly sealedProviderRefs: ConnectedWebOperationProviderReferences;
    readonly now: Date;
    readonly safeActivity: ConnectedWebOperationSafeActivity;
  }): Promise<{ readonly controlEpoch: number; readonly controlLeaseToken: string } | null>;
  /** Durable check-later records a due time without holding a model turn or supervisor lease. */
  scheduleOperationCheck(input: {
    readonly operationId: string;
    readonly expectedControlEpoch: number;
    readonly now: Date;
    readonly dueAt: Date;
    readonly requestedWakeAt?: Date;
    readonly safeActivity: ConnectedWebOperationSafeActivity;
  }): Promise<boolean>;
  /**
   * Records one coarse direct-control observation without changing its writer
   * epoch. The caller must still hold the exact owner/direct epoch fence.
   */
  recordDirectOperationActivity(input: {
    readonly operationId: string;
    readonly ownerUserId: string;
    readonly expectedControlEpoch: number;
    readonly now: Date;
    readonly safeActivity: ConnectedWebOperationSafeActivity;
  }): Promise<boolean>;
  /** Claims one undelivered meaningful checkpoint for exact initiating-Genie wake delivery. */
  claimOperationWake(input: {
    readonly operationId: string;
    readonly workerId: string;
    readonly now: Date;
    readonly leaseMs: number;
  }): Promise<ConnectedWebOperation | null>;
  /** Discoverable restart-safe wake work; each row remains fenced by its claimed fingerprint. */
  claimDueOperationWakes(input: {
    readonly workerId: string;
    readonly now: Date;
    readonly leaseMs: number;
    readonly batch?: number;
  }): Promise<readonly ConnectedWebOperation[]>;
  completeOperationWake(input: {
    readonly operationId: string;
    readonly workerId: string;
    /** The exact fingerprint returned by `claimOperationWake`; stale delivery cannot consume a newer checkpoint. */
    readonly expectedWakeFingerprint: string;
    readonly now: Date;
  }): Promise<boolean>;
  releaseOperationWakeClaim(input: {
    readonly operationId: string;
    readonly workerId: string;
    /** Fence release against a checkpoint that arrived while the old wake was in flight. */
    readonly expectedWakeFingerprint: string;
    readonly now: Date;
  }): Promise<boolean>;
  /** Terminalization is one-way and requires the exact current epoch/run truth. */
  terminalizeOperation(input: ConnectedWebOperationTerminalCheckpoint & {
    readonly operationId: string;
    readonly expectedControlEpoch: number;
    readonly expectedRunRef: string | null;
    readonly now: Date;
    readonly receipt: ConnectedWebOperationSafeReceipt;
  }): Promise<boolean>;
  /**
   * Read-only terminal commit: terminal truth and release of the one account
   * writer fence are a single CAS transaction keyed by the same run.
   */
  terminalizeReadOperationAndCompleteExecution(input: ConnectedWebOperationTerminalCheckpoint & {
    readonly operationId: string;
    readonly ownerUserId: string;
    readonly accountId: string | null;
    readonly expectedControlEpoch: number;
    readonly expectedRunRef: string;
    readonly opaqueExecutionRef: string;
    readonly now: Date;
    readonly receipt: ConnectedWebOperationSafeReceipt;
    /** Null for failed/cancelled terminal truth and never provider raw text. */
    readonly terminalReadResult?: ConnectedWebTerminalReadResult | null;
    /** A validated provider auth outcome transfers exact account control to Human attention. */
    readonly authenticationRequired?: "sign_in" | "mfa" | "captcha";
  }): Promise<boolean>;
}

/** These fields commit with terminal truth, never as a replayable cost delta. */
interface ConnectedWebOperationTerminalCheckpoint {
  readonly cumulativeCostUsdMicros: number;
  readonly remainingBudgetUsdMicros: number;
  readonly safeActivity: ConnectedWebOperationSafeActivity;
  readonly wakeFingerprint: string;
}

function actionOperation(row: typeof connectedWebActionOperations.$inferSelect): ConnectedWebActionOperation {
  const receipt = parseConnectedWebActionSafeReceipt(row.receipt);
  return {
    id: row.id, ownerUserId: row.ownerUserId, accountId: row.accountId,
    deliveryId: row.deliveryId, requestDigest: row.requestDigest,
    actionType: "save_item", target: row.target, status: row.status,
    opaqueRunRef: row.opaqueRunRef,
    // Do not let malformed/stale JSONB cross the store boundary. Callers must
    // fail closed when a terminal row has no valid receipt.
    receipt: receipt !== null && receipt.executionRef === row.id && receipt.target === row.target ? receipt : null,
  };
}

function operation(row: typeof connectedWebOperations.$inferSelect): ConnectedWebOperation {
  const refs = parseConnectedWebOperationProviderReferences(row.sealedProviderRefs);
  const activity = parseConnectedWebOperationSafeActivity(row.safeActivity);
  const receipt = row.terminalReceipt === null ? null : parseConnectedWebOperationSafeReceipt(row.terminalReceipt);
  const terminalReadResult = row.terminalReadResult === null ? null : parseConnectedWebTerminalReadResult(row.terminalReadResult);
  if (refs === null || activity === null || Buffer.byteLength(row.sealedIntent, "utf8") > OPERATION_SEALED_INTENT_MAX_CHARS || !isConnectedWebOperationSealedEnvelope(row.sealedIntent) || (row.terminalReceipt !== null && receipt === null)
    || (row.terminalReadResult !== null && terminalReadResult === null)
    || (row.lifecycle === "terminal") !== (row.terminalAt !== null && receipt !== null)
    || (row.lifecycle !== "terminal" && terminalReadResult !== null)
    || !Number.isSafeInteger(row.controlEpoch) || row.controlEpoch < 1
    || !Number.isSafeInteger(row.eventCursor) || row.eventCursor < 0
    || !nonnegativeMicros(row.cumulativeCostUsdMicros) || !nonnegativeMicros(row.remainingBudgetUsdMicros)) {
    throw new ConnectedWebAccountStoreError("conflict");
  }
  return {
    id: row.id, ownerUserId: row.ownerUserId, accountId: row.accountId,
    initiatingAgentId: row.initiatingAgentId, initiatingRoomId: row.initiatingRoomId,
    initiatingThreadId: row.initiatingThreadId, initiatingLane: row.initiatingLane,
    deliveryId: row.deliveryId, requestDigest: row.requestDigest, sealedIntent: row.sealedIntent,
    actionOperationId: row.actionOperationId, effectIdempotencyKey: row.effectIdempotencyKey,
    driver: row.driver, lifecycle: row.lifecycle, controlEpoch: row.controlEpoch,
    controlLeaseToken: row.controlLeaseToken, controlLeaseExpiresAt: row.controlLeaseExpiresAt,
    sealedProviderRefs: refs, eventCursor: row.eventCursor, safeActivity: activity,
    wakeFingerprint: row.wakeFingerprint, nextCheckAt: row.nextCheckAt,
    requestedWakeAt: row.requestedWakeAt ?? null,
    supervisorClaimOwner: row.supervisorClaimOwner, supervisorClaimExpiresAt: row.supervisorClaimExpiresAt,
    wakeClaimOwner: row.wakeClaimOwner, wakeClaimExpiresAt: row.wakeClaimExpiresAt,
    wakeAttempts: row.wakeAttempts, wakeDeliveredAt: row.wakeDeliveredAt,
    cumulativeCostUsdMicros: row.cumulativeCostUsdMicros, remainingBudgetUsdMicros: row.remainingBudgetUsdMicros,
    terminalReceipt: receipt, terminalReadResult, terminalAt: row.terminalAt,
    browserIdleUntil: row.browserIdleUntil ?? null, browserCleanupStartedAt: row.browserCleanupStartedAt ?? null,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

function asPublic(row: ConnectedWebAccountRow): ConnectedWebAccount {
  return {
    id: row.id,
    service: row.service,
    origin: row.origin,
    label: row.label,
    status: row.status,
    lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Keep PostgreSQL's polymorphic JSON builder from receiving an untyped bind. */
export function activeExecutionCheckpointExpression(opaqueExecutionRef: string) {
  return sql`jsonb_set(${connectedWebAccounts.executionCheckpoint}, '{phase}', '"active"'::jsonb)
    || jsonb_build_object('opaqueExecutionRef', ${opaqueExecutionRef}::text)`;
}


export function createConnectedWebAccountStore(db: DirectDatabase = getSharedDirectDb()): ConnectedWebAccountStore {
  async function ownedRow(ownerUserId: string, accountId: string): Promise<ConnectedWebAccountRow> {
    const [row] = await db.select().from(connectedWebAccounts).where(and(
      eq(connectedWebAccounts.id, accountId),
      eq(connectedWebAccounts.ownerUserId, ownerUserId),
    )).limit(1);
    if (!row) throw new ConnectedWebAccountStoreError("not_found");
    return row;
  }

  return {
    async createPending({ ownerUserId, account }) {
      const [row] = await db.insert(connectedWebAccounts).values({
        ownerUserId,
        service: account.service,
        origin: account.origin,
        label: account.label,
        status: "connecting",
      }).returning();
      if (!row) throw new ConnectedWebAccountStoreError("conflict");
      return asPublic(row);
    },

    async listForOwner(ownerUserId) {
      const rows = await db.select().from(connectedWebAccounts)
        .where(eq(connectedWebAccounts.ownerUserId, ownerUserId))
        .orderBy(desc(connectedWebAccounts.updatedAt), desc(connectedWebAccounts.id));
      return rows.map(asPublic);
    },

    async getForOwner({ ownerUserId, accountId }) {
      const [row] = await db.select().from(connectedWebAccounts).where(and(
        eq(connectedWebAccounts.id, accountId),
        eq(connectedWebAccounts.ownerUserId, ownerUserId),
      )).limit(1);
      return row ? asPublic(row) : null;
    },

    async getBindingForOwner({ ownerUserId, accountId }) {
      const row = await ownedRow(ownerUserId, accountId);
      return {
        accountId: row.id,
        ownerUserId: row.ownerUserId,
        service: row.service,
        origin: row.origin,
        status: row.status,
        profileRef: row.profileRef,
        executionCheckpoint: row.executionCheckpoint,
      };
    },

    async bindProfileReference({ ownerUserId, accountId, profileRef }) {
      if (profileRef.length === 0) {
        throw new ConnectedWebAccountStoreError("conflict");
      }
      const [updated] = await db.update(connectedWebAccounts)
        .set({ profileRef, updatedAt: new Date() })
        .where(and(
          eq(connectedWebAccounts.id, accountId),
          eq(connectedWebAccounts.ownerUserId, ownerUserId),
          eq(connectedWebAccounts.status, "connecting"),
          isNull(connectedWebAccounts.profileRef),
        ))
        .returning({ id: connectedWebAccounts.id });
      if (!updated) throw new ConnectedWebAccountStoreError("conflict");
    },

    async completeExecution({ ownerUserId, accountId, reservationToken, status, lastVerifiedAt = null, expectedOpaqueExecutionRef }) {
      const [updated] = await db.update(connectedWebAccounts).set({
        status,
        lastVerifiedAt,
        executionCheckpoint: null,
        updatedAt: new Date(),
      }).where(and(
        eq(connectedWebAccounts.id, accountId),
        ...(ownerUserId === undefined ? [] : [eq(connectedWebAccounts.ownerUserId, ownerUserId)]),
        sql`${connectedWebAccounts.status} IN ('connecting', 'busy')`,
        sql`${connectedWebAccounts.executionCheckpoint}->>'phase' = 'active'`,
        sql`${connectedWebAccounts.executionCheckpoint}->>'reservationToken' = ${reservationToken}`,
        ...(expectedOpaqueExecutionRef === undefined ? [] : [sql`${connectedWebAccounts.executionCheckpoint}->>'opaqueExecutionRef' = ${expectedOpaqueExecutionRef}`]),
      )).returning();
      if (!updated) throw new ConnectedWebAccountStoreError("conflict");
      return asPublic(updated);
    },

    async releaseExecutionReservation({ ownerUserId, accountId, reservationToken, status }) {
      const [updated] = await db.update(connectedWebAccounts).set({
        status,
        executionCheckpoint: null,
        updatedAt: new Date(),
      }).where(and(
        eq(connectedWebAccounts.id, accountId),
        eq(connectedWebAccounts.ownerUserId, ownerUserId),
        sql`${connectedWebAccounts.status} IN ('connecting', 'busy')`,
        sql`${connectedWebAccounts.executionCheckpoint}->>'phase' = 'reserving'`,
        sql`${connectedWebAccounts.executionCheckpoint}->>'reservationToken' = ${reservationToken}`,
      )).returning({ id: connectedWebAccounts.id });
      if (!updated) throw new ConnectedWebAccountStoreError("conflict");
    },

    async beginReconnect({ ownerUserId, accountId }) {
      const row = await ownedRow(ownerUserId, accountId);
      if (row.status === "revoked" || row.status === "busy" || row.executionCheckpoint !== null) throw new ConnectedWebAccountStoreError("conflict");
      const [updated] = await db.update(connectedWebAccounts).set({
        status: "connecting",
        updatedAt: new Date(),
      }).where(and(
        eq(connectedWebAccounts.id, accountId),
        eq(connectedWebAccounts.ownerUserId, ownerUserId),
        isNull(connectedWebAccounts.executionCheckpoint),
        sql`${connectedWebAccounts.status} IN ('connecting', 'connected', 'attention_needed', 'expired', 'provider_unavailable', 'error')`,
      )).returning();
      if (!updated) throw new ConnectedWebAccountStoreError("conflict");
      return asPublic(updated);
    },

    async revokeForOwner({ ownerUserId, accountId }) {
      const row = await ownedRow(ownerUserId, accountId);
      const now = new Date();
      const [updated] = await db.update(connectedWebAccounts).set({
        status: "revoked",
        revokedAt: now,
        cleanupState: row.profileRef ? "pending" : "not_required",
        cleanupFailureCode: null,
        updatedAt: now,
      }).where(eq(connectedWebAccounts.id, accountId)).returning();
      if (!updated) throw new ConnectedWebAccountStoreError("not_found");
      return asPublic(updated);
    },

    async reserveExecutionCheckpoint({ ownerUserId, accountId, checkpoint }) {
      const [updated] = await db.update(connectedWebAccounts).set({
        status: executionStatusForCheckpoint(checkpoint),
        executionCheckpoint: checkpoint,
        updatedAt: new Date(),
      }).where(and(
        eq(connectedWebAccounts.id, accountId),
        eq(connectedWebAccounts.ownerUserId, ownerUserId),
        isNotNull(connectedWebAccounts.profileRef),
        isNull(connectedWebAccounts.executionCheckpoint),
        eq(connectedWebAccounts.status, executionSourceStatusForCheckpoint(checkpoint)),
      )).returning({ id: connectedWebAccounts.id });
      if (!updated) throw new ConnectedWebAccountStoreError("conflict");
    },

    async activateExecutionCheckpoint({ ownerUserId, accountId, reservationToken, opaqueExecutionRef }) {
      if (reservationToken.length === 0 || opaqueExecutionRef.length === 0) {
        throw new ConnectedWebAccountStoreError("conflict");
      }
      const [updated] = await db.update(connectedWebAccounts).set({
        executionCheckpoint: activeExecutionCheckpointExpression(opaqueExecutionRef),
        updatedAt: new Date(),
      }).where(and(
        eq(connectedWebAccounts.id, accountId),
        eq(connectedWebAccounts.ownerUserId, ownerUserId),
        sql`${connectedWebAccounts.executionCheckpoint}->>'phase' = 'reserving'`,
        sql`${connectedWebAccounts.executionCheckpoint}->>'reservationToken' = ${reservationToken}`,
      )).returning({ id: connectedWebAccounts.id });
      if (!updated) throw new ConnectedWebAccountStoreError("conflict");
    },

    async rotateExecutionCheckpointReference({ ownerUserId, accountId, reservationToken, opaqueExecutionRef, expectedOpaqueExecutionRef }) {
      if (!opaqueExecutionRef || !expectedOpaqueExecutionRef) throw new ConnectedWebAccountStoreError("conflict");
      const [updated] = await db.update(connectedWebAccounts).set({
        executionCheckpoint: activeExecutionCheckpointExpression(opaqueExecutionRef), updatedAt: new Date(),
      }).where(and(eq(connectedWebAccounts.id, accountId), eq(connectedWebAccounts.ownerUserId, ownerUserId),
        sql`${connectedWebAccounts.executionCheckpoint}->>'phase' = 'active'`,
        sql`${connectedWebAccounts.executionCheckpoint}->>'reservationToken' = ${reservationToken}`,
        sql`${connectedWebAccounts.executionCheckpoint}->>'opaqueExecutionRef' = ${expectedOpaqueExecutionRef}`,
      )).returning({ id: connectedWebAccounts.id });
      if (!updated) throw new ConnectedWebAccountStoreError("conflict");
    },

    async requestExecutionCleanup(input) {
      const [row] = await db.update(connectedWebAccounts).set({
        executionCheckpoint: sql`${connectedWebAccounts.executionCheckpoint} || jsonb_build_object('cleanupStatus', ${input.status}::text)`,
        updatedAt: new Date(),
      }).where(and(
        eq(connectedWebAccounts.id, input.accountId),
        ...(input.ownerUserId === undefined ? [] : [eq(connectedWebAccounts.ownerUserId, input.ownerUserId)]),
        eq(connectedWebAccounts.status, "busy"),
        sql`${connectedWebAccounts.executionCheckpoint}->>'resource' IN ('read', 'action')`,
        sql`${connectedWebAccounts.executionCheckpoint}->>'phase' = 'active'`,
        sql`${connectedWebAccounts.executionCheckpoint}->>'reservationToken' = ${input.reservationToken}`,
        ...(input.expectedOpaqueExecutionRef === undefined ? [] : [sql`${connectedWebAccounts.executionCheckpoint}->>'opaqueExecutionRef' = ${input.expectedOpaqueExecutionRef}`]),
      )).returning({ checkpoint: connectedWebAccounts.executionCheckpoint });
      if (!row?.checkpoint?.opaqueExecutionRef) throw new ConnectedWebAccountStoreError("conflict");
      return row.checkpoint.opaqueExecutionRef;
    },

    async listPendingExecutionCleanup() {
      const rows = await db.select().from(connectedWebAccounts).where(and(
        eq(connectedWebAccounts.status, "busy"),
        sql`${connectedWebAccounts.executionCheckpoint}->>'cleanupStatus' IN ('connected', 'attention_needed')`,
      ));
      return rows.flatMap((row) => row.executionCheckpoint
        ? [{ accountId: row.id, ownerUserId: row.ownerUserId, checkpoint: row.executionCheckpoint }]
        : []);
    },

    async listStaleExecutions() {
      const rows = await db.select().from(connectedWebAccounts).where(and(
        isNotNull(connectedWebAccounts.executionCheckpoint),
        // Only non-terminal lifecycle work needs provider reconciliation.
        sql`${connectedWebAccounts.status} IN ('connecting', 'busy')`,
      ));
      return rows.flatMap((row) => row.executionCheckpoint
        ? [{ accountId: row.id, ownerUserId: row.ownerUserId, checkpoint: row.executionCheckpoint }]
        : []);
    },

    async hasNonterminalReadOperation({ ownerUserId, accountId }) {
      const [row] = await db.select({ id: connectedWebOperations.id }).from(connectedWebOperations).where(and(
        eq(connectedWebOperations.ownerUserId, ownerUserId),
        eq(connectedWebOperations.accountId, accountId),
        isNull(connectedWebOperations.actionOperationId),
        sql`${connectedWebOperations.lifecycle} <> 'terminal'`,
      )).limit(1);
      return row !== undefined;
    },

    async listRevokedProfilesForCleanup() {
      const rows = await db.select({
        accountId: connectedWebAccounts.id,
        profileRef: connectedWebAccounts.profileRef,
      }).from(connectedWebAccounts).where(and(
        eq(connectedWebAccounts.status, "revoked"),
        isNotNull(connectedWebAccounts.profileRef),
        sql`${connectedWebAccounts.cleanupState} IN ('pending', 'failed')`,
      ));
      return rows.flatMap((row) => row.profileRef === null
        ? []
        : [{ accountId: row.accountId, profileRef: row.profileRef }]);
    },

    async reconcileStaleExecution({ accountId, status }) {
      const [row] = await db.select({ checkpoint: connectedWebAccounts.executionCheckpoint })
        .from(connectedWebAccounts).where(eq(connectedWebAccounts.id, accountId)).limit(1);
      if (!row?.checkpoint) return;
      if (row.checkpoint.phase === "reserving") {
        await db.update(connectedWebAccounts).set({ status, executionCheckpoint: null, updatedAt: new Date() })
          .where(and(eq(connectedWebAccounts.id, accountId), sql`${connectedWebAccounts.executionCheckpoint}->>'phase' = 'reserving'`, sql`${connectedWebAccounts.executionCheckpoint}->>'reservationToken' = ${row.checkpoint.reservationToken}`));
        return;
      }
      await db.update(connectedWebAccounts).set({ status, executionCheckpoint: null, updatedAt: new Date() })
        .where(and(
          eq(connectedWebAccounts.id, accountId),
          sql`${connectedWebAccounts.status} IN ('connecting', 'busy')`,
          sql`${connectedWebAccounts.executionCheckpoint}->>'phase' = 'active'`,
          sql`${connectedWebAccounts.executionCheckpoint}->>'reservationToken' = ${row.checkpoint.reservationToken}`,
        ));
    },

    async markProviderCleanupCompleted(accountId) {
      await db.update(connectedWebAccounts).set({
        cleanupState: "completed",
        cleanupFailureCode: null,
        executionCheckpoint: null,
        updatedAt: new Date(),
      }).where(and(
        eq(connectedWebAccounts.id, accountId),
        eq(connectedWebAccounts.status, "revoked"),
      ));
    },

    async markProviderCleanupFailed({ accountId, safeFailureCode }) {
      if (safeFailureCode.length === 0 || safeFailureCode.length > 128) {
        throw new ConnectedWebAccountStoreError("conflict");
      }
      await db.update(connectedWebAccounts).set({
        cleanupState: "failed",
        cleanupFailureCode: safeFailureCode,
        updatedAt: new Date(),
      }).where(and(
        eq(connectedWebAccounts.id, accountId),
        eq(connectedWebAccounts.status, "revoked"),
      ));
    },

    async claimActionOperation({ ownerUserId, accountId, deliveryId, requestDigest, target }) {
      if (!deliveryId || deliveryId.length > 256 || !/^[0-9a-f]{64}$/u.test(requestDigest)
        || !target || target.length > 1_024) throw new ConnectedWebAccountStoreError("conflict");
      const [inserted] = await db.insert(connectedWebActionOperations).values({
        ownerUserId, accountId, deliveryId, requestDigest, actionType: "save_item", target, status: "reserving",
      }).onConflictDoNothing().returning();
      if (inserted) return { kind: "new" as const, operation: actionOperation(inserted) };
      const [existing] = await db.select().from(connectedWebActionOperations).where(and(
        eq(connectedWebActionOperations.ownerUserId, ownerUserId),
        eq(connectedWebActionOperations.deliveryId, deliveryId),
      )).limit(1);
      if (!existing) throw new ConnectedWebAccountStoreError("conflict");
      if (existing.requestDigest !== requestDigest || existing.accountId !== accountId) return { kind: "conflict" as const };
      return { kind: "existing" as const, operation: actionOperation(existing) };
    },

    async activateActionOperation({ operationId, opaqueRunRef, expectedOpaqueRunRef = null, nextStatus }) {
      if (!opaqueRunRef) throw new ConnectedWebAccountStoreError("conflict");
      const targetStatus = expectedOpaqueRunRef === null ? "running" : (nextStatus ?? "verifying");
      const [updated] = await db.update(connectedWebActionOperations).set({
        status: targetStatus, opaqueRunRef, updatedAt: new Date(),
      }).where(and(
        eq(connectedWebActionOperations.id, operationId),
        expectedOpaqueRunRef === null ? isNull(connectedWebActionOperations.opaqueRunRef) : eq(connectedWebActionOperations.opaqueRunRef, expectedOpaqueRunRef),
        expectedOpaqueRunRef === null
          ? eq(connectedWebActionOperations.status, "reserving")
          : eq(connectedWebActionOperations.status, "running"),
      ))
        .returning({ id: connectedWebActionOperations.id });
      if (!updated) throw new ConnectedWebAccountStoreError("conflict");
    },

    async finishActionOperation({ operationId, status, receipt, expectedOpaqueRunRef }) {
      const parsedReceipt = parseConnectedWebActionSafeReceipt(receipt);
      if (!parsedReceipt || parsedReceipt.executionRef !== operationId
        || (status === "completed" ? parsedReceipt.effectState !== "observed" : parsedReceipt.effectState !== status)) {
        throw new ConnectedWebAccountStoreError("conflict");
      }
      const [updated] = await db.update(connectedWebActionOperations).set({
        status, receipt: parsedReceipt, opaqueRunRef: null, updatedAt: new Date(),
      }).where(and(
        eq(connectedWebActionOperations.id, operationId),
        sql`${connectedWebActionOperations.status} in ('reserving', 'running', 'verifying')`,
        expectedOpaqueRunRef === null ? isNull(connectedWebActionOperations.opaqueRunRef) : eq(connectedWebActionOperations.opaqueRunRef, expectedOpaqueRunRef),
      ))
        .returning({ id: connectedWebActionOperations.id });
      if (!updated) throw new ConnectedWebAccountStoreError("conflict");
    },

    async getActionOperationForOwnerDelivery({ ownerUserId, deliveryId }) {
      if (!deliveryId || deliveryId.length > 256) throw new ConnectedWebAccountStoreError("not_found");
      const [row] = await db.select().from(connectedWebActionOperations).where(and(
        eq(connectedWebActionOperations.ownerUserId, ownerUserId),
        eq(connectedWebActionOperations.deliveryId, deliveryId),
      )).limit(1);
      if (!row) throw new ConnectedWebAccountStoreError("not_found");
      return actionOperation(row);
    },

    async resumeActionOperation({ operationId, ownerUserId, accountId, requestDigest }) {
      const [updated] = await db.update(connectedWebActionOperations).set({
        status: "reserving", opaqueRunRef: null, receipt: null, updatedAt: new Date(),
      }).where(and(
        eq(connectedWebActionOperations.id, operationId),
        eq(connectedWebActionOperations.ownerUserId, ownerUserId),
        eq(connectedWebActionOperations.accountId, accountId),
        eq(connectedWebActionOperations.requestDigest, requestDigest),
        eq(connectedWebActionOperations.status, "authentication_required"),
        isNull(connectedWebActionOperations.opaqueRunRef),
      )).returning({ id: connectedWebActionOperations.id });
      if (!updated) throw new ConnectedWebAccountStoreError("conflict");
    },

    async cancelActionAuthentication({ operationId, ownerUserId, receipt }) {
      const parsedReceipt = parseConnectedWebActionSafeReceipt(receipt);
      if (!parsedReceipt || parsedReceipt.executionRef !== operationId || parsedReceipt.effectState !== "cancelled") {
        throw new ConnectedWebAccountStoreError("conflict");
      }
      const [updated] = await db.update(connectedWebActionOperations).set({
        status: "cancelled", opaqueRunRef: null, receipt: parsedReceipt, updatedAt: new Date(),
      }).where(and(
        eq(connectedWebActionOperations.id, operationId),
        eq(connectedWebActionOperations.ownerUserId, ownerUserId),
        eq(connectedWebActionOperations.status, "authentication_required"),
        isNull(connectedWebActionOperations.opaqueRunRef),
      )).returning({ id: connectedWebActionOperations.id });
      if (!updated) throw new ConnectedWebAccountStoreError("conflict");
    },

    async listStaleActionOperations() {
      const rows = await db.select().from(connectedWebActionOperations).where(
        sql`${connectedWebActionOperations.status} in ('reserving', 'running', 'verifying')`,
      );
      return rows.map(actionOperation);
    },

    async admitReadOperation({ admission, checkpoint, rebindBrowserSession }) {
      assertOperationAdmission(admission);
      if (checkpoint.resource !== "read" || checkpoint.phase !== "reserving"
        || checkpoint.reservationToken.trim().length === 0 || Number.isNaN(Date.parse(checkpoint.recordedAt))) {
        throw new ConnectedWebAccountStoreError("conflict");
      }
      const activity = parseConnectedWebOperationSafeActivity(admission.safeActivity);
      if (!activity) throw new ConnectedWebAccountStoreError("conflict");
      const sameDelivery = (existing: typeof connectedWebOperations.$inferSelect) => (
        existing.accountId === admission.accountId
        && existing.requestDigest === admission.requestDigest
        && existing.initiatingAgentId === admission.initiatingAgentId
        && existing.initiatingRoomId === admission.initiatingRoomId
        && existing.initiatingThreadId === admission.initiatingThreadId
        && existing.initiatingLane === admission.initiatingLane
      );
      const values = {
        id: admission.id,
        ownerUserId: admission.ownerUserId,
        accountId: admission.accountId,
        initiatingAgentId: admission.initiatingAgentId,
        initiatingRoomId: admission.initiatingRoomId,
        initiatingThreadId: admission.initiatingThreadId,
        initiatingLane: admission.initiatingLane,
        deliveryId: admission.deliveryId,
        requestDigest: admission.requestDigest,
        sealedIntent: admission.sealedIntent,
        actionOperationId: admission.actionOperationId ?? null,
        effectIdempotencyKey: admission.effectIdempotencyKey ?? null,
        driver: admission.driver ?? "hosted",
        lifecycle: "admitted" as const,
        safeActivity: activity,
        remainingBudgetUsdMicros: admission.remainingBudgetUsdMicros,
        // Admitted is durable intent plus an account reservation, not a live
        // provider operation. Only activateReadOperation makes it due.
        nextCheckAt: null,
      };
      return db.transaction(async (tx) => {
        const [before] = await tx.select().from(connectedWebOperations).where(and(
          eq(connectedWebOperations.ownerUserId, admission.ownerUserId),
          eq(connectedWebOperations.deliveryId, admission.deliveryId),
        )).limit(1);
        if (before) return sameDelivery(before)
          ? { kind: "existing" as const, operation: operation(before) }
          : { kind: "conflict" as const };

        if (admission.accountId === null) {
          const [inserted] = await tx.insert(connectedWebOperations).values(values).onConflictDoNothing().returning();
          if (inserted) return { kind: "new" as const, operation: operation(inserted) };
          const [existing] = await tx.select().from(connectedWebOperations).where(and(
            eq(connectedWebOperations.ownerUserId, admission.ownerUserId),
            eq(connectedWebOperations.deliveryId, admission.deliveryId),
          )).limit(1);
          return existing && sameDelivery(existing)
            ? { kind: "existing" as const, operation: operation(existing) }
            : { kind: "conflict" as const };
        }

        const [reserved] = await tx.update(connectedWebAccounts).set({
          status: "busy",
          executionCheckpoint: checkpoint,
          updatedAt: new Date(),
        }).where(and(
          eq(connectedWebAccounts.id, admission.accountId),
          eq(connectedWebAccounts.ownerUserId, admission.ownerUserId),
          eq(connectedWebAccounts.status, "connected"),
          isNotNull(connectedWebAccounts.profileRef),
          isNull(connectedWebAccounts.executionCheckpoint),
        )).returning({ id: connectedWebAccounts.id });
        if (!reserved) {
          const [existing] = await tx.select().from(connectedWebOperations).where(and(
            eq(connectedWebOperations.ownerUserId, admission.ownerUserId),
            eq(connectedWebOperations.deliveryId, admission.deliveryId),
          )).limit(1);
          if (existing) return sameDelivery(existing)
            ? { kind: "existing" as const, operation: operation(existing) }
            : { kind: "conflict" as const };
          return { kind: "busy" as const };
        }

        // The account writer reservation serializes new turns. Lock terminal
        // custody too: an idle cleanup claim and reuse must have one winner.
        const now = new Date(checkpoint.recordedAt);
        const held = rebindBrowserSession === undefined ? [] : await tx.select().from(connectedWebOperations).where(and(
          eq(connectedWebOperations.accountId, admission.accountId),
          eq(connectedWebOperations.ownerUserId, admission.ownerUserId),
          eq(connectedWebOperations.lifecycle, "terminal"),
          isNotNull(connectedWebOperations.browserIdleUntil),
        )).orderBy(desc(connectedWebOperations.terminalAt)).for("update");
        const warm = held.find((row) => canReuseConnectedWebBrowser(operation(row), admission, now));
        const inherited = warm && rebindBrowserSession ? parseConnectedWebOperationProviderReferences(rebindBrowserSession(operation(warm))) : null;
        if (warm && (!inherited?.sessionRef || inherited.runRef || inherited.browserRef)) throw new ConnectedWebAccountStoreError("conflict");
        const [inserted] = await tx.insert(connectedWebOperations).values({ ...values, ...(inherited ? { sealedProviderRefs: inherited } : {}) })
          .onConflictDoNothing().returning();
        if (inserted) {
          const retiredBrowsers: ConnectedWebOperation[] = [];
          for (const row of held) {
            if (row.id === warm?.id) {
              // Same transaction: the new admitted row now owns the sealed
              // session even if the process dies before its POST /runs.
              await tx.update(connectedWebOperations).set({ browserIdleUntil: null }).where(eq(connectedWebOperations.id, row.id));
            } else {
              await tx.update(connectedWebOperations).set({ browserCleanupStartedAt: now }).where(eq(connectedWebOperations.id, row.id));
              retiredBrowsers.push(operation({ ...row, browserCleanupStartedAt: now }));
            }
          }
          return { kind: "new" as const, operation: operation(inserted), retiredBrowsers };
        }

        // A same-delivery race cannot retain a reservation from this loser.
        const [released] = await tx.update(connectedWebAccounts).set({
          status: "connected", executionCheckpoint: null, updatedAt: new Date(),
        }).where(and(
          eq(connectedWebAccounts.id, admission.accountId),
          eq(connectedWebAccounts.ownerUserId, admission.ownerUserId),
          eq(connectedWebAccounts.status, "busy"),
          sql`${connectedWebAccounts.executionCheckpoint}->>'phase' = 'reserving'`,
          sql`${connectedWebAccounts.executionCheckpoint}->>'reservationToken' = ${checkpoint.reservationToken}`,
        )).returning({ id: connectedWebAccounts.id });
        if (!released) throw new ConnectedWebAccountStoreError("conflict");
        const [existing] = await tx.select().from(connectedWebOperations).where(and(
          eq(connectedWebOperations.ownerUserId, admission.ownerUserId),
          eq(connectedWebOperations.deliveryId, admission.deliveryId),
        )).limit(1);
        if (!existing) throw new ConnectedWebAccountStoreError("conflict");
        return sameDelivery(existing)
          ? { kind: "existing" as const, operation: operation(existing) }
          : { kind: "conflict" as const };
      });
    },

    async claimIdleBrowserOperations({ now, batch }) {
      if (!Number.isSafeInteger(batch) || batch < 1 || batch > OPERATION_CLAIM_BATCH_MAX) throw new ConnectedWebAccountStoreError("conflict");
      return db.transaction(async (tx) => {
        const due = await tx.select().from(connectedWebOperations).where(and(
          eq(connectedWebOperations.lifecycle, "terminal"), lte(connectedWebOperations.browserIdleUntil, now),
        )).orderBy(connectedWebOperations.browserIdleUntil).limit(batch).for("update", { skipLocked: true });
        const result: ConnectedWebOperation[] = [];
        for (const row of due) {
          const [claimed] = await tx.update(connectedWebOperations).set({
            browserCleanupStartedAt: row.browserCleanupStartedAt ?? now,
            // Retry cadence only; the irreversible fence above forbids reuse.
            browserIdleUntil: new Date(now.getTime() + CONNECTED_WEB_BROWSER_CLEANUP_RETRY_MS),
          }).where(eq(connectedWebOperations.id, row.id)).returning();
          if (claimed) result.push(operation(claimed));
        }
        return result;
      });
    },

    async completeIdleBrowserCleanup({ operationId, now, stopped }) {
      await db.update(connectedWebOperations).set({
        browserIdleUntil: stopped ? null : new Date(now.getTime() + CONNECTED_WEB_BROWSER_CLEANUP_RETRY_MS),
      }).where(and(eq(connectedWebOperations.id, operationId), isNotNull(connectedWebOperations.browserCleanupStartedAt)));
    },

    async activateReadOperation({ ownerUserId, accountId, operationId, reservationToken, opaqueExecutionRef, sealedProviderRefs, safeActivity, now }) {
      const refs = parseConnectedWebOperationProviderReferences(sealedProviderRefs);
      const activity = parseConnectedWebOperationSafeActivity(safeActivity);
      const activatedAt = safeOperationDate(now);
      if (!refs?.runRef || !activity || !activatedAt || !reservationToken || !opaqueExecutionRef) {
        throw new ConnectedWebAccountStoreError("conflict");
      }
      return db.transaction(async (tx) => {
        if (accountId !== null) {
        const [checkpoint] = await tx.update(connectedWebAccounts).set({
          executionCheckpoint: activeExecutionCheckpointExpression(opaqueExecutionRef),
          updatedAt: activatedAt,
        }).where(and(
          eq(connectedWebAccounts.id, accountId),
          eq(connectedWebAccounts.ownerUserId, ownerUserId),
          eq(connectedWebAccounts.status, "busy"),
          sql`${connectedWebAccounts.executionCheckpoint}->>'resource' = 'read'`,
          sql`${connectedWebAccounts.executionCheckpoint}->>'phase' = 'reserving'`,
          sql`${connectedWebAccounts.executionCheckpoint}->>'reservationToken' = ${reservationToken}`,
        )).returning({ id: connectedWebAccounts.id });
        if (!checkpoint) return false;
        }
        const [operationRow] = await tx.update(connectedWebOperations).set({
          lifecycle: "running",
          sealedProviderRefs: refs,
          safeActivity: activity,
          nextCheckAt: activatedAt,
          updatedAt: activatedAt,
        }).where(and(
          eq(connectedWebOperations.id, operationId),
          eq(connectedWebOperations.ownerUserId, ownerUserId),
          accountId === null ? isNull(connectedWebOperations.accountId) : eq(connectedWebOperations.accountId, accountId),
          eq(connectedWebOperations.lifecycle, "admitted"),
          sql`${connectedWebOperations.sealedProviderRefs}->>'runRef' is null`,
        )).returning({ id: connectedWebOperations.id });
        if (!operationRow) throw new ConnectedWebAccountStoreError("conflict");
        return true;
      });
    },

    async failAdmittedReadOperation({ ownerUserId, accountId, operationId, reservationToken, now, receipt, sealedProviderRefs }) {
      const parsedReceipt = parseConnectedWebOperationSafeReceipt(receipt);
      const refs = sealedProviderRefs === undefined ? null : parseConnectedWebOperationProviderReferences(sealedProviderRefs);
      const terminalAt = safeOperationDate(now);
      if (!parsedReceipt || !terminalAt || !reservationToken || (sealedProviderRefs !== undefined && !refs)) throw new ConnectedWebAccountStoreError("conflict");
      return db.transaction(async (tx) => {
        const [terminalized] = await tx.update(connectedWebOperations).set({
          lifecycle: "terminal",
          ...(refs === null ? {} : { sealedProviderRefs: refs }),
          terminalReceipt: parsedReceipt,
          terminalAt,
          browserIdleUntil: terminalAt,
          nextCheckAt: null,
          updatedAt: terminalAt,
        }).where(and(
          eq(connectedWebOperations.id, operationId),
          eq(connectedWebOperations.ownerUserId, ownerUserId),
          accountId === null ? isNull(connectedWebOperations.accountId) : eq(connectedWebOperations.accountId, accountId),
          eq(connectedWebOperations.lifecycle, "admitted"),
          sql`${connectedWebOperations.sealedProviderRefs}->>'runRef' is null`,
          isNull(connectedWebOperations.actionOperationId),
        )).returning({ id: connectedWebOperations.id });
        if (!terminalized) return false;
        if (accountId === null) return true;
        const [released] = await tx.update(connectedWebAccounts).set({
          status: "connected", executionCheckpoint: null, updatedAt: terminalAt,
        }).where(and(
          eq(connectedWebAccounts.id, accountId),
          eq(connectedWebAccounts.ownerUserId, ownerUserId),
          eq(connectedWebAccounts.status, "busy"),
          sql`${connectedWebAccounts.executionCheckpoint}->>'resource' = 'read'`,
          sql`${connectedWebAccounts.executionCheckpoint}->>'phase' = 'reserving'`,
          sql`${connectedWebAccounts.executionCheckpoint}->>'reservationToken' = ${reservationToken}`,
        )).returning({ id: connectedWebAccounts.id });
        if (!released) throw new ConnectedWebAccountStoreError("conflict");
        return true;
      });
    },

    async admitOperation(input) {
      assertOperationAdmission(input);
      // The operation's account scope must be proven server-side. An account
      // UUID alone is never authority to bind another Human's saved profile.
      if (input.accountId === null) throw new ConnectedWebAccountStoreError("conflict");
      await ownedRow(input.ownerUserId, input.accountId);
      const safeActivity = parseConnectedWebOperationSafeActivity(input.safeActivity);
      if (!safeActivity) throw new ConnectedWebAccountStoreError("conflict");
      const [inserted] = await db.insert(connectedWebOperations).values({
        id: input.id,
        ownerUserId: input.ownerUserId,
        accountId: input.accountId,
        initiatingAgentId: input.initiatingAgentId,
        initiatingRoomId: input.initiatingRoomId,
        initiatingThreadId: input.initiatingThreadId,
        initiatingLane: input.initiatingLane,
        deliveryId: input.deliveryId,
        requestDigest: input.requestDigest,
        sealedIntent: input.sealedIntent,
        actionOperationId: input.actionOperationId ?? null,
        effectIdempotencyKey: input.effectIdempotencyKey ?? null,
        driver: input.driver ?? "hosted",
        lifecycle: "admitted",
        safeActivity,
        remainingBudgetUsdMicros: input.remainingBudgetUsdMicros,
        nextCheckAt: safeOperationDate(input.nextCheckAt) ?? new Date(),
      }).onConflictDoNothing().returning();
      if (inserted) return { kind: "new" as const, operation: operation(inserted) };
      const [existing] = await db.select().from(connectedWebOperations).where(and(
        eq(connectedWebOperations.ownerUserId, input.ownerUserId),
        eq(connectedWebOperations.deliveryId, input.deliveryId),
      )).limit(1);
      if (!existing) throw new ConnectedWebAccountStoreError("conflict");
      if (existing.accountId !== input.accountId || existing.requestDigest !== input.requestDigest
        || existing.initiatingAgentId !== input.initiatingAgentId || existing.initiatingRoomId !== input.initiatingRoomId
        || existing.initiatingThreadId !== input.initiatingThreadId || existing.initiatingLane !== input.initiatingLane) {
        return { kind: "conflict" as const };
      }
      return { kind: "existing" as const, operation: operation(existing) };
    },

    async getOperationForOwner({ ownerUserId, operationId, activityBefore }) {
      const [row] = await db.select().from(connectedWebOperations).where(and(
        eq(connectedWebOperations.id, operationId),
        eq(connectedWebOperations.ownerUserId, ownerUserId),
      )).limit(1);
      if (!row) throw new ConnectedWebAccountStoreError("not_found");
      if (activityBefore !== undefined && (!Number.isSafeInteger(activityBefore) || activityBefore < 1)) throw new ConnectedWebAccountStoreError("conflict");
      const recent = await db.select().from(connectedWebOperationActivityEntries).where(and(
        eq(connectedWebOperationActivityEntries.operationId, operationId),
        activityBefore === undefined ? undefined : lt(connectedWebOperationActivityEntries.id, activityBefore),
      )).orderBy(desc(connectedWebOperationActivityEntries.id)).limit(CONNECTED_WEB_ACTIVITY_PAGE_SIZE + 1);
      const page = recent.slice(0, CONNECTED_WEB_ACTIVITY_PAGE_SIZE).reverse();
      return { ...operation(row), activityLog: connectedWebActivityPageSchema.parse({
        entries: page.map((entry) => ({ id: entry.id, occurredAt: entry.occurredAt.toISOString(), source: "browser_agent", status: entry.status, summary: entry.summary })),
        before: recent.length > CONNECTED_WEB_ACTIVITY_PAGE_SIZE ? page[0]?.id ?? null : null,
        hasMore: recent.length > CONNECTED_WEB_ACTIVITY_PAGE_SIZE,
      }) };
    },

    async listDirectOperationsForRecovery(input) {
      const rows = await db.select().from(connectedWebOperations).where(and(
        eq(connectedWebOperations.driver, "direct"),
        input ? eq(connectedWebOperations.ownerUserId, input.ownerUserId) : undefined,
        input ? eq(connectedWebOperations.accountId, input.accountId) : undefined,
        sql`${connectedWebOperations.lifecycle} <> 'terminal'`,
        sql`${connectedWebOperations.sealedProviderRefs}->>'browserRef' is not null`,
      ));
      return rows.map(operation);
    },

    async claimDueOperations({ workerId, now, batch = 1, leaseMs }) {
      if (!workerId || workerId.length > OPERATION_WORKER_ID_MAX_CHARS || !Number.isSafeInteger(batch)
        || batch < 1 || batch > OPERATION_CLAIM_BATCH_MAX || !Number.isSafeInteger(leaseMs) || leaseMs < 1) {
        throw new ConnectedWebAccountStoreError("conflict");
      }
      const claimedAt = safeOperationDate(now);
      if (!claimedAt) throw new ConnectedWebAccountStoreError("conflict");
      const expiresAt = new Date(claimedAt.getTime() + leaseMs);
      return db.transaction(async (tx) => {
        const candidates = await tx.select({ id: connectedWebOperations.id }).from(connectedWebOperations).where(and(
          sql`${connectedWebOperations.lifecycle} in ('running', 'attention')`,
          lte(connectedWebOperations.nextCheckAt, claimedAt),
          or(isNull(connectedWebOperations.supervisorClaimExpiresAt), lte(connectedWebOperations.supervisorClaimExpiresAt, claimedAt)),
        )).orderBy(connectedWebOperations.nextCheckAt, connectedWebOperations.updatedAt).limit(batch).for("update", { skipLocked: true });
        if (candidates.length === 0) return [];
        const rows = await tx.update(connectedWebOperations).set({
          supervisorClaimOwner: workerId,
          supervisorClaimExpiresAt: expiresAt,
          updatedAt: claimedAt,
        }).where(sql`${connectedWebOperations.id} in (${sql.join(candidates.map((candidate) => sql`${candidate.id}`), sql`, `)})`).returning();
        return rows.map(operation);
      });
    },

    async claimOperationForControl(input) {
      const activity = parseConnectedWebOperationSafeActivity(input.safeActivity);
      if (!activity || !input.ownerUserId || !input.expectedRunRef || !input.workerId
        || input.workerId.length > OPERATION_WORKER_ID_MAX_CHARS
        || !Number.isSafeInteger(input.expectedControlEpoch) || input.expectedControlEpoch < 1
        || !Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1) {
        throw new ConnectedWebAccountStoreError("conflict");
      }
      const claimedAt = safeOperationDate(input.now);
      if (!claimedAt) throw new ConnectedWebAccountStoreError("conflict");
      const claimExpiresAt = new Date(claimedAt.getTime() + input.leaseMs);
      const nextEpoch = input.expectedControlEpoch + 1;
      const [updated] = await db.update(connectedWebOperations).set({
        driver: "checking",
        lifecycle: "running",
        controlEpoch: nextEpoch,
        controlLeaseToken: randomUUID(),
        controlLeaseExpiresAt: null,
        safeActivity: activity,
        // Keep the operation due. The private claim blocks ordinary workers
        // only while takeover is alive, so a process loss self-recovers.
        nextCheckAt: claimedAt,
        supervisorClaimOwner: input.workerId,
        supervisorClaimExpiresAt: claimExpiresAt,
        wakeFingerprint: null,
        wakeClaimOwner: null,
        wakeClaimExpiresAt: null,
        wakeDeliveredAt: null,
        updatedAt: claimedAt,
      }).where(and(
        eq(connectedWebOperations.id, input.operationId),
        eq(connectedWebOperations.ownerUserId, input.ownerUserId),
        eq(connectedWebOperations.controlEpoch, input.expectedControlEpoch),
        sql`${connectedWebOperations.sealedProviderRefs}->>'runRef' = ${input.expectedRunRef}`,
        sql`${connectedWebOperations.lifecycle} <> 'terminal'`,
        isNull(connectedWebOperations.actionOperationId),
        isNull(connectedWebOperations.effectIdempotencyKey),
      )).returning({ controlEpoch: connectedWebOperations.controlEpoch });
      return updated?.controlEpoch ?? null;
    },

    async releaseOperationClaim({ operationId, workerId, expectedControlEpoch, now, nextCheckAt }) {
      if (!workerId || workerId.length > OPERATION_WORKER_ID_MAX_CHARS || !Number.isSafeInteger(expectedControlEpoch) || expectedControlEpoch < 1) throw new ConnectedWebAccountStoreError("conflict");
      const releasedAt = safeOperationDate(now);
      if (!releasedAt) throw new ConnectedWebAccountStoreError("conflict");
      const rows = await db.update(connectedWebOperations).set({
        supervisorClaimOwner: null,
        supervisorClaimExpiresAt: null,
        nextCheckAt: safeOperationDate(nextCheckAt),
        updatedAt: releasedAt,
      }).where(and(
        eq(connectedWebOperations.id, operationId),
        eq(connectedWebOperations.supervisorClaimOwner, workerId),
        eq(connectedWebOperations.controlEpoch, expectedControlEpoch),
        sql`${connectedWebOperations.lifecycle} <> 'terminal'`,
        gt(connectedWebOperations.supervisorClaimExpiresAt, releasedAt),
      )).returning({ id: connectedWebOperations.id });
      return rows.length === 1;
    },

    async recordOperationCheckpoint(input) {
      const refs = parseConnectedWebOperationProviderReferences(input.sealedProviderRefs);
      const activity = parseConnectedWebOperationSafeActivity(input.safeActivity);
      if (!refs || !activity || !Number.isSafeInteger(input.expectedControlEpoch) || input.expectedControlEpoch < 1
        || !Number.isSafeInteger(input.expectedEventCursor) || input.expectedEventCursor < 0
        || !Number.isSafeInteger(input.eventCursor) || input.eventCursor < input.expectedEventCursor
        || !nonnegativeMicros(input.cumulativeCostUsdMicros) || !nonnegativeMicros(input.remainingBudgetUsdMicros)
        || !input.workerId || input.workerId.length > OPERATION_WORKER_ID_MAX_CHARS) throw new ConnectedWebAccountStoreError("conflict");
      const observedAt = safeOperationDate(input.now);
      if (!observedAt) throw new ConnectedWebAccountStoreError("conflict");
      const nextCheckAt = safeOperationDate(input.nextCheckAt);
      const wakeFingerprint = input.wakeFingerprint === undefined ? undefined : input.wakeFingerprint;
      if (wakeFingerprint !== undefined && wakeFingerprint !== null && (wakeFingerprint.length === 0 || wakeFingerprint.length > 128)) throw new ConnectedWebAccountStoreError("conflict");
      const entries = input.activityEntries ?? [];
      for (const entry of entries) {
        if (entry.providerEventId <= input.expectedEventCursor || entry.providerEventId > input.eventCursor
          || !Number.isSafeInteger(entry.providerEventId)
          || !connectedWebActivityEntrySchema.safeParse({ id: entry.providerEventId, occurredAt: entry.occurredAt.toISOString(),
            source: "browser_agent", status: entry.status, summary: entry.summary }).success) throw new ConnectedWebAccountStoreError("conflict");
      }
      const commit = async (connection: Pick<DirectDatabase, "update" | "insert">) => {
      const rows = await connection.update(connectedWebOperations).set({
        sealedProviderRefs: refs,
        eventCursor: input.eventCursor,
        safeActivity: activity,
        ...(input.lifecycle === undefined ? {} : { lifecycle: input.lifecycle }),
        ...(input.driver === undefined ? {} : { driver: input.driver }),
        ...(wakeFingerprint === undefined ? {} : {
          wakeFingerprint,
          wakeDeliveredAt: wakeFingerprint === null ? null : sql`case when ${connectedWebOperations.wakeFingerprint} is distinct from ${wakeFingerprint} then null else ${connectedWebOperations.wakeDeliveredAt} end`,
        }),
        nextCheckAt,
        cumulativeCostUsdMicros: input.cumulativeCostUsdMicros,
        remainingBudgetUsdMicros: input.remainingBudgetUsdMicros,
        updatedAt: observedAt,
      }).where(and(
        eq(connectedWebOperations.id, input.operationId),
        eq(connectedWebOperations.supervisorClaimOwner, input.workerId),
        eq(connectedWebOperations.controlEpoch, input.expectedControlEpoch),
        eq(connectedWebOperations.eventCursor, input.expectedEventCursor),
        sql`${connectedWebOperations.sealedProviderRefs}->>'runRef' is not distinct from ${input.expectedRunRef}`,
        sql`${connectedWebOperations.lifecycle} <> 'terminal'`,
        gt(connectedWebOperations.supervisorClaimExpiresAt, observedAt),
        sql`${connectedWebOperations.cumulativeCostUsdMicros} <= ${input.cumulativeCostUsdMicros}`,
        sql`${connectedWebOperations.remainingBudgetUsdMicros} >= ${input.remainingBudgetUsdMicros}`,
        sql`${input.cumulativeCostUsdMicros}::bigint + ${input.remainingBudgetUsdMicros}::bigint <= ${connectedWebOperations.cumulativeCostUsdMicros} + ${connectedWebOperations.remainingBudgetUsdMicros}`,
      )).returning({ id: connectedWebOperations.id });
      if (rows.length === 1 && entries.length) await connection.insert(connectedWebOperationActivityEntries).values(entries.map((entry) => ({
        ...entry, operationId: input.operationId, controlEpoch: input.expectedControlEpoch,
      }))).onConflictDoNothing();
      return rows.length === 1;
      };
      // The cursor and its sanitized rows commit together or both roll back.
      return entries.length ? db.transaction((tx) => commit(tx)) : commit(db);
    },

    async rotateOperationProviderRun(input) {
      const refs = parseConnectedWebOperationProviderReferences(input.sealedProviderRefs);
      const activity = parseConnectedWebOperationSafeActivity(input.safeActivity);
      if (!refs || !activity || !Number.isSafeInteger(input.expectedControlEpoch) || input.expectedControlEpoch < 1
        || !nonnegativeMicros(input.cumulativeCostUsdMicros) || !nonnegativeMicros(input.remainingBudgetUsdMicros)
        || !input.workerId || input.workerId.length > OPERATION_WORKER_ID_MAX_CHARS) throw new ConnectedWebAccountStoreError("conflict");
      const rotatedAt = safeOperationDate(input.now);
      if (!rotatedAt) throw new ConnectedWebAccountStoreError("conflict");
      const nextEpoch = input.expectedControlEpoch + 1;
      const nextLeaseToken = randomUUID();
      const [updated] = await db.update(connectedWebOperations).set({
        driver: "hosted",
        lifecycle: "running",
        controlEpoch: nextEpoch,
        controlLeaseToken: nextLeaseToken,
        sealedProviderRefs: refs,
        eventCursor: 0,
        safeActivity: activity,
        nextCheckAt: safeOperationDate(input.nextCheckAt),
        cumulativeCostUsdMicros: input.cumulativeCostUsdMicros,
        remainingBudgetUsdMicros: input.remainingBudgetUsdMicros,
        updatedAt: rotatedAt,
      }).where(and(
        eq(connectedWebOperations.id, input.operationId),
        eq(connectedWebOperations.supervisorClaimOwner, input.workerId),
        eq(connectedWebOperations.controlEpoch, input.expectedControlEpoch),
        sql`${connectedWebOperations.sealedProviderRefs}->>'runRef' is not distinct from ${input.expectedRunRef}`,
        sql`${connectedWebOperations.lifecycle} <> 'terminal'`,
        gt(connectedWebOperations.supervisorClaimExpiresAt, rotatedAt),
        sql`${connectedWebOperations.cumulativeCostUsdMicros} <= ${input.cumulativeCostUsdMicros}`,
        sql`${connectedWebOperations.remainingBudgetUsdMicros} >= ${input.remainingBudgetUsdMicros}`,
        sql`${input.cumulativeCostUsdMicros}::bigint + ${input.remainingBudgetUsdMicros}::bigint <= ${connectedWebOperations.cumulativeCostUsdMicros} + ${connectedWebOperations.remainingBudgetUsdMicros}`,
      )).returning({ controlEpoch: connectedWebOperations.controlEpoch });
      return updated?.controlEpoch ?? null;
    },

    async rotateOperationProviderRunByControl(input) {
      const refs = parseConnectedWebOperationProviderReferences(input.sealedProviderRefs);
      const activity = parseConnectedWebOperationSafeActivity(input.safeActivity);
      if (!refs || !activity || !input.ownerUserId || !input.workerId || !input.expectedOpaqueExecutionRef
        || !input.opaqueExecutionRef || !Number.isSafeInteger(input.expectedControlEpoch)
        || input.expectedControlEpoch < 1 || !nonnegativeMicros(input.cumulativeCostUsdMicros)
        || !nonnegativeMicros(input.remainingBudgetUsdMicros)) {
        throw new ConnectedWebAccountStoreError("conflict");
      }
      const rotatedAt = safeOperationDate(input.now);
      if (!rotatedAt) throw new ConnectedWebAccountStoreError("conflict");
      const nextEpoch = input.expectedControlEpoch + 1;
      return db.transaction(async (tx) => {
        const [updated] = await tx.update(connectedWebOperations).set({
          driver: "hosted",
          lifecycle: "running",
          controlEpoch: nextEpoch,
          controlLeaseToken: randomUUID(),
          controlLeaseExpiresAt: null,
          sealedProviderRefs: refs,
          eventCursor: 0,
          safeActivity: activity,
          wakeFingerprint: null,
          wakeClaimOwner: null,
          wakeClaimExpiresAt: null,
          wakeDeliveredAt: null,
          supervisorClaimOwner: null,
          supervisorClaimExpiresAt: null,
          nextCheckAt: safeOperationDate(input.nextCheckAt),
          cumulativeCostUsdMicros: input.cumulativeCostUsdMicros,
          remainingBudgetUsdMicros: input.remainingBudgetUsdMicros,
          updatedAt: rotatedAt,
        }).where(and(
          eq(connectedWebOperations.id, input.operationId),
          eq(connectedWebOperations.ownerUserId, input.ownerUserId),
          eq(connectedWebOperations.controlEpoch, input.expectedControlEpoch),
          sql`${connectedWebOperations.sealedProviderRefs}->>'runRef' is not distinct from ${input.expectedRunRef}`,
          eq(connectedWebOperations.supervisorClaimOwner, input.workerId),
          gt(connectedWebOperations.supervisorClaimExpiresAt, rotatedAt),
          sql`${connectedWebOperations.lifecycle} <> 'terminal'`,
          isNull(connectedWebOperations.actionOperationId),
          sql`${connectedWebOperations.cumulativeCostUsdMicros} <= ${input.cumulativeCostUsdMicros}`,
          sql`${connectedWebOperations.remainingBudgetUsdMicros} >= ${input.remainingBudgetUsdMicros}`,
          sql`${input.cumulativeCostUsdMicros}::bigint + ${input.remainingBudgetUsdMicros}::bigint <= ${connectedWebOperations.cumulativeCostUsdMicros} + ${connectedWebOperations.remainingBudgetUsdMicros}`,
        )).returning({ controlEpoch: connectedWebOperations.controlEpoch, accountId: connectedWebOperations.accountId });
        if (!updated) return null;
        if (updated.accountId === null) return updated.controlEpoch;
        const [checkpoint] = await tx.update(connectedWebAccounts).set({
          executionCheckpoint: activeExecutionCheckpointExpression(input.opaqueExecutionRef),
          updatedAt: rotatedAt,
        }).where(and(
          eq(connectedWebAccounts.id, updated.accountId),
          eq(connectedWebAccounts.ownerUserId, input.ownerUserId),
          eq(connectedWebAccounts.status, "busy"),
          sql`${connectedWebAccounts.executionCheckpoint}->>'resource' = 'read'`,
          sql`${connectedWebAccounts.executionCheckpoint}->>'phase' = 'active'`,
          sql`${connectedWebAccounts.executionCheckpoint}->>'opaqueExecutionRef' = ${input.expectedOpaqueExecutionRef}`,
        )).returning({ id: connectedWebAccounts.id });
        if (!checkpoint) throw new ConnectedWebAccountStoreError("conflict");
        return updated.controlEpoch;
      });
    },

    async rotateOperationDriver(input) {
      const activity = parseConnectedWebOperationSafeActivity(input.safeActivity);
      if (!activity || !Number.isSafeInteger(input.expectedControlEpoch) || input.expectedControlEpoch < 1) throw new ConnectedWebAccountStoreError("conflict");
      const rotatedAt = safeOperationDate(input.now);
      const leaseExpiresAt = safeOperationDate(input.controlLeaseExpiresAt);
      if (!rotatedAt) throw new ConnectedWebAccountStoreError("conflict");
      const controlLeaseToken = randomUUID();
      const [updated] = await db.update(connectedWebOperations).set({
        driver: input.driver,
        lifecycle: input.lifecycle,
        controlEpoch: input.expectedControlEpoch + 1,
        controlLeaseToken,
        controlLeaseExpiresAt: leaseExpiresAt,
        safeActivity: activity,
        nextCheckAt: safeOperationDate(input.nextCheckAt),
        supervisorClaimOwner: null,
        supervisorClaimExpiresAt: null,
        updatedAt: rotatedAt,
      }).where(and(
        eq(connectedWebOperations.id, input.operationId),
        eq(connectedWebOperations.controlEpoch, input.expectedControlEpoch),
        sql`${connectedWebOperations.lifecycle} <> 'terminal'`,
      )).returning({ controlEpoch: connectedWebOperations.controlEpoch });
      return updated ? { controlEpoch: updated.controlEpoch, controlLeaseToken } : null;
    },

    async takeOverReadOperationForDirect(input) {
      const refs = parseConnectedWebOperationProviderReferences(input.sealedProviderRefs);
      const activity = parseConnectedWebOperationSafeActivity(input.safeActivity);
      const takenAt = safeOperationDate(input.now);
      if (!refs?.browserRef || !activity || !takenAt || !input.expectedRunRef || !input.opaqueExecutionRef
        || !Number.isSafeInteger(input.expectedControlEpoch) || input.expectedControlEpoch < 1) {
        throw new ConnectedWebAccountStoreError("conflict");
      }
      const controlLeaseToken = randomUUID();
      return db.transaction(async (tx) => {
        // Use the operation -> account lock order of terminalizeRead… so a
        // takeover racing reconciliation cannot deadlock.  The transaction
        // rolls this CAS back if the exact writer checkpoint disappeared.
        const [updated] = await tx.update(connectedWebOperations).set({
          driver: "direct", lifecycle: "running", controlEpoch: input.expectedControlEpoch + 1,
          controlLeaseToken, controlLeaseExpiresAt: null, sealedProviderRefs: refs,
          safeActivity: activity, nextCheckAt: null,
          supervisorClaimOwner: null, supervisorClaimExpiresAt: null,
          // A hosted checkpoint must never wake after its writer has been
          // fenced. Direct control will create its own meaningful activity.
          wakeFingerprint: null, wakeClaimOwner: null, wakeClaimExpiresAt: null,
          wakeDeliveredAt: null, updatedAt: takenAt,
        }).where(and(
          eq(connectedWebOperations.id, input.operationId),
          eq(connectedWebOperations.ownerUserId, input.ownerUserId),
          eq(connectedWebOperations.accountId, input.accountId),
          eq(connectedWebOperations.controlEpoch, input.expectedControlEpoch),
          sql`${connectedWebOperations.sealedProviderRefs}->>'runRef' = ${input.expectedRunRef}`,
          sql`${connectedWebOperations.lifecycle} <> 'terminal'`,
          isNull(connectedWebOperations.actionOperationId),
        )).returning({ controlEpoch: connectedWebOperations.controlEpoch });
        if (!updated) return null;
        const [checkpoint] = await tx.select({ id: connectedWebAccounts.id }).from(connectedWebAccounts).where(and(
          eq(connectedWebAccounts.id, input.accountId),
          eq(connectedWebAccounts.ownerUserId, input.ownerUserId),
          eq(connectedWebAccounts.status, "busy"),
          sql`${connectedWebAccounts.executionCheckpoint}->>'resource' = 'read'`,
          sql`${connectedWebAccounts.executionCheckpoint}->>'phase' = 'active'`,
          sql`${connectedWebAccounts.executionCheckpoint}->>'opaqueExecutionRef' = ${input.opaqueExecutionRef}`,
        )).limit(1).for("update");
        if (!checkpoint) throw new ConnectedWebAccountStoreError("conflict");
        return { controlEpoch: updated.controlEpoch, controlLeaseToken };
      });
    },

    async scheduleOperationCheck(input) {
      const activity = parseConnectedWebOperationSafeActivity(input.safeActivity);
      if (!activity || !Number.isSafeInteger(input.expectedControlEpoch) || input.expectedControlEpoch < 1) throw new ConnectedWebAccountStoreError("conflict");
      const scheduledAt = safeOperationDate(input.now);
      const dueAt = safeOperationDate(input.dueAt);
      const requestedWakeAt = input.requestedWakeAt === undefined ? undefined : safeOperationDate(input.requestedWakeAt);
      if (!scheduledAt || !dueAt || dueAt < scheduledAt
        || (input.requestedWakeAt !== undefined && (!requestedWakeAt || requestedWakeAt < scheduledAt))) throw new ConnectedWebAccountStoreError("conflict");
      const rows = await db.update(connectedWebOperations).set({
        driver: "checking",
        lifecycle: "running",
        safeActivity: activity,
        nextCheckAt: requestedWakeAt ? scheduledAt : dueAt,
        requestedWakeAt,
        supervisorClaimOwner: null,
        supervisorClaimExpiresAt: null,
        updatedAt: scheduledAt,
      }).where(and(
        eq(connectedWebOperations.id, input.operationId),
        eq(connectedWebOperations.controlEpoch, input.expectedControlEpoch),
        sql`${connectedWebOperations.lifecycle} <> 'terminal'`,
      )).returning({ id: connectedWebOperations.id });
      return rows.length === 1;
    },

    async recordDirectOperationActivity(input) {
      const activity = parseConnectedWebOperationSafeActivity(input.safeActivity);
      const observedAt = safeOperationDate(input.now);
      if (!activity || !observedAt || !Number.isSafeInteger(input.expectedControlEpoch) || input.expectedControlEpoch < 1) {
        throw new ConnectedWebAccountStoreError("conflict");
      }
      const rows = await db.update(connectedWebOperations).set({
        safeActivity: activity,
        updatedAt: observedAt,
      }).where(and(
        eq(connectedWebOperations.id, input.operationId),
        eq(connectedWebOperations.ownerUserId, input.ownerUserId),
        eq(connectedWebOperations.controlEpoch, input.expectedControlEpoch),
        eq(connectedWebOperations.driver, "direct"),
        sql`${connectedWebOperations.lifecycle} <> 'terminal'`,
      )).returning({ id: connectedWebOperations.id });
      return rows.length === 1;
    },

    async claimOperationWake({ operationId, workerId, now, leaseMs }) {
      if (!workerId || workerId.length > OPERATION_WORKER_ID_MAX_CHARS || !Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new ConnectedWebAccountStoreError("conflict");
      const claimedAt = safeOperationDate(now);
      if (!claimedAt) throw new ConnectedWebAccountStoreError("conflict");
      const expiresAt = new Date(claimedAt.getTime() + leaseMs);
      const [updated] = await db.update(connectedWebOperations).set({
        wakeClaimOwner: workerId,
        wakeClaimExpiresAt: expiresAt,
        wakeAttempts: sql`${connectedWebOperations.wakeAttempts} + 1`,
        updatedAt: claimedAt,
      }).where(and(
        eq(connectedWebOperations.id, operationId),
        isNotNull(connectedWebOperations.wakeFingerprint),
        isNull(connectedWebOperations.wakeDeliveredAt),
        or(isNull(connectedWebOperations.wakeClaimExpiresAt), lte(connectedWebOperations.wakeClaimExpiresAt, claimedAt)),
      )).returning();
      return updated ? operation(updated) : null;
    },

    async claimDueOperationWakes({ workerId, now, leaseMs, batch = 1 }) {
      if (!workerId || workerId.length > OPERATION_WORKER_ID_MAX_CHARS || !Number.isSafeInteger(leaseMs) || leaseMs < 1
        || !Number.isSafeInteger(batch) || batch < 1 || batch > OPERATION_CLAIM_BATCH_MAX) throw new ConnectedWebAccountStoreError("conflict");
      const claimedAt = safeOperationDate(now);
      if (!claimedAt) throw new ConnectedWebAccountStoreError("conflict");
      const expiresAt = new Date(claimedAt.getTime() + leaseMs);
      return db.transaction(async (tx) => {
        const candidates = await tx.select().from(connectedWebOperations).where(and(
          or(
            and(isNotNull(connectedWebOperations.wakeFingerprint), isNull(connectedWebOperations.wakeDeliveredAt)),
            and(lte(connectedWebOperations.requestedWakeAt, claimedAt), sql`${connectedWebOperations.lifecycle} <> 'terminal'`),
          ),
          or(isNull(connectedWebOperations.wakeClaimExpiresAt), lte(connectedWebOperations.wakeClaimExpiresAt, claimedAt)),
        )).orderBy(connectedWebOperations.updatedAt, connectedWebOperations.id).limit(batch).for("update", { skipLocked: true });
        if (candidates.length === 0) return [];
        const claimed: ConnectedWebOperation[] = [];
        for (const candidate of candidates) {
          const requested = candidate.requestedWakeAt && candidate.requestedWakeAt <= claimedAt && candidate.lifecycle !== "terminal";
          // Persist a normal retryable wake before consuming the requested time.
          // Empty provider event pages cannot erase or suppress this wake.
          const fingerprint = requested ? createHash("sha256")
            .update(`connected-web:requested-check:${candidate.id}:${candidate.controlEpoch}:${candidate.requestedWakeAt!.toISOString()}`)
            .digest("hex") : undefined;
          const [row] = await tx.update(connectedWebOperations).set({
            wakeClaimOwner: workerId, wakeClaimExpiresAt: expiresAt,
            wakeAttempts: sql`${connectedWebOperations.wakeAttempts} + 1`,
            wakeFingerprint: fingerprint, wakeDeliveredAt: requested ? null : undefined,
            requestedWakeAt: requested ? null : undefined, updatedAt: claimedAt,
          }).where(eq(connectedWebOperations.id, candidate.id)).returning();
          if (row) claimed.push(operation(row));
        }
        return claimed;
      });
    },

    async completeOperationWake({ operationId, workerId, expectedWakeFingerprint, now }) {
      const deliveredAt = safeOperationDate(now);
      if (!workerId || workerId.length > OPERATION_WORKER_ID_MAX_CHARS || !expectedWakeFingerprint || expectedWakeFingerprint.length > 128 || !deliveredAt) throw new ConnectedWebAccountStoreError("conflict");
      const rows = await db.update(connectedWebOperations).set({
        wakeClaimOwner: null,
        wakeClaimExpiresAt: null,
        wakeDeliveredAt: deliveredAt,
        updatedAt: deliveredAt,
      }).where(and(
        eq(connectedWebOperations.id, operationId),
        eq(connectedWebOperations.wakeClaimOwner, workerId),
        eq(connectedWebOperations.wakeFingerprint, expectedWakeFingerprint),
        isNull(connectedWebOperations.wakeDeliveredAt),
        gt(connectedWebOperations.wakeClaimExpiresAt, deliveredAt),
      )).returning({ id: connectedWebOperations.id });
      return rows.length === 1;
    },

    async releaseOperationWakeClaim({ operationId, workerId, expectedWakeFingerprint, now }) {
      const releasedAt = safeOperationDate(now);
      if (!workerId || workerId.length > OPERATION_WORKER_ID_MAX_CHARS || !expectedWakeFingerprint || expectedWakeFingerprint.length > 128 || !releasedAt) throw new ConnectedWebAccountStoreError("conflict");
      const rows = await db.update(connectedWebOperations).set({
        wakeClaimOwner: null,
        wakeClaimExpiresAt: null,
        updatedAt: releasedAt,
      }).where(and(
        eq(connectedWebOperations.id, operationId),
        eq(connectedWebOperations.wakeClaimOwner, workerId),
        eq(connectedWebOperations.wakeFingerprint, expectedWakeFingerprint),
        isNull(connectedWebOperations.wakeDeliveredAt),
        gt(connectedWebOperations.wakeClaimExpiresAt, releasedAt),
      )).returning({ id: connectedWebOperations.id });
      return rows.length === 1;
    },

    async terminalizeOperation({ operationId, expectedControlEpoch, expectedRunRef, now, receipt, cumulativeCostUsdMicros, remainingBudgetUsdMicros, safeActivity, wakeFingerprint }) {
      const parsedReceipt = parseConnectedWebOperationSafeReceipt(receipt);
      const terminalAt = safeOperationDate(now);
      const activity = parseConnectedWebOperationSafeActivity(safeActivity);
      if (!parsedReceipt || !terminalAt || !activity || !wakeFingerprint || wakeFingerprint.length > 128
        || !nonnegativeMicros(cumulativeCostUsdMicros) || !nonnegativeMicros(remainingBudgetUsdMicros)
        || !Number.isSafeInteger(expectedControlEpoch) || expectedControlEpoch < 1) throw new ConnectedWebAccountStoreError("conflict");
      const rows = await db.update(connectedWebOperations).set({
        cumulativeCostUsdMicros, remainingBudgetUsdMicros, safeActivity: activity,
        wakeFingerprint, wakeDeliveredAt: null, wakeClaimOwner: null, wakeClaimExpiresAt: null,
        lifecycle: "terminal",
        terminalReceipt: parsedReceipt,
        requestedWakeAt: null,
        terminalAt,
        browserIdleUntil: terminalAt,
        nextCheckAt: null,
        supervisorClaimOwner: null,
        supervisorClaimExpiresAt: null,
        controlLeaseExpiresAt: null,
        updatedAt: terminalAt,
      }).where(and(
        eq(connectedWebOperations.id, operationId),
        eq(connectedWebOperations.controlEpoch, expectedControlEpoch),
        sql`${connectedWebOperations.sealedProviderRefs}->>'runRef' is not distinct from ${expectedRunRef}`,
        sql`${connectedWebOperations.lifecycle} <> 'terminal'`,
        sql`${connectedWebOperations.actionOperationId} is not distinct from ${parsedReceipt.actionOperationId ?? null}`,
        sql`${connectedWebOperations.cumulativeCostUsdMicros} <= ${cumulativeCostUsdMicros}`,
        sql`${connectedWebOperations.remainingBudgetUsdMicros} >= ${remainingBudgetUsdMicros}`,
        sql`${cumulativeCostUsdMicros}::bigint + ${remainingBudgetUsdMicros}::bigint <= ${connectedWebOperations.cumulativeCostUsdMicros} + ${connectedWebOperations.remainingBudgetUsdMicros}`,
      )).returning({ id: connectedWebOperations.id });
      return rows.length === 1;
    },

    async terminalizeReadOperationAndCompleteExecution({ operationId, ownerUserId, accountId, expectedControlEpoch, expectedRunRef, opaqueExecutionRef, now, receipt, terminalReadResult = null, authenticationRequired, cumulativeCostUsdMicros, remainingBudgetUsdMicros, safeActivity, wakeFingerprint }) {
      const parsedReceipt = parseConnectedWebOperationSafeReceipt(receipt);
      const parsedTerminalReadResult = terminalReadResult === null ? null : parseConnectedWebTerminalReadResult(terminalReadResult);
      const terminalAt = safeOperationDate(now);
      const activity = parseConnectedWebOperationSafeActivity(safeActivity);
      if (!parsedReceipt || !terminalAt || !expectedRunRef || !opaqueExecutionRef
        || !activity || !wakeFingerprint || wakeFingerprint.length > 128
        || !nonnegativeMicros(cumulativeCostUsdMicros) || !nonnegativeMicros(remainingBudgetUsdMicros)
        || (terminalReadResult !== null && parsedTerminalReadResult === null)
        || (parsedTerminalReadResult !== null && (accountId === null
          ? parsedTerminalReadResult.account !== null || parsedTerminalReadResult.page.ref !== operationId
          : parsedTerminalReadResult.account?.id !== accountId))
        || (authenticationRequired !== undefined && terminalReadResult !== null)
        || !Number.isSafeInteger(expectedControlEpoch) || expectedControlEpoch < 1) {
        throw new ConnectedWebAccountStoreError("conflict");
      }
      const accountAuthentication = accountId !== null ? authenticationRequired : undefined;
      return db.transaction(async (tx) => {
        const [terminalized] = await tx.update(connectedWebOperations).set({
          cumulativeCostUsdMicros, remainingBudgetUsdMicros,
          wakeFingerprint, wakeDeliveredAt: null, wakeClaimOwner: null, wakeClaimExpiresAt: null,
          lifecycle: accountAuthentication !== undefined ? "attention" : "terminal",
          requestedWakeAt: null,
          driver: accountAuthentication !== undefined ? "human" : undefined,
          safeActivity: accountAuthentication === undefined ? activity : {
            version: 1, phase: "attention", code: `authentication_${authenticationRequired}`,
            summary: "Connected website sign-in needs Human attention.",
          },
          terminalReceipt: accountAuthentication === undefined ? parsedReceipt : null,
          terminalReadResult: accountAuthentication === undefined ? parsedTerminalReadResult : null,
          terminalAt: accountAuthentication === undefined ? terminalAt : null,
          browserIdleUntil: accountAuthentication === undefined
            ? connectedWebBrowserIdleUntil(terminalAt, accountId !== null && parsedReceipt.outcome === "completed") : null,
          nextCheckAt: null,
          supervisorClaimOwner: null,
          supervisorClaimExpiresAt: null,
          controlLeaseExpiresAt: null,
          updatedAt: terminalAt,
        }).where(and(
          eq(connectedWebOperations.id, operationId),
          eq(connectedWebOperations.ownerUserId, ownerUserId),
          accountId === null ? isNull(connectedWebOperations.accountId) : eq(connectedWebOperations.accountId, accountId),
          eq(connectedWebOperations.controlEpoch, expectedControlEpoch),
          sql`${connectedWebOperations.sealedProviderRefs}->>'runRef' = ${expectedRunRef}`,
          sql`${connectedWebOperations.lifecycle} <> 'terminal'`,
          isNull(connectedWebOperations.actionOperationId),
          sql`${connectedWebOperations.cumulativeCostUsdMicros} <= ${cumulativeCostUsdMicros}`,
          sql`${connectedWebOperations.remainingBudgetUsdMicros} >= ${remainingBudgetUsdMicros}`,
          sql`${cumulativeCostUsdMicros}::bigint + ${remainingBudgetUsdMicros}::bigint <= ${connectedWebOperations.cumulativeCostUsdMicros} + ${connectedWebOperations.remainingBudgetUsdMicros}`,
        )).returning({ id: connectedWebOperations.id });
        if (!terminalized) return false;
        if (accountId === null) return true;
        const [released] = await tx.update(connectedWebAccounts).set({
          status: accountAuthentication === undefined ? "connected" : "attention_needed",
          executionCheckpoint: null,
          updatedAt: terminalAt,
        }).where(and(
          eq(connectedWebAccounts.id, accountId),
          eq(connectedWebAccounts.ownerUserId, ownerUserId),
          eq(connectedWebAccounts.status, "busy"),
          sql`${connectedWebAccounts.executionCheckpoint}->>'resource' = 'read'`,
          sql`${connectedWebAccounts.executionCheckpoint}->>'phase' = 'active'`,
          sql`${connectedWebAccounts.executionCheckpoint}->>'opaqueExecutionRef' = ${opaqueExecutionRef}`,
        )).returning({ id: connectedWebAccounts.id });
        if (!released) throw new ConnectedWebAccountStoreError("conflict");
        return true;
      });
    },

  };
}
