import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  BACKGROUND_WORK_DESCRIPTOR_DOMAIN_V2,
  BACKGROUND_WORK_DESCRIPTOR_FORMAT_VERSION_V2,
  MAX_BACKGROUND_AUTHORITY_BINDING_EDGES_V2,
  MAX_BACKGROUND_WORK_DESCRIPTOR_WIRE_BYTES_V2,
  MAX_ANY_BACKGROUND_PROCESSOR_WORK_DESCRIPTOR_WIRE_BYTES_V2,
  backgroundWorkDescriptorDigestV2,
  decodeBackgroundAgentWorkDescriptorV2,
  decodeBackgroundWorkDescriptorV2,
  encodeBackgroundWorkDescriptorV2,
  type BackgroundProtectedMemoryWorkSourceV2,
  type BackgroundAgentWorkDescriptorV2 as BackgroundWorkDescriptorV2,
} from "../../src/background/work-descriptor-v2.ts";
import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  accessRevision,
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDomainId,
  domainEpoch,
  humanId,
  namespaceId,
  objectId,
  unixTimestamp,
} from "../../src/v2-types/ids.ts";
import { V2_LIMITS } from "../../src/v2-types/limits.ts";
import { backgroundProcessorWorkV2Fixture } from "../helpers/background-work-v2-fixture.ts";

function descriptor(): BackgroundWorkDescriptorV2 {
  return {
    formatVersion: BACKGROUND_WORK_DESCRIPTOR_FORMAT_VERSION_V2,
    requestId: "background-request-multi-1",
    recipientGeneration: 4,
    workKind: "memory.review",
    workId: "memory-review-22",
    anchorNamespaceId: namespaceId("namespace-ab-1"),
    anchorDomainId: cryptoDomainId("domain-ab"),
    subject: {
      kind: "agent",
      agentId: agentId("agent-genie"),
      runtimeGeneration: agentRuntimeGeneration(7),
      authorizationRevision: authorizationRevision(101),
    },
    purpose: "memory.review",
    operations: ["decrypt", "encrypt"],
    source: {
      kind: "synthetic_payload",
      generation: 2,
      fingerprint: new Uint8Array(32).fill(0x41),
    },
    grantScope: [humanId("alice"), humanId("bob")],
    inputBindings: [
      {
        objectId: objectId("memory-input-1"),
        namespaceId: namespaceId("namespace-ab-1"),
      },
      {
        objectId: objectId("memory-input-2"),
        namespaceId: namespaceId("namespace-abc-1"),
      },
    ],
    outputSlots: [{
      objectId: objectId("memory-output-1"),
      objectType: "memory.revision",
      createdAt: unixTimestamp(1_900_000_000_000),
      namespaceIds: [
        namespaceId("namespace-ab-1"),
        namespaceId("namespace-ac-1"),
      ],
    }],
    namespaceRequirements: [
      {
        namespaceId: namespaceId("namespace-ab-1"),
        domainId: cryptoDomainId("domain-ab"),
        operations: ["decrypt", "encrypt"],
        expectedAccessRevision: accessRevision(11),
        expectedPolicyRevision: authorizationRevision(21),
      },
      {
        namespaceId: namespaceId("namespace-abc-1"),
        domainId: cryptoDomainId("domain-abc"),
        operations: ["decrypt"],
        expectedAccessRevision: accessRevision(12),
        expectedPolicyRevision: authorizationRevision(22),
      },
      {
        namespaceId: namespaceId("namespace-ac-1"),
        domainId: cryptoDomainId("domain-ac"),
        operations: ["encrypt"],
        expectedAccessRevision: accessRevision(13),
        expectedPolicyRevision: authorizationRevision(23),
      },
    ],
    domainRequirements: [
      {
        domainId: cryptoDomainId("domain-ab"),
        expectedEpoch: domainEpoch(31),
        expectedAgentAuthorizationRevision: authorizationRevision(41),
      },
      {
        domainId: cryptoDomainId("domain-abc"),
        expectedEpoch: domainEpoch(32),
        expectedAgentAuthorizationRevision: authorizationRevision(42),
      },
      {
        domainId: cryptoDomainId("domain-ac"),
        expectedEpoch: domainEpoch(33),
        expectedAgentAuthorizationRevision: authorizationRevision(43),
      },
    ],
    maximumInputObjectCount: 2,
    maximumOutputObjectCount: 1,
    maximumPlaintextBytes: 64 * 1024,
    maximumCiphertextBytes: 96 * 1024,
    recipientKeyId: "background-agent-recipient-4",
    recipientPublicKey: new Uint8Array(65).fill(0x31),
    issuedAt: 1_900_000_000_000,
    notBefore: 1_900_000_000_010,
    expiresAt: 1_900_000_300_000,
    idempotencyId: "memory-review-22-attempt-2",
  };
}

