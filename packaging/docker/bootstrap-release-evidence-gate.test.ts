import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { evaluateBootstrapArchitectureEvidence } from "./bootstrap-release-evidence-gate.ts";
import { createExactImageEvidenceFixture } from "./exact-image-evidence-fixture.test.ts";

function fixture(): { directory: string; nativeProbe: string } {
  return createExactImageEvidenceFixture({
    architecture: "linux/arm64",
    kind: "bootstrap",
  });
}

describe("D488 bootstrap architecture evidence gate", () => {
  test("accepts the exact package closure and native safe-failure evidence", () => {
    const input = fixture();
    const receipt = evaluateBootstrapArchitectureEvidence(input.directory, input.nativeProbe);
    expect(receipt.passed).toBeTrue();
    expect(receipt.packageCount).toBe(7);
    expect(receipt.executionMode).toBe("native");
  });

  test("rejects public or mutable image identity before promotion", () => {
    const publicImage = fixture();
    const manifestPath = join(publicImage.directory, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      image: { digest: string; reference: string };
    };
    manifest.image.reference = `ghcr.io/agentsea/nautilo-bootstrap-runtime@${manifest.image.digest}`;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    expect(() => evaluateBootstrapArchitectureEvidence(publicImage.directory, publicImage.nativeProbe))
      .toThrow("immutable private bootstrap staging digest");

    const mutableImage = fixture();
    const mutableManifestPath = join(mutableImage.directory, "manifest.json");
    const mutableManifest = JSON.parse(readFileSync(mutableManifestPath, "utf8")) as {
      image: { reference: string };
    };
    mutableManifest.image.reference = "ghcr.io/agentsea/nautilo-bootstrap-staging:latest";
    writeFileSync(mutableManifestPath, `${JSON.stringify(mutableManifest, null, 2)}\n`);
    expect(() => evaluateBootstrapArchitectureEvidence(mutableImage.directory, mutableImage.nativeProbe))
      .toThrow("immutable repository@sha256 authority");
  });

  test("rejects package drift, non-native execution, and incomplete safe-failure evidence", () => {
    const packageDrift = fixture();
    const index = JSON.parse(readFileSync(join(packageDrift.directory, "report-index.json"), "utf8")) as {
      reports: Array<{ type: string; path: string; sizeBytes: number; sha256: string }>;
    };
    const sbom = index.reports.find((entry) => entry.type === "sbom")!;
    const sbomPath = join(packageDrift.directory, sbom.path);
    const value = JSON.parse(readFileSync(sbomPath, "utf8")) as { artifacts: unknown[] };
    value.artifacts.push({ name: "bash", version: "fixture", type: "deb" });
    const contents = `${JSON.stringify(value, null, 2)}\n`;
    writeFileSync(sbomPath, contents);
    sbom.sizeBytes = Buffer.byteLength(contents);
    sbom.sha256 = `sha256:${createHash("sha256").update(contents).digest("hex")}`;
    writeFileSync(join(packageDrift.directory, "report-index.json"), `${JSON.stringify(index, null, 2)}\n`);
    expect(() => evaluateBootstrapArchitectureEvidence(packageDrift.directory, packageDrift.nativeProbe)).toThrow("package closure changed");

    const emulated = fixture();
    const probe = JSON.parse(readFileSync(emulated.nativeProbe, "utf8")) as Record<string, unknown>;
    probe.executionMode = "emulated";
    writeFileSync(emulated.nativeProbe, `${JSON.stringify(probe, null, 2)}\n`);
    expect(() => evaluateBootstrapArchitectureEvidence(emulated.directory, emulated.nativeProbe)).toThrow("execution mode");

    const unsafe = fixture();
    const unsafeProbe = JSON.parse(readFileSync(unsafe.nativeProbe, "utf8")) as { probe: Record<string, unknown> };
    unsafeProbe.probe.invalidMode = { status: "succeeded" };
    writeFileSync(unsafe.nativeProbe, `${JSON.stringify(unsafeProbe, null, 2)}\n`);
    expect(() => evaluateBootstrapArchitectureEvidence(unsafe.directory, unsafe.nativeProbe)).toThrow("safe-failure evidence");
  });
});
