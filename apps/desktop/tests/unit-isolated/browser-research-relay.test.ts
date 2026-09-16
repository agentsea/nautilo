import { beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createWorkspaceGuard, type RelayDispatchRequest } from "@nautilo/relay";
import { BrowserPageSnapshotStore, type BrowserPageSnapshotOwnerBinding } from "../../electron/browser-page-snapshot-store";
import { browserControlStateSessionId } from "../../electron/browser-control-state";

mock.module("electron", () => ({ app: { getPath: () => "/tmp/nautilo-test-userdata" } }));

let makeDispatchHandler: typeof import("../../electron/relay").makeDispatchHandler;

beforeAll(async () => {
  ({ makeDispatchHandler } = await import("../../electron/relay"));
});

function request(args: Record<string, unknown>): RelayDispatchRequest {
  return {
    correlationId: "research-1",
    toolName: "browser_research_read",
    args,
    impact: "read-only",
    approvalObtained: true,
    executionClass: "browser",
  };
}

describe("browser_research_read relay admission", () => {
  const invocation = { toolCallId: "tool-research-1", laneKey: "room:room-1" } as const;

  test("refuses a Task continuation after the exact embedded Browser view is replaced", async () => {
    const statePath = "/tmp/nautilo-test-userdata/browser-control-state.json";
    const original = {
      activeAppId: "browser",
      views: [{ appId: "browser", cdpUrl: "http://127.0.0.1:1111" }],
    };
    const requiredSession = browserControlStateSessionId(original);
    if (requiredSession === null) throw new Error("expected Browser session fixture");
    mkdirSync("/tmp/nautilo-test-userdata", { recursive: true });
    writeFileSync(statePath, JSON.stringify({
      activeAppId: "browser",
      views: [{ appId: "browser", cdpUrl: "http://127.0.0.1:2222" }],
    }));
    try {
      const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: "/tmp" }));
      await expect(handler({
        correlationId: "browser-task-continuation",
        toolName: "browser_snapshot",
        args: { _requiredSession: requiredSession },
        impact: "low",
        approvalObtained: true,
        executionClass: "browser",
      })).resolves.toEqual({
        status: "error",
        error: "the embedded Browser session bound to this Task continuation is no longer active",
      });
    } finally {
      rmSync(statePath, { force: true });
    }
  });

  test("reaches only the injected Electron-main research port with normalized bounded input and cancellation", async () => {
    const received: Array<{ url: string; maxChars?: number; signal?: AbortSignal }> = [];
    const controller = new AbortController();
    const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: "/tmp" }), {
      browserResearchRead: async (input, signal) => {
        received.push({ ...input, signal });
        return { status: "ok", result: { targetRole: "research" } };
      },
    });

    const result = await handler(request({ url: "https://example.com/article", maxChars: 500, ...invocation }), controller.signal);

    expect(result).toEqual({ status: "ok", result: { targetRole: "research" } });
    expect(received).toEqual([{
      url: "https://example.com/article",
      maxChars: 500,
      ...invocation,
      signal: controller.signal,
    }]);
  });

  test("routes fixed-provider search only through the injected Electron-main search port", async () => {
    const received: unknown[] = [];
    const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: "/tmp" }), {
      browserResearchSearch: async (input) => {
        received.push(input);
        return { status: "ok", result: { provider: "duckduckgo_html", items: [] } };
      },
    });
    const result = await handler({
      ...request({ provider: "duckduckgo_html", query: "Nautilo", maxResults: 5, ...invocation }),
      toolName: "browser_research_search",
    });
    expect(result).toEqual({ status: "ok", result: { provider: "duckduckgo_html", items: [] } });
    expect(received).toEqual([{ provider: "duckduckgo_html", query: "Nautilo", maxResults: 5, ...invocation }]);
  });

  test("rejects malformed input or an absent research port without using interactive browser dispatch", async () => {
    const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: "/tmp" }));

    await expect(handler(request({ url: "https://user:pass@example.com", ...invocation }))).resolves.toEqual({
      status: "error",
      error: "browser research read is unavailable",
    });
    await expect(handler(request({ url: "https://example.com", ...invocation }))).resolves.toEqual({
      status: "error",
      error: "browser research read is unavailable",
    });
  });

  test("rejects the internal operation outside its read-only browser execution lane", async () => {
    let called = false;
    const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: "/tmp" }), {
      browserResearchRead: async () => {
        called = true;
        return { status: "error", error: "unexpected" };
      },
    });
    const wrongClass = { ...request({ url: "https://example.com", ...invocation }), executionClass: "desktop" as const };
    const wrongImpact = { ...request({ url: "https://example.com", ...invocation }), impact: "low" as const };

    expect(await handler(wrongClass)).toEqual({ status: "error", error: "browser research read is unavailable" });
    expect(await handler(wrongImpact)).toEqual({ status: "error", error: "browser research read is unavailable" });
    expect(called).toBe(false);
  });

  test("continues a retained research page through browser_research_read without URL, lease, or reader call", async () => {
    const owner: BrowserPageSnapshotOwnerBinding = {
      instanceId: "instance-1", userId: "user-1", relayId: "relay-1", desktopSessionId: "desktop-1",
    };
    const store = new BrowserPageSnapshotStore();
    const content = "retained research evidence ".repeat(2_000);
    const created = store.create(owner, {
      targetRole: "research", requestedUrl: "https://example.com/article",
      finalUrl: "https://example.com/article", title: "Research", content, blocks: [],
      totalCharacters: content.length, totalCharactersCapped: false,
      totalBytes: Buffer.byteLength(content), estimatedTokens: Math.ceil(content.length / 4),
      offsetCharacters: 0, nextOffsetCharacters: content.length, returnedCharacters: content.length,
      remainingCharacters: 0, eof: true, truncated: false, contextClamped: false,
      extraction: { method: "mozilla-readability-turndown-v1", root: "article", iframeCount: 0 },
      timing: { readiness: "complete" }, quality: "complete",
      challenge: { detected: false, confidence: "none", signals: [] }, failure: "none", diagnostics: [],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("expected snapshot");
    let readerCalled = false;
    const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: "/tmp" }), {
      browserPageSnapshotStore: store,
      browserResearchRead: async () => {
        readerCalled = true;
        return { status: "error", error: "must not create a research lease" };
      },
    });
    const result = await handler({
      ...request({
        continuation: {
          version: 1,
          reference: created.snapshot.reference,
          offsetCharacters: 24_000,
          mode: "page",
        },
        ...invocation,
      }),
      browserPageOwnerBinding: owner,
    });
    expect(result).toMatchObject({
      status: "ok",
      result: { targetRole: "research", offsetCharacters: 24_000, eof: false },
    });
    expect(readerCalled).toBe(false);
  });

  test("routes page continuation before an active browser check and never reruns the current target", async () => {
    const owner: BrowserPageSnapshotOwnerBinding = {
      instanceId: "instance-1", userId: "user-1", relayId: "relay-1", desktopSessionId: "desktop-1",
    };
    const store = new BrowserPageSnapshotStore();
    const created = store.create(owner, {
      targetRole: "interactive", finalUrl: "https://example.com", title: "Example", content: "retained page text",
      blocks: [], totalCharacters: 18, totalCharactersCapped: false, totalBytes: 18, estimatedTokens: 5,
      offsetCharacters: 0, nextOffsetCharacters: 18, returnedCharacters: 18, remainingCharacters: 0,
      eof: true, truncated: false, contextClamped: false,
      extraction: { method: "mozilla-readability-turndown-v1", root: "article", iframeCount: 0 },
      timing: { readiness: "complete" }, quality: "complete",
      challenge: { detected: false, confidence: "none", signals: [] }, failure: "none", diagnostics: [],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("expected snapshot");
    const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: "/tmp" }), {
      browserPageSnapshotStore: store,
    });
    const result = await handler({
      correlationId: "browser-continuation", toolName: "browser_read_page",
      args: { continuation: { version: 1, reference: created.snapshot.reference, offsetCharacters: 0, mode: "page" } },
      impact: "read-only", approvalObtained: false, executionClass: "browser", browserPageOwnerBinding: owner,
    });
    expect(result).toMatchObject({ status: "ok", result: { content: "retained page text", eof: true } });
  });
});
