import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  __resetResolvedInstanceForTests,
  resolveInstanceUncached,
  resolveNautiloStorageRoot,
  deriveComposeContainerBundle,
  writeInstanceJson,
  type ResolvedInstance,
} from "@nautilo/config";
import { infraStart } from "../../src/commands/infra-start";
import { deleteInstance } from "../../src/commands/delete-instance";
import {
  CANONICAL_DEFAULT_SOURCE_EVIDENCE_FAILURE_CODES,
  CLONE_ACCEPTANCE_FAILURE_CODES,
  CLONE_DATABASES_STARTED_FAILURE_CODES,
  CLONE_COMPOSE_FAILURE_CATEGORIES,
  assertCanonicalDefaultSourceEvidenceUnchanged,
  canonicalDefaultSourceEvidenceFailureCode,
  cloneAcceptanceFailureCode,
  cloneAcceptanceVerifyFailureId,
  cloneDatabasesStartedFailureCode,
  cloneDatabasesStartedComposeCategory,
  captureCanonicalDefaultSourceEvidence,
  formatCloneFailure,
  materializeClone,
  type CloneMaterializationRequest,
} from "../../src/commands/clone";
import { AUTHORITATIVE_VERIFY_FAILURE_IDS } from "../../src/commands/verify";
import {
  cleanupCanonicalDefaultSeedCapture,
  createCanonicalDefaultSeedCapture,
  createCanonicalDefaultSourceEvidence,
  prepareCanonicalDefaultCloneSeed,
} from "../../src/lib/default-clone-seed";
import { selectCloneMaterialization, selectCloneSource } from "../../src/lib/clone-source-selection";
import { queryPostgresContainer } from "../../src/lib/postgres-archive";
import { readCheckoutMigrationLineage, type MigrationLineageEntry } from "../../src/lib/migration-lineage";
import { NAUTILO_REPO_ROOT } from "../../src/lib/compose-infra";
import { CLONE_STAGES, deriveCloneOperationNextStage } from "../../src/lib/clone-operation";
import { collectDockerPublishedTcpPorts } from "../../src/lib/docker-published-ports";

const RUN_LIVE = process.env["NAUTILO_RUN_D489_LIVE_ACCEPTANCE"] === "1";
const LIVE_CHILD = process.env["NAUTILO_D489_LIVE_CHILD"] === "1";
const describeLive = LIVE_CHILD ? describe : describe.skip;
const describeLauncher = RUN_LIVE && !LIVE_CHILD ? describe : describe.skip;
const MIGRATIONS_DIR = join(NAUTILO_REPO_ROOT, "packages/db/src/migrations");
const originalHome = process.env["HOME"];
const originalInstance = process.env["NAUTILO_INSTANCE_ID"];

function resolveDisposableSourceAllocator(input: {
  home: string;
  allocatorId: string;
  additionalClaimedPorts?: () => ReadonlySet<number>;
  skipHostBindProbe?: boolean;
}): ResolvedInstance {
  return resolveInstanceUncached(
    { HOME: input.home, NAUTILO_INSTANCE_ID: input.allocatorId },
    {
      userHomeDir: input.home,
      skipUserConfigOverlay: true,
      ...(input.skipHostBindProbe === true ? { skipHostBindProbe: true } : {}),
      additionalClaimedPorts: input.additionalClaimedPorts ?? (() => collectDockerPublishedTcpPorts()),
    },
  );
}

export function workerHomeMatchesDisposableAuthority(
  workerHome: string | undefined,
  disposableHome: string,
  journalRoot: string,
): boolean {
  if (workerHome === undefined) return false;
  const canonicalRoot = resolve(journalRoot);
  return resolve(workerHome) === canonicalRoot && resolve(disposableHome) === canonicalRoot;
}

const WORKER_STAGES = new Set([
  "source-infra-start",
  "source-population",
  "source-evidence",
  "aggregate-source",
  "seed-fresh-capture",
  "seed-fresh-prepare",
  "seed-reused-capture",
  "seed-reused-prepare",
  "seed-refreshed-capture",
  "seed-refreshed-prepare",
  "seed-lifecycle-assertions",
  "equal-materialize",
  "equal-aggregate",
  "equal-runtime",
  "equal-artifact",
  "forward-clone",
  "forward-prepare",
  "forward-materialize",
  "forward-migration-runner",
  "forward-copied-row",
  "forward-ledger",
  "forward-aggregate",
  "forward-server-health",
  "forward-logto-health",
  "rejection-and-corruption",
  "injected-failure-and-deletion",
  "injected-copied-row",
  "injected-materialize-rejected",
  "injected-operation-exists",
  "injected-operation-parse",
  "injected-operation-status",
  "injected-operation-failure",
  "injected-operation-completed-stages",
  "injected-deletion-guidance",
  "injected-target-stopped",
  "injected-delete-command",
  "injected-root-absent",
  "source-aggregate-restored",
  "source-evidence-restored",
  "public-evidence",
  "peak-docker-bytes",
  "peak-filesystem-bytes",
  "peak-journal-write",
  "acceptance-journal-write",
  "acceptance-complete",
]);
const WORKER_FAILURE_CODES = new Set([
  ...CANONICAL_DEFAULT_SOURCE_EVIDENCE_FAILURE_CODES,
  "aggregate-source",
  ...CLONE_STAGES.map((stage) => `equal-${stage}`),
  "equal-operation-unavailable",
  "equal-operation-invalid",
  "equal-operation-complete",
  ...CLONE_DATABASES_STARTED_FAILURE_CODES
    .filter((code) => !code.endsWith("compose"))
    .map((code) => `equal-${code}`),
  ...["legacy-compose", "logto-compose"].flatMap((step) =>
    CLONE_COMPOSE_FAILURE_CATEGORIES.map((category) => `equal-${step}-${category}`)
  ),
  "equal-aggregate",
  "equal-runtime",
  "equal-artifact-row",
  "equal-artifact-path",
  "equal-artifact-uri",
  "equal-artifact-size",
  "equal-artifact-file",
  "equal-artifact-bytes",
  "equal-artifact-hash",
  "equal-artifact-content",
  ...CLONE_STAGES.map((stage) => `forward-${stage}`),
  "forward-operation-unavailable",
  "forward-operation-invalid",
  "forward-operation-complete",
  ...CLONE_DATABASES_STARTED_FAILURE_CODES
    .filter((code) => !code.endsWith("compose"))
    .map((code) => `forward-${code}`),
  ...["legacy-compose", "logto-compose"].flatMap((step) =>
    CLONE_COMPOSE_FAILURE_CATEGORIES.map((category) => `forward-${step}-${category}`)
  ),
  ...CLONE_ACCEPTANCE_FAILURE_CODES.map((code) => `forward-acceptance-${code}`),
  ...AUTHORITATIVE_VERIFY_FAILURE_IDS.map((id) => `forward-acceptance-verify-${id}`),
  "forward-prepare",
  "forward-migration-runner",
  "forward-copied-row",
  "forward-ledger",
  "forward-aggregate",
  "forward-server-health",
  "forward-logto-health",
  "injected-copied-row",
  "injected-materialize-rejected",
  "injected-operation-exists",
  "injected-operation-parse",
  "injected-operation-status",
  "injected-operation-failure",
  "injected-operation-completed-stages",
  "injected-deletion-guidance",
  "injected-target-stopped",
  "injected-delete-command",
  "injected-root-absent",
  "source-aggregate-restored",
  "source-evidence-restored",
  "public-evidence",
  "peak-docker-bytes",
  "peak-filesystem-bytes",
  "peak-journal-write",
  "acceptance-journal-write",
  "source-isolation",
  "lineage",
  "seed-artifact",
  "source-service",
  "unclassified",
]);

function validateWorkerDiagnostics(workerStage?: unknown, workerFailureCode?: unknown): void {
  if (workerStage !== undefined && (typeof workerStage !== "string" || !WORKER_STAGES.has(workerStage))) {
    throw new Error("Invalid D489 worker stage");
  }
  if (
    workerFailureCode !== undefined &&
    (typeof workerFailureCode !== "string" || !WORKER_FAILURE_CODES.has(workerFailureCode))
  ) {
    throw new Error("Invalid D489 worker failure code");
  }
}

function operatorSentinel(home: string): string {
  const paths = [
    join(home, ".nautilo", "instance.json"),
    join(home, ".nautilo", "instance.env"),
    join(home, ".nautilo", "claim-invite.txt"),
    join(home, ".nautilo", ".bootstrap", "claim-invite"),
  ];
  return paths.map((path) => existsSync(path) ? `${path}|${sha(readFileSync(path))}` : `${path}|absent`).join("\n");
}

type DockerBaseline = {
  containers: string[];
  images: string[];
  volumes: string[];
  networks: string[];
  buildCache: string[];
  systemBytes: string;
};

type ResourceJournal = {
  formatVersion: 1;
  runId: string;
  journalPath: string;
  projects: string[];
  containers: string[];
  volumes: string[];
  networks: string[];
  requiredImages: string[];
  requiredImageIds: Record<string, string>;
  roots: string[];
  credentials: string[];
  pidFiles: string[];
  baseline: DockerBaseline;
  peakOwnedBytes: number | null;
  peakFilesystemBytes: number | null;
  workerStage?: string;
  launcherResult?: {
    exitCode: number | null;
    timedOut: boolean;
    requestedSignal: string | null;
    outputBytes: number;
  };
  workerFailureCode?: string;
  cleanup?: {
    attemptedAt: string;
    composeExitCodes: number[];
    remainingContainers: string[];
    remainingVolumes: string[];
    remainingNetworks: string[];
    ownedBytesAfterDockerCleanup: number;
    errors: string[];
    filesystemRemovalFailures: string[];
  };
};

