import { randomBytes } from "node:crypto";
import { mkdir, readFile, rmdir } from "node:fs/promises";
import { join } from "node:path";

import { transaction } from "@nautilo/config-guard";

/**
 * Per-instance AES-256 key for protecting Expo push-token capability material
 * at rest. The plaintext stays only in the selected instance.env and the
 * server overlay; callers must never include it in diagnostics or logs.
 */
export const PUSH_TOKEN_ENCRYPTION_KEY = "NAUTILO_PUSH_TOKEN_ENCRYPTION_KEY";

export interface EnsurePushTokenEncryptionKeyDeps {
  readInstanceEnv: (instanceRootDir: string) => Promise<string>;
  /** Persist only when absent, then return the canonical persisted value. */
  writeKeyToInstanceEnv: (
    key: string,
    instanceRootDir: string,
  ) => Promise<string>;
  /** Exactly 32 random bytes encoded as 64 hexadecimal characters by default. */
  randomKey: () => string;
}

export interface EnsurePushTokenEncryptionKeyArgs {
  instanceRootDir: string;
}

const instanceLocks = new Map<string, Promise<void>>();

async function withInstanceLock<T>(
  instanceRootDir: string,
  action: () => Promise<T>,
): Promise<T> {
  const previous = instanceLocks.get(instanceRootDir) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  instanceLocks.set(instanceRootDir, tail);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (instanceLocks.get(instanceRootDir) === tail) {
      instanceLocks.delete(instanceRootDir);
    }
  }
}

function parseDotenvValue(raw: string, key: string): string | undefined {
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1 || trimmed.slice(0, separator).trim() !== key) continue;
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value.trim().length > 0 ? value : undefined;
  }
  return undefined;
}

/** Exactly 32 bytes, canonically encoded as lowercase or uppercase hex. */
export function isValidPushTokenEncryptionKey(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

export async function ensurePushTokenEncryptionKey(
  args: EnsurePushTokenEncryptionKeyArgs,
  deps: EnsurePushTokenEncryptionKeyDeps,
): Promise<string> {
  return withInstanceLock(args.instanceRootDir, async () => {
    const existing = parseDotenvValue(
      await deps.readInstanceEnv(args.instanceRootDir),
      PUSH_TOKEN_ENCRYPTION_KEY,
    );
    if (existing !== undefined) {
      if (!isValidPushTokenEncryptionKey(existing)) {
        throw new Error(
          "Push-token encryption key in instance.env is invalid; rotate it explicitly before starting Nautilo.",
        );
      }
      return existing;
    }

    const candidate = deps.randomKey();
    if (!isValidPushTokenEncryptionKey(candidate)) {
      throw new Error("Push-token encryption key generator returned an invalid value.");
    }
    try {
      const canonical = await deps.writeKeyToInstanceEnv(
        candidate,
        args.instanceRootDir,
      );
      if (!isValidPushTokenEncryptionKey(canonical)) {
        throw new Error("invalid canonical value");
      }
      return canonical;
    } catch {
      throw new Error("Push-token encryption key could not be persisted.");
    }
  });
}

export function defaultEnsurePushTokenEncryptionKeyDeps(): EnsurePushTokenEncryptionKeyDeps {
  return {
    readInstanceEnv: async (instanceRootDir) => {
      try {
        return await readFile(join(instanceRootDir, "instance.env"), "utf8");
      } catch {
        return "";
      }
    },
    writeKeyToInstanceEnv: async (key, instanceRootDir) => {
      const lockDir = join(instanceRootDir, ".push-token-encryption-key.lock");
      let acquired = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          await mkdir(lockDir);
          acquired = true;
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
        }
      }
      if (!acquired) throw new Error("push-token encryption key lock timed out");
      try {
        const canonicalPath = join(instanceRootDir, "instance.env");
        const before = parseDotenvValue(
          await readFile(canonicalPath, "utf8").catch(() => ""),
          PUSH_TOKEN_ENCRYPTION_KEY,
        );
        if (before !== undefined) return before;

        const result = await transaction({
          actor: "cli",
          reason: "D468: push-token encryption key",
          healthCheck: "none",
          overwrite: true,
          operations: [{ type: "set", key: PUSH_TOKEN_ENCRYPTION_KEY, value: key }],
        });
        if (!result.success) {
          throw new Error("ensurePushTokenEncryptionKey: failed to persist secret.");
        }
        const canonicalRaw = await readFile(canonicalPath, "utf8").catch(() => "");
        const canonical = parseDotenvValue(canonicalRaw, PUSH_TOKEN_ENCRYPTION_KEY);
        if (canonical === undefined) {
          throw new Error("ensurePushTokenEncryptionKey: canonical readback failed.");
        }
        return canonical;
      } finally {
        await rmdir(lockDir).catch(() => undefined);
      }
    },
    randomKey: () => randomBytes(32).toString("hex"),
  };
}
