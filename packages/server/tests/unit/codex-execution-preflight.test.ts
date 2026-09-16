import { describe, expect, test } from "bun:test";
import type { CodexHostStatus } from "@nautilo/relay";
import { CodexAdminControlFailure } from "../../src/codex/admin-control-plane";
import {
  CodexExecutionPreflight,
  type CodexExecutionProfileFacts,
} from "../../src/codex/execution-preflight";

const profile: CodexExecutionProfileFacts = {
  userId: "owner-1",
  relayId: "relay-1",
  profileHandle: "profile-1",
  profileGeneration: 2,
  accountGeneration: 4,
};

function readyStatus(): CodexHostStatus {
  return {
    state: "ready",
    compatibility: "certified",
    features: {
      stableConversation: true,
      explicitSteer: true,
      codexApprovals: true,
      requestUserInput: true,
    },
    runtimeGeneration: 7,
    runtime: { state: "ready" },
    workspace: { state: "unavailable" },
  };
}

function fixture(input: {
  status?: CodexHostStatus | null;
  inspected?: {
    kind: "runtime_status";
    state: "absent" | "installing" | "ready" | "incompatible" | "draining" | "failed";
    runtimeGeneration?: number;
  };
  account?: {
    kind: "account_status";
    state: "signed_in" | "signed_out" | "reauth_required";
    accountGeneration: number;
  };
} = {}) {
  const calls: string[] = [];
  const service = new CodexExecutionPreflight({
    readHostStatus: (userId, relayId) => {
      calls.push(`status:${userId}:${relayId}`);
      return input.status === undefined ? readyStatus() : input.status;
    },
    control: {
      inspectRuntime: async (host) => {
        calls.push(`inspect:${host.userId}:${host.relayId}`);
        return input.inspected ?? {
          kind: "runtime_status",
          state: "ready",
          runtimeGeneration: 9,
        };
      },
      activateRuntime: async (host) => {
        calls.push(`activate:${host.runtimeGeneration}`);
        return {
          kind: "runtime_status",
          state: "ready",
          runtimeGeneration: host.runtimeGeneration,
        };
      },
      readAccount: async (facts) => {
        calls.push(`account:${facts.profileHandle}`);
        return input.account ?? {
          kind: "account_status",
          state: "signed_in",
          accountGeneration: profile.accountGeneration,
        };
      },
    },
  });
  return { calls, service };
}

async function failure(operation: Promise<unknown>) {
  try {
    await operation;
    throw new Error("expected failure");
  } catch (error) {
    return error;
  }
}

describe("CodexExecutionPreflight", () => {
  test("uses account rehydration directly when the exact host already selected a runtime", async () => {
    const fx = fixture();
    await fx.service.prepare(profile);
    expect(fx.calls).toEqual([
      "status:owner-1:relay-1",
      "account:profile-1",
    ]);
  });

  test("inspects and activates a fresh controller before account rehydration", async () => {
    const fx = fixture({
      status: {
        state: "runtime_unavailable",
        runtime: { state: "absent" },
        workspace: { state: "unavailable" },
      },
    });
    await fx.service.prepare(profile);
    expect(fx.calls).toEqual([
      "status:owner-1:relay-1",
      "inspect:owner-1:relay-1",
      "activate:9",
      "account:profile-1",
    ]);
  });

  test("fails closed for an unusable runtime or a changed account generation", async () => {
    const absent = fixture({
      status: null,
      inspected: { kind: "runtime_status", state: "absent" },
    });
    expect(await failure(absent.service.prepare(profile))).toMatchObject({
      code: "CODEX_STALE",
    } satisfies Partial<CodexAdminControlFailure>);
    expect(absent.calls).not.toContain("account:profile-1");

    const changed = fixture({
      account: {
        kind: "account_status",
        state: "signed_in",
        accountGeneration: 5,
      },
    });
    expect(await failure(changed.service.prepare(profile))).toMatchObject({
      code: "CODEX_STALE",
    } satisfies Partial<CodexAdminControlFailure>);
  });
});