function lines(command: string, args: string[]): string[] {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} read-only inventory failed`);
  return result.stdout.trim().split(/\s+/).filter(Boolean).sort();
}

function dockerBaseline(): DockerBaseline {
  const build = spawnSync("docker", ["builder", "du", "--format", "{{.ID}}"], { encoding: "utf8" });
  const bytes = spawnSync("docker", ["system", "df", "--format", "{{json .}}"], { encoding: "utf8" });
  if (build.error) throw build.error;
  if (bytes.error) throw bytes.error;
  if (build.status !== 0 || bytes.status !== 0) throw new Error("Docker byte inventory failed");
  return {
    containers: lines("docker", ["ps", "-aq"]),
    images: lines("docker", ["image", "ls", "-aq", "--no-trunc"]),
    volumes: lines("docker", ["volume", "ls", "-q"]),
    networks: lines("docker", ["network", "ls", "-q"]),
    buildCache: build.stdout.trim().split(/\s+/).filter(Boolean).sort(),
    systemBytes: bytes.stdout.trim(),
  };
}

function writeJournal(journal: ResourceJournal): void {
  const temp = `${journal.journalPath}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(journal, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, journal.journalPath);
}

function composeImages(): string[] {
  const refs = [
    ...lines("docker", ["compose", "-f", join(NAUTILO_REPO_ROOT, "infra/compose/nautilo.yml"), "--profile", "auth", "config", "--images"]),
    ...lines("docker", ["compose", "-f", join(NAUTILO_REPO_ROOT, "packages/db/docker/docker-compose.yml"), "config", "--images"]),
  ];
  return [...new Set(refs)].sort();
}

function projectResourceNames(projects: readonly string[]): {
  containers: string[]; volumes: string[]; networks: string[];
} {
  return {
    containers: projects.flatMap((project) => Object.values(deriveComposeContainerBundle(project))),
    volumes: projects.flatMap((project) => [`${project}_nautilo_pgdata`, `${project}_pgdata`]),
    networks: projects.flatMap((project) => [`${project}_default`, `${project}_nautilo-local`]),
  };
}

function labeledProjectObjects(
  kind: "container" | "volume" | "network",
  projects: readonly string[],
): string[] {
  const command = kind === "container" ? ["container", "ls", "-aq"] : [kind, "ls", "-q"];
  return projects.flatMap((project) => lines("docker", [
    ...command,
    "--filter",
    `label=com.docker.compose.project=${project}`,
  ]));
}

function parseDockerBytes(raw: string): number {
  const match = raw.trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*(B|kB|MB|GB|TB|KiB|MiB|GiB|TiB)$/);
  if (!match) throw new Error(`Unparseable Docker size: ${raw}`);
  const factors: Record<string, number> = {
    B: 1, kB: 1_000, MB: 1_000_000, GB: 1_000_000_000, TB: 1_000_000_000_000,
    KiB: 1_024, MiB: 1_048_576, GiB: 1_073_741_824, TiB: 1_099_511_627_776,
  };
  const bytes = Math.round(Number(match[1]) * factors[match[2]!]!);
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Invalid Docker byte measurement");
  return bytes;
}

export function isSafeNonnegativeByteEvidence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isCleanupByteEvidence(value: unknown): value is number {
  return value === -1 || isSafeNonnegativeByteEvidence(value);
}

export function addSafeNonnegativeBytes(total: number, next: number): number {
  if (!isSafeNonnegativeByteEvidence(total) || !isSafeNonnegativeByteEvidence(next)) {
    throw new Error("Invalid nonnegative byte measurement");
  }
  const sum = total + next;
  if (!Number.isSafeInteger(sum)) throw new Error("Byte measurement exceeds safe integer range");
  return sum;
}

export function parseOwnedDockerVolumeBytes(
  raw: string,
  wantedNames: ReadonlySet<string>,
): { bytes: number; measuredNames: Set<string> } {
  const report = JSON.parse(raw) as { Volumes?: unknown };
  if (!Array.isArray(report.Volumes)) throw new Error("Unsupported Docker volume report shape");
  let bytes = 0;
  const measuredNames = new Set<string>();
  for (const value of report.Volumes) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Unsupported Docker volume row shape");
    }
    const row = value as { Name?: unknown; Size?: unknown };
    if (typeof row.Name !== "string" || !wantedNames.has(row.Name)) continue;
    if (measuredNames.has(row.Name)) throw new Error("Duplicate Docker volume byte measurement");
    if (typeof row.Size !== "string") throw new Error("Docker volume size is missing");
    bytes = addSafeNonnegativeBytes(bytes, parseDockerBytes(row.Size));
    measuredNames.add(row.Name);
  }
  return { bytes, measuredNames };
}

function ownedDockerBytes(journal: ResourceJournal): number {
  let total = 0;
  for (const container of journal.containers) {
    const inspect = spawnSync(
      "docker",
      ["container", "inspect", "--size", container, "--format", "{{.SizeRw}}"],
      { encoding: "utf8" },
    );
    if (inspect.status !== 0) continue;
    const bytes = Number.parseInt(inspect.stdout.trim(), 10);
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Invalid container byte measurement");
    total = addSafeNonnegativeBytes(total, bytes);
  }
  const volumeDf = spawnSync(
    "docker",
    ["system", "df", "-v", "--format", "json"],
    { encoding: "utf8" },
  );
  if (volumeDf.error) throw volumeDf.error;
  if (volumeDf.status !== 0) throw new Error("Docker volume byte inventory failed");
  const wanted = new Set(journal.volumes);
  const measured = parseOwnedDockerVolumeBytes(volumeDf.stdout, wanted);
  total = addSafeNonnegativeBytes(total, measured.bytes);
  for (const name of measured.measuredNames) wanted.delete(name);
  for (const volume of [...wanted]) {
    if (spawnSync("docker", ["volume", "inspect", volume], { stdio: "ignore" }).status === 0) {
      throw new Error(`Docker volume ${volume} exists without a byte measurement`);
    }
  }
  return total;
}

export function filesystemBytes(root: string): number {
  if (!existsSync(root)) return 0;
  const stat = lstatSync(root);
  if (!stat.isDirectory()) {
    if (!isSafeNonnegativeByteEvidence(stat.size)) throw new Error("Invalid filesystem byte measurement");
    return stat.size;
  }
  return readdirSync(root).reduce(
    (sum, entry) => addSafeNonnegativeBytes(sum, filesystemBytes(join(root, entry))),
    0,
  );
}

