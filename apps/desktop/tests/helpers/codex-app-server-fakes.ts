import {
  createAnchorSchemaFixtureFiles,
  createFakeCodexAppServer,
  type FakeCodexAppServer,
} from "@nautilo/codex-app-server/testkit";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { gzipSync } from "node:zlib";
import type {
  ChildIdentity,
  ChildStdio,
  HostTimer,
  HostTimerHandle,
  ManagedChildProcess,
  ProcessHost,
  SpawnSpec,
} from "@nautilo/codex-app-server-host/internal";
import type {
  CodexRuntimeHost,
  CodexRuntimeReleaseManifest,
  ManagedRuntimeHost,
  RuntimeFileIdentity,
  RuntimeProcess,
} from "../../electron/codex-runtime/index.ts";
import { CodexManagedRuntimeManager } from "../../electron/codex-runtime/acquisition.ts";
import { ExternalCodexRuntimeManager } from "../../electron/codex-runtime/external-manager.ts";
import { CodexRuntimeManager } from "../../electron/codex-runtime/facade.ts";

type Exit = { readonly code: number | null; readonly signal: string | null };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

export class ManualHostTimer implements HostTimer {
  private next = 0;
  private readonly callbacks = new Map<number, () => void>();

  setTimeout(callback: () => void, _delayMs: number): HostTimerHandle {
    const handle = ++this.next;
    this.callbacks.set(handle, callback);
    return handle as unknown as HostTimerHandle;
  }

  clearTimeout(timer: HostTimerHandle): void {
    this.callbacks.delete(timer as unknown as number);
  }

  fireAll(): void {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) callback();
  }

  get pendingCount(): number {
    return this.callbacks.size;
  }
}

export class FakeCodexChild implements ManagedChildProcess {
  readonly pid: number;
  readonly server: FakeCodexAppServer;
  readonly stdio: ChildStdio;
  readonly exited: Promise<Exit>;
  readonly signals: string[] = [];
  identity: ChildIdentity | null = null;
  private readonly finish: (exit: Exit) => void;
  private gone = false;
  private disposed = false;

  constructor(readonly spec: SpawnSpec, index: number) {
    this.pid = 10_000 + index;
    this.server = createFakeCodexAppServer();
    const exit = deferred<Exit>();
    this.exited = exit.promise;
    this.finish = exit.resolve;
    this.stdio = {
      stdin: {
        write: async (chunk) => {
          this.server.writable.write(chunk);
        },
        end: async () => {
          this.server.writable.end();
        },
      },
      stdout: this.server.readable,
      stderr: emptyAsyncIterable(),
    };
  }

  async isProcessGroupGone(): Promise<boolean> {
    return this.gone;
  }

  async sendInterrupt(): Promise<void> {
    this.signals.push("SIGINT");
    this.exit(0, "SIGINT");
  }

  async signalProcessGroup(signal: "SIGTERM" | "SIGKILL"): Promise<void> {
    this.signals.push(signal);
    this.exit(null, signal);
  }

  exit(code: number | null, signal: string | null): void {
    if (this.gone) return;
    this.gone = true;
    this.dispose();
    this.finish({ code, signal });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.server.eof({ generation: this.identity?.childGeneration ?? 0 });
    this.server.writable.end();
  }
}

export class FakeCodexProcessHost implements ProcessHost {
  readonly children: FakeCodexChild[] = [];
  readonly specs: SpawnSpec[] = [];
  private readonly countWaiters: Array<{ count: number; resolve: (child: FakeCodexChild) => void }> = [];

  async spawn(spec: SpawnSpec): Promise<FakeCodexChild> {
    this.specs.push(spec);
    const child = new FakeCodexChild(spec, this.children.length + 1);
    this.children.push(child);
    for (let index = this.countWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.countWaiters[index]!;
      if (this.children.length < waiter.count) continue;
      this.countWaiters.splice(index, 1);
      waiter.resolve(child);
    }
    return child;
  }

  waitForCount(count: number): Promise<FakeCodexChild> {
    const child = this.children[count - 1];
    if (child) return Promise.resolve(child);
    return new Promise((resolve) => this.countWaiters.push({ count, resolve }));
  }
}

