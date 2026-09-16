import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

import {
  EncryptedCheckpointSaver,
} from "@nautilo/agent";

import type { ActiveConversationRepository } from "../../src/conversation/active-conversation-repository";
import {
  checkpointSaverForConversationExecution,
  type ConversationExecutionServices,
  type ProtectedCheckpointInvocation,
  type ProtectedConversationExecutionServices,
} from "../../src/conversation/conversation-execution-services";
import {
  createProtectedTestShadowConversationComposition,
  resolveConversationExecutionServices,
} from "../../src/conversation/conversation-composition";
import { createProtectedTestShadowAuthorityForTests } from "../../src/conversation/testing/protected-test-shadow-authority";
import { createDormantEncryptedCheckpointSaverForTests } from "./support/encrypted-checkpoint-saver";

function repository(label: string): ActiveConversationRepository {
  return Object.freeze({
    label,
    allocateHumanAppend: async () =>
      Object.freeze({ status: "conflict" as const }),
    allocateHumanEdit: async () =>
      Object.freeze({ status: "conflict" as const }),
    completeHumanRevision: async () =>
      Object.freeze({
        status: "orphaned" as const,
        reason: "stale_mapping" as const,
        messageId: 1,
        revision: 0,
        cryptoObjectId: "message:test",
      }),
    appendPreparedAgent: async () =>
      Object.freeze({ status: "committed" as const }),
    hardDelete: async () => Object.freeze({
      status: "committed" as const,
      disposition: "deleted" as const,
      effects: Object.freeze({
        roomId: "room:test",
        wasUnread: false,
        orphanedTurnId: null,
        rootSummary: null,
      }),
    }),
    readHumanMessages: async () =>
      Object.freeze({ status: "available" as const, messages: [] }),
    withAgentTranscript: async <Value>(
      input: Parameters<ActiveConversationRepository["withAgentTranscript"]>[0],
    ) => Object.freeze({
      status: "executed" as const,
      value: await input.execute([]) as Value,
    }),
  } as ActiveConversationRepository & { readonly label: string });
}

function protectedServices(
  saver: EncryptedCheckpointSaver,
  invocations?: ProtectedCheckpointInvocation[],
): ProtectedConversationExecutionServices {
  const authorization = Object.freeze({}) as never;
  return Object.freeze({
    authorization,
    repository: repository("protected"),
    checkpointSavers: Object.freeze({
      createForInvocation: (invocation: ProtectedCheckpointInvocation) => {
        invocations?.push(invocation);
        return saver;
      },
    }),
    protectedAgentMessagePreparer: Object.freeze({
      prepare: async () => Object.freeze({
        status: "unavailable" as const,
        reason: "signing_capability_unavailable" as const,
      }),
    }),
  });
}

describe("conversation checkpoint composition", () => {
  test("foreground, invocation-bound fork, and Human resume select the exact invocation-bound encrypted saver", () => {
    const saver = createDormantEncryptedCheckpointSaverForTests();
    const invocations: ProtectedCheckpointInvocation[] = [];
    const protectedExecution = protectedServices(saver, invocations);
    const legacyServices: ConversationExecutionServices = Object.freeze({
      repository: repository("legacy"),
    });
    const composition = createProtectedTestShadowConversationComposition({
      authority: createProtectedTestShadowAuthorityForTests(),
      namespaceId: "namespace-test-shadow",
      legacyServices,
      protectedServices: protectedExecution,
    });

    const origins = [
      { entrypointId: "foreground.main" },
      { entrypointId: "foreground.fork" },
      { entrypointId: "subagent.scope", mode: "invocation_bound" },
      { entrypointId: "resume.approval" },
      { entrypointId: "resume.approval_ask" },
      { entrypointId: "resume.identity" },
    ] as const;

    for (const origin of origins) {
      const selection = resolveConversationExecutionServices({
        defaultLegacyServices: legacyServices,
        composition,
        origin,
        resolvedNamespaceId: "namespace-test-shadow",
      });
      expect(selection.mode).toBe("protected_test_shadow");
      if (selection.mode !== "protected_test_shadow") {
        throw new Error("expected protected execution selection");
      }
      expect(
        checkpointSaverForConversationExecution(selection.services, {
          logicalThreadId: "room:room-1:bot:agent-1",
          kind: origin.entrypointId,
          authorization: protectedExecution.authorization,
        }),
      ).toBe(saver);
    }
    expect(invocations).toEqual(origins.map((origin) => ({
      logicalThreadId: "room:room-1:bot:agent-1",
      kind: origin.entrypointId,
      authorization: protectedExecution.authorization,
    })));
  });

  test("legacy execution constructs its existing saver lazily while an invalid protected call fails closed", () => {
    const legacySaver = Object.freeze({ kind: "legacy" });
    let legacyFactoryCalls = 0;
    const selected = checkpointSaverForConversationExecution(
      undefined,
      undefined,
      () => {
        legacyFactoryCalls += 1;
        return legacySaver as never;
      },
    );

    expect(selected as unknown).toBe(legacySaver);
    expect(legacyFactoryCalls).toBe(1);
    expect(() =>
      checkpointSaverForConversationExecution({
        repository: repository("forged-protected"),
        protectedAgentMessagePreparer: {
          prepare: async () => ({
            status: "unavailable",
            reason: "signing_capability_unavailable",
          }),
        },
      } as never, {
        logicalThreadId: "room:room-1:bot:agent-1",
        kind: "foreground.main",
        authorization: Object.freeze({}) as never,
      }, () => {
        throw new Error("must not fall back to plaintext");
      })
    ).toThrow("encrypted checkpoint saver");
  });

  test("both foreground executors select through the invocation boundary instead of constructing the global saver", () => {
    for (const relativePath of [
      "../../src/executors/langgraph-executor.ts",
      "../../src/executors/fork-langgraph-executor.ts",
    ]) {
      const source = readFileSync(
        new URL(relativePath, import.meta.url),
        "utf8",
      );
      expect(source).toContain("checkpointSaverForConversationExecution(");
      expect(source).not.toContain(
        "const checkpointSaver = createCheckpointSaver();",
      );
      expect(source).toContain("disposeProtectedCheckpointSaver({");
      expect(source).not.toContain("await checkpointSaver.end();");
    }
  });
});
