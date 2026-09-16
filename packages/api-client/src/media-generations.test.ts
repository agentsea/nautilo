import { describe, expect, test } from "bun:test";
import {
  compareMediaGenerationStatusRevision,
  isStaleMediaGenerationStatus,
  mapMediaGenerationStatusV1,
  parseMediaGenerationStatusDtoV1,
  type DurableMediaGenerationState,
  type MediaGenerationStatusDtoV1,
  type MediaGenerationStatusSourceV1,
} from "./media-generations";

const ACTION_HANDLE = "serveractionhandle01";

function safeFailure() {
  return {
    code: "VENICE_CONTENT_POLICY",
    message: "The provider declined this request. Revise it or choose another model.",
    phase: "queue" as const,
    retrySafe: false,
    stateChanged: false,
    completionCertainty: "not_started" as const,
    chargeCertainty: "unknown" as const,
  };
}

function safeArtifact() {
  return {
    artifactId: "artifact-media-01",
    path: "Generated/media/take-01.mp4",
    zone: "workspace" as const,
    mime: "video/mp4",
    bytes: 1_024,
  };
}

function source(
  state: DurableMediaGenerationState,
  overrides: Partial<MediaGenerationStatusSourceV1> = {},
): MediaGenerationStatusSourceV1 {
  const terminal = state === "needs_action" || state === "failed" || state === "unknown";
  return {
    receiptId: "mg_receipt_01",
    revision: 3,
    kind: "video",
    modelId: "venice:seedance-2-5-text-to-video-basic",
    state,
    settings: { durationSeconds: 5, resolution: "720p", aspectRatio: "16:9", audioEnabled: true },
    cleanupState: "completed",
    ...(state === "ready" ? { artifact: safeArtifact() } : {}),
    ...(terminal ? { failure: safeFailure() } : {}),
    recoveryActions: [],
    ...overrides,
  };
}

function readyDto(overrides: Partial<MediaGenerationStatusDtoV1> = {}): MediaGenerationStatusDtoV1 {
  return {
    dtoVersion: 1,
    receiptId: "mg_receipt_01",
    revision: 3,
    mediaKind: "video",
    state: "ready",
    modelId: "venice:seedance-2-5-text-to-video-basic",
    settings: { durationSeconds: 5 },
    artifact: safeArtifact(),
    recoveryActions: [],
    ...overrides,
  };
}

