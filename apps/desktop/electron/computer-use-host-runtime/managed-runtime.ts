import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { ComputerUseHostRuntimeLaunch, ComputerUseHostRuntimePort } from "./broker.ts";
import type { ComputerUseHostRelease, ComputerUseHostState } from "./contracts.ts";
import { MacosComputerUseHostAttestor, type MacosCommandRunner } from "./macos-attestor.ts";
import { NodeComputerUseHostStorage } from "./node-storage.ts";
import { OFFICIAL_COMPUTER_USE_HOST_POINTER_URL, OfficialComputerUseHostReleaseAuthority } from "./official-release-authority.ts";
import { ComputerUseHostRuntime } from "./runtime.ts";

type FetchLike = (input: string, init: Readonly<{ redirect: "error"; signal?: AbortSignal }>) => Promise<Response>;
type BundledManifest = Readonly<{
  schemaVersion: 2;
  binary: "nautilo-computer-use-host";
  version: string;
  architectures: readonly ["arm64", "x64"];
}>;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u;

function parseBundledManifest(value: unknown): BundledManifest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).sort().join(",") !== "architectures,binary,schemaVersion,version"
    || item["schemaVersion"] !== 2 || item["binary"] !== "nautilo-computer-use-host"
    || typeof item["version"] !== "string" || !VERSION.test(item["version"])
    || !Array.isArray(item["architectures"]) || item["architectures"].length !== 2
    || item["architectures"][0] !== "arm64" || item["architectures"][1] !== "x64") return null;
  return item as unknown as BundledManifest;
}

export interface ManagedComputerUseHostRuntimeOptions {
  readonly resourceDirectory: string;
  readonly runtimeRoot: string;
  /** The signed Nautilo executable whose Developer ID identity anchors Host releases. */
  readonly desktopExecutable: string;
  readonly expectedUid?: number;
  readonly fetcher?: FetchLike;
  readonly commandRunner?: MacosCommandRunner;
}

/**
 * Production runtime port. It always admits the bundled signed Host first,
 * then performs at most one same-origin managed-release check per process.
 * Offline or rejected remote state never displaces that last-known-good Host.
 */
class ManagedComputerUseHostRuntime implements ComputerUseHostRuntimePort {
  private runtime: ComputerUseHostRuntime | null = null;
  private initialization: Promise<ComputerUseHostRuntime> | null = null;
  private bootstrapWork: Promise<ComputerUseHostState> | null = null;

  constructor(private readonly options: ManagedComputerUseHostRuntimeOptions) {}

  async bootstrap(signal?: AbortSignal): Promise<ComputerUseHostState> {
    const present = this.runtime?.snapshot();
    if (present?.state === "ready") return present;
    if (this.bootstrapWork !== null) return await this.bootstrapWork;
    this.bootstrapWork = this.bootstrapOnce(signal);
    try { return await this.bootstrapWork; } finally { this.bootstrapWork = null; }
  }

  acquireLaunch(): ComputerUseHostRuntimeLaunch | null { return this.runtime?.acquireLaunch() ?? null; }

  async updateFromOfficialPointer(signal?: AbortSignal): Promise<ComputerUseHostState> {
    const runtime = await this.initialize(signal); return await runtime.updateFromOfficialPointer(signal);
  }

  private async bootstrapOnce(signal?: AbortSignal): Promise<ComputerUseHostState> {
    try {
      const runtime = await this.initialize(signal); const local = await runtime.bootstrap(signal);
      if (local.state !== "ready" || signal?.aborted) return local;
      const managed = await runtime.updateFromOfficialPointer(signal);
      if (managed.state === "ready") return managed;
      const retained = runtime.snapshot();
      return retained.state === "ready"
        ? { ...retained, remoteUpdateFailure: managed.code }
        : retained;
    } catch { return { state: "unavailable", code: "host_unavailable" }; }
  }

