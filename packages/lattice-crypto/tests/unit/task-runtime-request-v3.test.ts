import { describe, expect, test } from "bun:test";
import { bytesToHex } from "@noble/hashes/utils.js";

import { agentRuntimeObjectSignerKeyIdV1 } from
  "../../src/agent-runtime/object-signer-v1.ts";
import {
  createTaskRuntimeBackgroundAuthorizationRequestV1,
  destroyTaskRuntimeBackgroundAuthorizationRequestV1,
} from "../../src/background/task-runtime-request-v1.ts";
import {
  decodeTaskRuntimeBackgroundAuthorizationRequestV2,
  encodeTaskRuntimeBackgroundAuthorizationRequestV2,
  MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_WIRE_BYTES_V2,
} from "../../src/background/task-runtime-request-v2.ts";
import {
  createTaskRuntimeBackgroundAuthorizationRequestV3,
  decodeTaskRuntimeBackgroundAuthorizationRequestV3,
  destroyTaskRuntimeBackgroundAuthorizationRequestV3,
  encodeTaskRuntimeBackgroundAuthorizationRequestV3,
  isTaskRuntimeBackgroundAuthorizationRequestV3Carrier,
  MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_WIRE_BYTES_V3,
  taskRuntimeBackgroundAuthorizationIssuerV3,
  type TaskRuntimePublicationWorkBindingV3,
} from "../../src/background/task-runtime-request-v3.ts";
import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  createDomainForegroundAuthorizationPlanV2,
  destroyDomainForegroundAuthorizationPlanV2,
} from "../../src/format/domain-foreground-authorization-v2.ts";
import { authorizationRevision, cryptoDeviceId, humanId } from
  "../../src/v2-types/ids.ts";

const NOW = 1_800_900_000_000;
const TASK = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";
const MESSAGE = `message:v2:${"a".repeat(64)}`;

