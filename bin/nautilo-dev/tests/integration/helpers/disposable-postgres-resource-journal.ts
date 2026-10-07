/** Disposable PostgreSQL test-only exact resource ownership. Never prunes Docker or removes images. */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";

const JOURNAL_VERSION = 1 as const;
const RUN_RE = /^disposable-accept-[a-z0-9]{12}$/;
const DISPOSABLE_POSTGRES_ACCEPTANCE_PARENT = resolve(tmpdir(), "nautilo-disposable-acceptance");
const POSTGRES_INIT_COMPLETE = "PostgreSQL init process complete; ready for start up.";
const POSTGRES_READY = "database system is ready to accept connections";

/** Final-server readiness marker must occur after init-server completion, not before it. */
export function hasDisposablePostgresNormalPostgresReadyLog(logs: string): boolean {
  const initializedAt = logs.indexOf(POSTGRES_INIT_COMPLETE);
  return initializedAt >= 0 && logs.indexOf(POSTGRES_READY, initializedAt + POSTGRES_INIT_COMPLETE.length) >= 0;
}

export function advanceDisposablePostgresStableReadiness(
  priorSuccesses: number,
  probeSucceeded: boolean,
  requiredSuccesses = 2,
): { readonly consecutiveSuccesses: number; readonly ready: boolean } {
  if (!Number.isSafeInteger(priorSuccesses) || priorSuccesses < 0 || !Number.isSafeInteger(requiredSuccesses) || requiredSuccesses < 2) {
    throw new Error("Invalid Disposable PostgreSQL stable-readiness state");
  }
  const consecutiveSuccesses = probeSucceeded ? priorSuccesses + 1 : 0;
  return { consecutiveSuccesses, ready: consecutiveSuccesses >= requiredSuccesses };
}

export function parseDisposablePostgresLoopbackMappedPort(stdout: string): number {
  const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) throw new Error("Disposable PostgreSQL must have exactly one mapped port");
  const match = lines[0]!.match(/^127\.0\.0\.1:(\d+)$/);
  const port = Number(match?.[1]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("Invalid Disposable PostgreSQL loopback mapped port");
  return port;
}

export interface DisposablePostgresOwnedResources {
  readonly container: string;
  readonly volume: string;
  readonly network: string;
  readonly filesRoot: string;
}

export interface DisposablePostgresResourceJournal {
  readonly version: typeof JOURNAL_VERSION;
  readonly runId: string;
  readonly ownerPid: number;
  readonly createdAt: string;
  readonly image: { readonly reference: "postgres:16"; readonly id: string; readonly policy: "reuse-only-never-remove" };
  readonly resources: DisposablePostgresOwnedResources;
  readonly processes: readonly { readonly pid: number; readonly token: string }[];
  readonly measurements: {
    readonly beforeOwnedDockerBytes: 0;
    readonly peakOwnedDockerBytes: number | null;
    readonly afterOwnedDockerBytes: 0 | null;
    readonly beforeOwnedFilesystemBytes: 0;
    readonly peakOwnedFilesystemBytes: number | null;
    readonly afterOwnedFilesystemBytes: 0 | null;
  };
}

function docker(args: readonly string[]) {
  return spawnSync("docker", [...args], { encoding: "utf8", timeout: 120_000 });
}

export function expectedDisposablePostgresResourcePaths(runId: string) {
  if (!RUN_RE.test(runId)) throw new Error("Invalid Disposable PostgreSQL run ID");
  return {
    journalPath: join(DISPOSABLE_POSTGRES_ACCEPTANCE_PARENT, "journals", `${runId}.json`),
    resources: {
      container: `${runId}-pg`, volume: `${runId}-data`, network: `${runId}-net`,
      filesRoot: join(DISPOSABLE_POSTGRES_ACCEPTANCE_PARENT, "runs", runId),
    },
  } as const;
}

