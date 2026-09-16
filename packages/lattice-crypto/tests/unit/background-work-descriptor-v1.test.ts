import { describe, expect, test } from "bun:test";

import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  BACKGROUND_WORK_DESCRIPTOR_DOMAIN_V1,
  BACKGROUND_WORK_DESCRIPTOR_FORMAT_VERSION_V1,
  MAX_BACKGROUND_WORK_DESCRIPTOR_WIRE_BYTES_V1,
  backgroundWorkDescriptorDigestV1,
  decodeBackgroundWorkDescriptorV1,
  encodeBackgroundWorkDescriptorV1,
  type BackgroundWorkKindV1,
  type BackgroundWorkPurposeV1,
  type BackgroundWorkDescriptorV1,
} from "../../src/background/work-descriptor-v1.ts";
import {
  concatV2,
  encodeU32,
  encodeU64,
  frame,
  frameText,
} from "../../src/format/v2-primitives.ts";
import {
  accessRevision,
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDomainId,
  domainEpoch,
  namespaceId,
  objectId,
  unixTimestamp,
} from "../../src/v2-types/ids.ts";
import { V2_LIMITS } from "../../src/v2-types/limits.ts";

function fingerprint(marker: number): Uint8Array {
  return new Uint8Array(32).fill(marker);
}

function recipientKey(marker = 0x41): Uint8Array {
  return new Uint8Array(V2_LIMITS.hpkePublicKeyBytes).fill(marker);
}

function processorDescriptor(): BackgroundWorkDescriptorV1 {
  return {
    formatVersion: BACKGROUND_WORK_DESCRIPTOR_FORMAT_VERSION_V1,
    requestId: "background-request-1",
    recipientGeneration: 3,
    workKind: "stenographer.extraction",
    workId: "stenographer-batch-17",
    namespaceId: namespaceId("room-namespace-1"),
    domainId: cryptoDomainId("domain-ab"),
    subject: {
      kind: "processor",
      processorKind: "stenographer",
      processorVersion: 1,
      authorizationRevision: authorizationRevision(17),
    },
    purpose: "journal.extract",
    operations: ["decrypt", "encrypt"],
    source: {
      kind: "journal_range",
      startSequence: 41,
      endSequence: 57,
      rebuildGeneration: 2,
      fingerprint: fingerprint(0x31),
    },
    inputObjectIds: [
      objectId("message-object-41"),
      objectId("message-object-57"),
    ],
    outputObjectIds: [
      objectId("event-object-0"),
      objectId("event-object-1"),
    ],
    outputObjectMetadata: [
      {
        objectId: objectId("event-object-0"),
        objectType: "journal.event",
        createdAt: unixTimestamp(1_000_020),
      },
      {
        objectId: objectId("event-object-1"),
        objectType: "journal.rollup",
        createdAt: unixTimestamp(1_000_021),
      },
    ],
    maximumInputObjectCount: 2,
    maximumOutputObjectCount: 2,
    maximumPlaintextBytes: 64 * 1024,
    maximumCiphertextBytes: 96 * 1024,
    expectedDomainEpoch: domainEpoch(7),
    expectedNamespaceAccessRevision: accessRevision(11),
    expectedPolicyRevision: authorizationRevision(13),
    recipientKeyId: "background-recipient-3",
    recipientPublicKey: recipientKey(),
    issuedAt: 1_000_000,
    notBefore: 1_000_010,
    expiresAt: 1_300_000,
    idempotencyId: "stenographer-batch-17-generation-2",
  };
}

function agentDescriptor(): BackgroundWorkDescriptorV1 {
  return {
    ...processorDescriptor(),
    requestId: "background-request-2",
    workKind: "task.execute",
    workId: "task-run-9",
    subject: {
      kind: "agent",
      agentId: agentId("agent-genie"),
      runtimeGeneration: agentRuntimeGeneration(5),
      authorizationRevision: authorizationRevision(19),
    },
    purpose: "task.execute",
    operations: ["decrypt"],
    source: {
      kind: "synthetic_payload",
      generation: 4,
      fingerprint: fingerprint(0x52),
    },
    inputObjectIds: [objectId("task-payload-9")],
    outputObjectIds: [],
    outputObjectMetadata: [],
    maximumInputObjectCount: 1,
    maximumOutputObjectCount: 0,
    idempotencyId: "task-run-9-attempt-4",
  };
}

