import { describe, expect, test } from "bun:test";
import type { ConnectedWebAccount } from "@nautilo/types";
import type { ConnectedWebOperation } from "../../src/connected-web-accounts/store";
import { ConnectedWebOperationSecrets } from "../../src/connected-web-accounts/operation-secrets";
import {
  buildConnectedWebReadTask,
  createConnectedWebAccountReadAdmissionRuntime,
} from "../../src/connected-web-accounts/read-operation-admission-runtime";
import type { ConnectedWebAccountProviderResult, ConnectedWebAccountHostedReadRun } from "../../src/connected-web-accounts/read-tool-runtime";
import { usesAsyncConnectedWebReadAdmission } from "../../src/connected-web-accounts/read-tool-runtime-composition";
import { canReuseConnectedWebBrowser, connectedWebBrowserIdleUntil } from "../../src/connected-web-accounts/browser-idle";

const NOW = new Date("2026-09-03T20:00:00.000Z");
const OWNER = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";
const ROOM = "44444444-4444-4444-8444-444444444444";
const OPERATION_ID = "55555555-5555-4555-8555-555555555555";
const account: ConnectedWebAccount = {
  id: ACCOUNT_ID,
  service: "Nebius",
  origin: "https://console.nebius.com",
  label: "Nebius",
  status: "connected",
  lastVerifiedAt: null,
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
};

function admitted(): ConnectedWebOperation {
  return {
    id: OPERATION_ID, ownerUserId: OWNER, accountId: ACCOUNT_ID,
    initiatingAgentId: AGENT, initiatingRoomId: ROOM, initiatingThreadId: "thread-1", initiatingLane: "foreground:room",
    deliveryId: "tool-1", requestDigest: "a".repeat(64), sealedIntent: "cwo1.aaaaaaaaaaaaaaaa.VVVVVVVVVVVVVVVVVVVVVQ.cA",
    actionOperationId: null, effectIdempotencyKey: null, driver: "hosted", lifecycle: "admitted", controlEpoch: 1,
    controlLeaseToken: "66666666-6666-4666-8666-666666666666", controlLeaseExpiresAt: null,
    sealedProviderRefs: { version: 1 }, eventCursor: 0,
    safeActivity: { version: 1, phase: "starting", code: "provider_admitted", summary: "Connected website work is starting." },
    wakeFingerprint: null, nextCheckAt: null, supervisorClaimOwner: null, supervisorClaimExpiresAt: null,
    wakeClaimOwner: null, wakeClaimExpiresAt: null, wakeAttempts: 0, wakeDeliveredAt: null,
    cumulativeCostUsdMicros: 0, remainingBudgetUsdMicros: 2_000_000, terminalReceipt: null, terminalAt: null,
    createdAt: NOW, updatedAt: NOW,
  };
}

function actor(overrides: Record<string, unknown> = {}) {
  return {
    userId: OWNER, causalHumanUserId: OWNER, agentId: AGENT, roomId: ROOM, callingRoomId: null, memoryAccessEnvelope: {} as never,
    toolCallId: "tool-1", currentThreadId: "thread-1", turnId: "turn-1", laneKey: "foreground:room",
    ...overrides,
  };
}

