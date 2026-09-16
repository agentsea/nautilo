import { reapplyHappyDomGlobals } from "../bun-dom-preload";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement } from "react";

const statMock = mock(async () => ({
  exists: false,
  isFile: false,
  isDirectory: false,
  size: 0,
  modified: null,
}));
const writeFileMock = mock(async () => ({
  ok: true as const,
  sha256: "empty-sha",
  size: 0,
}));
const onOpenFileEdit = mock(() => {});
const alertMock = mock(() => {});
let createCallOrder: string[] = [];

mock.module("../../src/hooks/use-auth", () => ({
  useAuth: () => ({
    viewer: {
      isVerified: true,
      sessionUserId: "human-user-1",
      sessionActorId: "human-actor-1",
    },
  }),
}));

mock.module("../../src/lib/desktop", () => ({
  isDesktop: true,
  desktopAPI: {
    fs: {
      stat: statMock,
      writeFile: writeFileMock,
    },
  },
}));

mock.module("../../src/components/browser-column/browser-column.context", () => ({
  useBrowserColumn: () => ({ currentFolderPath: "/repo" }),
}));

mock.module("../../src/components/browser-column/file-tree-view", () => ({
  FileTreeView: ({ onNewFile }: { onNewFile: () => void }) =>
    createElement("button", { type: "button", onClick: onNewFile }, "New local file"),
  executeFileTreeMkdir: mock(async () => ({ ok: true })),
  formatFsMkdirError: () => ({ title: "", message: "" }),
}));

mock.module("../../src/components/toast", () => ({
  useToast: () => ({ show: mock(() => {}) }),
}));

const { FilesTab } = await import("../../src/components/browser-column/files-tab");

beforeEach(() => {
  reapplyHappyDomGlobals();
  statMock.mockClear();
  writeFileMock.mockClear();
  onOpenFileEdit.mockClear();
  alertMock.mockClear();
  createCallOrder = [];
  statMock.mockImplementation(async () => {
    createCallOrder.push("stat");
    return {
      exists: false,
      isFile: false,
      isDirectory: false,
      size: 0,
      modified: null,
    };
  });
  writeFileMock.mockImplementation(async () => {
    createCallOrder.push("write");
    return { ok: true as const, sha256: "empty-sha", size: 0 };
  });
  globalThis.alert = alertMock as unknown as typeof alert;
});

afterEach(() => {
  document.body.replaceChildren();
});

async function submitNewFile(view: ReturnType<typeof render>): Promise<void> {
  fireEvent.click(view.getByRole("button", { name: "New local file" }));
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Create" }));
  });
}

describe("D448 FilesTab local file create characterization", () => {
  test("validates then stats and creates an empty file with the explicit create precondition before opening it for edit", async () => {
    const view = render(<FilesTab onOpenFileEdit={onOpenFileEdit} />);

    await submitNewFile(view);

    await waitFor(() => {
      expect(statMock).toHaveBeenCalledWith("/repo/untitled.md");
      expect(writeFileMock).toHaveBeenCalledWith("/repo/untitled.md", "", { baseSha256: null });
    });
    expect(createCallOrder).toEqual(["stat", "write"]);
    expect(onOpenFileEdit).toHaveBeenCalledWith({
      kind: "fs",
      path: "/repo/untitled.md",
      rootPath: "/repo",
    });
  });

  test("does not call writeFile or open an editor when stat finds an existing target", async () => {
    statMock.mockImplementationOnce(async () => ({
      exists: true,
      isFile: true,
      isDirectory: false,
      size: 1,
      modified: null,
    }));
    const view = render(<FilesTab onOpenFileEdit={onOpenFileEdit} />);

    await submitNewFile(view);

    await waitFor(() => expect(statMock).toHaveBeenCalledWith("/repo/untitled.md"));
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(onOpenFileEdit).not.toHaveBeenCalled();
  });

  test("does not open an editor after the explicit-create write is rejected", async () => {
    writeFileMock.mockImplementationOnce(async () => ({
      ok: false as const,
      code: "already_exists",
      message: "already exists",
    }));
    const view = render(<FilesTab onOpenFileEdit={onOpenFileEdit} />);

    await submitNewFile(view);

    await waitFor(() => {
      expect(writeFileMock).toHaveBeenCalledWith("/repo/untitled.md", "", { baseSha256: null });
    });
    expect(onOpenFileEdit).not.toHaveBeenCalled();
  });
});
