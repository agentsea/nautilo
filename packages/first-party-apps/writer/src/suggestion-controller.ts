import type { Document } from "@nautilo/office-docs/node";
import type { LiveDocumentVersion } from "@nautilo/types";
import { liveDocumentVersionEquals } from "@nautilo/types";
import { applyDocumentOperations, type DocumentOperationMetadata } from "./document-ops";
import { validateEditOpenWriterRequest, type EditOpenWriterRequest, type ProposalValidationError } from "./proposal-contract";
import { executeProposalOperations } from "./proposal-execution";
import type { ResolvedProposalOperation } from "./proposal-resolver";
import { parseProposalIngressVersion } from "./live-document-version";
import { structuralDiff, type StructuralChange } from "./structural-diff";

export type SuggestionFailureReason =
  | "session_closed"
  | "stale_version"
  | "invalid_request"
  | "resolver_error"
  | "apply_error"
  | "persistence_error"
  | "human_changed"
  | "remote_changed";

export type SuggestionState =
  | { kind: "idle" }
  | { kind: "validating"; proposalId: string }
  | PendingSuggestionState
  | { kind: "accepting"; proposalId: string; pending: PendingSuggestionState }
  | { kind: "rejecting"; proposalId: string }
  | { kind: "completed"; proposalId: string; outcome: "accepted" | "rejected" }
  | { kind: "invalidated"; proposalId?: string; reason: SuggestionFailureReason }
  | { kind: "error"; proposalId?: string; reason: SuggestionFailureReason; message: string };

export type PendingSuggestionState = {
  kind: "pending";
  proposalId: string;
  documentVersion: LiveDocumentVersion;
  baseDoc: Document;
  /** Detached base used solely to render the unresolved redlines. */
  reviewBaseDoc: Document;
  proposedDoc: Document;
  request: EditOpenWriterRequest;
  operations: readonly ResolvedProposalOperation[];
  operationMetadata: readonly DocumentOperationMetadata[];
  changes: readonly StructuralChange[];
  selections: Readonly<Record<string, { selected: boolean; disabledReason?: string }>>;
  /** Operations already accepted into the detached review document, never canonical state. */
  acceptedOperationIndexes: readonly number[];
  /** Operations deliberately excluded from the eventual durable batch. */
  rejectedOperationIndexes: readonly number[];
  /**
   * Stable id for one local accepted-write attempt. Minted on first accept and
   * reused after an unknown/lost host response.
   */
  acceptRequestId?: string;
  /**
   * A failed batch leaves this detached review projection intact so the user
   * can retry the single atomic write without losing accepted work.
   */
  persistenceError?: string;
};

export type ProposalReception = {
  proposalId: string;
  sessionToken: string;
  documentVersion?: LiveDocumentVersion;
  /** Legacy Artifact-only ingress; mapped at the proposal boundary only. */
  baseRevision?: number;
  operations: unknown;
};

export type AcceptedSuggestionBatch = {
  proposalId: string;
  sessionToken: string;
  documentVersion: LiveDocumentVersion;
  requestId: string;
  baseDoc: Document;
  operations: readonly ResolvedProposalOperation[];
  /** Original proposal operation indexes selected for persistence. */
  acceptedOperationIndexes: readonly number[];
};

export type SuggestionControllerOptions = {
  onStateChange?: (state: SuggestionState) => void;
  createRequestId?: () => string;
};

/**
 * The surface applies this only after the controller has rebuilt its detached
 * review state. `nextChangeId` is consequently an ID from that rebuilt state,
 * never an ID predicted from stale projection geometry.
 */
export type ReviewActionResult = {
  state: SuggestionState;
  nextChangeId: string | null;
};

