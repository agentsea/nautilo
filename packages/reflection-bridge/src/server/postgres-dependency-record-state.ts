import { and, asc, eq, reflectionRecords, reflectionRecordSuccessors, reflectionRecordPayloadRepresentations } from "@nautilo/db";
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

}
