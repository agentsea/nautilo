import { reapplyHappyDomGlobals } from "../../../tests/bun-dom-preload";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ArtifactDto } from "@nautilo/api-client/browser";
import { shouldCloseManagedArtifactViewer } from "./open-file-target";

const createWorkspaceArtifact = mock(async () => ({}));
const renameWorkspaceArtifact = mock(async (rowId: string, newPath: string) => ({
  id: rowId,
  path: newPath,
}));
const deleteWorkspaceArtifact = mock(async () => {});
let encryptionPolicyMode: "plaintext_only" | "unknown" = "unknown";

mock.module("../../adapters/runtime-contexts", () => ({
  useToolActivity: () => [],
  useConversationEncryptionPolicyMode: () => encryptionPolicyMode,
  useMostRecentlyTouchedPath: () => ({ path: null, view: {
    canUndo: false, canRedo: false, snapshot: null,
  } }),
}));

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
const listWorkspaceArtifacts = mock(() =>
  Promise.resolve({
    artifacts: [
      {
        id: "m1",
        artifactId: "ag-m1",
        path: "src/.nautilo-keep.md",
        mimeType: "text/markdown",
        size: 0,
        revision: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        namespaceIds: [],
      },
      {
        id: "f1",
        artifactId: "ag-f1",
        path: "src/a.ts",
        mimeType: "text/plain",
        size: 1,
        revision: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        namespaceIds: [],
      },
    ],
  }),
);

mock.module("../../contexts/room-navigation-context", () => ({
  useRoomNavigation: () => ({ activeRoomId: "test-room-id-uuid" }),
}));

