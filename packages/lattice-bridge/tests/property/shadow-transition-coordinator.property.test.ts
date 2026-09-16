import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  createShadowTransitionCoordinator,
  type ShadowTransitionCandidate,
  type ShadowTransitionTask,
} from "../../src/index.ts";

type Returned = Readonly<{ id: number; complete: boolean }>;

function candidate(item: Returned): ShadowTransitionCandidate<Returned> {
  return {
    family: "memory",
    operation: "read_repair",
    productRevision: item.id,
    audienceFingerprint: new Uint8Array(32).fill(item.id & 0xff),
    audienceMappingInvalidated: false,
    opaque: item,
  };
}

describe("shadow transition coordinator properties", () => {
  test("plaintext policy never evaluates a shadow selector", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.boolean(), { maxLength: 64 }),
      async (values) => {
        let selected = false;
        let scheduled = false;
        const coordinator = createShadowTransitionCoordinator({
          policy: { mode: "plaintext_only" },
          schedule: () => {
            scheduled = true;
          },
          observe: () => undefined,
        });
        const returned = values.map((complete, id) => ({ id, complete }));
        expect(await coordinator.runOrdinaryReadRepair({
          family: "memory",
          ordinaryBound: returned.length,
          ordinary: () => Promise.resolve(returned),
          selectCompleteCandidates: () => {
            selected = true;
            return [];
          },
          verifyCurrent: () => Promise.resolve("current"),
          publishExisting: () => Promise.resolve("verified"),
        })).toBe(returned);
        expect({ selected, scheduled }).toEqual({
          selected: false,
          scheduled: false,
        });
      },
    ), { numRuns: 100 });
  });

  test("read repair publishes each complete already-returned object once", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.boolean(), { maxLength: 64 }),
      async (values) => {
        const tasks: ShadowTransitionTask[] = [];
        const published: number[] = [];
        const coordinator = createShadowTransitionCoordinator({
          policy: { mode: "shadow_encryption" },
          schedule: (task) => tasks.push(task),
          observe: () => undefined,
        });
        const returned = values.map((complete, id) => ({ id, complete }));
        expect(await coordinator.runOrdinaryReadRepair({
          family: "memory",
          ordinaryBound: returned.length,
          ordinary: () => Promise.resolve(returned),
          selectCompleteCandidates: (items) => items
            .filter((item) => item.complete)
            .map(candidate),
          verifyCurrent: () => Promise.resolve("current"),
          publishExisting: (selected) => {
            published.push(selected.opaque.id);
            return Promise.resolve("verified");
          },
        })).toBe(returned);
        expect(published).toEqual([]);
        expect(tasks).toHaveLength(1);
        await tasks[0]!();
        expect(published).toEqual(returned
          .filter((item) => item.complete)
          .map((item) => item.id));
      },
    ), { numRuns: 100 });
  });
});
