/** `cleanup-instances` — deterministic, profile-aware local instance doctor. */
import { homedir } from "node:os";
import {
  classifyProfileAuthority,
  listLocalInstances,
  readProfileInstanceAuthority,
  type InstanceAuthorityClassification,
  type ProfileInstanceAuthority,
} from "@nautilo/instance-discovery/node";
import { probeManyInstanceProcessStates, type InstanceProcessState } from "../lib/process-state";
import { formatHelp, hasHelpFlag, type HelpSpec } from "../lib/cli-help";
import { isProtectedDurableInstance } from "../lib/protected-durable-instance";

const CLEANUP_INSTANCES_HELP: HelpSpec = {
  name: "cleanup-instances",
  summary: "Report profile-aware cleanup decisions for ~/.nautilo* layout dirs (never bulk-deletes).",
  usage:
    "bun run dev:cleanup-instances [--stale | --missing-instance-json | --name <pat>] [--yes] [--json]",
  flags: [
    {
      flag: "--stale",
      description: "Report rows whose diagnostic stale predicate holds. This mode never deletes.",
    },
    {
      flag: "--missing-instance-json",
      description: "Report rows without instance.json. This mode never deletes.",
    },
    {
      flag: "--name <pat>",
      description:
        "Filter the report by name. '*' is a wildcard regex; no '*' is a literal substring. This mode never deletes.",
    },
    {
      flag: "--yes",
      description: "Accepted for compatibility; cleanup remains report-only and fail-closed.",
    },
    { flag: "--json", description: "Emit the same decisions as structured JSON." },
    { flag: "--help, -h", description: "Show this help and exit." },
  ],
  examples: [
    { cmd: "bun run dev:cleanup-instances", desc: "Report every classified local layout root." },
    {
      cmd: "bun run dev:cleanup-instances --stale --json",
      desc: "Report stale diagnostics without deleting anything.",
    },
    {
      cmd: "bun run dev:delete-instance <exact-id> --yes",
      desc: "Delete one positively local named instance after reviewing this report.",
    },
  ],
  notes: [
    "All cleanup modes are report-only. Automatic deletion by name, age, PID absence, or missing JSON is intentionally disabled.",
    "Host-server, Workbench-listener, Compose-container, and labeled-volume observations are evidence for review, not disposal authority.",
    "Remote profiles and their local projections are never probed or deleted by this command.",
    "The canonical empty-ID (default) and named instances marked with `bun run dev:protect-instance <id>` are protected; a named ID literally called 'default' is ordinary.",
    "Remote profile/server lifecycle remains the responsibility of the deployment CLI.",
  ],
};

export interface CleanupInstancesOptions {
  mode: "stale" | "missing-instance-json" | "name";
  namePattern?: string;
  yes?: boolean;
  asJson?: boolean;
}

export type CleanupInstancesDeps = {
  userHomeDir?: string;
  listLocal?: typeof listLocalInstances;
  probeMany?: typeof probeManyInstanceProcessStates;
  readProfileAuthority?: typeof readProfileInstanceAuthority;
  readDockerProjects?: typeof readDockerProjectSnapshot;
  readWorkbenchListeners?: typeof readWorkbenchListenerSnapshot;
  /** When set, do not call `process.exit` — used by unit tests. */
  onExit?: (code: number) => void;
};

type LocalInstanceRow = Awaited<ReturnType<typeof listLocalInstances>>[number];

type ParsedCli =
  | { ok: true; mode: CleanupInstancesOptions["mode"] | null; namePattern?: string; yes: boolean; asJson: boolean }
  | { ok: false; message: string };

export type CleanupDecision = {
  displayId: string;
  instanceId: string;
  root: string;
  instanceJsonState: "valid" | "missing" | "invalid";
  stale: boolean;
  serverRunning: boolean;
  serverPid: number | null;
  serverCwd: string | null;
  serverAgeSeconds: number | null;
  activityAgeSeconds: number | null;
  workbenchPort: number | null;
  workbenchListenerState: WorkbenchListenerState;
  workbenchPid: number | null;
  dockerState: DockerProjectState;
  dockerRunningContainers: number;
  dockerStoppedContainers: number;
  dockerVolumes: number;
  classification: InstanceAuthorityClassification;
  deletable: boolean;
  reason: string;
};

