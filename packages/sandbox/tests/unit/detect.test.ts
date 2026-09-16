/**
 * Unit tests for backend detection. D060 Phase 1 task 1.3.
 *
 * Mock the prober to exercise each branch without shelling out to a
 * real bwrap/sandbox-exec. The production `detectBackend()` wraps
 * the real child_process; `detectBackendCore()` is the pure logic
 * we test here.
 */

import { describe, expect, test } from "bun:test";
import { detectBackendCore, type Prober } from "../../src/detect";

type ProbeResp = { exitCode: number; stderr?: string };
type ProbeMap = Record<string, ProbeResp>;

/**
 * Build a prober that returns canned responses per `binary args…`
 * tuple. Unmatched probes throw so tests fail loudly on unexpected
 * shell-outs.
 */
function stubProber(map: ProbeMap): Prober {
  return (binary, args) => {
    const key = `${binary} ${args.join(" ")}`;
    const resp = map[key];
    if (!resp) {
      throw new Error(`stubProber: unexpected probe for "${key}"`);
    }
    return Promise.resolve({ exitCode: resp.exitCode, stderr: resp.stderr ?? "" });
  };
}

describe("detectBackendCore", () => {
  describe("linux", () => {
    test("no bwrap → {none}", async () => {
      const prober = stubProber({
        "bwrap --version": { exitCode: 127, stderr: "bwrap: command not found" },
      });
      expect(await detectBackendCore("linux", prober)).toEqual({ kind: "none" });
    });

    test("bwrap present + /proc mountable → {bubblewrap, procSupported: true}", async () => {
      const prober = stubProber({
        "bwrap --version": { exitCode: 0, stderr: "" },
        "bwrap --proc /proc --ro-bind /bin /bin -- true": { exitCode: 0, stderr: "" },
        "bwrap --ro-bind /usr /usr --ro-bind /usr/bin/true /usr/bin/false -- /usr/bin/false": {
          exitCode: 0,
          stderr: "",
        },
      });
      expect(await detectBackendCore("linux", prober)).toEqual({
        kind: "bubblewrap",
        procSupported: true,
        fileMaskSupported: true,
      });
    });

    test("bwrap present + /proc NOT mountable → {bubblewrap, procSupported: false}", async () => {
      // Nested-Docker scenario: bwrap exists but the container's
      // /proc isn't mountable inside bwrap. Builder in 1.5 will
      // skip `--proc /proc`.
      const prober = stubProber({
        "bwrap --version": { exitCode: 0, stderr: "" },
        "bwrap --proc /proc --ro-bind /bin /bin -- true": {
          exitCode: 1,
          stderr: "bwrap: Can't mount proc: Operation not permitted",
        },
        "bwrap --ro-bind /usr /usr --ro-bind /usr/bin/true /usr/bin/false -- /usr/bin/false": {
          exitCode: 1,
          stderr: "bwrap: file overmount unsupported",
        },
      });
      expect(await detectBackendCore("linux", prober)).toEqual({
        kind: "bubblewrap",
        procSupported: false,
        fileMaskSupported: false,
      });
    });
  });

  describe("darwin", () => {
    test("sandbox-exec present → {sandbox-exec}", async () => {
      const prober = stubProber({
        "/usr/bin/sandbox-exec -p (version 1)\n(allow default) /usr/bin/true": {
          exitCode: 0,
          stderr: "",
        },
      });
      expect(await detectBackendCore("darwin", prober)).toEqual({ kind: "sandbox-exec" });
    });

    test("sandbox-exec missing (unusual but handled) → {none}", async () => {
      const prober = stubProber({
        "/usr/bin/sandbox-exec -p (version 1)\n(allow default) /usr/bin/true": {
          exitCode: 127,
          stderr: "not found",
        },
      });
      expect(await detectBackendCore("darwin", prober)).toEqual({ kind: "none" });
    });
  });

  describe("other platforms", () => {
    test("win32 → {none} without probing", async () => {
      // Unused-probe safety: the stub throws on unexpected keys, so
      // reaching THIS passthrough without throwing proves no probe
      // happened.
      const prober = stubProber({});
      expect(await detectBackendCore("win32", prober)).toEqual({ kind: "none" });
    });

    test("freebsd → {none}", async () => {
      const prober = stubProber({});
      expect(await detectBackendCore("freebsd", prober)).toEqual({ kind: "none" });
    });
  });
});
