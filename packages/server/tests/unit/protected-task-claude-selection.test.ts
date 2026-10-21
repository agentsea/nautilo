import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { CLAUDE_EXECUTION_MAX_TEXT_BYTES } from "@nautilo/relay";
import {
  parseProtectedTaskClaudeSelection,
  protectedTaskClaudeSelectionProjection,
  sameProtectedTaskClaudeSelection,
} from "../../src/routes/protected-task-claude-selection";

const execution = {
  version: 1, harnessId: "claude-code", source: "genie",
  profileRef: "profile-1", catalogModelId: "claude-sonnet", selectedModel: "claude-sonnet-4",
};

describe("protected Claude selection", () => {
  test("returns a frozen closed operational projection", () => {
    const parsed = parseProtectedTaskClaudeSelection(execution);
    expect(parsed).toEqual({ profileRef: execution.profileRef,
      catalogModelId: execution.catalogModelId, selectedModel: execution.selectedModel });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(sameProtectedTaskClaudeSelection(parsed, parsed!)).toBe(true);
    for (const key of ["profileRef", "catalogModelId", "selectedModel"] as const) {
      expect(sameProtectedTaskClaudeSelection({ ...parsed!, [key]: "substituted" }, parsed!)).toBe(false);
    }
    expect(sameProtectedTaskClaudeSelection(null, parsed!)).toBe(false);
    expect(sameProtectedTaskClaudeSelection(undefined, parsed!)).toBe(false);
  });

  test("rejects unclosed, wrong-provider and malformed metadata", () => {
    for (const value of [null, [], "claude", 1, {},
      { ...execution, version: 2 }, { ...execution, source: "human_api" },
      { ...execution, harnessId: "codex" }, { ...execution, workingDirectory: "/private/work" },
      { ...execution, prompt: "sensitive" }, { ...execution, profileRef: "" },
      { ...execution, catalogModelId: null }, { ...execution, selectedModel: [] },
      { ...execution, selectedModel: "x".repeat(CLAUDE_EXECUTION_MAX_TEXT_BYTES + 1) },
    ]) expect(parseProtectedTaskClaudeSelection(value)).toBeNull();
  });

  test("SQL validates scalar routing fields before reconstructing the closed execution", () => {
    const projection = protectedTaskClaudeSelectionProjection();
    const query = new PgDialect().sqlToQuery(projection.sql);
    expect(projection.fieldAlias).toBe("claude_execution_selection");
    expect(query.params).toEqual([
      CLAUDE_EXECUTION_MAX_TEXT_BYTES,
      CLAUDE_EXECUTION_MAX_TEXT_BYTES,
      CLAUDE_EXECUTION_MAX_TEXT_BYTES,
    ]);
    expect(query.sql).toContain("when jsonb_typeof(\"tasks\".\"metadata\") = 'object'");
    expect(query.sql).toContain("jsonb_typeof(\"tasks\".\"metadata\"->'execution') = 'object'");
    expect(query.sql).toContain("then case");
    expect(query.sql).toContain("- 'profileRef' - 'catalogModelId' - 'selectedModel'");
    expect(query.sql).toContain("jsonb_typeof(\"tasks\".\"metadata\"->'execution'->'profileRef') = 'string'");
    expect(query.sql).toContain("octet_length(\"tasks\".\"metadata\"->'execution'->>'selectedModel') between 1 and $3");
    expect(query.sql).toContain("then jsonb_build_object(");
    expect(query.sql).toContain("'profileRef', \"tasks\".\"metadata\"->'execution'->>'profileRef'");
    expect(query.sql).not.toContain("then \"tasks\".\"metadata\"->'execution'");
    expect(query.sql).not.toContain("then \"tasks\".\"metadata\"\n");
  });
});
