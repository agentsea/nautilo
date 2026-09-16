import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const FILE_ROOT = resolve(import.meta.dirname, "../../src/tools/file");

function source(relativePath: string): string {
  return readFileSync(resolve(FILE_ROOT, relativePath), "utf8");
}

describe("D448 legacy file mutation cleanup guards", () => {
  test("superseded local-server structural and history modules stay deleted", () => {
    for (const relativePath of [
      "commands/move.ts",
      "commands/copy.ts",
      "commands/delete.ts",
      "commands/undo.ts",
      "commands/redo.ts",
      "commands/undo-turn.ts",
      "workspace-history-restore.ts",
      "backups/restore.ts",
    ]) {
      expect(existsSync(resolve(FILE_ROOT, relativePath))).toBe(false);
    }
  });

  test("direct dispatch cannot re-import legacy mutation handlers", () => {
    const dispatch = source("dispatch.ts");
    for (const forbidden of [
      "./commands/move",
      "./commands/copy",
      "./commands/delete",
      "./commands/undo",
      "./commands/redo",
      "handleMove(",
      "handleCopy(",
      "handleDelete(",
      "handleUndo(",
      "handleRedo(",
    ]) {
      expect(dispatch).not.toContain(forbidden);
    }
    expect(dispatch).toContain("local_relay_required");
    expect(dispatch).toContain("isMutatingLocalFileCommand");
  });

  test("the retained content/importer path has no structural apply branch", () => {
    const shared = source("commands/_shared.ts");
    const applyCore = source("commands/apply-core.ts");
    expect(shared).not.toContain("applyStructuralPatch");
    expect(shared).not.toContain("buildStructuralPatchParts");
    expect(applyCore).not.toContain("if (patch.structural)");
    expect(applyCore).not.toContain("function applyDelete");
    expect(applyCore).not.toContain("function applyMove");
    expect(applyCore).not.toContain("function applyCopy");
  });

  test("legacy artifact row facade remains create/update only", () => {
    const artifactStore = source("artifact-store.ts");
    expect(artifactStore).toContain('mode: "create" | "update"');
    expect(artifactStore).not.toContain('case "delete"');
    expect(artifactStore).not.toContain('case "logical_move"');
    expect(artifactStore).not.toContain('case "restore"');
  });

  test("the backup barrel no longer exports a server-side restore mutation API", () => {
    const backups = source("backups/index.ts");
    expect(backups).not.toContain("restoreRevisionBytes");
    expect(backups).not.toContain("findLatestRedoEligibleForPath");
    expect(backups).not.toContain("RevisionApplyError");
  });
});
