import { describe, expect, test } from "bun:test";
import {
  CANONICAL_RUNTIME_IMAGE,
  buildPinnedImageOverlay,
  buildRegistryImageRef,
  buildRegistryOverlay,
} from "../../src/buildRegistryOverlay.ts";

const canonicalImage = "ghcr.io/agentsea/nautilo-runtime-v2@sha256:74c76a08d65399d83f752cae76caa2bb4b0a4218e57f74ece87ac8a5a1c06ec1";

describe("buildRegistryOverlay", () => {
  test("emits the immutable public runtime image and clears the inherited build block", () => {
    const out = buildRegistryOverlay(canonicalImage);

    expect(out).toContain("nautilo-server:");
    expect(out).toContain(`image: ${canonicalImage}`);
    expect(out).toContain("build: !reset null");
    expect(out).not.toContain("context:");
    expect(out).not.toContain("dockerfile:");
  });

  test("accepts the canonical public digest verbatim", () => {
    expect(buildRegistryImageRef(canonicalImage)).toBe(canonicalImage);
  });

  test("keeps the legacy immutable namespace admissible during migration", () => {
    const legacy = canonicalImage.replace("nautilo-runtime-v2", "nautilo-runtime");
    expect(buildRegistryImageRef(legacy)).toBe(legacy);
  });

  test("rejects blank, mutable, and historical registry input", () => {
    expect(() => buildRegistryImageRef("   ")).toThrow(/requires ghcr\.io\/agentsea\/nautilo-runtime-v2@sha256/);
    expect(() => buildRegistryImageRef(`${CANONICAL_RUNTIME_IMAGE}:main`)).toThrow(/requires ghcr\.io\/agentsea\/nautilo-runtime-v2@sha256/);
    expect(() => buildRegistryImageRef("ghcr.io/agentsea/nautilo-server@sha256:74c76a08d65399d83f752cae76caa2bb4b0a4218e57f74ece87ac8a5a1c06ec1")).toThrow(/requires ghcr\.io\/agentsea\/nautilo-runtime-v2@sha256/);
    expect(() => buildRegistryImageRef("ghcrXio/agentsea/nautilo-runtime-v2@sha256:74c76a08d65399d83f752cae76caa2bb4b0a4218e57f74ece87ac8a5a1c06ec1")).toThrow(/requires ghcr\.io\/agentsea\/nautilo-runtime-v2@sha256/);
    expect(() => buildRegistryImageRef("ghcr.io/agentsea/nautilo-runtime-v2@sha256:74C76A08D65399D83F752CAE76CAA2BB4B0A4218E57F74ECE87AC8A5A1C06EC1")).toThrow(/requires ghcr\.io\/agentsea\/nautilo-runtime-v2@sha256/);
  });

  test("buildPinnedImageOverlay accepts a historical registry digest for restore", () => {
    const out = buildPinnedImageOverlay(
      "ghcr.io/agentsea/nautilo-server@sha256:abc",
    );

    expect(out).toContain(
      "image: ghcr.io/agentsea/nautilo-server@sha256:abc",
    );
    expect(out).toContain("build: !reset null");
  });

  test("buildPinnedImageOverlay accepts a source backup tag verbatim", () => {
    const out = buildPinnedImageOverlay("nautilo-server:backup-XYZ");

    expect(out).toContain("image: nautilo-server:backup-XYZ");
    expect(out).toContain("build: !reset null");
  });
});