function setup(input: {
  readonly create?: () => Promise<ConnectedWebAccountProviderResult<ConnectedWebAccountHostedReadRun>>;
  readonly admission?: "new" | "existing" | "conflict" | "busy";
  readonly existing?: ConnectedWebOperation;
  readonly activate?: boolean;
  readonly reuse?: boolean;
  readonly public?: boolean;
  readonly publicAuthorized?: boolean;
  readonly assertServerFunding?: (humanUserId: string, origin?: string) => Promise<void>;
} = {}) {
  const admissions: unknown[] = [];
  const activations: unknown[] = [];
  const failures: unknown[] = [];
  const creates: unknown[] = [];
  const secrets = new ConnectedWebOperationSecrets({ stableServerSecret: "a stable server-only secret long enough for this test" });
  let operation = input.existing ?? { ...admitted(), ...(input.public ? { accountId: null } : {}) };
  const runtime = createConnectedWebAccountReadAdmissionRuntime({
    facts: { canResearchPublic: async () => input.publicAuthorized ?? true, hasExactOwnedGenie: async () => !input.public, isOwnersPersonalPrivateRoom: async () => !input.public },
    validatePublicTarget: async (url) => ({ targetUrl: url, origin: new URL(url).origin }),
    accounts: {
      listForOwner: async () => { if (input.public) throw new Error("Public research touched private accounts"); return [account]; },
      getBindingForOwner: async () => ({ accountId: ACCOUNT_ID, ownerUserId: OWNER, service: "Nebius", origin: account.origin, status: "connected", profileRef: "profile-private" }),
    },
    store: {
      admitReadOperation: async (value) => {
        admissions.push(value);
        if (input.reuse) {
          const source = { ...admitted(), id: "77777777-7777-4777-8777-777777777777" };
          source.sealedProviderRefs = secrets.sealProviderReferences({
            context: { operationId: source.id, ownerUserId: OWNER, accountId: ACCOUNT_ID },
            coordinates: { runId: "old-run", sessionId: "warm-session", workspaceId: "warm-workspace" },
          });
          operation = { ...operation, sealedProviderRefs: value.rebindBrowserSession!(source) };
        }
        return input.admission === "conflict" ? { kind: "conflict" as const }
          : input.admission === "busy" ? { kind: "busy" as const }
            : input.admission === "existing" ? { kind: "existing" as const, operation }
              : { kind: "new" as const, operation };
      },
      activateReadOperation: async (value) => { activations.push(value); return input.activate ?? true; },
      failAdmittedReadOperation: async (value) => { failures.push(value); return true; },
    },
    provider: {
      health: () => ({ kind: "available" as const }),
      createHostedReadRun: async (value) => {
        creates.push(value);
        return input.create ? input.create() : { runId: "run-private", sessionId: value.sessionId ?? "session-private", workspaceId: value.workspaceId ?? "workspace-private", status: "queued" as const };
      },
      cancelHostedReadRun: async () => ({ runId: "run-private", status: "cancelled" as const }),
    },
    secrets: () => secrets,
    assertServerFunding: input.assertServerFunding ?? (async () => undefined),
    policy: { maxCostUsd: 2 },
    clock: { now: () => NOW },
    createReservationToken: () => "reservation-1",
    mintOperationId: () => OPERATION_ID,
  });
  return { runtime, admissions, activations, failures, creates, secrets };
}

