import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExactImageAuditReportIndexV1,
  ExactImageAuditReportType,
} from "./exact-image-audit.ts";
import type { RuntimeImageEvidenceManifestV1 } from "./runtime-image-evidence.ts";

const REPORT_TYPES = [
  "sbom",
  "vulnerabilities",
  "image-analysis",
  "vulnerability-policy",
  "image-inspect",
  "image-history",
  "bounded-disclosure",
] as const satisfies readonly ExactImageAuditReportType[];

const REPORT_PATHS: Readonly<Record<ExactImageAuditReportType, string>> = {
  sbom: "sbom.syft.json",
  vulnerabilities: "vulnerabilities.grype.json",
  "image-analysis": "image-analysis.trivy.json",
  "vulnerability-policy": "vulnerability-policy.json",
  "image-inspect": "image-inspect.docker.json",
  "image-history": "image-history.docker.json",
  "bounded-disclosure": "bounded-disclosure.json",
};

interface EvidenceFixtureOptions {
  readonly architecture: RuntimeImageEvidenceManifestV1["architecture"];
  readonly kind: "bootstrap" | "server";
}

export interface ExactImageEvidenceFixture {
  readonly directory: string;
  readonly nativeProbe: string;
}

function sha256(contents: string): string {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

function serverNativeProbe(
  manifest: RuntimeImageEvidenceManifestV1,
): Record<string, unknown> {
  return {
    version: 1,
    sourceSha: manifest.sourceSha,
    dockerfileSha256: manifest.dockerfileSha256,
    requestedPlatform: manifest.architecture,
    executionMode: "native",
    image: {
      reference: manifest.image.reference,
      repoDigests: [manifest.image.reference],
      sizeBytes: manifest.image.sizeBytes,
    },
    probe: {
      platform: manifest.architecture,
      encryptionInventory: { typescriptVersion: "5.9.3" },
      sharp: { version: "0.35.4", sha256: "a".repeat(64) },
      argon2: { verified: true, rejectedWrongValue: true },
      officecli: {
        browserExecutable: "/usr/bin/chromium",
        screenshots: ["docx", "xlsx", "pptx"].map((format) => ({
          format,
          sizeBytes: 1024,
          sha256: "b".repeat(64),
        })),
      },
    },
  };
}

function bootstrapNativeProbe(
  manifest: RuntimeImageEvidenceManifestV1,
): Record<string, unknown> {
  return {
    version: 1,
    sourceSha: manifest.sourceSha,
    dockerfileSha256: manifest.dockerfileSha256,
    requestedPlatform: manifest.architecture,
    executionMode: "native",
    image: {
      reference: manifest.image.reference,
      repoDigests: [manifest.image.reference],
      sizeBytes: manifest.image.sizeBytes,
    },
    probe: {
      user: "nonroot:nonroot",
      entrypoint: ["/usr/local/bin/nautilo-hosted-bootstrap"],
      network: "none",
      rootFilesystem: "read-only",
      missingEnvironment: {
        status: "failed",
        clusters: [],
        failure: {
          kind: "invalid-environment",
          code: "missing-app-postgres-admin-url",
        },
      },
      invalidMode: { status: "failed", code: "invalid-bootstrap-mode" },
      missingDatabase: {
        status: "failed",
        clusters: [
          {
            status: "failed",
            cluster: "app",
            checkpoints: [],
            failure: {
              kind: "adapter-failure",
              cluster: "app",
              retryable: true,
            },
          },
        ],
        failure: { kind: "reconciliation-failed", cluster: "app" },
      },
    },
  };
}

/** Creates a compact, internally bound fixture instead of copying real scanner output. */
export function createExactImageEvidenceFixture(
  options: EvidenceFixtureOptions,
): ExactImageEvidenceFixture {
  const architectureSlug = options.architecture.split("/")[1]!;
  const digestLetter = options.architecture === "linux/amd64" ? "a" : "b";
  const digest = `sha256:${digestLetter.repeat(64)}`;
  const repository =
    options.kind === "bootstrap"
      ? "ghcr.io/agentsea/nautilo-bootstrap-staging"
      : "ghcr.io/agentsea/nautilo-runtime";
  const directory = mkdtempSync(
    join(tmpdir(), `nautilo-${options.kind}-evidence-${architectureSlug}-`),
  );
  const capturedAt = "2026-08-05T00:00:00Z";
  const manifest: RuntimeImageEvidenceManifestV1 = {
    version: 1,
    sourceSha: "c".repeat(40),
    dockerfileSha256: `sha256:${"d".repeat(64)}`,
    baseImages: [
      {
        role: "runtime",
        identity: `registry.example/base@sha256:${"e".repeat(64)}`,
      },
    ],
    architecture: options.architecture,
    image: {
      digest,
      reference: `${repository}@${digest}`,
      sizeBytes: 1024,
    },
    tools: { syft: "fixture", grype: "fixture", trivy: "fixture" },
    databases: [
      { name: "grype", identity: `sha256:${"f".repeat(64)}`, version: "fixture" },
      { name: "trivy", identity: `sha256:${"1".repeat(64)}`, version: "fixture" },
    ],
    capturedAt,
  };
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  const packages =
    options.kind === "bootstrap"
      ? [
          "base-files",
          "ca-certificates",
          "libc6",
          "media-types",
          "netbase",
          "tzdata",
          "tzdata-legacy",
        ]
      : ["nautilo-runtime", "typescript"];
  const reportValues: Record<ExactImageAuditReportType, unknown> = {
    sbom: {
      artifacts: packages.map((name) => ({
        name,
        version: name === "typescript" ? "5.9.3" : "fixture",
        type: name === "typescript" ? "npm" : "deb",
      })),
      source: {},
    },
    vulnerabilities: { matches: [] },
    "image-analysis": {
      Results: [{ Class: "license", Licenses: [{ Name: "fixture" }] }],
    },
    "vulnerability-policy": {
      version: 1,
      passed: true,
      findings: [],
      exceptions: [],
      failures: [],
      evaluatedAt: capturedAt,
    },
    "image-inspect": [
      {
        Os: "linux",
        Architecture: architectureSlug,
        Size: manifest.image.sizeBytes,
        RepoDigests: [manifest.image.reference],
      },
    ],
    "image-history": [{ ID: "fixture", Size: "1kB" }],
    "bounded-disclosure": {
      version: 1,
      claim: "bounded-taxonomy-only",
      categories: [],
      findings: [],
      coverage: { unscannedTextFiles: [] },
      passed: true,
    },
  };
  const reports = REPORT_TYPES.map((type) => {
    const path = REPORT_PATHS[type];
    const contents = `${JSON.stringify(reportValues[type], null, 2)}\n`;
    writeFileSync(join(directory, path), contents);
    return {
      type,
      path,
      sizeBytes: Buffer.byteLength(contents),
      sha256: sha256(contents),
      sourceSha: manifest.sourceSha,
      architecture: manifest.architecture,
      image: manifest.image,
    };
  });
  const index: ExactImageAuditReportIndexV1 = {
    version: 1,
    sourceSha: manifest.sourceSha,
    architecture: manifest.architecture,
    image: manifest.image,
    tools: { syft: "fixture", grype: "fixture", trivy: "fixture" },
    databases: {
      grype: {
        provider: "fixture",
        schemaVersion: "fixture",
        path: "/tmp/grype.db",
        sha256: "f".repeat(64),
      },
      trivy: {
        provider: "fixture",
        schemaVersion: "fixture",
        path: "/tmp/trivy.db",
        sha256: "1".repeat(64),
      },
    },
    reports,
    capturedAt,
  };
  writeFileSync(
    join(directory, "report-index.json"),
    `${JSON.stringify(index, null, 2)}\n`,
  );

  const nativeProbe = join(directory, "native-probe.json");
  const probe =
    options.kind === "bootstrap"
      ? bootstrapNativeProbe(manifest)
      : serverNativeProbe(manifest);
  writeFileSync(nativeProbe, `${JSON.stringify(probe, null, 2)}\n`);
  return { directory, nativeProbe };
}
