import { describe, expect, test } from "bun:test";
import type {
  BrowserPageReadResult,
  RelayCapabilities,
  RelayServerMessage,
} from "@nautilo/relay";
import {
  BrowserResearchReadRelayDispatchError,
  BrowserResearchConsentRecoveryRelayDispatchError,
  BrowserResearchSnapshotInspectionRelayDispatchError,
  BrowserResearchSearchRelayDispatchError,
  InMemoryRelayRegistry,
} from "../../src/relay-registry";

const CAPABILITIES: RelayCapabilities = {
  profile: "desktop-agent",
  canControlBrowser: true,
  canResearchWeb: true,
  canSearchResearchWeb: true,
  canDeferResearchChallenges: true,
  canRecoverResearchConsent: true,
};

const RESULT: BrowserPageReadResult = {
  targetRole: "research",
  requestedUrl: "https://example.com/article",
  finalUrl: "https://example.com/article",
  title: "Example",
  content: "Useful content",
  blocks: [{ kind: "paragraph", text: "Useful content" }],
  totalCharacters: 14,
  totalCharactersCapped: false,
  totalBytes: 14,
  estimatedTokens: 4,
  offsetCharacters: 0,
  nextOffsetCharacters: 14,
  returnedCharacters: 14,
  remainingCharacters: 0,
  eof: true,
  truncated: false,
  contextClamped: false,
  extraction: { method: "fixed-dom-semantic-v1", root: "main", iframeCount: 0 },
  timing: { readiness: "complete", elapsedMs: 4 },
  quality: "complete",
  challenge: { detected: false, confidence: "none", signals: [] },
  failure: "none",
  diagnostics: [],
};

const INVOCATION = { toolCallId: "tool-research-1", laneKey: "room:room-1" } as const;

test("capability refresh preserves v13 page continuation and snapshot inspection", async () => {
  const registry = new InMemoryRelayRegistry();
  await registry.register(
    "exact-relay",
    "alice",
    CAPABILITIES,
    () => undefined,
    13,
    "desktop-session-1",
    0,
  );

  expect(registry.updateCapabilities({
    relayId: "exact-relay",
    userId: "alice",
    desktopSessionId: "desktop-session-1",
    capabilityRevision: 1,
    capabilities: {
      ...CAPABILITIES,
      canContinueBrowserPageRead: true,
      canInspectBrowserPageSnapshot: true,
    },
  })).toEqual({ ok: true });
  expect(registry.getCapabilities("exact-relay")).toMatchObject({
    canContinueBrowserPageRead: true,
    canInspectBrowserPageSnapshot: true,
  });
});

