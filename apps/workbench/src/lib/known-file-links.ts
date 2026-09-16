import { useSyncExternalStore } from "react";
import { readFileContext } from "../adapters/file-context-ref";
import { basename } from "./file-preview";
import {
  isUnderRoot,
  relativeFromWorkspace,
} from "../components/browser-column/cited-paths";

const FILE_LINK_HASH_PREFIX = "#nautilo-file:";

/**
 * A filesystem file the genie may mention in prose. Opens via the FS
 * reader target (`fsOpenFileTarget(path, rootPath)`).
 */
export interface KnownFsRef {
  kind: "fs";
  path: string;
  rootPath: string;
  label: string;
  source: "tool" | "file-tree";
}

/**
 * A workspace artifact (logical `artifacts/...` namespace) the genie may
 * mention in prose. Opens via the artifact reader target, which needs the
 * INTERNAL `ArtifactDto.id` (URL-safe, the only valid `:id` for
 * `/api/workspace/artifacts/:id`) plus `mimeType`. D322 — sourced
 * list-based from `listWorkspaceArtifacts`, not from an FS root, so it
 * deliberately carries no `rootPath`.
 */
export interface KnownArtifactRef {
  kind: "artifact";
  path: string;
  /** Internal `ArtifactDto.id`, NOT the agent-chosen external `artifactId`. */
  artifactId: string;
  mimeType: string;
  label: string;
  source: "artifact-list";
}

export type KnownFileRef = KnownFsRef | KnownArtifactRef;

/** Minimal shape D322's list source feeds in (subset of `ArtifactDto`). */
export interface KnownArtifactInput {
  id: string;
  path: string;
  mimeType: string;
}

let fsRefs = new Map<string, KnownFsRef>();
let artifactRefs = new Map<string, KnownArtifactRef>();
let refsSnapshot: readonly KnownFileRef[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function rebuildSnapshot(): void {
  refsSnapshot = [...fsRefs.values(), ...artifactRefs.values()];
  emit();
}

function snapshot(): readonly KnownFileRef[] {
  return refsSnapshot;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function rootForKnownPath(filePath: string): string | null {
  const ctx = readFileContext();
  const roots = [ctx.workspacePath, ctx.currentFolder].filter(
    (root): root is string => typeof root === "string" && root.length > 0,
  );
  return roots.find((root) => isUnderRoot(root, filePath)) ?? null;
}

export function registerKnownFilePath(
  filePath: string,
  source: KnownFsRef["source"] = "tool",
): void {
  const rootPath = rootForKnownPath(filePath);
  if (!rootPath) return;
  fsRefs = new Map(fsRefs);
  fsRefs.set(filePath, {
    kind: "fs",
    path: filePath,
    rootPath,
    label: basename(filePath),
    source,
  });
  rebuildSnapshot();
}

/**
 * D322 — replace the full set of known workspace artifacts. List-based:
 * the caller passes the current `listWorkspaceArtifacts` result, so this
 * naturally handles creates / renames / deletes (a removed artifact simply
 * isn't in the next list). No-ops (skips the emit) when the set is
 * unchanged, so it is safe to call on every `WorkspaceArtifactEvent`.
 */
export function setKnownArtifacts(artifacts: readonly KnownArtifactInput[]): void {
  const next = new Map<string, KnownArtifactRef>();
  for (const a of artifacts) {
    if (!a.path || !a.id) continue;
    next.set(a.path, {
      kind: "artifact",
      path: a.path,
      artifactId: a.id,
      mimeType: a.mimeType,
      label: basename(a.path),
      source: "artifact-list",
    });
  }
  if (artifactRefsEqual(artifactRefs, next)) return;
  artifactRefs = next;
  rebuildSnapshot();
}

function artifactRefsEqual(
  a: Map<string, KnownArtifactRef>,
  b: Map<string, KnownArtifactRef>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [path, ref] of a) {
    const other = b.get(path);
    if (
      !other ||
      other.artifactId !== ref.artifactId ||
      other.mimeType !== ref.mimeType
    ) {
      return false;
    }
  }
  return true;
}

export function getKnownFileRef(filePath: string): KnownFileRef | null {
  return fsRefs.get(filePath) ?? artifactRefs.get(filePath) ?? null;
}

export function useKnownFileRefs(): readonly KnownFileRef[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/([\\[\]])/g, "\\$1");
}

