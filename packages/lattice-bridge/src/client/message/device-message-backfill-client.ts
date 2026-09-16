import {
  type MessageBackfillAckRequest, type MessageBackfillAckResponse,
  type MessageBackfillClaim, type MessageBackfillUrgentSelection,
  type MessageBackfillNextResponse, type MessageBackfillOutcome,
  type MessageBackfillPublishRequest, type MessageBackfillPublishResponse,
  type MessageBackfillSourceResponse,
} from "@nautilo/api-client/browser";
import {
  type LatticeCrypto, agentId, authorizationRevision, cryptoDeviceId, humanId,
  namespaceId, objectId, prepareHumanExistingMessageRepresentationPublicationRequest, unixTimestamp,
} from "@nautilo/lattice-crypto";
import { authenticateClientDeviceProfileV4, destroyOpenedClientDeviceProfileV4 } from "../../client-vault/profile-v4.ts";
import type { ClientProfileCoordinates, ClientProfileVault } from "../../client-vault/types.ts";
import { decodeMessagePayloadV2, encodeMessagePayloadV2 } from "../../message/message-payload-v2.ts";
import { messageBackfillAcknowledgementDigest, messageBackfillClaimDigest } from "../../message/message-backfill-ack.ts";
import { prepareHumanExistingMessageRepresentationCryptoRevision, prepareHumanPeerLiveShadowCryptoRevision } from
  "../../message/human-existing-message-representation-crypto.ts";
import { readPreparedConversationCryptoRevision } from "../../message/conversation-prepared-revision.ts";
import { ClassifiedDataOperationError, classifyDataOperationFailure, type EncryptionDataOperationOwner } from
  "../../transition/encryption-data-operation-owner.ts";
import type { ForegroundRoomHistoryShadowMessageReader } from "./foreground-shadow-client-composition.ts";
import type { MessageBackfillBatchResult } from "./message-backfill-worker.ts";
import type { NamespaceAuthorityClient } from "./namespace-authority-client.ts";
import type { RoomHistoryShadowRecordTransportV1, VaultRoomHistoryShadowReadResultV1 } from
  "./vault-room-history-shadow-message-reader.ts";

export interface DeviceMessageBackfillApiPort {
  nextMessageBackfill(input: Readonly<{ urgent?: MessageBackfillUrgentSelection }>, options?: Readonly<{signal?: AbortSignal}>): Promise<MessageBackfillNextResponse>;
  readMessageBackfillSource(input: Readonly<{ claimId: string }>, options?: Readonly<{signal?: AbortSignal}>): Promise<MessageBackfillSourceResponse>;
  publishMessageBackfill(input: MessageBackfillPublishRequest, options?: Readonly<{signal?: AbortSignal}>): Promise<MessageBackfillPublishResponse>;
  acknowledgeMessageBackfill(input: MessageBackfillAckRequest, options?: Readonly<{signal?: AbortSignal}>): Promise<MessageBackfillAckResponse>;
}

const waiting = (): MessageBackfillBatchResult => ({ state: "waiting", resumeAt: null });
// Backfill has no useful ordinary-only substitute. Preserve the original error
// for durable waiting acknowledgement instead of invoking a fallback mutation.
function backfillFailure(error: unknown) {
  const failure = classifyDataOperationFailure(error);
  return failure === "key_waiting" || failure === "recoverable_availability" ? "unknown" : failure;
}
function bytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) throw new ClassifiedDataOperationError("integrity", "Invalid backfill encoding");
  const result = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")
    + "=".repeat((4 - value.length % 4) % 4)), character => character.charCodeAt(0));
  if (base64url(result) !== value) { result.fill(0); throw new ClassifiedDataOperationError("integrity", "Invalid backfill encoding"); }
  return result;
}
function base64url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
function equal(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  for (let index = 0; index < left.length; index++) difference |= left[index]! ^ (right[index] ?? 0);
  return difference === 0;
}
function decodePayload(value: Uint8Array) {
  try { return decodeMessagePayloadV2(value); } catch { return fail("integrity"); }
}
function fail(kind: ConstructorParameters<typeof ClassifiedDataOperationError>[0]): never {
  throw new ClassifiedDataOperationError(kind, "Message backfill requires current exact authority");
}

