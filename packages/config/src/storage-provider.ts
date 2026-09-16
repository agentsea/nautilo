/**
 * Zone-scoped filesystem abstraction for the Nautilo agent.
 *
 * Every file the agent reads or writes goes through a `StorageProvider`
 * instance that is bound to a single zone root (`home/`, `scratch/`,
 * etc.) and refuses to resolve any path that escapes it. This is how
 * D049 closes the historical path-traversal vector in filesystem tools
 * and how later issues plug in encryption at rest, cloud storage, and
 * per-user namespacing without touching tool code.
 *
 * Design rules:
 *
 * 1. Paths are ALWAYS relative to the zone root. Callers never pass
 *    absolute paths and never pass paths that traverse (`..`).
 *    Violations throw `StoragePathTraversalError` — never silently
 *    accepted.
 *
 * 2. Each zone gets its own provider instance. A provider with
 *    `rootPath = /a/b/home` cannot read a file under `/a/b/scratch`
 *    even if the caller crafts a traversal. Structural isolation, not
 *    policy.
 *
 * 3. The interface is designed to be WRAPPED. An
 *    `EncryptedStorageProvider` composes an inner provider and
 *    transparently encrypts on `write` / decrypts on `read`. A
 *    `NamespacedStorageProvider` (the planned multi-user lane, Step 1)
 *    adds a `{namespace}/` segment between the zone root and the
 *    relative path. Neither wrapper changes the interface contract.
 *
 * 4. The `namespace?` constructor parameter is recorded but UNUSED in
 *    `LocalStorageProvider` (Phase 0 — one human, one agent). When
 *    multi-user arrives it identifies which per-user/per-agent subtree
 *    this provider scopes to. The interface stays stable across that
 *    change.
 */

/**
 * Canonical zone names. Kept as a union so consumers can't invent new
 * ones.
 *
 * - `home`, `scratch`, `data`, `vault` — server-side D049 zones under
 *   `~/.nautilo/`.
 * - `workspace` — RELAY-side zone for the user-selected workspace path
 *   (D057). Separate from `home/workspace/` on the server today; D057
 *   Phase 2a.1 unifies them when the filesystem panel ships.
 *
 * No `inbox` — the pre-pivot zone was removed. ISSUE-D068 will
 * reintroduce an ingestion zone when async adapters ship.
 */
export type StorageZoneName =
  | "home"
  | "scratch"
  | "data"
  | "vault"
  | "workspace";

/** File metadata returned by `StorageProvider.stat`. Deliberately
 *  narrower than `fs.Stats` so backends that aren't a local filesystem
 *  (future S3/GCS providers) can satisfy it cheaply. */
export interface StorageFileStat {
  size: number;
  mtime: Date;
  isDirectory: boolean;
}

export interface StorageProvider {
  /** Canonical zone name. */
  readonly zone: StorageZoneName;

  /** Absolute path of the zone root on disk (or the bucket prefix for
   *  object storage). Useful for diagnostics and logs — callers should
   *  never `path.join(rootPath, ...)` directly; that bypasses
   *  traversal rejection. */
  readonly rootPath: string;

  /** Namespace scope. Unused in `LocalStorageProvider` (Phase 0).
   *  Reserved for Step 1/2 of the D049 evolution path. Allowed to be
   *  `undefined` explicitly so wrappers can carry the parameter
   *  unchanged under `exactOptionalPropertyTypes`. */
  readonly namespace: string | undefined;

  read(relativePath: string): Promise<Uint8Array>;
  readText(relativePath: string): Promise<string>;
  write(relativePath: string, data: Uint8Array | string): Promise<void>;
  append(relativePath: string, data: Uint8Array | string): Promise<void>;
  list(relativeDir: string): Promise<string[]>;
  exists(relativePath: string): Promise<boolean>;
  stat(relativePath: string): Promise<StorageFileStat | null>;
  delete(relativePath: string): Promise<void>;
  mkdir(relativeDir: string): Promise<void>;
}

/**
 * Bundle of per-zone providers handed to the server and agent at boot.
 *
 * Four zones post-pivot (no inbox). Relay adapters (v8 §9.1 key
 * isolation) receive a SUBSET of this — never `data` or `vault`. The
 * factory exposes that subset explicitly (`toRelayStorageZones`) so
 * that a mis-wired relay route gets `undefined` at the type level.
 */
export interface StorageZones {
  home: StorageProvider;
  scratch: StorageProvider;
  data: StorageProvider;
  vault: StorageProvider;
}

/** Subset of `StorageZones` safe to hand to a relay (v8 §9.1). */
export interface RelayStorageZones {
  home: StorageProvider;
  scratch: StorageProvider;
}

// ────────────────────────────────────────────────────────────────────
// Error taxonomy
// ────────────────────────────────────────────────────────────────────
//
// Every error carries the zone name + relative path so operators can
// map a log line back to the offending call site. All extend a common
// `StorageError` so callers can `instanceof StorageError` to gate
// recovery.

export class StorageError extends Error {
  readonly zone: StorageZoneName;
  readonly relativePath: string;

  constructor(
    zone: StorageZoneName,
    relativePath: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`[storage:${zone}] ${message} (path=${relativePath})`, options);
    this.name = "StorageError";
    this.zone = zone;
    this.relativePath = relativePath;
  }
}

/**
 * Thrown when a caller supplies a path that resolves outside the zone
 * root. Covers `..` traversal, absolute paths, null bytes, sibling-
 * prefix attacks, and symlinks that escape after resolution. This is
 * a SECURITY signal — treat it as if a prompt-injected tool call just
 * tried to read `/etc/passwd`.
 */
export class StoragePathTraversalError extends StorageError {
  constructor(zone: StorageZoneName, relativePath: string, reason: string) {
    super(zone, relativePath, `path traversal rejected: ${reason}`);
    this.name = "StoragePathTraversalError";
  }
}

export class StorageNotFoundError extends StorageError {
  constructor(zone: StorageZoneName, relativePath: string) {
    super(zone, relativePath, "file not found");
    this.name = "StorageNotFoundError";
  }
}

export class StoragePermissionError extends StorageError {
  constructor(zone: StorageZoneName, relativePath: string, cause?: unknown) {
    super(zone, relativePath, "permission denied", { cause });
    this.name = "StoragePermissionError";
  }
}
