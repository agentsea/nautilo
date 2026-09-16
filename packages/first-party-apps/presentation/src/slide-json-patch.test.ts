import { expect, test } from "bun:test";
import { patchSlideJson } from "./slide-json-patch";

test("patches arbitrary native fields without restricting creative properties", () => {
  const source = { themes: [{ fonts: { heading: "A" } }], slides: [{ custom: { "a/b~c": [1, 2] } }] };
  const result = patchSlideJson(source, [
    { op: "replace", path: "/themes/0/fonts/heading", value: "B" },
    { op: "add", path: "/slides/0/custom/a~1b~0c/-", value: 3 },
    { op: "copy", from: "/themes/0/fonts", path: "/other" },
    { op: "move", from: "/slides/0/custom/a~1b~0c/0", path: "/slides/0/custom/a~1b~0c/2" },
    { op: "test", path: "/other", value: { heading: "B" } },
  ]);
  expect(result.value).toEqual({ themes: [{ fonts: { heading: "B" } }], slides: [{ custom: { "a/b~c": [2, 3, 1] } }], other: { heading: "B" } });
  expect(source.themes[0].fonts.heading).toBe("A");
  expect(source.slides[0].custom["a/b~c"]).toEqual([1, 2]);
});

test("failed preconditions and invalid pointers leave every source field intact", () => {
  const source = { list: [1, 2], value: { a: 1, b: 2 } };
  for (const patch of [
    { op: "test", path: "/list/0", value: 4 },
    { op: "remove", path: "/missing" },
    { op: "replace", path: "/list/02", value: 3 },
    { op: "add", path: "/list/4", value: 3 },
    { op: "add", path: "/__proto__/polluted", value: true },
    { op: "add", path: "/value/~3", value: true },
    { op: "move", from: "/value", path: "/value/nested" },
  ]) {
    expect(() => patchSlideJson(source, [{ op: "replace", path: "/list/0", value: 9 }, patch])).toThrow();
    expect(source).toEqual({ list: [1, 2], value: { a: 1, b: 2 } });
  }
  expect(patchSlideJson(source, [{ op: "test", path: "/value", value: { b: 2, a: 1 } }]).value).toEqual(source);
});

test("supports full replacement and moving an item to the same array position", () => {
  expect(patchSlideJson({ value: 1 }, [{ op: "replace", path: "", value: { value: 2 } }]).value).toEqual({ value: 2 });
  expect(patchSlideJson([1, 2], [{ op: "move", from: "/0", path: "/0" }]).value).toEqual([1, 2]);
});
