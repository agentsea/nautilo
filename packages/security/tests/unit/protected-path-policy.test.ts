import { describe, test, expect } from "bun:test";
import * as nodePath from "node:path";
import {
  buildProtectedPathDescriptors,
  buildProtectedPathPolicy,
  matchProtectedPath,
  isPathProtected,
  PROTECTED_PATH_POLICY_SCHEMA_VERSION,
  ProtectedPathPolicyError,
  type ProtectedPathDescriptor,
  type ProtectedPathCheckResult,
} from "../../src/protected-path-policy";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const POSIX_HOME = nodePath.posix.join(nodePath.posix.sep, "Users", "alice");
const DARWIN_HOME = POSIX_HOME;
const LINUX_HOME = nodePath.posix.join(nodePath.posix.sep, "home", "alice");
const WIN32_HOME = nodePath.win32.join("C:\\Users", "alice");

function findDescriptor(
  descriptors: readonly ProtectedPathDescriptor[],
  canonicalPath: string,
): ProtectedPathDescriptor | undefined {
  return descriptors.find((d) => d.canonicalPath === canonicalPath);
}

function hasDescriptor(
  descriptors: readonly ProtectedPathDescriptor[],
  canonicalPath: string,
): boolean {
  return findDescriptor(descriptors, canonicalPath) !== undefined;
}

function expectAllowed(result: ProtectedPathCheckResult): void {
  expect(result.allowed).toBe(true);
}

function expectDenied(result: ProtectedPathCheckResult): ProtectedPathCheckResult & {
  allowed: false;
} {
  expect(result.allowed).toBe(false);
  if (result.allowed) throw new Error("expected denied result");
  return result as ProtectedPathCheckResult & { allowed: false };
}

// ---------------------------------------------------------------------------
// Descriptor construction — POSIX (linux)
// ---------------------------------------------------------------------------

describe("buildProtectedPathDescriptors — linux", () => {
  const descriptors = buildProtectedPathDescriptors({
    homeDir: LINUX_HOME,
    platform: "linux",
  });

  test("includes POSIX system-auth absolute roots", () => {
    expect(hasDescriptor(descriptors, "/etc/passwd")).toBe(true);
    expect(hasDescriptor(descriptors, "/etc/shadow")).toBe(true);
    expect(hasDescriptor(descriptors, "/etc/sudoers")).toBe(true);
    expect(hasDescriptor(descriptors, "/etc/ssh")).toBe(true);
    expect(hasDescriptor(descriptors, "/proc")).toBe(true);
    expect(hasDescriptor(descriptors, "/sys")).toBe(true);
    expect(hasDescriptor(descriptors, "/dev")).toBe(true);
    expect(hasDescriptor(descriptors, "/boot")).toBe(true);
  });

  test("includes common home-relative secret stores", () => {
    expect(hasDescriptor(descriptors, `${LINUX_HOME}/.ssh`)).toBe(true);
    expect(hasDescriptor(descriptors, `${LINUX_HOME}/.gnupg`)).toBe(true);
    expect(hasDescriptor(descriptors, `${LINUX_HOME}/.aws`)).toBe(true);
    expect(hasDescriptor(descriptors, `${LINUX_HOME}/.azure`)).toBe(true);
    expect(hasDescriptor(descriptors, `${LINUX_HOME}/.kube`)).toBe(true);
    expect(hasDescriptor(descriptors, `${LINUX_HOME}/.docker`)).toBe(true);
    expect(hasDescriptor(descriptors, `${LINUX_HOME}/.netrc`)).toBe(true);
    expect(hasDescriptor(descriptors, `${LINUX_HOME}/.password-store`)).toBe(true);
  });

  test("includes Linux-only XDG browser/keyring/gcloud roots", () => {
    expect(hasDescriptor(descriptors, `${LINUX_HOME}/.config/gcloud`)).toBe(true);
    expect(hasDescriptor(descriptors, `${LINUX_HOME}/.mozilla/firefox`)).toBe(true);
    expect(hasDescriptor(descriptors, `${LINUX_HOME}/.config/google-chrome`)).toBe(true);
    expect(hasDescriptor(descriptors, `${LINUX_HOME}/.local/share/keyrings`)).toBe(true);
  });

  test("does NOT include macOS Library/* entries", () => {
    expect(hasDescriptor(descriptors, `${LINUX_HOME}/Library/Keychains`)).toBe(false);
    expect(hasDescriptor(descriptors, `${LINUX_HOME}/Library/Cookies`)).toBe(false);
    expect(hasDescriptor(descriptors, `${LINUX_HOME}/Library/Safari`)).toBe(false);
  });

  test("does NOT include Windows roots", () => {
    expect(hasDescriptor(descriptors, "C:\\Windows\\System32\\config")).toBe(false);
    expect(hasDescriptor(descriptors, `${LINUX_HOME}\\AppData\\Roaming\\Microsoft\\Credentials`)).toBe(false);
  });

  test("tags system roots as builtin_system and home roots as builtin_home", () => {
    const etc = findDescriptor(descriptors, "/etc/passwd");
    expect(etc?.origin).toBe("builtin_system");
    expect(etc?.category).toBe("system_auth");

    const ssh = findDescriptor(descriptors, `${LINUX_HOME}/.ssh`);
    expect(ssh?.origin).toBe("builtin_home");
    expect(ssh?.category).toBe("ssh");
  });
});

