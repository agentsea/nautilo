import { rejects } from "node:assert/strict";
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  ARTIFACT_RELOCATION_FILE_PROBE, applyArtifactRelocation, artifactRelocationMutationSql,
  planArtifactRelocation, relocatedSnapshot, relocationPlanSha256, relocationReferences,
  type ArtifactRelocationDeps, type ArtifactRelocationPlan, type StorageSnapshot,
} from "../../src/artifact-relocation.ts";

const hash = createHash("sha256").update("original").digest("hex");
function fixture() {
  const before: StorageSnapshot = {
    identity: { id: "self", instance_id: "fixture", server_instance_id: "f0000000-0000-4000-8000-000000000000", server_binding_generation: 1 },
    artifacts: [{ id: "a0000000-0000-4000-8000-000000000000", storage_uri: "file:///old/artifacts/head", size: 8, revision: 7, path: "doc.md", crypto_object_id: null }],
    message_attachments: [{ id: "b0000000-0000-4000-8000-000000000000", storage_uri: "file:///old/artifacts/attachment", size_bytes: 8 }],
    workspace_document_mutation_entries: [{ id: "c0000000-0000-4000-8000-000000000000", before_storage_uri: "file:///old/artifacts/history", after_storage_uri: "file:///old/artifacts/history", destination_before_storage_uri: "file:///old/artifacts/history", before_size: 8, after_size: 8, destination_before_size: 8, before_sha256: hash, after_sha256: hash, destination_before_sha256: hash, mutation_id: "retained-receipt", before_revision: 6, after_revision: 7 }],
  };
  let current = structuredClone(before);
  const target = { instanceId: "fixture", project: "fixture", serverContainer: "server", databaseContainer: "database", imageId: "image", artifactsRoot: "/new/artifacts" };
  let writes = 0;
  let active: ArtifactRelocationPlan;
  let reverse = false;
  const deps: ArtifactRelocationDeps = {
    target: async () => target,
    files: async (_root, paths) => paths.map(path => ({ path, size: 8, sha256: hash })),
    sourceFiles: async (_root, paths) => ({ bundlePath: "/backup", manifestSha256: "a".repeat(64), archiveSha256: "b".repeat(64), files: paths.map(path => ({ path, size: 8, sha256: hash })) }),
    sql: async input => {
      if (input.includes("DO '")) { writes++; current = reverse ? structuredClone(before) : relocatedSnapshot(active); return ""; }
      return JSON.stringify(current);
    },
  };
  return { before, deps, target, writes: () => writes, mutate: (fn: (state: StorageSnapshot) => void) => fn(current), activate: (plan: ArtifactRelocationPlan, rollback = false) => { active = plan; reverse = rollback; } };
}

