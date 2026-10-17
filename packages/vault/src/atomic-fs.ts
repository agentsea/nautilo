import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { publishPrivateFileAtomically } from "@nautilo/config/private-filesystem";

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
  const target = resolve(finalPath);
  await mkdir(dirname(target), { recursive: true });
  try {
    await publishPrivateFileAtomically(target, Buffer.from(serial));
  } catch {
    throw new VaultSchemaError(`atomic persistence failed (${finalPath})`);
  }
}
