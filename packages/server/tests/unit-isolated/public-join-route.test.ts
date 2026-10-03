import { describe, expect, test } from "bun:test";
import Fastify from "fastify";
import {
  publicJoinInviteToken,
  publicJoinRoutes,
  type PublicJoinRouteOptions,
} from "../../src/routes/public-join";

const INVITE_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const TOKEN = `inv_${"a".repeat(32)}`;

function setup(input: {
  selected?: string | null;
  canManage?: boolean;
  session?: string | null;
  open?: boolean;
  inviteActive?: boolean;
} = {}) {
  const app = Fastify();
  let selection = { inviteId: input.selected ?? null, revision: 1 };
  let open = input.open ?? true;
  let active = input.inviteActive ?? true;
  app.addHook("preHandler", async (request) => {
    request.sessionUserId = input.session === undefined ? USER_ID : input.session;
  });
  const services: NonNullable<PublicJoinRouteOptions["services"]> = {
    readSelection: async () => selection,
    updateSelection: async (inviteId, revision) => {
      if (revision !== selection.revision) return null;
      selection = { inviteId, revision: revision + 1 };
      return selection;
    },
    eligibleToken: async (id) => active && id === INVITE_ID ? TOKEN : null,
    hasCapabilities: async () => input.canManage ?? true,
  };
  publicJoinRoutes(app, {
    joinUrl: "https://community.nautilo.ai/join",
    isEnrollmentOpen: async () => open,
    services,
  });
  return {
    app,
    setOpen(value: boolean) { open = value; },
    setActive(value: boolean) { active = value; },
  };
}

describe("public community join route", () => {
  test("redirects to the same-origin client entry with an active invite", async () => {
    const { app } = setup({ selected: INVITE_ID });
    const response = await app.inject({ method: "GET", url: "/join" });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(`/join/continue?invite=${TOKEN}`);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    await app.close();
  });

  test("selection changes and clearing take effect on the next public visit", async () => {
    const { app } = setup();
    expect((await app.inject({ method: "GET", url: "/join" })).headers.location).toBe("/join/continue");
    const selected = await app.inject({ method: "PUT", url: "/api/admin/public-join",
      payload: { inviteId: INVITE_ID, revision: 1 } });
    expect(selected.statusCode).toBe(200);
    expect(selected.json<{ inviteId: string; revision: number; joinUrl: string }>()).toEqual({
      inviteId: INVITE_ID, revision: 2, joinUrl: "https://community.nautilo.ai/join",
    });
    expect((await app.inject({ method: "GET", url: "/join" })).headers.location).toBe(`/join/continue?invite=${TOKEN}`);
    const cleared = await app.inject({ method: "PUT", url: "/api/admin/public-join",
      payload: { inviteId: null, revision: 2 } });
    expect(cleared.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/join" })).headers.location).toBe("/join/continue");
    await app.close();
  });

  test("does not offer a paused or revoked invite while still allowing a signed-in client to enter", async () => {
    const instance = setup({ selected: INVITE_ID });
    instance.setOpen(false);
    expect((await instance.app.inject({ method: "GET", url: "/join" })).headers.location).toBe("/join/continue");
    instance.setOpen(true);
    instance.setActive(false);
    const closed = await instance.app.inject({ method: "GET", url: "/join" });
    expect(closed.statusCode).toBe(302);
    expect(closed.headers.location).toBe("/join/continue");
    await instance.app.close();
  });

  test("admin read and write require an authenticated authorized user", async () => {
    const unauthenticated = setup({ session: null });
    expect((await unauthenticated.app.inject({ method: "GET", url: "/api/admin/public-join" })).statusCode).toBe(401);
    expect((await unauthenticated.app.inject({ method: "PUT", url: "/api/admin/public-join", payload: { inviteId: null, revision: 1 } })).statusCode).toBe(401);
    await unauthenticated.app.close();
    const forbidden = setup({ canManage: false });
    expect((await forbidden.app.inject({ method: "GET", url: "/api/admin/public-join" })).statusCode).toBe(403);
    expect((await forbidden.app.inject({ method: "PUT", url: "/api/admin/public-join", payload: { inviteId: null, revision: 1 } })).statusCode).toBe(403);
    await forbidden.app.close();
  });

  test("rejects stale updates and ineligible selections", async () => {
    const { app } = setup({ inviteActive: false });
    const unavailable = await app.inject({ method: "PUT", url: "/api/admin/public-join",
      payload: { inviteId: INVITE_ID, revision: 1 } });
    expect(unavailable.statusCode).toBe(409);
    expect(unavailable.json<{ error: string }>()).toEqual({ error: "invite_unavailable" });
    const stale = await app.inject({ method: "PUT", url: "/api/admin/public-join",
      payload: { inviteId: null, revision: 0 } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json<{ error: string }>()).toEqual({ error: "stale_revision" });
    await app.close();
  });

  test("accepts only the canonical ordinary invite token shape for legacy import", () => {
    expect(publicJoinInviteToken(` ${TOKEN} `)).toBe(TOKEN);
    expect(publicJoinInviteToken(`inv_${"a".repeat(31)}`)).toBeNull();
    expect(publicJoinInviteToken(`inv_${"a".repeat(33)}`)).toBeNull();
    expect(publicJoinInviteToken(undefined)).toBeNull();
  });
});
