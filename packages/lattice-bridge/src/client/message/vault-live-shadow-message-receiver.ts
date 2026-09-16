import {
  decryptObjectThroughNamespace,
  accessRevision,
  authorizationRevision,
  cryptoDeviceId,
  humanId,
  objectId,
  namespaceGeneration,
  namespaceId,
  openDeviceWrappedAgentLiveShadowStreamFrame,
  openObjectDekForNamespace,
  prepareHumanLiveShadowClientVerification,
  unixTimestamp,
  verifyDeviceWrappedAgentLiveShadowStreamStart,
  type NamespaceAgentGrantAuthorityEntry,
  verifyAgentObjectAccessManifest,
  type HumanLiveShadowStreamTerminalVerificationEntry,
  type HumanLiveShadowTranscriptVerificationEntry,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import {
  decodeAgentLiveShadowStreamStartV2,
  decodeEncryptedPayloadV2,
  decodeLiveShadowMessagePlanV4,
  decodeNamespaceObjectEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";
import {
  encodeProtectedMessageDtoV2,
  parseFullEncryptionMessageRealtimeContentEventV2,
  parseLiveShadowMessageRealtimeEventV1,
  type FullEncryptionMessageRealtimeContentEventV2,
  type ProtectedMessageDtoV2,
  type LiveShadowMessageRealtimeEventV1,
} from "@nautilo/types";

import {
  authenticateClientDeviceProfileV4,
  destroyOpenedClientDeviceProfileV4,
} from "../../client-vault/profile-v4.ts";
import type {
  ClientProfileCoordinates,
  ClientProfileVault,
} from "../../client-vault/types.ts";
import {
  decodeMessagePayloadV2,
  type MessagePayloadV2,
} from "../../message/message-payload-v2.ts";
import { deriveLiveShadowMessageCryptoObjectIdV1 } from
  "../../message/conversation-repository.ts";
import {
  fullEncryptionDurableEventDigestV2,
  liveShadowDurableEventDigestV1,
} from
  "../../message/live-shadow-realtime-evidence.ts";
import type { NamespaceAuthorityClient } from
  "./namespace-authority-client.ts";

const ZERO_HASH = new Uint8Array(32);
type ForegroundRealtimeEvent =
  | Extract<LiveShadowMessageRealtimeEventV1, { type:
      | "message.shadow_stream_start"
      | "message.shadow_stream_frame"
      | "message.shadow_durable" }>
  | Extract<FullEncryptionMessageRealtimeContentEventV2, { type:
      | "message.shadow_stream_start"
      | "message.shadow_stream_frame"
      | "message.shadow_durable" }>;

type StreamState = {
  readonly operationId: string;
  readonly policyRevision: number;
  readonly transcriptOrdinal: number;
  readonly sessionId: string;
  readonly roomId: string;
  readonly messageId: number;
  readonly revision: number;
  readonly createdAt: number;
  readonly cryptoObjectId: string;
  readonly namespaceId: string;
  readonly authorAgentId: string;
  readonly assistantMessageKey: string;
  readonly streamId: string;
  readonly startBytes: Uint8Array;
  readonly startDigest: Uint8Array;
  readonly objectDek: Uint8Array;
  previousFrameHash: Uint8Array;
  nextSequence: number;
  accumulatedBytes: number;
  readonly chunks: Uint8Array[];
  terminalFrameDigest: Uint8Array | null;
  streamedTextDigest: Uint8Array | null;
  finalPayloadDigest: Uint8Array | null;
};

type AgentAckEvidence = Readonly<{
  transcript: HumanLiveShadowTranscriptVerificationEntry;
  streamTerminal: HumanLiveShadowStreamTerminalVerificationEntry | null;
  finalTurnMessage: boolean;
}>;

type TurnState = {
  readonly operationId: string;
  readonly policyRevision: number;
  readonly sessionId: string;
  readonly roomId: string;
  readonly subjectHumanId: string;
  readonly committerDeviceId: string;
  readonly hostAuthorizationRevision: number;
  readonly recipientAgentId: string;
  readonly agentAuthorizationRevision: number;
  readonly agentRuntimeGeneration: number;
  readonly agentSignerKeyId: string;
  readonly agentSignerPublicKey: Uint8Array;
  readonly namespaceKeyAuthority: Readonly<{
    deviceSigningKeyGeneration: number;
    namespaceId: string;
    accessRevision: number;
    generation: number;
    headDigest: Uint8Array;
    publicationDigest: Uint8Array;
    publicationSetDigest: Uint8Array;
    audienceFingerprint: Uint8Array;
  }>;
  readonly transcript: HumanLiveShadowTranscriptVerificationEntry[];
  readonly streamTerminals: HumanLiveShadowStreamTerminalVerificationEntry[];
  readonly recoveringDurableOnly: boolean;
  finalSeen: boolean;
  submitting: boolean;
};

type TurnFailure = Readonly<{
  stage: "assistant_stream" | "browser_open";
  reason: "integrity_failure" | "parity_mismatch" | "stream_incomplete";
}>;

type FallbackStreamState = {
  readonly messageId: number;
  readonly assistantMessageKey: string;
  readonly authorAgentId: string;
  nextSequence: number;
};

export type VaultLiveShadowReceiveResult =
  | Readonly<{ status: "start_verified" }>
  | Readonly<{
      status: "frame_verified";
      ordinaryChunk: string;
      done: boolean;
      chunkSequence: number;
      messageId: number;
      assistantMessageKey: string;
      authorAgentId: string;
    }>
  | Readonly<{
      status: "durable_verified";
      payload: MessagePayloadV2;
      messageId: string;
      assistantMessageKey: string | null;
      authorAgentId: string;
    }>
  | Readonly<{
      status: "failed";
      reason: "unavailable" | "integrity";
      checkpoint?: VaultLiveShadowFailureCheckpoint;
      ordinaryFallback?: VaultLiveShadowOrdinaryFallback;
    }>;

export type VaultLiveShadowFailureCheckpoint =
  | "stream_start_precondition"
  | "stream_start_decode"
  | "stream_start_turn"
  | "stream_start_keyring"
  | "stream_start_verify"
  | "stream_frame_without_start"
  | "stream_frame_without_verified_start"
  | "stream_frame_parity"
  | "stream_frame_open";

export type VaultLiveShadowOrdinaryFallback =
  | Readonly<{
      kind: "frame";
      ordinaryChunk: string;
      done: boolean;
      chunkSequence: number;
      messageId: number;
      assistantMessageKey: string;
      authorAgentId: string;
    }>
  | Readonly<{
      kind: "durable";
      payload: MessagePayloadV2;
      messageId: string;
      assistantMessageKey: string | null;
      authorAgentId: string;
    }>;

export interface VaultLiveShadowMessageReceiver {
  registerHuman(input: Readonly<{
    operationId: string;
    planBytes: Uint8Array;
    ordinaryPayloadBytes: Uint8Array;
    protectedMessage: ProtectedMessageDtoV2;
    recovery?: true;
  }>): Promise<void>;
  receive(event: unknown): Promise<VaultLiveShadowReceiveResult>;
  destroy(): void;
}

export type VaultLiveShadowVerificationRetryDiagnostic = Readonly<{
  operationId: string;
  attempt: number;
  willRetry: boolean;
}>;

function bytes(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/")
    + "=".repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(
    atob(padded),
    (character) => character.charCodeAt(0),
  );
}

function base64url(value: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < value.length; offset += 0x8000) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function streamKey(operationId: string, ordinal: number): string {
  return `${operationId}\u0000${String(ordinal)}`;
}

function currentNamespaceKeyAuthority(
  turn: TurnState,
): readonly NamespaceAgentGrantAuthorityEntry[] {
  const current = turn.namespaceKeyAuthority;
  return Object.freeze([Object.freeze({
    namespaceId: namespaceId(current.namespaceId),
    keyClass: "ai" as const,
    firstRetainedGeneration: namespaceGeneration(current.generation),
    currentGeneration: namespaceGeneration(current.generation),
    retainedGenerations: Object.freeze([Object.freeze({
      generation: namespaceGeneration(current.generation),
      accessRevision: accessRevision(current.accessRevision),
      headDigest: current.headDigest.slice(),
      publicationDigest: current.publicationDigest.slice(),
      publicationSetDigest: current.publicationSetDigest.slice(),
      audienceFingerprint: current.audienceFingerprint.slice(),
    })]),
    agentAuthorizationRevision: authorizationRevision(
      turn.agentAuthorizationRevision,
    ),
  })]);
}

function destroyNamespaceKeyAuthority(
  authority: readonly NamespaceAgentGrantAuthorityEntry[],
): void {
  authority.forEach((entry) => entry.retainedGenerations.forEach((retained) => {
    retained.headDigest.fill(0);
    retained.publicationDigest.fill(0);
    retained.publicationSetDigest.fill(0);
    retained.audienceFingerprint.fill(0);
  }));
}

/** Browser-vault receiver for causal live stream and durable dual siblings. */
export function createVaultLiveShadowMessageReceiver(input: Readonly<{
  crypto: LatticeCrypto;
  vault: ClientProfileVault;
  coordinates: ClientProfileCoordinates;
  namespaceAuthority?: NamespaceAuthorityClient;
  submitVerification: (input: Readonly<{
    roomId: string;
    operationId: string;
    verificationBytesBase64url: string;
  }>) => Promise<"verified" | "replayed">;
  onTerminalVerification?: (operationId: string) => Promise<void> | void;
  onVerificationAttemptFailed?: (
    diagnostic: VaultLiveShadowVerificationRetryDiagnostic,
  ) => void;
  verificationRetryDelay?: (attempt: number) => Promise<void>;
  now?: () => number;
}>): VaultLiveShadowMessageReceiver {
  const streams = new Map<string, StreamState>();
  const fallbackStreams = new Map<string, FallbackStreamState>();
  const failed = new Set<string>();
  const terminalOperations = new Set<string>();
  const turns = new Map<string, TurnState>();
  const pendingEvidence = new Map<string, AgentAckEvidence[]>();
  const pendingFailures = new Map<string, TurnFailure>();
  const now = input.now ?? Date.now;
  const verificationRetryDelay = input.verificationRetryDelay
    ?? ((attempt: number) => new Promise<void>((resolve) => {
      setTimeout(resolve, attempt === 1 ? 100 : 500);
    }));
  let destroyed = false;

  const releaseStream = (key: string): void => {
    const state = streams.get(key);
    if (state === undefined) return;
    state.startBytes.fill(0);
    state.startDigest.fill(0);
    state.objectDek.fill(0);
    state.previousFrameHash.fill(0);
    state.chunks.forEach((chunk) => chunk.fill(0));
    state.terminalFrameDigest?.fill(0);
    state.streamedTextDigest?.fill(0);
    state.finalPayloadDigest?.fill(0);
    streams.delete(key);
  };

  const withProfile = async <Value>(
    operation: Parameters<ClientProfileVault["withOpenProfile"]>[1],
  ): Promise<Value> => {
    const availability = await input.vault.availability();
    if (
      availability.status !== "available"
      && (await input.vault.unlock()).status !== "available"
    ) throw new Error("Live Shadow Browser profile is unavailable");
    return input.vault.withOpenProfile(
      input.coordinates,
      operation,
    ) as Promise<Value>;
  };

  const destroyTranscript = (
    entry: HumanLiveShadowTranscriptVerificationEntry,
  ): void => {
    entry.ordinaryPayloadDigest.fill(0);
    entry.protectedDtoDigest.fill(0);
  };
  const destroyTerminal = (
    entry: HumanLiveShadowStreamTerminalVerificationEntry,
  ): void => {
    entry.streamStartDigest.fill(0);
    entry.terminalFrameDigest.fill(0);
    entry.streamedTextDigest.fill(0);
    entry.finalPayloadDigest.fill(0);
  };
  const destroyEvidence = (evidence: AgentAckEvidence): void => {
    destroyTranscript(evidence.transcript);
    if (evidence.streamTerminal !== null) {
      destroyTerminal(evidence.streamTerminal);
    }
  };
  const destroyTurn = (turn: TurnState): void => {
    turn.agentSignerPublicKey.fill(0);
    turn.namespaceKeyAuthority.headDigest.fill(0);
    turn.namespaceKeyAuthority.publicationDigest.fill(0);
    turn.namespaceKeyAuthority.publicationSetDigest.fill(0);
    turn.namespaceKeyAuthority.audienceFingerprint.fill(0);
    turn.transcript.forEach(destroyTranscript);
    turn.streamTerminals.forEach(destroyTerminal);
  };

  const markTerminalOperation = (operationId: string): void => {
    if (terminalOperations.size >= 128 && !terminalOperations.has(operationId)) {
      const oldest = terminalOperations.values().next().value;
      if (oldest !== undefined) terminalOperations.delete(oldest);
    }
    terminalOperations.add(operationId);
  };

  const retainPendingFailure = (
    operationId: string,
    failure: TurnFailure,
  ): void => {
    if (pendingFailures.size >= 128 && !pendingFailures.has(operationId)) {
      const oldestOperationId = pendingFailures.keys().next().value;
      if (oldestOperationId !== undefined) {
        pendingFailures.delete(oldestOperationId);
        const oldestTurn = turns.get(oldestOperationId);
        if (oldestTurn !== undefined) {
          turns.delete(oldestOperationId);
          destroyTurn(oldestTurn);
        }
      }
    }
    pendingFailures.set(operationId, failure);
  };

  const submitFailedTurn = async (
    turn: TurnState,
    failure: TurnFailure,
  ): Promise<void> => {
    if (turn.submitting || destroyed) return;
    turn.submitting = true;
    try {
      await withProfile(async (profileBytes: Uint8Array) => {
        const profile = await authenticateClientDeviceProfileV4({
          crypto: input.crypto,
          profileBytes,
          expectedDeviceId: input.coordinates.deviceId,
        });
        try {
          const base = profile.baseProfile.baseProfile;
          if (
            base.deviceId !== turn.committerDeviceId
            || base.trustedHostAuthorizationRevision
              !== turn.hostAuthorizationRevision
          ) {
            throw new TypeError(
              "Live Shadow Browser failure authority changed",
            );
          }
          const issuedAt = unixTimestamp(now());
          const created = prepareHumanLiveShadowClientVerification(
            input.crypto,
            {
              subjectHumanId: humanId(turn.subjectHumanId),
              operationId: turn.operationId,
              policyRevision: turn.policyRevision,
              sessionId: turn.sessionId,
              roomId: turn.roomId,
              status: "failed",
              transcript: turn.transcript,
              streamTerminals: turn.streamTerminals,
              closedStage: failure.stage,
              reason: failure.reason,
              issuedAt,
              deadlineAt: unixTimestamp(Number(issuedAt) + 30_000),
              committerDeviceId: cryptoDeviceId(turn.committerDeviceId),
              hostAuthorizationRevision: authorizationRevision(
                turn.hostAuthorizationRevision,
              ),
              committerSigningPublicKey: base.signingPublicKey,
              committerSigningPrivateKey: base.signingPrivateKey,
            },
          );
          try {
            const status = await input.submitVerification({
              roomId: turn.roomId,
              operationId: turn.operationId,
              verificationBytesBase64url: base64url(created.bytes),
            });
            if (status !== "verified" && status !== "replayed") {
              throw new TypeError(
                "Live Shadow failure verification receipt is invalid",
              );
            }
          } finally {
            created.bytes.fill(0);
            created.verificationDigest.fill(0);
            created.verification.transcript.forEach(destroyTranscript);
            created.verification.streamTerminals.forEach(destroyTerminal);
            created.verification.signature.fill(0);
          }
        } finally {
          destroyOpenedClientDeviceProfileV4(profile);
        }
      });
      turns.delete(turn.operationId);
      pendingFailures.delete(turn.operationId);
      markTerminalOperation(turn.operationId);
      destroyTurn(turn);
      if (!turn.recoveringDurableOnly) {
        await input.onTerminalVerification?.(turn.operationId);
      }
    } catch {
      turn.submitting = false;
      retainPendingFailure(turn.operationId, failure);
    }
  };

  const fail = (
    key: string,
    ordinaryFallback?: VaultLiveShadowOrdinaryFallback,
    stage: "assistant_stream" | "browser_open" = "browser_open",
    reason:
      | "integrity_failure"
      | "parity_mismatch"
      | "stream_incomplete" = "integrity_failure",
    checkpoint?: VaultLiveShadowFailureCheckpoint,
  ): VaultLiveShadowReceiveResult => {
    if (failed.size >= 256 && !failed.has(key)) {
      const oldest = failed.values().next().value;
      if (oldest !== undefined) failed.delete(oldest);
    }
    failed.add(key);
    releaseStream(key);
    const operationId = key.split("\u0000", 1)[0]!;
    const failure = Object.freeze({ stage, reason });
    if (!destroyed && !terminalOperations.has(operationId)) {
      retainPendingFailure(operationId, failure);
    }
    return Object.freeze({
      status: "failed" as const,
      reason: "integrity" as const,
      ...(checkpoint === undefined ? {} : { checkpoint }),
      ...(ordinaryFallback === undefined ? {} : { ordinaryFallback }),
    });
  };

  const flushPendingFailure = async (operationId: string): Promise<void> => {
    const failure = pendingFailures.get(operationId);
    const turn = turns.get(operationId);
    if (failure !== undefined && turn !== undefined) {
      await submitFailedTurn(turn, failure);
    }
  };

  const appendEvidence = (turn: TurnState, evidence: AgentAckEvidence): void => {
    const previous = turn.transcript.at(-1)?.transcriptOrdinal ?? 0;
    if (
      evidence.transcript.transcriptOrdinal !== previous + 1
      || turn.transcript.length >= 256
      || turn.streamTerminals.length >= 256
    ) {
      destroyEvidence(evidence);
      throw new TypeError("Live Shadow Browser transcript order disagrees");
    }
    turn.transcript.push(evidence.transcript);
    if (evidence.streamTerminal !== null) {
      turn.streamTerminals.push(evidence.streamTerminal);
    }
    turn.finalSeen ||= evidence.finalTurnMessage;
  };

  const submitTurn = async (turn: TurnState): Promise<void> => {
    if (!turn.finalSeen || turn.submitting || destroyed) return;
    if (turn.recoveringDurableOnly && turn.streamTerminals.length === 0) {
      await submitFailedTurn(turn, Object.freeze({
        stage: "assistant_stream" as const,
        reason: "stream_incomplete" as const,
      }));
      return;
    }
    turn.submitting = true;
    let verificationBytes: Uint8Array | null = null;
    try {
      verificationBytes = await withProfile(async (profileBytes: Uint8Array) => {
        const profile = await authenticateClientDeviceProfileV4({
          crypto: input.crypto,
          profileBytes,
          expectedDeviceId: input.coordinates.deviceId,
        });
        try {
          const base = profile.baseProfile.baseProfile;
          if (
            base.deviceId !== turn.committerDeviceId
            || base.trustedHostAuthorizationRevision
              !== turn.hostAuthorizationRevision
          ) throw new TypeError("Live Shadow Browser verification authority changed");
          const issuedAt = unixTimestamp(now());
          const created = prepareHumanLiveShadowClientVerification(
            input.crypto,
            {
              subjectHumanId: humanId(turn.subjectHumanId),
              operationId: turn.operationId,
              policyRevision: turn.policyRevision,
              sessionId: turn.sessionId,
              roomId: turn.roomId,
              status: "matched",
              transcript: turn.transcript,
              streamTerminals: turn.streamTerminals,
              closedStage: "browser_open",
              reason: "none",
              issuedAt,
              deadlineAt: unixTimestamp(Number(issuedAt) + 30_000),
              committerDeviceId: cryptoDeviceId(turn.committerDeviceId),
              hostAuthorizationRevision: authorizationRevision(
                turn.hostAuthorizationRevision,
              ),
              committerSigningPublicKey: base.signingPublicKey,
              committerSigningPrivateKey: base.signingPrivateKey,
            },
          );
          try {
            return created.bytes.slice();
          } finally {
            created.bytes.fill(0);
            created.verificationDigest.fill(0);
            created.verification.transcript.forEach(destroyTranscript);
            created.verification.streamTerminals.forEach(destroyTerminal);
            created.verification.signature.fill(0);
          }
        } finally {
          destroyOpenedClientDeviceProfileV4(profile);
        }
      });
      const bytesForSubmission = verificationBytes;
      if (bytesForSubmission === null) {
        throw new TypeError("Live Shadow verification bytes are unavailable");
      }
      let accepted = false;
      for (let attempt = 1; attempt <= 3 && !destroyed; attempt += 1) {
        try {
          const status = await input.submitVerification({
            roomId: turn.roomId,
            operationId: turn.operationId,
            verificationBytesBase64url: base64url(bytesForSubmission),
          });
          if (status !== "verified" && status !== "replayed") {
            throw new TypeError("Live Shadow verification receipt is invalid");
          }
          accepted = true;
          break;
        } catch {
          const willRetry = attempt < 3 && !destroyed;
          input.onVerificationAttemptFailed?.({
            operationId: turn.operationId,
            attempt,
            willRetry,
          });
          if (willRetry) await verificationRetryDelay(attempt);
        }
      }
      if (!accepted) throw new TypeError("Live Shadow verification was not accepted");
      turns.delete(turn.operationId);
      markTerminalOperation(turn.operationId);
      destroyTurn(turn);
      if (!turn.recoveringDurableOnly) {
        await input.onTerminalVerification?.(turn.operationId);
      }
    } catch {
      // Keep only content-free digest evidence for a bounded retry opportunity.
      // Server reconciliation will classify a permanently lost acknowledgment.
      turn.submitting = false;
    } finally {
      verificationBytes?.fill(0);
    }
  };

  const registerHuman = async (registered: Readonly<{
    operationId: string;
    planBytes: Uint8Array;
    ordinaryPayloadBytes: Uint8Array;
    protectedMessage: ProtectedMessageDtoV2;
    recovery?: true;
  }>): Promise<void> => {
    let planV4: ReturnType<typeof decodeLiveShadowMessagePlanV4> | null = null;
    try {
      planV4 = decodeLiveShadowMessagePlanV4(registered.planBytes);
      const plan = planV4;
      const payload = registered.protectedMessage.protectedPayload;
      const expectedObjectId = deriveLiveShadowMessageCryptoObjectIdV1({
        operationId: plan.operationId,
        sessionId: plan.sessionId,
        messageId: plan.humanMessageId,
        revision: 0,
        transcriptOrdinal: 1,
        authorRole: "user",
      });
      const projection = registered.protectedMessage.projection;
      if (
        plan.operationId !== registered.operationId
        || payload.status !== "encrypted"
        || payload.cryptoObjectId !== expectedObjectId
        || projection.messageId !== String(plan.humanMessageId)
        || projection.sessionId !== plan.sessionId
        || projection.roomId !== plan.roomId
        || projection.namespaceId !== plan.namespaceId
        || projection.role !== "user"
        || projection.editRevision !== 0
        || Date.parse(projection.createdAt) !== plan.createdAt
      ) throw new TypeError("Live Shadow Human receipt disagrees with its plan");
      const dtoBytes = new TextEncoder().encode(
        encodeProtectedMessageDtoV2(registered.protectedMessage),
      );
      const transcript = Object.freeze({
        transcriptOrdinal: 1,
        messageId: plan.humanMessageId,
        revision: 0 as const,
        authorRole: "human" as const,
        cryptoObjectId: objectId(expectedObjectId),
        ordinaryPayloadDigest: input.crypto.hash(
          registered.ordinaryPayloadBytes,
        ),
        protectedDtoDigest: input.crypto.hash(dtoBytes),
      });
      dtoBytes.fill(0);
      const existing = turns.get(plan.operationId);
      if (existing !== undefined) {
        destroyTranscript(transcript);
        const pendingFailure = pendingFailures.get(plan.operationId);
        if (pendingFailure === undefined) await submitTurn(existing);
        else await submitFailedTurn(existing, pendingFailure);
        return;
      }
      if (terminalOperations.has(plan.operationId)) {
        destroyTranscript(transcript);
        return;
      }
      if (turns.size >= 128) {
        const oldest = turns.entries().next().value;
        if (oldest !== undefined) {
          turns.delete(oldest[0]);
          destroyTurn(oldest[1]);
        }
      }
      const turn: TurnState = {
        operationId: plan.operationId,
        policyRevision: plan.policyRevision,
        sessionId: plan.sessionId,
        roomId: plan.roomId,
        subjectHumanId: plan.subjectHumanId,
        committerDeviceId: plan.committerDeviceId,
        hostAuthorizationRevision: plan.hostAuthorizationRevision,
        recipientAgentId: plan.recipientAgentId,
        agentAuthorizationRevision: plan.agentAuthorizationRevision,
        agentRuntimeGeneration: plan.agentRuntimeGeneration,
        agentSignerKeyId: plan.agentSignerKeyId,
        agentSignerPublicKey: plan.agentSignerPublicKey.slice(),
        namespaceKeyAuthority: Object.freeze({
          deviceSigningKeyGeneration:
            plan.committerDeviceSigningKeyGeneration,
          namespaceId: plan.namespaceId,
          accessRevision: plan.namespaceAccessRevision,
          generation: plan.namespaceKeyGeneration,
          headDigest: plan.namespaceHeadDigest.slice(),
          publicationDigest: plan.namespacePublicationDigest.slice(),
          publicationSetDigest:
            plan.namespacePublicationSetDigest.slice(),
          audienceFingerprint:
            plan.namespaceAudienceFingerprint.slice(),
        }),
        transcript: [transcript],
        streamTerminals: [],
        recoveringDurableOnly: registered.recovery === true,
        finalSeen: false,
        submitting: false,
      };
      turns.set(plan.operationId, turn);
      const pending = pendingEvidence.get(plan.operationId) ?? [];
      pendingEvidence.delete(plan.operationId);
      for (let index = 0; index < pending.length; index += 1) {
        try {
          appendEvidence(turn, pending[index]!);
        } catch (cause) {
          for (let remainder = index + 1; remainder < pending.length; remainder += 1) {
            destroyEvidence(pending[remainder]!);
          }
          throw cause;
        }
      }
      const pendingFailure = pendingFailures.get(plan.operationId);
      if (pendingFailure === undefined) await submitTurn(turn);
      else await submitFailedTurn(turn, pendingFailure);
    } finally {
      registered.planBytes.fill(0);
      registered.ordinaryPayloadBytes.fill(0);
      if (planV4 !== null) {
        planV4.agentSignerPublicKey.fill(0);
        planV4.namespaceHeadDigest.fill(0);
        planV4.namespacePublicationDigest.fill(0);
        planV4.namespacePublicationSetDigest.fill(0);
        planV4.namespaceAudienceFingerprint.fill(0);
        planV4.grantDomainParticipantDigest.fill(0);
        planV4.grantDomainHeadDigest.fill(0);
        planV4.grantDomainPublicationDigest.fill(0);
        planV4.namespaceBundleDigest.fill(0);
        if (planV4.authorization.disposition === "authorization_required") {
          planV4.authorization.authorizationPlanBytes.fill(0);
          planV4.authorization.authorizationPlanDigest.fill(0);
          planV4.authorization.recipientPublicKey.fill(0);
        } else {
          planV4.authorization.authorizationDigest.fill(0);
        }
      }
    }
  };

  const receiveStart = async (
    event: Extract<ForegroundRealtimeEvent, {
      type: "message.shadow_stream_start";
    }>,
  ): Promise<VaultLiveShadowReceiveResult> => {
    const key = streamKey(event.operationId, event.transcriptOrdinal);
    if (
      destroyed
      || failed.has(key)
      || streams.has(key)
      || fallbackStreams.has(key)
      || fallbackStreams.size >= 256
    ) return fail(
      key,
      undefined,
      "assistant_stream",
      "integrity_failure",
      "stream_start_precondition",
    );
    const startBytes = bytes(event.streamStartBytesBase64url);
    let publicStart;
    try {
      publicStart = decodeAgentLiveShadowStreamStartV2(startBytes);
      if (
        publicStart.operationId !== event.operationId
        || publicStart.transcriptOrdinal !== event.transcriptOrdinal
      ) return fail(
        key,
        undefined,
        "assistant_stream",
        "integrity_failure",
        "stream_start_decode",
      );
      fallbackStreams.set(key, {
        messageId: publicStart.messageId,
        assistantMessageKey: publicStart.assistantMessageKey,
        authorAgentId: publicStart.authorAgentId,
        nextSequence: 1,
      });
    } catch {
      return fail(
        key,
        undefined,
        "assistant_stream",
        "integrity_failure",
        "stream_start_decode",
      );
    } finally {
      if (publicStart !== undefined) {
        publicStart.namespaceHeadDigest.fill(0);
        publicStart.namespacePublicationDigest.fill(0);
        publicStart.namespacePublicationSetDigest.fill(0);
        publicStart.namespaceAudienceFingerprint.fill(0);
      }
      publicStart?.namespaceEnvelopeBytes.fill(0);
      publicStart?.namespaceEnvelopeDigest.fill(0);
      publicStart?.signature.fill(0);
    }
    try {
        const turn = turns.get(event.operationId);
        const namespaceClient = input.namespaceAuthority;
        if (
          turn === undefined
          || namespaceClient === undefined
        ) return fail(
          key,
          undefined,
          "assistant_stream",
          "integrity_failure",
          "stream_start_turn",
        );
        const authority = currentNamespaceKeyAuthority(turn);
        try {
          const start = verifyDeviceWrappedAgentLiveShadowStreamStart(
            input.crypto,
            {
              startBytes,
              now: unixTimestamp(now()),
              resolveSigner: (context) =>
                context.operationId === turn.operationId
                    && context.authorAgentId === turn.recipientAgentId
                    && context.hostAuthorizationRevision
                      === turn.hostAuthorizationRevision
                    && context.runtimeGeneration
                      === turn.agentRuntimeGeneration
                    && context.signerKeyId === turn.agentSignerKeyId
                  ? turn.agentSignerPublicKey.slice()
                  : null,
            },
          );
          const current = turn.namespaceKeyAuthority;
          const envelope = decodeNamespaceObjectEnvelopeV2(
            start.namespaceEnvelopeBytes,
          );
          try {
            if (
              start.operationId !== event.operationId
              || start.transcriptOrdinal !== event.transcriptOrdinal
              || start.namespaceId !== current.namespaceId
              || start.namespaceAccessRevision !== current.accessRevision
              || start.namespaceKeyGeneration !== current.generation
              || !equal(start.namespaceHeadDigest, current.headDigest)
              || !equal(
                start.namespacePublicationDigest,
                current.publicationDigest,
              )
              || !equal(
                start.namespacePublicationSetDigest,
                current.publicationSetDigest,
              )
              || !equal(
                start.namespaceAudienceFingerprint,
                current.audienceFingerprint,
              )
            ) return fail(key);
            const opened = await namespaceClient.withOpenedAiGenerations({
              sourceRoomId: turn.roomId,
              subjectHumanId: turn.subjectHumanId,
              deviceSigningKeyGeneration:
                current.deviceSigningKeyGeneration,
              authority,
            }, (entries) => {
              const generation = entries.find((entry) =>
                entry.namespaceId === current.namespaceId
                && entry.generation === current.generation
                && entry.accessRevision === current.accessRevision
                && equal(entry.headDigest, current.headDigest)
                && equal(
                  entry.audienceFingerprint,
                  current.audienceFingerprint,
                )
              );
              return generation === undefined
                ? null
                : openObjectDekForNamespace(
                  input.crypto,
                  generation.generationKey,
                  envelope,
                );
            });
            if (opened.status !== "opened" || opened.value === null) {
              return fail(
                key,
                undefined,
                "assistant_stream",
                "integrity_failure",
                "stream_start_keyring",
              );
            }
            streams.set(key, {
              operationId: event.operationId,
              policyRevision: start.policyRevision,
              transcriptOrdinal: event.transcriptOrdinal,
              sessionId: start.sessionId,
              roomId: start.roomId,
              messageId: start.messageId,
              revision: start.revision,
              createdAt: start.createdAt,
              cryptoObjectId: start.cryptoObjectId,
              namespaceId: start.namespaceId,
              authorAgentId: start.authorAgentId,
              assistantMessageKey: start.assistantMessageKey,
              streamId: start.streamId,
              startBytes: startBytes.slice(),
              startDigest: input.crypto.hash(startBytes),
              objectDek: opened.value,
              previousFrameHash: ZERO_HASH.slice(),
              nextSequence: 1,
              accumulatedBytes: 0,
              chunks: [],
              terminalFrameDigest: null,
              streamedTextDigest: null,
              finalPayloadDigest: null,
            });
            return Object.freeze({ status: "start_verified" as const });
          } finally {
            envelope.wrappedDek.fill(0);
            start.namespaceHeadDigest.fill(0);
            start.namespacePublicationDigest.fill(0);
            start.namespacePublicationSetDigest.fill(0);
            start.namespaceAudienceFingerprint.fill(0);
            start.namespaceEnvelopeBytes.fill(0);
            start.namespaceEnvelopeDigest.fill(0);
            start.signature.fill(0);
          }
        } finally {
          destroyNamespaceKeyAuthority(authority);
        }
    } catch {
        return fail(
          key,
          undefined,
          "assistant_stream",
          "integrity_failure",
          "stream_start_verify",
        );
    } finally {
      startBytes.fill(0);
    }
  };

  const receiveFrame = (
    event: Extract<ForegroundRealtimeEvent, {
      type: "message.shadow_stream_frame";
    }>,
  ): VaultLiveShadowReceiveResult => {
    const key = streamKey(event.operationId, event.transcriptOrdinal);
    const state = streams.get(key);
    const fallbackState = fallbackStreams.get(key);
    if (destroyed || fallbackState === undefined) {
      return fail(
        key,
        undefined,
        "assistant_stream",
        "stream_incomplete",
        "stream_frame_without_start",
      );
    }
    const ordinaryFallback: VaultLiveShadowOrdinaryFallback | undefined =
      event.wireVersion === 1
        ? Object.freeze({
          kind: "frame" as const,
          ordinaryChunk: event.ordinaryChunk,
          done: event.done,
          chunkSequence: fallbackState.nextSequence,
          messageId: fallbackState.messageId,
          assistantMessageKey: fallbackState.assistantMessageKey,
          authorAgentId: fallbackState.authorAgentId,
        })
        : undefined;
    fallbackState.nextSequence += 1;
    if (failed.has(key) || state === undefined) {
      return fail(
        key,
        ordinaryFallback,
        "assistant_stream",
        "stream_incomplete",
        "stream_frame_without_verified_start",
      );
    }
    const frameBytes = bytes(event.frameBytesBase64url);
    try {
      const opened = openDeviceWrappedAgentLiveShadowStreamFrame(input.crypto, {
        startBytes: state.startBytes,
        frameBytes,
        objectDek: state.objectDek,
        expectedSequence: state.nextSequence,
        expectedPreviousFrameHash: state.previousFrameHash,
        accumulatedPlaintextBytes: state.accumulatedBytes,
      });
      try {
        const ordinary = event.wireVersion === 1
          ? new TextEncoder().encode(event.ordinaryChunk)
          : null;
        const matches = (ordinary === null || equal(ordinary, opened.plaintext))
          && event.done === opened.frame.done;
        ordinary?.fill(0);
        if (!matches) {
          return fail(
            key,
            ordinaryFallback,
            "assistant_stream",
            "parity_mismatch",
            "stream_frame_parity",
          );
        }
        state.previousFrameHash.fill(0);
        state.previousFrameHash = opened.frameHash.slice();
        state.nextSequence += 1;
        state.accumulatedBytes = opened.accumulatedPlaintextBytes;
        state.chunks.push(opened.plaintext.slice());
        if (opened.frame.done) {
          state.terminalFrameDigest = opened.frameHash.slice();
          state.streamedTextDigest =
            opened.frame.streamedTextDigest!.slice();
          state.finalPayloadDigest = opened.frame.finalPayloadDigest!.slice();
        }
        return Object.freeze({
          status: "frame_verified" as const,
          ordinaryChunk: new TextDecoder().decode(opened.plaintext),
          done: opened.frame.done,
          chunkSequence: opened.frame.chunkSequence,
          messageId: state.messageId,
          assistantMessageKey: state.assistantMessageKey,
          authorAgentId: state.authorAgentId,
        });
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
    } catch {
      return fail(
        key,
        ordinaryFallback,
        "assistant_stream",
        "integrity_failure",
        "stream_frame_open",
      );
    } finally {
      frameBytes.fill(0);
    }
  };

  const receiveDurable = async (
    event: Extract<ForegroundRealtimeEvent, {
      type: "message.shadow_durable";
    }>,
  ): Promise<VaultLiveShadowReceiveResult> => {
    const key = streamKey(event.operationId, event.transcriptOrdinal);
    if (destroyed) return fail(key);
    const ordinary = event.wireVersion === 1
      ? bytes(event.ordinaryPayloadBytesBase64url)
      : null;
    let ordinaryPayload: MessagePayloadV2 | undefined;
    if (ordinary !== null) try {
      ordinaryPayload = decodeMessagePayloadV2(ordinary);
    } catch {
      ordinary.fill(0);
      return fail(key);
    }
    if (ordinaryPayload !== undefined && (
      ordinaryPayload.role !== event.protectedMessage.projection.role
      || (
        ordinaryPayload.role !== "assistant"
        && ordinaryPayload.role !== "tool"
      )
      || typeof event.protectedMessage.projection.authorAgentId !== "string"
    )) {
      ordinary?.fill(0);
      return fail(key);
    }
    const state = streams.get(key);
    const fallbackState = fallbackStreams.get(key);
    const durableFallback: VaultLiveShadowOrdinaryFallback | undefined =
      ordinaryPayload === undefined ? undefined : Object.freeze({
      kind: "durable" as const,
      payload: ordinaryPayload,
      messageId: event.protectedMessage.projection.messageId,
      assistantMessageKey:
        state?.assistantMessageKey ?? fallbackState?.assistantMessageKey ?? null,
      authorAgentId:
        event.protectedMessage.projection.authorAgentId
          ?? fallbackState?.authorAgentId
          ?? "",
      });
    const expectedDurableDigest = bytes(
      event.durableEventDigestBase64url,
    );
    const actualDurableDigest = event.wireVersion === 1
      ? liveShadowDurableEventDigestV1(input.crypto, {
        operationId: event.operationId,
        policyRevision: event.policyRevision,
        transcriptOrdinal: event.transcriptOrdinal,
        ordinaryPayloadBytes: ordinary!,
        protectedMessage: event.protectedMessage,
      })
      : fullEncryptionDurableEventDigestV2(input.crypto, {
        operationId: event.operationId,
        policyRevision: event.policyRevision,
        transcriptOrdinal: event.transcriptOrdinal,
        protectedMessage: event.protectedMessage,
      });
    const eventEvidenceMatches = equal(
      expectedDurableDigest,
      actualDurableDigest,
    ) && (state === undefined || state.policyRevision === event.policyRevision);
    expectedDurableDigest.fill(0);
    actualDurableDigest.fill(0);
    if (!eventEvidenceMatches) {
      ordinary?.fill(0);
      return fail(key, durableFallback);
    }
    if (failed.has(key)) {
      ordinary?.fill(0);
      fallbackStreams.delete(key);
      return fail(key, durableFallback);
    }
    const protectedPayload = event.protectedMessage.protectedPayload;
    if (protectedPayload.status !== "encrypted") {
      ordinary?.fill(0);
      return fail(key, durableFallback);
    }
    const encryptedBytes = bytes(
      protectedPayload.encryptedPayloadBytesBase64url,
    );
    const manifestBytes = bytes(
      protectedPayload.accessManifestBytesBase64url,
    );
    const envelopeBytes = bytes(
      protectedPayload.namespaceEnvelopeBytesBase64url,
    );
    let ackEvidence: AgentAckEvidence | null = null;
    try {
      const verifyDurable = async (): Promise<VaultLiveShadowReceiveResult> => {
        const turn = turns.get(event.operationId);
        if (turn === undefined) return fail(key, durableFallback);
          const verifiedManifest = verifyAgentObjectAccessManifest(
            input.crypto,
            {
              manifestBytes,
              resolveSignerPublicKey: (principal) =>
                principal.agentId === turn.recipientAgentId
                    && principal.runtimeGeneration
                      === turn.agentRuntimeGeneration
                    && principal.signerKeyId === turn.agentSignerKeyId
                  ? turn.agentSignerPublicKey.slice()
                  : null,
            },
          );
          const manifest = verifiedManifest.manifest;
          const encrypted = decodeEncryptedPayloadV2(encryptedBytes);
          const envelope = decodeNamespaceObjectEnvelopeV2(envelopeBytes);
          const encryptedDigest = input.crypto.hash(encryptedBytes);
          const envelopeDigest = input.crypto.hash(envelopeBytes);
          try {
            if (
              manifest.objectId !== protectedPayload.cryptoObjectId
              || !equal(manifest.payloadHash, encryptedDigest)
              || manifest.envelopeHashes.length !== 1
              || !equal(
                manifest.envelopeHashes[0]!,
                envelopeDigest,
              )
              || encrypted.context.objectId !== protectedPayload.cryptoObjectId
              || envelope.context.objectId !== protectedPayload.cryptoObjectId
              || envelope.context.namespaceId
                !== event.protectedMessage.projection.namespaceId
              || manifest.signer.agentId
                !== event.protectedMessage.projection.authorAgentId
              || (
                event.protectedMessage.projection.role !== "assistant"
                && event.protectedMessage.projection.role !== "tool"
              )
              || typeof event.protectedMessage.projection.authorAgentId
                !== "string"
            ) return fail(key, durableFallback);
            if (
              state !== undefined
              && (
                event.protectedMessage.projection.sessionId !== state.sessionId
                || event.protectedMessage.projection.roomId !== state.roomId
                || Number(event.protectedMessage.projection.messageId)
                  !== state.messageId
                || event.protectedMessage.projection.editRevision
                  !== state.revision
                || Date.parse(event.protectedMessage.projection.createdAt)
                  !== state.createdAt
                || event.protectedMessage.projection.namespaceId
                  !== state.namespaceId
                || event.protectedMessage.projection.role !== "assistant"
                || event.protectedMessage.projection.authorAgentId
                  !== state.authorAgentId
                || protectedPayload.cryptoObjectId !== state.cryptoObjectId
              )
            ) return fail(key, durableFallback);
            if (
              manifest.accessRevision !== 0
              || envelope.context.bindingRevisionAtWrap
                !== turn.namespaceKeyAuthority.accessRevision
            ) return fail(key, durableFallback);
            const namespaceClient = input.namespaceAuthority;
            const authority = currentNamespaceKeyAuthority(turn);
            if (namespaceClient === undefined) {
              destroyNamespaceKeyAuthority(authority);
              return fail(key, durableFallback);
            }
            let opened: Uint8Array | null = null;
            try {
              const result = await namespaceClient.withOpenedAiGenerations({
                sourceRoomId: turn.roomId,
                subjectHumanId: turn.subjectHumanId,
                deviceSigningKeyGeneration:
                  turn.namespaceKeyAuthority.deviceSigningKeyGeneration,
                authority,
              }, (entries) => {
                const generation = entries.find((entry) =>
                  entry.namespaceId === envelope.context.namespaceId
                  && entry.generation === envelope.context.keyGeneration
                  && entry.accessRevision
                    === turn.namespaceKeyAuthority.accessRevision
                  && equal(
                    entry.headDigest,
                    turn.namespaceKeyAuthority.headDigest,
                  )
                  && equal(
                    entry.audienceFingerprint,
                    turn.namespaceKeyAuthority.audienceFingerprint,
                  )
                );
                return generation === undefined
                  ? null
                  : decryptObjectThroughNamespace(
                    input.crypto,
                    generation.generationKey,
                    envelope,
                    encrypted,
                  );
              });
              opened = result.status === "opened" ? result.value : null;
            } finally {
              destroyNamespaceKeyAuthority(authority);
            }
            if (opened === null || (ordinary !== null && !equal(opened, ordinary))) {
              opened?.fill(0);
              return fail(key, durableFallback);
            }
            if (
              state?.finalPayloadDigest !== null
              && state?.finalPayloadDigest !== undefined
            ) {
              const finalDigest = input.crypto.hash(opened);
              const matches = equal(finalDigest, state.finalPayloadDigest);
              finalDigest.fill(0);
              if (matches) {
                // Continue with canonical payload decoding below.
              } else {
                opened.fill(0);
                return fail(key, durableFallback);
              }
            }
            const openedPayloadDigest = input.crypto.hash(opened);
            const payload = decodeMessagePayloadV2(opened);
            opened.fill(0);
            if (payload.role !== event.protectedMessage.projection.role) {
              openedPayloadDigest.fill(0);
              return fail(key, durableFallback);
            }
            if (
              payload.role === "assistant"
              && payload.content.length > 0
              && (
                state === undefined
                || state.terminalFrameDigest === null
                || state.streamedTextDigest === null
                || state.finalPayloadDigest === null
              )
            ) {
              openedPayloadDigest.fill(0);
              return fail(
                key,
                durableFallback,
                "assistant_stream",
                "stream_incomplete",
              );
            }
            const dtoBytes = new TextEncoder().encode(
              encodeProtectedMessageDtoV2(event.protectedMessage),
            );
            const streamTerminal = state !== undefined
                && state.terminalFrameDigest !== null
                && state.streamedTextDigest !== null
                && state.finalPayloadDigest !== null
              ? Object.freeze({
                  transcriptOrdinal: event.transcriptOrdinal,
                  streamId: state.streamId,
                  streamStartDigest: state.startDigest.slice(),
                  terminalFrameDigest: state.terminalFrameDigest.slice(),
                  streamedTextDigest: state.streamedTextDigest.slice(),
                  finalPayloadDigest: state.finalPayloadDigest.slice(),
                })
              : null;
            try {
              ackEvidence = Object.freeze({
                transcript: Object.freeze({
                  transcriptOrdinal: event.transcriptOrdinal,
                  messageId: Number(
                    event.protectedMessage.projection.messageId,
                  ),
                  revision: 0 as const,
                  authorRole: payload.role === "assistant"
                    ? "assistant" as const
                    : "tool" as const,
                  cryptoObjectId: objectId(protectedPayload.cryptoObjectId),
                  ordinaryPayloadDigest: openedPayloadDigest,
                  protectedDtoDigest: input.crypto.hash(dtoBytes),
                }),
                streamTerminal,
                finalTurnMessage: payload.role === "assistant"
                  && (payload.toolCalls?.length ?? 0) === 0,
              });
            } finally {
              dtoBytes.fill(0);
            }
            return Object.freeze({
              status: "durable_verified" as const,
              payload,
              messageId: event.protectedMessage.projection.messageId,
              assistantMessageKey: state?.assistantMessageKey ?? null,
              authorAgentId:
                event.protectedMessage.projection.authorAgentId ?? "",
            });
          } finally {
            encryptedDigest.fill(0);
            envelopeDigest.fill(0);
            encrypted.ciphertext.fill(0);
            envelope.wrappedDek.fill(0);
            manifest.payloadHash.fill(0);
            manifest.previousManifestHash?.fill(0);
            manifest.envelopeHashes.forEach((hash) => hash.fill(0));
            manifest.signature.fill(0);
            verifiedManifest.manifestBytes.fill(0);
            verifiedManifest.manifestHash.fill(0);
          }
      };
      const result = await verifyDurable();
      const evidence = ackEvidence as AgentAckEvidence | null;
      if (result.status === "durable_verified" && evidence !== null) {
        const turn = turns.get(event.operationId);
        if (turn !== undefined) {
          if (
            turn.policyRevision !== event.policyRevision
            || turn.sessionId !== event.protectedMessage.projection.sessionId
            || turn.roomId !== event.protectedMessage.projection.roomId
          ) {
            destroyEvidence(evidence);
            return fail(key, durableFallback);
          }
          try {
            appendEvidence(turn, evidence);
            await submitTurn(turn);
          } catch {
            return fail(key, durableFallback);
          }
        } else {
          if (terminalOperations.has(event.operationId)) {
            destroyEvidence(evidence);
            return result;
          }
          const pending = pendingEvidence.get(event.operationId) ?? [];
          if (pending.length >= 255 || pendingEvidence.size >= 128) {
            destroyEvidence(evidence);
            return fail(key, durableFallback);
          }
          pending.push(evidence);
          pendingEvidence.set(event.operationId, pending);
        }
      }
      return result;
    } catch {
      if (ackEvidence !== null) destroyEvidence(ackEvidence);
      return fail(key, durableFallback);
    } finally {
      ordinary?.fill(0);
      encryptedBytes.fill(0);
      manifestBytes.fill(0);
      envelopeBytes.fill(0);
      releaseStream(key);
      fallbackStreams.delete(key);
    }
  };

  return Object.freeze({
    registerHuman,
    receive: async (candidate: unknown) => {
      let event: LiveShadowMessageRealtimeEventV1
        | FullEncryptionMessageRealtimeContentEventV2;
      try {
        event = typeof candidate === "object" && candidate !== null
            && "wireVersion" in candidate && candidate.wireVersion === 2
          ? parseFullEncryptionMessageRealtimeContentEventV2(candidate)
          : parseLiveShadowMessageRealtimeEventV1(candidate);
      } catch {
        return Object.freeze({
          status: "failed" as const,
          reason: "integrity" as const,
        });
      }
      if (
        event.type === "message.shared_agent_authorization_required"
        || event.type === "message.runtime_invocation_authorization_required"
      ) {
        return Object.freeze({
          status: "failed" as const,
          reason: "unavailable" as const,
        });
      }
      const result = event.type === "message.shadow_stream_start"
        ? await receiveStart(event)
        : event.type === "message.shadow_stream_frame"
          ? receiveFrame(event)
          : event.type === "message.shadow_durable"
            ? await receiveDurable(event)
            : Object.freeze({
                status: "failed" as const,
                reason: "unavailable" as const,
              });
      await flushPendingFailure(event.operationId);
      return result;
    },
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      for (const key of [...streams.keys()]) releaseStream(key);
      fallbackStreams.clear();
      failed.clear();
      terminalOperations.clear();
      for (const turn of turns.values()) destroyTurn(turn);
      turns.clear();
      for (const evidence of pendingEvidence.values()) {
        evidence.forEach(destroyEvidence);
      }
      pendingEvidence.clear();
      pendingFailures.clear();
    },
  });
}
