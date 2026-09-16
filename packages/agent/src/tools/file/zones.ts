/**
 * D079 Phase 4 / G3 — zone resolver for the unified `file` tool.
 *
 * The `file` tool routes every command through one zone resolver.
 * Given a command arg (`path` + `zone`) and the current turn's
 * ZoneContext (workspace root + current folder from agent state),
 * produces an absolute path OR a clear error.
 *
 * Zone vocabulary (matches D079 issue + D078 WS-event payload):
 *   workspace — the Agent's persistent drawer (always set post-Phase-3)
 *   current   — the user's task-scoped folder (null when no folder open)
 *   absolute  — an explicit absolute path anywhere the user can read
 *   home      — LEGACY alias → workspace (one-release deprecation window)
 *   scratch   — LEGACY alias → workspace + "/scratch" (one-release)
 *
 * Pure function; no fs access. Tests live alongside. Called once per
 * `file` tool invocation, before any command handler runs.
 *
 * Decision record anchor:
 *   pr-reviews/DECISION-2026-04-21-file-tool-shape.md (§Zone semantics)
 */

import * as path from "node:path";
import { realpath } from "node:fs/promises";
import { getArtifactsRoot } from "@nautilo/config";

export type FsZone =
  | "workspace"
  | "current"
  | "absolute"
  | "home"     // legacy alias
  | "scratch"; // legacy alias

export interface ZoneContext {
  /** Absolute path to the Agent's Workspace root (Surface A). Always
   * non-empty post-D079 Phase 3 for owner sessions. */
  workspaceRoot: string;
  /** Absolute path to the user's task-scoped folder (Surface B), or
   * null when no folder is open. */
  currentFolder: string | null;
}

export type ZoneResolution =
  | { ok: true; resolved: string; resolvedZone: "workspace" | "current" | "absolute" }
  | { ok: false; reason: string };

/**
 * Resolve a `{ path, zone }` pair against a ZoneContext to an absolute
 * filesystem path.
 *
 * Contract:
 * - For `zone: "absolute"`, `path` MUST be absolute. Relative paths
 *   reject with a clear message.
 * - For `zone: "workspace"` or `"current"`, `path` is joined onto the
 *   zone root after rejecting path-traversal attempts (`..` segments
 *   that escape the root, null bytes, control chars).
 * - For `zone: "current"` with a null `currentFolder`, reject with a
 *   prompt-able error so the Agent can ask the user to open a folder.
 * - For `zone: "home"`, behave as if `zone: "workspace"` and log
 *   one-shot deprecation warning at the call site (this function is
 *   pure; logging happens upstream).
 * - For `zone: "scratch"`, join onto `<workspaceRoot>/scratch/`.
 *
 * Normalization: the resolved path is run through `path.resolve` +
 * `path.normalize` so `.` / `..` segments collapse and any trailing
 * slashes are removed. The result is then guaranteed to lie UNDER
 * the zone root for `workspace`/`current` — a traversal-escape
 * attempt that cancels out (e.g. `../foo/../bar`) would still fail
 * the under-root check.
 *
 * Control-char hygiene: null bytes and other C0 chars reject at this
 * layer even though the chat route already sanitizes inputs. Defense
 * in depth — the agent might synthesize a path from scratch (e.g.
 * constructing a filename from memory-brief content), and the zone
 * resolver is the last gate before fs ops.
 */
