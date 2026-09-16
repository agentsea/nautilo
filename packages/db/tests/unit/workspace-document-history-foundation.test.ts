import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DB_ROOT = resolve(import.meta.dirname, "../..");
const readDbSource = (path: string) =>
  readFileSync(resolve(DB_ROOT, path), "utf8");

const SCHEMA = readDbSource("src/schema/workspace-document-mutations.ts");
const MIGRATION = readDbSource(
  "src/migrations/0111_d448_workspace_document_mutation_history_metadata.sql",
);
const SNAPSHOT = JSON.parse(
  readDbSource("src/migrations/meta/0111_snapshot.json"),
) as {
  tables: Record<string, {
    columns: Record<string, unknown>;
    indexes: Record<string, unknown>;
    foreignKeys: Record<string, unknown>;
    checkConstraints: Record<string, unknown>;
  }>;
};
const HISTORY_QUERY = readDbSource(
  "src/queries/workspace-document-history.ts",
);
const RECEIPT_QUERY = readDbSource(
  "src/queries/workspace-document-mutations.ts",
);
const AGENT_GRANTS = readDbSource(
  "src/migrations/0112_d448_workspace_history_agent_grants.sql",
);

describe("D448 canonical Workspace history DB foundation", () => {
  test("keeps migration metadata aligned with group and entry history truth", () => {
    const mutation =
      SNAPSHOT.tables["public.workspace_document_mutations"]!;
    const entry =
      SNAPSHOT.tables["public.workspace_document_mutation_entries"]!;

    for (const column of [
      "turn_id",
      "pinned",
      "accessed_at",
    ]) {
      expect(mutation.columns[column]).toBeDefined();
      expect(MIGRATION).toContain(`"${column}"`);
    }
    for (const column of [
      "history_operation",
      "history_eligible",
      "restore_from_entry_id",
    ]) {
      expect(entry.columns[column]).toBeDefined();
      expect(MIGRATION).toContain(`"${column}"`);
    }

    expect(entry.foreignKeys)
      .toHaveProperty("workspace_document_mutation_entries_restore_from_entry_fk");
    expect(entry.checkConstraints)
      .toHaveProperty("workspace_document_mutation_entries_history_operation_check");
    expect(entry.indexes)
      .toHaveProperty("idx_workspace_document_mutation_entries_redo");
    expect(SCHEMA).toContain('.onDelete("set null")');
  });

  test("provides every scoped canonical history operation without a legacy fallback", () => {
    for (const exportedQuery of [
      "findOwnedWorkspaceHistoryByRevisionId",
      "findLatestEligibleWorkspaceHistory",
      "listWorkspaceHistoryForTurn",
      "findLatestWorkspaceRedoEligibleHistory",
      "listWorkspaceDocumentHistory",
      "setOwnedWorkspaceHistoryGroupPinned",
      "touchOwnedWorkspaceHistoryGroup",
      "findRecentWorkspaceHumanCheckpoint",
      "findLatestDeletedWorkspaceArtifactHistory",
    ]) {
      expect(HISTORY_QUERY).toContain(
        `export async function ${exportedQuery}`,
      );
    }
    expect(HISTORY_QUERY).toContain(
      "eq(workspaceDocumentMutations.ownerId, scope.ownerId)",
    );
    expect(HISTORY_QUERY).toContain(
      "eq(workspaceDocumentMutations.agentId, scope.agentId)",
    );
    expect(HISTORY_QUERY).not.toContain("fileRevisions");
    expect(HISTORY_QUERY).not.toMatch(
      /from\s+["'][^"']*file-revisions[^"']*["']/,
    );
  });

  test("grants the agent runtime only the canonical history read and pin surface", () => {
    for (const table of [
      "workspace_document_mutations",
      "workspace_document_mutation_entries",
      "workspace_document_mutation_entry_identities",
    ]) {
      expect(AGENT_GRANTS).toContain(`"${table}"`);
    }
    expect(AGENT_GRANTS).toContain("GRANT SELECT ON TABLE");
    expect(AGENT_GRANTS).toContain('GRANT UPDATE ("pinned", "accessed_at")');
    expect(AGENT_GRANTS).not.toContain("INSERT");
    expect(AGENT_GRANTS).not.toContain("DELETE");
  });

  test("has no hidden list ceiling or physical payload-pruning machinery", () => {
    const listStart = HISTORY_QUERY.indexOf(
      "export async function listWorkspaceDocumentHistory",
    );
    const listEnd = HISTORY_QUERY.indexOf(
      "function ownedMutationIdForRevision",
      listStart,
    );
    const listBody = HISTORY_QUERY.slice(listStart, listEnd);
    expect(listBody).toContain("assertLimit(input.limit)");
    expect(listBody).toContain("query.limit(input.limit)");
    expect(listBody).not.toMatch(/\.limit\(\d+/);

    for (const source of [SCHEMA, MIGRATION, HISTORY_QUERY]) {
      expect(source).not.toContain("historyPruned");
      expect(source).not.toContain("history_pruned");
      expect(source).not.toContain("PayloadPrune");
      expect(source).not.toContain("GroupPruned");
    }
    const mutation =
      SNAPSHOT.tables["public.workspace_document_mutations"]!;
    expect(mutation.columns).not.toHaveProperty("history_pruned_at");
    expect(mutation.indexes)
      .not.toHaveProperty("idx_workspace_document_mutations_retention");
  });

  test("orders canonical history totally before applying a cutoff", () => {
    const listStart = HISTORY_QUERY.indexOf(
      "export async function listWorkspaceDocumentHistory",
    );
    const listEnd = HISTORY_QUERY.indexOf(
      "function ownedMutationIdForRevision",
      listStart,
    );
    const listSource = HISTORY_QUERY.slice(listStart, listEnd);
    const createdAt = listSource.indexOf(
      "desc(workspaceDocumentMutations.createdAt)",
    );
    const mutationId = listSource.indexOf(
      "desc(workspaceDocumentMutations.id)",
    );
    const sequence = listSource.indexOf(
      "desc(workspaceDocumentMutationEntries.sequence)",
    );
    const entryId = listSource.indexOf(
      "desc(workspaceDocumentMutationEntries.id)",
    );
    const limit = listSource.indexOf(".limit(input.limit)");
    expect(createdAt).toBeGreaterThan(-1);
    expect(mutationId).toBeGreaterThan(createdAt);
    expect(sequence).toBeGreaterThan(mutationId);
    expect(entryId).toBeGreaterThan(sequence);
    expect(limit).toBeGreaterThan(entryId);
  });

  test("keeps existing producers compatible while persisting explicit history semantics", () => {
    expect(RECEIPT_QUERY).toContain("readonly historyOperation?: string");
    expect(RECEIPT_QUERY).toContain("readonly historyEligible?: boolean");
    expect(RECEIPT_QUERY).toContain("readonly restoreFromEntryId?: string | null");
    expect(RECEIPT_QUERY).toContain(
      "historyOperation: historyOperation ?? input.lane",
    );
    expect(RECEIPT_QUERY).toContain(
      'historyEligible ?? (input.actorKind === "agent" || entry.checkpoint)',
    );
    expect(RECEIPT_QUERY).toContain("pinned: input.pinned");
    expect(RECEIPT_QUERY).toContain("turnId: input.turnId");
  });
});
