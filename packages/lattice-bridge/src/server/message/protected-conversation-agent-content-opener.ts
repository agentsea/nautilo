import {
  decryptObjectThroughNamespace,
  type LatticeCrypto,
  type LatticeStorage,
} from "@nautilo/lattice-crypto";
import {
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";
import type {
  ProtectedCheckpointNamespaceMaterial,
} from "../../checkpoint/protected-checkpoint-cell-crypto.ts";
import type {
  ConversationProtectedAgentContentOpener,
  ConversationProtectedAgentObjectOutcome,
  ConversationProtectedProductReadRecord,
} from "../../message/conversation-repository.ts";
import type {
  ProtectedAgentRuntimeForegroundEntrypointId,
} from "../../invocation/protected-agent-runtime.ts";
import {
  decodeMessagePayloadV2,
} from "../../message/message-payload-v2.ts";
import type {
  ConversationProtectedMessageDtoV2,
} from "./postgres-conversation-protected-read.ts";
import {
  ConversationCryptoReadUnavailableError,
  readVerifiedStoredConversationCryptoRevision,
  type ResolveHistoricalHumanObjectAccessGenesisSigner,
} from "../storage/postgres-conversation-crypto-completion.ts";
import {
  AgentRuntimeSignerHistoryUnavailableError,
  type ResolveHistoricalAgentRuntimeSignerManagerAuthority,
} from "../storage/agent-runtime-signer-history.ts";

const MAXIMUM_AGENT_READ_BATCH = 256;

export type ConversationProtectedAgentUnavailableReason =
  | "missing_grant"
  | "stale_grant"
  | "unauthorized"
  | "removed"
  | "unsupported_version"
  | "corrupt"
  | "lost_key_material";

export interface ConversationProtectedAgentContentAuthorityPort {
  execute<Value>(input: Readonly<{
    readonly authorizationSession: unknown;
    readonly entrypointId: ProtectedAgentRuntimeForegroundEntrypointId;
    readonly namespaceId: string;
    readonly domainId: string;
    readonly expectedAccessRevision: number;
    readonly expectedPolicyRevision: number;
    readonly signal?: AbortSignal;
    readonly execute: (context: Readonly<{
      readonly material: ProtectedCheckpointNamespaceMaterial;
      readonly signal: AbortSignal;
      readonly assertActive: () => void;
    }>) => Value | PromiseLike<Value>;
  }>): Promise<
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

export interface ProtectedConversationAgentContentOpenerOptions {
  readonly crypto: LatticeCrypto;
  readonly storage: LatticeStorage;
  readonly authority: ConversationProtectedAgentContentAuthorityPort;
  readonly resolveHistoricalHumanSigner:
    ResolveHistoricalHumanObjectAccessGenesisSigner;
  readonly resolveHistoricalAgentSignerAuthority:
    ResolveHistoricalAgentRuntimeSignerManagerAuthority;
}

type ProductRecord =
  ConversationProtectedProductReadRecord<ConversationProtectedMessageDtoV2>;
type ObjectOutcome =
  ConversationProtectedAgentObjectOutcome<
    ConversationProtectedAgentUnavailableReason
  >;

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function decodedBase64url(label: string, value: string): Uint8Array {
  if (
    typeof value !== "string"
    || value.length < 1
    || !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new TypeError(`${label} is malformed`);
  }
  const bytes = new Uint8Array(Buffer.from(value, "base64url"));
  if (
    bytes.length < 1
    || Buffer.from(bytes).toString("base64url") !== value
  ) {
    bytes.fill(0);
    throw new TypeError(`${label} is not canonical base64url`);
  }
  return bytes;
}

function messageCoordinate(record: ProductRecord): Readonly<{
  messageId: number;
  revision: number;
}> {
  const messageId = Number(record.dto.projection.messageId);
  const revision = record.dto.projection.editRevision;
  if (
    !Number.isSafeInteger(messageId)
    || messageId < 1
    || !Number.isSafeInteger(revision)
    || revision < 0
  ) {
    throw new TypeError("Protected Agent message coordinate is malformed");
  }
  return Object.freeze({ messageId, revision });
}

function pendingOrUnavailable(record: ProductRecord): ObjectOutcome | null {
  const coordinate = messageCoordinate(record);
  const protectedPayload = record.dto.protectedPayload;
  if (protectedPayload.status === "pending") {
    return Object.freeze({
      ...coordinate,
      status: "pending",
      reason: protectedPayload.reason,
    });
  }
  if (protectedPayload.status === "unavailable") {
    return Object.freeze({
      ...coordinate,
      status: "unavailable",
      reason: protectedPayload.reason,
    });
  }
  return null;
}

function unavailable(
  record: ProductRecord,
  reason: ConversationProtectedAgentUnavailableReason,
): ObjectOutcome {
  return Object.freeze({
    ...messageCoordinate(record),
    status: "unavailable",
    reason,
  });
}

function materialMatches(
  material: ProtectedCheckpointNamespaceMaterial,
  expected: Readonly<{
    namespaceId: string;
    domainId: string;
    accessRevision: number;
    policyRevision: number;
  }>,
): boolean {
  const generations: ProtectedCheckpointNamespaceMaterial["generations"] =
    material.generations;
  if (!Array.isArray(generations as unknown)) return false;
  return material.namespaceId === expected.namespaceId
    && material.domainId === expected.domainId
    && material.accessRevision === expected.accessRevision
    && material.agentAuthorizationRevision === expected.policyRevision
    && generations.length > 0
    && Number.isSafeInteger(material.currentGeneration)
    && material.currentGeneration >= 0
    && generations.every((entry, index, entries) =>
      Number.isSafeInteger(entry.generation)
      && entry.generation >= 0
      && entry.key instanceof Uint8Array
      && entry.key.length === 32
      && entries.findIndex(
        (candidate) => candidate.generation === entry.generation,
      ) === index
    )
    && generations.some(
      (entry) => entry.generation === material.currentGeneration,
    );
}

async function openRecord(input: Readonly<{
  options: ProtectedConversationAgentContentOpenerOptions;
  material: ProtectedCheckpointNamespaceMaterial;
  record: ProductRecord;
  assertActive: () => void;
}>): Promise<ObjectOutcome> {
  const { record } = input;
  const terminal = pendingOrUnavailable(record);
  if (terminal !== null) return terminal;
  const protectedPayload = record.dto.protectedPayload;
  if (
    protectedPayload.status !== "encrypted"
    || protectedPayload.payloadVersion !== 2
  ) {
    return unavailable(record, "unsupported_version");
  }
  if (protectedPayload.keyClass !== "ai") {
    return unavailable(record, "unauthorized");
  }

  let dtoPayload: Uint8Array | null = null;
  let dtoManifest: Uint8Array | null = null;
  let dtoEnvelope: Uint8Array | null = null;
  let verified: Awaited<
    ReturnType<typeof readVerifiedStoredConversationCryptoRevision>
  > = null;
  try {
    try {
      dtoPayload = decodedBase64url(
        "Protected Agent payload bytes",
        protectedPayload.encryptedPayloadBytesBase64url,
      );
      dtoManifest = decodedBase64url(
        "Protected Agent access manifest bytes",
        protectedPayload.accessManifestBytesBase64url,
      );
      dtoEnvelope = decodedBase64url(
        "Protected Agent Namespace envelope bytes",
        protectedPayload.namespaceEnvelopeBytesBase64url,
      );
    } catch {
      return unavailable(record, "corrupt");
    }

    input.assertActive();
    try {
      verified = await readVerifiedStoredConversationCryptoRevision({
        crypto: input.options.crypto,
        storage: input.options.storage,
        objectId: protectedPayload.cryptoObjectId,
        resolveHistoricalSigner:
          input.options.resolveHistoricalHumanSigner,
        resolveHistoricalAgentSignerAuthority:
          input.options.resolveHistoricalAgentSignerAuthority,
      });
    } catch (cause) {
      if (
        cause instanceof ConversationCryptoReadUnavailableError
        || cause instanceof AgentRuntimeSignerHistoryUnavailableError
      ) {
        throw cause;
      }
      return unavailable(record, "corrupt");
    }
    input.assertActive();
    if (verified === null) {
      return unavailable(record, "lost_key_material");
    }
    if (
      verified.revision.objectId !== protectedPayload.cryptoObjectId
      || verified.revision.namespaceId
        !== record.dto.projection.namespaceId
      || verified.revision.payloadVersion !== protectedPayload.payloadVersion
      || verified.revision.keyClass !== protectedPayload.keyClass
      || !bytesEqual(verified.payloadBytes, dtoPayload)
      || !bytesEqual(
        verified.objectAccessManifestBytes,
        dtoManifest,
      )
      || !bytesEqual(verified.namespaceEnvelopeBytes, dtoEnvelope)
    ) {
      return unavailable(record, "corrupt");
    }

    let payload: ReturnType<typeof decodeEncryptedPayloadV2>;
    let envelope: ReturnType<typeof decodeNamespaceObjectEnvelopeV2>;
    try {
      payload = decodeEncryptedPayloadV2(verified.payloadBytes);
      envelope = decodeNamespaceObjectEnvelopeV2(
        verified.namespaceEnvelopeBytes,
      );
    } catch {
      return unavailable(record, "corrupt");
    }
    try {
      if (
        payload.context.objectId !== protectedPayload.cryptoObjectId
        || envelope.context.objectId !== protectedPayload.cryptoObjectId
        || envelope.context.namespaceId
          !== record.dto.projection.namespaceId
        || envelope.context.keyClass !== "ai"
      ) {
        return unavailable(record, "corrupt");
      }
      const generation = input.material.generations.find(
        (candidate) =>
          candidate.generation === envelope.context.keyGeneration,
      );
      if (generation === undefined) {
        return unavailable(record, "lost_key_material");
      }
      input.assertActive();
      let plaintext: Uint8Array | null;
      try {
        plaintext = decryptObjectThroughNamespace(
          input.options.crypto,
          generation.key,
          envelope,
          payload,
        );
      } catch {
        return unavailable(record, "corrupt");
      }
      if (plaintext === null) return unavailable(record, "corrupt");
      try {
        let decoded;
        try {
          decoded = decodeMessagePayloadV2(plaintext);
        } catch {
          return unavailable(record, "corrupt");
        }
        if (decoded.role !== record.dto.projection.role) {
          return unavailable(record, "corrupt");
        }
        return Object.freeze({
          ...messageCoordinate(record),
          status: "opened",
          payload: decoded,
        });
      } finally {
        plaintext.fill(0);
      }
    } finally {
      payload.ciphertext.fill(0);
      envelope.wrappedDek.fill(0);
    }
  } finally {
    dtoPayload?.fill(0);
    dtoManifest?.fill(0);
    dtoEnvelope?.fill(0);
    verified?.payloadBytes.fill(0);
    verified?.objectAccessManifestBytes.fill(0);
    verified?.namespaceEnvelopeBytes.fill(0);
  }
}

/**
 * Opens one bounded transcript batch under one live foreground operation.
 * Durable bytes are independently authenticated before decryption, and no
 * Namespace key or opened payload bytes escape the authority callback.
 */
export function createProtectedConversationAgentContentOpener(
  options: ProtectedConversationAgentContentOpenerOptions,
): ConversationProtectedAgentContentOpener<
  ConversationProtectedMessageDtoV2,
  ConversationProtectedAgentUnavailableReason
> {
  return Object.freeze({
    openBatch: async <Value>(input: Readonly<{
      readonly authorizationSession: unknown;
      readonly entrypointId: ProtectedAgentRuntimeForegroundEntrypointId;
      readonly namespaceId: string;
      readonly domainId: string;
      readonly expectedAccessRevision: number;
      readonly expectedPolicyRevision: number;
      readonly messages: readonly ProductRecord[];
      readonly signal?: AbortSignal;
      readonly execute: (
        outcomes: readonly ObjectOutcome[],
      ) => Value | PromiseLike<Value>;
    }>) => {
      if (
        !Array.isArray(input.messages)
        || input.messages.length > MAXIMUM_AGENT_READ_BATCH
        || input.signal?.aborted === true
      ) {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "authorization_unavailable" as const,
        });
      }
      return options.authority.execute({
        authorizationSession: input.authorizationSession,
        entrypointId: input.entrypointId,
        namespaceId: input.namespaceId,
        domainId: input.domainId,
        expectedAccessRevision: input.expectedAccessRevision,
        expectedPolicyRevision: input.expectedPolicyRevision,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        execute: async (context) => {
          context.assertActive();
          if (
            !materialMatches(context.material, {
              namespaceId: input.namespaceId,
              domainId: input.domainId,
              accessRevision: input.expectedAccessRevision,
              policyRevision: input.expectedPolicyRevision,
            })
          ) {
            throw new TypeError(
              "Protected Agent Namespace material is unauthorized",
            );
          }
          const outcomes: ObjectOutcome[] = [];
          for (const record of input.messages) {
            context.assertActive();
            outcomes.push(await openRecord({
              options,
              material: context.material,
              record,
              assertActive: context.assertActive,
            }));
          }
          context.assertActive();
          return input.execute(Object.freeze(outcomes));
        },
      });
    },
  });
}
