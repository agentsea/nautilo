import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import {
  BACKGROUND_AUTHORIZATION_COLLECTION_LIMITS,
} from "@nautilo/db/schema";
import { MAX_AGENT_GRANT_NAMESPACES_V2 } from
  "@nautilo/lattice-crypto/wire-limits";

import {
  PROTECTED_AGENT_RUNTIME_FOREGROUND_ENTRYPOINT_IDS,
  destroyProtectedInvocationCapability,
  inspectProtectedInvocationCapability,
  type ProtectedInvocationCapability,
  type ProtectedInvocationCapabilityDescription,
  type ProtectedCheckpointNamespaceMaterial,
  type ProtectedCheckpointNamespaceSessionContentExecutor,
  type ProtectedCheckpointAuthorizedOperationContext,
  type ProtectedAgentRuntimeForegroundEntrypointId,
  type MessagePayloadV2,
  type PreparedConversationCryptoRevision,
  type AgentMemoryExactAccessPlan,
  type PreparedAgentMemoryExactAccess,
  type ProtectedAgentMemoryExactAccessContentPort,
  type ProtectedAgentConversationSessionCryptoPreparer,
  type ProtectedAgentMemorySessionContentPort,
  type ProtectedMemoryAuthority,
  type ProtectedMemoryCandidate,
  type ProtectedMemoryMutationPlan,
  type ProtectedMemoryMutationTarget,
  type ProtectedMemoryResult,
  type ProtectedMemorySessionOpenedItem,
  type PreparedMemoryCryptoRevision,
} from "@nautilo/lattice-bridge";

import {
  type ProtectedExecutionContentUnavailableReason,
  type ProtectedExecutionEntrypointId,
  type ProtectedExecutionOperation,
} from "./broker";
import type { ProtectedInvocationCapabilityPort } from "./lease-registry";

export const FOREGROUND_AUTHORIZATION_ABSOLUTE_LIMIT_MS =
  2 * 60 * 60 * 1_000;
export const FOREGROUND_AUTHORIZATION_IDLE_LIMIT_MS =
  30 * 60 * 1_000;
export const TASK_RUNTIME_AUTHORIZATION_ABSOLUTE_LIMIT_MS =
  BACKGROUND_AUTHORIZATION_COLLECTION_LIMITS.productTtlSeconds * 1_000;
export const FOREGROUND_AUTHORIZATION_MAX_SESSIONS = 256;
export const FOREGROUND_AUTHORIZATION_MAX_CHILD_VIEWS = 16;
export const MAX_FOREGROUND_AUTHORIZATION_OPERATIONS = 256;
const MAX_FOREGROUND_SWEEP_INTERVAL_MS = 30_000;
const MAX_FOREGROUND_ID_BYTES = 256;

export type LegacyAgentForegroundAuthorizationBinding = Readonly<{
  readonly humanId: string;
  readonly issuingDeviceId: string;
  readonly recipientAgentId: string;
}>;

export type RuntimeForegroundAuthorizationBinding = Readonly<{
  readonly humanId: string;
  readonly issuingDeviceId: string;
  readonly recipientKind: "nautilo_foreground_runtime";
  readonly browserSessionId: string;
  readonly topLevelRoomId: string;
}>;

export type TaskRuntimeAuthorizationBinding = Readonly<{
  readonly humanId: string;
  readonly issuingDeviceId: string;
  readonly recipientKind: "nautilo_task_runtime";
  readonly taskRunId: string;
  readonly authorizationEpisodeId: string;
  readonly sourceRoomId: string;
}>;

export type ForegroundAuthorizationBinding =
  | LegacyAgentForegroundAuthorizationBinding
  | RuntimeForegroundAuthorizationBinding;

export type AuthorizationSessionBinding =
  | ForegroundAuthorizationBinding
  | TaskRuntimeAuthorizationBinding;

export const FOREGROUND_AUTHORIZATION_ENTRYPOINT_IDS =
  PROTECTED_AGENT_RUNTIME_FOREGROUND_ENTRYPOINT_IDS;

export interface ForegroundAuthorizationContentPort<
  Capability extends object = ProtectedInvocationCapability,
> {
  readonly execute: <Value>(input: Readonly<{
    readonly capability: Capability;
    readonly entrypointId:
      (typeof FOREGROUND_AUTHORIZATION_ENTRYPOINT_IDS)[number];
    readonly operation: ProtectedExecutionOperation;
    readonly namespaceId: string;
    readonly domainId: string;
    readonly signal?: AbortSignal;
    readonly execute: (
      plaintext: Uint8Array,
    ) => Value | PromiseLike<Value>;
  }>) => Promise<
    | Readonly<{ readonly status: "executed"; readonly value: Value }>
    | Readonly<{
      readonly status: "unavailable";
      readonly reason: ProtectedExecutionContentUnavailableReason;
    }>
  >;
}

/**
 * Bridge-owned hook for one exact Namespace-set operation. Runtime supplies
 * the retained opaque capability and the bound view's Domain inventory; the
 * product caller supplies neither Domain mappings nor recipient authority.
 */
export interface ForegroundAuthorizationNamespaceSetPort<
  Capability extends object = ProtectedInvocationCapability,
> {
  readonly execute: <Value>(input: Readonly<{
    readonly capability: Capability;
    readonly entrypointId:
      (typeof FOREGROUND_AUTHORIZATION_ENTRYPOINT_IDS)[number];
    readonly operation: ProtectedExecutionOperation;
    readonly namespaceIds: readonly string[];
    readonly domainIds: readonly string[];
    readonly signal?: AbortSignal;
    readonly execute: () => Value | PromiseLike<Value>;
  }>) => Promise<
    | Readonly<{ readonly status: "executed"; readonly value: Value }>
    | Readonly<{
      readonly status: "unavailable";
      readonly reason: ProtectedExecutionContentUnavailableReason;
    }>
  >;
}

export type ForegroundAuthorizationCapabilityOperation<
  Capability extends object,
> = Readonly<{
  readonly capability: Capability;
  readonly entrypointId:
    (typeof FOREGROUND_AUTHORIZATION_ENTRYPOINT_IDS)[number];
  readonly operations: readonly ProtectedExecutionOperation[];
  readonly namespaceIds: readonly string[];
  readonly domainIds: readonly string[];
  readonly signal: AbortSignal;
}>;

export type ForegroundAuthorizationCapabilityOperationExecutor<
  Capability extends object,
  Value,
> = (
  operation: ForegroundAuthorizationCapabilityOperation<Capability>,
) =>
  | Readonly<{ readonly status: "executed"; readonly value: Value }>
  | Readonly<{
    readonly status: "unavailable";
    readonly reason: ProtectedExecutionContentUnavailableReason;
  }>
  | PromiseLike<
    | Readonly<{ readonly status: "executed"; readonly value: Value }>
    | Readonly<{
      readonly status: "unavailable";
      readonly reason: ProtectedExecutionContentUnavailableReason;
    }>
  >;

declare const foregroundAuthorizationViewBrand: unique symbol;
declare const foregroundAuthorizationLeaseBrand: unique symbol;

export type ForegroundAuthorizationView = Readonly<{
  readonly sessionId: string;
  readonly viewId: string;
  /** Null for the root; exact content-free work binding for a child view. */
  readonly workDescriptorDigestBase64url: string | null;
  readonly [foregroundAuthorizationViewBrand]: true;
}>;

export type ForegroundAuthorizationOperationLease = Readonly<{
  readonly sessionId: string;
  readonly leaseId: string;
  readonly [foregroundAuthorizationLeaseBrand]: true;
}>;

export type ForegroundAuthorizationNamespaceRequirement = Readonly<{
  namespaceId: string;
  operation: ProtectedExecutionOperation;
}>;

export type ForegroundAuthorizationChildWorkDescriptor = Readonly<{
  readonly parentInvocationId: string;
  readonly childExecutionId: string;
}>;

/**
 * Content-free identity binding for one invocation-bound foreground child.
 * The digest may be retained with the opaque view; Human or Agent content may
 * never enter this descriptor.
 */
export function foregroundAuthorizationChildWorkDescriptorDigest(
  descriptor: ForegroundAuthorizationChildWorkDescriptor,
): Uint8Array {
  if (
    !portableText(descriptor.parentInvocationId)
    || !portableText(descriptor.childExecutionId)
  ) {
    throw new TypeError("Foreground child work descriptor is invalid");
  }
  const hash = createHash("sha256");
  hash.update("nautilo.foreground.child-work.v1\0", "utf8");
  for (const value of [
    descriptor.parentInvocationId,
    descriptor.childExecutionId,
  ]) {
    const bytes = encoder.encode(value);
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length);
    hash.update(bytes);
  }
  return new Uint8Array(hash.digest());
}

export type ForegroundAuthorizationRegistrationReason =
  | "binding_invalid"
  | "capability_invalid"
  | "capability_in_use"
  | "capability_expired"
  | "operation_scope_invalid"
  | "session_deadline_invalid"
  | "session_id_invalid"
  | "view_id_invalid"
  | "process_capacity"
  | "registry_closed";

export type ForegroundAuthorizationRegistration =
  | Readonly<{
    readonly status: "registered";
    readonly sessionId: string;
    readonly rootView: ForegroundAuthorizationView;
  }>
  | Readonly<{
    readonly status: "unavailable";
    readonly reason: ForegroundAuthorizationRegistrationReason;
  }>;

