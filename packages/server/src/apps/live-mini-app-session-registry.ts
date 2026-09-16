import { randomBytes } from "node:crypto";
import { liveAppCommandBroker } from "./live-app-command-broker";
import * as path from "node:path";
import type {
  ApplyAcceptedLiveProposalResponse,
  LiveDocumentVersion,
} from "@nautilo/types";
import {
  liveDocumentVersionEquals,
  parseArtifactDocumentVersion,
  parseLocalShaDocumentVersion,
} from "@nautilo/types";

const LIVE_MINI_APP_SESSION_TTL_MS = 15 * 60 * 1000;
const LIVE_DIRECT_MUTATION_LEDGER_LIMIT = 128;
const LIVE_DIRECT_MUTATION_RESULT_MAX_BYTES = 64 * 1024;

export type LiveMiniAppSessionArtifactBinding = {
  targetKind: "artifact";
  appId: string;
  userId: string;
  namespaceIds: readonly string[];
  artifactId: string;
  documentId: string;
  documentVersion: Extract<LiveDocumentVersion, { kind: "artifact_revision" }>;
};

export type LiveMiniAppSessionCurrentFileBinding = {
  targetKind: "currentFile";
  appId: string;
  userId: string;
  localTargetId: string;
  relayId: string;
  canonicalPath: string;
  currentFolderRoot: string;
  relativePath: string;
  documentVersion: Extract<LiveDocumentVersion, { kind: "local_sha" }>;
};

export type LiveMiniAppSessionBinding =
  | LiveMiniAppSessionArtifactBinding
  | LiveMiniAppSessionCurrentFileBinding;

export type LiveMiniAppSessionArtifactExpected = {
  targetKind: "artifact";
  appId: string;
  userId: string;
  artifactId: string;
  documentId: string;
  documentVersion: Extract<LiveDocumentVersion, { kind: "artifact_revision" }>;
};

export type LiveMiniAppSessionCurrentFileExpected = {
  targetKind: "currentFile";
  appId: string;
  userId: string;
  localTargetId: string;
  documentVersion: Extract<LiveDocumentVersion, { kind: "local_sha" }>;
};

export type LiveMiniAppSessionValidateExpected =
  | LiveMiniAppSessionArtifactExpected
  | LiveMiniAppSessionCurrentFileExpected;

export type LiveMiniAppSessionArtifactRefreshExpected = Omit<
  LiveMiniAppSessionArtifactExpected,
  "documentVersion"
> & { documentVersion?: Extract<LiveDocumentVersion, { kind: "artifact_revision" }> };

export type LiveMiniAppSessionCurrentFileRefreshExpected = Omit<
  LiveMiniAppSessionCurrentFileExpected,
  "documentVersion"
> & { documentVersion?: Extract<LiveDocumentVersion, { kind: "local_sha" }> };

export type LiveMiniAppSessionRefreshExpected =
  | LiveMiniAppSessionArtifactRefreshExpected
  | LiveMiniAppSessionCurrentFileRefreshExpected;

export type LiveMiniAppSessionTargetQuery =
  | {
      targetKind: "artifact";
      appId: string;
      userId: string;
      artifactId: string;
    }
  | {
      targetKind: "currentFile";
      appId: string;
      userId: string;
      localTargetId: string;
    };

export type LiveMiniAppSessionValidation =
  | { ok: true; binding: LiveMiniAppSessionBinding; sessionId: string; expiresAt: number }
  | { ok: false; code: "session_closed" }
  | {
      ok: false;
      code: "stale_version";
      /** The authenticated session's current host-bound version only. */
      currentDocumentVersion?: LiveDocumentVersion;
    };

export type LiveDirectMutationClaim =
  | {
      ok: true;
      status: "claimed";
      binding: LiveMiniAppSessionBinding;
      sessionId: string;
    }
  | { ok: true; status: "replay"; resultContent: string }
  | {
      ok: false;
      code:
        | "session_closed"
        | "idempotency_conflict"
        | "idempotency_in_progress"
        | "idempotency_ledger_full";
    }
  | {
      ok: false;
      code: "stale_version";
      /** The authenticated session's current host-bound version only. */
      currentDocumentVersion?: LiveDocumentVersion;
    };

export type LiveReviewLocatorValidation =
  | { ok: true; payload: unknown }
  | { ok: false; code: "session_closed" | "stale_version" };

export type LiveReviewProposalAcceptance = {
  requestId: string;
  acceptedContentSha256: string;
  acceptedOperationIndexes: readonly number[];
  result: ApplyAcceptedLiveProposalResponse;
};

/** Bounded in-memory lineage for server-preflighted live review proposals. */
export type LiveReviewProposalRecord = {
  /** Server-generated opaque id, not the LangChain tool-call id. */
  proposalId: string;
  sessionId: string;
  documentVersion: LiveDocumentVersion;
  /** Authenticated proposing agent retained only as process-local mutation provenance. */
  agentId: string;
  turnId: string;
  /** Server-preflighted resolved operations in original index order. */
  operations: readonly unknown[];
  /** Client-safe operations returned by the live Writer tool. */
  deliveryOperations: readonly unknown[];
  /** Dependency/grouping metadata from the same preflight execution. */
  operationMetadata: readonly unknown[];
  acceptance?: LiveReviewProposalAcceptance;
  /** A review is no longer eligible to own the visible Writer surface once its
   * terminal outcome has been recorded.  This is transport state only; Task
   * terminalization and durable receipts are owned by the lifecycle port. */
  reviewOutcome?: "accepted" | "rejected";
  expiresAt: number;
};

export type LiveReviewProposalRegistration =
  | { ok: true; proposalId: string }
  | {
      ok: false;
      code: "session_closed" | "stale_version" | "missing_turn_id";
      /** Deliberately maps to the existing fail-closed tool result until the
       * proposal tool exposes a user-safe competing-review code. */
      reason?: "review_owner_busy";
    };

