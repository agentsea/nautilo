import { describe, expect, test } from "bun:test";
import {
  BROWSER_USE_DEFAULT_MODEL,
  BROWSER_USE_V4_BASE_URL,
  BrowserUseCloudAdapter,
  type BrowserUseFetch,
} from "../../src/browser-use/browser-use-cloud.ts";

const API_KEY = "bu_test-browser-use-key";
const PROFILE_ID = "profile-private-id";
const BROWSER_ID = "browser-private-id";
const RUN_ID = "run-private-id";
const FIXED_TIME = new Date("2026-09-01T12:00:00.000Z");

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function queuedFetch(
  responses: readonly (Response | Error)[],
  seen: Array<{ readonly url: string; readonly init: RequestInit }>,
): BrowserUseFetch {
  let index = 0;
  return async (url, init) => {
    seen.push({ url, init });
    const next = responses[index++];
    if (next === undefined) throw new Error("unexpected fetch");
    if (next instanceof Error) throw next;
    return next;
  };
}

function adapter(
  responses: readonly (Response | Error)[] = [],
  seen: Array<{ readonly url: string; readonly init: RequestInit }> = [],
  secrets: Readonly<Record<string, string | undefined>> = { BROWSER_USE_API_KEY: API_KEY },
  recordProviderCost: NonNullable<ConstructorParameters<typeof BrowserUseCloudAdapter>[0]["recordProviderCost"]> = async () => undefined,
): BrowserUseCloudAdapter {
  return new BrowserUseCloudAdapter({
    serverKeys: secrets,
    fetch: queuedFetch(responses, seen),
    clock: { now: () => FIXED_TIME },
    recordProviderCost,
  });
}

function jsonBody(init: RequestInit): unknown {
  if (typeof init.body !== "string") throw new Error("expected JSON request body");
  return JSON.parse(init.body) as unknown;
}

describe("BrowserUseCloudAdapter configuration and profile lifecycle", () => {
  test("reports unavailable configuration without a provider request or secret leak", async () => {
    const seen: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const missing = adapter([], seen, {});
    const invalid = adapter([], seen, { BROWSER_USE_API_KEY: " bad-key" });

    expect(missing.health()).toEqual({ kind: "unavailable", reason: "missing_configuration" });
    expect(invalid.health()).toEqual({ kind: "unavailable", reason: "invalid_configuration" });
    expect(await missing.createProfile()).toEqual({ kind: "failure", code: "missing_configuration" });
    expect(await invalid.createProfile()).toEqual({ kind: "failure", code: "invalid_configuration" });
    expect(seen).toEqual([]);
  });

  test("reports configured-but-unverified truthfully and creates/deletes an isolated profile", async () => {
    const seen: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const provider = adapter([
      jsonResponse({ id: PROFILE_ID }),
      new Response(null, { status: 204 }),
    ], seen);

    expect(provider.health()).toEqual({ kind: "available", verification: "not_checked" });
    expect(await provider.createProfile()).toEqual({ profileId: PROFILE_ID });
    expect(await provider.deleteProfile(PROFILE_ID)).toBeUndefined();
    expect(seen.map((request) => [request.url, request.init.method])).toEqual([
      [`${BROWSER_USE_V4_BASE_URL}/profiles`, "POST"],
      [`${BROWSER_USE_V4_BASE_URL}/profiles/${PROFILE_ID}`, "DELETE"],
    ]);
    expect(jsonBody(seen[0]!.init)).toEqual({});
    expect(seen[0]!.init.headers).toEqual({
      accept: "application/json",
      "content-type": "application/json",
      "x-browser-use-api-key": API_KEY,
    });
  });

  test("picks up a key saved through the live server API-key registry without restart", async () => {
    const serverKeys: Record<string, string | undefined> = {};
    const seen: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const provider = adapter([jsonResponse({ id: PROFILE_ID })], seen, serverKeys);
    expect(provider.health()).toEqual({ kind: "unavailable", reason: "missing_configuration" });
    serverKeys["BROWSER_USE_API_KEY"] = API_KEY;
    expect(provider.health()).toEqual({ kind: "available", verification: "not_checked" });
    expect(await provider.createProfile()).toEqual({ profileId: PROFILE_ID });
    expect(seen).toHaveLength(1);
  });
});

