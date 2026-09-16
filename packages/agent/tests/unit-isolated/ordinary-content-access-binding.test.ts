import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { clearToolCatalog, initToolCatalog, ToolCatalog } from "@nautilo/catalog";
import { z } from "zod";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { Command, END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import type { ContentAccessReceipt, PolicyResolver } from "@nautilo/trust";
import { NautiloStateAnnotation, type NautiloState } from "../../src/agent/state";
import { createOrdinaryContentAccessPreflightNode } from "../../src/nodes/ordinary-content-access-preflight";
import { createPostModelNode, type PostModelDeps } from "../../src/nodes/post-model";
import { createToolsNode } from "../../src/nodes/tools";
import {
  bindOrdinaryContentAccessExecution,
  matchesOrdinaryContentAccessBinding,
  ordinaryShareExecutionIdentity,
  ordinaryShareOperationId,
  type OrdinaryContentAccessPort,
  type OrdinaryContentAccessPreparedOperation,
  type OrdinaryContentAccessSelection,
  type OrdinaryContentAccessExecution,
  OrdinaryContentAccessRetryRequiredError,
  ordinaryContentAccessToolContextForState,
} from "../../src/runtime/ordinary-content-access";

const userId = "10000000-0000-4000-8000-000000000001";
const actorId = "10000000-0000-4000-8000-000000000002";
const agentId = "10000000-0000-4000-8000-000000000003";
const roomId = "10000000-0000-4000-8000-000000000004";
const artifactId = "10000000-0000-4000-8000-000000000005";
const recipientId = "10000000-0000-4000-8000-000000000006";
const internalArtifactId = "10000000-0000-4000-8000-000000000007";

beforeEach(() => {
  const catalog = new ToolCatalog();
  for (const name of ["share_artifact", "share_memory", "ask_peer"]) catalog.register({
    name, factory: (context) => new DynamicStructuredTool({ name, description: "synthetic share", schema: z.object({}).passthrough(),
      func: async () => {
        const capability = context?.["ordinaryContentAccess"] as OrdinaryContentAccessExecution | undefined;
        return capability ? JSON.stringify(await capability.commit()) : "unused";
      } }),
    category: "knowledge", trustTier: "standard", impact: "destructive", approvalMode: "hybrid", exposure: "core", resultScanPolicy: "never",
  });
  initToolCatalog(catalog);
});
afterEach(() => clearToolCatalog());

function input(args: Record<string, unknown> = { artifact_id: artifactId, target_handle: "peer", sensitivity: "sensitive" }, name = "share_artifact") {
  return {
    messages: [new AIMessage({ id: "assistant-message", content: "", tool_calls: [{ id: "call-1", name, args }] })],
    userId, agentId, roomId, actorRole: "owner", turnId: "durable-turn",
    langgraphThreadId: "ordinary-binding", approvalLaneKey: "room-lane",
    memoryAccessEnvelope: { actorId, agentId, ownerId: userId, roomId, memoryMode: "namespace",
      readableNamespaces: [], mutableNamespaces: [], writableNamespaces: [], toolPolicy: {} },
  } as Partial<NautiloState>;
}

function fixture() {
  const prepared: OrdinaryContentAccessPreparedOperation[] = [];
  const commits: OrdinaryContentAccessPreparedOperation[] = [];
  let deadline = Date.now() + 600_000;
  let outcome: ContentAccessReceipt["outcome"] = "applied";
  let failOnce = false;
  const port: OrdinaryContentAccessPort = {
    async verifyPeerContact() { return true; },
    async prepare(request) {
      const operations = request.intent.objects.map((object, index): OrdinaryContentAccessPreparedOperation => ({
        admission: { principal: { kind: "agent", userId, actorId, agentId, sourceRoomId: roomId },
          audienceContract: "invoking_room", approvalContext: request.approvalContext },
        command: { operationId: request.operationIds[index]!, object: { kind: object.kind, id: internalArtifactId },
          change: request.intent.target.kind === "person"
            ? { kind: "grant_people", selectedActorIds: [recipientId] }
            : { kind: "grant_room", targetRoomId: recipientId } },
        sourceObject: object, previewToken: `signed-${request.operationIds[index]}`, expiresAt: deadline,
        ...(object.kind === "artifact" ? { artifact: { artifactId: object.id, path: "exact.md", mimeType: "text/markdown", size: 12 } } : {}),
      }));
      prepared.push(...operations);
      return { status: "prepared", operations,
        preview: { id: request.execution.toolCallId, name: request.execution.toolName,
          args: { audience: "Source Room Humans and peer", objectCount: operations.length } } };
    },
    async commit(operation) {
      commits.push(operation);
      if (failOnce) { failOnce = false; return { outcome: "failed", stateChanged: "unknown", receiptPersisted: false, recovery: "retry_receipt" }; }
      if (operation.expiresAt <= Date.now()) return { outcome: "stale", stateChanged: false, receiptPersisted: false, recovery: "prepare_again" };
      return { operationId: operation.command.operationId, outcome, stateChanged: true, originalStateChanged: true,
        replayed: false, attachedCount: 1, detachedCount: 0, skippedCount: 0 };
    },
  };
  let selection: OrdinaryContentAccessSelection = { mode: "plaintext_only", port };
  return { prepared, commits, port,
    resolve: async () => selection,
    expire() { deadline = Date.now() - 1; },
    setOutcome(value: typeof outcome) { outcome = value; },
    failOnce() { failOnce = true; },
    changeMode() { selection = { mode: "unchanged" }; },
  };
}

function graph(f: ReturnType<typeof fixture>, options: { approval?: boolean; artifactDenied?: boolean; enrolled?: () => boolean; saver?: MemorySaver; extraDeps?: PostModelDeps; actualTools?: boolean } = {}) {
  const policy = { checkToolAccess: async (_actorId: string, call: { name: string }) => options.artifactDenied && call.name === "share_artifact"
    ? { type: "forbidden", reason: "Artifact sharing unavailable" } : options.approval
    ? { type: "require_approval", route: { type: "prove_it", approvers: [userId] } }
    : { type: "allow" } } as unknown as PolicyResolver;
  return new StateGraph(NautiloStateAnnotation)
    .addNode("ordinary_preflight", createOrdinaryContentAccessPreflightNode(f.resolve,
      options.enrolled ? async () => options.enrolled!() : undefined))
    .addNode("post_model", createPostModelNode(policy, {
      ordinaryContentAccessForState: f.resolve,
      matchCommandApproval: async () => null,
      createCommandApproval: async () => ({ id: "standing", created: true }),
      ...(options.enrolled ? { isPinEnrolled: async () => options.enrolled!() } : {}),
      ...options.extraDeps,
    }))
    .addNode("execute", options.actualTools ? createToolsNode({ ordinaryContentAccessForState: f.resolve }) : async (state) => {
      for (const call of state.approvedToolCalls) await bindOrdinaryContentAccessExecution(
        state, call, state.ordinaryContentAccessBindings[call.id!], f.port,
      ).commit();
      return {};
    })
    .addEdge(START, "ordinary_preflight").addEdge("ordinary_preflight", "post_model")
    .addEdge("post_model", "execute").addEdge("execute", END)
    .compile({ checkpointer: options.saver ?? new MemorySaver() });
}
const config = { configurable: { thread_id: "ordinary-binding" } };

describe("ordinary content access checkpoint authority", () => {
  test("auto execution receives the checkpointed exact operation without a write during prepare", async () => {
    const f = fixture();
    await graph(f).invoke(input(), config);
    expect(f.prepared).toHaveLength(1);
    expect(f.commits).toHaveLength(1);
    expect(f.commits[0]).toEqual(f.prepared[0]);
  });

  test("prove-it restart reuses one preparation and exposes only its public preview", async () => {
    const f = fixture();
    const saver = new MemorySaver();
    const first = graph(f, { approval: true, saver });
    await first.invoke(input(), config);
    const checkpoint = await first.getState(config);
    expect(f.prepared).toHaveLength(1);
    expect(f.commits).toHaveLength(0);
    expect(JSON.stringify(checkpoint.tasks)).not.toContain("signed-");
    expect(JSON.stringify(checkpoint.tasks)).not.toContain(internalArtifactId);
    expect(JSON.stringify(checkpoint.tasks)).toContain("Source Room Humans and peer");
    await graph(f, { approval: true, saver }).invoke(new Command({ resume: { approved: true } }), config);
    expect(f.prepared).toHaveLength(1);
    expect(f.commits).toEqual(f.prepared);
  });

  test("PIN enrollment preserves exact preparation and requires following proof", async () => {
    const f = fixture();
    let enrolled = false;
    const saver = new MemorySaver();
    const options = { approval: true, enrolled: () => enrolled, saver };
    const g = graph(f, options);
    await g.invoke(input(), config);
    expect(JSON.stringify((await g.getState(config)).tasks)).toContain("enrollPin");
    enrolled = true;
    await graph(f, options).invoke(new Command({ resume: { verified: true }, update: { identityEnrollmentToolCallIds: ["call-1"] } }), config);
    expect(f.commits).toHaveLength(0);
    await graph(f, options).invoke(new Command({ resume: { approved: true } }), config);
    expect(f.prepared).toHaveLength(1);
    expect(f.commits).toHaveLength(1);
  });

  test("expired approval resumes to structured recovery without another prepare or commit", async () => {
    const f = fixture();
    f.expire();
    const g = graph(f, { approval: true });
    await g.invoke(input(), config);
    await g.invoke(new Command({ resume: { approved: true } }), config);
    const checkpoint = await g.getState(config);
    expect(f.prepared).toHaveLength(1);
    expect(f.commits).toHaveLength(0);
    const errors = (checkpoint.values as NautiloState).messages.filter((message) => ToolMessage.isInstance(message));
    expect(JSON.stringify(errors)).toContain("prepare_new_call");
  });

  test("policy selection drift invalidates the batch, with no protected fallback", async () => {
    const f = fixture();
    const g = graph(f, { approval: true });
    await g.invoke(input(), config);
    f.changeMode();
    await g.invoke(new Command({ resume: { approved: true } }), config);
    expect(f.prepared).toHaveLength(1);
    expect(f.commits).toHaveLength(0);
  });

  test("operation identity binds durable turn and message rather than model call id alone", () => {
    const state = input() as NautiloState;
    const call = (state.messages[0] as AIMessage).tool_calls![0]!;
    const identity = ordinaryShareExecutionIdentity(state, call)!;
    const id = ordinaryShareOperationId(identity, { kind: "artifact", id: artifactId }, 0);
    expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(ordinaryShareOperationId({ ...identity, turnId: "later" }, { kind: "artifact", id: artifactId }, 0)).not.toBe(id);
    expect(ordinaryShareOperationId({ ...identity, assistantMessageId: "later" }, { kind: "artifact", id: artifactId }, 0)).not.toBe(id);
    expect(ordinaryShareOperationId(identity, { kind: "artifact", id: artifactId }, 0)).toBe(id);
  });

  test("bound execution rejects changed call, principal and missing capability", async () => {
    const f = fixture();
    const state = input() as NautiloState;
    const update = await createOrdinaryContentAccessPreflightNode(f.resolve)(state);
    const preparedState = { ...state, ...update };
    const call = (preparedState.messages[0] as AIMessage).tool_calls![0]!;
    const binding = preparedState.ordinaryContentAccessBindings![call.id!]!;
    expect(matchesOrdinaryContentAccessBinding(preparedState, call, binding)).toBe(true);
    expect(matchesOrdinaryContentAccessBinding({ ...preparedState, userId: "other" }, call, binding)).toBe(false);
    expect((await bindOrdinaryContentAccessExecution(preparedState, { ...call, args: { ...call.args, target_handle: "other" } }, binding, f.port).commit()).status).toBe("error");
    expect((await bindOrdinaryContentAccessExecution(preparedState, call, binding, undefined).commit()).status).toBe("error");
    expect(f.commits).toHaveLength(0);
  });

  test("person and Room intents bind distinct commands and ask_peer freezes focused artifacts", async () => {
    const f = fixture();
    const preflight = createOrdinaryContentAccessPreflightNode(f.resolve);
    await preflight(input({ artifact_id: artifactId, target: { kind: "room", name: "Planning" }, sensitivity: "normal" }) as NautiloState);
    expect(f.prepared[0]!.command.change.kind).toBe("grant_room");
    const state = { ...input({ peer_handle: "peer", include_focused_artifacts: true, sensitivity: "normal" }, "ask_peer"),
      focusedResources: [{ kind: "workspace-artifact", locator: { artifactId } }] } as NautiloState;
    const prepared = { ...state, ...await preflight(state) };
    const binding = prepared.ordinaryContentAccessBindings!["call-1"]!;
    const changedFocus = { ...prepared, focusedResources: [] };
    const result = await bindOrdinaryContentAccessExecution(changedFocus, (state.messages[0] as AIMessage).tool_calls![0]!, binding, f.port).commit();
    expect(result.status).toBe("success");
    expect(result.peerActorId).toBe(recipientId);
    expect(result.artifacts.map((artifact) => artifact.artifactId)).toEqual([artifactId]);
    const malformed = { ...binding, prepared: { ...binding.prepared, operations: binding.prepared.operations.map((operation) => ({ ...operation,
      command: { ...operation.command, change: { kind: "grant_people" as const, selectedActorIds: [recipientId, actorId] } },
    })) } };
    const commitsBeforeInvalid = f.commits.length;
    expect((await bindOrdinaryContentAccessExecution(changedFocus, (state.messages[0] as AIMessage).tool_calls![0]!, malformed, f.port).commit()).status).toBe("error");
    expect(f.commits).toHaveLength(commitsBeforeInvalid);
    f.port.verifyPeerContact = async () => false;
    const revoked = await bindOrdinaryContentAccessExecution(changedFocus, (state.messages[0] as AIMessage).tool_calls![0]!, binding, f.port).commit();
    expect(revoked.status).toBe("error");
    expect(revoked.receipts).toHaveLength(1);
    expect(revoked.message).toContain("peer was not contacted");
    delete f.port.verifyPeerContact;
    expect((await bindOrdinaryContentAccessExecution(changedFocus, (state.messages[0] as AIMessage).tool_calls![0]!, binding, f.port).commit()).status).toBe("error");
    f.setOutcome("partial");
    expect((await bindOrdinaryContentAccessExecution(changedFocus, (state.messages[0] as AIMessage).tool_calls![0]!, binding, f.port).commit()).status).toBe("error");
  });

  test("ask_peer mixed prepared recipients are rejected before any grant", async () => {
    const f = fixture();
    const state = input({ peer_handle: "peer", artifact_ids: [artifactId, recipientId], sensitivity: "normal" }, "ask_peer") as NautiloState;
    const prepared = { ...state, ...await createOrdinaryContentAccessPreflightNode(f.resolve)(state) };
    const binding = prepared.ordinaryContentAccessBindings!["call-1"]!;
    const changed = { ...binding, prepared: { ...binding.prepared, operations: binding.prepared.operations.map((operation, index) => ({ ...operation,
      command: { ...operation.command, change: { kind: "grant_people" as const, selectedActorIds: [index === 0 ? recipientId : actorId] } },
    })) } };
    const result = await bindOrdinaryContentAccessExecution(prepared, (state.messages[0] as AIMessage).tool_calls![0]!, changed, f.port).commit();
    expect(result.status).toBe("error");
    expect(f.commits).toHaveLength(0);
  });

  test("ask reply consumes the exact preview and expiry cannot create a standing rule", async () => {
    const f = fixture();
    let standingWrites = 0;
    const g = graph(f, { approval: true, extraDeps: {
      createCommandApproval: async () => { standingWrites++; return { id: "rule", created: true }; },
      createCapabilityApproval: async () => { standingWrites++; return { id: "rule", created: true }; },
    } });
    f.expire();
    await g.invoke(input({ artifact_id: artifactId, target_handle: "peer", sensitivity: "normal" }), config);
    expect(JSON.stringify((await g.getState(config)).tasks)).toContain("approval_ask");
    await g.invoke(new Command({ resume: { approved: true, verb: "always" } }), config);
    expect(standingWrites).toBe(0);
    expect(f.commits).toHaveLength(0);
    expect(f.prepared).toHaveLength(1);
  });

  test("valid ask reply on a rebuilt graph uses the same prepared operation", async () => {
    const f = fixture();
    const saver = new MemorySaver();
    await graph(f, { approval: true, saver }).invoke(input({ artifact_id: artifactId, target_handle: "peer", sensitivity: "normal" }), config);
    await graph(f, { approval: true, saver }).invoke(new Command({ resume: { approved: true, verb: "once" } }), config);
    expect(f.prepared).toHaveLength(1);
    expect(f.commits).toEqual(f.prepared);
  });

  test("real tools node passes server capability, records error status, and prunes terminal binding", async () => {
    const f = fixture();
    f.setOutcome("partial");
    const g = graph(f, { actualTools: true });
    await g.invoke(input(), config);
    const state = (await g.getState(config)).values as NautiloState;
    expect(f.commits).toHaveLength(1);
    expect(state.ordinaryContentAccessBindings).toEqual({});
    expect(state.approvedToolCalls).toEqual([]);
    const result = state.messages.at(-1) as ToolMessage;
    expect(result.status).toBe("error");
    expect(result.additional_kwargs["nautilo_tool_status"]).toBe("error");
  });

  test("unknown outcome preserves failed node checkpoint for exact null-input retry", async () => {
    const f = fixture();
    f.failOnce();
    const saver = new MemorySaver();
    const g = graph(f, { actualTools: true, saver });
    const failure = await g.invoke(input(), config).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(OrdinaryContentAccessRetryRequiredError);
    const stopped = (await g.getState(config)).values as NautiloState;
    expect(stopped.approvedToolCalls).toHaveLength(1);
    expect(Object.keys(stopped.ordinaryContentAccessBindings ?? {})).toEqual(["call-1"]);
    await graph(f, { actualTools: true, saver }).invoke(null, config);
    expect(f.prepared).toHaveLength(1);
    expect(f.commits).toHaveLength(2);
    expect(f.commits[0]!.command.operationId).toBe(f.commits[1]!.command.operationId);
  });

  test("exposure follows fresh async mode selection, including absent plaintext capability", async () => {
    const state = input() as NautiloState;
    expect(await ordinaryContentAccessToolContextForState(state, async () => ({ mode: "plaintext_only" })))
      .toEqual({ ordinaryContentAccessRequired: true });
    expect(await ordinaryContentAccessToolContextForState(state, async () => ({ mode: "unchanged" })))
      .toEqual({ ordinaryContentAccessRequired: false });
    expect(await ordinaryContentAccessToolContextForState(state)).toEqual({ ordinaryContentAccessRequired: false });
  });

  test("ask_peer contact approval never substitutes for Artifact sharing admission", async () => {
    const f = fixture();
    const g = graph(f, { artifactDenied: true });
    await g.invoke(input({ peer_handle: "peer", artifact_ids: [artifactId], sensitivity: "normal" }, "ask_peer"), config);
    const state = (await g.getState(config)).values as NautiloState;
    expect(f.prepared).toHaveLength(1);
    expect(f.commits).toHaveLength(0);
    expect(state.approvedToolCalls).toEqual([]);
  });

  test("missing plaintext port denies preparation; unchanged mode leaves protected calls untouched", async () => {
    const state = input() as NautiloState;
    const missing = await createOrdinaryContentAccessPreflightNode(async () => ({ mode: "plaintext_only" }))(state);
    expect(missing.ordinaryContentAccessBindings).toEqual({});
    expect(missing.ordinaryContentAccessRejectedToolCallIds).toEqual(["call-1"]);
    const unchanged = await createOrdinaryContentAccessPreflightNode(async () => ({ mode: "unchanged" }))(state);
    expect(unchanged.messages).toBeUndefined();
    expect(unchanged.ordinaryContentAccessRejectedToolCallIds).toEqual([]);
  });

  test("unexpected preparation errors do not disclose database or content material", async () => {
    const f = fixture();
    f.port.prepare = async () => { throw new Error("private-body-and-db-query"); };
    const result = await createOrdinaryContentAccessPreflightNode(f.resolve)(input() as NautiloState);
    expect(JSON.stringify(result.messages)).not.toContain("private-body-and-db-query");
    expect(JSON.stringify(result.messages)).toContain("prepare_new_call");
  });

  test("mixed auto/ask layout drift cannot consume the old ask as a new prove-it", async () => {
    const f = fixture();
    let overrideActive = true;
    const saver = new MemorySaver();
    const options = { approval: true, saver, extraDeps: {
      resolveWorkstationApprovalOverride: (request: Parameters<NonNullable<PostModelDeps["resolveWorkstationApprovalOverride"]>>[0]) =>
        overrideActive && request.toolCall.id === "call-1"
          ? { override: "auto" as const, executionClass: "profile_bound_sandbox" as const }
          : { override: "none" as const, reason: "no_active_session" as const, detail: "No active session" },
    } };
    const state = input();
    const first = state.messages![0] as AIMessage;
    state.messages = [new AIMessage({ id: "assistant-message", content: "", tool_calls: [
      ...first.tool_calls!,
      { id: "call-2", name: "ask_peer", args: { peer_handle: "peer", message_to_peer: "Hello" } },
    ] })];
    const g = graph(f, options);
    await g.invoke(state, config);
    const checkpoint = await g.getState(config);
    expect(JSON.stringify(checkpoint.tasks)).toContain("approval_ask");
    expect(JSON.stringify(checkpoint.tasks)).not.toContain("prove_it_challenge");
    overrideActive = false;
    const resumed = graph(f, options);
    await resumed.invoke(new Command({ resume: { approved: true, verb: "once" } }), config);
    const result = await resumed.getState(config);
    expect(result.tasks).toEqual([]);
    expect(f.commits).toHaveLength(0);
    expect(f.prepared).toHaveLength(1);
    expect(JSON.stringify((result.values as NautiloState).messages)).toContain("content_access_approval_stale");
  });
});
