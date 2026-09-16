/**
 * Unit tests for the current-folder sanity predicate (D075; renamed by
 * D079 Phase 1).
 *
 * Matrix covers POSIX + Windows absolute paths, home-dir exact match,
 * known system roots, relative paths, empty / null inputs. Mirrors the
 * cited-paths.test.ts pattern in apps/workbench — pure module tests
 * with no Electron runtime.
 */

import { describe, test, expect } from "bun:test";
import { checkCurrentFolderSanity } from "../../electron/workspace-sanity";

const HOME = "/Users/tester";

describe("checkCurrentFolderSanity — null / empty / malformed", () => {
  test("null → not ok", () => {
    const r = checkCurrentFolderSanity(null, HOME);
    expect(r.ok).toBe(false);
  });

  test("undefined → not ok", () => {
    const r = checkCurrentFolderSanity(undefined, HOME);
    expect(r.ok).toBe(false);
  });

  test("empty string → not ok", () => {
    const r = checkCurrentFolderSanity("", HOME);
    expect(r.ok).toBe(false);
  });

  test("whitespace → not ok", () => {
    const r = checkCurrentFolderSanity("   ", HOME);
    expect(r.ok).toBe(false);
  });

  test("raw ~ marker → not ok", () => {
    const r = checkCurrentFolderSanity("~", HOME);
    expect(r.ok).toBe(false);
  });

  test("~/ → not ok", () => {
    const r = checkCurrentFolderSanity("~/", HOME);
    expect(r.ok).toBe(false);
  });

  test("relative path → not ok (workspaces must be absolute)", () => {
    expect(checkCurrentFolderSanity("./projects", HOME).ok).toBe(false);
    expect(checkCurrentFolderSanity("../projects", HOME).ok).toBe(false);
    expect(checkCurrentFolderSanity("projects", HOME).ok).toBe(false);
  });
});

describe("checkCurrentFolderSanity — system roots (POSIX)", () => {
  test.each([
    "/",
    "/tmp",
    "/private/tmp",
    "/private/var",
    "/var",
    "/usr",
    "/etc",
    "/opt",
    "/bin",
    "/sbin",
    "/dev",
    "/System",
    "/Library",
    "/Applications",
    "/Volumes",
  ])("rejects %s", (path) => {
    const r = checkCurrentFolderSanity(path, HOME);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("system path");
  });

  test("rejects /tmp with trailing slash", () => {
    expect(checkCurrentFolderSanity("/tmp/", HOME).ok).toBe(false);
  });

  test("accepts a subdirectory of a system root (e.g. /tmp/nautilo-workspace)", () => {
    // If the user genuinely creates /tmp/nautilo-workspace, that's
    // their choice. We reject the roots themselves, not children.
    // This keeps the gate conservative — it only fires on paths that
    // are statically clearly wrong, not on any subdirectory.
    expect(checkCurrentFolderSanity("/tmp/nautilo-workspace", HOME).ok).toBe(true);
  });
});

describe("checkCurrentFolderSanity — home directory", () => {
  test("rejects exact home directory match", () => {
    const r = checkCurrentFolderSanity(HOME, HOME);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("home directory");
  });

  test("rejects home directory with trailing slash", () => {
    expect(checkCurrentFolderSanity(`${HOME}/`, HOME).ok).toBe(false);
  });

  test("accepts a subdirectory of home", () => {
    expect(
      checkCurrentFolderSanity(`${HOME}/Documents/Nautilo`, HOME).ok,
    ).toBe(true);
    expect(
      checkCurrentFolderSanity(`${HOME}/projects/nautilo`, HOME).ok,
    ).toBe(true);
  });

  test("accepts a sibling of home (like /Users/another-user) — their choice", () => {
    expect(checkCurrentFolderSanity("/Users/another-user", HOME).ok).toBe(true);
  });
});

describe("checkCurrentFolderSanity — system roots (Windows)", () => {
  test.each([
    "C:",
    "C:\\",
    "c:\\",
    "C:\\Windows",
    "C:\\Program Files",
    "C:\\Program Files (x86)",
    "C:\\ProgramData",
    "C:\\Users",
  ])("rejects %s", (path) => {
    expect(checkCurrentFolderSanity(path, HOME).ok).toBe(false);
  });

  test("accepts a real Windows workspace path", () => {
    expect(checkCurrentFolderSanity("C:\\Users\\writer\\projects\\nautilo", HOME).ok).toBe(true);
  });
});

describe("checkCurrentFolderSanity — valid paths", () => {
  test.each([
    "/Users/john-user/projects/nautilo",
    "/Users/john-user/Documents/work",
    "/home/user/code",
    "/mnt/storage/projects",
  ])("accepts %s", (path) => {
    expect(checkCurrentFolderSanity(path, HOME).ok).toBe(true);
  });
});
