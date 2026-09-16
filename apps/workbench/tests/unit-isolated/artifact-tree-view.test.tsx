import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("../../src/contexts/room-navigation-context", () => ({
  useRoomNavigation: () => ({ activeRoomId: "test-room-id-uuid" }),
}));

mock.module("../../src/hooks/use-can", () => ({
  useCan: () => () => true,
}));

mock.module("../../src/components/toast", () => ({
  useToast: () => ({
    show: mock(() => {}),
  }),
}));

mock.module("../../src/apps/use-installed-apps", () => ({
  useInstalledApps: () => ({ kind: "ready", apps: [], reload: () => {} }),
}));

mock.module("../../src/apps/use-conversion-runner", () => ({
  useConversionRunner: () => ({ run: mock(async () => null) }),
}));

mock.module("../../src/artifacts/workspace-artifacts-provider", () => ({
  useWorkspaceArtifacts: () => ({
    roomId: "test-room-id-uuid",
    artifacts: [],
    loading: true,
    error: null,
    refresh: mock(() => {}),
    updateArtifacts: mock(() => {}),
  }),
}));

mock.module("../../src/lib/api", () => ({
  apiClient: {
    listWorkspaceArtifacts: mock(() => Promise.resolve({ artifacts: [] })),
    subscribeWorkspaceArtifactEvents: mock(() => () => {}),
    createWorkspaceArtifact: mock(async () => ({})),
    renameWorkspaceArtifact: mock(async () => ({})),
    deleteWorkspaceArtifact: mock(async () => {}),
    getWorkspaceArtifactBytes: mock(async () => new Blob()),
    getWorkspaceArtifactObjectUrl: mock(async () => "blob:fake"),
  },
}));

const { ArtifactTreeView } = await import("../../src/components/browser-column/artifact-tree-view");

describe("ArtifactTreeView", () => {
  test("initial markup shows loading marker", () => {
    const html = renderToStaticMarkup(<ArtifactTreeView />);
    expect(html).toContain("artifact-tree-loading");
    expect(html).toContain('data-testid="artifact-tree-view"');
  });
});
