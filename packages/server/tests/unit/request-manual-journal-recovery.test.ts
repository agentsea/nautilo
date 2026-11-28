import { describe, expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import { roomJournalModelRecoveries } from "@nautilo/db";
import { classifyManualJournalRecoveryRequest } from "../../src/lib/request-manual-journal-recovery";

describe("manual Journal recovery", () => {
  const observedThrough = new Date("2026-11-27T10:00:00.000Z");
  const now = new Date("2026-11-27T10:01:00.000Z");

  test("queues one observed hold and deduplicates a repeated click", () => {
    const failureAt = new Date("2026-11-27T09:59:00.000Z");
    expect(classifyManualJournalRecoveryRequest({
      failureAt, observedThrough, now, prior: "none",
    })).toBe("queue");
    expect(classifyManualJournalRecoveryRequest({
      failureAt, observedThrough, now, prior: "pending",
    })).toBe("duplicate");
    expect(classifyManualJournalRecoveryRequest({
      failureAt, observedThrough, now, prior: "spent",
    })).toBe("hold");
  });

  test("does not re-arm a newer failure from an older report click", () => {
    expect(classifyManualJournalRecoveryRequest({
      failureAt: new Date("2026-11-27T10:00:00.001Z"),
      observedThrough,
      now,
      prior: "none",
    })).toBe("hold");
  });

  test("persists exact work, operator, observation, claim, and spend fences", () => {
    const config = getTableConfig(roomJournalModelRecoveries);
    const columnNames = new Set(config.columns.map((column) => column.name));
    for (const name of [
      "room_id",
      "work_kind",
      "work_id",
      "source_batch_id",
      "rebuild_generation",
      "observed_attempt",
      "observed_failure_at",
      "observed_through",
      "target_model_id",
      "authorized_by",
      "authorized_at",
      "claim_lease_token",
      "claimed_at",
      "spent_at",
    ]) expect(columnNames.has(name)).toBe(true);
    expect(config.uniqueConstraints.some((constraint) =>
      constraint.name === "uq_room_journal_model_recovery_attempt"
    )).toBe(true);
    expect(config.enableRLS).toBe(true);
    expect(config.policies).toHaveLength(1);
    expect(config.policies[0]?.to).toHaveProperty("name", "nautilo");
    expect(config.policies[0]?.for).toBe("all");
    const checkNames = new Set(config.checks.map((constraint) => constraint.name));
    for (const name of [
      "room_journal_model_recovery_work_shape",
      "room_journal_model_recovery_coordinates",
      "room_journal_model_recovery_claim",
      "room_journal_model_recovery_time_order",
    ]) expect(checkNames.has(name)).toBe(true);
  });
});
