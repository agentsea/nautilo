import { chmod, mkdir, open, readFile, rename, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  PERSONAL_PROVIDER_CUSTODY_ENV, PersonalProviderCustodyError,
  createPersonalProviderCustody, parsePersonalProviderCustody,
  personalProviderCustodyFromEnvFile, serializePersonalProviderCustody,
  type PersonalProviderCustody,
} from "./personal-provider-custody";

export interface PersonalProviderCustodyFileOptions {
  readonly instanceRootDir: string;
  readonly instanceEnvPath?: string;
  /** Must query the actual target database; failed/unknown evidence must throw. */
  readonly hasCredentialRecords: () => Promise<boolean>;
}

async function readCanonical(path: string): Promise<string> {
  try { return await readFile(path, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw new PersonalProviderCustodyError("custody_unavailable");
  }
}

const locks = new Map<string, Promise<unknown>>();

async function withCustodyLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(root) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    const lockPath = join(root, ".personal-provider-custody.lock");
    try { await mkdir(lockPath, { mode: 0o700 }); } catch {
      // Never steal an interrupted or another process's lock. The operator can
      // remove a stale lock after proving every writer is stopped.
      throw new PersonalProviderCustodyError("custody_unavailable");
    }
    try { return await operation(); } finally { await rmdir(lockPath); }
  });
  locks.set(root, current);
  try { return await current; } finally { if (locks.get(root) === current) locks.delete(root); }
}

async function persist(root: string, path: string, before: string, custody: PersonalProviderCustody): Promise<void> {
  const temp = join(root, `.personal-provider-custody.${randomUUID()}.tmp`);
  const line = `${PERSONAL_PROVIDER_CUSTODY_ENV}=${serializePersonalProviderCustody(custody)}`;
  const body = before.split(/\r?\n/).filter((item) => !/^\s*(?:export\s+)?NAUTILO_PERSONAL_PROVIDER_CUSTODY\s*=/.test(item));
  body.push(line, "");
  try {
    const file = await open(temp, "wx", 0o600);
    try { await file.writeFile(body.join("\n"), "utf8"); await file.sync(); } finally { await file.close(); }
    if (await readCanonical(path) !== before) throw new PersonalProviderCustodyError("custody_unavailable");
    await rename(temp, path);
    if (process.platform !== "win32") await chmod(path, 0o600);
    // Persist the directory entry as well as the file before reporting success.
    if (process.platform !== "win32") {
      const directory = await open(root, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } catch {
    throw new PersonalProviderCustodyError("custody_unavailable");
  } finally { await unlink(temp).catch(() => undefined); }
}

/** Source/local canonical custody; deployment controllers own injected environments. */
export async function ensurePersonalProviderCustodyFile(options: PersonalProviderCustodyFileOptions): Promise<PersonalProviderCustody> {
  return withCustodyLock(options.instanceRootDir, async () => {
    const path = options.instanceEnvPath ?? join(options.instanceRootDir, "instance.env");
    const before = await readCanonical(path);
    const raw = personalProviderCustodyFromEnvFile(before);
    if (raw !== undefined) return parsePersonalProviderCustody(raw);
    if (await options.hasCredentialRecords()) throw new PersonalProviderCustodyError("custody_missing");
    const custody = createPersonalProviderCustody();
    await persist(options.instanceRootDir, path, before, custody);
    return custody;
  });
}

/**
 * Explicit disaster operation while personal dispatch is stopped. The caller
 * supplies a lost key ID from the retained records. Retry observes the already
 * committed replacement; it never rotates that replacement again.
 */
export async function resetPersonalProviderCustodyFile(options: {
  readonly instanceRootDir: string;
  readonly instanceEnvPath?: string;
  readonly lostKeyId: string;
  readonly confirmReset: true;
  readonly hasLostKeyRecords: (keyId: string) => Promise<boolean>;
}): Promise<PersonalProviderCustody> {
  return withCustodyLock(options.instanceRootDir, async () => {
    if (options.confirmReset !== true || !options.lostKeyId || !await options.hasLostKeyRecords(options.lostKeyId)) {
      throw new PersonalProviderCustodyError("custody_unavailable");
    }
    const path = options.instanceEnvPath ?? join(options.instanceRootDir, "instance.env");
    const before = await readCanonical(path);
    const raw = personalProviderCustodyFromEnvFile(before);
    let current: PersonalProviderCustody | undefined;
    if (raw !== undefined) {
      try { current = parsePersonalProviderCustody(raw); } catch (error) {
        if (!(error instanceof PersonalProviderCustodyError)) throw error;
      }
    }
    if (current && current.keyId !== options.lostKeyId) {
      if (current.resetFromKeyId === options.lostKeyId) return current;
      throw new PersonalProviderCustodyError("custody_unavailable");
    }
    const replacement = { ...createPersonalProviderCustody(), resetFromKeyId: options.lostKeyId };
    await persist(options.instanceRootDir, path, before, replacement);
    return replacement;
  });
}
