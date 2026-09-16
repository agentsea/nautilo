import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { sha256HexOfBytes } from "../../packages/config/src/vendored-binary.ts";
import { runExactImageAudit, type ExactImageAuditDependencies } from "./exact-image-audit.ts";
import { parseExactImageAuditToolManifest } from "./exact-image-audit-tools.ts";
import type { RuntimeImageEvidenceManifestV1 } from "./runtime-image-evidence.ts";
import type { VulnerabilityDatabaseIdentityV1 } from "./vulnerability-db-identity.ts";
import type { BoundedDisclosurePolicyV1, DisclosureArchiveObservation } from "./bounded-disclosure.ts";
import type { VulnerabilityPolicyV1 } from "./vulnerability-policy.ts";

const digest = `sha256:${"a".repeat(64)}`;
const reference = `registry.example/nautilo/server@${digest}`;
const toolManifest = parseExactImageAuditToolManifest(readFileSync(join(import.meta.dir, "exact-image-audit-tools.manifest.json"), "utf8"));
const disclosurePolicy: BoundedDisclosurePolicyV1 = { version: 1, repositoryPaths: [], operatorPaths: [], privateHostnames: [], privateEmails: [], privateUsernames: [], customerMarkers: [] };
const vulnerabilityPolicy: VulnerabilityPolicyV1 = {
  version: 1,
  binding: { image: { digest, reference }, architecture: "linux/arm64", databases: { grype: "1".repeat(64), trivy: "2".repeat(64) } },
  exceptions: [],
};
const cleanDisclosure: DisclosureArchiveObservation = { files: [{ layer: "layer.tar", path: "app/server.js", contents: "console.log('ready')" }], ociMetadata: { config: { Labels: { "org.opencontainers.image.revision": "b".repeat(40) } } }, layersInspected: 1, filesInspected: 1, textBytesInspected: 20, unscannedTextFiles: [] };

function temporaryDirectory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function fixture(): { manifest: RuntimeImageEvidenceManifestV1; databaseIdentity: VulnerabilityDatabaseIdentityV1; root: string; cache: string; tools: string } {
  const directory = temporaryDirectory("d490-exact-image-audit-");
  const grypePath = join(directory, "grype.db");
  const trivyPath = join(directory, "trivy.db");
  writeFileSync(grypePath, "grype database");
  writeFileSync(trivyPath, "trivy database");
  const databaseIdentity: VulnerabilityDatabaseIdentityV1 = {
    version: 1,
    databases: {
      grype: { provider: "anchore", schemaVersion: "v6", path: grypePath, sha256: sha256HexOfBytes(readFileSync(grypePath)) },
      trivy: { provider: "aquasecurity", schemaVersion: "2", path: trivyPath, sha256: sha256HexOfBytes(readFileSync(trivyPath)) },
    },
  };
  return {
    databaseIdentity,
    root: join(directory, "evidence"),
    cache: directory,
    tools: join(directory, "tools"),
    manifest: {
      version: 1,
      sourceSha: "b".repeat(40),
      dockerfileSha256: `sha256:${"c".repeat(64)}`,
      baseImages: [{ role: "runtime", identity: `registry.example/base@sha256:${"d".repeat(64)}` }],
      architecture: "linux/arm64",
      image: { digest, reference, sizeBytes: 1234 },
      tools: { syft: "1.50.0", grype: "0.116.1", trivy: "0.73.0" },
      databases: [
        { name: "grype", identity: `sha256:${databaseIdentity.databases.grype.sha256}`, version: "v6" },
        { name: "trivy", identity: `sha256:${databaseIdentity.databases.trivy.sha256}`, version: "2" },
      ],
      capturedAt: "2026-08-04T20:00:00Z",
    },
  };
}

