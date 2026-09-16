/**
 * D418 — production wiring integration coverage for the Full Workstation
 * activation/disable route.
 *
 * Two integration surfaces, both exercising REAL collaborators (no fake
 * `RelayBindingProvider`):
 *
 *   1. `createApp` route registration — the real production app mounts
 *      `workstationAccessRoutes` with the real
 *      `createRelayRegistryBindingProvider` + real
 *      `InMemoryWorkstationSessionRegistry` + the real security-audit
 *      writer. With no desktop relay advertised the provider resolves
 *      `null` and the route returns a truthful 404
 *      `relay_binding_unavailable` — proving the wiring is fail-closed
 *      and never fabricates a binding.
 *
 *   2. Real provider + real registries + real route — a minimal Fastify
 *      app registers a real `InMemoryRelayRegistry` (with snapshots),
 *      the real `createRelayRegistryBindingProvider`, the real
 *      `InMemoryWorkstationSessionRegistry`, and the real
 *      `workstationAccessRoutes`. Covers: binding derivation from
 *      registry state, headless / missing-snapshot / mismatched-grant
 *      rejection, audit redaction, and transient relay-disconnect session
 *      preservation.
 */

import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { LockoutError, type ChallengeProvider, type RbacProjection } from "@nautilo/trust";
import type { RelayCapabilities } from "@nautilo/relay";
import {
  and,
  capabilities,
  eq,
  groupMembers,
  profiles,
  roleCapabilities,
  roles,
  users,
} from "@nautilo/db";
import {
  FULL_WORKSTATION_AGENT_SCOPE,
  InMemoryRelayRegistry,
  InMemoryWorkstationSessionRegistry,
  type FullWorkstationBinding,
  type WorkstationAccessAuditEvent,
} from "@nautilo/runtime";
import { setupOwnerAppFixture, seatPeerUser, type AppFixture } from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";
import { SessionStore } from "../helpers/test-session-store";
import {
  createRelayRegistryBindingProvider,
  createRelayRegistryProfileActivationProvider,
  createWorkstationAccessRegistry,
  workstationAccessRoutes,
} from "../../src/routes/workstation-access";
import { UncontainedHostCommandsController } from "../../src/routes/security";
import { verifyWorkstationStartupReceipt } from "../../src/workstation-startup-receipt";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const OWNER_ACTOR_ID = "owner-actor";
const OWNER_USER_ID = "owner-user";
const OWNER_PIN = "246810";
const RELAY_ID = "relay-1";
const DESKTOP_SESSION_ID = "desktop-session-1";
const INSTANCE_ID = "instance-1";
const SERVER_BINDING_ID = "server-binding-test";
const PROFILE_ID = "profile-developer-workstation";
const GRANT_ID = "grant-1";
const PAIRING_GENERATION = "pairing-1";
const STARTUP_RECEIPT_SECRET = "startup-receipt-integration-secret-material-32";

const VALID_GRANT_SNAPSHOT = {
  revision: 7,
  instanceId: INSTANCE_ID,
  agentScope: FULL_WORKSTATION_AGENT_SCOPE,
  grants: [
    {
      id: GRANT_ID,
      canonicalRoot: "/Users/alice/project",
      access: ["read", "create_modify"] as const,
      policyVersion: 2,
      lifetime: "durable" as const,
    },
  ],
};

const VALID_PROFILE_SNAPSHOT = {
  profileId: PROFILE_ID,
  profileRevision: 1,
  grantIds: [GRANT_ID],
  protectedPolicyVersion: 2,
  networkMode: "isolated" as const,
  capabilities: [
    { id: "cap-bun", backend: "sandboxed" as const },
  ],
};

/** The binding the real provider is expected to derive from the snapshots. */
function expectedBinding(): FullWorkstationBinding {
  return {
    userId: OWNER_USER_ID,
    instanceId: INSTANCE_ID,
    relayId: RELAY_ID,
    desktopSessionId: DESKTOP_SESSION_ID,
    serverBindingId: SERVER_BINDING_ID,
    pairingGeneration: PAIRING_GENERATION,
    agentScope: FULL_WORKSTATION_AGENT_SCOPE,
    profileId: PROFILE_ID,
    profileRevision: 1,
    grantIds: [GRANT_ID],
    // D418 — capabilityRevision must be a POSITIVE safe integer (>= 1) for
    // activation, so the relay registers with revision 1 (not the 0 default).
    capabilityRevision: 1,
  };
}

/** Client payload = the binding minus userId (stamped from the session). */
function clientPayload(overrides: Partial<FullWorkstationBinding> = {}) {
  const b = expectedBinding();
  const { userId: _userId, ...rest } = { ...b, ...overrides };
  return rest;
}

/**
 * D418 — client payload for /activate-profile: profile selectors + relay
 * binding evidence + PIN. No roots/env/executables/grants/subject/profile
 * payload. The desktop main supplies relayId / desktopSessionId / instanceId
 * from authoritative main-side state; profileId + profileRevision are the
 * selected stored profile's identity.
 */
function profileActivationBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pin: OWNER_PIN,
    profileId: PROFILE_ID,
    profileRevision: 1,
    relayId: RELAY_ID,
    desktopSessionId: DESKTOP_SESSION_ID,
    instanceId: INSTANCE_ID,
    ...overrides,
  };
}

type RouteBody = {
  error?: string;
  ok?: boolean;
  outcome?: string;
  authorization?: string;
  startupReceipt?: string;
  session?: { serverBindingId?: string; profileId?: string } | null;
};

function responseBody(res: { json(): unknown }): RouteBody {
  return res.json() as RouteBody;
}

