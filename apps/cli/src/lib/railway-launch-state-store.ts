import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { ensurePrivateDirectory, isPrivateFilesystemPathAsync, publishPrivateFileAtomically } from "@nautilo/config/private-filesystem";

const MAX_CHECKPOINT_BYTES = 1024 * 1024;

function missing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function within(root: string, path: string): boolean {
  const canonicalRoot = resolve(root);
  const canonicalPath = resolve(path);
  const descendant = relative(canonicalRoot, canonicalPath);
  return descendant !== "" && descendant !== ".." && !descendant.startsWith(`..${sep}`) && !isAbsolute(descendant);
}

async function ensureDirectory(root: string, directory: string): Promise<void> {
  if (!within(root, directory) && relative(resolve(root), resolve(directory)) !== "") throw new Error("Unsafe Railway state path");
  await assertDirectoryChain(root, directory, true);
  try { await lstat(directory); }
  catch (error) {
    if (!missing(error)) throw error;
    await ensurePrivateDirectory(directory);
  }
  await assertDirectoryChain(root, directory, false);
  const status = await lstat(directory);
  if (status.isSymbolicLink() || !status.isDirectory()
    || !await isPrivateFilesystemPathAsync(directory)) {
    throw new Error("Unsafe Railway state path");
  }
}

async function assertDirectoryChain(root: string, directory: string, allowMissing: boolean): Promise<void> {
  const boundary = resolve(root);
  let current = resolve(directory);
  if (!within(boundary, current) && relative(boundary, current) !== "") throw new Error("Unsafe Railway state path");
  for (;;) {
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("Unsafe Railway state path");
    } catch (error) {
      if (!allowMissing || !missing(error)) throw new Error("Unsafe Railway state path");
    }
    if (relative(boundary, current) === "") return;
    const parent = dirname(current);
    if (parent === current) throw new Error("Unsafe Railway state path");
    current = parent;
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
      status = await lstat(this.#path, { bigint: true });
    } catch (error) {
      if (missing(error)) return undefined;
      throw new Error("Railway state read failed");
    }
    await assertDirectoryChain(this.#root, dirname(this.#path), false);
    if (status.isSymbolicLink() || !status.isFile() || status.size > MAX_CHECKPOINT_BYTES
      || !await isPrivateFilesystemPathAsync(this.#path)) {
      throw new Error("Unsafe Railway state path");
    }
    const flags = process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
    const handle = await open(this.#path, flags);
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.dev !== status.dev || opened.ino !== status.ino) throw new Error("Railway state read failed");
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
    try {
      await publishPrivateFileAtomically(this.#path, Buffer.from(body, "utf8"));
    } catch {
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
    await assertDirectoryChain(input.root, launches, false);
    if (status.isSymbolicLink() || !status.isDirectory()
      || !await isPrivateFilesystemPathAsync(launches)) throw new Error("Railway state discovery failed");
    entries = await readdir(launches, { withFileTypes: true });
  } catch (error) {
    if (missing(error)) return [];
    throw new Error("Railway state discovery failed");
  }
  if (entries.length > 1024) throw new Error("Railway state discovery failed");
  const result: { launchId: string; state: T }[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !SAFE_LAUNCH_DIRECTORY.test(entry.name)) throw new Error("Railway state discovery failed");
    const directoryPath = resolve(launches, entry.name);
    const directory = await lstat(directoryPath);
    if (directory.isSymbolicLink() || !directory.isDirectory()
      || !await isPrivateFilesystemPathAsync(directoryPath)) throw new Error("Railway state discovery failed");
    const store = new RailwayLaunchStateStore({ root: input.root, path: resolve(launches, entry.name, "state.json"), validate: input.validate });
    const state = await store.read();
    if (state !== undefined) {
      if (input.identity(state) !== entry.name) throw new Error("Railway state discovery failed");
      result.push({ launchId: entry.name, state });
    }
  }
  return result;
}
