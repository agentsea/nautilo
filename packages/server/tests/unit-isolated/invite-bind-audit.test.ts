/**
 * D240 — `/api/bind-logto-user` security audit rows.
 *
 * Isolated runner: each file under `tests/unit-isolated/` runs in its own
 * `bun test` invocation (see package.json) so `mock.module` does not leak.
 * Dynamic-import auth routes after mocks (static imports hoist above mock.module).
 */
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import Fastify from "fastify";
import * as realDb from "@nautilo/db";
import * as realTrust from "@nautilo/trust";
import * as realRedeemInvite from "../../src/lib/redeem-invite";
import type { SecurityAuditEvent } from "../../src/lib/security-audit-log";

const verifyLogtoAccessToken = mock(async (_bearer: string) => ({
  sub: "logto-sub-1",
  name: "Alice Display",
}));
const getLogtoUser = mock(async (_sub: string) => ({ username: "alice" }));
const getLogtoAdminClient = mock(() => ({ getUser: getLogtoUser }));
type MockBindResult =
  | {
      ok: true;
      actorId: string;
      userId: string;
      logtoSub: string;
    }
  | {
      ok: false;
      httpStatus: number;
      error: string;
      code: string;
    };
const redeemInviteWithLogtoSub = mock(
  async (): Promise<MockBindResult> => ({
    ok: true,
    actorId: "actor-1",
    userId: "user-1",
    logtoSub: "logto-sub-1",
  }),
);

let inviteRow:
  | {
      kind: string;
      targetGroupId: string | null;
      targetRoomId: string | null;
    }
  | null = {
    kind: "server",
    targetGroupId: "group-1",
    targetRoomId: "room-1",
  };

const db = {
  select: mock((_selection: unknown) => ({
    from: mock((_table: unknown) => ({
      where: mock((_condition: unknown) => ({
        limit: mock(async (_limit: number) =>
          inviteRow
            ? [
                {
                  inviteKind: inviteRow.kind,
                  targetGroupId: inviteRow.targetGroupId,
                  targetRoomId: inviteRow.targetRoomId,
                },
              ]
            : [],
        ),
      })),
    })),
  })),
};

mock.module("@nautilo/db", () => ({
  ...realDb,
  agentDb: realDb.agentDb,
  db,
}));

mock.module("@nautilo/trust", () => ({
  ...realTrust,
  getLogtoAdminClient,
  verifyLogtoAccessToken,
}));

mock.module("../../src/lib/redeem-invite", () => ({
  ...realRedeemInvite,
  redeemInviteWithLogtoSub,
}));

