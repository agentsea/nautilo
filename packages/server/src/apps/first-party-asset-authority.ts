import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { computeAppSourceHash } from "./app-registry";

const ASSET_AUTHORITY_SOURCE_DIRS = {
  "nautilo-design": "design",
  "nautilo-presentation": "presentation",
  "nautilo-board": "board",
} as const;

export type FirstPartyAssetSourceIdentity = Readonly<{
  appId: string;
  appRoot: string;
  sourceHash: string;
}>;

export type FirstPartyAssetAuthorityDependencies = Readonly<{
  canonicalAppRoot?: string;
  /** Backward-compatible test seam for the original Design-only verifier. */
  canonicalDesignRoot?: string;
  computeSourceHash?: typeof computeAppSourceHash;
}>;

/**
 * Server-owned privilege check for bundled first-party visual-authoring apps.
 *
 * The app id is only a selector. Authority requires both the exact source hash
 * used to build the running worker and the current installed source tree to
 * match the corresponding bundled canonical app source. A copied/edited app with the same
 * manifest id therefore cannot acquire the first-party bridge.
 */
export async function hasFirstPartyAssetAuthority(
  identity: FirstPartyAssetSourceIdentity,
  dependencies: FirstPartyAssetAuthorityDependencies = {},
): Promise<boolean> {
  if (
    !Object.hasOwn(ASSET_AUTHORITY_SOURCE_DIRS, identity.appId) ||
    !/^[a-f0-9]{64}$/u.test(identity.sourceHash)
  ) {
    return false;
  }
  const computeSourceHash = dependencies.computeSourceHash ?? computeAppSourceHash;
  const sourceDir = ASSET_AUTHORITY_SOURCE_DIRS[
    identity.appId as keyof typeof ASSET_AUTHORITY_SOURCE_DIRS
  ];
  const canonicalAppRoot = dependencies.canonicalAppRoot ?? dependencies.canonicalDesignRoot ?? join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "first-party-apps",
    sourceDir,
  );
  try {
    const [canonicalHash, installedHash] = await Promise.all([
      computeSourceHash(canonicalAppRoot),
      computeSourceHash(identity.appRoot),
    ]);
    return identity.sourceHash === canonicalHash && installedHash === canonicalHash;
  } catch {
    return false;
  }
}
