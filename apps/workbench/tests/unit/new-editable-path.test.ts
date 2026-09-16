import { describe, expect, test } from "bun:test";
import {
  buildNewEditablePath,
  inferEditableMimeType,
} from "../../src/editors/new-editable-path";

describe("buildNewEditablePath", () => {
  test("joins parent and name", () => {
    expect(
      buildNewEditablePath({
        parentPath: "/repo/src",
        name: "notes.md",
        existingNames: [],
      }),
    ).toEqual({ ok: true, path: "/repo/src/notes.md" });
  });

  test("rejects empty name", () => {
    expect(
      buildNewEditablePath({
        parentPath: "/repo",
        name: "   ",
        existingNames: [],
      }),
    ).toEqual({ ok: false, reason: "File name is required." });
  });

  test("rejects absolute file name", () => {
    expect(
      buildNewEditablePath({
        parentPath: "/repo",
        name: "/etc/passwd",
        existingNames: [],
      }),
    ).toEqual({ ok: false, reason: "File name must not be an absolute path." });
  });

  test("rejects slash escape and dot segments", () => {
    expect(
      buildNewEditablePath({
        parentPath: "/repo",
        name: "../secret.txt",
        existingNames: [],
      }),
    ).toEqual({
      ok: false,
      reason: "File name must not contain path separators.",
    });
    expect(
      buildNewEditablePath({
        parentPath: "/repo",
        name: "..",
        existingNames: [],
      }),
    ).toEqual({ ok: false, reason: "File name is not allowed." });
  });

  test("rejects binary extensions", () => {
    expect(
      buildNewEditablePath({
        parentPath: "/repo",
        name: "photo.png",
        existingNames: [],
      }),
    ).toEqual({ ok: false, reason: "That file type cannot be edited." });
  });

  test("rejects case-insensitive collisions", () => {
    expect(
      buildNewEditablePath({
        parentPath: "/repo",
        name: "Notes.md",
        existingNames: ["notes.md"],
      }),
    ).toEqual({
      ok: false,
      reason: "A file with that name already exists.",
    });
  });

  test("allows workspace root with empty parent", () => {
    expect(
      buildNewEditablePath({
        parentPath: "",
        name: "notes.md",
        existingNames: [],
      }),
    ).toEqual({ ok: true, path: "notes.md" });
  });
});

describe("inferEditableMimeType", () => {
  test("maps common editable extensions", () => {
    expect(inferEditableMimeType("/repo/readme.md")).toBe("text/markdown");
    expect(inferEditableMimeType("/repo/page.html")).toBe("text/html");
    expect(inferEditableMimeType("/repo/data.json")).toBe("application/json");
    expect(inferEditableMimeType("/repo/config.yaml")).toBe("application/yaml");
    expect(inferEditableMimeType("/repo/schema.xml")).toBe("application/xml");
    expect(inferEditableMimeType("/repo/style.css")).toBe("text/css");
    expect(inferEditableMimeType("/repo/app.ts")).toBe("text/plain");
    expect(inferEditableMimeType("/repo/script.sh")).toBe("text/plain");
  });
});
