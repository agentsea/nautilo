import { randomUUID } from "node:crypto";

import {
  hasExactKeys,
  parseSshInvocationSubject,
  sameSshInvocationSubject,
  type SshInvocationSubject,
  type SshOperation,
} from "./contracts.ts";
import { type OpenSshDestinationIntent, type OpenSshDestinationPlan, type OpenSshDestinationPlanSummary } from "./open-ssh-plan.ts";

const DEFAULT_SSH_PREPARATION_TTL_MS = 60_000;
const DEFAULT_SSH_PREPARATION_MAX_ENTRIES = 128;
const MAX_SSH_PREPARATION_TTL_MS = 5 * 60_000;
const MAX_SSH_PREPARATION_ENTRIES = 1_024;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:=-]{0,255}$/;
const REQUEST_DIGEST = /^[a-f0-9]{64}$/;
const MAX_REVISION = 2 ** 31 - 1;

export interface SshHumanApprovalSummary {
  readonly requestedDestination: OpenSshDestinationIntent;
  readonly host: string;
  readonly port: number;
  readonly remoteUser: string;
  readonly operation: SshOperation;
  readonly hostKeyFingerprint: string;
  readonly hostTrust: "trusted" | "unknown" | "changed";
  readonly previousHostKeyFingerprint?: string | undefined;
}

/** Exact observed decision, private until it is projected into the approval. */
export type SshHostTrustDecision =
  | { readonly state: "trusted" | "unknown"; readonly hostKeyFingerprint: string }
  | { readonly state: "changed"; readonly hostKeyFingerprint: string; readonly previousHostKeyFingerprint: string };

export interface SshPreparationCreateInput {
  readonly toolCallId: string;
  readonly approvedRequestDigest: string;
  readonly operation: SshOperation;
  readonly subject: SshInvocationSubject;
  /** Revision of the local SSH capability-store envelope, not relay topology. */
  readonly capabilityStoreRevision: number;
  /** Private OpenSSH observation, used only by the subsequent one-use dispatch. */
  readonly destinationPlan: OpenSshDestinationPlan;
  /** Strict original intent and selected provenance never cross the relay wire. */
  readonly destinationIntent: OpenSshDestinationIntent;
  readonly connectionSource: OpenSshDestinationPlanSummary["connectionSource"];
  readonly semanticFingerprint: string;
  readonly trustDecision: SshHostTrustDecision;
  readonly approval: SshHumanApprovalSummary;
}

export interface SshPreparationConsumeInput {
  readonly preparationId: string;
  readonly toolCallId: string;
  readonly approvedRequestDigest: string;
  readonly operation: SshOperation;
  readonly subject: SshInvocationSubject;
}

export interface SshPreparation {
  readonly preparationId: string;
  readonly toolCallId: string;
  readonly approvedRequestDigest: string;
  readonly operation: SshOperation;
  readonly subject: SshInvocationSubject;
  /** Revision of the local SSH capability-store envelope, not relay topology. */
  readonly capabilityStoreRevision: number;
  /** Never serialize this Electron-private record into a relay response. */
  readonly destinationPlan: OpenSshDestinationPlan;
  readonly destinationIntent: OpenSshDestinationIntent;
  readonly connectionSource: OpenSshDestinationPlanSummary["connectionSource"];
  readonly semanticFingerprint: string;
  readonly trustDecision: SshHostTrustDecision;
  readonly approval: SshHumanApprovalSummary;
  readonly expiresAt: string;
}

export type SshPreparationErrorCode =
  | "preparation_invalid"
  | "preparation_unavailable"
  | "preparation_not_found"
  | "preparation_expired"
  | "preparation_replayed"
  | "preparation_mismatch"
  | "preparation_capacity_exhausted";

export type SshPreparationResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly code: SshPreparationErrorCode; readonly message: string };

export interface SshPreparationStoreOptions {
  readonly clock?: () => Date;
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly idFactory?: () => string;
}

type RecordState =
  | { readonly kind: "active"; readonly preparation: SshPreparation; readonly expiresAtMs: number }
  | { readonly kind: "spent"; readonly expiresAtMs: number };

