import { createHmac, randomUUID } from "node:crypto";
import type { WorkspaceReceipt as RelayWorkspaceReceipt } from "@nautilo/relay";
import {
  CodexHostError,
  type CurrentFolderSnapshot,
  type CurrentFolderSnapshotSource,
  type HostClock,
  type HostFilesystem,
  type OpaqueHandle,
  type ResolvedWorkspace,
  type WorkspaceIdentity,
  type WorkspaceReceipt,
} from "./contracts";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_RECEIPTS = 128;

interface ReceiptRecord {
  readonly receipt: WorkspaceReceipt;
  readonly rootPath: string;
  readonly identity: WorkspaceIdentity;
  readonly selectedAliasIdentity: WorkspaceIdentity;
}

export interface WorkspaceReceiptAuthorityOptions {
  readonly snapshots: CurrentFolderSnapshotSource;
  readonly filesystem: Pick<HostFilesystem, "lstat" | "stat" | "realpath">;
  readonly clock: HostClock;
  readonly ttlMs?: number;
  readonly maxReceipts?: number;
  readonly newHandle?: () => OpaqueHandle;
  /** Persistent host secret, injected by Electron and never sent to the server. */
  readonly hmacKey: Uint8Array | string;
}

/**
 * Stores actual paths only in the paired host. A browser/server sees a receipt
 * handle and session metadata, never a path-derived fingerprint.
 */
export class CodexWorkspaceReceiptAuthority {
  private readonly records = new Map<OpaqueHandle, ReceiptRecord>();
  private readonly ttlMs: number;
  private readonly maxReceipts: number;
  private readonly newHandle: () => OpaqueHandle;

  constructor(private readonly options: WorkspaceReceiptAuthorityOptions) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxReceipts = options.maxReceipts ?? DEFAULT_MAX_RECEIPTS;
    this.newHandle = options.newHandle ?? (() => randomUUID() as OpaqueHandle);
    if (this.ttlMs <= 0 || this.maxReceipts <= 0) {
      throw new Error("Workspace receipt limits must be positive");
    }
  }

  async mint(): Promise<WorkspaceReceipt> {
    const first = await this.options.snapshots.read();
    const inspected = await this.inspect(first);
    const second = await this.options.snapshots.read();
    if (!sameSnapshot(first, second)) {
      throw stale("Host routing root changed while creating workspace receipt");
    }

    this.pruneExpired();
    while (this.records.size >= this.maxReceipts) {
      const oldest = this.records.keys().next().value;
      if (oldest === undefined) break;
      this.records.delete(oldest);
    }
    const receipt: WorkspaceReceipt = Object.freeze({
      handle: this.newHandle(),
      actorId: second.actorId,
      relayId: second.relayId,
      relaySessionId: second.relaySessionId,
      desktopSessionId: second.desktopSessionId,
      pairingGenerationRef: second.pairingGenerationRef,
      capabilityRevision: second.capabilityRevision,
      revision: second.revision,
      fingerprint: fingerprint(this.options.hmacKey, inspected.rootPath, inspected.selectedAliasIdentity, inspected.identity),
      issuedAt: this.options.clock.now(),
      expiresAt: this.options.clock.now() + this.ttlMs,
    });
    this.records.set(receipt.handle, { receipt, ...inspected });
    return receipt;
  }

  /** Invalidates on any host routing/session/pairing change. */
  invalidateAll(): void {
    this.records.clear();
  }

  invalidate(handle: OpaqueHandle): void {
    this.records.delete(handle);
  }

  async resolve(receipt: WorkspaceReceipt): Promise<ResolvedWorkspace> {
    this.pruneExpired();
    const record = this.records.get(receipt.handle);
    if (!record || !sameReceipt(record.receipt, receipt)) {
      throw stale("Workspace receipt is unknown, expired, or altered");
    }
    const first = await this.options.snapshots.read();
    if (!matchesReceipt(first, receipt)) {
      this.records.delete(receipt.handle);
      throw stale("Paired desktop session or host routing root no longer matches receipt");
    }
    const inspected = await this.inspect(first);
    const second = await this.options.snapshots.read();
    if (!sameSnapshot(first, second) || !matchesReceipt(second, receipt)) {
      this.records.delete(receipt.handle);
      throw stale("Host routing root changed while validating workspace receipt");
    }
    if (inspected.rootPath !== record.rootPath || !sameIdentity(inspected.selectedAliasIdentity, record.selectedAliasIdentity) || !sameIdentity(inspected.identity, record.identity)) {
      this.records.delete(receipt.handle);
      throw stale("Workspace root no longer matches the receipt");
    }
    return { receipt, rootPath: record.rootPath, selectedAliasIdentity: record.selectedAliasIdentity, identity: record.identity };
  }

  private async inspect(snapshot: CurrentFolderSnapshot): Promise<{ readonly rootPath: string; readonly selectedAliasIdentity: WorkspaceIdentity; readonly identity: WorkspaceIdentity }> {
    try {
      const alias = await this.options.filesystem.lstat(snapshot.selectedPath);
      const rootPath = await this.options.filesystem.realpath(snapshot.selectedPath);
      const stat = await this.options.filesystem.stat(rootPath);
      const aliasAfter = await this.options.filesystem.lstat(snapshot.selectedPath);
      if (!stat.isDirectory || stat.isSymbolicLink) {
        throw new Error("Host routing root is not a real directory");
      }
      if (!sameIdentity({ device: alias.dev, inode: alias.ino }, { device: aliasAfter.dev, inode: aliasAfter.ino })) {
        throw stale("Host routing root alias changed while resolving workspace");
      }
      return { rootPath, selectedAliasIdentity: { device: alias.dev, inode: alias.ino }, identity: { device: stat.dev, inode: stat.ino } };
    } catch (error) {
      if (error instanceof CodexHostError) throw error;
      throw new CodexHostError("WORKSPACE_UNAVAILABLE", "Host routing root is unavailable");
    }
  }

  private pruneExpired(): void {
    const now = this.options.clock.now();
    for (const [handle, record] of this.records) {
      if (record.receipt.expiresAt <= now) this.records.delete(handle);
    }
  }
}

