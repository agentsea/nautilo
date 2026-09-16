import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { agents, count, eq, groups } from "@nautilo/db";
import { setupOwnerAppFixture, type AppFixture } from "./helpers/app-fixture";

describe("Agent creation writes no groups rows (M128 T19)", () => {
  let fx: AppFixture;

  beforeAll(async () => {
    fx = await setupOwnerAppFixture({ suiteName: "m128agt" });
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  test("inserting an Agent row does not change groups table count", async () => {
    // POST /api/agents does not exist yet (only GET list/members routes in
    // agent-members.ts). Pin the behavioral invariant directly: agent CRUD must
    // not mint per-Agent groups post-M128 (groups.agent_id column is gone).
    const [beforeRow] = await fx.db.select({ n: count() }).from(groups);
    const groupsBefore = Number(beforeRow?.n ?? 0);

    const handle = `m128-no-grp-${Date.now().toString(36)}`;
    const [inserted] = await fx.db
      .insert(agents)
      .values({ handle })
      .returning({ id: agents.id });
    expect(inserted?.id).toBeDefined();

    try {
      const [afterRow] = await fx.db.select({ n: count() }).from(groups);
      const groupsAfter = Number(afterRow?.n ?? 0);
      expect(groupsAfter).toBe(groupsBefore);
    } finally {
      await fx.db.delete(agents).where(eq(agents.id, inserted!.id));
    }
  });
});
