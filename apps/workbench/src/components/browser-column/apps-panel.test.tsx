import { reapplyHappyDomGlobals } from "../../../tests/bun-dom-preload";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import type { ArtifactDto, MiniAppCreateActionDto, PublicMiniAppDto } from "@nautilo/api-client/browser";
import type { InstalledAppsState } from "../../apps/use-installed-apps";

const sampleApp: PublicMiniAppDto = {
  id: "sample-app",
  name: "Sample App",
  version: "0.1.0",
  status: "ready",
  sourceHash: "a".repeat(64),
  fileAssociations: {
    extensions: [],
    mimeTypes: [],
  },
  createActions: [
    {
      id: "new-note",
      label: "New note",
      defaultFilename: "Untitled note.html",
      mimeType: "text/html",
      targetSurfaces: ["workspace"],
      template: { kind: "file", path: "templates/empty-note.html" },
      openAfterCreate: true,
    },
  ],
  canEditSource: false,
  description: null,
  installedAt: null,
  enabled: true,
};

const slidesApp: PublicMiniAppDto = {
  ...sampleApp,
  id: "nautilo-presentation",
  name: "Slides",
  createActions: [],
};

const matchingArtifact: ArtifactDto = {
  id: "artifact-row-1",
  artifactId: "art-1",
  path: "budget.html",
  mimeType: "text/html",
  size: 12,
  revision: 1,
  updatedAt: "2026-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  namespaceIds: [],
};

let installedAppsState: InstalledAppsState = { kind: "loading" };
let isVerified = true;
let officeEnabled = false;
let activeRoomId = "test-room-id";
const requestOpenMiniApp = mock(() => true);
const requestOpenAppSource = mock(() => true);
const requestOpenAppsOverview = mock(() => true);
const requestOpenAppDetail = mock(() => true);
const onOpenFile = mock(() => {});
let associationContent: string | null = null;
const readFileTextForAssociation = mock(async () => associationContent);
const listWorkspaceArtifacts = mock(() => Promise.resolve({ artifacts: [matchingArtifact] }));
let workspaceArtifacts: ArtifactDto[] = [matchingArtifact];
const getMiniAppCreateTemplate = mock(() =>
  Promise.resolve({
    appId: "sample-app",
    actionId: "new-note",
    content: "<!doctype html><html></html>",
    mimeType: "text/html",
    sha256: "b".repeat(64),
  }),
);
const createWorkspaceArtifact = mock(() =>
  Promise.resolve({
    id: "created-row-1",
    artifactId: "created-art-1",
    path: "Untitled note.html",
    mimeType: "text/html",
    size: 28,
    revision: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    namespaceIds: [],
  }),
);
const createBlankOfficeDoc = mock(() =>
  Promise.resolve({
    id: "created-office-row-1",
    artifactId: "created-office-art-1",
    path: "Untitled document.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    size: 28,
    revision: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    namespaceIds: [],
  }),
);
let currentFolderPath: string | null = "/Users/test/Decks";
const getCurrentFolderPath = mock(async () => currentFolderPath);
const pickAndCommit = mock(async () => currentFolderPath);
const stat = mock(async () => ({ exists: false, isFile: false, isDirectory: false, size: 0, modified: null }));
const writeFile = mock(async () => ({ ok: true as const, sha256: "c".repeat(64), size: 28 }));
const localStat = stat;
const localWriteFile = writeFile;
const listMiniAppSourceTree = mock(() =>
  Promise.resolve({
    files: [
      { path: "manifest.json", kind: "file" as const },
      { path: "src", kind: "directory" as const },
    ],
  }),
);
mock.module("../../lib/desktop", () => ({
  isDesktop: true,
  desktopAPI: {
    currentFolder: { getPath: getCurrentFolderPath, pickAndCommit },
    fs: { stat, writeFile },
  },
}));

mock.module("./browser-column.context", () => ({
  useBrowserColumn: () => ({ currentFolderPath }),
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
      isVerified,
      capabilities: [],
      features: { office: { enabled: officeEnabled } },
      staleWhoami: false,
    },
  }),
}));

mock.module("../../contexts/room-navigation-context", () => ({
  useRoomNavigation: () => ({
    activeRoomId,
    activeRoom: { label: "Test Room" },
  }),
}));

mock.module("../../apps/use-installed-apps", () => ({
  useInstalledApps: () => ({ ...installedAppsState, reload: () => {} }),
}));

mock.module("../../apps/association-content-io", () => ({
  readFileTextForAssociation,
}));

mock.module("../../artifacts/workspace-artifacts-provider", () => ({
  useWorkspaceArtifacts: () => ({
    roomId: "test-room-id",
    artifacts: workspaceArtifacts,
    loading: false,
    error: null,
    refresh: mock(() => {}),
    upsertArtifact: (artifact: ArtifactDto) => {
      workspaceArtifacts = [
        ...workspaceArtifacts.filter((candidate) => candidate.id !== artifact.id),
        artifact,
      ];
    },
  }),
}));

mock.module("../../adapters/open-mini-app-ref", () => ({
  requestOpenMiniApp,
  supportsMiniAppPreview: (appId: string) => appId === "nautilo-presentation",
}));

mock.module("../../adapters/open-app-source-ref", () => ({
  requestOpenAppSource,
}));

mock.module("../../adapters/open-apps-surface-ref", () => ({
  requestOpenAppsOverview,
  requestOpenAppDetail,
  setOpenAppsOverviewDispatcher: () => {},
  setOpenAppDetailDispatcher: () => {},
}));

mock.module("../../lib/api", () => ({
  apiClient: {
    listWorkspaceArtifacts,
    listMiniAppSourceTree,
    getMiniAppCreateTemplate,
    createWorkspaceArtifact,
    createBlankOfficeDoc,
    setMiniAppEnabled: () => Promise.resolve({ ...sampleApp, enabled: false }),
  },
}));

const { AppsPanel, createActionFilename } = await import("./apps-panel");

/** happy-dom does not propagate fireEvent.change to controlled text/search inputs. */
function typeInControlledInput(input: HTMLInputElement, value: string): void {
  const propsKey = Object.keys(input).find((k) => k.startsWith("__reactProps$"));
  if (!propsKey) throw new Error("React props not found on input element");
  const props = (input as HTMLInputElement & Record<string, unknown>)[propsKey] as {
    onChange: (e: { target: { value: string } }) => void;
  };
  props.onChange({ target: { value } });
}


