import { describe, expect, test } from "bun:test";
import type { RecordSnapshot } from "../../src/contracts/hierarchy";
import {
  ORGANIZER_CONTRACT,
  partitionOrganizerProposal,
  projectOrganizerBatchPrompt,
  projectOrganizerPrompt,
  runOrganizerBatch,
  runOrganizer,
  type OrganizerInput,
} from "../../src/organizer/processor";

function record(recordRef: string, statement: string, height = 0): RecordSnapshot {
  return {
    recordRef,
    observedContentFingerprint: `fingerprint-${recordRef}`,
    posture: "derived",
    anchors: [`room-${recordRef}`],
    statement,
    sourceRefs: [],
    childRecordRefs: [],
    structuralHeight: height,
    lifecycle: "current",
  };
}

const input: OrganizerInput = {
  changed: { handle: "R1", snapshot: record("secret-db-id-1", "PostgreSQL supports transactions.") },
  candidates: [
    { handle: "R2", snapshot: record("secret-db-id-2", "Portable SQL is required.") },
    { handle: "R3", snapshot: record("secret-db-id-3", "Neon is PostgreSQL compatible.") },
  ],
  existingParents: [
    { handle: "P1", snapshot: record("secret-parent-id", "Database requirements", 1) },
  ],
  changeReason: "created",
  maxSelectedChildren: 3,
};

