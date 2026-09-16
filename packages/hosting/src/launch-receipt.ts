import type { HostingBackend, HostingResourceReference } from "./types";

export const LAUNCH_RECEIPT_SCHEMA_VERSION = 1 as const;

export const LAUNCH_RECEIPT_STAGES = [
  "planned",
  "authorized",
  "provisioning",
  "bootstrapping",
  "claimable",
] as const;

export type LaunchReceiptStage = (typeof LAUNCH_RECEIPT_STAGES)[number];

export const LAUNCH_RECEIPT_FAILURE_KINDS = [
  "authorization",
  "permission",
  "rate-limited",
  "provider",
  "validation",
  "interrupted",
  "unknown",
] as const;

export type LaunchReceiptFailureKind =
  (typeof LAUNCH_RECEIPT_FAILURE_KINDS)[number];

export const LAUNCH_RECEIPT_CLEANUP_STATES = [
  "not-required",
  "pending",
  "in-progress",
  "failed",
  "verified",
] as const;

export type LaunchReceiptCleanupState =
  (typeof LAUNCH_RECEIPT_CLEANUP_STATES)[number];

/**
 * Deliberately excludes a message, cause, stack, request, response, and provider
 * payload. Those fields routinely contain credentials and are not needed to
 * decide whether a launch can be retried.
 */
export interface LaunchReceiptFailureSummary {
  readonly kind: LaunchReceiptFailureKind;
  readonly operation: string;
  readonly retryable: boolean;
  readonly occurredAt: string;
}

export interface LaunchReceiptCleanup {
  readonly state: LaunchReceiptCleanupState;
  readonly verifiedAt?: string | undefined;
}

/**
 * Non-secret durable identity for one launch attempt. Provider credentials,
 * environment maps, credential-bearing URLs, and raw errors never belong here.
 */
export interface LaunchReceiptV1 {
  readonly schemaVersion: typeof LAUNCH_RECEIPT_SCHEMA_VERSION;
  readonly launchId: string;
  readonly backend: HostingBackend;
  /** Starts at zero and advances by exactly one for every persisted update. */
  readonly revision: number;
  readonly stage: LaunchReceiptStage;
  readonly resources: readonly HostingResourceReference[];
  readonly lastFailure?: LaunchReceiptFailureSummary | undefined;
  readonly cleanup: LaunchReceiptCleanup;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly claimableAt?: string | undefined;
}

export type LaunchReceipt = LaunchReceiptV1;

export type LaunchReceiptValidationCode =
  | "invalid-type"
  | "unknown-field"
  | "unsupported-version"
  | "invalid-value"
  | "duplicate-resource"
  | "conflicting-resource"
  | "secret-material"
  | "invalid-transition";

export type LaunchReceiptValidationResult =
  | { readonly ok: true; readonly receipt: LaunchReceipt }
  | {
      readonly ok: false;
      readonly code: LaunchReceiptValidationCode;
      readonly path: string;
    };

export type LaunchReceiptTransitionResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: "invalid-transition";
      readonly path: string;
    };

const RECEIPT_KEYS = new Set([
  "schemaVersion",
  "launchId",
  "backend",
  "revision",
  "stage",
  "resources",
  "lastFailure",
  "cleanup",
  "createdAt",
  "updatedAt",
  "claimableAt",
]);
const RESOURCE_KEYS = new Set(["kind", "id", "name"]);
const FAILURE_KEYS = new Set(["kind", "operation", "retryable", "occurredAt"]);
const CLEANUP_KEYS = new Set(["state", "verifiedAt"]);
const BACKENDS = new Set<HostingBackend>([
  "railway",
  "digitalocean-droplet",
]);
const STAGES = new Set<string>(LAUNCH_RECEIPT_STAGES);
const FAILURE_KINDS = new Set<string>(LAUNCH_RECEIPT_FAILURE_KINDS);
const CLEANUP_STATES = new Set<string>(LAUNCH_RECEIPT_CLEANUP_STATES);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_KIND = /^[a-z][a-z0-9.-]{0,63}$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,159}$/;
const SAFE_OPERATION = /^[a-z][a-z0-9.-]{0,63}$/;
const FORBIDDEN_KEY =
  /(?:token|secret|password|credential|api[_-]?key|authorization|cookie|environment|variables?|env|raw|stack|cause|message|error)/i;
