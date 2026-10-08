import { describe, expect, test } from "bun:test";
import { createHumanTerminalTool, humanTerminalSchema } from "../../src/tools/terminal/human-terminal";

describe("Human Terminal model schema", () => {
  test("accepts input/read and excludes authority and lifecycle selectors", () => {
    for (const value of [{ action: "read", cursor: 0 }, { action: "run", command: "help" }, { action: "write", data: "\x03" }]) {
      expect(humanTerminalSchema.safeParse(value).success).toBeTrue();
    }
    for (const value of [{ action: "spawn" }, { action: "list" }, { action: "kill" }, { action: "read", session_id: "t1" },
      { action: "read", generation: "g" }, { action: "read", humanUserId: "human-a" }, { action: "read", cursor: Infinity },
      { action: "read", cursor: Number.MAX_SAFE_INTEGER + 1 }, { action: "run", command: " " }, { action: "run", command: "x\0" }]) {
      expect(humanTerminalSchema.safeParse(value).success).toBeFalse();
    }
  });
  test("requires admitted dispatch and describes input acknowledgement honestly", async () => {
    const tool = createHumanTerminalTool();
    expect(tool.name).toBe("human_terminal");
    expect(tool.description).toContain("does not force a shell");
    expect(tool.description).toContain("never command completion");
    expect(tool.description).toContain("UTF-16 code units");
    const failure = await tool.invoke({ action: "read" }).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("admitted Desktop");
  });
});
