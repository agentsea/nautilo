/**
 * D152 — Workspace tab browser parity regression lock.
 *
 * Ensures signed-in browser users see the artifact listing, not the
 * stale "Desktop required" gate removed in Stack 30 PR-1.
 */
import { reapplyHappyDomGlobals } from "../../../tests/bun-dom-preload";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, render, within } from "@testing-library/react";
import type { ArtifactDto } from "@nautilo/api-client/browser";

const sampleArtifact: ArtifactDto = {
  id: "row-1",
  artifactId: "art-1",
  path: "notes/hello.md",
  mimeType: "text/markdown",
  size: 12,
  revision: 1,
  updatedAt: "2026-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  namespaceIds: [],
  canWrite: true,
};

mock.module("../../hooks/use-can", () => ({ useCan: () => () => true }));

const secondArtifact = { ...sampleArtifact, id: "row-2", artifactId: "art-2", path: "notes/second.md" };

const listWorkspaceShares = mock(async () => ({ artifacts: [{ id: "received", artifactId: "shared-1", path: "review.pdf", mimeType: "application/pdf", size: 12, revision: 1, updatedAt: "2026-09-06T12:00:00Z", sharedAt: "2026-09-06T12:00:00Z", roomId: "hidden-share-room", sharedBy: "Casey" }] }));

const listWorkspaceArtifacts = mock(() => Promise.resolve({ artifacts: [sampleArtifact] }));

mock.module("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 24,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 24,
        size: 24,
      })),
    scrollToIndex: mock(() => {}),
  }),
}));

mock.module("../../lib/desktop", () => ({
  isDesktop: false,
  desktopAPI: null,
}));

mock.module("../../hooks/use-auth", () => ({
  useAuth: () => ({
    session: {
      state: "signed-in" as const,
      signIn: async () => {},
      signOut: async () => {},
      getAccessToken: async () => "token",
    },
    viewer: {
      role: "owner" as const,
      label: "Owner",
      userIdentity: "u",
      sessionUserId: "s",
      sessionActorId: "actor-s",
      isVerified: true,
      staleWhoami: false,
    },
  }),
}));

mock.module("../../contexts/room-navigation-context", () => ({
  useRoomNavigation: () => ({
    activeRoomId: "test-room-id",
    activeRoom: { label: "Test Room" },
    rooms: [],
  }),
}));

mock.module("../../apps/use-installed-apps", () => ({
  useInstalledApps: () => ({ kind: "ready", apps: [], reload: () => {} }),
}));

mock.module("../../apps/use-conversion-runner", () => ({
  useConversionRunner: () => ({
    run: mock(async () => null),
    running: false,
  }),
}));

let encryptionPolicyMode: "plaintext_only" | "shadow_encryption" | "encrypted_only" | "unknown" = "unknown";
mock.module("../../adapters/runtime-contexts", () => ({
  useConversationEncryptionPolicyMode: () => encryptionPolicyMode,
  useToolActivity: () => [],
  useMostRecentlyTouchedPath: () => ({
    path: null,
    view: {
      canUndo: false,
      canRedo: false,
      snapshot: null,
    },
  }),
}));

mock.module("../toast", () => ({
  useToast: () => ({
    show: mock(() => {}),
  }),
}));

mock.module("../../artifacts/workspace-artifacts-provider", () => ({
  useWorkspaceArtifacts: () => ({
    roomId: "test-room-id",
    artifacts: [sampleArtifact, secondArtifact],
    loading: false,
    error: null,
    refresh: mock(() => {}),
    updateArtifacts: mock(() => {}),
  }),
}));

mock.module("../../lib/api", () => ({
  apiClient: {
    listWorkspaceArtifacts,
    listWorkspaceShares,
    searchDirectory: mock(async () => []),
    subscribeWorkspaceArtifactEvents: mock(() => () => {}),
    createWorkspaceArtifact: mock(async () => ({})),
    renameWorkspaceArtifact: mock(async () => ({})),
    deleteWorkspaceArtifact: mock(async () => {}),
    getWorkspaceArtifactBytes: mock(async () => new Blob()),
    getWorkspaceArtifactObjectUrl: mock(async () => "blob:fake"),
    invokeDirect: mock(async () => ({})),
  },
}));

const { WorkspaceTab } = await import("./workspace-tab");

