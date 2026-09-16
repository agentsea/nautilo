import { ApiError, ArtifactWriteRequiredError } from "@nautilo/api-client/browser";
import { describe, expect, test } from "bun:test";

import { onAuthDead } from "@/lib/auth-events";
import { ArtifactDeleteCoordinator, shouldExitDeletedArtifactReconciliation } from "./artifact-delete";

describe("artifact delete coordinator", () => {
  test("single-flights aggregate authority without retaining a selected room across an uncertain retry", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls: Array<{ id: string; options: unknown }> = [];
    const coordinator = new ArtifactDeleteCoordinator();
    const client = { deleteWorkspaceArtifact: async (id: string, options?: { roomId?: string }) => { calls.push({ id, options }); await gate; throw new Error("lost"); } };
    const first = coordinator.delete({ client, id: "artifact-a", serverId: "server-a" });
    expect(coordinator.delete({ client, id: "artifact-b", serverId: "server-b" })).toBe(first);
    release();
    expect(await first).toMatchObject({ state: "error", reason: "offline", retryable: true, reconcileBeforeClose: true });
    expect(await coordinator.retry({ deleteWorkspaceArtifact: async (id, options) => { calls.push({ id, options }); } })).toEqual({ state: "deleted" });
    expect(calls).toEqual([{ id: "artifact-a", options: undefined }, { id: "artifact-a", options: undefined }]);
  });

  test("401 emits auth-dead, while 403 and 404 require reconciliation and never claim deletion", async () => {
    const emitted: string[] = [];
    const unsubscribe = onAuthDead((serverId) => emitted.push(serverId));
    try {
      const auth = await new ArtifactDeleteCoordinator().delete({ client: { deleteWorkspaceArtifact: async () => { throw new ApiError(401, "expired"); } }, id: "a", serverId: "server-auth" });
      expect(auth).toMatchObject({ state: "error", reason: "auth-dead", retryable: false });
      expect(emitted).toEqual(["server-auth"]);
      for (const [status, reason] of [[403, "permission"], [404, "missing"]] as const) {
        const result = await new ArtifactDeleteCoordinator().delete({ client: { deleteWorkspaceArtifact: async () => { throw new ApiError(status, "changed"); } }, id: "a", serverId: "server" });
        expect(result).toMatchObject({ state: "error", reason, retryable: false, reconcileBeforeClose: true });
      }
    } finally { unsubscribe(); }
  });

  test("preserves the stable Artifact capability denial", async () => {
    const result = await new ArtifactDeleteCoordinator().delete({
      client: { deleteWorkspaceArtifact: async () => { throw new ArtifactWriteRequiredError(); } },
      id: "artifact-a",
      serverId: "server",
    });
    expect(result).toMatchObject({ reason: "capability", retryable: false, reconcileBeforeClose: true });
  });

  test("abandon permits a fresh delete and disposal fences a late completion", async () => {
    const coordinator = new ArtifactDeleteCoordinator();
    await coordinator.delete({ client: { deleteWorkspaceArtifact: async () => { throw new Error("lost"); } }, id: "old", serverId: "server" });
    expect(coordinator.abandon()).toBe(true);
    const calls: string[] = [];
    expect(await coordinator.delete({ client: { deleteWorkspaceArtifact: async (id) => { calls.push(id); } }, id: "new", serverId: "server" })).toEqual({ state: "deleted" });
    expect(calls).toEqual(["new"]);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const disposed = new ArtifactDeleteCoordinator();
    const late = disposed.delete({ client: { deleteWorkspaceArtifact: async () => { await gate; } }, id: "a", serverId: "server" });
    disposed.dispose();
    release();
    expect(await late).toMatchObject({ state: "error", reason: "disposed" });
  });

  test("only a missing or unreadable canonical result exits the viewer after reconciliation", () => {
    for (const kind of ["auth_dead", "forbidden", "not_found"] as const) expect(shouldExitDeletedArtifactReconciliation(kind)).toBe(true);
    for (const kind of ["network", "server", "unsupported", "too_large", "text", "file", "cancelled"] as const) expect(shouldExitDeletedArtifactReconciliation(kind)).toBe(false);
  });
});
