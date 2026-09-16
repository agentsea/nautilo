/**
 * D448 canonical Workspace history queries.
 *
 * These read and mutate only the durable mutation receipt tables. They never
 * consult `file_revisions`, physical artifact paths, or a compatibility
 * projection. Every externally supplied revision id is resolved together with
 * owner + agent scope so a miss and a cross-scope hit are indistinguishable.
 */

import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lte,
  or,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { DirectDatabase } from "../config/direct-database";
import { artifacts } from "../schema/artifacts";
import {
  workspaceDocumentMutationEntries,
  workspaceDocumentMutationEntryIdentities,
  workspaceDocumentMutations,
  type WorkspaceDocumentMutation,
  type WorkspaceDocumentMutationEntry,
} from "../schema/workspace-document-mutations";

export type WorkspaceHistoryScope = {
  readonly ownerId: string;
  readonly agentId: string;
};

export type WorkspaceDocumentHistoryRecord = {
  readonly mutation: WorkspaceDocumentMutation;
  readonly entry: WorkspaceDocumentMutationEntry;
  readonly revisionId: string;
};

export type WorkspaceDocumentHistoryLineage =
  | {
      readonly kind: "valid";
      readonly undo: readonly WorkspaceDocumentHistoryRecord[];
      readonly redo: readonly WorkspaceDocumentHistoryRecord[];
      readonly current: WorkspaceDocumentHistoryRecord | null;
    }
  | {
      readonly kind: "broken";
      readonly entryId: string;
    };

/**
 * Reduces canonical receipt lineage into conventional undo/redo stacks.
 * Input must be oldest-first in the same deterministic total order used by
 * listWorkspaceDocumentHistory. Broken or non-top restore pointers fail closed.
 */
export function reduceWorkspaceDocumentHistoryLineage(
  records: readonly WorkspaceDocumentHistoryRecord[],
): WorkspaceDocumentHistoryLineage {
  const undo: WorkspaceDocumentHistoryRecord[] = [];
  const redo: WorkspaceDocumentHistoryRecord[] = [];
  const recordsByEntryId = new Map(
    records.map((record) => [record.entry.id, record]),
  );
  for (const record of records) {
    const operation = record.entry.historyOperation;
    if (
      operation !== "undo" &&
      operation !== "redo" &&
      operation !== "undo_turn"
    ) {
      undo.push(record);
      redo.length = 0;
      continue;
    }
    const targetEntryId = record.entry.restoreFromEntryId;
    if (operation === "undo_turn") {
      const expected = undo.at(-1);
      const source = targetEntryId
        ? recordsByEntryId.get(targetEntryId)
        : undefined;
      const targetTurnId = source?.mutation.turnId;
      if (
        !targetEntryId ||
        expected?.entry.id !== targetEntryId ||
        source !== expected ||
        !targetTurnId
      ) {
        return { kind: "broken", entryId: record.entry.id };
      }
      const targetRecords = records.filter(
        (candidate) => candidate.mutation.turnId === targetTurnId,
      );
      if (
        targetRecords.some((candidate) =>
          candidate.entry.historyOperation === "undo" ||
          candidate.entry.historyOperation === "redo" ||
          candidate.entry.historyOperation === "undo_turn"
        ) ||
        redo.some((candidate) => candidate.mutation.turnId === targetTurnId)
      ) {
        return { kind: "broken", entryId: record.entry.id };
      }
      let suffixStart = undo.length;
      while (
        suffixStart > 0 &&
        undo[suffixStart - 1]!.mutation.turnId === targetTurnId
      ) {
        suffixStart -= 1;
      }
      if (
        suffixStart === undo.length ||
        undo.slice(0, suffixStart).some(
          (candidate) => candidate.mutation.turnId === targetTurnId,
        )
      ) {
        return { kind: "broken", entryId: record.entry.id };
      }
      undo.splice(suffixStart);
      redo.push(record);
      continue;
    }
    const stack = operation === "undo" ? undo : redo;
    const expected = stack.at(-1);
    if (!targetEntryId || expected?.entry.id !== targetEntryId) {
      return { kind: "broken", entryId: record.entry.id };
    }
    stack.pop();
    (operation === "undo" ? redo : undo).push(record);
  }
  return { kind: "valid", undo, redo, current: records.at(-1) ?? null };
}

