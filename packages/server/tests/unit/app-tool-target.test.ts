import { describe, expect, test } from "bun:test";
import { TEST_MINI_APP_MANIFEST } from "../helpers/test-mini-app-manifest";
import {
  accessAllowsRead,
  accessAllowsWrite,
  appStateStorageKey,
  validateAppDocumentTarget,
  validateBasenameFilename,
  validateCurrentFolderRelativePath,
  validateStateKey,
  validateWorkspaceLogicalPath,
} from "../../src/apps/app-tool-target";

describe("app-tool target validation", () => {
  test("validateBasenameFilename rejects traversal and separators", () => {
    expect(validateBasenameFilename("notes.html").ok).toBe(true);
    expect(validateBasenameFilename("../x").ok).toBe(false);
    expect(validateBasenameFilename("a/b").ok).toBe(false);
    expect(validateBasenameFilename("").ok).toBe(false);
  });

  test("validateWorkspaceLogicalPath rejects absolute and .. segments", () => {
    expect(validateWorkspaceLogicalPath("drafts/q3.html").ok).toBe(true);
    expect(validateWorkspaceLogicalPath("/etc/passwd").ok).toBe(false);
    expect(validateWorkspaceLogicalPath("a/../b").ok).toBe(false);
  });

  test("validateCurrentFolderRelativePath rejects absolute paths", () => {
    expect(validateCurrentFolderRelativePath("sheet.html").ok).toBe(true);
    expect(validateCurrentFolderRelativePath("/tmp/x").ok).toBe(false);
  });

  test("validateAppDocumentTarget accepts workspace and currentFolder shapes", () => {
    expect(validateAppDocumentTarget({ surface: "workspace", path: "a.html" }).ok).toBe(true);
    expect(
      validateAppDocumentTarget({ surface: "currentFolder", relativePath: "a.html" }).ok,
    ).toBe(true);
    expect(validateAppDocumentTarget({ surface: "workspace", path: "../x" }).ok).toBe(false);
  });

  test("validateStateKey enforces length and colon ban", () => {
    expect(validateStateKey("view").ok).toBe(true);
    expect(validateStateKey("bad:key").ok).toBe(false);
    expect(validateStateKey("x".repeat(129)).ok).toBe(false);
  });

  test("appStateStorageKey prefixes app id", () => {
    expect(appStateStorageKey("test-canvas", "view")).toBe("app:test-canvas:view");
  });
});

describe("manifest capability helpers", () => {
  test("test-canvas manifest allows read/write where declared", () => {
    expect(accessAllowsRead(TEST_MINI_APP_MANIFEST.capabilities.document?.artifact)).toBe(true);
    expect(accessAllowsWrite(TEST_MINI_APP_MANIFEST.capabilities.document?.artifact)).toBe(true);
    expect(accessAllowsRead(TEST_MINI_APP_MANIFEST.capabilities.document?.currentFolder)).toBe(true);
    expect(accessAllowsWrite(TEST_MINI_APP_MANIFEST.capabilities.state)).toBe(true);
  });

  test("none/omitted access levels deny operations", () => {
    expect(accessAllowsRead("none")).toBe(false);
    expect(accessAllowsWrite("read")).toBe(false);
    expect(accessAllowsWrite(undefined)).toBe(false);
  });
});
