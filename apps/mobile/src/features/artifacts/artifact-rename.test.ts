import { ApiError, ArtifactWriteRequiredError, type ArtifactDto } from "@nautilo/api-client/browser";
import { describe, expect, test } from "bun:test";

import { onAuthDead } from "@/lib/auth-events";
import { ArtifactRenameCoordinator, renamePathFromBasename } from "./artifact-rename";

const artifact: ArtifactDto = { id: "row", artifactId: "stable", path: "folder/old.md", mimeType: "text/markdown", size: 4, revision: 1, updatedAt: "now", createdAt: "then", namespaceIds: [], canWrite: true };

describe("artifact rename", () => {
  test("preserves exact parent and only accepts a nonempty basename", () => {
    expect(renamePathFromBasename("a//parent/old.md", "new.md")).toEqual({ ok: true, path: "a//parent/new.md" });
    expect(renamePathFromBasename(artifact.path, " spaced ")).toEqual({ ok: true, path: "folder/spaced" });
    for (const name of ["", "   ", ".", "..", "nested/name", "nested\\name", "bad\nname"]) expect(renamePathFromBasename(artifact.path, name)).toMatchObject({ ok: false });
    expect(renamePathFromBasename(artifact.path, "old.md")).toEqual({ ok: false, reason: "unchanged" });
  });

  test("single-flights aggregate authority without retaining a selected room, while deterministic failure permits a fresh name", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls: Array<{ path: string; options: unknown }> = [];
    const coordinator = new ArtifactRenameCoordinator();
    const client = { renameWorkspaceArtifact: async (_id: string, path: string, options?: { roomId?: string }) => { calls.push({ path, options }); await gate; throw new Error("lost"); } };
    const first = coordinator.rename({ client, artifact, basename: "first.md", serverId: "server" });
    const repeated = coordinator.rename({ client, artifact, basename: "newer.md", serverId: "server" });
    expect(repeated).toBe(first);
    release();
    expect(await first).toMatchObject({ reason: "offline", retryable: true, reloadBeforeClose: true });
    const retry = await coordinator.retry({ renameWorkspaceArtifact: async (_id, path, options) => { calls.push({ path, options }); return { ...artifact, path, revision: 2 }; } });
    expect(retry).toMatchObject({ state: "saved", artifact: { path: "folder/first.md", id: "row", artifactId: "stable" } });
    expect(calls).toEqual([{ path: "folder/first.md", options: undefined }, { path: "folder/first.md", options: undefined }]);

    const rejected = new ArtifactRenameCoordinator();
    expect(await rejected.rename({ client: { renameWorkspaceArtifact: async () => { throw new ApiError(422, "bad"); } }, artifact, basename: "bad.md", serverId: "server" })).toMatchObject({ reason: "validation", retryable: false });
    expect(await rejected.rename({ client: { renameWorkspaceArtifact: async (_id, path) => ({ ...artifact, path, revision: 3 }) }, artifact, basename: "fresh.md", serverId: "server" })).toMatchObject({ state: "saved", artifact: { path: "folder/fresh.md" } });
  });

  test("maps auth, permission, conflict, missing, server and disposal without an extra request", async () => {
    const cases = [[401, "auth-dead"], [403, "permission"], [404, "missing"], [409, "conflict"], [500, "server"]] as const;
    for (const [status, reason] of cases) {
      const result = await new ArtifactRenameCoordinator().rename({ client: { renameWorkspaceArtifact: async () => { throw new ApiError(status, reason); } }, artifact, basename: "next.md", serverId: "server" });
      expect(result).toMatchObject({ state: "error", reason, ...(status === 403 || status === 404 ? { reloadBeforeClose: true } : {}) });
    }
    const disposed = new ArtifactRenameCoordinator();
    disposed.dispose();
    expect(await disposed.rename({ client: { renameWorkspaceArtifact: async () => ({ ...artifact }) }, artifact, basename: "next.md", serverId: "server" })).toMatchObject({ reason: "disposed" });
  });

  test("preserves the stable Artifact capability denial", async () => {
    const result = await new ArtifactRenameCoordinator().rename({
      client: { renameWorkspaceArtifact: async () => { throw new ArtifactWriteRequiredError(); } },
      artifact,
      basename: "next.md",
      serverId: "server",
    });
    expect(result).toMatchObject({ reason: "capability", retryable: false, reloadBeforeClose: true });
  });

  test("emits the shared auth-dead signal exactly once for a 401", async () => {
    const emitted: string[] = [];
    const unsubscribe = onAuthDead((serverId) => emitted.push(serverId));
    try {
      const result = await new ArtifactRenameCoordinator().rename({
        client: { renameWorkspaceArtifact: async () => { throw new ApiError(401, "expired"); } },
        artifact,
        basename: "next.md",
        serverId: "server-401",
      });
      expect(result).toMatchObject({ state: "error", reason: "auth-dead", retryable: false });
      expect(emitted).toEqual(["server-401"]);
    } finally {
      unsubscribe();
    }
  });

  test("closes unchanged without a request and treats any immutable success mismatch as uncertain", async () => {
    let calls = 0;
    const coordinator = new ArtifactRenameCoordinator();
    expect(await coordinator.rename({ client: { renameWorkspaceArtifact: async () => { calls += 1; return artifact; } }, artifact, basename: "old.md", serverId: "server" })).toEqual({ state: "unchanged" });
    expect(calls).toBe(0);
    const malformed = [
      { ...artifact, id: "wrong", path: "folder/next.md" },
      { ...artifact, artifactId: "wrong", path: "folder/next.md" },
      { ...artifact, path: "folder/not-the-frozen-name.md" },
    ];
    for (const returned of malformed) {
      const mismatch = new ArtifactRenameCoordinator();
      expect(await mismatch.rename({ client: { renameWorkspaceArtifact: async () => returned }, artifact, basename: "next.md", serverId: "server" }))
        .toMatchObject({ state: "error", reason: "server", retryable: true, reloadBeforeClose: true });
    }
    expect(renamePathFromBasename(`${"x".repeat(4090)}/old`, "toolong")).toMatchObject({ ok: false, reason: "validation" });
  });

  test("abandoning an uncertain close prevents a later rename from replaying its old path", async () => {
    const coordinator = new ArtifactRenameCoordinator();
    const first = await coordinator.rename({
      client: { renameWorkspaceArtifact: async () => { throw new Error("response lost"); } },
      artifact,
      basename: "first.md",
      serverId: "server",
    });
    expect(first).toMatchObject({ state: "error", retryable: true });
    expect(coordinator.abandon()).toBe(true);
    const calls: string[] = [];
    const next = await coordinator.rename({
      client: { renameWorkspaceArtifact: async (_id, path) => { calls.push(path); return { ...artifact, path }; } },
      artifact,
      basename: "second.md",
      serverId: "server",
    });
    expect(next).toMatchObject({ state: "saved", artifact: { path: "folder/second.md" } });
    expect(calls).toEqual(["folder/second.md"]);
  });

  test("permission and missing failures are nonretryable but request viewer reconciliation", async () => {
    for (const status of [403, 404]) {
      const result = await new ArtifactRenameCoordinator().rename({
        client: { renameWorkspaceArtifact: async () => { throw new ApiError(status, "changed"); } },
        artifact,
        basename: "next.md",
        serverId: "server",
      });
      expect(result).toMatchObject({ state: "error", retryable: false, reloadBeforeClose: true });
    }
  });

  test("late completion after disposal is fenced", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const coordinator = new ArtifactRenameCoordinator();
    const pending = coordinator.rename({
      client: { renameWorkspaceArtifact: async (_id, path) => { await gate; return { ...artifact, path }; } },
      artifact,
      basename: "next.md",
      serverId: "server",
    });
    coordinator.dispose();
    release();
    expect(await pending).toMatchObject({ state: "error", reason: "disposed" });
  });
});
