import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import {
  BOUNDED_DISCLOSURE_CATEGORIES,
  evaluateBoundedDisclosure,
  collectDisclosureArchive,
  parseBoundedDisclosurePolicy,
  type BoundedDisclosurePolicyV1,
  type DisclosureArchiveObservation,
} from "./bounded-disclosure.ts";
import type { RuntimeImageEvidenceManifestV1 } from "./runtime-image-evidence.ts";

const manifest: RuntimeImageEvidenceManifestV1 = {
  version: 1, sourceSha: "b".repeat(40), dockerfileSha256: `sha256:${"c".repeat(64)}`,
  baseImages: [{ role: "runtime", identity: `registry.example/base@sha256:${"d".repeat(64)}` }],
  architecture: "linux/amd64",
  image: { digest: `sha256:${"a".repeat(64)}`, reference: `registry.example/server@sha256:${"a".repeat(64)}`, sizeBytes: 42 },
  tools: { syft: "1.50.0", grype: "0.116.1", trivy: "0.73.0" }, databases: [{ name: "grype", identity: "db", version: "6" }], capturedAt: "2026-08-04T20:00:00Z",
};
const policy: BoundedDisclosurePolicyV1 = {
  version: 1,
  repositoryPaths: ["/build/private-repository"], operatorPaths: ["/Users/operator-name"],
  privateHostnames: ["private.nautilo.test"], privateEmails: ["operator@nautilo.test"],
  privateUsernames: ["operator-name"], customerMarkers: ["CUSTOMER-ALPHA-PRIVATE"],
};
function observation(files: DisclosureArchiveObservation["files"], ociMetadata: unknown = {}): DisclosureArchiveObservation {
  return { files, ociMetadata, layersInspected: 2, filesInspected: files.length, textBytesInspected: 100, unscannedTextFiles: [] };
}

