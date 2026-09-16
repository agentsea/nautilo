import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstanceProcessState } from "../../src/lib/process-state";
import {
  addDockerProjectVolumeRows,
  cleanupInstancesCmd,
  mapWorkbenchListeningPids,
  parseDockerProjectRows,
  parseListenerPid,
  parseWorkbenchListeningPids,
  parseCleanupInstancesArgs,
  rowMatchesNamePattern,
} from "../../src/commands/cleanup-instances";
import { listLocalInstances } from "@nautilo/instance-discovery/node";

type Row = Awaited<ReturnType<typeof listLocalInstances>>[number];

function row(partial: Partial<Row> & Pick<Row, "instanceId" | "displayId" | "root" | "state">): Row {
  return {
    projectName: partial.instanceId === "" ? "nautilo" : `nautilo-${partial.instanceId}`,
    serverPort: partial.serverPort ?? 3001,
    workbenchPort: partial.workbenchPort ?? 3000,
    ...partial,
  };
}

function st(instanceId: string, partial: Partial<InstanceProcessState> = {}): InstanceProcessState {
  return {
    instanceId,
    serverPid: null,
    serverPort: null,
    cwd: null,
    ageSeconds: null,
    idleSeconds: null,
    isStale: false,
    isRunning: false,
    ...partial,
  };
}

const emptyAuthority = () => ({ claimsByInstanceId: new Map(), unattributedErrors: [] });
const noDockerProjects = async () => ({ available: true, projects: new Map() });
const noWorkbenchListeners = async (rows: ReadonlyArray<{ workbenchPort: number }>) =>
  new Map(rows.map((row) => [row.workbenchPort, { state: "absent" as const, pid: null }]));

describe("cleanup-instances argument and name parsing", () => {
  test("modes are mutually exclusive", () => {
    expect(parseCleanupInstancesArgs(["--stale", "--missing-instance-json"]).ok).toBe(false);
  });

  test("glob and substring matching", () => {
    const candidate = { instanceId: "stack-3-foo", displayId: "stack-3-foo" };
    expect(rowMatchesNamePattern(candidate, "3-foo")).toBe(true);
    expect(rowMatchesNamePattern(candidate, "stack-*")).toBe(true);
    expect(rowMatchesNamePattern(candidate, "z*")).toBe(false);
  });

  test("groups active and stopped containers by Compose project", () => {
    const projects = parseDockerProjectRows(
      [
        "nautilo-test-cruft|running",
        "nautilo-test-cruft|exited",
        "nautilo-old|exited",
      ].join("\n"),
    );
    expect(projects.get("nautilo-test-cruft")).toEqual({
      runningContainers: 1,
      stoppedContainers: 1,
      volumes: 0,
    });
    expect(projects.get("nautilo-old")).toEqual({
      runningContainers: 0,
      stoppedContainers: 1,
      volumes: 0,
    });
    addDockerProjectVolumeRows(projects, "nautilo-test-cruft\nnautilo-volume-only\n");
    expect(projects.get("nautilo-test-cruft")?.volumes).toBe(1);
    expect(projects.get("nautilo-volume-only")).toEqual({
      runningContainers: 0,
      stoppedContainers: 0,
      volumes: 1,
    });
  });

  test("selects the lowest valid listener PID", () => {
    expect(parseListenerPid("69518\n70001\n")).toBe(69518);
    expect(parseListenerPid("\n")).toBeNull();
  });

  test("parses one lsof listener inventory and maps only configured ports", () => {
    const pidsByPort = parseWorkbenchListeningPids(
      ["p70001", "n127.0.0.1:3000", "n[::1]:3000", "p69518", "n*:3000", "p42", "n*:4567"].join(
        "\n",
      ),
    );
    expect(pidsByPort).toEqual(
      new Map([
        [3000, 69518],
        [4567, 42],
      ]),
    );
    expect(mapWorkbenchListeningPids([3000, 3001, 3000], pidsByPort)).toEqual(
      new Map([
        [3000, { state: "listening", pid: 69518 }],
        [3001, { state: "absent", pid: null }],
      ]),
    );
  });

  test("marks all configured ports unavailable when listener inventory fails", () => {
    expect(mapWorkbenchListeningPids([3000, 3001, 0], null)).toEqual(
      new Map([
        [3000, { state: "unavailable", pid: null }],
        [3001, { state: "unavailable", pid: null }],
      ]),
    );
  });
});

