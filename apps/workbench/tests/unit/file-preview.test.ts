import { describe, expect, test } from "bun:test";
import { previewKindForPath } from "../../src/lib/file-preview";
import { readerShikiLanguageIds } from "../../src/lib/shiki-reader";

describe("previewKindForPath", () => {
  test("recognizes exact dotfile names", () => {
    expect(previewKindForPath("/repo/.gitignore")).toEqual({
      kind: "text",
      language: null,
    });
    expect(previewKindForPath("/repo/.npmrc")).toEqual({
      kind: "text",
      language: null,
    });
    expect(previewKindForPath("/repo/.editorconfig")).toEqual({
      kind: "text",
      language: null,
    });
  });

  test("recognizes env filename family", () => {
    for (const name of [".env", ".env.example", ".env.local", ".env.production"]) {
      expect(previewKindForPath(`/repo/${name}`)).toEqual({
        kind: "text",
        language: null,
      });
    }
  });

  test("recognizes extensionless common text files", () => {
    expect(previewKindForPath("/repo/Dockerfile")).toEqual({
      kind: "text",
      language: null,
    });
    expect(previewKindForPath("/repo/Makefile")).toEqual({
      kind: "text",
      language: null,
    });
    expect(previewKindForPath("/repo/LICENSE")).toEqual({
      kind: "text",
      language: null,
    });
  });

  test("recognizes markdown and regular code extensions", () => {
    expect(previewKindForPath("/repo/README.md")).toEqual({
      kind: "markdown",
      language: "markdown",
    });
    expect(previewKindForPath("/repo/app.tsx")).toEqual({
      kind: "text",
      language: "tsx",
    });
    expect(previewKindForPath("/repo/config.json")).toEqual({
      kind: "text",
      language: "json",
    });
  });

  test("returns unsupported for unknown binary-ish extensions", () => {
    expect(previewKindForPath("/repo/archive.zip")).toEqual({
      kind: "unsupported",
      ext: ".zip",
    });
  });

  test("every emitted preview language is bundled by the reader highlighter", () => {
    const paths = [
      "/repo/app.ts",
      "/repo/app.tsx",
      "/repo/app.js",
      "/repo/app.jsx",
      "/repo/app.mjs",
      "/repo/app.cjs",
      "/repo/app.py",
      "/repo/app.rs",
      "/repo/app.go",
      "/repo/app.rb",
      "/repo/config.json",
      "/repo/config.yaml",
      "/repo/config.yml",
      "/repo/config.toml",
      "/repo/README.md",
      "/repo/index.html",
      "/repo/styles.css",
      "/repo/styles.scss",
      "/repo/script.sh",
      "/repo/script.bash",
      "/repo/layout.xml",
      "/repo/.env.local",
      "/repo/Dockerfile",
      "/repo/Makefile",
    ];

    for (const path of paths) {
      const kind = previewKindForPath(path);
      if (kind.kind === "unsupported" || kind.language === null) continue;
      expect(readerShikiLanguageIds.has(kind.language), path).toBe(true);
    }
  });
});