function assertScope(scope: WorkspaceHistoryScope): void {
  if (scope.ownerId.trim().length === 0 || scope.agentId.trim().length === 0) {
    throw new Error("Workspace history owner and agent scope must be nonempty");
  }
}

function assertLimit(limit: number | undefined): void {
  if (
    limit !== undefined &&
    (!Number.isSafeInteger(limit) || limit <= 0)
  ) {
    throw new Error("Workspace history limit must be a positive safe integer");
  }
}

function assertValidDate(value: Date, label: string): void {
  if (Number.isNaN(value.getTime())) {
    throw new Error(`Workspace history ${label} must be a valid date`);
  }
}

function scopeConditions(scope: WorkspaceHistoryScope): SQL[] {
  assertScope(scope);
  return [
    eq(workspaceDocumentMutations.ownerId, scope.ownerId),
    eq(workspaceDocumentMutations.agentId, scope.agentId),
  ];
}

function eligibleHistoryConditions(scope: WorkspaceHistoryScope): SQL[] {
  return [
    ...scopeConditions(scope),
    eq(workspaceDocumentMutationEntries.historyEligible, true),
  ];
}

function pathCondition(logicalPath: string): SQL {
  if (logicalPath.trim().length === 0) {
    throw new Error("Workspace history logical path must be nonempty");
  }
  return or(
    eq(workspaceDocumentMutationEntries.beforeLogicalPath, logicalPath),
    eq(workspaceDocumentMutationEntries.afterLogicalPath, logicalPath),
    eq(workspaceDocumentMutationEntries.destinationBeforeLogicalPath, logicalPath),
  )!;
}

function primaryRevisionJoinConditions(): SQL {
  return and(
    eq(
      workspaceDocumentMutationEntryIdentities.mutationEntryId,
      workspaceDocumentMutationEntries.id,
    ),
    eq(workspaceDocumentMutationEntryIdentities.kind, "revision"),
    eq(workspaceDocumentMutationEntryIdentities.sequence, 0),
  )!;
}

function baseHistoryQuery(db: Pick<DirectDatabase, "select">) {
  return db
    .select({
      mutation: workspaceDocumentMutations,
      entry: workspaceDocumentMutationEntries,
      revisionId: workspaceDocumentMutationEntryIdentities.value,
    })
    .from(workspaceDocumentMutationEntryIdentities)
    .innerJoin(
      workspaceDocumentMutationEntries,
      primaryRevisionJoinConditions(),
    )
    .innerJoin(
      workspaceDocumentMutations,
      eq(
        workspaceDocumentMutations.id,
        workspaceDocumentMutationEntries.mutationId,
      ),
    );
}

/**
 * Human UI recovery is a separate disclosure surface from agent history tools.
 * The caller must re-prove current Room membership and artifact readability;
 * owner/agent scope alone must never widen this read to another Room's bytes.
 * Metadata only: consumers load the selected receipt's two snapshots, not all
 * history payloads. No recent-N cutoff may silently change the undo lineage.
 */
export async function listWorkspaceRoomDocumentHistory(
  db: Pick<DirectDatabase, "select">,
  input: {
    readonly agentId: string;
    readonly roomId: string;
    readonly artifactInternalId: string;
  },
): Promise<readonly WorkspaceDocumentHistoryRecord[]> {
  if (!input.agentId.trim() || !input.roomId.trim() || !input.artifactInternalId.trim()) {
    throw new Error("Workspace UI history requires an exact Room and artifact");
  }
  return baseHistoryQuery(db)
    .where(and(
      eq(workspaceDocumentMutationEntries.historyEligible, true),
      eq(workspaceDocumentMutations.agentId, input.agentId),
      eq(workspaceDocumentMutations.roomId, input.roomId),
      eq(workspaceDocumentMutationEntries.artifactInternalId, input.artifactInternalId),
    ))
    .orderBy(
      desc(workspaceDocumentMutations.createdAt),
      desc(workspaceDocumentMutations.id),
      desc(workspaceDocumentMutationEntries.sequence),
      desc(workspaceDocumentMutationEntries.id),
    );
}

