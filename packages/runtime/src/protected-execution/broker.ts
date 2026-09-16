import {
  decodeTransientAgentRuntimeConfiguration,
  type TransientAgentRuntimeConfiguration,
} from "@nautilo/agent";

import {
  ProtectedInvocationLeaseRegistry,
  type ProtectedInvocationCapability,
  type ProtectedInvocationLease,
  type ProtectedInvocationRegistrationReason,
  type ProtectedInvocationRunReason,
} from "./lease-registry";

const MAX_COORDINATE_ID_BYTES = 256;
const MAX_COORDINATE_SCOPE_IDS = 256;

export const PROTECTED_EXECUTION_ENTRYPOINT_IDS = Object.freeze([
  "foreground.conductor",
  "foreground.main",
  "foreground.fork",
  "resume.approval",
  "resume.approval_ask",
  "resume.identity",
  "resume.await_reply",
  "task.dispatch",
  "task.execute",
  "task.approval_resume",
  "subagent.scope",
  "compaction.model",
  "stenographer.extraction",
  "stenographer.compaction",
  "memory.review",
  "memory.exit_flush",
  "artifact.read",
  "artifact.write",
] as const);

export type ProtectedExecutionEntrypointId =
  (typeof PROTECTED_EXECUTION_ENTRYPOINT_IDS)[number];

export const PROTECTED_EXECUTION_PATH_FAMILIES = Object.freeze([
  "foreground",
  "fork",
  "approval_resume",
  "identity_resume",
  "await_reply_resume",
  "task",
  "subagent",
  "compaction",
  "stenographer",
  "memory",
  "artifact",
] as const);

export type ProtectedExecutionPathFamily =
  (typeof PROTECTED_EXECUTION_PATH_FAMILIES)[number];

export type ProtectedExecutionOperation = "decrypt" | "encrypt";

export type ProtectedExecutionDurableCoordinates = Readonly<{
  readonly invocationId: string;
  readonly grantId: string;
  readonly issuingHumanId: string;
  readonly recipientAgentId: string;
  readonly recipientKeyId: string;
  readonly issuingDeviceId: string;
  readonly namespaceIds: readonly string[];
  readonly domainIds: readonly string[];
  readonly issuedAt: number;
  readonly expiresAt: number;
}>;

export type ProtectedExecutionContentUnavailableReason =
  | "authorization_unavailable"
  | "content_unavailable"
  | "content_invalid";

export type ProtectedExecutionContentResult<Value> =
  | Readonly<{ readonly status: "executed"; readonly value: Value }>
  | Readonly<{
    readonly status: "unavailable";
    readonly reason: ProtectedExecutionContentUnavailableReason;
  }>;

/**
 * Runtime receives this port from the bridge composition root. The port owns
 * every key/root/plaintext byte and lends plaintext only to the exact active
 * callback. Runtime never receives a general-purpose decryptor or root.
 */
export interface ProtectedExecutionContentPort {
  readonly execute: <Value>(input: Readonly<{
    readonly capability: ProtectedInvocationCapability;
    readonly entrypointId: ProtectedExecutionEntrypointId;
    readonly operation: ProtectedExecutionOperation;
    readonly signal?: AbortSignal;
    readonly execute: (
      plaintext: Uint8Array,
    ) => Value | PromiseLike<Value>;
  }>) => Promise<ProtectedExecutionContentResult<Value>>;
}

declare const protectedExecutionHandleBrand: unique symbol;

export type ProtectedExecutionHandle = Readonly<{
  readonly invocationId: string;
  readonly leaseId: string;
  readonly [protectedExecutionHandleBrand]: true;
}>;

export type ProtectedExecutionBindReason =
  | ProtectedInvocationRegistrationReason
  | "coordinates_invalid"
  | "parent_forbidden"
  | "parent_unavailable";

export type ProtectedExecutionBinding =
  | Readonly<{
    readonly status: "ready";
    readonly handle: ProtectedExecutionHandle;
  }>
  | Readonly<{
    readonly status: "unavailable";
    readonly reason: ProtectedExecutionBindReason;
  }>;

export type ProtectedExecutionRunReason =
  | ProtectedInvocationRunReason
  | ProtectedExecutionContentUnavailableReason;

export type ProtectedExecutionRunResult<Value> =
  | Readonly<{ readonly status: "executed"; readonly value: Value }>
  | Readonly<{
    readonly status: "unavailable";
    readonly reason: ProtectedExecutionRunReason;
  }>;

export type ProtectedExecutionDurableSnapshot = Readonly<{
  readonly formatVersion: 1;
  readonly entrypointId: ProtectedExecutionEntrypointId;
  readonly family: ProtectedExecutionPathFamily;
  readonly coordinates: ProtectedExecutionDurableCoordinates;
}>;

