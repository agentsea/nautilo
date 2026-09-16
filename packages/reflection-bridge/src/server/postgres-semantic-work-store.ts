import { createHmac, randomUUID } from "node:crypto";

import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  ne,
  or,
  reflectionRecordDependencies,
  reflectionRecordAuthorityDependencies,
  reflectionRecordDependencyChangeRepairs,
  reflectionRecordSemanticWork,
  reflectionRecordSemanticWorkAdmissions,
  reflectionRecordSourceChangeRepairs,
  reflectionRecordSourceDependencyIndex,
  reflectionRecords,
  sql,
} from "@nautilo/db";
import type {
  DurableSleepClaim,
  DurableSleepClaimOptions,
  DurableSleepClaimResult,
  DurableParentConflictResolutionResult,
  DurableSleepDeferralResult,
  DurableSleepFailureCode,
  DurableSleepOrdinaryFallbackReason,
  DurableSleepLeaseResult,
  DurableSleepStage,
  DurableSleepWorkPort,
} from "@nautilo/reflection";
import {
  DURABLE_SLEEP_QUARANTINE_RECOVERY_POLICY_V1,
  DURABLE_SLEEP_WORK_INTENT_POLICY_V1,
} from "@nautilo/reflection";
import type {
  DurableRecordPublication,
  DurableSourceDependency,
} from "@nautilo/reflection/durable";

import {
  assertVerifiedRecordProductPostgresHandle,
  executeTypedRecordProductQuery,
  recordProductTypedDb,
  type RecordProductPostgresExecutor,
  type RecordProductPostgresHandle,
  type RecordProductPostgresRow,
} from "./product-postgres";

const MAXIMUM_ATTEMPTS = 8;
const DEFAULT_LEASE_MILLISECONDS = 2 * 60 * 1_000;
const DEFAULT_RETRY_MILLISECONDS = 15 * 1_000;
const MAXIMUM_REPAIR_PAGE = 256;
const COMMITMENT_BYTES = 32;
const MAXIMUM_DATE_EPOCH_MILLISECONDS = 8_640_000_000_000_000;
const encoder = new TextEncoder();

const SEMANTIC_STAGE_RANK: Readonly<Record<DurableSleepStage, number>> =
  Object.freeze({
    authority_projection: 0,
    search_projection: 1,
    organization: 2,
  });

type RepresentationAdmission = NonNullable<
  DurableSleepClaimOptions["representationAdmission"]
>;

function assertRepresentationAdmission(
  admission: RepresentationAdmission,
): void {
  if (
    !["any", "without_protected_head", "none"].includes(admission.ordinary)
    || !["authority_projection", "organization", "none"].includes(admission.protected)
    || (
      admission.ordinary === "any"
      && admission.protected !== "none"
    )
  ) {
    throw new TypeError("Invalid semantic work representation admission");
  }
}

type SemanticChangeReason = DurableSleepClaim["changeReason"];

export interface RecordSemanticCommitmentPort {
  sourceDependency(input: Pick<
    DurableSourceDependency,
    "sourceKind" | "logicalSourceRef"
  >): Uint8Array;
  sourceChange(input: Readonly<{
    sourceKind: string;
    logicalSourceRef: string;
    changeRef: string;
  }>): Uint8Array;
  recordChange(input: Readonly<{
    recordRef: string;
    changeRef: string;
  }>): Uint8Array;
  publication(input: Readonly<{
    publication: DurableRecordPublication;
  }>): Uint8Array;
  enqueue(input: Readonly<{
    logicalObjectRef: string;
    generation: number;
    recordRef: string;
    changeReason: SemanticChangeReason;
  }>): Uint8Array;
  bootstrap(input: Readonly<{
    recordRef: string;
    processingGeneration: number;
  }>): Uint8Array;
  promotionBootstrap(input: Readonly<{
    recordRef: string;
    processingGeneration: number;
  }>): Uint8Array;
  candidatePolicyRecovery(input: Readonly<{
    recordRef: string;
    processingGeneration: number;
    policyVersion: string;
  }>): Uint8Array;
  parentConflict(input: Readonly<{
    childRecordRef: string;
    parents: readonly Readonly<{
      recordRef: string;
      processingGeneration: number;
    }>[];
  }>): Uint8Array;
  parentConflictRebuild(input: Readonly<{
    childRecordRef: string;
    supportRecordRef: string;
    parents: readonly Readonly<{
      recordRef: string;
      processingGeneration: number;
    }>[];
  }>): Uint8Array;
}

export const PARENT_CONFLICT_REPAIR_POLICY_V1 = Object.freeze({
  version: "parent-conflict-repair-v1",
  maximumParents: 32,
  maximumSupportRecords: 256,
} as const);

function assertOpaque(value: string, label: string): void {
  if (value.length === 0) throw new TypeError(`${label} must be non-empty`);
}

function semanticHmac(
  key: Uint8Array,
  domain: string,
  fields: readonly string[],
): Uint8Array {
  const hmac = createHmac("sha256", key);
  for (const field of [domain, ...fields]) {
    const bytes = encoder.encode(field);
    hmac.update(String(bytes.byteLength), "utf8");
    hmac.update(":", "utf8");
    hmac.update(bytes);
  }
  return new Uint8Array(hmac.digest());
}

/** Domain-separated commitments; neither the key nor source identity is persisted. */
export function createHmacRecordSemanticCommitmentPort(
  key: Uint8Array,
): RecordSemanticCommitmentPort {
  if (key.byteLength < COMMITMENT_BYTES) {
    throw new TypeError("Record semantic commitment key must contain at least 32 bytes");
  }
  const ownedKey = key.slice();
  const port: RecordSemanticCommitmentPort = {
    sourceDependency(input: Pick<
      DurableSourceDependency,
      "sourceKind" | "logicalSourceRef"
    >) {
      assertOpaque(input.sourceKind, "source kind");
      assertOpaque(input.logicalSourceRef, "logical source reference");
      return semanticHmac(ownedKey, "nautilo/reflection/source-dependency/v1", [
        input.sourceKind,
        input.logicalSourceRef,
      ]);
    },
    sourceChange(input: Readonly<{
      sourceKind: string;
      logicalSourceRef: string;
      changeRef: string;
    }>) {
      assertOpaque(input.sourceKind, "source kind");
      assertOpaque(input.logicalSourceRef, "logical source reference");
      assertOpaque(input.changeRef, "source change reference");
      return semanticHmac(ownedKey, "nautilo/reflection/source-change/v1", [
        input.sourceKind,
        input.logicalSourceRef,
        input.changeRef,
      ]);
    },
    recordChange(input: Readonly<{
      recordRef: string;
      changeRef: string;
    }>) {
      assertOpaque(input.recordRef, "changed Record reference");
      assertOpaque(input.changeRef, "Record change reference");
      return semanticHmac(ownedKey, "nautilo/reflection/record-change/v1", [
        input.recordRef,
        input.changeRef,
      ]);
    },
    publication(input: Readonly<{
      publication: DurableRecordPublication;
    }>) {
      return semanticHmac(ownedKey, "nautilo/reflection/publication-work/v1", [
        input.publication.idempotencyKey,
        // Preserve the deployed record-target commitment preimage while
        // removing predecessor admission from the public API.
        "record",
        input.publication.record.recordRef,
      ]);
    },
    enqueue(input: Readonly<{
      logicalObjectRef: string;
      generation: number;
      recordRef: string;
      changeReason: SemanticChangeReason;
    }>) {
      assertOpaque(input.logicalObjectRef, "logical object reference");
      assertOpaque(input.recordRef, "Record reference");
      if (!Number.isSafeInteger(input.generation) || input.generation < 0) {
        throw new RangeError("semantic enqueue generation must be non-negative");
      }
      return semanticHmac(ownedKey, "nautilo/reflection/recursive-work/v1", [
        input.logicalObjectRef,
        String(input.generation),
        input.recordRef,
        input.changeReason,
      ]);
    },
    bootstrap(input: Readonly<{
      recordRef: string;
      processingGeneration: number;
    }>) {
      assertOpaque(input.recordRef, "Record reference");
      if (
        !Number.isSafeInteger(input.processingGeneration)
        || input.processingGeneration < 1
      ) {
        throw new RangeError("bootstrap processing generation must be positive");
      }
      return semanticHmac(ownedKey, "nautilo/reflection/bootstrap-work/v1", [
        input.recordRef,
        String(input.processingGeneration),
      ]);
    },
    promotionBootstrap(input: Readonly<{
      recordRef: string;
      processingGeneration: number;
    }>) {
      assertOpaque(input.recordRef, "Record reference");
      if (
        !Number.isSafeInteger(input.processingGeneration)
        || input.processingGeneration < 1
      ) {
        throw new RangeError("promotion bootstrap processing generation must be positive");
      }
      return semanticHmac(
        ownedKey,
        "nautilo/reflection/promotion-bootstrap-work/v1",
        [input.recordRef, String(input.processingGeneration)],
      );
    },
    candidatePolicyRecovery(input) {
      assertOpaque(input.recordRef, "candidate-policy recovery Record reference");
      assertOpaque(input.policyVersion, "candidate-policy recovery version");
      if (
        !Number.isSafeInteger(input.processingGeneration)
        || input.processingGeneration < 1
      ) {
        throw new RangeError("candidate-policy recovery processing generation must be positive");
      }
      return semanticHmac(
        ownedKey,
        "nautilo/reflection/candidate-policy-recovery/v1",
        [
          input.policyVersion,
          input.recordRef,
          String(input.processingGeneration),
        ],
      );
    },
    parentConflict(input) {
      const fields = parentConflictFields(input);
      return semanticHmac(
        ownedKey,
        "nautilo/reflection/parent-conflict/v1",
        fields,
      );
    },
    parentConflictRebuild(input) {
      assertOpaque(input.supportRecordRef, "conflict support Record reference");
      return semanticHmac(
        ownedKey,
        "nautilo/reflection/parent-conflict-rebuild/v1",
        [...parentConflictFields(input), input.supportRecordRef],
      );
    },
  };
  return Object.freeze(port);
}

