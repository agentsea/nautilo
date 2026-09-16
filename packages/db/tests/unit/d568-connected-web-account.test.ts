import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  CONNECTED_WEB_ACCOUNT_CLEANUP_STATES,
  CONNECTED_WEB_ACCOUNT_STATUSES,
  CONNECTED_WEB_ACTION_OPERATION_STATUSES,
  connectedWebAccounts,
} from "../../src/schema";

test("D568 Connected Web Account schema is Human-owned with opaque server-only recovery fields", () => {
  expect(CONNECTED_WEB_ACCOUNT_STATUSES).toEqual([
    "connecting", "connected", "busy", "attention_needed", "expired", "revoked", "provider_unavailable", "error",
  ]);
  expect(CONNECTED_WEB_ACCOUNT_CLEANUP_STATES).toEqual(["not_required", "pending", "failed", "completed"]);
  const config = getTableConfig(connectedWebAccounts);
  const names = config.columns.map((column) => column.name);
  for (const field of ["owner_user_id", "service", "origin", "label", "status", "profile_ref", "last_verified_at", "execution_checkpoint", "cleanup_state"]) {
    expect(names).toContain(field);
  }
  expect(names).not.toContain("agent_id");
  expect(names).not.toContain("namespace_id");
  expect(config.indexes.map((index) => index.config.name)).toContain("idx_connected_web_accounts_owner_updated");
});

test("D568 migration is generated, additive, and keeps profile references behind RLS", async () => {
  const migration = await readFile(join(import.meta.dir, "../../src/migrations/0225_d568_connected_web_accounts.sql"), "utf8");
  expect(migration).toContain('CREATE TABLE "connected_web_accounts"');
  expect(migration).toContain('"owner_user_id" uuid NOT NULL');
  expect(migration).toContain('ON DELETE restrict');
  expect(migration).toContain('ALTER TABLE "connected_web_accounts" ENABLE ROW LEVEL SECURITY');
  expect(migration).toContain('CREATE POLICY "connected_web_accounts_product_all"');
  expect(migration).not.toContain("live_view");
  expect(migration).not.toContain("cdp_url");
});

test("D568 creates action operations with a separately recoverable verifier phase", async () => {
  expect(CONNECTED_WEB_ACTION_OPERATION_STATUSES).toContain("verifying");
  const migration = await readFile(join(import.meta.dir, "../../src/migrations/0232_short_morg.sql"), "utf8");
  expect(migration).toContain('CREATE TABLE "connected_web_action_operations"');
  expect(migration).toContain("'reserving', 'running', 'verifying'");
  expect(migration).toContain('CONSTRAINT "connected_web_action_operations_status"');
});
