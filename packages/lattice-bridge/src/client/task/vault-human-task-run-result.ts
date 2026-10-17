import {
  decryptObjectThroughNamespace,
  verifyCommonObjectAccessManifestChain,
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
import {
  ingestObjectAccessSignerEvidenceV4,
  type ObjectAccessSignerEvidenceTransportV1,
  type ResolveTrustedObjectAccessEvidenceIssuerV4,
} from "../../client-vault/ingest-object-access-signer-evidence-v4.ts";
import { deriveTaskHistoricalContentCryptoObjectIdV1 } from
  "../../task/task-historical-content-identity.ts";
import {
  deriveTaskContentCryptoObjectIdV1,
  TASK_RUN_RESULT_OBJECT_TYPE_V1,
} from "../../task/task-content-repository.ts";
import { parseTaskHistoricalRepairProvenanceV1 } from
  "../../task/task-historical-repair-provenance.ts";
import { ClassifiedDataOperationError } from
  "../../transition/encryption-data-operation-owner.ts";
import {
  exactForegroundAgentSignerKeysV1,
  foregroundAgentSignerPrincipalKeyV1,
} from "../foreground-agent-accepted-execution.ts";
import type { HumanTaskRunResultDevicePortV1 } from
  "./authorized-human-task-run-result.ts";
import {
  destroyPreparedTaskAccessManifestChain,
  assertTaskAccessRewrapSigners,
  exactTaskHumanSignerKeys,
  prepareTaskAccessManifestChain,
  sameTaskAccessBytes,
  taskHumanSignerCoordinate,
} from "./task-access-manifest-read.ts";
import type { VaultHumanTaskDeviceContentInputV1 } from
  "./vault-human-task-device-content.ts";
import { withVaultHumanTaskReadAuthorityV1 } from
  "./vault-human-task-device-content.ts";
import {
  withTaskRuntimeSignerEvidenceResolversV1,
  type TaskRuntimeSignerCertificateEvidenceTransportV1,
} from "../task-runtime-signer-evidence.ts";

export type VaultHumanTaskRunResultReaderInputV1 =
  VaultHumanTaskDeviceContentInputV1 & Readonly<{
    resolveTrustedIssuingDevicePublicKey?: ResolveTrustedObjectAccessEvidenceIssuerV4;
    createStageId(): string;
  }>;

function fromHex(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError("Historical Task result digest is not canonical");
  }
  return Uint8Array.from(value.match(/../gu)!, byte => Number.parseInt(byte, 16));
}

function wipeManifest(manifest: ReturnType<typeof decodeObjectAccessManifestV5>): void {
  manifest.payloadHash.fill(0);
  manifest.previousManifestHash?.fill(0);
  manifest.envelopeHashes.forEach(hash => hash.fill(0));
  manifest.signerAuthorizationHash?.fill(0);
  manifest.signature.fill(0);
}

