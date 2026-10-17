import {
  lstat,
  open,
  readFile,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { ensurePrivateDirectory, isPrivateFilesystemPathAsync, publishPrivateFileAtomically, syncDirectory } from "@nautilo/config/private-filesystem";

import {
  parseLaunchReceipt,
  validateLaunchReceiptTransition,
  type LaunchReceipt,
  type LaunchReceiptValidationCode,
} from "./launch-receipt";

const OWNER_ONLY_MODE = 0o600;
const MAX_RECEIPT_BYTES = 1024 * 1024;

export type LaunchReceiptStoreErrorCode =
  | "unsafe-path"
  | "unsafe-permissions"
  | "receipt-too-large"
  | "invalid-json"
  | "invalid-receipt"
  | "revision-conflict"
  | "invalid-transition"
  | "io-failure"
  | "publish-unknown";

export class LaunchReceiptStoreError extends Error {
  readonly code: LaunchReceiptStoreErrorCode;
  readonly validationCode?: LaunchReceiptValidationCode | undefined;
  readonly validationPath?: string | undefined;

  constructor(
    code: LaunchReceiptStoreErrorCode,
    options: {
      readonly validationCode?: LaunchReceiptValidationCode | undefined;
      readonly validationPath?: string | undefined;
    } = {},
  ) {
    super(`Launch receipt store failed: ${code}`);
    this.name = "LaunchReceiptStoreError";
    this.code = code;
    this.validationCode = options.validationCode;
    this.validationPath = options.validationPath;
  }
}

/** Narrow test seam for an interruption after durable temp write, before publish. */
export interface LaunchReceiptWriteHooks {
  readonly beforeRename?: (() => void | Promise<void>) | undefined;
}

export interface WriteLaunchReceiptOptions {
  readonly hooks?: LaunchReceiptWriteHooks | undefined;
}

export interface UpdateLaunchReceiptOptions extends WriteLaunchReceiptOptions {
  readonly expectedRevision: number;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function assertSafeParent(path: string, create: boolean): Promise<boolean> {
  const parent = dirname(path);
  let status;
  try {
    status = await lstat(parent);
  } catch (error) {
    if (!isMissing(error)) throw error;
    if (!create) return false;
    await ensurePrivateDirectory(parent);
    status = await lstat(parent);
  }
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new LaunchReceiptStoreError("unsafe-path");
  }
  if (process.platform === "win32" ? !await isPrivateFilesystemPathAsync(parent) : (status.mode & 0o777) !== 0o700) {
    throw new LaunchReceiptStoreError("unsafe-permissions");
  }
  return true;
}

async function assertSafeTarget(
  path: string,
  options: { readonly allowMissing: boolean; readonly requireOwnerOnly: boolean },
): Promise<boolean> {
  try {
    const status = await lstat(path);
    if (status.isSymbolicLink() || !status.isFile()) {
      throw new LaunchReceiptStoreError("unsafe-path");
    }
    if (options.requireOwnerOnly && (process.platform === "win32"
      ? !await isPrivateFilesystemPathAsync(path)
      : (status.mode & 0o777) !== OWNER_ONLY_MODE)) {
      throw new LaunchReceiptStoreError("unsafe-permissions");
    }
    return true;
  } catch (error) {
    if (options.allowMissing && isMissing(error)) return false;
    throw error;
  }
}

function validateForStorage(value: unknown): LaunchReceipt {
  const parsed = parseLaunchReceipt(value);
  if (!parsed.ok) {
    throw new LaunchReceiptStoreError("invalid-receipt", {
      validationCode: parsed.code,
      validationPath: parsed.path,
    });
  }
  return parsed.receipt;
}

function redactStoreFailure(error: unknown): LaunchReceiptStoreError {
  return error instanceof LaunchReceiptStoreError
    ? error
    : new LaunchReceiptStoreError("io-failure");
}

function lockPath(path: string): string {
  return join(dirname(path), `.${basename(path)}.lock`);
}

async function withExclusiveLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  const lock = lockPath(path);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(lock, "wx", OWNER_ONLY_MODE);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      throw new LaunchReceiptStoreError("revision-conflict");
    }
    throw error;
  }

  let outcome: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };
  try {
    await handle.chmod(OWNER_ONLY_MODE);
    await handle.sync();
    outcome = { ok: true, value: await work() };
  } catch (error) {
    outcome = { ok: false, error };
  }

  let cleanupError: unknown;
  try {
    await handle.close();
  } catch (error) {
    cleanupError = error;
  }
  try {
    await unlink(lock);
  } catch (error) {
    cleanupError ??= error;
  }
  if (!outcome.ok) throw redactStoreFailure(outcome.error);
  if (cleanupError !== undefined) throw redactStoreFailure(cleanupError);
  return outcome.value;
}

