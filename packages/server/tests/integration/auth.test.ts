import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { and, eq, inArray, namespaces, rooms, roomMembers, hasAdminUser, hasUnredeemedClaimInvite } from "@nautilo/db";
import { setupOwnerAppFixture, type AppFixture } from "./helpers/app-fixture";

let fx: AppFixture;
const authResumeNamespaceIds: string[] = [];

beforeAll(async () => {
  fx = await setupOwnerAppFixture({ suiteName: "auth" });
  // M075 — resumeThreadAllowed maps threadId → rooms.graph_thread_id + membership.
  for (const graphThreadId of ["test-thread-1", "test-thread-2"] as const) {
    const [ns] = await fx.db
      .insert(namespaces)
      .values({ scope: "room", label: `auth-resume-${graphThreadId}` })
      .returning({ id: namespaces.id });
    if (!ns) throw new Error("namespace");
    authResumeNamespaceIds.push(ns.id);
    const [room] = await fx.db
      .insert(rooms)
      .values({
        ownerId: fx.ownerId,
        type: "private",
        label: `auth resume ${graphThreadId}`,
        graphThreadId,
        namespaceId: ns.id,
        humanActorIds: [fx.ownerActorId],
      })
      .returning({ id: rooms.id });
    if (!room) throw new Error("room");
    await fx.db.insert(roomMembers).values({
      roomId: room.id,
      actorId: fx.ownerActorId,
      roomRole: "member",
    });
  }
});

afterAll(async () => {
  await fx.db
    .delete(rooms)
    .where(
      and(
        eq(rooms.ownerId, fx.ownerId),
        inArray(rooms.graphThreadId, ["test-thread-1", "test-thread-2"]),
      ),
    );
  if (authResumeNamespaceIds.length > 0) {
    await fx.db.delete(namespaces).where(inArray(namespaces.id, authResumeNamespaceIds));
  }
  await fx.cleanup();
});

describe("GET /health", () => {
  test("returns authRequired: true and enrolled matches D112 canonical census", async () => {
    const res = await fx.app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      status: string;
      authRequired: boolean;
      enrolled: boolean;
    };
    expect(body.status).toBe("ok");
    expect(body.authRequired).toBe(true);
    const canonicalEnrolled =
      (await hasAdminUser(fx.db)) && !(await hasUnredeemedClaimInvite(fx.db));
    expect(body.enrolled).toBe(canonicalEnrolled);
  });
});

