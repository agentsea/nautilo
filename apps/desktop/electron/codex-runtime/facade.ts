import type {
  CodexRuntimeDetails,
  CodexRuntimeInstallState,
  ResolveExternalCodexRuntimeOptions,
  ResolveManagedCodexRuntimeOptions,
} from "./contracts.ts";
import { createHash, randomUUID } from "node:crypto";
import { CodexManagedRuntimeManager, type ManagedRuntimeHost, type ManagedRuntimeLease } from "./acquisition.ts";
import { ExternalCodexRuntimeManager } from "./external-manager.ts";
import type { CodexRuntimeHost } from "./contracts.ts";
import { REVIEWED_CODEX_RUNTIME_MANIFEST } from "./release-manifest.ts";
import { dirname, join } from "node:path";
import type { RuntimeProvider } from "@nautilo/codex-app-server-host/internal";
import { CODEX_REVIEWED_RUNTIME_ARTIFACT_REF } from "@nautilo/relay";

export interface CodexRuntimeControllerAdapter {
  inspect(input?: { readonly signal?: AbortSignal }): Promise<RuntimeControllerDetails>;
  install(input: {
    readonly artifactRef: string;
    readonly signal: AbortSignal;
    /** Existing manager lifecycle stream; observers cannot influence installation. */
    readonly onState?: (state: CodexRuntimeInstallState) => void;
  }): Promise<RuntimeControllerMutationDetails>;
  revalidateForActivation(handle: string, fingerprint: string): Promise<boolean>;
  activate(handle: string): Promise<RuntimeControllerMutationDetails>;
  rollback(): Promise<RuntimeControllerMutationDetails>;
}

/** Exact opaque generation selection; it exposes no runtime path or source. */
export interface CodexRuntimeGenerationAuthority {
  resolveRuntimeHandleForGeneration(generation: number): string | null;
}

/** Deliberately small DTO shared with the Electron controller; handles are facade-issued. */
export interface RuntimeControllerDetails {
  readonly state: "absent" | "ready" | "incompatible" | "failed";
  readonly fingerprint?: string;
  readonly handle?: string;
  /** Coarse provenance and semver only; paths, URLs, and launch details stay local. */
  readonly source?: "external" | "managed";
  readonly version?: string;
  /** Validated capability projection; no runtime path or launch detail leaks. */
  readonly compatibility?: NonNullable<CodexRuntimeDetails["compatibility"]>;
  readonly features?: NonNullable<CodexRuntimeDetails["features"]>;
  readonly compatibilityDiagnostics?: CodexRuntimeDetails["compatibilityDiagnostics"];
}
export interface RuntimeControllerMutationDetails {
  readonly state: "ready" | "incompatible" | "failed";
  readonly fingerprint?: string;
  readonly handle?: string;
  readonly source?: "external" | "managed";
  readonly version?: string;
  readonly compatibility?: NonNullable<CodexRuntimeDetails["compatibility"]>;
  readonly features?: NonNullable<CodexRuntimeDetails["features"]>;
  readonly compatibilityDiagnostics?: CodexRuntimeDetails["compatibilityDiagnostics"];
}

type RuntimeRoute = {
  readonly source: "external" | "managed";
  readonly handle: string;
  readonly generation: number;
  readonly details: CodexRuntimeDetails;
};
type RuntimeFacadeState = {
  readonly external: ExternalCodexRuntimeManager;
  readonly managed: CodexManagedRuntimeManager;
  readonly handles: Map<string, RuntimeRoute>;
  generation: number;
};

// Keep source managers and their filesystem-capable launch targets entirely
// outside the public manager object's observable shape.
const runtimeFacadeStates = new WeakMap<CodexRuntimeManager, RuntimeFacadeState>();
function stateFor(manager: CodexRuntimeManager): RuntimeFacadeState {
  const state = runtimeFacadeStates.get(manager);
  if (!state) throw new Error("unknown_codex_runtime_manager");
  return state;
}

/**
 * One opaque-handle boundary for all runtime sources.  Source-specific
 * resolution stays here; product callers inspect, acquire and revalidate the
 * returned handle without ever receiving a filesystem path.
 */
export class CodexRuntimeManager {
  constructor(
    external: ExternalCodexRuntimeManager,
    managed: CodexManagedRuntimeManager,
  ) {
    runtimeFacadeStates.set(this, { external, managed, handles: new Map(), generation: 0 });
  }

