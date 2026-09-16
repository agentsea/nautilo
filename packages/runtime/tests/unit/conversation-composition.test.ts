import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

import type { ActiveConversationRepository } from "../../src/conversation/active-conversation-repository";
import type {
  ConversationExecutionServices,
  ProtectedConversationExecutionServices,
} from "../../src/conversation/conversation-execution-services";
import {
  createLegacyConversationComposition,
  createProtectedTestShadowConversationComposition,
  resolveConversationExecutionServices,
} from "../../src/conversation/conversation-composition";
import { createProtectedTestShadowAuthorityForTests } from "../../src/conversation/testing/protected-test-shadow-authority";
import { createDormantEncryptedCheckpointSaverForTests } from "./support/encrypted-checkpoint-saver";

function services(label: string): ConversationExecutionServices {
  const repository = Object.freeze({
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
  }) satisfies ActiveConversationRepository & { readonly label: string };
  return Object.freeze({ repository });
}

function createProtectedServices(
  label: string,
): ProtectedConversationExecutionServices {
  return Object.freeze({
    ...services(label),
    authorization: Object.freeze({}) as never,
    checkpointSavers: Object.freeze({
      createForInvocation: ({ logicalThreadId }: {
        readonly logicalThreadId: string;
      }) => createDormantEncryptedCheckpointSaverForTests(logicalThreadId),
    }),
    protectedAgentMessagePreparer: Object.freeze({
      prepare: async () => Object.freeze({
        status: "unavailable" as const,
        reason: "signing_capability_unavailable" as const,
      }),
    }),
  });
}

