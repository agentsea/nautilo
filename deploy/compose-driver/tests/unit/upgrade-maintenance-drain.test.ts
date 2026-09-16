import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as nodeFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ComposeDriver,
  type ComposeDriverDeps,
  type ExecFn,
  type ExecResult,
  type RestoreOptions,
} from "../../src/ComposeDriver.ts";
import type { RunBootstrapFn } from "../../src/bootstrapLogtoForProfile.ts";
import type { ReleaseArtifact, ReleasePlanReport } from "../../../contracts/release.ts";
import type { ComposeDriverProfile, MaintenanceDrainHandle } from "../../src/types.ts";

const CANONICAL_IMAGE_REF = `ghcr.io/agentsea/nautilo-runtime-v2@sha256:${"a".repeat(64)}`;

interface ExecCall {
  cmd: string;
  args: string[];
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: "inherit" | "pipe" };
}

const tmpDirs: string[] = [];

function mktmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function makeFakeExec(
  responder: (call: ExecCall) => ExecResult = () => ({ code: 0, stdout: "", stderr: "" }),
): { exec: ExecFn; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const exec: ExecFn = async (cmd, args, opts) => {
    const call: ExecCall = { cmd, args, opts };
    calls.push(call);
    const result = responder(call);
    if (result.code !== 0 || result.stdout.trim() !== "") return result;

    // Full upgrades capture the running server image after applying succeeds
    // and before the server stop. Fixtures that exercise post-transition
    // paths use this source-image container unless they supply a specific
    // Docker response.
    const command = [cmd, ...args].join(" ");
    if (
      (cmd === "docker" && args[0] === "ps") ||
      (cmd === "sh" && command.includes("docker ps -aq"))
    ) {
      return { ...result, stdout: "running-server\n" };
    }
    if (
      (cmd === "docker" && args[0] === "inspect") ||
      (cmd === "sh" && command.includes("docker inspect"))
    ) {
      return {
        ...result,
        stdout: "sha256:source-id\nnautilo-server:local-dev\n",
      };
    }
    return result;
  };
  return { exec, calls };
}

function makeDeps(over: Partial<ComposeDriverDeps> = {}): ComposeDriverDeps {
  const repoRoot = mktmp("upgrade-drain-repo-");
  const templateDir = join(repoRoot, "deploy/compose-driver/templates");
  const localRoot = mktmp("upgrade-drain-home-");
  mkdirSync(templateDir, { recursive: true });
  writeFileSync(join(templateDir, "docker-compose.yml"), "# unit-test template marker\n");
  const infraDir = join(repoRoot, "infra");
  mkdirSync(infraDir, { recursive: true });
  writeFileSync(join(infraDir, "postgres-init.sh"), "#!/bin/sh\n");
  const { exec } = makeFakeExec();
  const fakeFetch = (async () =>
    new Response("ok", { status: 200 })) as unknown as typeof fetch;
  const fakeRunBootstrap: RunBootstrapFn = async () => {};
  return {
    exec,
    localExec: exec,
    fetch: fakeFetch,
    runBootstrap: fakeRunBootstrap as ComposeDriverDeps["runBootstrap"],
    fs: nodeFs,
    now: () => new Date("2026-07-14T12:00:00.000Z"),
    templateDir,
    pollIntervalMs: 1,
    logtoHealthTimeoutMs: 1000,
    serverHealthTimeoutMs: 1000,
    resolveInstanceRootDir: () => localRoot,
    resolveLocalInstanceRootDir: () => localRoot,
    ensureDbPasswords: async () => ({
      appDbPassword: "fake_app_pw",
      postgresPassword: "fake_pg_pw",
      nautilo: "fake_nautilo_pw",
      logto: "fake_logto_pw",
      nautiloAgent: "fake_agent_pw",
      nautiloCrypto: "fake_crypto_pw",
    }),
    ...over,
  };
}

const localProfile: ComposeDriverProfile = {
  name: "local-drain",
  transport: "local",
  lifecycle: "compose",
  from_source: true,
};

