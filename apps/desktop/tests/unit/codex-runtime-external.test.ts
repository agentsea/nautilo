import { describe, expect, test } from "bun:test";
import { createAnchorSchemaFixtureFiles } from "@nautilo/codex-app-server/testkit";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { ExternalCodexRuntimeManager as CodexRuntimeManager } from "../../electron/codex-runtime/external-manager.ts";
import { CodexRuntimeMetadataStore } from "../../electron/codex-runtime/metadata-store.ts";
import { createNodeCodexRuntimeHost } from "../../electron/codex-runtime/node-adapters.ts";
import type {
  CodexRuntimeHost,
  RuntimeFileIdentity,
  RuntimeProcess,
} from "../../electron/codex-runtime/contracts.ts";

const identity = (
  overrides: Partial<RuntimeFileIdentity> = {},
): RuntimeFileIdentity => ({
  canonicalPath: "/private/codex",
  device: 1,
  inode: 2,
  size: 3,
  mtimeMs: 4,
  executable: true,
  regular: true,
  header: new Uint8Array([
    0x7f, 0x45, 0x4c, 0x46, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x3e, 0,
  ]),
  ...overrides,
});
function host(
  resolve: (candidate: string) => RuntimeFileIdentity | null,
): CodexRuntimeHost {
  return {
    platform: "linux",
    arch: "x64",
    pathEntries: ["/path"],
    conventionalPaths: [],
    probeEnv: { PATH: "/path" },
    now: () => 1,
    randomHandle: () => "opaque",
    async resolve(candidate) {
      return resolve(candidate);
    },
    async *executableChunks() {
      yield new Uint8Array([1]);
    },
    async run() {
      throw new Error("must not run");
    },
    async createPrivateProbeRoot() {
      return "/private/probe";
    },
    async listSchemaFiles() {
      return [];
    },
    async removePrivateProbeRoot() {},
  };
}

function anchoredSchemas(): readonly {
  relativePath: string;
  bytes: Uint8Array;
}[] {
  return createAnchorSchemaFixtureFiles();
}

function successHost() {
  const calls: Array<{
    argv: readonly string[];
    cwd: string;
    env: Readonly<Record<string, string>>;
  }> = [];
  const roots: string[] = [];
  const files = anchoredSchemas();
  const result = host(() => identity());
  return {
    calls,
    roots,
    host: {
      ...result,
      randomHandle: () => "opaque-success",
      async createPrivateProbeRoot() {
        const root = `/private/probe-${roots.length}`;
        roots.push(root);
        return root;
      },
      async removePrivateProbeRoot(root: string) {
        expect(roots).toContain(root);
      },
      async listSchemaFiles() {
        return files;
      },
      async run(_identity, argv, options): Promise<RuntimeProcess> {
        calls.push({ argv, cwd: options.cwd, env: options.env });
        const stdout = new PassThrough();
        let finish:
          | ((value: {
              code: number | null;
              timedOut: boolean;
              outputLimited: boolean;
              stdout: Uint8Array;
              stderr: Uint8Array;
            }) => void)
          | undefined;
        const complete = () =>
          finish?.({
            code: 0,
            timedOut: false,
            outputLimited: false,
            stdout: new TextEncoder().encode(
              argv[0] === "--version" ? "codex-cli 0.146.0\n" : "",
            ),
            stderr: new Uint8Array(),
          });
        const stdin = new Writable({
          write(chunk, _encoding, callback) {
            if (argv[0] === "app-server" && argv[1] === "--listen") {
              const frame = JSON.parse(String(chunk));
              if (frame.method === "initialize")
                stdout.write(
                  `${JSON.stringify({ id: frame.id, result: { userAgent: "test", codexHome: options.env.CODEX_HOME, platformFamily: "unix", platformOs: "linux" } })}\n`,
                );
            }
            callback();
          },
        });
        if (argv[0] !== "app-server" || argv[1] !== "--listen")
          queueMicrotask(complete);
        return {
          stdout,
          stdin,
          result: new Promise((resolveResult) => {
            finish = resolveResult;
          }),
          async terminate() {
            complete();
            stdout.end();
          },
        };
      },
    } satisfies CodexRuntimeHost,
  };
}