type ProtectedSource = Extract<MessageBackfillSourceResponse, { status: "protected" }>;
/** This adapter has canonical source bytes, so no Room view or UI Message DTO is needed. */
function historyRecords(source: ProtectedSource): readonly RoomHistoryShadowRecordTransportV1[] {
  if (source.history.status !== "ready") return fail("key_waiting");
  const ordinaryBytes = source.ordinaryPayloadBytesBase64url === null ? null : bytes(source.ordinaryPayloadBytesBase64url);
  try {
    const payload = ordinaryBytes === null ? null : decodePayload(ordinaryBytes);
    return source.history.records.map(record => {
      const projection = record.protectedMessage.projection;
      const projectionSource = { role: projection.role,
        ...(projection.logicalMessageKey === undefined ? {} : { logicalMessageKey: projection.logicalMessageKey }),
        ...(projection.sourceUserId === undefined ? {} : { sourceUserId: projection.sourceUserId }),
        ...(projection.authorAgentId === undefined ? {} : { authorAgentId: projection.authorAgentId }) };
      if (record.protectedMessage.protectedPayload.status !== "encrypted") fail("key_waiting");
      const protectedMessage = { dtoVersion: 2 as const, projection: {
        ...projectionSource, messageId: projection.messageId, sessionId: projection.sessionId,
        roomId: projection.roomId, namespaceId: projection.namespaceId, createdAt: projection.createdAt,
        editRevision: projection.editRevision,
      }, protectedPayload: record.protectedMessage.protectedPayload };
      const common = { sessionId: record.coordinate.sessionId, messageId: String(record.coordinate.messageId),
        editRevision: record.coordinate.editRevision, protectedMessage };
      // Retain the independently selected attribution for the reader's cross-check.
      const originalSource = "representationMode" in record && record.representationMode === "protected-only"
        ? record.selectedSource : null;
      const representation = payload === null
        ? { representationMode: "protected-only" as const,
          selectedSource: originalSource === null ? fail("integrity") : {
            role: originalSource.role,
            ...(originalSource.logicalMessageKey === undefined ? {} : {logicalMessageKey: originalSource.logicalMessageKey}),
            ...(originalSource.sourceUserId === undefined ? {} : {sourceUserId: originalSource.sourceUserId}),
            ...(originalSource.authorAgentId === undefined ? {} : {authorAgentId: originalSource.authorAgentId}),
          } }
        : { representationMode: "ordinary-and-protected" as const,
          ordinarySibling: { payload, ...projectionSource }, ordinaryPayloadBytesBase64url: source.ordinaryPayloadBytesBase64url! };
      if (record.kind === "existing_representation") return { ...common, ...representation,
        kind: "existing_representation" as const, repair: record.repair.publisherKind === "human_device"
          ? record.repair : { ...record.repair, publisherKind: "foreground_runtime" as const },
        ...("retainedGeneration" in record && record.retainedGeneration !== undefined ? { retainedGeneration: record.retainedGeneration } : {}) };
      const retained = { namespaceGeneration: record.retainedGeneration.namespaceGeneration,
        namespaceAccessRevision: record.retainedGeneration.accessRevision,
        namespaceHeadDigestBase64url: record.retainedGeneration.headDigestBase64url,
        namespacePublicationDigestBase64url: record.retainedGeneration.publicationDigestBase64url,
        namespacePublicationSetDigestBase64url: record.retainedGeneration.publicationSetDigestBase64url,
        namespaceAudienceFingerprintBase64url: record.retainedGeneration.audienceFingerprintBase64url };
      if (record.kind === "human_edited_representation") return { ...common, ...retained,
        ...representation,
        kind: "human_edited_representation" as const, authorHumanId: record.authorHumanId,
        committerDeviceSigningPublicKeyBase64url: record.committerDeviceSigningPublicKeyBase64url };
      return { ...common, ...retained, ...representation, shadowOperationId: record.shadowOperationId,
        ...(record.shadowOperationFamily === undefined ? {} : { shadowOperationFamily: record.shadowOperationFamily }),
        shadowTranscriptOrdinal: record.shadowTranscriptOrdinal };
    });
  } finally { ordinaryBytes?.fill(0); }
}

