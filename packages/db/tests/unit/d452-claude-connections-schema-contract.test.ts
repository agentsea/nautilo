import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

test("D452 Claude Connections migration is owner-RLS constrained", async () => {
  const sql = await readFile(join(import.meta.dir, "../../src/migrations/0215_nice_madame_hydra.sql"), "utf8");
  expect(sql).toContain('CREATE TABLE "claude_connections"');
  expect(sql).toContain("ALTER TABLE claude_connections ENABLE ROW LEVEL SECURITY");
  expect(sql).toContain("ALTER TABLE claude_connections FORCE ROW LEVEL SECURITY");
  expect(sql).toContain("CREATE POLICY claude_connections_owner");
  expect(sql).toContain("USING (user_id=app_current_user_id())");
  expect(sql).toContain("WITH CHECK (user_id=app_current_user_id())");
  expect(sql).toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON claude_connections TO nautilo_agent");
  expect(sql).not.toContain("relay_session");
  expect(sql).not.toContain("token");
  expect(sql).not.toContain("path");
});