class FakeChallengeProvider implements ChallengeProvider {
  private readonly pins = new Map<string, string>();
  enroll(userId: string, pin: string): void {
    this.pins.set(userId, pin);
  }
  verifyProof(userId: string, proof: string): Promise<boolean> {
    if (proof === "LOCK") throw new LockoutError(30_000);
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

// ===========================================================================
// (1) createApp route registration — real production app wiring
// ===========================================================================

describe("createApp wiring — /api/workstation-access/* (D418)", () => {
  let fx: AppFixture;

  beforeAll(async () => {
    fx = await setupOwnerAppFixture({ suiteName: "wsx" });
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

  test("activate is registered and 401s without a bearer session", async () => {
    const res = await fx.app.inject({
      method: "POST",
      url: "/api/workstation-access/activate",
      headers: { "content-type": "application/json" },
      payload: { pin: OWNER_PIN, binding: clientPayload() },
    });
    expect(res.statusCode).toBe(401);
    expect(responseBody(res).error).toBe("Authentication required");
  });

  test("activate returns a truthful 404 relay_binding_unavailable when no desktop advertises a profile", async () => {
    // No relay is registered on the production relay registry, so the real
    // binding provider resolves null. The route must NOT fabricate a binding
    // — it returns a truthful 404 instead. The owner holds
    // use_workstation (D418 seeded role bundle; activation
    // requires ONLY use_workstation — control_desktop is an
    // independent tool gate), so this reaches the provider, not a 403.
    const bearer = await fx.mintOwnerBearer();
    const res = await fx.app.inject({
      method: "POST",
      url: "/api/workstation-access/activate",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bearer}`,
      },
      payload: { pin: OWNER_PIN, binding: clientPayload() },
    });
    expect(res.statusCode).toBe(404);
    expect(responseBody(res).error).toBe("relay_binding_unavailable");
  });

  test("disable is registered and 401s without a bearer session", async () => {
    const res = await fx.app.inject({
      method: "POST",
      url: "/api/workstation-access/disable",
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  test("activate-profile is registered and 401s without a bearer session", async () => {
    const res = await fx.app.inject({
      method: "POST",
      url: "/api/workstation-access/activate-profile",
      headers: { "content-type": "application/json" },
      payload: profileActivationBody(),
    });
    expect(res.statusCode).toBe(401);
    expect(responseBody(res).error).toBe("Authentication required");
  });

  test("activate-profile returns a truthful 404 relay_binding_unavailable when no desktop advertises a profile", async () => {
    // No relay is registered on the production relay registry, so the real
    // profile-activation provider resolves null. The route must NOT
    // fabricate a binding — it returns a truthful 404 instead. The owner
    // holds use_workstation (D418 seeded role bundle; activation
    // requires ONLY use_workstation), so this reaches the
    // provider, not a 403.
    const bearer = await fx.mintOwnerBearer();
    const res = await fx.app.inject({
      method: "POST",
      url: "/api/workstation-access/activate-profile",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bearer}`,
      },
      payload: profileActivationBody(),
    });
    expect(res.statusCode).toBe(404);
    expect(responseBody(res).error).toBe("relay_binding_unavailable");
  });
});

// ===========================================================================
// (1b) Real production app + REAL DB effective capabilities — the
// Casey+Alex policy seam. `setupOwnerAppFixture` boots the real
// `createApp`, which wires `workstationAccessRoutes` with
// `getCapabilities: (userId) => getUserCapabilities(userId)` (real
// server-wide Group→Role→Capability JOIN, no test double). Seating a
// fixture peer into a canonical ladder Group via `seatPeerUser` therefore
// gives the route the peer's REAL effective caps.
//
// Activation requires ONLY `use_workstation` + a paired binding +
// the caller's own PIN; `control_desktop` is an independent tool gate, not
// an activation gate. So:
//   - a Member (real caps include use_workstation) passes the
//     activation cap gate and reaches the relay-binding provider, which
//     resolves null (no desktop relay advertised) → truthful 404
//     `relay_binding_unavailable`.
//   - a Contributor (real caps lack use_workstation) is denied at
//     the cap gate → 403 `capability_missing` naming
//     `use_workstation`.
//
// SEAM NOTE: `setupOwnerAppFixture` boots `createApp` directly (NOT
// `bin/nautilo-server`), so `seedTrustPersonal` is NOT re-run by the
// fixture. The scratch DB's `role_capabilities` therefore reflects
// whatever ladder was seeded by the last real server boot. To exercise
// the CORRECTED Casey+Alex ladder (Member keeps
// use_workstation), the Member test below idempotently re-wires
// the `member` role's `use_workstation` grant to match the
// corrected seed (`seedTrustPersonal`'s M128 reseed does this on the next
// real server boot). The Contributor test needs no re-wire — Contributor
// lacks use_workstation in both the pre- and post-correction
// ladder. The full activate happy path (relay binding + PIN proof +
// registry.activate) is covered by the unit suite with an injected
// registry; that harness is the existing seam for the post-cap-gate steps
// and is not duplicated here.
// ===========================================================================

/**
 * Idempotently ensure the `member` ladder Role carries the
 * `use_workstation` capability, mirroring the corrected
 * `seedTrustPersonal` M128 reseed. The only difference between the
 * pre- and post-correction `member` bundle IS this cap, so adding it
 * alone brings the stale scratch DB's member role to the corrected
 * effective-cap set. No-op when already wired.
 */
async function ensureMemberHasWorkstationProfiles(
  db: AppFixture["db"],
): Promise<{
  inserted: boolean;
  roleId: string;
  capabilityId: string;
}> {
  const [memberRole] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.slug, "member"))
    .limit(1);
  if (!memberRole) throw new Error("member role missing — did seedTrustPersonal run?");
  const [cap] = await db
    .select({ id: capabilities.id })
    .from(capabilities)
    .where(eq(capabilities.slug, "use_workstation"))
    .limit(1);
  if (!cap) throw new Error("use_workstation capability missing");
  const insertedRows = await db
    .insert(roleCapabilities)
    .values({ roleId: memberRole.id, capabilityId: cap.id })
    .onConflictDoNothing({
      target: [roleCapabilities.roleId, roleCapabilities.capabilityId],
    })
    .returning({
      roleId: roleCapabilities.roleId,
      capabilityId: roleCapabilities.capabilityId,
    });
  return {
    inserted: insertedRows.length === 1,
    roleId: memberRole.id,
    capabilityId: cap.id,
  };
}

