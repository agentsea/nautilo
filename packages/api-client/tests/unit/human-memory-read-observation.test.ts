import { expect, test } from "bun:test";
import { MAX_HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_WIRE_BYTES_V1 } from
  "@nautilo/lattice-crypto/wire";
import { NautiloApiClient } from "../../src/client";
import { humanMemoryReadObservationRequestV1Schema } from "../../src/schemas/human-memory-read-observation";

test("Memory read observation sends only signed bytes on the authenticated POST", async () => {
  const calls: { url: string; method: string | undefined; body: unknown }[] = [];
  const client = new NautiloApiClient("https://nautilo.test", { fetchImpl: async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (typeof init?.body !== "string") throw new TypeError("Expected JSON request");
    calls.push({ url, method: init.method, body: JSON.parse(init.body) as unknown });
    return Response.json({ status: "accepted" });
  } });
  const request = { requestVersion: 1 as const, acknowledgementBytesBase64url: "c2lnbmVk" };
  expect(await client.observeHumanMemoryRead(request)).toEqual({ status: "accepted" });
  expect(calls).toEqual([{ url: "https://nautilo.test/api/protected/memories/read-observation",
    method: "POST", body: request }]);
  expect(humanMemoryReadObservationRequestV1Schema.safeParse({ ...request, content: "secret" }).success).toBe(false);
  expect(humanMemoryReadObservationRequestV1Schema.safeParse({ ...request, outcome: "verified" }).success).toBe(false);
  expect(humanMemoryReadObservationRequestV1Schema.safeParse({ ...request,
    acknowledgementBytesBase64url: "!" }).success).toBe(false);
  const maximumCharacters = Math.ceil(
    MAX_HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_WIRE_BYTES_V1 * 4 / 3,
  );
  expect(humanMemoryReadObservationRequestV1Schema.safeParse({
    ...request,
    acknowledgementBytesBase64url: "A".repeat(maximumCharacters),
  }).success).toBe(true);
  expect(humanMemoryReadObservationRequestV1Schema.safeParse({
    ...request,
    acknowledgementBytesBase64url: "A".repeat(maximumCharacters + 1),
  }).success).toBe(false);
});
