import { describe, it, expect } from "bun:test";
import { memories } from "@nautilo/db";

describe("memories schema (M083)", () => {
  it("has no roomId column", () => {
    expect((memories as unknown as Record<string, unknown>)["roomId"]).toBeUndefined();
  });
});