describe("Guest-by-default", () => {
  test("profile without token returns public shell (no owner-data leak)", async () => {
    const res = await fx.app.inject({ method: "GET", url: "/api/profile" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body["viewerRole"]).toBe("guest");
    expect(JSON.stringify(body)).not.toContain("soulFile");
    expect(JSON.stringify(body)).not.toContain("federatedId");
    expect(JSON.stringify(body)).not.toContain("userId");
  });

  test("owner profile with valid token is not denied (owner access)", async () => {
    const token = await fx.mintOwnerBearer();
    const res = await fx.app.inject({
      method: "GET",
      url: "/api/profile",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).not.toBe(401);
  });

  test("profile with invalid token falls back to public shell (no owner-data leak)", async () => {
    const res = await fx.app.inject({
      method: "GET",
      url: "/api/profile",
      headers: { authorization: "Bearer bogus-token-12345" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body["viewerRole"]).toBe("guest");
    expect(JSON.stringify(body)).not.toContain("soulFile");
    expect(JSON.stringify(body)).not.toContain("federatedId");
    expect(JSON.stringify(body)).not.toContain("userId");
  });

  test("public profile status exposes onboarding state + localhost relayUserId bootstrap", async () => {
    const res = await fx.app.inject({ method: "GET", url: "/api/profile/status" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(typeof body["exists"]).toBe("boolean");
    expect(typeof body["onboardingCompleted"]).toBe("boolean");
    expect(body["relayUserId"]).toBe(fx.ownerId);
    expect(body["name"]).toBeUndefined();
    expect(body["soulFile"]).toBeUndefined();
    expect(body["avatarUrl"]).toBeUndefined();
  });

  test("GET /api/auth/whoami without session has null sessionUserId", async () => {
    const res = await fx.app.inject({ method: "GET", url: "/api/auth/whoami" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { sessionUserId?: unknown; sessionActorId?: unknown };
    expect(body.sessionUserId).toBeNull();
    expect(body.sessionActorId).toBeNull();
  });

  test("GET /api/auth/whoami with owner session returns sessionUserId UUID", async () => {
    const token = await fx.mintOwnerBearer();
    const res = await fx.app.inject({
      method: "GET",
      url: "/api/auth/whoami",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { sessionUserId?: unknown; sessionActorId?: unknown };
    expect(body.sessionUserId).toBe(fx.ownerId);
    expect(typeof body.sessionActorId).toBe("string");
    expect((body.sessionActorId as string).length).toBeGreaterThan(0);
  });
});

describe("M072 — legacy local-auth routes removed", () => {
  test("POST /api/auth/session is gone (404)", async () => {
    const res = await fx.app.inject({
      method: "POST",
      url: "/api/auth/session",
      headers: { "content-type": "application/json" },
      payload: { pin: fx.ownerPin },
    });
    expect(res.statusCode).toBe(404);
  });

  test("POST /api/auth/enroll is gone (404)", async () => {
    const res = await fx.app.inject({
      method: "POST",
      url: "/api/auth/enroll",
      headers: { "content-type": "application/json" },
      payload: { pin: "567890" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/auth/verify-pin", () => {
  test("verifies the authenticated Human without minting a reusable proof", async () => {
    const token = await fx.mintOwnerBearer();
    const res = await fx.app.inject({
      method: "POST",
      url: "/api/auth/verify-pin",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      payload: { pin: fx.ownerPin },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  test("fails closed for a wrong PIN and for an unauthenticated caller", async () => {
    const token = await fx.mintOwnerBearer();
    const wrong = await fx.app.inject({
      method: "POST",
      url: "/api/auth/verify-pin",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      payload: { pin: "999999" },
    });
    expect(wrong.statusCode).toBe(401);
    expect(JSON.parse(wrong.body)).toEqual({ error: "Invalid PIN" });

    const guest = await fx.app.inject({
      method: "POST",
      url: "/api/auth/verify-pin",
      headers: { "content-type": "application/json" },
      payload: { pin: fx.ownerPin },
    });
    expect(guest.statusCode).toBe(401);
  });
});

describe("Owner onboarding compatibility", () => {
  test("handle validation returns wizard-compatible `valid` shape", async () => {
    const handle = `wizard${Date.now().toString(36).slice(-6)}`;
    const res = await fx.app.inject({
      method: "POST",
      url: "/api/setup/validate-handle",
      headers: { "content-type": "application/json" },
      payload: { handle },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      ok?: boolean;
      valid?: boolean;
      normalized?: string;
    };
    expect(body.ok).toBe(true);
    expect(body.valid).toBe(true);
    expect(body.normalized).toBe(handle);
  });

  test("PUT /api/owner accepts the Electron wizard payload", async () => {
    const token = await fx.mintOwnerBearer();
    const handle = `wizardowner${Date.now().toString(36).slice(-6)}`;

    const res = await fx.app.inject({
      method: "PUT",
      url: "/api/owner",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      payload: {
        displayName: "Wizard Owner",
        handle,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      ok?: boolean;
      name?: string;
      handle?: string;
      federatedId?: string;
    };
    expect(body.ok).toBe(true);
    expect(body.name).toBe("Wizard Owner");
    expect(body.handle).toBe(handle);
    expect(body.federatedId).toContain(handle);
  });
});

describe("POST /api/auth/pin (change PIN)", () => {
  let validToken: string;

  beforeAll(async () => {
    validToken = await fx.mintOwnerBearer();
  });

  test("changes PIN with correct current PIN", async () => {
    const res = await fx.app.inject({
      method: "POST",
      url: "/api/auth/pin",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${validToken}`,
      },
      payload: { currentPin: "847291", newPin: "391047" },
    });
    expect(res.statusCode).toBe(200);

    const proofOk = await fx.app.inject({
      method: "POST",
      url: "/api/auth/prove-and-resume",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${validToken}`,
      },
      payload: { pin: "391047", threadId: "test-thread-1" },
    });
    expect(proofOk.statusCode).toBe(200);

    const revertRes = await fx.app.inject({
      method: "POST",
      url: "/api/auth/pin",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${validToken}`,
      },
      payload: { currentPin: "391047", newPin: "847291" },
    });
    expect(revertRes.statusCode).toBe(200);
  });

  test("rejects change with wrong current PIN", async () => {
    const token = await fx.mintOwnerBearer();
    const res = await fx.app.inject({
      method: "POST",
      url: "/api/auth/pin",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      payload: { currentPin: "wrongwrong", newPin: "391047" },
    });
    expect(res.statusCode).toBe(401);
  });

  test("PIN change requires session token (guest gets 401 on this endpoint)", async () => {
    const res = await fx.app.inject({
      method: "POST",
      url: "/api/auth/pin",
      headers: { "content-type": "application/json" },
      payload: { currentPin: "847291", newPin: "391047" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /api/auth/prove-and-resume", () => {
  test("returns 401 without session token", async () => {
    const res = await fx.app.inject({
      method: "POST",
      url: "/api/auth/prove-and-resume",
      headers: { "content-type": "application/json" },
      payload: { pin: "847291", threadId: "thread-1" },
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe("Authentication required");
  });

  test("returns 401 with wrong PIN", async () => {
    const token = await fx.mintOwnerBearer();

    const res = await fx.app.inject({
      method: "POST",
      url: "/api/auth/prove-and-resume",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      payload: { pin: "999999", threadId: "thread-1" },
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe("Invalid PIN");
  });

  test("returns ok:true with correct PIN (approval)", async () => {
    const token = await fx.mintOwnerBearer();

    const res = await fx.app.inject({
      method: "POST",
      url: "/api/auth/prove-and-resume",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      payload: { pin: "847291", threadId: "test-thread-1" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test("returns ok:true for denial (no PIN needed)", async () => {
    const token = await fx.mintOwnerBearer();

    const res = await fx.app.inject({
      method: "POST",
      url: "/api/auth/prove-and-resume",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      payload: { denied: true, threadId: "test-thread-2" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test("returns 400 when threadId is missing", async () => {
    const token = await fx.mintOwnerBearer();

    const res = await fx.app.inject({
      method: "POST",
      url: "/api/auth/prove-and-resume",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      payload: { pin: "847291" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("Lockout after repeated failures", () => {
  test(
    "5 consecutive wrong PINs on prove-and-resume triggers 429, clears after duration",
    async () => {
      const token = await fx.mintOwnerBearer();
      for (let i = 0; i < 5; i++) {
        await fx.app.inject({
          method: "POST",
          url: "/api/auth/prove-and-resume",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          payload: { pin: "123456", threadId: "test-thread-2" },
        });
      }

      const lockedRes = await fx.app.inject({
        method: "POST",
        url: "/api/auth/prove-and-resume",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        payload: { pin: "847291", threadId: "test-thread-2" },
      });
      expect(lockedRes.statusCode).toBe(429);

      await new Promise((r) => setTimeout(r, 31_000));

      const unlockedRes = await fx.app.inject({
        method: "POST",
        url: "/api/auth/prove-and-resume",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        payload: { pin: "847291", threadId: "test-thread-2" },
      });
      expect(unlockedRes.statusCode).toBe(200);
    },
    45_000,
  );
});