function linkFor(ref: KnownFileRef, label: string): string {
  return `[${escapeMarkdownLabel(label)}](${FILE_LINK_HASH_PREFIX}${encodeURIComponent(ref.path)})`;
}

function aliasesFor(ref: KnownFileRef): string[] {
  if (ref.kind === "artifact") {
    return [...new Set([ref.path, ref.label].filter(Boolean))];
  }
  const rel = relativeFromWorkspace(ref.rootPath, ref.path);
  return [...new Set([
    ref.path,
    rel && rel !== ref.path ? rel : "",
    ref.label,
  ].filter(Boolean))];
}

export function decodeKnownFileHref(href: string): string | null {
  const hashIndex = href.indexOf(FILE_LINK_HASH_PREFIX);
  if (hashIndex === -1) return null;
  try {
    return decodeURIComponent(href.slice(hashIndex + FILE_LINK_HASH_PREFIX.length));
  } catch {
    return null;
  }
}

/** A known path written as inline code, e.g. `artifacts/x.html`, becomes a
 * clickable link whose label keeps the monospace styling. */
function inlineCodeLinkFor(ref: KnownFileRef, alias: string): string {
  return `[\`${escapeMarkdownLabel(alias)}\`](${FILE_LINK_HASH_PREFIX}${encodeURIComponent(ref.path)})`;
}

export function linkKnownFileMentions(
  text: string,
  knownRefs: readonly KnownFileRef[],
): string {
  if (knownRefs.length === 0 || text.length === 0) return text;

  const byAlias = new Map<string, KnownFileRef[]>();
  for (const ref of knownRefs) {
    for (const alias of aliasesFor(ref)) {
      byAlias.set(alias, [...(byAlias.get(alias) ?? []), ref]);
    }
  }

  const uniqueAliases = [...byAlias.entries()]
    .filter(([, matches]) => matches.length === 1)
    .map(([alias, matches]) => ({ alias, ref: matches[0] }))
    .sort((a, b) => b.alias.length - a.alias.length);
  const aliasMap = new Map(uniqueAliases.map(({ alias, ref }) => [alias, ref]));

  // Tokenize every emitted replacement (and every protected span) so later
  // passes never re-process generated link markup or text inside code.
  const tokens: string[] = [];
  const stash = (markup: string): string => {
    tokens.push(markup);
    return `\uE000NFL${tokens.length - 1}\uE000`;
  };

  let out = text;

  // 1. Protect fenced code blocks entirely — never inject links into a
  //    ```code``` example the agent is showing verbatim.
  out = out.replace(/```[\s\S]*?```/g, (m) => stash(m));

  // 2. Inline code spans. A genie naturally writes a filename in backticks
  //    (`artifacts/x.html`); turn a known path into a clickable monospace
  //    link instead of injecting link markup *inside* the code span (which
  //    would render as flat literal text). Non-path code spans are stashed
  //    so the plain-text pass below can't reach inside them.
  out = out.replace(/`([^`\n]+)`/g, (full: string, inner: string) => {
    const ref = aliasMap.get(inner.trim());
    return ref ? stash(inlineCodeLinkFor(ref, inner.trim())) : stash(full);
  });

  // 3. Plain-text occurrences (longest alias first).
  for (const { alias, ref } of uniqueAliases) {
    const pattern = new RegExp(`(?<![\\w/\\\\.-])${escapeRegex(alias)}(?![\\w/\\\\-])`, "g");
    out = out.replace(pattern, () => stash(linkFor(ref, alias)));
  }

  // 4. Restore stashed markup.
  out = out.replace(/\uE000NFL(\d+)\uE000/g, (_m, i: string) => tokens[Number(i)] ?? "");
  return out;
}
