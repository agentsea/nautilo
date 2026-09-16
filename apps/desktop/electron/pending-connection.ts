/**
 * D514 Phase 1 — durable, resume-safe pending connection candidate.
 *
 * This journal is deliberately smaller than a connection attempt. It records
 * only enough non-secret intent to restart that attempt after an interruption;
 * health/setup/auth bodies, cookies, tokens, certificates, fingerprints, and
 * every observation are revalidated by the resumed attempt.
 *
 * The production owner supplies a path from `pendingConnectionFilePath()` and
 * an opaque `(instance, profile)` tuple binding. Keeping this module free of
 * Electron imports makes its fail-closed persistence contract unit-testable.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { isServerFingerprint } from "./config-schema";
import { planServerTarget } from "./server-target";

export const PENDING_CONNECTION_VERSION = 2 as const;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

/** Only phases that still need an authority-owned resume are durable. */
export type PendingConnectionPhase =
  | "normalizing"
  | "downgrade-confirmation"
  | "transport"
  | "readiness"
  | "health"
  | "identity"
  | "mismatch"
  | "setup"
  | "auth"
  | "navigation"
  | "promotion";

/** The entry path changes resume semantics; it is not inferred from phase. */
export type PendingConnectionContext = "initial" | "cold-boot" | "add" | "switch";
export type PendingConnectionHandoffCheckpoint = "candidate" | "active-committed";
export type PendingConnectionPostCommitCheckpoint =
  | "metadata"
  | "old-codex"
  | "old-relay"
  | "old-profile"
  | "old-identity"
  | "renderer-authority"
  | "visibility"
  | "target-relay"
  | "pending-clear";

/**
 * Exact on-disk schema. `candidateOrigin` is intent, not proof. The last
 * progress phase is only a recovery hint. Precommit recovery starts a fresh
 * attempt; a transaction already named by active authority resumes only its
 * committed handoff, with ephemeral facts reconstructed and revalidated.
 */
export type PendingConnection = Readonly<{
  version: typeof PENDING_CONNECTION_VERSION;
  tupleBinding: string;
  attemptId: string;
  context: PendingConnectionContext;
  generation: number;
  enteredTarget: string;
  /** Null only before normalization has selected a transport candidate. */
  candidateOrigin: string | null;
  /** Must still equal the authoritative active scope before a resume is offered. */
  activeScopeGuard: string | null;
  /** Monotonic/opaque active-authority revision; prevents A→B→A confusion. */
  activeRevisionGuard: string | null;
  identityTransition:
    | Readonly<{ kind: "ordinary" }>
    | Readonly<{
        kind: "accepted-identity-replacement";
        priorConnectionAttemptId: string;
        priorServerFingerprint: string;
        priorRoutingServerUrl: string;
      }>;
  /** Non-authoritative recovery hint; never a phase to resume directly. */
  lastProgressPhase: PendingConnectionPhase;
  /** Durable handoff truth, never a transport/identity receipt. */
  handoffCheckpoint: PendingConnectionHandoffCheckpoint;
  /** Next idempotent postcommit step. Null is valid only before commit. */
  postCommitCheckpoint: PendingConnectionPostCommitCheckpoint | null;
}>;

/** Exact snapshot supplied by the one authoritative config/session owner. */
export type ActiveAuthority =
  | Readonly<{ scope: null; revision: null; connectionAttemptId: null; serverFingerprint: null }>
  | Readonly<{ scope: string; revision: string; connectionAttemptId: string; serverFingerprint: string | null }>;

export type PendingConnectionLoadResult =
  | Readonly<{ disposition: "none" }>
  | Readonly<{ disposition: "precommit"; pending: PendingConnection }>
  | Readonly<{ disposition: "committed-handoff"; pending: PendingConnection }>
  | Readonly<{ disposition: "blocked-legacy-handoff" }>;

/** Safe input for a new reducer attempt before the durable handoff point. */
export type PrecommitPendingConnectionRecovery = Readonly<{
  disposition: "precommit";
  action: "fresh-attempt";
  context: PendingConnectionContext;
  enteredTarget: string;
  priorActiveScope: string | null;
  priorRecoveryGuard:
    | Readonly<{ scope: null; revision: null }>
    | Readonly<{ scope: string; revision: string }>;
  restartPhase: "normalizing";
  requiresFreshAttemptAndGeneration: true;
}>;