// ---------------------------------------------------------------------------
// Descriptor construction — darwin
// ---------------------------------------------------------------------------

describe("buildProtectedPathDescriptors — darwin", () => {
  const descriptors = buildProtectedPathDescriptors({
    homeDir: DARWIN_HOME,
    platform: "darwin",
  });

  test("includes POSIX system-auth absolute roots", () => {
    expect(hasDescriptor(descriptors, "/etc/passwd")).toBe(true);
    expect(hasDescriptor(descriptors, "/etc/ssh")).toBe(true);
  });

  test("includes macOS-only Library/* keychain + browser + cookie roots", () => {
    expect(hasDescriptor(descriptors, `${DARWIN_HOME}/Library/Keychains`)).toBe(true);
    expect(hasDescriptor(descriptors, `${DARWIN_HOME}/Library/Cookies`)).toBe(true);
    expect(hasDescriptor(descriptors, `${DARWIN_HOME}/Library/Safari`)).toBe(true);
    expect(
      hasDescriptor(descriptors, `${DARWIN_HOME}/Library/Application Support/Google/Chrome`),
    ).toBe(true);
    expect(
      hasDescriptor(descriptors, `${DARWIN_HOME}/Library/Application Support/Firefox`),
    ).toBe(true);
  });

  test("includes darwin gcloud (XDG-style) root", () => {
    expect(hasDescriptor(descriptors, `${DARWIN_HOME}/.config/gcloud`)).toBe(true);
  });

  test("does NOT include Linux-only XDG roots", () => {
    expect(hasDescriptor(descriptors, `${DARWIN_HOME}/.mozilla/firefox`)).toBe(false);
    expect(hasDescriptor(descriptors, `${DARWIN_HOME}/.local/share/keyrings`)).toBe(false);
  });

  test("tags darwin-only entries with builtin_darwin origin", () => {
    const keychains = findDescriptor(descriptors, `${DARWIN_HOME}/Library/Keychains`);
    expect(keychains?.origin).toBe("builtin_darwin");
    expect(keychains?.category).toBe("macos_keychain");
  });
});

// ---------------------------------------------------------------------------
// Descriptor construction — win32
// ---------------------------------------------------------------------------

