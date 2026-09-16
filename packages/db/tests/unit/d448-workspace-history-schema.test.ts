/**
 * D448 schema/query contract tests. These deliberately inspect generated
 * migration metadata without opening Postgres.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  findLatestWorkspaceRevisionForLogicalPath,
  withWorkspaceFileRevisionMetadata,
} from "../../src/queries/file-revisions";
import type { DirectDatabase } from "../../src/config/direct-database";
import {
  FILE_REVISION_KIND,
  FILE_REVISION_OPERATION,
  type FileRevision,
  type NewFileRevision,
} from "../../src/schema/file-revisions";

const DB_ROOT = resolve(import.meta.dirname, "../..");
const MIGRATIONS = resolve(DB_ROOT, "src/migrations");
const SCHEMA = readFileSync(
  resolve(DB_ROOT, "src/schema/file-revisions.ts"),
  "utf8",
);
const SQL = readFileSync(
  resolve(MIGRATIONS, "0109_d448_workspace_mutation_history.sql"),
  "utf8",
);

describe("D448 Workspace mutation history migration", () => {
  test("uses the Workspace logical-path history query only through agent-scoped rows", async () => {
    const row = { id: "revision", agentId: "agent", workspaceOperationId: "operation" } as unknown as FileRevision;
    const calls: string[] = [];
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () => {
            calls.push("where");
            return {
              orderBy: () => ({
                limit: async () => [row],
              }),
            };
          },
        }),
      }),
    } as unknown as DirectDatabase;
    const result = await findLatestWorkspaceRevisionForLogicalPath(fakeDb, {
      agentId: "agent",
      ownerId: "owner",
      logicalPath: "gone.txt",
    });
    expect(result).toBe(row);
    expect(calls).toEqual(["where"]);
  });

  test("keeps ordinary revisions nullable while adding full Workspace provenance", () => {
    for (const column of [
      "workspace_artifact_id",
      "workspace_path_before",
      "workspace_path_after",
      "workspace_operation_id",
    ]) {
      expect(SQL).toContain(`ADD COLUMN "${column}"`);
      expect(SQL).not.toMatch(
        new RegExp(`ADD COLUMN "${column}"[^;]*NOT NULL`, "i"),
      );
    }
    expect(SCHEMA).toContain('workspaceArtifactId: uuid("workspace_artifact_id")');
  });

  test("preserves the operation provenance index", () => {
    expect(SQL).toContain('"idx_file_revisions_workspace_operation"');
    expect(SQL).toContain('("agent_id","workspace_operation_id")');
  });

  test("0109 through 0112 remain recorded before the D462, M219, D480, and D476 tail", () => {
    const journal = JSON.parse(
      readFileSync(resolve(MIGRATIONS, "meta/_journal.json"), "utf8"),
    ) as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries.some(
      (entry) =>
        entry.idx === 109 &&
        entry.tag === "0109_d448_workspace_mutation_history",
    )).toBe(true);
    expect(journal.entries.some(
      (entry) =>
        entry.idx === 111 &&
        entry.tag === "0111_d448_workspace_document_mutation_history_metadata",
    )).toBe(true);
    expect(journal.entries.some(
      (entry) =>
        entry.idx === 112 &&
        entry.tag === "0112_d448_workspace_history_agent_grants",
    )).toBe(true);
    expect(journal.entries.find((entry) => entry.idx === 113)).toMatchObject({
      idx: 113,
      tag: "0113_d462_model_control_selection",
    });
    expect(journal.entries.find((entry) => entry.idx === 119)).toMatchObject({
      idx: 119,
      tag: "0119_m219_stenographer_model_prior_context",
    });
    expect(
      journal.entries
        .filter(({ idx }) => idx >= 120 && idx <= 127)
        .map(({ idx, tag }) => ({ idx, tag })),
    )
      .toEqual([
        { idx: 120, tag: "0120_d480_relay_device_grouping" },
        { idx: 121, tag: "0121_d476_projection_creation_key" },
        { idx: 122, tag: "0122_d476_room_name_lookup_initial" },
        { idx: 123, tag: "0123_d476_room_name_lookup_indexes" },
        { idx: 124, tag: "0124_solid_chameleon" },
        { idx: 125, tag: "0125_purple_cerise" },
        { idx: 126, tag: "0126_conscious_ricochet" },
        { idx: 127, tag: "0127_notification_intelligence_facts" },
      ]);

    const compatibilitySnapshot = JSON.parse(
      readFileSync(resolve(MIGRATIONS, "meta/0109_snapshot.json"), "utf8"),
    ) as {
      tables: Record<string, { columns: Record<string, { type: string; notNull: boolean }> }>;
    };
    expect(compatibilitySnapshot.tables["public.file_revisions"]?.columns["workspace_artifact_id"])
      .toMatchObject({ type: "uuid", notNull: false });

    const canonicalSnapshot = JSON.parse(
      readFileSync(resolve(MIGRATIONS, "meta/0111_snapshot.json"), "utf8"),
    ) as { tables: Record<string, unknown> };
    expect(canonicalSnapshot.tables["public.workspace_document_mutations"]).toBeDefined();
  });

  test("adds validated Workspace metadata to the typed revision insert row", () => {
    const row: NewFileRevision = {
      ownerId: "11111111-1111-4111-8111-111111111111",
      agentId: "22222222-2222-4222-8222-222222222222",
      turnId: "turn-d448",
      absolutePath: "/artifact-store/a",
      preSha256: "a".repeat(64),
      preSize: 1,
      kind: FILE_REVISION_KIND.DIFF,
      diffText: "diff",
      operation: FILE_REVISION_OPERATION.WRITE,
    };
    expect(
      withWorkspaceFileRevisionMetadata(row, {
        workspaceArtifactId: "33333333-3333-4333-8333-333333333333",
        workspacePathBefore: "src/old.ts",
        workspacePathAfter: "src/new.ts",
        workspaceOperationId: "44444444-4444-4444-8444-444444444444",
      }),
    ).toMatchObject({
      workspacePathBefore: "src/old.ts",
      workspacePathAfter: "src/new.ts",
    });
    expect(() =>
      withWorkspaceFileRevisionMetadata(row, {
        workspaceArtifactId: null,
        workspacePathBefore: null,
        workspacePathAfter: "src/new.ts",
        workspaceOperationId: "",
      }),
    ).toThrow("workspaceOperationId");
  });

  test("documents group identity without an ordering claim", () => {
    expect(SCHEMA).toContain("one logical/native operation group");
    expect(SCHEMA).toContain("overwrite-move may therefore create two linked revision rows");
    expect(SCHEMA).toContain("Ordering across groups remains intentionally unspecified");
  });
});
