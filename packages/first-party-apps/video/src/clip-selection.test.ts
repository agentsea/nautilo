import { expect, test } from "bun:test";
import { selectClipIds } from "./clip-selection";

test("additive selection preserves order and dragging a member preserves the group", () => {
  const first = selectClipIds(new Set(), "a");
  const group = selectClipIds(first, "b", true);
  expect([...group]).toEqual(["a", "b"]);
  expect(selectClipIds(group, "a", false, true)).toBe(group);
  expect([...selectClipIds(group, "c", false, true)]).toEqual(["c"]);
  expect([...selectClipIds(group, "a", true)]).toEqual(["b"]);
  expect([...group]).toEqual(["a", "b"]);
  expect([...selectClipIds(group, null)]).toEqual([]);
});