describe("cleanupInstancesCmd profile-aware doctor", () => {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;

  beforeEach(() => {
    logs.length = 0;
    errors.length = 0;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
  });

  test("remote Compose projection wins over misleading loopback JSON without a network probe", async () => {
    const home = mkdtempSync(join(tmpdir(), "nautilo-d507-remote-"));
    try {
      const profiles = join(home, ".nautilo", "profiles");
      mkdirSync(profiles, { recursive: true });
      writeFileSync(
        join(profiles, "alpha.toml"),
        'name = "alpha"\ntransport = "remote"\nlifecycle = "compose"\ninstance_id = "alpha"\n',
      );
      const rows = [
        row({ instanceId: "alpha", displayId: "alpha", root: join(home, ".nautilo-alpha"), state: "idle" }),
      ];
      let probeHealthCalled = false;
      await cleanupInstancesCmd(["--json"], {
        userHomeDir: home,
        listLocal: async (_home, deps) => {
          if (deps?.probeHealth) {
            probeHealthCalled = (await deps.probeHealth("https://unreachable.invalid/health")) !== false;
          }
          return rows;
        },
        probeMany: async () => [st("alpha", { isStale: true })],
        readDockerProjects: noDockerProjects,
        readWorkbenchListeners: noWorkbenchListeners,
        onExit: () => {},
      });
      const payload = JSON.parse(logs.join("\n")) as { decisions: Array<Record<string, unknown>> };
      expect(payload.decisions[0]).toMatchObject({
        instanceId: "alpha",
        classification: "remote",
        deletable: false,
        stale: false,
      });
      expect(probeHealthCalled).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("stale and missing-JSON selections remain report-only even with --yes", async () => {
    const rows = [
      row({ instanceId: "stopped", displayId: "stopped", root: "/h/.nautilo-stopped", state: "idle" }),
      row({ instanceId: "orphan", displayId: "orphan", root: "/h/.nautilo-orphan", state: "no-instance-json" }),
    ];
    for (const args of [["--stale", "--yes", "--json"], ["--missing-instance-json", "--yes", "--json"]]) {
      logs.length = 0;
      await cleanupInstancesCmd(args, {
        userHomeDir: "/h",
        listLocal: async () => rows,
        probeMany: async () => [st("stopped", { isStale: true }), st("orphan")],
        readProfileAuthority: emptyAuthority,
        readDockerProjects: noDockerProjects,
        readWorkbenchListeners: noWorkbenchListeners,
        onExit: () => {},
      });
      const payload = JSON.parse(logs.join("\n")) as { reportOnly: boolean };
      expect(payload.reportOnly).toBe(true);
    }
  });

  test("canonical default is protected while named ID 'default' is ordinary", async () => {
    const rows = [
      row({ instanceId: "", displayId: "(default)", root: "/h/.nautilo", state: "idle" }),
      row({ instanceId: "default", displayId: "default", root: "/h/.nautilo-default", state: "idle" }),
    ];
    await cleanupInstancesCmd(["--json"], {
      userHomeDir: "/h",
      listLocal: async () => rows,
      probeMany: async () => [st(""), st("default")],
      readProfileAuthority: emptyAuthority,
      readDockerProjects: noDockerProjects,
      readWorkbenchListeners: noWorkbenchListeners,
      onExit: () => {},
    });
    const payload = JSON.parse(logs.join("\n")) as {
      decisions: Array<{ instanceId: string; deletable: boolean; classification: string }>;
    };
    expect(payload.decisions.find((decision) => decision.instanceId === "")).toMatchObject({
      classification: "local",
      deletable: false,
    });
    expect(payload.decisions.find((decision) => decision.instanceId === "default")).toMatchObject({
      classification: "local",
      deletable: true,
    });
  });

  test("marker-protected durable fixtures are not deletion candidates", async () => {
    const home = mkdtempSync(join(tmpdir(), "nautilo-cleanup-protected-"));
    try {
      const markedRoot = join(home, ".nautilo-capture-baseline");
      mkdirSync(markedRoot, { recursive: true });
      writeFileSync(join(markedRoot, ".protected-instance"), "purpose=publication\n", "utf8");
      const rows = [
        row({ instanceId: "ordinary-fixture", displayId: "ordinary-fixture", root: join(home, ".nautilo-ordinary-fixture"), state: "idle" }),
        row({ instanceId: "capture-baseline", displayId: "capture-baseline", root: markedRoot, state: "idle" }),
      ];
      await cleanupInstancesCmd(["--json"], {
        userHomeDir: home,
        listLocal: async () => rows,
        probeMany: async () => [st("ordinary-fixture"), st("capture-baseline")],
        readProfileAuthority: emptyAuthority,
        readDockerProjects: noDockerProjects,
        readWorkbenchListeners: noWorkbenchListeners,
        onExit: () => {},
      });
      const payload = JSON.parse(logs.join("\n")) as {
        decisions: Array<{ instanceId: string; deletable: boolean; reason: string }>;
      };
      expect(payload.decisions.find((decision) => decision.instanceId === "ordinary-fixture")).toMatchObject({
        deletable: true,
      });
      expect(payload.decisions.find((decision) => decision.instanceId === "capture-baseline")).toMatchObject({
        deletable: false,
        reason: "operator-owned durable fixture is protected",
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("legacy local profile protects a named root without an instance-local marker", async () => {
    const home = mkdtempSync(join(tmpdir(), "nautilo-cleanup-profile-durable-"));
    try {
      const profiles = join(home, ".nautilo", "profiles");
      mkdirSync(profiles, { recursive: true });
      writeFileSync(join(profiles, "kept.toml"), 'transport = "local"\nlifecycle = "compose"\ninstance_id = "kept"\n');
      await cleanupInstancesCmd(["--json"], {
        userHomeDir: home,
        listLocal: async () => [row({ instanceId: "kept", displayId: "kept", root: join(home, ".nautilo-kept"), state: "idle" })],
        probeMany: async () => [st("kept")],
        readDockerProjects: noDockerProjects,
        readWorkbenchListeners: noWorkbenchListeners,
        onExit: () => {},
      });
      const payload = JSON.parse(logs.join("\n")) as { decisions: Array<{ instanceId: string; deletable: boolean }> };
      expect(payload.decisions.find((decision) => decision.instanceId === "kept")).toMatchObject({ deletable: false });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("malformed and conflicting profile authority is unknown and preserved", async () => {
    const rows = [
      row({ instanceId: "conflict", displayId: "conflict", root: "/h/.nautilo-conflict", state: "idle" }),
      row({ instanceId: "other", displayId: "other", root: "/h/.nautilo-other", state: "idle" }),
    ];
    await cleanupInstancesCmd(["--json"], {
      userHomeDir: "/h",
      listLocal: async () => rows,
      probeMany: async () => [st("conflict"), st("other")],
      readProfileAuthority: () => ({
        claimsByInstanceId: new Map([
          [
            "conflict",
            [
              { profileName: "a", instanceId: "conflict", transport: "local" as const, retention: "durable" as const },
              { profileName: "b", instanceId: "conflict", transport: "remote" as const, retention: "unknown" as const },
            ],
          ],
        ]),
        unattributedErrors: ["profile broken is malformed"],
      }),
      readDockerProjects: noDockerProjects,
      readWorkbenchListeners: noWorkbenchListeners,
      onExit: () => {},
    });
    const payload = JSON.parse(logs.join("\n")) as {
      decisions: Array<{ instanceId: string; classification: string; deletable: boolean }>;
    };
    expect(payload.decisions.find((decision) => decision.instanceId === "conflict")).toMatchObject({
      classification: "unknown",
      deletable: false,
    });
    expect(payload.decisions.find((decision) => decision.instanceId === "other")).toMatchObject({
      classification: "unknown",
      deletable: false,
    });
  });

  test("human and JSON output expose the same classification, eligibility, activity, and reason", async () => {
    const rows = [
      row({ instanceId: "local", displayId: "local", root: "/h/.nautilo-local", state: "idle" }),
    ];
    const deps = {
      userHomeDir: "/h",
      listLocal: async () => rows,
      probeMany: async () => [st("local")],
      readProfileAuthority: emptyAuthority,
      readDockerProjects: async () => ({
        available: true,
        projects: new Map([
          ["nautilo-local", { runningContainers: 1, stoppedContainers: 2, volumes: 3 }],
        ]),
      }),
      readWorkbenchListeners: async () =>
        new Map([[3000, { state: "listening" as const, pid: 69_518 }]]),
      onExit: () => {},
    };
    await cleanupInstancesCmd(["--json"], deps);
    const json = JSON.parse(logs.join("\n")) as {
      decisions: Array<{
        classification: string;
        deletable: boolean;
        instanceJsonState: string;
        serverRunning: boolean;
        serverPid: number | null;
        serverCwd: string | null;
        serverAgeSeconds: number | null;
        activityAgeSeconds: number | null;
        workbenchPort: number | null;
        workbenchListenerState: string;
        workbenchPid: number | null;
        dockerState: string;
        dockerRunningContainers: number;
        dockerStoppedContainers: number;
        dockerVolumes: number;
        reason: string;
      }>;
    };
    logs.length = 0;
    await cleanupInstancesCmd([], deps);
    const human = logs.join("\n");
    const decision = json.decisions[0]!;
    expect(human).toContain(`classification=${decision.classification}`);
    expect(human).toContain(`deletable=${String(decision.deletable)}`);
    expect(human).toContain(`instanceJsonState=${decision.instanceJsonState}`);
    expect(human).toContain(`serverRunning=${String(decision.serverRunning)}`);
    expect(human).toContain(`serverPid=${decision.serverPid ?? "none"}`);
    expect(human).toContain(`serverCwd=${decision.serverCwd ?? "none"}`);
    expect(human).toContain(`serverAgeSeconds=${decision.serverAgeSeconds ?? "unknown"}`);
    expect(human).toContain(`activityAgeSeconds=${decision.activityAgeSeconds ?? "unknown"}`);
    expect(human).toContain(`workbenchPort=${decision.workbenchPort ?? "unknown"}`);
    expect(human).toContain(`workbenchListenerState=${decision.workbenchListenerState}`);
    expect(human).toContain(`workbenchPid=${decision.workbenchPid ?? "none"}`);
    expect(human).toContain(`dockerState=${decision.dockerState}`);
    expect(human).toContain(`dockerRunningContainers=${decision.dockerRunningContainers}`);
    expect(human).toContain(`dockerStoppedContainers=${decision.dockerStoppedContainers}`);
    expect(human).toContain(`dockerVolumes=${decision.dockerVolumes}`);
    expect(human).toContain(`reason=${decision.reason}`);
  });
});
