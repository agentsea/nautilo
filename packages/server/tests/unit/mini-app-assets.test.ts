import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { Artifact } from "@nautilo/db";
import sharp from "sharp";
import {
  formatMiniAppAssetRef,
  inspectWorkspaceRasterAsset,
  parseMiniAppAssetRef,
  resolveMiniAppAssetReferencesInSvg,
  resolveWorkspaceRasterAsset,
} from "../../src/apps/mini-app-assets";
import { validateResourceFreeSvg } from "../../src/apps/svg-raster";

const ID = "11111111-1111-4111-8111-111111111111";

function artifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: ID,
    artifactId: "external-image-id",
    path: "assets/portrait.png",
    mimeType: "image/png",
    size: 0,
    storageUri: "file:///workspace/image",
    revision: 1,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    deletedAt: null,
    ...overrides,
  };
}

async function png(width = 3, height = 2): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: "#2563eb" } }).png().toBuffer();
}

function pinned(bytes: Uint8Array): string {
  return `artifact:${ID}:${createHash("sha256").update(bytes).digest("hex")}`;
}

describe("mini-app raster assets", () => {
  test("parses only the canonical pinned reference grammar", async () => {
    const bytes = await png();
    const ref = pinned(bytes);
    expect(parseMiniAppAssetRef(ref)).toEqual({ artifactId: ID, sha256: ref.slice(-64) });
    expect(formatMiniAppAssetRef(ID, ref.slice(-64))).toBe(ref);
    expect(parseMiniAppAssetRef(ref.toUpperCase())).toBeNull();
    expect(parseMiniAppAssetRef(`artifact:${ID}:../${"a".repeat(64)}`)).toBeNull();
  });

  test("inspects a known authorized artifact and returns metadata without bytes", async () => {
    const bytes = await png(7, 5);
    const calls: unknown[] = [];
    const result = await inspectWorkspaceRasterAsset(ID, ["ns-design"], {
      findArtifact: async (input) => { calls.push(input); return artifact({ size: bytes.byteLength }); },
      readArtifactBytes: async () => bytes,
    });
    expect(result).toEqual({
      ok: true,
      ref: pinned(bytes),
      name: "portrait.png",
      width: 7,
      height: 5,
    });
    expect(calls).toEqual([{ internalId: ID, readableNamespaceIds: ["ns-design"] }]);
    expect(JSON.stringify(result)).not.toContain(bytes.toString("base64"));
  });

  test.each(["jpeg", "webp"] as const)("strictly decodes and normalizes a static %s", async (format) => {
    const source = sharp({ create: { width: 5, height: 4, channels: 3, background: "#16a34a" } });
    const bytes = format === "jpeg" ? await source.jpeg().toBuffer() : await source.webp().toBuffer();
    const result = await resolveWorkspaceRasterAsset(pinned(bytes), ["ns-1"], {
      findArtifact: async () => artifact({ mimeType: `image/${format}`, size: bytes.byteLength }),
      readArtifactBytes: async () => bytes,
    });
    expect(result).toMatchObject({ ok: true, width: 5, height: 4 });
    if (!result.ok) return;
    expect(await sharp(result.pngBytes).metadata()).toMatchObject({ format: "png", width: 5, height: 4 });
  });

  test("applies JPEG EXIF orientation before publishing dimensions or normalized pixels", async () => {
    const bytes = await sharp({
      create: { width: 5, height: 3, channels: 3, background: "#16a34a" },
    }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    expect(await sharp(bytes).metadata()).toMatchObject({ width: 5, height: 3, orientation: 6 });

    const result = await resolveWorkspaceRasterAsset(pinned(bytes), ["ns-1"], {
      findArtifact: async () => artifact({ mimeType: "image/jpeg", size: bytes.byteLength }),
      readArtifactBytes: async () => bytes,
    });

    expect(result).toMatchObject({ ok: true, width: 3, height: 5 });
    if (!result.ok) return;
    expect(await sharp(result.pngBytes).metadata()).toMatchObject({
      format: "png",
      width: 3,
      height: 5,
    });
  });

  test("does not distinguish missing from unauthorized and detects changed bytes", async () => {
    const original = await png(2, 2);
    const changed = await png(4, 1);
    expect(await resolveWorkspaceRasterAsset(pinned(original), ["ns-1"], {
      findArtifact: async () => null,
    })).toMatchObject({ ok: false, code: "ASSET_NOT_FOUND" });
    expect(await resolveWorkspaceRasterAsset(pinned(original), ["ns-1"], {
      findArtifact: async () => artifact(),
      readArtifactBytes: async () => changed,
    })).toMatchObject({ ok: false, code: "ASSET_CHANGED" });
  });

  test("rejects spoofed and animated raster bytes before emitting a PNG", async () => {
    const spoof = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>");
    expect(await resolveWorkspaceRasterAsset(pinned(spoof), ["ns-1"], {
      findArtifact: async () => artifact({ mimeType: "image/png" }),
      readArtifactBytes: async () => spoof,
    })).toMatchObject({ ok: false, code: "UNSUPPORTED_ASSET_FORMAT" });

    const animatedHeader = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([0, 0, 0, 0]), Buffer.from("acTL"), Buffer.alloc(4),
    ]);
    expect(await resolveWorkspaceRasterAsset(pinned(animatedHeader), ["ns-1"], {
      findArtifact: async () => artifact(),
      readArtifactBytes: async () => animatedHeader,
    })).toMatchObject({ ok: false, code: "ANIMATED_ASSET_UNSUPPORTED" });

    const animatedWebpHeader = Buffer.alloc(30);
    animatedWebpHeader.write("RIFF", 0, "ascii");
    animatedWebpHeader.writeUInt32LE(22, 4);
    animatedWebpHeader.write("WEBP", 8, "ascii");
    animatedWebpHeader.write("VP8X", 12, "ascii");
    animatedWebpHeader.writeUInt32LE(10, 16);
    animatedWebpHeader[20] = 0x02;
    expect(await resolveWorkspaceRasterAsset(pinned(animatedWebpHeader), ["ns-1"], {
      findArtifact: async () => artifact({ mimeType: "image/webp" }),
      readArtifactBytes: async () => animatedWebpHeader,
    })).toMatchObject({ ok: false, code: "ANIMATED_ASSET_UNSUPPORTED" });
  });

  test("resolves canonical SVG image refs to host-owned transient PNG data", async () => {
    const bytes = await png(3, 2);
    const resolved = await resolveWorkspaceRasterAsset(pinned(bytes), ["ns-1"], {
      findArtifact: async () => artifact({ size: bytes.byteLength }),
      readArtifactBytes: async () => bytes,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const source =
      `<svg xmlns="http://www.w3.org/2000/svg" width="6" height="4">` +
      `<image href="nautilo-asset:${resolved.ref}" x="0" y="0" width="6" height="4" preserveAspectRatio="xMidYMid meet"/>` +
      `</svg>`;
    const prepared = await resolveMiniAppAssetReferencesInSvg(source, async () => resolved);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.svg).toContain('href="data:image/png;base64,');
    expect(prepared.svg).not.toContain("nautilo-asset:");
    expect(() => validateResourceFreeSvg(prepared.svg, {
      isHostResolvedPngDataUrl: (href) => prepared.approvedPngDataUrls.has(href),
    })).not.toThrow();
    expect(() => validateResourceFreeSvg(prepared.svg)).toThrow(/host-resolved PNG/u);
  });

  test.each([
    ["raw data", "data:image/png;base64,AAAA"],
    ["network", "https://example.com/a.png"],
    ["filesystem", "file:///etc/passwd"],
  ])("rejects %s image resources", async (_name, href) => {
    const source = `<svg xmlns="http://www.w3.org/2000/svg"><image href="${href}"/></svg>`;
    expect(await resolveMiniAppAssetReferencesInSvg(source, async () => {
      throw new Error("resolver must not run");
    })).toMatchObject({ ok: false, code: "INVALID_SVG_ASSET_REFERENCE" });
  });

  test("preserves text and permits only bundled inline font resources", async () => {
    const source =
      '<svg xmlns="http://www.w3.org/2000/svg"><style>' +
      '@font-face{font-family:"Nautilo Noto Sans";src:url(data:font/ttf;base64,AA==) format("truetype")}' +
      '</style><text>Ordinary text</text></svg>';
    const prepared = await resolveMiniAppAssetReferencesInSvg(source, async () => {
      throw new Error("resolver must not run");
    });
    expect(prepared).toMatchObject({ ok: true, svg: source });
    expect(await resolveMiniAppAssetReferencesInSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(https://example.com/x.css)</style></svg>',
      async () => { throw new Error("resolver must not run"); },
    )).toMatchObject({ ok: false, code: "INVALID_SVG_ASSET_REFERENCE" });
  });

  test("rejects malformed XML and active SVG elements atomically", async () => {
    expect(await resolveMiniAppAssetReferencesInSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><g></svg>',
      async () => { throw new Error("resolver must not run"); },
    )).toMatchObject({ ok: false, code: "INVALID_SVG_ASSET_REFERENCE" });
    expect(await resolveMiniAppAssetReferencesInSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      async () => { throw new Error("resolver must not run"); },
    )).toMatchObject({ ok: false, code: "INVALID_SVG_ASSET_REFERENCE" });
  });
});
