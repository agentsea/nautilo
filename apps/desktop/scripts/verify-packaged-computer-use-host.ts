#!/usr/bin/env bun
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { createManagedComputerUseHostRuntime } from "../electron/computer-use-host-runtime/managed-runtime.ts";
import { runMacosComputerUseHostCommand, type MacosCommandRunner } from "../electron/computer-use-host-runtime/macos-attestor.ts";

const BOOTSTRAP_DEADLINE_MS = 60_000;

export async function withBootstrapDeadline<T>(work: (signal: AbortSignal) => Promise<T>, milliseconds = BOOTSTRAP_DEADLINE_MS): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`packaged Computer Use Host bootstrap exceeded ${milliseconds}ms`);
      controller.abort(error);
      reject(error);
    }, milliseconds);
  });
  try {
    const value = await Promise.race([work(controller.signal), expired]);
    controller.signal.throwIfAborted();
    return value;
  } finally { clearTimeout(timer); }
}

/** No executable paths, native diagnostics, or signed payloads enter CI logs. */
export function reportBootstrapProbes(runner: MacosCommandRunner, report: (message: string) => void): MacosCommandRunner {
  let sequence = 0;
  return async (executable, args, signal) => {
    const probe = ++sequence;
    const operation = executable === "/usr/bin/codesign"
      ? args[0] === "--verify" ? "signature-verify" : args[0] === "-dv" ? "signature-identity" : "signature-requirement"
      : executable === "/usr/bin/lipo" ? "architectures" : "host-health";
    const started = performance.now();
    const abort = () => report(`stage=probe-abort probe=${probe} operation=${operation}`);
    report(`stage=probe-start probe=${probe} operation=${operation}`);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const result = await runner(executable, args, signal);
      report(`stage=probe-complete probe=${probe} operation=${operation} code=${result.code} elapsedMs=${Math.round(performance.now() - started)}`);
      return result;
    } catch {
      report(`stage=probe-failed probe=${probe} operation=${operation} elapsedMs=${Math.round(performance.now() - started)}`);
      throw new Error(`packaged Host probe ${probe} (${operation}) failed`);
    } finally { signal?.removeEventListener("abort", abort); }
  };
}

export async function launchIsInManagedStorage(options: Readonly<{
  runtimeRoot: string;
  resourceDirectory: string;
  entrypoint: string;
}>): Promise<boolean> {
  const canonicalRuntimeRoot = await realpath(options.runtimeRoot);
  const canonicalResourceDirectory = await realpath(options.resourceDirectory);
  const canonicalEntrypoint = await realpath(options.entrypoint);
  return canonicalEntrypoint.startsWith(`${canonicalRuntimeRoot}${sep}releases${sep}sha256-`)
    && !canonicalEntrypoint.startsWith(`${canonicalResourceDirectory}${sep}`);
}

async function main(argv = process.argv): Promise<void> {
  const bundlePath = argv[2] ? resolve(argv[2]) : "";
  if (!bundlePath.endsWith(".app")) throw new Error("signed macOS app bundle path is required");
  const resourceDirectory = join(bundlePath, "Contents", "Resources", "tools-computer-use-host");
  const desktopExecutable = join(bundlePath, "Contents", "MacOS", "Nautilo");
  const manifest = JSON.parse(await readFile(join(resourceDirectory, "manifest.json"), "utf8")) as { version?: unknown };
  const proofRoot = await mkdtemp(join(tmpdir(), "nautilo-packaged-host-proof-"));
  try {
    process.stdout.write("[verify-packaged-computer-use-host] stage=bootstrap-start\n");
    const runtime = createManagedComputerUseHostRuntime({
      resourceDirectory,
      runtimeRoot: join(proofRoot, "runtime"),
      desktopExecutable,
      ...(process.getuid === undefined ? {} : { expectedUid: process.getuid() }),
      fetcher: () => Promise.resolve(new Response(null, { status: 503 })),
      commandRunner: reportBootstrapProbes(runMacosComputerUseHostCommand,
        (message) => process.stdout.write(`[verify-packaged-computer-use-host] ${message}\n`)),
    });
    const state = await withBootstrapDeadline((signal) => runtime.bootstrap(signal));
    process.stdout.write(`[verify-packaged-computer-use-host] stage=bootstrap-complete state=${state.state}\n`);
    if (state.state !== "ready" || state.source !== "bundled" || state.generation !== 1
      || state.release.version !== manifest.version || state.remoteUpdateFailure !== "host_pointer_untrusted") {
      throw new Error(`packaged Computer Use Host bootstrap rejected: ${JSON.stringify(state)}`);
    }
    const launch = runtime.acquireLaunch();
    if (launch === null) throw new Error("packaged Computer Use Host launch lease missing");
    if (!(await launchIsInManagedStorage({
      runtimeRoot: join(proofRoot, "runtime"),
      resourceDirectory,
      entrypoint: launch.entrypoint,
    }))) {
      launch.lease.release();
      throw new Error("packaged Computer Use Host launch escaped managed immutable storage");
    }
    launch.lease.release();
    process.stdout.write(`[verify-packaged-computer-use-host] version=${state.release.version} source=bundled generation=1 offlineFallback=passed\n`);
  } finally {
    await rm(proofRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`[verify-packaged-computer-use-host] FATAL ${error instanceof Error ? error.message : String(error)}`);
    // A failed qualification must not remain alive on an uncooperative probe.
    process.exit(1);
  });
}
