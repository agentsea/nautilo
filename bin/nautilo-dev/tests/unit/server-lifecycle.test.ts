import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  buildServerDaemonEnv,
  checkFirstPartyAppPrerequisitesForServerStart,
  checkWorkbenchDistForServerStart,
  daemonLaunchFrom,
  fetchServerHealth,
  HEALTH_WAIT_MS,
  parseDaemonLauncherPid,
  readDaemonLauncherPid,
  runServerStart,
  serverDaemonEnv,
  type DaemonLaunch,
  type ServerStartDeps,
} from "../../src/commands/server-start";
import { runServerStop, type ServerStopDeps } from "../../src/commands/server-stop";
import { runServerStatus, type ServerStatusDeps } from "../../src/commands/server-status";

const paths = {
  pidPath: "/tmp/nautilo-test/server.pid",
  logPath: "/tmp/nautilo-test/logs/nautilo-server.log",
  serverUrl: "http://127.0.0.1:3001",
};

describe("fetchServerHealth", () => {
  test("returns an accepted health status", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ status: "ready" }), {
        status: 200,
      })) as unknown as typeof fetch;

    expect(
      await fetchServerHealth("http://127.0.0.1:3001/health", { fetchImpl }),
    ).toEqual({ ok: true, status: "ready" });
  });

  test("times out an accepted connection that never responds", async () => {
    const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("health probe aborted")),
          { once: true },
        );
      })) as typeof fetch;

    expect(
      await fetchServerHealth("http://127.0.0.1:3001/health", {
        fetchImpl,
        timeoutMs: 10,
      }),
    ).toEqual({ ok: false });
  });
});

