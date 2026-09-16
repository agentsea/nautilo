import type {
  ApplyProposalResult,
  HierarchyBudget,
  HierarchyBudgetUsage,
  OrganizeProposal,
  RecordRef,
  SyntheticAccessAudience,
} from "../contracts/hierarchy";
import type { InMemoryHierarchyRepository } from "../graph/in-memory-repository";
import type { SyntheticHierarchyBridge } from "../graph/synthetic-bridge";
import {
  runOrganizer,
  type OrganizerChangeReason,
  type OrganizerInput,
  type OrganizerModelInvoker,
  type OrganizerRecordInput,
} from "../organizer/processor";

export interface SleepDirtyGeneration {
  readonly logicalObjectRef: string;
  readonly generation: number;
  readonly recordRef: RecordRef;
  readonly changeReason: OrganizerChangeReason;
}

export interface SleepOrganizerView {
  readonly candidateRecordRefs: readonly RecordRef[];
  readonly existingParentRecordRefs: readonly RecordRef[];
  readonly eligibleRecordRefs: readonly RecordRef[];
  readonly initialPublicationScope: SyntheticAccessAudience;
  readonly maxSelectedChildren: number;
}

export type SleepOrganizerViewPort = (
  changedRecordRef: RecordRef,
) => SleepOrganizerView | Promise<SleepOrganizerView>;

export interface SleepContinuation {
  readonly pending: readonly SleepDirtyGeneration[];
}

export interface SleepRunResult {
  readonly applied: readonly ApplyProposalResult[];
  readonly failures: readonly {
    recordRef: RecordRef;
    errorCode: "invalid_output";
  }[];
  readonly usage: HierarchyBudgetUsage;
  readonly continuation?: SleepContinuation;
}

function zeroUsage(): HierarchyBudgetUsage {
  return { modelCalls: 0, visitedRecords: 0, createdRecords: 0, traversalWork: 0 };
}

function addUsage(
  left: HierarchyBudgetUsage,
  right: HierarchyBudgetUsage,
): HierarchyBudgetUsage {
  return {
    modelCalls: left.modelCalls + right.modelCalls,
    visitedRecords: left.visitedRecords + right.visitedRecords,
    createdRecords: left.createdRecords + right.createdRecords,
    traversalWork: left.traversalWork + right.traversalWork,
  };
}

function remainingBudget(
  budget: HierarchyBudget,
  usage: HierarchyBudgetUsage,
): HierarchyBudget {
  return {
    maxModelCalls: Math.max(0, budget.maxModelCalls - usage.modelCalls),
    maxVisitedRecords: Math.max(0, budget.maxVisitedRecords - usage.visitedRecords),
    maxCreatedRecords: Math.max(0, budget.maxCreatedRecords - usage.createdRecords),
    maxTraversalWork: Math.max(0, budget.maxTraversalWork - usage.traversalWork),
    maxStatementCharacters: budget.maxStatementCharacters,
  };
}

function requireGeneration(input: SleepDirtyGeneration): void {
  if (input.logicalObjectRef.length === 0 || input.recordRef.length === 0) {
    throw new TypeError("Sleep dirty references must not be empty");
  }
  if (!Number.isSafeInteger(input.generation) || input.generation < 0) {
    throw new RangeError("Sleep generation must be a non-negative safe integer");
  }
}

/** Mutable only as a fixture queue; semantic Records in its repository remain immutable. */
export class HierarchySleepQueue {
  readonly #dirty = new Map<string, SleepDirtyGeneration>();

  enqueue(input: SleepDirtyGeneration): void {
    requireGeneration(input);
    const existing = this.#dirty.get(input.logicalObjectRef);
    if (!existing || input.generation > existing.generation) {
      this.#dirty.set(input.logicalObjectRef, { ...input });
    }
  }

