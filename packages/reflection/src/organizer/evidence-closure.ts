import type { RecordRef } from "../contracts/hierarchy";
import type { DurableSourceDependency } from "../persistence/repository";

export type OrganizerEvidenceIdentity =
  | Readonly<{ kind: "record"; recordRef: RecordRef }>
  | Readonly<{
      kind: "source";
      sourceKind: string;
      logicalSourceRef: string;
      observedRevision?: string;
      observedContentFingerprint?: string;
    }>;

export interface OrganizerEvidenceRecord {
  readonly recordRef: RecordRef;
  /** True only for a native leaf; synthesized source-only parents are false. */
  readonly terminalEvidenceIdentity: boolean;
  readonly childRecordRefs: readonly RecordRef[];
  readonly sourceDependencies: readonly DurableSourceDependency[];
}

export interface OrganizerEvidenceBudget {
  readonly maxVisitedRecords: number;
  readonly maxTraversalWork: number;
}

export type OrganizerEvidenceClosureResult =
  | Readonly<{
      status: "complete";
      identities: readonly OrganizerEvidenceIdentity[];
      identityKeys: ReadonlySet<string>;
      visitedRecords: number;
      traversalWork: number;
    }>
  | Readonly<{
      status: "unavailable";
      reason: "invalid_input" | "record_unavailable" | "dependency_cycle" | "budget_exceeded";
      visitedRecords: number;
      traversalWork: number;
    }>;

