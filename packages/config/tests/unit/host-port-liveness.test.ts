import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  bundlePassesHostTcpBindProbeSync,
  setHostPortLivenessProbeExecutableForProcess,
} from "../../src/host-port-liveness";

const roots: string[] = [];
afterEach(() => {
  setHostPortLivenessProbeExecutableForProcess(undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("host-port-liveness (2A.3)", () => {
  test("bundlePassesHostTcpBindProbeSync rejects wrong arity", () => {
    expect(() => bundlePassesHostTcpBindProbeSync([])).toThrow(/exactly six/);
    expect(() => bundlePassesHostTcpBindProbeSync([1, 2, 3])).toThrow(/exactly six/);
  });

  test("accepts only an absolute regular native probe override and resets after use", () => {
    const root = mkdtempSync(join(tmpdir(), "nautilo-host-probe-"));
    roots.push(root);
    // Both fixtures return zero without binding ports; the default CJS probe
    // remains responsible for real TCP availability checks.
    const probe = process.platform === "win32" ? process.execPath : join(root, "probe.cjs");
    const link = join(root, "probe-link.cjs");
    if (process.platform === "win32") {
      symlinkSync(dirname(probe), link, "junction");
    } else {
      writeFileSync(probe, "#!/bin/sh\ncat >/dev/null\nexit 0\n", { mode: 0o755 });
      chmodSync(probe, 0o755);
      symlinkSync(probe, link);
    }

    expect(() => setHostPortLivenessProbeExecutableForProcess("relative/probe")).toThrow(
      /absolute path/,
    );
    expect(() => setHostPortLivenessProbeExecutableForProcess(join(root, "missing"))).toThrow(
      /Missing host port probe/,
    );
    expect(() => setHostPortLivenessProbeExecutableForProcess(link)).toThrow(
      /regular non-symlink/,
    );
    if (process.platform !== "win32") {
      chmodSync(probe, 0o644);
      expect(() => setHostPortLivenessProbeExecutableForProcess(probe)).toThrow(/must be executable/);
      chmodSync(probe, 0o755);
    }

    setHostPortLivenessProbeExecutableForProcess(probe);
    expect(bundlePassesHostTcpBindProbeSync([45101, 45102, 45103, 45104, 45105, 45106])).toBe(
      true,
    );
  });
});
