import { describe, expect, test } from "bun:test";
import { delimiter, join } from "node:path";
import { CLAUDE_AGENT_SDK_COMPATIBLE_CLAUDE_CODE_VERSION, isReviewedClaudeCodeVersion } from "@nautilo/claude-agent-sdk-host";
import {
  CLAUDE_VERSION_ARGS,
  createAmbientClaudeExecutableResolver,
  parseAmbientClaudeVersionOutput,
  REVIEWED_CLAUDE_RUNTIME_FEATURES,
  UNREVIEWED_CLAUDE_RUNTIME_FEATURES,
} from "../../electron/claude-executable-resolver";

describe("D452 ambient Claude executable resolver", () => {
  test("admits only an ambient exact reviewed executable and returns its frozen feature ledger", async () => {
    const calls: string[] = [];
    const resolver = createAmbientClaudeExecutableResolver({
      path: ["/missing", "/ambient"].join(delimiter),
      inspect: {
        canonicalAmbientClaude: async (candidate) => {
          calls.push(candidate);
          return candidate === join("/ambient", "claude") ? "/resolved/claude" : null;
        },
        version: async (executable, args) => {
          expect(executable).toBe("/resolved/claude");
          expect(args).toBe(CLAUDE_VERSION_ARGS);
          return `${CLAUDE_AGENT_SDK_COMPATIBLE_CLAUDE_CODE_VERSION} (Claude Code)\n`;
        },
      },
    });
    expect(await resolver.resolve()).toEqual({
      path: "/resolved/claude",
      version: CLAUDE_AGENT_SDK_COMPATIBLE_CLAUDE_CODE_VERSION,
      features: REVIEWED_CLAUDE_RUNTIME_FEATURES,
    });
    expect(calls).toEqual([join("/missing", "claude"), join("/ambient", "claude")]);
  });

  test("resolves other canonical ambient versions for discovery without inventing execution features", async () => {
    expect(parseAmbientClaudeVersionOutput(`${CLAUDE_AGENT_SDK_COMPATIBLE_CLAUDE_CODE_VERSION}\n`)).toBe(CLAUDE_AGENT_SDK_COMPATIBLE_CLAUDE_CODE_VERSION);
    expect(parseAmbientClaudeVersionOutput("2.1.39 (Claude Code)\n")).toBe("2.1.39");
    expect(isReviewedClaudeCodeVersion("2.1.39")).toBe(false);
    for (const output of ["Claude Code 2.1.235\n", `${CLAUDE_AGENT_SDK_COMPATIBLE_CLAUDE_CODE_VERSION} beta\n`, "02.1.39\n", null]) {
      expect(parseAmbientClaudeVersionOutput(output)).toBeNull();
    }
    const resolver = createAmbientClaudeExecutableResolver({
      path: "/ambient",
      inspect: {
        canonicalAmbientClaude: async () => "/resolved/claude",
        version: async () => "2.1.39\n",
      },
    });
    expect(await resolver.resolve()).toEqual({ path: "/resolved/claude", version: "2.1.39", features: UNREVIEWED_CLAUDE_RUNTIME_FEATURES });
  });

  test("uses the bounded ambient Windows candidate when requested", async () => {
    const candidates: string[] = [];
    const resolver = createAmbientClaudeExecutableResolver({
      path: "/ambient",
      executableName: "claude.exe",
      inspect: {
        canonicalAmbientClaude: async (candidate) => { candidates.push(candidate); return null; },
        version: async () => null,
      },
    });
    expect(await resolver.resolve()).toBeNull();
    expect(candidates).toEqual([join("/ambient", "claude.exe")]);
  });
});