/** Enumeration-safe revision lookup. Cross-owner/agent ids return null. */
export async function findOwnedWorkspaceHistoryByRevisionId(
  db: DirectDatabase,
  input: WorkspaceHistoryScope & { readonly revisionId: string },
): Promise<WorkspaceDocumentHistoryRecord | null> {
  if (input.revisionId.trim().length === 0) {
    throw new Error("Workspace history revision id must be nonempty");
  }
  const [row] = await db
    .select({
      mutation: workspaceDocumentMutations,
      entry: workspaceDocumentMutationEntries,
      revisionId: workspaceDocumentMutationEntryIdentities.value,
    })
    .from(workspaceDocumentMutationEntryIdentities)
    .innerJoin(
      workspaceDocumentMutationEntries,
      eq(
        workspaceDocumentMutationEntries.id,
        workspaceDocumentMutationEntryIdentities.mutationEntryId,
      ),
    )
    .innerJoin(
      workspaceDocumentMutations,
      eq(
        workspaceDocumentMutations.id,
        workspaceDocumentMutationEntries.mutationId,
      ),
    )
    .where(and(
      ...eligibleHistoryConditions(input),
      eq(workspaceDocumentMutationEntryIdentities.kind, "revision"),
      eq(workspaceDocumentMutationEntryIdentities.value, input.revisionId),
    ))
    .limit(1);
  return row ?? null;
}

export async function findOwnedWorkspaceHistoryByEntryId(
  db: DirectDatabase,
  input: WorkspaceHistoryScope & { readonly entryId: string },
): Promise<WorkspaceDocumentHistoryRecord | null> {
  if (input.entryId.trim().length === 0) {
    throw new Error("Workspace history entry id must be nonempty");
  }
  const [row] = await baseHistoryQuery(db)
    .where(and(
      ...eligibleHistoryConditions(input),
      eq(workspaceDocumentMutationEntries.id, input.entryId),
    ))
    .limit(1);
  return row ?? null;
}

export async function findLatestEligibleWorkspaceHistory(
  db: DirectDatabase,
  input: WorkspaceHistoryScope & {
    readonly artifactInternalId?: string;
    readonly logicalPath?: string;
  },
): Promise<WorkspaceDocumentHistoryRecord | null> {
  if (input.artifactInternalId === undefined && input.logicalPath === undefined) {
    throw new Error("Workspace history lookup requires an artifact id or logical path");
  }
  if (input.artifactInternalId?.trim().length === 0) {
    throw new Error("Workspace history artifact id must be nonempty when provided");
  }
  const [row] = await baseHistoryQuery(db)
    .where(and(
      ...eligibleHistoryConditions(input),
      ...(input.artifactInternalId === undefined
        ? []
        : [eq(
          workspaceDocumentMutationEntries.artifactInternalId,
          input.artifactInternalId,
        )]),
      ...(input.logicalPath === undefined ? [] : [pathCondition(input.logicalPath)]),
    ))
    .orderBy(
      desc(workspaceDocumentMutations.createdAt),
      desc(workspaceDocumentMutations.id),
      desc(workspaceDocumentMutationEntries.sequence),
      desc(workspaceDocumentMutationEntries.id),
    )
    .limit(1);
  return row ?? null;
}

export async function listWorkspaceHistoryForTurn(
  db: DirectDatabase,
  input: WorkspaceHistoryScope & { readonly turnId: string },
): Promise<readonly WorkspaceDocumentHistoryRecord[]> {
  if (input.turnId.trim().length === 0) {
    throw new Error("Workspace history turn id must be nonempty");
  }
  return await baseHistoryQuery(db)
    .where(and(
      ...eligibleHistoryConditions(input),
      eq(workspaceDocumentMutations.turnId, input.turnId),
    ))
    .orderBy(
      desc(workspaceDocumentMutations.createdAt),
      desc(workspaceDocumentMutations.id),
      desc(workspaceDocumentMutationEntries.sequence),
      desc(workspaceDocumentMutationEntries.id),
    );
}