function bytes(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

function work(
  kind: TaskRuntimePublicationWorkBindingV3["kind"],
  wakeRevision: 1 | 2 = 1,
): TaskRuntimePublicationWorkBindingV3 {
  const common = {
    taskId: TASK,
    taskRunId: RUN,
    workIdentityHash: bytes(0x41),
  };
  switch (kind) {
    case "task.cancel_result":
      return { ...common, kind, contentRevision: 2 };
    case "task.deliver_result":
      return { ...common, kind, contentRevision: 1 };
    case "task.deliver_message":
      return { ...common, kind, contentRevision: 2, messageObjectId: MESSAGE };
    case "task.delivery_wake":
      return { ...common, kind, contentRevision: wakeRevision, jobId: JOB };
  }
}

async function fixture(
  kind: TaskRuntimePublicationWorkBindingV3["kind"],
  wakeRevision: 1 | 2 = 1,
) {
  const crypto = new LatticeCrypto(seededRng(809_101), { now: () => NOW });
  const recipient = await crypto.deriveEncryptionKeyPair(bytes(0x31));
  const device = crypto.generateSigningKeyPair();
  const signer = crypto.generateSigningKeyPair();
  const operations = kind === "task.cancel_result" || kind === "task.deliver_message"
    ? ["encrypt"] as const
    : ["decrypt", "encrypt"] as const;
  const plan = createDomainForegroundAuthorizationPlanV2(crypto, {
    authorizationId: `request:${kind}`, policyRevision: 7,
    sessionId: "episode:publication-one", roomId: "room:source-one",
    subjectHumanId: humanId("human:one"),
    committerDeviceId: cryptoDeviceId("device:one"),
    committerDeviceSigningGeneration: 3,
    hostAuthorizationRevision: authorizationRevision(5),
    recipientKind: "runtime", recipientPrincipalId: "nautilo_task_runtime",
    recipientAuthorizationRevision: authorizationRevision(0),
    recipientRuntimeGeneration: 12, recipientKeyId: "recipient:key-one",
    operations, issuedAt: NOW, deadlineAt: NOW + 300_000,
    maximumSecretBytes: 2_048,
    domains: [{
      domainId: "domain:one", sourceNamespaceId: "namespace:source-one",
      participantDigest: bytes(0x11), participantCount: 2, keyClass: "ai",
      domainKeyGeneration: 4, authorizationRevision: authorizationRevision(8),
      headDigest: bytes(0x12), activeNamespaceBindingSetDigest: bytes(0x13),
      activeNamespaceBindingCount: 2,
    }],
  });
  const baseRequest = createTaskRuntimeBackgroundAuthorizationRequestV1({
    requestId: `request:${kind}`,
    workId: kind === "task.delivery_wake" ? JOB : RUN,
    workKind: kind,
    workPurpose: kind,
    recipientGeneration: 12,
    episodeId: "episode:publication-one", sourceRoomId: "room:source-one",
    recipientKeyId: "recipient:key-one", recipientPublicKey: recipient.publicKey,
    authorizationPlan: plan, issuedAt: NOW, deadlineAt: NOW + 300_000,
  });
  const workInput = work(kind, wakeRevision);
  const signerPublicKey = signer.publicKey.slice();
  const headDigest = bytes(0x42);
  const signingPublicKeyHash = crypto.hash(device.publicKey);
  const request = createTaskRuntimeBackgroundAuthorizationRequestV3(crypto, {
    baseRequest,
    work: workInput,
    signer: {
      agentId: "agent:one", runtimeGeneration: 0,
      signerKeyId: agentRuntimeObjectSignerKeyIdV1(crypto, signerPublicKey),
      signerPublicKey,
    },
    deviceGroupHead: {
      serverInstanceId: "server:one", lineageGeneration: 2, epoch: 9,
      headDigest, signingPublicKeyHash,
    },
    namespaceRequirements: [{
      ordinal: 0, namespaceId: "namespace:source-one", domainId: "domain:one",
      operations, expectedAccessRevision: 6, expectedPolicyRevision: 7,
    }],
  });
  recipient.privateKey.fill(0);
  recipient.publicKey.fill(0);
  return {
    crypto, device, signer, plan, baseRequest, request,
    inputs: { workInput, signerPublicKey, headDigest, signingPublicKeyHash },
  };
}

function cleanup(value: Awaited<ReturnType<typeof fixture>>): void {
  destroyTaskRuntimeBackgroundAuthorizationRequestV3(value.request);
  destroyTaskRuntimeBackgroundAuthorizationRequestV1(value.baseRequest);
  destroyDomainForegroundAuthorizationPlanV2(value.plan);
  value.device.privateKey.fill(0);
  value.device.publicKey.fill(0);
  value.signer.privateKey.fill(0);
  value.signer.publicKey.fill(0);
}

describe("Task Runtime background authorization request v3", () => {
  test.each([
    ["task.cancel_result", 2,
      "000b2104cb27763c62192fcd46ab3c8a6882c4b2b8c8770f00e5a9879f002587"],
    ["task.deliver_result", 1,
      "171f93c4084a4484cee619f0a722846cc9bf02d4034b16b2ec7753fb35cd739f"],
    ["task.deliver_message", 2,
      "8f2fdf272e86bfff4dfbcd3196c6cf77a60e79de2b44c1bec0c80e0af40994b1"],
    ["task.delivery_wake", 1,
      "d29cc159763860f57e561beb08de14939cb39240176a5bbb7ec40a2ad5a55525"],
    ["task.delivery_wake", 2,
      "8f3475027394ad169e2d8bad608f9815cecd0b3c999330753593ae48cee56bf2"],
  ] as const)("round-trips canonical %s revision %d", async (
    kind,
    contentRevision,
    expectedHash,
  ) => {
    const f = await fixture(kind, contentRevision);
    try {
      const encoded = encodeTaskRuntimeBackgroundAuthorizationRequestV3(
        f.crypto, f.request,
      );
      expect(encoded.length).toBeLessThanOrEqual(
        MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_WIRE_BYTES_V3,
      );
      expect(isTaskRuntimeBackgroundAuthorizationRequestV3Carrier(encoded)).toBe(true);
      const decoded = decodeTaskRuntimeBackgroundAuthorizationRequestV3(
        f.crypto, encoded,
      );
      expect(decoded).not.toBeNull();
      expect(decoded?.work).toEqual(f.request.work);
      expect(decoded?.baseRequest.workKind).toBe(kind);
      expect(encodeTaskRuntimeBackgroundAuthorizationRequestV3(f.crypto, decoded!))
        .toEqual(encoded);
      const issuer = taskRuntimeBackgroundAuthorizationIssuerV3(decoded!);
      expect(issuer).toEqual({
        humanId: "human:one", deviceId: "device:one", deviceGeneration: 3,
        serverInstanceId: "server:one", lineageGeneration: 2, epoch: 9,
        securityRevision: 5, headDigest: bytes(0x42),
        signingPublicKeyHash: f.crypto.hash(f.device.publicKey),
      });
      issuer.headDigest.fill(0);
      issuer.signingPublicKeyHash.fill(0);
      expect(bytesToHex(f.crypto.hash(encoded))).toBe(expectedHash);
      destroyTaskRuntimeBackgroundAuthorizationRequestV3(decoded!);
    } finally {
      cleanup(f);
    }
  });

  test("keeps the derived wire bound below V2 without increasing a limit", () => {
    expect(MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_WIRE_BYTES_V3)
      .toBe(MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_WIRE_BYTES_V2 - 128);
    expect(decodeTaskRuntimeBackgroundAuthorizationRequestV3(
      new LatticeCrypto(seededRng(1)),
      new Uint8Array(
        MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_WIRE_BYTES_V3 + 1,
      ),
    )).toBeNull();
  });

  test("rejects variant, coordinate, revision, and authority substitutions", async () => {
    const f = await fixture("task.deliver_message");
    try {
      const changes: unknown[] = [
        { ...f.request, work: { ...f.request.work, taskRunId: TASK } },
        { ...f.request, work: { ...f.request.work, contentRevision: 1 } },
        { ...f.request, work: { ...f.request.work,
          messageObjectId: `message:v2:${"A".repeat(64)}` } },
        { ...f.request, work: { ...f.request.work, jobId: JOB } },
        { ...f.request, work: { ...f.request.work,
          workIdentityHash: new Uint8Array(31) } },
        { ...f.request, baseRequest: { ...f.request.baseRequest, workId: TASK } },
        { ...f.request, baseRequest: { ...f.request.baseRequest,
          workKind: "task.cancel_result", workPurpose: "task.cancel_result" } },
        { ...f.request, signer: { ...f.request.signer, runtimeGeneration: 1 } },
        { ...f.request, signer: { ...f.request.signer,
          signerKeyId: `agent_runtime_signer_${"0".repeat(64)}` } },
        { ...f.request, namespaceRequirements: [{
          ...f.request.namespaceRequirements[0]!, expectedPolicyRevision: 8,
        }] },
        { ...f.request, deviceGroupHead: {
          ...f.request.deviceGroupHead, headDigest: new Uint8Array(31),
        } },
      ];
      for (const changed of changes) {
        expect(() => encodeTaskRuntimeBackgroundAuthorizationRequestV3(
          f.crypto,
          changed as typeof f.request,
        )).toThrow();
      }

      const wake = await fixture("task.delivery_wake", 1);
      try {
        if (wake.request.work.kind !== "task.delivery_wake") {
          throw new Error("wake fixture work binding is invalid");
        }
        const wakeWork = wake.request.work;
        expect(() => encodeTaskRuntimeBackgroundAuthorizationRequestV3(
          wake.crypto,
          { ...wake.request, work: { ...wakeWork, jobId: RUN } },
        )).toThrow();
        expect(() => encodeTaskRuntimeBackgroundAuthorizationRequestV3(
          wake.crypto,
          { ...wake.request, work: {
            ...wakeWork, contentRevision: 3 as 1,
          } },
        )).toThrow();
      } finally {
        cleanup(wake);
      }
    } finally {
      cleanup(f);
    }
  });

  test("rejects every truncation, trailing bytes, and another codec version", async () => {
    const f = await fixture("task.delivery_wake", 2);
    try {
      const encoded = encodeTaskRuntimeBackgroundAuthorizationRequestV3(
        f.crypto, f.request,
      );
      for (let length = 0; length < encoded.length; length += 1) {
        expect(decodeTaskRuntimeBackgroundAuthorizationRequestV3(
          f.crypto, encoded.slice(0, length),
        )).toBeNull();
      }
      expect(decodeTaskRuntimeBackgroundAuthorizationRequestV3(
        f.crypto, Uint8Array.from([...encoded, 0]),
      )).toBeNull();
      expect(decodeTaskRuntimeBackgroundAuthorizationRequestV2(f.crypto, encoded))
        .toBeNull();

      const changedDomain = encoded.slice();
      changedDomain[4] = changedDomain[4]! ^ 1;
      expect(isTaskRuntimeBackgroundAuthorizationRequestV3Carrier(changedDomain))
        .toBe(false);
      const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
      let offset = 4 + view.getUint32(0);
      offset += 4;
      offset += 4 + view.getUint32(offset);
      offset += 4 + view.getUint32(offset);
      const changedDiscriminator = encoded.slice();
      changedDiscriminator[offset + 3] = 9;
      expect(isTaskRuntimeBackgroundAuthorizationRequestV3Carrier(
        changedDiscriminator,
      )).toBe(true);
      expect(decodeTaskRuntimeBackgroundAuthorizationRequestV3(
        f.crypto, changedDiscriminator,
      )).toBeNull();
    } finally {
      cleanup(f);
    }
  });

  test("copies caller-owned buffers and wipes only request-owned copies", async () => {
    const f = await fixture("task.cancel_result");
    const requestWorkHash = f.request.work.workIdentityHash;
    const requestSignerKey = f.request.signer.signerPublicKey;
    const requestHead = f.request.deviceGroupHead.headDigest;
    const requestSigningHash = f.request.deviceGroupHead.signingPublicKeyHash;
    try {
      f.inputs.workInput.workIdentityHash.fill(0x91);
      f.inputs.signerPublicKey.fill(0x92);
      f.inputs.headDigest.fill(0x93);
      f.inputs.signingPublicKeyHash.fill(0x94);
      expect(f.request.work.workIdentityHash).toEqual(bytes(0x41));
      expect(f.request.deviceGroupHead.headDigest).toEqual(bytes(0x42));
      expect(f.request.signer.signerPublicKey).not.toEqual(f.inputs.signerPublicKey);
      destroyTaskRuntimeBackgroundAuthorizationRequestV3(f.request);
      expect(requestWorkHash).toEqual(new Uint8Array(32));
      expect(requestSignerKey).toEqual(new Uint8Array(32));
      expect(requestHead).toEqual(new Uint8Array(32));
      expect(requestSigningHash).toEqual(new Uint8Array(32));
      expect(f.inputs.workInput.workIdentityHash).toEqual(bytes(0x91));
      expect(Array.from(f.inputs.signerPublicKey)).toEqual(
        Array<number>(32).fill(0x92),
      );
    } finally {
      destroyTaskRuntimeBackgroundAuthorizationRequestV1(f.baseRequest);
      destroyDomainForegroundAuthorizationPlanV2(f.plan);
      f.device.privateKey.fill(0);
      f.device.publicKey.fill(0);
      f.signer.privateKey.fill(0);
      f.signer.publicKey.fill(0);
    }
  });

  test("V2 cannot be reinterpreted as publication V3", async () => {
    const f = await fixture("task.deliver_result");
    try {
      expect(() => encodeTaskRuntimeBackgroundAuthorizationRequestV2(
        f.crypto,
        f.request as never,
      )).toThrow();
      const encoded = encodeTaskRuntimeBackgroundAuthorizationRequestV3(
        f.crypto, f.request,
      );
      expect(decodeTaskRuntimeBackgroundAuthorizationRequestV2(f.crypto, encoded))
        .toBeNull();
    } finally {
      cleanup(f);
    }
  });
});