/**
 * The active config already names this exact attempt. Resume only the ordered
 * remaining handoff side effects; no health/navigation receipt survives.
 */
export type CommittedHandoffPendingConnectionRecovery = Readonly<{
  disposition: "committed-handoff";
  action: "resume-handoff";
  attemptId: string;
  generation: number;
  context: PendingConnectionContext;
  candidateOrigin: string;
  /** Exact persisted routing base; identity receipts remain candidateOrigin-bound. */
  routingServerUrl: string;
  priorRecoveryGuard:
    | Readonly<{ scope: null; revision: null }>
    | Readonly<{ scope: string; revision: string }>;
  /** A fresh process has no process-local prior registry session to name. */
  priorRegistryScope: null;
  nextPostCommitCheckpoint: PendingConnectionPostCommitCheckpoint;
  validActions: readonly ["resume-handoff"];
  requiresEphemeralFactReconstructionAndRevalidation: true;
  identityTransition: PendingConnection["identityTransition"];
}>;

export type PendingConnectionRecovery =
  | PrecommitPendingConnectionRecovery
  | CommittedHandoffPendingConnectionRecovery;

export interface PendingConnectionFs {
  readFileSync(filePath: string, encoding: "utf-8"): string;
  writeFileSync(
    filePath: string,
    data: string,
    options: { encoding: "utf-8"; mode: number; flag: "wx" },
  ): void;
  chmodSync(filePath: string, mode: number): void;
  mkdirSync(directoryPath: string, options: { recursive: true; mode: number }): void;
  renameSync(from: string, to: string): void;
  unlinkSync(filePath: string): void;
}

export type PendingConnectionStoreOptions = Readonly<{
  /** Family-A path, normally `pendingConnectionFilePath()`. */
  filePath: string;
  /** Opaque exact `(instance, profile)` binding, supplied at boot. */
  tupleBinding: string;
  /** Current authoritative config/session snapshot; never inferred from the journal. */
  currentActiveAuthority: () => ActiveAuthority;
  fs?: PendingConnectionFs;
  /** Test seam; production uses a cryptographically unique UUID. */
  temporaryId?: () => string;
}>;

const PHASES: ReadonlySet<PendingConnectionPhase> = new Set([
  "normalizing",
  "downgrade-confirmation",
  "transport",
  "readiness",
  "health",
  "identity",
  "mismatch",
  "setup",
  "auth",
  "navigation",
  "promotion",
]);

const CONTEXTS: ReadonlySet<PendingConnectionContext> = new Set([
  "initial",
  "cold-boot",
  "add",
  "switch",
]);

const HANDOFF_CHECKPOINTS: ReadonlySet<PendingConnectionHandoffCheckpoint> = new Set([
  "candidate",
  "active-committed",
]);
const POSTCOMMIT_CHECKPOINTS: ReadonlySet<PendingConnectionPostCommitCheckpoint> = new Set([
  "metadata",
  "old-codex",
  "old-relay",
  "old-profile",
  "old-identity",
  "renderer-authority",
  "visibility",
  "target-relay",
  "pending-clear",
]);

const JOURNAL_KEYS = [
  "version",
  "tupleBinding",
  "attemptId",
  "context",
  "generation",
  "enteredTarget",
  "candidateOrigin",
  "activeScopeGuard",
  "activeRevisionGuard",
  "identityTransition",
  "lastProgressPhase",
  "handoffCheckpoint",
  "postCommitCheckpoint",
] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === JOURNAL_KEYS.length &&
    keys.every((key, index) => key === JOURNAL_KEYS.slice().sort()[index]);
}

function isOpaqueBinding(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(value);
}

function isAttemptId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value);
}

function isGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isOpaqueRevision(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(value);
}

function isRevisionGuard(value: unknown): value is string | null {
  return value === null || isOpaqueRevision(value);
}

function isCanonicalHttpOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !parsed.username && !parsed.password && !parsed.search && !parsed.hash &&
      parsed.pathname === "/" && parsed.origin === value;
  } catch {
    return false;
  }
}

function isActiveScopeGuard(value: unknown): value is string | null {
  return value === null || isCanonicalHttpOrigin(value);
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** Reject userinfo, query, hash, and non-origin paths before user input hits disk. */
function isResumeSafeEnteredTarget(
  value: unknown,
  context: PendingConnectionContext,
): value is string {
  if (typeof value !== "string" || !value || value.length > 2048 || hasControlCharacter(value)) {
    return false;
  }
  const explicitScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value);
  try {
    const parsed = new URL(explicitScheme ? value : `https://${value}`);
    const safePath = parsed.pathname === "/" || parsed.pathname === "" ||
      (context === "cold-boot" && explicitScheme && parsed.pathname.startsWith("/"));
    return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !parsed.username && !parsed.password && !parsed.search && !parsed.hash && safePath;
  } catch {
    return false;
  }
}

function isCandidateForEnteredTarget(
  enteredTarget: string,
  candidateOrigin: string | null,
  activeScopeGuard: string | null,
  lastProgressPhase: PendingConnectionPhase,
  context: PendingConnectionContext,
): boolean {
  if (candidateOrigin === null) return lastProgressPhase === "normalizing";
  if (context === "cold-boot") {
    try {
      return new URL(enteredTarget).origin === candidateOrigin;
    } catch {
      // Ordinary target planning below handles non-scoped legacy values.
    }
  }
  const target = planServerTarget(enteredTarget, { previousVerifiedOrigin: activeScopeGuard });
  return target.ok && target.candidates.some((candidate) => candidate.origin === candidateOrigin);
}

function validHandoffCheckpoint(
  checkpoint: unknown,
  postCommitCheckpoint: unknown,
  candidateOrigin: string | null,
  lastProgressPhase: PendingConnectionPhase,
): checkpoint is PendingConnectionHandoffCheckpoint {
  if (typeof checkpoint !== "string" || !HANDOFF_CHECKPOINTS.has(checkpoint as PendingConnectionHandoffCheckpoint)) {
    return false;
  }
  if (checkpoint === "candidate") return postCommitCheckpoint === null;
  return lastProgressPhase === "promotion" && candidateOrigin !== null &&
    typeof postCommitCheckpoint === "string" &&
    POSTCOMMIT_CHECKPOINTS.has(postCommitCheckpoint as PendingConnectionPostCommitCheckpoint);
}

function isRoutedUrlForOrigin(value: unknown, origin: string): value is string {
  return isResumeSafeEnteredTarget(value, "cold-boot") && (() => {
    try { return new URL(value).origin === origin; } catch { return false; }
  })();
}

function validIdentityTransition(value: unknown, candidateOrigin: string | null,
  activeScopeGuard: string | null, activeRevisionGuard: string | null, attemptId: string): boolean {
  if (!isPlainRecord(value) || typeof value["kind"] !== "string") return false;
  if (value["kind"] === "ordinary") return Object.keys(value).length === 1;
  return value["kind"] === "accepted-identity-replacement" &&
    candidateOrigin !== null && activeScopeGuard === candidateOrigin && activeRevisionGuard !== null &&
    Object.keys(value).length === 4 && isAttemptId(value["priorConnectionAttemptId"]) &&
    value["priorConnectionAttemptId"] !== attemptId &&
    isServerFingerprint(value["priorServerFingerprint"]) &&
    isRoutedUrlForOrigin(value["priorRoutingServerUrl"], candidateOrigin);
}

