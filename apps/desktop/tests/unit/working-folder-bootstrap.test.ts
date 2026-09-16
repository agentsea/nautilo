import { describe, expect, test } from "bun:test";
import {
  persistWorkingFolderPathAtomically,
  resolveWorkingFolderBootstrap,
  type WorkingFolderBootstrapOptions,
} from "../../electron/working-folder-bootstrap";

const STATE_FILE = "/state/current-folder.json";
const DEFAULT_FOLDER = "/home/human/Documents/Nautilo";
const SAVED_FOLDER = "/home/human/projects/kept";

type Entry =
  | { readonly kind: "directory" }
  | { readonly kind: "file"; readonly contents: string };

function enoent(): NodeJS.ErrnoException {
  return Object.assign(new Error("missing"), { code: "ENOENT" });
}

class MemoryFileSystem {
  readonly entries = new Map<string, Entry>();
  readonly calls: string[] = [];
  readonly inaccessible = new Set<string>();
  readonly failedMkdirs = new Set<string>();
  readonly realpaths = new Map<string, string>();
  failWrite = false;
  failRename = false;

  readFile = (filePath: string): string => {
    this.calls.push(`read:${filePath}`);
    const entry = this.entries.get(filePath);
    if (!entry) throw enoent();
    if (entry.kind !== "file") throw new Error("is a directory");
    return entry.contents;
  };

  mkdir = (directory: string): void => {
    this.calls.push(`mkdir:${directory}`);
    if (this.failedMkdirs.has(directory)) throw new Error("mkdir failed");
    const existing = this.entries.get(directory);
    if (existing?.kind === "file") throw new Error("file exists");
    this.entries.set(directory, { kind: "directory" });
  };

  stat = (target: string): { isDirectory(): boolean } => {
    this.calls.push(`stat:${target}`);
    const entry = this.entries.get(target);
    if (!entry) throw enoent();
    return { isDirectory: () => entry.kind === "directory" };
  };

  access = (target: string): void => {
    this.calls.push(`access:${target}`);
    if (this.inaccessible.has(target)) throw new Error("access denied");
    if (!this.entries.has(target)) throw enoent();
  };

  realpath = (target: string): string => {
    this.calls.push(`realpath:${target}`);
    if (!this.entries.has(target)) throw enoent();
    return this.realpaths.get(target) ?? target;
  };

  writeFileExclusive = (filePath: string, contents: string): void => {
    this.calls.push(`write:${filePath}`);
    if (this.failWrite || this.entries.has(filePath)) throw new Error("write failed");
    this.entries.set(filePath, { kind: "file", contents });
  };

  rename = (from: string, to: string): void => {
    this.calls.push(`rename:${from}:${to}`);
    if (this.failRename) throw new Error("rename failed");
    const entry = this.entries.get(from);
    if (!entry) throw enoent();
    this.entries.set(to, entry);
    this.entries.delete(from);
  };

  unlink = (filePath: string): void => {
    this.calls.push(`unlink:${filePath}`);
    if (!this.entries.delete(filePath)) throw enoent();
  };
}

function options(fileSystem = new MemoryFileSystem()): {
  readonly fileSystem: MemoryFileSystem;
  readonly options: WorkingFolderBootstrapOptions;
} {
  return {
    fileSystem,
    options: {
      stateFilePath: STATE_FILE,
      defaultFolderPath: DEFAULT_FOLDER,
      homeDirectory: "/home/human",
      checkSanity: (candidate) => ({
        ok: typeof candidate === "string" && candidate.startsWith("/home/human/"),
      }),
      fileSystem,
      dirname: () => "/state",
      uniqueTempSuffix: () => "owned-temp",
    },
  };
}

function save(fileSystem: MemoryFileSystem, path: string): void {
  fileSystem.entries.set(STATE_FILE, {
    kind: "file",
    contents: JSON.stringify({ path }),
  });
}

