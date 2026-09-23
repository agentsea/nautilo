import type {
  DeviceAdmissionStatus,
  DualTaskPreparedCreateRequestV1,
  DualTaskPreparedUpdateRequestV1,
  ProtectedTaskPreparedCreateRequestV1,
  ProtectedTaskPreparedUpdateRequestV1,
} from "@nautilo/api-client/browser";
import {
  LatticeCrypto,
  accessRevision,
  authorizationRevision,
  cryptoDeviceId,
  decryptObjectThroughNamespace,
  encryptObjectPayload,
  humanId,
  namespaceGeneration,
  namespaceId,
  objectId,
  prepareHumanObjectAccessManifestGenesisSet,
  prepareHumanTaskPublicationRequest,
  unixTimestamp,
  verifyCommonObjectAccessManifest,
  wrapObjectDekForNamespace,
  type TrustedMinimumObjectAccessHead,
} from "@nautilo/lattice-crypto";
import {
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
  decodeObjectAccessManifestV5,
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
  encodeObjectAccessManifestV5,
} from "@nautilo/lattice-crypto/wire";

import {
  authenticateClientDeviceProfileV4,
  destroyOpenedClientDeviceProfileV4,
  withClientObjectAccessSignerResolversV4,
} from "../../client-vault/profile-v4.ts";
import type {
  ClientProfileCoordinates,
  ClientProfileVault,
} from "../../client-vault/types.ts";
import { withClientNamespaceKeyring } from
  "../../device/client-namespace-keyring.ts";
import {
  deriveTaskContentCryptoObjectIdV1,
  TASK_DEFINITION_OBJECT_TYPE_V1,
} from "../../task/task-content-repository.ts";
import { encodeTaskPayloadV1 } from "../../task/task-payload-v1.ts";
import {
  fingerprintTaskDualPublicationFieldsV1,
  fingerprintTaskOperationalFieldsV1,
} from
  "../../task/task-operational-fields-digest-v1.ts";
import {
  ClassifiedDataOperationError,
} from "../../transition/encryption-data-operation-owner.ts";
import type {
  HumanTaskDeviceContentPortV1,
} from "./authorized-human-task-client.ts";

const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const SIGNED_REQUEST_TTL_MS = 30_000;

type HumanSignerEvidence = Readonly<{
  kind: "human_device";
  subjectHumanId: string;
  committerDeviceId: string;
  hostAuthorizationRevision: number;
  signingPublicKeyBase64url: string;
}>;

export interface VaultHumanTaskDeviceContentInputV1 {
  readonly crypto: LatticeCrypto;
  readonly vault: ClientProfileVault;
  readonly coordinates: ClientProfileCoordinates;
  readonly subjectHumanId: string;
  readonly now: () => number;
  readonly resolveDeviceAdmissionStatus: () => Promise<DeviceAdmissionStatus>;
  readonly accessAnchors: Readonly<{
    load(objectId: string): Promise<TrustedMinimumObjectAccessHead | null>;
    advance(input: Readonly<{
      expected: TrustedMinimumObjectAccessHead | null;
      next: TrustedMinimumObjectAccessHead;
    }>): Promise<boolean>;
  }>;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function toBase64url(value: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < value.length; offset += 0x8000) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function fromBase64url(label: string, value: string): Uint8Array {
  if (!BASE64URL.test(value) || value.length % 4 === 1) {
    throw new TypeError(`${label} is not canonical base64url`);
  }
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/")
    + "=".repeat((4 - value.length % 4) % 4));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (toBase64url(bytes) !== value) {
    bytes.fill(0);
    throw new TypeError(`${label} is not canonical base64url`);
  }
  return bytes;
}