beforeEach(() => {
  reapplyHappyDomGlobals();
  encryptionPolicyMode = "unknown";
});

describe("WorkspaceTab (browser context)", () => {
  test("renders artifact listing without desktop-required gate", async () => {
    const view = render(<WorkspaceTab />);

    expect(view.getByTestId("workspace-tab-listing")).toBeTruthy();
    expect(view.queryByTestId("workspace-tab-desktop-required")).toBeNull();

    expect(await view.findByTestId("artifact-tree-view")).toBeTruthy();
    expect(listWorkspaceArtifacts).not.toHaveBeenCalled();
  });

  test("reveals and activates an artifact opened outside the tree", async () => {
    const view = render(
      <WorkspaceTab
        activeArtifact={{ id: sampleArtifact.id, path: sampleArtifact.path }}
      />,
    );

    const activeRow = await view.findByRole("treeitem", { name: "hello.md" });
    expect(activeRow.getAttribute("aria-current")).toBe("page");
    expect(activeRow.getAttribute("aria-selected")).toBe("true");
  });
});


test("received files open in their access Room, independently of the active conversation", async () => {
  const onOpenFile = mock(() => {});
  const view = render(<WorkspaceTab onOpenFile={onOpenFile} />);
  fireEvent.click(view.getByRole("button", { name: "Shared with me" }));
  fireEvent.click(await view.findByRole("button", { name: /review.pdf Shared by Casey/ }));
  expect(listWorkspaceShares).toHaveBeenCalled();
  expect(onOpenFile.mock.calls[0]?.[0]).toMatchObject({ id: "received", roomId: "hidden-share-room" });
});


test("highlight selection opens the bulk picker and Cancel preserves selected rows", async () => {
  const view = render(<WorkspaceTab activeArtifact={{ id: sampleArtifact.id, path: sampleArtifact.path }} />);
  const first = await view.findByRole("treeitem", { name: "hello.md" });
  const second = await view.findByRole("treeitem", { name: "second.md" });
  fireEvent.click(first, { ctrlKey: true });
  fireEvent.click(second, { ctrlKey: true });
  expect(first.getAttribute("aria-selected")).toBe("true");
  expect(second.getAttribute("aria-selected")).toBe("true");
  fireEvent.click(view.getByTestId("artifact-tree-bulk-share"));
  const dialog = within(document.body).getByRole("dialog", { name: "Add 2 files to workspace" });
  expect(within(dialog).queryAllByRole("checkbox")).toHaveLength(0);
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(first.getAttribute("aria-selected")).toBe("true");
  expect(second.getAttribute("aria-selected")).toBe("true");
});

test("plaintext mode replaces the legacy inbox and bulk delivery dialog with Manage access", async () => {
  encryptionPolicyMode = "plaintext_only";
  const view = render(<WorkspaceTab activeArtifact={{ id: sampleArtifact.id, path: sampleArtifact.path }} />);
  expect(view.queryByRole("button", { name: "Shared with me" })).toBeNull();
  expect(view.queryByRole("button", { name: "Conversation files" })).toBeNull();
  expect(view.queryByLabelText("Workspace view")).toBeNull();
  expect(view.getByTestId("workspace-scope-label")).toBeTruthy();
  const first = await view.findByRole("treeitem", { name: "hello.md" });
  const second = await view.findByRole("treeitem", { name: "second.md" });
  fireEvent.click(first, { ctrlKey: true });
  fireEvent.click(second, { ctrlKey: true });
  fireEvent.click(view.getByTestId("artifact-tree-bulk-share"));
  const dialog = within(document.body).getByRole("dialog", { name: "Manage access" });
  expect(within(dialog).getAllByText("2 selected files")).toHaveLength(2);
  expect(within(dialog).queryByText(/Shared with me/)).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
});

test("protected-compatible modes preserve the legacy workspace switcher", () => {
  encryptionPolicyMode = "encrypted_only";
  const view = render(<WorkspaceTab />);

  expect(view.getByRole("button", { name: "Conversation files" }).getAttribute("aria-pressed")).toBe("true");
  expect(view.getByRole("button", { name: "Shared with me" }).getAttribute("aria-pressed")).toBe("false");
  expect(view.getByLabelText("Workspace view")).toBeTruthy();
});
