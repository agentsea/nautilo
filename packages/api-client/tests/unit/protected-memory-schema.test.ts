import { describe, expect, test } from "bun:test";
import {
  MAX_HUMAN_MEMORY_EXACT_ACCESS_REQUEST_WIRE_BYTES_V2,
  MAX_OBJECT_ACCESS_MANIFEST_WIRE_BYTES_V5,
  MAX_RETAINED_NAMESPACE_GENERATIONS_V2,
} from
  "@nautilo/lattice-crypto/wire";
import * as browserSurface from "../../src/browser";
import * as rootSurface from "../../src/index";
import {
  protectedMemoryBriefResponseV1Schema,
  protectedMemoryCreatePlanSlotResponseV1Schema,
  protectedMemoryDtoV1Schema,
  protectedMemoryPreparedCreateRequestV1Schema,
  protectedMemoryPreparedUpdateRequestV1Schema,
  protectedMemorySearchResponseV1Schema,
  protectedMemoryUnavailableResponseV1Schema,
  protectedMemoryAccessPlanResponseV1Schema,
  protectedMemoryPreparedAccessRequestV1Schema,
} from "../../src/schemas/protected-memory";
import {
  protectedObjectAccessSignerEvidenceSetV1Schema,
} from "../../src/schemas/protected-object-access";

const NS_A = "11111111-1111-4111-8111-111111111111";
const NS_B = "22222222-2222-4222-8222-222222222222";
const authority = (namespaceId: string) => ({
  sourceRoomId: "33333333-3333-4333-8333-333333333333",
  namespaceId,
  currentGeneration: 1,
  retainedGenerations: [{ generation: 1, accessRevision: 2,
    headDigestBase64url: "aGVhZA", publicationDigestBase64url: "cHVi",
    publicationSetDigestBase64url: "c2V0",
    audienceFingerprintBase64url: "YXVkaWVuY2U" }],
});

function dto() {
  return {
    dtoVersion: 1 as const,
    projection: {
      memoryId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      contentRevision: 2,
      cryptoAccessRevision: 1,
      importance: 0.6,
      tier: 2,
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:01.000Z",
      namespaceIds: [NS_A, NS_B],
      requiredNamespaceIds: [NS_A, NS_B],
      readAuthorities: [authority(NS_A)],
      mutationAuthorities: [authority(NS_A), authority(NS_B)],
    },
    protectedPayload: {
      status: "encrypted" as const,
      cryptoObjectId: "memory:v1:abc",
      payloadVersion: 1 as const,
      encryptedPayloadBytesBase64url: "YWJj",
      accessManifestBytesBase64url: "ZGVm",
      accessSignerEvidence: [],
      namespaceEnvelopes: [
        { namespaceId: NS_A, envelopeBytesBase64url: "Z2hp" },
        { namespaceId: NS_B, envelopeBytesBase64url: "amts" },
      ],
    },
  };
}

