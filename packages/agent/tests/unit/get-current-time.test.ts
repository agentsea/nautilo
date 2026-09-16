import { describe, expect, test } from "bun:test";
import { createGetCurrentTimeTool } from "../../src/tools/time/get-current-time";
import { formatLocal } from "../../src/prompts/time-format";

describe("get_current_time tool", () => {
  test("returns ISO + IANA + localFormatted matching formatLocal at the same instant", async () => {
    const tool = createGetCurrentTimeTool({ userTimezone: "Asia/Tokyo" });
    const before = Date.now();
    const raw = await tool.invoke({});
    const after = Date.now();
    const parsed = JSON.parse(raw) as { nowUtcIso: string; userTimezone: string; localFormatted: string };

    expect(parsed.userTimezone).toBe("Asia/Tokyo");
    const t = Date.parse(parsed.nowUtcIso);
    expect(t).toBeGreaterThanOrEqual(before - 1000);
    expect(t).toBeLessThanOrEqual(after + 1000);
    // Parity: localFormatted equals formatLocal(nowUtcIso, tz).
    expect(parsed.localFormatted).toBe(formatLocal(new Date(parsed.nowUtcIso), "Asia/Tokyo"));
    expect(parsed.localFormatted).toContain("Asia/Tokyo");
  });

  test("falls back to UTC when context tz is empty", async () => {
    const tool = createGetCurrentTimeTool({ userTimezone: "" });
    const parsed = JSON.parse(await tool.invoke({})) as { userTimezone: string; localFormatted: string };
    expect(parsed.userTimezone).toBe("UTC");
    expect(parsed.localFormatted).toContain("(UTC, UTC+00:00)");
  });

  test("falls back to UTC when no context is provided", async () => {
    const tool = createGetCurrentTimeTool();
    const parsed = JSON.parse(await tool.invoke({})) as { userTimezone: string };
    expect(parsed.userTimezone).toBe("UTC");
  });
});