describe("Working Folder bootstrap", () => {
  test("restores a valid, readable and writable human selection without rewriting it", () => {
    const { fileSystem, options: bootstrap } = options();
    fileSystem.entries.set(SAVED_FOLDER, { kind: "directory" });
    save(fileSystem, SAVED_FOLDER);

    expect(resolveWorkingFolderBootstrap(bootstrap)).toEqual({
      ok: true,
      path: SAVED_FOLDER,
      source: "restored",
    });
    expect(fileSystem.calls.some((call) => call.startsWith("write:"))).toBe(false);
  });

  test("creates and persists the safe default on first start", () => {
    const { fileSystem, options: bootstrap } = options();

    expect(resolveWorkingFolderBootstrap(bootstrap)).toEqual({
      ok: true,
      path: DEFAULT_FOLDER,
      source: "defaulted",
    });
    expect(fileSystem.entries.get(DEFAULT_FOLDER)).toEqual({ kind: "directory" });
    expect(fileSystem.entries.get(STATE_FILE)).toEqual({
      kind: "file",
      contents: `${JSON.stringify({ path: DEFAULT_FOLDER })}\n`,
    });
  });

  test.each([
    ["malformed", () => "not json"],
    ["deleted", () => JSON.stringify({ path: SAVED_FOLDER })],
    ["file", () => JSON.stringify({ path: SAVED_FOLDER })],
    ["inaccessible", () => JSON.stringify({ path: SAVED_FOLDER })],
  ])("recovers a %s saved state to the safe default", (kind, contents) => {
    const { fileSystem, options: bootstrap } = options();
    fileSystem.entries.set(STATE_FILE, { kind: "file", contents: contents() });
    if (kind === "file") {
      fileSystem.entries.set(SAVED_FOLDER, { kind: "file", contents: "nope" });
    }
    if (kind === "inaccessible") {
      fileSystem.entries.set(SAVED_FOLDER, { kind: "directory" });
      fileSystem.inaccessible.add(SAVED_FOLDER);
    }

    expect(resolveWorkingFolderBootstrap(bootstrap)).toEqual({
      ok: true,
      path: DEFAULT_FOLDER,
      source: "recovered",
    });
  });

  test("rejects a saved path that fails folder sanity and recovers", () => {
    const { fileSystem, options: bootstrap } = options();
    fileSystem.entries.set("/tmp", { kind: "directory" });
    save(fileSystem, "/tmp");

    expect(resolveWorkingFolderBootstrap(bootstrap)).toEqual({
      ok: true,
      path: DEFAULT_FOLDER,
      source: "recovered",
    });
  });

  test("recovers saved traversal and symlink spellings whose canonical target is unsafe", () => {
    const traversal = "/home/human/projects/kept/../../../tmp";
    const traversalState = options();
    traversalState.fileSystem.entries.set(traversal, { kind: "directory" });
    traversalState.fileSystem.realpaths.set(traversal, "/tmp");
    save(traversalState.fileSystem, traversal);

    expect(resolveWorkingFolderBootstrap(traversalState.options)).toEqual({
      ok: true,
      path: DEFAULT_FOLDER,
      source: "recovered",
    });

    const symlinkState = options();
    symlinkState.fileSystem.entries.set(SAVED_FOLDER, { kind: "directory" });
    symlinkState.fileSystem.realpaths.set(SAVED_FOLDER, "/tmp");
    save(symlinkState.fileSystem, SAVED_FOLDER);

    expect(resolveWorkingFolderBootstrap(symlinkState.options)).toEqual({
      ok: true,
      path: DEFAULT_FOLDER,
      source: "recovered",
    });
  });

  test("does not persist the textual default when it resolves through an unsafe symlink", () => {
    const { fileSystem, options: bootstrap } = options();
    fileSystem.realpaths.set(DEFAULT_FOLDER, "/tmp");

    expect(resolveWorkingFolderBootstrap(bootstrap)).toEqual({
      ok: false,
      reason: "default_folder_unusable",
    });
  });

  test("reports a create or access failure instead of claiming a usable default", () => {
    const create = options();
    create.fileSystem.failedMkdirs.add(DEFAULT_FOLDER);
    expect(resolveWorkingFolderBootstrap(create.options)).toEqual({
      ok: false,
      reason: "default_folder_unusable",
    });

    const access = options();
    access.fileSystem.inaccessible.add(DEFAULT_FOLDER);
    expect(resolveWorkingFolderBootstrap(access.options)).toEqual({
      ok: false,
      reason: "default_folder_unusable",
    });
  });

  test("does not publish a default when exclusive persistence or rename fails", () => {
    const stateDirectory = options();
    stateDirectory.fileSystem.failedMkdirs.add("/state");
    expect(resolveWorkingFolderBootstrap(stateDirectory.options)).toEqual({
      ok: false,
      reason: "persistence_failed",
    });

    const write = options();
    write.fileSystem.failWrite = true;
    expect(resolveWorkingFolderBootstrap(write.options)).toEqual({
      ok: false,
      reason: "persistence_failed",
    });

    const rename = options();
    rename.fileSystem.failRename = true;
    expect(resolveWorkingFolderBootstrap(rename.options)).toEqual({
      ok: false,
      reason: "persistence_failed",
    });
    expect([...rename.fileSystem.entries.keys()].some((path) => path.endsWith(".tmp"))).toBe(false);
  });

  test("uses an exclusive same-directory temp and rename for a persistence commit", () => {
    const { fileSystem, options: bootstrap } = options();

    expect(() => persistWorkingFolderPathAtomically(SAVED_FOLDER, bootstrap)).not.toThrow();
    expect(fileSystem.calls).toEqual([
      "mkdir:/state",
      `write:${STATE_FILE}.owned-temp.tmp`,
      `rename:${STATE_FILE}.owned-temp.tmp:${STATE_FILE}`,
    ]);
  });
});
