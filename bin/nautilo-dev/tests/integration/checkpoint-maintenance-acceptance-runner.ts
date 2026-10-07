/** Outer parent for the expensive checkpoint maintenance acceptance. Its finally owns cleanup after worker timeout/interruption. */
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  cleanupDisposablePostgresOwnedResources,
  expectedDisposablePostgresResourcePaths,
  readDisposablePostgresResourceJournal,
  removeDisposablePostgresJournalEvidence,
} from "./helpers/disposable-postgres-resource-journal";

if (process.env["NAUTILO_CHECKPOINT_DISPOSABLE_PG"] !== "1") {
  throw new Error("Set NAUTILO_CHECKPOINT_DISPOSABLE_PG=1 to authorize randomized disposable PostgreSQL acceptance");
}

const runId = `disposable-accept-${randomBytes(6).toString("hex")}`;
const { journalPath } = expectedDisposablePostgresResourcePaths(runId);
let worker: ReturnType<typeof Bun.spawn> | undefined;
let terminating = false;
let receivedSignal: NodeJS.Signals | undefined;
const PARENT_TIMEOUT_MS = 360_000;

function parentFinally(): void {
  if (!existsSync(journalPath)) return;
  const cleanup = cleanupDisposablePostgresOwnedResources(journalPath);
  const journal = readDisposablePostgresResourceJournal(journalPath);
  process.stdout.write(`${JSON.stringify({ runId, cleanup, measurements: journal.measurements })}\n`);
  removeDisposablePostgresJournalEvidence(journalPath);
}

function onSignal(signal: NodeJS.Signals): void {
  if (terminating) return;
  terminating = true;
  receivedSignal = signal;
  worker?.kill("SIGTERM");
  setTimeout(() => worker?.kill("SIGKILL"), 5_000).unref();
}

process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);

let exitCode = 1;
let timedOut = false;
try {
  if (receivedSignal !== undefined) throw new Error("Checkpoint maintenance acceptance interrupted before worker creation");
  worker = Bun.spawn([
    "bun", "test", "--timeout", "300000",
    "tests/integration/checkpoint-maintenance-acceptance.test.ts",
  ], {
    cwd: import.meta.dir.replace(/\/tests\/integration$/, ""),
    env: { ...process.env, NAUTILO_CHECKPOINT_RUN_ID: runId, NAUTILO_CHECKPOINT_PARENT_OWNS_CLEANUP: "1" },
    stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  const hardTimeout = setTimeout(() => {
    timedOut = true;
    terminating = true;
    worker?.kill("SIGTERM");
    setTimeout(() => worker?.kill("SIGKILL"), 5_000).unref();
  }, PARENT_TIMEOUT_MS);
  try { exitCode = await worker.exited; } finally { clearTimeout(hardTimeout); }
} finally {
  parentFinally();
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
}
if (timedOut) {
  process.stderr.write(`Checkpoint maintenance acceptance exceeded parent timeout ${PARENT_TIMEOUT_MS}ms\n`);
  exitCode = 124;
}
if (receivedSignal !== undefined) {
  const signal = receivedSignal;
  process.removeListener(signal, onSignal);
  process.kill(process.pid, signal);
}
process.exit(exitCode);