function successfulRun(overrides: { trivyTarget?: string; syft?: string; grype?: string } = {}): NonNullable<ExactImageAuditDependencies["run"]> {
  return async (command, args, environment) => {
    if (args[0] === "version") {
      const name = command.split("/").at(-1);
      const version = name === "syft" ? "1.50.0" : name === "grype" ? "0.116.1" : "0.73.0";
      return { exitCode: 0, stdout: `Version: ${version}\n`, stderr: "" };
    }
    if (command.endsWith("/syft")) return {
      exitCode: 0,
      stdout: overrides.syft ?? JSON.stringify({
        artifacts: [],
        source: { version: digest, metadata: { userInput: reference, repoDigests: [reference], manifestDigest: `sha256:${"f".repeat(64)}` } },
      }),
      stderr: "",
    };
    if (command.endsWith("/grype")) {
      expect(environment).toMatchObject({ GRYPE_DB_AUTO_UPDATE: "false" });
      return { exitCode: 0, stdout: overrides.grype ?? JSON.stringify({ matches: [], source: {}, descriptor: {} }), stderr: "" };
    }
    if (command.endsWith("/trivy")) return { exitCode: 0, stdout: JSON.stringify({ SchemaVersion: 2, ArtifactName: overrides.trivyTarget ?? reference, Results: [] }), stderr: "" };
    if (args[1] === "inspect") return { exitCode: 0, stdout: JSON.stringify([{ Os: "linux", Architecture: "arm64", Size: 1234, RepoDigests: [reference] }]), stderr: "" };
    if (args[1] === "history") return { exitCode: 0, stdout: `${JSON.stringify({ ID: "layer-1", Size: "1kB" })}\n`, stderr: "" };
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };
}

async function runFixture(f = fixture(), run = successfulRun(), disclosure: DisclosureArchiveObservation = cleanDisclosure) {
  return runExactImageAudit({
    manifest: f.manifest,
    toolManifest,
    databaseIdentity: f.databaseIdentity,
    disclosurePolicy,
    vulnerabilityPolicy: {
      ...vulnerabilityPolicy,
      binding: {
        ...vulnerabilityPolicy.binding,
        databases: { grype: f.databaseIdentity.databases.grype.sha256, trivy: f.databaseIdentity.databases.trivy.sha256 },
      },
    },
    toolsDirectory: f.tools,
    grypeCacheDirectory: f.cache,
    trivyCacheDirectory: f.cache,
    outputRoot: f.root,
    dependencies: { run, collectDisclosure: async () => disclosure },
  });
}