mock.module("../toast", () => ({
  useToast: () => ({
    show: mock(() => {}),
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

let canWriteArtifacts = true;
mock.module("../../hooks/use-can", () => ({
  useCan: () => (capability: string) =>
    capability === "write_artifacts" ? canWriteArtifacts : true,
}));

let providerArtifacts: ArtifactDto[] = [];
let providerLoading = true;
mock.module("../../artifacts/workspace-artifacts-provider", () => ({
  useWorkspaceArtifacts: () => ({
    roomId: "test-room-id-uuid",
    artifacts: providerArtifacts,
    loading: providerLoading,
    error: null,
    refresh: mock(() => {}),
    updateArtifacts: mock(() => {}),
  }),
}));

mock.module("../../lib/api", () => ({
  apiClient: {
    listWorkspaceArtifacts,
    subscribeWorkspaceArtifactEvents: mock(() => () => {}),
    createWorkspaceArtifact,
    runMiniAppConversion: mock(async () => ({ ok: true, result: { ok: true, status: "imported" } })),
    renameWorkspaceArtifact,
    deleteWorkspaceArtifact,
    downloadArtifactsZip: mock(async () => {}),
    getWorkspaceArtifactBytes: mock(async () => new Blob()),
    getWorkspaceArtifactObjectUrl: mock(async () => "blob:fake"),
  },
}));

const { buildFolderMarkerPath } = await import("./artifact-tree");
const { planFolderRebase, detectRebaseCollisions } = await import("./artifact-move");
const { ArtifactTreeView } = await import("./artifact-tree-view");

describe("ArtifactTreeView", () => {
  beforeEach(() => {
    cleanup();
    reapplyHappyDomGlobals();
    canWriteArtifacts = true;
    encryptionPolicyMode = "unknown";
    providerArtifacts = [];
    providerLoading = true;
    deleteWorkspaceArtifact.mockClear();
  });

  test("initial markup shows loading marker", () => {
    const html = renderToStaticMarkup(<ArtifactTreeView />);
    expect(html).toContain("artifact-tree-loading");
    expect(html).toContain('data-testid="artifact-tree-view"');
  });

  test("toolbar includes new folder affordance", () => {
    const html = renderToStaticMarkup(<ArtifactTreeView />);
    expect(html).toContain('data-testid="artifact-tree-new-folder"');
  });

  test("read-only viewers see the Artifact tree without mutation controls", () => {
    canWriteArtifacts = false;
    const html = renderToStaticMarkup(<ArtifactTreeView />);
    expect(html).toContain('data-testid="artifact-tree-view"');
    expect(html).not.toContain('data-testid="artifact-tree-new-folder"');
    expect(html).not.toContain('data-testid="artifact-tree-upload"');
  });

  test("same-path rows open and delete by the chosen internal ID", async () => {
    providerLoading = false;
    providerArtifacts = [
      {
        id: "row-alpha",
        artifactId: "artifact-alpha",
        path: "report.md",
        mimeType: "text/markdown",
        size: 10,
        revision: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        namespaceIds: [],
        canWrite: true,
      },
      {
        id: "row-bravo",
        artifactId: "artifact-bravo",
        path: "report.md",
        mimeType: "text/markdown",
        size: 20,
        revision: 1,
        updatedAt: "2026-01-02T00:00:00.000Z",
        createdAt: "2026-01-02T00:00:00.000Z",
        namespaceIds: [],
        canWrite: true,
      },
    ];
    const onOpenFile = mock(() => {});
    const view = render(<ArtifactTreeView onOpenFile={onOpenFile} />);
    const chosenRow = view.getByText("report.md · row-b").closest(
      '[data-testid="artifact-tree-leaf"]',
    );
    expect(chosenRow).toBeTruthy();

    fireEvent.click(within(chosenRow!).getByRole("treeitem"));
    expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ id: "row-bravo" }));

    fireEvent.click(within(chosenRow!).getByRole("button", { name: "Row actions" }));
    fireEvent.click(view.getByRole("menuitem", { name: "Delete" }));
    fireEvent.click(view.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteWorkspaceArtifact).toHaveBeenCalled());
    expect(deleteWorkspaceArtifact.mock.calls[0]?.[0]).toBe("row-bravo");
  });

  test("plaintext rows expose Manage access while unknown mode preserves the legacy action", () => {
    providerLoading = false;
    providerArtifacts = [{
      id: "row-alpha", artifactId: "artifact-alpha", path: "report.md",
      mimeType: "text/markdown", size: 10, revision: 1,
      updatedAt: "2026-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z",
      namespaceIds: [], canWrite: true,
    }];
    const legacy = render(<ArtifactTreeView />);
    fireEvent.click(legacy.getByRole("button", { name: "Row actions" }));
    expect(legacy.getByRole("menuitem", { name: "Add to someone’s workspace…" })).toBeTruthy();
    cleanup();

    encryptionPolicyMode = "plaintext_only";
    const ordinary = render(<ArtifactTreeView />);
    fireEvent.click(ordinary.getByRole("button", { name: "Row actions" }));
    expect(ordinary.getByRole("menuitem", { name: "Manage access…" })).toBeTruthy();
    expect(ordinary.queryByRole("menuitem", { name: "Add to someone’s workspace…" })).toBeNull();
  });

  test("access loss targets only the viewer for an exact managed Artifact id", () => {
    const managed = [{ id: "row-alpha", path: "report.md" }];
    expect(shouldCloseManagedArtifactViewer({ id: "row-alpha", path: "renamed.md" }, managed)).toBe(true);
    expect(shouldCloseManagedArtifactViewer({ id: "another-row", path: "report.md" }, managed)).toBe(false);
    expect(shouldCloseManagedArtifactViewer(null, managed)).toBe(false);
  });
});

describe("create-folder marker path", () => {
  test("nested folder posts marker artifact at expected path", () => {
    const folderPath = "parent/child";
    expect(buildFolderMarkerPath(folderPath)).toBe("parent/child/.nautilo-keep.md");
  });

  test("root folder posts marker at top-level path", () => {
    expect(buildFolderMarkerPath("drafts")).toBe("drafts/.nautilo-keep.md");
  });
});

describe("folder move rebase sequence", () => {
  test("plans N renameWorkspaceArtifact calls including marker", async () => {
    const res = await listWorkspaceArtifacts();
    const ops = planFolderRebase(res.artifacts, "src", "lib");
    expect(ops).toHaveLength(2);
    expect(ops.map((o) => o.newPath).sort()).toEqual(
      [buildFolderMarkerPath("lib"), "lib/a.ts"].sort(),
    );
  });

  test("pre-flight flags a colliding folder move so the batch aborts before any rename", async () => {
    // This is the exact decision the component's runRebaseOps makes: it calls
    // detectRebaseCollisions on the planned ops and, when non-empty, shows a
    // "Name in use" toast and returns WITHOUT issuing any renameWorkspaceArtifact.
    const res = await listWorkspaceArtifacts();
    const existing = [...res.artifacts, { id: "collision", path: "lib/a.ts" }];
    const ops = planFolderRebase(res.artifacts, "src", "lib");
    const collisions = detectRebaseCollisions(existing, ops);
    expect(collisions).toContain("lib/a.ts");
    // A move whose destinations are all free produces no collisions (proceeds).
    expect(detectRebaseCollisions(res.artifacts, ops)).toEqual([]);
  });
});
