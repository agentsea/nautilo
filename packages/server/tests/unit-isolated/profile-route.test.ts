/**
 * Stack 28 Phase 1 Half B — `GET /api/profile` ownedAgents projection.
 *
 * Hermetic: stubs `@nautilo/agent` profile reads and `@nautilo/trust`
 * ownership resolution so no Postgres is required.
 */
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { ViewerRole } from "@nautilo/types";

const OWNER_USER_ID = "11111111-1111-4111-8111-111111111111";
const MEMBER_USER_ID = "22222222-2222-4222-8222-222222222222";
const DEFAULT_AGENT_ID = "33333333-3333-4333-8333-333333333333";
const AGENT_HANDLE = "fixture-genie";
const AGENT_DISPLAY_NAME = "Fixture Genie";

const findPersonalAgentsForUserMock = mock((_userId: string) =>
  Promise.resolve<
    Array<{ agentId: string; handle: string; displayName: string }>
  >([]),
);

// M132 — PUT /api/profile resolves the subject's agent at the route layer
// and passes it to upsertProfile(userId, agentId, data). Capture the args.
const upsertProfileMock = mock(
  (_userId: string, _agentId: string, _data: Record<string, unknown>) =>
    Promise.resolve({
      id: "profile-row",
      userId: OWNER_USER_ID,
      agentId: DEFAULT_AGENT_ID,
      name: "Canonical Genie",
      language: "en",
      voiceId: null,
      voiceName: null,
      avatar: { kind: "preset", id: "shell" },
      defaultModel: null,
      personalityPrompt: null,
      personalityTone: null,
      motherAnswer: null,
      privacySpectrum: null,
      workLifeMode: null,
      soulFile: null,
      onboardingCompleted: true,
      welcomeMessageSent: true,
      publicProfile: true,
      fallbackEnabled: false,
      fallbackChain: [],
    }),
);

const realAgent = await import("@nautilo/agent");
mock.module("@nautilo/agent", () => ({
  ...realAgent,
  upsertProfile: (userId: string, agentId: string, data: Record<string, unknown>) =>
    upsertProfileMock(userId, agentId, data),
  getProfileByAgentId: async () => ({
    id: "profile-row",
    userId: OWNER_USER_ID,
    agentId: DEFAULT_AGENT_ID,
    name: "Canonical Genie",
    language: "en",
    voiceId: null,
    voiceName: null,
    voices: {},
    avatar: { kind: "preset", id: "shell" },
    defaultModel: null,
    personalityPrompt: null,
    personalityTone: null,
    motherAnswer: null,
    privacySpectrum: null,
    workLifeMode: null,
    soulFile: null,
    onboardingCompleted: true,
    welcomeMessageSent: true,
    publicProfile: true,
    fallbackEnabled: false,
    fallbackChain: [],
  }),
  getProfile: async () => ({
    id: "profile-row",
    userId: OWNER_USER_ID,
    name: "Canonical Genie",
    language: "en",
    voiceId: null,
    voiceName: null,
    avatar: { kind: "preset", id: "shell" },
    defaultModel: null,
    personalityPrompt: null,
    personalityTone: null,
    motherAnswer: null,
    privacySpectrum: null,
    workLifeMode: null,
    soulFile: null,
    onboardingCompleted: true,
    welcomeMessageSent: true,
    publicProfile: true,
    fallbackEnabled: false,
    fallbackChain: [],
  }),
}));

const realTrust = await import("@nautilo/trust");
mock.module("@nautilo/trust", () => ({
  ...realTrust,
  findPersonalAgentsForUser: (userId: string) => findPersonalAgentsForUserMock(userId),
  findAgentById: async (agentId: string) => ({
    id: agentId,
    handle: AGENT_HANDLE,
    displayName: AGENT_DISPLAY_NAME,
  }),
  // Do NOT hardcode getBootstrapDefaultAgentId here — it leaks into other
  // tests via bun's sticky mock.module(). Use the real getter via
  // setBootstrapDefaultAgentId() in beforeEach instead (see below).
}));

// Seed the bootstrap default agent ID via the real setter so the
// mocked module's `getBootstrapDefaultAgentId` (delegating to realTrust)
// returns our fixture during these tests, but downstream tests that
// call `setBootstrapDefaultAgentId(...)` themselves still take effect.
realTrust.setBootstrapDefaultAgentId(DEFAULT_AGENT_ID);

