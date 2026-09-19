import {
  accessRevision,
  decryptObjectPayload,
  namespaceGeneration,
  namespaceId,
  objectId,
  openDeviceWrappedAgentLiveShadowStreamFrame,
  prepareDeviceWrappedAgentLiveShadowStreamStart,
  sealDeviceWrappedAgentLiveShadowStreamFrame,
  unixTimestamp,
  wrapObjectDekForNamespace,
  type AgentRuntimeKeyGeneration,
  type LatticeCrypto,
  type ForegroundSessionLiveShadowMessagePlan,
  type ResolveCurrentDeviceWrappedLiveShadowAgentObjectAccessGenesisAuthorization,
} from "@nautilo/lattice-crypto";
import {
  AGENT_LIVE_SHADOW_STREAM_MAX_TTL_MS_V2,
  decodeEncryptedPayloadV2,
  encodeLiveShadowMessagePlanV4,
  encodeNamespaceObjectEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";
import {
  parseProtectedMessageDtoV2,
  type ProtectedMessageDtoV2,
} from "@nautilo/types";

import {
  decodeMessagePayloadV2,
  encodeMessagePayloadV2,
  type MessagePayloadV2,
} from "../../message/message-payload-v2.ts";
import type {
  ProtectedAgentMemoryAccessPort,
  ProtectedAgentMemoryProjectionPort,
  ProtectedAgentMemoryRepository,
} from
  "../../memory/active-memory-repository.ts";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import { fullEncryptionDurableEventDigestV2, liveShadowDurableEventDigestV1 } from
  "../../message/live-shadow-realtime-evidence.ts";
import type {
  ConversationAllocatedRevision,
  ConversationProductStorePort,
  ConversationRepository,
} from "../../message/conversation-repository.ts";
import {
  readPreparedConversationCryptoRevisionSnapshot,
} from "../../message/conversation-prepared-revision.ts";
import {
  prepareDeviceWrappedLiveShadowAgentConversationCryptoRevisionWithDek,
} from "../../message/agent-conversation-crypto.ts";
import type { ForegroundMessageHistoryResult } from
  "./foreground-message-history-repair.ts";
import type { ForegroundJournalHistoryResult } from
  "../../journal/foreground-journal-selection.ts";
import type {
  ForegroundRecordHistoryResult,
  ForegroundRecordSourceSelection,
} from "../../object/foreground-record-history.ts";
import type {
  ForegroundMemoryRepairSelection,
  ForegroundMemoryHistoryResult,
} from "../../memory/foreground-memory-history.ts";
import type { ProtectedCheckpointCellCrypto } from
  "../../checkpoint/protected-checkpoint-cell-crypto.ts";

const ZERO_HASH = new Uint8Array(32);

declare const reservationBrand: unique symbol;
export type LiveShadowAgentMessageReservation = Readonly<{
  readonly messageId: number;
  readonly transcriptOrdinal: number;
  readonly authorRole: "assistant" | "tool";
  readonly [reservationBrand]: true;
}>;

export type LiveShadowAgentSessionFailureStage =
  | "agent_input"
  | "assistant_stream"
  | "assistant_message"
  | "tool_call"
  | "tool_result"
  | "durable_transcript";

export type LiveShadowAgentSessionFailureReason =
  | "protected_unavailable"
  | "integrity_failure"
  | "parity_mismatch"
  | "deadline_expired"
  | "cancelled"
  | "process_lost";

export type LiveShadowAgentSessionResult<Value> =
  | Readonly<{ status: "protected"; value: Value }>
  | Readonly<{
      status: "ordinary_fallback";
      stage: LiveShadowAgentSessionFailureStage;
      reason: LiveShadowAgentSessionFailureReason;
      ordinaryPublication?: LiveShadowAgentOrdinaryPublication;
    }>;

export type LiveShadowAgentTurnExecutionResult<Value> =
  | Readonly<{ status: "executed"; value: Value }>
  | Readonly<{ status: "ordinary_fallback"; reason?: string }>;

export interface LiveShadowAgentOrdinaryPublication {
  readonly createdAt?: string;
  readonly reservation: LiveShadowAgentMessageReservation;
  readonly payload: MessagePayloadV2;
  readonly assistantMessageKey: string | null;
}

export interface LiveShadowAgentStreamReservation {
  readonly reservation: LiveShadowAgentMessageReservation;
  readonly startBytes: Uint8Array;
}

export interface LiveShadowAgentStreamFrameResult {
  readonly frameBytes: Uint8Array;
  readonly terminal: boolean;
}

export interface LiveShadowAgentPublishedMessage {
  /** Ordinary bytes below are transient only; Full transports must omit them. */
  readonly representationMode?: "shadow_encryption" | "full_encryption";
  readonly reservation: LiveShadowAgentMessageReservation;
  readonly policyRevision: number;
  readonly ordinaryPayloadBytes: Uint8Array;
  readonly openedPayload: MessagePayloadV2;
  readonly protectedMessage: ProtectedMessageDtoV2;
  readonly durableEventDigest: Uint8Array;
  readonly streamEvidence: Readonly<{
    readonly streamId: string;
    readonly startDigest: Uint8Array;
    readonly terminalDigest: Uint8Array;
    readonly streamedTextDigest: Uint8Array;
  }> | null;
}

export interface LiveShadowAgentTurnSession {
  readonly representationMode?: "shadow_encryption" | "full_encryption";
  /** Exact expiry of the invocation authority that owns this session. */
  readonly authorizationDeadlineAt?: number;
  /** Aborts immediately when the retained invocation authority is revoked. */
  readonly authorizationSignal?: AbortSignal;
  /**
   * Invocation-bound encrypted checkpoint authority. The Runtime owns the
   * physical saver; this bridge owns only the crypto operation boundary.
   */
  readonly checkpoint?: Readonly<{
    crypto: ProtectedCheckpointCellCrypto;
    namespaceId: string;
    namespaceAccessRevision: number;
    agentAuthorizationRevision: number;
    authorizationSession: object;
  }>;
  /** Self-contained public V4 authority bytes for an XH1A recipient peer. */
  sharedAgentRealtimePlanBytes?(): Uint8Array | null;
  protectForegroundHistory?(input: Readonly<{
    messageIds: readonly number[];
    signal?: AbortSignal;
  }>): Promise<ForegroundMessageHistoryResult>;
  protectForegroundJournal?(input: Readonly<{
    maximumEvents: number;
    signal?: AbortSignal;
  }>): Promise<ForegroundJournalHistoryResult>;
  protectForegroundRecords?(input: Readonly<{
    records: readonly ForegroundRecordSourceSelection[];
    signal?: AbortSignal;
  }>): Promise<ForegroundRecordHistoryResult>;
  protectForegroundMemories?(input: Readonly<{
    memories: readonly ForegroundMemoryRepairSelection[];
    signal?: AbortSignal;
  }>): Promise<ForegroundMemoryHistoryResult>;
  /** Build one invocation-bound protected Memory tool repository. */
  createForegroundMemoryRepository?(
    envelope: MemoryAccessEnvelope,
  ): Promise<ProtectedAgentMemoryRepository>;
  createForegroundMemoryAccessPort?(
    envelope: MemoryAccessEnvelope,
  ): Promise<ProtectedAgentMemoryAccessPort>;
  createForegroundMemoryProjectionPort?(
    envelope: MemoryAccessEnvelope,
  ): Promise<ProtectedAgentMemoryProjectionPort>;
  reserveAssistantStream(input: Readonly<{
    assistantMessageKey: string;
    createdAt: number;
  }>): Promise<LiveShadowAgentSessionResult<LiveShadowAgentStreamReservation>>;
  sealAssistantStreamChunk(input: Readonly<{
    reservation: LiveShadowAgentMessageReservation;
    ordinaryChunk: Uint8Array;
    done: boolean;
    finalPayload?: MessagePayloadV2;
  }>): LiveShadowAgentSessionResult<LiveShadowAgentStreamFrameResult>;
  publishMessage(input: Readonly<{
    payload: MessagePayloadV2;
    stage: "assistant_message" | "tool_call" | "tool_result";
    reservation?: LiveShadowAgentMessageReservation;
    createdAt?: number;
  }>): Promise<LiveShadowAgentSessionResult<LiveShadowAgentPublishedMessage>>;
  fail(
    stage: LiveShadowAgentSessionFailureStage,
    reason?: LiveShadowAgentSessionFailureReason,
  ): void;
  destroy(): void;
}

type ReservationState = {
  readonly token: LiveShadowAgentMessageReservation;
  readonly allocation: ConversationAllocatedRevision;
  readonly createdAt: number;
  readonly reservationDigest: Uint8Array;
  readonly objectDek: Uint8Array;
  readonly envelopeBytes: Uint8Array;
  readonly assistantMessageKey: string | null;
  startBytes: Uint8Array | null;
  streamStartDigest: Uint8Array | null;
  previousFrameHash: Uint8Array;
  nextSequence: number;
  accumulatedChunks: Uint8Array[];
  accumulatedBytes: number;
  terminalFrameDigest: Uint8Array | null;
  terminalStreamedTextDigest: Uint8Array | null;
  terminalPayloadDigest: Uint8Array | null;
  readonly nonceKeys: Set<string>;
  published: LiveShadowAgentPublishedMessage | null;
};

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function base64url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function concat(values: readonly Uint8Array[]): Uint8Array {
  const length = values.reduce((total, value) => total + value.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}

function unavailable(
  stage: LiveShadowAgentSessionFailureStage,
  reason: LiveShadowAgentSessionFailureReason,
): LiveShadowAgentSessionResult<never> {
  return Object.freeze({ status: "ordinary_fallback" as const, stage, reason });
}

function withOrdinaryPublication(
  fallback: ReturnType<typeof unavailable>,
  publication: LiveShadowAgentOrdinaryPublication,
): LiveShadowAgentSessionResult<never> {
  return Object.freeze({ ...fallback, ordinaryPublication: publication });
}

/**
 * Build the callback-scoped cryptographic half of one admitted live turn.
 * Namespace and Runtime secret copies remain owned by this object and are
 * destroyed with every per-Message DEK when the Job scope closes.
 */
export function createLiveShadowAgentTurnSession(input: Readonly<{
  crypto: LatticeCrypto;
  plan: ForegroundSessionLiveShadowMessagePlan;
  /** Retained from the current policy whose revision is bound by the plan. */
  representationMode?: "shadow_encryption" | "full_encryption";
  causalHumanUserId: string;
  /** Defaults to the plan operation for ordinary 1H1A turns. */
  causalHumanTurnId?: string;
  product: ConversationProductStorePort;
  conversation: ConversationRepository;
  namespace: Readonly<{
    namespaceId: string;
    accessRevision: number;
    headDigest: Uint8Array;
    publicationDigest: Uint8Array;
    publicationSetDigest: Uint8Array;
    audienceFingerprint: Uint8Array;
    keyGeneration: number;
    aiKey: Uint8Array;
  }>;
  runtime: AgentRuntimeKeyGeneration;
  grantId: string;
  grantDigest: Uint8Array;
  /** Exact expiry of the retained foreground authorization, not the request plan. */
  authorizationDeadlineAt?: number;
  /** Exact cancellation signal of the retained foreground authorization. */
  authorizationSignal?: AbortSignal;
  checkpoint?: LiveShadowAgentTurnSession["checkpoint"];
  /** Standing M294 recipient key when the per-turn plan carries only a reference. */
  recipientKeyId?: string;
  resolveCurrentDeviceWrappedAgentObjectAuthorization:
    ResolveCurrentDeviceWrappedLiveShadowAgentObjectAccessGenesisAuthorization;
  protectForegroundHistory?: LiveShadowAgentTurnSession["protectForegroundHistory"];
  protectForegroundJournal?: LiveShadowAgentTurnSession["protectForegroundJournal"];
  protectForegroundRecords?: LiveShadowAgentTurnSession["protectForegroundRecords"];
  protectForegroundMemories?: LiveShadowAgentTurnSession["protectForegroundMemories"];
  createForegroundMemoryRepository?:
    LiveShadowAgentTurnSession["createForegroundMemoryRepository"];
  createForegroundMemoryAccessPort?:
    LiveShadowAgentTurnSession["createForegroundMemoryAccessPort"];
  createForegroundMemoryProjectionPort?:
    LiveShadowAgentTurnSession["createForegroundMemoryProjectionPort"];
  sharedAgentExecution?: boolean;
  onDiagnostic?: (
    stage: LiveShadowAgentSessionFailureStage,
    error: unknown,
  ) => void;
  onTerminalFailure?: (
    stage: LiveShadowAgentSessionFailureStage,
    reason: LiveShadowAgentSessionFailureReason,
  ) => void;
  now?: () => number;
}>): LiveShadowAgentTurnSession {
  const states = new WeakMap<object, ReservationState>();
  const ownedStates = new Set<ReservationState>();
  const now = input.now ?? Date.now;
  const representationMode = input.representationMode ?? "shadow_encryption";
  const full = representationMode === "full_encryption";
  const authorizationDeadlineAt =
    input.authorizationDeadlineAt ?? input.plan.deadlineAt;
  let nextOrdinal = 2;
  let currentAssistant: ReservationState | null = null;
  let terminalFailure: ReturnType<typeof unavailable> | null = null;
  let destroyed = false;
  const sharedAgentPlanBytes = input.sharedAgentExecution === true
    ? encodeLiveShadowMessagePlanV4(input.plan)
    : null;

  const fail = (
    stage: LiveShadowAgentSessionFailureStage,
    reason: LiveShadowAgentSessionFailureReason =
      "protected_unavailable",
  ): void => {
    if (terminalFailure !== null) return;
    terminalFailure = unavailable(stage, reason);
    input.onTerminalFailure?.(stage, reason);
  };

  const active = <Value>(): LiveShadowAgentSessionResult<Value> | null => {
    if (destroyed) return unavailable("agent_input", "protected_unavailable");
    if (now() >= authorizationDeadlineAt) {
      fail("agent_input", "deadline_expired");
      return terminalFailure as LiveShadowAgentSessionResult<Value>;
    }
    if (input.authorizationSignal?.aborted === true) {
      fail("agent_input", "protected_unavailable");
      return terminalFailure as LiveShadowAgentSessionResult<Value>;
    }
    return terminalFailure as LiveShadowAgentSessionResult<Value> | null;
  };

  const reserve = async (
    authorRole: "assistant" | "tool",
    createdAt: number,
    assistantMessageKey: string | null,
  ): Promise<LiveShadowAgentSessionResult<ReservationState>> => {
    const inactive = active<ReservationState>();
    if (inactive !== null) return inactive;
    const transcriptOrdinal = nextOrdinal++;
    const reservationDigest = input.crypto.hash(new TextEncoder().encode(
      `${input.plan.operationId}\n${input.plan.sessionId}\n${transcriptOrdinal}\n${authorRole}\n${createdAt}`,
    ));
    const reserved = await input.product.reserveLiveShadowAgent({
      publicationPolicy: {
        expectedRevision: input.plan.policyRevision,
        representation: full ? "protected_only" : "ordinary_and_protected",
      },
      sessionId: input.plan.sessionId,
      operationId: input.plan.operationId,
      transcriptOrdinal,
      authorRole,
      createdAt,
      requestDigest: reservationDigest,
      subthreadReplyClassification:
        authorRole === "assistant" ? "counted" : "excluded",
    });
    if (reserved.status !== "reserved" && reserved.status !== "replayed") {
      reservationDigest.fill(0);
      fail("durable_transcript", "integrity_failure");
      return terminalFailure!;
    }
    const objectDek = input.crypto.randomBytes(32);
    const envelopeBytes = encodeNamespaceObjectEnvelopeV2(
      wrapObjectDekForNamespace(
        input.crypto,
        input.namespace.aiKey,
        {
          objectId: objectId(reserved.allocation.cryptoObjectId),
          namespaceId: namespaceId(input.namespace.namespaceId),
          keyClass: "ai",
          keyGeneration: namespaceGeneration(input.namespace.keyGeneration),
          bindingRevisionAtWrap: accessRevision(
            input.namespace.accessRevision,
          ),
        },
        objectDek,
      ),
    );
    const token = Object.freeze({
      messageId: reserved.allocation.messageId,
      transcriptOrdinal,
      authorRole,
    }) as LiveShadowAgentMessageReservation;
    const state: ReservationState = {
      token,
      allocation: reserved.allocation,
      createdAt,
      reservationDigest,
      objectDek,
      envelopeBytes,
      assistantMessageKey,
      startBytes: null,
      streamStartDigest: null,
      previousFrameHash: ZERO_HASH.slice(),
      nextSequence: 1,
      accumulatedChunks: [],
      accumulatedBytes: 0,
      terminalFrameDigest: null,
      terminalStreamedTextDigest: null,
      terminalPayloadDigest: null,
      nonceKeys: new Set(),
      published: null,
    };
    states.set(token, state);
    ownedStates.add(state);
    if (authorRole === "assistant") currentAssistant = state;
    return Object.freeze({ status: "protected" as const, value: state });
  };

  const publicSession: LiveShadowAgentTurnSession = Object.freeze({
    representationMode,
    authorizationDeadlineAt,
    ...(input.authorizationSignal === undefined
      ? {}
      : { authorizationSignal: input.authorizationSignal }),
    ...(input.checkpoint === undefined
      ? {}
      : { checkpoint: input.checkpoint }),
    sharedAgentRealtimePlanBytes: () =>
      destroyed || sharedAgentPlanBytes === null
        ? null
        : sharedAgentPlanBytes.slice(),
    ...(input.protectForegroundHistory === undefined
      ? {}
      : { protectForegroundHistory: input.protectForegroundHistory }),
    ...(input.protectForegroundJournal === undefined
      ? {}
      : { protectForegroundJournal: input.protectForegroundJournal }),
    ...(input.protectForegroundRecords === undefined
      ? {}
      : { protectForegroundRecords: input.protectForegroundRecords }),
    ...(input.protectForegroundMemories === undefined
      ? {}
      : { protectForegroundMemories: input.protectForegroundMemories }),
    ...(input.createForegroundMemoryRepository === undefined
      ? {}
      : {
        createForegroundMemoryRepository:
          input.createForegroundMemoryRepository,
      }),
    ...(input.createForegroundMemoryAccessPort === undefined
      ? {}
      : { createForegroundMemoryAccessPort: input.createForegroundMemoryAccessPort }),
    ...(input.createForegroundMemoryProjectionPort === undefined
      ? {}
      : { createForegroundMemoryProjectionPort: input.createForegroundMemoryProjectionPort }),
    async reserveAssistantStream(request: Readonly<{
      assistantMessageKey: string;
      createdAt: number;
    }>) {
      const reserved = await reserve(
        "assistant",
        request.createdAt,
        request.assistantMessageKey,
      );
      if (reserved.status !== "protected") return reserved;
      const state = reserved.value;
      const inactive = active<LiveShadowAgentStreamReservation>();
      if (inactive !== null) return inactive;
      try {
        const issuedAt = now();
        if (issuedAt >= authorizationDeadlineAt) {
          fail("agent_input", "deadline_expired");
          return terminalFailure as LiveShadowAgentSessionResult<LiveShadowAgentStreamReservation>;
        }
        const commonStart = {
          operationId: input.plan.operationId,
          policyRevision: input.plan.policyRevision,
          sessionId: input.plan.sessionId,
          roomId: input.plan.roomId,
          messageId: state.allocation.messageId,
          revision: 0,
          createdAt: unixTimestamp(state.createdAt),
          cryptoObjectId: objectId(state.allocation.cryptoObjectId),
          authorAgentId: input.runtime.agentId,
          assistantMessageKey: request.assistantMessageKey,
          transcriptOrdinal: state.token.transcriptOrdinal,
          streamId:
            `live-stream:${input.plan.operationId}:${state.token.transcriptOrdinal}`,
          namespaceId: namespaceId(input.namespace.namespaceId),
          namespaceAccessRevision: input.namespace.accessRevision,
          namespaceKeyGeneration: input.namespace.keyGeneration,
          agentAuthorizationRevision:
            input.plan.agentAuthorizationRevision,
          runtime: input.runtime,
          runtimeSigner: {
            kind: "agent_runtime",
            agentId: input.runtime.agentId,
            runtimeGeneration: input.runtime.generation,
            signerKeyId: input.plan.agentSignerKeyId,
          },
          hostAuthorizationRevision: input.plan.hostAuthorizationRevision,
          namespaceEnvelopeBytes: state.envelopeBytes,
          namespaceEnvelopeDigest: input.crypto.hash(state.envelopeBytes),
          firstChunkSequence: 1,
          issuedAt: unixTimestamp(issuedAt),
          deadlineAt: unixTimestamp(Math.min(
            authorizationDeadlineAt,
            issuedAt + AGENT_LIVE_SHADOW_STREAM_MAX_TTL_MS_V2,
          )),
        } as const;
        const start = prepareDeviceWrappedAgentLiveShadowStreamStart(
          input.crypto,
          {
            ...commonStart,
            namespaceHeadDigest: input.plan.namespaceHeadDigest,
            namespacePublicationDigest:
              input.plan.namespacePublicationDigest,
            namespacePublicationSetDigest:
              input.plan.namespacePublicationSetDigest,
            namespaceAudienceFingerprint:
              input.plan.namespaceAudienceFingerprint,
          },
        );
        state.startBytes = start.bytes.slice();
        state.streamStartDigest = start.startDigest.slice();
        start.start.namespaceHeadDigest.fill(0);
        start.start.namespacePublicationDigest.fill(0);
        start.start.namespacePublicationSetDigest.fill(0);
        start.start.namespaceAudienceFingerprint.fill(0);
        start.start.namespaceEnvelopeBytes.fill(0);
        start.start.namespaceEnvelopeDigest.fill(0);
        start.start.signature.fill(0);
        start.startDigest.fill(0);
        return Object.freeze({
          status: "protected" as const,
          value: Object.freeze({
            reservation: state.token,
            startBytes: state.startBytes.slice(),
          }),
        });
      } catch (error) {
        input.onDiagnostic?.("assistant_stream", error);
        fail("assistant_stream", "integrity_failure");
        return terminalFailure!;
      }
    },

    sealAssistantStreamChunk(request: Readonly<{
      reservation: LiveShadowAgentMessageReservation;
      ordinaryChunk: Uint8Array;
      done: boolean;
      finalPayload?: MessagePayloadV2;
    }>) {
      const inactive = active<LiveShadowAgentStreamFrameResult>();
      if (inactive !== null) return inactive;
      const state = states.get(request.reservation);
      if (
        state === undefined
        || state.token.authorRole !== "assistant"
        || state.startBytes === null
        || state.terminalFrameDigest !== null
        || (request.done && request.finalPayload === undefined)
      ) {
        fail("assistant_stream", "integrity_failure");
        return terminalFailure!;
      }
      const chunk = request.ordinaryChunk.slice();
      const nextTotal = state.accumulatedBytes + chunk.length;
      if (nextTotal > 1024 * 1024) {
        chunk.fill(0);
        fail("assistant_stream", "integrity_failure");
        return terminalFailure!;
      }
      const complete = concat([...state.accumulatedChunks, chunk]);
      const finalPayloadBytes = request.done && request.finalPayload !== undefined
        ? encodeMessagePayloadV2(request.finalPayload)
        : null;
      const streamedTextDigest = request.done
        ? input.crypto.hash(complete)
        : null;
      try {
        const sealInput = {
          startBytes: state.startBytes,
          objectDek: state.objectDek,
          chunkSequence: state.nextSequence,
          previousFrameHash: state.previousFrameHash,
          ordinaryChunk: chunk,
          done: request.done,
          ...(request.done
            ? {
              totalChunkCount: state.nextSequence,
              streamedTextDigest: streamedTextDigest!,
              finalPayloadDigest: input.crypto.hash(finalPayloadBytes!),
            }
            : {}),
          reserveNonce: (nonce: Uint8Array) => {
            const key = base64url(nonce);
            if (state.nonceKeys.has(key)) return false;
            state.nonceKeys.add(key);
            return true;
          },
        } as const;
        const sealed = sealDeviceWrappedAgentLiveShadowStreamFrame(
          input.crypto,
          sealInput,
        );
        const openInput = {
          startBytes: state.startBytes,
          frameBytes: sealed.bytes,
          objectDek: state.objectDek,
          expectedSequence: state.nextSequence,
          expectedPreviousFrameHash: state.previousFrameHash,
          accumulatedPlaintextBytes: state.accumulatedBytes,
        } as const;
        const opened = openDeviceWrappedAgentLiveShadowStreamFrame(
          input.crypto,
          openInput,
        );
        try {
          if (!equal(opened.plaintext, chunk)) {
            fail("assistant_stream", "parity_mismatch");
            return terminalFailure!;
          }
        } finally {
          opened.plaintext.fill(0);
          opened.frameHash.fill(0);
          opened.frame.streamStartDigest.fill(0);
          opened.frame.previousFrameHash.fill(0);
          opened.frame.ordinaryChunk.fill(0);
          opened.frame.nonce.fill(0);
          opened.frame.ciphertext.fill(0);
          opened.frame.tag.fill(0);
          opened.frame.streamedTextDigest?.fill(0);
          opened.frame.finalPayloadDigest?.fill(0);
        }
        state.previousFrameHash.fill(0);
        state.previousFrameHash = sealed.frameHash.slice();
        state.nextSequence += 1;
        state.accumulatedChunks.push(chunk);
        state.accumulatedBytes = nextTotal;
        if (request.done) {
          state.terminalFrameDigest = sealed.frameHash.slice();
          state.terminalStreamedTextDigest = streamedTextDigest!.slice();
          state.terminalPayloadDigest = input.crypto.hash(finalPayloadBytes!);
        }
        sealed.frame.streamStartDigest.fill(0);
        sealed.frame.previousFrameHash.fill(0);
        sealed.frame.ordinaryChunk.fill(0);
        sealed.frame.nonce.fill(0);
        sealed.frame.ciphertext.fill(0);
        sealed.frame.tag.fill(0);
        sealed.frame.streamedTextDigest?.fill(0);
        sealed.frame.finalPayloadDigest?.fill(0);
        sealed.frameHash.fill(0);
        return Object.freeze({
          status: "protected" as const,
          value: Object.freeze({
            frameBytes: sealed.bytes,
            terminal: request.done,
          }),
        });
      } catch (error) {
        input.onDiagnostic?.("assistant_stream", error);
        chunk.fill(0);
        fail("assistant_stream", "integrity_failure");
        return terminalFailure!;
      } finally {
        streamedTextDigest?.fill(0);
        complete.fill(0);
        finalPayloadBytes?.fill(0);
      }
    },

    async publishMessage(request: Readonly<{
      payload: MessagePayloadV2;
      stage: "assistant_message" | "tool_call" | "tool_result";
      reservation?: LiveShadowAgentMessageReservation;
      createdAt?: number;
    }>) {
      const inactive = active<LiveShadowAgentPublishedMessage>();
      if (inactive !== null) return inactive;
      let state = request.reservation === undefined
        ? null
        : states.get(request.reservation) ?? null;
      if (state === null && request.payload.role === "assistant") {
        state = currentAssistant;
      }
      if (state === null) {
        if (request.payload.role !== "assistant" && request.payload.role !== "tool") {
          fail(request.stage, "integrity_failure");
          return terminalFailure!;
        }
        const reserved = await reserve(
          request.payload.role,
          request.createdAt ?? now(),
          null,
        );
        if (reserved.status !== "protected") return reserved;
        state = reserved.value;
      }
      if (state.published !== null) {
        const expected = encodeMessagePayloadV2(request.payload);
        const matches = equal(expected, state.published.ordinaryPayloadBytes);
        expected.fill(0);
        if (!matches) {
          fail(request.stage, "integrity_failure");
          return terminalFailure!;
        }
        return Object.freeze({
          status: "protected" as const,
          value: state.published,
        });
      }
      if (state.token.authorRole !== request.payload.role) {
        fail(request.stage, "integrity_failure");
        return terminalFailure!;
      }
      const ordinaryPayloadBytes = encodeMessagePayloadV2(request.payload);
      if (state.terminalPayloadDigest !== null) {
        const durableDigest = input.crypto.hash(ordinaryPayloadBytes);
        const matchesTerminal = equal(
          durableDigest,
          state.terminalPayloadDigest,
        );
        durableDigest.fill(0);
        if (!matchesTerminal) {
          ordinaryPayloadBytes.fill(0);
          fail(request.stage, "parity_mismatch");
          return terminalFailure!;
        }
      }
      let prepared;
      let ordinaryPersisted = false;
      try {
        const commonPrepared = {
          crypto: input.crypto,
          objectId: state.allocation.cryptoObjectId,
          payload: request.payload,
          createdAt: state.createdAt,
          objectDek: state.objectDek,
          namespaceEnvelopeBytes: state.envelopeBytes,
          namespace: input.namespace,
          grant: {
            grantId: input.grantId,
            grantHash: input.grantDigest,
            useStatus: "reusable",
          },
          runtime: input.runtime,
          agentAuthorizationRevision:
            input.plan.agentAuthorizationRevision,
          signerKeyId: input.plan.agentSignerKeyId,
          signerPublicKey: input.plan.agentSignerPublicKey,
        } as const;
        prepared = prepareDeviceWrappedLiveShadowAgentConversationCryptoRevisionWithDek({
              ...commonPrepared,
              operationId: input.plan.operationId,
              grant: {
                grantId: input.grantId,
                grantHash: input.grantDigest,
                recipientKeyId: input.recipientKeyId!,
              },
              namespace: {
                namespaceId: input.namespace.namespaceId,
                accessRevision: input.namespace.accessRevision,
                keyGeneration: input.namespace.keyGeneration,
                headDigest: input.plan.namespaceHeadDigest,
                publicationDigest: input.plan.namespacePublicationDigest,
                publicationSetDigest:
                  input.plan.namespacePublicationSetDigest,
                audienceFingerprint:
                  input.plan.namespaceAudienceFingerprint,
                aiKey: input.namespace.aiKey,
              },
              resolveCurrentAuthorization:
                input.resolveCurrentDeviceWrappedAgentObjectAuthorization,
            });
        const snapshot = readPreparedConversationCryptoRevisionSnapshot(
          prepared,
        );
        if (
          snapshot.kind !== "agent-v3-device-wrapped-live-shadow"
        ) {
          throw new TypeError("Live Shadow Agent revision kind is invalid");
        }
        const encrypted = decodeEncryptedPayloadV2(
          snapshot.value.object.payloadBytes.ciphertext,
        );
        const opened = decryptObjectPayload(
          input.crypto,
          state.objectDek,
          encrypted,
        );
        encrypted.ciphertext.fill(0);
        if (opened === null || !equal(opened, ordinaryPayloadBytes)) {
          opened?.fill(0);
          fail(request.stage, "parity_mismatch");
          return terminalFailure!;
        }
        const openedPayload = decodeMessagePayloadV2(opened);
        opened.fill(0);
        const published = await input.product.publishReservedLiveShadowAgent({
          sessionId: input.plan.sessionId,
          idempotencyKey:
            `live-agent:${input.plan.operationId}:${state.token.transcriptOrdinal}`,
          content: full ? null : request.payload.content,
          publicationPolicy: {
            expectedRevision: input.plan.policyRevision,
            representation: full ? "protected_only" : "ordinary_and_protected",
          },
          keyClass: "ai",
          authorRole: state.token.authorRole,
          toolCalls: full || request.payload.toolCalls === undefined
            ? null
            : JSON.stringify(request.payload.toolCalls),
          toolName: full ? null : request.payload.toolName ?? null,
          fingerprint:
            `live-agent:${input.plan.operationId}:${state.token.transcriptOrdinal}`,
          humanTurnId: null,
          transcriptOrigin: "main",
          parentThreadId: null,
          scopeId: null,
          metadata: null,
          subthreadRoomId: null,
          replyToMessageId: null,
          notificationContext: {
            mentionedHumanUserIds: [],
            // Product user identity is resolved independently from current
            // product + device authority; it is never inferred from the
            // cryptographic Human actor coordinate.
            causalHumanUserId: input.causalHumanUserId,
            causalHumanTurnId:
              input.causalHumanTurnId ?? input.plan.operationId,
          },
          structuralProjection: {
            notificationEligibility:
              state.token.authorRole === "assistant" ? "eligible" : "excluded",
            subthreadReplyClassification:
              state.token.authorRole === "assistant" ? "counted" : "excluded",
          },
          operationId: input.plan.operationId,
          transcriptOrdinal: state.token.transcriptOrdinal,
          reservedMessageId: state.allocation.messageId,
          reservedCreatedAt: state.createdAt,
          cryptoObjectId: state.allocation.cryptoObjectId,
          reservationDigest: state.reservationDigest,
        });
        if (published.status === "conflict") {
          fail("durable_transcript", "integrity_failure");
          return terminalFailure!;
        }
        ordinaryPersisted = !full;
        const completed = await input.conversation.completeRevision({
          messageId: state.allocation.messageId,
          expectedRevision: 0,
          parityStatus: full ? "server_authenticated" : "server_verified",
          prepared,
        });
        if (completed.status === "orphaned") {
          fail("durable_transcript", "integrity_failure");
          return full ? terminalFailure! : withOrdinaryPublication(terminalFailure!, {
            reservation: state.token,
            createdAt: new Date(state.createdAt).toISOString(),
            payload: request.payload,
            assistantMessageKey: state.assistantMessageKey,
          });
        }
        const value = snapshot.value;
        const dto = parseProtectedMessageDtoV2({
          dtoVersion: 2,
          projection: {
            messageId: String(state.allocation.messageId),
            sessionId: input.plan.sessionId,
            roomId: input.plan.roomId,
            namespaceId: input.plan.namespaceId,
            role: state.token.authorRole,
            createdAt: new Date(state.createdAt).toISOString(),
            editRevision: 0,
            authorAgentId: input.plan.recipientAgentId,
          },
          protectedPayload: {
            status: "encrypted",
            cryptoObjectId: state.allocation.cryptoObjectId,
            payloadVersion: 2,
            keyClass: "ai",
            encryptedPayloadBytesBase64url: base64url(
              value.object.payloadBytes.ciphertext,
            ),
            accessManifestBytesBase64url: base64url(
              value.access.manifestBytes,
            ),
            namespaceEnvelopeBytesBase64url: base64url(
              value.access.envelopeBytes[0],
            ),
          },
        });
        const digestInput = {
          operationId: input.plan.operationId,
          policyRevision: input.plan.policyRevision,
          transcriptOrdinal: state.token.transcriptOrdinal,
          protectedMessage: dto,
        };
        const durableEventDigest = full ? fullEncryptionDurableEventDigestV2(
          input.crypto, digestInput,
        ) : liveShadowDurableEventDigestV1(
          input.crypto,
          {
            ...digestInput,
            ordinaryPayloadBytes,
          },
        );
        const streamEvidence = state.startBytes === null
          ? null
          : state.streamStartDigest !== null
              && state.terminalFrameDigest !== null
              && state.terminalStreamedTextDigest !== null
            ? Object.freeze({
              streamId:
                `live-stream:${input.plan.operationId}:${state.token.transcriptOrdinal}`,
              startDigest: state.streamStartDigest.slice(),
              terminalDigest: state.terminalFrameDigest.slice(),
              streamedTextDigest: state.terminalStreamedTextDigest.slice(),
            })
            : undefined;
        if (streamEvidence === undefined) {
          durableEventDigest.fill(0);
          fail("durable_transcript", "integrity_failure");
          return full ? terminalFailure! : withOrdinaryPublication(terminalFailure!, {
            reservation: state.token,
            createdAt: new Date(state.createdAt).toISOString(),
            payload: request.payload,
            assistantMessageKey: state.assistantMessageKey,
          });
        }
        const evidence = await input.product.recordLiveShadowAgentEvidence({
          publicationPolicy: {
            expectedRevision: input.plan.policyRevision,
            representation: full ? "protected_only" : "ordinary_and_protected",
          },
          sessionId: input.plan.sessionId,
          operationId: input.plan.operationId,
          messageId: state.allocation.messageId,
          transcriptOrdinal: state.token.transcriptOrdinal,
          durableEventDigest,
          streamEvidence,
          finalTurnMessage: request.payload.role === "assistant"
            && (request.payload.toolCalls?.length ?? 0) === 0,
          now: now(),
        });
        if (evidence === "conflict") {
          durableEventDigest.fill(0);
          streamEvidence?.startDigest.fill(0);
          streamEvidence?.terminalDigest.fill(0);
          streamEvidence?.streamedTextDigest.fill(0);
          fail("durable_transcript", "integrity_failure");
          return full ? terminalFailure! : withOrdinaryPublication(terminalFailure!, {
            reservation: state.token,
            createdAt: new Date(state.createdAt).toISOString(),
            payload: request.payload,
            assistantMessageKey: state.assistantMessageKey,
          });
        }
        state.published = Object.freeze({
          representationMode,
          reservation: state.token,
          policyRevision: input.plan.policyRevision,
          ordinaryPayloadBytes: ordinaryPayloadBytes.slice(),
          openedPayload,
          protectedMessage: dto,
          durableEventDigest,
          streamEvidence,
        });
        if (currentAssistant === state) currentAssistant = null;
        return Object.freeze({
          status: "protected" as const,
          value: state.published,
        });
      } catch (error) {
        input.onDiagnostic?.(request.stage, error);
        fail(request.stage, "protected_unavailable");
        return ordinaryPersisted
          ? withOrdinaryPublication(terminalFailure!, {
            reservation: state.token,
            createdAt: new Date(state.createdAt).toISOString(),
            payload: request.payload,
            assistantMessageKey: state.assistantMessageKey,
          })
          : terminalFailure!;
      } finally {
        ordinaryPayloadBytes.fill(0);
      }
    },

    fail,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      sharedAgentPlanBytes?.fill(0);
      for (const state of ownedStates) {
        state.reservationDigest.fill(0);
        state.objectDek.fill(0);
        state.envelopeBytes.fill(0);
        state.startBytes?.fill(0);
        state.streamStartDigest?.fill(0);
        state.previousFrameHash.fill(0);
        state.accumulatedChunks.forEach((chunk) => chunk.fill(0));
        state.terminalFrameDigest?.fill(0);
        state.terminalStreamedTextDigest?.fill(0);
        state.terminalPayloadDigest?.fill(0);
        state.nonceKeys.clear();
        state.published?.ordinaryPayloadBytes.fill(0);
        state.published?.durableEventDigest.fill(0);
        state.published?.streamEvidence?.startDigest.fill(0);
        state.published?.streamEvidence?.terminalDigest.fill(0);
        state.published?.streamEvidence?.streamedTextDigest.fill(0);
      }
      ownedStates.clear();
      input.namespace.headDigest?.fill(0);
      input.namespace.publicationDigest?.fill(0);
      input.namespace.publicationSetDigest?.fill(0);
      input.namespace.audienceFingerprint?.fill(0);
      input.namespace.aiKey.fill(0);
      input.runtime.key.fill(0);
      input.grantDigest.fill(0);
    },
  });
  return publicSession;
}
