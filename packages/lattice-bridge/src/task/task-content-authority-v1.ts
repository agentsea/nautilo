import { LATTICE_LIMITS } from "@nautilo/lattice-crypto";

export const TASK_CONTENT_AUTHORITY_RESOLVER_VERSION_V1 = 1 as const;

export type TaskConversationShapeV1 =
  | "private"
  | "group"
  | "public"
  | "open"
  | "dm"
  | "orphan";

export type TaskMemoryExecutionShapeV1 =
  | "namespace"
  | "private_wide"
  | "scope";

export type TaskExecutorShapeV1 = "native" | "external_harness";

/**
 * Message destinations are routing facts. They never select the Namespace
 * that owns the Task definition or its canonical result.
 */
export type TaskMessageDestinationV1 =
  | Readonly<{ status: "none" }>
  | Readonly<{ status: "deferred" }>
  | Readonly<{
      status: "resolved";
      roomId: string;
      namespaceId: string;
    }>;

export type TaskExecutionDeliveryShapeV1 = Readonly<{
  conversation: TaskConversationShapeV1;
  memory: TaskMemoryExecutionShapeV1;
  executor: TaskExecutorShapeV1;
}>;

/** Resolved or late-bound Message routing remains outside content custody. */
export type TaskDeliveryDestinationsV1 = Readonly<{
  transcriptDestination: TaskMessageDestinationV1;
  reportBackDestination: TaskMessageDestinationV1;
}>;

export type RequesterPrivateNamespaceUnavailableReasonV1 =
  | "requester_identity_unavailable"
  | "requester_private_namespace_unavailable"
  | "requester_private_namespace_unauthorized"
  | "authority_stale";

/** A trusted, already-resolved product/Namespace authorization fact. */
export type RequesterPrivateNamespaceFactV1 =
  | Readonly<{
      status: "authorized";
      subjectHumanId: string;
      namespaceId: string;
      domainId: string;
      accessRevision: number;
      policyRevision: number;
    }>
  | Readonly<{
      status: "unavailable";
      reason: RequesterPrivateNamespaceUnavailableReasonV1;
    }>;

export type ResolveTaskContentAuthorityInputV1 = Readonly<{
  resolverVersion: typeof TASK_CONTENT_AUTHORITY_RESOLVER_VERSION_V1;
  requesterHumanId: string;
  requesterPrivateNamespace: RequesterPrivateNamespaceFactV1;
  shape: TaskExecutionDeliveryShapeV1;
}>;

export type TaskContentAuthorityV1 = Readonly<{
  authorityVersion: typeof TASK_CONTENT_AUTHORITY_RESOLVER_VERSION_V1;
  kind: "requester_private_namespace";
  keyClass: "ai";
  requesterHumanId: string;
  namespaceId: string;
  domainId: string;
  expectedAccessRevision: number;
  expectedPolicyRevision: number;
}>;

export type TaskContentAuthorityUnavailableReasonV1 =
  | RequesterPrivateNamespaceUnavailableReasonV1
  | "requester_authority_mismatch"
  | "invalid_authority_facts"
  | "unsupported_resolver_version";

export type TaskContentAuthorityResolutionV1 =
  | Readonly<{
      resolverVersion: typeof TASK_CONTENT_AUTHORITY_RESOLVER_VERSION_V1;
      status: "resolved";
      authority: TaskContentAuthorityV1;
    }>
  | Readonly<{
      resolverVersion: typeof TASK_CONTENT_AUTHORITY_RESOLVER_VERSION_V1;
      status: "unavailable";
      reason: TaskContentAuthorityUnavailableReasonV1;
    }>;

const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;
const CONVERSATION_SHAPES = new Set<string>([
  "private", "group", "public", "open", "dm", "orphan",
]);
const MEMORY_SHAPES = new Set<string>([
  "namespace", "private_wide", "scope",
]);
const EXECUTOR_SHAPES = new Set<string>(["native", "external_harness"]);

function ownRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length) return false;
  const expected = new Set(fields);
  return keys.every((key) => {
    if (typeof key !== "string" || !expected.has(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined
      && descriptor.enumerable
      && "value" in descriptor;
  });
}

function portableId(value: unknown): value is string {
  return typeof value === "string"
    && new TextEncoder().encode(value).length >= 1
    && new TextEncoder().encode(value).length <= LATTICE_LIMITS.idBytes
    && PORTABLE_ID.test(value);
}

function revision(value: unknown, minimum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function validShape(value: unknown): boolean {
  return ownRecord(value)
    && exactFields(value, ["conversation", "memory", "executor"])
    && typeof value["conversation"] === "string"
    && CONVERSATION_SHAPES.has(value["conversation"])
    && typeof value["memory"] === "string"
    && MEMORY_SHAPES.has(value["memory"])
    && typeof value["executor"] === "string"
    && EXECUTOR_SHAPES.has(value["executor"]);
}

function unavailable(
  reason: TaskContentAuthorityUnavailableReasonV1,
): TaskContentAuthorityResolutionV1 {
  return Object.freeze({
    resolverVersion: TASK_CONTENT_AUTHORITY_RESOLVER_VERSION_V1,
    status: "unavailable" as const,
    reason,
  });
}

/**
 * Resolves stable Task custody from trusted facts only. Execution Memory,
 * transcript, report-back, Room audience, and external executor selection are
 * deliberately unable to influence the returned content Namespace.
 */
export function resolveTaskContentAuthorityV1(
  input: ResolveTaskContentAuthorityInputV1,
): TaskContentAuthorityResolutionV1 {
  if (!ownRecord(input)) return unavailable("invalid_authority_facts");
  if (input["resolverVersion"] !== TASK_CONTENT_AUTHORITY_RESOLVER_VERSION_V1) {
    return unavailable("unsupported_resolver_version");
  }
  if (
    !exactFields(input, [
      "resolverVersion",
      "requesterHumanId",
      "requesterPrivateNamespace",
      "shape",
    ])
    || !portableId(input["requesterHumanId"])
    || !validShape(input["shape"])
    || !ownRecord(input["requesterPrivateNamespace"])
  ) return unavailable("invalid_authority_facts");

  const fact = input["requesterPrivateNamespace"];
  if (fact["status"] === "unavailable") {
    if (
      !exactFields(fact, ["status", "reason"])
      || fact["reason"] !== "requester_identity_unavailable"
        && fact["reason"] !== "requester_private_namespace_unavailable"
        && fact["reason"] !== "requester_private_namespace_unauthorized"
        && fact["reason"] !== "authority_stale"
    ) return unavailable("invalid_authority_facts");
    return unavailable(fact["reason"]);
  }
  if (
    fact["status"] !== "authorized"
    || !exactFields(fact, [
      "status",
      "subjectHumanId",
      "namespaceId",
      "domainId",
      "accessRevision",
      "policyRevision",
    ])
    || !portableId(fact["subjectHumanId"])
    || !portableId(fact["namespaceId"])
    || !portableId(fact["domainId"])
    || !revision(fact["accessRevision"], 0)
    || !revision(fact["policyRevision"], 1)
  ) return unavailable("invalid_authority_facts");
  if (fact["subjectHumanId"] !== input["requesterHumanId"]) {
    return unavailable("requester_authority_mismatch");
  }

  return Object.freeze({
    resolverVersion: TASK_CONTENT_AUTHORITY_RESOLVER_VERSION_V1,
    status: "resolved" as const,
    authority: Object.freeze({
      authorityVersion: TASK_CONTENT_AUTHORITY_RESOLVER_VERSION_V1,
      kind: "requester_private_namespace" as const,
      keyClass: "ai" as const,
      requesterHumanId: input["requesterHumanId"],
      namespaceId: fact["namespaceId"],
      domainId: fact["domainId"],
      expectedAccessRevision: fact["accessRevision"],
      expectedPolicyRevision: fact["policyRevision"],
    }),
  });
}
