import { expect, test } from "bun:test";
import { DurableSleepOrganizationUnavailableError, type DurableSleepClaim } from "@nautilo/reflection/durable";
import { createReflectionOrganizationAttemptOpener } from "../../src/reflection/organization-attempt";
import type { BackgroundAttemptObservation } from "../../src/background-processing/attempt";

const claim: DurableSleepClaim = {
  logicalObjectRef: "record", recordRef: "record", generation: 3,
  stage: "organization", changeReason: "dependency_lost", leaseToken: "lease",
};

test("expired claim never opens access and reports unavailable claim coordinates", async () => {
  let opened = false;
  const observations: BackgroundAttemptObservation[] = [];
  const open = createReflectionOrganizationAttemptOpener({
    checkAvailable: async () => true,
    assertClaimCurrent: async () => false,
    openAccess: async () => { opened = true; throw new Error("must not open"); },
    observe: (value) => { observations.push(value); },
  });
  expect(await open(claim).catch((error: unknown) => error)).toBeInstanceOf(DurableSleepOrganizationUnavailableError);
  expect(opened).toBe(false);
  expect(observations).toHaveLength(1);
  expect(observations[0]).toMatchObject({ family: "reflection", stage: "dependency_rewrite", workId: "sleep:record:3", attemptId: "lease", outcome: "unavailable" });
});

test("claim revalidation prevents publication and releases the acquired access exactly once", async () => {
  let current = true;
  let closed = 0;
  let published = false;
  const open = createReflectionOrganizationAttemptOpener({
    checkAvailable: async () => true,
    assertClaimCurrent: async () => current,
    openAccess: async () => ({ assertCurrent: async () => {}, close: async () => { closed++; } }),
  });
  const attempt = await open(claim);
  current = false;
  expect(await attempt.publish(async () => { published = true; }).catch((error: unknown) => error)).toBeInstanceOf(DurableSleepOrganizationUnavailableError);
  await attempt.close("unavailable");
  await attempt.close("completed");
  expect(published).toBe(false);
  expect(closed).toBe(1);
});

test("consumed claim after an entered canonical commit preserves its result", async () => {
  let current = true;
  const open = createReflectionOrganizationAttemptOpener({ checkAvailable: async () => true, assertClaimCurrent: async () => current });
  const attempt = await open(claim);
  expect(await attempt.publish(async () => { current = false; return "committed"; })).toBe("committed");
  await attempt.close("completed");
  expect(await attempt.publish(async () => "late").catch((error: unknown) => error)).toBeInstanceOf(Error);
});
