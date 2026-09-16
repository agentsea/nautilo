import { describe, expect, test } from "bun:test";

import { DTO_BASELINE_DECLARATIONS } from "../../baseline/dto-declarations";
import { BASELINE_REGISTRY } from "../../baseline/existing-debt";
import {
  REVIEWED_MAIN_2026_08_17_SOURCE_ALARMS,
  SUPERSEDED_MAIN_2026_08_17_SOURCE_ALARM_LOCATORS,
} from "../../baseline/reviewed-main-2026-08-17-source-alarms";
import { REVIEWED_MAIN_2026_08_22_SOURCE_ALARMS } from "../../baseline/reviewed-main-2026-08-22-source-alarms";
import { SUPERSEDED_MAIN_2026_08_29_SOURCE_ALARM_LOCATORS } from "../../baseline/reviewed-main-2026-08-29-source-alarms";
import { CURRENT_SOURCE_ALARM_REVIEWS } from "../../src/node/source-alarm-review";

const MEDIA_LIFECYCLE_FIELDS = [
  "completion_wake_claimed_at",
  "completion_wake_delivered_at",
  "initiating_agent_id",
  "initiating_thread_id",
  "provider_average_execution_seconds",
  "provider_execution_seconds",
] as const;

const WORKCARD_INPUT_LOCATORS = [
  {
    declaration:
      "http:accepted_arbitrary:packages/server/src/messaging/dispatch.ts#RoomPostMessageBody",
    coverage:
      "http:accepted_arbitrary:packages/server/src/messaging/dispatch.ts#RoomPostMessageBody#cardContinuation",
  },
  {
    declaration: "http:request_response:POST /api/rooms/:roomId/messages",
    coverage:
      "http:request_response:POST /api/rooms/:roomId/messages#request.body.cardContinuation",
  },
] as const;

describe("reviewed 2026-08-17 encryption inventory", () => {
  test("keeps media wake and timing state bounded and content-free", () => {
    for (const field of MEDIA_LIFECYCLE_FIELDS) {
      const entry = BASELINE_REGISTRY.entries.find((candidate) =>
        candidate.locator === `public.media_generations.${field}`
      );
      expect(entry).toMatchObject({
        surface: "db",
        classification: "bounded_metadata",
        metadataAllowlist: [field],
      });
      if (entry?.classification !== "bounded_metadata") {
        throw new Error(`${field} must remain bounded metadata`);
      }
      expect(entry.plaintextReason).toContain("no prompt");
      expect(entry.plaintextReason).toContain("credential");
      expect(entry.plaintextReason).toContain("key");
      expect(entry.plaintextReason).toContain("message content");
    }

    expect(BASELINE_REGISTRY.entries.some((entry) =>
      entry.locator === "public.media_generations.request_payload"
    )).toBe(false);
  });

  test("keeps advanced-video continuation a closed content-free marker", () => {
    for (const locator of WORKCARD_INPUT_LOCATORS) {
      const entry = BASELINE_REGISTRY.entries.find((candidate) =>
        candidate.locator === locator.coverage
      );
      expect(entry).toMatchObject({
        surface: "wire",
        classification: "bounded_metadata",
        metadataAllowlist: ["advanced_video"],
      });
      if (entry?.classification !== "bounded_metadata") {
        throw new Error(`${locator.coverage} must remain bounded metadata`);
      }
      expect(entry.plaintextReason).toContain("exactly the literal advanced_video");
      expect(entry.plaintextReason).toContain("no prompt");

      const declaration = DTO_BASELINE_DECLARATIONS.find((candidate) =>
        candidate.locator === locator.declaration
      );
      expect(declaration?.structuralSignatures?.join("\n")).toContain(
        "cardContinuation",
      );
      expect(declaration?.arbitraryPayloads.some((payload) =>
        payload.schema === "AdvancedVideoWorkcardContinuationV1"
      )).toBe(true);
    }
  });

  test("declares output annotations as closed metadata", () => {
    for (const locator of [
      "http:request_response:GET /api/rooms/:id/messages/:messageId/around",
      "http:request_response:GET /api/rooms/:id/messages",
      "http:request_response:GET /api/rooms/:id/thread-detail",
      "http:request_response:GET /api/sessions/latest",
    ]) {
      const declaration = DTO_BASELINE_DECLARATIONS.find((candidate) =>
        candidate.locator === locator
      );
      expect(declaration?.structuralSignatures?.join("\n")).toContain(
        'workcardContinuation?:{kind:"advanced_video";referenceCount:number}',
      );
      expect(declaration?.arbitraryPayloads).toEqual(
        locator === "http:request_response:GET /api/rooms/:id/messages"
          ? [{
            path: "response.body.shadowEncryption",
            schema: "ProtectedMessageDtoV2",
          }]
          : [],
      );
    }
  });

  test("closes the two new source alarms without hiding plaintext debt", () => {
    expect(REVIEWED_MAIN_2026_08_17_SOURCE_ALARMS).toHaveLength(2);
    expect(REVIEWED_MAIN_2026_08_17_SOURCE_ALARMS[0]).toMatchObject({
      closure: "declaration",
      declarationId: "source.file.desktop-local-history",
    });
    expect(REVIEWED_MAIN_2026_08_17_SOURCE_ALARMS[0]?.reason).toContain(
      "plaintext file debt",
    );
    expect(REVIEWED_MAIN_2026_08_17_SOURCE_ALARMS[1]).toMatchObject({
      closure: "reviewed_exclusion",
      exclusionId: "exclusion.main-2026-08-17.portable-restore-list",
    });
    for (const review of REVIEWED_MAIN_2026_08_17_SOURCE_ALARMS) {
      expect(CURRENT_SOURCE_ALARM_REVIEWS).toContainEqual(review);
    }
    for (const locator of SUPERSEDED_MAIN_2026_08_17_SOURCE_ALARM_LOCATORS) {
      const reintroduced = REVIEWED_MAIN_2026_08_22_SOURCE_ALARMS.find(
        (review) => review.locator === locator,
      );
      expect(CURRENT_SOURCE_ALARM_REVIEWS.some((review) =>
        review.locator === locator
      )).toBe(
        reintroduced !== undefined
        && !SUPERSEDED_MAIN_2026_08_29_SOURCE_ALARM_LOCATORS.has(locator)
      );
    }
  });
});