function validBound(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validOpaque(value: string): boolean {
  return value.trim().length > 0;
}

export function organizerEvidenceIdentityKey(
  identity: OrganizerEvidenceIdentity,
): string {
  return JSON.stringify(identity.kind === "record"
    ? ["record", identity.recordRef]
    : [
        "source",
        identity.sourceKind,
        identity.logicalSourceRef,
        identity.observedRevision ?? null,
        identity.observedContentFingerprint ?? null,
      ]);
}

export function organizerSourceEvidenceIdentity(
  dependency: DurableSourceDependency,
): OrganizerEvidenceIdentity {
  return {
    kind: "source",
    sourceKind: dependency.sourceKind,
    logicalSourceRef: dependency.logicalSourceRef,
    ...(dependency.observedRevision === undefined
      ? {}
      : { observedRevision: dependency.observedRevision }),
    ...(dependency.observedContentFingerprint === undefined
      ? {}
      : { observedContentFingerprint: dependency.observedContentFingerprint }),
  };
}

/**
 * Derive the exact semantic evidence closure from an already selected,
 * bounded graph view. Authority leaves, Rooms, and model labels are
 * deliberately absent from evidence identity.
 */
export function deriveOrganizerEvidenceClosure(input: Readonly<{
  rootRecordRefs: readonly RecordRef[];
  sourceDependencies?: readonly DurableSourceDependency[];
  records: ReadonlyMap<RecordRef, OrganizerEvidenceRecord>;
  budget: OrganizerEvidenceBudget;
}>): OrganizerEvidenceClosureResult {
  if (
    !validBound(input.budget.maxVisitedRecords)
    || !validBound(input.budget.maxTraversalWork)
    || input.rootRecordRefs.some((recordRef) => !validOpaque(recordRef))
    || new Set(input.rootRecordRefs).size !== input.rootRecordRefs.length
  ) {
    return {
      status: "unavailable",
      reason: "invalid_input",
      visitedRecords: 0,
      traversalWork: 0,
    };
  }

  const identities = new Map<string, OrganizerEvidenceIdentity>();
  const completed = new Set<RecordRef>();
  const visiting = new Set<RecordRef>();
  let visitedRecords = 0;
  let traversalWork = 0;

  const addIdentity = (identity: OrganizerEvidenceIdentity): boolean => {
    if (
      identity.kind === "record"
        ? !validOpaque(identity.recordRef)
        : !validOpaque(identity.sourceKind)
          || !validOpaque(identity.logicalSourceRef)
          || (identity.observedRevision !== undefined
            && !validOpaque(identity.observedRevision))
          || (identity.observedContentFingerprint !== undefined
            && !validOpaque(identity.observedContentFingerprint))
    ) return false;
    identities.set(organizerEvidenceIdentityKey(identity), identity);
    return true;
  };

  for (const dependency of input.sourceDependencies ?? []) {
    if (!addIdentity(organizerSourceEvidenceIdentity(dependency))) {
      return {
        status: "unavailable",
        reason: "invalid_input",
        visitedRecords,
        traversalWork,
      };
    }
  }

  let failure: Extract<OrganizerEvidenceClosureResult, { status: "unavailable" }>["reason"]
    | undefined;
  const visit = (recordRef: RecordRef): void => {
    if (failure !== undefined || completed.has(recordRef)) return;
    if (visiting.has(recordRef)) {
      failure = "dependency_cycle";
      return;
    }
    if (visitedRecords >= input.budget.maxVisitedRecords) {
      failure = "budget_exceeded";
      return;
    }
    const record = input.records.get(recordRef);
    if (record === undefined || record.recordRef !== recordRef) {
      failure = "record_unavailable";
      return;
    }
    visitedRecords += 1;
    visiting.add(recordRef);
    if (record.childRecordRefs.length === 0 && record.terminalEvidenceIdentity) {
      if (!addIdentity({ kind: "record", recordRef })) failure = "invalid_input";
    }
    for (const dependency of record.sourceDependencies) {
      if (!addIdentity(organizerSourceEvidenceIdentity(dependency))) {
        failure = "invalid_input";
        break;
      }
    }
    for (const childRecordRef of record.childRecordRefs) {
      if (failure !== undefined) break;
      if (traversalWork >= input.budget.maxTraversalWork) {
        failure = "budget_exceeded";
        break;
      }
      traversalWork += 1;
      visit(childRecordRef);
    }
    visiting.delete(recordRef);
    if (failure === undefined) completed.add(recordRef);
  };

  for (const rootRecordRef of input.rootRecordRefs) visit(rootRecordRef);
  if (failure !== undefined) {
    return { status: "unavailable", reason: failure, visitedRecords, traversalWork };
  }
  const ordered = [...identities.entries()]
    .sort(([left], [right]) => left.localeCompare(right));
  return {
    status: "complete",
    identities: ordered.map(([, identity]) => identity),
    identityKeys: new Set(ordered.map(([key]) => key)),
    visitedRecords,
    traversalWork,
  };
}

export function isStrictOrganizerEvidenceSuperset(
  candidate: ReadonlySet<string>,
  predecessor: ReadonlySet<string>,
): boolean {
  return candidate.size > predecessor.size
    && [...predecessor].every((identity) => candidate.has(identity));
}

export function organizerEvidenceClosuresArePairwiseDisjoint(
  closures: readonly ReadonlySet<string>[],
): boolean {
  const seen = new Set<string>();
  for (const closure of closures) {
    for (const identity of closure) {
      if (seen.has(identity)) return false;
      seen.add(identity);
    }
  }
  return true;
}

export function organizerEvidenceHasDependencyPath(input: Readonly<{
  from: RecordRef;
  target: RecordRef;
  records: ReadonlyMap<RecordRef, OrganizerEvidenceRecord>;
  maxTraversalWork: number;
}>): "yes" | "no" | "unavailable" {
  if (!validOpaque(input.from) || !validOpaque(input.target) || !validBound(input.maxTraversalWork)) {
    return "unavailable";
  }
  const pending = [input.from];
  const seen = new Set<RecordRef>();
  let work = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === input.target) return "yes";
    if (seen.has(current)) continue;
    const record = input.records.get(current);
    if (record === undefined) return "unavailable";
    seen.add(current);
    for (const childRecordRef of record.childRecordRefs) {
      if (work >= input.maxTraversalWork) return "unavailable";
      work += 1;
      pending.push(childRecordRef);
    }
  }
  return "no";
}
