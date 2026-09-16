import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../..", ".env") });

import {
  createDirectDb,
  ensureDatabase,
  seedTrustPersonal,
  users,
  actors,
  agents,
  credentials,
  channelIdentities,
  jobs,
  relayTokens,
  groups,
  groupMembers,
  namespaces,
  rooms,
  roomMembers,
  roles,
  sessions,
  sessionMessages,
  profiles,
  eq,
  and,
  inArray,
} from "@nautilo/db";
import {
  PersonalPolicyResolver,
  PinChallengeProvider,
  hashPin,
  setBootstrapOwnerId,
  setBootstrapOwnerActorId,
  setBootstrapDefaultAgentId,
  getBootstrapOwnerId,
  getBootstrapOwnerActorId,
  getBootstrapDefaultAgentId,
} from "@nautilo/trust";
import { composeFederatedId, getServerHostname, resolveInstance } from "@nautilo/config";
import type { CreateAppOptions } from "../../../src/app";
import { createApp } from "../../../src/app";
import type { FastifyInstance } from "fastify";
import type { KeyObject } from "node:crypto";
import { SignJWT, generateKeyPair } from "jose";
import {
  _resetJwksForTests,
  _setJwksKeyForTests,
} from "../../../../trust/src/logto-verifier";
import {
  _resetClockSkewForTests,
  _setProbeForTests,
} from "../../../../trust/src/logto-clock-skew";
import {
  _resetLogtoAdminClientForTests,
  _setLogtoAdminClientForTests,
  type LogtoAdminClient,
} from "../../../../trust/src/logto-admin";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";

// `seedTrustPersonal` reconciles the canonical Role→Capability catalogue by
// deleting and reinserting its scoped mappings. Serialize fixture calls so
// Bun's concurrent integration files exercise the production seed without
// racing that reconcile phase against each other.
let fixtureTrustSeedQueue: Promise<void> = Promise.resolve();

function seedFixtureTrustPersonal(ownerId: string, ownerName: string): Promise<void> {
  const pending = fixtureTrustSeedQueue.then(async () => {
    await seedTrustPersonal(ownerId, ownerName);
  });
  fixtureTrustSeedQueue = pending.catch(() => {});
  return pending;
}

/** Shared RS256 keypair for all integration fixtures (same issuer/aud/JWKS). */
let fixtureJwtKeysPromise: Promise<{
  publicKey: KeyObject;
  privateKey: KeyObject;
}> | null = null;

async function getFixtureJwtKeys(): Promise<{
  publicKey: KeyObject;
  privateKey: KeyObject;
}> {
  fixtureJwtKeysPromise ??= generateKeyPair("RS256", { extractable: true }).then(
    (kp) => ({
      publicKey: kp.publicKey as unknown as KeyObject,
      privateKey: kp.privateKey as unknown as KeyObject,
    }),
  );
  return fixtureJwtKeysPromise;
}

// Audience is an arbitrary test resource (not instance-derived); the
// server only checks the minted token's `aud` against `LOGTO_RESOURCE`.
const FIXTURE_LOGTO_AUDIENCE = "https://api.nautilo.integration.test/resource";

/**
 * Resolve the Logto coordinates from the *connected instance* rather than
 * hardcoding the default instance's `:3301`. Running with any named instance
 * derives the
 * correct shifted Logto core port from the instance bundle. Falls back to
 * the default `:3301` when no instance is resolvable (CI / default runs).
 * Memoized so the minted-token issuer and the verifier env always agree.
 */
let _fixtureLogtoCoords:
  | { endpoint: string; issuer: string; jwksUri: string; audience: string }
  | null = null;

function fixtureLogtoCoords(): {
  endpoint: string;
  issuer: string;
  jwksUri: string;
  audience: string;
} {
  if (_fixtureLogtoCoords) return _fixtureLogtoCoords;
  let corePort = 3301;
  try {
    const resolved = resolveInstance();
    corePort = resolved.logto?.corePort ?? 3301;
  } catch {
    // No resolvable instance bundle — keep the default-instance port.
  }
  const endpoint = `http://127.0.0.1:${corePort}`;
  _fixtureLogtoCoords = {
    endpoint,
    issuer: `${endpoint}/oidc`,
    jwksUri: `${endpoint}/oidc/jwks`,
    audience: FIXTURE_LOGTO_AUDIENCE,
  };
  return _fixtureLogtoCoords;
}

