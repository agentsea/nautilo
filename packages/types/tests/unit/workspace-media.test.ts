import { describe, expect, test } from "bun:test";
import { workspaceMediaMimeMatchesInspection, workspaceMediaMimeMatchesKind } from "../../src/workspace-media";

describe("Workspace media MIME aliases", () => {
  test("accepts x-wav as audio and treats WAV labels as inspection-equivalent", () => {
    expect(workspaceMediaMimeMatchesKind("audio", "audio/x-wav")).toBe(true);
    expect(workspaceMediaMimeMatchesKind("video", "audio/x-wav")).toBe(false);
    expect(workspaceMediaMimeMatchesInspection("audio/x-wav", "audio/wav")).toBe(true);
    expect(workspaceMediaMimeMatchesInspection("audio/wav", "audio/x-wav")).toBe(true);
    expect(workspaceMediaMimeMatchesInspection("audio/x-wav", "audio/mpeg")).toBe(false);
  });
});
