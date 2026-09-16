/**
 * M037 — per-tool arity registry unit tests.
 */

import { describe, test, expect } from "bun:test";
import { slotKindFor, TOOL_ARITY } from "../../src/command-arity";

describe("slotKindFor", () => {
  test("declared params resolve to their declared slot kind", () => {
    expect(slotKindFor("run_shell", "command")).toBe("shell_command");
    expect(slotKindFor("file", "command")).toBe("discriminator");
    expect(slotKindFor("file", "path")).toBe("path");
  });

  test("undeclared param on a declared tool defaults to opaque", () => {
    expect(slotKindFor("file", "zone")).toBe("opaque");
    expect(slotKindFor("run_shell", "cwd")).toBe("opaque");
  });

  test("undeclared tool defaults to opaque for any param", () => {
    expect(slotKindFor("totally_new_tool", "anything")).toBe("opaque");
  });

  test("TOOL_ARITY declares run_shell + file only", () => {
    expect(Object.keys(TOOL_ARITY).sort()).toEqual(["file", "run_shell"]);
  });
});
