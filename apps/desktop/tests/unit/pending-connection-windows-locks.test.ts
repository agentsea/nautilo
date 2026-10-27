import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPendingConnectionStore, type ActiveAuthority, type PendingConnection } from "../../electron/pending-connection";

// A scanner can hold a freshly written journal open for a while. The store
// replaces the journal by rename, which Windows refuses during that hold; the
// production filesystem port retries instead of losing the save.

let root = "";
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

const authority: ActiveAuthority = { scope: "https://previous.nautilo.dev", revision: "revision-a", connectionAttemptId: "active-attempt-a", serverFingerprint: "fingerprint-active-attempt-a" };

function record(enteredTarget: string): PendingConnection {
  return {
    version: 2, tupleBinding: "instance-dev.profile-agent", attemptId: "attempt-1", context: "switch", generation: 1,
    enteredTarget, candidateOrigin: `https://${enteredTarget}`, activeScopeGuard: authority.scope, activeRevisionGuard: authority.revision,
    identityTransition: { kind: "ordinary" }, lastProgressPhase: "health", handoffCheckpoint: "candidate", postCommitCheckpoint: null,
  };
}

// Holds `path` open without sharing for two seconds. The release promise sits
// in an object: an async function returning a bare promise would only settle
// once the holder has exited.
async function holdWithoutSharing(path: string): Promise<{ released: Promise<unknown> }> {
  const holder = spawn("C:\\Program Files\\PowerShell\\7\\pwsh.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    "$held = [IO.File]::Open($env:NAUTILO_HELD_FILE, 'Open', 'Read', 'None'); [Console]::Out.WriteLine('held'); Start-Sleep -Milliseconds 2000; $held.Close()",
  ], { env: { ...process.env, NAUTILO_HELD_FILE: path } });
  const released = new Promise((resolveExit) => holder.once("exit", resolveExit));
  await new Promise<void>((resolveHeld) => holder.stdout.once("data", () => resolveHeld()));
  // A save that meets no lock would pass without exercising the retry.
  expect(() => readFileSync(path)).toThrow();
  return { released };
}

test.skipIf(process.platform !== "win32")("a journal save waits while another process holds the journal open", async () => {
  root = mkdtempSync(join(tmpdir(), "nautilo-pending-lock-"));
  const filePath = join(root, "tuple", "pending-connection.json");
  const store = createPendingConnectionStore({ filePath, tupleBinding: "instance-dev.profile-agent", currentActiveAuthority: () => authority });
  store.save(record("alpha.example.test"));
  const hold = await holdWithoutSharing(filePath);
  const startedAt = Date.now();
  store.save(record("beta.example.test"));
  expect(Date.now() - startedAt).toBeGreaterThan(500);
  await hold.released;
  expect(store.load()).toEqual({ disposition: "precommit", pending: record("beta.example.test") });
}, 30_000);