describe("InMemoryRelayRegistry.browserResearchReadDispatch", () => {
  test("dispatches only to the exact authenticated owner relay and returns the normalized result", async () => {
    const registry = new InMemoryRelayRegistry();
    const first: RelayServerMessage[] = [];
    const exact: RelayServerMessage[] = [];
    await registry.register("other-relay", "alice", CAPABILITIES, (message) => first.push(message), 12);
    await registry.register("exact-relay", "alice", CAPABILITIES, (message) => exact.push(message), 12);

    const pending = registry.browserResearchReadDispatch(
      "exact-relay",
      "alice",
      { url: "https://example.com/article", maxChars: 400, challengeBehavior: "defer", ...INVOCATION },
    );

    expect(first).toHaveLength(0);
    expect(exact).toHaveLength(1);
    const dispatch = exact[0] as Extract<RelayServerMessage, { type: "relay:dispatch" }>;
    expect(dispatch).toMatchObject({
      toolName: "browser_research_read",
      executionClass: "browser",
      impact: "read-only",
      approvalObtained: true,
      args: { url: "https://example.com/article", maxChars: 400, challengeBehavior: "defer" },
    });

    registry.resolveDispatch(dispatch.correlationId, { status: "ok", result: RESULT });
    expect(await pending).toEqual(RESULT);
  });

  test("dispatches a URL-less continuation through the same exact research relay API", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register("exact-relay", "alice", CAPABILITIES, (message) => sent.push(message), 12);
    const continuation = {
      version: 1 as const,
      reference: "a".repeat(43),
      offsetCharacters: 24_000,
      mode: "remainder" as const,
    };
    const pending = registry.browserResearchReadDispatch("exact-relay", "alice", {
      continuation,
      ...INVOCATION,
    });
    const dispatch = sent[0] as Extract<RelayServerMessage, { type: "relay:dispatch" }>;
    expect(dispatch).toMatchObject({
      toolName: "browser_research_read",
      args: { continuation, ...INVOCATION },
    });
    expect(dispatch.args).not.toHaveProperty("url");
    registry.resolveDispatch(dispatch.correlationId, { status: "ok", result: RESULT });
    expect(await pending).toEqual(RESULT);
  });

  test("preserves an unresolved consent wall as a typed relay outcome", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register("exact-relay", "alice", CAPABILITIES, (message) => sent.push(message), 12);
    const pending = registry.browserResearchReadDispatch("exact-relay", "alice", {
      url: "https://example.com/consent",
      ...INVOCATION,
    });
    const dispatch = sent[0] as Extract<RelayServerMessage, { type: "relay:dispatch" }>;
    registry.resolveDispatch(dispatch.correlationId, {
      status: "error",
      errorCode: "browser_research_consent_wall",
      error: "consent wall remained",
    });
    await pending.then(
      () => { throw new Error("expected consent wall dispatch to fail"); },
      (error: unknown) => {
        expect(error).toMatchObject({ browserResearchReadErrorCode: "consent_wall" });
      },
    );
  });

  test("fails truthfully for old, headless, capability-less, foreign, and malformed requests without selecting another relay", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: string[] = [];
    await registry.register("good", "alice", CAPABILITIES, () => sent.push("good"), 12);
    await registry.register("old", "alice", CAPABILITIES, () => sent.push("old"), 11);
    await registry.register("headless", "alice", { profile: "device-relay", canResearchWeb: true }, () => sent.push("headless"), 12);
    await registry.register("missing", "alice", { profile: "desktop-agent" }, () => sent.push("missing"), 12);

    for (const [relayId, actorId, request] of [
      ["old", "alice", { url: "https://example.com", ...INVOCATION }],
      ["headless", "alice", { url: "https://example.com", ...INVOCATION }],
      ["missing", "alice", { url: "https://example.com", ...INVOCATION }],
      ["good", "mallory", { url: "https://example.com", ...INVOCATION }],
      ["good", "alice", { url: "https://user:pass@example.com", ...INVOCATION }],
      ["good", "alice", { url: "https://example.com", maxChars: 256_001, ...INVOCATION }],
      ["good", "alice", { url: "https://example.com", challengeBehavior: "never", ...INVOCATION }],
    ] as const) {
      await registry.browserResearchReadDispatch(relayId, actorId, request as import("@nautilo/relay").RelayBrowserResearchReadRequest).then(
        () => { throw new Error("expected exact relay admission to fail"); },
        (error: unknown) => {
          expect(error).toBeInstanceOf(BrowserResearchReadRelayDispatchError);
          expect((error as BrowserResearchReadRelayDispatchError).browserResearchReadErrorCode).toBe("runtime_unavailable");
        },
      );
    }
    expect(sent).toEqual([]);
  });

  test("rejects malformed or relay-local result fields before they leave the registry", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register("exact-relay", "alice", CAPABILITIES, (message) => sent.push(message), 12);

    const pending = registry.browserResearchReadDispatch("exact-relay", "alice", { url: "https://example.com/article", ...INVOCATION });
    const dispatch = sent[0] as Extract<RelayServerMessage, { type: "relay:dispatch" }>;
    registry.resolveDispatch(dispatch.correlationId, {
      status: "ok",
      result: { ...RESULT, cdpUrl: "ws://127.0.0.1:9222/devtools/page/private" },
    });

    await pending.then(
      () => { throw new Error("expected private relay result to fail"); },
      (error: unknown) => {
        expect(error).toBeInstanceOf(BrowserResearchReadRelayDispatchError);
        expect((error as BrowserResearchReadRelayDispatchError).browserResearchReadErrorCode).toBe("invalid_result");
      },
    );
  });

  test("rejects oversized nested result text before it leaves the registry", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register("exact-relay", "alice", CAPABILITIES, (message) => sent.push(message), 12);

    const pending = registry.browserResearchReadDispatch("exact-relay", "alice", { url: "https://example.com/article", ...INVOCATION });
    const dispatch = sent[0] as Extract<RelayServerMessage, { type: "relay:dispatch" }>;
    registry.resolveDispatch(dispatch.correlationId, {
      status: "ok",
      result: { ...RESULT, blocks: [{ kind: "paragraph", text: "x".repeat(4_097) }] },
    });

    await pending.then(
      () => { throw new Error("expected oversized result to fail"); },
      (error: unknown) => {
        expect(error).toMatchObject({ browserResearchReadErrorCode: "invalid_result" });
      },
    );
  });
});