export type DockerProjectState = "running" | "stopped" | "absent" | "unavailable";
export type WorkbenchListenerState = "listening" | "absent" | "unavailable" | "not-configured";

export type WorkbenchListenerObservation = {
  state: Exclude<WorkbenchListenerState, "not-configured">;
  pid: number | null;
};

export type WorkbenchListenerSnapshot = ReadonlyMap<number, WorkbenchListenerObservation>;

export type DockerProjectObservation = {
  runningContainers: number;
  stoppedContainers: number;
  volumes: number;
};

export type DockerProjectSnapshot = {
  available: boolean;
  projects: ReadonlyMap<string, DockerProjectObservation>;
};

const DEFAULT_DISPLAY = "(default)";

export function parseListenerPid(stdout: string): number | null {
  const pids = stdout
    .split(/\s+/)
    .map((value) => Number.parseInt(value, 10))
    .filter((value): value is number => Number.isInteger(value) && value > 0);
  return pids.length === 0 ? null : Math.min(...pids);
}

/** Parse `lsof -Fpn` records into the lowest listener PID per TCP port. */
export function parseWorkbenchListeningPids(stdout: string): Map<number, number> {
  const pidsByPort = new Map<number, number>();
  let currentPid: number | null = null;

  for (const field of stdout.split("\n")) {
    if (field.startsWith("p")) {
      currentPid = parseListenerPid(field.slice(1));
      continue;
    }
    if (!field.startsWith("n") || currentPid === null) continue;
    const portMatch = /:(\d+)$/.exec(field.slice(1));
    const port = portMatch === null ? Number.NaN : Number.parseInt(portMatch[1]!, 10);
    if (!Number.isInteger(port) || port <= 0) continue;
    const existingPid = pidsByPort.get(port);
    if (existingPid === undefined || currentPid < existingPid) {
      pidsByPort.set(port, currentPid);
    }
  }

  return pidsByPort;
}

/** Map one local listener inventory to every configured Workbench port. */
export function mapWorkbenchListeningPids(
  ports: ReadonlyArray<number>,
  pidsByPort: ReadonlyMap<number, number> | null,
): WorkbenchListenerSnapshot {
  const snapshot = new Map<number, WorkbenchListenerObservation>();
  for (const port of new Set(ports.filter((port) => port > 0))) {
    const pid = pidsByPort?.get(port);
    snapshot.set(
      port,
      pidsByPort === null
        ? { state: "unavailable", pid: null }
        : pid === undefined
          ? { state: "absent", pid: null }
          : { state: "listening", pid },
    );
  }
  return snapshot;
}

async function readWorkbenchListeningPids(): Promise<Map<number, number> | null> {
  try {
    const proc = Bun.spawn(
      ["lsof", "-nP", "-Fpn", "-iTCP", "-sTCP:LISTEN"],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        signal: AbortSignal.timeout(2000),
      },
    );
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    return code === 0 || code === 1 ? parseWorkbenchListeningPids(stdout) : null;
  } catch {
    return null;
  }
}

/**
 * Inventory local TCP listeners once, then map configured Workbench ports without
 * making network requests. A failed inventory preserves fail-closed evidence.
 */
export async function readWorkbenchListenerSnapshot(
  rows: ReadonlyArray<Pick<LocalInstanceRow, "workbenchPort">>,
): Promise<WorkbenchListenerSnapshot> {
  const ports = rows.map((row) => row.workbenchPort);
  return mapWorkbenchListeningPids(ports, await readWorkbenchListeningPids());
}

