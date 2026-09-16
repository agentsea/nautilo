import { describe, expect, test } from "bun:test";
import type { ResolvedInstance } from "@nautilo/config";
import {
  buildCompactCheckpointsSnapshotScript,
  assertCheckpointMaintenanceSourceIdentityUnchanged,
  checkpointFailureEvidence,
  checkpointFailureOperationState,
  checkpointSemanticFailureOperationState,
  isCheckpointPhysicalOutcomeAmbiguous,
  COMPACT_CHECKPOINTS_SPAWN_TIMEOUT_MS,
  compactCheckpointsCmd,
  formatCompactCheckpointsResult,
  formatCheckpointApplyOutcome,
  parseCompactCheckpointsArgs,
} from "../../src/commands/compact-checkpoints";
import { CheckpointMaintenanceGateError } from "../../src/lib/checkpoint-maintenance-gate";
import { BackupQuiescenceOperationError } from "../../src/lib/backup-quiescence";
import { CheckpointSemanticCompactionError } from "../../src/lib/checkpoint-semantic-compaction";
import { CheckpointPhysicalReclamationError } from "../../src/lib/checkpoint-physical-reclamation";
import type { CheckpointPhysicalReclamationResult } from "../../src/lib/checkpoint-physical-reclamation";
import type { CompactCheckpointsFailure } from "../../src/commands/compact-checkpoints";
import type { CanonicalDefaultSourceIsolationEvidence } from "../../src/commands/clone";

const aggregateRow = {
  current_checkpoint_rows: "6",
  current_checkpoint_logical_bytes: "600",
  current_write_rows: "8",
  current_write_logical_bytes: "800",
  current_blob_rows: "7",
  current_blob_logical_bytes: "700",
  current_blob_payload_bytes: "420",
  retained_checkpoint_rows: "3",
  retained_checkpoint_logical_bytes: "300",
  retained_write_rows: "3",
  retained_write_logical_bytes: "300",
  retained_blob_rows: "4",
  retained_blob_logical_bytes: "400",
  retained_blob_payload_bytes: "240",
  invalid_retained_checkpoint_formats: "0",
  unsupported_retained_legacy_parent_formats: "0",
};

function snapshot(lines: unknown[] = [
  { kind: "schema", row: { missing_required_checkpoint_tables: "0", invalid_required_schema_items: "0" } },
  { kind: "plan", row: aggregateRow },
  {
    kind: "physical",
    relations: [
      { relation: "checkpoint_blobs", table_bytes: "100", index_bytes: "20", toast_bytes: "75", total_bytes: "120" },
      { relation: "checkpoint_writes", table_bytes: "200", index_bytes: "40", toast_bytes: "150", total_bytes: "240" },
      { relation: "checkpoints", table_bytes: "50", index_bytes: "10", toast_bytes: "0", total_bytes: "60" },
    ],
  },
]): string {
  return lines.map((line) => JSON.stringify(line)).join("\n");
}

const instance = {
  instanceId: "",
  compose: { containers: { legacyPostgres: "nautilo-postgres" } },
} as ResolvedInstance;

function commandDeps(output: string[], stdout = snapshot()) {
  return {
    env: { NAUTILO_INSTANCE_ID: "wrong-worktree" },
    instanceRootExists: () => true,
    resolveInstance: (env: NodeJS.ProcessEnv) => ({ ...instance, instanceId: env["NAUTILO_INSTANCE_ID"] ?? "" }),
    executor: { execute: () => ({ ok: true as const, stdout }) },
    write: (line: string) => output.push(line),
  };
}