describe("buildProtectedPathDescriptors — win32", () => {
  const descriptors = buildProtectedPathDescriptors({
    homeDir: WIN32_HOME,
    platform: "win32",
  });

  test("does NOT include POSIX /etc/* roots", () => {
    expect(hasDescriptor(descriptors, "/etc/passwd")).toBe(false);
    expect(hasDescriptor(descriptors, "/proc")).toBe(false);
  });

  test("includes Windows system config roots", () => {
    expect(hasDescriptor(descriptors, "C:\\Windows\\System32\\config")).toBe(true);
    expect(hasDescriptor(descriptors, "C:\\Windows\\System32\\GroupPolicy")).toBe(true);
    expect(hasDescriptor(descriptors, "C:\\Windows\\System32\\drivers\\etc")).toBe(true);
  });

  test("includes common home-relative secret stores under %USERPROFILE%", () => {
    expect(hasDescriptor(descriptors, `${WIN32_HOME}\\.ssh`)).toBe(true);
    expect(hasDescriptor(descriptors, `${WIN32_HOME}\\.aws`)).toBe(true);
    expect(hasDescriptor(descriptors, `${WIN32_HOME}\\.gnupg`)).toBe(true);
  });

  test("includes Windows-only AppData credential + browser roots", () => {
    expect(hasDescriptor(descriptors, `${WIN32_HOME}\\AppData\\Roaming\\Microsoft\\Credentials`)).toBe(true);
    expect(hasDescriptor(descriptors, `${WIN32_HOME}\\AppData\\Roaming\\Microsoft\\Protect`)).toBe(true);
    expect(hasDescriptor(descriptors, `${WIN32_HOME}\\AppData\\Local\\Google\\Chrome\\User Data`)).toBe(true);
  });

  test("tags win32-only entries with builtin_win32 origin", () => {
    const creds = findDescriptor(descriptors, `${WIN32_HOME}\\AppData\\Roaming\\Microsoft\\Credentials`);
    expect(creds?.origin).toBe("builtin_win32");
  });
});

// ---------------------------------------------------------------------------
// Caller-supplied Nautilo + extra roots
// ---------------------------------------------------------------------------

describe("buildProtectedPathDescriptors — caller roots", () => {
  const privateRoot = nodePath.posix.join(POSIX_HOME, ".nautilo", "private");
  const dataRoot = nodePath.posix.join(POSIX_HOME, ".nautilo", "data");
  const auditRoot = nodePath.posix.join(POSIX_HOME, ".nautilo", "audit");

  const descriptors = buildProtectedPathDescriptors({
    homeDir: POSIX_HOME,
    platform: "linux",
    nautiloRoots: { privateRoot, dataRoot, auditRoot },
    extraRoots: [
      {
        canonicalPath: nodePath.posix.join(POSIX_HOME, "secrets-vault"),
        category: "caller_root",
        label: "operator vault",
      },
    ],
  });

  test("includes the three Nautilo roots with caller-supplied origin", () => {
    const priv = findDescriptor(descriptors, privateRoot);
    expect(priv?.origin).toBe("caller_supplied");
    expect(priv?.category).toBe("nautilo_private");
    const data = findDescriptor(descriptors, dataRoot);
    expect(data?.category).toBe("nautilo_data");
    const audit = findDescriptor(descriptors, auditRoot);
    expect(audit?.category).toBe("nautilo_audit");
  });

  test("includes extra caller roots verbatim", () => {
    const vault = findDescriptor(descriptors, nodePath.posix.join(POSIX_HOME, "secrets-vault"));
    expect(vault?.origin).toBe("caller_supplied");
    expect(vault?.category).toBe("caller_root");
    expect(vault?.label).toBe("operator vault");
  });

  test("dedupes descriptors that collapse to the same canonical path", () => {
    const dupes = buildProtectedPathDescriptors({
      homeDir: POSIX_HOME,
      platform: "linux",
      extraRoots: [
        { canonicalPath: `${POSIX_HOME}/.ssh`, category: "caller_root", label: "dup" },
      ],
    });
    const sshMatches = dupes.filter((d) => d.canonicalPath === `${POSIX_HOME}/.ssh`);
    expect(sshMatches).toHaveLength(1);
    // Builtin wins because it is pushed first; caller dup is dropped.
    expect(sshMatches[0]?.origin).toBe("builtin_home");
  });
});

