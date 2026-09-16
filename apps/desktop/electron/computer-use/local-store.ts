import { randomBytes } from "node:crypto";
import * as nodePath from "node:path";
import { isCanonicalNautiloInstanceId } from "@nautilo/config";
import {
  COMPUTER_USE_LOCAL_STORE_VERSION,
  DESKTOP_AUTOMATION_RECEIPT_VERSION,
  createComputerUseLocalStorage,
  hasExactKeys,
  isComputerUseOpaqueId,
  isUtcIso,
  parseDesktopAutomationReceipt,
  type ComputerUseLocalStorage,
  type ComputerUseLocalStorageDependencies,
  type DesktopAutomationReceipt,
} from "./contracts.ts";

interface ComputerUseLocalEnvelope {
  readonly version: typeof COMPUTER_USE_LOCAL_STORE_VERSION;
  readonly instanceId: string;
  readonly serverBindingId: string;
  /** Changes only during explicit fail-closed recovery of unreadable/foreign state. */
  readonly installationEpoch: string;
  /** Retained after PIN-free revoke so receipt generations cannot regress. */
  readonly grantGeneration: number;
  readonly receipt: DesktopAutomationReceipt | null;
  readonly updatedAt: string;
}

type DecodedComputerUseLocalEnvelope =
  | { readonly ok: true; readonly data: ComputerUseLocalEnvelope; readonly legacy: boolean }
  | { readonly ok: false; readonly code: ComputerUseLocalStoreErrorCode; readonly message: string };

export interface MintDesktopAutomationReceipt {
  readonly instanceId: string;
  readonly humanUserId: string;
  readonly agentId: string;
  readonly serverBindingId: string;
  readonly relayId: string;
  readonly pairingGeneration: string;
}

export type ComputerUseLocalStoreErrorCode =
  | "store_unavailable"
  | "store_corrupt"
  | "store_instance_mismatch"
  | "store_server_mismatch"
  | "invalid_receipt"
  | "grant_generation_exhausted";

export type ComputerUseLocalStoreResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly code: ComputerUseLocalStoreErrorCode; readonly message: string };

export interface ComputerUseLocalStoreOptions {
  readonly instanceId: string;
  readonly serverBindingId: string;
  readonly filePath: string;
  readonly storage?: ComputerUseLocalStorage;
  readonly storageDependencies?: ComputerUseLocalStorageDependencies;
  readonly clock?: () => Date;
  readonly createInstallationEpoch?: () => string;
}

export type ComputerUseRecoveryCause =
  | "store_corrupt"
  | "store_instance_mismatch"
  | "store_server_mismatch";

export interface ComputerUseRevocationResult {
  readonly revoked: boolean;
  readonly recovered: boolean;
  readonly recoveryCause?: ComputerUseRecoveryCause;
  readonly previousReceipt: DesktopAutomationReceipt | null;
  readonly installationEpoch: string;
  /** The new authority fence. It advances on every enabled-to-Off transition. */
  readonly grantGeneration: number;
}

const MAX_GRANT_GENERATION = 2 ** 31 - 1;
const serializedTailByFilePath = new Map<string, Promise<void>>();

function failed<T>(code: ComputerUseLocalStoreErrorCode, message: string): ComputerUseLocalStoreResult<T> {
  return { ok: false, code, message };
}

function decodeFailed(
  code: ComputerUseLocalStoreErrorCode,
  message: string,
): DecodedComputerUseLocalEnvelope {
  return { ok: false, code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStoredGrantGeneration(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= MAX_GRANT_GENERATION;
}

function isLegacyProviderPolicy(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ["primary", "fallback"])) return false;
  const primary = value["primary"];
  const fallback = value["fallback"];
  return (primary === "cua" || primary === "peekaboo")
    && (fallback === "cua" || fallback === "peekaboo" || fallback === "disabled")
    && fallback !== primary;
}

function isMint(value: unknown): value is MintDesktopAutomationReceipt {
  if (!isRecord(value) || !hasExactKeys(value, [
    "instanceId",
    "humanUserId",
    "agentId",
    "serverBindingId",
    "relayId",
    "pairingGeneration",
  ])) return false;
  return typeof value["instanceId"] === "string"
    && isComputerUseOpaqueId(value["humanUserId"])
    && isComputerUseOpaqueId(value["agentId"])
    && isComputerUseOpaqueId(value["serverBindingId"])
    && isComputerUseOpaqueId(value["relayId"])
    && isComputerUseOpaqueId(value["pairingGeneration"]);
}

/**
 * Electron-local Computer use state only. The receipt is a non-secret record
 * of a successful external PIN ceremony; this store cannot perform, bypass, or
 * infer that ceremony. A PIN-free revoke deletes the receipt immediately while
 * retaining only its counter, so a later grant receives a new generation.
 */
export class ComputerUseLocalStore {
  private readonly instanceId: string;
  private readonly serverBindingId: string;
  private readonly filePath: string;
  private readonly storage: ComputerUseLocalStorage;
  private readonly clock: () => Date;
  private readonly createInstallationEpoch: () => string;

