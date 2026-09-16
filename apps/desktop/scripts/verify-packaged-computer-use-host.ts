#!/usr/bin/env bun
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { createManagedComputerUseHostRuntime } from "../electron/computer-use-host-runtime/managed-runtime.ts";

const BOOTSTRAP_DEADLINE_MS = 60_000;

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
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(() => deadline.abort(new Error("packaged Host bootstrap deadline exceeded")), BOOTSTRAP_DEADLINE_MS);
  deadlineTimer.unref();
  try {
    process.stdout.write("[verify-packaged-computer-use-host] stage=bootstrap-start\n");
    const runtime = createManagedComputerUseHostRuntime({
      resourceDirectory,
      runtimeRoot: join(proofRoot, "runtime"),
      desktopExecutable,
      ...(process.getuid === undefined ? {} : { expectedUid: process.getuid() }),
      fetcher: () => Promise.resolve(new Response(null, { status: 503 })),
    });
    const state = await runtime.bootstrap(deadline.signal);
    if (deadline.signal.aborted) throw new Error(`packaged Computer Use Host bootstrap exceeded ${BOOTSTRAP_DEADLINE_MS}ms`);
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
    clearTimeout(deadlineTimer);
    await rm(proofRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`[verify-packaged-computer-use-host] FATAL ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