function protectedMemorySource(): BackgroundProtectedMemoryWorkSourceV2 {
  return {
    kind: "protected_memory_work",
    sourceVersion: 1,
    productAuthority: { mode: "namespace" },
    inputRevisions: [
      {
        productKind: "memory",
        productId: "memory-input-1",
        productRevision: 7,
        cryptoAccessRevision: 3,
        accessKind: "namespace",
        objectId: objectId("memory-input-1"),
      },
      {
        productKind: "message",
        productId: "message-input-2",
        productRevision: 11,
        objectId: objectId("memory-input-2"),
      },
    ],
    outputRevisions: [{
      action: "create",
      memoryId: "memory-output-1",
      expectedContentRevision: 0,
      expectedCryptoAccessRevision: 0,
      nextContentRevision: 1,
      objectId: objectId("memory-output-1"),
      publicationIdempotencyId: "memory-review-22-output-1",
    }],
    tierMutations: [],
  };
}

describe("Agent background work descriptor v2", () => {
  test("round-trips one exact canonical multi-Domain authority inventory", () => {
    const value = descriptor();
    const bytes = encodeBackgroundWorkDescriptorV2(value);
    const decoded = decodeBackgroundWorkDescriptorV2(bytes);

    expect(BACKGROUND_WORK_DESCRIPTOR_DOMAIN_V2).toBe(
      "nautilo/lattice-crypto/background-work-descriptor/v2",
    );
    expect(decoded).toEqual(value);
    expect(decodeBackgroundAgentWorkDescriptorV2(bytes)).toEqual(value);
    expect(encodeBackgroundWorkDescriptorV2(decoded)).toEqual(bytes);

    const crypto = new LatticeCrypto(seededRng(24_400));
    expect(backgroundWorkDescriptorDigestV2(crypto, value))
      .toEqual(crypto.hash(bytes));
  });

  test("keeps the merged Wave 11 synthetic encoding byte-stable", () => {
    const bytes = encodeBackgroundWorkDescriptorV2(descriptor());
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "39a4320bcdfbd4c13030a0f906d83676cc08d1784667cc589b26ab0a195083ca",
    );
  });

  test("rejects unknown V2 subject tags without falling back to Agent decoding", () => {
    const bytes = encodeBackgroundWorkDescriptorV2(descriptor());
    const framedAgent = Uint8Array.of(0, 0, 0, 5, ...new TextEncoder().encode("agent"));
    const offset = bytes.findIndex((_, index) =>
      framedAgent.every((byte, inner) => bytes[index + inner] === byte)
    );
    expect(offset).toBeGreaterThanOrEqual(0);
    bytes.set(new TextEncoder().encode("other"), offset + 4);

    expect(() => decodeBackgroundWorkDescriptorV2(bytes))
      .toThrow("Unsupported background V2 subject");
    expect(() => decodeBackgroundAgentWorkDescriptorV2(bytes))
      .toThrow("Agent subject");
  });

  test("keeps processor descriptors out of the Agent-specific V2 decoder", () => {
    const processor = backgroundProcessorWorkV2Fixture(
      new Uint8Array(V2_LIMITS.hpkePublicKeyBytes).fill(0x71),
    );
    const bytes = encodeBackgroundWorkDescriptorV2(processor);

    expect(decodeBackgroundWorkDescriptorV2(bytes)).toEqual(processor);
    expect(() => decodeBackgroundAgentWorkDescriptorV2(bytes))
      .toThrow("Agent subject");
  });

  test("accepts explicit real Memory work provenance without reinterpreting synthetic", () => {
    const value = descriptor();
    const source = protectedMemorySource();
    const real = { ...value, source };

    const bytes = encodeBackgroundWorkDescriptorV2(real);
    expect(decodeBackgroundWorkDescriptorV2(bytes)).toEqual(real);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "546298ca6d2c53b35dcf43dcd704b40db3e6b3900dbe776541d42344a6294a7b",
    );
  });

  test("binds exact Namespace and scope product authority", () => {
    const value = descriptor();
    const namespaceSource = protectedMemorySource();
    expect(decodeBackgroundWorkDescriptorV2(
      encodeBackgroundWorkDescriptorV2({ ...value, source: namespaceSource }),
    ).source).toEqual(namespaceSource);

    const origin = namespaceId("namespace-ab-1");
    const scopeSource: BackgroundProtectedMemoryWorkSourceV2 = {
      ...namespaceSource,
      productAuthority: {
        mode: "scope",
        scopeId: "scope-review-22",
        originWritableNamespaceId: origin,
      },
      inputRevisions: namespaceSource.inputRevisions.map((entry) =>
        entry.productKind === "memory"
          ? { ...entry, accessKind: "scope_seed" as const }
          : entry
      ),
      outputRevisions: [],
    };
    const scopeDescriptor: BackgroundWorkDescriptorV2 = {
      ...value,
      source: scopeSource,
      outputSlots: [],
      namespaceRequirements: value.namespaceRequirements.slice(0, 2).map(
        (entry) => ({ ...entry, operations: ["decrypt"] as const }),
      ),
      domainRequirements: value.domainRequirements.slice(0, 2),
      operations: ["decrypt"],
      maximumOutputObjectCount: 0,
    };
    expect(decodeBackgroundWorkDescriptorV2(
      encodeBackgroundWorkDescriptorV2(scopeDescriptor),
    ).source).toEqual(scopeSource);

    const invalidAuthorities = [
      { mode: "namespace", scopeId: "scope-extra" },
      { mode: "scope", scopeId: "bad scope", originWritableNamespaceId: origin },
      { mode: "scope", scopeId: "scope-review-22" },
      { mode: "other" },
    ];
    for (const productAuthority of invalidAuthorities) {
      expect(() => encodeBackgroundWorkDescriptorV2({
        ...value,
        source: {
          ...namespaceSource,
          productAuthority,
        } as unknown as BackgroundProtectedMemoryWorkSourceV2,
      })).toThrow();
    }
    expect(() => encodeBackgroundWorkDescriptorV2({
      ...value,
      source: {
        ...namespaceSource,
        inputRevisions: namespaceSource.inputRevisions.map((entry) =>
          entry.productKind === "memory"
            ? { ...entry, accessKind: "scope_seed" as const }
            : entry
        ),
      },
    })).toThrow("match product authority");

    const mismatchedOrigin: BackgroundProtectedMemoryWorkSourceV2 = {
      ...scopeSource,
      productAuthority: {
        mode: "scope",
        scopeId: "scope-review-22",
        originWritableNamespaceId: namespaceId("namespace-ac-1"),
      },
      inputRevisions: scopeSource.inputRevisions.map((entry) =>
        entry.productKind === "memory"
          ? { ...entry, accessKind: "scope_origin" as const }
          : entry
      ),
    };
    expect(() => encodeBackgroundWorkDescriptorV2({
      ...scopeDescriptor,
      source: mismatchedOrigin,
    })).toThrow("scope-origin input");
  });

  test("requires exact create and replace revision authority", () => {
    const value = descriptor();
    const source = protectedMemorySource();
    const replaceInput = source.inputRevisions[0]!;
    if (replaceInput.productKind !== "memory") throw new Error("fixture");
    const replaceSource: BackgroundProtectedMemoryWorkSourceV2 = {
      ...source,
      outputRevisions: [{
        action: "replace",
        memoryId: replaceInput.productId,
        expectedContentRevision: replaceInput.productRevision,
        expectedCryptoAccessRevision: replaceInput.cryptoAccessRevision,
        nextContentRevision: replaceInput.productRevision + 1,
        objectId: objectId("memory-output-1"),
        publicationIdempotencyId: "replace-memory-input-1",
      }],
    };
    expect(() => encodeBackgroundWorkDescriptorV2({
      ...value,
      source: replaceSource,
    })).not.toThrow();

    const invalid = [
      { ...replaceSource.outputRevisions[0]!, expectedCryptoAccessRevision: 4 },
      { ...replaceSource.outputRevisions[0]!, expectedContentRevision: 6 },
      { ...replaceSource.outputRevisions[0]!, nextContentRevision: 9 },
      { ...source.outputRevisions[0]!, expectedCryptoAccessRevision: 1 },
      { ...source.outputRevisions[0]!, nextContentRevision: 2 },
    ];
    for (const output of invalid) {
      expect(() => encodeBackgroundWorkDescriptorV2({
        ...value,
        source: { ...source, outputRevisions: [output] },
      })).toThrow();
    }
  });

  test("binds meaningful tier mutations to exact Memory revisions and encrypt authority", () => {
    const value = descriptor();
    const source = protectedMemorySource();
    const memoryInput = source.inputRevisions[0]!;
    if (memoryInput.productKind !== "memory") throw new Error("fixture");
    const tierOnly: BackgroundProtectedMemoryWorkSourceV2 = {
      ...source,
      outputRevisions: [],
      tierMutations: [{
        operationIdempotencyId: "tier-memory-input-1",
        memoryId: memoryInput.productId,
        contentRevision: memoryInput.productRevision,
        cryptoAccessRevision: memoryInput.cryptoAccessRevision,
        objectId: memoryInput.objectId,
        action: "promote",
        expectedTier: 2,
        nextTier: 1,
        requiredNamespaceIds: [namespaceId("namespace-ab-1")],
      }],
    };
    const candidate: BackgroundWorkDescriptorV2 = {
      ...value,
      source: tierOnly,
      outputSlots: [],
      namespaceRequirements: value.namespaceRequirements.slice(0, 2),
      domainRequirements: value.domainRequirements.slice(0, 2),
      maximumOutputObjectCount: 0,
    };
    expect(() => encodeBackgroundWorkDescriptorV2(candidate)).not.toThrow();

    for (const mutation of [
      { ...tierOnly.tierMutations[0]!, expectedTier: 1 as const },
      { ...tierOnly.tierMutations[0]!, nextTier: 2 as const },
      { ...tierOnly.tierMutations[0]!, nextTier: 3 as const },
      { ...tierOnly.tierMutations[0]!, action: "demote" as const, expectedTier: 1 as const, nextTier: 1 as const },
      { ...tierOnly.tierMutations[0]!, action: "demote" as const, expectedTier: 1 as const, nextTier: 3 as const },
      { ...tierOnly.tierMutations[0]!, action: "demote" as const, expectedTier: 2 as const, nextTier: 1 as const },
      { ...tierOnly.tierMutations[0]!, action: "demote" as const, expectedTier: 2 as const, nextTier: 2 as const },
      { ...tierOnly.tierMutations[0]!, cryptoAccessRevision: 4 },
      { ...tierOnly.tierMutations[0]!, requiredNamespaceIds: [namespaceId("namespace-ac-1")] },
    ]) {
      expect(() => encodeBackgroundWorkDescriptorV2({
        ...candidate,
        source: { ...tierOnly, tierMutations: [mutation] },
      })).toThrow();
    }

    expect(() => encodeBackgroundWorkDescriptorV2({
      ...candidate,
      namespaceRequirements: candidate.namespaceRequirements.map((entry) =>
        entry.namespaceId === namespaceId("namespace-ab-1")
          ? { ...entry, operations: ["decrypt"] as const }
          : entry
      ),
      operations: ["decrypt"],
    })).toThrow("required operations");

    const scopeSeed: BackgroundProtectedMemoryWorkSourceV2 = {
      ...tierOnly,
      productAuthority: {
        mode: "scope",
        scopeId: "scope-review-22",
        originWritableNamespaceId: namespaceId("namespace-ab-1"),
      },
      inputRevisions: tierOnly.inputRevisions.map((entry) =>
        entry.productKind === "memory"
          ? { ...entry, accessKind: "scope_seed" as const }
          : entry
      ),
    };
    expect(() => encodeBackgroundWorkDescriptorV2({
      ...candidate,
      source: scopeSeed,
    })).toThrow("writable input revision");
  });

  test("bounds tier authority edges and the combined result inventory", () => {
    const value = descriptor();
    const source = protectedMemorySource();
    const memoryInput = source.inputRevisions[0]!;
    if (memoryInput.productKind !== "memory") throw new Error("fixture");
    const requiredNamespaceIds = Array.from(
      { length: MAX_BACKGROUND_AUTHORITY_BINDING_EDGES_V2 - 1 },
      (_, index) => namespaceId(
        index === 0
          ? "namespace-ab-1"
          : `namespace-tier-${String(index).padStart(3, "0")}`,
      ),
    );
    const mutation = {
      operationIdempotencyId: "tier-memory-input-1",
      memoryId: memoryInput.productId,
      contentRevision: memoryInput.productRevision,
      cryptoAccessRevision: memoryInput.cryptoAccessRevision,
      objectId: memoryInput.objectId,
      action: "promote" as const,
      expectedTier: 2 as const,
      nextTier: 1 as const,
      requiredNamespaceIds,
    };
    expect(() => encodeBackgroundWorkDescriptorV2({
      ...value,
      source: { ...source, outputRevisions: [], tierMutations: [mutation] },
      outputSlots: [],
      maximumOutputObjectCount: 0,
    })).toThrow("binding edges");

    expect(() => encodeBackgroundWorkDescriptorV2({
      ...value,
      source: {
        ...source,
        tierMutations: Array.from(
          { length: V2_LIMITS.batchItems },
          (_, index) => ({
            ...mutation,
            operationIdempotencyId: `tier-${String(index).padStart(3, "0")}`,
            requiredNamespaceIds: [namespaceId("namespace-ab-1")],
          }),
        ),
      },
    })).toThrow("result actions");
  });

  test("requires globally unique protected-work operation ids", () => {
    const value = descriptor();
    const source = protectedMemorySource();
    const memoryInput = source.inputRevisions[0]!;
    if (memoryInput.productKind !== "memory") throw new Error("fixture");
    expect(() => encodeBackgroundWorkDescriptorV2({
      ...value,
      source: {
        ...source,
        tierMutations: [{
          operationIdempotencyId:
            source.outputRevisions[0]!.publicationIdempotencyId,
          memoryId: memoryInput.productId,
          contentRevision: memoryInput.productRevision,
          cryptoAccessRevision: memoryInput.cryptoAccessRevision,
          objectId: memoryInput.objectId,
          action: "demote",
          expectedTier: 1,
          nextTier: 2,
          requiredNamespaceIds: [namespaceId("namespace-ab-1")],
        }],
      },
    })).toThrow("idempotency ids");

    const replace = {
      action: "replace" as const,
      memoryId: memoryInput.productId,
      expectedContentRevision: memoryInput.productRevision,
      expectedCryptoAccessRevision: memoryInput.cryptoAccessRevision,
      nextContentRevision: memoryInput.productRevision + 1,
      objectId: objectId("memory-output-1"),
      publicationIdempotencyId: "replace-memory-input-1",
    };
    expect(() => encodeBackgroundWorkDescriptorV2({
      ...value,
      source: {
        ...source,
        outputRevisions: [replace],
        tierMutations: [{
          operationIdempotencyId: "tier-memory-input-1",
          memoryId: memoryInput.productId,
          contentRevision: memoryInput.productRevision,
          cryptoAccessRevision: memoryInput.cryptoAccessRevision,
          objectId: memoryInput.objectId,
          action: "promote",
          expectedTier: 2,
          nextTier: 1,
          requiredNamespaceIds: [namespaceId("namespace-ab-1")],
        }],
      },
    })).toThrow("result Memory ids");
  });

  test("uses kind-aware product revision origins without changing the wire", () => {
    const value = descriptor();
    const source = protectedMemorySource();
    const messageZero = {
      ...value,
      source: {
        ...source,
        inputRevisions: source.inputRevisions.map((entry) =>
          entry.productKind === "message"
            ? { ...entry, productRevision: 0 }
            : entry
        ),
      },
    };
    const bytes = encodeBackgroundWorkDescriptorV2(messageZero);
    expect(decodeBackgroundWorkDescriptorV2(bytes)).toEqual(messageZero);

    const invalid = [
      source.inputRevisions.map((entry) =>
        entry.productKind === "memory"
          ? { ...entry, productRevision: 0 }
          : entry
      ),
      source.inputRevisions.map((entry) =>
        entry.productKind === "message"
          ? { ...entry, productRevision: -1 }
          : entry
      ),
      source.inputRevisions.map((entry) =>
        entry.productKind === "message"
          ? { ...entry, productRevision: Number.MAX_SAFE_INTEGER + 1 }
          : entry
      ),
    ];
    for (const inputRevisions of invalid) {
      expect(() => encodeBackgroundWorkDescriptorV2({
        ...value,
        source: { ...source, inputRevisions },
      })).toThrow();
    }
  });

  test("rejects partial, substituted, and contradictory real Memory provenance", () => {
    const value = descriptor();
    const source = protectedMemorySource();
    const invalid: Array<readonly [BackgroundWorkDescriptorV2, string]> = [
      [{ ...value, source: { ...source, sourceVersion: 2 } as unknown as BackgroundProtectedMemoryWorkSourceV2 }, "source version"],
      [{ ...value, source: { ...source, extra: true } as unknown as BackgroundProtectedMemoryWorkSourceV2 }, "field set"],
      [{ ...value, source: { ...source, inputRevisions: source.inputRevisions.slice(0, 1) } }, "equal input bindings"],
      [{ ...value, source: { ...source, inputRevisions: [...source.inputRevisions].reverse() } }, "canonical"],
      [{ ...value, source: { ...source, inputRevisions: source.inputRevisions.map((entry, index) => index === 0 ? { ...entry, productKind: "artifact" } : entry) } as unknown as BackgroundProtectedMemoryWorkSourceV2 }, "product kind"],
      [{ ...value, source: { ...source, inputRevisions: source.inputRevisions.map((entry, index) => index === 0 ? { ...entry, productRevision: 0 } : entry) } }, "must be positive"],
      [{ ...value, source: { ...source, inputRevisions: source.inputRevisions.map((entry, index) => index === 0 ? { ...entry, objectId: objectId("substituted-input") } : entry) } }, "input revisions"],
      [{ ...value, source: { ...source, outputRevisions: [] } }, "equal Memory output slots"],
      [{ ...value, source: { ...source, outputRevisions: source.outputRevisions.map((entry) => ({ ...entry, nextContentRevision: 4 })) } }, "advance exactly once"],
      [{ ...value, outputSlots: value.outputSlots.map((entry) => ({ ...entry, objectType: "artifact.revision" })), source }, "Memory output slots"],
      [{ ...value, workKind: "task.execute", purpose: "task.execute", source }, "requires Memory work"],
    ];

    for (const [candidate, message] of invalid) {
      expect(() => encodeBackgroundWorkDescriptorV2(candidate))
        .toThrow(message);
    }
  });

  test("keeps the three revision axes independent", () => {
    const value = descriptor();
    expect(() => encodeBackgroundWorkDescriptorV2({
      ...value,
      subject: {
        ...value.subject,
        authorizationRevision: authorizationRevision(999),
      },
      namespaceRequirements: value.namespaceRequirements.map((entry) => ({
        ...entry,
        expectedPolicyRevision: authorizationRevision(
          entry.expectedPolicyRevision + 100,
        ),
      })),
      domainRequirements: value.domainRequirements.map((entry) => ({
        ...entry,
        expectedAgentAuthorizationRevision: authorizationRevision(
          entry.expectedAgentAuthorizationRevision + 200,
        ),
      })),
    })).not.toThrow();
  });

  test("rejects noncanonical, partial, extra, and contradictory authority", () => {
    const value = descriptor();
    const invalid: Array<readonly [BackgroundWorkDescriptorV2, string]> = [
      [{ ...value, extra: true } as BackgroundWorkDescriptorV2, "field set"],
      [{ ...value, grantScope: [...value.grantScope].reverse() }, "grant scope"],
      [{ ...value, grantScope: [value.grantScope[0]!, value.grantScope[0]!] }, "duplicate"],
      [{ ...value, inputBindings: [...value.inputBindings].reverse() }, "input bindings"],
      [{ ...value, outputSlots: [{
        ...value.outputSlots[0]!,
        namespaceIds: [...value.outputSlots[0]!.namespaceIds].reverse(),
      }] }, "Namespace ids"],
      [{ ...value, namespaceRequirements: [...value.namespaceRequirements].reverse() }, "Namespace requirements"],
      [{ ...value, domainRequirements: [...value.domainRequirements].reverse() }, "Domain requirements"],
      [{ ...value, namespaceRequirements: value.namespaceRequirements.slice(0, 2) }, "Namespace requirement set"],
      [{ ...value, domainRequirements: value.domainRequirements.slice(0, 2) }, "Domain requirement set"],
      [{ ...value, anchorNamespaceId: namespaceId("namespace-missing") }, "anchor"],
      [{ ...value, operations: ["decrypt"] }, "operation set"],
      [{
        ...value,
        namespaceRequirements: value.namespaceRequirements.map((entry, index) =>
          index === 0 ? { ...entry, operations: ["decrypt"] } : entry
        ),
      }, "required operations"],
    ];

    for (const [candidate, message] of invalid) {
      expect(() => encodeBackgroundWorkDescriptorV2(candidate))
        .toThrow(message);
    }
  });

  test("validates every descriptor shape, discriminator, budget, and lifetime", () => {
    const value = descriptor();
    const invalid: Array<readonly [unknown, string]> = [
      [null, "object"],
      [[], "object"],
      ["descriptor", "object"],
      [{ ...value, formatVersion: 1 }, "format version"],
      [{ ...value, requestId: "" }, "request id"],
      [{ ...value, recipientGeneration: -1 }, "recipient generation"],
      [{ ...value, workKind: "unknown" }, "work kind"],
      [{ ...value, purpose: "task.execute" }, "do not match"],
      [{ ...value, operations: "decrypt" }, "array"],
      [{ ...value, operations: [] }, "work operations"],
      [{ ...value, operations: ["decrypt", "decrypt"] }, "canonical"],
      [{ ...value, operations: ["read"] }, "unsupported"],
      [{ ...value, subject: null }, "object"],
      [{ ...value, subject: { ...value.subject, kind: "human" } }, "Agent subject"],
      [{ ...value, source: null }, "object"],
      [{ ...value, source: { ...value.source, kind: "object" } }, "work source is unsupported"],
      [{ ...value, source: { ...value.source, generation: -1 } }, "generation"],
      [{ ...value, source: { ...value.source, fingerprint: new Uint8Array(31) } }, "fingerprint"],
      [{ ...value, grantScope: "alice" }, "array"],
      [{ ...value, grantScope: [] }, "grant scope"],
      [{ ...value, inputBindings: "input" }, "array"],
      [{ ...value, inputBindings: [] }, "input bindings"],
      [{ ...value, outputSlots: "output" }, "array"],
      [{ ...value, outputSlots: [{ ...value.outputSlots[0]!, namespaceIds: "namespace" }] }, "array"],
      [{ ...value, namespaceRequirements: "requirements" }, "array"],
      [{ ...value, domainRequirements: "requirements" }, "array"],
      [{ ...value, maximumInputObjectCount: 1 }, "input object count"],
      [{ ...value, maximumOutputObjectCount: 0 }, "output object count"],
      [{ ...value, maximumPlaintextBytes: 0 }, "plaintext byte budget"],
      [{ ...value, maximumCiphertextBytes: 0 }, "ciphertext byte budget"],
      [{ ...value, recipientKeyId: "" }, "recipient key id"],
      [{ ...value, recipientPublicKey: new Uint8Array(64) }, "public key"],
      [{ ...value, issuedAt: value.notBefore + 1 }, "timestamps"],
      [{ ...value, notBefore: value.expiresAt }, "timestamps"],
      [{ ...value, expiresAt: value.issuedAt + 24 * 60 * 60 * 1_000 + 1 }, "TTL"],
      [{ ...value, idempotencyId: "" }, "idempotency id"],
    ];

    for (const [candidate, message] of invalid) {
      expect(() => encodeBackgroundWorkDescriptorV2(
        candidate as BackgroundWorkDescriptorV2,
      )).toThrow(message);
    }

    const sameSizeWrongFields = { ...value } as Record<string, unknown>;
    delete sameSizeWrongFields["purpose"];
    sameSizeWrongFields["replacement"] = value.purpose;
    expect(() => encodeBackgroundWorkDescriptorV2(
      sameSizeWrongFields as unknown as BackgroundWorkDescriptorV2,
    )).toThrow("field set");
  });

  test("enforces the aggregate binding-edge bound", () => {
    const value = descriptor();
    const namespaceIds = Array.from(
      { length: MAX_BACKGROUND_AUTHORITY_BINDING_EDGES_V2 - 1 },
      (_, index) => namespaceId(`namespace-${String(index).padStart(3, "0")}`),
    );
    const domain = cryptoDomainId("domain-ab");
    const atLimit: BackgroundWorkDescriptorV2 = {
      ...value,
      anchorNamespaceId: namespaceIds[0]!,
      anchorDomainId: domain,
      inputBindings: [{
        objectId: objectId("memory-input-1"),
        namespaceId: namespaceIds[0]!,
      }],
      outputSlots: [{
        ...value.outputSlots[0]!,
        namespaceIds,
      }],
      namespaceRequirements: namespaceIds.map((exactNamespaceId, index) => ({
        namespaceId: exactNamespaceId,
        domainId: domain,
        operations: index === 0
          ? ["decrypt", "encrypt"] as const
          : ["encrypt"] as const,
        expectedAccessRevision: accessRevision(index + 1),
        expectedPolicyRevision: authorizationRevision(index + 1),
      })),
      domainRequirements: [{
        domainId: domain,
        expectedEpoch: domainEpoch(31),
        expectedAgentAuthorizationRevision: authorizationRevision(41),
      }],
      maximumInputObjectCount: 1,
    };
    const atLimitBytes = encodeBackgroundWorkDescriptorV2(atLimit);
    expect(decodeBackgroundWorkDescriptorV2(atLimitBytes)).toEqual(atLimit);
    expect(() => encodeBackgroundWorkDescriptorV2({
      ...atLimit,
      outputSlots: [{
        ...atLimit.outputSlots[0]!,
        namespaceIds: atLimit.outputSlots[0]!.namespaceIds.slice(0, -1),
      }],
      namespaceRequirements: atLimit.namespaceRequirements.slice(0, -1),
    })).not.toThrow();
    expect(() => encodeBackgroundWorkDescriptorV2({
      ...atLimit,
      inputBindings: [
        ...atLimit.inputBindings,
        {
          objectId: objectId("memory-input-2"),
          namespaceId: namespaceIds[0]!,
        },
      ],
      maximumInputObjectCount: 2,
    })).toThrow("binding edges");
  });

  test("accepts equal issue/not-before and the exact maximum TTL", () => {
    const value = descriptor();
    const boundary = {
      ...value,
      issuedAt: 0,
      notBefore: 0,
      expiresAt: 24 * 60 * 60 * 1_000,
    };
    const encoded = encodeBackgroundWorkDescriptorV2(boundary);
    expect(decodeBackgroundWorkDescriptorV2(encoded)).toEqual(boundary);
  });

  test("rejects truncated, trailing, malformed-domain, and oversized wire", () => {
    const bytes = encodeBackgroundWorkDescriptorV2(descriptor());
    expect(() => decodeBackgroundWorkDescriptorV2("wire" as never))
      .toThrow("Uint8Array");
    expect(() => decodeBackgroundWorkDescriptorV2(bytes.slice(0, -1)))
      .toThrow();
    expect(() => decodeBackgroundWorkDescriptorV2(
      new Uint8Array([...bytes, 0]),
    )).toThrow("trailing");
    const changedDomain = bytes.slice();
    changedDomain[10] = changedDomain[10]! ^ 1;
    expect(() => decodeBackgroundWorkDescriptorV2(changedDomain)).toThrow();
    expect(() => decodeBackgroundAgentWorkDescriptorV2(
      new Uint8Array(MAX_BACKGROUND_WORK_DESCRIPTOR_WIRE_BYTES_V2 + 1),
    )).toThrow("wire limit");
    expect(() => decodeBackgroundWorkDescriptorV2(
      new Uint8Array(Math.max(MAX_BACKGROUND_WORK_DESCRIPTOR_WIRE_BYTES_V2, MAX_ANY_BACKGROUND_PROCESSOR_WORK_DESCRIPTOR_WIRE_BYTES_V2) + 1),
    )).toThrow("wire limit");
  });
});
