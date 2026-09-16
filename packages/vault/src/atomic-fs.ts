import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

import { VaultSchemaError } from "./errors.ts";
import type { VaultDiskEnvelope } from "./disk-types.ts";
import { validateVaultEnvelope } from "./disk-validate.ts";

export async function readVaultFile(path: string): Promise<VaultDiskEnvelope | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new VaultSchemaError(`vault persistence parse (json) at ${path}`);
    }
    return validateVaultEnvelope(parsed);
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return undefined;
    }
    throw e;
  }
}

export async function atomicWriteVaultFile(
  finalPath: string,
  payload: VaultDiskEnvelope,
): Promise<void> {
  await atomicWriteJsonFile(finalPath, payload);
}

export async function atomicWriteJsonFile(
  finalPath: string,
  payload: unknown,
): Promise<void> {
  const serial = `${JSON.stringify(payload)}\n`;
  const dir = dirname(finalPath);
  await mkdir(dir, { recursive: true });
  const base = basename(finalPath);
  const sibling = join(
    dir,
    `${base}.tmp-${String(process.pid)}-${randomBytes(4).toString("hex")}`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(sibling, "wx", 0o600);
    await handle.writeFile(serial, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(sibling, finalPath);
  } catch {
    if (handle) {
      await handle.close().catch(() => {});
    }
    await unlink(sibling).catch(() => {});
    throw new VaultSchemaError(`atomic persistence failed (${finalPath})`);
  }
}
