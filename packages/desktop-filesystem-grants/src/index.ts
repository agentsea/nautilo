/**
 * Filesystem-independent schema gate for persisted Desktop Filesystem Grants.
 *
 * This module validates record shape and normalizes lexical paths only. It
 * deliberately does not inspect the filesystem, resolve symlinks, confirm
 * platform authorization, or decide whether a grant may be enforced.
 */

import * as path from "node:path";
import { isCanonicalNautiloInstanceId } from "@nautilo/config/instance-id";

export const DESKTOP_FILESYSTEM_GRANT_SCHEMA_VERSION = 1 as const;

export const DESKTOP_FILESYSTEM_ACCESS_OPERATIONS = [
  "read",
  "create_modify",
  "delete",
  "execute",
] as const;

export type DesktopFilesystemAccessOperation = (typeof DESKTOP_FILESYSTEM_ACCESS_OPERATIONS)[number];

export const DESKTOP_FILESYSTEM_GRANT_ORIGINS = ["user_picker", "approval", "policy_pack"] as const;
export type DesktopFilesystemGrantOrigin = (typeof DESKTOP_FILESYSTEM_GRANT_ORIGINS)[number];

export const DESKTOP_FILESYSTEM_GRANT_LIFETIMES = ["once", "session", "durable"] as const;
export type DesktopFilesystemGrantLifetime = (typeof DESKTOP_FILESYSTEM_GRANT_LIFETIMES)[number];

export interface DesktopFilesystemGrantSubject {
  userId: string;
  instanceId: string;
  relayId: string;
  agentScope: string;
}

/**
 * Filesystem facts captured when a root was selected. `realRoot` is the
 * canonical path after filesystem resolution; device/inode are present only
 * on platforms where Node exposes a safe POSIX identity pair.
 */
export interface DesktopFilesystemGrantFilesystemIdentity {
  realRoot: string;
  device?: number;
  inode?: number;
}

/**
 * The versioned, JSON-safe record stored by the future Electron grant store.
 * `canonicalRoot` and date fields are returned in canonical form by the
 * parser; filesystem identity is parsed but not inspected here.
 */
export interface DesktopFilesystemGrant {
  schemaVersion: typeof DESKTOP_FILESYSTEM_GRANT_SCHEMA_VERSION;
  id: string;
  canonicalRoot: string;
  access: readonly DesktopFilesystemAccessOperation[];
  origin: DesktopFilesystemGrantOrigin;
  lifetime: DesktopFilesystemGrantLifetime;
  subject: DesktopFilesystemGrantSubject;
  createdBy: string;
  createdAt: string;
  policyVersion: number;
  expiresAt?: string;
  platformAuthorization?: string;
  revokedAt?: string;
  /** Most recent successful use, retained for Settings history. */
  lastUsedAt?: string;
  /** Optional for records written before filesystem identity was captured. */
  filesystemIdentity?: DesktopFilesystemGrantFilesystemIdentity;
}

export type DesktopFilesystemGrantValidationErrorCode =
  | "invalid_record"
  | "unknown_schema_version"
  | "unknown_field"
  | "invalid_id"
  | "invalid_canonical_root"
  | "invalid_access"
  | "invalid_origin"
  | "invalid_lifetime"
  | "invalid_subject"
  | "invalid_created_by"
  | "invalid_created_at"
  | "invalid_expires_at"
  | "expired"
  | "invalid_policy_version"
  | "invalid_platform_authorization"
  | "invalid_revoked_at"
  | "invalid_last_used_at"
  | "invalid_filesystem_identity";

export type DesktopFilesystemGrantValidationResult =
  | { ok: true; grant: DesktopFilesystemGrant; revoked: boolean }
  | { ok: false; error: { code: DesktopFilesystemGrantValidationErrorCode; message: string } };