function parentConflictFields(input: Readonly<{
  childRecordRef: string;
  parents: readonly Readonly<{
    recordRef: string;
    processingGeneration: number;
  }>[];
}>): readonly string[] {
  assertOpaque(input.childRecordRef, "conflict child Record reference");
  if (
    input.parents.length < 2
    || input.parents.length > PARENT_CONFLICT_REPAIR_POLICY_V1.maximumParents
  ) {
    throw new RangeError("parent conflict must contain 2..32 parents");
  }
  const sorted = [...input.parents].sort((left, right) =>
    left.recordRef.localeCompare(right.recordRef)
  );
  if (
    new Set(sorted.map((parent) => parent.recordRef)).size !== sorted.length
    || sorted.some((parent) =>
      parent.recordRef.trim().length === 0
      || !Number.isSafeInteger(parent.processingGeneration)
      || parent.processingGeneration < 1
    )
  ) {
    throw new TypeError("parent conflict coordinates are invalid");
  }
  return [
    input.childRecordRef,
    ...sorted.flatMap((parent) => [
      parent.recordRef,
      String(parent.processingGeneration),
    ]),
  ];
}

function assertCommitment(value: Uint8Array, label: string): void {
  if (value.byteLength !== COMMITMENT_BYTES) {
    throw new TypeError(`${label} must contain exactly 32 bytes`);
  }
}

function assertReason(value: string): asserts value is SemanticChangeReason {
  if (![
    "scheduled_review",
    "created",
    "revised",
    "dependency_lost",
    "parent_conflict",
  ].includes(value)) {
    throw new TypeError("invalid semantic work change reason");
  }
}

function semanticReasonStrength(reason: SemanticChangeReason): number {
  switch (reason) {
    case "scheduled_review": return 0;
    case "created": return 1;
    case "revised": return 2;
    case "dependency_lost": return 3;
    case "parent_conflict": return 4;
  }
}

function assertPageLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAXIMUM_REPAIR_PAGE) {
    throw new RangeError(`semantic repair page limit must be 1..${MAXIMUM_REPAIR_PAGE}`);
  }
}

function rowString(row: RecordProductPostgresRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new TypeError("Invalid semantic work row");
  return value;
}

function rowInteger(row: RecordProductPostgresRow, key: string): number {
  const raw = row[key];
  const value = typeof raw === "bigint"
    ? Number(raw)
    : typeof raw === "string" && /^(?:0|[1-9][0-9]*)$/u.test(raw)
      ? Number(raw)
      : raw;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError("Invalid semantic work counter");
  }
  return value;
}

function rowBytes(row: RecordProductPostgresRow, key: string): Uint8Array {
  const value = row[key];
  if (!(value instanceof Uint8Array) || value.byteLength !== COMMITMENT_BYTES) {
    throw new TypeError("Invalid semantic work commitment");
  }
  return Uint8Array.from(value);
}

interface ParentConflictCoordinate {
  readonly recordRef: string;
  readonly processingGeneration: number;
}

function parentConflictCoordinates(
  rows: readonly RecordProductPostgresRow[],
): ReadonlyMap<string, readonly ParentConflictCoordinate[]> {
  const grouped = new Map<string, ParentConflictCoordinate[]>();
  for (const row of rows) {
    const childRecordRef = rowString(row, "child_record_id");
    const parents = grouped.get(childRecordRef) ?? [];
    parents.push({
      recordRef: rowString(row, "parent_record_id"),
      processingGeneration: rowInteger(row, "processing_generation"),
    });
    grouped.set(childRecordRef, parents);
  }
  return grouped;
}

async function currentConflictParents(
  tx: RecordProductPostgresExecutor,
  childRecordRef: string,
  limit: number,
): Promise<readonly ParentConflictCoordinate[]> {
  const rows = await executeTypedRecordProductQuery(tx, recordProductTypedDb
    .select({
      record_id: reflectionRecords.recordId,
      processing_generation: reflectionRecords.processingGeneration,
    })
    .from(reflectionRecordDependencies)
    .innerJoin(
      reflectionRecords,
      eq(reflectionRecords.recordId, reflectionRecordDependencies.parentRecordId),
    )
    .where(and(
      eq(reflectionRecordDependencies.childRecordId, childRecordRef),
      eq(reflectionRecords.lifecycle, "current"),
      eq(reflectionRecords.disposition, "available"),
    ))
    .orderBy(asc(reflectionRecords.recordId))
    .limit(limit));
  return rows.map((row) => ({
    recordRef: row.record_id,
    processingGeneration: row.processing_generation,
  }));
}

function sameParentCoordinates(
  left: readonly ParentConflictCoordinate[],
  right: readonly ParentConflictCoordinate[],
): boolean {
  return left.length === right.length && left.every((parent, index) => {
    const other = right[index];
    return other !== undefined
      && parent.recordRef === other.recordRef
      && parent.processingGeneration === other.processingGeneration;
  });
}

function parentConflictCapacityExceeded(): DurableParentConflictResolutionResult {
  return {
    status: "unavailable",
    failureCode: "candidate_unavailable",
    failureDetail: "parent_conflict_capacity_exceeded",
  };
}

function rowDate(row: RecordProductPostgresRow, key: string): Date | null {
  const value = row[key];
  if (value === null) return null;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  const parts = typeof value === "string"
    ? /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d{1,6})?(Z|[+-]\d{2}(?::?\d{2})?)$/u.exec(value)
    : null;
  if (parts !== null) {
    const zone = parts[4]!;
    const normalizedZone = zone === "Z" || zone.length === 6
      ? zone
      : zone.length === 3
        ? `${zone}:00`
        : `${zone.slice(0, 3)}:${zone.slice(3)}`;
    const parsed = new Date(`${parts[1]}T${parts[2]}${parts[3] ?? ""}${normalizedZone}`);
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  throw new TypeError("Invalid semantic work timestamp");
}

/**
 * Exact, transaction-neutral admission primitive. The immutable receipt makes
 * replays no-ops even after later first-seen changes advanced the work row.
 */
export async function admitSemanticWorkWithinTransaction(
  tx: RecordProductPostgresExecutor,
  input: Readonly<{
    recordRef: string;
    changeReason: SemanticChangeReason;
    admissionCommitment: Uint8Array;
    now: Date;
    notBefore?: Date;
  }>,
): Promise<Readonly<{ admitted: boolean; generation: number }>> {
  assertOpaque(input.recordRef, "Record reference");
  assertReason(input.changeReason);
  assertCommitment(input.admissionCommitment, "semantic admission commitment");
  const nextAttemptAt = input.notBefore ?? input.now;
  const nowMilliseconds = input.now.getTime();
  const nextAttemptMilliseconds = nextAttemptAt.getTime();
  if (
    !Number.isFinite(nowMilliseconds)
    || !Number.isFinite(nextAttemptMilliseconds)
    || nextAttemptMilliseconds < nowMilliseconds
  ) {
    throw new RangeError("semantic work timestamps must be valid and not-before cannot precede admission");
  }
  await tx.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`reflection-semantic-work:${input.recordRef}`],
  );
  const receipt = await executeTypedRecordProductQuery(tx,
    recordProductTypedDb.select({
      assigned_generation: reflectionRecordSemanticWorkAdmissions.assignedGeneration,
    })
      .from(reflectionRecordSemanticWorkAdmissions)
      .where(and(
        eq(reflectionRecordSemanticWorkAdmissions.recordId, input.recordRef),
        eq(
          reflectionRecordSemanticWorkAdmissions.admissionCommitment,
          input.admissionCommitment,
        ),
      )));
  if (receipt.length > 0) {
    return {
      admitted: false,
      generation: rowInteger(receipt[0]!, "assigned_generation"),
    };
  }
  const work = await tx.query(
    `SELECT generation, change_reason, state
       FROM reflection_record_semantic_work
      WHERE record_id = $1
      FOR UPDATE`,
    [input.recordRef],
  );
  const generation = work.length === 0
    ? 1
    : rowInteger(work[0]!, "generation") + 1;
  const previousReason = work.length === 0
    ? undefined
    : rowString(work[0]!, "change_reason");
  if (previousReason !== undefined) assertReason(previousReason);
  const preserveOutstandingStrongerReason = previousReason !== undefined
    && rowString(work[0]!, "state") !== "complete"
    && semanticReasonStrength(previousReason)
      > semanticReasonStrength(input.changeReason);
  const effectiveReason = preserveOutstandingStrongerReason
    ? previousReason
    : input.changeReason;
  // A weaker review discovered while stronger work is outstanding must not
  // delay that work behind the promotion timer.
  const effectiveNextAttemptAt = preserveOutstandingStrongerReason
    ? input.now
    : nextAttemptAt;
  await executeTypedRecordProductQuery(tx, recordProductTypedDb
    .insert(reflectionRecordSemanticWorkAdmissions)
    .values({
      recordId: input.recordRef,
      admissionCommitment: input.admissionCommitment,
      assignedGeneration: generation,
      createdAt: input.now,
    }));
  if (work.length === 0) {
    await executeTypedRecordProductQuery(tx, recordProductTypedDb
      .insert(reflectionRecordSemanticWork)
      .values({
        recordId: input.recordRef,
        generation,
        completedGeneration: 0,
        changeReason: effectiveReason,
        stage: "authority_projection",
        state: "due",
        attemptCount: 0,
        nextAttemptAt: effectiveNextAttemptAt,
        dueSince: input.now,
        startedAt: null,
        createdAt: input.now,
        updatedAt: input.now,
      }));
  } else {
    await executeTypedRecordProductQuery(tx, recordProductTypedDb
      .update(reflectionRecordSemanticWork)
      .set({
        generation,
        changeReason: effectiveReason,
        stage: "authority_projection",
        state: "due",
        claimGeneration: null,
        attemptCount: 0,
        quarantineRound: 0,
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: effectiveNextAttemptAt,
        recoverAfter: null,
        failureCode: null,
        ordinaryFallbackReason: null,
        dueSince: sql`greatest(${reflectionRecordSemanticWork.dueSince}, ${input.now})`,
        startedAt: null,
        completedAt: null,
        updatedAt: sql`greatest(${reflectionRecordSemanticWork.updatedAt}, ${input.now})`,
      })
      .where(eq(reflectionRecordSemanticWork.recordId, input.recordRef)));
  }
  return { admitted: true, generation };
}

