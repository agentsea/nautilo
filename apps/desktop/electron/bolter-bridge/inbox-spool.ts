import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, unlink, type FileHandle } from "node:fs/promises";
import { renameWithWindowsRetry } from "@nautilo/config/private-filesystem";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface BolterSpoolScope {
  readonly serverId: string;
  readonly userId: string;
  readonly connectionId: string;
}

/** Supplied by Desktop's protected storage owner; never a plaintext fallback. */
export interface BolterSpoolCipher {
  isAvailable(): boolean;
  seal(plaintext: string): Promise<Uint8Array>;
  open(ciphertext: Uint8Array): Promise<string>;
}

export interface BolterSpoolReceipt {
  readonly id: string;
  readonly fingerprint: string;
}

export interface BolterSpoolBatch extends BolterSpoolReceipt {
  readonly jsonl: string;
}

const recordName = /^\d+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.sealed$/;
const unavailable = () => new Error("Bolter inbox storage is unavailable.");
const fingerprint = (content: string) => createHash("sha256").update(content).digest("hex");
const identity = (stat: Stats) => `${stat.dev}:${stat.ino}`;
function protectedStat(stat: Stats): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 &&
    (!process.getuid || stat.uid === process.getuid());
}
async function protectedDirectory(directory: string): Promise<Stats> {
  const stat = await lstat(directory);
  if (!protectedStat(stat) || await realpath(directory) !== resolve(directory)) throw unavailable();
  return stat;
}
interface BolterSpoolOptions {
  readonly directory: string;
  readonly scope: BolterSpoolScope;
  readonly cipher: BolterSpoolCipher;
  readonly isCurrent: () => boolean;
}

/**
 * Connection-scoped durable ownership between the CLI child and server.
 * A successful store is the only event that may acknowledge a CLI batch.
 * Server acceptance, not a requested model turn, permits acknowledge().
 * An interrupted write can leave an encrypted temporary file, never an
 * acknowledged but uncommitted batch. Redelivery is deduplicated by the server.
 */
export class BolterInboxSpool {
  private readonly scope: BolterSpoolScope;
  private readonly options: BolterSpoolOptions;
  private directoryIdentity: string | null = null;
  private parentIdentity: string | null = null;
  private serial: Promise<unknown> = Promise.resolve();

  constructor(options: BolterSpoolOptions) {
    const scope = options.scope;
    if (typeof options.directory !== "string" || !isAbsolute(options.directory) ||
      !scope || typeof scope !== "object" || Array.isArray(scope) ||
      ["serverId", "userId", "connectionId"].some(key => {
        const value: unknown = scope[key as keyof BolterSpoolScope];
        return typeof value !== "string" || value.trim().length === 0;
      })) {
      throw unavailable();
    }
    this.scope = Object.freeze({ serverId: scope.serverId, userId: scope.userId, connectionId: scope.connectionId });
    // Capture functions as well as paths: caller mutation cannot replace the codec or fence.
    const cipher = Object.freeze({
      isAvailable: options.cipher.isAvailable.bind(options.cipher),
      seal: options.cipher.seal.bind(options.cipher),
      open: options.cipher.open.bind(options.cipher),
    });
    this.options = Object.freeze({ directory: options.directory, scope: this.scope,
      cipher, isCurrent: options.isCurrent });
  }

  private current(): void {
    if (this.options.isCurrent() !== true || this.options.cipher.isAvailable() !== true) throw unavailable();
  }

  private async directory(): Promise<void> {
    this.current();
    const directory = this.options.directory;
    const parent = await protectedDirectory(dirname(directory));
    const stat = await protectedDirectory(directory);
    if ((this.parentIdentity !== null && this.parentIdentity !== identity(parent)) ||
      (this.directoryIdentity !== null && this.directoryIdentity !== identity(stat))) throw unavailable();
    this.parentIdentity = identity(parent);
    this.directoryIdentity = identity(stat);
    this.current();
  }

