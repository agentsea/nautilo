/**
 * D418 foundation — pure-ish Electron adapter that compiles a validated
 * WorkstationProfile into the shared in-memory `DesktopFilesystemGrantAuthority`
 * overlay.
 *
 * The adapter is "pure-ish": it owns no disk state and mutates only the
 * authority's in-memory overlay. It calls the shared, side-effect-free
 * `compileWorkstationProfile` to compute the contained intersection of a bound
 * profile and already-canonical `DiscoveredWorkstationFacts`, then maps each
 * compiled root to a fresh `origin:"policy_pack"`, `lifetime:"session"` grant
 * and adds it to the authority overlay.
 *
 * Fail-closed compile contract:
 *   - Every compiled root is prevalidated (strict `parseDesktopFilesystemGrant`)
 *     and its grant id minted before any authority mutation.
 *   - Grants are added one-by-one via `authority.addEphemeral`. If a later add
 *     fails, every grant added earlier in this session is revoked so no partial
 *     compile confers authority. (Revoked entries remain in overlay history
 *     with no authority — the authority exposes no single-grant delete.)
 *   - Policy-pack grants are never persisted: they live only in the overlay.
 *
 * Profile state is kept strictly separate from grant `policyVersion`: compiled
 * grants use a fixed `policyVersion` constant, never the profile's
 * `protectedPolicyVersion`, and the store envelope revision is untouched here.
 */

import { randomUUID } from "node:crypto";

import {
  parseDesktopFilesystemGrant,
  type DesktopFilesystemGrant,
  type DesktopFilesystemGrantSubject,
} from "@nautilo/desktop-filesystem-grants";
import {
  compileWorkstationProfile,
  type CompiledWorkstationProfile,
  type DiscoveredWorkstationFacts,
  type WorkstationProfile,
  type WorkstationProfileCompileErrorCode,
} from "@nautilo/workstation-profiles";
import type { DesktopFilesystemGrantAuthority } from "../desktop-filesystem-grants/authority.ts";

/**
 * Fixed `policyVersion` stamped on every compiled policy-pack grant. Kept
 * independent of the bound profile's `protectedPolicyVersion` so profile state
 * and grant `policyVersion` never share a dimension.
 */
const COMPILED_POLICY_PACK_GRANT_POLICY_VERSION = 1 as const;

export interface WorkstationProfileCompilerOptions {
  /** Inject a clock for deterministic `compiledAt` / grant `createdAt`. */
  clock?: () => Date;
  /** Mints a fresh grant id per compiled root. Defaults to crypto.randomUUID. */
  mintGrantId?: () => string;
}

export interface CompileWorkstationProfileSessionInput {
  /** A validated stored profile (the store's parsed payload). */
  profile: WorkstationProfile;
  /** Already-canonical discovered concrete facts. Discovery never creates authority. */
  facts: DiscoveredWorkstationFacts;
  /** The Desktop Filesystem Grant subject the compiled grants will bind to. */
  subject: DesktopFilesystemGrantSubject;
  /** The authority overlay that will own the compiled policy-pack grants. */
  authority: DesktopFilesystemGrantAuthority;
}

export interface CompiledProfileSessionResult {
  profileId: string;
  profileRevision: number;
  grantIds: string[];
  compiledAt: string;
}

export type WorkstationProfileCompilerErrorCode =
  | "compile_failed"
  | "grant_prevalidation_failed"
  | "grant_add_failed";

export type WorkstationProfileCompilerResult =
  | { ok: true; data: CompiledProfileSessionResult }
  | {
      ok: false;
      code: WorkstationProfileCompilerErrorCode;
      message: string;
      compileErrorCode?: WorkstationProfileCompileErrorCode;
      /** Number of grants revoked during rollback when an add failed mid-session. */
      rolledBack?: number;
    };

function compilerError(
  code: WorkstationProfileCompilerErrorCode,
  message: string,
): { ok: false; code: WorkstationProfileCompilerErrorCode; message: string } {
  return { ok: false, code, message };
}

/**
 * Builds a `policy_pack` / `session` grant for one compiled root. The grant is
 * strict-validated by the caller before any authority mutation.
 */
function buildPolicyPackGrant(
  compiledRoot: CompiledWorkstationProfile["roots"][number],
  subject: DesktopFilesystemGrantSubject,
  grantId: string,
  createdAt: string,
): DesktopFilesystemGrant {
  return {
    schemaVersion: 1,
    id: grantId,
    canonicalRoot: compiledRoot.path,
    access: [...compiledRoot.access],
    origin: "policy_pack",
    lifetime: "session",
    subject,
    createdBy: subject.userId,
    createdAt,
    policyVersion: COMPILED_POLICY_PACK_GRANT_POLICY_VERSION,
  };
}

