/**
 * D103 — production updater eligibility.
 *
 * This is deliberately a small pure policy rather than a runtime setting.
 * The signed release workflow stamps only ordinary `X.Y.Z` releases with a
 * stable version. Development, manual diagnostic, and unsigned QA packages
 * retain `0.0.0-dev` or receive an `-rc.N` version, so they remain inert even
 * when they are packaged. There is intentionally no environment, command-line,
 * server, profile, IPC, or renderer escape hatch that can enable the feed.
 */
import type { UpdaterDisabledReason } from "./updater";

const STABLE_RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export interface ProductionUpdaterEligibilityInput {
  readonly isPackaged: boolean;
  readonly version: string;
  /** Test runners must never exercise the concrete platform updater. */
  readonly isTest: boolean;
}

export type ProductionUpdaterEligibility = Readonly<{
  enabled: boolean;
  disabledReason: UpdaterDisabledReason | null;
}>;

/**
 * Returns true only for a packaged stable version produced by the protected
 * signed-release route. This is an enablement gate, not an integrity check:
 * electron-updater validates the signed update artifact before installation.
 */
export function resolveProductionUpdaterEligibility(
  input: ProductionUpdaterEligibilityInput,
): ProductionUpdaterEligibility {
  if (input.isTest) return { enabled: false, disabledReason: "test" };
  if (!input.isPackaged) return { enabled: false, disabledReason: "unpackaged" };
  if (!STABLE_RELEASE_VERSION.test(input.version)) {
    return { enabled: false, disabledReason: "development" };
  }
  return { enabled: true, disabledReason: null };
}
