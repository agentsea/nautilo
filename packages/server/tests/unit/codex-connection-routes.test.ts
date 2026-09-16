import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyRequest } from "fastify";
import {
  codexAccountStatusSchema,
  codexConnectionSummarySchema,
  codexProfileConnectSchema,
  codexRuntimeSummarySchema,
  codexUsageSchema,
} from "@nautilo/types";
import type { CodexAdminControlPlane } from "../../src/codex/admin-control-plane";
import { CodexAdminControlFailure } from "../../src/codex/admin-control-plane";
import { codexConnectionRoutes, type CodexConnectionsRouteDeps } from "../../src/routes/codex";

const OWNER = "11111111-1111-4111-8111-111111111111";
const PROFILE = "22222222-2222-4222-8222-222222222222";
const SECOND_OWNER = "33333333-3333-4333-8333-333333333333";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: PROFILE,
    relayId: "relay-1",
    homeHandle: "private-home",
    label: "Personal",
    accountEmail: null,
    authState: "signed_out",
    planType: null,
    usageSnapshot: null,
    usageObservedAt: null,
    lastErrorCode: null,
    revision: 3,
    profileGeneration: 1,
    accountGeneration: 0,
    registrationState: "registered" as const,
    removalState: "active" as const,
    ...overrides,
  };
}

function removalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PROFILE,
    relayId: "relay-1",
    homeHandle: "private-home",
    profileGeneration: 1,
    accountGeneration: 0,
    revision: 4,
    ...overrides,
  };
}

function makeControl(overrides: Record<string, unknown> = {}) {
  return {
    createProfile: async () => ({ kind: "profile_created" as const, profileHandle: PROFILE, homeHandle: "private-home", profileGeneration: 1 }),
    removeProfile: async () => ({ kind: "profile_removed" as const }),
    inspectRuntime: async () => ({ kind: "runtime_status" as const, state: "ready" as const, runtimeGeneration: 7 }),
    activateRuntime: async () => ({ kind: "runtime_status" as const, state: "ready" as const, runtimeGeneration: 7 }),
    startAccountLogin: async () => ({ kind: "login_started" as const, loginRef: "login-ref", state: "waiting_for_browser" as const }),
    cancelAccountLogin: async () => ({ kind: "account_status" as const, state: "signed_out" as const, accountGeneration: 0 }),
    readAccount: async () => ({ kind: "account_status" as const, state: "signed_in" as const, accountGeneration: 2 }),
    listModels: async () => ({
      models: [{
        id: "picker-sol",
        model: "gpt-5.6-sol",
        displayName: "GPT-5.6 Sol",
        description: "Frontier coding model",
        isDefault: true,
      }],
      preferredModelId: "picker-sol",
    }),
    ...overrides,
  } as unknown as CodexAdminControlPlane;
}

function makeApp(
  options: Partial<CodexConnectionsRouteDeps> = {},
  sessionUserId: string | null | ((request: FastifyRequest) => string | null) = OWNER,
  actorRole: "owner" | "guest" | null = "owner",
) {
  const app = Fastify();
  app.decorateRequest("sessionUserId", null);
  app.decorateRequest("policyContext", null);
  app.addHook("preHandler", async (request) => {
    request.sessionUserId =
      typeof sessionUserId === "function" ? sessionUserId(request) : sessionUserId;
    request.policyContext = actorRole ? { actorRole } as typeof request.policyContext : null;
  });
  codexConnectionRoutes(app, {
    control: makeControl(),
    resolveHost: async () => ({ relayId: "relay-1" }),
    readHostStatus: () => ({
      state: "ready",
      runtimeGeneration: 7,
      runtime: { state: "ready" },
      profiles: [{
        profileHandle: PROFILE,
        profileGeneration: 1,
        accountGeneration: 0,
        state: "signed_out",
      }],
      workspace: { state: "unavailable" },
    }),
    readHostInspectionScope: () => ({
      relaySessionId: "socket-1",
      desktopSessionId: "desktop-1",
      capabilityRevision: 6,
    }),
    listProfiles: async () => [row()],
    getProfile: async () => row(),
    createProfile: async () => row(),
    renameProfile: async () => row(),
    updateProfileStatus: async (input) => row({
      id: input.profileId,
      authState: input.authState,
      ...(input.accountEmail !== undefined ? { accountEmail: input.accountEmail } : {}),
      ...(input.planType !== undefined ? { planType: input.planType } : {}),
      profileGeneration: input.profileGeneration,
      accountGeneration: input.accountGeneration,
      registrationState: input.expectedRegistrationState ?? "registered",
      revision: input.expectedRevision + 1,
    }),
    registerProfileFromOfficialAccount: async (input) => row({
      registrationState: "registered",
      authState: "signed_in",
      accountEmail: input.accountEmail ?? "human@example.com",
      planType: input.planType ?? null,
      accountGeneration: input.accountGeneration,
      revision: input.expectedRevision + 1,
    }),
    updateProfileUsageSnapshot: async (input) => row({
      usageSnapshot: {
        schemaVersion: 1,
        ...input.patch,
      },
      usageObservedAt: input.observedAt,
      revision: input.expectedRevision + 1,
    }),
    beginProfileRemoval: async () => ({ status: "begun" as const, profile: removalRow() }),
    drainProfileTurns: async () => undefined,
    archiveProfileBindingsForRemoval: async () => ({ status: "archived" as const, count: 0 }),
    finalizeProfileRemoval: async () => ({ status: "finalized" as const, profile: removalRow({ revision: 5 }) }),
    getUserPreference: async () => ({
      enabled: false,
      accountProfileId: null,
      defaultPosture: "codex_default",
      revision: 0,
    }),
    upsertUserPreference: async (input) => ({
      enabled: input.enabled,
      accountProfileId: input.profileId,
      defaultPosture: input.posture,
      revision: input.expectedRevision + 1,
    }),
    ...options,
  });
  return app;
}

