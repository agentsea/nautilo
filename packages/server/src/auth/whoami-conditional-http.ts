import { createHash } from "node:crypto";
import type { GroupChip, WhoamiResponse } from "@nautilo/types";

export const WHOAMI_CACHE_CONTROL = "private, no-store";
export const WHOAMI_VARY = "Authorization";

function compareGroupChips(a: GroupChip, b: GroupChip): number {
  const byId = a.id.localeCompare(b.id);
  if (byId !== 0) return byId;
  const byType = a.type.localeCompare(b.type);
  if (byType !== 0) return byType;
  const byLabel = a.label.localeCompare(b.label);
  if (byLabel !== 0) return byLabel;
  return a.roleSlug.localeCompare(b.roleSlug);
}

/** Stable JSON input for hashing; does not mutate or reorder the live response body. */
export function canonicalWhoamiProjectionForHash(body: WhoamiResponse): Record<string, unknown> {
  const officeEnabled = body.features?.office?.enabled ?? false;
  return {
    sessionUserId: body.sessionUserId,
    sessionActorId: body.sessionActorId,
    userIdentity: body.userIdentity,
    handle: body.handle,
    displayName: body.displayName,
    externalId: body.externalId,
    instanceId: body.instanceId,
    mustChangePassword: body.mustChangePassword,
    groups: [...body.groups].sort(compareGroupChips),
    capabilities: [...body.capabilities].sort((a, b) => a.localeCompare(b)),
    features: { office: { enabled: officeEnabled } },
    highestRole: body.highestRole ?? null,
  };
}

function sha256Base64Url(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("base64url");
}

/** Opaque weak ETag for the fully authorized whoami projection (M213 Phase 8). */
export function whoamiWeakETagFromProjection(body: WhoamiResponse): string {
  const digest = sha256Base64Url(JSON.stringify(canonicalWhoamiProjectionForHash(body)));
  return `W/"${digest}"`;
}

/** Exact token match against a single weak ETag value; ignores `*`. */
export function whoamiIfNoneMatchEquals(
  ifNoneMatch: string | string[] | undefined,
  etag: string,
): boolean {
  if (ifNoneMatch === undefined) return false;
  const raw = Array.isArray(ifNoneMatch) ? ifNoneMatch.join(",") : ifNoneMatch;
  if (raw.trim().length === 0) return false;
  for (const token of raw.split(",")) {
    if (token.trim() === etag) return true;
  }
  return false;
}
