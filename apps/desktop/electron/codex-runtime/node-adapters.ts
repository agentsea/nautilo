import { randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import type { CodexRuntimeHost, RuntimeProcess } from "./contracts.ts";

const FILE_LIMIT = 4_096;
const DIRECTORY_LIMIT = 4_096;
const DEPTH_LIMIT = 128;
const FILE_BYTES = 8 * 1024 * 1024;
const TOTAL_BYTES = 32 * 1024 * 1024;
const PACKAGE_JSON_BYTES = 64 * 1024;

const OFFICIAL_CODEX_TARGETS: Partial<
  Record<NodeJS.Platform, Partial<Record<string, readonly [packageName: string, triple: string]>>>
> = {
  darwin: {
    arm64: ["@openai/codex-darwin-arm64", "aarch64-apple-darwin"],
    x64: ["@openai/codex-darwin-x64", "x86_64-apple-darwin"],
  },
  linux: {
    arm64: ["@openai/codex-linux-arm64", "aarch64-unknown-linux-musl"],
    x64: ["@openai/codex-linux-x64", "x86_64-unknown-linux-musl"],
  },
  win32: {
    arm64: ["@openai/codex-win32-arm64", "aarch64-pc-windows-msvc"],
    x64: ["@openai/codex-win32-x64", "x86_64-pc-windows-msvc"],
  },
};

async function readPackageMetadata(
  path: string,
): Promise<{ readonly name: string; readonly version: string } | null> {
  try {
    const canonicalPath = await realpath(path);
    const info = await lstat(canonicalPath);
    if (!info.isFile() || info.size <= 0 || info.size > PACKAGE_JSON_BYTES)
      return null;
    const parsed: unknown = JSON.parse(await readFile(canonicalPath, "utf8"));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as Record<string, unknown>)["name"] !== "string" ||
      typeof (parsed as Record<string, unknown>)["version"] !== "string"
    )
      return null;
    return {
      name: (parsed as Record<string, string>)["name"]!,
      version: (parsed as Record<string, string>)["version"]!,
    };
  } catch {
    return null;
  }
}

