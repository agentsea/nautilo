import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migration = readFileSync(resolve(import.meta.dirname, "../../src/migrations/0233_quick_logan.sql"), "utf8");

describe("Memory publication privilege boundary", () => {
  test("liveness guard returns only current-account eligibility while holding its row lock", () => {
    expect(migration).toContain("app_memory_review_actor_is_active() RETURNS boolean");
    expect(migration).toContain("SECURITY DEFINER SET search_path = pg_catalog, public");
    expect(migration).toContain("PERFORM 1 FROM public.users");
    expect(migration).toContain("id = public.app_current_user_id() AND disabled_at IS NULL FOR SHARE");
    expect(migration).toContain("RETURN FOUND;");
    expect(migration).toContain("REVOKE ALL ON FUNCTION app_memory_review_actor_is_active() FROM PUBLIC");
    expect(migration).toContain("GRANT EXECUTE ON FUNCTION app_memory_review_actor_is_active() TO nautilo_agent");
    expect(migration).not.toMatch(/GRANT\s+SELECT[^;]*ON\s+(?:public\.)?users/i);
  });

  test("Agent publication can append receipts but cannot rewrite or prune them", () => {
    expect(migration).toContain("REVOKE ALL ON memory_review_turns, memory_review_receipts FROM nautilo_agent");
    expect(migration).toContain("GRANT SELECT, INSERT, UPDATE ON memory_review_turns TO nautilo_agent");
    expect(migration).toContain("GRANT SELECT, INSERT ON memory_review_receipts TO nautilo_agent");
    expect(migration).not.toMatch(/GRANT[^;]*(?:UPDATE|DELETE)[^;]*ON memory_review_receipts/i);
  });
});
