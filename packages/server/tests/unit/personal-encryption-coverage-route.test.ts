import { describe, expect, mock, test } from "bun:test";
import Fastify from "fastify";

import type {
  PersonalEncryptionCoverageFamily,
  PersonalEncryptionCoverageFamilyResult,
} from "@nautilo/db";

import {
  personalEncryptionCoverageRoutes,
  type PersonalEncryptionCoverageRouteDeps,
} from "../../src/routes/personal-encryption-coverage";

const USER_ID = "10000000-0000-4000-8000-000000000308";
const HUMAN_ACTOR_ID = "20000000-0000-4000-8000-000000000308";
const NAMESPACE_ID = "30000000-0000-4000-8000-000000000308";
type CoverageInput = {
  family: PersonalEncryptionCoverageFamily;
  readableNamespaceIds: readonly string[];
  userId: string;
};

function familyResult(
  family: PersonalEncryptionCoverageFamily,
): PersonalEncryptionCoverageFamilyResult {
  if (family === "task") {
    return {
      family,
      measurement: "unsupported",
      accessible: 34n,
      plaintextPresent: 31n,
    };
  }
  return {
    family,
    measurement: "measured",
    accessible: 10n,
    plaintextPresent: 8n,
    encryptedCounterpart: 7n,
  };
}

function appWith(
  deps: PersonalEncryptionCoverageRouteDeps,
  authenticated = true,
) {
  const app = Fastify({ logger: false });
  app.decorateRequest("sessionUserId", null);
  app.decorateRequest("sessionActorId", null);
  app.addHook("preHandler", async (request) => {
    if (authenticated) {
      request.sessionUserId = USER_ID;
      request.sessionActorId = HUMAN_ACTOR_ID;
    }
  });
  personalEncryptionCoverageRoutes(app, {
    getDb: () => ({}) as never,
    getPolicy: async () => ({ mode: "shadow_encryption" }),
    getReadableNamespaces: async () => [NAMESPACE_ID],
    getFamilyCoverage: async (_db, { family }) => familyResult(family),
    now: () => new Date("2026-09-03T09:15:00.000Z"),
    ...deps,
  });
  return app;
}

