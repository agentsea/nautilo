/** Durable, non-secret funding facts for native Task execution. */
export const TASK_FUNDING_MODES = ["legacy_server", "caller"] as const;

export type TaskFundingMode = (typeof TASK_FUNDING_MODES)[number];

export type TaskFundingBinding =
  | Readonly<{
      kind: "server";
      providerRoute: string;
    }>
  | Readonly<{
      kind: "personal";
      providerRoute: string;
      credentialId: string;
      credentialRevision: number;
    }>;

export const TASK_FUNDING_FAILURE_CODES = [
  "personal_credentials_disabled",
  "personal_credentials_forbidden",
  "personal_credential_missing",
  "server_credentials_forbidden",
  "provider_credentials_missing",
  "personal_credential_stale",
  "personal_credential_unavailable",
  "personal_provider_unavailable",
  "funding_source_changed",
  "unsupported_workload",
  "unsupported_provider",
  "funding_interrupted_uncertain",
] as const;

export type TaskFundingFailureCode =
  (typeof TASK_FUNDING_FAILURE_CODES)[number];

const PROVIDER_ROUTE_PATTERN = /^[a-z][a-z0-9-]*$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function validProviderRoute(value: unknown): value is string {
  return typeof value === "string" && PROVIDER_ROUTE_PATTERN.test(value);
}

/**
 * Parse a database funding binding without accepting widened or secret-bearing
 * shapes. Explicit null is the legacy representation and must be handled by
 * the caller together with Task.fundingMode.
 */
export function parseTaskFundingBinding(value: unknown): TaskFundingBinding {
  if (!isRecord(value) || !validProviderRoute(value["providerRoute"])) {
    throw new TypeError("Task funding binding is malformed");
  }
  if (value["kind"] === "server" && hasExactKeys(value, ["kind", "providerRoute"])) {
    return Object.freeze({ kind: "server", providerRoute: value["providerRoute"] });
  }
  if (
    value["kind"] === "personal"
    && hasExactKeys(value, [
      "kind",
      "providerRoute",
      "credentialId",
      "credentialRevision",
    ])
    && typeof value["credentialId"] === "string"
    && UUID_PATTERN.test(value["credentialId"])
    && Number.isSafeInteger(value["credentialRevision"])
    && (value["credentialRevision"] as number) >= 1
  ) {
    return Object.freeze({
      kind: "personal",
      providerRoute: value["providerRoute"],
      credentialId: value["credentialId"],
      credentialRevision: value["credentialRevision"] as number,
    });
  }
  throw new TypeError("Task funding binding is malformed");
}

const TASK_FUNDING_FAILURE_MESSAGES: Readonly<Record<TaskFundingFailureCode, string>> = {
  personal_credentials_disabled: "Personal provider credentials are disabled.",
  personal_credentials_forbidden: "Personal provider credentials are not permitted.",
  personal_credential_missing: "A personal provider credential is missing.",
  server_credentials_forbidden: "Server provider credentials are not permitted.",
  provider_credentials_missing: "Provider credentials are not configured.",
  personal_credential_stale: "The admitted personal provider credential changed.",
  personal_credential_unavailable: "The personal provider credential is unavailable.",
  personal_provider_unavailable: "The personal provider rejected or could not complete this request.",
  funding_source_changed: "The admitted funding source changed.",
  unsupported_workload: "Personal funding is not supported for this work.",
  unsupported_provider: "Personal funding is not supported for this provider.",
  funding_interrupted_uncertain: "The funding attempt was interrupted with an uncertain result.",
};

export function taskFundingFailureMessage(code: TaskFundingFailureCode): string {
  return TASK_FUNDING_FAILURE_MESSAGES[code];
}
