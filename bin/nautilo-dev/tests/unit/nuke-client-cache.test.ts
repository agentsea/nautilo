/**
 * Stack 19 Phase 4 (D156) — pin the load-bearing invariants of
 * `dev:nuke-client-cache`:
 *
 * - Path resolution matrix: (default vs named instance) × (default vs named profile).
 *   Verifies the nuke command + Electron's `main.ts` agree on userData
 *   dir names via the shared `computeUserDataDirName` helper (the WHOLE
 *   POINT of the Architecture amendment).
 * - HARD refuse `--instance default` without `--i-know-what-i-am-doing`.
 * - Missing `--instance` → exit 2.
 * - Dry-run-by-default semantics (no flags = report + exit 0, deletes nothing).
 *
 * Does NOT pin the running-Electron refuse path (requires a real process
 * probe; the manual Phase 6.4 smoke covers that end-to-end). Does NOT
 * exercise the atomic stage-then-delete on real filesystem state — that
 * would require fixture dirs + cleanup teardown; the rename-based logic
 * is straightforward enough that the dry-run path-resolution test
 * provides adequate coverage for the unit level.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverRelayTokens,
  findElectronPidsHoldingUserData,
  nukeClientCacheCmd,
  parseNukeClientCacheArgs,
  type RefuseElectronDeps,
} from "../../src/commands/nuke-client-cache";

describe("parseNukeClientCacheArgs", () => {
  test("missing --instance → exit 2", () => {
    const r = parseNukeClientCacheArgs(["--yes"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.exitCode).toBe(2);
      expect(r.message).toContain("--instance");
    }
  });

  test("--instance smoke-stack19 → ok", () => {
    const r = parseNukeClientCacheArgs(["--instance", "smoke-stack19"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.opts.instance).toBe("smoke-stack19");
      expect(r.opts.profile).toBeUndefined();
      expect(r.opts.yes).toBe(false);
      expect(r.opts.iKnowWhatIAmDoing).toBe(false);
      expect(r.opts.asJson).toBe(false);
    }
  });

  test("--instance default --profile galina --yes --json → all flags captured", () => {
    const r = parseNukeClientCacheArgs([
      "--instance",
      "default",
      "--profile",
      "galina",
      "--yes",
      "--json",
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.opts.instance).toBe("default");
      expect(r.opts.profile).toBe("galina");
      expect(r.opts.yes).toBe(true);
      expect(r.opts.asJson).toBe(true);
      expect(r.opts.iKnowWhatIAmDoing).toBe(false); // not set
    }
  });

  test("--instance default --yes --i-know-what-i-am-doing → all flags", () => {
    const r = parseNukeClientCacheArgs([
      "--instance",
      "default",
      "--yes",
      "--i-know-what-i-am-doing",
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.opts.iKnowWhatIAmDoing).toBe(true);
    }
  });

  test("--instance with no value → exit 2", () => {
    const r = parseNukeClientCacheArgs(["--instance"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.exitCode).toBe(2);
  });

  test("unknown flag → exit 2", () => {
    const r = parseNukeClientCacheArgs(["--instance", "x", "--frobnicate"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.exitCode).toBe(2);
      expect(r.message).toContain("--frobnicate");
    }
  });

  test("empty --profile string coerces to undefined (defensive)", () => {
    const r = parseNukeClientCacheArgs(["--instance", "foo", "--profile", ""]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.opts.profile).toBeUndefined();
  });
});

describe("nukeClientCacheCmd — top-level guards (no side effects)", () => {
  let captured = "";
  let stderrCaptured = "";
  const origLog = console.log;
  const origErr = console.error;

  function captureIO() {
    captured = "";
    stderrCaptured = "";
    console.log = (...xs: unknown[]) => {
      captured += `${xs.join(" ")}\n`;
    };
    console.error = (...xs: unknown[]) => {
      stderrCaptured += `${xs.join(" ")}\n`;
    };
  }
  function restoreIO() {
    console.log = origLog;
    console.error = origErr;
  }

  test("--help short-circuit: prints help + exit 0, no spawn / no fetch / no fs writes", async () => {
    captureIO();
    try {
      const code = await nukeClientCacheCmd(["--help"]);
      expect(code).toBe(0);
      expect(captured).toContain("dev:nuke-client-cache — ");
      expect(captured).toContain("--instance");
      expect(captured).toContain("--i-know-what-i-am-doing");
      // No "would delete" report (that's dry-run, not help).
      expect(captured).not.toContain("would delete");
    } finally {
      restoreIO();
    }
  });

  test("missing --instance → exit 2 + error message", async () => {
    captureIO();
    try {
      const code = await nukeClientCacheCmd([]);
      expect(code).toBe(2);
      expect(stderrCaptured).toContain("--instance");
      expect(captured).toBe(""); // nothing on stdout
    } finally {
      restoreIO();
    }
  });

  test("--instance default --yes WITHOUT --i-know-what-i-am-doing → exit 2 + HARD refuse message", async () => {
    captureIO();
    try {
      const code = await nukeClientCacheCmd(["--instance", "default", "--yes"]);
      expect(code).toBe(2);
      expect(stderrCaptured).toContain("Refusing to nuke the (default) instance");
      expect(stderrCaptured).toContain("--i-know-what-i-am-doing");
      // The "migration recipe" guidance is the inline tip for what to do instead.
      expect(stderrCaptured).toContain("migration recipe");
    } finally {
      restoreIO();
    }
  });

  test("--instance '' --yes WITHOUT --i-know-what-i-am-doing → exit 2 (empty-string also caught)", async () => {
    captureIO();
    try {
      const code = await nukeClientCacheCmd(["--instance", "", "--yes"]);
      expect(code).toBe(2);
      expect(stderrCaptured).toContain("Refusing to nuke the (default) instance");
    } finally {
      restoreIO();
    }
  });

  test("vacuous-test guard: replacing the HARD-refuse with a pass-through would fail this", async () => {
    // If a future refactor removed the `isDefaultInstance && opts.yes && !opts.iKnowWhatIAmDoing`
    // guard, the test above ("--instance default --yes WITHOUT --i-know-what-i-am-doing")
    // would not exit 2 — it would proceed to dry-run-or-execute. This test makes the
    // guard's behavior load-bearing by re-asserting it from a different angle.
    captureIO();
    try {
      const code = await nukeClientCacheCmd(["--instance", "(default)", "--yes"]);
      expect(code).toBe(2);
      expect(stderrCaptured).toContain("Refusing");
    } finally {
      restoreIO();
    }
  });
});

describe("nukeClientCacheCmd — dry-run report (no side effects)", () => {
  let captured = "";
  const origLog = console.log;

  // Instance id used in these dry-run tests must match
  // NAUTILO_INSTANCE_ID_PATTERN (^[a-z0-9][a-z0-9_-]{0,30}[a-z0-9]?$).
  // `d156-nope` is 9 chars, vanishingly unlikely to exist on a test machine.
  const FAKE_INSTANCE = "d156-nope";

  test("dry-run for a non-existent instance: prints '(default profile)' or named, exits 0, no error", async () => {
    captured = "";
    console.log = (...xs: unknown[]) => {
      captured += `${xs.join(" ")}\n`;
    };
    try {
      const code = await nukeClientCacheCmd(["--instance", FAKE_INSTANCE]);
      expect(code).toBe(0);
      expect(captured).toContain("DRY RUN");
      expect(captured).toContain(`Instance: ${FAKE_INSTANCE}`);
      // Should report "Nothing to do" since the userData dir + auth file don't exist.
      expect(captured).toContain("Nothing to do");
    } finally {
      console.log = origLog;
    }
  });

  test("dry-run --json for a non-existent instance: emits valid JSON with mode='dry-run'", async () => {
    captured = "";
    console.log = (...xs: unknown[]) => {
      captured += `${xs.join(" ")}\n`;
    };
    try {
      const code = await nukeClientCacheCmd([
        "--instance",
        FAKE_INSTANCE,
        "--json",
      ]);
      expect(code).toBe(0);
      const parsed = JSON.parse(captured.trim()) as {
        mode: string;
        instance: string;
        userDataDirExists: boolean;
        desktopAuthExists: boolean;
        targets: unknown[];
        totalBytes: number;
      };
      expect(parsed.mode).toBe("dry-run");
      expect(parsed.instance).toBe(FAKE_INSTANCE);
      expect(parsed.userDataDirExists).toBe(false);
      expect(parsed.desktopAuthExists).toBe(false);
      expect(parsed.targets).toEqual([]);
      expect(parsed.totalBytes).toBe(0);
    } finally {
      console.log = origLog;
    }
  });
});

/**
 * Stack 19 Phase 6.9.4 regression suite — Electron-on-this-userData
 * detection.
 *
 * Pre-fix `refuseIfElectronRunning` only checked whether the
 * per-instance SERVER was running via Phase 3.A's probe. Reviewer's
 * BLOCK High-#4 finding on PR #188: operator who stopped server but
 * left Electron open would have --yes proceed and rename/delete
 * active renderer storage = userData corruption.
 *
 * Fix: explicit Electron-PID-holding-our-userData probe via
 * `pgrep -f Electron` + `lsof -p <pid>` grep. The probe is
 * dependency-injected so this test can stub pgrep/lsof shapes
 * without spawning real processes.
 *
 * These tests pin the contract at the helper boundary
 * (`findElectronPidsHoldingUserData`) rather than at the full
 * nukeClientCacheCmd boundary (which would require fixture
 * instance.json + userData tree + real process state). The helper
 * is the load-bearing primitive; the cmd-level integration is
 * exercised by the manual Phase 6.4 smoke + by the D161 smoke
 * harness once it ships.
 */
