import { describe, expect, test } from "bun:test";
import {
  generatedMediaStateLabel,
  mapMediaGenerationStatusToEnvelope,
  parseGeneratedMediaEnvelope,
  type GeneratedMediaEnvelope,
} from "./generated-media-envelope";

function envelope(overrides: Partial<GeneratedMediaEnvelope> = {}): GeneratedMediaEnvelope {
  return {
    kind: "generated_media",
    version: 1,
    receiptId: "mg_1234567890abcdef",
    queueStarted: true,
    mediaKind: "video",
    state: "ready",
    model: "seedance-2-5-text-to-video-basic",
    promptSummary: "A bright sailboat crossing calm water.",
    settings: { durationSeconds: 5, resolution: "720p", aspectRatio: "16:9", audio: true },
    artifact: {
      artifactId: "media-1",
      path: "generated-media/sailboat.mp4",
      zone: "workspace",
      mime: "video/mp4",
      bytes: 1_024,
    },
    recoveryActions: [],
    ...overrides,
  };
}

describe("parseGeneratedMediaEnvelope", () => {
  test("accepts a narrow ready envelope", () => {
    expect(parseGeneratedMediaEnvelope(JSON.stringify(envelope()))).toEqual(envelope());
  });

  test("binds queue certainty to a validated server-local receipt", () => {
    const queued = envelope({ state: "queued", artifact: undefined });
    expect(parseGeneratedMediaEnvelope(JSON.stringify(queued))).toEqual(queued);
    expect(parseGeneratedMediaEnvelope(JSON.stringify({ ...queued, receiptId: undefined }))).toBeNull();
    expect(parseGeneratedMediaEnvelope(JSON.stringify({ ...queued, receiptId: "venice-provider-receipt" }))).toBeNull();
    expect(parseGeneratedMediaEnvelope(JSON.stringify({ ...queued, queueStarted: false }))).toBeNull();

    const unbound = envelope({
      receiptId: undefined,
      queueStarted: false,
      state: "failed",
      artifact: undefined,
      failure: { code: "APPROVAL_STALE", message: "Request a fresh exact quote." },
    });
    expect(parseGeneratedMediaEnvelope(JSON.stringify(unbound))).toEqual(unbound);

    const unknown = envelope({
      queueStarted: null,
      state: "unknown",
      artifact: undefined,
      failure: { code: "ADMISSION_UNKNOWN", message: "Check status before starting another generation." },
    });
    expect(parseGeneratedMediaEnvelope(JSON.stringify(unknown))).toEqual(unknown);
    expect(parseGeneratedMediaEnvelope(JSON.stringify({ ...unknown, receiptId: undefined }))).toBeNull();
    expect(parseGeneratedMediaEnvelope(JSON.stringify({ ...unknown, state: "failed" }))).toBeNull();
    expect(parseGeneratedMediaEnvelope(JSON.stringify({ ...unknown, queueStarted: true }))).toBeNull();

    const submitting = envelope({
      queueStarted: null,
      state: "submitting",
      artifact: undefined,
    });
    expect(parseGeneratedMediaEnvelope(JSON.stringify(submitting))).toEqual(submitting);
    expect(parseGeneratedMediaEnvelope(JSON.stringify({ ...submitting, receiptId: undefined }))).toBeNull();
    expect(parseGeneratedMediaEnvelope(JSON.stringify({ ...submitting, queueStarted: false }))).toBeNull();
  });

  test("maps strict status without replacing the safe prompt or exposing topology", () => {
    const current = envelope({ state: "queued", artifact: undefined });
    const mapped = mapMediaGenerationStatusToEnvelope({
      dtoVersion: 1,
      receiptId: current.receiptId!,
      revision: 4,
      mediaKind: "video",
      state: "ready",
      modelId: "seedance-2-5-text-to-video-basic",
      settings: { durationSeconds: 5, resolution: "720p", aspectRatio: "16:9", audioEnabled: true },
      artifact: {
        artifactId: "media-2",
        path: "generated-media/ready.mp4",
        zone: "workspace",
        mime: "video/mp4",
        bytes: 2_048,
      },
      recoveryActions: [],
    }, current);
    expect(mapped).toMatchObject({
      receiptId: current.receiptId,
      queueStarted: true,
      state: "ready",
      promptSummary: current.promptSummary,
      artifact: { artifactId: "media-2" },
    });
    expect(JSON.stringify(mapped)).not.toContain("providerUrl");
    expect(mapMediaGenerationStatusToEnvelope({
      dtoVersion: 1,
      receiptId: "mg_different12345678",
      revision: 5,
      mediaKind: "video",
      state: "queued",
      modelId: "seedance-2-5-text-to-video-basic",
      settings: {},
      progress: { phase: "queued" },
      recoveryActions: [],
    }, current)).toBeNull();

    const boundDto = {
      dtoVersion: 1 as const,
      receiptId: current.receiptId!,
      revision: 6,
      mediaKind: "video" as const,
      state: "queued" as const,
      modelId: "seedance-2-5-text-to-video-basic",
      settings: { durationSeconds: 5, resolution: "720p", aspectRatio: "16:9", audioEnabled: true },
      progress: { phase: "queued" as const },
      recoveryActions: [],
    };
    expect(mapMediaGenerationStatusToEnvelope({ ...boundDto, mediaKind: "audio" }, current)).toBeNull();
    expect(mapMediaGenerationStatusToEnvelope({ ...boundDto, modelId: "minimax-h3-enhanced-text-to-video" }, current)).toBeNull();
    expect(mapMediaGenerationStatusToEnvelope({
      ...boundDto,
      settings: { ...boundDto.settings, durationSeconds: 10 },
    }, current)).toBeNull();
    expect(mapMediaGenerationStatusToEnvelope({
      ...boundDto,
      state: "submitting",
      progress: { phase: "submitting" },
    }, current)).toMatchObject({
      receiptId: current.receiptId,
      queueStarted: null,
      state: "submitting",
    });
  });

  test("hydrates a ready reference-video receipt while retaining its safe reference count", () => {
    const current = envelope({
      state: "queued",
      artifact: undefined,
      model: "seedance-2-5-reference-to-video-basic",
      settings: {
        durationSeconds: 10,
        resolution: "720p",
        aspectRatio: "16:9",
        audio: true,
        referenceImages: 1,
      },
    });
    const dto = {
      dtoVersion: 1 as const,
      receiptId: current.receiptId!,
      revision: 35,
      mediaKind: "video" as const,
      state: "ready" as const,
      modelId: "seedance-2-5-reference-to-video-basic",
      settings: { durationSeconds: 10, resolution: "720p", aspectRatio: "16:9", audioEnabled: true },
      artifact: {
        artifactId: "reference-video-1",
        path: "generated-media/reference.mp4",
        zone: "workspace" as const,
        mime: "video/mp4",
        bytes: 4_792_167,
      },
      recoveryActions: [],
    };
    expect(mapMediaGenerationStatusToEnvelope(dto, current)).toMatchObject({
      state: "ready",
      artifact: { artifactId: "reference-video-1" },
      settings: { referenceImages: 1 },
    });
    expect(mapMediaGenerationStatusToEnvelope(dto, {
      ...current,
      settings: { ...current.settings, referenceImages: 31 },
    })).toBeNull();
  });

  test("requires a Workspace artifact for ready media", () => {
    const value = envelope();
    delete value.artifact;
    expect(parseGeneratedMediaEnvelope(JSON.stringify(value))).toBeNull();
  });

  test("rejects provider topology and URL-shaped values", () => {
    expect(parseGeneratedMediaEnvelope(JSON.stringify({
      ...envelope(),
      queueId: "provider-queue-should-never-reach-browser",
    }))).toBeNull();
    expect(parseGeneratedMediaEnvelope(JSON.stringify({
      ...envelope(),
      artifact: { ...envelope().artifact!, signedUrl: "https://provider.example/download" },
    }))).toBeNull();
    expect(parseGeneratedMediaEnvelope(JSON.stringify({
      ...envelope(),
      settings: { resolution: "https://provider.example/setting" },
    }))).toBeNull();
  });

  test("only permits typed recovery actions and marks fresh work as new spend", () => {
    const fresh = envelope({
      queueStarted: false,
      state: "needs-action",
      artifact: undefined,
      failure: { code: "CONTENT_POLICY", message: "Revise the prompt or switch models." },
      recoveryActions: [{
        actionId: "safe-action-1",
        kind: "fresh_generation",
        label: "Start fresh generation",
        newSpend: true,
      }],
    });
    expect(parseGeneratedMediaEnvelope(JSON.stringify(fresh))).toEqual(fresh);
    expect(parseGeneratedMediaEnvelope(JSON.stringify({
      ...fresh,
      recoveryActions: [{ ...fresh.recoveryActions[0], newSpend: false }],
    }))).toBeNull();
    expect(parseGeneratedMediaEnvelope(JSON.stringify({
      ...fresh,
      recoveryActions: [{ ...fresh.recoveryActions[0], kind: "retry_queue" }],
    }))).toBeNull();
  });

  test("requires a safe typed failure for failed media", () => {
    const failed = envelope({
      queueStarted: false,
      state: "failed",
      artifact: undefined,
      failure: { code: "CONTENT_POLICY", message: "The provider declined this request.", creditsRefunded: true },
      recoveryActions: [{ actionId: "revise-1", kind: "revise_prompt", label: "Revise prompt", newSpend: false }],
    });
    expect(parseGeneratedMediaEnvelope(JSON.stringify(failed))).toEqual(failed);
    expect(parseGeneratedMediaEnvelope(JSON.stringify({ ...failed, failure: undefined }))).toBeNull();
  });
});

describe("generatedMediaStateLabel", () => {
  test("names every durable state honestly", () => {
    expect(generatedMediaStateLabel("unknown")).toContain("unknown");
    expect(generatedMediaStateLabel("submitting")).toContain("awaiting provider acknowledgement");
    expect(generatedMediaStateLabel("cleanup-pending")).toContain("cleanup pending");
  });
});
