import { beforeEach, describe, expect, mock, test } from "bun:test";

const listWorkspaceArtifacts = mock(async () => ({ artifacts: [] }));

mock.module("../lib/api", () => ({
  apiClient: { listWorkspaceArtifacts },
}));

const { setOpenFileDispatcher } = await import("../adapters/open-file-ref");
const { buildImportRequest, openExportedResult } = await import("./run-conversion");

beforeEach(() => {
  setOpenFileDispatcher(null);
  listWorkspaceArtifacts.mockClear();
  listWorkspaceArtifacts.mockImplementation(async () => ({ artifacts: [] }));
});

describe("buildImportRequest", () => {
  test("carries the source artifact room into a workspace import", () => {
    expect(
      buildImportRequest(
        {
          id: "import-docx",
          label: "Import to Writer",
          from: { extensions: [".docx"], mimeTypes: [] },
          sourceSurfaces: ["workspace", "currentFolder"],
          tool: "import-docx",
          target: { surface: "workspace", extension: ".html" },
          openAfterImport: true,
        },
        {
          kind: "artifact",
          id: "source-row",
          path: "shared/report.docx",
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          roomId: "33333333-3333-4333-8333-333333333333",
        },
      ),
    ).toEqual({
      actionId: "import-docx",
      direction: "import",
      source: { surface: "workspace", path: "shared/report.docx" },
      roomId: "33333333-3333-4333-8333-333333333333",
    });
  });
});

describe("openExportedResult", () => {
  test("looks up the exact renamed workspace output in the source artifact room and opens its server row", async () => {
    const open = mock(() => {});
    setOpenFileDispatcher(open);
    listWorkspaceArtifacts.mockImplementation(async (options) => {
      expect(options).toEqual({ roomId: "room-a" });
      return {
        artifacts: [
          { id: "other-row", path: "exports/report.pdf", mimeType: "application/pdf" },
          { id: "internal-row-7", path: "exports/report-renamed.pdf", mimeType: "application/pdf" },
        ],
      };
    });

    const result = await openExportedResult(
      {
        kind: "artifact",
        id: "source-row",
        path: "source/report.html",
        mimeType: "text/html",
        roomId: "room-a",
      },
      { status: "exported", displayPath: "exports/report-renamed.pdf" },
      "exports/report.pdf",
    );

    expect(result).toEqual({ opened: true, artifactPath: "exports/report-renamed.pdf" });
    expect(open).toHaveBeenCalledWith({
      kind: "artifact",
      id: "internal-row-7",
      path: "exports/report-renamed.pdf",
      mimeType: "application/pdf",
      roomId: "room-a",
    });
  });

  test("uses an explicit artifact path when the export host provides one", async () => {
    const open = mock(() => {});
    setOpenFileDispatcher(open);
    listWorkspaceArtifacts.mockImplementation(async () => ({
      artifacts: [{ id: "internal-row-8", path: "exports/renamed.pdf", mimeType: "application/pdf" }],
    }));

    const result = await openExportedResult(
      { kind: "artifact", id: "source-row", path: "source.html", mimeType: "text/html" },
      { status: "exported", artifactPath: "exports/renamed.pdf" },
      "exports/requested.pdf",
    );

    expect(result).toEqual({ opened: true, artifactPath: "exports/renamed.pdf" });
    expect(open).toHaveBeenCalledWith({
      kind: "artifact",
      id: "internal-row-8",
      path: "exports/renamed.pdf",
      mimeType: "application/pdf",
    });
  });

  test("opens current-folder exports at the exact root-relative target", async () => {
    const open = mock(() => {});
    setOpenFileDispatcher(open);

    const result = await openExportedResult(
      { kind: "fs", path: "/workspace/source/report.html", rootPath: "/workspace" },
      { status: "exported", displayPath: "source/report.pdf" },
      "source/report.pdf",
    );

    expect(result).toEqual({ opened: true, artifactPath: "source/report.pdf" });
    expect(open).toHaveBeenCalledWith({
      kind: "fs",
      path: "/workspace/source/report.pdf",
      rootPath: "/workspace",
    });
    expect(listWorkspaceArtifacts).not.toHaveBeenCalled();
  });

  test("does not let an export host escape the current-folder root", async () => {
    const open = mock(() => {});
    setOpenFileDispatcher(open);
    const source = { kind: "fs" as const, path: "/workspace/source/report.html", rootPath: "/workspace" };

    for (const unsafePath of ["../report.pdf", "/tmp/report.pdf", "folder\\report.pdf", "folder/./report.pdf", "folder/../report.pdf", "folder/\u0000report.pdf", "C:report.pdf"]) {
      expect(
        await openExportedResult(source, { status: "exported", artifactPath: unsafePath }, "source/report.pdf"),
      ).toEqual({ opened: false, artifactPath: unsafePath });
    }
    expect(open).not.toHaveBeenCalled();
  });

  test("keeps a persisted export successful when its workspace row is not listed or listing fails", async () => {
    const open = mock(() => {});
    setOpenFileDispatcher(open);
    const source = { kind: "artifact" as const, id: "source-row", path: "source.html", mimeType: "text/html" };

    expect(
      await openExportedResult(source, { status: "exported" }, "exports/report.pdf"),
    ).toEqual({ opened: false, artifactPath: "exports/report.pdf" });

    listWorkspaceArtifacts.mockImplementationOnce(async () => {
      throw new Error("temporarily unavailable");
    });
    expect(
      await openExportedResult(source, { status: "exported" }, "exports/report.pdf"),
    ).toEqual({ opened: false, artifactPath: "exports/report.pdf" });
    expect(open).not.toHaveBeenCalled();
  });

  test("keeps a persisted export successful when no reader dispatcher is mounted", async () => {
    listWorkspaceArtifacts.mockImplementation(async () => ({
      artifacts: [{ id: "internal-row", path: "exports/report.pdf", mimeType: "application/pdf" }],
    }));

    const result = await openExportedResult(
      { kind: "artifact", id: "source-row", path: "source.html", mimeType: "text/html" },
      { status: "exported" },
      "exports/report.pdf",
    );

    expect(result).toEqual({ opened: false, artifactPath: "exports/report.pdf" });
  });

  test("does not dispatch when the owning surface is no longer current", async () => {
    const open = mock(() => {});
    setOpenFileDispatcher(open);
    listWorkspaceArtifacts.mockImplementation(async () => ({
      artifacts: [{ id: "internal-row", path: "exports/report.pdf", mimeType: "application/pdf" }],
    }));

    const result = await openExportedResult(
      { kind: "artifact", id: "source-row", path: "source.html", mimeType: "text/html" },
      { status: "exported" },
      "exports/report.pdf",
      () => false,
    );

    expect(result).toEqual({ opened: false, artifactPath: "exports/report.pdf" });
    expect(open).not.toHaveBeenCalled();
  });
});
