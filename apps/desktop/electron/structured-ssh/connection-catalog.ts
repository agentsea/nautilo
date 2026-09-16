import { constants as fsConstants } from "node:fs";
import type { Dirent } from "node:fs";
import * as nodeFs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import * as nodePath from "node:path";

import { parse as parseToml } from "smol-toml";

import { isCanonicalSshHost } from "./contracts.ts";

export const NAUTILO_SSH_PROFILE_MAX_FILES = 128;
const NAUTILO_SSH_PROFILE_MAX_BYTES = 64 * 1024;
const MAX_PROFILE_NAME_BYTES = 253;
const MAX_REMOTE_USER_BYTES = 64;
const MAX_PATH_BYTES = 4 * 1024;
const REMOTE_USER = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

export type StructuredSshConnectionSourceKind = "explicit" | "openssh" | "nautilo-profile";

export interface NautiloSshConnection {
  readonly source: { readonly kind: "nautilo-profile"; readonly name: string };
  readonly destination: { readonly host: string; readonly remoteUser: string; readonly port: number };
  /** Electron-private; never include in summaries, relay payloads, or diagnostics. */
  readonly identityFile?: string;
  /** Electron-private; never include in summaries, relay payloads, or diagnostics. */
  readonly knownHostsFile?: string;
}

export type NautiloSshConnectionCatalogFailureCode =
  | "connection_catalog_malformed"
  | "connection_catalog_unreadable"
  | "connection_catalog_overflow"
  | "connection_ambiguous";

export interface NautiloSshConnectionCatalogFailure {
  readonly ok: false;
  readonly code: NautiloSshConnectionCatalogFailureCode;
  readonly phase: "profile_catalog";
  readonly complete: false;
  readonly observed: { readonly profileFiles: number; readonly matchingProfiles: number; readonly bytes: number };
  readonly configuredBound?: { readonly profileFiles?: number; readonly profileBytes?: number };
  readonly retrySafe: true;
  readonly stateChanged: false;
  readonly recovery: "repair_profile" | "reduce_catalog" | "choose_connection";
}

export type NautiloSshConnectionResult =
  | { readonly ok: true; readonly connections: readonly NautiloSshConnection[]; readonly observed: { readonly profileFiles: number; readonly matchingProfiles: number; readonly bytes: number } }
  | NautiloSshConnectionCatalogFailure;

export interface NautiloSshConnectionCatalogDependencies {
  readonly homeDirectory?: string;
  readonly fs?: {
    readdir(path: string, options: { readonly withFileTypes: true; readonly encoding: "utf8" }): Promise<Dirent[]>;
    open(path: string, flags: number): Promise<FileHandle>;
  };
}

function failure(
  code: NautiloSshConnectionCatalogFailureCode,
  profileFiles: number,
  matchingProfiles: number,
  bytes = 0,
): NautiloSshConnectionCatalogFailure {
  return {
    ok: false,
    code,
    phase: "profile_catalog",
    complete: false,
    observed: { profileFiles, matchingProfiles, bytes },
    ...(code === "connection_catalog_overflow" ? { configuredBound: { profileFiles: NAUTILO_SSH_PROFILE_MAX_FILES, profileBytes: NAUTILO_SSH_PROFILE_MAX_BYTES } } : {}),
    retrySafe: true,
    stateChanged: false,
    recovery: code === "connection_ambiguous" ? "choose_connection" : code === "connection_catalog_overflow" ? "reduce_catalog" : "repair_profile",
  };
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim() && Buffer.byteLength(value, "utf8") <= maximum && !/[\0\r\n]/.test(value);
}

function canonicalHost(value: unknown): string | null {
  if (!boundedString(value, MAX_PROFILE_NAME_BYTES)) return null;
  const canonical = value.toLowerCase();
  return isCanonicalSshHost(canonical) ? canonical : null;
}

function canonicalUser(value: unknown): string | null {
  return boundedString(value, MAX_REMOTE_USER_BYTES) && REMOTE_USER.test(value) ? value : null;
}

function canonicalPort(value: unknown): number | null {
  if (value === undefined) return 22;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 65_535 ? value : null;
}