describe("D568 async read admission", () => {
  const taskActor = (access: string = "allow") => actor({ memoryAccessEnvelope: {
    ownerId: OWNER, agentId: AGENT, roomId: ROOM, toolPolicy: { run_website_task: access },
  } });

  test.each([false, true])("admits a task with durable intent and no second approval; public=%s", async (publicSite) => {
    const fixture = setup({ public: publicSite });
    const request = "Create an Expedition Handbook book with a Welcome page.";
    const result = publicSite
      ? await fixture.runtime.readPublic!(taskActor(), { url: "https://example.com", request, intent: "task" })
      : await fixture.runtime.read(taskActor(), { account: "Nebius", request, intent: "task", delivery: "text" });
    expect(result).toMatchObject({ ok: true, status: "active" });
    expect(fixture.creates).toHaveLength(1);
    const created = fixture.creates[0] as { task: string; profileId?: string };
    expect(created.task).toContain("You may read and take actions");
    expect(created.task).toContain("Do not ask them to authorize the same task again");
    expect(created.task).toContain("genuinely dangerous, irreversible, ambiguous or outside");
    expect(created.task).toContain("Never blindly retry");
    expect(created.task).not.toContain("Read only the already-connected");
    expect(created.profileId).toBe(publicSite ? undefined : "profile-private");
    const admission = (fixture.admissions[0] as { admission: { sealedIntent: string } }).admission;
    const intent: unknown = JSON.parse(fixture.secrets.unsealIntent({ context: { operationId: OPERATION_ID, ownerUserId: OWNER, accountId: publicSite ? null : ACCOUNT_ID }, sealedIntent: admission.sealedIntent }));
    expect(intent).toMatchObject({ kind: "run_website_task", request, deliveryId: "tool-1", threadId: "thread-1" });
    expect(JSON.stringify(result)).not.toMatch(/profile-private|run-private|session-private|sealedIntent/);
  });

  test.each(["read_only", "forbidden", "require_prove_it"])("does not turn %s access into task authority", async (access) => {
    const fixture = setup();
    expect(await fixture.runtime.read(taskActor(access), { account: "Nebius", request: "Create a page", delivery: "text", intent: "task" }))
      .toMatchObject({ ok: false, code: "unavailable" });
    expect(fixture.admissions).toHaveLength(0);
    expect(fixture.creates).toHaveLength(0);
  });

  test("a task's duplicate delivery and uncertain creation never launch another worker", async () => {
    const existing = setup({ admission: "existing", existing: { ...admitted(), lifecycle: "running", sealedProviderRefs: { version: 1, runRef: "sealed-run" } } });
    await existing.runtime.read(taskActor(), { account: "Nebius", request: "Create a page", delivery: "text", intent: "task" });
    expect(existing.creates).toHaveLength(0);
    const uncertain = setup({ create: async () => { throw new Error("response lost"); } });
    expect(await uncertain.runtime.read(taskActor(), { account: "Nebius", request: "Create a page", delivery: "text", intent: "task" })).toMatchObject({ ok: false });
    expect(uncertain.creates).toHaveLength(1);
    expect(uncertain.failures).toHaveLength(0);
  });
  test("rebinds warm session custody to the new operation and sends the same V4 session on the next turn", async () => {
    const fixture = setup({ reuse: true });
    const result = await fixture.runtime.read(actor(), { account: "Nebius", request: "Now inspect current usage", delivery: "text" });
    expect(result).toMatchObject({ ok: true, status: "active" });
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.creates[0]).toMatchObject({ sessionId: "warm-session", workspaceId: "warm-workspace", profileId: "profile-private" });
    expect(JSON.stringify(result)).not.toMatch(/warm-session|warm-workspace|old-run|profile-private/);
  });

  test("warm reuse is exact-conversation and expires only between terminal runs", () => {
    const target = { ...admitted(), id: OPERATION_ID };
    const source: ConnectedWebOperation = { ...admitted(), lifecycle: "terminal", terminalAt: NOW,
      terminalReceipt: { version: 1, outcome: "completed", code: "done", summary: "Done." },
      browserIdleUntil: connectedWebBrowserIdleUntil(NOW, true), browserCleanupStartedAt: null };
    expect(canReuseConnectedWebBrowser(source, target, new Date(NOW.getTime() + 299_999))).toBe(true);
    expect(canReuseConnectedWebBrowser(source, target, new Date(NOW.getTime() + 300_000))).toBe(false);
    for (const field of ["ownerUserId", "accountId", "initiatingAgentId", "initiatingRoomId", "initiatingThreadId", "initiatingLane"] as const) {
      expect(canReuseConnectedWebBrowser(source, { ...target, [field]: "different" }, NOW)).toBe(false);
    }
    expect(canReuseConnectedWebBrowser({ ...source, lifecycle: "running" }, target, NOW)).toBe(false);
    expect(canReuseConnectedWebBrowser({ ...source, driver: "direct" }, target, NOW)).toBe(false);
    expect(canReuseConnectedWebBrowser({ ...source, browserCleanupStartedAt: NOW }, target, NOW)).toBe(false);
    expect(canReuseConnectedWebBrowser({ ...source, browserIdleUntil: null }, target, NOW)).toBe(false);
    expect(connectedWebBrowserIdleUntil(NOW, false)).toEqual(NOW);
  });

  test("returns immediately with a provider-neutral active receipt after sealed durable activation", async () => {
    const fixture = setup();
    const result = await fixture.runtime.read(actor(), { account: "Nebius", request: "List my projects", delivery: "text" });
    expect(result).toMatchObject({ ok: true, status: "active", operation: { operationId: OPERATION_ID, driver: "hosted", lifecycle: "running", controlEpoch: 1, receipt: null } });
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.activations).toHaveLength(1);
    expect(JSON.stringify(fixture.admissions)).not.toContain("List my projects");
    expect((fixture.activations[0] as { sealedProviderRefs: { runRef: string } }).sealedProviderRefs.runRef).toStartWith("cwo1.");
  });

  test("checks current Human server funding before durable admission or provider creation", async () => {
    const checks: unknown[] = [];
    const fixture = setup({
      assertServerFunding: async (...input) => {
        checks.push(input);
        throw new Error("server_provider_credentials_required");
      },
    });
    expect(await fixture.runtime.read(actor(), {
      account: "Nebius", request: "List my projects", delivery: "text",
    })).toEqual({ ok: false, code: "unavailable", recovery: "none" });
    expect(checks).toEqual([[OWNER, "connected_web_read"]]);
    expect(fixture.admissions).toHaveLength(0);
    expect(fixture.creates).toHaveLength(0);
  });

  test("returns the same existing active operation for an exact delivery without a second provider run", async () => {
    const existing = { ...admitted(), lifecycle: "running" as const, sealedProviderRefs: { version: 1 as const, runRef: "cwo1.aaaaaaaaaaaaaaaa.VVVVVVVVVVVVVVVVVVVVVQ.cA" } };
    const fixture = setup({ admission: "existing", existing });
    const result = await fixture.runtime.read(actor(), { account: "Nebius", request: "List my projects", delivery: "text" });
    expect(result).toMatchObject({ ok: true, status: "active", operation: { operationId: OPERATION_ID } });
    expect(fixture.creates).toEqual([]);
    expect(fixture.activations).toEqual([]);
  });

  test("refuses mismatched replay and never starts a provider run", async () => {
    const fixture = setup({ admission: "conflict" });
    expect(await fixture.runtime.read(actor(), { account: "Nebius", request: "Different request", delivery: "text" }))
      .toEqual({ ok: false, code: "idempotency_conflict", recovery: "none" });
    expect(fixture.creates).toEqual([]);
  });

  test("confirmed provider-create failure atomically fails the admission and releases its reservation", async () => {
    const fixture = setup({ create: async () => ({ kind: "failure", code: "invalid_cost_policy" }) });
    expect(await fixture.runtime.read(actor(), { account: "Nebius", request: "List projects", delivery: "text" }))
      .toEqual({ ok: false, code: "provider_unavailable", recovery: "none" });
    expect(fixture.failures).toHaveLength(1);
    expect(fixture.failures[0]).toMatchObject({ operationId: OPERATION_ID, reservationToken: "reservation-1", receipt: { outcome: "failed", code: "provider_create_rejected" } });
  });

  test("ambiguous provider failure envelopes preserve the admission fence", async () => {
    const fixture = setup({ create: async () => ({ kind: "failure", code: "provider_unavailable" }) });
    expect(await fixture.runtime.read(actor(), { account: "Nebius", request: "List projects", delivery: "text" }))
      .toEqual({ ok: false, code: "provider_unavailable", recovery: "none" });
    expect(fixture.failures).toEqual([]);
  });

  test("activation failure releases the admission only after terminal cancellation proof", async () => {
    const fixture = setup({ activate: false });
    expect(await fixture.runtime.read(actor(), { account: "Nebius", request: "List projects", delivery: "text" }))
      .toEqual({ ok: false, code: "provider_unavailable", recovery: "none" });
    expect(fixture.failures).toHaveLength(1);
    expect(fixture.failures[0]).toMatchObject({
      operationId: OPERATION_ID,
      receipt: { code: "provider_activation_failed", outcome: "cancelled" },
    });
    const failure = fixture.failures[0] as { sealedProviderRefs: ConnectedWebOperation["sealedProviderRefs"] };
    expect(fixture.secrets.unsealProviderReferences({
      context: { operationId: OPERATION_ID, ownerUserId: OWNER, accountId: ACCOUNT_ID },
      references: failure.sealedProviderRefs,
    })).toEqual({ runId: "run-private", sessionId: "session-private", workspaceId: "workspace-private" });
  });

  test("transport-uncertain create preserves the admission fence and cannot trigger a second paid run", async () => {
    const first = setup({ create: async () => { throw new Error("lost response"); } });
    expect(await first.runtime.read(actor(), { account: "Nebius", request: "List projects", delivery: "text" }))
      .toEqual({ ok: false, code: "provider_unavailable", recovery: "none" });
    expect(first.failures).toEqual([]);
    expect(first.creates).toHaveLength(1);

    const replay = setup({ admission: "existing" });
    expect(await replay.runtime.read(actor(), { account: "Nebius", request: "List projects", delivery: "text" }))
      .toEqual({ ok: false, code: "provider_unavailable", recovery: "none" });
    expect(replay.creates).toEqual([]);
  });

  test("requires the exact trusted delivery, thread, turn, and lane before admission", async () => {
    const fixture = setup();
    expect(await fixture.runtime.read(actor({ laneKey: "" }), { account: "Nebius", request: "List projects", delivery: "text" }))
      .toEqual({ ok: false, code: "unavailable", recovery: "none" });
    expect(fixture.admissions).toEqual([]);
  });

  test("keeps the legacy strict result/auth/workspace contract in the hosted task", () => {
    const task = buildConnectedWebReadTask({
      origin: account.origin,
      request: { account: "Nebius", request: "Save a report", delivery: "workspace" },
    });
    expect(task).toContain("Return exactly one JSON object and no markdown with keys answer, facts, completeness, provenance, origin.");
    expect(task).toContain("{\"outcome\":\"authentication_required\",\"reason\":\"sign_in\"}");
    expect(task).toContain("one-time code/passkey/approval");
    expect(task).toContain("create the requested file, image, or capture in this run's workspace");
  });

  test("keeps workspace delivery on the established synchronous custody runtime", () => {
    expect(usesAsyncConnectedWebReadAdmission("text")).toBe(true);
    expect(usesAsyncConnectedWebReadAdmission("workspace")).toBe(false);
  });
});