export type LiveReviewProposalLookup =
  | { ok: true; record: LiveReviewProposalRecord }
  | {
      ok: false;
      code:
        | "session_closed"
        | "stale_version"
        | "proposal_not_found"
        | "proposal_closed"
        | "acceptance_conflict";
    };

export type LiveReviewProposalCommit =
  | {
      ok: true;
      binding: LiveMiniAppSessionBinding;
      sessionId: string;
      expiresAt: number;
    }
  | {
      ok: false;
      code:
        | "session_closed"
        | "stale_version"
        | "proposal_not_found"
        | "proposal_closed";
    };

export type LiveReviewResolutionValidation =
  | { ok: true; record: LiveReviewProposalRecord }
  | { ok: false; code: "session_closed" | "stale_version" | "proposal_not_found" | "proposal_closed" };

/** Reasons that close an in-memory capability without granting a document write. */
export type LiveMiniAppSessionExpiryObserver = (sessionId: string) => void;

type LiveMiniAppSessionEntry = {
  binding: LiveMiniAppSessionBinding;
  sessionId: string;
  expiresAt: number;
  directMutationLedger: Map<string, LiveDirectMutationLedgerRecord>;
};

type LiveDirectMutationLedgerRecord = {
  documentVersion: LiveDocumentVersion;
  operationFingerprint: string;
  sequence: number;
  resultContent?: string;
};

type LiveReviewProposalEntry = LiveReviewProposalRecord;

function cloneDocumentVersion(version: LiveDocumentVersion): LiveDocumentVersion {
  if (version.kind === "artifact_revision") {
    return { kind: "artifact_revision", revision: version.revision };
  }
  return { kind: "local_sha", sha256: version.sha256 };
}

