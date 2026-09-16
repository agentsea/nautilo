import { join } from "node:path";
import {
  CompatibilityCache,
  CodexRpcClient,
  compatibilityToFeatureGates,
  createExecutableByteVerifier,
  evaluateCompatibility,
  evaluateStableCompatibility,
  observeProtocolSchemas,
  rpcRuntimeDecoder,
  type CodexFeatureGates,
  type CompatibilityResult,
  type VerifiedExecutableEvidence,
} from "@nautilo/codex-app-server";
import type {
  CodexRuntimeCode,
  CodexRuntimeDetails,
  CodexRuntimeHost,
  CodexRuntimeKind,
  ResolveExternalCodexRuntimeOptions,
  RuntimeFileIdentity,
} from "./contracts.ts";
import { CodexRuntimeMetadataStore } from "./metadata-store.ts";

const TIMEOUT = 5_000;
const OUTPUT = 512 * 1024;
const MAX_CANDIDATES = 128;
const MAX_PATH_LENGTH = 4_096;
const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;
const MINIMUM_VERSION = [0, 139, 0] as const;
type Source = "configured" | "path" | "conventional";
interface Evidence {
  readonly original: string;
  /** Concrete native executable used for every probe and eventual launch. */
  readonly identity: RuntimeFileIdentity;
  readonly executable: VerifiedExecutableEvidence;
  /** Official npm/Bun launcher identity, when discovery began at codex.js. */
  readonly launcher?: {
    readonly identity: RuntimeFileIdentity;
    readonly executable: VerifiedExecutableEvidence;
  };
}
interface PrivateRuntime {
  readonly evidence: Evidence;
  readonly details: CodexRuntimeDetails;
}
class ProbeCancelled extends Error {}
const isScriptLauncher = (identity: RuntimeFileIdentity) =>
  identity.header[0] === 0x23 && identity.header[1] === 0x21;
const freeze = <T>(value: T): T => {
  const clone = structuredClone(value);
  if (!clone || typeof clone !== "object") return clone;
  const pending: object[] = [clone as object];
  const seen = new Set<object>();
  while (pending.length) {
    const current = pending.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const child of Object.values(current))
      if (child && typeof child === "object") pending.push(child as object);
    Object.freeze(current);
  }
  return clone;
};
const equal = (a: RuntimeFileIdentity, b: RuntimeFileIdentity) =>
  a.canonicalPath === b.canonicalPath &&
  a.device === b.device &&
  a.inode === b.inode &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.header.length === b.header.length &&
  a.header.every((value, index) => value === b.header[index]);
function architectures(
  header: Uint8Array,
): readonly ("x64" | "arm64")[] | null {
  const u16 = (o: number, be = false) =>
    be
      ? (header[o]! << 8) | header[o + 1]!
      : header[o]! | (header[o + 1]! << 8);
  const u32 = (o: number, be = false) =>
    be
      ? ((header[o]! << 24) |
          (header[o + 1]! << 16) |
          (header[o + 2]! << 8) |
          header[o + 3]!) >>>
        0
      : (header[o]! |
          (header[o + 1]! << 8) |
          (header[o + 2]! << 16) |
          (header[o + 3]! << 24)) >>>
        0;
  if (
    header[0] === 0x7f &&
    header[1] === 0x45 &&
    header[2] === 0x4c &&
    header[3] === 0x46
  ) {
    if (header.length < 20 || ![1, 2].includes(header[5]!)) return null;
    const machine = u16(18, header[5] === 2);
    return machine === 0x3e ? ["x64"] : machine === 0xb7 ? ["arm64"] : null;
  }
  if (header[0] === 0x4d && header[1] === 0x5a) {
    const at = u32(0x3c);
    if (
      at + 6 <= header.length &&
      header[at] === 0x50 &&
      header[at + 1] === 0x45 &&
      header[at + 2] === 0 &&
      header[at + 3] === 0
    ) {
      const machine = u16(at + 4);
      return machine === 0x8664
        ? ["x64"]
        : machine === 0xaa64
          ? ["arm64"]
          : null;
    }
  }
  const magic = u32(0, true);
  if (
    magic === 0xcafebabe ||
    magic === 0xbebafeca ||
    magic === 0xcafebabf ||
    magic === 0xbfbafeca
  ) {
    const be = magic === 0xcafebabe || magic === 0xcafebabf;
    const entryBytes =
      magic === 0xcafebabf || magic === 0xbfbafeca ? 32 : 20;
    const count = u32(4, be);
    if (count > 32 || 8 + count * entryBytes > header.length) return null;
    const found: Array<"x64" | "arm64"> = [];
    for (let i = 0; i < count; i += 1) {
      const cpu = u32(8 + i * entryBytes, be);
      if (cpu === 0x01000007) found.push("x64");
      if (cpu === 0x0100000c) found.push("arm64");
    }
    return found.length ? [...new Set(found)] : null;
  }
  if ([0xfeedfacf, 0xcffaedfe].includes(u32(0, true))) {
    const cpu = u32(4, u32(0, true) === 0xfeedfacf);
    return cpu === 0x01000007 ? ["x64"] : cpu === 0x0100000c ? ["arm64"] : null;
  }
  return null;
}

