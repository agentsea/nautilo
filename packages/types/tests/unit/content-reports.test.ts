import { describe, expect, test } from "bun:test";

import {
  CONTENT_REPORT_REASONS,
  contentReportListQuerySchema,
  createContentReportRequestSchema,
} from "../../src/content-reports";

const REPORT_ID = "11111111-1111-4111-8111-111111111111";
const ROOM_ID = "22222222-2222-4222-8222-222222222222";

describe("content report contracts", () => {
  test("accepts only the deliberately short reason and target inventory", () => {
    for (const reason of CONTENT_REPORT_REASONS) {
      expect(createContentReportRequestSchema.safeParse({
        id: REPORT_ID,
        target: { type: "message", roomId: ROOM_ID, messageId: 42 },
        reason,
      }).success).toBe(true);
    }
    expect(createContentReportRequestSchema.safeParse({
      id: REPORT_ID,
      target: { type: "room", roomId: ROOM_ID },
      reason: "spam_scam",
    }).success).toBe(false);
  });

  test("bounds optional reporter comments at 500 characters", () => {
    const base = {
      id: REPORT_ID,
      target: {
        type: "person" as const,
        roomId: ROOM_ID,
        userId: "33333333-3333-4333-8333-333333333333",
      },
      reason: "other" as const,
    };
    expect(createContentReportRequestSchema.safeParse({ ...base, comment: "x".repeat(500) }).success).toBe(true);
    expect(createContentReportRequestSchema.safeParse({ ...base, comment: "x".repeat(501) }).success).toBe(false);
  });

  test("defaults the admin queue to open and bounds page size", () => {
    expect(contentReportListQuerySchema.parse({})).toEqual({ status: "open", limit: 25 });
    expect(contentReportListQuerySchema.safeParse({ limit: 51 }).success).toBe(false);
  });
});
