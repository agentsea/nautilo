import {
  createDesktopFilesystemGrantStorage,
  type DesktopFilesystemGrantStorage,
} from "./desktop-filesystem-grants/storage.ts";

const STORE_VERSION = 1 as const;
const RECEIPT_VERSION = 1 as const;
const MAX_RECEIPTS = 128;

export interface WorkstationShellSubject {
  readonly instanceId: string;
  readonly userId: string;
  readonly relayId: string;
  readonly serverOrigin: string;
  /** One-way digest of the current relay credential; never the credential. */
  readonly pairingFingerprint: string;
}

export interface WorkstationShellFolderIdentity {
  readonly canonicalRoot: string;
  readonly device?: number | undefined;
  readonly inode?: number | undefined;
}

export interface WorkstationShellConsentReceipt
  extends WorkstationShellSubject,
    WorkstationShellFolderIdentity {
  readonly version: typeof RECEIPT_VERSION;
  readonly createdAt: string;
}

interface WorkstationShellConsentEnvelope {
  readonly version: typeof STORE_VERSION;
  readonly instanceId: string;
  readonly receipts: readonly WorkstationShellConsentReceipt[];
  readonly updatedAt: string;
}

export type WorkstationShellConsentStoreResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly code: "store_unavailable" | "store_corrupt";
      readonly message: string;
    };