  constructor(options: ComputerUseLocalStoreOptions) {
    this.instanceId = options.instanceId;
    this.serverBindingId = options.serverBindingId;
    this.filePath = nodePath.resolve(options.filePath);
    this.storage = options.storage
      ?? createComputerUseLocalStorage(this.filePath, options.storageDependencies);
    this.clock = options.clock ?? (() => new Date());
    this.createInstallationEpoch = options.createInstallationEpoch
      ?? (() => `computer-use-epoch-${randomBytes(16).toString("hex")}`);
  }

  private async serialized<T>(
    operation: () => Promise<ComputerUseLocalStoreResult<T>>,
  ): Promise<ComputerUseLocalStoreResult<T>> {
    const previous = serializedTailByFilePath.get(this.filePath) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    serializedTailByFilePath.set(this.filePath, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (serializedTailByFilePath.get(this.filePath) === tail) {
        serializedTailByFilePath.delete(this.filePath);
      }
    }
  }

  private now(): string | null {
    try {
      const value = this.clock();
      return Number.isNaN(value.getTime()) ? null : value.toISOString();
    } catch {
      return null;
    }
  }

  private empty(): ComputerUseLocalStoreResult<ComputerUseLocalEnvelope> {
    const updatedAt = this.now();
    if (updatedAt === null) return failed("store_unavailable", "computer-use local clock is unavailable");
    const installationEpoch = this.freshInstallationEpoch();
    if (installationEpoch === null) {
      return failed("store_unavailable", "computer-use installation epoch is unavailable");
    }
    return {
      ok: true,
      data: {
        version: COMPUTER_USE_LOCAL_STORE_VERSION,
        instanceId: this.instanceId,
        serverBindingId: this.serverBindingId,
        installationEpoch,
        grantGeneration: 0,
        receipt: null,
        updatedAt,
      },
    };
  }

  private freshInstallationEpoch(): string | null {
    try {
      const value = this.createInstallationEpoch();
      return isComputerUseOpaqueId(value) ? value : null;
    } catch {
      return null;
    }
  }

