import { buildMiniApp, miniAppRuntimePayloadDigest, type SuccessfulMiniAppBuild } from "./app-builder";
import { scanInstalledApps, type RegisteredMiniApp } from "./app-registry";
import { resolveDefaultFirstPartyAppsRoot } from "./seed-first-party-apps";

export type MiniAppHostCapabilities = {
  assets?: true;
  assetReadRaster?: true;
  /** Bounded Desktop-local MP4 proxy preview; never a filesystem grant. */
  mediaProxy?: true;
  /** Parent-mediated paid-generation review; never iframe spend authority. */
  videoGeneration?: true;
};

const STATIC_FIRST_PARTY_CAPABILITIES: Readonly<Record<string, MiniAppHostCapabilities>> = {
  "nautilo-video": Object.freeze({ assetReadRaster: true, mediaProxy: true, videoGeneration: true }),
};

export interface FirstPartyHostCapabilityDeps {
  sourceRoot?: string;
  scanApps?: typeof scanInstalledApps;
  buildApp?: typeof buildMiniApp;
}

/**
 * Grants privileged host APIs only when the bytes about to execute are byte-
 * equivalent to a fresh build of Nautilo's shipped first-party source. A
 * manifest claim, app id, seed marker, or source hash cannot grant authority.
 */
export async function resolveFirstPartyHostCapabilities(
  installed: RegisteredMiniApp,
  installedBuild: SuccessfulMiniAppBuild,
  deps: FirstPartyHostCapabilityDeps = {},
): Promise<MiniAppHostCapabilities | undefined> {
  const declared = STATIC_FIRST_PARTY_CAPABILITIES[installed.id];
  if (!declared || installed.status !== "ready" || !installed.enabled || !installed.manifest) return undefined;

  try {
    const sourceRoot = deps.sourceRoot ?? resolveDefaultFirstPartyAppsRoot();
    const sourceApps = await (deps.scanApps ?? scanInstalledApps)(sourceRoot);
    const canonical = sourceApps.find((entry) => entry.id === installed.id);
    if (!canonical || canonical.status !== "ready" || !canonical.enabled || !canonical.manifest) return undefined;
    const canonicalBuild = await (deps.buildApp ?? buildMiniApp)(canonical, sourceRoot);
    if (!canonicalBuild.ok) return undefined;
    if (miniAppRuntimePayloadDigest(installedBuild) !== miniAppRuntimePayloadDigest(canonicalBuild)) return undefined;
    return declared;
  } catch {
    return undefined;
  }
}