describe("protected Memory browser DTO", () => {
  test("does not impose a separate signer-count or display-name ceiling", () => {
    const value = dto();
    const accessSignerEvidence = Array.from({ length: 513 }, (_, index) => ({
      kind: "human_device" as const,
      subjectHumanId: "10000000-0000-4000-8000-000000000001",
      committerDeviceId: `device:${index}`,
      hostAuthorizationRevision: 1,
      signingPublicKeyBase64url: "KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio",
    }));
    const displayName = "x".repeat(257);
    // A single Namespace may contain more Humans than the Namespace-inventory
    // bound; the people-only projection must not inherit that unrelated cap.
    const accessList = Array.from({ length: 257 }, (_, index) => ({
      userHandle: `reader${index}`, displayName,
    }));
    const parsed = protectedMemoryDtoV1Schema.parse({
      ...value,
      projection: { ...value.projection, accessList },
      protectedPayload: { ...value.protectedPayload, accessSignerEvidence },
    });
    expect(parsed.projection.accessList?.[0]?.displayName).toBe(displayName);
    expect(parsed.projection.accessList).toEqual(accessList);
    expect(parsed.protectedPayload).toMatchObject({ accessSignerEvidence });
    expect(() => protectedMemoryDtoV1Schema.parse({
      ...value,
      protectedPayload: { ...value.protectedPayload,
        accessSignerEvidence: [...accessSignerEvidence, accessSignerEvidence[0]] },
    })).toThrow();
  });

  test("admits the complete canonical V2 retained-generation history", () => {
    const retainedGenerations = Array.from({
      length: MAX_RETAINED_NAMESPACE_GENERATIONS_V2,
    }, (_, generation) => ({
      generation,
      accessRevision: generation,
      headDigestBase64url: "aGVhZA",
      publicationDigestBase64url: "cHVi",
      publicationSetDigestBase64url: "c2V0",
      audienceFingerprintBase64url: "YXVkaWVuY2U",
    }));
    const exactAuthority = {
      ...authority(NS_A),
      currentGeneration: MAX_RETAINED_NAMESPACE_GENERATIONS_V2 - 1,
      retainedGenerations,
    };
    const candidate = {
      ...dto(),
      projection: {
        ...dto().projection,
        readAuthorities: [exactAuthority],
        mutationAuthorities: undefined,
      },
    };
    expect(protectedMemoryDtoV1Schema.safeParse(candidate).success).toBe(true);
    expect(protectedMemoryDtoV1Schema.safeParse({
      ...candidate,
      projection: { ...candidate.projection, readAuthorities: [{
        ...exactAuthority,
        retainedGenerations: [...retainedGenerations, {
          ...retainedGenerations[0]!,
          generation: MAX_RETAINED_NAMESPACE_GENERATIONS_V2,
        }],
      }] },
    }).success).toBe(false);
    expect(protectedMemoryDtoV1Schema.safeParse({
      ...candidate,
      projection: { ...candidate.projection, readAuthorities: [{
        ...exactAuthority,
        retainedGenerations: [retainedGenerations[1]!, retainedGenerations[0]!],
      }] },
    }).success).toBe(false);
    expect(protectedMemoryDtoV1Schema.safeParse({
      ...candidate,
      projection: { ...candidate.projection, readAuthorities: [{
        ...exactAuthority,
        retainedGenerations: retainedGenerations.slice(0, -1),
      }] },
    }).success).toBe(false);
  });

  test("ordinary fallback is an explicit bounded sibling, not a verification receipt", () => {
    const ordinaryFallback = { policyRevision: 7,
      payload: { formatVersion: 1, type: "fact", content: "ordinary sibling" } };
    const pending = { ...dto(), ordinaryFallback,
      protectedPayload: { status: "pending", reason: "backfill_pending" } };
    expect(protectedMemoryDtoV1Schema.parse(pending)).toMatchObject({ ordinaryFallback });
    expect(protectedMemoryDtoV1Schema.parse(pending).readObservationAdmission).toBeUndefined();
    for (const invalid of [
      { ...ordinaryFallback, policyRevision: 0 },
      { ...ordinaryFallback, verified: true },
      { ...ordinaryFallback, payload: { ...ordinaryFallback.payload, signature: "fake" } },
      { ...ordinaryFallback, payload: { ...ordinaryFallback.payload, type: "é".repeat(129) } },
      { ...ordinaryFallback, payload: { ...ordinaryFallback.payload, content: "é".repeat(32_769) } },
    ]) expect(protectedMemoryDtoV1Schema.safeParse({ ...pending, ordinaryFallback: invalid }).success).toBe(false);
  });

  test("read observation admission cannot manufacture an eligible pending row", () => {
    const readObservationAdmission = { tokenBase64url: "A".repeat(43),
      policyRevision: 1, issuedAt: 10, expiresAt: 20 };
    expect(protectedMemoryDtoV1Schema.safeParse({ ...dto(), readObservationAdmission }).success).toBe(true);
    expect(protectedMemoryDtoV1Schema.safeParse({ ...dto(), readObservationAdmission,
      protectedPayload: { status: "pending", reason: "backfill_pending" } }).success).toBe(false);
    for (const delta of [{ expiresAt: 10 }, { policyRevision: 0 }, { tokenBase64url: "short" }]) {
      expect(protectedMemoryDtoV1Schema.safeParse({ ...dto(),
        readObservationAdmission: { ...readObservationAdmission, ...delta } }).success).toBe(false);
    }
  });

  test("read observation admission uses real Unix milliseconds rather than database int32 revisions", () => {
    const readObservationAdmission = { tokenBase64url: "A".repeat(43),
      policyRevision: 1, issuedAt: Date.UTC(2026, 8, 7),
      expiresAt: Date.UTC(2026, 8, 7) + 300_000 };
    expect(protectedMemoryDtoV1Schema.parse({ ...dto(), readObservationAdmission })
      .readObservationAdmission).toEqual(readObservationAdmission);
    for (const issuedAt of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(protectedMemoryDtoV1Schema.safeParse({ ...dto(),
        readObservationAdmission: { ...readObservationAdmission, issuedAt },
      }).success).toBe(false);
    }
  });

  test("Shadow comparison carries only a digest alongside current ciphertext", () => {
    const shadowComparison = { algorithm: "sha256-memory-payload-v1", digestBase64url: "A".repeat(43) };
    expect(protectedMemoryDtoV1Schema.parse({ ...dto(), shadowComparison }))
      .toMatchObject({ shadowComparison });
    for (const invalid of [
      { ...shadowComparison, content: "ordinary body must not travel here" },
      { ...shadowComparison, algorithm: "plaintext" },
      { ...shadowComparison, digestBase64url: "short" },
    ]) expect(protectedMemoryDtoV1Schema.safeParse({ ...dto(), shadowComparison: invalid }).success).toBe(false);
    expect(protectedMemoryDtoV1Schema.safeParse({ ...dto(), shadowComparison,
      protectedPayload: { status: "pending", reason: "backfill_pending" },
    }).success).toBe(false);
  });

  test("revision zero is an ordinary historical projection, never encrypted success", () => {
    const ordinary = { ...dto(), projection: { ...dto().projection,
      contentRevision: 0, readAuthorities: [] },
      protectedPayload: { status: "pending", reason: "backfill_pending" } };
    expect(protectedMemoryDtoV1Schema.safeParse(ordinary).success).toBe(true);
    expect(protectedMemoryDtoV1Schema.safeParse({ ...dto(),
      projection: { ...dto().projection, contentRevision: 0 } }).success).toBe(false);
  });

  test("exports the canonical prepared request schema from root and browser surfaces", () => {
    expect(rootSurface.protectedMemoryPreparedUpdateRequestV1Schema)
      .toBe(protectedMemoryPreparedUpdateRequestV1Schema);
    expect(browserSurface.protectedMemoryPreparedUpdateRequestV1Schema)
      .toBe(protectedMemoryPreparedUpdateRequestV1Schema);
    expect(rootSurface.protectedMemoryPreparedCreateRequestV1Schema)
      .toBe(protectedMemoryPreparedCreateRequestV1Schema);
    expect(browserSurface.protectedMemoryPreparedCreateRequestV1Schema)
      .toBe(protectedMemoryPreparedCreateRequestV1Schema);
    expect(rootSurface.protectedMemoryCreatePlanSlotResponseV1Schema)
      .toBe(protectedMemoryCreatePlanSlotResponseV1Schema);
    expect(browserSurface.protectedMemoryCreatePlanSlotResponseV1Schema)
      .toBe(protectedMemoryCreatePlanSlotResponseV1Schema);
  });

  test("accepts an exact multi-Namespace encrypted projection", () => {
    expect(protectedMemoryDtoV1Schema.parse(dto())).toEqual(dto());
    const reversed = dto();
    reversed.projection.namespaceIds.reverse();
    reversed.projection.requiredNamespaceIds.reverse();
    reversed.protectedPayload.namespaceEnvelopes.reverse();
    expect(() => protectedMemoryDtoV1Schema.parse(reversed)).toThrow();
  });

  test("accepts only exact unique Memory Human signer evidence", () => {
    const entry = {
      kind: "human_device" as const,
      subjectHumanId: "10000000-0000-4000-8000-000000000001",
      committerDeviceId: "device:peer",
      hostAuthorizationRevision: 7,
      signingPublicKeyBase64url:
        "KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio",
    };
    expect(protectedMemoryDtoV1Schema.parse({
      ...dto(),
      protectedPayload: {
        ...dto().protectedPayload,
        accessSignerEvidence: [entry],
      },
    }).protectedPayload).toMatchObject({ accessSignerEvidence: [entry] });
    expect(() => protectedMemoryDtoV1Schema.parse({
      ...dto(),
      protectedPayload: {
        ...dto().protectedPayload,
        accessSignerEvidence: [entry, entry],
      },
    })).toThrow();
    expect(() => protectedMemoryDtoV1Schema.parse({
      ...dto(),
      protectedPayload: {
        ...dto().protectedPayload,
        accessSignerEvidence: [{ ...entry, subjectHumanId: "human:forged" }],
      },
    })).toThrow();
  });

  test("allows no read authority while protection is pending but not once encrypted", () => {
    const value = dto();
    const projection = { ...value.projection, readAuthorities: [] };
    const pending = {
      ...value,
      projection,
      protectedPayload: { status: "pending" as const, reason: "shadow_pending" as const },
    };
    expect(protectedMemoryDtoV1Schema.parse(pending)).toEqual(pending);
    expect(() => protectedMemoryDtoV1Schema.parse({
      ...value,
      projection,
    })).toThrow();
  });

  test("bounds strict canonical signer-evidence transport", () => {
    const value = dto();
    const issuerEvidence = {
      kind: "evidence_issuer_human_device" as const,
      subjectHumanId: "33333333-3333-4333-8333-333333333333",
      deviceId: "device:issuer",
      hostAuthorizationRevision: 4,
      signingPublicKeyBase64url: "A".repeat(43),
    };
    expect(protectedMemoryDtoV1Schema.safeParse({
      ...value,
      protectedPayload: { ...value.protectedPayload,
        accessSignerEvidence: [issuerEvidence] },
    }).success).toBeTrue();
    expect(protectedMemoryDtoV1Schema.safeParse({
      ...value,
      protectedPayload: { ...value.protectedPayload,
        accessSignerEvidence: [issuerEvidence, issuerEvidence] },
    }).success).toBeFalse();
    expect(protectedObjectAccessSignerEvidenceSetV1Schema.safeParse([{
      kind: "agent_runtime_publication",
      evidenceBytesBase64url: "A",
    }]).success).toBeFalse();
    expect(protectedObjectAccessSignerEvidenceSetV1Schema.safeParse([{
      kind: "server_key" as never,
      evidenceBytesBase64url: "YWJj",
    }]).success).toBeFalse();
    expect(protectedObjectAccessSignerEvidenceSetV1Schema.safeParse([
      { kind: "agent_runtime_publication", evidenceBytesBase64url: "A".repeat(349_526) },
      { kind: "agent_runtime_publication", evidenceBytesBase64url: "B".repeat(349_526) },
      { kind: "processor_authorization", evidenceBytesBase64url: "C".repeat(349_526) },
      { kind: "processor_authorization", evidenceBytesBase64url: "D".repeat(349_526) },
    ]).success).toBeFalse();
  });

  test("retains one bounded unique product-projected audience list", () => {
    const value = dto();
    const projection = {
      ...value.projection,
      accessList: [
        { userHandle: "alice", displayName: "Alice" },
        { userHandle: "bob", displayName: "Bob" },
      ],
    };
    expect(protectedMemoryDtoV1Schema.parse({
      ...value,
      projection,
    })).toEqual({ ...value, projection });

    expect(() => protectedMemoryDtoV1Schema.parse({
      ...value,
      projection: {
        ...projection,
        accessList: [projection.accessList[0], projection.accessList[0]],
      },
    })).toThrow();
  });

  test("represents a scope-only Memory without inventing a product Namespace attachment", () => {
    const value = dto();
    const scopeProjection = {
      ...value.projection,
      namespaceIds: [],
      requiredNamespaceIds: [NS_A],
      readAuthorities: [authority(NS_A)],
      mutationAuthorities: [authority(NS_A)],
      scopeOrigin: "scope" as const,
    };
    value.protectedPayload.namespaceEnvelopes = [
      { namespaceId: NS_A, envelopeBytesBase64url: "Z2hp" },
    ];
    expect(protectedMemoryDtoV1Schema.parse({
      ...value,
      projection: scopeProjection,
    })).toEqual({ ...value, projection: scopeProjection });
  });

  test("contains no plaintext content/type fields and rejects unknown ones", () => {
    expect(() => protectedMemoryDtoV1Schema.parse({
      ...dto(),
      content: "plaintext canary",
    })).toThrow();
    expect(() => protectedMemoryDtoV1Schema.parse({
      ...dto(),
      type: "personal-secret",
    })).toThrow();
  });

  test("rejects incomplete, duplicate, or extra Namespace envelopes", () => {
    for (const namespaceEnvelopes of [
      [{ namespaceId: NS_A, envelopeBytesBase64url: "Z2hp" }],
      [
        { namespaceId: NS_A, envelopeBytesBase64url: "Z2hp" },
        { namespaceId: NS_A, envelopeBytesBase64url: "amts" },
      ],
      [
        { namespaceId: NS_A, envelopeBytesBase64url: "Z2hp" },
        { namespaceId: "33333333-3333-4333-8333-333333333333", envelopeBytesBase64url: "amts" },
      ],
    ]) {
      const value = dto();
      value.protectedPayload.namespaceEnvelopes = namespaceEnvelopes;
      expect(() => protectedMemoryDtoV1Schema.parse(value)).toThrow();
    }
  });

  test("defines bounded encrypted search and client-local brief candidates", () => {
    expect(protectedMemorySearchResponseV1Schema.parse({
      dtoVersion: 1,
      items: [{ memory: dto(), score: 0.75 }],
      memoryMode: "namespace",
      queryDisclosure: "embedding_provider",
    }).items[0]?.score).toBe(0.75);
    expect(protectedMemoryBriefResponseV1Schema.parse({
      dtoVersion: 1,
      items: [dto()],
      memoryMode: "namespace",
    }).items).toHaveLength(1);
    expect(protectedMemoryUnavailableResponseV1Schema.parse({
      dtoVersion: 1,
      status: "unavailable",
      reason: "text_search_unsupported",
    }).reason).toBe("text_search_unsupported");
  });

  test("accepts only ciphertext-bound exact-set prepared updates", () => {
    const request = {
      requestVersion: 1 as const,
      operationId: "memory-update:1",
      expectedContentRevision: 2,
      nextContentRevision: 3,
      cryptoObjectId: "memory:v1:def",
      payloadVersion: 1 as const,
      encryptedPayloadBytesBase64url: "YWJj",
      accessManifestBytesBase64url: "ZGVm",
      requiredNamespaceIds: [NS_A, NS_B],
      namespaceEnvelopes: [
        { namespaceId: NS_A, envelopeBytesBase64url: "Z2hp" },
        { namespaceId: NS_B, envelopeBytesBase64url: "amts" },
      ],
      signedContentEmbeddingRequestBytesBase64url: "c2lnbmVkLXJlcXVlc3Q",
    };
    expect(protectedMemoryPreparedUpdateRequestV1Schema.parse(request))
      .toEqual(request);
    expect(() => protectedMemoryPreparedUpdateRequestV1Schema.parse({
      ...request,
      signedContentEmbeddingRequestBytesBase64url: "A",
    })).toThrow();
    expect(() => protectedMemoryPreparedUpdateRequestV1Schema.parse({
      ...request,
      content: "plaintext must never cross this route",
    })).toThrow();
    expect(() => protectedMemoryPreparedUpdateRequestV1Schema.parse({
      ...request,
      nextContentRevision: 4,
    })).toThrow();
    expect(() => protectedMemoryPreparedUpdateRequestV1Schema.parse({
      ...request,
      namespaceEnvelopes: request.namespaceEnvelopes.slice(0, 1),
    })).toThrow();
    expect(() => protectedMemoryPreparedUpdateRequestV1Schema.parse({
      ...request,
      requiredNamespaceIds: [...request.requiredNamespaceIds].reverse(),
      namespaceEnvelopes: [...request.namespaceEnvelopes].reverse(),
    })).toThrow();
    expect(() => protectedMemoryPreparedUpdateRequestV1Schema.parse({
      ...request,
      namespaceEnvelopes: [...request.namespaceEnvelopes].reverse(),
    })).toThrow();
    expect(() => protectedMemoryPreparedUpdateRequestV1Schema.parse({
      ...request,
      signedContentEmbeddingRequestBytesBase64url: undefined,
      embedding: {
        provider: "openai",
        model: "text-embedding-3-small",
        dimensions: 1536,
        contractVersion: 1,
        vector: Array.from({ length: 1536 }, () => 0.01),
      },
    })).toThrow();
  });

  test("accepts exact access plans and empty-target authorized-view removal", () => {
    const plan = {
      dtoVersion: 1 as const, status: "planned" as const, planVersion: 1 as const,
      operationId: "access:1", memoryId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expectedContentRevision: 2, expectedCryptoAccessRevision: 1,
      cryptoObjectId: "memory:1", currentNamespaceIds: [NS_A],
      targetNamespaceIds: [], addedNamespaceIds: [], removedNamespaceIds: [NS_A],
      currentAuthorities: [authority(NS_A)], targetAuthorities: [],
      deadlineAt: 1_900_000_000_000,
    };
    expect(protectedMemoryAccessPlanResponseV1Schema.parse(plan)).toEqual(plan);
    const readiness = {
      dtoVersion: 1 as const, status: "readiness_required" as const,
      reason: "target_encryption_not_ready" as const,
      memoryId: plan.memoryId,
      sourceRoomId: "33333333-3333-4333-8333-333333333333",
      requiredNamespaceIds: [NS_B],
    };
    expect(protectedMemoryAccessPlanResponseV1Schema.parse(readiness))
      .toEqual(readiness);
    for (const candidate of [
      { ...plan, currentAuthorities: [] },
      { ...plan, targetAuthorities: [authority(NS_A)] },
      { ...plan, addedNamespaceIds: [NS_A] },
      { ...plan, removedNamespaceIds: [] },
    ]) {
      expect(() => protectedMemoryAccessPlanResponseV1Schema.parse(candidate))
        .toThrow();
    }
    expect(protectedMemoryPreparedAccessRequestV1Schema.parse({
      requestVersion: 1, operationId: plan.operationId, memoryId: plan.memoryId,
      expectedContentRevision: 2, expectedCryptoAccessRevision: 1,
      nextCryptoAccessRevision: 2, cryptoObjectId: plan.cryptoObjectId,
      currentNamespaceIds: [NS_A], targetNamespaceIds: [],
      accessManifestBytesBase64url: "bWFuaWZlc3Q", namespaceEnvelopes: [],
      signedAccessRequestBytesBase64url: "c2lnbmVkLWFjY2Vzcy1yZXF1ZXN0",
    }).targetNamespaceIds).toEqual([]);
    const signedRequestMaxCharacters = Math.ceil(
      MAX_HUMAN_MEMORY_EXACT_ACCESS_REQUEST_WIRE_BYTES_V2 * 4 / 3,
    );
    const base = protectedMemoryPreparedAccessRequestV1Schema.parse({
      requestVersion: 1, operationId: plan.operationId, memoryId: plan.memoryId,
      expectedContentRevision: 2, expectedCryptoAccessRevision: 1,
      nextCryptoAccessRevision: 2, cryptoObjectId: plan.cryptoObjectId,
      currentNamespaceIds: [NS_A], targetNamespaceIds: [],
      accessManifestBytesBase64url: "bWFuaWZlc3Q", namespaceEnvelopes: [],
      signedAccessRequestBytesBase64url: "A".repeat(signedRequestMaxCharacters),
    });
    expect(base.signedAccessRequestBytesBase64url)
      .toHaveLength(signedRequestMaxCharacters);
    expect(() => protectedMemoryPreparedAccessRequestV1Schema.parse({
      ...base, signedAccessRequestBytesBase64url: `${base.signedAccessRequestBytesBase64url}A`,
    })).toThrow();
    const manifest = Buffer.alloc(MAX_OBJECT_ACCESS_MANIFEST_WIRE_BYTES_V5)
      .toString("base64url");
    expect(protectedMemoryPreparedAccessRequestV1Schema.parse({
      ...base, accessManifestBytesBase64url: manifest,
    }).accessManifestBytesBase64url).toBe(manifest);
    expect(() => protectedMemoryPreparedAccessRequestV1Schema.parse({
      ...base, accessManifestBytesBase64url: `${manifest}AA`,
    })).toThrow();
  });

  test("binds a content-free server-issued create slot", () => {
    const slot = {
      dtoVersion: 1 as const,
      memoryId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      operationId: "memory-create:1",
      expectedContentRevision: 0 as const,
      nextContentRevision: 1 as const,
      productAuthority: { mode: "namespace" as const },
      requiredNamespaceIds: [NS_A, NS_B],
      targetAuthorities: [authority(NS_A), authority(NS_B)],
      deadlineAt: 1_900_000_030_000,
    };
    expect(protectedMemoryCreatePlanSlotResponseV1Schema.parse(slot))
      .toEqual(slot);
    const generationZero = {
      ...slot,
      targetAuthorities: [{
        ...authority(NS_A),
        currentGeneration: 0,
        retainedGenerations: [{
          ...authority(NS_A).retainedGenerations[0]!,
          generation: 0,
        }],
      }, authority(NS_B)],
    };
    expect(protectedMemoryCreatePlanSlotResponseV1Schema.parse(generationZero))
      .toEqual(generationZero);
    for (const candidate of [
      { ...slot, requiredNamespaceIds: [NS_A, NS_A] },
      { ...slot, requiredNamespaceIds: [NS_B, NS_A] },
      { ...slot, targetAuthorities: [authority(NS_A)] },
      { ...slot, targetAuthorities: [] },
      { ...slot, memoryId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" },
      { ...slot, requiredNamespaceIds: [
        "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
      ] },
      { ...slot, deadlineAt: -1 },
      { ...slot, productAuthority: { mode: "namespace", scopeId: NS_A } },
      { ...slot, content: "plaintext" },
      { ...slot, namespaceKey: "secret" },
    ]) {
      expect(() => protectedMemoryCreatePlanSlotResponseV1Schema.parse(candidate))
        .toThrow();
    }
    const scopeSlot = {
      ...slot,
      productAuthority: {
        mode: "scope" as const,
        scopeId: "33333333-3333-4333-8333-333333333333",
        originWritableNamespaceId: NS_A,
      },
      requiredNamespaceIds: [NS_A],
      targetAuthorities: [authority(NS_A)],
    };
    expect(protectedMemoryCreatePlanSlotResponseV1Schema.parse(scopeSlot))
      .toEqual(scopeSlot);
    expect(() => protectedMemoryCreatePlanSlotResponseV1Schema.parse({
      ...scopeSlot,
      requiredNamespaceIds: [NS_B],
    })).toThrow();
  });

  test("accepts only exact ciphertext-bound prepared creates", () => {
    const request = {
      requestVersion: 1 as const,
      memoryId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      operationId: "memory-create:1",
      expectedContentRevision: 0 as const,
      nextContentRevision: 1 as const,
      cryptoObjectId: "memory:v1:create-1",
      payloadVersion: 1 as const,
      encryptedPayloadBytesBase64url: "YWJj",
      accessManifestBytesBase64url: "ZGVm",
      requiredNamespaceIds: [NS_A, NS_B],
      namespaceEnvelopes: [
        { namespaceId: NS_A, envelopeBytesBase64url: "Z2hp" },
        { namespaceId: NS_B, envelopeBytesBase64url: "amts" },
      ],
      signedContentEmbeddingRequestBytesBase64url: "c2lnbmVkLXJlcXVlc3Q",
    };
    expect(protectedMemoryPreparedCreateRequestV1Schema.parse(request))
      .toEqual(request);
    for (const candidate of [
      { ...request, memoryId: "client-chosen" },
      { ...request, expectedContentRevision: 1 },
      { ...request, nextContentRevision: 2 },
      { ...request, namespaceEnvelopes: request.namespaceEnvelopes.slice(0, 1) },
      { ...request, namespaceEnvelopes: [...request.namespaceEnvelopes].reverse() },
      { ...request, signedContentEmbeddingRequestBytesBase64url: "A" },
      { ...request, content: "plaintext" },
      { ...request, embedding: [0.1] },
    ]) {
      expect(() => protectedMemoryPreparedCreateRequestV1Schema.parse(candidate))
        .toThrow();
    }
  });

});
