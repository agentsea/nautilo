import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { dirname, isAbsolute, parse, resolve } from "node:path";
import { isPrivateFilesystemPathAsync, secureFilesystemPath } from "@nautilo/config/private-filesystem";

export class ProtectedHandoffError extends Error {
  constructor() {
    super("The protected handoff could not be written safely.");
    this.name = "ProtectedHandoffError";
  }
}

export interface ProtectedHandoffReservation {
  write(value: Record<string, unknown>): Promise<void>;
  discard(): Promise<void>;
}

type FileIdentity = { readonly dev: bigint; readonly ino: bigint };

async function namesReservedFile(path: string, identity: FileIdentity | undefined): Promise<boolean> {
  if (!identity) return false;
  try {
    const entry = await lstat(path, { bigint: true });
    return entry.isFile() && !entry.isSymbolicLink() && entry.dev === identity.dev && entry.ino === identity.ino;
  } catch { return false; }
}

async function assertPrivateFile(path: string, identity: FileIdentity): Promise<void> {
  if (!await namesReservedFile(path, identity) || !await isPrivateFilesystemPathAsync(path)
    || !await namesReservedFile(path, identity)) throw new ProtectedHandoffError();
}

/** Read a bounded owner-only JSON handoff without following symlinks. */
export async function readProtectedHandoff(source: string): Promise<unknown> {
  if (source.trim() === "" || source === "-" || !isAbsolute(source)) {
    throw new ProtectedHandoffError();
  }
  const path = resolve(source);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await assertNoSymlinkParents(path);
    const before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()
      || (process.platform !== "win32" && (before.mode & 0o777n) !== 0o600n)) {
      throw new ProtectedHandoffError();
    }
    await assertPrivateFile(path, before);
    handle = await open(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.size < 2n || opened.size > 1024n * 1024n) {
      throw new ProtectedHandoffError();
    }
    return JSON.parse(await handle.readFile({ encoding: "utf8" })) as unknown;
  } catch {
    throw new ProtectedHandoffError();
  } finally {
    try { await handle?.close(); } catch { /* fixed public failure above */ }
  }
}

async function assertNoSymlinkParents(path: string): Promise<void> {
  const root = parse(path).root;
  let current = dirname(path);
  while (current !== root) {
    const entry = await lstat(current);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new ProtectedHandoffError();
    }
    current = dirname(current);
  }
}

/** Reserve one new owner-only file before a remote mutation can mint a secret. */
export async function reserveProtectedHandoff(
  destination: string,
): Promise<ProtectedHandoffReservation> {
  if (destination.trim() === "" || destination === "-" || !isAbsolute(destination)) {
    throw new ProtectedHandoffError();
  }
  const path = resolve(destination);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let identity: FileIdentity | undefined;
  let active = false;
  const remove = async (): Promise<void> => {
    if (!active) return;
    active = false;
    try { await handle?.close(); } catch { /* fixed public failure below */ }
    if (await namesReservedFile(path, identity)) {
      try { await unlink(path); } catch { /* leave an inaccessible owned file in place */ }
    }
  };
  try {
    await assertNoSymlinkParents(path);
    handle = await open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
      0o600,
    );
    active = true;
    const file = handle;
    const reserved = await file.stat({ bigint: true });
    if (!reserved.isFile()) throw new ProtectedHandoffError();
    identity = reserved;
    // The reservation is still empty; restrict its ACL before a caller can
    // perform the remote operation which creates the secret.
    if (process.platform === "win32") await secureFilesystemPath(path);
    await assertPrivateFile(path, reserved);
    let writing = false;
    return {
      write: async (value) => {
        if (!active || writing) throw new ProtectedHandoffError();
        writing = true;
        try {
          await assertPrivateFile(path, reserved);
          await file.writeFile(`${JSON.stringify(value)}\n`, { encoding: "utf8" });
          await file.sync();
          await assertPrivateFile(path, reserved);
          if (!active) throw new ProtectedHandoffError();
          await file.close();
          active = false;
        } catch {
          await remove();
          throw new ProtectedHandoffError();
        }
      },
      discard: async () => {
        if (active && writing) throw new ProtectedHandoffError();
        await remove();
      },
    };
  } catch {
    await remove();
    throw new ProtectedHandoffError();
  }
}

/** Create one new owner-only JSON handoff without following symlinks or overwriting. */
export async function writeProtectedHandoff(
  destination: string,
  value: Record<string, unknown>,
): Promise<void> {
  const reservation = await reserveProtectedHandoff(destination);
  await reservation.write(value);
}