describe("InMemoryRelayRegistry.browserResearchConsentRecoveryDispatch", () => {
  test("dispatches only a strict opaque recovery request to the exact v13 capable owner relay", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register("exact-relay", "alice", CAPABILITIES, (message) => sent.push(message), 13);
    const consentRecovery = { version: 1 as const, reference: "r".repeat(43), operation: "snapshot" as const };
    const pending = registry.browserResearchConsentRecoveryDispatch("exact-relay", "alice", { consentRecovery, ...INVOCATION });
    const dispatch = sent[0] as Extract<RelayServerMessage, { type: "relay:dispatch" }>;
    expect(dispatch).toMatchObject({
      toolName: "browser_research_read", executionClass: "browser", impact: "read-only", approvalObtained: true,
      args: { consentRecovery, ...INVOCATION },
    });
    registry.resolveDispatch(dispatch.correlationId, { status: "ok", result: {
      kind: "browser_research_consent_recovery", operation: "snapshot", reference: consentRecovery.reference,
      expiresAt: "2026-08-10T12:00:00.000Z", state: "consent_wall", snapshot: '- button "Reject all" [ref=e1]',
      controls: [{ reference: "e1", label: "Reject all" }],
    } });
    expect(await pending).toMatchObject({ operation: "snapshot", controls: [{ label: "Reject all" }] });
  });

  test("fails closed for old, foreign, capability-less, and malformed recovery calls", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register("old", "alice", CAPABILITIES, (message) => sent.push(message), 12);
    await registry.register("missing", "alice", { ...CAPABILITIES, canRecoverResearchConsent: false }, (message) => sent.push(message), 13);
    for (const [relayId, actorId, consentRecovery] of [
      ["old", "alice", { version: 1, reference: "r".repeat(43), operation: "snapshot" }],
      ["missing", "alice", { version: 1, reference: "r".repeat(43), operation: "snapshot" }],
      ["missing", "mallory", { version: 1, reference: "r".repeat(43), operation: "snapshot" }],
      ["missing", "alice", { version: 1, reference: "r".repeat(43), operation: "click_coordinates", x: -1, y: 20 }],
    ] as const) {
      await registry.browserResearchConsentRecoveryDispatch(relayId, actorId, { consentRecovery, ...INVOCATION } as never).then(
        () => { throw new Error("expected recovery admission to fail"); },
        (error: unknown) => expect(error).toBeInstanceOf(BrowserResearchConsentRecoveryRelayDispatchError),
      );
    }
    expect(sent).toEqual([]);
  });

  test("keeps a local recovery-operation failure distinct from relay loss", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register("exact-relay", "alice", CAPABILITIES, (message) => sent.push(message), 13);
    const pending = registry.browserResearchConsentRecoveryDispatch("exact-relay", "alice", {
      consentRecovery: { version: 1, reference: "r".repeat(43), operation: "screenshot" }, ...INVOCATION,
    });
    const dispatch = sent[0] as Extract<RelayServerMessage, { type: "relay:dispatch" }>;
    registry.resolveDispatch(dispatch.correlationId, {
      status: "error", errorCode: "browser_research_recovery_failed", error: "screenshot failed",
    });
    await pending.then(
      () => { throw new Error("expected operation failure"); },
      (error: unknown) => expect(error).toMatchObject({ browserResearchConsentRecoveryErrorCode: "operation_failed" }),
    );
  });
});

