import { describe, expect, test } from "bun:test";
import {
  RELAY_BROWSER_PAGE_CONTINUATION_PROTOCOL_VERSION,
  RELAY_BROWSER_PAGE_SNAPSHOT_REFERENCE_PROTOCOL_VERSION,
  RELAY_MIN_SUPPORTED_PROTOCOL_VERSION,
  RELAY_PROTOCOL_VERSION,
  projectRelayCapabilitiesForProtocol,
} from "../../src/protocol";
import {
  BROWSER_RESEARCH_READ_PROTOCOL_VERSION,
  canRelayExecuteBrowserResearchRead,
  canRelayExecuteBrowserResearchConsentRecovery,
  parseRelayBrowserResearchReadRequest,
  parseRelayBrowserResearchConsentRecoveryRequest,
  parseRelayBrowserResearchConsentRecoveryResult,
  parseRelayBrowserResearchSnapshotInspectionRequest,
  parseRelayBrowserResearchSnapshotInspectionResult,
  parseRelayBrowserResearchReadResult,
  type RelayCapabilities,
} from "../../src/types";

const CAPABILITIES: RelayCapabilities = {
  profile: "desktop-agent",
  canControlBrowser: true,
  canContinueBrowserPageRead: true,
  canInspectBrowserPageSnapshot: true,
  canReplayResearchConsent: true,
  canRecoverResearchConsent: true,
  canSearchResearchWeb: true,
};

