import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as nodeFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ComposeDriver,
  type BackupOptions,
  type ComposeDriverDeps,
  type ExecFn,
  type ExecResult,
  type RestoreOptions,
} from "../../src/ComposeDriver.ts";
import type { RemoteDeploymentManifest } from "../../src/remote-deployment-manifest.ts";
import type {
  ReleaseArtifact,
  ReleasePlanReport,
  ReleaseState,
} from "../../../contracts/release.ts";
import type { ComposeDriverProfile, MaintenanceDrainHandle } from "../../src/types.ts";

const tmpDirs: string[] = [];

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "release-recovery-"));
  tmpDirs.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of tmpDirs) rmSync(directory, { recursive: true, force: true });
  tmpDirs.length = 0;
});

const profile: ComposeDriverProfile = {
  name: "release-test",
  transport: "local",
  lifecycle: "compose",
  from_source: false,
  tag: "main",
};

function makeDriver(
  exec: ExecFn,
  root: string,
  overrides: Partial<ComposeDriverDeps> = {},
): ComposeDriver {
  const deps: ComposeDriverDeps = {
    exec,
    localExec: exec,
    fetch: (async () => new Response("ok")) as unknown as typeof fetch,
    runBootstrap: async () => undefined,
    fs: nodeFs,
    now: () => new Date("2026-07-12T12:34:56.000Z"),
    templateDir: root,
    resolveInstanceRootDir: () => root,
    resolveLocalInstanceRootDir: () => root,
    ensureDbPasswords: async () => ({
      appDbPassword: "app",
      postgresPassword: "postgres",
      nautilo: "nautilo",
      logto: "logto",
      nautiloAgent: "agent",
      nautiloCrypto: "fake_crypto_pw",
    }),
    ...overrides,
  };
  return new ComposeDriver(deps);
}

const incomingPlan: ReleasePlanReport = {
  artifact: {
    mode: "registry",
    requested: "ghcr.io/agentsea/nautilo-server:main",
    immutableId: "sha256:incoming",
    repoDigest: "ghcr.io/agentsea/nautilo-server@sha256:incoming",
  },
  auth: {} as ReleasePlanReport["auth"],
  compatible: true,
  limitations: [],
};

type ReleaseDriverHarness = {
  releasePlan: (profile: ComposeDriverProfile) => Promise<ReleasePlanReport>;
  releaseApply: (profile: ComposeDriverProfile) => Promise<ReleasePlanReport>;
  backup: (
    profile: ComposeDriverProfile,
    options?: BackupOptions,
  ) => Promise<string>;
  checkServerHealth: (profile: ComposeDriverProfile) => Promise<void>;
  assertArtifactVolumePresentOrMigrated: (
    profile: ComposeDriverProfile,
  ) => Promise<void>;
  assertRemoteArtifactVolumePresentOrMigrated: (
    profile: ComposeDriverProfile,
    composeProjectName: string,
  ) => Promise<void>;
  releaseServerAction: (
    profile: ComposeDriverProfile,
    action: "stop" | "start",
  ) => Promise<void>;
  releaseServerUp: (
    profile: ComposeDriverProfile,
    artifact: ReleaseArtifact,
  ) => Promise<void>;
  readRemoteDeploymentManifest: (
    profile: ComposeDriverProfile,
  ) => Promise<RemoteDeploymentManifest>;
  captureRunningServerArtifact: (
    profile: ComposeDriverProfile,
  ) => Promise<ReleaseArtifact>;
  restore: (profile: ComposeDriverProfile, options: RestoreOptions) => Promise<void>;
};

function releaseDriverHarness(driver: ComposeDriver): ReleaseDriverHarness {
  return driver as unknown as ReleaseDriverHarness;
}