  private decode(raw: string): DecodedComputerUseLocalEnvelope {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return decodeFailed("store_corrupt", "computer-use local state contains invalid JSON");
    }
    const currentKeys = ["version", "instanceId", "serverBindingId", "installationEpoch", "grantGeneration", "receipt", "updatedAt"];
    const currentShape = isRecord(value) && hasExactKeys(value, currentKeys);
    const legacyShape = isRecord(value)
      && hasExactKeys(value, [...currentKeys, "policy"])
      && isLegacyProviderPolicy(value["policy"]);
    if (!isRecord(value) || (!currentShape && !legacyShape) || value["version"] !== COMPUTER_USE_LOCAL_STORE_VERSION
      || typeof value["instanceId"] !== "string"
      || !isComputerUseOpaqueId(value["serverBindingId"])
      || !isComputerUseOpaqueId(value["installationEpoch"])
      || !isStoredGrantGeneration(value["grantGeneration"])
      || !isUtcIso(value["updatedAt"])) {
      return decodeFailed("store_corrupt", "computer-use local state has an invalid envelope");
    }
    if (value["instanceId"] !== this.instanceId) {
      return decodeFailed("store_instance_mismatch", "computer-use local state belongs to another instance");
    }
    if (value["serverBindingId"] !== this.serverBindingId) {
      return decodeFailed("store_server_mismatch", "computer-use local state belongs to another active server");
    }
    if (value["receipt"] !== null) {
      const receipt = parseDesktopAutomationReceipt(value["receipt"]);
      if (receipt === null
        || receipt.instanceId !== this.instanceId
        || receipt.serverBindingId !== this.serverBindingId
        || receipt.installationEpoch !== value["installationEpoch"]
        || receipt.grantGeneration !== value["grantGeneration"]
        || receipt.issuedAt > value["updatedAt"]) {
        return decodeFailed("store_corrupt", "computer-use local state has an invalid receipt");
      }
    }
    return {
      ok: true,
      legacy: legacyShape,
      data: {
        version: COMPUTER_USE_LOCAL_STORE_VERSION,
        instanceId: this.instanceId,
        serverBindingId: this.serverBindingId,
        installationEpoch: value["installationEpoch"],
        grantGeneration: value["grantGeneration"],
        receipt: value["receipt"] as DesktopAutomationReceipt | null,
        updatedAt: value["updatedAt"],
      },
    };
  }

  private async read(): Promise<ComputerUseLocalStoreResult<ComputerUseLocalEnvelope>> {
    if (!isCanonicalNautiloInstanceId(this.instanceId) || !isComputerUseOpaqueId(this.serverBindingId)) {
      return failed("invalid_receipt", "computer-use local store server binding is invalid");
    }
    let raw: string | null;
    try {
      raw = await this.storage.read();
    } catch {
      return failed("store_unavailable", "computer-use local state could not be read");
    }
    if (raw === null) return this.empty();
    const decoded = this.decode(raw);
    if (!decoded.ok) return decoded;
    if (decoded.legacy) {
      // The old provider preference has no current meaning. Remove it on the
      // first successful read while preserving the exact receipt and fence.
      const migrated = await this.write(decoded.data);
      if (!migrated.ok) return migrated;
    }
    return { ok: true, data: decoded.data };
  }

  private async write(envelope: ComputerUseLocalEnvelope): Promise<ComputerUseLocalStoreResult<void>> {
    try {
      await this.storage.writeAtomic(`${JSON.stringify(envelope, null, 2)}\n`);
      return { ok: true, data: undefined };
    } catch {
      return failed("store_unavailable", "computer-use local state could not be persisted");
    }
  }

  private async persist(
    envelope: Omit<ComputerUseLocalEnvelope, "updatedAt">,
  ): Promise<ComputerUseLocalStoreResult<ComputerUseLocalEnvelope>> {
    const updatedAt = this.now();
    if (updatedAt === null) return failed("store_unavailable", "computer-use local clock is unavailable");
    const next: ComputerUseLocalEnvelope = { ...envelope, updatedAt };
    const written = await this.write(next);
    return written.ok ? { ok: true, data: next } : written;
  }

  async get(): Promise<ComputerUseLocalStoreResult<{
    readonly receipt: DesktopAutomationReceipt | null;
    readonly grantGeneration: number;
    readonly installationEpoch: string;
  }>> {
    return this.serialized(async () => {
      const current = await this.read();
      return current.ok ? {
        ok: true,
        data: {
          receipt: current.data.receipt,
          grantGeneration: current.data.grantGeneration,
          installationEpoch: current.data.installationEpoch,
        },
      } : current;
    });
  }

  async mint(input: MintDesktopAutomationReceipt): Promise<ComputerUseLocalStoreResult<DesktopAutomationReceipt>> {
    return this.serialized(async () => {
      if (!isMint(input) || input.instanceId !== this.instanceId || input.serverBindingId !== this.serverBindingId) {
        return failed("invalid_receipt", "computer-use receipt minting input is invalid");
      }
      const current = await this.read();
      if (!current.ok) return current;
      if (current.data.grantGeneration >= MAX_GRANT_GENERATION) {
        return failed("grant_generation_exhausted", "computer-use grant generation is exhausted");
      }
      const issuedAt = this.now();
      if (issuedAt === null) return failed("store_unavailable", "computer-use local clock is unavailable");
      const receipt: DesktopAutomationReceipt = {
        version: DESKTOP_AUTOMATION_RECEIPT_VERSION,
        installationEpoch: current.data.installationEpoch,
        ...input,
        grantGeneration: current.data.grantGeneration + 1,
        issuedAt,
      };
      const written = await this.persist({
        ...current.data,
        grantGeneration: receipt.grantGeneration,
        receipt,
      });
      return written.ok ? { ok: true, data: receipt } : written;
    });
  }

  /**
   * PIN-free local revocation. Corrupt or foreign bytes are replaced only on
   * this explicit recovery path. A fresh installation epoch makes unknown old
   * generations incomparable and therefore unusable instead of pretending the
   * numeric counter remained monotonic across unreadable state.
   */
  async revoke(): Promise<ComputerUseLocalStoreResult<ComputerUseRevocationResult>> {
    return this.serialized<ComputerUseRevocationResult>(async () => {
      const current = await this.read();
      if (!current.ok) {
        if (current.code !== "store_corrupt"
          && current.code !== "store_instance_mismatch"
          && current.code !== "store_server_mismatch") return current;
        const updatedAt = this.now();
        const installationEpoch = this.freshInstallationEpoch();
        if (updatedAt === null || installationEpoch === null) {
          return failed("store_unavailable", "computer-use local recovery is unavailable");
        }
        const reset: ComputerUseLocalEnvelope = {
          version: COMPUTER_USE_LOCAL_STORE_VERSION,
          instanceId: this.instanceId,
          serverBindingId: this.serverBindingId,
          installationEpoch,
          grantGeneration: 0,
          receipt: null,
          updatedAt,
        };
        const written = await this.write(reset);
        return written.ok ? {
          ok: true,
          data: {
            revoked: true,
            recovered: true,
            recoveryCause: current.code,
            previousReceipt: null,
            installationEpoch,
            grantGeneration: 0,
          },
        } : written;
      }
      if (current.data.receipt === null) {
        return {
          ok: true,
          data: {
            revoked: false,
            recovered: false,
            previousReceipt: null,
            installationEpoch: current.data.installationEpoch,
            grantGeneration: current.data.grantGeneration,
          },
        };
      }
      if (current.data.grantGeneration >= MAX_GRANT_GENERATION) {
        return failed("grant_generation_exhausted", "computer-use grant generation is exhausted");
      }
      const previousReceipt = current.data.receipt;
      const written = await this.persist({
        ...current.data,
        grantGeneration: current.data.grantGeneration + 1,
        receipt: null,
      });
      return written.ok
        ? {
          ok: true,
          data: {
            revoked: true,
            recovered: false,
            previousReceipt,
            installationEpoch: written.data.installationEpoch,
            grantGeneration: written.data.grantGeneration,
          },
        }
        : written;
    });
  }
}
