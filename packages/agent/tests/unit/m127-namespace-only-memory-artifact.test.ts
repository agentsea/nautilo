/**
 * M127 — Memory + Artifact namespace-only boundary, source-level guard.
 *
 * These tests are belt-and-suspenders next to the ESLint rule
 * `m127-no-agent-id-on-memory-or-artifact` (eslint.config.mjs) and the
 * Drizzle schema (which structurally lacks the column). They open the
 * relevant source files and assert no `memories.agent_id` /
 * `artifacts.agent_id` regression sneaks back in.
 *
 * Pure string read — no DB connection, no embedding model, no
 * trust-context. Runs under `bun run test:unit`.
 */
import { describe, test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "../..");

const FORBIDDEN_DRIZZLE_PATTERNS = [
  /memories\.agentId/,
  /artifacts\.agentId/,
];

const FORBIDDEN_SQL_PATTERNS = [
  // Plain SQL string references to the dropped columns.
  /memories\.agent_id/,
  /artifacts\.agent_id/,
  // `m.agent_id` is the alias the previous memory-store dedup used.
  // Disallow that specific shape too so we don't reintroduce a raw
  // alias-only reference.
  /\bm\.agent_id\b/,
];

async function readSource(relPath: string): Promise<string> {
  return readFile(join(pkgRoot, relPath), "utf8");
}

describe("M127 namespace-only Memory/Artifact boundary (source-level)", () => {
  test("memory-store has no row-level agent_id predicate", async () => {
    const src = await readSource("src/store/memory-store.ts");
    for (const re of FORBIDDEN_DRIZZLE_PATTERNS) {
      expect(src).not.toMatch(re);
    }
    for (const re of FORBIDDEN_SQL_PATTERNS) {
      expect(src).not.toMatch(re);
    }
  });

  test("scope-memory-store INSERT does not write memories.agent_id", async () => {
    const src = await readSource("src/store/scope-memory-store.ts");
    for (const re of FORBIDDEN_DRIZZLE_PATTERNS) {
      expect(src).not.toMatch(re);
    }
    for (const re of FORBIDDEN_SQL_PATTERNS) {
      expect(src).not.toMatch(re);
    }
    // Positive assertion: scope isolation still goes through
    // `memory_scopes` + `agent_scopes` rather than `memories.agent_id`.
    expect(src).toMatch(/memory_scopes/);
  });

  test("agent-scope-store no longer references memories.agent_id", async () => {
    const src = await readSource("src/store/agent-scope-store.ts");
    for (const re of FORBIDDEN_DRIZZLE_PATTERNS) {
      expect(src).not.toMatch(re);
    }
    for (const re of FORBIDDEN_SQL_PATTERNS) {
      expect(src).not.toMatch(re);
    }
  });

  test("artifact-store + share-artifact have no artifacts.agent_id predicate", async () => {
    const srcStore = await readSource("src/tools/file/artifact-store.ts");
    const srcShare = await readSource("src/tools/file/share-artifact.ts");
    for (const re of FORBIDDEN_DRIZZLE_PATTERNS) {
      expect(srcStore).not.toMatch(re);
      expect(srcShare).not.toMatch(re);
    }
    for (const re of FORBIDDEN_SQL_PATTERNS) {
      expect(srcStore).not.toMatch(re);
      expect(srcShare).not.toMatch(re);
    }
  });

  test("WorkspaceArtifactPatchMeta no longer carries agentId", async () => {
    const src = await readSource("src/tools/file/artifact-store.ts");
    // The interface declaration must NOT reintroduce `agentId: string`
    // as a meta field. We look for the interface block explicitly.
    const ifaceMatch = src.match(
      /export interface WorkspaceArtifactPatchMeta[\s\S]*?\n\}/,
    );
    expect(ifaceMatch).not.toBeNull();
    const iface = ifaceMatch?.[0] ?? "";
    expect(iface).not.toMatch(/agentId/);
  });

  test("apply-core no longer stamps meta.agentId on workspace artifact rows", async () => {
    const src = await readSource("src/tools/file/commands/apply-core.ts");
    expect(src).not.toMatch(/\n\s*agentId:[^\n]+\n\s*storageUri:/);
  });

  test("share_memory description reframes as namespace attach", async () => {
    const src = await readSource("src/tools/memory/share-memory.ts");
    // The description must drop "share with another user" framing and
    // adopt exact destination-attachment copy without claiming that unrelated
    // Room membership makes an attachment unnecessary.
    expect(src).toMatch(/additional Namespace/);
    expect(src).toMatch(/exact Memory is already attached/);
    expect(src).not.toMatch(/already share that Room's Namespace/);
  });

  test("share_artifact description reframes as namespace attach", async () => {
    const src = await readSource("src/tools/file/share-artifact.ts");
    expect(src).toMatch(/additional Namespace/);
    expect(src).toMatch(/grants exact access to that Human/);
    expect(src).toMatch(/does not select a broader common Room/);
  });

  test("file_revisions agent_id scoping is preserved (out-of-scope carve-out)", async () => {
    // M127 deliberately leaves `file_revisions.agent_id` alone. The
    // backup/revision modules must still reference it — surface that
    // here as a positive assertion so a future "all agent_id is gone"
    // sweep doesn't accidentally widen.
    const src = await readSource("src/tools/file/backups/record-revision.ts").catch(
      () => "",
    );
    if (src.length > 0) {
      expect(src).toMatch(/agentId|agent_id/);
    }
  });
});
