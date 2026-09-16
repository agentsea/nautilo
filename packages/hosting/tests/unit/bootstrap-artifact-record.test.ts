import { describe, expect, test } from "bun:test";

import {
  parseBootstrapArtifactRecordJson,
  projectBootstrapImage,
  verifyBootstrapArtifactRecord,
} from "../../src";

const sourceSha = "e0f34a65d6a8cc59a9595f213569bd66cc05496d";
const manifestDigest = "sha256:d22aeb2da8fb79ea03ab1dac11e55f676bc4a2ad810a27540f4b448944aaed9c";
const approval = { sourceSha, manifestDigest } as const;

function record(): Record<string, unknown> {
  const evidenceDigest = "sha256:8ed31e93395fadb5adf23ba55d3676a046c2df63cb63a891d72cd92ac3386f5c";
  return {
    version: 1,
    sourceSha,
    image: `ghcr.io/agentsea/nautilo-bootstrap-runtime-v2@${manifestDigest}`,
    manifestDigest,
    architectures: {
      "linux/amd64": "sha256:f06b17dccd30013835b5e1289e279b3df42c0c71c5022c7f153fb5d039fad38a",
      "linux/arm64": "sha256:455a08396cea391acdd16a68fd072cc4a6612ed3b43d548a831cc805f1017336",
    },
    evidence: {
      sbom: evidenceDigest,
      vulnerabilities: evidenceDigest,
      disclosure: evidenceDigest,
      licenses: evidenceDigest,
      safeFailure: evidenceDigest,
    },
    compatibility: {
      execution: "One-shot nonroot database and Logto reconciliation; never a long-running customer service.",
      safeFailure: "Missing or invalid environment and unreachable databases exit non-zero with receipt-safe JSON and no secret values.",
      database: "Reconciliation is idempotent and retryable; promotion requires native missing-database safe-failure evidence.",
      rollback: "rerun-idempotently",
    },
  };
}

describe("D488 bootstrap artifact record receiving contract", () => {
  test("accepts and projects the exact public artifact from workflow 31720540036", () => {
    const result = verifyBootstrapArtifactRecord(record(), approval);
    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(result.code);
    expect(projectBootstrapImage(result.record)).toBe(
      `ghcr.io/agentsea/nautilo-bootstrap-runtime-v2@${manifestDigest}`,
    );
  });

  test("keeps the signed legacy bootstrap record admissible during namespace migration", () => {
    const legacy = { ...record(), image: `ghcr.io/agentsea/nautilo-bootstrap-runtime@${manifestDigest}` };
    expect(verifyBootstrapArtifactRecord(legacy, approval).ok).toBeTrue();
  });

  test("rejects mutable, retired, credential-bearing, and unapproved records", () => {
    expect(verifyBootstrapArtifactRecord({ ...record(), image: "ghcr.io/agentsea/nautilo-bootstrap-runtime-v2:main" }, approval).ok).toBeFalse();
    expect(verifyBootstrapArtifactRecord({ ...record(), image: `ghcr.io/agentsea/nautilo-bootstrap@${manifestDigest}` }, approval).ok).toBeFalse();
    expect(verifyBootstrapArtifactRecord({ ...record(), registryToken: "forbidden" }, approval).ok).toBeFalse();
    expect(verifyBootstrapArtifactRecord(record(), { ...approval, sourceSha: "a".repeat(40) }).ok).toBeFalse();
  });

  test("rejects missing evidence, inconsistent digests, incompatible contracts, and malformed JSON", () => {
    const missingEvidence = record();
    delete (missingEvidence["evidence"] as Record<string, unknown>)["safeFailure"];
    expect(verifyBootstrapArtifactRecord(missingEvidence, approval).ok).toBeFalse();
    expect(verifyBootstrapArtifactRecord({
      ...record(),
      architectures: { "linux/amd64": manifestDigest, "linux/arm64": "sha256:455a08396cea391acdd16a68fd072cc4a6612ed3b43d548a831cc805f1017336" },
    }, approval).ok).toBeFalse();
    expect(verifyBootstrapArtifactRecord({
      ...record(),
      compatibility: { ...(record()["compatibility"] as Record<string, unknown>), rollback: "replace" },
    }, approval).ok).toBeFalse();
    expect(parseBootstrapArtifactRecordJson("not-json", approval).ok).toBeFalse();
    expect(parseBootstrapArtifactRecordJson("x".repeat(64 * 1024 + 1), approval).ok).toBeFalse();
  });
});
