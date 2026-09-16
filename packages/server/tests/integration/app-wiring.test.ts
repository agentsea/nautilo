/**
 * App-level wiring smoke tests for route registration and chat room auth.
 *
 * POST /api/chat bearer resolution needs a real `actors` + `users` row so
 * `getFederatedIdForActor` resolves (no `mock.module("@nautilo/trust")` —
 * Bun globals leak across files in one process).
 */
import { describe, expect, mock, test, beforeAll, afterAll } from "bun:test";
import type { PolicyResolver, RuntimePolicyContext } from "@nautilo/trust";
import { ensureDatabase } from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";

import { createApp } from "../../src/app";
import { setupOwnerAppFixture, type AppFixture } from "../integration/helpers/app-fixture";

const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const ROOM_ID = "44444444-4444-4444-8444-444444444444";

let fx: AppFixture | null = null;

beforeAll(async () => {
  // D266 Wave 1: route the scratch instance before the direct `ensureDatabase`
  // call below so this suite cannot resolve the protected `(default)` DB even
  // when invoked ad-hoc from the repo root (package preload may not fire).
  bootstrapTestDbInstance();
  await ensureDatabase();
  fx = await setupOwnerAppFixture({ suiteName: "appwire" });
});

afterAll(async () => {
  await fx?.cleanup();
});

function requireFixture(): AppFixture {
  if (!fx) throw new Error("app fixture was not initialized");
  return fx;
}

function makeContext(
  ownerId: string,
  ownerActorId: string,
  roomId = "",
): RuntimePolicyContext {
  return {
    laneKey: roomId ? `room:${roomId}` : "app:default",
    actorId: ownerActorId,
    agentId: AGENT_ID,
    roomId,
    roomType: roomId ? "private" : "",
    graphThreadId: roomId ? `room:${roomId}` : "app:default",
    actorLabel: "Owner",
    actorFederatedId: "@owner@test.local",
    agentFederatedId: "@agent@test.local",
    speakerTrust: "verified",
    laneScope: "private",
    actorRole: "owner",
    memoryAccess: {
      ownerId,
      actorId: ownerActorId,
      agentId: AGENT_ID,
      roomId,
      readableNamespaces: [],
      mutableNamespaces: [],
      writableNamespaces: [],
      toolPolicy: {},
    },
  } as unknown as RuntimePolicyContext;
}

describe("createApp route/runtime wiring", () => {
  test("registers /api/rooms on the real app", async () => {
    const fixture = requireFixture();
    const app = await createApp({
      silent: true,
      ownerId: fixture.ownerId,
      ownerActorId: fixture.ownerActorId,
    });
    try {
      const res = await app.inject({ method: "GET", url: "/api/rooms" });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ rooms: [] });
    } finally {
      await app.close();
    }
  });

  test("passes POST /api/chat roomId into bearer resolution before room 404", async () => {
    const fixture = requireFixture();
    const resolveContext = mock(
      async (_channel: string, _actor: string, _agent: string, roomId?: string) =>
        makeContext(fixture.ownerId, fixture.ownerActorId, roomId ?? ""),
    );
    const policyResolver = {
      resolveContext,
    } as unknown as PolicyResolver;
    const pinProvider = {
      verifyProof: mock(async () => true),
      isEnrolled: mock(async () => true),
    };
    const app = await createApp({
      silent: true,
      ownerId: fixture.ownerId,
      ownerActorId: fixture.ownerActorId,
      policyResolver,
      pinProvider: pinProvider as never,
    });
    try {
      const token = await fixture.mintOwnerBearer();

      const res = await app.inject({
        method: "POST",
        url: "/api/chat",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        payload: {
          message: "hi",
          roomId: ROOM_ID,
          currentFolder: "\0bad-path",
        },
      });
      expect(res.statusCode).toBe(404);
      expect(resolveContext).toHaveBeenCalled();
      const args = resolveContext.mock.calls.at(-1) as unknown[] | undefined;
      expect(args?.[3]).toBe(ROOM_ID);
    } finally {
      await app.close();
    }
  });

  test("registers /api/apps/:appId/runtime before SPA fallback", async () => {
    const fixture = requireFixture();
    const app = fixture.app;
    const unauth = await app.inject({
      method: "GET",
      url: "/api/apps/nautilo-writer/runtime",
    });
    expect(unauth.statusCode).toBe(401);
    expect(unauth.headers["content-type"]).toContain("application/json");

    const token = await fixture.mintOwnerBearer();
    const authed = await app.inject({
      method: "GET",
      url: "/api/apps/nautilo-writer/runtime",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(authed.statusCode).toBe(200);
    const body = JSON.parse(authed.body) as Record<string, unknown>;
    expect(body["appId"]).toBe("nautilo-writer");
    expect(body["sourceHash"]).toMatch(/^[a-f0-9]{64}$/);

    const srcDoc = body["srcDoc"] as string;
    expect(typeof srcDoc).toBe("string");
    expect(srcDoc.length).toBeGreaterThan(0);
    expect(srcDoc).toContain("connect-src 'none'");
    expect(srcDoc).toContain('appId:"nautilo-writer"');

    const manifest = body["manifest"] as Record<string, unknown>;
    expect(manifest["id"]).toBe("nautilo-writer");
    expect(manifest["name"]).toBe("Writer");
    expect(manifest["version"]).toBe("1.5.0");
    expect(body["agentToolsBuild"]).toMatchObject({
      status: "ok",
      toolCount: 24,
    });
    expect((body["agentToolsBuild"] as { toolNames: string[] }).toolNames).toContain(
      "app_nautilo_writer__inspect_document",
    );
    expect(authed.headers["content-type"]).toContain("application/json");
  });
});
