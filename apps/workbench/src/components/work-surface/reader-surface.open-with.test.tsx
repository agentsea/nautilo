import { reapplyHappyDomGlobals } from "../../../tests/bun-dom-preload";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { PublicMiniAppDto } from "@nautilo/api-client/browser";
import type { OpenFileTarget } from "../browser-column/open-file-target";
import type { InstalledAppsState } from "../../apps/use-installed-apps";
import type { ViewerAdapter } from "../../viewers/types";

const sheetsApp: PublicMiniAppDto = {
  id: "nautilo-spreadsheet",
  name: "Sheets",
  version: "0.1.0",
  status: "ready",
  sourceHash: "a".repeat(64),
  fileAssociations: {
    extensions: [],
    mimeTypes: [],
  },
  contentAssociations: [
    {
      id: "spreadsheet-html",
      kind: "html-script-json",
      scriptId: "manifest",
      scriptType: "application/vnd.nautilo.document+json",
      match: {
        documentType: "spreadsheet",
        editor: "wafflebase",
        payloadFormat: "application/vnd.wafflebase.spreadsheet+json",
      },
    },
  ],
  canEditSource: false,
};

const writerApp: PublicMiniAppDto = {
  ...sheetsApp,
  id: "writer",
  name: "Writer",
  contentAssociations: [],
  conversions: {
    import: [
      {
        id: "import-docx",
        label: "Import Word document",
        from: { extensions: [".docx"] },
        sourceSurfaces: ["workspace", "currentFolder"],
        tool: "importDocx",
        target: { surface: "workspace", extension: ".html" },
      },
    ],
  },
};

