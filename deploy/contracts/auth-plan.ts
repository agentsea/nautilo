import type { AppliedAuthContract } from "./applied-auth-contract.ts";
import type { AuthContract } from "./auth.ts";

export const AUTH_PLAN_CLASSIFICATIONS = [
  "compatible",
  "reconcile-required-additive",
  "session-disruptive",
  "unknown",
  "incompatible",
] as const;

export type AuthPlanClassification = (typeof AUTH_PLAN_CLASSIFICATIONS)[number];

export type AuthPlanReport = Readonly<{
  classification: AuthPlanClassification;
  incoming: Pick<AuthContract, "version" | "hash" | "logtoEngine" | "impact">;
  applied: AppliedAuthContract | null;
  live: Readonly<{
    logtoEngineImage: string | null;
    logtoEngineVersion: string | null;
    inspected: boolean;
  }>;
  reasons: readonly string[];
  limitations: readonly string[];
}>;

export type AuthPlanInput = Readonly<{
  incoming: AuthContract;
  applied: AppliedAuthContract | null;
  /**
   * Optional because this first read-only path has no safe Management API
   * probe. Callers that obtain a container/API version can provide it.
   */
  liveLogtoEngineImage?: string | null;
}>;

function parseVersion(value: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function imageVersion(image: string): string | null {
  const tag = image.slice(image.lastIndexOf(":") + 1);
  return parseVersion(tag) === null ? null : tag;
}

function compareVersions(left: string, right: string): number | null {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (let i = 0; i < a.length; i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]! ? -1 : 1;
  }
  return 0;
}

function report(
  classification: AuthPlanClassification,
  input: AuthPlanInput,
  reasons: readonly string[],
): AuthPlanReport {
  const liveImage = input.liveLogtoEngineImage ?? null;
  const liveVersion = liveImage === null ? null : imageVersion(liveImage);
  return {
    classification,
    incoming: {
      version: input.incoming.version,
      hash: input.incoming.hash,
      logtoEngine: input.incoming.logtoEngine,
      impact: input.incoming.impact,
    },
    applied: input.applied,
    live: {
      logtoEngineImage: liveImage,
      logtoEngineVersion: liveVersion,
      inspected: liveImage !== null,
    },
    reasons,
    limitations:
      liveImage === null
        ? [
            "The running Logto container image could not be inspected; auth plan cannot report compatible without that evidence.",
          ]
        : [],
  };
}

/**
 * Pure, conservative auth compatibility classifier. A missing durable stamp
 * or an unmet live engine minimum never enters the routine release lane.
 */
export function classifyAuthPlan(input: AuthPlanInput): AuthPlanReport {
  const { incoming, applied } = input;

  if (applied === null) {
    return report("unknown", input, [
      "No persisted applied auth-contract stamp is available.",
    ]);
  }

  if (incoming.version < applied.contractVersion) {
    return report("incompatible", input, [
      `Incoming contract version ${incoming.version} is older than the applied version ${applied.contractVersion}.`,
    ]);
  }

  const liveImage = input.liveLogtoEngineImage;
  if (!liveImage) {
    return report("unknown", input, [
      "The running Logto container image is unavailable.",
    ]);
  }

  if (liveImage !== incoming.logtoEngine.image) {
    return report("incompatible", input, [
      `Running Logto image '${liveImage}' does not match incoming required image '${incoming.logtoEngine.image}'.`,
    ]);
  }

  const liveVersion = imageVersion(liveImage);
  if (liveVersion) {
    const engineComparison = compareVersions(
      liveVersion,
      incoming.logtoEngine.minimumVersion,
    );
    if (engineComparison !== null && engineComparison < 0) {
      return report("incompatible", input, [
        `Live Logto ${liveVersion} does not meet incoming minimum ${incoming.logtoEngine.minimumVersion}.`,
      ]);
    }
  }

  if (
    incoming.version === applied.contractVersion &&
    incoming.hash === applied.contractHash
  ) {
    return report("compatible", input, [
      "Incoming contract exactly matches the persisted applied contract stamp.",
    ]);
  }

  if (incoming.impact.mayAffectExistingSessions) {
    return report("session-disruptive", input, [
      "Incoming contract differs from the applied stamp and declares possible effects on existing sessions.",
    ]);
  }

  return report("reconcile-required-additive", input, [
    "Incoming contract differs from the applied stamp and requires explicit auth reconciliation.",
  ]);
}