export function createRuntimeFacadeFixture(runtimeRoot: string): {
  readonly manager: CodexRuntimeManager;
  readonly manifest: CodexRuntimeReleaseManifest;
  readonly privateTargets: Readonly<Record<string, string>>;
} {
  const artifact = runtimeArtifact();
  const publishedRoot = join(
    runtimeRoot,
    "runtimes",
    "codex",
    artifact.manifest.codexVersion,
    "darwin-arm64",
    artifact.manifest.artifacts["darwin-arm64"].sha256,
  );
  const externalTarget = "/fixture/private/nautilo_synthetic/external/codex";
  const managedHost = managedRuntimeHost(runtimeRoot, artifact.archive);
  return {
    manager: new CodexRuntimeManager(
      new ExternalCodexRuntimeManager(externalRuntimeHost(externalTarget)),
      new CodexManagedRuntimeManager(managedHost, artifact.manifest),
    ),
    manifest: artifact.manifest,
    privateTargets: Object.freeze({
      external: externalTarget,
      managed: join(publishedRoot, "bin", "codex-app-server"),
    }),
  };
}

async function* emptyAsyncIterable(): AsyncIterable<Uint8Array> {}

export const SYNTHETIC_RUNTIME_FIXTURE_PROVENANCE = "nautilo_synthetic";

const encoder = new TextEncoder();
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const octal = (value: number, width: number) => `${value.toString(8).padStart(width - 1, "0")}\0`;

function tar(entries: Readonly<Record<string, Uint8Array>>): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const [name, content] of Object.entries(entries)) {
    const header = new Uint8Array(512);
    header.set(encoder.encode(name), 0);
    header.set(encoder.encode(octal(0o600, 8)), 100);
    header.set(encoder.encode(octal(content.byteLength, 12)), 124);
    header.fill(0x20, 148, 156);
    header[156] = 0x30;
    header.set(encoder.encode("ustar\0"), 257);
    header.set(encoder.encode(octal(header.reduce((total, byte) => total + byte, 0), 8)), 148);
    chunks.push(header, content, new Uint8Array(Math.ceil(content.byteLength / 512) * 512 - content.byteLength));
  }
  chunks.push(new Uint8Array(1024));
  return gzipSync(Buffer.concat(chunks.map((value) => Buffer.from(value))));
}

function runtimeArtifact(): { archive: Uint8Array; manifest: CodexRuntimeReleaseManifest } {
  const version = "0.146.0";
  // Real Darwin executables use the little-endian MH_CIGAM_64 byte layout.
  const entrypoint = new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0, 0, 1]);
  const entries = {
    "codex-package.json": encoder.encode(JSON.stringify({
      layoutVersion: 1,
      version,
      target: "aarch64-apple-darwin",
      variant: "codex-app-server",
      entrypoint: "bin/codex-app-server",
      pathDir: "codex-path",
      resourcesDir: "codex-resources",
    })),
    "bin/codex-app-server": entrypoint,
    "bin/codex-code-mode-host": entrypoint,
    "codex-path/rg": encoder.encode("synthetic-rg"),
    "codex-resources/zsh/bin/zsh": encoder.encode("synthetic-zsh"),
  };
  const requiredMembers = Object.fromEntries(
    Object.entries(entries).map(([name, bytes]) => [name, { bytes: bytes.byteLength, sha256: sha(bytes) }]),
  );
  const archive = tar(entries);
  const descriptor = {
    platform: "darwin-arm64" as const,
    version,
    releaseTag: `rust-v${version}`,
    url: `https://github.com/openai/codex/releases/download/rust-v${version}/codex-app-server-package-aarch64-apple-darwin.tar.gz`,
    archiveName: "codex-app-server-package-aarch64-apple-darwin.tar.gz",
    archiveBytes: archive.byteLength,
    sha256: sha(archive),
    entrypointSha256: sha(entrypoint),
    package: {
      layoutVersion: 1 as const,
      version,
      target: "aarch64-apple-darwin",
      variant: "codex-app-server" as const,
      entrypoint: "bin/codex-app-server",
      pathDir: "codex-path",
      resourcesDir: "codex-resources",
      requiredMembers,
      executableMembers: ["bin/codex-app-server", "bin/codex-code-mode-host", "codex-path/rg", "codex-resources/zsh/bin/zsh"],
    },
    signature: {
      kind: "macos-codesign" as const,
      teamId: "2DC432GLL2",
      publisherSubject: "Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)",
    },
  };
  return {
    archive,
    manifest: {
      schemaVersion: 1,
      cohort: "certified",
      codexVersion: version,
      releaseTag: `rust-v${version}`,
      sourceRepo: "openai/codex",
      artifacts: {
        "darwin-arm64": descriptor,
        "darwin-x64": {
          ...descriptor,
          platform: "darwin-x64",
          url: `https://github.com/openai/codex/releases/download/rust-v${version}/codex-app-server-package-x86_64-apple-darwin.tar.gz`,
          archiveName: "codex-app-server-package-x86_64-apple-darwin.tar.gz",
          archiveBytes: 1,
          sha256: "0".repeat(64),
          entrypointSha256: "0".repeat(64),
          package: { ...descriptor.package, target: "x86_64-apple-darwin" },
        },
      },
    },
  };
}