describe("physical artifact relocation", () => {
  test("plans all five columns, proves bytes, preserves logical/history state, and supports exact retry/rollback", async () => {
    const f = fixture(); const plan = await planArtifactRelocation("/old/artifacts", f.deps); f.activate(plan);
    expect(f.writes()).toBe(0); expect(relocationReferences(plan)).toHaveLength(5); expect(plan.files).toHaveLength(3);
    const digest = relocationPlanSha256(plan);
    expect((await applyArtifactRelocation(plan, digest, f.deps)).outcome).toBe("applied");
    expect((await applyArtifactRelocation(plan, digest, f.deps)).outcome).toBe("already-applied");
    expect(f.writes()).toBe(1); expect(plan.before).toEqual(f.before);
    const after = relocatedSnapshot(plan);
    expect(after.artifacts[0]!["revision"]).toBe(7); expect(after.workspace_document_mutation_entries[0]!["mutation_id"]).toBe("retained-receipt");
    f.activate(plan, true);
    expect((await applyArtifactRelocation(plan, digest, f.deps, true)).outcome).toBe("rolled-back");
    expect((await applyArtifactRelocation(plan, digest, f.deps, true)).outcome).toBe("already-rolled-back");
    expect(f.writes()).toBe(2);
  });
  test("refuses wrong identity, root, history hash, missing files, metadata drift and tampered plans before writes", async () => {
    for (const failure of ["identity", "target", "hash", "missing", "metadata", "digest", "bytes", "unsafe", "encrypted"]) {
      const f = fixture(); const plan = await planArtifactRelocation("/old/artifacts", f.deps); f.activate(plan);
      if (failure === "identity") f.target.instanceId = "other";
      if (failure === "target") f.target.imageId = "changed";
      if (failure === "metadata") f.mutate(s => { s.artifacts[0]!["revision"] = 8; });
      if (failure === "digest") plan.sourceRoot = "/other";
      if (failure === "hash") f.deps.files = async (_root, paths) => paths.map(path => ({ path, size: 8, sha256: "0".repeat(64) }));
      if (failure === "missing") f.deps.files = async () => [];
      if (failure === "bytes") f.deps.files = async (_root, paths) => paths.map(path => ({ path, size: 9, sha256: hash }));
      if (failure === "unsafe") plan.before.artifacts[0]!["storage_uri"] = "file:///old/artifacts/../escape";
      if (failure === "encrypted") plan.before.artifacts[0]!["crypto_object_id"] = "encrypted";
      await rejects(applyArtifactRelocation(plan, failure === "digest" ? "0".repeat(64) : relocationPlanSha256(plan), f.deps));
      expect(f.writes()).toBe(0);
    }
  });
  test("equal-size corruption without a history hash and missing original rollback bytes are rejected", async () => {
    const f = fixture();
    f.deps.files = async (_root, paths) => paths.map(path => ({ path, size: 8, sha256: path.endsWith('/head') ? '0'.repeat(64) : hash }));
    await rejects(planArtifactRelocation('/old/artifacts', f.deps), /verified original backup/);
    expect(f.writes()).toBe(0);
    f.deps.files = async (_root, paths) => paths.map(path => ({ path, size: 8, sha256: hash }));
    const plan = await planArtifactRelocation('/old/artifacts', f.deps); f.activate(plan);
    await applyArtifactRelocation(plan, relocationPlanSha256(plan), f.deps);
    f.activate(plan, true);
    f.deps.files = async (root, paths) => { if (root === '/old/artifacts') throw new Error('old root absent'); return paths.map(path => ({ path, size: 8, sha256: hash })); };
    await rejects(applyArtifactRelocation(plan, relocationPlanSha256(plan), f.deps, true), /old root absent/);
    expect(f.writes()).toBe(1);
  });
  test("segment boundaries preserve unrelated paths; SQL atomically compares complete state and escapes dollar-quote payloads", async () => {
    const f = fixture(); const plan = await planArtifactRelocation("/old/artifacts", f.deps);
    plan.before.artifacts.push({ id: "d0000000-0000-4000-8000-000000000000", storage_uri: "file:///old/artifacts-other/keep", size: 8, path: "quote' $relocation$ ; COMMIT; --" });
    expect(relocationReferences(plan)).toHaveLength(5);
    expect(relocatedSnapshot(plan).artifacts[1]).toEqual(plan.before.artifacts[1]);
    const sql = artifactRelocationMutationSql(plan);
    expect(sql).toContain("SHARE ROW EXCLUSIVE MODE NOWAIT"); expect(sql).toContain("IS DISTINCT FROM");
    expect(sql).toContain("DO 'BEGIN"); expect(sql).not.toContain("DO $relocation$");
    expect(sql).not.toContain('SET "revision"'); expect(sql).not.toContain('SET "after_sha256"');
  });
  test("real unprivileged byte probe hashes nested files and rejects symlinks/outside/config drift without changing bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "artifact-relocation-"));
    try {
      const root = join(await realpath(directory), "artifacts"); await mkdir(join(root, "history"), { recursive: true });
      const file = join(root, "history", "content"); await writeFile(file, "original");
      await symlink(file, join(root, "link"));
      const run = async (paths: string[], configured = root) => {
        const child = Bun.spawn([process.execPath, "-e", ARTIFACT_RELOCATION_FILE_PROBE], { env: { ...process.env, NAUTILO_ARTIFACTS_ROOT: configured }, stdin: new TextEncoder().encode(JSON.stringify({ root, paths })), stdout: "pipe", stderr: "pipe" });
        const stdout = await new Response(child.stdout).text(); const stderr = await new Response(child.stderr).text();
        return { code: await child.exited, stdout, stderr };
      };
      const result = await run([file]); expect(result.code, result.stderr).toBe(0); expect(JSON.parse(result.stdout)).toEqual([{ path: file, size: 8, sha256: hash }]);
      for (const paths of [[join(root, "link")], [join(directory, "outside")], [join(root, "missing")]]) expect((await run(paths)).code).not.toBe(0);
      expect((await run([file], directory)).code).not.toBe(0);
      expect(await readFile(file, "utf8")).toBe("original");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
