import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("M261/M274 Artifact ordinary-query boundary", () => {
  test("ordinary readers and writers accept dual-form rows but reject protected-only rows", () => {
    const artifactQueries = readFileSync(
      resolve(import.meta.dir, "../../src/queries/artifacts.ts"), "utf8",
    );
    const mutationQueries = readFileSync(
      resolve(import.meta.dir, "../../src/queries/workspace-document-mutations.ts"),
      "utf8",
    );
    expect(artifactQueries).toContain("Legacy Artifact repository received a protected row");
    expect(mutationQueries).toContain("Workspace mutation repository received a protected Artifact");
    expect(artifactQueries).not.toContain("isNull(artifacts.cryptoObjectId)");
    expect(mutationQueries).not.toContain("isNull(artifacts.cryptoObjectId)");
    for (const source of [artifactQueries, mutationQueries]) {
      expect(source).toContain("isNotNull(artifacts.path)");
      expect(source).toContain("isNotNull(artifacts.mimeType)");
      expect(source).toContain("isNotNull(artifacts.size)");
      expect(source).toContain("isNotNull(artifacts.storageUri)");
    }
    expect((artifactQueries.match(/ordinaryArtifactRowPredicate\(\)/gu) ?? []).length)
      .toBeGreaterThanOrEqual(14);
    expect((mutationQueries.match(/ordinaryArtifactRowPredicate\(\)/gu) ?? []).length)
      .toBeGreaterThanOrEqual(4);
    expect(mutationQueries).not.toContain("row.cryptoObjectId !== null");
  });

  test("ordinary archive and restore retain dual visibility and verified mapping", () => {
    const artifactQueries = readFileSync(
      resolve(import.meta.dir, "../../src/queries/artifacts.ts"), "utf8",
    );
    const artifactSchema = readFileSync(
      resolve(import.meta.dir, "../../src/schema/artifacts.ts"), "utf8",
    );
    const finalizer = readFileSync(
      resolve(
        import.meta.dir,
        "../../scripts/finalize-m274-encryption-transition.ts",
      ),
      "utf8",
    );
    expect(artifactQueries).toContain("export async function markArtifactDeleted");
    expect(artifactQueries).toContain("export async function restoreArtifactRevision");
    expect(artifactQueries).toContain("deletedAt: new Date()");
    expect(artifactQueries).toContain("deletedAt: null");
    expect(artifactSchema).toContain(
      "${table.cryptoMappingState} in ('verified', 'stale')",
    );
    expect(artifactSchema).not.toContain(
      "${table.cryptoLifecycleState} = 'active' and ${table.deletedAt} is null",
    );
    expect(artifactSchema).not.toContain(
      "${table.cryptoLifecycleState} = 'archived' and ${table.deletedAt} is not null",
    );
    expect(finalizer).not.toContain(
      'NEW."deleted_at" IS DISTINCT FROM OLD."deleted_at"',
    );
    expect(finalizer).toContain('NEW."storage_uri" IS DISTINCT FROM OLD."storage_uri"');
  });
});
