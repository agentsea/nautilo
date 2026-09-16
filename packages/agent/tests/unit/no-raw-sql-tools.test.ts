import { describe, test, expect, beforeAll } from "bun:test";
import { ToolCatalog } from "@nautilo/catalog";
import { registerAllTools } from "../../src/tools/register-all";

/** Hermetic guard: no catalog tool name may look like a raw-SQL escape hatch. */
const RAW_SQL_LIKE_TOOL_NAME = /^(query|sql|executeSql|runSql|dbQuery|rawQuery|exec_sql|run_sql)$/i;

const FORBIDDEN_DESCRIPTION_PHRASES = [
  "arbitrary sql",
  "execute sql",
  "raw sql",
] as const;

function assertNoRawSqlToolSurface(tool: { name: string; description: string }): void {
  if (RAW_SQL_LIKE_TOOL_NAME.test(tool.name)) {
    throw new Error(
      `Tool name "${tool.name}" matches the forbidden raw-SQL-like name pattern ${RAW_SQL_LIKE_TOOL_NAME}.`,
    );
  }
  const lower = tool.description.toLowerCase();
  for (const phrase of FORBIDDEN_DESCRIPTION_PHRASES) {
    if (lower.includes(phrase)) {
      throw new Error(
        `Tool "${tool.name}" description contains forbidden phrase "${phrase}" (case-insensitive).`,
      );
    }
  }
}

let catalog: ToolCatalog;

beforeAll(() => {
  catalog = new ToolCatalog();
  registerAllTools(catalog);
});

describe("no-raw-sql-tools (D129 P4 hermetic)", () => {
  test("every registered built-in tool passes raw-SQL surface checks", () => {
    const entries = catalog.query({});
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      assertNoRawSqlToolSurface(entry);
    }
  });

  test("deliberate bad tool names are rejected by the same guard", () => {
    expect(() =>
      assertNoRawSqlToolSurface({
        name: "runSql",
        description: "benign description",
      }),
    ).toThrow(/forbidden raw-SQL-like name pattern/);

    expect(() =>
      assertNoRawSqlToolSurface({
        name: "safe_tool_name",
        description: "This tool lets you Run arbitrary SQL against the cluster.",
      }),
    ).toThrow(/forbidden phrase/);
  });
});