  async resolveExternal(options?: ResolveExternalCodexRuntimeOptions): Promise<CodexRuntimeDetails> {
    return this.register("external", await stateFor(this).external.resolveExternal(options));
  }
  async installManaged(options?: ResolveManagedCodexRuntimeOptions): Promise<CodexRuntimeDetails> {
    return this.register("managed", await stateFor(this).managed.install(options));
  }
  /** Installs only the reviewed artifact and propagates the caller's exact cancellation signal. */
  async installReviewed(
    artifactRef: string,
    signal: AbortSignal,
    onState?: (state: CodexRuntimeInstallState) => void,
  ): Promise<CodexRuntimeDetails> {
    if (artifactRef !== CODEX_REVIEWED_RUNTIME_ARTIFACT_REF) throw new Error("codex_runtime_artifact_unapproved");
    return this.installManaged({ signal, ...(onState ? { onState } : {}) });
  }
  async resolveActiveManaged(options?: ResolveManagedCodexRuntimeOptions): Promise<CodexRuntimeDetails> {
    return this.register("managed", await stateFor(this).managed.resolveActive(options));
  }
  /** Offline resolution policy. It never installs while looking for a usable runtime. */
  async resolvePreferred(options?: {
    readonly external?: ResolveExternalCodexRuntimeOptions;
    readonly managed?: ResolveManagedCodexRuntimeOptions;
  }): Promise<CodexRuntimeDetails> {
    const external = await this.resolveExternal(options?.external);
    if (isUsableRuntime(external) && external.handle) return external;
    const activeManaged = await this.resolveActiveManaged(options?.managed);
    if (isUsableRuntime(activeManaged) && activeManaged.handle) return activeManaged;
    return [external, activeManaged].find((details) => !isGenuineAbsence(details)) ?? activeManaged;
  }
  /** Rolls back the managed active record and registers its fresh public handle. */
  async rollbackManaged(options?: ResolveManagedCodexRuntimeOptions): Promise<CodexRuntimeDetails | null> {
    const rolledBack = await stateFor(this).managed.rollback(options);
    return rolledBack ? this.register("managed", rolledBack) : null;
  }
  inspect(handle: string): CodexRuntimeDetails | null {
    return stateFor(this).handles.get(handle)?.details ?? null;
  }
  acquire(handle: string): ManagedRuntimeLease | null {
    const state = stateFor(this);
    const route = state.handles.get(handle);
    if (!route) return null;
    if (route.source === "external") return Object.freeze({ generation: route.generation, release() {} });
    // Managed generation is durable active-record identity, not facade
    // registration order. This also preserves it across fresh resolutions.
    return state.managed.acquireLease(route.handle);
  }
  async revalidate(handle: string): Promise<boolean> {
    const state = stateFor(this);
    const route = state.handles.get(handle);
    return route ? route.source === "managed" ? state.managed.revalidate(route.handle) : state.external.revalidate(route.handle) : false;
  }
  /** Require the exact facade handle and runtime fingerprint that was ledgered for activation. */
  async revalidateForActivation(handle: string, fingerprint: string): Promise<boolean> {
    const route = stateFor(this).handles.get(handle);
    return Boolean(route && runtimeFingerprint(route.details) === fingerprint && await this.revalidate(handle));
  }
  private register(source: "external" | "managed", details: CodexRuntimeDetails): CodexRuntimeDetails {
    if (!details.handle) return details;
    const state = stateFor(this);
    let handle: string;
    do { handle = `runtime-${randomUUID()}`; } while (state.handles.has(handle));
    const publicDetails = Object.freeze({ ...details, handle });
    const generation = ++state.generation;
    state.handles.set(handle, { source, handle: details.handle, generation, details: publicDetails });
    return publicDetails;
  }
}

/**
 * Concrete Electron-controller port. It exposes only facade-generated opaque
 * handles and verified fingerprints; source-manager paths remain unobservable.
 */
export function createCodexRuntimeControllerAdapter(manager: CodexRuntimeManager): CodexRuntimeControllerAdapter {
  return Object.freeze({
    async inspect(input: { readonly signal?: AbortSignal } = {}) {
      // A controller lifecycle fence must reach every offline source probe:
      // external discovery and active managed verification.
      // resolvePreferred never installs, so one signal is sufficient here.
      const details = !input.signal
        ? await manager.resolvePreferred()
        : await manager.resolvePreferred({
          external: { signal: input.signal },
          managed: { signal: input.signal },
        });
      return controllerDetails(details);
    },
    async install({ artifactRef, signal, onState }: {
      readonly artifactRef: string;
      readonly signal: AbortSignal;
      readonly onState?: (state: CodexRuntimeInstallState) => void;
    }) {
      return mutationControllerDetails(await manager.installReviewed(artifactRef, signal, onState));
    },
    async revalidateForActivation(handle: string, fingerprint: string) { return manager.revalidateForActivation(handle, fingerprint); },
    activate(handle: string) { return Promise.resolve(mutationControllerDetails(manager.inspect(handle))); },
    async rollback() { return mutationControllerDetails(await manager.rollbackManaged()); },
  });
}

/** Internal supervisor seam; deliberately omitted from the public barrel. */
export function resolveCodexRuntimeLaunchSpecForSupervisor(
  manager: CodexRuntimeManager,
  handle: string,
): Readonly<{ command: string; argv: readonly string[]; pathEntries: readonly string[] }> | null {
  const state = stateFor(manager);
  const route = state.handles.get(handle);
  if (!route) return null;
  const command = route.source === "managed"
    ? state.managed.internalLaunchTarget(route.handle)
    : state.external.internalLaunchTarget(route.handle);
  if (!command) return null;
  return Object.freeze({
    command,
    argv: Object.freeze(route.source === "external" ? ["app-server", "--listen", "stdio://"] : ["--listen", "stdio://"]),
    // The managed package's reviewed companion binaries live beside `bin/`.
    // Keep this launch-only and out of CodexRuntimeDetails/public barrels.
    pathEntries: Object.freeze(route.source === "managed"
      ? [join(dirname(dirname(command)), "codex-path")]
      : []),
  });
}