function readJournal(path: string): ResourceJournal {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as ResourceJournal;
  const expectedPath = join(tmpdir(), `d489-live-default-clone-${parsed.runId}.journal.json`);
  const expectedRoot = join(tmpdir(), `d489-live-default-clone-${parsed.runId}`);
  const runKey = parsed.runId.slice(0, 8);
  if (
    parsed.formatVersion !== 1 || !/^[a-f0-9]{24}$/.test(parsed.runId) ||
    parsed.journalPath !== path || path !== expectedPath || !isAbsolute(path) || resolve(path) !== path ||
    !Array.isArray(parsed.projects) || !Array.isArray(parsed.roots) ||
    !Array.isArray(parsed.credentials) || !Array.isArray(parsed.pidFiles) ||
    parsed.roots[0] !== expectedRoot
  ) throw new Error("Invalid D489 resource journal identity");
  if (lstatSync(path).isSymbolicLink()) throw new Error("D489 resource journal refuses a symbolic-link journal");
  const stringArrays = [
    parsed.projects, parsed.containers, parsed.volumes, parsed.networks,
    parsed.requiredImages, parsed.roots, parsed.credentials, parsed.pidFiles,
    parsed.baseline?.containers, parsed.baseline?.images, parsed.baseline?.volumes,
    parsed.baseline?.networks, parsed.baseline?.buildCache,
  ];
  if (stringArrays.some((value) => !Array.isArray(value) || value.some((entry) => typeof entry !== "string"))) {
    throw new Error("Invalid D489 resource journal array schema");
  }
  if (
    typeof parsed.requiredImageIds !== "object" || parsed.requiredImageIds === null ||
    Object.entries(parsed.requiredImageIds).some(([ref, id]) =>
      !parsed.requiredImages.includes(ref) || typeof id !== "string" || !/^sha256:[a-f0-9]{64}$/.test(id)
    ) || Object.keys(parsed.requiredImageIds).length !== parsed.requiredImages.length ||
    typeof parsed.baseline?.systemBytes !== "string" ||
    !(parsed.peakOwnedBytes === null || isSafeNonnegativeByteEvidence(parsed.peakOwnedBytes)) ||
    !(parsed.peakFilesystemBytes === null || isSafeNonnegativeByteEvidence(parsed.peakFilesystemBytes))
  ) throw new Error("Invalid D489 resource journal evidence schema");
  if (parsed.cleanup !== undefined && (
    typeof parsed.cleanup.attemptedAt !== "string" ||
    !Array.isArray(parsed.cleanup.composeExitCodes) ||
    !Array.isArray(parsed.cleanup.remainingContainers) ||
    !Array.isArray(parsed.cleanup.remainingVolumes) ||
    !Array.isArray(parsed.cleanup.remainingNetworks) ||
    !Array.isArray(parsed.cleanup.errors) ||
    !Array.isArray(parsed.cleanup.filesystemRemovalFailures) ||
    !isCleanupByteEvidence(parsed.cleanup.ownedBytesAfterDockerCleanup)
  )) throw new Error("Invalid D489 cleanup evidence schema");
  if (parsed.launcherResult !== undefined && (
    !(parsed.launcherResult.exitCode === null || Number.isInteger(parsed.launcherResult.exitCode)) ||
    typeof parsed.launcherResult.timedOut !== "boolean" ||
    !(parsed.launcherResult.requestedSignal === null || typeof parsed.launcherResult.requestedSignal === "string") ||
    !Number.isSafeInteger(parsed.launcherResult.outputBytes) || parsed.launcherResult.outputBytes < 0
  )) throw new Error("Invalid D489 launcher evidence schema");
  validateWorkerDiagnostics(parsed.workerStage, parsed.workerFailureCode);
  for (const project of parsed.projects) {
    if (project !== `d489-default-${runKey}` && !project.startsWith(`nautilo-d489-${runKey}-`)) {
      throw new Error("D489 resource journal project is outside its run authority");
    }
  }
  const expectedResources = projectResourceNames(parsed.projects);
  for (const [actual, expected] of [
    [parsed.containers, expectedResources.containers],
    [parsed.volumes, expectedResources.volumes],
    [parsed.networks, expectedResources.networks],
  ] as const) {
    if (
      !Array.isArray(actual) ||
      JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())
    ) throw new Error("D489 resource journal object names do not match its projects");
  }
  const allowedRoots = new Set([
    expectedRoot,
    join(expectedRoot, ".nautilo"),
    ...parsed.projects
      .filter((project) => project.startsWith("nautilo-"))
      .map((project) => join(expectedRoot, `.nautilo-${project.slice("nautilo-".length)}`)),
  ]);
  for (const root of parsed.roots) {
    if (
      !isAbsolute(root) || resolve(root) !== root || !allowedRoots.has(root)
    ) {
      throw new Error("D489 resource journal root is outside its temporary authority");
    }
    if (existsSync(root) && lstatSync(root).isSymbolicLink()) {
      throw new Error("D489 resource journal refuses symbolic-link roots");
    }
  }
  for (const pathEntry of [...parsed.credentials, ...parsed.pidFiles]) {
    if (!isAbsolute(pathEntry) || resolve(pathEntry) !== pathEntry || !pathEntry.startsWith(`${expectedRoot}/`)) {
      throw new Error("D489 resource journal file is outside its temporary authority");
    }
    if (existsSync(pathEntry) && lstatSync(pathEntry).isSymbolicLink()) {
      throw new Error("D489 resource journal refuses symbolic-link files");
    }
  }
  return parsed;
}

function emergencyCleanup(journalPath: string): void {
  const journal = readJournal(journalPath);
  const isolatedHome = journal.roots[0]!;
  for (const pidFile of journal.pidFiles) {
    try {
      const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
      if (!Number.isSafeInteger(pid) || pid <= 1) continue;
      const command = spawnSync("ps", ["eww", "-p", String(pid), "-o", "command="], { encoding: "utf8" });
      const rootName = pidFile.slice(isolatedHome.length + 1).split("/")[0] ?? "";
      const instanceId = rootName.startsWith(".nautilo-") ? rootName.slice(".nautilo-".length) : "";
      if (
        command.status === 0 && /nautilo-server|bin\/nautilo-server/.test(command.stdout) &&
        command.stdout.includes(`HOME=${isolatedHome}`) &&
        (instanceId === "" || command.stdout.includes(`NAUTILO_INSTANCE_ID=${instanceId}`))
      ) {
        process.kill(pid, "SIGTERM");
      }
    } catch {
      // Exact Docker/root cleanup below still runs.
    }
  }
  const composeExitCodes: number[] = [];
  for (const project of journal.projects) {
    if (!/^(?:d489-default-|nautilo-d489-)[a-z0-9-]+$/.test(project)) continue;
    const logtoDown = spawnSync("docker", [
      "compose", "-p", project, "-f", "infra/compose/nautilo.yml",
      "--profile", "auth", "down", "-v", "--remove-orphans",
    ], { cwd: NAUTILO_REPO_ROOT, stdio: "ignore" });
    composeExitCodes.push(logtoDown.status ?? 1);
    const dbDown = spawnSync("docker", [
      "compose", "-p", project, "-f", "packages/db/docker/docker-compose.yml",
      "down", "-v", "--remove-orphans",
    ], { cwd: NAUTILO_REPO_ROOT, stdio: "ignore" });
    composeExitCodes.push(dbDown.status ?? 1);
  }
  // Compose can fail when a child was interrupted mid-write. Fall back only
  // to the exact names already committed to the validated journal.
  for (const container of journal.containers) {
    if (spawnSync("docker", ["container", "inspect", container], { stdio: "ignore" }).status === 0) {
      spawnSync("docker", ["container", "rm", "-f", container], { stdio: "ignore" });
    }
  }
  for (const volume of journal.volumes) {
    if (spawnSync("docker", ["volume", "inspect", volume], { stdio: "ignore" }).status === 0) {
      spawnSync("docker", ["volume", "rm", volume], { stdio: "ignore" });
    }
  }
  for (const network of journal.networks) {
    if (spawnSync("docker", ["network", "inspect", network], { stdio: "ignore" }).status === 0) {
      spawnSync("docker", ["network", "rm", network], { stdio: "ignore" });
    }
  }
  const errors: string[] = [];
  const safeLabeled = (kind: "container" | "volume" | "network"): string[] => {
    try { return labeledProjectObjects(kind, journal.projects); }
    catch { errors.push(`${kind}-label-inventory-failed`); return [`${kind}-inventory-unknown`]; }
  };
  const remainingContainers = [...new Set([
    ...journal.containers.filter((name) =>
      spawnSync("docker", ["container", "inspect", name], { stdio: "ignore" }).status === 0
    ),
    ...safeLabeled("container"),
  ])];
  const remainingVolumes = [...new Set([
    ...journal.volumes.filter((name) =>
      spawnSync("docker", ["volume", "inspect", name], { stdio: "ignore" }).status === 0
    ),
    ...safeLabeled("volume"),
  ])];
  const remainingNetworks = [...new Set([
    ...journal.networks.filter((name) =>
      spawnSync("docker", ["network", "inspect", name], { stdio: "ignore" }).status === 0
    ),
    ...safeLabeled("network"),
  ])];
  let ownedBytesAfterDockerCleanup = -1;
  try { ownedBytesAfterDockerCleanup = ownedDockerBytes(journal); }
  catch { errors.push("owned-byte-measurement-failed"); }
  const filesystemRemovalFailures: string[] = [];
  for (const root of journal.roots) {
    try { rmSync(root, { recursive: true, force: true }); }
    catch { filesystemRemovalFailures.push(root); }
  }
  for (const credential of journal.credentials) {
    try { rmSync(credential, { force: true }); }
    catch { filesystemRemovalFailures.push(credential); }
  }
  writeJournal({
    ...journal,
    cleanup: {
      attemptedAt: new Date().toISOString(),
      composeExitCodes,
      remainingContainers,
      remainingVolumes,
      remainingNetworks,
      ownedBytesAfterDockerCleanup,
      errors,
      filesystemRemovalFailures,
    },
  });
  if (
    remainingContainers.length > 0 || remainingVolumes.length > 0 ||
    remainingNetworks.length > 0 || ownedBytesAfterDockerCleanup !== 0 ||
    errors.length > 0 || filesystemRemovalFailures.length > 0
  ) throw new Error("D489 exact cleanup incomplete; journal retained for retry");
}