function expectedProcessorBytes(
  value: BackgroundWorkDescriptorV1,
): Uint8Array {
  if (
    value.subject.kind !== "processor"
    || value.source.kind !== "journal_range"
  ) {
    throw new Error("processor fixture is malformed");
  }
  return concatV2(
    frameText(BACKGROUND_WORK_DESCRIPTOR_DOMAIN_V1),
    encodeU32(BACKGROUND_WORK_DESCRIPTOR_FORMAT_VERSION_V1),
    frameText(value.requestId),
    encodeU64(value.recipientGeneration),
    frameText(value.workKind),
    frameText(value.workId),
    frameText(value.namespaceId),
    frameText(value.domainId),
    frameText(value.subject.kind),
    frameText(value.subject.processorKind),
    encodeU32(value.subject.processorVersion),
    encodeU64(value.subject.authorizationRevision),
    frameText(value.purpose),
    encodeU32(value.operations.length),
    ...value.operations.map(frameText),
    frameText(value.source.kind),
    encodeU64(value.source.startSequence),
    encodeU64(value.source.endSequence),
    encodeU64(value.source.rebuildGeneration),
    frame(value.source.fingerprint),
    encodeU32(value.inputObjectIds.length),
    ...value.inputObjectIds.map(frameText),
    encodeU32(value.outputObjectIds.length),
    ...value.outputObjectIds.map(frameText),
    encodeU32(value.outputObjectMetadata.length),
    ...value.outputObjectMetadata.flatMap((metadata) => [
      frameText(metadata.objectId),
      frameText(metadata.objectType),
      encodeU64(metadata.createdAt),
    ]),
    encodeU32(value.maximumInputObjectCount),
    encodeU32(value.maximumOutputObjectCount),
    encodeU64(value.maximumPlaintextBytes),
    encodeU64(value.maximumCiphertextBytes),
    encodeU64(value.expectedDomainEpoch),
    encodeU64(value.expectedNamespaceAccessRevision),
    encodeU64(value.expectedPolicyRevision),
    frameText(value.recipientKeyId),
    frame(value.recipientPublicKey),
    encodeU64(value.issuedAt),
    encodeU64(value.notBefore),
    encodeU64(value.expiresAt),
    frameText(value.idempotencyId),
  );
}

