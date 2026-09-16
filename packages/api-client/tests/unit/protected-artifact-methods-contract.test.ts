import { describe, expect, test } from "bun:test";
import { NautiloApiClient, type NautiloApiFetch } from "../../src/client.ts";
import type { ProtectedArtifactPreparedPublicationRequestV1 } from "../../src/schemas/protected-artifact.ts";

const ARTIFACT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROW = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BLOB = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NS = "11111111-1111-4111-8111-111111111111";
const HASH = "A".repeat(43);

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function clientWith(handler: (url: string, init: RequestInit) => Promise<Response> | Response) {
  const fetchImpl: NautiloApiFetch = async (target, init) => handler(
    typeof target === "string" ? target : target instanceof URL ? target.href : target.url,
    init ?? {},
  );
  const client = new NautiloApiClient("https://nautilo.test", { fetchImpl });
  client.setToken("session-token");
  return client;
}

function prepared(): ProtectedArtifactPreparedPublicationRequestV1 {
  return {
    requestVersion: 1,
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
    encryptedControlPayloadBytesBase64url: "Y29udHJvbA",
    accessManifestBytesBase64url: "bWFuaWZlc3Q",
    namespaceEnvelopes: [{ namespaceId: NS, envelopeBytesBase64url: "ZW52ZWxvcGU" }],
    signedPublicationRequestBytesBase64url: "c2lnbmVk",
    ciphertextLength: 4,
    ciphertextSha256Base64url: HASH,
    chunkPlaintextBytes: 1_048_576,
    chunkCount: 1,
    mimeClass: "document",
    sizeBucket: "le_64_kib",
  };
}

async function* chunks(): AsyncGenerator<Uint8Array> {
  yield new Uint8Array([1, 2]);
  yield new Uint8Array([3, 4]);
}

describe("protected Human Artifact HTTP methods", () => {
  test("loads encrypted metadata and bounded complete ciphertext chunks", async () => {
    const frame = new Uint8Array(47);
    new DataView(frame.buffer).setUint32(0, 43, false);
    frame.fill(0x44, 4);
    const client = clientWith((url) => {
      if (!url.includes("/ciphertext?")) return response({
        dtoVersion: 1,
        status: "unavailable",
        reason: "encryption_pending",
      });
      return new Response(frame, { headers: {
        "content-type": "application/vnd.nautilo.artifact-blob-range-v1",
        "content-length": String(frame.length),
        "x-nautilo-artifact-id": ARTIFACT,
        "x-nautilo-artifact-revision": "1",
        "x-nautilo-crypto-access-revision": "0",
        "x-nautilo-blob-id": BLOB,
        "x-nautilo-blob-generation": "1",
        "x-nautilo-plaintext-length": "3",
        "x-nautilo-ciphertext-length": "220",
        "x-nautilo-ciphertext-sha256": HASH,
        "x-nautilo-chunk-plaintext-bytes": "1048576",
        "x-nautilo-chunk-count": "1",
        "x-nautilo-first-chunk-index": "0",
        "x-nautilo-returned-chunk-count": "1",
      } });
    });
    expect((await client.getProtectedArtifact(ARTIFACT)).status).toBe("unavailable");
    const range = await client.getProtectedArtifactCiphertextRange(ARTIFACT, {
      start: 0,
      endExclusive: 3,
    });
    expect(range).toMatchObject({ status: "encrypted_chunks", artifactId: ARTIFACT,
      firstChunkIndex: 0, returnedChunkCount: 1 });
    if (range.status !== "encrypted_chunks") throw new Error("range unavailable");
    expect(range.body).toEqual(frame);
  });

  test("plans, streams exact ciphertext, and publishes without plaintext JSON", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = clientWith(async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/publication-plan")) return response({
        dtoVersion: 1, status: "unavailable", reason: "target_encryption_not_ready",
      });
      if (init.method === "PUT") {
        const observed: number[] = [];
        const reader = (init.body as ReadableStream<Uint8Array>).getReader();
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          observed.push(...next.value);
        }
        expect(observed).toEqual([1, 2, 3, 4]);
        return response({
          dtoVersion: 1, status: "staged", operationId: "artifact-op-1",
          artifactId: ARTIFACT, blobId: BLOB, blobGeneration: 1,
          ciphertextLength: 4, ciphertextSha256Base64url: HASH,
        });
      }
      return response({
        dtoVersion: 1, status: "published", operationId: "artifact-op-1",
        artifactId: ARTIFACT, artifactRevision: 1, cryptoAccessRevision: 0,
        blobId: BLOB, blobGeneration: 1, requiredNamespaceIds: [NS],
      });
    });
    expect((await client.planProtectedArtifactPublication({
      requestVersion: 1, operation: "create", lifecycleAction: "activate", artifactId: null,
      anchorNamespaceId: NS, expectedArtifactRevision: 0,
      expectedCryptoAccessRevision: 0, expectedBlobGeneration: 0,
      expectedBlobId: null, mimeClass: "document", sizeBucket: "le_64_kib",
    })).status).toBe("unavailable");
    expect((await client.stageProtectedArtifactCiphertext({
      artifactId: ARTIFACT, operationId: "artifact-op-1", blobId: BLOB,
      blobGeneration: 1, ciphertextLength: 4,
      ciphertextSha256Base64url: HASH, ciphertext: chunks(),
    })).status).toBe("staged");
    expect((await client.publishProtectedArtifact(prepared())).status).toBe("published");
    expect(calls[1]!.init.headers).toMatchObject({
      "Content-Type": "application/vnd.nautilo.artifact-blob-v1",
      "Content-Length": "4",
    });
    expect(JSON.stringify(calls.map(({ init }) => init.body)))
      .not.toContain("plaintext");
  });

  test("rejects substituted ciphertext and publication receipts", async () => {
    const staged = clientWith(() => response({
      dtoVersion: 1, status: "staged", operationId: "other",
      artifactId: ARTIFACT, blobId: BLOB, blobGeneration: 1,
      ciphertextLength: 4, ciphertextSha256Base64url: HASH,
    }));
    expect(staged.stageProtectedArtifactCiphertext({
      artifactId: ARTIFACT, operationId: "artifact-op-1", blobId: BLOB,
      blobGeneration: 1, ciphertextLength: 4,
      ciphertextSha256Base64url: HASH, ciphertext: chunks(),
    })).rejects.toThrow("substituted");

    const published = clientWith(() => response({
      dtoVersion: 1, status: "replayed", operationId: "artifact-op-1",
      artifactId: ARTIFACT, artifactRevision: 2, cryptoAccessRevision: 0,
      blobId: BLOB, blobGeneration: 1, requiredNamespaceIds: [NS],
    }));
    expect(published.publishProtectedArtifact(prepared())).rejects.toThrow("substituted");
  });
});
