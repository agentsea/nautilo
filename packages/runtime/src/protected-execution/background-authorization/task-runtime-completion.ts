import { completeBackgroundAuthorizationRequest } from "./lifecycle";
import {
  sameBackgroundAuthorizationRecord,
  type BackgroundAuthorizationRecord,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
} from "./repository";

/** Exact durable completion recognized by both live execution and recovery. */
export function isExactCompletedTaskRuntimeSuccessor(
  current: BackgroundAuthorizationRecord | null,
  expected: BackgroundAuthorizationTaskRuntimeRecordV3,
): boolean {
  if (
    current === null
    || current.snapshot.formatVersion !== 3
    || current.snapshot.credentialSubject.kind !== "runtime"
    || current.snapshot.credentialSubject.runtimeKind !== "task"
    || current.snapshot.credentialSubject.runtimeVersion !== 1
    || current.authoritySet === undefined
    || current.snapshot.state !== "completed"
    || (
      expected.snapshot.state !== "running"
      && expected.snapshot.state !== "publication_reconciliation"
    )
  ) return false;
  try {
    const snapshot = completeBackgroundAuthorizationRequest(
      expected.snapshot,
      current.snapshot.updatedAt,
    ) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"];
    return sameBackgroundAuthorizationRecord(current, {
      ...expected,
      snapshot,
      finishedAt: current.snapshot.updatedAt,
    });
  } catch {
    return false;
  }
}
