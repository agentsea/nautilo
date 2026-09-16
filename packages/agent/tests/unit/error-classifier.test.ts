import { describe, expect, test } from "bun:test";
import { classifyErrorSimple } from "../../src/utils/errors";

describe("classifyErrorSimple (legacy binary)", () => {
  test("rate limit is retriable", () => {
    expect(classifyErrorSimple({ status: 429 })).toBe("retriable");
    expect(classifyErrorSimple(new Error("rate limit exceeded"))).toBe("retriable");
  });

  test("timeout is retriable", () => {
    expect(classifyErrorSimple(new Error("Request timed out"))).toBe("retriable");
    expect(classifyErrorSimple(new Error("ETIMEDOUT"))).toBe("retriable");
  });

  test("503 is retriable", () => {
    expect(classifyErrorSimple({ status: 503 })).toBe("retriable");
  });

  test("500 is retriable", () => {
    expect(classifyErrorSimple({ status: 500 })).toBe("retriable");
  });

  test("overloaded is retriable", () => {
    expect(classifyErrorSimple(new Error("Anthropic API overloaded"))).toBe("retriable");
  });

  test("auth error is non-retriable", () => {
    expect(classifyErrorSimple({ status: 401 })).toBe("non_retriable");
  });

  test("bad request is non-retriable", () => {
    expect(classifyErrorSimple({ status: 400 })).toBe("non_retriable");
  });

  test("null is non-retriable", () => {
    expect(classifyErrorSimple(null)).toBe("non_retriable");
  });
});
