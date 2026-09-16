import {
  isPathWithinDesktopFilesystemGrantRoot,
  DESKTOP_FILESYSTEM_ACCESS_OPERATIONS,
  type DesktopFilesystemAccessOperation,
  type DesktopFilesystemGrant,
  type DesktopFilesystemGrantSubject,
} from "@nautilo/desktop-filesystem-grants";
import * as path from "node:path";

/**
 * A trusted local authority, such as the Current Folder or Genie Workspace.
 *
 * Baselines deliberately carry their own operation subset. They are not a
 * generic `allowedRoots` list and cannot implicitly widen a grant.
 */
export interface DesktopFilesystemBaselineAuthority {
  id: string;
  root: string;
  access: readonly DesktopFilesystemAccessOperation[];
}

export interface DesktopFilesystemOperationGuardInput {
  /** Absolute lexical path the caller wants to use. */
  candidatePath: string;
  /** Required for every decision; this guard never defaults an operation. */
  operation: DesktopFilesystemAccessOperation;
  /** Locally held, already schema-validated grants. Server path arrays are not authority. */
  grants: readonly DesktopFilesystemGrant[];
  /** Binding the selected grant must match exactly. */
  subject: DesktopFilesystemGrantSubject;
  /** Explicit trusted local authorities, each limited to its declared operations. */
  baselineAuthorities?: readonly DesktopFilesystemBaselineAuthority[];
  /** Injected clock for deterministic expiry decisions. */
  now?: Date;
}

export type DesktopFilesystemOperationGuardFailureCode =
  | "INVALID_PATH"
  | "INVALID_OPERATION"
  | "SUBJECT_MISMATCH"
  | "GRANT_NOT_FOUND"
  | "REVOKED"
  | "EXPIRED"
  | "ROOT_EXPANSION"
  | "OPERATION_UPGRADE";

export type DesktopFilesystemOperationGuardResult =
  | {
      ok: true;
      authority: "baseline" | "grant";
      authorityId: string;
      root: string;
      grantId?: string;
    }
  | { ok: false; code: DesktopFilesystemOperationGuardFailureCode };

interface MatchingAuthority {
  authority: "baseline" | "grant";
  authorityId: string;
  root: string;
  grantId?: string;
}

function subjectsMatch(left: DesktopFilesystemGrantSubject, right: DesktopFilesystemGrantSubject): boolean {
  return (
    left.userId === right.userId &&
    left.instanceId === right.instanceId &&
    left.relayId === right.relayId &&
    left.agentScope === right.agentScope
  );
}

function hasOperation(access: readonly DesktopFilesystemAccessOperation[], operation: DesktopFilesystemAccessOperation): boolean {
  return access.includes(operation);
}

function isValidCandidatePath(candidatePath: unknown): candidatePath is string {
  return (
    typeof candidatePath === "string" &&
    candidatePath.length > 0 &&
    !candidatePath.includes("\0") &&
    path.isAbsolute(candidatePath)
  );
}

function isSupportedOperation(operation: unknown): operation is DesktopFilesystemAccessOperation {
  return typeof operation === "string" && DESKTOP_FILESYSTEM_ACCESS_OPERATIONS.includes(operation as DesktopFilesystemAccessOperation);
}

function selectMostSpecific(matches: readonly MatchingAuthority[]): MatchingAuthority | undefined {
  let selected: MatchingAuthority | undefined;
  for (const match of matches) {
    if (selected === undefined || match.root.length > selected.root.length) selected = match;
  }
  return selected;
}

/**
 * Pure lexical authorization for one explicitly requested Desktop filesystem operation.
 *
 * This function does not inspect disk, resolve symlinks, accept server-provided
 * path arrays as authority, or use Electron filesystem identity. The Electron
 * caller must revalidate the selected root's identity and platform authorization
 * immediately before filesystem use.
 */
export function guardDesktopFilesystemOperation(
  input: DesktopFilesystemOperationGuardInput,
): DesktopFilesystemOperationGuardResult {
  if (!isValidCandidatePath(input.candidatePath)) return { ok: false, code: "INVALID_PATH" };
  if (!isSupportedOperation(input.operation)) return { ok: false, code: "INVALID_OPERATION" };

  const candidatePath = path.normalize(input.candidatePath);
  const baselineAuthorities = input.baselineAuthorities ?? [];
  const containingBaselines = baselineAuthorities.filter((baseline) =>
    isPathWithinDesktopFilesystemGrantRoot(baseline.root, candidatePath),
  );
  const containingGrants = input.grants.filter((grant) =>
    isPathWithinDesktopFilesystemGrantRoot(grant.canonicalRoot, candidatePath),
  );
  const matches: MatchingAuthority[] = [];

  for (const baseline of containingBaselines) {
    if (hasOperation(baseline.access, input.operation)) {
      matches.push({ authority: "baseline", authorityId: baseline.id, root: path.normalize(baseline.root) });
    }
  }

  const matchingSubjectGrants = containingGrants.filter((grant) => subjectsMatch(grant.subject, input.subject));
  const activeMatchingGrants = matchingSubjectGrants.filter((grant) => {
    if (grant.revokedAt !== undefined) return false;
    return grant.expiresAt === undefined || Date.parse(grant.expiresAt) > (input.now ?? new Date()).getTime();
  });
  for (const grant of activeMatchingGrants) {
    if (hasOperation(grant.access, input.operation)) {
      matches.push({ authority: "grant", authorityId: grant.id, root: grant.canonicalRoot, grantId: grant.id });
    }
  }

  const selected = selectMostSpecific(matches);
  if (selected) return { ok: true, ...selected };

  if (containingGrants.some((grant) => !subjectsMatch(grant.subject, input.subject))) {
    return { ok: false, code: "SUBJECT_MISMATCH" };
  }
  if (matchingSubjectGrants.some((grant) => grant.revokedAt !== undefined)) {
    return { ok: false, code: "REVOKED" };
  }
  if (
    matchingSubjectGrants.some(
      (grant) => grant.expiresAt !== undefined && Date.parse(grant.expiresAt) <= (input.now ?? new Date()).getTime(),
    )
  ) {
    return { ok: false, code: "EXPIRED" };
  }
  if (
    containingBaselines.some((baseline) => !hasOperation(baseline.access, input.operation)) ||
    activeMatchingGrants.some((grant) => !hasOperation(grant.access, input.operation))
  ) {
    return { ok: false, code: "OPERATION_UPGRADE" };
  }
  if (input.grants.length === 0 && baselineAuthorities.length === 0) {
    return { ok: false, code: "GRANT_NOT_FOUND" };
  }
  return { ok: false, code: "ROOT_EXPANSION" };
}
