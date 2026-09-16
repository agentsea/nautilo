import { describe, expect, test } from "bun:test";
import {
  CHECKPOINT_PHYSICAL_REWRITE_ORDER,
  CheckpointPhysicalReclamationError,
  buildCheckpointPhysicalAnalyzeScript,
  buildCheckpointPhysicalProbeScript,
  buildCheckpointPhysicalRewriteScript,
  executeCheckpointPhysicalReclamation,
  parseCheckpointPhysicalProbe,
  type CheckpointPhysicalExecutor,
} from "../../src/lib/checkpoint-physical-reclamation";

const semantic = {
  checkpointRows: 2, writeRows: 2, blobRows: 4, totalRows: 8,
  checkpointLogicalBytes: 20, writeLogicalBytes: 20, blobLogicalBytes: 40,
  totalLogicalBytes: 80, blobPayloadBytes: 30,
};

function probe(totalOffset = 0, blockers = 0): string {
  return JSON.stringify({
    relations: [
      { relation: "checkpoint_blobs", table_bytes: 100 + totalOffset, index_bytes: 20, toast_bytes: 50, total_bytes: 120 + totalOffset },
      { relation: "checkpoint_writes", table_bytes: 80, index_bytes: 20, toast_bytes: 0, total_bytes: 100 },
      { relation: "checkpoints", table_bytes: 50, index_bytes: 10, toast_bytes: 0, total_bytes: 60 },
    ],
    checkpointRows: 2, writeRows: 2, blobRows: 4,
    blockerLocks: blockers, activeClients: 0,
  });
}

function sequenceExecutor(outputs: Array<{ ok: true; stdout: string } | { ok: false; stderr: string }>, scripts: string[]): CheckpointPhysicalExecutor {
  return { execute: ({ script }) => { scripts.push(script); return outputs.shift()!; } };
}

describe("checkpoint physical reclamation contracts", () => {
  test("uses deterministic nontransactional VACUUM FULL ordering, bounded locks, and explicit ANALYZE", () => {
    expect(CHECKPOINT_PHYSICAL_REWRITE_ORDER).toEqual(["checkpoint_writes", "checkpoints", "checkpoint_blobs"]);
    for (const relation of CHECKPOINT_PHYSICAL_REWRITE_ORDER) {
      const sql = buildCheckpointPhysicalRewriteScript(relation);
      expect(sql).toContain(`VACUUM (FULL) langchain.${relation}`);
      expect(sql).toContain("lock_timeout = '5s'");
      expect(sql).not.toContain("BEGIN");
    }
    expect(buildCheckpointPhysicalAnalyzeScript()).toContain("ANALYZE langchain.checkpoint_blobs");
    expect(buildCheckpointPhysicalProbeScript()).toContain("pg_catalog.pg_locks");
    expect(buildCheckpointPhysicalProbeScript()).toContain("pg_catalog.pg_stat_activity");
  });

  test("rewrites only after a clean preflight and claims bytes only after after-probe verification", async () => {
    const scripts: string[] = [];
    const progress: string[] = [];
    const result = await executeCheckpointPhysicalReclamation({
      container: "disposable",
      expectedSemanticState: semantic,
      executor: sequenceExecutor([
        { ok: true, stdout: probe(100) },
        { ok: true, stdout: "" }, { ok: true, stdout: "" }, { ok: true, stdout: "" },
        { ok: true, stdout: "" },
        { ok: true, stdout: probe(0) },
      ], scripts),
      progress: ({ stage, status }) => { progress.push(`${stage}:${status}`); },
    });
    expect(result).toMatchObject({ beforeRelationBytes: 380, afterRelationBytes: 280, reclaimedBytes: 100, statisticsRefreshed: true });
    expect(scripts.filter((script) => script.includes("VACUUM (FULL)")).map((script) => script.match(/langchain\.([a-z_]+)/)?.[1])).toEqual([...CHECKPOINT_PHYSICAL_REWRITE_ORDER]);
    expect(progress.at(-1)).toBe("verification:complete");
  });

  test("contention refuses before rewrite and executor interruption never claims after bytes", async () => {
    const contentionScripts: string[] = [];
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(executeCheckpointPhysicalReclamation({
      container: "disposable", expectedSemanticState: semantic,
      executor: sequenceExecutor([{ ok: true, stdout: probe(0, 1) }], contentionScripts),
    })).rejects.toMatchObject({ code: "contention", stage: "preflight", before: { blockerLocks: 1 } });
    expect(contentionScripts.some((script) => script.includes("VACUUM (FULL)"))).toBe(false);

    const interruptedScripts: string[] = [];
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(executeCheckpointPhysicalReclamation({
      container: "disposable", expectedSemanticState: semantic,
      executor: sequenceExecutor([
        { ok: true, stdout: probe(100) }, { ok: true, stdout: "" }, { ok: false, stderr: "secret" },
      ], interruptedScripts),
    })).rejects.toEqual(new CheckpointPhysicalReclamationError("execution-failed", "checkpoints"));
    expect(interruptedScripts.filter((script) => script.includes("VACUUM (FULL)"))).toHaveLength(2);
  });

  test("rejects changed semantic rows, malformed probes, and increased after measurements", async () => {
    expect(parseCheckpointPhysicalProbe("not-json")).toBeUndefined();
    const changed = JSON.parse(probe()) as Record<string, unknown>;
    changed["writeRows"] = 3;
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(executeCheckpointPhysicalReclamation({
      container: "disposable", expectedSemanticState: semantic,
      executor: sequenceExecutor([{ ok: true, stdout: JSON.stringify(changed) }], []),
    })).rejects.toMatchObject({ code: "semantic-state-changed" });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(executeCheckpointPhysicalReclamation({
      container: "disposable", expectedSemanticState: semantic,
      executor: sequenceExecutor([
        { ok: true, stdout: probe(0) },
        { ok: true, stdout: "" }, { ok: true, stdout: "" }, { ok: true, stdout: "" }, { ok: true, stdout: "" },
        { ok: true, stdout: probe(1) },
      ], []),
    })).rejects.toMatchObject({ code: "physical-measurement-increased", stage: "verification" });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(executeCheckpointPhysicalReclamation({
      container: "disposable", expectedSemanticState: semantic,
      executor: sequenceExecutor([
        { ok: true, stdout: probe(0) },
        { ok: true, stdout: "" }, { ok: true, stdout: "" }, { ok: true, stdout: "" }, { ok: true, stdout: "" },
        { ok: true, stdout: "not-json" },
      ], []),
    })).rejects.toMatchObject({ code: "invalid-probe", stage: "verification" });
  });
});
