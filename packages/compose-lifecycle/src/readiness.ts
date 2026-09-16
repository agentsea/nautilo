import type { ComposeDriverDeps, ComposeDriverProfile } from "@nautilo/compose-driver";

export type ComposeOperatorFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface BuildComposeReleaseReadinessOptions {
  readonly fetch: ComposeOperatorFetch;
  readonly resolveServerUrl: (profile: ComposeDriverProfile) => string;
  readonly home: string;
  readonly readBootstrapToken: (profileName: string, home: string) => string | null;
}

type ReleaseReadinessSummary = {
  readonly runningJobs: number;
  readonly queuedTurns: number;
  readonly bufferedLanes: number;
};

export function buildComposeReleaseReadiness(
  options: BuildComposeReleaseReadinessOptions,
): NonNullable<ComposeDriverDeps["assertReleaseActiveWorkReady"]> {
  return async (profile) => {
    let serverUrl: string;
    try {
      serverUrl = options.resolveServerUrl(profile);
    } catch (error) {
      throw new Error(
        `nautilo upgrade readiness preflight failed closed: could not resolve server URL: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    let response: Response;
    try {
      const bearer = profile.transport === "local"
        ? options.readBootstrapToken(profile.name, options.home)
        : null;
      response = await options.fetch(
        `${serverUrl.replace(/\/+$/, "")}/api/operator/release/readiness`,
        bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {},
      );
    } catch (error) {
      throw new Error(
        `nautilo upgrade readiness preflight failed closed: operator endpoint is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok) {
      throw new Error(
        `nautilo upgrade readiness preflight failed closed: operator endpoint returned HTTP ${response.status}.`,
      );
    }
    let summary: ReleaseReadinessSummary;
    try {
      summary = (await response.json()) as ReleaseReadinessSummary;
    } catch {
      throw new Error(
        "nautilo upgrade readiness preflight failed closed: operator endpoint returned invalid JSON.",
      );
    }
    const counts = [summary.runningJobs, summary.queuedTurns, summary.bufferedLanes];
    if (!counts.every((count) => Number.isSafeInteger(count) && count >= 0)) {
      throw new Error(
        "nautilo upgrade readiness preflight failed closed: operator endpoint returned invalid work counts.",
      );
    }
    if (counts.some((count) => count > 0)) {
      throw new Error(
        `nautilo upgrade refused: active work remains (runningJobs=${summary.runningJobs}, queuedTurns=${summary.queuedTurns}, bufferedLanes=${summary.bufferedLanes}).`,
      );
    }
  };
}
