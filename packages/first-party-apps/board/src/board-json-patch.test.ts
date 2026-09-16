import { expect, test } from "bun:test";
import { BoardPatchError, patchBoardJson } from "./board-json-patch";

test("edits arbitrary native Board fields and leaves the source untouched", () => {
  const source = { meta: { title: "Plan", custom: { "a/b~c": [1, 2] } }, elements: [] };
  const result = patchBoardJson(source, [
    { op: "test", path: "/meta/title", value: "Plan" },
    { op: "replace", path: "/meta/title", value: "Launch" },
    { op: "add", path: "/meta/custom/a~1b~0c/-", value: 3 },
    { op: "copy", from: "/meta/custom", path: "/copied" },
    { op: "move", from: "/meta/custom/a~1b~0c/0", path: "/meta/custom/a~1b~0c/2" },
  ]);
  expect(result.value).toEqual({
    meta: { title: "Launch", custom: { "a/b~c": [2, 3, 1] } },
    elements: [], copied: { "a/b~c": [1, 2, 3] },
  });
  expect(source).toEqual({ meta: { title: "Plan", custom: { "a/b~c": [1, 2] } }, elements: [] });
});

test("failed batches preserve every source fact and identify the failed operation", () => {
  const source = { meta: { title: "Plan" }, elements: [{ id: "one" }] };
  for (const operation of [
    { op: "test", path: "/meta/title", value: "Other" },
    { op: "remove", path: "/missing" },
    { op: "replace", path: "/elements/01", value: {} },
    { op: "add", path: "/__proto__/polluted", value: true },
    { op: "move", from: "/meta", path: "/meta/child" },
  ]) {
    try {
      patchBoardJson(source, [{ op: "replace", path: "/meta/title", value: "Changed" }, operation]);
      throw new Error("expected patch failure");
    } catch (error) {
      expect(error).toBeInstanceOf(BoardPatchError);
      expect((error as BoardPatchError).operationIndex).toBe(1);
    }
    expect(source).toEqual({ meta: { title: "Plan" }, elements: [{ id: "one" }] });
  }
});

test("supports complete model replacement and same-position array moves", () => {
  expect(patchBoardJson({ value: 1 }, [{ op: "replace", path: "", value: { value: 2 } }]).value).toEqual({ value: 2 });
  expect(patchBoardJson([1, 2], [{ op: "move", from: "/0", path: "/0" }]).value).toEqual([1, 2]);
});