function okReleaseApply(order: string[]): (profile: ComposeDriverProfile) => Promise<ReleasePlanReport> {
  return async (_profile) => {
    order.push("releaseApply");
    return {
      compatible: true,
      auth: {
        classification: "compatible",
        incoming: {
          version: 1,
          hash: "incoming",
          logtoEngine: { image: "ghcr.io/logto-io/logto:1.0.0", minimumVersion: "1.0.0" },
          impact: { requiresExplicitAuthReconcile: false, mayAffectExistingSessions: false },
        },
        applied: null,
        live: { logtoEngineImage: null, logtoEngineVersion: null, inspected: false },
        reasons: [],
        limitations: [],
      },
      artifact: {
        mode: "registry",
        requested: CANONICAL_IMAGE_REF,
        immutableId: "sha256:1",
      },
      limitations: [],
    };
  };
}

/**
 * D420 (Wave 2 task 2.2.5 / Wave 3 task 3.1.3) — a controllable maintenance
 * handle for the upgrade-ordering tests. Its operations record into the shared
 * `order` log so tests can prove `applying` happens before `stop` and
 * `completeLease` happens AFTER the relevant health check. `transitionError`
 * and `completeError` exercise fail-closed transitions.
 */
function fakeMaintenanceHandle(
  order: string[],
  opts: {
    transitionError?: () => Error;
    completeError?: () => Error;
  } = {},
): MaintenanceDrainHandle {
  return {
    operationId: "op-test",
    transitionApplying: async () => {
      order.push("applying");
      if (opts.transitionError) throw opts.transitionError();
    },
    releaseLease: async () => {
      order.push("releaseLease");
      return { cancelled: true };
    },
    completeLease: async () => {
      order.push("completeLease");
      if (opts.completeError) throw opts.completeError();
      return { completed: true };
    },
  };
}

afterEach(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  tmpDirs.length = 0;
});

