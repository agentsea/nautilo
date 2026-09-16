import { beforeEach, describe, expect, test } from "bun:test";
import { reapplyHappyDomGlobals } from "../../tests/bun-dom-preload";
import {
  getAppPreference,
  setAppPreference,
  subscribeAppPreferences,
  validateAppPreference,
} from "../../src/lib/app-preferences";

describe("app-scoped device preferences", () => {
  test("remembers a first-video policy per viewer, not a fixed fps or document value", () => {
    reapplyHappyDomGlobals();
    localStorage.clear();
    const key = "video.firstSourceRate";
    expect(getAppPreference("viewer-a", "nautilo-video", key)).toEqual({ decision: "ask" });
    expect(setAppPreference("viewer-a", "nautilo-video", key, { decision: "adopt-source-rate" })).toEqual({ decision: "adopt-source-rate" });
    expect(getAppPreference("viewer-a", "nautilo-video", key)).toEqual({ decision: "adopt-source-rate" });
    expect(getAppPreference("viewer-b", "nautilo-video", key)).toEqual({ decision: "ask" });
    expect(validateAppPreference("nautilo-design", key, { decision: "adopt-source-rate" })).toBeNull();
    expect(validateAppPreference("nautilo-video", key, { decision: "60" })).toBeNull();
    expect(validateAppPreference("nautilo-video", key, { decision: "ask", fps: 60 })).toBeNull();
    expect(setAppPreference("viewer-a", "nautilo-video", key, { decision: "ask" })).toEqual({ decision: "ask" });
  });
  beforeEach(() => {
    reapplyHappyDomGlobals();
    localStorage.clear();
  });

  test("keeps Writer spelling preferences viewer/app-scoped and reactive", () => {
    const seen: unknown[] = [];
    const unsubscribe = subscribeAppPreferences(
      "viewer-a",
      "nautilo-writer",
      (_key, value) => seen.push(value),
    );
    const value = {
      enabled: false,
      language: "en-US" as const,
      personalWords: ["Nautilo", "nautilo"],
    };
    expect(
      setAppPreference(
        "viewer-a",
        "nautilo-writer",
        "writer.spellcheck",
        value,
      ),
    ).toEqual({
      enabled: false,
      language: "en-US",
      personalWords: ["nautilo"],
    });
    expect(
      getAppPreference("viewer-a", "nautilo-writer", "writer.spellcheck")
        .enabled,
    ).toBe(false);
    expect(
      getAppPreference("viewer-b", "nautilo-writer", "writer.spellcheck")
        .enabled,
    ).toBe(true);
    expect(seen).toHaveLength(1);
    unsubscribe();
  });

  test("fails closed for corrupt, content-like, cross-app, and overlong values", () => {
    expect(
      validateAppPreference("other-app", "writer.spellcheck", {
        enabled: true,
        personalWords: [],
      }),
    ).toBeNull();
    expect(
      validateAppPreference("nautilo-writer", "writer.spellcheck", {
        enabled: true,
        language: "en-US",
        personalWords: ["two words"],
      }),
    ).toBeNull();
    expect(
      validateAppPreference("nautilo-writer", "writer.spellcheck", {
        enabled: true,
        language: "en-US",
        personalWords: Array.from({ length: 257 }, (_, i) => `word${i}`),
      }),
    ).toBeNull();
    localStorage.setItem(
      "nautilo.app-preferences.v1.viewer-a.nautilo-writer.writer.spellcheck",
      "not json",
    );
    expect(
      getAppPreference("viewer-a", "nautilo-writer", "writer.spellcheck"),
    ).toEqual({
      enabled: true,
      language: "en-US",
      personalWords: [],
    });
  });

  test("persists Design receipt visibility without accepting cross-app or extra fields", () => {
    expect(getAppPreference("viewer-a", "nautilo-design", "design.agentReceipts")).toEqual({ enabled: true });
    expect(setAppPreference("viewer-a", "nautilo-design", "design.agentReceipts", { enabled: false })).toEqual({ enabled: false });
    expect(getAppPreference("viewer-a", "nautilo-design", "design.agentReceipts")).toEqual({ enabled: false });
    expect(validateAppPreference("nautilo-writer", "design.agentReceipts", { enabled: false })).toBeNull();
    expect(validateAppPreference("nautilo-design", "design.agentReceipts", { enabled: false, document: "no" })).toBeNull();
  });

  test("keeps Video receipt visibility viewer/app-scoped and closed to other fields", () => {
    const seen: unknown[] = [];
    const unsubscribe = subscribeAppPreferences(
      "viewer-a",
      "nautilo-video",
      (_key, value) => seen.push(value),
    );
    expect(
      getAppPreference("viewer-a", "nautilo-video", "video.agentReceipts"),
    ).toEqual({ enabled: true });
    expect(
      setAppPreference("viewer-a", "nautilo-video", "video.agentReceipts", {
        enabled: false,
      }),
    ).toEqual({ enabled: false });
    expect(
      getAppPreference("viewer-b", "nautilo-video", "video.agentReceipts"),
    ).toEqual({ enabled: true });
    expect(seen).toEqual([{ enabled: false }]);
    expect(
      validateAppPreference("nautilo-design", "video.agentReceipts", {
        enabled: false,
      }),
    ).toBeNull();
    expect(
      validateAppPreference("nautilo-video", "video.agentReceipts", {
        enabled: false,
        document: "no",
      }),
    ).toBeNull();
    unsubscribe();
  });
});
