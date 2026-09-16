import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { directBrowserHarnessSession } from "./direct-browser-router";
import type {
  DirectBrowserRouterDirectories,
  DirectBrowserRouterDirectoryAuthority,
} from "./direct-browser-router";

// agent-browser encodes a Unix socket pathname in a 108-byte sockaddr_un and
// reserves five bytes for its terminator/transport bookkeeping. Keep this in
// lockstep with direct-browser-harness's final pre-spawn validation.
const MAX_AGENT_BROWSER_SOCKET_PATH_BYTES = 103;
const OPERATION_DIRECTORY = /^o-[a-f0-9]{24}$/u;
const HARNESS_SESSION = /^[a-z0-9](?:[a-z0-9_-]{0,119})$/iu;
const PRIVATE_DIRECTORY_MODE = 0o700;

export interface ServerDirectBrowserDirectoryAuthorityOptions {
  /**
   * Explicit, stable, short, per-instance root. Its parent must already
   * exist; this authority never consults HOME or recursively crosses it.
   */
  readonly rootDirectory: string;
  /** Durable identity for the instance that owns rootDirectory. */
  readonly instanceIdentity: string;
  /** Test seam. Production defaults to the effective process uid. */
  readonly expectedUid?: number;
}

export class ServerDirectBrowserDirectoryAuthorityError extends Error {
  constructor(readonly code: "invalid_configuration" | "unsafe_directory" | "socket_path_too_long") {
    super("direct browser directory authority unavailable");
    this.name = "ServerDirectBrowserDirectoryAuthorityError";
  }
}

function fail(code: ServerDirectBrowserDirectoryAuthorityError["code"]): never {
  throw new ServerDirectBrowserDirectoryAuthorityError(code);
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null
    && "code" in error && (error as { readonly code?: unknown }).code === code;
}

function validRootDirectory(value: string): boolean {
  return value.length > 0 && !value.includes("\0") && isAbsolute(value)
    && resolve(value) === value && dirname(value) !== value;
}

function validAllocation(input: {
  readonly ownerUserId: string;
  readonly accountId: string;
  readonly operationId: string;
  readonly controlEpoch: number;
  readonly harnessSession: string;
}): boolean {
  return input.ownerUserId.length > 0
    && input.accountId.length > 0
    && input.operationId.length > 0
    && Number.isSafeInteger(input.controlEpoch)
    && input.controlEpoch >= 1
    && HARNESS_SESSION.test(input.harnessSession);
}

function operationDirectoryName(input: {
  readonly rootDirectory: string;
  readonly instanceIdentity: string;
  readonly ownerUserId: string;
  readonly accountId: string;
  readonly operationId: string;
  readonly controlEpoch: number;
  readonly harnessSession: string;
}): string {
  const digest = createHash("sha256")
    // JSON's array framing keeps every identity axis unambiguous while the
    // digest prevents model/provider-controlled identifiers entering a path.
    .update(JSON.stringify([
      "nautilo-direct-browser-directory-v1",
      input.rootDirectory,
      input.instanceIdentity,
      input.ownerUserId,
      input.accountId,
      input.operationId,
      input.controlEpoch,
      input.harnessSession,
    ]))
    .digest("hex")
    .slice(0, 24);
  return `o-${digest}`;
}

async function assertPrivateDirectory(candidate: string, expectedUid: number): Promise<string> {
  const info = await lstat(candidate).catch(() => fail("unsafe_directory"));
  if (!info.isDirectory() || info.isSymbolicLink()
    || (info.mode & 0o777) !== PRIVATE_DIRECTORY_MODE || info.uid !== expectedUid) {
    fail("unsafe_directory");
  }
  const canonical = await realpath(candidate).catch(() => fail("unsafe_directory"));
  if (canonical !== candidate) fail("unsafe_directory");
  return canonical;
}