function assertOwnedPaths(path: string, journal: DisposablePostgresResourceJournal): void {
  if (!RUN_RE.test(journal.runId)) throw new Error("Invalid Disposable PostgreSQL run ID");
  const expected = expectedDisposablePostgresResourcePaths(journal.runId);
  if (resolve(path) !== expected.journalPath ||
      journal.resources.container !== expected.resources.container ||
      journal.resources.volume !== expected.resources.volume ||
      journal.resources.network !== expected.resources.network ||
      resolve(journal.resources.filesRoot) !== expected.resources.filesRoot) {
    throw new Error("Disposable PostgreSQL journal resources are not bound to its run ID");
  }
  const root = resolve(journal.resources.filesRoot);
  const forbidden = [resolve("/"), resolve(tmpdir()), resolve(homedir()), resolve(process.cwd())];
  if (forbidden.includes(root) || !root.startsWith(`${resolve(DISPOSABLE_POSTGRES_ACCEPTANCE_PARENT, "runs")}${sep}`)) {
    throw new Error("Unsafe Disposable PostgreSQL files root");
  }
  for (const part of [DISPOSABLE_POSTGRES_ACCEPTANCE_PARENT, dirname(path), dirname(root), root]) {
    if (existsSync(part) && lstatSync(part).isSymbolicLink()) throw new Error("Disposable PostgreSQL ownership path may not be a symlink");
  }
  if (journal.image.reference !== "postgres:16" || !/^sha256:[a-f0-9]{64}$/.test(journal.image.id) ||
      journal.image.policy !== "reuse-only-never-remove") throw new Error("Invalid Disposable PostgreSQL image ownership policy");
  if (journal.processes.some(({ pid, token }) => !Number.isSafeInteger(pid) || pid < 1 || !token.startsWith(`${journal.runId}-`))) {
    throw new Error("Invalid Disposable PostgreSQL process ownership");
  }
}

