import { randomBytes } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import { isIP } from "node:net";
import * as nodePath from "node:path";
import { isCanonicalNautiloInstanceId } from "@nautilo/config";

/**
 * The replacement for rejected tuple-bound records. This is intentionally a
 * small Electron-local SSH capability, not a generalized capability registry.
 */
export const SSH_CAPABILITY_VERSION = 1 as const;
export const SSH_CAPABILITY_STORE_VERSION = 1 as const;
export const SSH_HOST_TRUST_RECORD_VERSION = 1 as const;
export const STRUCTURED_SSH_STORE_VERSION = 1 as const;
export const MAX_STRUCTURED_SSH_RECORDS = 128;

const MAX_OPAQUE_TEXT_LENGTH = 256;
const MAX_HANDLE_LENGTH = 512;
const FINGERPRINT = /^[A-Za-z0-9][A-Za-z0-9._:+/=-]{7,255}$/;
const OPAQUE_TEXT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const HOSTNAME_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export type SshOperation = "auth" | "exec" | "copy-upload" | "copy-download";
export type SshIdentityProvider = "system-agent";
export type SshActorRole = "owner" | "admin";
export type SshExecutionEntrypoint =
  | "foreground.main"
  | "foreground.fork"
  | "background.task"
  | "foreground.subagent";

export interface SshHostTrustTarget {
  readonly host: string;
  readonly port: number;
}

/**
 * Durable Electron-local authority subject. It must never absorb facts that
 * only the authenticated relay/server transport can prove.
 */
export interface SshCapabilitySubject {
  readonly instanceId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly relayId: string;
  readonly desktopSessionId: string;
}

/**
 * Per-invocation provenance supplied through the authenticated relay path.
 * This is deliberately never persisted in local capability authority.
 */
export interface SshInvocationSubject {
  readonly instanceId: string;
  readonly userId: string;
  readonly actorId: string;
  readonly actorRole: SshActorRole;
  readonly agentId: string;
  readonly executionEntrypoint: SshExecutionEntrypoint;
  readonly relayId: string;
  readonly relaySessionId: string;
  readonly desktopSessionId: string;
  readonly pairingGenerationRef: string;
  readonly capabilityRevision: number;
}

/** Deliberately public metadata only: no key bytes, paths, or agent protocol. */
export interface SshPublicIdentity {
  readonly provider: SshIdentityProvider;
  readonly publicKeyFingerprint: string;
  readonly localHandle: string;
}

/** Independent tool policy under one Human-enabled local SSH capability. */
export interface SshCapabilityTools {
  readonly auth: boolean;
  readonly exec: boolean;
  readonly copyUpload: boolean;
  readonly copyDownload: boolean;
}

/**
 * Durable local authority for one exact Human/Genie/relay/Desktop subject.
 * It deliberately contains no destination, identity, trust, filesystem, or
 * workstation policy. Those remain local observation and per-operation work.
 */
export interface SshCapability {
  readonly version: typeof SSH_CAPABILITY_VERSION;
  readonly subject: SshCapabilitySubject;
  readonly enabled: boolean;
  readonly tools: SshCapabilityTools;
  readonly issuedAt: string;
  readonly updatedAt: string;
  readonly disabledAt?: string;
  readonly revokedAt?: string;
}

export interface SshHostTrustRecord {
  readonly version: typeof SSH_HOST_TRUST_RECORD_VERSION;
  readonly host: string;
  readonly port: number;
  readonly hostKeyFingerprint: string;
  readonly confirmedAt: string;
  readonly replacedAt?: string;
}

export interface StructuredSshStorage {
  read(): Promise<string | null>;
  writeAtomic(bytes: string): Promise<void>;
}

export interface StructuredSshFileSystem {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, options: { mode: number }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  rm(path: string, options: { force: true }): Promise<void>;
}

export interface StructuredSshStorageDependencies {
  readonly fs?: StructuredSshFileSystem;
  readonly randomHex?: () => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function isUtcIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function isOpaqueText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_OPAQUE_TEXT_LENGTH && OPAQUE_TEXT.test(value);
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 2 ** 31 - 1;
}

export function isSshFingerprint(value: unknown): value is string {
  return typeof value === "string" && value.length <= 256 && FINGERPRINT.test(value);
}

