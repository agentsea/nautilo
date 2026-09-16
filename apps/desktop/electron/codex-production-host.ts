import { randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { AppServerClientFactory, HostClock, HostTimer } from "@nautilo/codex-app-server-host/internal";
import { NodeCodexAppServerClientFactory } from "@nautilo/codex-app-server-host/node";
import {
  ElectronCodexHost,
  createElectronCodexHostServiceFactory,
  type ElectronCodexClientCallbackBuilderInput,
  type ElectronCodexHostOptions,
} from "./codex-host.ts";
import { ElectronCodexController } from "./codex-controller.ts";
import {
  createCodexRuntimeControllerAdapter,
  createCodexRuntimeManager,
  createNodeCodexRuntimeHost,
  createNodeManagedRuntimeHost,
} from "./codex-runtime/index.ts";
import { createCodexRuntimeProviderForSupervisor } from "./codex-runtime/facade.ts";
import type { ManagedElectronCodexHost } from "./codex-connection.ts";
import { CODEX_REVIEWED_RUNTIME_ARTIFACT_REF } from "@nautilo/relay";
import { ElectronCodexTurnTerminalTracker } from "./codex-turn-terminal.ts";

/** Immutable, Electron-main-only paths. None are ever sent to the relay. */
export interface ElectronCodexProductionPaths {
  readonly codexHostDirPath: string;
  readonly codexRuntimeDirPath: string;
  readonly codexProfileHomesDirPath: string;
  readonly codexHostStateDirPath: string;
}

export interface ElectronCodexProductionHostOptions {
  /** Resolved from the active Electron server session, never from the renderer. */
  readonly actorId: string;
  /** Optional Current Folder used only as the default cwd for new Codex threads. */
  readonly currentFolder: () => Readonly<{ path: string; revision: number }> | null;
  /** Existing Genie Workspace used when a Task does not request a cwd. */
  readonly defaultWorkingDirectory: string;
  readonly paths: ElectronCodexProductionPaths;
  readonly openExternal: (url: string) => Promise<void>;
  readonly now?: () => number;
  readonly timer?: HostTimer;
  readonly currentUid?: () => number;
  readonly environment?: Readonly<Record<string, string>>;
  readonly mintId?: () => string;
  readonly dependencies?: Partial<ElectronCodexProductionHostDependencies>;
}

/**
 * Test seams deliberately wrap constructors, rather than exposing host paths
 * or runtime details through the relay-facing port.
 */
export interface ElectronCodexProductionHostDependencies {
  readonly prepareDirectories: (input: SecureCodexDirectories) => Promise<void>;
  readonly createRuntimeHost: typeof createNodeCodexRuntimeHost;
  readonly createManagedRuntimeHost: typeof createNodeManagedRuntimeHost;
  readonly createRuntimeManager: typeof createCodexRuntimeManager;
  readonly createRuntimeControllerAdapter: typeof createCodexRuntimeControllerAdapter;
  readonly createRuntimeProvider: typeof createCodexRuntimeProviderForSupervisor;
  readonly createController: (options: ConstructorParameters<typeof ElectronCodexController>[0]) => ElectronCodexController;
  readonly createClients: (
    callbacks: ElectronCodexClientCallbackBuilderInput,
    options: Readonly<{ experimentalApi: true }>,
  ) => AppServerClientFactory;
  readonly createServices: typeof createElectronCodexHostServiceFactory;
  readonly createHost: (options: ElectronCodexHostOptions) => ManagedElectronCodexHost;
  readonly randomBytes: (size: number) => Uint8Array;
}

export interface SecureCodexDirectories extends ElectronCodexProductionPaths {
  readonly currentUid: number;
}

const nodeTimer: HostTimer = {
  setTimeout(callback, delayMs) {
    return setTimeout(callback, delayMs) as unknown as ReturnType<HostTimer["setTimeout"]>;
  },
  clearTimeout(handle) { clearTimeout(handle as unknown as ReturnType<typeof setTimeout>); },
};

/**
 * Builds a lazy Relay host factory. Calling this function only captures
 * immutable authority; it neither probes nor starts Codex. Directory creation
 * and all runtime/controller construction occur when the returned factory is
 * invoked by an explicit connection enable.
 */
export function createElectronCodexProductionHostFactory(
  options: ElectronCodexProductionHostOptions,
): () => Promise<ManagedElectronCodexHost> {
  const paths = Object.freeze({ ...options.paths });
  const actorId = options.actorId;
  const currentFolder = options.currentFolder;
  const defaultWorkingDirectory = options.defaultWorkingDirectory;
  const now = options.now ?? (() => Date.now());
  const timer = options.timer ?? nodeTimer;
  const currentUid = options.currentUid ?? (() => process.getuid?.() ?? -1);
  const mintId = options.mintId ?? randomUUID;
  const environment = Object.freeze(Object.fromEntries(
    Object.entries(options.environment ?? process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  ));
  const dependencies: ElectronCodexProductionHostDependencies = {
    prepareDirectories: prepareSecureCodexDirectories,
    createRuntimeHost: createNodeCodexRuntimeHost,
    createManagedRuntimeHost: createNodeManagedRuntimeHost,
    createRuntimeManager: createCodexRuntimeManager,
    createRuntimeControllerAdapter: createCodexRuntimeControllerAdapter,
    createRuntimeProvider: createCodexRuntimeProviderForSupervisor,
    createController: (controllerOptions) => new ElectronCodexController(controllerOptions),
    createClients: (callbacks, clientOptions) => new NodeCodexAppServerClientFactory({
      ...clientOptions,
      callbacks: {
        isCurrent: callbacks.isCurrent,
        onTransportFault: ({ child }) => callbacks.onClientFault(child),
        onCallbackFault: ({ child }) => callbacks.onClientFault(child),
        onNotification: ({ child, notification }) =>
          callbacks.onNotification(child, notification),
        onServerRequest: ({ child, method, params, context }) =>
          callbacks.onServerRequest(child, method, params, context),
      },
    }),
    createServices: createElectronCodexHostServiceFactory,
    createHost: (hostOptions) => new ElectronCodexHost(hostOptions),
    randomBytes,
    ...options.dependencies,
  };

  return async () => {
    const uid = currentUid();
    await dependencies.prepareDirectories({ ...paths, currentUid: uid });

    // Construction is inert. The manager only probes/acquires/installs after
    // an authenticated admin command; it is intentionally one shared ledger.
    const manager = dependencies.createRuntimeManager(
      dependencies.createRuntimeHost(environment),
      dependencies.createManagedRuntimeHost(paths.codexRuntimeDirPath),
    );
    const hostRef: { current?: ManagedElectronCodexHost } = {};
    const controller = dependencies.createController({
      runtime: dependencies.createRuntimeControllerAdapter(manager),
      artifactAuthority: { artifactRef: CODEX_REVIEWED_RUNTIME_ARTIFACT_REF },
      openExternal: options.openExternal,
      now,
      mintId,
      timer: {
        setTimeout: (callback, delayMs) => timer.setTimeout(callback, delayMs),
        clearTimeout: (handle) => timer.clearTimeout(handle as never),
      },
      // Runtime manager callbacks are already coalesced. This is only a
      // best-effort nudge to publish the controller's current fenced ledger.
      onStatusChange: () => hostRef.current?.refreshStatus?.(),
    });
    const runtimes = dependencies.createRuntimeProvider(manager, controller);
    const hmacKey = dependencies.randomBytes(32);
    if (hmacKey.byteLength !== 32) throw new Error("Codex workspace HMAC must be 32 bytes");
    const services = dependencies.createServices({
      actorId: () => actorId,
      currentFolder,
      defaultWorkingDirectory,
      profileHomesRoot: paths.codexProfileHomesDirPath,
      profileHomesTrustedParent: paths.codexHostDirPath,
      bindingStateFile: join(paths.codexHostStateDirPath, "bindings.json"),
      hmacKey,
      clock: { now } satisfies HostClock,
      timer,
      runtimes,
      createClients: (callbacks) => dependencies.createClients(
        callbacks,
        Object.freeze({ experimentalApi: true }),
      ),
      // Each relay service session gets an Electron-local exact terminal
      // receipt tracker. The supervisor retains interruption/process ownership.
      createTurnTerminal: () => new ElectronCodexTurnTerminalTracker(timer),
      currentUid: () => uid,
      environment,
      controllerInstance: controller,
      onFault: async (fault) => {
        if (await controller.onSupervisorFault(fault)) hostRef.current?.refreshStatus?.();
      },
    });
    const host = dependencies.createHost({
      currentActorId: () => actorId,
      createServices: services,
      status: () => controller.status(),
    });
    hostRef.current = host;
    return host;
  };
}

/**
 * Creates only known direct children below a pre-existing private parent.
 * No recursive mkdir crosses an untrusted component; every directory is
 * canonicalized and checked after creation before it becomes host authority.
 */
export async function prepareSecureCodexDirectories(input: SecureCodexDirectories): Promise<void> {
  const parent = dirname(input.codexHostDirPath);
  const canonicalParent = await assertPrivateDirectory(parent, input.currentUid, false);
  if (resolve(parent) !== resolve(input.codexHostDirPath, "..")) throw new Error("codex_host_parent_mismatch");
  const root = await ensureDirectPrivateChild(canonicalParent, input.codexHostDirPath, input.currentUid);
  for (const child of [input.codexRuntimeDirPath, input.codexProfileHomesDirPath, input.codexHostStateDirPath]) {
    if (dirname(child) !== input.codexHostDirPath) throw new Error("codex_host_child_mismatch");
    await ensureDirectPrivateChild(root, child, input.currentUid);
  }
}

async function assertPrivateDirectory(path: string, uid: number, allowRepair: boolean): Promise<string> {
  let info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (uid >= 0 && info.uid !== uid)) throw new Error("unsafe_codex_host_directory");
  if ((info.mode & 0o077) !== 0) {
    if (!allowRepair) throw new Error("insecure_codex_host_parent");
    await chmod(path, 0o700);
    info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || (uid >= 0 && info.uid !== uid)) throw new Error("unsafe_codex_host_directory");
  }
  // `lstat` above rejects a leaf symlink. macOS may canonicalize a trusted
  // volume prefix (for example /var -> /private/var), so compare descendants
  // only after canonicalizing both sides rather than rejecting that alias.
  return realpath(path);
}

async function ensureDirectPrivateChild(parent: string, child: string, uid: number): Promise<string> {
  if (await realpath(dirname(child)) !== parent) throw new Error("codex_host_child_mismatch");
  try { await mkdir(child, { recursive: false, mode: 0o700 }); }
  catch (error) {
    if (!(error && typeof error === "object" && (error as { code?: string }).code === "EEXIST")) throw error;
  }
  const canonical = await assertPrivateDirectory(child, uid, true);
  if (dirname(canonical) !== parent) throw new Error("unsafe_codex_host_directory");
  return canonical;
}
