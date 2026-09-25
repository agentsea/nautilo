import { BACKGROUND_AUTHORIZATION_MAX_IDENTIFIER_BYTES } from
  "../protected-execution/background-authorization/lifecycle";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;
const TASK_DEFINITION_OBJECT_ID = /^task-definition:v1:[0-9a-f]{64}$/u;
const TASK_RUN_RESULT_OBJECT_ID = /^task-run-result:v1:[0-9a-f]{64}$/u;
const encoder = new TextEncoder();

/**
 * Content-free durable correlation for one protected Task occurrence.
 *
 * This reference carries no decryption capability. In particular, the
 * authorization request id identifies durable lifecycle state; loading it
 * cannot reconstruct a process-local accepted authority.
 */
export type ProtectedTaskJobReferenceV1 = Readonly<{
  kind: "protected_task_run_v1";
  taskId: string;
  taskRunId: string;
  inputObjectId: string;
  resultObjectId: string;
  authorizationRequestId: string;
  policyRevision: number;
}>;

function isPortableIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && PORTABLE_ID.test(value)
    && encoder.encode(value).length <= BACKGROUND_AUTHORIZATION_MAX_IDENTIFIER_BYTES;
}

/** Validate the exact durable shape before any Job row is written. */
export function assertProtectedTaskJobReferenceV1(
  value: unknown,
): asserts value is ProtectedTaskJobReferenceV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Protected Task durable Job reference is invalid");
  }
  const reference = value as Record<string, unknown>;
  if (
    Object.keys(reference).sort().join(",")
      !== "authorizationRequestId,inputObjectId,kind,policyRevision,resultObjectId,taskId,taskRunId"
    || reference["kind"] !== "protected_task_run_v1"
    || typeof reference["taskId"] !== "string"
    || !UUID.test(reference["taskId"])
    || typeof reference["taskRunId"] !== "string"
    || !UUID.test(reference["taskRunId"])
    || typeof reference["inputObjectId"] !== "string"
    || !TASK_DEFINITION_OBJECT_ID.test(reference["inputObjectId"])
    || typeof reference["resultObjectId"] !== "string"
    || !TASK_RUN_RESULT_OBJECT_ID.test(reference["resultObjectId"])
    || !isPortableIdentifier(reference["authorizationRequestId"])
    || !Number.isSafeInteger(reference["policyRevision"])
    || (reference["policyRevision"] as number) < 1
  ) {
    throw new TypeError("Protected Task durable Job reference is invalid");
  }
}