/** Converts a local receipt to the exact v8 wire receipt shape without a path. */
export function toRelayWorkspaceReceipt(receipt: WorkspaceReceipt): RelayWorkspaceReceipt {
  return {
    workspaceRef: receipt.handle,
    revision: receipt.revision,
    fingerprint: receipt.fingerprint,
    issuedAt: new Date(receipt.issuedAt).toISOString(),
    expiresAt: new Date(receipt.expiresAt).toISOString(),
  };
}

function sameSnapshot(left: CurrentFolderSnapshot, right: CurrentFolderSnapshot): boolean {
  return left.actorId === right.actorId && left.relayId === right.relayId &&
    left.relaySessionId === right.relaySessionId && left.desktopSessionId === right.desktopSessionId &&
    left.pairingGenerationRef === right.pairingGenerationRef && left.capabilityRevision === right.capabilityRevision &&
    left.revision === right.revision && left.selectedPath === right.selectedPath;
}

function matchesReceipt(snapshot: CurrentFolderSnapshot, receipt: WorkspaceReceipt): boolean {
  return snapshot.actorId === receipt.actorId && snapshot.relayId === receipt.relayId &&
    snapshot.relaySessionId === receipt.relaySessionId && snapshot.desktopSessionId === receipt.desktopSessionId &&
    snapshot.pairingGenerationRef === receipt.pairingGenerationRef && snapshot.capabilityRevision === receipt.capabilityRevision && snapshot.revision === receipt.revision;
}

function sameReceipt(left: WorkspaceReceipt, right: WorkspaceReceipt): boolean {
  return left.handle === right.handle && left.actorId === right.actorId && left.relayId === right.relayId &&
    left.relaySessionId === right.relaySessionId && left.desktopSessionId === right.desktopSessionId &&
    left.pairingGenerationRef === right.pairingGenerationRef && left.capabilityRevision === right.capabilityRevision &&
    left.revision === right.revision && left.fingerprint === right.fingerprint && left.issuedAt === right.issuedAt && left.expiresAt === right.expiresAt;
}

function sameIdentity(left: WorkspaceIdentity, right: WorkspaceIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function fingerprint(key: Uint8Array | string, rootPath: string, alias: WorkspaceIdentity, target: WorkspaceIdentity): string {
  return createHmac("sha256", key).update(rootPath).update("\u0000").update(`${alias.device}:${alias.inode}`).update("\u0000").update(`${target.device}:${target.inode}`).digest("hex");
}

function stale(message: string): CodexHostError {
  return new CodexHostError("WORKSPACE_STALE", message);
}