function privatePath(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return boundedString(value, MAX_PATH_BYTES) && !/[\t%$'"\\]/.test(value) && (value.startsWith("~/") || nodePath.isAbsolute(value)) ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function connectionFromProfile(filename: string, raw: unknown, reference: string): NautiloSshConnection | null | "malformed" {
  const profile = record(raw);
  const filenameName = filename.slice(0, -".toml".length);
  const filenameAlias = canonicalHost(filenameName);
  if (profile === null) return filenameAlias === reference ? "malformed" : null;
  const declaredName = typeof profile["name"] === "string" ? profile["name"] : filenameName;
  const name = canonicalHost(declaredName);
  const domain = profile["domain"] === undefined ? null : canonicalHost(profile["domain"]);
  const ssh = record(profile["ssh"]);
  const sshHost = ssh === null ? null : canonicalHost(ssh["host"]);
  const aliases = [filenameAlias, name, domain, sshHost].filter((value): value is string => value !== null);
  if (!aliases.includes(reference)) return null;
  if (profile["transport"] !== "remote" || name === null || ssh === null || sshHost === null) return "malformed";
  const remoteUser = canonicalUser(ssh["user"]);
  const port = canonicalPort(ssh["port"]);
  const identityFile = privatePath(ssh["identity_file"]);
  const knownHostsFile = privatePath(ssh["known_hosts_file"]);
  if (remoteUser === null || port === null || identityFile === null || knownHostsFile === null) return "malformed";
  return Object.freeze({
    source: Object.freeze({ kind: "nautilo-profile", name }),
    destination: Object.freeze({ host: sshHost, remoteUser, port }),
    ...(identityFile === undefined ? {} : { identityFile }),
    ...(knownHostsFile === undefined ? {} : { knownHostsFile }),
  });
}

/**
 * Read only Nautilo's declared remote profiles. This source is bounded and
 * O_NOFOLLOW-only; public failures identify phase/scope without leaking a
 * filesystem path, key location, or parser exception.
 */
export async function resolveNautiloSshConnection(
  rawReference: string,
  dependencies: NautiloSshConnectionCatalogDependencies = {},
): Promise<NautiloSshConnectionResult> {
  const reference = canonicalHost(rawReference);
  if (reference === null) return { ok: true, connections: [], observed: { profileFiles: 0, matchingProfiles: 0, bytes: 0 } };
  const homeDirectory = dependencies.homeDirectory ?? homedir();
  if (!nodePath.isAbsolute(homeDirectory)) return failure("connection_catalog_unreadable", 0, 0);
  const fs = dependencies.fs ?? nodeFs;
  const profilesDirectory = nodePath.join(homeDirectory, ".nautilo", "profiles");
  let entries: Dirent[];
  try {
    entries = await fs.readdir(profilesDirectory, { withFileTypes: true, encoding: "utf8" });
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { ok: true, connections: [], observed: { profileFiles: 0, matchingProfiles: 0, bytes: 0 } }
      : failure("connection_catalog_unreadable", 0, 0);
  }
  const profileEntries = entries.filter((entry) => entry.name.endsWith(".toml")).sort((left, right) => left.name.localeCompare(right.name));
  if (profileEntries.length > NAUTILO_SSH_PROFILE_MAX_FILES) return failure("connection_catalog_overflow", profileEntries.length, 0);
  const matches: NautiloSshConnection[] = [];
  let observedBytes = 0;
  for (const entry of profileEntries) {
    // Every .toml source participates in completeness. A broken file whose
    // filename does not happen to match today may still declare the requested
    // alias, so skipping it would turn uncertainty into a false not-found.
    if (!entry.isFile() || entry.isSymbolicLink()) {
      return failure("connection_catalog_unreadable", profileEntries.length, matches.length, observedBytes);
    }
    let handle: FileHandle | undefined;
    let bytes: string;
    try {
      handle = await fs.open(nodePath.join(profilesDirectory, entry.name), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 0 || stat.size > NAUTILO_SSH_PROFILE_MAX_BYTES) throw new Error("profile unreadable");
      bytes = await handle.readFile("utf8");
    } catch {
      return failure("connection_catalog_unreadable", profileEntries.length, matches.length, observedBytes);
    } finally {
      try { await handle?.close(); } catch { /* Read-only cleanup. */ }
    }
    observedBytes += Buffer.byteLength(bytes, "utf8");
    let parsed: unknown;
    try { parsed = parseToml(bytes); } catch {
      return failure("connection_catalog_malformed", profileEntries.length, matches.length, observedBytes);
    }
    const candidate = connectionFromProfile(entry.name, parsed, reference);
    if (candidate === "malformed") return failure("connection_catalog_malformed", profileEntries.length, matches.length, observedBytes);
    if (candidate !== null) matches.push(candidate);
  }
  if (matches.length > 1) return failure("connection_ambiguous", profileEntries.length, matches.length, observedBytes);
  return { ok: true, connections: Object.freeze(matches), observed: { profileFiles: profileEntries.length, matchingProfiles: matches.length, bytes: observedBytes } };
}
