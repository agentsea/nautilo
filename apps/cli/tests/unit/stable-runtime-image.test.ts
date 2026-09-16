import { afterEach, describe, expect, test } from "bun:test";

import {
  resolveStableRuntimeImageFromProduction,
  setStableRuntimeImageResolverForTests,
} from "../../src/lib/stable-runtime-image.ts";

const CANONICAL_IMAGE = `ghcr.io/agentsea/nautilo-runtime-v2@sha256:${"a".repeat(64)}`;

afterEach(() => {
  setStableRuntimeImageResolverForTests(undefined);
});

describe("stable runtime image selection", () => {
  test("extracts the canonical server digest from a verified stable release", async () => {
    const image = await resolveStableRuntimeImageFromProduction(async () => ({
      state: "verified",
      runtimeArtifact: { image: CANONICAL_IMAGE },
    } as never));

    expect(image).toBe(CANONICAL_IMAGE);
  });

  test("distinguishes unavailable and invalid stable release failures", async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(resolveStableRuntimeImageFromProduction(
      async () => ({ state: "missing" }),
    )).rejects.toThrow(/No signed stable Nautilo server release.*--image/);

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(resolveStableRuntimeImageFromProduction(
      async () => ({ state: "invalid" }),
    )).rejects.toThrow(/failed verification.*--image/);
  });

  test("keeps the compose driver's canonical image guard on the verified pointer", async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(resolveStableRuntimeImageFromProduction(async () => ({
      state: "verified",
      runtimeArtifact: {
        image: `ghcr.io/example/nautilo-runtime-v2@sha256:${"a".repeat(64)}`,
      },
    } as never))).rejects.toThrow(/Runtime image selection requires/);
  });
});