  snapshot(): readonly SleepDirtyGeneration[] {
    return [...this.#dirty.values()]
      .sort(
        (left, right) =>
          left.logicalObjectRef.localeCompare(right.logicalObjectRef)
          || left.generation - right.generation,
      )
      .map((entry) => ({ ...entry }));
  }

  take(logicalObjectRef: string, generation: number): SleepDirtyGeneration | undefined {
    const current = this.#dirty.get(logicalObjectRef);
    if (!current || current.generation !== generation) return undefined;
    this.#dirty.delete(logicalObjectRef);
    return { ...current };
  }
}

function recordInput(
  repository: InMemoryHierarchyRepository,
  handle: string,
  recordRef: RecordRef,
): OrganizerRecordInput {
  return { handle, snapshot: repository.require(recordRef).snapshot };
}

function prepareOrganizer(
  repository: InMemoryHierarchyRepository,
  dirty: SleepDirtyGeneration,
  view: SleepOrganizerView,
): { input: OrganizerInput; byHandle: ReadonlyMap<string, RecordRef> } {
  const byHandle = new Map<string, RecordRef>();
  const add = (handle: string, recordRef: RecordRef): OrganizerRecordInput => {
    if (byHandle.has(handle)) throw new TypeError("duplicate Sleep Organizer handle");
    byHandle.set(handle, recordRef);
    return recordInput(repository, handle, recordRef);
  };
  const changed = add("C0", dirty.recordRef);
  const candidates = view.candidateRecordRefs.map((recordRef, index) =>
    add(`R${index + 1}`, recordRef)
  );
  const existingParents = view.existingParentRecordRefs.map((recordRef, index) =>
    add(`P${index + 1}`, recordRef)
  );
  return {
    input: {
      changed,
      candidates,
      existingParents,
      changeReason: dirty.changeReason,
      maxSelectedChildren: view.maxSelectedChildren,
    },
    byHandle,
  };
}

function mapProposal(
  proposal: OrganizeProposal,
  byHandle: ReadonlyMap<string, RecordRef>,
): OrganizeProposal {
  const resolve = (handle: string): RecordRef => {
    const recordRef = byHandle.get(handle);
    if (!recordRef) throw new TypeError("accepted Organizer handle was not mapped");
    return recordRef;
  };
  switch (proposal.operation) {
    case "no_change":
      return proposal;
    case "create_parent":
      return {
        ...proposal,
        childRecordRefs: proposal.childRecordRefs.map(resolve),
      };
    case "extend_parent":
    case "wrap_parent":
      return {
        ...proposal,
        parentRecordRef: resolve(proposal.parentRecordRef),
        additionRefs: proposal.additionRefs.map(resolve),
      };
    case "supersede_parent":
    case "resolve_parent":
      return {
        ...proposal,
        parentRecordRef: resolve(proposal.parentRecordRef),
        childRecordRefs: proposal.childRecordRefs.map(resolve),
      };
    case "dissolve_parent":
      return { ...proposal, parentRecordRef: resolve(proposal.parentRecordRef) };
  }
}

function reserveAllowsAnotherModelOperation(
  budget: HierarchyBudget,
  usage: HierarchyBudgetUsage,
): boolean {
  // Reserve the repair call and one possible creation so no accepted proposal
  // is dropped after semantic work has happened.
  return budget.maxModelCalls - usage.modelCalls >= 2
    && budget.maxCreatedRecords - usage.createdRecords >= 1;
}

function viewFitsWorstCaseOperation(
  budget: HierarchyBudget,
  usage: HierarchyBudgetUsage,
  view: SleepOrganizerView,
): boolean {
  const semanticVisits = 1
    + view.candidateRecordRefs.length
    + view.existingParentRecordRefs.length;
  const maximumApplicationVisits = view.maxSelectedChildren
    + (view.existingParentRecordRefs.length > 0 ? 1 : 0);
  return usage.visitedRecords + semanticVisits + maximumApplicationVisits
      <= budget.maxVisitedRecords
    && usage.traversalWork + 1 + view.maxSelectedChildren
      <= budget.maxTraversalWork;
}

/** Run both change-driven and scheduled work through the same Organizer path. */
export async function runHierarchySleep(input: {
  readonly queue: HierarchySleepQueue;
  readonly repository: InMemoryHierarchyRepository;
  readonly bridge: SyntheticHierarchyBridge;
  readonly view: SleepOrganizerViewPort;
  readonly invoke: OrganizerModelInvoker;
  readonly budget: HierarchyBudget;
  readonly signal?: AbortSignal;
}): Promise<SleepRunResult> {
  let usage = zeroUsage();
  const applied: ApplyProposalResult[] = [];
  const failures: { recordRef: RecordRef; errorCode: "invalid_output" }[] = [];

  while (reserveAllowsAnotherModelOperation(input.budget, usage)) {
    const next = input.queue.snapshot()[0];
    if (!next) break;
    const dirty = input.queue.take(next.logicalObjectRef, next.generation);
    if (!dirty) continue;

    const view = await input.view(dirty.recordRef);
    if (!viewFitsWorstCaseOperation(input.budget, usage, view)) {
      input.queue.enqueue(dirty);
      break;
    }
    const prepared = prepareOrganizer(input.repository, dirty, view);
    let modelCalls = 0;
    const organizer = await runOrganizer({
      snapshot: prepared.input,
      invoke: async (prompt, signal) => {
        modelCalls += 1;
        return input.invoke(prompt, signal);
      },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    usage = addUsage(usage, {
      modelCalls,
      visitedRecords: 1 + view.candidateRecordRefs.length + view.existingParentRecordRefs.length,
      createdRecords: 0,
      traversalWork: 1,
    });
    if (!organizer.ok) {
      failures.push({ recordRef: dirty.recordRef, errorCode: "invalid_output" });
      continue;
    }

    const proposal = mapProposal(organizer.proposal, prepared.byHandle);
    const application = input.bridge.applyProposal({
      proposal,
      eligibleRecordRefs: view.eligibleRecordRefs,
      initialPublicationScope: view.initialPublicationScope,
      idempotencyKey: `sleep:${dirty.logicalObjectRef}:${dirty.generation}`,
      budget: remainingBudget(input.budget, usage),
    });
    usage = addUsage(usage, application.usage);
    applied.push(application);
    if (
      application.operation === "create_parent"
      || application.operation === "extend_parent"
      || application.operation === "wrap_parent"
      || application.operation === "supersede_parent"
      || application.operation === "resolve_parent"
    ) {
      input.queue.enqueue({
        logicalObjectRef: application.record.snapshot.recordRef,
        generation: 0,
        recordRef: application.record.snapshot.recordRef,
        changeReason: "created",
      });
    }
  }

  const pending = input.queue.snapshot();
  return {
    applied,
    failures,
    usage,
    ...(pending.length === 0 ? {} : { continuation: { pending } }),
  };
}

export interface ScheduledSleepCheckpoint {
  readonly afterRecordRef?: RecordRef;
}

/** Deterministic retained-graph paging; every lifecycle state is retained in Wave 3. */
export function enqueueScheduledSleepPage(input: {
  readonly queue: HierarchySleepQueue;
  readonly repository: InMemoryHierarchyRepository;
  readonly pageSize: number;
  readonly checkpoint?: ScheduledSleepCheckpoint;
}): { enqueuedRecordRefs: readonly RecordRef[]; checkpoint?: ScheduledSleepCheckpoint } {
  if (!Number.isSafeInteger(input.pageSize) || input.pageSize < 1) {
    throw new RangeError("scheduled Sleep pageSize must be a positive safe integer");
  }
  const records = input.repository.list();
  let start = 0;
  if (input.checkpoint?.afterRecordRef !== undefined) {
    const checkpointIndex = records.findIndex(
      (record) => record.snapshot.recordRef === input.checkpoint!.afterRecordRef,
    );
    if (checkpointIndex < 0) throw new TypeError("scheduled Sleep checkpoint is unknown");
    start = checkpointIndex + 1;
  }
  const page = records.slice(start, start + input.pageSize);
  for (const record of page) {
    input.queue.enqueue({
      logicalObjectRef: `scheduled:${record.snapshot.recordRef}`,
      generation: 0,
      recordRef: record.snapshot.recordRef,
      changeReason: "scheduled_review",
    });
  }
  const hasMore = start + page.length < records.length;
  return {
    enqueuedRecordRefs: page.map((record) => record.snapshot.recordRef),
    ...(hasMore && page.length > 0
      ? { checkpoint: { afterRecordRef: page.at(-1)!.snapshot.recordRef } }
      : {}),
  };
}