describe("BackgroundWorkDescriptorV1 canonical wire format", () => {
  test("locks the wire ceiling and every work-kind purpose mapping", () => {
    expect(MAX_BACKGROUND_WORK_DESCRIPTOR_WIRE_BYTES_V1).toBe(131_072);
    const mappings: readonly [
      BackgroundWorkKindV1,
      BackgroundWorkPurposeV1,
    ][] = [
      ["stenographer.extraction", "journal.extract"],
      ["stenographer.historical", "journal.extract"],
      ["stenographer.compaction", "journal.compact"],
      ["stenographer.rebuild", "journal.rebuild"],
      ["memory.review", "memory.review"],
      ["memory.exit_flush", "memory.exit_flush"],
      ["task.dispatch", "task.dispatch"],
      ["task.execute", "task.execute"],
      ["task.approval_resume", "task.approval_resume"],
    ];

    for (const [workKind, purpose] of mappings) {
      const base = workKind.startsWith("stenographer.")
        ? processorDescriptor()
        : agentDescriptor();
      const descriptor = { ...base, workKind, purpose };
      expect(
        decodeBackgroundWorkDescriptorV1(
          encodeBackgroundWorkDescriptorV1(descriptor),
        ),
      ).toMatchObject({ workKind, purpose });
    }
  });

  test("round-trips and locks the exact processor field order", () => {
    const original = processorDescriptor();
    const encoded = encodeBackgroundWorkDescriptorV1(original);
    const decoded = decodeBackgroundWorkDescriptorV1(encoded);

    expect(encoded).toEqual(expectedProcessorBytes(original));
    expect(decoded).toEqual(original);
    expect(decoded).not.toBe(original);
    expect(decoded.subject).not.toBe(original.subject);
    expect(decoded.source).not.toBe(original.source);
    expect(decoded.recipientPublicKey).not.toBe(original.recipientPublicKey);
    expect(encodeBackgroundWorkDescriptorV1(decoded)).toEqual(encoded);
  });

  test("round-trips the distinct Agent and synthetic-source variant", () => {
    const original = agentDescriptor();
    expect(
      decodeBackgroundWorkDescriptorV1(
        encodeBackgroundWorkDescriptorV1(original),
      ),
    ).toEqual(original);
  });

  test("binds every security coordinate into the canonical digest", () => {
    const crypto = new LatticeCrypto(seededRng(24_101));
    const original = processorDescriptor();
    if (original.source.kind !== "journal_range") {
      throw new Error("processor fixture source is malformed");
    }
    const digest = backgroundWorkDescriptorDigestV1(crypto, original);
    const substitutions: BackgroundWorkDescriptorV1[] = [
      { ...original, requestId: "background-request-other" },
      { ...original, recipientGeneration: 4 },
      { ...original, workId: "stenographer-batch-other" },
      { ...original, namespaceId: namespaceId("room-namespace-other") },
      { ...original, domainId: cryptoDomainId("domain-other") },
      {
        ...original,
        subject: {
          ...original.subject,
          authorizationRevision: authorizationRevision(18),
        },
      },
      {
        ...original,
        source: { ...original.source, endSequence: 58 },
      },
      {
        ...original,
        inputObjectIds: [objectId("message-object-other")],
        maximumInputObjectCount: 1,
      },
      {
        ...original,
        inputObjectIds: [...original.inputObjectIds].reverse(),
      },
      {
        ...original,
        outputObjectIds: [objectId("event-object-other")],
        outputObjectMetadata: [{
          objectId: objectId("event-object-other"),
          objectType: "journal.event",
          createdAt: unixTimestamp(1_000_020),
        }],
        maximumOutputObjectCount: 1,
      },
      {
        ...original,
        outputObjectIds: [...original.outputObjectIds].reverse(),
        outputObjectMetadata:
          [...original.outputObjectMetadata].reverse(),
      },
      {
        ...original,
        outputObjectMetadata: original.outputObjectMetadata.map(
          (metadata, index) => index === 0
            ? { ...metadata, objectType: "journal.rollup.revised" }
            : metadata,
        ),
      },
      {
        ...original,
        outputObjectMetadata: original.outputObjectMetadata.map(
          (metadata, index) => index === 0
            ? { ...metadata, createdAt: unixTimestamp(1_000_099) }
            : metadata,
        ),
      },
      { ...original, maximumPlaintextBytes: 64 * 1024 - 1 },
      { ...original, expectedDomainEpoch: domainEpoch(8) },
      {
        ...original,
        expectedNamespaceAccessRevision: accessRevision(12),
      },
      { ...original, expectedPolicyRevision: authorizationRevision(14) },
      { ...original, recipientKeyId: "background-recipient-other" },
      { ...original, recipientPublicKey: recipientKey(0x42) },
      { ...original, notBefore: original.notBefore + 1 },
      { ...original, idempotencyId: "stenographer-batch-other-generation-2" },
    ];

    for (const substituted of substitutions) {
      expect(backgroundWorkDescriptorDigestV1(crypto, substituted))
        .not.toEqual(digest);
    }
  });

  test("rejects unknown, contradictory, noncanonical, and unbounded values", () => {
    const processor = processorDescriptor();
    const agent = agentDescriptor();
    const invalid: Array<readonly [unknown, string]> = [
      [{ ...processor, extra: true }, "field set"],
      [{ ...processor, formatVersion: 2 }, "format version"],
      [{
        ...processor,
        subject: { ...processor.subject, processorKind: "plugin" },
      }, "processor kind"],
      [{
        ...processor,
        subject: { ...processor.subject, processorVersion: 2 },
      }, "processor version"],
      [{
        ...processor,
        subject: agent.subject,
      }, "requires the Stenographer processor"],
      [{ ...processor, purpose: "journal.compact" }, "purpose"],
      [{ ...processor, operations: ["encrypt", "decrypt"] }, "canonical"],
      [{ ...processor, operations: ["decrypt"] }, "operations"],
      [{ ...processor, source: agent.source }, "journal source"],
      [{
        ...processor,
        source: { ...processor.source, startSequence: 58 },
      }, "range"],
      [{
        ...processor,
        inputObjectIds: [
          objectId("message-object-41"),
          objectId("message-object-41"),
        ],
      }, "ordered and unique"],
      [{
        ...processor,
        outputObjectIds: [
          objectId("event-object-0"),
          objectId("event-object-0"),
        ],
      }, "ordered and unique"],
      [{
        ...processor,
        outputObjectMetadata: processor.outputObjectMetadata.slice(0, 1),
      }, "output metadata"],
      [{
        ...processor,
        outputObjectMetadata: processor.outputObjectMetadata.map(
          (metadata, index) => index === 0
            ? { ...metadata, objectId: objectId("event-object-other") }
            : metadata,
        ),
      }, "authorized output slot order"],
      [{ ...processor, maximumInputObjectCount: 1 }, "input object count"],
      [{ ...processor, maximumOutputObjectCount: 1 }, "output object count"],
      [{
        ...processor,
        outputObjectIds: [],
        outputObjectMetadata: [],
        maximumOutputObjectCount: 0,
      }, "output object slot space"],
      [{ ...processor, maximumPlaintextBytes: 0 }, "plaintext byte budget"],
      [{
        ...processor,
        maximumCiphertextBytes: V2_LIMITS.ciphertextBytes + 1,
      }, "ciphertext byte budget"],
      [{ ...processor, recipientPublicKey: new Uint8Array(64) }, "public key"],
      [{ ...processor, notBefore: processor.issuedAt - 1 }, "timestamps"],
      [{ ...processor, expiresAt: processor.notBefore }, "timestamps"],
      [{
        ...processor,
        expiresAt: processor.issuedAt + V2_LIMITS.grantTtlMs + 1,
      }, "TTL"],
      [{
        ...agent,
        workKind: "stenographer.compaction",
        purpose: "journal.compact",
      }, "requires the Stenographer processor"],
      [{
        ...agent,
        source: processor.source,
      }, "synthetic source"],
      [{
        ...agent,
        operations: ["encrypt"],
      }, "output object"],
    ];

    for (const [value, message] of invalid) {
      expect(() =>
        encodeBackgroundWorkDescriptorV1(value as BackgroundWorkDescriptorV1)
      ).toThrow(message);
    }
  });

  test("rejects malformed containers at every descriptor boundary", () => {
    const processor = processorDescriptor();
    const { requestId: _, ...withoutRequestId } = processor;
    const malformed: Array<readonly [unknown, string]> = [
      [null, "Background work descriptor must be an object"],
      [[], "Background work descriptor must be an object"],
      ["descriptor", "Background work descriptor must be an object"],
      [{ ...withoutRequestId, unexpectedRequestId: processor.requestId },
        "field set"],
      [{ ...processor, workKind: 1 }, "work kind is unsupported"],
      [{ ...processor, purpose: 1 }, "work purpose is unsupported"],
      [{ ...processor, subject: agentDescriptor().subject },
        "requires the Stenographer processor"],
      [{ ...agentDescriptor(), subject: processor.subject },
        "requires an Agent subject"],
      [{ ...processor, subject: null },
        "Background work subject must be an object"],
      [{ ...processor, subject: [] },
        "Background work subject must be an object"],
      [{ ...processor, source: null },
        "Background work source must be an object"],
      [{ ...processor, source: [] },
        "Background work source must be an object"],
      [{ ...processor, operations: null },
        "Background work operations must be an array"],
      [{ ...processor, operations: ["decrypt", 1] },
        "Background work operation is unsupported"],
      [{ ...processor, operations: ["decrypt", "decrypt"] },
        "canonical and unique"],
      [{ ...processor, operations: ["decrypt"] },
        "processor operations must be decrypt and encrypt"],
      [{ ...processor, operations: ["encrypt"] },
        "processor operations must be decrypt and encrypt"],
      [{ ...processor, inputObjectIds: null },
        "Background input object ids must be an array"],
      [{ ...processor, outputObjectIds: null },
        "Background output object ids must be an array"],
      [{ ...processor, outputObjectMetadata: null },
        "output metadata must match"],
      [{
        ...processor,
        outputObjectMetadata: [
          null,
          processor.outputObjectMetadata[1],
        ],
      }, "Background output metadata must be an object"],
    ];

    for (const [value, expectedMessage] of malformed) {
      expect(() =>
        encodeBackgroundWorkDescriptorV1(
          value as BackgroundWorkDescriptorV1,
        )
      ).toThrow(expectedMessage);
    }

    expect(() => decodeBackgroundWorkDescriptorV1(null as never))
      .toThrow("must be Uint8Array");
  });

  test("accepts the inclusive timestamp and TTL format boundaries", () => {
    const original = processorDescriptor();
    const boundary = {
      ...original,
      notBefore: original.issuedAt,
      expiresAt: original.issuedAt + V2_LIMITS.grantTtlMs,
    };

    expect(
      decodeBackgroundWorkDescriptorV1(
        encodeBackgroundWorkDescriptorV1(boundary),
      ),
    ).toMatchObject({
      issuedAt: boundary.issuedAt,
      notBefore: boundary.issuedAt,
      expiresAt: boundary.expiresAt,
    });
  });

  test("preserves declared input and output order as signed semantic state", () => {
    const original = processorDescriptor();
    const reordered: BackgroundWorkDescriptorV1 = {
      ...original,
      inputObjectIds: [...original.inputObjectIds].reverse(),
      outputObjectIds: [...original.outputObjectIds].reverse(),
      outputObjectMetadata:
        [...original.outputObjectMetadata].reverse(),
    };
    const encoded = encodeBackgroundWorkDescriptorV1(reordered);
    const decoded = decodeBackgroundWorkDescriptorV1(encoded);

    expect(decoded.inputObjectIds).toEqual(reordered.inputObjectIds);
    expect(decoded.outputObjectIds).toEqual(reordered.outputObjectIds);
    expect(decoded.outputObjectMetadata)
      .toEqual(reordered.outputObjectMetadata);
    expect(encodeBackgroundWorkDescriptorV1(decoded)).toEqual(encoded);
  });

  test("rejects truncated, trailing, tampered-domain, and oversized wire bytes", () => {
    const encoded = encodeBackgroundWorkDescriptorV1(processorDescriptor());
    expect(() => decodeBackgroundWorkDescriptorV1(encoded.slice(0, -1)))
      .toThrow();
    expect(() =>
      decodeBackgroundWorkDescriptorV1(new Uint8Array([...encoded, 0]))
    ).toThrow("trailing");

    const tampered = encoded.slice();
    const domain = new TextEncoder().encode(
      BACKGROUND_WORK_DESCRIPTOR_DOMAIN_V1,
    );
    const offset = tampered.findIndex(
      (_, index) =>
        domain.every((byte, inner) => tampered[index + inner] === byte),
    );
    expect(offset).toBeGreaterThanOrEqual(0);
    const lastDomainByte = offset + domain.length - 1;
    tampered[lastDomainByte] = tampered[lastDomainByte]! ^ 1;
    expect(() => decodeBackgroundWorkDescriptorV1(tampered))
      .toThrow("domain");

    expect(() =>
      decodeBackgroundWorkDescriptorV1(
        new Uint8Array(MAX_BACKGROUND_WORK_DESCRIPTOR_WIRE_BYTES_V1 + 1),
      )
    ).toThrow("wire limit");
  });
});
