import { describe, expect, test } from "bun:test";
import { COMBO_SPECS } from "../../src/config/model-selection";
import { SELECTION_PROFILES, type SelectionAxis } from "@nautilo/types";

describe("COMBO_SPECS (M152)", () => {
  test("has exactly the 9 non-balanced profiles", () => {
    const keys = Object.keys(COMBO_SPECS).sort();
    const expected = SELECTION_PROFILES.filter((p) => p !== "balanced").sort();
    expect(keys).toEqual([...expected]);
  });

  test("each spec has band !== objective; singles have no band", () => {
    for (const [name, spec] of Object.entries(COMBO_SPECS)) {
      if (spec.band) {
        expect(spec.band).not.toBe(spec.objective);
      }
      const isSingle = ["most_private", "smartest", "cheapest"].includes(name);
      expect(spec.band === undefined).toBe(isSingle);
    }
  });

  test("the 6 pairs cover every ordered (band, objective) axis pair", () => {
    const axes: SelectionAxis[] = ["privacy", "smart", "cheap"];
    const pairs = new Set<string>();
    for (const spec of Object.values(COMBO_SPECS)) {
      if (spec.band) pairs.add(`${spec.band}->${spec.objective}`);
    }
    let count = 0;
    for (const b of axes) for (const o of axes) if (b !== o) count++;
    expect(pairs.size).toBe(count); // 6
  });
});
