import { describe, expect, mock, test } from "bun:test";
import { artifactOpenFileTarget, fsOpenFileTarget } from "../../src/components/browser-column/open-file-target";

const writeFileMock = mock(async () => ({
  ok: true as const,
  sha256: "copy-sha",
  size: 10,
}));
const statMock = mock(async () => ({
  exists: false,
  isFile: false,
  isDirectory: false,
  size: 0,
  modified: null,
}));
const createArtifactMock = mock(async () => ({
  id: "art-copy",
  path: "notes.conflict-copy.txt",
  revision: 1,
  mimeType: "text/plain",
}));
const listArtifactsMock = mock(async () => ({
  artifacts: [{ path: "notes.txt", id: "art-1" }],
}));

mock.module("../../src/lib/desktop", () => ({
  isDesktop: true,
  desktopAPI: {
    fs: {
      writeFile: writeFileMock,
      stat: statMock,
    },
  },
}));

mock.module("../../src/lib/api", () => ({
  apiClient: {
    createWorkspaceArtifact: createArtifactMock,
    listWorkspaceArtifacts: listArtifactsMock,
  },
}));

const {
  buildConflictCopyFileName,
  resolveAvailableConflictCopyName,
  saveConflictCopy,
} = await import("../../src/editors/editor-conflict-copy");

describe("buildConflictCopyFileName", () => {
  test("inserts conflict-copy before extension", () => {
    expect(buildConflictCopyFileName("notes.txt")).toBe("notes.conflict-copy.txt");
  });

  test("appends conflict-copy when no extension", () => {
    expect(buildConflictCopyFileName("README")).toBe("README.conflict-copy");
  });
});

describe("resolveAvailableConflictCopyName", () => {
  test("increments suffix when copy name is taken", () => {
    expect(
      resolveAvailableConflictCopyName("notes.txt", ["notes.conflict-copy.txt"]),
    ).toBe("notes.conflict-copy-2.txt");
  });
});

describe("saveConflictCopy", () => {
  test("writes fs sibling with conflict-copy suffix", async () => {
    writeFileMock.mockClear();
    statMock.mockClear();

    const fsFile = fsOpenFileTarget("/tmp/workspace/notes.txt", "/tmp/workspace");
    const result = await saveConflictCopy(fsFile, "my draft\n");

    expect(result).toEqual({ kind: "saved", path: "/tmp/workspace/notes.conflict-copy.txt" });
    expect(writeFileMock).toHaveBeenCalledWith(
      "/tmp/workspace/notes.conflict-copy.txt",
      "my draft\n",
      { baseSha256: null },
    );
  });

  test("creates artifact copy without overwriting original", async () => {
    createArtifactMock.mockClear();
    listArtifactsMock.mockClear();

    const artifact = artifactOpenFileTarget({
      id: "art-1",
      path: "notes.txt",
      mimeType: "text/plain",
      roomId: "room-1",
    });

    const result = await saveConflictCopy(artifact, "draft body");

    expect(result.kind).toBe("saved");
    expect(createArtifactMock).toHaveBeenCalledTimes(1);
    const [, opts] = createArtifactMock.mock.calls[0] as [Blob, { path: string; mimeType: string; roomId: string }];
    expect(opts.path).toBe("notes.conflict-copy.txt");
    expect(opts.mimeType).toBe("text/plain");
    expect(opts.roomId).toBe("room-1");
  });
});
