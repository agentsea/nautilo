import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { githubCliManifest } from "../../electron/github-cli-runtime";
import { GITHUB_CLI_LICENSE_SHA256, verifyGitHubCliDistribution } from "../../scripts/github-cli-distribution";

const { requiresGitHubRuntimeAttestation } = createRequire(import.meta.url)("../../scripts/after-sign.cjs") as {
  requiresGitHubRuntimeAttestation(details: string): boolean;
};

test("post-sign credential attestation follows the actual certificate rather than release environment", () => {
  const identifier = "Identifier=com.nautilo.desktop\n";
  expect(requiresGitHubRuntimeAttestation(`${identifier}TeamIdentifier=ABCDEFGHIJ\nAuthority=Developer ID Application: Fixture\n`)).toBe(true);
  expect(requiresGitHubRuntimeAttestation(`${identifier}TeamIdentifier=not set\nSignature=adhoc\n`)).toBe(false);
  for (const details of [identifier, `${identifier}TeamIdentifier=not set\nAuthority=Fixture\nSignature=adhoc\n`, `${identifier}TeamIdentifier=ABCDEFGHIJ\nAuthority=Fixture\n`, "Identifier=foreign.app\nSignature=adhoc\n"]) {
    expect(() => requiresGitHubRuntimeAttestation(details)).toThrow();
  }
});

test("GitHub CLI pins exact official macOS archives and independently extracted binaries", () => {
  expect(githubCliManifest.version).toBe("2.102.0");
  expect(githubCliManifest.license).toBe("MIT");
  expect(githubCliManifest.source).toBe("https://github.com/cli/cli");
  expect(Object.keys(githubCliManifest.artifacts).sort()).toEqual(["darwin-arm64", "darwin-x64"]);
  for (const [key, arch] of [["darwin-arm64", "arm64"], ["darwin-x64", "amd64"]] as const) {
    const artifact = githubCliManifest.artifacts[key]!;
    expect(artifact.url).toBe(`https://github.com/cli/cli/releases/download/v2.102.0/gh_2.102.0_macOS_${arch}.zip`);
    expect(artifact.member).toBe(`gh_2.102.0_macOS_${arch}/bin/gh`);
    expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(artifact.binarySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(artifact.sha256).not.toBe(artifact.binarySha256);
  }
  expect(GITHUB_CLI_LICENSE_SHA256).toBe("6da4adc42392c8485e40b4251c7e332fc3352df1947c9ffade71dd60b14a7a4f");
  expect(() => verifyGitHubCliDistribution("/missing-github-cli-fixture")).toThrow();
});

test("both architecture resources, permissions and build-time integrity checks remain in the packaging path", () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  const yaml = source("../../electron-builder.yml");
  expect(yaml).toContain("from: vendor/github-cli"); expect(yaml).toContain("to: tools-github-cli");
  expect(yaml).toContain('"darwin-arm64/gh"'); expect(yaml).toContain('"darwin-x64/gh"');
  expect(yaml).toContain("tools-gog,tools-github-cli,tools-ffmpeg");
  const pkg = JSON.parse(source("../../package.json")) as { scripts: Record<string, string> };
  for (const key of ["dev:prepare", "package:mac:build", "package:dev:build"]) expect(pkg.scripts[key]).toContain("bun run vendor:github-cli");
  expect(source("../../scripts/after-pack.cjs")).toContain('"gh"');
  expect(source("../../scripts/after-pack.cjs")).toContain('"verify-github-cli.ts"');
  expect(source("../../scripts/after-sign.cjs")).toContain('"verify-github-cli.ts"');
  expect(source("../../scripts/after-sign.cjs")).toContain("ad-hoc package: GitHub credential custody is unavailable");
});