type HandleState = {
  readonly lease: ProtectedInvocationLease;
  readonly entrypointId: ProtectedExecutionEntrypointId;
  readonly family: ProtectedExecutionPathFamily;
  readonly coordinates: ProtectedExecutionDurableCoordinates;
};

const textEncoder = new TextEncoder();
const exactCoordinateFields = new Set([
  "invocationId",
  "grantId",
  "issuingHumanId",
  "recipientAgentId",
  "recipientKeyId",
  "issuingDeviceId",
  "namespaceIds",
  "domainIds",
  "issuedAt",
  "expiresAt",
]);

function portableText(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && textEncoder.encode(value).length <= MAX_COORDINATE_ID_BYTES;
}

function canonicalIds(value: unknown): readonly string[] | null {
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.length > MAX_COORDINATE_SCOPE_IDS
    || !value.every(portableText)
  ) {
    return null;
  }
  if (
    value.some((item, index) =>
      index > 0 && String(value[index - 1]) >= String(item)
    )
  ) {
    return null;
  }
  return Object.freeze([...value] as string[]);
}

function snapshotCoordinates(
  value: ProtectedExecutionDurableCoordinates,
): ProtectedExecutionDurableCoordinates | null {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.keys(value).some((field) => !exactCoordinateFields.has(field))
    || Object.keys(value).length !== exactCoordinateFields.size
    || !portableText(value.invocationId)
    || !portableText(value.grantId)
    || !portableText(value.issuingHumanId)
    || !portableText(value.recipientAgentId)
    || !portableText(value.recipientKeyId)
    || !portableText(value.issuingDeviceId)
    || !Number.isSafeInteger(value.issuedAt)
    || !Number.isSafeInteger(value.expiresAt)
    || value.issuedAt < 0
    || value.expiresAt <= value.issuedAt
  ) {
    return null;
  }
  const namespaceIds = canonicalIds(value.namespaceIds);
  const domainIds = canonicalIds(value.domainIds);
  if (namespaceIds === null || domainIds === null) return null;
  return Object.freeze({
    invocationId: value.invocationId,
    grantId: value.grantId,
    issuingHumanId: value.issuingHumanId,
    recipientAgentId: value.recipientAgentId,
    recipientKeyId: value.recipientKeyId,
    issuingDeviceId: value.issuingDeviceId,
    namespaceIds,
    domainIds,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
  });
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function unavailableBind(
  reason: ProtectedExecutionBindReason,
): ProtectedExecutionBinding {
  return Object.freeze({ status: "unavailable", reason });
}

function unavailableRun(
  reason: ProtectedExecutionRunReason,
): ProtectedExecutionRunResult<never> {
  return Object.freeze({ status: "unavailable", reason });
}

export interface ProtectedExecutionBrokerOptions {
  readonly contentPort: ProtectedExecutionContentPort;
  readonly registry?: ProtectedInvocationLeaseRegistry;
}

function forbidsParent(family: ProtectedExecutionPathFamily): boolean {
  return family === "stenographer"
    || family === "memory"
    || family === "task";
}

/**
 * The single runtime custody spine for every protected execution adapter.
 * Handles are object-identity capabilities; their serializable fields are
 * diagnostics only and never reconstruct a lease after restart.
 */
export class ProtectedExecutionBroker {
  readonly #contentPort: ProtectedExecutionContentPort;
  readonly #registry: ProtectedInvocationLeaseRegistry;
  readonly #handles = new WeakMap<object, HandleState>();
  readonly #liveHandles = new Set<ProtectedExecutionHandle>();

  constructor(options: ProtectedExecutionBrokerOptions) {
    this.#contentPort = options.contentPort;
    this.#registry =
      options.registry ?? new ProtectedInvocationLeaseRegistry();
  }

