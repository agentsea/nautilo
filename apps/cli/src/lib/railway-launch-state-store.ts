import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

const OWNER_DIRECTORY_MODE = 0o700;
const OWNER_FILE_MODE = 0o600;
const MAX_CHECKPOINT_BYTES = 1024 * 1024;

function missing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function within(root: string, path: string): boolean {
  const canonicalRoot = resolve(root);
  const canonicalPath = resolve(path);
  return canonicalPath.startsWith(`${canonicalRoot}${sep}`);
}

async function ensureDirectory(root: string, directory: string): Promise<void> {
  if (!within(root, directory) && resolve(root) !== resolve(directory)) throw new Error("Unsafe Railway state path");
  await mkdir(directory, { recursive: true, mode: OWNER_DIRECTORY_MODE });
  const status = await lstat(directory);
  if (status.isSymbolicLink() || !status.isDirectory()
    || (typeof process.getuid === "function" && status.uid !== process.getuid())
    || (process.platform !== "win32" && (status.mode & 0o077) !== 0)) {
    throw new Error("Unsafe Railway state path");
  }
}

/** Owner-only, bounded, atomic JSON storage for non-secret launch checkpoints. */
export class RailwayLaunchStateStore<T> {
  readonly #root: string;
  readonly #path: string;
  readonly #validate: (value: unknown) => T;

  constructor(input: {
    readonly root: string;
    readonly path: string;
    readonly validate: (value: unknown) => T;
  }) {
    if (!within(input.root, input.path)) throw new Error("Unsafe Railway state path");
    this.#root = resolve(input.root);
    this.#path = resolve(input.path);
    this.#validate = input.validate;
  }

  async read(): Promise<T | undefined> {
    let status;
    try {
      status = await lstat(this.#path);
    } catch (error) {
      if (missing(error)) return undefined;
      throw new Error("Railway state read failed");
    }
    if (status.isSymbolicLink() || !status.isFile() || status.size > MAX_CHECKPOINT_BYTES
      || (typeof process.getuid === "function" && status.uid !== process.getuid())
      || (process.platform !== "win32" && (status.mode & 0o077) !== 0)) {
      throw new Error("Unsafe Railway state path");
    }
    const flags = process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
    const handle = await open(this.#path, flags);
    try {
      const body = await handle.readFile();
      if (body.byteLength > MAX_CHECKPOINT_BYTES) throw new Error("Railway state read failed");
      return this.#validate(JSON.parse(body.toString("utf8")) as unknown);
    } catch {
      throw new Error("Railway state read failed");
    } finally {
      await handle.close();
    }
  }

  async write(value: T): Promise<void> {
    const validated = this.#validate(value);
    const body = `${JSON.stringify(validated, null, 2)}\n`;
    if (Buffer.byteLength(body, "utf8") > MAX_CHECKPOINT_BYTES) throw new Error("Railway state write failed");
    const directory = dirname(this.#path);
    await ensureDirectory(this.#root, directory);
    const temporary = `${this.#path}.tmp-${process.pid}-${Date.now()}`;
    try {
      const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
        | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);
      const handle = await open(temporary, flags, OWNER_FILE_MODE);
      try {
        await handle.writeFile(body, "utf8");
        await handle.chmod(OWNER_FILE_MODE);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.#path);
      await chmod(this.#path, OWNER_FILE_MODE);
    } catch {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new Error("Railway state write failed");
    }
  }
}

const SAFE_LAUNCH_DIRECTORY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

/** Bounded, owner-only discovery; callers still decide eligibility explicitly. */
export async function discoverRailwayLaunchStates<T>(input: {
  readonly root: string;
  readonly validate: (value: unknown) => T;
  readonly identity: (value: T) => string;
}): Promise<readonly { readonly launchId: string; readonly state: T }[]> {
  const launches = resolve(input.root, "launches");
  let entries;
  try {
    const status = await lstat(launches);
    if (status.isSymbolicLink() || !status.isDirectory()
      || (typeof process.getuid === "function" && status.uid !== process.getuid())
      || (process.platform !== "win32" && (status.mode & 0o077) !== 0)) throw new Error("Railway state discovery failed");
    entries = await readdir(launches, { withFileTypes: true });
  } catch (error) {
    if (missing(error)) return [];
    throw new Error("Railway state discovery failed");
  }
  if (entries.length > 1024) throw new Error("Railway state discovery failed");
  const result: { launchId: string; state: T }[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !SAFE_LAUNCH_DIRECTORY.test(entry.name)) throw new Error("Railway state discovery failed");
    const directory = await lstat(resolve(launches, entry.name));
    if (directory.isSymbolicLink() || !directory.isDirectory()
      || (typeof process.getuid === "function" && directory.uid !== process.getuid())
      || (process.platform !== "win32" && (directory.mode & 0o077) !== 0)) throw new Error("Railway state discovery failed");
    const store = new RailwayLaunchStateStore({ root: input.root, path: resolve(launches, entry.name, "state.json"), validate: input.validate });
    const state = await store.read();
    if (state !== undefined) {
      if (input.identity(state) !== entry.name) throw new Error("Railway state discovery failed");
      result.push({ launchId: entry.name, state });
    }
  }
  return result;
}