/** Install exact protected-mode reverse lookup without persisting source IDs. */
export async function indexSemanticSourceDependenciesWithinTransaction(
  tx: RecordProductPostgresExecutor,
  input: Readonly<{
    recordRef: string;
    sourceDependencyCommitments: readonly Uint8Array[];
  }>,
): Promise<void> {
  assertOpaque(input.recordRef, "Record reference");
  if (input.sourceDependencyCommitments.length > MAXIMUM_REPAIR_PAGE) {
    throw new RangeError(`source dependency commitments must be at most ${MAXIMUM_REPAIR_PAGE}`);
  }
  const seen = new Map<string, Uint8Array>();
  for (const commitment of input.sourceDependencyCommitments) {
    assertCommitment(commitment, "source dependency commitment");
    const key = Buffer.from(commitment).toString("hex");
    if (!seen.has(key)) seen.set(key, commitment);
  }
  if (seen.size > 0) {
    await executeTypedRecordProductQuery(tx, recordProductTypedDb
      .insert(reflectionRecordSourceDependencyIndex)
      .values([...seen.values()].map((sourceDependencyCommitment) => ({
        sourceDependencyCommitment,
        recordId: input.recordRef,
      })))
      .onConflictDoNothing());
  }
}

/** Narrow product-store hook; every write stays inside the caller's transaction. */
export interface RecordSemanticPublicationPort {
  attachPublicationWithinTransaction(
    tx: RecordProductPostgresExecutor,
    publication: DurableRecordPublication,
    now?: Date,
  ): Promise<void>;
  recordChangedWithinTransaction(
    tx: RecordProductPostgresExecutor,
    input: Readonly<{ recordRef: string; changeRef: string }>,
    now?: Date,
  ): Promise<void>;
}

export interface SemanticWorkHealth {
  readonly backlog: number;
  /** Work that claimNext can attempt now, excluding future retries and recovery. */
  readonly ready: number;
  readonly claimed: number;
  readonly quarantined: number;
  readonly maximumAttempts: number;
  readonly oldestDueAt: Date | null;
}

export interface SemanticWorkRepairPage {
  readonly admitted: number;
  readonly continuation?: string;
}

export interface SemanticSourceRepairDrainResult {
  readonly consumed: number;
  readonly admitted: number;
  readonly pending: boolean;
}

