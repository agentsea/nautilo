import { describe, expect, test } from "bun:test";
import {
  artifactOpenFileTarget,
  fsOpenFileTarget,
} from "../../src/components/browser-column/open-file-target";
import {
  canEditInThisChannel,
  editorKindForFile,
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
