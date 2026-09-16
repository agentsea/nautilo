import { describe, expect, test } from "bun:test";
import {
  SHAPE_ACTIONS,
  WIDE_BAR_ACTIONS,
  chromeInvariants,
  creationBarModeForWidth,
  isWideActionReachable,
  overflowActionsForMode,
  visiblePrimaryActions,
} from "./creation-bar";

describe("creation bar responsive presentation", () => {
  const measurements = { wide: 820, compact: 520 };

  test("chooses wide, compact, and minimal from measured available space", () => {
    expect(creationBarModeForWidth(820, measurements)).toBe("wide");
    expect(creationBarModeForWidth(700, measurements)).toBe("compact");
    expect(creationBarModeForWidth(519, measurements)).toBe("minimal");
  });

  test("keeps each hidden action reachable through a structured group", () => {
    const compact = overflowActionsForMode("compact");
    expect(compact.edit).toEqual(["undo", "redo"]);
    expect(compact.create).toContain("select");
    expect(compact.create).toContain("frame");
    expect(compact.create).toContain("connector");
    expect(compact.view).toEqual(["layers", "inspector", "full-canvas"]);

    const minimal = overflowActionsForMode("minimal");
    expect(minimal.edit).toEqual(["undo", "redo"]);
    for (const action of [...SHAPE_ACTIONS, "pen", "connector"] as const) {
      expect(minimal.create).toContain(action);
    }
    expect(minimal.view).toEqual(["layers", "inspector"]);
  });

  test("only minimal removes direct creation controls", () => {
    expect(visiblePrimaryActions("wide")).toContain("shapes");
    expect(visiblePrimaryActions("compact")).toContain("connector");
    expect(visiblePrimaryActions("minimal")).toEqual([]);
  });

  test("gives every hidden wide-bar action a named compact/minimal recovery", () => {
    for (const mode of ["compact", "minimal"] as const) {
      for (const action of WIDE_BAR_ACTIONS) {
        expect(isWideActionReachable(mode, action)).toBe(true);
      }
    }
  });

  test("never sacrifices save truth, active tool, or full canvas to collapse", () => {
    for (const mode of ["wide", "compact", "minimal"] as const) {
      expect(chromeInvariants(mode)).toMatchObject({
        saveTruthVisible: true,
        activeToolVisible: true,
        fullCanvasReachable: true,
      });
    }
    expect(chromeInvariants("wide").overflowAvailable).toBe(false);
    expect(chromeInvariants("compact").overflowAvailable).toBe(true);
    expect(chromeInvariants("minimal").overflowAvailable).toBe(true);
  });
});
