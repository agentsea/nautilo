#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchAndVerifyVendoredBinary } from "@nautilo/config/vendored-binary-fetch";
import { githubCliManifest } from "../electron/github-cli-runtime";
import { DESKTOP_DARWIN_PLATFORM_KEYS } from "../electron/tool-runtimes-manifest";
import { githubCliDigest, GITHUB_CLI_LICENSE_SHA256, verifyGitHubCliDistribution } from "./github-cli-distribution";

/** Download only official pinned ZIP bytes; extract and materialize exactly
 * the declared executable and license. Never runs gh, Homebrew or auth. */
export async function vendorGitHubCli(root: string): Promise<void> {
  try { verifyGitHubCliDistribution(root); return; } catch { /* Rebuild stale generated cache from the pins. */ }
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  for (const key of DESKTOP_DARWIN_PLATFORM_KEYS) {
    const artifact = githubCliManifest.artifacts[key];
    if (!artifact?.url || !artifact.sha256 || !artifact.binarySha256 || !artifact.member) throw new Error("Incomplete GitHub CLI pin");
    const temporary = mkdtempSync(join(tmpdir(), "nautilo-github-cli-vendor-"));
    try {
      const archive = join(temporary, "archive.zip");
      await fetchAndVerifyVendoredBinary({ url: artifact.url, sha256: artifact.sha256, destPath: archive, executable: false, minBytes: 1 });
      const extracted = join(temporary, "extracted");
      // The complete ZIP is verified before extraction; incidental completion,
      // docs and executable members never enter the app's runtime resource.
      execFileSync("/usr/bin/unzip", ["-q", archive, "-d", extracted]);
      const copy = (member: string, destination: string, expected: string): void => {
        const source = join(extracted, member);
        if (!lstatSync(source).isFile() || lstatSync(source).isSymbolicLink() || !realpathSync(source).startsWith(realpathSync(extracted) + sep)) throw new Error("Unsafe GitHub CLI archive member");
        const bytes = readFileSync(source);
        if (githubCliDigest(bytes) !== expected) throw new Error("GitHub CLI archive member checksum mismatch");
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, bytes);
      };
      const destination = join(root, key, "gh");
      copy(artifact.member, destination, artifact.binarySha256);
      chmodSync(destination, 0o755);
      copy(join(dirname(dirname(artifact.member)), "LICENSE"), join(root, "LICENSE"), GITHUB_CLI_LICENSE_SHA256);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
  writeFileSync(join(root, "manifest.json"), JSON.stringify({ "github-cli": githubCliManifest }, null, 2) + "\n");
  writeFileSync(join(root, ".version"), githubCliManifest.version + "\n");
  verifyGitHubCliDistribution(root);
}
if (import.meta.main) {
  await vendorGitHubCli(resolve(dirname(fileURLToPath(import.meta.url)), "../vendor/github-cli"));
  console.log(`[github-cli] verified official runtime ${githubCliManifest.version} and MIT license`);
}