export function resolveZone(
  args: { path: string; zone: FsZone },
  ctx: ZoneContext,
): ZoneResolution {
  const { path: rawPath, zone } = args;

  // Basic input validation first — catch obviously-bad paths before
  // any zone-specific logic.
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    return { ok: false, reason: "path is required" };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(rawPath)) {
    return { ok: false, reason: "path contains control characters" };
  }

  // Normalize legacy zone aliases. `home` → `workspace`; `scratch`
  // → workspace/scratch subtree. Legacy aliases reject without ever
  // touching the zone resolver if workspace is unset (shouldn't
  // happen post-Phase-3, but defensive).
  let effectiveZone: "workspace" | "current" | "absolute";
  let effectivePathPrefix = "";
  switch (zone) {
    case "workspace":
      effectiveZone = "workspace";
      break;
    case "current":
      effectiveZone = "current";
      break;
    case "absolute":
      effectiveZone = "absolute";
      break;
    case "home":
      effectiveZone = "workspace";
      break;
    case "scratch":
      effectiveZone = "workspace";
      effectivePathPrefix = "scratch";
      break;
    default:
      return { ok: false, reason: `unknown zone "${String(zone)}"` };
  }

  if (effectiveZone === "absolute") {
    if (!path.isAbsolute(rawPath)) {
      return {
        ok: false,
        reason: `zone="absolute" requires an absolute path (got ${rawPath.slice(0, 80)})`,
      };
    }
    const normalized = path.normalize(rawPath);
    return { ok: true, resolved: normalized, resolvedZone: "absolute" };
  }

  // zone="workspace" or "current" — resolve against a root.
  const root =
    effectiveZone === "workspace" ? ctx.workspaceRoot : ctx.currentFolder;

  if (!root) {
    if (effectiveZone === "current") {
      return {
        ok: false,
        reason: "No folder is open. Ask the user to open one via the 📂 picker.",
      };
    }
    return {
      ok: false,
      reason: "Workspace root is not set. This is a boot-order bug; server should have initialized it.",
    };
  }

  if (!path.isAbsolute(root)) {
    return {
      ok: false,
      reason: `zone root is not absolute (${root}) — boot-order bug`,
    };
  }

  // If the agent passed an absolute path with a non-absolute zone,
  // reject. It's unambiguous intent-mismatch — they meant
  // zone="absolute" but typed the wrong zone. Better to surface the
  // bug than silently ignore the zone argument.
  if (path.isAbsolute(rawPath)) {
    return {
      ok: false,
      reason: `zone="${zone}" expects a relative path (got absolute ${rawPath.slice(0, 80)}); use zone="absolute" for absolute paths`,
    };
  }

  // Join with the optional prefix (scratch alias) first so path-
  // traversal is checked against the full joined result.
  const joined = path.join(root, effectivePathPrefix, rawPath);
  const resolved = path.normalize(joined);

  // Under-root check: after normalization, the resolved path must
  // still start with the root. This catches `..`-based traversal
  // attempts that cancel out (e.g. `foo/../../../etc/passwd`).
  const rootNormalized = path.normalize(root);
  const rootWithSep = rootNormalized.endsWith(path.sep)
    ? rootNormalized
    : rootNormalized + path.sep;
  if (resolved !== rootNormalized && !resolved.startsWith(rootWithSep)) {
    return {
      ok: false,
      reason: `resolved path escapes zone root (${resolved} not under ${rootNormalized})`,
    };
  }

  return { ok: true, resolved, resolvedZone: effectiveZone };
}

/**
 * D079 PR-011 security port — realpath containment check.
 *
 * `resolveZone()` above does TEXTUAL containment via `path.normalize`
 * + string-prefix. That catches `..`-based traversal but does NOT
 * follow symlinks. Combined with auto-approve writes on the
 * workspace zone (and symlink-follow semantics in write.ts / read
 * via `fsp.readFile` / recursive grep), a symlink INSIDE the
 * workspace root pointing outside — e.g. `~/Documents/Nautilo/
 * notes.md -> /Users/me/.ssh/authorized_keys` — would pass the
 * textual check and redirect the fs op to the symlink target.
 *
 * This helper re-verifies containment via `realpath` (the OS-level
 * answer to "what does this path actually point at?"). Runs once
 * per `file` tool invocation inside the dispatcher between
 * `resolveZone()` and the command handler. `move` and `copy` call
 * it again on their destination resolution.
 *
 * Absolute zone bypasses — the user explicitly opted into an
 * arbitrary path, and the deny-list in `checkPathAccess`
 * (path-deny.ts) is the gate for absolute-zone paths, run by
 * `validateBeforeExecution` in toolsNode before the tool invokes.
 *
 * For paths that don't exist yet (e.g. writing a new file), the
 * check degrades to the parent directory's realpath — covers the
 * "symlinked subdirectory inside workspace" attack where the file
 * itself doesn't yet exist but the symlinked parent would redirect
 * the write.
 */
/**
 * M174 — minimal realpath surface the containment check needs. The
 * unified `file` tool passes a relay-backed implementation for
 * `current`/`absolute` zones so symlink-following containment is
 * evaluated on the USER's machine (not the server's). Defaults to the
 * server-local `node:fs/promises` realpath for the `workspace` zone and
 * for the convert / transcribe tools that share this helper (those stay
 * server-side and are out of scope for M174).
 */
export interface RealpathBackend {
  realpath(p: string): Promise<string>;
}

const localRealpathBackend: RealpathBackend = {
  realpath: (p) => realpath(p),
};

/** Resolve a path to its realpath; null on ENOENT (target doesn't yet exist). */
async function realpathOrNull(
  p: string,
  backend: RealpathBackend,
): Promise<string | null> {
  try {
    return await backend.realpath(p);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ENOENT")) return null;
    throw err;
  }
}

