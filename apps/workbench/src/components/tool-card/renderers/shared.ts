/**
 * D083 Phase 2b — shared pure helpers used by the per-tool
 * renderers (read_file, write_file, edit_file, list_directory,
 * search_memory, delete_file).
 *
 * Live here (not in tool-card-helpers.ts which owns the generic
 * card state machine) because these are all RESULT PARSERS — they
 * crack open the `resultText` string that crossed the WS and make
 * it legible. No React, no framework coupling, all unit-tested.
 *
 * Design principle: defensive parsers. Each returns a typed shape
 * when the input matches the expected format, and degrades to
 * `{ raw: resultText }` when it doesn't. Renderers check which
 * field is present and render accordingly — this way a future
 * tool version that changes its output format just falls back to
 * the raw view instead of breaking the card.
 */

// ---------------------------------------------------------------------------
// Arg pickers — one-liner collapse-row fodder
// ---------------------------------------------------------------------------

/**
 * Pull a path-shaped arg from common key names used across the
 * path args used by filesystem-oriented tools. Returns the first matching string,
 * or "" if none present.
 */
export function pickPath(args: Record<string, unknown>): string {
  const keys = ["path", "file", "filename", "target", "filepath"];
  for (const k of keys) {
    const v = args[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "";
}

export function pickZonedPath(args: Record<string, unknown>): string {
  const path = pickPath(args);
  const zone = args["zone"];
  if (typeof zone === "string" && zone.length > 0 && path) {
    return `${zone}/${path}`;
  }
  return path;
}

/** D121-P6 — workspace HTML artifact paths for tool-card affordances. */
export function workspaceLogicalPathLooksHtml(args: Record<string, unknown>): boolean {
  if (args["zone"] !== "workspace") return false;
  const p = pickPath(args).toLowerCase();
  return p.endsWith(".html") || p.endsWith(".htm");
}

export function pickLineRange(
  args: Record<string, unknown>,
): { start: number; end: number } | null {
  const pairs: Array<[string, string]> = [
    ["startLine", "endLine"],
    ["start", "end"],
    ["fromLine", "toLine"],
  ];
  for (const [s, e] of pairs) {
    const sv = args[s];
    const ev = args[e];
    if (typeof sv === "number" && typeof ev === "number") {
      return { start: sv, end: ev };
    }
  }
  return null;
}

export function pickQuery(args: Record<string, unknown>): string {
  const keys = ["query", "pattern", "q", "term"];
  for (const k of keys) {
    const v = args[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Text preview — truncate by line, mark the excess
// ---------------------------------------------------------------------------

export interface PreviewResult {
  preview: string;
  truncated: boolean;
  totalLines: number;
  shownLines: number;
}

/**
 * Cap a (possibly huge) string at N lines. Adds a trailing
 * "… (M more lines)" marker when truncated. Used by read/write/edit
 * renderers so a 5000-line file doesn't blow the viewport.
 */
export function previewLines(text: string, maxLines: number): PreviewResult {
  if (typeof text !== "string" || text.length === 0) {
    return { preview: "", truncated: false, totalLines: 0, shownLines: 0 };
  }
  const allLines = text.split(/\r?\n/);
  // Drop a single trailing empty line (text ending in \n is common).
  if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
    allLines.pop();
  }
  const totalLines = allLines.length;
  if (totalLines <= maxLines) {
    return { preview: text.trimEnd(), truncated: false, totalLines, shownLines: totalLines };
  }
  const shown = allLines.slice(0, maxLines);
  const remaining = totalLines - maxLines;
  return {
    preview: `${shown.join("\n")}\n… (${remaining} more line${remaining === 1 ? "" : "s"})`,
    truncated: true,
    totalLines,
    shownLines: maxLines,
  };
}

// ---------------------------------------------------------------------------
// Grep / search_memory result parser
// ---------------------------------------------------------------------------

export interface SearchMatch {
  path: string;
  line: number | null;
  preview: string;
}

export interface ParsedSearchResult {
  header?: string;
  matches?: SearchMatch[];
  raw?: string;
}

/**
 * Parse the canonical grep-style search output:
 *
 *   3 matches for "query" in home (scanned 127 files):
 *     home/notes.md:42 — matched preview content
 *     home/other.md:18 — another preview
 *
 * Tolerant to:
 *   - 0-match "No matches for ... " output (caller renders "no matches")
 *   - Variations in the dash separator (—, -, :)
 *   - Missing line number (shows as null)
 *   - Non-conforming strings (returned as raw)
 */
export function parseSearchResult(resultText: string | undefined): ParsedSearchResult {
  if (resultText === undefined) return {};
  const trimmed = resultText.trim();
  if (trimmed.length === 0) return {};

  // "No matches" path — still show the header so the user sees the
  // tool ran, just with an empty match list.
  if (/^No matches\b/i.test(trimmed)) {
    return { header: trimmed, matches: [] };
  }

  const lines = trimmed.split(/\r?\n/);
  const first = lines[0] ?? "";
  const headerRe = /^(\d+)\s+match(?:es)?\s+for\s+/i;
  if (!headerRe.test(first)) {
    return { raw: resultText };
  }

  const matches: SearchMatch[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]?.trim() ?? "";
    if (line.length === 0) continue;
    // <path>:<line> (— | - | :) <preview>    OR    <path>:<line><preview>
    const m = line.match(/^(\S+?):(\d+)\s*[—:-]\s*(.*)$/);
    if (m) {
      matches.push({
        path: m[1],
        line: parseInt(m[2], 10),
        preview: m[3],
      });
      continue;
    }
    // Path-only fallback (no line number).
    const pathOnly = line.match(/^(\S+)\s*[—:-]?\s*(.*)$/);
    if (pathOnly) {
      matches.push({
        path: pathOnly[1],
        line: null,
        preview: pathOnly[2],
      });
    }
  }

  return { header: first, matches };
}

// ---------------------------------------------------------------------------
// list_directory / file:list result parser
// ---------------------------------------------------------------------------

export interface DirectoryEntry {
  name: string;
  /** "dir" when the name ends with "/"; "file" otherwise. */
  kind: "file" | "dir";
}

export interface ParsedListResult {
  entries?: DirectoryEntry[];
  raw?: string;
}

/**
 * Parse directory-listing output. Accepts multiple shapes:
 *
 *   a) Canonical JSON array: [{name, type?}, ...]
 *   b) Newline-separated names (optional trailing "/" = dir)
 *   c) Anything else → `{ raw }`
 *
 * The JSON branch lets a future relay emit structured entries;
 * today the relay emits the plain newline-list form and this
 * degrades to branch (b).
 */
export function parseListResult(resultText: string | undefined): ParsedListResult {
  if (resultText === undefined) return {};
  const trimmed = resultText.trim();
  if (trimmed.length === 0) return { entries: [] };

  // JSON array branch. If the input LOOKS like JSON (starts with `[`)
  // but fails to parse, don't silently fall through to the newline
  // branch — that would treat a truncated/broken JSON blob as a
  // single bizarre filename. A leading `[` is a strong enough
  // signal of intent that we treat the parse failure as "raw".
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        const entries: DirectoryEntry[] = [];
        for (const item of parsed) {
          if (typeof item === "string" && item.length > 0) {
            entries.push({ name: item, kind: item.endsWith("/") ? "dir" : "file" });
          } else if (item && typeof item === "object" && !Array.isArray(item)) {
            const rec = item as Record<string, unknown>;
            const name = rec.name;
            if (typeof name !== "string") continue;
            const t = rec.type;
            const kind: "file" | "dir" =
              t === "dir" || t === "directory" || name.endsWith("/") ? "dir" : "file";
            entries.push({ name, kind });
          }
        }
        return { entries };
      }
      // Parsed but not an array → raw.
      return { raw: resultText };
    } catch {
      // Looked like JSON, didn't parse → raw, NOT newline fallback.
      return { raw: resultText };
    }
  }

  // Newline-separated names branch.
  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  // Heuristic: if the first line looks like a header (e.g. "Contents of
  // /path:"), drop it — the tool's freeform framing shouldn't render
  // as an entry.
  const body =
    /^(contents of|listing of|in |directory|path)/i.test(lines[0] ?? "")
      ? lines.slice(1)
      : lines;

  if (body.length === 0) return { raw: resultText };

  // Defensive: if ANY line contains characters incompatible with a
  // filename (`: ` + multi-word prose), bail to raw — the relay
  // returned English, not a listing.
  const looksLikeListing = body.every((l) => l.length < 300 && !l.includes(". "));
  if (!looksLikeListing) return { raw: resultText };

  const entries: DirectoryEntry[] = body.map((name) => ({
    name,
    kind: name.endsWith("/") ? "dir" : "file",
  }));
  return { entries };
}

// ---------------------------------------------------------------------------
// Generic result classifier — used by renderers to know which branch
// to render when their result format is ambiguous.
// ---------------------------------------------------------------------------

/**
 * Short helper: does the string look like an error message the tool
 * itself returned? (As opposed to a successful result that started
 * with "Error: " by coincidence.) Any string starting with `Error:`
 * or `error:` is treated as a tool-level error and rendered in
 * error-colored form.
 */
export function looksLikeToolError(text: string | undefined): boolean {
  if (!text) return false;
  return /^error\b/i.test(text.trim());
}