export function selectedSuggestionChanges(
  pending: PendingSuggestionState,
): readonly StructuralChange[] {
  return pending.changes.filter((change) => {
    const selection = pending.selections[change.id];
    return selection?.selected === true && !selection.disabledReason;
  });
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isProposal(value: ProposalReception): value is ProposalReception {
  return typeof value.proposalId === "string" && value.proposalId.length > 0;
}

function proposalDocumentVersion(proposal: ProposalReception): LiveDocumentVersion | null {
  if (proposal.documentVersion) return proposal.documentVersion;
  return parseProposalIngressVersion(proposal as unknown as Record<string, unknown>);
}

function selectedOperationIndexes(
  changes: readonly StructuralChange[],
  selections: Readonly<Record<string, { selected: boolean; disabledReason?: string }>>,
): Set<number> {
  const represented = new Set(changes.flatMap((change) => change.operationIndexes));
  return new Set([...represented].filter((operationIndex) => {
    const group = changes.filter((change) => change.operationIndexes.includes(operationIndex));
    return group.length > 0 && group.every((change) =>
      selections[change.id]?.selected === true && !selections[change.id]?.disabledReason,
    );
  }));
}

function groupedOperationIndexes(changes: readonly StructuralChange[], changeId: string): Set<number> {
  const indexes = new Set(changes.find((change) => change.id === changeId)?.operationIndexes ?? []);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const change of changes) {
      if (!change.operationIndexes.some((index) => indexes.has(index))) continue;
      for (const index of change.operationIndexes) {
        if (!indexes.has(index)) {
          indexes.add(index);
          expanded = true;
        }
      }
    }
  }
  return indexes;
}

function availableOperationIndexes(
  operations: readonly ResolvedProposalOperation[],
  accepted: ReadonlySet<number>,
  rejected: ReadonlySet<number>,
  dependencies: ReadonlyMap<number, ReadonlySet<number>>,
): Set<number> {
  const available = new Set<number>();
  for (let index = 0; index < operations.length; index++) {
    if (accepted.has(index) || rejected.has(index)) continue;
    if ([...(dependencies.get(index) ?? [])].some((predecessor) => rejected.has(predecessor))) continue;
    const hasRejectedPredecessor = operations.slice(0, index).some((operation, predecessor) =>
      rejected.has(predecessor) && operation.blockId === operations[index]?.blockId,
    );
    if (!hasRejectedPredecessor) available.add(index);
  }
  return available;
}

function operationDependencies(changes: readonly StructuralChange[]): Map<number, Set<number>> {
  const dependencies = new Map<number, Set<number>>();
  for (const change of changes) {
    if (!("dependencyOperationIndexes" in change)) continue;
    for (const index of change.operationIndexes) {
      const target = dependencies.get(index) ?? new Set<number>();
      for (const dependency of change.dependencyOperationIndexes) target.add(dependency);
      dependencies.set(index, target);
    }
  }
  return dependencies;
}

/** In-memory-only suggestion lifecycle. It never receives a writable DocStore. */
export class SuggestionController {
  private state: SuggestionState = { kind: "idle" };
  private readonly onStateChange?: (state: SuggestionState) => void;
  private readonly createRequestId: () => string;

  constructor(options: SuggestionControllerOptions = {}) {
    if (options.onStateChange !== undefined) {
      this.onStateChange = options.onStateChange;
    }
    this.createRequestId = options.createRequestId ?? (() => crypto.randomUUID());
  }

  getState(): SuggestionState {
    return this.state;
  }

  private setState(state: SuggestionState): void {
    this.state = state;
    this.onStateChange?.(state);
  }

  receive(
    proposal: ProposalReception,
    baseDoc: Document,
    documentVersion: LiveDocumentVersion,
  ): SuggestionState {
    if (!isProposal(proposal)) {
      this.setState({ kind: "error", reason: "invalid_request", message: "Proposal ID is invalid." });
      return this.state;
    }
    this.setState({ kind: "validating", proposalId: proposal.proposalId });
    const ingressVersion = proposalDocumentVersion(proposal);
    const validation = validateEditOpenWriterRequest({
      sessionToken: proposal.sessionToken,
      documentVersion: ingressVersion ?? documentVersion,
      operations: proposal.operations,
    });
    if (!validation.ok) return this.validationError(proposal.proposalId, validation);
    if (!liveDocumentVersionEquals(validation.request.documentVersion, documentVersion)) {
      this.setState({ kind: "invalidated", proposalId: proposal.proposalId, reason: "stale_version" });
      return this.state;
    }
    const immutableBase = clone(baseDoc);
    const execution = executeProposalOperations(immutableBase, validation.request.operations);
    if (!execution.ok) {
      const reason = execution.stage === "resolve" ? "resolver_error" : "apply_error";
      this.setState({ kind: "error", proposalId: proposal.proposalId, reason, message: execution.message });
      return this.state;
    }
    const changes = structuralDiff(immutableBase, execution.document, execution.metadata);
    const selections = Object.fromEntries(changes.map((change) => [change.id, { selected: true }]));
    this.setState({
      kind: "pending",
      proposalId: proposal.proposalId,
      documentVersion,
      baseDoc: immutableBase,
      reviewBaseDoc: clone(immutableBase),
      proposedDoc: clone(execution.document),
      request: validation.request,
      operations: clone(execution.operations),
      operationMetadata: clone(execution.metadata),
      changes,
      selections,
      acceptedOperationIndexes: [],
      rejectedOperationIndexes: [],
    });
    return this.state;
  }

