/**
 * D418 — unit tests for the Full Workstation access activation/disable
 * route. Mirrors the security-posture route test harness: a minimal
 * Fastify app, a bearer-session preHandler stub that stamps
 * `sessionUserId` / `sessionActorId` / `policyContext`, an in-memory
 * `FakeChallengeProvider`, an injected `RelayBindingProvider` test
 * double, and a spy audit callback.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { ToolCall } from "@langchain/core/messages/tool";
import Fastify, { type FastifyInstance } from "fastify";
import {
  LockoutError,
  type ChallengeProvider,
} from "@nautilo/trust";

import {
  workstationAccessRoutes,
  createWorkstationApprovalOverrideResolver,
  classifyWorkstationExecutionClass,
  resolveActiveWorkstationDispatchBinding,
  type WorkstationOverrideResolverRequest,
} from "../../src/routes/workstation-access";
import { verifyWorkstationStartupReceipt } from "../../src/workstation-startup-receipt";
import {
  FULL_WORKSTATION_AGENT_SCOPE,
  InMemoryRelayRegistry,
  InMemoryWorkstationSessionRegistry,
  InMemoryWorkstationDispatchPlanRegistry,
  type FullWorkstationBinding,
  type WorkstationAccessAuditEvent,
  type WorkstationAdmissionAuditEvent,
} from "@nautilo/runtime";
import { SessionStore } from "../helpers/test-session-store";
import type { RelayCapabilities } from "@nautilo/relay";

const OWNER_ACTOR_ID = "owner-actor";
const OWNER_USER_ID = "owner-user";
const NO_CAP_USER_ID = "nocap-user";
const OWNER_PIN = "246810";
const STARTUP_RECEIPT_SECRET = "startup-receipt-unit-secret-material-32";

const FIXED_TS = "2026-07-13T12:00:00.000Z";
const clock = () => new Date(FIXED_TS);

function binding(overrides: Partial<FullWorkstationBinding> = {}): FullWorkstationBinding {
  return {
    userId: OWNER_USER_ID,
    instanceId: "instance-1",
    relayId: "relay-1",
    desktopSessionId: "desktop-session-1",
    serverBindingId: "server-binding-1",
    pairingGeneration: "pairing-1",
    agentScope: FULL_WORKSTATION_AGENT_SCOPE,
    profileId: "profile-1",
    profileRevision: 1,
    grantIds: ["grant-1", "grant-2"],
    capabilityRevision: 10,
    ...overrides,
  };
}

/** The client payload omits userId (stamped in from the session). */
function payload(overrides: Partial<FullWorkstationBinding> = {}) {
  const b = binding(overrides);
  const { userId: _userId, ...rest } = b;
  return rest;
}

type RouteBody = {
  error?: string;
  retryAfterMs?: number;
  ok?: boolean;
  outcome?: string;
  authorization?: string;
  session?: {
    serverBindingId?: string;
    activatedAt?: string;
    profileId?: string;
    profileRevision?: number;
  } | null;
  commandOutput?: unknown;
  pin?: unknown;
  startupReceipt?: unknown;
};

function responseBody(res: { json(): unknown }): RouteBody {
  return res.json() as RouteBody;
}

class FakeChallengeProvider implements ChallengeProvider {
  private readonly pins = new Map<string, string>();
  private locked: { userId: string; remainingMs: number } | null = null;
  enroll(userId: string, pin: string): void {
    this.pins.set(userId, pin);
  }
  lockNext(userId: string, remainingMs: number): void {
    this.locked = { userId, remainingMs };
  }
  verifyProof(userId: string, proof: string): Promise<boolean> {
    if (this.locked?.userId === userId) {
      const { remainingMs } = this.locked;
      this.locked = null;
      throw new LockoutError(remainingMs);
    }
    return Promise.resolve(this.pins.get(userId) === proof);
  }
  isEnrolled(userId: string): Promise<boolean> {
    return Promise.resolve(this.pins.has(userId));
  }
}

function installBearerSessionPreHandler(
  app: FastifyInstance,
  store: SessionStore,
): void {
  app.decorateRequest("sessionUserId", null);
  app.decorateRequest("sessionActorId", null);
  app.decorateRequest("policyContext", null);
  app.addHook("preHandler", async (request) => {
    const auth = request.headers.authorization;
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
    const session = token ? store.validateSession(token) : null;
    if (!session) return;
    request.sessionUserId = session.userId;
    request.sessionActorId = session.actorId;
    request.policyContext = {
      actorRole: "owner",
      actorLabel: "owner",
    } as unknown as typeof request.policyContext;
  });
}

let app: FastifyInstance;
let sessionStore: SessionStore;
let ownerToken: string;
let nocapToken: string;
let pinProvider: FakeChallengeProvider;
let registry: InMemoryWorkstationSessionRegistry;
let auditCalls: WorkstationAccessAuditEvent[];
// D418 task 3.1.2 — transient dispatch-plan store + live relay registry used
// by the override resolver's plan-admission tests.
let planRegistry: InMemoryWorkstationDispatchPlanRegistry;
let relayRegistry: InMemoryRelayRegistry;
const userCaps = new Map<string, readonly string[]>();
// Mutable so the route's closure picks up per-test overrides.
let relayBinding: FullWorkstationBinding | null;
// D418 — mutable profile-selector activation binding test double. The
// /activate-profile route resolves this (or null) via the injected
// `profileActivationProvider`; per-test overrides flip it.
let profileActivationBinding: FullWorkstationBinding | null;

beforeAll(async () => {
  sessionStore = new SessionStore(undefined, { persistPath: null });
  pinProvider = new FakeChallengeProvider();
  pinProvider.enroll(OWNER_USER_ID, OWNER_PIN);
  pinProvider.enroll(NO_CAP_USER_ID, "000000");
  auditCalls = [];
  registry = new InMemoryWorkstationSessionRegistry({
    audit: (e) => auditCalls.push(e),
    now: clock,
  });
  // D418 task 3.1.2 — fresh plan + relay registries for the resolver tests.
  planRegistry = new InMemoryWorkstationDispatchPlanRegistry({ now: clock });
  relayRegistry = new InMemoryRelayRegistry();
  relayBinding = binding();
  // D418 — default the profile-selector activation binding to a valid
  // binding matching the client selectors. Per-test overrides flip it.
  profileActivationBinding = binding();

  app = Fastify({ logger: false });
  installBearerSessionPreHandler(app, sessionStore);
  workstationAccessRoutes(app, {
    get relayRegistry() { return relayRegistry; },
    pinProvider,
    getCapabilities: (userId) => Promise.resolve(userCaps.get(userId) ?? []),
    relayBindingProvider: {
      resolve: async () => relayBinding,
    },
    profileActivationProvider: {
      resolve: async (input) => {
        // Echo the client selectors into the resolved binding so the route
        // stamps them; per-test overrides drive the mutable default.
        if (profileActivationBinding === null) return null;
        return {
          ...profileActivationBinding,
          profileId: input.profileId,
          profileRevision: input.profileRevision,
        };
      },
    },
    registry,
    auditEvent: async (event) => {
      auditCalls.push(event);
    },
    startupReceiptSecret: () => STARTUP_RECEIPT_SECRET,
    now: clock,
  });
  await app.ready();

  ownerToken = sessionStore.createSession(
    OWNER_ACTOR_ID,
    OWNER_USER_ID,
    OWNER_USER_ID,
  ).token;
  nocapToken = sessionStore.createSession(
    "nocap-actor",
    OWNER_USER_ID,
    NO_CAP_USER_ID,
  ).token;
});

beforeEach(() => {
  // Clear the single registry instance in place (the route closes over
  // it). Idempotent disable removes any active session.
  registry.disable(OWNER_USER_ID);
  registry.disable(NO_CAP_USER_ID);
  userCaps.clear();
  // B3 (D418 Commit 1): activation requires ONLY `use_workstation`
  // (control_desktop is no longer an activation gate); disable is
  // capability-independent. Owner holds use_workstation; the
  // no-cap user holds nothing. Per-test cap overrides drive the
  // missing-use_workstation + revoked-mid-session cases.
  userCaps.set(OWNER_USER_ID, ["control_desktop", "use_workstation"]);
  userCaps.set(NO_CAP_USER_ID, []);
  auditCalls = [];
  relayBinding = binding();
  profileActivationBinding = binding();
  // D418 task 3.1.2 — reset the plan store + relay registry so each resolver
  // test starts from a clean binding fingerprint. The relay registry here is
  // read through the route dependency getter, so re-creating it is safe.
  planRegistry.clear();
  relayRegistry = new InMemoryRelayRegistry();
});

afterAll(async () => {
  if (app) await app.close();
});

describe("GET /api/workstation-access/session", () => {
  test("returns 401 without an authenticated session", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/workstation-access/session",
    });

    expect(res.statusCode).toBe(401);
    expect(responseBody(res).error).toBe("Authentication required");
  });

  test("returns a truthful null session for an authenticated user with none", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/workstation-access/session",
      headers: { authorization: `Bearer ${ownerToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(responseBody(res)).toEqual({ ok: true, session: null });
  });

  test("returns only profile selectors for an active authenticated session", async () => {
    const active = binding();
    expect(registry.activate(active, active).ok).toBe(true);

    registerBoundRelay();

    const res = await app.inject({
      method: "GET",
      url: "/api/workstation-access/session",
      headers: { authorization: `Bearer ${ownerToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = responseBody(res);
    expect(body).toEqual({
      ok: true,
      session: { profileId: active.profileId, profileRevision: active.profileRevision },
    });
    expect(body.session).toEqual({ profileId: active.profileId, profileRevision: active.profileRevision });
  });
});

