import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bundlePassesHostTcpBindProbeSync,
  setHostPortLivenessProbeExecutableForProcess,
} from "../../src/host-port-liveness";

afterEach(() => {
  setHostPortLivenessProbeExecutableForProcess(undefined);
});

describe("host-port-liveness (2A.3)", () => {
  test("bundlePassesHostTcpBindProbeSync rejects wrong arity", () => {
    expect(() => bundlePassesHostTcpBindProbeSync([])).toThrow(/exactly six/);
    expect(() => bundlePassesHostTcpBindProbeSync([1, 2, 3])).toThrow(/exactly six/);
  });

  test("accepts only an absolute regular native probe override and resets after use", () => {
    const root = mkdtempSync(join(tmpdir(), "nautilo-host-probe-"));
    const probe = join(root, "probe.cjs");
    const link = join(root, "probe-link.cjs");
    writeFileSync(probe, "#!/bin/sh\ncat >/dev/null\nexit 0\n", { mode: 0o755 });
    chmodSync(probe, 0o755);
    symlinkSync(probe, link);

    expect(() => setHostPortLivenessProbeExecutableForProcess("relative/probe")).toThrow(
      /absolute path/,
    );
    expect(() => setHostPortLivenessProbeExecutableForProcess(join(root, "missing"))).toThrow(
      /Missing host port probe/,
    );
    expect(() => setHostPortLivenessProbeExecutableForProcess(link)).toThrow(
      /regular non-symlink/,
    );
    chmodSync(probe, 0o644);
    expect(() => setHostPortLivenessProbeExecutableForProcess(probe)).toThrow(/must be executable/);
    chmodSync(probe, 0o755);

    setHostPortLivenessProbeExecutableForProcess(probe);
    expect(bundlePassesHostTcpBindProbeSync([45101, 45102, 45103, 45104, 45105, 45106])).toBe(
      true,
    );
  });
});
