import { describe, expect, test } from "bun:test";

import {
  protectedArtifactDtoV1Schema,
  protectedArtifactPreparedPublicationRequestV1Schema,
  protectedArtifactPublicationPlanRequestV1Schema,
  protectedArtifactPublicationPlanResponseV1Schema,
} from "../../src/schemas/protected-artifact.ts";

const ARTIFACT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROW = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BLOB = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NS = "11111111-1111-4111-8111-111111111111";
const HASH = "A".repeat(43);
const BYTES = "AQ";

function plan() {
  return {
    dtoVersion: 1,
    status: "planned",
    planVersion: 1,
    operationId: "artifact-op-1",
    planDigestBase64url: HASH,
    operation: "create",
    lifecycleAction: "activate",
    artifactRowId: ROW,
    artifactId: ARTIFACT,
    anchorNamespaceId: NS,
    cryptoObjectId: `artifact:v1:${"a".repeat(64)}`,
    expectedArtifactRevision: 0,
    nextArtifactRevision: 1,
    expectedCryptoAccessRevision: 0,
    resultCryptoAccessRevision: 0,
    expectedBlobGeneration: 0,
    resultBlobGeneration: 1,
    expectedBlobId: null,
    resultBlobId: BLOB,
    requiredNamespaceIds: [NS],
    bindings: [{
      namespaceId: NS,
      domainId: "domain-1",
      expectedAccessRevision: 2,
      expectedPolicyRevision: 3,
      bindingHashBase64url: HASH,
    }],
    maxPlaintextBytes: 104_857_600,
    maxCiphertextBytes: 110_100_000,
    chunkPlaintextBytes: 1_048_576,
    mimeClass: "document",
    sizeBucket: "le_10_mib",
    deadlineAt: 10_000,
  } as const;
}

describe("protected Artifact schemas", () => {
  test("accepts strict create and planned coordinates", () => {
    expect(protectedArtifactPublicationPlanRequestV1Schema.parse({
      requestVersion: 1,
      operation: "create",
      lifecycleAction: "activate",
      artifactId: null,
      anchorNamespaceId: NS,
      expectedArtifactRevision: 0,
      expectedCryptoAccessRevision: 0,
      expectedBlobGeneration: 0,
      expectedBlobId: null,
      mimeClass: "document",
      sizeBucket: "le_10_mib",
    }).operation).toBe("create");
    expect(protectedArtifactPublicationPlanResponseV1Schema.parse(plan()).status).toBe("planned");
  });

  test("rejects create/update ambiguity and substituted blob semantics", () => {
    expect(() => protectedArtifactPublicationPlanRequestV1Schema.parse({
      requestVersion: 1,
      operation: "create",
      lifecycleAction: "activate",
      artifactId: ARTIFACT,
      anchorNamespaceId: NS,
      expectedArtifactRevision: 1,
      expectedCryptoAccessRevision: 0,
      expectedBlobGeneration: 1,
      expectedBlobId: BLOB,
      mimeClass: "document",
      sizeBucket: "le_10_mib",
    })).toThrow();
    expect(() => protectedArtifactPublicationPlanResponseV1Schema.parse({
      ...plan(),
      operation: "revise_control",
    })).toThrow();
  });

  test("requires exact canonical prepared and read envelope inventories", () => {
    const prepared = {
      requestVersion: 1,
      ...plan(),
      dtoVersion: undefined,
      status: undefined,
      planVersion: undefined,
      bindings: undefined,
      maxPlaintextBytes: undefined,
      maxCiphertextBytes: undefined,
      deadlineAt: undefined,
      encryptedControlPayloadBytesBase64url: BYTES,
      accessManifestBytesBase64url: BYTES,
      namespaceEnvelopes: [{ namespaceId: NS, envelopeBytesBase64url: BYTES }],
      signedPublicationRequestBytesBase64url: BYTES,
      ciphertextLength: 100,
      ciphertextSha256Base64url: HASH,
      chunkCount: 1,
    };
    const exact = Object.fromEntries(Object.entries(prepared).filter(([, value]) => value !== undefined));
    expect(protectedArtifactPreparedPublicationRequestV1Schema.parse(exact).artifactId).toBe(ARTIFACT);
    expect(() => protectedArtifactPreparedPublicationRequestV1Schema.parse({
      ...exact,
      namespaceEnvelopes: [],
    })).toThrow();

    const dto = {
      dtoVersion: 1,
      status: "encrypted",
      artifactId: ARTIFACT,
      artifactRevision: 1,
      cryptoObjectId: plan().cryptoObjectId,
      cryptoAccessRevision: 0,
      requiredNamespaceIds: [NS],
      encryptedControlPayloadBytesBase64url: BYTES,
      accessManifestBytesBase64url: BYTES,
      accessManifestProofBytesBase64url: [],
      accessSignerEvidence: [],
      namespaceEnvelopes: [{ namespaceId: NS, envelopeBytesBase64url: BYTES }],
      blobId: BLOB,
      blobGeneration: 1,
      ciphertextLength: 100,
      ciphertextSha256Base64url: HASH,
      chunkPlaintextBytes: 1_048_576,
      chunkCount: 1,
      mimeClass: "document",
      sizeBucket: "le_10_mib",
      archived: false,
      canManageAccess: true,
    };
    expect(protectedArtifactDtoV1Schema.parse(dto).artifactId).toBe(ARTIFACT);
    expect(() => protectedArtifactDtoV1Schema.parse({ ...dto, plaintextPath: "/secret" })).toThrow();
  });
});