export async function findLatestWorkspaceRedoEligibleHistory(
  db: DirectDatabase,
  input: WorkspaceHistoryScope & {
    readonly artifactInternalId?: string;
    readonly logicalPath?: string;
  },
): Promise<WorkspaceDocumentHistoryRecord | null> {
  if (input.artifactInternalId === undefined && input.logicalPath === undefined) {
    throw new Error("Workspace redo lookup requires an artifact id or logical path");
  }
  if (input.artifactInternalId?.trim().length === 0) {
    throw new Error("Workspace redo artifact id must be nonempty when provided");
  }
  const [row] = await baseHistoryQuery(db)
    .where(and(
      ...eligibleHistoryConditions(input),
      ...(input.artifactInternalId === undefined
        ? []
        : [eq(
          workspaceDocumentMutationEntries.artifactInternalId,
          input.artifactInternalId,
        )]),
      isNotNull(workspaceDocumentMutationEntries.restoreFromEntryId),
      ...(input.logicalPath === undefined ? [] : [pathCondition(input.logicalPath)]),
    ))
    .orderBy(
      desc(workspaceDocumentMutations.createdAt),
      desc(workspaceDocumentMutations.id),
      desc(workspaceDocumentMutationEntries.sequence),
      desc(workspaceDocumentMutationEntries.id),
    )
    .limit(1);
  return row ?? null;
}

export type ListWorkspaceDocumentHistoryInput = WorkspaceHistoryScope & {
  readonly artifactInternalId?: string;
  readonly logicalPath?: string;
  readonly turnId?: string;
  readonly since?: Date;
  readonly until?: Date;
  readonly pinnedOnly?: boolean;
  /** Explicit caller pagination only; no product-level maximum is imposed. */
  readonly limit?: number;
};

export async function listWorkspaceDocumentHistory(
  db: DirectDatabase,
  input: ListWorkspaceDocumentHistoryInput,
): Promise<readonly WorkspaceDocumentHistoryRecord[]> {
  assertLimit(input.limit);
  if (input.since) assertValidDate(input.since, "since");
  if (input.until) assertValidDate(input.until, "until");
  if (
    input.artifactInternalId !== undefined &&
    input.artifactInternalId.trim().length === 0
  ) {
    throw new Error("Workspace history artifact filter must be nonempty");
  }
  if (input.turnId !== undefined && input.turnId.trim().length === 0) {
    throw new Error("Workspace history turn filter must be nonempty");
  }
  if (input.since && input.until && input.since > input.until) {
    throw new Error("Workspace history since must be before or equal to until");
  }
  const conditions: SQL[] = eligibleHistoryConditions(input);
  if (input.artifactInternalId !== undefined) {
    conditions.push(eq(
      workspaceDocumentMutationEntries.artifactInternalId,
      input.artifactInternalId,
    ));
  }
  if (input.logicalPath !== undefined) conditions.push(pathCondition(input.logicalPath));
  if (input.turnId !== undefined) {
    conditions.push(eq(workspaceDocumentMutations.turnId, input.turnId));
  }
  if (input.since) conditions.push(gte(workspaceDocumentMutations.createdAt, input.since));
  if (input.until) conditions.push(lte(workspaceDocumentMutations.createdAt, input.until));
  if (input.pinnedOnly) conditions.push(eq(workspaceDocumentMutations.pinned, true));

  const query = baseHistoryQuery(db)
    .where(and(...conditions))
    .orderBy(
      desc(workspaceDocumentMutations.createdAt),
      desc(workspaceDocumentMutations.id),
      desc(workspaceDocumentMutationEntries.sequence),
      desc(workspaceDocumentMutationEntries.id),
    );
  return input.limit === undefined
    ? await query
    : await query.limit(input.limit);
}

export async function resolveWorkspaceDocumentHistoryLineage(
  db: DirectDatabase,
  input: WorkspaceHistoryScope & { readonly logicalPath: string },
): Promise<WorkspaceDocumentHistoryLineage> {
  const newestFirst = await listWorkspaceDocumentHistory(db, input);
  return reduceWorkspaceDocumentHistoryLineage([...newestFirst].reverse());
}

export async function resolveWorkspaceDocumentHistoryLineageForArtifact(
  db: DirectDatabase,
  input: WorkspaceHistoryScope & { readonly artifactInternalId: string },
): Promise<WorkspaceDocumentHistoryLineage> {
  const newestFirst = await listWorkspaceDocumentHistory(db, input);
  return reduceWorkspaceDocumentHistoryLineage([...newestFirst].reverse());
}

function ownedMutationIdForRevision(
  db: DirectDatabase,
  input: WorkspaceHistoryScope & { readonly revisionId: string },
) {
  return db
    .select({ id: workspaceDocumentMutations.id })
    .from(workspaceDocumentMutationEntryIdentities)
    .innerJoin(
      workspaceDocumentMutationEntries,
      eq(
        workspaceDocumentMutationEntries.id,
        workspaceDocumentMutationEntryIdentities.mutationEntryId,
      ),
    )
    .innerJoin(
      workspaceDocumentMutations,
      eq(
        workspaceDocumentMutations.id,
        workspaceDocumentMutationEntries.mutationId,
      ),
    )
    .where(and(
      ...eligibleHistoryConditions(input),
      eq(workspaceDocumentMutationEntryIdentities.kind, "revision"),
      eq(workspaceDocumentMutationEntryIdentities.value, input.revisionId),
    ));
}

