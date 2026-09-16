/**
 * M088B — pure helpers from `generate-image.tsx`. The renderer no
 * longer ships thumbnails (server-side bytes API is M088C); the card
 * is a structured list of {artifactId, path, mime, bytes} rows. Live
 * UI is verified in Electron.
 */

import { describe, expect, test } from "bun:test";
import {
  formatBytes,
  formatFooterText,
  parseEnvelope,
  resolveGeneratedImages,
  type GenerateImageEnvelope,
} from "../../src/components/tool-card/renderers/generate-image";

function makeEnv(over: Partial<GenerateImageEnvelope> = {}): GenerateImageEnvelope {
  return {
    images: over.images ?? [
      {
        artifactId: "11111111-1111-1111-1111-111111111111",
        path: "generated-images/2026-05-08/foo-01.png",
        zone: "workspace",
        mime: "image/png",
        bytes: 100,
      },
    ],
    model: over.model ?? "openai:gpt-image-2",
    provider: over.provider ?? "openai",
    prompt: over.prompt ?? "test",
  };
}

describe("parseEnvelope", () => {
  test("happy path returns full M088B envelope", () => {
    const env = makeEnv();
    const raw = JSON.stringify(env);
    expect(parseEnvelope(raw)).toEqual(env);
  });

  test("rejects undefined / empty / non-JSON", () => {
    expect(parseEnvelope(undefined)).toBeNull();
    expect(parseEnvelope("")).toBeNull();
    expect(parseEnvelope("   ")).toBeNull();
    expect(parseEnvelope("not json")).toBeNull();
  });

  test("rejects object missing images", () => {
    expect(
      parseEnvelope(
        JSON.stringify({ model: "m", provider: "p", prompt: "x" }),
      ),
    ).toBeNull();
  });

  test("rejects image missing artifactId (M088B contract)", () => {
    expect(
      parseEnvelope(
        JSON.stringify({
          model: "m",
          provider: "p",
          prompt: "x",
          images: [{ path: "p", zone: "workspace", mime: "image/png", bytes: 1 }],
        }),
      ),
    ).toBeNull();
  });

  test("rejects legacy D113 envelope (workspaceRoot + absolutePath, no artifactId)", () => {
    expect(
      parseEnvelope(
        JSON.stringify({
          model: "m",
          provider: "p",
          prompt: "x",
          workspaceRoot: "/tmp/work",
          images: [
            {
              path: "p",
              absolutePath: "/tmp/work/p",
              zone: "workspace",
              mime: "image/png",
              bytes: 1,
            },
          ],
        }),
      ),
    ).toBeNull();
  });

  test("rejects image with non-workspace zone", () => {
    expect(
      parseEnvelope(
        JSON.stringify({
          model: "m",
          provider: "p",
          prompt: "x",
          images: [
            {
              artifactId: "id",
              path: "p",
              zone: "scratch",
              mime: "image/png",
              bytes: 1,
            },
          ],
        }),
      ),
    ).toBeNull();
  });

  test("accepts four-image envelope", () => {
    const env = makeEnv({
      images: [0, 1, 2, 3].map((k) => ({
        artifactId: `aaaaaaaa-aaaa-aaaa-aaaa-00000000000${k}`,
        path: `generated-images/2026-05-08/foo-0${k}.png`,
        zone: "workspace" as const,
        mime: "image/png",
        bytes: 100,
      })),
    });
    expect(parseEnvelope(JSON.stringify(env))).toEqual(env);
  });
});

describe("formatFooterText", () => {
  test("one workspace image path", () => {
    const t = formatFooterText(makeEnv());
    expect(t).toContain("1 image saved to workspace/generated-images/2026-05-08/");
  });

  test("three images plural", () => {
    const env = makeEnv({
      images: [1, 2, 3].map((k) => ({
        artifactId: `bbbbbbbb-bbbb-bbbb-bbbb-00000000000${k}`,
        path: `generated-images/2026-05-08/foo-0${k}.png`,
        zone: "workspace" as const,
        mime: "image/png",
        bytes: 100,
      })),
    });
    const t = formatFooterText(env);
    expect(t).toContain("3 images saved to workspace/generated-images/2026-05-08/");
  });
});

describe("formatBytes", () => {
  test("renders B / KB / MB", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(204)).toBe("204 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(700 * 1024)).toBe("700 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(1.4 * 1024 * 1024)).toBe("1.4 MB");
  });

  test("guards against negative / NaN", () => {
    expect(formatBytes(-1)).toBe("—");
    expect(formatBytes(Number.NaN)).toBe("—");
  });
});

describe("resolveGeneratedImages", () => {
  test("uses the external artifact id before a matching path", () => {
    const [resolved] = resolveGeneratedImages(makeEnv().images, [
      {
        id: "internal-by-path",
        artifactId: "another-artifact",
        path: "generated-images/2026-05-08/foo-01.png",
        mimeType: "image/webp",
      },
      {
        id: "internal-by-external-id",
        artifactId: "11111111-1111-1111-1111-111111111111",
        path: "generated-images/2026-05-08/renamed.png",
        mimeType: "image/png",
      },
    ]);

    expect(resolved).toMatchObject({
      internalId: "internal-by-external-id",
      resolvedPath: "generated-images/2026-05-08/renamed.png",
      resolvedMime: "image/png",
    });
  });

  test("falls back to a logical-path match for compatibility", () => {
    const [resolved] = resolveGeneratedImages(makeEnv().images, [
      {
        id: "internal-by-path",
        artifactId: "different-external-id",
        path: "generated-images/2026-05-08/foo-01.png",
        mimeType: "image/webp",
      },
    ]);

    expect(resolved).toMatchObject({
      internalId: "internal-by-path",
      resolvedPath: "generated-images/2026-05-08/foo-01.png",
      resolvedMime: "image/webp",
    });
  });

  test("keeps envelope metadata when no readable artifact is found", () => {
    const [resolved] = resolveGeneratedImages(makeEnv().images, []);

    expect(resolved).toMatchObject({
      internalId: null,
      resolvedPath: "generated-images/2026-05-08/foo-01.png",
      resolvedMime: "image/png",
    });
  });
});
