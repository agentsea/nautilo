import type { NautiloApiClient } from "@nautilo/api-client/browser";

/**
 * Keep this derived from the browser client's method rather than duplicating
 * the DTO. The browser entrypoint deliberately has a narrower public type
 * surface than the Node entrypoint, but the method still carries the shared
 * effective-access schema type.
 */
export type EffectiveAccess = Awaited<
  ReturnType<NautiloApiClient["accessControl"]["getMyEffectiveAccess"]>
>;

export type AccessCapability = EffectiveAccess["capabilities"][number];

export type AccessProvenance = AccessCapability["provenance"][number];

export type AccessOverview = {
  highestRole: string | null;
  granted: readonly AccessCapability[];
  denied: readonly AccessCapability[];
  hasAnyGrant: boolean;
};

export type EffectiveAccessFailureState =
  | { kind: "signed-out"; serverId: string; viewerId: string | null }
  | { kind: "forbidden"; serverId: string; viewerId: string | null }
  | { kind: "failed"; serverId: string; viewerId: string | null; message: string };

export function effectiveAccessFailure(
  error: unknown,
  serverId: string,
  viewerId: string | null,
): EffectiveAccessFailureState {
  const status =
    error !== null && typeof error === "object" && "status" in error &&
    typeof (error as { status?: unknown }).status === "number"
      ? (error as { status: number }).status
      : null;
  if (status === 401) return { kind: "signed-out", serverId, viewerId };
  if (status === 403) return { kind: "forbidden", serverId, viewerId };
  return {
    kind: "failed",
    serverId,
    viewerId,
    message: error instanceof Error && error.message ? error.message : "Could not load your access.",
  };
}

/**
 * This is deliberately a presentation projection of the canonical endpoint,
 * not an authorization decision. In particular, it does not accept cached
 * viewer capabilities as an input.
 */
export function accessOverview(access: EffectiveAccess): AccessOverview {
  const granted = access.capabilities.filter((capability) => capability.granted);
  const denied = access.capabilities.filter((capability) => !capability.granted);
  return {
    highestRole: access.highestRole,
    granted,
    denied,
    hasAnyGrant: granted.length > 0 || access.highestRole !== null,
  };
}

export function roleLabel(highestRole: string | null): string {
  if (highestRole === null) return "No role granted";
  const canonicalLabels: Readonly<Record<string, string>> = {
    owner: "Owner",
    admin: "Admin",
    superuser: "Superuser",
    member: "Member",
    contributor: "Contributor",
    community: "Community",
    guest: "Guest",
  };
  return canonicalLabels[highestRole] ?? highestRole;
}

export function capabilityStatusLabel(capability: AccessCapability): string {
  return capability.granted ? "Granted" : "Not granted";
}

export function viewerFreshnessNotice(viewerState: string): string | null {
  if (viewerState === "stale") {
    return "Your saved sign-in identity could not be verified. Reconnect or sign in again before Nautilo reads your access from this server.";
  }
  if (viewerState === "cached") {
    return "Verifying your saved sign-in identity. Access information is read directly from this server.";
  }
  return null;
}

export function provenanceSummary(path: AccessProvenance): string {
  return `${path.groupLabel} · ${path.roleLabel}`;
}
