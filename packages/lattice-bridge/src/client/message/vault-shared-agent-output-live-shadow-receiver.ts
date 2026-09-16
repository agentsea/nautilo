import {
  agentId,
  authorizationRevision,
  cryptoDeviceId,
  decryptObjectThroughNamespace,
  humanId,
  objectId,
  openDeviceWrappedAgentLiveShadowStreamFrame,
  openObjectDekForNamespace,
  prepareSharedAgentLiveShadowAcknowledgement,
  unixTimestamp,
  verifyAgentObjectAccessManifest,
  verifyDeviceWrappedAgentLiveShadowStreamStart,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import {
  decodeEncryptedPayloadV2,
  decodeLiveShadowMessagePlanV4,
  decodeNamespaceObjectEnvelopeV2,
  encodeLiveShadowMessagePlanV4,
} from "@nautilo/lattice-crypto/wire";
import {
  parseFullEncryptionMessageRealtimeContentEventV2,
  parseLiveShadowMessageRealtimeEventV1,
  type FullEncryptionMessageRealtimeContentEventV2,
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
import { fullEncryptionDurableEventDigestV2, liveShadowDurableEventDigestV1 } from
  "../../message/live-shadow-realtime-evidence.ts";
import {
  decodeMessagePayloadV2,
  type MessagePayloadV2,
} from "../../message/message-payload-v2.ts";
import type {
  VaultLiveShadowFailureCheckpoint,
  VaultLiveShadowReceiveResult,
} from "./vault-live-shadow-message-receiver.ts";
import type { NamespaceAuthorityClient } from
  "./namespace-authority-client.ts";

type SharedOutputEvent = LiveShadowMessageRealtimeEventV1 | FullEncryptionMessageRealtimeContentEventV2;
type StartEvent = Extract<SharedOutputEvent, {
  type: "message.shared_agent_stream_start";
}>;
type FrameEvent = Extract<SharedOutputEvent, {
  type: "message.shared_agent_stream_frame";
}>;
type DurableEvent = Extract<SharedOutputEvent, {
  type: "message.shared_agent_output_shadow";
}>;

type StreamState = {
  readonly operationId: string;
  readonly transcriptOrdinal: number;
  readonly policyRevision: number;
  readonly sessionId: string;
  readonly roomId: string;
  readonly messageId: number;
  readonly createdAt: number;
  readonly cryptoObjectId: string;
  readonly namespaceId: string;
  readonly authorAgentId: string;
  readonly assistantMessageKey: string;
  readonly startBytes: Uint8Array;
  readonly objectDek: Uint8Array;
  previousFrameHash: Uint8Array;
  nextSequence: number;
  accumulatedBytes: number;
  terminal: boolean;
  finalPayloadDigest: Uint8Array | null;
};

export interface SharedAgentOutputReadApiPort {
  planSharedAgentOutputRead(input: Readonly<{
    roomId: string;
    executionId: string;
    clientDeviceId: string;
  }>): Promise<
    | Readonly<{
        status: "ready";
        subjectHumanId: string;
        clientDeviceId: string;
        clientDeviceSigningKeyGeneration: number;
        hostAuthorizationRevision: number;
      }>
    | Readonly<{ status: "unavailable"; reason: string }>
  >;
  acknowledgeSharedAgentOutput(input: Readonly<{
    roomId: string;
    executionId: string;
    acknowledgementBytesBase64url: string;
  }>): Promise<"verified" | "replayed">;
}

export interface VaultSharedAgentOutputLiveShadowReceiver {
  receive(candidate: unknown): Promise<VaultLiveShadowReceiveResult | null>;
  destroy(): void;
}

function fromBase64url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/")
    + "=".repeat((4 - value.length % 4) % 4);
  const result = Uint8Array.from(
    atob(padded),
    (character) => character.charCodeAt(0),
  );
  if (result.length === 0 || toBase64url(result) !== value) {
    result.fill(0);
    throw new TypeError("Shared-Agent output bytes are noncanonical");
  }
  return result;
}

function toBase64url(value: Uint8Array): string {
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

function key(operationId: string, transcriptOrdinal: number): string {
  return `${operationId}\0${transcriptOrdinal}`;
}

function release(state: StreamState): void {
  state.startBytes.fill(0);
  state.objectDek.fill(0);
  state.previousFrameHash.fill(0);
  state.finalPayloadDigest?.fill(0);
}

function destroyPlan(
  plan: ReturnType<typeof decodeLiveShadowMessagePlanV4>,
): void {
  plan.agentSignerPublicKey.fill(0);
  plan.namespaceHeadDigest.fill(0);
  plan.namespacePublicationDigest.fill(0);
  plan.namespacePublicationSetDigest.fill(0);
  plan.namespaceAudienceFingerprint.fill(0);
  plan.grantDomainParticipantDigest.fill(0);
  plan.grantDomainHeadDigest.fill(0);
  plan.grantDomainPublicationDigest.fill(0);
  plan.namespaceBundleDigest.fill(0);
  if (plan.authorization.disposition === "authorization_required") {
    plan.authorization.authorizationPlanBytes.fill(0);
    plan.authorization.authorizationPlanDigest.fill(0);
    plan.authorization.recipientPublicKey.fill(0);
  } else {
    plan.authorization.authorizationDigest.fill(0);
  }
}

function failed(
  ordinaryFallback?: NonNullable<Extract<VaultLiveShadowReceiveResult, {
    status: "failed";
  }>["ordinaryFallback"]>,
  checkpoint?: VaultLiveShadowFailureCheckpoint,
): VaultLiveShadowReceiveResult {
  return Object.freeze({
    status: "failed" as const,
    reason: "integrity" as const,
    ...(checkpoint === undefined ? {} : { checkpoint }),
    ...(ordinaryFallback === undefined ? {} : { ordinaryFallback }),
  });
}

export function createVaultSharedAgentOutputLiveShadowReceiver(input: Readonly<{
  crypto: LatticeCrypto;
  vault: ClientProfileVault;
  coordinates: ClientProfileCoordinates;
  namespaceAuthority: NamespaceAuthorityClient;
  api: SharedAgentOutputReadApiPort;
  now?: () => number;
}>): VaultSharedAgentOutputLiveShadowReceiver {
  const streams = new Map<string, StreamState>();
  const now = input.now ?? Date.now;
  let destroyed = false;

  const acknowledge = async (
    plan: ReturnType<typeof decodeLiveShadowMessagePlanV4>,
    event: DurableEvent,
    durableEventDigest: Uint8Array,
    ordinaryPayloadBytes: Uint8Array,
    status: "verified" | "fallback",
    reason:
      | "matched"
      | "authority_stale"
      | "sender_evidence_unavailable"
      | "namespace_unavailable"
      | "protected_open_failed"
      | "parity_mismatch"
      | "transport_unavailable",
  ): Promise<void> => {
    const current = await input.api.planSharedAgentOutputRead({
      roomId: plan.roomId,
      executionId: plan.operationId,
      clientDeviceId: input.coordinates.deviceId,
    });
    if (current.status !== "ready") {
      throw new Error("Shared-Agent output acknowledgement authority is absent");
    }
    const availability = await input.vault.availability();
    if (
      availability.status !== "available"
      && (await input.vault.unlock()).status !== "available"
    ) throw new Error("Shared-Agent output acknowledgement profile is locked");
    await input.vault.withOpenProfile(input.coordinates, async (profileBytes) => {
      const profile = await authenticateClientDeviceProfileV4({
        crypto: input.crypto,
        profileBytes,
        expectedDeviceId: input.coordinates.deviceId,
      });
      let created: ReturnType<
        typeof prepareSharedAgentLiveShadowAcknowledgement
      > | null = null;
      const ordinaryDigest = input.crypto.hash(ordinaryPayloadBytes);
      try {
        const base = profile.baseProfile.baseProfile;
        const issuedAt = now();
        created = prepareSharedAgentLiveShadowAcknowledgement(input.crypto, {
          subjectHumanId: humanId(current.subjectHumanId),
          operationId: plan.operationId,
          clientIdempotencyKey: plan.operationId,
          policyRevision: plan.policyRevision,
          sessionId: plan.sessionId,
          roomId: plan.roomId,
          recipientAgentId: agentId(plan.recipientAgentId),
          messageId: Number(event.protectedMessage.projection.messageId),
          revision: 0,
          transcriptOrdinal: event.transcriptOrdinal,
          cryptoObjectId: objectId(
            event.protectedMessage.protectedPayload.status === "encrypted"
              ? event.protectedMessage.protectedPayload.cryptoObjectId
              : "unavailable",
          ),
          // Agent-output acknowledgements bind the server-recorded complete
          // durable-event digest in this existing digest slot.
          protectedMessageDigest: durableEventDigest,
          ordinaryPayloadDigest: ordinaryDigest,
          status,
          reason,
          issuedAt: unixTimestamp(issuedAt),
          deadlineAt: unixTimestamp(issuedAt + 30_000),
          committerDeviceId: cryptoDeviceId(base.deviceId),
          committerDeviceSigningKeyGeneration:
            current.clientDeviceSigningKeyGeneration,
          hostAuthorizationRevision: authorizationRevision(
            current.hostAuthorizationRevision,
          ),
          committerSigningPublicKey: base.signingPublicKey,
          committerSigningPrivateKey: base.signingPrivateKey,
        });
        await input.api.acknowledgeSharedAgentOutput({
          roomId: plan.roomId,
          executionId: plan.operationId,
          acknowledgementBytesBase64url: toBase64url(created.bytes),
        });
      } finally {
        ordinaryDigest.fill(0);
        created?.bytes.fill(0);
        created?.acknowledgementDigest.fill(0);
        created?.acknowledgement.protectedMessageDigest.fill(0);
        created?.acknowledgement.ordinaryPayloadDigest.fill(0);
        created?.acknowledgement.signature.fill(0);
        destroyOpenedClientDeviceProfileV4(profile);
      }
    });
  };

  const withCurrentNamespace = async <Value>(
    plan: ReturnType<typeof decodeLiveShadowMessagePlanV4>,
    use: (key: Uint8Array) => Value | Promise<Value>,
  ): Promise<Value | null> => {
    const current = await input.api.planSharedAgentOutputRead({
      roomId: plan.roomId,
      executionId: plan.operationId,
      clientDeviceId: input.coordinates.deviceId,
    });
    if (
      current.status !== "ready"
      || current.clientDeviceId !== input.coordinates.deviceId
      || input.namespaceAuthority.withOpenedGenerations === undefined
    ) return null;
    const opened = await input.namespaceAuthority.withOpenedGenerations({
      sourceRoomId: plan.roomId,
      subjectHumanId: current.subjectHumanId,
      deviceSigningKeyGeneration:
        current.clientDeviceSigningKeyGeneration,
      keyClass: "ai",
      authority: [{
        namespaceId: plan.namespaceId,
        retainedGenerations: [{
          generation: plan.namespaceKeyGeneration,
          accessRevision: plan.namespaceAccessRevision,
          headDigest: plan.namespaceHeadDigest,
          publicationDigest: plan.namespacePublicationDigest,
          publicationSetDigest: plan.namespacePublicationSetDigest,
          audienceFingerprint: plan.namespaceAudienceFingerprint,
        }],
      }],
    }, async (entries) => {
      const generation = entries.find((entry) =>
        entry.namespaceId === plan.namespaceId
        && entry.keyClass === "ai"
        && entry.generation === plan.namespaceKeyGeneration
        && entry.accessRevision === plan.namespaceAccessRevision
        && equal(entry.headDigest, plan.namespaceHeadDigest)
        && equal(
          entry.audienceFingerprint,
          plan.namespaceAudienceFingerprint,
        )
      );
      return generation === undefined
        ? null
        : use(generation.generationKey);
    });
    return opened.status === "opened" ? opened.value : null;
  };

  const receiveStart = async (
    event: StartEvent,
  ): Promise<VaultLiveShadowReceiveResult> => {
    const streamKey = key(event.operationId, event.transcriptOrdinal);
    if (destroyed || streams.has(streamKey) || streams.size >= 256) {
      return failed(undefined, "stream_start_precondition");
    }
    const planBytes = fromBase64url(event.planBytesBase64url);
    const startBytes = fromBase64url(event.streamStartBytesBase64url);
    let plan: ReturnType<typeof decodeLiveShadowMessagePlanV4> | null = null;
    let checkpoint: VaultLiveShadowFailureCheckpoint = "stream_start_decode";
    try {
      plan = decodeLiveShadowMessagePlanV4(planBytes);
      const canonical = encodeLiveShadowMessagePlanV4(plan);
      const canonicalPlan = equal(canonical, planBytes);
      canonical.fill(0);
      checkpoint = "stream_start_turn";
      if (
        !canonicalPlan
        || plan.operationId !== event.operationId
        || plan.roomId !== event.laneKey.slice("room:".length).split(":")[0]
      ) return failed(undefined, checkpoint);
      checkpoint = "stream_start_verify";
      const start = verifyDeviceWrappedAgentLiveShadowStreamStart(
        input.crypto,
        {
          startBytes,
          now: unixTimestamp(now()),
          resolveSigner: (context) =>
            context.operationId === plan!.operationId
                && context.authorAgentId === plan!.recipientAgentId
                && context.runtimeGeneration
                  === plan!.agentRuntimeGeneration
                && context.signerKeyId === plan!.agentSignerKeyId
                && context.hostAuthorizationRevision
                  === plan!.hostAuthorizationRevision
              ? plan!.agentSignerPublicKey.slice()
              : null,
        },
      );
      const envelope = decodeNamespaceObjectEnvelopeV2(
        start.namespaceEnvelopeBytes,
      );
      try {
        if (
          start.operationId !== event.operationId
          || start.transcriptOrdinal !== event.transcriptOrdinal
          || start.policyRevision !== plan.policyRevision
          || start.sessionId !== plan.sessionId
          || start.roomId !== plan.roomId
          || start.namespaceId !== plan.namespaceId
          || start.namespaceAccessRevision !== plan.namespaceAccessRevision
          || start.namespaceKeyGeneration !== plan.namespaceKeyGeneration
          || !equal(start.namespaceHeadDigest, plan.namespaceHeadDigest)
          || !equal(
            start.namespacePublicationDigest,
            plan.namespacePublicationDigest,
          )
          || !equal(
            start.namespacePublicationSetDigest,
            plan.namespacePublicationSetDigest,
          )
          || !equal(
            start.namespaceAudienceFingerprint,
            plan.namespaceAudienceFingerprint,
          )
        ) return failed(undefined, checkpoint);
        checkpoint = "stream_start_keyring";
        const objectDek = await withCurrentNamespace(plan, (namespaceKey) =>
          openObjectDekForNamespace(input.crypto, namespaceKey, envelope)
        );
        if (objectDek === null) return failed(undefined, checkpoint);
        streams.set(streamKey, {
          operationId: event.operationId,
          transcriptOrdinal: event.transcriptOrdinal,
          policyRevision: start.policyRevision,
          sessionId: start.sessionId,
          roomId: start.roomId,
          messageId: start.messageId,
          createdAt: start.createdAt,
          cryptoObjectId: start.cryptoObjectId,
          namespaceId: start.namespaceId,
          authorAgentId: start.authorAgentId,
          assistantMessageKey: start.assistantMessageKey,
          startBytes: startBytes.slice(),
          objectDek,
          previousFrameHash: new Uint8Array(32),
          nextSequence: 1,
          accumulatedBytes: 0,
          terminal: false,
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
    } catch {
      return failed(undefined, checkpoint);
    } finally {
      planBytes.fill(0);
      startBytes.fill(0);
      if (plan !== null) destroyPlan(plan);
    }
  };

  const receiveFrame = (event: FrameEvent): VaultLiveShadowReceiveResult => {
    const streamKey = key(event.operationId, event.transcriptOrdinal);
    const state = streams.get(streamKey);
    const ordinaryFallback = state === undefined || event.wireVersion === 2
      ? undefined
      : Object.freeze({
          kind: "frame" as const,
          ordinaryChunk: event.ordinaryChunk,
          done: event.done,
          chunkSequence: state.nextSequence,
          messageId: state.messageId,
          assistantMessageKey: state.assistantMessageKey,
          authorAgentId: state.authorAgentId,
        });
    if (destroyed || state === undefined || state.terminal) {
      return failed(ordinaryFallback);
    }
    const frameBytes = fromBase64url(event.frameBytesBase64url);
    try {
      const opened = openDeviceWrappedAgentLiveShadowStreamFrame(
        input.crypto,
        {
          startBytes: state.startBytes,
          frameBytes,
          objectDek: state.objectDek,
          expectedSequence: state.nextSequence,
          expectedPreviousFrameHash: state.previousFrameHash,
          accumulatedPlaintextBytes: state.accumulatedBytes,
        },
      );
      try {
        const ordinary = event.wireVersion === 1
          ? new TextEncoder().encode(event.ordinaryChunk) : null;
        const matches = (ordinary === null || equal(ordinary, opened.plaintext))
          && event.done === opened.frame.done;
        ordinary?.fill(0);
        if (!matches) return failed(ordinaryFallback);
        state.previousFrameHash.fill(0);
        state.previousFrameHash = opened.frameHash.slice();
        state.nextSequence += 1;
        state.accumulatedBytes = opened.accumulatedPlaintextBytes;
        state.terminal = opened.frame.done;
        state.finalPayloadDigest =
          opened.frame.finalPayloadDigest?.slice() ?? null;
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
      return failed(ordinaryFallback);
    } finally {
      frameBytes.fill(0);
    }
  };

  const receiveDurable = async (
    event: DurableEvent,
  ): Promise<VaultLiveShadowReceiveResult> => {
    const streamKey = key(event.operationId, event.transcriptOrdinal);
    const state = streams.get(streamKey);
    const ordinaryBytes = event.wireVersion === 1
      ? fromBase64url(event.ordinaryPayloadBytesBase64url) : null;
    let ordinary: MessagePayloadV2 | undefined;
    if (ordinaryBytes !== null) try { ordinary = decodeMessagePayloadV2(ordinaryBytes); }
    catch { ordinaryBytes.fill(0); return failed(); }
    const ordinaryFallback = ordinary === undefined ? undefined : Object.freeze({
      kind: "durable" as const,
      payload: ordinary,
      messageId: event.protectedMessage.projection.messageId,
      assistantMessageKey: state?.assistantMessageKey ?? null,
      authorAgentId:
        event.protectedMessage.projection.authorAgentId ?? "",
    });
    const planBytes = fromBase64url(event.planBytesBase64url);
    const protectedPayload = event.protectedMessage.protectedPayload;
    if (protectedPayload.status !== "encrypted") {
      ordinaryBytes?.fill(0);
      planBytes.fill(0);
      return failed(ordinaryFallback);
    }
    const encryptedBytes = fromBase64url(
      protectedPayload.encryptedPayloadBytesBase64url,
    );
    const manifestBytes = fromBase64url(
      protectedPayload.accessManifestBytesBase64url,
    );
    const envelopeBytes = fromBase64url(
      protectedPayload.namespaceEnvelopeBytesBase64url,
    );
    let plan: ReturnType<typeof decodeLiveShadowMessagePlanV4> | null = null;
    let expectedEventDigest: Uint8Array | null = null;
    try {
      plan = decodeLiveShadowMessagePlanV4(planBytes);
      const canonicalPlanBytes = encodeLiveShadowMessagePlanV4(plan);
      const canonicalPlan = equal(canonicalPlanBytes, planBytes);
      canonicalPlanBytes.fill(0);
      expectedEventDigest = fromBase64url(
        event.durableEventDigestBase64url,
      );
      const actualEventDigest = event.wireVersion === 1
        ? liveShadowDurableEventDigestV1(input.crypto, {
        operationId: event.operationId,
        policyRevision: event.policyRevision,
        transcriptOrdinal: event.transcriptOrdinal,
        ordinaryPayloadBytes: ordinaryBytes!,
        protectedMessage: event.protectedMessage,
        }) : fullEncryptionDurableEventDigestV2(input.crypto, {
          operationId: event.operationId, policyRevision: event.policyRevision,
          transcriptOrdinal: event.transcriptOrdinal,
          protectedMessage: event.protectedMessage,
        });
      const eventMatches = equal(expectedEventDigest, actualEventDigest);
      actualEventDigest.fill(0);
      if (
        !canonicalPlan
        || !eventMatches
        || plan.operationId !== event.operationId
        || plan.policyRevision !== event.policyRevision
        || plan.sessionId !== event.protectedMessage.projection.sessionId
        || plan.roomId !== event.protectedMessage.projection.roomId
        || plan.namespaceId !== event.protectedMessage.projection.namespaceId
        || plan.recipientAgentId
          !== event.protectedMessage.projection.authorAgentId
        || event.protectedMessage.projection.editRevision !== 0
        || (ordinary !== undefined && ((ordinary.role !== "assistant" && ordinary.role !== "tool")
          || ordinary.role !== event.protectedMessage.projection.role))
      ) return failed(ordinaryFallback);
      const verified = verifyAgentObjectAccessManifest(input.crypto, {
        manifestBytes,
        resolveSignerPublicKey: (principal) =>
          principal.agentId === plan!.recipientAgentId
              && principal.runtimeGeneration === plan!.agentRuntimeGeneration
              && principal.signerKeyId === plan!.agentSignerKeyId
            ? plan!.agentSignerPublicKey.slice()
            : null,
      });
      const encrypted = decodeEncryptedPayloadV2(encryptedBytes);
      const envelope = decodeNamespaceObjectEnvelopeV2(envelopeBytes);
      try {
        const manifest = verified.manifest;
        const payloadDigest = input.crypto.hash(encryptedBytes);
        const envelopeDigest = input.crypto.hash(envelopeBytes);
        const coordinatesMatch =
          manifest.objectId === protectedPayload.cryptoObjectId
          && equal(manifest.payloadHash, payloadDigest)
          && manifest.envelopeHashes.length === 1
          && equal(manifest.envelopeHashes[0]!, envelopeDigest)
          && encrypted.context.objectId === protectedPayload.cryptoObjectId
          && envelope.context.objectId === protectedPayload.cryptoObjectId
          && envelope.context.namespaceId === plan.namespaceId
          && envelope.context.keyGeneration === plan.namespaceKeyGeneration
          && envelope.context.bindingRevisionAtWrap
            === plan.namespaceAccessRevision;
        payloadDigest.fill(0);
        envelopeDigest.fill(0);
        if (!coordinatesMatch) return failed(ordinaryFallback);
        const opened = await withCurrentNamespace(plan, (namespaceKey) =>
          decryptObjectThroughNamespace(
            input.crypto,
            namespaceKey,
            envelope,
            encrypted,
          )
        );
        if (opened === null || (ordinaryBytes !== null && !equal(opened, ordinaryBytes))) {
          opened?.fill(0);
          if (ordinaryBytes !== null) await acknowledge(
            plan,
            event,
            expectedEventDigest,
            ordinaryBytes,
            "fallback",
            opened === null ? "namespace_unavailable" : "parity_mismatch",
          );
          return failed(ordinaryFallback);
        }
        const payload = decodeMessagePayloadV2(opened);
        if (payload.role !== event.protectedMessage.projection.role) {
          opened.fill(0);
          return failed(ordinaryFallback);
        }
        if (
          payload.role === "assistant"
          && payload.content.length > 0
          && state === undefined
        ) {
          if (ordinaryBytes !== null) await acknowledge(
            plan,
            event,
            expectedEventDigest,
            ordinaryBytes,
            "fallback",
            "parity_mismatch",
          );
          opened.fill(0);
          return failed(ordinaryFallback);
        }
        const finalPayloadDigest = state === undefined
          ? null
          : input.crypto.hash(opened);
        const streamMatches = state === undefined
          || (
            state.terminal
            && state.finalPayloadDigest !== null
            && equal(state.finalPayloadDigest, finalPayloadDigest!)
            && state.sessionId === plan.sessionId
            && state.roomId === plan.roomId
            && state.messageId
              === Number(event.protectedMessage.projection.messageId)
            && state.cryptoObjectId === protectedPayload.cryptoObjectId
          );
        finalPayloadDigest?.fill(0);
        if (
          state !== undefined
          && !streamMatches
        ) {
          await acknowledge(
            plan,
            event,
            expectedEventDigest,
            opened,
            "fallback",
            "parity_mismatch",
          );
          opened.fill(0);
          return failed(ordinaryFallback);
        }
        await acknowledge(
          plan,
          event,
          expectedEventDigest,
          opened,
          "verified",
          "matched",
        );
        opened.fill(0);
        return Object.freeze({
          status: "durable_verified" as const,
          payload,
          messageId: event.protectedMessage.projection.messageId,
          assistantMessageKey: state?.assistantMessageKey ?? null,
          authorAgentId:
            event.protectedMessage.projection.authorAgentId ?? "",
        });
      } finally {
        encrypted.ciphertext.fill(0);
        envelope.wrappedDek.fill(0);
        verified.manifest.payloadHash.fill(0);
        verified.manifest.previousManifestHash?.fill(0);
        verified.manifest.envelopeHashes.forEach((value) => value.fill(0));
        verified.manifest.signature.fill(0);
        verified.manifestBytes.fill(0);
        verified.manifestHash.fill(0);
      }
    } catch {
      return failed(ordinaryFallback);
    } finally {
      ordinaryBytes?.fill(0);
      planBytes.fill(0);
      encryptedBytes.fill(0);
      manifestBytes.fill(0);
      envelopeBytes.fill(0);
      expectedEventDigest?.fill(0);
      if (plan !== null) destroyPlan(plan);
      if (state !== undefined) {
        release(state);
        streams.delete(streamKey);
      }
    }
  };

  return Object.freeze({
    async receive(candidate: unknown) {
      let event: StartEvent | FrameEvent | DurableEvent;
      try {
        const parsed = typeof candidate === "object" && candidate !== null
            && "wireVersion" in candidate && candidate.wireVersion === 2
          ? parseFullEncryptionMessageRealtimeContentEventV2(candidate)
          : parseLiveShadowMessageRealtimeEventV1(candidate);
        if (
          parsed.type !== "message.shared_agent_stream_start"
          && parsed.type !== "message.shared_agent_stream_frame"
          && parsed.type !== "message.shared_agent_output_shadow"
        ) return null;
        event = parsed;
      } catch {
        return null;
      }
      return event.type === "message.shared_agent_stream_start"
        ? receiveStart(event)
        : event.type === "message.shared_agent_stream_frame"
        ? receiveFrame(event)
        : receiveDurable(event);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      streams.forEach(release);
      streams.clear();
    },
  });
}