describe("conversation composition", () => {
  test("omitted and explicit legacy composition preserve the exact legacy services", () => {
    const legacy = services("legacy");

    const omitted = resolveConversationExecutionServices({
      defaultLegacyServices: legacy,
      origin: { entrypointId: "foreground.main" },
      resolvedNamespaceId: null,
    });
    const explicit = resolveConversationExecutionServices({
      defaultLegacyServices: services("unused-default"),
      composition: createLegacyConversationComposition(legacy),
      origin: { entrypointId: "foreground.main" },
      resolvedNamespaceId: "namespace-any",
    });

    expect(omitted).toEqual({
      mode: "legacy",
      reason: "default_legacy",
      services: legacy,
    });
    expect(omitted.services).toBe(legacy);
    expect(explicit).toEqual({
      mode: "legacy",
      reason: "legacy_composition",
      services: legacy,
    });
    expect(explicit.services).toBe(legacy);
  });

  test("protected test shadow is selected only for Wave 9 active foreground paths", () => {
    const legacy = services("legacy");
    const protectedShadow = createProtectedServices("protected");
    const composition = createProtectedTestShadowConversationComposition({
      authority: createProtectedTestShadowAuthorityForTests(),
      namespaceId: "namespace-test-shadow",
      legacyServices: legacy,
      protectedServices: protectedShadow,
    });

    const activeOrigins = [
      { entrypointId: "foreground.main" },
      { entrypointId: "foreground.fork" },
      { entrypointId: "resume.approval" },
      { entrypointId: "resume.approval_ask" },
      { entrypointId: "resume.identity" },
      {
        entrypointId: "resume.await_reply",
        mode: "foreground_session",
      },
      {
        entrypointId: "compaction.model",
        mode: "invocation_bound",
      },
      {
        entrypointId: "subagent.scope",
        mode: "invocation_bound",
      },
    ] as const;

    for (const origin of activeOrigins) {
      const selected = resolveConversationExecutionServices({
        defaultLegacyServices: services("unused-default"),
        composition,
        origin,
        resolvedNamespaceId: "namespace-test-shadow",
      });
      expect(selected.mode).toBe("protected_test_shadow");
      expect(selected.reason).toBe("protected_active");
      expect(selected.services).toBe(protectedShadow);
    }
  });

  test("task, background, deferred resume, and task-backed subagent paths cannot inherit protected foreground services", () => {
    const legacy = services("legacy");
    const protectedShadow = createProtectedServices("protected");
    const composition = createProtectedTestShadowConversationComposition({
      authority: createProtectedTestShadowAuthorityForTests(),
      namespaceId: "namespace-test-shadow",
      legacyServices: legacy,
      protectedServices: protectedShadow,
    });

    const deferredOrigins = [
      { entrypointId: "resume.await_reply", mode: "task" },
      { entrypointId: "task.dispatch" },
      { entrypointId: "task.execute" },
      { entrypointId: "task.approval_resume" },
      { entrypointId: "compaction.model", mode: "background" },
      { entrypointId: "stenographer.extraction" },
      { entrypointId: "stenographer.compaction" },
      { entrypointId: "memory.review" },
      { entrypointId: "memory.exit_flush" },
      { entrypointId: "artifact.read" },
      { entrypointId: "artifact.write" },
      { entrypointId: "background.job" },
      { entrypointId: "subagent.scope", mode: "task" },
    ] as const;

    for (const origin of deferredOrigins) {
      const selected = resolveConversationExecutionServices({
        defaultLegacyServices: services("unused-default"),
        composition,
        origin,
        resolvedNamespaceId: "namespace-test-shadow",
      });
      expect(selected.mode).toBe("legacy");
      expect(selected.reason).toBe("protected_boundary_fallback");
      expect(selected.services).toBe(legacy);
      expect(selected.services).not.toBe(protectedShadow);
    }
  });

  test("protected construction rejects forged authority and composition values", () => {
    const legacy = services("legacy");
    const protectedShadow = createProtectedServices("protected");
    const authority = createProtectedTestShadowAuthorityForTests();

    expect(() =>
      createProtectedTestShadowConversationComposition({
        authority: Object.freeze({}) as never,
        namespaceId: "namespace-test-shadow",
        legacyServices: legacy,
        protectedServices: protectedShadow,
      })
    ).toThrow("test authority");

    expect(() =>
      createProtectedTestShadowConversationComposition({
        authority,
        namespaceId: "namespace-test-shadow",
        legacyServices: legacy,
        protectedServices: services("missing-authorized-writer") as never,
      })
    ).toThrow("authorized Agent message preparer");

    expect(() =>
      resolveConversationExecutionServices({
        defaultLegacyServices: legacy,
        composition: Object.freeze({
          mode: "protected_test_shadow",
          namespaceId: "namespace-test-shadow",
          legacyServices: legacy,
          protectedServices: protectedShadow,
        }) as never,
        origin: { entrypointId: "foreground.main" },
        resolvedNamespaceId: "namespace-test-shadow",
      })
    ).toThrow("recognized conversation composition");
  });

  test("an active request falls back to legacy unless its Room resolves to the one selected test Namespace", () => {
    const legacy = services("legacy");
    const protectedShadow = createProtectedServices("protected");
    const composition = createProtectedTestShadowConversationComposition({
      authority: createProtectedTestShadowAuthorityForTests(),
      namespaceId: "namespace-test-shadow",
      legacyServices: legacy,
      protectedServices: protectedShadow,
    });

    for (const resolvedNamespaceId of [
      "namespace-other-room",
      null,
    ] as const) {
      const selected = resolveConversationExecutionServices({
        defaultLegacyServices: services("unused-default"),
        composition,
        origin: { entrypointId: "foreground.main" },
        resolvedNamespaceId,
      });
      expect(selected).toEqual({
        mode: "legacy",
        reason: "protected_namespace_mismatch",
        services: legacy,
      });
      expect(selected.services).not.toBe(protectedShadow);
    }
  });

  test("test authority minting is not exported from the runtime package root", () => {
    const packageRoot = readFileSync(
      new URL("../../src/index.ts", import.meta.url),
      "utf8",
    );
    expect(packageRoot).not.toContain(
      "createProtectedTestShadowAuthorityForTests",
    );
    expect(packageRoot).not.toContain(
      "__mintProtectedTestShadowAuthorityForTesting",
    );
  });

  test("production runtime and server sources cannot import the test-authority mint", () => {
    const workspaceRoot = new URL("../../../../", import.meta.url).pathname;
    const sourceFiles = [
      ...new Bun.Glob("packages/runtime/src/**/*.ts").scanSync({
        cwd: workspaceRoot,
      }),
      ...new Bun.Glob("packages/server/src/**/*.ts").scanSync({
        cwd: workspaceRoot,
      }),
    ];
    const allowedDefinitions = new Set([
      "packages/runtime/src/conversation/conversation-composition.ts",
      "packages/runtime/src/conversation/testing/protected-test-shadow-authority.ts",
    ]);

    for (const relativePath of sourceFiles) {
      if (allowedDefinitions.has(relativePath)) continue;
      const source = readFileSync(`${workspaceRoot}/${relativePath}`, "utf8");
      expect(source).not.toContain(
        "createProtectedTestShadowAuthorityForTests",
      );
      expect(source).not.toContain(
        "__mintProtectedTestShadowAuthorityForTesting",
      );
      expect(source).not.toContain(
        "conversation/testing/protected-test-shadow-authority",
      );
    }

    const compositionSource = readFileSync(
      new URL(
        "../../src/conversation/conversation-composition.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(compositionSource).not.toContain("process.env");
    expect(compositionSource).not.toContain("@nautilo/config");
  });
});