export function isCanonicalSshHost(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 253 || value !== value.trim()) return false;
  if (isIP(value) === 4) {
    return value.split(".").every((part) => String(Number(part)) === part && Number(part) <= 255);
  }
  if (isIP(value) === 6) return value === value.toLowerCase() && !value.includes("%") && !value.includes("[");
  if (value !== value.toLowerCase() || value.endsWith(".")) return false;
  return value.split(".").every((label) => HOSTNAME_LABEL.test(label));
}

function parseHostTrustTarget(value: unknown): SshHostTrustTarget | null {
  if (!isRecord(value) || !hasExactKeys(value, ["host", "port"])) return null;
  if (!isCanonicalSshHost(value["host"]) || !isPort(value["port"])) return null;
  return { host: value["host"], port: value["port"] };
}

function isPort(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 65_535;
}

export function parseSshCapabilitySubject(value: unknown): SshCapabilitySubject | null {
  if (!isRecord(value) || !hasExactKeys(value, ["instanceId", "userId", "agentId", "relayId", "desktopSessionId"])) return null;
  const strings = ["userId", "agentId", "relayId", "desktopSessionId"] as const;
  if (!isCanonicalNautiloInstanceId(value["instanceId"]) || strings.some((key) => !isOpaqueText(value[key]))) return null;
  return value as unknown as SshCapabilitySubject;
}

export function parseSshInvocationSubject(value: unknown): SshInvocationSubject | null {
  if (!isRecord(value) || !hasExactKeys(value, ["instanceId", "userId", "actorId", "actorRole", "agentId", "executionEntrypoint", "relayId", "relaySessionId", "desktopSessionId", "pairingGenerationRef", "capabilityRevision"])) return null;
  const strings = ["userId", "actorId", "agentId", "relayId", "relaySessionId", "desktopSessionId", "pairingGenerationRef"] as const;
  if (!isCanonicalNautiloInstanceId(value["instanceId"]) || strings.some((key) => !isOpaqueText(value[key])) || (value["actorRole"] !== "owner" && value["actorRole"] !== "admin") || !isSshExecutionEntrypoint(value["executionEntrypoint"]) || !isRevision(value["capabilityRevision"])) return null;
  return value as unknown as SshInvocationSubject;
}

function isSshExecutionEntrypoint(value: unknown): value is SshExecutionEntrypoint {
  return value === "foreground.main"
    || value === "foreground.fork"
    || value === "background.task"
    || value === "foreground.subagent";
}

export function parseSshPublicIdentity(value: unknown): SshPublicIdentity | null {
  if (!isRecord(value) || !hasExactKeys(value, ["provider", "publicKeyFingerprint", "localHandle"])) return null;
  if (value["provider"] !== "system-agent" || !isSshFingerprint(value["publicKeyFingerprint"]) || typeof value["localHandle"] !== "string" || value["localHandle"].length === 0 || value["localHandle"].length > MAX_HANDLE_LENGTH || !OPAQUE_TEXT.test(value["localHandle"])) return null;
  return value as unknown as SshPublicIdentity;
}

export function parseSshCapabilityTools(value: unknown): SshCapabilityTools | null {
  if (!isRecord(value) || !hasExactKeys(value, ["auth", "exec", "copyUpload", "copyDownload"])) return null;
  if (typeof value["auth"] !== "boolean" || typeof value["exec"] !== "boolean" || typeof value["copyUpload"] !== "boolean" || typeof value["copyDownload"] !== "boolean") return null;
  return value as unknown as SshCapabilityTools;
}

