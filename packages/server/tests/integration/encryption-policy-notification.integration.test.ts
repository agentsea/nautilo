import { afterEach, describe, expect, test } from "bun:test";
import Fastify from "fastify";
import type { WebSocket as WsWebSocket } from "ws";

import {
  DISABLE_SHADOW_ENCRYPTION_CONFIRMATION,
} from "@nautilo/api-client";
import type { LiveShadowEncryptionTransitionPolicy } from "@nautilo/db";

import {
  addClient,
  flushPendingWebSocketBroadcasts,
} from "../../src/realtime/ws-publisher";
import { encryptionTransitionRoutes } from "../../src/routes/encryption-transition";

interface MockWs {
  readyState: number;
  sent: string[];
  OPEN: number;
  on(event: "close", handler: () => void): void;
  send(payload: string): void;
  closeForTest(): void;
}

function makeClient(): MockWs {
  let closeHandler: () => void = () => undefined;
  return {
    readyState: 1,
    sent: [],
    OPEN: 1,
    on(_event, handler) { closeHandler = handler; },
    send(payload) { this.sent.push(payload); },
    closeForTest() {
      this.readyState = 3;
      closeHandler();
    },
  };
}

let client: MockWs | null = null;

afterEach(() => {
  client?.closeForTest();
  client = null;
});

describe("encryption policy notification production composition", () => {
  test("the real route defaults to the real broadcaster at the commit boundary", async () => {
    const before: LiveShadowEncryptionTransitionPolicy = {
      mode: "shadow_encryption",
      shadowBehavior: "fallback",
      revision: 2,
      shadowEncryptionStartedAt: new Date("2026-09-07T10:00:00.000Z"),
      updatedAt: new Date("2026-09-07T10:00:00.000Z"),
    };
    const after: LiveShadowEncryptionTransitionPolicy = {
      ...before,
      mode: "plaintext_only",
      revision: 3,
      updatedAt: new Date("2026-09-07T10:01:00.000Z"),
    };
    client = makeClient();
    addClient(client as unknown as WsWebSocket, {
      userId: "integration-user",
      actorId: "integration-actor",
      roomIds: new Set(),
    });

    const app = Fastify({ logger: false });
    app.decorateRequest("sessionUserId", null);
    app.addHook("preHandler", async (request) => {
      request.sessionUserId = "integration-user";
    });
    encryptionTransitionRoutes(app, {
      getCapabilities: async () => ["manage_server_settings"],
      getDb: () => ({}) as never,
      getPolicy: async () => before,
      casPolicy: async () => after,
      getDashboard: async () => [],
      getObservationPressure: async () => ({}) as never,
      getLiveTurnDashboard: async () => ({}) as never,
      getHumanPeerLiveDashboard: async () => ({}) as never,
      getSharedAgentLiveDashboard: async () => ({}) as never,
      getDomainKeyCatchUpDashboard: async () => ({}) as never,
      getHistoryReadActivity: async () => ({}) as never,
      getStrictShadowBoundaryHealth: async () => {
        throw new Error("dashboard unavailable");
      },
      auditEvent: () => undefined,
      // Intentionally omit publishPolicyChanged: this exercises the route's
      // real production default, not an injected test callback.
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/admin/encryption-transition",
        payload: {
          requestVersion: 2,
          expectedRevision: 2,
          targetMode: "plaintext_only",
          targetShadowBehavior: "fallback",
          confirmation: DISABLE_SHADOW_ENCRYPTION_CONFIRMATION,
        },
      });
      await flushPendingWebSocketBroadcasts();

      expect(response.statusCode).toBe(500);
      expect(client.sent).toEqual([JSON.stringify({
        type: "encryption.policy.changed",
        policyRevision: 3,
      })]);
    } finally {
      await app.close();
    }
  });
});
