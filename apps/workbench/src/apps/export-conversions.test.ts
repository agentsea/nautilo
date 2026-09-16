import { describe, expect, test } from "bun:test";
import type { MiniAppConversionExportDto } from "@nautilo/api-client/browser";
import { buildExportRequest, replaceExtension } from "./export-conversions";

const docxAction: MiniAppConversionExportDto = {
  id: "export-docx",
  label: "Microsoft Word",
  to: {
    extension: ".docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  tool: "office-export",
  targetSurfaces: ["workspace", "currentFolder"],
};

describe("export conversions", () => {
  test("replaceExtension swaps the final extension and handles extensionless names", () => {
    expect(replaceExtension("docs/report.writer.json", ".docx")).toBe("docs/report.writer.docx");
    expect(replaceExtension("docs/README", ".pdf")).toBe("docs/README.pdf");
    expect(replaceExtension(".env", ".txt")).toBe(".env.txt");
    expect(replaceExtension("C:\\work\\notes.md", ".pdf")).toBe("C:\\work\\notes.pdf");
  });

  test("buildExportRequest targets the same workspace directory for artifacts", () => {
    expect(
      buildExportRequest(
        {
          kind: "artifact",
          id: "artifact-1",
          path: "docs/report.writer.json",
          mimeType: "application/vnd.nautilo.writer+json",
          roomId: "33333333-3333-4333-8333-333333333333",
        },
        docxAction,
      ),
    ).toEqual({
      actionId: "export-docx",
      direction: "export",
      source: { surface: "workspace", path: "docs/report.writer.json" },
      target: { surface: "workspace", path: "docs/report.writer.docx" },
      roomId: "33333333-3333-4333-8333-333333333333",
    });
  });

  test("buildExportRequest targets the same current-folder directory for fs files", () => {
    expect(
      buildExportRequest(
        {
          kind: "fs",
          rootPath: "/Users/me/project",
          path: "/Users/me/project/docs/report.writer.json",
        },
        docxAction,
      ),
    ).toEqual({
      actionId: "export-docx",
      direction: "export",
      source: { surface: "currentFolder", path: "docs/report.writer.json" },
      target: { surface: "currentFolder", path: "docs/report.writer.docx" },
      currentFolder: "/Users/me/project",
    });
  });

  test("workspace destination exports start in the current workspace with a basename target", () => {
    expect(buildExportRequest(
      {
        kind: "artifact", id: "artifact-1", path: "imports/deck.presentation.html",
        mimeType: "text/html", roomId: "33333333-3333-4333-8333-333333333333",
      },
      { ...docxAction, selectWorkspaceDestination: true },
    )).toMatchObject({
      source: { surface: "workspace", path: "imports/deck.presentation.html" },
      target: { surface: "workspace", path: "deck.presentation.docx" },
      workspaceDestination: "current",
      roomId: "33333333-3333-4333-8333-333333333333",
    });
  });

  test("carries an explicit trusted Design export scope without changing host-derived locations", () => {
    expect(
      buildExportRequest(
        {
          kind: "artifact",
          id: "artifact-1",
          path: "designs/Hero.design.html",
          mimeType: "text/html",
          roomId: "33333333-3333-4333-8333-333333333333",
        },
        {
          id: "export-svg",
          label: "SVG",
          to: { extension: ".svg", mimeType: "image/svg+xml" },
          tool: "export-svg",
          targetSurfaces: ["workspace"],
        },
        { pageHandle: "page:page-2", nodeHandles: ["node:node-7"] },
      ),
    ).toEqual({
      actionId: "export-svg",
      direction: "export",
      source: { surface: "workspace", path: "designs/Hero.design.html" },
      target: { surface: "workspace", path: "designs/Hero.design.svg" },
      roomId: "33333333-3333-4333-8333-333333333333",
      scope: { pageHandle: "page:page-2", nodeHandles: ["node:node-7"] },
    });
  });
});
