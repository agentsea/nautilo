import { describe, expect, test } from "bun:test";
import { bytesToHex } from "@noble/hashes/utils.js";

import { agentRuntimeObjectSignerKeyIdV1 } from
  "../../src/agent-runtime/object-signer-v1.ts";
import {
  createTaskRuntimeBackgroundAuthorizationRequestV1,
  destroyTaskRuntimeBackgroundAuthorizationRequestV1,
  encodeTaskRuntimeBackgroundAuthorizationRequestV1,
} from "../../src/background/task-runtime-request-v1.ts";
import {
  decodeTaskRuntimeBackgroundAuthorizationRequestBase,
} from "../../src/background/task-runtime-request-base.ts";
import {
  createTaskRuntimeBackgroundAuthorizationRequestV2,
  decodeTaskRuntimeBackgroundAuthorizationRequestV2,
  destroyTaskRuntimeBackgroundAuthorizationRequestV2,
  encodeTaskRuntimeBackgroundAuthorizationRequestV2,
  isTaskRuntimeBackgroundAuthorizationRequestV2Carrier,
  taskRuntimeBackgroundAuthorizationIssuerV2,
} from "../../src/background/task-runtime-request-v2.ts";
import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  createDomainForegroundAuthorizationPlanV2,
  destroyDomainForegroundAuthorizationPlanV2,
} from "../../src/format/domain-foreground-authorization-v2.ts";
import { authorizationRevision, cryptoDeviceId, humanId } from
  "../../src/v2-types/ids.ts";

const NOW = 1_800_800_000_000;
const TASK = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const encoder = new TextEncoder();
type TaskExecutionWorkKind = "task.execute" | "task.approval_resume"
  | "task.await_reply_resume";

