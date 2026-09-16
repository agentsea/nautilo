import { describe, expect, test } from "bun:test";
import {
  createWorkspaceGuard,
  type BrowserPageReadResult,
  type RelayDispatchRequest,
} from "@nautilo/relay";

import {
  BrowserPageSnapshotStore,
  type BrowserPageSnapshotOwnerBinding,
} from "../../electron/browser-page-snapshot-store.ts";
import { createBrowserResearchDispatchHandler } from "../../electron/relay-dispatch/browser-research.ts";
import { FIXED_DESKTOP_DISPATCH_NOT_HANDLED } from "../../electron/relay-dispatch/router.ts";

const identity = { toolCallId: "tool-browser-research", laneKey: "room:research" } as const;
const guard = createWorkspaceGuard({ workspaceRoot: "/tmp" });
const owner: BrowserPageSnapshotOwnerBinding = {
  instanceId: "instance-1",
  userId: "user-1",
  relayId: "relay-1",
  desktopSessionId: "desktop-1",
};

function request(
  toolName: "browser_research_read" | "browser_research_search",
  args: Record<string, unknown>,
  overrides: Partial<RelayDispatchRequest> = {},
): RelayDispatchRequest {
  return {
    correlationId: "browser-research-dispatch",
    toolName,
    args,
    impact: "read-only",
    approvalObtained: true,
    executionClass: "browser",
    ...overrides,
  };
}

function page(
  targetRole: "research" | "interactive",
  content: string,
): BrowserPageReadResult {
  return {
    targetRole,
    finalUrl: "https://example.com/article",
    title: "Research",
    content,
    blocks: [],
    totalCharacters: content.length,
    totalCharactersCapped: false,
    totalBytes: Buffer.byteLength(content),
    estimatedTokens: Math.ceil(content.length / 4),
    offsetCharacters: 0,
    nextOffsetCharacters: content.length,
    returnedCharacters: content.length,
    remainingCharacters: 0,
    eof: true,
    truncated: false,
    contextClamped: false,
    extraction: {
      method: "mozilla-readability-turndown-v1",
      root: "article",
      iframeCount: 0,
    },
    timing: { readiness: "complete" },
    quality: "complete",
    challenge: { detected: false, confidence: "none", signals: [] },
    failure: "none",
    diagnostics: [],
  };
}