// ---------------------------------------------------------------------------
// Builder validation — fail loud on bad inputs
// ---------------------------------------------------------------------------

describe("buildProtectedPathDescriptors — validation", () => {
  test("rejects a non-absolute home directory", () => {
    expect(() =>
      buildProtectedPathDescriptors({ homeDir: "relative/home", platform: "linux" }),
    ).toThrow(ProtectedPathPolicyError);
    expect(() =>
      buildProtectedPathDescriptors({ homeDir: "relative/home", platform: "linux" }),
    ).toThrow(/absolute/);
  });

  test("rejects a blank home directory", () => {
    expect(() =>
      buildProtectedPathDescriptors({ homeDir: "   ", platform: "linux" }),
    ).toThrow(ProtectedPathPolicyError);
  });

  test("rejects a home directory containing control bytes", () => {
    expect(() =>
      buildProtectedPathDescriptors({ homeDir: `${POSIX_HOME}\u0000`, platform: "linux" }),
    ).toThrow(ProtectedPathPolicyError);
  });

  test("rejects a non-absolute Nautilo root", () => {
    expect(() =>
      buildProtectedPathDescriptors({
        homeDir: POSIX_HOME,
        platform: "linux",
        nautiloRoots: { privateRoot: "relative/private" },
      }),
    ).toThrow(ProtectedPathPolicyError);
  });

  test("rejects a caller root containing control bytes", () => {
    expect(() =>
      buildProtectedPathDescriptors({
        homeDir: POSIX_HOME,
        platform: "linux",
        extraRoots: [
          { canonicalPath: `${POSIX_HOME}/vault\u0007`, category: "caller_root", label: "x" },
        ],
      }),
    ).toThrow(ProtectedPathPolicyError);
  });

  test("rejects an unknown platform", () => {
    expect(() =>
      buildProtectedPathDescriptors({ homeDir: POSIX_HOME, platform: "plan9" as NodeJS.Platform }),
    ).toThrow(ProtectedPathPolicyError);
  });
});

// ---------------------------------------------------------------------------
// Canonicalization + determinism
// ---------------------------------------------------------------------------