function failed<T>(code: SshPreparationErrorCode, message: string): SshPreparationResult<T> {
  return { ok: false, code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOperation(value: unknown): value is SshOperation {
  return value === "auth" || value === "exec" || value === "copy-upload" || value === "copy-download";
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_REVISION;
}

function isSummary(value: unknown): value is SshHumanApprovalSummary {
  if (!isRecord(value)) return false;
  const expected = value["hostTrust"] === "changed"
    ? ["requestedDestination", "host", "port", "remoteUser", "operation", "hostKeyFingerprint", "hostTrust", "previousHostKeyFingerprint"]
    : ["requestedDestination", "host", "port", "remoteUser", "operation", "hostKeyFingerprint", "hostTrust"];
  if (!hasExactKeys(value, expected)) return false;
  const requested = value["requestedDestination"];
  return isDestinationIntent(requested) && typeof value["host"] === "string" && value["host"].length > 0 && typeof value["port"] === "number" && Number.isSafeInteger(value["port"]) && value["port"] >= 1 && value["port"] <= 65_535 && typeof value["remoteUser"] === "string" && value["remoteUser"].length > 0 && typeof value["hostKeyFingerprint"] === "string" && /^SHA256:[A-Za-z0-9+/]{20,86}$/.test(value["hostKeyFingerprint"]) && isOperation(value["operation"]) && (value["hostTrust"] === "trusted" || value["hostTrust"] === "unknown" || (value["hostTrust"] === "changed" && typeof value["previousHostKeyFingerprint"] === "string" && /^SHA256:[A-Za-z0-9+/]{20,86}$/.test(value["previousHostKeyFingerprint"]) && value["previousHostKeyFingerprint"] !== value["hostKeyFingerprint"]));
}

function isTrustDecision(value: unknown): value is SshHostTrustDecision {
  if (!isRecord(value)) return false;
  const state = value["state"];
  const expected = state === "changed" ? ["state", "hostKeyFingerprint", "previousHostKeyFingerprint"] : ["state", "hostKeyFingerprint"];
  return hasExactKeys(value, expected)
    && (state === "trusted" || state === "unknown" || state === "changed")
    && typeof value["hostKeyFingerprint"] === "string" && /^SHA256:[A-Za-z0-9+/]{20,86}$/.test(value["hostKeyFingerprint"])
    && (state !== "changed" || (typeof value["previousHostKeyFingerprint"] === "string" && /^SHA256:[A-Za-z0-9+/]{20,86}$/.test(value["previousHostKeyFingerprint"]) && value["previousHostKeyFingerprint"] !== value["hostKeyFingerprint"]));
}

function isDestinationPlan(value: unknown): value is OpenSshDestinationPlan {
  if (!isRecord(value) || !hasExactKeys(value, ["destination", "identitySources", "knownHostFiles", "safetyDirectives"])) return false;
  const destination = value["destination"];
  return isRecord(destination) && hasExactKeys(destination, ["host", "remoteUser", "port"])
    && typeof destination["host"] === "string" && destination["host"].length > 0
    && typeof destination["remoteUser"] === "string" && destination["remoteUser"].length > 0
    && typeof destination["port"] === "number" && Number.isSafeInteger(destination["port"]) && destination["port"] >= 1 && destination["port"] <= 65_535
    && Array.isArray(value["identitySources"])
    && Array.isArray(value["knownHostFiles"])
    && isRecord(value["safetyDirectives"]);
}

function isDestinationIntent(value: unknown): value is OpenSshDestinationIntent {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  return (keys.length === 1 && keys[0] === "connection" && typeof value["connection"] === "string" && value["connection"].length > 0) ||
    ((keys.length === 2 || keys.length === 3) && keys.every((key) => key === "host" || key === "user" || key === "port") && typeof value["host"] === "string" && typeof value["user"] === "string" && (value["port"] === undefined || (typeof value["port"] === "number" && Number.isSafeInteger(value["port"]))));
}
function isConnectionSource(value: unknown): value is OpenSshDestinationPlanSummary["connectionSource"] {
  return isRecord(value) && (value["kind"] === "explicit" || value["kind"] === "openssh" || value["kind"] === "nautilo-profile") &&
    Object.keys(value).every((key) => key === "kind" || key === "name") && (value["name"] === undefined || typeof value["name"] === "string");
}

function freezeDestinationPlan(plan: OpenSshDestinationPlan): OpenSshDestinationPlan {
  return Object.freeze({
    destination: Object.freeze({ ...plan.destination }),
    identitySources: Object.freeze(plan.identitySources.map((source) => Object.freeze({ ...source }))),
    knownHostFiles: Object.freeze([...plan.knownHostFiles]),
    safetyDirectives: Object.freeze({ ...plan.safetyDirectives }),
  });
}

function isCreateInput(value: unknown): value is SshPreparationCreateInput {
  if (!isRecord(value) || !hasExactKeys(value, ["toolCallId", "approvedRequestDigest", "operation", "subject", "capabilityStoreRevision", "destinationPlan", "destinationIntent", "connectionSource", "semanticFingerprint", "trustDecision", "approval"])) return false;
  const decision = value["trustDecision"];
  const approval = value["approval"];
  return typeof value["toolCallId"] === "string" && OPAQUE_ID.test(value["toolCallId"]) && typeof value["approvedRequestDigest"] === "string" && REQUEST_DIGEST.test(value["approvedRequestDigest"]) && isOperation(value["operation"]) && parseSshInvocationSubject(value["subject"]) !== null && isRevision(value["capabilityStoreRevision"]) && isDestinationPlan(value["destinationPlan"]) && isDestinationIntent(value["destinationIntent"]) && isConnectionSource(value["connectionSource"]) && typeof value["semanticFingerprint"] === "string" && REQUEST_DIGEST.test(value["semanticFingerprint"]) && isTrustDecision(decision) && isSummary(approval) && approval.operation === value["operation"] && approval.hostTrust === decision.state && approval.hostKeyFingerprint === decision.hostKeyFingerprint && (decision.state !== "changed" || approval.previousHostKeyFingerprint === decision.previousHostKeyFingerprint);
}

function isConsumeInput(value: unknown): value is SshPreparationConsumeInput {
  if (!isRecord(value) || !hasExactKeys(value, ["preparationId", "toolCallId", "approvedRequestDigest", "operation", "subject"])) return false;
  return typeof value["preparationId"] === "string" && OPAQUE_ID.test(value["preparationId"]) && typeof value["toolCallId"] === "string" && OPAQUE_ID.test(value["toolCallId"]) && typeof value["approvedRequestDigest"] === "string" && REQUEST_DIGEST.test(value["approvedRequestDigest"]) && isOperation(value["operation"]) && parseSshInvocationSubject(value["subject"]) !== null;
}

export function sshHumanApprovalSummary(
  requestedDestination: SshHumanApprovalSummary["requestedDestination"],
  destinationPlan: OpenSshDestinationPlan,
  operation: SshOperation,
  trustDecision: SshHostTrustDecision,
): SshHumanApprovalSummary {
  return Object.freeze({
    requestedDestination: Object.freeze({ ...requestedDestination }),
    host: destinationPlan.destination.host,
    port: destinationPlan.destination.port,
    remoteUser: destinationPlan.destination.remoteUser,
    operation,
    hostKeyFingerprint: trustDecision.hostKeyFingerprint,
    hostTrust: trustDecision.state,
    ...(trustDecision.state === "changed" ? { previousHostKeyFingerprint: trustDecision.previousHostKeyFingerprint } : {}),
  });
}

/**
 * Process-local, bounded, one-use bridge between Electron's local grant
 * selection and the server's final dispatch. Nothing here is persisted across
 * a desktop restart, and spent ids stay tombstoned until their original TTL.
 */
export class SshPreparationStore {
  private readonly records = new Map<string, RecordState>();
  private readonly clock: () => Date;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly idFactory: () => string;
  private lastObservedMs: number;

  constructor(options: SshPreparationStoreOptions = {}) {
    const rawOptions: unknown = options;
    if (!isRecord(rawOptions) || !hasExactKeys(rawOptions, ["clock", "ttlMs", "maxEntries", "idFactory"].filter((key) => rawOptions[key] !== undefined))) {
      throw new RangeError("structured SSH preparation store options are invalid");
    }
    const configuredClock = rawOptions["clock"];
    const configuredTtlMs = rawOptions["ttlMs"];
    const configuredMaxEntries = rawOptions["maxEntries"];
    const configuredIdFactory = rawOptions["idFactory"];
    if (configuredClock !== undefined && typeof configuredClock !== "function") throw new RangeError("structured SSH preparation store clock is invalid");
    if (configuredTtlMs !== undefined && typeof configuredTtlMs !== "number") throw new RangeError("structured SSH preparation store ttlMs is invalid");
    if (configuredMaxEntries !== undefined && typeof configuredMaxEntries !== "number") throw new RangeError("structured SSH preparation store maxEntries is invalid");
    if (configuredIdFactory !== undefined && typeof configuredIdFactory !== "function") throw new RangeError("structured SSH preparation store idFactory is invalid");
    this.clock = configuredClock === undefined ? (() => new Date()) : configuredClock as () => Date;
    this.ttlMs = configuredTtlMs ?? DEFAULT_SSH_PREPARATION_TTL_MS;
    this.maxEntries = configuredMaxEntries ?? DEFAULT_SSH_PREPARATION_MAX_ENTRIES;
    this.idFactory = configuredIdFactory === undefined ? (() => `ssh-preparation-${randomUUID()}`) : configuredIdFactory as () => string;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1 || this.ttlMs > MAX_SSH_PREPARATION_TTL_MS) throw new RangeError("structured SSH preparation store ttlMs is invalid");
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1 || this.maxEntries > MAX_SSH_PREPARATION_ENTRIES) throw new RangeError("structured SSH preparation store maxEntries is invalid");
    this.lastObservedMs = this.readNowMs();
  }

  private readNowMs(): number {
    let value: Date;
    try { value = this.clock(); } catch { throw new RangeError("structured SSH preparation store clock is unavailable"); }
    const now = value.getTime();
    if (!Number.isSafeInteger(now)) throw new RangeError("structured SSH preparation store clock is unavailable");
    return now;
  }

  private now(): number | null {
    try {
      const now = this.readNowMs();
      if (now < this.lastObservedMs) {
        this.records.clear();
        this.lastObservedMs = now;
        return null;
      }
      this.lastObservedMs = now;
      return now;
    } catch {
      this.records.clear();
      return null;
    }
  }

  private purge(now: number): void {
    for (const [id, record] of this.records) {
      if (record.expiresAtMs <= now) this.records.delete(id);
    }
  }

  create(input: SshPreparationCreateInput): SshPreparationResult<SshPreparation> {
    const now = this.now();
    if (now === null) return failed("preparation_unavailable", "structured SSH preparation clock is unavailable");
    if (!isCreateInput(input)) return failed("preparation_invalid", "structured SSH preparation is invalid");
    this.purge(now);
    if (this.records.size >= this.maxEntries) return failed("preparation_capacity_exhausted", "structured SSH preparation capacity is exhausted");
    const preparationId = this.idFactory();
    if (typeof preparationId !== "string" || !OPAQUE_ID.test(preparationId) || this.records.has(preparationId)) return failed("preparation_unavailable", "structured SSH preparation id is unavailable");
    const expiresAtMs = now + this.ttlMs;
    const preparation: SshPreparation = Object.freeze({
      preparationId,
      toolCallId: input.toolCallId,
      approvedRequestDigest: input.approvedRequestDigest,
      operation: input.operation,
      subject: Object.freeze({ ...input.subject }),
      capabilityStoreRevision: input.capabilityStoreRevision,
      destinationPlan: freezeDestinationPlan(input.destinationPlan),
      destinationIntent: Object.freeze({ ...input.destinationIntent }) as OpenSshDestinationIntent,
      connectionSource: Object.freeze({ ...input.connectionSource }),
      semanticFingerprint: input.semanticFingerprint,
      trustDecision: Object.freeze({ ...input.trustDecision }),
      approval: Object.freeze({ ...input.approval }),
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
    this.records.set(preparationId, { kind: "active", preparation, expiresAtMs });
    return { ok: true, data: preparation };
  }

  /** Consume-before-verify prevents any valid id from being replayed after a malformed final binding. */
  consume(input: SshPreparationConsumeInput): SshPreparationResult<SshPreparation> {
    const now = this.now();
    if (now === null) return failed("preparation_unavailable", "structured SSH preparation clock is unavailable");
    if (!isConsumeInput(input)) return failed("preparation_invalid", "structured SSH preparation use is invalid");
    // Inspect the requested id before global expiry cleanup so a late final
    // dispatch receives a typed expiry outcome rather than an indistinct miss.
    const record = this.records.get(input.preparationId);
    if (record !== undefined && record.expiresAtMs <= now) {
      this.records.delete(input.preparationId);
      this.purge(now);
      return failed("preparation_expired", "structured SSH preparation expired");
    }
    this.purge(now);
    if (record === undefined) return failed("preparation_not_found", "structured SSH preparation was not found");
    if (record.kind === "spent") return failed("preparation_replayed", "structured SSH preparation was already used");
    this.records.set(input.preparationId, { kind: "spent", expiresAtMs: record.expiresAtMs });
    const expected = record.preparation;
    if (
      expected.toolCallId !== input.toolCallId ||
      expected.approvedRequestDigest !== input.approvedRequestDigest ||
      expected.operation !== input.operation ||
      !sameSshInvocationSubject(expected.subject, input.subject)
    ) return failed("preparation_mismatch", "structured SSH preparation no longer matches final dispatch");
    return { ok: true, data: expected };
  }

  size(): number {
    const now = this.now();
    if (now === null) return 0;
    this.purge(now);
    return this.records.size;
  }
}