describe("D420 (2.2.5) ComposeDriver.upgrade maintenance drain preflight", () => {
  test("drain runs before the server-only releaseApply lane and forwards waitForMs", async () => {
    const order: string[] = [];
    let receivedWait: number | undefined;
    const driver = new ComposeDriver(makeDeps());
    driver.setMaintenanceDrain(async (_profile, waitForMs) => {
      receivedWait = waitForMs;
      order.push("drain");
      return fakeMaintenanceHandle(order);
    });
    driver.releaseApply = okReleaseApply(order) as typeof driver.releaseApply;

    await driver.upgrade(
      { name: "default-image", transport: "local", lifecycle: "compose", image_ref: CANONICAL_IMAGE_REF },
      { artifact: "image", imageRef: CANONICAL_IMAGE_REF, scope: "server-only", waitForMs: 42_000 },
    );

    expect(order).toEqual(["drain", "releaseApply"]);
    expect(receivedWait).toBe(42_000);
  });

  test("server-only readiness failure occurs before drain lease acquisition", async () => {
    const order: string[] = [];
    const driver = new ComposeDriver(
      makeDeps({
        assertReleaseActiveWorkReady: async () => {
          order.push("readiness");
          throw new Error("operator endpoint unavailable");
        },
      }),
    );
    driver.setMaintenanceDrain(async () => {
      order.push("drain");
      return fakeMaintenanceHandle(order);
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(
      driver.upgrade(localProfile, {
        artifact: "image",
        imageRef: CANONICAL_IMAGE_REF,
        scope: "server-only",
      }),
    ).rejects.toThrow(/operator endpoint unavailable/);

    expect(order).toEqual(["readiness"]);
  });

  test("full-path doctor refusal after drain acquisition releases the owning lease", async () => {
    const order: string[] = [];
    const driver = new ComposeDriver(
      makeDeps({
        doctor: async () => {
          order.push("doctor");
          throw new Error("doctor refused the upgrade");
        },
      }),
    );
    driver.setMaintenanceDrain(async () => {
      order.push("drain");
      return fakeMaintenanceHandle(order);
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(driver.upgrade(localProfile)).rejects.toThrow(
      /doctor refused the upgrade/,
    );

    expect(order).toEqual(["drain", "doctor", "releaseLease"]);
    expect(order).not.toContain("applying");
  });

  test("full path: drain → applying → stop → backup → deploy → health → complete; lease completed after health", async () => {
    const order: string[] = [];
    const { exec } = makeFakeExec((call) => {
      if (call.args.includes("stop") && call.args.includes("nautilo-server")) order.push("stop");
      if (call.args.includes("start") && call.args.includes("nautilo-server")) order.push("start");
      return { code: 0, stdout: "", stderr: "" };
    });
    const driver = new ComposeDriver(makeDeps({ exec }));
    driver.setMaintenanceDrain(async () => {
      order.push("drain");
      return fakeMaintenanceHandle(order);
    });
    driver.backup = (async (_p, o) => {
      order.push("backup");
      return o?.toPath ?? "/x";
    }) as typeof driver.backup;
    driver.deploy = (async () => {
      order.push("deploy");
    }) as typeof driver.deploy;
    driver.checkServerHealth = (async () => {
      order.push("health");
    }) as typeof driver.checkServerHealth;

    await driver.upgrade(localProfile);

    // The applying transition runs immediately before the server stop; the
    // stop completes before backup begins; the lease is COMPLETED (not
    // released) on the success path, and completion runs AFTER the health
    // check proves the new deployment is healthy — never before.
    expect(order).toEqual([
      "drain",
      "applying",
      "stop",
      "backup",
      "deploy",
      "health",
      "completeLease",
    ]);
    expect(order).not.toContain("releaseLease");
    expect(order.indexOf("applying")).toBeLessThan(order.indexOf("stop"));
    expect(order.indexOf("stop")).toBeLessThan(order.indexOf("backup"));
    expect(order.indexOf("health")).toBeLessThan(order.indexOf("completeLease"));
  });

  test("full path: a failed completion is reported honestly and the lease is not released on success", async () => {
    const order: string[] = [];
    const logLines: string[] = [];
    const { exec } = makeFakeExec((call) => {
      if (call.args.includes("stop") && call.args.includes("nautilo-server")) order.push("stop");
      if (call.args.includes("start") && call.args.includes("nautilo-server")) order.push("start");
      return { code: 0, stdout: "", stderr: "" };
    });
    const driver = new ComposeDriver(
      makeDeps({ exec, log: (msg) => logLines.push(msg) }),
    );
    driver.setMaintenanceDrain(async () => {
      order.push("drain");
      return fakeMaintenanceHandle(order, {
        completeError: () =>
          new Error("maintenance complete: operator endpoint refused authorization (HTTP 403)."),
      });
    });
    driver.backup = (async (_p, o) => {
      order.push("backup");
      return o?.toPath ?? "/x";
    }) as typeof driver.backup;
    driver.deploy = (async () => {
      order.push("deploy");
    }) as typeof driver.deploy;
    driver.checkServerHealth = (async () => {
      order.push("health");
    }) as typeof driver.checkServerHealth;

    // A failed completion does NOT turn a successful upgrade into a failure:
    // the new deployment is healthy. The failure is reported honestly (the
    // lease is left in applying for hard-expiry to reclaim) and never claimed
    // "cleared". The lease is not released (cancel) either.
    await driver.upgrade(localProfile);

    expect(order).toContain("completeLease");
    expect(order).not.toContain("releaseLease");
    expect(order.indexOf("health")).toBeLessThan(order.indexOf("completeLease"));
    expect(
      logLines.some((line) => line.includes("maintenance lease completion failed") && line.includes("HTTP 403")),
    ).toBe(true);
    expect(logLines.some((line) => line.includes("lease cleared"))).toBe(false);
  });

  test("drain failure aborts the upgrade before any mutation (no stop/backup/deploy)", async () => {
    const order: string[] = [];
    const { exec, calls } = makeFakeExec((call) => {
      if (call.args.includes("stop")) order.push("stop");
      if (call.args.includes("start")) order.push("start");
      return { code: 0, stdout: "", stderr: "" };
    });
    const driver = new ComposeDriver(makeDeps({ exec }));
    driver.setMaintenanceDrain(async () => {
      order.push("drain");
      throw new Error("maintenance drain timed out after 1000ms: lease cleared; no upgrade mutation performed.");
    });
    let backupCalls = 0;
    let deployCalls = 0;
    driver.backup = (async () => {
      backupCalls += 1;
      return "/x";
    }) as typeof driver.backup;
    driver.deploy = (async () => {
      deployCalls += 1;
    }) as typeof driver.deploy;
    driver.checkServerHealth = (async () => {}) as typeof driver.checkServerHealth;

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(driver.upgrade(localProfile)).rejects.toThrow(/timed out.*no upgrade mutation/);
    expect(order).toEqual(["drain"]);
    expect(backupCalls).toBe(0);
    expect(deployCalls).toBe(0);
    expect(calls.some((c) => c.args.includes("stop"))).toBe(false);
  });

  test("applying transition failure aborts before stop/backup/deploy and releases the draining lease", async () => {
    const order: string[] = [];
    const { exec, calls } = makeFakeExec((call) => {
      if (call.args.includes("stop")) order.push("stop");
      if (call.args.includes("start")) order.push("start");
      return { code: 0, stdout: "", stderr: "" };
    });
    const driver = new ComposeDriver(makeDeps({ exec }));
    driver.setMaintenanceDrain(async () => {
      order.push("drain");
      return fakeMaintenanceHandle(order, {
        transitionError: () => new Error("maintenance applying: operator endpoint refused authorization (HTTP 403)."),
      });
    });
    let backupCalls = 0;
    let deployCalls = 0;
    driver.backup = (async () => {
      backupCalls += 1;
      return "/x";
    }) as typeof driver.backup;
    driver.deploy = (async () => {
      deployCalls += 1;
    }) as typeof driver.deploy;
    driver.checkServerHealth = (async () => {}) as typeof driver.checkServerHealth;

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(driver.upgrade(localProfile)).rejects.toThrow(/HTTP 403/);
    // Fail closed: the transition error propagates before any
    // stop/backup/deploy, and the still-draining owning lease is cancelled.
    expect(order).toEqual(["drain", "applying", "releaseLease"]);
    expect(backupCalls).toBe(0);
    expect(deployCalls).toBe(0);
    expect(order).not.toContain("stop");
    expect(calls.some((c) => c.args.includes("stop"))).toBe(false);
  });

  test("backup failure completes the lease only after restarted-server health (full path)", async () => {
    const order: string[] = [];
    const { exec, calls } = makeFakeExec((call) => {
      if (call.args.includes("stop") && call.args.includes("nautilo-server")) order.push("stop");
      if (call.args.includes("start") && call.args.includes("nautilo-server")) order.push("start");
      return { code: 0, stdout: "", stderr: "" };
    });
    const driver = new ComposeDriver(makeDeps({ exec }));
    driver.setMaintenanceDrain(async () => {
      order.push("drain");
      return fakeMaintenanceHandle(order);
    });
    let backupCalls = 0;
    let deployCalls = 0;
    driver.backup = (async () => {
      backupCalls += 1;
      order.push("backup");
      throw new Error("pg_dump exited 1");
    }) as typeof driver.backup;
    driver.deploy = (async () => {
      deployCalls += 1;
    }) as typeof driver.deploy;
    driver.checkServerHealth = (async () => {
      order.push("health");
    }) as typeof driver.checkServerHealth;

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(driver.upgrade(localProfile)).rejects.toThrow(
      /pre-upgrade backup failed.*old server restarted.*post-restart health = ready.*maintenance lease cleared.*pg_dump exited 1/,
    );
    expect(order).toEqual([
      "drain",
      "applying",
      "stop",
      "backup",
      "start",
      "health",
      "completeLease",
    ]);
    expect(backupCalls).toBe(1);
    expect(deployCalls).toBe(0);
    expect(order).not.toContain("releaseLease");
    // Exactly one stop and one restart-start of nautilo-server.
    expect(calls.filter((c) => c.args.includes("stop") && c.args.includes("nautilo-server"))).toHaveLength(1);
    expect(calls.filter((c) => c.args.includes("start") && c.args.includes("nautilo-server"))).toHaveLength(1);
  });

  test("backup failure with unhealthy restart retains applying (full path)", async () => {
    const order: string[] = [];
    const { exec } = makeFakeExec((call) => {
      if (call.args.includes("stop") && call.args.includes("nautilo-server")) order.push("stop");
      if (call.args.includes("start") && call.args.includes("nautilo-server")) order.push("start");
      return { code: 0, stdout: "", stderr: "" };
    });
    const driver = new ComposeDriver(makeDeps({ exec }));
    driver.setMaintenanceDrain(async () => {
      order.push("drain");
      return fakeMaintenanceHandle(order);
    });
    driver.backup = (async () => {
      order.push("backup");
      throw new Error("pg_dump exited 1");
    }) as typeof driver.backup;
    driver.deploy = (async () => {}) as typeof driver.deploy;
    driver.checkServerHealth = (async () => {
      throw new Error("connection reset");
    }) as typeof driver.checkServerHealth;

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(driver.upgrade(localProfile)).rejects.toThrow(
      /CRITICAL.*backup failed.*recovery is unproven.*lease left in applying.*connection reset.*pg_dump exited 1/,
    );
    expect(order).not.toContain("completeLease");
    expect(order).not.toContain("releaseLease");
  });

  test("without a drain dep wired, upgrade preserves legacy no-drain behavior", async () => {
    const order: string[] = [];
    const { exec } = makeFakeExec((call) => {
      if (call.args.includes("stop") && call.args.includes("nautilo-server")) order.push("stop");
      if (call.args.includes("start") && call.args.includes("nautilo-server")) order.push("start");
      return { code: 0, stdout: "", stderr: "" };
    });
    const driver = new ComposeDriver(makeDeps({ exec }));
    driver.backup = (async (_p, o) => {
      order.push("backup");
      return o?.toPath ?? "/x";
    }) as typeof driver.backup;
    driver.deploy = (async () => {
      order.push("deploy");
    }) as typeof driver.deploy;
    driver.checkServerHealth = (async () => {
      order.push("health");
    }) as typeof driver.checkServerHealth;

    await driver.upgrade(localProfile);

    expect(order).not.toContain("drain");
    expect(order).not.toContain("applying");
    expect(order).toEqual(["stop", "backup", "deploy", "health"]);
  });

  test("omitted waitForMs defaults to the 5m drain ceiling", async () => {
    let receivedWait: number | undefined;
    const driver = new ComposeDriver(makeDeps());
    driver.setMaintenanceDrain(async (_profile, waitForMs) => {
      receivedWait = waitForMs;
      return fakeMaintenanceHandle([]);
    });
    driver.releaseApply = okReleaseApply([]) as typeof driver.releaseApply;

    await driver.upgrade(
      { name: "default-image", transport: "local", lifecycle: "compose", image_ref: CANONICAL_IMAGE_REF },
      { artifact: "image", scope: "server-only" },
    );

    expect(receivedWait).toBe(5 * 60_000);
  });
});

// D420 (Wave 3 task 3.1.3) — maintenance completion fencing on the full
// upgrade path. Completion of the owning lease happens ONLY after a healthy
// new deployment or a healthy full-bundle rollback, never on an unproven
// state. `--no-rollback`, a restore failure, and a rollback-health failure
// (double failure) retain `applying` for hard-expiry to reclaim; no
// completion or cancel is attempted. The exact recovery bundle path is
// preserved in every failure message.
describe("D420 (3.1.3) ComposeDriver.upgrade maintenance completion fencing (full path)", () => {
  function wireFull(
    order: string[],
    over: {
      deploy?: () => void | Promise<void>;
      restore?: () => void | Promise<void>;
      health?: () => void | Promise<void>;
      completeError?: () => Error;
    } = {},
  ): ComposeDriver {
    const { exec } = makeFakeExec((call) => {
      if (call.args.includes("stop") && call.args.includes("nautilo-server")) order.push("stop");
      if (call.args.includes("start") && call.args.includes("nautilo-server")) order.push("start");
      return { code: 0, stdout: "", stderr: "" };
    });
    const driver = new ComposeDriver(makeDeps({ exec }));
    driver.setMaintenanceDrain(async () => {
      order.push("drain");
      return fakeMaintenanceHandle(order, {
        ...(over.completeError ? { completeError: over.completeError } : {}),
      });
    });
    driver.backup = (async (_p, o) => {
      order.push("backup");
      return o?.toPath ?? "/x";
    }) as typeof driver.backup;
    driver.deploy = (async () => {
      order.push("deploy");
      if (over.deploy) await over.deploy();
    }) as typeof driver.deploy;
    driver.restore = (async () => {
      order.push("restore");
      if (over.restore) await over.restore();
    }) as typeof driver.restore;
    driver.checkServerHealth = (async () => {
      order.push("health");
      if (over.health) await over.health();
    }) as typeof driver.checkServerHealth;
    return driver;
  }

  test("healthy rollback completes the lease AFTER rollback health (not before)", async () => {
    const order: string[] = [];
    const driver = wireFull(order, {
      deploy: () => {
        throw new Error("deploy exploded");
      },
      restore: () => {
        /* restore succeeds */
      },
      health: () => {
        /* post-rollback health = ready */
      },
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(driver.upgrade(localProfile)).rejects.toThrow(
      /full-bundle rollback succeeded.*post-rollback health = ready.*maintenance lease cleared.*deploy exploded/,
    );

    expect(order).toContain("completeLease");
    expect(order).not.toContain("releaseLease");
    // Completion runs AFTER the rollback health check, never before. The
    // deploy-try health is never reached (deploy throws), so the only
    // `health` entry is the rollback health check.
    expect(order.lastIndexOf("health")).toBeLessThan(order.indexOf("completeLease"));
  });

  test("double failure (restore fails) retains applying; no completion or cancel attempted", async () => {
    const order: string[] = [];
    const driver = wireFull(order, {
      deploy: () => {
        throw new Error("deploy exploded");
      },
      restore: () => {
        throw new Error("gunzip failed on nautilo.sql.gz");
      },
      health: () => {
        throw new Error("health should not be reached when restore failed");
      },
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(driver.upgrade(localProfile)).rejects.toThrow(
      /CRITICAL.*full-bundle rollback failed.*post-rollback health = FAILED.*maintenance lease left in applying.*gunzip failed.*deploy exploded/,
    );

    // Unproven state: completion is never attempted; the lease is not released.
    expect(order).not.toContain("completeLease");
    expect(order).not.toContain("releaseLease");
  });

  test("post-rollback health failure retains applying; no completion or cancel attempted", async () => {
    const order: string[] = [];
    const driver = wireFull(order, {
      deploy: () => {
        throw new Error("deploy exploded");
      },
      restore: () => {
        /* restore succeeds */
      },
      health: () => {
        throw new Error("still broken");
      },
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(driver.upgrade(localProfile)).rejects.toThrow(
      /CRITICAL.*full-bundle rollback failed.*post-rollback health = FAILED.*maintenance lease left in applying.*still broken.*deploy exploded/,
    );

    expect(order).not.toContain("completeLease");
    expect(order).not.toContain("releaseLease");
  });

  test("--no-rollback retains applying and reports the exact bundle; no completion or restore", async () => {
    const order: string[] = [];
    const driver = wireFull(order, {
      deploy: () => {
        throw new Error("deploy exploded");
      },
      restore: () => {
        /* not reached */
      },
      health: () => {
        /* not reached */
      },
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(driver.upgrade(localProfile, { noRollback: true })).rejects.toThrow(
      /--no-rollback.*leaving the failed target as-is.*maintenance lease left in applying.*auto-pre-upgrade-.*nautilo restore.*deploy exploded/,
    );

    expect(order).not.toContain("completeLease");
    expect(order).not.toContain("releaseLease");
    // No restore is attempted: the failed target is left in place.
    expect(order).not.toContain("restore");
  });

  test("healthy rollback: a failed completion is reported honestly (lease not cleared, not released)", async () => {
    const order: string[] = [];
    const driver = wireFull(order, {
      deploy: () => {
        throw new Error("deploy exploded");
      },
      restore: () => {
        /* restore succeeds */
      },
      health: () => {
        /* post-rollback health = ready */
      },
      completeError: () =>
        new Error("maintenance complete: operator endpoint refused authorization (HTTP 403)."),
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(driver.upgrade(localProfile)).rejects.toThrow(
      /full-bundle rollback succeeded.*post-rollback health = ready.*maintenance lease completion failed.*HTTP 403.*deploy exploded/,
    );

    expect(order).toContain("completeLease");
    expect(order).not.toContain("releaseLease");
  });
});

// D420 (Wave 3 task 3.3.1) — fault-inject the full upgrade transaction WITH the
// owning maintenance lease wired, across both scope lanes the seams permit.
// Every injected failure must resolve to exactly one deterministic lease
// outcome: a healthy full-bundle rollback completes the lease AFTER the
// rollback health check (never before, never on an unproven state); a
// `--no-rollback` retains `applying` for hard-expiry with the EXACT bundle path.
// The full path uses the `auto-pre-upgrade-<stamp>` bundle; the server-only
// releaseApply lane (delegated from upgrade()) uses `auto-pre-release-<stamp>`.
// makeDeps pins now() to 2026-07-14T12:00:00Z → stamp 20260714T120000Z.

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const faultPlanReport: ReleasePlanReport = {
  compatible: true,
  auth: {
    classification: "compatible",
    incoming: {
      version: 1,
      hash: "incoming",
      logtoEngine: { image: "ghcr.io/logto-io/logto:1.0.0", minimumVersion: "1.0.0" },
      impact: { requiresExplicitAuthReconcile: false, mayAffectExistingSessions: false },
    },
    applied: null,
    live: { logtoEngineImage: null, logtoEngineVersion: null, inspected: false },
    reasons: [],
    limitations: [],
  },
  artifact: {
    mode: "registry",
    requested: CANONICAL_IMAGE_REF,
    immutableId: "sha256:1",
  },
  limitations: [],
};

// Reusable handled-upgrade fault harness covering both scope lanes. The full
// lane mutates via `deploy`; the server-only lane mutates via `releaseServerUp`
// (releaseApply's incoming-server start). Both share the same rollback +
// lease-completion contract, so one helper drives both.
function wireHandledUpgradeFault(
  bundlePrefix: "auto-pre-upgrade" | "auto-pre-release",
  over: {
    deploy?: () => void | Promise<void>;
    releaseServerUp?: () => void | Promise<void>;
    restore?: () => void | Promise<void>;
    health?: (call: number) => void | Promise<void>;
  } = {},
): {
  driver: ComposeDriver;
  order: string[];
  restoreCalls: Array<{ opts: RestoreOptions }>;
  healthCalls: number[];
  localRoot: string;
  bundleDir: string;
} {
  const order: string[] = [];
  const localRoot = mktmp("upgrade-fault-handled-");
  const exec: ExecFn = async (_cmd, args) => {
    if (args[0] === "ps") return { code: 0, stdout: "server-container\n", stderr: "" };
    if (args[0] === "inspect") {
      return { code: 0, stdout: "sha256:legacy\nnautilo-server:local-dev\n\n", stderr: "" };
    }
    if (args.includes("stop") && args.includes("nautilo-server")) order.push("stop");
    if (args.includes("start") && args.includes("nautilo-server")) order.push("start");
    return { code: 0, stdout: "", stderr: "" };
  };
  const driver = new ComposeDriver(
    makeDeps({
      exec,
      resolveInstanceRootDir: () => localRoot,
      resolveLocalInstanceRootDir: () => localRoot,
    }),
  );
  driver.setMaintenanceDrain(async () => {
    order.push("drain");
    return fakeMaintenanceHandle(order);
  });
  driver.backup = (async (_p, o) => {
    order.push("backup");
    return o?.toPath ?? "/x";
  }) as typeof driver.backup;
  driver.deploy = (async () => {
    order.push("deploy");
    if (over.deploy) await over.deploy();
  }) as typeof driver.deploy;
  const restoreCalls: Array<{ opts: RestoreOptions }> = [];
  driver.restore = (async (_p, opts) => {
    restoreCalls.push({ opts });
    order.push("restore");
    if (over.restore) await over.restore();
  }) as typeof driver.restore;
  const healthCalls: number[] = [];
  driver.checkServerHealth = (async () => {
    healthCalls.push(healthCalls.length + 1);
    order.push("health");
    if (over.health) await over.health(healthCalls.length);
  }) as typeof driver.checkServerHealth;
  // Server-only lane seams (releaseApply internals). The full lane never
  // reaches these because upgrade() delegates to deploy() instead.
  const releaseHarness = driver as unknown as {
    releasePlan: (p: ComposeDriverProfile) => Promise<ReleasePlanReport>;
    assertArtifactVolumePresentOrMigrated: (p: ComposeDriverProfile) => Promise<void>;
    releaseServerAction: (p: ComposeDriverProfile, action: "stop" | "start") => Promise<void>;
    releaseServerUp: (p: ComposeDriverProfile, artifact: ReleaseArtifact) => Promise<void>;
  };
  releaseHarness.releasePlan = async () => faultPlanReport;
  releaseHarness.assertArtifactVolumePresentOrMigrated = async () => {};
  releaseHarness.releaseServerAction = async (_p, action) => {
    order.push(action);
  };
  releaseHarness.releaseServerUp = async () => {
    order.push("releaseServerUp");
    if (over.releaseServerUp) await over.releaseServerUp();
  };
  const bundleDir = join(localRoot, "backups", `${bundlePrefix}-20260714T120000Z`);
  return { driver, order, restoreCalls, healthCalls, localRoot, bundleDir };
}

describe("D420 (3.3.1) ComposeDriver.upgrade full-transaction fault injection (with maintenance handle)", () => {
  const imageFullProfile: ComposeDriverProfile = {
    name: "image-full-handled-fault",
    transport: "local",
    lifecycle: "compose",
    from_source: false,
    image_ref: CANONICAL_IMAGE_REF,
  };
  const imageServerOnlyProfile: ComposeDriverProfile = {
    name: "image-serveronly-handled-fault",
    transport: "local",
    lifecycle: "compose",
    from_source: false,
    image_ref: CANONICAL_IMAGE_REF,
  };

  test("full lane (image artifact): deploy failure rolls back and completes the lease after rollback health", async () => {
    const { driver, order, bundleDir, restoreCalls, healthCalls } = wireHandledUpgradeFault("auto-pre-upgrade", {
        deploy: () => {
          throw new Error("deploy exploded");
        },
        health: () => {
          /* post-rollback health = ready */
        },
      },
    );

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(driver.upgrade(imageFullProfile)).rejects.toThrow(
      new RegExp(
        `full-bundle rollback succeeded.*post-rollback health = ready.*maintenance lease cleared.*Bundle: ${escapeRegExp(bundleDir)}.*deploy exploded`,
      ),
    );

    // The lease is COMPLETED (not released) only after the rollback health
    // check proves the restored server is ready — never before.
    expect(order).toContain("completeLease");
    expect(order).not.toContain("releaseLease");
    expect(order.lastIndexOf("health")).toBeLessThan(order.indexOf("completeLease"));
    expect(restoreCalls).toHaveLength(1);
    expect(restoreCalls[0]!.opts).toEqual({ fromPath: bundleDir, force: true });
    // Full lane ordered: drain → applying → stop → backup → deploy → restore → health → complete.
    expect(order).toEqual([
      "drain",
      "applying",
      "stop",
      "backup",
      "deploy",
      "restore",
      "health",
      "completeLease",
    ]);
    expect(healthCalls).toEqual([1]);
  });

  test("server-only lane (image artifact): incoming-server startup failure rolls back and completes the lease after rollback health", async () => {
    const { driver, order, bundleDir, restoreCalls, healthCalls } = wireHandledUpgradeFault("auto-pre-release", {
        releaseServerUp: () => {
          throw new Error("incoming server did not start");
        },
        health: () => {
          /* post-rollback health = ready */
        },
      },
    );

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(
      driver.upgrade(imageServerOnlyProfile, {
        artifact: "image",
        imageRef: CANONICAL_IMAGE_REF,
        scope: "server-only",
        waitForMs: 30_000,
      }),
    ).rejects.toThrow(
      new RegExp(
        `full-bundle rollback succeeded.*post-rollback health = ready.*maintenance lease cleared.*Bundle: ${escapeRegExp(bundleDir)}.*incoming server did not start`,
      ),
    );

    // The server-only lane delegates releaseApply through upgrade(); the lease
    // is completed (not released) only after rollback health, with the exact
    // auto-pre-release bundle path restored.
    expect(order).toContain("completeLease");
    expect(order).not.toContain("releaseLease");
    expect(order.lastIndexOf("health")).toBeLessThan(order.indexOf("completeLease"));
    expect(restoreCalls).toHaveLength(1);
    expect(restoreCalls[0]!.opts).toEqual({ fromPath: bundleDir, force: true });
    expect(order).toEqual([
      "drain",
      "applying",
      "stop",
      "backup",
      "releaseServerUp",
      "restore",
      "health",
      "completeLease",
    ]);
    // The deploy-try health never ran (releaseServerUp threw first); the only
    // health call is the rollback health check.
    expect(healthCalls).toEqual([1]);
  });

  test("full lane (image artifact): --no-rollback retains applying and reports the exact bundle; no completion or restore", async () => {
    const { driver, order, bundleDir, restoreCalls } = wireHandledUpgradeFault("auto-pre-upgrade", {
        deploy: () => {
          throw new Error("deploy exploded");
        },
      },
    );

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(driver.upgrade(imageFullProfile, { noRollback: true })).rejects.toThrow(
      new RegExp(
        `--no-rollback.*leaving the failed target as-is.*maintenance lease left in applying.*${escapeRegExp(bundleDir)}.*nautilo restore.*deploy exploded`,
      ),
    );

    // Unproven state: completion is never attempted and the lease is not
    // released; no restore is attempted (the failed target is left in place).
    expect(order).not.toContain("completeLease");
    expect(order).not.toContain("releaseLease");
    expect(order).not.toContain("restore");
    expect(restoreCalls).toEqual([]);
  });
});