describe("D490 bounded disclosure taxonomy", () => {
  test("passes a clean image while stating the bounded claim", () => {
    const report = evaluateBoundedDisclosure(manifest, policy, observation([{ layer: "one/layer.tar", path: "app/server.js", contents: "public runtime" }]));
    expect(report.passed).toBe(true);
    expect(report.categories).toEqual(BOUNDED_DISCLOSURE_CATEGORIES);
    expect(report.claim).toBe("bounded-taxonomy-only");
    expect(report.limitation).toContain("Does not claim");
  });

  test("does not block inert parser constants, documentation tokens, generic host paths, or RFC1918 examples", () => {
    const contents = [
      'const PRIVATE_KEY_HEADER = "-----BEGIN PRIVATE KEY-----";',
      "// ghp_abcdefghijklmnopqrstuvwxyz123456 is documentation only",
      'const token = "example_token_value_123456";',
      'const X_AWS_EC2_METADATA_TOKEN = "x-aws-ec2-metadata-token";',
      'const apiKey = "ANTHROPIC_API_KEY"; const extracted = token = extractToken(chunk);',
      "const APP_SPECIFIC_SECRET = 'salt-12345678-secret';",
      "const options = args.local; // not a hostname",
      "ghp_xxxxxxxxxxxxxxxxxxxx",
      "-----BEGIN RSA PRIVATE KEY-----\n...\nKh9NV...\n-----END RSA PRIVATE KEY-----",
      "Open https://api.example.internal from /Users/example/project or /workspace/example/project and use 192.168.10.20 in the guide.",
    ].join("\n");
    const report = evaluateBoundedDisclosure(manifest, policy, observation([{ layer: "one/layer.tar", path: "app/docs.js", contents }]));
    expect(report.passed).toBe(true);
    expect(report.findings).toEqual([]);
  });

  test("allows the exact public EC2 metadata header name without weakening credential detection", () => {
    const contents = [
      'const X_AWS_EC2_METADATA_TOKEN = "x-aws-ec2-metadata-token";',
      'const API_TOKEN = "wK5m2vF9qR7sT3xN8cD4pL6a";',
    ].join("\n");
    const report = evaluateBoundedDisclosure(manifest, policy, observation([{ layer: "one/layer.tar", path: "app/sdk.js", contents }]));
    expect(report.passed).toBe(false);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.rule).toBe("credential-assignment");
  });

  test("detects complete embedded secrets and non-generic operator infrastructure while allowing exact policy markers to cover known private IPs", () => {
    const policyWithPrivateIp: BoundedDisclosurePolicyV1 = { ...policy, privateHostnames: [...policy.privateHostnames, "10.42.0.7"] };
    const contents = [
      "-----BEGIN PRIVATE KEY-----",
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCv6tYRrJ2z",
      "-----END PRIVATE KEY-----",
      'API_TOKEN="wK5m2vF9qR7sT3xN8cD4pL6a"',
      "ghp_Q2vN7xK9pL3mR6sT8wY1zA4bC5dE7fG9hJ",
      "AKIAQWERTYUIOPASDFGH",
      'connect /Users/alice-prod/project or /workspace/alice-prod/project from /github/workspace and /github/workspace/ to "db.corp.internal" at 10.42.0.7',
    ].join("\n");
    const report = evaluateBoundedDisclosure(manifest, policyWithPrivateIp, observation([{ layer: "one/layer.tar", path: "app/runtime-config.js", contents }]));
    expect(report.passed).toBe(false);
    expect(new Set(report.findings.map((finding) => finding.rule))).toEqual(new Set([
      "private-key", "credential-assignment", "github-token", "aws-access-key", "host-build-path", "private-hostname",
    ]));
    expect(report.findings.filter((finding) => finding.rule === "host-build-path")).toHaveLength(1);
    for (const buildRoot of ["/github/workspace", "/github/workspace/"]) {
      const buildRootReport = evaluateBoundedDisclosure(manifest, policy, observation([{ layer: "one/layer.tar", path: "app/runtime-config.js", contents: buildRoot }]));
      expect(buildRootReport.findings.filter((finding) => finding.rule === "host-build-path")).toHaveLength(1);
    }
  });

  test("detects every explicit category without storing matched values", () => {
    const files = [
      { layer: "one/layer.tar", path: "root/.npmrc", contents: "//registry/:_authToken=abcdefghijklmnop" },
      { layer: "one/layer.tar", path: "app/server.js.map", contents: "CUSTOMER-ALPHA-PRIVATE /build/private-repository /Users/operator-name private.nautilo.test operator@nautilo.test" },
    ];
    const metadata = { config: { Env: { API_TOKEN: "github_pat_Q2vN7xK9pL3mR6sT8wY1zA4bC5dE7fG9hJ" }, Labels: { "org.opencontainers.image.revision": "wrong-sha" } } };
    const report = evaluateBoundedDisclosure(manifest, policy, observation(files, metadata));
    expect(report.passed).toBe(false);
    expect(new Set(report.findings.map((finding) => finding.category))).toEqual(new Set(BOUNDED_DISCLOSURE_CATEGORIES));
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("CUSTOMER-ALPHA-PRIVATE");
    expect(serialized).not.toContain("github_pat_Q2vN7xK9pL3mR6sT8wY1zA4bC5dE7fG9hJ");
    expect(report.findings.every((finding) => /^sha256:[a-f0-9]{64}$/.test(finding.matchSha256))).toBe(true);
  });

  test("fails closed when a text file was too large to inspect", () => {
    const input = observation([]) as DisclosureArchiveObservation & { unscannedTextFiles: string[] };
    input.unscannedTextFiles = ["layer:large.txt"];
    expect(evaluateBoundedDisclosure(manifest, policy, input).passed).toBe(false);
  });

  test("rejects unknown policy fields and duplicate markers", () => {
    expect(() => parseBoundedDisclosurePolicy(JSON.stringify({ ...policy, claimAllPii: true }))).toThrow("exactly");
    expect(() => parseBoundedDisclosurePolicy(JSON.stringify({ ...policy, customerMarkers: ["x", "x"] }))).toThrow("duplicate");
  });

  test("collects text and metadata from every layer, including empty layers, of a Docker save archive", async () => {
    const root = mkdtempSync(join(tmpdir(), "d490-disclosure-fixture-"));
    const outer = join(root, "outer");
    const layerSource = join(root, "layer-source");
    mkdirSync(join(outer, "layer"), { recursive: true });
    mkdirSync(join(outer, "empty"), { recursive: true });
    mkdirSync(join(layerSource, "app"), { recursive: true });
    writeFileSync(join(layerSource, "app", "server.js"), "clean runtime text");
    writeFileSync(join(layerSource, "app", ".wh.deleted-secret.txt"), "");
    chmodSync(join(layerSource, "app", ".wh.deleted-secret.txt"), 0o000);
    const layerTar = join(outer, "layer", "layer.tar");
    const emptyLayerTar = join(outer, "empty", "layer.tar");
    expect(Bun.spawnSync(["tar", "-cf", layerTar, "-C", layerSource, "."]).exitCode).toBe(0);
    expect(Bun.spawnSync(["tar", "-cf", emptyLayerTar, "--files-from", "/dev/null"]).exitCode).toBe(0);
    writeFileSync(join(outer, "config.json"), JSON.stringify({ config: { Labels: { "org.opencontainers.image.revision": manifest.sourceSha } } }));
    writeFileSync(join(outer, "manifest.json"), JSON.stringify([{ Config: "config.json", Layers: ["empty/layer.tar", "layer/layer.tar", "empty/layer.tar"] }]));
    const archive = join(root, "image.tar");
    expect(Bun.spawnSync(["tar", "-cf", archive, "-C", outer, "."]).exitCode).toBe(0);
    let savedArchive: string | undefined;
    let priorLayerRoot: string | undefined;
    const collected = await collectDisclosureArchive(manifest.image.reference, async (command, args) => {
      if (command === "docker") {
        savedArchive = args[args.indexOf("--output") + 1]!;
        copyFileSync(archive, savedArchive);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (command === "tar" && args[0] === "-xf" && args[1]?.endsWith("layer.tar")) {
        expect(savedArchive).toBeDefined();
        expect(existsSync(savedArchive!)).toBe(false);
        if (priorLayerRoot !== undefined) expect(existsSync(priorLayerRoot)).toBe(false);
        priorLayerRoot = args[args.indexOf("-C") + 1];
      }
      const process = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
      return { exitCode, stdout, stderr };
    });
    expect(collected.layersInspected).toBe(3);
    expect(collected.files.some((file) => file.path === "app/server.js" && file.contents === "clean runtime text")).toBe(true);
    expect(collected.files.some((file) => file.path === "app/.wh.deleted-secret.txt" && file.contents === undefined)).toBe(true);
    expect(JSON.stringify(collected.ociMetadata)).toContain(manifest.sourceSha);
    expect(priorLayerRoot).toBeDefined();
    expect(existsSync(priorLayerRoot!)).toBe(false);
    expect(readFileSync(archive).length).toBeGreaterThan(0);
  });
});
