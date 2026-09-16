/**
 * Path helpers for `@nautilo/sandbox`. D060 Phase 1.
 *
 * Keep this module small and pure — no `@nautilo/logger` imports, no
 * config knowledge. The bwrap + sandbox-exec modules compose these
 * helpers to build their mount + allow-rule lists.
 *
 * Port: Spacebot `src/sandbox.rs`'s `canonicalize_or_self` +
 * `push_unique_path` utilities.
 */

import { realpathSync } from "node:fs";

/**
 * Realpath a path. Returns the same string if realpath fails (non-
 * existent paths, permission errors, etc.) — NEVER throws. Mirrors
 * Spacebot's `canonicalize_or_self`.
 *
 * Why "or self": the callers build arg lists for bwrap and SBPL
 * profiles. Throwing on a missing path would kill the whole sandbox
 * bootstrap when ONE entry in the writable-paths list doesn't
 * resolve. Better to log + skip at the call site than abort.
 */
export function canonicalize(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * realpath that returns `null` instead of the input on failure, for
 * call sites that need to KNOW whether the path exists. The
 * bubblewrap builder uses this to decide whether to add a writable
 * bind vs skip the entry.
 *
 * Port: Spacebot `src/sandbox.rs:294-296` pattern.
 */
export function tryRealpath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Push a path to a list IFF it's not already present. Preserves
 * insertion order (important for bwrap — later mounts override
 * earlier, so duplicate bind lines can silently change semantics).
 *
 * Callers use this for both the ro-system list and the writable-
 * allow list to dedupe user-specified paths that happen to already
 * be covered by a system mount.
 *
 * Port: Spacebot `src/sandbox.rs`'s `push_unique_path` utility.
 */
export function pushUniquePath(list: string[], candidate: string): void {
  if (!list.includes(candidate)) {
    list.push(candidate);
  }
}

// macOS /var ↔ /private/var quirk — documented as prose (no exported
// helper) since Phase 2's `seatbelt-profile.ts` is the actual
// consumer and has its own inline coverage of the same invariant.
// Before Phase 2 this module exported a `describeDarwinVarQuirk()`
// reminder-in-code function; PR-014 M-3 called it dead weight once
// Phase 2 lands — replaced with this header comment.
//
// Summary: on macOS, `/var` is a symlink to `/private/var` and
// `/tmp` is a symlink to `/private/tmp`. Sandbox-exec (Seatbelt)
// rules evaluated against literal `/var/…` paths silently skip
// resources under the `/private/…` tree because the kernel
// already resolved the symlink before the profile evaluator runs.
// Every path that enters an SBPL profile MUST be canonicalized OR
// both forms emitted (original + realpath) so the profile matches
// regardless of which form the fs op uses. See
// `seatbelt-profile.ts::buildSbplProfile` for the emit-both-forms
// pattern.
//
// Bubblewrap (Linux) doesn't have the same resolve-before-apply
// behavior; paths there are literal mount points, so a single form
// suffices.
//
// Port: Spacebot `src/sandbox.rs:786-792`; Gemini CLI
// `seatbeltArgsBuilder.ts` (see research doc §Q5).
