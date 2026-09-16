import { describe, expect, test } from "bun:test";
import {
  isDocumentPatchAppliedEvent,
  isReloadRequiredDocumentChange,
  isSafeVideoGenerationRequestPrompt,
  type NautiloVideoPreviewRequest,
  type NautiloVideoGenerationRequest,
  type NautiloVideoGenerationReferenceImportResult,
  type NautiloDocumentChangeEvent,
} from "./bridge";

describe("video bridge change events", () => {
  test("narrows reload-required changes", () => {
    const reload: NautiloDocumentChangeEvent = { type: "changed", reloadRequired: true };
    const plain: NautiloDocumentChangeEvent = { type: "changed" };

    expect(isReloadRequiredDocumentChange(reload)).toBe(true);
    expect(isReloadRequiredDocumentChange(plain)).toBe(false);
  });

  test("narrows patch-applied events", () => {
    const event: NautiloDocumentChangeEvent = {
      type: "patch_applied",
      revision: 2,
      sha256: "next",
      previousRevision: 1,
      previousSha256: "base",
      envelope: {
        content: "<html></html>",
        baseSha256: "next",
        baseRevision: 2,
      },
    };

    expect(isDocumentPatchAppliedEvent(event)).toBe(true);
    if (isDocumentPatchAppliedEvent(event)) {
      expect(event.envelope.baseSha256).toBe("next");
    }
  });

  test("keeps the quote handoff to one saved text-only job", () => {
    const request: NautiloVideoGenerationRequest = {
      document: { sha256: "a".repeat(64), revision: 3 },
      sourceFingerprint: `sha256:${"b".repeat(64)}`,
      job: {
        source: { kind: "shot", shotId: "shot-1" },
        shotLabel: "Opening image",
        modelId: "venice:seedance-2-5-text-to-video-basic",
        prompt: "Goal:\nA moving image.",
      },
    };

    expect(request).toEqual({
      document: { sha256: "a".repeat(64), revision: 3 },
      sourceFingerprint: `sha256:${"b".repeat(64)}`,
      job: {
        source: { kind: "shot", shotId: "shot-1" },
        shotLabel: "Opening image",
        modelId: "venice:seedance-2-5-text-to-video-basic",
        prompt: "Goal:\nA moving image.",
      },
    });
  });

  test("preserves the full prompt for canonical model validation", () => {
    expect(isSafeVideoGenerationRequestPrompt("A moving image.")).toBe(true);
    expect(isSafeVideoGenerationRequestPrompt("   ")).toBe(false);
    expect(isSafeVideoGenerationRequestPrompt("景".repeat(15_000))).toBe(true);
    expect(isSafeVideoGenerationRequestPrompt("a".repeat(15_001))).toBe(true);
    expect(isSafeVideoGenerationRequestPrompt(null)).toBe(false);
  });

  test("keeps durable Workspace playback on the opaque media-id request branch", () => {
    const workspaceRequest: NautiloVideoPreviewRequest = { mediaId: "media-generated-opening" };
    const currentFolderRequest: NautiloVideoPreviewRequest = { ref: "rushes/opening.mp4" };

    expect(workspaceRequest).toEqual({ mediaId: "media-generated-opening" });
    expect(currentFolderRequest).toEqual({ ref: "rushes/opening.mp4" });
  });

  test("keeps reference picker output to safe public lineage", () => {
    const result: NautiloVideoGenerationReferenceImportResult = {
      kind: "ready",
      asset: {
        artifactId: "018f1234-5678-7123-8123-123456789abc",
        path: "video-references/portrait.png",
        label: "Portrait",
        mediaKind: "image",
        mimeType: "image/png",
        sizeBytes: 1024,
      },
    };
    expect(result).toEqual({
      kind: "ready",
      asset: {
        artifactId: "018f1234-5678-7123-8123-123456789abc",
        path: "video-references/portrait.png",
        label: "Portrait",
        mediaKind: "image",
        mimeType: "image/png",
        sizeBytes: 1024,
      },
    });
  });
});