describe("compact-checkpoints parsing", () => {
  test("reports measured physical bytes only on verified physical completion", () => {
    const physical = {
      beforeRelationBytes: 100, afterRelationBytes: 40, reclaimedBytes: 60,
      statisticsRefreshed: true as const, rewritten: ["checkpoint_writes", "checkpoints", "checkpoint_blobs"] as const,
      before: {}, after: {},
    } as unknown as CheckpointPhysicalReclamationResult;
    expect(JSON.parse(formatCheckpointApplyOutcome("canonical-default", "physical-complete", true, "done", physical))).toMatchObject({
      outcome: "physical-complete",
      physical: { beforeRelationBytes: 100, afterRelationBytes: 40, reclaimedBytes: 60, statisticsRefreshed: true },
    });
    expect(formatCheckpointApplyOutcome("canonical-default", "semantic-complete", true, "done")).not.toContain("reclaimedBytes");
    expect(formatCheckpointApplyOutcome("canonical-default", "physical-complete", false, "done", physical)).toContain("Physically reclaimed: 60 B");
  });

  test("re-proves stable source identity while allowing checkpoint aggregates to change", () => {
    const before = {
      instanceJsonHash: "a", instanceEnvHash: "b", volumeState: "c", projectObjects: { containers: [], networks: [] },
      writersRunning: true, databaseLedger: [{ changed: "before" }], databaseIdentity: "default",
      serverListenerState: "recognized:7", logtoCoreState: "true|false",
    } as unknown as CanonicalDefaultSourceIsolationEvidence;
    const after = { ...before } as unknown as CanonicalDefaultSourceIsolationEvidence;
    expect(() => assertCheckpointMaintenanceSourceIdentityUnchanged(before, after)).not.toThrow();
    expect(() => assertCheckpointMaintenanceSourceIdentityUnchanged(before, { ...after, databaseIdentity: "other" })).toThrow("source identity changed");
  });

  test("maps apply gate boundaries to typed redacted maintenance evidence", () => {
    expect(checkpointFailureEvidence(new CheckpointMaintenanceGateError("backup"))).toMatchObject({
      failure: { code: "backup-verification-failed" }, retryState: "safe-to-retry",
    });
    expect(checkpointFailureEvidence(new CheckpointMaintenanceGateError("source-evidence"))).toMatchObject({
      failure: { code: "lineage-verification-failed" },
    });
    expect(checkpointFailureEvidence(new CheckpointMaintenanceGateError("writer-quiescence"))).toMatchObject({
      failure: { code: "writer-quiescence-failed" },
    });
    expect(checkpointFailureEvidence(new CheckpointMaintenanceGateError("resume"))).toMatchObject({
      failure: { code: "service-restoration-failed" }, restorationFailed: true,
    });
    const restoredFailure = new CheckpointMaintenanceGateError(
      "writer-quiescence",
      new BackupQuiescenceOperationError(new Error("callback"), {
        nautiloWriterStopped: true,
        logtoWriterStopped: true,
      }, true),
      "mutation",
    );
    expect(checkpointFailureEvidence(restoredFailure)).toMatchObject({
      failure: { code: "writer-quiescence-failed", guidance: "retry-after-writer-quiescence" },
      retryState: "safe-to-retry",
      writersRestored: true,
      writersQuiesced: true,
    });
    expect(checkpointFailureOperationState(restoredFailure, { backupVerified: true, gateCompleted: false })).toEqual({
      completedStages: ["inventory-read", "consent-verified", "backup-verified", "writers-quiesced", "services-restored"],
      serviceRestoration: { intent: "restore-paused-services", result: "restored" },
    });
    const semanticFailure = new CheckpointMaintenanceGateError(
      "writer-quiescence",
      new BackupQuiescenceOperationError(new CheckpointSemanticCompactionError("execution-failed"), {
        nautiloWriterStopped: true,
        logtoWriterStopped: true,
      }, true),
      "mutation",
    );
    expect(checkpointFailureEvidence(semanticFailure)).toMatchObject({
      failure: { code: "operation-interrupted", guidance: "inspect-postgres-recovery-and-rerun-explicitly" },
      retryState: "manual-recovery-required",
      writersQuiesced: true,
      writersRestored: true,
    });
  });

  test("records submitted executor failures as COMMIT-ambiguous interruption", () => {
    const executionFailure = new CheckpointMaintenanceGateError(
      "writer-quiescence",
      new BackupQuiescenceOperationError(new CheckpointSemanticCompactionError("execution-failed"), {
        nautiloWriterStopped: true,
        logtoWriterStopped: true,
      }, true),
      "mutation",
    );
    expect(checkpointSemanticFailureOperationState(executionFailure, {
      semanticStarted: true,
      semanticResultPresent: false,
    })).toEqual({
      status: "interrupted",
      semanticStatus: "interrupted",
      interruption: "during-semantic-cleanup",
    });
    expect(checkpointFailureEvidence(executionFailure)).toMatchObject({
      retryState: "manual-recovery-required",
      failure: {
        code: "operation-interrupted",
        guidance: "inspect-postgres-recovery-and-rerun-explicitly",
      },
    });
    expect(checkpointSemanticFailureOperationState(
      new CheckpointSemanticCompactionError("source-identity-mismatch"),
      { semanticStarted: true, semanticResultPresent: true },
    )).toEqual({ status: "failed", semanticStatus: "complete", interruption: "none" });
  });

  test("only ambiguous rewrite execution failures become physical interruptions", () => {
    expect(isCheckpointPhysicalOutcomeAmbiguous(new CheckpointPhysicalReclamationError("execution-failed", "checkpoint_blobs"))).toBe(true);
    expect(isCheckpointPhysicalOutcomeAmbiguous(new CheckpointPhysicalReclamationError("execution-failed", "analyze"))).toBe(true);
    expect(isCheckpointPhysicalOutcomeAmbiguous(new CheckpointPhysicalReclamationError("execution-failed", "preflight"))).toBe(false);
    expect(isCheckpointPhysicalOutcomeAmbiguous(new CheckpointPhysicalReclamationError("invalid-probe", "verification"))).toBe(false);
    expect(checkpointFailureEvidence(new CheckpointPhysicalReclamationError("contention", "preflight"))).toMatchObject({
      failure: { code: "physical-reclamation-failed" }, retryState: "manual-recovery-required",
    });
    expect(checkpointFailureEvidence(new CheckpointPhysicalReclamationError("execution-failed", "checkpoints"))).toMatchObject({
      failure: { code: "operation-interrupted" }, retryState: "manual-recovery-required",
    });
  });

  test("requires exactly one explicit target and parses Phase 3.2 apply authority", () => {
    const missing = parseCompactCheckpointsArgs(["compact-checkpoints"]);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.message).toContain("--instance");
    const apply = parseCompactCheckpointsArgs(["compact-checkpoints", "--instance", "default", "--apply"]);
    expect(apply).toMatchObject({ ok: true, value: { apply: true, target: "canonical-default" } });
    expect(parseCompactCheckpointsArgs(["compact-checkpoints", "--instance", "default", "--reclaim-physical"])).toMatchObject({ ok: false });
    expect(parseCompactCheckpointsArgs(["compact-checkpoints", "--instance", "default", "--apply", "--reclaim-physical"])).toMatchObject({ ok: true, value: { reclaimPhysical: true } });
    expect(parseCompactCheckpointsArgs(["compact-checkpoints", "--instance", "default", "--instance", "beta"])).toMatchObject({ ok: false });
    expect(parseCompactCheckpointsArgs(["compact-checkpoints", "--instance", "default", "--json", "--json"])).toMatchObject({ ok: false });
    expect(parseCompactCheckpointsArgs(["compact-checkpoints", "--instance", "default", "oops"])).toMatchObject({ ok: false });
    const invalid = parseCompactCheckpointsArgs(["compact-checkpoints", "--instance", "bad/path"]);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.message).toContain("invalid");
    expect(parseCompactCheckpointsArgs(["compact-checkpoints", "--instance", "(default)", "--json"])).toEqual({
      ok: true,
      value: { explicitInstance: "(default)", resolvedInstanceId: "", target: "canonical-default", asJson: true, apply: false, iKnowWhatIAmDoing: false, reclaimPhysical: false },
    });
  });

  test("snapshot script is one bounded read-only transaction with physical query before rollback", () => {
    const script = buildCompactCheckpointsSnapshotScript();
    expect(script).toContain("REPEATABLE READ READ ONLY");
    expect(script).toContain("SET LOCAL lock_timeout = '5s'");
    expect(script).toContain("SET LOCAL statement_timeout = '60s'");
    expect(script.indexOf("pg_total_relation_size")).toBeLessThan(script.lastIndexOf("ROLLBACK"));
    expect(script).toContain("\\if :checkpoint_schema_is_current");
    expect(COMPACT_CHECKPOINTS_SPAWN_TIMEOUT_MS).toBeGreaterThan(60_000);
  });

  test("help truthfully separates semantic cleanup from physical rewrite", async () => {
    const output: string[] = [];
    await compactCheckpointsCmd(["compact-checkpoints", "--help"], { write: (line) => output.push(line) });
    expect(output.join("\n")).toContain("--i-know-what-i-am-doing");
    expect(output.join("\n")).toContain("Performs no physical rewrite");
    expect(output.join("\n")).toContain("ACCESS EXCLUSIVE");
    expect(output.join("\n")).toContain("Dry-run is the default");
  });
});