/**
 * Internal host adapter. Product code selects an opaque handle for each
 * generation; only the supervisor receives the verified launch path.
 */
export function createCodexRuntimeProviderForSupervisor(
  manager: CodexRuntimeManager,
  authority: CodexRuntimeGenerationAuthority,
): RuntimeProvider {
  return {
    async acquire(generation) {
      const handle = authority.resolveRuntimeHandleForGeneration(generation);
      if (!handle) throw new Error("codex_runtime_generation_unavailable");
      const lease = manager.acquire(handle);
      if (!lease) throw new Error("codex_runtime_generation_unavailable");
      try {
        if (!(await manager.revalidate(handle))) throw new Error("codex_runtime_generation_unavailable");
        const launch = resolveCodexRuntimeLaunchSpecForSupervisor(manager, handle);
        if (!launch) throw new Error("codex_runtime_generation_unavailable");
        return {
          launch: {
            executablePath: launch.command,
            args: launch.argv,
            pathEntries: launch.pathEntries,
            runtimeGeneration: generation,
          },
          lease: { release: () => { lease.release(); return Promise.resolve(); } },
        };
      } catch (error) {
        lease.release();
        throw error;
      }
    },
  };
}

/** Public construction boundary; callers cannot construct source managers directly. */
export function createCodexRuntimeManager(
  externalHost: CodexRuntimeHost,
  managedHost: ManagedRuntimeHost,
): CodexRuntimeManager {
  return new CodexRuntimeManager(
    new ExternalCodexRuntimeManager(externalHost),
    new CodexManagedRuntimeManager(managedHost, REVIEWED_CODEX_RUNTIME_MANIFEST as NonNullable<typeof REVIEWED_CODEX_RUNTIME_MANIFEST>),
  );
}

function runtimeFingerprint(details: CodexRuntimeDetails): string | undefined {
  if (!details.executableFingerprint && !details.launcherFingerprint) return undefined;
  const identity = JSON.stringify({
    source: details.source ?? null,
    kind: details.kind ?? null,
    version: details.version ?? null,
    executable: details.executableFingerprint ?? null,
    launcher: details.launcherFingerprint ?? null,
    schema: details.schemaFingerprint ?? null,
    stableSchema: details.stableSchemaFingerprint ?? null,
  });
  return `runtime-id-${createHash("sha256").update(identity).digest("base64url")}`;
}

function isUsableRuntime(details: CodexRuntimeDetails): boolean {
  return details.state === "ready" || details.state === "limited";
}

function isGenuineAbsence(details: CodexRuntimeDetails): boolean {
  return details.state === "unavailable" && details.code === "CODEX_RUNTIME_NOT_FOUND";
}

function controllerDetails(details: CodexRuntimeDetails | null): RuntimeControllerDetails {
  if (!details) return Object.freeze({ state: "failed" });
  const fingerprint = runtimeFingerprint(details);
  if (isUsableRuntime(details) && (!fingerprint || !details.handle)) return Object.freeze({ state: "failed" });
  const state = isUsableRuntime(details) ? "ready" : details.state === "incompatible" ? "incompatible" : isGenuineAbsence(details) ? "absent" : "failed";
  const source = runtimeSource(details);
  return Object.freeze({
    state,
    ...(source ? { source } : {}),
    ...(safeSemver(details.version) ? { version: details.version } : {}),
    ...(state === "ready" && fingerprint && details.handle ? {
      fingerprint,
      handle: details.handle,
      ...(details.compatibility && details.features
        ? { compatibility: details.compatibility, features: details.features }
        : {}),
    } : {}),
    ...(details.compatibilityDiagnostics
      ? { compatibilityDiagnostics: details.compatibilityDiagnostics }
      : {}),
  });
}

function mutationControllerDetails(details: CodexRuntimeDetails | null): RuntimeControllerMutationDetails {
  const projected = controllerDetails(details);
  const source = details ? runtimeSource(details) : undefined;
  const version = details && safeSemver(details.version) ? details.version : undefined;
  return Object.freeze({
    state: projected.state === "absent" ? "failed" : projected.state,
    ...(source ? { source } : {}),
    ...(version ? { version } : {}),
    ...(projected.state === "ready" && projected.fingerprint && projected.handle
      ? {
        fingerprint: projected.fingerprint,
        handle: projected.handle,
        ...(projected.compatibility && projected.features
          ? { compatibility: projected.compatibility, features: projected.features }
          : {}),
      }
      : {}),
    ...(projected.compatibilityDiagnostics
      ? { compatibilityDiagnostics: projected.compatibilityDiagnostics }
      : {}),
  });
}

function runtimeSource(details: CodexRuntimeDetails): "external" | "managed" | undefined {
  if (!details.source) return undefined;
  return details.source === "managed" ? "managed" : "external";
}

/** Versions are presentation metadata, never an admission decision. */
function safeSemver(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value);
}
