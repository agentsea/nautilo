import { exists, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import {
  assertRuntimeImageEvidenceManifest,
  runtimeImageEvidenceRelativePath,
  writeRuntimeImageEvidence,
  type RuntimeImageEvidenceManifestV1,
} from "./runtime-image-evidence";

const SOURCE_SHA = "a".repeat(40);
const DOCKERFILE_SHA = `sha256:${"b".repeat(64)}`;
const IMAGE_DIGEST = `sha256:${"c".repeat(64)}`;
const BASE_DIGEST = `sha256:${"d".repeat(64)}`;

function manifest(overrides: Partial<RuntimeImageEvidenceManifestV1> = {}): RuntimeImageEvidenceManifestV1 {
  return {
    version: 1,
    sourceSha: SOURCE_SHA,
    dockerfileSha256: DOCKERFILE_SHA,
    baseImages: [{ role: "runtime", identity: `docker.io/library/bun@${BASE_DIGEST}` }],
    architecture: "linux/amd64",
    image: {
      digest: IMAGE_DIGEST,
      reference: `ghcr.io/agentsea/nautilo-runtime@${IMAGE_DIGEST}`,
      sizeBytes: 123_456_789,
    },
    tools: { docker: "28.0.0", buildx: "0.20.0" },
    databases: [
      { name: "postgres", identity: "postgresql://runtime-postgres/nautilo", version: "17.2" },
      { name: "logto", identity: "postgresql://runtime-postgres/logto", version: "1.28.0" },
    ],
    capturedAt: "2026-08-04T18:38:03.000Z",
    ...overrides,
  };
}

describe("RuntimeImageEvidenceManifestV1", () => {
  test("accepts complete immutable amd64 and arm64 manifests", () => {
    const amd64 = manifest();
    const arm64 = manifest({ architecture: "linux/arm64", image: { ...manifest().image, digest: `sha256:${"e".repeat(64)}`, reference: `ghcr.io/agentsea/nautilo-runtime@sha256:${"e".repeat(64)}` }, capturedAt: "2026-08-04T18:38:03Z" });

    expect(() => assertRuntimeImageEvidenceManifest(amd64)).not.toThrow();
    expect(() => assertRuntimeImageEvidenceManifest(arm64)).not.toThrow();
  });

  test("rejects mutable image and base-image authority", () => {
    expect(() => assertRuntimeImageEvidenceManifest(manifest({ image: { ...manifest().image, reference: "ghcr.io/agentsea/nautilo-runtime:latest" } }))).toThrow("immutable repository@sha256 authority");
    expect(() => assertRuntimeImageEvidenceManifest(manifest({ baseImages: [{ role: "runtime", identity: "docker.io/library/bun:latest" }] }))).toThrow("immutable repository@sha256 authority");
  });

  test("rejects an image reference whose digest differs from image.digest", () => {
    expect(() => assertRuntimeImageEvidenceManifest(manifest({ image: { ...manifest().image, reference: `ghcr.io/agentsea/nautilo-runtime@sha256:${"e".repeat(64)}` } }))).toThrow("must match image.digest");
  });

  test("rejects missing and malformed required fields", () => {
    const cases: unknown[] = [
      manifest({ sourceSha: "not-a-sha" }),
      manifest({ dockerfileSha256: `sha256:${"0".repeat(64)}` }),
      manifest({ architecture: "linux/s390x" as RuntimeImageEvidenceManifestV1["architecture"] }),
      manifest({ image: { ...manifest().image, sizeBytes: 0 } }),
      manifest({ tools: {} }),
      manifest({ databases: [] }),
      manifest({ capturedAt: "2026-08-04" }),
    ];

    for (const value of cases) expect(() => assertRuntimeImageEvidenceManifest(value)).toThrow();
  });

  test("derives deterministic and disjoint paths from all release identity axes", () => {
    const base = manifest();
    const changes = [
      manifest({ sourceSha: "f".repeat(40) }),
      manifest({ dockerfileSha256: `sha256:${"f".repeat(64)}` }),
      manifest({ architecture: "linux/arm64" }),
      manifest({ image: { ...base.image, digest: `sha256:${"e".repeat(64)}`, reference: `ghcr.io/agentsea/nautilo-runtime@sha256:${"e".repeat(64)}` } }),
    ];
    const basePath = runtimeImageEvidenceRelativePath(base);

    expect(runtimeImageEvidenceRelativePath(base)).toBe(basePath);
    for (const changed of changes) expect(runtimeImageEvidenceRelativePath(changed)).not.toBe(basePath);
  });

  test("writes a new manifest once and refuses the evidence collision", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-runtime-evidence-"));
    try {
      const evidence = manifest();
      const written = await writeRuntimeImageEvidence(root, evidence);

      expect(await exists(written.directory)).toBe(true);
      expect(JSON.parse(await readFile(written.manifestPath, "utf8"))).toEqual(evidence);
      await expect(writeRuntimeImageEvidence(root, evidence)).rejects.toThrow("collision");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
