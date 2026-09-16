import { describe, expect, test } from "bun:test";
import {
  SEARCH_DEFAULT_GLOB_LIMIT,
  SEARCH_DEFAULT_GREP_LIMIT,
  parseRelaySearchArgs,
  type RelaySearchResult,
} from "../../src";

describe("D446 native search contract", () => {
  test("glob defaults preserve useful hidden discovery and repository ignores", () => {
    expect(parseRelaySearchArgs("glob", { path: ".", pattern: "**/*.ts" })).toEqual({
      ok: true,
      value: {
        path: ".",
        pattern: "**/*.ts",
        limit: SEARCH_DEFAULT_GLOB_LIMIT,
        includeIgnored: false,
        hidden: "include",
      },
    });
  });

  test("grep defaults to smart case and its compatibility page size", () => {
    expect(parseRelaySearchArgs("grep", { path: "src", query: "Widget" })).toEqual({
      ok: true,
      value: {
        path: "src",
        query: "Widget",
        limit: SEARCH_DEFAULT_GREP_LIMIT,
        includeIgnored: false,
        hidden: "include",
        caseMode: "smart",
      },
    });
  });

  test("accepts the locked grep modes and single optional file glob", () => {
    expect(
      parseRelaySearchArgs("grep", {
        path: ".",
        query: "TODO",
        glob: "**/*.ts",
        lineRange: { from: 10, to: 30 },
        limit: 750,
        includeIgnored: true,
        hidden: "exclude",
        caseMode: "sensitive",
      }),
    ).toEqual({
      ok: true,
      value: {
        path: ".",
        query: "TODO",
        glob: "**/*.ts",
        lineRange: { from: 10, to: 30 },
        limit: 750,
        includeIgnored: true,
        hidden: "exclude",
        caseMode: "sensitive",
      },
    });
  });

  test.each([
    ["glob", { path: ".", pattern: "" }, "pattern must be a non-empty string"],
    ["glob", { path: ".", pattern: "*", limit: 0 }, "limit must be a positive safe integer"],
    ["grep", { path: ".", query: "x", lineRange: { from: 4, to: 2 } }, "lineRange.from must be less"],
    ["grep", { path: ".", query: "x", caseMode: "maybe" }, "caseMode must be"],
    ["grep", { path: ".", query: "x", globs: ["*.ts"] }, "unknown search argument: globs"],
    ["grep", { path: ".", query: "x", shell: true }, "unknown search argument: shell"],
  ] as const)("rejects invalid %s args before spawn", (command, input, message) => {
    const result = parseRelaySearchArgs(command, input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SEARCH_INVALID_ARGS");
      expect(result.error.message).toContain(message);
    }
  });

  test("normalized success keeps relative identity and a reusable file path distinct", () => {
    const result: RelaySearchResult = {
      ok: true,
      command: "grep",
      engine: { name: "ripgrep", version: "15.1.0" },
      query: "Widget",
      caseMode: "smart",
      includeIgnored: false,
      hidden: "include",
      count: 1,
      truncated: false,
      matches: [
        {
          relativePath: "src/widget.ts",
          path: "project/src/widget.ts",
          line: 12,
          column: 4,
          match: "Widget",
          preview: "export class Widget {}",
        },
      ],
    };

    expect(result.matches[0]?.relativePath).toBe("src/widget.ts");
    expect(result.matches[0]?.path).toBe("project/src/widget.ts");
  });

  test("no-match is an empty successful page, not an engine error", () => {
    const result: RelaySearchResult = {
      ok: true,
      command: "glob",
      engine: { name: "ripgrep", version: "15.1.0" },
      pattern: "**/*.does-not-exist",
      includeIgnored: false,
      hidden: "include",
      count: 0,
      truncated: false,
      entries: [],
    };
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.count).toBe(0);
  });

  test("truncation remains valid structured output with recovery guidance", () => {
    const result: RelaySearchResult = {
      ok: true,
      command: "glob",
      engine: { name: "ripgrep", version: "15.1.0" },
      pattern: "**/*",
      includeIgnored: false,
      hidden: "include",
      count: 1,
      truncated: true,
      recovery: "Narrow path or pattern, or request another explicit result page size.",
      entries: [{ relativePath: "src/a.ts", path: "src/a.ts" }],
    };
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});
