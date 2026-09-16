import { randomBytes } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import * as nodePath from "node:path";
import { isCanonicalNautiloInstanceId } from "@nautilo/config";

/** The durable-format version, intentionally independent from provider APIs. */
export const COMPUTER_USE_LOCAL_STORE_VERSION = 1 as const;
export const DESKTOP_AUTOMATION_RECEIPT_VERSION = 1 as const;

/** Cua is the only supported Computer use provider. */
export type DesktopProvider = "cua";

/**
 * Non-secret proof that this exact local installation has an enabled Desktop
 * automation grant. A per-launch desktopSessionId is deliberately absent: it
 * is live invocation state and must be revalidated, not made durable.
 */
export interface DesktopAutomationReceipt {
  readonly version: typeof DESKTOP_AUTOMATION_RECEIPT_VERSION;
  /** Distinguishes an explicit fail-closed local recovery from older authority. */
  readonly installationEpoch: string;
  readonly instanceId: string;
  readonly humanUserId: string;
  readonly agentId: string;
  readonly serverBindingId: string;
  readonly relayId: string;
  readonly pairingGeneration: string;
  readonly grantGeneration: number;
  readonly issuedAt: string;
}

export interface ComputerUseLocalStorage {
  read(): Promise<string | null>;
  writeAtomic(bytes: string): Promise<void>;
}

export interface ComputerUseLocalFileSystem {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, options: { mode: number }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  rm(path: string, options: { force: true }): Promise<void>;
}

export interface ComputerUseLocalStorageDependencies {
  readonly fs?: ComputerUseLocalFileSystem;
  readonly randomHex?: () => string;
}

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MAX_GRANT_GENERATION = 2 ** 31 - 1;

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

export function isComputerUseOpaqueId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID.test(value);
}

function isGrantGeneration(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 1
    && value <= MAX_GRANT_GENERATION;
}

export function parseDesktopAutomationReceipt(value: unknown): DesktopAutomationReceipt | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "version",
    "installationEpoch",
    "instanceId",
    "humanUserId",
    "agentId",
    "serverBindingId",
    "relayId",
    "pairingGeneration",
    "grantGeneration",
    "issuedAt",
  ])) return null;
  if (value["version"] !== DESKTOP_AUTOMATION_RECEIPT_VERSION
    || !isComputerUseOpaqueId(value["installationEpoch"])
    || !isCanonicalNautiloInstanceId(value["instanceId"])
    || !isComputerUseOpaqueId(value["humanUserId"])
    || !isComputerUseOpaqueId(value["agentId"])
    || !isComputerUseOpaqueId(value["serverBindingId"])
    || !isComputerUseOpaqueId(value["relayId"])
    || !isComputerUseOpaqueId(value["pairingGeneration"])
    || !isGrantGeneration(value["grantGeneration"])
    || !isUtcIso(value["issuedAt"])) return null;
  return value as unknown as DesktopAutomationReceipt;
}

/**
 * 0600 atomic persistence for this one local Computer use setting and receipt.
 * The caller owns authority/PIN verification; this boundary intentionally
 * never accepts, persists, logs, or derives a PIN or secret.
 */
export function createComputerUseLocalStorage(
  filePath: string,
  dependencies: ComputerUseLocalStorageDependencies = {},
): ComputerUseLocalStorage {
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
        try { await fs.rm(temporary, { force: true }); } catch { /* best effort cleanup */ }
        throw error;
      }
    },
  };
}
