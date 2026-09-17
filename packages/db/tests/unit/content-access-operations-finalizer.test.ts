import { describe, expect, test } from "bun:test";
import { finalizeContentAccessOperationsMigration, finalizeContentAccessReceiptImmutability, finalizeContentAccessReceiptFkPermissions } from "../../scripts/finalize-content-access-operations";

describe("content access terminal receipt migration privileges", () => {
  test("restores only FK cleanup DML without replacing immutability guards", () => {
    const source = "-- generated custom migration";
    const finalized = finalizeContentAccessReceiptFkPermissions(source);
    expect(finalizeContentAccessReceiptFkPermissions(finalized)).toBe(finalized);
    expect(finalized.startsWith(source)).toBe(true);
    expect(finalized).toContain('GRANT UPDATE, DELETE ON TABLE "content_access_operations" TO "nautilo"');
    expect(finalized).toContain('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE "content_access_operations" FROM "nautilo"');
    expect(finalized).not.toMatch(/DISABLE|DROP|CREATE OR REPLACE|BYPASSRLS|GRANT ALL/);
    expect(finalized).not.toContain('TO "nautilo_agent"');
    expect(finalized).not.toContain('TO "nautilo_crypto"');
  });
  test("guards direct mutation despite BYPASSRLS while retaining exact FK cleanup", () => {
    const finalized = finalizeContentAccessReceiptImmutability("-- generated custom migration");
    expect(finalizeContentAccessReceiptImmutability(finalized)).toBe(finalized);
    expect(finalized).toContain("pg_trigger_depth() < 2");
    expect(finalized).toContain("BEFORE UPDATE OR DELETE");
    expect(finalized).toContain("BEFORE TRUNCATE");
    expect(finalized).toContain("to_jsonb(NEW) - 'requester_user_id' - 'requester_actor_id'");
    expect(finalized).toContain("SELECT 1 FROM public.memories WHERE id = OLD.memory_id");
    expect(finalized).toContain("SELECT 1 FROM public.artifacts WHERE id = OLD.artifact_id");
    expect(finalized).toContain("SELECT 1 FROM public.users WHERE id = OLD.requester_user_id");
    expect(finalized).toContain("SELECT 1 FROM public.actors WHERE id = OLD.requester_actor_id");
    const grant = finalized.indexOf('GRANT TRIGGER ON TABLE "content_access_operations" TO "nautilo"');
    const create = finalized.indexOf('CREATE TRIGGER "content_access_receipt_immutable_row"');
    const revoke = finalized.indexOf('REVOKE TRIGGER ON TABLE "content_access_operations" FROM "nautilo"');
    expect(grant).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(grant);
    expect(revoke).toBeGreaterThan(create);
  });
  test("only finalizes the new ledger and is idempotent", () => {
    const unrelated = 'CREATE TABLE "unrelated" ("id" uuid);';
    expect(finalizeContentAccessOperationsMigration(unrelated)).toBe(unrelated);
    const generated = 'CREATE TABLE "content_access_operations" ("operation_id" uuid);';
    const finalized = finalizeContentAccessOperationsMigration(generated);
    expect(finalized.startsWith(generated)).toBe(true);
    expect(finalizeContentAccessOperationsMigration(finalized)).toBe(finalized);
    expect(finalized).toContain('ALTER TABLE "content_access_operations" FORCE ROW LEVEL SECURITY');
    expect(finalized).toContain('FROM PUBLIC, "nautilo_agent", "nautilo_crypto"');
    expect(finalized).toContain('REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER');
    expect(finalized).toContain('GRANT SELECT, INSERT ON TABLE "content_access_operations" TO "nautilo"');
  });
});