/**
 * Test-only stub of the Logto Management API client. The fixture mints
 * self-signed JWTs whose `sub`s do NOT exist in any real Logto tenant, so
 * Management-API calls (password change, token revocation, etc.) can't go
 * to a live Logto. This stub makes those code paths deterministic:
 * mutations succeed, the user always looks active. Only used when real
 * `LOGTO_M2M_*` creds are absent (see installFixtureLogtoVerifier).
 */
function makeStubLogtoAdminClient(): LogtoAdminClient {
  // Methods return resolved Promises (no `async`) to satisfy
  // @typescript-eslint/require-await — there's nothing to await in a stub.
  const stub = {
    getAccessToken: () => Promise.resolve("stub-access-token"),
    isUserActive: () => Promise.resolve(true),
    createUser: () => Promise.resolve({ id: randomUUID() }),
    createPersonalAccessToken: () => Promise.resolve({ value: "stub-pat" }),
    setUserPassword: () => Promise.resolve(),
    createOneTimeToken: () => Promise.resolve({ token: "stub-ott" }),
    verifyUserPassword: () => Promise.resolve(true),
    getPasswordPolicy: () => Promise.resolve({
      length: { min: 8, max: 256 },
      characterTypes: { min: 1 },
      rejects: {
        pwned: false,
        repetitionAndSequence: false,
        userInfo: false,
        words: [],
      },
    }),
    revokeUser: () => Promise.resolve(),
    deleteUser: () => Promise.resolve(),
    findUserByEmailOrUsername: () => Promise.resolve(null),
    getUser: () => Promise.resolve(null),
    patchUser: () => Promise.resolve(),
  };
  return stub as unknown as LogtoAdminClient;
}

async function installFixtureLogtoVerifier(): Promise<void> {
  const { publicKey } = await getFixtureJwtKeys();
  const coords = fixtureLogtoCoords();
  process.env["LOGTO_JWKS_URI"] = coords.jwksUri;
  process.env["LOGTO_ISSUER"] = coords.issuer;
  process.env["LOGTO_RESOURCE"] = coords.audience;
  process.env["LOGTO_ENDPOINT"] = coords.endpoint;
  _resetJwksForTests();
  _setJwksKeyForTests(() => Promise.resolve(publicKey));
  _resetClockSkewForTests();
  _setProbeForTests(() => Promise.resolve(0));

  // Management-API client: default to the deterministic stub so the
  // suite is RESILIENT to ambient environment. The fixture mints
  // self-signed JWTs whose `sub`s do not exist in any real Logto tenant;
  // if the real Logto admin client is used, its `isUserActive(sub)`
  // probe returns false and EVERY fixture token is rejected as
  // `logto.revoked` → a full-suite 401 cascade. That used to trigger
  // silently whenever the runner's shell had the connected instance's
  // `LOGTO_M2M_*` exported (e.g. `source ~/.nautilo-<id>/instance.env`
  // to pick up LLM keys). Make real-Logto an EXPLICIT opt-in
  // (`NAUTILO_TEST_REAL_LOGTO=1`) instead of an ambient-env heuristic,
  // so the suite behaves identically regardless of what the operator
  // happens to have exported.
  _resetLogtoAdminClientForTests();
  const optInRealLogto = process.env["NAUTILO_TEST_REAL_LOGTO"] === "1";
  const hasRealM2M =
    optInRealLogto &&
    !!process.env["LOGTO_M2M_APP_ID"] &&
    !!process.env["LOGTO_M2M_APP_SECRET"];
  if (!hasRealM2M) {
    _setLogtoAdminClientForTests(makeStubLogtoAdminClient());
  }
}

async function signFixtureAccessTokenForSub(
  sub: string,
  iatSeconds?: number,
): Promise<string> {
  const { privateKey } = await getFixtureJwtKeys();
  const nowSec = Math.floor(Date.now() / 1000);
  const iat = typeof iatSeconds === "number" ? iatSeconds : nowSec;
  const exp = nowSec + 3600;
  const coords = fixtureLogtoCoords();
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "fixture-key-1" })
    .setIssuer(coords.issuer)
    .setAudience(coords.audience)
    .setSubject(sub)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(privateKey);
}

