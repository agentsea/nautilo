import { describe, expect, test } from "bun:test";

import { languageExtensionsForPath } from "../../src/editors/code-editor";

describe("languageExtensionsForPath", () => {
  test("returns language extensions for common code paths", () => {
    expect(languageExtensionsForPath("src/app.ts").length).toBeGreaterThan(0);
    expect(languageExtensionsForPath("index.html").length).toBeGreaterThan(0);
    expect(languageExtensionsForPath("data.json").length).toBeGreaterThan(0);
    expect(languageExtensionsForPath("config.yaml").length).toBeGreaterThan(0);
    expect(languageExtensionsForPath("schema.xml").length).toBeGreaterThan(0);
    expect(languageExtensionsForPath("README.md").length).toBeGreaterThan(0);
  });

  test("returns empty extensions for plaintext and shell paths", () => {
    expect(languageExtensionsForPath("notes.txt")).toEqual([]);
    expect(languageExtensionsForPath("run.sh")).toEqual([]);
    expect(languageExtensionsForPath("script.bash")).toEqual([]);
    expect(languageExtensionsForPath("readme.plaintext")).toEqual([]);
  });

  test("returns empty extensions for unknown extensions", () => {
    expect(languageExtensionsForPath("archive.bin")).toEqual([]);
    expect(languageExtensionsForPath("no-extension")).toEqual([]);
  });
});
