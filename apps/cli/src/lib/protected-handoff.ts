import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { dirname, isAbsolute, parse, resolve } from "node:path";

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

/** Read a bounded owner-only JSON handoff without following symlinks. */
export async function readProtectedHandoff(source: string): Promise<unknown> {
  if (source.trim() === "" || source === "-" || !isAbsolute(source)) {
    throw new ProtectedHandoffError();
  }
  const path = resolve(source);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await assertNoSymlinkParents(path);
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || (before.mode & 0o777) !== 0o600) {
      throw new ProtectedHandoffError();
    }
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size < 2 || opened.size > 1024 * 1024) {
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
  try {
    await assertNoSymlinkParents(path);
    const handle = await open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    let active = true;
    const remove = async (): Promise<void> => {
      if (!active) return;
      active = false;
      try { await handle.close(); } catch { /* fixed public failure below */ }
      try { await unlink(path); } catch { /* fixed public failure below */ }
    };
    return {
      write: async (value) => {
        if (!active) throw new ProtectedHandoffError();
        try {
          await handle.writeFile(`${JSON.stringify(value)}\n`, { encoding: "utf8" });
          await handle.sync();
          await handle.chmod(0o600);
          await handle.close();
          active = false;
        } catch {
          await remove();
          throw new ProtectedHandoffError();
        }
      },
      discard: remove,
    };
  } catch {
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