export type ForegroundAuthorizationResolveReason =
  | "binding_mismatch"
  | "registry_closed"
  | "session_expired"
  | "session_idle_expired"
  | "session_cancelled"
  | "session_unavailable";

export type ForegroundAuthorizationResolveResult =
  | Readonly<{
    readonly status: "resolved";
    readonly view: ForegroundAuthorizationView;
  }>
  | Readonly<{
    readonly status: "unavailable";
    readonly reason: ForegroundAuthorizationResolveReason;
  }>;

export type ForegroundAuthorizationChildReason =
  | ForegroundAuthorizationResolveReason
  | "child_capacity"
  | "child_scope_invalid"
  | "child_scope_widened"
  | "view_id_invalid"
  | "view_unavailable";

export type ForegroundAuthorizationChildResult =
  | Readonly<{
    readonly status: "created";
    readonly view: ForegroundAuthorizationView;
  }>
  | Readonly<{
    readonly status: "unavailable";
    readonly reason: ForegroundAuthorizationChildReason;
  }>;

export type ForegroundAuthorizationLeaseReason =
  | ForegroundAuthorizationResolveReason
  | "lease_id_invalid"
  | "operation_capacity"
  | "operation_deadline_invalid"
  | "operation_scope_widened"
  | "view_unavailable";

export type ForegroundAuthorizationLeaseResult =
  | Readonly<{
    readonly status: "leased";
    readonly lease: ForegroundAuthorizationOperationLease;
  }>
  | Readonly<{
    readonly status: "unavailable";
    readonly reason: ForegroundAuthorizationLeaseReason;
  }>;

export type ForegroundAuthorizationExecutionReason =
  | ProtectedExecutionContentUnavailableReason
  | "execution_failed"
  | "lease_cancelled"
  | "lease_expired"
  | "lease_in_use"
  | "lease_unavailable"
  | "session_cancelled"
  | "session_expired";

export type ForegroundAuthorizationExecutionResult<Value> =
  | Readonly<{ readonly status: "executed"; readonly value: Value }>
  | Readonly<{
    readonly status: "unavailable";
    readonly reason: ForegroundAuthorizationExecutionReason;
  }>;

/**
 * Canonical lifecycle description supplied by a bridge-owned capability
 * adapter. The signed authorization id is descriptive input only: the
 * registry always creates its own opaque session id.
 */
type ForegroundAuthorizationCapabilityDescriptionBase = Readonly<{
  readonly authorizationId: string;
  readonly expiresAt: number;
  readonly issuedAt: number;
  readonly issuingHumanId: string;
  readonly issuingDeviceId: string;
  readonly recipientKeyId: string;
  readonly namespaceIds: readonly string[];
  readonly domainIds: readonly string[];
}>;

export type ForegroundAuthorizationCapabilityDescription =
  ForegroundAuthorizationCapabilityDescriptionBase & (
    | Readonly<{ readonly recipientAgentId: string }>
    | Readonly<{
      readonly recipientKind: "nautilo_foreground_runtime";
      readonly browserSessionId: string;
      readonly topLevelRoomId: string;
    }>
    | Readonly<{
      readonly recipientKind: "nautilo_task_runtime";
      readonly taskRunId: string;
      readonly authorizationEpisodeId: string;
      readonly sourceRoomId: string;
    }>
  );

export interface ForegroundAuthorizationCapabilityPort<
  Capability extends object = ProtectedInvocationCapability,
> {
  readonly inspect: (
    capability: Capability,
  ) =>
    | ForegroundAuthorizationCapabilityDescription
    | ProtectedInvocationCapabilityDescription
    | null;
  readonly destroy: (capability: Capability) => void;
}

export function createForegroundAuthorizationCapabilityPort<
  Capability extends object,
>(
  input: ForegroundAuthorizationCapabilityPort<Capability>,
): ForegroundAuthorizationCapabilityPort<Capability> {
  if (
    typeof input !== "object"
    || input === null
    || typeof input.inspect !== "function"
    || typeof input.destroy !== "function"
  ) {
    throw new TypeError("Foreground authorization capability port is invalid");
  }
  return Object.freeze({
    inspect: (capability: Capability) => input.inspect(capability),
    destroy: (capability: Capability) => input.destroy(capability),
  });
}

export interface ForegroundAuthorizationSessionRegistryOptions<
  Capability extends object = ProtectedInvocationCapability,
> {
  readonly capabilityPort?: ForegroundAuthorizationCapabilityPort<Capability>;
  readonly contentPort?: ForegroundAuthorizationContentPort<Capability>;
  readonly now?: () => number;
  readonly createSessionId?: () => string;
  readonly createViewId?: () => string;
  readonly createLeaseId?: () => string;
  readonly startSweep?: boolean;
  readonly sweepIntervalMs?: number;
}

type SessionCloseReason =
  | "authorization_unavailable"
  | "session_cancelled"
  | "session_expired"
  | "session_idle_expired";

type SessionEntry<Capability extends object> = {
  readonly sessionId: string;
  readonly capability: Capability;
  readonly description: ForegroundAuthorizationCapabilityDescription;
  readonly binding: AuthorizationSessionBinding;
  readonly absoluteExpiresAt: number;
  readonly rootView: ForegroundAuthorizationView;
  readonly views: Set<ForegroundAuthorizationView>;
  readonly operations: Set<ForegroundAuthorizationOperationLease>;
  idleExpiresAt: number;
  childCount: number;
  status: "active" | "closing" | "closed";
  closeReason: SessionCloseReason | null;
};

type ViewState<Capability extends object> = {
  readonly session: SessionEntry<Capability>;
  readonly view: ForegroundAuthorizationView;
  readonly parent: ForegroundAuthorizationView | null;
  readonly namespaceIds: readonly string[];
  readonly domainIds: readonly string[];
  readonly operations: readonly ProtectedExecutionOperation[];
  readonly workDescriptorDigest: Uint8Array | null;
  readonly effectiveExpiresAt: number;
  readonly children: Set<ForegroundAuthorizationView>;
};

type OperationAbortReason =
  | "caller"
  | "operation_deadline"
  | "session_cancelled"
  | "session_expired"
  | "view_cancelled";

type OperationTarget =
  | Readonly<{
    readonly kind: "single";
    readonly namespaceId: string;
    readonly domainId: string;
  }>
  | Readonly<{
    readonly kind: "namespace-set";
    readonly namespaceIds: readonly string[];
    readonly domainIds: readonly string[];
  }>
  | Readonly<{
    readonly kind: "namespace-requirements";
    readonly requirements: readonly ForegroundAuthorizationNamespaceRequirement[];
    readonly namespaceIds: readonly string[];
    readonly domainIds: readonly string[];
  }>
  | Readonly<{
    readonly kind: "authorization-set";
    readonly operations: readonly ProtectedExecutionOperation[];
    readonly namespaceIds: readonly string[];
    readonly domainIds: readonly string[];
  }>;

type OperationState<Capability extends object> = {
  readonly session: SessionEntry<Capability>;
  readonly view: ForegroundAuthorizationView;
  readonly lease: ForegroundAuthorizationOperationLease;
  readonly entrypointId: ProtectedAgentRuntimeForegroundEntrypointId;
  readonly operation: ProtectedExecutionOperation;
  readonly target: OperationTarget;
  readonly executionDeadline: number;
  status: "ready" | "running";
  controller: AbortController | null;
  abortReason: OperationAbortReason | null;
};

type ProtectedInvocationOnly<Capability extends object, Port> =
  Capability extends ProtectedInvocationCapability ? Port : never;

const bridgeCapabilityPort: ProtectedInvocationCapabilityPort =
  Object.freeze({
    inspect: inspectProtectedInvocationCapability,
    destroy: destroyProtectedInvocationCapability,
  });

const encoder = new TextEncoder();
const protectedEntrypoints = new Set<string>(
  FOREGROUND_AUTHORIZATION_ENTRYPOINT_IDS,
);

function isForegroundEntrypoint(
  value: ProtectedExecutionEntrypointId,
): value is ProtectedAgentRuntimeForegroundEntrypointId {
  return protectedEntrypoints.has(value);
}

function isEntrypointAllowed(
  binding: AuthorizationSessionBinding,
  value: ProtectedExecutionEntrypointId,
): value is ProtectedAgentRuntimeForegroundEntrypointId {
  return (!("recipientKind" in binding)
      || binding.recipientKind === "nautilo_foreground_runtime")
    && isForegroundEntrypoint(value);
}

function portableText(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && encoder.encode(value).length <= MAX_FOREGROUND_ID_BYTES;
}

function canonicalIds(
  value: unknown,
  maximum = FOREGROUND_AUTHORIZATION_MAX_SESSIONS,
): readonly string[] | null {
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.length > maximum
    || !value.every(portableText)
    || value.some((item, index) =>
      index > 0 && String(value[index - 1]) >= String(item)
    )
  ) {
    return null;
  }
  return Object.freeze([...value]);
}

function scopeMaximum(
  binding: AuthorizationSessionBinding,
): number {
  return "recipientKind" in binding
      && binding.recipientKind === "nautilo_task_runtime"
    ? MAX_AGENT_GRANT_NAMESPACES_V2
    : FOREGROUND_AUTHORIZATION_MAX_SESSIONS;
}