export function createNodeCodexRuntimeHost(
  environment: NodeJS.ProcessEnv = process.env,
): CodexRuntimeHost {
  const created = new Set<string>();
  const privateParent = realpath(tmpdir()).catch(() => tmpdir());
  const pathEntries = (environment["PATH"] ?? "")
    .split(process.platform === "win32" ? ";" : ":")
    .filter(Boolean);
  const home = homedir();
  const probeEnv = Object.freeze(
    Object.fromEntries(
      ["PATH", "TMPDIR", "TEMP", "TMP", "SystemRoot", "PATHEXT"].flatMap(
        (name) => {
          const value = environment[name];
          return value === undefined ? [] : [[name, value]];
        },
      ),
    ),
  );
  const conventionalPaths =
    process.platform === "darwin"
      ? [
          join(home, ".local", "bin", "codex"),
          join(home, ".npm-global", "bin", "codex"),
          "/opt/homebrew/bin/codex",
          "/usr/local/bin/codex",
        ]
      : process.platform === "linux"
        ? [
            join(home, ".local", "bin", "codex"),
            join(home, ".npm", "bin", "codex"),
            "/usr/local/bin/codex",
            "/usr/bin/codex",
          ]
        : [];
  const resolveIdentity = async (
    candidate: string,
  ): Promise<import("./contracts.ts").RuntimeFileIdentity | null> => {
    try {
      const canonicalPath = await realpath(candidate);
      const info = await lstat(canonicalPath);
      if (!info.isFile()) return null;
      const file = await open(canonicalPath, "r");
      try {
        const header = new Uint8Array(Math.min(4_096, info.size));
        await file.read(header, 0, header.length, 0);
        return {
          canonicalPath,
          device: info.dev,
          inode: info.ino,
          size: info.size,
          mtimeMs: info.mtimeMs,
          executable: (info.mode & 0o111) !== 0,
          regular: true,
          header,
        };
      } finally {
        await file.close();
      }
    } catch {
      return null;
    }
  };
  return {
    platform: process.platform,
    arch: process.arch,
    pathEntries,
    conventionalPaths,
    probeEnv,
    resolve: resolveIdentity,
    async resolveOfficialLauncherTarget(launcher) {
      if (
        basename(launcher.canonicalPath) !== "codex.js" ||
        basename(dirname(launcher.canonicalPath)) !== "bin"
      )
        return null;
      const packageRoot = dirname(dirname(launcher.canonicalPath));
      const packageMetadata = await readPackageMetadata(join(packageRoot, "package.json"));
      if (packageMetadata?.name !== "@openai/codex" || !packageMetadata.version)
        return null;
      const target = OFFICIAL_CODEX_TARGETS[process.platform]?.[process.arch];
      if (!target) return null;
      const [platformPackage, triple] = target;
      const packageSegments = platformPackage.split("/");
      const packageRoots: string[] = [];
      let cursor = packageRoot;
      for (let depth = 0; depth < 8; depth += 1) {
        packageRoots.push(join(cursor, "node_modules", ...packageSegments));
        const parent = dirname(cursor);
        if (parent === cursor) break;
        cursor = parent;
      }
      for (const platformRoot of packageRoots) {
        const metadata = await readPackageMetadata(join(platformRoot, "package.json"));
        const platformVersion = `${packageMetadata.version}-${platformPackage.slice("@openai/codex-".length)}`;
        if (
          !metadata ||
          ![platformPackage, "@openai/codex"].includes(metadata.name) ||
          ![packageMetadata.version, platformVersion].includes(metadata.version)
        )
          continue;
        const native = await resolveIdentity(
          join(platformRoot, "vendor", triple, "bin", process.platform === "win32" ? "codex.exe" : "codex"),
        );
        if (native) return native;
      }
      // Matches the official launcher's fallback for package layouts that
      // vendor the platform binary inside @openai/codex itself.
      return resolveIdentity(
        join(packageRoot, "vendor", triple, "bin", process.platform === "win32" ? "codex.exe" : "codex"),
      );
    },
    async *executableChunks(identity) {
      const file = await open(identity.canonicalPath, "r");
      try {
        const chunk = new Uint8Array(1024 * 1024);
        for (;;) {
          const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
          if (!bytesRead) return;
          yield chunk.slice(0, bytesRead);
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      } finally {
        await file.close();
      }
    },
    run(identity, argv, options) {
      if (
        process.platform === "win32" &&
        identity.canonicalPath.toLowerCase().endsWith(".cmd")
      )
        throw new Error("unsupported_wrapper");
      const child = spawn(identity.canonicalPath, [...argv], {
        cwd: options.cwd,
        env: { ...options.env },
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout = new PassThrough();
      const stdin = child.stdin;
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outputLimited = false;
      let timedOut = false;
      let settled = false;
      let capturedBytes = 0;
      const kill = (signal: NodeJS.Signals) => {
        try {
          if (process.platform !== "win32" && child.pid)
            process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch {
          try {
            child.kill(signal);
          } catch {
            /* Child already exited. */
          }
        }
      };
      const terminate = async (graceMs: number) => {
        if (settled) return;
        kill("SIGTERM");
        await new Promise((resolve) => setTimeout(resolve, graceMs));
        if (!settled) kill("SIGKILL");
      };
      const capture =
        (target: Buffer[]) =>
        (chunk: Buffer): boolean => {
          const bytes = Buffer.from(chunk);
          if (capturedBytes + bytes.length > options.maxOutputBytes) {
            outputLimited = true;
            void terminate(0);
            return false;
          }
          capturedBytes += bytes.length;
          target.push(bytes);
          return true;
        };
      child.stdout.on("data", (chunk: Buffer) => {
        if (capture(out)(chunk)) stdout.write(chunk);
      });
      child.stderr.on("data", capture(err));
      const timer = setTimeout(() => {
        timedOut = true;
        void terminate(100);
      }, options.timeoutMs);
      const result = new Promise<import("./contracts.ts").RuntimeProcessResult>(
        (resolve) => {
          const finish = (code: number | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            stdout.end();
            resolve({
              code,
              timedOut,
              outputLimited,
              stdout: new Uint8Array(Buffer.concat(out)),
              stderr: new Uint8Array(Buffer.concat(err)),
            });
          };
          child.once("close", finish);
          child.once("error", () => finish(null));
        },
      );
      return Promise.resolve({
        stdout,
        stdin,
        result,
        terminate,
      } as RuntimeProcess);
    },
    async createPrivateProbeRoot() {
      const root = await mkdtemp(
        join(await privateParent, "nautilo-codex-probe-"),
      );
      await chmod(root, 0o700);
      await mkdir(join(root, "home"), { mode: 0o700 });
      await mkdir(join(root, "cwd"), { mode: 0o700 });
      created.add(await realpath(root));
      return root;
    },
    async listSchemaFiles(root) {
      const actual = await realpath(root);
      if (
        ![...created].some(
          (parent) => actual === parent || actual.startsWith(`${parent}/`),
        )
      )
        throw new Error("unowned_schema_root");
      const files: Array<{ relativePath: string; bytes: Uint8Array }> = [];
      let total = 0;
      let directories = 1;
      const walk = async (directory: string, depth: number): Promise<void> => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const full = join(directory, entry.name);
          if (
            entry.isSymbolicLink() ||
            (!entry.isDirectory() && !entry.isFile())
          )
            throw new Error("unsafe_schema_file");
          if (entry.isDirectory()) {
            directories += 1;
            if (directories > DIRECTORY_LIMIT || depth >= DEPTH_LIMIT)
              throw new Error("schema_directory_limit");
            await walk(full, depth + 1);
          }
          else {
            if (files.length >= FILE_LIMIT)
              throw new Error("schema_file_limit");
            const before = await lstat(full);
            if (!before.isFile() || before.size > FILE_BYTES)
              throw new Error("schema_size_limit");
            const bytes = await readFile(full);
            const after = await lstat(full);
            if (
              !after.isFile() ||
              after.dev !== before.dev ||
              after.ino !== before.ino ||
              after.size !== bytes.byteLength ||
              bytes.byteLength > FILE_BYTES ||
              (total += bytes.byteLength) > TOTAL_BYTES
            )
              throw new Error("schema_size_limit");
            files.push({
              relativePath: relative(actual, full).replaceAll("\\", "/"),
              bytes,
            });
          }
        }
      };
      await walk(actual, 0);
      if (!files.length) throw new Error("empty_schema_output");
      return files;
    },
    async removePrivateProbeRoot(root) {
      let actual: string;
      try {
        actual = await realpath(root);
      } catch {
        return;
      }
      if (!created.delete(actual)) throw new Error("unowned_cleanup");
      await rm(actual, { recursive: true, force: true });
    },
    now: () => Date.now(),
    randomHandle: () => randomBytes(24).toString("base64url"),
  };
}
