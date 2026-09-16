/**
 * D448 Phase 6 — characterization of the existing shared Workbench editor
 * session. These assertions intentionally freeze current persistence/event
 * behavior before editor commits move behind the mutation coordinator.
 */

import { reapplyHappyDomGlobals } from "../bun-dom-preload";
import React, { forwardRef, useImperativeHandle } from "react";
import { act, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  applyAnchoredTextPatch,
  deriveAnchoredTextPatch,
  type DocumentPatchEvent,
} from "@nautilo/types";
import {
  artifactOpenFileTarget,
  fsOpenFileTarget,
} from "../../src/components/browser-column/open-file-target";
import type { LoadEditableTextResult } from "../../src/editors/editor-io";

const applyPatchMock = mock(async (_id: string, body: {
  patch: { oldString: string; newString: string };
  requestId?: string;
}) => ({
  kind: "applied" as const,
  target: { kind: "artifact" as const, artifactInternalId: "art-d448", path: "notes.md" },
  patchId: "patch-d448",
  requestId: body.requestId ?? "request-d448",
  revision: 2,
  sha256: `sha-${body.patch.newString}`,
  author: { kind: "human" as const, displayName: "You" },
  patch: body.patch,
  unifiedDiff: "",
  rebased: false,
}));
const saveArtifactMock = mock(async () => ({
  id: "art-d448",
  revision: 2,
  size: 0,
  sha256: "snapshot-sha",
}));

type ArtifactEventHandler = (event: unknown) => void;
let artifactEventHandler: ArtifactEventHandler | null = null;
const subscribeWorkspaceArtifactEventsMock = mock((handler: ArtifactEventHandler) => {
  artifactEventHandler = handler;
  return () => {
    artifactEventHandler = null;
  };
});

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

const readFileMock = mock(async () => "alpha\nbeta\n");
const writeFileMock = mock(async (_path: string, content: string) => ({
  ok: true as const,
  sha256: `sha-${content}`,
  size: content.length,
}));
mock.module("../../src/lib/desktop", () => ({
  isDesktop: true,
  getDesktopRelayId: async () => null,
  getDesktopLocalHumanEditLeaseAPI: () => null,
  desktopAPI: {
    fs: {
      readFile: readFileMock,
      writeFile: writeFileMock,
      stat: async () => ({ exists: true, isFile: true, isDirectory: false, size: 0, modified: null }),
      watchRoot: async () => {},
      onDirectoryChanged: () => () => {},
    },
  },
}));
mock.module("../../src/hooks/use-auth", () => ({
  useAuth: () => ({ viewer: { isVerified: false, sessionUserId: null }, viewerGeneration: 0 }),
}));
mock.module("../../src/editors/editor-conflict-copy", () => ({
  saveConflictCopy: async () => ({ kind: "saved" as const, path: "conflict.md" }),
  buildConflictCopyFileName: (name: string) => `${name}.conflict-copy`,
  resolveAvailableConflictCopyName: (name: string) => `${name}.conflict-copy`,
}));

let mdxLiveMarkdown = "";
const setMarkdownMock = mock((markdown: string) => {
  mdxLiveMarkdown = markdown;
});
mock.module("@mdxeditor/editor", () => {
  const plugin = () => ({});
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  return {
    BoldItalicUnderlineToggles: () => null,
    ChangeCodeMirrorLanguage: () => null,
    codeBlockPlugin: plugin,
    codeMirrorPlugin: plugin,
    ConditionalContents: Passthrough,
    CreateLink: () => null,
    diffSourcePlugin: plugin,
    DiffSourceToggleWrapper: Passthrough,
    headingsPlugin: plugin,
    InsertCodeBlock: () => null,
    InsertTable: () => null,
    linkPlugin: plugin,
    listsPlugin: plugin,
    ListsToggle: () => null,
    markdownShortcutPlugin: plugin,
    quotePlugin: plugin,
    tablePlugin: plugin,
    thematicBreakPlugin: plugin,
    toolbarPlugin: plugin,
    UndoRedo: () => null,
    MDXEditor: forwardRef((props: { markdown: string }, ref) => {
      const seeded = React.useRef(false);
      if (!seeded.current) {
        mdxLiveMarkdown = props.markdown;
        seeded.current = true;
      }
      useImperativeHandle(ref, () => ({
        getMarkdown: () => mdxLiveMarkdown,
        setMarkdown: setMarkdownMock,
        insertMarkdown: () => {},
        focus: () => {},
        getEditorState: () => null,
        getContentEditableHTML: () => "",
        getMarkdownSelection: () => "",
      }), []);
      return <div data-testid="mdx-editor" />;
    }),
  };
});