  private async directoryHandle(): Promise<FileHandle> {
    await this.directory();
    this.current();
    const handle = await open(this.options.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!protectedStat(stat) || identity(stat) !== this.directoryIdentity) throw unavailable();
      await this.directory();
      this.current();
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  private async syncDirectory(handle: FileHandle): Promise<void> {
    const stat = await handle.stat();
    if (!protectedStat(stat) || identity(stat) !== this.directoryIdentity) throw unavailable();
    await handle.sync();
    // A pinned handle alone does not prove the current path still owns the batch.
    await this.directory();
    this.current();
  }

  private async serialized<T>(run: () => Promise<T>): Promise<T> {
    const result = this.serial.then(run, run);
    this.serial = result.catch(() => undefined);
    try {
      const value = await result;
      // Async cleanup is part of the operation: retirement during close must not report success.
      this.current();
      return value;
    } catch { throw unavailable(); }
  }

  async store(jsonl: string): Promise<BolterSpoolReceipt> {
    return this.serialized(async () => {
      await this.directory();
      if (!jsonl.trim()) throw unavailable();
      const digest = fingerprint(jsonl);
      const plaintext = JSON.stringify({ version: 1, scope: this.scope, fingerprint: digest, jsonl });
      const ciphertext = await this.options.cipher.seal(plaintext);
      this.current();
      if (ciphertext.byteLength === 0) throw unavailable();
      const id = `${Date.now()}-${randomUUID()}.sealed`;
      const temporary = join(this.options.directory, `${id}.pending`);
      const committed = join(this.options.directory, id);
      let renamed = false;
      const directory = await this.directoryHandle();
      try {
        this.current();
        const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        let writtenIdentity: string;
        try {
          await file.writeFile(ciphertext);
          await file.sync();
          writtenIdentity = identity(await file.stat());
        } finally { await file.close(); }
        await this.directory();
        this.current();
        await renameWithWindowsRetry(temporary, committed);
        renamed = true;
        const entry = await lstat(committed);
        if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 ||
          identity(entry) !== writtenIdentity) throw unavailable();
        await this.syncDirectory(directory);
        this.current();
        return { id, fingerprint: digest };
      } finally {
        if (!renamed) await unlink(temporary).catch(() => undefined);
        await directory.close();
      }
    });
  }

  /** Enumerates committed ciphertext records only; does not expose content. */
  async pending(): Promise<readonly string[]> {
    return this.serialized(async () => {
      await this.directory();
      const names = (await readdir(this.options.directory)).filter(name => recordName.test(name));
      this.current();
      return names.sort();
    });
  }

  private async readCommitted(id: string): Promise<BolterSpoolBatch> {
    await this.directory();
    if (!recordName.test(id)) throw unavailable();
    const file = await open(join(this.options.directory, id), constants.O_RDONLY | constants.O_NOFOLLOW);
    let ciphertext: Uint8Array;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 ||
        (process.getuid && stat.uid !== process.getuid())) throw unavailable();
      ciphertext = await file.readFile();
    } finally { await file.close(); }
    const decoded: unknown = JSON.parse(await this.options.cipher.open(ciphertext));
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw unavailable();
    const record = decoded as Record<string, unknown>;
    const scope = record["scope"];
    if (record["version"] !== 1 || !scope || typeof scope !== "object" || Array.isArray(scope)) throw unavailable();
    const saved = scope as Record<string, unknown>;
    if (saved["serverId"] !== this.scope.serverId || saved["userId"] !== this.scope.userId ||
      saved["connectionId"] !== this.scope.connectionId || typeof record["jsonl"] !== "string" ||
      typeof record["fingerprint"] !== "string" || fingerprint(record["jsonl"]) !== record["fingerprint"]) throw unavailable();
    this.current();
    return { id, fingerprint: record["fingerprint"], jsonl: record["jsonl"] };
  }

  read(id: string): Promise<BolterSpoolBatch> {
    return this.serialized(() => this.readCommitted(id));
  }

  async acknowledge(receipt: BolterSpoolReceipt): Promise<void> {
    return this.serialized(async () => {
      const directory = await this.directoryHandle();
      try {
        const batch = await this.readCommitted(receipt.id);
        if (batch.fingerprint !== receipt.fingerprint) throw unavailable();
        await this.directory();
        this.current();
        await unlink(join(this.options.directory, receipt.id));
        await this.syncDirectory(directory);
        this.current();
      } finally { await directory.close(); }
    });
  }
}

/** Prepare only a newly allocated connection directory, never repair a foreign one. */
export async function createBolterSpoolDirectory(parent: string): Promise<string> {
  try {
    if (typeof parent !== "string" || !isAbsolute(parent)) throw unavailable();
    const stat = await protectedDirectory(parent);
    const directory = join(parent, randomUUID());
    const handle = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (!protectedStat(opened) || identity(opened) !== identity(stat)) throw unavailable();
      await mkdir(directory, { mode: 0o700 });
      await handle.sync();
      if (identity(await protectedDirectory(parent)) !== identity(stat)) throw unavailable();
      await protectedDirectory(directory);
    } finally { await handle.close(); }
    return directory;
  } catch { throw unavailable(); }
}