  private async initialize(signal?: AbortSignal): Promise<ComputerUseHostRuntime> {
    if (this.runtime !== null) return this.runtime;
    if (this.initialization === null) {
      const work = this.initializeOnce(signal);
      this.initialization = work;
      void work.catch(() => {
        if (this.initialization === work) this.initialization = null;
      });
    }
    return await this.initialization;
  }

  private async initializeOnce(signal?: AbortSignal): Promise<ComputerUseHostRuntime> {
    if (!isAbsolute(this.options.resourceDirectory) || !isAbsolute(this.options.runtimeRoot) || !isAbsolute(this.options.desktopExecutable)) {
      throw new Error("Computer Use Host production paths rejected");
    }
    const resourceInfo = await lstat(this.options.resourceDirectory);
    if (!resourceInfo.isDirectory() || resourceInfo.isSymbolicLink()) throw new Error("Computer Use Host resource root rejected");
    const resource = await realpath(this.options.resourceDirectory); const manifestPath = join(resource, "manifest.json");
    if (relative(resource, manifestPath).startsWith("..")) throw new Error("Computer Use Host manifest escaped resource root");
    const manifestInfo = await lstat(manifestPath); if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > 64 * 1024) throw new Error("Computer Use Host manifest rejected");
    const manifest = parseBundledManifest(JSON.parse(await readFile(manifestPath, "utf8"))); if (manifest === null) throw new Error("Computer Use Host manifest rejected");
    const entrypoint = join(resource, manifest.binary); const entryInfo = await lstat(entrypoint);
    if (!entryInfo.isFile() || entryInfo.isSymbolicLink() || entryInfo.size <= 0 || (entryInfo.mode & 0o111) === 0) throw new Error("Computer Use Host bundled executable rejected");
    // electron-builder signs this nested Mach-O after extraResources are
    // copied, so its final bytes cannot be predeclared in the bundled
    // manifest. The enclosing sealed app and the nested Developer ID
    // signature establish provenance; bind storage to the final signed bytes.
    const digest = createHash("sha256").update(await readFile(entrypoint)).digest("hex");
    const attestor = await MacosComputerUseHostAttestor.create({
      desktopExecutable: this.options.desktopExecutable,
      bundledEntrypoint: entrypoint,
      ...(this.options.commandRunner ? { runner: this.options.commandRunner } : {}),
      ...(signal ? { signal } : {}),
    });
    const bundledRelease: ComputerUseHostRelease = Object.freeze({
      schemaVersion: 1,
      releaseId: `bundled-${digest.slice(0, 24)}`,
      version: manifest.version,
      pointerUrl: OFFICIAL_COMPUTER_USE_HOST_POINTER_URL,
      archive: Object.freeze({
        format: "bare",
        url: `https://media.nautilo.ai/computer-use/host/v1/bundled/sha256-${digest}`,
        bytes: entryInfo.size,
        sha256: digest,
      }),
      entrypoint: manifest.binary,
      members: Object.freeze([{ path: manifest.binary, bytes: entryInfo.size, sha256: digest, executable: true as const }]),
      architectures: manifest.architectures,
      signature: attestor.trustedSignature(),
    });
    const storage = new NodeComputerUseHostStorage({
      runtimeRoot: this.options.runtimeRoot,
      bundledDirectory: resource,
      officialPointerUrl: OFFICIAL_COMPUTER_USE_HOST_POINTER_URL,
      ...(this.options.expectedUid === undefined ? {} : { expectedUid: this.options.expectedUid }),
      ...(this.options.fetcher ? { fetcher: this.options.fetcher } : {}),
    });
    const runtime = new ComputerUseHostRuntime({
      officialPointerUrl: OFFICIAL_COMPUTER_USE_HOST_POINTER_URL,
      bundledRelease,
      releaseAuthority: new OfficialComputerUseHostReleaseAuthority(this.options.fetcher),
      storage,
      attestor,
      expectedArchitectures: ["arm64", "x64"],
    });
    this.runtime = runtime; return runtime;
  }
}

export function createManagedComputerUseHostRuntime(options: ManagedComputerUseHostRuntimeOptions): ManagedComputerUseHostRuntime {
  return new ManagedComputerUseHostRuntime(options);
}
