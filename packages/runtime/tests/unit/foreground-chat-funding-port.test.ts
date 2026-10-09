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
  openConnectedWebOperationWakeFundingSessionForInvocation,
  openImageAssistanceForInvocation,
  uninstallForegroundChatFundingPort,
} from "../../src/foreground-chat-funding-port";
import { setTaskRunDb } from "../../src/tasks/task-runtime-context";

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

afterEach(() => {
  uninstallForegroundChatFundingPort();
  setTaskRunDb(null);
});

describe("foreground chat funding port", () => {
  test("opens a personal session for an exact durable connected-website wake only", async () => {
    const opened: unknown[] = [];
    installForegroundChatFundingPort({ openSession: async (input) => { opened.push(input); return personalSession; } });
    let durable = true;
    setTaskRunDb({
      select: () => ({ from: () => ({ where: () => ({ limit: async () => durable ? [{ id: "operation-1" }] : [] }) }) }),
    } as never);
    const jobInput = {
      ...baseJobInput,
      ownerId: "human-1",
      metadata: { originatedBy: "connected_web_operation", operationId: "operation-1", controlEpoch: 3, wakeFingerprint: "wake-fingerprint" },
    };
    expect(await openConnectedWebOperationWakeFundingSessionForInvocation({
      authority: createAcceptedInvocationAuthority("human-1"), jobInput, causalHumanUserId: "human-1",
      modelId: "openai:test-model", roomId: "room-1", agentId: "agent-1",
    })).toBe(personalSession);
    expect(opened).toEqual([expect.objectContaining({ humanUserId: "human-1", entrypoint: "foreground.main" })]);
    durable = false;
    expect(openConnectedWebOperationWakeFundingSessionForInvocation({
      authority: createAcceptedInvocationAuthority("human-1"), jobInput, causalHumanUserId: "human-1",
      modelId: "openai:test-model", roomId: "room-1", agentId: "agent-1",
    })).rejects.toBeInstanceOf(ForegroundChatFundingAuthorityError);
  });

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
        hasImages: false,
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

  test.each(["foreground.main", "foreground.fork"] as const)(
    "rechecks unsupported payloads after a policy change at %s execution", async (entrypoint) => {
      let source: "server" | "personal" = "server";
      installForegroundChatFundingPort({
        openSession: async () => ({ ...personalSession, kind: source }),
      });
      const invoke = (jobInput: Record<string, unknown>, protectedTurn = false) =>
        openForegroundChatFundingSessionForInvocation({
          authority: createAcceptedInvocationAuthority("human-1"),
          jobInput: { ...baseJobInput, ...jobInput }, causalHumanUserId: "human-1",
          entrypoint, modelId: "openai:test-model", roomId: "room-1", agentId: "agent-1",
          protectedTurn,
        });
      const shapes = [
        { voiceMode: true },
        { attachmentTextBlocks: ["text"] }, { retainedAttachmentIds: ["attachment"] },
        { artifactRefs: [{ id: "artifact" }] }, { focusedResources: [{ id: "resource" }] },
        { activeMiniApp: {} }, { liveMiniAppSession: {} },
      ];
      for (const shape of shapes) expect((await invoke(shape))?.kind).toBe("server");
      expect((await invoke({}, true))?.kind).toBe("server");
      // A dispatch projection never authorizes a later personal-paid shape.
      source = "personal";
      for (const shape of shapes) {
        expect(invoke(shape)).rejects.toBeInstanceOf(ForegroundChatFundingUnsupportedWorkloadError);
      }
      expect(invoke({}, true)).rejects.toBeInstanceOf(ForegroundChatFundingUnsupportedWorkloadError);
      expect((await invoke({ attachmentTextBlocks: [], artifactRefs: [], activeMiniApp: null }))?.kind).toBe("personal");
    },
  );

  test("personal sessions admit images but refuse unrelated voice work", () => {
    expect(() => assertForegroundChatFundingWorkloadSupported(personalSession, { hasImages: true, voiceRequested: false })).not.toThrow();
    for (const workload of [
      { hasImages: false, voiceRequested: true },
    ]) {
      expect(() => assertForegroundChatFundingWorkloadSupported(
        personalSession,
        workload,
      )).toThrow(ForegroundChatFundingUnsupportedWorkloadError);
    }
  });

  test.each(["foreground.main", "foreground.fork"] as const)("image assistance uses accepted %s authority and pinned funding", async (entrypoint) => {
    const opened: unknown[] = [];
    installForegroundChatFundingPort({ openSession: async () => personalSession,
      openImageAssistance: async (input) => { opened.push(input); return { modelId: "vision-a", fundingSession: personalSession }; } });
    const input = { authority: createAcceptedInvocationAuthority("human-1"), jobInput: baseJobInput,
      causalHumanUserId: "human-1", entrypoint, modelId: "text-a", roomId: "room-1", agentId: "agent-1", fundingKind: "personal" as const };
    expect((await openImageAssistanceForInvocation(input))?.modelId).toBe("vision-a");
    expect(opened[0]).toMatchObject({ humanUserId: "human-1", fundingKind: "personal", entrypoint });
    expect(openImageAssistanceForInvocation({ ...input, causalHumanUserId: "other" })).rejects.toBeInstanceOf(ForegroundChatFundingAuthorityError);
    expect(opened).toHaveLength(1);
    expect(await openImageAssistanceForInvocation({ ...input, authority: undefined })).toBeNull();
  });

  test("image-linked retained resources are supported without admitting other files", async () => {
    installForegroundChatFundingPort({ openSession: async () => personalSession });
    const input = { authority: createAcceptedInvocationAuthority("human-1"),
      jobInput: { ...baseJobInput, multimodalImages: [{ attachmentId: "image-a" }], retainedAttachmentIds: ["image-a"],
        focusedResources: [{ kind: "message-attachment", displayName: "chart.png", location: "server", lifetime: "message", capabilities: ["read"], locator: { attachmentId: "image-a" } }] },
      causalHumanUserId: "human-1", entrypoint: "foreground.main" as const, modelId: "text-a", roomId: "room-1", agentId: "agent-1" };
    expect((await openForegroundChatFundingSessionForInvocation(input))?.kind).toBe("personal");
    expect(openForegroundChatFundingSessionForInvocation({ ...input, jobInput: { ...input.jobInput, focusedResources: [{ kind: "local-file", locator: { attachmentId: "image-a" } }] } })).rejects.toBeInstanceOf(ForegroundChatFundingUnsupportedWorkloadError);
    expect(openForegroundChatFundingSessionForInvocation({ ...input, jobInput: { ...input.jobInput, retainedAttachmentIds: ["other-file"] } })).rejects.toBeInstanceOf(ForegroundChatFundingUnsupportedWorkloadError);
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
      expect(graphInput.split("  };", 1)[0]).not.toContain("fundingSession");
      expect(source).toContain("foregroundChatFundingSession: fundingSession");
    }
  });
});