describe("BrowserUseCloudAdapter browser lifecycle", () => {
  test("starts, gets, and explicitly stops a non-recorded browser using provider expiry", async () => {
    const seen: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const receipts: unknown[] = [];
    const session = {
      id: BROWSER_ID,
      status: "active",
      liveUrl: "https://live.browser-use.com/private",
      cdpUrl: "https://11111111-1111-4111-8111-111111111111.cdp.browser-use.com",
      timeoutAt: "2026-09-01T16:00:00.000Z",
    };
    const provider = adapter([
      jsonResponse(session, 201),
      jsonResponse(session),
      jsonResponse({ ...session, status: "stopped", liveUrl: null, browserCost: "0.004", proxyCost: "0.0015" }),
    ], seen, { BROWSER_USE_API_KEY: API_KEY }, async (receipt) => { receipts.push(receipt); });

    expect(await provider.startBrowser({ profileId: PROFILE_ID, timeoutMinutes: 240 })).toMatchObject({
      browserId: BROWSER_ID,
      status: "active",
      liveViewUrl: session.liveUrl,
      timeoutAt: new Date(session.timeoutAt),
      observedAt: FIXED_TIME,
    });
    expect(await provider.getBrowser(BROWSER_ID)).toMatchObject({ browserId: BROWSER_ID });
    expect(await provider.stopBrowser(BROWSER_ID)).toMatchObject({ status: "stopped" });
    expect(jsonBody(seen[0]!.init)).toEqual({
      profileId: PROFILE_ID,
      timeout: 240,
      enableRecording: false,
    });
    expect(jsonBody(seen[2]!.init)).toEqual({ action: "stop" });
    expect(seen[1]!.url).toBe(`${BROWSER_USE_V4_BASE_URL}/browsers/${BROWSER_ID}`);
    expect(seen[2]!.url).toBe(`${BROWSER_USE_V4_BASE_URL}/browsers/${BROWSER_ID}`);
    expect(receipts).toEqual([expect.objectContaining({
      identity: `browser-use:browser-session:${BROWSER_ID}`,
      provider: "browser_use",
      operation: "browser_session",
      actualCostUsd: "0.00550000",
      evidenceState: "actual",
    })]);
  });

  test("requires an explicit documented browser timeout policy before any fetch", async () => {
    const seen: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const provider = adapter([], seen);

    expect(await provider.startBrowser({ profileId: PROFILE_ID, timeoutMinutes: 0 })).toEqual({
      kind: "failure",
      code: "invalid_browser_policy",
    });
    expect(await provider.startBrowser({ profileId: PROFILE_ID, timeoutMinutes: 240.5 })).toEqual({
      kind: "failure",
      code: "invalid_browser_policy",
    });
    expect(await provider.startBrowser({ profileId: PROFILE_ID, timeoutMinutes: 241 })).toEqual({
      kind: "failure",
      code: "invalid_browser_policy",
    });
    expect(seen).toEqual([]);
  });

  test("rejects bearer browser coordinates that do not match the documented provider hosts", async () => {
    const provider = adapter([
      jsonResponse({
        id: BROWSER_ID,
        status: "active",
        liveUrl: "https://attacker.example/frame",
        cdpUrl: "https://11111111-1111-4111-8111-111111111111.cdp.browser-use.com",
        timeoutAt: "2026-09-01T16:00:00.000Z",
      }, 201),
      jsonResponse({
        id: BROWSER_ID,
        status: "active",
        liveUrl: "https://live.browser-use.com/private",
        cdpUrl: "https://attacker.example/private",
        timeoutAt: "2026-09-01T16:00:00.000Z",
      }, 201),
    ]);
    expect(await provider.startBrowser({ profileId: PROFILE_ID, timeoutMinutes: 240 })).toEqual({ kind: "failure", code: "malformed_response" });
    expect(await provider.startBrowser({ profileId: PROFILE_ID, timeoutMinutes: 240 })).toEqual({ kind: "failure", code: "malformed_response" });
  });
});