describe("buildProtectedPathDescriptors — canonicalization", () => {
  test("normalizes a home dir with trailing slash + .. segments", () => {
    const a = buildProtectedPathDescriptors({
      homeDir: `${POSIX_HOME}/foo/../`,
      platform: "linux",
    });
    const b = buildProtectedPathDescriptors({
      homeDir: POSIX_HOME,
      platform: "linux",
    });
    expect(a.map((d) => d.canonicalPath)).toEqual(b.map((d) => d.canonicalPath));
  });

  test("is deterministic: identical inputs yield identical descriptors", () => {
    const a = buildProtectedPathDescriptors({
      homeDir: POSIX_HOME,
      platform: "darwin",
      nautiloRoots: { privateRoot: `${POSIX_HOME}/.nautilo/private` },
    });
    const b = buildProtectedPathDescriptors({
      homeDir: POSIX_HOME,
      platform: "darwin",
      nautiloRoots: { privateRoot: `${POSIX_HOME}/.nautilo/private` },
    });
    expect(a).toEqual(b);
  });

  test("can build linux descriptors on a non-linux host (platform is parameterized)", () => {
    // The module must not depend on process.platform; building a linux
    // policy from any host produces posix-separated descriptors.
    const linux = buildProtectedPathDescriptors({ homeDir: LINUX_HOME, platform: "linux" });
    expect(hasDescriptor(linux, `${LINUX_HOME}/.ssh`)).toBe(true);
    expect(linux.every((d) => !d.canonicalPath.includes("\\"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Matcher — equality, descendant, ancestor
// ---------------------------------------------------------------------------

describe("matchProtectedPath — posix matching", () => {
  const descriptors = buildProtectedPathDescriptors({
    homeDir: POSIX_HOME,
    platform: "darwin",
  });
  const opts = { platform: "darwin" as NodeJS.Platform, homeCanonical: POSIX_HOME };

  test("equality: denies a protected path itself", () => {
    const r = matchProtectedPath(descriptors, `${POSIX_HOME}/.ssh`, opts);
    const denied = expectDenied(r);
    expect(denied.kind).toBe("equality");
    expect(denied.descriptor?.category).toBe("ssh");
  });

  test("descendant: denies a file inside a protected subtree", () => {
    const r = matchProtectedPath(descriptors, `${POSIX_HOME}/.ssh/id_rsa`, opts);
    const denied = expectDenied(r);
    expect(denied.kind).toBe("descendant");
  });

  test("equality on absolute system root", () => {
    const r = matchProtectedPath(descriptors, "/etc/passwd", opts);
    expectDenied(r);
  });

  test("descendant on absolute system root subtree", () => {
    const r = matchProtectedPath(descriptors, "/etc/ssh/sshd_config", opts);
    const denied = expectDenied(r);
    expect(denied.kind).toBe("descendant");
  });

  test("ancestor: denies `/` (root is ancestor of every absolute deny)", () => {
    const r = matchProtectedPath(descriptors, "/", opts);
    const denied = expectDenied(r);
    expect(denied.kind).toBe("ancestor");
  });

  test("ancestor: denies `/etc` (ancestor of /etc/passwd, /etc/shadow, ...)", () => {
    const r = matchProtectedPath(descriptors, "/etc", opts);
    const denied = expectDenied(r);
    expect(denied.kind).toBe("ancestor");
  });

  test("ancestor: denies home directory itself (ancestor of ~/.ssh, ~/.aws, ...)", () => {
    const r = matchProtectedPath(descriptors, POSIX_HOME, opts);
    const denied = expectDenied(r);
    expect(denied.kind).toBe("ancestor");
  });

  test("ancestor: denies home PARENT so a recursive walk from /Users cannot bypass", () => {
    const parent = nodePath.posix.dirname(POSIX_HOME); // /Users
    const r = matchProtectedPath(descriptors, parent, opts);
    const denied = expectDenied(r);
    expect(denied.kind).toBe("ancestor");
  });

  test("allows a legit sibling path with no protected descendants", () => {
    expectAllowed(matchProtectedPath(descriptors, `${POSIX_HOME}/Documents/notes.md`, opts));
    expectAllowed(matchProtectedPath(descriptors, "/tmp/scratch.txt", opts));
  });
});

// ---------------------------------------------------------------------------
// Matcher — separator safety + canonicalization
// ---------------------------------------------------------------------------

describe("matchProtectedPath — separator safety + canonicalization", () => {
  const descriptors = buildProtectedPathDescriptors({
    homeDir: POSIX_HOME,
    platform: "linux",
  });
  const opts = { platform: "linux" as NodeJS.Platform, homeCanonical: POSIX_HOME };

  test("`/etcfoo` is NOT matched by the `/etc` descriptor", () => {
    expectAllowed(matchProtectedPath(descriptors, "/etcfoo/passwd", opts));
  });

  test("`/etc` ancestor match works regardless of trailing slash", () => {
    expectDenied(matchProtectedPath(descriptors, "/etc/", opts));
    expectDenied(matchProtectedPath(descriptors, "/etc", opts));
  });

  test("a sibling named `.ssh-backup` is NOT matched by `.ssh`", () => {
    expectAllowed(matchProtectedPath(descriptors, `${POSIX_HOME}/.ssh-backup/key`, opts));
  });

  test("collapses `..` segments before matching", () => {
    const r = matchProtectedPath(
      descriptors,
      `${POSIX_HOME}/Documents/../.ssh/id_rsa`,
      opts,
    );
    const denied = expectDenied(r);
    expect(denied.candidateCanonical).toBe(`${POSIX_HOME}/.ssh/id_rsa`);
  });

  test("expands `~` and `~/...` against the policy home", () => {
    expectDenied(matchProtectedPath(descriptors, "~/.ssh", opts));
    expectDenied(matchProtectedPath(descriptors, "~", opts));
  });

  test("resolves relative candidates against home (deterministic, no cwd)", () => {
    const r = matchProtectedPath(descriptors, ".ssh/id_ed25519", opts);
    expectDenied(r);
  });
});

// ---------------------------------------------------------------------------
// Matcher — fail closed on control bytes
// ---------------------------------------------------------------------------

describe("matchProtectedPath — fail closed", () => {
  const descriptors = buildProtectedPathDescriptors({
    homeDir: POSIX_HOME,
    platform: "linux",
  });
  const opts = { platform: "linux" as NodeJS.Platform, homeCanonical: POSIX_HOME };

  test("denies a candidate containing a NUL byte", () => {
    const r = matchProtectedPath(descriptors, `${POSIX_HOME}/.ssh\u0000id_rsa`, opts);
    const denied = expectDenied(r);
    expect(denied.kind).toBe("control_byte");
    expect(denied.descriptor).toBeUndefined();
  });

  test("denies a candidate containing a DEL or C1 control byte", () => {
    expect(expectDenied(matchProtectedPath(descriptors, `${POSIX_HOME}/safe\u007f`, opts)).kind).toBe("control_byte");
    expect(expectDenied(matchProtectedPath(descriptors, `${POSIX_HOME}/safe\u009f`, opts)).kind).toBe("control_byte");
  });

  test("control-byte denial happens even with an empty descriptor set", () => {
    const r = matchProtectedPath([], `${POSIX_HOME}/x\u0000`, opts);
    const denied = expectDenied(r);
    expect(denied.kind).toBe("control_byte");
  });

  test("an empty descriptor set allows a clean path", () => {
    expectAllowed(matchProtectedPath([], `${POSIX_HOME}/safe.txt`, opts));
  });
});

// ---------------------------------------------------------------------------
// isPathProtected + policy wrapper
// ---------------------------------------------------------------------------

describe("isPathProtected + buildProtectedPathPolicy", () => {
  const policy = buildProtectedPathPolicy({
    homeDir: POSIX_HOME,
    platform: "linux",
    nautiloRoots: { privateRoot: `${POSIX_HOME}/.nautilo/private` },
  });

  test("policy carries the schema version + canonical home + descriptors", () => {
    expect(policy.schemaVersion).toBe(PROTECTED_PATH_POLICY_SCHEMA_VERSION);
    expect(policy.platform).toBe("linux");
    expect(policy.homeCanonical).toBe(POSIX_HOME);
    expect(policy.descriptors.length).toBeGreaterThan(0);
  });

  test("policy.check denies a protected descendant", () => {
    expect(isPathProtected(policy.descriptors, `${POSIX_HOME}/.ssh/id_rsa`, {
      platform: "linux",
      homeCanonical: POSIX_HOME,
    })).toBe(true);
  });

  test("policy.check allows a clean path", () => {
    expect(policy.check(`${POSIX_HOME}/Documents/notes.md`).allowed).toBe(true);
  });

  test("policy.check denies a Nautilo caller root subtree", () => {
    expect(policy.check(`${POSIX_HOME}/.nautilo/private/vault.key`).allowed).toBe(false);
  });

  test("policy.check fails closed on control bytes", () => {
    const r = policy.check(`${POSIX_HOME}/x\u0000`);
    const denied = expectDenied(r);
    expect(denied.kind).toBe("control_byte");
  });
});