describe("runServerStart", () => {
  test("missing first-party prerequisites prevent a new daemon and runtime provisioning", async () => {
    const events: string[] = [];
    const result = await runServerStart({
      paths, readPidFile: () => null, writePidFile: () => {}, removePidFile: () => {},
      isProcessAlive: () => false, findListenerPid: () => null, looksLikeNautiloServer: () => false,
      fetchHealth: async () => ({ ok: false }),
      checkFirstPartyAppPrerequisites: () => { events.push("first-party-check"); return false; },
      provisionOfficeCli: () => { events.push("officecli"); },
      provisionAgentBrowser: async () => { events.push("browser"); return true; },
      spawnDaemon: () => { events.push("spawn"); }, log: () => {}, warn: () => {},
      now: () => 0, sleep: async () => {}, killPid: () => {},
    });

    expect(result).toBe(1);
    expect(events).toEqual(["first-party-check"]);
  });

  test("browser provisioning failure prevents daemon launch and ready reporting", async () => {
    const events: string[] = [];
    const result = await runServerStart({
      paths, readPidFile: () => null, writePidFile: () => {}, removePidFile: () => {},
      isProcessAlive: () => false, findListenerPid: () => null, looksLikeNautiloServer: () => false,
      fetchHealth: async () => ({ ok: false }), provisionOfficeCli: () => {},
      provisionAgentBrowser: async () => false,
      spawnDaemon: () => { events.push("spawn"); }, log: (s) => { events.push(s); },
      warn: (s) => { events.push(s); }, now: () => 0, sleep: async () => {}, killPid: () => {},
    });
    expect(result).toBe(1);
    expect(events).toEqual(["[server:start] server browser provisioning failed; refusing to start an incomplete runtime"]);
  });
  test("already running and healthy returns 0 without spawning", async () => {
    let spawned = false;
    let provisioned = false;
    const deps: ServerStartDeps = {
      paths,
      readPidFile: () => 111,
      writePidFile: () => {},
      removePidFile: () => {},
      isProcessAlive: () => true,
      spawnDaemon: () => {
        spawned = true;
      },
      fetchHealth: async () => ({ ok: true, status: "ok" }),
      findListenerPid: () => 111,
      looksLikeNautiloServer: () => true,
      provisionAgentBrowser: async () => { provisioned = true; return true; },
      provisionOfficeCli: () => {
        provisioned = true;
      },
      log: () => {},
      warn: () => {},
      now: () => 0,
      sleep: async () => {},
      killPid: () => {},
    };
    expect(await runServerStart(deps)).toBe(0);
    expect(spawned).toBe(false);
    expect(provisioned).toBe(false);
  });

  test("stale PID is removed then daemon is spawned and health succeeds", async () => {
    let pidReads = 0;
    let removed = false;
    let spawned = false;
    let provisioned = false;
    const startupOrder: string[] = [];
    let healthCalls = 0;
    const deps: ServerStartDeps = {
      paths,
      readPidFile: () => {
        pidReads += 1;
        if (pidReads === 1) return 222;
        return 333;
      },
      writePidFile: () => {},
      removePidFile: () => {
        removed = true;
      },
      isProcessAlive: (pid) => pid === 333,
      spawnDaemon: () => {
        spawned = true;
        startupOrder.push("spawn");
      },
      fetchHealth: async () => {
        healthCalls += 1;
        if (healthCalls === 1) {
          return { ok: false };
        }
        if (healthCalls === 2) {
          // foreign-listener probe before spawn — nothing on the port yet
          return { ok: false };
        }
        return { ok: true, status: "ok" };
      },
      findListenerPid: () => null,
      looksLikeNautiloServer: () => false,
      provisionOfficeCli: () => {
        provisioned = true;
        startupOrder.push("officecli");
      },
      provisionAgentBrowser: async () => { startupOrder.push("browser"); return true; },
      log: () => {},
      warn: () => {},
      now: () => 0,
      sleep: async () => {},
      killPid: () => {},
    };
    expect(await runServerStart(deps)).toBe(0);
    expect(removed).toBe(true);
    expect(spawned).toBe(true);
    expect(provisioned).toBe(true);
    expect(startupOrder).toEqual(["officecli", "browser", "spawn"]);
  });

  test("foreign nautilo server without PID file is CLAIMED (PID file written, no spawn)", async () => {
    let spawned = false;
    let provisioned = false;
    const writes: number[] = [];
    const logs: string[] = [];
    const deps: ServerStartDeps = {
      paths,
      readPidFile: () => null,
      writePidFile: (pid) => {
        writes.push(pid);
      },
      removePidFile: () => {},
      isProcessAlive: () => false,
      spawnDaemon: () => {
        spawned = true;
      },
      fetchHealth: async () => ({ ok: true, status: "ok" }),
      findListenerPid: () => 5150,
      looksLikeNautiloServer: () => true,
      provisionAgentBrowser: async () => { provisioned = true; return true; },
      provisionOfficeCli: () => {
        provisioned = true;
      },
      log: (s) => {
        logs.push(s);
      },
      warn: () => {},
      now: () => 0,
      sleep: async () => {},
      killPid: () => {},
    };
    expect(await runServerStart(deps)).toBe(0);
    expect(spawned).toBe(false);
    expect(provisioned).toBe(false);
    expect(writes).toEqual([5150]);
    expect(logs.some((l) => l.includes("claimed existing server (pid=5150)"))).toBe(true);
  });

  test("foreign listener that does NOT look like nautilo returns 0 with refusal warn", async () => {
    let spawned = false;
    let pidWritten = false;
    const warns: string[] = [];
    const deps: ServerStartDeps = {
      paths,
      readPidFile: () => null,
      writePidFile: () => {
        pidWritten = true;
      },
      removePidFile: () => {},
      isProcessAlive: () => false,
      spawnDaemon: () => {
        spawned = true;
      },
      fetchHealth: async () => ({ ok: true, status: "ok" }),
      findListenerPid: () => 9090,
      looksLikeNautiloServer: () => false,
      provisionAgentBrowser: async () => true,
      provisionOfficeCli: () => {},
      log: () => {},
      warn: (s) => {
        warns.push(s);
      },
      now: () => 0,
      sleep: async () => {},
      killPid: () => {},
    };
    expect(await runServerStart(deps)).toBe(0);
    expect(spawned).toBe(false);
    expect(pidWritten).toBe(false);
    expect(warns.some((w) => w.includes("does not look like nautilo-server"))).toBe(true);
  });

  test("alive but unhealthy returns 0 without spawning", async () => {
    let spawned = false;
    const warns: string[] = [];
    const deps: ServerStartDeps = {
      paths,
      readPidFile: () => 444,
      writePidFile: () => {},
      removePidFile: () => {},
      isProcessAlive: () => true,
      spawnDaemon: () => {
        spawned = true;
      },
      fetchHealth: async () => ({ ok: false }),
      findListenerPid: () => 444,
      looksLikeNautiloServer: () => true,
      provisionAgentBrowser: async () => true,
      provisionOfficeCli: () => {},
      log: () => {},
      warn: (s) => {
        warns.push(s);
      },
      now: () => 0,
      sleep: async () => {},
      killPid: () => {},
    };
    expect(await runServerStart(deps)).toBe(0);
    expect(spawned).toBe(false);
    expect(warns.some((w) => w.includes("not ready"))).toBe(true);
  });

  test("health wait timeout returns 1 and kills PID from file", async () => {
    let spawned = false;
    const kills: { pid: number; signal: NodeJS.Signals }[] = [];
    let t = 0;
    const deps: ServerStartDeps = {
      paths,
      readPidFile: () => (t >= 30_000 ? 777 : null),
      writePidFile: () => {},
      removePidFile: () => {},
      isProcessAlive: () => true,
      spawnDaemon: () => {
        spawned = true;
      },
      fetchHealth: async () => ({ ok: false }),
      findListenerPid: () => null,
      looksLikeNautiloServer: () => false,
      provisionAgentBrowser: async () => true,
      provisionOfficeCli: () => {},
      log: () => {},
      warn: () => {},
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      killPid: (pid, signal) => {
        kills.push({ pid, signal });
      },
    };
    expect(await runServerStart(deps)).toBe(1);
    expect(spawned).toBe(true);
    expect(kills.map((k) => k.signal)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(kills.every((k) => k.pid === 777)).toBe(true);
  });

  /** Deps for a fresh daemon launch on a fake clock; `over` sets what a test is about. */
  function bootDeps(clock: { t: number }, over: Partial<ServerStartDeps>): ServerStartDeps {
    return {
      paths,
      readPidFile: () => null,
      writePidFile: () => {},
      removePidFile: () => {},
      isProcessAlive: (pid) => pid === 4242,
      spawnDaemon: () => ({ pid: Promise.resolve(4242), cancel: () => {} }),
      fetchHealth: async () => ({ ok: false }),
      findListenerPid: () => null,
      looksLikeNautiloServer: () => false,
      provisionAgentBrowser: async () => true,
      provisionOfficeCli: () => {},
      log: () => {},
      warn: () => {},
      now: () => clock.t,
      sleep: async (ms) => {
        clock.t += ms;
      },
      killPid: () => {
        throw new Error("unexpected kill");
      },
      ...over,
    };
  }

  test("a booting server that never binds is stopped by its launcher PID (no server.pid yet)", async () => {
    // server.pid is written only after the listener binds, so a slow boot
    // used to leave an orphaned daemon behind when the wait expired.
    const clock = { t: 0 };
    const kills: { pid: number; signal: NodeJS.Signals }[] = [];
    const warnings: string[] = [];
    const deps = bootDeps(clock, {
      warn: (s) => { warnings.push(s); },
      killPid: (pid, signal) => { kills.push({ pid, signal }); },
    });
    expect(await runServerStart(deps)).toBe(1);
    expect(clock.t).toBeGreaterThanOrEqual(HEALTH_WAIT_MS);
    expect(kills).toEqual([
      { pid: 4242, signal: "SIGTERM" },
      { pid: 4242, signal: "SIGKILL" },
    ]);
    expect(warnings.at(-1)).toContain(`timed out after ${HEALTH_WAIT_MS}ms`);
  });

  test("keeps waiting past the former 90 s bound while the server is alive and booting", async () => {
    const clock = { t: 0 };
    const deps = bootDeps(clock, {
      readPidFile: () => (clock.t >= 120_000 ? 4242 : null),
      fetchHealth: async () => (clock.t >= 120_000 ? { ok: true, status: "ready" } : { ok: false }),
    });
    expect(await runServerStart(deps)).toBe(0);
  });

  test("a server that exits during boot fails at once instead of waiting out the deadline", async () => {
    const clock = { t: 0 };
    const warnings: string[] = [];
    const deps = bootDeps(clock, {
      isProcessAlive: (pid) => pid === 4242 && clock.t < 5_000,
      warn: (s) => { warnings.push(s); },
    });
    expect(await runServerStart(deps)).toBe(1);
    expect(clock.t).toBeLessThan(6_000);
    expect(warnings).toEqual([
      `[server:start] server process 4242 exited before ${paths.serverUrl}/health became ready (see ${paths.logPath})`,
    ]);
  });

  test("a failed launcher fails at once: no server was started", async () => {
    const clock = { t: 0 };
    const warnings: string[] = [];
    const deps = bootDeps(clock, {
      spawnDaemon: () => ({
        pid: Promise.reject(new Error("daemon launcher exited with code 3")),
        cancel: () => {},
      }),
      warn: (s) => { warnings.push(s); },
    });
    expect(await runServerStart(deps)).toBe(1);
    expect(clock.t).toBe(0);
    expect(warnings).toEqual(["[server:start] daemon launcher exited with code 3; no server was started"]);
  });

  test("a launcher that never reports cannot outlast the deadline", async () => {
    const clock = { t: 0 };
    const warnings: string[] = [];
    let cancelled = 0;
    const deps = bootDeps(clock, {
      spawnDaemon: () => ({
        pid: new Promise<number | null>(() => {}),
        cancel: () => { cancelled += 1; },
      }),
      warn: (s) => { warnings.push(s); },
    });
    expect(await runServerStart(deps)).toBe(1);
    expect(clock.t).toBeGreaterThanOrEqual(HEALTH_WAIT_MS);
    expect(cancelled).toBe(1);
    expect(warnings).toEqual([
      "[server:start] the daemon launcher had not reported a server by the deadline and was stopped",
      `[server:start] timed out after ${HEALTH_WAIT_MS}ms waiting for ${paths.serverUrl}/health (see ${paths.logPath})`,
    ]);
  });

  test("a launcher that has reported its server is not cancelled at the deadline", async () => {
    const clock = { t: 0 };
    let cancelled = 0;
    const deps = bootDeps(clock, {
      spawnDaemon: () => ({ pid: Promise.resolve(4242), cancel: () => { cancelled += 1; } }),
      killPid: () => {},
    });
    expect(await runServerStart(deps)).toBe(1);
    expect(cancelled).toBe(0);
  });

  test("a server the launcher reports while it is being stopped is stopped too", async () => {
    // The launcher started the server just before the deadline; its PID line
    // arrives only once the launcher is stopped.
    const clock = { t: 0 };
    const kills: { pid: number; signal: NodeJS.Signals }[] = [];
    let report: (pid: number) => void = () => {};
    const deps = bootDeps(clock, {
      spawnDaemon: () => ({
        pid: new Promise<number | null>((resolvePid) => { report = resolvePid; }),
        cancel: () => { report(4242); },
      }),
      killPid: (pid, signal) => { kills.push({ pid, signal }); },
    });
    expect(await runServerStart(deps)).toBe(1);
    expect(kills).toEqual([
      { pid: 4242, signal: "SIGTERM" },
      { pid: 4242, signal: "SIGKILL" },
    ]);
  });

  test("real processes: a launcher still running at the deadline is stopped and starts no server later", async () => {
    // The launcher reports its server only after a delay, far beyond the
    // fake clock's deadline. Left running, it would start the server after
    // server:start has already reported the failure.
    const launcherScript = [
      "setTimeout(() => {",
      '  const { spawn } = require("node:child_process");',
      '  const server = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "ignore" });',
      "  server.unref();",
      "  console.log(`[daemon] started, pid=${server.pid}`);",
      "  process.exit(0);",
      "}, 1500);",
    ].join("\n");
    const clock = { t: 0 };
    let launch: DaemonLaunch | undefined;
    const deps = bootDeps(clock, {
      spawnDaemon: () => {
        launch = daemonLaunchFrom(
          spawn(process.execPath, ["-e", launcherScript], { stdio: ["ignore", "pipe", "ignore"] }),
        );
        return launch;
      },
    });
    expect(await runServerStart(deps)).toBe(1);
    // Settles when the launcher is gone: a number would be a started server.
    const outcome = await launch!.pid.catch(() => null);
    try {
      expect(outcome).toBeNull();
    } finally {
      if (outcome !== null) process.kill(outcome);
    }
  }, 30_000);
});

describe("daemon launcher PID", () => {
  /** A launcher whose stdout and exit the test drives by hand. */
  function fakeLauncher() {
    return Object.assign(new EventEmitter(), { stdout: new PassThrough() });
  }

  test("parses only a complete started line among other boot output", () => {
    expect(parseDaemonLauncherPid("[boot] hosting mode: local\n[daemon] started, pid=31337\n")).toBe(31337);
    expect(parseDaemonLauncherPid("[daemon] started, pid=31337\r\n")).toBe(31337);
    expect(parseDaemonLauncherPid("[daemon] started, pid=313")).toBeNull();
    expect(parseDaemonLauncherPid("[daemon] started, pid=undefined\n")).toBeNull();
    expect(parseDaemonLauncherPid("")).toBeNull();
  });

  test("resolves the PID when its line arrives, while stdout stays open", async () => {
    const launcher = fakeLauncher();
    const pid = readDaemonLauncherPid(launcher);
    launcher.stdout.write("[boot] hosting mode: local\n[daemon] started, pid=42");
    launcher.stdout.write("42\n");
    expect(await pid).toBe(4242);
    expect(launcher.stdout.destroyed).toBe(true);
  });

  test("a launcher without a PID resolves null on a clean exit and rejects on a failed one", async () => {
    for (const exitFirst of [true, false]) {
      const clean = fakeLauncher();
      const cleanPid = readDaemonLauncherPid(clean);
      const failed = fakeLauncher();
      // Capture the rejection as a value: it settles only after the events
      // below, and it must not be unhandled while the clean launcher is awaited.
      const failedOutcome = readDaemonLauncherPid(failed).then(
        (pid) => `resolved ${String(pid)}`,
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      );
      for (const [launcher, code] of [[clean, 0], [failed, 3]] as const) {
        if (exitFirst) launcher.emit("exit", code);
        launcher.stdout.end("[boot] hosting mode: local\n");
        if (!exitFirst) launcher.emit("exit", code);
      }
      expect(await cleanPid).toBeNull();
      expect(await failedOutcome).toBe("daemon launcher exited with code 3");
    }
  });

  test("real processes: the PID arrives although the detached server keeps the launcher's stdout open", async () => {
    // The launcher hands its own stdout to a long-lived detached child, the
    // worst case for the pipe: it never closes while the "server" lives.
    const launcherScript = [
      'const { spawn } = require("node:child_process");',
      'const server = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: ["ignore", "inherit", "ignore"] });',
      "server.unref();",
      "console.log(`[daemon] started, pid=${server.pid}`);",
      "process.exit(0);",
    ].join("\n");
    const launcher = spawn(process.execPath, ["-e", launcherScript], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const pid = await readDaemonLauncherPid(launcher);
    try {
      expect(pid).not.toBeNull();
      expect(() => process.kill(pid!, 0)).not.toThrow();
    } finally {
      if (pid !== null) process.kill(pid);
    }
  }, 30_000);

  test("real processes: a launcher that fails before starting a server rejects", async () => {
    const launcher = spawn(process.execPath, ["-e", "process.exit(3)"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(readDaemonLauncherPid(launcher)).rejects.toThrow("daemon launcher exited with code 3");
  }, 30_000);
});

describe("serverDaemonEnv", () => {
  const inst = {
    instanceId: "",
    server: {
      host: "127.0.0.1",
      port: 6101,
      url: "http://127.0.0.1:6101",
    },
    db: {
      directConnection: "postgresql://postgres:postgres@localhost:5434/nautilo",
      postgresHostPort: 5434,
    },
  } as Parameters<typeof serverDaemonEnv>[0];

  test("preserves explicit DB_CONNECTION_STRING override from parent env", () => {
    const override = "postgresql://nautilo:custom@example.invalid:5432/nautilo";
    const env = serverDaemonEnv(inst, "", {
      DB_CONNECTION_STRING: override,
      DB_DIRECT_CONNECTION: "postgresql://postgres:postgres@localhost:5434/nautilo",
    });

    expect(env["DB_CONNECTION_STRING"]).toBe(override);
    expect(env["DB_DIRECT_CONNECTION"]).toBe(
      "postgresql://postgres:postgres@localhost:5434/nautilo",
    );
  });

  test("defaults full runtime and agent URLs to direct localhost role endpoints", () => {
    const env = serverDaemonEnv(inst, "", {});

    expect(env["DB_CONNECTION_STRING"]).toBe(
      "postgres://nautilo:nautilo@localhost:5434/nautilo",
    );
    expect(env["DB_DIRECT_CONNECTION"]).toBe(
      "postgresql://postgres:postgres@localhost:5434/nautilo",
    );
    expect(env["DB_AGENT_CONNECTION_STRING"]).toBe(
      "postgres://nautilo_agent:nautilo_agent@localhost:5434/nautilo",
    );
    expect(env["DB_AGENT_DIRECT_CONNECTION"]).toBe(
      "postgresql://nautilo_agent:nautilo_agent@localhost:5434/nautilo",
    );
    expect(env["DB_CRYPTO_CONNECTION_STRING"]).toBe(
      "postgres://nautilo_crypto:nautilo_crypto@localhost:5434/nautilo",
    );
    expect(env["NAUTILO_OPENCONNECTOR_BASE_URL"]).toBe("http://127.0.0.1:6110");
    expect(env["NAUTILO_CRYPTO_DB_PASSWORD"]).toBeUndefined();
  });

  test("honors explicit agent URL overrides and role passwords in defaults", () => {
    const env = serverDaemonEnv(inst, "", {
      NAUTILO_DB_PASSWORD: "full-secret",
      NAUTILO_AGENT_DB_PASSWORD: "agent-secret",
      DB_AGENT_CONNECTION_STRING:
        "postgres://nautilo_agent:override@example.invalid:5432/nautilo",
      DB_AGENT_DIRECT_CONNECTION:
        "postgres://nautilo_agent:override-direct@example.invalid:5432/nautilo",
    });

    expect(env["DB_CONNECTION_STRING"]).toBe(
      "postgres://nautilo:full-secret@localhost:5434/nautilo",
    );
    expect(env["DB_AGENT_CONNECTION_STRING"]).toBe(
      "postgres://nautilo_agent:override@example.invalid:5432/nautilo",
    );
    expect(env["DB_AGENT_DIRECT_CONNECTION"]).toBe(
      "postgres://nautilo_agent:override-direct@example.invalid:5432/nautilo",
    );
  });
});

describe("checkWorkbenchDistForServerStart", () => {
  test("warns but allows API-only server-start when workbench dist is unset", () => {
    const warns: string[] = [];

    const code = checkWorkbenchDistForServerStart({
      env: {},
      warn: (s) => warns.push(s),
    });

    expect(code).toBe(0);
    expect(warns.some((w) => w.includes("NAUTILO_WORKBENCH_DIST is not set"))).toBe(true);
    expect(warns.some((w) => w.includes("JSON 404"))).toBe(true);
  });

  test("fails fast when workbench dist is required and unset", () => {
    const warns: string[] = [];

    const code = checkWorkbenchDistForServerStart({
      env: {},
      requireWorkbenchDist: true,
      warn: (s) => warns.push(s),
    });

    expect(code).toBe(1);
    expect(warns.some((w) => w.includes("refusing to start"))).toBe(true);
  });

  test("fails fast when required workbench dist lacks index.html", () => {
    const warns: string[] = [];
    const dist = mkdtempSync(join(tmpdir(), "nautilo-empty-dist-"));

    const code = checkWorkbenchDistForServerStart({
      env: { NAUTILO_WORKBENCH_DIST: dist },
      requireWorkbenchDist: true,
      warn: (s) => warns.push(s),
    });

    expect(code).toBe(1);
    expect(warns.some((w) => w.includes("index.html does not exist"))).toBe(true);
  });

  test("accepts existing workbench dist index", () => {
    const warns: string[] = [];
    const dist = mkdtempSync(join(tmpdir(), "nautilo-valid-dist-"));
    writeFileSync(join(dist, "index.html"), "<!doctype html>", "utf8");

    const code = checkWorkbenchDistForServerStart({
      env: { NAUTILO_WORKBENCH_DIST: dist },
      requireWorkbenchDist: true,
      warn: (s) => warns.push(s),
    });

    expect(code).toBe(0);
    expect(warns).toEqual([]);
  });
});

describe("checkFirstPartyAppPrerequisitesForServerStart", () => {
  test("explains the supported Sheets preparation command when provenance is absent", () => {
    const warns: string[] = [];
    const ready = checkFirstPartyAppPrerequisitesForServerStart({
      repoRoot: "/source", pathExists: () => false, warn: (message) => warns.push(message),
    });

    expect(ready).toBe(false);
    expect(warns).toEqual([
      "[server:start] refusing to start: Nautilo Sheets is not prepared in this source worktree. Run `bun run sheets:prepare`, then retry `bun run server:start`.",
    ]);
  });

  test("accepts a prepared Sheets provenance artifact", () => {
    const checked: string[] = [];
    const warns: string[] = [];
    const ready = checkFirstPartyAppPrerequisitesForServerStart({
      repoRoot: "/source",
      pathExists: (path) => { checked.push(path); return true; },
      warn: (message) => warns.push(message),
    });

    expect(ready).toBe(true);
    expect(checked).toEqual([join("/source", "packages/first-party-apps/spreadsheet/engine/provenance.json")]);
    expect(warns).toEqual([]);
  });
});

describe("runServerStop", () => {
  test("no PID file and no listener returns 0 'already stopped'", async () => {
    const logs: string[] = [];
    const deps: ServerStopDeps = {
      paths: { pidPath: paths.pidPath, serverUrl: paths.serverUrl },
      readPidFile: () => null,
      removePidFile: () => {},
      isProcessAlive: () => false,
      findListenerPid: () => null,
      looksLikeNautiloServer: () => false,
      kill: () => {},
      log: (s) => {
        logs.push(s);
      },
      warn: () => {},
      sleep: async () => {},
      now: () => 0,
    };
    expect(await runServerStop(deps)).toBe(0);
    expect(logs[0]).toContain("nothing listening");
  });

  test("stale PID + no listener removes file and returns 0", async () => {
    let removed = false;
    const deps: ServerStopDeps = {
      paths: { pidPath: paths.pidPath, serverUrl: paths.serverUrl },
      readPidFile: () => 55,
      removePidFile: () => {
        removed = true;
      },
      isProcessAlive: () => false,
      findListenerPid: () => null,
      looksLikeNautiloServer: () => false,
      kill: () => {
        throw new Error("kill should not run");
      },
      log: () => {},
      warn: () => {},
      sleep: async () => {},
      now: () => 0,
    };
    expect(await runServerStop(deps)).toBe(0);
    expect(removed).toBe(true);
  });

  test("no PID but a Nautilo listener is found → SIGTERM that PID", async () => {
    const kills: { pid: number; signal: NodeJS.Signals }[] = [];
    let alive = true;
    let t = 0;
    const deps: ServerStopDeps = {
      paths: { pidPath: paths.pidPath, serverUrl: paths.serverUrl },
      readPidFile: () => null,
      removePidFile: () => {
        /* idempotent */
      },
      isProcessAlive: () => alive,
      findListenerPid: () => 4242,
      looksLikeNautiloServer: () => true,
      kill: (pid, signal) => {
        kills.push({ pid, signal });
        if (signal === "SIGTERM") {
          alive = false;
        }
      },
      log: () => {},
      warn: () => {},
      sleep: async (ms) => {
        t += ms;
      },
      now: () => t,
    };
    expect(await runServerStop(deps)).toBe(0);
    expect(kills).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
  });

  test("no PID + foreign non-nautilo listener returns 1 with refusal", async () => {
    const warns: string[] = [];
    const deps: ServerStopDeps = {
      paths: { pidPath: paths.pidPath, serverUrl: paths.serverUrl },
      readPidFile: () => null,
      removePidFile: () => {},
      isProcessAlive: () => false,
      findListenerPid: () => 9090,
      looksLikeNautiloServer: () => false,
      kill: () => {
        throw new Error("must not kill");
      },
      log: () => {},
      warn: (s) => {
        warns.push(s);
      },
      sleep: async () => {},
      now: () => 0,
    };
    expect(await runServerStop(deps)).toBe(1);
    expect(warns.some((w) => w.includes("does not look like nautilo-server"))).toBe(true);
  });

  test("live PID exits after SIGTERM within window", async () => {
    const kills: { pid: number; signal: NodeJS.Signals }[] = [];
    let alive = true;
    let t = 0;
    const deps: ServerStopDeps = {
      paths: { pidPath: paths.pidPath, serverUrl: paths.serverUrl },
      readPidFile: () => 99,
      removePidFile: () => {
        /* removed */
      },
      isProcessAlive: () => alive,
      findListenerPid: () => null,
      looksLikeNautiloServer: () => false,
      kill: (pid, signal) => {
        kills.push({ pid, signal });
        if (signal === "SIGTERM") {
          alive = false;
        }
      },
      log: () => {},
      warn: () => {},
      sleep: async (ms) => {
        t += ms;
      },
      now: () => t,
    };
    expect(await runServerStop(deps)).toBe(0);
    expect(kills.map((k) => k.signal)).toEqual(["SIGTERM"]);
  });

  test("SIGKILL escalation when SIGTERM does not stop process", async () => {
    const kills: { pid: number; signal: NodeJS.Signals }[] = [];
    let alive = true;
    let t = 0;
    const deps: ServerStopDeps = {
      paths: { pidPath: paths.pidPath, serverUrl: paths.serverUrl },
      readPidFile: () => 100,
      removePidFile: () => {},
      isProcessAlive: () => alive,
      findListenerPid: () => null,
      looksLikeNautiloServer: () => false,
      kill: (pid, signal) => {
        kills.push({ pid, signal });
        if (signal === "SIGKILL") {
          alive = false;
        }
      },
      log: () => {},
      warn: () => {},
      sleep: async (ms) => {
        t += ms;
      },
      now: () => t,
    };
    expect(await runServerStop(deps)).toBe(0);
    expect(kills.map((k) => k.signal)).toEqual(["SIGTERM", "SIGKILL"]);
  });
});

describe("runServerStatus", () => {
  test("no PID + nothing listening returns 1", async () => {
    const lines: string[] = [];
    const deps: ServerStatusDeps = {
      paths,
      readPidFile: () => null,
      isProcessAlive: () => false,
      findListenerPid: () => null,
      looksLikeNautiloServer: () => false,
      fetchHealthLabel: async () => "(unreachable)",
      fetchSetupState: async () => "(unreachable)",
      log: (s) => {
        lines.push(s);
      },
      warn: () => {},
    };
    expect(await runServerStatus(deps)).toBe(1);
    expect(lines[0]).toContain("not running");
  });

  test("managed PID alive returns 0 with health + setupState", async () => {
    const lines: string[] = [];
    const deps: ServerStatusDeps = {
      paths,
      readPidFile: () => 7,
      isProcessAlive: () => true,
      findListenerPid: () => 7,
      looksLikeNautiloServer: () => true,
      fetchHealthLabel: async () => "ready",
      fetchSetupState: async () => "fresh-unclaimed",
      log: (s) => {
        lines.push(s);
      },
      warn: () => {},
    };
    expect(await runServerStatus(deps)).toBe(0);
    expect(lines.some((l) => l.startsWith("[server:status] running"))).toBe(true);
    expect(lines.some((l) => l.includes("health : ready"))).toBe(true);
    expect(lines.some((l) => l.includes("setupState : fresh-unclaimed"))).toBe(true);
  });

  test("foreign nautilo listener (no PID file) returns 0 with 'foreign' label and hint", async () => {
    const lines: string[] = [];
    const deps: ServerStatusDeps = {
      paths,
      readPidFile: () => null,
      isProcessAlive: () => false,
      findListenerPid: () => 8181,
      looksLikeNautiloServer: () => true,
      fetchHealthLabel: async () => "ready",
      fetchSetupState: async () => "ready",
      log: (s) => {
        lines.push(s);
      },
      warn: () => {},
    };
    expect(await runServerStatus(deps)).toBe(0);
    expect(lines.some((l) => l.includes("(foreign — not managed by server:start)"))).toBe(true);
    expect(lines.some((l) => l.includes("pid : 8181"))).toBe(true);
    expect(lines.some((l) => l.includes("server:start"))).toBe(true);
  });

  test("stale PID + nothing listening returns 1 with stale-warn", async () => {
    const warns: string[] = [];
    const deps: ServerStatusDeps = {
      paths,
      readPidFile: () => 8,
      isProcessAlive: () => false,
      findListenerPid: () => null,
      looksLikeNautiloServer: () => false,
      fetchHealthLabel: async () => "(unreachable)",
      fetchSetupState: async () => "(unreachable)",
      log: () => {},
      warn: (s) => {
        warns.push(s);
      },
    };
    expect(await runServerStatus(deps)).toBe(1);
    expect(warns.some((w) => w.includes("stale PID file"))).toBe(true);
  });

  test("/health reachable but listener does not look like nautilo → returns 1 with warn", async () => {
    const warns: string[] = [];
    const deps: ServerStatusDeps = {
      paths,
      readPidFile: () => null,
      isProcessAlive: () => false,
      findListenerPid: () => 9090,
      looksLikeNautiloServer: () => false,
      fetchHealthLabel: async () => "ready",
      fetchSetupState: async () => "ready",
      log: () => {},
      warn: (s) => {
        warns.push(s);
      },
    };
    expect(await runServerStatus(deps)).toBe(1);
    expect(warns.some((w) => w.includes("does not look like nautilo-server"))).toBe(true);
  });
});

/**
 * Stack 193 — `buildServerDaemonEnv` clones the parent env, loads the
 * selected instance's `<rootDir>/instance.env` into the clone. Selected
 * internal service credentials override drifted parent values; unrelated
 * parent values keep their established precedence. Missing file preserves
 * fresh-instance fallback behavior; process.env is never mutated.
 */
describe("buildServerDaemonEnv (Stack 193 instance.env loading)", () => {
  const inst = {
    instanceId: "",
    server: {
      host: "127.0.0.1",
      port: 6101,
      url: "http://127.0.0.1:6101",
    },
    db: {
      directConnection: "postgresql://postgres:postgres@localhost:5434/nautilo",
      postgresHostPort: 5434,
    },
  } as Parameters<typeof buildServerDaemonEnv>[0]["inst"];

  function writeCryptoRoleSecret(root: string, value = "selected-crypto-pw"): void {
    const directory = join(root, ".bootstrap");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "nautilo-crypto-db-password"), `${value}\n`, {
      mode: 0o600,
    });
  }

  test("file-only NAUTILO_AGENT_DB_PASSWORD is used for both agent connection URLs", () => {
    const root = mkdtempSync(join(tmpdir(), "nautilo-instanceenv-"));
    writeFileSync(
      join(root, "instance.env"),
      "NAUTILO_DB_PASSWORD=file-only-full-pw\n" +
        "NAUTILO_AGENT_DB_PASSWORD=file-only-agent-pw\n" +
        "LOGTO_DB_PASSWORD=file-only-logto-pw\n",
      "utf8",
    );
    writeCryptoRoleSecret(root);
    const env = buildServerDaemonEnv({
      rootDir: root,
      inst,
      instanceId: "",
      parentEnv: {},
    });
    expect(env["DB_AGENT_CONNECTION_STRING"]).toBe(
      "postgres://nautilo_agent:file-only-agent-pw@localhost:5434/nautilo",
    );
    expect(env["DB_AGENT_DIRECT_CONNECTION"]).toBe(
      "postgresql://nautilo_agent:file-only-agent-pw@localhost:5434/nautilo",
    );
    expect(env["DB_CRYPTO_CONNECTION_STRING"]).toBe(
      "postgres://nautilo_crypto:selected-crypto-pw@localhost:5434/nautilo",
    );
    expect(env["NAUTILO_CRYPTO_DB_PASSWORD"]).toBeUndefined();
  });

  test("selected NAUTILO_AGENT_DB_PASSWORD overrides a drifted parent value", () => {
    const root = mkdtempSync(join(tmpdir(), "nautilo-instanceenv-"));
    writeFileSync(
      join(root, "instance.env"),
      "NAUTILO_DB_PASSWORD=file-only-full-pw\n" +
        "NAUTILO_AGENT_DB_PASSWORD=file-only-agent-pw\n" +
        "LOGTO_DB_PASSWORD=file-only-logto-pw\n",
      "utf8",
    );
    writeCryptoRoleSecret(root);
    const env = buildServerDaemonEnv({
      rootDir: root,
      inst,
      instanceId: "",
      parentEnv: { NAUTILO_AGENT_DB_PASSWORD: "parent-override-pw" },
    });
    expect(env["DB_AGENT_CONNECTION_STRING"]).toBe(
      "postgres://nautilo_agent:file-only-agent-pw@localhost:5434/nautilo",
    );
    expect(env["DB_AGENT_DIRECT_CONNECTION"]).toBe(
      "postgresql://nautilo_agent:file-only-agent-pw@localhost:5434/nautilo",
    );
  });

  test("selected credentials replace drifted parent DB_AGENT_* URLs", () => {
    const root = mkdtempSync(join(tmpdir(), "nautilo-instanceenv-"));
    writeFileSync(
      join(root, "instance.env"),
      "NAUTILO_DB_PASSWORD=file-only-full-pw\n" +
        "NAUTILO_AGENT_DB_PASSWORD=file-only-agent-pw\n" +
        "LOGTO_DB_PASSWORD=file-only-logto-pw\n" +
        "DB_AGENT_CONNECTION_STRING=postgres://nautilo_agent:file@host/nautilo\n",
      "utf8",
    );
    writeCryptoRoleSecret(root);
    const env = buildServerDaemonEnv({
      rootDir: root,
      inst,
      instanceId: "",
      parentEnv: {
        DB_AGENT_CONNECTION_STRING: "postgres://nautilo_agent:parent@host/nautilo",
        DB_AGENT_DIRECT_CONNECTION: "postgresql://nautilo_agent:parent-direct@host/nautilo",
      },
    });
    expect(env["DB_AGENT_CONNECTION_STRING"]).toBe(
      "postgres://nautilo_agent:file-only-agent-pw@localhost:5434/nautilo",
    );
    expect(env["DB_AGENT_DIRECT_CONNECTION"]).toBe(
      "postgresql://nautilo_agent:file-only-agent-pw@localhost:5434/nautilo",
    );
  });

  test("missing instance.env preserves current fallback behavior", () => {
    const root = mkdtempSync(join(tmpdir(), "nautilo-instanceenv-"));
    const env = buildServerDaemonEnv({
      rootDir: root,
      inst,
      instanceId: "",
      parentEnv: {},
    });
    expect(env["DB_AGENT_CONNECTION_STRING"]).toBe(
      "postgres://nautilo_agent:nautilo_agent@localhost:5434/nautilo",
    );
    expect(env["DB_AGENT_DIRECT_CONNECTION"]).toBe(
      "postgresql://nautilo_agent:nautilo_agent@localhost:5434/nautilo",
    );
  });

  test("default and named selected roots resolve the correct instance.env path", () => {
    const defaultRoot = mkdtempSync(join(tmpdir(), "nautilo-default-root-"));
    writeFileSync(
      join(defaultRoot, "instance.env"),
      "NAUTILO_DB_PASSWORD=default-full-pw\n" +
        "NAUTILO_AGENT_DB_PASSWORD=default-root-pw\n" +
        "LOGTO_DB_PASSWORD=default-logto-pw\n",
      "utf8",
    );
    writeCryptoRoleSecret(defaultRoot, "default-crypto-pw");
    const envDefault = buildServerDaemonEnv({
      rootDir: defaultRoot,
      inst,
      instanceId: "",
      parentEnv: {},
    });
    expect(envDefault["DB_AGENT_CONNECTION_STRING"]).toContain("default-root-pw");

    const namedRoot = mkdtempSync(join(tmpdir(), "nautilo-named-root-"));
    writeFileSync(
      join(namedRoot, "instance.env"),
      "NAUTILO_DB_PASSWORD=named-full-pw\n" +
        "NAUTILO_AGENT_DB_PASSWORD=named-root-pw\n" +
        "LOGTO_DB_PASSWORD=named-logto-pw\n",
      "utf8",
    );
    writeCryptoRoleSecret(namedRoot, "named-crypto-pw");
    const envNamed = buildServerDaemonEnv({
      rootDir: namedRoot,
      inst,
      instanceId: "stack193",
      parentEnv: {},
    });
    expect(envNamed["DB_AGENT_CONNECTION_STRING"]).toContain("named-root-pw");
    expect(envNamed["NAUTILO_INSTANCE_ID"]).toBe("stack193");
    // The named selection must not leak the default root's instance.env.
    expect(envNamed["DB_AGENT_CONNECTION_STRING"]).not.toContain("default-root-pw");
    expect(envNamed["DB_CRYPTO_CONNECTION_STRING"]).toContain("named-crypto-pw");
    expect(envNamed["DB_CRYPTO_CONNECTION_STRING"]).not.toContain(
      "default-crypto-pw",
    );
  });

  test("does not mutate process.env when loading instance.env", () => {
    const root = mkdtempSync(join(tmpdir(), "nautilo-instanceenv-"));
    writeFileSync(
      join(root, "instance.env"),
      "NAUTILO_DB_PASSWORD=must-not-leak-full\n" +
        "NAUTILO_AGENT_DB_PASSWORD=must-not-leak-into-process-env\n" +
        "LOGTO_DB_PASSWORD=must-not-leak-logto\n",
      "utf8",
    );
    writeCryptoRoleSecret(root, "must-not-leak-crypto");
    const before = process.env["NAUTILO_AGENT_DB_PASSWORD"];
    buildServerDaemonEnv({ rootDir: root, inst, instanceId: "", parentEnv: {} });
    expect(process.env["NAUTILO_AGENT_DB_PASSWORD"]).toBe(before);
    expect(process.env["NAUTILO_CRYPTO_DB_PASSWORD"]).toBeUndefined();
  });

  test("fails closed when a selected instance lacks its role-only crypto secret", () => {
    const root = mkdtempSync(join(tmpdir(), "nautilo-instanceenv-"));
    writeFileSync(
      join(root, "instance.env"),
      "NAUTILO_DB_PASSWORD=full\n" +
        "NAUTILO_AGENT_DB_PASSWORD=agent\n" +
        "LOGTO_DB_PASSWORD=logto\n",
      "utf8",
    );
    expect(() => buildServerDaemonEnv({
      rootDir: root,
      inst,
      instanceId: "",
      parentEnv: {},
    })).toThrow("selected instance crypto database credential is unavailable");
  });
});