async function ensurePrivateDirectory(candidate: string, expectedUid: number): Promise<string> {
  let created = false;
  try {
    await mkdir(candidate, { recursive: false, mode: PRIVATE_DIRECTORY_MODE });
    created = true;
  } catch (error) {
    if (!isErrorCode(error, "EEXIST")) throw error;
  }
  // chmod closes over restrictive umasks on a directory created by this uid,
  // but never attempts to repair a pre-existing or replaced directory.
  const initial = await lstat(candidate).catch(() => fail("unsafe_directory"));
  if (!initial.isDirectory() || initial.isSymbolicLink() || initial.uid !== expectedUid) {
    fail("unsafe_directory");
  }
  if ((initial.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    // A freshly-created directory can be stricter than 0700 under an unusual
    // umask. Never broaden or silently repair a pre-existing directory.
    if (!created || (initial.mode & 0o077) !== 0) fail("unsafe_directory");
    await chmod(candidate, PRIVATE_DIRECTORY_MODE);
  }
  return assertPrivateDirectory(candidate, expectedUid);
}

async function ensureDirectPrivateChild(parent: string, child: string, expectedUid: number): Promise<string> {
  if (dirname(child) !== parent) fail("unsafe_directory");
  const canonical = await ensurePrivateDirectory(child, expectedUid);
  if (dirname(canonical) !== parent) fail("unsafe_directory");
  return canonical;
}

function exactOperationRoot(
  ownedRoot: string,
  input: DirectBrowserRouterDirectories,
): string {
  const socketDirectory = input.socketDirectory;
  const homeDirectory = input.homeDirectory;
  if (!validRootDirectory(socketDirectory) || !validRootDirectory(homeDirectory)
    || basename(socketDirectory) !== "s" || basename(homeDirectory) !== "h") {
    fail("unsafe_directory");
  }
  const operationRoot = dirname(socketDirectory);
  if (dirname(homeDirectory) !== operationRoot
    || dirname(operationRoot) !== ownedRoot
    || !OPERATION_DIRECTORY.test(basename(operationRoot))) {
    fail("unsafe_directory");
  }
  return operationRoot;
}

/**
 * Creates the sole server authority for agent-browser socket and HOME paths.
 * Paths are deterministic across process recovery, but carry no raw account,
 * operation, instance, or Human identifier.
 */
export function createServerDirectBrowserDirectoryAuthority(
  options: ServerDirectBrowserDirectoryAuthorityOptions,
): DirectBrowserRouterDirectoryAuthority {
  if (!validRootDirectory(options.rootDirectory) || options.instanceIdentity.length === 0) {
    fail("invalid_configuration");
  }
  const resolvedUid = options.expectedUid ?? process.getuid?.();
  if (resolvedUid === undefined || !Number.isSafeInteger(resolvedUid) || resolvedUid < 0) {
    fail("invalid_configuration");
  }
  const expectedUid = resolvedUid;
  const configuredRoot = options.rootDirectory;

  async function ownedRoot(): Promise<string> {
    return ensurePrivateDirectory(configuredRoot, expectedUid);
  }

  return {
    async allocate(input): Promise<DirectBrowserRouterDirectories> {
      if (!validAllocation(input)) fail("invalid_configuration");
      const rootDirectory = await ownedRoot();
      const operationRoot = join(rootDirectory, operationDirectoryName({
        rootDirectory: configuredRoot,
        instanceIdentity: options.instanceIdentity,
        ...input,
      }));
      const socketDirectory = join(operationRoot, "s");
      const homeDirectory = join(operationRoot, "h");
      const socketPath = join(socketDirectory, `${input.harnessSession}.sock`);
      if (Buffer.byteLength(socketPath, "utf8") > MAX_AGENT_BROWSER_SOCKET_PATH_BYTES) {
        fail("socket_path_too_long");
      }
      const canonicalOperationRoot = await ensureDirectPrivateChild(rootDirectory, operationRoot, expectedUid);
      const canonicalSocketDirectory = await ensureDirectPrivateChild(canonicalOperationRoot, socketDirectory, expectedUid);
      const canonicalHomeDirectory = await ensureDirectPrivateChild(canonicalOperationRoot, homeDirectory, expectedUid);
      return Object.freeze({
        socketDirectory: canonicalSocketDirectory,
        homeDirectory: canonicalHomeDirectory,
      });
    },

    async *forRecovery(input): AsyncIterable<DirectBrowserRouterDirectories> {
      if (!Number.isSafeInteger(input.controlEpoch) || input.controlEpoch < 1) fail("invalid_configuration");
      const rootDirectory = await ownedRoot();
      // Cleanup rotations advance the durable epoch without moving the daemon.
      // Inspect the exact historical identities, never allocate replacement
      // directories or infer ownership from a directory name alone.
      for (let controlEpoch = 1; controlEpoch <= input.controlEpoch; controlEpoch += 1) {
        const harnessSession = directBrowserHarnessSession({ ...input, controlEpoch });
        if (!validAllocation({ ...input, controlEpoch, harnessSession })) fail("invalid_configuration");
        const operationRoot = join(rootDirectory, operationDirectoryName({
          rootDirectory: configuredRoot, instanceIdentity: options.instanceIdentity,
          ...input, controlEpoch, harnessSession,
        }));
        const info = await lstat(operationRoot).catch((error) => {
          if (isErrorCode(error, "ENOENT")) return null;
          throw error;
        });
        if (info === null) continue;
        await assertPrivateDirectory(operationRoot, expectedUid);
        const socketDirectory = await assertPrivateDirectory(join(operationRoot, "s"), expectedUid);
        const homeDirectory = await assertPrivateDirectory(join(operationRoot, "h"), expectedUid);
        yield { socketDirectory, homeDirectory };
      }
    },

    async release(input): Promise<void> {
      const rootDirectory = await ownedRoot();
      const operationRoot = exactOperationRoot(rootDirectory, input);
      const operationInfo = await lstat(operationRoot).catch((error) => {
        if (isErrorCode(error, "ENOENT")) return null;
        throw error;
      });
      // The exact operation root is already gone: release is idempotent.
      if (operationInfo === null) return;
      await assertPrivateDirectory(operationRoot, expectedUid);
      await assertPrivateDirectory(input.socketDirectory, expectedUid);
      await assertPrivateDirectory(input.homeDirectory, expectedUid);
      try {
        await rm(operationRoot, { recursive: true, force: false });
      } catch (error) {
        // A concurrent exact release that already removed the same owned root
        // has the same successful terminal state.
        if (!isErrorCode(error, "ENOENT")) throw error;
      }
      const remaining = await lstat(operationRoot).catch((error) => {
        if (isErrorCode(error, "ENOENT")) return null;
        throw error;
      });
      if (remaining !== null) fail("unsafe_directory");
    },
  };
}
