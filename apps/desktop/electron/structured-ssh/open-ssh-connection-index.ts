import { constants as fsConstants } from "node:fs";
import type { Dirent, Stats } from "node:fs";
import * as nodeFs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import * as nodePath from "node:path";

/** Bounds defend the local discovery pass; failures expose the exhausted bound. */
const OPEN_SSH_CONNECTION_INDEX_MAX_FILES = 128;
export const OPEN_SSH_CONNECTION_INDEX_MAX_RECORDS = 256;
const OPEN_SSH_CONNECTION_INDEX_MAX_BYTES = 256 * 1024;
const OPEN_SSH_CONNECTION_INDEX_MAX_FILE_BYTES = 64 * 1024;
export const OPEN_SSH_CONNECTION_INDEX_MAX_DEPTH = 8;

const MAX_ALIAS_BYTES = 253;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export interface OpenSshFiniteAliasRecord {
  /** A declaration, rather than an alias: `Host alpha beta` is one record. */
  readonly aliases: readonly string[];
}

export type OpenSshConnectionIndexFailureCode =
  | "openssh_connection_catalog_unreadable"
  | "openssh_connection_catalog_malformed"
  | "openssh_connection_catalog_overflow"
  | "openssh_connection_catalog_unsupported_match"
  | "openssh_connection_catalog_unsupported_source";

export interface OpenSshConnectionIndexFailure {
  readonly ok: false;
  readonly code: OpenSshConnectionIndexFailureCode;
  readonly phase: "openssh_catalog";
  readonly complete: false;
  readonly observed: { readonly configFiles: number; readonly hostRecords: number; readonly bytes: number };
  readonly configuredBound?: { readonly configFiles?: number; readonly hostRecords?: number; readonly bytes?: number; readonly includeDepth?: number };
  readonly retrySafe: true;
  readonly stateChanged: false;
  readonly recovery: "repair_ssh_config" | "reduce_catalog";
}

export type OpenSshConnectionIndexResult =
  | { readonly ok: true; readonly records: readonly OpenSshFiniteAliasRecord[]; readonly observed: { readonly configFiles: number; readonly hostRecords: number; readonly bytes: number } }
  | OpenSshConnectionIndexFailure;

export interface OpenSshConnectionIndexDependencies {
  readonly homeDirectory?: string;
  readonly fs?: {
    readdir(path: string, options: { readonly withFileTypes: true; readonly encoding: "utf8" }): Promise<Dirent[]>;
    lstat(path: string): Promise<Stats>;
    open(path: string, flags: number): Promise<FileHandle>;
  };
}

interface IndexState {
  configFiles: number;
  hostRecords: number;
  bytes: number;
  readonly records: OpenSshFiniteAliasRecord[];
}

interface ActiveState { active: boolean; }

function failure(code: OpenSshConnectionIndexFailureCode, state: IndexState, bound?: OpenSshConnectionIndexFailure["configuredBound"]): OpenSshConnectionIndexFailure {
  return {
    ok: false,
    code,
    phase: "openssh_catalog",
    complete: false,
    observed: { configFiles: state.configFiles, hostRecords: state.hostRecords, bytes: state.bytes },
    ...(bound === undefined ? {} : { configuredBound: bound }),
    retrySafe: true,
    stateChanged: false,
    recovery: code === "openssh_connection_catalog_overflow" ? "reduce_catalog" : "repair_ssh_config",
  };
}

function canonicalAlias(value: string): string | null {
  if (value.length === 0 || Buffer.byteLength(value, "utf8") > MAX_ALIAS_BYTES || /[\0\r\n\s@]/.test(value)) return null;
  const canonical = value.toLowerCase();
  return !canonical.endsWith(".") && canonical.split(".").every((label) => HOST_LABEL.test(label)) ? canonical : null;
}