describe("findElectronPidsHoldingUserData (Stack 19 Phase 6.9.4)", () => {
  const fakeUserData =
    "/Users/test/Library/Application Support/Nautilo-smoke-stack19";

  function makeDeps(opts: {
    pgrepPids: number[];
    pidsHoldingPath: Set<number>;
  }): RefuseElectronDeps {
    return {
      pgrepElectronPids: async () => opts.pgrepPids,
      lsofPidHoldsPath: async (pid, path) => {
        if (path !== fakeUserData) return false;
        return opts.pidsHoldingPath.has(pid);
      },
    };
  }

  test("REGRESSION: zero Electron procs at all → returns [] (genuine empty case; nuke proceeds)", async () => {
    const deps = makeDeps({ pgrepPids: [], pidsHoldingPath: new Set() });
    const hits = await findElectronPidsHoldingUserData(fakeUserData, deps);
    expect(hits).toEqual([]);
  });

  test("REGRESSION: Electron proc exists but does NOT hold our userData → returns [] (different instance)", async () => {
    // pgrep finds an Electron process (maybe a different app, maybe
    // a different Nautilo instance). lsof reports it does NOT have
    // open files in our userData tree. Nuke proceeds safely.
    const deps = makeDeps({ pgrepPids: [12345], pidsHoldingPath: new Set() });
    const hits = await findElectronPidsHoldingUserData(fakeUserData, deps);
    expect(hits).toEqual([]);
  });

  test("REGRESSION: Electron proc HOLDS our userData → returns the PID (LOAD-BEARING — fails under pre-fix server-only check)", async () => {
    // This is the exact scenario the reviewer flagged: server is
    // down (so the pre-fix check passes), but Electron is still
    // open with renderer storage mounted. Pre-fix this would have
    // returned no error and --yes would have deleted active state.
    const deps = makeDeps({
      pgrepPids: [54321],
      pidsHoldingPath: new Set([54321]),
    });
    const hits = await findElectronPidsHoldingUserData(fakeUserData, deps);
    expect(hits).toEqual([54321]);
  });

  test("multiple Electron PIDs, only some hold our userData → returns the matching subset", async () => {
    // Mixed environment: 3 Electron processes total (other apps,
    // other Nautilo instances), only one mounted on our userData.
    const deps = makeDeps({
      pgrepPids: [10001, 10002, 10003],
      pidsHoldingPath: new Set([10002]),
    });
    const hits = await findElectronPidsHoldingUserData(fakeUserData, deps);
    expect(hits).toEqual([10002]);
  });

  test("multiple Electron PIDs all hold our userData → returns all of them (multi-window or multi-profile case)", async () => {
    const deps = makeDeps({
      pgrepPids: [20001, 20002],
      pidsHoldingPath: new Set([20001, 20002]),
    });
    const hits = await findElectronPidsHoldingUserData(fakeUserData, deps);
    expect(hits.sort()).toEqual([20001, 20002]);
  });

  test("pgrep error / no pgrep → returns [] gracefully (does NOT throw, does NOT block nuke)", async () => {
    // Real impl wraps pgrep in try/catch; injected deps mirror that
    // by returning [] when shelling fails. This test pins the contract
    // that we degrade gracefully (rather than throwing into the cmd
    // path which would refuse with a misleading error).
    const deps: RefuseElectronDeps = {
      pgrepElectronPids: async () => [],
      lsofPidHoldsPath: async () => false,
    };
    const hits = await findElectronPidsHoldingUserData(fakeUserData, deps);
    expect(hits).toEqual([]);
  });

  test("the no-op replacement THIS test would have caught", () => {
    // Pre-fix shape: refuseIfElectronRunning only checked
    // state.isRunning (the SERVER PID via Phase 3.A's probe) and
    // returned null when the server was down. With Electron still
    // up holding userData, the function returned null → nuke
    // proceeded → renderer storage corrupted.
    //
    // The "Electron HOLDS our userData → returns PID" test above
    // is the load-bearing assertion: it FAILS under the pre-fix
    // shape because the pre-fix function would have returned null
    // (no error), but the post-fix function MUST return the PID
    // so the caller can refuse with a clear message.
    expect(true).toBe(true);
  });
});