const SECRET_LIKE_VALUE =
  /(?:\bBearer\s+\S+|:\/\/[^\s/:@]+:[^\s/@]+@|^(?:sk|pk|rk|gsk|tvly|xi|dop|railway)[_-][A-Za-z0-9_-]{8,}$|^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$)/i;

type PlainObject = Record<string, unknown> & {
  readonly schemaVersion?: unknown;
  readonly launchId?: unknown;
  readonly backend?: unknown;
  readonly revision?: unknown;
  readonly stage?: unknown;
  readonly resources?: unknown;
  readonly lastFailure?: unknown;
  readonly cleanup?: unknown;
  readonly createdAt?: unknown;
  readonly updatedAt?: unknown;
  readonly claimableAt?: unknown;
  readonly kind?: unknown;
  readonly id?: unknown;
  readonly name?: unknown;
  readonly operation?: unknown;
  readonly retryable?: unknown;
  readonly occurredAt?: unknown;
  readonly state?: unknown;
  readonly verifiedAt?: unknown;
};

function isPlainObject(value: unknown): value is PlainObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function invalid(
  code: LaunchReceiptValidationCode,
  path: string,
): LaunchReceiptValidationResult {
  return { ok: false, code, path };
}

function secretPath(value: unknown, path = "$"): string | undefined {
  if (typeof value === "string") {
    return SECRET_LIKE_VALUE.test(value) ? path : undefined;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = secretPath(value[index], `${path}[${String(index)}]`);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isPlainObject(value)) return undefined;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) return `${path}.${key}`;
    const found = secretPath(nested, `${path}.${key}`);
    if (found !== undefined) return found;
  }
  return undefined;
}