function versionOutcomeHost(outcome: {
  timedOut?: boolean;
  outputLimited?: boolean;
  stdout?: string;
  code?: number | null;
}) {
  const base = host(() => identity());
  let removed = 0;
  return {
    get removed() {
      return removed;
    },
    host: {
      ...base,
      async removePrivateProbeRoot() {
        removed += 1;
      },
      async run(): Promise<RuntimeProcess> {
        const stdout = new PassThrough();
        return {
          stdout,
          stdin: new Writable({
            write(_chunk, _encoding, callback) {
              callback();
            },
          }),
          result: Promise.resolve({
            code: outcome.code ?? 0,
            timedOut: outcome.timedOut ?? false,
            outputLimited: outcome.outputLimited ?? false,
            stdout: new TextEncoder().encode(
              outcome.stdout ?? "codex-cli 0.139.0\n",
            ),
            stderr: new Uint8Array(),
          }),
          async terminate() {
            stdout.end();
          },
        };
      },
    } satisfies CodexRuntimeHost,
  };
}

describe("CodexRuntimeManager external discovery", () => {
  test("configured path is authoritative and never falls through to PATH", async () => {
    const result = await new CodexRuntimeManager(
      host((candidate) =>
        candidate === "/configured/missing" ? null : identity(),
      ),
    ).resolveExternal({ configuredPath: "/configured/missing" });
    expect(result).toMatchObject({
      state: "unavailable",
      code: "CODEX_RUNTIME_NOT_FOUND",
      source: "configured",
    });
  });
  test("rejects a direct wrong-architecture executable before execution", async () => {
    const result = await new CodexRuntimeManager(
      host(() =>
        identity({
          header: new Uint8Array([
            0x7f, 0x45, 0x4c, 0x46, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            0xb7, 0,
          ]),
        }),
      ),
    ).resolveExternal({ configuredPath: "/configured/codex" });
    expect(result).toMatchObject({
      state: "unavailable",
      code: "CODEX_RUNTIME_WRONG_ARCHITECTURE",
      source: "configured",
    });
  });
  test("rejects bounded PE and Mach-O architecture mismatches before execution", async () => {
    const pe = new Uint8Array(96);
    pe[0] = 0x4d;
    pe[1] = 0x5a;
    pe[0x3c] = 0x40;
    pe[0x40] = 0x50;
    pe[0x41] = 0x45;
    pe[0x44] = 0x64;
    pe[0x45] = 0x86;
    const macho = new Uint8Array([
      0xfe, 0xed, 0xfa, 0xcf, 0x01, 0x00, 0x00, 0x07,
    ]);
    for (const header of [pe, macho]) {
      const base = host(() => identity({ header }));
      const result = await new CodexRuntimeManager({
        ...base,
        arch: "arm64",
      }).resolveExternal({ configuredPath: "/configured/codex" });
      expect(result.code).toBe("CODEX_RUNTIME_WRONG_ARCHITECTURE");
    }
  });
  test("recognizes both host slices in a bounded universal Mach-O 64 header", async () => {
    const universal = new Uint8Array(72);
    universal.set([0xca, 0xfe, 0xba, 0xbf, 0, 0, 0, 2]);
    universal.set([0x01, 0, 0, 0x07], 8);
    universal.set([0x01, 0, 0, 0x0c], 40);

    for (const arch of ["x64", "arm64"] as const) {
      const base = host(() => identity({ header: universal }));
      const result = await new CodexRuntimeManager({
        ...base,
        arch,
      }).resolveExternal({ configuredPath: "/configured/codex" });
      expect(result.code).not.toBe("CODEX_RUNTIME_WRONG_ARCHITECTURE");
    }
  });
  test("does not use a name as standalone identity evidence", async () => {
    const result = await new CodexRuntimeManager(
      host(() => identity()),
    ).resolveExternal({ configuredPath: "/configured/codex-app-server" });
    expect(result.code).toBe("CODEX_RUNTIME_UNHEALTHY");
  });
  test("public failure never includes the configured path", async () => {
    const result = await new CodexRuntimeManager(
      host(() => null),
    ).resolveExternal({ configuredPath: "/secret/path/codex" });
    expect(JSON.stringify(result)).not.toContain("/secret/path");
  });
  test("returns the stable cancellation and non-executable codes before spawning", async () => {
    const controller = new AbortController();
    controller.abort();
    const cancelled = await new CodexRuntimeManager(
      host(() => identity()),
    ).resolveExternal({
      configuredPath: "/configured/codex",
      signal: controller.signal,
    });
    expect(cancelled.code).toBe("CODEX_RUNTIME_CANCELLED");
    const nonExecutable = await new CodexRuntimeManager(
      host(() => identity({ executable: false })),
    ).resolveExternal({ configuredPath: "/configured/codex" });
    expect(nonExecutable.code).toBe("CODEX_RUNTIME_NOT_EXECUTABLE");
    const oversized = await new CodexRuntimeManager(
      host(() => identity({ size: 512 * 1024 * 1024 + 1 })),
    ).resolveExternal({ configuredPath: "/configured/codex" });
    expect(oversized.code).toBe("CODEX_RUNTIME_EXECUTABLE_LIMIT");
    const invalidPath = await new CodexRuntimeManager(
      host(() => {
        throw new Error("must not resolve an invalid path");
      }),
    ).resolveExternal({ configuredPath: `/${"x".repeat(4_096)}` });
    expect(invalidPath.code).toBe("CODEX_RUNTIME_PATH_INVALID");
  });
  test("cancels while incrementally hashing executable chunks before any subprocess", async () => {
    const controller = new AbortController();
    let runs = 0;
    const base = host(() => identity());
    const result = await new CodexRuntimeManager({
      ...base,
      async *executableChunks() {
        yield new Uint8Array([1]);
        controller.abort();
        yield new Uint8Array([2]);
      },
      async run() {
        runs += 1;
        throw new Error("must not run");
      },
    }).resolveExternal({
      configuredPath: "/configured/codex",
      signal: controller.signal,
    });
    expect(result.code).toBe("CODEX_RUNTIME_CANCELLED");
    expect(runs).toBe(0);
  });
  test("cancels an active schema child, reaps it, then removes its private root", async () => {
    const controller = new AbortController();
    const fake = successHost();
    const ordinaryRun = fake.host.run.bind(fake.host);
    const ordinaryRemove = fake.host.removePrivateProbeRoot.bind(fake.host);
    let terminated = false;
    let reaped = false;
    let removedAfterReap = false;

    const result = await new CodexRuntimeManager({
      ...fake.host,
      async run(runtimeIdentity, argv, options) {
        if (
          argv[0] !== "app-server" ||
          argv[1] !== "generate-json-schema"
        )
          return ordinaryRun(runtimeIdentity, argv, options);

        const stdout = new PassThrough();
        let finish!: (
          value: Awaited<RuntimeProcess["result"]>,
        ) => void;
        const processResult = new Promise<Awaited<RuntimeProcess["result"]>>(
          (resolveResult) => {
            finish = resolveResult;
          },
        );
        queueMicrotask(() => controller.abort());
        return {
          stdout,
          stdin: new Writable({
            write(_chunk, _encoding, callback) {
              callback();
            },
          }),
          result: processResult,
          async terminate() {
            terminated = true;
            finish({
              code: null,
              timedOut: false,
              outputLimited: false,
              stdout: new Uint8Array(),
              stderr: new Uint8Array(),
            });
            await processResult;
            reaped = true;
            stdout.end();
          },
        };
      },
      async removePrivateProbeRoot(root) {
        await ordinaryRemove(root);
        if (root.endsWith("probe-2")) removedAfterReap = reaped;
      },
    }).resolveExternal({
      configuredPath: "/configured/codex",
      signal: controller.signal,
    });

    expect(result.code).toBe("CODEX_RUNTIME_CANCELLED");
    expect({ terminated, reaped, removedAfterReap }).toEqual({
      terminated: true,
      reaped: true,
      removedAfterReap: true,
    });
  });
  test("probes the full CLI through owned argv, private roots, and cached schemas", async () => {
    const fake = successHost();
    const manager = new CodexRuntimeManager(fake.host);
    const first = await manager.resolveExternal({
      configuredPath: "/configured/codex",
    });
    expect(first).toMatchObject({
      state: "ready",
      kind: "full_cli",
      version: "0.146.0",
      handle: "opaque-success",
    });
    expect(fake.calls.map((call) => call.argv)).toEqual([
      ["--version"],
      ["app-server", "--listen", "stdio://"],
      [
        "app-server",
        "generate-json-schema",
        "--out",
        "/private/probe-2/stable",
      ],
      [
        "app-server",
        "generate-json-schema",
        "--out",
        "/private/probe-2/experimental",
        "--experimental",
      ],
    ]);
    expect(
      fake.calls.every(
        (call) =>
          call.env.CODEX_HOME.endsWith("/home") &&
          call.env.TMPDIR.startsWith("/private/probe-") &&
          call.cwd.endsWith("/cwd"),
      ),
    ).toBe(true);
    expect(manager.inspect("opaque-success")).toEqual(first);
    await manager.resolveExternal({ configuredPath: "/configured/codex" });
    expect(fake.calls).toHaveLength(6);
  });
  test("re-probes launchers and never replaces a fresh stable fingerprint with cached provenance", async () => {
    const fake = successHost();
    const ordinaryList = fake.host.listSchemaFiles.bind(fake.host);
    let stableReads = 0;
    let handles = 0;
    const manager = new CodexRuntimeManager({
      ...fake.host,
      randomHandle: () => `opaque-launcher-${(handles += 1)}`,
      async resolve() {
        return identity({ header: new Uint8Array([0x23, 0x21]) });
      },
      async resolveOfficialLauncherTarget() {
        return identity();
      },
      async listSchemaFiles(root) {
        const files = await ordinaryList(root);
        if (!root.endsWith("/stable")) return files;
        stableReads += 1;
        return stableReads === 1
          ? files
          : [
              ...files,
              {
                relativePath: "additive-nautilo-test.json",
                bytes: new TextEncoder().encode('{"type":"object"}'),
              },
            ];
      },
    });

    const first = await manager.resolveExternal({
      configuredPath: "/configured/codex",
    });
    const second = await manager.resolveExternal({
      configuredPath: "/configured/codex",
    });
    expect(second.schemaFingerprint).toBe(first.schemaFingerprint);
    expect(second.stableSchemaFingerprint).not.toBe(
      first.stableSchemaFingerprint,
    );
    expect(fake.calls).toHaveLength(8);
  });
  test("activates the native binary behind an official launcher and revalidates both identities", async () => {
    const fake = successHost();
    const ordinaryRun = fake.host.run.bind(fake.host);
    const launcher = identity({
      canonicalPath: "/official/@openai/codex/bin/codex.js",
      header: new Uint8Array([0x23, 0x21]),
    });
    const native = identity({
      canonicalPath: "/official/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex",
      inode: 20,
    });
    const launched: string[] = [];
    let nativeChanged = false;
    const manager = new CodexRuntimeManager({
      ...fake.host,
      async resolve(candidate) {
        if (candidate === "/configured/codex" || candidate === launcher.canonicalPath)
          return launcher;
        if (candidate === native.canonicalPath)
          return nativeChanged ? { ...native, mtimeMs: 99 } : native;
        return null;
      },
      async resolveOfficialLauncherTarget() {
        return nativeChanged ? { ...native, mtimeMs: 99 } : native;
      },
      async *executableChunks(runtimeIdentity) {
        yield new TextEncoder().encode(runtimeIdentity.canonicalPath);
      },
      async run(runtimeIdentity, argv, options) {
        launched.push(runtimeIdentity.canonicalPath);
        return ordinaryRun(runtimeIdentity, argv, options);
      },
    });

    const result = await manager.resolveExternal({ configuredPath: "/configured/codex" });
    expect(result).toMatchObject({
      state: "ready",
      executableFingerprint: expect.stringMatching(/^sha256:/),
      launcherFingerprint: expect.stringMatching(/^sha256:/),
    });
    expect(launched.length).toBeGreaterThan(0);
    expect(launched.every((path) => path === native.canonicalPath)).toBeTrue();
    expect(manager.internalLaunchTarget(result.handle!)).toBe(native.canonicalPath);
    expect(await manager.revalidate(result.handle!)).toBeTrue();
    nativeChanged = true;
    expect(await manager.revalidate(result.handle!)).toBeFalse();
  });
  test("resolves the official npm package layout to its platform-native binary", async () => {
    if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch))
      return;
    const root = await mkdtemp(join(tmpdir(), "nautilo-official-codex-"));
    try {
      const packageRoot = join(root, "node_modules", "@openai", "codex");
      const platformPackage = process.arch === "arm64"
        ? "@openai/codex-darwin-arm64"
        : "@openai/codex-darwin-x64";
      const triple = process.arch === "arm64"
        ? "aarch64-apple-darwin"
        : "x86_64-apple-darwin";
      const platformRoot = join(packageRoot, "node_modules", ...platformPackage.split("/"));
      const launcherPath = join(packageRoot, "bin", "codex.js");
      const nativePath = join(platformRoot, "vendor", triple, "bin", "codex");
      await mkdir(join(packageRoot, "bin"), { recursive: true });
      await mkdir(join(platformRoot, "vendor", triple, "bin"), { recursive: true });
      await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "@openai/codex", version: "0.139.0" }));
      // This mirrors OpenAI's published optional package: its install path is
      // platform-specific while its own metadata retains the base package
      // name and appends the platform to the version.
      await writeFile(join(platformRoot, "package.json"), JSON.stringify({ name: "@openai/codex", version: "0.139.0-darwin-arm64" }));
      await writeFile(launcherPath, "#!/usr/bin/env node\n");
      await writeFile(nativePath, new Uint8Array([0xfe, 0xed, 0xfa, 0xcf, 0x01, 0, 0, process.arch === "arm64" ? 0x0c : 0x07]));
      await chmod(launcherPath, 0o755);
      await chmod(nativePath, 0o755);

      const runtimeHost = createNodeCodexRuntimeHost({ PATH: "" });
      const launcher = await runtimeHost.resolve(launcherPath);
      expect(launcher).not.toBeNull();
      const target = await runtimeHost.resolveOfficialLauncherTarget!(launcher!);
      expect(target?.canonicalPath).toBe(await realpath(nativePath));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("persists only a strict safe metadata snapshot with mode 0600", async () => {
    const directory = await mkdtemp(`${tmpdir()}/nautilo-codex-metadata-`);
    const file = `${directory}/runtime.json`;
    const store = new CodexRuntimeMetadataStore(file);
    await store.save({
      state: "ready",
      checkedAt: 7,
      source: "configured",
      kind: "full_cli",
      version: "0.139.0",
      compatibility: "compatible_uncertified",
      features: {
        stableConversation: true,
        explicitSteer: true,
        codexApprovals: true,
        requestUserInput: true,
        collaborationMode: true,
      },
      compatibilityDiagnostics: [{
        feature: "request_user_input",
        reason: "changed_field_shape",
      }],
      executableFingerprint: `sha256:${"a".repeat(64)}`,
      schemaFingerprint: `sha256:${"b".repeat(64)}`,
      stableSchemaFingerprint: `sha256:${"c".repeat(64)}`,
      handle: "secret-handle",
    });
    const serialized = await readFile(file, "utf8");
    expect(serialized).not.toContain("secret-handle");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await store.load()).toMatchObject({
      schemaVersion: 1,
      state: "ready",
      version: "0.139.0",
      compatibilityDiagnostics: [{
        feature: "request_user_input",
        reason: "changed_field_shape",
      }],
    });
    await writeFile(
      file,
      JSON.stringify({ schemaVersion: 2, checkedAt: 7, state: "ready" }),
    );
    expect(await store.load()).toBeNull();
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        checkedAt: 7,
        state: "ready",
        features: { stableConversation: "yes" },
      }),
    );
    expect(await store.load()).toBeNull();
  });
  test("maps version timeout, output overflow, and malformed wrappers to stable failures and cleans up", async () => {
    for (const [outcome, code] of [
      [{ timedOut: true }, "CODEX_RUNTIME_TIMEOUT"],
      [{ outputLimited: true }, "CODEX_RUNTIME_OUTPUT_LIMIT"],
      [{ stdout: "npm wrapper warning" }, "CODEX_RUNTIME_VERSION_INVALID"],
    ] as const) {
      const fake = versionOutcomeHost(outcome);
      const result = await new CodexRuntimeManager(fake.host).resolveExternal({
        configuredPath: "/path/codex",
      });
      expect(result.code).toBe(code);
      expect(fake.removed).toBe(1);
    }
  });
  test("fails closed when a manager-owned probe root cannot be removed", async () => {
    const fake = versionOutcomeHost({});
    const result = await new CodexRuntimeManager({
      ...fake.host,
      async removePrivateProbeRoot() {
        throw new Error("cleanup denied");
      },
    }).resolveExternal({ configuredPath: "/path/codex" });
    expect(result.code).toBe("CODEX_RUNTIME_UNHEALTHY");
  });
  test("enforces the 0.139.0 minimum and the reviewed known-bad seam", async () => {
    const old = versionOutcomeHost({ stdout: "codex-cli 0.0.0\n" });
    expect(
      (
        await new CodexRuntimeManager(old.host).resolveExternal({
          configuredPath: "/path/codex",
        })
      ).code,
    ).toBe("CODEX_RUNTIME_VERSION_INVALID");
    const denied = versionOutcomeHost({});
    expect(
      (
        await new CodexRuntimeManager(
          denied.host,
          undefined,
          new Set(["0.139.0"]),
        ).resolveExternal({ configuredPath: "/path/codex" })
      ).code,
    ).toBe("CODEX_RUNTIME_VERSION_INVALID");
  });
  test("auto discovery deduplicates canonical candidates and retains actionable failure after a miss", async () => {
    const candidates: string[] = [];
    const base = host((candidate) =>
      candidate === "/one/codex" || candidate === "/two/codex"
        ? identity()
        : null,
    );
    const result = await new CodexRuntimeManager({
      ...base,
      pathEntries: ["/missing", "/one", "/two"],
      conventionalPaths: [],
      async run() {
        candidates.push("run");
        throw new Error("missing platform child");
      },
    }).resolveExternal();
    expect(result.code).toBe("CODEX_RUNTIME_UNHEALTHY");
    expect(candidates).toHaveLength(1);
  });
  test("rejects an executable identity swap after the version subprocess before initialize", async () => {
    let resolves = 0;
    const fake = versionOutcomeHost({});
    const result = await new CodexRuntimeManager({
      ...fake.host,
      async resolve() {
        resolves += 1;
        return resolves >= 4 ? identity({ mtimeMs: 99 }) : identity();
      },
    }).resolveExternal({ configuredPath: "/path/codex" });
    expect(result.code).toBe("CODEX_RUNTIME_IDENTITY_CHANGED");
    expect(fake.removed).toBe(1);
  });
});
