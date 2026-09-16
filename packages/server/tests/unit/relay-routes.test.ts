/**
 * M056 — `POST /api/relay/pair` + `GET/DELETE /api/relay/devices`.
 *
 * Uses the M052 `installLocalAuthPreHandlerStub` helper so the routes
 * see the same `request.sessionUserId` / `sessionActorId` shape as
 * production. The relay-token DB seam is swapped for an in-memory
 * fake via `setRelayTokenStore()` so the test never touches Postgres.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { SessionStore } from "../helpers/test-session-store";
import { relayHttpRoutes } from "../../src/routes/relay";
import {
  resetRelayTokenStore,
  setRelayTokenStore,
  relayDeviceManagementIdFor,
  type RelayDeviceListItem,
  type RelayTokenStore,
} from "../../src/lib/relay-token-store";
import { installLocalAuthPreHandlerStub } from "./helpers/auth-preHandler-stub";
import { resetElectronOriginCredentialStoreForTests } from "../../src/remote-control/electron-origin-credential-store";

const ACTOR_A = "00000000-0000-0000-0000-0000000000a1";
const USER_A = "00000000-0000-0000-0000-0000000000b1";
const USER_B = "00000000-0000-0000-0000-0000000000b2";

interface FakeRow {
  id: string;
  userId: string;
  actorId: string;
  tokenHash: string;
  label: string;
  capabilities: Record<string, unknown>;
  createdAt: Date;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
  installationId: string | null;
  deviceGroupId: string | null;
  deviceManagementId: string | null;
}

function makeFakeStore(): {
  store: RelayTokenStore;
  rows: FakeRow[];
  touchedIds: string[];
} {
  const rows: FakeRow[] = [];
  const touchedIds: string[] = [];
  let nextId = 1;
  const store: RelayTokenStore = {
    async insertToken(args) {
      const id = `relay-token-${nextId++}`;
      rows.push({
        id,
        userId: args.userId,
        actorId: args.actorId,
        tokenHash: args.tokenHash,
        label: args.label,
        capabilities: args.capabilities,
        createdAt: new Date(),
        lastSeenAt: null,
        revokedAt: null,
        installationId: null,
        deviceGroupId: args.deviceGroupId ?? null,
        deviceManagementId: args.deviceGroupId
          ? relayDeviceManagementIdFor(args.userId, args.deviceGroupId)
          : null,
      });
      return { id };
    },
    async pairForInstallation(args) {
      // Mirror the real DB transaction: revoke every existing active
      // row for (userId, installationId), then insert a fresh row whose
      // id is the new pairingGeneration.
      for (const r of rows) {
        if (
          r.userId === args.userId &&
          r.installationId === args.installationId &&
          r.revokedAt === null
        ) {
          r.revokedAt = new Date();
        }
      }
      const id = `relay-token-${nextId++}`;
      rows.push({
        id,
        userId: args.userId,
        actorId: args.actorId,
        tokenHash: args.tokenHash,
        label: args.label,
        capabilities: args.capabilities,
        createdAt: new Date(),
        lastSeenAt: null,
        revokedAt: null,
        installationId: args.installationId,
        deviceGroupId: args.deviceGroupId ?? null,
        deviceManagementId: args.deviceGroupId
          ? relayDeviceManagementIdFor(args.userId, args.deviceGroupId)
          : null,
      });
      return { id };
    },
    async findActiveByHash(tokenHash) {
      const r = rows.find((row) => row.tokenHash === tokenHash && row.revokedAt === null);
      return r ? { id: r.id, userId: r.userId, actorId: r.actorId } : null;
    },
    async touchLastSeen(tokenId) {
      touchedIds.push(tokenId);
      const r = rows.find((row) => row.id === tokenId);
      if (r) r.lastSeenAt = new Date();
    },
    async listForUser(userId) {
      return rows
        .filter((r) => r.userId === userId && r.revokedAt === null)
        .map<RelayDeviceListItem>((r) => ({
          id: r.id,
          label: r.label,
          capabilities: r.capabilities,
          createdAt: r.createdAt,
          lastSeenAt: r.lastSeenAt,
        }));
    },
    async revokeForUser({ id, userId }) {
      const r = rows.find((row) => row.id === id && row.userId === userId && row.revokedAt === null);
      if (!r) return false;
      r.revokedAt = new Date();
      return true;
    },
    async listGroupedForUser(userId) {
      const groups = new Map<string, {
        label: string;
        pairingCount: number;
        firstPairedAt: Date;
        lastSeenAt: Date | null;
        profiles: string[];
        capabilities: string[];
      }>();
      let historicalCount = 0;
      let oldestPairedAt: Date | null = null;
      let latestSeenAt: Date | null = null;
      for (const row of rows.filter((candidate) => candidate.userId === userId && candidate.revokedAt === null)) {
        if (!row.deviceManagementId) {
          historicalCount += 1;
          if (!oldestPairedAt || row.createdAt < oldestPairedAt) oldestPairedAt = row.createdAt;
          if (row.lastSeenAt && (!latestSeenAt || row.lastSeenAt > latestSeenAt)) latestSeenAt = row.lastSeenAt;
          continue;
        }
        const current = groups.get(row.deviceManagementId) ?? {
          label: row.label,
          pairingCount: 0,
          firstPairedAt: row.createdAt,
          lastSeenAt: row.lastSeenAt,
          profiles: [],
          capabilities: [],
        };
        current.pairingCount += 1;
        if (row.createdAt < current.firstPairedAt) current.firstPairedAt = row.createdAt;
        if (row.lastSeenAt && (!current.lastSeenAt || row.lastSeenAt > current.lastSeenAt)) current.lastSeenAt = row.lastSeenAt;
        if (typeof row.capabilities["profile"] === "string") current.profiles.push(row.capabilities["profile"]);
        current.capabilities.push(...Object.entries(row.capabilities)
          .filter(([key, value]) => key !== "profile" && value === true)
          .map(([key]) => key));
        groups.set(row.deviceManagementId, current);
      }
      return {
        devices: [...groups.entries()].map(([deviceManagementId, current]) => ({
          deviceManagementId,
          label: current.label,
          pairingCount: current.pairingCount,
          firstPairedAt: current.firstPairedAt,
          lastSeenAt: current.lastSeenAt,
          profiles: [...new Set(current.profiles)],
          capabilities: [...new Set(current.capabilities)],
        })),
        historical: { activeCount: historicalCount, oldestPairedAt, latestSeenAt },
      };
    },
    async revokeGroupedForUser({ userId, deviceManagementId, expectedPairingCount }) {
      const matches = rows.filter((row) => row.userId === userId && row.deviceManagementId === deviceManagementId && row.revokedAt === null);
      if (matches.length === 0) return { affectedPairingCount: 0, revokedPairingGenerationIds: [], matched: false, current: true };
      if (matches.length !== expectedPairingCount) return { affectedPairingCount: 0, revokedPairingGenerationIds: [], matched: true, current: false };
      for (const row of matches) row.revokedAt = new Date();
      return { affectedPairingCount: matches.length, revokedPairingGenerationIds: matches.map((row) => row.id), matched: true, current: true };
    },
    async cleanupHistoricalForUser({ userId, expectedPairingCount }) {
      const matches = rows.filter((row) => row.userId === userId && row.deviceGroupId === null && row.revokedAt === null);
      if (matches.length === 0) return { affectedPairingCount: 0, revokedPairingGenerationIds: [], matched: false, current: expectedPairingCount === 0 };
      if (matches.length !== expectedPairingCount) return { affectedPairingCount: 0, revokedPairingGenerationIds: [], matched: true, current: false };
      for (const row of matches) row.revokedAt = new Date();
      return { affectedPairingCount: matches.length, revokedPairingGenerationIds: matches.map((row) => row.id), matched: true, current: true };
    },
  };
  return { store, rows, touchedIds };
}

describe("relay HTTP routes (M056)", () => {
  let app: FastifyInstance;
  let sessionStore: SessionStore;
  let userAToken: string;
  let userBToken: string;
  let fake: ReturnType<typeof makeFakeStore>;
  const reconciledGenerations: string[][] = [];
  const lifecycleAudits: Array<{ managementTarget: string; affectedPairingCount: number }> = [];
  let failLifecycleAudit = false;
  let liveRelay: {
    relayId: string;
    userId: string;
    desktopSessionId: string;
    pairingGeneration: string;
  } | null = null;

  beforeAll(async () => {
    sessionStore = new SessionStore(undefined, { persistPath: null });
    app = Fastify({ logger: false });
    installLocalAuthPreHandlerStub(app, sessionStore);
    relayHttpRoutes(app, {
      relayRegistry: {
        getUserId: (relayId) => liveRelay?.relayId === relayId ? liveRelay.userId : null,
        getDesktopSessionId: (relayId) =>
          liveRelay?.relayId === relayId ? liveRelay.desktopSessionId : null,
        getPairingGeneration: (relayId) =>
          liveRelay?.relayId === relayId ? liveRelay.pairingGeneration : null,
      },
      reconcileRevokedPairingGenerations: ({ pairingGenerationIds }) => {
        reconciledGenerations.push([...pairingGenerationIds]);
      },
      recordPairingLifecycleAudit: (event) => {
        if (failLifecycleAudit) throw new Error("audit unavailable");
        lifecycleAudits.push({
          managementTarget: event.managementTarget,
          affectedPairingCount: event.affectedPairingCount,
        });
      },
    });
    await app.ready();

    userAToken = sessionStore.createSession(ACTOR_A, USER_A, USER_A).token;
    userBToken = sessionStore.createSession(
      "00000000-0000-0000-0000-0000000000a2",
      USER_B,
      USER_B,
    ).token;
  });

  beforeEach(() => {
    fake = makeFakeStore();
    setRelayTokenStore(fake.store);
    reconciledGenerations.length = 0;
    lifecycleAudits.length = 0;
    failLifecycleAudit = false;
    liveRelay = null;
    resetElectronOriginCredentialStoreForTests();
  });

  afterEach(() => {
    resetRelayTokenStore();
    resetElectronOriginCredentialStoreForTests();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  describe("POST /api/relay/electron-origin-credential", () => {
    test("requires the caller's exact active Relay token and launch session", async () => {
      const paired = await app.inject({
        method: "POST",
        url: "/api/relay/pair",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${userAToken}` },
        payload: {
          deviceLabel: "MacBook",
          installationId: "11111111-1111-4111-8111-111111111111",
        },
      });
      const relayToken = paired.json<{ relayToken: string }>().relayToken;
      const pairingGeneration = fake.rows[0]!.id;
      liveRelay = {
        relayId: "relay-a",
        userId: USER_A,
        desktopSessionId: "22222222-2222-4222-8222-222222222222",
        pairingGeneration,
      };
      const payload = {
        requestId: "33333333-3333-4333-8333-333333333333",
        relayId: liveRelay.relayId,
        desktopSessionId: liveRelay.desktopSessionId,
        method: "POST",
        path: "/api/rooms/44444444-4444-4444-8444-444444444444/messages",
        bodySha256: "a".repeat(64),
      };

      const browser = await app.inject({
        method: "POST",
        url: "/api/relay/electron-origin-credential",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${userAToken}` },
        payload,
      });
      expect(browser.statusCode).toBe(403);

      const wrongLaunch = await app.inject({
        method: "POST",
        url: "/api/relay/electron-origin-credential",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userAToken}`,
          "X-Nautilo-Relay-Token": relayToken,
        },
        payload: { ...payload, desktopSessionId: "55555555-5555-4555-8555-555555555555" },
      });
      expect(wrongLaunch.statusCode).toBe(403);

      const accepted = await app.inject({
        method: "POST",
        url: "/api/relay/electron-origin-credential",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userAToken}`,
          "X-Nautilo-Relay-Token": relayToken,
        },
        payload,
      });
      expect(accepted.statusCode).toBe(200);
      const responseBody: unknown = accepted.json();
      expect(responseBody).toEqual(expect.objectContaining({
        credential: expect.stringMatching(/^deo_[A-Za-z0-9_-]+$/) as unknown,
        expiresAt: expect.any(String) as unknown,
      }));
    });
  });

  describe("POST /api/relay/pair", () => {
    test("rejects guest (no Bearer) with 401", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/relay/pair",
        headers: { "Content-Type": "application/json" },
        payload: { deviceLabel: "MacBook" },
      });
      expect(res.statusCode).toBe(401);
      expect(fake.rows.length).toBe(0);
    });

    test("mints token, stores hash (not plaintext), returns plaintext once", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/relay/pair",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userAToken}`,
        },
        payload: { deviceLabel: "Mac mini", capabilities: { profile: "desktop-agent" } },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ relayToken: string }>();
      expect(body.relayToken).toMatch(/^rty_[A-Za-z0-9_-]{32}$/);
      expect(fake.rows.length).toBe(1);
      const row = fake.rows[0]!;
      // DB stores SHA-256 hash, not plaintext.
      expect(row.tokenHash).toBe(
        createHash("sha256").update(body.relayToken).digest("hex"),
      );
      expect(row.tokenHash).not.toBe(body.relayToken);
      expect(row.userId).toBe(USER_A);
      expect(row.actorId).toBe(ACTOR_A);
      expect(row.label).toBe("Mac mini");
      expect(row.capabilities).toEqual({ profile: "desktop-agent" });
    });

    test("default label when deviceLabel missing/empty", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/relay/pair",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userAToken}`,
        },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(fake.rows[0]?.label).toBe("Unnamed device");
    });

    test("rejects deviceLabel longer than 200 chars with 400", async () => {
      const tooLong = "x".repeat(201);
      const res = await app.inject({
        method: "POST",
        url: "/api/relay/pair",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userAToken}`,
        },
        payload: { deviceLabel: tooLong },
      });
      expect(res.statusCode).toBe(400);
      expect(fake.rows.length).toBe(0);
    });

    test("ignores non-object capabilities (defaults to empty)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/relay/pair",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userAToken}`,
        },
        payload: { capabilities: "not-an-object" },
      });
      expect(res.statusCode).toBe(200);
      expect(fake.rows[0]?.capabilities).toEqual({});
    });

    test("D418 — missing installationId stays legacy (no revocation, NULL id)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/relay/pair",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userAToken}`,
        },
        payload: { deviceLabel: "legacy-1" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ relayToken: string }>().relayToken).toMatch(/^rty_/);
      expect(fake.rows.length).toBe(1);
      expect(fake.rows[0]?.installationId).toBeNull();

      // A second legacy pair does NOT revoke the first — legacy rows
      // MAY legitimately duplicate.
      const res2 = await app.inject({
        method: "POST",
        url: "/api/relay/pair",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userAToken}`,
        },
        payload: { deviceLabel: "legacy-2" },
      });
      expect(res2.statusCode).toBe(200);
      expect(fake.rows.length).toBe(2);
      expect(fake.rows[0]?.revokedAt).toBeNull();
      expect(fake.rows[1]?.revokedAt).toBeNull();
    });

    test("D418 — valid installationId re-pair revokes the prior active row and inserts a new one", async () => {
      const installId = "11111111-2222-3333-4444-555555555555";
      const first = await app.inject({
        method: "POST",
        url: "/api/relay/pair",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userAToken}`,
        },
        payload: { deviceLabel: "desktop-A", installationId: installId },
      });
      expect(first.statusCode).toBe(200);
      expect(fake.rows.length).toBe(1);
      const firstRow = fake.rows[0]!;
      expect(firstRow.installationId).toBe(installId);
      expect(firstRow.revokedAt).toBeNull();

      const second = await app.inject({
        method: "POST",
        url: "/api/relay/pair",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userAToken}`,
        },
        payload: { deviceLabel: "desktop-A-repaire", installationId: installId },
      });
      expect(second.statusCode).toBe(200);
      expect(fake.rows.length).toBe(2);
      // The original row is revoked; only the new row stays active.
      expect(firstRow.revokedAt).not.toBeNull();
      expect(fake.rows[1]?.revokedAt).toBeNull();
      expect(fake.rows[1]?.installationId).toBe(installId);
      // pairingGeneration (new row id) differs from the revoked row id.
      expect(fake.rows[1]?.id).not.toBe(firstRow.id);
      const active = fake.rows.filter((r) => r.revokedAt === null);
      expect(active.length).toBe(1);
      expect(active[0]?.id).toBe(fake.rows[1]?.id);
    });

    test("D418 — installationId is scoped per user (B's pair does not revoke A's row)", async () => {
      const installId = "22222222-3333-4444-5555-666666666666";
      await app.inject({
        method: "POST",
        url: "/api/relay/pair",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userAToken}`,
        },
        payload: { deviceLabel: "A-desktop", installationId: installId },
      });
      await app.inject({
        method: "POST",
        url: "/api/relay/pair",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userBToken}`,
        },
        payload: { deviceLabel: "B-desktop", installationId: installId },
      });
      // Same installation id, different users → both stay active.
      expect(fake.rows.length).toBe(2);
      expect(fake.rows[0]?.revokedAt).toBeNull();
      expect(fake.rows[1]?.revokedAt).toBeNull();
    });

    test("D418 — invalid installationId returns 400 with no insert", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/relay/pair",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userAToken}`,
        },
        payload: { deviceLabel: "bad", installationId: "not-a-uuid" },
      });
      expect(res.statusCode).toBe(400);
      expect(fake.rows.length).toBe(0);
    });

    test("D418 — empty-string installationId is treated as omitted (legacy)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/relay/pair",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userAToken}`,
        },
        payload: { deviceLabel: "empty", installationId: "" },
      });
      expect(res.statusCode).toBe(200);
      expect(fake.rows.length).toBe(1);
      expect(fake.rows[0]?.installationId).toBeNull();
    });

    test("D418 — non-string installationId (number) returns 400 with no insert", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/relay/pair",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userAToken}`,
        },
        payload: { deviceLabel: "num", installationId: 12345 },
      });
      expect(res.statusCode).toBe(400);
      expect(fake.rows.length).toBe(0);
    });

    test("D480 — persists a valid grouping UUID without conflating installation rotation authority", async () => {
      const deviceGroupId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      const first = await app.inject({
        method: "POST", url: "/api/relay/pair",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${userAToken}` },
        payload: { deviceLabel: "same Mac", installationId: "11111111-1111-4111-8111-111111111111", deviceGroupId },
      });
      const second = await app.inject({
        method: "POST", url: "/api/relay/pair",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${userAToken}` },
        payload: { deviceLabel: "same Mac", installationId: "22222222-2222-4222-8222-222222222222", deviceGroupId },
      });
      expect(first.json<{ pairingContractVersion: number }>().pairingContractVersion).toBe(2);
      expect(second.statusCode).toBe(200);
      expect(fake.rows.filter((row) => row.revokedAt === null)).toHaveLength(2);
      expect(fake.rows.map((row) => row.installationId)).toEqual([
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
      ]);
      expect(fake.rows.map((row) => row.deviceManagementId)).toEqual([
        relayDeviceManagementIdFor(USER_A, deviceGroupId),
        relayDeviceManagementIdFor(USER_A, deviceGroupId),
      ]);
    });

    test("D480 — rejects a present malformed grouping UUID with no label fallback or insert", async () => {
      const res = await app.inject({
        method: "POST", url: "/api/relay/pair",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${userAToken}` },
        payload: { deviceLabel: "not an identity", deviceGroupId: "not-a-uuid" },
      });
      expect(res.statusCode).toBe(400);
      expect(fake.rows).toHaveLength(0);
    });
  });

  describe("GET /api/relay/devices", () => {
    test("rejects guest with 401", async () => {
      const res = await app.inject({ method: "GET", url: "/api/relay/devices" });
      expect(res.statusCode).toBe(401);
    });

    test("lists only the calling user's active devices", async () => {
      // user A pairs two devices, user B pairs one.
      for (const label of ["Mac mini", "MacBook Pro"]) {
        await app.inject({
          method: "POST",
          url: "/api/relay/pair",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userAToken}`,
          },
          payload: { deviceLabel: label },
        });
      }
      await app.inject({
        method: "POST",
        url: "/api/relay/pair",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userBToken}`,
        },
        payload: { deviceLabel: "B-laptop" },
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/relay/devices",
        headers: { Authorization: `Bearer ${userAToken}` },
      });
      expect(res.statusCode).toBe(200);
      const list = res.json<Array<{ label: string; lastSeenAt: string | null }>>();
      expect(list.map((d) => d.label).sort()).toEqual(["Mac mini", "MacBook Pro"]);
      // No leak of user B.
      expect(list.find((d) => d.label === "B-laptop")).toBeUndefined();
    });

    test("excludes revoked rows", async () => {
      await app.inject({
        method: "POST",
        url: "/api/relay/pair",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userAToken}`,
        },
        payload: { deviceLabel: "Mac mini" },
      });
      const id = fake.rows[0]!.id;
      fake.rows[0]!.revokedAt = new Date();

      const res = await app.inject({
        method: "GET",
        url: "/api/relay/devices",
        headers: { Authorization: `Bearer ${userAToken}` },
      });
      expect(res.statusCode).toBe(200);
      const list = res.json<Array<{ id: string }>>();
      expect(list.find((d) => d.id === id)).toBeUndefined();
    });
  });

  describe("DELETE /api/relay/devices/:id", () => {
    test("rejects guest with 401", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: "/api/relay/devices/some-id",
      });
      expect(res.statusCode).toBe(401);
    });

    test("revokes the user's own device with 204", async () => {
      await app.inject({
        method: "POST",
        url: "/api/relay/pair",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userAToken}`,
        },
        payload: { deviceLabel: "Mac mini" },
      });
      const id = fake.rows[0]!.id;

      const res = await app.inject({
        method: "DELETE",
        url: `/api/relay/devices/${id}`,
        headers: { Authorization: `Bearer ${userAToken}` },
      });
      expect(res.statusCode).toBe(204);
      expect(fake.rows[0]?.revokedAt).not.toBeNull();
    });

    test("cross-user revoke is silent 204 with no mutation", async () => {
      // user A's row, user B tries to delete.
      await app.inject({
        method: "POST",
        url: "/api/relay/pair",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userAToken}`,
        },
        payload: { deviceLabel: "Mac mini" },
      });
      const id = fake.rows[0]!.id;

      const res = await app.inject({
        method: "DELETE",
        url: `/api/relay/devices/${id}`,
        headers: { Authorization: `Bearer ${userBToken}` },
      });
      expect(res.statusCode).toBe(204);
      // Existence-hiding: the row is untouched; the response gives
      // user B no signal that the id belongs to someone else.
      expect(fake.rows[0]?.revokedAt).toBeNull();
    });
  });

  describe("D480 v2 grouped relay devices", () => {
    const groupA = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const groupB = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";

    async function pairGrouped(groupId: string, installationId: string, label = "same hostname") {
      return app.inject({
        method: "POST", url: "/api/relay/pair",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${userAToken}` },
        payload: { deviceLabel: label, installationId, deviceGroupId: groupId, capabilities: { profile: "desktop", canReadWorkspace: true, secret: "never-return" } },
      });
    }

    test("requires authentication on every grouped-device route", async () => {
      const managementId = relayDeviceManagementIdFor(USER_A, groupA);
      const requests = [
        app.inject({ method: "GET", url: "/api/relay/devices/v2" }),
        app.inject({
          method: "GET",
          url: `/api/relay/devices/v2/${managementId}`,
        }),
        app.inject({
          method: "DELETE",
          url: `/api/relay/devices/v2/${managementId}`,
          headers: { "Content-Type": "application/json" },
          payload: { expectedPairingCount: 1 },
        }),
        app.inject({
          method: "POST",
          url: "/api/relay/devices/v2/historical/cleanup",
          headers: { "Content-Type": "application/json" },
          payload: { confirm: true, expectedPairingCount: 1 },
        }),
      ];

      const responses = await Promise.all(requests);
      expect(responses.map((response) => response.statusCode)).toEqual([
        401,
        401,
        401,
        401,
      ]);
      expect(fake.rows).toHaveLength(0);
      expect(lifecycleAudits).toHaveLength(0);
    });

    test("groups same pseudonym, keeps same-label separate, redacts raw identities and arbitrary values", async () => {
      await pairGrouped(groupA, "11111111-1111-4111-8111-111111111111");
      await pairGrouped(groupA, "22222222-2222-4222-8222-222222222222");
      await pairGrouped(groupB, "33333333-3333-4333-8333-333333333333");
      await app.inject({ method: "POST", url: "/api/relay/pair", headers: { "Content-Type": "application/json", Authorization: `Bearer ${userAToken}` }, payload: { deviceLabel: "same hostname" } });
      const res = await app.inject({ method: "GET", url: "/api/relay/devices/v2", headers: { Authorization: `Bearer ${userAToken}` } });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ contractVersion: number; devices: Array<{ deviceManagementId: string; pairingCount: number; capabilities: string[] }>; historical: { pairingCount: number } }>();
      expect(body.contractVersion).toBe(2);
      expect(body.devices).toHaveLength(2);
      expect(body.devices.map((device) => device.pairingCount).sort()).toEqual([1, 2]);
      expect(body.historical.pairingCount).toBe(1);
      expect(JSON.stringify(body)).not.toContain(groupA);
      expect(JSON.stringify(body)).not.toContain("11111111-1111-4111-8111-111111111111");
      expect(JSON.stringify(body)).not.toContain("never-return");
      expect(body.devices[0]?.capabilities).toContain("canReadWorkspace");
    });

    test("returns only the caller-owned grouped-device detail", async () => {
      await pairGrouped(groupA, "11111111-1111-4111-8111-111111111111");
      const managementId = relayDeviceManagementIdFor(USER_A, groupA);

      const own = await app.inject({
        method: "GET",
        url: `/api/relay/devices/v2/${managementId}`,
        headers: { Authorization: `Bearer ${userAToken}` },
      });
      expect(own.statusCode).toBe(200);
      expect(own.json<{
        contractVersion: number;
        device: { deviceManagementId: string; pairingCount: number };
      }>()).toMatchObject({
        contractVersion: 2,
        device: { deviceManagementId: managementId, pairingCount: 1 },
      });

      const foreign = await app.inject({
        method: "GET",
        url: `/api/relay/devices/v2/${managementId}`,
        headers: { Authorization: `Bearer ${userBToken}` },
      });
      expect(foreign.statusCode).toBe(404);
      expect(JSON.stringify(foreign.json())).not.toContain(USER_A);
      expect(JSON.stringify(foreign.json())).not.toContain(groupA);
    });

    test("does not correlate equal group pseudonyms across users", async () => {
      await pairGrouped(groupA, "11111111-1111-4111-8111-111111111111");
      await app.inject({ method: "POST", url: "/api/relay/pair", headers: { "Content-Type": "application/json", Authorization: `Bearer ${userBToken}` }, payload: { deviceLabel: "same hostname", installationId: "22222222-2222-4222-8222-222222222222", deviceGroupId: groupA } });
      const a = await app.inject({ method: "GET", url: "/api/relay/devices/v2", headers: { Authorization: `Bearer ${userAToken}` } });
      const b = await app.inject({ method: "GET", url: "/api/relay/devices/v2", headers: { Authorization: `Bearer ${userBToken}` } });
      expect(a.json<{ devices: Array<{ deviceManagementId: string }> }>().devices).toHaveLength(1);
      expect(b.json<{ devices: Array<{ deviceManagementId: string }> }>().devices).toHaveLength(1);
      expect(a.json<{ devices: Array<{ deviceManagementId: string }> }>().devices[0]?.deviceManagementId).not.toBe(b.json<{ devices: Array<{ deviceManagementId: string }> }>().devices[0]?.deviceManagementId);
    });

    test("group revoke is caller-owned, count-confirmed, and revokes every active member", async () => {
      await pairGrouped(groupA, "11111111-1111-4111-8111-111111111111");
      await pairGrouped(groupA, "22222222-2222-4222-8222-222222222222");
      const managementId = relayDeviceManagementIdFor(USER_A, groupA);
      const stale = await app.inject({ method: "DELETE", url: `/api/relay/devices/v2/${managementId}`, headers: { Authorization: `Bearer ${userAToken}`, "Content-Type": "application/json" }, payload: { expectedPairingCount: 1 } });
      expect(stale.statusCode).toBe(409);
      expect(fake.rows.filter((row) => row.revokedAt === null)).toHaveLength(2);
      const revoked = await app.inject({ method: "DELETE", url: `/api/relay/devices/v2/${managementId}`, headers: { Authorization: `Bearer ${userAToken}`, "Content-Type": "application/json" }, payload: { expectedPairingCount: 2 } });
      expect(revoked.statusCode).toBe(200);
      expect(revoked.json<{ affectedPairingCount: number; auditRecorded: boolean }>()).toEqual({
        affectedPairingCount: 2,
        auditRecorded: true,
      });
      expect(fake.rows.every((row) => row.revokedAt !== null)).toBe(true);
      expect(reconciledGenerations).toEqual([["relay-token-1", "relay-token-2"]]);
      expect(lifecycleAudits).toHaveLength(2);
      expect(lifecycleAudits.at(-1)).toEqual({
        managementTarget: managementId,
        affectedPairingCount: 2,
      });
    });

    test("an audit failure cannot turn a committed grouped revoke into a retryable error", async () => {
      await pairGrouped(groupA, "11111111-1111-4111-8111-111111111111");
      failLifecycleAudit = true;
      const managementId = relayDeviceManagementIdFor(USER_A, groupA);

      const revoked = await app.inject({
        method: "DELETE",
        url: `/api/relay/devices/v2/${managementId}`,
        headers: {
          Authorization: `Bearer ${userAToken}`,
          "Content-Type": "application/json",
        },
        payload: { expectedPairingCount: 1 },
      });

      expect(revoked.statusCode).toBe(200);
      expect(revoked.json<{ affectedPairingCount: number; auditRecorded: boolean }>()).toEqual({
        affectedPairingCount: 1,
        auditRecorded: false,
      });
      expect(fake.rows[0]?.revokedAt).not.toBeNull();
      expect(reconciledGenerations).toEqual([["relay-token-1"]]);
    });

    test("rejects malformed management targets before persistence or audit", async () => {
      await pairGrouped(groupA, "11111111-1111-4111-8111-111111111111");
      const sentinels = [
        groupA,
        "rty_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "https://attacker.invalid/private?token=secret",
      ];

      for (const sentinel of sentinels) {
        const response = await app.inject({
          method: "DELETE",
          url: `/api/relay/devices/v2/${encodeURIComponent(sentinel)}`,
          headers: {
            Authorization: `Bearer ${userAToken}`,
            "Content-Type": "application/json",
          },
          payload: { expectedPairingCount: 1 },
        });
        expect(response.statusCode).toBe(400);
        expect(JSON.stringify(response.json())).not.toContain(sentinel);
      }

      expect(fake.rows[0]?.revokedAt).toBeNull();
      expect(reconciledGenerations).toHaveLength(0);
      expect(lifecycleAudits).toHaveLength(0);
    });

    test("historical cleanup requires confirmation and never revokes grouped rows", async () => {
      await pairGrouped(groupA, "11111111-1111-4111-8111-111111111111");
      await app.inject({ method: "POST", url: "/api/relay/pair", headers: { "Content-Type": "application/json", Authorization: `Bearer ${userAToken}` }, payload: { deviceLabel: "legacy" } });
      const noConfirm = await app.inject({ method: "POST", url: "/api/relay/devices/v2/historical/cleanup", headers: { Authorization: `Bearer ${userAToken}`, "Content-Type": "application/json" }, payload: { expectedPairingCount: 1 } });
      expect(noConfirm.statusCode).toBe(400);
      const clean = await app.inject({ method: "POST", url: "/api/relay/devices/v2/historical/cleanup", headers: { Authorization: `Bearer ${userAToken}`, "Content-Type": "application/json" }, payload: { confirm: true, expectedPairingCount: 1 } });
      expect(clean.statusCode).toBe(200);
      expect(fake.rows.find((row) => row.deviceGroupId === null)?.revokedAt).not.toBeNull();
      expect(fake.rows.find((row) => row.deviceGroupId === groupA)?.revokedAt).toBeNull();
    });
  });
});
