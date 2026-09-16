import { describe, expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  MEDIA_GENERATION_CLEANUP_STATES,
  MEDIA_GENERATION_KINDS,
  MEDIA_GENERATION_STATES,
  type MediaGenerationPublicReceipt,
  type MediaGenerationRequestPayload,
  type MediaGenerationSafeSnapshot,
  mediaGenerations,
} from "../../src/schema";

describe("D525 durable media generation schema", () => {
  test("holds only receipt-safe durable lifecycle data", () => {
    expect(MEDIA_GENERATION_STATES).toEqual([
      "prequeue", "admitting", "queued", "retrieving", "saving", "ready", "needs_action", "failed", "unknown",
    ]);
    expect(MEDIA_GENERATION_KINDS).toEqual(["video", "music"]);
    expect(MEDIA_GENERATION_CLEANUP_STATES).toEqual(["pending", "completed"]);
    const config = getTableConfig(mediaGenerations);
    const names = config.columns.map((column) => column.name);
    for (const field of [
      "receipt_id", "owner_id", "room_id", "namespace_id", "approval_digest",
      "quote_digest", "safe_snapshot", "request_payload", "provider_queue_id", "admission_token",
      "admission_started_at", "safe_failure",
      "provider_execution_seconds", "provider_average_execution_seconds",
      "artifact_internal_id", "cleanup_state", "claim_owner", "claim_expires_at",
      "revision", "retain_until",
    ]) expect(names).toContain(field);
    for (const forbidden of ["prompt", "lyrics", "download_url", "signed_url", "api_key", "authorization", "raw_response"])
      expect(names).not.toContain(forbidden);
    const snapshot: MediaGenerationSafeSnapshot = {
      version: 1,
      normalizedSettings: { resolution: "720p", aspectRatio: "16:9", audioEnabled: true },
      inputSummary: { promptCharacters: 42, lyricsCharacters: 0 },
    };
    expect(snapshot.normalizedSettings).not.toHaveProperty("prompt");
    expect(snapshot.inputSummary).not.toHaveProperty("lyrics");
    expect(snapshot.inputSummary).not.toHaveProperty("referenceAssetCount");
    const requestPayload: MediaGenerationRequestPayload = {
      version: 1,
      model: "seedance-2-5-text-to-video-basic",
      prompt: "A storm at sea",
      normalizedSettings: { resolution: "720p", aspectRatio: "16:9" },
    };
    expect(requestPayload).toHaveProperty("prompt");
    expect(requestPayload).not.toHaveProperty("queueId");
    const publicReceipt = {} as MediaGenerationPublicReceipt;
    expect(publicReceipt).not.toHaveProperty("requestPayload");
    expect(publicReceipt).not.toHaveProperty("providerQueueId");
    expect(publicReceipt).not.toHaveProperty("admissionToken");
    expect(publicReceipt).not.toHaveProperty("admissionStartedAt");
  });

  test("pins receipt scope to the canonical Room/Namespace pair", () => {
    const config = getTableConfig(mediaGenerations);
    expect(config.foreignKeys.map((key) => key.getName())).toContain(
      "media_generations_room_namespace_fk",
    );
    const checks = config.checks.map((check) => check.name);
    for (const check of [
      "media_generations_admission_shape",
      "media_generations_safe_json",
      "media_generations_request_payload_shape",
      "media_generations_artifact_ready_shape",
      "media_generations_claim_shape",
      "media_generations_provider_timing_nonnegative",
    ]) expect(checks).toContain(check);
  });
});
