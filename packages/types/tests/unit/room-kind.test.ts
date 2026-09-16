/**
 * M124 P1 — pins `RoomKind` to include `'open'`.
 *
 * `'open'` is the discoverable, self-joinable public-room value (MR11). This
 * is primarily a compile-time guard: the `satisfies RoomKind` assertions
 * below fail `tsc` if the union ever drops a value, and the const array
 * doubles as a runtime regression check.
 */
import { describe, expect, test } from "bun:test";

import type { RoomKind } from "../../src/api";

const ALL_ROOM_KINDS = [
  "private",
  "group",
  "multi_agent",
  "subthread",
  "open",
] as const satisfies readonly RoomKind[];

describe("RoomKind (M124)", () => {
  test("includes 'open'", () => {
    const open: RoomKind = "open";
    expect(open).toBe("open");
    expect(ALL_ROOM_KINDS).toContain("open");
  });

  test("retains every pre-M124 kind", () => {
    for (const k of ["private", "group", "multi_agent", "subthread"] as const) {
      expect(ALL_ROOM_KINDS).toContain(k);
    }
  });
});