export function parseDockerProjectRows(stdout: string): Map<string, DockerProjectObservation> {
  const projects = new Map<string, DockerProjectObservation>();
  for (const line of stdout.split("\n")) {
    const [projectName = "", rawState = ""] = line.trim().split("|", 2);
    if (projectName === "" || rawState === "") continue;
    const observation = projects.get(projectName) ?? {
      runningContainers: 0,
      stoppedContainers: 0,
      volumes: 0,
    };
    if (rawState === "running" || rawState === "restarting" || rawState === "paused") {
      observation.runningContainers++;
    } else {
      observation.stoppedContainers++;
    }
    projects.set(projectName, observation);
  }
  return projects;
}

export function addDockerProjectVolumeRows(
  projects: Map<string, DockerProjectObservation>,
  stdout: string,
): void {
  for (const projectName of stdout.split("\n").map((line) => line.trim())) {
    if (projectName === "") continue;
    const observation = projects.get(projectName) ?? {
      runningContainers: 0,
      stoppedContainers: 0,
      volumes: 0,
    };
    observation.volumes++;
    projects.set(projectName, observation);
  }
}

async function runDockerQuery(args: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(["docker", ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      signal: AbortSignal.timeout(2000),
    });
    const stdout = await new Response(proc.stdout).text();
    return (await proc.exited) === 0 ? stdout : null;
  } catch {
    return null;
  }
}

/** Read all local Compose project container and volume states without mutation. */
export async function readDockerProjectSnapshot(): Promise<DockerProjectSnapshot> {
  const [containers, volumes] = await Promise.all([
    runDockerQuery([
      "ps",
      "-a",
      "--filter",
      "label=com.docker.compose.project",
      "--format",
      '{{.Label "com.docker.compose.project"}}|{{.State}}',
    ]),
    runDockerQuery([
      "volume",
      "ls",
      "--filter",
      "label=com.docker.compose.project",
      "--format",
      '{{.Label "com.docker.compose.project"}}',
    ]),
  ]);
  if (containers === null || volumes === null) {
    return { available: false, projects: new Map() };
  }
  const projects = parseDockerProjectRows(containers);
  addDockerProjectVolumeRows(projects, volumes);
  return { available: true, projects };
}

function dockerObservationForProject(
  projectName: string,
  snapshot: DockerProjectSnapshot,
): {
  state: DockerProjectState;
  runningContainers: number;
  stoppedContainers: number;
  volumes: number;
} {
  if (!snapshot.available) {
    return { state: "unavailable", runningContainers: 0, stoppedContainers: 0, volumes: 0 };
  }
  const observation = snapshot.projects.get(projectName);
  if (!observation) {
    return { state: "absent", runningContainers: 0, stoppedContainers: 0, volumes: 0 };
  }
  return {
    state:
      observation.runningContainers > 0
        ? "running"
        : observation.stoppedContainers > 0
          ? "stopped"
          : "absent",
    runningContainers: observation.runningContainers,
    stoppedContainers: observation.stoppedContainers,
    volumes: observation.volumes,
  };
}

function escapeRegexChars(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

export function rowMatchesNamePattern(
  row: Pick<LocalInstanceRow, "displayId" | "instanceId">,
  pattern: string,
): boolean {
  const hay = [row.displayId, row.instanceId];
  if (pattern.includes("*")) {
    const body = pattern.split("*").map(escapeRegexChars).join(".*");
    const re = new RegExp(`^(?:${body})$`);
    return hay.some((value) => re.test(value));
  }
  return hay.some((value) => value.includes(pattern));
}

export function parseCleanupInstancesArgs(argv: string[]): ParsedCli {
  let stale = false;
  let missingJson = false;
  let namePattern: string | undefined;
  let yes = false;
  let asJson = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--stale") stale = true;
    else if (arg === "--missing-instance-json") missingJson = true;
    else if (arg === "--yes") yes = true;
    else if (arg === "--json") asJson = true;
    else if (arg === "--name") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { ok: false, message: "cleanup-instances: --name requires a pattern argument" };
      }
      namePattern = value;
      i++;
    } else {
      return { ok: false, message: `cleanup-instances: unknown argument: ${arg}` };
    }
  }

  const modeCount = Number(stale) + Number(missingJson) + Number(namePattern !== undefined);
  if (modeCount > 1) {
    return {
      ok: false,
      message:
        "cleanup-instances: modes are mutually exclusive — use at most one of --stale, --missing-instance-json, --name <pat>",
    };
  }
  if (namePattern !== undefined) return { ok: true, mode: "name", namePattern, yes, asJson };
  if (stale) return { ok: true, mode: "stale", yes, asJson };
  if (missingJson) return { ok: true, mode: "missing-instance-json", yes, asJson };
  return { ok: true, mode: null, yes, asJson };
}

