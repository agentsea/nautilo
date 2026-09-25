import {
  accessRevision,
  decryptObjectThroughNamespace,
  objectId,
  verifyCommonObjectAccessManifest,
  type TrustedMinimumObjectAccessHead,
} from "@nautilo/lattice-crypto";
import {
  decodeAgentRuntimeSignerPublicationV1,
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
import {
  ingestObjectAccessSignerEvidenceV4,
  type ResolveTrustedObjectAccessEvidenceIssuerV4,
} from "../../client-vault/ingest-object-access-signer-evidence-v4.ts";
import { withClientNamespaceKeyring } from
  "../../device/client-namespace-keyring.ts";
import {
  deriveTaskContentCryptoObjectIdV1,
  TASK_RUN_RESULT_OBJECT_TYPE_V1,
} from "../../task/task-content-repository.ts";
import { ClassifiedDataOperationError } from
  "../../transition/encryption-data-operation-owner.ts";
import type { VaultHumanTaskDeviceContentInputV1 } from
  "./vault-human-task-device-content.ts";
import type {
  HumanTaskRunResultDevicePortV1,
} from "./authorized-human-task-run-result.ts";

export type VaultHumanTaskRunResultReaderInputV1 =
  VaultHumanTaskDeviceContentInputV1 & Readonly<{
    resolveTrustedIssuingDevicePublicKey:
      ResolveTrustedObjectAccessEvidenceIssuerV4;
    createStageId(): string;
  }>;

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function fromBase64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) {
    throw new TypeError("Task result signer evidence is not canonical");
  }
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/")
    + "=".repeat((4 - value.length % 4) % 4));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  let roundTrip = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    roundTrip += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  if (btoa(roundTrip).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/u, "") !== value) {
    bytes.fill(0);
    throw new TypeError("Task result signer evidence is not canonical");
  }
  return bytes;
}

/**
 * Device-custodied Task result open. The server's evidence is ingested only
 * after its issuing device is authenticated; manifest, result coordinate, and
 * AI Namespace key are independently checked before any plaintext leaves.
 */