/** Device-custodied Task result open with rollback-safe access-chain verification. */
export function createVaultHumanTaskRunResultReaderV1(
  dependencies: VaultHumanTaskRunResultReaderInputV1,
): HumanTaskRunResultDevicePortV1 {
  return Object.freeze({
    async openExact(input: Parameters<HumanTaskRunResultDevicePortV1["openExact"]>[0]) {
      const envelope = input.envelope;
      let historicalRepair = envelope.historicalRepair;
      let sourceDigest: Uint8Array | undefined;
      try {
        if (historicalRepair !== undefined) {
          const parsed = parseTaskHistoricalRepairProvenanceV1(historicalRepair);
          if (parsed.version !== 2) throw new TypeError("unsupported version");
          historicalRepair = parsed;
          sourceDigest = fromHex(parsed.sourceDigest);
        }
        const expectedObjectId = historicalRepair === undefined
          ? deriveTaskContentCryptoObjectIdV1({
              kind: "run_result", taskId: input.taskId,
              taskRunId: input.taskRunId,
              contentRevision: envelope.resultRevision,
            })
          : deriveTaskHistoricalContentCryptoObjectIdV1({
              coordinate: {
                kind: "run_result", taskId: input.taskId,
                taskRunId: input.taskRunId,
                contentRevision: envelope.resultRevision,
              },
              namespaceId: envelope.namespaceId,
              sourceDigest: sourceDigest!,
            });
        const agentEvidence = envelope.signerEvidence.filter(entry =>
          entry.kind === "agent_runtime_publication"
          || entry.kind === "foreground_agent_accepted_execution"
          || entry.kind === "task_runtime_signer_certificate");
        const humanEvidence = envelope.signerEvidence.filter(entry =>
          entry.kind === "human_device");
        if (dependencies.subjectHumanId !== dependencies.coordinates.humanActorId
          || envelope.taskId !== input.taskId
          || envelope.taskRunId !== input.taskRunId
          || envelope.objectId !== expectedObjectId
          || (envelope.resultRevision !== 1 && envelope.resultRevision !== 2)
          || envelope.accessManifestProofBytes.length !== envelope.cryptoAccessRevision
          || historicalRepair === undefined && (
            agentEvidence.length !== 1
            || agentEvidence.length + humanEvidence.length !== envelope.signerEvidence.length)
          || historicalRepair !== undefined && (
            envelope.resultRevision !== 1
            || agentEvidence.length !== 0
            || humanEvidence.length !== envelope.signerEvidence.length
            || !humanEvidence.some(entry =>
              entry.committerDeviceId === historicalRepair!.publisherDeviceId))) {
          throw new TypeError("Protected Task result access is invalid");
        }
        let availability = await dependencies.vault.availability();
        if (availability.status === "locked") availability = await dependencies.vault.unlock();
        if (availability.status !== "available") throw new ClassifiedDataOperationError(
          "key_waiting", "Protected Task result device is unavailable",
        );
        const admission = await dependencies.resolveDeviceAdmissionStatus();
        if (admission.status !== "admitted"
          || admission.deviceId !== dependencies.coordinates.deviceId
          || admission.expiresAt <= dependencies.now()) throw new ClassifiedDataOperationError(
          "key_waiting", "Protected Task result device admission is unavailable",
        );

        let payload: ReturnType<typeof decodeEncryptedPayloadV2> | undefined;
        let namespaceEnvelope: ReturnType<typeof decodeNamespaceObjectEnvelopeV2>
          | undefined;
        let canonicalPayload: Uint8Array | undefined;
        let canonicalManifest: Uint8Array | undefined;
        let canonicalEnvelope: Uint8Array | undefined;
        let payloadHash: Uint8Array | undefined;
        let envelopeHash: Uint8Array | undefined;
        let retained = null as Awaited<ReturnType<typeof dependencies.accessAnchors.load>>;
        let prepared: ReturnType<typeof prepareTaskAccessManifestChain> | undefined;
        let foregroundKeys: Map<string, Uint8Array> | undefined;
        let humanKeys: Map<string, Uint8Array> | undefined;
        let opened: Uint8Array | null = null;
        try {
          payload = decodeEncryptedPayloadV2(envelope.encryptedPayloadBytes);
          const head = decodeObjectAccessManifestV5(envelope.accessManifestBytes);
          namespaceEnvelope = decodeNamespaceObjectEnvelopeV2(envelope.namespaceEnvelopeBytes);
          try {
            canonicalPayload = encodeEncryptedPayloadV2(payload);
            canonicalManifest = encodeObjectAccessManifestV5(head);
            canonicalEnvelope = encodeNamespaceObjectEnvelopeV2(namespaceEnvelope);
            payloadHash = dependencies.crypto.hash(envelope.encryptedPayloadBytes);
            envelopeHash = dependencies.crypto.hash(envelope.namespaceEnvelopeBytes);
            if (!sameTaskAccessBytes(canonicalPayload, envelope.encryptedPayloadBytes)
              || !sameTaskAccessBytes(canonicalManifest, envelope.accessManifestBytes)
              || !sameTaskAccessBytes(canonicalEnvelope, envelope.namespaceEnvelopeBytes)
              || payload.context.objectId !== expectedObjectId
              || payload.context.objectType !== TASK_RUN_RESULT_OBJECT_TYPE_V1
              || payload.context.keyClass !== "ai"
              || head.objectId !== expectedObjectId
              || head.accessRevision !== envelope.cryptoAccessRevision
              || !sameTaskAccessBytes(head.payloadHash, payloadHash)
              || head.envelopeHashes.length !== 1
              || !sameTaskAccessBytes(head.envelopeHashes[0]!, envelopeHash)
              || namespaceEnvelope.context.objectId !== expectedObjectId
              || namespaceEnvelope.context.namespaceId !== envelope.namespaceId
              || namespaceEnvelope.context.keyClass !== "ai") {
              throw new TypeError("Task result ciphertext was substituted");
            }
          } finally { wipeManifest(head); }
          retained = await dependencies.accessAnchors.load(expectedObjectId);
          prepared = prepareTaskAccessManifestChain({
            crypto: dependencies.crypto,
            objectId: expectedObjectId,
            payloadHash,
            headManifestBytes: envelope.accessManifestBytes,
            proofManifestBytes: envelope.accessManifestProofBytes,
            retained,
          });
          const genesis = decodeObjectAccessManifestV5(prepared.genesisManifestBytes);
          try {
            if (historicalRepair === undefined) {
              if (genesis.signer.kind !== "agent_runtime"
                || genesis.signer.agentId !== input.agentId) {
                throw new TypeError("Task result Agent genesis was substituted");
              }
            } else {
              const actual = dependencies.crypto.hash(prepared.genesisManifestBytes);
              const expected = fromHex(historicalRepair.genesisManifestHash);
              try {
                if (genesis.signer.kind !== "human_device"
                  || genesis.signer.subjectHumanId !== dependencies.subjectHumanId
                  || genesis.signer.committerDeviceId !== historicalRepair.publisherDeviceId
                  || !sameTaskAccessBytes(actual, expected)) {
                  throw new TypeError("Task result historical genesis was substituted");
                }
              } finally { actual.fill(0); expected.fill(0); }
            }
          } finally { wipeManifest(genesis); }
          assertTaskAccessRewrapSigners(
            prepared.fullChain,
            dependencies.subjectHumanId,
          );

          const publications = envelope.signerEvidence.filter(
            (entry): entry is ObjectAccessSignerEvidenceTransportV1 =>
              entry.kind === "agent_runtime_publication",
          );
          const taskCertificates = envelope.signerEvidence.filter(
            (entry): entry is TaskRuntimeSignerCertificateEvidenceTransportV1 =>
              entry.kind === "task_runtime_signer_certificate",
          );
          if (publications.length > 0) {
            try {
              await ingestObjectAccessSignerEvidenceV4({
                crypto: dependencies.crypto, vault: dependencies.vault,
                coordinates: dependencies.coordinates, evidence: publications,
                ...(dependencies.resolveTrustedIssuingDevicePublicKey === undefined
                  ? {} : { resolveTrustedIssuingDevicePublicKey:
                    dependencies.resolveTrustedIssuingDevicePublicKey }),
                createStageId: dependencies.createStageId,
              });
            } catch (cause) {
              throw new ClassifiedDataOperationError(
                "key_waiting", "Protected Task result signer authority is unavailable",
                { cause },
              );
            }
          }
          foregroundKeys = exactForegroundAgentSignerKeysV1({
            crypto: dependencies.crypto, evidence: envelope.signerEvidence,
            manifestBytes: prepared.fullChain, expectedAgentId: input.agentId,
          });
          humanKeys = exactTaskHumanSignerKeys({
            evidence: envelope.signerEvidence, chain: prepared.fullChain,
            expectedHumanId: dependencies.subjectHumanId,
          });
          await dependencies.vault.withOpenProfile(
            dependencies.coordinates,
            async profileBytes => {
              const profile = await authenticateClientDeviceProfileV4({
                crypto: dependencies.crypto, profileBytes,
                expectedDeviceId: dependencies.coordinates.deviceId,
              });
              try {
                const own = profile.baseProfile.baseProfile;
                withTaskRuntimeSignerEvidenceResolversV1({
                  crypto: dependencies.crypto,
                  profile,
                  subjectHumanId: dependencies.subjectHumanId,
                  ownDeviceGeneration: admission.deviceGeneration,
                  expectedWork: { taskId: envelope.taskId,
                    taskRunId: envelope.taskRunId },
                  evidence: taskCertificates,
                  operation: taskResolvers =>
                    withClientObjectAccessSignerResolversV4({
                      crypto: dependencies.crypto, profile,
                      operation: resolvers => verifyCommonObjectAccessManifestChain(
                        dependencies.crypto,
                        {
                      manifestBytes: envelope.accessManifestBytes,
                      proof: prepared!.proof,
                      trustedMinimumHead: prepared!.trustedMinimumHead,
                      resolveHistoricalHumanDeviceSigningPublicKey: context => {
                        const evidenceKey = humanKeys!.get(taskHumanSignerCoordinate({
                          subjectHumanId: context.subjectHumanId,
                          committerDeviceId: context.committerDeviceId,
                          hostAuthorizationRevision: context.hostAuthorizationRevision,
                        }));
                        if (evidenceKey === undefined) return null;
                        const trusted = context.committerDeviceId === own.deviceId
                          && context.subjectHumanId === dependencies.subjectHumanId
                          && context.hostAuthorizationRevision
                            <= own.trustedHostAuthorizationRevision
                          ? own.signingPublicKey
                          : resolvers.resolveHistoricalHumanDeviceSigningPublicKey({
                              humanId: context.subjectHumanId,
                              deviceId: context.committerDeviceId,
                            });
                        if (trusted === null || trusted === undefined) {
                          throw new ClassifiedDataOperationError(
                            "key_waiting", "Protected Task result signer history is unavailable",
                          );
                        }
                        if (!sameTaskAccessBytes(trusted, evidenceKey)) {
                          throw new TypeError("Task result Human signer evidence is untrusted");
                        }
                        return evidenceKey;
                      },
                      resolveAgentRuntimeSignerPublicKey: principal =>
                        foregroundKeys!.get(foregroundAgentSignerPrincipalKeyV1(principal))
                        ?? resolvers.resolveAgentRuntimeSignerPublicKey(principal),
                      resolveProcessorSignerAuthorizationBytes: () => null,
                      resolveHistoricalProcessorIssuingDevicePublicKey: () => null,
                      ...taskResolvers,
                        },
                      ),
                    }),
                });
              } finally { destroyOpenedClientDeviceProfileV4(profile); }
            },
          );
          opened = await withVaultHumanTaskReadAuthorityV1({
            dependencies,
            authority: envelope.readAuthority,
            namespaceId: envelope.namespaceId,
            generation: namespaceEnvelope.context.keyGeneration,
            accessRevision: namespaceEnvelope.context.bindingRevisionAtWrap,
            operation: (generationKey) => {
              const plaintext = decryptObjectThroughNamespace(
                dependencies.crypto, generationKey, namespaceEnvelope!, payload!,
              );
              if (plaintext === null) throw new TypeError(
                "Protected Task result ciphertext authentication failed",
              );
              return plaintext;
            },
          });
          if (!await dependencies.accessAnchors.advance({
            expected: retained, next: prepared.nextAnchor,
          })) throw new ClassifiedDataOperationError(
            "stale", "Protected Task result anchor changed concurrently",
          );
          const result = opened;
          opened = null;
          return result;
        } finally {
          opened?.fill(0);
          payload?.ciphertext.fill(0);
          namespaceEnvelope?.wrappedDek.fill(0);
          canonicalPayload?.fill(0);
          canonicalManifest?.fill(0);
          canonicalEnvelope?.fill(0);
          payloadHash?.fill(0);
          envelopeHash?.fill(0);
          foregroundKeys?.forEach(key => key.fill(0));
          humanKeys?.forEach(key => key.fill(0));
          if (prepared !== undefined) {
            destroyPreparedTaskAccessManifestChain(prepared, retained);
          }
        }
      } catch (cause) {
        if (cause instanceof ClassifiedDataOperationError) throw cause;
        throw new ClassifiedDataOperationError(
          "integrity", "Protected Task result could not be authenticated", { cause },
        );
      } finally { sourceDigest?.fill(0); }
    },
  });
}