function writeOwnerOnly(path: string, journal: DisposablePostgresResourceJournal, initial = false): void {
  assertOwnedPaths(path, journal);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  if (lstatSync(dirname(path)).isSymbolicLink()) throw new Error("Disposable PostgreSQL journal parent may not be a symlink");
  if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile())) {
    throw new Error("Disposable PostgreSQL journal target is not a regular file");
  }
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(temporary, 0o600);
  try {
    if (initial) {
      // Hard-link publication is atomic and fails rather than following or replacing a raced target.
      linkSync(temporary, path);
      unlinkSync(temporary);
    } else {
      renameSync(temporary, path);
    }
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function readDisposablePostgresResourceJournal(path: string): DisposablePostgresResourceJournal {
  const details = lstatSync(path);
  if (!details.isFile() || details.isSymbolicLink() || (details.mode & 0o077) !== 0) throw new Error("Disposable PostgreSQL journal is not an owner-only regular file");
  const value = JSON.parse(readFileSync(path, "utf8")) as DisposablePostgresResourceJournal;
  if (value.version !== JOURNAL_VERSION || value.ownerPid < 1 || value.measurements.beforeOwnedDockerBytes !== 0 ||
      value.measurements.beforeOwnedFilesystemBytes !== 0) {
    throw new Error("Invalid Disposable PostgreSQL resource journal");
  }
  assertOwnedPaths(path, value);
  return value;
}

function objectExists(kind: "container" | "volume" | "network", name: string): boolean {
  return docker([kind, "inspect", name]).status === 0;
}

export function createDisposablePostgresResourceJournal(runId: string): DisposablePostgresResourceJournal {
  const expected = expectedDisposablePostgresResourcePaths(runId);
  if (existsSync(expected.journalPath)) throw new Error("Disposable PostgreSQL journal already exists");
  if (Object.entries(expected.resources).slice(0, 3).some(([kind, name]) => objectExists(kind as "container" | "volume" | "network", name))) {
    throw new Error("Disposable PostgreSQL exact-owned Docker target already exists");
  }
  const image = docker(["image", "inspect", "--format", "{{.Id}}", "postgres:16"]);
  if (image.status !== 0 || !/^sha256:[a-f0-9]{64}$/.test(image.stdout.trim())) {
    throw new Error("Disposable PostgreSQL requires pre-existing postgres:16; it never pulls or builds");
  }
  const journal: DisposablePostgresResourceJournal = {
    version: JOURNAL_VERSION, runId, ownerPid: process.pid, createdAt: new Date().toISOString(),
    image: { reference: "postgres:16", id: image.stdout.trim(), policy: "reuse-only-never-remove" },
    resources: expected.resources, processes: [],
    measurements: {
      beforeOwnedDockerBytes: 0, peakOwnedDockerBytes: null, afterOwnedDockerBytes: null,
      beforeOwnedFilesystemBytes: 0, peakOwnedFilesystemBytes: null, afterOwnedFilesystemBytes: null,
    },
  };
  writeOwnerOnly(expected.journalPath, journal, true);
  // The published journal owns this exact path before the path is created.
  mkdirSync(expected.resources.filesRoot, { recursive: true, mode: 0o700 });
  chmodSync(expected.resources.filesRoot, 0o700);
  return journal;
}

export function recordDisposablePostgresOwnedProcess(path: string, pid: number, token: string): void {
  const journal = readDisposablePostgresResourceJournal(path);
  if (!Number.isSafeInteger(pid) || pid < 1 || !token.startsWith(`${journal.runId}-`)) throw new Error("Invalid Disposable PostgreSQL owned process evidence");
  writeOwnerOnly(path, { ...journal, processes: [...journal.processes, { pid, token }] });
}

export function parseDisposablePostgresDockerBytes(value: string): number {
  const match = value.trim().match(/^([0-9]+(?:\.[0-9]+)?)(B|kB|MB|GB|TB|KiB|MiB|GiB|TiB)$/);
  if (!match) throw new Error(`Unrecognized Docker byte measurement: ${value}`);
  const scale: Record<string, number> = {
    B: 1, kB: 1_000, MB: 1_000_000, GB: 1_000_000_000, TB: 1_000_000_000_000,
    KiB: 1_024, MiB: 1_048_576, GiB: 1_073_741_824, TiB: 1_099_511_627_776,
  };
  const parsed = Math.round(Number(match[1]) * scale[match[2]!]!);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("Invalid Docker byte measurement");
  return parsed;
}

function measureDisposablePostgresOwnedDockerBytes(journal: DisposablePostgresResourceJournal): number {
  const result = docker(["system", "df", "-v", "--format", "json"]);
  if (result.status !== 0) throw new Error("Unable to measure Disposable PostgreSQL-owned Docker bytes");
  return parseDisposablePostgresOwnedDockerDiskReport(result.stdout, journal);
}

export function parseDisposablePostgresOwnedDockerDiskReport(stdout: string, journal: DisposablePostgresResourceJournal): number {
  const report = JSON.parse(stdout) as { Containers?: unknown; Volumes?: unknown };
  if (!Array.isArray(report.Containers) || !Array.isArray(report.Volumes) ||
      report.Containers.some((row: unknown) => typeof row !== "object" || row === null || Array.isArray(row)) ||
      report.Volumes.some((row: unknown) => typeof row !== "object" || row === null || Array.isArray(row))) {
    throw new Error("Unsupported Docker disk report shape");
  }
  const rows = (report.Containers as Record<string, unknown>[]).concat(report.Volumes as Record<string, unknown>[]);
  const owned = rows.filter((row) => row["Names"] === journal.resources.container || row["Name"] === journal.resources.volume);
  return owned.reduce((sum, row) => {
    const size = row["Size"];
    if (typeof size !== "string") throw new Error("Docker owned object has no byte measurement");
    return sum + parseDisposablePostgresDockerBytes(size);
  }, 0);
}

export function recordDisposablePostgresPeakMeasurement(path: string): number {
  const journal = readDisposablePostgresResourceJournal(path);
  const dockerBytes = measureDisposablePostgresOwnedDockerBytes(journal);
  const filesystemBytes = measureDisposablePostgresOwnedFilesystemBytes(journal);
  writeOwnerOnly(path, { ...journal, measurements: {
    ...journal.measurements,
    peakOwnedDockerBytes: Math.max(journal.measurements.peakOwnedDockerBytes ?? 0, dockerBytes),
    peakOwnedFilesystemBytes: Math.max(journal.measurements.peakOwnedFilesystemBytes ?? 0, filesystemBytes),
  } });
  return dockerBytes + filesystemBytes;
}

export function measureDisposablePostgresOwnedFilesystemBytes(journal: DisposablePostgresResourceJournal): number {
  const visit = (path: string): number => {
    const details = lstatSync(path);
    if (details.isSymbolicLink()) throw new Error("Disposable PostgreSQL owned filesystem contains a symlink");
    if (details.isFile()) return details.size;
    if (!details.isDirectory()) throw new Error("Disposable PostgreSQL owned filesystem contains an unsupported object");
    return readdirSync(path).reduce((sum, entry) => sum + visit(join(path, entry)), 0);
  };
  return existsSync(journal.resources.filesRoot) ? visit(journal.resources.filesRoot) : 0;
}

/** Synchronous so both worker signal handlers and the outer runner's finally can use it. */
export function cleanupDisposablePostgresOwnedResources(path: string): { peakOwnedDockerBytes: number; afterOwnedDockerBytes: 0 } {
  if (!existsSync(path)) return { peakOwnedDockerBytes: 0, afterOwnedDockerBytes: 0 };
  let journal = readDisposablePostgresResourceJournal(path);
  const failures: string[] = [];
  let measuredAtCleanup = 0;
  try { measuredAtCleanup = measureDisposablePostgresOwnedDockerBytes(journal); } catch { failures.push("before-byte-measurement"); }
  const peakOwnedDockerBytes = Math.max(journal.measurements.peakOwnedDockerBytes ?? 0, measuredAtCleanup);
  let filesystemAtCleanup = 0;
  try { filesystemAtCleanup = measureDisposablePostgresOwnedFilesystemBytes(journal); } catch { failures.push("before-filesystem-measurement"); }
  const peakOwnedFilesystemBytes = Math.max(journal.measurements.peakOwnedFilesystemBytes ?? 0, filesystemAtCleanup);
  for (const owned of journal.processes) {
    const command = spawnSync("ps", ["-p", String(owned.pid), "-o", "command="], { encoding: "utf8" });
    if (command.status === 0 && command.stdout.includes(owned.token)) {
      try { process.kill(owned.pid, "SIGTERM"); } catch { /* already exited */ }
    }
  }
  for (const [kind, args] of [
    ["container", ["container", "rm", "-f", journal.resources.container]],
    ["volume", ["volume", "rm", "-f", journal.resources.volume]],
    ["network", ["network", "rm", journal.resources.network]],
  ] as const) {
    const removed = docker(args);
    if (removed.error) failures.push(`${kind}-remove-exec`);
  }
  for (const [kind, name] of [
    ["container", journal.resources.container], ["volume", journal.resources.volume], ["network", journal.resources.network],
  ] as const) {
    try { if (objectExists(kind, name)) failures.push(`${kind}-residue`); } catch { failures.push(`${kind}-verify`); }
  }
  for (const owned of journal.processes) {
    let stillOwned = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const command = spawnSync("ps", ["-p", String(owned.pid), "-o", "command="], { encoding: "utf8" });
      stillOwned = command.status === 0 && command.stdout.includes(owned.token);
      if (!stillOwned) break;
      if (attempt === 5) try { process.kill(owned.pid, "SIGKILL"); } catch { /* already exited */ }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
    if (stillOwned) failures.push("process-residue");
  }
  let afterOwnedDockerBytes: number | null = null;
  try { afterOwnedDockerBytes = measureDisposablePostgresOwnedDockerBytes(journal); } catch { failures.push("after-byte-measurement"); }
  if (afterOwnedDockerBytes !== null && afterOwnedDockerBytes !== 0) failures.push("docker-byte-residue");
  try { rmSync(journal.resources.filesRoot, { recursive: true, force: true }); } catch { failures.push("files-remove"); }
  if (existsSync(journal.resources.filesRoot)) failures.push("files-residue");
  const afterOwnedFilesystemBytes = existsSync(journal.resources.filesRoot) ? null : 0;
  journal = { ...journal, measurements: {
    beforeOwnedDockerBytes: 0, peakOwnedDockerBytes, afterOwnedDockerBytes: failures.length === 0 ? 0 : null,
    beforeOwnedFilesystemBytes: 0, peakOwnedFilesystemBytes, afterOwnedFilesystemBytes,
  } };
  try { writeOwnerOnly(path, journal); } catch { failures.push("journal-evidence-write"); }
  if (failures.length > 0) throw new Error(`Disposable PostgreSQL exact cleanup incomplete: ${failures.join(",")}`);
  return { peakOwnedDockerBytes, afterOwnedDockerBytes: 0 };
}

export function removeDisposablePostgresJournalEvidence(path: string): void {
  const journal = readDisposablePostgresResourceJournal(path);
  if (journal.measurements.afterOwnedDockerBytes !== 0 || journal.measurements.afterOwnedFilesystemBytes !== 0) {
    throw new Error("Disposable PostgreSQL cleanup evidence is incomplete");
  }
  rmSync(path);
  for (const directory of [dirname(path), resolve(DISPOSABLE_POSTGRES_ACCEPTANCE_PARENT, "runs"), DISPOSABLE_POSTGRES_ACCEPTANCE_PARENT]) {
    try { rmSync(directory); } catch { /* retain non-empty parent owned by another run */ }
  }
}

export function installDisposablePostgresWorkerCleanup(path: string): () => void {
  if (process.env["NAUTILO_CHECKPOINT_PARENT_OWNS_CLEANUP"] === "1") return () => undefined;
  let cleaning = false;
  const cleanup = () => { if (cleaning) return; cleaning = true; try { cleanupDisposablePostgresOwnedResources(path); } catch { /* outer runner retries */ } };
  const onSignal = (signal: NodeJS.Signals) => { cleanup(); process.removeListener(signal, onSignal); process.kill(process.pid, signal); };
  process.once("exit", cleanup); process.once("SIGINT", onSignal); process.once("SIGTERM", onSignal);
  return () => { process.off("exit", cleanup); process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal); };
}
