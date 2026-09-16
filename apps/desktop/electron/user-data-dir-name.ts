/**
 * Stack 19 Phase 4 (D156 Architecture amendment 2026-05-16).
 *
 * Pure helper: compute the `userData` directory BASENAME (NOT full path)
 * for a given `(instance, profile)` tuple.
 *
 * Naming formula:
 *
 *   ${appName}${instanceSuffix}${profileSuffix}
 *
 * where:
 *   ${appName}         = "Nautilo" (constant; matches app.setName in main.ts)
 *   ${instanceSuffix}  = "" for the default instance, else "-${instanceId}"
 *   ${profileSuffix}   = "" for the default profile, else "-${profile}"
 *
 * Default+default tuple collapses to the bare `Nautilo` basename, which
 * means existing operators (early operators — the only two pre-Stack-19
 * users) have their default-instance state preserved by the same path
 * they were already using.
 *
 * Examples:
 *
 *   computeUserDataDirName({appName: "Nautilo", instanceId: "",
 *     isDefaultInstance: true, profile: undefined})
 *   => "Nautilo"
 *
 *   computeUserDataDirName({appName: "Nautilo", instanceId: "smoke-stack19",
 *     isDefaultInstance: false, profile: undefined})
 *   => "Nautilo-smoke-stack19"
 *
 *   computeUserDataDirName({appName: "Nautilo", instanceId: "",
 *     isDefaultInstance: true, profile: "galina"})
 *   => "Nautilo-galina"
 *
 *   computeUserDataDirName({appName: "Nautilo", instanceId: "smoke-stack19",
 *     isDefaultInstance: false, profile: "galina"})
 *   => "Nautilo-smoke-stack19-galina"
 *
 * Lives in its own module — and consumes only primitives — so unit tests
 * can pin the 4-way (instance × profile) matrix without standing up Electron.
 * `apps/desktop/electron/main.ts` and `bin/nautilo-dev/src/commands/nuke-client-cache.ts`
 * both call this helper so the formula lives in ONE place, no parallel
 * resolution logic.
 */

export interface ComputeUserDataDirNameInput {
  /** Application name. In production this is always `"Nautilo"` (constant). */
  appName: string;
  /** Instance id from `resolveInstance()`. Empty string is the default. */
  instanceId: string;
  /**
   * Whether `instanceId` represents the default instance. Callers pass this
   * explicitly rather than recomputing here — the empty-string convention
   * is enforced by `@nautilo/config`'s `resolveInstance()` contract, but
   * threading the boolean keeps this helper pure and avoids hidden coupling.
   */
  isDefaultInstance: boolean;
  /** Profile name from `parseProfileFromArgv()`, or `undefined` for default. */
  profile: string | undefined;
}

/**
 * Compose the userData directory basename per the Stack 19 formula.
 *
 * Treats empty-string `profile` as "no profile" (defensive — `parseProfileFromArgv`
 * already returns `undefined` for absent flag, but a malformed `--profile ""`
 * should not yield a trailing dash).
 */
export function computeUserDataDirName(input: ComputeUserDataDirNameInput): string {
  const instanceSuffix =
    input.isDefaultInstance || input.instanceId === ""
      ? ""
      : `-${input.instanceId}`;
  const profileSuffix =
    input.profile === undefined || input.profile === ""
      ? ""
      : `-${input.profile}`;
  return `${input.appName}${instanceSuffix}${profileSuffix}`;
}
