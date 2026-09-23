import { describe, expect, test } from "bun:test";
import type { ConnectedWebAccount } from "@nautilo/types";
import {
  createConnectedWebAccountReadServerRuntime,
  type ConnectedWebAccountReadProvider,
  type ConnectedWebAccountReadRuntimeOptions,
} from "../../src/connected-web-accounts/read-tool-runtime.ts";
import { isExactOwnersPersonalPrivateRoom } from "../../src/connected-web-accounts/read-tool-runtime-composition.ts";

const OWNER_ID = "human-1";
const FUNDING_HUMAN_ID = "human-caller";
const AGENT_ID = "agent-1";
const ROOM_ID = "room-personal";
const ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";
const ORIGIN = "https://app.example.test";
const NOW = new Date("2026-09-01T12:00:00.000Z");
type RecordedCost = Parameters<NonNullable<ConnectedWebAccountReadRuntimeOptions["recordProviderCost"]>>[0];

function account(overrides: Partial<ConnectedWebAccount> = {}): ConnectedWebAccount {
  return {
    id: ACCOUNT_ID,
    service: "Example",
    origin: ORIGIN,
    label: "My Example",
    status: "connected",
    lastVerifiedAt: NOW.toISOString(),
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function successJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    answer: "You have three pending items.",
    facts: [{ label: "Pending", value: "3" }],
    completeness: "complete",
    provenance: "authenticated_website",
    origin: ORIGIN,
    ...overrides,
  });
}

function makeProvider(overrides: Partial<ConnectedWebAccountReadProvider> = {}): {
  readonly provider: ConnectedWebAccountReadProvider;
  readonly calls: { create: Array<{ profileId?: string; task: string; maxCostUsd: number }>; poll: string[]; get: string[]; cancel: string[] };
} {
  const calls = { create: [], poll: [], get: [], cancel: [] } as {
    create: Array<{ profileId?: string; task: string; maxCostUsd: number }>;
    poll: string[];
    get: string[];
    cancel: string[];
  };
  const provider: ConnectedWebAccountReadProvider = {
    stopHostedReadBrowser: async () => true,
    health: () => ({ kind: "available" }),
    createHostedReadRun: async (input) => {
      calls.create.push(input);
      return { runId: "run-private-id", status: "queued" };
    },
    pollHostedReadRun: async (runId) => {
      calls.poll.push(runId);
      return { runId, status: "completed" };
    },
    getHostedReadResult: async (runId) => {
      calls.get.push(runId);
      return { runId, status: "completed", result: successJson(), totalCostUsd: "0.014" };
    },
    cancelHostedReadRun: async (runId) => {
      calls.cancel.push(runId);
      return { runId, status: "cancelled" };
    },
    ...overrides,
  };
  return { provider, calls };
}

function makeRuntime(
  overrides: Partial<ConnectedWebAccountReadRuntimeOptions> = {},
): {
  readonly runtime: ReturnType<typeof createConnectedWebAccountReadServerRuntime>;
  readonly providerCalls: ReturnType<typeof makeProvider>["calls"];
  readonly checkpoints: string[];
  readonly finishes: string[];
  readonly recordedCosts: RecordedCost[];
} {
  const { provider, calls: providerCalls } = makeProvider(overrides.provider);
  const checkpoints: string[] = [];
  const finishes: string[] = [];
  const recordedCosts: RecordedCost[] = [];
  const options: ConnectedWebAccountReadRuntimeOptions = {
    facts: {
      hasExactOwnedGenie: async () => true,
      isOwnersPersonalPrivateRoom: async () => true,
    },
    accounts: {
      listForOwner: async () => [account()],
      getBindingForOwner: async () => ({
        accountId: ACCOUNT_ID,
        ownerUserId: OWNER_ID,
        service: "Example",
        origin: ORIGIN,
        status: "connected",
        profileRef: "profile-private-id",
      }),
    },
    executions: {
      reserveExecutionCheckpoint: async (input) => { checkpoints.push(`reserve:${input.checkpoint.reservationToken}`); },
      activateExecutionCheckpoint: async (input) => { checkpoints.push(`active:${input.reservationToken}:${input.opaqueExecutionRef}`); },
      completeExecution: async (input) => { finishes.push(`${input.status}:${input.reservationToken}`); },
      releaseExecutionReservation: async (input) => { finishes.push(`released:${input.reservationToken}:${input.status}`); },
    },
    provider,
    policy: { maxCostUsd: 0.25, pollIntervalMs: 1_000 },
    clock: { now: () => NOW },
    sleep: async () => undefined,
    createReservationToken: () => "reservation-private-token",
    recordProviderCost: async (input) => { recordedCosts.push(input); },
    ...overrides,
  };
  return { runtime: createConnectedWebAccountReadServerRuntime(options), providerCalls, checkpoints, finishes, recordedCosts };
}