const { MarkdownEditor } = await import("../../src/editors/markdown-editor");
const { usePatchDocumentSession } = await import(
  "../../src/editors/use-patch-document-session"
);
const { deriveExactAnchoredTextPatch } = await import("@nautilo/types");
const { sha256HexForText } = await import("../../src/editors/editor-io");

const artifactFile = artifactOpenFileTarget({
  id: "art-d448",
  path: "notes.md",
  mimeType: "text/markdown",
  roomId: "room-d448",
});
const fsFile = fsOpenFileTarget("/tmp/d448/notes.md", "/tmp/d448");

function ready(content: string, revision: number | null): LoadEditableTextResult {
  return {
    kind: "ready",
    content,
    baseSha256: `sha-${content}`,
    baseRevision: revision,
  };
}

function renderSession(opts: {
  file?: typeof artifactFile | typeof fsFile;
  content?: string;
  baseSha?: string;
  loadLatest?: () => Promise<LoadEditableTextResult>;
} = {}) {
  const file = opts.file ?? artifactFile;
  const content = opts.content ?? "alpha\nbeta\n";
  return renderHook(() => usePatchDocumentSession({
    file,
    initialContent: content,
    baseSha256: opts.baseSha ?? `sha-${content}`,
    baseRevision: file.kind === "artifact" ? 1 : null,
    loadLatest: opts.loadLatest,
  }));
}