export function parseSshCapability(value: unknown): SshCapability | null {
  if (!isRecord(value)) return null;
  const optional = [
    ...(value["disabledAt"] === undefined ? [] : ["disabledAt"]),
    ...(value["revokedAt"] === undefined ? [] : ["revokedAt"]),
  ];
  if (!hasExactKeys(value, ["version", "subject", "enabled", "tools", "issuedAt", "updatedAt", ...optional])) return null;
  const subject = parseSshCapabilitySubject(value["subject"]);
  const tools = parseSshCapabilityTools(value["tools"]);
  if (value["version"] !== SSH_CAPABILITY_VERSION || subject === null || tools === null || typeof value["enabled"] !== "boolean" || !isUtcIso(value["issuedAt"]) || !isUtcIso(value["updatedAt"]) || (value["disabledAt"] !== undefined && !isUtcIso(value["disabledAt"])) || (value["revokedAt"] !== undefined && !isUtcIso(value["revokedAt"]))) return null;
  if (
    value["issuedAt"] > value["updatedAt"]
    || (value["enabled"] && (value["disabledAt"] !== undefined || value["revokedAt"] !== undefined))
    || (!value["enabled"] && value["disabledAt"] === undefined)
    || (value["disabledAt"] !== undefined && value["disabledAt"] > value["updatedAt"])
    || (value["revokedAt"] !== undefined && value["revokedAt"] !== value["updatedAt"])
  ) return null;
  return {
    version: SSH_CAPABILITY_VERSION,
    subject,
    enabled: value["enabled"],
    tools,
    issuedAt: value["issuedAt"],
    updatedAt: value["updatedAt"],
    ...(value["disabledAt"] === undefined ? {} : { disabledAt: value["disabledAt"] }),
    ...(value["revokedAt"] === undefined ? {} : { revokedAt: value["revokedAt"] }),
  };
}

export function parseSshHostTrustRecord(value: unknown): SshHostTrustRecord | null {
  if (!isRecord(value)) return null;
  const optional = value["replacedAt"] === undefined ? [] : ["replacedAt"];
  const target = parseHostTrustTarget({ host: value["host"], port: value["port"] });
  if (!hasExactKeys(value, ["version", "host", "port", "hostKeyFingerprint", "confirmedAt", ...optional]) || value["version"] !== SSH_HOST_TRUST_RECORD_VERSION || target === null || !isSshFingerprint(value["hostKeyFingerprint"]) || !isUtcIso(value["confirmedAt"]) || (value["replacedAt"] !== undefined && !isUtcIso(value["replacedAt"]))) return null;
  return { version: SSH_HOST_TRUST_RECORD_VERSION, ...target, hostKeyFingerprint: value["hostKeyFingerprint"], confirmedAt: value["confirmedAt"], ...(value["replacedAt"] === undefined ? {} : { replacedAt: value["replacedAt"] }) };
}

export function sameSshCapabilitySubject(left: SshCapabilitySubject, right: SshCapabilitySubject): boolean {
  return Object.keys(left).every((key) => left[key as keyof SshCapabilitySubject] === right[key as keyof SshCapabilitySubject]);
}

export function sameSshInvocationSubject(left: SshInvocationSubject, right: SshInvocationSubject): boolean {
  return Object.keys(left).every((key) => left[key as keyof SshInvocationSubject] === right[key as keyof SshInvocationSubject]);
}

/** The only durable-to-dynamic comparison. Dynamic provenance stays dynamic. */
export function matchesSshCapabilitySubject(
  capability: SshCapabilitySubject,
  invocation: SshInvocationSubject,
): boolean {
  return (
    capability.instanceId === invocation.instanceId &&
    capability.userId === invocation.userId &&
    capability.agentId === invocation.agentId &&
    capability.relayId === invocation.relayId &&
    capability.desktopSessionId === invocation.desktopSessionId
  );
}

export function createStructuredSshStorage(filePath: string, dependencies: StructuredSshStorageDependencies = {}): StructuredSshStorage {
  const fs = dependencies.fs ?? nodeFs;
  const randomHex = dependencies.randomHex ?? (() => randomBytes(12).toString("hex"));
  const directory = nodePath.dirname(filePath);
  return {
    async read() {
      try {
        return await fs.readFile(filePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return null;
        throw error;
      }
    },
    async writeAtomic(bytes: string) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.chmod(directory, 0o700);
      const temporary = nodePath.join(directory, `.${nodePath.basename(filePath)}.${randomHex()}.tmp`);
      try {
        await fs.writeFile(temporary, bytes, { mode: 0o600 });
        await fs.chmod(temporary, 0o600);
        await fs.rename(temporary, filePath);
        await fs.chmod(filePath, 0o600);
      } catch (error) {
        try { await fs.rm(temporary, { force: true }); } catch { /* best effort only */ }
        throw error;
      }
    },
  };
}
