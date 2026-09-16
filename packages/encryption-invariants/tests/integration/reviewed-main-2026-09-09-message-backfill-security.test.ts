import { describe, expect, test } from "bun:test";

import {
  REVIEWED_MAIN_2026_09_09_MESSAGEBACKFILL_COVERAGE_ENTRIES,
  REVIEWED_MAIN_2026_09_09_MESSAGEBACKFILL_DEBT_LINKS,
} from "../../baseline/reviewed-main-2026-09-09-message-backfill-coverage";
import { REVIEWED_MAIN_2026_09_09_MESSAGEBACKFILL_DTO_DECLARATIONS } from "../../baseline/reviewed-main-2026-09-09-message-backfill-dto";

describe("current-main Message backfill inventory", () => {
  test("classifies only closed coordination state as metadata", () => {
    const claim = REVIEWED_MAIN_2026_09_09_MESSAGEBACKFILL_COVERAGE_ENTRIES.find((entry) => entry.locator === "public.message_backfill_scans.claim");
    expect(claim?.classification).toBe("bounded_metadata");
    expect(claim?.classification === "bounded_metadata" ? claim.plaintextReason : undefined).toContain("excludes plaintext");
    expect(REVIEWED_MAIN_2026_09_09_MESSAGEBACKFILL_COVERAGE_ENTRIES.filter((entry) => entry.classification === "protected")).toHaveLength(0);
  });

  test("keeps backfill transport attached to frozen Message debt", () => {
    expect(REVIEWED_MAIN_2026_09_09_MESSAGEBACKFILL_DEBT_LINKS.length).toBeGreaterThan(0);
    expect(new Set(REVIEWED_MAIN_2026_09_09_MESSAGEBACKFILL_DEBT_LINKS.flatMap((entry) => entry.targetDebtIds))).toEqual(new Set(["debt.wire.http.request.response.get.api.rooms.id.messages.1f82u0n"]));
    expect(REVIEWED_MAIN_2026_09_09_MESSAGEBACKFILL_DTO_DECLARATIONS.some((entry) => entry.locator === "http:request_response:POST /api/message-backfill/publish")).toBe(true);
  });
});