function isUnderAny(real: string, roots: readonly string[]): boolean {
  for (const r of roots) {
    const rWithSep = r.endsWith(path.sep) ? r : r + path.sep;
    if (real === r || real.startsWith(rWithSep)) return true;
  }
  return false;
}

export async function assertRealpathContained(
  resolution: { resolved: string; resolvedZone: "workspace" | "current" | "absolute" },
  ctx: ZoneContext,
  backend: RealpathBackend = localRealpathBackend,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (resolution.resolvedZone === "absolute") {
    return { ok: true };
  }

  // ─── Dual-root containment invariant (D136-P2 audit, 2026-05-13) ───
  //
  // "Contained" means: for `current` zone, the realpath lies under
  // `ctx.currentFolder`; for `workspace` zone, the realpath lies under
  // EITHER `ctx.workspaceRoot` (user-visible Surface A) OR
  // `getArtifactsRoot()` (M088B server-owned artifact byte storage,
  // default `~/.nautilo/artifacts/`, override via
  // `NAUTILO_ARTIFACTS_ROOT`). Pre-M088B this was a single root because
  // physical artifact paths were `<workspaceRoot>/.artifacts/<uuid>`.
  //
  // Why dual-root: M088B moved artifact bytes outside `workspaceRoot`
  // so packaged-server / Droplet deployments can mount a persistent
  // volume there without leaking the client's filesystem layout. The
  // legacy `<workspaceRoot>/.artifacts/<uuid>` layout still appears on
  // systems whose `bun run dev:migrate-artifacts` Pass A hasn't run
  // yet — so coexistence of both physical layouts is a real operating
  // state, not just a transition snapshot.
  //
  // Known permissiveness (D136-P2 follow-up, not fixed here): a
  // symlink under one root pointing into the other CURRENTLY resolves
  // cleanly. Exploitability requires a local attacker who can already
  // plant files in the user's home (game-over class) — not CVE-class,
  // but a documented permissiveness worth a per-backend tightening
  // in a follow-up. Tests in `file-tool-realpath-containment.test.ts`
  // pin both directions of this current behavior so a future tightening
  // (or further loosening) surfaces in CI.
  const literalRoots: string[] = [];
  if (resolution.resolvedZone === "workspace") {
    if (ctx.workspaceRoot) literalRoots.push(ctx.workspaceRoot);
    literalRoots.push(getArtifactsRoot());
  } else {
    if (ctx.currentFolder) literalRoots.push(ctx.currentFolder);
  }
  if (literalRoots.length === 0) {
    return { ok: false, reason: "zone root is not set (boot-order bug)" };
  }

  const realRoots: string[] = [];
  for (const r of literalRoots) {
    const real = await realpathOrNull(r, backend);
    if (real !== null) realRoots.push(real);
  }
  if (realRoots.length === 0) {
    return {
      ok: false,
      reason: `zone roots do not resolve: ${literalRoots.join(", ")}`,
    };
  }

  let resolvedReal: string | null;
  try {
    resolvedReal = await realpathOrNull(resolution.resolved, backend);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `realpath failed: ${msg}` };
  }

  if (resolvedReal !== null) {
    if (isUnderAny(resolvedReal, realRoots)) return { ok: true };
    const symlinked = resolvedReal !== path.normalize(resolution.resolved);
    return {
      ok: false,
      reason: symlinked
        ? `path escapes zone via symlink (${resolution.resolved} -> ${resolvedReal})`
        : `path escapes zone (${resolvedReal} not under any of: ${realRoots.join(", ")})`,
    };
  }

  // ENOENT — target doesn't exist yet. Walk up to the first existing
  // ancestor and check IT is under a valid root. This covers the
  // "symlinked subdirectory" attack while also accepting deep paths
  // whose parent directories `mkdir -p` will create at write time.
  let parent = path.dirname(resolution.resolved);
  while (parent !== path.dirname(parent)) {
    const parentReal = await realpathOrNull(parent, backend);
    if (parentReal === null) {
      parent = path.dirname(parent);
      continue;
    }
    if (isUnderAny(parentReal, realRoots)) return { ok: true };
    const symlinked = parentReal !== path.normalize(parent);
    return {
      ok: false,
      reason: symlinked
        ? `parent directory escapes zone via symlink (${parent} -> ${parentReal})`
        : `parent directory escapes zone (${parentReal} not under any of: ${realRoots.join(", ")})`,
    };
  }
  // Walked all the way to filesystem root without finding an existing
  // ancestor under a valid containment root. Fail closed — the path is
  // genuinely outside every zone root.
  return {
    ok: false,
    reason: `path has no existing ancestor under any zone root (${realRoots.join(", ")})`,
  };
}
