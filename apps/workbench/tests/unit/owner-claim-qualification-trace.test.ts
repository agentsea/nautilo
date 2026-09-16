import { afterEach, describe, expect, test } from "bun:test";
import type { OwnerClaimCoordinatorTraceEvent } from "../../src/lib/owner-claim-coordinator";
import {
  OWNER_CLAIM_QUALIFICATION_EVENT_SINK_GLOBAL,
  ownerClaimQualificationEventSink,
} from "../../src/lib/owner-claim-qualification-trace";

const event: OwnerClaimCoordinatorTraceEvent = {
  operationId: 1 as OwnerClaimCoordinatorTraceEvent["operationId"],
  phase: "previewing",
  commandKind: "preview-claim",
  result: "started",
  navigationIntent: null,
};

afterEach(() => {
  delete globalThis.__NAUTILO_D508_OWNER_CLAIM_EVENT_SINK__;
});

describe("D508 owner-claim qualification trace seam", () => {
  test("is a production no-op without the pre-bootstrap global", () => {
    expect(globalThis[OWNER_CLAIM_QUALIFICATION_EVENT_SINK_GLOBAL]).toBeUndefined();
    expect(() => ownerClaimQualificationEventSink()(event)).not.toThrow();
  });

  test("delivers only a frozen exact redacted event to the injected callback", () => {
    const observed: unknown[] = [];
    globalThis.__NAUTILO_D508_OWNER_CLAIM_EVENT_SINK__ = (value) => observed.push(value);
    ownerClaimQualificationEventSink()(event);

    expect(observed).toEqual([event]);
    expect(Object.keys(observed[0] as object).sort()).toEqual([
      "commandKind",
      "navigationIntent",
      "operationId",
      "phase",
      "result",
    ]);
    expect(Object.isFrozen(observed[0])).toBe(true);
    expect(JSON.stringify(observed)).not.toContain("test-raw-claim");
    expect(JSON.stringify(observed)).not.toContain("test-profile-pin");
  });

  test("isolates a qualification callback failure from the coordinator", () => {
    globalThis.__NAUTILO_D508_OWNER_CLAIM_EVENT_SINK__ = () => { throw new Error("harness failure"); };
    expect(() => ownerClaimQualificationEventSink()(event)).not.toThrow();
  });

  test("keeps the global callback structurally incapable of receiving authority values", async () => {
    const source = await Bun.file(new URL("../../src/lib/owner-claim-qualification-trace.ts", import.meta.url)).text();
    expect(source).toContain(OWNER_CLAIM_QUALIFICATION_EVENT_SINK_GLOBAL);
    expect(source).toMatch(/operationId:[\s\S]*phase:[\s\S]*commandKind:[\s\S]*result:[\s\S]*navigationIntent:/);
    expect(source).not.toMatch(/\b(?:claim|prepared|bearer|password|pin|recovery)\s*:/i);
    expect(source).not.toMatch(/from\s+[^\n]*(?:react|api-client|use-auth|owner-claim-handoff)/);
  });
});
