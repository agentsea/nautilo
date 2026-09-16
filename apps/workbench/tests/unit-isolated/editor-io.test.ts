import { describe, expect, mock, test } from "bun:test";
import { ConflictError } from "@nautilo/api-client";
import {
  artifactOpenFileTarget,
  fsOpenFileTarget,
} from "../../src/components/browser-column/open-file-target";
import { MAX_TEXT_PREVIEW_BYTES } from "../../src/lib/file-preview";

const getArtifactMock = mock(async () => ({ id: "art-1", revision: 7 }));
const getBytesMock = mock(async () => new Blob(["hello"], { type: "text/plain" }));
const saveArtifactMock = mock(async () => ({
  id: "art-1",
  revision: 8,
  size: 5,
  sha256: "abc123",
}));
const statMock = mock(async () => ({
  exists: true,
  isFile: true,
  isDirectory: false,
  size: 5,
  modified: null,
}));
const readFileMock = mock(async () => "hello");
const writeFileMock = mock(async () => ({
  ok: true as const,
  sha256: "saved-sha",
  size: 5,
}));

mock.module("../../src/lib/api", () => ({
  apiClient: {
    getWorkspaceArtifact: getArtifactMock,
    getWorkspaceArtifactBytes: getBytesMock,
    saveWorkspaceArtifactContent: saveArtifactMock,
  },
}));

mock.module("../../src/lib/desktop", () => ({
  isDesktop: true,
  desktopAPI: {
    fs: {
      stat: statMock,
      readFile: readFileMock,
      writeFile: writeFileMock,
    },
  },
  getShellStateOnBoot: () => null,
  computeInitialLastOpenAtSeed: (input: {
    hasEverBeenOpen: boolean;
    shellStateOnBoot: unknown;
    now: number;
  }) => (input.hasEverBeenOpen ? input.now : null),
}));

const {
  loadEditableText,
  saveEditableText,
  sha256HexForText,
} = await import("../../src/editors/editor-io");

describe("sha256HexForText", () => {
  test("returns stable hex digest", async () => {
    const digest = await sha256HexForText("hello");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await sha256HexForText("hello")).toBe(digest);
  });
});

describe("loadEditableText", () => {
  test("artifact load returns revision and preserves roomId", async () => {
    getArtifactMock.mockClear();
    getBytesMock.mockClear();

    const file = artifactOpenFileTarget({
      id: "art-1",
      path: "notes.txt",
      mimeType: "text/plain",
      roomId: "room-42",
    });
    const result = await loadEditableText(file);

    expect(getArtifactMock).toHaveBeenCalledWith("art-1", { roomId: "room-42" });
    expect(getBytesMock).toHaveBeenCalledWith("art-1", { roomId: "room-42" });
    expect(result).toEqual({
      kind: "ready",
      content: "hello",
      baseSha256: await sha256HexForText("hello"),
      baseRevision: 7,
    });
  });

  test("fs load returns baseRevision null", async () => {
    const result = await loadEditableText(
      fsOpenFileTarget("/repo/notes.txt", "/repo"),
    );
    expect(result.kind).toBe("ready");
    if (result.kind === "ready") {
      expect(result.baseRevision).toBeNull();
    }
  });

  test("over the preview cap returns too_large", async () => {
    getBytesMock.mockImplementationOnce(async () => ({
      // Only `size` matters — the cap check returns before `text()` is read.
      size: MAX_TEXT_PREVIEW_BYTES + 1,
      text: async () => "x",
    } as Blob));

    const result = await loadEditableText(
      artifactOpenFileTarget({
        id: "big",
        path: "big.txt",
        mimeType: "text/plain",
      }),
    );
    expect(result).toEqual({ kind: "too_large" });
  });
});

describe("saveEditableText", () => {
  test("artifact save forwards clientMutationId", async () => {
    saveArtifactMock.mockClear();

    const result = await saveEditableText(
      artifactOpenFileTarget({
        id: "art-1",
        path: "notes.txt",
        mimeType: "text/plain",
        roomId: "room-42",
      }),
      "mine",
      { sha256: "base", revision: 1 },
      true,
      { clientMutationId: "mutation-123" },
    );

    expect(result.kind).toBe("saved");
    expect(saveArtifactMock).toHaveBeenCalledWith("art-1", "mine", {
      baseRevision: 1,
      baseSha256: "base",
      checkpoint: true,
      mimeType: "text/plain",
      roomId: "room-42",
      clientMutationId: "mutation-123",
    });
  });

  test("artifact ConflictError maps to conflict", async () => {
    saveArtifactMock.mockImplementationOnce(async () => {
      throw new ConflictError("deadbeef".repeat(8));
    });

    const result = await saveEditableText(
      artifactOpenFileTarget({
        id: "art-1",
        path: "notes.txt",
        mimeType: "text/plain",
      }),
      "stale",
      { sha256: "old", revision: 1 },
      false,
    );

    expect(result).toEqual({
      kind: "conflict",
      currentSha256: "deadbeef".repeat(8),
    });
  });

  test("fs conflict maps to conflict", async () => {
    writeFileMock.mockImplementationOnce(async () => ({
      ok: false as const,
      code: "conflict" as const,
      currentSha256: "current-sha",
    }));

    const result = await saveEditableText(
      fsOpenFileTarget("/repo/notes.txt", "/repo"),
      "mine",
      { sha256: "base", revision: null },
      true,
    );

    expect(result).toEqual({
      kind: "conflict",
      currentSha256: "current-sha",
    });
    expect(writeFileMock.mock.calls.at(-1)?.[2]).toEqual(expect.objectContaining({
      baseSha256: "base",
      checkpoint: true,
      requestId: expect.any(String),
      clientMutationId: expect.any(String),
    }));
  });

  test("fs forbidden maps to error", async () => {
    writeFileMock.mockImplementationOnce(async () => ({
      ok: false as const,
      code: "forbidden" as const,
    }));

    const result = await saveEditableText(
      fsOpenFileTarget("/repo/notes.txt", "/repo"),
      "mine",
      { sha256: "base", revision: null },
      false,
    );

    expect(result).toEqual({
      kind: "error",
      message: "You do not have permission to save this file.",
    });
  });
});
