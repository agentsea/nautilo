import {
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  decryptObjectPayload,
  domainEpoch,
  objectId,
  openAgentRuntimeFromDomain,
  type AgentId,
  type AgentRuntimeKeyGeneration,
  type LatticeCrypto,
  type LatticeStorage,
  type ObjectId,
  type OpenedGrantDomain,
} from "@nautilo/lattice-crypto";
import {
  agentRuntimeConfigDekAadV2,
  decodeEncryptedPayloadV2,
  parseAgentRuntimeDomainEnvelopeV1,
  type HistoricalAgentRuntimeCommitterResolverV1,
} from "@nautilo/lattice-crypto/wire";
import {
  destroyProtectedInvocationCapability,
  executeProtectedGrantCapabilityOperation,
  executeProtectedGrantSessionCapabilityOperation,
  inspectProtectedInvocationCapability,
  type ProtectedGrantAuthorityPort,
  type ProtectedGrantOperation,
  type ProtectedGrantUnavailableReason,
  type ProtectedInvocationCapability,
} from "./protected-grant-invocation.ts";

export type ProtectedAgentRuntimeUnavailableReason =
  | "runtime_unavailable"
  | "configuration_unavailable"
  | "configuration_invalid";

export type ProtectedAgentRuntimeResult<Value> =
  | Readonly<{
    readonly status: "executed";
    readonly value: Value;
  }>
  | Readonly<{
    readonly status: "unavailable";
    readonly reason: ProtectedAgentRuntimeUnavailableReason;
  }>;

export type ProtectedAgentRuntimeCapabilityUnavailableReason =
  | ProtectedGrantUnavailableReason
  | ProtectedAgentRuntimeUnavailableReason;

export type ProtectedAgentRuntimeCapabilityResult<Value> =
  | Readonly<{
    readonly status: "executed";
    readonly value: Value;
  }>
  | Readonly<{
    readonly status: "unavailable";
    readonly reason: ProtectedAgentRuntimeCapabilityUnavailableReason;
  }>;

export interface ProtectedAgentRuntimeContentExecutor {
  readonly execute: <Value>(input: Readonly<{
    readonly capability: ProtectedInvocationCapability;
    readonly operation: ProtectedGrantOperation;
    readonly signal?: AbortSignal;
    readonly execute: (
      plaintext: Uint8Array,
    ) => Value | PromiseLike<Value>;
  }>) => Promise<
    | Readonly<{ readonly status: "executed"; readonly value: Value }>
    | Readonly<{
      readonly status: "unavailable";
      readonly reason:
        | "authorization_unavailable"
        | "content_unavailable"
        | "content_invalid";
    }>
  >;
}

export const PROTECTED_AGENT_RUNTIME_FOREGROUND_ENTRYPOINT_IDS =
  Object.freeze([
    "foreground.conductor",
    "foreground.main",
    "foreground.fork",
    "resume.approval",
    "resume.approval_ask",
    "resume.identity",
    "resume.await_reply",
    "subagent.scope",
  ] as const);

export type ProtectedAgentRuntimeForegroundEntrypointId =
  (typeof PROTECTED_AGENT_RUNTIME_FOREGROUND_ENTRYPOINT_IDS)[number];