describeLauncher("D489 isolated live-acceptance launcher", () => {
  test("starts the worker with HOME established before any Nautilo module loads", async () => {
    const operatorHome = originalHome ?? "";
    const before = operatorSentinel(operatorHome);
    const defaultProjectBefore = projectObjects("nautilo");
    const runId = randomBytes(12).toString("hex");
    const nonce = runId.slice(0, 8);
    const project = `d489-default-${nonce}`;
    const isolatedHome = join(tmpdir(), `d489-live-default-clone-${runId}`);
    const journalPath = join(tmpdir(), `d489-live-default-clone-${runId}.journal.json`);
    const baseline = dockerBaseline();
    const requiredImages = composeImages();
    const requiredImageIds: Record<string, string> = {};
    for (const image of requiredImages) {
      const inspect = spawnSync(
        "docker",
        ["image", "inspect", image, "--format", "{{.Id}}"],
        { encoding: "utf8" },
      );
      if (inspect.status !== 0) throw new Error(`D489 live acceptance refuses to pull missing image ${image}`);
      requiredImageIds[image] = inspect.stdout.trim();
    }
    const sourceResources = projectResourceNames([project]);
    writeJournal({
      formatVersion: 1,
      runId,
      journalPath,
      projects: [project],
      ...sourceResources,
      requiredImages,
      requiredImageIds,
      roots: [isolatedHome],
      credentials: [
        join(isolatedHome, ".nautilo", "instance.env"),
        join(isolatedHome, ".nautilo", "claim-invite.txt"),
        join(isolatedHome, ".nautilo", "logto-admin.txt"),
        join(isolatedHome, ".nautilo", ".bootstrap", "claim-invite"),
      ],
      pidFiles: [join(isolatedHome, ".nautilo", "server.pid")],
      baseline,
      peakOwnedBytes: null,
      peakFilesystemBytes: null,
    });
    expect(ownedDockerBytes(readJournal(journalPath))).toBe(0);
    mkdirSync(isolatedHome, { recursive: false, mode: 0o700 });
    const child = spawn("bun", ["test", import.meta.path], {
      cwd: NAUTILO_REPO_ROOT,
      env: {
        ...process.env,
        HOME: isolatedHome,
        NAUTILO_INSTANCE_ID: "",
        NAUTILO_D489_LIVE_CHILD: "1",
        NAUTILO_D489_LIVE_HOME: isolatedHome,
        NAUTILO_D489_LIVE_NONCE: nonce,
        NAUTILO_D489_JOURNAL: journalPath,
        NAUTILO_DISPOSABLE_NO_PULL_BUILD: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let outputBytes = 0;
    const consume = (chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > 64 * 1024 * 1024) child.kill("SIGTERM");
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    let timedOut = false;
    let requestedSignal: "SIGINT" | "SIGTERM" | null = null;
    let escalation: ReturnType<typeof setTimeout> | null = null;
    const requestChildStop = (signal: "SIGINT" | "SIGTERM"): void => {
      requestedSignal = signal;
      child.kill(signal);
      escalation ??= setTimeout(() => child.kill("SIGKILL"), 5_000);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      requestChildStop("SIGTERM");
    }, 900_000);
    const onSigint = (): void => {
      requestChildStop("SIGINT");
    };
    const onSigterm = (): void => {
      requestChildStop("SIGTERM");
    };
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    let exitCode: number | null = null;
    try {
      exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
        child.once("error", rejectExit);
        child.once("close", resolveExit);
      });
    } finally {
      clearTimeout(timeout);
      if (escalation !== null) clearTimeout(escalation);
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      emergencyCleanup(journalPath);
    }
    if (requestedSignal !== null) process.exitCode = requestedSignal === "SIGINT" ? 130 : 143;
    let journal = readJournal(journalPath);
    writeJournal({
      ...journal,
      launcherResult: {
        exitCode,
        timedOut,
        requestedSignal,
        outputBytes,
      },
    });
    journal = readJournal(journalPath);
    for (const projectName of journal.projects) expect(projectObjects(projectName)).toBe("");
    expect(labeledProjectObjects("volume", journal.projects)).toEqual([]);
    expect(labeledProjectObjects("network", journal.projects)).toEqual([]);
    for (const container of journal.containers) {
      expect(spawnSync("docker", ["container", "inspect", container], { stdio: "ignore" }).status).not.toBe(0);
    }
    for (const volume of journal.volumes) {
      expect(spawnSync("docker", ["volume", "inspect", volume], { stdio: "ignore" }).status).not.toBe(0);
    }
    for (const network of journal.networks) {
      expect(spawnSync("docker", ["network", "inspect", network], { stdio: "ignore" }).status).not.toBe(0);
    }
    for (const root of journal.roots) expect(existsSync(root)).toBe(false);
    for (const credential of journal.credentials) expect(existsSync(credential)).toBe(false);
    for (const pidFile of journal.pidFiles) {
      expect(existsSync(pidFile)).toBe(false);
    }
    for (const [image, imageId] of Object.entries(journal.requiredImageIds)) {
      expect(spawnSync("docker", ["image", "inspect", image, "--format", "{{.Id}}"], { encoding: "utf8" }).stdout.trim())
        .toBe(imageId);
    }
    const byteEvidence = {
      beforeOwnedBytes: 0,
      peakOwnedBytes: journal.peakOwnedBytes,
      peakFilesystemBytes: journal.peakFilesystemBytes,
      afterOwnedBytes: ownedDockerBytes(journal),
      afterFilesystemBytes: journal.roots.reduce(
        (sum, root) => addSafeNonnegativeBytes(sum, filesystemBytes(root)),
        0,
      ),
      dockerSystemBefore: baseline.systemBytes,
      dockerSystemAfter: dockerBaseline().systemBytes,
    };
    expect(byteEvidence.afterOwnedBytes).toBe(0);
    expect(byteEvidence.afterFilesystemBytes).toBe(0);
    expect(operatorSentinel(operatorHome)).toBe(before);
    expect(projectObjects("nautilo")).toBe(defaultProjectBefore);
    if (timedOut || exitCode !== 0 || outputBytes > 64 * 1024 * 1024) {
      throw new Error(
        `D489 live worker failed at ${journal.workerStage ?? "unknown stage"}; ` +
        `owner-only cleanup journal retained at ${journalPath}`,
      );
    }
    expect(byteEvidence.peakOwnedBytes).toBeGreaterThan(0);
    expect(byteEvidence.peakFilesystemBytes).toBeGreaterThan(0);
    rmSync(journalPath, { force: true });
  }, 930_000);
});

type Aggregate = {
  users: number;
  rooms: number;
  memories: number;
  artifacts: number;
  artifactBytes: number;
  signInExperiences: number;
  logtoUsers: number;
  providerConfigSha256: string;
  instanceEnvSha256: string;
  lineageCount: number;
  serviceState: string;
};