export async function readLaunchReceipt(path: string): Promise<LaunchReceipt | null> {
  path = resolve(path);
  try {
    const parentExists = await assertSafeParent(path, false);
    if (!parentExists) return null;
    const exists = await assertSafeTarget(path, {
      allowMissing: true,
      requireOwnerOnly: true,
    });
    if (!exists) return null;

    const payload = await readFile(path);
    if (payload.byteLength > MAX_RECEIPT_BYTES) {
      throw new LaunchReceiptStoreError("receipt-too-large");
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(payload.toString("utf8"));
    } catch {
      throw new LaunchReceiptStoreError("invalid-json");
    }
    return validateForStorage(decoded);
  } catch (error) {
    throw redactStoreFailure(error);
  }
}

/**
 * Publishes an owner-only receipt with a durable same-directory temp file.
 * Any failure before rename leaves an existing known-good receipt untouched.
 */
async function publishLaunchReceipt(
  path: string,
  value: LaunchReceipt,
  options: WriteLaunchReceiptOptions = {},
): Promise<void> {
  const receipt = validateForStorage(value);
  await assertSafeParent(path, false);
  await assertSafeTarget(path, { allowMissing: true, requireOwnerOnly: false });

  let published = false;
  try {
    await publishPrivateFileAtomically(path, Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`), {
      beforePublish: async () => {
        await options.hooks?.beforeRename?.();
        await assertSafeTarget(path, { allowMissing: true, requireOwnerOnly: false });
      },
    });
    published = true;
    await syncDirectory(dirname(path));
  } catch (error) {
    if (error instanceof LaunchReceiptStoreError) throw error;
    throw new LaunchReceiptStoreError(published ? "publish-unknown" : "io-failure");
  }
}

function isCanonicalInitialReceipt(receipt: LaunchReceipt): boolean {
  return (
    receipt.revision === 0 &&
    receipt.stage === "planned" &&
    receipt.resources.length === 0 &&
    receipt.cleanup.state === "not-required" &&
    receipt.lastFailure === undefined &&
    receipt.claimableAt === undefined &&
    receipt.createdAt === receipt.updatedAt
  );
}

/** Creates one canonical initial receipt and refuses to replace any existing one. */
export async function writeLaunchReceipt(
  path: string,
  value: LaunchReceipt,
  options: WriteLaunchReceiptOptions = {},
): Promise<void> {
  path = resolve(path);
  try {
    const receipt = validateForStorage(value);
    if (!isCanonicalInitialReceipt(receipt)) {
      throw new LaunchReceiptStoreError("invalid-receipt", {
        validationCode: "invalid-transition",
        validationPath: "$",
      });
    }
    await assertSafeParent(path, true);
    await withExclusiveLock(path, async () => {
      const exists = await assertSafeTarget(path, {
        allowMissing: true,
        requireOwnerOnly: false,
      });
      if (exists) throw new LaunchReceiptStoreError("revision-conflict");
      await publishLaunchReceipt(path, receipt, options);
    });
  } catch (error) {
    throw redactStoreFailure(error);
  }
}

/**
 * Compare-and-update entry point used by reconcile retries. The caller must
 * supply the revision it inspected; stale checkpoints fail closed.
 */
export async function updateLaunchReceipt(
  path: string,
  options: UpdateLaunchReceiptOptions,
  update: (current: LaunchReceipt) => LaunchReceipt,
): Promise<LaunchReceipt> {
  path = resolve(path);
  try {
    await assertSafeParent(path, true);
    return await withExclusiveLock(path, async () => {
      const current = await readLaunchReceipt(path);
      if (current === null || current.revision !== options.expectedRevision) {
        throw new LaunchReceiptStoreError("revision-conflict");
      }
      const next = validateForStorage(update(current));
      const transition = validateLaunchReceiptTransition(current, next);
      if (!transition.ok) {
        throw new LaunchReceiptStoreError("invalid-transition", {
          validationCode: transition.code,
          validationPath: transition.path,
        });
      }
      await publishLaunchReceipt(path, next, options);
      return next;
    });
  } catch (error) {
    throw redactStoreFailure(error);
  }
}
