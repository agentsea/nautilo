import { afterEach, describe, expect, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { HumanArtifactRoutePorts } from "@nautilo/lattice-bridge/server";
import { NautiloApiClient, type NautiloApiFetch } from "@nautilo/api-client";

import {
  createProtectedArtifactTestAuthority,
  createProtectedArtifactTestComposition,
} from "../../src/routes/protected-artifact-composition";
import { protectedArtifactRoutes } from "../../src/routes/protected-artifact-routes";

const NS = "11111111-1111-4111-8111-111111111111";
const ARTIFACT = "22222222-2222-4222-8222-222222222222";
const BLOB = "33333333-3333-4333-8333-333333333333";
const ROW = "44444444-4444-4444-8444-444444444444";
const HASH = "A".repeat(43);

function preparedPublication() {
  return {
    requestVersion: 1 as const,
    operationId: "artifact-publication:client-route",
    planDigestBase64url: HASH,
    operation: "create" as const,
    lifecycleAction: "activate" as const,
    artifactRowId: ROW,
    artifactId: ARTIFACT,
    anchorNamespaceId: NS,
    cryptoObjectId: `artifact:v1:${"a".repeat(64)}`,
    expectedArtifactRevision: 0,
    nextArtifactRevision: 1,
    expectedCryptoAccessRevision: 0,
    resultCryptoAccessRevision: 0 as const,
    expectedBlobGeneration: 0,
    resultBlobGeneration: 1,
    expectedBlobId: null,
    resultBlobId: BLOB,
    requiredNamespaceIds: [NS],
    encryptedControlPayloadBytesBase64url: "Y29udHJvbA",
    accessManifestBytesBase64url: "bWFuaWZlc3Q",
    namespaceEnvelopes: [{
      namespaceId: NS,
      envelopeBytesBase64url: "ZW52ZWxvcGU",
    }],
    signedPublicationRequestBytesBase64url: "c2lnbmVk",
    ciphertextLength: 4,
    ciphertextSha256Base64url: HASH,
    chunkPlaintextBytes: 1_048_576 as const,
    chunkCount: 1,
    mimeClass: "document" as const,
    sizeBucket: "le_64_kib" as const,
  };
}

const authority = Object.freeze({
  userId: "user-alice",
  subjectHumanId: "human-alice",
  actorId: "actor-alice",
  agentId: null,
  readableNamespaceIds: Object.freeze([NS]),
  mutableNamespaceIds: Object.freeze([NS]),
  writableNamespaceIds: Object.freeze([NS]),
});

const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function register(ports: HumanArtifactRoutePorts) {
  const app = Fastify();
  apps.push(app);
  protectedArtifactRoutes(app, {
    composition: createProtectedArtifactTestComposition({
      authority: createProtectedArtifactTestAuthority(),
      target: authority,
      ports,
    }),
    resolveAuthorizedRequest: () => Promise.resolve(authority),
  });
  return app;
}

function unavailableReadPorts(): Pick<
  HumanArtifactRoutePorts,
  "list" | "detail" | "ciphertextRange" | "planAccess" | "commitAccess"
> {
  return {
    list: () => Promise.resolve({
      dtoVersion: 1,
      status: "unavailable",
      reason: "authorization_required",
    }),
    detail: () => Promise.resolve({
      dtoVersion: 1,
      status: "unavailable",
      reason: "authorization_required",
    }),
    ciphertextRange: () => Promise.resolve({
      dtoVersion: 1,
      status: "unavailable",
      reason: "authorization_required",
    }),
    planAccess: () => Promise.resolve({
      dtoVersion: 1,
      status: "unavailable",
      reason: "authorization_required",
    }),
    commitAccess: () => Promise.resolve({
      dtoVersion: 1,
      status: "unavailable",
      reason: "authorization_required",
    }),
  };
}

describe("dormant protected Artifact routes", () => {
  test("composes the canonical API client through the dormant access routes", async () => {
    const prepared = {
      requestVersion: 1 as const, operationId: "artifact-access:client-route",
      artifactId: ARTIFACT, artifactRevision: 3,
      expectedCryptoAccessRevision: 1, nextCryptoAccessRevision: 2,
      cryptoObjectId: `artifact:v1:${"a".repeat(64)}`, blobId: BLOB,
      blobGeneration: 2, currentNamespaceIds: [NS], targetNamespaceIds: [],
      accessManifestBytesBase64url: "bWFuaWZlc3Q",
      signedAccessRequestBytesBase64url: "c2lnbmVk",
      namespaceEnvelopes: [],
    };
    const app = register({
      ...unavailableReadPorts(),
      planAccess: ({ artifactId }) => Promise.resolve({
        dtoVersion: 1, status: "unchanged", artifactId,
        cryptoAccessRevision: 1, requiredNamespaceIds: [NS],
      }),
      commitAccess: ({ artifactId }) => Promise.resolve({
        dtoVersion: 1, status: "updated", operationId: prepared.operationId,
        artifactId, cryptoAccessRevision: 2, requiredNamespaceIds: [],
      }),
      plan: () => Promise.resolve({ dtoVersion: 1, status: "unavailable",
        reason: "authorization_required" }),
      stageCiphertext: () => Promise.resolve({ dtoVersion: 1,
        status: "unavailable", reason: "authorization_required" }),
      publish: ({ prepared }) => Promise.resolve({
        dtoVersion: 1,
        status: "published",
        operationId: prepared.operationId,
        artifactId: prepared.artifactId,
        artifactRevision: prepared.nextArtifactRevision,
        cryptoAccessRevision: prepared.resultCryptoAccessRevision,
        blobId: prepared.resultBlobId,
        blobGeneration: prepared.resultBlobGeneration,
        requiredNamespaceIds: prepared.requiredNamespaceIds,
      }),
    });
    const fetchImpl: NautiloApiFetch = async (raw, init) => {
      const url = new URL(typeof raw === "string" ? raw
        : raw instanceof URL ? raw.href : raw.url);
      const response = await app.inject({
        method: (init?.method ?? "GET") as "GET" | "POST",
        url: `${url.pathname}${url.search}`,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        ...(typeof init?.body === "string" ? { payload: init.body } : {}),
      });
      return new Response(response.body, {
        status: response.statusCode,
        headers: { "content-type": "application/json" },
      });
    };
    const client = new NautiloApiClient("https://nautilo.test", { fetchImpl });
    client.setToken("test-session");
    expect(await client.planProtectedArtifactAccess(ARTIFACT, {
      requestVersion: 1,
      operation: { kind: "delete_authorized_view" },
    })).toMatchObject({ status: "unchanged", artifactId: ARTIFACT });
    expect(await client.commitProtectedArtifactAccess(ARTIFACT, prepared))
      .toEqual({ dtoVersion: 1, status: "updated",
        operationId: prepared.operationId, artifactId: ARTIFACT,
        cryptoAccessRevision: 2, requiredNamespaceIds: [] });
    expect(await client.publishProtectedArtifact(preparedPublication()))
      .toMatchObject({ status: "published", artifactId: ARTIFACT });
  });

  test("plans and commits strict exact access without legacy mutation routes", async () => {
    const app = register({
      ...unavailableReadPorts(),
      planAccess: ({ artifactId }) => Promise.resolve({
        dtoVersion: 1, status: "unchanged", artifactId,
        cryptoAccessRevision: 2, requiredNamespaceIds: [NS],
      }),
      commitAccess: ({ artifactId, prepared }) => Promise.resolve({
        dtoVersion: 1, status: "updated", operationId: prepared.operationId,
        artifactId, cryptoAccessRevision: prepared.nextCryptoAccessRevision,
        requiredNamespaceIds: prepared.targetNamespaceIds,
      }),
      plan: () => Promise.resolve({ dtoVersion: 1, status: "unavailable",
        reason: "authorization_required" }),
      stageCiphertext: () => Promise.resolve({ dtoVersion: 1,
        status: "unavailable", reason: "authorization_required" }),
      publish: () => Promise.resolve({ dtoVersion: 1, status: "unavailable",
        reason: "authorization_required" }),
    });
    expect((await app.inject({ method: "POST",
      url: `/api/protected/artifacts/${ARTIFACT}/access-plan`,
      payload: { requestVersion: 1, operation: { kind: "make_private" } },
    })).json()).toMatchObject({ status: "unchanged", artifactId: ARTIFACT });
    const prepared = {
      requestVersion: 1, operationId: "artifact-access:1", artifactId: ARTIFACT,
      artifactRevision: 3, expectedCryptoAccessRevision: 1,
      nextCryptoAccessRevision: 2,
      cryptoObjectId: `artifact:v1:${"a".repeat(64)}`, blobId: BLOB,
      blobGeneration: 2, currentNamespaceIds: [NS], targetNamespaceIds: [],
      accessManifestBytesBase64url: "bWFuaWZlc3Q",
      signedAccessRequestBytesBase64url: "c2lnbmVk",
      namespaceEnvelopes: [],
    };
    expect((await app.inject({ method: "POST",
      url: `/api/protected/artifacts/${ARTIFACT}/access`, payload: prepared,
    })).json()).toMatchObject({ status: "updated", cryptoAccessRevision: 2,
      requiredNamespaceIds: [] });
    expect((await app.inject({ method: "POST",
      url: `/api/protected/artifacts/${BLOB}/access`, payload: prepared,
    })).statusCode).toBe(400);
    expect((await app.inject({ method: "DELETE",
      url: `/api/protected/artifacts/${ARTIFACT}`,
    })).statusCode).toBe(404);
  });

  test("streams ciphertext to the exact recognized composition", async () => {
    const observed: number[] = [];
    const app = register({
      ...unavailableReadPorts(),
      plan: () => Promise.resolve({
        dtoVersion: 1,
        status: "unavailable",
        reason: "target_encryption_not_ready",
      }),
      stageCiphertext: async (input) => {
        for await (const chunk of input.ciphertext) observed.push(...chunk);
        return {
          dtoVersion: 1,
          status: "staged",
          operationId: input.operationId,
          artifactId: input.artifactId,
          blobId: input.blobId,
          blobGeneration: input.blobGeneration,
          ciphertextLength: input.ciphertextLength,
          ciphertextSha256Base64url: Buffer.from(
            input.ciphertextSha256,
          ).toString("base64url"),
        };
      },
      publish: () => Promise.resolve({
        dtoVersion: 1,
        status: "published",
        operationId: "artifact-op-1",
        artifactId: ARTIFACT,
        artifactRevision: 1,
        cryptoAccessRevision: 0,
        blobId: BLOB,
        blobGeneration: 1,
        requiredNamespaceIds: [NS],
      }),
    });
    const payload = Buffer.from([1, 2, 3, 4]);
    const response = await app.inject({
      method: "PUT",
      url: `/api/protected/artifacts/${ARTIFACT}/ciphertext/artifact-op-1`,
      headers: {
        "content-type": "application/vnd.nautilo.artifact-blob-v1",
        "content-length": String(payload.length),
        "x-nautilo-blob-id": BLOB,
        "x-nautilo-blob-generation": "1",
        "x-nautilo-ciphertext-sha256": HASH,
      },
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "staged", blobId: BLOB });
    expect(observed).toEqual([1, 2, 3, 4]);
  });

  test("keeps routes absent without explicit registration and rejects extra prepared fields", async () => {
    const absent = Fastify();
    apps.push(absent);
    expect((await absent.inject({
      method: "POST",
      url: "/api/protected/artifacts/publication-plan",
      payload: {},
    })).statusCode).toBe(404);

    const app = register({
      ...unavailableReadPorts(),
      plan: () => Promise.resolve({ dtoVersion: 1, status: "unavailable", reason: "authorization_required" }),
      stageCiphertext: () => Promise.resolve({ dtoVersion: 1, status: "unavailable", reason: "authorization_required" }),
      publish: () => Promise.resolve({ dtoVersion: 1, status: "unavailable", reason: "authorization_required" }),
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/protected/artifacts/${ARTIFACT}/publication`,
      payload: { requestVersion: 1, plaintext: "secret" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain("secret");
    expect((await app.inject({
      method: "POST",
      url: `/api/protected/artifacts/${BLOB}/publication`,
      payload: preparedPublication(),
    })).statusCode).toBe(400);
  });

  test("returns bounded complete encrypted chunk frames with authenticated coordinates", async () => {
    const app = register({
      ...unavailableReadPorts(),
      ciphertextRange: ({ artifactId }) => Promise.resolve({
        status: "encrypted_chunks",
        artifactId,
        artifactRevision: 3,
        cryptoAccessRevision: 2,
        blobId: BLOB,
        blobGeneration: 2,
        plaintextLength: 2_000_000,
        ciphertextLength: 2_000_200,
        ciphertextSha256: new Uint8Array(32).fill(0x44),
        chunkPlaintextBytes: 1_048_576,
        chunkCount: 2,
        firstChunkIndex: 0,
        returnedChunkCount: 1,
        body: new Uint8Array([0, 0, 0, 1, 0x44]),
      }),
      plan: () => Promise.resolve({ dtoVersion: 1, status: "unavailable", reason: "authorization_required" }),
      stageCiphertext: () => Promise.resolve({ dtoVersion: 1, status: "unavailable", reason: "authorization_required" }),
      publish: () => Promise.resolve({ dtoVersion: 1, status: "unavailable", reason: "authorization_required" }),
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/protected/artifacts/${ARTIFACT}/ciphertext?start=0&endExclusive=4`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain(
      "application/vnd.nautilo.artifact-blob-range-v1",
    );
    expect(response.headers["x-nautilo-artifact-revision"]).toBe("3");
    expect(response.headers["x-nautilo-first-chunk-index"]).toBe("0");
    expect(Buffer.from(response.rawPayload)).toEqual(
      Buffer.from([0, 0, 0, 1, 0x44]),
    );
  });
});