describe("D504 browser-page continuation and snapshot-reference protocols", () => {
  test("keeps v12 continuation while projecting v13 inspection away", () => {
    expect(RELAY_PROTOCOL_VERSION).toBe(20);
    expect(RELAY_BROWSER_PAGE_CONTINUATION_PROTOCOL_VERSION).toBe(12);
    expect(RELAY_BROWSER_PAGE_SNAPSHOT_REFERENCE_PROTOCOL_VERSION).toBe(13);
    expect(BROWSER_RESEARCH_READ_PROTOCOL_VERSION).toBe(12);
    expect(RELAY_MIN_SUPPORTED_PROTOCOL_VERSION).toBe(9);
    expect(projectRelayCapabilitiesForProtocol(CAPABILITIES, 11)).toEqual({
      profile: "desktop-agent", canControlBrowser: true,
    });
    expect(projectRelayCapabilitiesForProtocol(CAPABILITIES, 12)).toEqual({
      profile: "desktop-agent", canControlBrowser: true,
      canContinueBrowserPageRead: true, canSearchResearchWeb: true,
    });
    expect(projectRelayCapabilitiesForProtocol(CAPABILITIES, 13)).toEqual(CAPABILITIES);
  });

  test("keeps ordinary visible browser reads at v11 while research reads require the v12 result contract", () => {
    const research = { ...CAPABILITIES, canResearchWeb: true };
    expect(canRelayExecuteBrowserResearchRead(11, research)).toBe(false);
    expect(canRelayExecuteBrowserResearchRead(12, research)).toBe(true);
  });

  test("strictly bounds ordered consent-label replay to initial URL reads", () => {
    const identity = { toolCallId: "tool-consent", laneKey: "room-1" };
    expect(parseRelayBrowserResearchReadRequest({
      ...identity,
      url: "https://example.test/article",
      consentActions: ["Manage preferences", "Reject optional", "Save choices"],
    })).toMatchObject({ ok: true, request: { consentActions: ["Manage preferences", "Reject optional", "Save choices"] } });
    expect(parseRelayBrowserResearchReadRequest({
      ...identity,
      url: "https://example.test/article",
      consentActions: ["x".repeat(161)],
    })).toEqual({ ok: false, error: "browser research consentActions are invalid" });
    expect(parseRelayBrowserResearchReadRequest({
      ...identity,
      continuation: { version: 1, reference: "a".repeat(43), offsetCharacters: 0, mode: "page" },
      consentActions: ["Reject optional"],
    })).toEqual({ ok: false, error: "browser research continuation request is malformed" });
  });

  test("strictly gates bounded same-target consent recovery to capable v13 Desktops", () => {
    const reference = "r".repeat(43);
    const identity = { toolCallId: "tool-consent", laneKey: "room-1" };
    expect(canRelayExecuteBrowserResearchConsentRecovery(12, { ...CAPABILITIES, canResearchWeb: true })).toBe(false);
    expect(canRelayExecuteBrowserResearchConsentRecovery(13, { ...CAPABILITIES, canResearchWeb: true })).toBe(true);
    expect(parseRelayBrowserResearchConsentRecoveryRequest({
      ...identity,
      consentRecovery: { version: 1, reference, operation: "click_coordinates", x: 400, y: 300 },
    })).toMatchObject({ ok: true });
    expect(parseRelayBrowserResearchConsentRecoveryRequest({
      ...identity,
      consentRecovery: { version: 1, reference, operation: "click_control", label: "Reject all", selector: "#reject" },
    })).toEqual({ ok: false, error: "browser research consent recovery request is malformed" });
    expect(parseRelayBrowserResearchConsentRecoveryResult({
      kind: "browser_research_consent_recovery", operation: "screenshot", reference,
      expiresAt: "2026-08-10T12:00:00.000Z", state: "consent_wall",
      viewport: { cssWidth: 800, cssHeight: 600, imageWidth: 1600, imageHeight: 1200, scale: 2 },
      image: { mime: "image/png", base64: "aGVsbG8=" },
    })).toMatchObject({ ok: true });
    expect(parseRelayBrowserResearchConsentRecoveryResult({
      kind: "browser_research_consent_recovery", operation: "click_coordinates", reference,
      expiresAt: "2026-08-10T12:00:00.000Z", state: "cleared", cdpUrl: "ws://127.0.0.1:9222",
    })).toEqual({ ok: false, error: "browser research consent recovery result is malformed" });
  });

  test("strictly admits an EOF page reference and same-owner eviction receipt, while preserving old result shapes", () => {
    const result = {
      targetRole: "research",
      requestedUrl: "https://example.test/requested",
      finalUrl: "https://example.test/final",
      title: "Example page",
      content: "Evidence",
      blocks: [],
      totalCharacters: 8,
      totalCharactersCapped: false,
      totalBytes: 8,
      estimatedTokens: 2,
      offsetCharacters: 0,
      nextOffsetCharacters: 8,
      returnedCharacters: 8,
      remainingCharacters: 0,
      eof: true,
      truncated: false,
      contextClamped: false,
      extraction: { method: "mozilla-readability-turndown-v1", root: "article", iframeCount: 0 },
      timing: { readiness: "complete" },
      quality: "complete",
      challenge: { detected: false, confidence: "none", signals: [] },
      failure: "none",
      diagnostics: [],
    };
    const reference = "a".repeat(43);
    expect(parseRelayBrowserResearchReadResult(result)).toMatchObject({ ok: true });
    expect(parseRelayBrowserResearchReadResult({
      ...result,
      failure: "consent-wall",
      quality: "partial",
      diagnostics: ["consent-wall-remained"],
    })).toMatchObject({ ok: true });
    expect(parseRelayBrowserResearchReadResult({
      ...result,
      pageReference: { version: 1, reference, expiresAt: "2026-08-09T00:00:00.000Z" },
      evictedPageReferences: [{
        version: 1,
        reference: "b".repeat(43),
        title: "Previous page",
        finalUrl: "https://example.test/previous",
      }],
    })).toMatchObject({ ok: true });
    expect(parseRelayBrowserResearchReadResult({
      ...result,
      pageReference: { version: 1, reference, expiresAt: "2026-08-09T00:00:00.000Z", leaked: true },
    })).toEqual({ ok: false, error: "browser research read result is malformed" });
    expect(parseRelayBrowserResearchReadResult({
      ...result,
      evictedPageReferences: [],
    })).toEqual({ ok: false, error: "browser research read result is malformed" });
    expect(parseRelayBrowserResearchReadResult({
      ...result,
      pageReference: { version: 1, reference, expiresAt: "2026-08-09T00:00:00.000Z" },
      evictedPageReferences: [{
        version: 1,
        reference: "b".repeat(43),
        title: "Previous page",
        finalUrl: "https://person:secret@example.test/previous",
      }],
    })).toEqual({ ok: false, error: "browser research read result is malformed" });
    const continuation = {
      ...result,
      totalCharacters: 16,
      totalBytes: 16,
      estimatedTokens: 4,
      nextOffsetCharacters: 8,
      remainingCharacters: 8,
      eof: false,
      truncated: true,
      continuation: { version: 1, reference, nextOffsetCharacters: 8, expiresAt: "2026-08-09T00:00:00.000Z" },
      pageReference: { version: 1, reference, expiresAt: "2026-08-09T00:00:00.000Z" },
    };
    expect(parseRelayBrowserResearchReadResult(continuation)).toMatchObject({ ok: true });
    expect(parseRelayBrowserResearchReadResult({
      ...continuation,
      pageReference: { version: 1, reference: "c".repeat(43), expiresAt: "2026-08-09T00:00:00.000Z" },
    })).toEqual({ ok: false, error: "browser research read result is malformed" });
    expect(parseRelayBrowserResearchReadResult({
      ...continuation,
      pageReference: { version: 1, reference, expiresAt: "2026-08-09T00:00:01.000Z" },
    })).toEqual({ ok: false, error: "browser research read result is malformed" });
    expect(parseRelayBrowserResearchReadResult({
      ...continuation,
      evictedPageReferences: [
        { version: 1, reference: "b".repeat(43), title: "One", finalUrl: "https://example.test/one" },
        { version: 1, reference: "b".repeat(43), title: "Two", finalUrl: "https://example.test/two" },
      ],
    })).toEqual({ ok: false, error: "browser research read result is malformed" });
    expect(parseRelayBrowserResearchReadResult({
      ...continuation,
      evictedPageReferences: [
        { version: 1, reference, title: "Current", finalUrl: "https://example.test/current" },
      ],
    })).toEqual({ ok: false, error: "browser research read result is malformed" });
  });

  test("strictly admits only v13 immutable snapshot find/range shapes", () => {
    const reference = "s".repeat(43);
    const identity = { toolCallId: "tool-1", laneKey: "room-1" };
    expect(parseRelayBrowserResearchSnapshotInspectionRequest({
      ...identity,
      snapshot: { version: 1, operation: "find", reference, query: "cyclic imports", maxMatches: 8 },
    })).toMatchObject({ ok: true });
    expect(parseRelayBrowserResearchSnapshotInspectionRequest({
      ...identity,
      snapshot: { version: 1, operation: "find", reference, query: "   " },
    })).toEqual({ ok: false, error: "browser research snapshot request is malformed" });
    expect(parseRelayBrowserResearchSnapshotInspectionRequest({
      ...identity,
      url: "https://attacker.test",
      snapshot: { version: 1, operation: "range", reference, offsetCharacters: 0 },
    })).toEqual({ ok: false, error: "browser research snapshot request is malformed" });

    const find = {
      version: 1,
      operation: "find",
      reference,
      expiresAt: "2026-08-09T00:00:00.000Z",
      caseSensitive: false,
      totalMatches: 3,
      returnedMatches: 1,
      matchesOmitted: 2,
      matches: [{
        offsetCharacters: 10,
        matchCharacters: 6,
        previewOffsetCharacters: 4,
        preview: "a needle b    ",
        startsMidBlock: true,
        endsMidBlock: false,
        truncatedBlock: true,
      }],
    };
    expect(parseRelayBrowserResearchSnapshotInspectionResult(find)).toMatchObject({ ok: true });
    expect(parseRelayBrowserResearchSnapshotInspectionResult({ ...find, matchesOmitted: 1 })).toEqual({
      ok: false, error: "browser research snapshot result is malformed",
    });
    expect(parseRelayBrowserResearchSnapshotInspectionResult({
      ...find,
      matches: [{ ...find.matches[0], previewOffsetCharacters: 11 }],
    })).toEqual({ ok: false, error: "browser research snapshot result is malformed" });
    expect(parseRelayBrowserResearchSnapshotInspectionResult({
      ...find,
      matches: [{ ...find.matches[0], matchCharacters: 20 }],
    })).toEqual({ ok: false, error: "browser research snapshot result is malformed" });
    expect(parseRelayBrowserResearchSnapshotInspectionResult({
      ...find,
      totalMatches: 2,
      returnedMatches: 2,
      matchesOmitted: 0,
      matches: [find.matches[0], { ...find.matches[0], offsetCharacters: 12 }],
    })).toEqual({ ok: false, error: "browser research snapshot result is malformed" });
    expect(parseRelayBrowserResearchSnapshotInspectionResult({
      ...find,
      matches: [{
        ...find.matches[0],
        offsetCharacters: 0,
        matchCharacters: 1,
        previewOffsetCharacters: 0,
        preview: "😀".repeat(6_000),
      }],
    })).toEqual({ ok: false, error: "browser research snapshot result is malformed" });
    expect(parseRelayBrowserResearchSnapshotInspectionResult({
      version: 1,
      operation: "range",
      reference,
      expiresAt: "2026-08-09T00:00:00.000Z",
      offsetCharacters: 8,
      startOffsetCharacters: 3,
      endOffsetCharacters: 12,
      content: "123456789",
      startsMidBlock: true,
      endsMidBlock: true,
      truncatedBlock: true,
    })).toMatchObject({ ok: true });
    expect(parseRelayBrowserResearchSnapshotInspectionResult({ ...find, leaked: true })).toEqual({
      ok: false, error: "browser research snapshot result is malformed",
    });
  });
});
