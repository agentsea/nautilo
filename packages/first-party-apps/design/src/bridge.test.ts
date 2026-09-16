import { describe, expect, test } from "bun:test";
import {
  isNoDocumentError,
  isPatchAppliedDocumentChange,
  isReloadRequiredDocumentChange,
  parseDocumentEnvelope,
  type NautiloDocumentChangeEvent,
} from "./bridge";

describe("bridge document change events", () => {
  test("isPatchAppliedDocumentChange narrows patch_applied events", () => {
    const event: NautiloDocumentChangeEvent = {
      type: "patch_applied",
      patchId: "patch-1",
      revision: 2,
      sha256: "next-sha",
      previousRevision: 1,
      previousSha256: "base-sha",
      patch: { kind: "anchored_text", oldString: "a\n", newString: "b\n" },
      author: { kind: "app_tool", displayName: "nautilo-design" },
      rebased: false,
      envelope: { content: "b\n", baseSha256: "next-sha", baseRevision: 2 },
    };
    expect(isPatchAppliedDocumentChange(event)).toBe(true);
    if (isPatchAppliedDocumentChange(event)) {
      expect(event.patchId).toBe("patch-1");
      expect(event.envelope.content).toBe("b\n");
      expect(event).toMatchObject({
        previousRevision: 1,
        previousSha256: "base-sha",
        author: { kind: "app_tool", displayName: "nautilo-design" },
        rebased: false,
        envelope: { baseSha256: "next-sha", baseRevision: 2 },
      });
    }
  });

  test("isReloadRequiredDocumentChange narrows changed events with reloadRequired", () => {
    const reload: NautiloDocumentChangeEvent = { type: "changed", reloadRequired: true };
    const plain: NautiloDocumentChangeEvent = { type: "changed" };
    expect(isReloadRequiredDocumentChange(reload)).toBe(true);
    expect(isReloadRequiredDocumentChange(plain)).toBe(false);
    expect(isPatchAppliedDocumentChange(plain)).toBe(false);
  });
});

describe("isNoDocumentError", () => {
  test("matches the host no-document message", () => {
    expect(isNoDocumentError(new Error("No document is bound to this app."))).toBe(true);
    expect(isNoDocumentError(new Error("something else"))).toBe(false);
    expect(isNoDocumentError("not an error")).toBe(false);
  });
});

describe("parseDocumentEnvelope", () => {
  test("returns a normalized envelope for a valid host response", () => {
    const envelope = parseDocumentEnvelope({
      content: "<html></html>",
      path: "workspace/Hero.design.html",
      baseSha256: "abc",
      baseRevision: 3,
    });
    expect(envelope).toEqual({
      content: "<html></html>",
      path: "workspace/Hero.design.html",
      baseSha256: "abc",
      baseRevision: 3,
    });
  });

  test("defaults missing sha/revision to null and omits absent path", () => {
    const envelope = parseDocumentEnvelope({ content: "x" });
    expect(envelope).toEqual({ content: "x", baseSha256: null, baseRevision: null });
  });

  test("returns null when content is missing or value is not an object", () => {
    expect(parseDocumentEnvelope({ path: "x" })).toBeNull();
    expect(parseDocumentEnvelope(null)).toBeNull();
    expect(parseDocumentEnvelope("string")).toBeNull();
  });
});
