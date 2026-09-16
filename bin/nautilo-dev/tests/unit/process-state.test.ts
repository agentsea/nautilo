import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeIsStale,
  formatAgeShort,
  parsePsEtimeToSeconds,
  probeInstanceProcessState,
  resolveStaleThresholdSeconds,
  type InstanceProcessState,
} from "../../src/lib/process-state";

describe("computeIsStale", () => {
  test("true iff age and idle both exceed thresholds", () => {
    expect(computeIsStale(100, 100, 99, 99)).toBe(true);
    expect(computeIsStale(100, 50, 99, 99)).toBe(false);
    expect(computeIsStale(50, 100, 99, 99)).toBe(false);
    expect(computeIsStale(99, 99, 99, 99)).toBe(false);
  });

  test("null age or idle → not stale", () => {
    expect(computeIsStale(null, 500, 1, 1)).toBe(false);
    expect(computeIsStale(500, null, 1, 1)).toBe(false);
  });
});

describe("resolveStaleThresholdSeconds (env + opts precedence)", () => {
  const savedUptime = process.env["NAUTILO_DEV_STALE_UPTIME_H"];
  const savedIdle = process.env["NAUTILO_DEV_STALE_IDLE_H"];

  afterEach(() => {
    if (savedUptime === undefined) delete process.env["NAUTILO_DEV_STALE_UPTIME_H"];
    else process.env["NAUTILO_DEV_STALE_UPTIME_H"] = savedUptime;
    if (savedIdle === undefined) delete process.env["NAUTILO_DEV_STALE_IDLE_H"];
    else process.env["NAUTILO_DEV_STALE_IDLE_H"] = savedIdle;
  });

  test("defaults to 6h when env unset", () => {
    delete process.env["NAUTILO_DEV_STALE_UPTIME_H"];
    delete process.env["NAUTILO_DEV_STALE_IDLE_H"];
    const r = resolveStaleThresholdSeconds();
    expect(r.staleUptimeSeconds).toBe(6 * 3600);
    expect(r.staleIdleSeconds).toBe(6 * 3600);
  });

  test("env wins over baked-in default", () => {
    process.env["NAUTILO_DEV_STALE_UPTIME_H"] = "10";
    process.env["NAUTILO_DEV_STALE_IDLE_H"] = "2";
    const r = resolveStaleThresholdSeconds();
    expect(r.staleUptimeSeconds).toBe(10 * 3600);
    expect(r.staleIdleSeconds).toBe(2 * 3600);
  });

  test("opts override env", () => {
    process.env["NAUTILO_DEV_STALE_UPTIME_H"] = "10";
    process.env["NAUTILO_DEV_STALE_IDLE_H"] = "10";
    const r = resolveStaleThresholdSeconds({
      staleUptimeSeconds: 111,
      staleIdleSeconds: 222,
    });
    expect(r.staleUptimeSeconds).toBe(111);
    expect(r.staleIdleSeconds).toBe(222);
  });
});

describe("parsePsEtimeToSeconds", () => {
  test("parses mm:ss and hh:mm:ss", () => {
    expect(parsePsEtimeToSeconds("05:30")).toBe(330);
    expect(parsePsEtimeToSeconds("01:05:10")).toBe(3600 + 310);
  });

  test("parses dd-hh:mm:ss", () => {
    expect(parsePsEtimeToSeconds("1-00:00:10")).toBe(86400 + 10);
  });
});

describe("formatAgeShort", () => {
  test("formats null and tiers", () => {
    expect(formatAgeShort(null)).toBe("—");
    expect(formatAgeShort(45)).toBe("45s");
    expect(formatAgeShort(120)).toBe("2m");
    expect(formatAgeShort(3720)).toBe("1h 2m");
    expect(formatAgeShort(7200)).toBe("2h");
  });
});

function minimalInstanceJson(instanceId: string, serverPort: number): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    instanceId,
    server: { host: "127.0.0.1", port: serverPort, url: `http://127.0.0.1:${serverPort}` },
    workbench: { port: serverPort + 1, url: `http://127.0.0.1:${serverPort + 1}` },
    db: {
      directConnection: "postgresql://x",
      postgresHostPort: 5434,
    },
    logto: { dbPort: 5432, corePort: 3301, adminPort: 3302 },
    compose: { projectName: `nautilo-${instanceId}` },
    hostname: {
      federated: "n.local",
      mdns: "n.local",
      tlsSan: "n.local",
      caddyAuthHost: "a.local",
      caddyAuthAdminHost: "aa.local",
    },
  })}\n`;
}

describe("probeInstanceProcessState (stubbed subprocess + listener override)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nautilo-ps-"));
    mkdirSync(join(dir, "logs"), { recursive: true });
    writeFileSync(join(dir, "instance.json"), minimalInstanceJson("probe-test", 45123), "utf8");
    writeFileSync(join(dir, "logs", "nautilo-server.log"), "x\n", "utf8");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("merged shape with mocked ps/lsof + injected listener pid", async () => {
    const old = new Date(Date.now() - 10 * 3600 * 1000);
    utimesSync(join(dir, "logs", "nautilo-server.log"), old, old);
    utimesSync(join(dir, "instance.json"), old, old);

    const fakePid = process.pid;
    const row = await probeInstanceProcessState("probe-test", dir, {
      staleUptimeSeconds: 60,
      staleIdleSeconds: 60,
      budgetMsPerInstance: 5000,
      testPortListenerPid: () => fakePid,
      spawnStdout: async (cmd) => {
        if (cmd[0] === "ps") {
          return "02:15:00";
        }
        if (cmd[0] === "lsof" && cmd.includes("-d")) {
          return `bun  ${fakePid}  user  cwd    DIR   1,4    704    /tmp/nautilo-probe-cwd\n`;
        }
        return null;
      },
    });

    expect(row.instanceId).toBe("probe-test");
    expect(row.serverPid).toBe(fakePid);
    expect(row.serverPort).toBe(45123);
    expect(row.cwd).toBe("/tmp/nautilo-probe-cwd");
    expect(row.ageSeconds).toBe(2 * 3600 + 15 * 60);
    expect(row.idleSeconds).not.toBeNull();
    expect(row.isRunning).toBe(true);
    expect(row.isStale).toBe(true);
  });
});

describe("InstanceProcessState shape", () => {
  test("satisfies exported interface", () => {
    const row: InstanceProcessState = {
      instanceId: "x",
      serverPid: null,
      serverPort: null,
      cwd: null,
      ageSeconds: null,
      idleSeconds: null,
      isStale: false,
      isRunning: false,
    };
    expect(row.isStale).toBe(false);
  });
});
