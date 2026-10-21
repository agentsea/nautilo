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
  assertProtectedTaskOperationalMetadataProjectionV1,
  classifyProtectedTaskMetadataV1,
  isProtectedTaskOperationalMetadataProjectionV1,
  parseProtectedTaskOperationalMetadataProjectionV1,
  reconstructProtectedTaskMetadataV1,
  type ProtectedTaskMetadataClassificationV1,
  type ProtectedTaskMetadataProjectionV1,
} from "../../src/protected-task-metadata";

const ACTOR_ID = "123e4567-e89b-42d3-a456-426614174000";

function supported(input: unknown) {
  const result = classifyProtectedTaskMetadataV1(input);
  expect(result.status).toBe("supported");
  if (result.status !== "supported") throw new Error(`expected supported metadata at ${result.path}`);
  return result;
}

function jsonProjection(
  value: ProtectedTaskMetadataProjectionV1,
): ProtectedTaskMetadataProjectionV1 {
  return value;
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
  test("reconstructs every recognized split without mutating either projection", () => {
    const input = {
      preparation: {
        stage: "using_tools",
        researchWork: { role: "investigator", subject: "Review access checks" },
        taskRunId: "run-1",
        updatedAt: "2026-09-21T10:00:00.000Z",
      },
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
    };
    const classified = supported(input);
    const operationalBefore = structuredClone(classified.operational);
    const protectedBefore = structuredClone(classified.protectedContent);

    const reconstructed = reconstructProtectedTaskMetadataV1(
      classified.operational,
      classified.protectedContent,
    );

    expect(reconstructed).toEqual({ status: "supported", version: 1, metadata: input });
    expect(classified.operational).toEqual(operationalBefore);
    expect(classified.protectedContent).toEqual(protectedBefore);
    expect(reconstructed.status === "supported" && Object.isFrozen(reconstructed.metadata)).toBe(true);
  });

  test("reconstructs top-level and execution splits", () => {
    for (const input of [
      {
        execution: codexExecution({ workingDirectory: "/work/private-project" }),
      },
      {
        target: "/work/repository",
        mode: "update",
        publish: "branch",
        instructions: "Preserve the existing voice.",
      },
      {
        artifactAwareAskPeer: true,
        artifactRefs: [artifactRef()],
        artifactOperationId: "ask-peer-artifacts-v1:turn:peer:artifact-0",
      },
      {
        ordinaryArtifactPeer: true,
        expectedArtifactPeerActorId: "123e4567-e89b-42d3-a456-426614174000",
        artifactAwareAskPeer: true,
        artifactRefs: [artifactRef()],
        artifactOperationId: "ask-peer-artifacts-v1:turn:peer:artifact-1",
      },
      {
        artifactId: "board/events",
        topic: "selection.changed",
        source: "artifact_ping",
      },
      { bringBack: false },
    ]) {
      const classified = supported(input);
      expect(reconstructProtectedTaskMetadataV1(
        classified.operational,
        classified.protectedContent,
      )).toEqual({ status: "supported", version: 1, metadata: input });
    }
  });

  test("rejects unknown projection fields, split-field collisions, and incomplete pairs", () => {
    expect(reconstructProtectedTaskMetadataV1(
      { bringBack: true, future: true },
      {},
    )).toEqual({ status: "unsupported", version: 1, reason: "unknown_field", path: "$.operational" });
    expect(reconstructProtectedTaskMetadataV1(
      {},
      { future: true },
    )).toEqual({ status: "unsupported", version: 1, reason: "unknown_field", path: "$.protectedContent" });
    expect(reconstructProtectedTaskMetadataV1(
      { execution: codexExecution({ workingDirectory: "/wrong" }) },
      { execution: { workingDirectory: "/work" } },
    )).toEqual({
      status: "unsupported", version: 1, reason: "unsupported_shape", path: "$.protectedContent.execution",
    });
    expect(reconstructProtectedTaskMetadataV1(
      {},
      { execution: { workingDirectory: "/work" } },
    )).toEqual({
      status: "unsupported", version: 1, reason: "malformed_field", path: "$.operational.execution",
    });
    expect(reconstructProtectedTaskMetadataV1(
      { preparation: {
        stage: "using_tools",
        researchWork: { role: "investigator", subject: "collision" },
        taskRunId: "run-1",
        updatedAt: "2026-09-21T10:00:00.000Z",
      } },
      { preparation: { researchWork: { subject: "protected" } } },
    )).toEqual({
      status: "unsupported",
      version: 1,
      reason: "unsupported_shape",
      path: "$.protectedContent.preparation.researchWork",
    });
  });

  test("rejects recognized fields placed in the wrong projection", () => {
    expect(reconstructProtectedTaskMetadataV1(
      { target: "/private", mode: "update", publish: "branch" },
      {},
    )).toEqual({ status: "unsupported", version: 1, reason: "unknown_field", path: "$.operational" });
    expect(reconstructProtectedTaskMetadataV1(
      {},
      { bringBack: true },
    )).toEqual({ status: "unsupported", version: 1, reason: "unknown_field", path: "$.protectedContent" });
  });

  test("brands only canonical operational projections", () => {
    const classified = supported({
      target: "/work/repository",
      mode: "update",
      publish: "branch",
      instructions: "Keep this protected.",
    });

    expect(isProtectedTaskOperationalMetadataProjectionV1(
      classified.operational,
    )).toBe(true);
    expect(() => assertProtectedTaskOperationalMetadataProjectionV1(
      classified.operational,
    )).not.toThrow();
    for (const unclassified of [
      { mode: "update", publish: "branch" },
      { target: "/work/repository", instructions: "protected" },
      { unknown: true },
      { execution: { harnessModelId: "x".repeat(
        PROTECTED_TASK_EXECUTION_OPAQUE_ID_MAX_UTF8_BYTES_V1 + 1,
      ) } },
    ]) {
      expect(isProtectedTaskOperationalMetadataProjectionV1(unclassified))
        .toBe(false);
      expect(() => assertProtectedTaskOperationalMetadataProjectionV1(
        unclassified,
      )).toThrow("canonical classifier output");
    }
  });

  test("restores every persisted operational projection without protected values", () => {
    const inputs = [
      { execution: codexExecution({ workingDirectory: "/private/repository" }) },
      {
        preparation: {
          stage: "using_tools",
          researchWork: { role: "investigator", subject: "Private subject" },
          taskRunId: "run-1",
          updatedAt: "2026-09-21T10:00:00.000Z",
        },
      },
      {
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
      },
      {
        deepResearch: {
          version: 1,
          reportLanguage: "Portuguese",
          modelPlan: modelPlan(),
          invokingModelId: null,
        },
      },
      { target: "/private/repository", mode: "update", publish: "branch" },
      { bringBack: false },
      {
        ordinaryArtifactPeer: true,
        expectedArtifactPeerActorId: "123e4567-e89b-42d3-a456-426614174000",
      },
      {
        artifactAwareAskPeer: true,
        artifactRefs: [artifactRef()],
        artifactOperationId: "ask-peer-artifacts-v1:turn:peer:artifact-0",
      },
      {
        ordinaryArtifactPeer: true,
        expectedArtifactPeerActorId: "123e4567-e89b-42d3-a456-426614174000",
        artifactAwareAskPeer: true,
        artifactRefs: [artifactRef()],
        artifactOperationId: "ask-peer-artifacts-v1:turn:peer:artifact-2",
      },
      { artifactId: "board/events", topic: "selection.changed", source: "artifact_ping" },
      { liveMiniAppTaskDelegation: { version: 1, appId: "mini-app" } },
      {
        writerReviewAwaiting: {
          version: 1,
          taskRunId: "run-1",
          proposalId: "proposal-1",
        },
      },
    ];

    for (const input of inputs) {
      const classified = supported(input);
      const restored = parseProtectedTaskOperationalMetadataProjectionV1(
        structuredClone(classified.operational),
      );
      expect(restored).toEqual(classified.operational);
      expect(isProtectedTaskOperationalMetadataProjectionV1(restored)).toBe(true);
    }
  });

  test("rejects malformed, protected, and unknown persisted operational projections", () => {
    for (const input of [
      { execution: { harnessId: "codex" } },
      { deepResearch: { version: 1, modelPlan: { ...modelPlan(), privateCanary: "secret" }, invokingModelId: null } },
      { execution: { ...codexExecution(), harnessModelId: { privateCanary: "secret" } } },
      { mode: "update" },
      { artifactAwareAskPeer: false },
      { source: "artifact_ping", topic: "private" },
      { target: "/private" },
      { futureOperationalField: true },
    ]) {
      expect(parseProtectedTaskOperationalMetadataProjectionV1(input)).toBeNull();
    }
  });

  test("accepts the canonical empty Task case and keeps unrelated metadata outside the API", () => {
    const result = supported({});
    expect({ ...result, operational: jsonProjection(result.operational) }).toEqual({
      status: "supported", version: 1, operational: {}, protectedContent: {},
    });
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

    expect(jsonProjection(result.operational)).toEqual({
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
    expect(jsonProjection(result.operational)).toEqual({ source: "artifact_ping" });
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
    expect(jsonProjection(supported({ execution }).operational)).toEqual({ execution });
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

    expect(jsonProjection(result.operational)).toEqual({
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


describe("protected Deep Research admitted funding metadata", () => {
  const lanes = ["supervisor", "research", "summarization", "compression", "finalReport"] as const;
  function admitted() {
    return {
      version: 2,
      reportLanguage: "Portuguese",
      modelPlan: modelPlan(),
      invokingModelId: null,
      preferenceRevisions: Object.fromEntries(lanes.map((lane, index) => [lane, index])),
      modelFunding: Object.fromEntries(lanes.map((lane, index) => [lane, index % 2 === 0
        ? { kind: "personal", providerRoute: "openai", credentialId: ACTOR_ID, credentialRevision: 1 }
        : { kind: "server", providerRoute: "anthropic" }])),
      tavilyFunding: { kind: "personal", providerRoute: "tavily", credentialId: ACTOR_ID, credentialRevision: 2 },
    };
  }

  test("round-trips all five admitted lanes and Tavily without leaking language or sharing mutable inputs", () => {
    const deepResearch = admitted();
    const original = structuredClone(deepResearch);
    const classified = supported({ deepResearch });
    const { reportLanguage, ...operational } = original;
    expect(jsonProjection(classified.operational)).toEqual({ deepResearch: operational });
    expect(classified.protectedContent).toEqual({ deepResearch: { reportLanguage } });
    expect(reconstructProtectedTaskMetadataV1(classified.operational, classified.protectedContent))
      .toEqual({ status: "supported", version: 1, metadata: { deepResearch: original } });
    deepResearch.preferenceRevisions["research"] = 99;
    deepResearch.tavilyFunding.credentialRevision = 99;
    expect(jsonProjection(classified.operational)).toEqual({ deepResearch: operational });
    expect(isProtectedTaskOperationalMetadataProjectionV1(classified.operational)).toBe(true);
  });

  test.each([...lanes])("requires an exact valid %s funding lane and preference revision", lane => {
    for (const replacement of [undefined, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, "1"]) {
      const input = admitted();
      expect(classifyProtectedTaskMetadataV1({ deepResearch: {
        ...input, preferenceRevisions: { ...input.preferenceRevisions, [lane]: replacement },
      } }).status).toBe("unsupported");
    }
    for (const replacement of [undefined, null, { kind: "personal", providerRoute: "openai", credentialId: ACTOR_ID, credentialRevision: 0 },
      { kind: "server", providerRoute: "openai", apiKey: "must-not-persist" },
      { kind: "personal", providerRoute: "openai", credentialId: "wrong-id", credentialRevision: 1 }]) {
      const input = admitted();
      expect(classifyProtectedTaskMetadataV1({ deepResearch: {
        ...input, modelFunding: { ...input.modelFunding, [lane]: replacement },
      } }).status).toBe("unsupported");
    }
  });

  test("rejects unknown, mixed-version, secret-bearing and misplaced funding fields", () => {
    const input = admitted();
    for (const deepResearch of [
      { ...input, version: 1 }, { ...input, version: 3 }, { ...input, researchBrief: "private" },
      { ...input, preferenceRevisions: { ...input.preferenceRevisions, extra: 1 } },
      { ...input, modelFunding: { ...input.modelFunding, extra: input.tavilyFunding } },
      { ...input, tavilyFunding: { ...input.tavilyFunding, apiKey: "must-not-persist" } },
      { ...input, tavilyFunding: null }, { ...input, tavilyFunding: { kind: "server", providerRoute: "bad route" } },
    ]) expect(classifyProtectedTaskMetadataV1({ deepResearch }).status).toBe("unsupported");
    const classified = supported({ deepResearch: input });
    expect(reconstructProtectedTaskMetadataV1(classified.operational, {
      deepResearch: { reportLanguage: input.reportLanguage, modelFunding: input.modelFunding },
    }).status).toBe("unsupported");
    expect(reconstructProtectedTaskMetadataV1({ deepResearch: { ...input } }, classified.protectedContent).status)
      .toBe("unsupported");
    expect(reconstructProtectedTaskMetadataV1(classified.operational, {}).status).toBe("unsupported");
  });
});
