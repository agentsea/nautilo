import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  decodeHumanMessageEditPlanV1,
  deriveHumanMessageEditCryptoObjectIdV1,
  prepareHumanMessageEditRequestV1,
} from "@nautilo/lattice-crypto/wire";

import {
  authenticateClientDeviceProfileV4,
  destroyOpenedClientDeviceProfileV4,
} from "../../client-vault/profile-v4.ts";
import type {
  ClientProfileCoordinates,
  ClientProfileVault,
} from "../../client-vault/types.ts";
import {
  prepareHumanExistingMessageRepresentationCryptoRevision,
  prepareHumanPeerLiveShadowCryptoRevision,
} from "../../message/human-existing-message-representation-crypto.ts";
import { encodeMessagePayloadV2 } from "../../message/message-payload-v2.ts";
import { readPreparedConversationCryptoRevisionSnapshot } from "../../message/conversation-prepared-revision.ts";
import type { NamespaceAuthorityClient } from "./namespace-authority-client.ts";

export type PreparedVaultHumanMessageEdit = Readonly<{
  operationId: string;
  planBytes: Uint8Array;
  requestBytes: Uint8Array;
  targets: readonly Readonly<{
    sessionId: string;
    messageId: number;
    encryptedPayloadBytes: Uint8Array;
    accessManifestBytes: Uint8Array;
    namespaceEnvelopeBytes: Uint8Array;
  }>[];
}>;

export type PrepareVaultHumanMessageEditResult =
  | Readonly<{ status: "prepared"; value: PreparedVaultHumanMessageEdit }>
  | Readonly<{ status: "unavailable"; reason: string }>;

const unavailable = (reason: string): PrepareVaultHumanMessageEditResult =>
  Object.freeze({ status: "unavailable", reason });

const same = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