/** Strict validation intentionally rejects all future/unknown (including secret) fields. */
export function parsePendingConnection(value: unknown): PendingConnection | null {
  if (!isPlainRecord(value) || !exactKeys(value)) return null;
  if (
    value["version"] !== PENDING_CONNECTION_VERSION ||
    !isOpaqueBinding(value["tupleBinding"]) ||
    !isAttemptId(value["attemptId"]) ||
    typeof value["context"] !== "string" || !CONTEXTS.has(value["context"] as PendingConnectionContext) ||
    !isGeneration(value["generation"]) ||
    !isResumeSafeEnteredTarget(
      value["enteredTarget"],
      value["context"] as PendingConnectionContext,
    ) ||
    !(value["candidateOrigin"] === null || isCanonicalHttpOrigin(value["candidateOrigin"])) ||
    !isActiveScopeGuard(value["activeScopeGuard"]) ||
    !isRevisionGuard(value["activeRevisionGuard"]) ||
    (value["activeRevisionGuard"] === null &&
      (value["context"] !== "initial" || value["activeScopeGuard"] !== null)) ||
    (value["activeRevisionGuard"] !== null && value["activeScopeGuard"] === null) ||
    !validIdentityTransition(value["identityTransition"], value["candidateOrigin"],
      value["activeScopeGuard"], value["activeRevisionGuard"], value["attemptId"]) ||
    typeof value["lastProgressPhase"] !== "string" || !PHASES.has(value["lastProgressPhase"] as PendingConnectionPhase) ||
    !isCandidateForEnteredTarget(
      value["enteredTarget"],
      value["candidateOrigin"],
      value["activeScopeGuard"],
      value["lastProgressPhase"] as PendingConnectionPhase,
      value["context"] as PendingConnectionContext,
    ) ||
    !validHandoffCheckpoint(
      value["handoffCheckpoint"],
      value["postCommitCheckpoint"],
      value["candidateOrigin"],
      value["lastProgressPhase"] as PendingConnectionPhase,
    )
  ) {
    return null;
  }
  return value as PendingConnection;
}

/**
 * Precommit recovery discards the journal's attempt id, generation, candidate,
 * and progress hint. The coordinator must mint fresh values and revalidate.
 */
export function projectPendingConnectionRecovery(
  loaded: Extract<PendingConnectionLoadResult, { pending: PendingConnection }>,
): PendingConnectionRecovery {
  if (loaded.disposition === "precommit") {
    return {
      disposition: "precommit",
      action: "fresh-attempt",
      context: loaded.pending.context,
      enteredTarget: loaded.pending.enteredTarget,
      priorActiveScope: loaded.pending.activeScopeGuard,
      priorRecoveryGuard: loaded.pending.activeScopeGuard && loaded.pending.activeRevisionGuard
        ? {
            scope: loaded.pending.activeScopeGuard,
            revision: loaded.pending.activeRevisionGuard,
          }
        : { scope: null, revision: null },
      restartPhase: "normalizing",
      requiresFreshAttemptAndGeneration: true,
    };
  }
  // `committed-handoff` is not an ordinary retry/edit/cancel. The coordinator
  // reconstructs and freshly revalidates transient network/navigation facts
  // before completing only the post-linearization side effects.
  let routingServerUrl = loaded.pending.candidateOrigin ?? "";
  try {
    const entered = new URL(loaded.pending.enteredTarget);
    if (entered.pathname !== "/" && entered.pathname !== "") routingServerUrl = loaded.pending.enteredTarget.replace(/\/$/, "");
  } catch { /* bare host routes at its validated origin */ }
  return {
    disposition: "committed-handoff",
    action: "resume-handoff",
    attemptId: loaded.pending.attemptId,
    generation: loaded.pending.generation,
    context: loaded.pending.context,
    candidateOrigin: loaded.pending.candidateOrigin ?? "",
    routingServerUrl,
    priorRecoveryGuard: loaded.pending.activeScopeGuard && loaded.pending.activeRevisionGuard
      ? {
          scope: loaded.pending.activeScopeGuard,
          revision: loaded.pending.activeRevisionGuard,
        }
      : { scope: null, revision: null },
    priorRegistryScope: null,
    nextPostCommitCheckpoint: loaded.pending.handoffCheckpoint === "candidate"
      ? "metadata"
      : loaded.pending.postCommitCheckpoint ?? "metadata",
    validActions: ["resume-handoff"],
    requiresEphemeralFactReconstructionAndRevalidation: true,
    identityTransition: loaded.pending.identityTransition,
  };
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT";
}

