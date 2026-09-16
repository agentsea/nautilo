import { describe, expect, test } from "bun:test";
import type { HarnessExecutionAdmission } from "@nautilo/runtime";
import type { RelayCodexCommandMessage, RelayCodexCommandResponseMessage } from "@nautilo/relay";
import { CodexAuthorityFailure, type CodexBindingMutationPort, type CodexDerivedBindingScope } from "../../src/codex/authority";
import {
  CodexBindingSessionFailure,
  CodexBindingSessionService,
  type CodexTaskBindingRecord,
} from "../../src/codex/binding-session";
import { createCodexExecutionAdmission } from "../../src/codex/execution-admission";

const workspace = {
  workspaceRef: "workspace", revision: 7, fingerprint: "fingerprint",
  issuedAt: "2026-07-27T09:55:00.000Z", expiresAt: "2026-07-27T10:05:00.000Z",
};
const scope: CodexDerivedBindingScope = {
  userId: "user", agentId: "agent", taskId: "task", taskRunId: "run", jobId: "job",
  parentTaskId: null, roomId: "room", laneKey: "room:lane", profileId: "profile",
  relayId: "relay", profileHandle: "profile-handle", profileGeneration: 2,
  accountGeneration: 3, posture: "prompted_workspace", explicitSteer: true,
  relaySessionId: "relay-session",
  desktopSessionId: "desktop-session", pairingGenerationRef: "pairing", selectedProtocolVersion: 9, capabilityRevision: 4,
  runtimeGeneration: 5, childGeneration: 6, workspace,
  codexSandboxMode: "workspace-write", codexApprovalPolicy: "on-request",
};
const outputContract = {
  version: 1, capabilityModelId: "openai:gpt-test", catalogVersion: "test-v1",
  contextTokens: 1_000_000, outputTokens: 128_000,
} as const;

function admission(options: {
  id?: string;
  generation?: number;
  model?: string | null;
  source?: "room" | "agent";
  requesterId?: string;
  profileGeneration?: string;
  collaborationMode?: "work" | "plan";
  workingDirectory?: string | null;
  scope?: CodexDerivedBindingScope;
} = {}) {
  const admittedScope = options.scope ?? scope;
  const bindingId = options.id ?? "binding";
  const bindingGeneration = options.generation ?? 0;
  return createCodexExecutionAdmission({
    jobId: admittedScope.jobId, taskId: admittedScope.taskId, taskRunId: admittedScope.taskRunId,
    ownerId: admittedScope.userId, requesterId: options.requesterId ?? admittedScope.userId, roomId: admittedScope.roomId,
    laneKey: admittedScope.laneKey, source: options.source ?? "room", parentTaskId: admittedScope.parentTaskId,
    binding: { id: bindingId, generation: String(bindingGeneration) },
    workspace: {
      id: admittedScope.workspace.workspaceRef,
      currentFolderReceiptId: admittedScope.workspace.fingerprint,
      pairingGeneration: admittedScope.pairingGenerationRef,
    },
    profile: {
      id: admittedScope.profileId,
      generation: options.profileGeneration ?? String(admittedScope.profileGeneration),
    },
    posture: { id: admittedScope.posture, generation: "posture-generation" },
    prompt: "hello", abortSignal: new AbortController().signal,
    codex: {
      scope: admittedScope,
      selectedModel: options.model ?? "gpt-test",
      outputContract,
      collaborationMode: options.collaborationMode ?? "work",
      workingDirectory: options.workingDirectory ?? null,
      bindingKind: "task",
    },
  });
}

function binding(overrides: Partial<CodexTaskBindingRecord> = {}): CodexTaskBindingRecord {
  const active = admission({ generation: 0 });
  return {
    id: "binding", userId: scope.userId, sourceAgentId: scope.agentId,
    taskId: scope.taskId, taskRunId: scope.taskRunId, jobId: scope.jobId,
    parentTaskId: scope.parentTaskId, roomId: scope.roomId, laneKey: scope.laneKey,
    bindingKind: "task", relayId: scope.relayId, relaySessionId: scope.relaySessionId,
    desktopSessionId: scope.desktopSessionId, pairingGenerationRef: scope.pairingGenerationRef,
    capabilityRevision: scope.capabilityRevision, workspaceRef: scope.workspace.workspaceRef,
    workspaceRevision: scope.workspace.revision, workspaceFingerprint: scope.workspace.fingerprint,
    workspaceIssuedAt: new Date(scope.workspace.issuedAt), workspaceExpiresAt: new Date(scope.workspace.expiresAt),
    accountProfileId: scope.profileId, codexThreadId: "thread", profileGeneration: scope.profileGeneration,
    accountGeneration: scope.accountGeneration, runtimeGeneration: scope.runtimeGeneration,
    childGeneration: scope.childGeneration, bindingGeneration: 0,
    selectedModel: active.codex.selectedModel,
    codexSandboxMode: scope.codexSandboxMode, codexApprovalPolicy: scope.codexApprovalPolicy,
    state: "active", revision: 9, archivedAt: null, ...overrides,
  };
}

