import { describe, expect, test } from "bun:test";
import { classifyDbError } from "../../src/executors/persist-messages";

describe("classifyDbError (M070)", () => {
  test("maps postgres error codes on root and nested cause", () => {
    expect(classifyDbError(Object.assign(new Error("x"), { code: "23503" }))).toBe("fk_violation");
    const inner = Object.assign(new Error("inner"), { code: "23505" });
    const outer = Object.assign(new Error("wrap"), { cause: inner });
    expect(classifyDbError(outer)).toBe("unique_violation");
    expect(classifyDbError(Object.assign(new Error("violates foreign key constraint on x"), {}))).toBe(
      "fk_violation",
    );
    expect(classifyDbError(Object.assign(new Error("x"), { code: "57014" }))).toBe("timeout");
    expect(classifyDbError(Object.assign(new Error("x"), { code: "40P01" }))).toBe("deadlock");
    expect(classifyDbError(new Error("no code"))).toBe("unknown");
  });
});