function bytes(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

function resultObjectId(crypto: LatticeCrypto): string {
  return `task-run-result:v1:${bytesToHex(crypto.hash(encoder.encode(
    `nautilo/task-run-result-crypto-object/v1\n${TASK}\n${RUN}\n1`,
  )))}`;
}

async function fixture(
  executionSegment = 1,
  workKind: TaskExecutionWorkKind = "task.execute",
) {
  const crypto = new LatticeCrypto(seededRng(808_101), { now: () => NOW });
  const recipient = await crypto.deriveEncryptionKeyPair(bytes(0x31));
  const device = crypto.generateSigningKeyPair();
  const signer = crypto.generateSigningKeyPair();
  const plan = createDomainForegroundAuthorizationPlanV2(crypto, {
    authorizationId: "request:execute-one", policyRevision: 7,
    sessionId: "episode:execute-one", roomId: "room:source-one",
    subjectHumanId: humanId("human:one"),
    committerDeviceId: cryptoDeviceId("device:one"),
    committerDeviceSigningGeneration: 3,
    hostAuthorizationRevision: authorizationRevision(5),
    recipientKind: "runtime", recipientPrincipalId: "nautilo_task_runtime",
    recipientAuthorizationRevision: authorizationRevision(0),
    recipientRuntimeGeneration: 12, recipientKeyId: "recipient:key-one",
    operations: ["decrypt", "encrypt"], issuedAt: NOW,
    deadlineAt: NOW + 300_000, maximumSecretBytes: 2_048,
    domains: [{
      domainId: "domain:one", sourceNamespaceId: "namespace:source-one",
      participantDigest: bytes(0x11), participantCount: 2, keyClass: "ai",
      domainKeyGeneration: 4, authorizationRevision: authorizationRevision(8),
      headDigest: bytes(0x12), activeNamespaceBindingSetDigest: bytes(0x13),
      activeNamespaceBindingCount: 2,
    }],
  });
  const baseRequest = createTaskRuntimeBackgroundAuthorizationRequestV1({
    requestId: "request:execute-one", workId: RUN,
    workKind, workPurpose: workKind,
    recipientGeneration: 12, episodeId: "episode:execute-one",
    sourceRoomId: "room:source-one", recipientKeyId: "recipient:key-one",
    recipientPublicKey: recipient.publicKey, authorizationPlan: plan,
    issuedAt: NOW, deadlineAt: NOW + 300_000,
  });
  const request = createTaskRuntimeBackgroundAuthorizationRequestV2(crypto, {
    baseRequest,
    work: { taskId: TASK, taskRunId: RUN,
      inputObjectId: `task-definition:v1:${"a".repeat(64)}`,
      resultObjectId: resultObjectId(crypto),
      executionSegment,
      workIdentityHash: bytes(0x21) },
    signer: { agentId: "agent:one", runtimeGeneration: 0,
      signerKeyId: agentRuntimeObjectSignerKeyIdV1(crypto, signer.publicKey),
      signerPublicKey: signer.publicKey },
    deviceGroupHead: { serverInstanceId: "server:one", lineageGeneration: 2,
      epoch: 9, headDigest: bytes(0x22),
      signingPublicKeyHash: crypto.hash(device.publicKey) },
    namespaceRequirements: [{ ordinal: 0, namespaceId: "namespace:source-one",
      domainId: "domain:one", operations: ["decrypt", "encrypt"],
      expectedAccessRevision: 6, expectedPolicyRevision: 7 }],
  });
  recipient.privateKey.fill(0); recipient.publicKey.fill(0);
  return { crypto, device, signer, plan, baseRequest, request };
}

describe("Task Runtime background authorization request v2", () => {
  test("round-trips the canonical segment-one request and reconstructs issuer", async () => {
    const f = await fixture();
    try {
      const encoded = encodeTaskRuntimeBackgroundAuthorizationRequestV2(
        f.crypto, f.request,
      );
      expect(bytesToHex(f.crypto.hash(encoded))).toBe(
        "54e3b71d5c5fea70db202bd7e2a6683de29eecbb8b3349c5ad261ece6563c4f5",
      );
      expect(isTaskRuntimeBackgroundAuthorizationRequestV2Carrier(encoded))
        .toBe(true);
      const decoded = decodeTaskRuntimeBackgroundAuthorizationRequestV2(
        f.crypto, encoded,
      );
      expect(decoded).not.toBeNull();
      expect(decoded?.baseRequest.requestId).toBe("request:execute-one");
      expect(decoded?.work).toEqual(f.request.work);
      expect(decoded?.namespaceRequirements).toEqual(f.request.namespaceRequirements);
      expect(encodeTaskRuntimeBackgroundAuthorizationRequestV1(
        decoded!.baseRequest,
      )).toEqual(encodeTaskRuntimeBackgroundAuthorizationRequestV1(
        f.baseRequest,
      ));
      const issuer = taskRuntimeBackgroundAuthorizationIssuerV2(decoded!);
      expect(issuer).toEqual({ humanId: "human:one", deviceId: "device:one",
        deviceGeneration: 3, serverInstanceId: "server:one",
        lineageGeneration: 2, epoch: 9, securityRevision: 5,
        headDigest: bytes(0x22), signingPublicKeyHash: f.crypto.hash(f.device.publicKey) });
      issuer.headDigest.fill(0); issuer.signingPublicKeyHash.fill(0);
      destroyTaskRuntimeBackgroundAuthorizationRequestV2(decoded!);
    } finally {
      destroyTaskRuntimeBackgroundAuthorizationRequestV2(f.request);
      destroyTaskRuntimeBackgroundAuthorizationRequestV1(f.baseRequest);
      destroyDomainForegroundAuthorizationPlanV2(f.plan);
    }
  });

  test("round-trips a resumed execution segment and rejects invalid segments", async () => {
    const f = await fixture(2);
    try {
      const encoded = encodeTaskRuntimeBackgroundAuthorizationRequestV2(
        f.crypto,
        f.request,
      );
      const decoded = decodeTaskRuntimeBackgroundAuthorizationRequestV2(
        f.crypto,
        encoded,
      );
      expect(decoded?.work.executionSegment).toBe(2);
      expect(decoded?.work.resultObjectId).toBe(resultObjectId(f.crypto));
      destroyTaskRuntimeBackgroundAuthorizationRequestV2(decoded!);

      for (const executionSegment of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => encodeTaskRuntimeBackgroundAuthorizationRequestV2(
          f.crypto,
          { ...f.request, work: { ...f.request.work, executionSegment } },
        )).toThrow();
      }
    } finally {
      destroyTaskRuntimeBackgroundAuthorizationRequestV2(f.request);
      destroyTaskRuntimeBackgroundAuthorizationRequestV1(f.baseRequest);
      destroyDomainForegroundAuthorizationPlanV2(f.plan);
    }
  });

  test.each([
    ["task.approval_resume", 2],
    ["task.await_reply_resume", 3],
  ] as const)("round-trips %s execution segment %d", async (
    workKind,
    executionSegment,
  ) => {
    const f = await fixture(executionSegment, workKind);
    try {
      const encoded = encodeTaskRuntimeBackgroundAuthorizationRequestV2(
        f.crypto,
        f.request,
      );
      const decoded = decodeTaskRuntimeBackgroundAuthorizationRequestV2(
        f.crypto,
        encoded,
      );
      expect(decoded?.baseRequest.workKind).toBe(workKind);
      expect(decoded?.baseRequest.workPurpose).toBe(workKind);
      expect(decoded?.work.executionSegment).toBe(executionSegment);
      expect(decoded?.work.resultObjectId).toBe(resultObjectId(f.crypto));
      destroyTaskRuntimeBackgroundAuthorizationRequestV2(decoded!);
    } finally {
      destroyTaskRuntimeBackgroundAuthorizationRequestV2(f.request);
      destroyTaskRuntimeBackgroundAuthorizationRequestV1(f.baseRequest);
      destroyDomainForegroundAuthorizationPlanV2(f.plan);
    }
  });

  test("rejects signer, work, scope, and issuer-head substitutions", async () => {
    const f = await fixture();
    try {
      const changes = [
        { ...f.request, signer: { ...f.request.signer, runtimeGeneration: 1 as 0 } },
        { ...f.request, signer: { ...f.request.signer, signerKeyId: `agent_runtime_signer_${"0".repeat(64)}` } },
        { ...f.request, signer: { ...f.request.signer,
          signerPublicKey: new Uint8Array(32).fill(0x77) } },
        { ...f.request, work: { ...f.request.work, taskRunId: TASK } },
        { ...f.request, work: { ...f.request.work, resultObjectId: `task-run-result:v1:${"0".repeat(64)}` } },
        { ...f.request, work: { ...f.request.work, inputObjectId: "foreign" } },
        { ...f.request, namespaceRequirements: [{ ...f.request.namespaceRequirements[0]!, domainId: "domain:foreign" }] },
        { ...f.request, namespaceRequirements: [{ ...f.request.namespaceRequirements[0]!, operations: ["encrypt", "decrypt"] as ["encrypt", "decrypt"] }] },
        { ...f.request, namespaceRequirements: [{ ...f.request.namespaceRequirements[0]!, expectedPolicyRevision: 8 }] },
        { ...f.request, namespaceRequirements: [
          { ...f.request.namespaceRequirements[0]!, ordinal: 0,
            namespaceId: "namespace:z" },
          { ...f.request.namespaceRequirements[0]!, ordinal: 1,
            namespaceId: "namespace:a" },
        ] },
        { ...f.request, deviceGroupHead: { ...f.request.deviceGroupHead, headDigest: new Uint8Array(31) } },
      ];
      for (const changed of changes) {
        expect(() => encodeTaskRuntimeBackgroundAuthorizationRequestV2(
          f.crypto, changed,
        )).toThrow();
      }
    } finally {
      destroyTaskRuntimeBackgroundAuthorizationRequestV2(f.request);
      destroyTaskRuntimeBackgroundAuthorizationRequestV1(f.baseRequest);
      destroyDomainForegroundAuthorizationPlanV2(f.plan);
    }
  });

  test("fails closed for mismatched or excluded work purposes and malformed wire", async () => {
    const f = await fixture();
    try {
      const encoded = encodeTaskRuntimeBackgroundAuthorizationRequestV2(
        f.crypto, f.request,
      );
      const otherBase = { ...f.baseRequest, workKind: "task.dispatch" as const,
        workPurpose: "task.dispatch" as const };
      expect(() => createTaskRuntimeBackgroundAuthorizationRequestV2(f.crypto, {
        ...f.request, baseRequest: otherBase,
      })).toThrow("only Task execution work");
      const mismatchedBase = {
        ...f.baseRequest,
        workKind: "task.approval_resume" as const,
        workPurpose: "task.await_reply_resume" as const,
      };
      expect(() => createTaskRuntimeBackgroundAuthorizationRequestV2(f.crypto, {
        ...f.request,
        baseRequest: mismatchedBase,
      })).toThrow("work kind and purpose disagree");
      for (const workKind of [
        "task.dispatch",
        "task.cancel_result",
        "task.deliver_message",
        "task.deliver_result",
        "task.delivery_wake",
      ] as const) {
        expect(() => createTaskRuntimeBackgroundAuthorizationRequestV2(
          f.crypto,
          {
            ...f.request,
            baseRequest: {
              ...f.baseRequest,
              workKind,
              workPurpose: workKind,
            },
          },
        )).toThrow();
      }
      expect(decodeTaskRuntimeBackgroundAuthorizationRequestV2(
        f.crypto, Uint8Array.from([...encoded, 0]),
      )).toBeNull();
      const changed = encoded.slice(); changed[0] = changed[0]! ^ 1;
      expect(decodeTaskRuntimeBackgroundAuthorizationRequestV2(
        f.crypto, changed,
      )).toBeNull();
      expect(isTaskRuntimeBackgroundAuthorizationRequestV2Carrier(changed))
        .toBe(false);
      const versionOffset = 4 + new TextEncoder().encode(
        "nautilo/lattice-crypto/task-runtime-background-authorization-request/v2",
      ).length;
      const badVersion = encoded.slice(); badVersion[versionOffset + 3] = 3;
      expect(isTaskRuntimeBackgroundAuthorizationRequestV2Carrier(badVersion))
        .toBe(true);
      expect(decodeTaskRuntimeBackgroundAuthorizationRequestV2(
        f.crypto, badVersion,
      )).toBeNull();
      expect(isTaskRuntimeBackgroundAuthorizationRequestV2Carrier(
        encoded.slice(0, versionOffset),
      )).toBe(true);
      expect(isTaskRuntimeBackgroundAuthorizationRequestV2Carrier(
        encoded.slice(0, versionOffset - 1),
      )).toBe(false);
    } finally {
      destroyTaskRuntimeBackgroundAuthorizationRequestV2(f.request);
      destroyTaskRuntimeBackgroundAuthorizationRequestV1(f.baseRequest);
      destroyDomainForegroundAuthorizationPlanV2(f.plan);
    }
  });

  test("projects canonical V2 base coordinates and never downgrades malformed V2", async () => {
    const f = await fixture();
    try {
      const v1Bytes = encodeTaskRuntimeBackgroundAuthorizationRequestV1(
        f.baseRequest,
      );
      const legacy = decodeTaskRuntimeBackgroundAuthorizationRequestBase(
        f.crypto,
        v1Bytes,
      );
      expect(legacy).not.toBeNull();
      expect(encodeTaskRuntimeBackgroundAuthorizationRequestV1(legacy!))
        .toEqual(v1Bytes);
      destroyTaskRuntimeBackgroundAuthorizationRequestV1(legacy!);

      const v2Bytes = encodeTaskRuntimeBackgroundAuthorizationRequestV2(
        f.crypto,
        f.request,
      );
      const projected = decodeTaskRuntimeBackgroundAuthorizationRequestBase(
        f.crypto,
        v2Bytes,
      );
      expect(projected).not.toBeNull();
      expect(encodeTaskRuntimeBackgroundAuthorizationRequestV1(projected!))
        .toEqual(v1Bytes);
      destroyTaskRuntimeBackgroundAuthorizationRequestV1(projected!);

      const malformed = v2Bytes.slice();
      malformed[malformed.length - 1] = malformed[malformed.length - 1]! ^ 1;
      expect(isTaskRuntimeBackgroundAuthorizationRequestV2Carrier(malformed))
        .toBe(true);
      expect(decodeTaskRuntimeBackgroundAuthorizationRequestBase(
        f.crypto,
        malformed,
      )).toBeNull();
    } finally {
      destroyTaskRuntimeBackgroundAuthorizationRequestV2(f.request);
      destroyTaskRuntimeBackgroundAuthorizationRequestV1(f.baseRequest);
      destroyDomainForegroundAuthorizationPlanV2(f.plan);
    }
  });
});