/** Tokenize the OpenSSH source grammar needed for Host and Include discovery. */
function tokens(line: string): string[] | null {
  const result: string[] = [];
  let token = "";
  let quoted = false;
  let escaping = false;
  let haveToken = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (escaping) {
      token += character;
      haveToken = true;
      escaping = false;
      continue;
    }
    if (character === "\\") {
      escaping = true;
      haveToken = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      haveToken = true;
      continue;
    }
    if (!quoted && character === "#") break;
    if (!quoted && /[ \t]/.test(character)) {
      if (haveToken) result.push(token);
      token = "";
      haveToken = false;
      continue;
    }
    token += character;
    haveToken = true;
  }
  if (quoted || escaping) return null;
  if (haveToken) result.push(token);
  return result;
}

function directive(rawTokens: readonly string[]): { readonly key: string; readonly values: readonly string[] } | null {
  if (rawTokens.length === 0) return null;
  const first = rawTokens[0]!;
  const equals = first.indexOf("=");
  const key = (equals < 0 ? first : first.slice(0, equals)).toLowerCase();
  const values = equals < 0 ? rawTokens.slice(1) : [first.slice(equals + 1), ...rawTokens.slice(1)];
  return key.length > 0 && /^[a-z][a-z0-9]*$/.test(key) ? { key, values } : null;
}

function hasGlob(value: string): boolean { return value.includes("*") || value.includes("?") || value.includes("["); }
function globRegExp(pattern: string): RegExp | null {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*") expression += "[^/]*";
    else if (character === "?") expression += "[^/]";
    else if (character === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end < 0) return null;
      const range = pattern.slice(index + 1, end);
      if (range.length === 0 || /[\\/]/.test(range)) return null;
      expression += `[${range}]`;
      index = end;
    } else expression += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  try { return new RegExp(`${expression}$`); } catch { return null; }
}

function containedUserSshPath(homeDirectory: string, path: string): boolean {
  const root = nodePath.resolve(homeDirectory, ".ssh");
  const candidate = nodePath.resolve(path);
  return candidate === root || candidate.startsWith(`${root}${nodePath.sep}`);
}

