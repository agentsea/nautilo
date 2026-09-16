import { reapplyHappyDomGlobals } from "../bun-dom-preload";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { fsOpenFileTarget } from "../../src/components/browser-column/open-file-target";

const readFileMock = mock(async () => "hello\n");
const writeFileMock = mock(async () => ({
  ok: true as const,
  sha256: "sha",
  size: 5,
}));

mock.module("../../src/artifacts/workspace-artifacts-provider", () => ({
  useWorkspaceArtifactEventHub: () => () => () => {},
}));

mock.module("../../src/lib/api", () => ({
  apiClient: {
    applyWorkspaceArtifactPatch: mock(async () => ({})),
    saveWorkspaceArtifactContent: mock(async () => ({})),
    subscribeWorkspaceArtifactEvents: mock(() => () => {}),
  },
}));

mock.module("../../src/lib/desktop", () => ({
  isDesktop: false,
  getDesktopRelayId: async () => null,
  getDesktopLocalHumanEditLeaseAPI: () => null,
  desktopAPI: null,
}));

mock.module("../../src/hooks/use-auth", () => ({
  useAuth: () => ({ viewer: { isVerified: false, sessionUserId: null }, viewerGeneration: 0 }),
}));

mock.module("../../src/editors/editor-conflict-copy", () => ({
  saveConflictCopy: mock(async () => ({ kind: "saved", path: "copy.txt" })),
  buildConflictCopyFileName: (name: string) => `${name}.conflict-copy`,
  resolveAvailableConflictCopyName: (name: string) => `${name}.conflict-copy`,
}));

const { usePatchDocumentSession } = await import("../../src/editors/use-patch-document-session");
const { sha256HexForText } = await import("../../src/editors/editor-io");

beforeEach(() => {
  reapplyHappyDomGlobals();
  readFileMock.mockClear();
  writeFileMock.mockClear();
});

afterEach(() => {
  /* noop */
});

describe("usePatchDocumentSession fs fallback", () => {
  test("fs patch path fails explicitly when desktop bridge unavailable", async () => {
    const fsFile = fsOpenFileTarget("/tmp/workspace/notes.txt", "/tmp/workspace");
    const baseSha = await sha256HexForText("hello\n");

    const { result } = renderHook(() =>
      usePatchDocumentSession({
        file: fsFile,
        initialContent: "hello\n",
        baseSha256: baseSha,
        baseRevision: null,
      }),
    );

    act(() => {
      result.current.setDraftFromEditor("hello!\n");
    });

    await act(async () => {
      await result.current.saveNow({ checkpoint: true });
    });

    expect(result.current.status).toBe("failed");
    expect(result.current.errorMessage).toBe("Desktop file bridge unavailable.");
    expect(writeFileMock).not.toHaveBeenCalled();
  });
});
