import { describe, expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  PUSH_MESSAGE_CANDIDATE_STATES,
  PUSH_NOTIFICATION_DELIVERY_KINDS,
  PUSH_NOTIFICATION_DELIVERY_CLAIM_PURPOSES,
  PUSH_NOTIFICATION_DELIVERY_STATES,
  PUSH_NOTIFICATION_TEST_INTENT_STATES,
  pushMessageCandidates,
  pushNotificationDeliveries,
  pushNotificationTestIntents,
} from "../../src/schema";

describe("D468 durable push delivery schema", () => {
  test("makes candidate and generic test claims recoverable after worker loss", () => {
    expect(PUSH_MESSAGE_CANDIDATE_STATES).toEqual(["pending", "claimed", "terminal"]);
    expect(PUSH_NOTIFICATION_TEST_INTENT_STATES).toEqual(["pending", "claimed", "terminal"]);
    for (const table of [pushMessageCandidates, pushNotificationTestIntents]) {
      const config = getTableConfig(table);
      expect(config.columns.map((column) => column.name)).toContain("claim_owner");
      expect(config.columns.map((column) => column.name)).toContain("claim_expires_at");
      expect(config.checks.some((check) =>
        check.name.includes("lease_shape") || check.name.includes("terminal_shape"),
      )).toBe(true);
    }
  });

  test("keys one logical fixed-copy delivery per binding token generation", () => {
    const delivery = getTableConfig(pushNotificationDeliveries);
    expect(PUSH_NOTIFICATION_DELIVERY_KINDS).toEqual([
      "important_message",
      "needs_you",
      "test",
    ]);
    expect(PUSH_NOTIFICATION_DELIVERY_STATES).toEqual([
      "pending",
      "claimed",
      "receipt_pending",
      "retry",
      "delivered",
      "terminal",
    ]);
    expect(PUSH_NOTIFICATION_DELIVERY_CLAIM_PURPOSES).toEqual(["send", "receipt"]);
    expect(delivery.indexes.some((index) =>
      index.config.name === "uq_push_notification_deliveries_logical_generation",
    )).toBe(true);
    expect(delivery.columns.map((column) => column.name)).toEqual([
      "id",
      "user_id",
      "binding_id",
      "token_generation",
      "kind",
      "event_id",
      "room_id",
      "top_level_room_id",
      "message_id",
      "attention_request_id",
      "occurred_at",
      "state",
      "attempt_count",
      "receipt_attempt_count",
      "next_attempt_at",
      "ticket_id",
      "ticket_accepted_at",
      "claim_owner",
      "claim_purpose",
      "claim_expires_at",
      "last_failure_code",
      "terminal_at",
      "expires_at",
      "created_at",
      "updated_at",
    ]);
    const names = delivery.columns.map((column) => column.name);
    expect(names).not.toContain("expo_push_token");
    expect(names).not.toContain("title");
    expect(names).not.toContain("body");
    expect(names).not.toContain("content");
    expect(delivery.checks.some((check) => check.name === "push_notification_deliveries_target_shape_check")).toBe(true);
    expect(delivery.checks.some((check) => check.name === "push_notification_deliveries_attempt_bounds_check")).toBe(true);
    expect(delivery.checks.some((check) => check.name === "push_notification_deliveries_expiry_bound_check")).toBe(true);
  });
});
