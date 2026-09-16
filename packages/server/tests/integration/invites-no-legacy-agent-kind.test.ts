import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { eq, groups, invites } from "@nautilo/db";
import { setupOwnerAppFixture, type AppFixture } from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";

describe("POST /api/invites — M128 kind contract (TP10)", () => {
  let fx: AppFixture;
  let bearer: string;

  beforeAll(async () => {
    fx = await setupOwnerAppFixture({ suiteName: "m128inv" });
    bearer = await fx.mintOwnerBearer();
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  test("kind=agent is hard-rejected with invalid_kind", async () => {
    const res = await authedInject(fx.app, {
      method: "POST",
      url: "/api/invites",
      bearer,
      payload: { kind: "agent", targetGroupRoleSlug: "member" },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error?: string };
    expect(body.error).toBe("invalid_kind");
  });

  test("kind=group is hard-rejected with invalid_kind", async () => {
    const res = await authedInject(fx.app, {
      method: "POST",
      url: "/api/invites",
      bearer,
      payload: { kind: "group", targetGroupRoleSlug: "member" },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error?: string };
    expect(body.error).toBe("invalid_kind");
  });

  test("kind=room is hard-rejected with invalid_kind", async () => {
    const res = await authedInject(fx.app, {
      method: "POST",
      url: "/api/invites",
      bearer,
      payload: { kind: "room", targetGroupRoleSlug: "member" },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error?: string };
    expect(body.error).toBe("invalid_kind");
  });

  test("kind=server with targetGroupRoleSlug=member mints and resolves members group", async () => {
    const [membersGroup] = await fx.db
      .select({ id: groups.id })
      .from(groups)
      .where(eq(groups.type, "members"))
      .limit(1);
    expect(membersGroup).toBeDefined();

    const res = await authedInject(fx.app, {
      method: "POST",
      url: "/api/invites",
      bearer,
      payload: { kind: "server", targetGroupRoleSlug: "member" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { id?: string; kind?: string; token?: string };
    expect(body.kind).toBe("server");
    expect(typeof body.id).toBe("string");
    expect(typeof body.token).toBe("string");

    const [row] = await fx.db
      .select({ targetGroupId: invites.targetGroupId })
      .from(invites)
      .where(eq(invites.id, body.id!))
      .limit(1);
    expect(row?.targetGroupId).toBe(membersGroup!.id);
  });
});
