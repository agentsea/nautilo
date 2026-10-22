import { bytesToHex } from "@noble/hashes/utils.js";
import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import { TaskRuntimeRecipientRegistryV1, withTaskRuntimeTemporarySignerV1, type TaskRuntimeTemporarySignerV1 } from "../../src/background/task-runtime-recipient-registry-v1.ts";
import { createTaskRuntimeBackgroundAuthorizationRequestV1 } from "../../src/background/task-runtime-request-v1.ts";
import { createTaskRuntimeBackgroundAuthorizationRequestV3, encodeTaskRuntimeBackgroundAuthorizationRequestV3, taskRuntimeBackgroundAuthorizationIssuerV3 } from "../../src/background/task-runtime-request-v3.ts";
import { createTaskRuntimeSignerAuthorizationV2 } from "../../src/background/task-runtime-signer-authorization-v1.ts";
import type { TaskRuntimeWakeForegroundEvidenceV1 } from "../../src/background/task-runtime-wake-foreground-evidence-v1.ts";
import { createDomainForegroundAuthorizationPlanV2, mintDomainForegroundAuthorizationV2, serializeDomainForegroundAuthorizationPlanV2, serializeDomainForegroundAuthorizationV2 } from "../../src/format/domain-foreground-authorization-v2.ts";
import { agentRuntimeGeneration, authorizationRevision, cryptoDeviceId, humanId } from "../../src/v2-types/ids.ts";

export const PUBLICATION_NOW = 1_930_000_000_000;
export const PUBLICATION_NAMESPACE = "33333333-3333-4333-8333-333333333333";
const TASK = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const JOB = "76e64205-be03-5f38-b8ea-5f8c7b5f4399";
const ROOM = "44444444-4444-4444-8444-444444444444";
const SESSION = "55555555-5555-4555-8555-555555555555";
const AGENT = "agent:publication";
const REQUEST = `task-wake-authorization:${JOB}`;
export const publicationBytes = (fill: number) => new Uint8Array(32).fill(fill);