function exactHumanSignerEvidenceKey(
  envelope: Parameters<HumanTaskDeviceContentPortV1["openExact"]>[0]["envelope"],
  signer: Readonly<{ subjectHumanId: string; committerDeviceId: string }>,
  hostAuthorizationRevision: number,
): Uint8Array | undefined {
  const evidence = envelope.signerEvidence.filter(
    (entry): entry is HumanSignerEvidence =>
      typeof entry === "object"
      && entry !== null
      && !Array.isArray(entry)
      && (entry as Partial<HumanSignerEvidence>).kind === "human_device",
  );
  if (envelope.signerEvidence.length !== 1 || evidence.length !== 1) {
    return undefined;
  }
  const entry = evidence[0]!;
  if (
    entry.subjectHumanId !== signer.subjectHumanId
    || entry.committerDeviceId !== signer.committerDeviceId
    || entry.hostAuthorizationRevision !== hostAuthorizationRevision
    || typeof entry.signingPublicKeyBase64url !== "string"
  ) return undefined;
  const key = fromBase64url(
    "Protected Task Human signer key",
    entry.signingPublicKeyBase64url,
  );
  if (key.length === 32) return key;
  key.fill(0);
  return undefined;
}

async function withProfile<Value>(
  input: VaultHumanTaskDeviceContentInputV1,
  operation: (
    profile: Awaited<ReturnType<typeof authenticateClientDeviceProfileV4>>,
    admission: Extract<DeviceAdmissionStatus, { status: "admitted" }>,
  ) => Promise<Value>,
): Promise<Value> {
  let availability = await input.vault.availability();
  if (availability.status === "locked") availability = await input.vault.unlock();
  if (availability.status !== "available") {
    throw new ClassifiedDataOperationError(
      "key_waiting",
      `Protected Task device custody is unavailable (${availability.status})`,
    );
  }
  const admission = await input.resolveDeviceAdmissionStatus();
  if (
    admission.status !== "admitted"
    || admission.deviceId !== input.coordinates.deviceId
    || admission.expiresAt <= input.now()
  ) {
    throw new ClassifiedDataOperationError(
      "key_waiting",
      "Protected Task device admission is unavailable",
    );
  }
  return input.vault.withOpenProfile(input.coordinates, async (profileBytes) => {
    const profile = await authenticateClientDeviceProfileV4({
      crypto: input.crypto,
      profileBytes,
      expectedDeviceId: input.coordinates.deviceId,
    });
    try {
      return await operation(profile, admission);
    } finally {
      destroyOpenedClientDeviceProfileV4(profile);
    }
  });
}

