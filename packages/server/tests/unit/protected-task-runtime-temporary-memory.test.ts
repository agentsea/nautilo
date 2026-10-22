import { expect, test } from "bun:test";
import {
  LatticeCrypto,
  TaskRuntimeRecipientRegistry,
  accessRevision,
  authorizationRevision,
  createDomainForegroundAuthorizationPlan,
  createTaskRuntimeBackgroundAuthorizationRequest,
  createTaskRuntimeSignerAuthorization,
  cryptoDeviceId,
  decryptObjectPayload,
  humanId,
  mintDomainForegroundAuthorization,
  namespaceGeneration,
  namespaceId,
  openObjectDekForNamespace,
  taskRuntimeBackgroundAuthorizationIssuer,
  verifyCommonObjectAccessManifest,
} from "@nautilo/lattice-crypto";
import { createTaskRuntimeBackgroundAuthorizationRequestV1 } from
  "@nautilo/lattice-crypto/background";
import {
  agentRuntimeObjectSignerKeyIdV1,
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
  encodeTaskRuntimeBackgroundAuthorizationRequestV2,
  serializeDomainForegroundAuthorizationPlanV2,
  serializeDomainForegroundAuthorizationV2,
} from "@nautilo/lattice-crypto/wire";
import {
  commitMemoryMutationV1,
  decodeMemoryPayloadV1,
  deriveMemoryCryptoObjectIdV1,
  type ForegroundAgentEntityCryptoInvocation,
  readPreparedTaskRuntimeAgentObjectSnapshot,
  type VerifiedAgentObject,
} from "@nautilo/lattice-bridge";
import {
  createForegroundDomainMemoryExactAccess,
  createTaskRuntimeDomainMemoryCryptoSession,
  type ForegroundDomainMemoryAccessHead,
  type ForegroundDomainMemoryExactAccessPublication,
} from "@nautilo/runtime";

import { withProtectedTaskRuntimeSigner } from
  "../../src/routes/protected-task-runtime-signer";

const NOW = 2_300_000_000_000;
const TASK = "10000000-0000-4000-8000-000000000801";
const RUN = "20000000-0000-4000-8000-000000000802";
const MEMORY = "30000000-0000-4000-8000-000000000803";
const NAMESPACE = "40000000-0000-4000-8000-000000000804";
const TARGET_NAMESPACE = "40000000-0000-4000-8000-000000000809";
const DOMAIN = "50000000-0000-4000-8000-000000000805";
const USER = "60000000-0000-4000-8000-000000000806";
const AGENT = "70000000-0000-4000-8000-000000000807";
const HUMAN = "80000000-0000-4000-8000-000000000808";
const DEVICE = "temporary-memory-device";
const bytes = (value: number): Uint8Array => new Uint8Array(32).fill(value);

