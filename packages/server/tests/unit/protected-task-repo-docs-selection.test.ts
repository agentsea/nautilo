import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import { tasks } from "@nautilo/db";
import {
  openProtectedTaskRepoDocsSelection,
  parseProtectedTaskRepoDocsSelection,
  protectedTaskRepoDocsSelectionProjection,
} from "../../src/routes/protected-task-repo-docs-selection";

describe("protected repo docs selection", () => {
  test("projects only closed operational mode and publication facts", () => {
    const query = drizzle.mock().select({ repo: protectedTaskRepoDocsSelectionProjection() })
      .from(tasks).toSQL();
    expect(query.sql).toContain("'repo_docs'");
    expect(query.sql).toContain("- 'target' - 'instructions'");
    expect(query.sql).toContain("jsonb_build_object");
    expect(query.sql).not.toContain("'target',");
    expect(query.sql).not.toContain("'instructions',");
  });

  test("reconstructs encrypted target and instructions beside admitted lifecycle wrappers", () => {
    const selection = parseProtectedTaskRepoDocsSelection({ mode: "update", publish: "pr" });
    expect(selection).not.toBeNull();
    const opened = openProtectedTaskRepoDocsSelection(selection!, {
      target: "https://example.test/repository.git",
      instructions: "Keep the API examples.",
      preparation: { version: 1, state: "pending", operationId: "prepare" },
    });
    expect(opened).toEqual({
      target: "https://example.test/repository.git",
      instructions: "Keep the API examples.",
      mode: "update",
      publish: "pr",
    });
  });

  test("rejects content in the selector and operational substitution", () => {
    expect(parseProtectedTaskRepoDocsSelection({
      mode: "auto", publish: "branch", target: "/private",
    })).toBeNull();
    expect(openProtectedTaskRepoDocsSelection(
      { mode: "auto", publish: "branch" },
      { target: "repo", mode: "update" },
    )).toBeNull();
  });
});
