import { describe, expect, test } from "bun:test";
import "./first-party-live-review-extensions";
import {
  getLiveAppSessionExtension,
  getLiveReviewExtension,
  getLiveTaskDelegationToolIds,
  isDirectMutationLiveReviewExtension,
  isLiveReviewEnabled,
} from "./live-review-extension-registry";
import { TEST_MINI_APP_MANIFEST } from "../../tests/helpers/test-mini-app-manifest";

describe("live review extension registry", () => {
  test("contains boot-registered Writer review and Design direct-mutation extensions", () => {
    expect(getLiveReviewExtension("nautilo-writer")?.liveToolIds).toEqual([
      "edit-open-writer",
      "read-open-writer-range",
      "locate-open-writer-text",
    ]);
    expect(getLiveReviewExtension("agent-authored-writer")).toBeNull();
    expect(getLiveReviewExtension("nautilo-design")).toBeNull();
    expect(getLiveTaskDelegationToolIds("nautilo-writer")).toEqual([
      "edit-open-writer",
      "read-open-writer-range",
      "locate-open-writer-text",
    ]);
    expect(getLiveTaskDelegationToolIds("nautilo-design")).toBeNull();
    expect(getLiveTaskDelegationToolIds("unregistered-live-app")).toBeNull();
    const design = getLiveAppSessionExtension("nautilo-design");
    expect(design && isDirectMutationLiveReviewExtension(design) && design).toMatchObject({
      liveToolIds: ["inspect-open-design", "edit-open-design"],
      directMutationToolIds: ["edit-open-design"],
      taskDelegation: { mode: "direct_only" },
    });
  });

  test("requires both a manifest request and trusted extension", () => {
    expect(isLiveReviewEnabled({ ...TEST_MINI_APP_MANIFEST, liveReview: { enabled: true } })).toBe(false);
    expect(isLiveReviewEnabled({ ...TEST_MINI_APP_MANIFEST, id: "nautilo-writer" })).toBe(false);
    expect(isLiveReviewEnabled({ ...TEST_MINI_APP_MANIFEST, id: "nautilo-writer", liveReview: { enabled: true } })).toBe(true);
  });
});