  invalidate(reason: Extract<SuggestionFailureReason, "session_closed" | "stale_version" | "human_changed" | "remote_changed">): void {
    const proposalId = this.state.kind === "pending" || this.state.kind === "accepting"
      ? this.state.proposalId
      : undefined;
    this.setState({ kind: "invalidated", ...(proposalId ? { proposalId } : {}), reason });
  }

  beginReject(): string | null {
    if (this.state.kind !== "pending") return null;
    this.setState({ kind: "rejecting", proposalId: this.state.proposalId });
    return this.state.proposalId;
  }

  completeReject(proposalId: string): void {
    if (this.state.kind !== "rejecting" || this.state.proposalId !== proposalId) return;
    this.setState({ kind: "completed", proposalId, outcome: "rejected" });
  }

  failReject(proposalId: string, message: string): void {
    if (this.state.kind !== "rejecting" || this.state.proposalId !== proposalId) return;
    this.setState({ kind: "error", proposalId, reason: "persistence_error", message });
  }

  rejectAll(): void {
    const proposalId = this.beginReject();
    if (!proposalId) return;
    this.completeReject(proposalId);
  }

  rejectChange(changeId: string): SuggestionState {
    return this.setChangeSelected(changeId, false);
  }

  rejectChangeAndSelectNext(changeId: string): ReviewActionResult {
    return this.transitionReviewChange(changeId, () => this.rejectChange(changeId));
  }

  acceptAll(): AcceptedSuggestionBatch | null {
    if (this.state.kind !== "pending") return null;
    return this.beginAccept();
  }

  /**
   * Resolves one logical review action into the detached projection. Operations
   * shared by multiple visual spans move together, but canonical state is not
   * touched until beginAccept() returns the final batch.
   */
  acceptChangeForReview(changeId: string): SuggestionState {
    if (this.state.kind !== "pending") return this.state;
    const pending = this.state;
    const indexes = groupedOperationIndexes(pending.changes, changeId);
    if (indexes.size === 0) return this.state;
    const accepted = new Set(pending.acceptedOperationIndexes);
    for (const index of indexes) accepted.add(index);
    return this.rebuildPending(pending, accepted, new Set(pending.rejectedOperationIndexes));
  }

  acceptChangeAndSelectNext(changeId: string): ReviewActionResult {
    return this.transitionReviewChange(changeId, () => this.acceptChangeForReview(changeId));
  }

  /** P4 applies this returned, already dependency-filtered batch atomically. */
  beginAccept(): AcceptedSuggestionBatch | null {
    if (this.state.kind !== "pending") return null;
    const pending = this.state;
    const selectedIndexes = new Set(pending.acceptedOperationIndexes);
    for (const index of selectedOperationIndexes(pending.changes, pending.selections)) selectedIndexes.add(index);
    const acceptedOperationIndexes = [...selectedIndexes].sort((left, right) => left - right);
    const operations = pending.operations.filter((_, index) => selectedIndexes.has(index));
    if (operations.length === 0) return null;
    const requestId = pending.acceptRequestId ?? this.createRequestId();
    const nextPending = { ...pending, acceptRequestId: requestId };
    this.setState({ kind: "accepting", proposalId: pending.proposalId, pending: nextPending });
    return {
      proposalId: pending.proposalId,
      sessionToken: pending.request.sessionToken,
      documentVersion: pending.documentVersion,
      requestId,
      baseDoc: clone(pending.baseDoc),
      operations: clone(operations),
      acceptedOperationIndexes,
    };
  }

  completeAccept(proposalId: string): void {
    if (this.state.kind !== "accepting" || this.state.proposalId !== proposalId) return;
    this.setState({ kind: "completed", proposalId, outcome: "accepted" });
  }

