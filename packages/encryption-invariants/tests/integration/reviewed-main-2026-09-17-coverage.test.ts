import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { eventFeedPreferenceSchema } from "@nautilo/types";
import { CURRENT_FROZEN_BASELINE_DEBT } from "../../baseline/existing-debt";
import {
  REVIEWED_MAIN_2026_09_17_COVERAGE,
  REVIEWED_MAIN_2026_09_17_DEBT_LINKS,
} from "../../baseline/reviewed-main-2026-09-17-coverage";
import { validateCoverageEntry } from "../../src/model";

const repoRoot = resolve(import.meta.dir, "../../../..");

describe("September 17 incremental coverage review", () => {
  test("classifies all eleven new observations without admitting new debt", () => {
    expect(REVIEWED_MAIN_2026_09_17_COVERAGE).toHaveLength(8);
    expect(REVIEWED_MAIN_2026_09_17_DEBT_LINKS).toHaveLength(3);
    const locators = new Set(REVIEWED_MAIN_2026_09_17_COVERAGE.map(entry => entry.locator));
    const frozen = new Set(CURRENT_FROZEN_BASELINE_DEBT.map(entry => entry.id));
    for (const entry of REVIEWED_MAIN_2026_09_17_COVERAGE) {
      expect(validateCoverageEntry(entry)).toEqual({ ok: true });
      expect(entry.classification).toBe("bounded_metadata");
    }
    for (const link of REVIEWED_MAIN_2026_09_17_DEBT_LINKS) {
      expect(locators.has(link.locator)).toBe(false);
      expect(link.targetDebtIds.every(id => frozen.has(id))).toBe(true);
      locators.add(link.locator);
    }
    expect(locators.size).toBe(11);
  });

  test("quiet preferences reject content, credentials, unknown modes and invalid deadlines", () => {
    for (const value of [
      { mode: "active" }, { mode: "quiet" },
      { mode: "snoozed", until: "2099-01-01T00:00:00Z" },
    ]) expect(eventFeedPreferenceSchema.safeParse(value).success).toBe(true);
    for (const value of [
      { mode: "quiet", content: "private event" },
      { mode: "active", token: "secret" },
      { mode: "quiet", until: "2099-01-01T00:00:00Z" },
      { mode: "custom" }, { mode: "snoozed" },
      { mode: "snoozed", until: "not-a-timestamp" },
    ]) expect(eventFeedPreferenceSchema.safeParse(value).success).toBe(false);
  });

  test("does not classify session credentials or media labels as metadata", () => {
    const secret = REVIEWED_MAIN_2026_09_17_DEBT_LINKS.find(entry => entry.locator.endsWith("/prepare"));
    expect(secret?.targetDebtIds).toEqual(["debt.wire.http.request.response.post.api.apps.appid.live.session.172tdwt"]);
    expect(REVIEWED_MAIN_2026_09_17_DEBT_LINKS.filter(entry => entry.locator.includes("VideoMediaPickResult"))).toHaveLength(2);
    const clientIds = REVIEWED_MAIN_2026_09_17_COVERAGE.filter(entry => entry.locator.endsWith("#request.body.clientSessionId"));
    expect(clientIds).toHaveLength(2);
    for (const entry of clientIds) {
      expect(entry.classification === "bounded_metadata" && entry.metadataAllowlist).toEqual(["clientSessionId"]);
    }
  });

  test("reviewed migrations preserve public-read, media-shape, and preference restrictions", async () => {
    const migration = (name: string) => readFile(resolve(repoRoot, "packages/db/src/migrations", name), "utf8");
    expect(await migration("0289_mean_sage.sql")).toContain('"account_id" DROP NOT NULL');
    const publicRead = await migration("0290_tiny_ezekiel_stane.sql");
    expect(publicRead).toContain('"action_operation_id" is null');
    expect(publicRead).toContain('"effect_idempotency_key" is null');
    expect(publicRead).toContain("('hosted', 'checking')");
    const receipt = await migration("0291_outstanding_morgan_stark.sql");
    expect(receipt).toContain("->'outputs' = '[]'::jsonb");
    expect(receipt).toContain("->>'outputsTruncated' = 'false'");
    expect(receipt).toContain("->'account') = 'null'");
    const media = await migration("0292_polite_slipstream.sql");
    expect(media).toContain("- 'referenceAudios'");
    expect(media).toContain("->'referenceAudios') = 'array'");
    expect(media).toContain("->'normalizedSettings' = \"media_generations\".\"safe_snapshot\"->'normalizedSettings'");
    // Prompt/lyrics remain existing plaintext media debt, not safe metadata.
    expect(media).toContain("->'prompt') = 'string'");
    const preferences = await migration("0293_certain_gabe_jones.sql");
    expect(preferences).toContain("IN ('active', 'quiet')");
    expect(preferences).toContain('"event_feed_quiet_until" IS NULL');
    expect(preferences).toContain("= 'snoozed'");
    expect(preferences).toContain('"event_feed_quiet_until" IS NOT NULL');
    const receiptPermissions = await migration(
      "0294_content_access_receipt_fk_permissions.sql",
    );
    expect(receiptPermissions).toContain(
      'GRANT UPDATE, DELETE ON TABLE "content_access_operations" TO "nautilo"',
    );
    expect(receiptPermissions).toContain(
      'REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE "content_access_operations" FROM "nautilo"',
    );
    expect(receiptPermissions).not.toContain("GRANT TRUNCATE");
  });
});
