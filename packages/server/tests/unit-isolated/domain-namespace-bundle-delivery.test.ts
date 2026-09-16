import { afterEach, describe, expect, mock, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";

const events: unknown[] = [];
const order: string[] = [];
let targetRooms: { roomId: string }[] = [];
let publication: "published" | "replayed" | "denied" | "failed" = "published";
const namespaceId = "11111111-1111-4111-8111-111111111111";
const targetRoomId = "22222222-2222-4222-8222-222222222222";
const sourceRoomId = "33333333-3333-4333-8333-333333333333";
const database = {
  select: () => ({ from: () => ({ where: async () => targetRooms }) }),
};
const actualDb = await import("@nautilo/db");
mock.module("@nautilo/db", () => ({
  ...actualDb,
  createPostgresJsBridgeConnection: () => ({}),
  getSharedDirectCryptoDb: () => ({}),
}));
mock.module("../../src/lib/server-direct-db", () => ({
  getServerDirectDb: () => database,
}));
const actualTrust = await import("@nautilo/trust");
mock.module("@nautilo/trust", () => ({
  ...actualTrust,
  listHumanUserIdsInRoom: async () => {
    order.push("participants");
    return ["user-current"];
  },
}));
mock.module("../../src/realtime/ws-publisher", () => ({
  publishDomainKeyCatchUpRequested: () => {},
  publishDomainKeyCatchUpDelivered: (event: unknown) => {
    order.push("notified");
    events.push(event);
  },
}));
const actualBridge = await import("@nautilo/lattice-bridge/server");
mock.module("@nautilo/lattice-bridge/server", () => ({
  ...actualBridge,
  PostgresNamespaceProductAuthority: class {
    async withCurrentReadableNamespace(input: {
      use: (snapshot: object) => Promise<unknown>;
    }) {
      return input.use({});
    }
  },
  createPostgresDomainKeyAuthorityRepositoryFactory: () => () => ({
    async publishNamespaceBundle() {
      if (publication === "failed") throw new Error("publication failed");
      if (publication === "denied") return null;
      order.push("committed");
      return {
        status: publication, operationId: "bundle-operation", namespaceId,
        domainId: "domain-current", keyClass: "ai", bindingDigest: new Uint8Array(32),
      };
    },
  }),
}));
const { registerProductionDomainKeyAuthority } = await import(
  "../../src/routes/domain-key-authority"
);
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  events.length = 0;
  order.length = 0;
});

async function publish() {
  const app = Fastify();
  app.addHook("onRequest", async (request) => {
    Object.assign(request, {
      sessionUserId: "user", sessionActorId: "human", policyContext: { actorRole: "member" },
    });
  });
  registerProductionDomainKeyAuthority(app);
  apps.push(app);
  return app.inject({
    method: "POST",
    url: `/api/rooms/${sourceRoomId}/live-shadow/domain-key/${namespaceId}/bundle/publish`,
    payload: {
      requestVersion: 2, serverId: "server", clientDeviceId: "device", keyClass: "ai",
      operationId: "bundle-operation", idempotencyKey: "bundle-retry", bindingBytesBase64url: "AQ",
    },
  });
}

describe("durable Namespace bundle delivery notification", () => {
  for (const status of ["published", "replayed"] as const) {
    test(`${status} wakes the target Room only after durable publication`, async () => {
      publication = status;
      targetRooms = [{ roomId: targetRoomId }];
      expect((await publish()).statusCode).toBe(200);
      expect(order).toEqual(["committed", "participants", "notified"]);
      expect(events).toEqual([{ roomId: targetRoomId, namespaceId, keyClass: "ai",
        recipientUserIds: ["user-current"] }]);
    });
  }
  for (const status of ["denied", "failed"] as const) {
    test(`${status} publication does not announce available keys`, async () => {
      publication = status;
      targetRooms = [{ roomId: targetRoomId }];
      expect((await publish()).statusCode).toBe(status === "denied" ? 403 : 500);
      expect(events).toEqual([]);
      expect(order).not.toContain("participants");
    });
  }
  test("missing or ambiguous target does not notify the unrelated source Room", async () => {
    publication = "published";
    for (const rows of [[], [{ roomId: targetRoomId }, { roomId: sourceRoomId }]]) {
      targetRooms = rows;
      expect((await publish()).statusCode).toBe(200);
      expect(events).toEqual([]);
      expect(order).not.toContain("participants");
    }
  });
});
