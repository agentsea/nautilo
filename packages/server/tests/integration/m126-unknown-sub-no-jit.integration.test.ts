import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { NautiloApiClient, pickHighestRoleSlug } from "@nautilo/api-client";
import { createDirectDb, users, eq } from "@nautilo/db";
import { setupOwnerAppFixture, type AppFixture } from "./helpers/app-fixture";

describe("M126 — unknown Logto sub does not JIT-provision a users row", () => {
  let fx: AppFixture;
  let baseUrl: string;

  beforeAll(async () => {
    fx = await setupOwnerAppFixture({ suiteName: "m126unk" });
    baseUrl = await fx.app.listen({ port: 0, host: "127.0.0.1" });
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  test("whoami with bearer for unbound sub returns guest envelope; no users row created", async () => {
    const orphanSub = randomUUID();

    const db = createDirectDb(1);
    try {
      const [pre] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.externalId, orphanSub))
        .limit(1);
      expect(pre).toBeUndefined();
    } finally {
      await db.end();
    }

    const bearer = await fx.mintBearerForOrphanSub(orphanSub);

    const client = new NautiloApiClient(baseUrl.replace(/\/$/, ""));
    client.setToken(bearer);

    const who = await client.whoami();

    expect(pickHighestRoleSlug(who.groups)).toBe("guest");
    expect(who.sessionUserId ?? null).toBeNull();
    expect(who.handle ?? null).toBeNull();
    expect(who.displayName ?? null).toBeNull();
    expect(who.externalId ?? null).toBeNull();

    const dbAfter = createDirectDb(1);
    try {
      const [post] = await dbAfter
        .select({ id: users.id })
        .from(users)
        .where(eq(users.externalId, orphanSub))
        .limit(1);
      expect(post).toBeUndefined();
    } finally {
      await dbAfter.end();
    }
  });

  test("whoami with bearer for already-bound owner sub returns full envelope (no regression)", async () => {
    const ownerBearer = await fx.mintOwnerBearer();
    const client = new NautiloApiClient(baseUrl.replace(/\/$/, ""));
    client.setToken(ownerBearer);
    const who = await client.whoami();
    expect(pickHighestRoleSlug(who.groups)).not.toBe("guest");
    expect(who.sessionUserId).toBe(fx.ownerId);
    expect(who.handle).toBe(fx.ownerHandle);
    expect(who.externalId).toBe(fx.ownerLogtoSub);
  });
});