// M156 — a profile NAME change now routes through the transactional
// `renameAgentProfileIdentity` helper (in `@nautilo/db`); stub it so the
// route stays Postgres-free.
const renameIdentityMock = mock(
  (_args: { ownerUserId: string; agentId: string; name: string }) =>
    Promise.resolve({ name: _args.name, handle: AGENT_HANDLE }),
);
const realDb = await import("@nautilo/db");
mock.module("@nautilo/db", () => ({
  ...realDb,
  renameAgentProfileIdentity: (args: { ownerUserId: string; agentId: string; name: string }) =>
    renameIdentityMock(args),
  setAgentHandle: async () => ({ ok: true as const }),
}));

import { profileRoutes } from "../../src/routes/profile";

describe("GET /api/profile — ownedAgents", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    findPersonalAgentsForUserMock.mockClear();
    upsertProfileMock.mockClear();
    renameIdentityMock.mockClear();
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  /*
   * Bun's `mock.module()` replacements are sticky across test files
   * (`mock.restore()` only un-spies; it does NOT un-replace modules).
   * Without this `afterAll`, the `@nautilo/agent` + `@nautilo/trust`
   * stubs above continue to win module-resolution for any later test
   * file in the same bun-test process, poisoning suites that depend
   * on the real exports (`auth-identity-verify-resume-route.test.ts`,
   * `sessions-guest-leak.test.ts`, etc.).
   *
   * Defensive re-mock with the real modules restores them for downstream
   * suites. Matches the pattern in
   * `packages/server/tests/unit-isolated/profile-soul-stream-route.test.ts`.
   */
  afterAll(() => {
    mock.module("@nautilo/agent", () => realAgent);
    mock.module("@nautilo/trust", () => realTrust);
    mock.module("@nautilo/db", () => realDb);
  });

  function makeApp(input: {
    viewerRole: ViewerRole;
    sessionUserId: string | null;
    memoryEnvelopeOwnerId?: string;
  }): FastifyInstance {
    const app = Fastify({ logger: false });
    app.decorateRequest("policyContext", null);
    app.decorateRequest("memoryEnvelope", null);
    app.decorateRequest("sessionActorId", null);
    app.decorateRequest("sessionUserId", null);
    profileRoutes(app, { ownerId: OWNER_USER_ID });
    app.addHook("preHandler", async (request) => {
      request.sessionUserId = input.sessionUserId;
      request.memoryEnvelope = input.memoryEnvelopeOwnerId ? {
        ownerId: input.memoryEnvelopeOwnerId,
      } as typeof request.memoryEnvelope : null;
      request.policyContext = {
        actorRole: input.viewerRole,
        actorId: input.sessionUserId ?? "guest",
      } as typeof request.policyContext;
    });
    apps.push(app);
    return app;
  }

  test("guest viewer receives public shell without ownedAgents (preserves envelope)", async () => {
    const app = makeApp({ viewerRole: "guest", sessionUserId: null });

    const res = await app.inject({ method: "GET", url: "/api/profile" });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body["viewerRole"]).toBe("guest");
    expect(body["ownedAgents"]).toBeUndefined();
    expect(findPersonalAgentsForUserMock.mock.calls.length).toBe(0);
  });

  test("owner viewer receives exactly one owned agent summary", async () => {
    findPersonalAgentsForUserMock.mockImplementationOnce(async (userId) => {
      expect(userId).toBe(OWNER_USER_ID);
      return [
        {
          agentId: DEFAULT_AGENT_ID,
          handle: AGENT_HANDLE,
          displayName: AGENT_DISPLAY_NAME,
        },
      ];
    });
    const app = makeApp({ viewerRole: "owner", sessionUserId: OWNER_USER_ID });

    const res = await app.inject({ method: "GET", url: "/api/profile" });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      viewerRole: string;
      ownedAgents: Array<Record<string, string>>;
    };
    expect(body.viewerRole).toBe("owner");
    expect(body.ownedAgents).toEqual([
      {
        agentId: DEFAULT_AGENT_ID,
        handle: AGENT_HANDLE,
        displayName: AGENT_DISPLAY_NAME,
      },
    ]);
    expect(findPersonalAgentsForUserMock.mock.calls.length).toBe(1);
  });

  test("member viewer sees their OWN profile as owner (M129 regression — was guest)", async () => {
    // Regression for the upgraded-instance bug: a `member` (post-M128 canonical
    // role) used to fall through `getViewerRole` to "guest" and receive
    // the public shell projection. Now any verified user views their own
    // profile as its owner — soul/name/model fields and ownedAgents come
    // from THEIR session id, not the bootstrap owner's.
    findPersonalAgentsForUserMock.mockImplementationOnce(async (userId) => {
      expect(userId).toBe(MEMBER_USER_ID);
      return [];
    });
    const app = makeApp({
      viewerRole: "member",
      sessionUserId: MEMBER_USER_ID,
    });

    const res = await app.inject({ method: "GET", url: "/api/profile" });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      viewerRole: string;
      ownedAgents: unknown[];
      agent: Record<string, unknown>;
    };
    expect(body.viewerRole).toBe("owner");
    expect(body.ownedAgents).toEqual([]);
    // owner projection exposes the agent's own private fields (the data a
    // member was previously denied)
    expect(body.agent).toHaveProperty("soulFile");
    expect(body.agent).toHaveProperty("defaultModel");
    expect(findPersonalAgentsForUserMock.mock.calls.length).toBe(1);
  });

  // M132 — PUT /api/profile resolves the subject's personal agent at the
  // route layer and keys the upsert by it.
  test("PUT /api/profile returns 409 no_personal_agent when subject has no agent", async () => {
    findPersonalAgentsForUserMock.mockImplementationOnce(async () => []);
    const app = makeApp({ viewerRole: "owner", sessionUserId: OWNER_USER_ID });

    const res = await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { name: "New name" },
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe("no_personal_agent");
    expect(upsertProfileMock.mock.calls.length).toBe(0);
  });

  // M156 — a NAME change is identity-critical and routes through the
  // transactional `renameAgentProfileIdentity` helper (NOT upsertProfile,
  // which would skip the actor-cache + auto-derived-handle sync). The route
  // still resolves the subject's personal agent at the route layer and keys
  // the identity write by it.
  test("PUT /api/profile routes a name change through renameAgentProfileIdentity with the resolved agentId", async () => {
    findPersonalAgentsForUserMock.mockImplementation(async () => [
      { agentId: DEFAULT_AGENT_ID, handle: AGENT_HANDLE, displayName: AGENT_DISPLAY_NAME },
    ]);
    const app = makeApp({ viewerRole: "owner", sessionUserId: OWNER_USER_ID });

    const res = await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { name: "New name" },
    });

    expect(res.statusCode).toBe(200);
    expect(renameIdentityMock.mock.calls.length).toBe(1);
    const [args] = renameIdentityMock.mock.calls[0]!;
    expect(args.ownerUserId).toBe(OWNER_USER_ID);
    expect(args.agentId).toBe(DEFAULT_AGENT_ID);
    expect(args.name).toBe("New name");
    // A name-only payload must not also fire a redundant upsertProfile.
    expect(upsertProfileMock.mock.calls.length).toBe(0);
    findPersonalAgentsForUserMock.mockImplementation(async () => []);
  });

  // M156 — non-name fields still go through upsertProfile keyed by the
  // route-resolved agentId (the identity helper only owns the name).
  test("PUT /api/profile passes the route-resolved agentId to upsertProfile for non-name fields", async () => {
    findPersonalAgentsForUserMock.mockImplementation(async () => [
      { agentId: DEFAULT_AGENT_ID, handle: AGENT_HANDLE, displayName: AGENT_DISPLAY_NAME },
    ]);
    const app = makeApp({ viewerRole: "owner", sessionUserId: OWNER_USER_ID });

    const res = await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { language: "es" },
    });

    expect(res.statusCode).toBe(200);
    expect(renameIdentityMock.mock.calls.length).toBe(0);
    expect(upsertProfileMock.mock.calls.length).toBe(1);
    const [calledUserId, calledAgentId] = upsertProfileMock.mock.calls[0]!;
    expect(calledUserId).toBe(OWNER_USER_ID);
    expect(calledAgentId).toBe(DEFAULT_AGENT_ID);
    findPersonalAgentsForUserMock.mockImplementation(async () => []);
  });

});