beforeEach(() => {
  reapplyHappyDomGlobals();
  localStorage.clear();
  activeRoomId = "test-room-id";
  isVerified = true;
  officeEnabled = false;
  associationContent = null;
  workspaceArtifacts = [matchingArtifact];
  installedAppsState = { kind: "loading" };
  requestOpenMiniApp.mockClear();
  requestOpenAppSource.mockClear();
  requestOpenAppsOverview.mockClear();
  requestOpenAppDetail.mockClear();
  onOpenFile.mockClear();
  readFileTextForAssociation.mockClear();
  listWorkspaceArtifacts.mockClear();
  listMiniAppSourceTree.mockClear();
  getMiniAppCreateTemplate.mockClear();
  createWorkspaceArtifact.mockClear();
  createBlankOfficeDoc.mockClear();
  currentFolderPath = "/Users/test/Decks";
  getCurrentFolderPath.mockClear();
  pickAndCommit.mockClear();
  stat.mockClear();
  stat.mockImplementation(async () => ({ exists: false, isFile: false, isDirectory: false, size: 0, modified: null }));
  writeFile.mockClear();
  writeFile.mockImplementation(async () => ({ ok: true as const, sha256: "c".repeat(64), size: 28 }));
});

describe("AppsPanel", () => {
  test("renders guest gate when viewer is unverified", () => {
    isVerified = false;
    installedAppsState = {
      kind: "ready",
      apps: [{ ...sampleApp, fileAssociations: { mimeTypes: ["text/html"] } }],
    };
    const view = render(<AppsPanel />);
    expect(view.getByText("Apps are locked")).toBeTruthy();
    expect(readFileTextForAssociation).not.toHaveBeenCalled();
  });

  test("renders loading state", () => {
    const view = render(<AppsPanel />);
    expect(view.getByTestId("apps-panel-loading")).toBeTruthy();
    expect(view.getByText("Loading apps…")).toBeTruthy();
  });

  test("renders error state", () => {
    installedAppsState = { kind: "error", message: "Network unavailable" };
    const view = render(<AppsPanel />);
    expect(view.getByTestId("apps-panel-error")).toBeTruthy();
    expect(view.getByText("Network unavailable")).toBeTruthy();
  });

  test("renders empty state", () => {
    installedAppsState = { kind: "ready", apps: [] };
    const view = render(<AppsPanel />);
    expect(view.getByTestId("apps-panel-empty")).toBeTruthy();
    expect(view.getByText("No apps installed yet.")).toBeTruthy();
  });

  test("hides LibreOffice section when office is disabled", () => {
    installedAppsState = { kind: "ready", apps: [sampleApp] };
    const view = render(<AppsPanel />);
    expect(view.queryByTestId("apps-panel-office-suite")).toBeNull();
  });

  test("shows LibreOffice section when office is enabled", async () => {
    officeEnabled = true;
    installedAppsState = { kind: "ready", apps: [] };
    const view = render(<AppsPanel />);
    expect(view.getByTestId("apps-panel-office-suite")).toBeTruthy();
    expect(view.getByTestId("apps-panel-office-writer")).toBeTruthy();
  });

  test("LibreOffice section is collapsible via the real CollapsibleSection", () => {
    officeEnabled = true;
    installedAppsState = { kind: "ready", apps: [] };
    const view = render(<AppsPanel />);

    // Expanded by default: the labelled group + per-kind boxed cards render.
    expect(view.getByText("LibreOffice (3)")).toBeTruthy();
    expect(view.getByTestId("apps-panel-office-writer")).toBeTruthy();
    expect(view.getByTestId("apps-panel-office-calc")).toBeTruthy();
    expect(view.getByTestId("apps-panel-office-impress")).toBeTruthy();

    // Collapsing hides the cards and persists the state under the group key.
    fireEvent.click(view.getByTestId("apps-panel-group-libreoffice-toggle"));
    expect(view.queryByTestId("apps-panel-office-writer")).toBeNull();
    expect(localStorage.getItem("nautilo.apps.group.expanded.v1:libreoffice")).toBe("0");
  });

  test("LibreOffice cards expose New + Upload actions", () => {
    officeEnabled = true;
    installedAppsState = { kind: "ready", apps: [] };
    const view = render(<AppsPanel />);

    expect(view.getByTestId("apps-panel-office-new-writer")).toBeTruthy();
    expect(view.getByTestId("apps-panel-office-upload-writer")).toBeTruthy();
  });

  test("omits the unavailable install button", () => {
    installedAppsState = { kind: "ready", apps: [sampleApp] };
    const view = render(<AppsPanel />);
    expect(view.queryByTestId("apps-panel-install")).toBeNull();
  });

  test("search matches names, descriptions and IDs, and clearing restores collapsed groups", async () => {
    const storageKey = "nautilo.apps.group.expanded.v1:other-apps";
    localStorage.setItem(storageKey, "0");
    installedAppsState = { kind: "ready", apps: [
      { ...sampleApp, description: "Write documents" },
      { ...sampleApp, id: "paint", name: "Paint", description: "Draw pictures" },
    ] };
    const view = render(<AppsPanel />);
    const input = view.getByRole("searchbox", { name: "Search apps" }) as HTMLInputElement;
    expect(view.queryByTestId("apps-panel-row-sample-app")).toBeNull();
    for (const query of ["  SAMPLE  ", "documents", "sample-app"]) {
      await act(async () => typeInControlledInput(input, query));
      expect(view.getByTestId("apps-panel-row-sample-app")).toBeTruthy();
      expect(view.queryByTestId("apps-panel-row-paint")).toBeNull();
      expect(view.getByText("Other Apps (1)")).toBeTruthy();
      expect(localStorage.getItem(storageKey)).toBe("0");
    }
    await act(async () => typeInControlledInput(input, "unmatched"));
    expect(view.getByTestId("apps-panel-no-matches").textContent).toContain("unmatched");
    expect(view.queryByTestId("apps-panel-group-other-apps")).toBeNull();
    await act(async () => typeInControlledInput(input, ""));
    expect(view.queryByTestId("apps-panel-no-matches")).toBeNull();
    expect(view.getByText("Other Apps (2)")).toBeTruthy();
    expect(view.queryByTestId("apps-panel-row-sample-app")).toBeNull();
    fireEvent.click(view.getByTestId("apps-panel-group-other-apps-toggle"));
    expect(view.getByTestId("apps-panel-row-sample-app")).toBeTruthy();
    expect(view.getByTestId("apps-panel-row-paint")).toBeTruthy();
  });

  test("search includes enabled LibreOffice apps and hides unrelated results", async () => {
    officeEnabled = true;
    localStorage.setItem("nautilo.apps.group.expanded.v1:libreoffice", "0");
    installedAppsState = { kind: "ready", apps: [sampleApp] };
    const view = render(<AppsPanel />);
    const input = view.getByTestId("apps-panel-search") as HTMLInputElement;
    await act(async () => typeInControlledInput(input, "writer"));
    expect(view.getByTestId("apps-panel-office-writer")).toBeTruthy();
    expect(view.queryByTestId("apps-panel-office-calc")).toBeNull();
    expect(view.queryByTestId("apps-panel-row-sample-app")).toBeNull();
    await act(async () => typeInControlledInput(input, "libreoffice"));
    expect(view.getByText("LibreOffice (3)")).toBeTruthy();
    await act(async () => typeInControlledInput(input, "sample"));
    expect(view.queryByTestId("apps-panel-office-suite")).toBeNull();
    expect(view.getByTestId("apps-panel-row-sample-app")).toBeTruthy();
    await act(async () => typeInControlledInput(input, "missing"));
    expect(view.getByTestId("apps-panel-no-matches")).toBeTruthy();
    await act(async () => typeInControlledInput(input, ""));
    expect(view.getByText("LibreOffice (3)")).toBeTruthy();
    expect(view.queryByTestId("apps-panel-office-writer")).toBeNull();
  });

  test("ready app with createActions renders primary create button enabled with no status badge", () => {
    installedAppsState = { kind: "ready", apps: [sampleApp] };
    const view = render(<AppsPanel />);

    expect(view.getByTestId("apps-panel-create-primary-sample-app")).toHaveProperty("disabled", false);
    // Inline Launch is replaced by the create primary; raw Launch lives in the
    // overflow menu only (opened separately).
    expect(view.queryByTestId("apps-panel-launch-sample-app")).toBeNull();
    expect(view.queryByTestId("apps-panel-status-sample-app")).toBeNull();
  });

  test("ready app without createActions keeps Launch as primary button", () => {
    installedAppsState = {
      kind: "ready",
      apps: [{ ...sampleApp, createActions: [] }],
    };
    const view = render(<AppsPanel />);

    const launch = view.getByTestId("apps-panel-launch-sample-app");
    expect(launch).toHaveProperty("disabled", false);
    expect(launch.textContent).toBe("Launch");
    expect(view.queryByTestId("apps-panel-create-primary-sample-app")).toBeNull();
  });

  test("uses the shared Slides icon in the sidebar", () => {
    installedAppsState = { kind: "ready", apps: [slidesApp] };
    const view = render(<AppsPanel />);

    const icon = view.getByTestId("apps-panel-row-nautilo-presentation").querySelector("img");
    expect(icon?.getAttribute("src")).toBe("/apps/office/slides.svg");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
  });

  test("uses the shared Board icon in the sidebar", () => {
    installedAppsState = { kind: "ready", apps: [{ ...slidesApp, id: "nautilo-board", name: "Board" }] };
    const view = render(<AppsPanel />);

    const icon = view.getByTestId("apps-panel-row-nautilo-board").querySelector("img");
    expect(icon?.getAttribute("src")).toBe("/apps/office/board.svg");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
  });

  test("ready app renders description when present", () => {
    const description =
      "Quick notes for the current workspace.";
    installedAppsState = {
      kind: "ready",
      apps: [{ ...sampleApp, description }],
    };
    const view = render(<AppsPanel />);

    const descriptionEl = view.getByTestId("apps-panel-description-sample-app");
    expect(descriptionEl.textContent).toBe(description);
  });

  test("groups apps by manifest display metadata and collapses sections", () => {
    installedAppsState = {
      kind: "ready",
      apps: [
        {
          ...sampleApp,
          display: {
            groupId: "reference-demos",
            groupName: "Reference Demos",
            groupOrder: 90,
            appOrder: 10,
            defaultCollapsed: false,
          },
        },
        {
          ...sampleApp,
          id: "writer",
          name: "Writer",
          createActions: [],
          display: {
            groupId: "nautilo-office",
            groupName: "Nautilo Office",
            groupOrder: 10,
            appOrder: 10,
            defaultCollapsed: false,
          },
        },
        {
          ...sampleApp,
          id: "nautilo-spreadsheet",
          name: "Sheets",
          createActions: [
            {
              ...sampleApp.createActions![0]!,
              id: "new-spreadsheet",
              label: "New spreadsheet",
              defaultFilename: "Untitled spreadsheet.html",
              template: { kind: "file", path: "templates/empty-spreadsheet.html" },
            },
          ],
          display: {
            groupId: "nautilo-office",
            groupName: "Nautilo Office",
            groupOrder: 10,
            appOrder: 20,
            defaultCollapsed: false,
          },
        },
      ],
    };
    const view = render(<AppsPanel />);

    expect(view.getByTestId("apps-panel-group-nautilo-office")).toBeTruthy();
    expect(view.getByTestId("apps-panel-group-reference-demos")).toBeTruthy();
    expect(view.getByText("Nautilo Office (2)")).toBeTruthy();
    expect(view.getByText("Reference Demos (1)")).toBeTruthy();
    expect(
      Array.from(
        view
          .getByTestId("apps-panel-group-nautilo-office")
          .querySelectorAll<HTMLElement>("[data-testid^='apps-panel-row-']"),
      ).map((row) => row.dataset.testid),
    ).toEqual(["apps-panel-row-writer", "apps-panel-row-nautilo-spreadsheet"]);
    expect(view.getByTestId("apps-panel-create-primary-nautilo-spreadsheet").textContent).toBe("New spreadsheet");
    const sheetsIcon = view.getByTestId("apps-panel-row-nautilo-spreadsheet").querySelector("img");
    expect(sheetsIcon?.getAttribute("src")).toBe("/apps/office/sheets.svg");
    expect(sheetsIcon?.getAttribute("aria-hidden")).toBe("true");

    fireEvent.click(view.getByTestId("apps-panel-group-reference-demos-toggle"));
    expect(view.queryByTestId("apps-panel-row-sample-app")).toBeNull();
    expect(localStorage.getItem("nautilo.apps.group.expanded.v1:reference-demos")).toBe("0");
    expect(view.getByTestId("apps-panel-row-writer")).toBeTruthy();
    expect(view.getByTestId("apps-panel-row-nautilo-spreadsheet")).toBeTruthy();
  });

  test("overflow menu shows actionable Disable (D343); Uninstall still disabled", () => {
    installedAppsState = {
      kind: "ready",
      apps: [{ ...sampleApp, createActions: [] }],
    };
    const view = render(<AppsPanel />);

    fireEvent.click(view.getByTestId("apps-panel-menu-sample-app"));
    const disable = view.getByTestId("apps-panel-disable-sample-app");
    expect(disable).toHaveProperty("disabled", false);
    expect(disable.textContent).toBe("Disable");
    expect(view.getByTestId("apps-panel-uninstall-sample-app")).toHaveProperty("disabled", true);
  });

  test("shows association summary and still launches via overflow menu when app has createActions", async () => {
    installedAppsState = { kind: "ready", apps: [sampleApp] };
    const view = render(<AppsPanel />);

    expect(view.getByTestId("apps-panel-associations-sample-app").textContent).toBe("No associations");

    fireEvent.click(view.getByTestId("apps-panel-menu-sample-app"));
    const launchItem = view.getByTestId("apps-panel-launch-sample-app");
    expect(launchItem.textContent).toBe("Launch without document");
    fireEvent.click(launchItem);
    expect(requestOpenMiniApp).toHaveBeenCalledWith("sample-app");

  });

  test("a disabled app remains visible but cannot create or launch from its menu", () => {
    installedAppsState = { kind: "ready", apps: [{ ...sampleApp, enabled: false }] };
    const view = render(<AppsPanel />);

    expect(view.getByTestId("apps-panel-create-primary-sample-app")).toHaveProperty("disabled", true);
    fireEvent.click(view.getByTestId("apps-panel-menu-sample-app"));
    expect(view.getByTestId("apps-panel-launch-sample-app")).toHaveProperty("disabled", true);
    expect(view.getByTestId("apps-panel-create-sample-app-new-note")).toHaveProperty("disabled", true);
  });

  test("clicking the primary create button opens the create-name dialog", () => {
    installedAppsState = { kind: "ready", apps: [sampleApp] };
    const view = render(<AppsPanel />);

    const primary = view.getByTestId("apps-panel-create-primary-sample-app");
    expect(primary.textContent).toBe("New note");
    fireEvent.click(primary);

    const input = view.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("Untitled note.html");
  });

  test("creates a declared Current Folder app template locally and opens that exact file", async () => {
    currentFolderPath = "/fixtures/video-project";
    const videoApp: PublicMiniAppDto = {
      ...sampleApp,
      id: "nautilo-video",
      name: "Video",
      createActions: [{
        ...sampleApp.createActions[0]!,
        id: "new-video",
        label: "New video",
        defaultFilename: "Untitled.video.html",
        targetSurfaces: ["workspace", "currentFolder"],
      }],
    };
    installedAppsState = { kind: "ready", apps: [videoApp] };
    const view = render(<AppsPanel />);

    fireEvent.click(view.getByTestId("apps-panel-create-primary-nautilo-video"));
    fireEvent.click(view.getByRole("radio", { name: "Current Folder" }));
    fireEvent.click(view.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(localStat).toHaveBeenCalledWith("/fixtures/video-project/Untitled.video.html");
      expect(localWriteFile).toHaveBeenCalledWith(
        "/fixtures/video-project/Untitled.video.html",
        "<!doctype html><html></html>",
        { baseSha256: null },
      );
    });
    expect(createWorkspaceArtifact).not.toHaveBeenCalled();
    expect(requestOpenMiniApp).toHaveBeenCalledWith("nautilo-video", {
      kind: "fs",
      path: "/fixtures/video-project/Untitled.video.html",
      rootPath: "/fixtures/video-project",
    });
  });

  test("creates a Workspace Video with the canonical compound suffix", async () => {
    const videoApp: PublicMiniAppDto = {
      ...sampleApp,
      id: "nautilo-video",
      name: "Video",
      createActions: [{
        ...sampleApp.createActions[0]!,
        id: "new-video",
        label: "New video",
        defaultFilename: "Untitled.video.html",
        targetSurfaces: ["workspace", "currentFolder"],
      }],
    };
    installedAppsState = { kind: "ready", apps: [videoApp] };
    const view = render(<AppsPanel />);

    fireEvent.click(view.getByTestId("apps-panel-create-primary-nautilo-video"));
    fireEvent.click(view.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(createWorkspaceArtifact).toHaveBeenCalledWith(
      expect.any(Blob),
      expect.objectContaining({ path: "Untitled.video.html" }),
    ));
  });

  test("disables launch for non-ready apps and shows status badges", () => {
    installedAppsState = {
      kind: "ready",
      apps: [
        { ...sampleApp, status: "invalid_manifest" },
        { ...sampleApp, id: "deps", status: "needs_dependencies", createActions: [] },
      ],
    };
    const view = render(<AppsPanel />);

    expect(view.getByTestId("apps-panel-launch-sample-app")).toHaveProperty("disabled", true);
    expect(view.getByTestId("apps-panel-status-sample-app").textContent).toBe("Invalid manifest");
    expect(view.getByText("Fix the app manifest before launching.")).toBeTruthy();

    expect(view.getByTestId("apps-panel-launch-deps")).toHaveProperty("disabled", true);
    expect(view.getByTestId("apps-panel-status-deps").textContent).toBe("Needs dependencies");
    expect(view.getByText("Install app dependencies before launching.")).toBeTruthy();
  });

  test("opens matching workspace artifacts in the app", async () => {
    installedAppsState = {
      kind: "ready",
      apps: [
        {
          ...sampleApp,
          fileAssociations: { mimeTypes: ["text/html"] },
          createActions: [],
        },
      ],
    };
    const view = render(<AppsPanel onOpenFile={onOpenFile} />);

    const openButton = await view.findByTestId("apps-panel-open-sample-app-artifact-row-1");
    fireEvent.click(openButton);

    expect(requestOpenMiniApp).toHaveBeenCalledWith("sample-app", {
      kind: "artifact",
      id: "artifact-row-1",
      path: "budget.html",
      mimeType: "text/html",
      roomId: "test-room-id",
    });
  });

  test("previews an associated Slides document in the Slides runtime", async () => {
    const slidesApp: PublicMiniAppDto = {
      ...sampleApp,
      id: "nautilo-presentation",
      name: "Slides",
      createActions: [],
      contentAssociations: [
        {
          id: "wafflebase-presentation",
          kind: "html-script-json",
          scriptId: "manifest",
          scriptType: "application/vnd.nautilo.document+json",
          match: {
            documentType: "presentation",
            editor: "wafflebase",
            payloadFormat: "application/vnd.wafflebase.presentation+json",
          },
        },
      ],
    };
    associationContent = `<script type="application/vnd.nautilo.document+json" id="manifest">{"documentType":"presentation","editor":"wafflebase","payloadFormat":"application/vnd.wafflebase.presentation+json"}</script>`;
    installedAppsState = { kind: "ready", apps: [slidesApp] };
    const view = render(<AppsPanel onOpenFile={onOpenFile} />);

    const preview = await view.findByTestId(
      "apps-panel-preview-nautilo-presentation-artifact-row-1",
    );
    fireEvent.click(preview);

    expect(requestOpenMiniApp).toHaveBeenCalledWith(
      "nautilo-presentation",
      {
        kind: "artifact",
        id: "artifact-row-1",
        path: "budget.html",
        mimeType: "text/html",
        roomId: "test-room-id",
      },
      { mode: "preview" },
    );
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  test("falls back to the generic reader when Slides preview has no shell dispatcher", async () => {
    const slidesApp: PublicMiniAppDto = {
      ...sampleApp,
      id: "nautilo-presentation",
      name: "Slides",
      createActions: [],
      fileAssociations: { extensions: [], mimeTypes: ["text/html"] },
    };
    installedAppsState = { kind: "ready", apps: [slidesApp] };
    requestOpenMiniApp.mockImplementationOnce(() => false);
    const view = render(<AppsPanel onOpenFile={onOpenFile} />);

    fireEvent.click(await view.findByTestId(
      "apps-panel-preview-nautilo-presentation-artifact-row-1",
    ));

    expect(onOpenFile).toHaveBeenCalledWith({
      kind: "artifact",
      id: "artifact-row-1",
      path: "budget.html",
      mimeType: "text/html",
      roomId: "test-room-id",
    });
  });

  test("routes a Video manifest artifact to Video instead of a broad Design HTML MIME claimant", async () => {
    const videoArtifact: ArtifactDto = {
      ...matchingArtifact,
      id: "video-artifact-row-1",
      artifactId: "video-art-1",
      path: "d378-login-retry.video.html",
    };
    const videoApp: PublicMiniAppDto = {
      ...sampleApp,
      id: "nautilo-video",
      name: "Video",
      createActions: [],
      contentAssociations: [
        {
          id: "video-html",
          kind: "html-script-json",
          scriptId: "manifest",
          scriptType: "application/vnd.nautilo.document+json",
          match: {
            documentType: "video",
            editor: "nautilo-video",
            payloadFormat: "application/vnd.nautilo.video-edl+json",
          },
        },
      ],
    };
    const designApp: PublicMiniAppDto = {
      ...sampleApp,
      id: "nautilo-design",
      name: "Nautilo Design",
      createActions: [],
      fileAssociations: { extensions: [".design.html"], mimeTypes: ["text/html"] },
      contentAssociations: [
        {
          id: "design-html",
          kind: "html-script-json",
          scriptId: "manifest",
          scriptType: "application/vnd.nautilo.design+json",
          match: {
            documentType: "design",
            editor: "nautilo-design",
            payloadFormat: "application/vnd.nautilo.design-scene+json",
          },
        },
      ],
    };
    associationContent = `<script type="application/vnd.nautilo.document+json" id="manifest">\n      {"documentType":"video","editor":"nautilo-video","payloadId":"nautilo-video-edl","payloadFormat":"application/vnd.nautilo.video-edl+json","version":"1.0"}\n    </script>`;
    workspaceArtifacts = [videoArtifact];
    installedAppsState = { kind: "ready", apps: [designApp, videoApp] };

    const view = render(<AppsPanel />);
    const openButton = await view.findByTestId("apps-panel-open-nautilo-video-video-artifact-row-1");
    expect(view.queryByTestId("apps-panel-open-nautilo-design-video-artifact-row-1")).toBeNull();

    fireEvent.click(openButton);
    expect(requestOpenMiniApp).toHaveBeenCalledWith("nautilo-video", {
      kind: "artifact",
      id: "video-artifact-row-1",
      path: "d378-login-retry.video.html",
      mimeType: "text/html",
      roomId: "test-room-id",
    });
  });

  test("keeps a verified HTML row visible while its updated revision is being re-read", async () => {
    const nativeApp: PublicMiniAppDto = {
      ...sampleApp,
      id: "native-doc",
      name: "Native Doc",
      createActions: [],
      contentAssociations: [{
        id: "native-html",
        kind: "html-script-json",
        scriptId: "manifest",
        scriptType: "application/vnd.nautilo.document+json",
        match: { documentType: "native", editor: "native-doc", payloadFormat: "application/json" },
      }],
    };
    const content = `<script type="application/vnd.nautilo.document+json" id="manifest">{"documentType":"native","editor":"native-doc","payloadId":"document","payloadFormat":"application/json","version":"1.0"}</script>`;
    let resolveRefresh: ((value: string | null) => void) | null = null;
    associationContent = content;
    installedAppsState = { kind: "ready", apps: [nativeApp] };

    const view = render(<AppsPanel />);
    expect(await view.findByTestId("apps-panel-open-native-doc-artifact-row-1")).toBeTruthy();

    readFileTextForAssociation.mockImplementationOnce(() => new Promise((resolve) => {
      resolveRefresh = resolve;
    }));
    workspaceArtifacts = [{
      ...matchingArtifact,
      revision: 2,
      updatedAt: "2026-01-01T00:00:01.000Z",
    }];
    view.rerender(<AppsPanel />);

    expect(view.getByTestId("apps-panel-open-native-doc-artifact-row-1")).toBeTruthy();
    await Promise.resolve();
    expect(view.getByTestId("apps-panel-open-native-doc-artifact-row-1")).toBeTruthy();
    resolveRefresh?.(content);
    await waitFor(() => expect(readFileTextForAssociation).toHaveBeenCalledTimes(2));
  });

  test("keeps the Board row mounted while each autosaved revision is being re-read", async () => {
    const nativeApp: PublicMiniAppDto = {
      ...sampleApp,
      id: "nautilo-board",
      name: "Board",
      createActions: [],
      contentAssociations: [{
        id: "wafflebase-board",
        kind: "html-script-json",
        scriptId: "manifest",
        scriptType: "application/vnd.nautilo.document+json",
        match: { documentType: "board", editor: "wafflebase", payloadFormat: "application/vnd.wafflebase.board+json" },
      }],
    };
    const content = `<script type="application/vnd.nautilo.document+json" id="manifest">{"documentType":"board","editor":"wafflebase","payloadId":"wafflebase-board","payloadFormat":"application/vnd.wafflebase.board+json","version":"1.0"}</script>`;
    let resolveRefresh: ((value: string | null) => void) | null = null;
    associationContent = content;
    installedAppsState = { kind: "ready", apps: [nativeApp] };

    const view = render(<AppsPanel />);
    expect(await view.findByTestId("apps-panel-open-nautilo-board-artifact-row-1")).toBeTruthy();

    readFileTextForAssociation.mockImplementationOnce(() => new Promise((resolve) => {
      resolveRefresh = resolve;
    }));
    workspaceArtifacts = [{
      ...matchingArtifact,
      revision: 2,
      updatedAt: "2026-01-01T00:00:01.000Z",
    }];
    view.rerender(<AppsPanel />);

    expect(view.getByTestId("apps-panel-open-nautilo-board-artifact-row-1")).toBeTruthy();
    await Promise.resolve();
    expect(view.getByTestId("apps-panel-open-nautilo-board-artifact-row-1")).toBeTruthy();
    resolveRefresh?.(content);
    await waitFor(() => expect(readFileTextForAssociation).toHaveBeenCalledTimes(2));
  });

  test("replaces a carried verified match after refreshed content names another app", async () => {
    const association = (appId: string) => ({
      id: `${appId}-html`,
      kind: "html-script-json" as const,
      scriptId: "manifest",
      scriptType: "application/vnd.nautilo.document+json",
      match: { documentType: appId, editor: appId, payloadFormat: "application/json" },
    });
    const firstApp: PublicMiniAppDto = { ...sampleApp, id: "first-app", name: "First", createActions: [], contentAssociations: [association("first-app")] };
    const secondApp: PublicMiniAppDto = { ...sampleApp, id: "second-app", name: "Second", createActions: [], contentAssociations: [association("second-app")] };
    const manifest = (appId: string) => `<script type="application/vnd.nautilo.document+json" id="manifest">{"documentType":"${appId}","editor":"${appId}","payloadId":"document","payloadFormat":"application/json","version":"1.0"}</script>`;
    associationContent = manifest("first-app");
    installedAppsState = { kind: "ready", apps: [firstApp, secondApp] };
    const view = render(<AppsPanel />);
    expect(await view.findByTestId("apps-panel-open-first-app-artifact-row-1")).toBeTruthy();

    associationContent = manifest("second-app");
    workspaceArtifacts = [{ ...matchingArtifact, revision: 2 }];
    view.rerender(<AppsPanel />);
    expect(view.getByTestId("apps-panel-open-first-app-artifact-row-1")).toBeTruthy();
    expect(await view.findByTestId("apps-panel-open-second-app-artifact-row-1")).toBeTruthy();
    expect(view.queryByTestId("apps-panel-open-first-app-artifact-row-1")).toBeNull();
  });

  test("does not reuse a verified HTML match after the active room changes", async () => {
    const nativeApp: PublicMiniAppDto = {
      ...sampleApp,
      id: "native-doc",
      name: "Native Doc",
      createActions: [],
      contentAssociations: [{
        id: "native-html",
        kind: "html-script-json",
        scriptId: "manifest",
        scriptType: "application/vnd.nautilo.document+json",
        match: { documentType: "native", editor: "native-doc", payloadFormat: "application/json" },
      }],
    };
    associationContent = `<script type="application/vnd.nautilo.document+json" id="manifest">{"documentType":"native","editor":"native-doc","payloadId":"document","payloadFormat":"application/json","version":"1.0"}</script>`;
    installedAppsState = { kind: "ready", apps: [nativeApp] };
    const view = render(<AppsPanel />);
    expect(await view.findByTestId("apps-panel-open-native-doc-artifact-row-1")).toBeTruthy();

    readFileTextForAssociation.mockImplementationOnce(() => new Promise(() => {}));
    activeRoomId = "other-room-id";
    view.rerender(<AppsPanel />);
    expect(view.queryByTestId("apps-panel-open-native-doc-artifact-row-1")).toBeNull();
  });

  test("lists recent Design artifacts by embedded provenance and never claims plain HTML", async () => {
    const designArtifact: ArtifactDto = {
      ...matchingArtifact,
      id: "design-artifact-row-1",
      artifactId: "design-art-1",
      path: "Launch.design.html",
      updatedAt: "2026-08-12T12:00:00.000Z",
    };
    const plainHtml: ArtifactDto = {
      ...matchingArtifact,
      id: "plain-html-row-1",
      artifactId: "plain-html-art-1",
      path: "notes.html",
      updatedAt: "2026-08-12T13:00:00.000Z",
    };
    const designApp: PublicMiniAppDto = {
      ...sampleApp,
      id: "nautilo-design",
      name: "Nautilo Design",
      createActions: [],
      fileAssociations: { extensions: [], mimeTypes: [] },
      contentAssociations: [
        {
          id: "design-html",
          kind: "html-script-json",
          scriptId: "manifest",
          scriptType: "application/vnd.nautilo.design+json",
          match: {
            documentType: "design",
            editor: "nautilo-design",
            payloadFormat: "application/vnd.nautilo.design-scene+json",
          },
        },
      ],
    };
    readFileTextForAssociation.mockImplementation(async (target) =>
      target.path.endsWith(".design.html")
        ? `<script type="application/vnd.nautilo.design+json" id="manifest">{"documentType":"design","editor":"nautilo-design","payloadId":"scene","payloadFormat":"application/vnd.nautilo.design-scene+json","version":"1.0"}</script>`
        : "<!doctype html><p>ordinary HTML</p>",
    );
    workspaceArtifacts = [plainHtml, designArtifact];
    installedAppsState = { kind: "ready", apps: [designApp] };

    const view = render(<AppsPanel />);
    expect(await view.findByTestId("apps-panel-open-nautilo-design-design-artifact-row-1")).toBeTruthy();
    expect(view.queryByTestId("apps-panel-open-nautilo-design-plain-html-row-1")).toBeNull();
    expect(view.getByTestId("apps-panel-associations-nautilo-design").textContent).toBe(
      "Design documents · verified manifest",
    );
  });

  test("falls back to metadata association when bounded HTML content read fails", async () => {
    const designApp: PublicMiniAppDto = {
      ...sampleApp,
      id: "nautilo-design",
      name: "Nautilo Design",
      createActions: [],
      fileAssociations: { mimeTypes: ["text/html"] },
    };
    readFileTextForAssociation.mockImplementationOnce(async () => {
      throw new Error("offline");
    });
    installedAppsState = { kind: "ready", apps: [designApp] };

    const view = render(<AppsPanel />);
    const openButton = await view.findByTestId("apps-panel-open-nautilo-design-artifact-row-1");
    fireEvent.click(openButton);

    expect(requestOpenMiniApp).toHaveBeenCalledWith("nautilo-design", {
      kind: "artifact",
      id: "artifact-row-1",
      path: "budget.html",
      mimeType: "text/html",
      roomId: "test-room-id",
    });
  });

  test("creates a workspace artifact from app-declared template and opens it", async () => {
    installedAppsState = { kind: "ready", apps: [sampleApp] };
    const view = render(<AppsPanel onOpenFile={onOpenFile} />);

    fireEvent.click(view.getByTestId("apps-panel-menu-sample-app"));
    fireEvent.click(view.getByTestId("apps-panel-create-sample-app-new-note"));
    const input = view.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("Untitled note.html");
    fireEvent.click(view.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(getMiniAppCreateTemplate).toHaveBeenCalledWith("sample-app", "new-note");
    });
    expect(createWorkspaceArtifact).toHaveBeenCalledWith(
      expect.any(Blob),
      {
        path: "Untitled note.html",
        mimeType: "text/html",
        roomId: "test-room-id",
      },
    );
    expect(requestOpenMiniApp).toHaveBeenCalledWith("sample-app", {
      kind: "artifact",
      id: "created-row-1",
      path: "Untitled note.html",
      mimeType: "text/html",
      roomId: "test-room-id",
    });
  });

  test("creates an app template in the captured Current Folder and opens its filesystem target", async () => {
    const dualSurfaceApp = {
      ...sampleApp,
      createActions: sampleApp.createActions?.map((action) => ({ ...action, targetSurfaces: ["workspace", "currentFolder"] as const })),
    };
    workspaceArtifacts = [{ ...matchingArtifact, id: "same-name-in-workspace", path: "Untitled note.html" }];
    installedAppsState = { kind: "ready", apps: [dualSurfaceApp] };
    const view = render(<AppsPanel />);

    fireEvent.click(view.getByTestId("apps-panel-create-primary-sample-app"));
    fireEvent.click(view.getByLabelText("Current Folder"));
    await view.findByText("/Users/test/Decks");
    fireEvent.click(view.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(writeFile).toHaveBeenCalledWith(
      "/Users/test/Decks/Untitled note.html",
      "<!doctype html><html></html>",
      { baseSha256: null },
    ));
    expect(requestOpenMiniApp).toHaveBeenCalledWith("sample-app", {
      kind: "fs",
      path: "/Users/test/Decks/Untitled note.html",
      rootPath: "/Users/test/Decks",
    });
    expect(createWorkspaceArtifact).not.toHaveBeenCalled();
  });

  test("opens at most one native folder picker while a choice is pending", async () => {
    const dualSurfaceApp = { ...sampleApp, createActions: sampleApp.createActions?.map((action) => ({ ...action, targetSurfaces: ["workspace", "currentFolder"] as const })) };
    let resolvePick!: (path: string | null) => void;
    pickAndCommit.mockImplementationOnce(() => new Promise((resolve) => { resolvePick = resolve; }));
    installedAppsState = { kind: "ready", apps: [dualSurfaceApp] };
    const view = render(<AppsPanel />);
    fireEvent.click(view.getByTestId("apps-panel-create-primary-sample-app"));
    fireEvent.click(view.getByLabelText("Current Folder"));
    await view.findByText("/Users/test/Decks");
    const choose = view.getByRole("button", { name: "Choose folder…" });
    fireEvent.click(choose);
    fireEvent.click(choose);
    expect(pickAndCommit).toHaveBeenCalledTimes(1);
    expect(view.getByRole("button", { name: "Choosing…" })).toBeTruthy();
    resolvePick("/Users/test/New Decks");
    expect(await view.findByText("/Users/test/New Decks")).toBeTruthy();
  });

  test("ignores a folder-picker result from a cancelled dialog after reopening", async () => {
    const dualSurfaceApp = { ...sampleApp, createActions: sampleApp.createActions?.map((action) => ({ ...action, targetSurfaces: ["workspace", "currentFolder"] as const })) };
    let resolvePick!: (path: string | null) => void;
    pickAndCommit.mockImplementationOnce(() => new Promise((resolve) => { resolvePick = resolve; }));
    installedAppsState = { kind: "ready", apps: [dualSurfaceApp] };
    const view = render(<AppsPanel />);
    fireEvent.click(view.getByTestId("apps-panel-create-primary-sample-app"));
    fireEvent.click(view.getByLabelText("Current Folder"));
    await view.findByText("/Users/test/Decks");
    fireEvent.click(view.getByRole("button", { name: "Choose folder…" }));
    fireEvent.click(view.getAllByRole("button", { name: "Cancel" })[0]!);
    fireEvent.click(view.getByTestId("apps-panel-create-primary-sample-app"));
    fireEvent.click(view.getByLabelText("Current Folder"));
    await view.findByText("/Users/test/Decks");
    resolvePick("/Users/test/Stale Pick");
    await Promise.resolve();
    expect(view.queryByText("/Users/test/Stale Pick")).toBeNull();
    expect(view.getByText("/Users/test/Decks")).toBeTruthy();
  });

  test("keeps the dialog open and reports a strict create conflict", async () => {
    const dualSurfaceApp = { ...sampleApp, createActions: sampleApp.createActions?.map((action) => ({ ...action, targetSurfaces: ["workspace", "currentFolder"] as const })) };
    writeFile.mockImplementationOnce(async () => ({ ok: false as const, code: "conflict" as const, currentSha256: "d".repeat(64) }));
    installedAppsState = { kind: "ready", apps: [dualSurfaceApp] };
    const view = render(<AppsPanel />);
    fireEvent.click(view.getByTestId("apps-panel-create-primary-sample-app"));
    fireEvent.click(view.getByLabelText("Current Folder"));
    await view.findByText("/Users/test/Decks");
    fireEvent.click(view.getByRole("button", { name: "Create" }));
    expect((await view.findByRole("alert")).textContent).toContain("already exists");
    expect((view.getByRole("textbox") as HTMLInputElement).value).toBe("Untitled note.html");
    expect(requestOpenMiniApp).not.toHaveBeenCalled();
  });

  test("reports an existing Current Folder path before attempting the exclusive write", async () => {
    const dualSurfaceApp = { ...sampleApp, createActions: sampleApp.createActions?.map((action) => ({ ...action, targetSurfaces: ["workspace", "currentFolder"] as const })) };
    stat.mockImplementationOnce(async () => ({ exists: true, isFile: true, isDirectory: false, size: 42, modified: "2026-09-08T00:00:00.000Z" }));
    installedAppsState = { kind: "ready", apps: [dualSurfaceApp] };
    const view = render(<AppsPanel />);
    fireEvent.click(view.getByTestId("apps-panel-create-primary-sample-app"));
    fireEvent.click(view.getByLabelText("Current Folder"));
    await view.findByText("/Users/test/Decks");
    fireEvent.click(view.getByRole("button", { name: "Create" }));
    expect((await view.findByRole("alert")).textContent).toContain("already exists");
    expect(stat).toHaveBeenCalledWith("/Users/test/Decks/Untitled note.html");
    expect(writeFile).not.toHaveBeenCalled();
  });

  test("rejects a folder switch during template fetch without writing or falling back", async () => {
    const dualSurfaceApp = { ...sampleApp, createActions: sampleApp.createActions?.map((action) => ({ ...action, targetSurfaces: ["workspace", "currentFolder"] as const })) };
    installedAppsState = { kind: "ready", apps: [dualSurfaceApp] };
    const view = render(<AppsPanel />);
    fireEvent.click(view.getByTestId("apps-panel-create-primary-sample-app"));
    fireEvent.click(view.getByLabelText("Current Folder"));
    await view.findByText("/Users/test/Decks");
    currentFolderPath = "/Users/test/Other";
    fireEvent.click(view.getByRole("button", { name: "Create" }));
    expect((await view.findByRole("alert")).textContent).toContain("Current Folder changed");
    expect(writeFile).not.toHaveBeenCalled();
    expect(createWorkspaceArtifact).not.toHaveBeenCalled();
  });

  test("guards a double submit while the template request is pending", async () => {
    let resolveTemplate!: (value: Awaited<ReturnType<typeof getMiniAppCreateTemplate>>) => void;
    getMiniAppCreateTemplate.mockImplementationOnce(() => new Promise((resolve) => { resolveTemplate = resolve; }));
    installedAppsState = { kind: "ready", apps: [sampleApp] };
    const view = render(<AppsPanel />);
    fireEvent.click(view.getByTestId("apps-panel-create-primary-sample-app"));
    const create = view.getByRole("button", { name: "Create" });
    fireEvent.click(create);
    fireEvent.click(create);
    expect(getMiniAppCreateTemplate).toHaveBeenCalledTimes(1);
    expect((view.getAllByRole("button", { name: "Cancel" })[0] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(view.getAllByRole("button", { name: "Cancel" })[0]!);
    expect(view.getByRole("dialog")).toBeTruthy();
    resolveTemplate({ appId: "sample-app", actionId: "new-note", content: "<!doctype html><html></html>", mimeType: "text/html", sha256: "b".repeat(64) });
    await waitFor(() => expect(createWorkspaceArtifact).toHaveBeenCalledTimes(1));
  });

  test("normalizes a bare Design name with its declared suffix and preserves explicit names", () => {
    const designAction: MiniAppCreateActionDto = {
      ...sampleApp.createActions![0]!,
      id: "new-design",
      label: "New design",
      defaultFilename: "Untitled.design.html",
    };

    expect(createActionFilename("D575 Design acceptance", designAction)).toBe("D575 Design acceptance.design.html");
    expect(createActionFilename("   ", designAction)).toBe("");
    expect(createActionFilename("D575 Design acceptance.custom.html", designAction)).toBe("D575 Design acceptance.custom.html");
  });

  test("normalizes Video names to its attestation-eligible compound suffix only when required", () => {
    const videoAction: MiniAppCreateActionDto = {
      ...sampleApp.createActions![0]!,
      id: "new-video",
      label: "New video",
      defaultFilename: "Untitled.video.html",
    };

    expect(createActionFilename("blue-cube", videoAction, true)).toBe("blue-cube.video.html");
    expect(createActionFilename("blue-cube.html", videoAction, true)).toBe("blue-cube.video.html");
    expect(createActionFilename("blue-cube.video.html", videoAction, true)).toBe("blue-cube.video.html");
    expect(createActionFilename("BLUE-CUBE.VIDEO.HTML", videoAction, true)).toBe("BLUE-CUBE.video.html");
    expect(createActionFilename("blue-cube.html", videoAction)).toBe("blue-cube.html");
  });

  test("shows recent matching workspace docs beneath a row and opens via mini-app path", async () => {
    const older: ArtifactDto = {
      ...matchingArtifact,
      id: "artifact-old",
      path: "older.html",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const newer: ArtifactDto = {
      ...matchingArtifact,
      id: "artifact-new",
      path: "newer.html",
      updatedAt: "2026-02-01T00:00:00.000Z",
    };
    workspaceArtifacts = [older, newer];
    installedAppsState = {
      kind: "ready",
      apps: [
        {
          ...sampleApp,
          fileAssociations: { mimeTypes: ["text/html"] },
          createActions: [],
        },
      ],
    };
    const view = render(<AppsPanel />);

    await view.findByTestId("apps-panel-recent-sample-app");
    const openNewer = await view.findByTestId(
      "apps-panel-recent-open-sample-app-artifact-new",
    );
    fireEvent.click(openNewer);

    expect(requestOpenMiniApp).toHaveBeenCalledWith("sample-app", {
      kind: "artifact",
      id: "artifact-new",
      path: "newer.html",
      mimeType: "text/html",
      roomId: "test-room-id",
    });
  });

  test("overflow menu shows Edit source only for capable apps", () => {
    installedAppsState = {
      kind: "ready",
      apps: [
        sampleApp,
        { ...sampleApp, id: "editor", canEditSource: true, createActions: [] },
      ],
    };
    const view = render(<AppsPanel />);

    fireEvent.click(view.getByTestId("apps-panel-menu-sample-app"));
    expect(view.queryByTestId("apps-panel-edit-source-sample-app")).toBeNull();

    fireEvent.click(view.getByTestId("apps-panel-menu-editor"));
    expect(view.getByTestId("apps-panel-edit-source-editor")).toBeTruthy();
  });

  test("open overview button calls requestOpenAppsOverview", () => {
    installedAppsState = { kind: "ready", apps: [sampleApp] };
    const view = render(<AppsPanel />);

    fireEvent.click(view.getByTestId("apps-panel-open-overview"));
    expect(requestOpenAppsOverview).toHaveBeenCalledTimes(1);
  });

  test("overflow menu Details item calls requestOpenAppDetail with app id", () => {
    installedAppsState = {
      kind: "ready",
      apps: [{ ...sampleApp, createActions: [] }],
    };
    const view = render(<AppsPanel />);

    fireEvent.click(view.getByTestId("apps-panel-menu-sample-app"));
    fireEvent.click(view.getByTestId("apps-panel-details-sample-app"));
    expect(requestOpenAppDetail).toHaveBeenCalledWith("sample-app");
  });

  test("expanding source tree fetches files and opens source editor on file click", async () => {
    installedAppsState = {
      kind: "ready",
      apps: [{ ...sampleApp, id: "editor", canEditSource: true, createActions: [] }],
    };
    const view = render(<AppsPanel />);

    fireEvent.click(view.getByTestId("apps-panel-menu-editor"));
    fireEvent.click(view.getByTestId("apps-panel-edit-source-editor"));

    await waitFor(() => {
      expect(listMiniAppSourceTree).toHaveBeenCalledWith("editor");
    });

    const editButton = await view.findByTestId("apps-panel-source-file-editor-manifest.json");
    fireEvent.click(editButton);

    expect(requestOpenAppSource).toHaveBeenCalledWith({
      kind: "app-source",
      appId: "editor",
      path: "manifest.json",
    });
  });
});