export interface ProtectedAgentRuntimeSessionContentExecutor {
  readonly execute: <Value>(input: Readonly<{
    readonly capability: ProtectedInvocationCapability;
    readonly entrypointId: ProtectedAgentRuntimeForegroundEntrypointId;
    readonly operation: ProtectedGrantOperation;
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
      readonly reason:
        | "authorization_unavailable"
        | "content_unavailable"
        | "content_invalid";
    }>
  >;
}

const protectedForegroundEntrypoints = new Set<string>(
  PROTECTED_AGENT_RUNTIME_FOREGROUND_ENTRYPOINT_IDS,
);

function unavailable(
  reason: ProtectedAgentRuntimeUnavailableReason,
): ProtectedAgentRuntimeResult<never> {
  return Object.freeze({ status: "unavailable", reason });
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

type OpenedProtectedAgentRuntime = Readonly<{
  runtime: AgentRuntimeKeyGeneration;
  stored: NonNullable<Awaited<
    ReturnType<LatticeStorage["getAgentRuntimeAtomicState"]>
  >>;
}>;

async function openProtectedAgentRuntime(input: Readonly<{
  crypto: LatticeCrypto;
  storage: Pick<LatticeStorage, "getAgentRuntimeAtomicState">;
  opened: OpenedGrantDomain;
  agentId: AgentId;
  resolveHistoricalCommitter: HistoricalAgentRuntimeCommitterResolverV1;
}>): Promise<OpenedProtectedAgentRuntime | null> {
  let stored: Awaited<
    ReturnType<LatticeStorage["getAgentRuntimeAtomicState"]>
  >;
  try {
    stored = await input.storage.getAgentRuntimeAtomicState(input.agentId);
  } catch {
    return null;
  }
  if (stored === null || stored.runtime.agentId !== input.agentId) return null;
  const envelopeRecords = stored.domainEnvelopes.filter((record) =>
    record.agentId === input.agentId
    && record.domainId === input.opened.domainId
    && record.domainEpoch === input.opened.domainEpoch
    && record.agentAuthorizationRevision
      === input.opened.agentAuthorizationRevision
    && record.runtimeGeneration === stored.runtime.runtimeGeneration
  );
  if (envelopeRecords.length !== 1) return null;
  const envelopeRecord = envelopeRecords[0]!;
  if (
    !equalBytes(
      input.crypto.hash(envelopeRecord.envelopeBytes),
      envelopeRecord.envelopeHash,
    )
  ) return null;
  try {
    const envelope = parseAgentRuntimeDomainEnvelopeV1(
      envelopeRecord.envelopeBytes,
    );
    return Object.freeze({
      runtime: openAgentRuntimeFromDomain({
        crypto: input.crypto,
        domainRoot: input.opened.aiRoot,
        envelope,
        expected: {
          agentId: agentId(envelopeRecord.agentId),
          domainId: cryptoDomainId(envelopeRecord.domainId),
          domainEpoch: domainEpoch(envelopeRecord.domainEpoch),
          agentAuthorizationRevision:
            authorizationRevision(
              envelopeRecord.agentAuthorizationRevision,
            ),
          runtimeGeneration:
            agentRuntimeGeneration(envelopeRecord.runtimeGeneration),
          committerDeviceId:
            cryptoDeviceId(envelopeRecord.committerDeviceId),
        },
        resolveHistoricalCommitter: input.resolveHistoricalCommitter,
      }),
      stored,
    });
  } catch {
    return null;
  }
}

/**
 * Lend the current Runtime generation only for one already-authorized Grant
 * operation. The callback cannot retain a usable key: the owned Runtime key is
 * wiped on every exit.
 */
export async function withProtectedAgentRuntimeGeneration<Value>(
  input: Readonly<{
    crypto: LatticeCrypto;
    storage: Pick<LatticeStorage, "getAgentRuntimeAtomicState">;
    opened: OpenedGrantDomain;
    agentId: AgentId;
    resolveHistoricalCommitter: HistoricalAgentRuntimeCommitterResolverV1;
    execute(
      runtime: AgentRuntimeKeyGeneration,
    ): Value | PromiseLike<Value>;
  }>,
): Promise<ProtectedAgentRuntimeResult<Value>> {
  const opened = await openProtectedAgentRuntime(input);
  if (opened === null) return unavailable("runtime_unavailable");
  try {
    const value = await input.execute(opened.runtime);
    return Object.freeze({ status: "executed", value });
  } finally {
    opened.runtime.key.fill(0);
  }
}

/**
 * Open one current Agent Runtime configuration object only for the duration
 * of `execute`. The caller's Grant coordinator owns and wipes `opened.aiRoot`;
 * this coordinator owns and wipes the opened Runtime key, config DEK, and
 * plaintext on every exit.
 */
export async function withProtectedAgentRuntimeConfiguration<Value>(
  input: Readonly<{
    readonly crypto: LatticeCrypto;
    readonly storage: Pick<
      LatticeStorage,
      "getAgentRuntimeAtomicState" | "getObject"
    >;
    readonly opened: OpenedGrantDomain;
    readonly agentId: AgentId;
    readonly objectId: ObjectId;
    readonly expectedObjectType: string;
    readonly resolveHistoricalCommitter:
      HistoricalAgentRuntimeCommitterResolverV1;
    readonly execute: (
      plaintext: Uint8Array,
    ) => Value | PromiseLike<Value>;
  }>,
): Promise<ProtectedAgentRuntimeResult<Value>> {
  const opened = await openProtectedAgentRuntime(input);
  if (opened === null) return unavailable("runtime_unavailable");
  const { runtime, stored } = opened;

  try {
    const configRecords = stored.configObjects.filter((record) =>
      record.agentId === input.agentId
      && record.objectId === input.objectId
      && record.runtimeGeneration === stored.runtime.runtimeGeneration
    );
    if (configRecords.length !== 1) {
      return unavailable("configuration_unavailable");
    }
    const configRecord = configRecords[0]!;
    if (
      !equalBytes(
        input.crypto.hash(configRecord.wrappedDekBytes),
        configRecord.wrappedDekHash,
      )
    ) {
      return unavailable("configuration_invalid");
    }
    const dek = input.crypto.aeadOpen(
      runtime.key,
      configRecord.wrappedDekBytes,
      agentRuntimeConfigDekAadV2({
        agentId: agentId(configRecord.agentId),
        objectId: objectId(configRecord.objectId),
        configRevision:
          authorizationRevision(configRecord.configRevision),
        runtimeGeneration:
          agentRuntimeGeneration(configRecord.runtimeGeneration),
      }),
    );
    if (dek === null || dek.length !== 32) {
      dek?.fill(0);
      return unavailable("configuration_invalid");
    }

    try {
      let object: Awaited<ReturnType<LatticeStorage["getObject"]>>;
      try {
        object = await input.storage.getObject(input.objectId);
      } catch {
        return unavailable("configuration_unavailable");
      }
      if (object === null || object.objectId !== input.objectId) {
        return unavailable("configuration_unavailable");
      }
      let payload: ReturnType<typeof decodeEncryptedPayloadV2>;
      try {
        payload = decodeEncryptedPayloadV2(object.payloadBytes);
      } catch {
        return unavailable("configuration_invalid");
      }
      if (
        payload.context.objectId !== input.objectId
        || payload.context.keyClass !== "ai"
        || payload.context.objectType !== input.expectedObjectType
      ) {
        return unavailable("configuration_invalid");
      }
      const plaintext = decryptObjectPayload(input.crypto, dek, payload);
      if (plaintext === null) {
        return unavailable("configuration_invalid");
      }
      try {
        const value = await input.execute(plaintext);
        return Object.freeze({ status: "executed", value });
      } finally {
        plaintext.fill(0);
      }
    } finally {
      dek.fill(0);
    }
  } finally {
    runtime.key.fill(0);
  }
}

/**
 * The complete Wave 8 read spine: validate that the opaque Grant capability
 * belongs to the requested Agent, authorize/claim it, open the matching
 * Domain root, then lend exactly one current Runtime configuration plaintext
 * to the callback. Every secret remains owned and wiped by the two composed
 * coordinators.
 */
export async function executeProtectedAgentRuntimeCapabilityOperation<Value>(
  input: Readonly<{
    readonly capability: ProtectedInvocationCapability;
    readonly crypto: LatticeCrypto;
    readonly storage: Pick<
      LatticeStorage,
      | "getGrant"
      | "consumeGrant"
      | "getAgentRuntimeAtomicState"
      | "getObject"
    >;
    readonly operation: ProtectedGrantOperation;
    readonly authority: ProtectedGrantAuthorityPort;
    readonly agentId: AgentId;
    readonly objectId: ObjectId;
    readonly expectedObjectType: string;
    readonly resolveHistoricalCommitter:
      HistoricalAgentRuntimeCommitterResolverV1;
    readonly execute: (
      plaintext: Uint8Array,
    ) => Value | PromiseLike<Value>;
  }>,
): Promise<ProtectedAgentRuntimeCapabilityResult<Value>> {
  try {
    const description =
      inspectProtectedInvocationCapability(input.capability);
    if (
      description === null
      || description.recipientAgentId !== input.agentId
    ) {
      return Object.freeze({
        status: "unavailable",
        reason: "authorization_unavailable",
      });
    }

    const granted = await executeProtectedGrantCapabilityOperation({
      capability: input.capability,
      crypto: input.crypto,
      storage: input.storage,
      operation: input.operation,
      authority: input.authority,
      execute: (opened) =>
        withProtectedAgentRuntimeConfiguration({
          crypto: input.crypto,
          storage: input.storage,
          opened,
          agentId: input.agentId,
          objectId: input.objectId,
          expectedObjectType: input.expectedObjectType,
          resolveHistoricalCommitter: input.resolveHistoricalCommitter,
          execute: input.execute,
        }),
    });
    if (granted.status === "unavailable") return granted;
    return granted.value;
  } finally {
    destroyProtectedInvocationCapability(input.capability);
  }
}

/**
 * Foreground-session variant of the Wave 8 Runtime read spine. Recipient
 * custody remains bridge-owned between operations, while every operation
 * still repeats Grant/current-authority validation and wipes every opened
 * root, Runtime key, DEK, and plaintext buffer before returning.
 */
export async function executeProtectedAgentRuntimeSessionCapabilityOperation<
  Value,
>(
  input: Readonly<{
    readonly capability: ProtectedInvocationCapability;
    readonly crypto: LatticeCrypto;
    readonly storage: Pick<
      LatticeStorage,
      | "getGrant"
      | "consumeGrant"
      | "getAgentRuntimeAtomicState"
      | "getObject"
    >;
    readonly operation: ProtectedGrantOperation;
    readonly namespaceId: string;
    readonly domainId: string;
    readonly authority: ProtectedGrantAuthorityPort;
    readonly agentId: AgentId;
    readonly objectId: ObjectId;
    readonly expectedObjectType: string;
    readonly resolveHistoricalCommitter:
      HistoricalAgentRuntimeCommitterResolverV1;
    readonly execute: (
      plaintext: Uint8Array,
    ) => Value | PromiseLike<Value>;
  }>,
): Promise<ProtectedAgentRuntimeCapabilityResult<Value>> {
  const description =
    inspectProtectedInvocationCapability(input.capability);
  if (
    description === null
    || description.recipientAgentId !== input.agentId
  ) {
    return Object.freeze({
      status: "unavailable",
      reason: "authorization_unavailable",
    });
  }

  const granted =
    await executeProtectedGrantSessionCapabilityOperation({
      capability: input.capability,
      crypto: input.crypto,
      storage: input.storage,
      operation: input.operation,
      namespaceId: input.namespaceId,
      domainId: input.domainId,
      authority: input.authority,
      execute: (opened) =>
        withProtectedAgentRuntimeConfiguration({
          crypto: input.crypto,
          storage: input.storage,
          opened,
          agentId: input.agentId,
          objectId: input.objectId,
          expectedObjectType: input.expectedObjectType,
          resolveHistoricalCommitter: input.resolveHistoricalCommitter,
          execute: input.execute,
        }),
    });
  if (granted.status === "unavailable") return granted;
  return granted.value;
}

/**
 * Bind bridge/storage/authorization dependencies once and expose the narrow
 * structural port consumed by the runtime broker. This factory is dormant
 * until an explicit composition root constructs it.
 */
export function createProtectedAgentRuntimeContentExecutor(input: Readonly<{
  readonly crypto: LatticeCrypto;
  readonly storage: Pick<
    LatticeStorage,
    | "getGrant"
    | "consumeGrant"
    | "getAgentRuntimeAtomicState"
    | "getObject"
  >;
  readonly authority: ProtectedGrantAuthorityPort;
  readonly agentId: AgentId;
  readonly objectId: ObjectId;
  readonly expectedObjectType: string;
  readonly resolveHistoricalCommitter:
    HistoricalAgentRuntimeCommitterResolverV1;
}>): ProtectedAgentRuntimeContentExecutor {
  return Object.freeze({
    execute: async <Value>(request: Readonly<{
      readonly capability: ProtectedInvocationCapability;
      readonly operation: ProtectedGrantOperation;
      readonly signal?: AbortSignal;
      readonly execute: (
        plaintext: Uint8Array,
      ) => Value | PromiseLike<Value>;
    }>) => {
      if (request.signal?.aborted === true) {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "authorization_unavailable" as const,
        });
      }
      const result =
        await executeProtectedAgentRuntimeCapabilityOperation({
          ...input,
          capability: request.capability,
          operation: request.operation,
          execute: (plaintext) => {
            if (request.signal?.aborted === true) {
              throw new Error("protected execution cancelled");
            }
            return request.execute(plaintext);
          },
        });
      if (result.status === "executed") return result;
      if (
        result.reason === "runtime_unavailable"
        || result.reason === "configuration_unavailable"
      ) {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "content_unavailable" as const,
        });
      }
      if (result.reason === "configuration_invalid") {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "content_invalid" as const,
        });
      }
      return Object.freeze({
        status: "unavailable" as const,
        reason: "authorization_unavailable" as const,
      });
    },
  });
}

