import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";

const INVITE_ID = "11111111-1111-4111-8111-111111111111";
const GROUP_ID = "22222222-2222-4222-8222-222222222222";
const TOKEN = `inv_${"a".repeat(32)}`;
const inviteTable = { id: "invite-id" };
const groupTable = { id: "group-id", type: "group-type" };
const roomTable = { id: "room-id", archivedAt: "room-archived-at" };
const selectionTable = { singleton: true, inviteId: "selected-invite", revision: "revision" };
const activeInvite = {
  kind: "server", token: TOKEN, targetGroupId: GROUP_ID,
  targetRoomId: null as string | null, revokedAt: null as Date | null,
  expiresAt: null as Date | null, maxUses: null as number | null, usedCount: 0,
};
type StoredInvite = Omit<typeof activeInvite, "token" | "targetGroupId"> & {
  token: string | null;
  targetGroupId: string | null;
};
let invite: StoredInvite | null;
let groupType: string;
let groupExists: boolean;
let room: { archivedAt: Date | null } | null;
let selection: { inviteId: string | null; revision: number };
let capabilities: string[];
const apps: FastifyInstance[] = [];

mock.module("@nautilo/db", () => ({
  invites: inviteTable, groups: groupTable, rooms: roomTable, serverPublicJoin: selectionTable,
  eq: (...args: unknown[]) => args,
  and: (...args: unknown[]) => args,
  db: {
    select: () => ({ from: (table: unknown) => ({ where: () => ({ limit: async () => {
      if (table === selectionTable) return [selection];
      if (table === inviteTable) return invite ? [invite] : [];
      if (table === groupTable) return groupExists ? [{ id: GROUP_ID, type: groupType }] : [];
      if (table === roomTable) return room ? [room] : [];
      throw new Error("unexpected table");
    } }) }) }),
    update: () => ({ set: (values: typeof selection) => ({ where: () => ({ returning: async () => {
      selection = { inviteId: values.inviteId, revision: values.revision };
      return [selection];
    } }) }) }),
  },
}));
mock.module("@nautilo/trust", () => ({ getUserCapabilities: async () => capabilities }));
const { publicJoinRoutes } = await import("../../src/routes/public-join");

beforeEach(() => {
  invite = { ...activeInvite };
  groupType = "contributors";
  groupExists = true;
  room = { archivedAt: null };
  selection = { inviteId: null, revision: 1 };
  capabilities = ["manage_members", "manage_server_enrollment"];
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function setup(): FastifyInstance {
  const app = Fastify();
  apps.push(app);
  app.addHook("preHandler", async (request) => { request.sessionUserId = "admin-user"; });
  publicJoinRoutes(app, {
    joinUrl: "https://example.test/join",
    isEnrollmentOpen: async () => true,
  });
  return app;
}

async function selectInvite(app: FastifyInstance) {
  return app.inject({ method: "PUT", url: "/api/admin/public-join",
    payload: { inviteId: INVITE_ID, revision: 1 } });
}

describe("public join real invite eligibility", () => {
  test.each(["owners", "admins", "superusers", "members", "contributors", "communities", "guests"])(
    "selects and serves an active invitation targeting %s", async (type) => {
      groupType = type;
      const app = setup();
      expect((await selectInvite(app)).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/public-join" })).json<{ available: boolean }>())
        .toEqual({ available: true });
      expect((await app.inject({ method: "GET", url: "/join" })).headers.location)
        .toBe(`/join/continue?invite=${TOKEN}`);
    },
  );

  test.each([
    ["claim", { kind: "claim" }],
    ["missing code", { token: null }],
    ["invalid code", { token: "invalid" }],
    ["revoked", { revokedAt: new Date(0) }],
    ["expired", { expiresAt: new Date(0) }],
    ["exhausted", { maxUses: 1, usedCount: 1 }],
    ["missing group binding", { targetGroupId: null }],
  ] as const)("rejects an unavailable invitation: %s", async (_label, changes) => {
    invite = { ...activeInvite, ...changes };
    const app = setup();
    expect((await selectInvite(app)).statusCode).toBe(409);
    selection.inviteId = INVITE_ID;
    expect((await app.inject({ method: "GET", url: "/api/public-join" })).json<{ available: boolean }>())
      .toEqual({ available: false });
  });

  test("requires the selected invite, destination Group and optional Room to remain available", async () => {
    const app = setup();
    invite = null;
    expect((await selectInvite(app)).statusCode).toBe(409);
    invite = { ...activeInvite };
    groupExists = false;
    expect((await selectInvite(app)).statusCode).toBe(409);
    groupExists = true;
    invite.targetRoomId = "destination-room";
    room = null;
    expect((await selectInvite(app)).statusCode).toBe(409);
    room = { archivedAt: new Date(0) };
    expect((await selectInvite(app)).statusCode).toBe(409);
    room = { archivedAt: null };
    expect((await selectInvite(app)).statusCode).toBe(200);
    invite.usedCount = 1;
    invite.maxUses = 1;
    expect((await app.inject({ method: "GET", url: "/api/public-join" })).json<{ available: boolean }>())
      .toEqual({ available: false });
  });

  test.each([
    { label: "member management only", grants: ["manage_members"] },
    { label: "enrollment management only", grants: ["manage_server_enrollment"] },
    { label: "neither capability", grants: [] },
  ])("requires both administrator capabilities ($label)", async ({ grants }) => {
    capabilities = [...grants];
    expect((await selectInvite(setup())).statusCode).toBe(403);
  });
});
