import { describe, expect, test } from "bun:test";
import { buildAppliedAuthContract } from "../applied-auth-contract.ts";
import { classifyAuthPlan } from "../auth-plan.ts";
import { buildAuthContract } from "../auth.ts";

describe("auth plan contract classifier", () => {
  const incoming = buildAuthContract();
  const applied = buildAppliedAuthContract(
    "2026-07-12T12:00:00.000Z",
    incoming,
  );

  test("requires an inspected matching running image before compatible", () => {
    expect(classifyAuthPlan({ incoming, applied }).classification).toBe("unknown");
    expect(
      classifyAuthPlan({
        incoming,
        applied,
        liveLogtoEngineImage: incoming.logtoEngine.image,
      }).classification,
    ).toBe("compatible");
  });

  test("rejects a mismatched or too-old running Logto image", () => {
    expect(
      classifyAuthPlan({
        incoming,
        applied,
        liveLogtoEngineImage: "ghcr.io/logto-io/logto:1.39.0",
      }).classification,
    ).toBe("incompatible");
    expect(
      classifyAuthPlan({
        incoming,
        applied,
        liveLogtoEngineImage: "ghcr.io/logto-io/logto:1.37.0",
      }).classification,
    ).toBe("incompatible");
  });
});