  failAccept(proposalId: string, reason: Extract<SuggestionFailureReason, "apply_error" | "persistence_error">, message: string): void {
    if (this.state.kind !== "accepting" || this.state.proposalId !== proposalId) return;
    if (reason === "persistence_error") {
      this.setState({ ...this.state.pending, persistenceError: message });
      return;
    }
    this.setState({ kind: "error", proposalId, reason, message });
  }

  dismiss(): void {
    if (this.state.kind === "pending" || this.state.kind === "accepting" || this.state.kind === "rejecting") return;
    this.setState({ kind: "idle" });
  }

  setChangeSelected(changeId: string, selected: boolean): SuggestionState {
    if (this.state.kind !== "pending") return this.state;
    const pending = this.state;
    const indexes = groupedOperationIndexes(pending.changes, changeId);
    if (indexes.size === 0) return this.state;
    const rejected = new Set(pending.rejectedOperationIndexes);
    for (const index of indexes) {
      if (selected) rejected.delete(index);
      else rejected.add(index);
    }
    return this.rebuildPending(pending, new Set(pending.acceptedOperationIndexes), rejected);
  }

  private rebuildPending(
    pending: PendingSuggestionState,
    accepted: ReadonlySet<number>,
    rejected: ReadonlySet<number>,
  ): SuggestionState {
    const available = availableOperationIndexes(
      pending.operations,
      accepted,
      rejected,
      operationDependencies(pending.changes),
    );
    // Rejecting the final review item leaves no durable work to save. Complete
    // immediately so the canonical editor is restored instead of retaining an
    // empty detached review surface.
    if (available.size === 0 && accepted.size === 0) {
      this.setState({ kind: "completed", proposalId: pending.proposalId, outcome: "rejected" });
      return this.state;
    }
    const acceptedOperations = pending.operations.filter((_, index) => accepted.has(index));
    const proposedOperations = pending.operations.filter((_, index) => accepted.has(index) || available.has(index));
    const reviewBase = applyDocumentOperations(pending.baseDoc, acceptedOperations);
    const proposed = applyDocumentOperations(pending.baseDoc, proposedOperations);
    if (!reviewBase.ok) {
      this.setState({ kind: "error", proposalId: pending.proposalId, reason: "apply_error", message: reviewBase.message });
      return this.state;
    }
    if (!proposed.ok) {
      this.setState({ kind: "error", proposalId: pending.proposalId, reason: "apply_error", message: proposed.message });
      return this.state;
    }
    const remainingIndexes = [...available].sort((left, right) => left - right);
    const remainingMetadata = pending.operationMetadata.filter((operation) =>
      operation.operationIndex !== undefined && remainingIndexes.includes(operation.operationIndex),
    );
    const changes = structuralDiff(reviewBase.document, proposed.document, remainingMetadata);
    const selections = Object.fromEntries(changes.map((change) => [change.id, { selected: true }]));
    this.setState({
      ...pending,
      proposedDoc: clone(proposed.document),
      changes,
      selections,
      acceptedOperationIndexes: [...accepted].sort((left, right) => left - right),
      rejectedOperationIndexes: [...rejected].sort((left, right) => left - right),
      reviewBaseDoc: clone(reviewBase.document),
    });
    return this.state;
  }

  private transitionReviewChange(
    changeId: string,
    apply: () => SuggestionState,
  ): ReviewActionResult {
    const before = this.state.kind === "pending" ? selectedSuggestionChanges(this.state) : [];
    const currentIndex = before.findIndex((change) => change.id === changeId);
    const state = apply();
    const after = state.kind === "pending" ? selectedSuggestionChanges(state) : [];
    const remainingIds = new Set(after.map((change) => change.id));
    // Preserve existing review semantics: prefer the following item, then walk
    // backwards when the action was the final item. Reconcile only against the
    // rebuilt state, since shared/dependent operations may have disappeared.
    const candidates = currentIndex < 0
      ? []
      : [...before.slice(currentIndex + 1), ...before.slice(0, currentIndex).reverse()];
    return {
      state,
      nextChangeId: candidates.find((change) => remainingIds.has(change.id))?.id ?? after[0]?.id ?? null,
    };
  }

  private validationError(proposalId: string, validation: ProposalValidationError): SuggestionState {
    this.setState({ kind: "error", proposalId, reason: "invalid_request", message: validation.message });
    return this.state;
  }
}