function sha(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

type EqualArtifactProjection = {
  path: string;
  storageUri: string;
  size: number;
};

export function equalArtifactProjectionFailureCode(
  projection: string,
  expected: EqualArtifactProjection,
): string | null {
  if (projection === "") return "equal-artifact-row";
  const [path, storageUri, size, ...extra] = projection.split("|");
  if (extra.length !== 0 || path === undefined || storageUri === undefined || size === undefined) {
    return "equal-artifact-row";
  }
  if (path !== expected.path) return "equal-artifact-path";
  if (storageUri !== expected.storageUri) return "equal-artifact-uri";
  if (size !== String(expected.size)) return "equal-artifact-size";
  return null;
}

export function classifySeedFailureMessage(text: string): string {
  return /source.*(?:changed|mismatch|restor)/i.test(text)
    ? "source-isolation"
    : /lineage|migration/i.test(text)
      ? "lineage"
      : /backup|artifact|manifest|seed/i.test(text)
        ? "seed-artifact"
        : /docker|container|postgres|logto/i.test(text)
          ? "source-service"
          : "unclassified";
}

describe("D489 secret-free seed failure classification", () => {
  test("binds worker HOME to disposable authority and leaves operator config proof to the parent", () => {
    const disposableHome = join(tmpdir(), "d489-disposable-home");
    expect(workerHomeMatchesDisposableAuthority(disposableHome, disposableHome, disposableHome)).toBe(true);
    expect(workerHomeMatchesDisposableAuthority(
      join(disposableHome, "..", "d489-disposable-home"),
      disposableHome,
      disposableHome,
    ))
      .toBe(true);
    expect(workerHomeMatchesDisposableAuthority(undefined, disposableHome, disposableHome)).toBe(false);
    expect(workerHomeMatchesDisposableAuthority(
      join(tmpdir(), "operator-home"),
      disposableHome,
      disposableHome,
    )).toBe(false);
    const matchingOutsideHome = join(tmpdir(), "matching-but-unowned-home");
    expect(workerHomeMatchesDisposableAuthority(
      matchingOutsideHome,
      matchingOutsideHome,
      disposableHome,
    )).toBe(false);
  });

  test("allocates the disposable source against one Docker port inventory", () => {
    const testHome = join(tmpdir(), `d489-source-allocator-${randomBytes(12).toString("hex")}`);
    mkdirSync(testHome, { recursive: true, mode: 0o700 });
    let calls = 0;
    const firstNamedLegacyPort = 5534;
    try {
      const allocated = resolveDisposableSourceAllocator({
        home: testHome,
        allocatorId: "d489-source-test",
        skipHostBindProbe: true,
        additionalClaimedPorts: () => {
          calls++;
          return new Set([firstNamedLegacyPort]);
        },
      });
      expect(calls).toBe(1);
      expect(allocated.db.postgresHostPort).not.toBe(firstNamedLegacyPort);
      expect(existsSync(join(testHome, ".nautilo-d489-source-test", "instance.json"))).toBe(true);
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  test("accepts only fixed worker stages and failure codes", () => {
    expect(() => validateWorkerDiagnostics("seed-fresh-capture", "seed-artifact")).not.toThrow();
    expect(() => validateWorkerDiagnostics("acceptance-complete", "unclassified")).not.toThrow();
    expect(() => validateWorkerDiagnostics("injected-operation-status", "injected-operation-status")).not.toThrow();
    expect(() => validateWorkerDiagnostics("raw database error", "seed-artifact")).toThrow("Invalid D489 worker stage");
    expect(() => validateWorkerDiagnostics("source-evidence", "password=secret")).toThrow(
      "Invalid D489 worker failure code",
    );
    expect(() => validateWorkerDiagnostics("forward-migration-runner", "forward-migration-runner")).not.toThrow();
    expect(() => validateWorkerDiagnostics(42, null)).toThrow("Invalid D489 worker stage");
  });

  test("persists stable categories without copying raw errors", () => {
    expect(classifySeedFailureMessage("source writer state was not restored")).toBe("source-isolation");
    expect(classifySeedFailureMessage("migration lineage diverged")).toBe("lineage");
    expect(classifySeedFailureMessage("backup manifest artifact failed verification")).toBe("seed-artifact");
    expect(classifySeedFailureMessage("Logto postgres container stopped")).toBe("source-service");
    expect(classifySeedFailureMessage("inv_secret-value")).toBe("unclassified");
  });

  test("accepts an exact rebound artifact URI without rejecting its default-root prefix", () => {
    const sourceRoot = "/tmp/d489-home/.nautilo";
    const targetRoot = `${sourceRoot}-d489-equal`;
    const expected = {
      path: "d489/witness.txt",
      storageUri: `file://${targetRoot}/artifacts/artifact-id`,
      size: 17,
    };
    expect(equalArtifactProjectionFailureCode(
      `${expected.path}|${expected.storageUri}|${expected.size}`,
      expected,
    )).toBeNull();
    expect(equalArtifactProjectionFailureCode(
      `${expected.path}|file://${sourceRoot}/artifacts/artifact-id|${expected.size}`,
      expected,
    )).toBe("equal-artifact-uri");
  });

  test("measures owned volumes from the aggregate Docker disk-report shape", () => {
    const measured = parseOwnedDockerVolumeBytes(JSON.stringify({
      Containers: [],
      Volumes: [
        { Name: "owned-a", Size: "1.5MB" },
        { Name: "foreign", Size: "9GB" },
        { Name: "owned-b", Size: "2KiB" },
      ],
      Images: [],
      BuildCache: [],
    }), new Set(["owned-a", "owned-b"]));
    expect(measured.bytes).toBe(1_502_048);
    expect([...measured.measuredNames].sort()).toEqual(["owned-a", "owned-b"]);
    expect(() => parseOwnedDockerVolumeBytes('{"Volumes":{}}', new Set())).toThrow(
      "Unsupported Docker volume report shape",
    );
    expect(() => parseOwnedDockerVolumeBytes(JSON.stringify({
      Volumes: [{ Name: "owned", Size: "1MB" }, { Name: "owned", Size: "1MB" }],
    }), new Set(["owned"]))).toThrow("Duplicate Docker volume byte measurement");
    expect(() => parseOwnedDockerVolumeBytes(JSON.stringify({
      Volumes: [{ Name: "owned-a", Size: "9000TB" }, { Name: "owned-b", Size: "9000TB" }],
    }), new Set(["owned-a", "owned-b"]))).toThrow("Byte measurement exceeds safe integer range");
  });

  test("rejects unsafe byte evidence and aggregate overflow", () => {
    expect(isSafeNonnegativeByteEvidence(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(isSafeNonnegativeByteEvidence(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    expect(isSafeNonnegativeByteEvidence(-1)).toBe(false);
    expect(isSafeNonnegativeByteEvidence(1.5)).toBe(false);
    expect(addSafeNonnegativeBytes(Number.MAX_SAFE_INTEGER - 1, 1)).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => addSafeNonnegativeBytes(Number.MAX_SAFE_INTEGER, 1)).toThrow(
      "Byte measurement exceeds safe integer range",
    );
    expect(isCleanupByteEvidence(-1)).toBe(true);
    expect(isCleanupByteEvidence(0)).toBe(true);
    expect(isCleanupByteEvidence(-2)).toBe(false);
    expect(isCleanupByteEvidence(1.5)).toBe(false);
    expect(isCleanupByteEvidence(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
  });

  test("counts owned symlink inode bytes without following the target", () => {
    const root = mkdtempSync(join(tmpdir(), "d489-filesystem-bytes-"));
    try {
      writeFileSync(join(root, "owned.txt"), "12345", { mode: 0o600 });
      symlinkSync("owned.txt", join(root, "link"));
      expect(filesystemBytes(root)).toBe(5 + lstatSync(join(root, "link")).size);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function docker(args: string[]): string {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout).trim());
  return result.stdout.trim();
}

function projectObjects(project: string): string {
  return docker([
    "ps", "-a", "--filter", `label=com.docker.compose.project=${project}`,
    "--format", "{{.ID}}|{{.Names}}|{{.State}}",
  ]);
}

function dbCount(inst: ResolvedInstance, table: string): number {
  return Number.parseInt(queryPostgresContainer({
    container: inst.compose.containers.legacyPostgres,
    database: "nautilo",
    sql: `SELECT count(*) FROM public.${table};`,
  }), 10);
}

function logtoProjection(inst: ResolvedInstance): { count: number; sha256: string } {
  const value = queryPostgresContainer({
    container: inst.compose.containers.logtoPostgres,
    database: "logto_nautilo",
    user: "logto",
    sql: "SELECT tenant_id || '|' || sign_in_mode::text FROM sign_in_experiences ORDER BY tenant_id;",
  });
  return { count: value === "" ? 0 : value.split("\n").length, sha256: sha(value) };
}

function logtoCount(inst: ResolvedInstance, table: string): number {
  return Number.parseInt(queryPostgresContainer({
    container: inst.compose.containers.logtoPostgres,
    database: "logto_nautilo",
    user: "logto",
    sql: `SELECT count(*) FROM public.${table};`,
  }), 10);
}

function ledgerCount(inst: ResolvedInstance): number {
  return Number.parseInt(queryPostgresContainer({
    container: inst.compose.containers.legacyPostgres,
    database: "nautilo",
    sql: "SELECT count(*) FROM drizzle.__drizzle_migrations;",
  }), 10);
}

function serviceState(inst: ResolvedInstance): string {
  return docker([
    "inspect", "-f", "{{.Name}}|{{.State.Running}}|{{.State.Paused}}",
    inst.compose.containers.legacyPostgres,
    inst.compose.containers.logtoPostgres,
    inst.compose.containers.logtoCore,
  ]);
}

async function aggregate(inst: ResolvedInstance): Promise<Aggregate> {
  const projection = logtoProjection(inst);
  const envRaw = await readFile(
    join(resolveNautiloStorageRoot(process.env["HOME"] ?? "", inst.instanceId), "instance.env"),
    "utf8",
  );
  return {
    users: dbCount(inst, "users"),
    rooms: dbCount(inst, "rooms"),
    memories: dbCount(inst, "memories"),
    artifacts: dbCount(inst, "artifacts"),
    artifactBytes: Number.parseInt(queryPostgresContainer({
      container: inst.compose.containers.legacyPostgres,
      database: "nautilo",
      sql: "SELECT COALESCE(sum(size), 0) FROM public.artifacts WHERE deleted_at IS NULL;",
    }), 10),
    signInExperiences: projection.count,
    logtoUsers: logtoCount(inst, "users"),
    providerConfigSha256: projection.sha256,
    instanceEnvSha256: sha(envRaw),
    lineageCount: ledgerCount(inst),
    serviceState: serviceState(inst),
  };
}

function cloneRequest(home: string, targetId: string): CloneMaterializationRequest {
  return selectCloneMaterialization({
    userHome: home,
    source: { kind: "canonical-default" },
    targetId,
  });
}

describeLive("D489 live disposable default-clone acceptance", () => {
  let home = "";
  let source!: ResolvedInstance;
  let sourceProject = "";
  let artifactId = "";
  let artifactBody = "";
  let providerSentinelSha256 = "";
  let runKey = "";
  const targetIds: string[] = [];

  const publishAuthority = (): void => {
    const journalPath = process.env["NAUTILO_D489_JOURNAL"];
    if (!journalPath) throw new Error("D489 live worker requires its parent resource journal");
    const current = readJournal(journalPath);
    const roots = [resolveNautiloStorageRoot(home, ""), ...targetIds.map((id) => resolveNautiloStorageRoot(home, id))];
    const credentials = roots.flatMap((root) => [
      join(root, "instance.env"),
      join(root, "claim-invite.txt"),
      join(root, "logto-admin.txt"),
      join(root, ".bootstrap", "claim-invite"),
    ]);
    writeJournal({
      ...current,
      ...projectResourceNames([...new Set([
        ...current.projects, sourceProject, ...targetIds.map((id) => `nautilo-${id}`),
      ])].filter(Boolean)),
      projects: [...new Set([...current.projects, sourceProject, ...targetIds.map((id) => `nautilo-${id}`)])].filter(Boolean),
      roots: [...new Set([...current.roots, ...roots])],
      credentials: [...new Set([...current.credentials, ...credentials])],
      pidFiles: [...new Set([...current.pidFiles, ...roots.map((root) => join(root, "server.pid"))])],
    });
  };
  const publishStage = (workerStage: string): void => {
    const journalPath = process.env["NAUTILO_D489_JOURNAL"]!;
    writeJournal({ ...readJournal(journalPath), workerStage });
  };
  const registerTarget = (id: string): void => {
    targetIds.push(id);
    publishAuthority();
  };

  beforeAll(async () => {
    home = process.env["NAUTILO_D489_LIVE_HOME"] ?? "";
    runKey = process.env["NAUTILO_D489_LIVE_NONCE"] ?? "";
    if (home === "" || !/^[a-f0-9]{8}$/.test(runKey)) {
      throw new Error("D489 live worker requires its parent-owned HOME and run key");
    }
    const journalPath = process.env["NAUTILO_D489_JOURNAL"];
    if (!journalPath) throw new Error("D489 live worker requires its parent resource journal");
    const journal = readJournal(journalPath);
    if (!workerHomeMatchesDisposableAuthority(originalHome, home, journal.roots[0]!)) {
      throw new Error("D489 live worker HOME must match its journal-owned disposable authority");
    }
    sourceProject = `d489-default-${runKey}`;
    publishAuthority();
    const allocatorId = `d489ports-${runKey}`;
    const allocator = resolveDisposableSourceAllocator({ home, allocatorId });
    publishAuthority();
    await rm(resolveNautiloStorageRoot(home, allocatorId), { recursive: true, force: true });
    const root = join(home, ".nautilo");
    writeInstanceJson(root, {
      ...allocator,
      instanceId: "",
      deploymentMode: "local-self-host",
      compose: { projectName: sourceProject },
    });
    const providerSentinel = randomBytes(24).toString("base64url");
    providerSentinelSha256 = sha(providerSentinel);
    const workbenchDist = join(root, "workbench-dist");
    await mkdir(workbenchDist, { recursive: true, mode: 0o700 });
    await writeFile(
      join(workbenchDist, "index.html"),
      "<!doctype html><html><body>D489 isolated workbench</body></html>",
      { mode: 0o600 },
    );
    await writeFile(join(root, "instance.env"), [
      `NAUTILO_DB_PASSWORD=${randomBytes(24).toString("base64url")}`,
      `NAUTILO_AGENT_DB_PASSWORD=${randomBytes(24).toString("base64url")}`,
      `LOGTO_DB_PASSWORD=${randomBytes(24).toString("base64url")}`,
      `D489_PROVIDER_SENTINEL=${providerSentinel}`,
      `NAUTILO_WORKBENCH_DIST=${workbenchDist}`,
      "",
    ].join("\n"), { mode: 0o600 });
    process.env["HOME"] = home;
    process.env["NAUTILO_INSTANCE_ID"] = "";
    __resetResolvedInstanceForTests();
    source = resolveInstanceUncached({ HOME: home, NAUTILO_INSTANCE_ID: "" }, { skipUserConfigOverlay: true });
    expect(source.compose.projectName).toBe(sourceProject);
    expect(source.compose.projectName).not.toBe("nautilo");
    publishStage("source-infra-start");
    expect(await infraStart({
      iKnowWhatIAmDoing: true,
      operatorHomeDir: home,
      noPullOrBuild: true,
    })).toBe(0);
    publishStage("source-population");
    // infra:start creates the first invite before server runtime normally
    // seeds the owner. On this disposable authority remove that disposable
    // invite so D374 does not interpret it as prior-life evidence, then run
    // the exact production seeders directly.
    queryPostgresContainer({
      container: source.compose.containers.legacyPostgres,
      database: "nautilo",
      sql: "DELETE FROM public.invites;",
    });
    const db = await import("@nautilo/db");
    const ownerId = await db.seedDefaultOwner();
    const { actorId } = await db.seedTrustPersonal(ownerId, "user");
    const agentId = await db.seedDefaultAgent(ownerId);
    await db.seedDefaultRoom(ownerId, actorId, agentId);

    // Server startup creates the real owner/agent/room graph. Add only the
    // two acceptance rows whose byte/count identity must be easy to observe.
    artifactId = randomUUID();
    artifactBody = `d489-artifact-${randomBytes(32).toString("hex")}`;
    const artifactRoot = join(root, "artifacts");
    await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
    await writeFile(join(artifactRoot, artifactId), artifactBody, { mode: 0o600 });
    queryPostgresContainer({
      container: source.compose.containers.legacyPostgres,
      database: "nautilo",
      sql: `
        INSERT INTO public.memories (content, creation_key)
        VALUES ('D489 copied-row migration witness', 'd489-live-witness');
        INSERT INTO public.artifacts (artifact_id, path, mime_type, size, storage_uri)
        VALUES ('${artifactId}', 'd489/witness.txt', 'text/plain', ${Buffer.byteLength(artifactBody)},
                'file://${join(artifactRoot, artifactId)}');
      `,
    });
    await writeFile(join(root, "session.json"), "source-auth-cache-must-not-clone", { mode: 0o600 });
    await writeFile(join(root, "desktop-auth-live.json"), "source-auth-cache-must-not-clone", { mode: 0o600 });
    const populated = await aggregate(source);
    expect(populated.users).toBeGreaterThan(0);
    expect(populated.rooms).toBeGreaterThan(0);
    expect(populated.memories).toBeGreaterThan(0);
    expect(populated.artifacts).toBeGreaterThan(0);
    expect(populated.signInExperiences).toBeGreaterThan(0);
  }, 240_000);

  afterAll(() => {
    // The worker never deletes its own authority. Parent-only cleanup runs
    // after the child has fully exited, so it cannot race live writers.
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    if (originalInstance === undefined) delete process.env["NAUTILO_INSTANCE_ID"];
    else process.env["NAUTILO_INSTANCE_ID"] = originalInstance;
    __resetResolvedInstanceForTests();
  });

  test("captures/reuses/refreshes and drives real equal, forward, rejected, corrupt, and failed clones", async () => {
    const sourceSelection = selectCloneSource(home, { kind: "canonical-default" });
    publishStage("source-evidence");
    const recordFailure = (workerFailureCode: string): void => {
      const journalPath = process.env["NAUTILO_D489_JOURNAL"]!;
      writeJournal({ ...readJournal(journalPath), workerFailureCode });
    };
    const recordFailureIfAbsent = (workerFailureCode: string): void => {
      const journalPath = process.env["NAUTILO_D489_JOURNAL"]!;
      if (readJournal(journalPath).workerFailureCode === undefined) recordFailure(workerFailureCode);
    };
    const checked = async <T>(stage: string, action: () => T | Promise<T>): Promise<T> => {
      publishStage(stage);
      try {
        return await action();
      } catch (error) {
        recordFailureIfAbsent(stage);
        throw error;
      }
    };
    const recordPeakSample = async (): Promise<void> => {
      const before = readJournal(process.env["NAUTILO_D489_JOURNAL"]!);
      const dockerBytes = await checked("peak-docker-bytes", () => ownedDockerBytes(before));
      const ownedFilesystemBytes = await checked("peak-filesystem-bytes", () => filesystemBytes(home));
      await checked("peak-journal-write", () => {
        const current = readJournal(process.env["NAUTILO_D489_JOURNAL"]!);
        writeJournal({
          ...current,
          peakOwnedBytes: Math.max(current.peakOwnedBytes ?? 0, dockerBytes),
          peakFilesystemBytes: Math.max(current.peakFilesystemBytes ?? 0, ownedFilesystemBytes),
        });
      });
    };
    let sourceIsolationBefore: Awaited<ReturnType<typeof captureCanonicalDefaultSourceEvidence>>;
    let sourceBefore: Aggregate;
    try {
      sourceIsolationBefore = await captureCanonicalDefaultSourceEvidence(sourceSelection);
    } catch (error) {
      recordFailure(canonicalDefaultSourceEvidenceFailureCode(error) ?? "source-snapshot");
      throw error;
    }
    publishStage("aggregate-source");
    try {
      sourceBefore = await aggregate(source);
    } catch (error) {
      recordFailure("aggregate-source");
      throw error;
    }
    const checkout = await readCheckoutMigrationLineage(MIGRATIONS_DIR);
    const last = checkout.at(-1);
    if (!last) throw new Error("checkout has no migration lineage");
    const seedRoot = join(home, ".nautilo-clone-seeds", "canonical-default");
    const commit = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: NAUTILO_REPO_ROOT,
      encoding: "utf8",
    }).stdout.trim();
    expect(commit).toMatch(/^[a-f0-9]{40}$/);
    const provenance = {
      checkoutCommitSha: commit,
      lineage: {
        appliedMigrationCount: checkout.length,
        lastAppliedIndex: last.index,
        sha256: sha(JSON.stringify(checkout)),
      },
    };
    const sourceEvidence = createCanonicalDefaultSourceEvidence(sourceSelection);
    const prepare = (label: "fresh" | "reused" | "refreshed", forceRefresh = false) => {
      const capture = createCanonicalDefaultSeedCapture(seedRoot);
      return prepareCanonicalDefaultCloneSeed({
        source: sourceSelection,
        root: seedRoot,
        provenance,
        capture: async () => {
          publishStage(`seed-${label}-capture`);
          return capture();
        },
        cleanupCapture: () => cleanupCanonicalDefaultSeedCapture(seedRoot),
        sourceEvidence,
        forceRefresh,
      });
    };
    const timed = async <T>(action: () => Promise<T>) => {
      const start = performance.now();
      const value = await action();
      return { value, durationMs: performance.now() - start };
    };
    const timedSeed = async <T>(stage: string, action: () => Promise<T>): Promise<{ value: T; durationMs: number }> => {
      publishStage(stage);
      try { return await timed(action); }
      catch (error) {
        const text = error instanceof Error ? error.message : "non-error";
        const workerFailureCode = classifySeedFailureMessage(text);
        recordFailure(workerFailureCode);
        throw error;
      }
    };
    const fresh = await timedSeed("seed-fresh-prepare", () => prepare("fresh"));
    const reused = await timedSeed("seed-reused-prepare", () => prepare("reused"));
    const refreshed = await timedSeed("seed-refreshed-prepare", () => prepare("refreshed", true));
    publishStage("seed-lifecycle-assertions");
    expect(fresh.value.freshness).toBe("fresh");
    expect(reused.value.freshness).toBe("reused");
    expect(refreshed.value.freshness).toBe("fresh");
    expect(reused.value.seed.generation).toBe(fresh.value.seed.generation);
    expect(refreshed.value.seed.generation).not.toBe(fresh.value.seed.generation);
    const archivedHome = spawnSync("tar", [
      "-tzf",
      join(
        refreshed.value.seed.backup.dir,
        refreshed.value.seed.backup.manifest.artifacts.nautiloHome.file,
      ),
    ], { encoding: "utf8" });
    expect(archivedHome.status).toBe(0);
    expect(archivedHome.stdout).not.toMatch(
      /(?:^|\/)(?:session\.json|desktop-auth[^/]*\.json|claim-invite\.txt|logto-admin\.txt|\.bootstrap\/claim-invite)$/m,
    );

    const admission = { seed: refreshed.value.seed, freshness: refreshed.value.freshness } as const;
    const equalId = `d489-${runKey}-equal-${randomBytes(3).toString("hex")}`;
    registerTarget(equalId);
    const equalRoot = resolveNautiloStorageRoot(home, equalId);
    publishStage("equal-materialize");
    try {
      expect(await materializeClone(cloneRequest(home, equalId), admission, {
        mode: "provision", quiet: true, noPullOrBuild: true,
      })).toBe(0);
    } catch (error) {
      const operationPath = join(equalRoot, "clone-operation.json");
      let code = "equal-operation-unavailable";
      const databasesStartedCode = cloneDatabasesStartedFailureCode(error);
      if (databasesStartedCode !== null) {
        const composeCategory = cloneDatabasesStartedComposeCategory(error);
        code = composeCategory === null
          ? `equal-${databasesStartedCode}`
          : `equal-${databasesStartedCode}-${composeCategory}`;
      }
      if (existsSync(operationPath)) {
        try {
          const next = deriveCloneOperationNextStage(JSON.parse(readFileSync(operationPath, "utf8")));
          if (databasesStartedCode === null) {
            code = next === "complete" ? "equal-operation-complete" : `equal-${next}`;
          }
        } catch {
          if (databasesStartedCode === null) code = "equal-operation-invalid";
        }
      }
      recordFailure(code);
      throw error;
    }
    const equal = resolveInstanceUncached({ HOME: home, NAUTILO_INSTANCE_ID: equalId }, { skipUserConfigOverlay: true });
    publishStage("equal-aggregate");
    try {
      expect(ledgerCount(equal) - sourceBefore.lineageCount).toBe(0);
      expect(await aggregate(equal)).toMatchObject({
        users: sourceBefore.users,
        rooms: sourceBefore.rooms,
        memories: sourceBefore.memories,
        artifacts: sourceBefore.artifacts,
        artifactBytes: sourceBefore.artifactBytes,
        signInExperiences: sourceBefore.signInExperiences,
        logtoUsers: sourceBefore.logtoUsers,
        providerConfigSha256: sourceBefore.providerConfigSha256,
      });
    } catch (error) {
      recordFailure("equal-aggregate");
      throw error;
    }
    publishStage("equal-runtime");
    try {
      expect(existsSync(join(equalRoot, "session.json"))).toBe(false);
      expect(existsSync(join(equalRoot, "desktop-auth-live.json"))).toBe(false);
      const targetEnv = await readFile(join(equalRoot, "instance.env"), "utf8");
      const reboundProvider = targetEnv.match(/^D489_PROVIDER_SENTINEL=(.+)$/m)?.[1] ?? "";
      expect(sha(reboundProvider)).toBe(providerSentinelSha256);
    } catch (error) {
      recordFailure("equal-runtime");
      throw error;
    }
    publishStage("equal-artifact");
    try {
      const artifactProjection = queryPostgresContainer({
        container: equal.compose.containers.legacyPostgres,
        database: "nautilo",
        sql: `SELECT path || '|' || storage_uri || '|' || size FROM artifacts WHERE artifact_id='${artifactId}';`,
      });
      const projectionFailure = equalArtifactProjectionFailureCode(artifactProjection, {
        path: "d489/witness.txt",
        storageUri: `file://${join(equalRoot, "artifacts", artifactId)}`,
        size: Buffer.byteLength(artifactBody),
      });
      if (projectionFailure !== null) {
        recordFailure(projectionFailure);
        throw new Error("D489 equal artifact database projection mismatch");
      }
      const artifactPath = join(equalRoot, "artifacts", artifactId);
      if (!existsSync(artifactPath)) {
        recordFailure("equal-artifact-file");
        throw new Error("D489 equal artifact target file is absent");
      }
      const clonedArtifactBody = await readFile(artifactPath, "utf8");
      if (Buffer.byteLength(clonedArtifactBody) !== Buffer.byteLength(artifactBody)) {
        recordFailure("equal-artifact-bytes");
        throw new Error("D489 equal artifact target byte count mismatch");
      }
      if (sha(clonedArtifactBody) !== sha(artifactBody)) {
        recordFailure("equal-artifact-hash");
        throw new Error("D489 equal artifact target hash mismatch");
      }
      if (clonedArtifactBody !== artifactBody) {
        recordFailure("equal-artifact-content");
        throw new Error("D489 equal artifact target content mismatch");
      }
    } catch (error) {
      if (readJournal(process.env["NAUTILO_D489_JOURNAL"]!).workerFailureCode === undefined) {
        recordFailure("equal-artifact-row");
      }
      throw error;
    }

    const forwardId = `d489-${runKey}-forward-${randomBytes(3).toString("hex")}`;
    publishStage("forward-clone");
    registerTarget(forwardId);
    const forwardTag = `${String(checkout.length).padStart(4, "0")}_d489_live_copied_row_witness`;
    const forwardSql = `
DO $d489$
BEGIN
  IF (SELECT count(*) FROM public.users) <> ${sourceBefore.users}
     OR (SELECT count(*) FROM public.rooms) <> ${sourceBefore.rooms}
     OR (SELECT count(*) FROM public.memories) <> ${sourceBefore.memories} THEN
    RAISE EXCEPTION 'D489 copied rows are not visible to forward migration';
  END IF;
END
$d489$;
CREATE TABLE public.d489_clone_migration_witness AS
  SELECT count(*)::bigint AS copied_memories FROM public.memories;
`;
    const forward: MigrationLineageEntry = {
      index: checkout.length,
      tag: forwardTag,
      createdAt: last.createdAt + 1,
      sha256: sha(forwardSql),
    };
    const forwardMigrations = join(home, "d489-forward-migrations");
    const forwardJournalPath = join(forwardMigrations, "meta", "_journal.json");
    const forwardConfig = join(home, "d489-forward-drizzle.config.ts");
    publishStage("forward-prepare");
    try {
      await cp(MIGRATIONS_DIR, forwardMigrations, { recursive: true, errorOnExist: true });
      const forwardJournal = JSON.parse(await readFile(forwardJournalPath, "utf8")) as {
        entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
      };
      forwardJournal.entries.push({
        idx: forward.index,
        version: "7",
        when: forward.createdAt,
        tag: forward.tag,
        breakpoints: true,
      });
      await writeFile(forwardJournalPath, `${JSON.stringify(forwardJournal, null, 2)}\n`, { mode: 0o600 });
      await writeFile(join(forwardMigrations, `${forward.tag}.sql`), forwardSql, { mode: 0o600 });
      await writeFile(forwardConfig, `
export default {
  schema: ${JSON.stringify(join(NAUTILO_REPO_ROOT, "packages/db/src/schema/index.ts"))},
  out: ${JSON.stringify(forwardMigrations)},
  dialect: "postgresql",
  dbCredentials: { url: process.env.DB_DIRECT_CONNECTION },
  strict: true,
};
`, { mode: 0o600 });
    } catch (error) {
      recordFailure("forward-prepare");
      throw error;
    }
    let copiedRowsObserved = false;
    publishStage("forward-materialize");
    try {
      expect(await materializeClone(cloneRequest(home, forwardId), admission, {
      mode: "full",
      quiet: true,
      noPullOrBuild: true,
      disposableMigrationAcceptance: {
        checkoutLineage: [...checkout, forward],
        run: async ({ target, targetEnv }) => {
          publishAuthority();
          publishStage("forward-migration-runner");
          expect(targetEnv["NAUTILO_INSTANCE_ROOT"]).toBe(resolveNautiloStorageRoot(home, target.instanceId));
          const migrated = spawnSync("bunx", ["drizzle-kit", "migrate", "--config", forwardConfig], {
            cwd: join(NAUTILO_REPO_ROOT, "packages/db"),
            env: targetEnv,
            encoding: "utf8",
            maxBuffer: 32 * 1024 * 1024,
          });
          if (migrated.error || migrated.status !== 0) {
            recordFailure("forward-migration-runner");
            throw new Error("D489 real forward migration runner failed");
          }
          publishStage("forward-copied-row");
          copiedRowsObserved = queryPostgresContainer({
            container: target.compose.containers.legacyPostgres,
            database: "nautilo",
            sql: "SELECT copied_memories FROM public.d489_clone_migration_witness;",
          }) === String(sourceBefore.memories);
          if (!copiedRowsObserved) {
            recordFailure("forward-copied-row");
            throw new Error("D489 forward migration copied-row witness mismatch");
          }
        },
      },
      })).toBe(0);
    } catch (error) {
      const operationPath = join(resolveNautiloStorageRoot(home, forwardId), "clone-operation.json");
      const acceptanceCode = cloneAcceptanceFailureCode(error);
      const verifyFailureId = cloneAcceptanceVerifyFailureId(error);
      const databasesStartedCode = cloneDatabasesStartedFailureCode(error);
      if (verifyFailureId !== null) {
        recordFailureIfAbsent(`forward-acceptance-verify-${verifyFailureId}`);
      } else if (acceptanceCode !== null) {
        recordFailureIfAbsent(`forward-acceptance-${acceptanceCode}`);
      } else if (databasesStartedCode !== null) {
        const composeCategory = cloneDatabasesStartedComposeCategory(error);
        recordFailureIfAbsent(composeCategory === null
          ? `forward-${databasesStartedCode}`
          : `forward-${databasesStartedCode}-${composeCategory}`);
      } else {
        let code = "forward-operation-unavailable";
        try {
          const next = deriveCloneOperationNextStage(JSON.parse(readFileSync(operationPath, "utf8")));
          code = next === "complete" ? "forward-operation-complete" : `forward-${next}`;
        } catch {
          if (existsSync(operationPath)) code = "forward-operation-invalid";
        }
        recordFailureIfAbsent(code);
      }
      throw error;
    }
    publishStage("forward-copied-row");
    try {
      expect(copiedRowsObserved).toBe(true);
    } catch (error) {
      recordFailure("forward-copied-row");
      throw error;
    }
    const forwardTarget = resolveInstanceUncached({ HOME: home, NAUTILO_INSTANCE_ID: forwardId }, { skipUserConfigOverlay: true });
    publishStage("forward-ledger");
    try {
      expect(ledgerCount(forwardTarget) - sourceBefore.lineageCount).toBe(1);
    } catch (error) {
      recordFailure("forward-ledger");
      throw error;
    }
    publishStage("forward-aggregate");
    try {
      expect(await aggregate(forwardTarget)).toMatchObject({
        users: sourceBefore.users,
        rooms: sourceBefore.rooms,
        memories: sourceBefore.memories,
        artifacts: sourceBefore.artifacts,
        signInExperiences: sourceBefore.signInExperiences,
        logtoUsers: sourceBefore.logtoUsers,
      });
    } catch (error) {
      recordFailure("forward-aggregate");
      throw error;
    }
    publishStage("forward-server-health");
    try {
      expect(await fetch(`${forwardTarget.server.url}/health`).then((response) => response.ok)).toBe(true);
    } catch (error) {
      recordFailure("forward-server-health");
      throw error;
    }
    publishStage("forward-logto-health");
    try {
      expect(await fetch(`http://localhost:${forwardTarget.logto.corePort}/oidc/.well-known/openid-configuration`).then((response) => response.ok)).toBe(true);
    } catch (error) {
      recordFailure("forward-logto-health");
      throw error;
    }

    const rejected = async (id: string, lineage: readonly MigrationLineageEntry[]) => {
      registerTarget(id);
      return materializeClone(cloneRequest(home, id), admission, {
        mode: "provision", quiet: true, noPullOrBuild: true,
        disposableMigrationAcceptance: { checkoutLineage: lineage, run: async () => undefined },
      }).then(() => false, () => true);
    };
    expect(await rejected(`d489-${runKey}-ahead-${randomBytes(3).toString("hex")}`, checkout.slice(0, -1))).toBe(true);
    expect(await rejected(`d489-${runKey}-divergent-${randomBytes(3).toString("hex")}`, [
      { ...checkout[0]!, sha256: sha("divergent") }, ...checkout.slice(1),
    ])).toBe(true);

    const databaseArtifact = join(
      refreshed.value.seed.backup.dir,
      refreshed.value.seed.backup.manifest.artifacts.nautiloDatabase.file,
    );
    const originalArtifact = await readFile(databaseArtifact);
    await writeFile(databaseArtifact, "corrupt-d489-seed", { mode: 0o600 });
    const corruptId = `d489-${runKey}-corrupt-${randomBytes(3).toString("hex")}`;
    publishStage("rejection-and-corruption");
    registerTarget(corruptId);
    expect(await materializeClone(cloneRequest(home, corruptId), admission, {
      mode: "provision", quiet: true, noPullOrBuild: true,
    })
      .then(() => false, () => true)).toBe(true);
    await writeFile(databaseArtifact, originalArtifact, { mode: 0o600 });

    const failedId = `d489-${runKey}-failed-${randomBytes(3).toString("hex")}`;
    publishStage("injected-failure-and-deletion");
    registerTarget(failedId);
    const failedRoot = join(home, `.nautilo-${failedId}`);
    const materializeRejected = await materializeClone(cloneRequest(home, failedId), admission, {
      mode: "provision", quiet: true, noPullOrBuild: true,
      disposableMigrationAcceptance: {
        checkoutLineage: [...checkout, forward],
        run: async ({ target }) => {
          publishAuthority();
          await checked("injected-copied-row", () => {
            expect(dbCount(target, "memories")).toBe(sourceBefore.memories);
          });
          throw new Error("D489 injected migration failure");
        },
      },
    }).then(() => false, () => true);
    await checked("injected-materialize-rejected", () => {
      expect(materializeRejected).toBe(true);
    });
    const operationPath = join(failedRoot, "clone-operation.json");
    await checked("injected-operation-exists", () => {
      expect(existsSync(operationPath)).toBe(true);
    });
    const failedOperation = await checked("injected-operation-parse", async () =>
      JSON.parse(await readFile(operationPath, "utf8")) as {
        status?: string; failure?: string; completedStages?: string[];
      });
    await checked("injected-operation-status", () => {
      expect(failedOperation.status).toBe("failed");
    });
    await checked("injected-operation-failure", () => {
      expect(failedOperation.failure).toBe("D489 injected migration failure");
    });
    await checked("injected-operation-completed-stages", () => {
      expect(failedOperation.completedStages).not.toContain("nautilo-migrated");
    });
    await checked("injected-deletion-guidance", () => {
      expect(formatCloneFailure(operationPath, failedId)).toContain(`dev:delete-instance ${failedId} --yes`);
    });
    const failed = resolveInstanceUncached({ HOME: home, NAUTILO_INSTANCE_ID: failedId }, { skipUserConfigOverlay: true });
    await checked("injected-target-stopped", () => {
      expect(projectObjects(failed.compose.projectName)).not.toContain("|running");
    });
    // Capture the high-water mark before the only worker-owned destructive
    // deletion, while every admitted target's volumes and roots still exist.
    await recordPeakSample();
    await checked("injected-delete-command", async () => {
      expect(await deleteInstance({ id: failedId, yes: true, userHomeDir: home })).toBe(0);
    });
    await checked("injected-root-absent", () => {
      expect(existsSync(failedRoot)).toBe(false);
    });

    const sourceAfter = await checked("source-aggregate-restored", async () => {
      const aggregateAfter = await aggregate(source);
      expect(aggregateAfter).toEqual(sourceBefore);
      return aggregateAfter;
    });
    await checked("source-evidence-restored", () =>
      assertCanonicalDefaultSourceEvidenceUnchanged(sourceIsolationBefore, sourceSelection));
    const publicEvidence = {
      seed: {
        freshGeneration: fresh.value.seed.generation,
        freshCapturedAt: fresh.value.seed.operation.capture.capturedAt,
        freshMs: fresh.durationMs,
        reusedGeneration: reused.value.seed.generation,
        reusedCapturedAt: reused.value.seed.operation.capture.capturedAt,
        reusedMs: reused.durationMs,
        refreshedGeneration: refreshed.value.seed.generation,
        refreshedCapturedAt: refreshed.value.seed.operation.capture.capturedAt,
        refreshedMs: refreshed.durationMs,
        lineage: refreshed.value.seed.operation.source.lineage,
        artifactCount: Object.keys(refreshed.value.seed.backup.manifest.artifacts).length,
        artifactBytes: Object.values(refreshed.value.seed.backup.manifest.artifacts)
          .reduce((total, artifact) => total + artifact.bytes, 0),
      },
      equalApplied: 0,
      forwardApplied: 1,
      sourceRestored: sourceAfter.serviceState === sourceBefore.serviceState,
      failedTargetDeleted: !existsSync(failedRoot),
    };
    await checked("public-evidence", () => {
      expect(JSON.stringify(publicEvidence)).not.toMatch(/PASSWORD|SENTINEL|base64url/i);
      writeFileSync(join(home, "d489-default-clone-acceptance.json"), `${JSON.stringify(publicEvidence, null, 2)}\n`, { mode: 0o600 });
    });
    const journalPath = process.env["NAUTILO_D489_JOURNAL"]!;
    await recordPeakSample();
    await checked("acceptance-journal-write", () => {
      const journal = readJournal(journalPath);
      writeJournal({
        ...journal,
        workerStage: "acceptance-complete",
      });
    });
  }, 900_000);
});
