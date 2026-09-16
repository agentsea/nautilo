import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { sha256HexOfBytes } from "../../packages/config/src/vendored-binary.ts";
import {
  ExactImageAuditToolsError,
  auditToolPlatformKeyForHost,
  installExactImageAuditTools,
  parseExactImageAuditToolManifest,
  type ExactImageAuditToolManifestV1,
} from "./exact-image-audit-tools.ts";
import {
  VulnerabilityDatabaseIdentityError,
  parseVulnerabilityDatabaseIdentity,
  verifyVulnerabilityDatabaseIdentity,
  type VulnerabilityDatabaseIdentityV1,
} from "./vulnerability-db-identity.ts";

const manifestText = readFileSync(join(import.meta.dir, "exact-image-audit-tools.manifest.json"), "utf8");

function manifest(): ExactImageAuditToolManifestV1 {
  return parseExactImageAuditToolManifest(manifestText);
}

function temporaryDirectory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function databaseIdentity(grypePath: string, trivyPath: string): VulnerabilityDatabaseIdentityV1 {
  return {
    version: 1,
    databases: {
      grype: {
        provider: "anchore",
        schemaVersion: "v6",
        builtAt: "2026-08-04T18:00:00Z",
        updatedAt: "2026-08-04T18:01:00Z",
        path: grypePath,
        sha256: sha256HexOfBytes(readFileSync(grypePath)),
      },
      trivy: {
        provider: "aquasecurity",
        schemaVersion: "2",
        updatedAt: "2026-08-04T18:02:00Z",
        path: trivyPath,
        sha256: sha256HexOfBytes(readFileSync(trivyPath)),
      },
    },
  };
}

describe("D490 exact-image audit tool pins", () => {
  test("accepts the strict pinned manifest", () => {
    expect(manifest().tools.syft.version).toBe("1.50.0");
    expect(manifest().tools.grype.version).toBe("0.116.1");
    expect(manifest().tools.trivy.version).toBe("0.73.0");
  });

  test("rejects a malformed manifest and archive checksum drift", () => {
    expect(() => parseExactImageAuditToolManifest("{" )).toThrow(ExactImageAuditToolsError);
    const withBadHash = JSON.parse(manifestText) as ExactImageAuditToolManifestV1;
    (withBadHash.tools.syft.artifacts["linux-amd64"] as { sha256: string }).sha256 = "a".repeat(64);
    expect(() => parseExactImageAuditToolManifest(JSON.stringify(withBadHash))).toThrow("required archive checksum");
  });

  test("maps only supported host tuples and fails closed for every other platform", () => {
    expect(auditToolPlatformKeyForHost({ platform: "darwin", arch: "arm64" })).toBe("darwin-arm64");
    expect(auditToolPlatformKeyForHost({ platform: "darwin", arch: "x64" })).toBe("darwin-x64");
    expect(auditToolPlatformKeyForHost({ platform: "linux", arch: "x64" })).toBe("linux-amd64");
    expect(auditToolPlatformKeyForHost({ platform: "linux", arch: "arm64" })).toBe("linux-arm64");
    expect(() => auditToolPlatformKeyForHost({ platform: "win32", arch: "x64" })).toThrow("unsupported");
  });

  test("installs all three through an injected downloader without network access", async () => {
    const destination = temporaryDirectory("d490-audit-tools-");
    const calls: Array<{ readonly url: string; readonly destPath: string; readonly member: string | undefined }> = [];
    const result = await installExactImageAuditTools({
      manifest: manifest(),
      destination,
      host: { platform: "linux", arch: "arm64" },
      fetchAndInstall: async (input) => {
        calls.push({ url: input.url, destPath: input.destPath, member: input.archive?.member });
        writeFileSync(input.destPath, input.archive?.member ?? "missing-member");
        const bytes = readFileSync(input.destPath);
        return {
          destPath: input.destPath,
          size: bytes.length,
          sha256: input.sha256,
          binarySha256: sha256HexOfBytes(bytes),
        };
      },
    });

    expect(result.platformKey).toBe("linux-arm64");
    expect(result.tools.map((tool) => tool.name)).toEqual(["syft", "grype", "trivy"]);
    expect(calls.map((call) => call.member)).toEqual(["syft", "grype", "trivy"]);
    expect(calls.map((call) => call.destPath)).toEqual([join(destination, "syft"), join(destination, "grype"), join(destination, "trivy")]);
    expect(calls.every((call) => call.url.includes("/releases/download/v"))).toBe(true);
  });
});

describe("D490 vulnerability database identity", () => {
  test("hash-verifies supplied Grype and Trivy database files", () => {
    const directory = temporaryDirectory("d490-vulnerability-dbs-");
    const grypePath = join(directory, "grype.db");
    const trivyPath = join(directory, "trivy.db");
    writeFileSync(grypePath, "grype-db-bytes");
    writeFileSync(trivyPath, "trivy-db-bytes");

    const verified = verifyVulnerabilityDatabaseIdentity(databaseIdentity(grypePath, trivyPath));
    expect(verified.map((database) => database.name)).toEqual(["grype", "trivy"]);
  });

  test("rejects a supplied database whose bytes no longer match its identity", () => {
    const directory = temporaryDirectory("d490-vulnerability-db-mismatch-");
    const grypePath = join(directory, "grype.db");
    const trivyPath = join(directory, "trivy.db");
    writeFileSync(grypePath, "expected-grype-db");
    writeFileSync(trivyPath, "trivy-db");
    const identity = databaseIdentity(grypePath, trivyPath);
    writeFileSync(grypePath, "changed-grype-db");

    expect(() => verifyVulnerabilityDatabaseIdentity(identity)).toThrow("sha256 mismatch");
  });

  test("rejects a missing database file", () => {
    const directory = temporaryDirectory("d490-vulnerability-db-missing-");
    const grypePath = join(directory, "grype.db");
    const trivyPath = join(directory, "trivy.db");
    writeFileSync(grypePath, "grype-db");
    writeFileSync(trivyPath, "trivy-db");
    const identity = databaseIdentity(grypePath, trivyPath);
    unlinkSync(trivyPath);

    expect(() => verifyVulnerabilityDatabaseIdentity(identity)).toThrow("missing or unreadable");
  });

  test("rejects malformed identity, including a mutable tag-like field", () => {
    const directory = temporaryDirectory("d490-vulnerability-db-malformed-");
    const grypePath = join(directory, "grype.db");
    const trivyPath = join(directory, "trivy.db");
    writeFileSync(grypePath, "grype-db");
    writeFileSync(trivyPath, "trivy-db");
    const identity = databaseIdentity(grypePath, trivyPath);
    const malformed = JSON.parse(JSON.stringify(identity)) as { databases: { grype: Record<string, unknown> } };
    malformed.databases.grype["tag"] = "latest";

    expect(() => parseVulnerabilityDatabaseIdentity(JSON.stringify(malformed))).toThrow(VulnerabilityDatabaseIdentityError);
  });
});
