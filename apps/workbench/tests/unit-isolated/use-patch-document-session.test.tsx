import { reapplyHappyDomGlobals } from "../bun-dom-preload";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ConflictError, DocumentPatchConflictError } from "@nautilo/api-client/browser";
import {
  applyAnchoredTextPatch,
  deriveAnchoredTextPatch,
  type DocumentPatchEvent,
} from "@nautilo/types";
import {
  artifactOpenFileTarget,
  fsOpenFileTarget,
  type OpenFileTarget,
} from "../../src/components/browser-column/open-file-target";
import type { LoadEditableTextResult } from "../../src/editors/editor-io";
import { isLocalFsSaveSha, clearLocalFsSaveShasForTests } from "../../src/editors/local-fs-save-shas";

type PendingTimer = { fn: () => void; delay: number };

let pendingTimers: PendingTimer[] = [];
let realSetTimeout: typeof setTimeout | undefined;
let realClearTimeout: typeof clearTimeout | undefined;

const applyPatchMock = mock(
  async (
    _id: string,
    body: {
      patch: { oldString: string; newString: string };
      clientMutationId?: string;
      requestId?: string;
    },
  ) => ({
    kind: "applied" as const,
    target: {
      kind: "artifact" as const,
      artifactInternalId: "art-1",
      path: "notes.txt",
    },
    patchId: "patch-1",
    requestId: body.requestId ?? "req-1",
    revision: 9,
    sha256: `sha-${body.patch.newString}`,
    author: { kind: "human" as const, displayName: "You" },
    patch: body.patch,
    unifiedDiff: "",
    rebased: false,
  }),
);

const saveArtifactMock = mock(async () => ({
  id: "art-1",
  revision: 99,
  size: 5,
  sha256: "snapshot-sha",
}));

type ArtifactEventHandler = (event: unknown) => void | Promise<void>;
let artifactEventHandler: ArtifactEventHandler | null = null;
let artifactEventOptions: { onReconnect?: () => void | Promise<void> } | undefined;

const subscribeWorkspaceArtifactEventsMock = mock(
  (handler: ArtifactEventHandler, options?: { onReconnect?: () => void }) => {
    artifactEventHandler = handler;
    artifactEventOptions = options;
    return () => {
      artifactEventHandler = null;
    };
  },
);

mock.module("../../src/artifacts/workspace-artifacts-provider", () => ({
  useWorkspaceArtifactEventHub: () => subscribeWorkspaceArtifactEventsMock,
}));

mock.module("../../src/lib/api", () => ({
  apiClient: {
    applyWorkspaceArtifactPatch: applyPatchMock,
    saveWorkspaceArtifactContent: saveArtifactMock,
    subscribeWorkspaceArtifactEvents: subscribeWorkspaceArtifactEventsMock,
  },
}));

const readFileMock = mock(async () => "hello\n");
type FsWriteOptions = {
  baseSha256?: string | null;
  checkpoint?: boolean;
  requestId?: string;
  clientMutationId?: string;
  anchoredPatch?: unknown;
};

const writeFileMock = mock(
  async (_path: string, content: string, opts?: FsWriteOptions) => ({
    ok: true as const,
    sha256: `sha-${content}`,
    size: content.length,
  }),
);

function firstWriteCall(): [string, string, FsWriteOptions | undefined] {
  const call = writeFileMock.mock.calls[0] as unknown as
    | [string, string, FsWriteOptions | undefined]
    | undefined;
  if (!call) throw new Error("Expected a filesystem write call.");
  return call;
}
const statMock = mock(async () => ({
  exists: true,
  isFile: true,
  isDirectory: false,
  size: 5,
  modified: null,
  documentIdentity: {
    kind: "local_file" as const,
    relayId: "relay-1",
    canonicalPath: "/tmp/workspace/notes.txt",
  },
}));
const watchRootMock = mock(async () => {});
type DirectoryChangeHandler = (event: {
  rootPath: string;
  path: string;
  changedPath?: string;
  patchEvent?: DocumentPatchEvent;
  reloadRequired?: boolean;
}) => void;
let directoryChangeHandler: DirectoryChangeHandler | null = null;
const onDirectoryChangedMock = mock((handler: DirectoryChangeHandler) => {
  directoryChangeHandler = handler;
  return () => {
    directoryChangeHandler = null;
  };
});

mock.module("../../src/lib/desktop", () => ({
  isDesktop: true,
  getDesktopRelayId: async () => null,
  getDesktopLocalHumanEditLeaseAPI: () => null,
  desktopAPI: {
    fs: {
      readFile: readFileMock,
      writeFile: writeFileMock,
      stat: statMock,
      watchRoot: watchRootMock,
      onDirectoryChanged: onDirectoryChangedMock,
    },
  },
}));

mock.module("../../src/hooks/use-auth", () => ({
  useAuth: () => ({ viewer: { isVerified: false, sessionUserId: null }, viewerGeneration: 0 }),
}));

const saveConflictCopyMock = mock(async () => ({
  kind: "saved" as const,
  path: "notes.conflict-copy.txt",
}));

mock.module("../../src/editors/editor-conflict-copy", () => ({
  saveConflictCopy: saveConflictCopyMock,
  buildConflictCopyFileName: (name: string) => `${name}.conflict-copy`,
  resolveAvailableConflictCopyName: (name: string) => `${name}.conflict-copy`,
}));

const {
  CHANGED_EVENT_RELOAD_DELAY_MS,
  usePatchDocumentSession,
} = await import("../../src/editors/use-patch-document-session");
const { deriveExactAnchoredTextPatch } = await import("@nautilo/types");
const { AUTOSAVE_DEBOUNCE_MS } = await import("../../src/editors/use-doc-editor");
const { sha256HexForText } = await import("../../src/editors/editor-io");

function flushTimers() {
  const batch = pendingTimers.splice(0);
  for (const { fn } of batch) {
    fn();
  }
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  pendingTimers = [];
  realSetTimeout = globalThis.setTimeout;
  realClearTimeout = globalThis.clearTimeout;
  reapplyHappyDomGlobals();
  globalThis.localStorage.clear();
  artifactEventHandler = null;
  artifactEventOptions = undefined;
  applyPatchMock.mockClear();
  saveArtifactMock.mockClear();
  subscribeWorkspaceArtifactEventsMock.mockClear();
  readFileMock.mockClear();
  writeFileMock.mockClear();
  statMock.mockClear();
  watchRootMock.mockClear();
  onDirectoryChangedMock.mockClear();
  directoryChangeHandler = null;
  saveConflictCopyMock.mockClear();
  clearLocalFsSaveShasForTests();
  readFileMock.mockImplementation(async () => "hello\n");
  writeFileMock.mockImplementation(
    async (_path: string, content: string) => ({
      ok: true as const,
      sha256: `sha-${content}`,
      size: content.length,
    }),
  );

  globalThis.setTimeout = ((fn: () => void, delay?: number) => {
    pendingTimers.push({ fn, delay: delay ?? 0 });
    return pendingTimers.length as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
    const index = Number(id) - 1;
    if (index >= 0 && index < pendingTimers.length) {
      pendingTimers.splice(index, 1);
    }
  }) as typeof clearTimeout;
});

