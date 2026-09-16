import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  parseRuntimeArtifactRecordJson,
  projectRuntimeImage,
  verifyRuntimeArtifactRecord,
} from "../../src";

const sourceSha = "cb4f605532d6e9b9903aa16531dbecae7b0cc46f";
const manifestDigest = "sha256:8b1b0c79b779da7dabe6ce8c508d2f97ca5a8e6bdbdfb66b4012db1a8029f461";
const amd64Digest = "sha256:661c310e4df92bbda5b0be53c130af8fed5f6963a015dff46131db24bb44c554";
const arm64Digest = "sha256:d1a235eba3dfdb42942471d11a1f44dfd2c97ec2af301d6760f7bbce564a164a";
const evidenceDigest = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

function artifactRecord(): Record<string, unknown> {
  return {
    version: 1,
    sourceSha,
    image: `ghcr.io/agentsea/nautilo-runtime-v2@${manifestDigest}`,
    manifestDigest,
    architectures: {
      "linux/amd64": amd64Digest,
      "linux/arm64": arm64Digest,
    },
    evidence: {
      sbom: evidenceDigest,
      vulnerabilities: evidenceDigest,
      disclosure: evidenceDigest,
      licenses: evidenceDigest,
      acceptance: evidenceDigest,
    },
    compatibility: {
      authContract: "Anonymous pull of ghcr.io/agentsea/nautilo-runtime-v2 by immutable digest; runtime requires configured Logto OIDC.",
      database: "This record adds no database migration; use the existing ComposeDriver migration-aware release transaction.",
      rollback: "full-bundle-required",
    },
  };
}

const approval = { sourceSha, manifestDigest } as const;

describe("D490 runtime artifact record receiving contract", () => {
  test("accepts the exact checked-in qualification handoff from D490 run 31946455462", () => {
    const bytes = readFileSync(new URL(
      "../../../../deploy/releases/qualification/runtime-artifact-record-v1.json",
      import.meta.url,
    ));
    const result = parseRuntimeArtifactRecordJson(bytes, {
      sourceSha,
      manifestDigest,
    });
    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(result.code);
    expect(result.record.image).toBe(`ghcr.io/agentsea/nautilo-runtime@${manifestDigest}`);
  });

  test("accepts the exact public D490 shape and projects only its immutable runtime digest", () => {
    const result = verifyRuntimeArtifactRecord(artifactRecord(), approval);
    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(result.code);
    expect(projectRuntimeImage(result.record)).toBe(`ghcr.io/agentsea/nautilo-runtime-v2@${manifestDigest}`);
    expect(result.record.architectures).toEqual({
      "linux/amd64": amd64Digest,
      "linux/arm64": arm64Digest,
    });
  });

  test("keeps the signed legacy runtime record admissible during namespace migration", () => {
    const legacy = artifactRecord();
    legacy["image"] = `ghcr.io/agentsea/nautilo-runtime@${manifestDigest}`;
    (legacy["compatibility"] as Record<string, unknown>)["authContract"] =
      "Anonymous pull of ghcr.io/agentsea/nautilo-runtime by immutable digest; runtime requires configured Logto OIDC.";
    expect(verifyRuntimeArtifactRecord(legacy, approval).ok).toBeTrue();
    (legacy["compatibility"] as Record<string, unknown>)["authContract"] =
      "Anonymous pull of ghcr.io/agentsea/nautilo-runtime-v2 by immutable digest; runtime requires configured Logto OIDC.";
    expect(verifyRuntimeArtifactRecord(legacy, approval)).toEqual({
      ok: false,
      code: "hosting.runtime-artifact.incompatible-contract",
    });
  });

  test("rejects legacy, mutable, credential-bearing, and unapproved source shapes", () => {
    expect(verifyRuntimeArtifactRecord({ ...artifactRecord(), image: "ghcr.io/agentsea/nautilo-runtime-v2:main" }, approval)).toEqual({
      ok: false,
      code: "hosting.runtime-artifact.unapproved-runtime",
    });
    expect(verifyRuntimeArtifactRecord({ ...artifactRecord(), image: `ghcr.io/agentsea/nautilo-server@${manifestDigest}` }, approval)).toEqual({
      ok: false,
      code: "hosting.runtime-artifact.unapproved-runtime",
    });
    expect(verifyRuntimeArtifactRecord({ ...artifactRecord(), registryToken: "must-never-be-accepted" }, approval)).toEqual({
      ok: false,
      code: "hosting.runtime-artifact.malformed",
    });
    expect(verifyRuntimeArtifactRecord({ ...artifactRecord(), sourceRepository: "agentsea/nautilo" }, approval)).toEqual({
      ok: false,
      code: "hosting.runtime-artifact.malformed",
    });
  });

  test("rejects missing evidence and manifest/platform digest inconsistency", () => {
    const withoutEvidence = artifactRecord();
    delete (withoutEvidence["evidence"] as Record<string, unknown>)["acceptance"];
    expect(verifyRuntimeArtifactRecord(withoutEvidence, approval)).toEqual({
      ok: false,
      code: "hosting.runtime-artifact.missing-evidence",
    });
    expect(verifyRuntimeArtifactRecord({
      ...artifactRecord(),
      architectures: { "linux/amd64": manifestDigest, "linux/arm64": arm64Digest },
    }, approval)).toEqual({
      ok: false,
      code: "hosting.runtime-artifact.inconsistent-digest",
    });
  });

  test("requires the independent approved source and manifest identity when supplied", () => {
    expect(verifyRuntimeArtifactRecord(artifactRecord(), undefined as never)).toEqual({
      ok: false,
      code: "hosting.runtime-artifact.unapproved-runtime",
    });
    expect(verifyRuntimeArtifactRecord(artifactRecord(), null as never)).toEqual({
      ok: false,
      code: "hosting.runtime-artifact.unapproved-runtime",
    });
    expect(verifyRuntimeArtifactRecord({ ...artifactRecord(), sourceSha: "c".repeat(40) }, approval)).toEqual({
      ok: false,
      code: "hosting.runtime-artifact.unapproved-runtime",
    });
    expect(verifyRuntimeArtifactRecord({
      ...artifactRecord(),
      image: `ghcr.io/agentsea/nautilo-runtime-v2@sha256:${"f".repeat(64)}`,
      manifestDigest: `sha256:${"f".repeat(64)}`,
    }, approval)).toEqual({
      ok: false,
      code: "hosting.runtime-artifact.unapproved-runtime",
    });
  });

  test("bounds JSON input and fails closed for malformed bytes", () => {
    expect(parseRuntimeArtifactRecordJson(JSON.stringify(artifactRecord()), approval).ok).toBeTrue();
    expect(parseRuntimeArtifactRecordJson("not-json", approval)).toEqual({
      ok: false,
      code: "hosting.runtime-artifact.malformed",
    });
    expect(parseRuntimeArtifactRecordJson("x".repeat(64 * 1024 + 1), approval)).toEqual({
      ok: false,
      code: "hosting.runtime-artifact.malformed",
    });
  });
});