async function expandInclude(pattern: string, homeDirectory: string, fs: NonNullable<OpenSshConnectionIndexDependencies["fs"]>): Promise<string[] | OpenSshConnectionIndexFailureCode> {
  let expanded: string;
  let traversalRoot: string;
  if (pattern.startsWith("~/")) {
    expanded = nodePath.join(homeDirectory, pattern.slice(2));
    traversalRoot = nodePath.resolve(homeDirectory);
  } else if (nodePath.isAbsolute(pattern)) {
    expanded = nodePath.normalize(pattern);
    traversalRoot = nodePath.parse(expanded).root;
  }
  else {
    if (pattern.length === 0 || pattern.split(/[\\/]/).includes("..")) return "openssh_connection_catalog_unsupported_source";
    expanded = nodePath.join(homeDirectory, ".ssh", pattern);
    traversalRoot = nodePath.resolve(homeDirectory);
  }
  if (!nodePath.isAbsolute(expanded) || (pattern.startsWith("~/") || !nodePath.isAbsolute(pattern)) && !containedUserSshPath(homeDirectory, expanded)) return "openssh_connection_catalog_unsupported_source";
  const relative = nodePath.relative(traversalRoot, expanded).split(nodePath.sep).filter(Boolean);
  let candidates = [traversalRoot];
  for (let segmentIndex = 0; segmentIndex < relative.length; segmentIndex += 1) {
    const segment = relative[segmentIndex]!;
    const finalSegment = segmentIndex === relative.length - 1;
    if (segment === "." || segment === "..") return "openssh_connection_catalog_unsupported_source";
    const matcher = hasGlob(segment) ? globRegExp(segment) : null;
    if (hasGlob(segment) && matcher === null) return "openssh_connection_catalog_unsupported_source";
    const next: string[] = [];
    for (const candidate of candidates) {
      if (matcher === null) {
        const nextPath = nodePath.join(candidate, segment);
        try {
          const stat = await fs.lstat(nextPath);
          if (stat.isSymbolicLink()) return "openssh_connection_catalog_unreadable";
          if (finalSegment || stat.isDirectory()) next.push(nextPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "openssh_connection_catalog_unreadable";
        }
        continue;
      }
      let entries: Dirent[];
      try { entries = await fs.readdir(candidate, { withFileTypes: true, encoding: "utf8" }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        return "openssh_connection_catalog_unreadable";
      }
      for (const entry of entries) {
        if (!matcher.test(entry.name)) continue;
        if (entry.isSymbolicLink()) return "openssh_connection_catalog_unreadable";
        if (finalSegment || entry.isDirectory()) next.push(nodePath.join(candidate, entry.name));
      }
    }
    candidates = next.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  }
  return candidates;
}

function hostPatternMatches(pattern: string, reference: string): boolean | null {
  const matcher = globRegExp(pattern.toLowerCase());
  return matcher === null ? null : matcher.test(reference);
}

async function readSource(path: string, fs: NonNullable<OpenSshConnectionIndexDependencies["fs"]>, state: IndexState): Promise<{ readonly content: string } | { readonly code: OpenSshConnectionIndexFailureCode } | { readonly missing: true }> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 0) return { code: "openssh_connection_catalog_unreadable" };
    if (stat.size > OPEN_SSH_CONNECTION_INDEX_MAX_FILE_BYTES) return { code: "openssh_connection_catalog_overflow" };
    if (state.bytes + stat.size > OPEN_SSH_CONNECTION_INDEX_MAX_BYTES) return { code: "openssh_connection_catalog_overflow" };
    const content = await handle.readFile("utf8");
    if (Buffer.byteLength(content, "utf8") !== stat.size || /\0/.test(content)) return { code: "openssh_connection_catalog_malformed" };
    state.configFiles += 1;
    state.bytes += stat.size;
    return { content };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { missing: true };
    return { code: "openssh_connection_catalog_unreadable" };
  } finally {
    try { await handle?.close(); } catch { /* Read-only cleanup. */ }
  }
}