  bind(input: Readonly<{
    readonly entrypointId: ProtectedExecutionEntrypointId;
    readonly family: ProtectedExecutionPathFamily;
    readonly coordinates: ProtectedExecutionDurableCoordinates;
    readonly capability: ProtectedInvocationCapability;
    readonly executionDeadline?: number;
    readonly parent?: ProtectedExecutionHandle;
  }>): ProtectedExecutionBinding {
    let parentLease: ProtectedInvocationLease | undefined;
    if (input.parent !== undefined) {
      if (forbidsParent(input.family)) {
        const discarded = this.#registry.register({
          capability: input.capability,
          ...(input.executionDeadline === undefined
            ? {}
            : { executionDeadline: input.executionDeadline }),
        });
        if (discarded.status === "registered") {
          this.#registry.release(discarded.lease);
        }
        return unavailableBind("parent_forbidden");
      }
      const parentState = this.#liveState(input.parent);
      if (parentState === null) {
        const discarded = this.#registry.register({
          capability: input.capability,
          ...(input.executionDeadline === undefined
            ? {}
            : { executionDeadline: input.executionDeadline }),
        });
        if (discarded.status === "registered") {
          this.#registry.release(discarded.lease);
        }
        return unavailableBind("parent_unavailable");
      }
      parentLease = parentState.lease;
    }

    const registration = this.#registry.register({
      capability: input.capability,
      ...(input.executionDeadline === undefined
        ? {}
        : { executionDeadline: input.executionDeadline }),
      ...(parentLease === undefined ? {} : { parentLease }),
    });
    if (registration.status === "unavailable") return registration;

    const coordinates = snapshotCoordinates(input.coordinates);
    const description = this.#registry.describe(registration.lease);
    if (
      coordinates === null
      || description === null
      || coordinates.invocationId !== description.invocationId
      || coordinates.grantId !== description.grantId
      || coordinates.issuingHumanId !== description.issuingHumanId
      || coordinates.expiresAt !== description.expiresAt
      || coordinates.issuedAt !== description.issuedAt
      || coordinates.issuingDeviceId !== description.issuingDeviceId
      || coordinates.recipientAgentId !== description.recipientAgentId
      || coordinates.recipientKeyId !== description.recipientKeyId
      || !sameIds(coordinates.namespaceIds, description.namespaceIds)
      || !sameIds(coordinates.domainIds, description.domainIds)
    ) {
      this.#registry.release(registration.lease);
      return unavailableBind("coordinates_invalid");
    }

    const handle = Object.freeze({
      invocationId: coordinates.invocationId,
      leaseId: registration.lease.leaseId,
    }) as ProtectedExecutionHandle;
    this.#handles.set(handle, {
      lease: registration.lease,
      entrypointId: input.entrypointId,
      family: input.family,
      coordinates,
    });
    this.#liveHandles.add(handle);
    return Object.freeze({ status: "ready", handle });
  }

  async execute<Value>(
    handle: ProtectedExecutionHandle,
    operation: ProtectedExecutionOperation,
    execute: (plaintext: Uint8Array) => Value | PromiseLike<Value>,
    options: Readonly<{ readonly signal?: AbortSignal }> = {},
  ): Promise<ProtectedExecutionRunResult<Value>> {
    const state = this.#liveState(handle);
    if (state === null) return unavailableRun("lease_unavailable");
    try {
      const segment = await this.#registry.run(
        state.lease,
        async () => {
          const capability = this.#registry.currentCapability();
          if (capability === null) {
            throw new Error("protected capability unavailable");
          }
          return this.#contentPort.execute({
            capability,
            entrypointId: state.entrypointId,
            operation,
            ...(options.signal === undefined
              ? {}
              : { signal: options.signal }),
            execute,
          });
        },
        options,
      );
      if (segment.status === "unavailable") return segment;
      return segment.value;
    } finally {
      this.#handles.delete(handle);
      this.#liveHandles.delete(handle);
    }
  }

  executeRuntimeConfiguration<Value>(
    handle: ProtectedExecutionHandle,
    execute: (
      configuration: TransientAgentRuntimeConfiguration,
    ) => Value | PromiseLike<Value>,
    options: Readonly<{ readonly signal?: AbortSignal }> = {},
  ): Promise<ProtectedExecutionRunResult<Value>> {
    return this.execute(
      handle,
      "decrypt",
      (plaintext) =>
        execute(decodeTransientAgentRuntimeConfiguration(plaintext)),
      options,
    );
  }

  snapshot(
    handle: ProtectedExecutionHandle,
  ): ProtectedExecutionDurableSnapshot | null {
    const state = this.#liveState(handle);
    if (state === null) return null;
    return Object.freeze({
      formatVersion: 1,
      entrypointId: state.entrypointId,
      family: state.family,
      coordinates: state.coordinates,
    });
  }

  release(handle: ProtectedExecutionHandle): boolean {
    const state = this.#handles.get(handle);
    if (state === undefined) return false;
    this.#handles.delete(handle);
    this.#liveHandles.delete(handle);
    return this.#registry.release(state.lease);
  }

  close(): void {
    this.#registry.close();
    for (const handle of this.#liveHandles) this.#handles.delete(handle);
    this.#liveHandles.clear();
  }

  #liveState(handle: ProtectedExecutionHandle): HandleState | null {
    const state = this.#handles.get(handle);
    if (
      state === undefined
      || this.#registry.describe(state.lease) === null
    ) {
      if (state !== undefined) {
        this.#handles.delete(handle);
        this.#liveHandles.delete(handle);
      }
      return null;
    }
    return state;
  }
}
