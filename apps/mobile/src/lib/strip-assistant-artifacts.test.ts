import { describe, expect, test } from "bun:test";

import { stripAssistantArtifacts } from "./strip-assistant-artifacts";

describe("stripAssistantArtifacts — mobile assistant rendering", () => {
  test("strips observed voice emotion tags while preserving spoken prose", () => {
    expect(
      stripAssistantArtifacts(
        "[cheerful] Loud and clear, love — your voice came through.",
      ),
    ).toBe("Loud and clear, love — your voice came through.");
    expect(stripAssistantArtifacts("I am [excited] about this")).toBe(
      "I am about this",
    );
  });

  test("preserves unknown bracketed content markers", () => {
    expect(stripAssistantArtifacts("See [cite:42] and [todo]")).toBe(
      "See [cite:42] and [todo]",
    );
  });
});