export interface AppFixture {
  app: FastifyInstance;
  db: ReturnType<typeof createDirectDb>;
  ownerId: string;
  ownerActorId: string;
  ownerHandle: string;
  /** OIDC `sub` claim minted into the owner's JWT (matches `users.external_id`). */
  ownerLogtoSub: string;
  /** PIN used for session minting (default six digits). */
  ownerPin: string;
  mintOwnerBearer: () => Promise<string>;
  /** Mint a bearer whose JWT `iat` is the given Unix seconds (exp still ~1h from now). */
  mintOwnerBearerIssuedAt: (iatUnixSeconds: number) => Promise<string>;
  /**
   * M077 — mint a Logto JWT for another user row (`users.external_id` === `sub`).
   * The peer user must have `external_id` populated before calling.
   */
  mintSessionBearerForUser: (actorId: string, userId: string) => Promise<string>;
  /**
   * M126 — mint a Logto JWT for a `sub` with no matching `users.external_id`.
   * Exercises the unknown-sub / no-JIT path without reaching into fixture signing.
   */
  mintBearerForOrphanSub: (sub: string) => Promise<string>;
  cleanup: () => Promise<void>;
  /** Set when `withDefaultAgentGraph: true`. */
  defaultAgentId?: string;
  defaultRoomId?: string;
  /** `agent_ownership` group id when `withDefaultAgentGraph: true`. */
  defaultOwnershipGroupId?: string;
}

export interface SetupOwnerAppFixtureOptions {
  /** Prefix for unique handle / email (keep short). */
  suiteName: string;
  /** Defaults to `847291` (non-weak) when omitted. */
  ownerPin?: string | undefined;
  createAppExtras?: Partial<CreateAppOptions>;
  /**
   * M077 — seed `agents` + `agent_ownership` group + owner private room
   * (`graph_thread_id = room:<id>`) and set `NAUTILO_DEFAULT_AGENT_ID`
   * before `createApp` (for chat / WS multi-user integration tests).
   */
  withDefaultAgentGraph?: boolean | undefined;
}

export async function seatPeerUser(
  db: ReturnType<typeof createDirectDb>,
  opts: {
    suiteName: string;
    groupType: "owners" | "admins" | "superusers" | "members" | "contributors" | "guests";
    withPin?: boolean;
  },
): Promise<{ userId: string; actorId: string; agentId: string; bearer: string }> {
  const suffix = `${Date.now().toString(36)}${randomUUID().slice(0, 8)}`.toLowerCase();
  const handle = `${opts.suiteName}${opts.groupType}${suffix}`
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 48);
  const externalId = randomUUID();
  const [user] = await db
    .insert(users)
    .values({
      name: `${opts.suiteName}-${opts.groupType}-peer`,
      email: `${handle}@test.local`,
      handle,
      externalId,
      server: null,
    })
    .returning({ id: users.id });
  if (!user) throw new Error("seatPeerUser: user insert failed");

  const [actor] = await db
    .insert(actors)
    .values({
      ownerId: user.id,
      displayName: `${opts.suiteName} ${opts.groupType} peer`,
      trustState: "verified",
      kind: "user",
    })
    .returning({ id: actors.id });
  if (!actor) throw new Error("seatPeerUser: actor insert failed");

  const federatedId = composeFederatedId(handle, getServerHostname());
  await db.insert(channelIdentities).values([
    { channel: "tui", externalId: federatedId, userId: user.id, verifiedAt: new Date() },
    { channel: "workbench", externalId: federatedId, userId: user.id, verifiedAt: new Date() },
  ]);

  if (opts.withPin === true) {
    await db.insert(credentials).values({
      userId: user.id,
      type: "pin",
      value: await hashPin("847291"),
    });
  }

  // M132 — peer profile is agent-keyed; mint the peer's personal agent
  // + mirror actor before the profile INSERT.
  const [peerAgent] = await db
    .insert(agents)
    .values({
      handle: `ag-peer-${handle.replace(/[^a-z0-9]/gi, "").slice(0, 10)}-${Date.now().toString(36).slice(-4)}`,
    })
    .returning({ id: agents.id });
  if (!peerAgent) throw new Error("seatPeerUser: agent insert failed");
  await db.insert(actors).values({
    ownerId: user.id,
    displayName: `${opts.suiteName} Peer agent actor`,
    trustState: "verified",
    kind: "agent",
    agentId: peerAgent.id,
  });

  await db.insert(profiles).values({
    userId: user.id,
    agentId: peerAgent.id,
    name: `${opts.suiteName} Peer`,
  });

  const [group] = await db
    .select({ id: groups.id })
    .from(groups)
    .where(eq(groups.type, opts.groupType))
    .limit(1);
  if (!group) {
    throw new Error(`seatPeerUser: canonical ${opts.groupType} group missing`);
  }
  await db
    .insert(groupMembers)
    .values({
      groupId: group.id,
      userId: user.id,
      grantedBy: actor.id,
    })
    .onConflictDoNothing({
      target: [groupMembers.groupId, groupMembers.userId],
    });

  return {
    userId: user.id,
    actorId: actor.id,
    agentId: peerAgent.id,
    bearer: await signFixtureAccessTokenForSub(externalId),
  };
}