describe("workstation-access real DB effective-cap gate (D418 Casey+Alex policy)", () => {
  let fx: AppFixture;

  beforeAll(async () => {
    fx = await setupOwnerAppFixture({ suiteName: "wsmgate" });
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

  test("a Member passes the activation cap gate and reaches the relay-binding provider (404 relay_binding_unavailable)", async () => {
    // Re-wire the member role to the corrected ladder (Casey+Alex:
    // Member keeps use_workstation). Idempotent; mirrors the
    // seedTrustPersonal M128 reseed that a real server boot performs.
    const edge = await ensureMemberHasWorkstationProfiles(fx.db);
    let member: Awaited<ReturnType<typeof seatPeerUser>> | null = null;
    try {
      member = await seatPeerUser(fx.db, {
        suiteName: "wsmgate",
        groupType: "members",
      });
      // The member's REAL effective caps now include
      // use_workstation (mirrors the server-wide-rbac matrix)
      // but NOT the independent device-control / profile-management caps.
      const res = await authedInject(fx.app, {
        method: "POST",
        url: "/api/workstation-access/activate",
        bearer: member.bearer,
        payload: { pin: "any-non-blank-pin", binding: clientPayload() },
      });
      // Member holds use_workstation → cap gate passes → binding
      // shape parses → pin non-blank → relay binding resolves null (no
      // desktop advertised) → truthful 404. NOT 403.
      expect(res.statusCode).toBe(404);
      expect(responseBody(res).error).toBe("relay_binding_unavailable");
    } finally {
      try {
        if (member) {
          await fx.db.delete(groupMembers).where(eq(groupMembers.userId, member.userId));
          await fx.db.delete(profiles).where(eq(profiles.userId, member.userId));
          await fx.db.delete(users).where(eq(users.id, member.userId));
        }
      } finally {
        // Restore shared catalogue state only when this test inserted the
        // edge. Never remove a pre-existing corrected seed edge, even when
        // an assertion or fixture-user cleanup fails.
        if (edge.inserted) {
          await fx.db
            .delete(roleCapabilities)
            .where(
              and(
                eq(roleCapabilities.roleId, edge.roleId),
                eq(roleCapabilities.capabilityId, edge.capabilityId),
              ),
            );
        }
      }
    }
  }, 60000);

  test("a Contributor is denied at the activation cap gate (403 capability_missing: use_workstation)", async () => {
    const contributor = await seatPeerUser(fx.db, {
      suiteName: "wscgate",
      groupType: "contributors",
    });
    try {
      const res = await authedInject(fx.app, {
        method: "POST",
        url: "/api/workstation-access/activate",
        bearer: contributor.bearer,
        payload: { pin: "any-non-blank-pin", binding: clientPayload() },
      });
      // Contributor lacks use_workstation → cap gate denies
      // BEFORE the binding is parsed or the relay provider is consulted.
      expect(res.statusCode).toBe(403);
      expect(responseBody(res).error).toBe("capability_missing");
      expect(res.json()).toHaveProperty("capability", "use_workstation");
    } finally {
      await fx.db.delete(groupMembers).where(eq(groupMembers.userId, contributor.userId));
      await fx.db.delete(profiles).where(eq(profiles.userId, contributor.userId));
      await fx.db.delete(users).where(eq(users.id, contributor.userId));
    }
  }, 60000);
});

// ===========================================================================
// (2) Real provider + real registries + real route wiring
// ===========================================================================

describe("workstation-access real provider + registry wiring (D418)", () => {
  let app: FastifyInstance;
  let sessionStore: SessionStore;
  let ownerToken: string;
  let pinProvider: FakeChallengeProvider;
  let relayRegistry: InMemoryRelayRegistry;
  let sessionRegistry: InMemoryWorkstationSessionRegistry;
  let auditCalls: WorkstationAccessAuditEvent[];
  let uncontainedHostCommands: UncontainedHostCommandsController;
  let uncontainedInvalidations: Promise<void>[];

  const uncontainedProjection: RbacProjection = {
    highestRole: "superuser",
    capabilitySlugs: [],
    groupChips: [{
      id: "uncontained-host-commands-grantees",
      type: "uncontained_host_commands_grantees",
      label: "Uncontained host commands grantees",
      roleSlug: "uncontained_host_commands_grantee",
    }],
  };

  function createUncontainedHostCommandsController(): UncontainedHostCommandsController {
    return new UncontainedHostCommandsController({
      pinProvider,
      getAllowUncontainedHostCommands: () => true,
      getRbac: async () => uncontainedProjection,
      getLiveRelayBinding: ({ userId, relayId, desktopSessionId }) => {
        const matches = relayRegistry.snapshotForUser(userId).filter((snapshot) =>
          snapshot.relayId === relayId &&
          snapshot.desktopSessionId === desktopSessionId &&
          snapshot.capabilities.profile === "desktop-agent",
        );
        if (matches.length !== 1) return null;
        const snapshot = matches[0]!;
        return {
          userId: snapshot.userId,
          serverBindingId: SERVER_BINDING_ID,
          relayId: snapshot.relayId,
          desktopSessionId,
          pairingGeneration: snapshot.pairingGeneration,
          capabilityRevision: snapshot.capabilityRevision,
        };
      },
      auditEvent: async () => {},
    });
  }

  async function activateUncontained(): Promise<void> {
    const result = await uncontainedHostCommands.activate({
      userId: OWNER_USER_ID,
      actorId: OWNER_ACTOR_ID,
      pin: OWNER_PIN,
      relayId: RELAY_ID,
      desktopSessionId: DESKTOP_SESSION_ID,
      ip: "127.0.0.1",
      userAgent: "integration-test",
    });
    expect(result.ok).toBe(true);
  }

  async function uncontainedIsActive(): Promise<boolean> {
    return (await uncontainedHostCommands.status({
      userId: OWNER_USER_ID,
      actorId: OWNER_ACTOR_ID,
      relayId: RELAY_ID,
      desktopSessionId: DESKTOP_SESSION_ID,
      ip: "127.0.0.1",
      userAgent: "integration-test",
    })).active;
  }

  function invalidateUncontained(input: Parameters<UncontainedHostCommandsController["invalidateForRelayBinding"]>[0]): void {
    uncontainedInvalidations.push(uncontainedHostCommands.invalidateForRelayBinding(input));
  }

  async function registerRelay(
    caps: RelayCapabilities,
    opts: {
      desktopSessionId?: string | null;
      capabilityRevision?: number;
      pairingGeneration?: string;
    } = {},
  ): Promise<void> {
    // `desktopSessionId: null` registers a HEADLESS relay (no session id);
    // omitting it defaults to the desktop session id. capabilityRevision
    // defaults to 1: a Full Workstation binding requires a positive (>= 1)
    // capability revision to activate. pairingGeneration defaults to the
    // server-derived pairing id (the validated relay-token row id).
    const desktopSessionId =
      opts.desktopSessionId === undefined ? DESKTOP_SESSION_ID : opts.desktopSessionId;
    const pairingGeneration =
      opts.pairingGeneration === undefined ? PAIRING_GENERATION : opts.pairingGeneration;
    await relayRegistry.register(
      RELAY_ID,
      OWNER_USER_ID,
      caps,
      () => {},
      9,
      desktopSessionId ?? undefined,
      opts.capabilityRevision ?? 1,
      pairingGeneration,
    );
  }

  function fullCaps(overrides: Partial<RelayCapabilities> = {}): RelayCapabilities {
    return {
      profile: "desktop-agent",
      desktopFilesystemGrantSnapshot: VALID_GRANT_SNAPSHOT,
      workstationProfileSnapshot: VALID_PROFILE_SNAPSHOT,
      ...overrides,
    } as RelayCapabilities;
  }

  beforeAll(async () => {
    sessionStore = new SessionStore(undefined, { persistPath: null });
    pinProvider = new FakeChallengeProvider();
    pinProvider.enroll(OWNER_USER_ID, OWNER_PIN);
    auditCalls = [];
    sessionRegistry = createWorkstationAccessRegistry({
      audit: (e) => auditCalls.push(e),
    });
    // Mirror app.ts: transient disconnects preserve a session bound to the
    // same desktopSessionId. Explicit disable/re-pair/server-switch paths
    // invalidate it separately. The app-restart seam (same relay/user
    // re-registers with a DIFFERENT non-empty desktopSessionId) is wired to
    // invalidateForRelayBinding against the previous desktop session, exactly
    // as app.ts wires `onDesktopSessionReplaced`.
    relayRegistry = new InMemoryRelayRegistry({
      onRemotePresenceChanged: (input) => {
        if (
          input.previous !== null &&
          input.current !== null &&
          input.previous.userId === input.current.userId &&
          input.previous.desktopSessionId !== null &&
          input.previous.capabilityRevision !== input.current.capabilityRevision
        ) {
          invalidateUncontained({
            userId: input.previous.userId,
            relayId: input.previous.relayId,
            desktopSessionId: input.previous.desktopSessionId,
            pairingGeneration: input.previous.pairingGeneration,
            capabilityRevision: input.previous.capabilityRevision,
            reason: "capability_revision_changed",
          });
        }
      },
      onDesktopSessionReplaced: (input) => {
        invalidateUncontained({
          userId: input.userId,
          relayId: input.relayId,
          desktopSessionId: input.previousDesktopSessionId,
          reason: "desktop_session_replaced",
        });
        sessionRegistry.invalidateForRelayBinding({
          userId: input.userId,
          serverBindingId: SERVER_BINDING_ID,
          relayId: input.relayId,
          desktopSessionId: input.previousDesktopSessionId,
        });
      },
      onPairingGenerationChanged: (input) => {
        invalidateUncontained({
          userId: input.userId,
          relayId: input.relayId,
          desktopSessionId: input.desktopSessionId,
          pairingGeneration: input.previousPairingGeneration,
          reason: "pairing_generation_changed",
        });
        // D418 Commit 2 — mirror app.ts: a re-pair (same relay/user/desktop
        // session, different server-derived pairing generation) invalidates
        // the bound session, pinned by the prior generation.
        sessionRegistry.invalidateForRelayBinding({
          userId: input.userId,
          serverBindingId: SERVER_BINDING_ID,
          relayId: input.relayId,
          desktopSessionId: input.desktopSessionId,
          pairingGeneration: input.previousPairingGeneration,
        });
      },
      onUnregister: (input) => {
        invalidateUncontained({
          userId: input.userId,
          relayId: input.relayId,
          desktopSessionId: input.desktopSessionId,
          reason: "relay_unregistered",
        });
      },
      // D418 reconnect/session split-brain fix — mirror app.ts: when a
      // desktop relay's profile binding snapshot transitions present→absent,
      // invalidate any Full Workstation session + plans bound to that relay
      // so a session never survives the loss of its relay's profile
      // snapshot (which would let the no-plan run_shell gate skip).
      onWorkstationProfileSnapshotCleared: (input) => {
        sessionRegistry.invalidateForRelayBinding({
          userId: input.userId,
          serverBindingId: SERVER_BINDING_ID,
          relayId: input.relayId,
          desktopSessionId: input.desktopSessionId,
          ...(input.pairingGeneration !== undefined
            ? { pairingGeneration: input.pairingGeneration }
            : {}),
        });
      },
      // D418 reconnect/session split-brain fix — mirror app.ts: expose the
      // live active session to the agent tools node's session-aware
      // missing-snapshot run_shell gate.
      getActiveWorkstationSession: (userId) => {
        const session = sessionRegistry.get(userId);
        if (session === null) return null;
        return {
          userId: session.userId,
          relayId: session.relayId,
          desktopSessionId: session.desktopSessionId,
          capabilityRevision: session.capabilityRevision,
        };
      },
    });

    app = Fastify({ logger: false });
    installBearerSessionPreHandler(app, sessionStore);
    workstationAccessRoutes(app, {
      relayRegistry,
      pinProvider,
      // D418 — activation requires ONLY use_workstation
      // (control_desktop is an independent tool gate, not an activation
      // gate); disable is capability-independent. The owner fixture holds
      // use_workstation (and control_desktop), so the cap gate
      // passes for the activation happy path.
      getCapabilities: () =>
        Promise.resolve(["control_desktop", "use_workstation"]),
      relayBindingProvider: createRelayRegistryBindingProvider({
        relayRegistry,
        serverBindingId: SERVER_BINDING_ID,
      }),
      // D418 — profile-selector activation seam. Derives the authoritative
      // binding from the relay registry's grant snapshot + the desktop
      // main's profile selectors, so the FIRST activation of an approved
      // stored profile can be gated by the user's OWN fresh PIN at the
      // server boundary.
      profileActivationProvider: createRelayRegistryProfileActivationProvider({
        relayRegistry,
        serverBindingId: SERVER_BINDING_ID,
      }),
      registry: sessionRegistry,
      auditEvent: async (event) => {
        auditCalls.push(event);
      },
      startupReceiptSecret: () => STARTUP_RECEIPT_SECRET,
    });
    await app.ready();

    uncontainedInvalidations = [];
    uncontainedHostCommands = createUncontainedHostCommandsController();

    ownerToken = sessionStore.createSession(
      OWNER_ACTOR_ID,
      OWNER_USER_ID,
      OWNER_USER_ID,
    ).token;
  });

  beforeEach(async () => {
    // Reset registry + relay state between tests.
    sessionRegistry.disable(OWNER_USER_ID);
    await relayRegistry.unregister(RELAY_ID);
    auditCalls = [];
    uncontainedInvalidations = [];
    uncontainedHostCommands = createUncontainedHostCommandsController();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  describe("createRelayRegistryBindingProvider — registry-state derivation", () => {
    test("resolves a binding from a registered relay's grant + profile snapshots", async () => {
      const provider = createRelayRegistryBindingProvider({
        relayRegistry,
        serverBindingId: SERVER_BINDING_ID,
      });
      await registerRelay(fullCaps());
      const binding = await provider.resolve({
        userId: OWNER_USER_ID,
        relayId: RELAY_ID,
        desktopSessionId: DESKTOP_SESSION_ID,
        instanceId: INSTANCE_ID,
      });
      expect(binding).toEqual(expectedBinding());
    });

    test("returns null for an unknown relay", async () => {
      const provider = createRelayRegistryBindingProvider({
        relayRegistry,
        serverBindingId: SERVER_BINDING_ID,
      });
      const binding = await provider.resolve({
        userId: OWNER_USER_ID,
        relayId: "never-registered",
        desktopSessionId: DESKTOP_SESSION_ID,
        instanceId: INSTANCE_ID,
      });
      expect(binding).toBeNull();
    });

    test("returns null when the registry owner user does not match the caller", async () => {
      const provider = createRelayRegistryBindingProvider({
        relayRegistry,
        serverBindingId: SERVER_BINDING_ID,
      });
      await registerRelay(fullCaps());
      const binding = await provider.resolve({
        userId: "foreign-user",
        relayId: RELAY_ID,
        desktopSessionId: DESKTOP_SESSION_ID,
        instanceId: INSTANCE_ID,
      });
      expect(binding).toBeNull();
    });

    test("returns null for a headless relay (no desktopSessionId)", async () => {
      const provider = createRelayRegistryBindingProvider({
        relayRegistry,
        serverBindingId: SERVER_BINDING_ID,
      });
      await registerRelay(fullCaps(), { desktopSessionId: null });
      const binding = await provider.resolve({
        userId: OWNER_USER_ID,
        relayId: RELAY_ID,
        desktopSessionId: DESKTOP_SESSION_ID,
        instanceId: INSTANCE_ID,
      });
      expect(binding).toBeNull();
    });

    test("returns null when the profile snapshot is missing", async () => {
      const provider = createRelayRegistryBindingProvider({
        relayRegistry,
        serverBindingId: SERVER_BINDING_ID,
      });
      await registerRelay(
        fullCaps({ workstationProfileSnapshot: undefined }),
      );
      const binding = await provider.resolve({
        userId: OWNER_USER_ID,
        relayId: RELAY_ID,
        desktopSessionId: DESKTOP_SESSION_ID,
        instanceId: INSTANCE_ID,
      });
      expect(binding).toBeNull();
    });

    test("returns null when the grant snapshot is missing", async () => {
      const provider = createRelayRegistryBindingProvider({
        relayRegistry,
        serverBindingId: SERVER_BINDING_ID,
      });
      await registerRelay(
        fullCaps({ desktopFilesystemGrantSnapshot: undefined }),
      );
      const binding = await provider.resolve({
        userId: OWNER_USER_ID,
        relayId: RELAY_ID,
        desktopSessionId: DESKTOP_SESSION_ID,
        instanceId: INSTANCE_ID,
      });
      expect(binding).toBeNull();
    });

    test("returns null on mismatched profile/grant state (profile grant not active)", async () => {
      const provider = createRelayRegistryBindingProvider({
        relayRegistry,
        serverBindingId: SERVER_BINDING_ID,
      });
      await registerRelay(
        fullCaps({
          workstationProfileSnapshot: {
            ...VALID_PROFILE_SNAPSHOT,
            grantIds: ["grant-not-in-snapshot"],
          },
        }),
      );
      const binding = await provider.resolve({
        userId: OWNER_USER_ID,
        relayId: RELAY_ID,
        desktopSessionId: DESKTOP_SESSION_ID,
        instanceId: INSTANCE_ID,
      });
      expect(binding).toBeNull();
    });

    test("returns null when the grant snapshot instanceId does not match", async () => {
      const provider = createRelayRegistryBindingProvider({
        relayRegistry,
        serverBindingId: SERVER_BINDING_ID,
      });
      await registerRelay(fullCaps());
      const binding = await provider.resolve({
        userId: OWNER_USER_ID,
        relayId: RELAY_ID,
        desktopSessionId: DESKTOP_SESSION_ID,
        instanceId: "foreign-instance",
      });
      expect(binding).toBeNull();
    });
  });

  describe("route → real provider → real registry activation", () => {
    test("activates a session end-to-end from registry-advertised snapshots", async () => {
      await registerRelay(fullCaps());
      const res = await app.inject({
        method: "POST",
        url: "/api/workstation-access/activate",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${ownerToken}`,
        },
        payload: { pin: OWNER_PIN, binding: clientPayload() },
      });
      expect(res.statusCode).toBe(200);
      const body = responseBody(res);
      expect(body.ok).toBe(true);
      expect(body.outcome).toBe("activated");
      expect(body.session?.serverBindingId).toBe(SERVER_BINDING_ID);
      expect(body.session?.profileId).toBe(PROFILE_ID);
      expect(sessionRegistry.get(OWNER_USER_ID)?.profileId).toBe(PROFILE_ID);
    });

    test("404 relay_binding_unavailable when no relay is registered (truthful, no fabrication)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/workstation-access/activate",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${ownerToken}`,
        },
        payload: { pin: OWNER_PIN, binding: clientPayload() },
      });
      expect(res.statusCode).toBe(404);
      expect(responseBody(res).error).toBe("relay_binding_unavailable");
      expect(sessionRegistry.get(OWNER_USER_ID)).toBeNull();
    });

    test("404 when the relay is headless (no profile snapshot advertised)", async () => {
      await registerRelay(
        fullCaps({ workstationProfileSnapshot: undefined }),
      );
      const res = await app.inject({
        method: "POST",
        url: "/api/workstation-access/activate",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${ownerToken}`,
        },
        payload: { pin: OWNER_PIN, binding: clientPayload() },
      });
      expect(res.statusCode).toBe(404);
      expect(responseBody(res).error).toBe("relay_binding_unavailable");
    });
  });

  describe("audit redaction", () => {
    test("emitted audit events carry no PIN, roots, env, token, or raw profile data", async () => {
      await registerRelay(fullCaps());
      await app.inject({
        method: "POST",
        url: "/api/workstation-access/activate",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${ownerToken}`,
        },
        payload: { pin: OWNER_PIN, binding: clientPayload() },
      });
      const activated = auditCalls.find(
        (e) => e.kind === "workstation_session_activated",
      );
      expect(activated).toBeDefined();
      // Redaction: the audit envelope carries only identifiers + outcome.
      // No PIN, command output, roots, env values, tokens, or raw profile
      // fields (canonicalRoot / access / networkMode / capabilities /
      // protectedPolicyVersion) appear.
      const serialized = JSON.stringify(activated);
      expect(serialized).not.toContain("pin");
      expect(serialized).not.toContain("commandOutput");
      expect(serialized).not.toContain("canonicalRoot");
      expect(serialized).not.toContain("networkMode");
      expect(serialized).not.toContain("protectedPolicyVersion");
      expect(serialized).not.toContain("token");
      // Only the allowed Full Workstation audit kinds are emitted.
      const allowedKinds = new Set<WorkstationAccessAuditEvent["kind"]>([
        "workstation_session_activated",
        "workstation_session_narrowed",
        "workstation_session_broadened",
        "workstation_session_switched",
        "workstation_session_invalidated",
        "workstation_session_disabled",
        "workstation_session_denied",
      ]);
      for (const e of auditCalls) {
        expect(allowedKinds.has(e.kind)).toBe(true);
      }
    });
  });

  describe("transient relay disconnects", () => {
    test("unregistering a relay preserves its bound Full Workstation session", async () => {
      await registerRelay(fullCaps());
      const activateRes = await app.inject({
        method: "POST",
        url: "/api/workstation-access/activate",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${ownerToken}`,
        },
        payload: { pin: OWNER_PIN, binding: clientPayload() },
      });
      expect(activateRes.statusCode).toBe(200);
      expect(sessionRegistry.get(OWNER_USER_ID)).not.toBeNull();

      // A socket loss must not force a second PIN. The same desktop session
      // can reconnect and resume the exact server-side binding.
      await relayRegistry.unregister(RELAY_ID);

      expect(sessionRegistry.get(OWNER_USER_ID)).not.toBeNull();
      expect(
        auditCalls.some((e) => e.kind === "workstation_session_invalidated"),
      ).toBe(false);
    });

    test("a foreign relay unregister does not invalidate an unrelated session", async () => {
      await registerRelay(fullCaps());
      await app.inject({
        method: "POST",
        url: "/api/workstation-access/activate",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${ownerToken}`,
        },
        payload: { pin: OWNER_PIN, binding: clientPayload() },
      });
      expect(sessionRegistry.get(OWNER_USER_ID)).not.toBeNull();
      // Unregister a different, unknown relay — must not touch the active
      // session.
      await relayRegistry.unregister("relay-other");
      expect(sessionRegistry.get(OWNER_USER_ID)).not.toBeNull();
    });
  });

  describe("D538 production relay lifecycle wiring", () => {
    test("unregister invalidates the in-memory uncontained-host-command session", async () => {
      await registerRelay(fullCaps());
      await activateUncontained();
      expect(await uncontainedIsActive()).toBe(true);

      await relayRegistry.unregister(RELAY_ID);
      await Promise.all(uncontainedInvalidations);

      expect(await uncontainedIsActive()).toBe(false);
    });

    test("Desktop replacement invalidates the prior uncontained session", async () => {
      await registerRelay(fullCaps());
      await activateUncontained();

      await registerRelay(fullCaps(), { desktopSessionId: "desktop-session-2" });
      await Promise.all(uncontainedInvalidations);

      expect(await uncontainedIsActive()).toBe(false);
    });

    test("re-pair invalidates the prior uncontained session", async () => {
      await registerRelay(fullCaps());
      await activateUncontained();

      await registerRelay(fullCaps(), { pairingGeneration: "pairing-re-paired" });
      await Promise.all(uncontainedInvalidations);

      expect(await uncontainedIsActive()).toBe(false);
    });

    test("capability revision change invalidates the prior uncontained session", async () => {
      await registerRelay(fullCaps());
      await activateUncontained();

      expect(relayRegistry.updateCapabilities({
        relayId: RELAY_ID,
        userId: OWNER_USER_ID,
        desktopSessionId: DESKTOP_SESSION_ID,
        capabilityRevision: 2,
        capabilities: fullCaps(),
      })).toEqual({ ok: true });
      await Promise.all(uncontainedInvalidations);

      expect(await uncontainedIsActive()).toBe(false);
    });
  });

  describe("app-restart desktop-session invalidation (D418)", () => {
    test("re-registering the same relay/user with a different desktopSessionId invalidates the old session", async () => {
      await registerRelay(fullCaps());
      const activateRes = await app.inject({
        method: "POST",
        url: "/api/workstation-access/activate",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${ownerToken}`,
        },
        payload: { pin: OWNER_PIN, binding: clientPayload() },
      });
      expect(activateRes.statusCode).toBe(200);
      expect(sessionRegistry.get(OWNER_USER_ID)?.desktopSessionId).toBe(DESKTOP_SESSION_ID);

      // App restart: the same relay/user re-registers with a NEW
      // desktopSessionId (a fresh Electron main-process launch). The
      // production-wired `onDesktopSessionReplaced` hook must invalidate the
      // Full Workstation session bound to the dead desktop session.
      await registerRelay(fullCaps(), { desktopSessionId: "desktop-session-2" });

      expect(sessionRegistry.get(OWNER_USER_ID)).toBeNull();
      expect(
        auditCalls.some((e) => e.kind === "workstation_session_invalidated"),
      ).toBe(true);
    });

    test("re-registering with the SAME desktopSessionId does NOT invalidate (transient reconnect resumes)", async () => {
      await registerRelay(fullCaps());
      await app.inject({
        method: "POST",
        url: "/api/workstation-access/activate",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${ownerToken}`,
        },
        payload: { pin: OWNER_PIN, binding: clientPayload() },
      });
      expect(sessionRegistry.get(OWNER_USER_ID)).not.toBeNull();

      // A transient socket reconnect re-uses the same desktopSessionId — the
      // session must survive (no invalidation).
      await registerRelay(fullCaps(), { desktopSessionId: DESKTOP_SESSION_ID });

      expect(sessionRegistry.get(OWNER_USER_ID)).not.toBeNull();
      expect(
        auditCalls.some((e) => e.kind === "workstation_session_invalidated"),
      ).toBe(false);
    });

    test("a headless re-register (no desktopSessionId) does NOT invalidate a desktop session", async () => {
      await registerRelay(fullCaps());
      await app.inject({
        method: "POST",
        url: "/api/workstation-access/activate",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${ownerToken}`,
        },
        payload: { pin: OWNER_PIN, binding: clientPayload() },
      });
      expect(sessionRegistry.get(OWNER_USER_ID)).not.toBeNull();

      // Re-register as headless (empty desktopSessionId). The hook only fires
      // for a DIFFERENT non-empty desktopSessionId, so a headless re-register
      // must not invalidate the prior desktop session.
      await registerRelay(fullCaps(), { desktopSessionId: null });

      expect(sessionRegistry.get(OWNER_USER_ID)).not.toBeNull();
      expect(
        auditCalls.some((e) => e.kind === "workstation_session_invalidated"),
      ).toBe(false);
    });
  });

  describe("re-pair pairing-generation invalidation (D418 Commit 2)", () => {
    test("re-registering with the SAME desktopSessionId but a DIFFERENT pairingGeneration invalidates the session", async () => {
      await registerRelay(fullCaps());
      const activateRes = await app.inject({
        method: "POST",
        url: "/api/workstation-access/activate",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${ownerToken}`,
        },
        payload: { pin: OWNER_PIN, binding: clientPayload() },
      });
      expect(activateRes.statusCode).toBe(200);
      expect(sessionRegistry.get(OWNER_USER_ID)?.pairingGeneration).toBe(PAIRING_GENERATION);

      // Explicit re-pair: the same relay/user re-registers with the SAME
      // desktopSessionId but a NEW server-derived pairingGeneration (a new
      // validated relay-token row id). The production-wired
      // `onPairingGenerationChanged` hook must invalidate the Full Workstation
      // session even though desktopSessionId is reused.
      await registerRelay(fullCaps(), { pairingGeneration: "pairing-re-paired" });

      expect(sessionRegistry.get(OWNER_USER_ID)).toBeNull();
      expect(
        auditCalls.some((e) => e.kind === "workstation_session_invalidated"),
      ).toBe(true);
    });
  });

  // =========================================================================
  // D418 reconnect/session split-brain fix — a Full Workstation session must
  // NOT survive the loss of its relay's advisory Workstation Profile binding
  // snapshot. The production-wired `onWorkstationProfileSnapshotCleared` hook
  // invalidates the session + plans when a desktop relay's snapshot
  // transitions present→absent (reconnect with frozen pre-activation caps,
  // profile deactivation, a refresh that transiently cleared the snapshot).
  // =========================================================================
  describe("profile-snapshot-loss session invalidation (D418 reconnect/session split-brain fix)", () => {
    test("re-registering with the SAME desktopSessionId but NO profile snapshot invalidates the session", async () => {
      await registerRelay(fullCaps());
      const activateRes = await app.inject({
        method: "POST",
        url: "/api/workstation-access/activate",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${ownerToken}`,
        },
        payload: { pin: OWNER_PIN, binding: clientPayload() },
      });
      expect(activateRes.statusCode).toBe(200);
      expect(sessionRegistry.get(OWNER_USER_ID)).not.toBeNull();

      // The split-brain bug: a reconnect re-registers frozen pre-activation
      // capabilities (no profile snapshot) with the SAME desktopSessionId +
      // pairingGeneration. The production-wired
      // `onWorkstationProfileSnapshotCleared` hook must invalidate the
      // session so the no-plan run_shell gate cannot skip on a null
      // snapshot under an active session.
      await registerRelay(
        fullCaps({ workstationProfileSnapshot: undefined }),
      );

      expect(sessionRegistry.get(OWNER_USER_ID)).toBeNull();
      expect(
        auditCalls.some((e) => e.kind === "workstation_session_invalidated"),
      ).toBe(true);
    });

    test("an updateCapabilities that omits the profile snapshot invalidates the session (refresh clears snapshot)", async () => {
      await registerRelay(fullCaps());
      await app.inject({
        method: "POST",
        url: "/api/workstation-access/activate",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${ownerToken}`,
        },
        payload: { pin: OWNER_PIN, binding: clientPayload() },
      });
      expect(sessionRegistry.get(OWNER_USER_ID)).not.toBeNull();

      // A capability refresh that drops the profile binding snapshot (e.g.
      // the controller was transiently unavailable during a grant mutation
      // re-advertise) must invalidate the session — fail closed rather than
      // preserve a session that can run unbound generic shells.
      const result = relayRegistry.updateCapabilities({
        relayId: RELAY_ID,
        userId: OWNER_USER_ID,
        desktopSessionId: DESKTOP_SESSION_ID,
        capabilityRevision: 2,
        capabilities: {
          profile: "desktop-agent",
          desktopFilesystemGrantSnapshot: VALID_GRANT_SNAPSHOT,
        } as RelayCapabilities,
      });
      expect(result).toEqual({ ok: true });

      expect(sessionRegistry.get(OWNER_USER_ID)).toBeNull();
      expect(
        auditCalls.some((e) => e.kind === "workstation_session_invalidated"),
      ).toBe(true);
    });

    test("re-registering WITH the profile snapshot preserves the session (healthy reconnect)", async () => {
      await registerRelay(fullCaps());
      await app.inject({
        method: "POST",
        url: "/api/workstation-access/activate",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${ownerToken}`,
        },
        payload: { pin: OWNER_PIN, binding: clientPayload() },
      });
      expect(sessionRegistry.get(OWNER_USER_ID)).not.toBeNull();

      // A healthy reconnect re-advertises the profile snapshot — no
      // present→absent transition, so the session survives.
      await registerRelay(fullCaps());

      expect(sessionRegistry.get(OWNER_USER_ID)).not.toBeNull();
      expect(
        auditCalls.some((e) => e.kind === "workstation_session_invalidated"),
      ).toBe(false);
    });
  });

  // =========================================================================
  // D418 — profile-selector activation seam (/activate-profile) with the
  // REAL provider + real registries + real route. This is the seam that
  // unblocks the FIRST activation of an approved stored profile before any
  // compiled profile snapshot is advertised: the server derives every
  // authority-bearing field from the relay registry's grant snapshot + the
  // client's profile selectors, gates on capability + the user's OWN fresh
  // PIN, and records the session.
  // =========================================================================

  describe("createRelayRegistryProfileActivationProvider — grant-snapshot derivation", () => {
    test("resolves a binding from the grant snapshot + client profile selectors (no profile snapshot required)", async () => {
      const provider = createRelayRegistryProfileActivationProvider({
        relayRegistry,
        serverBindingId: SERVER_BINDING_ID,
      });
      await registerRelay(fullCaps());
      const binding = await provider.resolve({
        userId: OWNER_USER_ID,
        relayId: RELAY_ID,
        desktopSessionId: DESKTOP_SESSION_ID,
        instanceId: INSTANCE_ID,
        profileId: "selected-profile-7",
        profileRevision: 3,
      });
      expect(binding).toEqual({
        userId: OWNER_USER_ID,
        instanceId: INSTANCE_ID,
        relayId: RELAY_ID,
        desktopSessionId: DESKTOP_SESSION_ID,
        serverBindingId: SERVER_BINDING_ID,
        pairingGeneration: PAIRING_GENERATION,
        agentScope: FULL_WORKSTATION_AGENT_SCOPE,
        // Profile selectors stamped in from the client (trusted desktop main).
        profileId: "selected-profile-7",
        profileRevision: 3,
        // grantIds derived from the grant snapshot's active grants.
        grantIds: [GRANT_ID],
        capabilityRevision: 1,
      });
    });

    test("returns null for an unknown relay", async () => {
      const provider = createRelayRegistryProfileActivationProvider({
        relayRegistry,
        serverBindingId: SERVER_BINDING_ID,
      });
      const binding = await provider.resolve({
        userId: OWNER_USER_ID,
        relayId: "never-registered",
        desktopSessionId: DESKTOP_SESSION_ID,
        instanceId: INSTANCE_ID,
        profileId: PROFILE_ID,
        profileRevision: 1,
      });
      expect(binding).toBeNull();
    });

    test("returns null when the registry owner user does not match the caller (foreign relay)", async () => {
      const provider = createRelayRegistryProfileActivationProvider({
        relayRegistry,
        serverBindingId: SERVER_BINDING_ID,
      });
      await registerRelay(fullCaps());
      const binding = await provider.resolve({
        userId: "foreign-user",
        relayId: RELAY_ID,
        desktopSessionId: DESKTOP_SESSION_ID,
        instanceId: INSTANCE_ID,
        profileId: PROFILE_ID,
        profileRevision: 1,
      });
      expect(binding).toBeNull();
    });

    test("returns null for a headless relay (no desktopSessionId)", async () => {
      const provider = createRelayRegistryProfileActivationProvider({
        relayRegistry,
        serverBindingId: SERVER_BINDING_ID,
      });
      await registerRelay(fullCaps(), { desktopSessionId: null });
      const binding = await provider.resolve({
        userId: OWNER_USER_ID,
        relayId: RELAY_ID,
        desktopSessionId: DESKTOP_SESSION_ID,
        instanceId: INSTANCE_ID,
        profileId: PROFILE_ID,
        profileRevision: 1,
      });
      expect(binding).toBeNull();
    });

    test("returns null when the grant snapshot is missing", async () => {
      const provider = createRelayRegistryProfileActivationProvider({
        relayRegistry,
        serverBindingId: SERVER_BINDING_ID,
      });
      await registerRelay(
        fullCaps({ desktopFilesystemGrantSnapshot: undefined }),
      );
      const binding = await provider.resolve({
        userId: OWNER_USER_ID,
        relayId: RELAY_ID,
        desktopSessionId: DESKTOP_SESSION_ID,
        instanceId: INSTANCE_ID,
        profileId: PROFILE_ID,
        profileRevision: 1,
      });
      expect(binding).toBeNull();
    });

    test("returns null when the grant snapshot instanceId does not match (wrong binding)", async () => {
      const provider = createRelayRegistryProfileActivationProvider({
        relayRegistry,
        serverBindingId: SERVER_BINDING_ID,
      });
      await registerRelay(fullCaps());
      const binding = await provider.resolve({
        userId: OWNER_USER_ID,
        relayId: RELAY_ID,
        desktopSessionId: DESKTOP_SESSION_ID,
        instanceId: "foreign-instance",
        profileId: PROFILE_ID,
        profileRevision: 1,
      });
      expect(binding).toBeNull();
    });

    test("accepts capabilityRevision 0 as a phase-one preauthorization baseline", async () => {
      const provider = createRelayRegistryProfileActivationProvider({
        relayRegistry,
        serverBindingId: SERVER_BINDING_ID,
      });
      await registerRelay(fullCaps(), { capabilityRevision: 0 });
      const binding = await provider.resolve({
        userId: OWNER_USER_ID,
        relayId: RELAY_ID,
        desktopSessionId: DESKTOP_SESSION_ID,
        instanceId: INSTANCE_ID,
        profileId: PROFILE_ID,
        profileRevision: 1,
      });
      expect(binding?.capabilityRevision).toBe(0);
    });
  });

  describe("route → real profile-activation provider → real registry", () => {
    test("phase one issues no session; phase two commits only after exact profile snapshot and revision bump", async () => {
      // Baseline is allowed to be zero-grant/revision-0 and has no profile
      // snapshot. It issues a ticket but never grants Full Mode.
      await registerRelay(
        fullCaps({
          workstationProfileSnapshot: undefined,
          desktopFilesystemGrantSnapshot: { ...VALID_GRANT_SNAPSHOT, grants: [] },
        }),
        { capabilityRevision: 0 },
      );
      const res = await app.inject({
        method: "POST",
        url: "/api/workstation-access/activate-profile",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${ownerToken}`,
        },
        payload: profileActivationBody(),
      });
      expect(res.statusCode).toBe(200);
      const ticket = responseBody(res).authorization;
      expect(ticket).toBeString();
      expect(responseBody(res).startupReceipt).toBeUndefined();
      expect(sessionRegistry.get(OWNER_USER_ID)).toBeNull();

      // Simulate Electron compile + awaited capability ACK: exact profile
      // snapshot, non-empty compiled grants, and revision strictly > baseline.
      await registerRelay(fullCaps(), { capabilityRevision: 1 });
      const complete = await app.inject({
        method: "POST",
        url: "/api/workstation-access/activate-profile/complete",
        headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
        payload: { authorization: ticket },
      });
      expect(complete.statusCode).toBe(200);
      const startupReceipt = responseBody(complete).startupReceipt;
      expect(
        verifyWorkstationStartupReceipt(
          STARTUP_RECEIPT_SECRET,
          startupReceipt,
        ),
      ).toEqual({
        userId: OWNER_USER_ID,
        instanceId: INSTANCE_ID,
        serverBindingId: SERVER_BINDING_ID,
        pairingGeneration: PAIRING_GENERATION,
        profileId: PROFILE_ID,
        profileRevision: 1,
      });
      expect(sessionRegistry.get(OWNER_USER_ID)?.profileId).toBe(PROFILE_ID);
      expect(sessionRegistry.get(OWNER_USER_ID)?.grantIds).toEqual([GRANT_ID]);

      // A later Desktop session may use the receipt to run the same two-phase
      // path without another PIN. The live provider and completion registry
      // still recheck the new Desktop session, compile ACK, and revision bump.
      sessionRegistry.disable(OWNER_USER_ID);
      const nextDesktopSessionId = "desktop-session-next";
      await registerRelay(
        fullCaps({
          workstationProfileSnapshot: undefined,
          desktopFilesystemGrantSnapshot: { ...VALID_GRANT_SNAPSHOT, grants: [] },
        }),
        { desktopSessionId: nextDesktopSessionId, capabilityRevision: 2 },
      );
      const restored = await app.inject({
        method: "POST",
        url: "/api/workstation-access/activate-profile",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${ownerToken}`,
        },
        payload: profileActivationBody({
          pin: undefined,
          startupReceipt,
          desktopSessionId: nextDesktopSessionId,
        }),
      });
      expect(restored.statusCode).toBe(200);
      expect(sessionRegistry.get(OWNER_USER_ID)).toBeNull();

      await registerRelay(fullCaps(), {
        desktopSessionId: nextDesktopSessionId,
        capabilityRevision: 3,
      });
      const restoredComplete = await app.inject({
        method: "POST",
        url: "/api/workstation-access/activate-profile/complete",
        headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
        payload: { authorization: responseBody(restored).authorization },
      });
      expect(restoredComplete.statusCode).toBe(200);
      expect(responseBody(restoredComplete).startupReceipt).toBe(startupReceipt);
      expect(sessionRegistry.get(OWNER_USER_ID)?.desktopSessionId).toBe(nextDesktopSessionId);
    });

    test("404 relay_binding_unavailable when no relay is registered (truthful, no fabrication)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/workstation-access/activate-profile",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${ownerToken}`,
        },
        payload: profileActivationBody(),
      });
      expect(res.statusCode).toBe(404);
      expect(responseBody(res).error).toBe("relay_binding_unavailable");
      expect(sessionRegistry.get(OWNER_USER_ID)).toBeNull();
    });

    test("404 when the relay is headless (no desktopSessionId)", async () => {
      await registerRelay(fullCaps(), { desktopSessionId: null });
      const res = await app.inject({
        method: "POST",
        url: "/api/workstation-access/activate-profile",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${ownerToken}`,
        },
        payload: profileActivationBody(),
      });
      expect(res.statusCode).toBe(404);
      expect(responseBody(res).error).toBe("relay_binding_unavailable");
    });

    test("404 when the grant snapshot is missing", async () => {
      await registerRelay(
        fullCaps({ desktopFilesystemGrantSnapshot: undefined }),
      );
      const res = await app.inject({
        method: "POST",
        url: "/api/workstation-access/activate-profile",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${ownerToken}`,
        },
        payload: profileActivationBody(),
      });
      expect(res.statusCode).toBe(404);
      expect(responseBody(res).error).toBe("relay_binding_unavailable");
    });

    test("401 on an invalid PIN (after capability + binding resolve pass)", async () => {
      await registerRelay(fullCaps());
      const res = await app.inject({
        method: "POST",
        url: "/api/workstation-access/activate-profile",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${ownerToken}`,
        },
        payload: profileActivationBody({ pin: "wrong-pin" }),
      });
      expect(res.statusCode).toBe(401);
      expect(responseBody(res).error).toBe("Invalid PIN");
      expect(sessionRegistry.get(OWNER_USER_ID)).toBeNull();
    });

    test("emitted audit events carry no PIN, roots, env, token, or raw profile data", async () => {
      await registerRelay(fullCaps());
      await app.inject({
        method: "POST",
        url: "/api/workstation-access/activate-profile",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${ownerToken}`,
        },
        payload: profileActivationBody(),
      });
      const serialized = JSON.stringify(auditCalls);
      expect(serialized).not.toContain("pin");
      expect(serialized).not.toContain("commandOutput");
      expect(serialized).not.toContain("canonicalRoot");
      expect(serialized).not.toContain("networkMode");
      expect(serialized).not.toContain("protectedPolicyVersion");
      expect(serialized).not.toContain("token");
    });
  });

  // =========================================================================
  // D418 default-instance — the real providers + real registries + real
  // route accept a canonical `instanceId: ""` (the default unnamed
  // instance) end-to-end. The grant snapshot carries `instanceId: ""`, the
  // real `createRelayRegistryBindingProvider` /
  // `createRelayRegistryProfileActivationProvider` derive a binding with
  // `instanceId: ""` (the explicit empty-ID rejection was removed; the
  // exact-equality check is preserved), and the route activates phase one
  // / commits a session exactly as for a named instance.
  // =========================================================================

  describe("default instanceId \"\" (D418)", () => {
    const DEFAULT_INSTANCE_ID = "";
    const DEFAULT_GRANT_SNAPSHOT = {
      ...VALID_GRANT_SNAPSHOT,
      instanceId: DEFAULT_INSTANCE_ID,
    };

    function defaultInstanceClientPayload(overrides: Partial<FullWorkstationBinding> = {}) {
      const b = expectedBinding();
      const { userId: _userId, ...rest } = { ...b, instanceId: DEFAULT_INSTANCE_ID, ...overrides };
      return rest;
    }

    test("createRelayRegistryBindingProvider resolves a binding with instanceId: \"\" from a default-instance grant snapshot", async () => {
      await registerRelay(fullCaps({ desktopFilesystemGrantSnapshot: DEFAULT_GRANT_SNAPSHOT }));
      const provider = createRelayRegistryBindingProvider({
        relayRegistry,
        serverBindingId: SERVER_BINDING_ID,
      });
      const binding = await provider.resolve({
        userId: OWNER_USER_ID,
        relayId: RELAY_ID,
        desktopSessionId: DESKTOP_SESSION_ID,
        instanceId: DEFAULT_INSTANCE_ID,
      });
      expect(binding).toEqual({ ...expectedBinding(), instanceId: DEFAULT_INSTANCE_ID });
    });

    test("createRelayRegistryBindingProvider returns null when the client instanceId does not exactly match a default-instance snapshot", async () => {
      await registerRelay(fullCaps({ desktopFilesystemGrantSnapshot: DEFAULT_GRANT_SNAPSHOT }));
      const provider = createRelayRegistryBindingProvider({
        relayRegistry,
        serverBindingId: SERVER_BINDING_ID,
      });
      // The snapshot carries "" but the client claims a named instance — the
      // preserved exact-equality check rejects it (no fabrication).
      const binding = await provider.resolve({
        userId: OWNER_USER_ID,
        relayId: RELAY_ID,
        desktopSessionId: DESKTOP_SESSION_ID,
        instanceId: "instance-1",
      });
      expect(binding).toBeNull();
    });

    test("route → real provider → real registry activates a default-instance session end-to-end", async () => {
      await registerRelay(fullCaps({ desktopFilesystemGrantSnapshot: DEFAULT_GRANT_SNAPSHOT }));
      const res = await app.inject({
        method: "POST",
        url: "/api/workstation-access/activate",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${ownerToken}`,
        },
        payload: { pin: OWNER_PIN, binding: defaultInstanceClientPayload() },
      });
      expect(res.statusCode).toBe(200);
      const body = responseBody(res);
      expect(body.ok).toBe(true);
      expect(body.outcome).toBe("activated");
      expect(body.session?.serverBindingId).toBe(SERVER_BINDING_ID);
      expect(sessionRegistry.get(OWNER_USER_ID)?.instanceId).toBe(DEFAULT_INSTANCE_ID);
    });

    test("createRelayRegistryProfileActivationProvider resolves a binding with instanceId: \"\" from a default-instance grant snapshot", async () => {
      await registerRelay(fullCaps({ desktopFilesystemGrantSnapshot: DEFAULT_GRANT_SNAPSHOT }));
      const provider = createRelayRegistryProfileActivationProvider({
        relayRegistry,
        serverBindingId: SERVER_BINDING_ID,
      });
      const binding = await provider.resolve({
        userId: OWNER_USER_ID,
        relayId: RELAY_ID,
        desktopSessionId: DESKTOP_SESSION_ID,
        instanceId: DEFAULT_INSTANCE_ID,
        profileId: "selected-profile-7",
        profileRevision: 3,
      });
      expect(binding).toEqual({
        ...expectedBinding(),
        instanceId: DEFAULT_INSTANCE_ID,
        profileId: "selected-profile-7",
        profileRevision: 3,
        grantIds: [GRANT_ID],
        capabilityRevision: 1,
      });
    });

    test("route → real profile-activation provider issues a phase-one ticket for a default-instance binding", async () => {
      await registerRelay(fullCaps({ desktopFilesystemGrantSnapshot: DEFAULT_GRANT_SNAPSHOT }));
      const res = await app.inject({
        method: "POST",
        url: "/api/workstation-access/activate-profile",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${ownerToken}`,
        },
        payload: profileActivationBody({ instanceId: DEFAULT_INSTANCE_ID }),
      });
      expect(res.statusCode).toBe(200);
      const body = responseBody(res);
      expect(body.ok).toBe(true);
      expect(body.authorization).toBeString();
      expect(sessionRegistry.get(OWNER_USER_ID)).toBeNull();
    });
  });
});