const V1_JOURNAL_KEYS = JOURNAL_KEYS.filter((key) => key !== "identityTransition");
function migrateV1(value: unknown): PendingConnection | null {
  if (!isPlainRecord(value) || value["version"] !== 1) return null;
  const keys = Object.keys(value).sort();
  if (keys.length !== V1_JOURNAL_KEYS.length ||
      !keys.every((key, index) => key === V1_JOURNAL_KEYS.slice().sort()[index])) return null;
  return parsePendingConnection({ ...value, version: PENDING_CONNECTION_VERSION,
    identityTransition: { kind: "ordinary" } });
}
function namesCurrentCommittedAttempt(value: unknown, authority: ActiveAuthority | undefined): boolean {
  if (!isPlainRecord(value) || !authority || authority.scope === null) return false;
  return value["candidateOrigin"] === authority.scope && value["attemptId"] === authority.connectionAttemptId;
}

function uniqueTemporaryPath(filePath: string, token: string): string {
  if (!/^[A-Za-z0-9-]{1,128}$/.test(token)) {
    throw new Error("pending connection temporary id is invalid");
  }
  return path.join(path.dirname(filePath), `.${path.basename(filePath)}.${token}.tmp`);
}

/**
 * A compact sync store whose write is same-directory, unique-temp, 0600, and
 * atomic-rename. It follows the repository's config/token persistence shape;
 * those existing patterns do not fsync, so this one does not claim durability
 * beyond the successful rename either.
 */
