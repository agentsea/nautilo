import { describe, expect, test } from "bun:test";
import { mcpToolToLangChain, type McpDispatch } from "../../src/tool-factory.ts";
import type { McpDiscoveredTool } from "../../src/types.ts";

const echoTool: McpDiscoveredTool = {
  name: "echo",
  description: "echo tool",
  inputSchema: { type: "object", properties: {}, required: [] },
};

describe("mcpToolToLangChain (RES2 never-throw)", () => {
  test("relays the dispatch result on success", async () => {
    const dispatch: McpDispatch = () => Promise.resolve("hi");
    const lc = mcpToolToLangChain(echoTool, dispatch);
    const out = (await lc.invoke({})) as string;
    expect(out).toBe("hi");
  });

  test("returns a friendly string (never throws) when dispatch rejects", async () => {
    const dispatch: McpDispatch = () => Promise.reject(new Error("boom"));
    const lc = mcpToolToLangChain(echoTool, dispatch);
    const out = (await lc.invoke({})) as string;
    expect(out).toContain("temporarily unavailable");
    expect(out).toContain("boom");
  });
});