describe("D525 media-generation status DTO v1", () => {
  test("maps every durable receipt state without exposing an internal state", () => {
    const expected: ReadonlyArray<readonly [DurableMediaGenerationState, MediaGenerationStatusDtoV1["state"]]> = [
      ["prequeue", "queued"],
      ["admitting", "submitting"],
      ["queued", "queued"],
      ["retrieving", "downloading"],
      ["saving", "saving"],
      ["ready", "ready"],
      ["needs_action", "needs-action"],
      ["failed", "failed"],
      ["unknown", "unknown"],
    ];
    for (const [durableState, clientState] of expected) {
      const dto = mapMediaGenerationStatusV1(source(durableState));
      expect(dto.state).toBe(clientState);
      expect(parseMediaGenerationStatusDtoV1(dto)).toEqual(dto);
    }
  });

  test("maps admitting to submitting, not provider-queued, and supports proven generating progress", () => {
    expect(mapMediaGenerationStatusV1(source("admitting"))).toMatchObject({
      state: "submitting",
      progress: { phase: "submitting" },
    });
    expect(mapMediaGenerationStatusV1(source("queued", {
      progress: { phase: "generating", elapsedSeconds: 4, estimatedSeconds: 12 },
    }))).toMatchObject({
      state: "generating",
      progress: { phase: "generating", elapsedSeconds: 4, estimatedSeconds: 12 },
    });
    expect(mapMediaGenerationStatusV1(source("retrieving", {
      progress: { phase: "generating", elapsedSeconds: 18, estimatedSeconds: 145 },
    }))).toMatchObject({
      state: "generating",
      progress: { phase: "generating", elapsedSeconds: 18, estimatedSeconds: 145 },
    });
    expect(mapMediaGenerationStatusV1(source("ready", { kind: "music", artifact: {
      ...safeArtifact(), path: "Generated/music/take-01.mp3", mime: "audio/mpeg",
    } })).mediaKind).toBe("audio");
  });

  test("strictly rejects topology, request text, URLs, paths, and unknown keys", () => {
    const dto = readyDto();
    for (const hostile of [
      { providerQueueId: "venice-queue-private" },
      { queue_id: "venice-queue-private" },
      { prompt: "raw creative text" },
      { lyrics: "raw lyrics" },
      { requestPayload: { prompt: "raw creative text" } },
      { rawProviderBody: "provider body" },
      { deliveryUrl: "https://provider.example/media" },
      { receiptId: "https://provider.example/receipt" },
      { modelId: "https://provider.example/model" },
      { artifact: { ...safeArtifact(), path: "/private/provider/path.mp4" } },
      { artifact: { ...safeArtifact(), path: "https://provider.example/media.mp4" } },
    ]) {
      expect(parseMediaGenerationStatusDtoV1({ ...dto, ...hostile })).toBeNull();
    }
  });

  test("requires a complete artifact only for ready", () => {
    const ready = readyDto();
    expect(parseMediaGenerationStatusDtoV1(ready)).toEqual(ready);
    expect(parseMediaGenerationStatusDtoV1({ ...ready, artifact: undefined })).toBeNull();
    expect(parseMediaGenerationStatusDtoV1({ ...ready, state: "queued", progress: { phase: "queued" } })).toBeNull();
    expect(parseMediaGenerationStatusDtoV1({
      ...ready,
      artifact: { ...safeArtifact(), bytes: 0 },
    })).toBeNull();
  });

  test("maps ready cleanup work to the renderer-compatible cleanup-pending state", () => {
    const cleanupPending = mapMediaGenerationStatusV1(source("ready", { cleanupState: "pending" }));
    expect(cleanupPending).toMatchObject({
      state: "cleanup-pending",
      artifact: safeArtifact(),
    });
    expect(parseMediaGenerationStatusDtoV1(cleanupPending)).toEqual(cleanupPending);
    expect(parseMediaGenerationStatusDtoV1({ ...cleanupPending, artifact: undefined })).toBeNull();
  });

  test("requires only safe typed failures for recovery states", () => {
    const failed = {
      ...readyDto(),
      state: "failed" as const,
      artifact: undefined,
      failure: safeFailure(),
      recoveryActions: [{
        actionId: ACTION_HANDLE,
        kind: "revise_prompt" as const,
        label: "Revise prompt",
        newSpend: false,
      }],
    };
    expect(parseMediaGenerationStatusDtoV1(failed)).toEqual(failed);
    expect(parseMediaGenerationStatusDtoV1({ ...failed, failure: undefined })).toBeNull();
    expect(parseMediaGenerationStatusDtoV1({ ...readyDto(), failure: safeFailure() })).toBeNull();
  });

  test("permits only bounded safe progress and failure messages", () => {
    const queued = {
      ...readyDto(),
      state: "queued" as const,
      artifact: undefined,
      progress: { phase: "queued" as const, message: "Waiting for a generation slot." },
    };
    expect(parseMediaGenerationStatusDtoV1(queued)).not.toBeNull();
    const failed = {
      ...readyDto(),
      state: "failed" as const,
      artifact: undefined,
      failure: safeFailure(),
    };
    expect(parseMediaGenerationStatusDtoV1(failed)).not.toBeNull();
    for (const message of [
      "https://provider.example/download",
      "Provider said:\nretry with this queue",
      '{"provider_response":{"prompt":"raw creative text"}}',
      "provider queue id: private-coordinate",
    ]) {
      expect(parseMediaGenerationStatusDtoV1({
        ...queued,
        progress: { phase: "queued", message },
      })).toBeNull();
      expect(parseMediaGenerationStatusDtoV1({
        ...failed,
        failure: { ...safeFailure(), message },
      })).toBeNull();
    }
  });

  test("makes same-receipt retry and fresh paid generation unambiguous", () => {
    const needsAction = {
      ...readyDto(),
      state: "needs-action" as const,
      artifact: undefined,
      failure: safeFailure(),
      recoveryActions: [{
        actionId: ACTION_HANDLE,
        kind: "retry_same_receipt" as const,
        label: "Try again",
        newSpend: false,
      }],
    };
    expect(parseMediaGenerationStatusDtoV1(needsAction)).toEqual(needsAction);
    expect(parseMediaGenerationStatusDtoV1({
      ...needsAction,
      recoveryActions: [{ ...needsAction.recoveryActions[0], newSpend: true }],
    })).toBeNull();
    expect(parseMediaGenerationStatusDtoV1({
      ...needsAction,
      recoveryActions: [{ ...needsAction.recoveryActions[0], kind: "fresh_generation", newSpend: true }],
    })).not.toBeNull();
    expect(parseMediaGenerationStatusDtoV1({
      ...needsAction,
      recoveryActions: [{ ...needsAction.recoveryActions[0], kind: "fresh_generation", newSpend: false }],
    })).toBeNull();
  });

  test("uses the exact renderer-compatible recovery action vocabulary", () => {
    const recoveryActions = [
      "wait",
      "retry_same_receipt",
      "revise_prompt",
      "switch_model",
      "repair_venice",
      "fresh_generation",
    ].map((kind, index) => ({
      actionId: `serveractionhandle${index}x`,
      kind,
      label: `Action ${index + 1}`,
      newSpend: kind === "fresh_generation",
    }));
    const value = {
      ...readyDto(),
      state: "needs-action" as const,
      artifact: undefined,
      failure: safeFailure(),
      recoveryActions,
    };
    expect(parseMediaGenerationStatusDtoV1(value)).not.toBeNull();
    expect(parseMediaGenerationStatusDtoV1({
      ...value,
      recoveryActions: [{ ...recoveryActions[0]!, kind: "repair_account" }],
    })).toBeNull();
  });

  test("orders same-receipt revisions and ignores stale events", () => {
    const current = readyDto({ revision: 5 });
    expect(compareMediaGenerationStatusRevision(current, readyDto({ revision: 4 }))).toBe("older");
    expect(compareMediaGenerationStatusRevision(current, readyDto({ revision: 5 }))).toBe("same");
    expect(compareMediaGenerationStatusRevision(current, readyDto({ revision: 6 }))).toBe("newer");
    expect(compareMediaGenerationStatusRevision(current, readyDto({ receiptId: "mg_receipt_02", revision: 1 }))).toBe("different_receipt");
    expect(isStaleMediaGenerationStatus(current, readyDto({ revision: 4 }))).toBe(true);
    expect(isStaleMediaGenerationStatus(current, readyDto({ receiptId: "mg_receipt_02", revision: 1 }))).toBe(false);
  });
});
