import { describe, test, expect } from "bun:test";
import type { DirectDatabase } from "@nautilo/db";
import {
  computeNextFireAt,
  createTask,
  type TaskCreateInput,
} from "../../src/tasks/create-task";
import { nextCronOccurrence } from "../../src/tasks/cron";
import { createAcceptedInvocationAuthority } from "@nautilo/trust";
import {
  createHumanApiTaskCreationProvenance,
  getPlaintextTaskCreationAdmission,
} from "../../src/tasks/task-creation-admission";

function fakeDb(): { db: DirectDatabase; lastValues: () => Record<string, unknown> } {
  let captured: Record<string, unknown> = {};
  const db = {
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        captured = v;
        return {
          returning: async () => [{ id: "task-1", ...v }],
        };
      },
    }),
  } as unknown as DirectDatabase;
  return { db, lastValues: () => captured };
}

const baseInput = (over: Partial<TaskCreateInput> = {}): TaskCreateInput =>
  ({
    ownerId: "11111111-1111-1111-1111-111111111111",
    requestorId: "11111111-1111-1111-1111-111111111111",
    agentId: "22222222-2222-2222-2222-222222222222",
    prompt: "do the thing",
    scheduleKind: "now",
    timezone: "UTC",
    depth: 0,
    ...over,
  }) as TaskCreateInput;

const accepted = () =>
  createAcceptedInvocationAuthority("11111111-1111-1111-1111-111111111111");

const taskDeps = (db: DirectDatabase) => ({
  db,
  observer: { kick: () => {} },
  invocationAuthority: accepted(),
  provenance: createHumanApiTaskCreationProvenance({
    ownerId: "11111111-1111-1111-1111-111111111111",
  }),
  admission: getPlaintextTaskCreationAdmission(),
});

describe("computeNextFireAt (M146)", () => {
  const fixedNow = new Date("2026-06-09T12:00:00Z");

  test("now → returns the provided now", () => {
    const result = computeNextFireAt("now", undefined, undefined, "UTC", fixedNow);
    expect(result).toBe(fixedNow);
  });

  test("one_shot → returns runAt", () => {
    const runAt = new Date("2030-01-01T00:00:00Z");
    const result = computeNextFireAt("one_shot", runAt, undefined, "UTC", fixedNow);
    expect(result).toBe(runAt);
  });

  test("one_shot throws when runAt missing", () => {
    expect(() =>
      computeNextFireAt("one_shot", undefined, undefined, "UTC", fixedNow),
    ).toThrow(/requires runAt/);
  });

  test("cron → matches nextCronOccurrence", () => {
    const cron = "0 9 * * *";
    const tz = "UTC";
    const expected = nextCronOccurrence(cron, tz, fixedNow);
    const result = computeNextFireAt("cron", undefined, cron, tz, fixedNow);
    expect(result).toEqual(expected);
  });

  test("cron throws when cron missing", () => {
    expect(() =>
      computeNextFireAt("cron", undefined, undefined, "UTC", fixedNow),
    ).toThrow(/requires a cron/);
  });

  test("parity: createTask nextFireAt matches computeNextFireAt — one_shot", async () => {
    const { db } = fakeDb();
    const runAt = new Date("2030-06-15T14:30:00Z");
    const res = await createTask(
      taskDeps(db),
      baseInput({ scheduleKind: "one_shot", runAt }),
    );
    const expected = computeNextFireAt("one_shot", runAt, undefined, "UTC");
    expect(res.nextFireAt).toEqual(expected);
  });

  test("parity: createTask nextFireAt matches computeNextFireAt — cron", async () => {
    const { db } = fakeDb();
    const cron = "0 9 * * *";
    const tz = "UTC";
    const res = await createTask(
      taskDeps(db),
      baseInput({ scheduleKind: "cron", cron, timezone: tz }),
    );
    const expected = computeNextFireAt("cron", undefined, cron, tz);
    expect(res.nextFireAt).toEqual(expected);
  });
});