const ACTOR = { userId: OWNER_ID, causalHumanUserId: FUNDING_HUMAN_ID, agentId: AGENT_ID, roomId: ROOM_ID, callingRoomId: null, memoryAccessEnvelope: {} as never };
const INPUT = { account: "My Example", request: "How many pending items are there?", delivery: "text" as const };

describe("ConnectedWebAccount read runtime authority", () => {
  test("admits only the owner private Room with one Human and the calling owned Genie", () => {
    const baseRows = [
      { roomOwnerId: OWNER_ID, roomKind: "private", roomType: "private", roomArchivedAt: null, actorOwnerId: OWNER_ID, actorKind: "user", actorAgentId: null },
      { roomOwnerId: OWNER_ID, roomKind: "private", roomType: "private", roomArchivedAt: null, actorOwnerId: OWNER_ID, actorKind: "agent", actorAgentId: AGENT_ID },
    ];
    expect(isExactOwnersPersonalPrivateRoom({ ownerUserId: OWNER_ID, agentId: AGENT_ID }, baseRows)).toBe(true);
    expect(isExactOwnersPersonalPrivateRoom({ ownerUserId: OWNER_ID, agentId: AGENT_ID }, [
      ...baseRows,
      { ...baseRows[0]!, actorOwnerId: "another-human" },
    ])).toBe(false);
    expect(isExactOwnersPersonalPrivateRoom({ ownerUserId: OWNER_ID, agentId: AGENT_ID }, baseRows.map((row) => ({ ...row, roomKind: "group" })))).toBe(false);
    expect(isExactOwnersPersonalPrivateRoom({ ownerUserId: OWNER_ID, agentId: AGENT_ID }, baseRows.map((row) => ({ ...row, roomArchivedAt: NOW })))).toBe(false);
    expect(isExactOwnersPersonalPrivateRoom({ ownerUserId: OWNER_ID, agentId: AGENT_ID }, baseRows.filter((row) => row.actorKind !== "agent"))).toBe(false);
    expect(isExactOwnersPersonalPrivateRoom({ ownerUserId: OWNER_ID, agentId: AGENT_ID }, [
      ...baseRows,
      { ...baseRows[1]!, actorAgentId: "another-agent" },
    ])).toBe(false);
  });

  test("fails closed before enumeration for a non-owned Genie or a non-personal Room", async () => {
    const first = makeRuntime({ facts: { hasExactOwnedGenie: async () => false, isOwnersPersonalPrivateRoom: async () => true } });
    const second = makeRuntime({ facts: { hasExactOwnedGenie: async () => true, isOwnersPersonalPrivateRoom: async () => false } });

    expect(await first.runtime.read(ACTOR, INPUT)).toEqual({ ok: false, code: "unavailable", recovery: "none" });
    expect(await second.runtime.read(ACTOR, INPUT)).toEqual({ ok: false, code: "unavailable", recovery: "none" });
    expect(first.providerCalls.create).toEqual([]);
    expect(second.providerCalls.create).toEqual([]);
  });

  test("lists only safe, usable account selectors after the same foreground authority check", async () => {
    const { runtime } = makeRuntime({
      accounts: {
        listForOwner: async () => [
          account({
            id: "00000000-0000-4000-8000-000000000004",
            label: "Zeta",
            status: "expired",
          }),
          account({
            id: "00000000-0000-4000-8000-000000000002",
            label: "Connecting",
            status: "connecting",
          }),
          account({
            id: "00000000-0000-4000-8000-000000000003",
            label: "Revoked",
            status: "revoked",
          }),
          account({ label: "Alpha" }),
        ],
        getBindingForOwner: async () => { throw new Error("inventory must not bind a provider profile"); },
      },
    });

    const result = await runtime.listAvailable(ACTOR);
    expect(result).toEqual([
      { label: "Alpha", service: "Example", origin: ORIGIN, status: "connected" },
      { label: "Zeta", service: "Example", origin: ORIGIN, status: "expired" },
    ]);
    expect(JSON.stringify(result)).not.toContain(ACCOUNT_ID);
    expect(JSON.stringify(result)).not.toContain("profile");
  });

  test("does not enumerate accounts for an unauthorized or background actor", async () => {
    let listCalls = 0;
    const accounts = {
      listForOwner: async () => {
        listCalls += 1;
        return [account()];
      },
      getBindingForOwner: async () => { throw new Error("unauthorized inventory must not bind an account"); },
    };
    const unauthorized = makeRuntime({
      facts: {
        hasExactOwnedGenie: async () => false,
        isOwnersPersonalPrivateRoom: async () => true,
      },
      accounts,
    });
    const background = makeRuntime({ accounts });

    expect(await unauthorized.runtime.listAvailable(ACTOR)).toEqual([]);
    expect(await background.runtime.listAvailable({ ...ACTOR, callingRoomId: "task-room-1" })).toEqual([]);
    expect(listCalls).toBe(0);
  });

  test("excludes background/task calling-room contexts before account enumeration", async () => {
    const { runtime, providerCalls } = makeRuntime();
    expect(await runtime.read({ ...ACTOR, callingRoomId: "task-room-1" }, INPUT)).toEqual({
      ok: false,
      code: "unavailable",
      recovery: "none",
    });
    expect(providerCalls.create).toEqual([]);
  });

  test("does not guess among same-owner accounts", async () => {
    const { runtime, providerCalls } = makeRuntime({
      accounts: {
        listForOwner: async () => [account(), account({ id: "00000000-0000-4000-8000-000000000002", label: "Work Example" })],
        getBindingForOwner: async () => { throw new Error("must not bind ambiguous selector"); },
      },
    });

    expect(await runtime.read(ACTOR, { ...INPUT, account: "Example" })).toEqual({
      ok: false,
      code: "ambiguous_account",
      recovery: "none",
    });
    expect(providerCalls.create).toEqual([]);
  });

  test("resolves a unique connected login from its parent site or provider name", async () => {
    const nebiusOrigin = "https://console.nebius.com";
    const nebiusAccount = account({
      service: "Nebius Cloud",
      origin: nebiusOrigin,
      label: "console.nebius.com",
    });
    const nebiusProvider = makeProvider({
      getHostedReadResult: async (runId) => ({
        runId,
        status: "completed",
        result: successJson({ origin: nebiusOrigin }),
        totalCostUsd: "0.014",
      }),
    });
    const { runtime } = makeRuntime({
      provider: nebiusProvider.provider,
      accounts: {
        listForOwner: async () => [nebiusAccount],
        getBindingForOwner: async () => ({
          accountId: ACCOUNT_ID,
          ownerUserId: OWNER_ID,
          service: nebiusAccount.service,
          origin: nebiusOrigin,
          status: "connected",
          profileRef: "profile-private-id",
        }),
      },
    });

    expect((await runtime.read(ACTOR, { ...INPUT, account: "https://nebius.com" })).ok).toBe(true);
    expect((await runtime.read(ACTOR, { ...INPUT, account: "Nebius" })).ok).toBe(true);
    expect(nebiusProvider.calls.create).toHaveLength(2);
  });

  test("requires clarification when a parent site matches multiple real accounts", async () => {
    const { runtime, providerCalls } = makeRuntime({
      accounts: {
        listForOwner: async () => [
          account({ origin: "https://app.example.test", label: "Personal Example" }),
          account({
            id: "00000000-0000-4000-8000-000000000002",
            origin: "https://console.example.test",
            label: "Work Example",
          }),
        ],
        getBindingForOwner: async () => { throw new Error("must not bind an ambiguous site"); },
      },
    });

    expect(await runtime.read(ACTOR, { ...INPUT, account: "https://example.test" })).toEqual({
      ok: false,
      code: "ambiguous_account",
      recovery: "none",
    });
    expect(providerCalls.create).toEqual([]);
  });

  test("ignores revoked history when selecting the one visible account", async () => {
    const { runtime, providerCalls } = makeRuntime({
      accounts: {
        listForOwner: async () => [
          account(),
          account({ id: "00000000-0000-4000-8000-000000000002", status: "revoked" }),
        ],
        getBindingForOwner: async () => ({
          accountId: ACCOUNT_ID,
          ownerUserId: OWNER_ID,
          service: "Example",
          origin: ORIGIN,
          status: "connected",
          profileRef: "profile-private-id",
        }),
      },
    });

    expect((await runtime.read(ACTOR, { ...INPUT, account: "Example" })).ok).toBe(true);
    expect(providerCalls.create).toHaveLength(1);
  });

  test("reserves before a Luna hosted run, binds the provider run, validates JSON, and exposes only safe fields", async () => {
    const { runtime, providerCalls, checkpoints, finishes, recordedCosts } = makeRuntime();
    const result = await runtime.read(ACTOR, INPUT);

    expect(providerCalls.create).toHaveLength(1);
    expect(providerCalls.create[0]!.profileId).toBe("profile-private-id");
    expect(providerCalls.create[0]!.maxCostUsd).toBe(0.25);
    expect(providerCalls.create[0]!.task).toContain(`Allowed origin: ${JSON.stringify(ORIGIN)}`);
    expect(providerCalls.create[0]!.task).toContain("Do not navigate to another origin");
    expect(providerCalls.create[0]!.task).toContain(JSON.stringify(INPUT.request));
    expect(checkpoints).toEqual([
      "reserve:reservation-private-token",
      "active:reservation-private-token:run-private-id",
    ]);
    expect(finishes).toEqual(["connected:reservation-private-token"]);
    expect(recordedCosts).toHaveLength(1);
    expect(recordedCosts[0]).toMatchObject({
      occurredAt: NOW,
      userId: FUNDING_HUMAN_ID,
      roomId: ROOM_ID,
      agentId: AGENT_ID,
      provider: "browser_use",
      operation: "hosted_read",
      actualCostUsd: "0.014",
      evidenceState: "actual",
    });
    expect(recordedCosts[0]!.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    expect(recordedCosts[0]!.idempotencyKey).not.toContain("run-private-id");
    expect(result).toEqual({
      ok: true,
      status: "completed",
      account: { id: ACCOUNT_ID, label: "My Example", service: "Example", origin: ORIGIN },
      page: { ref: ACCOUNT_ID, title: "My Example", origin: ORIGIN },
      read: {
        answer: "You have three pending items.",
        facts: [{ label: "Pending", value: "3" }],
        completeness: "complete",
        provenance: "authenticated_website",
        origin: ORIGIN,
      },
      cost: { currency: "USD", amountUsd: 0.014, state: "actual" },
      outputs: [],
      outputsTruncated: false,
    });
    expect(JSON.stringify(result)).not.toContain("profile-private-id");
    expect(JSON.stringify(result)).not.toContain("run-private-id");
    expect(JSON.stringify(result)).not.toContain("reservation-private-token");
  });

  test("records missing Browser Use cost as unknown without fabricating an amount", async () => {
    const { provider } = makeProvider({
      getHostedReadResult: async (runId) => ({
        runId,
        status: "completed",
        result: successJson(),
        totalCostUsd: null,
      }),
    });
    const { runtime, recordedCosts } = makeRuntime({ provider });

    expect(await runtime.read(ACTOR, INPUT)).toMatchObject({
      ok: true,
      cost: { currency: "USD", amountUsd: null, state: "unknown" },
    });
    expect(recordedCosts).toHaveLength(1);
    expect(recordedCosts[0]).toMatchObject({
      actualCostUsd: null,
      evidenceState: "unknown",
    });
  });

  test("keeps a completed read successful when cost persistence fails", async () => {
    const { runtime, finishes } = makeRuntime({
      recordProviderCost: async () => { throw new Error("database unavailable"); },
    });

    expect(await runtime.read(ACTOR, INPUT)).toMatchObject({
      ok: true,
      cost: { currency: "USD", amountUsd: 0.014, state: "actual" },
    });
    expect(finishes).toEqual(["connected:reservation-private-token"]);
  });

  test("normalizes Browser Use scalar and flat-list fact values without discarding a completed read", async () => {
    const { provider } = makeProvider({
      getHostedReadResult: async (runId) => ({
        runId,
        status: "completed",
        result: successJson({
          facts: [
            { label: "Months", value: ["June", "July", "August"] },
            { label: "Listings", value: 12 },
            { label: "Available", value: true },
          ],
        }),
        totalCostUsd: "0.014",
      }),
    });
    const { runtime } = makeRuntime({ provider });

    expect(await runtime.read(ACTOR, INPUT)).toMatchObject({
      ok: true,
      read: {
        facts: [
          { label: "Months", value: "June, July, August" },
          { label: "Listings", value: "12" },
          { label: "Available", value: "true" },
        ],
      },
    });
  });

  test("collects and imports hosted outputs only for an explicit workspace delivery before terminal release", async () => {
    const collected: unknown[] = [];
    const imported: unknown[] = [];
    let createdTask = "";
    const { provider } = makeProvider({
      createHostedReadRun: async (input) => {
        createdTask = input.task;
        return {
          runId: "run-private-id",
          sessionId: "session-private-id",
          workspaceId: "workspace-private-id",
          status: "queued",
        };
      },
      collectHostedReadOutputs: async (input) => {
        collected.push(input);
        return { outputs: [{ path: "connected-web/report.csv", mimeType: "text/csv", bytes: new Uint8Array([1, 2, 3]) }], truncated: false };
      },
    });
    const { runtime, finishes } = makeRuntime({
      provider,
      importOutput: async (input) => {
        imported.push(input);
        expect(finishes).toEqual([]);
        return { artifactId: "artifact-1", path: "connected-web/report.csv", mime: "text/csv", bytes: 3 };
      },
    });

    const result = await runtime.read(ACTOR, { ...INPUT, delivery: "workspace" });
    expect(collected).toEqual([{ sessionId: "session-private-id", workspaceId: "workspace-private-id", maxOutputs: 4 }]);
    expect(imported).toHaveLength(1);
    expect(createdTask).toContain("you MUST create the requested file");
    expect(createdTask).toContain("Do not merely claim that a file was saved");
    expect(result).toMatchObject({ ok: true, outputs: [{ artifactId: "artifact-1", path: "connected-web/report.csv", mime: "text/csv", bytes: 3 }] });
    expect(JSON.stringify(result)).not.toContain("session-private-id");
    expect(JSON.stringify(result)).not.toContain("workspace-private-id");
  });

  test("never collects provider outputs for the ordinary text delivery", async () => {
    let collectCalls = 0;
    const { provider } = makeProvider({
      createHostedReadRun: async () => ({ runId: "run-private-id", sessionId: "session-private-id", workspaceId: "workspace-private-id", status: "queued" }),
      collectHostedReadOutputs: async () => {
        collectCalls += 1;
        return { outputs: [], truncated: false };
      },
    });
    const { runtime } = makeRuntime({ provider });
    expect((await runtime.read(ACTOR, INPUT)).ok).toBe(true);
    expect(collectCalls).toBe(0);
  });

  test("marks a workspace delivery truncated when an output cannot be imported", async () => {
    const { provider } = makeProvider({
      createHostedReadRun: async () => ({ runId: "run-private-id", sessionId: "session-private-id", workspaceId: "workspace-private-id", status: "queued" }),
      collectHostedReadOutputs: async () => ({
        outputs: [{ path: "connected-web/report.csv", mimeType: "text/csv", bytes: new Uint8Array([1]) }],
        truncated: false,
      }),
    });
    const { runtime } = makeRuntime({ provider, importOutput: async () => null });
    expect(await runtime.read(ACTOR, { ...INPUT, delivery: "workspace" })).toMatchObject({
      ok: true,
      outputs: [],
      outputsTruncated: true,
    });
  });

  test("marks an explicit workspace delivery incomplete when no provider output is available", async () => {
    const { provider } = makeProvider({
      createHostedReadRun: async () => ({ runId: "run-private-id", sessionId: "session-private-id", workspaceId: "workspace-private-id", status: "queued" }),
      collectHostedReadOutputs: async () => ({ outputs: [], truncated: false }),
    });
    const { runtime } = makeRuntime({ provider });
    expect(await runtime.read(ACTOR, { ...INPUT, delivery: "workspace" })).toMatchObject({
      ok: true,
      outputs: [],
      outputsTruncated: true,
    });
  });

  test("does not start a provider run when the atomic checkpoint reservation is contended", async () => {
    const { runtime, providerCalls } = makeRuntime({
      executions: {
        reserveExecutionCheckpoint: async () => { throw new Error("conflict"); },
        activateExecutionCheckpoint: async () => undefined,
        completeExecution: async () => undefined,
        releaseExecutionReservation: async () => undefined,
      },
    });

    expect(await runtime.read(ACTOR, INPUT)).toEqual({ ok: false, code: "unavailable", recovery: "none" });
    expect(providerCalls.create).toEqual([]);
  });

  test("releases a confirmed pre-create rejection back to connected", async () => {
    const { provider } = makeProvider({
      createHostedReadRun: async () => ({ kind: "failure", code: "invalid_configuration" }),
    });
    const { runtime, finishes } = makeRuntime({ provider });
    expect(await runtime.read(ACTOR, INPUT)).toEqual({ ok: false, code: "provider_unavailable", recovery: "none" });
    expect(finishes).toEqual(["released:reservation-private-token:connected"]);
  });

  test.each(["provider_unavailable", "network_error", "cancelled"])("retains a synchronous admission fence after uncertain create: %s", async (code) => {
    const { provider } = makeProvider({
      createHostedReadRun: async () => ({ kind: "failure", code }),
    });
    const { runtime, finishes, checkpoints } = makeRuntime({ provider });
    expect((await runtime.read(ACTOR, { ...INPUT, delivery: "workspace" })).ok).toBe(false);
    expect(checkpoints).toEqual(["reserve:reservation-private-token"]);
    expect(finishes).toEqual([]);
  });

  test("retains a synchronous admission fence after a lost create response", async () => {
    const { provider } = makeProvider({
      createHostedReadRun: async () => { throw new Error("response lost after POST"); },
    });
    const { runtime, finishes, checkpoints } = makeRuntime({ provider });
    expect(await runtime.read(ACTOR, { ...INPUT, delivery: "workspace" })).toEqual({ ok: false, code: "provider_unavailable", recovery: "none" });
    expect(checkpoints).toEqual(["reserve:reservation-private-token"]);
    expect(finishes).toEqual([]);
  });

  test("matches a human label/service case-insensitively but still exactly", async () => {
    const { runtime } = makeRuntime();
    expect((await runtime.read(ACTOR, { ...INPUT, account: "  my example  " })).ok).toBe(true);
    expect((await runtime.read(ACTOR, { ...INPUT, account: "My Example extra" }))).toEqual({
      ok: false,
      code: "authentication_required",
      recovery: "connect",
      intervention: {
        kind: "authentication_required",
        mode: "connect",
        reason: "not_connected",
        target: { selector: "My Example extra" },
      },
    });
  });

  test("continues a hosted read beyond the former five-minute cutoff until the provider is terminal", async () => {
    let now = 0;
    let pollCount = 0;
    const { provider, calls } = makeProvider({
      pollHostedReadRun: async (runId) => {
        calls.poll.push(runId);
        pollCount += 1;
        return { runId, status: pollCount < 2 ? "running" : "completed" };
      },
    });
    const { runtime, finishes } = makeRuntime({
      provider,
      policy: { maxCostUsd: 0.25, pollIntervalMs: 1 },
      clock: { now: () => new Date(now) },
      sleep: async () => { now += 180_000; },
    });

    expect(await runtime.read(ACTOR, INPUT)).toMatchObject({ ok: true, status: "completed" });
    expect(now).toBe(360_000);
    expect(calls.cancel).toEqual([]);
    expect(finishes).toEqual(["connected:reservation-private-token"]);
  });

  test("retains the active checkpoint when poll-failure cancellation cannot be confirmed", async () => {
    const { provider } = makeProvider({
      pollHostedReadRun: async () => ({ kind: "failure", code: "provider_unavailable" }),
      cancelHostedReadRun: async () => ({ kind: "failure", code: "provider_unavailable" }),
    });
    const { runtime, finishes } = makeRuntime({
      provider,
      policy: { maxCostUsd: 0.25, pollIntervalMs: 1 },
    });

    expect(await runtime.read(ACTOR, INPUT)).toEqual({ ok: false, code: "provider_unavailable", recovery: "none" });
    expect(finishes).toEqual([]);
  });

  test("returns reconnect guidance for an expired profile and redacts malformed provider output", async () => {
    const expired = makeRuntime({
      accounts: {
        listForOwner: async () => [account({ status: "expired" })],
        getBindingForOwner: async () => ({ accountId: ACCOUNT_ID, ownerUserId: OWNER_ID, service: "Example", origin: ORIGIN, status: "expired", profileRef: "profile-private-id" }),
      },
    });
    expect(await expired.runtime.read(ACTOR, INPUT)).toEqual({
      ok: false,
      code: "authentication_required",
      recovery: "reconnect",
      intervention: {
        kind: "authentication_required",
        mode: "reconnect",
        reason: "reconnect",
        account: { id: ACCOUNT_ID, label: "My Example", service: "Example", origin: ORIGIN },
      },
    });

    const malformedProvider = makeProvider({
      getHostedReadResult: async (runId) => ({
        runId,
        status: "completed",
        result: '{"answer":"bad","privateProviderId":"do-not-leak"}',
        totalCostUsd: "0.014",
      }),
    });
    const malformed = makeRuntime({ provider: malformedProvider.provider });
    const result = await malformed.runtime.read(ACTOR, INPUT);
    expect(result).toEqual({
      ok: true,
      status: "completed",
      account: { id: ACCOUNT_ID, label: "My Example", service: "Example", origin: ORIGIN },
      page: { ref: ACCOUNT_ID, title: "My Example", origin: ORIGIN },
      read: null,
      cost: { currency: "USD", amountUsd: 0.014, state: "actual" },
      outputs: [],
      outputsTruncated: false,
    });
    expect(JSON.stringify(result)).not.toContain("privateProviderId");
    expect(JSON.stringify(result)).not.toContain("do-not-leak");
  });

  test("turns a hosted sign-in wall into a canonical Human intervention", async () => {
    const { provider } = makeProvider({
      getHostedReadResult: async (runId) => ({
        runId,
        status: "completed",
        result: JSON.stringify({ outcome: "authentication_required", reason: "mfa" }),
        totalCostUsd: "0.004",
      }),
    });
    const { runtime, finishes } = makeRuntime({ provider });

    expect(await runtime.read(ACTOR, INPUT)).toEqual({
      ok: false,
      code: "authentication_required",
      recovery: "reconnect",
      intervention: {
        kind: "authentication_required",
        mode: "reconnect",
        reason: "mfa",
        account: { id: ACCOUNT_ID, label: "My Example", service: "Example", origin: ORIGIN },
      },
    });
    expect(finishes).toEqual(["attention_needed:reservation-private-token"]);
  });
});
