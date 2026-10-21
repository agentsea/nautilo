import { describe, expect, test } from "bun:test";
import { sha256 } from "@noble/hashes/sha2.js";
import { LATTICE_LIMITS, LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  createHumanTaskOrdinaryFallbackReplayAdmissionV1,
  decodeHumanTaskOrdinaryFallbackRequestV1,
  digestHumanTaskOrdinaryFallbackRequestV1,
  encodeHumanTaskOrdinaryFallbackRequestV1,
  fingerprintHumanTaskOrdinaryFallbackContentV1,
  fingerprintHumanTaskOrdinaryFallbackPlanV1,
  prepareHumanTaskOrdinaryFallbackRequestV1,
  verifyHumanTaskOrdinaryFallbackRequestV1,
  type HumanTaskOrdinaryFallbackReplayAdmissionV1,
  type HumanTaskOrdinaryFallbackUnsignedRequestV1,
} from "../../src/task/human-task-ordinary-fallback-request.ts";
import {
  encodeTaskDefinitionContent,
  TASK_PAYLOAD_MAX_TEXT_BYTES_V1,
} from "../../src/task/task-payload-v1.ts";

const TASK = "81000000-0000-8000-8000-000000000001";

function crypto(): LatticeCrypto {
  let value = 1;
  return new LatticeCrypto({
    bytes: (length) => Uint8Array.from(
      { length },
      () => value++ & 0xff,
    ),
  });
}

function content(retainedHistoricalError?: string): Uint8Array {
  return encodeTaskDefinitionContent(retainedHistoricalError === undefined
    ? {
      formatVersion: 1,
      prompt: "Publish the exact Task",
      expectedOutput: "done",
      protectedMetadata: {},
    }
    : {
      formatVersion: 2,
      prompt: "Publish the exact Task",
      expectedOutput: "done",
      protectedMetadata: {},
      retainedHistoricalError,
    });
}

function digest(value: number): Uint8Array {
  return new Uint8Array(32).fill(value);
}

function unsigned(
  overrides: Partial<HumanTaskOrdinaryFallbackUnsignedRequestV1> = {},
): HumanTaskOrdinaryFallbackUnsignedRequestV1 {
  return {
    formatVersion: 1,
    purpose: "task.ordinary_fallback.create",
    reason: "target_encryption_not_ready",
    operationId: "human-task-create:1",
    taskId: TASK,
    planDigest: digest(1),
    sourceDigest: digest(2),
    operationalFieldsDigest: digest(3),
    expectedContentRevision: 0,
    expectedCryptoAccessRevision: 0,
    expectedUpdatedAt: null,
    taskDefinitionContentDigest:
      fingerprintHumanTaskOrdinaryFallbackContentV1(content()),
    policyRevision: 7,
    subjectHumanId: "human:1",
    committerDeviceId: "device:1",
    committerDeviceSigningKeyGeneration: 2,
    hostAuthorizationRevision: 9,
    planIssuedAt: 1_000,
    planDeadlineAt: 31_000,
    issuedAt: 1_100,
    deadlineAt: 31_000,
    ...overrides,
  };
}

function tamper(bytes: Uint8Array, index: number, value: unknown): Uint8Array {
  const wire = JSON.parse(new TextDecoder().decode(bytes)) as unknown[];
  wire[index] = value;
  return new TextEncoder().encode(JSON.stringify(wire));
}

