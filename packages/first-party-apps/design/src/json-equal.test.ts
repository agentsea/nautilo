import { describe, expect, test } from "bun:test";
import { jsonEqual } from "./json-equal";

describe("jsonEqual", () => {
  test("compares equal metadata beyond 200 nested levels", () => {
    const nest = (leaf: string): unknown => {
      let value: unknown = leaf;
      for (let index = 0; index < 201; index += 1) value = { metadata: value };
      return value;
    };
    expect(jsonEqual(nest("same"), nest("same"))).toBe(true);
  });

  test("terminates when both values contain matching cycles", () => {
    const left: { self?: unknown; value: string } = { value: "same" };
    const right: { self?: unknown; value: string } = { value: "same" };
    left.self = left;
    right.self = right;
    expect(jsonEqual(left, right)).toBe(true);
  });

  test("finds a distinct value beyond 200 nested levels", () => {
    const nest = (leaf: string): unknown => {
      let value: unknown = leaf;
      for (let index = 0; index < 201; index += 1) value = { metadata: value };
      return value;
    };
    expect(jsonEqual(nest("left"), nest("right"))).toBe(false);
  });
});