test.each([
  ["task.execute", 1],
  ["task.approval_resume", 2],
  ["task.await_reply_resume", 3],
] as const)("fresh certified %s segment %s writes and reopens Memory without permanent Runtime state", async (workKind, executionSegment) => {
  let now = NOW;
  const crypto = new LatticeCrypto(undefined, { now: () => now });
  const issuer = crypto.generateSigningKeyPair();
  const domainKey = bytes(0x41);
  const domain = Object.freeze({
    domainId: DOMAIN,
    sourceNamespaceId: NAMESPACE,
    participantDigest: bytes(0x42),
    participantCount: 1,
    keyClass: "ai" as const,
    domainKeyGeneration: 1,
    authorizationRevision: authorizationRevision(3),
    headDigest: bytes(0x43),
    activeNamespaceBindingSetDigest: bytes(0x44),
    activeNamespaceBindingCount: 1,
  });
  const namespaceRequirement = Object.freeze({
    ordinal: 0,
    namespaceId: NAMESPACE,
    domainId: DOMAIN,
    operations: Object.freeze(["decrypt", "encrypt"] as const),
    expectedAccessRevision: 0,
    expectedPolicyRevision: 5,
  });
  const registry = new TaskRuntimeRecipientRegistry(crypto, { now: () => now });
  const attempt = await registry.createAttempt({
    requestId: "temporary-memory-request",
    workId: RUN,
    recipientGeneration: 1,
    recipientKeyId: "temporary-memory-recipient",
    expiresAt: NOW + 60_000,
    signerAgentId: AGENT,
  });
  if (attempt.status !== "created" || attempt.attempt.signer === undefined) {
    throw new Error("Temporary Memory signer is unavailable");
  }
  const plan = createDomainForegroundAuthorizationPlan(crypto, {
    authorizationId: "temporary-memory-request",
    policyRevision: 5,
    sessionId: "temporary-memory-session",
    roomId: "temporary-memory-room",
    subjectHumanId: humanId(HUMAN),
    committerDeviceId: cryptoDeviceId(DEVICE),
    committerDeviceSigningGeneration: 1,
    hostAuthorizationRevision: authorizationRevision(7),
    recipientKind: "runtime",
    recipientPrincipalId: "nautilo_task_runtime",
    recipientAuthorizationRevision: authorizationRevision(0),
    recipientRuntimeGeneration: 1,
    recipientKeyId: "temporary-memory-recipient",
    operations: ["decrypt", "encrypt"],
    issuedAt: NOW,
    deadlineAt: NOW + 60_000,
    maximumSecretBytes: 4_096,
    domains: [domain],
  });
  const authorization = await mintDomainForegroundAuthorization(crypto, {
    plan,
    domains: [{ ...domain, domainKey }],
    committerDeviceSigningPrivateKey: issuer.privateKey,
    recipientEncryptionPublicKey: attempt.attempt.recipientPublicKey,
  });
  const authorizationBytes = serializeDomainForegroundAuthorizationV2(
    authorization,
  );
  const baseRequest = createTaskRuntimeBackgroundAuthorizationRequestV1({
    requestId: plan.authorizationId,
    workId: RUN,
    workKind,
    workPurpose: workKind,
    recipientGeneration: 1,
    episodeId: plan.sessionId,
    sourceRoomId: plan.roomId,
    recipientKeyId: plan.recipientKeyId,
    recipientPublicKey: attempt.attempt.recipientPublicKey,
    authorizationPlan: plan,
    issuedAt: NOW,
    deadlineAt: NOW + 60_000,
  });
  const resultObjectId = `task-run-result:v1:${Buffer.from(crypto.hash(
    new TextEncoder().encode(
      `nautilo/task-run-result-crypto-object/v1\n${TASK}\n${RUN}\n1`,
    ),
  )).toString("hex")}`;
  const request = createTaskRuntimeBackgroundAuthorizationRequest(crypto, {
    baseRequest,
    work: {
      taskId: TASK,
      taskRunId: RUN,
      inputObjectId: `task-definition:v1:${"b".repeat(64)}`,
      resultObjectId,
      executionSegment,
      workIdentityHash: bytes(0x45),
    },
    signer: attempt.attempt.signer,
    deviceGroupHead: {
      serverInstanceId: "temporary-memory-server",
      lineageGeneration: 1,
      epoch: 1,
      headDigest: bytes(0x46),
      signingPublicKeyHash: crypto.hash(issuer.publicKey),
    },
    namespaceRequirements: [namespaceRequirement],
  });
  const requestBytes = encodeTaskRuntimeBackgroundAuthorizationRequestV2(
    crypto,
    request,
  );
  const certificateBytes = createTaskRuntimeSignerAuthorization(crypto, {
    requestBytes,
    authorizationBytes,
    expectedAuthorizationPlanBytes:
      serializeDomainForegroundAuthorizationPlanV2(plan),
    expectedAuthorizationHash: crypto.hash(authorizationBytes),
    issuerSigningPrivateKey: issuer.privateKey,
  });
  const result = Object.freeze({
    taskId: TASK,
    taskRunId: RUN,
    contentRevision: 1,
    objectId: resultObjectId,
    signerAgentId: AGENT,
    namespace: Object.freeze({
      namespaceId: NAMESPACE,
      domainId: DOMAIN,
      operations: Object.freeze(["encrypt"] as const),
      expectedAccessRevision: 0,
      expectedPolicyRevision: 5,
    }),
  });
  const durable = new Map<string, VerifiedAgentObject>();
  let storedManifestBytes: Uint8Array | null = null;
  let storedManifestHash: Uint8Array | null = null;
  let exactPublication: ForegroundDomainMemoryExactAccessPublication | null =
    null;
  let storedCertificateBytes: Uint8Array | null = null;
  let permanentRuntimeQueries = 0;
  const opened = await registry.withOpenedGrant({
    requestId: plan.authorizationId,
    workId: RUN,
    recipientGeneration: 1,
    recipientKeyId: plan.recipientKeyId,
    claimId: "temporary-memory-claim",
    claimExpiresAt: NOW + 60_000,
    authorizationBytes,
    current: {
      authorizationId: plan.authorizationId,
      policyRevision: plan.policyRevision,
      sessionId: plan.sessionId,
      roomId: plan.roomId,
      subjectHumanId: plan.subjectHumanId,
      committerDeviceId: plan.committerDeviceId,
      committerDeviceSigningGeneration: plan.committerDeviceSigningGeneration,
      committerDeviceSigningPublicKey: issuer.publicKey,
      committerDeviceActive: true,
      hostAuthorizationRevision: plan.hostAuthorizationRevision,
      recipientKind: plan.recipientKind,
      recipientPrincipalId: plan.recipientPrincipalId,
      recipientAuthorizationRevision: plan.recipientAuthorizationRevision,
      recipientRuntimeGeneration: plan.recipientRuntimeGeneration,
      recipientKeyId: plan.recipientKeyId,
      recipientAuthorized: true,
      domains: plan.domains,
    },
    currentNamespaceRequirements: [namespaceRequirement],
    result,
    certifiedSigning: {
      expectedExecutionSegment: executionSegment,
      requestBytes,
      certificateBytes,
      currentIssuer: taskRuntimeBackgroundAuthorizationIssuer(request),
    },
    operation: (domains, signal, evidence) => withProtectedTaskRuntimeSigner({
      restricted: {
        query: () => {
          permanentRuntimeQueries += 1;
          throw new Error("Permanent Runtime state must not be queried");
        },
      } as never,
      crypto,
      evidence,
      domains,
      use: async signer => {
        const namespaceAuthority = Object.freeze({
          namespaceId: namespaceId(NAMESPACE),
          namespaceAccessRevision: accessRevision(0),
          namespaceKeyGeneration: namespaceGeneration(0),
          domainId: DOMAIN,
          domainKeyGeneration: 1,
          domainAuthorizationRevision: authorizationRevision(3),
          domainHeadDigest: domain.headDigest,
          namespaceHeadDigest: bytes(0x48),
          namespacePublicationDigest: bytes(0x49),
          namespacePublicationSetDigest: bytes(0x4a),
          namespaceAudienceFingerprint: bytes(0x4b),
        });
        const namespace = Object.freeze({
          namespaceKey: bytes(0x47),
          authority: namespaceAuthority,
        });
        const targetNamespaceAuthority = Object.freeze({
          ...namespaceAuthority,
          namespaceId: namespaceId(TARGET_NAMESPACE),
          namespaceHeadDigest: bytes(0x58),
          namespacePublicationDigest: bytes(0x59),
          namespacePublicationSetDigest: bytes(0x5a),
          namespaceAudienceFingerprint: bytes(0x5b),
        });
        const targetNamespace = Object.freeze({
          namespaceKey: bytes(0x57),
          authority: targetNamespaceAuthority,
        });
        const namespaces = new Map<string,
          typeof namespace | typeof targetNamespace>([
          [NAMESPACE, namespace],
          [TARGET_NAMESPACE, targetNamespace],
        ]);
        const entities: Pick<ForegroundAgentEntityCryptoInvocation,
          "signal" | "use" | "useCurrentSet"> = {
          signal,
          use: async input => {
            const selected = namespaces.get(input.entity.namespaceId);
            if (selected === undefined) {
              return Object.freeze({ status: "unavailable" as const,
                reason: "authorization_unavailable" as const });
            }
            return Object.freeze({
              status: "executed" as const,
              value: await input.execute(selected),
            });
          },
          useCurrentSet: async input => {
            const selected = input.namespaceIds.map(id => namespaces.get(id));
            if (selected.some(value => value === undefined)) {
              return Object.freeze({ status: "unavailable" as const,
                reason: "authorization_unavailable" as const });
            }
            return Object.freeze({
              status: "executed" as const,
              value: await input.execute(selected as never),
            });
          },
        };
        const temporarySigner = signer.temporarySigner;
        if (temporarySigner === undefined) {
          throw new Error("Certified Memory signer proof is unavailable");
        }
        const session = createTaskRuntimeDomainMemoryCryptoSession({
          subjectUserId: USER,
          agentId: AGENT,
          evidence,
          crypto,
          entities,
          runtime: signer.runtime,
          signerPublication: signer.signerPublication,
          temporarySigner,
          resolveHistoricalSignerPublicationManager: () => null,
          agentAuthorizationRevision: signer.agentAuthorizationRevision,
          persist: async write => {
            const snapshot = readPreparedTaskRuntimeAgentObjectSnapshot(
              write.prepared,
              evidence,
            );
            const envelopeBytes = snapshot.access.envelopeBytes[0]!;
            const envelope = decodeNamespaceObjectEnvelopeV2(envelopeBytes);
            durable.set(write.prepared.objectId, Object.freeze({
              objectId: write.prepared.objectId,
              accessRevision: 0,
              payloadBytes: snapshot.object.payloadBytes.ciphertext.slice(),
              namespaceEnvelopes: Object.freeze([Object.freeze({
                namespaceId: envelope.context.namespaceId,
                keyGeneration: envelope.context.keyGeneration,
                bindingRevisionAtWrap: envelope.context.bindingRevisionAtWrap,
                envelopeBytes: envelopeBytes.slice(),
              })]),
            }));
            storedManifestBytes = snapshot.access.manifestBytes.slice();
            storedManifestHash = snapshot.access.manifestHash.slice();
            storedCertificateBytes =
              snapshot.access.signerEvidenceBytes?.slice() ?? null;
            return "created";
          },
          read: async request => {
            const stored = durable.get(request.objectId);
            return stored === undefined ? null : Object.freeze({
            ...stored,
            payloadBytes: stored.payloadBytes.slice(),
            namespaceEnvelopes: stored.namespaceEnvelopes.map(entry =>
              Object.freeze({
                ...entry,
                envelopeBytes: entry.envelopeBytes.slice(),
              })
            ),
            });
          },
        });
        const payload = Object.freeze({
          formatVersion: 1 as const,
          type: "preference" as const,
          content: "Use certified Task Memory.",
        });
        const preparedMemory = await session.session.prepare({
          entrypointId: "subagent.scope",
          agentId: AGENT,
          authority: Object.freeze({
            mode: "namespace" as const,
            subjectUserId: USER,
            agentId: AGENT,
            readableNamespaceIds: Object.freeze([NAMESPACE]),
            mutableNamespaceIds: Object.freeze([NAMESPACE]),
            writableNamespaceId: NAMESPACE,
          }),
          plan: Object.freeze({
            operationId: "temporary-memory-write",
            action: "created" as const,
            mutationKind: "save" as const,
            memoryId: MEMORY,
            contentRevision: 1,
            cryptoAccessRevision: 0,
            expectedPriorAccessRevision: 0,
            cryptoObjectId: deriveMemoryCryptoObjectIdV1({
              memoryId: MEMORY,
              contentRevision: 1,
            }),
            requiredNamespaceIds: Object.freeze([NAMESPACE]),
            reservationDigest: bytes(0x4c),
            mutationCommitment: commitMemoryMutationV1({
              kind: "save",
              payload,
            }),
            importance: 0.5,
            createdAt: NOW,
          }),
          content: Object.freeze({ kind: "complete" as const, payload }),
        });
        if (preparedMemory.status !== "success"
          || storedManifestBytes === null || storedManifestHash === null) {
          return preparedMemory;
        }
        const objectId = deriveMemoryCryptoObjectIdV1({
          memoryId: MEMORY,
          contentRevision: 1,
        });
        const exact = createForegroundDomainMemoryExactAccess({
          crypto,
          entities,
          runtime: signer.runtime,
          signerKeyId: agentRuntimeObjectSignerKeyIdV1(
            crypto,
            temporarySigner.signerPublicKey,
          ),
          agentAuthorizationRevision: signer.agentAuthorizationRevision,
          evidence,
          temporarySigner,
          read: async (): Promise<ForegroundDomainMemoryAccessHead | null> => {
            const stored = durable.get(objectId);
            if (stored === undefined) return null;
            const envelope = stored.namespaceEnvelopes[0]!;
            return Object.freeze({
              ...stored,
              payloadBytes: stored.payloadBytes.slice(),
              payloadHash: crypto.hash(stored.payloadBytes),
              accessManifestBytes: storedManifestBytes!.slice(),
              accessManifestHash: storedManifestHash!.slice(),
              namespaceEnvelopes: Object.freeze([
                Object.freeze({
                  ...envelope,
                  envelopeBytes: envelope.envelopeBytes.slice(),
                }),
              ]),
              nativeEntries: Object.freeze([Object.freeze({
                namespaceId: namespaceId(namespaceAuthority.namespaceId),
                keyGeneration: namespaceAuthority.namespaceKeyGeneration,
                namespaceAccessRevision:
                  namespaceAuthority.namespaceAccessRevision,
                headDigest: namespaceAuthority.namespaceHeadDigest.slice(),
                publicationDigest:
                  namespaceAuthority.namespacePublicationDigest.slice(),
                publicationSetDigest:
                  namespaceAuthority.namespacePublicationSetDigest.slice(),
                audienceFingerprint:
                  namespaceAuthority.namespaceAudienceFingerprint.slice(),
                envelopeHash: crypto.hash(envelope.envelopeBytes),
              })]),
            });
          },
        });
        const preparedAccess = await exact.prepare({
          objectId,
          expectedAccessRevision: 0,
          currentNamespaceIds: [NAMESPACE],
          targetNamespaceIds: [NAMESPACE, TARGET_NAMESPACE].sort(),
        });
        if (preparedAccess === null) {
          throw new Error("Certified Memory exact-access preparation failed");
        }
        exactPublication = await exact.authorizeCommit({
          prepared: preparedAccess,
          commit: publication => publication,
        });
        return preparedMemory;
      },
    }),
  });
  expect(opened.status).toBe("opened");
  if (opened.status !== "opened") throw new Error("Certified grant unavailable");
  expect(opened.value.status).toBe("success");
  expect(permanentRuntimeQueries).toBe(0);
  const capturedManifest = (): Uint8Array | null => storedManifestBytes;
  const capturedCertificate = (): Uint8Array | null => storedCertificateBytes;
  const capturedExact = (): ForegroundDomainMemoryExactAccessPublication | null =>
    exactPublication;
  const manifestBytes = capturedManifest();
  const certificate = capturedCertificate();
  const exact = capturedExact();
  expect(certificate).toEqual(certificateBytes);
  if (manifestBytes === null || certificate === null || exact === null) {
    throw new Error("Certified Memory was not stored");
  }
  expect(exact.signerEvidenceBytes).toEqual(certificateBytes);
  now = NOW + 120_000;
  const verified = verifyCommonObjectAccessManifest(crypto, {
    manifestBytes,
    resolveHistoricalHumanDeviceSigningPublicKey: () => null,
    resolveAgentRuntimeSignerPublicKey: () => {
      throw new Error("Legacy signer resolution must not run");
    },
    resolveProcessorSignerAuthorizationBytes: () => null,
    resolveHistoricalProcessorIssuingDevicePublicKey: () => null,
    resolveTaskRuntimeSignerAuthorizationBytes: () => certificate,
    resolveHistoricalTaskRuntimeIssuer: () => issuer.publicKey,
  });
  expect(verified.manifest.signerAuthorizationHash)
    .toEqual(crypto.hash(certificateBytes));
  const verifiedExact = verifyCommonObjectAccessManifest(crypto, {
    manifestBytes: exact.nextManifestBytes,
    resolveHistoricalHumanDeviceSigningPublicKey: () => null,
    resolveAgentRuntimeSignerPublicKey: () => {
      throw new Error("Legacy signer resolution must not run");
    },
    resolveProcessorSignerAuthorizationBytes: () => null,
    resolveHistoricalProcessorIssuingDevicePublicKey: () => null,
    resolveTaskRuntimeSignerAuthorizationBytes: () =>
      exact.signerEvidenceBytes!,
    resolveHistoricalTaskRuntimeIssuer: () => issuer.publicKey,
  });
  expect(verifiedExact.manifest.accessRevision).toBe(accessRevision(1));
  const targetEnvelopeBytes = exact.targetEnvelopeBytes.find(
    value => decodeNamespaceObjectEnvelopeV2(value).context.namespaceId
      === TARGET_NAMESPACE,
  );
  if (targetEnvelopeBytes === undefined) {
    throw new Error("Certified Memory target envelope was not retained");
  }
  const targetEnvelope = decodeNamespaceObjectEnvelopeV2(targetEnvelopeBytes);
  const dek = openObjectDekForNamespace(crypto, bytes(0x57), targetEnvelope);
  const stored = durable.values().next().value;
  if (dek === null || stored === undefined) {
    throw new Error("Certified Memory target envelope cannot be opened");
  }
  const encryptedPayload = decodeEncryptedPayloadV2(stored.payloadBytes);
  const plaintext = decryptObjectPayload(crypto, dek, encryptedPayload);
  expect(plaintext === null ? null : decodeMemoryPayloadV1(plaintext)).toEqual({
    formatVersion: 1,
    type: "preference",
    content: "Use certified Task Memory.",
  });
  dek.fill(0);
  plaintext?.fill(0);
  const substituted = certificateBytes.slice();
  substituted[substituted.length - 1]! ^= 1;
  expect(() => verifyCommonObjectAccessManifest(crypto, {
    manifestBytes: exact.nextManifestBytes,
    resolveHistoricalHumanDeviceSigningPublicKey: () => null,
    resolveAgentRuntimeSignerPublicKey: () => null,
    resolveProcessorSignerAuthorizationBytes: () => null,
    resolveHistoricalProcessorIssuingDevicePublicKey: () => null,
    resolveTaskRuntimeSignerAuthorizationBytes: () => substituted,
    resolveHistoricalTaskRuntimeIssuer: () => issuer.publicKey,
  })).toThrow();
  registry.close();
});
