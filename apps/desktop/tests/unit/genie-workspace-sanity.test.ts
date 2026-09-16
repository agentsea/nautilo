/**
 * D079 Phase 3 — `checkGenieWorkspaceSanity` unit tests.
 *
 * Workspace policy is LOOSER than current-folder policy: `~/Documents/*`
 * passes here (it's the default Workspace location) but is explicitly
 * allowed by the spec. Current-folder has the same `~/Documents/*`
 * allowance in practice, so the divergence point is narrow. Both
 * policies are tested in parallel so drift is caught immediately.
 *
 * The whole reason for two separate functions: avoid accidentally
 * relaxing current-folder by editing the wrong helper. Tests pin both.
 */

import { describe, test, expect } from "bun:test";
import {
  checkGenieWorkspaceSanity,
  checkCurrentFolderSanity,
} from "../../electron/workspace-sanity";

const HOME = "/Users/tester";

describe("checkGenieWorkspaceSanity — null / empty / malformed", () => {
  test("null → not ok", () => {
    expect(checkGenieWorkspaceSanity(null, HOME).ok).toBe(false);
  });
  test("undefined → not ok", () => {
    expect(checkGenieWorkspaceSanity(undefined, HOME).ok).toBe(false);
  });
  test("empty string → not ok", () => {
    expect(checkGenieWorkspaceSanity("", HOME).ok).toBe(false);
  });
  test("raw ~ marker → not ok", () => {
    expect(checkGenieWorkspaceSanity("~", HOME).ok).toBe(false);
    expect(checkGenieWorkspaceSanity("~/", HOME).ok).toBe(false);
  });
});

describe("checkGenieWorkspaceSanity — relative paths rejected", () => {
  test("relative path → not ok", () => {
    const r = checkGenieWorkspaceSanity("Documents/Nautilo", HOME);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/absolute/);
  });
});

describe("checkGenieWorkspaceSanity — the default location is allowed", () => {
  test("~/Documents/Nautilo absolute → OK", () => {
    expect(checkGenieWorkspaceSanity("/Users/john-user/Documents/Nautilo", HOME).ok).toBe(true);
  });
  test("any subfolder of home outside system roots → OK", () => {
    expect(checkGenieWorkspaceSanity("/Users/john-user/Code/nautilo-space", HOME).ok).toBe(true);
    expect(checkGenieWorkspaceSanity("/Users/john-user/Desktop/genie-stuff", HOME).ok).toBe(true);
  });
});

describe("checkGenieWorkspaceSanity — home-dir itself rejected", () => {
  test("exact home → not ok", () => {
    const r = checkGenieWorkspaceSanity(HOME, HOME);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/pick a subfolder/);
  });
});

describe("checkGenieWorkspaceSanity — system paths rejected", () => {
  const systemRoots = [
    "/",
    "/tmp",
    "/private/tmp",
    "/private/var",
    "/var",
    "/etc",
    "/usr",
    "/bin",
    "/sbin",
    "/System",
    "/Library",
  ];
  for (const root of systemRoots) {
    test(`${root} → not ok`, () => {
      expect(checkGenieWorkspaceSanity(root, HOME).ok).toBe(false);
    });
  }
});

describe("checkGenieWorkspaceSanity — Windows system paths rejected", () => {
  test("C:/Windows → not ok", () => {
    expect(checkGenieWorkspaceSanity("C:/Windows", HOME).ok).toBe(false);
  });
  test("C:\\Program Files → not ok", () => {
    expect(checkGenieWorkspaceSanity("C:\\Program Files", HOME).ok).toBe(false);
  });
  test("C:/Users → not ok (this is Windows sys path; individual user folders would be sub-paths)", () => {
    expect(checkGenieWorkspaceSanity("C:/Users", HOME).ok).toBe(false);
  });
});

describe("drift regression — both policies agree on critical rejections", () => {
  // These MUST both reject regardless of which function is called.
  // If this test fails, someone edited one function without the other
  // and the policies have silently diverged.
  const mustReject = ["/", "/tmp", "/etc", "/System", "/Library", "/"];
  for (const p of mustReject) {
    test(`both reject ${p}`, () => {
      expect(checkGenieWorkspaceSanity(p, HOME).ok).toBe(false);
      expect(checkCurrentFolderSanity(p, HOME).ok).toBe(false);
    });
  }
  test("both reject exact home", () => {
    expect(checkGenieWorkspaceSanity(HOME, HOME).ok).toBe(false);
    expect(checkCurrentFolderSanity(HOME, HOME).ok).toBe(false);
  });
});

describe("drift regression — both policies agree on critical acceptances", () => {
  // The spec-ed ONE place both should accept: ~/Documents/Nautilo
  // subfolders. If this test fails, someone restricted one of the two
  // policies in a way that breaks the other's assumptions.
  test("both accept a user's Documents subfolder", () => {
    expect(checkGenieWorkspaceSanity("/Users/john-user/Documents/Nautilo", HOME).ok).toBe(true);
    expect(checkCurrentFolderSanity("/Users/john-user/Documents/Nautilo", HOME).ok).toBe(true);
  });
});
