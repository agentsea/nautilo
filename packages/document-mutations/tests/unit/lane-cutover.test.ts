import { describe, expect, test } from "bun:test";

import {
  DOCUMENT_MUTATION_LANES,
  runDocumentMutationLane,
  type DocumentMutationLaneCutover,
} from "../../src/lane-cutover";

async function captureFailure(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to fail");
}

describe("document mutation lane cutover", () => {
  test("defines every stable cutover lane", () => {
    expect(DOCUMENT_MUTATION_LANES).toEqual([
      "editor_save",
      "apply_patch",
      "file_tool",
      "officecli",
      "artifact_lifecycle",
      "desktop_files_ui",
    ]);
  });

  test("legacy mode invokes only the legacy writer", async () => {
    let legacyWrites = 0;

    const result = await runDocumentMutationLane({
      lane: "file_tool",
      mode: "legacy",
      legacyWrite: () => {
        legacyWrites += 1;
        return "legacy";
      },
    });

    expect(result).toEqual({ mode: "legacy", result: "legacy" });
    expect(legacyWrites).toBe(1);
  });

  test("shadow mode starts an advisory preview without delaying the legacy writer", async () => {
    const calls: string[] = [];
    let resolvePreview!: (value: { applicable: boolean }) => void;
    const pendingPreview = new Promise<{ applicable: boolean }>((resolve) => {
      resolvePreview = resolve;
    });

    const result = await runDocumentMutationLane({
      lane: "apply_patch",
      mode: "shadow",
      coordinatorPreview: () => {
        calls.push("preview");
        return pendingPreview;
      },
      legacyWrite: async () => {
        calls.push("legacy");
        return "legacy";
      },
    });

    expect(result.mode).toBe("shadow");
    if (result.mode !== "shadow") throw new Error("Expected shadow execution");
    expect(result.result).toBe("legacy");
    expect(calls).toContain("legacy");
    resolvePreview({ applicable: true });
    expect(await result.preview).toEqual({
      ok: true,
      value: { applicable: true },
    });
  });

  test("coordinator mode invokes only the coordinator writer", async () => {
    let coordinatorWrites = 0;

    const result = await runDocumentMutationLane({
      lane: "editor_save",
      mode: "coordinator",
      coordinatorWrite: () => {
        coordinatorWrites += 1;
        return "coordinator";
      },
    });

    expect(result).toEqual({ mode: "coordinator", result: "coordinator" });
    expect(coordinatorWrites).toBe(1);
  });

  test("legacy writer failure propagates without a second writer", async () => {
    let legacyWrites = 0;
    const failure = new Error("legacy failed");

    const result = runDocumentMutationLane({
      lane: "desktop_files_ui",
      mode: "legacy",
      legacyWrite: () => {
        legacyWrites += 1;
        throw failure;
      },
    });

    expect(await captureFailure(result)).toBe(failure);
    expect(legacyWrites).toBe(1);
  });

  test("shadow preview failure is surfaced without changing legacy behavior", async () => {
    let previews = 0;
    let legacyWrites = 0;
    const failure = new Error("preview failed");

    const result = runDocumentMutationLane({
      lane: "officecli",
      mode: "shadow",
      coordinatorPreview: () => {
        previews += 1;
        throw failure;
      },
      legacyWrite: () => {
        legacyWrites += 1;
        return "legacy";
      },
    });

    const completed = await result;
    expect(completed.mode).toBe("shadow");
    if (completed.mode !== "shadow") throw new Error("Expected shadow execution");
    expect(completed.result).toBe("legacy");
    expect(await completed.preview).toEqual({ ok: false, error: failure });
    expect(previews).toBe(1);
    expect(legacyWrites).toBe(1);
  });

  test("shadow legacy failure propagates after one read-only preview", async () => {
    let previews = 0;
    let legacyWrites = 0;
    const failure = new Error("legacy failed");

    const result = runDocumentMutationLane({
      lane: "artifact_lifecycle",
      mode: "shadow",
      coordinatorPreview: () => {
        previews += 1;
      },
      legacyWrite: () => {
        legacyWrites += 1;
        throw failure;
      },
    });

    expect(await captureFailure(result)).toBe(failure);
    expect(previews).toBe(1);
    expect(legacyWrites).toBe(1);
  });

  test("coordinator writer failure propagates without a legacy fallback", async () => {
    let coordinatorWrites = 0;
    const failure = new Error("coordinator failed");

    const result = runDocumentMutationLane({
      lane: "editor_save",
      mode: "coordinator",
      coordinatorWrite: () => {
        coordinatorWrites += 1;
        throw failure;
      },
    });

    expect(await captureFailure(result)).toBe(failure);
    expect(coordinatorWrites).toBe(1);
  });

  test("the discriminated modes make dual writes structurally impossible", async () => {
    const writerCounts = {
      legacy: 0,
      coordinator: 0,
    };

    const selections: DocumentMutationLaneCutover<string>[] = [
      {
        lane: "file_tool",
        mode: "legacy",
        legacyWrite: () => {
          writerCounts.legacy += 1;
          return "legacy";
        },
      },
      {
        lane: "apply_patch",
        mode: "shadow",
        coordinatorPreview: () => undefined,
        legacyWrite: () => {
          writerCounts.legacy += 1;
          return "legacy";
        },
      },
      {
        lane: "officecli",
        mode: "coordinator",
        coordinatorWrite: () => {
          writerCounts.coordinator += 1;
          return "coordinator";
        },
      },
    ];

    for (const selection of selections) {
      const before = { ...writerCounts };
      await runDocumentMutationLane(selection);

      const legacyDelta = writerCounts.legacy - before.legacy;
      const coordinatorDelta = writerCounts.coordinator - before.coordinator;
      expect(legacyDelta + coordinatorDelta).toBe(1);
      expect(legacyDelta === 0 || coordinatorDelta === 0).toBe(true);
    }
  });
});
