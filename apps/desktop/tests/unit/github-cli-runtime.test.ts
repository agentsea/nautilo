import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { probeDesktopGitHubRuntime, verifiedGitHubFileHash, verifyGitHubAppSignature } from "../../electron/github-cli-runtime";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "github-runtime-fixture-"))); roots.push(root);
  const app = join(root, "Nautilo.app"); const resourcesPath = join(app, "Contents", "Resources");
  const executablePath = join(app, "Contents", "MacOS", "Nautilo");
  const binaryPath = join(resourcesPath, "tools-github-cli", "darwin-arm64", "gh");
  mkdirSync(dirname(executablePath), { recursive: true }); mkdirSync(dirname(binaryPath), { recursive: true });
  writeFileSync(executablePath, "fixture app"); writeFileSync(binaryPath, "fixture runtime"); chmodSync(binaryPath, 0o755);
  return { root, app, resourcesPath, executablePath, binaryPath, hash: createHash("sha256").update("fixture runtime").digest("hex") };
}
function signature(f: ReturnType<typeof fixture>, change: { adHoc?: boolean; wrongTeam?: boolean; invalidSeal?: boolean } = {}) {
  const calls: string[][] = [];
  const run = (args: readonly string[]): string => {
    calls.push([...args]);
    if (args.includes("--deep") && change.invalidSeal) throw new Error("seal failed");
    const path = args.at(-1);
    return `Identifier=${path === f.app ? "com.nautilo.desktop" : "fixture-runtime"}\nTeamIdentifier=${change.adHoc ? "not set" : change.wrongTeam && path === f.binaryPath ? "ZZZZZZZZZZ" : "ABCDEFGHIJ"}\n`;
  };
  return { run, calls };
}

test.skipIf(process.platform === "win32")("strict development file verification accepts only exact executable bytes and never caches drift", () => {
  const f = fixture();
  expect(verifiedGitHubFileHash(f.binaryPath, f.hash)).toBe(f.hash);
  writeFileSync(f.binaryPath, "changed runtime");
  expect(verifiedGitHubFileHash(f.binaryPath, f.hash)).toBeNull();
  expect(verifiedGitHubFileHash(f.binaryPath, "invalid")).toBeNull();
});

test.skipIf(process.platform === "win32")("symlinks, hardlinks, missing executable permission and writable executable permissions fail closed", () => {
  const f = fixture();
  chmodSync(f.binaryPath, 0o644); expect(verifiedGitHubFileHash(f.binaryPath, f.hash)).toBeNull();
  chmodSync(f.binaryPath, 0o777); expect(verifiedGitHubFileHash(f.binaryPath, f.hash)).toBeNull();
  chmodSync(f.binaryPath, 0o755);
  const linked = join(f.root, "linked-gh"); symlinkSync(f.binaryPath, linked);
  expect(verifiedGitHubFileHash(linked, f.hash)).toBeNull();
  linkSync(f.binaryPath, join(f.root, "hardlinked-gh"));
  expect(verifiedGitHubFileHash(f.binaryPath, f.hash)).toBeNull();
});

test.skipIf(process.platform === "win32")("packaged verification requires the exact app seal and matching certificate-backed nested identity", () => {
  const f = fixture(); const signed = signature(f);
  expect(verifiedGitHubFileHash(f.binaryPath, "0".repeat(64), f, signed.run)).toBe(f.hash);
  expect(signed.calls.some(args => args.includes("--deep") && args.includes("--strict") && args.at(-1) === f.app)).toBe(true);
  expect(signed.calls.some(args => args.includes("-R") && args.at(-1) === f.binaryPath)).toBe(true);
  for (const change of [{ adHoc: true }, { wrongTeam: true }, { invalidSeal: true }]) {
    expect(verifiedGitHubFileHash(f.binaryPath, f.hash, f, signature(f, change).run)).toBeNull();
  }
  expect(verifyGitHubAppSignature({ ...f, resourcesPath: join(f.root, "foreign-resources") }, signed.run)).toBe(false);
  expect(verifyGitHubAppSignature({ ...f, executablePath: process.execPath }, signed.run)).toBe(false);
});

test("generated codesign requirements use inline grammar accepted by the macOS requirement compiler", () => {
  const f = fixture(); const signed = signature(f);
  expect(verifyGitHubAppSignature(f, signed.run)).toBe(true);
  const requirements = signed.calls.filter(args => args.includes("-R")).map(args => args[args.indexOf("-R") + 1]!);
  expect(requirements).toEqual([
    '=anchor apple generic and identifier "com.nautilo.desktop"',
    '=anchor apple generic and certificate leaf[subject.OU] = "ABCDEFGHIJ"',
    '=anchor apple generic and certificate leaf[subject.OU] = "ABCDEFGHIJ"',
  ]);
  if (process.platform === "darwin") {
    for (const requirement of requirements) {
      // Compile the exact generated argument. No code is signed or executed,
      // and no Nautilo artifact or account is involved in this grammar check.
      const result = spawnSync("/usr/bin/csreq", ["-r", requirement, "-t"], {
        encoding: "utf8", env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("anchor apple generic");
    }
  }
});

test.skipIf(process.platform === "win32")("signature verification cannot authorize bytes changed during attestation", () => {
  const f = fixture(); const signed = signature(f);
  const run = (args: readonly string[]): string => {
    if (args.includes("--deep")) writeFileSync(f.binaryPath, "replacement runtime");
    return signed.run(args);
  };
  expect(verifiedGitHubFileHash(f.binaryPath, f.hash, f, run)).toBeNull();
});

test("production attestation rejects an unsigned fixture even when its byte hash matches", () => {
  const f = fixture();
  expect(verifiedGitHubFileHash(f.binaryPath, f.hash, f)).toBeNull();
});

test("runtime probe never borrows a packaged path for development or a vendor path for packaged custody", () => {
  const f = fixture();
  const vendor = join(f.root, "vendor");
  expect(probeDesktopGitHubRuntime({ isPackaged: false, resourcesPath: f.resourcesPath, devVendorRoot: vendor, platformKey: "darwin-arm64" }).ok).toBe(false);
  expect(probeDesktopGitHubRuntime({ isPackaged: true, resourcesPath: join(f.root, "missing"), devVendorRoot: vendor, platformKey: "darwin-arm64" }).ok).toBe(false);
  expect(probeDesktopGitHubRuntime({ isPackaged: false, platformKey: null }).ok).toBe(false);
});
