/**
 * D120 A1 — synchronous in-memory cache for bootstrap-time identity
 * facts about THIS server instance.
 *
 * Backs `PersonalPolicyResolver`'s `() => string` ownerId callback +
 * the `app.ts` boot-time `ownerActorId` / `defaultAgentId` reads that
 * pre-D120 came from three retired env vars (the source-code names
 * are deliberately not spelled out here so red-team-env-var.sh
 * source-grep stays a pure read-detector; see ops/security and
 * config-guard mode-registry for the historical names if needed).
 *
 * Pre-D120 the env vars were kept in sync via `promote-default-owner`
 * + `promote-default-agent` writing to the per-instance `instance.env`
 * under `~/.nautilo<instance-id>/` and a boot-time `loadDotenv` bridge
 * re-reading them. That whole loop is
 * gone — the DB is now the persistent source of truth (queried at boot
 * via `findClaimedOwnerId` and refreshed in-process inside
 * `redeem-invite.ts` after a successful `kind=claim`); this cache is
 * the runtime read seam for code that needs the values synchronously.
 *
 * Why a module-level cache and not constructor-injected:
 *   - PersonalPolicyResolver's ownerId callback is `() => string` —
 *     synchronous, deliberately. Async DB lookups inside the callback
 *     would breach the resolver's per-request hot-path contract.
 *   - The values are populated at exactly two synchronization points
 *     (server boot, post-claim) and read everywhere else. A module
 *     singleton matches that read-mostly shape with zero plumbing
 *     through ~20 files.
 *   - Test isolation: `_resetBootstrapStateCacheForTests()` clears all
 *     cached identity and binding state between cases.
 *
 * Four fields (the first three replace retired env vars; names elided so
 * the red-team source grep stays a pure read-detector):
 *   - ownerId         — set in P1
 *   - ownerActorId    — set in P1
 *   - defaultAgentId  — set in P1b
 *   - ownerBound      — explicit canonical claim state; never inferred from
 *                       ownerId because fresh boot caches the seed user there
 */

let ownerId = "";
let ownerActorId = "";
let defaultAgentId = "";
let ownerBound = false;

// ---------------------------------------------------------------------
// owner user id
// ---------------------------------------------------------------------

export function setBootstrapOwnerId(value: string): void {
  ownerId = value;
}

export function getBootstrapOwnerId(): string {
  return ownerId;
}

/**
 * Narrow non-identity predicate for security boundaries that only need to
 * know whether a real owner has completed claim. Fresh boot deliberately
 * caches the bootstrap seed user as ownerId, so ownerId presence is not an
 * ownership predicate.
 */
export function isBootstrapOwnerBound(): boolean {
  return ownerBound;
}

export function setBootstrapOwnerBound(value: boolean): void {
  ownerBound = value;
}

// ---------------------------------------------------------------------
// owner actor id (M042D — minted by seedTrustPersonal)
// ---------------------------------------------------------------------

export function setBootstrapOwnerActorId(value: string): void {
  ownerActorId = value;
}

export function getBootstrapOwnerActorId(): string {
  return ownerActorId;
}

// ---------------------------------------------------------------------
// default agent id (D120 A1.P1b)
// ---------------------------------------------------------------------

export function setBootstrapDefaultAgentId(value: string): void {
  defaultAgentId = value;
}

export function getBootstrapDefaultAgentId(): string {
  return defaultAgentId;
}

// ---------------------------------------------------------------------
// tests-only — clear all cached identity and binding state between cases
// ---------------------------------------------------------------------

export function _resetBootstrapStateCacheForTests(): void {
  ownerId = "";
  ownerActorId = "";
  defaultAgentId = "";
  ownerBound = false;
}
