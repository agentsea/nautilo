import {
  mintDomainForegroundAuthorization,
  objectId as cryptoObjectId,
  prepareForegroundSessionHumanLiveShadowMessageRequest,
  type LatticeCrypto,
  type DomainForegroundSecretEntry,
} from "@nautilo/lattice-crypto";
import {
  decodeLiveShadowMessagePlanV4,
  destroyDomainForegroundAuthorizationPlanV2,
  destroyDomainForegroundAuthorizationV2,
  encodeLiveShadowMessagePlanV4,
  parseDomainForegroundAuthorizationPlanV2,
  serializeDomainForegroundAuthorizationV2,
} from "@nautilo/lattice-crypto/wire";

import {
  authenticateClientDeviceProfileV4,
  destroyOpenedClientDeviceProfileV4,
} from "../../client-vault/profile-v4.ts";
import type {
  ClientProfileCoordinates,
  ClientProfileVault,
} from "../../client-vault/types.ts";
import { deriveLiveShadowMessageCryptoObjectIdV1 } from
  "../../message/conversation-repository.ts";
import {
  prepareHumanExistingMessageRepresentationCryptoRevision,
} from "../../message/human-existing-message-representation-crypto.ts";
import {
  encodeMessagePayloadV2,
  type MessagePayloadV2,
} from "../../message/message-payload-v2.ts";
import {
  readPreparedConversationCryptoRevisionSnapshot,
} from "../../message/conversation-prepared-revision.ts";
import type { DomainForegroundAuthorityClientV2 } from
  "./domain-foreground-authority-client.ts";

export interface PreparedHumanLiveShadowMessageV1 {
  readonly normalizedContent: string;
  readonly planBytes: Uint8Array;
  readonly requestBytes: Uint8Array;
  readonly encryptedPayloadBytes: Uint8Array;
  readonly accessManifestBytes: Uint8Array;
  readonly namespaceEnvelopeBytes: Uint8Array;
  readonly requestDigest: Uint8Array;
  readonly grantBytes: Uint8Array;
  readonly authorizationScheme?: "foreground_session_v1";
}

export type PrepareVaultHumanLiveShadowMessageResultV1 =
  | Readonly<{ status: "prepared"; value: PreparedHumanLiveShadowMessageV1 }>
  | Readonly<{
      status: "unavailable";
      reason:
        | "profile_unavailable"
        | "profile_invalid"
        | "plan_stale"
        | "namespace_unavailable"
        | "domain_unavailable"
        | "content_invalid";
    }>;

export interface PrepareVaultHumanLiveShadowMessageInputV1 {
  readonly crypto: LatticeCrypto;
  readonly vault: ClientProfileVault;
  readonly coordinates: ClientProfileCoordinates;
  readonly planBytes: Uint8Array;
  readonly normalizedContent: string;
  readonly now: number;
}

