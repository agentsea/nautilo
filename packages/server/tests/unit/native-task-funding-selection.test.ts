import { beforeEach, describe, expect, test } from "bun:test";
import { resetModelCapabilitiesCacheForTests } from "@nautilo/model-capabilities";

import {
  assertNativeTaskRetainedModelSelection,
  nativeTaskSelectionPurpose,
  validateNativeTaskExactModelSelection,
} from "../../src/lib/native-task-funding";

const NULL_TOOLS_MODEL = "google:gemini-2.5-pro";
const GOOGLE_ENV: NodeJS.ProcessEnv = { GOOGLE_API_KEY: "synthetic-test-key" };

beforeEach(() => {
  resetModelCapabilitiesCacheForTests();
  process.env["NAUTILO_SKIP_VENICE_REFRESH"] = "1";
});

describe("native caller-funded Task model selection", () => {
  test("derives the shared canonical tool need from auto, none, and whitelist modes", () => {
    expect(nativeTaskSelectionPurpose({ toolsMode: "auto", toolsWhitelist: [] }))
      .toBe("task-tools");
    expect(nativeTaskSelectionPurpose({ toolsMode: undefined, toolsWhitelist: undefined }))
      .toBe("task-tools");
    expect(nativeTaskSelectionPurpose({ toolsMode: "none", toolsWhitelist: [] }))
      .toBe("chat");
    expect(nativeTaskSelectionPurpose({ toolsMode: "whitelist", toolsWhitelist: [] }))
      .toBe("chat");
    expect(nativeTaskSelectionPurpose({ toolsMode: "whitelist", toolsWhitelist: ["file"] }))
      .toBe("task-tools");
  });

  test("passes canonical tool intent through the shared exact-model validator", () => {
    const selection = {
      requestedModelId: NULL_TOOLS_MODEL,
    } as const;

    expect(validateNativeTaskExactModelSelection({
      ...selection,
      toolsMode: "none",
      toolsWhitelist: [],
    }, GOOGLE_ENV)).toBeNull();
    expect(validateNativeTaskExactModelSelection({
      ...selection,
      toolsMode: "whitelist",
      toolsWhitelist: [],
    }, GOOGLE_ENV)).toBeNull();
    expect(validateNativeTaskExactModelSelection({
      ...selection,
      toolsMode: "auto",
      toolsWhitelist: [],
    }, GOOGLE_ENV)).toMatchObject({ code: "capability_mismatch" });
    expect(validateNativeTaskExactModelSelection({
      ...selection,
      toolsMode: "whitelist",
      toolsWhitelist: ["file"],
    }, GOOGLE_ENV)).toMatchObject({ code: "capability_mismatch" });
  });

  test("retained and resumed model pins are checked against the same tool need", () => {
    expect(() => assertNativeTaskRetainedModelSelection(NULL_TOOLS_MODEL, {
      toolsMode: "none",
      toolsWhitelist: [],
    }, GOOGLE_ENV)).not.toThrow();
    expect(() => assertNativeTaskRetainedModelSelection(NULL_TOOLS_MODEL, {
      toolsMode: "whitelist",
      toolsWhitelist: [],
    }, GOOGLE_ENV)).not.toThrow();
    expect(() => assertNativeTaskRetainedModelSelection(NULL_TOOLS_MODEL, {
      toolsMode: "auto",
      toolsWhitelist: [],
    }, GOOGLE_ENV)).toThrow("unsupported_provider");
    expect(() => assertNativeTaskRetainedModelSelection(NULL_TOOLS_MODEL, {
      toolsMode: "whitelist",
      toolsWhitelist: ["file"],
    }, GOOGLE_ENV)).toThrow("unsupported_provider");
  });
});
