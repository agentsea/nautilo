import { expect, test } from "bun:test";
import { NautiloApiClient } from "../../src/client";
import {
  protectedMemoryRepairPlanV1Schema,
  protectedMemoryPreparedRepairRequestV1Schema,
} from "../../src/schemas/protected-memory-repair";

const MEMORY = "81000000-0000-4000-8000-000000000001";
const NS = "81000000-0000-4000-8000-000000000002";
const ROOM = "81000000-0000-4000-8000-000000000003";
const plan = {
  dtoVersion: 1, status: "planned", mode: "shadow_encryption", shadowBehavior: "strict",
  policyRevision: 1, memoryId: MEMORY, operationId: "repair:1", direction: "ordinary_to_protected",
  expectedContentRevision: 0, targetContentRevision: 1, expectedCryptoAccessRevision: 0,
  cryptoObjectId: `nautilo-memory-v1:${MEMORY}:1`, requiredNamespaceIds: [NS],
  requiredNamespaceFingerprintBase64url: "A".repeat(43),
  targetAuthorities: [{ namespaceId: NS, sourceRoomId: ROOM, currentGeneration: 0, retainedGenerations: [{
    generation: 0, accessRevision: 1, headDigestBase64url: "A".repeat(43),
    publicationDigestBase64url: "B".repeat(43), publicationSetDigestBase64url: "C".repeat(43),
    audienceFingerprintBase64url: "D".repeat(43),
  }] }], createdAt: 1, deadlineAt: 2,
  repairInput: { formatVersion: 1, type: "authored type", content: "historic fact" },
};

test("repair transport permits only Shadow input and the unchanged exact source", () => {
  expect(protectedMemoryRepairPlanV1Schema.safeParse(plan).success).toBe(true);
  for (const changed of [
    { mode: "encrypted_only" }, { mode: "plaintext_only" }, { targetContentRevision: 0 },
    { expectedContentRevision: 3, targetContentRevision: 2 },
    { targetAuthorities: [] }, { requiredNamespaceIds: [NS, ROOM] },
    { repairInput: { ...plan.repairInput, type: "🫖".repeat(65) } },
    { repairInput: { ...plan.repairInput, content: "🫖".repeat(16_385) } },
  ]) expect(protectedMemoryRepairPlanV1Schema.safeParse({ ...plan, ...changed }).success).toBe(false);
});

test("forward repair accepts the canonical reserved revision after an abandoned attempt", () => {
  expect(protectedMemoryRepairPlanV1Schema.safeParse({ ...plan,
    targetContentRevision: 3, cryptoObjectId: `nautilo-memory-v1:${MEMORY}:3`,
  }).success).toBe(true);
});

test("forward repair has no ordinary body or provider request; reverse has no new ciphertext", () => {
  const common = { requestVersion: 1, memoryId: MEMORY, operationId: "repair:1",
    signedRepairAttestationBytesBase64url: "c2lnbmVk" };
  const forward = { ...common, direction: "ordinary_to_protected", encryptedPayloadBytesBase64url: "YQ",
    accessManifestBytesBase64url: "Yg", namespaceEnvelopes: [{ namespaceId: NS, envelopeBytesBase64url: "Yw" }] };
  expect(protectedMemoryPreparedRepairRequestV1Schema.safeParse(forward).success).toBe(true);
  expect(protectedMemoryPreparedRepairRequestV1Schema.safeParse({ ...forward, payload: plan.repairInput }).success).toBe(false);
  expect(protectedMemoryPreparedRepairRequestV1Schema.safeParse({ ...forward,
    signedContentEmbeddingRequestBytesBase64url: "YQ" }).success).toBe(false);
  const reverse = { ...common, direction: "protected_to_ordinary", payload: plan.repairInput };
  expect(protectedMemoryPreparedRepairRequestV1Schema.safeParse(reverse).success).toBe(true);
  expect(protectedMemoryPreparedRepairRequestV1Schema.safeParse({ ...reverse, encryptedPayloadBytesBase64url: "YQ" }).success).toBe(false);
});

test("HTTP repair checks source and signed operation receipt without a semantic mutation", async () => {
  const calls: { url: string; body: unknown }[] = [];
  let substitute = false;
  const client = new NautiloApiClient("https://nautilo.test", { fetchImpl: async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (typeof init?.body !== "string") throw new TypeError("Expected JSON request body");
    calls.push({ url, body: JSON.parse(init.body) as unknown });
    return new Response(JSON.stringify(url.endsWith("repair-plan") ? plan : {
      dtoVersion: 1, status: "repaired", direction: "protected_to_ordinary", memoryId: MEMORY,
      operationId: substitute ? "substituted" : "repair:1", contentRevision: 1, cryptoAccessRevision: 0,
    }), { status: 200, headers: { "content-type": "application/json" } });
  } });
  client.setToken("test-session");
  expect(await client.planProtectedMemoryRepair(MEMORY)).toMatchObject({ status: "planned" });
  const prepared = { requestVersion: 1 as const, memoryId: MEMORY, operationId: "repair:1",
    direction: "protected_to_ordinary" as const, signedRepairAttestationBytesBase64url: "c2lnbmVk",
    payload: { ...plan.repairInput, formatVersion: 1 as const } };
  expect(await client.commitProtectedMemoryRepair(MEMORY, prepared)).toMatchObject({ status: "repaired" });
  expect(calls.map(({ url }) => new URL(url).pathname)).toEqual([
    `/api/protected/memories/${MEMORY}/repair-plan`, `/api/protected/memories/${MEMORY}/repair`,
  ]);
  substitute = true;
  expect(await client.commitProtectedMemoryRepair(MEMORY, prepared).catch((error: unknown) => error)).toBeInstanceOf(TypeError);
});