describe("InMemoryRelayRegistry.browserResearchSearchDispatch", () => {
  test("dispatches fixed-provider discovery only to the exact capable owner relay", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register("exact-relay", "alice", CAPABILITIES, (message) => sent.push(message), 12);
    const pending = registry.browserResearchSearchDispatch("exact-relay", "alice", {
      provider: "duckduckgo_html", query: "Nautilo", maxResults: 5, ...INVOCATION,
    });
    const dispatch = sent[0] as Extract<RelayServerMessage, { type: "relay:dispatch" }>;
    expect(dispatch).toMatchObject({ toolName: "browser_research_search", executionClass: "browser", impact: "read-only" });
    const result = { provider: "duckduckgo_html" as const, items: [{ url: "https://example.com/", title: "Example" }] };
    registry.resolveDispatch(dispatch.correlationId, { status: "ok", result });
    expect(await pending).toEqual(result);
  });

  test("fails closed without the explicit search capability", async () => {
    const registry = new InMemoryRelayRegistry();
    await registry.register("read-only", "alice", { profile: "desktop-agent", canResearchWeb: true }, () => undefined, 12);
    const outcome = registry.browserResearchSearchDispatch("read-only", "alice", {
      provider: "duckduckgo_html", query: "Nautilo", maxResults: 5, ...INVOCATION,
    });
    await outcome.then(
      () => { throw new Error("expected search capability admission to fail"); },
      (error: unknown) => expect(error).toBeInstanceOf(BrowserResearchSearchRelayDispatchError),
    );
  });
});

describe("InMemoryRelayRegistry.browserResearchSnapshotInspectionDispatch", () => {
  test("admits only the exact v13 capable owner, strictly returns a valid result, and preserves typed failures", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register("exact-relay", "alice", { ...CAPABILITIES, canInspectBrowserPageSnapshot: true }, (message) => sent.push(message), 13);
    const request = { snapshot: { version: 1 as const, operation: "find" as const, reference: "s".repeat(43), query: "useful" }, ...INVOCATION };
    const pending = registry.browserResearchSnapshotInspectionDispatch("exact-relay", "alice", request);
    const dispatch = sent[0] as Extract<RelayServerMessage, { type: "relay:dispatch" }>;
    expect(dispatch).toMatchObject({ toolName: "browser_research_read", executionClass: "browser", args: request });
    const result = {
      version: 1 as const, operation: "find" as const, reference: request.snapshot.reference, expiresAt: "2026-08-10T12:00:00.000Z",
      caseSensitive: false, totalMatches: 1, returnedMatches: 1, matchesOmitted: 0,
      matches: [{ offsetCharacters: 2, matchCharacters: 6, previewOffsetCharacters: 0, preview: "a useful page", startsMidBlock: false, endsMidBlock: false, truncatedBlock: false }],
    };
    registry.resolveDispatch(dispatch.correlationId, { status: "ok", result });
    expect(await pending).toEqual(result);

    const failure = registry.browserResearchSnapshotInspectionDispatch("exact-relay", "alice", request);
    const failureDispatch = sent[1] as Extract<RelayServerMessage, { type: "relay:dispatch" }>;
    registry.resolveDispatch(failureDispatch.correlationId, { status: "error", errorCode: "BROWSER_PAGE_SNAPSHOT_EVICTED", error: "private details stay local" });
    await failure.then(
      () => { throw new Error("expected typed snapshot eviction"); },
      (error: unknown) => expect(error).toMatchObject({ browserResearchSnapshotInspectionErrorCode: "evicted" }),
    );

    const v12 = new InMemoryRelayRegistry();
    await v12.register("old", "alice", { ...CAPABILITIES, canInspectBrowserPageSnapshot: true }, () => { throw new Error("must not dispatch"); }, 12);
    await v12.browserResearchSnapshotInspectionDispatch("old", "alice", request).then(
      () => { throw new Error("expected v12 rejection"); },
      (error: unknown) => expect(error).toBeInstanceOf(BrowserResearchSnapshotInspectionRelayDispatchError),
    );

    const blocked = new InMemoryRelayRegistry();
    const blockedMessages: RelayServerMessage[] = [];
    await blocked.register("missing-capability", "alice", CAPABILITIES, (message) => blockedMessages.push(message), 13);
    await blocked.register("foreign", "mallory", { ...CAPABILITIES, canInspectBrowserPageSnapshot: true }, (message) => blockedMessages.push(message), 13);
    for (const [relayId, actorId] of [["missing-capability", "alice"], ["foreign", "alice"]] as const) {
      await blocked.browserResearchSnapshotInspectionDispatch(relayId, actorId, request).then(
        () => { throw new Error("expected exact snapshot admission to fail"); },
        (error: unknown) => expect(error).toMatchObject({ browserResearchSnapshotInspectionErrorCode: "runtime_unavailable" }),
      );
    }
    expect(blockedMessages).toEqual([]);
  });
});