function remoteArtifactEvent(input: {
  patchId: string;
  sha256: string;
  revision: number;
  patch: DocumentPatchEvent["patch"];
  clientMutationId?: string;
}): DocumentPatchEvent {
  return {
    type: "document.patch.applied",
    target: { kind: "artifact", artifactInternalId: "art-d448", path: "notes.md" },
    patchId: input.patchId,
    revision: input.revision,
    sha256: input.sha256,
    previousRevision: 1,
    previousSha256: "sha-alpha\nbeta\n",
    patch: input.patch,
    author: { kind: "agent", displayName: "Genie" },
    ...(input.clientMutationId ? { clientMutationId: input.clientMutationId } : {}),
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

beforeEach(() => {
  reapplyHappyDomGlobals();
  globalThis.localStorage.clear();
  artifactEventHandler = null;
  mdxLiveMarkdown = "";
  setMarkdownMock.mockClear();
  applyPatchMock.mockClear();
  saveArtifactMock.mockClear();
  subscribeWorkspaceArtifactEventsMock.mockClear();
  readFileMock.mockClear();
  writeFileMock.mockClear();
  readFileMock.mockImplementation(async () => "alpha\nbeta\n");
  writeFileMock.mockImplementation(async (_path, content) => ({
    ok: true as const,
    sha256: `sha-${content}`,
    size: content.length,
  }));
});

afterEach(() => {
  artifactEventHandler = null;
});

describe("D448 Workbench editor and MDX characterization", () => {
  test("uses anchored artifact patches, with snapshot save reserved for an empty base", async () => {
    const regular = renderSession();
    act(() => regular.result.current.setAutosaveEnabled(false));
    act(() => regular.result.current.setDraftFromEditor("alpha\nbeta edited\n"));
    await act(async () => {
      await regular.result.current.saveNow({ checkpoint: true });
      await settle();
    });
    expect(applyPatchMock).toHaveBeenCalledTimes(1);
    expect(saveArtifactMock).toHaveBeenCalledTimes(0);
    expect(applyPatchMock.mock.calls[0]?.[1]).toMatchObject({
      target: { kind: "artifact", artifactInternalId: "art-d448", path: "notes.md", roomId: "room-d448" },
      baseRevision: 1,
      baseSha256: "sha-alpha\nbeta\n",
      patch: { kind: "anchored_text", oldString: "beta\n", newString: "beta edited\n" },
    });

    applyPatchMock.mockClear();
    const emptySha = await sha256HexForText("");
    const empty = renderSession({ content: "", baseSha: emptySha });
    act(() => empty.result.current.setAutosaveEnabled(false));
    act(() => empty.result.current.setDraftFromEditor("first document\n"));
    await act(async () => {
      await empty.result.current.saveNow({ checkpoint: true });
      await settle();
    });
    expect(applyPatchMock).toHaveBeenCalledTimes(0);
    expect(saveArtifactMock).toHaveBeenCalledTimes(1);
  });

  test("persists local editor/MDX normalization bytes through direct SHA-guarded save", async () => {
    const initial = "S\n\nText&#x20;\n\nBla\n\n\nNew&#x20;\n\nBla";
    const normalized = "S\n\nText X&#x20;\n\nBla\n\nNew&#x20;\n\nBla";
    const baseSha = await sha256HexForText(initial);
    readFileMock.mockImplementation(async () => initial);
    const candidate = deriveAnchoredTextPatch(initial, normalized)!;
    expect(applyAnchoredTextPatch(initial, candidate)).not.toEqual({ ok: true, text: normalized });
    expect(
      applyAnchoredTextPatch(initial, deriveExactAnchoredTextPatch(initial, normalized)!),
    ).toEqual({
      ok: true,
      text: normalized,
    });

    const session = renderSession({ file: fsFile, content: initial, baseSha });
    act(() => session.result.current.setAutosaveEnabled(false));
    act(() => session.result.current.setDraftFromEditor(normalized));
    await act(async () => {
      await session.result.current.saveNow({ checkpoint: true });
      await settle();
    });

    expect(writeFileMock).toHaveBeenCalledWith(
      fsFile.path,
      normalized,
      expect.objectContaining({ baseSha256: baseSha }),
    );
    expect(saveArtifactMock).toHaveBeenCalledTimes(0);
    expect(session.result.current.draft).toBe(normalized);
    expect(session.result.current.status).toBe("saved");
  });

  test("applies an exact remote patch to an MDX value and preserves a non-overlapping dirty draft", async () => {
    const session = renderSession();
    act(() => session.result.current.setAutosaveEnabled(false));
    act(() => session.result.current.setDraftFromEditor("alpha\nbeta mine\n"));
    const view = render(<MarkdownEditor value={session.result.current.draft} onChange={() => {}} />);
    const patch = deriveAnchoredTextPatch("alpha\nbeta\n", "ALPHA\nbeta\n")!;
    const remoteSha = await sha256HexForText("ALPHA\nbeta\n");

    await act(async () => {
      artifactEventHandler?.(remoteArtifactEvent({
        patchId: "remote-non-overlap",
        revision: 4,
        sha256: remoteSha,
        patch,
      }));
      await settle();
    });
    view.rerender(<MarkdownEditor value={session.result.current.draft} onChange={() => {}} />);

    expect(session.result.current.draft).toBe("ALPHA\nbeta mine\n");
    expect(session.result.current.dirty).toBe(true);
    expect(session.result.current.status).toBe("unsaved");
    expect(setMarkdownMock).toHaveBeenCalledWith("ALPHA\nbeta mine\n");

    await act(async () => {
      await session.result.current.saveNow({ checkpoint: true });
      await settle();
    });
    expect(applyPatchMock.mock.calls.at(-1)?.[1]).toMatchObject({
      baseRevision: 4,
      baseSha256: remoteSha,
    });
  });

  test("overlapping local external save enters conflict and preserves the human draft", async () => {
    const initial = "hello\n";
    const mine = "hello edited\n";
    const theirs = "totally different\n";
    const loadLatest = mock(async () => ready(theirs, 4));
    const baseSha = await sha256HexForText(initial);
    readFileMock.mockImplementation(async () => theirs);
    const session = renderSession({ file: fsFile, content: initial, baseSha, loadLatest });
    act(() => session.result.current.setAutosaveEnabled(false));
    act(() => session.result.current.setDraftFromEditor(mine));
    await act(async () => {
      await session.result.current.saveNow({ checkpoint: true });
      await settle();
    });

    expect(loadLatest).toHaveBeenCalledTimes(1);
    expect(writeFileMock).toHaveBeenCalledTimes(0);
    expect(session.result.current.draft).toBe(mine);
    expect(session.result.current.status).toBe("conflict");
    expect(session.result.current.dirty).toBe(true);
    expect(session.result.current.draft).toBe(mine);
    expect(session.result.current.conflict).toEqual({
      latestContent: theirs,
      currentSha256: await sha256HexForText(theirs),
    });
  });

  test("ignores the editor's own exact patch event", async () => {
    const session = renderSession();
    act(() => session.result.current.setAutosaveEnabled(false));
    act(() => session.result.current.setDraftFromEditor("alpha\nbeta edited\n"));
    await act(async () => {
      await session.result.current.saveNow({ checkpoint: true });
      await settle();
    });
    const ownMutationId = applyPatchMock.mock.calls[0]?.[1]?.clientMutationId as string;
    expect(ownMutationId).toBeTruthy();

    act(() => {
      artifactEventHandler?.(remoteArtifactEvent({
        patchId: "own-event",
        revision: 99,
        sha256: "sha-ignored",
        patch: deriveAnchoredTextPatch("alpha\nbeta edited\n", "unexpected\n")!,
        clientMutationId: ownMutationId,
      }));
    });
    expect(session.result.current.draft).toBe("alpha\nbeta edited\n");
    expect(session.result.current.status).toBe("saved");
  });
});