function unknownField(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): string | undefined {
  const key = Object.keys(value).find((candidate) => !allowed.has(candidate));
  return key === undefined ? undefined : `${path}.${key}`;
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function parseResource(
  value: unknown,
  path: string,
):
  | { readonly ok: true; readonly resource: HostingResourceReference }
  | { readonly ok: false; readonly path: string; readonly code: LaunchReceiptValidationCode } {
  if (!isPlainObject(value)) return { ok: false, code: "invalid-type", path };
  const extra = unknownField(value, RESOURCE_KEYS, path);
  if (extra !== undefined) return { ok: false, code: "unknown-field", path: extra };
  if (typeof value.kind !== "string" || !SAFE_KIND.test(value.kind)) {
    return { ok: false, code: "invalid-value", path: `${path}.kind` };
  }
  if (typeof value.id !== "string" || !SAFE_ID.test(value.id)) {
    return { ok: false, code: "invalid-value", path: `${path}.id` };
  }
  if (
    value.name !== undefined &&
    (typeof value.name !== "string" || !SAFE_NAME.test(value.name))
  ) {
    return { ok: false, code: "invalid-value", path: `${path}.name` };
  }
  return {
    ok: true,
    resource: {
      kind: value.kind,
      id: value.id,
      ...(value.name === undefined ? {} : { name: value.name }),
    },
  };
}

function parseFailure(
  value: unknown,
):
  | { readonly ok: true; readonly failure: LaunchReceiptFailureSummary }
  | { readonly ok: false; readonly path: string; readonly code: LaunchReceiptValidationCode } {
  const path = "$.lastFailure";
  if (!isPlainObject(value)) return { ok: false, code: "invalid-type", path };
  const extra = unknownField(value, FAILURE_KEYS, path);
  if (extra !== undefined) return { ok: false, code: "unknown-field", path: extra };
  if (typeof value.kind !== "string" || !FAILURE_KINDS.has(value.kind)) {
    return { ok: false, code: "invalid-value", path: `${path}.kind` };
  }
  if (typeof value.operation !== "string" || !SAFE_OPERATION.test(value.operation)) {
    return { ok: false, code: "invalid-value", path: `${path}.operation` };
  }
  if (typeof value.retryable !== "boolean") {
    return { ok: false, code: "invalid-type", path: `${path}.retryable` };
  }
  if (!isTimestamp(value.occurredAt)) {
    return { ok: false, code: "invalid-value", path: `${path}.occurredAt` };
  }
  return {
    ok: true,
    failure: {
      kind: value.kind as LaunchReceiptFailureKind,
      operation: value.operation,
      retryable: value.retryable,
      occurredAt: value.occurredAt,
    },
  };
}

function parseCleanup(
  value: unknown,
):
  | { readonly ok: true; readonly cleanup: LaunchReceiptCleanup }
  | { readonly ok: false; readonly path: string; readonly code: LaunchReceiptValidationCode } {
  const path = "$.cleanup";
  if (!isPlainObject(value)) return { ok: false, code: "invalid-type", path };
  const extra = unknownField(value, CLEANUP_KEYS, path);
  if (extra !== undefined) return { ok: false, code: "unknown-field", path: extra };
  if (typeof value.state !== "string" || !CLEANUP_STATES.has(value.state)) {
    return { ok: false, code: "invalid-value", path: `${path}.state` };
  }
  if (value.verifiedAt !== undefined && !isTimestamp(value.verifiedAt)) {
    return { ok: false, code: "invalid-value", path: `${path}.verifiedAt` };
  }
  if ((value.state === "verified") !== (value.verifiedAt !== undefined)) {
    return { ok: false, code: "invalid-value", path: `${path}.verifiedAt` };
  }
  return {
    ok: true,
    cleanup: {
      state: value.state as LaunchReceiptCleanupState,
      ...(value.verifiedAt === undefined ? {} : { verifiedAt: value.verifiedAt }),
    },
  };
}

export function parseLaunchReceipt(value: unknown): LaunchReceiptValidationResult {
  const secret = secretPath(value);
  if (secret !== undefined) return invalid("secret-material", secret);
  if (!isPlainObject(value)) return invalid("invalid-type", "$");

  if (value.schemaVersion !== LAUNCH_RECEIPT_SCHEMA_VERSION) {
    return invalid("unsupported-version", "$.schemaVersion");
  }
  const extra = unknownField(value, RECEIPT_KEYS, "$");
  if (extra !== undefined) return invalid("unknown-field", extra);
  if (typeof value.launchId !== "string" || !SAFE_ID.test(value.launchId)) {
    return invalid("invalid-value", "$.launchId");
  }
  if (typeof value.backend !== "string" || !BACKENDS.has(value.backend as HostingBackend)) {
    return invalid("invalid-value", "$.backend");
  }
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) {
    return invalid("invalid-value", "$.revision");
  }
  if (typeof value.stage !== "string" || !STAGES.has(value.stage)) {
    return invalid("invalid-value", "$.stage");
  }
  if (!Array.isArray(value.resources)) return invalid("invalid-type", "$.resources");

  const resources: HostingResourceReference[] = [];
  const exactReferences = new Set<string>();
  const logicalReferences = new Map<string, string>();
  for (let index = 0; index < value.resources.length; index += 1) {
    const parsed = parseResource(value.resources[index], `$.resources[${String(index)}]`);
    if (!parsed.ok) return invalid(parsed.code, parsed.path);
    const exactKey = `${parsed.resource.kind}\u0000${parsed.resource.id}`;
    if (exactReferences.has(exactKey)) {
      return invalid("duplicate-resource", `$.resources[${String(index)}]`);
    }
    exactReferences.add(exactKey);
    if (parsed.resource.name !== undefined) {
      const logicalKey = `${parsed.resource.kind}\u0000${parsed.resource.name}`;
      const existingId = logicalReferences.get(logicalKey);
      if (existingId !== undefined && existingId !== parsed.resource.id) {
        return invalid("conflicting-resource", `$.resources[${String(index)}]`);
      }
      logicalReferences.set(logicalKey, parsed.resource.id);
    }
    resources.push(parsed.resource);
  }

  const parsedFailure =
    value.lastFailure === undefined ? undefined : parseFailure(value.lastFailure);
  if (parsedFailure !== undefined && !parsedFailure.ok) {
    return invalid(parsedFailure.code, parsedFailure.path);
  }
  const parsedCleanup = parseCleanup(value.cleanup);
  if (!parsedCleanup.ok) return invalid(parsedCleanup.code, parsedCleanup.path);
  if (!isTimestamp(value.createdAt)) return invalid("invalid-value", "$.createdAt");
  if (!isTimestamp(value.updatedAt)) return invalid("invalid-value", "$.updatedAt");
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
    return invalid("invalid-value", "$.updatedAt");
  }
  if (value.claimableAt !== undefined && !isTimestamp(value.claimableAt)) {
    return invalid("invalid-value", "$.claimableAt");
  }
  if ((value.stage === "claimable") !== (value.claimableAt !== undefined)) {
    return invalid("invalid-value", "$.claimableAt");
  }
  if (parsedCleanup.cleanup.state === "verified" && resources.length !== 0) {
    return invalid("invalid-value", "$.resources");
  }

  return {
    ok: true,
    receipt: {
      schemaVersion: LAUNCH_RECEIPT_SCHEMA_VERSION,
      launchId: value.launchId,
      backend: value.backend as HostingBackend,
      revision: value.revision as number,
      stage: value.stage as LaunchReceiptStage,
      resources,
      ...(parsedFailure === undefined ? {} : { lastFailure: parsedFailure.failure }),
      cleanup: parsedCleanup.cleanup,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
      ...(value.claimableAt === undefined ? {} : { claimableAt: value.claimableAt }),
    },
  };
}