describe("M308 personal encryption coverage route", () => {
  test("requires request-derived Human identity and rejects client scope coordinates", async () => {
    const signedOut = appWith({}, false);
    const unauthorized = await signedOut.inject({
      method: "GET",
      url: "/api/encryption/coverage/me",
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.headers["cache-control"]).toBe("private, no-store");
    expect(unauthorized.headers.vary).toBe("Authorization");
    await signedOut.close();

    const getReadableNamespaces = mock(async () => [NAMESPACE_ID]);
    const getFamilyCoverage = mock(async (
      _db: never,
      input: CoverageInput,
    ) => familyResult(input.family));
    const app = appWith({
      getReadableNamespaces,
      getFamilyCoverage: getFamilyCoverage as never,
    });
    const rejected = await app.inject({
      method: "GET",
      url: `/api/encryption/coverage/me?userId=other&namespaceId=${NAMESPACE_ID}`,
    });
    expect(rejected.statusCode).toBe(400);
    expect(getReadableNamespaces).not.toHaveBeenCalled();
    expect(getFamilyCoverage).not.toHaveBeenCalled();
    await app.close();
  });

  test("returns an inactive plaintext-only response without resolving authority or counts", async () => {
    const getReadableNamespaces = mock(async () => [NAMESPACE_ID]);
    const getFamilyCoverage = mock(async () => familyResult("message"));
    const app = appWith({
      getPolicy: async () => ({ mode: "plaintext_only" }),
      getReadableNamespaces,
      getFamilyCoverage: getFamilyCoverage as never,
    });
    const response = await app.inject({ method: "GET", url: "/api/encryption/coverage/me" });
    expect(response.statusCode).toBe(200);
    const body: unknown = response.json();
    expect(body).toEqual({
      dtoVersion: 1,
      policy: "plaintext_only",
      computedAt: null,
      families: [],
    });
    expect(getReadableNamespaces).not.toHaveBeenCalled();
    expect(getFamilyCoverage).not.toHaveBeenCalled();
    await app.close();
  });

  test("passes only request-derived authority and emits all families in stable order", async () => {
    const getReadableNamespaces = mock(async () => [NAMESPACE_ID]);
    const inputs: Array<Record<string, unknown>> = [];
    const app = appWith({
      getReadableNamespaces,
      getFamilyCoverage: (async (_db: never, input: CoverageInput) => {
        inputs.push(input);
        return familyResult(input.family);
      }) as never,
    });
    const response = await app.inject({ method: "GET", url: "/api/encryption/coverage/me" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers.vary).toBe("Authorization");
    expect(getReadableNamespaces).toHaveBeenCalledWith(HUMAN_ACTOR_ID);
    expect(inputs.map(({ family }) => family)).toEqual([
      "message", "memory", "journal_event", "reflection_record", "artifact", "task",
    ]);
    expect(inputs.every((input) =>
      input["userId"] === USER_ID
      && (input["readableNamespaceIds"] as string[])[0] === NAMESPACE_ID
    )).toBe(true);
    const body: unknown = response.json();
    expect(body).toEqual({
      dtoVersion: 1,
      policy: "shadow_encryption",
      computedAt: "2026-09-03T09:15:00.000Z",
      families: [
        { family: "message", measurement: "measured", accessible: "10", plaintextPresent: "8", encryptedCounterpart: "7" },
        { family: "memory", measurement: "measured", accessible: "10", plaintextPresent: "8", encryptedCounterpart: "7" },
        { family: "journal_event", measurement: "measured", accessible: "10", plaintextPresent: "8", encryptedCounterpart: "7" },
        { family: "reflection_record", measurement: "measured", accessible: "10", plaintextPresent: "8", encryptedCounterpart: "7" },
        { family: "artifact", measurement: "measured", accessible: "10", plaintextPresent: "8", encryptedCounterpart: "7" },
        { family: "task", measurement: "unsupported", accessible: "34", plaintextPresent: "31", encryptedCounterpart: null },
      ],
    });
    await app.close();
  });

  test("isolates family failures as unavailable without error detail or fabricated zeroes", async () => {
    const app = appWith({
      getFamilyCoverage: (async (_db: never, { family }: CoverageInput) => {
        if (family === "reflection_record") throw new Error("private SQL detail");
        return familyResult(family);
      }) as never,
    });
    const response = await app.inject({ method: "GET", url: "/api/encryption/coverage/me" });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ families: Array<Record<string, unknown>> }>();
    expect(body.families[3]).toEqual({
      family: "reflection_record",
      measurement: "unavailable",
      accessible: null,
      plaintextPresent: null,
      encryptedCounterpart: null,
    });
    expect(JSON.stringify(body)).not.toContain("private SQL detail");
    expect(body.families[0]?.["measurement"]).toBe("measured");
    await app.close();
  });

  test("keeps owner-scoped Task counts when Namespace authority cannot be resolved", async () => {
    const getFamilyCoverage = mock(async (
      _db: never,
      input: CoverageInput,
    ) => familyResult(input.family));
    const app = appWith({
      getReadableNamespaces: async () => { throw new Error("authority store unavailable"); },
      getFamilyCoverage: getFamilyCoverage as never,
    });
    const response = await app.inject({ method: "GET", url: "/api/encryption/coverage/me" });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ families: Array<Record<string, unknown>> }>();
    expect(body.families).toHaveLength(6);
    expect(body.families.slice(0, 5).every((family) =>
      family["measurement"] === "unavailable"
      && family["accessible"] === null
      && family["plaintextPresent"] === null
      && family["encryptedCounterpart"] === null
    )).toBe(true);
    expect(body.families[5]).toEqual({
      family: "task",
      measurement: "unsupported",
      accessible: "34",
      plaintextPresent: "31",
      encryptedCounterpart: null,
    });
    expect(getFamilyCoverage).toHaveBeenCalledTimes(1);
    expect(getFamilyCoverage.mock.calls[0]?.[1] as unknown).toEqual({
      family: "task",
      readableNamespaceIds: [],
      userId: USER_ID,
    });
    await app.close();
  });
});