/**
 * Compiles a validated profile against canonical discovered facts and adds the
 * resulting roots to the authority overlay as `policy_pack` / `session` grants.
 *
 * Fails closed: on any compile, prevalidation, or add failure, no partial
 * compile confers authority — earlier additions in the same session are
 * revoked before returning. Policy-pack grants are never persisted; they live
 * only in the authority overlay.
 */
export async function compileWorkstationProfileSession(
  input: CompileWorkstationProfileSessionInput,
  options: WorkstationProfileCompilerOptions = {},
): Promise<WorkstationProfileCompilerResult> {
  const clock = options.clock ?? (() => new Date());
  const mintGrantId = options.mintGrantId ?? (() => randomUUID());

  const now = clock();
  if (Number.isNaN(now.getTime())) {
    return compilerError("compile_failed", "compile clock must be a valid date");
  }
  const compiledAt = now.toISOString();

  const compiled = compileWorkstationProfile(input.profile, input.facts, { now });
  if (!compiled.ok) {
    return {
      ...compilerError(
        "compile_failed",
        `profile compile rejected: ${compiled.error.code}`,
      ),
      compileErrorCode: compiled.error.code,
    };
  }

  // Mint ids and build grants for every compiled root before touching the
  // authority, so a malformed grant never causes a partial overlay mutation.
  const grants: DesktopFilesystemGrant[] = [];
  for (const root of compiled.compiled.roots) {
    const grant = buildPolicyPackGrant(root, input.subject, mintGrantId(), compiledAt);
    const parsed = parseDesktopFilesystemGrant(grant, { now });
    if (!parsed.ok) {
      return {
        ...compilerError(
          "grant_prevalidation_failed",
          `compiled grant rejected: ${parsed.error.code}`,
        ),
      };
    }
    grants.push(parsed.grant);
  }

  const addedIds: string[] = [];
  for (const grant of grants) {
    const added = await input.authority.addEphemeral({
      grant,
      userId: input.subject.userId,
    });
    if (!added.ok) {
      // Roll back every grant added earlier in this session so a failed add
      // leaves no partial authority. Revoked entries retain no authority.
      for (const addedId of addedIds) {
        await input.authority.revoke({ userId: input.subject.userId, grantId: addedId });
      }
      return {
        ...compilerError(
          "grant_add_failed",
          `authority rejected compiled grant ${grant.id}: ${added.code}`,
        ),
        rolledBack: addedIds.length,
      };
    }
    addedIds.push(grant.id);
  }

  return {
    ok: true,
    data: {
      profileId: compiled.compiled.profileId,
      profileRevision: compiled.compiled.profileRevision,
      grantIds: addedIds,
      compiledAt,
    },
  };
}

/**
 * Revokes the policy-pack session grants associated with one compilation
 * session. Only grants whose ids are passed in AND that are currently
 * `origin:"policy_pack"` overlay grants for the caller are touched — unrelated
 * `once` / `session` / durable grants are never cleared. Revoked grants remain
 * in overlay history with no authority (matching the authority's overlay-revoke
 * semantics; the authority exposes no single-grant delete).
 */
export async function clearCompiledProfileSession(input: {
  authority: DesktopFilesystemGrantAuthority;
  userId: string;
  grantIds: readonly string[];
}): Promise<{ cleared: number; skipped: readonly string[] }> {
  if (input.grantIds.length === 0) {
    return { cleared: 0, skipped: [] };
  }

  const listed = await input.authority.list({
    userId: input.userId,
    includeHistory: true,
  });
  if (!listed.ok) {
    return { cleared: 0, skipped: [...input.grantIds] };
  }

  const policyPackIds = new Set(
    listed.data.grants
      .filter((entry) => entry.grant.origin === "policy_pack")
      .map((entry) => entry.grant.id),
  );

  const skipped: string[] = [];
  let cleared = 0;
  for (const grantId of input.grantIds) {
    if (!policyPackIds.has(grantId)) {
      skipped.push(grantId);
      continue;
    }
    const revoked = await input.authority.revoke({ userId: input.userId, grantId });
    if (revoked.ok) {
      cleared += 1;
    } else {
      skipped.push(grantId);
    }
  }
  return { cleared, skipped };
}
