import { describe, expect, test } from "bun:test";

import {
  createTaskRuntimeBackgroundAuthorizationRequestV1,
  decodeTaskRuntimeBackgroundAuthorizationRequestV1,
  destroyTaskRuntimeBackgroundAuthorizationRequestV1,
  encodeTaskRuntimeBackgroundAuthorizationRequestV1,
} from "../../src/background/task-runtime-request-v1.ts";
import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  createDomainForegroundAuthorizationPlanV2,
  destroyDomainForegroundAuthorizationPlanV2,
} from "../../src/format/domain-foreground-authorization-v2.ts";
import { encodeU64, utf8V2 } from "../../src/format/v2-primitives.ts";
import {
  authorizationRevision,
  cryptoDeviceId,
  humanId,
} from "../../src/v2-types/ids.ts";

const NOW = 1_800_700_000_000;
const GENERATION = 9_007_101;

function bytes(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

function replaceFirst(
  input: Uint8Array,
  search: Uint8Array,
  replacement: Uint8Array,
): Uint8Array {
  if (search.length !== replacement.length) throw new Error("length mismatch");
  const output = input.slice();
  outer: for (let offset = 0; offset <= output.length - search.length; offset++) {
    for (let index = 0; index < search.length; index++) {
      if (output[offset + index] !== search[index]) continue outer;
    }
    output.set(replacement, offset);
    return output;
  }
  throw new Error("test pattern not found");
}

async function fixture(work: "task.dispatch" | "task.execute" = "task.execute") {
  const crypto = new LatticeCrypto(seededRng(807_503), { now: () => NOW });
  const recipient = await crypto.deriveEncryptionKeyPair(bytes(0x51));
  const plan = createDomainForegroundAuthorizationPlanV2(crypto, {
    authorizationId: "request:one",
    policyRevision: 4,
    sessionId: "episode:one",
    roomId: "room:source1",
    subjectHumanId: humanId("human:one"),
    committerDeviceId: cryptoDeviceId("device:one"),
    committerDeviceSigningGeneration: 2,
    hostAuthorizationRevision: authorizationRevision(3),
    recipientKind: "runtime",
    recipientPrincipalId: "nautilo_task_runtime",
    recipientAuthorizationRevision: authorizationRevision(0),
    recipientRuntimeGeneration: GENERATION,
    recipientKeyId: "recipient:key1",
    operations: ["decrypt", "encrypt"],
    issuedAt: NOW,
    deadlineAt: NOW + 5 * 60_000,
    maximumSecretBytes: 1024,
    domains: [{
      domainId: "domain:one",
      sourceNamespaceId: "namespace:one",
      participantDigest: bytes(0x11),
      participantCount: 2,
      keyClass: "ai",
      domainKeyGeneration: 2,
      authorizationRevision: authorizationRevision(5),
      headDigest: bytes(0x12),
      activeNamespaceBindingSetDigest: bytes(0x13),
      activeNamespaceBindingCount: 1,
    }],
  });
  const request = createTaskRuntimeBackgroundAuthorizationRequestV1({
    requestId: "request:one",
    workId: "task-run:one",
    workKind: work,
    workPurpose: work,
    recipientGeneration: GENERATION,
    episodeId: "episode:one",
    sourceRoomId: "room:source1",
    recipientKeyId: "recipient:key1",
    recipientPublicKey: recipient.publicKey,
    authorizationPlan: plan,
    issuedAt: NOW,
    deadlineAt: NOW + 5 * 60_000,
  });
  recipient.privateKey.fill(0);
  recipient.publicKey.fill(0);
  return { plan, request };
}

describe("Task Runtime background authorization request v1", () => {
  test.each(["task.dispatch", "task.execute"] as const)(
    "round-trips canonical %s requests",
    async (work) => {
      const value = await fixture(work);
      try {
        const encoded = encodeTaskRuntimeBackgroundAuthorizationRequestV1(
          value.request,
        );
        const decoded = decodeTaskRuntimeBackgroundAuthorizationRequestV1(encoded);
        expect(decoded).not.toBeNull();
        expect(decoded?.workId).toBe("task-run:one");
        expect(decoded?.workKind).toBe(work);
        expect(decoded?.workPurpose).toBe(work);
        expect(decoded?.recipientGeneration).toBe(GENERATION);
        expect(decoded?.recipientPublicKey).toEqual(value.request.recipientPublicKey);
        if (decoded !== null) {
          expect(encodeTaskRuntimeBackgroundAuthorizationRequestV1(decoded))
            .toEqual(encoded);
          destroyTaskRuntimeBackgroundAuthorizationRequestV1(decoded);
        }
      } finally {
        destroyTaskRuntimeBackgroundAuthorizationRequestV1(value.request);
        destroyDomainForegroundAuthorizationPlanV2(value.plan);
      }
    },
  );

  test("rejects carrier-to-plan substitution and trailing bytes", async () => {
    const value = await fixture();
    try {
      const encoded = encodeTaskRuntimeBackgroundAuthorizationRequestV1(
        value.request,
      );
      const substitutions = [
        [utf8V2("request:one"), utf8V2("request:two")],
        [utf8V2("episode:one"), utf8V2("episode:two")],
        [utf8V2("room:source1"), utf8V2("room:source2")],
        [encodeU64(GENERATION), encodeU64(GENERATION + 1)],
        [utf8V2("recipient:key1"), utf8V2("recipient:key2")],
        [utf8V2("nautilo_task_runtime"), utf8V2("nautilo_task_runtimf")],
        [encodeU64(NOW), encodeU64(NOW + 1)],
        [encodeU64(NOW + 5 * 60_000), encodeU64(NOW + 5 * 60_000 + 1)],
        [utf8V2("task.execute"), utf8V2("task.unknown")],
      ] as const;
      for (const [search, replacement] of substitutions) {
        expect(decodeTaskRuntimeBackgroundAuthorizationRequestV1(
          replaceFirst(encoded, search, replacement),
        )).toBeNull();
      }
      expect(decodeTaskRuntimeBackgroundAuthorizationRequestV1(
        Uint8Array.from([...encoded, 0]),
      )).toBeNull();
    } finally {
      destroyTaskRuntimeBackgroundAuthorizationRequestV1(value.request);
      destroyDomainForegroundAuthorizationPlanV2(value.plan);
    }
  });

  test("rejects unknown or crossed work types and malformed recipient keys", async () => {
    const value = await fixture();
    try {
      expect(() => encodeTaskRuntimeBackgroundAuthorizationRequestV1({
        ...value.request,
        workPurpose: "task.dispatch",
      })).toThrow("work kind and purpose disagree");
      expect(() => encodeTaskRuntimeBackgroundAuthorizationRequestV1({
        ...value.request,
        workKind: "task.unknown" as "task.execute",
      })).toThrow("work kind is unsupported");
      expect(() => encodeTaskRuntimeBackgroundAuthorizationRequestV1({
        ...value.request,
        recipientPublicKey: value.request.recipientPublicKey.slice(1),
      })).toThrow("must be exactly 65 bytes");
    } finally {
      destroyTaskRuntimeBackgroundAuthorizationRequestV1(value.request);
      destroyDomainForegroundAuthorizationPlanV2(value.plan);
    }
  });
});
