import { describe, expect, test } from "bun:test";
import { augmentChromiumSbom, assertChromiumSbomEvidence, chromiumCpe } from "./chromium-sbom.ts";
import artifacts from "./chromium-artifacts.json";
import type { RuntimeImageEvidenceManifestV1 } from "./runtime-image-evidence.ts";

const image = { digest: `sha256:${"a".repeat(64)}`, reference: `registry.example/server@sha256:${"a".repeat(64)}`, sizeBytes: 100 };
const manifest = { sourceSha: "b".repeat(40), architecture: "linux/arm64", image } as RuntimeImageEvidenceManifestV1;
const pin = artifacts.targets["linux/arm64"];
const raw = JSON.stringify({ artifacts: [{ id: "existing", name: "libc6", version: "2.41", type: "deb" }], artifactRelationships: [{ parent: "existing", child: "file" }], files: [{ id: "file" }], source: { version: image.digest }, descriptor: { name: "syft" }, schema: { version: "16.1.10" } });
function observation() {
  return { platform: "linux", arch: "arm64", executableSha256: pin.executableSha256,
    elf: { class: 64, endianness: "little", machine: 183 },
    receipt: { schemaVersion: 1, version: artifacts.version, platform: "linux/arm64", archiveSha256: pin.sha256, executableSha256: pin.executableSha256, url: pin.url } };
}

describe("source-pinned Chromium SBOM", () => {
  test("adds explicit Chrome CPE without changing any existing inventory", () => {
    const sbom = augmentChromiumSbom(raw, manifest, observation());
    const original = JSON.parse(raw);
    expect((sbom["artifacts"] as unknown[]).slice(0, -1)).toEqual(original.artifacts);
    for (const key of ["artifactRelationships", "files", "source", "descriptor", "schema"]) expect(sbom[key]).toEqual(original[key]);
    expect((sbom["artifacts"] as unknown[]).at(-1)).toMatchObject({ name: "google-chrome", version: artifacts.version, type: "binary", cpes: [{ cpe: chromiumCpe(artifacts.version) }] });
    expect(() => assertChromiumSbomEvidence(sbom, manifest)).not.toThrow();
  });

  test.each(["platform", "hash", "receipt", "ELF"])("rejects wrong %s evidence", (field) => {
    const probe = observation();
    if (field === "platform") probe.arch = "x64";
    if (field === "hash") probe.executableSha256 = "0".repeat(64);
    if (field === "receipt") probe.receipt.archiveSha256 = "0".repeat(64);
    if (field === "ELF") probe.elf.machine = 62;
    expect(() => augmentChromiumSbom(raw, manifest, probe)).toThrow("Chromium SBOM evidence");
  });

  test("rejects a modified receipt URL or version", () => {
    for (const field of ["url", "version"] as const) {
      const probe = observation();
      probe.receipt[field] = "wrong";
      expect(() => augmentChromiumSbom(raw, manifest, probe)).toThrow("receipt");
    }
  });

  test("release validation rejects missing proof, CPE, platform, or image binding", () => {
    for (const field of ["proof", "cpe", "platform", "image"] as const) {
      const sbom = augmentChromiumSbom(raw, manifest, observation());
      const proof = sbom["nautiloChromium"] as Record<string, unknown>;
      if (field === "proof") delete sbom["nautiloChromium"];
      if (field === "cpe") ((sbom["artifacts"] as Record<string, unknown>[]).at(-1)!)["cpes"] = [];
      if (field === "platform") proof["verification"] = {};
      if (field === "image") proof["image"] = { ...image, digest: `sha256:${"c".repeat(64)}` };
      expect(() => assertChromiumSbomEvidence(sbom, manifest)).toThrow("Chromium SBOM evidence");
    }
  });

  test("rejects augmentation of an already augmented SBOM", () => {
    const augmented = augmentChromiumSbom(raw, manifest, observation());
    expect(() => augmentChromiumSbom(JSON.stringify(augmented), manifest, observation())).toThrow("already contains");
  });
});