function managedRuntimeHost(root: string, archive: Uint8Array): ManagedRuntimeHost {
  let handle = 0;
  return {
    platform: "darwin",
    arch: "arm64",
    runtimeRoot: root,
    async fetch(url) {
      return { url, status: 200, contentLength: archive.byteLength, body: chunks(archive) };
    },
    async verifyDarwinSignature() { return true; },
    async health() { return true; },
    now: () => 1,
    randomHandle: () => `synthetic-managed-${++handle}`,
  };
}

async function* chunks(value: Uint8Array): AsyncIterable<Uint8Array> {
  yield value.slice(0, 17);
  yield value.slice(17);
}

function externalRuntimeHost(canonicalPath: string): CodexRuntimeHost {
  const identity: RuntimeFileIdentity = {
    canonicalPath,
    device: 1,
    inode: 2,
    size: 8,
    mtimeMs: 4,
    executable: true,
    regular: true,
    header: new Uint8Array([
      0x7f, 0x45, 0x4c, 0x46, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x3e, 0,
    ]),
  };
  let probe = 0;
  return {
    platform: "linux",
    arch: "x64",
    pathEntries: [],
    conventionalPaths: [],
    probeEnv: {},
    now: () => 1,
    randomHandle: () => "synthetic-external",
    async resolve() { return identity; },
    async *executableChunks() { yield new Uint8Array([1, 2, 3]); },
    async createPrivateProbeRoot() { return `/fixture/probe-${++probe}`; },
    async removePrivateProbeRoot() {},
    async listSchemaFiles() { return anchoredSchemas(); },
    async run(_identity, argv, options): Promise<RuntimeProcess> {
      const stdout = new PassThrough();
      let finish!: (value: Awaited<RuntimeProcess["result"]>) => void;
      const result = new Promise<Awaited<RuntimeProcess["result"]>>((resolveResult) => { finish = resolveResult; });
      const complete = () => finish({
        code: 0,
        timedOut: false,
        outputLimited: false,
        stdout: encoder.encode(argv[0] === "--version" ? "codex-cli 0.146.0\n" : ""),
        stderr: new Uint8Array(),
      });
      const stdin = new Writable({
        write(chunk, _encoding, callback) {
          if (argv[0] === "app-server" && argv[1] === "--listen") {
            const frame = JSON.parse(String(chunk)) as Record<string, unknown>;
            if (frame["method"] === "initialize") {
              stdout.write(`${JSON.stringify({
                id: frame["id"],
                result: {
                  userAgent: "Synthetic Codex",
                  codexHome: options.env["CODEX_HOME"],
                  platformFamily: "unix",
                  platformOs: "macos",
                },
              })}\n`);
            }
          }
          callback();
        },
      });
      if (argv[0] !== "app-server" || argv[1] !== "--listen") queueMicrotask(complete);
      return {
        stdout,
        stdin,
        result,
        async terminate() {
          complete();
          stdout.end();
        },
      };
    },
  };
}

function anchoredSchemas(): readonly { relativePath: string; bytes: Uint8Array }[] {
  return createAnchorSchemaFixtureFiles();
}
