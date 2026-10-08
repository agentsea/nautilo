import { describe, expect, test } from "bun:test";
import { createReadShellOutputTool, readShellOutputSchema } from "../../src/tools/shell/read-shell-output";
import { createRetiredRunShellTool } from "../../src/tools/shell/run-shell";

const reference = "retained-output-fixture-reference".padEnd(43, "x");

describe("retained shell output tool schema", () => {
  test("preserves old retained output page and search requests through the explicit reader", () => {
    const page = { reference, offset_bytes: 31, max_bytes: 1024, delete_after_read: true };
    const search = { operation: "search" as const, reference, query: "compile failed", max_matches: 2, context_bytes: 64 };
    expect(readShellOutputSchema.parse({ ...page, operation: "page" })).toEqual({ ...page, operation: "page" });
    expect(readShellOutputSchema.parse(search)).toEqual(search);
  });

  test("retired execution tombstone exposes no retained-output or command schema", () => {
    const retired = createRetiredRunShellTool().schema;
    expect(retired.safeParse({ command: "echo forbidden" }).success).toBeFalse();
    expect(retired.safeParse({ output_artifact: { reference } }).success).toBeFalse();
    expect(retired.safeParse({}).success).toBeTrue();
  });

  test("rejects execution and authority selectors and mixed operation fields", () => {
    for (const fields of [
      { command: "echo extra" }, { owner: "another-reader" }, { execution: "real_workstation" },
      { userId: "another-human" }, { query: "wrong-operation" }, { timeout_seconds: 1 },
    ]) expect(readShellOutputSchema.safeParse({ operation: "page", reference, ...fields }).success).toBe(false);
    expect(readShellOutputSchema.safeParse({ operation: "search", reference, query: "error", offset_bytes: 0 }).success).toBe(false);
    expect(readShellOutputSchema.safeParse({ reference }).success).toBe(false);
  });

  test("keeps the existing byte-based query and page bounds", () => {
    expect(readShellOutputSchema.safeParse({ operation: "search", reference, query: "😀".repeat(257) }).success).toBe(false);
    expect(readShellOutputSchema.safeParse({ operation: "page", reference, max_bytes: 16385 }).success).toBe(false);
    expect(readShellOutputSchema.safeParse({ operation: "page", reference, offset_bytes: -1 }).success).toBe(false);
  });

  test("cannot execute outside the admitted dispatch owner", async () => {
    const error: unknown = await createReadShellOutputTool().invoke({ operation: "page", reference })
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error ? error.message : "").toContain("requires the admitted Desktop executor");
  });
});
