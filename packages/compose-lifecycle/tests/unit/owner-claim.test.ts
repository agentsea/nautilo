import { describe, expect, test } from "bun:test";

import {
  advanceComposeOwnerStage,
  prepareComposeOwnerStage,
  type ComposeOwnerClaimControlPort,
  type ComposeOwnerClaimCustodyPort,
} from "../../src/index.ts";

const identity = {
  profileName: "m269-test",
  instanceId: "m269-test",
  controlFingerprint: "safe-fingerprint",
  mode: "claim" as const,
};

function custody(secret: string, calls: string[]): ComposeOwnerClaimCustodyPort {
  return {
    getOrCreate: async () => { calls.push("get"); return secret; },
    rotate: async () => { calls.push("rotate"); return secret; },
    clear: async () => { calls.push("clear"); },
  };
}

describe("resumable owner stage", () => {
  test("prepared checkpoint is serializable and contains no claim", async () => {
    const canary = "owner-claim-secret-canary";
    const stage = await prepareComposeOwnerStage({
      identity,
      custody: custody(canary, []),
    });

    expect(JSON.parse(JSON.stringify(stage))).toEqual(stage);
    expect(JSON.stringify(stage)).not.toContain(canary);
  });

  test("resume observes before rotating and retries the identical install", async () => {
    const calls: string[] = [];
    const installs: Array<{ claimHash: string; expiresAt: string }> = [];
    let observations = 0;
    const control: ComposeOwnerClaimControlPort = {
      observe: async () => {
        calls.push("observe");
        observations += 1;
        return { state: observations === 1 ? "awaiting-owner" : "claim-active" };
      },
      install: async (request) => {
        calls.push("install");
        installs.push(request);
        if (installs.length === 1) throw new Error("lost response");
        return { state: "claim-active" };
      },
    };
    const stage = { schemaVersion: 1 as const, identity };

    expect(await advanceComposeOwnerStage({
      stage,
      resume: true,
      custody: custody("same-secret", calls),
      control,
      now: () => 0,
    })).toEqual({ outcome: "claim-active" });
    expect(calls).toEqual(["observe", "rotate", "install", "observe", "install"]);
    expect(installs).toHaveLength(2);
    expect(installs[0]).toEqual(installs[1]);
  });

  test("owner-bound observation clears stale custody without minting", async () => {
    const calls: string[] = [];
    const result = await advanceComposeOwnerStage({
      stage: { schemaVersion: 1, identity },
      resume: true,
      custody: custody("unused", calls),
      control: {
        observe: async () => { calls.push("observe"); return { state: "owner-bound" }; },
        install: async () => { throw new Error("not reached"); },
      },
    });

    expect(result).toEqual({ outcome: "owner-bound" });
    expect(calls).toEqual(["observe", "clear"]);
  });
});