describe("Hierarchy Organizer", () => {
  test("batches independent questions into one strict ordered response", async () => {
    const prompts: string[] = [];
    const results = await runOrganizerBatch({
      snapshots: [input, { ...input, changeReason: "revised" }],
      invoke: (prompt) => {
        prompts.push(prompt);
        return Promise.resolve(JSON.stringify({
          answers: [
            { question: "Q1", proposal: { operation: "no_change" } },
            {
              question: "Q2",
              proposal: {
                operation: "create_parent",
                statement: "A useful second hierarchy decision.",
                childRecordRefs: ["R1", "R2"],
              },
            },
          ],
        }));
      },
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('"question":"Q1"');
    expect(prompts[0]).toContain('"question":"Q2"');
    expect(results.map((entry) => entry.result.ok)).toEqual([true, true]);
    expect(results[1]?.result).toMatchObject({
      attempts: 1,
      proposal: { operation: "create_parent", childRecordRefs: ["R1", "R2"] },
    });
  });

  test("repairs only invalid batch answers and retains valid first-pass work", async () => {
    const prompts: string[] = [];
    const results = await runOrganizerBatch({
      snapshots: [input, { ...input, changeReason: "revised" }],
      invoke: (prompt) => {
        prompts.push(prompt);
        return Promise.resolve(prompts.length === 1
          ? JSON.stringify({
              answers: [
                { question: "Q1", proposal: { operation: "no_change" } },
                {
                  question: "Q2",
                  proposal: {
                    operation: "create_parent",
                    statement: "Hidden input.",
                    childRecordRefs: ["R1", "HIDDEN"],
                  },
                },
              ],
            })
          : JSON.stringify({
              answers: [{ question: "Q1", proposal: { operation: "no_change" } }],
            }));
      },
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('"questions":[{"question":"Q1"');
    expect(prompts[1]).not.toContain('"question":"Q2"');
    expect(results[0]?.result).toMatchObject({ ok: true, attempts: 1 });
    expect(results[1]?.result).toMatchObject({ ok: true, attempts: 2 });
  });

  test("fails a malformed batch envelope closed and bounds batch size", async () => {
    let calls = 0;
    const results = await runOrganizerBatch({
      snapshots: [input, input],
      invoke: () => {
        calls += 1;
        return Promise.resolve(JSON.stringify({
          answers: [
            { question: "Q1", proposal: { operation: "no_change" } },
            { question: "Q1", proposal: { operation: "no_change" } },
          ],
        }));
      },
    });
    expect(calls).toBe(2);
    expect(results.every((entry) => !entry.result.ok)).toBe(true);
    expect(projectOrganizerBatchPrompt(Array.from({ length: 9 }, () => input))).toEqual({
      ok: false,
      reason: "Organizer batch must contain between 1 and 8 items",
    });
  });

  test("renders bounded untrusted evidence using only opaque handles", () => {
    const projected = projectOrganizerPrompt(input);
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.prompt.startsWith(ORGANIZER_CONTRACT)).toBe(true);
    expect(projected.prompt).toContain("PostgreSQL supports transactions");
    expect(projected.prompt).toContain('"handle":"R1"');
    expect(projected.prompt).toContain("use extend_parent");
    expect(projected.prompt).toContain("use wrap_parent");
    expect(projected.prompt).not.toContain("secret-db-id-1");
    expect(projected.prompt).not.toContain("room-secret-db-id-1");
  });

  test("forbids latest-wins inference while preserving explicit temporal transitions", () => {
    const projected = projectOrganizerPrompt(input);
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;

    const contract = projected.prompt.slice(0, projected.prompt.indexOf("[Untrusted semantic evidence]"))
      .replace(/\s+/gu, " ");

    expect(contract).toContain("Input order, the changed-Record role, current lifecycle");
    expect(contract).toContain("A newer independent assertion does not automatically replace an older one.");
    expect(contract).toContain("correction, replacement, decision, or transition");
    expect(contract).toContain("names the unresolved positions and uncertainty");
    expect(contract).toContain("Describe a timeline only when the selected evidence itself establishes the transition or ordering.");
  });

  test("accepts a useful parent proposal and carries the signal", async () => {
    const controller = new AbortController();
    const signals: (AbortSignal | undefined)[] = [];
    const result = await runOrganizer({
      snapshot: input,
      signal: controller.signal,
      invoke: (_prompt, signal) => {
        signals.push(signal);
        return Promise.resolve(JSON.stringify({
          operation: "create_parent",
          statement: "PostgreSQL meets the portable transactional requirements.",
          childRecordRefs: ["R1", "R2"],
        }));
      },
    });
    expect(result).toMatchObject({
      ok: true,
      attempts: 1,
      proposal: { operation: "create_parent", childRecordRefs: ["R1", "R2"] },
    });
    expect(signals).toEqual([controller.signal]);
  });

  test("repairs one invalid response without widening eligible references", async () => {
    const prompts: string[] = [];
    const result = await runOrganizer({
      snapshot: input,
      invoke: (prompt) => {
        prompts.push(prompt);
        return Promise.resolve(prompts.length === 1
          ? JSON.stringify({
              operation: "create_parent",
              statement: "Invalid hidden dependency.",
              childRecordRefs: ["R1", "HIDDEN"],
            })
          : JSON.stringify({ operation: "no_change" }));
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected repaired Organizer result");
    expect(result.attempts).toBe(2);
    expect(result.proposal).toEqual({ operation: "no_change" });
    expect(prompts[1]).toContain("unknown or ineligible handle");
  });

  test("rejects unknown parents and duplicate additions after one repair", async () => {
    const result = await runOrganizer({
      snapshot: input,
      invoke: () => Promise.resolve(JSON.stringify({
        operation: "extend_parent",
        parentRecordRef: "P_UNKNOWN",
        statement: "Replacement",
        additionRefs: ["R1", "R1"],
      })),
    });
    expect(result).toMatchObject({
      ok: false,
      errorCode: "invalid_output",
      attempts: 2,
    });
  });

  test("accepts only additions when evolving an existing parent", async () => {
    const result = await runOrganizer({
      snapshot: input,
      invoke: () => Promise.resolve(JSON.stringify({
        operation: "extend_parent",
        parentRecordRef: "P1",
        statement: "The database decision now includes managed compatibility.",
        additionRefs: ["R1", "R3"],
      })),
    });
    expect(result).toMatchObject({
      ok: true,
      proposal: {
        operation: "extend_parent",
        parentRecordRef: "P1",
        additionRefs: ["R1", "R3"],
      },
    });
    if (!result.ok) return;
    expect(partitionOrganizerProposal({
      proposal: result.proposal,
      selectedInputs: [input.changed, ...input.candidates],
      existingParents: input.existingParents,
    })).toEqual({
      operation: "extend_parent",
      parentRecordRef: "secret-parent-id",
      statement: "The database decision now includes managed compatibility.",
      additionRecordRefs: ["secret-db-id-1", "secret-db-id-3"],
      additionSourceDependencies: [],
    });
  });

  test("wraps a derived changed Record without replacing it", async () => {
    const derivedChanged: OrganizerInput = {
      ...input,
      changed: {
        ...input.changed,
        snapshot: { ...input.changed.snapshot, structuralHeight: 1 },
      },
      existingParents: [],
    };
    const result = await runOrganizer({
      snapshot: derivedChanged,
      invoke: () => Promise.resolve(JSON.stringify({
        operation: "wrap_parent",
        parentRecordRef: "R1",
        statement: "The database decision and operating requirement form a broader topic.",
        additionRefs: ["R2"],
      })),
    });
    expect(result).toMatchObject({
      ok: true,
      proposal: {
        operation: "wrap_parent",
        parentRecordRef: "R1",
        additionRefs: ["R2"],
      },
    });
    if (!result.ok) return;
    expect(partitionOrganizerProposal({
      proposal: result.proposal,
      selectedInputs: [derivedChanged.changed, ...derivedChanged.candidates],
      existingParents: [],
    })).toEqual({
      operation: "wrap_parent",
      parentRecordRef: "secret-db-id-1",
      statement: "The database decision and operating requirement form a broader topic.",
      additionRecordRefs: ["secret-db-id-2"],
      additionSourceDependencies: [],
    });
  });

  test("rejects every synthesis that omits the changed Record", async () => {
    for (const response of [
      {
        operation: "create_parent",
        statement: "Two nearby candidates, but not the changed Record.",
        childRecordRefs: ["R2", "R3"],
      },
      {
        operation: "extend_parent",
        parentRecordRef: "P1",
        statement: "An unrelated extension.",
        additionRefs: ["R2"],
      },
      {
        operation: "wrap_parent",
        parentRecordRef: "P1",
        statement: "An unrelated wrapper.",
        additionRefs: ["R2"],
      },
    ]) {
      expect(await runOrganizer({
        snapshot: input,
        invoke: () => Promise.resolve(JSON.stringify(response)),
      })).toMatchObject({ ok: false, errorCode: "invalid_output", attempts: 2 });
    }
  });

  test("does not accept model-authored replacement or contraction operations", async () => {
    const result = await runOrganizer({
      snapshot: input,
      invoke: () => Promise.resolve(JSON.stringify({
        operation: "supersede_parent",
        parentRecordRef: "P1",
        statement: "Replace support.",
        childRecordRefs: ["R1"],
      })),
    });
    expect(result).toMatchObject({ ok: false, errorCode: "invalid_output", attempts: 2 });
  });

  test("rejects duplicate call-local handles before invoking a model", async () => {
    let calls = 0;
    const result = await runOrganizer({
      snapshot: {
        ...input,
        candidates: [{ handle: "R1", snapshot: input.candidates[0]!.snapshot }],
      },
      invoke: () => {
        calls += 1;
        return Promise.resolve("{}");
      },
    });
    expect(result).toMatchObject({ ok: false, errorCode: "invalid_input", attempts: 0 });
    expect(calls).toBe(0);
  });

  test("does not permit a single-child create-parent paraphrase", async () => {
    const result = await runOrganizer({
      snapshot: input,
      invoke: () => Promise.resolve(JSON.stringify({
        operation: "create_parent",
        statement: "PostgreSQL supports transactions.",
        childRecordRefs: ["R1"],
      })),
    });
    expect(result).toMatchObject({ ok: false, errorCode: "invalid_output" });
  });

  test("bounds provider output before parsing or repair", async () => {
    let calls = 0;
    const result = await runOrganizer({
      snapshot: input,
      invoke: () => {
        calls += 1;
        return Promise.resolve("x".repeat(5_001));
      },
    });
    expect(result).toMatchObject({
      ok: false,
      errorCode: "invalid_output",
      attempts: 2,
      reason: "response exceeds the Organizer output budget",
    });
    expect(calls).toBe(2);
  });

  test("partitions authored Memory selections from native Record children", async () => {
    const memory = {
      handle: "M1",
      snapshot: {
        ...record("must-not-become-a-record-ref", "The team prefers managed backups."),
        posture: "authored" as const,
        observedLogicalObjectRef: "memory-logical-secret",
        observedRevision: "memory-revision-secret",
      },
      dependency: {
        kind: "source" as const,
        dependency: {
          sourceKind: "memory/v1",
          logicalSourceRef: "memory-logical-secret",
          observedRevision: "memory-revision-secret",
          observedContentFingerprint: "memory-fingerprint-secret",
          terminalAuthorityLeafHandle: "authority-leaf-secret",
          authorityBearing: true,
        },
      },
    };
    const mixed: OrganizerInput = {
      ...input,
      changed: {
        ...input.changed,
        dependency: { kind: "record", recordRef: "native-record-a" },
      },
      candidates: [memory],
      existingParents: [],
      maxSelectedChildren: 2,
    };
    let prompt = "";
    const organized = await runOrganizer({
      snapshot: mixed,
      invoke: (value) => {
        prompt = value;
        return Promise.resolve(JSON.stringify({
          operation: "create_parent",
          statement: "The decision combines the observation and authored preference.",
          childRecordRefs: ["R1", "M1"],
        }));
      },
    });
    expect(organized.ok).toBe(true);
    if (!organized.ok) return;
    expect(prompt).not.toContain("memory-logical-secret");
    expect(prompt).not.toContain("memory-revision-secret");
    expect(prompt).not.toContain("authority-leaf-secret");

    const partitioned = partitionOrganizerProposal({
      proposal: organized.proposal,
      selectedInputs: [mixed.changed, ...mixed.candidates],
      existingParents: mixed.existingParents,
    });
    expect(partitioned).toEqual({
      operation: "create_parent",
      statement: "The decision combines the observation and authored preference.",
      childRecordRefs: ["native-record-a"],
      sourceDependencies: [{
        sourceKind: "memory/v1",
        logicalSourceRef: "memory-logical-secret",
        observedRevision: "memory-revision-secret",
        observedContentFingerprint: "memory-fingerprint-secret",
        terminalAuthorityLeafHandle: "authority-leaf-secret",
        authorityBearing: true,
      }],
    });
  });

  test("rejects duplicate logical dependencies before model invocation", async () => {
    let calls = 0;
    const result = await runOrganizer({
      snapshot: {
        ...input,
        changed: {
          ...input.changed,
          dependency: { kind: "record", recordRef: "same-record" },
        },
        candidates: [{
          ...input.candidates[0]!,
          dependency: { kind: "record", recordRef: "same-record" },
        }],
      },
      invoke: () => {
        calls += 1;
        return Promise.resolve('{"operation":"no_change"}');
      },
    });
    expect(result).toMatchObject({ ok: false, errorCode: "invalid_input", attempts: 0 });
    expect(calls).toBe(0);
  });
});