export interface PrepareVaultHumanLiveShadowMessageInputV4
  extends PrepareVaultHumanLiveShadowMessageInputV1 {
  readonly domainForegroundAuthority: DomainForegroundAuthorityClientV2;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function unavailable(
  reason: Extract<PrepareVaultHumanLiveShadowMessageResultV1, { status: "unavailable" }>["reason"],
): PrepareVaultHumanLiveShadowMessageResultV1 {
  return Object.freeze({ status: "unavailable", reason });
}

function copyPrepared(
  value: PreparedHumanLiveShadowMessageV1,
): PreparedHumanLiveShadowMessageV1 {
  return Object.freeze({
    ...value,
    planBytes: value.planBytes.slice(),
    requestBytes: value.requestBytes.slice(),
    grantBytes: value.grantBytes.slice(),
    encryptedPayloadBytes: value.encryptedPayloadBytes.slice(),
    accessManifestBytes: value.accessManifestBytes.slice(),
    namespaceEnvelopeBytes: value.namespaceEnvelopeBytes.slice(),
    requestDigest: value.requestDigest.slice(),
  });
}

/** Prepare one short Human operation under a reusable M294 foreground session. */
export async function prepareVaultHumanLiveShadowMessageV4(
  input: PrepareVaultHumanLiveShadowMessageInputV4,
): Promise<PrepareVaultHumanLiveShadowMessageResultV1> {
  let plan;
  try {
    plan = decodeLiveShadowMessagePlanV4(input.planBytes);
  } catch {
    return unavailable("plan_stale");
  }
  let domainAuthorizationPlan = plan.authorization.disposition
      === "authorization_required"
    ? parseDomainForegroundAuthorizationPlanV2(
      plan.authorization.authorizationPlanBytes,
    )
    : null;
  try {
    if (
      !Number.isSafeInteger(input.now)
      || input.now < plan.issuedAt
      || input.now >= plan.deadlineAt
      || plan.committerDeviceId !== input.coordinates.deviceId
      || typeof input.normalizedContent !== "string"
      || input.normalizedContent.length < 1
      || (
        plan.authorization.disposition === "authorization_required"
        && (
          domainAuthorizationPlan === null
          || domainAuthorizationPlan.authorizationId
            !== plan.authorization.authorizationId
          || domainAuthorizationPlan.sessionId !== plan.sessionId
          || domainAuthorizationPlan.roomId !== plan.roomId
          || domainAuthorizationPlan.subjectHumanId
            !== plan.subjectHumanId
          || domainAuthorizationPlan.committerDeviceId
            !== plan.committerDeviceId
          || domainAuthorizationPlan.recipientPrincipalId
            !== plan.recipientAgentId
          || domainAuthorizationPlan?.recipientKind === "runtime"
          || domainAuthorizationPlan.recipientKeyId
            !== plan.authorization.recipientKeyId
          || !equalBytes(
            input.crypto.hash(plan.authorization.authorizationPlanBytes),
            plan.authorization.authorizationPlanDigest,
          )
        )
      )
    ) return unavailable("plan_stale");
    const available = await input.vault.availability();
    if (
      available.status !== "available"
      && (await input.vault.unlock()).status !== "available"
    ) return unavailable("profile_unavailable");

    const prepareWithRoomKey = async (
      roomNamespaceKey: Uint8Array,
      domains: readonly DomainForegroundSecretEntry[] | null,
    ): Promise<PrepareVaultHumanLiveShadowMessageResultV1> =>
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
        let payloadBytes: Uint8Array | undefined;
        let authorizationBytes: Uint8Array | undefined;
        let canonicalPlanBytes: Uint8Array | undefined;
        try {
          if (
            base.deviceId !== plan.committerDeviceId
            || base.trustedHostAuthorizationRevision
              !== plan.hostAuthorizationRevision
          ) return unavailable("plan_stale");
          const derivedObjectId = deriveLiveShadowMessageCryptoObjectIdV1({
            operationId: plan.operationId,
            sessionId: plan.sessionId,
            messageId: plan.humanMessageId,
            revision: plan.revision,
            transcriptOrdinal: 1,
            authorRole: "user",
          });
          const payload: MessagePayloadV2 = Object.freeze({
            role: "user",
            content: input.normalizedContent,
          });
          payloadBytes = encodeMessagePayloadV2(payload);
          const preparedRevision =
            prepareHumanExistingMessageRepresentationCryptoRevision({
              crypto: input.crypto,
              objectId: derivedObjectId,
              payload,
              createdAt: plan.createdAt,
              namespace: {
                namespaceId: plan.namespaceId,
                accessRevision: plan.namespaceAccessRevision,
                keyGeneration: plan.namespaceKeyGeneration,
                aiKey: roomNamespaceKey,
              },
              device: {
                deviceId: plan.committerDeviceId,
                hostAuthorizationRevision: plan.hostAuthorizationRevision,
                signingPrivateKey: base.signingPrivateKey,
              },
              resolveCurrentAuthorization: (context) => Object.freeze({
                ...context,
                sourceAuthorized: true,
                targetAuthorized: true,
                currentHostAuthorizationRevision:
                  plan.hostAuthorizationRevision,
                committerSigningPublicKey: base.signingPublicKey.slice(),
              }),
            });
          const snapshot = readPreparedConversationCryptoRevisionSnapshot(
            preparedRevision,
          );
          if (snapshot.kind !== "human-v2") {
            throw new TypeError("Live Shadow Human preparation kind disagrees");
          }
          const encryptedPayloadBytes = snapshot.value.object.payloadBytes.ciphertext;
          const accessManifestBytes = snapshot.value.access.manifestBytes;
          const namespaceEnvelopeBytes = snapshot.value.access.envelopeBytes[0];
          if (namespaceEnvelopeBytes === undefined) {
            throw new TypeError("Live Shadow Human Namespace envelope is absent");
          }
          let authorization;
          if (plan.authorization.disposition === "authorization_required") {
            if (
              domainAuthorizationPlan === null || domains === null
            ) {
              throw new TypeError("Foreground authorization authority is absent");
            }
            const minted = await mintDomainForegroundAuthorization(
              input.crypto,
              {
                plan: domainAuthorizationPlan,
                domains,
                committerDeviceSigningPrivateKey: base.signingPrivateKey,
                recipientEncryptionPublicKey:
                  plan.authorization.recipientPublicKey,
              },
            );
            try {
              authorizationBytes =
                serializeDomainForegroundAuthorizationV2(minted);
            } finally {
              destroyDomainForegroundAuthorizationV2(minted);
            }
            authorization = Object.freeze({
              kind: "establish" as const,
              authorizationBytes,
              authorizationDigest: input.crypto.hash(authorizationBytes),
            });
          } else {
            authorization = Object.freeze({
              kind: "reuse" as const,
              sessionReference: plan.authorization.sessionReference,
              authorizationDigest: plan.authorization.authorizationDigest,
            });
          }
          canonicalPlanBytes = encodeLiveShadowMessagePlanV4(plan);
          const request = prepareForegroundSessionHumanLiveShadowMessageRequest(
            input.crypto,
            {
              subjectHumanId: plan.subjectHumanId,
              operationId: plan.operationId,
              policyRevision: plan.policyRevision,
              sessionId: plan.sessionId,
              roomId: plan.roomId,
              messageId: plan.humanMessageId,
              revision: 0,
              createdAt: plan.createdAt,
              recipientAgentId: plan.recipientAgentId,
              agentAuthorizationRevision: plan.agentAuthorizationRevision,
              cryptoObjectId: cryptoObjectId(derivedObjectId),
              namespaceId: plan.namespaceId,
              namespaceAccessRevision: plan.namespaceAccessRevision,
              namespaceKeyGeneration: plan.namespaceKeyGeneration,
              namespaceHeadDigest: plan.namespaceHeadDigest,
              namespacePublicationDigest: plan.namespacePublicationDigest,
              namespacePublicationSetDigest:
                plan.namespacePublicationSetDigest,
              namespaceAudienceFingerprint:
                plan.namespaceAudienceFingerprint,
              authorization,
              planDigest: input.crypto.hash(canonicalPlanBytes),
              plaintextPayloadDigest: input.crypto.hash(payloadBytes),
              encryptedPayloadDigest: input.crypto.hash(encryptedPayloadBytes),
              manifestDigest: input.crypto.hash(accessManifestBytes),
              envelopeDigest: input.crypto.hash(namespaceEnvelopeBytes),
              issuedAt: plan.issuedAt,
              deadlineAt: plan.deadlineAt,
              committerDeviceId: plan.committerDeviceId,
              committerDeviceSigningKeyGeneration:
                plan.committerDeviceSigningKeyGeneration,
              hostAuthorizationRevision: plan.hostAuthorizationRevision,
              committerSigningPublicKey: base.signingPublicKey,
              committerSigningPrivateKey: base.signingPrivateKey,
            },
          );
          return Object.freeze({
            status: "prepared" as const,
            value: copyPrepared({
              normalizedContent: input.normalizedContent,
              planBytes: canonicalPlanBytes,
              requestBytes: request.bytes,
              grantBytes: new Uint8Array(0),
              authorizationScheme: "foreground_session_v1",
              encryptedPayloadBytes,
              accessManifestBytes,
              namespaceEnvelopeBytes,
              requestDigest: request.requestDigest,
            }),
          });
        } finally {
          payloadBytes?.fill(0);
          authorizationBytes?.fill(0);
          canonicalPlanBytes?.fill(0);
          destroyOpenedClientDeviceProfileV4(profile);
        }
      });

    if (plan.authorization.disposition === "authorization_required") {
      if (domainAuthorizationPlan === null) return unavailable("plan_stale");
      const opened = await input.domainForegroundAuthority
        .withOpenedTurnAuthority({
          sourceRoomId: plan.roomId,
          namespaceId: plan.namespaceId,
          namespaceAccessRevision: plan.namespaceAccessRevision,
          namespaceKeyGeneration: plan.namespaceKeyGeneration,
          namespaceHeadDigest: plan.namespaceHeadDigest,
          domains: domainAuthorizationPlan.domains,
        }, (authority) => prepareWithRoomKey(
          authority.roomNamespaceKey,
          authority.domains,
        ));
      return opened.status === "opened"
        ? opened.value
        : unavailable("domain_unavailable");
    }
    const opened = await input.domainForegroundAuthority
      .withOpenedReusableTurnRoomKey({
        sourceRoomId: plan.roomId,
        namespaceId: plan.namespaceId,
        namespaceAccessRevision: plan.namespaceAccessRevision,
        namespaceKeyGeneration: plan.namespaceKeyGeneration,
        namespaceHeadDigest: plan.namespaceHeadDigest,
      }, (roomNamespaceKey) => prepareWithRoomKey(roomNamespaceKey, null));
    return opened.status === "opened"
      ? opened.value
      : unavailable("domain_unavailable");
  } catch {
    return unavailable("domain_unavailable");
  } finally {
    if (domainAuthorizationPlan !== null) {
      destroyDomainForegroundAuthorizationPlanV2(domainAuthorizationPlan);
      domainAuthorizationPlan = null;
    }
    destroyForegroundSessionPlanBytes(plan);
  }
}

function destroyForegroundSessionPlanBytes(
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