export interface DesktopFilesystemGrantValidationOptions {
  /**
   * Inject a clock for deterministic validation. Defaults to the current
   * time; no clock, filesystem, Electron, or policy state is otherwise read.
   */
  now?: Date;
}

// eslint-disable-next-line no-control-regex -- rejects path/token control bytes in persisted grants
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
const ISO_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const GRANT_KEYS = new Set([
  "schemaVersion",
  "id",
  "canonicalRoot",
  "access",
  "origin",
  "lifetime",
  "subject",
  "createdBy",
  "createdAt",
  "policyVersion",
  "expiresAt",
  "platformAuthorization",
  "revokedAt",
  "lastUsedAt",
  "filesystemIdentity",
]);

const SUBJECT_KEYS = new Set(["userId", "instanceId", "relayId", "agentScope"]);
const FILESYSTEM_IDENTITY_KEYS = new Set(["realRoot", "device", "inode"]);

type UnknownGrantRecord = Record<string, unknown> & {
  schemaVersion?: unknown;
  id?: unknown;
  canonicalRoot?: unknown;
  access?: unknown;
  origin?: unknown;
  lifetime?: unknown;
  subject?: unknown;
  createdBy?: unknown;
  createdAt?: unknown;
  policyVersion?: unknown;
  expiresAt?: unknown;
  platformAuthorization?: unknown;
  revokedAt?: unknown;
  lastUsedAt?: unknown;
  filesystemIdentity?: unknown;
  userId?: unknown;
  instanceId?: unknown;
  relayId?: unknown;
  agentScope?: unknown;
  realRoot?: unknown;
  device?: unknown;
  inode?: unknown;
};

function failure(code: DesktopFilesystemGrantValidationErrorCode, message: string): DesktopFilesystemGrantValidationResult {
  return { ok: false, error: { code, message } };
}

function isRecord(value: unknown): value is UnknownGrantRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(record).every((key) => allowed.has(key));
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseUtcTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !ISO_UTC_TIMESTAMP.test(value)) return undefined;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const canonical = date.toISOString();
  const match = /^(.{19})(?:\.(\d{1,3}))?Z$/.exec(value);
  const expectedCanonical = match ? `${match[1]}.${(match[2] ?? "").padEnd(3, "0")}Z` : undefined;
  return canonical === expectedCanonical ? canonical : undefined;
}

function isOneOf<T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === "string" && values.includes(value);
}

/**
 * Parses a persisted grant fail-closed.
 *
 * It lexically normalizes an absolute root using the host platform's
 * `node:path` semantics. Filesystem existence, realpath identity, symlink
 * safety, TCC, and OS permissions are intentionally outside this schema gate.
 */
