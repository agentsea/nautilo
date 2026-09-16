/**
 * Boot-safe Working Folder resolution.
 *
 * This module deliberately has no Electron dependency. Electron main injects
 * the small synchronous filesystem boundary so the first-start invariant can
 * be proven without loading an Electron runtime in unit tests.
 */

export type WorkingFolderBootstrapResult =
  | {
      readonly ok: true;
      readonly path: string;
      readonly source: "restored" | "defaulted" | "recovered";
    }
  | {
      readonly ok: false;
      readonly reason:
        | "default_folder_rejected"
        | "default_folder_unusable"
        | "persistence_failed";
    };

export interface WorkingFolderFileSystem {
  readFile(path: string): string;
  mkdir(path: string): void;
  stat(path: string): { isDirectory(): boolean };
  access(path: string): void;
  realpath(path: string): string;
  writeFileExclusive(path: string, contents: string): void;
  rename(from: string, to: string): void;
  unlink(path: string): void;
}

export interface WorkingFolderBootstrapOptions {
  readonly stateFilePath: string;
  readonly defaultFolderPath: string;
  readonly homeDirectory: string;
  readonly checkSanity: (
    candidate: string | null | undefined,
    homeDirectory: string,
  ) => { ok: boolean };
  readonly fileSystem: WorkingFolderFileSystem;
  readonly dirname: (filePath: string) => string;
  readonly uniqueTempSuffix: () => string;
}

type StoredFolderState =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "path"; readonly path: string };

function readStoredFolderState(
  stateFilePath: string,
  fileSystem: WorkingFolderFileSystem,
): StoredFolderState {
  try {
    const parsed = JSON.parse(fileSystem.readFile(stateFilePath)) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as { path?: unknown }).path === "string" &&
      (parsed as { path: string }).path.trim().length > 0
    ) {
      return { kind: "path", path: (parsed as { path: string }).path };
    }
    return { kind: "invalid" };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "missing" }
      : { kind: "invalid" };
  }
}

export type WorkingFolderUsability =
  | { readonly ok: true; readonly canonicalPath: string }
  | { readonly ok: false };

/**
 * Check the candidate and its canonical target. The latter matters because a
 * harmless-looking symlink or traversal spelling may resolve to a protected
 * root after the initial stat/access succeeds.
 */
export function validateUsableWorkingFolder(
  candidate: string,
  options: WorkingFolderBootstrapOptions,
): WorkingFolderUsability {
  if (!options.checkSanity(candidate, options.homeDirectory).ok) {
    return { ok: false };
  }
  try {
    if (!options.fileSystem.stat(candidate).isDirectory()) return { ok: false };
    options.fileSystem.access(candidate);
    const canonicalPath = options.fileSystem.realpath(candidate);
    if (!options.checkSanity(canonicalPath, options.homeDirectory).ok) {
      return { ok: false };
    }
    return { ok: true, canonicalPath };
  } catch {
    return { ok: false };
  }
}

/**
 * Durably write `{ path }` through a newly-created temp file in the state
 * file's own directory. A failed write or rename leaves the prior state file
 * untouched; cleanup is limited to this call's uniquely-owned temp path.
 */
export function persistWorkingFolderPathAtomically(
  path: string,
  options: Pick<
    WorkingFolderBootstrapOptions,
    "stateFilePath" | "fileSystem" | "dirname" | "uniqueTempSuffix"
  >,
): void {
  let tempPath: string | null = null;
  try {
    options.fileSystem.mkdir(options.dirname(options.stateFilePath));
    tempPath = `${options.stateFilePath}.${options.uniqueTempSuffix()}.tmp`;
    options.fileSystem.writeFileExclusive(
      tempPath,
      `${JSON.stringify({ path })}\n`,
    );
    options.fileSystem.rename(tempPath, options.stateFilePath);
  } catch {
    if (tempPath !== null) {
      try {
        options.fileSystem.unlink(tempPath);
      } catch {
        // The cleanup target is owned by this invocation; an interrupted
        // cleanup never changes the prior persisted selection.
      }
    }
    throw new Error("Could not persist Working Folder state.");
  }
}

/**
 * Restore an actually usable selected folder, otherwise provision and commit
 * the safe default before any consumer observes current-folder state.
 */
export function resolveWorkingFolderBootstrap(
  options: WorkingFolderBootstrapOptions,
): WorkingFolderBootstrapResult {
  const stored = readStoredFolderState(options.stateFilePath, options.fileSystem);
  if (
    stored.kind === "path" &&
    validateUsableWorkingFolder(stored.path, options).ok
  ) {
    return { ok: true, path: stored.path, source: "restored" };
  }

  if (!options.checkSanity(options.defaultFolderPath, options.homeDirectory).ok) {
    return { ok: false, reason: "default_folder_rejected" };
  }

  try {
    options.fileSystem.mkdir(options.defaultFolderPath);
  } catch {
    return { ok: false, reason: "default_folder_unusable" };
  }
  if (!validateUsableWorkingFolder(options.defaultFolderPath, options).ok) {
    return { ok: false, reason: "default_folder_unusable" };
  }
  try {
    persistWorkingFolderPathAtomically(options.defaultFolderPath, options);
  } catch {
    return { ok: false, reason: "persistence_failed" };
  }
  return {
    ok: true,
    path: options.defaultFolderPath,
    source: stored.kind === "missing" ? "defaulted" : "recovered",
  };
}
