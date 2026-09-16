import { buildRegistryImageRef } from "@nautilo/compose-driver";

import { resolveServerProductionRelease } from "./server-release-source.ts";

type ProductionReleaseResolver = typeof resolveServerProductionRelease;
export type StableRuntimeImageResolver = () => Promise<string>;

/** Resolve the canonical server image selected by Nautilo's signed stable release channel. */
export async function resolveStableRuntimeImageFromProduction(
  resolveProductionRelease: ProductionReleaseResolver = resolveServerProductionRelease,
): Promise<string> {
  const release = await resolveProductionRelease();
  if (release.state === "missing") {
    throw new Error(
      "No signed stable Nautilo server release is currently available. Check network access and retry, or pass --image <immutable-digest>.",
    );
  }
  if (release.state !== "verified") {
    throw new Error(
      "The signed stable Nautilo server release manifest failed verification. Retry later or pass --image <immutable-digest>.",
    );
  }
  return buildRegistryImageRef(release.runtimeArtifact.image);
}

let stableRuntimeImageResolver: StableRuntimeImageResolver =
  resolveStableRuntimeImageFromProduction;

export function resolveStableRuntimeImage(): Promise<string> {
  return stableRuntimeImageResolver();
}

/** Test-only seam; production always uses the pinned-trust stable release resolver. */
export function setStableRuntimeImageResolverForTests(
  resolver: StableRuntimeImageResolver | undefined,
): void {
  stableRuntimeImageResolver = resolver ?? resolveStableRuntimeImageFromProduction;
}