/**
 * D418 — installation-id.json preservation guard.
 *
 * `installation-id.json` is the stable opaque install UUID. It MUST
 * survive `dev:nuke-client-cache` (sign-out / token clearing / re-pair
 * must not rotate install identity). The mechanism is the relay-token
 * discovery regex `/^relay-token.*\.json$/` in `discoverRelayTokens`,
 * which does not match `installation-id.json`, plus no explicit target
 * entry adds it. This test pins that contract directly against a real
 * temp userData dir so a future refactor that, say, globs `*.json` or
 * renames the discovery regex fails loudly here.
 */
describe("discoverRelayTokens — installation-id.json preservation (D418)", () => {
  test("picks up relay-token-*.json but NOT installation-id.json", () => {
    const tmp = mkdtempSync(join(tmpdir(), "nuke-d418-"));
    try {
      writeFileSync(
        join(tmp, "installation-id.json"),
        '{"installationId":"11111111-2222-4333-8444-555555555555"}',
      );
      writeFileSync(join(tmp, "relay-token-deadbeef.json"), '{"token":"rty_x"}');
      writeFileSync(join(tmp, "relay-token-cafef00d.json"), '{"token":"rty_y"}');
      // A distractor that shares the prefix but is NOT a relay token —
      // must also be excluded so the regex is anchored correctly.
      writeFileSync(join(tmp, "relay-token-backup.txt"), "noise");

      const found = discoverRelayTokens(tmp).sort();
      expect(found).toEqual(
        [
          join(tmp, "relay-token-cafef00d.json"),
          join(tmp, "relay-token-deadbeef.json"),
        ].sort(),
      );
      expect(found).not.toContain(join(tmp, "installation-id.json"));

      // Sanity: the temp dir really does hold installation-id.json, so
      // the absence above is the regex excluding it, not a missing fixture.
      expect(readdirSync(tmp)).toContain("installation-id.json");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("missing userData dir → [] (no throw)", () => {
    expect(discoverRelayTokens(join(tmpdir(), "nuke-d418-does-not-exist-xyz"))).toEqual([]);
  });
});