/** Real registry custody and Device certificate, with no permanent Agent state. */
export async function withPublicationSigner<Value>(use: (input: Readonly<{
  crypto: LatticeCrypto;
  evidence: TaskRuntimeWakeForegroundEvidenceV1;
  signer: TaskRuntimeTemporarySignerV1;
  domain: ReturnType<typeof domainFacts>;
  abort(): void;
}>) => Value | Promise<Value>, options: Readonly<{
  recipientGeneration?: number;
}> = {}): Promise<Value> {
  const recipientGeneration = options.recipientGeneration ?? 0;
  const crypto = new LatticeCrypto(seededRng(818_181), { now: () => PUBLICATION_NOW });
  const device = crypto.generateSigningKeyPair();
  const registry = new TaskRuntimeRecipientRegistryV1(crypto, { now: () => PUBLICATION_NOW });
  const attempt = await registry.createAttempt({ requestId: REQUEST, workId: JOB,
    recipientGeneration, recipientKeyId: "recipient:publication", expiresAt: PUBLICATION_NOW + 60_000, signerAgentId: AGENT });
  if (attempt.status !== "created" || attempt.attempt.signer === undefined) throw new Error("fixture recipient");
  const recipient = attempt.attempt;
  const domain = domainFacts();
  const plan = createDomainForegroundAuthorizationPlanV2(crypto, {
    authorizationId: REQUEST, policyRevision: 7, sessionId: SESSION, roomId: ROOM,
    subjectHumanId: humanId("human:publication"), committerDeviceId: cryptoDeviceId("device:publication"),
    committerDeviceSigningGeneration: 1, hostAuthorizationRevision: authorizationRevision(5),
    recipientKind: "runtime", recipientPrincipalId: "nautilo_task_runtime",
    recipientAuthorizationRevision: authorizationRevision(0),
    recipientRuntimeGeneration: agentRuntimeGeneration(recipientGeneration),
    recipientKeyId: recipient.recipientKeyId, operations: ["decrypt", "encrypt"],
    issuedAt: PUBLICATION_NOW, deadlineAt: PUBLICATION_NOW + 60_000, maximumSecretBytes: 2048, domains: [domain],
  });
  const base = createTaskRuntimeBackgroundAuthorizationRequestV1({ requestId: REQUEST, workId: JOB,
    workKind: "task.delivery_wake", workPurpose: "task.delivery_wake", recipientGeneration,
    episodeId: plan.sessionId, sourceRoomId: plan.roomId, recipientKeyId: recipient.recipientKeyId,
    recipientPublicKey: recipient.recipientPublicKey, authorizationPlan: plan,
    issuedAt: plan.issuedAt, deadlineAt: plan.deadlineAt });
  const namespaces = [{ ordinal: 0, namespaceId: PUBLICATION_NAMESPACE, domainId: domain.domainId,
    expectedAccessRevision: 4, expectedPolicyRevision: 7, operations: ["decrypt", "encrypt"] as const }];
  const request = createTaskRuntimeBackgroundAuthorizationRequestV3(crypto, { baseRequest: base,
    work: { kind: "task.delivery_wake", taskId: TASK, taskRunId: RUN, jobId: JOB,
      contentRevision: 1, workIdentityHash: publicationBytes(0x71) }, signer: recipient.signer!,
    deviceGroupHead: { serverInstanceId: "server:publication", lineageGeneration: 1, epoch: 1,
      headDigest: publicationBytes(0x72), signingPublicKeyHash: crypto.hash(device.publicKey) },
    namespaceRequirements: namespaces });
  const authorization = await mintDomainForegroundAuthorizationV2(crypto, { plan,
    domains: [{ ...domain, domainKey: publicationBytes(0x51) }],
    committerDeviceSigningPrivateKey: device.privateKey, recipientEncryptionPublicKey: recipient.recipientPublicKey });
  const authorizationBytes = serializeDomainForegroundAuthorizationV2(authorization);
  const requestBytes = encodeTaskRuntimeBackgroundAuthorizationRequestV3(crypto, request);
  const certificateBytes = createTaskRuntimeSignerAuthorizationV2(crypto, {
    requestBytes, authorizationBytes, expectedAuthorizationPlanBytes: serializeDomainForegroundAuthorizationPlanV2(plan),
    expectedAuthorizationHash: crypto.hash(authorizationBytes), issuerSigningPrivateKey: device.privateKey });
  const resultObjectId = `task-run-result:v1:${bytesToHex(crypto.hash(new TextEncoder().encode(
    `nautilo/task-run-result-crypto-object/v1\n${TASK}\n${RUN}\n1`)))}`;
  const bindingId = `task-run-output:${RUN}`;
  const operationId = `task-run-delivery-wake:${RUN}`;
  const controller = new AbortController();
  try {
    const opened = await registry.withOpenedRunResultReadGrant({ requestId: REQUEST, workId: JOB,
      workKind: "task.delivery_wake", recipientGeneration, recipientKeyId: recipient.recipientKeyId,
      claimId: "claim:publication", claimExpiresAt: plan.deadlineAt, authorizationBytes,
      current: { authorizationId: REQUEST, policyRevision: 7, sessionId: plan.sessionId, roomId: plan.roomId,
        subjectHumanId: plan.subjectHumanId, committerDeviceId: plan.committerDeviceId,
        committerDeviceSigningGeneration: 1, committerDeviceSigningPublicKey: device.publicKey,
        committerDeviceActive: true, hostAuthorizationRevision: authorizationRevision(5), recipientKind: "runtime",
        recipientPrincipalId: "nautilo_task_runtime", recipientAuthorizationRevision: authorizationRevision(0),
        recipientRuntimeGeneration: agentRuntimeGeneration(recipientGeneration),
        recipientKeyId: recipient.recipientKeyId, recipientAuthorized: true, domains: [domain] },
      requesterHumanId: plan.subjectHumanId,
      result: { taskId: TASK, taskRunId: RUN, contentRevision: 1, terminalStatus: "completed", objectId: resultObjectId,
        cryptoAccessRevision: 0, genesisManifestHash: publicationBytes(0x73), signerAgentId: AGENT,
        namespace: { namespaceId: PUBLICATION_NAMESPACE, domainId: domain.domainId, expectedAccessRevision: 4,
          expectedPolicyRevision: 7, operations: ["decrypt"] } },
      invocation: { kind: "wake", jobId: JOB, bindingId, operationId, roomId: plan.roomId, sessionId: plan.sessionId,
        reference: { kind: "protected_task_delivery_v1", taskId: TASK, taskRunId: RUN, bindingId,
          resultObjectId, wakeOperationId: operationId } },
      currentNamespaceRequirements: namespaces, currentForegroundNamespaceRequirements: namespaces,
      certifiedSigning: { requestBytes, certificateBytes, currentIssuer: taskRuntimeBackgroundAuthorizationIssuerV3(request),
        expectedPublication: request.work }, signal: controller.signal,
      operation: async (_partitions, _signal, _read, evidence) => {
        if (evidence === undefined || evidence === null) throw new Error("fixture wake evidence");
        return withTaskRuntimeTemporarySignerV1(evidence, signer => use({ crypto, signer, evidence,
          domain, abort: () => controller.abort(new Error("fixture aborted")) }));
      },
    });
    if (opened.status !== "opened") throw new Error(`fixture did not open: ${opened.reason}`);
    return opened.value;
  } finally {
    registry.close(); device.privateKey.fill(0); device.publicKey.fill(0);
    certificateBytes.fill(0); requestBytes.fill(0); authorizationBytes.fill(0);
  }
}

function domainFacts() {
  return { domainId: "domain:publication", sourceNamespaceId: PUBLICATION_NAMESPACE,
    participantDigest: publicationBytes(0x61), participantCount: 1, keyClass: "ai" as const,
    domainKeyGeneration: 3, authorizationRevision: authorizationRevision(4), headDigest: publicationBytes(0x62),
    activeNamespaceBindingCount: 1, activeNamespaceBindingSetDigest: publicationBytes(0x63) };
}
