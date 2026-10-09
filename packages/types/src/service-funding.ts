import { parseTaskFundingBinding, type TaskFundingBinding } from "./task-funding";

export const PAID_SERVICE_PROVIDERS = [
  "tavily",
  "browser-use",
  "cloudconvert",
] as const;

export type PaidServiceProvider = (typeof PAID_SERVICE_PROVIDERS)[number];

/** Non-secret creating-account facts persisted by the owning service lifecycle. */
export interface DurableServiceFundingBinding {
  readonly humanUserId: string;
  readonly provider: PaidServiceProvider;
  readonly binding: TaskFundingBinding;
  readonly credentialFingerprint: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

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

export function isPaidServiceProvider(value: unknown): value is PaidServiceProvider {
  return typeof value === "string"
    && (PAID_SERVICE_PROVIDERS as readonly string[]).includes(value);
}

/** Parse persisted service funding without accepting widened or secret-bearing shapes. */
export function parseDurableServiceFundingBinding(
  value: unknown,
): DurableServiceFundingBinding {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      "humanUserId",
      "provider",
      "binding",
      "credentialFingerprint",
    ])
    || typeof value["humanUserId"] !== "string"
    || !UUID_PATTERN.test(value["humanUserId"])
    || !isPaidServiceProvider(value["provider"])
    || typeof value["credentialFingerprint"] !== "string"
    || !SHA256_PATTERN.test(value["credentialFingerprint"])
  ) {
    throw new TypeError("Durable service funding binding is malformed");
  }
  const binding = parseTaskFundingBinding(value["binding"]);
  if (binding.providerRoute !== value["provider"]) {
    throw new TypeError("Durable service funding binding is malformed");
  }
  return Object.freeze({
    humanUserId: value["humanUserId"],
    provider: value["provider"],
    binding,
    credentialFingerprint: value["credentialFingerprint"],
  });
}