describe("BrowserUseCloudAdapter hosted V4 read runs", () => {
  test("public hosted run omits profileId and cannot borrow a saved login", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const provider = adapter([jsonResponse({ id: RUN_ID, status: "queued", sessionId: "public-session", workspaceId: "public-workspace" })], seen);
    expect(await provider.createHostedReadRun({ task: "Research a public interactive page", maxCostUsd: 0.25 })).toMatchObject({ runId: RUN_ID, status: "queued" });
    expect(jsonBody(seen[0]!.init)).toMatchObject({ browserSettings: { record: false } });
    expect((jsonBody(seen[0]!.init) as { browserSettings: object }).browserSettings).not.toHaveProperty("profileId");
  });

  test("terminal run cleanup resolves its exact session then explicitly stops the browser", async () => {
    const seen: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const browser = { id: BROWSER_ID, status: "active", liveUrl: null, cdpUrl: null,
      timeoutAt: "2026-09-01T16:00:00.000Z", agentSessionId: "session" };
    const provider = adapter([
      jsonResponse({ id: RUN_ID, sessionId: "session", status: "completed", result: "done" }),
      jsonResponse({ items: [browser], totalItems: 1, pageNumber: 1, pageSize: 100 }),
      jsonResponse({ ...browser, status: "stopped" }),
    ], seen);
    expect(await provider.stopHostedReadBrowser(RUN_ID)).toBe(true);
    expect(seen.map(({ init }) => init.method)).toEqual(["GET", "GET", "PATCH"]);
    expect(seen[1]!.url).toContain("agentSessionId=session");
    expect(seen[2]!.url).toBe(`${BROWSER_USE_V4_BASE_URL}/browsers/${BROWSER_ID}`);
    expect(jsonBody(seen[2]!.init)).toEqual({ action: "stop" });
  });

  test("cancellation acceptance is not terminal browser cleanup proof", async () => {
    const seen: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const provider = adapter([
      jsonResponse({ id: RUN_ID, sessionId: "session", status: "running" }),
      jsonResponse({ status: "running" }), jsonResponse({ status: "running" }),
    ], seen);
    expect(await provider.stopHostedReadBrowser(RUN_ID)).toBe(false);
    expect(seen.map(({ init }) => init.method)).toEqual(["GET", "POST", "GET"]);
  });

  test("missing session or missing run stays unresolved instead of pretending billing stopped", async () => {
    expect(await adapter([jsonResponse({ status: "completed" })]).stopHostedReadBrowser(RUN_ID)).toBe(false);
    expect(await adapter([jsonResponse({}, 404)]).stopHostedReadBrowser(RUN_ID)).toBe(false);
  });
  test("continues a warm conversation without creating a browser or another session", async () => {
    const seen: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const provider = adapter([jsonResponse({ id: RUN_ID, status: "queued", sessionId: "same-session", workspaceId: "same-workspace" })], seen);
    expect(await provider.createHostedReadRun({ profileId: PROFILE_ID, task: "Inspect current usage", maxCostUsd: 1,
      sessionId: "same-session", workspaceId: "same-workspace" })).toMatchObject({ sessionId: "same-session" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(`${BROWSER_USE_V4_BASE_URL}/runs`);
    expect(jsonBody(seen[0]!.init)).toMatchObject({ sessionId: "same-session", workspaceId: "same-workspace", browserSettings: { profileId: PROFILE_ID } });
  });

  test("rejects a provider response that silently switches the requested reusable session", async () => {
    const provider = adapter([jsonResponse({ id: RUN_ID, status: "queued", sessionId: "other-session", workspaceId: "workspace" })]);
    expect(await provider.createHostedReadRun({ profileId: PROFILE_ID, task: "Inspect", maxCostUsd: 1, sessionId: "same-session" }))
      .toEqual({ kind: "failure", code: "malformed_response" });
  });

  test("creates, polls, reads provider cost, and cancels with Luna, explicit cost, and recording off", async () => {
    const seen: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const provider = adapter([
      jsonResponse({ id: RUN_ID, status: "queued", sessionId: "session-private-id", workspaceId: "workspace-private-id" }),
      jsonResponse({ status: "running" }),
      jsonResponse({ status: "completed", result: "untrusted result", totalCostUsd: "0.014" }),
      jsonResponse({ status: "cancelled" }),
    ], seen);

    expect(await provider.createHostedReadRun({
      profileId: PROFILE_ID,
      task: "Read the signed-in account page.",
      maxCostUsd: 0.25,
    })).toEqual({ runId: RUN_ID, sessionId: "session-private-id", workspaceId: "workspace-private-id", status: "queued", observedAt: FIXED_TIME });
    expect(await provider.pollHostedReadRun(RUN_ID)).toEqual({
      runId: RUN_ID,
      status: "running",
      observedAt: FIXED_TIME,
    });
    expect(await provider.getHostedReadResult(RUN_ID)).toEqual({
      runId: RUN_ID,
      status: "completed",
      result: "untrusted result",
      totalCostUsd: "0.014",
      observedAt: FIXED_TIME,
    });
    expect(await provider.cancelHostedReadRun(RUN_ID)).toEqual({
      runId: RUN_ID,
      status: "cancelled",
      observedAt: FIXED_TIME,
    });
    expect(jsonBody(seen[0]!.init)).toEqual({
      task: "Read the signed-in account page.",
      model: BROWSER_USE_DEFAULT_MODEL,
      browserSettings: { profileId: PROFILE_ID, record: false },
      maxCostUsd: 0.25,
    });
    expect(seen.map((request) => request.url)).toEqual([
      `${BROWSER_USE_V4_BASE_URL}/runs`,
      `${BROWSER_USE_V4_BASE_URL}/runs/${RUN_ID}/status`,
      `${BROWSER_USE_V4_BASE_URL}/runs/${RUN_ID}`,
      `${BROWSER_USE_V4_BASE_URL}/runs/${RUN_ID}/cancel`,
    ]);
  });

  test("projects V4 events into a coarse stage and live capability without forwarding event data", async () => {
    const seen: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const provider = adapter([
      jsonResponse({ status: "running" }),
      jsonResponse({
        events: [
          { runId: RUN_ID, id: 1, ts: "2026-09-01T12:00:00.000Z", type: "browser.ready", data: { live_view_url: "https://live.browser-use.com/?opaque", providerSecret: "never-forward" } },
          { runId: RUN_ID, id: 2, ts: "2026-09-01T12:00:01.000Z", type: "tool.started", data: { rawAction: "private-page-text" } },
          { runId: RUN_ID, id: 3, ts: "2026-09-01T12:00:02.000Z", type: "model.started", data: { privateThought: "never-forward" } },
        ],
        nextAfter: 3,
        hasMore: false,
      }),
    ], seen);

    const observed = await provider.observeHostedReadRun(RUN_ID);
    expect(observed).toEqual({
      runId: RUN_ID,
      status: "running",
      stage: "browsing",
      liveViewUrl: "https://live.browser-use.com/?opaque",
      observedAt: FIXED_TIME,
    });
    expect(JSON.stringify(observed)).not.toContain("never-forward");
    expect(JSON.stringify(observed)).not.toContain("private-page-text");
    expect(JSON.stringify(observed)).not.toContain("privateThought");
    expect(seen.map((request) => request.url)).toEqual([
      `${BROWSER_USE_V4_BASE_URL}/runs/${RUN_ID}/status`,
      `${BROWSER_USE_V4_BASE_URL}/runs/${RUN_ID}/events?limit=200&after=0&include_output=false`,
    ]);
  });

  test("reads and drains cursor pages without resetting the event cursor", async () => {
    const seen: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const provider = adapter([
      jsonResponse({
        events: [
          { runId: RUN_ID, id: 3, ts: "2026-09-01T12:00:03.000Z", type: "tool.started", data: { privatePageText: "server-only" } },
          { runId: RUN_ID, id: 4, ts: "2026-09-01T12:00:04.000Z", type: "browser.ready", data: { live_view_url: "https://live.browser-use.com/private" } },
        ],
        nextAfter: 4,
        hasMore: true,
      }),
      jsonResponse({
        events: [{ runId: RUN_ID, id: 5, ts: "2026-09-01T12:00:05.000Z", type: "artifact.ready", data: { privateFile: "server-only" } }],
        nextAfter: 5,
        hasMore: false,
      }),
    ], seen);

    const delta = await provider.drainHostedRunEventDeltas({ runId: RUN_ID, after: 2, limit: 2 });
    expect(delta).toMatchObject({
      runId: RUN_ID,
      nextAfter: 5,
      hasMore: false,
      events: [{ eventId: 3, type: "tool.started" }, { eventId: 4, type: "browser.ready" }, { eventId: 5, type: "artifact.ready" }],
    });
    expect(seen.map((request) => request.url)).toEqual([
      `${BROWSER_USE_V4_BASE_URL}/runs/${RUN_ID}/events?limit=2&after=2&include_output=false`,
      `${BROWSER_USE_V4_BASE_URL}/runs/${RUN_ID}/events?limit=2&after=4&include_output=false`,
    ]);

    const malformed = adapter([jsonResponse({
      events: [{ runId: "another-private-run", id: 3, ts: "2026-09-01T12:00:03.000Z", type: "tool.started", data: {} }],
      nextAfter: 3,
      hasMore: false,
    })]);
    expect(await malformed.readHostedRunEventDelta({ runId: RUN_ID, after: 2, limit: 2 }))
      .toEqual({ kind: "failure", code: "malformed_response" });
  });

  test("creates an explicit same-session continuation with its own model and remaining cost", async () => {
    const seen: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const provider = adapter([
      jsonResponse({
        id: "continuation-private-id",
        status: "queued",
        sessionId: "session-private-id",
        workspaceId: "workspace-private-id",
      }),
    ], seen);

    expect(await provider.createHostedReadContinuationRun({
      sessionId: "session-private-id",
      workspaceId: "workspace-private-id",
      task: "Continue the original bounded task.",
      model: "gpt-5.6-terra",
      maxCostUsd: 0.11,
    })).toEqual({
      runId: "continuation-private-id",
      sessionId: "session-private-id",
      workspaceId: "workspace-private-id",
      status: "queued",
      observedAt: FIXED_TIME,
    });
    expect(jsonBody(seen[0]!.init)).toEqual({
      task: "Continue the original bounded task.",
      model: "gpt-5.6-terra",
      sessionId: "session-private-id",
      workspaceId: "workspace-private-id",
      maxCostUsd: 0.11,
    });
    expect(seen[0]!.url).toBe(`${BROWSER_USE_V4_BASE_URL}/runs`);
  });

  test("does not erase an accepted cursor when the final drained page is empty", async () => {
    const provider = adapter([
      jsonResponse({
        events: [{ runId: RUN_ID, id: 4, ts: "2026-09-01T12:00:04.000Z", type: "tool.started", data: {} }],
        nextAfter: 4,
        hasMore: true,
      }),
      jsonResponse({ events: [], nextAfter: null, hasMore: false }),
    ]);
    expect(await provider.drainHostedRunEventDeltas({ runId: RUN_ID, after: 3, limit: 1 })).toMatchObject({
      events: [{ eventId: 4 }],
      nextAfter: 4,
      hasMore: false,
    });
  });

  test("inspects and submits queue steering without returning provider message text", async () => {
    const seen: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const provider = adapter([
      jsonResponse({
        queue: [{
          id: 7,
          sessionId: "session-private-id",
          runId: RUN_ID,
          mode: "interrupt",
          status: "dispatching",
          text: "private prior steer must not escape",
          createdAt: "2026-09-01T12:00:07.000Z",
        }, {
          id: 9,
          sessionId: "session-private-id",
          runId: null,
          mode: "queue",
          status: "consumed",
          text: "",
          createdAt: "2026-09-01T12:00:09.000Z",
        }],
        steeringCutoffs: [{ sourceRunId: RUN_ID, createdAt: "2026-09-01T12:00:07.000Z" }],
      }),
      jsonResponse({
        id: 8,
        sessionId: "session-private-id",
        runId: null,
        mode: "interrupt",
        status: "pending",
        text: "private new steer must not escape",
        createdAt: "2026-09-01T12:00:08.000Z",
      }),
    ], seen);

    const inspected = await provider.inspectHostedSessionQueue("session-private-id");
    expect(inspected).toMatchObject({
      sessionId: "session-private-id",
      messages: [
        { messageId: 7, runId: RUN_ID, mode: "interrupt", status: "dispatching" },
        { messageId: 9, runId: null, mode: "queue", status: "consumed" },
      ],
      steeringCutoffRunIds: [RUN_ID],
    });
    expect(JSON.stringify(inspected)).not.toContain("private prior steer");

    const queued = await provider.queueHostedSessionSteer({
      sessionId: "session-private-id",
      text: "Correct the task; do not repeat an external effect.",
      interrupt: true,
    });
    expect(queued).toMatchObject({
      messageId: 8,
      runId: null,
      mode: "interrupt",
      status: "pending",
      delivery: "interrupt_best_effort",
    });
    expect(JSON.stringify(queued)).not.toContain("private new steer");
    expect(jsonBody(seen[1]!.init)).toEqual({
      text: "Correct the task; do not repeat an external effect.",
      interrupt: true,
    });
    expect(seen.map((request) => request.url)).toEqual([
      `${BROWSER_USE_V4_BASE_URL}/sessions/session-private-id/queue`,
      `${BROWSER_USE_V4_BASE_URL}/sessions/session-private-id/queue`,
    ]);
  });

  test("looks up only hosted browsers associated with the requested agent session", async () => {
    const seen: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const provider = adapter([
      jsonResponse({
        items: [{
          id: BROWSER_ID,
          status: "active",
          liveUrl: "https://live.browser-use.com/private",
          cdpUrl: "https://11111111-1111-4111-8111-111111111111.cdp.browser-use.com",
          timeoutAt: "2026-09-01T16:00:00.000Z",
          startedAt: "2026-09-01T12:00:00.000Z",
          agentSessionId: "agent-session-private-id",
        }],
        totalItems: 1,
        pageNumber: 1,
        pageSize: 100,
      }),
    ], seen);

    const browsers = await provider.findHostedBrowsers({ agentSessionId: "agent-session-private-id" });
    expect(browsers).toMatchObject([{
      browserId: BROWSER_ID,
      agentSessionId: "agent-session-private-id",
      status: "active",
    }]);
    expect(seen[0]!.url).toBe(`${BROWSER_USE_V4_BASE_URL}/browsers?agentSessionId=agent-session-private-id&pageSize=100&pageNumber=1`);

    const mismatch = adapter([jsonResponse({
      items: [{
        id: BROWSER_ID,
        status: "active",
        liveUrl: null,
        cdpUrl: null,
        timeoutAt: "2026-09-01T16:00:00.000Z",
        startedAt: "2026-09-01T12:00:00.000Z",
        agentSessionId: "another-private-session",
      }],
      totalItems: 1,
      pageNumber: 1,
      pageSize: 100,
    })]);
    expect(await mismatch.findHostedBrowsers({ agentSessionId: "agent-session-private-id" }))
      .toEqual({ kind: "failure", code: "malformed_response" });
  });

  test("maps steering queue rejection without leaking the provider body", async () => {
    const provider = adapter([jsonResponse({ detail: "private queue capacity detail" }, 429)]);
    const result = await provider.queueHostedSessionSteer({
      sessionId: "session-private-id",
      text: "Correct the current task.",
      interrupt: true,
    });
    expect(result).toEqual({ kind: "failure", code: "rate_limited" });
    expect(JSON.stringify(result)).not.toContain("private queue capacity detail");
  });

  test("rejects missing cost policy and malformed success bodies before returning provider state", async () => {
    const seen: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const provider = adapter([
      jsonResponse({ id: RUN_ID, status: "unknown" }),
      jsonResponse({ status: "completed", result: { unsafe: "not a string" }, totalCostUsd: "0.25" }),
    ], seen);

    expect(await provider.createHostedReadRun({
      profileId: PROFILE_ID,
      task: "Read.",
      maxCostUsd: 0,
    })).toEqual({ kind: "failure", code: "invalid_cost_policy" });
    expect(await provider.createHostedReadRun({
      profileId: PROFILE_ID,
      task: "Read.",
      maxCostUsd: 0.25,
    })).toEqual({ kind: "failure", code: "malformed_response" });
    expect(await provider.getHostedReadResult(RUN_ID)).toEqual({
      kind: "failure",
      code: "malformed_response",
    });
    expect(seen).toHaveLength(2);
  });

  test("collects workspace files and browser downloads server-side without forwarding the API key", async () => {
    const seen: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const provider = adapter([
      jsonResponse({ files: [{ path: "reports/report.csv", size: 3, url: "https://storage.example/workspace?sig=private" }], hasMore: false }),
      jsonResponse({ files: [{ path: "download.png", size: 4, url: "https://storage.example/download?sig=private" }], hasMore: false }),
      new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "text/csv; charset=utf-8" } }),
      new Response(new Uint8Array([4, 5, 6, 7]), { headers: { "content-type": "image/png" } }),
    ], seen);

    const collected = await provider.collectHostedReadOutputs({
      workspaceId: "workspace-private-id",
      sessionId: "session-private-id",
      maxOutputs: 2,
    });
    expect(collected).toMatchObject({
      truncated: false,
      outputs: [
        { mimeType: "text/csv", bytes: new Uint8Array([1, 2, 3]) },
        { mimeType: "image/png", bytes: new Uint8Array([4, 5, 6, 7]) },
      ],
    });
    if ("outputs" in collected) {
      expect(collected.outputs[0]!.path).toMatch(/^connected-web\/[a-f0-9]{16}\/report\.csv$/u);
      expect(collected.outputs[1]!.path).toMatch(/^connected-web\/[a-f0-9]{16}\/download\.png$/u);
    }
    expect(seen[0]!.url).toBe(`${BROWSER_USE_V4_BASE_URL}/workspaces/workspace-private-id/files?includeUrls=true`);
    expect(seen[1]!.url).toBe(`${BROWSER_USE_V4_BASE_URL}/browsers/session-private-id/downloads?includeUrls=true`);
    expect(seen[2]!.init.headers).toBeUndefined();
    expect(seen[3]!.init.headers).toBeUndefined();
    expect(JSON.stringify(collected)).not.toContain("storage.example");
    expect(JSON.stringify(collected)).not.toContain("session-private-id");
    expect(JSON.stringify(collected)).not.toContain("workspace-private-id");
  });

  test("keeps workspace outputs when the independent browser-download surface is gone", async () => {
    const seen: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const provider = adapter([
      jsonResponse({ files: [{ path: "proof.txt", size: 5, url: "https://storage.example/workspace?sig=private" }], hasMore: false }),
      jsonResponse({ detail: "browser session already stopped" }, 404),
      new Response(new TextEncoder().encode("proof"), { headers: { "content-type": "text/plain" } }),
    ], seen);

    const collected = await provider.collectHostedReadOutputs({
      workspaceId: "workspace-private-id",
      sessionId: "session-private-id",
      maxOutputs: 4,
    });
    expect(collected).toMatchObject({
      truncated: false,
      outputs: [{ mimeType: "text/plain", bytes: new TextEncoder().encode("proof") }],
    });
    expect(seen).toHaveLength(3);
    expect(JSON.stringify(collected)).not.toContain("storage.example");
    expect(JSON.stringify(collected)).not.toContain("session-private-id");
    expect(JSON.stringify(collected)).not.toContain("workspace-private-id");
  });

  test("fails closed on malformed output lists before fetching a provider URL", async () => {
    const seen: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const provider = adapter([
      jsonResponse({ files: [{ path: "../unsafe", size: 3, url: "https://storage.example/private" }] }),
      jsonResponse({ files: [] }),
    ], seen);
    expect(await provider.collectHostedReadOutputs({
      workspaceId: "workspace-private-id",
      sessionId: "session-private-id",
      maxOutputs: 1,
    })).toEqual({ kind: "failure", code: "malformed_response" });
    expect(seen).toHaveLength(2);
  });
});