describe("compact-checkpoints command", () => {
  test("connects using the raw explicit default selector, not a pre-existing environment", async () => {
    const output: string[] = [];
    let selectedEnv: NodeJS.ProcessEnv | undefined;
    const code = await compactCheckpointsCmd(["compact-checkpoints", "--instance", "default", "--json"], {
      ...commandDeps(output),
      resolveInstance: (env) => {
        selectedEnv = env;
        return instance;
      },
    });
    expect(code).toBe(0);
    expect(selectedEnv?.["NAUTILO_INSTANCE_ID"]).toBe("");
    expect(JSON.parse(output[0]!)).toMatchObject({ target: "canonical-default", outcome: "current-schema" });
  });

  test("reports absent, malformed, timeout, and permission outcomes without raw database errors", async () => {
    const cases: Array<{ stdout?: string; stderr?: string; outcome: string }> = [
      {
        stdout: snapshot([{ kind: "schema", row: { missing_required_checkpoint_tables: "3", invalid_required_schema_items: "0" } }]),
        outcome: "absent-required-checkpoint-schema",
      },
      { stdout: "unexpected warning", outcome: "invalid-aggregate-projection" },
      { stderr: "ERROR: canceling statement due to statement timeout postgres://secret", outcome: "snapshot-timeout" },
      { stderr: "ETIMEDOUT postgres://secret", outcome: "snapshot-timeout" },
      { stderr: "ERROR: permission denied for schema langchain postgres://secret", outcome: "snapshot-permission-denied" },
    ];
    for (const fixture of cases) {
      const output: string[] = [];
      const deps = commandDeps(output, fixture.stdout ?? snapshot());
      const code = await compactCheckpointsCmd(["compact-checkpoints", "--instance", "default", "--json"], {
        ...deps,
        executor: fixture.stderr
          ? { execute: () => ({ ok: false as const, stderr: fixture.stderr! }) }
          : deps.executor,
      });
      expect(code).toBe(1);
      expect(output.join("\n")).toContain(fixture.outcome);
      expect(output.join("\n")).not.toContain("postgres://secret");
    }
  });

  test("returns aggregate-only human output for compact, historical, and shared-blob fixtures", async () => {
    const output: string[] = [];
    const code = await compactCheckpointsCmd(["compact-checkpoints", "--instance", "feature-489"], commandDeps(output));
    expect(code).toBe(0);
    expect(output[0]).toContain("Reclaimable (estimate)");
    expect(output[0]).toContain("TOAST");
    expect(output[0]).not.toContain("thread_id");
    expect(output[0]).not.toContain("checkpoint_id");
    const failedResult: CompactCheckpointsFailure = {
      formatVersion: 1, kind: "checkpoint-maintenance-inventory", mode: "dry-run", target: "named-instance", outcome: "invalid-retained-checkpoint-format",
    };
    expect(formatCompactCheckpointsResult(failedResult)).toContain("No changes were made.");
  });

  test("accepts empty and shared-blob aggregate fixtures, but rejects malformed current-format evidence", async () => {
    const zeroes = Object.fromEntries(Object.keys(aggregateRow).map((key) => [key, "0"]));
    const emptyOutput: string[] = [];
    expect(await compactCheckpointsCmd(
      ["compact-checkpoints", "--instance", "default", "--json"],
      commandDeps(emptyOutput, snapshot([
        { kind: "schema", row: { missing_required_checkpoint_tables: "0", invalid_required_schema_items: "0" } },
        { kind: "plan", row: zeroes },
        { kind: "physical", relations: [
          { relation: "checkpoint_blobs", table_bytes: "0", index_bytes: "0", toast_bytes: "0", total_bytes: "0" },
          { relation: "checkpoint_writes", table_bytes: "0", index_bytes: "0", toast_bytes: "0", total_bytes: "0" },
          { relation: "checkpoints", table_bytes: "0", index_bytes: "0", toast_bytes: "0", total_bytes: "0" },
        ] },
      ])),
    )).toBe(0);
    expect(emptyOutput.join("\n")).toContain("current-schema");

    // Shared blobs only appear as de-duplicated aggregate counts at this API
    // boundary; source IDs and channel names never escape the query.
    const sharedOutput: string[] = [];
    expect(await compactCheckpointsCmd(
      ["compact-checkpoints", "--instance", "default", "--json"],
      commandDeps(sharedOutput, snapshot([
        { kind: "schema", row: { missing_required_checkpoint_tables: "0", invalid_required_schema_items: "0" } },
        { kind: "plan", row: { ...aggregateRow, current_blob_rows: "1", retained_blob_rows: "1", current_blob_payload_bytes: "99", retained_blob_payload_bytes: "99" } },
        { kind: "physical", relations: [
          { relation: "checkpoint_blobs", table_bytes: "100", index_bytes: "20", toast_bytes: "75", total_bytes: "120" },
          { relation: "checkpoint_writes", table_bytes: "200", index_bytes: "40", toast_bytes: "150", total_bytes: "240" },
          { relation: "checkpoints", table_bytes: "50", index_bytes: "10", toast_bytes: "0", total_bytes: "60" },
        ] },
      ])),
    )).toBe(0);
    expect(sharedOutput.join("\n")).not.toContain("channel");

    const malformedOutput: string[] = [];
    expect(await compactCheckpointsCmd(
      ["compact-checkpoints", "--instance", "default", "--json"],
      commandDeps(malformedOutput, snapshot([
        { kind: "schema", row: { missing_required_checkpoint_tables: "0", invalid_required_schema_items: "0" } },
        { kind: "plan", row: { ...aggregateRow, invalid_retained_checkpoint_formats: "1" } },
        { kind: "physical", relations: [
          { relation: "checkpoint_blobs", table_bytes: "100", index_bytes: "20", toast_bytes: "75", total_bytes: "120" },
          { relation: "checkpoint_writes", table_bytes: "200", index_bytes: "40", toast_bytes: "150", total_bytes: "240" },
          { relation: "checkpoints", table_bytes: "50", index_bytes: "10", toast_bytes: "0", total_bytes: "60" },
        ] },
      ])),
    )).toBe(1);
    expect(malformedOutput.join("\n")).toContain("invalid-retained-checkpoint-format");
  });

  test("does not invoke the executor when the selected instance has no instance.json", async () => {
    const output: string[] = [];
    let called = false;
    const code = await compactCheckpointsCmd(["compact-checkpoints", "--instance", "default"], {
      ...commandDeps(output),
      instanceRootExists: () => false,
      executor: { execute: () => { called = true; return { ok: true as const, stdout: snapshot() }; } },
    });
    expect(code).toBe(1);
    expect(called).toBe(false);
    expect(output.join("\n")).toContain("instance-unavailable");
  });

  test("fails closed if resolver returns a different instance than the explicit selector", async () => {
    const output: string[] = [];
    let called = false;
    const code = await compactCheckpointsCmd(["compact-checkpoints", "--instance", "default", "--json"], {
      ...commandDeps(output),
      resolveInstance: () => ({ ...instance, instanceId: "wrong-worktree" }),
      executor: { execute: () => { called = true; return { ok: true as const, stdout: snapshot() }; } },
    });
    expect(code).toBe(1);
    expect(called).toBe(false);
    expect(output.join("\n")).toContain("instance-resolution-mismatch");
  });

  test("fails closed on duplicate or unknown snapshot records", async () => {
    const output: string[] = [];
    const code = await compactCheckpointsCmd(["compact-checkpoints", "--instance", "default", "--json"], commandDeps(output, snapshot([
      { kind: "schema", row: { missing_required_checkpoint_tables: "0", invalid_required_schema_items: "0" } },
      { kind: "plan", row: aggregateRow },
      { kind: "plan", row: aggregateRow },
    ])));
    expect(code).toBe(1);
    expect(output.join("\n")).toContain("invalid-aggregate-projection");
  });

  test("apply awaits gate then record, reports truthful JSON, and dry-run never enters the gate", async () => {
    const events: string[] = [];
    const output: string[] = [];
    const code = await compactCheckpointsCmd(["compact-checkpoints", "--instance", "default", "--apply", "--json"], {
      ...commandDeps(output), mutationGuard: () => true,
      applyGate: async () => { events.push("gate"); },
      writeApplyRecord: async () => { events.push("record"); },
      writeApplyFailureRecord: async () => { events.push("failure-record"); },
    });
    expect(code).toBe(0); expect(events).toEqual(["gate", "record"]);
    expect(JSON.parse(output[0]!)).toMatchObject({ mode: "apply", outcome: "gated-no-delete" });
    await compactCheckpointsCmd(["compact-checkpoints", "--instance", "default"], { ...commandDeps([]), applyGate: async () => { events.push("wrong"); } });
    expect(events).toEqual(["gate", "record"]);
  });

  test("dry-run and ordinary semantic apply never enter the separately requested physical executor", async () => {
    let physicalCalls = 0;
    const physicalExecutor = { execute: () => { physicalCalls += 1; return { ok: false as const, stderr: "must-not-run" }; } };
    expect(await compactCheckpointsCmd(["compact-checkpoints", "--instance", "default"], {
      ...commandDeps([]), physicalExecutor,
    })).toBe(0);
    const output: string[] = [];
    expect(await compactCheckpointsCmd(["compact-checkpoints", "--instance", "default", "--apply", "--json"], {
      ...commandDeps(output), mutationGuard: () => true, physicalExecutor,
      applyGate: async () => undefined,
      writeApplyRecord: async () => undefined,
      writeApplyFailureRecord: async () => undefined,
    })).toBe(0);
    expect(physicalCalls).toBe(0);
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]!)).toMatchObject({ outcome: "gated-no-delete" });
  });

  test("apply guard, gate, record failure, and named target fail closed without raw errors", async () => {
    const scenarios = [
      { args: ["compact-checkpoints", "--instance", "default", "--apply"], extra: { mutationGuard: () => false } },
      { args: ["compact-checkpoints", "--instance", "default", "--apply"], extra: { mutationGuard: () => true, applyGate: async () => { throw new Error("postgres://secret"); }, writeApplyRecord: async () => undefined, writeApplyFailureRecord: async () => undefined } },
      { args: ["compact-checkpoints", "--instance", "default", "--apply"], extra: { mutationGuard: () => true, applyGate: async () => undefined, writeApplyRecord: async () => { throw new Error("secret"); }, writeApplyFailureRecord: async () => undefined } },
      { args: ["compact-checkpoints", "--instance", "named", "--apply"], extra: { mutationGuard: () => true } },
    ];
    for (const scenario of scenarios) {
      const output: string[] = [];
      const code = await compactCheckpointsCmd(scenario.args, { ...commandDeps(output), ...scenario.extra });
      expect(code).not.toBe(0); expect(output.join("\n")).not.toContain("postgres://secret");
    }
  });

  test("every JSON apply refusal or failure is one typed redacted document", async () => {
    const scenarios = [
      { args: ["compact-checkpoints", "--instance", "default", "--apply", "--json"], extra: { mutationGuard: () => false }, outcome: "consent-required" },
      { args: ["compact-checkpoints", "--instance", "named", "--apply", "--json"], extra: { mutationGuard: () => true }, outcome: "canonical-default-only" },
      { args: ["compact-checkpoints", "--instance", "default", "--apply", "--json"], extra: { mutationGuard: () => true, applyGate: async () => undefined }, outcome: "invalid-injected-seams" },
      { args: ["compact-checkpoints", "--instance", "default", "--apply", "--json"], extra: { mutationGuard: () => true, applyGate: async () => { throw new Error("postgres://secret"); }, writeApplyRecord: async () => undefined, writeApplyFailureRecord: async () => undefined }, outcome: "gate-failed" },
    ];
    for (const scenario of scenarios) {
      const output: string[] = [];
      expect(await compactCheckpointsCmd(scenario.args, { ...commandDeps(output), ...scenario.extra })).not.toBe(0);
      expect(output).toHaveLength(1);
      expect(JSON.parse(output[0]!)).toMatchObject({ mode: "apply", outcome: scenario.outcome });
      expect(output[0]).not.toContain("secret");
    }
  });

  test("injected apply gate and success/failure record writers are an all-or-nothing set", async () => {
    const output: string[] = [];
    const code = await compactCheckpointsCmd(["compact-checkpoints", "--instance", "default", "--apply"], {
      ...commandDeps(output), mutationGuard: () => true, applyGate: async () => undefined,
    });
    expect(code).toBe(1);
    expect(output.join("\n")).toContain("provided together");
  });

  test("awaits typed failure evidence after a gate failure and stays nonzero if that write fails", async () => {
    const events: string[] = [];
    const output: string[] = [];
    const code = await compactCheckpointsCmd(["compact-checkpoints", "--instance", "default", "--apply"], {
      ...commandDeps(output),
      mutationGuard: () => true,
      applyGate: async () => { events.push("gate"); throw new Error("postgres://secret"); },
      writeApplyRecord: async () => { events.push("success-record"); },
      writeApplyFailureRecord: async () => { events.push("failure-record"); throw new Error("record secret"); },
    });
    expect(code).toBe(1);
    expect(events).toEqual(["gate", "failure-record"]);
    expect(output.join("\n")).not.toContain("postgres://secret");
    expect(output.join("\n")).not.toContain("record secret");
  });
});
