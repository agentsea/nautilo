import { describe, test, expect } from "bun:test";
import { stripAtHandle } from "../../src/tools/memory/share-memory";

describe("stripAtHandle (M078)", () => {
  test("removes leading @", () => {
    expect(stripAtHandle("@alice")).toBe("alice");
  });

  test("trims whitespace", () => {
    expect(stripAtHandle("  bob  ")).toBe("bob");
  });

  test("leaves plain handles unchanged", () => {
    expect(stripAtHandle("carol")).toBe("carol");
  });
});