describe("BrowserUseCloudAdapter sanitized provider failures", () => {
  test("maps auth, balance, timeout, cancellation, stop failure, malformed output, and network failures without body leakage", async () => {
    const seen: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const failures = adapter([
      jsonResponse({ detail: "api key and provider id must not escape" }, 401),
      jsonResponse({ detail: "balance private" }, 402),
      jsonResponse({ detail: "slow" }, 504),
      jsonResponse({ detail: "stop failed" }, 503),
      jsonResponse({
        id: BROWSER_ID,
        status: "active",
        liveUrl: "https://live.browser-use.com/private",
        cdpUrl: "https://11111111-1111-4111-8111-111111111111.cdp.browser-use.com",
        timeoutAt: "invalid",
      }),
      new Error("network error includes private endpoint"),
    ], seen);

    expect(await failures.createProfile()).toEqual({ kind: "failure", code: "authentication_failed" });
    expect(await failures.createProfile()).toEqual({ kind: "failure", code: "insufficient_balance" });
    expect(await failures.createProfile()).toEqual({ kind: "failure", code: "timeout" });
    expect(await failures.stopBrowser(BROWSER_ID)).toEqual({ kind: "failure", code: "provider_unavailable" });
    const malformed = await failures.getBrowser(BROWSER_ID);
    expect(malformed).toEqual({ kind: "failure", code: "malformed_response" });
    expect(await failures.createProfile()).toEqual({ kind: "failure", code: "network_error" });

    const serialised = JSON.stringify(await Promise.all([
      failures.createProfile(),
      failures.getBrowser(BROWSER_ID),
    ]));
    expect(serialised).not.toContain(API_KEY);
    expect(serialised).not.toContain(BROWSER_ID);
    expect(serialised).not.toContain(PROFILE_ID);
    expect(serialised).not.toContain("live.browser-use.com");
    expect(serialised).not.toContain("cdp.browser-use.com");
    expect(serialised).not.toContain("stop failed");
    expect(serialised).not.toContain("private endpoint");
    expect(JSON.stringify(malformed)).not.toContain("live.browser-use.com");
    expect(JSON.stringify(malformed)).not.toContain("cdp.browser-use.com");
    expect(seen).toHaveLength(8);
  });

  test("maps an aborted request to cancellation without including the abort detail", async () => {
    const abort = new Error("private provider request aborted");
    abort.name = "AbortError";
    const provider = new BrowserUseCloudAdapter({
      serverKeys: { BROWSER_USE_API_KEY: API_KEY },
      fetch: async () => { throw abort; },
      clock: { now: () => FIXED_TIME },
    });

    const result = await provider.createProfile();
    expect(result).toEqual({ kind: "failure", code: "cancelled" });
    expect(JSON.stringify(result)).not.toContain("private provider request aborted");
  });

  test("uses an operational transport deadline without exposing transport detail", async () => {
    const provider = new BrowserUseCloudAdapter({
      serverKeys: { BROWSER_USE_API_KEY: API_KEY },
      requestTimeoutMs: 1,
      fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const error = new Error("private transport deadline");
          error.name = "AbortError";
          reject(error);
        });
      }),
    });
    expect(await provider.createProfile()).toEqual({ kind: "failure", code: "timeout" });
  });

  test("maps 403 and 422 to safe failures without reading their response bodies", async () => {
    const provider = adapter([
      jsonResponse({ detail: "project capability and profile id must stay private" }, 403),
      jsonResponse({ detail: "provider validation body must stay private" }, 422),
    ]);

    const results = await Promise.all([provider.createProfile(), provider.createProfile()]);
    expect(results).toEqual([
      { kind: "failure", code: "provider_unavailable" },
      { kind: "failure", code: "provider_unavailable" },
    ]);
    const serialised = JSON.stringify(results);
    expect(serialised).not.toContain("project capability");
    expect(serialised).not.toContain("provider validation");
  });
});