function failure<T>(
  code: "store_unavailable" | "store_corrupt",
  message: string,
): WorkstationShellConsentStoreResult<T> {
  return { ok: false, code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isUtcIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function isSafeIdentityPart(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseReceipt(value: unknown): WorkstationShellConsentReceipt | null {
  if (!isRecord(value)) return null;
  const allowed = [
    "version",
    "instanceId",
    "userId",
    "relayId",
    "serverOrigin",
    "pairingFingerprint",
    "canonicalRoot",
    "createdAt",
    ...(value["device"] === undefined ? [] : ["device"]),
    ...(value["inode"] === undefined ? [] : ["inode"]),
  ];
  if (!hasExactKeys(value, allowed)) return null;
  if (
    value["version"] !== RECEIPT_VERSION ||
    typeof value["instanceId"] !== "string" ||
    typeof value["userId"] !== "string" ||
    value["userId"].length === 0 ||
    typeof value["relayId"] !== "string" ||
    value["relayId"].length === 0 ||
    typeof value["serverOrigin"] !== "string" ||
    value["serverOrigin"].length === 0 ||
    typeof value["pairingFingerprint"] !== "string" ||
    value["pairingFingerprint"].length === 0 ||
    typeof value["canonicalRoot"] !== "string" ||
    value["canonicalRoot"].length === 0 ||
    !isUtcIso(value["createdAt"])
  ) {
    return null;
  }
  const hasDevice = value["device"] !== undefined;
  const hasInode = value["inode"] !== undefined;
  if (hasDevice !== hasInode) return null;
  if (
    (hasDevice && !isSafeIdentityPart(value["device"])) ||
    (hasInode && !isSafeIdentityPart(value["inode"]))
  ) {
    return null;
  }
  return {
    version: RECEIPT_VERSION,
    instanceId: value["instanceId"],
    userId: value["userId"],
    relayId: value["relayId"],
    serverOrigin: value["serverOrigin"],
    pairingFingerprint: value["pairingFingerprint"],
    canonicalRoot: value["canonicalRoot"],
    createdAt: value["createdAt"],
    ...(hasDevice
      ? { device: value["device"] as number, inode: value["inode"] as number }
      : {}),
  };
}

function sameSubject(
  receipt: WorkstationShellConsentReceipt,
  subject: WorkstationShellSubject,
): boolean {
  return (
    receipt.instanceId === subject.instanceId &&
    receipt.userId === subject.userId &&
    receipt.relayId === subject.relayId &&
    receipt.serverOrigin === subject.serverOrigin &&
    receipt.pairingFingerprint === subject.pairingFingerprint
  );
}

function sameFolder(
  receipt: WorkstationShellConsentReceipt,
  identity: WorkstationShellFolderIdentity,
): boolean {
  if (receipt.canonicalRoot !== identity.canonicalRoot) return false;
  const receiptHasStableIdentity = receipt.device !== undefined && receipt.inode !== undefined;
  const candidateHasStableIdentity = identity.device !== undefined && identity.inode !== undefined;
  if (receiptHasStableIdentity !== candidateHasStableIdentity) return false;
  return (
    !receiptHasStableIdentity ||
    (receipt.device === identity.device && receipt.inode === identity.inode)
  );
}

/**
 * Electron-local durable authority for the unsandboxed host-command lane.
 *
 * This is intentionally not a Workstation filesystem grant: Current Folder
 * selects cwd and receipt identity, but it does not contain the signed-in OS
 * account or its CLI credentials.
 */
export class WorkstationShellConsentStore {
  private readonly instanceId: string;
  private readonly storage: DesktopFilesystemGrantStorage;
  private readonly clock: () => Date;
  private pending: Promise<void> = Promise.resolve();

  constructor(options: {
    readonly instanceId: string;
    readonly filePath: string;
    readonly storage?: DesktopFilesystemGrantStorage | undefined;
    readonly clock?: (() => Date) | undefined;
  }) {
    this.instanceId = options.instanceId;
    this.storage =
      options.storage ?? createDesktopFilesystemGrantStorage(options.filePath, undefined);
    this.clock = options.clock ?? (() => new Date());
  }

  private async serialized<T>(
    operation: () => Promise<WorkstationShellConsentStoreResult<T>>,
  ): Promise<WorkstationShellConsentStoreResult<T>> {
    const previous = this.pending;
    let release!: () => void;
    this.pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async read(): Promise<
    WorkstationShellConsentStoreResult<WorkstationShellConsentEnvelope>
  > {
    let raw: string | null;
    try {
      raw = await this.storage.read();
    } catch (error) {
      return failure(
        "store_unavailable",
        `could not read host-command consent: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (raw === null) {
      const now = this.clock();
      return {
        ok: true,
        data: {
          version: STORE_VERSION,
          instanceId: this.instanceId,
          receipts: [],
          updatedAt: now.toISOString(),
        },
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return failure("store_corrupt", "host-command consent contains invalid JSON");
    }
    if (
      !isRecord(parsed) ||
      !hasExactKeys(parsed, ["version", "instanceId", "receipts", "updatedAt"]) ||
      parsed["version"] !== STORE_VERSION ||
      parsed["instanceId"] !== this.instanceId ||
      !Array.isArray(parsed["receipts"]) ||
      parsed["receipts"].length > MAX_RECEIPTS ||
      !isUtcIso(parsed["updatedAt"])
    ) {
      return failure("store_corrupt", "host-command consent has an invalid envelope");
    }
    const receipts: WorkstationShellConsentReceipt[] = [];
    for (const candidate of parsed["receipts"]) {
      const receipt = parseReceipt(candidate);
      if (receipt === null || receipt.instanceId !== this.instanceId) {
        return failure("store_corrupt", "host-command consent contains an invalid receipt");
      }
      receipts.push(receipt);
    }
    return {
      ok: true,
      data: {
        version: STORE_VERSION,
        instanceId: this.instanceId,
        receipts,
        updatedAt: parsed["updatedAt"],
      },
    };
  }

  private async write(
    receipts: readonly WorkstationShellConsentReceipt[],
  ): Promise<WorkstationShellConsentStoreResult<void>> {
    const now = this.clock();
    const envelope: WorkstationShellConsentEnvelope = {
      version: STORE_VERSION,
      instanceId: this.instanceId,
      receipts: receipts.slice(-MAX_RECEIPTS),
      updatedAt: now.toISOString(),
    };
    try {
      await this.storage.writeAtomic(`${JSON.stringify(envelope, null, 2)}\n`);
      return { ok: true, data: undefined };
    } catch (error) {
      return failure(
        "store_unavailable",
        `could not persist host-command consent: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async has(input: {
    readonly subject: WorkstationShellSubject;
    readonly identity: WorkstationShellFolderIdentity;
  }): Promise<WorkstationShellConsentStoreResult<boolean>> {
    return this.serialized(async () => {
      const current = await this.read();
      if (!current.ok) return current;
      return {
        ok: true,
        data: current.data.receipts.some(
          (receipt) =>
            sameSubject(receipt, input.subject) && sameFolder(receipt, input.identity),
        ),
      };
    });
  }

  async grant(input: {
    readonly subject: WorkstationShellSubject;
    readonly identity: WorkstationShellFolderIdentity;
  }): Promise<WorkstationShellConsentStoreResult<void>> {
    return this.serialized(async () => {
      const current = await this.read();
      if (!current.ok) return current;
      const createdAt = this.clock().toISOString();
      const receipt: WorkstationShellConsentReceipt = {
        version: RECEIPT_VERSION,
        ...input.subject,
        ...input.identity,
        createdAt,
      };
      // Re-pairing or folder replacement supersedes older receipts for the
      // same Human + lexical Current Folder instead of growing without bound.
      const retained = current.data.receipts.filter(
        (candidate) =>
          !(
            candidate.instanceId === input.subject.instanceId &&
            candidate.userId === input.subject.userId &&
            candidate.canonicalRoot === input.identity.canonicalRoot
          ),
      );
      return await this.write([...retained, receipt]);
    });
  }

  async revoke(input: {
    readonly instanceId: string;
    readonly userId: string;
    readonly canonicalRoot: string;
  }): Promise<WorkstationShellConsentStoreResult<void>> {
    return this.serialized(async () => {
      const current = await this.read();
      if (!current.ok) return current;
      const retained = current.data.receipts.filter(
        (receipt) =>
          !(
            receipt.instanceId === input.instanceId &&
            receipt.userId === input.userId &&
            receipt.canonicalRoot === input.canonicalRoot
          ),
      );
      if (retained.length === current.data.receipts.length) {
        return { ok: true, data: undefined };
      }
      return await this.write(retained);
    });
  }
}