export async function prepareVaultHumanMessageEdit(
  input: Readonly<{
    crypto: LatticeCrypto;
    vault: ClientProfileVault;
    coordinates: ClientProfileCoordinates;
    namespaceAuthority: NamespaceAuthorityClient;
    planBytes: Uint8Array;
    roomId: string;
    messageId: number;
    expectedRevision: number;
    normalizedContent: string;
    now: number;
  }>,
): Promise<PrepareVaultHumanMessageEditResult> {
  let plan;
  try {
    plan = decodeHumanMessageEditPlanV1(input.planBytes);
  } catch {
    return unavailable("plan_invalid");
  }
  if (
    plan.roomId !== input.roomId ||
    plan.subjectHumanId !== input.coordinates.humanActorId ||
    plan.committerDeviceId !== input.coordinates.deviceId ||
    input.now < plan.issuedAt ||
    input.now >= plan.deadlineAt ||
    !plan.targets.some(
      (target) =>
        target.messageId === input.messageId &&
        target.expectedRevision === input.expectedRevision,
    ) ||
    plan.targets.some(
      (target) => target.expectedRevision !== input.expectedRevision,
    ) ||
    plan.targets.some(
      (target) => target.cryptoObjectId !== deriveHumanMessageEditCryptoObjectIdV1({
        operationId: plan.operationId,
        sessionId: target.sessionId,
        messageId: target.messageId,
        revision: target.nextRevision,
      }),
    ) ||
    plan.targets.some(
      (target) =>
        target.keyClass !==
        (plan.authorizationScheme === "human_peer_v1" ? "human" : "ai"),
    ) ||
    input.normalizedContent.length < 1 ||
    input.namespaceAuthority.withOpenedGenerations === undefined
  )
    return unavailable("plan_stale");
  const authorityByNamespace = new Map<string, {
    namespaceId: string;
    retainedGenerations: Array<{
      generation: number;
      accessRevision: number;
      headDigest: Uint8Array;
      publicationDigest: Uint8Array;
      publicationSetDigest: Uint8Array;
      audienceFingerprint: Uint8Array;
    }>;
  }>();
  for (const target of plan.targets) {
    const authority = authorityByNamespace.get(target.namespaceId) ?? {
      namespaceId: target.namespaceId,
      retainedGenerations: [],
    };
    const retained = authority.retainedGenerations.find((candidate) =>
      candidate.generation === target.namespaceKeyGeneration
      && candidate.accessRevision === target.namespaceAccessRevision
    );
    if (retained !== undefined) {
      if (!same(retained.headDigest, target.namespaceHeadDigest)
        || !same(retained.publicationDigest, target.namespacePublicationDigest)
        || !same(retained.publicationSetDigest,
          target.namespacePublicationSetDigest)
        || !same(retained.audienceFingerprint,
          target.namespaceAudienceFingerprint)) return unavailable("plan_stale");
      continue;
    }
    authority.retainedGenerations.push({
      generation: target.namespaceKeyGeneration,
      accessRevision: target.namespaceAccessRevision,
      headDigest: target.namespaceHeadDigest,
      publicationDigest: target.namespacePublicationDigest,
      publicationSetDigest: target.namespacePublicationSetDigest,
      audienceFingerprint: target.namespaceAudienceFingerprint,
    });
    authorityByNamespace.set(target.namespaceId, authority);
  }
  const available = await input.vault.availability();
  if (
    available.status !== "available" &&
    (await input.vault.unlock()).status !== "available"
  )
    return unavailable("profile_unavailable");

  const opened = await input.namespaceAuthority.withOpenedGenerations(
    {
      sourceRoomId: plan.roomId,
      subjectHumanId: plan.subjectHumanId,
      deviceSigningKeyGeneration: plan.committerDeviceSigningKeyGeneration,
      keyClass: plan.authorizationScheme === "human_peer_v1" ? "human" : "ai",
      authority: [...authorityByNamespace.values()],
    },
    async (generations) =>
      input.vault.withOpenProfile(input.coordinates, async (profileBytes) => {
        let profile;
        try {
          profile = await authenticateClientDeviceProfileV4({
            crypto: input.crypto,
            profileBytes,
            expectedDeviceId: plan.committerDeviceId,
          });
        } catch {
          return unavailable("profile_invalid");
        }
        const base = profile.baseProfile.baseProfile;
        const preparedTargets: Array<
          PreparedVaultHumanMessageEdit["targets"][number]
        > = [];
        let completed = false;
        try {
          if (
            base.trustedHostAuthorizationRevision !==
            plan.hostAuthorizationRevision
          )
            return unavailable("plan_stale");
          const signedTargets = [];
          for (const target of plan.targets) {
            const generation = generations.find(
              (candidate) =>
                candidate.keyClass === target.keyClass &&
                candidate.namespaceId === target.namespaceId &&
                candidate.generation === target.namespaceKeyGeneration &&
                candidate.accessRevision === target.namespaceAccessRevision &&
                same(candidate.headDigest, target.namespaceHeadDigest) &&
                same(
                  candidate.audienceFingerprint,
                  target.namespaceAudienceFingerprint,
                ),
            );
            if (generation === undefined)
              return unavailable("namespace_unavailable");
            const payload = Object.freeze({
              role: "user" as const,
              content: input.normalizedContent,
            });
            const prepared =
              target.keyClass === "human"
                ? prepareHumanPeerLiveShadowCryptoRevision({
                    crypto: input.crypto,
                    objectId: target.cryptoObjectId,
                    payload,
                    createdAt: target.createdAt,
                    namespace: {
                      namespaceId: target.namespaceId,
                      accessRevision: target.namespaceAccessRevision,
                      keyGeneration: target.namespaceKeyGeneration,
                      humanKey: generation.generationKey,
                    },
                    device: {
                      deviceId: plan.committerDeviceId,
                      hostAuthorizationRevision: plan.hostAuthorizationRevision,
                      signingPrivateKey: base.signingPrivateKey,
                    },
                    resolveCurrentAuthorization: (context) => ({
                      ...context,
                      sourceAuthorized: true,
                      targetAuthorized: true,
                      currentHostAuthorizationRevision:
                        plan.hostAuthorizationRevision,
                      committerSigningPublicKey: base.signingPublicKey.slice(),
                    }),
                  })
                : prepareHumanExistingMessageRepresentationCryptoRevision({
                    crypto: input.crypto,
                    objectId: target.cryptoObjectId,
                    payload,
                    createdAt: target.createdAt,
                    namespace: {
                      namespaceId: target.namespaceId,
                      accessRevision: target.namespaceAccessRevision,
                      keyGeneration: target.namespaceKeyGeneration,
                      aiKey: generation.generationKey,
                    },
                    device: {
                      deviceId: plan.committerDeviceId,
                      hostAuthorizationRevision: plan.hostAuthorizationRevision,
                      signingPrivateKey: base.signingPrivateKey,
                    },
                    resolveCurrentAuthorization: (context) => ({
                      ...context,
                      sourceAuthorized: true,
                      targetAuthorized: true,
                      currentHostAuthorizationRevision:
                        plan.hostAuthorizationRevision,
                      committerSigningPublicKey: base.signingPublicKey.slice(),
                    }),
                  });
            const snapshot =
              readPreparedConversationCryptoRevisionSnapshot(prepared);
            if (snapshot.kind !== "human-v2") {
              return unavailable("preparation_failed");
            }
            const envelope = snapshot.value.access.envelopeBytes[0];
            const encrypted = snapshot.value.object.payloadBytes.ciphertext;
            const manifest = snapshot.value.access.manifestBytes;
            if (envelope === undefined) {
              encrypted.fill(0);
              manifest.fill(0);
              return unavailable("preparation_failed");
            }
            const plaintext = encodeMessagePayloadV2(payload);
            preparedTargets.push(
              Object.freeze({
                sessionId: target.sessionId,
                messageId: target.messageId,
                encryptedPayloadBytes: encrypted,
                accessManifestBytes: manifest,
                namespaceEnvelopeBytes: envelope,
              }),
            );
            try {
              signedTargets.push(
                Object.freeze({
                  ...target,
                  plaintextPayloadDigest: input.crypto.hash(plaintext),
                  encryptedPayloadDigest: input.crypto.hash(encrypted),
                  manifestDigest: input.crypto.hash(manifest),
                  envelopeDigest: input.crypto.hash(envelope),
                }),
              );
            } finally {
              plaintext.fill(0);
            }
          }
          const signed = prepareHumanMessageEditRequestV1(input.crypto, {
            operationId: plan.operationId,
            clientIdempotencyKey: plan.clientIdempotencyKey,
            authorizationScheme: plan.authorizationScheme,
            policyRevision: plan.policyRevision,
            roomId: plan.roomId,
            subjectHumanId: plan.subjectHumanId,
            committerDeviceId: plan.committerDeviceId,
            committerDeviceSigningKeyGeneration:
              plan.committerDeviceSigningKeyGeneration,
            hostAuthorizationRevision: plan.hostAuthorizationRevision,
            planDigest: input.crypto.hash(input.planBytes),
            targets: signedTargets,
            issuedAt: plan.issuedAt,
            deadlineAt: plan.deadlineAt,
            committerSigningPublicKey: base.signingPublicKey,
            committerSigningPrivateKey: base.signingPrivateKey,
          });
          const result = Object.freeze({
            status: "prepared" as const,
            value: Object.freeze({
              operationId: plan.operationId,
              planBytes: input.planBytes.slice(),
              requestBytes: signed.bytes,
              targets: Object.freeze(preparedTargets),
            }),
          });
          completed = true;
          return result;
        } catch {
          return unavailable("preparation_failed");
        } finally {
          if (!completed) {
            for (const target of preparedTargets) {
              target.encryptedPayloadBytes.fill(0);
              target.accessManifestBytes.fill(0);
              target.namespaceEnvelopeBytes.fill(0);
            }
          }
          destroyOpenedClientDeviceProfileV4(profile);
        }
      }),
  );
  return opened.status === "opened" ? opened.value : unavailable(opened.reason);
}
