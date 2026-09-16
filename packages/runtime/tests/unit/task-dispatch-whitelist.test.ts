import { beforeAll, describe, expect, test } from "bun:test";
import { ToolCatalog, initToolCatalog, registerAllTools } from "@nautilo/agent";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import type { Task } from "@nautilo/db";
import {
  resolveToolWhitelist,
  selectTaskEnvelopeMode,
} from "../../src/tasks/dispatch-task-run";

/**
 * M144 (R3) — the run's tool whitelist is resolved + VALIDATED at the dispatch
 * seam (single source of truth), not in the shortcut tools. These are DB-free
 * unit tests: `resolveToolWhitelist` only touches the in-memory tool catalog
 * via `validateSubagentToolWhitelist`, so we install a real catalog and a
 * synthetic envelope/task — no Postgres, no network.
 */

const baseEnvelope: MemoryAccessEnvelope = {
  memoryMode: "namespace",
  ownerId: "10000000-0000-4000-8000-000000000001",
  actorId: "20000000-0000-4000-8000-000000000002",
  agentId: "30000000-0000-4000-8000-000000000003",
  roomId: "",
  readableNamespaces: [],
  mutableNamespaces: [],
  writableNamespaces: [],
  // Empty policy → no tool is `forbidden`, so all cloud tools are visible.
  toolPolicy: {},
};

/** Minimal `Task` row carrying only the fields `resolveToolWhitelist` reads. */
function makeTask(overrides: Partial<Task>): Task {
  return {
    id: "task-1",
    depth: 0,
    toolsMode: "auto",
    toolsWhitelist: [],
    ...overrides,
  } as Task;
}

describe("M144 dispatch — resolveToolWhitelist (R3 single source of truth)", () => {
  beforeAll(() => {
    const catalog = new ToolCatalog();
    registerAllTools(catalog);
    initToolCatalog(catalog);
  });

  test("auto → undefined (select progressive core + activation default)", () => {
    const out = resolveToolWhitelist(makeTask({ toolsMode: "auto" }), baseEnvelope);
    expect(out).toBeUndefined();
  });

  test("none → [] (no core or activated tools)", () => {
    const out = resolveToolWhitelist(makeTask({ toolsMode: "none" }), baseEnvelope);
    expect(out).toEqual([]);
  });

  test("whitelist remains an exact hard ceiling for progressive activation", () => {
    const out = resolveToolWhitelist(
      makeTask({ toolsMode: "whitelist", toolsWhitelist: ["search_memory"] }),
      baseEnvelope,
    );
    expect(out).toEqual(["search_memory"]);
  });

  test("whitelist with an unknown tool → throws (rejected at dispatch)", () => {
    expect(() =>
      resolveToolWhitelist(
        makeTask({ toolsMode: "whitelist", toolsWhitelist: ["definitely_not_a_tool"] }),
        baseEnvelope,
      ),
    ).toThrow(/whitelist rejected/i);
  });

  test("whitelist with a policy-forbidden tool → throws (context-unavailable)", () => {
    const forbiddenEnvelope: MemoryAccessEnvelope = {
      ...baseEnvelope,
      toolPolicy: { search_memory: "forbidden" },
    };
    expect(() =>
      resolveToolWhitelist(
        makeTask({ toolsMode: "whitelist", toolsWhitelist: ["search_memory"] }),
        forbiddenEnvelope,
      ),
    ).toThrow(/whitelist rejected/i);
  });
});

describe("M144 dispatch — selectTaskEnvelopeMode (R2 / S3 discriminator)", () => {
  const OWNER = "10000000-0000-4000-8000-000000000001";

  test("use_scope=true → scope (regardless of preset)", () => {
    expect(
      selectTaskEnvelopeMode(makeTask({ useScope: true, preset: "in_scope" })),
    ).toBe("scope");
    // use_scope wins even if preset says private.
    expect(
      selectTaskEnvelopeMode(
        makeTask({ useScope: true, preset: "in_private_namespace" }),
      ),
    ).toBe("scope");
  });

  test("preset=in_private_namespace (requester-only) → wide", () => {
    expect(
      selectTaskEnvelopeMode(
        makeTask({
          useScope: false,
          preset: "in_private_namespace",
          targetUserIds: [OWNER],
        }),
      ),
    ).toBe("wide");
  });

  test("preset=in_background (requester-only) → namespace, NOT wide (S3 regression)", () => {
    expect(
      selectTaskEnvelopeMode(
        makeTask({
          useScope: false,
          preset: "in_background",
          targetUserIds: [OWNER],
        }),
      ),
    ).toBe("namespace");
  });

  test("generic task (preset=task, requester-only) → namespace", () => {
    expect(
      selectTaskEnvelopeMode(
        makeTask({ useScope: false, preset: "task", targetUserIds: [OWNER] }),
      ),
    ).toBe("namespace");
  });
});