const slidesApp: PublicMiniAppDto = {
  ...sheetsApp,
  id: "nautilo-presentation",
  name: "Slides",
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

const artifactTarget: OpenFileTarget = {
  kind: "artifact",
  id: "artifact-row-1",
  path: "budget.html",
  mimeType: "text/html",
};

const fsSpreadsheetTarget: OpenFileTarget = {
  kind: "fs",
  path: "/workspace/budget.html",
  rootPath: "/workspace",
};

const plainHtmlTarget: OpenFileTarget = {
  kind: "fs",
  path: "/workspace/plain.html",
  rootPath: "/workspace",
};

const xlsxTarget: OpenFileTarget = {
  kind: "fs",
  path: "/workspace/report.xlsx",
  rootPath: "/workspace",
};

const docxArtifactTarget: OpenFileTarget = {
  kind: "artifact",
  id: "artifact-docx-1",
  path: "report.docx",
  mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

let installedAppsState: InstalledAppsState = { kind: "loading" };
let associationContent: string | null = null;
const requestOpenMiniApp = mock(() => true);
const previewLoad = mock(async () => ({ kind: "ready" as const, data: {} }));

const previewAdapter: ViewerAdapter = {
  kind: "text",
  canView: () => true,
  load: previewLoad,
  Component: () => <div data-testid="preview">Preview</div>,
};

mock.module("../../lib/desktop", () => ({
  isDesktop: true,
  desktopAPI: {
    fs: {
      openPath: mock(async () => {}),
    },
  },
}));

mock.module("../../apps/use-installed-apps", () => ({
  useInstalledApps: () => installedAppsState,
}));

mock.module("../../adapters/open-mini-app-ref", () => ({
  requestOpenMiniApp,
  supportsMiniAppPreview: (appId: string) => appId === "nautilo-presentation",
}));

mock.module("../../lib/api", () => ({
  apiClient: {
    runMiniAppConversion: mock(async () => ({
      ok: true,
      result: {
        ok: true,
        status: "imported",
        artifactPath: "report.html",
      },
    })),
    listWorkspaceArtifacts: mock(async () => ({
      artifacts: [
        {
          id: "artifact-imported-1",
          artifactId: "ag-artifact-imported-1",
          path: "report.html",
          mimeType: "text/html",
          size: 1,
          revision: 1,
          updatedAt: "2026-01-01T00:00:00.000Z",
          createdAt: "2026-01-01T00:00:00.000Z",
          namespaceIds: [],
        },
      ],
    })),
  },
}));

mock.module("../../apps/association-content-io", () => ({
  readFileTextForAssociation: mock(async () => associationContent),
}));

mock.module("../../viewers/registry", () => ({
  adapterForFile: (file: OpenFileTarget) =>
    file.path.toLowerCase().endsWith(".docx") ? null : previewAdapter,
}));

const { ReaderSurface } = await import("./reader-surface");

beforeEach(() => {
  reapplyHappyDomGlobals();
  installedAppsState = { kind: "loading" };
  associationContent = null;
  requestOpenMiniApp.mockClear();
  previewLoad.mockClear();
});

describe("ReaderSurface app-open actions", () => {
  test("reloads preview bytes when the shell advances a local file reload token", async () => {
    const view = render(
      <ReaderSurface file={plainHtmlTarget} onClose={() => {}} />,
    );
    await waitFor(() => expect(previewLoad).toHaveBeenCalledTimes(1));

    view.rerender(
      <ReaderSurface file={{ ...plainHtmlTarget, reloadToken: 1 }} onClose={() => {}} />,
    );

    await waitFor(() => expect(previewLoad).toHaveBeenCalledTimes(2));
  });

  test("keeps the current document visible while a new artifact revision loads", async () => {
    let finishRefresh: ((result: { kind: "ready"; data: {} }) => void) | undefined;
    previewLoad.mockImplementationOnce(async () => ({ kind: "ready", data: {} }));
    previewLoad.mockImplementationOnce(() => new Promise((resolve) => {
      finishRefresh = resolve;
    }));
    const view = render(<ReaderSurface file={artifactTarget} onClose={() => {}} />);
    await waitFor(() => expect(view.getByTestId("preview")).toBeTruthy());

    view.rerender(
      <ReaderSurface file={{ ...artifactTarget, reloadToken: 2 }} onClose={() => {}} />,
    );
    await waitFor(() => expect(previewLoad).toHaveBeenCalledTimes(2));
    expect(view.getByTestId("preview")).toBeTruthy();

    finishRefresh?.({ kind: "ready", data: {} });
    await waitFor(() => expect(view.getByTestId("preview")).toBeTruthy());
  });

  test("shows primary Open in app for HTML artifact with spreadsheet manifest", async () => {
    installedAppsState = { kind: "ready", apps: [sheetsApp] };
    associationContent = `<script type="application/vnd.nautilo.document+json" id="manifest">{"documentType":"spreadsheet","editor":"wafflebase","payloadId":"wafflebase-spreadsheet","payloadFormat":"application/vnd.wafflebase.spreadsheet+json","version":"1.0"}</script>`;
    const view = render(
      <ReaderSurface file={artifactTarget} onClose={() => {}} />,
    );

    await waitFor(() => {
      expect(view.getByTestId("preview")).toBeTruthy();
    });

    await waitFor(() => {
      expect(view.getByRole("button", { name: "Open in Sheets" })).toBeTruthy();
    });
  });

  test("clicking primary Open in app calls requestOpenMiniApp with nautilo-spreadsheet and exact file target", async () => {
    installedAppsState = { kind: "ready", apps: [sheetsApp] };
    associationContent = `<script type="application/vnd.nautilo.document+json" id="manifest">{"documentType":"spreadsheet","editor":"wafflebase","payloadId":"wafflebase-spreadsheet","payloadFormat":"application/vnd.wafflebase.spreadsheet+json","version":"1.0"}</script>`;
    const view = render(
      <ReaderSurface file={artifactTarget} onClose={() => {}} />,
    );

    await waitFor(() => {
      expect(view.getByTestId("preview")).toBeTruthy();
    });

    await waitFor(() => {
      expect(view.getByRole("button", { name: "Open in Sheets" })).toBeTruthy();
    });

    fireEvent.click(view.getByRole("button", { name: "Open in Sheets" }));
    expect(requestOpenMiniApp).toHaveBeenCalledWith("nautilo-spreadsheet", artifactTarget);
  });

  test("automatically previews Slides only after its embedded manifest matches", async () => {
    installedAppsState = { kind: "ready", apps: [slidesApp] };
    associationContent = `<script type="application/vnd.nautilo.document+json" id="manifest">{"documentType":"presentation","editor":"wafflebase","payloadFormat":"application/vnd.wafflebase.presentation+json"}</script>`;

    render(<ReaderSurface file={artifactTarget} onClose={() => {}} />);

    await waitFor(() => {
      expect(requestOpenMiniApp).toHaveBeenCalledWith(
        "nautilo-presentation",
        artifactTarget,
        { mode: "preview" },
      );
    });
    expect(requestOpenMiniApp).toHaveBeenCalledTimes(1);
  });

  test("does not route ordinary HTML into Slides preview", async () => {
    installedAppsState = { kind: "ready", apps: [slidesApp] };
    associationContent = "<!doctype html><p>ordinary HTML</p>";

    const view = render(<ReaderSurface file={plainHtmlTarget} onClose={() => {}} />);

    await waitFor(() => expect(view.getByTestId("preview")).toBeTruthy());
    expect(requestOpenMiniApp).not.toHaveBeenCalled();
  });

  test("does not dispatch a new file with the previous file's Slides match", async () => {
    installedAppsState = { kind: "ready", apps: [slidesApp] };
    associationContent = `<script type="application/vnd.nautilo.document+json" id="manifest">{"documentType":"presentation","editor":"wafflebase","payloadFormat":"application/vnd.wafflebase.presentation+json"}</script>`;
    const view = render(<ReaderSurface file={artifactTarget} onClose={() => {}} />);
    await waitFor(() => expect(requestOpenMiniApp).toHaveBeenCalledTimes(1));
    requestOpenMiniApp.mockClear();
    associationContent = "<!doctype html><p>ordinary replacement</p>";
    const replacement: OpenFileTarget = {
      ...artifactTarget,
      id: "artifact-row-2",
      path: "ordinary.html",
      reloadToken: 1,
    };

    view.rerender(<ReaderSurface file={replacement} onClose={() => {}} />);
    await waitFor(() => expect(view.getByRole("heading", { name: "ordinary.html" })).toBeTruthy());
    await waitFor(() => expect(view.queryByRole("button", { name: "Open in Slides" })).toBeNull());
    expect(requestOpenMiniApp).not.toHaveBeenCalled();
  });

  test("FS HTML spreadsheet document shows primary Open in app and keeps Open Externally", async () => {
    installedAppsState = { kind: "ready", apps: [sheetsApp] };
    associationContent = `<script type="application/vnd.nautilo.document+json" id="manifest">{"documentType":"spreadsheet","editor":"wafflebase","payloadId":"wafflebase-spreadsheet","payloadFormat":"application/vnd.wafflebase.spreadsheet+json","version":"1.0"}</script>`;
    const view = render(
      <ReaderSurface file={fsSpreadsheetTarget} onClose={() => {}} />,
    );

    await waitFor(() => {
      expect(view.getByTestId("preview")).toBeTruthy();
    });

    await waitFor(() => {
      expect(view.getByRole("button", { name: "Open in Sheets" })).toBeTruthy();
    });
    expect(view.getByRole("button", { name: "Open Externally" })).toBeTruthy();
  });

  test("plain HTML does not show Open in app", async () => {
    installedAppsState = { kind: "ready", apps: [sheetsApp] };
    associationContent = "<h1>Plain document</h1>";
    const view = render(
      <ReaderSurface file={plainHtmlTarget} onClose={() => {}} />,
    );

    await waitFor(() => {
      expect(view.getByTestId("preview")).toBeTruthy();
    });

    expect(view.queryByRole("button", { name: "Open in Sheets" })).toBeNull();
  });

  test("renders primary Open in app from app association", async () => {
    installedAppsState = {
      kind: "ready",
      apps: [
        {
          ...sheetsApp,
          id: "kanban",
          name: "Kanban",
          contentAssociations: [
            {
              id: "kanban-html",
              kind: "html-script-json",
              scriptId: "manifest",
              scriptType: "application/vnd.nautilo.document+json",
              match: { documentType: "kanban", editor: "cards" },
            },
          ],
        },
      ],
    };
    associationContent = `<script type="application/vnd.nautilo.document+json" id="manifest">{"documentType":"kanban","editor":"cards","version":"1.0"}</script>`;
    const view = render(
      <ReaderSurface file={plainHtmlTarget} onClose={() => {}} />,
    );

    await waitFor(() => {
      expect(view.getByRole("button", { name: "Open in Kanban" })).toBeTruthy();
    });

    fireEvent.click(view.getByRole("button", { name: "Open in Kanban" }));
    expect(requestOpenMiniApp).toHaveBeenCalledWith("kanban", plainHtmlTarget);
  });

  test("plain HTML falls back to Edit Source after app association check", async () => {
    const onEdit = mock(() => {});
    installedAppsState = { kind: "ready", apps: [sheetsApp] };
    associationContent = "<h1>Plain document</h1>";
    const view = render(
      <ReaderSurface file={plainHtmlTarget} onClose={() => {}} onEdit={onEdit} />,
    );

    await waitFor(() => {
      expect(view.getByTestId("preview")).toBeTruthy();
    });

    await waitFor(() => {
      expect(view.getByRole("button", { name: "Edit Source" })).toBeTruthy();
    });

    fireEvent.click(view.getByRole("button", { name: "Edit Source" }));
    expect(onEdit).toHaveBeenCalledWith(plainHtmlTarget);
    expect(requestOpenMiniApp).not.toHaveBeenCalled();
  });

  test("shows Edit Source while app associations are still loading", async () => {
    const onEdit = mock(() => {});
    installedAppsState = { kind: "loading" };
    const view = render(
      <ReaderSurface file={artifactTarget} onClose={() => {}} onEdit={onEdit} />,
    );

    await waitFor(() => {
      expect(view.getByTestId("preview")).toBeTruthy();
    });

    fireEvent.click(view.getByRole("button", { name: "Edit Source" }));
    expect(onEdit).toHaveBeenCalledWith(artifactTarget);
  });

  test("does not show Open in app for .xlsx targets", async () => {
    installedAppsState = { kind: "ready", apps: [sheetsApp] };
    const view = render(
      <ReaderSurface file={xlsxTarget} onClose={() => {}} />,
    );

    await waitFor(() => {
      expect(view.getByTestId("preview")).toBeTruthy();
    });

    expect(view.queryByRole("button", { name: "Open in Sheets" })).toBeNull();
  });

  test("does not show Open in app when matching app is not ready", async () => {
    installedAppsState = {
      kind: "ready",
      apps: [{ ...sheetsApp, status: "needs_dependencies" }],
    };
    const view = render(
      <ReaderSurface file={artifactTarget} onClose={() => {}} />,
    );

    await waitFor(() => {
      expect(view.getByTestId("preview")).toBeTruthy();
    });

    expect(view.queryByRole("button", { name: "Open in Sheets" })).toBeNull();
  });

  test("renders Import to Writer for unsupported .docx artifact", async () => {
    installedAppsState = { kind: "ready", apps: [writerApp] };
    const view = render(
      <ReaderSurface file={docxArtifactTarget} onClose={() => {}} />,
    );

    await waitFor(() => {
      expect(view.getByText("Preview is not available for .docx yet.")).toBeTruthy();
    });

    expect(view.getAllByRole("button", { name: "Import to Writer" })).toHaveLength(2);
  });

  test("app-list error does not break preview rendering", async () => {
    installedAppsState = { kind: "error", message: "Network unavailable" };
    const view = render(
      <ReaderSurface file={artifactTarget} onClose={() => {}} />,
    );

    await waitFor(() => {
      expect(view.getByTestId("preview")).toBeTruthy();
    });

    expect(view.queryByRole("button", { name: "Open in Sheets" })).toBeNull();
    expect(view.getByRole("button", { name: "Retry Apps" })).toBeTruthy();
    expect(view.queryByText("Network unavailable")).toBeNull();
  });
});