function buildCleanupDecision(
  row: LocalInstanceRow,
  state: InstanceProcessState,
  authority: ProfileInstanceAuthority,
  dockerSnapshot: DockerProjectSnapshot,
  workbenchSnapshot: WorkbenchListenerSnapshot,
): CleanupDecision {
  const profileDecision = classifyProfileAuthority(row.instanceId, authority);
  let classification: InstanceAuthorityClassification;
  let reason: string;

  if (profileDecision?.classification === "remote") {
    classification = "remote";
    reason = profileDecision.reason;
  } else if (profileDecision?.classification === "unknown") {
    classification = "unknown";
    reason = profileDecision.reason;
  } else if (row.state === "invalid-json") {
    classification = "unknown";
    reason = `invalid or contradictory instance.json: ${row.detail ?? "validation failed"}`;
  } else if (profileDecision?.classification === "local") {
    classification = "local";
    reason = profileDecision.reason;
  } else if (row.state === "running" || row.state === "idle") {
    classification = "local";
    reason = "valid instance.json matches this local layout root";
  } else {
    classification = "unknown";
    reason = "missing instance.json and no local profile proves ownership";
  }

  let deletable = classification === "local" && row.instanceId !== "";
  const docker = dockerObservationForProject(row.projectName, dockerSnapshot);
  const workbench =
    row.workbenchPort > 0
      ? (workbenchSnapshot.get(row.workbenchPort) ?? { state: "unavailable" as const, pid: null })
      : { state: "not-configured" as const, pid: null };
  if (row.instanceId === "") {
    deletable = false;
    reason = "canonical empty-ID default instance is protected";
  } else if (isProtectedDurableInstance(row.root, profileDecision)) {
    deletable = false;
    reason = "operator-owned durable fixture is protected";
  } else if (classification === "local" && state.isRunning) {
    reason = `${reason}; server is running${state.serverPid === null ? "" : ` on pid ${state.serverPid}`}`;
  }

  return {
    displayId: row.displayId,
    instanceId: row.instanceId,
    root: row.root,
    instanceJsonState:
      row.state === "no-instance-json"
        ? "missing"
        : row.state === "invalid-json"
          ? "invalid"
          : "valid",
    stale: classification === "local" && state.isStale,
    serverRunning: state.isRunning,
    serverPid: state.serverPid,
    serverCwd: state.cwd,
    serverAgeSeconds: state.isRunning ? state.ageSeconds : null,
    activityAgeSeconds: state.idleSeconds,
    workbenchPort: row.workbenchPort > 0 ? row.workbenchPort : null,
    workbenchListenerState: workbench.state,
    workbenchPid: workbench.pid,
    dockerState: docker.state,
    dockerRunningContainers: docker.runningContainers,
    dockerStoppedContainers: docker.stoppedContainers,
    dockerVolumes: docker.volumes,
    classification,
    deletable,
    reason,
  };
}

function filterDecisions(
  decisions: CleanupDecision[],
  mode: CleanupInstancesOptions["mode"] | null,
  namePattern?: string,
): CleanupDecision[] {
  if (mode === "stale") return decisions.filter((decision) => decision.stale);
  if (mode === "missing-instance-json") {
    return decisions.filter((decision) => decision.instanceJsonState === "missing");
  }
  if (mode === "name" && namePattern !== undefined) {
    return decisions.filter((decision) => rowMatchesNamePattern(decision, namePattern));
  }
  return decisions;
}

