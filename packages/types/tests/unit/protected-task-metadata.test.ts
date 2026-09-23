import { describe, expect, test } from "bun:test";
import {
  PROTECTED_TASK_ARTIFACT_ID_MAX_CHARS_V1,
  PROTECTED_TASK_ARTIFACT_PATH_MAX_CHARS_V1,
  PROTECTED_TASK_ARTIFACT_REFS_MAX_ITEMS_V1,
  PROTECTED_TASK_ARTIFACT_TOPIC_MAX_CHARS_V1,
  PROTECTED_TASK_CLAUDE_EXECUTION_TEXT_MAX_UTF8_BYTES_V1,
  PROTECTED_TASK_CODEX_WORKING_DIRECTORY_MAX_UTF8_BYTES_V1,
  PROTECTED_TASK_EXECUTION_OPAQUE_ID_MAX_UTF8_BYTES_V1,
  PROTECTED_TASK_LIVE_MINI_APP_ID_MAX_CHARS_V1,
  classifyProtectedTaskMetadataV1,
  type ProtectedTaskMetadataClassificationV1,
} from "../../src/protected-task-metadata";

const ACTOR_ID = "123e4567-e89b-42d3-a456-426614174000";

function supported(input: unknown) {
  const result = classifyProtectedTaskMetadataV1(input);
  expect(result.status).toBe("supported");
  if (result.status !== "supported") throw new Error(`expected supported metadata at ${result.path}`);
  return result;
}

function expectUnsupported(
  input: unknown,
  reason: Extract<ProtectedTaskMetadataClassificationV1, { status: "unsupported" }>["reason"],
  path: string,
) {
  expect(classifyProtectedTaskMetadataV1(input)).toEqual({
    status: "unsupported",
    version: 1,
    reason,
    path,
  });
}

function artifactRef(index = 0) {
  return {
    artifactId: `artifact-${index}`,
    path: `drafts/${index}.md`,
    mimeType: "text/markdown",
    size: index,
  };
}

function modelPlan(model = "model") {
  return {
    version: 1,
    supervisorModel: model,
    researchModel: model,
    summarizationModel: model,
    compressionModel: model,
    finalReportModel: model,
  };
}

function codexExecution(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    harnessId: "codex",
    source: "genie",
    collaborationMode: "work",
    harnessModelId: "codex-model",
    readiness: {
      relayId: "relay",
      pairingGenerationRef: "pairing",
      capabilityRevision: 3,
    },
    ...overrides,
  };
}