/** Shared trusted body adapter; the scheduler receives only continuation state. */
export function createDeviceMessageBackfillClient(input: Readonly<{
  owner: EncryptionDataOperationOwner; api: DeviceMessageBackfillApiPort;
  namespaceAuthority: NamespaceAuthorityClient; vault: ClientProfileVault;
  coordinates: ClientProfileCoordinates; crypto: LatticeCrypto;
  historyReader: ForegroundRoomHistoryShadowMessageReader; now(): number; createId(): string;
}>) {
  let urgent: MessageBackfillUrgentSelection | undefined;
  const dual = <Value>(use: () => Promise<Value>): Promise<Value> => input.owner.runMutation({
    ordinary: () => Promise.reject(new ClassifiedDataOperationError("stale", "Message backfill is inactive")),
    protected: () => Promise.reject(new ClassifiedDataOperationError("stale", "Message backfill is inactive")),
    dual: use, classifyFailure: backfillFailure,
  });
  const active = (claim: MessageBackfillClaim, signal: AbortSignal) => {
    if (signal.aborted) fail("cancelled");
    if (claim.subjectHumanId !== input.coordinates.humanActorId || claim.deviceId !== input.coordinates.deviceId
      || input.historyReader.readerDeviceId !== claim.deviceId || claim.expiresAt <= claim.issuedAt
      || input.now() < claim.issuedAt || input.now() >= claim.expiresAt) fail("stale");
  };
  const retryStale = (claim?: MessageBackfillClaim): MessageBackfillBatchResult =>
    claim !== undefined && claim.expiresAt > input.now()
      ? {state: "waiting", resumeAt: claim.expiresAt}
      : {state: "more", resumeAt: input.now()};
  const afterAcknowledgement = (claim: MessageBackfillClaim, response: MessageBackfillAckResponse,
    outcome: MessageBackfillOutcome): MessageBackfillBatchResult => {
    if (response.status === "stale") return retryStale(claim);
    return {state: response.status, resumeAt: response.resumeAt,
      ...(outcome === "reconciled" ? {reconciled: true as const,
        reconciledSelection: {roomId: claim.coordinate.roomId,
          messageId: claim.coordinate.messageId, revision: claim.coordinate.revision}} : {})};
  };
  const withProfile = async <Value>(use: (profile: Awaited<ReturnType<typeof authenticateClientDeviceProfileV4>>) => Value | Promise<Value>) => {
    if ((await input.vault.availability()).status !== "available") fail("key_waiting");
    return input.vault.withOpenProfile(input.coordinates, async profileBytes => {
      const profile = await authenticateClientDeviceProfileV4({ crypto: input.crypto, profileBytes,
        expectedDeviceId: input.coordinates.deviceId });
      try { return await use(profile); } finally { destroyOpenedClientDeviceProfileV4(profile); }
    });
  };
  const acknowledge = (claim: MessageBackfillClaim, outcome: MessageBackfillOutcome,
    witness: Readonly<{ sourceDigestBase64url: string | null; manifestDigestBase64url: string | null }>, signal: AbortSignal) => dual(async () => {
    active(claim, signal);
    const signed = await withProfile(profile => {
      const claimDigest = messageBackfillClaimDigest(claim);
      const unsigned = { claimId: claim.claimId, outcome, claimDigestBase64url: base64url(claimDigest), ...witness };
      const digest = messageBackfillAcknowledgementDigest(unsigned);
      let signature: Uint8Array | undefined;
      try {
        signature = input.crypto.sign(profile.baseProfile.baseProfile.signingPrivateKey, digest);
        active(claim, signal);
        return { ...unsigned, signatureBase64url: base64url(signature) };
      } finally { claimDigest.fill(0); digest.fill(0); signature?.fill(0); }
    });
    active(claim, signal);
    return input.api.acknowledgeMessageBackfill(signed, {signal});
  });
  const source = (claim: MessageBackfillClaim, signal: AbortSignal) => dual(async () => {
    active(claim, signal);
    const value = await input.api.readMessageBackfillSource({ claimId: claim.claimId }, {signal});
    active(claim, signal);
    if (value.status !== "ordinary" && value.status !== "protected") return fail(value.status === "stale" ? "stale"
      : value.status === "integrity_failure" ? "integrity" : value.status === "unsupported" ? "unsupported" : "key_waiting");
    const expected = messageBackfillClaimDigest(claim);
    const actual = messageBackfillClaimDigest(value.claim);
    try { if (!equal(expected, actual)) fail("stale"); } finally { expected.fill(0); actual.fill(0); }
    return value;
  });
  const encrypt = (claim: MessageBackfillClaim, ordinary: Extract<MessageBackfillSourceResponse, { status: "ordinary" }>, signal: AbortSignal) => dual(async () => {
    active(claim, signal);
    const sourceBytes = bytes(ordinary.payloadBytesBase64url);
    const expectedDigest = bytes(ordinary.sourceDigestBase64url);
    const head = bytes(claim.namespaceHeadDigestBase64url);
    try {
      if (!equal(input.crypto.hash(sourceBytes), expectedDigest)) fail("integrity");
      const payload = decodePayload(sourceBytes);
      const canonical = encodeMessagePayloadV2(payload);
      try { if (!equal(sourceBytes, canonical) || payload.role !== claim.coordinate.role) fail("integrity"); }
      finally { canonical.fill(0); }
      const open = input.namespaceAuthority.withOpenedGenerations?.bind(input.namespaceAuthority);
      if (open === undefined) fail("unsupported");
      // Native V2 ensure/open may need this same non-reentrant profile vault
      // to receive a Domain key. Obtain Namespace custody before signing custody.
      const opened = await open({ sourceRoomId: claim.coordinate.roomId,
          subjectHumanId: claim.subjectHumanId, deviceSigningKeyGeneration: claim.deviceGeneration, keyClass: claim.keyClass,
          authority: [{ namespaceId: claim.coordinate.namespaceId, retainedGenerations: [{ generation: claim.namespaceKeyGeneration,
            accessRevision: claim.namespaceAccessRevision, headDigest: head, publicationDigest: head,
            publicationSetDigest: head, audienceFingerprint: head }] }],
          signal,
        }, generations => withProfile(profile => {
          const generation = generations.find(entry => entry.namespaceId === claim.coordinate.namespaceId
            && entry.keyClass === claim.keyClass && entry.generation === claim.namespaceKeyGeneration
            && entry.accessRevision === claim.namespaceAccessRevision && equal(entry.headDigest, head));
          if (generation === undefined) fail("key_waiting");
          active(claim, signal);
          const signing = profile.baseProfile.baseProfile;
          const common = { crypto: input.crypto, objectId: claim.cryptoObjectId, payload, createdAt: claim.createdAt,
            device: { deviceId: claim.deviceId, hostAuthorizationRevision: claim.hostAuthorizationRevision,
              signingPrivateKey: signing.signingPrivateKey }, resolveCurrentAuthorization: () => null };
          const namespace = { namespaceId: claim.coordinate.namespaceId, accessRevision: claim.namespaceAccessRevision,
            keyGeneration: claim.namespaceKeyGeneration };
          const prepared = claim.keyClass === "ai"
            ? prepareHumanExistingMessageRepresentationCryptoRevision({ ...common, namespace: { ...namespace, aiKey: generation.generationKey } })
            : prepareHumanPeerLiveShadowCryptoRevision({ ...common, namespace: { ...namespace, humanKey: generation.generationKey } });
          const snapshot = readPreparedConversationCryptoRevision(prepared);
          const envelope = snapshot.access.envelopeBytes[0]!;
          const request = prepareHumanExistingMessageRepresentationPublicationRequest(input.crypto, {
            subjectHumanId: humanId(claim.subjectHumanId), operationId: claim.operationId,
            sessionId: claim.coordinate.sessionId, roomId: claim.coordinate.roomId,
            messageId: claim.coordinate.messageId, revision: claim.coordinate.revision, createdAt: unixTimestamp(claim.createdAt),
            authorRole: claim.coordinate.role, authorHumanTurnId: claim.authorHumanTurnId,
            sessionAgentId: claim.sessionAgentId === null ? null : agentId(claim.sessionAgentId),
            cryptoObjectId: objectId(claim.cryptoObjectId), namespaceId: namespaceId(claim.coordinate.namespaceId),
            namespaceBindingHash: head, namespaceAccessRevision: claim.namespaceAccessRevision,
            namespaceKeyGeneration: claim.namespaceKeyGeneration, bindingRevisionAtWrap: claim.namespaceAccessRevision,
            ciphertextPayloadHash: input.crypto.hash(snapshot.object.payloadBytes.ciphertext), plaintextPayloadHash: expectedDigest,
            accessManifestHash: input.crypto.hash(snapshot.access.manifestBytes), envelopeHash: input.crypto.hash(envelope),
            issuedAt: unixTimestamp(claim.issuedAt), deadlineAt: unixTimestamp(claim.expiresAt),
            committerDeviceId: cryptoDeviceId(claim.deviceId), hostAuthorizationRevision: authorizationRevision(claim.hostAuthorizationRevision),
            committerSigningPublicKey: signing.signingPublicKey, committerSigningPrivateKey: signing.signingPrivateKey,
          });
          try {
            active(claim, signal);
            return { claimId: claim.claimId,
              requestBytesBase64url: base64url(request.bytes), payloadBytesBase64url: base64url(snapshot.object.payloadBytes.ciphertext),
              manifestBytesBase64url: base64url(snapshot.access.manifestBytes), envelopeBytesBase64url: base64url(envelope) };
          } finally { request.bytes.fill(0); snapshot.object.payloadBytes.ciphertext.fill(0);
            snapshot.access.manifestBytes.fill(0); snapshot.access.envelopeBytes.forEach(value => value.fill(0)); }
        }));
      if (opened.status !== "opened") fail("key_waiting");
      // Only the signed transport leaves both custody callbacks. Publication may
      // refresh device admission and must be able to reopen the profile vault.
      active(claim, signal);
      const published = await dual(() => input.api.publishMessageBackfill(opened.value, {signal}));
      if (published.status !== "published" && published.status !== "replayed") fail(published.status === "stale" ? "stale"
        : published.status === "integrity_failure" ? "integrity" : "key_waiting");
    } finally { sourceBytes.fill(0); expectedDigest.fill(0); head.fill(0); }
  });

  return Object.freeze({
    prioritize(coordinate: MessageBackfillUrgentSelection) {
      urgent = {roomId: coordinate.roomId, messageId: coordinate.messageId, revision: coordinate.revision};
    },
    async runBatch({ signal }: Readonly<{ signal: AbortSignal }>): Promise<MessageBackfillBatchResult> {
      let claim: MessageBackfillClaim | undefined;
      let observedFailure: MessageBackfillOutcome | undefined;
      try {
        return await input.owner.runMutation({ ordinary: () => Promise.resolve(waiting()), protected: () => Promise.resolve(waiting()), classifyFailure: backfillFailure, dual: async () => {
          if (signal.aborted) return waiting();
          const priority = urgent;
          const next = await input.api.nextMessageBackfill(priority === undefined ? {} : { urgent: priority }, {signal});
          if (signal.aborted) return waiting();
          if (urgent === priority) urgent = undefined;
          if (next.status === "prepare_authority") {
            const ensured = await dual(() => input.namespaceAuthority.ensure({ sourceRoomId: next.coordinate.roomId,
              namespaceId: next.coordinate.namespaceId, keyClass: next.keyClass,
              operationId: input.createId(), idempotencyKey: input.createId(), signal }));
            if (signal.aborted) return waiting();
            return { state: ensured.status === "ready" ? "more" as const : "waiting" as const, resumeAt: next.resumeAt };
          }
          if (next.status !== "claimed") {
            const resolvedSelection = next.resolvedSelection;
            return { state: next.status === "disabled" ? "waiting" as const : next.status,
              resumeAt: next.resumeAt,
              ...(resolvedSelection === undefined ? {} : {resolvedSelection}) };
          }
          claim = next.claim;
          active(claim, signal);
          let selected = await source(claim, signal);
          if (selected.status === "ordinary") {
            await encrypt(claim, selected, signal);
            selected = await source(claim, signal);
          }
          if (selected.status !== "protected") fail("key_waiting");
          const exact = selected;
          if (exact.history.status !== "ready" || exact.history.records.length !== 1) fail("key_waiting");
          const history = exact.history;
          const authority = history.authority;
          if (authority.subjectHumanId !== claim.subjectHumanId || authority.readerDeviceId !== claim.deviceId
            || authority.readerDeviceSigningKeyGeneration !== claim.deviceGeneration
            || authority.hostAuthorizationRevision !== claim.hostAuthorizationRevision
            || authority.policyRevision !== claim.policyRevision || authority.roomId !== claim.coordinate.roomId
            || authority.namespaceId !== claim.coordinate.namespaceId || authority.keyClass !== claim.keyClass
            || authority.namespaceAccessRevision !== claim.namespaceAccessRevision
            || authority.namespaceHeadDigestBase64url !== claim.namespaceHeadDigestBase64url
            || authority.domainId !== claim.domainId || authority.domainKeyGeneration !== claim.domainGeneration
            || authority.domainAuthorizationRevision !== claim.domainAuthorizationRevision
            || authority.domainHeadDigestBase64url !== claim.domainHeadDigestBase64url
            || authority.namespaceBundleRevision !== claim.namespaceBundleRevision
            || authority.namespaceBundleDigestBase64url !== claim.namespaceBundleDigestBase64url) fail("stale");
          const selectedRecord = history.records[0]!;
          const selectedPayload = selectedRecord.protectedMessage.protectedPayload;
          if (selectedPayload.status !== "encrypted" || selectedPayload.cryptoObjectId !== claim.cryptoObjectId
            || selectedPayload.keyClass !== claim.keyClass
            || Date.parse(selectedRecord.protectedMessage.projection.createdAt) !== claim.createdAt) fail("integrity");
          const coordinate = selectedRecord.coordinate;
          if (coordinate.logicalMessageKey !== claim.coordinate.logicalMessageKey || coordinate.sessionId !== claim.coordinate.sessionId || coordinate.messageId !== claim.coordinate.messageId
            || coordinate.editRevision !== claim.coordinate.revision || coordinate.role !== claim.coordinate.role) fail("integrity");
          const records = historyRecords(exact);
          const readInput = { sourceRoomId: claim.coordinate.roomId, authority: history.authority,
            ...(history.authorities === undefined ? {} : { authorities: history.authorities }), signerEvidence: history.signerEvidence, records,
            signal };
          let restored = false;
          const currentClaim = claim;
          const result = await input.owner.read<never, VaultRoomHistoryShadowReadResultV1, VaultRoomHistoryShadowReadResultV1>({
            ordinary: () => Promise.reject(new ClassifiedDataOperationError("key_waiting", "Ordinary backfill fallback is unavailable")),
            protected: () => dual(async () => { active(currentClaim, signal); return input.historyReader.reconcile(readInput); }),
            consumeOrdinary: () => fail("key_waiting"), consumeProtected: value => value,
            repair: { reverse: async value => {
              if (exact.ordinaryPayloadBytesBase64url !== null) return;
              if (value.records[0]?.status !== "verified") return;
              await dual(async () => {
                active(currentClaim, signal);
                await input.historyReader.acknowledge({ roomId: currentClaim.coordinate.roomId,
                  operationId: history.operationId, clientRequestKey: history.clientRequestKey,
                  policyRevision: history.authority.policyRevision, subjectHumanId: history.authority.subjectHumanId,
                  readerDeviceSigningKeyGeneration: history.authority.readerDeviceSigningKeyGeneration,
                  hostAuthorizationRevision: history.authority.hostAuthorizationRevision,
                  selectedCoordinateDigestBase64url: history.selectedCoordinateDigestBase64url,
                  selectedCoordinates: history.selectedCoordinates,
                  eligibleCoordinates: history.records.map(record => record.coordinate), eligibleRecords: records,
                  acknowledgement: history.acknowledgement, result: value, allowOrdinaryRepairs: true, signal });
                restored = true;
              });
            } },
          });
          const verified = result.value.records[0];
          if (verified?.status !== "verified") {
            observedFailure = verified?.reason === "parity_mismatch" ? "parity_mismatch"
              : verified?.reason === "integrity_failure" ? "integrity_failure" : "waiting_for_authority";
            fail(observedFailure === "waiting_for_authority" ? "key_waiting" : "integrity");
          }
          let sourceDigestBase64url: string | null = null;
          let manifestDigestBase64url: string | null = null;
          if (exact.ordinaryPayloadBytesBase64url !== null) {
            if (verified.verification !== "independent_parity" || exact.sourceDigestBase64url === null) fail("integrity");
            const ordinary = bytes(exact.ordinaryPayloadBytesBase64url);
            const decrypted = encodeMessagePayloadV2(verified.payload);
            const expected = bytes(exact.sourceDigestBase64url);
            try {
              if (!equal(ordinary, decrypted) || !equal(input.crypto.hash(ordinary), expected)) fail("integrity");
              sourceDigestBase64url = exact.sourceDigestBase64url;
            } finally { ordinary.fill(0); decrypted.fill(0); expected.fill(0); }
            const protectedPayload = history.records[0]!.protectedMessage.protectedPayload;
            if (protectedPayload.status !== "encrypted") fail("integrity");
            const manifest = bytes(protectedPayload.accessManifestBytesBase64url);
            try { manifestDigestBase64url = base64url(input.crypto.hash(manifest)); } finally { manifest.fill(0); }
          } else if (!restored) fail("key_waiting");
          const acknowledged = await acknowledge(currentClaim, "reconciled", { sourceDigestBase64url, manifestDigestBase64url }, signal);
          return afterAcknowledgement(currentClaim, acknowledged, "reconciled");
        } });
      } catch (error) {
        if (signal.aborted) return waiting();
        const failure = classifyDataOperationFailure(error);
        if (failure === "unknown") throw error;
        if (failure === "stale") {
          // Restricted authority or a Tool predecessor can change without changing
          // discovery coordinates. Do not repeatedly reoffer the same live lease.
          // Readiness hints may wake us earlier; expiry always permits a fresh claim.
          return retryStale(claim);
        }
        if (claim === undefined || failure === "cancelled") return waiting();
        const outcome = observedFailure ?? (failure === "integrity" ? "integrity_failure" : failure === "unsupported" ? "unsupported" : "waiting_for_authority");
        const acknowledged = await acknowledge(claim, outcome, { sourceDigestBase64url: null, manifestDigestBase64url: null }, signal);
        return afterAcknowledgement(claim, acknowledged, outcome);
      }
    },
  });
}
