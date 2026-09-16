import { randomBytes } from "node:crypto";
import { mkdir, readFile, rmdir } from "node:fs/promises";
import { join } from "node:path";

import { transaction } from "@nautilo/config-guard";

/**
 * Per-instance HMAC pepper for remote-controller pairing challenges. The
 * plaintext value is persisted in the selected instance.env and is never
 * returned in diagnostics or logs.
 */
export const REMOTE_PAIRING_PEPPER_KEY = "NAUTILO_REMOTE_PAIRING_PEPPER";

export interface EnsureRemotePairingPepperDeps {
  readInstanceEnv: (instanceRootDir: string) => Promise<string>;
  /** Persist only when absent, then return the canonical persisted value. */
  writePepperToInstanceEnv: (
    pepper: string,
    instanceRootDir: string,
  ) => Promise<string>;
  /** 32 random bytes encoded as 64 hexadecimal characters by default. */
  randomPepper: () => string;
}

export interface EnsureRemotePairingPepperArgs {
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

/** At least 32 random bytes, encoded in an unambiguous env-safe format. */
export function isValidRemotePairingPepper(value: string): boolean {
  return /^[a-f0-9]{64,}$/i.test(value) && value.length % 2 === 0;
}

export async function ensureRemotePairingPepper(
  args: EnsureRemotePairingPepperArgs,
  deps: EnsureRemotePairingPepperDeps,
): Promise<string> {
  return withInstanceLock(args.instanceRootDir, async () => {
    const existing = parseDotenvValue(
      await deps.readInstanceEnv(args.instanceRootDir),
      REMOTE_PAIRING_PEPPER_KEY,
    );
    if (existing !== undefined) {
      if (!isValidRemotePairingPepper(existing)) {
        throw new Error(
          "Remote pairing pepper in instance.env is invalid; rotate it explicitly before starting Nautilo.",
        );
      }
      return existing;
    }

    const candidate = deps.randomPepper();
    if (!isValidRemotePairingPepper(candidate)) {
      throw new Error("Remote pairing pepper generator returned an invalid value.");
    }
    try {
      const canonical = await deps.writePepperToInstanceEnv(
        candidate,
        args.instanceRootDir,
      );
      if (!isValidRemotePairingPepper(canonical)) {
        throw new Error("invalid canonical value");
      }
      return canonical;
    } catch {
      throw new Error("Remote pairing pepper could not be persisted.");
    }
  });
}

export function defaultEnsureRemotePairingPepperDeps(): EnsureRemotePairingPepperDeps {
  return {
    readInstanceEnv: async (instanceRootDir) => {
      try {
        return await readFile(join(instanceRootDir, "instance.env"), "utf8");
      } catch {
        return "";
      }
    },
    writePepperToInstanceEnv: async (pepper, instanceRootDir) => {
      const lockDir = join(instanceRootDir, ".remote-pairing-pepper.lock");
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
      if (!acquired) throw new Error("pairing pepper lock timed out");
      try {
        const canonicalPath = join(instanceRootDir, "instance.env");
        const before = parseDotenvValue(
          await readFile(canonicalPath, "utf8").catch(() => ""),
          REMOTE_PAIRING_PEPPER_KEY,
        );
        if (before !== undefined) return before;

        const result = await transaction({
          actor: "cli",
          reason: "D458: remote controller pairing pepper",
          healthCheck: "none",
          overwrite: true,
          operations: [{ type: "set", key: REMOTE_PAIRING_PEPPER_KEY, value: pepper }],
        });
        if (!result.success) {
          throw new Error("ensureRemotePairingPepper: failed to persist secret.");
        }
        const canonicalRaw = await readFile(canonicalPath, "utf8").catch(() => "");
        const canonical = parseDotenvValue(canonicalRaw, REMOTE_PAIRING_PEPPER_KEY);
        if (canonical === undefined) {
          throw new Error("ensureRemotePairingPepper: canonical readback failed.");
        }
        return canonical;
      } finally {
        await rmdir(lockDir).catch(() => undefined);
      }
    },
    randomPepper: () => randomBytes(32).toString("hex"),
  };
}
