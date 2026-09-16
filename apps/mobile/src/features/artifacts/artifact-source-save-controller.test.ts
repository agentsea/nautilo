import { ApiError, ArtifactWriteRequiredError, ConflictError } from "@nautilo/api-client/browser";
import { describe, expect, test } from "bun:test";

import { ArtifactSourceSaveController, createArtifactReloadFence, type SourceSaveInput } from "./artifact-source-save-controller";
import { MAX_NATIVE_SOURCE_EDIT_BYTES } from "./artifact-edit-limits";

type Save = SourceSaveInput["client"]["saveWorkspaceArtifactContent"];
const input = (save: Save, content = "edited"): SourceSaveInput => ({
  client: { saveWorkspaceArtifactContent: save },
  id: "artifact-a",
  content,
  mimeType: "text/markdown",
  checkpoint: true,
});

describe("ArtifactSourceSaveController", () => {
  test("cancelled reload generations make late completions inert", () => {
    const fence = createArtifactReloadFence();
    const first = fence.begin();
    expect(fence.isCurrent(first.generation)).toBe(true);
    fence.cancel();
    expect(first.signal.aborted).toBe(true);
    expect(fence.isCurrent(first.generation)).toBe(false);
    const second = fence.begin();
    expect(fence.isCurrent(second.generation)).toBe(true);
    expect(fence.isCurrent(first.generation)).toBe(false);
  });

  test("shares one in-flight promise and sends the exact frozen optimistic contract", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls: Array<{ id: string; content: string; options: unknown }> = [];
    const controller = new ArtifactSourceSaveController({ revision: 1, sha256: "base" }, () => "mutation-1");
    const save: Save = async (id, content, options) => {
      calls.push({ id, content, options });
      await gate;
      return { id, revision: 2, size: content.length, sha256: "next" };
    };
    const first = controller.save(input(save));
    const repeated = controller.save(input(save, "must-not-send"));
    expect(repeated).toBe(first);
    expect(calls).toHaveLength(1);
    release();
    expect(await first).toEqual({
      state: "idle",
      snapshot: { revision: 2, sha256: "next" },
      acceptedContent: "edited",
    });
    expect(calls[0]).toEqual({
      id: "artifact-a",
      content: "edited",
      options: {
        baseRevision: 1,
        baseSha256: "base",
        checkpoint: true,
        mimeType: "text/markdown",
        clientMutationId: "mutation-1",
      },
    });
  });

  test("retries identical frozen bytes and identity, then advances the next save base", async () => {
    const calls: unknown[] = [];
    let attempt = 0;
    const ids = ["mutation-1", "mutation-2"];
    const controller = new ArtifactSourceSaveController({ revision: 4, sha256: null }, () => ids.shift()!);
    const save: Save = async (id, content, options) => {
      calls.push({ id, content, options });
      if (attempt++ === 0) throw new Error("offline");
      return { id, revision: attempt === 2 ? 5 : 6, size: content.length, sha256: `sha-${attempt}` };
    };
    expect(await controller.save(input(save, "one"))).toMatchObject({ reason: "offline", retryable: true });
    expect(await controller.retry({ saveWorkspaceArtifactContent: save })).toMatchObject({
      state: "idle",
      acceptedContent: "one",
      snapshot: { revision: 5, sha256: "sha-2" },
    });
    await controller.save(input(save, "two"));
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual(calls[1]);
    expect(calls[2]).toMatchObject({
      content: "two",
      options: { baseRevision: 5, baseSha256: "sha-2", clientMutationId: "mutation-2" },
    });
  });

  test("ordinary Save replays an unconfirmed mutation before newer editor bytes", async () => {
    const calls: Array<{ content: string; options: unknown }> = [];
    let first = true;
    let mutationNumber = 0;
    const controller = new ArtifactSourceSaveController(
      { revision: 7, sha256: "base" },
      () => `mutation-${++mutationNumber}`,
    );
    const save: Save = async (id, content, options) => {
      calls.push({ content, options });
      if (first) {
        first = false;
        throw new Error("response lost");
      }
      return { id, revision: 8, size: content.length, sha256: "confirmed" };
    };
    expect(await controller.save(input(save, "possibly committed"))).toMatchObject({ retryable: true });
    expect(await controller.save(input(save, "newer unsaved edit"))).toMatchObject({
      state: "idle",
      acceptedContent: "possibly committed",
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(mutationNumber).toBe(1);
  });

  test("blocks every later write after a conflict and preserves the remote SHA", async () => {
    let calls = 0;
    const controller = new ArtifactSourceSaveController({ revision: 3, sha256: "base" }, () => "m");
    const conflict = await controller.save(input(async () => {
      calls++;
      throw new ConflictError("remote");
    }));
    expect(conflict).toMatchObject({ state: "conflict", currentSha256: "remote", retryable: false });
    expect(await controller.save(input(async () => { calls++; throw new Error("must not run"); }))).toMatchObject({ state: "conflict" });
    expect(calls).toBe(1);
  });

  test("only an explicit valid latest baseline resolves a blocked conflict", async () => {
    let mutation = 0;
    const controller = new ArtifactSourceSaveController(
      { revision: 3, sha256: "base" },
      () => `m-${++mutation}`,
    );
    await controller.save(input(async () => { throw new ConflictError("remote"); }));
    expect(controller.resolveConflictWithLatest({ revision: 4, sha256: "" })).toBe(false);
    expect(await controller.save(input(async () => { throw new Error("blocked"); }))).toMatchObject({ state: "conflict" });
    expect(controller.resolveConflictWithLatest({ revision: 4, sha256: "latest" })).toBe(true);
    expect(await controller.save(input(async (id, content, options) => ({
      id,
      revision: 5,
      size: content.length,
      sha256: `${options.baseSha256}:saved`,
    })))).toMatchObject({ state: "idle", snapshot: { revision: 5, sha256: "latest:saved" } });
  });

  test("maps deterministic API failures without making them retryable", async () => {
    const cases = [
      [401, "auth-dead"], [403, "permission"], [404, "missing"],
      [413, "size"], [400, "validation"], [422, "validation"],
    ] as const;
    for (const [status, reason] of cases) {
      const controller = new ArtifactSourceSaveController({ revision: 1, sha256: null }, () => "m");
      const result = await controller.save(input(async () => { throw new ApiError(status, reason); }));
      expect(result).toMatchObject({ state: "error", reason, retryable: false });
    }
  });

  test("preserves the stable Artifact capability denial", async () => {
    const controller = new ArtifactSourceSaveController({ revision: 1, sha256: null }, () => "m");
    const result = await controller.save(input(async () => { throw new ArtifactWriteRequiredError(); }));
    expect(result).toMatchObject({ state: "error", reason: "capability", retryable: false });
  });

  test("retains server and malformed-response attempts for stable retry", async () => {
    for (const failure of [new ApiError(503, "unavailable"), null] as const) {
      const controller = new ArtifactSourceSaveController({ revision: 1, sha256: null }, () => "stable");
      let calls = 0;
      const save: Save = async (id, content) => {
        calls++;
        if (calls === 1) {
          if (failure) throw failure;
          return { id, revision: Number.NaN, size: content.length, sha256: "" };
        }
        return { id, revision: 2, size: content.length, sha256: "valid" };
      };
      expect(await controller.save(input(save))).toMatchObject({ reason: "server", retryable: true });
      expect(await controller.retry({ saveWorkspaceArtifactContent: save })).toMatchObject({ state: "idle" });
    }
  });

  test("rejects oversized UTF-8 and fences an authorized completion after disposal", async () => {
    let calls = 0;
    const oversized = new ArtifactSourceSaveController({ revision: 1, sha256: null }, () => "m");
    expect(
      await oversized.save(
        input(
          async () => {
            calls++;
            throw new Error();
          },
          "x".repeat(MAX_NATIVE_SOURCE_EDIT_BYTES + 1),
        ),
      ),
    ).toMatchObject({ reason: "size", retryable: false });
    expect(calls).toBe(0);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const disposed = new ArtifactSourceSaveController({ revision: 8, sha256: "old" }, () => "m");
    const pending = disposed.save(input(async (id, content) => {
      await gate;
      return { id, revision: 9, size: content.length, sha256: "new" };
    }));
    disposed.dispose();
    release();
    expect(await pending).toMatchObject({ state: "error", reason: "disposed", snapshot: { revision: 8, sha256: "old" } });
  });
});