function canonicalOperations(
  value: unknown,
): readonly ProtectedExecutionOperation[] | null {
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.length > 2
    || !value.every((item) => item === "decrypt" || item === "encrypt")
    || value.some((item, index) =>
      index > 0 && String(value[index - 1]) >= String(item)
    )
  ) {
    return null;
  }
  return Object.freeze(value.map((item) =>
    item === "decrypt" ? "decrypt" : "encrypt"
  ));
}

function canonicalNamespaceRequirements(
  value: unknown,
  maximum = FOREGROUND_AUTHORIZATION_MAX_SESSIONS,
): readonly ForegroundAuthorizationNamespaceRequirement[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) {
    return null;
  }
  const entries: readonly unknown[] = value;
  const result: ForegroundAuthorizationNamespaceRequirement[] = [];
  for (const raw of entries) {
    if (
      typeof raw !== "object"
      || raw === null
    ) return null;
    const entry = raw as Readonly<Record<string, unknown>>;
    if (
      !portableText(entry["namespaceId"])
      || (entry["operation"] !== "decrypt"
        && entry["operation"] !== "encrypt")
    ) return null;
    result.push(Object.freeze({
      namespaceId: entry["namespaceId"],
      operation: entry["operation"],
    }));
  }
  if (result.some((entry, index) =>
    index > 0 && result[index - 1]!.namespaceId >= entry.namespaceId
  )) return null;
  return Object.freeze(result);
}

function snapshotBinding(
  value: AuthorizationSessionBinding,
): AuthorizationSessionBinding | null {
  if (
    typeof value !== "object"
    || value === null
    || !portableText(value.humanId)
    || !portableText(value.issuingDeviceId)
  ) {
    return null;
  }
  if ("recipientAgentId" in value) {
    if (!portableText(value.recipientAgentId)) return null;
    return Object.freeze({
      humanId: value.humanId,
      issuingDeviceId: value.issuingDeviceId,
      recipientAgentId: value.recipientAgentId,
    });
  }
  if (value.recipientKind === "nautilo_foreground_runtime") {
    if (
      !portableText(value.browserSessionId)
      || !portableText(value.topLevelRoomId)
    ) return null;
    return Object.freeze({
      humanId: value.humanId,
      issuingDeviceId: value.issuingDeviceId,
      recipientKind: value.recipientKind,
      browserSessionId: value.browserSessionId,
      topLevelRoomId: value.topLevelRoomId,
    });
  }
  if (
    value.recipientKind !== "nautilo_task_runtime"
    || !portableText(value.taskRunId)
    || !portableText(value.authorizationEpisodeId)
    || !portableText(value.sourceRoomId)
  ) return null;
  return Object.freeze({
    humanId: value.humanId,
    issuingDeviceId: value.issuingDeviceId,
    recipientKind: value.recipientKind,
    taskRunId: value.taskRunId,
    authorizationEpisodeId: value.authorizationEpisodeId,
    sourceRoomId: value.sourceRoomId,
  });
}

function snapshotDescription(
  value:
    | ForegroundAuthorizationCapabilityDescription
    | ProtectedInvocationCapabilityDescription,
): ForegroundAuthorizationCapabilityDescription | null {
  const authorizationId = "authorizationId" in value
    ? value.authorizationId
    : value.invocationId;
  if (
    typeof value !== "object"
    || value === null
    || !portableText(authorizationId)
    || (
      "grantId" in value
      && !portableText(value.grantId)
    )
    || !portableText(value.issuingHumanId)
    || !portableText(value.issuingDeviceId)
    || !portableText(value.recipientKeyId)
    || !Number.isSafeInteger(value.issuedAt)
    || !Number.isSafeInteger(value.expiresAt)
    || value.issuedAt < 0
    || value.expiresAt <= value.issuedAt
  ) {
    return null;
  }
  const maximum = "recipientKind" in value
      && value.recipientKind === "nautilo_task_runtime"
    ? MAX_AGENT_GRANT_NAMESPACES_V2
    : FOREGROUND_AUTHORIZATION_MAX_SESSIONS;
  const namespaceIds = canonicalIds(value.namespaceIds, maximum);
  const domainIds = canonicalIds(value.domainIds, maximum);
  if (namespaceIds === null || domainIds === null) return null;
  const recipient = "recipientAgentId" in value
    ? (
      portableText(value.recipientAgentId)
        ? Object.freeze({ recipientAgentId: value.recipientAgentId })
        : null
    )
    : value.recipientKind === "nautilo_foreground_runtime"
      ? portableText(value.browserSessionId)
        && portableText(value.topLevelRoomId)
        ? Object.freeze({
          recipientKind: value.recipientKind,
          browserSessionId: value.browserSessionId,
          topLevelRoomId: value.topLevelRoomId,
        })
        : null
      : value.recipientKind === "nautilo_task_runtime"
        && portableText(value.taskRunId)
        && portableText(value.authorizationEpisodeId)
        && portableText(value.sourceRoomId)
        ? Object.freeze({
          recipientKind: value.recipientKind,
          taskRunId: value.taskRunId,
          authorizationEpisodeId: value.authorizationEpisodeId,
          sourceRoomId: value.sourceRoomId,
        })
        : null;
  if (recipient === null) return null;
  return Object.freeze({
    authorizationId,
    issuingHumanId: value.issuingHumanId,
    issuingDeviceId: value.issuingDeviceId,
    ...recipient,
    recipientKeyId: value.recipientKeyId,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
    namespaceIds,
    domainIds,
  });
}

function sameBinding(
  left: AuthorizationSessionBinding,
  right: AuthorizationSessionBinding,
): boolean {
  if (
    left.humanId !== right.humanId
    || left.issuingDeviceId !== right.issuingDeviceId
    || ("recipientAgentId" in left) !== ("recipientAgentId" in right)
  ) return false;
  if ("recipientAgentId" in left && "recipientAgentId" in right) {
    return left.recipientAgentId === right.recipientAgentId;
  }
  if (!("recipientKind" in left) || !("recipientKind" in right)
    || left.recipientKind !== right.recipientKind) return false;
  return left.recipientKind === "nautilo_foreground_runtime"
    && right.recipientKind === "nautilo_foreground_runtime"
    ? left.browserSessionId === right.browserSessionId
      && left.topLevelRoomId === right.topLevelRoomId
    : left.recipientKind === "nautilo_task_runtime"
      && right.recipientKind === "nautilo_task_runtime"
      && left.taskRunId === right.taskRunId
      && left.authorizationEpisodeId === right.authorizationEpisodeId
      && left.sourceRoomId === right.sourceRoomId;
}

function bindingMatchesDescription(
  binding: AuthorizationSessionBinding,
  description: ForegroundAuthorizationCapabilityDescription,
): boolean {
  if (
    binding.humanId !== description.issuingHumanId
    || binding.issuingDeviceId !== description.issuingDeviceId
    || ("recipientAgentId" in binding)
      !== ("recipientAgentId" in description)
  ) return false;
  if ("recipientAgentId" in binding && "recipientAgentId" in description) {
    return binding.recipientAgentId === description.recipientAgentId;
  }
  if (!("recipientKind" in binding) || !("recipientKind" in description)
    || binding.recipientKind !== description.recipientKind) return false;
  return binding.recipientKind === "nautilo_foreground_runtime"
    && description.recipientKind === "nautilo_foreground_runtime"
    ? binding.browserSessionId === description.browserSessionId
      && binding.topLevelRoomId === description.topLevelRoomId
    : binding.recipientKind === "nautilo_task_runtime"
      && description.recipientKind === "nautilo_task_runtime"
      && binding.taskRunId === description.taskRunId
      && binding.authorizationEpisodeId === description.authorizationEpisodeId
      && binding.sourceRoomId === description.sourceRoomId;
}

function isSubset(
  child: readonly string[],
  parent: readonly string[],
): boolean {
  const allowed = new Set(parent);
  return child.every((value) => allowed.has(value));
}

function asProtectedInvocationCapability(
  capability: object,
): ProtectedInvocationCapability {
  return capability as ProtectedInvocationCapability;
}

function unavailableRegistration(
  reason: ForegroundAuthorizationRegistrationReason,
): ForegroundAuthorizationRegistration {
  return Object.freeze({ status: "unavailable", reason });
}

function unavailableResolve(
  reason: ForegroundAuthorizationResolveReason,
): ForegroundAuthorizationResolveResult {
  return Object.freeze({ status: "unavailable", reason });
}

function unavailableChild(
  reason: ForegroundAuthorizationChildReason,
): ForegroundAuthorizationChildResult {
  return Object.freeze({ status: "unavailable", reason });
}

function unavailableLease(
  reason: ForegroundAuthorizationLeaseReason,
): ForegroundAuthorizationLeaseResult {
  return Object.freeze({ status: "unavailable", reason });
}

function unavailableExecution(
  reason: ForegroundAuthorizationExecutionReason,
): ForegroundAuthorizationExecutionResult<never> {
  return Object.freeze({ status: "unavailable", reason });
}

/**
 * Process-local foreground authority that retains only a bridge-owned
 * recipient capability. Each operation receives a fresh one-shot lease and
 * the bridge/core repeat Grant and current-authority checks before lending
 * plaintext. Session ids are lookup coordinates, never authority.
 */