/** Group-atomic and enumeration-safe. False covers both missing and foreign. */
export async function setOwnedWorkspaceHistoryGroupPinned(
  db: DirectDatabase,
  input: WorkspaceHistoryScope & {
    readonly revisionId: string;
    readonly pinned: boolean;
  },
): Promise<boolean> {
  assertScope(input);
  if (input.revisionId.trim().length === 0) return false;
  const rows = await db
    .update(workspaceDocumentMutations)
    .set({ pinned: input.pinned })
    .where(inArray(
      workspaceDocumentMutations.id,
      ownedMutationIdForRevision(db, input),
    ))
    .returning({ id: workspaceDocumentMutations.id });
  return rows.length === 1;
}

/** Access touches are scoped and group-atomic for the same enumeration reason. */
export async function touchOwnedWorkspaceHistoryGroup(
  db: DirectDatabase,
  input: WorkspaceHistoryScope & {
    readonly revisionId: string;
    readonly accessedAt: Date;
  },
): Promise<boolean> {
  assertScope(input);
  if (input.revisionId.trim().length === 0) return false;
  assertValidDate(input.accessedAt, "access time");
  const rows = await db
    .update(workspaceDocumentMutations)
    .set({ accessedAt: input.accessedAt })
    .where(inArray(
      workspaceDocumentMutations.id,
      ownedMutationIdForRevision(db, input),
    ))
    .returning({ id: workspaceDocumentMutations.id });
  return rows.length === 1;
}

export async function findRecentWorkspaceHumanCheckpoint(
  db: DirectDatabase,
  input: WorkspaceHistoryScope & {
    readonly userId: string;
    readonly artifactInternalId: string;
    readonly since?: Date;
  },
): Promise<WorkspaceDocumentHistoryRecord | null> {
  if (input.userId.trim().length === 0) {
    throw new Error("Workspace checkpoint user id must be nonempty");
  }
  if (input.artifactInternalId.trim().length === 0) {
    throw new Error("Workspace checkpoint artifact id must be nonempty");
  }
  if (input.since) assertValidDate(input.since, "checkpoint lower bound");
  const [row] = await baseHistoryQuery(db)
    .where(and(
      ...eligibleHistoryConditions(input),
      eq(workspaceDocumentMutations.actorKind, "human"),
      eq(workspaceDocumentMutations.userId, input.userId),
      eq(
        workspaceDocumentMutationEntries.artifactInternalId,
        input.artifactInternalId,
      ),
      eq(workspaceDocumentMutationEntries.checkpoint, true),
      ...(input.since === undefined
        ? []
        : [gte(workspaceDocumentMutations.createdAt, input.since)]),
    ))
    .orderBy(
      desc(workspaceDocumentMutations.createdAt),
      desc(workspaceDocumentMutations.id),
      desc(workspaceDocumentMutationEntries.sequence),
      desc(workspaceDocumentMutationEntries.id),
    )
    .limit(1);
  return row ?? null;
}

/** Canonical deleted-artifact history lookup; no physical-path fallback. */
export async function findLatestDeletedWorkspaceArtifactHistory(
  db: DirectDatabase,
  input: WorkspaceHistoryScope & { readonly logicalPath: string },
): Promise<WorkspaceDocumentHistoryRecord | null> {
  const [row] = await baseHistoryQuery(db)
    .innerJoin(
      artifacts,
      eq(artifacts.id, workspaceDocumentMutationEntries.artifactInternalId),
    )
    .where(and(
      ...eligibleHistoryConditions(input),
      pathCondition(input.logicalPath),
      isNotNull(artifacts.deletedAt),
    ))
    .orderBy(
      desc(workspaceDocumentMutations.createdAt),
      desc(workspaceDocumentMutations.id),
      desc(workspaceDocumentMutationEntries.sequence),
      desc(workspaceDocumentMutationEntries.id),
    )
    .limit(1);
  return row ?? null;
}