function response(value: unknown): RelayCodexCommandResponseMessage {
  return value as RelayCodexCommandResponseMessage;
}

async function expectFailure(
  operation: Promise<unknown>,
  code: CodexBindingSessionFailure["code"],
): Promise<void> {
  try {
    await operation;
    throw new Error("expected Codex binding session failure");
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

function harness(options: {
  row?: CodexTaskBindingRecord | null;
  childGeneration?: number;
  mutationFailure?: "insert" | "replace_conflict" | "replace_unknown" | "update" | "rebind";
  openedThreadId?: string;
  interruptResult?: "interrupted" | "accepted";
  openRejectedCode?: "CODEX_CONTEXT_STALE" | "CODEX_BINDING_UNAVAILABLE";
} = {}) {
  const calls: string[] = [];
  const commands: RelayCodexCommandMessage[] = [];
  const lookupScopes: CodexDerivedBindingScope[] = [];
  const replacements: Array<{
    scope: CodexDerivedBindingScope;
    currentId: string;
    expectedRevision: number;
    mutation: Parameters<CodexBindingMutationPort["replace"]>[3];
  }> = [];
  const mutations: CodexBindingMutationPort = {
    insert: async () => {
      calls.push("insert");
      if (options.mutationFailure === "insert") throw new Error("conflict");
    },
    replace: async (replaceScope, currentId, expectedRevision, mutation) => {
      calls.push("replace");
      replacements.push({
        scope: replaceScope,
        currentId,
        expectedRevision,
        mutation,
      });
      if (options.mutationFailure === "replace_conflict") {
        throw new CodexAuthorityFailure("CODEX_CONFLICT");
      }
      if (options.mutationFailure === "replace_unknown") throw new Error("ambiguous database failure");
    },
    update: async () => {
      calls.push("update");
      if (options.mutationFailure === "update") throw new Error("conflict");
    },
    archive: async () => undefined,
    rebind: async () => {
      calls.push("rebind-persist");
      if (options.mutationFailure === "rebind") throw new Error("conflict");
    },
  };
  let commandId = 0;
  const service = new CodexBindingSessionService({
    bindings: {
      getActiveTaskBinding: async (lookupScope) => {
        calls.push("lookup-task");
        lookupScopes.push(lookupScope);
        return options.row ?? null;
      },
    },
    mutations,
    mintId: () => `mint-${++commandId}`,
    relay: {
      sendCodexCommand: async (_relayId, command): Promise<RelayCodexCommandResponseMessage> => {
        commands.push(command);
        calls.push(command.command.kind);
        switch (command.command.kind) {
          case "ensure_profile_child":
            return response({
              type: "relay:codex-command-response", commandId: command.commandId,
              scope: {
                ...command.scope,
                childGeneration: options.childGeneration ?? scope.childGeneration,
              },
              result: { kind: "child_ready" },
            });
          case "open_binding":
            if (options.openRejectedCode) {
              return response({
                type: "relay:codex-command-response",
                commandId: command.commandId,
                scope: command.scope,
                result: { kind: "rejected", code: options.openRejectedCode },
              });
            }
            return response({
              type: "relay:codex-command-response", commandId: command.commandId,
              scope: { ...command.scope, threadId: options.openedThreadId ?? "thread" }, result: { kind: "binding_ready" },
            });
          case "resume_binding":
            return response({ type: "relay:codex-command-response", commandId: command.commandId, scope: command.scope, result: { kind: "binding_ready" } });
          case "release_binding":
            return response({
              type: "relay:codex-command-response",
              commandId: command.commandId,
              scope: command.scope,
              result: { kind: "binding_released" },
            });
          case "rebind_binding":
            return response({
              type: "relay:codex-command-response", commandId: command.commandId,
              scope: { ...command.scope, bindingGeneration: command.command.nextBindingGeneration, workspace: command.command.successorWorkspace },
              result: { kind: "binding_rebound" },
            });
          case "start_turn":
            return response({
              type: "relay:codex-command-response", commandId: command.commandId,
              scope: { ...command.scope, turnId: "upstream-turn" },
              result: { kind: "turn_started" },
            });
          case "interrupt_turn":
            return response({
              type: "relay:codex-command-response", commandId: command.commandId,
              scope: command.scope,
              result: { kind: options.interruptResult ?? "interrupted" },
            });
          case "steer_turn":
            return response({
              type: "relay:codex-command-response",
              commandId: command.commandId,
              scope: command.scope,
              result: { kind: "accepted" },
            });
          default: throw new Error("unexpected command");
        }
      },
    },
  });
  return { service, calls, commands, lookupScopes, replacements };
}

describe("CodexBindingSessionService", () => {
  test("preserves an explicit working-directory rejection without exposing its host detail", async () => {
    const rejected = harness({ openRejectedCode: "CODEX_CONTEXT_STALE" });
    await expectFailure(
      rejected.service.openOrResume(admission({ workingDirectory: "/missing/private-project" })),
      "CODEX_WORKSPACE_UNAVAILABLE",
    );
    expect(rejected.commands.find((command) => command.command.kind === "open_binding"))
      .toMatchObject({ command: { workingDirectory: "/missing/private-project" } });
  });

  test("keeps automatic working-directory rejection closed as a generic binding failure", async () => {
    const rejected = harness({ openRejectedCode: "CODEX_CONTEXT_STALE" });
    await expectFailure(rejected.service.openOrResume(admission()), "CODEX_BINDING_UNAVAILABLE");
  });

  test("accepts negotiated protocol version 9, opens an exact task binding, then persists only after binding_ready", async () => {
    const { service, calls, commands } = harness();
    const session = await service.openOrResume(admission());
    expect(session.id).toBe("binding");
    expect(calls).toEqual(["ensure_profile_child", "lookup-task", "open_binding", "insert", "update"]);
    expect(commands[1]?.scope).toMatchObject({
      bindingId: "binding", bindingGeneration: 0, taskId: "task", jobId: "job",
      relaySessionId: "relay-session", selectedProtocolVersion: 9,
    });
  });

  test("resumes only an exact active task binding", async () => {
    const { service, calls, commands } = harness({ row: binding() });
    await service.openOrResume(admission());
    expect(calls).toEqual(["ensure_profile_child", "lookup-task", "resume_binding"]);
    expect(commands[1]?.scope).toMatchObject({ bindingId: "binding", threadId: "thread" });
  });

  test("rebinds a needs_rebind binding to the admitted successor generation before resume", async () => {
    const stale = binding({ state: "needs_rebind", relaySessionId: "old-relay-session", revision: 12, bindingGeneration: 4 });
    const { service, calls, commands } = harness({ row: stale });
    await service.openOrResume(admission({ generation: 5 }));
    expect(calls).toEqual(["ensure_profile_child", "lookup-task", "rebind_binding", "rebind-persist", "resume_binding"]);
    expect(commands[1]?.scope).toMatchObject({ bindingGeneration: 4, relaySessionId: "old-relay-session" });
    expect(commands[1]?.command).toMatchObject({ nextBindingGeneration: 5, successorWorkspace: workspace });
    expect(commands[2]?.scope).toMatchObject({ bindingGeneration: 5, relaySessionId: scope.relaySessionId });
  });

  test("recovers only the exact live generation-zero opening row", async () => {
    const opening = binding({ state: "opening", revision: 0, bindingGeneration: 0 });
    const { service, calls, commands } = harness({ row: opening });
    await service.openOrResume(admission());
    expect(calls).toEqual(["ensure_profile_child", "lookup-task", "resume_binding", "update"]);
    expect(commands[1]?.scope).toMatchObject({ bindingId: "binding", bindingGeneration: 0, threadId: "thread" });

    const wrongGeneration = harness({ row: binding({ state: "opening", bindingGeneration: 1 }) });
    await expectFailure(wrongGeneration.service.openOrResume(admission()), "CODEX_BINDING_MISMATCH");
  });

  test("fails closed for mismatched persisted identity or unsupported state", async () => {
    const mismatch = harness({ row: binding({ selectedModel: "other-model" }) });
    await expectFailure(mismatch.service.openOrResume(admission()), "CODEX_BINDING_MISMATCH");
    expect(mismatch.calls).toEqual(["ensure_profile_child", "lookup-task"]);

    const stale = harness({ row: binding({ state: "completed" }) });
    await expectFailure(stale.service.openOrResume(admission()), "CODEX_BINDING_STALE");
  });

  test("opens a fresh thread then atomically archives and replaces immutable drift", async () => {
    const predecessor = binding({
      id: "predecessor",
      codexThreadId: "predecessor-thread",
      accountProfileId: "previous-profile",
      accountGeneration: scope.accountGeneration + 1,
      revision: 12,
    });
    const { service, calls, commands, replacements } = harness({
      row: predecessor,
      openedThreadId: "successor-thread",
    });

    const session = await service.openOrResume(admission({ id: "successor", generation: 0 }));

    expect(session.id).toBe("successor");
    expect(calls).toEqual([
      "ensure_profile_child",
      "lookup-task",
      "open_binding",
      "replace",
      "update",
    ]);
    expect(commands[1]?.scope).toMatchObject({
      bindingId: "successor",
      bindingGeneration: 0,
      profileHandle: scope.profileHandle,
    });
    expect(replacements).toEqual([{
      scope,
      currentId: "predecessor",
      expectedRevision: 12,
      mutation: {
        bindingId: "successor",
        bindingKind: "task",
        codexThreadId: "successor-thread",
        selectedModel: "gpt-test",
      },
    }]);
  });

  test("releases only the just-opened successor when replacement loses its CAS race", async () => {
    const predecessor = binding({
      id: "predecessor",
      codexThreadId: "predecessor-thread",
      runtimeGeneration: scope.runtimeGeneration + 1,
      revision: 12,
    });
    const { service, calls, commands } = harness({
      row: predecessor,
      mutationFailure: "replace_conflict",
      openedThreadId: "uncommitted-successor-thread",
    });

    await expectFailure(
      service.openOrResume(admission({ id: "successor", generation: 0 })),
      "CODEX_PERSISTENCE_CONFLICT",
    );
    expect(calls).toEqual([
      "ensure_profile_child",
      "lookup-task",
      "open_binding",
      "replace",
      "release_binding",
    ]);
    expect(commands.map((command) => command.command.kind)).toEqual([
      "ensure_profile_child",
      "open_binding",
      "release_binding",
    ]);
    expect(commands[2]).toMatchObject({
      scope: {
        bindingId: "successor",
        bindingGeneration: 0,
        threadId: "uncommitted-successor-thread",
        taskId: scope.taskId,
        jobId: scope.jobId,
        childGeneration: scope.childGeneration,
      },
      command: { kind: "release_binding" },
    });
    expect(commands[2]?.scope).not.toMatchObject({
      bindingId: predecessor.id,
      threadId: predecessor.codexThreadId,
    });
  });

  test("retains the just-opened host binding when replacement failure has an ambiguous commit outcome", async () => {
    const predecessor = binding({
      id: "predecessor",
      codexThreadId: "predecessor-thread",
      runtimeGeneration: scope.runtimeGeneration + 1,
      revision: 12,
    });
    const { service, calls, commands } = harness({
      row: predecessor,
      mutationFailure: "replace_unknown",
      openedThreadId: "ambiguous-successor-thread",
    });

    await expectFailure(
      service.openOrResume(admission({ id: "successor", generation: 0 })),
      "CODEX_PERSISTENCE_CONFLICT",
    );
    expect(calls).toEqual([
      "ensure_profile_child",
      "lookup-task",
      "open_binding",
      "replace",
    ]);
    expect(commands.map((command) => command.command.kind)).toEqual([
      "ensure_profile_child",
      "open_binding",
    ]);
  });

  test("rejects malformed predecessors and a host that reuses the predecessor thread", async () => {
    const malformed = harness({
      row: binding({ relayId: "" }),
      openedThreadId: "should-not-open",
    });
    await expectFailure(
      malformed.service.openOrResume(admission({ id: "successor" })),
      "CODEX_BINDING_MISMATCH",
    );
    expect(malformed.calls).toEqual(["ensure_profile_child", "lookup-task"]);

    const reused = harness({
      row: binding({
        id: "predecessor",
        runtimeGeneration: scope.runtimeGeneration + 1,
        codexThreadId: "predecessor-thread",
      }),
      openedThreadId: "predecessor-thread",
    });
    await expectFailure(
      reused.service.openOrResume(admission({ id: "successor" })),
      "CODEX_BINDING_UNAVAILABLE",
    );
    expect(reused.calls).toEqual([
      "ensure_profile_child",
      "lookup-task",
      "open_binding",
    ]);
  });

  test("never reuses a predecessor id after immutable account, host, workspace, posture, runtime, or model drift", async () => {
    const cases: Array<[string, Partial<CodexTaskBindingRecord>]> = [
      ["account", { accountProfileId: "other-profile", accountGeneration: 4 }],
      ["host", { relayId: "other-relay", pairingGenerationRef: "other-pairing" }],
      ["workspace", { workspaceRef: "other-workspace", workspaceFingerprint: "other-current-folder" }],
      ["posture", { codexSandboxMode: "default", codexApprovalPolicy: "default" }],
      ["runtime", { runtimeGeneration: 6 }],
      ["model", { selectedModel: "other-model" }],
    ];

    for (const [name, changed] of cases) {
      const { service, calls, commands } = harness({ row: binding(changed) });
      await expectFailure(service.openOrResume(admission()), "CODEX_BINDING_MISMATCH");
      expect(calls, name).toEqual(["ensure_profile_child", "lookup-task"]);
      expect(commands.map((command) => command.command.kind), name)
        .toEqual(["ensure_profile_child"]);
    }
  });

  test("requires a successor generation after stale child or Current Folder receipt, then rebinds only that exact successor", async () => {
    const refreshedFolder: CodexDerivedBindingScope = {
      ...scope,
      workspace: {
        ...scope.workspace,
        revision: scope.workspace.revision + 1,
        issuedAt: "2026-07-27T10:05:00.000Z",
        expiresAt: "2026-07-27T10:15:00.000Z",
      },
    };
    const refreshedChild: CodexDerivedBindingScope = {
      ...scope,
      childGeneration: scope.childGeneration + 1,
    };

    for (const [name, successor] of [
      ["child", refreshedChild],
      ["Current Folder", refreshedFolder],
    ] as const) {
      const active = harness({ row: binding(), childGeneration: successor.childGeneration });
      await expectFailure(
        active.service.openOrResume(admission({ scope: successor })),
        "CODEX_BINDING_STALE",
      );
      expect(active.calls, name).toEqual(["ensure_profile_child", "lookup-task"]);

      const pending = harness({
        row: binding({ state: "needs_rebind", revision: 12 }),
        childGeneration: successor.childGeneration,
      });
      await expectFailure(
        pending.service.openOrResume(admission({ scope: successor })),
        "CODEX_BINDING_STALE",
      );
      expect(pending.calls, `${name} stale generation`).toEqual([
        "ensure_profile_child",
        "lookup-task",
      ]);

      const rebound = harness({
        row: binding({ state: "needs_rebind", revision: 12 }),
        childGeneration: successor.childGeneration,
      });
      await rebound.service.openOrResume(admission({ generation: 1, scope: successor }));
      expect(rebound.commands[1]?.scope, name).toMatchObject({
        bindingGeneration: 0,
        childGeneration: scope.childGeneration,
      });
      expect(rebound.commands[1]?.command, name).toMatchObject({
        successorWorkspace: successor.workspace,
      });
      expect(rebound.commands[2]?.scope, name).toMatchObject({
        bindingGeneration: 1,
        childGeneration: successor.childGeneration,
        workspace: successor.workspace,
      });
    }
  });

  test("opens separately owned Task bindings for two Humans in the same Room", async () => {
    const secondHuman: CodexDerivedBindingScope = {
      ...scope,
      userId: "other-user",
      taskId: "other-task",
      taskRunId: "other-run",
      jobId: "other-job",
      profileId: "other-profile",
      profileHandle: "other-profile-handle",
      // Deliberately the same Room and lane shape: owner/Task identity, not a
      // shared Room lookup, selects the durable Codex thread binding.
      roomId: scope.roomId,
      laneKey: scope.laneKey,
    };
    const first = harness();
    const second = harness();

    const firstSession = await first.service.openOrResume(admission({ id: "binding-a" }));
    const secondSession = await second.service.openOrResume(admission({
      id: "binding-b",
      scope: secondHuman,
    }));

    expect(firstSession.id).toBe("binding-a");
    expect(secondSession.id).toBe("binding-b");
    expect(first.lookupScopes[0]).toMatchObject({
      userId: scope.userId,
      taskId: scope.taskId,
      roomId: scope.roomId,
    });
    expect(second.lookupScopes[0]).toMatchObject({
      userId: secondHuman.userId,
      taskId: secondHuman.taskId,
      roomId: scope.roomId,
    });
    expect(first.commands[1]?.scope).toMatchObject({ bindingId: "binding-a", taskId: scope.taskId });
    expect(second.commands[1]?.scope).toMatchObject({ bindingId: "binding-b", taskId: secondHuman.taskId });
  });

  test("rejects a child generation mismatch before reading any binding", async () => {
    const { service, calls } = harness({ childGeneration: scope.childGeneration + 1 });
    await expectFailure(service.openOrResume(admission()), "CODEX_CHILD_UNAVAILABLE");
    expect(calls).toEqual(["ensure_profile_child"]);
  });

  test("starts, steers, and interrupts an exact returned turn scope", async () => {
    const { service, commands } = harness();
    const admitted = admission();
    const session = await service.openOrResume(admitted);
    const turn = await service.startTurn({ session, admission: admitted });
    await service.steerTurn({
      session,
      turn,
      text: "Focus on the failing test",
      actorRef: "actor-ref",
    });
    await service.interruptTurn({ session, turn });
    const start = commands.find((command) => command.command.kind === "start_turn");
    const stop = commands.find((command) => command.command.kind === "interrupt_turn");
    const steer = commands.find((command) => command.command.kind === "steer_turn");
    expect(start?.scope).toMatchObject({ bindingId: "binding", threadId: "thread", taskId: "task", jobId: "job" });
    expect(stop?.scope).toMatchObject({
      ...(start?.scope ?? {}),
      turnId: turn.scope.turnId,
    });
    expect(stop?.command).toEqual({ kind: "interrupt_turn", reason: "user_stop" });
    expect(steer).toMatchObject({
      scope: { turnId: turn.scope.turnId },
      command: {
        kind: "steer_turn",
        userText: "Focus on the failing test",
        actorRef: "actor-ref",
      },
    });
  });

  test("propagates the private Plan Task fact into the semantic start command", async () => {
    const { service, commands } = harness();
    const admitted = admission({ collaborationMode: "plan" });
    const session = await service.openOrResume(admitted);
    await service.startTurn({ session, admission: admitted });
    expect(commands.find((command) => command.command.kind === "start_turn")?.command)
      .toMatchObject({ kind: "start_turn", collaborationMode: "plan" });
  });

  test("does not treat a merely accepted interrupt as a completed stop", async () => {
    const { service } = harness({ interruptResult: "accepted" });
    const admitted = admission();
    const session = await service.openOrResume(admitted);
    const turn = await service.startTurn({ session, admission: admitted });
    await expectFailure(service.interruptTurn({ session, turn }), "CODEX_TURN_UNAVAILABLE");
  });

  test("maps persistence conflicts to a bounded failure after host confirmation", async () => {
    const { service, calls } = harness({ mutationFailure: "insert" });
    await expectFailure(service.openOrResume(admission()), "CODEX_PERSISTENCE_CONFLICT");
    expect(calls).toEqual(["ensure_profile_child", "lookup-task", "open_binding", "insert"]);
  });

  test("does not accept an unbranded runtime admission", async () => {
    const { service } = harness();
    const unbranded = { ...admission() } as HarnessExecutionAdmission;
    await expectFailure(service.openOrResume(unbranded), "CODEX_EXECUTION_ADMISSION_INVALID");
  });

  test("does not accept a branded admission whose public facts diverge from its private scope", async () => {
    const { service } = harness();
    await expectFailure(service.openOrResume(admission({ source: "agent" })), "CODEX_EXECUTION_ADMISSION_INVALID");
    await expectFailure(service.openOrResume(admission({ requesterId: "other-user" })), "CODEX_EXECUTION_ADMISSION_INVALID");
    await expectFailure(service.openOrResume(admission({ profileGeneration: "99" })), "CODEX_EXECUTION_ADMISSION_INVALID");
  });
});
