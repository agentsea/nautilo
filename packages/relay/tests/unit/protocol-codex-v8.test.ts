import { describe, expect, test } from "bun:test";
import {
  CODEX_RELAY_MAX_FRAME_BYTES,
  CODEX_RELAY_PROTOCOL_VERSION,
  RELAY_PROTOCOL_VERSION,
  parseRelayCodexJsonFrame,
  parseRelayCodexClientMessage,
  parseRelayCodexServerMessage,
  classifyRelayTopLevelType,
  isRelayCodexCommandResponseForCommand,
} from "../../src/index";

const HOST_SCOPE = {
  relayId: "relay-1",
  relaySessionId: "session-1",
  desktopSessionId: "desktop-1",
  pairingGenerationRef: "pair-ref-1",
  selectedProtocolVersion: RELAY_PROTOCOL_VERSION,
  capabilityRevision: 2,
} as const;

describe("D453 relay Codex v8 protocol", () => {
  test("keeps the v8 Codex family available on the current relay protocol", () => {
    expect(CODEX_RELAY_PROTOCOL_VERSION).toBe(8);
    expect(RELAY_PROTOCOL_VERSION).toBeGreaterThanOrEqual(CODEX_RELAY_PROTOCOL_VERSION);
  });

  test("accepts an exact dedicated command and rejects scope/key smuggling", () => {
    const frame = {
      type: "relay:codex-command",
      commandId: "command-1",
      scope: HOST_SCOPE,
      command: { kind: "runtime_inspect" },
    };
    expect(parseRelayCodexServerMessage(frame).ok).toBe(true);
    expect(parseRelayCodexServerMessage({ ...frame, userId: "spoofed" }).ok).toBe(false);
    expect(parseRelayCodexServerMessage({
      ...frame,
      command: { kind: "runtime_inspect", sandboxProfile: {} },
    }).ok).toBe(false);
  });

  test("projects a home handle only for created profiles at its exact UTF-8 bound", () => {
    const created = {
      type: "relay:codex-command-response",
      commandId: "create",
      scope: HOST_SCOPE,
      result: {
        kind: "profile_status",
        state: "created",
        profileHandle: "profile",
        profileGeneration: 1,
        homeHandle: "h".repeat(512),
      },
    } as const;
    expect(parseRelayCodexClientMessage(created).ok).toBe(true);
    expect(parseRelayCodexClientMessage({
      ...created,
      result: { ...created.result, homeHandle: "h".repeat(513) },
    }).ok).toBe(false);
    expect(parseRelayCodexClientMessage({
      ...created,
      scope: { ...HOST_SCOPE, profileHandle: "profile", profileGeneration: 1, accountGeneration: 2, runtimeGeneration: 3 },
      result: {
        kind: "profile_status",
        state: "removed",
        profileHandle: "profile",
        profileGeneration: 1,
      },
    }).ok).toBe(true);
    expect(parseRelayCodexServerMessage({
      type: "relay:codex-command", commandId: "remove", scope: { ...HOST_SCOPE, profileHandle: "profile", profileGeneration: 1, accountGeneration: 2, runtimeGeneration: 3 },
      command: { kind: "profile_remove", profileHandle: "profile", profileGeneration: 1 },
    }).ok).toBe(true);
    expect(parseRelayCodexServerMessage({
      type: "relay:codex-command", commandId: "remove-host", scope: HOST_SCOPE,
      command: { kind: "profile_remove", profileHandle: "profile", profileGeneration: 1 },
    }).ok).toBe(false);
    expect(parseRelayCodexClientMessage({
      ...created,
      result: { ...created.result, state: "removed" },
    }).ok).toBe(false);
    const withoutHandle = { ...created.result } as Record<string, unknown>;
    delete withoutHandle["homeHandle"];
    expect(parseRelayCodexClientMessage({ ...created, result: withoutHandle }).ok).toBe(false);
  });

  test("projects child generation only truthfully for live profile states", () => {
    const status = {
      type: "relay:codex-status",
      socket: {
        relayId: HOST_SCOPE.relayId,
        relaySessionId: HOST_SCOPE.relaySessionId,
        desktopSessionId: HOST_SCOPE.desktopSessionId,
        pairingGenerationRef: HOST_SCOPE.pairingGenerationRef,
        selectedProtocolVersion: 8,
      },
      capabilityRevision: HOST_SCOPE.capabilityRevision,
      status: {
        state: "ready",
        profiles: [{
          profileHandle: "profile",
          profileGeneration: 1,
          accountGeneration: 2,
          state: "busy",
          childGeneration: 3,
        }],
        workspace: { state: "unavailable" },
      },
    } as const;
    expect(parseRelayCodexClientMessage(status).ok).toBe(true);
    const beforeFirstLifecycle = {
      ...status,
      status: {
        ...status.status,
        runtime: { state: "installing" as const, source: "managed" as const, installRef: "relay-private-install" },
      },
    };
    expect(parseRelayCodexClientMessage(beforeFirstLifecycle).ok).toBe(true);
    expect(parseRelayCodexClientMessage({
      ...status,
      status: {
        ...status.status,
        profiles: [{ ...status.status.profiles[0], childGeneration: -1 }],
      },
    }).ok).toBe(false);
    expect(parseRelayCodexClientMessage({
      ...status,
      status: {
        ...status.status,
        profiles: [{ ...status.status.profiles[0], childGeneration: 0 }],
      },
    }).ok).toBe(false);
    expect(parseRelayCodexClientMessage({
      ...status,
      status: {
        ...status.status,
        profiles: [{
          profileHandle: "profile",
          profileGeneration: 1,
          accountGeneration: 2,
          state: "signed_out",
        }],
      },
    }).ok).toBe(true);
    expect(parseRelayCodexClientMessage({
      ...status,
      status: {
        ...status.status,
        profiles: [{
          profileHandle: "profile",
          profileGeneration: 1,
          accountGeneration: 2,
          state: "busy",
        }],
      },
    }).ok).toBe(false);
    expect(parseRelayCodexClientMessage({
      ...status,
      status: {
        ...status.status,
        profiles: [{ ...status.status.profiles[0], unexpected: true }],
      },
    }).ok).toBe(false);
  });

  test("accepts only relationally coherent bounded managed-install runtime status", () => {
    const status = {
      type: "relay:codex-status",
      socket: {
        relayId: HOST_SCOPE.relayId,
        relaySessionId: HOST_SCOPE.relaySessionId,
        desktopSessionId: HOST_SCOPE.desktopSessionId,
        pairingGenerationRef: HOST_SCOPE.pairingGenerationRef,
        selectedProtocolVersion: 8,
      },
      capabilityRevision: HOST_SCOPE.capabilityRevision,
      status: {
        state: "runtime_unavailable",
        runtime: {
          state: "installing",
          source: "managed",
          installRef: "relay-private-install",
          installation: {
            phase: "downloading",
            receivedBytes: 64 * 1024,
            totalBytes: 128 * 1024,
            canCancel: true,
          },
        },
        workspace: { state: "unavailable" },
      },
    } as const;
    expect(parseRelayCodexClientMessage(status).ok).toBe(true);
    expect(parseRelayCodexClientMessage({
      ...status,
      status: { ...status.status, runtime: { ...status.status.runtime, source: "external" } },
    }).ok).toBe(false);
    expect(parseRelayCodexClientMessage({
      ...status,
      status: { ...status.status, runtime: { ...status.status.runtime, installation: { ...status.status.runtime.installation, canCancel: false } } },
    }).ok).toBe(false);
    expect(parseRelayCodexClientMessage({
      ...status,
      status: { ...status.status, runtime: { ...status.status.runtime, progressPercent: 50 } },
    }).ok).toBe(false);
    const incompatible = {
      ...status,
      status: {
        ...status.status,
        state: "runtime_incompatible" as const,
        runtime: {
          state: "incompatible" as const,
          source: "external" as const,
          compatibilityDiagnostics: [{
            feature: "core" as const,
            reason: "changed_field_shape" as const,
          }],
        },
      },
    };
    expect(parseRelayCodexClientMessage(incompatible).ok).toBe(true);
    expect(parseRelayCodexClientMessage({
      ...incompatible,
      status: {
        ...incompatible.status,
        runtime: {
          ...incompatible.status.runtime,
          compatibilityDiagnostics: [{
            feature: "core",
            reason: "changed_field_shape",
            target: "/private/schema/path",
          }],
        },
      },
    }).ok).toBe(false);
    expect(parseRelayCodexClientMessage({
      ...status,
      status: {
        ...status.status,
        runtime: {
          state: "failed",
          source: "managed",
          installation: { phase: "failed", receivedBytes: 0, totalBytes: 128 * 1024, canCancel: false, code: "CODEX_RUNTIME_ARTIFACT_INVALID" },
        },
      },
    }).ok).toBe(true);
    expect(parseRelayCodexClientMessage({
      ...status,
      status: {
        ...status.status,
        runtime: {
          state: "failed",
          source: "managed",
          installation: { phase: "failed", receivedBytes: 0, totalBytes: 128 * 1024, canCancel: false, code: "file:///private/error" },
        },
      },
    }).ok).toBe(false);
  });

  test("carries only a bounded exact-profile model catalog and correlates model_list", () => {
    const scope = {
      ...HOST_SCOPE,
      profileHandle: "profile",
      profileGeneration: 1,
      accountGeneration: 2,
      runtimeGeneration: 3,
      childGeneration: 4,
    } as const;
    const command = {
      type: "relay:codex-command",
      commandId: "models",
      scope,
      command: { kind: "model_list" },
    } as const;
    const response = {
      type: "relay:codex-command-response",
      commandId: "models",
      scope,
      result: {
        kind: "model_catalog_status",
        value: { models: [{
          id: "gpt-5.6-sol",
          model: "gpt-5.6-sol",
          displayName: "GPT-5.6 Sol",
          description: "Frontier coding model",
          isDefault: true,
        }] },
      },
    } as const;
    expect(parseRelayCodexServerMessage(command).ok).toBe(true);
    expect(parseRelayCodexClientMessage(response).ok).toBe(true);
    expect(isRelayCodexCommandResponseForCommand(command, response)).toBe(true);
    expect(parseRelayCodexClientMessage({
      ...response,
      result: {
        ...response.result,
        value: { models: [{ ...response.result.value.models[0], hidden: false }] },
      },
    }).ok).toBe(false);
  });

  test("carries only bounded Codex account display identity", () => {
    const scope = {
      ...HOST_SCOPE,
      profileHandle: "profile",
      profileGeneration: 1,
      accountGeneration: 2,
      runtimeGeneration: 3,
      childGeneration: 4,
    } as const;
    const command = {
      type: "relay:codex-command",
      commandId: "account",
      scope,
      command: { kind: "account_read" },
    } as const;
    const response = {
      type: "relay:codex-command-response",
      commandId: "account",
      scope,
      result: {
        kind: "account_status",
        state: "signed_in",
        accountGeneration: 2,
        accountEmail: "owner@example.test",
        planType: "pro",
      },
    } as const;
    expect(parseRelayCodexServerMessage(command).ok).toBe(true);
    expect(parseRelayCodexClientMessage(response).ok).toBe(true);
    expect(isRelayCodexCommandResponseForCommand(command, response)).toBe(true);
    expect(parseRelayCodexClientMessage({
      ...response,
      result: { ...response.result, accountEmail: "x".repeat(321) },
    }).ok).toBe(false);
    expect(parseRelayCodexClientMessage({
      ...response,
      result: { ...response.result, accountEmail: "owner@example.test\nprivate" },
    }).ok).toBe(false);
    expect(parseRelayCodexClientMessage({
      ...response,
      result: { ...response.result, planType: "raw-upstream-plan" },
    }).ok).toBe(false);
  });

  test("enforces the pre-parse v8 ceiling and rejects duplicate JSON keys", () => {
    const oversized = JSON.stringify({
      type: "relay:codex-command",
      payload: "x".repeat(CODEX_RELAY_MAX_FRAME_BYTES),
    });
    expect(parseRelayCodexJsonFrame(oversized, "server")).toEqual({
      ok: false,
      error: "CODEX_FRAME_TOO_LARGE",
    });

    const duplicate = `{"type":"relay:codex-command","type":"relay:codex-cancel"}`;
    expect(parseRelayCodexJsonFrame(duplicate, "server")).toEqual({
      ok: false,
      error: "CODEX_FRAME_INVALID",
    });
    const decodedDuplicate = `{"t\\u0079pe":"relay:codex-command","type":"relay:codex-command"}`;
    expect(parseRelayCodexJsonFrame(decodedDuplicate, "server")).toEqual({
      ok: false,
      error: "CODEX_FRAME_INVALID",
    });
  });

  test("enforces the scanner node N/N+1 boundary", () => {
    const atLimit = `{"padding":[${"0,".repeat(9_996)}0],"type":"relay:codex-command"}`;
    const overLimit = `{"padding":[${"0,".repeat(9_997)}0],"type":"relay:codex-command"}`;
    expect(classifyRelayTopLevelType(atLimit)).toBe("relay:codex-command");
    expect(classifyRelayTopLevelType(overLimit)).toBeNull();
  });

  test("classifies event frames strictly and rejects event/scope Cartesian smuggling", () => {
    const profileScope = {
      ...HOST_SCOPE,
      profileHandle: "profile", profileGeneration: 1, accountGeneration: 2,
      runtimeGeneration: 3, childGeneration: 4, eventId: "event",
    };
    const valid = {
      type: "relay:codex-event",
      scope: profileScope,
      eventSequence: 1,
      event: { kind: "child_status", state: "ready" },
    };
    expect(parseRelayCodexClientMessage(valid).ok).toBe(true);
    expect(parseRelayCodexClientMessage({
      ...valid,
      event: { kind: "message_delta", text: "smuggled", sequence: 1 },
    }).ok).toBe(false);
    expect(parseRelayCodexJsonFrame(
      JSON.stringify(valid).replace("relay:codex-event", "relay:codex-\\u0065vent"),
      "client",
    ).ok).toBe(true);
  });

  test("accepts only bounded typed assistant completion projections", () => {
    const turnScope = {
      ...HOST_SCOPE,
      profileHandle: "profile", profileGeneration: 1, accountGeneration: 2,
      runtimeGeneration: 3, childGeneration: 4,
      bindingId: "binding", bindingGeneration: 5, taskId: "task", jobId: "job",
      threadId: "thread",
      workspace: {
        workspaceRef: "workspace", revision: 1, fingerprint: "fingerprint",
        issuedAt: "2026-07-29T00:00:00.000Z",
        expiresAt: "2026-07-29T01:00:00.000Z",
      },
      turnId: "turn", eventId: "event",
    } as const;
    const completed = {
      type: "relay:codex-event",
      scope: turnScope,
      eventSequence: 1,
      event: {
        kind: "turn_completed",
        status: "completed",
        itemsView: "full",
        assistantItems: [{
          itemId: "final", text: "A bounded answer", phase: "final_answer",
        }],
      },
    } as const;
    expect(parseRelayCodexClientMessage(completed).ok).toBe(true);
    expect(parseRelayCodexClientMessage({
      ...completed,
      event: { ...completed.event, error: "raw upstream error" },
    }).ok).toBe(false);
    expect(parseRelayCodexClientMessage({
      ...completed,
      event: {
        ...completed.event,
        assistantItems: [{ ...completed.event.assistantItems[0], text: "x".repeat(16 * 1024 + 1) }],
      },
    }).ok).toBe(false);
    const itemCompleted = {
      ...completed,
      scope: { ...turnScope, itemId: "final" },
      event: {
        kind: "assistant_item_completed",
        text: "A bounded answer",
        phase: "final_answer",
        sequence: 2,
      },
    } as const;
    expect(parseRelayCodexClientMessage(itemCompleted).ok).toBe(true);
    expect(parseRelayCodexClientMessage({
      ...itemCompleted,
      scope: turnScope,
    }).ok).toBe(false);

    expect(parseRelayCodexClientMessage({
      ...itemCompleted,
      event: { ...itemCompleted.event, text: null },
    }).ok).toBe(true);
    expect(parseRelayCodexClientMessage({
      ...itemCompleted,
      scope: { ...itemCompleted.scope, selectedProtocolVersion: 16 },
      event: { ...itemCompleted.event, text: null },
    }).ok).toBe(false);
  });

  test("preserves distinct bounded Codex-native permission presentation and responses", () => {
    const requestScope = {
      ...HOST_SCOPE,
      profileHandle: "profile", profileGeneration: 1, accountGeneration: 2,
      runtimeGeneration: 3, childGeneration: 4,
      bindingId: "binding", bindingGeneration: 5, taskId: "task", jobId: "job",
      threadId: "thread",
      workspace: {
        workspaceRef: "workspace", revision: 1, fingerprint: "fingerprint",
        issuedAt: "2026-07-29T00:00:00.000Z",
        expiresAt: "2026-07-29T01:00:00.000Z",
      },
      turnId: "turn", eventId: "event", itemId: "item", requestRef: "request",
    } as const;
    const approval = {
      type: "relay:codex-request",
      scope: requestScope,
      request: {
        kind: "permissions_approval",
        reason: "host_local_only",
        permissions: {
          network: { enabled: true },
          fileSystem: { readPathCount: 1, writePathCount: 2, entryCount: 0, pathDetail: "host_local_only" },
        },
        expiresAt: "2026-07-29T00:00:30.000Z",
      },
    } as const;
    expect(parseRelayCodexClientMessage(approval).ok).toBe(true);
    expect(parseRelayCodexClientMessage({
      ...approval,
      request: { ...approval.request, permissions: { ...approval.request.permissions, unknown: true } },
    }).ok).toBe(false);
    expect(parseRelayCodexClientMessage({
      ...approval,
      request: { ...approval.request, permissions: { ...approval.request.permissions, fileSystem: { ...approval.request.permissions.fileSystem, readPathCount: -1 } } },
    }).ok).toBe(false);
    expect(parseRelayCodexServerMessage({
      type: "relay:codex-request-response",
      scope: requestScope,
      response: {
        kind: "permissions_approval",
        grants: { network: false, fileSystem: true },
        scope: "session",
      },
    }).ok).toBe(true);
    expect(parseRelayCodexServerMessage({
      type: "relay:codex-request-response",
      scope: requestScope,
      response: { kind: "permissions_approval", grants: { network: "true", fileSystem: false }, scope: "turn" },
    }).ok).toBe(false);
  });

  test("enforces the exact UTF-8 N/N+1 boundary and bounds deep scans", () => {
    const prefix = `{"type":"relay:codex-command","padding":"`;
    const suffix = `"}`;
    const exact = prefix + "x".repeat(CODEX_RELAY_MAX_FRAME_BYTES - prefix.length - suffix.length) + suffix;
    expect(new TextEncoder().encode(exact)).toHaveLength(CODEX_RELAY_MAX_FRAME_BYTES);
    expect(parseRelayCodexJsonFrame(exact, "server")).toEqual({
      ok: false,
      error: "CODEX_FRAME_INVALID",
    });
    expect(parseRelayCodexJsonFrame(`${exact} `, "server")).toEqual({
      ok: false,
      error: "CODEX_FRAME_TOO_LARGE",
    });

    const deep = `{"type":"relay:codex-command","x":${"[".repeat(80)}0${"]".repeat(80)}}`;
    expect(parseRelayCodexJsonFrame(deep, "server")).toEqual({
      ok: false,
      error: "CODEX_FRAME_INVALID",
    });
  });

  test("requires normalized ISO timestamps", () => {
    const profile = {
      ...HOST_SCOPE,
      profileHandle: "profile", profileGeneration: 1, accountGeneration: 2,
      runtimeGeneration: 3, childGeneration: 4,
    };
    expect(parseRelayCodexServerMessage({
      type: "relay:codex-command",
      commandId: "drain",
      scope: profile,
      command: { kind: "drain_profile", deadlineAt: "July 26, 2026" },
    }).ok).toBe(false);
  });

  test("accepts callback-free binding commands and rejects callback smuggling", () => {
    const scope = {
      ...HOST_SCOPE,
      profileHandle: "profile",
      profileGeneration: 1,
      accountGeneration: 2,
      runtimeGeneration: 3,
      childGeneration: 4,
      workspace: {
        workspaceRef: "workspace",
        revision: 1,
        fingerprint: "fingerprint",
        issuedAt: "2026-07-26T10:00:00.000Z",
        expiresAt: "2026-07-26T11:00:00.000Z",
      },
      bindingId: "binding",
      bindingGeneration: 5,
      taskId: "task",
      jobId: "job",
    };
    const frame = {
      type: "relay:codex-command",
      commandId: "open",
      scope,
      command: {
        kind: "open_binding",
        posture: { kind: "codex_default", anchorMode: "default" },
        workingDirectory: "/projects/nautilo",
      },
    } as const;
    expect(parseRelayCodexServerMessage(frame).ok).toBe(true);
    expect(parseRelayCodexServerMessage({
      ...frame,
      command: {
        ...frame.command,
        callbacks: {
          manifestHash: "a".repeat(43),
          declarations: [],
        },
      },
    }).ok).toBe(false);
    expect(parseRelayCodexServerMessage({
      ...frame,
      command: { ...frame.command, workingDirectory: "x".repeat(4097) },
    }).ok).toBe(false);
  });

  test("correlates response-owned identity and rejects impossible scope/result arms", () => {
    const profileCommand = {
      type: "relay:codex-command",
      commandId: "profile-create",
      scope: HOST_SCOPE,
      command: {
        kind: "profile_create",
        profileHandle: "expected-profile",
        profileGeneration: 7,
      },
    } as const;
    const wrongProfile = {
      type: "relay:codex-command-response",
      commandId: "profile-create",
      scope: HOST_SCOPE,
      result: {
        kind: "profile_status",
        state: "created",
        profileHandle: "wrong-profile",
        profileGeneration: 999,
        homeHandle: "wrong-home",
      },
    } as const;
    expect(parseRelayCodexClientMessage(wrongProfile).ok).toBe(true);
    expect(isRelayCodexCommandResponseForCommand(profileCommand, wrongProfile)).toBe(false);

    const activateCommand = {
      type: "relay:codex-command",
      commandId: "runtime-activate",
      scope: HOST_SCOPE,
      command: { kind: "runtime_activate", runtimeGeneration: 11 },
    } as const;
    const wrongRuntimeGeneration = {
      type: "relay:codex-command-response",
      commandId: "runtime-activate",
      scope: HOST_SCOPE,
      result: { kind: "runtime_status", state: "ready", runtimeGeneration: 12 },
    } as const;
    expect(isRelayCodexCommandResponseForCommand(
      activateCommand,
      wrongRuntimeGeneration,
    )).toBe(false);

    const profileScope = {
      ...HOST_SCOPE,
      profileHandle: "expected-profile",
      profileGeneration: 7,
      accountGeneration: 1,
      runtimeGeneration: 2,
      childGeneration: 3,
    } as const;
    expect(parseRelayCodexClientMessage({
      type: "relay:codex-command-response",
      commandId: "impossible-runtime-profile-result",
      scope: profileScope,
      result: { kind: "runtime_status", state: "ready", runtimeGeneration: 2 },
    }).ok).toBe(false);

    const workspace = {
      workspaceRef: "workspace",
      revision: 1,
      fingerprint: "fingerprint",
      issuedAt: "2026-07-26T10:00:00.000Z",
      expiresAt: "2026-07-26T11:00:00.000Z",
    } as const;
    const rebindCommand = {
      type: "relay:codex-command",
      commandId: "rebind",
      scope: {
        ...profileScope,
        bindingId: "binding",
        bindingGeneration: 4,
        taskId: "task",
        jobId: "job",
        threadId: "expected-thread",
      },
      command: {
        kind: "rebind_binding",
        nextBindingGeneration: 5,
        successorWorkspace: workspace,
      },
    } as const;
    const wrongThreadRejection = {
      type: "relay:codex-command-response",
      commandId: "rebind",
      scope: {
        ...rebindCommand.scope,
        bindingGeneration: 5,
        threadId: "wrong-thread",
        workspace,
      },
      result: { kind: "rejected", code: "CODEX_CONTEXT_STALE" },
    } as const;
    expect(parseRelayCodexClientMessage(wrongThreadRejection).ok).toBe(true);
    expect(isRelayCodexCommandResponseForCommand(
      rebindCommand,
      wrongThreadRejection,
    )).toBe(false);
  });

  test("correlates resume_binding with its exact BindingScope and binding_ready result", () => {
    const scope = {
      ...HOST_SCOPE,
      profileHandle: "profile", profileGeneration: 1, accountGeneration: 2,
      runtimeGeneration: 3, childGeneration: 4, bindingId: "binding",
      bindingGeneration: 5, taskId: "task", jobId: "job", threadId: "thread",
      workspace: { workspaceRef: "workspace", revision: 1, fingerprint: "fingerprint", issuedAt: "2026-07-26T10:00:00.000Z", expiresAt: "2026-07-26T11:00:00.000Z" },
    } as const;
    const command = { type: "relay:codex-command", commandId: "resume", scope, command: { kind: "resume_binding" } } as const;
    const valid = { type: "relay:codex-command-response", commandId: "resume", scope, result: { kind: "binding_ready" } } as const;
    const wrongKind = { ...valid, result: { kind: "binding_rebound" } } as const;
    expect(parseRelayCodexClientMessage(valid).ok).toBe(true);
    expect(isRelayCodexCommandResponseForCommand(command, valid)).toBe(true);
    expect(parseRelayCodexClientMessage(wrongKind).ok).toBe(true);
    expect(isRelayCodexCommandResponseForCommand(command, wrongKind)).toBe(false);
  });

  test("correlates release_binding only to its exact BindingScope and binding_released result", () => {
    const scope = {
      ...HOST_SCOPE,
      profileHandle: "profile", profileGeneration: 1, accountGeneration: 2,
      runtimeGeneration: 3, childGeneration: 4, bindingId: "losing-binding",
      bindingGeneration: 0, taskId: "task", jobId: "job", threadId: "losing-thread",
      workspace: { workspaceRef: "workspace", revision: 1, fingerprint: "fingerprint", issuedAt: "2026-07-26T10:00:00.000Z", expiresAt: "2026-07-26T11:00:00.000Z" },
    } as const;
    const command = { type: "relay:codex-command", commandId: "release", scope, command: { kind: "release_binding" } } as const;
    const valid = { type: "relay:codex-command-response", commandId: "release", scope, result: { kind: "binding_released" } } as const;
    const staleGeneration = { ...valid, scope: { ...scope, bindingGeneration: 1 } } as const;
    const wrongKind = { ...valid, result: { kind: "binding_ready" } } as const;
    expect(parseRelayCodexServerMessage(command).ok).toBe(true);
    expect(parseRelayCodexClientMessage(valid).ok).toBe(true);
    expect(isRelayCodexCommandResponseForCommand(command, valid)).toBe(true);
    expect(parseRelayCodexClientMessage(staleGeneration).ok).toBe(true);
    expect(isRelayCodexCommandResponseForCommand(command, staleGeneration)).toBe(false);
    expect(parseRelayCodexClientMessage(wrongKind).ok).toBe(true);
    expect(isRelayCodexCommandResponseForCommand(command, wrongKind)).toBe(false);
  });

  test("correlates start_turn to the exact command and accepts the upstream-owned turn id", () => {
    const scope = {
      ...HOST_SCOPE,
      profileHandle: "profile",
      profileGeneration: 1,
      accountGeneration: 2,
      runtimeGeneration: 3,
      childGeneration: 4,
      bindingId: "binding",
      bindingGeneration: 0,
      taskId: "task",
      jobId: "job",
      threadId: "thread",
      workspace: {
        workspaceRef: "workspace",
        revision: 1,
        fingerprint: "fingerprint",
        issuedAt: "2026-07-26T10:00:00.000Z",
        expiresAt: "2026-07-26T11:00:00.000Z",
      },
    } as const;
    const command = {
      type: "relay:codex-command",
      commandId: "start",
      scope,
      command: {
        kind: "start_turn",
        userText: "hello",
        turnInputRef: "input",
      },
    } as const;
    const valid = {
      type: "relay:codex-command-response",
      commandId: "start",
      scope: {
        ...scope,
        turnId: "upstream-owned-turn",
      },
      result: { kind: "turn_started" },
    } as const;
    expect(parseRelayCodexClientMessage(valid).ok).toBe(true);
    expect(parseRelayCodexServerMessage({
      ...command,
      command: { ...command.command, collaborationMode: "plan" },
    }).ok).toBe(true);
    expect(parseRelayCodexServerMessage({
      ...command,
      command: { ...command.command, collaborationMode: "work" },
    }).ok).toBe(false);
    expect(isRelayCodexCommandResponseForCommand(command, valid)).toBe(true);
    expect(isRelayCodexCommandResponseForCommand(command, {
      ...valid,
      scope: { ...valid.scope, turnId: "another-upstream-turn" },
    })).toBe(true);
  });
});