/**
 * Boots the full production Fastify app with a synthetic owner user,
 * federated channel identity, and PIN credential — same discipline as
 * `auth.test.ts` pre-refactor.
 *
 * D202: refuses `(default)` unless `ALLOW_DEFAULT_DB_TESTS=1` or CI env
 * (see `tests/helpers/default-db-fixture-guard.ts`).
 */
export async function setupOwnerAppFixture(
  opts: SetupOwnerAppFixtureOptions,
): Promise<AppFixture> {
  // D266 Wave 1: route the scratch instance and refuse protected `(default)`
  // BEFORE `ensureDatabase()` / `createDirectDb()`. `bootstrapTestDbInstance`
  // supersedes the assert-only `assertFixtureDbMutationAllowed` call: it also
  // defaults an unset `NAUTILO_INSTANCE_ID` to `test-cruft` and clears stale
  // direct-connection overrides for the scratch target, so ad-hoc root-level
  // invocation cannot inherit `default` / a poisoned `DB_CONNECTION_STRING`
  // and silently write to an operator-owned database.
  bootstrapTestDbInstance();
  const ownerPin = opts.ownerPin ?? "847291";
  await installFixtureLogtoVerifier();
  await ensureDatabase();
  const db = createDirectDb(1);

  const ownerHandle = `${opts.suiteName}${Date.now().toString(36).slice(-6)}`;
  const ownerLogtoSub = randomUUID();
  const [user] = await db
    .insert(users)
    .values({
      name: `${opts.suiteName}-owner`,
      email: `${opts.suiteName}-${Date.now()}@test.local`,
      handle: ownerHandle,
      // D219 — `serverRole` retired; owner authority comes from the
      // `owners`-Group membership seeded below.
      externalId: ownerLogtoSub,
    })
    .returning({ id: users.id });
  if (!user) throw new Error("Failed to create test user");
  const ownerId = user.id;

  const [actor] = await db
    .insert(actors)
    .values({
      ownerId,
      displayName: `${opts.suiteName} Owner`,
      trustState: "verified",
      kind: "user",
    })
    .returning({ id: actors.id });
  if (!actor) throw new Error("Failed to create test actor");
  const ownerActorId = actor.id;

  // M132 — the Profile is agent-keyed (`profiles.agent_id` NOT NULL
  // UNIQUE). Every owner fixture therefore needs a personal Agent +
  // its `actors` mirror before the profile INSERT. This mirrors
  // production (the redeem-invite tx seeds the agent, then the profile).
  // `withDefaultAgentGraph` below reuses this same agent for room wiring.
  const [ownerAgent] = await db
    .insert(agents)
    .values({
      handle: `ag-${ownerHandle.replace(/[^a-z0-9]/gi, "").slice(0, 8)}-${randomUUID().slice(0, 8)}`,
    })
    .returning({ id: agents.id });
  if (!ownerAgent) throw new Error("Failed to create owner agent");
  const ownerAgentId = ownerAgent.id;

  const [ownerAgentActor] = await db
    .insert(actors)
    .values({
      ownerId,
      displayName: "Fixture agent actor",
      trustState: "verified",
      kind: "agent",
      agentId: ownerAgentId,
    })
    .returning({ id: actors.id });
  if (!ownerAgentActor) throw new Error("Failed to create owner agent actor");
  const ownerAgentActorId = ownerAgentActor.id;

  await db.insert(profiles).values({
    userId: ownerId,
    agentId: ownerAgentId,
    name: "Fixture",
  });

  const ownerFederatedId = composeFederatedId(ownerHandle, getServerHostname());
  await db.insert(channelIdentities).values([
    {
      channel: "tui",
      externalId: ownerFederatedId,
      userId: ownerId,
      verifiedAt: new Date(),
    },
    {
      channel: "workbench",
      externalId: ownerFederatedId,
      userId: ownerId,
      verifiedAt: new Date(),
    },
  ]);

  const hashed = await hashPin(ownerPin);
  await db.insert(credentials).values({
    userId: ownerId,
    type: "pin",
    value: hashed,
  });

  // Mirror bin/nautilo-server's post-migration bootstrap order. Migrations own
  // table shape; this production seed owns canonical Roles, Capabilities,
  // Groups, mappings, and the bootstrap owner's owner membership.
  await seedFixtureTrustPersonal(ownerId, `${opts.suiteName} Owner`);

  let prevDefaultAgentEnv = getBootstrapDefaultAgentId();
  const graphIds: {
    agentId?: string;
    roomId?: string;
    namespaceId?: string;
    groupId?: string;
  } = {};

  // M133 — the session/room transcript gates now resolve authorization via
  // `getUserCapabilities`, which is PURE server-wide Group membership (no
  // `serverRole='admin'` / bootstrap-owner fallback — that fallback only
  // survives for `actorRole` derivation). An owner fixture must therefore
  // hold real `owners`-Group membership to carry owner Capabilities
  // (`read_memories`, etc.), matching production where the claim flow seeds
  // the owner into this Group. Seed it unconditionally so every owner fixture
  // is a genuine cap-holding owner; cleanup keys on `graphIds.groupId` below.
  const [ownersGroup] = await db
    .select({ id: groups.id })
    .from(groups)
    .where(eq(groups.type, "owners"))
    .limit(1);
  if (!ownersGroup) {
    throw new Error("canonical owners group missing — did seedTrustPersonal run?");
  }
  await db
    .insert(groupMembers)
    .values({
      groupId: ownersGroup.id,
      userId: ownerId,
      grantedBy: ownerActorId,
    })
    .onConflictDoNothing({
      target: [groupMembers.groupId, groupMembers.userId],
    });
  graphIds.groupId = ownersGroup.id;

  if (opts.withDefaultAgentGraph) {
    const [ownerRole] = await db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.slug, "owner"))
      .limit(1);
    if (!ownerRole) {
      throw new Error("withDefaultAgentGraph: missing roles.slug=owner seed");
    }

    // M132 — reuse the owner's personal agent + mirror actor created
    // above (the profile is keyed to it); don't mint a second agent.
    const ag = { id: ownerAgentId };
    const agentActor = { id: ownerAgentActorId };

    const [ns] = await db
      .insert(namespaces)
      .values({ scope: "private", label: "fx-ns" })
      .returning({ id: namespaces.id });
    if (!ns) throw new Error("namespace insert failed");

    const [rm] = await db
      .insert(rooms)
      .values({
        ownerId,
        type: "private",
        label: "Home",
        graphThreadId: "app:default",
        namespaceId: ns.id,
        humanActorIds: [ownerActorId],
        createdBy: ownerActorId,
      })
      .returning({ id: rooms.id });
    if (!rm) throw new Error("room insert failed");

    const graphThreadId = `room:${rm.id}`;
    await db.update(rooms).set({ graphThreadId }).where(eq(rooms.id, rm.id));

    await db.insert(roomMembers).values([
      { roomId: rm.id, actorId: ownerActorId, roomRole: "admin" },
      { roomId: rm.id, actorId: agentActor.id, roomRole: "member" },
    ]);

    graphIds.agentId = ag.id;
    graphIds.roomId = rm.id;
    graphIds.namespaceId = ns.id;

    prevDefaultAgentEnv = getBootstrapDefaultAgentId();
    setBootstrapDefaultAgentId(ag.id);
  }

  const prevOwnerId = getBootstrapOwnerId();
  const prevOwnerActorId = getBootstrapOwnerActorId();
  setBootstrapOwnerId(ownerId);
  setBootstrapOwnerActorId(ownerActorId);

  async function signAccessTokenForSub(
    sub: string,
    iatSeconds?: number,
  ): Promise<string> {
    return signFixtureAccessTokenForSub(sub, iatSeconds);
  }

  const resolver = new PersonalPolicyResolver(ownerId);
  const app = await createApp({
    silent: true,
    policyResolver: resolver,
    ownerActorId,
    ownerId,
    pinProvider: new PinChallengeProvider({ persistPath: null }),
    trustBearerDefaultAgentId: graphIds.agentId ?? "",
    ...opts.createAppExtras,
  });

  async function mintOwnerBearer(): Promise<string> {
    return signAccessTokenForSub(ownerLogtoSub);
  }

  async function mintOwnerBearerIssuedAt(iatUnixSeconds: number): Promise<string> {
    return signAccessTokenForSub(ownerLogtoSub, iatUnixSeconds);
  }

  return {
    app,
    db,
    ownerId,
    ownerActorId,
    ownerHandle,
    ownerLogtoSub,
    ownerPin,
    mintOwnerBearer,
    mintOwnerBearerIssuedAt,
    async mintSessionBearerForUser(_actorId: string, userId: string): Promise<string> {
      const [row] = await db
        .select({ externalId: users.externalId })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      const sub = row?.externalId;
      if (!sub || sub.length === 0) {
        throw new Error(
          `mintSessionBearerForUser: user ${userId} must have users.external_id (Logto sub) set`,
        );
      }
      return signAccessTokenForSub(sub);
    },
    mintBearerForOrphanSub: (sub: string) => signAccessTokenForSub(sub),
    ...(graphIds.agentId !== undefined ? { defaultAgentId: graphIds.agentId } : {}),
    ...(graphIds.roomId !== undefined ? { defaultRoomId: graphIds.roomId } : {}),
    ...(graphIds.groupId !== undefined ? { defaultOwnershipGroupId: graphIds.groupId } : {}),
    cleanup: async () => {
      await app.close();
      const ownerSessionRows = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.ownerId, ownerId));
      const ownerSessionIds = ownerSessionRows.map((r) => r.id);
      if (ownerSessionIds.length > 0) {
        await db
          .delete(sessionMessages)
          .where(inArray(sessionMessages.sessionId, ownerSessionIds));
        await db.delete(sessions).where(inArray(sessions.id, ownerSessionIds));
      }
      if (graphIds.roomId) {
        await db.delete(jobs).where(eq(jobs.roomId, graphIds.roomId));
        await db.delete(roomMembers).where(eq(roomMembers.roomId, graphIds.roomId));
        await db.delete(rooms).where(eq(rooms.id, graphIds.roomId));
      }
      if (graphIds.namespaceId) {
        await db.delete(namespaces).where(eq(namespaces.id, graphIds.namespaceId));
      }
      if (graphIds.groupId) {
        // M128 — `graphIds.groupId` now references the canonical
        // server-wide `owners` Group (seeded by `seedTrustPersonal`),
        // NOT a per-Agent ownership group minted by the fixture.
        // Only remove the fixture-owner's membership row; NEVER drop
        // the canonical Group itself: doing so would leave every unrelated
        // user on the same database unable to resolve `owner` authority.
        await db
          .delete(groupMembers)
          .where(
            and(
              eq(groupMembers.groupId, graphIds.groupId),
              eq(groupMembers.userId, ownerId),
            ),
          );
      }
      setBootstrapDefaultAgentId(prevDefaultAgentEnv ?? "");
      await db.delete(relayTokens).where(eq(relayTokens.userId, ownerId));
      await db.delete(jobs).where(eq(jobs.ownerId, ownerId));
      // M132 — delete the profile BEFORE the agent it references
      // (`profiles.agent_id` FK is ON DELETE no action).
      await db.delete(profiles).where(eq(profiles.userId, ownerId));
      await db.delete(channelIdentities).where(eq(channelIdentities.userId, ownerId));
      await db.delete(credentials).where(eq(credentials.userId, ownerId));
      await db.delete(actors).where(eq(actors.ownerId, ownerId));
      // M132 — owner agent + its mirror actor are now always created.
      await db.delete(actors).where(eq(actors.agentId, ownerAgentId));
      await db.delete(agents).where(eq(agents.id, ownerAgentId));
      await db.delete(users).where(eq(users.id, ownerId));
      await db.end();
      setBootstrapOwnerId(prevOwnerId);
      setBootstrapOwnerActorId(prevOwnerActorId);
      _resetJwksForTests();
      _resetClockSkewForTests();
      _setProbeForTests(null);
    },
  };
}