describe("workstation readiness after Relay replacement", () => {
  test.each([
    ["rollback", { capabilityRevision: 0 }],
    ["different Desktop", { desktopSessionId: "other-desktop" }],
    ["different pairing", { pairingGeneration: "other-pairing" }],
    ["different profile", { profileId: "other-profile" }],
    ["different grants", { grantIds: ["other-grant"] }],
    ["different owner", { userId: NO_CAP_USER_ID }],
  ] as const)("does not report ready for %s and preserves consent for coherent recovery", async (_reason, drift) => {
    activateLiveSession();
    registerBoundRelay(drift);
    const status = () => app.inject({ method: "GET", url: "/api/workstation-access/session",
      headers: { authorization: `Bearer ${ownerToken}` } });
    expect(responseBody(await status())).toEqual({ ok: true, session: null });
    expect(registry.get(OWNER_USER_ID)).not.toBeNull();
    registerBoundRelay({ capabilityRevision: 11 });
    expect(responseBody(await status()).session).toEqual({ profileId: "profile-1", profileRevision: 1 });
  });

  test("reports an unchanged zero-grant session ready after a monotonic replacement", async () => {
    const active = binding({ grantIds: [] });
    expect(registry.activate(active, active).ok).toBe(true);
    registerBoundRelay({ grantIds: [], capabilityRevision: 11 });
    const res = await app.inject({ method: "GET", url: "/api/workstation-access/session",
      headers: { authorization: `Bearer ${ownerToken}` } });
    expect(responseBody(res).session).toEqual({ profileId: "profile-1", profileRevision: 1 });
  });
});

describe("POST /api/workstation-access/activate", () => {
  test("401 without a bearer session", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate",
      headers: { "Content-Type": "application/json" },
      payload: { pin: OWNER_PIN, binding: payload() },
    });
    expect(res.statusCode).toBe(401);
    expect(responseBody(res).error).toBe("Authentication required");
  });

  test("403 without use_workstation capability (no PIN burned)", async () => {
    // B3 (D418 Commit 1): activation requires ONLY use_workstation.
    // The no-cap user holds nothing; the 403 must name
    // use_workstation (control_desktop is no longer checked) and
    // must NOT burn a PIN attempt.
    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${nocapToken}`,
      },
      payload: { pin: "000000", binding: payload() },
    });
    expect(res.statusCode).toBe(403);
    expect(responseBody(res).error).toBe("capability_missing");
    expect(res.json()).toHaveProperty("capability", "use_workstation");
    expect(auditCalls.some((e) => e.kind === "workstation_session_denied")).toBe(true);
  });

  test("403 with control_desktop but missing use_workstation (B3)", async () => {
    // B3 (D418 Commit 1): control_desktop alone no longer authorizes
    // activation. The 403 must name use_workstation, and must NOT
    // burn a PIN attempt.
    userCaps.set(OWNER_USER_ID, ["control_desktop"]);
    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: { pin: OWNER_PIN, binding: payload() },
    });
    expect(res.statusCode).toBe(403);
    expect(responseBody(res).error).toBe("capability_missing");
    expect(res.json()).toHaveProperty("capability", "use_workstation");
    expect(auditCalls.some((e) => e.kind === "workstation_session_denied")).toBe(true);
    // No session was created.
    expect(registry.get(OWNER_USER_ID)).toBeNull();
  });

  test("200 activation succeeds with use_workstation but WITHOUT control_desktop (B3)", async () => {
    // B3 (D418 Commit 1): control_desktop is no longer required for
    // activation. A user holding ONLY use_workstation activates.
    userCaps.set(OWNER_USER_ID, ["use_workstation"]);
    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: { pin: OWNER_PIN, binding: payload() },
    });
    expect(res.statusCode).toBe(200);
    expect(responseBody(res).ok).toBe(true);
    expect(responseBody(res).outcome).toBe("activated");
    expect(registry.get(OWNER_USER_ID)?.serverBindingId).toBe("server-binding-1");
  });

  test("400 when binding is missing (before PIN verification)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: { pin: OWNER_PIN },
    });
    expect(res.statusCode).toBe(400);
    expect(responseBody(res).error).toBe("binding is required");
  });

  test("400 when PIN is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: { binding: payload() },
    });
    expect(res.statusCode).toBe(400);
    expect(responseBody(res).error).toBe("PIN is required");
  });

  test("400 when the binding payload is malformed (headless relay)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: { pin: OWNER_PIN, binding: payload({ desktopSessionId: "" }) },
    });
    expect(res.statusCode).toBe(400);
  });

  test("404 when the relay binding provider resolves no binding", async () => {
    relayBinding = null;
    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: { pin: OWNER_PIN, binding: payload() },
    });
    expect(res.statusCode).toBe(404);
    expect(responseBody(res).error).toBe("relay_binding_unavailable");
    expect(auditCalls.at(-1)?.denialCode).toBe("ineligible_binding");
  });

  test("409 when the payload does not exactly match the authoritative binding (foreign)", async () => {
    relayBinding = binding({ serverBindingId: "authoritative" });
    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: { pin: OWNER_PIN, binding: payload({ serverBindingId: "client-claimed" }) },
    });
    expect(res.statusCode).toBe(409);
    expect(responseBody(res).error).toBe("foreign_binding");
    expect(auditCalls.at(-1)?.denialCode).toBe("foreign_binding");
  });

  test("D418 Commit 2 — 409 when the payload pairingGeneration does not match the authoritative binding (foreign)", async () => {
    // The authoritative binding carries pairingGeneration "pairing-1"; the
    // client payload claims a different (client-authored) generation. The
    // exact-match check rejects it — a client flag alone cannot activate.
    relayBinding = binding({ pairingGeneration: "pairing-1" });
    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: { pin: OWNER_PIN, binding: payload({ pairingGeneration: "client-forged-generation" }) },
    });
    expect(res.statusCode).toBe(409);
    expect(responseBody(res).error).toBe("foreign_binding");
    expect(auditCalls.at(-1)?.denialCode).toBe("foreign_binding");
  });

  test("401 on an invalid PIN (after capability + binding shape pass)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: { pin: "wrong-pin", binding: payload() },
    });
    expect(res.statusCode).toBe(401);
    expect(responseBody(res).error).toBe("Invalid PIN");
  });

  test("429 when the challenge provider throws a LockoutError", async () => {
    pinProvider.lockNext(OWNER_USER_ID, 30_000);
    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: { pin: OWNER_PIN, binding: payload() },
    });
    expect(res.statusCode).toBe(429);
    expect(responseBody(res).retryAfterMs).toBe(30_000);
  });

  test("200 happy path activates a session and emits an audit event", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: { pin: OWNER_PIN, binding: payload() },
    });
    expect(res.statusCode).toBe(200);
    const body = responseBody(res);
    expect(body.ok).toBe(true);
    expect(body.outcome).toBe("activated");
    expect(body.session?.serverBindingId).toBe("server-binding-1");
    expect(body.session?.activatedAt).toBe(FIXED_TS);
    expect(registry.get(OWNER_USER_ID)?.serverBindingId).toBe("server-binding-1");
    expect(auditCalls.some((e) => e.kind === "workstation_session_activated")).toBe(true);
    // No secrets / command output in the audit row.
    const activated = auditCalls.find((e) => e.kind === "workstation_session_activated");
    expect(activated).not.toHaveProperty("pin");
  });

  test("mints a bounded startup receipt only after successful own-PIN activation", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
      payload: { pin: OWNER_PIN, binding: payload() },
    });
    expect(res.statusCode).toBe(200);
    const receipt = responseBody(res).startupReceipt;
    expect(typeof receipt).toBe("string");
    expect(receipt).not.toContain(OWNER_PIN);
    expect((receipt as string).length).toBeGreaterThan(0);
    expect(verifyWorkstationStartupReceipt(STARTUP_RECEIPT_SECRET, receipt)).toEqual({
      userId: OWNER_USER_ID,
      instanceId: "instance-1",
      serverBindingId: "server-binding-1",
      pairingGeneration: "pairing-1",
      profileId: "profile-1",
      profileRevision: 1,
    });
    expect(auditCalls.every((event) => !Object.values(event).includes(receipt))).toBe(true);
  });

  test("accepts a valid receipt only against the current exact live binding", async () => {
    const enrollment = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
      payload: { pin: OWNER_PIN, binding: payload() },
    });
    const receipt = responseBody(enrollment).startupReceipt;
    registry.disable(OWNER_USER_ID);

    const restored = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
      payload: { startupReceipt: receipt, binding: payload({ desktopSessionId: "desktop-session-next" }) },
    });
    // A later Electron launch changes the desktop session ID, but the live
    // provider still confirms the same physical pairing generation.
    expect(restored.statusCode).toBe(409);

    relayBinding = binding({ desktopSessionId: "desktop-session-next" });
    const accepted = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
      payload: { startupReceipt: receipt, binding: payload({ desktopSessionId: "desktop-session-next" }) },
    });
    expect(accepted.statusCode).toBe(200);
    expect(responseBody(accepted).startupReceipt).toBeUndefined();
  });

  test("rejects receipt replay across instance, server, pairing, and profile drift", async () => {
    const enrollment = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
      payload: { pin: OWNER_PIN, binding: payload() },
    });
    const receipt = responseBody(enrollment).startupReceipt;
    registry.disable(OWNER_USER_ID);

    for (const changed of [
      { instanceId: "instance-2" },
      { serverBindingId: "server-binding-2" },
      { pairingGeneration: "pairing-2" },
      { profileId: "profile-2" },
      { profileRevision: 2 },
    ] satisfies Partial<FullWorkstationBinding>[]) {
      relayBinding = binding(changed);
      const res = await app.inject({
        method: "POST",
        url: "/api/workstation-access/activate",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
        payload: { startupReceipt: receipt, binding: payload(changed) },
      });
      expect(res.statusCode).toBe(401);
      expect(responseBody(res).error).toBe("invalid_startup_receipt");
      expect(registry.get(OWNER_USER_ID)).toBeNull();
    }
  });

  test("still enforces current capability before accepting a receipt", async () => {
    const enrollment = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
      payload: { pin: OWNER_PIN, binding: payload() },
    });
    const receipt = responseBody(enrollment).startupReceipt;
    registry.disable(OWNER_USER_ID);
    userCaps.set(OWNER_USER_ID, []);

    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
      payload: { startupReceipt: receipt, binding: payload() },
    });
    expect(res.statusCode).toBe(403);
    expect(responseBody(res).error).toBe("capability_missing");
    expect(registry.get(OWNER_USER_ID)).toBeNull();
  });

  test("rejects a receipt replayed by another authenticated Human", async () => {
    const enrollment = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
      payload: { pin: OWNER_PIN, binding: payload() },
    });
    const receipt = responseBody(enrollment).startupReceipt;
    registry.disable(OWNER_USER_ID);
    userCaps.set(NO_CAP_USER_ID, ["use_workstation"]);
    relayBinding = binding({ userId: NO_CAP_USER_ID });

    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${nocapToken}` },
      payload: { startupReceipt: receipt, binding: payload() },
    });
    expect(res.statusCode).toBe(401);
    expect(responseBody(res).error).toBe("invalid_startup_receipt");
    expect(registry.get(NO_CAP_USER_ID)).toBeNull();
  });

  test("rejects forged or mixed PIN/receipt proofs before activation", async () => {
    const forged = "wsr1.eyJ2IjoxfQ.invalid";
    const mixed = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
      payload: { pin: OWNER_PIN, startupReceipt: forged, binding: payload() },
    });
    expect(mixed.statusCode).toBe(400);
    expect(responseBody(mixed).error).toBe("PIN and startupReceipt are mutually exclusive");

    const receiptOnly = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
      payload: { startupReceipt: forged, binding: payload() },
    });
    expect(receiptOnly.statusCode).toBe(401);
    expect(responseBody(receiptOnly).error).toBe("invalid_startup_receipt");
    expect(registry.get(OWNER_USER_ID)).toBeNull();
  });

  test("a client flag alone (no PIN) cannot activate", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: { binding: payload() },
    });
    expect(res.statusCode).toBe(400);
    expect(registry.get(OWNER_USER_ID)).toBeNull();
  });

  test("200 on a narrowing transition (higher revision, grant subset)", async () => {
    // First activate.
    await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: { pin: OWNER_PIN, binding: payload() },
    });
    // Now narrow: bump capabilityRevision + drop a grant, and move the
    // authoritative binding to match.
    relayBinding = binding({ grantIds: ["grant-1"], capabilityRevision: 11 });
    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: { pin: OWNER_PIN, binding: payload({ grantIds: ["grant-1"], capabilityRevision: 11 }) },
    });
    expect(res.statusCode).toBe(200);
    expect(responseBody(res).outcome).toBe("narrowed");
    expect(registry.get(OWNER_USER_ID)?.grantIds).toEqual(["grant-1"]);
  });

  test("409 on a duplicate activate", async () => {
    await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: { pin: OWNER_PIN, binding: payload() },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: { pin: OWNER_PIN, binding: payload() },
    });
    expect(res.statusCode).toBe(409);
    expect(responseBody(res).error).toBe("duplicate_active");
  });

  test("response carries no PIN or command output", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: { pin: OWNER_PIN, binding: payload() },
    });
    const body = responseBody(res);
    expect(body).not.toHaveProperty("pin");
    expect(body).not.toHaveProperty("commandOutput");
  });

  // =========================================================================
  // D418 default-instance — a canonical `instanceId: ""` (the default
  // unnamed instance) is a valid activation identity. It must activate
  // exactly like a named instance, stay exact-match-only (a named
  // authoritative binding does not match a default-instance payload), and
  // reject whitespace / noncanonical instance ids at body parsing.
  // =========================================================================

  test("D418 default-instance — 200 activation succeeds with instanceId: \"\"", async () => {
    relayBinding = binding({ instanceId: "" });
    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: { pin: OWNER_PIN, binding: payload({ instanceId: "" }) },
    });
    expect(res.statusCode).toBe(200);
    const body = responseBody(res);
    expect(body.ok).toBe(true);
    expect(body.outcome).toBe("activated");
    expect(registry.get(OWNER_USER_ID)?.instanceId).toBe("");
  });

  test("D418 default-instance — 400 when instanceId is whitespace-only (noncanonical)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: { pin: OWNER_PIN, binding: payload({ instanceId: " " }) },
    });
    expect(res.statusCode).toBe(400);
    expect(registry.get(OWNER_USER_ID)).toBeNull();
  });

  test("D418 default-instance — 400 when instanceId has surrounding whitespace (noncanonical)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: { pin: OWNER_PIN, binding: payload({ instanceId: "instance-1 " }) },
    });
    expect(res.statusCode).toBe(400);
    expect(registry.get(OWNER_USER_ID)).toBeNull();
  });

  test("D418 default-instance — 400 when instanceId is a noncanonical pattern (uppercase)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: { pin: OWNER_PIN, binding: payload({ instanceId: "Instance-1" }) },
    });
    expect(res.statusCode).toBe(400);
    expect(registry.get(OWNER_USER_ID)).toBeNull();
  });

  test("D418 default-instance — 409 when a default-instance payload hits a named authoritative binding (exact-match only)", async () => {
    relayBinding = binding({ instanceId: "instance-1" });
    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: { pin: OWNER_PIN, binding: payload({ instanceId: "" }) },
    });
    expect(res.statusCode).toBe(409);
    expect(responseBody(res).error).toBe("foreign_binding");
    expect(auditCalls.at(-1)?.denialCode).toBe("foreign_binding");
    expect(registry.get(OWNER_USER_ID)).toBeNull();
  });
});

