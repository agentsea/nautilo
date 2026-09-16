import { describe, expect, test } from "bun:test";
import type { BrowserPageReadResult, BrowserPageSnapshotInspectionResult, RelayCapabilities } from "@nautilo/relay";
import type { VerifiedOrdinaryOrigin } from "@nautilo/types";
import {
  createBrowserResearchExecutionPort,
  type BrowserResearchExecutionRegistry,
} from "../../src/tools/utilities/browser-research-execution";

const OWNER = "owner-1";
const RELAY = "relay-local-electron";

const RESULT: BrowserPageReadResult = {
  targetRole: "research",
  requestedUrl: "https://example.test/article",
  finalUrl: "https://example.test/article",
  title: "Example article",
  content: "Useful page text",
  blocks: [{ kind: "paragraph", text: "Useful page text" }],
  totalCharacters: 16,
  totalCharactersCapped: false,
  totalBytes: 16,
  estimatedTokens: 4,
  offsetCharacters: 0,
  nextOffsetCharacters: 16,
  returnedCharacters: 16,
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

function localOrigin(overrides: Partial<Extract<VerifiedOrdinaryOrigin, { kind: "local_electron" }>> = {}): VerifiedOrdinaryOrigin {
  return {
    kind: "local_electron",
    userId: OWNER,
    actorId: "actor-1",
    relayId: RELAY,
    desktopSessionId: "desktop-session-1",
    pairingGeneration: "pairing-generation-1",
    requestId: "request-1",
    ...overrides,
  };
}

function registry(input: {
  userId?: string | null;
  protocolVersion?: number | null;
  capabilities?: Partial<RelayCapabilities> | null;
  dispatch?: BrowserResearchExecutionRegistry["browserResearchReadDispatch"];
  searchDispatch?: BrowserResearchExecutionRegistry["browserResearchSearchDispatch"];
  snapshotDispatch?: BrowserResearchExecutionRegistry["browserResearchSnapshotInspectionDispatch"];
  recoveryDispatch?: BrowserResearchExecutionRegistry["browserResearchConsentRecoveryDispatch"];
} = {}): BrowserResearchExecutionRegistry & { readonly calls: Array<unknown> } {
  const calls: Array<unknown> = [];
  const capabilities: RelayCapabilities = {
    profile: "desktop-agent",
    canResearchWeb: true,
    canSearchResearchWeb: true,
    canDeferResearchChallenges: true,
    canReplayResearchConsent: true,
    canRecoverResearchConsent: true,
    ...input.capabilities,
  };
  return {
    calls,
    getUserId: () => input.userId === undefined ? OWNER : input.userId,
    getProtocolVersion: () => input.protocolVersion === undefined ? 13 : input.protocolVersion,
    getCapabilities: () => input.capabilities === null ? null : capabilities,
    browserResearchReadDispatch: input.dispatch ?? (async (relayId, actorId, request, options) => {
      calls.push({ relayId, actorId, request, options });
      return RESULT;
    }),
    browserResearchSearchDispatch: input.searchDispatch ?? (async (relayId, actorId, request, options) => {
      calls.push({ relayId, actorId, request, options });
      return { provider: "duckduckgo_html", items: [{ url: "https://example.test/result", title: "Result" }] };
    }),
    browserResearchSnapshotInspectionDispatch: input.snapshotDispatch ?? (async (relayId, actorId, request, options) => {
      calls.push({ relayId, actorId, request, options });
      return {
        version: 1, operation: "find", reference: request.snapshot.reference, expiresAt: "2026-08-10T12:00:00.000Z",
        caseSensitive: false, totalMatches: 1, returnedMatches: 1, matchesOmitted: 0,
        matches: [{ offsetCharacters: 2, matchCharacters: 4, previewOffsetCharacters: 0, preview: "a test page", startsMidBlock: false, endsMidBlock: false, truncatedBlock: false }],
      } satisfies BrowserPageSnapshotInspectionResult;
    }),
    browserResearchConsentRecoveryDispatch: input.recoveryDispatch ?? (async (relayId, actorId, request, options) => {
      calls.push({ relayId, actorId, request, options });
      return {
        kind: "browser_research_consent_recovery",
        operation: request.consentRecovery.operation,
        reference: request.consentRecovery.reference,
        expiresAt: "2026-08-10T12:00:00.000Z",
        state: "consent_wall",
      };
    }),
  };
}

function port(input: {
  origin?: VerifiedOrdinaryOrigin | null;
  registry?: BrowserResearchExecutionRegistry | null;
  ownerId?: string;
  actorRole?: string;
} = {}) {
  return createBrowserResearchExecutionPort({
    ownerId: input.ownerId ?? OWNER,
    actorRole: input.actorRole ?? "admin",
    verifiedOrdinaryOrigin: input.origin === undefined ? localOrigin() : input.origin,
    relayRegistry: input.registry === undefined ? registry() : input.registry,
    toolCallId: "tool-research-1",
    laneKey: "room:room-1",
  });
}

describe("D504 BrowserResearchExecutionPort", () => {
  test("dispatches keyless discovery through the same verified exact Desktop relay", async () => {
    const exact = registry();
    const outcome = await port({ registry: exact }).search!({ query: "Nautilo", maxResults: 5 });
    expect(outcome).toMatchObject({ category: "success", result: { provider: "duckduckgo_html", items: [{ url: "https://example.test/result" }] } });
    expect(exact.calls).toEqual([{
      relayId: RELAY,
      actorId: OWNER,
      request: { provider: "duckduckgo_html", query: "Nautilo", maxResults: 5, toolCallId: "tool-research-1", laneKey: "room:room-1" },
      options: { timeoutMs: 60_000 },
    }]);
  });
  test("dispatches only the verified local Electron relay and returns its normalized result", async () => {
    const exact = registry();
    const outcome = await port({ registry: exact }).read({
      url: "https://example.test/article",
      maxChars: 200,
    });

    expect(outcome).toEqual({ category: "success", result: RESULT });
    expect(exact.calls).toEqual([{
      relayId: RELAY,
      actorId: OWNER,
      request: {
        url: "https://example.test/article",
        maxChars: 200,
        toolCallId: "tool-research-1",
        laneKey: "room:room-1",
      },
      options: { timeoutMs: 660_000 },
    }]);
  });

  test("forwards bounded consent labels only to a relay that explicitly advertises replay", async () => {
    const exact = registry();
    expect(await port({ registry: exact }).read({
      url: "https://example.test/article",
      consentActions: ["Manage preferences", "Reject optional"],
    })).toMatchObject({ category: "success" });
    expect(exact.calls[0]).toMatchObject({ request: {
      consentActions: ["Manage preferences", "Reject optional"],
    } });

    const old = registry({ capabilities: { canReplayResearchConsent: false } });
    expect(await port({ registry: old }).read({
      url: "https://example.test/article",
      consentActions: ["Reject optional"],
    })).toEqual({ category: "unsupported" });
    expect(old.calls).toEqual([]);
  });

  test("recovers only an opaque same-target consent reference on the exact capable Desktop", async () => {
    const exact = registry();
    const consentRecovery = {
      version: 1 as const, reference: "r".repeat(43), operation: "click_coordinates" as const, x: 440, y: 320,
    };
    expect(await port({ registry: exact }).recoverConsent!({ consentRecovery })).toMatchObject({
      category: "success",
      result: { kind: "browser_research_consent_recovery", operation: "click_coordinates" },
    });
    expect(exact.calls).toEqual([{
      relayId: RELAY, actorId: OWNER,
      request: { consentRecovery, toolCallId: "tool-research-1", laneKey: "room:room-1" },
      options: { timeoutMs: 60_000 },
    }]);

    const old = registry({ capabilities: { canRecoverResearchConsent: false } });
    expect(await port({ registry: old }).recoverConsent!({ consentRecovery })).toEqual({ category: "unsupported" });
    expect(old.calls).toEqual([]);
  });

  test("never uses a selector or a different relay", async () => {
    const exact = registry();
    const outcome = await port({
      origin: localOrigin({ relayId: "relay-exact" }),
      registry: exact,
    }).read({ url: "https://example.test/article" });

    expect(outcome.category).toBe("success");
    expect(exact.calls[0]).toMatchObject({ relayId: "relay-exact" });
  });

  test("forwards an opaque URL-less continuation with the same bounded invocation identity", async () => {
    const exact = registry();
    const continuation = {
      version: 1 as const,
      reference: "a".repeat(43),
      offsetCharacters: 24_000,
      mode: "remainder" as const,
    };
    const outcome = await port({ registry: exact }).read({ continuation });
    expect(outcome).toEqual({ category: "success", result: RESULT });
    expect(exact.calls).toEqual([{
      relayId: RELAY,
      actorId: OWNER,
      request: {
        continuation,
        toolCallId: "tool-research-1",
        laneKey: "room:room-1",
      },
      options: { timeoutMs: 660_000 },
    }]);
    expect((exact.calls[0] as { request: Record<string, unknown> }).request).not.toHaveProperty("url");
  });

  test("inspects only the exact v13 capable owner Desktop without a URL or read fallback", async () => {
    const exact = registry({ capabilities: { canInspectBrowserPageSnapshot: true } });
    const snapshot = { version: 1 as const, operation: "find" as const, reference: "d".repeat(43), query: "test" };
    const outcome = await port({ registry: exact }).inspectSnapshot!({ snapshot });
    expect(outcome.category).toBe("success");
    expect(exact.calls).toEqual([{
      relayId: RELAY, actorId: OWNER,
      request: { snapshot, toolCallId: "tool-research-1", laneKey: "room:room-1" },
      options: { timeoutMs: 30_000 },
    }]);
  });

  test("inspection distinguishes verified non-Electron origin from unavailable ownership and fails closed at v12", async () => {
    const mobile: VerifiedOrdinaryOrigin = {
      kind: "paired_mobile", serverInstanceId: "instance-1", serverBindingGeneration: 1, userId: OWNER,
      actorId: "actor-1", controllerInstallationId: "installation-1", installationGeneration: 1, requestId: "request-1",
    };
    const snapshot = { version: 1 as const, operation: "range" as const, reference: "e".repeat(43), offsetCharacters: 0 };
    const old = registry({ protocolVersion: 12, capabilities: { canInspectBrowserPageSnapshot: true } });
    expect(await port({ registry: old }).inspectSnapshot!({ snapshot })).toEqual({ category: "unsupported" });
    expect(old.calls).toEqual([]);
    const nonElectron = registry({ capabilities: { canInspectBrowserPageSnapshot: true } });
    expect(await port({ origin: mobile, registry: nonElectron }).inspectSnapshot!({ snapshot })).toEqual({ category: "unsupported" });
    expect(nonElectron.calls).toEqual([]);
    const mismatch = registry({ capabilities: { canInspectBrowserPageSnapshot: true } });
    expect(await port({ origin: localOrigin({ userId: "other-owner" }), registry: mismatch }).inspectSnapshot!({ snapshot })).toEqual({ category: "unavailable" });
    expect(mismatch.calls).toEqual([]);
  });

  test("sends deferred challenge policy only to relays that advertise it", async () => {
    const current = registry();
    await port({ registry: current }).read({
      url: "https://example.test/article",
      challengeBehavior: "defer",
    });
    expect(current.calls[0]).toMatchObject({ request: { challengeBehavior: "defer" } });

    const older = registry({ capabilities: { canDeferResearchChallenges: false } });
    await port({ registry: older }).read({
      url: "https://example.test/article",
      challengeBehavior: "defer",
    });
    expect(older.calls[0]).toMatchObject({ request: { url: "https://example.test/article" } });
    expect((older.calls[0] as { request: Record<string, unknown> }).request).not.toHaveProperty("challengeBehavior");
  });

  test("fails unavailable without dispatch for guest, absent origin, server-only context, and owner mismatch", async () => {
    const guest = registry();
    expect(await port({ actorRole: "guest", registry: guest }).read({ url: "https://example.test/article" }))
      .toEqual({ category: "unavailable" });
    expect(guest.calls).toEqual([]);

    const absent = registry();
    expect(await port({ origin: null, registry: absent }).read({ url: "https://example.test/article" }))
      .toEqual({ category: "unavailable" });
    expect(absent.calls).toEqual([]);

    expect(await port({ registry: null }).read({ url: "https://example.test/article" }))
      .toEqual({ category: "unavailable" });

    const wrongOriginOwner = registry();
    expect(await port({
      origin: localOrigin({ userId: "other-owner" }),
      registry: wrongOriginOwner,
    }).read({ url: "https://example.test/article" })).toEqual({ category: "unavailable" });
    expect(wrongOriginOwner.calls).toEqual([]);

    const wrongRegistryOwner = registry({ userId: "other-owner" });
    expect(await port({ registry: wrongRegistryOwner }).read({ url: "https://example.test/article" }))
      .toEqual({ category: "unavailable" });
    expect(wrongRegistryOwner.calls).toEqual([]);
  });

  test("fails unsupported without dispatch for paired mobile, old, wrong-profile, missing-capability, and missing-port relays", async () => {
    const mobile: VerifiedOrdinaryOrigin = {
      kind: "paired_mobile",
      serverInstanceId: "instance-1",
      serverBindingGeneration: 1,
      userId: OWNER,
      actorId: "actor-1",
      controllerInstallationId: "installation-1",
      installationGeneration: 1,
      requestId: "request-1",
    };
    const withPort = registry();
    const { browserResearchReadDispatch: _missingPort, ...missingPort } = withPort;
    const cases: Array<{ origin?: VerifiedOrdinaryOrigin; registry?: BrowserResearchExecutionRegistry }> = [
      { origin: mobile },
      { registry: registry({ protocolVersion: 11 }) },
      { registry: registry({ capabilities: { profile: "device-relay" } }) },
      { registry: registry({ capabilities: { canResearchWeb: false } }) },
      { registry: missingPort },
    ];

    for (const input of cases) {
      const exact = input.registry ?? registry();
      const outcome = await port({ ...input, registry: exact }).read({ url: "https://example.test/article" });
      expect(outcome).toEqual({ category: "unsupported" });
      expect((exact as { calls?: unknown[] }).calls ?? []).toEqual([]);
    }
  });

  test("reports an exact relay disappearance or transport loss without fallback", async () => {
    const disappeared = registry({ userId: null });
    expect(await port({ registry: disappeared }).read({ url: "https://example.test/article" }))
      .toEqual({ category: "lost" });
    expect(disappeared.calls).toEqual([]);

    const lostDuringDispatch = registry({
      dispatch: async () => {
        throw Object.assign(new Error("disconnect"), { browserResearchReadErrorCode: "transport_failed" });
      },
    });
    expect(await port({ registry: lostDuringDispatch }).read({ url: "https://example.test/article" }))
      .toEqual({ category: "lost" });
  });

  test("maps malformed results and unexpected dispatch errors to error", async () => {
    const malformed = registry({ dispatch: async () => ({ ...RESULT, targetRole: "interactive" }) as BrowserPageReadResult });
    expect(await port({ registry: malformed }).read({ url: "https://example.test/article" }))
      .toEqual({ category: "error" });

    const failed = registry({ dispatch: async () => { throw new Error("private relay error"); } });
    expect(await port({ registry: failed }).read({ url: "https://example.test/article" }))
      .toEqual({ category: "error" });

    const invalidRequest = registry();
    expect(await port({ registry: invalidRequest }).read({ url: "file:///not-public" }))
      .toEqual({ category: "error" });
    expect(invalidRequest.calls).toEqual([]);
  });

  test("forwards thread cancellation and never dispatches an already cancelled read", async () => {
    const controller = new AbortController();
    controller.abort();
    const exact = registry();
    expect(await port({ registry: exact }).read({
      url: "https://example.test/article",
      signal: controller.signal,
    })).toEqual({ category: "cancelled" });
    expect(exact.calls).toEqual([]);

    const duringController = new AbortController();
    const duringDispatch = registry({
      dispatch: async (_relayId, _actorId, _request, options) => {
        expect(options?.signal).toBe(duringController.signal);
        duringController.abort();
        throw new DOMException("cancelled", "AbortError");
      },
    });
    expect(await port({ registry: duringDispatch }).read({
      url: "https://example.test/article",
      signal: duringController.signal,
    })).toEqual({ category: "cancelled" });
  });
});