async function loadAuthRoutesFresh(): Promise<typeof import("../../src/routes/auth")> {
  const href = new URL("../../src/routes/auth.ts", import.meta.url).href;
  return import(`${href}?t=${Date.now()}`) as Promise<typeof import("../../src/routes/auth")>;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function packState(inviteToken: string, handle = "alice"): string {
  return Buffer.from(`${inviteToken}:${handle}:nonce`, "utf8").toString("base64url");
}

async function makeApp() {
  const { authRoutes } = await loadAuthRoutesFresh();
  const app = Fastify({ logger: false });
  const auditEvents: SecurityAuditEvent[] = [];
  authRoutes(app, {
    pinProvider: {} as never,
    ownerActorId: "owner-actor",
    ownerId: "owner-user",
    auditEvent: async (event) => {
      auditEvents.push(event);
    },
    now: () => new Date("2026-05-29T10:00:00.000Z"),
  });
  await app.ready();
  return { app, auditEvents };
}

beforeEach(() => {
  verifyLogtoAccessToken.mockClear();
  getLogtoUser.mockClear();
  getLogtoAdminClient.mockClear();
  redeemInviteWithLogtoSub.mockClear();
  db.select.mockClear();
  inviteRow = {
    kind: "server",
    targetGroupId: "group-1",
    targetRoomId: "room-1",
  };
  getLogtoUser.mockImplementation(async () => ({ username: "alice" }));
  redeemInviteWithLogtoSub.mockImplementation(async () => ({
    ok: true as const,
    actorId: "actor-1",
    userId: "user-1",
    logtoSub: "logto-sub-1",
  }));
});

describe("POST /api/bind-logto-user audit rows (D240)", () => {
  test("writes a non-sensitive success row with post-M128 invite context", async () => {
    const inviteToken = "inv_1234567890";
    const { app, auditEvents } = await makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/bind-logto-user",
        headers: {
          authorization: "Bearer good-token",
          "user-agent": "nautilo-test/1",
        },
        payload: { state: packState(inviteToken) },
      });

      expect(res.statusCode).toBe(200);
      expect(auditEvents).toHaveLength(1);
      expect(auditEvents[0]).toMatchObject({
        kind: "invite_bind_logto_user_succeeded",
        ts: "2026-05-29T10:00:00.000Z",
        actorId: "actor-1",
        ip: "127.0.0.1",
        userAgent: "nautilo-test/1",
        tokenHash: sha256Hex(inviteToken),
        inviteKind: "server",
        targetGroupId: "group-1",
        targetRoomId: "room-1",
        userId: "user-1",
        logtoSub: "logto-sub-1",
        handleHash: sha256Hex("alice"),
      });
      const serialized = JSON.stringify(auditEvents[0]);
      expect(serialized).not.toContain(inviteToken);
      expect(serialized).not.toContain("good-token");
      expect(serialized).not.toContain("\"alice\"");
    } finally {
      await app.close();
    }
  });

  test("writes invalid_state after bearer verification without scanner-noise token material", async () => {
    const { app, auditEvents } = await makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/bind-logto-user",
        headers: { authorization: "Bearer good-token" },
        payload: { state: "not-valid-state" },
      });

      expect(res.statusCode).toBe(422);
      expect(auditEvents).toHaveLength(1);
      expect(auditEvents[0]).toMatchObject({
        kind: "invite_bind_logto_user_failed",
        reason: "invalid_state",
        actorId: null,
        logtoSub: "logto-sub-1",
      });
      expect(auditEvents[0]).not.toHaveProperty("tokenHash");
      expect(JSON.stringify(auditEvents[0])).not.toContain("good-token");
    } finally {
      await app.close();
    }
  });

  test("writes handle_mismatch with token and handle hashes, not raw values", async () => {
    const inviteToken = "inv_abcdefghij";
    getLogtoUser.mockImplementationOnce(async () => ({ username: "bob" }));
    const { app, auditEvents } = await makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/bind-logto-user",
        headers: { authorization: "Bearer good-token" },
        payload: { state: packState(inviteToken, "alice") },
      });

      expect(res.statusCode).toBe(409);
      expect(auditEvents).toHaveLength(1);
      expect(auditEvents[0]).toMatchObject({
        kind: "invite_bind_logto_user_failed",
        reason: "handle_mismatch",
        tokenHash: sha256Hex(inviteToken),
        inviteKind: "server",
        targetGroupId: "group-1",
        targetRoomId: "room-1",
        logtoSub: "logto-sub-1",
        handleHash: sha256Hex("alice"),
      });
      const serialized = JSON.stringify(auditEvents[0]);
      expect(serialized).not.toContain(inviteToken);
      expect(serialized).not.toContain("\"alice\"");
      expect(serialized).not.toContain("\"bob\"");
    } finally {
      await app.close();
    }
  });

  test("writes redeem helper failure with invite context", async () => {
    const inviteToken = "inv_redeemfail";
    redeemInviteWithLogtoSub.mockImplementationOnce(async () => ({
      ok: false as const,
      httpStatus: 410,
      error: "expired",
      code: "expired",
    }));
    const { app, auditEvents } = await makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/bind-logto-user",
        headers: { authorization: "Bearer good-token" },
        payload: { state: packState(inviteToken) },
      });

      expect(res.statusCode).toBe(410);
      expect(auditEvents).toHaveLength(1);
      expect(auditEvents[0]).toMatchObject({
        kind: "invite_bind_logto_user_failed",
        reason: "expired",
        tokenHash: sha256Hex(inviteToken),
        inviteKind: "server",
        targetGroupId: "group-1",
        targetRoomId: "room-1",
        logtoSub: "logto-sub-1",
        handleHash: sha256Hex("alice"),
      });
    } finally {
      await app.close();
    }
  });

  test("does not audit missing or invalid bearer scanner traffic", async () => {
    const { app, auditEvents } = await makeApp();
    try {
      const missing = await app.inject({
        method: "POST",
        url: "/api/bind-logto-user",
        payload: { state: packState("inv_no_bearer") },
      });
      verifyLogtoAccessToken.mockImplementationOnce(async () => {
        throw new Error("invalid");
      });
      const invalid = await app.inject({
        method: "POST",
        url: "/api/bind-logto-user",
        headers: { authorization: "Bearer bad-token" },
        payload: { state: packState("inv_bad_bearer") },
      });

      expect(missing.statusCode).toBe(401);
      expect(invalid.statusCode).toBe(401);
      expect(auditEvents).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});
