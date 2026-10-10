import { describe, test, expect } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join, normalize } from "node:path";
import { checkPathAccess, _buildResolvedDenyForTests } from "../../src/path-deny";

describe("checkPathAccess", () => {
  test("allows normal files at standard level", () => {
    expect(checkPathAccess("/tmp/test.txt", "standard").allowed).toBe(true);
    expect(checkPathAccess("/home/user/project/file.ts", "standard").allowed).toBe(true);
    expect(checkPathAccess("./relative/path.md", "standard").allowed).toBe(true);
  });

  test("allows everything at yolo level", () => {
    expect(checkPathAccess("/etc/passwd", "yolo").allowed).toBe(true);
    expect(checkPathAccess("~/.ssh/id_rsa", "yolo").allowed).toBe(true);
  });

  test("blocks /etc/passwd", () => {
    const result = checkPathAccess("/etc/passwd", "standard");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain(normalize("/etc/passwd"));
  });

  test("blocks /etc/shadow", () => {
    expect(checkPathAccess("/etc/shadow", "standard").allowed).toBe(false);
  });

  test("blocks /etc/sudoers", () => {
    expect(checkPathAccess("/etc/sudoers", "standard").allowed).toBe(false);
  });

  test("blocks /etc/ssh subdirectories", () => {
    expect(checkPathAccess("/etc/ssh/sshd_config", "standard").allowed).toBe(false);
  });

  test("blocks /proc", () => {
    expect(checkPathAccess("/proc/1/cmdline", "standard").allowed).toBe(false);
  });

  test("blocks /dev", () => {
    expect(checkPathAccess("/dev/sda", "standard").allowed).toBe(false);
  });

  test("blocks ~/.ssh", () => {
    expect(checkPathAccess("~/.ssh/id_rsa", "permissive").allowed).toBe(false);
  });

  test("blocks ~/.gnupg", () => {
    expect(checkPathAccess("~/.gnupg/private-keys-v1.d/key.key", "standard").allowed).toBe(false);
  });

  test("blocks ~/.aws", () => {
    expect(checkPathAccess("~/.aws/credentials", "standard").allowed).toBe(false);
  });

  test("blocks ~/.kube", () => {
    expect(checkPathAccess("~/.kube/config", "standard").allowed).toBe(false);
  });

  test("does NOT block normal home directory files", () => {
    expect(checkPathAccess("~/Documents/file.txt", "standard").allowed).toBe(true);
    expect(checkPathAccess("~/project/src/index.ts", "standard").allowed).toBe(true);
  });

  test("blocks path deny even at permissive level", () => {
    expect(checkPathAccess("/etc/passwd", "permissive").allowed).toBe(false);
  });

  // -----------------------------------------------------------------
  // D063 PR-001 M-2 — macOS paths are platform-gated
  // -----------------------------------------------------------------

  test("M-2: Linux platform does NOT include macOS Library/* entries", () => {
    const linuxDeny = _buildResolvedDenyForTests("linux");
    const home = homedir();
    // None of the DARWIN_HOME_RELATIVE_DENY entries should be present.
    expect(linuxDeny.some((p) => p.includes(join(home, "Library/Keychains")))).toBe(false);
    expect(linuxDeny.some((p) => p.includes(join(home, "Library/Cookies")))).toBe(false);
    expect(linuxDeny.some((p) => p.includes(join(home, "Library/Safari")))).toBe(false);
  });

  test("M-2: Darwin platform INCLUDES macOS Library/* entries", () => {
    const darwinDeny = _buildResolvedDenyForTests("darwin");
    const home = homedir();
    expect(darwinDeny.some((p) => p.endsWith(normalize("/Library/Keychains")))).toBe(true);
    expect(darwinDeny.some((p) => p.endsWith(normalize("/Library/Cookies")))).toBe(true);
    expect(darwinDeny.some((p) => p.endsWith(normalize("/Library/Safari")))).toBe(true);
    expect(darwinDeny.some((p) => p.includes(join(home, "Library/Application Support/Google/Chrome")))).toBe(true);
  });

  test("M-2: ABSOLUTE_DENY entries are platform-agnostic", () => {
    const linuxDeny = _buildResolvedDenyForTests("linux");
    const darwinDeny = _buildResolvedDenyForTests("darwin");
    // /etc/passwd et al. appear on both platforms.
    expect(linuxDeny.some((p) => p.endsWith(normalize("/etc/passwd")))).toBe(true);
    expect(darwinDeny.some((p) => p.endsWith(normalize("/etc/passwd")))).toBe(true);
  });

  // -----------------------------------------------------------------
  // G7 / FILE-02 — ancestor-of-deny block (exfil vector)
  //
  // Walking from `/` (or any ancestor of a deny entry) into a
  // recursive command like `grep` would scan /etc/passwd, ~/.ssh,
  // etc. before per-entry filtering caught it. checkPathAccess now
  // blocks at the gate so the FILE-02 smoke row hits
  // validate-before-execution rather than the handler.
  // -----------------------------------------------------------------

  test("G7/FILE-02: blocks `/` (root is ancestor of every absolute deny entry)", () => {
    const r = checkPathAccess("/", "standard");
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("protected path");
    expect(r.reason).toContain("ancestor");
  });

  test("G7/FILE-02: blocks `/etc` (ancestor of /etc/passwd, /etc/shadow, ...)", () => {
    const r = checkPathAccess("/etc", "standard");
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("protected path");
  });

  test("G7/FILE-02: blocks home dir as ancestor of ~/.ssh, ~/.aws, ...", () => {
    // Use ~ which expands to homedir — same path the deny list
    // resolves home-relative entries against, guaranteeing match.
    const r = checkPathAccess("~", "standard");
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("protected path");
  });

  test("G7/FILE-02: legit single-file path with no protected descendants is still allowed", () => {
    // Sibling to ~/.ssh but not an ancestor of anything in the deny
    // list. Regression-locks against an over-aggressive ancestor
    // check that would block normal workspace ops.
    expect(checkPathAccess("~/Documents/notes.md", "standard").allowed).toBe(true);
    expect(checkPathAccess("/tmp/scratch.txt", "standard").allowed).toBe(true);
  });

  test("G7/FILE-02: ancestor check works regardless of trailing slash", () => {
    expect(checkPathAccess("/etc/", "standard").allowed).toBe(false);
    expect(checkPathAccess("/etc", "standard").allowed).toBe(false);
  });

  test("native paths protect descendants without blocking a similarly named sibling", () => {
    expect(checkPathAccess(join(homedir(), ".ssh", "nested", "key"), "standard").allowed).toBe(false);
    expect(checkPathAccess(join(homedir(), ".ssh-backup-not-protected", "readme"), "standard").allowed).toBe(true);
  });

  test("a missing descendant below a directory alias still resolves to the protected home", () => {
    const temporary = mkdtempSync(join(tmpdir(), "path-deny-alias-"));
    const alias = join(temporary, "home");
    try {
      symlinkSync(homedir(), alias, process.platform === "win32" ? "junction" : "dir");
      expect(checkPathAccess(join(alias, ".ssh", "nautilo-missing-test-child", "key"), "standard").allowed).toBe(false);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform !== "win32")("Windows protected paths remain protected with different case and separators", () => {
    const native = join(homedir(), ".ssh", "nested", "key");
    expect(checkPathAccess(native.toUpperCase(), "standard").allowed).toBe(false);
    expect(checkPathAccess(native.replaceAll("\\", "/"), "standard").allowed).toBe(false);
    expect(checkPathAccess("~\\.ssh\\nested\\key", "standard").allowed).toBe(false);
  });
});
