import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchIsInManagedStorage, reportBootstrapProbes, withBootstrapDeadline } from "../../scripts/verify-packaged-computer-use-host.ts";

describe("packaged Computer Use Host verifier", () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

  test("deadline rejects work that ignores cancellation", async () => {
    let observed: AbortSignal | undefined;
    const failure = await withBootstrapDeadline((signal) => {
      observed = signal;
      return new Promise(() => {});
    }, 20).catch((error: unknown) => error);
    expect(failure).toEqual(new Error("packaged Computer Use Host bootstrap exceeded 20ms"));
    expect(observed?.aborted).toBeTrue();
  });

  test("deadline preserves successful results and original failures", async () => {
    expect(await withBootstrapDeadline(async () => "ready")).toBe("ready");
    const failure = await withBootstrapDeadline(async () => { throw new Error("rejected signature"); })
      .catch((error: unknown) => error);
    expect(failure).toEqual(new Error("rejected signature"));
  });

  test("probe diagnostics identify stages without disclosing native paths or output", async () => {
    const messages: string[] = [];
    const runner = reportBootstrapProbes(async () => ({ code: 0, stdout: "private output", stderr: "private diagnostic" }), (message) => messages.push(message));
    await runner("/usr/bin/codesign", ["--verify", "/private/example/host"]);
    await runner("/usr/bin/codesign", ["-dv", "/private/example/host"]);
    await runner("/usr/bin/codesign", ["-dr", "-", "/private/example/host"]);
    await runner("/usr/bin/lipo", ["-archs", "/private/example/host"]);
    await runner("/private/example/host", ["--health"]);
    expect(messages.filter((message) => message.startsWith("stage=probe-start"))).toEqual([
      "stage=probe-start probe=1 operation=signature-verify",
      "stage=probe-start probe=2 operation=signature-identity",
      "stage=probe-start probe=3 operation=signature-requirement",
      "stage=probe-start probe=4 operation=architectures",
      "stage=probe-start probe=5 operation=host-health",
    ]);
    expect(messages.every((message) => !message.includes("private"))).toBeTrue();
    expect(messages.filter((message) => message.includes("elapsedMs=")).length).toBe(5);
  });

  test("probe diagnostics expose cancellation and sanitize thrown errors", async () => {
    const messages: string[] = [];
    const runner = reportBootstrapProbes(async (_executable, _args, signal) => await new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("private path and output")), { once: true });
    }), (message) => messages.push(message));
    const controller = new AbortController();
    const pending = runner("/private/example/host", ["--health"], controller.signal);
    controller.abort();
    expect(await pending.catch((error: unknown) => error)).toEqual(new Error("packaged Host probe 1 (host-health) failed"));
    expect(messages).toContain("stage=probe-abort probe=1 operation=host-health");
    expect(messages.some((message) => message.startsWith("stage=probe-failed"))).toBeTrue();
    expect(messages.every((message) => !message.includes("private"))).toBeTrue();
  });

  test("accepts a canonical managed release reached through an aliased parent path", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-packaged-host-path-")); roots.push(root);
    const actual = join(root, "actual");
    const alias = join(root, "alias");
    const runtimeRoot = join(actual, "runtime");
    const resourceDirectory = join(actual, "bundle");
    const entrypoint = join(runtimeRoot, "releases", `sha256-${"a".repeat(64)}`, "nautilo-computer-use-host");
    await mkdir(join(entrypoint, ".."), { recursive: true });
    await mkdir(resourceDirectory, { recursive: true });
    await writeFile(entrypoint, "host");
    await symlink(actual, alias);

    expect(await launchIsInManagedStorage({
      runtimeRoot: join(alias, "runtime"),
      resourceDirectory: join(alias, "bundle"),
      entrypoint,
    })).toBeTrue();
  });

  test("rejects the mutable bundled entrypoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-packaged-host-bundle-")); roots.push(root);
    const runtimeRoot = join(root, "runtime");
    const resourceDirectory = join(root, "bundle");
    const entrypoint = join(resourceDirectory, "nautilo-computer-use-host");
    await mkdir(runtimeRoot, { recursive: true });
    await mkdir(resourceDirectory, { recursive: true });
    await writeFile(entrypoint, "host");

    expect(await launchIsInManagedStorage({ runtimeRoot, resourceDirectory, entrypoint })).toBeFalse();
  });
});
