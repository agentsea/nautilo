export const PROTECTED_TASK_ADDITIONAL_AUTHORITY_GRANTED_V1 =
  "protected_task_additional_authority_granted_v1" as const;

export type ProtectedTaskAdditionalAuthorityResumeAcknowledgementV1 = Readonly<{
  type: typeof PROTECTED_TASK_ADDITIONAL_AUTHORITY_GRANTED_V1;
  authorizationRequestId: string;
  effectDisposition: "not_started_v1";
  operationId: string;
  requestDigest: Uint8Array;
  requiredAuthorityDigest: Uint8Array;
}>;

export type ProtectedTaskAdditionalAuthorityResumeBindingV1 = Readonly<{
  interruptId: string;
  authorizationRequestId: string;
  effectDisposition: "not_started_v1";
  operationId: string;
  requestDigest: Uint8Array;
  requiredAuthorityDigest: Uint8Array;
}>;

type ExpectedAcknowledgement = Omit<
  ProtectedTaskAdditionalAuthorityResumeBindingV1,
  "interruptId"
>;

const ACKNOWLEDGEMENT_KEYS = Object.freeze([
  "authorizationRequestId",
  "effectDisposition",
  "operationId",
  "requestDigest",
  "requiredAuthorityDigest",
  "type",
].sort());
const BINDING_KEYS = Object.freeze([
  "authorizationRequestId",
  "effectDisposition",
  "interruptId",
  "operationId",
  "requestDigest",
  "requiredAuthorityDigest",
].sort());

function exactKeys(value: Record<string, unknown>): boolean {
  return Object.keys(value).sort().join(",") === ACKNOWLEDGEMENT_KEYS.join(",");
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function digest(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array && value.length === 32;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function exactBinding(
  binding: ProtectedTaskAdditionalAuthorityResumeBindingV1,
): void {
  if (typeof binding !== "object" || binding === null
    || Array.isArray(binding)
    || Object.keys(binding).sort().join(",") !== BINDING_KEYS.join(",")
    || !nonEmpty(binding.interruptId)
    || !nonEmpty(binding.authorizationRequestId)
    || binding.effectDisposition !== "not_started_v1"
    || !nonEmpty(binding.operationId)
    || !digest(binding.requestDigest)
    || !digest(binding.requiredAuthorityDigest)) {
    throw new TypeError(
      "Protected Task additional-authority resume binding is invalid",
    );
  }
}

/**
 * Build the content-free acknowledgement routed to one exact pending LangGraph
 * interrupt. The interrupt ID stays in Command.resume's key space rather than
 * being duplicated inside the acknowledgement value.
 */
export function createProtectedTaskAdditionalAuthorityResumeMapV1(
  binding: ProtectedTaskAdditionalAuthorityResumeBindingV1,
): Readonly<Record<string, ProtectedTaskAdditionalAuthorityResumeAcknowledgementV1>> {
  exactBinding(binding);
  const acknowledgement = Object.freeze({
    type: PROTECTED_TASK_ADDITIONAL_AUTHORITY_GRANTED_V1,
    authorizationRequestId: binding.authorizationRequestId,
    effectDisposition: binding.effectDisposition,
    operationId: binding.operationId,
    requestDigest: binding.requestDigest.slice(),
    requiredAuthorityDigest: binding.requiredAuthorityDigest.slice(),
  });
  return Object.freeze({ [binding.interruptId]: acknowledgement });
}

/** Validate the routed acknowledgement against the original pre-effect proof. */
export function assertProtectedTaskAdditionalAuthorityResumeAcknowledgementV1(
  value: unknown,
  expected: ExpectedAcknowledgement,
): asserts value is ProtectedTaskAdditionalAuthorityResumeAcknowledgementV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(
      "Protected Task additional-authority acknowledgement is invalid",
    );
  }
  const acknowledgement = value as Record<string, unknown>;
  if (!exactKeys(acknowledgement)
    || acknowledgement["type"]
      !== PROTECTED_TASK_ADDITIONAL_AUTHORITY_GRANTED_V1
    || acknowledgement["authorizationRequestId"]
      !== expected.authorizationRequestId
    || acknowledgement["effectDisposition"] !== "not_started_v1"
    || expected.effectDisposition !== "not_started_v1"
    || acknowledgement["operationId"] !== expected.operationId
    || !digest(acknowledgement["requestDigest"])
    || !digest(acknowledgement["requiredAuthorityDigest"])
    || !digest(expected.requestDigest)
    || !digest(expected.requiredAuthorityDigest)
    || !sameBytes(acknowledgement["requestDigest"], expected.requestDigest)
    || !sameBytes(
      acknowledgement["requiredAuthorityDigest"],
      expected.requiredAuthorityDigest,
    )) {
    throw new TypeError(
      "Protected Task additional-authority acknowledgement is invalid",
    );
  }
}