// ===========================================================================
// D418 — POST /api/workstation-access/activate-profile
// (profile-selector activation seam)
// ===========================================================================

/** Client payload for /activate-profile: profile selectors + relay binding
 * evidence + PIN. No roots/env/executables/grants/subject/profile payload. */
function profileActivationBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pin: OWNER_PIN,
    profileId: "profile-1",
    profileRevision: 1,
    relayId: "relay-1",
    desktopSessionId: "desktop-session-1",
    instanceId: "instance-1",
    ...overrides,
  };
}

async function enrollProfileStartupReceipt(): Promise<string> {
  profileActivationBinding = binding({ capabilityRevision: 9 });
  relayBinding = binding({ capabilityRevision: 10 });
  const started = await app.inject({
    method: "POST",
    url: "/api/workstation-access/activate-profile",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ownerToken}`,
    },
    payload: profileActivationBody(),
  });
  if (started.statusCode !== 200) throw new Error("profile receipt enrollment did not start");
  const completed = await app.inject({
    method: "POST",
    url: "/api/workstation-access/activate-profile/complete",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ownerToken}`,
    },
    payload: { authorization: responseBody(started).authorization },
  });
  const receipt = responseBody(completed).startupReceipt;
  if (completed.statusCode !== 200 || typeof receipt !== "string") {
    throw new Error("profile receipt enrollment did not complete");
  }
  registry.disable(OWNER_USER_ID);
  return receipt;
}