export function createVaultHumanTaskRunResultReaderV1(
  dependencies: VaultHumanTaskRunResultReaderInputV1,
): HumanTaskRunResultDevicePortV1 {
  return Object.freeze({
    async openExact(input: Parameters<HumanTaskRunResultDevicePortV1["openExact"]>[0]) {
      const envelope = input.envelope;
      const expectedObjectId = deriveTaskContentCryptoObjectIdV1({
        kind: "run_result",
        taskId: input.taskId,
        taskRunId: input.taskRunId,
        contentRevision: 1,
      });
      if (envelope.taskId !== input.taskId
        || envelope.taskRunId !== input.taskRunId
        || envelope.objectId !== expectedObjectId
        || envelope.resultRevision !== 1
        || envelope.cryptoAccessRevision !== 0
        || envelope.accessManifestProofBytes.length !== 0
        || envelope.signerEvidence.length !== 1
        || envelope.signerEvidence[0]?.kind !== "agent_runtime_publication") {
        throw new ClassifiedDataOperationError(
          "integrity", "Protected Task result access is invalid",
        );
      }
      let availability = await dependencies.vault.availability();
      if (availability.status === "locked") {
        availability = await dependencies.vault.unlock();
      }
      if (availability.status !== "available") {
        throw new ClassifiedDataOperationError(
          "key_waiting", "Protected Task result device is unavailable",
        );
      }
      const admission = await dependencies.resolveDeviceAdmissionStatus();
      if (admission.status !== "admitted"
        || admission.deviceId !== dependencies.coordinates.deviceId
        || admission.expiresAt <= dependencies.now()) {
        throw new ClassifiedDataOperationError(
          "key_waiting", "Protected Task result device admission is unavailable",
        );
      }

      let payload: ReturnType<typeof decodeEncryptedPayloadV2>;
      let manifest: ReturnType<typeof decodeObjectAccessManifestV5>;
      let namespaceEnvelope: ReturnType<
        typeof decodeNamespaceObjectEnvelopeV2
      >;
      let canonicalPayload: Uint8Array | undefined;
      let canonicalManifest: Uint8Array | undefined;
      let canonicalEnvelope: Uint8Array | undefined;
      let signerEvidenceBytes: Uint8Array | undefined;
      let opened: Uint8Array | null = null;
      let nextAnchor: TrustedMinimumObjectAccessHead | undefined;
      try {
        payload = decodeEncryptedPayloadV2(envelope.encryptedPayloadBytes);
        manifest = decodeObjectAccessManifestV5(envelope.accessManifestBytes);
        namespaceEnvelope = decodeNamespaceObjectEnvelopeV2(
          envelope.namespaceEnvelopeBytes,
        );
        canonicalPayload = encodeEncryptedPayloadV2(payload);
        canonicalManifest = encodeObjectAccessManifestV5(manifest);
        canonicalEnvelope = encodeNamespaceObjectEnvelopeV2(
          namespaceEnvelope,
        );
        if (!equalBytes(canonicalPayload, envelope.encryptedPayloadBytes)
          || !equalBytes(canonicalManifest, envelope.accessManifestBytes)
          || !equalBytes(canonicalEnvelope, envelope.namespaceEnvelopeBytes)
          || payload.context.objectId !== expectedObjectId
          || payload.context.objectType !== TASK_RUN_RESULT_OBJECT_TYPE_V1
          || payload.context.keyClass !== "ai"
          || manifest.objectId !== expectedObjectId
          || manifest.accessRevision !== 0
          || manifest.previousManifestHash !== null
          || !equalBytes(manifest.payloadHash, dependencies.crypto.hash(
            envelope.encryptedPayloadBytes,
          ))
          || manifest.envelopeHashes.length !== 1
          || !equalBytes(manifest.envelopeHashes[0]!, dependencies.crypto.hash(
            envelope.namespaceEnvelopeBytes,
          ))
          || manifest.signer.kind !== "agent_runtime"
          || manifest.signer.agentId !== input.agentId
          || namespaceEnvelope.context.objectId !== expectedObjectId
          || namespaceEnvelope.context.namespaceId !== envelope.namespaceId
          || namespaceEnvelope.context.keyClass !== "ai") {
          throw new TypeError("Task result ciphertext or signer was substituted");
        }
        const agentSigner = manifest.signer;
        if (agentSigner.kind !== "agent_runtime") {
          throw new TypeError("Task result signer was substituted");
        }
        signerEvidenceBytes = fromBase64url(
          envelope.signerEvidence[0].evidenceBytesBase64url,
        );
        const publication = decodeAgentRuntimeSignerPublicationV1(
          signerEvidenceBytes,
        );
        if (publication.agentId !== manifest.signer.agentId
          || publication.runtimeGeneration
            !== manifest.signer.runtimeGeneration
          || publication.signerKeyId !== manifest.signer.signerKeyId) {
          throw new TypeError("Task result signer publication was substituted");
        }
        const retained = await dependencies.accessAnchors.load(
          expectedObjectId,
        );
        try {
          await ingestObjectAccessSignerEvidenceV4({
            crypto: dependencies.crypto,
            vault: dependencies.vault,
            coordinates: dependencies.coordinates,
            evidence: [envelope.signerEvidence[0]],
            resolveTrustedIssuingDevicePublicKey:
              dependencies.resolveTrustedIssuingDevicePublicKey,
            createStageId: dependencies.createStageId,
          });
        } catch (cause) {
          throw new ClassifiedDataOperationError(
            "key_waiting",
            "Protected Task result signer authority is unavailable",
            { cause },
          );
        }
        nextAnchor = Object.freeze({
          objectId: objectId(expectedObjectId),
          payloadHash: manifest.payloadHash.slice(),
          accessRevision: accessRevision(0),
          manifestHash: dependencies.crypto.hash(
            envelope.accessManifestBytes,
          ),
        });
        if (retained !== null
          && (retained.objectId !== nextAnchor.objectId
            || retained.accessRevision !== 0
            || !equalBytes(retained.payloadHash, nextAnchor.payloadHash)
            || !equalBytes(retained.manifestHash, nextAnchor.manifestHash))) {
          throw new TypeError("Protected Task result rolled back");
        }
        opened = await dependencies.vault.withOpenProfile(
          dependencies.coordinates,
          async (profileBytes) => {
            const profile = await authenticateClientDeviceProfileV4({
              crypto: dependencies.crypto,
              profileBytes,
              expectedDeviceId: dependencies.coordinates.deviceId,
            });
            try {
              withClientObjectAccessSignerResolversV4({
                crypto: dependencies.crypto,
                profile,
                operation: (resolvers) => {
                  if (resolvers.resolveAgentRuntimeSignerPublicKey(
                    agentSigner,
                  ) === null) {
                    throw new ClassifiedDataOperationError(
                      "key_waiting",
                      "Protected Task result signer is unavailable",
                    );
                  }
                  verifyCommonObjectAccessManifest(dependencies.crypto, {
                    manifestBytes: envelope.accessManifestBytes,
                    resolveAgentRuntimeSignerPublicKey:
                      resolvers.resolveAgentRuntimeSignerPublicKey,
                    resolveHistoricalHumanDeviceSigningPublicKey:
                      () => null,
                    resolveProcessorSignerAuthorizationBytes: () => null,
                    resolveHistoricalProcessorIssuingDevicePublicKey:
                      () => null,
                  });
                },
              });
              return withClientNamespaceKeyring({
                profile: profile.baseProfile.baseProfile,
                namespaceId: envelope.namespaceId,
                keyClass: "ai",
                requiredAccessRevision:
                  namespaceEnvelope.context.bindingRevisionAtWrap,
                requiredGeneration:
                  namespaceEnvelope.context.keyGeneration,
                operation: (keyring) => {
                  const generation = keyring.generations.find((entry) =>
                    entry.generation
                      === namespaceEnvelope.context.keyGeneration);
                  return generation === undefined ? null
                    : decryptObjectThroughNamespace(
                      dependencies.crypto,
                      generation.key,
                      namespaceEnvelope,
                      payload,
                    );
                },
              });
            } finally {
              destroyOpenedClientDeviceProfileV4(profile);
            }
          },
        );
        if (opened === null) {
          throw new ClassifiedDataOperationError(
            "key_waiting", "Protected Task result Namespace key is unavailable",
          );
        }
        const advanced = await dependencies.accessAnchors.advance({
          expected: retained,
          next: nextAnchor,
        });
        if (!advanced) {
          throw new ClassifiedDataOperationError(
            "stale", "Protected Task result anchor changed concurrently",
          );
        }
        const result = opened;
        opened = null;
        return result;
      } catch (cause) {
        if (cause instanceof ClassifiedDataOperationError) throw cause;
        throw new ClassifiedDataOperationError(
          "integrity", "Protected Task result could not be authenticated",
          { cause },
        );
      } finally {
        opened?.fill(0);
        signerEvidenceBytes?.fill(0);
        canonicalPayload?.fill(0);
        canonicalManifest?.fill(0);
        canonicalEnvelope?.fill(0);
        nextAnchor?.payloadHash.fill(0);
        nextAnchor?.manifestHash.fill(0);
      }
    },
  });
}
