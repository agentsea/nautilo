import { isDeepStrictEqual } from "node:util";
import { createDormantConversationShadowRepository } from "../../message/conversation-shadow-saga.ts";

import {
  accessRevision,
  decryptObjectThroughNamespace,
  namespaceGeneration,
  namespaceId,
  objectId,
  wrapObjectDekForNamespace,
  type AgentRuntimeKeyGeneration,
  type LatticeCrypto,
  type LatticeStorage,
  type ResolveCurrentDeviceWrappedLiveShadowAgentObjectAccessGenesisAuthorization,
  type ResolveCurrentDeviceWrappedAgentObjectAccessGenesisSetAuthorization,
} from "@nautilo/lattice-crypto";
import {
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
  decodeObjectAccessManifestV2OrV3,
  encodeNamespaceObjectEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";

import {
  conversationExistingRepresentationRepairIdentityDigest,
  conversationOrdinaryRepairIdentityDigest,
  type ConversationExistingRepresentationProductStorePort,
  type ConversationOrdinaryRepairProductStorePort,
  type ConversationProductStorePort,
  type ConversationRepository,
  type AtomicConversationCryptoCompletionPort,
} from "../../message/conversation-repository.ts";
import {
  readPreparedConversationCryptoRevisionSnapshot,
} from "../../message/conversation-prepared-revision.ts";
import {
  prepareForegroundRuntimeExistingMessageCryptoRevision,
} from "../../message/agent-conversation-crypto.ts";
import {
  decodeMessagePayloadV2,
  encodeMessagePayloadV2,
  type MessagePayloadV2,
} from "../../message/message-payload-v2.ts";
import type { ForegroundAgentEntityCryptoInvocation, ForegroundAgentEntityNamespaceAuthority } from
  "../../object/foreground-agent-entity-crypto.ts";
import type {
  ResolveHistoricalAgentRuntimeSignerManagerAuthority,
} from "../storage/agent-runtime-signer-history.ts";
import {
  readVerifiedStoredConversationCryptoRevision,
  type ResolveHistoricalHumanObjectAccessGenesisSigner,
} from "../storage/postgres-conversation-crypto-completion.ts";

/** Narrow compatibility surface used by the Message-only repairer. */
export type ForegroundMessageEntityCryptoInvocation = Pick<
  ForegroundAgentEntityCryptoInvocation,
  "use" | "useCurrentSet"
>;

export type ForegroundMessageRepairSource = Readonly<{
  messageId: number;
  sessionId: string;
  roomId: string;
  namespaceId: string;
  revision: number;
  createdAt: number;
  authorRole: "user" | "assistant" | "tool" | "system";
  authorHumanTurnId: string | null;
  sessionAgentId: string | null;
  mappedCryptoObjectId: string | null;
  payload: MessagePayloadV2 | null;
  /** Ordinary Tool bytes exist, but their call ID is available only after protected open. */
  ordinaryComparison?: "exact" | "tool_result_protected_identity";
}>;

export type ForegroundMessageRepairSourceRepresentationMode =
  | "ordinary-and-protected"
  | "protected-only";

export type ForegroundMessageHistoryResult =
  | Readonly<{
      status: "verified";
      messages: readonly Readonly<{
        messageId: number;
        payload: MessagePayloadV2;
        provenance: "existing" | "repaired";
      }>[];
    }>
  | Readonly<{
      status: "waiting_for_authority" | "failed";
      reason: string;
    }>;

type VerifiedMessage = Extract<
  ForegroundMessageHistoryResult,
  { status: "verified" }
>["messages"][number];

type StoredRepairInspection = Readonly<{
  message: VerifiedMessage;
  namespaceAccessRevision: number;
  namespaceKeyGeneration: number;
  publisher:
    | Readonly<{ kind: "human_device"; id: string }>
    | Readonly<{ kind: "foreground_runtime"; id: string }>;
  attestationDigest: Uint8Array;
}>;

type InternalResult<Value> =
  | Readonly<{ status: "ready"; value: Value }>
  | Readonly<{ status: "waiting" | "failed"; reason: string }>;

export type ForegroundMessageRepairPublicationScope = Readonly<{
  product: ConversationProductStorePort & ConversationExistingRepresentationProductStorePort;
  resolveCurrentAuthorization: ResolveCurrentDeviceWrappedAgentObjectAccessGenesisSetAuthorization;
}>;

export type ForegroundMessageRepairPublication = <Value>(request: Readonly<{
  sessionId: string;
  messageId: number;
  revision: number;
  publicationPolicy: Readonly<{ expectedRevision: number; representation: "ordinary_and_protected" }>;
  signal?: AbortSignal;
  use(scope: ForegroundMessageRepairPublicationScope): Promise<Value>;
}>) => Promise<Value | null>;

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function base64url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function terminal(
  outcome: Exclude<InternalResult<unknown>, { status: "ready" }>,
): ForegroundMessageHistoryResult {
  return Object.freeze({
    status: outcome.status === "waiting"
      ? "waiting_for_authority" as const
      : "failed" as const,
    reason: outcome.reason,
  });
}

/** Keep Message's v3 wire format while admitting repairs through entity authority. */
export function createForegroundExistingMessageWriteAuthorization(input: Readonly<{
  authority: ForegroundAgentEntityNamespaceAuthority;
  resolveCurrentAuthorization: ResolveCurrentDeviceWrappedAgentObjectAccessGenesisSetAuthorization;
}>): ResolveCurrentDeviceWrappedLiveShadowAgentObjectAccessGenesisAuthorization {
  return async (context) => {
    const current = input.authority;
    const setContext: Parameters<ResolveCurrentDeviceWrappedAgentObjectAccessGenesisSetAuthorization>[0] = {
      purpose: "persist-device-wrapped-live-shadow-agent-object-access-genesis-set",
      objectId: context.objectId,
      payloadHash: context.payloadHash,
      operationId: context.operationId,
      grantId: context.grantId,
      grantHash: context.grantHash,
      recipientKeyId: context.recipientKeyId,
      agentId: context.agentId,
      agentAuthorizationRevision: context.agentAuthorizationRevision,
      runtimeGeneration: context.runtimeGeneration,
      signerKeyId: context.signerKeyId,
      envelopes: [context.envelope],
      namespaces: [{
        namespaceId: context.namespaceId,
        accessRevision: context.namespaceAccessRevision,
        keyGeneration: context.envelope.keyGeneration,
        domainId: current.domainId,
        domainKeyGeneration: current.domainKeyGeneration,
        domainAuthorizationRevision: current.domainAuthorizationRevision,
        domainHeadDigest: current.domainHeadDigest,
        headDigest: context.namespaceHeadDigest,
        publicationDigest: context.namespacePublicationDigest,
        publicationSetDigest: context.namespacePublicationSetDigest,
        audienceFingerprint: context.namespaceAudienceFingerprint,
      }],
    };
    const decision = await input.resolveCurrentAuthorization(setContext);
    if (decision === null || !isDeepStrictEqual(decision.context, setContext)) return null;
    return {
      context,
      grantAuthorized: decision.grantAuthorized,
      namespaceAuthorized: decision.namespacesAuthorized,
      agentAuthorized: decision.agentAuthorized,
      hostAllowsOperation: decision.hostAllowsOperation,
      currentRuntime: decision.currentRuntime,
      signerPublicKey: decision.signerPublicKey,
    };
  };
}

/**
 * One invocation-owned Message context repairer. It never acquires a grant or
 * resolves a Domain; every exact Namespace key use goes through `entities`.
 */
export function createForegroundMessageHistoryRepairer(input: Readonly<{
  crypto: LatticeCrypto;
  storage: LatticeStorage;
  entities: ForegroundMessageEntityCryptoInvocation;
  product: ConversationProductStorePort
    & ConversationExistingRepresentationProductStorePort
    & ConversationOrdinaryRepairProductStorePort;
  conversation: ConversationRepository;
  cryptoCompletion: AtomicConversationCryptoCompletionPort;
  contextNamespaceId: string;
  sourceRepresentationMode?: ForegroundMessageRepairSourceRepresentationMode;
  publication: Readonly<{
    operationId: string;
    policyRevision: number;
    grantId: string;
    grantDigest: Uint8Array;
    recipientKeyId: string;
    agentAuthorizationRevision: number;
    signerKeyId: string;
    signerPublicKey: Uint8Array;
    runtime: AgentRuntimeKeyGeneration;
    withCurrentPublication: ForegroundMessageRepairPublication;
  }>;
  loadSources(selection: Readonly<{
    readableNamespaceIds: readonly string[];
    messageIds: readonly number[];
    representationMode: ForegroundMessageRepairSourceRepresentationMode;
  }>): Promise<readonly ForegroundMessageRepairSource[]>;
  resolveHistoricalHumanSigner:
    ResolveHistoricalHumanObjectAccessGenesisSigner;
  resolveHistoricalAgentSignerAuthority:
    ResolveHistoricalAgentRuntimeSignerManagerAuthority;
  /** Authenticated retained foreground execution evidence, not current write authority. */
  resolveLiveShadowAgentSigner?: Parameters<
    typeof readVerifiedStoredConversationCryptoRevision
  >[0]["resolveLiveShadowAgentSigner"];
}>): Readonly<{
  protect(request: Readonly<{
    messageIds: readonly number[];
    signal?: AbortSignal;
  }>): Promise<ForegroundMessageHistoryResult>;
}> {
  const sourceRepresentationMode = input.sourceRepresentationMode
    ?? "ordinary-and-protected";
  const load = async (
    messageIds: readonly number[],
  ): Promise<readonly ForegroundMessageRepairSource[]> =>
    input.loadSources({
      readableNamespaceIds: Object.freeze([input.contextNamespaceId]),
      messageIds,
      representationMode: sourceRepresentationMode,
    });

  const inspectStored = async (
    source: ForegroundMessageRepairSource,
    cryptoObjectId: string,
    provenance: "existing" | "repaired",
  ): Promise<InternalResult<StoredRepairInspection> | null> => {
    const stored = await readVerifiedStoredConversationCryptoRevision({
      crypto: input.crypto,
      storage: input.storage,
      objectId: cryptoObjectId,
      resolveHistoricalSigner: input.resolveHistoricalHumanSigner,
      resolveHistoricalAgentSignerAuthority:
        input.resolveHistoricalAgentSignerAuthority,
      resolveLiveShadowAgentSigner: (principal) =>
        principal.agentId === input.publication.runtime.agentId
            && principal.runtimeGeneration === input.publication.runtime.generation
            && principal.signerKeyId === input.publication.signerKeyId
          ? input.publication.signerPublicKey.slice()
          : input.resolveLiveShadowAgentSigner?.(principal) ?? null,
    });
    if (stored === null) return null;
    let payload: ReturnType<typeof decodeEncryptedPayloadV2> | null = null;
    let envelope: ReturnType<typeof decodeNamespaceObjectEnvelopeV2> | null =
      null;
    try {
      if (
        stored.revision.namespaceId !== source.namespaceId
        || stored.revision.keyClass !== "ai"
      ) {
        return Object.freeze({
          status: "failed" as const,
          reason: "message_crypto_coordinates_mismatch",
        });
      }
      const manifest = decodeObjectAccessManifestV2OrV3(
        stored.objectAccessManifestBytes,
      );
      payload = decodeEncryptedPayloadV2(stored.payloadBytes);
      envelope = decodeNamespaceObjectEnvelopeV2(
        stored.namespaceEnvelopeBytes,
      );
      const currentPayload = payload;
      const currentEnvelope = envelope;
      const opened = await input.entities.use({
        operations: Object.freeze(["decrypt"]),
        entity: Object.freeze({
          namespaceId: source.namespaceId,
          keyGeneration: currentEnvelope.context.keyGeneration,
          accessRevision: currentEnvelope.context.bindingRevisionAtWrap,
        }),
        execute: ({ namespaceKey, authority }) => {
          const plaintext = decryptObjectThroughNamespace(
            input.crypto,
            namespaceKey,
            currentEnvelope,
            currentPayload,
          );
          if (plaintext === null) return Object.freeze({
            status: "decryption_failed" as const,
          });
          try {
            let decoded: MessagePayloadV2;
            try {
              decoded = decodeMessagePayloadV2(plaintext);
            } catch {
              return Object.freeze({ status: "decryption_failed" as const });
            }
            if (decoded.role !== source.authorRole) return Object.freeze({
              status: "role_mismatch" as const,
            });
            if (source.payload !== null) {
              if (
                source.ordinaryComparison === "tool_result_protected_identity"
                && (
                  decoded.role !== "tool"
                  || decoded.sensitiveMetadata === undefined
                  || typeof decoded.sensitiveMetadata["toolCallId"] !== "string"
                )
              ) return Object.freeze({ status: "parity_mismatch" as const });
              const comparisonPayload: MessagePayloadV2 =
                source.ordinaryComparison === "tool_result_protected_identity"
                  ? Object.freeze({
                      ...source.payload,
                      sensitiveMetadata: decoded.sensitiveMetadata!,
                    })
                  : source.payload;
              const expected = encodeMessagePayloadV2(comparisonPayload);
              try {
                if (!equalBytes(plaintext, expected)) return Object.freeze({
                  status: "parity_mismatch" as const,
                });
              } finally {
                expected.fill(0);
              }
            }
            return Object.freeze({
              status: "ready" as const,
              payload: decoded,
              namespaceAccessRevision: authority.namespaceAccessRevision,
              namespaceKeyGeneration: authority.namespaceKeyGeneration,
            });
          } finally {
            plaintext.fill(0);
          }
        },
      });
      if (opened.status !== "executed") {
        return Object.freeze({
          status: "waiting" as const,
          reason: "message_namespace_authority_unavailable",
        });
      }
      if (opened.value.status === "decryption_failed") {
        return Object.freeze({
          status: "failed" as const,
          reason: "message_decryption_failed",
        });
      }
      if (opened.value.status === "role_mismatch") {
        return Object.freeze({
          status: "failed" as const,
          reason: "message_author_role_mismatch",
        });
      }
      if (opened.value.status === "parity_mismatch") {
        return Object.freeze({
          status: "failed" as const,
          reason: "message_parity_mismatch",
        });
      }
      return Object.freeze({
        status: "ready" as const,
        value: Object.freeze({
          message: Object.freeze({
            messageId: source.messageId,
            payload: opened.value.payload,
            provenance,
          }),
          namespaceAccessRevision: opened.value.namespaceAccessRevision,
          namespaceKeyGeneration: opened.value.namespaceKeyGeneration,
          publisher: manifest.formatVersion === 2
            ? Object.freeze({
              kind: "human_device" as const,
              id: manifest.committerDeviceId,
            })
            : Object.freeze({
              kind: "foreground_runtime" as const,
              id: manifest.signer.signerKeyId,
            }),
          attestationDigest: input.crypto.hash(
            stored.objectAccessManifestBytes,
          ),
        }),
      });
    } finally {
      payload?.ciphertext.fill(0);
      envelope?.wrappedDek.fill(0);
      stored.payloadBytes.fill(0);
      stored.objectAccessManifestBytes.fill(0);
      stored.namespaceEnvelopeBytes.fill(0);
    }
  };

  const readStored = async (
    source: ForegroundMessageRepairSource,
    cryptoObjectId: string,
    provenance: "existing" | "repaired",
  ): Promise<InternalResult<StoredRepairInspection>> => {
    const inspected = await inspectStored(source, cryptoObjectId, provenance);
    if (inspected === null) return Object.freeze({
      status: "failed" as const,
      reason: "message_crypto_storage_incomplete",
    });
    if (inspected.status !== "ready") return inspected;
    let transferred = false;
    try {
      const requiresStructuralRevision = sourceRepresentationMode === "protected-only"
        || source.payload === null;
      const current = requiresStructuralRevision
        ? await input.product.getRevisionMapping?.(
          source.sessionId,
          source.messageId,
          source.revision,
        )
        : await input.product.getRevision(source.messageId, source.revision);
      if (
        current === null
        || current === undefined
        || current.message === null
        || current.lifecycle.disposition !== "mapped"
        || current.lifecycle.completion !== "complete"
        || current.lifecycle.cryptoObjectId !== cryptoObjectId
        || current.message.cryptoObjectId !== cryptoObjectId
        || (
          requiresStructuralRevision
          && (
            current.message.messageId !== source.messageId
            || current.message.sessionId !== source.sessionId
            || current.message.revision !== source.revision
            || current.message.authorRole !== source.authorRole
          )
        )
      ) return Object.freeze({
        status: "waiting" as const,
        reason: "message_product_revision_changed",
      });
      transferred = true;
      return Object.freeze({
        status: "ready" as const,
        value: inspected.value,
      });
    } finally {
      if (!transferred) inspected.value.attestationDigest.fill(0);
    }
  };

  const finishStoredRepair = async (
    source: ForegroundMessageRepairSource,
    cryptoObjectId: string,
    signal?: AbortSignal,
  ): Promise<InternalResult<string> | null> => {
    signal?.throwIfAborted();
    const inspected = await inspectStored(
      source,
      cryptoObjectId,
      "repaired",
    );
    if (inspected === null) return null;
    if (inspected.status !== "ready") return inspected;
    try {
      signal?.throwIfAborted();
      const state = await input.product.getRevision(source.messageId, source.revision);
      signal?.throwIfAborted();
      if (state?.lifecycle.cryptoObjectId === cryptoObjectId && state.lifecycle.completion === "complete"
        && state.lifecycle.disposition === "mapped") return Object.freeze({status: "ready" as const, value: cryptoObjectId});
      const deviceWinner = inspected.value.publisher.kind === "human_device";
      if (deviceWinner && (state?.lifecycle.repairPublisherKind !== "human_device"
        || state.lifecycle.repairPublisherId !== inspected.value.publisher.id
        || typeof state.lifecycle.repairPublisherHumanId !== "string"
        || state.lifecycle.repairAttestationDigest === null
        || !equalBytes(state.lifecycle.repairAttestationDigest, inspected.value.attestationDigest))) {
        return Object.freeze({status: "failed" as const, reason: "message_repair_publisher_invalid"});
      }
      const repairPublication = deviceWinner
        ? {publisherKind: "human_device" as const, publisherId: inspected.value.publisher.id,
          publisherHumanId: state!.lifecycle.repairPublisherHumanId!, attestationDigest: inspected.value.attestationDigest}
        : {publisherKind: "foreground_runtime" as const, publisherId: inspected.value.publisher.id,
          attestationDigest: inspected.value.attestationDigest};
      const publicationPolicy = {expectedRevision: input.publication.policyRevision, representation: "ordinary_and_protected" as const};
      const marked = await input.product.markCryptoComplete({
        sessionId: source.sessionId,
        messageId: source.messageId,
        revision: source.revision,
        cryptoObjectId,
        parityStatus: deviceWinner ? "client_authenticated" : "server_verified",
        leaseToken: null,
        repairPublication, publicationPolicy,
      });
      signal?.throwIfAborted();
      if (marked !== "applied" && marked !== "duplicate") {
        return Object.freeze({
          status: marked === "missing" ? "waiting" as const : "failed" as const,
          reason: `message_repair_completion_${marked}`,
        });
      }
      const mapped = await input.product.compareAndSwapCryptoMapping({
        sessionId: source.sessionId,
        messageId: source.messageId,
        revision: source.revision,
        expectedNamespaceId: source.namespaceId,
        cryptoObjectId,
        leaseToken: null, publicationPolicy,
      });
      signal?.throwIfAborted();
      if (mapped === "applied" || mapped === "duplicate") {
        return Object.freeze({ status: "ready" as const, value: cryptoObjectId });
      }
      return Object.freeze({
        status: mapped === "lease_lost" ? "failed" as const : "waiting" as const,
        reason: `message_repair_mapping_${mapped}`,
      });
    } finally {
      inspected.value.attestationDigest.fill(0);
    }
  };

  const repair = async (
    source: ForegroundMessageRepairSource,
    signal?: AbortSignal,
  ): Promise<InternalResult<string>> => {
    signal?.throwIfAborted();
    const sourcePayload = source.payload;
    if (sourcePayload === null) return Object.freeze({
      status: "failed" as const,
      reason: "protected_representation_missing",
    });
    if (source.ordinaryComparison === "tool_result_protected_identity") {
      return Object.freeze({
        status: "failed" as const,
        reason: "protected_tool_identity_missing",
      });
    }
    const encrypted = await input.entities.useCurrentSet({
      operations: Object.freeze(["encrypt"]),
      namespaceIds: Object.freeze([source.namespaceId]),
      execute: async (opened) => {
        signal?.throwIfAborted();
        const current = opened[0];
        if (opened.length !== 1 || current === undefined) {
          return Object.freeze({
            status: "failed" as const,
            reason: "message_namespace_authority_invalid",
          });
        }
        const { namespaceKey, authority } = current;
        const ordinaryBytes = encodeMessagePayloadV2(sourcePayload);
        const requestDigest = input.crypto.hash(ordinaryBytes);
        const repairIdentityDigest =
          conversationExistingRepresentationRepairIdentityDigest({
            sessionId: source.sessionId,
            messageId: source.messageId,
            revision: source.revision,
            namespaceId: source.namespaceId,
            authorRole: source.authorRole,
            authorityFingerprint: authority.namespacePublicationSetDigest,
            policyRevision: input.publication.policyRevision,
          });
        ordinaryBytes.fill(0);
        const operationId = `foreground-repair:${source.messageId}:${
          source.revision
        }:${base64url(repairIdentityDigest)}`;
        try {
          const allocation = await input.product.allocateExistingRepresentation({
            publisher: {
              kind: "foreground_runtime",
              agentId: input.publication.runtime.agentId,
            },
            sessionId: source.sessionId,
            messageId: source.messageId,
            revision: source.revision,
            operationId,
            expectedNamespaceId: source.namespaceId,
            expectedAuthorRole: source.authorRole,
            expectedAuthorHumanTurnId: source.authorHumanTurnId,
            expectedSessionAgentId: source.sessionAgentId,
            requestDigest,
            repairIdentityDigest,
          });
          signal?.throwIfAborted();
          if (allocation.status === "already_mapped") {
            return Object.freeze({ status: "reload" as const });
          }
          if (
            allocation.status !== "allocated"
            && allocation.status !== "replayed"
          ) {
            return Object.freeze({
              status: allocation.status === "stale"
                ? "waiting" as const
                : "failed" as const,
              reason: `message_repair_${allocation.status}`,
            });
          }
          if (allocation.status === "replayed") {
            const resumed = await finishStoredRepair(
              source,
              allocation.lifecycle.cryptoObjectId,
              signal,
            );
            signal?.throwIfAborted();
            if (resumed?.status === "ready") return Object.freeze({
              status: "ready" as const,
              objectId: resumed.value,
            });
            if (resumed !== null) return resumed;
          }
          const objectDek = input.crypto.randomBytes(32);
          const envelopeBytes = encodeNamespaceObjectEnvelopeV2(
            wrapObjectDekForNamespace(
              input.crypto,
              namespaceKey,
              {
                objectId: objectId(allocation.lifecycle.cryptoObjectId),
                namespaceId: namespaceId(source.namespaceId),
                keyClass: "ai",
                keyGeneration: namespaceGeneration(
                  authority.namespaceKeyGeneration,
                ),
                bindingRevisionAtWrap: accessRevision(
                  authority.namespaceAccessRevision,
                ),
              },
              objectDek,
            ),
          );
          try {
            let currentPublicationAuthorization:
              ResolveCurrentDeviceWrappedAgentObjectAccessGenesisSetAuthorization | null = null;
            const prepared =
              prepareForegroundRuntimeExistingMessageCryptoRevision({
                crypto: input.crypto,
                objectId: allocation.lifecycle.cryptoObjectId,
                payload: sourcePayload,
                createdAt: source.createdAt,
                objectDek,
                namespaceEnvelopeBytes: envelopeBytes,
                namespace: {
                  namespaceId: source.namespaceId,
                  accessRevision: authority.namespaceAccessRevision,
                  keyGeneration: authority.namespaceKeyGeneration,
                  headDigest: authority.namespaceHeadDigest,
                  publicationDigest: authority.namespacePublicationDigest,
                  publicationSetDigest:
                    authority.namespacePublicationSetDigest,
                  audienceFingerprint:
                    authority.namespaceAudienceFingerprint,
                  aiKey: namespaceKey,
                },
                operationId: input.publication.operationId,
                grant: {
                  grantId: input.publication.grantId,
                  grantHash: input.publication.grantDigest,
                  recipientKeyId: input.publication.recipientKeyId,
                },
                runtime: input.publication.runtime,
                signerKeyId: input.publication.signerKeyId,
                signerPublicKey: input.publication.signerPublicKey,
                agentAuthorizationRevision:
                  input.publication.agentAuthorizationRevision,
                resolveCurrentAuthorization:
                  createForegroundExistingMessageWriteAuthorization({
                    authority,
                    resolveCurrentAuthorization: async (context) => {
                      signal?.throwIfAborted();
                      if (currentPublicationAuthorization === null) return null;
                      const result = await currentPublicationAuthorization(context);
                      signal?.throwIfAborted();
                      return result;
                    },
                  }),
              });
            const snapshot = readPreparedConversationCryptoRevisionSnapshot(
              prepared,
            );
            const attestationDigest = input.crypto.hash(
              snapshot.value.access.manifestBytes,
            );
            try {
              const publicationPolicy = {expectedRevision: input.publication.policyRevision, representation: "ordinary_and_protected" as const};
              const repairPublication = {publisherKind: "foreground_runtime" as const,
                publisherId: input.publication.signerKeyId, attestationDigest};
              const coordinates = {sessionId: source.sessionId, messageId: source.messageId, revision: source.revision, publicationPolicy};
              const run = async (stage: "reserve" | "publish") => input.publication.withCurrentPublication({
                ...coordinates,
                ...(signal === undefined ? {} : {signal}),
                use: async ({product, resolveCurrentAuthorization}) => {
                  signal?.throwIfAborted();
                  // Every publisher holds the same Message lock across this
                  // absence check and storage write; reservation is durable first.
                  const stored = await input.storage.getObject(allocation.lifecycle.cryptoObjectId);
                  stored?.payloadBytes.fill(0);
                  signal?.throwIfAborted();
                  if (stored !== null) return {status: "stored" as const};
                  if (stage === "reserve") {
                    const reserved = await product.reserveExistingRepresentationPublication({...coordinates,
                      cryptoObjectId: allocation.lifecycle.cryptoObjectId, sourceDigest: requestDigest, repairPublication});
                    signal?.throwIfAborted();
                    return {status: reserved === "reserved" ? "reserved" as const : "stale" as const};
                  }
                  const state = await product.getRevision(source.messageId, source.revision);
                  signal?.throwIfAborted();
                  if (state?.lifecycle.repairPublisherKind !== "foreground_runtime"
                    || state.lifecycle.repairPublisherId !== input.publication.signerKeyId
                    || state.lifecycle.repairAttestationDigest === null
                    || !equalBytes(state.lifecycle.repairAttestationDigest, attestationDigest)) return {status: "stale" as const};
                  currentPublicationAuthorization = resolveCurrentAuthorization;
                  try {
                    const completed = await createDormantConversationShadowRepository({product, crypto: input.cryptoCompletion}).completeRevision({
                      messageId: source.messageId, expectedRevision: source.revision, parityStatus: "server_verified",
                      prepared, publicationPolicy, repairPublication,
                    });
                    signal?.throwIfAborted();
                    return {status: completed.status === "orphaned" ? "stale" as const : "completed" as const};
                  } finally { currentPublicationAuthorization = null; }
                },
              });
              try {
                const reserved = await run("reserve");
                signal?.throwIfAborted();
                const completed = reserved?.status === "reserved" ? await run("publish") : reserved;
                signal?.throwIfAborted();
                if (completed?.status === "stored") {
                  const winner = await finishStoredRepair(source, allocation.lifecycle.cryptoObjectId, signal);
                  return winner?.status === "ready" ? Object.freeze({status: "ready" as const, objectId: winner.value})
                    : winner ?? Object.freeze({status: "waiting" as const, reason: "message_repair_storage_incomplete"});
                }
                if (completed?.status !== "completed") return Object.freeze({status: "waiting" as const, reason: "message_repair_reservation_stale"});
              } catch (error) {
                signal?.throwIfAborted();
                const converged = await finishStoredRepair(source, allocation.lifecycle.cryptoObjectId, signal);
                if (converged?.status === "ready") return Object.freeze({status: "ready" as const, objectId: converged.value});
                if (converged !== null) return converged;
                throw error;
              }
            } finally {
              attestationDigest.fill(0);
            }
          } finally {
            objectDek.fill(0);
            envelopeBytes.fill(0);
          }
          return Object.freeze({
            status: "ready" as const,
            objectId: allocation.lifecycle.cryptoObjectId,
          });
        } finally {
          requestDigest.fill(0);
          repairIdentityDigest.fill(0);
        }
      },
    });
    if (encrypted.status !== "executed") {
      return Object.freeze({
        status: "waiting" as const,
        reason: "message_namespace_authority_unavailable",
      });
    }
    if (encrypted.value.status === "reload") {
      const [current] = await load([source.messageId]);
      return current?.revision === source.revision
          && current.mappedCryptoObjectId !== null
        ? Object.freeze({
          status: "ready" as const,
          value: current.mappedCryptoObjectId,
        })
        : Object.freeze({
          status: "waiting" as const,
          reason: "message_product_revision_changed",
        });
    }
    if (encrypted.value.status !== "ready") return encrypted.value;
    return Object.freeze({
      status: "ready" as const,
      value: encrypted.value.objectId,
    });
  };

  return Object.freeze({
    protect: async (request: Readonly<{
      messageIds: readonly number[];
      signal?: AbortSignal;
    }>): Promise<ForegroundMessageHistoryResult> => {
      const cancelled = (): boolean => request.signal?.aborted ?? false;
      if (
        new Set(request.messageIds).size !== request.messageIds.length
        || request.messageIds.some((id) =>
          !Number.isSafeInteger(id) || id < 1
        )
      ) {
        return Object.freeze({
          status: "failed" as const,
          reason: "invalid_selected_history",
        });
      }
      if (cancelled()) {
        return Object.freeze({
          status: "waiting_for_authority" as const,
          reason: "cancelled",
        });
      }
      let failureStage:
        | "source_load"
        | "forward_repair"
        | "stored_open"
        | "ordinary_restore" = "source_load";
      try {
        const sources = await load(request.messageIds);
        if (cancelled()) return Object.freeze({
          status: "waiting_for_authority" as const,
          reason: "cancelled",
        });
        const selectedIds = new Set(request.messageIds);
        if (
          sources.length !== selectedIds.size
          || sources.some((source) => !selectedIds.has(source.messageId))
        ) return Object.freeze({
          status: "waiting_for_authority" as const,
          reason: "message_product_revision_changed",
        });
        if (
          new Set(sources.map((source) => source.messageId)).size
            !== sources.length
        ) return Object.freeze({
          status: "failed" as const,
          reason: "message_selection_duplicated",
        });
        if (sources.some((source) =>
          source.namespaceId !== input.contextNamespaceId
        )) return Object.freeze({
          status: "failed" as const,
          reason: "message_authority_scope_mismatch",
        });
        if (
          sourceRepresentationMode === "protected-only"
          && sources.some((source) => source.payload !== null)
        ) return Object.freeze({
          status: "failed" as const,
          reason: "ordinary_source_forbidden",
        });
        const messages: VerifiedMessage[] = [];
        for (const source of sources) {
          if (cancelled()) {
            return Object.freeze({
              status: "waiting_for_authority" as const,
              reason: "cancelled",
            });
          }
          let objectIdValue = source.mappedCryptoObjectId;
          let provenance: "existing" | "repaired" = "existing";
          if (objectIdValue === null) {
            failureStage = "forward_repair";
            const repaired = await repair(source, request.signal);
            if (repaired.status !== "ready") return terminal(repaired);
            if (cancelled()) return Object.freeze({
              status: "waiting_for_authority" as const,
              reason: "cancelled",
            });
            objectIdValue = repaired.value;
            provenance = "repaired";
          }
          failureStage = "stored_open";
          const opened = await readStored(
            source,
            objectIdValue,
            provenance,
          );
          if (opened.status !== "ready") return terminal(opened);
          try {
            if (cancelled()) return Object.freeze({
              status: "waiting_for_authority" as const,
              reason: "cancelled",
            });
          if (
            sourceRepresentationMode === "ordinary-and-protected"
            && source.payload === null
          ) {
              failureStage = "ordinary_restore";
              const payload = opened.value.message.payload;
              const repairIdentityDigest = conversationOrdinaryRepairIdentityDigest({
                sessionId: source.sessionId,
                messageId: source.messageId,
                revision: source.revision,
                cryptoObjectId: objectIdValue,
              namespaceId: source.namespaceId,
              namespaceAccessRevision:
                opened.value.namespaceAccessRevision,
              namespaceKeyGeneration: opened.value.namespaceKeyGeneration,
              keyClass: "ai",
                publisherKind: "authenticated_runtime",
                publisherId: input.publication.signerKeyId,
                policyRevision: input.publication.policyRevision,
              });
              try {
                const restored = await input.product
                  .restoreOrdinaryExistingRepresentation({
                  sessionId: source.sessionId,
                  messageId: source.messageId,
                  revision: source.revision,
                  cryptoObjectId: objectIdValue,
                  expectedNamespaceId: source.namespaceId,
                  expectedKeyClass: "ai",
                  expectedNamespaceAccessRevision:
                    opened.value.namespaceAccessRevision,
                  expectedNamespaceKeyGeneration:
                    opened.value.namespaceKeyGeneration,
                  expectedAuthorRole: source.authorRole,
                  expectedCreatedAt: source.createdAt,
                  content: payload.content,
                  toolCalls: payload.toolCalls === undefined
                    ? null : JSON.stringify(payload.toolCalls),
                  toolName: payload.toolName ?? null,
                  authorityActorId: input.publication.runtime.agentId,
                  repairIdentityDigest,
                  attestationDigest: opened.value.attestationDigest,
                  publisher: {
                    kind: "authenticated_runtime",
                    id: input.publication.signerKeyId,
                  },
                  publicationPolicy: {
                    expectedRevision: input.publication.policyRevision,
                    representation: "ordinary_and_protected",
                  },
                  });
                if (restored !== "applied" && restored !== "replayed") {
                  return terminal(Object.freeze({
                    status: restored === "conflict" ? "failed" as const
                      : "waiting" as const,
                    reason: `message_ordinary_repair_${restored}`,
                  }));
                }
                if (restored === "applied") provenance = "repaired";
              } finally {
                repairIdentityDigest.fill(0);
              }
            }
            messages.push(Object.freeze({
              ...opened.value.message,
              provenance,
            }));
          } finally {
            opened.value.attestationDigest.fill(0);
          }
        }
        return Object.freeze({
          status: "verified" as const,
          messages: Object.freeze(messages),
        });
      } catch {
        if (cancelled()) return Object.freeze({ status: "waiting_for_authority" as const, reason: "cancelled" });
        return Object.freeze({
          status: "failed" as const,
          reason: `message_${failureStage}_failed`,
        });
      }
    },
  });
}
