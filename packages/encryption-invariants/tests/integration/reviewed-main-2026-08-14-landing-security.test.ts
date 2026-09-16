import { describe, expect, test } from "bun:test";

import { DTO_BASELINE_DECLARATIONS } from "../../baseline/dto-declarations";
import { BASELINE_REGISTRY } from "../../baseline/existing-debt";
import { RAW_DATABASE_WRITER_DEBT } from "../../baseline/raw-database-writer-debt";
import {
  RETIRED_MAIN_2026_08_14_LANDING_RAW_DATABASE_WRITER_LOCATORS,
} from "../../baseline/reviewed-main-2026-08-14-landing";

const inviteRedemptionLocators = [
  "public.invite_redemptions",
  "public.invite_redemptions.bound_at",
  "public.invite_redemptions.completed_at",
  "public.invite_redemptions.invite_id",
  "public.invite_redemptions.user_id",
] as const;

describe("reviewed main landing security decisions", () => {
  test("classifies Invite redemption coordination as bounded metadata", () => {
    for (const locator of inviteRedemptionLocators) {
      const entry = BASELINE_REGISTRY.entries.find((candidate) =>
        candidate.locator === locator
      );
      expect(entry).toMatchObject({
        surface: "db",
        owner: "packages/db",
        migrationState: "not_applicable",
        classification: "bounded_metadata",
      });
      if (entry?.classification !== "bounded_metadata") {
        throw new Error(`${locator} must remain bounded metadata`);
      }
      expect(entry.plaintextReason).toContain("no invite token");
      expect(entry.plaintextReason).toContain("protected content");
    }
  });

  test("retires only raw Memory writers that no longer exist", () => {
    for (const locator of
      RETIRED_MAIN_2026_08_14_LANDING_RAW_DATABASE_WRITER_LOCATORS) {
      expect(RAW_DATABASE_WRITER_DEBT.some((entry) =>
        entry.locator === locator
      )).toBe(false);
      expect(BASELINE_REGISTRY.reviewedDebtLinks?.some((entry) =>
        entry.locator === locator
      )).toBe(false);
    }
  });

  test("removes only obsolete void Group-member responses", () => {
    for (const locator of [
      "http:request_response:DELETE /api/groups/:id/members/:userId",
      "http:request_response:PUT /api/groups/:id/members/:userId",
    ]) {
      const declaration = DTO_BASELINE_DECLARATIONS.find((candidate) =>
        candidate.locator === locator
      );
      expect(declaration).toBeDefined();
      expect(declaration?.structuralSignatures).not.toContain(
        "response.body:void",
      );
      expect(declaration?.structuralSignatures).toContain(
        "response.body:{code:string}",
      );
      expect(declaration?.structuralSignatures).toContain(
        "response.body:{error:string}",
      );
    }
  });
});