export function parseDesktopFilesystemGrant(
  value: unknown,
  options: DesktopFilesystemGrantValidationOptions = {},
): DesktopFilesystemGrantValidationResult {
  if (!isRecord(value)) {
    return failure("invalid_record", "Desktop Filesystem Grant must be an object");
  }
  if (!hasOnlyKeys(value, GRANT_KEYS)) {
    return failure("unknown_field", "Desktop Filesystem Grant contains an unsupported field");
  }
  if (value.schemaVersion !== DESKTOP_FILESYSTEM_GRANT_SCHEMA_VERSION) {
    return failure("unknown_schema_version", "Desktop Filesystem Grant has an unsupported schema version");
  }
  if (typeof value.id !== "string" || value.id.length === 0) {
    return failure("invalid_id", "Desktop Filesystem Grant id must be a non-empty opaque string");
  }
  if (typeof value.canonicalRoot !== "string" || value.canonicalRoot.length === 0) {
    return failure("invalid_canonical_root", "canonicalRoot must be a non-empty absolute path");
  }
  if (CONTROL_CHARACTER.test(value.canonicalRoot)) {
    return failure("invalid_canonical_root", "canonicalRoot must not contain control characters");
  }
  if (!path.isAbsolute(value.canonicalRoot)) {
    return failure("invalid_canonical_root", "canonicalRoot must be absolute for the host platform");
  }

  const canonicalRoot = path.normalize(value.canonicalRoot);
  let filesystemIdentity: DesktopFilesystemGrantFilesystemIdentity | undefined;
  if (value.filesystemIdentity !== undefined) {
    if (!isRecord(value.filesystemIdentity) || !hasOnlyKeys(value.filesystemIdentity, FILESYSTEM_IDENTITY_KEYS)) {
      return failure("invalid_filesystem_identity", "filesystemIdentity contains unsupported fields");
    }

    const identity = value.filesystemIdentity;
    if (
      typeof identity.realRoot !== "string" ||
      identity.realRoot.length === 0 ||
      CONTROL_CHARACTER.test(identity.realRoot) ||
      !path.isAbsolute(identity.realRoot)
    ) {
      return failure("invalid_filesystem_identity", "filesystemIdentity.realRoot must be an absolute path");
    }
    const device = identity.device;
    const inode = identity.inode;
    const hasDevice = device !== undefined;
    const hasInode = inode !== undefined;
    if (
      hasDevice !== hasInode ||
      (hasDevice &&
        (typeof device !== "number" ||
          !Number.isSafeInteger(device) ||
          device < 0 ||
          typeof inode !== "number" ||
          !Number.isSafeInteger(inode) ||
          inode < 0))
    ) {
      return failure(
        "invalid_filesystem_identity",
        "filesystemIdentity.device and inode must be a non-negative safe integer pair",
      );
    }
    filesystemIdentity = {
      realRoot: path.normalize(identity.realRoot),
      ...(hasDevice ? { device, inode: inode as number } : {}),
    };
  }
  if (!Array.isArray(value.access) || value.access.length === 0) {
    return failure("invalid_access", "access must contain at least one operation");
  }
  if (
    !value.access.every((operation) => isOneOf(operation, DESKTOP_FILESYSTEM_ACCESS_OPERATIONS)) ||
    new Set(value.access).size !== value.access.length
  ) {
    return failure("invalid_access", "access must be a unique subset of supported operations");
  }
  if (!isOneOf(value.origin, DESKTOP_FILESYSTEM_GRANT_ORIGINS)) {
    return failure("invalid_origin", "origin is not supported");
  }
  if (!isOneOf(value.lifetime, DESKTOP_FILESYSTEM_GRANT_LIFETIMES)) {
    return failure("invalid_lifetime", "lifetime is not supported");
  }
  if (!isRecord(value.subject) || !hasOnlyKeys(value.subject, SUBJECT_KEYS)) {
    return failure("invalid_subject", "subject must contain only the required bindings");
  }

  const subject = value.subject;
  if (
    !isNonBlankString(subject.userId) ||
    !isCanonicalNautiloInstanceId(subject.instanceId) ||
    !isNonBlankString(subject.relayId) ||
    !isNonBlankString(subject.agentScope)
  ) {
    return failure(
      "invalid_subject",
      "subject requires non-empty userId, relayId, and agentScope, and a canonical instanceId (default \"\" or a named id)",
    );
  }
  if (!isNonBlankString(value.createdBy)) {
    return failure("invalid_created_by", "createdBy must be a non-empty string");
  }
  const policyVersion = value.policyVersion;
  if (typeof policyVersion !== "number" || !Number.isSafeInteger(policyVersion) || policyVersion < 1) {
    return failure("invalid_policy_version", "policyVersion must be a positive safe integer");
  }

  const createdAt = parseUtcTimestamp(value.createdAt);
  if (!createdAt) {
    return failure("invalid_created_at", "createdAt must be a valid UTC ISO-8601 timestamp");
  }

  let expiresAt: string | undefined;
  if (value.expiresAt !== undefined) {
    expiresAt = parseUtcTimestamp(value.expiresAt);
    if (!expiresAt) {
      return failure("invalid_expires_at", "expiresAt must be a valid UTC ISO-8601 timestamp");
    }
    if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
      return failure("invalid_expires_at", "expiresAt must be after createdAt");
    }
  }

  let lastUsedAt: string | undefined;
  if (value.lastUsedAt !== undefined) {
    lastUsedAt = parseUtcTimestamp(value.lastUsedAt);
    if (!lastUsedAt || Date.parse(lastUsedAt) < Date.parse(createdAt)) {
      return failure(
        "invalid_last_used_at",
        "lastUsedAt must be a valid timestamp on or after createdAt",
      );
    }
  }

  let revokedAt: string | undefined;
  if (value.revokedAt !== undefined) {
    revokedAt = parseUtcTimestamp(value.revokedAt);
    if (!revokedAt || Date.parse(revokedAt) < Date.parse(createdAt)) {
      return failure("invalid_revoked_at", "revokedAt must be a valid timestamp on or after createdAt");
    }
  }

  if (
    value.platformAuthorization !== undefined &&
    (!isNonBlankString(value.platformAuthorization) || CONTROL_CHARACTER.test(value.platformAuthorization))
  ) {
    return failure(
      "invalid_platform_authorization",
      "platformAuthorization must be a non-empty opaque string without control characters",
    );
  }

  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) {
    return failure("invalid_record", "validation clock must be a valid date");
  }
  if (expiresAt && Date.parse(expiresAt) <= now.getTime()) {
    return failure("expired", "Desktop Filesystem Grant has expired");
  }

  return {
    ok: true,
    revoked: revokedAt !== undefined,
    grant: {
      schemaVersion: DESKTOP_FILESYSTEM_GRANT_SCHEMA_VERSION,
      id: value.id,
      canonicalRoot,
      access: [...value.access],
      origin: value.origin,
      lifetime: value.lifetime,
      subject: {
        userId: subject.userId,
        instanceId: subject.instanceId,
        relayId: subject.relayId,
        agentScope: subject.agentScope,
      },
      createdBy: value.createdBy,
      createdAt,
      policyVersion,
      ...(expiresAt ? { expiresAt } : {}),
      ...(value.platformAuthorization !== undefined ? { platformAuthorization: value.platformAuthorization } : {}),
      ...(revokedAt ? { revokedAt } : {}),
      ...(lastUsedAt ? { lastUsedAt } : {}),
      ...(filesystemIdentity ? { filesystemIdentity } : {}),
    },
  };
}