export async function cleanupInstancesCmd(
  args: string[],
  deps: CleanupInstancesDeps = {},
): Promise<void> {
  const exit = (code: number) => {
    if (deps.onExit) deps.onExit(code);
    else process.exit(code);
  };

  if (hasHelpFlag(args)) {
    console.log(formatHelp(CLEANUP_INSTANCES_HELP));
    exit(0);
    return;
  }
  const parsed = parseCleanupInstancesArgs(args);
  if (!parsed.ok) {
    console.error(parsed.message);
    exit(2);
    return;
  }
  if (parsed.mode === "name" && parsed.namePattern?.trim() === DEFAULT_DISPLAY) {
    console.error("Refusing to target the canonical (default) instance.");
    exit(2);
    return;
  }

  const home = deps.userHomeDir?.trim() || homedir();
  const authority = (deps.readProfileAuthority ?? readProfileInstanceAuthority)(home);
  const rows = await (deps.listLocal ?? listLocalInstances)(home, {
    probeHealth: () => Promise.resolve(false),
  });
  const [states, dockerSnapshot, workbenchSnapshot] = await Promise.all([
    (deps.probeMany ?? probeManyInstanceProcessStates)(
      rows.map((row) => ({ instanceId: row.instanceId, instanceRoot: row.root })),
    ),
    (deps.readDockerProjects ?? readDockerProjectSnapshot)(),
    (deps.readWorkbenchListeners ?? readWorkbenchListenerSnapshot)(rows),
  ]);
  const allDecisions = rows.map((row, index) =>
    buildCleanupDecision(row, states[index]!, authority, dockerSnapshot, workbenchSnapshot),
  );
  const decisions = filterDecisions(allDecisions, parsed.mode, parsed.namePattern);
  const staleCount = allDecisions.filter((decision) => decision.stale).length;
  const missingInstanceJsonCount = allDecisions.filter(
    (decision) => decision.instanceJsonState === "missing",
  ).length;

  if (parsed.asJson) {
    console.log(
      JSON.stringify(
        {
          kind: parsed.mode === null ? "report" : "filtered-report",
          mode: parsed.mode,
          namePattern: parsed.namePattern,
          requestedYes: parsed.yes,
          reportOnly: true,
          staleCount,
          missingInstanceJsonCount,
          decisions,
        },
        null,
        2,
      ),
    );
    exit(0);
    return;
  }

  console.log("Nautilo instance cleanup doctor — report only (no changes made).");
  console.log(`Stale diagnostics: ${staleCount}; missing instance.json: ${missingInstanceJsonCount}`);
  if (decisions.length === 0) {
    console.log("No matching instance roots.");
  }
  for (const decision of decisions) {
    console.log(
      `${decision.displayId}: classification=${decision.classification} deletable=${String(decision.deletable)} instanceJsonState=${decision.instanceJsonState} serverRunning=${String(decision.serverRunning)} serverPid=${decision.serverPid ?? "none"} serverCwd=${decision.serverCwd ?? "none"} serverAgeSeconds=${decision.serverAgeSeconds ?? "unknown"} activityAgeSeconds=${decision.activityAgeSeconds ?? "unknown"} workbenchPort=${decision.workbenchPort ?? "unknown"} workbenchListenerState=${decision.workbenchListenerState} workbenchPid=${decision.workbenchPid ?? "none"} dockerState=${decision.dockerState} dockerRunningContainers=${decision.dockerRunningContainers} dockerStoppedContainers=${decision.dockerStoppedContainers} dockerVolumes=${decision.dockerVolumes} reason=${decision.reason}`,
    );
    if (decision.deletable) {
      if (
        decision.serverRunning ||
        decision.workbenchListenerState === "listening" ||
        decision.dockerState === "running"
      ) {
        console.log("  active local components detected; inspect and stop them before considering exact deletion");
      } else {
        console.log(
          `  eligible for reviewed exact deletion: bun run dev:delete-instance ${decision.instanceId} --yes`,
        );
      }
    }
  }
  if (parsed.yes) {
    console.log("--yes did not delete anything; cleanup modes are intentionally report-only.");
  }
  exit(0);
}