describe("Codex Connections routes", () => {
  test("Connect is one strict empty request that creates a provisional login-pending profile", async () => {
    const createdInputs: unknown[] = [];
    const app = makeApp({
      createProfile: async (input) => {
        createdInputs.push(input);
        return row({ registrationState: "provisional", authState: "signed_out", revision: 0 });
      },
    });
    const rejected = await app.inject({ method: "POST", url: "/api/codex/profiles", payload: { label: "hidden" } });
    expect(rejected.statusCode).toBe(400);
    const connected = await app.inject({ method: "POST", url: "/api/codex/profiles", payload: {} });
    expect(connected.statusCode).toBe(200);
    expect(connected.json()).toMatchObject({
      loginRef: "login-ref",
      profile: { registrationState: "provisional", reconciliationState: "current", authState: "login_pending" },
    });
    expect(createdInputs).toHaveLength(1);
    expect(createdInputs[0]).toMatchObject({ label: "Codex account", registrationState: "provisional", authState: "signed_out" });
    await app.close();
  });

  test("retains a failed private-home reattach as reconnecting instead of omitting the account", async () => {
    const app = makeApp({
      control: makeControl({ readAccount: async () => { throw new Error("offline"); } }),
      readHostStatus: () => ({ state: "ready", runtimeGeneration: 7, runtime: { state: "ready" }, profiles: [], workspace: { state: "unavailable" } }),
    });
    const response = await app.inject({ method: "GET", url: "/api/codex" });
    expect(response.statusCode).toBe(200);
    const projected = codexConnectionSummarySchema.parse(JSON.parse(response.body));
    expect(projected.profiles).toHaveLength(1);
    expect(projected.profiles[0]).toMatchObject({ id: PROFILE, reconciliationState: "reconnecting" });
    await app.close();
  });

  test("retries the exact provisional registration CAS after a harmless revision race", async () => {
    let writes = 0;
    const app = makeApp({
      control: makeControl({ readAccount: async () => ({ kind: "account_status", state: "signed_in", accountGeneration: 2, accountEmail: "human@example.com", planType: "plus" }) }),
      listProfiles: async () => [row({ registrationState: "provisional", authState: "login_pending" })],
      getProfile: async () => row({ registrationState: "provisional", authState: "login_pending", revision: 4 }),
      registerProfileFromOfficialAccount: async (input) => {
        writes += 1;
        return writes === 1 ? undefined : row({ registrationState: "registered", authState: "signed_in", accountEmail: input.accountEmail, accountGeneration: input.accountGeneration, revision: input.expectedRevision + 1 });
      },
    });
    const response = await app.inject({ method: "GET", url: "/api/codex" });
    expect(writes).toBe(2);
    expect(codexConnectionSummarySchema.parse(JSON.parse(response.body)).profiles[0]).toMatchObject({ registrationState: "registered", reconciliationState: "current", accountEmail: "human@example.com" });
    await app.close();
  });

  test("a registered account winner cannot be regressed to login_pending or removed", async () => {
    let removals = 0;
    const app = makeApp({
      control: makeControl({ removeProfile: async () => { removals += 1; return { kind: "profile_removed" }; } }),
      createProfile: async () => row({ registrationState: "provisional", authState: "signed_out", revision: 0 }),
      updateProfileStatus: async () => undefined,
      getProfile: async () => row({ registrationState: "registered", authState: "signed_in", accountEmail: "winner@example.com", accountGeneration: 1, revision: 1 }),
    });
    const response = await app.inject({ method: "POST", url: "/api/codex/profiles", payload: {} });
    expect(response.statusCode).toBe(200);
    expect(codexProfileConnectSchema.parse(JSON.parse(response.body)).profile).toMatchObject({ registrationState: "registered", authState: "signed_in", accountEmail: "winner@example.com" });
    expect(removals).toBe(0);
    await app.close();
  });

  test("returns a registration winner that commits between cleanup reload and CAS", async () => {
    let reads = 0;
    const app = makeApp({
      createProfile: async () => row({ registrationState: "provisional", authState: "signed_out", revision: 0 }),
      updateProfileStatus: async () => undefined,
      getProfile: async () => {
        reads += 1;
        return reads < 3
          ? row({ registrationState: "provisional", authState: "login_pending", revision: 1 })
          : row({ registrationState: "registered", authState: "signed_in", accountEmail: "winner@example.com", revision: 2 });
      },
      beginProfileRemoval: async () => ({ status: "conflict" as const }),
    });
    const response = await app.inject({ method: "POST", url: "/api/codex/profiles", payload: {} });
    expect(response.statusCode).toBe(200);
    expect(codexProfileConnectSchema.parse(JSON.parse(response.body)).profile).toMatchObject({ registrationState: "registered", authState: "signed_in" });
    await app.close();
  });

  test("an unresolved provisional registration remains visible as reconnecting", async () => {
    const app = makeApp({
      control: makeControl({ readAccount: async () => ({ kind: "account_status", state: "signed_in", accountGeneration: 2, accountEmail: "human@example.com" }) }),
      listProfiles: async () => [row({ registrationState: "provisional", authState: "login_pending" })],
      getProfile: async () => row({ registrationState: "provisional", authState: "login_pending", revision: 4 }),
      registerProfileFromOfficialAccount: async () => undefined,
    });
    const response = await app.inject({ method: "GET", url: "/api/codex" });
    expect(codexConnectionSummarySchema.parse(JSON.parse(response.body)).profiles[0]).toMatchObject({ registrationState: "provisional", reconciliationState: "reconnecting", authState: "login_pending" });
    await app.close();
  });

  test("a DB create conflict removes the exact new private home before login", async () => {
    const cancelled: unknown[] = [];
    const removed: unknown[] = [];
    const app = makeApp({
      control: makeControl({
        cancelAccountLogin: async (...args: unknown[]) => { cancelled.push(args); return { kind: "account_status", state: "signed_out", accountGeneration: 0 }; },
        removeProfile: async (facts: unknown) => { removed.push(facts); return { kind: "profile_removed" }; },
      }),
      createProfile: async () => { throw new Error("unique conflict"); },
    });
    const response = await app.inject({ method: "POST", url: "/api/codex/profiles", payload: {} });
    expect(response.statusCode).toBe(409);
    expect(cancelled).toHaveLength(0);
    expect(removed).toEqual([expect.objectContaining({ profileHandle: PROFILE, profileGeneration: 1 })]);
    await app.close();
  });

  test("a post-reservation login failure runs the canonical removal coordinator", async () => {
    const steps: string[] = [];
    const app = makeApp({
      control: makeControl({
        startAccountLogin: async () => { throw new Error("login unavailable"); },
        removeProfile: async () => { steps.push("host"); return { kind: "profile_removed" }; },
      }),
      createProfile: async () => row({ registrationState: "provisional", authState: "signed_out", revision: 0 }),
      getProfile: async () => row({ registrationState: "provisional", authState: "signed_out", revision: 0 }),
      beginProfileRemoval: async () => ({ status: "begun", profile: removalRow({ revision: 1 }) }),
      drainProfileTurns: async () => { steps.push("drain"); },
      archiveProfileBindingsForRemoval: async () => { steps.push("archive"); return { status: "archived", count: 0 }; },
      finalizeProfileRemoval: async () => { steps.push("finalize"); return { status: "finalized", profile: removalRow({ revision: 2 }) }; },
    });
    const response = await app.inject({ method: "POST", url: "/api/codex/profiles", payload: {} });
    expect(response.statusCode).toBe(409);
    expect(steps).toEqual(["drain", "host", "archive", "finalize"]);
    await app.close();
  });

  test("provisional cancel uses canonical cleanup and already-removing retry skips login", async () => {
    let cancelCalls = 0;
    let removeCalls = 0;
    const app = makeApp({
      control: makeControl({
        cancelAccountLogin: async () => { cancelCalls += 1; return { kind: "account_status", state: "signed_out", accountGeneration: 0 }; },
        removeProfile: async () => { removeCalls += 1; return { kind: "profile_removed" }; },
      }),
      getProfile: async () => row({ registrationState: "provisional", removalState: "removing", revision: 4 }),
      beginProfileRemoval: async () => ({ status: "already_removing", profile: removalRow() }),
    });
    const response = await app.inject({ method: "POST", url: `/api/codex/profiles/${PROFILE}/login/cancel`, payload: { loginRef: "old-ref" } });
    expect(JSON.parse(response.body)).toEqual({ state: "profile_removed" });
    expect(cancelCalls).toBe(0);
    expect(removeCalls).toBe(1);
    await app.close();
  });

  test("established reauthentication cancel never enters profile removal", async () => {
    let removals = 0;
    const app = makeApp({
      control: makeControl({ cancelAccountLogin: async () => ({ kind: "account_status", state: "signed_out", accountGeneration: 1 }) }),
      beginProfileRemoval: async () => { removals += 1; return { status: "conflict" as const }; },
      getProfile: async () => row({ registrationState: "registered", authState: "login_pending", accountGeneration: 1 }),
    });
    const response = await app.inject({ method: "POST", url: `/api/codex/profiles/${PROFILE}/login/cancel`, payload: { loginRef: "reauth-ref" } });
    expect(response.statusCode).toBe(200);
    expect(codexAccountStatusSchema.parse(JSON.parse(response.body)).profile.registrationState).toBe("registered");
    expect(removals).toBe(0);
    await app.close();
  });

  test("cleanup failure remains visible and an exact retry finishes removal", async () => {
    let removing = false;
    let archiveAttempts = 0;
    const app = makeApp({
      listProfiles: async () => [row({ registrationState: "provisional", removalState: removing ? "removing" : "active", revision: removing ? 4 : 3 })],
      beginProfileRemoval: async () => {
        removing = true;
        return { status: archiveAttempts === 0 ? "begun" as const : "already_removing" as const, profile: removalRow({ revision: 4 }) };
      },
      archiveProfileBindingsForRemoval: async () => {
        archiveAttempts += 1;
        return archiveAttempts === 1 ? { status: "conflict" as const } : { status: "archived" as const, count: 0 };
      },
      finalizeProfileRemoval: async () => ({ status: "finalized" as const, profile: removalRow({ revision: 5 }) }),
    });
    expect((await app.inject({ method: "DELETE", url: `/api/codex/profiles/${PROFILE}`, payload: { expectedRevision: 3 } })).statusCode).toBe(409);
    const summaryResponse = await app.inject({ method: "GET", url: "/api/codex" });
    expect(codexConnectionSummarySchema.parse(JSON.parse(summaryResponse.body)).profiles[0]).toMatchObject({ reconciliationState: "cleanup_required", registrationState: "provisional" });
    expect((await app.inject({ method: "DELETE", url: `/api/codex/profiles/${PROFILE}`, payload: { expectedRevision: 4 } })).statusCode).toBe(204);
    expect(archiveAttempts).toBe(2);
    await app.close();
  });
  test("keeps browser runtime receipts bounded, relational, and relay-private", () => {
    const receipt = { state: "installing", available: false, runtimeGeneration: null, collaborationModeAvailable: false, source: "managed", installation: { phase: "downloading", receivedBytes: 64 * 1024, totalBytes: 128 * 1024, canCancel: true } };
    expect(codexRuntimeSummarySchema.safeParse(receipt).success).toBe(true);
    expect(codexRuntimeSummarySchema.safeParse({ ...receipt, installation: { ...receipt.installation, receivedBytes: Number.MAX_SAFE_INTEGER + 1 } }).success).toBe(false);
    expect(codexRuntimeSummarySchema.safeParse({ ...receipt, source: "external" }).success).toBe(false);
    expect(codexRuntimeSummarySchema.safeParse({ ...receipt, installRef: "relay-private" }).success).toBe(false);
  });

  test("rejects an unauthenticated caller before resolving a paired host", async () => {
    const app = makeApp({ resolveHost: async () => { throw new Error("must not resolve"); } }, null);
    const result = await app.inject({ method: "GET", url: "/api/codex" });
    expect(result.statusCode).toBe(401);
    await app.close();
  });

  test("does not perform an owner-wide host guess while loading first-time Connections", async () => {
    const app = makeApp({
      listProfiles: async () => [],
      resolveHost: async () => { throw new Error("must resolve only at an operation boundary"); },
    });
    const result = await app.inject({ method: "GET", url: "/api/codex" });
    expect(result.statusCode).toBe(200);
    expect(codexConnectionSummarySchema.parse(JSON.parse(result.body))).toEqual({
      runtime: {
        state: "absent",
        available: false,
        runtimeGeneration: null,
        collaborationModeAvailable: false,
      },
      profiles: [],
    });
    await app.close();
  });

  test("uses the exact current Desktop hint for first-time Connections when several hosts are live", async () => {
    const resolved: Array<{ userId: string; relayId?: string }> = [];
    const app = makeApp({
      listProfiles: async () => [],
      resolveHost: async (userId, relayId) => {
        resolved.push({ userId, ...(relayId ? { relayId } : {}) });
        return relayId === "relay-current" ? { relayId } : null;
      },
    });
    const result = await app.inject({
      method: "GET",
      url: "/api/codex",
      headers: { "x-nautilo-codex-relay-id": "relay-current" },
    });
    expect(result.statusCode).toBe(200);
    expect(resolved).toEqual([{ userId: OWNER, relayId: "relay-current" }]);
    expect(codexConnectionSummarySchema.parse(JSON.parse(result.body)).profiles).toEqual([]);
    await app.close();
  });

  test("rejects an authenticated Guest from every Codex Connections surface before route work", async () => {
    let touched = false;
    const app = makeApp({
      resolveHost: async () => {
        touched = true;
        throw new Error("must not resolve");
      },
      getProfile: async () => {
        touched = true;
        throw new Error("must not read");
      },
      getUserPreference: async () => {
        touched = true;
        throw new Error("must not read");
      },
    }, OWNER, "guest");
    const requests = [
      { method: "GET", url: "/api/codex" },
      { method: "POST", url: "/api/codex/runtime/inspect" },
      { method: "POST", url: "/api/codex/runtime/install" },
      { method: "POST", url: "/api/codex/runtime/cancel" },
      { method: "POST", url: "/api/codex/runtime/activate", payload: { runtimeGeneration: 7 } },
      { method: "POST", url: "/api/codex/profiles", payload: { label: "Guest" } },
      { method: "PATCH", url: `/api/codex/profiles/${PROFILE}`, payload: { label: "Guest", expectedRevision: 3 } },
      { method: "POST", url: `/api/codex/profiles/${PROFILE}/login` },
      { method: "POST", url: `/api/codex/profiles/${PROFILE}/login/cancel`, payload: { loginRef: "guest-ref" } },
      { method: "POST", url: `/api/codex/profiles/${PROFILE}/account` },
      { method: "POST", url: `/api/codex/profiles/${PROFILE}/logout` },
      { method: "DELETE", url: `/api/codex/profiles/${PROFILE}`, payload: { expectedRevision: 3 } },
      { method: "GET", url: `/api/codex/profiles/${PROFILE}/usage` },
      { method: "GET", url: `/api/codex/profiles/${PROFILE}/rate-limits` },
      { method: "GET", url: `/api/codex/profiles/${PROFILE}/models` },
      { method: "GET", url: "/api/codex/preference" },
      {
        method: "PUT",
        url: "/api/codex/preference",
        payload: {
          profileId: null,
          enabled: false,
          posture: "codex_default",
          expectedRevision: 0,
        },
      },
    ] as const;

    for (const request of requests) {
      const result = await app.inject(request);
      expect(result.statusCode).toBe(403);
      expect(JSON.parse(result.body)).toEqual({ code: "CODEX_FORBIDDEN" });
    }
    expect(touched).toBe(false);
    await app.close();
  });

  test("does not disclose a profile owned by another user", async () => {
    const app = makeApp({ getProfile: async () => undefined });
    const result = await app.inject({ method: "POST", url: `/api/codex/profiles/${PROFILE}/account` });
    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body)).toEqual({ code: "CODEX_PROFILE_UNAVAILABLE" });
    await app.close();
  });

  test("coordinates tombstone, exact host cleanup, retained-binding archive, and finalization", async () => {
    const calls: string[] = [];
    let hostFacts: unknown;
    let archiveInput: unknown;
    let finalizeInput: unknown;
    const removing = removalRow();
    const app = makeApp({
      control: makeControl({
        removeProfile: async (facts: unknown) => {
          calls.push("host");
          hostFacts = facts;
          return {
            kind: "profile_status" as const,
            state: "removed" as const,
            profileHandle: PROFILE,
            profileGeneration: 1,
          };
        },
      }),
      beginProfileRemoval: async (input) => {
        calls.push("begin");
        expect(input).toEqual({ userId: OWNER, profileId: PROFILE, expectedRevision: 3 });
        return { status: "begun" as const, profile: removing };
      },
      drainProfileTurns: async (input) => {
        calls.push("drain");
        expect(input).toEqual({ userId: OWNER, profile: removing });
      },
      archiveProfileBindingsForRemoval: async (input) => {
        calls.push("archive");
        archiveInput = input;
        return { status: "archived" as const, count: 2 };
      },
      finalizeProfileRemoval: async (input) => {
        calls.push("finalize");
        finalizeInput = input;
        return { status: "finalized" as const, profile: removalRow({ revision: 5 }) };
      },
    });

    const result = await app.inject({
      method: "DELETE",
      url: `/api/codex/profiles/${PROFILE}`,
      payload: { expectedRevision: 3 },
    });

    expect(result.statusCode).toBe(204);
    expect(calls).toEqual(["begin", "drain", "host", "archive", "finalize"]);
    expect(hostFacts).toEqual({
      userId: OWNER,
      relayId: "relay-1",
      profileHandle: PROFILE,
      profileGeneration: 1,
      accountGeneration: 0,
    });
    expect(archiveInput).toEqual({ userId: OWNER, profile: removing });
    expect(finalizeInput).toEqual({ userId: OWNER, profile: removing });
    await app.close();
  });

  test("keeps an active/removing profile retryable when the host cannot prove cancellation", async () => {
    let archived = false;
    let finalized = false;
    const app = makeApp({
      control: makeControl({
        removeProfile: async () => {
          throw new CodexAdminControlFailure("CODEX_UNAVAILABLE");
        },
      }),
      beginProfileRemoval: async () => ({ status: "already_removing" as const, profile: removalRow() }),
      archiveProfileBindingsForRemoval: async () => {
        archived = true;
        return { status: "archived" as const, count: 1 };
      },
      finalizeProfileRemoval: async () => {
        finalized = true;
        return { status: "finalized" as const, profile: removalRow({ revision: 5 }) };
      },
    });

    const result = await app.inject({
      method: "DELETE",
      url: `/api/codex/profiles/${PROFILE}`,
      payload: { expectedRevision: 3 },
    });

    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body)).toEqual({ code: "CODEX_UNAVAILABLE" });
    expect(archived).toBe(false);
    expect(finalized).toBe(false);
    await app.close();
  });

  test("keeps a tombstoned profile retryable when canonical task drain cannot prove a fixed point", async () => {
    let hostCalled = false;
    let archived = false;
    const app = makeApp({
      control: makeControl({
        removeProfile: async () => {
          hostCalled = true;
          throw new Error("must not reach host cleanup");
        },
      }),
      drainProfileTurns: async () => {
        throw new Error("CODEX_PROFILE_REMOVAL_DRAIN_UNAVAILABLE");
      },
      archiveProfileBindingsForRemoval: async () => {
        archived = true;
        return { status: "archived" as const, count: 1 };
      },
    });

    const result = await app.inject({
      method: "DELETE",
      url: `/api/codex/profiles/${PROFILE}`,
      payload: { expectedRevision: 3 },
    });

    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body)).toEqual({ code: "CODEX_UNAVAILABLE" });
    expect(hostCalled).toBe(false);
    expect(archived).toBe(false);
    await app.close();
  });

  test("treats an exact already-removed retry as success without contacting the host", async () => {
    let hostCalled = false;
    const app = makeApp({
      control: makeControl({
        removeProfile: async () => {
          hostCalled = true;
          throw new Error("must not call host");
        },
      }),
      beginProfileRemoval: async () => ({ status: "already_removed" as const, profile: removalRow({ revision: 5 }) }),
    });
    const result = await app.inject({
      method: "DELETE",
      url: `/api/codex/profiles/${PROFILE}`,
      payload: { expectedRevision: 3 },
    });
    expect(result.statusCode).toBe(204);
    expect(hostCalled).toBe(false);
    await app.close();
  });

  test("returns the selected account child's live Codex model catalog", async () => {
    let received: unknown;
    const app = makeApp({
      control: makeControl({
        listModels: async (facts: unknown) => {
          received = facts;
          return {
            models: [{
              id: "picker-sol",
              model: "gpt-5.6-sol",
              displayName: "GPT-5.6 Sol",
              description: "Frontier coding model",
              isDefault: true,
            }],
            preferredModelId: "picker-sol",
          };
        },
      }),
    });

    const result = await app.inject({
      method: "GET",
      url: `/api/codex/profiles/${PROFILE}/models`,
    });

    expect(result.statusCode).toBe(200);
    expect(received).toMatchObject({
      userId: OWNER,
      relayId: "relay-1",
      profileHandle: PROFILE,
      profileGeneration: 1,
      accountGeneration: 0,
    });
    expect(JSON.parse(result.body)).toEqual({
      models: [{
        id: "picker-sol",
        model: "gpt-5.6-sol",
        displayName: "GPT-5.6 Sol",
        description: "Frontier coding model",
        isDefault: true,
      }],
      preferredModelId: "picker-sol",
    });
    await app.close();
  });

  test("reads an owner-scoped default independently of host reachability", async () => {
    const app = makeApp({
      resolveHost: async () => null,
      getUserPreference: async () => ({
        enabled: true,
        accountProfileId: PROFILE,
        defaultPosture: "full_access_headless",
        revision: 4,
      }),
    });
    const result = await app.inject({
      method: "GET",
      url: "/api/codex/preference",
    });
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({
      enabled: true,
      profileId: PROFILE,
      posture: "full_access_headless",
      revision: 4,
    });
    await app.close();
  });

  test("writes the owner default only for an owner-signed-in profile and forwards its revision", async () => {
    let saved: Record<string, unknown> | undefined;
    const app = makeApp({
      getProfile: async () =>
        row({
          authState: "signed_in",
        }),
      readHostStatus: () => ({
        state: "ready",
        runtimeGeneration: 7,
        runtime: { state: "ready" },
        profiles: [{
          profileHandle: PROFILE,
          profileGeneration: 1,
          accountGeneration: 0,
          state: "signed_in",
        }],
        workspace: { state: "unavailable" },
      }),
      upsertUserPreference: async (input) => {
        saved = input;
        return {
          enabled: input.enabled,
          accountProfileId: input.profileId,
          defaultPosture: input.posture,
          revision: input.expectedRevision + 1,
        };
      },
    });
    const result = await app.inject({
      method: "PUT",
      url: "/api/codex/preference",
      payload: {
        profileId: PROFILE,
        enabled: true,
        posture: "codex_default",
        expectedRevision: 0,
      },
    });
    expect(result.statusCode).toBe(200);
    expect(saved).toMatchObject({ userId: OWNER, profileId: PROFILE, expectedRevision: 0 });
    expect(JSON.parse(result.body)).toMatchObject({
      enabled: true,
      profileId: PROFILE,
      revision: 1,
    });
    await app.close();
  });

  test("rejects stale and other-host profiles from owner-default selection", async () => {
    for (const selected of [
      row({ authState: "signed_in", relayId: "relay-old" }),
      row({ authState: "signed_in", profileGeneration: 2 }),
      row({ authState: "signed_in", accountGeneration: 2 }),
    ]) {
      const app = makeApp({
        getProfile: async () => selected,
        readHostStatus: () => ({
          state: "ready",
          runtimeGeneration: 7,
          runtime: { state: "ready" },
          profiles: [{
            profileHandle: PROFILE,
            profileGeneration: 1,
            accountGeneration: 0,
            state: "signed_in",
          }],
          workspace: { state: "unavailable" },
        }),
      });
      const result = await app.inject({
        method: "PUT",
        url: "/api/codex/preference",
        payload: {
          profileId: PROFILE,
          enabled: true,
          posture: "codex_default",
          expectedRevision: 0,
        },
      });
      expect(result.statusCode).toBe(409);
      expect(JSON.parse(result.body)).toEqual({ code: "CODEX_PROFILE_UNAVAILABLE" });
      await app.close();
    }
  });

  test("rejects owner-default activation when the resolved relay has no current host session", async () => {
    const app = makeApp({
      getProfile: async () => row({ authState: "signed_in" }),
      readHostInspectionScope: () => null,
    });
    const result = await app.inject({
      method: "PUT",
      url: "/api/codex/preference",
      payload: {
        profileId: PROFILE,
        enabled: true,
        posture: "codex_default",
        expectedRevision: 0,
      },
    });
    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body)).toEqual({ code: "CODEX_PROFILE_UNAVAILABLE" });
    await app.close();
  });

  test("keeps only exact live-host profile generations in summary options", async () => {
    const current = row();
    const stale = row({
      id: "44444444-4444-4444-8444-444444444444",
      profileGeneration: 4,
    });
    const otherHost = row({
      id: "55555555-5555-4555-8555-555555555555",
      relayId: "relay-old",
    });
    const app = makeApp({
      listProfiles: async () => [current, stale, otherHost],
      readHostInspectionScope: (_userId, relayId) => relayId === "relay-1"
        ? { relaySessionId: "socket-1", desktopSessionId: "desktop-1", capabilityRevision: 6 }
        : null,
    });
    const result = await app.inject({ method: "GET", url: "/api/codex" });
    expect(result.statusCode).toBe(200);
    const summary = codexConnectionSummarySchema.parse(JSON.parse(result.body));
    expect(summary.profiles.map((candidate) => candidate.id))
      .toEqual([PROFILE, stale.id]);
    await app.close();
  });

  test("reattaches persisted active profiles before projecting a cold host summary", async () => {
    let liveProfiles: Array<{
      profileHandle: string;
      profileGeneration: number;
      accountGeneration: number;
      state: "signed_in";
    }> = [];
    let accountReads = 0;
    const app = makeApp({
      control: makeControl({
        readAccount: async () => {
          accountReads += 1;
          liveProfiles = [{
            profileHandle: PROFILE,
            profileGeneration: 1,
            accountGeneration: 0,
            state: "signed_in",
          }];
          return { kind: "account_status" as const, state: "signed_in" as const, accountGeneration: 0 };
        },
      }),
      readHostStatus: () => ({
        state: "ready",
        runtimeGeneration: 7,
        runtime: { state: "ready" },
        profiles: liveProfiles,
        workspace: { state: "unavailable" },
      }),
      listProfiles: async () => [row({ authState: "signed_in" })],
    });

    const result = await app.inject({ method: "GET", url: "/api/codex" });
    expect(result.statusCode).toBe(200);
    const summary = codexConnectionSummarySchema.parse(JSON.parse(result.body));
    expect(accountReads).toBe(1);
    expect(summary.profiles.map((candidate) => candidate.id)).toEqual([PROFILE]);
    expect(summary.profiles[0]?.authState).toBe("signed_in");
    await app.close();
  });

  test("does not reattach a removing profile during passive summary reads", async () => {
    let accountReads = 0;
    const app = makeApp({
      control: makeControl({
        readAccount: async () => {
          accountReads += 1;
          throw new Error("must not reattach");
        },
      }),
      readHostStatus: () => ({
        state: "ready",
        runtimeGeneration: 7,
        runtime: { state: "ready" },
        profiles: [],
        workspace: { state: "unavailable" },
      }),
      listProfiles: async () => [row({ removalState: "removing" })],
    });

    const result = await app.inject({ method: "GET", url: "/api/codex" });
    expect(result.statusCode).toBe(200);
    expect(accountReads).toBe(0);
    expect(codexConnectionSummarySchema.parse(JSON.parse(result.body)).profiles).toEqual([]);
    await app.close();
  });

  test("reads bounded display identity for an account already attached to the exact host generation", async () => {
    let accountReads = 0;
    let saved: Record<string, unknown> | undefined;
    const app = makeApp({
      control: makeControl({
        readAccount: async () => {
          accountReads += 1;
          return { kind: "account_status", state: "signed_in", accountGeneration: 0, accountEmail: "owner@example.test", planType: "pro" };
        },
      }),
      readHostStatus: () => ({
        state: "ready",
        runtimeGeneration: 7,
        runtime: { state: "ready" },
        profiles: [{
          profileHandle: PROFILE,
          profileGeneration: 1,
          accountGeneration: 0,
          state: "signed_in",
        }],
        workspace: { state: "unavailable" },
      }),
      listProfiles: async () => [row({ authState: "signed_in" })],
      updateProfileStatus: async (input) => {
        saved = input;
        return row({
          authState: input.authState,
          accountEmail: input.accountEmail,
          planType: input.planType,
          revision: input.expectedRevision + 1,
        });
      },
    });

    const result = await app.inject({ method: "GET", url: "/api/codex" });
    expect(result.statusCode).toBe(200);
    expect(accountReads).toBe(1);
    expect(saved).toMatchObject({ accountEmail: "owner@example.test", planType: "pro" });
    const summary = codexConnectionSummarySchema.parse(JSON.parse(result.body));
    expect(summary.profiles).toHaveLength(1);
    expect(summary.profiles[0]).toMatchObject({ accountEmail: "owner@example.test", planType: "pro" });
    await app.close();
  });

  test("does not expose the superseded per-Genie preference HTTP surface", async () => {
    const app = makeApp();
    const result = await app.inject({
      method: "GET",
      url: "/api/codex/agents/33333333-3333-4333-8333-333333333333/preference",
    });
    expect(result.statusCode).toBe(404);
    await app.close();
  });

  test("projects a populated persisted usage envelope without private host fields", async () => {
    const app = makeApp({
      control: makeControl({ readAccount: async () => ({ kind: "account_status", state: "signed_out", accountGeneration: 0 }) }),
      listProfiles: async () => [row({
        usageObservedAt: new Date("2026-07-28T09:00:00.000Z"),
        usageSnapshot: {
          schemaVersion: 1,
          rateLimits: {
            primary: { usedPercent: 20, windowDurationMins: 60, resetsAt: null },
            secondary: null,
            plan: "pro",
            credits: null,
            spendControl: null,
            reached: null,
            observedAt: "2026-07-28T09:00:00.000Z",
            freshness: "live",
          },
          usage: {
            summary: { lifetimeTokens: "42", peakDailyTokens: null, longestRunningTurnSec: null, currentStreakDays: null, longestStreakDays: null },
            daily: [{ startDate: "2026-07-28", tokens: "42" }],
            observedAt: "2026-07-28T09:00:00.000Z",
            freshness: "live",
          },
        },
      })],
    });
    const result = await app.inject({ method: "GET", url: "/api/codex" });
    expect(result.statusCode).toBe(200);
    const body = codexConnectionSummarySchema.parse(JSON.parse(result.body));
    const firstProfile = body.profiles[0]!;
    expect(body.runtime).toEqual({
      state: "ready",
      available: true,
      runtimeGeneration: 7,
      collaborationModeAvailable: false,
    });
    expect(firstProfile.rateLimits!.plan).toBe("pro");
    expect(firstProfile.usage!.daily).toEqual([{ startDate: "2026-07-28", tokens: "42" }]);
    expect(firstProfile).not.toHaveProperty("relayId");
    expect(firstProfile).not.toHaveProperty("homeHandle");
    await app.close();
  });

  test("refreshes both provider projections once, persists the safe snapshot, and returns the requested fresh half", async () => {
    const writes: unknown[] = [];
    const app = makeApp({
      control: makeControl({
        readUsage: async () => ({
          summary: { lifetimeTokens: "17", peakDailyTokens: null, longestRunningTurnSec: null, currentStreakDays: null, longestStreakDays: null },
          daily: [{ startDate: "2026-08-01", tokens: "17" }],
          observedAt: "2026-08-01T10:00:00.000Z",
          freshness: "live" as const,
        }),
        readRateLimits: async () => ({
          primary: { usedPercent: 10, windowDurationMins: 60, resetsAt: null },
          secondary: null,
          plan: "pro" as const,
          credits: null,
          spendControl: null,
          reached: null,
          observedAt: "2026-08-01T10:00:00.000Z",
          freshness: "live" as const,
        }),
      }),
      updateProfileUsageSnapshot: async (input) => {
        writes.push(input);
        return row({
          usageSnapshot: { schemaVersion: 1, ...input.patch },
          usageObservedAt: input.observedAt,
          revision: input.expectedRevision + 1,
        });
      },
    });
    const result = await app.inject({ method: "GET", url: `/api/codex/profiles/${PROFILE}/usage` });
    expect(result.statusCode).toBe(200);
    expect(codexUsageSchema.parse(JSON.parse(result.body))).toMatchObject({
      summary: { lifetimeTokens: "17" },
      freshness: "live",
    });
    expect(writes).toHaveLength(1);
    expect((writes[0] as { patch: unknown }).patch).toEqual({
      usage: {
        summary: { lifetimeTokens: "17", peakDailyTokens: null, longestRunningTurnSec: null, currentStreakDays: null, longestStreakDays: null },
        daily: [{ startDate: "2026-08-01", tokens: "17" }],
        observedAt: "2026-08-01T10:00:00.000Z",
        freshness: "live",
      },
      rateLimits: {
        primary: { usedPercent: 10, windowDurationMins: 60, resetsAt: null },
        secondary: null,
        plan: "pro",
        credits: null,
        spendControl: null,
        reached: null,
        observedAt: "2026-08-01T10:00:00.000Z",
        freshness: "live",
      },
    });
    await app.close();
  });

  test("keeps a requested unsupported usage read in the stable control-plane vocabulary", async () => {
    const app = makeApp({
      control: makeControl({
        readUsage: async () => { throw new CodexAdminControlFailure("CODEX_CAPABILITY_UNAVAILABLE"); },
        readRateLimits: async () => ({
          primary: null, secondary: null, plan: null, credits: null, spendControl: null, reached: null,
          observedAt: "2026-08-01T10:00:00.000Z", freshness: "live" as const,
        }),
      }),
    });
    const result = await app.inject({ method: "GET", url: `/api/codex/profiles/${PROFILE}/usage` });
    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body)).toEqual({ code: "CODEX_CAPABILITY_UNAVAILABLE" });
    await app.close();
  });

  test("execution admission has no usage or quota-derived profile routing inputs", () => {
    const selectionFiles = [
      "../../src/codex/harness-admission.ts",
      "../../src/codex/harness-task.ts",
      "../../src/codex/admission-factory.ts",
    ];
    for (const relative of selectionFiles) {
      const source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
      expect(source).not.toMatch(/usageSnapshot|rateLimits|usedPercent|quota|planType/i);
    }
  });

  test("reuses an exact-session inspection for passive summary reads", async () => {
    let inspections = 0;
    const app = makeApp({
      control: makeControl({
        inspectRuntime: async () => {
          inspections += 1;
          return { kind: "runtime_status" as const, state: "ready" as const, runtimeGeneration: 7 };
        },
      }),
    });

    expect((await app.inject({ method: "GET", url: "/api/codex" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/codex" })).statusCode).toBe(200);
    expect(inspections).toBe(1);
    await app.close();
  });

  test("forces an explicit inspection and naturally misses the snapshot after a host-scope change", async () => {
    let inspections = 0;
    let capabilityRevision = 6;
    const app = makeApp({
      control: makeControl({
        inspectRuntime: async () => {
          inspections += 1;
          return { kind: "runtime_status" as const, state: "ready" as const, runtimeGeneration: 7 };
        },
      }),
      readHostInspectionScope: () => ({
        relaySessionId: "socket-1",
        desktopSessionId: "desktop-1",
        capabilityRevision,
      }),
    });

    expect((await app.inject({ method: "GET", url: "/api/codex" })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/codex/runtime/inspect" })).statusCode).toBe(200);
    capabilityRevision = 7;
    expect((await app.inject({ method: "GET", url: "/api/codex" })).statusCode).toBe(200);
    // The latest exact scope evicts the old one: returning to the previous
    // revision must re-inspect rather than retaining snapshots forever.
    capabilityRevision = 6;
    expect((await app.inject({ method: "GET", url: "/api/codex" })).statusCode).toBe(200);
    expect(inspections).toBe(4);
    await app.close();
  });

  test("expires passive inspection snapshots and LRU-evicts owners beyond the bound", async () => {
    let now = 1_000;
    let inspections = 0;
    const app = makeApp({
      control: makeControl({
        inspectRuntime: async () => {
          inspections += 1;
          return { kind: "runtime_status" as const, state: "ready" as const, runtimeGeneration: 7 };
        },
      }),
      runtimeInspectionCache: {
        now: () => now,
        ttlMs: 50,
        maxEntries: 1,
      },
    }, (request) => request.headers["x-owner"] === "second" ? SECOND_OWNER : OWNER);

    expect((await app.inject({ method: "GET", url: "/api/codex" })).statusCode).toBe(200);
    expect((await app.inject({
      method: "GET",
      url: "/api/codex",
      headers: { "x-owner": "second" },
    })).statusCode).toBe(200);
    // The second owner displaced the first owner without sharing its result.
    expect((await app.inject({ method: "GET", url: "/api/codex" })).statusCode).toBe(200);
    now += 51;
    // The exact owner/session entry also expires without a scope change.
    expect((await app.inject({ method: "GET", url: "/api/codex" })).statusCode).toBe(200);
    expect(inspections).toBe(4);
    await app.close();
  });

  test("keeps the owner index bounded while many owners churn through the inspection LRU", async () => {
    let inspections = 0;
    const app = makeApp({
      control: makeControl({
        inspectRuntime: async () => {
          inspections += 1;
          return { kind: "runtime_status" as const, state: "ready" as const, runtimeGeneration: 7 };
        },
      }),
      runtimeInspectionCache: {
        ttlMs: 60_000,
        maxEntries: 2,
      },
    }, (request) => String(request.headers["x-owner"] ?? OWNER));

    for (let index = 0; index < 12; index += 1) {
      const result = await app.inject({
        method: "GET",
        url: "/api/codex",
        headers: { "x-owner": `owner-${index}` },
      });
      expect(result.statusCode).toBe(200);
    }
    // The first owner and its owner-index entry were evicted together.
    expect((await app.inject({
      method: "GET",
      url: "/api/codex",
      headers: { "x-owner": "owner-0" },
    })).statusCode).toBe(200);
    expect(inspections).toBe(13);
    await app.close();
  });

  test("replaces the passive inspection snapshot after a runtime mutation", async () => {
    let inspections = 0;
    const app = makeApp({
      control: makeControl({
        inspectRuntime: async () => {
          inspections += 1;
          return { kind: "runtime_status" as const, state: "ready" as const, runtimeGeneration: 7 };
        },
        activateRuntime: async () => ({ kind: "runtime_status" as const, state: "ready" as const, runtimeGeneration: 7 }),
      }),
    });

    expect((await app.inject({ method: "POST", url: "/api/codex/runtime/activate", payload: { runtimeGeneration: 7 } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/codex" })).statusCode).toBe(200);
    expect(inspections).toBe(0);
    await app.close();
  });

  test("marks a runtime available only after the refreshed host selects it", async () => {
    const app = makeApp({
      readHostStatus: () => ({
        state: "ready",
        runtimeGeneration: 7,
        runtime: { state: "ready" },
        workspace: { state: "unavailable" },
      }),
    });
    const result = await app.inject({ method: "POST", url: "/api/codex/runtime/activate", payload: { runtimeGeneration: 7 } });
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({
      state: "ready", available: true, runtimeGeneration: 7, collaborationModeAvailable: false,
    });
    await app.close();
  });

  test("preserves an inspected activation generation while host status catches up", async () => {
    const app = makeApp({
      readHostStatus: () => ({
        state: "runtime_unavailable",
        runtime: { state: "ready" },
        workspace: { state: "unavailable" },
      }),
    });
    const result = await app.inject({ method: "POST", url: "/api/codex/runtime/inspect" });
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({
      state: "ready",
      available: false,
      runtimeGeneration: 7,
      collaborationModeAvailable: false,
    });
    await app.close();
  });

  test("keeps a selected limited runtime available without asking to activate it again", async () => {
    const app = makeApp({
      readHostStatus: () => ({
        state: "limited",
        runtimeGeneration: 7,
        runtime: {
          state: "ready",
          compatibilityDiagnostics: [{
            feature: "request_user_input",
            reason: "changed_field_shape",
          }],
        },
        workspace: { state: "unavailable" },
      }),
    });
    const result = await app.inject({ method: "POST", url: "/api/codex/runtime/inspect" });
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({
      state: "limited", available: true, runtimeGeneration: 7, collaborationModeAvailable: false,
      compatibilityDiagnostics: [{
        feature: "request_user_input",
        reason: "changed_field_shape",
      }],
    });
    await app.close();
  });

  test("projects Plan availability only from the current ready host feature gate", async () => {
    const app = makeApp({
      readHostStatus: () => ({
        state: "ready",
        runtimeGeneration: 7,
        runtime: { state: "ready" },
        features: {
          stableConversation: true,
          explicitSteer: true,
          codexApprovals: true,
          requestUserInput: true,
          collaborationMode: true,
        },
        workspace: { state: "unavailable" },
      }),
    });
    const result = await app.inject({ method: "GET", url: "/api/codex" });
    expect(result.statusCode).toBe(200);
    const body = codexConnectionSummarySchema.parse(JSON.parse(result.body));
    expect(body.runtime).toMatchObject({
      state: "ready",
      collaborationModeAvailable: true,
    });
    await app.close();
  });

  test("persists and returns the live account state when polling login", async () => {
    let saved: Record<string, unknown> | undefined;
    const app = makeApp({
      control: makeControl({
        readAccount: async () => ({
          kind: "account_status" as const,
          state: "signed_in" as const,
          accountGeneration: 2,
          accountEmail: "person@example.test",
          planType: "pro" as const,
        }),
      }),
      getProfile: async () => row({ authState: "login_pending" }),
      updateProfileStatus: async (input) => {
        saved = input;
        return row({
          authState: input.authState,
          accountEmail: input.accountEmail,
          planType: input.planType,
          accountGeneration: input.accountGeneration,
          revision: input.expectedRevision + 1,
        });
      },
    });
    const result = await app.inject({ method: "POST", url: `/api/codex/profiles/${PROFILE}/account` });
    expect(result.statusCode).toBe(200);
    expect(saved).toMatchObject({
      authState: "signed_in",
      accountEmail: "person@example.test",
      planType: "pro",
      accountGeneration: 2,
      expectedRevision: 3,
    });
    expect(codexAccountStatusSchema.parse(JSON.parse(result.body)).profile).toMatchObject({
      authState: "signed_in",
      accountEmail: "person@example.test",
      planType: "pro",
    });
    await app.close();
  });

  test("retains the last provider-verified identity when a later account read has no identity", async () => {
    let saved: Record<string, unknown> | undefined;
    const app = makeApp({
      control: makeControl({
        readAccount: async () => ({
          kind: "account_status" as const,
          state: "signed_out" as const,
          accountGeneration: 2,
        }),
      }),
      getProfile: async () => row({
        authState: "reauth_required",
        accountEmail: "person@example.test",
        planType: "pro",
      }),
      updateProfileStatus: async (input) => {
        saved = input;
        return row({
          authState: input.authState,
          accountEmail: "person@example.test",
          planType: "pro",
          accountGeneration: input.accountGeneration,
          revision: input.expectedRevision + 1,
        });
      },
    });

    const result = await app.inject({ method: "POST", url: `/api/codex/profiles/${PROFILE}/account` });
    expect(result.statusCode).toBe(200);
    expect(saved).not.toHaveProperty("accountEmail");
    expect(saved).not.toHaveProperty("planType");
    expect(codexAccountStatusSchema.parse(JSON.parse(result.body)).profile).toMatchObject({
      authState: "signed_out",
      accountEmail: "person@example.test",
      planType: "pro",
    });
    await app.close();
  });

  test("reconciles one optimistic conflict after a host account generation advances", async () => {
    let reads = 0;
    const writes: number[] = [];
    const app = makeApp({
      getProfile: async () => {
        reads += 1;
        return row({ revision: reads === 1 ? 3 : 4 });
      },
      updateProfileStatus: async (input) => {
        writes.push(input.expectedRevision);
        return writes.length === 1
          ? undefined
          : row({ authState: input.authState, accountGeneration: input.accountGeneration, revision: input.expectedRevision + 1 });
      },
    });
    const result = await app.inject({ method: "POST", url: `/api/codex/profiles/${PROFILE}/account` });
    expect(result.statusCode).toBe(200);
    expect(writes).toEqual([3, 4]);
    expect(codexAccountStatusSchema.parse(JSON.parse(result.body)).profile).toMatchObject({ authState: "signed_in", revision: 5 });
    await app.close();
  });

  test("cancels a newly issued host login when pending-state persistence conflicts", async () => {
    let cancelled: string | undefined;
    let reads = 0;
    const app = makeApp({
      control: makeControl({
        cancelAccountLogin: async (_facts: unknown, loginRef: string) => {
          cancelled = loginRef;
          return { kind: "account_status" as const, state: "signed_out" as const, accountGeneration: 0 };
        },
      }),
      getProfile: async () => {
        reads += 1;
        return reads === 1 ? row() : undefined;
      },
      updateProfileStatus: async () => undefined,
    });
    const result = await app.inject({ method: "POST", url: `/api/codex/profiles/${PROFILE}/login` });
    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body)).toEqual({ code: "CODEX_STALE" });
    expect(cancelled).toBe("login-ref");
    await app.close();
  });

  test("recovers an expired host login receipt to the current account state", async () => {
    let saved: Record<string, unknown> | undefined;
    const app = makeApp({
      control: makeControl({
        cancelAccountLogin: async () => {
          throw new CodexAdminControlFailure("CODEX_CORRELATION_REPLAY");
        },
        readAccount: async () => ({
          kind: "account_status" as const,
          state: "signed_out" as const,
          accountGeneration: 0,
        }),
      }),
      getProfile: async () => row({ authState: "login_pending" }),
      updateProfileStatus: async (input) => {
        saved = input;
        return row({
          authState: input.authState,
          accountGeneration: input.accountGeneration,
          revision: input.expectedRevision + 1,
        });
      },
    });
    const result = await app.inject({
      method: "POST",
      url: `/api/codex/profiles/${PROFILE}/login/cancel`,
      payload: { loginRef: "expired-login-ref" },
    });

    expect(result.statusCode).toBe(200);
    expect(saved).toMatchObject({ authState: "signed_out", accountGeneration: 0 });
    expect(codexAccountStatusSchema.parse(JSON.parse(result.body)).profile.authState).toBe("signed_out");
    await app.close();
  });
});
