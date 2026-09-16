import type {
  TaskCreationLiveMiniAppContext,
  TaskCreationReturnContext,
  TaskReportBackContinuation,
} from "@nautilo/agent";
import {
  WRITER_REVIEW_ACCEPTED_RECEIPT_METADATA_KEY,
  type WriterReviewAwaitingMarker,
} from "@nautilo/db";
import {
  liveDocumentVersionEquals,
  type LiveDocumentReadCoverageFact,
  type LiveDocumentTableReadCursor,
  type TrustedLiveMiniAppSessionContext,
} from "@nautilo/types";
import type { RelayCapabilities } from "@nautilo/relay";

const MAX_LIVE_TASK_RETURN_BINDINGS = 1_000;
const MAX_LIVE_TASK_RETURN_BINDING_AGE_MS = 24 * 60 * 60 * 1_000;
export const LIVE_MINI_APP_TASK_DELEGATION_METADATA_KEY = "liveMiniAppTaskDelegation";

/** Durable intent only — no session token, path, or document data. */
export type LiveMiniAppTaskDelegationIntent = Readonly<{
  version: 1;
  appId: string;
}>;

export function parseLiveMiniAppTaskDelegationIntent(
  metadata: Record<string, unknown>,
): LiveMiniAppTaskDelegationIntent | null {
  const value = metadata[LIVE_MINI_APP_TASK_DELEGATION_METADATA_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  return candidate["version"] === 1
    && typeof candidate["appId"] === "string"
    && candidate["appId"].length > 0
    && candidate["appId"].length <= 128
    ? Object.freeze({ version: 1, appId: candidate["appId"] })
    : null;
}

/**
 * Recognize only the compact database-owned receipt that proves a prior run of
 * this same Task reached an accepted canonical Writer save. The caller gets a
 * boolean continuation fact, never the receipt identities or result revision.
 */
export function hasWriterReviewAcceptedContinuation(
  metadata: Record<string, unknown>,
): boolean {
  const value = metadata[WRITER_REVIEW_ACCEPTED_RECEIPT_METADATA_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<WriterReviewAwaitingMarker>;
  return candidate.version === 1
    && typeof candidate.taskRunId === "string"
    && candidate.taskRunId.length > 0
    && typeof candidate.proposalId === "string"
    && candidate.proposalId.length > 0
    && Object.prototype.hasOwnProperty.call(candidate, "acceptedResultRevision")
    && !Object.prototype.hasOwnProperty.call(candidate, "verificationRunId");
}

type RelayView = {
  getUserId(relayId: string): string | null;
  getRelaySessionId(relayId: string): string | null;
  getDesktopSessionId(relayId: string): string | null;
  getPairingGeneration(relayId: string): string | null;
  getCapabilities(relayId: string): RelayCapabilities | null;
  isRelayHeartbeatFresh(relayId: string, now?: number): boolean;
};

type LiveTaskReturnBinding = Readonly<{
  taskId: string;
  ownerId: string;
  relayId: string;
  relaySessionId: string;
  desktopSessionId: string;
  pairingGeneration: string;
  currentFolder: string;
  workspacePath: string;
  browserSessionId?: string;
  capturedAt: number;
}>;

const bindings = new Map<string, LiveTaskReturnBinding>();

export type TaskReturnBindingRegistrationFailure =
  | "context_unavailable"
  | "capacity_exhausted"
  | "relay_stale"
  | "relay_owner_mismatch"
  | "desktop_session_mismatch"
  | "pairing_generation_mismatch"
  | "relay_session_mismatch"
  | "relay_capabilities_missing"
  | "current_folder_mismatch"
  | "workspace_mismatch"
  | "browser_session_mismatch";

type LiveMiniAppBinding = Readonly<{
  taskId: string;
  ownerId: string;
  context: TaskCreationLiveMiniAppContext;
  /**
   * Process-local cold-start exposure selected by server admission. This is
   * not a capability and is never copied into Task, Job, or checkpoint data.
   */
  initialActivatedToolNames: readonly string[];
  /** Server-owned synchronous validation over the live session registry. */
  validate: () => TrustedLiveMiniAppSessionContext | null;
  /**
   * Ephemeral, non-authorizing proof for the one post-acceptance verifier.
   * It intentionally lives beside the existing live binding, never in a Task,
   * TaskRun, checkpoint, receipt, or document mutation.
   */
  verificationCoverage?: TaskWriterVerificationCoverage;
  capturedAt: number;
}>;

const liveMiniAppBindings = new Map<string, LiveMiniAppBinding>();

type TablePageCoverage = Readonly<{
  tableBlockIndex: number;
  cursor: LiveDocumentTableReadCursor;
  nextCursor: LiveDocumentTableReadCursor | null;
}>;

type TaskWriterVerificationCoverage = Readonly<{
  taskRunId: string;
  ownerId: string;
  documentVersion: TrustedLiveMiniAppSessionContext["documentVersion"];
  blockCount: number | null;
  blockIndexes: readonly number[];
  tablePages: readonly TablePageCoverage[];
}>;

export type TaskWriterVerificationCoverageState =
  | "not_verification"
  | "incomplete"
  | "complete";

export type TaskWriterReviewResolution =
  | Readonly<{
      outcome: "accepted";
      documentVersion: TrustedLiveMiniAppSessionContext["documentVersion"];
    }>
  | Readonly<{ outcome: "rejected" }>
  | Readonly<{ outcome: "failed"; code: string }>;

export type TaskWriterReviewBinding = Readonly<{
  taskId: string;
  taskRunId: string;
  ownerId: string;
  sessionId: string;
  proposalId: string;
  documentVersion: TrustedLiveMiniAppSessionContext["documentVersion"];
  modelFinished: boolean;
  /** Exact canonical accepted-write is in flight; Stop must not win mid-save. */
  acceptanceClaimed: boolean;
  resolution: TaskWriterReviewResolution | null;
  /** A resolved, model-finished review whose durable finalizer still needs a retry. */
  finalizationPending: boolean;
}>;

const writerReviewBindings = new Map<string, TaskWriterReviewBinding>();
const writerReviewTaskIdByProposalId = new Map<string, string>();
type WriterReviewInvalidation = Readonly<{
  taskId: string;
  taskRunId: string;
  ownerId: string;
  sessionId: string;
  proposalId: string;
  documentVersion: TrustedLiveMiniAppSessionContext["documentVersion"];
  invalidatedAt: number;
}>;
const invalidatedWriterReviewsByProposalId = new Map<string, WriterReviewInvalidation>();

function rememberWriterReviewInvalidation(binding: TaskWriterReviewBinding): void {
  if (
    !invalidatedWriterReviewsByProposalId.has(binding.proposalId)
    && invalidatedWriterReviewsByProposalId.size >= MAX_LIVE_TASK_RETURN_BINDINGS
  ) {
    const oldest = invalidatedWriterReviewsByProposalId.keys().next().value;
    if (oldest !== undefined) invalidatedWriterReviewsByProposalId.delete(oldest);
  }
  invalidatedWriterReviewsByProposalId.set(binding.proposalId, Object.freeze({
    taskId: binding.taskId,
    taskRunId: binding.taskRunId,
    ownerId: binding.ownerId,
    sessionId: binding.sessionId,
    proposalId: binding.proposalId,
    documentVersion: binding.documentVersion,
    invalidatedAt: Date.now(),
  }));
}

function deleteWriterReviewBinding(taskId: string): void {
  const binding = writerReviewBindings.get(taskId);
  if (binding?.acceptanceClaimed) return;
  if (binding) {
    writerReviewTaskIdByProposalId.delete(binding.proposalId);
    rememberWriterReviewInvalidation(binding);
  }
  writerReviewBindings.delete(taskId);
}

function sameTableCursor(
  a: LiveDocumentTableReadCursor,
  b: LiveDocumentTableReadCursor,
): boolean {
  return a.rowIndex === b.rowIndex && a.colIndex === b.colIndex &&
    a.blockIndex === b.blockIndex && a.sliceIndex === b.sliceIndex;
}

function validTableCursor(value: LiveDocumentTableReadCursor): boolean {
  return [value.rowIndex, value.colIndex, value.blockIndex, value.sliceIndex]
    .every((part) => Number.isSafeInteger(part) && part >= 0);
}

function coverageIsComplete(coverage: TaskWriterVerificationCoverage): boolean {
  if (coverage.blockCount === null) return false;
  const coveredBlocks = new Set(coverage.blockIndexes);
  const pagesByTable = new Map<number, TablePageCoverage[]>();
  for (const page of coverage.tablePages) {
    const pages = pagesByTable.get(page.tableBlockIndex) ?? [];
    pages.push(page);
    pagesByTable.set(page.tableBlockIndex, pages);
  }
  const start: LiveDocumentTableReadCursor = { rowIndex: 0, colIndex: 0, blockIndex: 0, sliceIndex: 0 };
  for (let index = 0; index < coverage.blockCount; index++) {
    const pages = pagesByTable.get(index);
    if (!pages) {
      if (!coveredBlocks.has(index)) return false;
      continue;
    }
    let cursor = start;
    const visited = new Set<string>();
    for (;;) {
      const page = pages.find((candidate) => sameTableCursor(candidate.cursor, cursor));
      if (!page) return false;
      const key = `${cursor.rowIndex}:${cursor.colIndex}:${cursor.blockIndex}:${cursor.sliceIndex}`;
      if (visited.has(key)) return false;
      visited.add(key);
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
  }
  return true;
}

function liveTaskBindingCount(): number {
  return new Set([...bindings.keys(), ...liveMiniAppBindings.keys()]).size;
}

function pruneExpired(now: number): void {
  for (const [taskId, binding] of bindings) {
    if (now - binding.capturedAt > MAX_LIVE_TASK_RETURN_BINDING_AGE_MS) {
      bindings.delete(taskId);
    }
  }
  for (const [taskId, binding] of liveMiniAppBindings) {
    if (now - binding.capturedAt > MAX_LIVE_TASK_RETURN_BINDING_AGE_MS) {
      liveMiniAppBindings.delete(taskId);
      deleteWriterReviewBinding(taskId);
    }
  }
  for (const [proposalId, invalidation] of invalidatedWriterReviewsByProposalId) {
    if (now - invalidation.invalidatedAt > MAX_LIVE_TASK_RETURN_BINDING_AGE_MS) {
      invalidatedWriterReviewsByProposalId.delete(proposalId);
    }
  }
}

/**
 * Registers a live Writer session only after durable Task creation.  The raw
 * session and validation closure remain process-local and are never copied to
 * Task/Job/checkpoint data.
 */
export function registerTaskLiveMiniAppBinding(
  taskId: string,
  context: TaskCreationLiveMiniAppContext | null,
  validate: (() => TrustedLiveMiniAppSessionContext | null) | null,
  options: Readonly<{
    /** Exact server-admitted live tool names to expose on the first model step. */
    initialActivatedToolNames?: readonly string[];
    now?: number;
  }> = {},
): boolean {
  const now = options.now ?? Date.now();
  pruneExpired(now);
  const appId = context?.liveMiniAppSession.appId;
  if (
    !context ||
    !validate ||
    !taskId ||
    (!liveMiniAppBindings.has(taskId) &&
      !bindings.has(taskId) &&
      liveTaskBindingCount() >= MAX_LIVE_TASK_RETURN_BINDINGS)
  ) {
    return false;
  }
  const validated = validate();
  if (
    !validated ||
    !appId ||
    context.activeMiniApp.appId !== appId ||
    validated.sessionToken !== context.liveMiniAppSession.sessionToken ||
    validated.sessionId !== context.liveMiniAppSession.sessionId ||
    validated.appId !== appId ||
    !liveDocumentVersionEquals(
      validated.documentVersion,
      context.liveMiniAppSession.documentVersion,
    )
  ) return false;
  const initialActivatedToolNames = Object.freeze([
    ...new Set((options.initialActivatedToolNames ?? []).filter((name) => name.length > 0)),
  ]);
  liveMiniAppBindings.set(taskId, Object.freeze({
    taskId,
    ownerId: context.ownerId,
    context,
    initialActivatedToolNames,
    validate,
    capturedAt: now,
  }));
  return true;
}

export type TaskLiveMiniAppBindingResolution =
  | {
      status: "available";
      context: TaskCreationLiveMiniAppContext;
      /** Present only for a server-admitted cold-start exposure seed. */
      initialActivatedToolNames?: readonly string[];
    }
  | { status: "not_captured" | "session_unavailable" };

/** Revalidate immediately before graph/provider work; never recover from a checkpoint. */
export function resolveTaskLiveMiniAppBinding(
  taskId: string,
  ownerId: string,
  now = Date.now(),
): TaskLiveMiniAppBindingResolution {
  pruneExpired(now);
  const binding = liveMiniAppBindings.get(taskId);
  if (!binding) return Object.freeze({ status: "not_captured" });
  if (binding.ownerId !== ownerId) return Object.freeze({ status: "session_unavailable" });
  let validated: TrustedLiveMiniAppSessionContext | null = null;
  try {
    validated = binding.validate();
  } catch {
    return Object.freeze({ status: "session_unavailable" });
  }
  if (
    !validated ||
    binding.context.activeMiniApp.appId !== binding.context.liveMiniAppSession.appId ||
    validated.sessionToken !== binding.context.liveMiniAppSession.sessionToken ||
    validated.sessionId !== binding.context.liveMiniAppSession.sessionId ||
    validated.appId !== binding.context.liveMiniAppSession.appId ||
    !liveDocumentVersionEquals(
      validated.documentVersion,
      binding.context.liveMiniAppSession.documentVersion,
    )
  ) return Object.freeze({ status: "session_unavailable" });
  return Object.freeze({
    status: "available",
    context: binding.context,
    ...(binding.initialActivatedToolNames.length > 0
      ? { initialActivatedToolNames: binding.initialActivatedToolNames }
      : {}),
  });
}

/**
 * Advance one Task's existing process-local live-session fence after the
 * server has canonically committed an accepted Writer proposal. The validator
 * must already observe the resulting version; no token, path, or authority is
 * accepted from durable Task state or from the model.
 */
export function advanceTaskLiveMiniAppBindingDocumentVersion(input: {
  taskId: string;
  ownerId: string;
  sessionId: string;
  previousDocumentVersion: TrustedLiveMiniAppSessionContext["documentVersion"];
  resultDocumentVersion: TrustedLiveMiniAppSessionContext["documentVersion"];
}, now = Date.now()): boolean {
  pruneExpired(now);
  const binding = liveMiniAppBindings.get(input.taskId);
  if (
    !binding ||
    binding.ownerId !== input.ownerId ||
    binding.context.liveMiniAppSession.sessionId !== input.sessionId ||
    (!liveDocumentVersionEquals(
      binding.context.liveMiniAppSession.documentVersion,
      input.previousDocumentVersion,
    ) && !liveDocumentVersionEquals(
      binding.context.liveMiniAppSession.documentVersion,
      input.resultDocumentVersion,
    ))
  ) return false;

  let validated: TrustedLiveMiniAppSessionContext | null = null;
  try {
    validated = binding.validate();
  } catch {
    return false;
  }
  const previous = binding.context.liveMiniAppSession;
  if (
    !validated ||
    validated.sessionToken !== previous.sessionToken ||
    validated.sessionId !== previous.sessionId ||
    validated.appId !== previous.appId ||
    !liveDocumentVersionEquals(
      validated.documentVersion,
      input.resultDocumentVersion,
    )
  ) return false;

  if (liveDocumentVersionEquals(previous.documentVersion, input.resultDocumentVersion)) {
    return true;
  }

  const context = Object.freeze({
    ...binding.context,
    liveMiniAppSession: Object.freeze({
      ...previous,
      documentVersion: Object.freeze(structuredClone(input.resultDocumentVersion)),
    }),
  });
  const { verificationCoverage: _priorCoverage, ...bindingWithoutCoverage } = binding;
  liveMiniAppBindings.set(input.taskId, Object.freeze({
    ...bindingWithoutCoverage,
    context,
    capturedAt: now,
  }));
  return true;
}

/**
 * Mark one admitted live Writer TaskRun for structural canonical-read
 * coverage. Accepted-save verification is one caller, but an initial run that
 * would otherwise report no review also has to prove the document it claims is
 * complete. The evidence remains entirely process-local with the existing
 * binding.
 */
export function beginTaskWriterReviewVerification(input: {
  taskId: string;
  taskRunId: string;
  ownerId: string;
}): boolean {
  const binding = liveMiniAppBindings.get(input.taskId);
  if (!binding || binding.ownerId !== input.ownerId || !input.taskRunId) return false;
  const current = binding.context.liveMiniAppSession.documentVersion;
  const existing = binding.verificationCoverage;
  if (
    existing &&
    existing.taskRunId === input.taskRunId &&
    existing.ownerId === input.ownerId &&
    liveDocumentVersionEquals(existing.documentVersion, current)
  ) return true;
  liveMiniAppBindings.set(input.taskId, Object.freeze({
    ...binding,
    verificationCoverage: Object.freeze({
      taskRunId: input.taskRunId,
      ownerId: input.ownerId,
      documentVersion: structuredClone(current),
      blockCount: null,
      blockIndexes: Object.freeze([]),
      tablePages: Object.freeze([]),
    }),
  }));
  return true;
}

/**
 * Record one app-classified read only for the exact live verification run and
 * version. A model cannot manufacture coverage: the caller receives a fact
 * only from the trusted first-party extension after canonical read success.
 */
export function recordTaskWriterReviewReadCoverage(input: {
  taskId: string;
  taskRunId: string;
  ownerId: string;
  coverage: LiveDocumentReadCoverageFact;
}): boolean {
  const binding = liveMiniAppBindings.get(input.taskId);
  const existing = binding?.verificationCoverage;
  if (
    !binding || !existing ||
    binding.ownerId !== input.ownerId ||
    existing.ownerId !== input.ownerId ||
    existing.taskRunId !== input.taskRunId ||
    !liveDocumentVersionEquals(existing.documentVersion, input.coverage.documentVersion) ||
    !liveDocumentVersionEquals(binding.context.liveMiniAppSession.documentVersion, input.coverage.documentVersion) ||
    !Number.isSafeInteger(input.coverage.blockCount) || input.coverage.blockCount < 0 ||
    (existing.blockCount !== null && existing.blockCount !== input.coverage.blockCount)
  ) return false;

  let blockIndexes = existing.blockIndexes;
  let tablePages = existing.tablePages;
  if (input.coverage.kind === "block_range") {
    if (
      input.coverage.blockIndexes.length === 0 ||
      input.coverage.blockIndexes.some((index) =>
        !Number.isSafeInteger(index) || index < 0 || index >= input.coverage.blockCount,
      )
    ) return false;
    blockIndexes = Object.freeze([
      ...new Set([...existing.blockIndexes, ...input.coverage.blockIndexes]),
    ].sort((a, b) => a - b));
  } else {
    const tableCoverage = input.coverage;
    if (
      !Number.isSafeInteger(tableCoverage.tableBlockIndex) ||
      tableCoverage.tableBlockIndex < 0 ||
      tableCoverage.tableBlockIndex >= tableCoverage.blockCount ||
      !validTableCursor(tableCoverage.cursor) ||
      (tableCoverage.nextCursor !== null && !validTableCursor(tableCoverage.nextCursor))
    ) return false;
    const samePage = (page: TablePageCoverage) =>
      page.tableBlockIndex === tableCoverage.tableBlockIndex &&
      sameTableCursor(page.cursor, tableCoverage.cursor);
    const prior = existing.tablePages.find(samePage);
    if (prior) {
      const sameNext = prior.nextCursor === null
        ? tableCoverage.nextCursor === null
        : tableCoverage.nextCursor !== null && sameTableCursor(prior.nextCursor, tableCoverage.nextCursor);
      if (!sameNext) return false;
    } else {
      tablePages = Object.freeze([
        ...existing.tablePages,
        Object.freeze({
          tableBlockIndex: tableCoverage.tableBlockIndex,
          cursor: structuredClone(tableCoverage.cursor),
          nextCursor: tableCoverage.nextCursor === null ? null : structuredClone(tableCoverage.nextCursor),
        }),
      ]);
    }
  }
  liveMiniAppBindings.set(input.taskId, Object.freeze({
    ...binding,
    verificationCoverage: Object.freeze({
      ...existing,
      blockCount: input.coverage.blockCount,
      blockIndexes,
      tablePages,
    }),
  }));
  return true;
}

/** Fail closed before ordinary Task success unless this exact verifier read all canonical structure. */
export function taskWriterReviewVerificationCoverageState(input: {
  taskId: string;
  taskRunId: string;
  ownerId: string;
}): TaskWriterVerificationCoverageState {
  const coverage = liveMiniAppBindings.get(input.taskId)?.verificationCoverage;
  if (!coverage || coverage.taskRunId !== input.taskRunId || coverage.ownerId !== input.ownerId) {
    return "not_verification";
  }
  return coverageIsComplete(coverage) ? "complete" : "incomplete";
}

/**
 * Associate the newest live Writer proposal with the exact server-authored
 * TaskRun that produced it.  The proposal identity is non-authorizing; the raw
 * session capability remains solely in `liveMiniAppBindings`.
 */
export function registerTaskWriterReviewProposal(input: {
  taskId: string;
  taskRunId: string;
  ownerId: string;
  sessionId: string;
  proposalId: string;
  documentVersion: TrustedLiveMiniAppSessionContext["documentVersion"];
}): boolean {
  const live = liveMiniAppBindings.get(input.taskId);
  if (
    !live ||
    !input.taskRunId ||
    !input.proposalId ||
    live.context.activeMiniApp.appId !== live.context.liveMiniAppSession.appId ||
    live.ownerId !== input.ownerId ||
    live.context.liveMiniAppSession.sessionId !== input.sessionId ||
    !liveDocumentVersionEquals(
      live.context.liveMiniAppSession.documentVersion,
      input.documentVersion,
    )
  ) return false;
  if (writerReviewBindings.get(input.taskId)?.acceptanceClaimed) return false;
  deleteWriterReviewBinding(input.taskId);
  const binding = Object.freeze({
    ...input,
    documentVersion: structuredClone(input.documentVersion),
    modelFinished: false,
    acceptanceClaimed: false,
    resolution: null,
    finalizationPending: false,
  });
  writerReviewBindings.set(input.taskId, binding);
  writerReviewTaskIdByProposalId.set(input.proposalId, input.taskId);
  return true;
}

/** Return the exact non-authorizing Writer review binding for a Stop callback. */
export function getTaskWriterReviewBinding(taskId: string): TaskWriterReviewBinding | null {
  return writerReviewBindings.get(taskId) ?? null;
}

/** Read-only classification used by host reconciliation; no authority leaves runtime. */
export function taskWriterReviewProposalState(input: {
  ownerId: string;
  sessionId: string;
  proposalId: string;
  documentVersion: TrustedLiveMiniAppSessionContext["documentVersion"];
}): "pending" | "closed" | "not_task" {
  const taskId = writerReviewTaskIdByProposalId.get(input.proposalId);
  if (taskId) {
    const binding = writerReviewBindings.get(taskId);
    if (!binding) return "closed";
    const exact = binding.ownerId === input.ownerId && binding.sessionId === input.sessionId &&
      liveDocumentVersionEquals(binding.documentVersion, input.documentVersion);
    // A proposal id already owned by a Task never falls back to foreground
    // replay when its authority tuple disagrees. Treat the mismatch as closed.
    if (!exact) return "closed";
    return binding.resolution === null ? "pending" : "closed";
  }
  const invalidation = invalidatedWriterReviewsByProposalId.get(input.proposalId);
  if (!invalidation) return "not_task";
  // Tombstones are Task lineage too. Exact and mismatched lookups both stay
  // closed; the caller receives classification only, never identity detail.
  return "closed";
}

/** Mark the model leg finished and return the exact proposal state atomically. */
export function finishTaskWriterReviewModel(
  taskId: string,
  taskRunId: string,
): TaskWriterReviewBinding | null {
  const binding = writerReviewBindings.get(taskId);
  if (!binding || binding.taskRunId !== taskRunId) return null;
  const finished = Object.freeze({ ...binding, modelFinished: true });
  writerReviewBindings.set(taskId, finished);
  return finished;
}

/**
 * Process-local recovery projection for the ordinary TaskObserver tick. It
 * exposes no session authority and deliberately excludes Human-unresolved
 * reviews; only a resolved review whose model leg has ended may be retried.
 */
export function pendingTaskWriterReviewFinalizations(): readonly TaskWriterReviewBinding[] {
  pruneExpired(Date.now());
  return Object.freeze(
    [...writerReviewBindings.values()].filter(
      (binding) => binding.modelFinished && binding.resolution !== null && binding.finalizationPending,
    ),
  );
}

/** Mark only the exact resolved binding complete after its idempotent DB finalizer succeeds. */
export function completeTaskWriterReviewFinalization(expected: TaskWriterReviewBinding): boolean {
  const current = writerReviewBindings.get(expected.taskId);
  if (
    !current ||
    !current.finalizationPending ||
    current.taskRunId !== expected.taskRunId ||
    current.ownerId !== expected.ownerId ||
    current.sessionId !== expected.sessionId ||
    current.proposalId !== expected.proposalId ||
    !liveDocumentVersionEquals(current.documentVersion, expected.documentVersion) ||
    JSON.stringify(current.resolution) !== JSON.stringify(expected.resolution)
  ) return false;
  writerReviewBindings.set(current.taskId, Object.freeze({ ...current, finalizationPending: false }));
  return true;
}

export type ResolveTaskWriterReviewResult =
  | { status: "not_found" }
  | { status: "conflict" }
  | { status: "resolved"; binding: TaskWriterReviewBinding; finalizeNow: boolean };

export type TaskWriterReviewAdmission =
  | { status: "not_task" }
  | { status: "pending"; binding: TaskWriterReviewBinding }
  | { status: "invalidated"; taskId: string; taskRunId: string };

/**
 * Distinguish an ordinary foreground proposal from a Task-owned proposal that
 * lost lifecycle authority (Stop, replacement, terminal cleanup). The server
 * checks this before applying an accepted write; tombstones are bounded to the
 * same short lifetime as process-local live bindings.
 */
export function claimTaskWriterReviewAcceptance(input: {
  ownerId: string;
  sessionId: string;
  proposalId: string;
  documentVersion: TrustedLiveMiniAppSessionContext["documentVersion"];
}): TaskWriterReviewAdmission {
  pruneExpired(Date.now());
  const taskId = writerReviewTaskIdByProposalId.get(input.proposalId);
  const binding = taskId ? writerReviewBindings.get(taskId) : undefined;
  if (binding) {
    const exact = binding.ownerId === input.ownerId
      && binding.sessionId === input.sessionId
      && liveDocumentVersionEquals(binding.documentVersion, input.documentVersion);
    if (!exact) return { status: "not_task" };
    if (binding.resolution && binding.resolution.outcome !== "accepted") {
      return { status: "invalidated", taskId: binding.taskId, taskRunId: binding.taskRunId };
    }
    if (!binding.acceptanceClaimed) {
      const claimed = Object.freeze({ ...binding, acceptanceClaimed: true });
      writerReviewBindings.set(binding.taskId, claimed);
      return { status: "pending", binding: claimed };
    }
    return { status: "pending", binding };
  }
  const invalidation = invalidatedWriterReviewsByProposalId.get(input.proposalId);
  return invalidation
    && invalidation.ownerId === input.ownerId
    && invalidation.sessionId === input.sessionId
    && liveDocumentVersionEquals(invalidation.documentVersion, input.documentVersion)
    ? { status: "invalidated", taskId: invalidation.taskId, taskRunId: invalidation.taskRunId }
    : { status: "not_task" };
}

/** Release only the exact unresolved acceptance claim after canonical save failure. */
export function releaseTaskWriterReviewAcceptanceClaim(input: {
  ownerId: string;
  sessionId: string;
  proposalId: string;
  documentVersion: TrustedLiveMiniAppSessionContext["documentVersion"];
}): boolean {
  const taskId = writerReviewTaskIdByProposalId.get(input.proposalId);
  const binding = taskId ? writerReviewBindings.get(taskId) : undefined;
  if (
    !binding
    || !binding.acceptanceClaimed
    || binding.resolution !== null
    || binding.ownerId !== input.ownerId
    || binding.sessionId !== input.sessionId
    || !liveDocumentVersionEquals(binding.documentVersion, input.documentVersion)
  ) return false;
  writerReviewBindings.set(binding.taskId, Object.freeze({ ...binding, acceptanceClaimed: false }));
  return true;
}

/** Lifecycle Stop uses this to avoid invalidating an accepted write in flight. */
export function hasTaskWriterReviewAcceptanceClaim(taskId: string): boolean {
  return writerReviewBindings.get(taskId)?.acceptanceClaimed === true;
}

/** Exact Task-run ownership check for child-creation guards; no authority is exposed. */
export function hasTaskWriterReviewBindingForTaskRun(input: {
  taskId: string;
  taskRunId: string;
  ownerId: string;
}): boolean {
  const binding = writerReviewBindings.get(input.taskId);
  return Boolean(
    binding
    && binding.taskRunId === input.taskRunId
    && binding.ownerId === input.ownerId,
  );
}

/**
 * Record one exact Writer review outcome. Duplicate identical delivery is
 * idempotent; a different outcome or version for the same proposal fails
 * closed. The caller finalizes immediately only after the model leg ended.
 */
export function resolveTaskWriterReviewProposal(input: {
  ownerId: string;
  sessionId: string;
  proposalId: string;
  documentVersion: TrustedLiveMiniAppSessionContext["documentVersion"];
  resolution: TaskWriterReviewResolution;
}): ResolveTaskWriterReviewResult {
  const taskId = writerReviewTaskIdByProposalId.get(input.proposalId);
  const binding = taskId ? writerReviewBindings.get(taskId) : undefined;
  if (!binding) return { status: "not_found" };
  if (
    binding.ownerId !== input.ownerId ||
    binding.sessionId !== input.sessionId ||
    !liveDocumentVersionEquals(binding.documentVersion, input.documentVersion)
  ) return { status: "conflict" };
  if (binding.acceptanceClaimed && input.resolution.outcome !== "accepted") {
    return { status: "conflict" };
  }
  if (binding.resolution) {
    if (JSON.stringify(binding.resolution) !== JSON.stringify(input.resolution)) {
      return { status: "conflict" };
    }
    return { status: "resolved", binding, finalizeNow: binding.modelFinished };
  }
  const resolved = Object.freeze({
    ...binding,
    acceptanceClaimed: false,
    resolution: input.resolution,
    finalizationPending: true,
  });
  writerReviewBindings.set(binding.taskId, resolved);
  return { status: "resolved", binding: resolved, finalizeNow: resolved.modelFinished };
}

/**
 * Fail only the exact Task-owned continuation after the canonical write won
 * but the server could not advance its process-local live-session fence. This
 * is intentionally separate from Human reject/session-close resolution: an
 * accepted write claim may be released only by this server-owned failure path.
 */
export function failTaskWriterReviewAcceptedContinuation(
  expected: TaskWriterReviewBinding,
  code: "LIVE_WRITER_VERIFICATION_SESSION_UNAVAILABLE",
): ResolveTaskWriterReviewResult {
  const binding = writerReviewBindings.get(expected.taskId);
  if (!binding) return { status: "not_found" };
  if (
    binding.taskRunId !== expected.taskRunId ||
    binding.ownerId !== expected.ownerId ||
    binding.sessionId !== expected.sessionId ||
    binding.proposalId !== expected.proposalId ||
    !liveDocumentVersionEquals(binding.documentVersion, expected.documentVersion)
  ) return { status: "conflict" };
  const resolution = Object.freeze({ outcome: "failed" as const, code });
  if (binding.resolution) {
    if (JSON.stringify(binding.resolution) !== JSON.stringify(resolution)) {
      return { status: "conflict" };
    }
    return { status: "resolved", binding, finalizeNow: binding.modelFinished };
  }
  const failed = Object.freeze({
    ...binding,
    acceptanceClaimed: false,
    resolution,
    finalizationPending: true,
  });
  writerReviewBindings.set(binding.taskId, failed);
  return { status: "resolved", binding: failed, finalizeNow: failed.modelFinished };
}

/** Server-side reconciliation predicate for the exact unresolved Task review. */
export function isPendingTaskWriterReviewProposal(input: {
  ownerId: string;
  sessionId: string;
  proposalId: string;
  documentVersion: TrustedLiveMiniAppSessionContext["documentVersion"];
}): boolean {
  const taskId = writerReviewTaskIdByProposalId.get(input.proposalId);
  const binding = taskId ? writerReviewBindings.get(taskId) : undefined;
  return Boolean(
    binding &&
    binding.resolution === null &&
    binding.ownerId === input.ownerId &&
    binding.sessionId === input.sessionId &&
    liveDocumentVersionEquals(binding.documentVersion, input.documentVersion),
  );
}

/** Return all exact proposals invalidated by one closing live session. */
export function failTaskWriterReviewsForSession(
  sessionId: string,
  code: string,
): TaskWriterReviewBinding[] {
  const resolved: TaskWriterReviewBinding[] = [];
  for (const [taskId, binding] of writerReviewBindings) {
    if (binding.sessionId !== sessionId || binding.resolution || binding.acceptanceClaimed) continue;
    const failed = Object.freeze({
      ...binding,
      resolution: Object.freeze({ outcome: "failed" as const, code }),
      finalizationPending: true,
    });
    writerReviewBindings.set(taskId, failed);
    if (failed.modelFinished) resolved.push(failed);
  }
  return resolved;
}

export function removeTaskWriterReviewBinding(taskId: string): void {
  deleteWriterReviewBinding(taskId);
}

/** Register only after the durable Task id exists; failure simply means cloud-only wake. */
export function registerTaskReturnBinding(
  taskId: string,
  context: TaskCreationReturnContext | null,
  relay: RelayView,
  now = Date.now(),
): boolean {
  pruneExpired(now);
  if (taskReturnBindingRegistrationFailure(taskId, context, relay, now) !== null) {
    return false;
  }
  // The diagnostic above proves context is present. Keep the narrowed alias so
  // the stored binding remains structurally identical to the pre-D574 shape.
  const captured = context!;
  const relaySessionId = relay.getRelaySessionId(captured.relayId)!;
  const browserSessionId = captured.browserSessionId;
  bindings.set(taskId, Object.freeze({
    taskId,
    ownerId: captured.ownerId,
    relayId: captured.relayId,
    relaySessionId,
    desktopSessionId: captured.desktopSessionId,
    pairingGeneration: captured.pairingGeneration,
    currentFolder: captured.currentFolder,
    workspacePath: captured.workspacePath,
    ...(browserSessionId === undefined ? {} : { browserSessionId }),
    capturedAt: now,
  }));
  return true;
}

/**
 * Content-free reason for a Task return-binding capture failure. This is
 * intentionally safe to log: it contains no ids, paths, sessions, or browser
 * state. It also keeps live acceptance diagnosable instead of collapsing every
 * failure into a misleading "select Current Folder" recovery.
 */
export function taskReturnBindingRegistrationFailure(
  taskId: string,
  context: TaskCreationReturnContext | null,
  relay: RelayView,
  now = Date.now(),
): TaskReturnBindingRegistrationFailure | null {
  if (!context || !taskId) return "context_unavailable";
  if (
    !bindings.has(taskId)
    && !liveMiniAppBindings.has(taskId)
    && liveTaskBindingCount() >= MAX_LIVE_TASK_RETURN_BINDINGS
  ) return "capacity_exhausted";
  if (!relay.isRelayHeartbeatFresh(context.relayId, now)) return "relay_stale";
  if (relay.getUserId(context.relayId) !== context.ownerId) return "relay_owner_mismatch";
  if (relay.getDesktopSessionId(context.relayId) !== context.desktopSessionId) {
    return "desktop_session_mismatch";
  }
  if (relay.getPairingGeneration(context.relayId) !== context.pairingGeneration) {
    return "pairing_generation_mismatch";
  }
  const relaySessionId = relay.getRelaySessionId(context.relayId);
  const capabilities = relay.getCapabilities(context.relayId);
  if (!relaySessionId || relaySessionId !== context.relaySessionId) {
    return "relay_session_mismatch";
  }
  if (!capabilities) return "relay_capabilities_missing";
  if (capabilities.currentFolderRoot !== context.currentFolder) {
    return "current_folder_mismatch";
  }
  if ((capabilities.workspaceRoot ?? "") !== context.workspacePath) {
    return "workspace_mismatch";
  }
  const browserSessionId = context.browserSessionId;
  if (
    browserSessionId !== undefined
    && (capabilities.canControlBrowser !== true
      || capabilities.browserSessionId !== browserSessionId)
  ) return "browser_session_mismatch";
  return null;
}

export function resolveTaskReturnBinding(
  taskId: string,
  ownerId: string,
  relay: RelayView | null,
  now = Date.now(),
): TaskReportBackContinuation {
  pruneExpired(now);
  const binding = bindings.get(taskId);
  if (!binding) return Object.freeze({ status: "not_captured" });
  if (!relay || !relay.isRelayHeartbeatFresh(binding.relayId, now)) {
    return Object.freeze({ status: "relay_disconnected" });
  }
  if (ownerId !== binding.ownerId || relay.getUserId(binding.relayId) !== binding.ownerId) {
    return Object.freeze({ status: "relay_owner_mismatch" });
  }
  if (
    relay.getRelaySessionId(binding.relayId) !== binding.relaySessionId ||
    relay.getDesktopSessionId(binding.relayId) !== binding.desktopSessionId ||
    relay.getPairingGeneration(binding.relayId) !== binding.pairingGeneration
  ) {
    return Object.freeze({ status: "relay_replaced" });
  }
  const capabilities = relay.getCapabilities(binding.relayId);
  if (!capabilities) return Object.freeze({ status: "relay_disconnected" });
  if (capabilities.currentFolderRoot !== binding.currentFolder) {
    return Object.freeze({ status: "folder_changed" });
  }
  if ((capabilities.workspaceRoot ?? "") !== binding.workspacePath) {
    return Object.freeze({ status: "folder_invalid" });
  }
  if (
    capabilities.canReadWorkspace !== true
    && capabilities.canRunShell !== true
    && capabilities.canUseTerminal !== true
    && capabilities.canControlBrowser !== true
  ) {
    return Object.freeze({ status: "capability_revoked" });
  }
  const browserStillExact = binding.browserSessionId === undefined
    || capabilities.browserSessionId === binding.browserSessionId;
  return Object.freeze({
    status: "available",
    browserStatus: binding.browserSessionId === undefined
      ? "not_captured"
      : browserStillExact
        ? "available"
        : "browser_session_expired",
    relayId: binding.relayId,
    relaySessionId: binding.relaySessionId,
    desktopSessionId: binding.desktopSessionId,
    pairingGeneration: binding.pairingGeneration,
    currentFolder: binding.currentFolder,
    workspacePath: binding.workspacePath,
    bindingCapturedAt: binding.capturedAt,
    ...(browserStillExact && binding.browserSessionId !== undefined
      ? { browserSessionId: binding.browserSessionId }
      : {}),
  });
}

/**
 * Resume only the original Desktop grant from an exact server-owned checkpoint.
 * The caller must first validate the current database Task/Run/thread and owner
 * admission. This helper repeats checkpoint identity checks and validates every
 * live binding field; only the authenticated socket generation may rotate.
 * It does not restore Writer, mini-app sessions, approvals, or capabilities.
 */
export function restoreTaskReturnBindingFromCheckpoint(input: {
  taskId: string;
  taskRunId: string;
  ownerId: string;
  graphThreadId: string;
  taskCreatedAt: Date;
  checkpointState: {
    taskRun: boolean;
    userId: string;
    currentTaskId: string;
    currentTaskRunId: string;
    langgraphThreadId: string;
    taskReportBackContinuation: TaskReportBackContinuation | null | undefined;
  };
}, relay: RelayView | null, now = Date.now()): TaskReportBackContinuation {
  const saved = input.checkpointState;
  const continuation = saved.taskReportBackContinuation;
  if (!saved.taskRun || !input.taskId || !input.taskRunId || !input.ownerId || !input.graphThreadId
    || saved.currentTaskId !== input.taskId || saved.currentTaskRunId !== input.taskRunId
    || saved.userId !== input.ownerId || saved.langgraphThreadId !== input.graphThreadId
    || continuation?.status !== "available" || !continuation.relayId
    || !continuation.relaySessionId || !continuation.desktopSessionId || !continuation.pairingGeneration
    || !continuation.currentFolder || typeof continuation.workspacePath !== "string") {
    return Object.freeze({ status: "not_captured" });
  }
  // Legacy checkpoints predate the capture timestamp. Task creation is a
  // conservative lower bound; neither restart nor Resume creates a new lease.
  const capturedAt = continuation.bindingCapturedAt ?? input.taskCreatedAt.getTime();
  if (!Number.isFinite(capturedAt) || capturedAt < 0 || capturedAt > now
    || now - capturedAt > MAX_LIVE_TASK_RETURN_BINDING_AGE_MS) {
    return Object.freeze({ status: "not_captured" });
  }
  if (!relay || !relay.isRelayHeartbeatFresh(continuation.relayId, now)) {
    return Object.freeze({ status: "relay_disconnected" });
  }
  if (relay.getUserId(continuation.relayId) !== input.ownerId) {
    return Object.freeze({ status: "relay_owner_mismatch" });
  }
  if (relay.getDesktopSessionId(continuation.relayId) !== continuation.desktopSessionId
    || relay.getPairingGeneration(continuation.relayId) !== continuation.pairingGeneration) {
    return Object.freeze({ status: "relay_replaced" });
  }
  const relaySessionId = relay.getRelaySessionId(continuation.relayId);
  const capabilities = relay.getCapabilities(continuation.relayId);
  if (!relaySessionId || !capabilities) return Object.freeze({ status: "relay_disconnected" });
  if (capabilities.currentFolderRoot !== continuation.currentFolder) return Object.freeze({ status: "folder_changed" });
  if ((capabilities.workspaceRoot ?? "") !== continuation.workspacePath) return Object.freeze({ status: "folder_invalid" });
  if (capabilities.canReadWorkspace !== true && capabilities.canRunShell !== true
    && capabilities.canUseTerminal !== true && capabilities.canControlBrowser !== true) {
    return Object.freeze({ status: "capability_revoked" });
  }
  pruneExpired(now);
  if (!bindings.has(input.taskId) && !liveMiniAppBindings.has(input.taskId)
    && liveTaskBindingCount() >= MAX_LIVE_TASK_RETURN_BINDINGS) return Object.freeze({ status: "not_captured" });
  bindings.set(input.taskId, Object.freeze({
    taskId: input.taskId, ownerId: input.ownerId, relayId: continuation.relayId,
    relaySessionId, desktopSessionId: continuation.desktopSessionId,
    pairingGeneration: continuation.pairingGeneration, currentFolder: continuation.currentFolder,
    workspacePath: continuation.workspacePath, capturedAt,
    ...(continuation.browserSessionId === undefined ? {} : { browserSessionId: continuation.browserSessionId }),
  }));
  return resolveTaskReturnBinding(input.taskId, input.ownerId, relay, now);
}

export function removeTaskReturnBinding(taskId: string): void {
  bindings.delete(taskId);
  liveMiniAppBindings.delete(taskId);
  deleteWriterReviewBinding(taskId);
}

/**
 * Report-back uses this only when its durable transition threw. Preserve an
 * already-resolved Writer review so the ordinary observer maintenance retry
 * can finish that exact transition; no relay or live-session authority stays.
 */
export function removeTaskReturnBindingPreservingResolvedWriterReview(taskId: string): void {
  bindings.delete(taskId);
  liveMiniAppBindings.delete(taskId);
  if (writerReviewBindings.get(taskId)?.resolution === null) {
    deleteWriterReviewBinding(taskId);
  }
}

export function removeTaskReturnBindingsForRelay(relayId: string): void {
  for (const [taskId, binding] of bindings) {
    if (binding.relayId === relayId) {
      bindings.delete(taskId);
      liveMiniAppBindings.delete(taskId);
      // A relay/session close may already have resolved this Writer review as
      // failed while its model leg is still winding down. Retain that compact,
      // non-authorizing resolution until `finishTaskWriterReviewModel` can
      // terminalize the exact TaskRun; deleting it here would strand the
      // durable awaiting marker after the relay disappears.
      if (writerReviewBindings.get(taskId)?.resolution === null) {
        deleteWriterReviewBinding(taskId);
      }
    }
  }
}

export function clearTaskReturnBindings(): void {
  bindings.clear();
  liveMiniAppBindings.clear();
  writerReviewBindings.clear();
  writerReviewTaskIdByProposalId.clear();
  invalidatedWriterReviewsByProposalId.clear();
}

export const taskReturnBindingRegistryForTests = Object.freeze({
  size: liveTaskBindingCount,
  clear: clearTaskReturnBindings,
  writerReviewSize: () => writerReviewBindings.size,
  invalidatedWriterReviewSize: () => invalidatedWriterReviewsByProposalId.size,
});