describe("release migration recovery", () => {
  test("reconciles legacy crypto credentials before doctor interpolates Compose", async () => {
    const root = tempDir();
    const order: string[] = [];
    const exec: ExecFn = async () => ({ code: 0, stdout: "", stderr: "" });
    const driver = makeDriver(exec, root, {
      doctor: async () => {
        order.push("doctor");
        throw new Error("stop after ordering assertion");
      },
    });
    const internal = driver as unknown as {
      preflightLocalCryptoCredential: (
        profile: ComposeDriverProfile,
      ) => Promise<void>;
    };
    internal.preflightLocalCryptoCredential = async () => {
      order.push("crypto-preflight");
    };

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(
      driver.releaseApply({ ...profile, from_source: true, tag: undefined }),
    ).rejects.toThrow("stop after ordering assertion");

    expect(order).toEqual(["crypto-preflight", "doctor"]);
  });

  test("pins the live source image before releasePlan (first-cutover)", async () => {
    const root = tempDir();
    const calls: string[][] = [];
    let releasePlanCalls = 0;
    const exec: ExecFn = async (_cmd, args) => {
      calls.push(args);
      if (args[0] === "ps") return { code: 0, stdout: "server-container\n", stderr: "" };
      if (args[0] === "inspect") {
        return { code: 0, stdout: "sha256:legacy\nnautilo-server:local-dev\n\n", stderr: "" };
      }
      if (args[0] === "image") {
        return { code: 1, stdout: "", stderr: "no digest" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const driver = releaseDriverHarness(makeDriver(exec, root));
    driver.releasePlan = async () => {
      releasePlanCalls += 1;
      // Pin must already have retained the live name before prepare/build.
      expect(
        calls.some(
          (args) =>
            args[0] === "tag" &&
            args[1] === "nautilo-server:local-dev" &&
            args[2] === "nautilo-server:first-cutover-20260712T123456Z",
        ),
      ).toBe(true);
      return incomingPlan;
    };
    driver.assertArtifactVolumePresentOrMigrated = async () => {};
    driver.releaseServerAction = async () => {};
    driver.releaseServerUp = async () => {};
    driver.backup = async (_profile, options) => {
      expect(options?.releaseLegacyImage).toMatchObject({
        immutableId: "sha256:legacy",
        archiveTag: "nautilo-server:first-cutover-20260712T123456Z",
      });
      return options?.toPath ?? "";
    };
    driver.checkServerHealth = async () => {};

    await driver.releaseApply(profile);

    expect(releasePlanCalls).toBe(1);
    expect(
      calls.some(
        (args) =>
          args[0] === "tag" &&
          args[1] === "nautilo-server:local-dev" &&
          args[2] === "nautilo-server:first-cutover-20260712T123456Z",
      ),
    ).toBe(true);
    const state = JSON.parse(
      readFileSync(join(root, "release-state.json"), "utf8"),
    ) as unknown as ReleaseState;
    expect(state.legacy.archiveTag).toBe("nautilo-server:first-cutover-20260712T123456Z");
    expect(state.incoming.repoDigest).toContain("@sha256:incoming");
    expect(state.migrationsApplied).toBe(true);
    expect(state.recovery).toBe("full-bundle");
  });

  test("pins source→source upgrades before releasePlan with upgrade-pin tag", async () => {
    const root = tempDir();
    const order: string[] = [];
    const exec: ExecFn = async (_cmd, args) => {
      if (args[0] === "tag") order.push(`tag:${args[1]}→${args[2]}`);
      if (args[0] === "ps") return { code: 0, stdout: "server-container\n", stderr: "" };
      if (args[0] === "inspect") {
        return { code: 0, stdout: "sha256:legacy\nnautilo-server:local-dev\n\n", stderr: "" };
      }
      if (args[0] === "image") {
        return { code: 1, stdout: "", stderr: "no digest" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const driver = releaseDriverHarness(makeDriver(exec, root));
    driver.releasePlan = async () => {
      order.push("releasePlan");
      return {
        ...incomingPlan,
        artifact: {
          mode: "source",
          requested: "compose-source",
          immutableId: "sha256:incoming-source",
        },
      };
    };
    driver.assertArtifactVolumePresentOrMigrated = async () => {};
    driver.releaseServerAction = async () => {};
    driver.releaseServerUp = async () => {};
    driver.backup = async (_profile, options) => {
      expect(options?.releaseLegacyImage?.archiveTag).toBe(
        "nautilo-server:upgrade-pin-20260712T123456Z",
      );
      return options?.toPath ?? "";
    };
    driver.checkServerHealth = async () => {};

    await driver.releaseApply({ ...profile, from_source: true, tag: undefined });

    expect(order[0]).toBe("tag:nautilo-server:local-dev→nautilo-server:upgrade-pin-20260712T123456Z");
    expect(order[1]).toBe("releasePlan");
  });

  test("requires full-bundle recovery after incoming server starts", async () => {
    const root = tempDir();
    const exec: ExecFn = async (_cmd, args) => {
      if (args[0] === "ps") return { code: 0, stdout: "server-container\n", stderr: "" };
      if (args[0] === "inspect") {
        return { code: 0, stdout: "sha256:legacy\nnautilo-server:local-dev\n\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const driver = releaseDriverHarness(makeDriver(exec, root));
    driver.releasePlan = async () => incomingPlan;
    driver.assertArtifactVolumePresentOrMigrated = async () => {};
    driver.releaseServerAction = async () => {};
    const released: string[] = [];
    driver.releaseServerUp = async (_profile, artifact) => {
      released.push(artifact.immutableId);
    };
    driver.backup = async (_profile, options) => options?.toPath ?? "";
    driver.checkServerHealth = async () => {
      throw new Error("not ready");
    };

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(driver.releaseApply(profile)).rejects.toThrow(/full-bundle rollback failed/);
    expect(released).toEqual(["sha256:incoming"]);
  });
});

describe("D420 (2.2.5) releaseApply maintenance handle ordering", () => {
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

  // An exec that satisfies captureRunningServerArtifact (ps + inspect) and
  // returns success for everything else; lifecycle stop/start are recorded by
  // the stubbed releaseServerAction, not by exec.
  function captureExec(): ExecFn {
    return async (_cmd, args) => {
      if (args[0] === "ps") return { code: 0, stdout: "server-container\n", stderr: "" };
      if (args[0] === "inspect") {
        return { code: 0, stdout: "sha256:legacy\nnautilo-server:local-dev\n\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
  }

  test("transitions applying before stop; backup failure completes only after old-server health", async () => {
    const root = tempDir();
    const order: string[] = [];
    const base = makeDriver(captureExec(), root);
    const driver = releaseDriverHarness(base);
    driver.releasePlan = async () => incomingPlan;
    driver.assertArtifactVolumePresentOrMigrated = async () => {};
    const serverActions: Array<"stop" | "start"> = [];
    driver.releaseServerAction = async (_profile, action) => {
      serverActions.push(action);
      order.push(action);
    };
    driver.releaseServerUp = async () => {
      order.push("releaseServerUp");
    };
    let backupCalls = 0;
    driver.backup = async () => {
      backupCalls += 1;
      order.push("backup");
      throw new Error("pg_dump exited 1");
    };
    driver.checkServerHealth = async () => {
      order.push("health");
    };
    const handle = fakeMaintenanceHandle(order);

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(base.releaseApply(profile, undefined, handle)).rejects.toThrow(
      /pre-upgrade backup failed.*old server restarted.*post-restart health = ready.*maintenance lease cleared.*pg_dump exited 1/,
    );

    // applying runs immediately before stop; stop completes before backup
    // begins; backup fails; the previous server is restarted and health-proven;
    // only then is the lease completed. The incoming server is never started.
    expect(order).toEqual(["applying", "stop", "backup", "start", "health", "completeLease"]);
    expect(serverActions).toEqual(["stop", "start"]);
    expect(backupCalls).toBe(1);
    expect(order).not.toContain("releaseServerUp");
    expect(order).not.toContain("releaseLease");
  });

  test("retains applying when backup failure recovery health is unproven", async () => {
    const root = tempDir();
    const order: string[] = [];
    const base = makeDriver(captureExec(), root);
    const driver = releaseDriverHarness(base);
    driver.releasePlan = async () => incomingPlan;
    driver.assertArtifactVolumePresentOrMigrated = async () => {};
    driver.releaseServerAction = async (_profile, action) => {
      order.push(action);
    };
    driver.releaseServerUp = async () => {
      order.push("releaseServerUp");
    };
    driver.backup = async () => {
      order.push("backup");
      throw new Error("pg_dump exited 1");
    };
    driver.checkServerHealth = async () => {
      throw new Error("operator endpoint unavailable: timeout");
    };
    const handle = fakeMaintenanceHandle(order);

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(base.releaseApply(profile, undefined, handle)).rejects.toThrow(
      /CRITICAL.*backup failed.*recovery is unproven.*lease left in applying.*timeout.*pg_dump exited 1/,
    );
    expect(order).not.toContain("completeLease");
    expect(order).not.toContain("releaseLease");
  });

  test("applying transition failure aborts before stop/backup and releases the owning lease", async () => {
    const root = tempDir();
    const order: string[] = [];
    const base = makeDriver(captureExec(), root);
    const driver = releaseDriverHarness(base);
    driver.releasePlan = async () => incomingPlan;
    driver.assertArtifactVolumePresentOrMigrated = async () => {};
    const serverActions: Array<"stop" | "start"> = [];
    driver.releaseServerAction = async (_profile, action) => {
      serverActions.push(action);
    };
    driver.releaseServerUp = async () => {
      order.push("releaseServerUp");
    };
    let backupCalls = 0;
    driver.backup = async () => {
      backupCalls += 1;
      return "";
    };
    driver.checkServerHealth = async () => {};
    const handle = fakeMaintenanceHandle(order, {
      transitionError: () =>
        new Error("maintenance applying: maintenance transition refused (HTTP 409: not_owner)."),
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(base.releaseApply(profile, undefined, handle)).rejects.toThrow(/HTTP 409.*not_owner/);
    // Fail closed: the transition error propagates before any stop/backup,
    // then the owning lease is cancelled because no server mutation began.
    expect(order).toEqual(["applying", "releaseLease"]);
    expect(serverActions).toEqual([]);
    expect(backupCalls).toBe(0);
    expect(order).not.toContain("releaseServerUp");
  });

  test("successful server-only path completes the owning lease after health (no release)", async () => {
    const root = tempDir();
    const order: string[] = [];
    const base = makeDriver(captureExec(), root);
    const driver = releaseDriverHarness(base);
    driver.releasePlan = async () => incomingPlan;
    driver.assertArtifactVolumePresentOrMigrated = async () => {};
    driver.releaseServerAction = async (_profile, action) => {
      order.push(action);
    };
    driver.releaseServerUp = async () => {
      order.push("releaseServerUp");
    };
    driver.backup = async (_profile, options) => options?.toPath ?? "";
    driver.checkServerHealth = async () => {
      order.push("health");
    };
    const handle = fakeMaintenanceHandle(order);

    await base.releaseApply(profile, undefined, handle);

    // applying → stop → backup → releaseServerUp (starts the incoming server)
    // → health → completeLease. The lease is COMPLETED (not released) on
    // success, and completion runs AFTER the health check proves the new
    // deployment is healthy — never before. releaseServerAction only records
    // the pre-backup stop; the incoming server is started by releaseServerUp.
    expect(order).toEqual(["applying", "stop", "releaseServerUp", "health", "completeLease"]);
    expect(order).not.toContain("releaseLease");
    expect(order.indexOf("health")).toBeLessThan(order.indexOf("completeLease"));
  });

  test("successful server-only path: a failed completion is reported honestly and the lease is not released", async () => {
    const root = tempDir();
    const order: string[] = [];
    const logLines: string[] = [];
    const base = makeDriver(captureExec(), root);
    const driver = releaseDriverHarness(base);
    driver.releasePlan = async () => incomingPlan;
    driver.assertArtifactVolumePresentOrMigrated = async () => {};
    driver.releaseServerAction = async () => {};
    driver.releaseServerUp = async () => {};
    driver.backup = async (_profile, options) => options?.toPath ?? "";
    driver.checkServerHealth = async () => {};
    const handle = fakeMaintenanceHandle(order, {
      completeError: () =>
        new Error("maintenance complete: operator endpoint unavailable: connection reset"),
    });
    // Capture the driver log to assert the honest completion-failure report.
    (base as unknown as { deps: { log: (msg: string) => void } }).deps.log = (msg) =>
      logLines.push(msg);

    // A failed completion does NOT turn a successful release into a failure:
    // the new deployment is healthy. The failure is reported honestly (the
    // lease is left in applying for hard-expiry to reclaim) and never claimed
    // "cleared"; the lease is not released (cancel) either.
    await base.releaseApply(profile, undefined, handle);

    expect(order).toContain("completeLease");
    expect(order).not.toContain("releaseLease");
    expect(
      logLines.some(
        (line) => line.includes("maintenance lease completion failed") && line.includes("connection reset"),
      ),
    ).toBe(true);
    expect(logLines.some((line) => line.includes("lease cleared"))).toBe(false);
  });
});

// D420 (Wave 3 task 3.1.2) — unified full-bundle rollback for the server-only
// releaseApply lane. These tests prove the pre-migration deploy/startup branch
// now shares the SAME full-bundle rollback semantics as the post-migration
// health-failure branch and the full upgrade path: restore DB/config/volumes +
// the prior immutable image, then health-check the restored server. A restore
// error is never swallowed and rollback is never claimed unless health is
// proven; `--no-rollback` is the only opt-out. The bundle dir for the local
// harness is `<root>/backups/auto-pre-release-20260712T123456Z` (the deps
// `now()` is pinned to 2026-07-12T12:34:56Z).

// Hoisted to module scope so both the 3.1.2 rollback proof and the 3.1.3
// completion-fencing proof (which wires a maintenance handle into the same
// rollback lane) can share the identical stubs.
function releaseRollbackBundleDir(root: string): string {
  return join(root, "backups", "auto-pre-release-20260712T123456Z");
}

// Stubs everything releaseApply touches before the rollback decision, so the
// tests can focus on the rollback contract. `releaseServerUp`/`checkServerHealth`
// are set per-test to drive the failure phase.
function wireRollbackHarness(
  root: string,
  over: {
    releaseServerUp?: (artifact: ReleaseArtifact) => void | Promise<void>;
    health?: (call: number) => void;
    restore?: (profile: ComposeDriverProfile, opts: RestoreOptions) => void | Promise<void>;
    plan?: ReleasePlanReport;
  },
): {
  base: ComposeDriver;
  driver: ReleaseDriverHarness;
  restoreCalls: Array<{ profile: ComposeDriverProfile; opts: RestoreOptions }>;
  healthState: { calls: number };
} {
  const exec: ExecFn = async (_cmd, args) => {
    if (args[0] === "ps") return { code: 0, stdout: "server-container\n", stderr: "" };
    if (args[0] === "inspect") {
      return { code: 0, stdout: "sha256:legacy\nnautilo-server:local-dev\n\n", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const base = makeDriver(exec, root);
  const driver = releaseDriverHarness(base);
  driver.releasePlan = async () => over.plan ?? incomingPlan;
  driver.assertArtifactVolumePresentOrMigrated = async () => {};
  driver.releaseServerAction = async () => {};
  const restoreCalls: Array<{ profile: ComposeDriverProfile; opts: RestoreOptions }> = [];
  const healthState = { calls: 0 };
  driver.releaseServerUp = async (_profile, artifact) => {
    if (over.releaseServerUp) await over.releaseServerUp(artifact);
  };
  driver.backup = async (_profile, options) => options?.toPath ?? "";
  driver.restore = async (profile, opts) => {
    restoreCalls.push({ profile, opts });
    if (over.restore) await over.restore(profile, opts);
  };
  driver.checkServerHealth = async () => {
    healthState.calls += 1;
    if (over.health) over.health(healthState.calls);
  };
  return { base, driver, restoreCalls, healthState };
}

describe("D420 (3.1.2) releaseApply unified full-bundle rollback", () => {
  const bundleDir = releaseRollbackBundleDir;

  test("pre-migration deploy failure restores the bundle + prior image and proves rollback health", async () => {
    const root = tempDir();
    const { base, restoreCalls } = wireRollbackHarness(root, {
      releaseServerUp: () => {
        throw new Error("incoming server did not start");
      },
      health: () => {
        /* post-rollback health = ready */
      },
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(base.releaseApply(profile)).rejects.toThrow(
      /full-bundle rollback succeeded.*rolled back to the prior image.*post-rollback health = ready/,
    );

    expect(restoreCalls).toHaveLength(1);
    expect(restoreCalls[0]!.opts).toEqual({ fromPath: bundleDir(root), force: true });
  });

  test("post-migration health failure restores the bundle + prior image and proves rollback health", async () => {
    const root = tempDir();
    const { base, restoreCalls, healthState } = wireRollbackHarness(root, {
      releaseServerUp: () => {
        /* incoming starts; migrations may have applied */
      },
      health: (call) => {
        if (call === 1) throw new Error("incoming not ready");
        // post-rollback health = ready
      },
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(base.releaseApply(profile)).rejects.toThrow(
      /after migrations may have applied.*full-bundle rollback succeeded.*post-rollback health = ready/,
    );

    expect(restoreCalls).toHaveLength(1);
    expect(restoreCalls[0]!.opts).toEqual({ fromPath: bundleDir(root), force: true });
    expect(healthState.calls).toBe(2);
  });

  test("restore failure during pre-migration rollback is surfaced as CRITICAL, never swallowed", async () => {
    const root = tempDir();
    const { base, healthState } = wireRollbackHarness(root, {
      releaseServerUp: () => {
        throw new Error("incoming did not start");
      },
      restore: () => {
        throw new Error("gunzip failed on nautilo.sql.gz");
      },
      health: () => {
        throw new Error("health should not be reached when restore failed");
      },
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(base.releaseApply(profile)).rejects.toThrow(
      /CRITICAL.*full-bundle rollback failed.*post-rollback health = FAILED.*gunzip failed on nautilo\.sql\.gz.*incoming did not start/,
    );
    // The restore error propagated: health was never attempted after restore threw.
    expect(healthState.calls).toBe(0);
  });

  test("post-rollback health failure is surfaced as CRITICAL (restore succeeded, health did not)", async () => {
    const root = tempDir();
    const { base, healthState } = wireRollbackHarness(root, {
      releaseServerUp: () => {
        throw new Error("incoming did not start");
      },
      restore: () => {
        /* restore succeeds */
      },
      health: () => {
        throw new Error("still broken");
      },
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(base.releaseApply(profile)).rejects.toThrow(
      /CRITICAL.*full-bundle rollback failed.*post-rollback health = FAILED.*still broken.*incoming did not start/,
    );
    expect(healthState.calls).toBe(1);
  });

  test("--no-rollback leaves the failed target and emits explicit recovery-bundle guidance", async () => {
    const root = tempDir();
    const { base, restoreCalls } = wireRollbackHarness(root, {
      releaseServerUp: () => {
        throw new Error("incoming did not start");
      },
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(base.releaseApply(profile, { noRollback: true })).rejects.toThrow(
      /--no-rollback.*leaving the failed target as-is.*auto-pre-release-20260712T123456Z.*nautilo restore.*incoming did not start/,
    );
    // No restore is attempted: the failed target is left in place.
    expect(restoreCalls).toHaveLength(0);
  });

  test("server-only source artifact pre-migration failure uses the same full-bundle rollback", async () => {
    const root = tempDir();
    const sourcePlan: ReleasePlanReport = {
      artifact: {
        mode: "source",
        requested: "compose-source",
        immutableId: "sha256:incoming-source",
      },
      auth: {} as ReleasePlanReport["auth"],
      compatible: true,
      limitations: [],
    };
    const released: string[] = [];
    const { base, restoreCalls } = wireRollbackHarness(root, {
      plan: sourcePlan,
      releaseServerUp: (artifact) => {
        released.push(artifact.mode);
        throw new Error("source build did not start");
      },
      health: () => {
        /* post-rollback health = ready */
      },
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(base.releaseApply(profile)).rejects.toThrow(
      /full-bundle rollback succeeded.*post-rollback health = ready/,
    );
    expect(released).toEqual(["source"]);
    expect(restoreCalls).toHaveLength(1);
    expect(restoreCalls[0]!.opts).toEqual({ fromPath: bundleDir(root), force: true });
  });
});

// D420 (Wave 3 task 3.1.2) — prove snapshot + prior-image restoration for the
// server-only lane through a REAL remote bundle restore (not just a method
// call). The remote registry bundle restore re-pins the prior image via a
// `deploy.restore-overlay.yml` compose overlay and rsyncs the snapshot bundle
// to the remote staging dir; these tests assert those commands actually run.
describe("D420 (3.1.2) releaseApply remote real-bundle rollback restores snapshot + prior image", () => {
  const remoteProfile: ComposeDriverProfile = {
    name: "remote-rollback",
    transport: "remote",
    lifecycle: "compose",
    from_source: false,
    tag: "main",
    ssh: { host: "1.2.3.4", user: "root" },
  };

  function remoteManifest(remoteRoot: string): RemoteDeploymentManifest {
    return {
      version: 1,
      instanceId: "",
      composeProjectName: "nautilo",
      lifecycle: "compose",
      image: {
        mode: "registry",
        reference: "ghcr.io/agentsea/nautilo-server:main",
      },
      remoteRoot,
      https: "off",
      createdAt: "2026-07-12T12:00:00.000Z",
      updatedAt: "2026-07-12T12:30:00.000Z",
    } as RemoteDeploymentManifest;
  }

  function writeBundle(bundlePath: string): void {
    mkdirSync(bundlePath, { recursive: true });
    writeFileSync(join(bundlePath, "nautilo.sql.gz"), "");
    writeFileSync(join(bundlePath, "logto_nautilo.sql.gz"), "");
    writeFileSync(join(bundlePath, "artifacts.tgz"), "");
    writeFileSync(join(bundlePath, "instance.env"), "LOGTO_ENDPOINT=http://localhost:3301\n");
    writeFileSync(
      join(bundlePath, "manifest.json"),
      JSON.stringify({
        version: 1,
        createdAt: "2026-07-12T12:34:56.000Z",
        profileName: remoteProfile.name,
        instanceId: "",
        transport: "remote",
        composeProjectName: "nautilo",
        image: {
          mode: "registry",
          repoDigest: "ghcr.io/agentsea/nautilo-server@sha256:prior",
          tag: "main",
        },
        contents: {
          nautiloDb: true,
          logtoDb: true,
          artifacts: true,
          instanceEnv: true,
          operatorFiles: false,
          caddyData: false,
          caddyConfig: false,
          localCaCerts: false,
        },
        https: "off",
      }),
    );
  }

  interface RemoteCall {
    cmd: string;
    args: string[];
  }

  function remoteExecResponder(events: string[]): (call: RemoteCall) => ExecResult {
    return (call) => {
      if (call.cmd === "cat") {
        return { code: 0, stdout: JSON.stringify(remoteManifest("/opt/nautilo")), stderr: "" };
      }
      const script = call.args[1] ?? "";
      if (call.cmd === "sh" && script.includes("docker compose")) {
        if (script.includes("pull")) events.push("pull");
        else if (script.includes("up -d") && script.includes("--no-build")) events.push("up");
        else if (script.includes("stop")) events.push("stop");
        else if (script.includes("start")) events.push("start");
      }
      return { code: 0, stdout: "", stderr: "" };
    };
  }

  function makeRemoteDriver(
    root: string,
    bundlePath: string,
    events: string[],
    rsyncCalls: RemoteCall[],
    composeScripts: string[],
  ): ComposeDriver {
    // restoreRemoteBundle reads infra/postgres-init.sh from
    // the template tree (relative to templateDir), so mirror the real repo
    // layout under <root>/repo.
    const templateDir = join(root, "repo", "deploy", "compose-driver", "templates");
    mkdirSync(templateDir, { recursive: true });
    writeFileSync(join(templateDir, "docker-compose.yml"), "# unit-test template marker\n");
    const infraDir = join(root, "repo", "infra");
    mkdirSync(infraDir, { recursive: true });
    writeFileSync(join(infraDir, "postgres-init.sh"), "#!/bin/sh\n");

    const execCalls: RemoteCall[] = [];
    const exec: ExecFn = async (cmd, args) => {
      const call: RemoteCall = { cmd, args };
      execCalls.push(call);
      const script = call.args[1] ?? "";
      if (call.cmd === "sh" && script.includes("docker compose")) {
        composeScripts.push(script);
      }
      return remoteExecResponder(events)(call);
    };
    const localExec: ExecFn = async (cmd, args) => {
      const call: RemoteCall = { cmd, args };
      if (call.cmd === "rsync" && call.args[0] !== "--version") {
        rsyncCalls.push(call);
      }
      return call.cmd === "rsync" && call.args[0] === "--version"
        ? { code: 0, stdout: "rsync  version 3.2.7\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" };
    };
    const deps: ComposeDriverDeps = {
      exec,
      localExec,
      fetch: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch,
      runBootstrap: async () => undefined,
      fs: nodeFs,
      now: () => new Date("2026-07-12T12:34:56.000Z"),
      pollIntervalMs: 1,
      logtoHealthTimeoutMs: 1000,
      serverHealthTimeoutMs: 1000,
      templateDir,
      resolveInstanceRootDir: () => "/opt/nautilo",
      resolveLocalInstanceRootDir: () => root,
      ensureDbPasswords: async () => ({
        appDbPassword: "app",
        postgresPassword: "postgres",
        nautilo: "nautilo",
        logto: "logto",
        nautiloAgent: "agent",
        nautiloCrypto: "fake_crypto_pw",
      }),
    };
    const base = new ComposeDriver(deps);
    const driver = releaseDriverHarness(base);
    driver.releasePlan = async () => incomingPlan;
    driver.assertRemoteArtifactVolumePresentOrMigrated = async () => {};
    driver.readRemoteDeploymentManifest = async () => remoteManifest("/opt/nautilo");
    driver.captureRunningServerArtifact = async () => ({
      mode: "registry",
      requested: "ghcr.io/agentsea/nautilo-server:main",
      immutableId: "sha256:legacy",
      repoDigest: "ghcr.io/agentsea/nautilo-server@sha256:legacy",
    });
    driver.releaseServerAction = async () => {};
    driver.backup = async () => bundlePath;
    // NOTE: driver.restore is intentionally NOT stubbed — the real
    // restoreRemoteBundle path runs so the test asserts actual snapshot +
    // prior-image restoration commands, not just a method call.
    return base;
  }

  test("pre-migration deploy failure rolls back through the real remote bundle restore", async () => {
    const root = tempDir();
    const bundlePath = join(root, "backups", "auto-pre-release-20260712T123456Z");
    writeBundle(bundlePath);
    const events: string[] = [];
    const rsyncCalls: RemoteCall[] = [];
    const composeScripts: string[] = [];
    const base = makeRemoteDriver(root, bundlePath, events, rsyncCalls, composeScripts);
    const driver = releaseDriverHarness(base);
    driver.releaseServerUp = async () => {
      throw new Error("incoming server did not start");
    };
    driver.checkServerHealth = async () => {
      events.push("re-health");
    };

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(base.releaseApply(remoteProfile)).rejects.toThrow(
      /full-bundle rollback succeeded.*rolled back to the prior image.*post-rollback health = ready/,
    );

    // The prior image is re-pinned by the restore overlay compose commands.
    expect(events).toContain("up");
    expect(events.filter((e) => e === "stop").length).toBeGreaterThanOrEqual(1);
    expect(events.filter((e) => e === "start").length).toBeGreaterThanOrEqual(1);
    expect(events[events.length - 1]).toBe("re-health");
    expect(composeScripts.some((s) => s.includes("deploy.restore-overlay.yml"))).toBe(true);
    // The snapshot bundle is actually transferred to the remote staging dir.
    expect(rsyncCalls.some((c) => (c.args.join(" ")).includes(bundlePath))).toBe(true);
  });

  test("post-migration health failure rolls back through the real remote bundle restore", async () => {
    const root = tempDir();
    const bundlePath = join(root, "backups", "auto-pre-release-20260712T123456Z");
    writeBundle(bundlePath);
    const events: string[] = [];
    const rsyncCalls: RemoteCall[] = [];
    const composeScripts: string[] = [];
    const base = makeRemoteDriver(root, bundlePath, events, rsyncCalls, composeScripts);
    const driver = releaseDriverHarness(base);
    driver.releaseServerUp = async () => {
      /* incoming starts; migrations may have applied */
    };
    let healthCalls = 0;
    driver.checkServerHealth = async () => {
      healthCalls += 1;
      if (healthCalls === 1) throw new Error("incoming not ready");
      events.push("re-health");
    };

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(base.releaseApply(remoteProfile)).rejects.toThrow(
      /after migrations may have applied.*full-bundle rollback succeeded.*post-rollback health = ready/,
    );

    expect(events).toContain("up");
    expect(events.filter((e) => e === "stop").length).toBeGreaterThanOrEqual(1);
    expect(events.filter((e) => e === "start").length).toBeGreaterThanOrEqual(1);
    expect(events[events.length - 1]).toBe("re-health");
    expect(composeScripts.some((s) => s.includes("deploy.restore-overlay.yml"))).toBe(true);
    expect(rsyncCalls.some((c) => c.args.join(" ").includes(bundlePath))).toBe(true);
  });
});

// D420 (Wave 3 task 3.1.3) — maintenance completion fencing for the
// server-only releaseApply lane. Completion of the owning lease happens ONLY
// after a healthy rollback (restore + rollback health), never on an unproven
// state. `--no-rollback`, a restore failure, and a rollback-health failure
// (double failure) retain `applying` for hard-expiry to reclaim; no
// completion or cancel is attempted. The exact recovery bundle path is
// preserved in every failure message.
describe("D420 (3.1.3) releaseApply maintenance completion fencing", () => {
  const bundleDir = releaseRollbackBundleDir;

  function fakeHandle(
    order: string[],
    opts: { completeError?: () => Error } = {},
  ): MaintenanceDrainHandle {
    return {
      operationId: "op-test",
      transitionApplying: async () => {
        order.push("applying");
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

  test("healthy rollback completes the lease AFTER rollback health (not before)", async () => {
    const root = tempDir();
    const order: string[] = [];
    const { base, healthState } = wireRollbackHarness(root, {
      releaseServerUp: () => {
        throw new Error("incoming server did not start");
      },
      health: () => {
        /* post-rollback health = ready */
      },
    });
    const handle = fakeHandle(order);

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(base.releaseApply(profile, undefined, handle)).rejects.toThrow(
      /full-bundle rollback succeeded.*post-rollback health = ready.*maintenance lease cleared.*incoming server did not start/,
    );

    expect(order).toContain("completeLease");
    expect(order).not.toContain("releaseLease");
    // The only health call is the rollback health check; completion runs after.
    expect(healthState.calls).toBe(1);
  });

  test("double failure (restore fails) retains applying; no completion or cancel attempted", async () => {
    const root = tempDir();
    const order: string[] = [];
    const { base, healthState } = wireRollbackHarness(root, {
      releaseServerUp: () => {
        throw new Error("incoming did not start");
      },
      restore: () => {
        throw new Error("gunzip failed on nautilo.sql.gz");
      },
      health: () => {
        throw new Error("health should not be reached when restore failed");
      },
    });
    const handle = fakeHandle(order);

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(base.releaseApply(profile, undefined, handle)).rejects.toThrow(
      /CRITICAL.*full-bundle rollback failed.*post-rollback health = FAILED.*maintenance lease left in applying.*gunzip failed.*incoming did not start/,
    );

    expect(order).not.toContain("completeLease");
    expect(order).not.toContain("releaseLease");
    expect(healthState.calls).toBe(0);
  });

  test("post-rollback health failure retains applying; no completion or cancel attempted", async () => {
    const root = tempDir();
    const order: string[] = [];
    const { base, healthState } = wireRollbackHarness(root, {
      releaseServerUp: () => {
        throw new Error("incoming did not start");
      },
      restore: () => {
        /* restore succeeds */
      },
      health: () => {
        throw new Error("still broken");
      },
    });
    const handle = fakeHandle(order);

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(base.releaseApply(profile, undefined, handle)).rejects.toThrow(
      /CRITICAL.*full-bundle rollback failed.*post-rollback health = FAILED.*maintenance lease left in applying.*still broken.*incoming did not start/,
    );

    expect(order).not.toContain("completeLease");
    expect(order).not.toContain("releaseLease");
    expect(healthState.calls).toBe(1);
  });

  test("--no-rollback retains applying and reports the exact bundle; no completion or restore", async () => {
    const root = tempDir();
    const order: string[] = [];
    const { base, restoreCalls } = wireRollbackHarness(root, {
      releaseServerUp: () => {
        throw new Error("incoming did not start");
      },
    });
    const handle = fakeHandle(order);

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(base.releaseApply(profile, { noRollback: true }, handle)).rejects.toThrow(
      /--no-rollback.*leaving the failed target as-is.*maintenance lease left in applying.*auto-pre-release-20260712T123456Z.*nautilo restore.*incoming did not start/,
    );

    expect(order).not.toContain("completeLease");
    expect(order).not.toContain("releaseLease");
    expect(restoreCalls).toHaveLength(0);
  });

  test("healthy rollback: a failed completion is reported honestly (lease not cleared, not released)", async () => {
    const root = tempDir();
    const order: string[] = [];
    const { base } = wireRollbackHarness(root, {
      releaseServerUp: () => {
        throw new Error("incoming did not start");
      },
      health: () => {
        /* post-rollback health = ready */
      },
    });
    const handle = fakeHandle(order, {
      completeError: () =>
        new Error("maintenance complete: operator endpoint refused authorization (HTTP 403)."),
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(base.releaseApply(profile, undefined, handle)).rejects.toThrow(
      /full-bundle rollback succeeded.*post-rollback health = ready.*maintenance lease completion failed.*HTTP 403.*incoming did not start/,
    );

    expect(order).toContain("completeLease");
    expect(order).not.toContain("releaseLease");
    expect(bundleDir(root)).toContain("auto-pre-release-20260712T123456Z");
  });
});

// D420 (Wave 3 task 3.3.1) — fault-inject the artifact/source PREPARATION phase
// of the server-only releaseApply transaction. Preparation (releasePlan +
// running-image capture) runs BEFORE the owning lease transitions to applying
// and BEFORE any stop/backup/start mutation, so a preparation failure must
// resolve to a deterministic no-mutation outcome: the lease is cancelled
// immediately without transitioning to applying, and no server lifecycle /
// backup / incoming-server-up / restore mutation runs. This is the fail-closed
// counterpart to the post-backup rollback proofs above: every failure either
// reaches the new healthy state, rolls back to the proven prior state, or
// aborts with zero mutation and an honest operator message — never a partial
// mutation.

function wireReleasePreparationHarness(
  root: string,
  opts: {
    plan?: ReleasePlanReport;
    planThrow?: () => Error;
    captureFail?: boolean;
  } = {},
): {
  base: ComposeDriver;
  mutationCalls: { stop: number; start: number; backup: number; up: number; restore: number };
  order: string[];
} {
  const order: string[] = [];
  const exec: ExecFn = async (_cmd, args) => {
    if (args[0] === "ps") {
      return opts.captureFail
        ? { code: 1, stdout: "", stderr: "no containers" }
        : { code: 0, stdout: "server-container\n", stderr: "" };
    }
    if (args[0] === "inspect") {
      return { code: 0, stdout: "sha256:legacy\nnautilo-server:local-dev\n\n", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const base = makeDriver(exec, root);
  const driver = releaseDriverHarness(base);
  driver.releasePlan = async () => {
    if (opts.planThrow) throw opts.planThrow();
    return opts.plan ?? incomingPlan;
  };
  driver.assertArtifactVolumePresentOrMigrated = async () => {};
  const mutationCalls = { stop: 0, start: 0, backup: 0, up: 0, restore: 0 };
  driver.releaseServerAction = async (_profile, action) => {
    if (action === "stop") mutationCalls.stop += 1;
    else mutationCalls.start += 1;
    order.push(action);
  };
  driver.releaseServerUp = async () => {
    mutationCalls.up += 1;
    order.push("releaseServerUp");
  };
  driver.backup = async () => {
    mutationCalls.backup += 1;
    order.push("backup");
    return "";
  };
  driver.restore = async () => {
    mutationCalls.restore += 1;
    order.push("restore");
  };
  driver.checkServerHealth = async () => {
    order.push("health");
  };
  return { base, mutationCalls, order };
}

describe("D420 (3.3.1) releaseApply artifact/source preparation failures", () => {
  function preparationHandle(
    order: string[],
    releaseError?: string,
  ): MaintenanceDrainHandle {
    return {
      operationId: "op-prep",
      transitionApplying: async () => {
        order.push("applying");
      },
      releaseLease: async () => {
        order.push("releaseLease");
        return releaseError
          ? { cancelled: false, error: releaseError }
          : { cancelled: true };
      },
      completeLease: async () => {
        order.push("completeLease");
        return { completed: true };
      },
    };
  }

  const noMutation = { stop: 0, start: 0, backup: 0, up: 0, restore: 0 };

  test("unknown auth plan aborts before mutation and clears the draining lease", async () => {
    const root = tempDir();
    const order: string[] = [];
    const unknownPlan: ReleasePlanReport = {
      ...incomingPlan,
      compatible: false,
      auth: {
        ...(incomingPlan.auth as object),
        classification: "unknown",
      } as ReleasePlanReport["auth"],
    };
    const { base, mutationCalls } = wireReleasePreparationHarness(root, {
      plan: unknownPlan,
    });
    const handle = preparationHandle(order);

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(base.releaseApply(profile, undefined, handle)).rejects.toThrow(
      /nautilo upgrade refused: auth plan is unknown.*run `nautilo auth plan`/,
    );

    // Preparation failed before the applying transition: no stop/backup/start,
    // no incoming-server up, no restore, and the draining lease is cancelled.
    expect(order).toEqual(["releaseLease"]);
    expect(mutationCalls).toEqual(noMutation);
  });

  test("releasePlan throw propagates before mutation and clears the draining lease", async () => {
    const root = tempDir();
    const order: string[] = [];
    const { base, mutationCalls } = wireReleasePreparationHarness(root, {
      planThrow: () => new Error("artifact resolution failed: registry manifest unreachable"),
    });
    const handle = preparationHandle(order);

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(base.releaseApply(profile, undefined, handle)).rejects.toThrow(
      /artifact resolution failed: registry manifest unreachable/,
    );

    expect(order).toEqual(["releaseLease"]);
    expect(mutationCalls).toEqual(noMutation);
  });

  test("running-image capture failure aborts before stop/backup and clears the draining lease", async () => {
    const root = tempDir();
    const order: string[] = [];
    const { base, mutationCalls } = wireReleasePreparationHarness(root, {
      captureFail: true,
    });
    const handle = preparationHandle(order);

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(base.releaseApply(profile, undefined, handle)).rejects.toThrow(
      /nautilo upgrade refused: could not identify the running nautilo-server image/,
    );

    // Capture/pin runs before releasePlan; failure aborts before prepare/build,
    // the applying transition, stop, backup, or any incoming-server mutation.
    expect(order).toEqual(["releaseLease"]);
    expect(mutationCalls).toEqual(noMutation);
  });

  test("lease-release failure preserves the original refusal and reports hard-expiry recovery", async () => {
    const root = tempDir();
    const order: string[] = [];
    const unknownPlan: ReleasePlanReport = {
      ...incomingPlan,
      compatible: false,
      auth: {
        ...(incomingPlan.auth as object),
        classification: "unknown",
      } as ReleasePlanReport["auth"],
    };
    const { base, mutationCalls } = wireReleasePreparationHarness(root, {
      plan: unknownPlan,
    });
    const handle = preparationHandle(order, "operator endpoint refused authorization (HTTP 403)");

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(base.releaseApply(profile, undefined, handle)).rejects.toThrow(
      /auth plan is unknown.*lease release failed.*hard-expiry.*HTTP 403/,
    );

    expect(order).toEqual(["releaseLease"]);
    expect(mutationCalls).toEqual(noMutation);
  });
});