/** Source-specific implementation; production callers use the facade export. */
export class ExternalCodexRuntimeManager {
  private readonly handles = new Map<string, PrivateRuntime>();
  private readonly cache = new CompatibilityCache<{
    compatibility: CompatibilityResult;
    features: CodexFeatureGates;
    schemaFingerprint: string;
    stableSchemaFingerprint: string;
  }>();
  private readonly verifiedByExecutable = new Map<
    string,
    {
      compatibility: CompatibilityResult;
      features: CodexFeatureGates;
      schemaFingerprint: string;
      stableSchemaFingerprint: string;
    }
  >();
  constructor(
    private readonly host: CodexRuntimeHost,
    private readonly metadata?: CodexRuntimeMetadataStore,
    /** Reviewed release policy seam; v1 ships with no known-bad versions. */
    private readonly knownBadVersions: ReadonlySet<string> = new Set(),
  ) {}
  async resolveExternal(
    options: ResolveExternalCodexRuntimeOptions = {},
  ): Promise<CodexRuntimeDetails> {
    if (this.host.platform === "win32")
      return this.persist(this.failure("CODEX_RUNTIME_PLATFORM_UNSUPPORTED"));
    const configured = options.configuredPath?.trim();
    if (options.configuredPath !== undefined && !configured)
      return this.persist(
        this.failure("CODEX_RUNTIME_NOT_FOUND", "configured"),
      );
    if (configured && configured.length > MAX_PATH_LENGTH)
      return this.persist(
        this.failure("CODEX_RUNTIME_PATH_INVALID", "configured"),
      );
    if (configured)
      return this.persist(
        await this.probe(configured, "configured", options.signal),
      );
    const seen = new Set<string>();
    let best: CodexRuntimeDetails | undefined;
    for (const item of this.candidates()) {
      if (options.signal?.aborted)
        return this.persist(
          this.failure("CODEX_RUNTIME_CANCELLED", item.source),
        );
      const identity = await this.host.resolve(item.path);
      if (!identity) {
        best ??= this.failure("CODEX_RUNTIME_NOT_FOUND", item.source);
        continue;
      }
      if (seen.has(identity.canonicalPath)) continue;
      seen.add(identity.canonicalPath);
      const result = await this.probe(
        item.path,
        item.source,
        options.signal,
        identity,
      );
      if (result.state === "ready" || result.state === "limited")
        return this.persist(result);
      if (
        !best ||
        (best.code === "CODEX_RUNTIME_NOT_FOUND" &&
          result.code !== "CODEX_RUNTIME_NOT_FOUND")
      )
        best = result;
    }
    return this.persist(best ?? this.failure("CODEX_RUNTIME_NOT_FOUND"));
  }
  inspect(handle: string): CodexRuntimeDetails | null {
    const value = this.handles.get(handle);
    return value ? freeze(value.details) : null;
  }
  async revalidate(handle: string): Promise<boolean> {
    const value = this.handles.get(handle);
    return value ? this.sameEvidence(value.evidence) : false;
  }
  /** Supervisor-only registry lookup; ordinary inspection never leaks paths. */
  internalLaunchTarget(handle: string): string | null {
    return this.handles.get(handle)?.evidence.identity.canonicalPath ?? null;
  }
  private *candidates(): Iterable<{
    path: string;
    source: Exclude<Source, "configured">;
  }> {
    const suffix = this.host.platform === "win32" ? ".exe" : "";
    let emitted = 0;
    for (const entry of this.host.pathEntries) {
      if (emitted >= MAX_CANDIDATES) return;
      const path = join(entry, `codex${suffix}`);
      if (path.length <= MAX_PATH_LENGTH) {
        emitted += 1;
        yield { path, source: "path" };
      }
    }
    for (const path of this.host.conventionalPaths) {
      if (emitted >= MAX_CANDIDATES) return;
      if (path.length <= MAX_PATH_LENGTH) {
        emitted += 1;
        yield { path, source: "conventional" };
      }
    }
  }
  private failure(
    code: CodexRuntimeCode,
    source?: Source,
  ): CodexRuntimeDetails {
    return freeze({
      state:
        code === "CODEX_RUNTIME_INCOMPATIBLE" ? "incompatible" : "unavailable",
      code,
      ...(source ? { source } : {}),
      checkedAt: this.host.now(),
    });
  }
  private async persist(
    details: CodexRuntimeDetails,
  ): Promise<CodexRuntimeDetails> {
    await this.metadata?.save(details).catch(() => undefined);
    return freeze(details);
  }
  private async evidence(
    original: string,
    identity: RuntimeFileIdentity,
    signal?: AbortSignal,
    launcherIdentity?: RuntimeFileIdentity,
  ): Promise<Evidence> {
    const executable = await this.hash(identity, signal);
    const launcher = launcherIdentity
      ? { identity: launcherIdentity, executable: await this.hash(launcherIdentity, signal) }
      : undefined;
    return { original, identity, executable, ...(launcher ? { launcher } : {}) };
  }
  private async hash(
    identity: RuntimeFileIdentity,
    signal?: AbortSignal,
  ): Promise<VerifiedExecutableEvidence> {
    const hash = createExecutableByteVerifier();
    for await (const chunk of this.host.executableChunks(identity)) {
      if (signal?.aborted) throw new ProbeCancelled();
      hash.update(chunk);
    }
    if (signal?.aborted) throw new ProbeCancelled();
    return hash.finish();
  }
  private async sameEvidence(evidence: Evidence): Promise<boolean> {
    const original = await this.host.resolve(evidence.original);
    if (!original) return false;
    let executable = original;
    if (evidence.launcher) {
      if (!equal(evidence.launcher.identity, original)) return false;
      const launcherFingerprint = await this.hash(original);
      if (launcherFingerprint.fingerprint !== evidence.launcher.executable.fingerprint)
        return false;
      const target = await this.host.resolveOfficialLauncherTarget?.(original);
      if (!target || !equal(evidence.identity, target)) return false;
      executable = target;
    } else if (!equal(evidence.identity, original)) {
      return false;
    }
    const executableFingerprint = await this.hash(executable);
    if (executableFingerprint.fingerprint !== evidence.executable.fingerprint)
      return false;
    const afterOriginal = await this.host.resolve(evidence.original);
    if (!afterOriginal || !equal(original, afterOriginal)) return false;
    if (!evidence.launcher) return true;
    const afterTarget = await this.host.resolveOfficialLauncherTarget?.(afterOriginal);
    return afterTarget !== null && afterTarget !== undefined && equal(executable, afterTarget);
  }
  private async probe(
    original: string,
    source: Source,
    signal?: AbortSignal,
    known?: RuntimeFileIdentity,
  ): Promise<CodexRuntimeDetails> {
    if (signal?.aborted) return this.failure("CODEX_RUNTIME_CANCELLED", source);
    if (
      this.host.platform === "win32" &&
      original.toLowerCase().endsWith(".cmd")
    )
      return this.failure("CODEX_RUNTIME_PLATFORM_UNSUPPORTED", source);
    const discovered = known ?? (await this.host.resolve(original));
    if (!discovered) return this.failure("CODEX_RUNTIME_NOT_FOUND", source);
    if (!discovered.regular || !discovered.executable)
      return this.failure("CODEX_RUNTIME_NOT_EXECUTABLE", source);
    if (discovered.size > MAX_EXECUTABLE_BYTES)
      return this.failure("CODEX_RUNTIME_EXECUTABLE_LIMIT", source);
    const launcherIdentity = isScriptLauncher(discovered) ? discovered : undefined;
    const identity = launcherIdentity
      ? await this.host.resolveOfficialLauncherTarget?.(launcherIdentity)
      : discovered;
    if (!identity)
      return this.failure("CODEX_RUNTIME_UNHEALTHY", source);
    if (!identity.regular || !identity.executable)
      return this.failure("CODEX_RUNTIME_NOT_EXECUTABLE", source);
    if (identity.size > MAX_EXECUTABLE_BYTES)
      return this.failure("CODEX_RUNTIME_EXECUTABLE_LIMIT", source);
    const machine = architectures(identity.header);
    if (!machine)
      return this.failure("CODEX_RUNTIME_UNHEALTHY", source);
    if (machine && !machine.includes(this.host.arch as "x64" | "arm64"))
      return this.failure("CODEX_RUNTIME_WRONG_ARCHITECTURE", source);
    let evidence: Evidence;
    try {
      evidence = await this.evidence(original, identity, signal, launcherIdentity);
    } catch (error) {
      return this.failure(
        error instanceof ProbeCancelled
          ? "CODEX_RUNTIME_CANCELLED"
          : "CODEX_RUNTIME_UNHEALTHY",
        source,
      );
    }
    const versionResult = await this.version(evidence, signal);
    if (typeof versionResult === "string")
      return this.failure(versionResult, source);
    const { kind, version } = versionResult;
    if (!this.versionAllowed(version))
      return this.failure("CODEX_RUNTIME_VERSION_INVALID", source);
    if (kind === "standalone")
      return freeze({
        ...this.failure("CODEX_RUNTIME_STANDALONE_UNSUPPORTED", source),
        kind,
        version,
        executableFingerprint: evidence.executable.fingerprint,
      });
    const launch = ["app-server", "--listen", "stdio://"];
    const health = await this.initialize(evidence, launch, signal);
    if (health) return this.failure(health, source);
    let schemas: Awaited<ReturnType<ExternalCodexRuntimeManager["schemas"]>>;
    try {
      schemas = await this.schemas(evidence, signal);
    } catch {
      return this.failure("CODEX_RUNTIME_UNHEALTHY", source);
    }
    if (typeof schemas === "string") return this.failure(schemas, source);
    const state: CodexRuntimeDetails["state"] =
      schemas.compatibility.state === "incompatible"
        ? "incompatible"
        : schemas.compatibility.state === "limited"
          ? "limited"
          : "ready";
    const details: CodexRuntimeDetails = {
      state,
      ...(schemas.compatibility.state === "incompatible"
        ? { code: "CODEX_RUNTIME_INCOMPATIBLE" as const }
        : {}),
      source,
      kind,
      version,
      checkedAt: this.host.now(),
      compatibility: schemas.compatibility.state,
      features: schemas.features,
      ...(schemas.compatibility.reasons.length > 0
        ? {
          compatibilityDiagnostics: Object.freeze(
            [...new Map(schemas.compatibility.reasons.map((reason) => [
              `${reason.feature}:${reason.code}`,
              Object.freeze({ feature: reason.feature, reason: reason.code }),
            ])).values()].slice(0, 5),
          ),
        }
        : {}),
      executableFingerprint: evidence.executable.fingerprint,
      ...(evidence.launcher
        ? { launcherFingerprint: evidence.launcher.executable.fingerprint }
        : {}),
      schemaFingerprint: schemas.schemaFingerprint,
      stableSchemaFingerprint: schemas.stableSchemaFingerprint,
    };
    if (details.state !== "incompatible") {
      let handle = this.host.randomHandle();
      for (
        let attempts = 0;
        this.handles.has(handle) && attempts < 8;
        attempts += 1
      )
        handle = this.host.randomHandle();
      if (this.handles.has(handle))
        return this.failure("CODEX_RUNTIME_UNHEALTHY", source);
      const publicDetails = freeze({ ...details, handle });
      this.handles.set(handle, { evidence, details: publicDetails });
      return publicDetails;
    }
    return freeze(details);
  }
  private versionAllowed(version: string): boolean {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
    if (!match || this.knownBadVersions.has(version)) return false;
    const actual = match.slice(1).map(Number);
    return (
      actual[0]! > MINIMUM_VERSION[0] ||
      (actual[0] === MINIMUM_VERSION[0] && actual[1]! > MINIMUM_VERSION[1]) ||
      (actual[0] === MINIMUM_VERSION[0] &&
        actual[1] === MINIMUM_VERSION[1] &&
        actual[2]! >= MINIMUM_VERSION[2])
    );
  }
  private async withProcess<T>(
    evidence: Evidence,
    argv: readonly string[],
    signal: AbortSignal | undefined,
    use: (
      process: Awaited<ReturnType<CodexRuntimeHost["run"]>>,
      root: string,
    ) => Promise<T>,
  ): Promise<T | CodexRuntimeCode> {
    if (signal?.aborted) return "CODEX_RUNTIME_CANCELLED";
    if (!(await this.sameEvidence(evidence)))
      return "CODEX_RUNTIME_IDENTITY_CHANGED";
    const root = await this.host.createPrivateProbeRoot();
    let process: Awaited<ReturnType<CodexRuntimeHost["run"]>> | undefined;
    let abort: (() => void) | undefined;
    let outcome: T | CodexRuntimeCode = "CODEX_RUNTIME_UNHEALTHY";
    try {
      process = await this.host.run(evidence.identity, argv, {
        timeoutMs: TIMEOUT,
        cwd: join(root, "cwd"),
        env: {
          ...this.host.probeEnv,
          HOME: join(root, "home"),
          USERPROFILE: join(root, "home"),
          CODEX_HOME: join(root, "home"),
          TMPDIR: root,
          TEMP: root,
          TMP: root,
        },
        maxOutputBytes: OUTPUT,
      });
      const aborted = new Promise<never>((_, reject) => {
        abort = () => reject(new Error("cancelled"));
        if (signal?.aborted) {
          abort();
          return;
        }
        signal?.addEventListener("abort", abort, { once: true });
      });
      const value = await Promise.race([use(process, root), aborted]);
      outcome = (await this.sameEvidence(evidence))
        ? value
        : "CODEX_RUNTIME_IDENTITY_CHANGED";
    } catch (error) {
      if (!(error instanceof Error)) outcome = "CODEX_RUNTIME_UNHEALTHY";
      else if (error.message === "cancelled")
        outcome = "CODEX_RUNTIME_CANCELLED";
      else if (error.message === "timeout") outcome = "CODEX_RUNTIME_TIMEOUT";
      else if (error.message === "limit")
        outcome = "CODEX_RUNTIME_OUTPUT_LIMIT";
      else if (error.message === "version")
        outcome = "CODEX_RUNTIME_VERSION_INVALID";
      else outcome = "CODEX_RUNTIME_UNHEALTHY";
    } finally {
      if (abort) signal?.removeEventListener("abort", abort);
      await process?.terminate(100).catch(() => undefined);
      await process?.result.catch(() => undefined);
      try {
        await this.host.removePrivateProbeRoot(root);
      } catch {
        outcome = "CODEX_RUNTIME_UNHEALTHY";
      }
    }
    return outcome;
  }
  private async version(
    evidence: Evidence,
    signal?: AbortSignal,
  ): Promise<{ kind: CodexRuntimeKind; version: string } | CodexRuntimeCode> {
    const result = await this.withProcess(
      evidence,
      ["--version"],
      signal,
      async (process) => {
        const output = await process.result;
        if (output.timedOut) throw new Error("timeout");
        if (output.outputLimited) throw new Error("limit");
        const text = new TextDecoder().decode(output.stdout).trim();
        const match =
          /^(codex-cli|codex-app-server)\s+([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)$/.exec(
            text,
          );
        if (output.code !== 0 || !match) throw new Error("version");
        return {
          kind: match[1] === "codex-cli" ? "full_cli" : "standalone",
          version: match[2]!,
        } as const;
      },
    );
    return typeof result === "string" ? result : result;
  }
  private async initialize(
    evidence: Evidence,
    argv: readonly string[],
    signal?: AbortSignal,
  ): Promise<CodexRuntimeCode | null> {
    const result = await this.withProcess(
      evidence,
      argv,
      signal,
      async (process, root) => {
        const client = new CodexRpcClient({
          readable: process.stdout,
          writable: process.stdin,
          decoder: rpcRuntimeDecoder,
        });
        const initialized = await client.initialize(
          {
            clientName: "nautilo",
            clientTitle: "Nautilo",
            clientVersion: "1",
            experimentalApi: false,
          },
          signal ? { timeoutMs: TIMEOUT, signal } : { timeoutMs: TIMEOUT },
        );
        if (initialized.codexHome !== join(root, "home"))
          throw new Error("initialize_home");
        await client.close();
        await process.terminate(100);
        const done = await process.result;
        if (done.timedOut) throw new Error("timeout");
        if (done.outputLimited) throw new Error("limit");
      },
    );
    return typeof result === "string" ? result : null;
  }
  private async schemas(
    evidence: Evidence,
    signal?: AbortSignal,
  ): Promise<
    | {
        compatibility: CompatibilityResult;
        features: CodexFeatureGates;
        schemaFingerprint: string;
        stableSchemaFingerprint: string;
      }
    | CodexRuntimeCode
  > {
    if (signal?.aborted) return "CODEX_RUNTIME_CANCELLED";
    const known = evidence.launcher
      ? undefined
      : this.verifiedByExecutable.get(evidence.executable.fingerprint);
    if (known) return freeze(known);
    const root = await this.host.createPrivateProbeRoot();
    try {
      for (const experimental of [false, true]) {
        if (!(await this.sameEvidence(evidence)))
          return "CODEX_RUNTIME_IDENTITY_CHANGED";
        const process = await this.host.run(
          evidence.identity,
          [
            "app-server",
            "generate-json-schema",
            "--out",
            join(root, experimental ? "experimental" : "stable"),
            ...(experimental ? ["--experimental"] : []),
          ],
          {
            timeoutMs: TIMEOUT,
            cwd: join(root, "cwd"),
            env: {
              ...this.host.probeEnv,
              HOME: join(root, "home"),
              USERPROFILE: join(root, "home"),
              CODEX_HOME: join(root, "home"),
              TMPDIR: root,
              TEMP: root,
              TMP: root,
            },
            maxOutputBytes: OUTPUT,
          },
        );
        let abort: (() => void) | undefined;
        const aborted = new Promise<never>((_, reject) => {
          abort = () => reject(new ProbeCancelled());
          if (signal?.aborted) {
            abort();
            return;
          }
          signal?.addEventListener("abort", abort, { once: true });
        });
        let done;
        try {
          done = await Promise.race([process.result, aborted]);
        } catch (error) {
          await process.terminate(100).catch(() => undefined);
          await process.result.catch(() => undefined);
          return error instanceof ProbeCancelled
            ? "CODEX_RUNTIME_CANCELLED"
            : "CODEX_RUNTIME_SCHEMA_INVALID";
        } finally {
          if (abort) signal?.removeEventListener("abort", abort);
        }
        await process.terminate(100).catch(() => undefined);
        await process.result.catch(() => undefined);
        if (done.timedOut) return "CODEX_RUNTIME_TIMEOUT";
        if (done.outputLimited) return "CODEX_RUNTIME_OUTPUT_LIMIT";
        if (done.code !== 0) return "CODEX_RUNTIME_SCHEMA_INVALID";
        if (!(await this.sameEvidence(evidence)))
          return "CODEX_RUNTIME_IDENTITY_CHANGED";
      }
      const stable = observeProtocolSchemas(
        await this.host.listSchemaFiles(join(root, "stable")),
        undefined,
        evidence.executable,
      );
      if (!evaluateStableCompatibility(stable).compatible)
        return "CODEX_RUNTIME_SCHEMA_INVALID";
      const full = observeProtocolSchemas(
        await this.host.listSchemaFiles(join(root, "experimental")),
        undefined,
        evidence.executable,
      );
      const cached = this.cache.get(full);
      if (cached)
        return freeze({
          ...cached,
          stableSchemaFingerprint: stable.schemaFingerprint,
        });
      const compatibility = evaluateCompatibility(full);
      const result = this.cache.set(full, {
        compatibility,
        features: compatibilityToFeatureGates(compatibility),
        schemaFingerprint: full.schemaFingerprint,
        stableSchemaFingerprint: stable.schemaFingerprint,
      });
      if (!isScriptLauncher(evidence.identity))
        this.verifiedByExecutable.set(evidence.executable.fingerprint, result);
      while (this.verifiedByExecutable.size > 32) {
        const oldest = this.verifiedByExecutable.keys().next().value;
        if (oldest === undefined) break;
        this.verifiedByExecutable.delete(oldest);
      }
      return result;
    } catch {
      return "CODEX_RUNTIME_SCHEMA_INVALID";
    } finally {
      await this.host.removePrivateProbeRoot(root);
    }
  }
}
