import {
  and,
  asc,
  eq,
  reflectionRecordAuthorityDependencies,
  reflectionRecordDependencies,
  reflectionRecords,
  reflectionRecordSuccessors,
  reflectionRecordPayloadRepresentations,
  sql,
} from "@nautilo/db";
import type { GroundedDependencyRecordStatePort } from "./dependency-loss-resolver";
import { executeTypedRecordProductQuery, recordProductTypedDb, type RecordProductPostgresHandle } from "./product-postgres";

/** Canonical lifecycle facts for repair; never opens a withdrawn payload. */
export class PostgresGroundedDependencyRecordState implements GroundedDependencyRecordStatePort {
  constructor(private readonly handle: RecordProductPostgresHandle) {}

  /** Recover only the logical coordinate from a persisted grant, never its body. */
  async readRecordRefForProtectedObject(objectId: string): Promise<string | null> {
    const rows = await executeTypedRecordProductQuery(this.handle, recordProductTypedDb.select({
      recordId: reflectionRecordPayloadRepresentations.recordId,
    }).from(reflectionRecordPayloadRepresentations).where(and(
      eq(reflectionRecordPayloadRepresentations.cryptoObjectId, objectId),
      eq(reflectionRecordPayloadRepresentations.representation, "protected"),
    )).limit(2));
    return rows.length === 1 ? rows[0]!.record_id : null;
  }

  async readState(recordRef: string): ReturnType<GroundedDependencyRecordStatePort["readState"]> {
    const rows = await executeTypedRecordProductQuery(this.handle, recordProductTypedDb.select({
      lifecycle: reflectionRecords.lifecycle,
      processingGeneration: reflectionRecords.processingGeneration,
      disposition: reflectionRecords.disposition,
    }).from(reflectionRecords).where(eq(reflectionRecords.recordId, recordRef)).limit(1));
    const row = rows[0];
    if (row === undefined) return {status: "unavailable"};
    return {status: "available", lifecycle: row.lifecycle,
      processingGeneration: row.processing_generation, disposition: row.disposition};
  }
  async readSuccessors(input: {recordRef: string; limit: 2}): ReturnType<GroundedDependencyRecordStatePort["readSuccessors"]> {
    const rows = await executeTypedRecordProductQuery(this.handle, recordProductTypedDb.select({
      successorRecordRef: reflectionRecordSuccessors.successorRecordId,
    }).from(reflectionRecordSuccessors).where(eq(reflectionRecordSuccessors.predecessorRecordId, input.recordRef))
      .orderBy(asc(reflectionRecordSuccessors.successorRecordId)).limit(input.limit + 1));
    return {status: "available", successorRecordRefs: rows.slice(0, input.limit).map(row => row.successor_record_id),
      complete: rows.length <= input.limit};
  }

  async readDependencyRecordRefs(input: {
    recordRef: string;
    limit: number;
  }): ReturnType<NonNullable<GroundedDependencyRecordStatePort["readDependencyRecordRefs"]>> {
    const dependencies = recordProductTypedDb.select({
      dependency_record_ref: sql<string>`${reflectionRecordDependencies.childRecordId}`
        .as("dependency_record_ref"),
    }).from(reflectionRecordDependencies).where(eq(
      reflectionRecordDependencies.parentRecordId,
      input.recordRef,
    )).union(recordProductTypedDb.select({
      dependency_record_ref:
        sql<string>`${reflectionRecordAuthorityDependencies.dependencyRecordId}`
          .as("dependency_record_ref"),
    }).from(reflectionRecordAuthorityDependencies).where(eq(
      reflectionRecordAuthorityDependencies.recordId,
      input.recordRef,
    ))).as("record_dependency_refs");
    const rows = await executeTypedRecordProductQuery(this.handle,
      recordProductTypedDb.select({
        dependency_record_ref: dependencies.dependency_record_ref,
      }).from(dependencies)
        .orderBy(asc(dependencies.dependency_record_ref))
        .limit(input.limit + 1));
    return {
      status: "available",
      dependencyRecordRefs: rows.slice(0, input.limit)
        .map((row) => row.dependency_record_ref),
      complete: rows.length <= input.limit,
    };
  }

}