describe("POST /api/workstation-access/activate-profile", () => {
  test("401 without a bearer session", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate-profile",
      headers: { "Content-Type": "application/json" },
      payload: profileActivationBody(),
    });
    expect(res.statusCode).toBe(401);
    expect(responseBody(res).error).toBe("Authentication required");
  });

  test("403 without use_workstation capability (no PIN burned)", async () => {
    // B3 (D418 Commit 1): activation requires ONLY use_workstation.
    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate-profile",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${nocapToken}`,
      },
      payload: profileActivationBody({ pin: "000000" }),
    });
    expect(res.statusCode).toBe(403);
    expect(responseBody(res).error).toBe("capability_missing");
    expect(res.json()).toHaveProperty("capability", "use_workstation");
    expect(auditCalls.some((e) => e.kind === "workstation_session_denied")).toBe(true);
  });

  test("403 with control_desktop but missing use_workstation (B3)", async () => {
    userCaps.set(OWNER_USER_ID, ["control_desktop"]);
    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate-profile",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: profileActivationBody(),
    });
    expect(res.statusCode).toBe(403);
    expect(responseBody(res).error).toBe("capability_missing");
    expect(res.json()).toHaveProperty("capability", "use_workstation");
    expect(registry.get(OWNER_USER_ID)).toBeNull();
  });

  test("200 phase one succeeds with use_workstation but WITHOUT control_desktop (B3)", async () => {
    // B3 (D418 Commit 1): control_desktop is no longer required for
    // activation. A user holding ONLY use_workstation issues a
    // pending authorization.
    userCaps.set(OWNER_USER_ID, ["use_workstation"]);
    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate-profile",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: profileActivationBody({ profileId: "profile-7", profileRevision: 3 }),
    });
    expect(res.statusCode).toBe(200);
    expect(responseBody(res).ok).toBe(true);
    expect(responseBody(res).authorization).toBeString();
    expect(registry.get(OWNER_USER_ID)).toBeNull();
  });

  test("400 when profileId is missing (before PIN verification)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate-profile",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: profileActivationBody({ profileId: undefined }),
    });
    expect(res.statusCode).toBe(400);
    expect(responseBody(res).error).toBe("profileId is required");
  });

  test("400 when profileRevision is not a positive safe integer", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate-profile",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: profileActivationBody({ profileRevision: 0 }),
    });
    expect(res.statusCode).toBe(400);
  });

  test("400 when relay binding evidence is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate-profile",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: profileActivationBody({ relayId: "" }),
    });
    expect(res.statusCode).toBe(400);
  });

  test("400 when PIN and startup receipt are both missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate-profile",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: profileActivationBody({ pin: undefined }),
    });
    expect(res.statusCode).toBe(400);
    expect(responseBody(res).error).toBe("PIN or startupReceipt is required");
  });

  test("404 when the profile activation provider resolves no binding (wrong user / relay / desktop session)", async () => {
    profileActivationBinding = null;
    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate-profile",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: profileActivationBody(),
    });
    expect(res.statusCode).toBe(404);
    expect(responseBody(res).error).toBe("relay_binding_unavailable");
    expect(auditCalls.at(-1)?.denialCode).toBe("ineligible_binding");
    expect(auditCalls.at(-1)?.route).toBe("POST /api/workstation-access/activate-profile");
  });

  test("401 on an invalid PIN (after capability + payload shape pass)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate-profile",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: profileActivationBody({ pin: "wrong-pin" }),
    });
    expect(res.statusCode).toBe(401);
    expect(responseBody(res).error).toBe("Invalid PIN");
    expect(registry.get(OWNER_USER_ID)).toBeNull();
  });

  test("429 when the challenge provider throws a LockoutError", async () => {
    pinProvider.lockNext(OWNER_USER_ID, 30_000);
    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate-profile",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: profileActivationBody(),
    });
    expect(res.statusCode).toBe(429);
    expect(responseBody(res).retryAfterMs).toBe(30_000);
  });

  test("200 phase one issues an opaque authorization without creating a session", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate-profile",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: profileActivationBody({ profileId: "profile-7", profileRevision: 3 }),
    });
    expect(res.statusCode).toBe(200);
    const body = responseBody(res);
    expect(body.ok).toBe(true);
    expect(body.authorization).toBeString();
    expect(registry.get(OWNER_USER_ID)).toBeNull();
    expect(auditCalls.some((e) => e.kind === "workstation_session_activated")).toBe(false);
  });

  test("mints the startup receipt only after the own-PIN profile activation completes", async () => {
    profileActivationBinding = binding({ capabilityRevision: 9 });
    relayBinding = binding({ capabilityRevision: 10 });

    const started = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate-profile",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: profileActivationBody(),
    });
    expect(started.statusCode).toBe(200);
    expect(responseBody(started).startupReceipt).toBeUndefined();

    const completed = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate-profile/complete",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: { authorization: responseBody(started).authorization },
    });
    expect(completed.statusCode).toBe(200);
    const receipt = responseBody(completed).startupReceipt;
    expect(verifyWorkstationStartupReceipt(STARTUP_RECEIPT_SECRET, receipt)).toEqual({
      userId: OWNER_USER_ID,
      instanceId: "instance-1",
      serverBindingId: "server-binding-1",
      pairingGeneration: "pairing-1",
      profileId: "profile-1",
      profileRevision: 1,
    });
    expect(auditCalls.every((event) => !Object.values(event).includes(receipt))).toBe(true);
  });

  test("does not mint a startup receipt when profile completion fails", async () => {
    profileActivationBinding = binding({ capabilityRevision: 10 });
    relayBinding = binding({ capabilityRevision: 10 });

    const started = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate-profile",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: profileActivationBody(),
    });
    const completed = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate-profile/complete",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: { authorization: responseBody(started).authorization },
    });
    expect(completed.statusCode).toBe(409);
    expect(responseBody(completed).startupReceipt).toBeUndefined();
    expect(registry.get(OWNER_USER_ID)).toBeNull();
  });

  test("requires exactly one PIN or startup-receipt proof", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate-profile",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: profileActivationBody({ startupReceipt: "opaque-receipt" }),
    });
    expect(res.statusCode).toBe(400);
    expect(responseBody(res).error).toBe("PIN and startupReceipt are mutually exclusive");
    expect(registry.get(OWNER_USER_ID)).toBeNull();
  });

  test("uses a valid startup receipt for the same two-phase profile activation", async () => {
    const receipt = await enrollProfileStartupReceipt();
    const nextDesktopSessionId = "desktop-session-next";
    profileActivationBinding = binding({
      desktopSessionId: nextDesktopSessionId,
      capabilityRevision: 10,
    });

    const started = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate-profile",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: profileActivationBody({
        pin: undefined,
        startupReceipt: receipt,
        desktopSessionId: nextDesktopSessionId,
      }),
    });
    expect(started.statusCode).toBe(200);
    expect(responseBody(started).authorization).toBeString();
    expect(registry.get(OWNER_USER_ID)).toBeNull();

    relayBinding = binding({
      desktopSessionId: nextDesktopSessionId,
      capabilityRevision: 11,
    });
    const completed = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate-profile/complete",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: { authorization: responseBody(started).authorization },
    });
    expect(completed.statusCode).toBe(200);
    expect(registry.get(OWNER_USER_ID)?.desktopSessionId).toBe(nextDesktopSessionId);
    expect(responseBody(completed).startupReceipt).toBe(receipt);
  });

  test("rejects profile startup-receipt replay across Human and binding drift", async () => {
    const receipt = await enrollProfileStartupReceipt();
    const scenarios = [
      {
        token: ownerToken,
        authoritative: binding({ instanceId: "instance-2" }),
        body: { instanceId: "instance-2" },
      },
      {
        token: ownerToken,
        authoritative: binding({ serverBindingId: "server-binding-2" }),
        body: {},
      },
      {
        token: ownerToken,
        authoritative: binding({ pairingGeneration: "pairing-2" }),
        body: {},
      },
      {
        token: ownerToken,
        authoritative: binding(),
        body: { profileId: "profile-2" },
      },
      {
        token: ownerToken,
        authoritative: binding(),
        body: { profileRevision: 2 },
      },
      {
        token: nocapToken,
        authoritative: binding({ userId: NO_CAP_USER_ID }),
        body: {},
        userId: NO_CAP_USER_ID,
      },
    ] as const;

    for (const scenario of scenarios) {
      if ("userId" in scenario) {
        userCaps.set(scenario.userId, ["use_workstation"]);
      }
      profileActivationBinding = scenario.authoritative;
      const res = await app.inject({
        method: "POST",
        url: "/api/workstation-access/activate-profile",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${scenario.token}`,
        },
        payload: profileActivationBody({
          pin: undefined,
          startupReceipt: receipt,
          ...scenario.body,
        }),
      });
      expect(res.statusCode).toBe(401);
      expect(responseBody(res).error).toBe("invalid_startup_receipt");
      expect(responseBody(res).authorization).toBeUndefined();
    }
  });

  test("rejects a profile startup receipt after capability revocation", async () => {
    const receipt = await enrollProfileStartupReceipt();
    userCaps.set(OWNER_USER_ID, []);
    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate-profile",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: profileActivationBody({ pin: undefined, startupReceipt: receipt }),
    });
    expect(res.statusCode).toBe(403);
    expect(responseBody(res).error).toBe("capability_missing");
    expect(responseBody(res).authorization).toBeUndefined();
  });

  test("a client flag alone (no PIN) cannot activate", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate-profile",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: profileActivationBody({ pin: undefined }),
    });
    expect(res.statusCode).toBe(400);
    expect(registry.get(OWNER_USER_ID)).toBeNull();
  });

  test("phase one tickets are distinct and do not create sessions", async () => {
    await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate-profile",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: profileActivationBody(),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate-profile",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: profileActivationBody(),
    });
    expect(res.statusCode).toBe(200);
    expect(registry.get(OWNER_USER_ID)).toBeNull();
  });

  test("response carries no PIN or command output", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate-profile",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: profileActivationBody(),
    });
    const body = responseBody(res);
    expect(body).not.toHaveProperty("pin");
    expect(body).not.toHaveProperty("commandOutput");
  });

  // =========================================================================
  // D418 default-instance — a canonical `instanceId: ""` (the default
  // unnamed instance) is a valid profile-selector activation identity, and
  // whitespace / noncanonical instance ids are rejected at body parsing.
  // =========================================================================

  test("D418 default-instance — 200 phase one succeeds with instanceId: \"\"", async () => {
    profileActivationBinding = binding({ instanceId: "" });
    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate-profile",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: profileActivationBody({ instanceId: "" }),
    });
    expect(res.statusCode).toBe(200);
    const body = responseBody(res);
    expect(body.ok).toBe(true);
    expect(body.authorization).toBeString();
    expect(registry.get(OWNER_USER_ID)).toBeNull();
  });

  test("D418 default-instance — 400 when instanceId is whitespace-only (noncanonical)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate-profile",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: profileActivationBody({ instanceId: " " }),
    });
    expect(res.statusCode).toBe(400);
    expect(registry.get(OWNER_USER_ID)).toBeNull();
  });

  test("D418 default-instance — 400 when instanceId has surrounding whitespace (noncanonical)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate-profile",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: profileActivationBody({ instanceId: "instance-1 " }),
    });
    expect(res.statusCode).toBe(400);
    expect(registry.get(OWNER_USER_ID)).toBeNull();
  });
});

describe("POST /api/workstation-access/disable", () => {
  test("401 without a bearer session", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/disable",
      headers: { "Content-Type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  test("B3: disable is capability-independent — 200 not_active with NO capabilities", async () => {
    // B3 (D418 Commit 1): disable is authenticated + user-bound + idempotent
    // + independent of all current capabilities. The no-cap user (who holds
    // neither control_desktop nor use_workstation) can still disable
    // their own session. With no active session it returns not_active.
    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/disable",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${nocapToken}`,
      },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(responseBody(res).ok).toBe(true);
    expect(responseBody(res).outcome).toBe("not_active");
  });

  test("B3: disable succeeds even with control_desktop but missing use_workstation", async () => {
    // B3 (D418 Commit 1): no capability gate on disable. A user holding only
    // control_desktop (no use_workstation) can still disable.
    userCaps.set(OWNER_USER_ID, ["control_desktop"]);
    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/disable",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(responseBody(res).ok).toBe(true);
    expect(responseBody(res).outcome).toBe("not_active");
  });

  test("is idempotent — disabling with no active session returns not_active, no PIN required", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/disable",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(responseBody(res).outcome).toBe("not_active");
  });

  test("disables an active session (user-bound)", async () => {
    // Activate first.
    await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: { pin: OWNER_PIN, binding: payload() },
    });
    expect(registry.get(OWNER_USER_ID)).not.toBeNull();
    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/disable",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(responseBody(res).outcome).toBe("disabled");
    expect(registry.get(OWNER_USER_ID)).toBeNull();
    expect(auditCalls.some((e) => e.kind === "workstation_session_disabled")).toBe(true);
  });

  test("B3: disables an active session even after use_workstation is revoked mid-session", async () => {
    // Activate first (requires use_workstation).
    await app.inject({
      method: "POST",
      url: "/api/workstation-access/activate",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: { pin: OWNER_PIN, binding: payload() },
    });
    expect(registry.get(OWNER_USER_ID)).not.toBeNull();
    // Mid-session: revoke ALL capabilities (e.g. an admin dropped the user
    // from every role). B3 (D418 Commit 1): disable is capability-independent,
    // so the user can still tear down their own session.
    userCaps.set(OWNER_USER_ID, []);
    const res = await app.inject({
      method: "POST",
      url: "/api/workstation-access/disable",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerToken}`,
      },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(responseBody(res).outcome).toBe("disabled");
    expect(registry.get(OWNER_USER_ID)).toBeNull();
    expect(auditCalls.some((e) => e.kind === "workstation_session_disabled")).toBe(true);
  });
});

// ===========================================================================
// D418 Commit 3 — createWorkstationApprovalOverrideResolver
// (post-model resolver factory wired by app.ts into defaultPostModelDeps).
//
// The factory binds the live `InMemoryWorkstationSessionRegistry` +
// `InMemoryRelayRegistry` + `InMemoryWorkstationDispatchPlanRegistry` and
// returns the function the post-model consults in Pass 2. It does TWO things
// per dispatch:
//   1. ADMISSION (task 3.1.2): when an active session exists, select the
//      exact active-session-bound relay, re-validate it against the live
//      relay registry, and admit ONE transient `WorkstationDispatchPlan`
//      keyed by tool-call id binding the exact binding tuple + execution
//      class. The tools node consumes that plan to pin the relay.
//   2. DECISION (Commit 4): forward the slim execution-admission contract
//      (`executionClass + activeSession + exactPlan + tool/operation
//      identity`) to the pure `resolveWorkstationAdmission` policy. An exact
//      profile_bound_sandbox `run_shell` or typed-broker Git attempt returns
//      auto; Electron-local
//      binding/sandbox/grant/path/OS enforcement remains fail-closed at
//      execution and is not a server-confirmed admission input.
//
// These tests pin:
//   - the decision reasons (no active session / no exact plan / run_shell
//     required / independent critical-elevation scan refusal):
//     `no_active_session`, `no_admitted_plan`,
//     `run_shell_required`, `critical_or_elevation_command`);
//   - the live-registry read and Electron-local enforcement boundary;
//   - the ADMISSION contract: relay A selected at admission, coherent
//     monotonic capability refresh, stale profile/binding rejection, no session ⇒ no plan, and no
//     client Auto-Approve bypass (a plan is admitted ONLY from the live
//     server-side session, never from tool-args flags);
//   - the execution-class classifier mapping the post-model tool names.
// The eligible-`auto` decision path (session + exact plan + containment
// confirmed) is covered by `packages/trust/tests/unit/workstation-admission.test.ts`
// (pure engine) and by `packages/agent/tests/unit/post-model.test.ts` (stub
// resolver). The tools-node relay pinning + `allowedRoots` non-widening is
// covered by `packages/agent/tests/unit/workstation-dispatch-plan.test.ts`.
// ===========================================================================

/** Activate a live session directly through the shared registry instance. */
function activateLiveSession(overrides: Partial<FullWorkstationBinding> = {}): void {
  const b = binding(overrides);
  const result = registry.activate(b, b);
  if (!result.ok) throw new Error(`registry.activate failed: ${result.denialCode}`);
}

/**
 * D418 Commit 4 — build an override request for a `run_shell` tool call
 * carrying a specific command string. The independent slim scan reads this
 * command only to refuse critical / elevation; benign + medium commands can
 * admit `auto` without asserting Electron-local containment.
 */
function runShellOverrideRequest(
  command: string,
  toolCallId = "tc-1",
): WorkstationOverrideResolverRequest {
  const toolCall: ToolCall = {
    name: "run_shell",
    args: { command },
    id: toolCallId,
  } as ToolCall;
  return {
    userId: OWNER_USER_ID,
    toolCall,
    actorId: OWNER_ACTOR_ID,
    roomId: "",
    currentFolder: "/tmp",
    workspacePath: "/tmp",
  };
}

describe("createWorkstationApprovalOverrideResolver — admission decision (Commit 4)", () => {
  beforeEach(() => {
    registry.disable(OWNER_USER_ID);
  });

  test("no active session ⇒ none (no_active_session), no throw", () => {
    registerBoundRelay();
    const resolver = createWorkstationApprovalOverrideResolver({
      registry,
      relayRegistry,
      planRegistry,
    });
    const d = resolver(overrideRequest("run_shell"));
    expect(d.override).toBe("none");
    if (d.override !== "none") throw new Error("unreachable");
    expect(d.reason).toBe("no_active_session");
    expect(d.executionClass).toBe("profile_bound_sandbox");
  });

  test("active session + exact plan + benign run_shell ⇒ auto (admission only)", () => {
    activateLiveSession();
    registerBoundRelay();
    const resolver = createWorkstationApprovalOverrideResolver({
      registry,
      relayRegistry,
      planRegistry,
    });
    const d = resolver(runShellOverrideRequest("ls -la", "tc-benign"));
    expect(d.override).toBe("auto");
    if (d.override !== "auto") throw new Error("unreachable");
    expect(d.executionClass).toBe("profile_bound_sandbox");
  });

  test("explicit real workstation run_shell auto-admits only to Electron local consent and creates no profile plan", () => {
    activateLiveSession();
    registerBoundRelay();
    const resolver = createWorkstationApprovalOverrideResolver({
      registry,
      relayRegistry,
      planRegistry,
    });
    const request = runShellOverrideRequest("gh auth status", "tc-real-workstation");
    const d = resolver({
      ...request,
      toolCall: {
        ...request.toolCall,
        args: { command: "gh auth status", execution: "workstation" },
      } as ToolCall,
    });
    expect(d.override).toBe("auto");
    expect(d.executionClass).toBe("real_workstation");
    expect(planRegistry.get("tc-real-workstation")).toBeNull();
  });

  test("explicit real workstation elevation retains normal approval", () => {
    const resolver = createWorkstationApprovalOverrideResolver({
      registry,
      relayRegistry,
      planRegistry,
    });
    const request = runShellOverrideRequest("sudo gh auth status", "tc-real-elevation");
    const d = resolver({
      ...request,
      toolCall: {
        ...request.toolCall,
        args: { command: "sudo gh auth status", execution: "workstation" },
      } as ToolCall,
    });
    expect(d.override).toBe("none");
    if (d.override !== "none") throw new Error("unreachable");
    expect(d.reason).toBe("critical_or_elevation_command");
  });

  test("active session + exact plan + empty-command run_shell ⇒ auto (no scan refusal)", () => {
    // No command content ⇒ the static scan matches nothing. Admission does
    // not gate on command presence; execution handles an empty command. The
    // scan only REFUSES critical/elevation and never confirms containment.
    activateLiveSession();
    registerBoundRelay();
    const resolver = createWorkstationApprovalOverrideResolver({
      registry,
      relayRegistry,
      planRegistry,
    });
    const d = resolver(overrideRequest("run_shell"));
    expect(d.override).toBe("auto");
  });

  test("active session + exact plan + medium-severity run_shell ⇒ auto (not critical/elevation)", () => {
    // `npm install react` is medium severity (supply-chain) — NOT critical/
    // elevation, so the independent scan does not refuse the attempt.
    activateLiveSession();
    registerBoundRelay();
    const resolver = createWorkstationApprovalOverrideResolver({
      registry,
      relayRegistry,
      planRegistry,
    });
    const d = resolver(runShellOverrideRequest("npm install react", "tc-medium"));
    expect(d.override).toBe("auto");
  });

  test("active session + exact plan + critical run_shell ⇒ none (critical_or_elevation_command)", () => {
    // `rm -rf /` is critical severity — the independent scan refuses the
    // attempt; it does not make any containment claim.
    activateLiveSession();
    registerBoundRelay();
    const resolver = createWorkstationApprovalOverrideResolver({
      registry,
      relayRegistry,
      planRegistry,
    });
    const d = resolver(runShellOverrideRequest("rm -rf /", "tc-critical"));
    expect(d.override).toBe("none");
    if (d.override !== "none") throw new Error("unreachable");
    expect(d.reason).toBe("critical_or_elevation_command");
  });

  test("active session + exact plan + elevation run_shell (sudo) ⇒ none (critical_or_elevation_command)", () => {
    // `sudo apt update` is high severity (elevation) — the independent scan
    // refuses the attempt without claiming containment.
    activateLiveSession();
    registerBoundRelay();
    const resolver = createWorkstationApprovalOverrideResolver({
      registry,
      relayRegistry,
      planRegistry,
    });
    const d = resolver(runShellOverrideRequest("sudo apt update", "tc-elevation"));
    expect(d.override).toBe("none");
    if (d.override !== "none") throw new Error("unreachable");
    expect(d.reason).toBe("critical_or_elevation_command");
  });

  test("active session survives a coherent forward capability refresh without manual reactivation", () => {
    activateLiveSession(); // session capabilityRevision = 10
    registerBoundRelay({ capabilityRevision: 11 }); // same authority, refreshed capabilities
    const resolver = createWorkstationApprovalOverrideResolver({
      registry,
      relayRegistry,
      planRegistry,
    });
    const d = resolver(overrideRequest("run_shell"));
    expect(d.override).toBe("auto");
    expect(planRegistry.get("tc-1")?.capabilityRevision).toBe(11);
  });

  test("active session rejects a capability revision rollback", () => {
    activateLiveSession(); // session capabilityRevision = 10
    registerBoundRelay({ capabilityRevision: 9 });
    const resolver = createWorkstationApprovalOverrideResolver({
      registry,
      relayRegistry,
      planRegistry,
    });
    const d = resolver(overrideRequest("run_shell"));
    expect(d.override).toBe("none");
    if (d.override !== "none") throw new Error("unreachable");
    expect(d.reason).toBe("no_admitted_plan");
  });

  test("active session but bound relay gone ⇒ none (no_admitted_plan)", () => {
    activateLiveSession({ relayId: "relay-gone" });
    // relay-gone is not registered — the bound relay is disconnected.
    const resolver = createWorkstationApprovalOverrideResolver({
      registry,
      relayRegistry,
      planRegistry,
    });
    const d = resolver(overrideRequest("run_shell"));
    expect(d.override).toBe("none");
    if (d.override !== "none") throw new Error("unreachable");
    expect(d.reason).toBe("no_admitted_plan");
  });

  test("the decision reflects LIVE registry state: auto while active, none (no_active_session) after disable", () => {
    activateLiveSession();
    registerBoundRelay();
    const resolver = createWorkstationApprovalOverrideResolver({
      registry,
      relayRegistry,
      planRegistry,
    });
    expect(resolver(overrideRequest("run_shell")).override).toBe("auto");
    registry.disable(OWNER_USER_ID);
    const d = resolver(overrideRequest("run_shell"));
    expect(d.override).toBe("none");
    if (d.override !== "none") throw new Error("unreachable");
    expect(d.reason).toBe("no_active_session");
  });
});

// ===========================================================================
// D418 task 3.1.2 / 3.2.5 — createWorkstationApprovalOverrideResolver
// (post-model resolver factory wired by app.ts into defaultPostModelDeps).
//
// The factory binds the live `InMemoryWorkstationSessionRegistry` +
// `InMemoryRelayRegistry` + `InMemoryWorkstationDispatchPlanRegistry` and
// returns the function the post-model consults in Pass 2. It does TWO things
// per dispatch:
//   1. ADMISSION (task 3.1.2): when an active session exists, select the
//      exact active-session-bound relay, re-validate it against the live
//      relay registry, and admit ONE transient `WorkstationDispatchPlan`
//      keyed by tool-call id binding the exact binding tuple + operation
//      class. The tools node consumes that plan to pin the relay.
//   2. DECISION (task 3.2.5): forward the full evidence bundle to the pure
//      policy. In THIS slice the decision is fail-closed `none` for every
//      dispatch (the per-dispatch side-evidence pipeline is a follow-up), so
//      normal approval semantics are unchanged.
//
// These tests pin:
//   - the fail-closed DECISION (never `auto`, never throws, `none` for both
//     no-session and active-session);
//   - the live-registry read (an active session does not throw + still
//     resolves `none` because local containment is fail-closed);
//   - the ADMISSION contract: relay A selected at admission, stale
//     profile/capability binding rejection, no session ⇒ no plan, and no
//     client Auto-Approve bypass (a plan is admitted ONLY from the live
//     server-side session, never from tool-args flags);
//   - the execution-class classifier mapping the post-model tool names.
// The eligible-`auto` decision path (session + exact plan + containment
// confirmed) is covered by `packages/trust/tests/unit/workstation-admission.test.ts`
// (pure engine) and by `packages/agent/tests/unit/post-model.test.ts` (stub
// resolver). The tools-node relay pinning + `allowedRoots` non-widening is
// covered by `packages/agent/tests/unit/workstation-dispatch-plan.test.ts`.
// ===========================================================================

function overrideRequest(
  toolName: string,
  toolCallId = "tc-1",
  args: Record<string, unknown> = {},
): WorkstationOverrideResolverRequest {
  const toolCall: ToolCall = {
    name: toolName,
    args,
    id: toolCallId,
  } as ToolCall;
  return {
    userId: OWNER_USER_ID,
    toolCall,
    actorId: OWNER_ACTOR_ID,
    roomId: "",
    currentFolder: "/tmp",
    workspacePath: "/tmp",
  };
}

/**
 * D418 task 3.1.2 — register a connected relay into the live
 * `relayRegistry` with a binding fingerprint matching the default session
 * binding (relay-1 / desktop-session-1 / capabilityRevision 10 /
 * profile-1@1). Per-test overrides drift a field to exercise stale-binding
 * rejection. The relay advertises a valid Workstation Profile binding
 * snapshot so `getWorkstationProfileSnapshot` returns profileId +
 * profileRevision for the admission re-validation.
 */
function registerBoundRelay(overrides: {
  relayId?: string;
  userId?: string;
  desktopSessionId?: string;
  capabilityRevision?: number;
  profileId?: string;
  profileRevision?: number;
  pairingGeneration?: string;
  grantIds?: readonly string[];
  grantRoots?: readonly string[];
} = {}): void {
  const relayId = overrides.relayId ?? "relay-1";
  const userId = overrides.userId ?? OWNER_USER_ID;
  const desktopSessionId = overrides.desktopSessionId ?? "desktop-session-1";
  const capabilityRevision = overrides.capabilityRevision ?? 10;
  const profileId = overrides.profileId ?? "profile-1";
  const profileRevision = overrides.profileRevision ?? 1;
  const pairingGeneration = overrides.pairingGeneration ?? "pairing-1";
  const grantIds = overrides.grantIds ?? ["grant-1", "grant-2"];
  const grantRoots = overrides.grantRoots ?? grantIds.map(() => "/tmp");
  const caps = {
    profile: "desktop-agent",
    canRunShell: true,
    allowedRoots: ["/tmp"],
    workstationProfileSnapshot: {
      profileId,
      profileRevision,
      grantIds,
      protectedPolicyVersion: 1,
      networkMode: "isolated",
      capabilities: [],
    },
    desktopFilesystemGrantSnapshot: {
      revision: 8,
      instanceId: "instance-1",
      agentScope: "all_owned_agents",
      grants: grantIds.map((id, index) => ({
        id,
        canonicalRoot: grantRoots[index] ?? "/tmp",
        access: ["read", "execute"],
        policyVersion: 1,
        lifetime: "durable",
      })),
    },
  } as unknown as RelayCapabilities;
  // `register` is sync-resolved (it sets the entry then returns
  // Promise.resolve()), so the entry is live by the time this returns.
  void relayRegistry.register(
    relayId,
    userId,
    caps,
    () => {},
    9,
    desktopSessionId,
    capabilityRevision,
    pairingGeneration,
  );
}

describe("resolveActiveWorkstationDispatchBinding — D498 server admission boundary", () => {
  beforeEach(() => {
    registry.disable(OWNER_USER_ID);
  });

  test("admits a Current Folder covered by a parent durable grant without an exact duplicate", () => {
    activateLiveSession();
    registerBoundRelay({ grantRoots: ["/Projects", "/Tools"] });

    const result = resolveActiveWorkstationDispatchBinding({
      userId: OWNER_USER_ID,
      currentFolder: "/Projects/nautilo",
      sessionRegistry: registry,
      relayRegistry,
    });

    expect(result).not.toBeNull();
    expect(result?.grantIds).toEqual(["grant-1", "grant-2"]);
  });

  test("admits a coherent active zero-grant session without inventing filesystem authority", () => {
    const zeroGrantSession = {
      ...binding({ grantIds: [] }),
      activatedAt: FIXED_TS,
    };
    const zeroGrantRegistry = {
      get: (userId: string) => (userId === OWNER_USER_ID ? zeroGrantSession : null),
    } as unknown as InMemoryWorkstationSessionRegistry;
    registerBoundRelay({ grantIds: [] });

    const zeroGrantPlans = new InMemoryWorkstationDispatchPlanRegistry({
      now: clock,
      getActiveBinding: ({ userId, currentFolder }) =>
        resolveActiveWorkstationDispatchBinding({
          userId,
          currentFolder,
          sessionRegistry: zeroGrantRegistry,
          relayRegistry,
        }),
    });
    const result = zeroGrantPlans.readmit({
      toolCallId: "tc-zero-grant",
      userId: OWNER_USER_ID,
      currentFolder: "/Projects/nautilo",
      executionClass: "typed_broker",
      fingerprint: {
        userId: OWNER_USER_ID,
        desktopSessionId: "desktop-session-1",
        capabilityRevision: 10,
        profileId: "profile-1",
        profileRevision: 1,
        pairingGeneration: "pairing-1",
        grantRevision: 8,
        protectedPolicyVersion: 1,
      },
    });

    // This is server admission metadata only. Electron still verifies the
    // selected folder's identity, operation posture, and protected-path policy.
    expect(result).not.toBeNull();
    expect(result?.grantIds).toEqual([]);
  });
});

/**
 * Register a second eligible relay (relay-B) for the same user, with its own
 * binding fingerprint. Used to prove the plan pins the SESSION's relay
 * (relay-A), not whichever relay is registered / eligible.
 */
function registerRelayB(): void {
  registerBoundRelay({
    relayId: "relay-B",
    desktopSessionId: "desktop-B",
    capabilityRevision: 20,
    profileId: "profile-B",
    profileRevision: 1,
  });
}

describe("createWorkstationApprovalOverrideResolver — admission decision by tool (Commit 4)", () => {
  beforeEach(() => {
    registry.disable(OWNER_USER_ID);
  });

  test("returns a function assignable to the post-model resolver seam", () => {
    const resolver = createWorkstationApprovalOverrideResolver({
      registry,
      relayRegistry,
      planRegistry,
    });
    expect(typeof resolver).toBe("function");
  });

  test("no active session ⇒ none (fail-closed, no throw)", () => {
    const resolver = createWorkstationApprovalOverrideResolver({
      registry,
      relayRegistry,
      planRegistry,
    });
    const decision = resolver(overrideRequest("run_shell"));
    expect(decision.override).toBe("none");
  });

  test("active session + run_shell ⇒ auto (admission does not claim containment)", () => {
    activateLiveSession();
    registerBoundRelay();
    const resolver = createWorkstationApprovalOverrideResolver({
      registry,
      relayRegistry,
      planRegistry,
    });
    const decision = resolver(overrideRequest("run_shell"));
    // The live session + exact plan + profile-bound run_shell ⇒ the pure
    // policy returns `auto`; Electron-local enforcement remains authoritative.
    expect(decision.override).toBe("auto");
  });

  test("non-run_shell tools stay none (run_shell-only admission slice)", () => {
    activateLiveSession();
    registerBoundRelay();
    const resolver = createWorkstationApprovalOverrideResolver({
      registry,
      relayRegistry,
      planRegistry,
    });
    // file / run_web_search / manage_local_mcp / unknown are profile_bound_
    // sandbox dispatches, but this B4 auto-admission slice is run_shell only;
    // their auto-admission is a follow-up.
    for (const toolName of ["file", "run_web_search", "manage_local_mcp", "unknown_tool"]) {
      const decision = resolver(overrideRequest(toolName));
      expect(decision.override).toBe("none");
      if (decision.override !== "none") throw new Error("unreachable");
      expect(decision.reason).toBe("run_shell_required");
    }
  });

  test("does not mutate the session registry (pure read)", () => {
    activateLiveSession();
    registerBoundRelay();
    const before = registry.get(OWNER_USER_ID);
    const resolver = createWorkstationApprovalOverrideResolver({
      registry,
      relayRegistry,
      planRegistry,
    });
    resolver(overrideRequest("run_shell"));
    const after = registry.get(OWNER_USER_ID);
    expect(after).toEqual(before);
  });
});

describe("createWorkstationApprovalOverrideResolver — plan ADMISSION (D418 task 3.1.2)", () => {
  beforeEach(() => {
    registry.disable(OWNER_USER_ID);
  });

  test("relay A selected at admission: active session bound to relay-A ⇒ plan pins relay-A", () => {
    // Activate a session bound to relay-A (NOT the default relay-1) so the
    // admission selects relay-A specifically, not whichever relay happens to
    // be registered first.
    activateLiveSession({ relayId: "relay-A", desktopSessionId: "desktop-A" });
    registerBoundRelay({
      relayId: "relay-A",
      desktopSessionId: "desktop-A",
    });
    // relay-B is also connected + eligible, but the session binds relay-A.
    registerRelayB();
    const resolver = createWorkstationApprovalOverrideResolver({
      registry,
      relayRegistry,
      planRegistry,
      now: clock,
    });
    resolver(overrideRequest("run_shell", "tc-A"));

    const plan = planRegistry.get("tc-A");
    expect(plan).not.toBeNull();
    if (!plan) return;
    expect(plan.relayId).toBe("relay-A");
    expect(plan.userId).toBe(OWNER_USER_ID);
    expect(plan.desktopSessionId).toBe("desktop-A");
    expect(plan.toolCallId).toBe("tc-A");
    expect(plan.executionClass).toBe("profile_bound_sandbox");
    expect(plan.capabilityRevision).toBe(10);
    expect(plan.profileId).toBe("profile-1");
    expect(plan.profileRevision).toBe(1);
    // The plan binds the exact session tuple — never relay-B.
    expect(plan.relayId).not.toBe("relay-B");
  });

  test("plan binds the exact session tuple (instance / server binding / grant ids / revisions)", () => {
    activateLiveSession();
    registerBoundRelay();
    const resolver = createWorkstationApprovalOverrideResolver({
      registry,
      relayRegistry,
      planRegistry,
      now: clock,
    });
    resolver(overrideRequest("file", "tc-exact"));

    const plan = planRegistry.get("tc-exact");
    expect(plan).not.toBeNull();
    if (!plan) return;
    const session = registry.get(OWNER_USER_ID);
    expect(session).not.toBeNull();
    if (!session) return;
    expect(plan.instanceId).toBe(session.instanceId);
    expect(plan.serverBindingId).toBe(session.serverBindingId);
    expect(plan.profileId).toBe(session.profileId);
    expect(plan.profileRevision).toBe(session.profileRevision);
    expect(plan.grantIds).toEqual([...session.grantIds]);
    expect(plan.capabilityRevision).toBe(session.capabilityRevision);
    expect(plan.executionClass).toBe("profile_bound_sandbox");
    expect(plan.admittedAt).toBe(FIXED_TS);
  });

  test("structured run_shell.git admits a typed_broker plan bound to the active session", () => {
    activateLiveSession();
    registerBoundRelay();
    const resolver = createWorkstationApprovalOverrideResolver({
      registry,
      relayRegistry,
      planRegistry,
      now: clock,
    });

    const decision = resolver(
      overrideRequest("run_shell", "tc-git", { git: { operation: "status" } }),
    );

    expect(decision).toEqual({ override: "auto", executionClass: "typed_broker" });
    const plan = planRegistry.get("tc-git");
    expect(plan).not.toBeNull();
    expect(plan?.executionClass).toBe("typed_broker");
    expect(plan?.relayId).toBe("relay-1");
    expect(plan?.currentFolder).toBe("/tmp");
  });

  test("forward capability refresh at admission stamps the current live revision", () => {
    activateLiveSession(); // session capabilityRevision = 10
    // A folder/capability refresh may advance the relay revision while the
    // Human/Desktop/profile/grant tuple remains the same.
    registerBoundRelay({ capabilityRevision: 11 });
    const resolver = createWorkstationApprovalOverrideResolver({
      registry,
      relayRegistry,
      planRegistry,
      now: clock,
    });
    resolver(overrideRequest("run_shell", "tc-stale-cap"));

    expect(planRegistry.get("tc-stale-cap")?.capabilityRevision).toBe(11);
  });

  test("capability rollback at admission ⇒ NO plan admitted (fail-closed)", () => {
    activateLiveSession(); // session capabilityRevision = 10
    registerBoundRelay({ capabilityRevision: 9 });
    const resolver = createWorkstationApprovalOverrideResolver({
      registry,
      relayRegistry,
      planRegistry,
      now: clock,
    });
    resolver(overrideRequest("run_shell", "tc-cap-rollback"));

    expect(planRegistry.get("tc-cap-rollback")).toBeNull();
  });

  test("stale profile binding at admission ⇒ NO plan admitted (fail-closed)", () => {
    activateLiveSession(); // session profileRevision = 1
    registerBoundRelay({ profileRevision: 2 });
    const resolver = createWorkstationApprovalOverrideResolver({
      registry,
      relayRegistry,
      planRegistry,
      now: clock,
    });
    resolver(overrideRequest("run_shell", "tc-stale-profile"));

    expect(planRegistry.get("tc-stale-profile")).toBeNull();
  });

  test("bound relay gone (not connected) at admission ⇒ NO plan admitted", () => {
    activateLiveSession({ relayId: "relay-gone" });
    // Do NOT register relay-gone — it is disconnected.
    const resolver = createWorkstationApprovalOverrideResolver({
      registry,
      relayRegistry,
      planRegistry,
      now: clock,
    });
    resolver(overrideRequest("run_shell", "tc-gone"));

    expect(planRegistry.get("tc-gone")).toBeNull();
  });

  test("desktop session mismatch at admission ⇒ NO plan admitted", () => {
    activateLiveSession(); // session desktopSessionId = desktop-session-1
    registerBoundRelay({ desktopSessionId: "desktop-restarted" });
    const resolver = createWorkstationApprovalOverrideResolver({
      registry,
      relayRegistry,
      planRegistry,
      now: clock,
    });
    resolver(overrideRequest("run_shell", "tc-desktop-mismatch"));

    expect(planRegistry.get("tc-desktop-mismatch")).toBeNull();
  });

  test("D418 Commit 2 — stale pairingGeneration at admission ⇒ NO plan admitted (re-pair, desktopSessionId reused)", () => {
    activateLiveSession(); // session pairingGeneration = pairing-1
    // The relay re-paired: same relay/user/desktop session, but a NEW
    // server-derived pairing generation. The bound relay is no longer the
    // exact bound relay, so no plan is admitted.
    registerBoundRelay({ pairingGeneration: "pairing-re-paired" });
    const resolver = createWorkstationApprovalOverrideResolver({
      registry,
      relayRegistry,
      planRegistry,
      now: clock,
    });
    resolver(overrideRequest("run_shell", "tc-stale-pairing"));

    expect(planRegistry.get("tc-stale-pairing")).toBeNull();
  });

  test("no active session ⇒ NO plan admitted (Full Mode no-op)", () => {
    registerBoundRelay();
    const resolver = createWorkstationApprovalOverrideResolver({
      registry,
      relayRegistry,
      planRegistry,
      now: clock,
    });
    resolver(overrideRequest("run_shell", "tc-no-session"));

    expect(planRegistry.get("tc-no-session")).toBeNull();
  });

  test("no client Auto-Approve bypass: tool-args flags cannot self-authorize a plan without a session", () => {
    // No active session. The tool call carries D375-style client auto-approve
    // flags in its args — they must NOT create a plan. A plan is admitted
    // ONLY from the live server-side session (activation requires fresh PIN
    // proof + an authoritative relay binding), never from client args.
    registerBoundRelay();
    const toolCall: ToolCall = {
      name: "run_shell",
      args: { command: "echo hello", auto_approve: true, workstation_full_mode: true },
      id: "tc-client-flag",
    } as ToolCall;
    const resolver = createWorkstationApprovalOverrideResolver({
      registry,
      relayRegistry,
      planRegistry,
      now: clock,
    });
    resolver({
      userId: OWNER_USER_ID,
      toolCall,
      actorId: OWNER_ACTOR_ID,
      roomId: "",
      currentFolder: "/tmp",
      workspacePath: "/tmp",
    });

    expect(planRegistry.get("tc-client-flag")).toBeNull();
  });

  test("plan binding comes from the SESSION, not from tool args (no arg smuggling)", () => {
    activateLiveSession({ relayId: "relay-A", desktopSessionId: "desktop-A" });
    registerBoundRelay({ relayId: "relay-A", desktopSessionId: "desktop-A" });
    // The tool call args claim a foreign relay / desktop session — the plan
    // must bind the SESSION's tuple, ignoring the args.
    const toolCall: ToolCall = {
      name: "run_shell",
      args: { command: "echo hi", relayId: "relay-B", desktopSessionId: "desktop-B" },
      id: "tc-smuggle",
    } as ToolCall;
    const resolver = createWorkstationApprovalOverrideResolver({
      registry,
      relayRegistry,
      planRegistry,
      now: clock,
    });
    resolver({
      userId: OWNER_USER_ID,
      toolCall,
      actorId: OWNER_ACTOR_ID,
      roomId: "",
      currentFolder: "/tmp",
      workspacePath: "/tmp",
    });

    const plan = planRegistry.get("tc-smuggle");
    expect(plan).not.toBeNull();
    if (!plan) return;
    expect(plan.relayId).toBe("relay-A");
    expect(plan.desktopSessionId).toBe("desktop-A");
  });

  test("plan carries NO roots (admission metadata only, never Desktop filesystem authority)", () => {
    activateLiveSession();
    registerBoundRelay();
    const resolver = createWorkstationApprovalOverrideResolver({
      registry,
      relayRegistry,
      planRegistry,
      now: clock,
    });
    resolver(overrideRequest("run_shell", "tc-surface"));

    const plan = planRegistry.get("tc-surface");
    expect(plan).not.toBeNull();
    if (!plan) return;
    // The plan surface is the contract: no roots / allowedRoots / sandbox
    // fields exist on a WorkstationDispatchPlan. Assert by key (not by
    // substring) because the `executionClass` value "profile_bound_sandbox"
    // legitimately contains the word "sandbox".
    const keys = new Set(Object.keys(plan));
    expect(keys.has("allowedRoots")).toBe(false);
    expect(keys.has("roots")).toBe(false);
    expect(keys.has("sandboxProfile")).toBe(false);
    expect(keys.has("sandbox")).toBe(false);
  });

  test("a tool call with no id ⇒ no plan admitted (cannot be keyed / consumed)", () => {
    activateLiveSession();
    registerBoundRelay();
    const toolCall: ToolCall = {
      name: "run_shell",
      args: {},
    } as ToolCall;
    const resolver = createWorkstationApprovalOverrideResolver({
      registry,
      relayRegistry,
      planRegistry,
      now: clock,
    });
    resolver({
      userId: OWNER_USER_ID,
      toolCall,
      actorId: OWNER_ACTOR_ID,
      roomId: "",
      currentFolder: "/tmp",
      workspacePath: "/tmp",
    });
    // No id ⇒ no plan keyed ⇒ the tools node cannot consume it. The resolver
    // must not throw and must not admit an unkeyed plan.
    expect(planRegistry.size()).toBe(0);
  });
});

describe("createWorkstationApprovalOverrideResolver — redacted workstation_admission audit (Commit 4)", () => {
  beforeEach(() => {
    registry.disable(OWNER_USER_ID);
  });

  test("emits an audit row on auto with outcome=auto + reason=auto_admitted", () => {
    activateLiveSession();
    registerBoundRelay();
    const calls: WorkstationAdmissionAuditEvent[] = [];
    const resolver = createWorkstationApprovalOverrideResolver({
      registry,
      relayRegistry,
      planRegistry,
      now: clock,
      audit: (e) => calls.push(e),
    });
    resolver(runShellOverrideRequest("ls -la", "tc-audit-auto"));
    const row = calls.find((e) => e.toolCallId === "tc-audit-auto");
    expect(row).toBeDefined();
    expect(row?.kind).toBe("workstation_admission");
    expect(row?.outcome).toBe("auto");
    expect(row?.reason).toBe("auto_admitted");
    expect(row?.toolName).toBe("run_shell");
    expect(row?.toolCallId).toBe("tc-audit-auto");
    expect(row?.executionClass).toBe("profile_bound_sandbox");
    expect(row?.userId).toBe(OWNER_USER_ID);
    expect(row?.actorId).toBe(OWNER_ACTOR_ID);
    expect(row?.ts).toBe(FIXED_TS);
  });

  test("emits an audit row on scan refusal with its truthful reason", () => {
    activateLiveSession();
    registerBoundRelay();
    const calls: WorkstationAdmissionAuditEvent[] = [];
    const resolver = createWorkstationApprovalOverrideResolver({
      registry,
      relayRegistry,
      planRegistry,
      now: clock,
      audit: (e) => calls.push(e),
    });
    resolver(runShellOverrideRequest("rm -rf /", "tc-audit-none"));
    const row = calls.find((e) => e.toolCallId === "tc-audit-none");
    expect(row).toBeDefined();
    expect(row?.outcome).toBe("none");
    expect(row?.reason).toBe("critical_or_elevation_command");
  });

  test("emits an audit row even with no active session (none is auditable, not silent)", () => {
    registerBoundRelay();
    const calls: WorkstationAdmissionAuditEvent[] = [];
    const resolver = createWorkstationApprovalOverrideResolver({
      registry,
      relayRegistry,
      planRegistry,
      now: clock,
      audit: (e) => calls.push(e),
    });
    resolver(runShellOverrideRequest("ls", "tc-audit-no-session"));
    const row = calls.find((e) => e.toolCallId === "tc-audit-no-session");
    expect(row).toBeDefined();
    expect(row?.outcome).toBe("none");
    expect(row?.reason).toBe("no_active_session");
    // Opaque binding ids fall back to empty / zero when no session is live.
    expect(row?.relayId).toBe("");
    expect(row?.serverBindingId).toBe("");
    expect(row?.capabilityRevision).toBe(0);
  });

  test("the audit row carries OPAQUE session binding ids (correlation, not authority)", () => {
    activateLiveSession();
    registerBoundRelay();
    const calls: WorkstationAdmissionAuditEvent[] = [];
    const resolver = createWorkstationApprovalOverrideResolver({
      registry,
      relayRegistry,
      planRegistry,
      now: clock,
      audit: (e) => calls.push(e),
    });
    resolver(runShellOverrideRequest("echo hi", "tc-audit-binding"));
    const row = calls.find((e) => e.toolCallId === "tc-audit-binding");
    expect(row).toBeDefined();
    const session = registry.get(OWNER_USER_ID);
    expect(session).not.toBeNull();
    if (!session) return;
    expect(row?.relayId).toBe(session.relayId);
    expect(row?.desktopSessionId).toBe(session.desktopSessionId);
    expect(row?.serverBindingId).toBe(session.serverBindingId);
    expect(row?.pairingGeneration).toBe(session.pairingGeneration);
    expect(row?.profileId).toBe(session.profileId);
    expect(row?.profileRevision).toBe(session.profileRevision);
    expect(row?.capabilityRevision).toBe(session.capabilityRevision);
  });

  test("the audit row records the admitted live capability revision after a coherent refresh", () => {
    activateLiveSession(); // activation revision 10
    registerBoundRelay({ capabilityRevision: 11 });
    const calls: WorkstationAdmissionAuditEvent[] = [];
    const resolver = createWorkstationApprovalOverrideResolver({
      registry,
      relayRegistry,
      planRegistry,
      now: clock,
      audit: (e) => calls.push(e),
    });
    resolver(runShellOverrideRequest("git status --short", "tc-audit-cap-refresh"));

    const row = calls.find((e) => e.toolCallId === "tc-audit-cap-refresh");
    expect(row?.outcome).toBe("auto");
    expect(row?.capabilityRevision).toBe(11);
  });

  test("the audit row is REDACTED — no command text, output, roots, env, token, PIN, or grant contents", () => {
    activateLiveSession();
    registerBoundRelay();
    const calls: WorkstationAdmissionAuditEvent[] = [];
    const resolver = createWorkstationApprovalOverrideResolver({
      registry,
      relayRegistry,
      planRegistry,
      now: clock,
      audit: (e) => calls.push(e),
    });
    resolver(runShellOverrideRequest("rm -rf / && echo secret-token", "tc-audit-redact"));
    const row = calls.find((e) => e.toolCallId === "tc-audit-redact");
    expect(row).toBeDefined();
    const serialized = JSON.stringify(row);
    // The command string never appears in the audit row.
    expect(serialized).not.toContain("rm -rf");
    expect(serialized).not.toContain("secret-token");
    expect(serialized).not.toContain("echo hi");
    // No authority material keys are present on the row.
    const keys = new Set(Object.keys(row!));
    expect(keys.has("command")).toBe(false);
    expect(keys.has("commandOutput")).toBe(false);
    expect(keys.has("output")).toBe(false);
    expect(keys.has("roots")).toBe(false);
    expect(keys.has("allowedRoots")).toBe(false);
    expect(keys.has("env")).toBe(false);
    expect(keys.has("token")).toBe(false);
    expect(keys.has("pin")).toBe(false);
    expect(keys.has("grantIds")).toBe(false);
  });

  test("stamps the request clientMeta (ip / userAgent) onto the audit envelope", () => {
    activateLiveSession();
    registerBoundRelay();
    const calls: WorkstationAdmissionAuditEvent[] = [];
    const resolver = createWorkstationApprovalOverrideResolver({
      registry,
      relayRegistry,
      planRegistry,
      now: clock,
      audit: (e) => calls.push(e),
    });
    resolver({
      ...runShellOverrideRequest("ls", "tc-audit-meta"),
      clientMeta: { ip: "10.0.0.7", userAgent: "nautilo-test/1" },
    });
    const row = calls.find((e) => e.toolCallId === "tc-audit-meta");
    expect(row?.ip).toBe("10.0.0.7");
    expect(row?.userAgent).toBe("nautilo-test/1");
  });

  test("audit emit throw is swallowed (fail-closed, never blocks the turn nor widens approval)", () => {
    activateLiveSession();
    registerBoundRelay();
    const resolver = createWorkstationApprovalOverrideResolver({
      registry,
      relayRegistry,
      planRegistry,
      now: clock,
      audit: () => {
        throw new Error("audit-sink-boom");
      },
    });
    // Must not throw — the decision still resolves to auto.
    const d = resolver(runShellOverrideRequest("ls", "tc-audit-throw"));
    expect(d.override).toBe("auto");
  });

  test("no audit callback ⇒ no throw (audit sink is optional)", () => {
    activateLiveSession();
    registerBoundRelay();
    const resolver = createWorkstationApprovalOverrideResolver({
      registry,
      relayRegistry,
      planRegistry,
      now: clock,
    });
    const d = resolver(runShellOverrideRequest("ls", "tc-audit-none-sink"));
    expect(d.override).toBe("auto");
  });

  test("the slim scan is run_shell-only: a critical-looking command in a non-run_shell tool stays none by tool identity", () => {
    // A `file` tool call does not carry a shell command; the slim scan is
    // not consulted for it. It stays none because B4 auto-admits run_shell
    // attempts only; the audit row records that truthful classification.
    activateLiveSession();
    registerBoundRelay();
    const calls: WorkstationAdmissionAuditEvent[] = [];
    const resolver = createWorkstationApprovalOverrideResolver({
      registry,
      relayRegistry,
      planRegistry,
      now: clock,
      audit: (e) => calls.push(e),
    });
    const toolCall: ToolCall = {
      name: "file",
      args: { command: "rm -rf /" },
      id: "tc-audit-file",
    } as ToolCall;
    resolver({
      userId: OWNER_USER_ID,
      toolCall,
      actorId: OWNER_ACTOR_ID,
      roomId: "",
      currentFolder: "/tmp",
      workspacePath: "/tmp",
    });
    const row = calls.find((e) => e.toolCallId === "tc-audit-file");
    expect(row?.outcome).toBe("none");
    expect(row?.reason).toBe("run_shell_required");
  });
});

describe("classifyWorkstationExecutionClass", () => {
  test("maps run_shell → profile_bound_sandbox (sandboxed relay dispatch)", () => {
    expect(classifyWorkstationExecutionClass("run_shell")).toBe("profile_bound_sandbox");
  });
  test("maps structured run_shell.git → typed_broker", () => {
    expect(
      classifyWorkstationExecutionClass("run_shell", { git: { operation: "status" } }),
    ).toBe("typed_broker");
  });
  test("maps explicit workstation run_shell → real_workstation", () => {
    expect(
      classifyWorkstationExecutionClass("run_shell", { execution: "workstation" }),
    ).toBe("real_workstation");
  });
  test("does not infer real workstation from another tool's arguments", () => {
    expect(
      classifyWorkstationExecutionClass("file", { execution: "workstation" }),
    ).toBe("profile_bound_sandbox");
  });
  test("maps file → profile_bound_sandbox", () => {
    expect(classifyWorkstationExecutionClass("file")).toBe("profile_bound_sandbox");
  });
  test("maps run_web_search / fetch_url → profile_bound_sandbox", () => {
    expect(classifyWorkstationExecutionClass("run_web_search")).toBe("profile_bound_sandbox");
    expect(classifyWorkstationExecutionClass("fetch_url")).toBe("profile_bound_sandbox");
  });
  test("maps manage_local_mcp → profile_bound_sandbox", () => {
    expect(classifyWorkstationExecutionClass("manage_local_mcp")).toBe("profile_bound_sandbox");
  });
  test("unknown tool defaults to profile_bound_sandbox", () => {
    expect(classifyWorkstationExecutionClass("something_new")).toBe("profile_bound_sandbox");
  });
});
