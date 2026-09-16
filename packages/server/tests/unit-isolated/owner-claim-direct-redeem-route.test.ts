import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import Fastify from "fastify";
import * as realDb from "@nautilo/db";
import * as realTrust from "@nautilo/trust";
import * as realRedeem from "../../src/lib/redeem-invite";
import { __resetInviteRateLimitForTests } from "../../src/lib/invite-rate-limit";

const claim = `inv_${"a".repeat(32)}`;
let inviteKind = "claim";
const db = {
  select: mock((_selection?: unknown) => ({
    from: mock((_table: unknown) => ({
      where: mock((_condition: unknown) => ({
        limit: mock(async (_count: number) => [{
          kind: inviteKind,
          revokedAt: null,
          expiresAt: new Date(Date.now() + 60_000),
          maxUses: 1,
          usedCount: 0,
          halfRedeemedUserId: null,
        }]),
      })),
    })),
  })),
};
const logto = { marker: "logto" };
const recoveryCodes = Array.from(
  { length: 8 },
  (_, index) => index.toString(16).padStart(24, "0"),
);
const getLogtoAdminClient = mock(() => logto);
const redeemInviteAtomically = mock(async (
  _token: string,
  _input: realRedeem.RedeemInput,
  _deps: realRedeem.RedeemInviteDeps,
) => ({
  ok: true as const,
  recoveryCodes,
  landingRoomId: "room-owner",
  newUserId: "user-owner",
  newActorId: "actor-owner",
}));
const refreshRoomSubscriptionsForUser = mock(async () => undefined);

mock.module("@nautilo/db", () => ({
  ...realDb,
  db,
  hasClaimedOwner: mock(async () => false),
}));
mock.module("@nautilo/trust", () => ({
  ...realTrust,
  getLogtoAdminClient,
}));
mock.module("../../src/lib/redeem-invite", () => ({
  ...realRedeem,
  redeemInviteAtomically,
}));
mock.module("../../src/realtime/ws-publisher", () => ({
  refreshRoomSubscriptionsForUser,
}));

const root = mkdtempSync(join(tmpdir(), "nautilo-owner-claim-direct-"));

async function makeApp() {
  const href = new URL("../../src/routes/invites.ts", import.meta.url).href;
  const { invitesRoutes } = await import(`${href}?t=${Date.now()}`) as typeof import("../../src/routes/invites");
  const app = Fastify({ logger: false });
  const auditPath = join(root, `audit-${Date.now()}-${Math.random()}.jsonl`);
  invitesRoutes(app, {
    ownerId: "bootstrap-owner",
    securityAuditLogPath: auditPath,
    publicInviteBaseUrl: "http://127.0.0.1",
  });
  await app.ready();
  return { app, auditPath };
}

beforeEach(() => {
  __resetInviteRateLimitForTests();
  inviteKind = "claim";
  redeemInviteAtomically.mockClear();
  refreshRoomSubscriptionsForUser.mockClear();
  refreshRoomSubscriptionsForUser.mockImplementation(async () => undefined);
  getLogtoAdminClient.mockClear();
  db.select.mockClear();
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("POST /api/setup/owner-claim/redeem", () => {
  test("requires the body claim and privileged setup authority, then returns only the strict durable result", async () => {
    const { app, auditPath } = await makeApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/setup/owner-claim/redeem",
        payload: {
          schemaVersion: 1,
          claim,
          handle: "owner",
          displayName: "Owner",
          password: "permanent-password",
          pin: "123456",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({
        schemaVersion: 1,
        state: "owner-bound",
        recoveryCodes,
      });
      expect(redeemInviteAtomically).toHaveBeenCalledTimes(1);
      expect(redeemInviteAtomically.mock.calls[0]?.[0]).toBe(claim);
      expect(redeemInviteAtomically.mock.calls[0]?.[1]).toEqual({
        handle: "owner",
        displayName: "Owner",
        password: "permanent-password",
        pin: "123456",
        forcePasswordChange: false,
      });
      expect(redeemInviteAtomically.mock.calls[0]?.[2]).toMatchObject({
        logto,
        allowLogtoSessionMint: false,
      });
      expect(refreshRoomSubscriptionsForUser).toHaveBeenCalledWith("user-owner", "actor-owner");
      expect(readFileSync(auditPath, "utf8")).not.toContain(claim);
    } finally {
      await app.close();
    }
  });

  test("rejects widened bodies and non-claim invite capabilities before mutation", async () => {
    const { app } = await makeApp();
    try {
      const widened = await app.inject({
        method: "POST",
        url: "/api/setup/owner-claim/redeem",
        payload: {
          schemaVersion: 1,
          claim,
          handle: "owner",
          displayName: "Owner",
          password: "permanent-password",
          pin: "123456",
          forcePasswordChange: true,
        },
      });
      expect(widened.statusCode).toBe(400);
      expect(redeemInviteAtomically).not.toHaveBeenCalled();

      inviteKind = "server";
      const ordinary = await app.inject({
        method: "POST",
        url: "/api/setup/owner-claim/redeem",
        payload: {
          schemaVersion: 1,
          claim,
          handle: "owner",
          displayName: "Owner",
          password: "permanent-password",
          pin: "123456",
        },
      });
      expect(ordinary.statusCode).toBe(404);
      expect(redeemInviteAtomically).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test("rejects a non-loopback caller without valid bootstrap authority before claim lookup", async () => {
    const { app } = await makeApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/setup/owner-claim/redeem",
        remoteAddress: "203.0.113.44",
        headers: { authorization: "Bearer invalid-bootstrap" },
        payload: {
          schemaVersion: 1,
          claim,
          handle: "owner",
          displayName: "Owner",
          password: "permanent-password",
          pin: "123456",
        },
      });
      expect(response.statusCode).toBe(403);
      expect(db.select).not.toHaveBeenCalled();
      expect(redeemInviteAtomically).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test("returns committed one-shot codes even if realtime refresh fails", async () => {
    refreshRoomSubscriptionsForUser.mockImplementationOnce(async () => {
      throw new Error("realtime unavailable");
    });
    const { app } = await makeApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/setup/owner-claim/redeem",
        payload: {
          schemaVersion: 1,
          claim,
          handle: "owner",
          displayName: "Owner",
          password: "permanent-password",
          pin: "123456",
        },
      });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({
        schemaVersion: 1,
        state: "owner-bound",
        recoveryCodes,
      });
    } finally {
      await app.close();
    }
  });
});
