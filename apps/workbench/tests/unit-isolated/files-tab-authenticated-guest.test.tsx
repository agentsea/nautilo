import { beforeEach, describe, expect, mock, test } from "bun:test";
import { render } from "@testing-library/react";
import { reapplyHappyDomGlobals } from "../bun-dom-preload";

const pickAndCommit = mock(async () => null);

mock.module("../../src/hooks/use-auth", () => ({
  useAuth: () => ({
    viewer: {
      role: "guest" as const,
      label: "Guest",
      userIdentity: "guest-002",
      sessionUserId: "user-002",
      sessionActorId: "actor-002",
      isVerified: false,
      staleWhoami: false,
    },
  }),
}));

mock.module("../../src/lib/desktop", () => ({
  isDesktop: true,
  desktopAPI: {
    currentFolder: { pickAndCommit },
    fs: {},
  },
}));

mock.module("../../src/components/browser-column/browser-column.context", () => ({
  useBrowserColumn: () => ({ currentFolderPath: null }),
}));

mock.module("../../src/components/browser-column/file-tree-view", () => ({
  FileTreeView: () => null,
  executeFileTreeMkdir: mock(async () => ({ ok: true as const })),
  formatFsMkdirError: () => ({ title: "error", message: "error" }),
}));

mock.module("../../src/components/toast", () => ({
  useToast: () => ({ show: mock(() => {}) }),
}));

const { FilesTab } = await import("../../src/components/browser-column/files-tab");

beforeEach(() => {
  reapplyHappyDomGlobals();
  pickAndCommit.mockClear();
});

describe("FilesTab authenticated Guest", () => {
  test("offers the local Current Folder picker instead of a sign-in gate", () => {
    const view = render(<FilesTab />);
    expect(view.getByRole("button", { name: "Open folder…" })).toBeTruthy();
    expect(view.queryByText(/sign in/i)).toBeNull();
  });
});
