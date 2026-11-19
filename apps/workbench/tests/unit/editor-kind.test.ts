import { describe, expect, test } from "bun:test";
import {
  artifactOpenFileTarget,
  fsOpenFileTarget,
} from "../../src/components/browser-column/open-file-target";
import {
  canEditInThisChannel,
  editorKindForFile,
  isHtmlTextCandidate,
} from "../../src/editors/editor-kind";

describe("editorKindForFile", () => {
  test("markdown fs path -> markdown", () => {
    expect(
      editorKindForFile(fsOpenFileTarget("/repo/README.md", "/repo")),
    ).toBe("markdown");
  });

  test("code kinds: html/json/yaml/xml/plaintext", () => {
    expect(
      editorKindForFile(fsOpenFileTarget("/repo/index.html", "/repo")),
    ).toBe("code");
    expect(
      editorKindForFile(fsOpenFileTarget("/repo/config.json", "/repo")),
    ).toBe("code");
    expect(
      editorKindForFile(fsOpenFileTarget("/repo/config.yaml", "/repo")),
    ).toBe("code");
    expect(
      editorKindForFile(fsOpenFileTarget("/repo/data.xml", "/repo")),
    ).toBe("code");
    expect(
      editorKindForFile(fsOpenFileTarget("/repo/notes.txt", "/repo")),
    ).toBe("code");
    expect(
      editorKindForFile(
        artifactOpenFileTarget({
          id: "a1",
          path: "app.ts",
          mimeType: "text/plain",
        }),
      ),
    ).toBe("code");
    expect(
      editorKindForFile(
        artifactOpenFileTarget({
          id: "a2",
          path: "data.json",
          mimeType: "application/json",
        }),
      ),
    ).toBe("code");
  });

  test("unsupported binary kinds -> null", () => {
    expect(
      editorKindForFile(fsOpenFileTarget("/repo/logo.png", "/repo")),
    ).toBeNull();
    expect(
      editorKindForFile(fsOpenFileTarget("/repo/doc.pdf", "/repo")),
    ).toBeNull();
    expect(
      editorKindForFile(fsOpenFileTarget("/repo/report.docx", "/repo")),
    ).toBeNull();
    expect(
      editorKindForFile(fsOpenFileTarget("/repo/sheet.xlsx", "/repo")),
    ).toBeNull();
    expect(
      editorKindForFile(
        artifactOpenFileTarget({
          id: "img",
          path: "photo.jpg",
          mimeType: "image/jpeg",
        }),
      ),
    ).toBeNull();
  });
});

describe("canEditInThisChannel", () => {
  const artifact = artifactOpenFileTarget({
    id: "art",
    path: "notes.md",
    mimeType: "text/markdown",
  });
  const fsFile = fsOpenFileTarget("/repo/notes.md", "/repo");

  test("artifact editable in browser", () => {
    expect(canEditInThisChannel(artifact, false)).toBe(true);
  });

  test("fs hidden in browser", () => {
    expect(canEditInThisChannel(fsFile, false)).toBe(false);
  });

  test("fs editable on desktop", () => {
    expect(canEditInThisChannel(fsFile, true)).toBe(true);
  });
});


describe("HTML text presentation eligibility", () => {
  test("offers ordinary HTML by path or MIME while keeping its code persistence kind", () => {
    for (const file of [fsOpenFileTarget("/repo/page.html", "/repo"),
      artifactOpenFileTarget({ id: "a", path: "page", mimeType: "text/html" }),
      artifactOpenFileTarget({ id: "b", path: "page.xhtml", mimeType: "application/xhtml+xml" })]) {
      expect(isHtmlTextCandidate(file, "<p>Editable text</p>")).toBe(true);
      expect(editorKindForFile(file)).toBe("code");
    }
    expect(isHtmlTextCandidate(fsOpenFileTarget("/repo/code.ts", "/repo"), "const n = 1")).toBe(false);
  });

  test("native document manifests remain outside generic friendly HTML editing regardless of filename", () => {
    const file = artifactOpenFileTarget({ id: "native", path: "ordinary-name.html", mimeType: "text/html" });
    for (const type of ["document", "spreadsheet", "presentation", "kanban"]) {
      const content = `<script type="application/vnd.nautilo.document+json" id="manifest">${JSON.stringify({ documentType: type, version: "1.0" })}</script><p>Preview</p>`;
      expect(isHtmlTextCandidate(file, content)).toBe(false);
    }
  });
});
