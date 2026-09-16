import { spawnSync } from "node:child_process";
import type { ResolvedInstance } from "@nautilo/config";
import { findListenerPid, looksLikeNautiloServer } from "./listener-pid";
import { queryPostgresContainer } from "./postgres-archive";

export interface BackupCaptureState {
  nautiloWriterStopped: boolean;
  logtoWriterStopped: boolean;
}

export interface BackupQuiescenceDeps {
  findServerPid: () => number | null;
  isNautiloServer: (pid: number) => boolean;
  isServerPaused: (pid: number) => boolean;
  isLogtoRunning: () => boolean;
  pauseServer: (pid: number) => void;
  resumeServer: (pid: number) => void;
  pauseLogto: () => void;
  resumeLogto: () => void;
  activeWriterCount: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
}

/** Restoration failure always takes precedence because a writer may remain paused. */
export interface BackupWriterStateEvidence {
  readonly paused: BackupCaptureState;
  readonly quiesced: boolean;
  readonly restoration: "restored" | "failed";
}

export class BackupWriterRestorationError extends Error {
  readonly writerState: BackupWriterStateEvidence;
  constructor(readonly primaryError: unknown, paused: BackupCaptureState, quiesced = false) {
    super("Failed to restore source writer state");
    this.name = "BackupWriterRestorationError";
    this.cause = primaryError;
    this.writerState = { paused, quiesced, restoration: "failed" };
  }
}

/** Primary quiescence/capture failure after any pauses were exactly restored. */
export class BackupQuiescenceOperationError extends Error {
  readonly writerState: BackupWriterStateEvidence;
  constructor(readonly primaryError: unknown, paused: BackupCaptureState, quiesced = false) {
    super(primaryError instanceof Error ? primaryError.message : "Backup capture failed");
    this.name = "BackupQuiescenceOperationError";
    this.cause = primaryError;
    this.writerState = { paused, quiesced, restoration: "restored" };
  }
}

async function waitForNoActiveWriters(
  deps: Pick<BackupQuiescenceDeps, "activeWriterCount" | "sleep">,
  attempts = 50,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (deps.activeWriterCount() === 0) return;
    await deps.sleep(100);
  }
  throw new Error(
    "Source database still has active or idle-in-transaction clients after writers were paused",
  );
}

export async function withQuiescedBackupSource<T>(
  deps: BackupQuiescenceDeps,
  capture: (state: BackupCaptureState) => Promise<T>,
): Promise<T> {
  const serverPid = deps.findServerPid();
  if (serverPid !== null && !deps.isNautiloServer(serverPid)) {
    throw new Error(
      `Source server port is owned by an unrecognized process (pid ${serverPid})`,
    );
  }
  if (!deps.isLogtoRunning()) {
    throw new Error("Logto must be running for a complete development backup");
  }

  let serverPaused = false;
  let logtoPaused = false;
  let primaryError: unknown;
  let result: T | undefined;
  let writersQuiesced = false;
  const resumeErrors: string[] = [];
  try {
    if (serverPid !== null) {
      if (deps.isServerPaused(serverPid)) {
        deps.log(`  Nautilo writer process (pid ${serverPid}) is already paused; preserving prior state.`);
      } else {
        deps.log(`  Pausing Nautilo writer process (pid ${serverPid})...`);
        deps.pauseServer(serverPid);
        serverPaused = true;
      }
    }
    deps.log("  Pausing Logto writer container...");
    deps.pauseLogto();
    logtoPaused = true;
    await waitForNoActiveWriters(deps);
    writersQuiesced = true;
    result = await capture({
      nautiloWriterStopped: serverPid !== null,
      logtoWriterStopped: logtoPaused,
    });
  } catch (error) {
    primaryError = error;
  } finally {
    if (logtoPaused) {
      try {
        deps.resumeLogto();
      } catch (error) {
        resumeErrors.push(`Logto: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (serverPaused && serverPid !== null) {
      try {
        deps.resumeServer(serverPid);
      } catch (error) {
        resumeErrors.push(
          `Nautilo pid ${serverPid}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  const paused = { nautiloWriterStopped: serverPaused, logtoWriterStopped: logtoPaused };
  if (resumeErrors.length > 0) throw new BackupWriterRestorationError(primaryError, paused, writersQuiesced);
  if (primaryError !== undefined) {
    throw new BackupQuiescenceOperationError(primaryError, paused, writersQuiesced);
  }
  return result as T;
}

function dockerContainerRunning(container: string): boolean {
  const result = spawnSync(
    "docker",
    ["inspect", "-f", "{{.State.Running}}|{{.State.Paused}}", container],
    { encoding: "utf8" },
  );
  return result.status === 0 && result.stdout.trim() === "true|false";
}

function processPaused(pid: number): boolean {
  const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0 || result.stdout.trim() === "") {
    throw new Error(`Cannot inspect prior writer state for pid ${pid}`);
  }
  return result.stdout.trim().includes("T");
}

function dockerPause(container: string): void {
  const result = spawnSync("docker", ["pause", container], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "docker pause failed").trim());
  }
}

export function dockerUnpauseReachedRestoredState(
  commandStatus: number | null,
  runningAndUnpaused: boolean,
): boolean {
  return commandStatus === 0 || runningAndUnpaused;
}

function dockerUnpause(container: string): void {
  const result = spawnSync("docker", ["unpause", container], { encoding: "utf8" });
  if (result.error) throw result.error;
  // Another serialized clone-seed capture can finish its own restoration
  // between our pause and unpause. Docker reports "not paused" in that race,
  // but the source writer has already reached the exact desired state.
  if (!dockerUnpauseReachedRestoredState(result.status, dockerContainerRunning(container))) {
    throw new Error((result.stderr || result.stdout || "docker unpause failed").trim());
  }
}

function activeClientCount(
  container: string,
  database: string,
): number {
  const raw = queryPostgresContainer({
    container,
    database,
    sql: `
      SELECT count(*)
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND backend_type = 'client backend'
        AND state IS DISTINCT FROM 'idle';
    `,
  });
  const count = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`Cannot inspect active writers in ${container}/${database}`);
  }
  return count;
}

export function defaultBackupQuiescenceDeps(
  inst: ResolvedInstance,
  log: (message: string) => void = console.log,
): BackupQuiescenceDeps {
  const c = inst.compose.containers;
  return {
    findServerPid: () => findListenerPid(inst.server.port),
    isNautiloServer: looksLikeNautiloServer,
    isServerPaused: processPaused,
    isLogtoRunning: () => dockerContainerRunning(c.logtoCore),
    pauseServer: (pid) => process.kill(pid, "SIGSTOP"),
    resumeServer: (pid) => process.kill(pid, "SIGCONT"),
    pauseLogto: () => dockerPause(c.logtoCore),
    resumeLogto: () => dockerUnpause(c.logtoCore),
    activeWriterCount: () =>
      activeClientCount(c.legacyPostgres, "nautilo") +
      activeClientCount(c.logtoPostgres, "logto_nautilo"),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log,
  };
}
