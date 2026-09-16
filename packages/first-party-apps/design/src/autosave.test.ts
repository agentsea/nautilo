import { describe, expect, test } from "bun:test";
import { bridgeWriteResult, DesignAutosave } from "./autosave";
import { createDefaultManifest, parseDesignHtml, serializeDesignHtml } from "./design-document";
import { appendChild, createEmptyDocument, createNode, type DesignDocument } from "./scene-graph";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function designContent(
  textById: Record<string, string>,
  manifest = createDefaultManifest(),
): string {
  let document: DesignDocument = createEmptyDocument();
  for (const [id, text] of Object.entries(textById)) {
    const node = createNode({ id, type: "text", parentId: null, text });
    document = appendChild({ ...document, nodes: { ...document.nodes, [id]: node } }, null, id, "page-1");
  }
  return serializeDesignHtml(manifest, document);
}

function sceneText(content: string, nodeId: string): string | undefined {
  const parsed = parseDesignHtml(content);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.document.scene.nodes[nodeId]?.text;
}

function sceneManifest(content: string) {
  const parsed = parseDesignHtml(content);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.document.manifest;
}

describe("bridgeWriteResult", () => {
  test("preserves saved path, revision and persistedContent", () => {
    expect(
      bridgeWriteResult({
        kind: "saved",
        sha256: "sha-1",
        revision: 2,
        path: "Untitled design.design.html",
        persistedContent: "<html>canonical</html>",
      }),
    ).toEqual({
      kind: "saved",
      sha256: "sha-1",
      revision: 2,
      path: "Untitled design.design.html",
      persistedContent: "<html>canonical</html>",
    });
  });

  test("maps conflict responses", () => {
    expect(bridgeWriteResult({ kind: "conflict", currentSha256: "remote" })).toEqual({
      kind: "conflict",
      currentSha256: "remote",
    });
  });

  test("maps unexpected shapes to failed", () => {
    expect(bridgeWriteResult(null)).toEqual({
      kind: "failed",
      message: "Unexpected save response.",
    });
  });
});

