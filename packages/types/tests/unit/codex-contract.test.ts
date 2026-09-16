import { expect, test } from "bun:test";
import {
  codexBindingSchema,
  codexRequestEventSchema,
  codexRoomRequestListSchema,
  codexUserInputRequestEventSchema,
  codexUserInputRequestSchema,
  codexUserPreferenceMutationSchema,
  codexUserPreferenceSchema,
  codexProfileSchema,
  codexProfileConnectSchema,
  codexRuntimeSummarySchema,
  codexRequestResponseSchema,
  codexRequestSchema,
  codexPermissionSelectionRequestSchema,
  codexPermissionSelectionResponseSchema,
  codexUsageSchema,
} from "../../src/codex";

test("Codex public DTOs reject authority and host fields", () => {
  expect(codexProfileConnectSchema.safeParse({
    loginRef: "login-ref",
    profile: {
      id: crypto.randomUUID(),
      label: "Codex account",
      accountEmail: null,
      authState: "login_pending",
      registrationState: "provisional",
      reconciliationState: "current",
      planType: null,
      rateLimits: null,
      usage: null,
      usageObservedAt: null,
      lastErrorCode: null,
      revision: 0,
    },
  }).success).toBe(true);
  expect(
    codexUserPreferenceMutationSchema.safeParse({
      profileId: null,
      enabled: false,
      posture: "codex_default",
      expectedRevision: 0,
      relayId: "forbidden",
    }).success,
  ).toBe(false);

  const forbidden = [
    "homeHandle",
    "relayId",
    "relaySessionId",
    "desktopSessionId",
    "pairingGenerationRef",
    "workspaceRef",
    "workspaceFingerprint",
    "codexThreadId",
    "profileGeneration",
    "accountGeneration",
    "runtimeGeneration",
    "childGeneration",
    "capabilityManifestHash",
    "lastTurnId",
    "lastItemCursor",
  ];
  for (const field of forbidden) {
    expect(codexProfileSchema.keyof().options).not.toContain(field);
    expect(codexBindingSchema.keyof().options).not.toContain(field);
  }
});

test("Codex safe DTO invariants reject ambiguous or unbounded state", () => {
  expect(
    codexUserPreferenceMutationSchema.safeParse({
      enabled: true,
      profileId: null,
      posture: "codex_default",
      expectedRevision: 0,
    }).success,
  ).toBe(false);
  expect(
    codexUserPreferenceSchema.safeParse({
      enabled: false,
      profileId: null,
      posture: "codex_default",
      revision: 0,
      agentId: crypto.randomUUID(),
    }).success,
  ).toBe(false);
  expect(
    codexBindingSchema.safeParse({
      id: crypto.randomUUID(),
      taskId: crypto.randomUUID(),
      roomId: crypto.randomUUID(),
      laneKey: "room:test",
      bindingKind: "task",
      state: "archived",
      selectedModel: null,
      posture: "codex_default",
      revision: 1,
      archivedAt: null,
    }).success,
  ).toBe(false);
  expect(
    codexRuntimeSummarySchema.safeParse({
      state: "limited",
      available: true,
      runtimeGeneration: null,
      collaborationModeAvailable: false,
    }).success,
  ).toBe(true);

  const usage = {
    summary: {
      lifetimeTokens: "1",
      peakDailyTokens: null,
      longestRunningTurnSec: null,
      currentStreakDays: null,
      longestStreakDays: null,
    },
    daily: [{ startDate: "2026-07-27", tokens: "1" }],
    observedAt: "2026-07-27T10:00:00.000Z",
    freshness: "live",
  };
  expect(codexUsageSchema.safeParse(usage).success).toBe(true);
  expect(
    codexUsageSchema.safeParse({
      ...usage,
      summary: { ...usage.summary, lifetimeTokens: "9".repeat(33) },
    }).success,
  ).toBe(false);
  expect(
    codexUsageSchema.safeParse({
      ...usage,
      daily: [{ startDate: "2026-07-27", tokens: "" }],
    }).success,
  ).toBe(false);
});

