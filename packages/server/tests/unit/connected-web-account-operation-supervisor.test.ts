import { describe, expect, test } from "bun:test";
import type {
  BrowserUseHostedReadResult,
  BrowserUseHostedReadRun,
  BrowserUseHostedRunEventDelta,
  BrowserUseResult,
} from "../../src/browser-use/browser-use-cloud";
import {
  ConnectedWebOperationSupervisor,
  type ConnectedWebOperationSupervisorProvider,
} from "../../src/connected-web-accounts/operation-supervisor";
import type {
  ConnectedWebAccountStore,
  ConnectedWebOperation,
} from "../../src/connected-web-accounts/store";

const NOW = new Date("2026-09-03T12:00:00.000Z");
const RUN_ID = "run-private-id";
const SEALED_RUN = "sealed-run-private-ref";

function operation(overrides: Partial<ConnectedWebOperation> = {}): ConnectedWebOperation {
  return {
    id: "operation-id",
    ownerUserId: "owner-id",
    accountId: "account-id",
    initiatingAgentId: "agent-id",
    initiatingRoomId: "room-id",
    initiatingThreadId: "thread-id",
    initiatingLane: "foreground",
    deliveryId: "delivery-id",
    requestDigest: "a".repeat(64),
    sealedIntent: "sealed-intent",
    actionOperationId: null,
    effectIdempotencyKey: null,
    driver: "hosted",
    lifecycle: "running",
    controlEpoch: 1,
    controlLeaseToken: "lease-id",
    controlLeaseExpiresAt: new Date("2026-09-03T12:01:00.000Z"),
    sealedProviderRefs: { version: 1, runRef: SEALED_RUN, sessionRef: "sealed-session-private-ref", workspaceRef: "sealed-workspace-private-ref" },
    eventCursor: 0,
    safeActivity: { version: 1, phase: "starting", code: "admitted", summary: "Connected website task admitted." },
    wakeFingerprint: null,
    nextCheckAt: NOW,
    supervisorClaimOwner: "worker-a",
    supervisorClaimExpiresAt: new Date("2026-09-03T12:01:00.000Z"),
    wakeClaimOwner: null,
    wakeClaimExpiresAt: null,
    wakeAttempts: 0,
    wakeDeliveredAt: null,
    cumulativeCostUsdMicros: 1_000,
    remainingBudgetUsdMicros: 49_000,
    terminalReceipt: null,
    terminalAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function running(): BrowserUseHostedReadRun {
  return { runId: RUN_ID, status: "running", observedAt: NOW };
}

function terminal(status: "completed" | "failed" | "cancelled"): BrowserUseHostedReadRun {
  return { runId: RUN_ID, status, observedAt: NOW };
}

function delta(input: {
  readonly events?: readonly { readonly id: number; readonly type: string; readonly data?: Readonly<Record<string, unknown>> }[];
  readonly nextAfter?: number | null;
  readonly hasMore?: boolean;
}): BrowserUseHostedRunEventDelta {
  return {
    runId: RUN_ID,
    events: (input.events ?? []).map((event) => ({
      eventId: event.id,
      occurredAt: NOW,
      type: event.type,
      data: event.data ?? {},
    })),
    nextAfter: input.nextAfter ?? null,
    hasMore: input.hasMore ?? false,
    observedAt: NOW,
  };
}

function provider(overrides: Partial<ConnectedWebOperationSupervisorProvider>): ConnectedWebOperationSupervisorProvider {
  return {
    pollHostedReadRun: async () => running(),
    readHostedRunEventDelta: async () => delta({}),
    getHostedReadResult: async () => ({ runId: RUN_ID, status: "completed", result: null, totalCostUsd: "0", observedAt: NOW }),
    ...overrides,
  };
}

function storeFor(input: {
  readonly operations: readonly ConnectedWebOperation[];
  readonly records: unknown[];
  readonly releases: unknown[];
  readonly terminalizations: unknown[];
  readonly recordResults?: readonly boolean[];
  readonly releaseResult?: boolean;
  readonly terminalResult?: boolean;
}): Pick<ConnectedWebAccountStore, "claimDueOperations" | "releaseOperationClaim" | "recordOperationCheckpoint" | "terminalizeOperation" | "terminalizeReadOperationAndCompleteExecution" | "getForOwner"> {
  let recordIndex = 0;
  return {
    claimDueOperations: async () => input.operations,
    recordOperationCheckpoint: async (record) => {
      input.records.push(record);
      return input.recordResults?.[recordIndex++] ?? true;
    },
    releaseOperationClaim: async (release) => {
      input.releases.push(release);
      return input.releaseResult ?? true;
    },
    terminalizeOperation: async (terminalization) => {
      input.terminalizations.push(terminalization);
      return input.terminalResult ?? true;
    },
    terminalizeReadOperationAndCompleteExecution: async (terminalization) => {
      input.terminalizations.push(terminalization);
      return input.terminalResult ?? true;
    },
    getForOwner: async () => ({ id: "account-id", label: "Account", service: "Example", origin: "https://example.com", status: "busy", lastVerifiedAt: null, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() }),
  };
}

function supervisor(input: {
  readonly store: Pick<ConnectedWebAccountStore, "claimDueOperations" | "releaseOperationClaim" | "recordOperationCheckpoint" | "terminalizeOperation" | "terminalizeReadOperationAndCompleteExecution" | "getForOwner">;
  readonly provider?: ConnectedWebOperationSupervisorProvider;
  readonly intent?: string;
  readonly unseal?: () => Promise<{ readonly runId: string | null; readonly sessionId: string | null; readonly workspaceId: string | null; readonly browserId: string | null; } | null>;
}) {
  return new ConnectedWebOperationSupervisor({
    store: input.store,
    provider: input.provider ?? provider({}),
    providerReferences: {
      unseal: async () => input.unseal ? input.unseal() : ({
        runId: RUN_ID,
        sessionId: "session-private-id",
        workspaceId: "workspace-private-id",
        browserId: null,
      }),
      unsealIntent: async () => input.intent ?? JSON.stringify({ version: 2, kind: "read_connected_web_account", fundingHumanUserId: "77777777-7777-4777-8777-777777777777", origin: "https://example.com", request: "read", delivery: "text", deliveryId: "delivery-id", threadId: "thread-id", lane: "foreground", turnId: "turn-id" }),
    },
    clock: { now: () => NOW },
    eventPageLimit: 2,
    nextCheckAt: ({ now }) => new Date(now.getTime() + 1_000),
  });
}

describe("ConnectedWebOperationSupervisor", () => {
  test("terminal persistence retry cannot charge the same run against the budget twice", async () => {
    let current = operation({ actionOperationId: "11111111-1111-4111-8111-111111111111" });
    const original = current.cumulativeCostUsdMicros;
    const terminalWrites: Array<{ cumulativeCostUsdMicros?: number }> = [];
    const store = storeFor({ operations: [], records: [], releases: [], terminalizations: [] });
    store.claimDueOperations = async () => [current];
    store.recordOperationCheckpoint = async (record) => {
      current = { ...current, ...record };
      return true;
    };
    store.terminalizeOperation = async (record) => {
      terminalWrites.push(record);
      // Simulate a failed transaction before the receipt commits.
      return terminalWrites.length > 1;
    };
    const runner = supervisor({ store, provider: provider({
      pollHostedReadRun: async () => terminal("completed"),
      getHostedReadResult: async () => ({ runId: RUN_ID, status: "completed", result: null, totalCostUsd: "0.01", observedAt: NOW }),
    }) });
    await runner.runOnce({ workerId: "worker-a", leaseMs: 1_000 });
    await runner.runOnce({ workerId: "worker-a", leaseMs: 1_000 });
    expect(terminalWrites.map((write) => write.cumulativeCostUsdMicros)).toEqual([original + 10_000, original + 10_000]);
    expect(current.cumulativeCostUsdMicros).toBe(original);
  });

  test("commits supported browser actions for the activity log without waking the Genie", async () => {
    const records: unknown[] = [];
    const runner = supervisor({ store: storeFor({ operations: [operation()], records, releases: [], terminalizations: [] }), provider: provider({
      readHostedRunEventDelta: async () => delta({ events: [{ id: 12, type: "core.event", data: {
        part: { type: "tool", tool: "browser_execute", state: { status: "completed", input: { description: "Inspect billing navigation", code: "private code" }, output: "private output" } },
      } }], nextAfter: 12 }),
    }) });
    await runner.runOnce({ workerId: "worker-a", now: NOW, leaseMs: 60_000 } as never);
    expect(records[0]).toMatchObject({ eventCursor: 12, safeActivity: { summary: "Inspect billing navigation" },
      activityEntries: [{ providerEventId: 12, summary: "Inspect billing navigation", status: "completed" }] });
    expect(records[0]).not.toHaveProperty("wakeFingerprint");
    expect(JSON.stringify(records)).not.toMatch(/private code|private output/);
  });

  test("wakes the Genie when a browser action fails", async () => {
    const records: unknown[] = [];
    const runner = supervisor({ store: storeFor({ operations: [operation()], records, releases: [], terminalizations: [] }), provider: provider({
      readHostedRunEventDelta: async () => delta({ events: [{ id: 12, type: "core.event", data: {
        part: { type: "tool", tool: "browser_execute", state: { status: "error", input: { description: "Inspect billing navigation", code: "private code" }, output: "private output" } },
      } }], nextAfter: 12 }),
    }) });
    await runner.runOnce({ workerId: "worker-a", now: NOW, leaseMs: 60_000 } as never);
    expect(records[0]).toMatchObject({ eventCursor: 12, safeActivity: { summary: "Inspect billing navigation" },
      activityEntries: [{ providerEventId: 12, summary: "Inspect billing navigation", status: "error" }] });
    expect(records[0]).toHaveProperty("wakeFingerprint");
    expect(JSON.stringify(records)).not.toMatch(/private code|private output/);
  });

  test("persists every cursor page before advancing and projects no raw event data", async () => {
    const records: unknown[] = [];
    const releases: unknown[] = [];
    const terminalizations: unknown[] = [];
    const pages = [
      delta({
        events: [{ id: 1, type: "tool.started", data: { pageText: "do not project", live_view_url: "https://live.browser-use.com/private" } }],
        nextAfter: 1,
        hasMore: true,
      }),
      delta({
        events: [{ id: 2, type: "artifact.ready", data: { cdpUrl: "wss://private" } }],
        nextAfter: 2,
      }),
    ];
    const calls: Array<{ readonly after: number; readonly limit: number }> = [];
    const result = await supervisor({
      store: storeFor({ operations: [operation()], records, releases, terminalizations }),
      provider: provider({
        readHostedRunEventDelta: async (input) => {
          calls.push({ after: input.after, limit: input.limit });
          return pages.shift() ?? delta({});
        },
      }),
    }).runOnce({ workerId: "worker-a", leaseMs: 1_000 });

    expect(result).toEqual({ claimed: 1, reconciled: 0, rescheduled: 1, terminalized: 0, stale: 0 });
    expect(calls).toEqual([{ after: 0, limit: 2 }, { after: 1, limit: 2 }]);
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({ expectedEventCursor: 0, eventCursor: 1, safeActivity: { code: "provider_browser_activity" } });
    expect(records[1]).toMatchObject({
      expectedEventCursor: 1,
      eventCursor: 2,
      nextCheckAt: NOW,
      safeActivity: { code: "provider_artifact_activity" },
    });
    expect(JSON.stringify(records)).not.toContain("do not project");
    expect(JSON.stringify(records)).not.toContain("live.browser-use.com");
    expect(JSON.stringify(records)).not.toContain("wss://private");
    expect(releases).toHaveLength(1);
    expect(terminalizations).toEqual([]);
  });

  test("reschedules a provider failure without terminalizing, spinning, or creating another run", async () => {
    const records: unknown[] = [];
    const releases: unknown[] = [];
    const terminalizations: unknown[] = [];
    let readEvents = 0;
    const result = await supervisor({
      store: storeFor({ operations: [operation()], records, releases, terminalizations }),
      provider: provider({
        pollHostedReadRun: async () => ({ kind: "failure", code: "provider_unavailable" }),
        readHostedRunEventDelta: async () => { readEvents += 1; return delta({}); },
      }),
    }).runOnce({ workerId: "worker-a", leaseMs: 1_000 });

    expect(result).toEqual({ claimed: 1, reconciled: 0, rescheduled: 1, terminalized: 0, stale: 0 });
    expect(readEvents).toBe(0);
    expect(records).toMatchObject([{ safeActivity: { phase: "checking", code: "provider_check_pending" } }]);
    expect(releases).toMatchObject([{ nextCheckAt: new Date("2026-09-03T12:00:01.000Z") }]);
    expect(terminalizations).toEqual([]);
  });

  test("commits conservative cost with terminal truth rather than a separate checkpoint", async () => {
    const records: unknown[] = [];
    const releases: unknown[] = [];
    const terminalizations: unknown[] = [];
    const result = await supervisor({
      store: storeFor({ operations: [operation({ actionOperationId: "11111111-1111-4111-8111-111111111111" })], records, releases, terminalizations }),
      provider: provider({
        pollHostedReadRun: async () => terminal("completed"),
        getHostedReadResult: async (): Promise<BrowserUseResult<BrowserUseHostedReadResult>> => ({
          runId: RUN_ID,
          status: "completed",
          result: "untrusted output must not reach the receipt",
          totalCostUsd: "0.0123456",
          observedAt: NOW,
        }),
      }),
    }).runOnce({ workerId: "worker-a", leaseMs: 1_000 });

    expect(result).toEqual({ claimed: 1, reconciled: 0, rescheduled: 0, terminalized: 1, stale: 0 });
    expect(records).toMatchObject([
      { expectedEventCursor: 0, eventCursor: 0, safeActivity: { code: "provider_terminal" } },
    ]);
    expect(terminalizations).toMatchObject([{
      cumulativeCostUsdMicros: 13_346,
      remainingBudgetUsdMicros: 36_654,
      safeActivity: { code: "provider_terminal_verified" },
      expectedRunRef: SEALED_RUN,
      receipt: {
        outcome: "completed",
        code: "provider_completed",
        actionOperationId: "11111111-1111-4111-8111-111111111111",
      },
    }]);
    expect(JSON.stringify(terminalizations)).not.toContain("untrusted output");
    expect(releases).toEqual([]);
  });

  test("stops local processing after a stale cursor CAS instead of overwriting a newer operation", async () => {
    const records: unknown[] = [];
    const releases: unknown[] = [];
    const terminalizations: unknown[] = [];
    const result = await supervisor({
      store: storeFor({ operations: [operation()], records, releases, terminalizations, recordResults: [false] }),
      provider: provider({ readHostedRunEventDelta: async () => delta({ events: [{ id: 1, type: "tool.started" }], nextAfter: 1 }) }),
    }).runOnce({ workerId: "worker-a", leaseMs: 1_000 });

    expect(result).toEqual({ claimed: 1, reconciled: 0, rescheduled: 0, terminalized: 0, stale: 1 });
    expect(records).toHaveLength(1);
    expect(releases).toEqual([]);
    expect(terminalizations).toEqual([]);
  });

  test("keeps a running auth-like event under hosted authority until a validated Human contract exists", async () => {
    const records: unknown[] = [];
    const releases: unknown[] = [];
    const terminalizations: unknown[] = [];
    const result = await supervisor({
      store: storeFor({ operations: [operation()], records, releases, terminalizations }),
      provider: provider({
        pollHostedReadRun: async () => running(),
        readHostedRunEventDelta: async () => delta({ events: [{ id: 1, type: "authentication.required" }], nextAfter: 1 }),
      }),
    }).runOnce({ workerId: "worker-a", leaseMs: 1_000 });

    expect(result).toEqual({ claimed: 1, reconciled: 0, rescheduled: 1, terminalized: 0, stale: 0 });
    expect(records[0]).toMatchObject({
      lifecycle: "running",
      driver: "hosted",
      safeActivity: { code: "provider_activity" },
    });
    expect(records[0]).not.toHaveProperty("wakeFingerprint");
    expect(releases).toMatchObject([{ nextCheckAt: new Date("2026-09-03T12:00:01.000Z") }]);
    expect(terminalizations).toEqual([]);
  });

  test("records browser readiness without waking the Genie", async () => {
    const records: unknown[] = [];
    const releases: unknown[] = [];
    const terminalizations: unknown[] = [];
    await supervisor({
      store: storeFor({ operations: [operation()], records, releases, terminalizations }),
      provider: provider({ readHostedRunEventDelta: async () => delta({ events: [{ id: 1, type: "browser.ready", data: { live_view_url: "https://live.browser-use.com/private" } }], nextAfter: 1 }) }),
    }).runOnce({ workerId: "worker-a", leaseMs: 1_000 });

    expect(records[0]).toMatchObject({
      eventCursor: 1,
      safeActivity: { code: "provider_browser_ready" },
    });
    const fingerprint = (records[0] as { readonly wakeFingerprint?: unknown } | undefined)?.wakeFingerprint;
    expect(fingerprint).toBeUndefined();
    expect(JSON.stringify(records)).not.toContain("live.browser-use.com");
  });

  test("terminalizes a null-cost completion once while consuming continuation budget", async () => {
    const records: unknown[] = [];
    const releases: unknown[] = [];
    const terminalizations: unknown[] = [];
    const result = await supervisor({
      store: storeFor({ operations: [operation()], records, releases, terminalizations }),
      provider: provider({
        pollHostedReadRun: async () => terminal("completed"),
        getHostedReadResult: async () => ({ runId: RUN_ID, status: "completed", result: null, totalCostUsd: null, observedAt: NOW }),
      }),
    }).runOnce({ workerId: "worker-a", leaseMs: 1_000 });

    expect(result).toEqual({ claimed: 1, reconciled: 0, rescheduled: 0, terminalized: 1, stale: 0 });
    expect(records).toMatchObject([
      { cumulativeCostUsdMicros: 1_000, remainingBudgetUsdMicros: 49_000 },
    ]);
    expect(terminalizations).toMatchObject([{
      cumulativeCostUsdMicros: 50_000, remainingBudgetUsdMicros: 0,
      safeActivity: { code: "provider_cost_unknown" },
      receipt: { outcome: "completed", code: "provider_completed_cost_unknown" },
    }]);
    expect(releases).toEqual([]);
  });

  test("uses one terminal GET and completes malformed provider text with a null durable read", async () => {
    const records: unknown[] = [];
    const releases: unknown[] = [];
    const terminalizations: unknown[] = [];
    let gets = 0;
    const result = await supervisor({
      store: storeFor({ operations: [operation()], records, releases, terminalizations }),
      provider: provider({
        pollHostedReadRun: async () => terminal("completed"),
        getHostedReadResult: async () => { gets += 1; return { runId: RUN_ID, status: "completed", result: "not JSON", totalCostUsd: "0", observedAt: NOW }; },
      }),
    }).runOnce({ workerId: "worker-a", leaseMs: 1_000 });
    expect(result.terminalized).toBe(1);
    expect(gets).toBe(1);
    expect(terminalizations).toMatchObject([{ receipt: { outcome: "completed" }, terminalReadResult: { read: null, outputs: [], outputsTruncated: false } }]);
  });

  test("converts a validated terminal authentication outcome into exact account attention", async () => {
    const records: unknown[] = [];
    const releases: unknown[] = [];
    const terminalizations: unknown[] = [];
    const result = await supervisor({
      store: storeFor({ operations: [operation()], records, releases, terminalizations }),
      provider: provider({
        pollHostedReadRun: async () => terminal("completed"),
        getHostedReadResult: async () => ({ runId: RUN_ID, status: "completed", result: JSON.stringify({ outcome: "authentication_required", reason: "mfa" }), totalCostUsd: "0", observedAt: NOW }),
      }),
    }).runOnce({ workerId: "worker-a", leaseMs: 1_000 });
    expect(result.terminalized).toBe(1);
    expect(terminalizations).toMatchObject([{ receipt: { outcome: "attention_required", code: "authentication_required" }, terminalReadResult: null, authenticationRequired: "mfa" }]);
  });
});

describe("D585 public browser completion", () => {
  const publicOp = () => operation({ accountId: null, id: "55555555-5555-4555-8555-555555555555" });
  const intent = JSON.stringify({ version: 2, kind: "browse_web", fundingHumanUserId: "77777777-7777-4777-8777-777777777777", targetUrl: "https://example.com/search", origin: "https://example.com", request: "Read", delivery: "text", deliveryId: "delivery-id", threadId: "thread-id", lane: "foreground", turnId: "turn-id", voiceMode: false });
  test("a task stopped over a dangerous step retains partial evidence, not a fabricated success", async () => {
    const terminalizations: unknown[] = [];
    await supervisor({ store: storeFor({ operations: [publicOp()], records: [], releases: [], terminalizations }),
      intent: JSON.stringify({ ...JSON.parse(intent), kind: "run_website_task", request: "Update the requested record" }),
      provider: provider({ pollHostedReadRun: async () => terminal("completed"), getHostedReadResult: async () => ({ runId: RUN_ID, status: "completed", totalCostUsd: "0", observedAt: NOW,
        result: JSON.stringify({ answer: "Updated the title. Stopped before an unexpected permanent deletion.", facts: [{ label: "Title", value: "Updated" }], completeness: "partial", provenance: "public_website", origin: "https://example.com" }) }) }),
    }).runOnce({ workerId: "worker-a", leaseMs: 60_000 });
    expect(terminalizations).toMatchObject([{ terminalReadResult: { read: { completeness: "partial", answer: "Updated the title. Stopped before an unexpected permanent deletion." } } }]);
  });
  test.each([false, true])("terminalizes without looking up an account; authentication checkpoint=%s", async (auth) => {
    const terminalizations: unknown[] = [];
    const store = storeFor({ operations: [publicOp()], records: [], releases: [], terminalizations });
    store.getForOwner = async () => { throw new Error("Public completion accessed private accounts"); };
    const runner = supervisor({ store, intent, provider: provider({
      pollHostedReadRun: async () => terminal("completed"),
      getHostedReadResult: async () => ({ runId: RUN_ID, status: "completed", totalCostUsd: "0.01", observedAt: NOW,
        result: JSON.stringify(auth ? { outcome: "authentication_required", reason: "sign_in" } : { answer: "Two public results", facts: [], completeness: "complete", provenance: "public_website", origin: "https://example.com" }) }),
    }) });
    await runner.runOnce({ workerId: "worker-a", now: NOW, leaseMs: 60_000 } as never);
    expect(terminalizations).toHaveLength(1);
    expect(terminalizations[0]).toMatchObject({ accountId: null, receipt: { outcome: auth ? "attention_required" : "completed" } });
    if (!auth) expect(terminalizations[0]).toMatchObject({ terminalReadResult: { account: null, read: { answer: "Two public results", provenance: "public_website" } } });
  });
  test("a public run with an unparseable answer is failed, not a completed research result", async () => {
    const terminalizations: unknown[] = [];
    await supervisor({ store: storeFor({ operations: [publicOp()], records: [], releases: [], terminalizations }), intent,
      provider: provider({ pollHostedReadRun: async () => terminal("completed"),
        getHostedReadResult: async () => ({ runId: RUN_ID, status: "completed", totalCostUsd: "0.01", observedAt: NOW, result: "invalid" }),
      }),
    }).runOnce({ workerId: "worker-a", leaseMs: 60_000 });
    expect(terminalizations[0]).toMatchObject({ receipt: { outcome: "failed", code: "invalid_result" }, terminalReadResult: null });
  });
  test("a public operation cannot finalize with private sealed authority", async () => {
    const terminalizations: unknown[] = [];
    await supervisor({ store: storeFor({ operations: [publicOp()], records: [], releases: [], terminalizations }),
      provider: provider({ pollHostedReadRun: async () => terminal("completed") }),
    }).runOnce({ workerId: "worker-a", now: NOW, leaseMs: 60_000 } as never);
    expect(terminalizations[0]).toMatchObject({ receipt: { outcome: "failed", code: "invalid_read_authority" } });
  });
});