function canonicalIdentityAtOrBelow(
  canonicalDirectoryIdentity: string,
  canonicalTargetIdentity: string,
): boolean {
  if (canonicalDirectoryIdentity === canonicalTargetIdentity) return true;
  const windows =
    /^[A-Za-z]:[\\/]/.test(canonicalDirectoryIdentity) &&
    /^[A-Za-z]:[\\/]/.test(canonicalTargetIdentity);
  const pathApi = windows ? path.win32 : path.posix;
  const relative = pathApi.relative(
    canonicalDirectoryIdentity,
    canonicalTargetIdentity,
  );
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${pathApi.sep}`) &&
    !pathApi.isAbsolute(relative)
  );
}

function cloneBinding(binding: LiveMiniAppSessionBinding): LiveMiniAppSessionBinding {
  if (binding.targetKind === "artifact") {
    return {
      ...binding,
      namespaceIds: [...binding.namespaceIds],
      documentVersion: {
        kind: "artifact_revision",
        revision: binding.documentVersion.revision,
      },
    };
  }
  return {
    ...binding,
    documentVersion: {
      kind: "local_sha",
      sha256: binding.documentVersion.sha256,
    },
  };
}

function isValidArtifactBinding(binding: LiveMiniAppSessionArtifactBinding): boolean {
  return (
    binding.appId.length > 0 &&
    binding.userId.length > 0 &&
    binding.artifactId.length > 0 &&
    binding.documentId.length > 0 &&
    binding.namespaceIds.length > 0 &&
    binding.namespaceIds.every((namespaceId) => namespaceId.length > 0) &&
    parseArtifactDocumentVersion(binding.documentVersion) !== null
  );
}

function isValidCurrentFileBinding(binding: LiveMiniAppSessionCurrentFileBinding): boolean {
  return (
    binding.appId.length > 0 &&
    binding.userId.length > 0 &&
    binding.localTargetId.length > 0 &&
    binding.relayId.length > 0 &&
    binding.canonicalPath.length > 0 &&
    binding.currentFolderRoot.length > 0 &&
    binding.relativePath.length > 0 &&
    parseLocalShaDocumentVersion(binding.documentVersion) !== null
  );
}

function isValidBinding(binding: LiveMiniAppSessionBinding): boolean {
  if (binding.targetKind === "artifact") {
    return isValidArtifactBinding(binding);
  }
  return isValidCurrentFileBinding(binding);
}

function bindingMatchesRefreshExpected(
  binding: LiveMiniAppSessionBinding,
  expected: LiveMiniAppSessionRefreshExpected,
): boolean {
  if (binding.targetKind !== expected.targetKind) return false;
  if (binding.appId !== expected.appId || binding.userId !== expected.userId) {
    return false;
  }
  if (
    expected.documentVersion !== undefined &&
    !liveDocumentVersionEquals(binding.documentVersion, expected.documentVersion)
  ) {
    return false;
  }
  if (expected.targetKind === "artifact") {
    return (
      binding.targetKind === "artifact" &&
      binding.artifactId === expected.artifactId &&
      binding.documentId === expected.documentId
    );
  }
  return (
    binding.targetKind === "currentFile" &&
    binding.localTargetId === expected.localTargetId
  );
}

function bindingMatchesValidateExpected(
  binding: LiveMiniAppSessionBinding,
  expected: LiveMiniAppSessionValidateExpected,
): boolean {
  if (binding.targetKind !== expected.targetKind) return false;
  if (binding.appId !== expected.appId || binding.userId !== expected.userId) {
    return false;
  }
  if (expected.targetKind === "artifact") {
    return (
      binding.targetKind === "artifact" &&
      binding.artifactId === expected.artifactId &&
      binding.documentId === expected.documentId
    );
  }
  return (
    binding.targetKind === "currentFile" &&
    binding.localTargetId === expected.localTargetId
  );
}

function versionKindMatchesBinding(
  binding: LiveMiniAppSessionBinding,
  documentVersion: LiveDocumentVersion,
): boolean {
  if (binding.targetKind === "artifact") {
    return documentVersion.kind === "artifact_revision";
  }
  return documentVersion.kind === "local_sha";
}

function parseRefreshDocumentVersion(
  binding: LiveMiniAppSessionBinding,
  documentVersion: LiveDocumentVersion,
): LiveDocumentVersion | null {
  if (!versionKindMatchesBinding(binding, documentVersion)) return null;
  if (binding.targetKind === "artifact") {
    return parseArtifactDocumentVersion(documentVersion);
  }
  return parseLocalShaDocumentVersion(documentVersion);
}

/**
 * Server-only authority for the model/tool path to a hydrated mini-app
 * document. Issuance is reached through an authenticated Workbench host request
 * whose target and version are authorized server-side; advisory
 * `activeMiniApp` payloads cannot mint or rebind a capability. HTTP cannot
 * cryptographically prove that a human-visible iframe remains on screen, so
 * "open" is represented by host lifecycle refresh/revoke plus TTL expiry.
 */
function cloneProposalOperations(operations: readonly unknown[]): readonly unknown[] {
  return structuredClone(operations);
}

function cloneProposalMetadata(metadata: readonly unknown[]): readonly unknown[] {
  return structuredClone(metadata);
}

export class LiveMiniAppSessionRegistry {
  private readonly entries = new Map<string, LiveMiniAppSessionEntry>();
  private readonly locators = new Map<string, {
    sessionId: string;
    documentVersion: LiveDocumentVersion;
    payload: unknown;
    expiresAt: number;
  }>();
  private readonly proposals = new Map<string, LiveReviewProposalEntry>();
  private directMutationSequence = 0;
  /**
   * Server composition uses this to settle Task-owned reviews before a TTL
   * expiry discards the only process-local session/proposal identity.  The
   * registry remains app-neutral: it provides only the exact session id.
   */
  private expiryObserver: LiveMiniAppSessionExpiryObserver | null = null;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = LIVE_MINI_APP_SESSION_TTL_MS,
    private readonly directMutationLedgerLimit: number = LIVE_DIRECT_MUTATION_LEDGER_LIMIT,
  ) {}

  setExpiryObserver(observer: LiveMiniAppSessionExpiryObserver | null): void {
    this.expiryObserver = observer;
  }

  issue(binding: LiveMiniAppSessionBinding): { token: string; sessionId: string; expiresAt: number } {
    if (!isValidBinding(binding)) {
      throw new Error("Cannot issue a live mini-app session without a valid bound document version.");
    }
    this.expire();
    const token = randomBytes(32).toString("base64url");
    const sessionId = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + this.ttlMs;
    this.entries.set(token, {
      binding: cloneBinding(binding),
      sessionId,
      expiresAt,
      directMutationLedger: new Map(),
    });
    return { token, sessionId, expiresAt };
  }

  refresh(
    token: string,
    documentVersion: LiveDocumentVersion,
    expected: LiveMiniAppSessionRefreshExpected,
  ): LiveMiniAppSessionValidation {
    const entry = this.getOpenEntry(token);
    if (!entry) return { ok: false, code: "session_closed" };
    const binding = entry.binding;
    if (!bindingMatchesRefreshExpected(binding, expected)) {
      return { ok: false, code: "session_closed" };
    }
    const parsedVersion = parseRefreshDocumentVersion(binding, documentVersion);
    if (!parsedVersion) return { ok: false, code: "session_closed" };
    entry.binding = {
      ...cloneBinding(binding),
      documentVersion: parsedVersion,
    } as LiveMiniAppSessionBinding;
    entry.expiresAt = this.now() + this.ttlMs;
    return {
      ok: true,
      binding: cloneBinding(entry.binding),
      sessionId: entry.sessionId,
      expiresAt: entry.expiresAt,
    };
  }

  validate(
    token: string,
    expected: LiveMiniAppSessionValidateExpected,
  ): LiveMiniAppSessionValidation {
    const entry = this.getOpenEntry(token);
    if (!entry) return { ok: false, code: "session_closed" };
    const binding = entry.binding;
    if (!bindingMatchesValidateExpected(binding, expected)) {
      return { ok: false, code: "session_closed" };
    }
    if (!versionKindMatchesBinding(binding, expected.documentVersion)) {
      return { ok: false, code: "session_closed" };
    }
    if (!liveDocumentVersionEquals(binding.documentVersion, expected.documentVersion)) {
      return {
        ok: false,
        code: "stale_version",
        currentDocumentVersion: cloneDocumentVersion(binding.documentVersion),
      };
    }
    return {
      ok: true,
      binding: cloneBinding(binding),
      sessionId: entry.sessionId,
      expiresAt: entry.expiresAt,
    };
  }

  /**
   * Tool-side validation deliberately derives document identity from the
   * capability, never from a model or prompt payload. A future extension handler
   * must compare its freshly read canonical version before resolver work.
   */
  validateForSubject(
    token: string,
    expected: Pick<LiveMiniAppSessionBinding, "appId" | "userId"> & {
      documentVersion: LiveDocumentVersion;
    },
  ): LiveMiniAppSessionValidation {
    const entry = this.getOpenEntry(token);
    if (!entry) return { ok: false, code: "session_closed" };
    const binding = entry.binding;
    if (binding.appId !== expected.appId || binding.userId !== expected.userId) {
      return { ok: false, code: "session_closed" };
    }
    if (!versionKindMatchesBinding(binding, expected.documentVersion)) {
      return { ok: false, code: "session_closed" };
    }
    if (!liveDocumentVersionEquals(binding.documentVersion, expected.documentVersion)) {
      return {
        ok: false,
        code: "stale_version",
        currentDocumentVersion: cloneDocumentVersion(binding.documentVersion),
      };
    }
    return {
      ok: true,
      binding: cloneBinding(binding),
      sessionId: entry.sessionId,
      expiresAt: entry.expiresAt,
    };
  }

  /** Validate only the opaque token's authenticated app/user binding.
   * Acceptance retries use this after a successful write changed the binding
   * version, while proposal lineage still pins the original version. */
  validateOpenForSubject(
    token: string,
    expected: Pick<LiveMiniAppSessionBinding, "appId" | "userId">,
  ): LiveMiniAppSessionValidation {
    const entry = this.getOpenEntry(token);
    if (!entry) return { ok: false, code: "session_closed" };
    if (
      entry.binding.appId !== expected.appId ||
      entry.binding.userId !== expected.userId
    ) {
      return { ok: false, code: "session_closed" };
    }
    return {
      ok: true,
      binding: cloneBinding(entry.binding),
      sessionId: entry.sessionId,
      expiresAt: entry.expiresAt,
    };
  }

  /**
   * Claims an idempotency key at the authenticated live-session boundary.
   * Completed claims remain addressable across binding version refreshes so a
   * lost tool response can be replayed without a second document write.
   */
  claimDirectMutation(
    token: string,
    expected: Pick<LiveMiniAppSessionBinding, "appId" | "userId"> & {
      documentVersion: LiveDocumentVersion;
      idempotencyKey: string;
      operationFingerprint: string;
    },
  ): LiveDirectMutationClaim {
    const entry = this.getOpenEntry(token);
    if (!entry) return { ok: false, code: "session_closed" };
    if (
      entry.binding.appId !== expected.appId ||
      entry.binding.userId !== expected.userId
    ) {
      return { ok: false, code: "session_closed" };
    }

    const existing = entry.directMutationLedger.get(expected.idempotencyKey);
    if (existing) {
      if (existing.operationFingerprint !== expected.operationFingerprint) {
        return { ok: false, code: "idempotency_conflict" };
      }
      if (existing.resultContent === undefined) {
        return { ok: false, code: "idempotency_in_progress" };
      }
      return { ok: true, status: "replay", resultContent: existing.resultContent };
    }

    if (!versionKindMatchesBinding(entry.binding, expected.documentVersion)) {
      return { ok: false, code: "session_closed" };
    }
    if (!liveDocumentVersionEquals(entry.binding.documentVersion, expected.documentVersion)) {
      return {
        ok: false,
        code: "stale_version",
        currentDocumentVersion: cloneDocumentVersion(entry.binding.documentVersion),
      };
    }

    if (entry.directMutationLedger.size >= this.directMutationLedgerLimit) {
      let oldestCompleted: [string, LiveDirectMutationLedgerRecord] | null = null;
      for (const candidate of entry.directMutationLedger) {
        if (candidate[1].resultContent === undefined) continue;
        if (!oldestCompleted || candidate[1].sequence < oldestCompleted[1].sequence) {
          oldestCompleted = candidate;
        }
      }
      if (!oldestCompleted) {
        return { ok: false, code: "idempotency_ledger_full" };
      }
      entry.directMutationLedger.delete(oldestCompleted[0]);
    }

    entry.directMutationLedger.set(expected.idempotencyKey, {
      documentVersion: cloneDocumentVersion(expected.documentVersion),
      operationFingerprint: expected.operationFingerprint,
      sequence: this.directMutationSequence++,
    });
    return {
      ok: true,
      status: "claimed",
      binding: cloneBinding(entry.binding),
      sessionId: entry.sessionId,
    };
  }

  completeDirectMutation(
    token: string,
    expected: Pick<LiveMiniAppSessionBinding, "appId" | "userId"> & {
      sessionId: string;
      documentVersion: LiveDocumentVersion;
      idempotencyKey: string;
      operationFingerprint: string;
    },
    resultContent: string,
    nextDocumentVersion: LiveDocumentVersion,
  ): boolean {
    if (Buffer.byteLength(resultContent, "utf8") > LIVE_DIRECT_MUTATION_RESULT_MAX_BYTES) {
      return false;
    }
    const entry = this.getOpenEntry(token);
    if (
      !entry ||
      entry.sessionId !== expected.sessionId ||
      entry.binding.appId !== expected.appId ||
      entry.binding.userId !== expected.userId
    ) {
      return false;
    }
    const record = entry.directMutationLedger.get(expected.idempotencyKey);
    if (
      !record ||
      record.resultContent !== undefined ||
      record.operationFingerprint !== expected.operationFingerprint ||
      !liveDocumentVersionEquals(record.documentVersion, expected.documentVersion) ||
      !liveDocumentVersionEquals(entry.binding.documentVersion, expected.documentVersion)
    ) {
      return false;
    }
    const parsedNextVersion = parseRefreshDocumentVersion(entry.binding, nextDocumentVersion);
    if (!parsedNextVersion) return false;
    record.resultContent = resultContent;
    entry.binding = {
      ...cloneBinding(entry.binding),
      documentVersion: parsedNextVersion,
    } as LiveMiniAppSessionBinding;
    entry.expiresAt = this.now() + this.ttlMs;
    return true;
  }

  abortDirectMutation(
    token: string,
    expected: Pick<LiveMiniAppSessionBinding, "appId" | "userId"> & {
      sessionId: string;
      documentVersion: LiveDocumentVersion;
      idempotencyKey: string;
      operationFingerprint: string;
    },
  ): boolean {
    const entry = this.getOpenEntry(token);
    if (
      !entry ||
      entry.sessionId !== expected.sessionId ||
      entry.binding.appId !== expected.appId ||
      entry.binding.userId !== expected.userId
    ) {
      return false;
    }
    const record = entry.directMutationLedger.get(expected.idempotencyKey);
    if (
      !record ||
      record.resultContent !== undefined ||
      record.operationFingerprint !== expected.operationFingerprint ||
      !liveDocumentVersionEquals(record.documentVersion, expected.documentVersion)
    ) {
      return false;
    }
    return entry.directMutationLedger.delete(expected.idempotencyKey);
  }

  revokeForSubject(
    token: string,
    expected: Pick<LiveMiniAppSessionBinding, "appId" | "userId">,
    beforeRevoke?: (sessionId: string) => void,
  ): boolean {
    const entry = this.getOpenEntry(token);
    if (!entry) return false;
    if (
      entry.binding.appId !== expected.appId ||
      entry.binding.userId !== expected.userId
    ) {
      return false;
    }
    beforeRevoke?.(entry.sessionId);
    return this.deleteEntry(token, entry);
  }

  revokeForRelay(
    userId: string,
    relayId: string,
    beforeRevoke?: (sessionId: string) => void,
  ): readonly string[] {
    this.expire();
    const revokedSessionIds: string[] = [];
    for (const [token, entry] of this.entries) {
      const binding = entry.binding;
      if (
        binding.targetKind === "currentFile" &&
        binding.userId === userId &&
        binding.relayId === relayId
      ) {
        beforeRevoke?.(entry.sessionId);
        if (this.deleteEntry(token, entry)) {
          revokedSessionIds.push(entry.sessionId);
        }
      }
    }
    return revokedSessionIds;
  }

  issueLocator(
    sessionId: string,
    documentVersion: LiveDocumentVersion,
    payload: unknown,
  ): string {
    const handle = randomBytes(32).toString("base64url");
    const entry = [...this.entries.values()].find((candidate) => candidate.sessionId === sessionId);
    if (!entry || !liveDocumentVersionEquals(entry.binding.documentVersion, documentVersion)) {
      throw new Error("Cannot issue a locator outside an open live review session.");
    }
    this.locators.set(handle, {
      sessionId,
      documentVersion: cloneDocumentVersion(documentVersion),
      payload,
      expiresAt: entry.expiresAt,
    });
    return handle;
  }

  registerProposal(args: {
    sessionId: string;
    documentVersion: LiveDocumentVersion;
    agentId: string;
    turnId: string;
    operations: readonly unknown[];
    deliveryOperations?: readonly unknown[];
    operationMetadata: readonly unknown[];
  }): LiveReviewProposalRegistration {
    this.expire();
    if (
      typeof args.agentId !== "string" || args.agentId.length === 0 ||
      typeof args.turnId !== "string" || args.turnId.length === 0
    ) {
      return { ok: false, code: "missing_turn_id" };
    }
    const entry = [...this.entries.values()].find((candidate) => candidate.sessionId === args.sessionId);
    if (!entry) return { ok: false, code: "session_closed" };
    if (!liveDocumentVersionEquals(entry.binding.documentVersion, args.documentVersion)) {
      return { ok: false, code: "stale_version" };
    }
    // Writer is a single human review surface, not a proposal queue.  Refuse
    // a competing producer before it can silently displace the proposal the
    // human is already reviewing.  A terminally resolved proposal releases
    // ownership even though its bounded lineage remains available for retry.
    if (
      [...this.proposals.values()].some(
        (proposal) => proposal.sessionId === args.sessionId && proposal.reviewOutcome === undefined,
      )
    ) {
      return { ok: false, code: "session_closed", reason: "review_owner_busy" };
    }
    const proposalId = randomBytes(32).toString("base64url");
    this.proposals.set(proposalId, {
      proposalId,
      sessionId: args.sessionId,
      documentVersion: cloneDocumentVersion(args.documentVersion),
      agentId: args.agentId,
      turnId: args.turnId,
      operations: cloneProposalOperations(args.operations),
      deliveryOperations: cloneProposalOperations(args.deliveryOperations ?? args.operations),
      operationMetadata: cloneProposalMetadata(args.operationMetadata),
      expiresAt: entry.expiresAt,
    });
    return { ok: true, proposalId };
  }

  lookupProposal(expected: {
    sessionId: string;
    proposalId: string;
    documentVersion: LiveDocumentVersion;
  }): LiveReviewProposalLookup {
    this.expire();
    const record = this.proposals.get(expected.proposalId);
    if (!record || record.expiresAt <= this.now()) {
      this.proposals.delete(expected.proposalId);
      return { ok: false, code: "proposal_not_found" };
    }
    const entry = [...this.entries.values()].find((candidate) => candidate.sessionId === expected.sessionId);
    if (!entry) return { ok: false, code: "session_closed" };
    if (record.sessionId !== expected.sessionId) {
      return { ok: false, code: "proposal_not_found" };
    }
    if (!liveDocumentVersionEquals(record.documentVersion, expected.documentVersion)) {
      return { ok: false, code: "stale_version" };
    }
    // A terminal acceptance advances the live binding to the post-write SHA.
    // Keep the original proposal/version addressable solely for an identical
    // lost-response retry; an unconsumed proposal must still match the live
    // binding exactly.
    if (
      record.acceptance === undefined &&
      !liveDocumentVersionEquals(entry.binding.documentVersion, expected.documentVersion)
    ) {
      return { ok: false, code: "stale_version" };
    }
    return {
      ok: true,
      record: {
        ...record,
        documentVersion: cloneDocumentVersion(record.documentVersion),
        operations: cloneProposalOperations(record.operations),
        deliveryOperations: cloneProposalOperations(record.deliveryOperations),
        operationMetadata: cloneProposalMetadata(record.operationMetadata),
        ...(record.acceptance ? { acceptance: structuredClone(record.acceptance) } : {}),
      },
    };
  }

  /**
   * Read-only reconciliation projection for an exact open session/version.
   *
   * A refresh can advance the live binding while its one visible review is
   * still unresolved. Replay that exact owner so the rehydrated Writer can
   * classify and invalidate it; terminal historical proposals remain hidden.
   * This is deliberately not a proposal history or queue.
   */
  listProposalsForSession(expected: {
    sessionId: string;
    documentVersion: LiveDocumentVersion;
  }): LiveReviewProposalRecord[] {
    this.expire();
    const entry = [...this.entries.values()].find(
      (candidate) => candidate.sessionId === expected.sessionId,
    );
    if (
      !entry ||
      !liveDocumentVersionEquals(entry.binding.documentVersion, expected.documentVersion)
    ) return [];
    const records = [...this.proposals.values()].filter(
      (record) => record.sessionId === expected.sessionId,
    );
    const currentVersion = records.filter((record) =>
      record.reviewOutcome === undefined &&
      liveDocumentVersionEquals(record.documentVersion, expected.documentVersion),
    );
    const unresolvedPrior = records.filter((record) =>
      record.reviewOutcome === undefined &&
      !liveDocumentVersionEquals(record.documentVersion, expected.documentVersion),
    );
    // registerProposal enforces one review owner per session. If corrupted
    // in-memory state ever violates that invariant, disclose neither stale
    // record rather than accidentally manufacturing a replay queue.
    const reconciled = [...currentVersion];
    const soleUnresolvedPrior = unresolvedPrior.length === 1 ? unresolvedPrior[0] : undefined;
    if (soleUnresolvedPrior) reconciled.push(soleUnresolvedPrior);
    return reconciled
      .map((record) => ({
        ...record,
        documentVersion: cloneDocumentVersion(record.documentVersion),
        operations: cloneProposalOperations(record.operations),
        deliveryOperations: cloneProposalOperations(record.deliveryOperations),
        operationMetadata: cloneProposalMetadata(record.operationMetadata),
        ...(record.acceptance ? { acceptance: structuredClone(record.acceptance) } : {}),
      }));
  }

  /**
   * Validate the UI's terminal review outcome against the exact proposal and
   * the canonical post-persistence live binding. This grants no mutation; it
   * only proves that Writer already persisted (or fully rejected) the review.
   */
  validateProposalReviewResolution(expected: {
    sessionId: string;
    proposalId: string;
    documentVersion: LiveDocumentVersion;
    outcome: "accepted" | "rejected";
    resultDocumentVersion?: LiveDocumentVersion;
  }): LiveReviewResolutionValidation {
    this.expire();
    const record = this.proposals.get(expected.proposalId);
    if (!record || record.sessionId !== expected.sessionId) {
      return { ok: false, code: "proposal_not_found" };
    }
    if (!liveDocumentVersionEquals(record.documentVersion, expected.documentVersion)) {
      return { ok: false, code: "stale_version" };
    }
    const entry = [...this.entries.values()].find(
      (candidate) => candidate.sessionId === expected.sessionId,
    );
    if (!entry) return { ok: false, code: "session_closed" };
    if (record.reviewOutcome !== undefined && record.reviewOutcome !== expected.outcome) {
      return { ok: false, code: "proposal_closed" };
    }
    if (expected.outcome === "rejected") {
      if (
        record.acceptance !== undefined ||
        expected.resultDocumentVersion !== undefined ||
        !liveDocumentVersionEquals(entry.binding.documentVersion, expected.documentVersion)
      ) return { ok: false, code: "proposal_closed" };
      return { ok: true, record: { ...record } };
    }
    const resultVersion = expected.resultDocumentVersion;
    if (!resultVersion) return { ok: false, code: "stale_version" };
    if (
      !record.acceptance ||
      !liveDocumentVersionEquals(record.acceptance.result.documentVersion, resultVersion) ||
      !liveDocumentVersionEquals(entry.binding.documentVersion, resultVersion)
    ) return { ok: false, code: "stale_version" };
    return { ok: true, record: { ...record, acceptance: structuredClone(record.acceptance) } };
  }

  /**
   * Validate an exact UI invalidation against proposal lineage, deliberately
   * without requiring the current live binding to remain at the old document
   * version. A Human or remote edit is precisely why the original review can
   * no longer be accepted. This remains non-authorizing: it cannot write the
   * document and callers still need the authenticated session token.
   */
  validateProposalReviewInvalidation(expected: {
    sessionId: string;
    proposalId: string;
    documentVersion: LiveDocumentVersion;
  }): LiveReviewResolutionValidation {
    this.expire();
    const record = this.proposals.get(expected.proposalId);
    if (!record || record.sessionId !== expected.sessionId) {
      return { ok: false, code: "proposal_not_found" };
    }
    if (!liveDocumentVersionEquals(record.documentVersion, expected.documentVersion)) {
      return { ok: false, code: "stale_version" };
    }
    const entry = [...this.entries.values()].find(
      (candidate) => candidate.sessionId === expected.sessionId,
    );
    if (!entry) return { ok: false, code: "session_closed" };
    if (record.reviewOutcome === "accepted") return { ok: false, code: "proposal_closed" };
    return {
      ok: true,
      record: {
        ...record,
        documentVersion: cloneDocumentVersion(record.documentVersion),
        operations: cloneProposalOperations(record.operations),
        deliveryOperations: cloneProposalOperations(record.deliveryOperations),
        operationMetadata: cloneProposalMetadata(record.operationMetadata),
        ...(record.acceptance ? { acceptance: structuredClone(record.acceptance) } : {}),
      },
    };
  }

  /**
   * Release the exact visible-review ownership only after the caller has
   * validated the terminal outcome and recorded its server-owned lifecycle
   * receipt. Duplicate identical completion is harmless; a contrary outcome
   * is rejected so a reconnect cannot rewrite history.
   */
  completeProposalReview(expected: {
    sessionId: string;
    proposalId: string;
    outcome: "accepted" | "rejected";
  }): LiveReviewResolutionValidation {
    this.expire();
    const record = this.proposals.get(expected.proposalId);
    if (!record || record.sessionId !== expected.sessionId) {
      return { ok: false, code: "proposal_not_found" };
    }
    if (record.reviewOutcome && record.reviewOutcome !== expected.outcome) {
      return { ok: false, code: "proposal_closed" };
    }
    record.reviewOutcome = expected.outcome;
    return { ok: true, record: {
      ...record,
      documentVersion: cloneDocumentVersion(record.documentVersion),
      operations: cloneProposalOperations(record.operations),
      deliveryOperations: cloneProposalOperations(record.deliveryOperations),
      operationMetadata: cloneProposalMetadata(record.operationMetadata),
      ...(record.acceptance ? { acceptance: structuredClone(record.acceptance) } : {}),
    } };
  }

  recordProposalAcceptance(
    expected: {
      sessionId: string;
      proposalId: string;
      documentVersion: LiveDocumentVersion;
    },
    acceptance: LiveReviewProposalAcceptance,
  ): LiveReviewProposalLookup {
    const lookup = this.lookupProposal(expected);
    if (!lookup.ok) return lookup;
    const record = this.proposals.get(expected.proposalId);
    if (!record) return { ok: false, code: "proposal_not_found" };
    if (record.acceptance) {
      const cached = record.acceptance;
      if (
        cached.requestId === acceptance.requestId &&
        cached.acceptedContentSha256 === acceptance.acceptedContentSha256 &&
        cached.acceptedOperationIndexes.length === acceptance.acceptedOperationIndexes.length &&
        cached.acceptedOperationIndexes.every(
          (index, position) => index === acceptance.acceptedOperationIndexes[position],
        )
      ) {
        return lookup;
      }
      return { ok: false, code: "acceptance_conflict" };
    }
    record.acceptance = structuredClone(acceptance);
    return lookup;
  }

  /** Atomically publish the post-write SHA and terminal retry record after the
   * relay has confirmed both mutation and local revision journaling. */
  commitCurrentFileAcceptance(
    token: string,
    expected: {
      sessionId: string;
      proposalId: string;
      documentVersion: Extract<LiveDocumentVersion, { kind: "local_sha" }>;
    },
    acceptance: LiveReviewProposalAcceptance,
  ): LiveReviewProposalCommit {
    this.expire();
    const entry = this.entries.get(token);
    if (!entry || entry.sessionId !== expected.sessionId) {
      return { ok: false, code: "session_closed" };
    }
    const binding = entry.binding;
    if (binding.targetKind !== "currentFile") {
      return { ok: false, code: "session_closed" };
    }
    const record = this.proposals.get(expected.proposalId);
    if (!record || record.sessionId !== expected.sessionId) {
      return { ok: false, code: "proposal_not_found" };
    }
    if (
      !liveDocumentVersionEquals(record.documentVersion, expected.documentVersion) ||
      !liveDocumentVersionEquals(binding.documentVersion, expected.documentVersion)
    ) {
      return { ok: false, code: "stale_version" };
    }
    if (record.acceptance !== undefined) {
      return { ok: false, code: "proposal_closed" };
    }
    if (acceptance.result.documentVersion.kind !== "local_sha") {
      return { ok: false, code: "stale_version" };
    }

    record.acceptance = structuredClone(acceptance);
    const nextBinding: LiveMiniAppSessionCurrentFileBinding = {
      ...binding,
      documentVersion: {
        kind: "local_sha",
        sha256: acceptance.result.documentVersion.sha256,
      },
    };
    entry.binding = nextBinding;
    entry.expiresAt = this.now() + this.ttlMs;
    return {
      ok: true,
      binding: {
        ...nextBinding,
        documentVersion: { ...nextBinding.documentVersion },
      },
      sessionId: entry.sessionId,
      expiresAt: entry.expiresAt,
    };
  }

  /** Publish a receipt-confirmed Workspace Artifact revision after the
   * canonical Artifact write port commits it.  This does not write bytes. */
  commitArtifactAcceptance(
    token: string,
    expected: {
      sessionId: string;
      proposalId: string;
      documentVersion: Extract<LiveDocumentVersion, { kind: "artifact_revision" }>;
    },
    acceptance: LiveReviewProposalAcceptance,
  ): LiveReviewProposalCommit {
    this.expire();
    const entry = this.entries.get(token);
    if (!entry || entry.sessionId !== expected.sessionId) return { ok: false, code: "session_closed" };
    const binding = entry.binding;
    const resultVersion = acceptance.result.documentVersion;
    if (
      binding.targetKind !== "artifact" ||
      resultVersion.kind !== "artifact_revision" ||
      resultVersion.revision <= expected.documentVersion.revision
    ) return { ok: false, code: "stale_version" };
    const record = this.proposals.get(expected.proposalId);
    if (!record || record.sessionId !== expected.sessionId) return { ok: false, code: "proposal_not_found" };
    if (
      !liveDocumentVersionEquals(record.documentVersion, expected.documentVersion) ||
      !liveDocumentVersionEquals(binding.documentVersion, expected.documentVersion)
    ) return { ok: false, code: "stale_version" };
    if (record.acceptance !== undefined) return { ok: false, code: "proposal_closed" };
    record.acceptance = structuredClone(acceptance);
    const nextBinding: LiveMiniAppSessionArtifactBinding = {
      ...binding,
      documentVersion: { kind: "artifact_revision", revision: resultVersion.revision },
    };
    entry.binding = nextBinding;
    entry.expiresAt = this.now() + this.ttlMs;
    return {
      ok: true,
      binding: { ...nextBinding, documentVersion: { ...nextBinding.documentVersion } },
      sessionId: entry.sessionId,
      expiresAt: entry.expiresAt,
    };
  }

  consumeOrValidateProposal(
    expected: {
      sessionId: string;
      proposalId: string;
      documentVersion: LiveDocumentVersion;
      requestId?: string;
    },
    mode: "validate" | "consume",
  ): LiveReviewProposalLookup {
    const lookup = this.lookupProposal(expected);
    if (!lookup.ok) return lookup;
    if (mode === "consume" && lookup.record.acceptance !== undefined) {
      if (
        expected.requestId !== undefined &&
        lookup.record.acceptance.requestId !== expected.requestId
      ) {
        return { ok: false, code: "proposal_closed" };
      }
    }
    return lookup;
  }

  validateLocator(
    handle: string,
    expected: { sessionId: string; documentVersion: LiveDocumentVersion },
  ): LiveReviewLocatorValidation {
    const locator = this.locators.get(handle);
    if (!locator || locator.expiresAt <= this.now()) {
      this.locators.delete(handle);
      return { ok: false, code: "session_closed" };
    }
    if (locator.sessionId !== expected.sessionId) {
      return { ok: false, code: "session_closed" };
    }
    if (!liveDocumentVersionEquals(locator.documentVersion, expected.documentVersion)) {
      return { ok: false, code: "stale_version" };
    }
    return { ok: true, payload: locator.payload };
  }

  /**
   * Returns whether this authenticated user currently has a hydrated session
   * for the exact internal artifact. Callers must resolve the artifact through
   * their authorization envelope first; this registry never accepts paths or
   * client-supplied artifact identifiers as authority.
   */
  hasOpenSessionForArtifact(
    expected: Pick<LiveMiniAppSessionArtifactBinding, "appId" | "userId" | "artifactId">,
  ): boolean {
    return this.hasOpenSessionForTarget({
      targetKind: "artifact",
      appId: expected.appId,
      userId: expected.userId,
      artifactId: expected.artifactId,
    });
  }

  hasOpenSessionForLocalTarget(
    expected: Pick<LiveMiniAppSessionCurrentFileBinding, "appId" | "userId" | "localTargetId">,
  ): boolean {
    return this.hasOpenSessionForTarget({
      targetKind: "currentFile",
      appId: expected.appId,
      userId: expected.userId,
      localTargetId: expected.localTargetId,
    });
  }

  /**
   * Direct-mutation guard lookup after the caller has independently resolved
   * filesystem identity on the exact pinned relay. localTargetId remains
   * opaque; raw request paths are never accepted as identity.
   */
  hasOpenSessionForCurrentFileIdentity(expected: {
    appId: string;
    userId: string;
    relayId: string;
    canonicalTargetIdentity: string;
  }): boolean {
    this.expire();
    for (const entry of this.entries.values()) {
      const binding = entry.binding;
      if (
        binding.targetKind === "currentFile" &&
        binding.appId === expected.appId &&
        binding.userId === expected.userId &&
        binding.relayId === expected.relayId &&
        binding.canonicalPath === expected.canonicalTargetIdentity
      ) {
        return true;
      }
    }
    return false;
  }

  hasOpenSessionAtOrBelowCurrentFileIdentity(expected: {
    appId: string;
    userId: string;
    relayId: string;
    canonicalDirectoryIdentity: string;
  }): boolean {
    this.expire();
    for (const entry of this.entries.values()) {
      const binding = entry.binding;
      if (
        binding.targetKind === "currentFile" &&
        binding.appId === expected.appId &&
        binding.userId === expected.userId &&
        binding.relayId === expected.relayId &&
        canonicalIdentityAtOrBelow(
          expected.canonicalDirectoryIdentity,
          binding.canonicalPath,
        )
      ) {
        return true;
      }
    }
    return false;
  }

  hasOpenSessionForTarget(expected: LiveMiniAppSessionTargetQuery): boolean {
    this.expire();
    for (const entry of this.entries.values()) {
      const binding = entry.binding;
      if (expected.targetKind === "artifact") {
        if (
          binding.targetKind === "artifact" &&
          binding.appId === expected.appId &&
          binding.userId === expected.userId &&
          binding.artifactId === expected.artifactId
        ) {
          return true;
        }
        continue;
      }
      if (
        binding.targetKind === "currentFile" &&
        binding.appId === expected.appId &&
        binding.userId === expected.userId &&
        binding.localTargetId === expected.localTargetId
      ) {
        return true;
      }
    }
    return false;
  }

  expire(): void {
    const now = this.now();
    for (const [token, entry] of this.entries) {
      if (entry.expiresAt <= now) this.deleteEntry(token, entry, "expired");
    }
    for (const [handle, locator] of this.locators) {
      if (locator.expiresAt <= now) this.locators.delete(handle);
    }
    for (const [proposalId, proposal] of this.proposals) {
      if (proposal.expiresAt <= now) this.proposals.delete(proposalId);
    }
  }

  private deleteEntry(
    token: string,
    entry: LiveMiniAppSessionEntry,
    reason: "expired" | "revoked" = "revoked",
  ): boolean {
    // The lifecycle callback must run while the exact session id still has
    // its proposal lineage. It only resolves an existing Task binding; it
    // never receives token, path, document bytes, or write authority.
    if (reason === "expired") this.expiryObserver?.(entry.sessionId);
    liveAppCommandBroker.close(entry.sessionId);
    const deleted = this.entries.delete(token);
    if (deleted) {
      for (const [handle, locator] of this.locators) {
        if (locator.sessionId === entry.sessionId) this.locators.delete(handle);
      }
      for (const [proposalId, proposal] of this.proposals) {
        if (proposal.sessionId === entry.sessionId) this.proposals.delete(proposalId);
      }
    }
    return deleted;
  }

  private getOpenEntry(token: string): LiveMiniAppSessionEntry | null {
    if (typeof token !== "string" || token.length < 32) return null;
    const entry = this.entries.get(token);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.deleteEntry(token, entry, "expired");
      return null;
    }
    return entry;
  }
}

export const liveMiniAppSessionRegistry = new LiveMiniAppSessionRegistry();
