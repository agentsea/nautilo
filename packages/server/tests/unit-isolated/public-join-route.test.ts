import { describe, expect, test } from "bun:test";
import Fastify from "fastify";
import {
  publicJoinInviteToken,
  publicJoinRoutes,
  type PublicJoinRouteOptions,
} from "../../src/routes/public-join";
import { routeSkipsTrustPreHandler } from "../../src/trust-bypass-routes";

const INVITE_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const TOKEN = `inv_${"a".repeat(32)}`;

function setup(input: {
  selected?: string | null;
  canManage?: boolean;
  session?: string | null;
  open?: boolean;
  inviteActive?: boolean;
  selectionUnavailable?: boolean;
  enrollmentUnavailable?: boolean;
  inviteAuthorityUnavailable?: boolean;
} = {}) {
  const app = Fastify();
  let selection = { inviteId: input.selected ?? null, revision: 1 };
  let open = input.open ?? true;
  let active = input.inviteActive ?? true;
  let selectionUnavailable = input.selectionUnavailable ?? false;
  let enrollmentUnavailable = input.enrollmentUnavailable ?? false;
  let inviteAuthorityUnavailable = input.inviteAuthorityUnavailable ?? false;
  app.addHook("preHandler", async (request) => {
    request.sessionUserId = input.session === undefined ? USER_ID : input.session;
  });
  const services: NonNullable<PublicJoinRouteOptions["services"]> = {
    readSelection: async () => {
      if (selectionUnavailable) throw new Error("selection unavailable");
      return selection;
    },
    updateSelection: async (inviteId, revision) => {
      if (revision !== selection.revision) return null;
      selection = { inviteId, revision: revision + 1 };
      return selection;
    },
    eligibleToken: async (id) => {
      if (inviteAuthorityUnavailable) throw new Error("invite authority unavailable");
      return active && id === INVITE_ID ? TOKEN : null;
    },
    hasCapabilities: async () => input.canManage ?? true,
  };
  publicJoinRoutes(app, {
    joinUrl: "https://community.nautilo.ai/join",
    isEnrollmentOpen: async () => {
      if (enrollmentUnavailable) throw new Error("enrollment unavailable");
      return open;
    },
    services,
  });
  return {
    app,
    setOpen(value: boolean) { open = value; },
    setActive(value: boolean) { active = value; },
    setSelection(inviteId: string | null) { selection = { ...selection, inviteId }; },
    setSelectionUnavailable(value: boolean) { selectionUnavailable = value; },
    setEnrollmentUnavailable(value: boolean) { enrollmentUnavailable = value; },
    setInviteAuthorityUnavailable(value: boolean) { inviteAuthorityUnavailable = value; },
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

  test("reports only live public availability without authentication or invite details", async () => {
    const instance = setup({ selected: INVITE_ID, session: null });
    expect(routeSkipsTrustPreHandler("/api/public-join")).toBe(true);
    expect(routeSkipsTrustPreHandler("/api/public-join/details")).toBe(false);
    expect(routeSkipsTrustPreHandler("/api/public-join?verbose=true")).toBe(false);

    const selected = await instance.app.inject({ method: "GET", url: "/api/public-join" });
    expect(selected.statusCode).toBe(200);
    expect(selected.headers["cache-control"]).toBe("no-store");
    expect(selected.json<{ available: boolean }>()).toEqual({ available: true });
    expect(Object.keys(selected.json<Record<string, unknown>>())).toEqual(["available"]);
    expect((await instance.app.inject({ method: "POST", url: "/api/public-join" })).statusCode)
      .toBe(404);

    instance.setSelection(null);
    expect((await instance.app.inject({ method: "GET", url: "/api/public-join" })).json<{ available: boolean }>())
      .toEqual({ available: false });
    instance.setSelection(INVITE_ID);
    instance.setActive(false);
    expect((await instance.app.inject({ method: "GET", url: "/api/public-join" })).json<{ available: boolean }>())
      .toEqual({ available: false });
    instance.setActive(true);
    instance.setOpen(false);
    expect((await instance.app.inject({ method: "GET", url: "/api/public-join" })).json<{ available: boolean }>())
      .toEqual({ available: false });
    await instance.app.close();
  });

  test("fails public availability closed for every backing authority outage", async () => {
    const instance = setup({ selected: INVITE_ID, session: null });
    instance.setSelectionUnavailable(true);
    expect((await instance.app.inject({ method: "GET", url: "/api/public-join" })).json<{ available: boolean }>())
      .toEqual({ available: false });
    instance.setSelectionUnavailable(false);
    instance.setEnrollmentUnavailable(true);
    expect((await instance.app.inject({ method: "GET", url: "/api/public-join" })).json<{ available: boolean }>())
      .toEqual({ available: false });
    instance.setEnrollmentUnavailable(false);
    instance.setInviteAuthorityUnavailable(true);
    expect((await instance.app.inject({ method: "GET", url: "/api/public-join" })).json<{ available: boolean }>())
      .toEqual({ available: false });

    const navigation = await instance.app.inject({ method: "GET", url: "/join" });
    expect(navigation.statusCode).toBe(302);
    expect(navigation.headers.location).toBe("/join/continue");
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
