import { beforeEach, afterEach, describe, expect, spyOn, test } from "bun:test";
import { HumanMessage, ToolMessage } from "@langchain/core/messages";
import { assertMessageInvariants } from "../../src/assert.js";

describe("D143 Layer 4 — assertMessageInvariants", () => {
  let savedNodeEnv: string | undefined;

  beforeEach(() => {
    savedNodeEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    if (savedNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = savedNodeEnv;
    }
  });

  test("L4-A1: no duplicates is a no-op", () => {
    const messages = [
      new HumanMessage("hi"),
      new ToolMessage({ content: "a", tool_call_id: "tc1", name: "t" }),
      new ToolMessage({ content: "b", tool_call_id: "tc2", name: "t" }),
    ];
    expect(() => assertMessageInvariants(messages, "L4-A1.where")).not.toThrow();
  });

  test("L4-A2: duplicate tool_call_id throws in dev/test with where, id, indices", () => {
    const dupId = "same-id";
    const messages = [
      new HumanMessage("h"),
      new ToolMessage({ content: "first", tool_call_id: dupId, name: "t" }),
      new ToolMessage({ content: "dup", tool_call_id: dupId, name: "t" }),
    ];
    const where = "test.pre_model";
    let err: unknown;
    try {
      assertMessageInvariants(messages, where);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain(`[${where}]`);
    expect(msg).toContain(`tool_call_id=${dupId}`);
    expect(msg).toContain("at idx 2");
    expect(msg).toContain("prev at idx 1");
  });

  test("L4-A3: many distinct tool_call_ids is a no-op", () => {
    const messages = Array.from({ length: 5 }, (_, i) =>
      new ToolMessage({ content: String(i), tool_call_id: `id-${i}`, name: "t" }),
    );
    expect(() => assertMessageInvariants(messages, "L4-A3.where")).not.toThrow();
  });

  test("L4-A4: production does not throw; warn surfaces via stderr (console.error)", () => {
    process.env.NODE_ENV = "production";
    const dupId = "prod-dup";
    const where = "prod.where";
    const messages = [
      new ToolMessage({ content: "a", tool_call_id: dupId, name: "t" }),
      new ToolMessage({ content: "b", tool_call_id: dupId, name: "t" }),
    ];
    // `warn()` routes to `console.error` in default stderr mode. Spying here
    // avoids ESM import-binding issues with `spyOn` on `@nautilo/logger.warn`.
    const stderrSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => assertMessageInvariants(messages, where)).not.toThrow();
      expect(stderrSpy).toHaveBeenCalled();
      const combined = stderrSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(combined).toContain(`[${where}]`);
      expect(combined).toContain(`tool_call_id=${dupId}`);
      expect(combined).toContain("at idx 1");
      expect(combined).toContain("prev at idx 0");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  test("L4-A5: ToolMessages without tool_call_id are ignored", () => {
    const a = new ToolMessage({ content: "a", tool_call_id: "x", name: "t" });
    const b = new ToolMessage({ content: "b", tool_call_id: "y", name: "t" });
    delete (a as { tool_call_id?: string }).tool_call_id;
    delete (b as { tool_call_id?: string }).tool_call_id;
    expect(() => assertMessageInvariants([a, b], "L4-A5.where")).not.toThrow();
  });
});
