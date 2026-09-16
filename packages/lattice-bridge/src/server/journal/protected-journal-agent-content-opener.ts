import {
  decryptObjectThroughNamespace,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import {
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";

import type {
  ProtectedCheckpointNamespaceMaterial,
} from "../../checkpoint/protected-checkpoint-cell-crypto.ts";
import {
  assertRoomEventPayloadBindingV1,
  decodeRoomEventPayloadV1,
} from "../../journal/room-event-payload-v1.ts";
import {
  assertRoomEventRollupPayloadBindingV1,
  decodeRoomEventRollupPayloadV1,
} from "../../journal/room-event-rollup-payload-v1.ts";
import {
  PROTECTED_JOURNAL_MAX_EVENTS,
  type ProtectedJournalAgentContentOpener,
  type ProtectedJournalOpenedRecord,
  type ProtectedJournalProductRecord,
} from "../../journal/protected-journal-reader.ts";
import type {
  ProtectedAgentRuntimeForegroundEntrypointId,
} from "../../invocation/protected-agent-runtime.ts";

const PROTECTED_JOURNAL_MAX_OUTPUT_SLOTS_PER_WORK = 5;

export interface ProtectedJournalAgentContentAuthorityPort {
  readonly execute: <Value>(input: Readonly<{
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

/**
 * Output of a verifier that has authenticated the object manifest, its
 * processor signature, the append-only signer authorization history, and the
 * exact background work descriptor referenced by that signer.
 */
export interface VerifiedProtectedJournalProcessorObject {
  readonly objectId: string;
  readonly namespaceId: string;
  readonly domainId: string;
  readonly workId: string;
  readonly rebuildGeneration: number;
  readonly outputOrdinal: number;
  readonly authorizedOutputObjectIds: readonly string[];
  readonly publisherNamespaceAccessRevision: number;
  /** Owned buffers transferred to the opener and wiped before it returns. */
  readonly payloadBytes: Uint8Array;
  readonly namespaceEnvelopeBytes: Uint8Array;
}

export interface ProtectedJournalProcessorObjectVerifierPort {
  readonly verify: (input: Readonly<{
    readonly objectId: string;
    readonly signal: AbortSignal;
  }>) => Promise<VerifiedProtectedJournalProcessorObject | null>;
}

export interface ProtectedJournalAgentContentOpenerOptions {
  readonly crypto: LatticeCrypto;
  readonly authority: ProtectedJournalAgentContentAuthorityPort;
  readonly verifiedObjects: ProtectedJournalProcessorObjectVerifierPort;
}

class ProtectedJournalConsumerFailure extends Error {
  declare readonly cause: unknown;

  constructor(cause: unknown) {
    super("Protected journal consumer failed", { cause });
    this.name = "ProtectedJournalConsumerFailure";
    this.cause = cause;
  }
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
  return Array.isArray(material.generations as unknown)
    && material.namespaceId === expected.namespaceId
    && material.domainId === expected.domainId
    && material.accessRevision === expected.accessRevision
    && material.agentAuthorizationRevision === expected.policyRevision
    && Number.isSafeInteger(material.currentGeneration)
    && material.currentGeneration >= 0
    && material.generations.length > 0
    && material.generations.every((entry, index, entries) =>
      Number.isSafeInteger(entry.generation)
      && entry.generation >= 0
      && entry.key instanceof Uint8Array
      && entry.key.length === 32
      && entries.findIndex(
        (candidate) => candidate.generation === entry.generation,
      ) === index
    )
    && material.generations.some(
      (entry) => entry.generation === material.currentGeneration,
    );
}

function evidenceMatches(
  record: ProtectedJournalProductRecord,
  verified: VerifiedProtectedJournalProcessorObject,
  expected: Readonly<{
    namespaceId: string;
    domainId: string;
    rebuildGeneration: number;
  }>,
): boolean {
  const authorizedOutputs = verified.authorizedOutputObjectIds;
  return verified.objectId === record.cryptoObjectId
    && verified.namespaceId === expected.namespaceId
    && verified.domainId === expected.domainId
    && verified.rebuildGeneration === expected.rebuildGeneration
    && record.rebuildGeneration === expected.rebuildGeneration
    && Number.isSafeInteger(verified.publisherNamespaceAccessRevision)
    && verified.publisherNamespaceAccessRevision >= 0
    && Number.isSafeInteger(verified.outputOrdinal)
    && verified.outputOrdinal >= 0
    && Array.isArray(authorizedOutputs)
    && authorizedOutputs.length >= 1
    && authorizedOutputs.length <= PROTECTED_JOURNAL_MAX_OUTPUT_SLOTS_PER_WORK
    && authorizedOutputs.every((objectId, index, values) =>
      typeof objectId === "string"
      && objectId.length > 0
      && values.indexOf(objectId) === index
    )
    && verified.outputOrdinal < authorizedOutputs.length
    && authorizedOutputs[verified.outputOrdinal]
      === record.cryptoObjectId;
}

async function openRecord(input: Readonly<{
  options: ProtectedJournalAgentContentOpenerOptions;
  material: ProtectedCheckpointNamespaceMaterial;
  record: ProtectedJournalProductRecord;
  namespaceId: string;
  domainId: string;
  rebuildGeneration: number;
  signal: AbortSignal;
  assertActive: () => void;
}>): Promise<ProtectedJournalOpenedRecord> {
  input.assertActive();
  const verified = await input.options.verifiedObjects.verify({
    objectId: input.record.cryptoObjectId,
    signal: input.signal,
  });
  input.assertActive();
  if (
    verified === null
    || !evidenceMatches(input.record, verified, input)
  ) {
    throw new TypeError("Protected journal processor evidence is invalid");
  }

  let payloadBytes: Uint8Array | undefined;
  let envelopeBytes: Uint8Array | undefined;
  let plaintext: Uint8Array | null = null;
  let payload: ReturnType<typeof decodeEncryptedPayloadV2> | undefined;
  let envelope:
    ReturnType<typeof decodeNamespaceObjectEnvelopeV2> | undefined;
  try {
    payloadBytes = verified.payloadBytes.slice();
    envelopeBytes = verified.namespaceEnvelopeBytes.slice();
    payload = decodeEncryptedPayloadV2(payloadBytes);
    const decodedEnvelope = decodeNamespaceObjectEnvelopeV2(envelopeBytes);
    envelope = decodedEnvelope;
    if (
      payload.context.objectId !== input.record.cryptoObjectId
      || payload.context.keyClass !== "ai"
      || decodedEnvelope.context.objectId !== input.record.cryptoObjectId
      || decodedEnvelope.context.namespaceId !== input.namespaceId
      || decodedEnvelope.context.keyClass !== "ai"
      || decodedEnvelope.context.bindingRevisionAtWrap
        !== verified.publisherNamespaceAccessRevision
    ) {
      throw new TypeError("Protected journal object binding is invalid");
    }
    const generation = input.material.generations.find(
      (entry) => entry.generation === decodedEnvelope.context.keyGeneration,
    );
    if (generation === undefined) {
      throw new TypeError("Protected journal Namespace generation is missing");
    }
    input.assertActive();
    plaintext = decryptObjectThroughNamespace(
      input.options.crypto,
      generation.key,
      decodedEnvelope,
      payload,
    );
    if (plaintext === null) {
      throw new TypeError("Protected journal ciphertext is invalid");
    }
    input.assertActive();
    if (input.record.kind === "event") {
      if (input.record.payloadFormat === "record_v1") {
        return Object.freeze({
          kind: "event",
          cryptoObjectId: input.record.cryptoObjectId,
          payloadFormat: "record_v1" as const,
          recordPayloadBytes: plaintext.slice(),
        });
      }
      const decoded = decodeRoomEventPayloadV1(plaintext);
      assertRoomEventPayloadBindingV1(decoded, input.record.binding);
      return Object.freeze({
        kind: "event",
        cryptoObjectId: input.record.cryptoObjectId,
        payload: decoded,
      });
    }
    const decoded = decodeRoomEventRollupPayloadV1(plaintext);
    assertRoomEventRollupPayloadBindingV1(decoded, input.record.binding);
    return Object.freeze({
      kind: "rollup",
      cryptoObjectId: input.record.cryptoObjectId,
      payload: decoded,
    });
  } finally {
    plaintext?.fill(0);
    payload?.ciphertext.fill(0);
    envelope?.wrappedDek.fill(0);
    payloadBytes?.fill(0);
    envelopeBytes?.fill(0);
    verified?.payloadBytes.fill(0);
    verified?.namespaceEnvelopeBytes.fill(0);
  }
}

/**
 * Dormant browser-safe journal opener. It owns no ambient authority: every
 * batch must be bound to an injected live foreground Agent session.
 */
export function createProtectedJournalAgentContentOpener(
  options: ProtectedJournalAgentContentOpenerOptions,
): ProtectedJournalAgentContentOpener {
  return Object.freeze({
    openBatch: async <Value>(input: Readonly<{
      readonly authorizationSession: unknown;
      readonly entrypointId: ProtectedAgentRuntimeForegroundEntrypointId;
      readonly namespaceId: string;
      readonly domainId: string;
      readonly rebuildGeneration: number;
      readonly expectedAccessRevision: number;
      readonly expectedPolicyRevision: number;
      readonly records: readonly ProtectedJournalProductRecord[];
      readonly signal?: AbortSignal;
      readonly execute: (
        records: readonly ProtectedJournalOpenedRecord[],
      ) => Value | PromiseLike<Value>;
    }>) => {
      if (
        !Array.isArray(input.records)
        || input.records.length > PROTECTED_JOURNAL_MAX_EVENTS + 1
        || !Number.isSafeInteger(input.rebuildGeneration)
        || input.rebuildGeneration < 0
        || input.signal?.aborted === true
      ) {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "content_invalid" as const,
        });
      }
      try {
        return await options.authority.execute({
          authorizationSession: input.authorizationSession,
          entrypointId: input.entrypointId,
          namespaceId: input.namespaceId,
          domainId: input.domainId,
          expectedAccessRevision: input.expectedAccessRevision,
          expectedPolicyRevision: input.expectedPolicyRevision,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          execute: async (context) => {
            context.assertActive();
            if (!materialMatches(context.material, {
              namespaceId: input.namespaceId,
              domainId: input.domainId,
              accessRevision: input.expectedAccessRevision,
              policyRevision: input.expectedPolicyRevision,
            })) {
              throw new TypeError(
                "Protected journal Namespace material is unauthorized",
              );
            }
            try {
              const opened: ProtectedJournalOpenedRecord[] = [];
              for (const record of input.records) {
                opened.push(await openRecord({
                  options,
                  material: context.material,
                  record,
                  namespaceId: input.namespaceId,
                  domainId: input.domainId,
                  rebuildGeneration: input.rebuildGeneration,
                  signal: context.signal,
                  assertActive: context.assertActive,
                }));
              }
              context.assertActive();
              try {
                return await input.execute(Object.freeze(opened));
              } catch (cause) {
                throw new ProtectedJournalConsumerFailure(cause);
              }
            } catch (cause) {
              if (cause instanceof ProtectedJournalConsumerFailure) {
                throw cause;
              }
              throw new TypeError("Protected journal content is invalid", {
                cause,
              });
            }
          },
        });
      } catch (cause) {
        if (cause instanceof ProtectedJournalConsumerFailure) {
          throw cause.cause;
        }
        return Object.freeze({
          status: "unavailable" as const,
          reason: "content_invalid" as const,
        });
      }
    },
  });
}
