/**
 * Tests for /api/security/posture — D060 Sprint 1 G5.3.b + G5.3.c.
 *
 * GET coverage:
 *   - 401 without Bearer token
 *   - 401 with invalid Bearer token
 *   - 200 for authenticated owner — returns deployment_mode +
 *     security_level + capabilities array containing the single
 *     `manage_server_security` Capability slug (stub until G5.5)
 *   - 200 for authenticated non-owner — returns posture but EMPTY
 *     capabilities array (UI must gate mutations on this)
 *   - posture reflects `setConfigOverrides` changes (proving the
 *     resolver is called per request, not cached at route mount)
 *
 * PUT coverage:
 *   - 401 without session → no mutator invocation
 *   - 403 non-owner (capability stub) → no mutator invocation
 *   - 400 missing PIN → no mutator invocation
 *   - 400 when neither field supplied (no-op body)
 *   - 400 invalid deploymentMode / securityLevel (Zod reject)
 *   - 401 invalid PIN → no mutator invocation
 *   - 200 happy path invokes mutator with prev/next + actor/ip/ua
 *   - 200 no-op short-circuit (next == prev) → no mutator call +
 *     `changed: false` in response
 *   - Ordering: validation runs BEFORE PIN verify (don't burn verify
 *     attempts on obviously-bad payloads)
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { setConfigOverrides } from "@nautilo/config";
import { LockoutError, type ChallengeProvider, type RbacProjection } from "@nautilo/trust";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  securityRoutes,
  UncontainedHostCommandsController,
} from "../../src/routes/security";
import type { PostureMutationMeta } from "../../src/routes/security";
import {
  writeSecurityAuditEvent,
  type SecurityAuditEvent,
} from "../../src/lib/security-audit-log";
import { SessionStore } from "../helpers/test-session-store";

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
    const role =
      session.userId === session.ownerId ? "owner" : "guest";
    request.policyContext = {
      actorRole: role,
      actorLabel: role,
    } as unknown as typeof request.policyContext;
  });
}

// M043 + G5.5 rebase: caps + PIN are now keyed on user_id (not
// actor_id). SessionStore today stores both; createSession(actorId,
// ownerId) puts the user id in the "ownerId" slot. Session-user-id
// threading is future work; for now these tests exercise the user-
// keyed path via session.ownerId.
const OWNER_ACTOR_ID = "owner-actor";
const OWNER_USER_ID = "owner-user"; // = session.ownerId today
const HOUSEHOLD_ACTOR_ID = "household-actor";
const HOUSEHOLD_USER_ID = "household-user";
const OWNER_PIN = "246810";
const HOUSEHOLD_PIN = "135791";

// Minimal in-memory ChallengeProvider so we don't need a DB at
// test time. Keyed as a Map so individual tests can enroll PINs
// for non-owner actors — lets us exercise the G5.5 non-owner
// cap-holder path (SEC-2 regression lock).
class FakeChallengeProvider implements ChallengeProvider {
  private readonly pins = new Map<string, string>();
  enrollActor(actorId: string, pin: string): void {
    this.pins.set(actorId, pin);
  }
  verifyProof(actorId: string, proof: string): Promise<boolean> {
    return Promise.resolve(this.pins.get(actorId) === proof);
  }
  isEnrolled(actorId: string): Promise<boolean> {
    return Promise.resolve(this.pins.has(actorId));
  }
}

let app: FastifyInstance;
let sessionStore: SessionStore;
let ownerToken: string;
let householdToken: string;
let tmp: string;
let auditLogPath: string;

// Spies: each test clears in beforeEach and asserts against them.
// Captures exactly what the PUT handler forwards so we can pin the
// actor/ip/prev/next contract + the audit-on-failure contract.
let mutatorCalls: PostureMutationMeta[] = [];
let auditCalls: SecurityAuditEvent[] = [];

// D060 Sprint 1 G5.5 + M043 — in-memory Capability store, keyed on
// user_id (post-M043 caps are user-scoped, not actor-scoped).
// Mirrors the shape @nautilo/trust::getUserCapabilities returns.
const userCaps = new Map<string, readonly string[]>();

let pinProvider: FakeChallengeProvider;
let allowUncontainedHostCommands = false;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "nautilo-security-route-"));
  auditLogPath = join(tmp, "security-audit.log");
  sessionStore = new SessionStore(undefined, { persistPath: null });
  pinProvider = new FakeChallengeProvider();
  // PIN enrolled against the user id (post-M043 credentials.user_id).
  pinProvider.enrollActor(OWNER_USER_ID, OWNER_PIN);

  app = Fastify({ logger: false });
  // M052/M055 — `securityRoutes` GETs now require `request.sessionUserId`
  // + `request.policyContext` (set by the trust preHandler in the real
  // server). Install a tiny test-only preHandler that decodes the
  // test Bearer token through `sessionStore` and sets the same
  // request decorations so the route gate sees what production sees.
  installBearerSessionPreHandler(app, sessionStore);
  securityRoutes(app, {
    pinProvider,
    mutatePosture: async (meta) => {
      mutatorCalls.push(meta);
    },
    auditEvent: async (event) => {
      auditCalls.push(event);
    },
    auditLogPath,
    getCapabilities: (userId) =>
      Promise.resolve(userCaps.get(userId) ?? []),
    // Stub the sandbox-backend probe so this stays a real unit test —
    // the production `resolveBackendSummary()` spawns `/usr/bin/sandbox-exec`
    // / `bwrap` via `execFile`, which under heavy parallel load
    // (lefthook pre-push pipeline) can hang past bun's 60s test timeout.
    backendSummary: () => Promise.resolve({ kind: "passthrough" as const }),
    getAllowUncontainedHostCommands: () => allowUncontainedHostCommands,
  });
  await app.ready();

  // createSession(actorId, ownerId, userId?) — post-G5 threading
  // has an explicit userId field. For owner sessions today, userId
  // === ownerId (the server owner\u0027s user id). For household
  // sessions (future), ownerId stays the server owner\u0027s id while
  // userId is the household member\u0027s own id. The security route
  // keys cap + PIN on session.userId, so tests that pass distinct
  // userIds exercise the user-keyed path correctly. Using the
  // 2-arg form here: userId defaults to ownerId, which for these
  // tests is the authenticated user.
  ownerToken = sessionStore.createSession(
    OWNER_ACTOR_ID,
    OWNER_USER_ID,
    OWNER_USER_ID,
  ).token;
  householdToken = sessionStore.createSession(
    HOUSEHOLD_ACTOR_ID,
    OWNER_USER_ID, // realistic: household session\u0027s "server owner" is still the server owner
    HOUSEHOLD_USER_ID, // authenticated user is the household member
  ).token;
});

beforeEach(() => {
  mutatorCalls = [];
  auditCalls = [];
  // Reset cap seed before each test so a test that mutates can\u0027t
  // leak state. Keyed on user_id (post-M043).
  userCaps.clear();
  // M128 P0.2 (TP6, 2026-05-28): owner gets `view_audit_log` in addition
  // to `manage_server_security` so the audit-log read gate (now cap-
  // based per B2 fix, was role-based) admits owner-bearer requests.
  // Per permission-model.md §6 grid both caps belong to the owner rung.
  userCaps.set(OWNER_USER_ID, ["manage_server_security", "view_audit_log"]);
  userCaps.set(HOUSEHOLD_USER_ID, []);
  allowUncontainedHostCommands = false;
  rmSync(auditLogPath, { force: true });
});

afterAll(async () => {
  if (app) await app.close();
  setConfigOverrides({});
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

interface PostureBody {
  readonly deploymentMode: string;
  readonly securityLevel: string;
  readonly allowUncontainedHostCommands: boolean;
  readonly networkPolicy: { readonly mode: string; readonly allow?: readonly unknown[] };
  readonly capabilities: readonly string[];
  readonly actorRole: string;
  readonly writablePaths: readonly string[];
  readonly readOnlyPaths: readonly string[];
  readonly backend: {
    readonly kind: string;
    readonly procSupported?: boolean;
  };
}

describe("GET /api/security/posture", () => {
  test("401 without Bearer token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/security/posture",
    });
    expect(res.statusCode).toBe(401);
    const body: { error: string } = res.json();
    expect(body.error).toBe("Authentication required");
  });

  test("401 with invalid Bearer token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/security/posture",
      headers: { Authorization: "Bearer not-a-real-token" },
    });
    expect(res.statusCode).toBe(401);
  });

  test("200 for actor with manage_server_security — capability surfaces in response", async () => {
    setConfigOverrides({
      nautilo_deployment_mode: "desktop-permissive",
      nautilo_security_level: "cautious",
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/security/posture",
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body: PostureBody = res.json();
    expect(body.deploymentMode).toBe("desktop-permissive");
    expect(body.securityLevel).toBe("cautious");
    expect(body.allowUncontainedHostCommands).toBe(false);
    expect(body.networkPolicy).toEqual({ mode: "host" });
    // M128 P0.2 (TP6): owner now also holds `view_audit_log` per §6 grid
    // (added in the beforeEach default seed so the audit-log route's
    // cap-gate admits owner). Order matches the userCaps.set call.
    expect(body.capabilities).toEqual(["manage_server_security", "view_audit_log"]);
    expect(body.actorRole).toBe("owner");
    expect(body.writablePaths.length).toBeGreaterThan(0);
    expect(body.readOnlyPaths.length).toBeGreaterThan(0);
    expect(["bubblewrap", "sandbox-exec", "passthrough"]).toContain(
      body.backend.kind,
    );
  });

  test("200 for actor without the cap — EMPTY capabilities array (UI gates mutations)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/security/posture",
      headers: { Authorization: `Bearer ${householdToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body: PostureBody = res.json();
    // Non-owner sees posture (so UI shows current shape) but CANNOT
    // mutate it. Empty array forces the client to gate the
    // [Change posture] button correctly.
    expect(body.capabilities).toEqual([]);
    expect(body.actorRole).toBe("guest");
    expect(body.writablePaths).toEqual([]);
    expect(body.readOnlyPaths).toEqual([]);
    expect(body.networkPolicy.mode).toBe("host");
  });

  test("non-owner with manage_server_security can see path details", async () => {
    userCaps.set(HOUSEHOLD_USER_ID, ["manage_server_security"]);
    const res = await app.inject({
      method: "GET",
      url: "/api/security/posture",
      headers: { Authorization: `Bearer ${householdToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body: PostureBody = res.json();
    expect(body.actorRole).toBe("guest");
    expect(body.capabilities).toEqual(["manage_server_security"]);
    expect(body.writablePaths.length).toBeGreaterThan(0);
    expect(body.readOnlyPaths.length).toBeGreaterThan(0);
  });

  test("GET returns the caller's full governance capability slice for the UI", async () => {
    // If an actor holds several governance caps (owner typically
    // holds all 9), the GET response returns them so the Sprint 3
    // posture modal can display the user's governance slice. The PUT
    // route still gates specifically on manage_server_security.
    userCaps.set(OWNER_USER_ID, [
      "approve_spending",
      "manage_billing",
      "manage_server_security",
      "manage_standing_approvals",
      "use_high_impact_tools",
    ]);
    const res = await app.inject({
      method: "GET",
      url: "/api/security/posture",
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body: PostureBody = res.json();
    expect(body.capabilities).toEqual([
      "approve_spending",
      "manage_billing",
      "manage_server_security",
      "manage_standing_approvals",
      "use_high_impact_tools",
    ]);
  });

  test("posture reflects setConfigOverrides on each request (no mount-time cache)", async () => {
    setConfigOverrides({
      nautilo_deployment_mode: "server",
      nautilo_security_level: "paranoid",
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/security/posture",
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body: PostureBody = res.json();
    expect(body.deploymentMode).toBe("server");
    expect(body.securityLevel).toBe("paranoid");
  });
});

describe("D538 uncontained-host-command session controller", () => {
  const binding = {
    userId: OWNER_USER_ID,
    serverBindingId: "server-1",
    relayId: "relay-1",
    desktopSessionId: "desktop-1",
    pairingGeneration: "pairing-1",
    capabilityRevision: 4,
  };
  const eligibleProjection: RbacProjection = {
    highestRole: "superuser",
    capabilitySlugs: [],
    groupChips: [{
      id: "uncontained-group",
      type: "uncontained_host_commands_grantees",
      label: "Uncontained host commands grantees",
      roleSlug: "uncontained_host_commands_grantee",
    }, {
      id: "superusers-group",
      type: "superusers",
      label: "Superusers",
      roleSlug: "superuser",
    }],
  };

  type VerifyMutation = (state: {
    setPolicy: (value: boolean) => void;
    setProjection: (value: RbacProjection) => void;
    setLiveBinding: (value: typeof binding | null) => void;
  }) => void;

  function controllerFixture(input: {
    policy?: boolean;
    projection?: RbacProjection;
    projectionFailure?: Error;
    liveBinding?: typeof binding | null;
    onVerify?: VerifyMutation;
  } = {}) {
    let policy = input.policy ?? true;
    let projection = input.projection ?? eligibleProjection;
    let projectionFailure = input.projectionFailure ?? null;
    let liveBinding = input.liveBinding === undefined ? binding : input.liveBinding;
    const events: SecurityAuditEvent[] = [];
    const setPolicy = (value: boolean) => { policy = value; };
    const setProjection = (value: RbacProjection) => {
      projection = value;
      projectionFailure = null;
    };
    const setProjectionFailure = (error: Error) => { projectionFailure = error; };
    const setLiveBinding = (value: typeof binding | null) => { liveBinding = value; };
    const provider: ChallengeProvider = {
      verifyProof: async (_userId, pin) => {
        input.onVerify?.({ setPolicy, setProjection, setLiveBinding });
        if (pin === "locked") throw new LockoutError(30_000);
        return pin === OWNER_PIN;
      },
      isEnrolled: async () => true,
    };
    const controller = new UncontainedHostCommandsController({
      pinProvider: provider,
      getAllowUncontainedHostCommands: () => policy,
      getLiveRelayBinding: ({ userId, relayId, desktopSessionId }) =>
        liveBinding !== null &&
        liveBinding.userId === userId &&
        liveBinding.relayId === relayId &&
        liveBinding.desktopSessionId === desktopSessionId
          ? liveBinding
          : null,
      getRbac: async () => {
        if (projectionFailure !== null) throw projectionFailure;
        return projection;
      },
      auditEvent: async (event) => { events.push(event); },
      now: () => new Date("2026-08-17T12:00:00.000Z"),
    });
    return {
      controller,
      events,
      setPolicy,
      setProjection,
      setProjectionFailure,
      setLiveBinding,
    };
  }

  const request = {
    userId: OWNER_USER_ID,
    actorId: OWNER_ACTOR_ID,
    relayId: binding.relayId,
    desktopSessionId: binding.desktopSessionId,
    ip: "127.0.0.1",
    userAgent: "test-client",
  };

  test("fails closed for default-off policy, missing exact grant, and role floor", async () => {
    const fixture = controllerFixture({ policy: false });
    expect((await fixture.controller.status(request)).reason).toBe("policy_disabled");
    fixture.setPolicy(true);
    fixture.setProjection({ ...eligibleProjection, groupChips: [] });
    expect((await fixture.controller.status(request)).reason).toBe("grant_missing");
    fixture.setProjection({ ...eligibleProjection, highestRole: "member" });
    expect((await fixture.controller.status(request)).reason).toBe("role_floor_missing");
  });

  test("requires own PIN, preserves lockout, and never records sensitive activation input", async () => {
    const fixture = controllerFixture();
    const invalid = await fixture.controller.activate({ ...request, pin: "wrong-pin" });
    const locked = await fixture.controller.activate({ ...request, pin: "locked" });
    expect(invalid.ok).toBe(false);
    expect(locked.ok).toBe(false);
    if (invalid.ok || locked.ok) throw new Error("expected PIN denial");
    expect(invalid.status).toBe(401);
    expect(locked.status).toBe(429);
    const encoded = JSON.stringify(fixture.events);
    expect(encoded).not.toContain("wrong-pin");
    expect(encoded).not.toContain('"pin":"locked"');
    expect(encoded).not.toContain("/Users/");
  });

  test("rejects foreign, headless, or disconnected relay evidence before PIN verification", async () => {
    const fixture = controllerFixture({ liveBinding: null });
    const result = await fixture.controller.activate({ ...request, pin: OWNER_PIN });
    expect(result).toEqual({ ok: false, status: 403, reason: "relay_binding_unavailable" });
    const event = fixture.events[0];
    expect(event?.kind).toBe("uncontained_host_commands_denied");
    if (event?.kind !== "uncontained_host_commands_denied") {
      throw new Error("expected uncontained-host-command denial audit");
    }
    expect(event.reason).toBe("relay_binding_unavailable");
  });

  test("holds one exact in-memory binding, invalidates drift, and cannot disable another Desktop", async () => {
    const fixture = controllerFixture();
    const activated = await fixture.controller.activate({ ...request, pin: OWNER_PIN });
    expect(activated.ok).toBe(true);
    expect((await fixture.controller.status(request)).active).toBe(true);
    expect(await fixture.controller.disable({ ...request, desktopSessionId: "desktop-foreign" })).toBe(false);
    expect((await fixture.controller.status(request)).active).toBe(true);
    fixture.setLiveBinding({ ...binding, capabilityRevision: 5 });
    expect((await fixture.controller.status(request)).active).toBe(false);
    expect(fixture.events.some((event) => event.kind === "uncontained_host_commands_status_invalidated")).toBe(true);
    // A new controller models restart: no durable receipt can recreate the session.
    const restarted = controllerFixture();
    expect((await restarted.controller.status(request)).active).toBe(false);
  });

  test("an unavailable foreign Desktop cannot invalidate another live Desktop session", async () => {
    const fixture = controllerFixture();
    await fixture.controller.activate({ ...request, pin: OWNER_PIN });
    const foreign = await fixture.controller.status({
      ...request,
      relayId: "relay-foreign",
      desktopSessionId: "desktop-foreign",
    });
    expect(foreign).toMatchObject({
      active: false,
      eligible: false,
      reason: "relay_binding_unavailable",
    });
    expect(await fixture.controller.status(request)).toMatchObject({ active: true, eligible: true });
  });

  test("post-PIN authority changes deny activation without storing a session", async () => {
    const races: ReadonlyArray<{
      readonly label: string;
      readonly mutate: VerifyMutation;
    }> = [
      { label: "policy", mutate: ({ setPolicy }) => setPolicy(false) },
      { label: "grant", mutate: ({ setProjection }) => setProjection({ ...eligibleProjection, groupChips: [] }) },
      { label: "role", mutate: ({ setProjection }) => setProjection({ ...eligibleProjection, highestRole: "member" }) },
      { label: "relay revision", mutate: ({ setLiveBinding }) => setLiveBinding({ ...binding, capabilityRevision: 5 }) },
      { label: "relay unavailable", mutate: ({ setLiveBinding }) => setLiveBinding(null) },
    ];
    for (const race of races) {
      const fixture = controllerFixture({ onVerify: race.mutate });
      const result = await fixture.controller.activate({ ...request, pin: OWNER_PIN });
      expect(result.ok, race.label).toBe(false);
      expect((await fixture.controller.status(request)).active, race.label).toBe(false);
    }
  });

  test("D538 dispatch re-reads every live fact and admits only the exact activated Desktop", async () => {
    const dispatch = { ...request, pairingGeneration: binding.pairingGeneration, toolCallId: "tool-call-opaque" };
    const positive = controllerFixture();
    await positive.controller.activate({ ...request, pin: OWNER_PIN });
    const admitted = await positive.controller.resolveDispatch(dispatch);
    expect(admitted).toMatchObject({
      admitted: true,
      executionClass: "real_workstation",
    });
    if (!admitted.admitted) throw new Error("expected admitted D538 dispatch");
    expect(admitted.activationSignal.aborted).toBe(false);

    const cases: ReadonlyArray<{
      readonly label: string;
      readonly prepare: (fixture: ReturnType<typeof controllerFixture>) => void;
      readonly input?: Partial<typeof dispatch>;
    }> = [
      { label: "policy", prepare: ({ setPolicy }) => setPolicy(false) },
      { label: "grant", prepare: ({ setProjection }) => setProjection({ ...eligibleProjection, groupChips: [] }) },
      { label: "role floor", prepare: ({ setProjection }) => setProjection({ ...eligibleProjection, highestRole: "member" }) },
      { label: "capability revision", prepare: ({ setLiveBinding }) => setLiveBinding({ ...binding, capabilityRevision: 5 }) },
      { label: "pairing", prepare: () => {}, input: { pairingGeneration: "pairing-stale" } },
      { label: "inactive", prepare: () => {} },
    ];
    for (const entry of cases) {
      const fixture = controllerFixture();
      if (entry.label !== "inactive") await fixture.controller.activate({ ...request, pin: OWNER_PIN });
      entry.prepare(fixture);
      const result = await fixture.controller.resolveDispatch({ ...dispatch, ...entry.input });
      expect(result.admitted, entry.label).toBe(false);
      expect(fixture.events.some((event) => event.kind === "uncontained_host_commands_dispatch_denied"), entry.label).toBe(true);
      expect(JSON.stringify(fixture.events), entry.label).not.toContain("tool-call-opaque");
    }
  });

  test("explicit lifecycle invalidation is exact to the prior pairing/session binding", async () => {
    const fixture = controllerFixture();
    await fixture.controller.activate({ ...request, pin: OWNER_PIN });
    await fixture.controller.invalidateForRelayBinding({
      userId: OWNER_USER_ID,
      relayId: binding.relayId,
      desktopSessionId: binding.desktopSessionId,
      pairingGeneration: binding.pairingGeneration,
      reason: "pairing_generation_changed",
    });
    expect((await fixture.controller.status(request)).active).toBe(false);
    expect(fixture.events.some((event) => event.kind === "uncontained_host_commands_invalidated")).toBe(true);
  });

  test("D538 revocation aborts only the active session and a fresh activation cannot revive its signal", async () => {
    const fixture = controllerFixture();
    const dispatch = { ...request, pairingGeneration: binding.pairingGeneration, toolCallId: "call-1" };
    await fixture.controller.activate({ ...request, pin: OWNER_PIN });
    const first = await fixture.controller.resolveDispatch(dispatch);
    if (!first.admitted) throw new Error("expected first activation admission");

    expect(await fixture.controller.disable(request)).toBe(true);
    expect(first.activationSignal.aborted).toBe(true);
    expect((await fixture.controller.resolveDispatch(dispatch)).admitted).toBe(false);

    await fixture.controller.activate({ ...request, pin: OWNER_PIN });
    const second = await fixture.controller.resolveDispatch(dispatch);
    if (!second.admitted) throw new Error("expected fresh activation admission");
    expect(second.activationSignal).not.toBe(first.activationSignal);
    expect(second.activationSignal.aborted).toBe(false);
    expect(first.activationSignal.aborted).toBe(true);
  });

  test("D538 classifies each exact grant or role-floor group independently and ignores unrelated membership", async () => {
    const fixture = controllerFixture();
    expect(await fixture.controller.prepareMembershipRemoval({
      userId: OWNER_USER_ID,
      groupId: "unrelated-group",
      actorId: "admin-actor",
    })).toBeNull();

    const revokeGrant = await fixture.controller.prepareMembershipRemoval({
      userId: OWNER_USER_ID,
      groupId: "uncontained-group",
      actorId: "admin-actor",
    });
    expect(revokeGrant).not.toBeNull();

    fixture.setProjection({
      ...eligibleProjection,
      groupChips: [...eligibleProjection.groupChips, {
        id: "admins-group",
        type: "admins",
        label: "Admins",
        roleSlug: "admin",
      }],
    });
    const revokeSuperuser = await fixture.controller.prepareMembershipRemoval({
      userId: OWNER_USER_ID,
      groupId: "superusers-group",
      actorId: "admin-actor",
    });
    const revokeAdmin = await fixture.controller.prepareMembershipRemoval({
      userId: OWNER_USER_ID,
      groupId: "admins-group",
      actorId: "admin-actor",
    });
    expect(revokeSuperuser).not.toBeNull();
    expect(revokeAdmin).not.toBeNull();
  });

  test("D538 prepared revoker ends an activation created while the DB mutation is in flight", async () => {
    const fixture = controllerFixture();
    const dispatch = { ...request, pairingGeneration: binding.pairingGeneration, toolCallId: "call-1" };
    const prepared = await fixture.controller.prepareMembershipRemoval({
      userId: OWNER_USER_ID,
      groupId: "uncontained-group",
      actorId: "admin-actor",
    });
    expect(prepared).not.toBeNull();

    await fixture.controller.activate({ ...request, pin: OWNER_PIN });
    const admission = await fixture.controller.resolveDispatch(dispatch);
    if (!admission.admitted) throw new Error("expected activation admission");
    await prepared?.();
    expect(admission.activationSignal.aborted).toBe(true);
  });

  test("D538 prepared revoker ends replacement B rather than only activation A", async () => {
    const fixture = controllerFixture();
    const dispatch = { ...request, pairingGeneration: binding.pairingGeneration, toolCallId: "call-1" };
    await fixture.controller.activate({ ...request, pin: OWNER_PIN });
    const admissionA = await fixture.controller.resolveDispatch(dispatch);
    if (!admissionA.admitted) throw new Error("expected activation A admission");
    const prepared = await fixture.controller.prepareMembershipRemoval({
      userId: OWNER_USER_ID,
      groupId: "superusers-group",
      actorId: "admin-actor",
    });
    expect(prepared).not.toBeNull();

    await fixture.controller.activate({ ...request, pin: OWNER_PIN });
    const admissionB = await fixture.controller.resolveDispatch(dispatch);
    if (!admissionB.admitted) throw new Error("expected activation B admission");
    expect(admissionA.activationSignal.aborted).toBe(true);
    expect(admissionB.activationSignal.aborted).toBe(false);

    await prepared?.();
    expect(admissionB.activationSignal.aborted).toBe(true);
  });

  test("D538 projection preparation failure revokes the activation current after successful mutation", async () => {
    const fixture = controllerFixture({ projectionFailure: new Error("projection unavailable") });
    const dispatch = { ...request, pairingGeneration: binding.pairingGeneration, toolCallId: "call-1" };
    const prepared = await fixture.controller.prepareMembershipRemoval({
      userId: OWNER_USER_ID,
      groupId: "uncontained-group",
      actorId: "admin-actor",
    });
    expect(prepared).not.toBeNull();

    fixture.setProjection(eligibleProjection);
    await fixture.controller.activate({ ...request, pin: OWNER_PIN });
    const admitted = await fixture.controller.resolveDispatch(dispatch);
    if (!admitted.admitted) throw new Error("expected activation admission");
    await prepared?.();
    expect(admitted.activationSignal.aborted).toBe(true);
  });

  test("D538 policy disable aborts every current activation after the policy mutation seam", async () => {
    const fixture = controllerFixture();
    const dispatch = { ...request, pairingGeneration: binding.pairingGeneration, toolCallId: "call-1" };
    await fixture.controller.activate({ ...request, pin: OWNER_PIN });
    const admitted = await fixture.controller.resolveDispatch(dispatch);
    if (!admitted.admitted) throw new Error("expected activation admission");

    await fixture.controller.invalidateAllForPolicyDisable({ actorId: "admin-actor" });

    expect(admitted.activationSignal.aborted).toBe(true);
    expect((await fixture.controller.resolveDispatch(dispatch)).admitted).toBe(false);
  });

  test("D538 policy mutation failure retains activation while successful policy-off revokes before response", async () => {
    const fixture = controllerFixture();
    const dispatch = { ...request, pairingGeneration: binding.pairingGeneration, toolCallId: "call-1" };
    await fixture.controller.activate({ ...request, pin: OWNER_PIN });
    const admitted = await fixture.controller.resolveDispatch(dispatch);
    if (!admitted.admitted) throw new Error("expected activation admission");

    const routeApp = Fastify({ logger: false });
    const routeSessions = new SessionStore(undefined, { persistPath: null });
    installBearerSessionPreHandler(routeApp, routeSessions);
    const routeToken = routeSessions.createSession(
      OWNER_ACTOR_ID,
      OWNER_USER_ID,
      OWNER_USER_ID,
    ).token;
    const routePinProvider = new FakeChallengeProvider();
    routePinProvider.enrollActor(OWNER_USER_ID, OWNER_PIN);
    let policy = true;
    let failMutation = true;
    securityRoutes(routeApp, {
      pinProvider: routePinProvider,
      mutatePosture: async ({ next }) => {
        if (failMutation) throw new Error("posture write failed");
        policy = next.allowUncontainedHostCommands;
      },
      auditEvent: async () => {},
      getCapabilities: async () => ["manage_uncontained_host_commands"],
      getAllowUncontainedHostCommands: () => policy,
      uncontainedHostCommands: fixture.controller,
    });
    await routeApp.ready();

    try {
      const failed = await routeApp.inject({
        method: "PUT",
        url: "/api/security/posture",
        headers: { Authorization: `Bearer ${routeToken}` },
        payload: { allowUncontainedHostCommands: false, pin: OWNER_PIN },
      });
      expect(failed.statusCode).toBe(500);
      expect(admitted.activationSignal.aborted).toBe(false);

      failMutation = false;
      const succeeded = await routeApp.inject({
        method: "PUT",
        url: "/api/security/posture",
        headers: { Authorization: `Bearer ${routeToken}` },
        payload: { allowUncontainedHostCommands: false, pin: OWNER_PIN },
      });
      expect(succeeded.statusCode).toBe(200);
      expect(admitted.activationSignal.aborted).toBe(true);
    } finally {
      await routeApp.close();
    }
  });

  test("exercises the authenticated activation route family with truthful exact-session state", async () => {
    const fixture = controllerFixture({ policy: false });
    const routeApp = Fastify({ logger: false });
    const routeSessions = new SessionStore(undefined, { persistPath: null });
    installBearerSessionPreHandler(routeApp, routeSessions);
    const routeToken = routeSessions.createSession(
      OWNER_ACTOR_ID,
      OWNER_USER_ID,
      OWNER_USER_ID,
    ).token;
    const routePinProvider = new FakeChallengeProvider();
    routePinProvider.enrollActor(OWNER_USER_ID, OWNER_PIN);
    securityRoutes(routeApp, {
      pinProvider: routePinProvider,
      mutatePosture: async () => {},
      auditEvent: async () => {},
      getCapabilities: async () => [],
      getAllowUncontainedHostCommands: () => false,
      uncontainedHostCommands: fixture.controller,
    });
    await routeApp.ready();
    const headers = { Authorization: `Bearer ${routeToken}` };
    const query = "relayId=relay-1&desktopSessionId=desktop-1";
    const bodyOf = (response: { json: () => unknown }): Record<string, unknown> =>
      response.json() as Record<string, unknown>;

    try {
      const unauthenticated = await routeApp.inject({
        method: "GET",
        url: `/api/security/uncontained-host-commands/session?${query}`,
      });
      expect(unauthenticated.statusCode).toBe(401);

      const malformed = await routeApp.inject({
        method: "GET",
        url: "/api/security/uncontained-host-commands/session?relayId=relay-1",
        headers,
      });
      expect(malformed.statusCode).toBe(400);

      const defaultOff = await routeApp.inject({
        method: "GET",
        url: `/api/security/uncontained-host-commands/session?${query}`,
        headers,
      });
      expect(defaultOff.statusCode).toBe(200);
      expect(bodyOf(defaultOff)).toEqual({
        active: false,
        eligible: false,
        reason: "policy_disabled",
        activatedAt: null,
      });

      fixture.setPolicy(true);
      fixture.setProjection({ ...eligibleProjection, groupChips: [] });
      const ineligible = await routeApp.inject({
        method: "GET",
        url: `/api/security/uncontained-host-commands/session?${query}`,
        headers,
      });
      expect(ineligible.statusCode).toBe(200);
      expect(bodyOf(ineligible)["reason"]).toBe("grant_missing");

      fixture.setProjection(eligibleProjection);
      const activated = await routeApp.inject({
        method: "POST",
        url: "/api/security/uncontained-host-commands/activate",
        headers,
        payload: { pin: OWNER_PIN, relayId: binding.relayId, desktopSessionId: binding.desktopSessionId },
      });
      expect(activated.statusCode).toBe(200);
      expect(bodyOf(activated)["active"]).toBe(true);

      const status = await routeApp.inject({
        method: "GET",
        url: `/api/security/uncontained-host-commands/session?${query}`,
        headers,
      });
      expect(bodyOf(status)).toMatchObject({ active: true, eligible: true, reason: null });

      const foreignDisable = await routeApp.inject({
        method: "POST",
        url: "/api/security/uncontained-host-commands/disable",
        headers,
        payload: { relayId: binding.relayId, desktopSessionId: "desktop-foreign" },
      });
      expect(bodyOf(foreignDisable)).toEqual({ ok: true, disabled: false });
      expect(bodyOf(await routeApp.inject({ method: "GET", url: `/api/security/uncontained-host-commands/session?${query}`, headers }))["active"])
        .toBe(true);

      const disabled = await routeApp.inject({
        method: "POST",
        url: "/api/security/uncontained-host-commands/disable",
        headers,
        payload: { relayId: binding.relayId, desktopSessionId: binding.desktopSessionId },
      });
      expect(bodyOf(disabled)).toEqual({ ok: true, disabled: true });
      const disabledAgain = await routeApp.inject({
        method: "POST",
        url: "/api/security/uncontained-host-commands/disable",
        headers,
        payload: { relayId: binding.relayId, desktopSessionId: binding.desktopSessionId },
      });
      expect(bodyOf(disabledAgain)).toEqual({ ok: true, disabled: false });
      expect(bodyOf(await routeApp.inject({ method: "GET", url: `/api/security/uncontained-host-commands/session?${query}`, headers })))
        .toMatchObject({ active: false, eligible: true, reason: null });
    } finally {
      await routeApp.close();
    }
  });
});

describe("GET /api/security/audit-log", () => {
  test("401 without Bearer token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/security/audit-log",
    });
    expect(res.statusCode).toBe(401);
  });

  test("403 for guest / actor without audit visibility", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/security/audit-log",
      headers: { Authorization: `Bearer ${householdToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  test("audit log fallback role does NOT infer owner from manage_server_security alone", async () => {
    userCaps.set(HOUSEHOLD_USER_ID, ["manage_server_security"]);
    const res = await app.inject({
      method: "GET",
      url: "/api/security/audit-log",
      headers: { Authorization: `Bearer ${householdToken}` },
    });
    // In production, policyContext supplies the exact actorRole. In
    // this isolated route test there is no policyContext, so fallback
    // must be fail-closed: userId !== ownerId is NOT owner even when
    // the cap list includes manage_server_security.
    expect(res.statusCode).toBe(403);
  });

  // M128 P0.2 (TP6.b, 2026-05-28): rung-by-rung audit-log gate. Per
  // permission-model.md §6 grid, `view_audit_log` is held by owner +
  // admin only; superuser / member / contributor / guest lack it and
  // are 403'd by the cap check at the route head.
  test("admin holds view_audit_log → 200", async () => {
    userCaps.set(HOUSEHOLD_USER_ID, ["view_audit_log"]);
    const res = await app.inject({
      method: "GET",
      url: "/api/security/audit-log",
      headers: { Authorization: `Bearer ${householdToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  test("superuser lacks view_audit_log → 403", async () => {
    // superuser bundle (per ladder) = admin minus
    // {manage_members, manage_groups, manage_roles, manage_agents,
    //  view_audit_log, manage_billing}. So even a superuser without
    // the cap is denied — regardless of how many *other* caps they hold.
    userCaps.set(HOUSEHOLD_USER_ID, [
      "manage_rooms",
      "use_high_impact_tools",
      "approve_destructive_actions",
      "manage_standing_approvals",
    ]);
    const res = await app.inject({
      method: "GET",
      url: "/api/security/audit-log",
      headers: { Authorization: `Bearer ${householdToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  test("member lacks view_audit_log → 403", async () => {
    userCaps.set(HOUSEHOLD_USER_ID, [
      "manage_rooms",
      "use_high_impact_tools",
      "read_memories",
    ]);
    const res = await app.inject({
      method: "GET",
      url: "/api/security/audit-log",
      headers: { Authorization: `Bearer ${householdToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  test("contributor lacks view_audit_log → 403", async () => {
    userCaps.set(HOUSEHOLD_USER_ID, [
      "read_memories",
      "use_research_tools",
    ]);
    const res = await app.inject({
      method: "GET",
      url: "/api/security/audit-log",
      headers: { Authorization: `Bearer ${householdToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  test("guest (no caps) → 403", async () => {
    userCaps.set(HOUSEHOLD_USER_ID, []);
    const res = await app.inject({
      method: "GET",
      url: "/api/security/audit-log",
      headers: { Authorization: `Bearer ${householdToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  test("owner sees recent audit rows with limit + kind filters", async () => {
    writeSecurityAuditEvent(auditLogPath, {
      kind: "posture_changed",
      ts: "2026-04-24T12:00:00.000Z",
      actorId: OWNER_ACTOR_ID,
      ip: "127.0.0.1",
      userAgent: "test",
      prev: { deploymentMode: "desktop-permissive", securityLevel: "cautious" },
      next: { deploymentMode: "server", securityLevel: "paranoid" },
    });
    writeSecurityAuditEvent(auditLogPath, {
      kind: "capability_check_failed",
      ts: "2026-04-24T12:01:00.000Z",
      actorId: HOUSEHOLD_ACTOR_ID,
      ip: "127.0.0.1",
      userAgent: "test",
      capability: "manage_server_security",
      attemptedRoute: "PUT /api/security/posture",
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/security/audit-log?limit=1&kinds=posture_changed",
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body: {
      events: readonly SecurityAuditEvent[];
      hasMore: boolean;
    } = res.json();
    expect(body.events.length).toBe(1);
    expect(body.events[0]?.kind).toBe("posture_changed");
    expect(body.hasMore).toBe(false);
  });

  test("audit continuation returns 400 when malformed and 409 when stale", async () => {
    writeSecurityAuditEvent(auditLogPath, {
      kind: "posture_changed",
      ts: "2026-04-24T12:00:00.000Z",
      actorId: OWNER_ACTOR_ID,
      ip: "127.0.0.1",
      userAgent: "test",
      prev: { deploymentMode: "desktop-permissive", securityLevel: "cautious" },
      next: { deploymentMode: "server", securityLevel: "paranoid" },
    });
    writeSecurityAuditEvent(auditLogPath, {
      kind: "posture_changed",
      ts: "2026-04-24T12:01:00.000Z",
      actorId: OWNER_ACTOR_ID,
      ip: "127.0.0.1",
      userAgent: "test",
      prev: { deploymentMode: "server", securityLevel: "paranoid" },
      next: { deploymentMode: "server", securityLevel: "cautious" },
    });
    const malformed = await app.inject({
      method: "GET",
      url: "/api/security/audit-log?cursor=not-a-cursor",
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(malformed.statusCode).toBe(400);
    expect(JSON.parse(malformed.body)).toEqual({ error: "invalid_audit_cursor" });

    const first = await app.inject({
      method: "GET",
      url: "/api/security/audit-log?limit=1",
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const cursor = (JSON.parse(first.body) as { nextCursor: string }).nextCursor;
    writeSecurityAuditEvent(auditLogPath, {
      kind: "posture_changed",
      ts: "2026-04-24T12:02:00.000Z",
      actorId: OWNER_ACTOR_ID,
      ip: "127.0.0.1",
      userAgent: "test",
      prev: { deploymentMode: "server", securityLevel: "cautious" },
      next: { deploymentMode: "server", securityLevel: "standard" },
    });
    const stale = await app.inject({
      method: "GET",
      url: `/api/security/audit-log?limit=1&cursor=${encodeURIComponent(cursor)}`,
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(stale.statusCode).toBe(409);
    expect(JSON.parse(stale.body)).toEqual({ error: "stale_audit_cursor" });
  });
});

// ---------------------------------------------------------------------------
// PUT /api/security/posture — G5.3.c mutation
// ---------------------------------------------------------------------------

interface PutResponse {
  readonly deploymentMode: string;
  readonly securityLevel: string;
  readonly allowUncontainedHostCommands: boolean;
  readonly networkPolicy: {
    readonly mode: string;
    readonly allow?: readonly unknown[];
  };
  readonly capabilities: readonly string[];
  readonly changed: boolean;
}

describe("PUT /api/security/posture", () => {
  // Seed posture to a known value so prev-snapshot assertions are
  // stable across test ordering.
  beforeEach(() => {
    setConfigOverrides({
      nautilo_deployment_mode: "desktop-permissive",
      nautilo_security_level: "cautious",
    });
  });

  test("401 without Bearer token — mutator not invoked", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/security/posture",
      payload: { deploymentMode: "server", pin: OWNER_PIN },
    });
    expect(res.statusCode).toBe(401);
    expect(mutatorCalls.length).toBe(0);
  });

  test("G5.5 regression: non-owner actor with cap + own PIN succeeds (SEC-2: PIN verify keyed on session.actorId)", async () => {
    // Pre-G5.5 the route passed anyone matching ownerActorId. G5.5
    // swapped to real cap lookup AND SEC-2 swapped PIN verify to
    // key on session.actorId (not ownerActorId). Grant the
    // household actor the cap + enroll THEIR pin + verify they get
    // through. If the old owner-keyed PIN verify leaked back in,
    // the household\u0027s PIN would not match the owner\u0027s → 401.
    userCaps.set(HOUSEHOLD_USER_ID, ["manage_server_security"]);
    pinProvider.enrollActor(HOUSEHOLD_USER_ID, HOUSEHOLD_PIN);
    const res = await app.inject({
      method: "PUT",
      url: "/api/security/posture",
      headers: { Authorization: `Bearer ${householdToken}` },
      payload: { deploymentMode: "server", pin: HOUSEHOLD_PIN },
    });
    expect(res.statusCode).toBe(200);
    expect(mutatorCalls.length).toBe(1);
  });

  test("G5.5 regression: non-owner cap holder WITHOUT own PIN → 401 (SEC-2: can\u0027t borrow owner\u0027s PIN)", async () => {
    // Symmetric check. Household has the cap but NOT their own PIN.
    // Even if they submit the OWNER\u0027S valid PIN, verify is keyed
    // on session.actorId which has no enrolled PIN → 401. Owner\u0027s
    // PIN is NOT a master key.
    userCaps.set(HOUSEHOLD_USER_ID, ["manage_server_security"]);
    // Intentionally no enrollActor for HOUSEHOLD_USER_ID.
    const res = await app.inject({
      method: "PUT",
      url: "/api/security/posture",
      headers: { Authorization: `Bearer ${householdToken}` },
      payload: { deploymentMode: "server", pin: OWNER_PIN },
    });
    expect(res.statusCode).toBe(401);
    expect(mutatorCalls.length).toBe(0);
    // pin_check_failed audit still fires — ship plan §5.8.
    expect(auditCalls.length).toBe(1);
    expect(auditCalls[0]?.kind).toBe("pin_check_failed");
  });

  test("G5.5 regression: owner-actor WITHOUT the cap gets 403 (not a pre-G5.5 owner-heuristic pass)", async () => {
    // The symmetric check: if someone forgets to seed
    // manage_server_security into the owner Role, the route must
    // 403 rather than fall back to "but they\u0027re the owner
    // actor". Pre-G5.5 code would have let this through.
    userCaps.set(OWNER_USER_ID, []);
    const res = await app.inject({
      method: "PUT",
      url: "/api/security/posture",
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: { deploymentMode: "server", pin: OWNER_PIN },
    });
    expect(res.statusCode).toBe(403);
    expect(mutatorCalls.length).toBe(0);
    expect(auditCalls.length).toBe(1);
    expect(auditCalls[0]?.kind).toBe("capability_check_failed");
  });

  test("403 for actor without cap — mutator not invoked + capability_check_failed audit row written (ship plan §5.8)", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/security/posture",
      headers: {
        Authorization: `Bearer ${householdToken}`,
        "User-Agent": "probe/1.0",
      },
      payload: { deploymentMode: "server", pin: OWNER_PIN },
    });
    expect(res.statusCode).toBe(403);
    const body: { error: string; capability: string } = res.json();
    expect(body.error).toBe("capability_missing");
    expect(body.capability).toBe("manage_server_security");
    expect(mutatorCalls.length).toBe(0);

    expect(auditCalls.length).toBe(1);
    const audit = auditCalls[0]!;
    expect(audit.kind).toBe("capability_check_failed");
    if (audit.kind !== "capability_check_failed") throw new Error("narrow");
    expect(audit.actorId).toBe(HOUSEHOLD_ACTOR_ID);
    expect(audit.capability).toBe("manage_server_security");
    expect(audit.attemptedRoute).toBe("PUT /api/security/posture");
    expect(audit.userAgent).toBe("probe/1.0");
  });

  test("400 when PIN is missing — mutator not invoked", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/security/posture",
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: { deploymentMode: "server" },
    });
    expect(res.statusCode).toBe(400);
    const body: { error: string } = res.json();
    expect(body.error).toBe("PIN is required");
    expect(mutatorCalls.length).toBe(0);
  });

  test("400 when neither deploymentMode nor securityLevel supplied", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/security/posture",
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: { pin: OWNER_PIN },
    });
    expect(res.statusCode).toBe(400);
    expect(mutatorCalls.length).toBe(0);
  });

  test("400 for invalid deploymentMode (enum reject)", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/security/posture",
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: { deploymentMode: "yolo-mode", pin: OWNER_PIN },
    });
    expect(res.statusCode).toBe(400);
    const body: { error: string; valid: readonly string[] } = res.json();
    expect(body.error).toBe("Invalid deploymentMode");
    expect(body.valid).toEqual([
      "server",
      "desktop-permissive",
      "desktop-locked",
    ]);
  });

  test("400 for invalid securityLevel", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/security/posture",
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: { securityLevel: "insane", pin: OWNER_PIN },
    });
    expect(res.statusCode).toBe(400);
    const body: { error: string } = res.json();
    expect(body.error).toBe("Invalid securityLevel");
  });

  test("401 for invalid PIN — mutator not invoked + pin_check_failed audit row written", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/security/posture",
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: { deploymentMode: "server", pin: "999999" },
    });
    expect(res.statusCode).toBe(401);
    const body: { error: string } = res.json();
    expect(body.error).toBe("Invalid PIN");
    expect(mutatorCalls.length).toBe(0);

    expect(auditCalls.length).toBe(1);
    const audit = auditCalls[0]!;
    expect(audit.kind).toBe("pin_check_failed");
    if (audit.kind !== "pin_check_failed") throw new Error("narrow");
    expect(audit.actorId).toBe(OWNER_ACTOR_ID);
    expect(audit.pinOutcome).toBe("invalid");
    expect(audit.attemptedRoute).toBe("PUT /api/security/posture");
  });

  test("200 happy path invokes mutator with prev/next + actor/ip/ua", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/security/posture",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "User-Agent": "test-client/1.0",
      },
      payload: { deploymentMode: "server", pin: OWNER_PIN },
    });
    expect(res.statusCode).toBe(200);
    const body: PutResponse = res.json();
    expect(body.deploymentMode).toBe("server");
    expect(body.securityLevel).toBe("cautious"); // unchanged
    expect(body.networkPolicy).toEqual({ mode: "isolated" });
    expect(body.changed).toBe(true);
    expect(body.capabilities).toEqual(["manage_server_security"]);

    expect(mutatorCalls.length).toBe(1);
    const call = mutatorCalls[0]!;
    expect(call.actorId).toBe(OWNER_ACTOR_ID);
    expect(call.userAgent).toBe("test-client/1.0");
    expect(typeof call.ip).toBe("string");
    expect(call.prev).toEqual({
      deploymentMode: "desktop-permissive",
      securityLevel: "cautious",
      networkPolicy: { mode: "host" },
      allowUncontainedHostCommands: false,
    });
    expect(call.next).toEqual({
      deploymentMode: "server",
      securityLevel: "cautious",
      networkPolicy: { mode: "isolated" },
      allowUncontainedHostCommands: false,
    });
  });

  test("D538: policy-only PUT requires manage_uncontained_host_commands", async () => {
    userCaps.set(OWNER_USER_ID, ["manage_uncontained_host_commands"]);
    const res = await app.inject({
      method: "PUT",
      url: "/api/security/posture",
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: { allowUncontainedHostCommands: true, pin: OWNER_PIN },
    });
    expect(res.statusCode).toBe(200);
    const body: PutResponse = res.json();
    expect(body.allowUncontainedHostCommands).toBe(true);
    expect(body.changed).toBe(true);
    expect(mutatorCalls).toHaveLength(1);
    expect(mutatorCalls[0]?.prev.allowUncontainedHostCommands).toBe(false);
    expect(mutatorCalls[0]?.next.allowUncontainedHostCommands).toBe(true);
  });

  test("D538: policy-only PUT rejects manage_server_security without the dedicated capability", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/security/posture",
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: { allowUncontainedHostCommands: true, pin: OWNER_PIN },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<Record<string, unknown>>()).toEqual({
      error: "capability_missing",
      capability: "manage_uncontained_host_commands",
    });
    expect(mutatorCalls).toHaveLength(0);
  });

  test("D538: existing posture fields still require manage_server_security", async () => {
    userCaps.set(OWNER_USER_ID, ["manage_uncontained_host_commands"]);
    const res = await app.inject({
      method: "PUT",
      url: "/api/security/posture",
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: { deploymentMode: "server", pin: OWNER_PIN },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<Record<string, unknown>>()).toEqual({
      error: "capability_missing",
      capability: "manage_server_security",
    });
    expect(mutatorCalls).toHaveLength(0);
  });

  test("D538: mixed PUT requires both capabilities with one PIN", async () => {
    const payload = {
      deploymentMode: "server",
      allowUncontainedHostCommands: true,
      pin: OWNER_PIN,
    };
    const onlySecurity = await app.inject({
      method: "PUT",
      url: "/api/security/posture",
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload,
    });
    expect(onlySecurity.statusCode).toBe(403);
    expect(onlySecurity.json<Record<string, unknown>>()).toEqual({
      error: "capability_missing",
      capability: "manage_uncontained_host_commands",
    });

    userCaps.set(OWNER_USER_ID, ["manage_uncontained_host_commands"]);
    const onlyPolicy = await app.inject({
      method: "PUT",
      url: "/api/security/posture",
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload,
    });
    expect(onlyPolicy.statusCode).toBe(403);
    expect(onlyPolicy.json<Record<string, unknown>>()).toEqual({
      error: "capability_missing",
      capability: "manage_server_security",
    });

    userCaps.set(OWNER_USER_ID, [
      "manage_server_security",
      "manage_uncontained_host_commands",
    ]);
    const both = await app.inject({
      method: "PUT",
      url: "/api/security/posture",
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload,
    });
    expect(both.statusCode).toBe(200);
    expect(both.json<PutResponse>().capabilities).toEqual([
      "manage_server_security",
      "manage_uncontained_host_commands",
    ]);
    expect(mutatorCalls).toHaveLength(1);
  });

  test("D538: rejects non-boolean policy values before PIN verification", async () => {
    userCaps.set(OWNER_USER_ID, ["manage_uncontained_host_commands"]);
    const res = await app.inject({
      method: "PUT",
      url: "/api/security/posture",
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: { allowUncontainedHostCommands: "true", pin: OWNER_PIN },
    });
    expect(res.statusCode).toBe(400);
    const body: { error: string } = res.json();
    expect(body).toEqual({ error: "Invalid allowUncontainedHostCommands" });
    expect(mutatorCalls).toHaveLength(0);
  });

  test("D103: explicit networkPolicy is preserved when deploymentMode changes", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/security/posture",
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: {
        deploymentMode: "server",
        networkPolicy: { mode: "host" },
        pin: OWNER_PIN,
      },
    });
    expect(res.statusCode).toBe(200);
    const body: PutResponse = res.json();
    expect(body.deploymentMode).toBe("server");
    expect(body.networkPolicy).toEqual({ mode: "host" });
    expect(mutatorCalls[0]!.next.networkPolicy).toEqual({ mode: "host" });
  });

  test("D103: networkPolicy mutation is PIN/capability gated and reaches mutator", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/security/posture",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "User-Agent": "test-client/1.0",
      },
      payload: {
        networkPolicy: {
          mode: "proxy-allowlist",
          allow: [{ type: "domain", host: "api.openai.com" }],
        },
        pin: OWNER_PIN,
      },
    });
    expect(res.statusCode).toBe(200);
    const body: PutResponse = res.json();
    expect(body.networkPolicy).toEqual({
      mode: "proxy-allowlist",
      allow: [{ type: "domain", host: "api.openai.com" }],
    });
    expect(mutatorCalls.length).toBe(1);
    expect(mutatorCalls[0]!.next.networkPolicy).toEqual({
      mode: "proxy-allowlist",
      allow: [{ type: "domain", host: "api.openai.com" }],
    });
  });

  test("D103: invalid networkPolicy is rejected before PIN verify", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/security/posture",
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: {
        networkPolicy: { mode: "isolated", allow: [] },
        pin: OWNER_PIN,
      },
    });
    expect(res.statusCode).toBe(400);
    const body: { error: string } = res.json();
    expect(body.error).toBe("Invalid networkPolicy");
    expect(mutatorCalls.length).toBe(0);
  });

  test.each([
    [{ type: "domain", host: "https://api.openai.com" }],
    [{ type: "domain", host: "api.openai.com:443" }],
    [{ type: "domain", host: "127.0.0.1" }],
    [{ type: "domain", host: " api.openai.com " }],
    [{ type: "wildcard", suffix: "*" }],
    [{ type: "wildcard", suffix: "https://github.com" }],
    [{ type: "wildcard", suffix: " github.com " }],
    [{ type: "cidr", cidr: "0xc0a80100/24" }],
    [{ type: "cidr", cidr: "not-a-cidr" }],
    [{ type: "domain", host: "api.openai.com", extra: "ignored?" }],
  ])("D103: malformed network allow rule is rejected: %o", async (rule) => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/security/posture",
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: {
        networkPolicy: {
          mode: "proxy-allowlist",
          allow: [rule],
        },
        pin: OWNER_PIN,
      },
    });
    expect(res.statusCode).toBe(400);
    const body: { error: string } = res.json();
    expect(body.error).toBe("Invalid networkPolicy");
    expect(mutatorCalls.length).toBe(0);
  });

  test("no-op short-circuit when next == prev → changed=false, no mutator call", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/security/posture",
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: {
        deploymentMode: "desktop-permissive",
        securityLevel: "cautious",
        pin: OWNER_PIN,
      },
    });
    expect(res.statusCode).toBe(200);
    const body: PutResponse = res.json();
    expect(body.changed).toBe(false);
    expect(mutatorCalls.length).toBe(0);
  });

  test("validation runs BEFORE PIN verify (no burned verify attempts on obviously-bad payloads)", async () => {
    // Invalid mode + invalid PIN: if validation ran AFTER PIN, the
    // invalid PIN would show up as 401 first and feed into the
    // lockout window. Validation-first behavior means a fat-finger
    // on the UI doesn't count against the brute-force budget.
    const res = await app.inject({
      method: "PUT",
      url: "/api/security/posture",
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: { deploymentMode: "bogus", pin: "also-bogus" },
    });
    expect(res.statusCode).toBe(400);
    const body: { error: string } = res.json();
    expect(body.error).toBe("Invalid deploymentMode");
  });
});

// PR-017 MINOR #6 — enforce the SecurityAuditor "must not prevent
// 4xx from reaching the caller" contract AT THE CALL SITE, not
// just in the docstring. Previously every `await auditEvent(...)`
// in `security.ts` was unwrapped; a thrown auditor would surface
// as a 500 to the caller, breaking the ship-plan §5.8 invariant.
// Hardened via the module-local `safeAudit()` helper that wraps
// every call — regardless of what the injected implementation
// does, the 4xx reaches the caller.
describe("PUT /api/security/posture — safeAudit contract (PR-017 MINOR #6)", () => {
  test("thrown auditor does NOT convert capability_missing 403 into a 500", async () => {
    // Standalone app with a THROWING auditor. Household token (no
    // cap) → route should 403 with error=capability_missing even
    // though the auditor throws on the capability_check_failed row.
    const throwingApp = Fastify({ logger: false });
    const throwingStore = new SessionStore(undefined, { persistPath: null });
    installBearerSessionPreHandler(throwingApp, throwingStore);
    const throwingPinProvider = new FakeChallengeProvider();
    const throwingToken = throwingStore.createSession(
      HOUSEHOLD_ACTOR_ID,
      OWNER_USER_ID,
      HOUSEHOLD_USER_ID,
    ).token;
    securityRoutes(throwingApp, {
      pinProvider: throwingPinProvider,
      mutatePosture: async () => {
        /* not reached on the capability-missing branch */
      },
      auditEvent: async () => {
        throw new Error("synthetic auditor failure");
      },
      getCapabilities: () => Promise.resolve([]), // no cap
    });
    await throwingApp.ready();

    const res = await throwingApp.inject({
      method: "PUT",
      url: "/api/security/posture",
      headers: { Authorization: `Bearer ${throwingToken}` },
      payload: {
        deploymentMode: "desktop-locked",
        pin: "whatever",
      },
    });
    expect(res.statusCode).toBe(403);
    const body: { error: string; capability: string } = res.json();
    expect(body.error).toBe("capability_missing");
    expect(body.capability).toBe("manage_server_security");

    await throwingApp.close();
  });

  test("thrown auditor does NOT convert pin_check_failed 401 into a 500", async () => {
    // Standalone app: cap holder but wrong PIN → should 401 with
    // error=Invalid PIN even though the auditor throws.
    const throwingApp = Fastify({ logger: false });
    const throwingStore = new SessionStore(undefined, { persistPath: null });
    installBearerSessionPreHandler(throwingApp, throwingStore);
    const throwingPinProvider = new FakeChallengeProvider();
    throwingPinProvider.enrollActor(OWNER_USER_ID, OWNER_PIN);
    const throwingToken = throwingStore.createSession(
      OWNER_ACTOR_ID,
      OWNER_USER_ID,
      OWNER_USER_ID,
    ).token;
    securityRoutes(throwingApp, {
      pinProvider: throwingPinProvider,
      mutatePosture: async () => {
        /* not reached on pin failure */
      },
      auditEvent: async () => {
        throw new Error("synthetic auditor failure");
      },
      getCapabilities: () => Promise.resolve(["manage_server_security"]),
    });
    await throwingApp.ready();

    const res = await throwingApp.inject({
      method: "PUT",
      url: "/api/security/posture",
      headers: { Authorization: `Bearer ${throwingToken}` },
      payload: {
        deploymentMode: "desktop-locked",
        pin: "wrong-pin", // triggers pin_check_failed path
      },
    });
    // The specific 4xx can be 401 (invalid) or 429 (lockout). Both
    // are acceptable — the invariant is "no 500". Lockout depends
    // on fake provider's counter state which isn't pinned here.
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(res.statusCode).not.toBe(500);

    await throwingApp.close();
  });
});
