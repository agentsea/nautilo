import { describe, expect, test } from "bun:test";

import {
  canUseExternalRoomVisibility,
  roomVisibilityFields,
} from "./room-visibility";

describe("mobile room visibility", () => {
  test("maps each creation choice to the canonical room payload", () => {
    expect(roomVisibilityFields("private", false)).toEqual({ kind: "private" });
    expect(roomVisibilityFields("external", true)).toEqual({
      kind: "open",
      discoverable: false,
    });
    expect(roomVisibilityFields("public", false)).toEqual({
      kind: "open",
      discoverable: true,
    });
  });

  test("requires freshly verified server support before producing an External payload", () => {
    expect(canUseExternalRoomVisibility("verified", true)).toBe(true);
    expect(canUseExternalRoomVisibility("verified", undefined)).toBe(false);
    expect(canUseExternalRoomVisibility("cached", true)).toBe(false);
    expect(canUseExternalRoomVisibility("stale", true)).toBe(false);
    expect(roomVisibilityFields("external", false)).toBeNull();
  });
});