describe("protected Task metadata v1", () => {
  test("accepts the canonical empty Task case and keeps unrelated metadata outside the API", () => {
    expect(supported({})).toEqual({ status: "supported", version: 1, operational: {}, protectedContent: {} });
    expectUnsupported(null, "unsupported_shape", "$");
    expectUnsupported(new Date(), "unsupported_shape", "$");
    expectUnsupported({ ordinary: "metadata" }, "unknown_field", "$");
  });

  test("rejects non-JSON values instead of dropping or normalizing them", () => {
    expectUnsupported({ bringBack: undefined }, "unsupported_shape", "$");
    expectUnsupported({ bringBack: Number.NaN }, "unsupported_shape", "$");
    const cyclic: Record<string, unknown> = { bringBack: true };
    cyclic["cycle"] = cyclic;
    expectUnsupported(cyclic, "unsupported_shape", "$");
  });

  test("classifies state overlays with one exact deep-research intent", () => {
    const result = supported({
      preparation: {
        stage: "using_tools",
        activity: "reading_source",
        researchWork: { role: "investigator", subject: "Review access checks" },
        taskRunId: "run-1",
        updatedAt: "2026-09-21T10:00:00.000Z",
      },
      lastInterruption: {
        code: "relay_unavailable",
        cause: "desktop_disconnected",
        stoppedBy: "task_runtime",
        outcome: "paused",
        observedAt: "2026-09-21T10:01:00.000Z",
        taskRunId: "run-1",
        graphThreadId: "thread-1",
        checkpointId: null,
        resumable: true,
        desktopExitCause: "unknown",
      },
      deepResearch: {
        version: 1,
        reportLanguage: "Portuguese",
        modelPlan: modelPlan(),
        invokingModelId: null,
      },
      writerReviewAwaiting: {
        version: 1,
        taskRunId: "run-1",
        proposalId: "proposal-1",
      },
    });

    expect(result.operational).toEqual({
      preparation: {
        stage: "using_tools",
        activity: "reading_source",
        researchWork: { role: "investigator" },
        taskRunId: "run-1",
        updatedAt: "2026-09-21T10:00:00.000Z",
      },
      lastInterruption: {
        code: "relay_unavailable",
        cause: "desktop_disconnected",
        stoppedBy: "task_runtime",
        outcome: "paused",
        observedAt: "2026-09-21T10:01:00.000Z",
        taskRunId: "run-1",
        graphThreadId: "thread-1",
        checkpointId: null,
        resumable: true,
        desktopExitCause: "unknown",
      },
      deepResearch: { version: 1, modelPlan: modelPlan(), invokingModelId: null },
      writerReviewAwaiting: { version: 1, taskRunId: "run-1", proposalId: "proposal-1" },
    });
    expect(result.protectedContent).toEqual({
      preparation: { researchWork: { subject: "Review access checks" } },
      deepResearch: { reportLanguage: "Portuguese" },
    });
  });

  test("classifies each remaining producer intent without mixing them", () => {
    expect(supported({
      target: "/work/repository",
      mode: "update",
      publish: "branch",
      instructions: "Preserve the existing voice.",
    })).toMatchObject({
      operational: { mode: "update", publish: "branch" },
      protectedContent: {
        target: "/work/repository",
        instructions: "Preserve the existing voice.",
      },
    });
    expect(supported({ bringBack: false })).toMatchObject({
      operational: { bringBack: false },
      protectedContent: {},
    });
    expect(supported({
      ordinaryArtifactPeer: true,
      expectedArtifactPeerActorId: ACTOR_ID,
      artifactAwareAskPeer: true,
      artifactRefs: [artifactRef()],
      artifactOperationId: "ask-peer-artifacts-v1:turn:peer:artifact-0",
    })).toMatchObject({
      operational: {
        ordinaryArtifactPeer: true,
        expectedArtifactPeerActorId: ACTOR_ID,
        artifactAwareAskPeer: true,
      },
      protectedContent: {
        artifactRefs: [artifactRef()],
        artifactOperationId: "ask-peer-artifacts-v1:turn:peer:artifact-0",
      },
    });
    expect(supported({
      liveMiniAppTaskDelegation: { version: 1, appId: "nautilo-writer" },
    })).toMatchObject({
      operational: {
        liveMiniAppTaskDelegation: { version: 1, appId: "nautilo-writer" },
      },
      protectedContent: {},
    });
    expect(supported({
      bringBack: true,
      liveMiniAppTaskDelegation: { version: 1, appId: "nautilo-writer" },
    })).toMatchObject({
      operational: {
        bringBack: true,
        liveMiniAppTaskDelegation: { version: 1, appId: "nautilo-writer" },
      },
      protectedContent: {},
    });
  });

  test("rejects ambiguous mixtures of mutually exclusive producer intents", () => {
    expectUnsupported({
      bringBack: true,
      target: "/work/repository",
      mode: "auto",
      publish: "pr",
    }, "unsupported_shape", "$");
    expectUnsupported({
      deepResearch: {
        version: 1,
        reportLanguage: "English",
        modelPlan: modelPlan(),
        invokingModelId: null,
      },
      artifactId: "artifact-1",
      topic: "selection.changed",
      source: "artifact_ping",
    }, "unsupported_shape", "$");
  });

  test("classifies artifact ping identifiers and topic as protected content", () => {
    const result = supported({ artifactId: "board/events", topic: "selection.changed", source: "artifact_ping" });
    expect(result.operational).toEqual({ source: "artifact_ping" });
    expect(result.protectedContent).toEqual({ artifactId: "board/events", topic: "selection.changed" });
  });

  test("splits the Codex working directory without retaining or freezing the input", () => {
    const input = { execution: codexExecution({
      workingDirectory: "/work/private-project",
      outputContract: {
        version: 1,
        capabilityModelId: "openai:gpt-5",
        catalogVersion: "catalog-1",
        contextTokens: 100_000,
        outputTokens: 20_000,
      },
    }) };
    const result = supported(input);
    expect(result.operational["execution"]).toEqual(codexExecution({
      outputContract: {
        version: 1,
        capabilityModelId: "openai:gpt-5",
        catalogVersion: "catalog-1",
        contextTokens: 100_000,
        outputTokens: 20_000,
      },
    }));
    expect(result.protectedContent).toEqual({ execution: { workingDirectory: "/work/private-project" } });
    expect(Object.isFrozen(result.operational)).toBe(true);
    expect(Object.isFrozen(result.operational["execution"])).toBe(true);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.execution)).toBe(false);
    expect(Object.isFrozen(input.execution.readiness)).toBe(false);
  });

  test.each([
    ["claude-code", {
      version: 1, harnessId: "claude-code", source: "genie",
      profileRef: "profile", catalogModelId: "catalog-model", selectedModel: "selected-model",
    }],
    ["hermes-acp", {
      version: 1, harnessId: "hermes-acp", source: "genie",
      readiness: { relayId: "relay", relaySessionId: "session", pairingGenerationRef: "pairing",
        desktopSessionId: "desktop", selectedProtocolVersion: 14, capabilityRevision: 1 },
    }],
    ["opencode-acp", {
      version: 1, harnessId: "opencode-acp", source: "genie", executionProfile: "autonomous",
      readiness: { relayId: "relay", relaySessionId: "session", pairingGenerationRef: "pairing",
        desktopSessionId: "desktop", selectedProtocolVersion: 15, capabilityRevision: 1 },
    }],
  ])("accepts the exact %s execution producer", (_name, execution) => {
    expect(supported({ execution }).operational).toEqual({ execution });
  });

  test("accepts canonical Writer revisions and rejects legacy nested receipt values", () => {
    const result = supported({
      writerReviewAcceptedReceipt: {
        version: 1,
        taskRunId: "run-1",
        proposalId: "proposal-1",
        acceptedResultRevision: { kind: "artifact_revision", revision: 8 },
        acceptedWorkspaceOperationId: "operation-1",
        acceptedWorkspaceClientMutationId: "mutation-1",
        acceptedWorkspaceArtifactId: "artifact-1",
      },
    });
    expect(result.protectedContent).toEqual({});
    expect(result.operational["writerReviewAcceptedReceipt"]).toEqual({
      version: 1,
      taskRunId: "run-1",
      proposalId: "proposal-1",
      acceptedResultRevision: { kind: "artifact_revision", revision: 8 },
      acceptedWorkspaceOperationId: "operation-1",
      acceptedWorkspaceClientMutationId: "mutation-1",
      acceptedWorkspaceArtifactId: "artifact-1",
    });
    expectUnsupported({ writerReviewAcceptedReceipt: {
      version: 1,
      taskRunId: "run-1",
      proposalId: "proposal-1",
      acceptedResultRevision: { legacy: true },
    } }, "unsupported_shape", "$.writerReviewAcceptedReceipt.acceptedResultRevision");
  });

  test.each([
    [{ preparation: { stage: "using_tools", taskRunId: "run", updatedAt: "2026-09-21T10:00:00Z", future: true } }, "$.preparation"],
    [{ deepResearch: { version: 1, reportLanguage: "English", modelPlan: { ...modelPlan(), future: true }, invokingModelId: null } }, "$.deepResearch.modelPlan"],
    [{ execution: codexExecution({ future: true }) }, "$.execution"],
    [{ artifactAwareAskPeer: true, artifactRefs: [{ ...artifactRef(), future: true }], artifactOperationId: "operation" }, "$.artifactRefs[0]"],
    [{ liveMiniAppTaskDelegation: { version: 1, appId: "writer", future: true } }, "$.liveMiniAppTaskDelegation"],
    [{ writerReviewAwaiting: { version: 1, taskRunId: "run", proposalId: "proposal", future: true } }, "$.writerReviewAwaiting"],
  ])("rejects unknown nested fields at their recognized container", (input, path) => {
    expectUnsupported(input, "unknown_field", path);
  });

  test.each([
    [PROTECTED_TASK_ARTIFACT_ID_MAX_CHARS_V1, (n: number) => ({ artifactId: "a".repeat(n), topic: "event", source: "artifact_ping" })],
    [PROTECTED_TASK_ARTIFACT_PATH_MAX_CHARS_V1, (n: number) => ({ artifactAwareAskPeer: true,
      artifactRefs: [{ artifactId: "artifact", path: "p".repeat(n) }], artifactOperationId: "operation" })],
    [PROTECTED_TASK_ARTIFACT_TOPIC_MAX_CHARS_V1, (n: number) => ({ artifactId: "artifact", topic: "t".repeat(n), source: "artifact_ping" })],
    [PROTECTED_TASK_LIVE_MINI_APP_ID_MAX_CHARS_V1, (n: number) => ({ liveMiniAppTaskDelegation: { version: 1, appId: "a".repeat(n) } })],
    [PROTECTED_TASK_EXECUTION_OPAQUE_ID_MAX_UTF8_BYTES_V1, (n: number) => ({ execution: codexExecution({ harnessModelId: "m".repeat(n) }) })],
    [PROTECTED_TASK_CLAUDE_EXECUTION_TEXT_MAX_UTF8_BYTES_V1, (n: number) => ({ execution: {
      version: 1, harnessId: "claude-code", source: "genie", profileRef: "p".repeat(n),
      catalogModelId: "catalog", selectedModel: "selected",
    } })],
    [PROTECTED_TASK_CODEX_WORKING_DIRECTORY_MAX_UTF8_BYTES_V1, (n: number) => ({ execution: codexExecution({ workingDirectory: "w".repeat(n) }) })],
  ])("enforces reused producer limit %i at N-1, N, and N+1", (limit, build) => {
    expect(supported(build(limit - 1)).status).toBe("supported");
    expect(supported(build(limit)).status).toBe("supported");
    expect(classifyProtectedTaskMetadataV1(build(limit + 1)).status).toBe("unsupported");
  });

  test("enforces the reused artifact-ref count at N-1, N, and N+1", () => {
    const build = (count: number) => ({
      artifactAwareAskPeer: true,
      artifactRefs: Array.from({ length: count }, (_, index) => artifactRef(index)),
      artifactOperationId: "operation",
    });
    expect(supported(build(PROTECTED_TASK_ARTIFACT_REFS_MAX_ITEMS_V1 - 1)).status).toBe("supported");
    expect(supported(build(PROTECTED_TASK_ARTIFACT_REFS_MAX_ITEMS_V1)).status).toBe("supported");
    expect(classifyProtectedTaskMetadataV1(build(PROTECTED_TASK_ARTIFACT_REFS_MAX_ITEMS_V1 + 1)).status).toBe("unsupported");
  });

  test("bounds operational identifiers and requires canonical timestamps", () => {
    const oversized = "x".repeat(
      PROTECTED_TASK_EXECUTION_OPAQUE_ID_MAX_UTF8_BYTES_V1 + 1,
    );
    expect(classifyProtectedTaskMetadataV1({
      execution: codexExecution({
        readiness: {
          relayId: oversized,
          pairingGenerationRef: "pairing",
          capabilityRevision: 1,
        },
      }),
    }).status).toBe("unsupported");
    expect(classifyProtectedTaskMetadataV1({
      preparation: {
        stage: "using_tools",
        taskRunId: oversized,
        updatedAt: "2026-09-21T10:00:00.000Z",
      },
    }).status).toBe("unsupported");
    expect(classifyProtectedTaskMetadataV1({
      writerReviewAwaiting: {
        version: 1,
        taskRunId: "run-1",
        proposalId: oversized,
      },
    }).status).toBe("unsupported");
    expect(classifyProtectedTaskMetadataV1({
      lastInterruption: {
        code: "relay_unavailable",
        cause: "desktop_disconnected",
        stoppedBy: "task_runtime",
        outcome: "paused",
        observedAt: "2026-09-21T10:01:00Z",
        taskRunId: "run-1",
        graphThreadId: "thread-1",
        checkpointId: null,
        resumable: true,
        desktopExitCause: "unknown",
      },
    }).status).toBe("unsupported");
  });

  test("keeps free-form interruption tool identity out of operational metadata", () => {
    const result = supported({
      lastInterruption: {
        code: "no_progress",
        cause: "repeated_tool_failure",
        stoppedBy: "no_progress_guard",
        outcome: "errored",
        observedAt: "2026-09-21T10:01:00.000Z",
        taskRunId: "run-1",
        graphThreadId: "thread-1",
        checkpointId: null,
        toolName: "private_repository_lookup",
        operation: "read",
        resumeRequiresValidation: true,
      },
    });

    expect(result.operational).toEqual({
      lastInterruption: {
        code: "no_progress",
        cause: "repeated_tool_failure",
        stoppedBy: "no_progress_guard",
        outcome: "errored",
        observedAt: "2026-09-21T10:01:00.000Z",
        taskRunId: "run-1",
        graphThreadId: "thread-1",
        checkpointId: null,
        resumeRequiresValidation: true,
      },
    });
    expect(result.protectedContent).toEqual({
      lastInterruption: {
        toolName: "private_repository_lookup",
        operation: "read",
      },
    });
  });

  test("preserves producer text without truncation when no canonical limit exists", () => {
    const target = `/work/${"repository/".repeat(3_000)}`;
    const instructions = "Document the public behavior. ".repeat(4_000);
    const result = supported({ target, mode: "auto", publish: "pr", instructions });
    expect(result.protectedContent).toEqual({ target, instructions });
  });
});
