import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { githubCliManifest, verifiedGitHubFileHash } from "../electron/github-cli-runtime";
import { DESKTOP_DARWIN_PLATFORM_KEYS, parseToolRuntimesManifest } from "../electron/tool-runtimes-manifest";

export const GITHUB_CLI_LICENSE_SHA256 = "6da4adc42392c8485e40b4251c7e332fc3352df1947c9ffade71dd60b14a7a4f";
export const githubCliDigest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** The vendor cache and pre-sign package must retain the exact upstream bytes.
 * Production post-sign verification binds changed bytes to the sealed app. */
export function verifyGitHubCliDistribution(root: string, signedApp?: string): void {
  const allowed = new Set(["manifest.json", "LICENSE", ".version", ...DESKTOP_DARWIN_PLATFORM_KEYS.map(key => `${key}/gh`)]);
  const walk = (directory: string, prefix = ""): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory() && DESKTOP_DARWIN_PLATFORM_KEYS.includes(relative as typeof DESKTOP_DARWIN_PLATFORM_KEYS[number])) walk(join(directory, entry.name), `${relative}/`);
      else if (!entry.isFile() || !allowed.has(relative)) throw new Error("Unexpected GitHub CLI package member");
    }
  };
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error("Invalid GitHub CLI package root");
  walk(root);
  const packaged = parseToolRuntimesManifest(readFileSync(join(root, "manifest.json"), "utf8"))["github-cli"];
  if (JSON.stringify(packaged) !== JSON.stringify(githubCliManifest) || readFileSync(join(root, ".version"), "utf8").trim() !== githubCliManifest.version) throw new Error("GitHub CLI package pin mismatch");
  if (githubCliDigest(readFileSync(join(root, "LICENSE"))) !== GITHUB_CLI_LICENSE_SHA256) throw new Error("GitHub CLI license mismatch");
  for (const key of DESKTOP_DARWIN_PLATFORM_KEYS) {
    const expected = githubCliManifest.artifacts[key]?.binarySha256;
    if (!expected || !verifiedGitHubFileHash(join(root, key, "gh"), expected, signedApp ? {
      resourcesPath: join(signedApp, "Contents", "Resources"), executablePath: join(signedApp, "Contents", "MacOS", basename(signedApp, ".app")),
    } : undefined)) throw new Error("GitHub CLI integrity verification failed");
  }
}