export function createPendingConnectionStore(options: PendingConnectionStoreOptions) {
  if (!isOpaqueBinding(options.tupleBinding)) {
    throw new Error("pending connection tuple binding is invalid");
  }
  if (!path.isAbsolute(options.filePath) || options.filePath.includes("\0")) {
    throw new Error("pending connection path must be absolute");
  }
  const fileSystem = options.fs ?? fs;
  const temporaryId = options.temporaryId ?? randomUUID;

  const sameAcceptedCandidate = (next: PendingConnection): boolean => {
    if (next.handoffCheckpoint !== "active-committed" ||
        next.identityTransition.kind !== "accepted-identity-replacement") return true;
    try {
      const previous = parsePendingConnection(JSON.parse(fileSystem.readFileSync(options.filePath, "utf-8")));
      const sameTransaction = (previous?.handoffCheckpoint === "candidate" ||
        previous?.handoffCheckpoint === "active-committed") &&
        previous.attemptId === next.attemptId && previous.generation === next.generation &&
        previous.tupleBinding === next.tupleBinding && previous.candidateOrigin === next.candidateOrigin &&
        previous.activeScopeGuard === next.activeScopeGuard && previous.activeRevisionGuard === next.activeRevisionGuard &&
        JSON.stringify(previous.identityTransition) === JSON.stringify(next.identityTransition);
      if (!sameTransaction) return false;
      if (previous.handoffCheckpoint === "candidate") return next.postCommitCheckpoint === "metadata";
      const order = Array.from(POSTCOMMIT_CHECKPOINTS);
      const previousIndex = order.indexOf(previous.postCommitCheckpoint!);
      const nextIndex = order.indexOf(next.postCommitCheckpoint!);
      return nextIndex === previousIndex || nextIndex === previousIndex + 1;
    } catch { return false; }
  };

  function currentActiveAuthority(): ActiveAuthority | undefined {
    try {
      const authority = options.currentActiveAuthority();
      if (!isPlainRecord(authority)) return undefined;
      const emptyAuthority = authority["scope"] === null && authority["revision"] === null &&
        authority["connectionAttemptId"] === null && authority["serverFingerprint"] === null;
      const markedAuthority = isCanonicalHttpOrigin(authority["scope"]) &&
        isOpaqueRevision(authority["revision"]) && isAttemptId(authority["connectionAttemptId"]) &&
        (isServerFingerprint(authority["serverFingerprint"]) ||
          (authority["serverFingerprint"] === null &&
            authority["connectionAttemptId"].startsWith("legacy-")));
      return emptyAuthority || markedAuthority
        ? authority
        : undefined;
    } catch {
      return undefined;
    }
  }

  function dispositionFor(
    pending: PendingConnection,
    authority: ActiveAuthority | undefined,
  ): PendingConnectionLoadResult["disposition"] {
    if (!authority) return "none";
    // This check comes first: a crash after config linearization can leave a
    // stale `candidate` checkpoint, but the current authoritative attempt
    // marker proves that this is the same committed handoff transaction.
    if (pending.candidateOrigin !== null && authority.scope === pending.candidateOrigin &&
        authority.connectionAttemptId === pending.attemptId) return "committed-handoff";
    if (pending.handoffCheckpoint === "candidate" &&
        authority.scope === pending.activeScopeGuard &&
        authority.revision === pending.activeRevisionGuard &&
        (pending.activeRevisionGuard !== null ||
          (authority.scope === null && authority.connectionAttemptId === null))) return "precommit";
    return "none";
  }

  return {
    load(): PendingConnectionLoadResult {
      let raw: string;
      try {
        raw = fileSystem.readFileSync(options.filePath, "utf-8");
      } catch (error) {
        return isMissingFile(error) ? { disposition: "none" } : { disposition: "blocked-legacy-handoff" };
      }
      try {
        const rawValue: unknown = JSON.parse(raw);
        const authority = currentActiveAuthority();
        const isV1 = isPlainRecord(rawValue) && rawValue["version"] === 1;
        const parsed = isV1 ? migrateV1(rawValue) : parsePendingConnection(rawValue);
        if (!parsed && namesCurrentCommittedAttempt(rawValue, authority)) return { disposition: "blocked-legacy-handoff" };
        if (!parsed || parsed.tupleBinding !== options.tupleBinding) return { disposition: "none" };
        if (isV1 &&
            namesCurrentCommittedAttempt(rawValue, authority) && parsed.activeScopeGuard === parsed.candidateOrigin) {
          return { disposition: "blocked-legacy-handoff" };
        }
        const disposition = dispositionFor(parsed, currentActiveAuthority());
        return disposition === "none" ? { disposition } : { disposition, pending: parsed };
      } catch {
        return { disposition: "blocked-legacy-handoff" };
      }
    },

    save(candidate: PendingConnection): void {
      const parsed = parsePendingConnection(candidate);
      const authority = currentActiveAuthority();
      const candidateSaveIsCurrent = parsed?.handoffCheckpoint === "candidate" &&
        authority?.scope === parsed.activeScopeGuard && authority.revision === parsed.activeRevisionGuard;
      const acceptedCandidateHasExactA = parsed?.handoffCheckpoint !== "candidate" ||
        parsed.identityTransition.kind !== "accepted-identity-replacement" ||
        (authority?.connectionAttemptId === parsed.identityTransition.priorConnectionAttemptId &&
          authority.serverFingerprint === parsed.identityTransition.priorServerFingerprint &&
          authority.scope === parsed.activeScopeGuard && authority.revision === parsed.activeRevisionGuard);
      const committedSaveIsCurrent = parsed?.handoffCheckpoint === "active-committed" &&
        authority?.scope === parsed.candidateOrigin && authority.connectionAttemptId === parsed.attemptId;
      if (!parsed || parsed.tupleBinding !== options.tupleBinding ||
          (!candidateSaveIsCurrent && !committedSaveIsCurrent) || !acceptedCandidateHasExactA ||
          !sameAcceptedCandidate(parsed)) {
        throw new Error("pending connection record is invalid for this tuple");
      }
      const tempPath = uniqueTemporaryPath(options.filePath, temporaryId());
      const bytes = JSON.stringify(parsed);
      fileSystem.mkdirSync(path.dirname(options.filePath), { recursive: true, mode: DIRECTORY_MODE });
      try {
        fileSystem.writeFileSync(tempPath, bytes, { encoding: "utf-8", mode: FILE_MODE, flag: "wx" });
        // Defend against permissive umasks and keep the final renamed inode private.
        fileSystem.chmodSync(tempPath, FILE_MODE);
        fileSystem.renameSync(tempPath, options.filePath);
      } finally {
        try {
          fileSystem.unlinkSync(tempPath);
        } catch {
          // Rename consumed it, or the write failed before creation.
        }
      }
    },

    /** Missing is success; only this journal path is ever removed. */
    clear(): void {
      try {
        fileSystem.unlinkSync(options.filePath);
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
    },
  };
}