/** Vault-backed Task content preparation/opening shared by Browser and Electron. */
export function createVaultHumanTaskDeviceContentPortV1(
  dependencies: VaultHumanTaskDeviceContentInputV1,
): HumanTaskDeviceContentPortV1 {
  const prepare = async (
    operation: "create" | "update",
    input: Parameters<HumanTaskDeviceContentPortV1["prepareCreate"]>[0]
      | Parameters<HumanTaskDeviceContentPortV1["prepareUpdate"]>[0],
    representation: "protected" | "dual",
  ): Promise<ProtectedTaskPreparedCreateRequestV1
    | ProtectedTaskPreparedUpdateRequestV1
    | DualTaskPreparedCreateRequestV1
    | DualTaskPreparedUpdateRequestV1> => withProfile(
      dependencies,
      async (profileV4) => {
    const profile = profileV4.baseProfile.baseProfile;
    const { plan } = input;
    const now = dependencies.now();
    if (plan.authority.requesterHumanId !== dependencies.subjectHumanId) {
      throw new ClassifiedDataOperationError(
        "authority",
        "Protected Task publication authority belongs to another Human",
      );
    }
    const cryptoObjectId = deriveTaskContentCryptoObjectIdV1({
      kind: "definition",
      taskId: plan.taskId,
      contentRevision: plan.nextContentRevision,
    });
    let plaintext: Uint8Array | undefined;
    let dek: Uint8Array | undefined;
    let payloadBytes: Uint8Array | undefined;
    let envelopeBytes: Uint8Array | undefined;
    let manifestBytes: Uint8Array | undefined;
    let signedBytes: Uint8Array | undefined;
    let planDigest: Uint8Array | undefined;
    let bindingHash: Uint8Array | undefined;
    let operationalFieldsDigest: Uint8Array | undefined;
    try {
      plaintext = encodeTaskPayloadV1(input.payload);
      const encrypted = encryptObjectPayload(dependencies.crypto, {
        objectId: objectId(cryptoObjectId),
        keyClass: "ai",
        objectType: TASK_DEFINITION_OBJECT_TYPE_V1,
        createdAt: unixTimestamp(now),
      }, plaintext);
      dek = encrypted.dek;
      payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
      bindingHash = fromBase64url(
        "Protected Task Namespace binding hash",
        plan.authority.bindingHashBase64url,
      );
      envelopeBytes = await withClientNamespaceKeyring({
        profile,
        namespaceId: plan.authority.namespaceId,
        keyClass: "ai",
        requiredAccessRevision: plan.authority.expectedAccessRevision,
        requiredGeneration: plan.authority.keyGeneration,
        operation: (keyring) => {
          if (
            keyring.domainId !== plan.authority.domainId
            || keyring.accessRevision !== plan.authority.expectedAccessRevision
            || keyring.currentGeneration !== plan.authority.keyGeneration
            || !equalBytes(keyring.bindingHash, bindingHash!)
          ) throw new ClassifiedDataOperationError(
            "stale",
            "Protected Task Namespace authority changed",
          );
          const generation = keyring.generations.find((entry) =>
            entry.generation === plan.authority.keyGeneration
          );
          if (generation === undefined) throw new ClassifiedDataOperationError(
            "key_waiting",
            "Protected Task Namespace key is unavailable",
          );
          return encodeNamespaceObjectEnvelopeV2(wrapObjectDekForNamespace(
            dependencies.crypto,
            generation.key,
            {
              objectId: objectId(cryptoObjectId),
              namespaceId: namespaceId(plan.authority.namespaceId),
              keyClass: "ai",
              keyGeneration: namespaceGeneration(generation.generation),
              bindingRevisionAtWrap: accessRevision(keyring.accessRevision),
            },
            dek!,
          ));
        },
      });
      const access = prepareHumanObjectAccessManifestGenesisSet(
        dependencies.crypto,
        {
          objectId: objectId(cryptoObjectId),
          payloadHash: dependencies.crypto.hash(payloadBytes),
          envelopeBytes: [envelopeBytes],
          sourceAuthorized: true,
          targetAuthorized: true,
          subjectHumanId: humanId(dependencies.subjectHumanId),
          committerDeviceId: cryptoDeviceId(profile.deviceId),
          hostAuthorizationRevision: authorizationRevision(
            profile.trustedHostAuthorizationRevision,
          ),
          committerSigningPublicKey: profile.signingPublicKey,
          committerSigningPrivateKey: profile.signingPrivateKey,
        },
      );
      manifestBytes = access.manifestBytes;
      planDigest = fromBase64url("Protected Task plan digest", plan.planDigestBase64url);
      operationalFieldsDigest = representation === "dual"
        ? fingerprintTaskDualPublicationFieldsV1(
            operation,
            input.task,
            plaintext,
          )
        : fingerprintTaskOperationalFieldsV1(operation, input.task);
      const signed = prepareHumanTaskPublicationRequest(dependencies.crypto, {
        operation,
        operationId: plan.operationId,
        taskId: plan.taskId,
        cryptoObjectId,
        expectedContentRevision: plan.expectedContentRevision,
        nextContentRevision: plan.nextContentRevision,
        expectedCryptoAccessRevision: plan.expectedCryptoAccessRevision,
        resultCryptoAccessRevision: 0,
        planDigest,
        operationalFieldsDigest,
        subjectHumanId: plan.authority.requesterHumanId,
        committerDeviceId: profile.deviceId,
        hostAuthorizationRevision: profile.trustedHostAuthorizationRevision,
        namespaceId: plan.authority.namespaceId,
        domainId: plan.authority.domainId,
        expectedNamespaceAccessRevision: plan.authority.expectedAccessRevision,
        expectedPolicyRevision: plan.authority.expectedPolicyRevision,
        bindingHash,
        keyGeneration: plan.authority.keyGeneration,
        payloadHash: dependencies.crypto.hash(payloadBytes),
        manifestHash: dependencies.crypto.hash(manifestBytes),
        envelopeHash: dependencies.crypto.hash(envelopeBytes),
        issuedAt: unixTimestamp(now),
        deadlineAt: unixTimestamp(now + SIGNED_REQUEST_TTL_MS),
        committerSigningPublicKey: profile.signingPublicKey,
        committerSigningPrivateKey: profile.signingPrivateKey,
      });
      signedBytes = signed.bytes;
      const prepared = {
        requestVersion: 1 as const,
        operation,
        operationId: plan.operationId,
        planDigestBase64url: plan.planDigestBase64url,
        taskId: plan.taskId,
        expectedContentRevision: plan.expectedContentRevision,
        nextContentRevision: plan.nextContentRevision,
        expectedCryptoAccessRevision: plan.expectedCryptoAccessRevision,
        resultCryptoAccessRevision: 0 as const,
        cryptoObjectId,
        payloadVersion: 1 as const,
        requiredNamespaceIds: [plan.authority.namespaceId] as [string],
        encryptedPayloadBytesBase64url: toBase64url(payloadBytes),
        accessManifestBytesBase64url: toBase64url(manifestBytes),
        namespaceEnvelopes: [{
          namespaceId: plan.authority.namespaceId,
          envelopeBytesBase64url: toBase64url(envelopeBytes),
        }] as [{ namespaceId: string; envelopeBytesBase64url: string }],
        signedPublicationRequestBytesBase64url: toBase64url(signedBytes),
        task: input.task,
      };
      return Object.freeze(representation === "dual"
        ? {
            ...prepared,
            representation: "dual" as const,
            ordinaryPayloadBytesBase64url: toBase64url(plaintext),
          }
        : prepared) as ProtectedTaskPreparedCreateRequestV1
          | ProtectedTaskPreparedUpdateRequestV1
          | DualTaskPreparedCreateRequestV1
          | DualTaskPreparedUpdateRequestV1;
    } finally {
      plaintext?.fill(0);
      dek?.fill(0);
      payloadBytes?.fill(0);
      envelopeBytes?.fill(0);
      manifestBytes?.fill(0);
      signedBytes?.fill(0);
      planDigest?.fill(0);
      bindingHash?.fill(0);
      operationalFieldsDigest?.fill(0);
    }
    },
  );

  return Object.freeze({
    prepareCreate: async (
      input: Parameters<HumanTaskDeviceContentPortV1["prepareCreate"]>[0],
    ) => prepare("create", input, "protected") as Promise<ProtectedTaskPreparedCreateRequestV1>,
    prepareUpdate: async (
      input: Parameters<HumanTaskDeviceContentPortV1["prepareUpdate"]>[0],
    ) => prepare("update", input, "protected") as Promise<ProtectedTaskPreparedUpdateRequestV1>,
    prepareDualCreate: async (
      input: Parameters<HumanTaskDeviceContentPortV1["prepareDualCreate"]>[0],
    ) => prepare("create", input, "dual") as Promise<DualTaskPreparedCreateRequestV1>,
    prepareDualUpdate: async (
      input: Parameters<HumanTaskDeviceContentPortV1["prepareDualUpdate"]>[0],
    ) => prepare("update", input, "dual") as Promise<DualTaskPreparedUpdateRequestV1>,
    openExact: async (input: Parameters<HumanTaskDeviceContentPortV1["openExact"]>[0]) => {
      const envelope = input.envelope;
      if (
        input.reference.cryptoAccessRevision !== 0
        || envelope.accessManifestProofBytes.length !== 0
      ) throw new ClassifiedDataOperationError(
        "unsupported",
        "Protected Task access-history reads are unavailable",
      );
      const retainedAnchor = await dependencies.accessAnchors.load(
        input.reference.objectId,
      );
      const result = await withProfile(dependencies, async (profileV4) => {
      let canonicalPayload: Uint8Array | undefined;
      let canonicalManifest: Uint8Array | undefined;
      let canonicalEnvelope: Uint8Array | undefined;
      let signerKey: Uint8Array | undefined;
      let evidenceKey: Uint8Array | undefined;
      let plaintext: Uint8Array | undefined;
      try {
        const payload = decodeEncryptedPayloadV2(envelope.encryptedPayloadBytes);
        const manifest = decodeObjectAccessManifestV5(envelope.accessManifestBytes);
        const namespaceEnvelope = decodeNamespaceObjectEnvelopeV2(
          envelope.namespaceEnvelopeBytes,
        );
        canonicalPayload = encodeEncryptedPayloadV2(payload);
        canonicalManifest = encodeObjectAccessManifestV5(manifest);
        canonicalEnvelope = encodeNamespaceObjectEnvelopeV2(namespaceEnvelope);
        if (
          !equalBytes(canonicalPayload, envelope.encryptedPayloadBytes)
          || !equalBytes(canonicalManifest, envelope.accessManifestBytes)
          || !equalBytes(canonicalEnvelope, envelope.namespaceEnvelopeBytes)
          || payload.context.objectId !== input.reference.objectId
          || payload.context.objectType !== TASK_DEFINITION_OBJECT_TYPE_V1
          || payload.context.keyClass !== "ai"
          || manifest.objectId !== input.reference.objectId
          || manifest.accessRevision !== input.reference.cryptoAccessRevision
          || !equalBytes(manifest.payloadHash, dependencies.crypto.hash(
            envelope.encryptedPayloadBytes,
          ))
          || namespaceEnvelope.context.objectId !== input.reference.objectId
          || namespaceEnvelope.context.namespaceId !== envelope.namespaceId
          || namespaceEnvelope.context.keyClass !== "ai"
          || manifest.envelopeHashes.length !== 1
          || !equalBytes(manifest.envelopeHashes[0]!, dependencies.crypto.hash(
            envelope.namespaceEnvelopeBytes,
          ))
        ) throw new ClassifiedDataOperationError(
          "integrity",
          "Protected Task ciphertext coordinates are invalid",
        );
        const signer = manifest.signer;
        if (signer.kind !== "human_device") throw new ClassifiedDataOperationError(
          "integrity",
          "Protected Task definition signer is invalid",
        );
        const own = profileV4.baseProfile.baseProfile;
        // Exact reads currently accept only the locally authenticated device.
        // Server-returned public keys are not a trust root. Cross-device reads
        // remain closed until signer evidence is ingested into the V4 profile's
        // authenticated device-history anchors.
        signerKey = signer.subjectHumanId === dependencies.subjectHumanId
          && signer.committerDeviceId === own.deviceId
          && manifest.hostAuthorizationRevision <= own.trustedHostAuthorizationRevision
          ? own.signingPublicKey.slice()
          : undefined;
        if (
          signerKey === undefined
          && signer.subjectHumanId === dependencies.subjectHumanId
          && manifest.hostAuthorizationRevision <= own.trustedHostAuthorizationRevision
        ) {
          signerKey = withClientObjectAccessSignerResolversV4({
            crypto: dependencies.crypto,
            profile: profileV4,
            operation: (resolvers) =>
              resolvers.resolveHistoricalHumanDeviceSigningPublicKey({
                humanId: signer.subjectHumanId,
                deviceId: signer.committerDeviceId,
              })?.slice(),
          });
        }
        if (signerKey === undefined) throw new ClassifiedDataOperationError(
          "key_waiting",
          "Protected Task signer evidence is unavailable",
        );
        evidenceKey = exactHumanSignerEvidenceKey(
          envelope,
          signer,
          manifest.hostAuthorizationRevision,
        );
        if (evidenceKey === undefined || !equalBytes(evidenceKey, signerKey)) {
          throw new ClassifiedDataOperationError(
            "integrity",
            "Protected Task signer evidence disagrees with trusted device history",
          );
        }
        verifyCommonObjectAccessManifest(dependencies.crypto, {
          manifestBytes: envelope.accessManifestBytes,
          resolveHistoricalHumanDeviceSigningPublicKey: () => signerKey!,
          resolveAgentRuntimeSignerPublicKey: () => null,
          resolveProcessorSignerAuthorizationBytes: () => null,
          resolveHistoricalProcessorIssuingDevicePublicKey: () => null,
        });
        const nextAnchor: TrustedMinimumObjectAccessHead = Object.freeze({
          objectId: objectId(manifest.objectId),
          payloadHash: manifest.payloadHash.slice(),
          accessRevision: accessRevision(0),
          manifestHash: dependencies.crypto.hash(envelope.accessManifestBytes),
        });
        if (
          retainedAnchor !== null
          && (
            retainedAnchor.objectId !== nextAnchor.objectId
            || retainedAnchor.accessRevision !== 0
            || !equalBytes(retainedAnchor.payloadHash, nextAnchor.payloadHash)
            || !equalBytes(retainedAnchor.manifestHash, nextAnchor.manifestHash)
          )
        ) {
          nextAnchor.payloadHash.fill(0);
          nextAnchor.manifestHash.fill(0);
          throw new ClassifiedDataOperationError(
            "integrity",
            "Protected Task definition rolled back behind its trusted anchor",
          );
        }
        plaintext = await withClientNamespaceKeyring({
          profile: own,
          namespaceId: envelope.namespaceId,
          keyClass: "ai",
          requiredAccessRevision: namespaceEnvelope.context.bindingRevisionAtWrap,
          requiredGeneration: namespaceEnvelope.context.keyGeneration,
          operation: (keyring) => {
            const generation = keyring.generations.find((entry) =>
              entry.generation === namespaceEnvelope.context.keyGeneration
            );
            if (generation === undefined) return null;
            return decryptObjectThroughNamespace(
              dependencies.crypto,
              generation.key,
              namespaceEnvelope,
              payload,
            );
          },
        }) ?? undefined;
        if (plaintext === undefined) throw new ClassifiedDataOperationError(
          "key_waiting",
          "Protected Task Namespace key is unavailable",
        );
        return Object.freeze({ plaintext, nextAnchor });
      } catch (error) {
        plaintext?.fill(0);
        if (error instanceof ClassifiedDataOperationError) throw error;
        throw new ClassifiedDataOperationError(
          "integrity",
          "Protected Task content could not be authenticated",
          { cause: error },
        );
      } finally {
        canonicalPayload?.fill(0);
        canonicalManifest?.fill(0);
        canonicalEnvelope?.fill(0);
        signerKey?.fill(0);
        evidenceKey?.fill(0);
      }
      });
      let advanced: boolean;
      try {
        advanced = await dependencies.accessAnchors.advance({
          expected: retainedAnchor,
          next: result.nextAnchor,
        });
      } catch (error) {
        result.plaintext.fill(0);
        result.nextAnchor.payloadHash.fill(0);
        result.nextAnchor.manifestHash.fill(0);
        throw error;
      }
      if (!advanced) {
        result.plaintext.fill(0);
        result.nextAnchor.payloadHash.fill(0);
        result.nextAnchor.manifestHash.fill(0);
        throw new ClassifiedDataOperationError(
          "stale",
          "Protected Task trusted access anchor changed concurrently",
        );
      }
      result.nextAnchor.payloadHash.fill(0);
      result.nextAnchor.manifestHash.fill(0);
      return result.plaintext;
    },
  });
}