test("admission seals the trusted initiating voice preference without exposing it to the provider or public receipt", async () => {
  for (const voiceMode of [true, false]) {
    const fixture = setup();
    const result = await fixture.runtime.read(actor({ voiceMode }), { account: "Nebius", request: "List projects", delivery: "text" });
    const saved = fixture.admissions[0] as { admission: { sealedIntent: string } };
    const intent = JSON.parse(fixture.secrets.unsealIntent({
      context: { operationId: OPERATION_ID, ownerUserId: OWNER, accountId: ACCOUNT_ID }, sealedIntent: saved.admission.sealedIntent,
    })) as Record<string, unknown>;
    expect(intent["voiceMode"]).toBe(voiceMode);
    expect(JSON.stringify(result)).not.toContain("voiceMode");
    expect(JSON.stringify(fixture.creates)).not.toContain("voiceMode");
  }
});

describe("D585 anonymous Browser Use admission", () => {
  test("starts with zero accounts and no owned-private-room requirement or profile", async () => {
    const fixture = setup({ public: true });
    const result = await fixture.runtime.readPublic!(actor(), { url: "https://example.com/search?q=energy", request: "Filter by year and summarize the first page" });
    expect(result).toMatchObject({ ok: true, status: "active", target: { origin: "https://example.com" } });
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.creates[0]).not.toHaveProperty("profileId");
    expect(fixture.admissions[0]).toMatchObject({ admission: { accountId: null } });
    expect(JSON.stringify(result)).not.toMatch(/profile-private|run-private|session-private|workspace-private/);
    const admission = (fixture.admissions[0] as { admission: { sealedIntent: string } }).admission;
    const intent = JSON.parse(fixture.secrets.unsealIntent({ context: { operationId: OPERATION_ID, ownerUserId: OWNER, accountId: null }, sealedIntent: admission.sealedIntent })) as Record<string, unknown>;
    expect(intent).toMatchObject({ kind: "browse_web", targetUrl: "https://example.com/search?q=energy", voiceMode: false });
  });
  test("public authority denial creates no provider work", async () => {
    const fixture = setup({ public: true, publicAuthorized: false });
    expect(await fixture.runtime.readPublic!(actor(), { url: "https://example.com", request: "Read" })).toMatchObject({ ok: false, code: "unavailable" });
    expect(fixture.creates).toHaveLength(0);
  });
  test("an uncertain accepted start is never duplicated by delivery replay", async () => {
    const fixture = setup({ public: true, admission: "existing" });
    const result = await fixture.runtime.readPublic!(actor(), { url: "https://example.com", request: "Read" });
    expect(result).toMatchObject({ ok: false, code: "provider_unavailable" });
    expect(fixture.creates).toHaveLength(0);
  });
  test("private account read still requires its original authority", async () => {
    const fixture = setup({ public: true });
    expect(await fixture.runtime.read(actor(), { account: "https://example.com", request: "Read", delivery: "text" })).toMatchObject({ ok: false, code: "unavailable" });
    expect(fixture.creates).toHaveLength(0);
  });
});
