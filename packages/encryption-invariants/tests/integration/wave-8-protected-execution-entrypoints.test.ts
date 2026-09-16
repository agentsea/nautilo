import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  PROTECTED_EXECUTION_ENTRYPOINTS,
  validateProtectedExecutionEntrypoints,
} from "../../src/node/protected-execution-entrypoints";
import {
  PROTECTED_EXECUTION_ADAPTERS,
  PROTECTED_EXECUTION_PATH_FAMILIES,
} from "../../../runtime/src/protected-execution/entrypoint-adapters";

const repositoryRoot = resolve(import.meta.dir, "../../../..");

const EXPECTED_ENTRYPOINT_IDS = [
  "artifact.read",
  "artifact.write",
  "compaction.model",
  "foreground.conductor",
  "foreground.fork",
  "foreground.main",
  "memory.exit_flush",
  "memory.review",
  "resume.approval",
  "resume.approval_ask",
  "resume.await_reply",
  "resume.identity",
  "stenographer.compaction",
  "stenographer.extraction",
  "subagent.scope",
  "task.approval_resume",
  "task.dispatch",
  "task.execute",
] as const;

describe("Wave 8 protected execution entrypoint inventory", () => {
  test("pins every currently separate Agent execution and resume boundary", () => {
    expect(
      PROTECTED_EXECUTION_ENTRYPOINTS.map((entry) => entry.id).sort(),
    ).toEqual([...EXPECTED_ENTRYPOINT_IDS]);
  });

  test("every registered source and anchor exists on the grounded Wave 7 baseline", () => {
    expect(
      validateProtectedExecutionEntrypoints(repositoryRoot),
    ).toEqual([]);

    for (const entry of PROTECTED_EXECUTION_ENTRYPOINTS) {
      const sourcePath = resolve(repositoryRoot, entry.sourcePath);
      expect(existsSync(sourcePath)).toBe(true);
      expect(readFileSync(sourcePath, "utf8")).toContain(entry.anchor);
    }
  });

  test("declares exact protected duties without duplicate source anchors", () => {
    const sourceAnchors = PROTECTED_EXECUTION_ENTRYPOINTS.map(
      (entry) => `${entry.sourcePath}#${entry.anchor}`,
    );
    expect(new Set(sourceAnchors).size).toBe(sourceAnchors.length);

    for (const entry of PROTECTED_EXECUTION_ENTRYPOINTS) {
      expect(entry.requiredDuties.length).toBeGreaterThan(0);
      expect(
        entry.requiredDuties.every((duty) =>
          [
            "carry_coordinates",
            "resolve_current_lease",
            "wipe_terminal_lease",
          ].includes(duty)
        ),
      ).toBe(true);
    }
  });

  test("keeps one runtime adapter for every audited entrypoint across all 11 families", () => {
    expect(
      PROTECTED_EXECUTION_ADAPTERS.map((adapter) =>
        adapter.entrypointId
      ).sort(),
    ).toEqual([...EXPECTED_ENTRYPOINT_IDS]);
    expect(
      [...new Set(
        PROTECTED_EXECUTION_ADAPTERS.map((adapter) => adapter.family),
      )].sort(),
    ).toEqual([...PROTECTED_EXECUTION_PATH_FAMILIES].sort());
    expect(PROTECTED_EXECUTION_PATH_FAMILIES).toHaveLength(11);
  });
});