afterEach(() => {
  if (realSetTimeout) globalThis.setTimeout = realSetTimeout;
  if (realClearTimeout) globalThis.clearTimeout = realClearTimeout;
  pendingTimers = [];
});

const artifactFile = artifactOpenFileTarget({
  id: "art-1",
  path: "notes.txt",
  mimeType: "text/plain",
  roomId: "room-1",
});

function readyLoad(
  content: string,
  revision = 2,
): Extract<LoadEditableTextResult, { kind: "ready" }> {
  return {
    kind: "ready",
    content,
    baseSha256: `sha-${content}`,
    baseRevision: revision,
  };
}

const fsFile = fsOpenFileTarget(
  "/tmp/workspace/notes.txt",
  "/tmp/workspace",
) as Extract<OpenFileTarget, { kind: "fs" }>;

function renderPatchSession(
  initialContent = "hello\n",
  loadLatest?: () => Promise<LoadEditableTextResult>,
  file: OpenFileTarget = artifactFile,
  baseSha256 = `sha-${initialContent}`,
) {
  return renderHook(() =>
    usePatchDocumentSession({
      file,
      initialContent,
      baseSha256,
      baseRevision: file.kind === "artifact" ? 1 : null,
      loadLatest,
    }),
  );
}

describe("usePatchDocumentSession", () => {
  test("overlapping initial snapshot saves are serialized", async () => {
    let complete!: (value: Awaited<ReturnType<typeof saveArtifactMock>>) => void;
    saveArtifactMock.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const { result } = renderPatchSession("");
    act(() => result.current.setDraftFromEditor("pasted text\n"));
    let saving!: Promise<boolean>;
    await act(async () => {
      saving = result.current.saveNow({ checkpoint: true });
      await flushPromises();
      await result.current.saveNow({ checkpoint: true });
    });
    const writeCount = saveArtifactMock.mock.calls.length;
    await act(async () => {
      complete({ id: "art-1", revision: 2, size: 12, sha256: "pasted-sha" });
      await saving;
      await flushPromises();
    });
    expect(writeCount).toBe(1);
    expect(result.current.status).toBe("saved");
    expect(result.current.draft).toBe("pasted text\n");
  });

  test("first-save acknowledgement preserves and saves edits made during the write", async () => {
    let complete!: (value: Awaited<ReturnType<typeof saveArtifactMock>>) => void;
    saveArtifactMock.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const { result } = renderPatchSession("");
    act(() => result.current.setDraftFromEditor("first line\n"));
    let saving!: Promise<boolean>;
    await act(async () => {
      saving = result.current.saveNow({ checkpoint: true });
      await flushPromises();
    });
    act(() => result.current.setDraftFromEditor("first line\nsecond line\n"));
    await act(async () => {
      complete({ id: "art-1", revision: 2, size: 11, sha256: "first-sha" });
      await saving;
      await flushPromises();
    });
    expect(result.current.draft).toBe("first line\nsecond line\n");
    expect(applyPatchMock).toHaveBeenCalledTimes(1);
    expect(applyPatchMock.mock.calls[0]?.[1]).toMatchObject({ baseRevision: 2, baseSha256: "first-sha" });
    expect(result.current.dirty).toBe(false);
  });

  test("failed conflict reload reports the error and can be retried", async () => {
    saveArtifactMock.mockImplementationOnce(async () => { throw new ConflictError("remote-sha"); });
    const loadLatest = mock(async (): Promise<LoadEditableTextResult> => ({ kind: "error", message: "Read failed." }));
    const { result } = renderPatchSession("", loadLatest);
    act(() => result.current.setDraftFromEditor("mine\n"));
    await act(async () => { await result.current.saveNow({ checkpoint: true }); });
    expect(result.current.status).toBe("conflict");
    expect(result.current.conflictLoading).toBe(false);
    expect(result.current.conflictLoadError).toBe("Read failed.");
    expect(result.current.draft).toBe("mine\n");
    loadLatest.mockImplementation(async () => readyLoad("", 2));
    await act(async () => { await result.current.retryConflict(); });
    expect(result.current.conflict?.latestContent).toBe("");
    expect(result.current.conflictLoading).toBe(false);
    expect(result.current.conflictLoadError).toBeNull();
    act(() => result.current.takeTheirs());
    expect(result.current.draft).toBe("");
    expect(result.current.conflict).toBeNull();
  });

  test("merge and save uses the displayed latest revision for snapshot CAS", async () => {
    const loadLatest = mock(async (): Promise<LoadEditableTextResult> => readyLoad("remote\n", 3));
    const { result } = renderPatchSession("base\n", loadLatest);
    act(() => result.current.setDraftFromEditor("mine\n"));
    await act(async () => { await artifactEventOptions?.onReconnect?.(); });
    expect(result.current.status).toBe("conflict");
    act(() => result.current.setDraftFromEditor("merged\n"));
    await act(async () => { await result.current.markMergedAndSave(); });
    expect(saveArtifactMock.mock.calls.at(-1)?.[2]).toMatchObject({ baseRevision: 3, baseSha256: "sha-remote\n" });
    expect(result.current.draft).toBe("merged\n");
    expect(result.current.conflict).toBeNull();
  });

  test("manual first-save acknowledgement leaves later edits dirty when autosave is off", async () => {
    let complete!: (value: Awaited<ReturnType<typeof saveArtifactMock>>) => void;
    saveArtifactMock.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const { result } = renderPatchSession("");
    act(() => {
      result.current.setAutosaveEnabled(false);
      result.current.setDraftFromEditor("first\n");
    });
    let saving!: Promise<boolean>;
    await act(async () => {
      saving = result.current.saveNow({ checkpoint: true });
      await flushPromises();
    });
    act(() => result.current.setDraftFromEditor("first\nlater\n"));
    await act(async () => {
      complete({ id: "art-1", revision: 2, size: 6, sha256: "first-sha" });
      expect(await saving).toBe(false);
    });
    expect(result.current.draft).toBe("first\nlater\n");
    expect(result.current.dirty).toBe(true);
    expect(applyPatchMock).toHaveBeenCalledTimes(0);
    await act(async () => { await result.current.saveNow({ checkpoint: true }); });
    expect(applyPatchMock.mock.calls[0]?.[1]).toMatchObject({ baseRevision: 2 });
    expect(applyPatchMock.mock.calls[0]?.[1]?.patch.newString).toContain("later");
  });

  test("merge loses a second CAS race without discarding the merged draft", async () => {
    const loadLatest = mock(async (): Promise<LoadEditableTextResult> => readyLoad("remote\n", 3));
    const { result } = renderPatchSession("base\n", loadLatest);
    act(() => result.current.setDraftFromEditor("mine\n"));
    await act(async () => { await artifactEventOptions?.onReconnect?.(); });
    act(() => result.current.setDraftFromEditor("merged\n"));
    saveArtifactMock.mockImplementationOnce(async () => { throw new ConflictError("new-remote-sha"); });
    loadLatest.mockImplementation(async () => readyLoad("new remote\n", 4));
    await act(async () => { expect(await result.current.markMergedAndSave()).toBe(false); });
    expect(result.current.status).toBe("conflict");
    expect(result.current.draft).toBe("merged\n");
    expect(result.current.conflict?.latestContent).toBe("new remote\n");
    expect(result.current.dirty).toBe(true);
    expect(saveArtifactMock).toHaveBeenCalledTimes(1);
  });

  test("thrown latest-version reads remain recoverable without another autosave", async () => {
    const loadLatest = mock(async (): Promise<LoadEditableTextResult> => readyLoad("remote\n", 3));
    const { result } = renderPatchSession("base\n", loadLatest);
    act(() => result.current.setDraftFromEditor("mine\n"));
    await act(async () => { await artifactEventOptions?.onReconnect?.(); });
    expect(loadLatest).toHaveBeenCalledTimes(1);
    loadLatest.mockImplementation(async () => { throw new Error("Connection lost."); });
    await act(async () => { await result.current.retryConflict(); });
    expect(result.current.conflictLoading).toBe(false);
    expect(result.current.conflictLoadError).toBe("Connection lost.");
    await act(async () => {
      flushTimers();
      await result.current.saveNow({ checkpoint: true });
    });
    expect(applyPatchMock).toHaveBeenCalledTimes(0);
    expect(saveArtifactMock).toHaveBeenCalledTimes(0);
    expect(result.current.draft).toBe("mine\n");
  });

  test("Keep Mine recovers after a failed latest read while ordinary save remains blocked", async () => {
    saveArtifactMock.mockImplementationOnce(async () => { throw new ConflictError("remote-sha"); });
    const loadLatest = mock(async (): Promise<LoadEditableTextResult> => ({ kind: "error", message: "Read failed." }));
    const { result } = renderPatchSession("", loadLatest);
    act(() => result.current.setDraftFromEditor("retained paste\n"));
    await act(async () => { await result.current.saveNow({ checkpoint: true }); });
    expect(result.current.status).toBe("conflict");
    await act(async () => { expect(await result.current.saveNow({ checkpoint: true })).toBe(false); });
    expect(saveArtifactMock).toHaveBeenCalledTimes(1);
    await act(async () => { expect(await result.current.keepMine()).toBe(true); });
    expect(saveArtifactMock).toHaveBeenCalledTimes(2);
    expect(saveArtifactMock.mock.calls.at(-1)?.[2]).toMatchObject({ baseRevision: null, baseSha256: null });
    expect(result.current.draft).toBe("retained paste\n");
    expect(result.current.conflict).toBeNull();
    expect(result.current.status).toBe("saved");
  });

  test("failed Keep Mine does not leave a superseded latest-version read loading forever", async () => {
    const loadLatest = mock(async (): Promise<LoadEditableTextResult> => readyLoad("remote\n", 3));
    const { result } = renderPatchSession("base\n", loadLatest);
    act(() => result.current.setDraftFromEditor("mine\n"));
    await act(async () => { await artifactEventOptions?.onReconnect?.(); });
    let complete!: (value: LoadEditableTextResult) => void;
    loadLatest.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    let retrying!: Promise<void>;
    await act(async () => {
      retrying = result.current.retryConflict();
      await flushPromises();
    });
    expect(result.current.conflictLoading).toBe(true);
    saveArtifactMock.mockImplementationOnce(async () => { throw new Error("Save failed."); });
    await act(async () => { expect(await result.current.keepMine()).toBe(false); });
    await act(async () => {
      complete(readyLoad("outdated read\n", 3));
      await retrying;
    });
    expect(result.current.conflictLoading).toBe(false);
    expect(result.current.conflictLoadError).toBeTruthy();
    expect(result.current.draft).toBe("mine\n");
    expect(result.current.conflict?.latestContent).toBeNull();
  });

  test("local edit sends patch, not saveWorkspaceArtifactContent", async () => {
    const { result } = renderPatchSession();

    act(() => {
      result.current.setDraftFromEditor("hello!\n");
    });

    await act(async () => {
      flushTimers();
      await flushPromises();
    });

    expect(applyPatchMock).toHaveBeenCalledTimes(1);
    expect(saveArtifactMock).toHaveBeenCalledTimes(0);
    expect(applyPatchMock.mock.calls[0]?.[1]?.target).toEqual({
      kind: "artifact",
      artifactInternalId: "art-1",
      path: "notes.txt",
      roomId: "room-1",
      mimeType: "text/plain",
    });
  });

  test("empty artifact edit falls back to initial snapshot save", async () => {
    const emptySha = await sha256HexForText("");
    const { result } = renderPatchSession("", undefined, artifactFile, emptySha);

    act(() => {
      result.current.setDraftFromEditor("first line\n");
    });

    await act(async () => {
      flushTimers();
      await flushPromises();
    });

    expect(applyPatchMock).toHaveBeenCalledTimes(0);
    expect(saveArtifactMock).toHaveBeenCalledTimes(1);
    expect(saveArtifactMock.mock.calls[0]?.[1]).toBe("first line\n");
    expect(saveArtifactMock.mock.calls[0]?.[2]).toMatchObject({
      baseSha256: emptySha,
      checkpoint: true,
    });
    expect(result.current.status).toBe("saved");
    expect(result.current.dirty).toBe(false);
  });

  test("durable editor patch updates a snapshot-saved artifact without legacy catch-up", async () => {
    const emptySha = await sha256HexForText("");
    const remotePatch = deriveAnchoredTextPatch("first line\n", "first line\nremote\n")!;
    const { result } = renderPatchSession("", undefined, artifactFile, emptySha);

    act(() => {
      result.current.setDraftFromEditor("first line\n");
    });

    await act(async () => {
      flushTimers();
      await flushPromises();
    });

    await act(async () => {
      await artifactEventHandler?.({
        type: "document.mutation.committed",
        operationId: "workspace-editor:test",
        revisionGroupId: "group-test",
        sequence: 0,
        outcome: "applied",
        actor: { kind: "human", humanId: "human-1" },
        mutation: "update",
        path: {
          kind: "update",
          before: { kind: "workspace_artifact", artifactId: "art-1", logicalPath: "notes.txt" },
          after: { kind: "workspace_artifact", artifactId: "art-1", logicalPath: "notes.txt" },
        },
        before: {
          identity: { kind: "workspace_artifact", artifactId: "art-1", logicalPath: "notes.txt" },
          backendVersion: { kind: "artifact_revision", revision: 99 },
          sha256: "snapshot-sha",
        },
        after: {
          identity: { kind: "workspace_artifact", artifactId: "art-1", logicalPath: "notes.txt" },
          backendVersion: { kind: "artifact_revision", revision: 100 },
          sha256: await sha256HexForText("first line\nremote\n"),
        },
        editorSave: { checkpoint: false, anchoredPatch: remotePatch },
      });
    });

    await act(async () => {
      flushTimers();
      await flushPromises();
    });

    expect(result.current.draft).toBe("first line\nremote\n");
    expect(result.current.dirty).toBe(false);
  });

  test("durable snapshot save safely reloads instead of inventing a patch", async () => {
    const loadLatest = mock(async (): Promise<LoadEditableTextResult> =>
      readyLoad("authoritative snapshot\n", 7),
    );
    const { result } = renderPatchSession("hello\n", loadLatest);

    await act(async () => {
      await artifactEventHandler?.({
        type: "document.mutation.committed",
        operationId: "workspace-editor:snapshot",
        revisionGroupId: "group-snapshot",
        sequence: 0,
        outcome: "applied",
        actor: { kind: "human", humanId: "human-1" },
        mutation: "update",
        path: {
          kind: "update",
          before: { kind: "workspace_artifact", artifactId: "art-1", logicalPath: "notes.txt" },
          after: { kind: "workspace_artifact", artifactId: "art-1", logicalPath: "notes.txt" },
        },
        before: {
          identity: { kind: "workspace_artifact", artifactId: "art-1", logicalPath: "notes.txt" },
          backendVersion: { kind: "artifact_revision", revision: 1 },
          sha256: "sha-before",
        },
        after: {
          identity: { kind: "workspace_artifact", artifactId: "art-1", logicalPath: "notes.txt" },
          backendVersion: { kind: "artifact_revision", revision: 7 },
          sha256: "sha-after",
        },
        editorSave: { checkpoint: true },
      });
    });

    await act(async () => {
      flushTimers();
      await flushPromises();
    });

    expect(loadLatest).toHaveBeenCalledTimes(1);
    expect(result.current.draft).toBe("authoritative snapshot\n");
  });

  test("fast typing ack advances base and queues next patch", async () => {
    let resolveFirst: ((value: unknown) => void) | undefined;
    applyPatchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );

    const { result } = renderPatchSession();

    act(() => {
      result.current.setDraftFromEditor("hello!\n");
    });

    await act(async () => {
      flushTimers();
      await flushPromises();
    });

    expect(applyPatchMock).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.setDraftFromEditor("hello!!\n");
    });

    await act(async () => {
      resolveFirst?.({
        kind: "applied",
        target: {
          kind: "artifact",
          artifactInternalId: "art-1",
          path: "notes.txt",
        },
        patchId: "patch-1",
        requestId: "req-1",
        revision: 8,
        sha256: "sha-hello!",
        author: { kind: "human", displayName: "You" },
        patch: deriveAnchoredTextPatch("hello\n", "hello!\n")!,
        unifiedDiff: "",
        rebased: false,
      });
      await flushPromises();
    });

    expect(result.current.draft).toBe("hello!!\n");
    expect(result.current.dirty).toBe(true);

    await act(async () => {
      flushTimers();
      await flushPromises();
    });

    expect(applyPatchMock).toHaveBeenCalledTimes(2);
    expect(saveArtifactMock).toHaveBeenCalledTimes(0);
  });

  test("remote non-overlap patch updates draft and base", async () => {
    const { result } = renderPatchSession("alpha\nbeta\n");

    const remotePatch = deriveAnchoredTextPatch("alpha\nbeta\n", "alpha\nBETA\n")!;

    await act(async () => {
      await artifactEventHandler?.({
        type: "document.patch.applied",
        target: {
          kind: "artifact",
          artifactInternalId: "art-1",
          path: "notes.txt",
        },
        patchId: "remote-1",
        revision: 5,
        sha256: await sha256HexForText("alpha\nBETA\n"),
        previousRevision: 1,
        previousSha256: "sha-alpha\nbeta\n",
        patch: remotePatch,
        author: { kind: "agent", displayName: "Genie" },
      });
    });

    expect(result.current.draft).toBe("alpha\nBETA\n");
    expect(result.current.dirty).toBe(false);
  });

  test("missed predecessor exact patch resyncs instead of applying out of order", async () => {
    const loadLatest = mock(async (): Promise<LoadEditableTextResult> =>
      readyLoad("authoritative latest\n", 6),
    );
    const { result } = renderPatchSession("alpha\n", loadLatest);
    await act(async () => {
      await artifactEventHandler?.({
        type: "document.patch.applied",
        target: { kind: "artifact", artifactInternalId: "art-1", path: "notes.txt" },
        patchId: "out-of-order",
        revision: 6,
        sha256: await sha256HexForText("beta\n"),
        previousRevision: 5,
        previousSha256: "missed-sha",
        patch: { kind: "anchored_text", oldString: "alpha\n", newString: "beta\n" },
        author: { kind: "agent", displayName: "Genie" },
      });
    });
    expect(loadLatest).toHaveBeenCalledTimes(1);
    expect(result.current.draft).toBe("authoritative latest\n");
  });

  test("delayed A-to-B verification cannot regress an out-of-order B-to-C resync", async () => {
    const betaSha = await sha256HexForText("beta\n");
    const gammaSha = await sha256HexForText("gamma\n");
    const loadLatest = mock(async (): Promise<LoadEditableTextResult> =>
      readyLoad("gamma\n", 3),
    );
    const { result } = renderPatchSession("alpha\n", loadLatest);
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    let releaseDigest!: () => void;
    let signalDigestEntered!: () => void;
    const digestGate = new Promise<void>((resolve) => { releaseDigest = resolve; });
    const digestEntered = new Promise<void>((resolve) => { signalDigestEntered = resolve; });
    Object.defineProperty(crypto.subtle, "digest", {
      configurable: true,
      value: async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
        if (new TextDecoder().decode(data) === "beta\n") {
          signalDigestEntered();
          await digestGate;
        }
        return originalDigest(algorithm, data);
      },
    });
    try {
      await act(async () => {
        const delayedAB = artifactEventHandler?.({
          type: "document.patch.applied",
          target: { kind: "artifact", artifactInternalId: "art-1", path: "notes.txt" },
          patchId: "patch-a-b",
          revision: 2,
          sha256: betaSha,
          previousRevision: 1,
          previousSha256: "sha-alpha\n",
          patch: { kind: "anchored_text", oldString: "alpha\n", newString: "beta\n" },
        });
        await digestEntered;
        await artifactEventHandler?.({
          type: "document.patch.applied",
          target: { kind: "artifact", artifactInternalId: "art-1", path: "notes.txt" },
          patchId: "patch-b-c",
          revision: 3,
          sha256: gammaSha,
          previousRevision: 2,
          previousSha256: betaSha,
          patch: { kind: "anchored_text", oldString: "beta\n", newString: "gamma\n" },
        });
        releaseDigest();
        await delayedAB;
      });
      expect(loadLatest).toHaveBeenCalled();
      expect(result.current.draft).toBe("gamma\n");
    } finally {
      releaseDigest();
      Object.defineProperty(crypto.subtle, "digest", {
        configurable: true,
        value: originalDigest,
      });
    }
  });

  test("generation advance during delayed verification resyncs current generation without sticking", async () => {
    const betaSha = await sha256HexForText("beta\n");
    const loadLatest = mock(async (): Promise<LoadEditableTextResult> =>
      readyLoad("authoritative latest\n", 3),
    );
    const { result } = renderPatchSession("alpha\n", loadLatest);
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    let releaseDigest!: () => void;
    let signalDigestEntered!: () => void;
    const digestGate = new Promise<void>((resolve) => { releaseDigest = resolve; });
    const digestEntered = new Promise<void>((resolve) => { signalDigestEntered = resolve; });
    Object.defineProperty(crypto.subtle, "digest", {
      configurable: true,
      value: async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
        if (new TextDecoder().decode(data) === "beta\n") {
          signalDigestEntered();
          await digestGate;
        }
        return originalDigest(algorithm, data);
      },
    });
    try {
      await act(async () => {
        const delayedRemote = artifactEventHandler?.({
          type: "document.patch.applied",
          target: { kind: "artifact", artifactInternalId: "art-1", path: "notes.txt" },
          patchId: "patch-a-b",
          revision: 2,
          sha256: betaSha,
          previousRevision: 1,
          previousSha256: "sha-alpha\n",
          patch: { kind: "anchored_text", oldString: "alpha\n", newString: "beta\n" },
        });
        await digestEntered;
        await result.current.keepMine();
        releaseDigest();
        await delayedRemote;
      });
      expect(loadLatest).toHaveBeenCalledTimes(1);
      expect(result.current.draft).toBe("authoritative latest\n");
      expect(result.current.status).toBe("idle");
      expect(result.current.status).not.toBe("resyncing");
    } finally {
      releaseDigest();
      Object.defineProperty(crypto.subtle, "digest", {
        configurable: true,
        value: originalDigest,
      });
    }
  });

  test("own patch event is ignored", async () => {
    const { result } = renderPatchSession("hello\n");

    act(() => {
      result.current.setDraftFromEditor("hello!\n");
    });

    await act(async () => {
      flushTimers();
      await flushPromises();
    });

    const sentMutationId = applyPatchMock.mock.calls[0]?.[1]?.clientMutationId as string;
    expect(sentMutationId).toBeTruthy();

    await act(async () => {
      await artifactEventHandler?.({
        type: "document.patch.applied",
        target: {
          kind: "artifact",
          artifactInternalId: "art-1",
          path: "notes.txt",
        },
        patchId: "own-1",
        revision: 8,
        sha256: "sha-own",
        previousRevision: 1,
        previousSha256: "sha-hello\n",
        patch: deriveAnchoredTextPatch("hello\n", "hello!\n")!,
        author: { kind: "human", displayName: "You" },
        clientMutationId: sentMutationId,
      });
    });

    expect(result.current.draft).toBe("hello!\n");
    expect(result.current.status).toBe("saved");
  });

  test("own changed event does not schedule reload after local patch ack", async () => {
    const loadLatest = mock(async (): Promise<LoadEditableTextResult> =>
      readyLoad("server version\n"),
    );
    const { result } = renderPatchSession("hello\n", loadLatest);

    act(() => {
      result.current.setDraftFromEditor("hello!\n");
    });

    await act(async () => {
      flushTimers();
      await flushPromises();
    });

    const sentMutationId = applyPatchMock.mock.calls[0]?.[1]?.clientMutationId as string;
    expect(sentMutationId).toBeTruthy();

    await act(async () => {
      await artifactEventHandler?.({
        type: "changed",
        id: "art-1",
        artifactId: "ext-id",
        path: "notes.txt",
        clientMutationId: sentMutationId,
      });
    });

    await act(async () => {
      flushTimers();
      await flushPromises();
    });

    expect(loadLatest).toHaveBeenCalledTimes(0);
    expect(result.current.draft).toBe("hello!\n");
  });

  test("changed event delayed reload is canceled by patch event", async () => {
    const loadLatest = mock(async (): Promise<LoadEditableTextResult> =>
      readyLoad("server version\n"),
    );
    const { result } = renderPatchSession("hello\n", loadLatest);

    await act(async () => {
      await artifactEventHandler?.({
        type: "changed",
        id: "art-1",
        artifactId: "ext-id",
        path: "notes.txt",
      });
    });

    const remotePatch = deriveAnchoredTextPatch("hello\n", "hello remote\n")!;

    await act(async () => {
      await artifactEventHandler?.({
        type: "document.patch.applied",
        target: {
          kind: "artifact",
          artifactInternalId: "art-1",
          path: "notes.txt",
        },
        patchId: "remote-2",
        revision: 6,
        sha256: await sha256HexForText("hello remote\n"),
        previousRevision: 1,
        previousSha256: "sha-hello\n",
        patch: remotePatch,
        author: { kind: "agent", displayName: "Genie" },
      });
    });

    await act(async () => {
      flushTimers();
      await flushPromises();
    });

    expect(loadLatest).toHaveBeenCalledTimes(0);
    expect(result.current.draft).toBe("hello remote\n");
    expect(pendingTimers.some((t) => t.delay === CHANGED_EVENT_RELOAD_DELAY_MS)).toBe(false);
  });

  test("changed event takes the authoritative full-resync path", async () => {
    const loadLatest = mock(async (): Promise<LoadEditableTextResult> =>
      readyLoad("server version\n"),
    );
    const { result } = renderPatchSession("hello\n", loadLatest);

    act(() => {
      artifactEventHandler?.({
        type: "changed",
        id: "art-1",
        artifactId: "ext-id",
        path: "notes.txt",
      });
    });

    await act(async () => {
      flushTimers();
      await flushPromises();
    });

    expect(loadLatest).toHaveBeenCalledTimes(1);
    expect(result.current.draft).toBe("server version\n");
  });

  test("EventSource reopen forces an authoritative editor resync", async () => {
    const loadLatest = mock(async (): Promise<LoadEditableTextResult> =>
      readyLoad("missed while disconnected\n", 10),
    );
    renderPatchSession("hello\n", loadLatest);
    await act(async () => {
      await artifactEventOptions?.onReconnect?.();
      flushTimers();
      await flushPromises();
    });
    expect(loadLatest).toHaveBeenCalledTimes(1);
  });

  test("changed event rebases onto the latest snapshot", async () => {
    const loadLatest = mock(async (): Promise<LoadEditableTextResult> =>
      readyLoad("server version\n", 5),
    );
    const { result } = renderPatchSession("hello\n", loadLatest);

    act(() => {
      artifactEventHandler?.({
        type: "changed",
        id: "art-1",
        artifactId: "ext-id",
        path: "notes.txt",
      });
    });

    await act(async () => {
      flushTimers();
      await flushPromises();
    });

    expect(loadLatest).toHaveBeenCalledTimes(1);
    expect(result.current.draft).toBe("server version\n");
    expect(result.current.dirty).toBe(false);
  });

  test("full resync rebases a multi-hunk human draft over a disjoint agent snapshot", async () => {
    const base = "one\ntwo\nthree\nfour\n";
    const humanDraft = "one\ntwo human\nthree\nfour human\n";
    const agentPostimage = "one agent\ntwo\nthree\nfour\n";
    const loadLatest = mock(async (): Promise<LoadEditableTextResult> =>
      readyLoad(agentPostimage, 5),
    );
    const { result } = renderPatchSession(base, loadLatest);

    act(() => result.current.setAutosaveEnabled(false));
    act(() => result.current.setDraftFromEditor(humanDraft));
    act(() => {
      artifactEventHandler?.({
        type: "changed",
        id: "art-1",
        artifactId: "ext-id",
        path: "notes.txt",
      });
    });

    await act(async () => {
      flushTimers();
      await flushPromises();
    });

    expect(result.current.draft).toBe(
      "one agent\ntwo human\nthree\nfour human\n",
    );
    expect(result.current.dirty).toBe(true);
    expect(result.current.status).toBe("unsaved");
  });

  test("full resync preserves the human draft when agent and human edits overlap", async () => {
    const base = "one\ntwo\n";
    const humanDraft = "one human\ntwo\n";
    const agentPostimage = "one agent\ntwo\n";
    const loadLatest = mock(async (): Promise<LoadEditableTextResult> =>
      readyLoad(agentPostimage, 5),
    );
    const { result } = renderPatchSession(base, loadLatest);

    act(() => result.current.setAutosaveEnabled(false));
    act(() => result.current.setDraftFromEditor(humanDraft));
    act(() => {
      artifactEventHandler?.({
        type: "changed",
        id: "art-1",
        artifactId: "ext-id",
        path: "notes.txt",
      });
    });

    await act(async () => {
      flushTimers();
      await flushPromises();
    });

    expect(result.current.draft).toBe(humanDraft);
    expect(result.current.status).toBe("conflict");
    expect(result.current.conflict?.latestContent).toBe(agentPostimage);
  });

  test("reloadRequired changed full resyncs after delay", async () => {
    const loadLatest = mock(async (): Promise<LoadEditableTextResult> =>
      readyLoad("broad rewrite\n", 8),
    );
    const { result } = renderPatchSession("hello\n", loadLatest);

    act(() => {
      artifactEventHandler?.({
        type: "changed",
        id: "art-1",
        artifactId: "ext-id",
        path: "notes.txt",
        reloadRequired: true,
      });
    });

    await act(async () => {
      flushTimers();
      await flushPromises();
    });

    expect(loadLatest).toHaveBeenCalledTimes(1);
    expect(result.current.draft).toBe("broad rewrite\n");
  });

  test("conflict preserves draft and latest content", async () => {
    applyPatchMock.mockImplementationOnce(async () => {
      throw new DocumentPatchConflictError({
        kind: "anchor_not_found",
        latestRevision: 10,
        latestSha256: "sha-server",
      });
    });

    const loadLatest = mock(async (): Promise<LoadEditableTextResult> =>
      readyLoad("server version\n", 10),
    );

    const { result } = renderPatchSession("mine\n", loadLatest);

    act(() => {
      result.current.setDraftFromEditor("mine edited\n");
    });

    await act(async () => {
      flushTimers();
      await flushPromises();
    });

    expect(result.current.status).toBe("conflict");
    expect(result.current.draft).toBe("mine edited\n");
    expect(result.current.conflict?.latestContent).toBe("server version\n");
    expect(saveArtifactMock).toHaveBeenCalledTimes(0);
  });

  test("debounced autosave uses AUTOSAVE_DEBOUNCE_MS", async () => {
    const { result } = renderPatchSession();

    act(() => {
      result.current.setDraftFromEditor("hello!\n");
    });

    expect(pendingTimers[0]?.delay).toBe(AUTOSAVE_DEBOUNCE_MS);
  });

  test("fs local edit writes patched text with current base SHA", async () => {
    const initial = "hello\n";
    const baseSha = await sha256HexForText(initial);
    readFileMock.mockImplementation(async () => initial);
    const { result } = renderPatchSession(initial, undefined, fsFile, baseSha);

    act(() => {
      result.current.setDraftFromEditor("hello!\n");
    });

    await act(async () => {
      flushTimers();
      await flushPromises();
    });

    expect(writeFileMock).toHaveBeenCalledTimes(1);
    const options = firstWriteCall()[2];
    expect(options).toMatchObject({
      baseSha256: baseSha,
      checkpoint: true,
    });
    expect(typeof options?.anchoredPatch).toBe("object");
    expect(typeof options?.clientMutationId).toBe("string");
    expect(options?.requestId).toBe(options?.clientMutationId);
    expect(firstWriteCall()[1]).toBe("hello!\n");
    expect(saveArtifactMock).toHaveBeenCalledTimes(0);
    expect(result.current.status).toBe("saved");
  });

  test("fs markdown normalization persists the exact editor value", async () => {
    const initial =
      "S\n\nSome text&#x20;\n\nBla\n\n\nNew&#x20;\n\nBla";
    const normalizedEdit =
      "S\n\nSome Xtext&#x20;\n\nBla\n\nNew&#x20;\n\nBla";
    const baseSha = await sha256HexForText(initial);
    readFileMock.mockImplementation(async () => initial);
    const compactCandidate = deriveAnchoredTextPatch(initial, normalizedEdit)!;
    expect(applyAnchoredTextPatch(initial, compactCandidate)).not.toEqual({
      ok: true,
      text: normalizedEdit,
    });
    const exactPatch = deriveExactAnchoredTextPatch(initial, normalizedEdit)!;
    expect(applyAnchoredTextPatch(initial, exactPatch)).toEqual({
      ok: true,
      text: normalizedEdit,
    });

    const { result } = renderPatchSession(initial, undefined, fsFile, baseSha);
    act(() => {
      result.current.setDraftFromEditor(normalizedEdit);
    });

    await act(async () => {
      flushTimers();
      await flushPromises();
    });

    expect(writeFileMock).toHaveBeenCalledTimes(1);
    expect(firstWriteCall()[1]).toBe(normalizedEdit);
    const options = firstWriteCall()[2];
    expect(options).toMatchObject({
      baseSha256: baseSha,
      checkpoint: true,
      anchoredPatch: exactPatch,
    });
    expect(typeof options?.clientMutationId).toBe("string");
    expect(typeof options?.requestId).toBe("string");
    expect(result.current.draft).toBe(normalizedEdit);
    expect(result.current.dirty).toBe(false);
    expect(result.current.status).toBe("saved");
  });

  test("empty fs edit falls back to initial snapshot write", async () => {
    const emptySha = await sha256HexForText("");
    const { result } = renderPatchSession("", undefined, fsFile, emptySha);

    act(() => {
      result.current.setDraftFromEditor("first local line\n");
    });

    await act(async () => {
      flushTimers();
      await flushPromises();
    });

    expect(writeFileMock).toHaveBeenCalledTimes(1);
    expect(firstWriteCall()[1]).toBe("first local line\n");
    const options = firstWriteCall()[2];
    expect(options).toMatchObject({
      baseSha256: emptySha,
      checkpoint: true,
    });
    expect(typeof options?.clientMutationId).toBe("string");
    expect(typeof options?.requestId).toBe("string");
    expect(result.current.status).toBe("saved");
    expect(result.current.dirty).toBe(false);
  });

  test("fs stale local content rebases anchored patch", async () => {
    const base = "AAA\nBBB\nCCC\n";
    const external = "AAA\nBBB\nCCC\nDDD\n";
    const baseSha = await sha256HexForText(base);
    const externalSha = await sha256HexForText(external);
    readFileMock.mockImplementation(async () => external);
    const loadLatest = mock(async (): Promise<LoadEditableTextResult> =>
      readyLoad(external, null),
    );
    const { result } = renderPatchSession(base, loadLatest, fsFile, baseSha);

    act(() => {
      result.current.setDraftFromEditor("AAA\nBBB-CHANGED\nCCC\n");
    });

    await act(async () => {
      flushTimers();
      await flushPromises();
    });

    expect(writeFileMock).toHaveBeenCalledTimes(1);
    expect(firstWriteCall()[1]).toBe("AAA\nBBB-CHANGED\nCCC\nDDD\n");
    const options = firstWriteCall()[2];
    expect(options).toMatchObject({
      baseSha256: externalSha,
      checkpoint: true,
    });
    expect(typeof options?.anchoredPatch).toBe("object");
    expect(typeof options?.clientMutationId).toBe("string");
    expect(typeof options?.requestId).toBe("string");
    expect(result.current.draft).toBe("AAA\nBBB-CHANGED\nCCC\nDDD\n");
    expect(result.current.dirty).toBe(false);
  });

  test("failed fs save does not suppress a later external committed event with the same id", async () => {
    const initial = "hello\n";
    const baseSha = await sha256HexForText(initial);
    const latest = "external\n";
    const latestSha = await sha256HexForText(latest);
    const loadLatest = mock(async (): Promise<LoadEditableTextResult> =>
      readyLoad(latest, null),
    );
    writeFileMock.mockImplementationOnce(async () => ({
      ok: false as const,
      code: "error" as const,
      message: "lost response",
    }));
    const { result } = renderPatchSession(initial, loadLatest, fsFile, baseSha);
    act(() => result.current.setDraftFromEditor("mine\n"));
    await act(async () => {
      flushTimers();
      await flushPromises();
    });
    const clientMutationId = firstWriteCall()[2]?.clientMutationId;
    expect(typeof clientMutationId).toBe("string");
    act(() => {
      artifactEventHandler?.({
        type: "document.mutation.committed",
        operationId: "external-op",
        revisionGroupId: "external-group",
        sequence: 0,
        outcome: "applied",
        actor: { kind: "agent", agentId: "agent-1" },
        mutation: "update",
        before: {
          identity: { kind: "local_file", relayId: "relay-1", canonicalPath: fsFile.path },
          backendVersion: { kind: "local_sha", sha256: baseSha },
          sha256: baseSha,
        },
        after: {
          identity: { kind: "local_file", relayId: "relay-1", canonicalPath: fsFile.path },
          backendVersion: { kind: "local_sha", sha256: latestSha },
          sha256: latestSha,
        },
        editorSave: { checkpoint: false, clientMutationId },
      });
    });
    await act(async () => {
      flushTimers();
      await flushPromises();
    });
    expect(loadLatest).toHaveBeenCalled();
  });

  test("clean Current Folder editor reloads an agent committed snapshot", async () => {
    const initial = "before\n";
    const latest = "after\n";
    const baseSha = await sha256HexForText(initial);
    const latestSha = await sha256HexForText(latest);
    const loadLatest = mock(async (): Promise<LoadEditableTextResult> =>
      readyLoad(latest, null),
    );
    const { result } = renderPatchSession(initial, loadLatest, fsFile, baseSha);

    await act(async () => {
      await artifactEventHandler?.({
        type: "document.mutation.committed",
        operationId: "desktop-apply-patch:external",
        revisionGroupId: "external-group",
        sequence: 0,
        outcome: "applied",
        actor: { kind: "agent", agentId: "agent-1" },
        mutation: "update",
        before: {
          identity: { kind: "local_file", relayId: "relay-1", canonicalPath: fsFile.path },
          backendVersion: { kind: "local_sha", sha256: baseSha },
          sha256: baseSha,
        },
        after: {
          identity: { kind: "local_file", relayId: "relay-1", canonicalPath: fsFile.path },
          backendVersion: { kind: "local_sha", sha256: latestSha },
          sha256: latestSha,
        },
      });
      flushTimers();
      await flushPromises();
    });

    expect(loadLatest).toHaveBeenCalledTimes(1);
    expect(result.current.draft).toBe(latest);
    expect(result.current.dirty).toBe(false);
  });

  test("fs missing anchor enters conflict preserving draft and latest", async () => {
    const initial = "hello\n";
    const baseSha = await sha256HexForText(initial);
    readFileMock.mockImplementation(async () => "totally different\n");
    const loadLatest = mock(async (): Promise<LoadEditableTextResult> =>
      readyLoad("totally different\n", null),
    );
    const { result } = renderPatchSession(initial, loadLatest, fsFile, baseSha);

    act(() => {
      result.current.setDraftFromEditor("hello edited\n");
    });

    await act(async () => {
      flushTimers();
      await flushPromises();
    });

    expect(writeFileMock).toHaveBeenCalledTimes(0);
    expect(result.current.status).toBe("conflict");
    expect(result.current.draft).toBe("hello edited\n");
    expect(result.current.conflict?.latestContent).toBe("totally different\n");
  });

  test("Current Folder Keep Mine rereads latest and a second race conflicts", async () => {
    const initial = "hello\n";
    const baseSha = await sha256HexForText(initial);
    const latest = readyLoad("server latest\n", null);
    const loadLatest = mock(async (): Promise<LoadEditableTextResult> => latest);
    const { result } = renderPatchSession(initial, loadLatest, fsFile, baseSha);
    act(() => result.current.setDraftFromEditor("mine\n"));
    writeFileMock.mockImplementationOnce(async () => ({
      ok: false as const,
      code: "conflict" as const,
      currentSha256: "second-race",
    }));
    let kept = true;
    await act(async () => {
      kept = await result.current.keepMine();
    });
    expect(kept).toBe(false);
    expect(loadLatest).toHaveBeenCalledTimes(2);
    expect(firstWriteCall()[2]?.baseSha256).toBe(latest.baseSha256);
    expect(firstWriteCall()[2]?.baseSha256).not.toBeNull();
  });

  test("fs own watcher event is ignored via registered SHA", async () => {
    const initial = "hello\n";
    const baseSha = await sha256HexForText(initial);
    readFileMock.mockImplementation(async () => initial);
    const loadLatest = mock(async (): Promise<LoadEditableTextResult> =>
      readyLoad("external version\n", null),
    );
    const { result } = renderPatchSession(initial, loadLatest, fsFile, baseSha);

    act(() => {
      result.current.setDraftFromEditor("hello!\n");
    });

    await act(async () => {
      flushTimers();
      await flushPromises();
    });

    const writtenContent = firstWriteCall()[1];
    const writtenSha = await sha256HexForText(writtenContent);
    expect(isLocalFsSaveSha(fsFile.path, writtenSha)).toBe(true);

    readFileMock.mockImplementation(async () => writtenContent);
    statMock.mockImplementation(async () => ({
      exists: true,
      isFile: true,
      isDirectory: false,
      size: writtenContent.length,
      modified: null,
    }));

    act(() => {
      directoryChangeHandler?.({
        rootPath: fsFile.rootPath,
        path: fsFile.rootPath,
        changedPath: fsFile.path,
      });
    });

    await act(async () => {
      await flushPromises();
      flushTimers();
      await flushPromises();
    });

    expect(loadLatest).toHaveBeenCalledTimes(0);
    expect(result.current.draft).toBe("hello!\n");
  });

  test("fs external watcher triggers resync/rebase", async () => {
    const initial = "hello\n";
    const baseSha = await sha256HexForText(initial);
    const remote = "hello remote\n";
    readFileMock.mockImplementation(async () => initial);
    const loadLatest = mock(async (): Promise<LoadEditableTextResult> =>
      readyLoad(remote, null),
    );
    const { result } = renderPatchSession(initial, loadLatest, fsFile, baseSha);

    await act(async () => {
      await flushPromises();
    });

    loadLatest.mockClear();

    readFileMock.mockImplementation(async () => remote);
    statMock.mockImplementation(async () => ({
      exists: true,
      isFile: true,
      isDirectory: false,
      size: remote.length,
      modified: null,
    }));

    act(() => {
      directoryChangeHandler?.({
        rootPath: fsFile.rootPath,
        path: fsFile.rootPath,
        changedPath: fsFile.path,
      });
    });

    expect(directoryChangeHandler).not.toBeNull();

    await act(async () => {
      await flushPromises();
    });

    await act(async () => {
      flushTimers();
      await flushPromises();
    });

    expect(loadLatest).toHaveBeenCalledTimes(1);
    expect(result.current.draft).toBe(remote);
    expect(result.current.dirty).toBe(false);
  });

  test("fs external watcher accepts parent-directory events without changedPath", async () => {
    const initial = "hello\n";
    const baseSha = await sha256HexForText(initial);
    const remote = "hello remote\n";
    readFileMock.mockImplementation(async () => initial);
    const loadLatest = mock(async (): Promise<LoadEditableTextResult> =>
      readyLoad(remote, null),
    );
    const { result } = renderPatchSession(initial, loadLatest, fsFile, baseSha);

    await act(async () => {
      await flushPromises();
    });

    loadLatest.mockClear();

    readFileMock.mockImplementation(async () => remote);
    statMock.mockImplementation(async () => ({
      exists: true,
      isFile: true,
      isDirectory: false,
      size: remote.length,
      modified: null,
    }));

    act(() => {
      directoryChangeHandler?.({
        rootPath: fsFile.rootPath,
        path: fsFile.rootPath,
      });
    });

    await act(async () => {
      await flushPromises();
    });

    await act(async () => {
      flushTimers();
      await flushPromises();
    });

    expect(loadLatest).toHaveBeenCalledTimes(1);
    expect(result.current.draft).toBe(remote);
  });

  test("fs relay patch event updates draft without full reload", async () => {
    const initial = "alpha\nbeta\n";
    const baseSha = await sha256HexForText(initial);
    readFileMock.mockImplementation(async () => initial);
    const loadLatest = mock(async (): Promise<LoadEditableTextResult> =>
      readyLoad("SHOULD NOT LOAD\n", null),
    );
    const { result } = renderPatchSession(initial, loadLatest, fsFile, baseSha);

    await act(async () => {
      await flushPromises();
    });

    const patch = deriveAnchoredTextPatch(initial, "ALPHA\nbeta\n")!;
    const afterSha = await sha256HexForText("ALPHA\nbeta\n");
    act(() => {
      directoryChangeHandler?.({
        rootPath: fsFile.rootPath,
        path: fsFile.rootPath,
        changedPath: fsFile.path,
        patchEvent: {
          type: "document.patch.applied",
          target: {
            kind: "currentFile",
            currentFolderRef: fsFile.rootPath,
            relativePath: "notes.txt",
          },
          patchId: "relay-patch-1",
          revision: null,
          sha256: afterSha,
          previousRevision: null,
          previousSha256: baseSha,
          patch,
          author: { kind: "agent", displayName: "Genie" },
        },
      });
    });
    await act(async () => {
      await flushPromises();
    });

    expect(loadLatest).toHaveBeenCalledTimes(0);
    expect(result.current.draft).toBe("ALPHA\nbeta\n");
    expect(result.current.dirty).toBe(false);
  });

  test("local dirty draft rebases over remote non-overlapping patch and stays dirty", async () => {
    const { result } = renderPatchSession("alpha\nbeta\n");

    act(() => {
      result.current.setDraftFromEditor("alpha\nbeta EDITED\n");
    });

    const remotePatch = deriveAnchoredTextPatch("alpha\nbeta\n", "ALPHA\nbeta\n")!;

    await act(async () => {
      await artifactEventHandler?.({
        type: "document.patch.applied",
        target: {
          kind: "artifact",
          artifactInternalId: "art-1",
          path: "notes.txt",
        },
        patchId: "remote-non-overlap",
        revision: 4,
        sha256: await sha256HexForText("ALPHA\nbeta\n"),
        previousRevision: 1,
        previousSha256: "sha-alpha\nbeta\n",
        patch: remotePatch,
        author: { kind: "agent", displayName: "Genie" },
      });
    });

    expect(result.current.draft).toBe("ALPHA\nbeta EDITED\n");
    expect(result.current.dirty).toBe(true);
    expect(result.current.status).toBe("unsaved");
  });

  test("outbound conflict rebases onto latest and sends second patch", async () => {
    applyPatchMock
      .mockImplementationOnce(async () => {
        throw new DocumentPatchConflictError({
          kind: "anchor_not_found",
          latestRevision: 10,
          latestSha256: "sha-server",
        });
      })
      .mockImplementationOnce(async (_id, body) => ({
        kind: "applied" as const,
        target: {
          kind: "artifact" as const,
          artifactInternalId: "art-1",
          path: "notes.txt",
        },
        patchId: "patch-2",
        requestId: body.requestId ?? "req-2",
        revision: 11,
        sha256: "sha-rebased",
        author: { kind: "human" as const, displayName: "You" },
        patch: body.patch,
        unifiedDiff: "",
        rebased: true,
      }));

    const loadLatest = mock(async (): Promise<LoadEditableTextResult> =>
      readyLoad("REMOTE\nbeta\n", 10),
    );

    const { result } = renderPatchSession("alpha\nbeta\n", loadLatest);

    act(() => {
      result.current.setDraftFromEditor("alpha\nbeta EDITED\n");
    });

    await act(async () => {
      flushTimers();
      await flushPromises();
    });

    expect(applyPatchMock).toHaveBeenCalledTimes(2);
    expect(result.current.conflict).toBeNull();
    expect(result.current.dirty).toBe(false);
    expect(result.current.draft).toBe("REMOTE\nbeta EDITED\n");
  });

  test("network failure while offline queues draft and retries on online", async () => {
    const priorOnLine = Object.getOwnPropertyDescriptor(navigator, "onLine");
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });

    applyPatchMock.mockImplementationOnce(async () => {
      throw new TypeError("Failed to fetch");
    });
    applyPatchMock.mockImplementationOnce(async (_id, body) => ({
      kind: "applied" as const,
      target: {
        kind: "artifact" as const,
        artifactInternalId: "art-1",
        path: "notes.txt",
      },
      patchId: "patch-online",
      requestId: body.requestId ?? "req-online",
      revision: 12,
      sha256: "sha-online",
      author: { kind: "human" as const, displayName: "You" },
      patch: body.patch,
      unifiedDiff: "",
      rebased: false,
    }));

    const { result } = renderPatchSession();

    act(() => {
      result.current.setDraftFromEditor("hello offline\n");
    });

    await act(async () => {
      flushTimers();
      await flushPromises();
    });

    expect(result.current.status).toBe("offline-queued");
    expect(result.current.dirty).toBe(true);

    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });

    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await flushPromises();
    });

    expect(applyPatchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.current.status).toBe("saved");
    expect(result.current.dirty).toBe(false);

    if (priorOnLine) {
      Object.defineProperty(navigator, "onLine", priorOnLine);
    } else {
      Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    }
  });

  test("saveCopy writes draft via conflict copy helper", async () => {
    const { result } = renderPatchSession("mine\n");

    act(() => {
      result.current.setDraftFromEditor("mine edited\n");
    });

    await act(async () => {
      await result.current.saveCopy();
    });

    expect(saveConflictCopyMock).toHaveBeenCalledWith(artifactFile, "mine edited\n");
  });
});