/**
 * Reusable foreground-session port. The owning runtime registry, not this
 * executor, decides terminal session teardown and destroys the retained
 * recipient capability.
 */
export function createProtectedAgentRuntimeSessionContentExecutor(
  input: Readonly<{
    readonly crypto: LatticeCrypto;
    readonly storage: Pick<
      LatticeStorage,
      | "getGrant"
      | "consumeGrant"
      | "getAgentRuntimeAtomicState"
      | "getObject"
    >;
    readonly authority: ProtectedGrantAuthorityPort;
    readonly agentId: AgentId;
    readonly objectId: ObjectId;
    readonly expectedObjectType: string;
    readonly resolveHistoricalCommitter:
      HistoricalAgentRuntimeCommitterResolverV1;
  }>,
): ProtectedAgentRuntimeSessionContentExecutor {
  return Object.freeze({
    execute: async <Value>(request: Readonly<{
      readonly capability: ProtectedInvocationCapability;
      readonly entrypointId: ProtectedAgentRuntimeForegroundEntrypointId;
      readonly operation: ProtectedGrantOperation;
      readonly namespaceId: string;
      readonly domainId: string;
      readonly signal?: AbortSignal;
      readonly execute: (
        plaintext: Uint8Array,
      ) => Value | PromiseLike<Value>;
    }>) => {
      if (
        request.signal?.aborted === true
        || !protectedForegroundEntrypoints.has(request.entrypointId)
      ) {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "authorization_unavailable" as const,
        });
      }
      const result =
        await executeProtectedAgentRuntimeSessionCapabilityOperation({
          ...input,
          capability: request.capability,
          operation: request.operation,
          namespaceId: request.namespaceId,
          domainId: request.domainId,
          execute: (plaintext) => {
            if (request.signal?.aborted === true) {
              throw new Error("protected execution cancelled");
            }
            return request.execute(plaintext);
          },
        });
      if (result.status === "executed") return result;
      if (
        result.reason === "runtime_unavailable"
        || result.reason === "configuration_unavailable"
      ) {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "content_unavailable" as const,
        });
      }
      if (result.reason === "configuration_invalid") {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "content_invalid" as const,
        });
      }
      return Object.freeze({
        status: "unavailable" as const,
        reason: "authorization_unavailable" as const,
      });
    },
  });
}
