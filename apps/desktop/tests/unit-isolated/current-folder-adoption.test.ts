import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCurrentFolderAdoptionAuthority } from "../../electron/current-folder-adoption";

const cleanup: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "current-folder-adoption-"));
  cleanup.push(root);
  return root;
}

afterEach(() => {
  while (cleanup.length > 0) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

function fixture() {
  const root = tempRoot();
  const workspace = join(root, "workspace");
  const current = join(root, "current");
  const target = join(workspace, "projects", "nautilo");
  mkdirSync(target, { recursive: true });
  mkdirSync(current);
  let selection = { path: current as string | null, revision: 3 };
  let committed: string | null = null;
  const authority = createCurrentFolderAdoptionAuthority({
    getWorkspaceRoot: () => ({ path: workspace, revision: 1 }),
    getCurrentFolderRoot: () => selection.path === null ? null : { path: selection.path, revision: selection.revision },
    getCurrentFolderSelection: () => selection,
    checkCurrentFolderSanity: () => ({ ok: true }),
    protectedPathPolicy: { check: (candidate) => ({ allowed: !candidate.includes("protected") }) },
    commitCurrentFolderPath: (candidate) => {
      committed = candidate;
      selection = { path: candidate, revision: selection.revision + 1 };
    },
    createPreparationId: () => "opaque-preparation",
  });
  return {
    authority,
    workspace,
    current,
    target,
    get committed() { return committed; },
    changeSelection: (next: string | null) => {
      selection = { path: next, revision: selection.revision + 1 };
    },
  };
}

describe("Current Folder agent adoption authority", () => {
  test("prepares a contained regular directory without returning a host path, then consumes it on approved commit", async () => {
    const f = fixture();
    const prepared = await f.authority.prepare({ sourceRootKind: "workspace", relativePath: "projects/nautilo" });
    expect(prepared).toMatchObject({
      ok: true,
      preparationId: "opaque-preparation",
      label: "nautilo",
      sourceRootKind: "workspace",
      currentFolderRevision: 3,
    });
    expect(JSON.stringify(prepared)).not.toContain(f.workspace);
    expect(JSON.stringify(prepared)).not.toContain(f.target);
    if (!prepared.ok) throw new Error("preparation failed");

    const committed = await f.authority.commit({ preparationId: prepared.preparationId, approved: true });
    expect(committed).toEqual({ ok: true, label: "nautilo", currentFolderRevision: 4 });
    expect(f.committed).toBe(realpathSync(f.target));
    await expect(f.authority.commit({ preparationId: prepared.preparationId, approved: true })).resolves.toMatchObject({
      ok: false,
      code: "preparation_unknown",
    });
  });

  test.each([
    ["", "empty"],
    [".", "dot"],
    ["projects//nautilo", "empty segment"],
    ["projects/../nautilo", "traversal"],
    ["/etc", "absolute"],
    ["C:\\Windows", "windows absolute"],
    ["projects\0nautilo", "NUL"],
  ])("fails closed for %s (%s)", async (relativePath) => {
    const f = fixture();
    await expect(f.authority.prepare({ sourceRootKind: "workspace", relativePath })).resolves.toMatchObject({
      ok: false,
      code: "invalid_request",
    });
    expect(f.committed).toBeNull();
  });

  test("refuses symlink, missing, non-directory, and protected targets", async () => {
    const f = fixture();
    mkdirSync(join(f.workspace, "projects", "file-parent"), { recursive: true });
    writeFileSync(join(f.workspace, "projects", "file-parent", "not-a-folder"), "x");
    mkdirSync(join(f.workspace, "protected"));
    symlinkSync(join(f.workspace, "projects", "nautilo"), join(f.workspace, "projects", "linked"));

    await expect(f.authority.prepare({ sourceRootKind: "workspace", relativePath: "projects/linked" })).resolves.toMatchObject({ ok: false, code: "target_symlink" });
    await expect(f.authority.prepare({ sourceRootKind: "workspace", relativePath: "projects/missing" })).resolves.toMatchObject({ ok: false, code: "target_missing" });
    await expect(f.authority.prepare({ sourceRootKind: "workspace", relativePath: "projects/file-parent/not-a-folder" })).resolves.toMatchObject({ ok: false, code: "target_not_directory" });
    await expect(f.authority.prepare({ sourceRootKind: "workspace", relativePath: "protected" })).resolves.toMatchObject({ ok: false, code: "target_protected" });
    expect(f.committed).toBeNull();
  });

  test("consumes a denial and refuses Current Folder and target races without changing the prior folder", async () => {
    const f = fixture();
    const denied = await f.authority.prepare({ sourceRootKind: "workspace", relativePath: "projects/nautilo" });
    if (!denied.ok) throw new Error("preparation failed");
    await expect(f.authority.commit({ preparationId: denied.preparationId, approved: false })).resolves.toMatchObject({
      ok: false,
      code: "approval_required",
    });
    await expect(f.authority.commit({ preparationId: denied.preparationId, approved: true })).resolves.toMatchObject({
      ok: false,
      code: "preparation_unknown",
    });

    const raced = await f.authority.prepare({ sourceRootKind: "workspace", relativePath: "projects/nautilo" });
    if (!raced.ok) throw new Error("preparation failed");
    f.changeSelection(null);
    await expect(f.authority.commit({ preparationId: raced.preparationId, approved: true })).resolves.toMatchObject({
      ok: false,
      code: "current_folder_stale",
    });
    expect(f.committed).toBeNull();

    const targetRaced = await f.authority.prepare({ sourceRootKind: "workspace", relativePath: "projects/nautilo" });
    if (!targetRaced.ok) throw new Error("preparation failed");
    rmSync(f.target, { recursive: true });
    mkdirSync(f.target);
    await expect(f.authority.commit({ preparationId: targetRaced.preparationId, approved: true })).resolves.toMatchObject({
      ok: false,
      code: "target_stale",
    });
    expect(f.committed).toBeNull();
  });

  test("fails closed when a prepared target disappears, becomes a symlink, or becomes protected", async () => {
    const f = fixture();
    const missing = await f.authority.prepare({ sourceRootKind: "workspace", relativePath: "projects/nautilo" });
    if (!missing.ok) throw new Error("preparation failed");
    rmSync(f.target, { recursive: true });
    await expect(f.authority.commit({ preparationId: missing.preparationId, approved: true })).resolves.toMatchObject({
      ok: false,
      code: "target_missing",
    });

    mkdirSync(f.target);
    const symlinked = await f.authority.prepare({ sourceRootKind: "workspace", relativePath: "projects/nautilo" });
    if (!symlinked.ok) throw new Error("preparation failed");
    rmSync(f.target, { recursive: true });
    symlinkSync(f.current, f.target);
    await expect(f.authority.commit({ preparationId: symlinked.preparationId, approved: true })).resolves.toMatchObject({
      ok: false,
      code: "target_symlink",
    });

    rmSync(f.target, { force: true });
    mkdirSync(f.target);
    let protectedTarget = false;
    const protectedAfterPrepare = createCurrentFolderAdoptionAuthority({
      getWorkspaceRoot: () => ({ path: f.workspace, revision: 1 }),
      getCurrentFolderRoot: () => ({ path: f.current, revision: 3 }),
      getCurrentFolderSelection: () => ({ path: f.current, revision: 3 }),
      checkCurrentFolderSanity: () => ({ ok: true }),
      protectedPathPolicy: { check: () => ({ allowed: !protectedTarget }) },
      commitCurrentFolderPath: () => undefined,
      createPreparationId: () => "protected-after-prepare",
    });
    const protectedPreparation = await protectedAfterPrepare.prepare({
      sourceRootKind: "workspace",
      relativePath: "projects/nautilo",
    });
    if (!protectedPreparation.ok) throw new Error("preparation failed");
    protectedTarget = true;
    const protectedResult = await protectedAfterPrepare.commit({
      preparationId: protectedPreparation.preparationId,
      approved: true,
    });
    expect(protectedResult).toMatchObject({ ok: false, code: "target_protected" });
    expect(JSON.stringify(protectedResult)).not.toContain(f.workspace);
    expect(f.committed).toBeNull();
  });

  test("consumes a prepared target when the source identity changes", async () => {
    const f = fixture();
    const prepared = await f.authority.prepare({ sourceRootKind: "workspace", relativePath: "projects/nautilo" });
    if (!prepared.ok) throw new Error("preparation failed");

    rmSync(f.workspace, { recursive: true });
    mkdirSync(f.target, { recursive: true });

    const result = await f.authority.commit({ preparationId: prepared.preparationId, approved: true });
    expect(result).toMatchObject({ ok: false, code: "source_stale" });
    expect(JSON.stringify(result)).not.toContain(f.workspace);
    expect(f.committed).toBeNull();
    await expect(f.authority.commit({ preparationId: prepared.preparationId, approved: true })).resolves.toMatchObject({
      ok: false,
      code: "preparation_unknown",
    });
  });

  test("expires and bounds in-memory preparations", async () => {
    let clock = 1_000;
    const f = fixture();
    const expiring = createCurrentFolderAdoptionAuthority({
      getWorkspaceRoot: () => ({ path: f.workspace, revision: 1 }),
      getCurrentFolderRoot: () => ({ path: f.current, revision: 3 }),
      getCurrentFolderSelection: () => ({ path: f.current, revision: 3 }),
      checkCurrentFolderSanity: () => ({ ok: true }),
      protectedPathPolicy: { check: () => ({ allowed: true }) },
      commitCurrentFolderPath: () => undefined,
      now: () => clock,
      preparationTtlMs: 10,
      maxPreparations: 1,
      createPreparationId: () => `opaque-${clock}`,
    });
    const prepared = await expiring.prepare({ sourceRootKind: "workspace", relativePath: "projects/nautilo" });
    if (!prepared.ok) throw new Error("preparation failed");
    await expect(expiring.prepare({ sourceRootKind: "workspace", relativePath: "projects/nautilo" })).resolves.toMatchObject({
      ok: false,
      code: "preparation_unavailable",
    });
    clock += 11;
    await expect(expiring.commit({ preparationId: prepared.preparationId, approved: true })).resolves.toMatchObject({
      ok: false,
      code: "preparation_expired",
    });
  });
});