export class ForegroundAuthorizationSessionRegistry<
  Capability extends object = ProtectedInvocationCapability,
> {
  readonly #capabilityPort: ForegroundAuthorizationCapabilityPort<Capability>;
  readonly #contentPort: ForegroundAuthorizationContentPort<Capability> | null;
  readonly #now: () => number;
  readonly #createSessionId: () => string;
  readonly #createViewId: () => string;
  readonly #createLeaseId: () => string;
  readonly #sessions = new Map<string, SessionEntry<Capability>>();
  readonly #registeredCapabilities = new WeakSet<object>();
  readonly #views = new WeakMap<object, ViewState<Capability>>();
  readonly #operations =
    new WeakMap<object, OperationState<Capability>>();
  readonly #liveOperations =
    new Set<ForegroundAuthorizationOperationLease>();
  readonly #currentOperation =
    new AsyncLocalStorage<ForegroundAuthorizationOperationLease>();
  readonly #timer: ReturnType<typeof setInterval> | null;
  #closed = false;

  constructor(
    options: ForegroundAuthorizationSessionRegistryOptions<Capability>,
  ) {
    this.#capabilityPort =
      options.capabilityPort
      ?? bridgeCapabilityPort as ForegroundAuthorizationCapabilityPort<Capability>;
    this.#contentPort = options.contentPort ?? null;
    this.#now = options.now ?? Date.now;
    this.#createSessionId = options.createSessionId ?? randomUUID;
    this.#createViewId = options.createViewId ?? randomUUID;
    this.#createLeaseId = options.createLeaseId ?? randomUUID;

    const sweepIntervalMs =
      options.sweepIntervalMs ?? MAX_FOREGROUND_SWEEP_INTERVAL_MS;
    if (
      !Number.isSafeInteger(sweepIntervalMs)
      || sweepIntervalMs <= 0
      || sweepIntervalMs > MAX_FOREGROUND_SWEEP_INTERVAL_MS
    ) {
      throw new TypeError(
        "Foreground authorization sweep interval must be within 1..30000ms",
      );
    }
    if (options.startSweep === false) {
      this.#timer = null;
    } else {
      this.#timer = setInterval(() => {
        this.sweep();
      }, sweepIntervalMs);
      this.#timer.unref?.();
    }
  }

  get size(): number {
    return this.#sessions.size;
  }

  get liveOperationCount(): number {
    return this.#liveOperations.size;
  }

  register(input: Readonly<{
    readonly capability: Capability;
    readonly authenticatedBinding: AuthorizationSessionBinding;
    readonly allowedOperations: readonly ProtectedExecutionOperation[];
    readonly sessionDeadline?: number;
  }>): ForegroundAuthorizationRegistration {
    if (this.#closed) {
      this.#capabilityPort.destroy(input.capability);
      return unavailableRegistration("registry_closed");
    }
    this.sweep();

    const inspected = this.#capabilityPort.inspect(input.capability);
    if (inspected === null) {
      return unavailableRegistration("capability_invalid");
    }
    const description = snapshotDescription(inspected);
    const binding = snapshotBinding(input.authenticatedBinding);
    const operations = canonicalOperations(input.allowedOperations);
    if (description === null) {
      this.#capabilityPort.destroy(input.capability);
      return unavailableRegistration("capability_invalid");
    }
    if (this.#registeredCapabilities.has(input.capability)) {
      return unavailableRegistration("capability_in_use");
    }
    if (
      binding === null
      || !bindingMatchesDescription(binding, description)
    ) {
      this.#capabilityPort.destroy(input.capability);
      return unavailableRegistration("binding_invalid");
    }
    if (operations === null) {
      this.#capabilityPort.destroy(input.capability);
      return unavailableRegistration("operation_scope_invalid");
    }
    if (
      input.sessionDeadline !== undefined
      && (
        !Number.isSafeInteger(input.sessionDeadline)
        || input.sessionDeadline < 0
      )
    ) {
      this.#capabilityPort.destroy(input.capability);
      return unavailableRegistration("session_deadline_invalid");
    }

    const now = this.#now();
    if (now < description.issuedAt) {
      this.#capabilityPort.destroy(input.capability);
      return unavailableRegistration("capability_invalid");
    }
    const policyDeadline = "recipientKind" in description
        && description.recipientKind === "nautilo_task_runtime"
      ? description.issuedAt + TASK_RUNTIME_AUTHORIZATION_ABSOLUTE_LIMIT_MS
      : Math.min(
        Number.MAX_SAFE_INTEGER,
        description.issuedAt
          + FOREGROUND_AUTHORIZATION_ABSOLUTE_LIMIT_MS,
      );
    const absoluteExpiresAt = Math.min(
      description.expiresAt,
      policyDeadline,
      input.sessionDeadline ?? Number.MAX_SAFE_INTEGER,
    );
    if (absoluteExpiresAt <= now) {
      this.#capabilityPort.destroy(input.capability);
      return unavailableRegistration("capability_expired");
    }
    if (
      this.#sessions.size
        >= FOREGROUND_AUTHORIZATION_MAX_SESSIONS
    ) {
      this.#capabilityPort.destroy(input.capability);
      return unavailableRegistration("process_capacity");
    }

    const sessionId = this.#createSessionId();
    if (
      !portableText(sessionId)
      || this.#sessions.has(sessionId)
    ) {
      this.#capabilityPort.destroy(input.capability);
      return unavailableRegistration("session_id_invalid");
    }
    const viewId = this.#createViewId();
    if (!portableText(viewId)) {
      this.#capabilityPort.destroy(input.capability);
      return unavailableRegistration("view_id_invalid");
    }
    const rootView = Object.freeze({
      sessionId,
      viewId,
      workDescriptorDigestBase64url: null,
    }) as ForegroundAuthorizationView;
    const entry: SessionEntry<Capability> = {
      sessionId,
      capability: input.capability,
      description,
      binding,
      absoluteExpiresAt,
      idleExpiresAt: Math.min(
        absoluteExpiresAt,
        now + FOREGROUND_AUTHORIZATION_IDLE_LIMIT_MS,
      ),
      rootView,
      views: new Set([rootView]),
      operations: new Set(),
      childCount: 0,
      status: "active",
      closeReason: null,
    };
    this.#views.set(rootView, {
      session: entry,
      view: rootView,
      parent: null,
      namespaceIds: description.namespaceIds,
      domainIds: description.domainIds,
      operations,
      workDescriptorDigest: null,
      effectiveExpiresAt: absoluteExpiresAt,
      children: new Set(),
    });
    this.#registeredCapabilities.add(input.capability);
    this.#sessions.set(sessionId, entry);
    return Object.freeze({
      status: "registered",
      sessionId,
      rootView,
    });
  }

  resolve(input: Readonly<{
    readonly sessionId: string;
    readonly authenticatedBinding: AuthorizationSessionBinding;
  }>): ForegroundAuthorizationResolveResult {
    if (this.#closed) return unavailableResolve("registry_closed");
    const entry = this.#sessions.get(input.sessionId);
    if (entry === undefined) {
      return unavailableResolve("session_unavailable");
    }
    const binding = snapshotBinding(input.authenticatedBinding);
    if (binding === null || !sameBinding(entry.binding, binding)) {
      return unavailableResolve("binding_mismatch");
    }
    const unavailable = this.#availability(entry);
    if (unavailable !== null) return unavailableResolve(unavailable);
    return Object.freeze({
      status: "resolved",
      view: entry.rootView,
    });
  }

  createChildView(input: Readonly<{
    readonly parent: ForegroundAuthorizationView;
    readonly namespaceIds: readonly string[];
    readonly domainIds: readonly string[];
    readonly operations: readonly ProtectedExecutionOperation[];
    readonly workDescriptorDigest: Uint8Array;
    readonly deadline?: number;
  }>): ForegroundAuthorizationChildResult {
    const parent = this.#views.get(input.parent);
    if (parent === undefined) return unavailableChild("view_unavailable");
    const unavailable = this.#availability(parent.session);
    if (unavailable !== null) return unavailableChild(unavailable);
    const maximum = scopeMaximum(parent.session.binding);
    const namespaceIds = canonicalIds(input.namespaceIds, maximum);
    const domainIds = canonicalIds(input.domainIds, maximum);
    const operations = canonicalOperations(input.operations);
    if (
      namespaceIds === null
      || domainIds === null
      || operations === null
      || !(input.workDescriptorDigest instanceof Uint8Array)
      || input.workDescriptorDigest.length !== 32
      || (
        input.deadline !== undefined
        && (
          !Number.isSafeInteger(input.deadline)
          || input.deadline < 0
        )
      )
    ) {
      return unavailableChild("child_scope_invalid");
    }
    if (
      !isSubset(namespaceIds, parent.namespaceIds)
      || !isSubset(domainIds, parent.domainIds)
      || !isSubset(operations, parent.operations)
      || (
        input.deadline !== undefined
        && input.deadline > parent.effectiveExpiresAt
      )
    ) {
      return unavailableChild("child_scope_widened");
    }
    if (
      parent.session.childCount
        >= FOREGROUND_AUTHORIZATION_MAX_CHILD_VIEWS
    ) {
      return unavailableChild("child_capacity");
    }
    const effectiveExpiresAt = Math.min(
      parent.effectiveExpiresAt,
      input.deadline ?? Number.MAX_SAFE_INTEGER,
    );
    if (effectiveExpiresAt <= this.#now()) {
      return unavailableChild("session_expired");
    }
    const viewId = this.#createViewId();
    if (
      !portableText(viewId)
      || [...parent.session.views].some((view) => view.viewId === viewId)
    ) {
      return unavailableChild("view_id_invalid");
    }
    const view = Object.freeze({
      sessionId: parent.session.sessionId,
      viewId,
      workDescriptorDigestBase64url:
        Buffer.from(input.workDescriptorDigest).toString("base64url"),
    }) as ForegroundAuthorizationView;
    const state: ViewState<Capability> = {
      session: parent.session,
      view,
      parent: input.parent,
      namespaceIds,
      domainIds,
      operations,
      workDescriptorDigest: input.workDescriptorDigest.slice(),
      effectiveExpiresAt,
      children: new Set(),
    };
    this.#views.set(view, state);
    parent.children.add(view);
    parent.session.views.add(view);
    parent.session.childCount += 1;
    return Object.freeze({ status: "created", view });
  }

  leaseOperation(input: Readonly<{
    readonly view: ForegroundAuthorizationView;
    readonly entrypointId: ProtectedExecutionEntrypointId;
    readonly operation: ProtectedExecutionOperation;
    readonly namespaceId: string;
    readonly domainId: string;
    readonly executionDeadline?: number;
  }>): ForegroundAuthorizationLeaseResult {
    const view = this.#views.get(input.view);
    if (view === undefined) return unavailableLease("view_unavailable");
    const unavailable = this.#availability(view.session);
    if (unavailable !== null) return unavailableLease(unavailable);
    if (
      !isEntrypointAllowed(view.session.binding, input.entrypointId)
      || (
        input.operation !== "decrypt"
        && input.operation !== "encrypt"
      )
      || !portableText(input.namespaceId)
      || !portableText(input.domainId)
      || !view.operations.includes(input.operation)
      || !view.namespaceIds.includes(input.namespaceId)
      || !view.domainIds.includes(input.domainId)
    ) {
      return unavailableLease("operation_scope_widened");
    }
    if (
      input.executionDeadline !== undefined
      && (
        !Number.isSafeInteger(input.executionDeadline)
        || input.executionDeadline < 0
      )
    ) {
      return unavailableLease("operation_deadline_invalid");
    }
    const executionDeadline = Math.min(
      view.effectiveExpiresAt,
      input.executionDeadline ?? Number.MAX_SAFE_INTEGER,
    );
    if (executionDeadline <= this.#now()) {
      return unavailableLease("operation_deadline_invalid");
    }
    if (
      this.#liveOperations.size
        >= MAX_FOREGROUND_AUTHORIZATION_OPERATIONS
    ) {
      return unavailableLease("operation_capacity");
    }
    const leaseId = this.#createLeaseId();
    if (
      !portableText(leaseId)
      || [...this.#liveOperations].some((lease) =>
        lease.leaseId === leaseId
      )
    ) {
      return unavailableLease("lease_id_invalid");
    }
    const lease = Object.freeze({
      sessionId: view.session.sessionId,
      leaseId,
    }) as ForegroundAuthorizationOperationLease;
    this.#operations.set(lease, {
      session: view.session,
      view: input.view,
      lease,
      entrypointId: input.entrypointId,
      operation: input.operation,
      target: Object.freeze({
        kind: "single",
        namespaceId: input.namespaceId,
        domainId: input.domainId,
      }),
      executionDeadline,
      status: "ready",
      controller: null,
      abortReason: null,
    });
    this.#liveOperations.add(lease);
    view.session.operations.add(lease);
    return Object.freeze({ status: "leased", lease });
  }

  leaseNamespaceSetOperation(input: Readonly<{
    readonly view: ForegroundAuthorizationView;
    readonly entrypointId: ProtectedExecutionEntrypointId;
    readonly operation: ProtectedExecutionOperation;
    readonly namespaceIds: readonly string[];
    readonly executionDeadline?: number;
  }>): ForegroundAuthorizationLeaseResult {
    const view = this.#views.get(input.view);
    if (view === undefined) return unavailableLease("view_unavailable");
    const unavailable = this.#availability(view.session);
    if (unavailable !== null) return unavailableLease(unavailable);
    const namespaceIds = canonicalIds(
      input.namespaceIds,
      scopeMaximum(view.session.binding),
    );
    if (
      !isEntrypointAllowed(view.session.binding, input.entrypointId)
      || (
        input.operation !== "decrypt"
        && input.operation !== "encrypt"
      )
      || namespaceIds === null
      || !view.operations.includes(input.operation)
      || !isSubset(namespaceIds, view.namespaceIds)
    ) {
      return unavailableLease("operation_scope_widened");
    }
    if (
      input.executionDeadline !== undefined
      && (
        !Number.isSafeInteger(input.executionDeadline)
        || input.executionDeadline < 0
      )
    ) {
      return unavailableLease("operation_deadline_invalid");
    }
    const executionDeadline = Math.min(
      view.effectiveExpiresAt,
      input.executionDeadline ?? Number.MAX_SAFE_INTEGER,
    );
    if (executionDeadline <= this.#now()) {
      return unavailableLease("operation_deadline_invalid");
    }
    if (
      this.#liveOperations.size
        >= MAX_FOREGROUND_AUTHORIZATION_OPERATIONS
    ) {
      return unavailableLease("operation_capacity");
    }
    const leaseId = this.#createLeaseId();
    if (
      !portableText(leaseId)
      || [...this.#liveOperations].some((lease) =>
        lease.leaseId === leaseId
      )
    ) {
      return unavailableLease("lease_id_invalid");
    }
    const lease = Object.freeze({
      sessionId: view.session.sessionId,
      leaseId,
    }) as ForegroundAuthorizationOperationLease;
    this.#operations.set(lease, {
      session: view.session,
      view: input.view,
      lease,
      entrypointId: input.entrypointId,
      operation: input.operation,
      target: Object.freeze({
        kind: "namespace-set",
        namespaceIds,
        domainIds: view.domainIds,
      }),
      executionDeadline,
      status: "ready",
      controller: null,
      abortReason: null,
    });
    this.#liveOperations.add(lease);
    view.session.operations.add(lease);
    return Object.freeze({ status: "leased", lease });
  }

  /**
   * Lease one exact foreground callback that may perform the supplied closed
   * operation set while the retained capability remains inside the registry
   * execution window. This is the M294 composition seam for an Agent turn
   * that decrypts its Human input and encrypts its own output atomically.
   */
  leaseAuthorizationSetOperation(input: Readonly<{
    readonly view: ForegroundAuthorizationView;
    readonly entrypointId: ProtectedExecutionEntrypointId;
    readonly operations: readonly ProtectedExecutionOperation[];
    readonly namespaceIds: readonly string[];
    readonly domainIds: readonly string[];
    readonly executionDeadline?: number;
  }>): ForegroundAuthorizationLeaseResult {
    const view = this.#views.get(input.view);
    if (view === undefined) return unavailableLease("view_unavailable");
    const unavailable = this.#availability(view.session);
    if (unavailable !== null) return unavailableLease(unavailable);
    const operations = canonicalOperations(input.operations);
    const maximum = scopeMaximum(view.session.binding);
    const namespaceIds = canonicalIds(input.namespaceIds, maximum);
    const domainIds = canonicalIds(input.domainIds, maximum);
    if (
      !isEntrypointAllowed(view.session.binding, input.entrypointId)
      || operations === null
      || namespaceIds === null
      || domainIds === null
      || !isSubset(operations, view.operations)
      || !isSubset(namespaceIds, view.namespaceIds)
      || !isSubset(domainIds, view.domainIds)
    ) return unavailableLease("operation_scope_widened");
    if (
      input.executionDeadline !== undefined
      && (!Number.isSafeInteger(input.executionDeadline)
        || input.executionDeadline < 0)
    ) return unavailableLease("operation_deadline_invalid");
    const executionDeadline = Math.min(
      view.effectiveExpiresAt,
      input.executionDeadline ?? Number.MAX_SAFE_INTEGER,
    );
    if (executionDeadline <= this.#now()) {
      return unavailableLease("operation_deadline_invalid");
    }
    if (this.#liveOperations.size >= MAX_FOREGROUND_AUTHORIZATION_OPERATIONS) {
      return unavailableLease("operation_capacity");
    }
    const leaseId = this.#createLeaseId();
    if (
      !portableText(leaseId)
      || [...this.#liveOperations].some((lease) => lease.leaseId === leaseId)
    ) return unavailableLease("lease_id_invalid");
    const lease = Object.freeze({
      sessionId: view.session.sessionId,
      leaseId,
    }) as ForegroundAuthorizationOperationLease;
    this.#operations.set(lease, {
      session: view.session,
      view: input.view,
      lease,
      entrypointId: input.entrypointId,
      operation: operations[0]!,
      target: Object.freeze({
        kind: "authorization-set" as const,
        operations,
        namespaceIds,
        domainIds,
      }),
      executionDeadline,
      status: "ready",
      controller: null,
      abortReason: null,
    });
    this.#liveOperations.add(lease);
    view.session.operations.add(lease);
    return Object.freeze({ status: "leased", lease });
  }

  leaseNamespaceRequirementsOperation(input: Readonly<{
    readonly view: ForegroundAuthorizationView;
    readonly entrypointId: ProtectedExecutionEntrypointId;
    readonly requirements:
      readonly ForegroundAuthorizationNamespaceRequirement[];
    readonly executionDeadline?: number;
  }>): ForegroundAuthorizationLeaseResult {
    const view = this.#views.get(input.view);
    if (view === undefined) return unavailableLease("view_unavailable");
    const unavailable = this.#availability(view.session);
    if (unavailable !== null) return unavailableLease(unavailable);
    const requirements = canonicalNamespaceRequirements(
      input.requirements,
      scopeMaximum(view.session.binding),
    );
    if (
      !isEntrypointAllowed(view.session.binding, input.entrypointId)
      || requirements === null
      || requirements.some((entry) =>
        !view.operations.includes(entry.operation)
        || !view.namespaceIds.includes(entry.namespaceId)
      )
    ) return unavailableLease("operation_scope_widened");
    if (
      input.executionDeadline !== undefined
      && (!Number.isSafeInteger(input.executionDeadline)
        || input.executionDeadline < 0)
    ) return unavailableLease("operation_deadline_invalid");
    const executionDeadline = Math.min(
      view.effectiveExpiresAt,
      input.executionDeadline ?? Number.MAX_SAFE_INTEGER,
    );
    if (executionDeadline <= this.#now()) {
      return unavailableLease("operation_deadline_invalid");
    }
    if (this.#liveOperations.size >= MAX_FOREGROUND_AUTHORIZATION_OPERATIONS) {
      return unavailableLease("operation_capacity");
    }
    const leaseId = this.#createLeaseId();
    if (
      !portableText(leaseId)
      || [...this.#liveOperations].some((lease) => lease.leaseId === leaseId)
    ) return unavailableLease("lease_id_invalid");
    const lease = Object.freeze({
      sessionId: view.session.sessionId,
      leaseId,
    }) as ForegroundAuthorizationOperationLease;
    this.#operations.set(lease, {
      session: view.session,
      view: input.view,
      lease,
      entrypointId: input.entrypointId,
      operation: requirements[0]!.operation,
      target: Object.freeze({
        kind: "namespace-requirements" as const,
        requirements,
        namespaceIds: view.namespaceIds,
        domainIds: view.domainIds,
      }),
      executionDeadline,
      status: "ready",
      controller: null,
      abortReason: null,
    });
    this.#liveOperations.add(lease);
    view.session.operations.add(lease);
    return Object.freeze({ status: "leased", lease });
  }

  async execute<Value>(
    lease: ForegroundAuthorizationOperationLease,
    execute: (plaintext: Uint8Array) => Value | PromiseLike<Value>,
    options: Readonly<{ readonly signal?: AbortSignal }> = {},
  ): Promise<ForegroundAuthorizationExecutionResult<Value>> {
    return this.#executeWithPort(
      lease,
      (operation, signal) => {
        if (operation.target.kind !== "single") {
          throw new Error("Foreground authorization lease kind mismatch");
        }
        if (this.#contentPort === null) {
          return Promise.resolve(Object.freeze({
            status: "unavailable" as const,
            reason: "authorization_unavailable" as const,
          }));
        }
        return this.#contentPort.execute({
          capability: operation.session.capability,
          entrypointId: operation.entrypointId,
          operation: operation.operation,
          namespaceId: operation.target.namespaceId,
          domainId: operation.target.domainId,
          signal,
          execute,
        });
      },
      options,
    );
  }

  executeNamespaceSet<Value>(
    lease: ForegroundAuthorizationOperationLease,
    input: Readonly<{
      readonly contentPort: ForegroundAuthorizationNamespaceSetPort<Capability>;
      readonly execute: () => Value | PromiseLike<Value>;
      readonly signal?: AbortSignal;
    }>,
  ): Promise<ForegroundAuthorizationExecutionResult<Value>> {
    return this.#executeWithPort(
      lease,
      (operation, signal) => {
        if (operation.target.kind !== "namespace-set") {
          throw new Error("Foreground authorization lease kind mismatch");
        }
        return input.contentPort.execute({
          capability: operation.session.capability,
          entrypointId: operation.entrypointId,
          operation: operation.operation,
          namespaceIds: operation.target.namespaceIds,
          domainIds: operation.target.domainIds,
          signal,
          execute: input.execute,
        });
      },
      input,
      false,
      "namespace-set",
    );
  }

  executeWithCapability<Value>(
    lease: ForegroundAuthorizationOperationLease,
    input: Readonly<{
      readonly execute:
        ForegroundAuthorizationCapabilityOperationExecutor<Capability, Value>;
      readonly signal?: AbortSignal;
    }>,
  ): Promise<ForegroundAuthorizationExecutionResult<Value>> {
    return this.#executeWithPort(
      lease,
      async (operation, signal) => {
        if (operation.target.kind !== "authorization-set") {
          throw new Error("Foreground authorization lease kind mismatch");
        }
        return await input.execute(Object.freeze({
          capability: operation.session.capability,
          entrypointId: operation.entrypointId,
          operations: operation.target.operations,
          namespaceIds: operation.target.namespaceIds,
          domainIds: operation.target.domainIds,
          signal,
        }));
      },
      input,
      false,
      "authorization-set",
    );
  }

  executeAgentMemoryOpen(
    lease: ForegroundAuthorizationOperationLease,
    input: Readonly<{
      readonly contentPort: ProtectedInvocationOnly<
        Capability,
        ProtectedAgentMemorySessionContentPort
      >;
      readonly agentId: string;
      readonly authority: ProtectedMemoryAuthority;
      readonly candidates: readonly ProtectedMemoryCandidate[];
      readonly signal?: AbortSignal;
    }>,
  ): Promise<ForegroundAuthorizationExecutionResult<
    ProtectedMemoryResult<readonly ProtectedMemorySessionOpenedItem[]>
  >> {
    return this.#executeWithPort(
      lease,
      (operation, signal) => {
        if (
          operation.target.kind !== "namespace-set"
          || operation.operation !== "decrypt"
        ) throw new Error("Foreground Memory-open lease kind mismatch");
        return input.contentPort.openMany({
          capability: asProtectedInvocationCapability(
            operation.session.capability,
          ),
          entrypointId: operation.entrypointId,
          operation: "decrypt",
          requestedNamespaceIds: operation.target.namespaceIds,
          allowedDomainIds: operation.target.domainIds,
          agentId: input.agentId,
          authority: input.authority,
          candidates: input.candidates,
          signal,
        });
      },
      input,
      true,
      "namespace-set",
    );
  }

  executeAgentMemoryPrepare(
    lease: ForegroundAuthorizationOperationLease,
    input: Readonly<{
      readonly contentPort: ProtectedInvocationOnly<
        Capability,
        ProtectedAgentMemorySessionContentPort
      >;
      readonly agentId: string;
      readonly authority: ProtectedMemoryAuthority;
      readonly plan: ProtectedMemoryMutationPlan;
      readonly content: Parameters<
        ProtectedAgentMemorySessionContentPort["prepare"]
      >[0]["content"];
      readonly signal?: AbortSignal;
    }>,
  ): Promise<ForegroundAuthorizationExecutionResult<
    ProtectedMemoryResult<PreparedMemoryCryptoRevision>
  >> {
    return this.#executeWithPort(
      lease,
      (operation, signal) => {
        if (
          operation.target.kind !== "namespace-set"
          || operation.operation !== "encrypt"
        ) throw new Error("Foreground Memory-prepare lease kind mismatch");
        return input.contentPort.prepare({
          capability: asProtectedInvocationCapability(
            operation.session.capability,
          ),
          entrypointId: operation.entrypointId,
          operation: "encrypt",
          requestedNamespaceIds: operation.target.namespaceIds,
          allowedDomainIds: operation.target.domainIds,
          agentId: input.agentId,
          authority: input.authority,
          plan: input.plan,
          content: input.content,
          signal,
        });
      },
      input,
      true,
      "namespace-set",
    );
  }

  executeAgentMemoryExactAccessPrepare(
    lease: ForegroundAuthorizationOperationLease,
    input: Readonly<{
      readonly contentPort: ProtectedInvocationOnly<
        Capability,
        ProtectedAgentMemoryExactAccessContentPort
      >;
      readonly agentId: string;
      readonly authority: ProtectedMemoryAuthority;
      readonly sourceNamespaceId: string | null;
      readonly plan: AgentMemoryExactAccessPlan;
      readonly signal?: AbortSignal;
    }>,
  ): Promise<ForegroundAuthorizationExecutionResult<
    ProtectedMemoryResult<PreparedAgentMemoryExactAccess>
  >> {
    return this.#executeWithPort(
      lease,
      (operation, signal) => {
        if (operation.target.kind !== "namespace-requirements") {
          throw new Error("Foreground Memory exact-access lease kind mismatch");
        }
        return input.contentPort.prepare({
          capability: asProtectedInvocationCapability(
            operation.session.capability,
          ),
          entrypointId: operation.entrypointId,
          agentId: input.agentId,
          authority: input.authority,
          requestedNamespaceIds: operation.target.namespaceIds,
          allowedDomainIds: operation.target.domainIds,
          sourceNamespaceId: input.sourceNamespaceId,
          plan: input.plan,
          signal,
        });
      },
      input,
      true,
      "namespace-requirements",
    );
  }

  executeAgentMemoryExactAccessCommit<Value>(
    lease: ForegroundAuthorizationOperationLease,
    input: Readonly<{
      readonly contentPort: ProtectedInvocationOnly<
        Capability,
        ProtectedAgentMemoryExactAccessContentPort
      >;
      readonly agentId: string;
      readonly authority: ProtectedMemoryAuthority;
      readonly sourceNamespaceId: string | null;
      readonly plan: AgentMemoryExactAccessPlan;
      readonly prepared: PreparedAgentMemoryExactAccess;
      readonly signal?: AbortSignal;
      readonly commit: () =>
        ProtectedMemoryResult<Value>
        | PromiseLike<ProtectedMemoryResult<Value>>;
    }>,
  ): Promise<ForegroundAuthorizationExecutionResult<
    ProtectedMemoryResult<Value>
  >> {
    return this.#executeWithPort(
      lease,
      (operation, signal) => {
        if (operation.target.kind !== "namespace-requirements") {
          throw new Error("Foreground Memory exact-access lease kind mismatch");
        }
        return input.contentPort.authorizeCommit({
          capability: asProtectedInvocationCapability(
            operation.session.capability,
          ),
          entrypointId: operation.entrypointId,
          agentId: input.agentId,
          authority: input.authority,
          requestedNamespaceIds: operation.target.namespaceIds,
          allowedDomainIds: operation.target.domainIds,
          sourceNamespaceId: input.sourceNamespaceId,
          plan: input.plan,
          prepared: input.prepared,
          signal,
          commit: input.commit,
        });
      },
      input,
      true,
      "namespace-requirements",
    );
  }

  executeAgentMemoryCommit<Value>(
    lease: ForegroundAuthorizationOperationLease,
    input: Readonly<{
      readonly contentPort: ProtectedInvocationOnly<
        Capability,
        ProtectedAgentMemorySessionContentPort
      >;
      readonly agentId: string;
      readonly authority: ProtectedMemoryAuthority;
      readonly target: ProtectedMemoryMutationTarget;
      readonly memoryOperation: "publish" | "replace" | "set-tier";
      readonly signal?: AbortSignal;
      readonly commit: () => Value | PromiseLike<Value>;
    }>,
  ): Promise<ForegroundAuthorizationExecutionResult<
    ProtectedMemoryResult<Value>
  >> {
    return this.#executeWithPort(
      lease,
      (operation, signal) => {
        if (
          operation.target.kind !== "namespace-set"
          || operation.operation !== "encrypt"
        ) throw new Error("Foreground Memory-commit lease kind mismatch");
        return input.contentPort.authorizeCommit({
          capability: asProtectedInvocationCapability(
            operation.session.capability,
          ),
          entrypointId: operation.entrypointId,
          operation: "encrypt",
          requestedNamespaceIds: operation.target.namespaceIds,
          allowedDomainIds: operation.target.domainIds,
          agentId: input.agentId,
          authority: input.authority,
          target: input.target,
          memoryOperation: input.memoryOperation,
          signal,
          commit: input.commit,
        });
      },
      input,
      true,
      "namespace-set",
    );
  }

  /**
   * Checkpoint-only Namespace material route. The bridge executor retains
   * root/keyring ownership; Runtime merely binds it to this exact live lease.
   */
  executeCheckpointNamespace<Value>(
    lease: ForegroundAuthorizationOperationLease,
    input: Readonly<{
      readonly contentPort: ProtectedInvocationOnly<
        Capability,
        ProtectedCheckpointNamespaceSessionContentExecutor
      >;
      readonly expectedAccessRevision: number;
      readonly expectedPolicyRevision: number;
      readonly execute: (
        material: ProtectedCheckpointNamespaceMaterial,
        context: ProtectedCheckpointAuthorizedOperationContext,
      ) => Value | PromiseLike<Value>;
      readonly signal?: AbortSignal;
    }>,
  ): Promise<ForegroundAuthorizationExecutionResult<Value>> {
    return this.#executeWithPort(
      lease,
      async (operation, signal) => {
        if (operation.target.kind !== "single") {
          throw new Error("Foreground authorization lease kind mismatch");
        }
        const result = await input.contentPort.execute({
          capability: asProtectedInvocationCapability(
            operation.session.capability,
          ),
          entrypointId: operation.entrypointId,
          operation: operation.operation,
          namespaceId: operation.target.namespaceId,
          domainId: operation.target.domainId,
          expectedAccessRevision: input.expectedAccessRevision,
          expectedPolicyRevision: input.expectedPolicyRevision,
          signal,
          execute: (material, assertCurrentAuthority) => input.execute(
            material,
            Object.freeze({
              signal,
              assertActive: () => {
                if (
                  signal.aborted
                  || operation.status !== "running"
                  || this.#operations.get(lease) !== operation
                  || operation.session.status !== "active"
                  || operation.session.absoluteExpiresAt <= this.#now()
                  || operation.executionDeadline <= this.#now()
                ) {
                  throw new Error(
                    "Foreground checkpoint authority is unavailable",
                  );
                }
              },
              assertCommitAllowed: async () => {
                if (
                  signal.aborted
                  || operation.status !== "running"
                  || this.#operations.get(lease) !== operation
                  || operation.session.status !== "active"
                  || operation.session.absoluteExpiresAt <= this.#now()
                  || operation.executionDeadline <= this.#now()
                ) {
                  throw new Error(
                    "Foreground checkpoint authority is unavailable",
                  );
                }
                await assertCurrentAuthority();
                if (
                  signal.aborted
                  || operation.status !== "running"
                  || this.#operations.get(lease) !== operation
                  || operation.session.status !== "active"
                  || operation.session.absoluteExpiresAt <= this.#now()
                  || operation.executionDeadline <= this.#now()
                ) {
                  throw new Error(
                    "Foreground checkpoint authority is unavailable",
                  );
                }
              },
              remainingMs: () =>
                Math.max(0, operation.executionDeadline - this.#now()),
            }),
          ),
        });
        if (result.status === "executed") return result;
        return Object.freeze({
          status: "unavailable" as const,
          reason:
            result.reason === "namespace_invalid"
              ? "content_invalid" as const
              : result.reason === "namespace_unavailable"
                ? "content_unavailable" as const
                : "authorization_unavailable" as const,
        });
      },
      input,
      true,
    );
  }

  /**
   * Agent-message preparation route. The bridge retains the invocation
   * capability and every opened key; Runtime receives only an opaque prepared
   * crypto revision after the exact live lease has been revalidated.
   */
  executeAgentConversationPreparation(
    lease: ForegroundAuthorizationOperationLease,
    input: Readonly<{
      readonly contentPort: ProtectedInvocationOnly<
        Capability,
        ProtectedAgentConversationSessionCryptoPreparer
      >;
      readonly expectedAccessRevision: number;
      readonly expectedPolicyRevision: number;
      readonly agentId: string;
      readonly objectId: string;
      readonly payload: MessagePayloadV2;
      readonly createdAt: number;
      readonly signal?: AbortSignal;
    }>,
  ): Promise<
    ForegroundAuthorizationExecutionResult<
      PreparedConversationCryptoRevision
    >
  > {
    return this.#executeWithPort(
      lease,
      async (operation, signal) => {
        if (operation.target.kind !== "single") {
          throw new Error("Foreground authorization lease kind mismatch");
        }
        const result = await input.contentPort.prepare({
          capability: asProtectedInvocationCapability(
            operation.session.capability,
          ),
          entrypointId: operation.entrypointId,
          namespaceId: operation.target.namespaceId,
          domainId: operation.target.domainId,
          expectedAccessRevision: input.expectedAccessRevision,
          expectedPolicyRevision: input.expectedPolicyRevision,
          agentId: input.agentId,
          objectId: input.objectId,
          payload: input.payload,
          createdAt: input.createdAt,
          signal,
        });
        if (result.status === "prepared") {
          return Object.freeze({
            status: "executed" as const,
            value: result.revision,
          });
        }
        return Object.freeze({
          status: "unavailable" as const,
          reason:
            result.reason === "content_invalid"
              ? "content_invalid" as const
              : result.reason === "authorization_unavailable"
                ? "authorization_unavailable" as const
                : "content_unavailable" as const,
        });
      },
      input,
      true,
    );
  }

  async #executeWithPort<Value>(
    lease: ForegroundAuthorizationOperationLease,
    invoke: (
      operation: OperationState<Capability>,
      signal: AbortSignal,
    ) => Promise<
      | Readonly<{ readonly status: "executed"; readonly value: Value }>
      | Readonly<{
        readonly status: "unavailable";
        readonly reason: ProtectedExecutionContentUnavailableReason;
      }>
    >,
    options: Readonly<{ readonly signal?: AbortSignal }>,
    preserveExecutionFailure = false,
    expectedTargetKind: OperationTarget["kind"] = "single",
  ): Promise<ForegroundAuthorizationExecutionResult<Value>> {
    const operation = this.#operations.get(lease);
    if (operation === undefined) {
      return unavailableExecution("lease_unavailable");
    }
    if (operation.status === "running") {
      return unavailableExecution("lease_in_use");
    }
    if (operation.target.kind !== expectedTargetKind) {
      this.#removeOperation(operation);
      return unavailableExecution("lease_unavailable");
    }
    const unavailable = this.#availability(operation.session);
    if (unavailable !== null) {
      this.#removeOperation(operation);
      return unavailableExecution(
        unavailable === "session_idle_expired"
          ? "lease_expired"
          : unavailable === "session_expired"
            ? "session_expired"
            : unavailable === "session_cancelled"
              ? "session_cancelled"
              : "lease_unavailable",
      );
    }
    if (operation.executionDeadline <= this.#now()) {
      this.#removeOperation(operation);
      return unavailableExecution("lease_expired");
    }
    if (options.signal?.aborted === true) {
      this.#removeOperation(operation);
      return unavailableExecution("lease_cancelled");
    }

    operation.status = "running";
    const controller = new AbortController();
    operation.controller = controller;
    const cancel = () => {
      if (operation.abortReason === null) {
        operation.abortReason = "caller";
      }
      controller.abort();
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    const timeout = setTimeout(() => {
      if (operation.abortReason === null) {
        operation.abortReason = "operation_deadline";
        controller.abort();
      }
    }, Math.max(0, operation.executionDeadline - this.#now()));
    timeout.unref?.();
    const aborted = Symbol("foreground-operation-aborted");
    const abortedExecution = new Promise<typeof aborted>((resolve) => {
      if (controller.signal.aborted) {
        resolve(aborted);
        return;
      }
      controller.signal.addEventListener(
        "abort",
        () => resolve(aborted),
        { once: true },
      );
    });

    let result: ForegroundAuthorizationExecutionResult<Value>;
    try {
      let segment: Awaited<ReturnType<typeof invoke>> | null = null;
      try {
        const execution = this.#currentOperation.run(
          lease,
          () => invoke(operation, controller.signal),
        );
        const completed = await Promise.race([
          execution,
          abortedExecution,
        ]);
        if (completed === aborted) {
          result = unavailableExecution(
            this.#abortExecutionReason(
              operation.abortReason ?? "caller",
            ),
          );
          return result;
        }
        segment = completed;
      } catch (error) {
        if (
          preserveExecutionFailure
          && operation.abortReason === null
        ) {
          throw error;
        }
        result = unavailableExecution(
          operation.abortReason === null
            ? "execution_failed"
            : this.#abortExecutionReason(operation.abortReason),
        );
        return result;
      }

      if (operation.abortReason !== null) {
        result = unavailableExecution(
          this.#abortExecutionReason(operation.abortReason),
        );
        return result;
      }
      if (segment.status === "unavailable") {
        if (segment.reason === "authorization_unavailable") {
          this.#beginClose(
            operation.session,
            "authorization_unavailable",
            operation,
          );
        }
        result = unavailableExecution(segment.reason);
        return result;
      }
      const now = this.#now();
      if (now >= operation.session.absoluteExpiresAt) {
        this.#beginClose(operation.session, "session_expired", operation);
        result = unavailableExecution("session_expired");
        return result;
      }
      if (now >= operation.executionDeadline) {
        result = unavailableExecution("lease_expired");
        return result;
      }
      if (operation.session.status !== "active") {
        result = unavailableExecution(
          operation.session.closeReason === "session_expired"
            ? "session_expired"
            : "session_cancelled",
        );
        return result;
      }

      operation.session.idleExpiresAt = Math.min(
        operation.session.absoluteExpiresAt,
        now + FOREGROUND_AUTHORIZATION_IDLE_LIMIT_MS,
      );
      result = Object.freeze({
        status: "executed",
        value: segment.value,
      });
      return result;
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", cancel);
      this.#removeOperation(operation);
      if (
        operation.session.status === "active"
        && this.#now() >= operation.session.idleExpiresAt
        && !this.#hasRunningOperation(operation.session)
      ) {
        this.#beginClose(
          operation.session,
          "session_idle_expired",
          null,
        );
      } else {
        this.#finalizeIfQuiescent(operation.session);
      }
    }
  }

  currentOperationLease(): ForegroundAuthorizationOperationLease | null {
    const lease = this.#currentOperation.getStore();
    if (lease === undefined) return null;
    return this.#operations.get(lease)?.status === "running"
      ? lease
      : null;
  }

  cancelSession(input: Readonly<{
    readonly sessionId: string;
    readonly authenticatedBinding: AuthorizationSessionBinding;
  }>): boolean {
    if (this.#closed) return false;
    const entry = this.#sessions.get(input.sessionId);
    if (entry === undefined) return false;
    const binding = snapshotBinding(input.authenticatedBinding);
    if (binding === null || !sameBinding(entry.binding, binding)) {
      return false;
    }
    this.#beginClose(entry, "session_cancelled", null);
    return true;
  }

  releaseView(view: ForegroundAuthorizationView): boolean {
    const state = this.#views.get(view);
    if (state === undefined) return false;
    if (state.parent === null) {
      this.#beginClose(state.session, "session_cancelled", null);
      return true;
    }
    this.#removeView(state);
    return true;
  }

  sweep(): number {
    let expired = 0;
    const now = this.#now();
    for (const lease of [...this.#liveOperations]) {
      const operation = this.#operations.get(lease);
      if (
        operation === undefined
        || operation.executionDeadline > now
      ) {
        continue;
      }
      if (operation.status === "ready") {
        this.#removeOperation(operation);
      } else {
        if (operation.abortReason === null) {
          operation.abortReason = "operation_deadline";
          operation.controller?.abort();
        }
      }
    }
    for (const entry of [...this.#sessions.values()]) {
      const before = entry.status;
      const unavailable = this.#availability(entry);
      if (unavailable !== null && before === "active") expired += 1;
    }
    return expired;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer !== null) clearInterval(this.#timer);
    for (const entry of [...this.#sessions.values()]) {
      this.#beginClose(entry, "session_cancelled", null);
    }
  }

  #availability(
    entry: SessionEntry<Capability>,
  ): ForegroundAuthorizationResolveReason | null {
    if (entry.status !== "active") {
      if (entry.closeReason === "session_expired") {
        return "session_expired";
      }
      if (entry.closeReason === "session_idle_expired") {
        return "session_idle_expired";
      }
      return "session_cancelled";
    }
    const now = this.#now();
    if (now >= entry.absoluteExpiresAt) {
      this.#beginClose(entry, "session_expired", null);
      return "session_expired";
    }
    if (now >= entry.idleExpiresAt) {
      this.#removeReadyOperations(entry);
      if (!this.#hasRunningOperation(entry)) {
        this.#beginClose(entry, "session_idle_expired", null);
      }
      return "session_idle_expired";
    }
    return null;
  }

  #beginClose(
    entry: SessionEntry<Capability>,
    reason: SessionCloseReason,
    current: OperationState<Capability> | null,
  ): void {
    if (entry.status === "closed") return;
    entry.status = "closing";
    entry.closeReason = reason;
    for (const lease of [...entry.operations]) {
      const operation = this.#operations.get(lease);
      if (operation === undefined) continue;
      if (operation.status === "running" && operation !== current) {
        operation.abortReason =
          reason === "session_expired"
            ? "session_expired"
            : "session_cancelled";
        operation.controller?.abort();
      }
      this.#removeOperation(operation);
    }
    for (const view of [...entry.views]) {
      this.#views.get(view)?.workDescriptorDigest?.fill(0);
      this.#views.delete(view);
    }
    entry.views.clear();
    entry.status = "closed";
    this.#sessions.delete(entry.sessionId);
    this.#capabilityPort.destroy(entry.capability);
  }

  #finalizeIfQuiescent(entry: SessionEntry<Capability>): void {
    if (entry.status === "closing") {
      this.#beginClose(
        entry,
        entry.closeReason ?? "session_cancelled",
        null,
      );
    }
  }

  #hasRunningOperation(entry: SessionEntry<Capability>): boolean {
    for (const lease of entry.operations) {
      if (this.#operations.get(lease)?.status === "running") return true;
    }
    return false;
  }

  #removeReadyOperations(entry: SessionEntry<Capability>): void {
    for (const lease of [...entry.operations]) {
      const operation = this.#operations.get(lease);
      if (operation?.status === "ready") this.#removeOperation(operation);
    }
  }

  #removeOperation(operation: OperationState<Capability>): void {
    this.#operations.delete(operation.lease);
    this.#liveOperations.delete(operation.lease);
    operation.session.operations.delete(operation.lease);
  }

  #removeView(state: ViewState<Capability>): void {
    for (const child of [...state.children]) {
      const childState = this.#views.get(child);
      if (childState !== undefined) this.#removeView(childState);
    }
    for (const lease of [...state.session.operations]) {
      const operation = this.#operations.get(lease);
      if (operation?.view !== state.view) continue;
      if (operation.status === "ready") {
        this.#removeOperation(operation);
      } else {
        operation.abortReason = "view_cancelled";
        operation.controller?.abort();
      }
    }
    if (state.parent !== null) {
      this.#views.get(state.parent)?.children.delete(state.view);
    }
    this.#views.delete(state.view);
    state.session.views.delete(state.view);
    state.workDescriptorDigest?.fill(0);
    state.session.childCount -= 1;
  }

  #abortExecutionReason(
    reason: OperationAbortReason,
  ): ForegroundAuthorizationExecutionReason {
    if (reason === "operation_deadline") return "lease_expired";
    if (reason === "session_expired") return "session_expired";
    if (reason === "session_cancelled") return "session_cancelled";
    return "lease_cancelled";
  }
}