describe("DesignAutosave", () => {
  test("does not save before initial load", async () => {
    let writes = 0;
    const autosave = new DesignAutosave(async () => {
      writes += 1;
      return { kind: "saved", sha256: "next" };
    });
    autosave.notifyChange("<html>a</html>");
    await sleep(800);
    expect(writes).toBe(0);
    autosave.destroy();
  });

  test("debounces multiple changes into one write", async () => {
    let writes = 0;
    const autosave = new DesignAutosave(async () => {
      writes += 1;
      return { kind: "saved", sha256: `sha-${writes}` };
    });
    autosave.markInitialLoad("<html></html>", null, null);
    autosave.notifyChange("<html>1</html>");
    autosave.notifyChange("<html>2</html>");
    await sleep(800);
    expect(writes).toBe(1);
    autosave.destroy();
  });

  test("saveNow bypasses debounce and reports saved", async () => {
    let writes = 0;
    const autosave = new DesignAutosave(async () => {
      writes += 1;
      return { kind: "saved", sha256: "sha-1" };
    });
    autosave.markInitialLoad("<html></html>", null, null);
    autosave.notifyChange("<html>1</html>");
    await autosave.saveNow();
    expect(writes).toBe(1);
    expect(autosave.getState().status).toBe("saved");
    expect(autosave.getState().dirty).toBe(false);
    autosave.destroy();
  });

  test("identical content does not schedule a save", async () => {
    let writes = 0;
    const autosave = new DesignAutosave(async () => {
      writes += 1;
      return { kind: "saved", sha256: "next" };
    });
    autosave.markInitialLoad("<html>stable</html>", null, null);
    autosave.notifyChange("<html>stable</html>");
    await sleep(800);
    expect(writes).toBe(0);
    expect(autosave.getState().dirty).toBe(false);
    autosave.destroy();
  });

  test("maps conflict and loads latest content for resolution", async () => {
    let writes = 0;
    const autosave = new DesignAutosave(
      async () => {
        writes += 1;
        return { kind: "conflict", currentSha256: "remote" };
      },
      async () => ({
        content: "<html>latest</html>",
        baseSha256: "remote",
        baseRevision: 2,
      }),
    );
    autosave.markInitialLoad("<html></html>", "local", 1);
    autosave.notifyChange("<html>mine</html>");
    await autosave.saveNow();
    expect(writes).toBe(1);
    expect(autosave.getState().status).toBe("conflict");
    expect(autosave.getState().conflictLatestContent).toBe("<html>latest</html>");
    autosave.destroy();
  });

  test("reloadLatest resets baseline to remote content", async () => {
    const autosave = new DesignAutosave(
      async () => ({ kind: "saved", sha256: "next" }),
      async () => ({
        content: "<html>latest</html>",
        baseSha256: "remote",
        baseRevision: 5,
      }),
    );
    autosave.markInitialLoad("<html>mine</html>", "local", 1);
    autosave.notifyChange("<html>mine-edited</html>");
    const reloaded = await autosave.reloadLatest();
    expect(reloaded?.content).toBe("<html>latest</html>");
    expect(autosave.getState().dirty).toBe(false);
    expect(autosave.getState().status).toBe("idle");
    autosave.destroy();
  });

  test("keepMine writes against a freshly read base", async () => {
    let writeBase: { sha256: string | null; revision: number | null } | null = null;
    const autosave = new DesignAutosave(
      async (_content, base) => {
        writeBase = base;
        return { kind: "saved", sha256: "remote-next", revision: 3 };
      },
      async () => ({
        content: "<html>latest</html>",
        baseSha256: "remote",
        baseRevision: 2,
      }),
    );
    autosave.markInitialLoad("<html></html>", "base", 1);
    autosave.notifyChange("<html>mine</html>");
    await autosave.keepMine();
    expect(writeBase as { sha256: string | null; revision: number | null } | null).toEqual({
      sha256: "remote",
      revision: 2,
    });
    expect(autosave.getState().status).toBe("saved");
    autosave.destroy();
  });

  test("clean authored patch becomes the exact next write baseline", async () => {
    let writeBase: { sha256: string | null; revision: number | null } | null = null;
    const autosave = new DesignAutosave(async (_content, base) => {
      writeBase = base;
      return { kind: "saved", sha256: "after-local", revision: 3 };
    });
    const base = designContent({ human: "before" });
    const remotePatch = designContent({ human: "agent update" });
    autosave.markInitialLoad(base, "base", 1);
    const content = autosave.applyRemoteEnvelope({
      content: remotePatch,
      baseSha256: "agent-patch-sha",
      baseRevision: 2,
    });
    expect(content).toBe(remotePatch);
    expect(sceneText(content, "human")).toBe("agent update");
    const state = autosave.getState();
    expect(state.dirty).toBe(false);
    expect(state.status).toBe("idle");
    autosave.notifyChange(designContent({ human: "human after agent" }));
    await autosave.saveNow();
    expect(writeBase as { sha256: string | null; revision: number | null } | null).toEqual({
      sha256: "agent-patch-sha",
      revision: 2,
    });
    autosave.destroy();
  });

  test("applyRemoteEnvelope surfaces a conflict when the draft is dirty", () => {
    const autosave = new DesignAutosave(async () => ({ kind: "saved", sha256: "next" }));
    autosave.markInitialLoad("<html>a</html>", "base", 1);
    autosave.notifyChange("<html>mine</html>");
    const content = autosave.applyRemoteEnvelope({
      content: "<html>remote</html>",
      baseSha256: "remote",
      baseRevision: 2,
    });
    expect(content).toBe("<html>mine</html>");
    const state = autosave.getState();
    expect(state.status).toBe("conflict");
    expect(state.dirty).toBe(true);
    expect(state.conflictLatestContent).toBe("<html>remote</html>");
    autosave.destroy();
  });

  test("disjoint dirty authored patch merges supported node changes and saves both through reopen", async () => {
    let written = "";
    let writeBase: { sha256: string | null; revision: number | null } | null = null;
    const autosave = new DesignAutosave(async (content, base) => {
      written = content;
      writeBase = base;
      return { kind: "saved", sha256: "merged", revision: 3, persistedContent: content };
    });
    const base = designContent({ human: "old", agent: "old" });
    const localDraft = designContent({ human: "local edit", agent: "old" });
    const remotePatch = designContent(
      { human: "old", agent: "agent edit" },
      {
        ...createDefaultManifest(),
        metadata: { createdBy: "agent", updatedAt: "2026-08-11T10:00:00.000Z" },
      },
    );
    autosave.markInitialLoad(base, "base", 1);
    autosave.notifyChange(localDraft);

    const merged = autosave.applyRemoteEnvelope({
      content: remotePatch,
      baseSha256: "agent-patch-sha",
      baseRevision: 2,
    });
    expect(sceneText(merged, "human")).toBe("local edit");
    expect(sceneText(merged, "agent")).toBe("agent edit");
    expect(sceneManifest(merged).metadata?.createdBy).toBe("agent");
    expect(autosave.getState()).toMatchObject({
      status: "unsaved",
      dirty: true,
      conflictLatestContent: null,
    });
    await autosave.saveNow();
    expect(writeBase as { sha256: string | null; revision: number | null } | null).toEqual({
      sha256: "agent-patch-sha",
      revision: 2,
    });
    expect(sceneText(written, "human")).toBe("local edit");
    expect(sceneText(written, "agent")).toBe("agent edit");
    const reopened = new DesignAutosave(async () => ({ kind: "saved", sha256: "unused" }));
    reopened.markInitialLoad(written, "merged", 3);
    expect(sceneText(written, "human")).toBe("local edit");
    expect(sceneText(written, "agent")).toBe("agent edit");
    expect(reopened.getState().dirty).toBe(false);
    reopened.destroy();
    autosave.destroy();
  });

  test("a stale save completion cannot replace a newly merged remote baseline", async () => {
    let resolveFirstWrite: (result: { kind: "saved"; sha256: string; revision: number }) => void = () => {
      throw new Error("The first save did not start.");
    };
    let writes = 0;
    let secondWriteBase: { sha256: string | null; revision: number | null } | null = null;
    const autosave = new DesignAutosave(async (_content, base) => {
      writes += 1;
      if (writes === 1) {
        return await new Promise<{ kind: "saved"; sha256: string; revision: number }>((resolve) => {
          resolveFirstWrite = resolve;
        });
      }
      secondWriteBase = base;
      return { kind: "saved", sha256: "merged", revision: 3 };
    });
    const base = designContent({ human: "old", agent: "old" });
    const localDraft = designContent({ human: "local edit", agent: "old" });
    const remotePatch = designContent({ human: "old", agent: "agent edit" });
    autosave.markInitialLoad(base, "base", 1);
    autosave.notifyChange(localDraft);
    const staleSave = autosave.saveNow();

    const merged = autosave.applyRemoteEnvelope({
      content: remotePatch,
      baseSha256: "agent-patch-sha",
      baseRevision: 2,
    });
    resolveFirstWrite({ kind: "saved", sha256: "stale", revision: 99 });
    await staleSave;

    expect(writes).toBe(2);
    expect(autosave.getState()).toMatchObject({ status: "saved", dirty: false });
    expect(secondWriteBase as { sha256: string | null; revision: number | null } | null).toEqual({
      sha256: "agent-patch-sha",
      revision: 2,
    });
    expect(sceneText(merged, "human")).toBe("local edit");
    expect(sceneText(merged, "agent")).toBe("agent edit");
    autosave.destroy();
  });

  test("same-target dirty authored patch preserves local draft with scoped conflict data", () => {
    const autosave = new DesignAutosave(async () => ({ kind: "saved", sha256: "next" }));
    const base = designContent({ shared: "old" });
    const localDraft = designContent({ shared: "human edit" });
    const remotePatch = designContent({ shared: "agent edit" });
    autosave.markInitialLoad(base, "base", 1);
    autosave.notifyChange(localDraft);

    expect(
      autosave.applyRemoteEnvelope({
        content: remotePatch,
        baseSha256: "agent-patch-sha",
        baseRevision: 2,
      }),
    ).toBe(localDraft);
    expect(autosave.getState()).toMatchObject({
      status: "conflict",
      dirty: true,
      conflictLatestContent: remotePatch,
      conflictAffectedNodeIds: ["shared"],
      conflictReason: "same_target",
    });
    autosave.destroy();
  });

  test("structural dirty authored patch preserves the local draft rather than guessing a merge", () => {
    const autosave = new DesignAutosave(async () => ({ kind: "saved", sha256: "next" }));
    const base = designContent({ agent: "old" });
    const localDraft = designContent({ agent: "old", humanCreated: "new local node" });
    const remotePatch = designContent({ agent: "agent edit" });
    autosave.markInitialLoad(base, "base", 1);
    autosave.notifyChange(localDraft);

    expect(
      autosave.applyRemoteEnvelope({
        content: remotePatch,
        baseSha256: "agent-patch-sha",
        baseRevision: 2,
      }),
    ).toBe(localDraft);
    expect(autosave.getState()).toMatchObject({
      status: "conflict",
      dirty: true,
      conflictLatestContent: remotePatch,
      conflictAffectedNodeIds: ["agent", "humanCreated"],
      conflictReason: "structural_change",
    });
    autosave.destroy();
  });

  test("external change while clean stays idle", () => {
    const autosave = new DesignAutosave(async () => ({ kind: "saved", sha256: "next" }));
    autosave.markInitialLoad("<html></html>", "base", 1);
    autosave.markExternalChange("<html>remote</html>");
    const state = autosave.getState();
    expect(state.status).toBe("idle");
    expect(state.dirty).toBe(false);
    expect(state.conflictLatestContent).toBe("<html>remote</html>");
    autosave.destroy();
  });

  test("persistedContent realigns the saved baseline after a write", async () => {
    const autosave = new DesignAutosave(async () => ({
      kind: "saved",
      sha256: "next",
      persistedContent: "<html>canonical</html>",
    }));
    autosave.markInitialLoad("<html>a</html>", null, null);
    autosave.notifyChange("<html>draft</html>");
    await autosave.saveNow();
    expect(autosave.getState().dirty).toBe(false);
    expect(autosave.getState().status).toBe("saved");
    autosave.destroy();
  });

  test("failed writes surface the error message", async () => {
    const autosave = new DesignAutosave(async () => {
      throw new Error("network down");
    });
    autosave.markInitialLoad("<html></html>", null, null);
    autosave.notifyChange("<html>x</html>");
    await autosave.saveNow();
    expect(autosave.getState().status).toBe("failed");
    expect(autosave.getState().errorMessage).toBe("network down");
    autosave.destroy();
  });

  test("serializes in-flight edits into exact sequential writes", async () => {
    let releaseFirst = (): void => {
      throw new Error("The first write did not start.");
    };
    let activeWrites = 0;
    let maxActiveWrites = 0;
    const writes: Array<{
      content: string;
      base: { sha256: string | null; revision: number | null };
    }> = [];
    const autosave = new DesignAutosave(async (content, base) => {
      activeWrites += 1;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      writes.push({ content, base });
      if (writes.length === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      activeWrites -= 1;
      return { kind: "saved", sha256: `sha-${writes.length}`, revision: writes.length };
    });
    autosave.markInitialLoad("<html>base</html>", "base", 0);
    autosave.notifyChange("<html>first exact snapshot</html>");
    const firstSave = autosave.saveNow();
    autosave.notifyChange("<html>second exact snapshot</html>");
    const joinedSave = autosave.saveNow();

    expect(writes).toHaveLength(1);
    expect(maxActiveWrites).toBe(1);
    releaseFirst();
    await Promise.all([firstSave, joinedSave]);

    expect(maxActiveWrites).toBe(1);
    expect(writes).toEqual([
      {
        content: "<html>first exact snapshot</html>",
        base: { sha256: "base", revision: 0 },
      },
      {
        content: "<html>second exact snapshot</html>",
        base: { sha256: "sha-1", revision: 1 },
      },
    ]);
    expect(autosave.getState()).toMatchObject({ status: "saved", dirty: false });
    autosave.destroy();
  });

  test("flush waits for the in-flight write and every newer queued draft", async () => {
    let releaseFirst = (): void => {
      throw new Error("The first write did not start.");
    };
    const written: string[] = [];
    const autosave = new DesignAutosave(async (content) => {
      written.push(content);
      if (written.length === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return { kind: "saved", sha256: `sha-${written.length}`, revision: written.length };
    });
    autosave.markInitialLoad("<html>base</html>", "base", 0);
    autosave.notifyChange("<html>first</html>");
    void autosave.saveNow();
    autosave.notifyChange("<html>latest before close</html>");
    const flushing = autosave.flush();

    let flushFinished = false;
    void flushing.then(() => {
      flushFinished = true;
    });
    await Promise.resolve();
    expect(flushFinished).toBe(false);
    releaseFirst();

    expect(await flushing).toMatchObject({
      status: "saved",
      dirty: false,
      documentSaved: true,
    });
    expect(written).toEqual(["<html>first</html>", "<html>latest before close</html>"]);
    autosave.destroy();
  });

  test("failed transport preserves an exact scope-bound recovery draft for flush", async () => {
    const recoveryWrites: unknown[] = [];
    const autosave = new DesignAutosave(
      async () => ({ kind: "failed", message: "destination unavailable" }),
      undefined,
      {
        recovery: {
          scope: "document:hero",
          adapter: {
            write: async (record) => {
              recoveryWrites.push(record);
            },
          },
        },
      },
    );
    autosave.markInitialLoad("<html>base</html>", "base-sha", 4);
    autosave.notifyChange("<html>recover me exactly</html>");

    const result = await autosave.flush();
    expect(result).toMatchObject({
      status: "failed",
      dirty: true,
      documentSaved: false,
      recoveryPersisted: true,
      recoverableDraft: {
        scope: "document:hero",
        content: "<html>recover me exactly</html>",
        base: { sha256: "base-sha", revision: 4 },
      },
    });
    expect(recoveryWrites.at(-1)).toEqual(result.recoverableDraft);
    let copied = "";
    expect(
      await autosave.saveCopy(async (content) => {
        copied = content;
        return { kind: "saved", sha256: "copy-sha" };
      }),
    ).toEqual({ kind: "saved", sha256: "copy-sha" });
    expect(copied).toBe("<html>recover me exactly</html>");
    expect(autosave.getState().dirty).toBe(true);
    autosave.destroy();
  });

  test("serialization failure stays dirty and exposes the last recoverable content", async () => {
    const autosave = new DesignAutosave(
      async () => ({ kind: "saved", sha256: "unused" }),
      undefined,
      {
        recovery: {
          scope: "document:hero",
          adapter: { write: async () => undefined },
        },
      },
    );
    autosave.markInitialLoad("<html>base</html>", "base", 1);
    autosave.notifyChange("<html>last serializable draft</html>");
    autosave.markSerializationFailure("Could not serialize the newest edit.");

    expect(autosave.getState()).toMatchObject({
      status: "failed",
      dirty: true,
      recoverableDraftAvailable: true,
      recoverableDraftExact: false,
    });
    expect(autosave.getSaveCopyContent()).toBe("<html>last serializable draft</html>");
    expect(await autosave.flush()).toMatchObject({ documentSaved: false, dirty: true });
    expect(
      autosave.applyRemoteEnvelope({
        content: "<html>remote while serialization is broken</html>",
        baseSha256: "remote",
        baseRevision: 2,
      }),
    ).toBe("<html>last serializable draft</html>");
    expect(autosave.getState()).toMatchObject({
      status: "conflict",
      dirty: true,
      recoverableDraftExact: false,
      conflictLatestContent: "<html>remote while serialization is broken</html>",
    });
    autosave.destroy();
  });

  test("retry writes the unchanged failed snapshot", async () => {
    const writes: string[] = [];
    const autosave = new DesignAutosave(async (content) => {
      writes.push(content);
      return writes.length === 1
        ? { kind: "failed", message: "offline" }
        : { kind: "saved", sha256: "saved", revision: 2 };
    });
    autosave.markInitialLoad("<html>base</html>", "base", 1);
    autosave.notifyChange("<html>same draft</html>");
    await autosave.saveNow();
    await autosave.retry();
    expect(writes).toEqual(["<html>same draft</html>", "<html>same draft</html>"]);
    expect(autosave.getState()).toMatchObject({ status: "saved", dirty: false });
    autosave.destroy();
  });

  test("cancelConflict retains unresolved local and remote evidence", () => {
    const autosave = new DesignAutosave(async () => ({ kind: "saved", sha256: "next" }));
    autosave.markInitialLoad("<html>base</html>", "base", 1);
    autosave.notifyChange("<html>local draft</html>");
    autosave.markExternalChange("<html>remote draft</html>", {
      affectedNodeIds: ["named-node"],
      reason: "same_target",
    });
    autosave.cancelConflict();
    expect(autosave.getState()).toMatchObject({
      status: "conflict",
      dirty: true,
      conflictLatestContent: "<html>remote draft</html>",
      conflictAffectedNodeIds: ["named-node"],
    });
    autosave.destroy();
  });

  test("restores an exact same-base draft and saves it normally", async () => {
    const writes: string[] = [];
    const autosave = new DesignAutosave(
      async (content) => {
        writes.push(content);
        return { kind: "saved", sha256: "saved", revision: 5 };
      },
      undefined,
      {
        recovery: {
          scope: "document:hero",
          adapter: { write: async () => undefined },
        },
      },
    );
    autosave.markInitialLoad("<html>base</html>", "base", 4);
    expect(
      autosave.restoreRecoveryDraft({
        version: 1,
        scope: "document:hero",
        content: "<html>recovered</html>",
        exact: true,
        base: { sha256: "base", revision: 4 },
      }),
    ).toBe("restored");
    await autosave.flush();
    expect(writes).toEqual(["<html>recovered</html>"]);
    expect(autosave.getState().dirty).toBe(false);
    autosave.destroy();
  });

  test("keeps a recovered draft as conflict evidence when the host base changed", () => {
    const autosave = new DesignAutosave(
      async () => ({ kind: "saved", sha256: "unused" }),
      undefined,
      {
        recovery: {
          scope: "document:hero",
          adapter: { write: async () => undefined },
        },
      },
    );
    autosave.markInitialLoad("<html>new remote</html>", "new-base", 5);
    expect(
      autosave.restoreRecoveryDraft({
        version: 1,
        scope: "document:hero",
        content: "<html>recovered local</html>",
        exact: true,
        base: { sha256: "old-base", revision: 4 },
      }),
    ).toBe("conflict");
    expect(autosave.getState()).toMatchObject({
      status: "conflict",
      dirty: true,
      conflictReason: "recovery_base_changed",
      conflictLatestContent: "<html>new remote</html>",
    });
    expect(autosave.getSaveCopyContent()).toBe("<html>recovered local</html>");
    autosave.destroy();
  });

  test("blank remote content remains an active conflict and fences later saves", async () => {
    let writes = 0;
    const autosave = new DesignAutosave(
      async () => {
        writes += 1;
        return { kind: "conflict", currentSha256: "empty" };
      },
      async () => ({ content: "", baseSha256: "empty", baseRevision: 2 }),
    );
    autosave.markInitialLoad("<html>base</html>", "base", 1);
    autosave.notifyChange("<html>mine</html>");
    await autosave.saveNow();
    expect(autosave.getState()).toMatchObject({
      status: "conflict",
      dirty: true,
      conflictLatestContent: "",
    });

    autosave.notifyChange("<html>newer mine</html>");
    await autosave.saveNow();
    expect(writes).toBe(1);
    expect(autosave.getState().status).toBe("conflict");
    autosave.destroy();
  });

  test("a stale keep-mine read cannot clear a newer conflict", async () => {
    let releaseRead!: (value: {
      content: string;
      baseSha256: string;
      baseRevision: number;
    }) => void;
    let writes = 0;
    const autosave = new DesignAutosave(
      async () => {
        writes += 1;
        return { kind: "saved", sha256: "saved" };
      },
      async () => new Promise((resolve) => {
        releaseRead = resolve;
      }),
    );
    autosave.markInitialLoad("<html>base</html>", "base", 1);
    autosave.notifyChange("<html>mine</html>");
    autosave.markExternalChange("<html>remote one</html>");
    const keeping = autosave.keepMine();
    autosave.markExternalChange("<html>remote two</html>");
    releaseRead({ content: "<html>remote one</html>", baseSha256: "one", baseRevision: 2 });
    await keeping;

    expect(writes).toBe(0);
    expect(autosave.getState()).toMatchObject({
      status: "conflict",
      dirty: true,
      conflictLatestContent: "<html>remote two</html>",
    });
    autosave.destroy();
  });

  test("latest-load failures preserve conflict evidence and surface the error", async () => {
    let writes = 0;
    const autosave = new DesignAutosave(
      async () => {
        writes += 1;
        return { kind: "conflict", currentSha256: "remote" };
      },
      async () => {
        throw new Error("latest unavailable");
      },
    );
    autosave.markInitialLoad("<html>base</html>", "base", 1);
    autosave.notifyChange("<html>mine</html>");
    await autosave.saveNow();
    expect(autosave.getState()).toMatchObject({
      status: "conflict",
      dirty: true,
      errorMessage: "latest unavailable",
    });

    await autosave.keepMine();
    expect(autosave.getState()).toMatchObject({
      status: "conflict",
      dirty: true,
      errorMessage: "latest unavailable",
    });
    expect(await autosave.reloadLatest()).toBeNull();
    expect(autosave.getState()).toMatchObject({
      status: "conflict",
      dirty: true,
      errorMessage: "latest unavailable",
    });
    expect(writes).toBe(1);
    autosave.destroy();
  });

  test("serialization failure during an in-flight success remains failed and partial", async () => {
    let releaseWrite!: () => void;
    const recoveryWrites: Array<{ exact?: boolean } | null> = [];
    const autosave = new DesignAutosave(
      async () => {
        await new Promise<void>((resolve) => {
          releaseWrite = resolve;
        });
        return { kind: "saved", sha256: "saved-first", revision: 2 };
      },
      undefined,
      {
        recovery: {
          scope: "document:hero",
          adapter: {
            write: async (record) => {
              recoveryWrites.push(record);
            },
          },
        },
      },
    );
    autosave.markInitialLoad("<html>base</html>", "base", 1);
    autosave.notifyChange("<html>serializable</html>");
    const saving = autosave.saveNow();
    autosave.markSerializationFailure("newest edit cannot serialize");
    const flushing = autosave.flush();
    let flushFinished = false;
    void flushing.then(() => {
      flushFinished = true;
    });
    await Promise.resolve();
    expect(flushFinished).toBe(false);
    releaseWrite();
    await Promise.all([saving, flushing]);

    expect(autosave.getSavedSnapshot()).toMatchObject({ sha256: "saved-first", revision: 2 });
    expect(autosave.getState()).toMatchObject({
      status: "failed",
      dirty: true,
      errorMessage: "newest edit cannot serialize",
      recoverableDraftExact: false,
    });
    expect((await autosave.flush()).recoverableDraft).toMatchObject({ exact: false });
    expect(recoveryWrites.at(-1)).toMatchObject({ exact: false });
    autosave.destroy();
  });

  test("flush before initial load never claims a document was saved", async () => {
    const autosave = new DesignAutosave(async () => ({ kind: "saved", sha256: "unused" }));
    expect(await autosave.flush()).toMatchObject({
      status: "idle",
      dirty: false,
      documentSaved: false,
    });
    autosave.destroy();
  });

  test("a saving listener cannot start a concurrent nested save loop", async () => {
    let activeWrites = 0;
    let maxActiveWrites = 0;
    const writes: string[] = [];
    let queuedFromListener = false;
    const autosave = new DesignAutosave(async (content) => {
      activeWrites += 1;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      writes.push(content);
      await Promise.resolve();
      activeWrites -= 1;
      return { kind: "saved", sha256: `sha-${writes.length}`, revision: writes.length };
    });
    autosave.markInitialLoad("<html>base</html>", "base", 0);
    autosave.subscribe((state) => {
      if (state.status === "saving" && !queuedFromListener) {
        queuedFromListener = true;
        autosave.notifyChange("<html>listener edit</html>");
        void autosave.saveNow();
      }
    });
    autosave.notifyChange("<html>first edit</html>");
    await autosave.saveNow();

    expect(maxActiveWrites).toBe(1);
    expect(writes).toEqual(["<html>first edit</html>", "<html>listener edit</html>"]);
    expect(autosave.getState()).toMatchObject({ status: "saved", dirty: false });
    autosave.destroy();
  });

  test("configuring recovery on a clean load does not erase an unread stored draft", async () => {
    const writes: unknown[] = [];
    const autosave = new DesignAutosave(async () => ({ kind: "saved", sha256: "unused" }));
    autosave.markInitialLoad("<html>base</html>", "base", 1);
    autosave.configureRecovery("document:hero", {
      write: async (record) => {
        writes.push(record);
      },
    });
    await autosave.flush();
    expect(writes).toEqual([]);
    autosave.destroy();
  });

  test("restoring a partial recovery never treats it as exact or auto-saves it", async () => {
    let writes = 0;
    const autosave = new DesignAutosave(
      async () => {
        writes += 1;
        return { kind: "saved", sha256: "unused" };
      },
      undefined,
      {
        recovery: {
          scope: "document:hero",
          adapter: { write: async () => undefined },
        },
      },
    );
    autosave.markInitialLoad("<html>base</html>", "base", 1);
    expect(
      autosave.restoreRecoveryDraft({
        version: 1,
        scope: "document:hero",
        content: "<html>last serializable</html>",
        exact: false,
        base: { sha256: "base", revision: 1 },
      }),
    ).toBe("restored");
    await autosave.flush();
    expect(writes).toBe(0);
    expect(autosave.getState()).toMatchObject({
      status: "failed",
      dirty: true,
      recoverableDraftExact: false,
    });
    autosave.destroy();
  });

  test("deleting a clean bound document preserves an exact Save Copy and recovery draft", async () => {
    let writes = 0;
    let reads = 0;
    const recoveryWrites: unknown[] = [];
    const cleanContent = "<html>clean scene</html>";
    const autosave = new DesignAutosave(
      async () => {
        writes += 1;
        return { kind: "saved", sha256: "unexpected" };
      },
      async () => {
        reads += 1;
        return { content: "<html>remote</html>", baseSha256: "remote", baseRevision: 2 };
      },
      {
        recovery: {
          scope: "document:deleted-clean",
          adapter: { write: async (record) => { recoveryWrites.push(record); } },
        },
      },
    );
    autosave.markInitialLoad(cleanContent, "clean-sha", 1);
    autosave.markUnavailable("The bound Design document was deleted.");

    expect(autosave.getState()).toMatchObject({
      status: "unavailable",
      dirty: true,
      errorMessage: "The bound Design document was deleted.",
      recoverableDraftAvailable: true,
      recoverableDraftExact: true,
    });
    expect(autosave.getSaveCopyContent()).toBe(cleanContent);
    await autosave.retry();
    await autosave.keepMine();
    expect(await autosave.reloadLatest()).toBeNull();
    const flushed = await autosave.flush();
    expect(flushed).toMatchObject({
      status: "unavailable",
      dirty: true,
      documentSaved: false,
      recoveryPersisted: true,
      recoverableDraft: { content: cleanContent, exact: true },
    });
    expect(recoveryWrites.at(-1)).toEqual(flushed.recoverableDraft);
    expect(writes).toBe(0);
    expect(reads).toBe(0);
    autosave.destroy();
  });

  test("deletion clears the admitted debounce and retains later exact edits without writing", async () => {
    const writes: string[] = [];
    const autosave = new DesignAutosave(async (content) => {
      writes.push(content);
      return { kind: "saved", sha256: "unexpected" };
    });
    autosave.markInitialLoad("<html>base</html>", "base", 1);
    autosave.notifyChange("<html>dirty before deletion</html>");
    autosave.markUnavailable("Document no longer exists.");
    autosave.notifyChange("<html>final text edit</html>");

    await sleep(800);
    await autosave.saveNow();
    expect(writes).toEqual([]);
    expect(autosave.getSaveCopyContent()).toBe("<html>final text edit</html>");
    expect(autosave.getState()).toMatchObject({
      status: "unavailable",
      dirty: true,
      errorMessage: "Document no longer exists.",
      recoverableDraftExact: true,
    });
    autosave.destroy();
  });

  test("deletion from a saving listener fences the host write before admission", async () => {
    let writes = 0;
    const autosave = new DesignAutosave(async () => {
      writes += 1;
      return { kind: "saved", sha256: "unexpected" };
    });
    let deleted = false;
    autosave.subscribe((state) => {
      if (state.status === "saving" && !deleted) {
        deleted = true;
        autosave.markUnavailable("Deleted before host write admission.");
      }
    });
    autosave.markInitialLoad("<html>base</html>", "base", 1);
    autosave.notifyChange("<html>draft</html>");
    expect(await autosave.flush()).toMatchObject({
      status: "unavailable",
      dirty: true,
      documentSaved: false,
    });
    expect(writes).toBe(0);
    expect(autosave.getSaveCopyContent()).toBe("<html>draft</html>");
    autosave.destroy();
  });

  test("flush awaits an admitted write but its completion cannot revive a deleted document", async () => {
    let releaseWrite!: () => void;
    let writes = 0;
    const autosave = new DesignAutosave(async () => {
      writes += 1;
      await new Promise<void>((resolve) => { releaseWrite = resolve; });
      return { kind: "saved", sha256: "stale-success", revision: 99 };
    });
    autosave.markInitialLoad("<html>base</html>", "base", 1);
    autosave.notifyChange("<html>dirty</html>");
    void autosave.saveNow();
    autosave.markUnavailable("Deleted while saving.");
    const flushing = autosave.flush();
    let flushFinished = false;
    void flushing.then(() => { flushFinished = true; });
    await Promise.resolve();
    expect(flushFinished).toBe(false);

    releaseWrite();
    expect(await flushing).toMatchObject({
      status: "unavailable",
      dirty: true,
      documentSaved: false,
    });
    expect(writes).toBe(1);
    expect(autosave.getSavedSnapshot()).toEqual({
      content: "<html>base</html>", sha256: "base", revision: 1,
    });
    expect(autosave.getSaveCopyContent()).toBe("<html>dirty</html>");
    autosave.destroy();
  });

  test("a fresh initial load resets deletion while fencing the former document write", async () => {
    let releaseOldWrite!: () => void;
    const writes: Array<{
      content: string;
      base: { sha256: string | null; revision: number | null };
    }> = [];
    const autosave = new DesignAutosave(async (content, base) => {
      writes.push({ content, base });
      if (writes.length === 1) {
        await new Promise<void>((resolve) => { releaseOldWrite = resolve; });
        return { kind: "saved", sha256: "stale-old", revision: 99 };
      }
      return { kind: "saved", sha256: "fresh-saved", revision: 8 };
    });
    autosave.markInitialLoad("<html>old base</html>", "old", 1);
    autosave.notifyChange("<html>old draft</html>");
    const oldSave = autosave.saveNow();
    autosave.markUnavailable("Old document deleted.");

    autosave.markInitialLoad("<html>fresh base</html>", "fresh", 7);
    autosave.notifyChange("<html>fresh draft</html>");
    const freshFlush = autosave.flush();
    releaseOldWrite();
    await Promise.all([oldSave, freshFlush]);

    expect(writes).toEqual([
      {
        content: "<html>old draft</html>",
        base: { sha256: "old", revision: 1 },
      },
      {
        content: "<html>fresh draft</html>",
        base: { sha256: "fresh", revision: 7 },
      },
    ]);
    expect(autosave.getSavedSnapshot()).toEqual({
      content: "<html>fresh draft</html>", sha256: "fresh-saved", revision: 8,
    });
    expect(autosave.getState()).toMatchObject({ status: "saved", dirty: false });
    autosave.destroy();
  });
});