describe("D490 exact-image audit evidence binding", () => {
  test("writes seven digest-bound reports and the index last", async () => {
    const result = await runFixture();
    expect(result.index.reports.map((report) => report.type)).toEqual(["sbom", "vulnerabilities", "image-analysis", "vulnerability-policy", "image-inspect", "image-history", "bounded-disclosure"]);
    expect(result.index.reports.every((report) => report.sourceSha === "b".repeat(40) && report.architecture === "linux/arm64" && report.image.reference === reference)).toBe(true);
    expect(result.index.reports.every((report) => report.sizeBytes > 0 && /^sha256:[a-f0-9]{64}$/.test(report.sha256))).toBe(true);
    expect(JSON.parse(readFileSync(result.indexPath, "utf8"))).toEqual(result.index);
  });

  test("rejects mutable image authority before executing a command", async () => {
    const f = fixture();
    (f.manifest.image as { reference: string }).reference = "registry.example/nautilo/server:latest";
    let called = false;
    await expect(runFixture(f, async () => { called = true; return { exitCode: 0, stdout: "x", stderr: "" }; })).rejects.toThrow("immutable");
    expect(called).toBe(false);
  });

  test("runs Trivy from the remote registry against the manifest immutable digest", async () => {
    const f = fixture();
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const run = successfulRun();
    await runFixture(f, async (command, args, environment) => {
      calls.push({ command, args });
      return run(command, args, environment);
    });
    const trivy = calls.find(({ command, args }) => command.endsWith("/trivy") && args[0] === "image");
    const trivyArgs = trivy?.args ?? [];
    expect(trivyArgs).toContain("--image-src");
    expect(trivyArgs[trivyArgs.indexOf("--image-src") + 1]).toBe("remote");
    expect(trivyArgs.at(-1)).toBe(f.manifest.image.reference);
  });

  test("rejects an installed scanner version that differs from the pin", async () => {
    const f = fixture();
    const run = successfulRun();
    await expect(runFixture(f, async (command, args, environment) => {
      if (command.endsWith("/grype") && args[0] === "version") return { exitCode: 0, stdout: "Version: 0.115.0\n", stderr: "" };
      return run(command, args, environment);
    })).rejects.toThrow("version mismatch");
  });

  test("fails closed when a subprocess exits nonzero", async () => {
    const run = successfulRun();
    await expect(runFixture(fixture(), async (command, args, environment) => {
      if (command.endsWith("/grype") && args[0]?.startsWith("sbom:")) return { exitCode: 7, stdout: "", stderr: "scanner failed" };
      return run(command, args, environment);
    })).rejects.toThrow("exit code 7");
  });

  test("rejects missing and malformed machine evidence", async () => {
    await expect(runFixture(fixture(), successfulRun({ syft: "" }))).rejects.toThrow("produced no output");
    await expect(runFixture(fixture(), successfulRun({ syft: "{}" }))).rejects.toThrow("artifacts and source");
  });

  test("accepts Syft's reconstructed manifest digest when authoritative repository bindings match", async () => {
    const result = await runFixture();
    expect(result.index.image.digest).toBe(digest);
  });

  test("rejects Syft evidence without the authoritative repository digest binding", async () => {
    const syft = JSON.stringify({
      artifacts: [],
      source: { version: digest, metadata: { userInput: reference, repoDigests: [], manifestDigest: digest } },
    });
    await expect(runFixture(fixture(), successfulRun({ syft }))).rejects.toThrow("repository digests");
  });

  test("rejects Syft evidence whose source version names another digest", async () => {
    const syft = JSON.stringify({
      artifacts: [],
      source: { version: `sha256:${"e".repeat(64)}`, metadata: { userInput: reference, repoDigests: [reference] } },
    });
    await expect(runFixture(fixture(), successfulRun({ syft }))).rejects.toThrow("source version");
  });

  test("rejects a scanner report bound to another immutable image", async () => {
    const other = `registry.example/nautilo/server@sha256:${"e".repeat(64)}`;
    await expect(runFixture(fixture(), successfulRun({ trivyTarget: other }))).rejects.toThrow("does not match");
  });

  test("writes the critical finding report but withholds the complete index", async () => {
    const f = fixture();
    const grype = JSON.stringify({
      matches: [{
        vulnerability: { id: "CVE-FIXTURE-CRITICAL", severity: "Critical", fix: { versions: [] } },
        artifact: { name: "fixture-runtime", version: "1.0.0" },
      }],
      source: {}, descriptor: {},
    });
    await expect(runFixture(f, successfulRun({ grype }))).rejects.toThrow("unmatched-high-critical");
    const files = [...new Bun.Glob("**/*").scanSync({ cwd: f.root })];
    expect(files.some((path) => path.endsWith("vulnerability-policy.json"))).toBe(true);
    const summaryPath = files.find((path) => path.endsWith("vulnerability-policy-summary.md"));
    expect(summaryPath).toBeDefined();
    const summary = readFileSync(join(f.root, summaryPath!), "utf8");
    expect(summary).toContain("CVE-FIXTURE-CRITICAL");
    expect(summary).toContain("grype / CVE-FIXTURE-CRITICAL / fixture-runtime / 1.0.0 / critical");
    expect(summary).toContain("Earliest exception expiry: none");
    expect(files.some((path) => path.endsWith("report-index.json"))).toBe(false);
  });

  test("writes the secret-marker report but withholds the complete index", async () => {
    const f = fixture();
    const disclosed: DisclosureArchiveObservation = { ...cleanDisclosure, files: [{ layer: "layer.tar", path: "app/runtime.js", contents: 'API_TOKEN="wK5m2vF9qR7sT3xN8cD4pL6a"' }] };
    await expect(runFixture(f, successfulRun(), disclosed)).rejects.toThrow("bounded disclosure gate");
    const files = [...new Bun.Glob("**/*").scanSync({ cwd: f.root })];
    expect(files.some((path) => path.endsWith("bounded-disclosure.json"))).toBe(true);
    expect(files.some((path) => path.endsWith("report-index.json"))).toBe(false);
  });
});
