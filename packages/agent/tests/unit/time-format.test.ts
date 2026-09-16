import { describe, expect, test } from "bun:test";
import { formatLocal, formatUtcOffset, relativeBucket } from "../../src/prompts/time-format";

describe("formatLocal", () => {
  test("Europe/Athens summer (EEST, UTC+3)", () => {
    const d = new Date("2026-05-09T15:58:00Z");
    expect(formatLocal(d, "Europe/Athens")).toBe(
      "Saturday, 2026-05-09 18:58 (Europe/Athens, UTC+03:00)",
    );
  });

  test("UTC", () => {
    const d = new Date("2026-05-09T15:58:00Z");
    expect(formatLocal(d, "UTC")).toBe(
      "Saturday, 2026-05-09 15:58 (UTC, UTC+00:00)",
    );
  });

  test("Asia/Tokyo (UTC+9)", () => {
    const d = new Date("2026-05-09T15:58:00Z");
    expect(formatLocal(d, "Asia/Tokyo")).toBe(
      "Sunday, 2026-05-10 00:58 (Asia/Tokyo, UTC+09:00)",
    );
  });

  test("America/New_York (DST, UTC-4 in May)", () => {
    const d = new Date("2026-05-09T15:58:00Z");
    expect(formatLocal(d, "America/New_York")).toBe(
      "Saturday, 2026-05-09 11:58 (America/New_York, UTC-04:00)",
    );
  });
});

describe("formatUtcOffset DST boundary (Europe/Athens)", () => {
  // Athens switches EET(+2)->EEST(+3) at 01:00 UTC on the last Sunday of March.
  test("before the spring-forward is UTC+02:00", () => {
    expect(formatUtcOffset(new Date("2026-03-29T00:30:00Z"), "Europe/Athens")).toBe("UTC+02:00");
  });
  test("after the spring-forward is UTC+03:00", () => {
    expect(formatUtcOffset(new Date("2026-03-29T01:30:00Z"), "Europe/Athens")).toBe("UTC+03:00");
  });
});

describe("relativeBucket", () => {
  test("0ms -> just now", () => expect(relativeBucket(0)).toBe("just now"));
  test("30s -> just now", () => expect(relativeBucket(30_000)).toBe("just now"));
  test("59s -> just now", () => expect(relativeBucket(59_000)).toBe("just now"));
  test("60s -> 1 minutes", () => expect(relativeBucket(60_000)).toBe("1 minutes"));
  test("14m", () => expect(relativeBucket(14 * 60_000)).toBe("14 minutes"));
  test("60m -> 1 hours", () => expect(relativeBucket(3_600_000)).toBe("1 hours"));
  test("3h", () => expect(relativeBucket(3 * 3_600_000)).toBe("3 hours"));
  test("23h59m -> 23 hours", () => expect(relativeBucket(23 * 3_600_000 + 59 * 60_000)).toBe("23 hours"));
  test("24h -> 1 days", () => expect(relativeBucket(86_400_000)).toBe("1 days"));
  test("25h -> 1 days", () => expect(relativeBucket(25 * 3_600_000)).toBe("1 days"));
  test("2d", () => expect(relativeBucket(2 * 86_400_000)).toBe("2 days"));
  test("negative clamps to just now", () => expect(relativeBucket(-5000)).toBe("just now"));
});