describe("Human Task ordinary fallback request", () => {
  test("round trips canonical create and update requests", () => {
    const lattice = crypto();
    const signer = lattice.generateSigningKeyPair();
    const create = prepareHumanTaskOrdinaryFallbackRequestV1(lattice, {
      ...unsigned(),
      signingPrivateKey: signer.privateKey,
    });
    expect(encodeHumanTaskOrdinaryFallbackRequestV1(
      decodeHumanTaskOrdinaryFallbackRequestV1(create.bytes),
    )).toEqual(create.bytes);
    expect(digestHumanTaskOrdinaryFallbackRequestV1(create.bytes)).toHaveLength(32);

    for (const [expectedContentRevision, expectedCryptoAccessRevision] of [
      [0, 0],
      [4, 3],
    ] as const) {
      const update = prepareHumanTaskOrdinaryFallbackRequestV1(lattice, {
        ...unsigned({
          purpose: "task.ordinary_fallback.update",
          operationId: `human-task-update:${expectedContentRevision}`,
          expectedContentRevision,
          expectedCryptoAccessRevision,
          expectedUpdatedAt: "2026-10-19T10:11:12.345Z",
          taskDefinitionContentDigest:
            fingerprintHumanTaskOrdinaryFallbackContentV1(
              content("retained failure"),
            ),
        }),
        signingPrivateKey: signer.privateKey,
      });
      expect(verifyHumanTaskOrdinaryFallbackRequestV1(lattice, {
        requestBytes: update.bytes,
        signingPublicKey: signer.publicKey,
        now: 1_500,
      }).request).toMatchObject({
        purpose: "task.ordinary_fallback.update",
        expectedContentRevision,
        expectedCryptoAccessRevision,
        expectedUpdatedAt: "2026-10-19T10:11:12.345Z",
      });
    }
  });

  test("fingerprints only canonical bounded Task definition content", () => {
    const canonical = content("retained failure");
    expect(fingerprintHumanTaskOrdinaryFallbackContentV1(canonical))
      .toEqual(sha256(canonical));

    const maximum = encodeTaskDefinitionContent({
      formatVersion: 1,
      prompt: "x".repeat(TASK_PAYLOAD_MAX_TEXT_BYTES_V1),
      expectedOutput: null,
      protectedMetadata: {},
    });
    expect(maximum).toHaveLength(LATTICE_LIMITS.plaintextBytes);
    expect(fingerprintHumanTaskOrdinaryFallbackContentV1(maximum))
      .toHaveLength(32);
    expect(() => fingerprintHumanTaskOrdinaryFallbackContentV1(
      new TextEncoder().encode("{}"),
    )).toThrow("content is invalid");
    expect(() => fingerprintHumanTaskOrdinaryFallbackContentV1(
      new Uint8Array(LATTICE_LIMITS.plaintextBytes + 1),
    )).toThrow("content is invalid");
  });

  test("fingerprints every server-authored plan field in canonical order", () => {
    const request = unsigned();
    const plan = {
      formatVersion: request.formatVersion,
      purpose: request.purpose,
      reason: request.reason,
      operationId: request.operationId,
      taskId: request.taskId,
      sourceDigest: request.sourceDigest,
      operationalFieldsDigest: request.operationalFieldsDigest,
      expectedContentRevision: request.expectedContentRevision,
      expectedCryptoAccessRevision: request.expectedCryptoAccessRevision,
      expectedUpdatedAt: request.expectedUpdatedAt,
      policyRevision: request.policyRevision,
      subjectHumanId: request.subjectHumanId,
      committerDeviceId: request.committerDeviceId,
      committerDeviceSigningKeyGeneration:
        request.committerDeviceSigningKeyGeneration,
      hostAuthorizationRevision: request.hostAuthorizationRevision,
      planIssuedAt: request.planIssuedAt,
      planDeadlineAt: request.planDeadlineAt,
    };
    const expected = fingerprintHumanTaskOrdinaryFallbackPlanV1(plan);
    expect(fingerprintHumanTaskOrdinaryFallbackPlanV1(plan)).toEqual(expected);
    const substitutions = [
      { ...plan, operationId: "human-task-create:2" },
      { ...plan, sourceDigest: digest(9) },
      { ...plan, operationalFieldsDigest: digest(8) },
      { ...plan, policyRevision: 8 },
      { ...plan, planDeadlineAt: 30_999 },
    ];
    for (const substituted of substitutions) {
      expect(fingerprintHumanTaskOrdinaryFallbackPlanV1(substituted))
        .not.toEqual(expected);
    }
  });

  test("binds every semantic field and the signature", () => {
    const lattice = crypto();
    const signer = lattice.generateSigningKeyPair();
    const created = prepareHumanTaskOrdinaryFallbackRequestV1(lattice, {
      ...unsigned(),
      signingPrivateKey: signer.privateKey,
    });
    const fields = JSON.parse(new TextDecoder().decode(created.bytes)) as unknown[];
    const substitutions: readonly [number, unknown][] = [
      [1, 2], [2, "task.ordinary_fallback.update"], [3, "other"],
      [4, "human-task-create:2"], [5, "81000000-0000-8000-8000-000000000002"],
      [6, "04".repeat(32)], [7, "05".repeat(32)], [8, "06".repeat(32)],
      [9, 1], [10, 1], [11, "2026-10-19T10:11:12.345Z"],
      [12, "07".repeat(32)], [13, 8],
      [14, "human:2"], [15, "device:2"], [16, 3], [17, 10],
      [18, 999], [19, 30_999], [20, 1_101], [21, 30_999],
      [22, `${(fields[22] as string).slice(0, -2)}00`],
    ];
    for (const [index, value] of substitutions) {
      expect(() => verifyHumanTaskOrdinaryFallbackRequestV1(lattice, {
        requestBytes: tamper(created.bytes, index, value),
        signingPublicKey: signer.publicKey,
        now: 1_500,
      })).toThrow();
    }
  });

  test("rejects noncanonical wires, invalid coordinates, and invalid content", () => {
    const lattice = crypto();
    const signer = lattice.generateSigningKeyPair();
    const created = prepareHumanTaskOrdinaryFallbackRequestV1(lattice, {
      ...unsigned(),
      signingPrivateKey: signer.privateKey,
    });
    const noncanonical = new Uint8Array(created.bytes.length + 1);
    noncanonical.set(created.bytes);
    noncanonical[created.bytes.length] = 0x20;
    expect(() => decodeHumanTaskOrdinaryFallbackRequestV1(noncanonical))
      .toThrow("noncanonical");
    expect(() => decodeHumanTaskOrdinaryFallbackRequestV1(
      new Uint8Array(LATTICE_LIMITS.plaintextBytes + 1),
    )).toThrow("wire is invalid");

    const invalid: Partial<HumanTaskOrdinaryFallbackUnsignedRequestV1>[] = [
      { expectedContentRevision: 1 },
      { expectedCryptoAccessRevision: 1 },
      { expectedUpdatedAt: "2026-10-19T10:11:12.345Z" },
      { policyRevision: 0 },
      { planDeadlineAt: 31_001 },
      { deadlineAt: 31_001 },
      { issuedAt: 999 },
      { taskDefinitionContentDigest: new Uint8Array(31) },
    ];
    for (const overrides of invalid) {
      expect(() => prepareHumanTaskOrdinaryFallbackRequestV1(lattice, {
        ...unsigned(overrides),
        signingPrivateKey: signer.privateKey,
      })).toThrow();
    }
    expect(() => prepareHumanTaskOrdinaryFallbackRequestV1(lattice, {
      ...unsigned({
        purpose: "task.ordinary_fallback.update",
        expectedUpdatedAt: "2026-10-19T10:11:12Z",
      }),
      signingPrivateKey: signer.privateKey,
    })).toThrow();
  });

  test.each([1, 2, 3, 4, 5, 6, 7, 8])(
    "accepts canonical UUID version %i",
    (version) => {
      const lattice = crypto();
      const signer = lattice.generateSigningKeyPair();
      expect(() => prepareHumanTaskOrdinaryFallbackRequestV1(lattice, {
        ...unsigned({ taskId: `81000000-0000-${version}000-8000-000000000001` }),
        signingPrivateKey: signer.privateKey,
      })).not.toThrow();
    },
  );

  test.each([
    "81000000-0000-0000-8000-000000000001",
    "81000000-0000-9000-8000-000000000001",
    "81000000-0000-8000-7000-000000000001",
    "81000000-0000-8000-8000-00000000000A",
    "{81000000-0000-8000-8000-000000000001}",
  ])("rejects invalid or noncanonical UUID %s", (taskId) => {
    const lattice = crypto();
    const signer = lattice.generateSigningKeyPair();
    expect(() => prepareHumanTaskOrdinaryFallbackRequestV1(lattice, {
      ...unsigned({ taskId }),
      signingPrivateKey: signer.privateKey,
    })).toThrow();
  });

  test("permits expiry only with the exact branded replay admission", () => {
    const lattice = crypto();
    const signer = lattice.generateSigningKeyPair();
    const created = prepareHumanTaskOrdinaryFallbackRequestV1(lattice, {
      ...unsigned(),
      signingPrivateKey: signer.privateKey,
    });
    const fresh = verifyHumanTaskOrdinaryFallbackRequestV1(lattice, {
      requestBytes: created.bytes,
      signingPublicKey: signer.publicKey,
      now: 1_500,
    });
    expect(() => verifyHumanTaskOrdinaryFallbackRequestV1(lattice, {
      requestBytes: created.bytes,
      signingPublicKey: signer.publicKey,
      now: 31_000,
    })).toThrow("not currently valid");

    const replayAdmission = createHumanTaskOrdinaryFallbackReplayAdmissionV1({
      operationId: created.request.operationId,
      taskId: created.request.taskId,
      requestDigest: fresh.requestDigest,
    });
    expect(verifyHumanTaskOrdinaryFallbackRequestV1(lattice, {
      requestBytes: created.bytes,
      signingPublicKey: signer.publicKey,
      now: 31_000,
      replayAdmission,
    }).request.operationId).toBe(created.request.operationId);

    const changedPayload = prepareHumanTaskOrdinaryFallbackRequestV1(lattice, {
      ...unsigned({
        taskDefinitionContentDigest:
          fingerprintHumanTaskOrdinaryFallbackContentV1(content("different")),
      }),
      signingPrivateKey: signer.privateKey,
    });
    expect(() => verifyHumanTaskOrdinaryFallbackRequestV1(lattice, {
      requestBytes: changedPayload.bytes,
      signingPublicKey: signer.publicKey,
      now: 31_000,
      replayAdmission,
    })).toThrow("replay admission disagrees");

    for (const admission of [
      createHumanTaskOrdinaryFallbackReplayAdmissionV1({
        operationId: "human-task-create:2",
        taskId: TASK,
        requestDigest: fresh.requestDigest,
      }),
      createHumanTaskOrdinaryFallbackReplayAdmissionV1({
        operationId: created.request.operationId,
        taskId: "81000000-0000-8000-8000-000000000002",
        requestDigest: fresh.requestDigest,
      }),
      createHumanTaskOrdinaryFallbackReplayAdmissionV1({
        operationId: created.request.operationId,
        taskId: TASK,
        requestDigest: digest(9),
      }),
      Object.freeze({}) as HumanTaskOrdinaryFallbackReplayAdmissionV1,
    ]) {
      expect(() => verifyHumanTaskOrdinaryFallbackRequestV1(lattice, {
        requestBytes: created.bytes,
        signingPublicKey: signer.publicKey,
        now: 31_000,
        replayAdmission: admission,
      })).toThrow("replay admission disagrees");
    }
  });
});
