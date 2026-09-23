import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, groups, invites } from "@nautilo/db";
import { setupOwnerAppFixture, type AppFixture } from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";

describe("server invite enrollment boundary", () => {
  let fixture!: AppFixture;
  let bearer: string;

  beforeAll(async () => {
    fixture = await setupOwnerAppFixture({ suiteName: "invitefence" });
    bearer = await fixture.mintOwnerBearer();
  });

  afterAll(async () => {
    if (fixture) await fixture.cleanup();
  });

  test("owner cannot mint a Community enrollment invite while Guest enrollment remains available", async () => {
    const before = await fixture.db
      .select({ id: invites.id })
      .from(invites)
      .where(eq(invites.createdBy, fixture.ownerId));

    const blocked = await authedInject(fixture.app, {
      method: "POST",
      url: "/api/invites",
      bearer,
      payload: {
        kind: "server",
        targetGroupRoleSlug: "community",
        maxUses: 1,
      },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json<{ error: string }>()).toEqual({
      error: "target_role_forbidden",
    });

    const afterBlocked = await fixture.db
      .select({ id: invites.id })
      .from(invites)
      .where(eq(invites.createdBy, fixture.ownerId));
    expect(afterBlocked.map((row) => row.id).sort()).toEqual(
      before.map((row) => row.id).sort(),
    );

    const allowed = await authedInject(fixture.app, {
      method: "POST",
      url: "/api/invites",
      bearer,
      payload: {
        kind: "server",
        targetGroupRoleSlug: "guest",
        maxUses: 1,
      },
    });
    expect(allowed.statusCode).toBe(200);
    const allowedBody = allowed.json<{
      id: string;
      kind: string;
      token: string;
    }>();
    expect(allowedBody.kind).toBe("server");
    expect(allowedBody.token).toMatch(/^inv_[A-Za-z0-9_-]{32}$/u);

    const [persisted] = await fixture.db
      .select({ targetGroupId: invites.targetGroupId })
      .from(invites)
      .innerJoin(groups, eq(groups.id, invites.targetGroupId))
      .where(
        and(
          eq(invites.id, allowedBody.id),
          eq(groups.type, "guests"),
        ),
      )
      .limit(1);
    expect(persisted?.targetGroupId).toBeString();
  });
});