export class PostgresSemanticWorkStore
  implements DurableSleepWorkPort, RecordSemanticPublicationPort {
  readonly #clock: () => Date;
  readonly #leaseMilliseconds: number;
  readonly #retryMilliseconds: number;

  constructor(
    private readonly options: Readonly<{
      handle: RecordProductPostgresHandle;
      commitments: RecordSemanticCommitmentPort;
      clock?: () => Date;
      leaseMilliseconds?: number;
      retryMilliseconds?: number;
    }>,
  ) {
    assertVerifiedRecordProductPostgresHandle(options.handle);
    this.#clock = options.clock ?? (() => new Date());
    this.#leaseMilliseconds = options.leaseMilliseconds ?? DEFAULT_LEASE_MILLISECONDS;
    this.#retryMilliseconds = options.retryMilliseconds ?? DEFAULT_RETRY_MILLISECONDS;
    if (!Number.isSafeInteger(this.#leaseMilliseconds) || this.#leaseMilliseconds < 1) {
      throw new RangeError("semantic work lease must be a positive integer of milliseconds");
    }
    if (!Number.isSafeInteger(this.#retryMilliseconds) || this.#retryMilliseconds < 1) {
      throw new RangeError("semantic work retry must be a positive integer of milliseconds");
    }
  }

  async attachPublicationWithinTransaction(
    tx: RecordProductPostgresExecutor,
    publication: DurableRecordPublication,
    now = this.#clock(),
  ): Promise<void> {
    const exposure = publication.record.semantic.modelExposureDependencies ?? [];
    const sourceDependencyCommitments = [
      ...publication.record.semantic.sourceDependencies,
      ...exposure.filter(dependency => dependency.kind === "source"),
    ].map((source) => this.options.commitments.sourceDependency(source));
    await indexSemanticSourceDependenciesWithinTransaction(tx, {
      recordRef: publication.record.recordRef,
      sourceDependencyCommitments,
    });
    const recordDependencies = exposure.flatMap(dependency => dependency.kind === "record"
      ? [{recordId: publication.record.recordRef, dependencyRecordId: dependency.recordRef}] : []);
    if (recordDependencies.length > 0) {
      await executeTypedRecordProductQuery(tx, recordProductTypedDb
        .insert(reflectionRecordAuthorityDependencies)
        .values(recordDependencies)
        .onConflictDoNothing());
    }
    await admitSemanticWorkWithinTransaction(tx, {
      recordRef: publication.record.recordRef,
      changeReason: publication.record.structuralHeight === 0
        ? "created"
        : "scheduled_review",
      admissionCommitment: this.options.commitments.publication({ publication }),
      now,
      ...(publication.record.structuralHeight === 0
        ? {}
        : {
            notBefore: new Date(
              now.getTime()
              + DURABLE_SLEEP_WORK_INTENT_POLICY_V1.promotionDelayMilliseconds,
            ),
          }),
    });
    if (publication.predecessor !== undefined) {
      await this.recordChangedWithinTransaction(tx, {
        recordRef: publication.predecessor.recordRef,
        changeRef:
          `${publication.predecessor.relation}:${publication.record.recordRef}`,
      }, now);
    }
  }

  async recordChangedWithinTransaction(
    tx: RecordProductPostgresExecutor,
    input: Readonly<{ recordRef: string; changeRef: string }>,
    now = this.#clock(),
  ): Promise<void> {
    assertOpaque(input.recordRef, "changed Record reference");
    assertOpaque(input.changeRef, "Record change reference");
    await executeTypedRecordProductQuery(tx, recordProductTypedDb
      .insert(reflectionRecordDependencyChangeRepairs)
      .values({
        changeCommitment: this.options.commitments.recordChange(input),
        changedRecordId: input.recordRef,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: reflectionRecordDependencyChangeRepairs.changeCommitment,
      }));
  }

  async enqueue(input: Readonly<{
    logicalObjectRef: string;
    generation: number;
    recordRef: string;
    changeReason: SemanticChangeReason;
  }>): Promise<void> {
    const commitment = this.options.commitments.enqueue(input);
    await this.options.handle.transaction(async (tx) => {
      await admitSemanticWorkWithinTransaction(tx, {
        recordRef: input.recordRef,
        changeReason: input.changeReason,
        admissionCommitment: commitment,
        now: this.#clock(),
      });
    }, { isolationLevel: "read committed" });
  }

  /**
   * Admit bounded legacy one-child/many-current-parent conflicts for repair.
   *
   * The child can already be terminal or unavailable: immutable provenance
   * edges survive those transitions, and conflicting current parents still
   * have to be retired. Filtering the child here would make conflicts visible
   * to health reporting but permanently unreachable by repair.
   */
  admitParentConflictsPage(input: Readonly<{
    limit: number;
  }>): Promise<SemanticWorkRepairPage> {
    assertPageLimit(input.limit);
    return this.options.handle.transaction(async (tx) => {
      const rows = await tx.query(
        `WITH conflict_children AS MATERIALIZED (
           SELECT dependency.child_record_id
             FROM reflection_record_dependencies AS dependency
             JOIN reflection_records AS parent
               ON parent.record_id = dependency.parent_record_id
            WHERE parent.lifecycle = 'current'
              AND parent.disposition = 'available'
           GROUP BY dependency.child_record_id
           HAVING count(*) > 1 AND count(*) <= $2
            ORDER BY dependency.child_record_id
            LIMIT $1
         )
         SELECT conflict.child_record_id, parent.record_id AS parent_record_id,
                parent.processing_generation
           FROM conflict_children AS conflict
           JOIN reflection_record_dependencies AS dependency
             ON dependency.child_record_id = conflict.child_record_id
           JOIN reflection_records AS parent
             ON parent.record_id = dependency.parent_record_id
            AND parent.lifecycle = 'current'
            AND parent.disposition = 'available'
          ORDER BY conflict.child_record_id, parent.record_id`,
        [input.limit, PARENT_CONFLICT_REPAIR_POLICY_V1.maximumParents],
      );
      const conflicts = parentConflictCoordinates(rows);
      const now = this.#clock();
      let admitted = 0;
      for (const [childRecordRef, parents] of conflicts) {
        if (parents.length > PARENT_CONFLICT_REPAIR_POLICY_V1.maximumParents) {
          continue;
        }
        const result = await admitSemanticWorkWithinTransaction(tx, {
          recordRef: childRecordRef,
          changeReason: "parent_conflict",
          admissionCommitment: this.options.commitments.parentConflict({
            childRecordRef,
            parents,
          }),
          now,
        });
        if (result.admitted) admitted += 1;
      }
      return { admitted };
    }, { isolationLevel: "read committed" });
  }

  /**
   * Symmetrically retire every conflicting derived parent and re-admit the
   * union of their current Record support. Immutable edges remain provenance;
   * only effective lifecycle and semantic work advance.
   */
  resolveParentConflict(input: Readonly<{
    claim: DurableSleepClaim;
    signal?: AbortSignal;
  }>): Promise<DurableParentConflictResolutionResult> {
    if (input.signal?.aborted) {
      return Promise.resolve({
        status: "unavailable",
        failureCode: "candidate_unavailable",
        failureDetail: "parent_conflict_storage_unavailable",
      });
    }
    return this.options.handle.transaction(async (tx) => {
      const now = this.#clock();
      const lease = await tx.query(
        `SELECT 1 AS found
           FROM reflection_record_semantic_work
          WHERE record_id = $1 AND generation = $2
            AND claim_generation = $2 AND lease_token = $3
            AND state = 'claimed' AND lease_expires_at > $4
          FOR UPDATE`,
        [input.claim.recordRef, input.claim.generation, input.claim.leaseToken, now],
      );
      if (lease.length !== 1) return { status: "not_applicable" as const };

      const initialParents = await currentConflictParents(
        tx,
        input.claim.recordRef,
        PARENT_CONFLICT_REPAIR_POLICY_V1.maximumParents + 1,
      );
      if (initialParents.length <= 1) return { status: "not_applicable" as const };
      if (initialParents.length > PARENT_CONFLICT_REPAIR_POLICY_V1.maximumParents) {
        return parentConflictCapacityExceeded();
      }
      await tx.query(
        `SELECT pg_advisory_xact_lock(hashtextextended(lock_id, 0))
           FROM (
             SELECT DISTINCT lock_id
               FROM unnest($1::text[]) AS lock_id
              ORDER BY lock_id
           ) AS ordered_locks`,
        [[input.claim.recordRef, ...initialParents.map((parent) => parent.recordRef)]],
      );
      const parents = await currentConflictParents(
        tx,
        input.claim.recordRef,
        PARENT_CONFLICT_REPAIR_POLICY_V1.maximumParents + 1,
      );
      if (parents.length <= 1) return { status: "not_applicable" as const };
      if (
        parents.length > PARENT_CONFLICT_REPAIR_POLICY_V1.maximumParents
        || !sameParentCoordinates(initialParents, parents)
      ) return parentConflictCapacityExceeded();

      const supportRows = await tx.query(
        `SELECT DISTINCT dependency.child_record_id
           FROM reflection_record_dependencies AS dependency
           JOIN reflection_records AS child
             ON child.record_id = dependency.child_record_id
          WHERE dependency.parent_record_id = ANY($1::text[])
            AND child.lifecycle = 'current'
            AND child.disposition = 'available'
          ORDER BY dependency.child_record_id
          LIMIT $2`,
        [
          parents.map((parent) => parent.recordRef),
          PARENT_CONFLICT_REPAIR_POLICY_V1.maximumSupportRecords + 1,
        ],
      );
      if (supportRows.length > PARENT_CONFLICT_REPAIR_POLICY_V1.maximumSupportRecords) {
        return parentConflictCapacityExceeded();
      }
      const supportRecordRefs = supportRows.map((row) =>
        rowString(row, "child_record_id")
      );
      for (const parent of parents) {
        const transitioned = await executeTypedRecordProductQuery(tx,
          recordProductTypedDb.update(reflectionRecords)
            .set({
              lifecycle: "resolved",
              processingGeneration: sql`${reflectionRecords.processingGeneration} + 1`,
              updatedAt: sql`greatest(${reflectionRecords.updatedAt}, ${now})`,
            })
            .where(and(
              eq(reflectionRecords.recordId, parent.recordRef),
              eq(reflectionRecords.processingGeneration, parent.processingGeneration),
              eq(reflectionRecords.lifecycle, "current"),
              eq(reflectionRecords.disposition, "available"),
            ))
            .returning({ record_id: reflectionRecords.recordId }));
        if (transitioned.length !== 1) {
          // Throw so the serializable transaction rolls every earlier
          // transition back when any generation fence loses a race.
          throw new Error("parent_conflict_transition_race");
        }
      }
      for (const parent of parents) {
        await this.recordChangedWithinTransaction(tx, {
          recordRef: parent.recordRef,
          changeRef:
            `parent-conflict:${input.claim.recordRef}:v${parent.processingGeneration + 1}`,
        }, now);
      }
      let requeuedRecords = 0;
      for (const supportRecordRef of supportRecordRefs) {
        const admission = await admitSemanticWorkWithinTransaction(tx, {
          recordRef: supportRecordRef,
          changeReason: "revised",
          admissionCommitment: this.options.commitments.parentConflictRebuild({
            childRecordRef: input.claim.recordRef,
            supportRecordRef,
            parents,
          }),
          now,
        });
        if (admission.admitted) requeuedRecords += 1;
      }
      return {
        status: "applied" as const,
        retiredParents: parents.length,
        requeuedRecords,
      };
    }, { isolationLevel: "serializable" }).catch(() => ({
      status: "unavailable" as const,
      failureCode: "candidate_unavailable" as const,
      failureDetail: "parent_conflict_storage_unavailable" as const,
    }));
  }

  async claimNext(
    signal?: AbortSignal,
    options: Parameters<DurableSleepWorkPort["claimNext"]>[1] = {},
  ): Promise<DurableSleepClaimResult> {
    if (signal?.aborted) return { status: "empty" };
    const maximumStage = options.maximumStage
      ?? (options.includeOrganization === false ? "search_projection" : "organization");
    const maximumStageRank = SEMANTIC_STAGE_RANK[maximumStage];
    if (maximumStageRank === undefined) {
      throw new TypeError("Invalid semantic work maximum stage");
    }
    const representationAdmission = options.representationAdmission;
    if (representationAdmission !== undefined) {
      assertRepresentationAdmission(representationAdmission);
    }
    const mutationStartedAt = performance.now();
    const result: DurableSleepClaimResult = await this.options.handle.transaction(async (tx) => {
      const now = this.#clock();
      await executeTypedRecordProductQuery(tx, recordProductTypedDb
        .update(reflectionRecordSemanticWork)
        .set({
          state: "quarantined",
          claimGeneration: null,
          quarantineRound: sql`${reflectionRecordSemanticWork.quarantineRound} + 1`,
          leaseToken: null,
          leaseExpiresAt: null,
          nextAttemptAt: null,
          recoverAfter: sql`${now}::timestamptz + least(
            ${DURABLE_SLEEP_QUARANTINE_RECOVERY_POLICY_V1.maximumDelayMilliseconds}
              ::double precision,
            ${DURABLE_SLEEP_QUARANTINE_RECOVERY_POLICY_V1.initialDelayMilliseconds}
              ::double precision * power(
              ${DURABLE_SLEEP_QUARANTINE_RECOVERY_POLICY_V1.backoffMultiplier}
                ::double precision,
              ${reflectionRecordSemanticWork.quarantineRound}::double precision
            )
          ) * interval '1 millisecond'`,
          failureCode: sql`coalesce(
            ${reflectionRecordSemanticWork.failureCode}, 'unexpected_failure'
          )`,
          completedAt: null,
          updatedAt: sql`greatest(${reflectionRecordSemanticWork.updatedAt}, ${now})`,
        })
        .where(and(
          sql`exists (
            select 1 from reflection_records as record
             where record.record_id = ${reflectionRecordSemanticWork.recordId}
               and record.disposition = 'available'
          )`,
          sql`${reflectionRecordSemanticWork.attemptCount} >= ${MAXIMUM_ATTEMPTS}`,
          or(
            and(
              inArray(reflectionRecordSemanticWork.state, [
                "due",
                "checkpointed",
                "deferred",
              ]),
              sql`${reflectionRecordSemanticWork.nextAttemptAt} <= ${now}`,
            ),
            and(
              eq(reflectionRecordSemanticWork.state, "claimed"),
              sql`${reflectionRecordSemanticWork.leaseExpiresAt} <= ${now}`,
            ),
          ),
        )));
      const rows = await tx.query(
        `WITH candidate AS (
            SELECT work.record_id,
                  work.state = 'quarantined' AS recovered_from_quarantine,
                  CASE
                    WHEN $6::text IS NULL THEN NULL
                    WHEN $6 = 'any' THEN 'ordinary'
                    WHEN $6 = 'without_protected_head'
                      AND protected_head.record_id IS NULL THEN 'ordinary'
                    WHEN $7 IN ('authority_projection', 'organization')
                      AND protected_head.record_id IS NOT NULL THEN 'protected'
                    ELSE NULL
                  END AS execution_representation,
                  CASE
                    WHEN $6 = 'any'
                      OR ($6 = 'without_protected_head'
                        AND protected_head.record_id IS NULL) THEN $5::integer
                    WHEN $7 IN ('authority_projection', 'organization')
                      AND protected_head.record_id IS NOT NULL
                      THEN LEAST($5::integer, CASE WHEN $7 = 'organization' THEN 2 ELSE 0 END)
                    ELSE NULL
                  END AS execution_maximum_stage
             FROM reflection_record_semantic_work AS work
             JOIN reflection_records AS record ON record.record_id = work.record_id
             LEFT JOIN reflection_record_payload_representation_heads AS protected_head
               ON protected_head.record_id = work.record_id
              AND protected_head.representation = 'protected'
            WHERE record.disposition = 'available'
              AND (
                ($6::text IS NULL AND CASE work.stage
                  WHEN 'authority_projection' THEN 0
                  WHEN 'search_projection' THEN 1
                  WHEN 'organization' THEN 2
                  ELSE 3
                END <= $5::integer)
                OR ($6 = 'any' AND CASE work.stage
                  WHEN 'authority_projection' THEN 0
                  WHEN 'search_projection' THEN 1
                  WHEN 'organization' THEN 2
                  ELSE 3
                END <= $5::integer)
                OR ($6 = 'without_protected_head'
                  AND protected_head.record_id IS NULL
                  AND CASE work.stage
                    WHEN 'authority_projection' THEN 0
                    WHEN 'search_projection' THEN 1
                    WHEN 'organization' THEN 2
                    ELSE 3
                  END <= $5::integer)
                OR ($7 IN ('authority_projection', 'organization')
                  AND protected_head.record_id IS NOT NULL
                  AND CASE work.stage
                    WHEN 'authority_projection' THEN 0
                    WHEN 'search_projection' THEN 1
                    WHEN 'organization' THEN 2
                    ELSE 3
                  END <= LEAST($5::integer, CASE WHEN $7 = 'organization' THEN 2 ELSE 0 END))
              )
              AND (
                (work.attempt_count < $2
                  AND work.state IN ('due', 'checkpointed', 'deferred')
                  AND work.next_attempt_at <= $1)
                OR (work.attempt_count < $2
                  AND work.state = 'claimed' AND work.lease_expires_at <= $1)
                OR (work.state = 'quarantined' AND work.recover_after <= $1)
              )
            ORDER BY CASE
                       WHEN work.change_reason = 'parent_conflict' THEN 0
                       ELSE 1
                     END ASC,
                     CASE
                       WHEN work.state = 'claimed'
                         AND work.lease_expires_at <= $1 THEN 0
                       WHEN work.state = 'quarantined' THEN 2
                       ELSE 1
                     END ASC,
                     work.attempt_count ASC,
                     CASE work.change_reason
                       WHEN 'dependency_lost' THEN 2
                       WHEN 'revised' THEN 1
                       ELSE 0
                     END DESC,
                     work.due_since,
                     work.record_id
            FOR UPDATE OF work SKIP LOCKED
            LIMIT 1
         )
         UPDATE reflection_record_semantic_work AS work
            SET state = 'claimed',
                claim_generation = work.generation,
                attempt_count = CASE
                  WHEN candidate.recovered_from_quarantine THEN 1
                  ELSE work.attempt_count + 1
                END,
                lease_token = $3,
                lease_expires_at = $4,
                next_attempt_at = null,
                recover_after = null,
                failure_code = null,
                started_at = coalesce(work.started_at, $1),
                completed_at = null,
                updated_at = greatest(work.updated_at, $1)
           FROM candidate
          WHERE work.record_id = candidate.record_id
        RETURNING work.record_id, work.generation, work.change_reason,
                  work.stage, work.lease_token, work.due_since, work.started_at,
                  candidate.recovered_from_quarantine,
                  candidate.execution_representation,
                  candidate.execution_maximum_stage`,
        [
          now,
          MAXIMUM_ATTEMPTS,
          randomUUID(),
          new Date(now.getTime() + this.#leaseMilliseconds),
          maximumStageRank,
          representationAdmission?.ordinary ?? null,
          representationAdmission?.protected ?? null,
        ],
      );
      const row = rows[0];
      if (row === undefined) return { status: "empty" as const };
      const recordRef = rowString(row, "record_id");
      const changeReason = rowString(row, "change_reason");
      assertReason(changeReason);
      const stage = rowString(row, "stage");
      if (![
        "authority_projection",
        "search_projection",
        "organization",
      ].includes(stage)) throw new TypeError("Invalid semantic work stage");
      const executionRepresentation = row["execution_representation"];
      const executionMaximumStage = representationAdmission === undefined
        ? undefined
        : rowInteger(row, "execution_maximum_stage");
      if (
        representationAdmission !== undefined
        && (
          !["ordinary", "protected"].includes(String(executionRepresentation))
          || executionMaximumStage === undefined
          || executionMaximumStage < 0
          || executionMaximumStage > 2
        )
      ) throw new TypeError("Invalid semantic work execution selection");
      return {
        status: "claimed" as const,
        claim: {
          logicalObjectRef: recordRef,
          generation: rowInteger(row, "generation"),
          recordRef,
          changeReason,
          stage: stage as DurableSleepClaim["stage"],
          leaseToken: rowString(row, "lease_token"),
          timing: {
            admittedAtEpochMs: rowDate(row, "due_since")!.getTime(),
            firstClaimedAtEpochMs: rowDate(row, "started_at")!.getTime(),
            claimedAtEpochMs: now.getTime(),
            claimStoreElapsedMs: 0,
          },
          ...(row["recovered_from_quarantine"] === true
            ? { recoveredFromQuarantine: true }
            : {}),
        },
        ...(representationAdmission === undefined
          ? {}
          : {
              executionRepresentation:
                executionRepresentation as "ordinary" | "protected",
              maximumStage: (
                ["authority_projection", "search_projection", "organization"] as const
              )[executionMaximumStage!]!,
            }),
      };
    }, { isolationLevel: "read committed" });
    if (result.status === "empty") return result;
    return {
      status: "claimed",
      claim: {
        ...result.claim,
        timing: {
          ...result.claim.timing!,
          claimStoreElapsedMs: Math.max(
            0,
            Math.round(performance.now() - mutationStartedAt),
          ),
        },
      },
      ...(result.executionRepresentation === undefined
        ? {}
        : { executionRepresentation: result.executionRepresentation }),
      ...(result.maximumStage === undefined
        ? {}
        : { maximumStage: result.maximumStage }),
    };
  }

  #currentClaimQuery(claim: DurableSleepClaim) {
    return recordProductTypedDb.select({ record_id: reflectionRecordSemanticWork.recordId, lease_expires_at: reflectionRecordSemanticWork.leaseExpiresAt })
        .from(reflectionRecordSemanticWork)
        .innerJoin(reflectionRecords, eq(reflectionRecords.recordId, reflectionRecordSemanticWork.recordId))
        .where(and(
          eq(reflectionRecordSemanticWork.recordId, claim.recordRef),
          eq(reflectionRecordSemanticWork.generation, claim.generation),
          eq(reflectionRecordSemanticWork.claimGeneration, claim.generation),
          eq(reflectionRecordSemanticWork.leaseToken, claim.leaseToken),
          eq(reflectionRecordSemanticWork.state, "claimed"),
          eq(reflectionRecordSemanticWork.stage, claim.stage),
          eq(reflectionRecordSemanticWork.changeReason, claim.changeReason),
          gt(reflectionRecordSemanticWork.leaseExpiresAt, this.#clock()),
          eq(reflectionRecords.disposition, "available"),
        ));
  }

  /** Metadata-only access check. Publication uses the locking sibling below. */
  async isClaimCurrent(claim: DurableSleepClaim): Promise<boolean> {
    if (claim.logicalObjectRef !== claim.recordRef) return false;
    const rows = await executeTypedRecordProductQuery(this.options.handle, this.#currentClaimQuery(claim));
    return rows.length === 1;
  }

  /** Keep the exact worker lease current through a product publication commit. */
  async withClaimPublicationFence<Value>(
    claim: DurableSleepClaim,
    use: (tx: RecordProductPostgresExecutor) => Promise<Value>,
  ): Promise<Readonly<{status: "current"; value: Value} | {status: "stale"}>> {
    if (claim.logicalObjectRef !== claim.recordRef) return {status: "stale"};
    return this.options.handle.transaction(async tx => {
      const locked = await executeTypedRecordProductQuery(tx,
        this.#currentClaimQuery(claim).for("update", {of: reflectionRecordSemanticWork}));
      if (locked.length !== 1) return {status: "stale"} as const;
      const value = await use(tx);
      // The held row prevents another worker replacing the lease. Product
      // publication can legitimately supersede its own work generation.
      const expiresAt = new Date(locked[0]!["lease_expires_at"] as string | Date).getTime();
      if (!Number.isFinite(expiresAt) || this.#clock().getTime() >= expiresAt) {
        throw new Error("Reflection publication lease expired");
      }
      return {status: "current", value} as const;
    }, {isolationLevel: "read committed"});
  }

  checkpoint(input: Readonly<{
    claim: DurableSleepClaim;
    completedStage: "authority_projection" | "search_projection";
  }>): Promise<DurableSleepLeaseResult> {
    if (input.claim.stage !== input.completedStage) {
      return Promise.resolve({ status: "lease_lost" });
    }
    const nextStage = input.completedStage === "authority_projection"
      ? "search_projection"
      : "organization";
    return this.#claimedMutation(input.claim, async (tx, now) => {
      const rows = await executeTypedRecordProductQuery(tx,
        recordProductTypedDb.update(reflectionRecordSemanticWork)
          .set({
            stage: nextStage,
            state: "checkpointed",
            claimGeneration: null,
            attemptCount: 0,
            leaseToken: null,
            leaseExpiresAt: null,
            nextAttemptAt: now,
            recoverAfter: null,
            failureCode: null,
            completedAt: null,
            updatedAt: sql`greatest(${reflectionRecordSemanticWork.updatedAt}, ${now})`,
          })
          .where(and(
            eq(reflectionRecordSemanticWork.recordId, input.claim.recordRef),
            eq(reflectionRecordSemanticWork.generation, input.claim.generation),
            eq(reflectionRecordSemanticWork.claimGeneration, input.claim.generation),
            eq(reflectionRecordSemanticWork.leaseToken, input.claim.leaseToken),
            eq(reflectionRecordSemanticWork.state, "claimed"),
            gt(reflectionRecordSemanticWork.leaseExpiresAt, now),
            eq(reflectionRecordSemanticWork.stage, input.completedStage),
          ))
          .returning({ record_id: reflectionRecordSemanticWork.recordId }));
      return rows.length === 1;
    });
  }

  pause(
    input: Parameters<DurableSleepWorkPort["pause"]>[0],
  ): Promise<DurableSleepLeaseResult> {
    return this.#claimedMutation(input.claim, async (tx, now) => {
      if (
        input.nextAttemptAt !== undefined
        && (
          !Number.isSafeInteger(input.nextAttemptAt)
          || input.nextAttemptAt <= now.getTime()
          || input.nextAttemptAt > MAXIMUM_DATE_EPOCH_MILLISECONDS
        )
      ) {
        throw new RangeError(
          "Semantic work next attempt must be a future bounded timestamp",
        );
      }
      const nextAttemptAt = input.nextAttemptAt === undefined
        ? now
        : new Date(input.nextAttemptAt);
      const state = input.claim.stage === "authority_projection" ? "due" : "checkpointed";
      const rows = await executeTypedRecordProductQuery(tx,
        recordProductTypedDb.update(reflectionRecordSemanticWork)
          .set({
            state,
            claimGeneration: null,
            attemptCount: sql`greatest(${reflectionRecordSemanticWork.attemptCount} - 1, 0)`,
            leaseToken: null,
            leaseExpiresAt: null,
            nextAttemptAt,
            recoverAfter: null,
            failureCode: null,
            completedAt: null,
            updatedAt: sql`greatest(${reflectionRecordSemanticWork.updatedAt}, ${now})`,
          })
          .where(and(
            eq(reflectionRecordSemanticWork.recordId, input.claim.recordRef),
            eq(reflectionRecordSemanticWork.generation, input.claim.generation),
            eq(reflectionRecordSemanticWork.claimGeneration, input.claim.generation),
            eq(reflectionRecordSemanticWork.leaseToken, input.claim.leaseToken),
            eq(reflectionRecordSemanticWork.state, "claimed"),
            gt(reflectionRecordSemanticWork.leaseExpiresAt, now),
          ))
          .returning({ record_id: reflectionRecordSemanticWork.recordId }));
      return rows.length === 1;
    });
  }

  /**
   * Commit a verified semantic product effect in its owning transaction. Unlike
   * a worker acknowledgement, recovery has no live process lease. Its caller
   * must authenticate the saved result and hold the exact source-generation
   * fence; newer admitted work is preserved rather than completed by replay.
   */
  async completeVerifiedGeneration(input: Readonly<{recordRef: string; generation: number}>): Promise<void> {
    if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
      throw new TypeError("Verified semantic generation must be positive");
    }
    await this.options.handle.transaction(async tx => {
      const table = reflectionRecordSemanticWork;
      const rows = await executeTypedRecordProductQuery(tx, recordProductTypedDb.select({
        generation: table.generation, completedGeneration: table.completedGeneration,
      }).from(table).where(eq(table.recordId, input.recordRef)).for("update"));
      const row = rows[0];
      if (rows.length !== 1 || row === undefined || row.generation < input.generation) {
        throw new Error("Verified semantic completion has no matching source generation");
      }
      if (row.completed_generation >= input.generation) return;
      const current = row.generation === input.generation;
      await executeTypedRecordProductQuery(tx, recordProductTypedDb.update(table).set({
        completedGeneration: input.generation,
        ...(current ? {state: "complete" as const, claimGeneration: null, leaseToken: null,
          leaseExpiresAt: null, nextAttemptAt: null, quarantineRound: 0, recoverAfter: null,
          failureCode: null, ordinaryFallbackReason: null, completedAt: sql`now()`} : {}),
        updatedAt: sql`greatest(${table.updatedAt}, now())`,
      }).where(eq(table.recordId, input.recordRef)));
    }, {isolationLevel: "read committed"});
  }

  complete(input: Readonly<{
    claim: DurableSleepClaim;
    ordinaryFallbackReason?: DurableSleepOrdinaryFallbackReason;
  }>): Promise<DurableSleepLeaseResult> {
    if (
      input.claim.stage !== "organization"
      && input.claim.changeReason !== "parent_conflict"
    ) {
      return Promise.resolve({ status: "lease_lost" });
    }
    return this.#claimedMutation(input.claim, async (tx, now) => {
      const rows = await executeTypedRecordProductQuery(tx,
        recordProductTypedDb.update(reflectionRecordSemanticWork)
          .set({
            state: "complete",
            completedGeneration: reflectionRecordSemanticWork.generation,
            claimGeneration: null,
            leaseToken: null,
            leaseExpiresAt: null,
            nextAttemptAt: null,
            quarantineRound: 0,
            recoverAfter: null,
            failureCode: null,
            ordinaryFallbackReason: input.ordinaryFallbackReason ?? null,
            completedAt: now,
            updatedAt: sql`greatest(${reflectionRecordSemanticWork.updatedAt}, ${now})`,
          })
          .where(and(
            eq(reflectionRecordSemanticWork.recordId, input.claim.recordRef),
            eq(reflectionRecordSemanticWork.generation, input.claim.generation),
            eq(reflectionRecordSemanticWork.claimGeneration, input.claim.generation),
            eq(reflectionRecordSemanticWork.leaseToken, input.claim.leaseToken),
            eq(reflectionRecordSemanticWork.state, "claimed"),
            eq(reflectionRecordSemanticWork.stage, input.claim.stage),
            eq(reflectionRecordSemanticWork.changeReason, input.claim.changeReason),
            gt(reflectionRecordSemanticWork.leaseExpiresAt, now),
          ))
          .returning({ record_id: reflectionRecordSemanticWork.recordId }));
      if (rows.length === 1) return true;
      // A protected attachment may have committed this exact generation before
      // the worker received its reply. Acknowledge it without touching newer work.
      const completed = await executeTypedRecordProductQuery(tx, recordProductTypedDb.select({
        completedGeneration: reflectionRecordSemanticWork.completedGeneration,
      }).from(reflectionRecordSemanticWork).where(eq(reflectionRecordSemanticWork.recordId, input.claim.recordRef)));
      return completed.length === 1 && completed[0]!.completed_generation >= input.claim.generation;
    });
  }

  defer(input: Readonly<{
    claim: DurableSleepClaim;
    failureCode: DurableSleepFailureCode;
  }>): Promise<DurableSleepDeferralResult> {
    return this.#claimedDeferral(input.claim, async (tx, now) => {
      const exhausted = sql`${reflectionRecordSemanticWork.attemptCount}
        >= ${MAXIMUM_ATTEMPTS}`;
      const rows = await executeTypedRecordProductQuery(tx,
        recordProductTypedDb.update(reflectionRecordSemanticWork)
          .set({
            state: sql`case when ${exhausted} then 'quarantined' else 'deferred' end`,
            claimGeneration: null,
            leaseToken: null,
            leaseExpiresAt: null,
            nextAttemptAt: sql`case when ${exhausted} then null else ${
              new Date(now.getTime() + this.#retryMilliseconds)
            }::timestamptz end`,
            quarantineRound: sql`${reflectionRecordSemanticWork.quarantineRound}
              + case when ${exhausted} then 1 else 0 end`,
            recoverAfter: sql`case when ${exhausted} then
              ${now}::timestamptz + least(
                ${DURABLE_SLEEP_QUARANTINE_RECOVERY_POLICY_V1.maximumDelayMilliseconds}
                  ::double precision,
                ${DURABLE_SLEEP_QUARANTINE_RECOVERY_POLICY_V1.initialDelayMilliseconds}
                  ::double precision * power(
                  ${DURABLE_SLEEP_QUARANTINE_RECOVERY_POLICY_V1.backoffMultiplier}
                    ::double precision,
                  ${reflectionRecordSemanticWork.quarantineRound}::double precision
                )
              ) * interval '1 millisecond'
              else null end`,
            failureCode: input.failureCode,
            completedAt: null,
            updatedAt: sql`greatest(${reflectionRecordSemanticWork.updatedAt}, ${now})`,
          })
          .where(and(
            eq(reflectionRecordSemanticWork.recordId, input.claim.recordRef),
            eq(reflectionRecordSemanticWork.generation, input.claim.generation),
            eq(reflectionRecordSemanticWork.claimGeneration, input.claim.generation),
            eq(reflectionRecordSemanticWork.leaseToken, input.claim.leaseToken),
            eq(reflectionRecordSemanticWork.state, "claimed"),
            gt(reflectionRecordSemanticWork.leaseExpiresAt, now),
          ))
          .returning({ state: reflectionRecordSemanticWork.state }));
      if (rows.length === 0) return null;
      return rowString(rows[0]!, "state") === "quarantined"
        ? "quarantined"
        : "deferred";
    });
  }

  async health(): Promise<SemanticWorkHealth> {
    const rows = await executeTypedRecordProductQuery(this.options.handle,
      recordProductTypedDb.select({
        backlog: sql<bigint>`count(*) filter (where ${reflectionRecordSemanticWork.state}
          in ('due', 'claimed', 'checkpointed', 'deferred'))::bigint`.as("backlog"),
        ready: sql<bigint>`count(*) filter (where (
          (${reflectionRecordSemanticWork.attemptCount} < ${MAXIMUM_ATTEMPTS}
            and ${reflectionRecordSemanticWork.state} in ('due', 'checkpointed', 'deferred')
            and ${reflectionRecordSemanticWork.nextAttemptAt} <= now())
          or (${reflectionRecordSemanticWork.attemptCount} < ${MAXIMUM_ATTEMPTS}
            and ${reflectionRecordSemanticWork.state} = 'claimed'
            and ${reflectionRecordSemanticWork.leaseExpiresAt} <= now())
          or (${reflectionRecordSemanticWork.state} = 'quarantined'
            and ${reflectionRecordSemanticWork.recoverAfter} <= now())
        ))::bigint`.as("ready"),
        claimed: sql<bigint>`count(*) filter (where ${reflectionRecordSemanticWork.state}
          = 'claimed')::bigint`.as("claimed"),
        quarantined: sql<bigint>`count(*) filter (where ${reflectionRecordSemanticWork.state}
          = 'quarantined')::bigint`.as("quarantined"),
        maximum_attempts: sql<number>`coalesce(max(${
          reflectionRecordSemanticWork.attemptCount
        }), 0)::integer`.as("maximum_attempts"),
        oldest_due_at: sql<Date | null>`min(${reflectionRecordSemanticWork.dueSince})
          filter (where ${reflectionRecordSemanticWork.state}
            in ('due', 'claimed', 'checkpointed', 'deferred'))`.as("oldest_due_at"),
      }).from(reflectionRecordSemanticWork)
        .innerJoin(
          reflectionRecords,
          eq(reflectionRecords.recordId, reflectionRecordSemanticWork.recordId),
        )
        .where(eq(reflectionRecords.disposition, "available")));
    const row = rows[0];
    if (row === undefined) {
      return {
        backlog: 0,
        ready: 0,
        claimed: 0,
        quarantined: 0,
        maximumAttempts: 0,
        oldestDueAt: null,
      };
    }
    return {
      backlog: rowInteger(row, "backlog"),
      ready: rowInteger(row, "ready"),
      claimed: rowInteger(row, "claimed"),
      quarantined: rowInteger(row, "quarantined"),
      maximumAttempts: rowInteger(row, "maximum_attempts"),
      oldestDueAt: rowDate(row, "oldest_due_at"),
    };
  }

  bootstrapPage(input: Readonly<{
    limit: number;
    continuation?: string;
  }>): Promise<SemanticWorkRepairPage> {
    assertPageLimit(input.limit);
    if (input.continuation !== undefined) {
      assertOpaque(input.continuation, "bootstrap continuation");
    }
    return this.options.handle.transaction(async (tx) => {
      const rows = await executeTypedRecordProductQuery(tx,
        recordProductTypedDb.select({
          record_id: reflectionRecords.recordId,
          processing_generation: reflectionRecords.processingGeneration,
          structural_height: reflectionRecords.structuralHeight,
        })
          .from(reflectionRecords)
          .leftJoin(
            reflectionRecordSemanticWork,
            eq(reflectionRecordSemanticWork.recordId, reflectionRecords.recordId),
          )
          .where(and(
            eq(reflectionRecords.disposition, "available"),
            or(
              isNull(reflectionRecordSemanticWork.recordId),
              and(
                eq(reflectionRecords.lifecycle, "current"),
                gt(reflectionRecords.structuralHeight, 0),
                eq(reflectionRecordSemanticWork.state, "complete"),
                ne(reflectionRecordSemanticWork.changeReason, "scheduled_review"),
              ),
            ),
            input.continuation === undefined
              ? undefined
              : gt(reflectionRecords.recordId, input.continuation),
          ))
          .orderBy(asc(reflectionRecords.recordId))
          .limit(input.limit + 1));
      const selected = rows.slice(0, input.limit);
      const now = this.#clock();
      let admitted = 0;
      for (const row of selected) {
        const recordRef = rowString(row, "record_id");
        const processingGeneration = rowInteger(row, "processing_generation");
        const structuralHeight = rowInteger(row, "structural_height");
        const result = await admitSemanticWorkWithinTransaction(tx, {
          recordRef,
          changeReason: structuralHeight === 0 ? "created" : "scheduled_review",
          admissionCommitment: structuralHeight > 0
            ? this.options.commitments.promotionBootstrap({
                recordRef,
                processingGeneration,
              })
            : this.options.commitments.bootstrap({
                recordRef,
                processingGeneration,
              }),
          now,
          ...(structuralHeight === 0
            ? {}
            : {
                notBefore: new Date(
                  now.getTime()
                  + DURABLE_SLEEP_WORK_INTENT_POLICY_V1.promotionDelayMilliseconds,
                ),
              }),
        });
        if (result.admitted) admitted += 1;
      }
      const continuation = rows.length > input.limit
        ? rowString(selected.at(-1)!, "record_id")
        : undefined;
      return {
        admitted,
        ...(continuation === undefined ? {} : { continuation }),
      };
    }, { isolationLevel: "read committed" });
  }

  /**
   * One bounded, receipt-backed repair pass for work quarantined by an obsolete
   * candidate planner. Callers scan it once per process; immutable admission
   * receipts make restarts exact and prevent a second model attempt for the
   * same Record generation and policy version.
   */
  recoverCandidatePolicyQuarantinesPage(input: Readonly<{
    limit: number;
    policyVersion: string;
    continuation?: string;
  }>): Promise<SemanticWorkRepairPage> {
    assertPageLimit(input.limit);
    assertOpaque(input.policyVersion, "candidate-policy recovery version");
    if (input.continuation !== undefined) {
      assertOpaque(input.continuation, "candidate-policy recovery continuation");
    }
    return this.options.handle.transaction(async (tx) => {
      const rows = await executeTypedRecordProductQuery(tx,
        recordProductTypedDb.select({
          record_id: reflectionRecords.recordId,
          processing_generation: reflectionRecords.processingGeneration,
          structural_height: reflectionRecords.structuralHeight,
        })
          .from(reflectionRecords)
          .innerJoin(
            reflectionRecordSemanticWork,
            eq(reflectionRecordSemanticWork.recordId, reflectionRecords.recordId),
          )
          .where(and(
            eq(reflectionRecords.disposition, "available"),
            eq(reflectionRecords.lifecycle, "current"),
            eq(reflectionRecordSemanticWork.state, "quarantined"),
            eq(reflectionRecordSemanticWork.failureCode, "candidate_unavailable"),
            input.continuation === undefined
              ? undefined
              : gt(reflectionRecords.recordId, input.continuation),
          ))
          .orderBy(asc(reflectionRecords.recordId))
          .limit(input.limit + 1));
      const selected = rows.slice(0, input.limit);
      const now = this.#clock();
      let admitted = 0;
      for (const row of selected) {
        const recordRef = rowString(row, "record_id");
        const processingGeneration = rowInteger(row, "processing_generation");
        const structuralHeight = rowInteger(row, "structural_height");
        const result = await admitSemanticWorkWithinTransaction(tx, {
          recordRef,
          changeReason: structuralHeight === 0 ? "created" : "scheduled_review",
          admissionCommitment: this.options.commitments.candidatePolicyRecovery({
            recordRef,
            processingGeneration,
            policyVersion: input.policyVersion,
          }),
          now,
        });
        if (result.admitted) admitted += 1;
      }
      const continuation = rows.length > input.limit
        ? rowString(selected.at(-1)!, "record_id")
        : undefined;
      return {
        admitted,
        ...(continuation === undefined ? {} : { continuation }),
      };
    }, { isolationLevel: "read committed" });
  }

  admitSourceDependentsPage(input: Readonly<{
    sourceDependencyCommitment: Uint8Array;
    sourceChangeCommitment: Uint8Array;
    limit: number;
    continuation?: string;
  }>): Promise<SemanticWorkRepairPage> {
    assertCommitment(input.sourceDependencyCommitment, "source dependency commitment");
    assertCommitment(input.sourceChangeCommitment, "source change commitment");
    assertPageLimit(input.limit);
    if (input.continuation !== undefined) {
      assertOpaque(input.continuation, "source repair continuation");
    }
    return this.options.handle.transaction(async (tx) => {
      const rows = await executeTypedRecordProductQuery(tx,
        recordProductTypedDb.select({
          record_id: reflectionRecordSourceDependencyIndex.recordId,
        })
          .from(reflectionRecordSourceDependencyIndex)
          .innerJoin(
            reflectionRecords,
            eq(
              reflectionRecords.recordId,
              reflectionRecordSourceDependencyIndex.recordId,
            ),
          )
          .where(and(
            eq(
              reflectionRecordSourceDependencyIndex.sourceDependencyCommitment,
              input.sourceDependencyCommitment,
            ),
            eq(reflectionRecords.disposition, "available"),
            input.continuation === undefined
              ? undefined
              : gt(reflectionRecordSourceDependencyIndex.recordId, input.continuation),
          ))
          .orderBy(asc(reflectionRecordSourceDependencyIndex.recordId))
          .limit(input.limit + 1));
      const selected = rows.slice(0, input.limit);
      const now = this.#clock();
      let admitted = 0;
      for (const row of selected) {
        const result = await admitSemanticWorkWithinTransaction(tx, {
          recordRef: rowString(row, "record_id"),
          changeReason: "dependency_lost",
          admissionCommitment: input.sourceChangeCommitment,
          now,
        });
        if (result.admitted) admitted += 1;
      }
      const continuation = rows.length > input.limit
        ? rowString(selected.at(-1)!, "record_id")
        : undefined;
      return {
        admitted,
        ...(continuation === undefined ? {} : { continuation }),
      };
    }, { isolationLevel: "read committed" });
  }

  /** Reserve one HMAC-only source change before returning from its mutation seam. */
  async reserveSourceRepair(input: Readonly<{
    sourceDependencyCommitment: Uint8Array;
    sourceChangeCommitment: Uint8Array;
  }>): Promise<Readonly<{ reserved: boolean }>> {
    assertCommitment(input.sourceDependencyCommitment, "source dependency commitment");
    assertCommitment(input.sourceChangeCommitment, "source change commitment");
    const now = this.#clock();
    const rows = await executeTypedRecordProductQuery(this.options.handle,
      recordProductTypedDb.insert(reflectionRecordSourceChangeRepairs)
        .values({
          sourceChangeCommitment: input.sourceChangeCommitment,
          sourceDependencyCommitment: input.sourceDependencyCommitment,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({
          target: reflectionRecordSourceChangeRepairs.sourceChangeCommitment,
        })
        .returning({
          source_change_commitment:
            reflectionRecordSourceChangeRepairs.sourceChangeCommitment,
        }));
    return { reserved: rows.length === 1 };
  }

  /**
   * Advance one child-Record change through a bounded page of direct parents.
   * A parent's eventual lifecycle transition reserves the following hop, so
   * deep propagation is restart-safe without a recursive graph scan.
   */
  repairRecordDependentsPage(input: Readonly<{
    limit: number;
  }>): Promise<SemanticSourceRepairDrainResult> {
    assertPageLimit(input.limit);
    return this.options.handle.transaction(async (tx) => {
      const repairs = await tx.query(
        `SELECT change_commitment, changed_record_id, continuation
           FROM reflection_record_dependency_change_repairs
          WHERE completed_at IS NULL
          ORDER BY created_at, change_commitment
          FOR UPDATE SKIP LOCKED
          LIMIT 1`,
      );
      const repair = repairs[0];
      if (repair === undefined) {
        return { consumed: 0, admitted: 0, pending: false };
      }
      const changeCommitment = rowBytes(repair, "change_commitment");
      const changedRecordId = rowString(repair, "changed_record_id");
      const rawContinuation = repair["continuation"];
      if (rawContinuation !== null && typeof rawContinuation !== "string") {
        throw new TypeError("Invalid Record dependency repair cursor");
      }
      const parents = recordProductTypedDb.select({
        parent_record_id: reflectionRecordDependencies.parentRecordId,
      }).from(reflectionRecordDependencies)
        .where(eq(reflectionRecordDependencies.childRecordId, changedRecordId))
        .union(recordProductTypedDb.select({
          parent_record_id: reflectionRecordAuthorityDependencies.recordId,
        }).from(reflectionRecordAuthorityDependencies)
          .where(eq(reflectionRecordAuthorityDependencies.dependencyRecordId, changedRecordId)))
        .as("dependent_parents");
      const rows = await executeTypedRecordProductQuery(tx,
        recordProductTypedDb.select({ parent_record_id: parents.parent_record_id })
          .from(parents)
          .innerJoin(reflectionRecords, eq(reflectionRecords.recordId, parents.parent_record_id))
          .where(and(
            eq(reflectionRecords.disposition, "available"),
            eq(reflectionRecords.lifecycle, "current"),
            rawContinuation === null ? undefined : gt(parents.parent_record_id, rawContinuation),
          ))
          .orderBy(asc(parents.parent_record_id))
          .limit(input.limit + 1));
      const selected = rows.slice(0, input.limit);
      const now = this.#clock();
      let admitted = 0;
      for (const row of selected) {
        const result = await admitSemanticWorkWithinTransaction(tx, {
          recordRef: rowString(row, "parent_record_id"),
          changeReason: "dependency_lost",
          admissionCommitment: changeCommitment,
          now,
        });
        if (result.admitted) admitted += 1;
      }
      const pending = rows.length > input.limit;
      if (pending) {
        await executeTypedRecordProductQuery(tx, recordProductTypedDb
          .update(reflectionRecordDependencyChangeRepairs)
          .set({
            continuation: rowString(selected.at(-1)!, "parent_record_id"),
            updatedAt: now,
          })
          .where(and(
            eq(
              reflectionRecordDependencyChangeRepairs.changeCommitment,
              changeCommitment,
            ),
            isNull(reflectionRecordDependencyChangeRepairs.completedAt),
          )));
      } else {
        await executeTypedRecordProductQuery(tx, recordProductTypedDb
          .update(reflectionRecordDependencyChangeRepairs)
          .set({ completedAt: now, updatedAt: now })
          .where(and(
            eq(
              reflectionRecordDependencyChangeRepairs.changeCommitment,
              changeCommitment,
            ),
            isNull(reflectionRecordDependencyChangeRepairs.completedAt),
          )));
      }
      return { consumed: 1, admitted, pending };
    }, { isolationLevel: "read committed" });
  }

  /**
   * Advance at most one durable source-change cursor and one bounded dependent
   * page atomically. A crash rolls back both admissions and the cursor.
   */
  repairSourceDependentsPage(input: Readonly<{
    limit: number;
  }>): Promise<SemanticSourceRepairDrainResult> {
    assertPageLimit(input.limit);
    return this.options.handle.transaction(async (tx) => {
      const repairs = await tx.query(
        `SELECT source_change_commitment, source_dependency_commitment, continuation
           FROM reflection_record_source_change_repairs
          WHERE completed_at IS NULL
          ORDER BY created_at, source_change_commitment
          FOR UPDATE SKIP LOCKED
          LIMIT 1`,
      );
      const repair = repairs[0];
      if (repair === undefined) {
        return { consumed: 0, admitted: 0, pending: false };
      }
      const sourceChangeCommitment = rowBytes(repair, "source_change_commitment");
      const sourceDependencyCommitment = rowBytes(
        repair,
        "source_dependency_commitment",
      );
      const rawContinuation = repair["continuation"];
      if (rawContinuation !== null && typeof rawContinuation !== "string") {
        throw new TypeError("Invalid semantic source repair cursor");
      }
      const rows = await executeTypedRecordProductQuery(tx,
        recordProductTypedDb.select({
          record_id: reflectionRecordSourceDependencyIndex.recordId,
        })
          .from(reflectionRecordSourceDependencyIndex)
          .innerJoin(
            reflectionRecords,
            eq(
              reflectionRecords.recordId,
              reflectionRecordSourceDependencyIndex.recordId,
            ),
          )
          .where(and(
            eq(
              reflectionRecordSourceDependencyIndex.sourceDependencyCommitment,
              sourceDependencyCommitment,
            ),
            eq(reflectionRecords.disposition, "available"),
            rawContinuation === null
              ? undefined
              : gt(reflectionRecordSourceDependencyIndex.recordId, rawContinuation),
          ))
          .orderBy(asc(reflectionRecordSourceDependencyIndex.recordId))
          .limit(input.limit + 1));
      const selected = rows.slice(0, input.limit);
      const now = this.#clock();
      let admitted = 0;
      for (const row of selected) {
        const result = await admitSemanticWorkWithinTransaction(tx, {
          recordRef: rowString(row, "record_id"),
          changeReason: "dependency_lost",
          admissionCommitment: sourceChangeCommitment,
          now,
        });
        if (result.admitted) admitted += 1;
      }
      const pending = rows.length > input.limit;
      if (pending) {
        await executeTypedRecordProductQuery(tx, recordProductTypedDb
          .update(reflectionRecordSourceChangeRepairs)
          .set({
            continuation: rowString(selected.at(-1)!, "record_id"),
            updatedAt: now,
          })
          .where(and(
            eq(
              reflectionRecordSourceChangeRepairs.sourceChangeCommitment,
              sourceChangeCommitment,
            ),
            isNull(reflectionRecordSourceChangeRepairs.completedAt),
          )));
      } else {
        await executeTypedRecordProductQuery(tx, recordProductTypedDb
          .update(reflectionRecordSourceChangeRepairs)
          .set({ completedAt: now, updatedAt: now })
          .where(and(
            eq(
              reflectionRecordSourceChangeRepairs.sourceChangeCommitment,
              sourceChangeCommitment,
            ),
            isNull(reflectionRecordSourceChangeRepairs.completedAt),
          )));
      }
      return {
        consumed: Math.max(1, selected.length),
        admitted,
        pending,
      };
    }, { isolationLevel: "read committed" });
  }

  async #claimedMutation(
    claim: DurableSleepClaim,
    mutate: (tx: RecordProductPostgresExecutor, now: Date) => Promise<boolean>,
  ): Promise<DurableSleepLeaseResult> {
    const mutationStartedAt = performance.now();
    const result = await this.options.handle.transaction(async (tx) => {
      const now = this.#clock();
      if (await mutate(tx, now)) {
        return {
          status: "accepted" as const,
          completedAtEpochMs: now.getTime(),
        };
      }
      return this.#miss(tx, claim);
    }, { isolationLevel: "read committed" });
    if (result.status !== "accepted") return result;
    return {
      status: "accepted",
      timing: {
        completedAtEpochMs: result.completedAtEpochMs,
        mutationElapsedMs: Math.max(
          0,
          Math.round(performance.now() - mutationStartedAt),
        ),
      },
    };
  }

  async #claimedDeferral(
    claim: DurableSleepClaim,
    mutate: (
      tx: RecordProductPostgresExecutor,
      now: Date,
    ) => Promise<"deferred" | "quarantined" | null>,
  ): Promise<DurableSleepDeferralResult> {
    return this.options.handle.transaction(async (tx) => {
      const disposition = await mutate(tx, this.#clock());
      if (disposition !== null) return { status: disposition };
      return this.#miss(tx, claim);
    }, { isolationLevel: "read committed" });
  }

  async #miss(
    tx: RecordProductPostgresExecutor,
    claim: DurableSleepClaim,
  ): Promise<Readonly<{ status: "superseded" | "lease_lost" }>> {
    const rows = await executeTypedRecordProductQuery(tx,
      recordProductTypedDb.select({
        generation: reflectionRecordSemanticWork.generation,
      })
        .from(reflectionRecordSemanticWork)
        .where(eq(reflectionRecordSemanticWork.recordId, claim.recordRef)));
    return rows.length > 0 && rowInteger(rows[0]!, "generation") > claim.generation
      ? { status: "superseded" }
      : { status: "lease_lost" };
  }
}
