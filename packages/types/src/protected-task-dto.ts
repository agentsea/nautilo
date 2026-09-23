export const PROTECTED_TASK_CONTENT_DTO_VERSION_V1 = 1 as const;
export const PROTECTED_TASK_PORTABLE_ID_MAX_UTF8_BYTES_V1 = 128;

/**
 * Opaque protected-content coordinates. Decrypted Task text is deliberately
 * absent so server/API projections can be shared with authorized clients.
 */
export type ProtectedTaskContentDtoV1 = Readonly<{
  dtoVersion: typeof PROTECTED_TASK_CONTENT_DTO_VERSION_V1;
  status: "protected";
  objectId: string;
  contentRevision: number;
  cryptoAccessRevision: number;
}>;

export type ProtectedTaskContentUnavailableReasonV1 =
  | "waiting_for_authorization"
  | "device_not_ready"
  | "authority_changed"
  | "unsupported_client"
  | "integrity_failure";

export type ProtectedTaskContentUnavailableDtoV1 = Readonly<{
  dtoVersion: typeof PROTECTED_TASK_CONTENT_DTO_VERSION_V1;
  status: "unavailable";
  reason: ProtectedTaskContentUnavailableReasonV1;
}>;

export type ProtectedTaskContentResponseV1 =
  | ProtectedTaskContentDtoV1
  | ProtectedTaskContentUnavailableDtoV1;

/** Definition and result coordinates stay explicit at their containing API. */
export type ProtectedTaskDefinitionDtoV1 = Readonly<{
  taskId: string;
  content: ProtectedTaskContentResponseV1;
}>;

export type ProtectedTaskRunResultDtoV1 = Readonly<{
  taskId: string;
  taskRunId: string;
  content: ProtectedTaskContentResponseV1;
}>;

const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;
const UNAVAILABLE_REASONS = new Set<string>([
  "waiting_for_authorization",
  "device_not_ready",
  "authority_changed",
  "unsupported_client",
  "integrity_failure",
]);
const encoder = new TextEncoder();

function ownRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactFields(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  const fields = new Set(expected);
  return keys.length === expected.length && keys.every((key) => {
    if (typeof key !== "string" || !fields.has(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined
      && descriptor.enumerable
      && "value" in descriptor;
  });
}

function portableId(value: unknown): value is string {
  return typeof value === "string"
    && PORTABLE_ID.test(value)
    && encoder.encode(value).length <= PROTECTED_TASK_PORTABLE_ID_MAX_UTF8_BYTES_V1;
}

function revision(value: unknown, minimum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

/** Strict parser for server/client boundaries; decrypted fields are rejected. */
export function parseProtectedTaskContentResponseV1(
  value: unknown,
): ProtectedTaskContentResponseV1 {
  if (!ownRecord(value) || value["dtoVersion"] !== 1) {
    throw new TypeError("Protected Task content DTO is invalid");
  }
  if (value["status"] === "protected") {
    if (
      !exactFields(value, [
        "dtoVersion",
        "status",
        "objectId",
        "contentRevision",
        "cryptoAccessRevision",
      ])
      || !portableId(value["objectId"])
      || !revision(value["contentRevision"], 1)
      || !revision(value["cryptoAccessRevision"], 0)
    ) throw new TypeError("Protected Task content DTO is invalid");
    return Object.freeze({
      dtoVersion: PROTECTED_TASK_CONTENT_DTO_VERSION_V1,
      status: "protected",
      objectId: value["objectId"],
      contentRevision: value["contentRevision"],
      cryptoAccessRevision: value["cryptoAccessRevision"],
    });
  }
  if (
    value["status"] !== "unavailable"
    || !exactFields(value, ["dtoVersion", "status", "reason"])
    || typeof value["reason"] !== "string"
    || !UNAVAILABLE_REASONS.has(value["reason"])
  ) throw new TypeError("Protected Task content DTO is invalid");
  return Object.freeze({
    dtoVersion: PROTECTED_TASK_CONTENT_DTO_VERSION_V1,
    status: "unavailable",
    reason: value["reason"] as ProtectedTaskContentUnavailableReasonV1,
  });
}

export function parseProtectedTaskDefinitionDtoV1(
  value: unknown,
): ProtectedTaskDefinitionDtoV1 {
  if (
    !ownRecord(value)
    || !exactFields(value, ["taskId", "content"])
    || !portableId(value["taskId"])
  ) throw new TypeError("Protected Task definition DTO is invalid");
  return Object.freeze({
    taskId: value["taskId"],
    content: parseProtectedTaskContentResponseV1(value["content"]),
  });
}

export function parseProtectedTaskRunResultDtoV1(
  value: unknown,
): ProtectedTaskRunResultDtoV1 {
  if (
    !ownRecord(value)
    || !exactFields(value, ["taskId", "taskRunId", "content"])
    || !portableId(value["taskId"])
    || !portableId(value["taskRunId"])
  ) throw new TypeError("Protected Task run result DTO is invalid");
  return Object.freeze({
    taskId: value["taskId"],
    taskRunId: value["taskRunId"],
    content: parseProtectedTaskContentResponseV1(value["content"]),
  });
}
