import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createPendingConnectionStore,
  parsePendingConnection,
  projectPendingConnectionRecovery,
  type ActiveAuthority,
  type PendingConnection,
} from "../../electron/pending-connection";

let root = "";
let journalPath = "";
function marked(scope: string, revision: string, connectionAttemptId: string): ActiveAuthority {
  return { scope, revision, connectionAttemptId, serverFingerprint: `fingerprint-${connectionAttemptId}` };
}
let authority: ActiveAuthority = marked("https://previous.nautilo.dev", "revision-a", "active-attempt-a");

const tupleBinding = "instance-dev.profile-agent";

function record(overrides: Partial<PendingConnection> = {}): PendingConnection {
  return {
    version: 2,
    tupleBinding,
    attemptId: "attempt-1",
    context: "switch",
    generation: 1,
    enteredTarget: "alpha.example.test",
    candidateOrigin: "https://alpha.example.test",
    activeScopeGuard: "https://previous.nautilo.dev",
    activeRevisionGuard: "revision-a",
    identityTransition: { kind: "ordinary" },
    lastProgressPhase: "health",
    handoffCheckpoint: "candidate",
    postCommitCheckpoint: null,
    ...overrides,
  };
}

function store(binding = tupleBinding) {
  return createPendingConnectionStore({
    filePath: journalPath,
    tupleBinding: binding,
    currentActiveAuthority: () => authority,
    temporaryId: () => "test-temp-id",
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "nautilo-d514-pending-"));
  journalPath = path.join(root, "tuple", "pending-connection.json");
  authority = marked("https://previous.nautilo.dev", "revision-a", "active-attempt-a");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("D514 pending connection journal", () => {
  test("atomically retains only resume-safe candidate intent with 0600 permissions", () => {
    store().save(record());

    expect(store().load()).toEqual({ disposition: "precommit", pending: record() });
    expect(fs.statSync(journalPath).mode & 0o777).toBe(0o600);
    const bytes = fs.readFileSync(journalPath, "utf-8");
    expect(bytes).not.toContain("token");
    expect(fs.readdirSync(path.dirname(journalPath)).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  test("fails closed for corrupt, truncated, wrong-version, and wrong-tuple records", () => {
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    for (const [bytes, expected] of [
      "{",
      JSON.stringify({ ...record(), version: 3 }),
      JSON.stringify({ ...record(), tupleBinding: "other.profile" }),
    ].map((bytes, index) => [bytes, index === 0 ? "blocked-legacy-handoff" : "none"] as const)) {
      fs.writeFileSync(journalPath, bytes, { mode: 0o600 });
      expect(store().load()).toEqual({ disposition: expected });
    }
  });

  test("superseding save replaces only the candidate journal and leaves no temporary sibling", () => {
    store().save(record({ attemptId: "attempt-1", generation: 1, lastProgressPhase: "transport" }));
    store().save(record({ attemptId: "attempt-2", generation: 2, lastProgressPhase: "promotion" }));

    expect(store().load()).toEqual({
      disposition: "precommit",
      pending: record({ attemptId: "attempt-2", generation: 2, lastProgressPhase: "promotion" }),
    });
    expect(fs.readdirSync(path.dirname(journalPath)).sort()).toEqual(["pending-connection.json"]);
  });

  test("clear is deterministic, idempotent, and never touches a sibling active config", () => {
    const configPath = path.join(path.dirname(journalPath), "config.json");
    store().save(record());
    fs.writeFileSync(configPath, '{"active":"unchanged"}', { mode: 0o600 });

    store().clear();
    store().clear();

    expect(fs.existsSync(journalPath)).toBe(false);
    expect(fs.readFileSync(configPath, "utf-8")).toBe('{"active":"unchanged"}');
  });

  test("strict schema rejects secret-bearing or ambiguous fields before disk write", () => {
    const withSecret = { ...record(), token: "must-never-persist" };
    expect(parsePendingConnection(withSecret)).toBeNull();
    expect(() => store().save(withSecret as PendingConnection)).toThrow("invalid");
    expect(fs.existsSync(journalPath)).toBe(false);

    expect(parsePendingConnection({ ...record(), enteredTarget: "https://user:password@alpha.example.test" })).toBeNull();
    expect(parsePendingConnection({ ...record(), candidateOrigin: "https://alpha.example.test/path" })).toBeNull();
    expect(parsePendingConnection({ ...record(), context: "pair-to-another-server" })).toBeNull();
  });

  test("normalizing may have no candidate, while all other phases require a planned candidate", () => {
    expect(parsePendingConnection(record({ candidateOrigin: null, lastProgressPhase: "normalizing" }))).toEqual(
      record({ candidateOrigin: null, lastProgressPhase: "normalizing" }),
    );
    expect(parsePendingConnection(record({ candidateOrigin: null, lastProgressPhase: "transport" }))).toBeNull();
    expect(parsePendingConnection(record({ candidateOrigin: "https://unrelated.example.test" }))).toBeNull();
  });

  test("mismatch and downgrade hints round-trip but project only a fresh normalization restart", () => {
    const mismatch = record({ lastProgressPhase: "mismatch" });
    const downgrade = record({
      enteredTarget: "http://localhost:3001",
      candidateOrigin: "http://localhost:3001",
      activeScopeGuard: "https://localhost:3001",
      activeRevisionGuard: "revision-local",
      lastProgressPhase: "downgrade-confirmation",
    });
    authority = marked("https://localhost:3001", "revision-local", "active-local");
    store().save(downgrade);
    expect(store().load()).toEqual({ disposition: "precommit", pending: downgrade });
    expect(projectPendingConnectionRecovery({ disposition: "precommit", pending: mismatch })).toEqual({
      disposition: "precommit",
      action: "fresh-attempt",
      context: "switch",
      enteredTarget: "alpha.example.test",
      priorActiveScope: "https://previous.nautilo.dev",
      priorRecoveryGuard: {
        scope: "https://previous.nautilo.dev",
        revision: "revision-a",
      },
      restartPhase: "normalizing",
      requiresFreshAttemptAndGeneration: true,
    });
    expect(projectPendingConnectionRecovery({ disposition: "precommit", pending: downgrade })).toMatchObject({
      restartPhase: "normalizing",
      requiresFreshAttemptAndGeneration: true,
    });
  });

  test("active scope changes reject the journal rather than creating a second active authority", () => {
    store().save(record());
    authority = marked("https://new-active.nautilo.dev", "revision-b", "active-attempt-b");
    expect(store().load()).toEqual({ disposition: "none" });
    expect(() => store().save(record())).toThrow("invalid");
  });

  test("handoff checkpoint distinguishes the two crash sides of durable promotion", () => {
    const beforeCommit = record({ lastProgressPhase: "promotion", handoffCheckpoint: "candidate" });
    store().save(beforeCommit);
    expect(store().load()).toEqual({ disposition: "precommit", pending: beforeCommit });
    authority = marked("https://alpha.example.test", "revision-b", "attempt-1");
    // Crash after config linearization but before journal checkpoint update:
    // marker wins over the stale candidate checkpoint.
    expect(store().load()).toEqual({ disposition: "committed-handoff", pending: beforeCommit });

    const afterCommit = record({
      lastProgressPhase: "promotion",
      handoffCheckpoint: "active-committed",
      postCommitCheckpoint: "metadata",
    });
    store().save(afterCommit);
    expect(store().load()).toEqual({ disposition: "committed-handoff", pending: afterCommit });
    expect(projectPendingConnectionRecovery({ disposition: "committed-handoff", pending: afterCommit })).toMatchObject({
      action: "resume-handoff",
      attemptId: "attempt-1",
      validActions: ["resume-handoff"],
      requiresEphemeralFactReconstructionAndRevalidation: true,
    });
  });

  test("active-committed is valid only at promotion with a planned candidate", () => {
    expect(parsePendingConnection(record({ handoffCheckpoint: "active-committed" }))).toBeNull();
    expect(parsePendingConnection(record({
      lastProgressPhase: "promotion",
      candidateOrigin: null,
      handoffCheckpoint: "active-committed",
      postCommitCheckpoint: "old-codex",
    }))).toBeNull();
  });

  test("revision and attempt marker fence A→B→A and same-origin unrelated authority", () => {
    store().save(record());
    authority = marked("https://other.nautilo.dev", "revision-b", "active-attempt-b");
    expect(store().load()).toEqual({ disposition: "none" });
    authority = marked("https://previous.nautilo.dev", "revision-c", "active-attempt-c");
    expect(store().load()).toEqual({ disposition: "none" });
    authority = marked("https://previous.nautilo.dev", "revision-d", "other-attempt");
    expect(store().load()).toEqual({ disposition: "none" });
  });

  test("committed checkpoint rejects a same-origin authority without its exact attempt marker", () => {
    authority = marked("https://alpha.example.test", "revision-b", "attempt-1");
    const committed = record({
      lastProgressPhase: "promotion",
      handoffCheckpoint: "active-committed",
      postCommitCheckpoint: "renderer-authority",
    });
    store().save(committed);
    authority = marked("https://alpha.example.test", "revision-c", "other-attempt");
    expect(store().load()).toEqual({ disposition: "none" });
  });

  test("an initial attempt can guard the authoritative no-pairing state without inventing a revision", () => {
    authority = { scope: null, revision: null, connectionAttemptId: null, serverFingerprint: null };
    const initial = record({
      context: "initial",
      activeScopeGuard: null,
      activeRevisionGuard: null,
    });
    store().save(initial);
    expect(store().load()).toEqual({ disposition: "precommit", pending: initial });

    expect(parsePendingConnection({ ...initial, context: "switch" })).toBeNull();
    expect(parsePendingConnection({ ...initial, activeScopeGuard: "https://previous.nautilo.dev" })).toBeNull();
    authority = { scope: null, revision: "revision-created", connectionAttemptId: null } as unknown as ActiveAuthority;
    expect(store().load()).toEqual({ disposition: "none" });
    authority = { scope: null, revision: null, connectionAttemptId: "other-attempt" } as unknown as ActiveAuthority;
    expect(store().load()).toEqual({ disposition: "none" });
  });

  test("injected active authority is empty, a complete receipt, or an explicit legacy-unknown receipt", () => {
    store().save(record());
    for (const inconsistent of [
      { scope: "https://previous.nautilo.dev", revision: "revision-a", connectionAttemptId: null },
      { scope: "https://previous.nautilo.dev", revision: null, connectionAttemptId: "active-attempt-a" },
      { scope: null, revision: "revision-a", connectionAttemptId: "active-attempt-a" },
      { scope: "https://previous.nautilo.dev/path", revision: "revision-a", connectionAttemptId: "active-attempt-a" },
    ]) {
      authority = inconsistent as unknown as ActiveAuthority;
      expect(store().load()).toEqual({ disposition: "none" });
      expect(() => store().save(record())).toThrow("invalid");
    }
    authority = {
      scope: "https://previous.nautilo.dev",
      revision: "legacy-revision-a",
      connectionAttemptId: "legacy-offline-a",
      serverFingerprint: null,
    };
    const legacyRecord = record({ activeRevisionGuard: "legacy-revision-a" });
    store().save(legacyRecord);
    expect(store().load()).toEqual({ disposition: "precommit", pending: legacyRecord });
  });

  test("committed recovery persists and projects the exact next postcommit checkpoint", () => {
    authority = {
      scope: "https://alpha.example.test",
      revision: "revision-b",
      connectionAttemptId: "attempt-1",
      serverFingerprint: "fingerprint-attempt-1",
    };
    for (const checkpoint of [
      "metadata",
      "old-codex",
      "old-relay",
      "old-profile",
      "renderer-authority",
      "visibility",
      "target-relay",
      "pending-clear",
    ] as const) {
      const committed = record({
        lastProgressPhase: "promotion",
        handoffCheckpoint: "active-committed",
        postCommitCheckpoint: checkpoint,
      });
      store().save(committed);
      const loaded = store().load();
      expect(loaded).toEqual({ disposition: "committed-handoff", pending: committed });
      if (loaded.disposition !== "committed-handoff") throw new Error("fixture must be committed");
      expect(projectPendingConnectionRecovery(loaded).nextPostCommitCheckpoint).toBe(checkpoint);
    }

    expect(parsePendingConnection(record({ postCommitCheckpoint: "metadata" }))).toBeNull();
    expect(parsePendingConnection({
      ...record({ lastProgressPhase: "promotion", handoffCheckpoint: "active-committed" }),
      postCommitCheckpoint: "secrets-and-cookies",
    })).toBeNull();
    expect(parsePendingConnection({
      ...record({ lastProgressPhase: "promotion", handoffCheckpoint: "active-committed" }),
      postCommitCheckpoint: "complete",
    })).toBeNull();
  });

  test("committed recovery projects one prior guard and keeps scoped cold routing separate from identity", () => {
    const scoped = record({
      context: "cold-boot",
      enteredTarget: "https://alpha.example.test/legacy/base",
      candidateOrigin: "https://alpha.example.test",
      lastProgressPhase: "promotion",
      handoffCheckpoint: "active-committed",
      postCommitCheckpoint: "metadata",
    });
    expect(parsePendingConnection(scoped)).toEqual(scoped);
    authority = marked("https://alpha.example.test", "revision-b", "attempt-1");
    store().save(scoped);
    const loaded = store().load();
    if (loaded.disposition !== "committed-handoff") throw new Error("fixture must be committed");
    expect(projectPendingConnectionRecovery(loaded)).toMatchObject({
      candidateOrigin: "https://alpha.example.test",
      routingServerUrl: "https://alpha.example.test/legacy/base",
      priorRecoveryGuard: {
        scope: "https://previous.nautilo.dev",
        revision: "revision-a",
      },
      priorRegistryScope: null,
    });
    expect(parsePendingConnection({ ...scoped, context: "switch" })).toBeNull();
    expect(parsePendingConnection({
      ...scoped,
      enteredTarget: "https://user:secret@alpha.example.test/legacy/base",
    })).toBeNull();
  });

  test("a stale precommit checkpoint discovered after linearization resumes from metadata", () => {
    const beforeCommit = record({ lastProgressPhase: "promotion" });
    store().save(beforeCommit);
    authority = {
      scope: "https://alpha.example.test",
      revision: "revision-b",
      connectionAttemptId: "attempt-1",
      serverFingerprint: "fingerprint-attempt-1",
    };
    const loaded = store().load();
    if (loaded.disposition !== "committed-handoff") throw new Error("fixture must be committed");
    expect(projectPendingConnectionRecovery(loaded).nextPostCommitCheckpoint).toBe("metadata");
  });

  test("v2 accepted marker is exact, binds live A on candidate save, and survives committed checkpoints", () => {
    const accepted = record({ context: "cold-boot", enteredTarget: "https://alpha.example.test/base",
      candidateOrigin: "https://alpha.example.test", activeScopeGuard: "https://previous.nautilo.dev",
      identityTransition: { kind: "accepted-identity-replacement", priorConnectionAttemptId: "active-attempt-a",
        priorServerFingerprint: "fingerprint-active-attempt-a", priorRoutingServerUrl: "https://previous.nautilo.dev/base" } });
    expect(parsePendingConnection(accepted)).toBeNull();
    const sameOrigin = { ...accepted, activeScopeGuard: "https://alpha.example.test", activeRevisionGuard: "revision-a",
      identityTransition: { kind: "accepted-identity-replacement" as const, priorConnectionAttemptId: "active-attempt-a",
        priorServerFingerprint: "fingerprint-active-attempt-a", priorRoutingServerUrl: "https://alpha.example.test/old" } };
    authority = marked("https://alpha.example.test", "revision-a", "active-attempt-a");
    store().save(sameOrigin);
    authority = marked("https://alpha.example.test", "revision-b", "attempt-1");
    const committed = { ...sameOrigin, handoffCheckpoint: "active-committed" as const,
      lastProgressPhase: "promotion" as const, postCommitCheckpoint: "metadata" as const };
    store().save(committed);
    expect(() => store().save({ ...committed, postCommitCheckpoint: "renderer-authority" })).toThrow();
    for (const postCommitCheckpoint of ["old-codex", "old-relay", "old-profile", "old-identity"] as const) {
      store().save({ ...committed, postCommitCheckpoint });
    }
    expect(store().load()).toEqual({ disposition: "committed-handoff", pending: { ...committed, postCommitCheckpoint: "old-identity" } });
  });

  test("v1 migrates only safe cross-origin/precommit records and blocks same-origin committed truth", () => {
    const v1 = (next: PendingConnection) => {
      const { identityTransition: _discarded, ...recordV1 } = next;
      return JSON.stringify({ ...recordV1, version: 1 });
    };
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    fs.writeFileSync(journalPath, v1(record()), { mode: 0o600 });
    expect(store().load().disposition).toBe("precommit");
    authority = marked("https://alpha.example.test", "revision-b", "attempt-1");
    fs.writeFileSync(journalPath, v1(record({ handoffCheckpoint: "active-committed", lastProgressPhase: "promotion",
      postCommitCheckpoint: "metadata" })), { mode: 0o600 });
    const crossOrigin = store().load();
    expect(crossOrigin.disposition).toBe("committed-handoff");
    if (crossOrigin.disposition === "committed-handoff") expect(crossOrigin.pending.identityTransition).toEqual({ kind: "ordinary" });
    const same = record({ candidateOrigin: "https://previous.nautilo.dev", enteredTarget: "https://previous.nautilo.dev",
      lastProgressPhase: "promotion", handoffCheckpoint: "active-committed", postCommitCheckpoint: "metadata" });
    authority = marked("https://previous.nautilo.dev", "revision-a", "attempt-1");
    fs.writeFileSync(journalPath, v1(same), { mode: 0o600 });
    expect(store().load()).toEqual({ disposition: "blocked-legacy-handoff" });
  });
});
