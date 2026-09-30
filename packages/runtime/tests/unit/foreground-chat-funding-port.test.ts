import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createAcceptedInvocationAuthority } from "@nautilo/trust";
import type { ForegroundChatFundingSession } from "@nautilo/agent";
import {
  ForegroundChatFundingAuthorityError,
  ForegroundChatFundingUnsupportedWorkloadError,
  assertForegroundChatFundingWorkloadSupported,
  installForegroundChatFundingPort,
  openForegroundChatFundingSessionForInvocation,
  uninstallForegroundChatFundingPort,
} from "../../src/foreground-chat-funding-port";

const personalSession: ForegroundChatFundingSession = {
  kind: "personal",
  runAttempt: async (_modelId, callback) => callback({
    usageFunding: {
      kind: "personal",
      humanUserId: "human-1",
      payerHumanId: "human-1",
      providerRoute: "openai",
      credentialId: "credential-1",
      credentialRevision: 1,
    },
  }),
  recheckAttempt: async () => {},
};

const baseJobInput = {
  requestorId: "human-1",
  causalHumanUserId: "human-1",
};

afterEach(() => uninstallForegroundChatFundingPort());

describe("foreground chat funding port", () => {
  test.each(["foreground.main", "foreground.fork"] as const)(
    "opens %s from the accepted Human authority",
    async (entrypoint) => {
      const opened: unknown[] = [];
      installForegroundChatFundingPort({
        openSession: async (input) => {
          opened.push(input);
          return personalSession;
        },
      });

      const result = await openForegroundChatFundingSessionForInvocation({
        authority: createAcceptedInvocationAuthority("human-1"),
        jobInput: baseJobInput,
        causalHumanUserId: "human-1",
        entrypoint,
        modelId: "openai:test-model",
        roomId: "room-1",
        agentId: "agent-1",
      });

      expect(result).toBe(personalSession);
      expect(opened).toEqual([{
        humanUserId: "human-1",
        modelId: "openai:test-model",
        roomId: "room-1",
        agentId: "agent-1",
        entrypoint,
      }]);
    },
  );

  test.each([
    { label: "requestor spoof", jobInput: { ...baseJobInput, requestorId: "human-2" }, causalHumanUserId: "human-1" },
    { label: "causal Human spoof", jobInput: baseJobInput, causalHumanUserId: "human-2" },
  ])("refuses $label before opening the port", async ({ jobInput, causalHumanUserId }) => {
    let calls = 0;
    installForegroundChatFundingPort({
      openSession: async () => {
        calls += 1;
        return personalSession;
      },
    });

    const error = await openForegroundChatFundingSessionForInvocation({
      authority: createAcceptedInvocationAuthority("human-1"),
      jobInput,
      causalHumanUserId,
      entrypoint: "foreground.main",
      modelId: "openai:test-model",
      roomId: "room-1",
      agentId: "agent-1",
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ForegroundChatFundingAuthorityError);
    expect(calls).toBe(0);
  });

  test.each([
    { label: "missing authority", authority: undefined, entrypoint: "foreground.main" as const, jobInput: baseJobInput },
    { label: "task", authority: createAcceptedInvocationAuthority("human-1"), entrypoint: "foreground.main" as const, jobInput: { ...baseJobInput, taskRun: true } },
    { label: "subagent", authority: createAcceptedInvocationAuthority("human-1"), entrypoint: "foreground.main" as const, jobInput: { ...baseJobInput, subagentRun: true } },
    { label: "task report-back", authority: createAcceptedInvocationAuthority("human-1"), entrypoint: "foreground.main" as const, jobInput: { ...baseJobInput, metadata: { originatedBy: "task" } } },
    { label: "connected web", authority: createAcceptedInvocationAuthority("human-1"), entrypoint: "foreground.main" as const, jobInput: { ...baseJobInput, metadata: { originatedBy: "connected_web_operation" } } },
    { label: "resume or untrusted entrance", authority: createAcceptedInvocationAuthority("human-1"), entrypoint: null, jobInput: baseJobInput },
  ])("does not open a personal session for $label", async ({ authority, entrypoint, jobInput }) => {
    let calls = 0;
    installForegroundChatFundingPort({
      openSession: async () => {
        calls += 1;
        return personalSession;
      },
    });

    const result = await openForegroundChatFundingSessionForInvocation({
      authority,
      jobInput,
      causalHumanUserId: "human-1",
      entrypoint,
      modelId: "openai:test-model",
      roomId: "room-1",
      agentId: "agent-1",
    });
    expect(result).toBeNull();
    expect(calls).toBe(0);
  });

  test("personal sessions refuse image and voice work with a safe error", () => {
    for (const workload of [
      { hasImages: true, voiceRequested: false },
      { hasImages: false, voiceRequested: true },
    ]) {
      expect(() => assertForegroundChatFundingWorkloadSupported(
        personalSession,
        workload,
      )).toThrow(ForegroundChatFundingUnsupportedWorkloadError);
    }
  });

  test("funding sessions are injected only as transient graph dependencies", () => {
    for (const file of ["langgraph-executor.ts", "fork-langgraph-executor.ts"]) {
      const source = readFileSync(
        resolve(import.meta.dirname, `../../src/executors/${file}`),
        "utf8",
      );
      const graphInput = source.split("const graphInput = {")[1]?.split(
        "const protectedCheckpointSaver",
      )[0] ?? "";
      expect(graphInput).not.toContain("fundingSession");
      expect(source).toContain("foregroundChatFundingSession: fundingSession");
    }
  });
});
