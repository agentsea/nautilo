import { describe, expect, test } from "bun:test";

import { createHumanMemoryReadObservationIssuer } from
  "../../src/routes/human-memory-read-observations";

const request = {
  authority: {
    userId: "user:1", actorId: "human:1", agentId: null,
    memoryMode: "namespace" as const, readableNamespaceIds: [],
    mutableNamespaceIds: [], writableNamespaceIds: [], scopeId: null,
    originWritableNamespaceId: null, sourceRoomId: null,
  },
  memoryId: "11111111-1111-4111-8111-111111111111",
  cryptoObjectId: "nautilo-memory-v1:11111111-1111-4111-8111-111111111111:2",
  contentRevision: 2,
  cryptoAccessRevision: 3,
};

describe("Human Memory read observation issuer", () => {
  test("issues an exact content-free binding", async () => {
    let captured: unknown;
    const issuer = createHumanMemoryReadObservationIssuer({ db: {} as never,
      now: () => new Date(1_000),
      issue: async (_db, input) => {
        captured = input;
        return { token: new Uint8Array(32).fill(2), policyRevision: 7,
          expiresAt: input.expiresAt };
      } });
    expect(await issuer(request)).toEqual({ tokenBase64url:
      "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI", policyRevision: 7,
    issuedAt: 1_000, expiresAt: 121_000 });
    expect(captured).toMatchObject({ family: "memory", operation: "read",
      memoryReadBinding: { subjectHumanId: "human:1", memoryId: request.memoryId,
        cryptoObjectId: request.cryptoObjectId, contentRevision: 2,
        cryptoAccessRevision: 3 } });
  });

  test("does not fail an authenticated read when admission storage is unavailable", async () => {
    const issuer = createHumanMemoryReadObservationIssuer({ db: {} as never,
      issue: () => Promise.reject(new Error("sensitive storage failure")) });
    expect(await issuer(request)).toBeUndefined();
  });
});