/**
 * Pure lexical containment check for already-canonical absolute paths.
 * It intentionally does not resolve symlinks or decide authorization.
 */
export function isPathWithinDesktopFilesystemGrantRoot(root: string, candidate: string): boolean {
  if (!path.isAbsolute(root) || !path.isAbsolute(candidate)) return false;

  const normalizedRoot = path.normalize(root);
  const normalizedCandidate = path.normalize(candidate);
  if (normalizedRoot === path.parse(normalizedRoot).root) {
    return normalizedCandidate.startsWith(normalizedRoot);
  }
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

/**
 * Returns the narrowest grant containing `candidate` that includes the
 * requested operation. Policy decisions (revocation, expiry, subject binding,
 * and hard-deny rules) remain the caller's responsibility.
 */
export function findMostSpecificMatchingDesktopFilesystemGrant(
  grants: readonly DesktopFilesystemGrant[],
  candidate: string,
  operation: DesktopFilesystemAccessOperation,
): DesktopFilesystemGrant | undefined {
  let match: DesktopFilesystemGrant | undefined;
  for (const grant of grants) {
    if (
      grant.access.includes(operation) &&
      isPathWithinDesktopFilesystemGrantRoot(grant.canonicalRoot, candidate) &&
      (match === undefined || grant.canonicalRoot.length > match.canonicalRoot.length)
    ) {
      match = grant;
    }
  }
  return match;
}
