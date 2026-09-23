import { describe, expect, test } from "bun:test";
import { docks, isCommand, views } from "../contract";
import { clampRect, nearestDock, place, validRect } from "../geometry";

describe("companion placement", () => {
  const screens = [
    { x: 0, y: 25, width: 1728, height: 1050 },
    { x: -1920, y: -400, width: 1920, height: 1080 },
    { x: 1728, y: 900, width: 900, height: 1400 },
    { x: 0, y: 0, width: 320, height: 240 },
  ];
  test("all modes stay reachable across displays, negative origins and undersized work areas", () => {
    for (const work of screens) for (const view of views) for (const dock of docks) {
      const rect = place(view, dock, { x: -9000, y: 9000, width: 440, height: 540 }, work);
      expect(rect.x).toBeGreaterThanOrEqual(work.x);
      expect(rect.y).toBeGreaterThanOrEqual(work.y);
      expect(rect.x + rect.width).toBeLessThanOrEqual(work.x + work.width);
      expect(rect.y + rect.height).toBeLessThanOrEqual(work.y + work.height);
    }
  });
  test("docked expansion preserves the chosen edge", () => {
    const work = screens[0]!;
    for (const dock of docks.filter(value => value !== "free")) {
      let rect = place("orb", dock, { x: 700, y: 500, width: 88, height: 88 }, work);
      for (const view of views) {
        rect = place(view, dock, rect, work);
        expect(nearestDock(rect, work)).toBe(dock);
      }
    }
  });
  test("saved placement on a removed monitor recovers on the remaining display", () => {
    const recovered = clampRect({ x: -1800, y: -300, width: 440, height: 540 }, screens[0]!);
    expect(recovered.x).toBe(0);
    expect(recovered.y).toBe(25);
  });
  test("free placement does not snap away from edges", () => {
    expect(nearestDock({ x: 300, y: 300, width: 88, height: 88 }, screens[0]!)).toBe("free");
  });
  test("malformed persistence and arbitrary IPC are rejected", () => {
    expect(validRect({ x: Infinity, y: 0, width: 88, height: 88 })).toBe(false);
    expect(validRect({ x: 0, y: 0, width: -1, height: 88 })).toBe(false);
    for (const command of [null, "quit", {}, { type: "dock", value: "other-app" }, { type: "bounds", value: { x: 0, y: 0 } }]) expect(isCommand(command)).toBe(false);
  });
});