describe("createBrowserResearchDispatchHandler", () => {
  test("returns the canonical inert decision for nonmatches", async () => {
    const handler = createBrowserResearchDispatchHandler({
      read: async () => {
        throw new Error("nonmatch must not reach a port");
      },
    });
    const decision = await handler({
      request: {
        correlationId: "not-research",
        toolName: "browser_read_page",
        args: {},
        impact: "read-only",
        approvalObtained: false,
      },
      signal: undefined,
      guard,
    });
    expect(decision).toBe(FIXED_DESKTOP_DISPATCH_NOT_HANDLED);
  });

  test("pins consent-recovery then snapshot-key precedence before ordinary read", async () => {
    const calls: string[] = [];
    const handler = createBrowserResearchDispatchHandler({
      consentRecovery: async () => {
        calls.push("consent");
        return { status: "ok", result: "consent" };
      },
      read: async () => {
        calls.push("read");
        return { status: "ok", result: "read" };
      },
    });
    const withConsentAndSnapshot = request("browser_research_read", {
      consentRecovery: {
        version: 1,
        reference: "a".repeat(43),
        operation: "snapshot",
      },
      snapshot: { version: 1, operation: "range", reference: "b".repeat(43), offsetCharacters: 0 },
      ...identity,
    });
    expect(await handler({ request: withConsentAndSnapshot, signal: undefined, guard })).toEqual({
      handled: true,
      result: {
        status: "error",
        error: "browser research consent recovery is unavailable",
      },
    });

    const withSnapshotAndRead = request("browser_research_read", {
      snapshot: { invalid: true },
      url: "https://example.com/article",
      ...identity,
    });
    expect(await handler({ request: withSnapshotAndRead, signal: undefined, guard })).toEqual({
      handled: true,
      result: {
        status: "error",
        error: "browser research snapshot is unavailable",
      },
    });
    expect(calls).toEqual([]);
  });

  test("forwards consent recovery and search to their exact ports with the client signal", async () => {
    const controller = new AbortController();
    const received: unknown[] = [];
    const handler = createBrowserResearchDispatchHandler({
      consentRecovery: async (input, signal) => {
        received.push({ lane: "consent", input, signal });
        return { status: "ok", result: "consent" };
      },
      search: async (input, signal) => {
        received.push({ lane: "search", input, signal });
        return { status: "ok", result: "search" };
      },
    });
    const consent = request("browser_research_read", {
      consentRecovery: {
        version: 1,
        reference: "a".repeat(43),
        operation: "snapshot",
      },
      ...identity,
    });
    const search = request("browser_research_search", {
      provider: "duckduckgo_html",
      query: "  Nautilo relay  ",
      maxResults: 5,
      ...identity,
    });

    expect(await handler({ request: consent, signal: controller.signal, guard })).toEqual({
      handled: true,
      result: { status: "ok", result: "consent" },
    });
    expect(await handler({ request: search, signal: controller.signal, guard })).toEqual({
      handled: true,
      result: { status: "ok", result: "search" },
    });
    expect(received).toEqual([
      {
        lane: "consent",
        input: {
          consentRecovery: {
            version: 1,
            reference: "a".repeat(43),
            operation: "snapshot",
          },
          ...identity,
        },
        signal: controller.signal,
      },
      {
        lane: "search",
        input: {
          provider: "duckduckgo_html",
          query: "Nautilo relay",
          maxResults: 5,
          ...identity,
        },
        signal: controller.signal,
      },
    ]);
  });

  test("forwards normalized reads and snapshot-publication intent without owning the reader", async () => {
    const controller = new AbortController();
    const received: unknown[] = [];
    const handler = createBrowserResearchDispatchHandler({
      read: async (input, signal, options) => {
        received.push({ input, signal, options });
        return { status: "error", errorCode: "READ_PORT", error: "reader result" };
      },
    });
    const read = request(
      "browser_research_read",
      { url: "https://example.com/article", maxChars: 500, ...identity },
      { browserPageSnapshotReferencePublication: true },
    );

    expect(await handler({ request: read, signal: controller.signal, guard })).toEqual({
      handled: true,
      result: { status: "error", errorCode: "READ_PORT", error: "reader result" },
    });
    expect(received).toEqual([{
      input: { url: "https://example.com/article", maxChars: 500, ...identity },
      signal: controller.signal,
      options: { publishSnapshotReference: true },
    }]);
  });

  test("uses the injected store, exact owner, publication flag, and research role for snapshot work", async () => {
    const store = new BrowserPageSnapshotStore();
    const research = store.create(owner, page("research", "alpha needle omega"));
    expect(research.ok).toBe(true);
    if (!research.ok) throw new Error("expected research snapshot");
    const interactive = store.create(owner, page("interactive", "interactive only"));
    expect(interactive.ok).toBe(true);
    if (!interactive.ok) throw new Error("expected interactive snapshot");
    let readCalls = 0;
    const handler = createBrowserResearchDispatchHandler({
      snapshotStore: store,
      read: async () => {
        readCalls += 1;
        return { status: "error", error: "continuation must not invoke reader" };
      },
    });

    const snapshotRequest = request(
      "browser_research_read",
      {
        snapshot: {
          version: 1,
          operation: "find",
          reference: research.snapshot.reference,
          query: "needle",
        },
        ...identity,
      },
      {
        browserPageOwnerBinding: owner,
        browserPageSnapshotReferencePublication: true,
      },
    );
    expect(await handler({ request: snapshotRequest, signal: undefined, guard })).toMatchObject({
      handled: true,
      result: {
        status: "ok",
        result: { operation: "find", reference: research.snapshot.reference, totalMatches: 1 },
      },
    });

    const continuation = (reference: string) => request(
      "browser_research_read",
      {
        continuation: { version: 1, reference, offsetCharacters: 0, mode: "page" },
        ...identity,
      },
      {
        browserPageOwnerBinding: owner,
        browserPageSnapshotReferencePublication: true,
      },
    );
    expect(await handler({
      request: continuation(research.snapshot.reference),
      signal: undefined,
      guard,
    })).toMatchObject({
      handled: true,
      result: {
        status: "ok",
        result: {
          targetRole: "research",
          pageReference: { reference: research.snapshot.reference },
        },
      },
    });
    expect(await handler({
      request: continuation(interactive.snapshot.reference),
      signal: undefined,
      guard,
    })).toMatchObject({
      handled: true,
      result: { status: "error", errorCode: "BROWSER_PAGE_SNAPSHOT_UNAVAILABLE" },
    });
    expect(readCalls).toBe(0);
    store.close();
  });

  test("keeps matching invalid class, impact, input, and absent-port errors handled", async () => {
    const handler = createBrowserResearchDispatchHandler({});
    const cases: Array<[RelayDispatchRequest, string]> = [
      [
        request(
          "browser_research_read",
          { url: "https://example.com", ...identity },
          { executionClass: "desktop" },
        ),
        "browser research read is unavailable",
      ],
      [
        request(
          "browser_research_read",
          { consentRecovery: { invalid: true }, ...identity },
          { impact: "low" },
        ),
        "browser research consent recovery is unavailable",
      ],
      [
        request("browser_research_read", { snapshot: { invalid: true }, ...identity }),
        "browser research snapshot is unavailable",
      ],
      [
        request("browser_research_search", { provider: "duckduckgo_html", query: "", maxResults: 5, ...identity }),
        "browser research search is unavailable",
      ],
    ];

    for (const [invalidRequest, error] of cases) {
      expect(await handler({ request: invalidRequest, signal: undefined, guard })).toEqual({
        handled: true,
        result: { status: "error", error },
      });
    }
  });
});
