/**
 * Repo-relative path normalization + traversal guard.
 *
 * Every filesystem tool the repo-docs agent uses takes a *repo-relative*
 * path (e.g. `README.md`, `openwiki/quickstart.md`). We reject host-absolute
 * paths and any `..` escape so a backend can safely resolve against its root
 * without the agent reaching outside the target repository. This mirrors the
 * "virtual root" discipline OpenWiki relied on, made explicit for our backends.
 */

import { DEFAULT_EXCLUDE_DIRS } from "./constants";

export class RepoPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoPathError";
  }
}

/**
 * Normalize an agent-supplied path to a clean repo-relative POSIX path.
 * Throws `RepoPathError` on absolute paths, drive letters, or `..` escapes.
 * Returns "" for the repo root.
 */
export function normalizeRepoPath(input: string): string {
  if (typeof input !== "string") {
    throw new RepoPathError("path must be a string");
  }
  let p = input.trim().replace(/\\/g, "/");

  if (p === "" || p === "." || p === "./" || p === "/") return "";

  // Reject Windows drive-absolute (C:/...) and UNC-ish inputs early.
  if (/^[a-zA-Z]:\//.test(p)) {
    throw new RepoPathError(`absolute host paths are not allowed: ${input}`);
  }

  // Leading "/" is treated as the repo root (virtual-root convenience), but a
  // path that looks like a real host absolute (/Users/..., /home/...) is a
  // common agent mistake — strip the leading slash and treat as repo-relative.
  p = p.replace(/^\/+/, "");

  const segments: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      throw new RepoPathError(`path escapes repository root: ${input}`);
    }
    segments.push(seg);
  }
  return segments.join("/");
}

/** True if any path segment is an excluded directory. */
export function isExcludedPath(relPath: string): boolean {
  if (!relPath) return false;
  const segs = relPath.split("/");
  return segs.some((s) => DEFAULT_EXCLUDE_DIRS.includes(s));
}

/**
 * Convert a simple glob (`*`, `**`, `?`, `{a,b}`) to a RegExp anchored to a
 * full repo-relative path. Good enough for the targeted-discovery patterns the
 * prompt asks for; not a full minimatch.
 */
export function globToRegExp(glob: string): RegExp {
  const normalized = normalizeRepoPath(glob) || "**";
  let re = "";
  for (let i = 0; i < normalized.length; i++) {
    const c = normalized[i]!;
    if (c === "*") {
      if (normalized[i + 1] === "*") {
        // ** matches across path separators
        re += ".*";
        i++;
        if (normalized[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      const end = normalized.indexOf("}", i);
      if (end > i) {
        const alts = normalized
          .slice(i + 1, end)
          .split(",")
          .map((a) => a.replace(/[.+^${}()|[\]\\]/g, "\\$&"));
        re += `(?:${alts.join("|")})`;
        i = end;
      } else {
        re += "\\{";
      }
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}