const CLEANUP_TRANSITIONS: Readonly<Record<LaunchReceiptCleanupState, ReadonlySet<LaunchReceiptCleanupState>>> = {
  "not-required": new Set(["not-required", "pending"]),
  pending: new Set(["pending", "in-progress"]),
  "in-progress": new Set(["in-progress", "failed", "verified"]),
  failed: new Set(["failed", "in-progress"]),
  verified: new Set(["verified"]),
};

function transitionFailure(path: string): LaunchReceiptTransitionResult {
  return { ok: false, code: "invalid-transition", path };
}

/** Validates a single persisted checkpoint transition, not merely two shapes. */
export function validateLaunchReceiptTransition(
  previous: LaunchReceipt,
  next: LaunchReceipt,
): LaunchReceiptTransitionResult {
  if (next.schemaVersion !== previous.schemaVersion) return transitionFailure("$.schemaVersion");
  if (next.launchId !== previous.launchId) return transitionFailure("$.launchId");
  if (next.backend !== previous.backend) return transitionFailure("$.backend");
  if (next.createdAt !== previous.createdAt) return transitionFailure("$.createdAt");
  if (next.revision !== previous.revision + 1) return transitionFailure("$.revision");

  const previousStage = LAUNCH_RECEIPT_STAGES.indexOf(previous.stage);
  const nextStage = LAUNCH_RECEIPT_STAGES.indexOf(next.stage);
  if (nextStage < previousStage || nextStage > previousStage + 1) {
    return transitionFailure("$.stage");
  }
  if (Date.parse(next.updatedAt) < Date.parse(previous.updatedAt)) {
    return transitionFailure("$.updatedAt");
  }
  if (!CLEANUP_TRANSITIONS[previous.cleanup.state].has(next.cleanup.state)) {
    return transitionFailure("$.cleanup.state");
  }
  if (
    (previous.cleanup.state !== "not-required" ||
      next.cleanup.state !== "not-required") &&
    next.stage !== previous.stage
  ) {
    return transitionFailure("$.stage");
  }

  const cleaning = next.cleanup.state === "in-progress" || next.cleanup.state === "verified";
  if (!cleaning) {
    const nextReferences = new Set(
      next.resources.map((resource) => `${resource.kind}\u0000${resource.id}`),
    );
    if (
      previous.resources.some(
        (resource) => !nextReferences.has(`${resource.kind}\u0000${resource.id}`),
      )
    ) {
      return transitionFailure("$.resources");
    }
  }
  return { ok: true };
}