test("Codex native request DTOs remain semantic, strict, and relay-bounded", () => {
  const request = {
    kind: "user_input_required",
    questions: [{
      id: "q1",
      header: "Pick",
      prompt: "Which option?",
      secret: false,
      allowOther: false,
      options: [{ id: "option:0", label: "One", description: null }],
    }],
    autoResolutionMs: 0,
  };
  expect(codexRequestSchema.safeParse(request).success).toBe(true);
  expect(codexRequestSchema.safeParse({ ...request, questions: [] }).success).toBe(true);
  expect(codexRequestSchema.safeParse({
    ...request,
    questions: [{ ...request.questions[0], options: [] }],
  }).success).toBe(true);
  expect(codexRequestSchema.safeParse({ ...request, command: "rm -rf /" }).success).toBe(false);
  expect(codexRequestSchema.safeParse({
    ...request,
    questions: Array.from({ length: 5 }, () => request.questions[0]),
  }).success).toBe(false);
  expect(codexRequestSchema.safeParse({
    ...request,
    questions: [{ ...request.questions[0], header: "x".repeat(129) }],
  }).success).toBe(false);
  expect(codexRequestSchema.safeParse({
    ...request,
    questions: [{ ...request.questions[0], options: Array.from({ length: 5 }, () => ({ id: "a", label: "A", description: null })) }],
  }).success).toBe(false);
  expect(codexRequestResponseSchema.safeParse({
    kind: "user_input_required",
    answers: { q1: ["option:0"] },
  }).success).toBe(true);
  expect(codexRequestResponseSchema.safeParse({
    kind: "user_input_required",
    answers: { q1: ["option:0"] },
    ownerId: "browser-must-not-set-this",
  }).success).toBe(false);
  expect(codexRequestResponseSchema.safeParse({
    kind: "user_input_required",
    answers: { q1: ["a", "b", "c", "d", "e", "f"] },
  }).success).toBe(false);
  expect(codexRequestSchema.safeParse({
    ...request,
    questions: Array.from({ length: 4 }, () => ({ ...request.questions[0], options: Array.from({ length: 4 }, () => ({ id: "a", label: "A", description: null })), multiSelect: true })),
  }).success).toBe(true);
  expect(codexRequestResponseSchema.safeParse({
    kind: "user_input_required",
    answers: { q1: ["a", "b", "c", "d", "Other"], q2: ["a"], q3: ["a"], q4: ["a"] },
  }).success).toBe(true);
  const permissionRequest = {
    kind: "permission_selection_required",
    options: [{ id: "allow_once", label: "Allow once", semanticHint: null }, { id: "deny", label: "Deny", semanticHint: null }],
    tool: { title: "Read", kind: null },
  } as const;
  expect(codexPermissionSelectionRequestSchema.safeParse(permissionRequest).success).toBe(true);
  expect(codexRequestSchema.safeParse(permissionRequest).success).toBe(true);
  expect(codexPermissionSelectionResponseSchema.safeParse({
    kind: "permission_selection_required", outcome: { kind: "selected", optionId: "allow_once" },
  }).success).toBe(true);
  expect(codexPermissionSelectionResponseSchema.safeParse({
    kind: "permission_selection_required", outcome: { kind: "selected", optionId: "allow_once", extra: true },
  }).success).toBe(false);
  expect(codexRequestEventSchema.safeParse({
    type: "codex.request",
    ownerId: "owner",
    requestId: "request",
    taskId: "task",
    jobId: "job",
    roomId: "room",
    expiresAt: null,
    request: { kind: "file_change_approval_required", options: ["deny"], reason: "host_local_only", grantRoot: "host_local_only" },
    vendorRequestId: "must-not-cross",
  }).success).toBe(false);
});

test("Codex Room input recovery wire is user-input-only, bounded, and authority-free", () => {
  const input = {
    kind: "user_input_required",
    questions: [{
      id: "q1", header: "Pick", prompt: "Which option?", secret: false,
      allowOther: false, options: null,
    }],
    autoResolutionMs: null,
  } as const;
  const event = {
    type: "codex.request",
    ownerId: "owner",
    requestId: "request",
    taskId: "task",
    jobId: "job",
    roomId: "room",
    expiresAt: "2026-08-01T12:00:00.000Z",
    request: input,
  } as const;
  expect(codexUserInputRequestSchema.safeParse(input).success).toBe(true);
  expect(codexUserInputRequestEventSchema.safeParse(event).success).toBe(true);
  expect(codexUserInputRequestEventSchema.safeParse({
    ...event,
    request: { kind: "command_approval_required", options: ["deny"], reason: "host_local_only", command: { detail: "host_local_only", actionKinds: [] } },
  }).success).toBe(false);
  expect(codexUserInputRequestEventSchema.safeParse({ ...event, expiresAt: null }).success).toBe(false);
  expect(codexUserInputRequestEventSchema.safeParse({ ...event, bindingGeneration: 1 }).success).toBe(false);
  expect(codexRoomRequestListSchema.safeParse({
    roomId: "room",
    items: Array.from({ length: 16 }, () => ({ availability: "actionable", event })),
  }).success).toBe(true);
  expect(codexRoomRequestListSchema.safeParse({
    roomId: "room",
    items: Array.from({ length: 17 }, () => ({ availability: "actionable", event })),
  }).success).toBe(false);
});
