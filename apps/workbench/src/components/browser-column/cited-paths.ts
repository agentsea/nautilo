/**
 * Pure path-containment + cited-path derivation helpers for the Files tab.
 *
 * Extracted from files-tab.tsx as a pure module so the security-adjacent
 * logic can be unit-tested without the React / DOM dependency the tab
 * itself carries. No React, no DOM, no node imports — browser-safe.
 *
 * Canonical containment rule: **equals-or-boundary**. A path `p` is
 * "under" root `r` iff:
 *   - `p === r` (exact match), OR
 *   - `p` starts with `r + sep` where `sep` is the path separator
 *     appropriate for `r`.
 *
 * This matches the shape used by the main-process guard
 * (`apps/desktop/electron/main.ts::isPathWithinWorkspace`) and the
 * canonical relay-side guard (`packages/relay/src/workspace-guard.ts`
 * lines 113-116). Naive `startsWith` without the separator check is a
 * classic sibling-token leak: `/home/user/proj` wrongly matches
 * `/home/user/proj-evil/secret.txt`.
 */

import type { ToolActivityEvent } from "../../adapters/runtime-contexts";

/**
 * Pick the path separator appropriate for the given root string. On
 * paths that contain a backslash but no forward slash we assume Windows;
 * anything else (POSIX, mixed) uses `/`. Mirrors `joinPath`'s heuristic
 * so the two helpers agree.
 */
export function separatorFor(root: string): "/" | "\\" {
  return root.includes("\\") && !root.includes("/") ? "\\" : "/";
}

/**
 * True when `candidate` is `root` itself or a descendant of it, using
 * the equals-or-boundary rule. Trims one trailing separator from `root`
 * before comparing so `/a/` and `/a` are treated identically.
 *
 * Does NOT normalize `..` segments — callers that accept user-supplied
 * paths should pass a pre-resolved absolute path. In our renderer use
 * the inputs come from tool-call args we already filter, so the risk
 * is limited to cosmetic DOM additions rather than filesystem access.
 */
export function isUnderRoot(root: string, candidate: string): boolean {
  if (!root || !candidate) return false;
  const sep = separatorFor(root);
  const trimmed = root.endsWith(sep) ? root.slice(0, -1) : root;
  if (candidate === trimmed) return true;
  return candidate.startsWith(trimmed + sep);
}

/**
 * Workbench-side `path.join` polyfill. Forward-slash on POSIX, mirror
 * the parent's separator otherwise. Does not normalize `..` or `.`
 * segments — caller is responsible for sane inputs.
 */
export function joinPath(parent: string, name: string): string {
  const sep = separatorFor(parent);
  const trimmed = parent.endsWith(sep) ? parent.slice(0, -1) : parent;
  return `${trimmed}${sep}${name}`;
}

/**
 * Strip a workspace-root prefix from an absolute path, returning a
 * workspace-relative display form. Uses equals-or-boundary so a path
 * that merely *looks* like it shares a prefix (`/proj-evil/x` for root
 * `/proj`) is returned unchanged rather than mis-stripped.
 */
export function relativeFromWorkspace(root: string, full: string): string {
  if (!isUnderRoot(root, full)) return full;
  const sep = separatorFor(root);
  const trimmed = root.endsWith(sep) ? root.slice(0, -1) : root;
  if (full === trimmed) return "";
  const rel = full.slice(trimmed.length);
  return rel.startsWith(sep) ? rel.slice(1) : rel;
}

/**
 * Derive the set of absolute workspace-contained paths the agent has
 * cited via tool calls. Used by the Files tab's cited-file glyph (●).
 *
 * Heuristic arg extraction: checks `path` / `file` / `target` /
 * `filename` in order — the canonical arg names across Nautilo's
 * built-in file tools. Relative paths are resolved against
 * `workspacePath`; absolute paths are kept as-is. Any path that is
 * NOT under the workspace root (equals-or-boundary) is dropped — the
 * glyph surfaces only paths the user can actually see in the tree.
 *
 * @param toolEvents — recent tool activity events (output of useToolActivity)
 * @param workspacePath — current workspace root; empty string disables derivation
 */
export function derivedCitedPaths(
  toolEvents: readonly ToolActivityEvent[],
  workspacePath: string,
): ReadonlySet<string> {
  const set = new Set<string>();
  if (!workspacePath) return set;
  for (const e of toolEvents) {
    const candidates: unknown[] = [
      e.args["path"],
      e.args["file"],
      e.args["target"],
      e.args["filename"],
    ];
    for (const raw of candidates) {
      if (typeof raw !== "string" || raw.length === 0) continue;
      const abs = raw.startsWith("/") || raw.startsWith("\\")
        ? raw
        : joinPath(workspacePath, raw);
      if (isUnderRoot(workspacePath, abs)) set.add(abs);
    }
  }
  return set;
}

function collectArtifactIdsFromValue(value: unknown, into: Set<string>): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) collectArtifactIdsFromValue(item, into);
    return;
  }
  if (typeof value !== "object") return;
  const o = value as Record<string, unknown>;
  const id = o["artifactId"] ?? o["artifact_id"];
  if (typeof id === "string" && id.length > 0) into.add(id);
  for (const v of Object.values(o)) collectArtifactIdsFromValue(v, into);
}

/**
 * `file` commands whose RESULT enumerates many artifacts rather than
 * citing a specific one. A directory listing / cross-artifact search
 * returns an envelope containing every matching artifact's id, so
 * harvesting those ids would light up the cited glyph (●) for the whole
 * tree — e.g. a single `file list workspace/artifacts` marking all 150+
 * artifacts "cited in conversation". We still harvest such an event's
 * `args` (an explicit id passed in args IS a citation); we only skip the
 * bulk result. Surfaced while exercising the list tool during D322.
 */
const ENUMERATION_COMMANDS: ReadonlySet<string> = new Set(["list", "grep"]);

/**
 * Collect stable artifact ids cited in tool args / JSON tool results
 * (workspace `file` tool envelopes, `generate_image`, etc.).
 */
export function derivedCitedArtifactIds(
  toolEvents: readonly ToolActivityEvent[],
): ReadonlySet<string> {
  const set = new Set<string>();
  for (const e of toolEvents) {
    collectArtifactIdsFromValue(e.args, set);
    const command = e.args["command"];
    if (typeof command === "string" && ENUMERATION_COMMANDS.has(command)) {
      continue;
    }
    const raw = e.result;
    if (typeof raw === "string" && raw.trim().length > 0) {
      try {
        collectArtifactIdsFromValue(JSON.parse(raw) as unknown, set);
      } catch {
        /* ignore malformed JSON */
      }
    }
  }
  return set;
}