async function visit(
  path: string,
  depth: number,
  ancestors: ReadonlySet<string>,
  homeDirectory: string,
  fs: NonNullable<OpenSshConnectionIndexDependencies["fs"]>,
  state: IndexState,
  activeState: ActiveState,
  reference: string,
  missingAllowed: boolean,
): Promise<OpenSshConnectionIndexFailure | null> {
  if (depth > OPEN_SSH_CONNECTION_INDEX_MAX_DEPTH) return failure("openssh_connection_catalog_overflow", state, { includeDepth: OPEN_SSH_CONNECTION_INDEX_MAX_DEPTH });
  if (ancestors.has(path)) return failure("openssh_connection_catalog_malformed", state);
  if (state.configFiles >= OPEN_SSH_CONNECTION_INDEX_MAX_FILES) return failure("openssh_connection_catalog_overflow", state, { configFiles: OPEN_SSH_CONNECTION_INDEX_MAX_FILES });
  const content = await readSource(path, fs, state);
  if ("missing" in content) return missingAllowed ? null : failure("openssh_connection_catalog_unreadable", state);
  if ("code" in content) {
    return failure(content.code, state, content.code === "openssh_connection_catalog_overflow" ? { bytes: OPEN_SSH_CONNECTION_INDEX_MAX_BYTES } : undefined);
  }
  const chain = new Set(ancestors); chain.add(path);
  for (const line of content.content.split("\n")) {
    const rawTokens = tokens(line);
    if (rawTokens === null) return failure("openssh_connection_catalog_malformed", state);
    const parsed = directive(rawTokens);
    if (parsed === null) {
      if (rawTokens.length === 0) continue;
      return failure("openssh_connection_catalog_malformed", state);
    }
    if (parsed.key === "match") return failure("openssh_connection_catalog_unsupported_match", state);
    if (parsed.key === "include") {
      if (!activeState.active) continue;
      if (parsed.values.length === 0) return failure("openssh_connection_catalog_malformed", state);
      for (const pattern of parsed.values) {
        const included = await expandInclude(pattern, homeDirectory, fs);
        if (!Array.isArray(included)) return failure(included, state);
        for (const includePath of included) {
          const nested = await visit(includePath, depth + 1, chain, homeDirectory, fs, state, activeState, reference, true);
          if (nested !== null) return nested;
        }
      }
      continue;
    }
    if (parsed.key !== "host") continue;
    if (parsed.values.length === 0) return failure("openssh_connection_catalog_malformed", state);
    const aliases: string[] = [];
    let positiveMatch = false;
    let negatedMatch = false;
    for (const rawPattern of parsed.values) {
      const negated = rawPattern.startsWith("!");
      const pattern = negated ? rawPattern.slice(1) : rawPattern;
      if (pattern.length === 0) return failure("openssh_connection_catalog_malformed", state);
      const matches = hostPatternMatches(pattern, reference);
      if (matches === null) return failure("openssh_connection_catalog_malformed", state);
      if (matches && negated) negatedMatch = true;
      if (matches && !negated) positiveMatch = true;
      if (negated || hasGlob(pattern)) continue;
      const alias = canonicalAlias(pattern);
      if (alias === null) return failure("openssh_connection_catalog_malformed", state);
      if (!aliases.includes(alias)) aliases.push(alias);
    }
    activeState.active = positiveMatch && !negatedMatch;
    if (aliases.length === 0) continue;
    if (state.hostRecords >= OPEN_SSH_CONNECTION_INDEX_MAX_RECORDS) return failure("openssh_connection_catalog_overflow", state, { hostRecords: OPEN_SSH_CONNECTION_INDEX_MAX_RECORDS });
    state.hostRecords += 1;
    if (activeState.active && aliases.includes(reference)) state.records.push(Object.freeze({ aliases: Object.freeze(aliases) }));
  }
  return null;
}

/**
 * Enumerates only finite Host declarations. It deliberately does not infer
 * effective configuration: ssh -G remains the authority for that later step.
 */
export async function resolveOpenSshFiniteAlias(
  rawReference: string,
  dependencies: OpenSshConnectionIndexDependencies = {},
): Promise<OpenSshConnectionIndexResult> {
  const reference = canonicalAlias(rawReference);
  const state: IndexState = { configFiles: 0, hostRecords: 0, bytes: 0, records: [] };
  if (reference === null) return { ok: true, records: [], observed: { configFiles: 0, hostRecords: 0, bytes: 0 } };
  const homeDirectory = dependencies.homeDirectory ?? homedir();
  if (!nodePath.isAbsolute(homeDirectory)) return failure("openssh_connection_catalog_unreadable", state);
  const fs = dependencies.fs ?? nodeFs;
  const root = nodePath.join(homeDirectory, ".ssh", "config");
  // A missing root config is an ordinary empty source; an include that names a
  // missing source is also OpenSSH's ordinary no-match behavior.
  let rootExists = true;
  try { await fs.open(root, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).then((handle) => handle.close()); }
  catch (error) { rootExists = (error as NodeJS.ErrnoException).code !== "ENOENT"; if (rootExists) return failure("openssh_connection_catalog_unreadable", state); }
  if (!rootExists) return { ok: true, records: [], observed: { configFiles: 0, hostRecords: 0, bytes: 0 } };
  const incomplete = await visit(root, 0, new Set(), homeDirectory, fs, state, { active: true }, reference, false);
  if (incomplete !== null) return incomplete;
  return { ok: true, records: Object.freeze(state.records), observed: { configFiles: state.configFiles, hostRecords: state.hostRecords, bytes: state.bytes } };
}
