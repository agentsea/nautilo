import { setConfigOverrides } from "@nautilo/config";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { ToolCatalog, clearToolCatalog, initToolCatalog } from "@nautilo/catalog";
import {
  StrictShadowEnforcementError,
  type ProtectedAgentMemoryAccessPort,
  type ProtectedAgentMemoryProjectionPort,
  type ProtectedAgentMemoryRepository,
  type StrictShadowBoundaryDecision,
} from "@nautilo/lattice-bridge";
import { parseGuideUserResultV1, type ServerEvent } from "@nautilo/types";
import { z } from "zod";
import { RELAY_SSH_APPROVED_REQUEST_VERSION } from "@nautilo/relay";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import * as trust from "@nautilo/trust";
import type { NautiloState } from "../../src/agent/state";
import { browserDecisionPlanSchema } from "../../src/graph/browser-decision";
import { configureRuntimeModelCatalog, resetRuntimeModelCatalog } from "../../src/config/model-catalog/runtime-catalog";
import { createControlConnectedWebOperationTool } from "../../src/tools/connected-web-accounts/control-connected-web-operation";
import { defaultPostModelDeps } from "../../src/agent/post-model-deps";
import { bindProtectedMemoryResumeDeps } from
  "../../src/graph/protected-memory-resume-deps";
import {
  normalizeAdmittedToolCalls,
  toolsNode,
} from "../../src/nodes/tools";
import { setAgentEventSink } from "../../src/runtime-hooks";
import {
  createNautiloToolInvocationSession,
  createServerToolInvocationContext,
  classifyStructuredSshHumanApproval,
  classifyStructuredSshPreparationRefresh,
  normalizeFileProviderArgs,
  resolveStructuredSshHumanApprovalReplay,
  setRelayRegistry,
  shouldAutoApproveStructuredSsh,
  structuredSshPrepareFailureGuidance,
  type NautiloToolInvocationCall,
  type NautiloToolInvocationServerContext,
  type ToolRelayRegistry,
} from "../../src/tools/invocation-service";
import { fileToolError } from "../../src/tools/file/file-result-status";
import { createManageMemoryTool } from "../../src/tools/memory/manage-memory";
import { createSearchMemoryTool } from "../../src/tools/memory/search-memory";
import {
  computeShareMemoryApprovalPreview,
  createShareMemoryTool,
} from "../../src/tools/memory/share-memory";
import { bindProtectedProjectionReference } from
  "../../src/tools/memory/projection-sharing";
import * as shareApprovalPreview from
  "../../src/post-model/share-approval-preview";
import * as memoryStore from "../../src/store/memory-store";
import { createManageConnectedWebOperationTool } from "../../src/tools/connected-web-accounts/manage-connected-web-operation";
import {
  resetConnectedWebAccountReadToolRuntimeForTests,
  setConnectedWebOperationToolRuntime,
  setConnectedWebOperationDirectToolRuntime,
  type ConnectedWebOperationDirectControlOptions,
} from "../../src/tools/connected-web-accounts/runtime";
import { registerAllTools } from "../../src/tools/register-all";
import { runWithInitiatingClientSurface } from "../../src/runtime/initiating-client-surface-context";
import { setOrdinaryHostResolver } from "../../src/runtime/ordinary-host-resolver";
import { getRequiredOrdinaryHostContext } from "../../src/runtime/ordinary-host-dispatch-context";
import { describeResearchContextIndex, describeResearchContextMessage } from "../../src/tools/security/research-context";

let initialOpenRouterKey: string | undefined;
beforeEach(() => { initialOpenRouterKey = process.env["OPENROUTER_API_KEY"]; });

afterEach(() => {
  if (initialOpenRouterKey === undefined) delete process.env["OPENROUTER_API_KEY"];
  else process.env["OPENROUTER_API_KEY"] = initialOpenRouterKey;
  resetRuntimeModelCatalog();
  setAgentEventSink(null);
  setRelayRegistry(null);
  setOrdinaryHostResolver(null);
  resetConnectedWebAccountReadToolRuntimeForTests();
  delete defaultPostModelDeps.resolveUncontainedHostCommandsDispatch;
  clearToolCatalog();
});

describe("provider file-argument compatibility", () => {
  test("recovers only GLM's read-only grep glob marker encoding", () => {
    expect(normalizeFileProviderArgs({
      command: "grep<arg_key>glob</arg_key><arg_value>*.{ts,tsx,mjs,json,md}",
      path: ".",
      query: "SERVICE_TOKEN",
      zone: "current",
    })).toEqual({
      command: "grep",
      glob: "*.{ts,tsx,mjs,json,md}",
      path: ".",
      query: "SERVICE_TOKEN",
      zone: "current",
    });
    expect(normalizeFileProviderArgs({
      command: "write<arg_key>path</arg_key><arg_value>owned.ts",
      content: "x",
      zone: "current",
    })).toEqual({
      command: "write<arg_key>path</arg_key><arg_value>owned.ts",
      content: "x",
      zone: "current",
    });
    expect(normalizeFileProviderArgs({
      command: "grep<arg_key>glob</arg_key><arg_value>*.ts",
      glob: "*.js",
      query: "token",
    })).toEqual({
      command: "grep<arg_key>glob</arg_key><arg_value>*.ts",
      glob: "*.js",
      query: "token",
    });
    expect(normalizeFileProviderArgs({
      command: "grep<arg_key>query</arg_key><arg_value>hasDocumentAccess|hasProjectAccess",
      path: "apps/web/app/api",
      zone: "current",
    })).toEqual({
      command: "grep",
      path: "apps/web/app/api",
      query: "hasDocumentAccess|hasProjectAccess",
      zone: "current",
    });
    expect(normalizeFileProviderArgs({
      command: "grep<arg_key><arg_key>path</arg_key><arg_value>packages/agent-runtime/src",
      query: "ensureThread|workspaceId",
      zone: "current",
    })).toEqual({
      command: "grep",
      path: "packages/agent-runtime/src",
      query: "ensureThread|workspaceId",
      zone: "current",
    });
    expect(normalizeFileProviderArgs({
      command: "read<arg_key><arg_key>path</arg_key><arg_value>src/auth.ts",
      zone: "current",
      lineRange: { startLine: 1, endLine: 20 },
    })).toEqual({
      command: "read",
      path: "src/auth.ts",
      zone: "current",
      lineRange: { from: 1, to: 20 },
    });
    expect(normalizeFileProviderArgs({
      command: "grep<arg_key>query</arg_key><arg_value>injected",
      path: ".",
      query: "trusted",
      zone: "current",
    })).toEqual({
      command: "grep<arg_key>query</arg_key><arg_value>injected",
      path: ".",
      query: "trusted",
      zone: "current",
    });
    const conflictingPath = {
      command: "grep<arg_key><arg_key>path</arg_key><arg_value>packages/agent-runtime/src",
      path: "services/ai/src",
      query: "ensureThread|workspaceId",
      zone: "current",
    };
    expect(normalizeFileProviderArgs(conflictingPath)).toEqual(conflictingPath);
    const mutationMarker = {
      command: "write<arg_key>path</arg_key><arg_value>src/auth.ts",
      content: "unsafe",
      zone: "current",
    };
    expect(normalizeFileProviderArgs(mutationMarker)).toEqual(mutationMarker);
  });

  test("normalizes security citation line aliases only on read-only calls", () => {
    expect(normalizeFileProviderArgs({
      command: "read",
      path: "src/auth.ts",
      zone: "current",
      lineRange: { from: 1, endLine: 80 },
    })).toEqual({
      command: "read",
      path: "src/auth.ts",
      zone: "current",
      lineRange: { from: 1, to: 80 },
    });
    expect(normalizeFileProviderArgs({
      command: "grep",
      path: ".",
      zone: "current",
      query: "token",
      lineRange: { startLine: 10, endLine: 20 },
    })).toEqual({
      command: "grep",
      path: ".",
      zone: "current",
      query: "token",
      lineRange: { from: 10, to: 20 },
    });
    expect(normalizeFileProviderArgs({
      command: "read",
      path: "package.json",
      zone: "current",
      lineRange: { from: 0, to: 70 },
    })).toEqual({
      command: "read",
      path: "package.json",
      zone: "current",
      lineRange: { from: 1, to: 70 },
    });
    const mutation = {
      command: "str_replace",
      path: "src/auth.ts",
      zone: "current",
      lineRange: { startLine: 10, endLine: 20 },
      newString: "x",
    };
    expect(normalizeFileProviderArgs(mutation)).toEqual(mutation);
  });
});

describe("paired-mobile conditional host execution context", () => {
  test("revalidates the selected host and binds its private roots for file execution", async () => {
    const catalog = new ToolCatalog();
    catalog.register({
      name: "file",
      exposure: "core",
      category: "development",
      trustTier: "guest",
      impact: "read-only",
      executor: "cloud",
      resultScanPolicy: "never",
      factory: () => new DynamicStructuredTool({
        name: "file",
        description: "paired-mobile execution-context fixture",
        schema: z.object({ command: z.string(), zone: z.string(), path: z.string() }),
        func: async () => JSON.stringify(getRequiredOrdinaryHostContext()),
      }),
    });
    initToolCatalog(catalog);
    let resolutionCalls = 0;
    setOrdinaryHostResolver({
      resolve: async () => {
        resolutionCalls += 1;
        return {
          status: "selected",
          host: {
            relayId: "relay-mobile",
            bindingId: "binding-mobile",
            pairingGeneration: "generation-mobile",
            desktopSessionId: "desktop-session-mobile",
            capabilityRevision: 7,
            workspaceRoot: "/path/to/user",
            currentFolderRoot: "/path/to/project",
          },
        };
      },
    });
    const callId = "call-file-current";
    const context = createServerToolInvocationContext(state({
      activatedToolNames: ["file"],
      requiredHostRelays: { [callId]: "relay-mobile" },
      verifiedOrdinaryOrigin: {
        kind: "paired_mobile",
        serverInstanceId: "server-1",
        serverBindingGeneration: 1,
        userId: "owner",
        actorId: "owner",
        controllerInstallationId: "controller-1",
        installationGeneration: 1,
        requestId: "request-1",
      },
    }), () => ({ status: "allowed" }));

    const result = await createNautiloToolInvocationSession(context).invoke({
      callId,
      toolName: "file",
      args: { command: "list", zone: "current", path: "." },
      authorityRef: "receipt-file-current",
    });

    expect(result.status).toBe("success");
    expect(resolutionCalls).toBe(1);
    expect(result.content).toContain('"relayId":"relay-mobile"');
    expect(result.content).toContain('"currentFolderRoot":"/path/to/project"');
    expect(result.content).toContain('"workspaceRoot":"/path/to/user"');
  });
});

describe("live mini-app tool execution context", () => {
  test("carries the trusted session and exact tool-call correlation into the executing factory", async () => {
    const catalog = new ToolCatalog();
    let capturedContext: unknown = null;
    catalog.register({
      name: "live-design-fixture",
      exposure: "core",
      category: "documents",
      trustTier: "standard",
      impact: "read-only",
      executor: "cloud",
      resultScanPolicy: "never",
      factory: (context) => {
        capturedContext = context;
        return new DynamicStructuredTool({
          name: "live-design-fixture",
          description: "trusted live Design context fixture",
          schema: z.object({}),
          func: async () => "ok",
        });
      },
    });
    initToolCatalog(catalog);
    const liveMiniAppSession = {
      appId: "nautilo-design",
      sessionToken: "trusted-live-session-token",
      sessionId: "trusted-live-session-id",
      documentVersion: { kind: "artifact_revision" as const, revision: 4 },
      instructions: "Inspect before editing.",
    };
    const context = createServerToolInvocationContext(
      state({ liveMiniAppSession }),
      () => ({ status: "allowed" }),
    );

    const result = await createNautiloToolInvocationSession(context).invoke({
      callId: "design-tool-call-1",
      toolName: "live-design-fixture",
      args: {},
      authorityRef: "receipt-live-design-fixture",
    });

    expect(result.status).toBe("success");
    const captured = capturedContext as Record<string, unknown>;
    expect(captured["toolCallId"]).toBe("design-tool-call-1");
    expect(captured["liveMiniAppSession"]).toEqual(liveMiniAppSession);
  });
});

describe("connected website operation execution context", () => {
  test("passes actual invocation arguments and cancellation authority into the connected decision driver", async () => {
    const priorKey = process.env["OPENROUTER_API_KEY"];
    process.env["OPENROUTER_API_KEY"] = "synthetic-connected-key";
    configureRuntimeModelCatalog({ catalogPointerUrl: null });
    try {
      const catalog = new ToolCatalog();
      catalog.register({ name: "control_connected_web_operation", exposure: "core", category: "integrations",
        trustTier: "high", impact: "low", executor: "cloud", resultScanPolicy: "always",
        factory: context => createControlConnectedWebOperationTool(context) });
      initToolCatalog(catalog);
      const captures: ConnectedWebOperationDirectControlOptions[] = [];
      let fail = false;
      setConnectedWebOperationDirectToolRuntime({ control: async (_actor, input, options) => {
        captures.push(options ?? {});
        if (fail) return { ok: false, code: "conflict", recovery: "none", browserFailure: "browser_observation_stale", detail: "Page changed before click." };
        return { ok: true, command: { text: "observed", truncated: false }, operation: {
          operationId: input.operationId, controlEpoch: input.expectedControlEpoch, driver: "direct", lifecycle: "running",
          activity: { phase: "working", code: "observed", summary: "Observed current page." }, receipt: null,
        } };
      } });
      const controller = new AbortController();
      const request = call("control_connected_web_operation", {
        operationId: "77777777-7777-4777-8777-777777777777", expectedControlEpoch: 3,
        command: { kind: "snapshot" }, decisionPlan: { goal: "Open details" },
      });
      const sourceCall = { id: request.callId, name: request.toolName, args: request.args };
      const invocationState = state({ currentThreadId: "thread-connected",
        messages: [new AIMessage({ content: "", tool_calls: [sourceCall] })],
        memoryAccessEnvelope: { ownerId: "owner", actorId: "owner", agentId: "agent", roomId: "room",
          readableNamespaces: [], mutableNamespaces: [], writableNamespaces: [], toolPolicy: {} },
      });
      const invoke = (input = request) => createNautiloToolInvocationSession(
        createServerToolInvocationContext(invocationState, () => ({ status: "allowed" })),
        { signal: controller.signal },
      ).invoke(input);
      expect((await invoke()).status).toBe("success");
      expect(captures[0]?.signal).toBe(controller.signal);
      expect(captures[0]?.decision).toEqual({ kind: "observe" });
      const action = { ...request, args: { operationId: request.args["operationId"], expectedControlEpoch: 3,
        command: { kind: "click", ref: "@e1" } } };
      invocationState.browserDecision = {
        turnId: "turn", modelId: "openrouter:typesafe/jev-1.13", phase: "waiting", reason: null,
        target: { kind: "connected_web", operationId: String(request.args["operationId"]), controlEpoch: 3 },
        plan: browserDecisionPlanSchema.parse({ goal: "Open details" }), observation: null,
        pending: { call: { id: action.callId, name: action.toolName, args: action.args }, browserSessionId: "browser", observationId: "fresh-observation" },
      };
      expect((await invoke(action)).status).toBe("success");
      expect(captures[1]?.signal).toBe(controller.signal);
      expect(captures[1]?.decision).toEqual({ kind: "act", observationId: "fresh-observation" });
      expect((await invoke({ ...action, args: { ...action.args, command: { kind: "click", ref: "@e2" } } })).status).toBe("error");
      expect(captures).toHaveLength(2);
      fail = true;
      const stale = await invoke(action);
      expect(stale.status).toBe("error");
      expect(stale.additionalKwargs?.["nautilo_browser_failure"]).toBe("browser_observation_stale");
      expect(stale.content).toContain("Page changed before click.");
      controller.abort();
      expect((await invoke(action)).status).toBe("error");
      expect(captures).toHaveLength(3);
    } finally {
      if (priorKey === undefined) delete process.env["OPENROUTER_API_KEY"];
      else process.env["OPENROUTER_API_KEY"] = priorKey;
      setConfigOverrides({});
      resetRuntimeModelCatalog();
    }
  });

  test("injects exact foreground thread, turn, tool call, and resolved lane into the real management factory", async () => {
    const catalog = new ToolCatalog();
    catalog.register({
      name: "manage_connected_web_operation",
      exposure: "core",
      category: "integrations",
      trustTier: "high",
      impact: "destructive",
      executor: "cloud",
      resultScanPolicy: "never",
      factory: (context) => createManageConnectedWebOperationTool(context),
    });
    initToolCatalog(catalog);
    const capturedActors: Array<Record<string, unknown>> = [];
    setConnectedWebOperationToolRuntime({
      async manage(actor, input) {
        capturedActors.push(actor as unknown as Record<string, unknown>);
        return {
          ok: true,
          accepted: input.operation,
          operation: {
            operationId: input.operationId,
            driver: "hosted",
            lifecycle: "running",
            controlEpoch: input.expectedControlEpoch,
            activity: { phase: "working", code: "running", summary: "Working." },
            receipt: null,
          },
        };
      },
    });
    const memoryAccessEnvelope: MemoryAccessEnvelope = {
      ownerId: "owner-connected-web",
      actorId: "owner-connected-web",
      agentId: "agent-connected-web",
      roomId: "room-connected-web",
      readableNamespaces: [],
      mutableNamespaces: [],
      writableNamespaces: [],
      toolPolicy: {},
    };
    const context = createServerToolInvocationContext(state({
      userId: "owner-connected-web",
      agentId: "agent-connected-web",
      roomId: "room-connected-web",
      currentThreadId: "graph-thread-connected-web",
      turnId: "turn-connected-web",
      memoryAccessEnvelope,
      activatedToolNames: ["manage_connected_web_operation"],
    }), () => ({ status: "allowed" }));

    const result = await createNautiloToolInvocationSession(context).invoke({
      callId: "tool-call-connected-web",
      toolName: "manage_connected_web_operation",
      args: {
        operation: "inspect",
        operationId: "77777777-7777-4777-8777-777777777777",
        expectedControlEpoch: 3,
      },
      authorityRef: "receipt-connected-web",
    });

    expect(result.status).toBe("success");
    expect(capturedActors).toHaveLength(1);
    expect(capturedActors[0]?.["userId"]).toBe("owner-connected-web");
    expect(capturedActors[0]?.["agentId"]).toBe("agent-connected-web");
    expect(capturedActors[0]?.["roomId"]).toBe("room-connected-web");
    expect(capturedActors[0]?.["currentThreadId"]).toBe("graph-thread-connected-web");
    expect(capturedActors[0]?.["turnId"]).toBe("turn-connected-web");
    expect(capturedActors[0]?.["toolCallId"]).toBe("tool-call-connected-web");
    expect(capturedActors[0]?.["laneKey"]).toBe("room:room-connected-web");
  });
});

describe("focused-resource tool execution context", () => {
  test("carries the authoritative turn manifest into the executing factory", async () => {
    const catalog = new ToolCatalog();
    let capturedContext: unknown = null;
    catalog.register({
      name: "focused-resource-fixture",
      exposure: "core",
      category: "documents",
      trustTier: "standard",
      impact: "read-only",
      executor: "cloud",
      resultScanPolicy: "never",
      factory: (context) => {
        capturedContext = context;
        return new DynamicStructuredTool({
          name: "focused-resource-fixture",
          description: "focused-resource execution-context fixture",
          schema: z.object({}),
          func: async () => "ok",
        });
      },
    });
    initToolCatalog(catalog);
    const focusedResources = [{
      kind: "workspace-artifact" as const,
      displayName: "plan.md",
      location: "server" as const,
      lifetime: "workspace" as const,
      capabilities: ["read" as const],
      locator: { artifactId: "artifact-public-id" },
      toolTarget: { tool: "file" as const, zone: "workspace" as const, path: "plan.md" },
    }];
    const context = createServerToolInvocationContext(
      state({ focusedResources }),
      () => ({ status: "allowed" }),
    );

    const result = await createNautiloToolInvocationSession(context).invoke({
      callId: "focused-resource-tool-call-1",
      toolName: "focused-resource-fixture",
      args: {},
      authorityRef: "receipt-focused-resource-fixture",
    });

    expect(result.status).toBe("success");
    expect((capturedContext as Record<string, unknown>)["focusedResources"]).toEqual(
      focusedResources,
    );
  });
});

describe(" uncontained host-command dispatch", () => {
  function registerRunShellFixture(): void {
    const catalog = new ToolCatalog();
    catalog.register({
      name: "run_shell",
      exposure: "core",
      category: "development",
      trustTier: "admin",
      impact: "low",
      executor: "relay",
      resultScanPolicy: "never",
      factory: () => new DynamicStructuredTool({
        name: "run_shell",
        description: "fixture",
        schema: z.object({ command: z.string() }),
        func: async () => "must dispatch through relay",
      }),
    });
    initToolCatalog(catalog);
  }

  function runShellState(args: Record<string, unknown>): NautiloState {
    return state({
      approvedToolCalls: [{ id: "call-run_shell", name: "run_shell", args, type: "tool_call" }],
      trustedExecutionEntrypoint: "foreground.main",
      requiredHostRelays: { "call-run_shell": "relay-local" },
      verifiedOrdinaryOrigin: {
        kind: "local_electron",
        userId: "owner",
        actorId: "actor-local",
        relayId: "relay-local",
        desktopSessionId: "desktop-local",
        pairingGeneration: "pairing-local",
        requestId: "request-local",
      },
    });
  }

  function relayFixture(captured: { request?: Parameters<ToolRelayRegistry["dispatch"]>[1] }): ToolRelayRegistry {
    return {
      findByCapabilityForUser: () => ["relay-local"],
      getCapabilities: () => ({
        profile: "desktop-agent",
        canReadWorkspace: true,
        canRunShell: true,
        allowedRoots: ["/tmp"],
        securityLevel: "standard",
      }),
      dispatch: async (_relayId, request) => {
        captured.request = request;
        return { status: "ok", result: "mocked" };
      },
    } as ToolRelayRegistry;
  }

  test("routes an ordinary foreground command only after the injected live resolver admits it", async () => {
    registerRunShellFixture();
    const captured: { request?: Parameters<ToolRelayRegistry["dispatch"]>[1] } = {};
    setRelayRegistry(relayFixture(captured));
    defaultPostModelDeps.resolveUncontainedHostCommandsDispatch = async (request) => {
      expect(request.foregroundLocalElectron.desktopSessionId).toBe("desktop-local");
      return {
        admitted: true,
        executionClass: "real_workstation",
        activationSignal: new AbortController().signal,
      };
    };

    await toolsNode(runShellState({ command: "pwd" }));

    expect(captured.request).toMatchObject({
      executionClass: "real_workstation",
      uncontainedHostCommandsSession: true,
    });
    expect(captured.request?.args).toEqual({ command: "pwd", execution: "workstation" });
  });

  test("keeps an explicit Full Workstation call on its existing independently authorized lane", async () => {
    registerRunShellFixture();
    const captured: { request?: Parameters<ToolRelayRegistry["dispatch"]>[1] } = {};
    setRelayRegistry(relayFixture(captured));
    let resolverCalls = 0;
    defaultPostModelDeps.resolveUncontainedHostCommandsDispatch = async () => {
      resolverCalls += 1;
      return { admitted: false, reason: "session_inactive" };
    };

    await toolsNode(runShellState({ command: "pwd", execution: "workstation" }));

    expect(resolverCalls).toBe(0);
    expect(captured.request?.executionClass).toBe("real_workstation");
    expect(captured.request?.uncontainedHostCommandsSession).toBeUndefined();
    expect(captured.request?.args).toEqual({ command: "pwd", execution: "workstation" });
  });

  test("fences a successful receipt that races a revoked activation without changing inactive dispatch", async () => {
    registerRunShellFixture();
    const activation = new AbortController();
    const captured: { request?: Parameters<ToolRelayRegistry["dispatch"]>[1] } = {};
    setRelayRegistry({
      ...relayFixture(captured),
      dispatch: async (_relayId, request) => {
        captured.request = request;
        activation.abort();
        return { status: "ok", result: "raced-success" };
      },
    });
    defaultPostModelDeps.resolveUncontainedHostCommandsDispatch = async () => ({
      admitted: true,
      executionClass: "real_workstation",
      activationSignal: activation.signal,
    });

    const output = await toolsNode(runShellState({ command: "echo harmless" }));

    expect(captured.request?.executionClass).toBe("real_workstation");
    expect(captured.request?.signal?.aborted).toBe(true);
    const message = output.messages?.[0] as ToolMessage | undefined;
    expect(typeof message?.content === "string" ? message.content : "").toContain(
      "effects may have occurred",
    );
    expect(typeof message?.content === "string" ? message.content : "").not.toContain("raced-success");
  });

  test("keeps a pre-dispatch activation revoke on the known-cancellation path", async () => {
    registerRunShellFixture();
    const activation = new AbortController();
    activation.abort();
    const captured: { request?: Parameters<ToolRelayRegistry["dispatch"]>[1] } = {};
    setRelayRegistry({
      ...relayFixture(captured),
      dispatch: async (_relayId, request) => {
        captured.request = request;
        if (request.signal?.aborted) throw new Error("Dispatch cancelled");
        return { status: "ok", result: "must-not-run" };
      },
    });
    defaultPostModelDeps.resolveUncontainedHostCommandsDispatch = async () => ({
      admitted: true,
      executionClass: "real_workstation",
      activationSignal: activation.signal,
    });

    const output = await toolsNode(runShellState({ command: "echo harmless" }));

    expect(captured.request?.signal?.aborted).toBe(true);
    const message = output.messages?.[0] as ToolMessage | undefined;
    const content = typeof message?.content === "string" ? message.content : "";
    expect(content).toContain("Dispatch cancelled");
    expect(content).not.toContain("effects may have occurred");
  });
});

describe("guide_user trusted presentation provenance", () => {
  test.each([
    ["foreground.main", "reveal"],
    ["background.task", "link"],
    [null, "link"],
  ] as const)("records %s provenance as durable %s guidance without client transport", async (entrypoint, presentation) => {
    const catalog = new ToolCatalog();
    registerAllTools(catalog);
    initToolCatalog(catalog);
    const context = createServerToolInvocationContext(
      state({
        trustedExecutionEntrypoint: entrypoint,
        activatedToolNames: ["guide_user"],
      }),
      () => ({ status: "allowed" }),
    );
    const result = await createNautiloToolInvocationSession(context).invoke(call("guide_user", {
      version: 1,
      target: "connections.google",
      presentation: "reveal",
      confirmed: true,
    }));
    expect(result.status).toBe("success");
    if (typeof result.content !== "string") throw new Error("guide_user returned a non-string result");
    expect(parseGuideUserResultV1(JSON.parse(result.content) as unknown)).toMatchObject({
      kind: "guidance",
      target: "connections.google",
      presentation,
    });
  });

  test("uses the execution-local mobile surface rather than model-call arguments", async () => {
    const catalog = new ToolCatalog();
    registerAllTools(catalog);
    initToolCatalog(catalog);
    const context = createServerToolInvocationContext(
      state({ trustedExecutionEntrypoint: "foreground.main", activatedToolNames: ["guide_user"] }),
      () => ({ status: "allowed" }),
    );
    const result = await runWithInitiatingClientSurface("mobile.web", () =>
      createNautiloToolInvocationSession(context).invoke(call("guide_user", {
        version: 1, target: "connections.google", presentation: "reveal", confirmed: true,
      })),
    );
    if (typeof result.content !== "string") throw new Error("guide_user returned a non-string result");
    expect(parseGuideUserResultV1(JSON.parse(result.content) as unknown)).toMatchObject({
      kind: "guidance", presentation: "link",
    });
  });
});

describe("structured SSH connection recovery guidance", () => {
  test("distinguishes missing, ambiguous, and unreadable connection facts without suggesting a grant or local-user fallback", () => {
    expect(structuredSshPrepareFailureGuidance("connection_not_found")).toContain("No complete authoritative local SSH connection");
    expect(structuredSshPrepareFailureGuidance("remote_user_missing")).toContain("no authoritative remote username");
    expect(structuredSshPrepareFailureGuidance("remote_user_missing")).toContain("Do not use the local workstation username");
    expect(structuredSshPrepareFailureGuidance("connection_ambiguous")).toContain("More than one authoritative local SSH connection");
    expect(structuredSshPrepareFailureGuidance("connection_catalog_unavailable")).toContain("No SSH connection was attempted");
    expect(structuredSshPrepareFailureGuidance("destination_unavailable")).toBeNull();
    for (const code of ["connection_not_found", "remote_user_missing", "connection_ambiguous", "connection_catalog_unavailable"]) {
      expect(structuredSshPrepareFailureGuidance(code)).not.toContain("grant");
    }
  });

  test("keeps trust-preparation phases and bounded timeout reasons distinct from lost authority", () => {
    const store = structuredSshPrepareFailureGuidance("trust_store_unavailable", {
      code: "trust_store_unavailable",
      phase: "trust_store_lookup",
      retrySafe: true,
      sideEffectStarted: false,
      stateChanged: false,
      recovery: "retry",
    });
    expect(store).toContain("trust-store lookup (trust_store_unavailable)");
    expect(store).toContain("Retrying is safe");

    const scan = structuredSshPrepareFailureGuidance("scan_timed_out", {
      code: "scan_timed_out",
      phase: "host_key_scan",
      retrySafe: true,
      sideEffectStarted: false,
      stateChanged: false,
      recovery: "retry",
    });
    expect(scan).toContain("host-key scan timed out after about 5 seconds (scan_timed_out)");

    const knownHosts = structuredSshPrepareFailureGuidance("lookup_timed_out", {
      code: "lookup_timed_out",
      phase: "known_hosts_lookup",
      retrySafe: true,
      sideEffectStarted: false,
      stateChanged: false,
      recovery: "retry",
    });
    expect(knownHosts).toContain("known_hosts lookup timed out after about 5 seconds (lookup_timed_out)");

    for (const guidance of [store, scan, knownHosts]) {
      expect(guidance).not.toContain("trust_unavailable");
      expect(guidance).not.toContain("capability");
      expect(guidance).not.toContain("expired");
    }
  });
});

describe("structured SSH exact approval replay", () => {
  test("session Auto-Approve bypasses review only for an already-trusted host", () => {
    expect(shouldAutoApproveStructuredSsh(true, "trusted")).toBe(true);
    expect(shouldAutoApproveStructuredSsh(false, "trusted")).toBe(false);
    expect(shouldAutoApproveStructuredSsh(undefined, "trusted")).toBe(false);
    expect(shouldAutoApproveStructuredSsh(true, "unknown")).toBe(false);
    expect(shouldAutoApproveStructuredSsh(true, "changed")).toBe(false);
  });

  test("reparks a prior call's approved receipt without accepting it, while an explicit denial remains denied", () => {
    const priorApprovedReceipt = {
      approved: true,
      verb: "once",
      structuredSshApprovalId: "ssh-approval-prior",
    };
    const currentApprovedReceipt = {
      approved: true,
      verb: "once",
      structuredSshApprovalId: "ssh-approval-current",
    };
    expect(classifyStructuredSshHumanApproval("ssh-approval-current", priorApprovedReceipt)).toBe("repark");

    let reparkAttempts = 0;
    expect(resolveStructuredSshHumanApprovalReplay(() => {
      reparkAttempts += 1;
      return classifyStructuredSshHumanApproval(
        "ssh-approval-current",
        reparkAttempts === 1 ? priorApprovedReceipt : currentApprovedReceipt,
      );
    })).toBe("approved");
    expect(reparkAttempts).toBe(2);

    let denialAttempts = 0;
    expect(resolveStructuredSshHumanApprovalReplay(() => {
      denialAttempts += 1;
      return classifyStructuredSshHumanApproval("ssh-approval-current", {
        approved: false,
        verb: "deny",
        structuredSshApprovalId: "ssh-approval-current",
      });
    })).toBe("denied");
    expect(denialAttempts).toBe(1);
  });

  test("uses a fresh one-use preparation without another review only when every reviewed fact and binding is unchanged", () => {
    const approved = structuredSshPrepareResponse("ssh-preparation-reviewed");
    const fresh = structuredSshPrepareResponse("ssh-preparation-fresh");

    expect(classifyStructuredSshPreparationRefresh(approved, fresh)).toBe("unchanged");
  });

  test("refuses the old review and requires a new exact review when the refreshed summary changes", () => {
    const approved = structuredSshPrepareResponse("ssh-preparation-reviewed");
    const changedFingerprint = structuredSshPrepareResponse("ssh-preparation-fresh", {
      approval: {
        ...approved.approval,
        hostKeyFingerprint: "SHA256:BBBBBBBBBBBBBBBBBBBB",
        hostTrust: "unknown",
      },
    });

    expect(classifyStructuredSshPreparationRefresh(approved, changedFingerprint)).toBe("review_required");
  });
});

function state(overrides: Partial<NautiloState> = {}): NautiloState {
  return {
    messages: [],
    approvedToolCalls: [],
    actorRole: "owner",
    userId: "owner",
    personaId: "owner",
    turnId: "turn",
    agentId: "agent",
    roomId: "room",
    activatedToolNames: [],
    activatedToolLeases: [],
    engagedSkillNames: [],
    memoryAccessEnvelope: null,
    relayCapabilities: {},
    ...overrides,
  } as unknown as NautiloState;
}

function register(
  name: string,
  invoke: (args: Record<string, unknown>) => Promise<string>,
  exposure: "core" | "discoverable" = "core",
): void {
  const catalog = new ToolCatalog();
  catalog.register({
    name,
    exposure,
    category: "development",
    trustTier: "guest",
    impact: "read-only",
    executor: "cloud",
    resultScanPolicy: "never",
    factory: () =>
      new DynamicStructuredTool({
        name,
        description: `invocation fixture ${name}`,
        schema: z.record(z.string(), z.unknown()),
        func: invoke,
      }),
  });
  initToolCatalog(catalog);
}

function call(
  toolName: string,
  args: Record<string, unknown> = {},
): NautiloToolInvocationCall {
  return {
    callId: `call-${toolName}`,
    toolName,
    args,
    authorityRef: `receipt-${toolName}`,
  };
}

function protectedMemoryRepository(
  overrides: Partial<ProtectedAgentMemoryRepository> = {},
): ProtectedAgentMemoryRepository {
  return {
    search: async () => ({ status: "success", value: [] }),
    save: async () => ({
      status: "success",
      value: { id: "memory-protected", action: "created" },
    }),
    replace: async () => ({ status: "success", value: undefined }),
    setTier: async () => ({ status: "success", value: undefined }),
    ...overrides,
  };
}

function registerProtectedMemoryTools(): void {
  const catalog = new ToolCatalog();
  catalog.register({
    name: "manage_memory",
    exposure: "core",
    category: "knowledge",
    trustTier: "standard",
    impact: "low",
    fullEncryptionSupport: "supported",
    executor: "cloud",
    resultScanPolicy: "never",
    factory: (context) => createManageMemoryTool(context),
  });
  catalog.register({
    name: "search_memory",
    exposure: "core",
    category: "knowledge",
    trustTier: "standard",
    impact: "read-only",
    fullEncryptionSupport: "supported",
    executor: "cloud",
    resultScanPolicy: "never",
    factory: (context) => createSearchMemoryTool(context),
  });
  initToolCatalog(catalog);
}

function registerShareMemoryProjectionTool(): void {
  const catalog = new ToolCatalog();
  catalog.register({
    name: "share_memory",
    exposure: "core",
    category: "knowledge",
    trustTier: "standard",
    impact: "high",
    fullEncryptionSupport: "supported",
    executor: "cloud",
    resultScanPolicy: "never",
    factory: (context) => createShareMemoryTool(context),
  });
  initToolCatalog(catalog);
}

function protectedMemoryState(): NautiloState {
  return state({
    memoryAccessEnvelope: {
      memoryMode: "namespace",
      ownerId: "user-alice",
      actorId: "actor-alice",
      agentId: "agent-genie",
      roomId: "room-ab",
      readableNamespaces: ["namespace-ab"],
      mutableNamespaces: ["namespace-ab"],
      writableNamespaces: ["namespace-ab"],
      toolPolicy: {},
    },
  });
}

function registerStructuredSshExec(): void {
  const catalog = new ToolCatalog();
  catalog.register({
    name: "structured_ssh_exec",
    exposure: "core",
    category: "development",
    trustTier: "admin",
    impact: "high",
    executor: "relay",
    resultScanPolicy: "never",
    factory: () => new DynamicStructuredTool({
      name: "structured_ssh_exec",
      description: "structured SSH fixture",
      schema: z.record(z.string(), z.unknown()),
      func: async () => "unexpected direct structured SSH invocation",
    }),
  });
  initToolCatalog(catalog);
}

function registerStructuredSshOutput(): void {
  const catalog = new ToolCatalog();
  catalog.register({
    name: "structured_ssh_output",
    exposure: "core",
    category: "development",
    trustTier: "admin",
    impact: "read-only",
    executor: "relay",
    resultScanPolicy: "never",
    factory: () => new DynamicStructuredTool({
      name: "structured_ssh_output",
      description: "structured SSH retained output fixture",
      schema: z.record(z.string(), z.unknown()),
      func: async () => "unexpected direct output invocation",
    }),
  });
  initToolCatalog(catalog);
}

type StructuredSshPrepareInput = Parameters<NonNullable<ToolRelayRegistry["prepareStructuredSsh"]>>[1];
type StructuredSshPrepareResponse = Awaited<ReturnType<NonNullable<ToolRelayRegistry["prepareStructuredSsh"]>>>;

function structuredSshPrepareResponse(
  preparationId: string,
  overrides: Partial<Pick<StructuredSshPrepareResponse, "approval" | "subject">> = {},
  input: StructuredSshPrepareInput = {
    instanceId: "default",
    userId: "owner",
    actorId: "owner",
    actorRole: "owner",
    agentId: "agent",
    executionEntrypoint: "foreground.main",
    toolCallId: "call-structured_ssh_exec",
    approvedRequestDigest: "a".repeat(64),
    operation: "exec",
    approvedRequest: {
      version: RELAY_SSH_APPROVED_REQUEST_VERSION,
      toolCallId: "call-structured_ssh_exec",
      toolName: "structured_ssh_exec",
      args: {
        destination: { host: "build.example.test", user: "deploy" },
        program: "true",
        argv: [],
        timeoutSeconds: 300,
      },
    },
  },
): StructuredSshPrepareResponse {
  const response: StructuredSshPrepareResponse = {
    version: 2,
    requestId: "ssh-request-1",
    toolCallId: input.toolCallId,
    approvedRequestDigest: input.approvedRequestDigest,
    operation: input.operation,
    subject: {
      userId: input.userId,
      actorId: input.actorId,
      actorRole: input.actorRole,
      agentId: input.agentId,
      executionEntrypoint: "foreground.main",
      instanceId: input.instanceId,
      relayId: "relay-1",
      relaySessionId: "relay-session-1",
      desktopSessionId: "desktop-session-1",
      pairingGenerationRef: "pairing-ref-1",
      capabilityRevision: 1,
    },
    preparationId,
    approval: {
      requestedDestination: input.approvedRequest.args.destination,
      host: "build.example.test",
      port: 22,
      remoteUser: "deploy",
      operation: input.operation,
      hostKeyFingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAA",
      hostTrust: "trusted" as const,
    },
  };
  return { ...response, ...overrides };
}

function structuredSshRegistry(
  dispatch: ToolRelayRegistry["dispatch"],
  prepare: (input: StructuredSshPrepareInput) => Awaited<ReturnType<NonNullable<ToolRelayRegistry["prepareStructuredSsh"]>>> =
    (input) => structuredSshPrepareResponse("ssh-preparation-1", {}, input),
): ToolRelayRegistry {
  return {
    findByCapabilityForUser: () => ["relay-1"],
    getCapabilities: () => null,
    prepareStructuredSsh: async (_relayId, input) => prepare(input),
    dispatch,
  };
}

function structuredSshInvocationState(
  autoApprove: boolean,
  callId = "call-structured_ssh_exec",
): NautiloState {
  return state({
    trustedExecutionEntrypoint: "foreground.main",
    autoApprove,
    requiredHostRelays: { [callId]: "relay-1" },
    verifiedOrdinaryOrigin: {
      kind: "local_electron",
      userId: "owner",
      actorId: "owner",
      relayId: "relay-1",
      desktopSessionId: "desktop-session-1",
      pairingGeneration: "pairing-1",
      requestId: "request-1",
    },
  });
}

function structuredSshExecCall(callId = "call-structured_ssh_exec"): NautiloToolInvocationCall {
  return {
    ...call("structured_ssh_exec", {
    destination: { host: "build.example.test", user: "deploy" },
    program: "true",
    argv: [],
    }),
    callId,
  };
}

async function invokeStructuredSshExec(
  dispatch: ToolRelayRegistry["dispatch"],
  prepare?: (input: StructuredSshPrepareInput) => Awaited<ReturnType<NonNullable<ToolRelayRegistry["prepareStructuredSsh"]>>>,
) {
  registerStructuredSshExec();
  setRelayRegistry(structuredSshRegistry(dispatch, prepare));
  const context = createServerToolInvocationContext(
    structuredSshInvocationState(true),
    () => ({ status: "allowed" }),
  );
  return await createNautiloToolInvocationSession(context).invoke(structuredSshExecCall());
}

describe("structured SSH pre-effect error contract", () => {
  test.each([
    ["STRUCTURED_SSH_TRUST_STALE", "Error from relay (STRUCTURED_SSH_TRUST_STALE)"],
    [undefined, "Error from relay (STRUCTURED_SSH_UNKNOWN)"],
  ] as const)("preserves a safe dispatch diagnostic code %s", async (errorCode, expected) => {
    const result = await invokeStructuredSshExec(async () => ({
      status: "error",
      ...(errorCode === undefined ? {} : { errorCode }),
      error: errorCode === undefined
        ? "Structured SSH failed for an unknown desktop reason."
        : "The SSH host-key observation changed before dispatch.",
    }));
    const content = typeof result.content === "string" ? result.content : JSON.stringify(result.content);

    expect(result.status).toBe("error");
    expect(content).toContain(expected);
    expect(content).not.toContain("unavailable or no longer authorized");
  });

  test("retrieves retained output as a local read without preparation or structured SSH dispatch", async () => {
    registerStructuredSshOutput();
    let prepares = 0;
    let dispatched: Parameters<ToolRelayRegistry["dispatch"]>[1] | undefined;
    setRelayRegistry(structuredSshRegistry(async (_relayId, request) => {
      dispatched = request;
      return { status: "ok", result: { stdout: "continued", complete: true } };
    }, (input) => {
      prepares += 1;
      return structuredSshPrepareResponse("must-not-prepare", {}, input);
    }));
    const callId = "call-structured_ssh_output";
    const context = createServerToolInvocationContext(structuredSshInvocationState(true, callId), () => ({ status: "allowed" }));
    const result = await createNautiloToolInvocationSession(context).invoke({
      ...call("structured_ssh_output", { output_artifact: { reference: "a".repeat(43) } }),
      callId,
    });
    expect(result.status).toBe("success");
    expect(prepares).toBe(0);
    expect(dispatched).toMatchObject({ toolName: "structured_ssh_output", executionClass: "desktop", impact: "read-only" });
    expect(dispatched).not.toHaveProperty("sshBinding");
  });

  test("preserves known retained-output error codes instead of mislabeling continuation failure", async () => {
    registerStructuredSshOutput();
    setRelayRegistry(structuredSshRegistry(async () => ({
      status: "error",
      errorCode: "STRUCTURED_SSH_OUTPUT_ARTIFACT_NOT_FOUND",
      error: "Structured SSH output continuation is unavailable, expired, or belongs to another session.",
    })));
    const callId = "call-structured_ssh_output";
    const context = createServerToolInvocationContext(structuredSshInvocationState(true, callId), () => ({ status: "allowed" }));
    const result = await createNautiloToolInvocationSession(context).invoke({
      ...call("structured_ssh_output", { output_artifact: { reference: "a".repeat(43) } }),
      callId,
    });
    const content = typeof result.content === "string" ? result.content : JSON.stringify(result.content);

    expect(result.status).toBe("error");
    expect(content).toContain("Error from relay (STRUCTURED_SSH_OUTPUT_ARTIFACT_NOT_FOUND)");
    expect(content).not.toContain("preparation");
  });

  test("projects structured SSH progress as a secret-free dedicated event while the final result stays canonical", async () => {
    const events: ServerEvent[] = [];
    setAgentEventSink({ emit: (event) => events.push(event) });
    const result = await invokeStructuredSshExec(async (_relayId, request) => {
      request.onStructuredSshProgress?.({
        type: "relay:structured-ssh-progress",
        correlationId: "relay-1:fixture",
        version: 1,
        sequence: 0,
        operation: "exec",
        kind: "exec-output",
        stream: "stdout",
        offsetBytes: 0,
        endOffsetBytes: 2,
        text: "ok",
        elapsedMs: 1,
        phase: "running",
      });
      return { status: "ok", result: { canonical: true } };
    });
    expect(result.status).toBe("success");
    const progress = events.filter((event) => event.type === "tool.structured_ssh.progress");
    expect(progress).toHaveLength(1);
    expect(progress[0]).toMatchObject({
      toolCallId: "call-structured_ssh_exec", authorAgentId: "agent", turnId: "turn",
      operation: "exec", kind: "exec-output", stream: "stdout", text: "ok",
    });
    expect(JSON.stringify(progress)).not.toContain("build.example.test");
    expect(JSON.stringify(progress)).not.toContain("deploy");
    expect(JSON.stringify(progress)).not.toContain("ssh-preparation");
  });

  test.each([
    ["ssh_prepare_timeout", undefined, "bounded relay timeout"],
    ["resolve_timed_out", { code: "resolve_timed_out", phase: "resolve", retrySafe: true, sideEffectStarted: false, stateChanged: false, recovery: "retry" }, "could not safely resolve"],
    ["scan_timed_out", { code: "scan_timed_out", phase: "host_key_scan", retrySafe: true, sideEffectStarted: false, stateChanged: false, recovery: "retry" }, "host-key scan timed out"],
    ["lookup_timed_out", { code: "lookup_timed_out", phase: "known_hosts_lookup", retrySafe: true, sideEffectStarted: false, stateChanged: false, recovery: "retry" }, "known_hosts lookup timed out"],
  ] as const)("maps known preparation/probe timeout %s to retry-only recovery", async (code, failure, expected) => {
    const result = await invokeStructuredSshExec(
      async () => ({ status: "ok", result: "unexpected" }),
      () => {
        throw Object.assign(new Error(code), failure === undefined ? { code } : { code, failure });
      },
    );
    const content = typeof result.content === "string" ? result.content : JSON.stringify(result.content);

    expect(result.status).toBe("error");
    expect(content).toContain(expected);
    for (const forbidden of ["prepare_unknown", "trust_unavailable", "grant expired"]) {
      expect(content).not.toContain(forbidden);
    }
    const containsAffirmativeRecovery = (phrase: string) => content.split(/[.!?]/).some((sentence) =>
      sentence.toLowerCase().includes(phrase) && !sentence.trimStart().toLowerCase().startsWith("do not ")
    );
    expect(content).not.toMatch(/capability[^.]*expired/i);
    expect(containsAffirmativeRecovery("re-enable ssh")).toBe(false);
    expect(containsAffirmativeRecovery("create another grant")).toBe(false);
  });

  test("reports invalid argv precisely without invoking desktop preparation", async () => {
    registerStructuredSshExec();
    let preparations = 0;
    setRelayRegistry(structuredSshRegistry(
      async () => ({ status: "ok", result: "unexpected" }),
      (input) => {
        preparations += 1;
        return structuredSshPrepareResponse("ssh-preparation-unexpected", {}, input);
      },
    ));
    const context = createServerToolInvocationContext(
      structuredSshInvocationState(true),
      () => ({ status: "allowed" }),
    );
    const baseCall = structuredSshExecCall();
    const malformed: NautiloToolInvocationCall = {
      ...baseCall,
      args: { ...baseCall.args, argv: ["contains\0nul"] },
    };

    const result = await createNautiloToolInvocationSession(context).invoke(malformed);
    const content = typeof result.content === "string" ? result.content : JSON.stringify(result.content);

    expect(result.status).toBe("error");
    expect(content).toContain("Structured SSH did not start (request_invalid)");
    expect(content).toContain("No SSH operation was started");
    expect(content).not.toContain("preparation is unavailable or no longer authorized");
    expect(preparations).toBe(0);
  });

  test("preserves an unknown desktop prepare failure as an explicit diagnostic code", async () => {
    registerStructuredSshExec();
    setRelayRegistry(structuredSshRegistry(
      async () => ({ status: "ok", result: "unexpected" }),
      () => { throw Object.assign(new Error("fixture prepare rejection"), { code: "novel_internal_failure" }); },
    ));
    const context = createServerToolInvocationContext(
      structuredSshInvocationState(true),
      () => ({ status: "allowed" }),
    );

    const result = await createNautiloToolInvocationSession(context).invoke(structuredSshExecCall());
    const content = typeof result.content === "string" ? result.content : JSON.stringify(result.content);

    expect(result.status).toBe("error");
    expect(content).toContain("Structured SSH did not start (prepare_unknown)");
    expect(content).not.toContain("novel_internal_failure");
    expect(content).toContain("desktop logs");
    expect(content).not.toContain("preparation is unavailable or no longer authorized");
  });
});

describe("structured SSH parked Human review lifecycle", () => {
  test("does not expire a parked Human review on an arbitrary wall clock", async () => {
    registerStructuredSshExec();
    const parkedCallId = "call-structured_ssh_exec-parked-review";
    let preparations = 0;
    let dispatches = 0;
    setRelayRegistry(structuredSshRegistry(
      async () => {
        dispatches += 1;
        return { status: "ok", result: "ok" };
      },
      (input) => {
        preparations += 1;
        return structuredSshPrepareResponse(`ssh-preparation-${preparations}`, {}, input);
      },
    ));
    const manualContext = createServerToolInvocationContext(
      structuredSshInvocationState(false, parkedCallId),
      () => ({ status: "allowed" }),
    );

    const parked = await createNautiloToolInvocationSession(manualContext).invoke(structuredSshExecCall(parkedCallId));
    const parkedContent = typeof parked.content === "string" ? parked.content : JSON.stringify(parked.content);
    expect(parked.status).toBe("error");
    expect(parkedContent).toContain("Called interrupt() outside the context of a graph");
    expect(preparations).toBe(1);

    const realNow = Date.now;
    Date.now = () => realNow() + 46_000;
    try {
      const resumedContext = createServerToolInvocationContext(
        structuredSshInvocationState(true, parkedCallId),
        () => ({ status: "allowed" }),
      );
      const result = await createNautiloToolInvocationSession(resumedContext).invoke(structuredSshExecCall(parkedCallId));
      const resultContent = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
      expect(result.status).toBe("error");
      expect(resultContent).toContain("Called interrupt() outside the context of a graph");
    } finally {
      Date.now = realNow;
    }

    expect(preparations).toBe(1);
    expect(dispatches).toBe(0);
  });
});

describe("structured SSH uncertain dispatch outcome", () => {
  test.each(["timeout", "disconnect"] as const)(
    "reports a post-send %s unknown effect as reconcile-before-retry, not relay-unavailable",
    async (reason) => {
      const unknown = Object.assign(
        new Error(`structured SSH outcome unknown after relay dispatch (${reason})`),
        { structuredSshOutcome: "unknown" as const },
      );
      const result = await invokeStructuredSshExec(async () => Promise.reject(unknown));
      const content = typeof result.content === "string" ? result.content : JSON.stringify(result.content);

      expect(result.status).toBe("error");
      expect(content).toContain("exact structured SSH exec operation may have executed");
      expect(content).toContain("Reconcile the remote effect before any retry");
      expect(content).toContain("do not retry this operation blindly");
      expect(content).not.toContain("relay_unavailable");
      expect(content).not.toContain(reason);
    },
  );

  test("keeps a synchronous pre-send failure on the ordinary known-error path", async () => {
    const result = await invokeStructuredSshExec(async () => {
      throw new Error("transport rejected frame");
    });
    const content = typeof result.content === "string" ? result.content : JSON.stringify(result.content);

    expect(result.status).toBe("error");
    expect(content).toContain("Error dispatching structured_ssh_exec to relay: transport rejected frame");
    expect(content).not.toContain("may have executed");
    expect(content).not.toContain("Reconcile the remote effect before any retry");
  });
});

describe("Nautilo tool invocation service", () => {
  test("recovers an exact top-level browser plan and rejects ambiguous shapes without a plain-read fallback", async () => {
    const catalog = new ToolCatalog();
    registerAllTools(catalog);
    initToolCatalog(catalog);
    const dispatched: Record<string, unknown>[] = [];
    setRelayRegistry({
      findByCapabilityForUser: () => ["relay-1"],
      getCapabilities: () => ({ profile: "desktop-agent", canControlBrowser: true, browserSessionId: "browser-1" }),
      getUserId: () => "owner",
      getRelaySessionId: () => "socket-1",
      getDesktopSessionId: () => "desktop-1",
      getPairingGeneration: () => "pairing-1",
      isRelayHeartbeatFresh: () => true,
      dispatch: async (_relayId, request) => {
        dispatched.push(request.args);
        return { status: "ok", result: "snapshot" };
      },
    });
    const rawPlan = {
      goal: "Choose the reviewed result",
      constraints: ["Keep the exact selection"],
      allowedOrigins: ["https://example.com"],
      actions: [{ kind: "click", role: "button", name: "Choose" }],
      progress: [],
      success: [],
    };
    const rawCall = call("browser_snapshot", rawPlan);
    const selectCall = call("browser_select", { ref: "@e4", values: ["express", "pickup"] });
    const typeCall = call("browser_type", { ref: "@e5", text: "exact text", clear: true });
    const invocationState = state({
      relayCapabilities: { canControlBrowser: true, control_browser: true },
      requiredHostRelays: {
        [rawCall.callId]: "relay-1",
        [selectCall.callId]: "relay-1",
        [typeCall.callId]: "relay-1",
      },
      trustedExecutionEntrypoint: "foreground.main",
      verifiedOrdinaryOrigin: { kind: "local_electron", userId: "owner", actorId: "owner", relayId: "relay-1",
        desktopSessionId: "desktop-1", pairingGeneration: "pairing-1", requestId: "request-raw-plan" },
    });
    const invoke = (input: NautiloToolInvocationCall) => createNautiloToolInvocationSession(
      createServerToolInvocationContext(invocationState, () => ({ status: "allowed" })),
    ).invoke(input);
    configureRuntimeModelCatalog({ catalogPointerUrl: null });
    process.env["OPENROUTER_API_KEY"] = "synthetic-decision-key";
    try {
      expect((await invoke(rawCall)).status).toBe("success");
      expect(dispatched).toEqual([{}]);
      expect((await invoke(selectCall)).status).toBe("success");
      expect((await invoke(typeCall)).status).toBe("success");
      expect(dispatched.slice(1)).toEqual([
        { ref: "@e4", values: ["express", "pickup"] },
        { ref: "@e5", text: "exact text", clear: true },
      ]);

      for (const args of [
        { ...rawPlan, appId: "mixed-selector" },
        { decisionPlan: rawPlan, goal: rawPlan.goal },
        { unknownSnapshotArgument: true },
      ]) {
        const rejected = await invoke({ ...rawCall, args });
        expect(rejected.status).toBe("error");
        expect(rejected.content).toContain("No browser request was sent");
      }
      expect(dispatched).toHaveLength(3);

      delete process.env["OPENROUTER_API_KEY"];
      const disabled = await invoke(rawCall);
      expect(disabled.status).toBe("error");
      expect(disabled.content).toContain("Routine browser decisions are unavailable");
      expect(dispatched).toHaveLength(3);
    } finally {
      setConfigOverrides({});
    }
  });

  test("reads one retained browser snapshot by historyToolCallId without dispatch or changing current authority", async () => {
    const catalog = new ToolCatalog();
    registerAllTools(catalog);
    initToolCatalog(catalog);
    let relayDispatches = 0;
    setRelayRegistry({
      findByCapabilityForUser: () => ["relay-1"],
      getCapabilities: () => ({ profile: "desktop-agent", canControlBrowser: true, browserSessionId: "browser-current" }),
      getUserId: () => "owner",
      getRelaySessionId: () => "socket-1",
      getDesktopSessionId: () => "desktop-1",
      getPairingGeneration: () => "pairing-1",
      isRelayHeartbeatFresh: () => true,
      dispatch: async () => {
        relayDispatches += 1;
        throw new Error("historical browser reads must not dispatch");
      },
    });
    const sourceToolCallId = "call-browser-snapshot-retained";
    const retainedObservation = {
      version: 1 as const,
      snapshot: "Older page with @e7 button",
      refs: { e7: { role: "button", name: "Older action" } },
      pageUrl: "https://example.com/older",
      browserSessionId: "browser-current",
      observationId: "observation-older",
    };
    const currentObservation = {
      ...retainedObservation,
      snapshot: "Current page with @e2 textbox",
      refs: { e2: { role: "textbox", name: "Current field" } },
      pageUrl: "https://example.com/current",
      observationId: "observation-current",
    };
    const browserDecision = {
      turnId: "turn",
      modelId: "openrouter:typesafe/jev-1.13",
      phase: "decide" as const,
      reason: null,
      observation: currentObservation,
      plan: {
        goal: "Continue on the current page",
        constraints: [],
        allowedOrigins: ["https://example.com"],
        actions: [{ kind: "click" as const, role: "button", name: "Continue" }],
        progress: [],
        success: [],
      },
      pending: null,
      recovery: {
        interventionLimit: 2,
        consecutiveEvents: 0,
        interventionAt: 2,
        progressSeen: [],
        assessNextObservation: false,
      },
    };
    const historyCall = call("browser_snapshot", { historyToolCallId: sourceToolCallId });
    const invocationState = state({
      messages: [
        new AIMessage({ content: "", tool_calls: [{
          id: sourceToolCallId, name: "browser_snapshot", args: {}, type: "tool_call",
        }] }),
        new ToolMessage({
          name: "browser_snapshot",
          tool_call_id: sourceToolCallId,
          content: JSON.stringify(retainedObservation),
          additional_kwargs: { nautilo_tool_status: "success" },
        }),
      ],
      relayCapabilities: { canControlBrowser: true, control_browser: true },
      requiredHostRelays: { [historyCall.callId]: "relay-1" },
      trustedExecutionEntrypoint: "foreground.main",
      verifiedOrdinaryOrigin: {
        kind: "local_electron", userId: "owner", actorId: "owner", relayId: "relay-1",
        desktopSessionId: "desktop-1", pairingGeneration: "pairing-1", requestId: "request-history",
      },
      browserDecision,
    });
    const session = createNautiloToolInvocationSession(
      createServerToolInvocationContext(invocationState, () => ({ status: "allowed" })),
    );

    const retained = await session.invoke(historyCall);
    expect(retained).toMatchObject({ status: "success" });
    if (typeof retained.content !== "string") throw new Error("expected retained browser JSON text");
    const historical = JSON.parse(retained.content) as {
      version: number;
      historical: boolean;
      sourceToolCallId: string;
      warning: string;
      observation: unknown;
    };
    expect(historical).toEqual({
      version: 1,
      historical: true,
      sourceToolCallId,
      warning: "Historical evidence only. Its refs are stale; take a fresh browser_snapshot before acting.",
      observation: retainedObservation,
    });
    expect(relayDispatches).toBe(0);
    expect(invocationState.browserDecision).toBe(browserDecision);
    expect(invocationState.browserDecision?.observation).toBe(currentObservation);

    for (const args of [
      { historyToolCallId: sourceToolCallId, appId: "conflict" },
      { historyToolCallId: "" },
      { historyToolCallId: "call-browser-snapshot-missing" },
    ]) {
      const rejected = await session.invoke({ ...historyCall, args });
      expect(rejected.status).toBe("error");
      expect(typeof rejected.content === "string" ? rejected.content.toLowerCase() : "")
        .toContain("no browser request was sent");
    }
    expect(relayDispatches).toBe(0);
    expect(invocationState.browserDecision).toBe(browserDecision);
    expect(invocationState.browserDecision?.observation).toBe(currentObservation);
  });

  test("binds a fast browser proposal to its exact snapshot and strips model-supplied private fields", async () => {
    const catalog = new ToolCatalog();
    registerAllTools(catalog);
    initToolCatalog(catalog);
    const dispatched: Record<string, unknown>[] = [];
    const signals: Array<AbortSignal | undefined> = [];
    const classes: Array<string | undefined> = [];
    const controller = new AbortController();
    let failure: "none" | "stale" | "unknown" | "browser-error" = "none";
    const browserDiagnostic = "browser_click may have taken effect. Do not replay it blindly.\nUnderlying browser error: locator.click: element is covered by a dialog";
    setRelayRegistry({
      findByCapabilityForUser: () => ["relay-1"],
      getCapabilities: () => ({ profile: "desktop-agent", canControlBrowser: true, browserSessionId: "browser-1" }),
      getUserId: () => "owner",
      getRelaySessionId: () => "socket-1",
      getDesktopSessionId: () => "desktop-1",
      getPairingGeneration: () => "pairing-1",
      isRelayHeartbeatFresh: () => true,
      dispatch: async (_relayId, request) => {
        dispatched.push(request.args); signals.push(request.signal); classes.push(request.executionClass);
        if (failure === "stale") return { status: "error", error: "Stale observation", errorCode: "browser_observation_stale" };
        if (failure === "unknown") throw Object.assign(new Error("lost receipt"), { desktopAutomationOutcome: "unknown" });
        if (failure === "browser-error") return { status: "error", errorCode: "browser_outcome_unknown", error: browserDiagnostic };
        return { status: "ok", result: "clicked" };
      },
    });
    const invocation = call("browser_click", { ref: "@e1" });
    const invocationState = state({
      relayCapabilities: { canControlBrowser: true, control_browser: true },
      requiredHostRelays: { [invocation.callId]: "relay-1" },
      trustedExecutionEntrypoint: "foreground.main",
      verifiedOrdinaryOrigin: { kind: "local_electron", userId: "owner", actorId: "owner", relayId: "relay-1",
        desktopSessionId: "desktop-1", pairingGeneration: "pairing-1", requestId: "request-1" },
      browserDecision: {
        turnId: "turn", modelId: "openrouter:typesafe/jev-1.13", phase: "waiting", reason: null, observation: null,
        plan: { goal: "Search", constraints: [], allowedOrigins: ["https://example.com"],
          actions: [{ kind: "click", role: "button", name: "Search" }],
          progress: [{ kind: "snapshot_contains", text: "Results" }], success: [{ kind: "snapshot_contains", text: "Found" }] },
        pending: { call: { id: invocation.callId, name: invocation.toolName, args: invocation.args },
          browserSessionId: "browser-1", observationId: "observation-1" },
      },
    });
    configureRuntimeModelCatalog({ catalogPointerUrl: null });
    process.env["OPENROUTER_API_KEY"] = "synthetic-decision-key";
    try {
      const invoke = (input = invocation) => createNautiloToolInvocationSession(
        createServerToolInvocationContext(invocationState, () => ({ status: "allowed" })),
        { signal: controller.signal },
      ).invoke(input);
      expect((await invoke()).status).toBe("success");
      expect(dispatched).toEqual([{ ref: "@e1", _requiredSession: "browser-1", _requiredObservationId: "observation-1" }]);
      expect((await invoke({ ...invocation, args: { ref: "@e2" } })).status).toBe("error");
      expect(dispatched).toHaveLength(1);
      delete process.env["OPENROUTER_API_KEY"];
      expect((await invoke()).status).toBe("error");
      expect(dispatched).toHaveLength(1);
      invocationState.browserDecision = null;
      expect((await invoke({ ...invocation, args: { ref: "@e1", _requiredSession: "forged", _requiredObservationId: "forged" } })).status).toBe("success");
      expect(dispatched[1]).toEqual({ ref: "@e1" });
      invocationState.requiredHostRelays = { "call-browser_snapshot": "relay-1" };
      const malformed = await invoke(call("browser_snapshot", {
        decisionPlan: {
          allowedOrigins: ["https://user:test1@example.com/?canary=1"],
          ignoredPlanField: "private-planner-value",
        },
        _requiredSession: "forged",
        _requiredObservationId: "forged",
      }));
      expect(malformed.status).toBe("error");
      const malformedContent = typeof malformed.content === "string" ? malformed.content : JSON.stringify(malformed.content);
      const diagnostic = JSON.parse(malformedContent) as {
        error: string;
        browserRequestSent: boolean;
        issues: Array<{ path: unknown; code: unknown }>;
        expectedContract: unknown;
      };
      expect(diagnostic.error).toBe("invalid_browser_decision_plan");
      expect(diagnostic.browserRequestSent).toBe(false);
      expect(diagnostic.expectedContract).toEqual(z.toJSONSchema(browserDecisionPlanSchema, { io: "input" }));
      const issuePaths = diagnostic.issues.map((issue) => JSON.stringify(issue.path));
      for (const requiredPath of [
        JSON.stringify(["decisionPlan", "goal"]),
        JSON.stringify(["decisionPlan", "allowedOrigins", 0]),
      ]) expect(issuePaths).toContain(requiredPath);
      expect(issuePaths).not.toContain(JSON.stringify(["decisionPlan", "actions"]));
      for (const issue of diagnostic.issues) expect(issue.code).toBeString();
      expect(JSON.stringify(diagnostic)).not.toContain("private-planner-value");
      expect(JSON.stringify(diagnostic)).not.toContain("test1");
      expect(JSON.stringify(diagnostic)).not.toContain("canary");
      expect(dispatched).toHaveLength(2);
      const validDecisionPlan = {
        goal: "Search",
        actions: [{ kind: "click", role: "button", name: "Search" }],
        progress: [{ kind: "snapshot_contains", text: "Results" }],
        success: [{ kind: "snapshot_contains", text: "Found" }],
      };
      const disabled = await invoke(call("browser_snapshot", {
        decisionPlan: validDecisionPlan,
        _requiredSession: "forged",
        _requiredObservationId: "forged",
      }));
      expect(disabled.status).toBe("error");
      expect(disabled.content).toContain("Routine browser decisions are unavailable");
      expect(disabled.content).toContain("no browser request was sent");
      expect(dispatched).toHaveLength(2);
      process.env["OPENROUTER_API_KEY"] = "synthetic-decision-key";
      expect((await invoke(call("browser_snapshot", {
        decisionPlan: validDecisionPlan,
        _requiredSession: "forged",
        _requiredObservationId: "forged",
      }))).status).toBe("success");
      expect(dispatched[2]).toEqual({});
      expect(signals).toEqual([controller.signal, controller.signal, controller.signal]);
      expect(classes).toEqual(["browser", "browser", "browser"]);
      const singletonSnapshot = call("browser_snapshot", { decisionPlan: validDecisionPlan });
      invocationState.messages = [new AIMessage({ content: "", tool_calls: [
        { id: singletonSnapshot.callId, name: singletonSnapshot.toolName, args: singletonSnapshot.args, type: "tool_call" },
        { id: "call-browser-click", name: "browser_click", args: { ref: "@e1" }, type: "tool_call" },
      ] })];
      const singleton = await invoke(singletonSnapshot);
      expect(singleton.status).toBe("error");
      const singletonContent = typeof singleton.content === "string" ? singleton.content : JSON.stringify(singleton.content);
      const singletonDiagnostic = JSON.parse(singletonContent) as {
        error: string;
        browserRequestSent: boolean;
        issues: unknown[];
        expectedContract: unknown;
      };
      expect(singletonDiagnostic.error).toBe("decision_plan_requires_singleton");
      expect(singletonDiagnostic.browserRequestSent).toBe(false);
      expect(singletonDiagnostic.issues).toEqual([]);
      expect(singletonDiagnostic.expectedContract).toEqual(z.toJSONSchema(browserDecisionPlanSchema, { io: "input" }));
      expect(dispatched).toHaveLength(3);
      invocationState.requiredHostRelays = { [invocation.callId]: "relay-1" };
      failure = "stale";
      expect((await invoke()).additionalKwargs).toMatchObject({ nautilo_browser_failure: "browser_observation_stale" });
      failure = "unknown";
      const unknown = await invoke();
      expect(unknown.additionalKwargs).toMatchObject({ nautilo_browser_failure: "browser_outcome_unknown" });
      expect(unknown.content).toContain("Do not replay");
      expect(unknown.content).toContain("browser_click");
      expect(unknown.content).toContain("Underlying relay error: lost receipt");
      invocationState.taskRun = true;
      const beforeBackgroundDispatch = dispatched.length;
      const backgroundUnknown = await invoke();
      expect(backgroundUnknown.status).toBe("error");
      expect(backgroundUnknown.additionalKwargs).toMatchObject({ nautilo_browser_failure: "browser_outcome_unknown" });
      expect(backgroundUnknown.content).toContain("browser_click");
      expect(backgroundUnknown.content).toContain("Do not replay");
      expect(backgroundUnknown.content).toContain("Underlying relay error: lost receipt");
      expect(dispatched).toHaveLength(beforeBackgroundDispatch + 1);
      failure = "browser-error";
      const browserError = await invoke();
      expect(browserError.status).toBe("error");
      expect(browserError.additionalKwargs).toMatchObject({ nautilo_browser_failure: "browser_outcome_unknown" });
      expect(browserError.content).toContain(browserDiagnostic);
    } finally { setConfigOverrides({}); }
  });
  test("dispatches a report-back only to its exact live relay and embedded Browser session", async () => {
    const catalog = new ToolCatalog();
    registerAllTools(catalog);
    initToolCatalog(catalog);
    const dispatched: Array<{
      relayId: string;
      args: Record<string, unknown>;
      requiredRelaySessionId?: string;
      requiredDesktopSessionId?: string;
      requiredPairingGeneration?: string;
    }> = [];
    let relaySessionId = "socket-1";
    setRelayRegistry({
      findByCapabilityForUser: () => ["relay-1"],
      getCapabilities: () => ({
        profile: "desktop-agent",
        canControlBrowser: true,
        currentFolderRoot: "/repo",
        workspaceRoot: "/workspace",
        browserSessionId: "browser-1",
      }),
      getUserId: () => "owner",
      getRelaySessionId: () => relaySessionId,
      getDesktopSessionId: () => "desktop-1",
      getPairingGeneration: () => "pairing-1",
      isRelayHeartbeatFresh: () => true,
      dispatch: async (relayId, request) => {
        dispatched.push({
          relayId,
          args: request.args,
          ...(request.requiredRelaySessionId === undefined
            ? {}
            : { requiredRelaySessionId: request.requiredRelaySessionId }),
          ...(request.requiredDesktopSessionId === undefined
            ? {}
            : { requiredDesktopSessionId: request.requiredDesktopSessionId }),
          ...(request.requiredPairingGeneration === undefined
            ? {}
            : { requiredPairingGeneration: request.requiredPairingGeneration }),
        });
        return { status: "ok", result: { snapshot: true } };
      },
    });
    const continuation = {
      status: "available" as const,
      browserStatus: "available" as const,
      relayId: "relay-1",
      relaySessionId: "socket-1",
      desktopSessionId: "desktop-1",
      pairingGeneration: "pairing-1",
      currentFolder: "/repo",
      workspacePath: "/workspace",
      browserSessionId: "browser-1",
    };
    const invocationState = state({
      currentFolder: "/repo",
      workspacePath: "/workspace",
      relayCapabilities: { canControlBrowser: true, control_browser: true },
      trustedExecutionEntrypoint: "foreground.task_report_back",
      taskReportBackContinuation: continuation,
      requiredHostRelays: { "call-browser_snapshot": "relay-1" },
    });
    const invoke = () => createNautiloToolInvocationSession(
      createServerToolInvocationContext(invocationState, () => ({ status: "allowed" })),
    ).invoke(call("browser_snapshot"));

    expect((await invoke()).status).toBe("success");
    expect(dispatched).toEqual([{
      relayId: "relay-1",
      args: { _requiredSession: "browser-1" },
      requiredRelaySessionId: "socket-1",
      requiredDesktopSessionId: "desktop-1",
      requiredPairingGeneration: "pairing-1",
    }]);

    relaySessionId = "socket-2";
    const replaced = await invoke();
    expect(replaced.status).toBe("error");
    const replacedContent = typeof replaced.content === "string"
      ? replaced.content
      : JSON.stringify(replaced.content);
    expect(replacedContent).toContain("exact Task continuation is no longer live");
    expect(dispatched).toHaveLength(1);
  });

  test("lends an explicitly injected protected Memory repository only to this invocation", async () => {
    registerProtectedMemoryTools();
    const operationIds: string[] = [];
    const searches: string[] = [];
    const repository = protectedMemoryRepository({
      save: async (input) => {
        operationIds.push(input.operationId);
        return {
          status: "success",
          value: { id: "memory-protected", action: "created" },
        };
      },
      search: async (input) => {
        searches.push(input.query);
        return {
          status: "success",
          value: [{
            id: "memory-protected",
            type: "fact",
            content: "protected result",
            importance: 0.5,
            tier: 2,
            score: 0.9,
            createdAt: new Date(0),
          }],
        };
      },
    });
    const context = createServerToolInvocationContext(
      protectedMemoryState(),
      () => ({ status: "allowed" }),
      { fullEncryptionOnly: true, protectedMemoryRepository: repository },
    );
    const invocationConfig = {
      configurable: { memoryToolMutationRequestId: "forged-config-id" },
    };
    const session = createNautiloToolInvocationSession(
      context,
      invocationConfig,
    );
    const manageCall: NautiloToolInvocationCall = {
      callId: "trusted-manage-call",
      toolName: "manage_memory",
      args: { action: "save", type: "fact", content: "remember me" },
      authorityRef: "trusted-manage-receipt",
    };
    const searchCall: NautiloToolInvocationCall = {
      callId: "trusted-search-call",
      toolName: "search_memory",
      args: { query: "protected", limit: 3, include_archive: false },
      authorityRef: "trusted-search-receipt",
    };

    expect((await session.invoke(manageCall)).content).toContain(
      "Saved memory (id: memory-protected",
    );
    expect((await session.invoke(searchCall)).content).toContain(
      "protected result",
    );
    expect(searches).toEqual(["protected"]);
    expect(operationIds).toEqual([
      `memory:v1:${createHash("sha256").update(
        "nautilo/protected-memory-operation/v1\ntrusted-manage-call\nsave\nnew",
      ).digest("hex")}`,
    ]);
    expect(invocationConfig).toEqual({
      configurable: { memoryToolMutationRequestId: "forged-config-id" },
    });
    expect(Object.keys(context)).not.toContain("protectedMemoryRepository");
    expect(JSON.stringify(context)).not.toContain(
      "protectedMemoryRepository",
    );
  });

  test("marks protected Memory unavailability as failed delivery, never successful tool text", async () => {
    registerProtectedMemoryTools();
    const context = createServerToolInvocationContext(
      protectedMemoryState(), () => ({ status: "allowed" }),
      { protectedMemoryRepository: protectedMemoryRepository({
        save: async () => ({ status: "unavailable", reason: "encryption_pending" }),
        search: async () => ({ status: "unavailable", reason: "embedding_unavailable" }),
      }) },
    );
    const session = createNautiloToolInvocationSession(context);
    const save = await session.invoke({
      callId: "pending-save-call", toolName: "manage_memory",
      args: { action: "save", type: "fact", content: "not saved" },
      authorityRef: "pending-save-receipt",
    });
    expect(save.status).toBe("error");
    expect(save.content).toContain("Memory encryption is still pending");
    expect(save.content).not.toContain("not saved");
    const search = await session.invoke({
      callId: "pending-search-call", toolName: "search_memory",
      args: { query: "private query", limit: 3, include_archive: false },
      authorityRef: "pending-search-receipt",
    });
    expect(search.status).toBe("error");
    expect(search.content).toContain("compatible Memory embeddings are unavailable");
    expect(search.content).not.toContain("No memories found");
    expect(search.content).not.toContain("private query");
  });

  test("serializes a stale protected projection as the canonical share rejection envelope", async () => {
    registerShareMemoryProjectionTool();
    const toolCallId = "protected-projection-stale";
    const now = Date.now();
    const snapshot = bindProtectedProjectionReference({
      referenceVersion: 1,
      referenceId: "protected-projection-stale-reference",
      toolCallId,
      requesterUserId: "user-alice",
      requesterActorId: "actor-alice",
      agentId: "agent-genie",
      createdAt: now - 1_000,
      expiresAt: now + 60_000,
      sealedPreparation: "protected-projection-stale-sealed",
    }, {
      proposedContent: "approved projection",
      roomLabel: "Destination",
      roomKind: "private",
      memberCount: 2,
    });
    const port: ProtectedAgentMemoryProjectionPort = {
      prepare: async () => ({
        status: "unavailable",
        reason: "authorization_required",
      }),
      publish: async () => ({
        status: "unavailable",
        reason: "authorization_required",
      }),
    };
    const events: ServerEvent[] = [];
    setAgentEventSink({ emit: (event) => events.push(event) });
    const invocationState = state({
      userId: "user-alice",
      agentId: "agent-genie",
      memoryAccessEnvelope: protectedMemoryState().memoryAccessEnvelope,
      projectionSnapshots: [snapshot],
    });

    const result = await createNautiloToolInvocationSession(
      createServerToolInvocationContext(
        invocationState,
        () => ({ status: "allowed" }),
        { fullEncryptionOnly: true, protectedMemoryProjectionPort: port },
      ),
    ).invoke({
      callId: toolCallId,
      toolName: "share_memory",
      args: { mode: "project" },
      authorityRef: "protected-projection-stale-receipt",
    });

    expect(result.status).toBe("error");
    expect(result.additionalKwargs?.["nautilo_tool_status"]).toBe("error");
    expect(result.content).toBe(JSON.stringify({
      error: "Projected Memory was not published: current Memory authorization is unavailable.",
    }));
    expect(events.filter((event) => event.type === "tool.end")).toMatchObject([{
      status: "error",
      error: "stale",
      result: result.content,
    }]);
  });

  test("serializes a missing projection snapshot as an error and preserves projection success", async () => {
    registerShareMemoryProjectionTool();
    const toolCallId = "protected-projection-result";
    const now = Date.now();
    const snapshot = bindProtectedProjectionReference({
      referenceVersion: 1,
      referenceId: "protected-projection-success-reference",
      toolCallId,
      requesterUserId: "user-alice",
      requesterActorId: "actor-alice",
      agentId: "agent-genie",
      createdAt: now - 1_000,
      expiresAt: now + 60_000,
      sealedPreparation: "protected-projection-success-sealed",
    }, {
      proposedContent: "approved projection",
      roomLabel: "Destination",
      roomKind: "private",
      memberCount: 2,
    });
    const port: ProtectedAgentMemoryProjectionPort = {
      prepare: async () => ({
        status: "unavailable",
        reason: "authorization_required",
      }),
      publish: async () => ({ status: "success", value: {
        status: "created",
        memoryId: "projected-memory-id",
        roomLabel: "Destination",
      } }),
    };
    const baseState = state({
      userId: "user-alice",
      agentId: "agent-genie",
      memoryAccessEnvelope: protectedMemoryState().memoryAccessEnvelope,
    });
    const context = (invocationState: NautiloState) =>
      createServerToolInvocationContext(
        invocationState,
        () => ({ status: "allowed" }),
        { fullEncryptionOnly: true, protectedMemoryProjectionPort: port },
      );

    const missing = await createNautiloToolInvocationSession(context(baseState)).invoke({
      callId: toolCallId,
      toolName: "share_memory",
      args: { mode: "project" },
      authorityRef: "protected-projection-missing-receipt",
    });
    expect(missing).toMatchObject({
      status: "error",
      content: JSON.stringify({
        error: "Projected Memory approval is missing its trusted snapshot; nothing was created.",
      }),
      additionalKwargs: { nautilo_tool_status: "error" },
    });

    const success = await createNautiloToolInvocationSession(context(state({
      ...baseState,
      projectionSnapshots: [snapshot],
    }))).invoke({
      callId: toolCallId,
      toolName: "share_memory",
      args: { mode: "project" },
      authorityRef: "protected-projection-success-receipt",
    });
    expect(success).toMatchObject({
      status: "success",
      content: "Created a new projected Memory in 'Destination'. Private source Memories were not shared.\nMemory ID: projected-memory-id",
      additionalKwargs: { nautilo_tool_status: "success" },
    });
  });

  test("serializes a projection idempotency conflict as the canonical share rejection envelope", async () => {
    registerShareMemoryProjectionTool();
    const actor = spyOn(trust, "findActorByOwnerId").mockResolvedValue({
      id: "actor-alice",
      displayName: "Alice",
      trustState: "trusted",
    });
    const projection = spyOn(memoryStore, "executeAtomicProjectionMemory")
      .mockResolvedValue({
        status: "idempotency_conflict",
        reason: "creation_key_mismatch",
      });
    const toolCallId = "ordinary-projection-conflict";
    const now = Date.now();
    const invocationState = state({
      userId: "user-alice",
      agentId: "agent-genie",
      memoryAccessEnvelope: {
        memoryMode: "namespace",
        ownerId: "user-alice",
        actorId: "actor-alice",
        agentId: "agent-genie",
        roomId: "source-room",
        readableNamespaces: ["source-namespace"],
        mutableNamespaces: ["source-namespace"],
        writableNamespaces: ["source-namespace"],
        toolPolicy: {},
      },
      projectionSnapshots: [{
        toolCallId,
        requesterUserId: "user-alice",
        requesterActorId: "actor-alice",
        agentId: "agent-genie",
        sourceFingerprints: [{ id: "source-memory", contentHash: "source-hash" }],
        readableNamespaceIds: ["source-namespace"],
        readableAuthorityFingerprint: "readable-authority-fingerprint",
        content: "approved projection",
        contentHash: "projection-content-hash",
        destination: {
          roomId: "destination-room",
          namespaceId: "destination-namespace",
          label: "Destination",
          kind: "private",
          memberCount: 2,
          audienceFingerprint: "audience-fingerprint",
        },
        audienceFingerprint: "audience-fingerprint",
        createdAt: now - 1_000,
        expiresAt: now + 60_000,
        creationKey: "projection:10000000-0000-4000-8000-000000000001",
      }],
    });

    try {
      const result = await createNautiloToolInvocationSession(
        createServerToolInvocationContext(
          invocationState,
          () => ({ status: "allowed" }),
        ),
      ).invoke({
        callId: toolCallId,
        toolName: "share_memory",
        args: { mode: "project" },
        authorityRef: "ordinary-projection-conflict-receipt",
      });

      expect(result).toMatchObject({
        status: "error",
        content: JSON.stringify({
          error: "Projected Memory approval conflicts with an existing result; nothing was created.",
        }),
        additionalKwargs: { nautilo_tool_status: "error" },
      });
      expect(projection).toHaveBeenCalledTimes(1);
    } finally {
      actor.mockRestore();
      projection.mockRestore();
    }
  });

  test("reports a resumed protected share digest mismatch as an error without any mutation", async () => {
    const catalog = new ToolCatalog();
    catalog.register({
      name: "share_memory",
      exposure: "core",
      category: "knowledge",
      trustTier: "standard",
      impact: "high",
      fullEncryptionSupport: "supported",
      executor: "cloud",
      resultScanPolicy: "never",
      factory: (context) => createShareMemoryTool(context),
    });
    initToolCatalog(catalog);
    const target = spyOn(
      shareApprovalPreview,
      "resolveLocalShareTargetByHandle",
    ).mockResolvedValue(null);
    const attach = spyOn(memoryStore, "attachMemoryToNamespace");
    const createRoom = spyOn(trust, "createSharedRoomForPair");
    const createAccess = spyOn(trust, "findOrCreateAccessNamespace");
    const invocationState = protectedMemoryState();
    const toolCallId = "resumed-share-call";
    const args = {
      mode: "attach",
      memory_id: "memory-protected",
      target_handle: "@bob",
      sensitivity: "sensitive",
    } as const;
    const checkpoint = (digest: string) => ({ tasks: [{ interrupts: [{ value: {
      type: "approval_ask",
      tools: [{ id: toolCallId, name: "share_memory", args,
        shareMemoryPreview: { protectedApprovalDigest: digest } }],
    } }] }] });
    const port = (
      referenceId: string,
      changed: () => void,
    ): ProtectedAgentMemoryAccessPort => ({
      prepareApproval: async (input) => ({ status: "success", value: {
        reference: { referenceVersion: 1, referenceId,
          toolCallId: input.toolCallId,
          requesterUserId: input.authority.subjectUserId,
          agentId: input.authority.agentId },
        preview: { type: "fact", content: "private payload" },
      } }),
      change: async (input) => {
        changed();
        return { status: "success", value: {
          status: "updated", memoryId: input.memoryId,
        } };
      },
    });
    let protectedChanges = 0;

    try {
      const staleResume = bindProtectedMemoryResumeDeps({
        protectedMemoryAccessPortForState: () => port(
          "newly-prepared-digest",
          () => { protectedChanges += 1; },
        ),
      });
      staleResume.bindCheckpoint(checkpoint("original-checkpoint-digest"));
      const stalePort = staleResume.deps
        .protectedMemoryAccessPortForState!(invocationState)!;
      const preparationError = await computeShareMemoryApprovalPreview({
        id: toolCallId, name: "share_memory", args,
      }, {
        userId: invocationState.userId,
        memoryAccessEnvelope: invocationState.memoryAccessEnvelope,
        protectedMemoryAccessPort: stalePort,
      }).then(() => null, (error: unknown) => error);
      expect(preparationError).toMatchObject({
        name: "ProtectedMemoryToolUnavailableError",
        reason: "stale_revision",
      });
      const staleResult = await createNautiloToolInvocationSession(
        createServerToolInvocationContext(
          invocationState,
          () => ({ status: "allowed" }),
          { fullEncryptionOnly: true, protectedMemoryAccessPort: stalePort },
        ),
      ).invoke({
        callId: toolCallId,
        toolName: "share_memory",
        args,
        authorityRef: "resumed-share-receipt",
      });
      expect(staleResult.status).toBe("error");
      expect(protectedChanges).toBe(0);
      expect(attach).not.toHaveBeenCalled();
      expect(createRoom).not.toHaveBeenCalled();
      expect(createAccess).not.toHaveBeenCalled();

      const matchedResume = bindProtectedMemoryResumeDeps({
        protectedMemoryAccessPortForState: () => port(
          "matching-checkpoint-digest",
          () => { protectedChanges += 1; },
        ),
      });
      matchedResume.bindCheckpoint(checkpoint("matching-checkpoint-digest"));
      const matchedPort = matchedResume.deps
        .protectedMemoryAccessPortForState!(invocationState)!;
      expect(await computeShareMemoryApprovalPreview({
        id: toolCallId, name: "share_memory", args,
      }, {
        userId: invocationState.userId,
        memoryAccessEnvelope: invocationState.memoryAccessEnvelope,
        protectedMemoryAccessPort: matchedPort,
      })).toMatchObject({ memoryContentSnippet: "private payload" });
      const matchedResult = await createNautiloToolInvocationSession(
        createServerToolInvocationContext(
          invocationState,
          () => ({ status: "allowed" }),
          { fullEncryptionOnly: true, protectedMemoryAccessPort: matchedPort },
        ),
      ).invoke({
        callId: toolCallId,
        toolName: "share_memory",
        args,
        authorityRef: "resumed-share-receipt",
      });
      expect(matchedResult).toMatchObject({
        status: "success",
        content: "Shared memory memory-protected with @bob.",
      });
      expect(protectedChanges).toBe(1);
      expect(attach).not.toHaveBeenCalled();
      expect(createRoom).not.toHaveBeenCalled();
      expect(createAccess).not.toHaveBeenCalled();
    } finally {
      target.mockRestore();
      attach.mockRestore();
      createRoom.mockRestore();
      createAccess.mockRestore();
    }
  });

  test("reports an unexpected protected share mutation failure as an error without ordinary fallback", async () => {
    const catalog = new ToolCatalog();
    catalog.register({
      name: "share_memory",
      exposure: "core",
      category: "knowledge",
      trustTier: "standard",
      impact: "high",
      fullEncryptionSupport: "supported",
      executor: "cloud",
      resultScanPolicy: "never",
      factory: (context) => createShareMemoryTool(context),
    });
    initToolCatalog(catalog);
    const target = spyOn(
      shareApprovalPreview,
      "resolveLocalShareTargetByHandle",
    ).mockResolvedValue(null);
    const attach = spyOn(memoryStore, "attachMemoryToNamespace");
    const createRoom = spyOn(trust, "createSharedRoomForPair");
    const createAccess = spyOn(trust, "findOrCreateAccessNamespace");
    const events: ServerEvent[] = [];
    setAgentEventSink({ emit: (event) => events.push(event) });
    const invocationState = protectedMemoryState();
    const toolCallId = "protected-share-product-failure";
    const args = {
      mode: "attach",
      memory_id: "memory-protected",
      target_handle: "@bob",
      sensitivity: "sensitive",
    } as const;
    const port: ProtectedAgentMemoryAccessPort = {
      prepareApproval: async (input) => ({ status: "success", value: {
        reference: { referenceVersion: 1, referenceId: "protected-share-digest",
          toolCallId: input.toolCallId,
          requesterUserId: input.authority.subjectUserId,
          agentId: input.authority.agentId },
        preview: { type: "fact", content: "private payload" },
      } }),
      change: async () => {
        throw new Error("product commit exploded");
      },
    };

    try {
      await computeShareMemoryApprovalPreview({
        id: toolCallId, name: "share_memory", args,
      }, {
        userId: invocationState.userId,
        memoryAccessEnvelope: invocationState.memoryAccessEnvelope,
        protectedMemoryAccessPort: port,
      });
      const result = await createNautiloToolInvocationSession(
        createServerToolInvocationContext(
          invocationState,
          () => ({ status: "allowed" }),
          { fullEncryptionOnly: true, protectedMemoryAccessPort: port },
        ),
      ).invoke({
        callId: toolCallId,
        toolName: "share_memory",
        args,
        authorityRef: "protected-share-product-failure-receipt",
      });

      expect(result.status).toBe("error");
      expect(typeof result.content).toBe("string");
      if (typeof result.content !== "string") {
        throw new Error("Protected share error content must be text");
      }
      expect(result.content).toContain("product commit exploded");
      expect(result.content).not.toContain("Share memory failed:");
      expect(events.filter((event) => event.type === "tool.end")).toMatchObject([
        { status: "error" },
      ]);
      expect(attach).not.toHaveBeenCalled();
      expect(createRoom).not.toHaveBeenCalled();
      expect(createAccess).not.toHaveBeenCalled();
    } finally {
      target.mockRestore();
      attach.mockRestore();
      createRoom.mockRestore();
      createAccess.mockRestore();
    }
  });

  test("propagates Strict Shadow retrieval failure past the shared tool dispatcher", async () => {
    registerProtectedMemoryTools();
    const decision: StrictShadowBoundaryDecision = {
      boundaryId: "conversation.read.foreground_memory",
      family: "memory",
      operation: "read_repair",
      actorClass: "agent",
      state: "failed",
      reason: "integrity_failure",
      retryable: false,
      policyRevision: 9,
    };
    const context = createServerToolInvocationContext(
      protectedMemoryState(),
      () => ({ status: "allowed" }),
      {
        protectedMemorySearch: {
          search: async () => {
            throw new StrictShadowEnforcementError(decision);
          },
        },
      },
    );

    expect(createNautiloToolInvocationSession(context).invoke({
      callId: "strict-search-call",
      toolName: "search_memory",
      args: { query: "strict", limit: 3, include_archive: false },
      authorityRef: "strict-search-receipt",
    })).rejects.toMatchObject({
      code: "strict_shadow_protected_content_required",
      decision,
    });
  });

  test("keeps absent protected Memory injection on the exact legacy path", async () => {
    registerProtectedMemoryTools();
    const context = createServerToolInvocationContext(
      state(),
      () => ({ status: "allowed" }),
    );

    const result = await createNautiloToolInvocationSession(context).invoke({
      callId: "legacy-manage-call",
      toolName: "manage_memory",
      args: { action: "save", type: "fact", content: "legacy" },
      authorityRef: "legacy-manage-receipt",
    });

    expect(result).toMatchObject({
      status: "success",
      content: "manage_memory unavailable: no agent context.",
    });
  });

  test("Full manage_memory never reaches an ordinary handler without its repository", async () => {
    registerProtectedMemoryTools();
    const namespaceContext = createServerToolInvocationContext(
      protectedMemoryState(),
      () => ({ status: "allowed" }),
      { fullEncryptionOnly: true },
    );
    const scopeState = state({
      memoryAccessEnvelope: {
        memoryMode: "scope",
        ownerId: "user-alice",
        actorId: "actor-alice",
        agentId: "agent-genie",
        roomId: "room-ab",
        scopeId: "scope-agent-work",
        toolPolicy: {},
      },
      trustedExecutionEntrypoint: "background.task",
    });
    const scopeContext = createServerToolInvocationContext(
      scopeState,
      () => ({ status: "allowed" }),
      { fullEncryptionOnly: true },
    );
    const request = {
      callId: "full-manage-without-repository",
      toolName: "manage_memory",
      args: { action: "save", type: "fact", content: "must not persist" },
      authorityRef: "full-manage-receipt",
    };

    for (const context of [namespaceContext, scopeContext]) {
      const result = await createNautiloToolInvocationSession(context)
        .invoke(request);
      expect(result).toMatchObject({
        status: "error",
        content:
          "Error: Protected tool access is unavailable while Full encryption is active.",
      });
      expect(JSON.stringify(result)).not.toContain("must not persist");
    }
  });

  test("Full share_memory never reaches an ordinary attach handler without its exact protected port", async () => {
    let invoked = false;
    const catalog = new ToolCatalog();
    catalog.register({
      name: "share_memory",
      exposure: "core",
      category: "knowledge",
      trustTier: "standard",
      impact: "high",
      fullEncryptionSupport: "supported",
      executor: "cloud",
      resultScanPolicy: "never",
      factory: () => new DynamicStructuredTool({
        name: "share_memory",
        description: "ordinary attach fixture",
        schema: z.object({}).passthrough(),
        func: async () => {
          invoked = true;
          return "ordinary attach ran";
        },
      }),
    });
    initToolCatalog(catalog);
    const context = createServerToolInvocationContext(
      protectedMemoryState(),
      () => ({ status: "allowed" }),
      { fullEncryptionOnly: true },
    );

    const result = await createNautiloToolInvocationSession(context).invoke({
      callId: "full-share-without-access-port",
      toolName: "share_memory",
      args: {
        mode: "attach",
        memory_id: "memory-sensitive",
        target_handle: "@bob",
        sensitivity: "sensitive",
      },
      authorityRef: "full-share-receipt",
    });

    expect(result).toMatchObject({
      status: "error",
      content:
        "Error: Protected tool access is unavailable while Full encryption is active.",
    });
    expect(invoked).toBe(false);
    expect(JSON.stringify(result)).not.toContain("memory-sensitive");
  });

  test("adapter mints authority independently from model and fallback call ids", () => {
    const admitted = normalizeAdmittedToolCalls([
      {
        id: "model-authored-call-id",
        name: "core",
        args: { value: 1 },
        type: "tool_call",
      },
      {
        name: "core",
        args: { value: 1 },
        type: "tool_call",
      },
      {
        name: "core",
        args: { value: 1 },
        type: "tool_call",
      },
    ]);

    expect(admitted[0]?.callId).toBe("model-authored-call-id");
    expect(admitted[0]?.authorityRef).not.toBe("model-authored-call-id");
    expect(new Set(admitted.map((entry) => entry.authorityRef)).size).toBe(3);
    expect(admitted[1]?.callId).not.toBe(admitted[2]?.callId);
    expect(admitted.every((entry) => entry.callId !== entry.authorityRef)).toBe(
      true,
    );
  });

  test("rejects a forged plain-object server context", () => {
    expect(() =>
      createNautiloToolInvocationSession(
        {
          state: protectedMemoryState(),
          authorityResolver: () => ({ status: "allowed" }),
          protectedMemoryRepository: protectedMemoryRepository(),
        } as unknown as NautiloToolInvocationServerContext,
      ),
    ).toThrow("invalid_tool_invocation_server_context");
  });

  test("denied or mismatched admission never invokes or renews", async () => {
    let invoked = 0;
    const events: ServerEvent[] = [];
    setAgentEventSink({ emit: (event) => events.push(event) });
    register("deferred", async () => {
      invoked += 1;
      return "unexpected";
    }, "discoverable");
    const context = createServerToolInvocationContext(
      state({
        activatedToolNames: ["deferred"],
        activatedToolLeases: [{ name: "deferred", idleTurns: 2 }],
      }),
      ({ call: candidate, authorityRef }) =>
        candidate.callId === "expected-call" && authorityRef === "expected-receipt"
          ? { status: "allowed" }
          : { status: "denied", reason: "admission mismatch" },
    );
    const session = createNautiloToolInvocationSession(context);
    const result = await session.invoke(call("deferred"));

    expect(result).toMatchObject({
      callId: "call-deferred",
      toolName: "deferred",
      status: "error",
      content: "admission mismatch",
    });
    expect(invoked).toBe(0);
    expect(events).toEqual([]);
    expect(session.snapshot().activatedToolLeases).toEqual([
      { name: "deferred", idleTurns: 2 },
    ]);
  });

  test("wrong receipt with an otherwise exact call is denied before factory, events, or renewal", async () => {
    let factoryCalls = 0;
    const events: ServerEvent[] = [];
    setAgentEventSink({ emit: (event) => events.push(event) });
    const catalog = new ToolCatalog();
    catalog.register({
      name: "deferred",
      exposure: "discoverable",
      category: "development",
      trustTier: "guest",
      impact: "read-only",
      executor: "cloud",
      resultScanPolicy: "never",
      factory: () => {
        factoryCalls += 1;
        return new DynamicStructuredTool({
          name: "deferred",
          description: "must not be constructed",
          schema: z.record(z.string(), z.unknown()),
          func: async () => "unexpected",
        });
      },
    });
    initToolCatalog(catalog);
    // Registration constructs one instance to capture its description. Count
    // only execution-path factory calls from this point forward.
    factoryCalls = 0;
    const exactCall = call("deferred", { value: 1 });
    const admittedByReceipt = new Map([
      [
        exactCall.authorityRef,
        {
          callId: exactCall.callId,
          toolName: exactCall.toolName,
          args: JSON.stringify(exactCall.args),
        },
      ],
    ]);
    const context = createServerToolInvocationContext(
      state({
        activatedToolNames: ["deferred"],
        activatedToolLeases: [{ name: "deferred", idleTurns: 2 }],
      }),
      ({ call: candidate, authorityRef }) => {
        const admitted = admittedByReceipt.get(authorityRef);
        return admitted &&
            admitted.callId === candidate.callId &&
            admitted.toolName === candidate.toolName &&
            admitted.args === JSON.stringify(candidate.args)
          ? { status: "allowed" }
          : { status: "denied", reason: "bad receipt" };
      },
    );
    const session = createNautiloToolInvocationSession(context);
    const result = await session.invoke({
      ...exactCall,
      // A model/tool-call correlation id is not an admission receipt.
      authorityRef: exactCall.callId,
    });

    expect(result).toMatchObject({
      callId: exactCall.callId,
      status: "error",
      content: "bad receipt",
    });
    expect(factoryCalls).toBe(0);
    expect(events).toEqual([]);
    expect(session.snapshot().activatedToolLeases).toEqual([
      { name: "deferred", idleTurns: 2 },
    ]);
  });

  test("multiple id-less same-name calls produce unique ToolMessage ids", async () => {
    register("core", async () => "ok");
    const initial = state({
      approvedToolCalls: [
        { name: "core", args: { value: 1 }, type: "tool_call" },
        { name: "core", args: { value: 1 }, type: "tool_call" },
      ] as NonNullable<NautiloState["approvedToolCalls"]>,
    });
    const firstCheckpoint = await toolsNode(initial);
    const secondCheckpoint = await toolsNode(state({ ...initial, ...firstCheckpoint }));
    const messages = secondCheckpoint.messages ?? [];
    const toolMessages = messages.slice(-2) as ToolMessage[];

    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[0]?.tool_call_id).not.toBe(
      toolMessages[1]?.tool_call_id,
    );
    expect(toolMessages[0]?.id).not.toBe(toolMessages[1]?.id);
  });

  test("pre-execution denial emits exact start/end order without renewal", async () => {
    const events: ServerEvent[] = [];
    setAgentEventSink({ emit: (event) => events.push(event) });
    register("run_shell", async () => "unexpected", "discoverable");
    const context = createServerToolInvocationContext(
      state({
        activatedToolNames: ["run_shell"],
        activatedToolLeases: [{ name: "run_shell", idleTurns: 2 }],
      }),
      () => ({ status: "allowed" }),
    );
    const session = createNautiloToolInvocationSession(context);
    const result = await session.invoke(
      call("run_shell", { command: "rm -rf /" }),
    );

    expect(result.status).toBe("error");
    expect(typeof result.content === "string" ? result.content : "").toContain(
      "Security: command blocked",
    );
    expect(events.map((event) => event.type)).toEqual([
      "tool.start",
      "tool.end",
    ]);
    expect(session.snapshot().activatedToolLeases).toEqual([
      { name: "run_shell", idleTurns: 2 },
    ]);
  });

  test("rejects authority-shaped fields outside the four-field call contract", async () => {
    register("core", async () => "unexpected");
    const context = createServerToolInvocationContext(
      state(),
      () => ({ status: "allowed" }),
    );
    const session = createNautiloToolInvocationSession(context);
    const forged = {
      ...call("core"),
      actorId: "forged",
      approvalObtained: true,
      workspacePath: "/forged",
    };
    let message = "";
    try {
      await session.invoke(forged as unknown as NautiloToolInvocationCall);
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toBe("invalid_tool_invocation_call");
  });

  test("serializes calls and returns normalized content/status", async () => {
    const order: string[] = [];
    register("core", async (args) => {
      const label = String(args["label"]);
      order.push(`start:${label}`);
      await Promise.resolve();
      order.push(`end:${label}`);
      return `result:${label}`;
    });
    const context = createServerToolInvocationContext(
      state(),
      ({ call: candidate, authorityRef }) =>
        authorityRef === `receipt-${candidate.toolName}`
          ? { status: "allowed" }
          : { status: "denied", reason: "bad receipt" },
    );
    const session = createNautiloToolInvocationSession(context);
    const first = session.invoke(call("core", { label: "a" }));
    const second = session.invoke({
      ...call("core", { label: "b" }),
      callId: "call-core-b",
    });

    expect(await first).toMatchObject({
      status: "success",
      content: "result:a",
    });
    expect(await second).toMatchObject({
      callId: "call-core-b",
      status: "success",
      content: "result:b",
    });
    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b"]);
  });

  test("eligible discoverable execution renews only its own lease", async () => {
    register("deferred", async () => {
      throw new Error("executor failure");
    }, "discoverable");
    const context = createServerToolInvocationContext(
      state({
        activatedToolNames: ["deferred", "sibling"],
        activatedToolLeases: [
          { name: "deferred", idleTurns: 2 },
          { name: "sibling", idleTurns: 1 },
        ],
      }),
      () => ({ status: "allowed" }),
    );
    const session = createNautiloToolInvocationSession(context);
    const result = await session.invoke(call("deferred"));

    expect(result.status).toBe("error");
    expect(typeof result.content === "string" ? result.content : "").toContain(
      "executor failure",
    );
    expect(session.snapshot().activatedToolLeases).toEqual([
      { name: "deferred", idleTurns: 0 },
      { name: "sibling", idleTurns: 1 },
    ]);
  });

  test("uses the checkpointed connected-app provider snapshot before dispatch", async () => {
    let executions = 0;
    const catalog = new ToolCatalog();
    catalog.register({
      name: "notion_connection_fixture",
      exposure: "discoverable",
      category: "integrations",
      trustTier: "guest",
      impact: "read-only",
      executor: "cloud",
      resultScanPolicy: "never",
      connectedAppProviderId: "notion",
      factory: () => new DynamicStructuredTool({
        name: "notion_connection_fixture",
        description: "connected-app invocation fixture",
        schema: z.object({}),
        func: async () => {
          executions += 1;
          return "connected";
        },
      }),
    });
    initToolCatalog(catalog);
    const activation = ["notion_connection_fixture"];
    const permitted = createNautiloToolInvocationSession(createServerToolInvocationContext(
      state({ activatedToolNames: activation, connectedAppProviderIds: ["notion"] }),
      () => ({ status: "allowed" }),
    ));
    expect(await permitted.invoke(call("notion_connection_fixture"))).toMatchObject({ status: "success", content: "connected" });

    const disconnected = createNautiloToolInvocationSession(createServerToolInvocationContext(
      state({ activatedToolNames: activation, connectedAppProviderIds: [] }),
      () => ({ status: "allowed" }),
    ));
    expect(await disconnected.invoke(call("notion_connection_fixture"))).toMatchObject({ status: "error" });
    expect(executions).toBe(1);
  });
});


describe("trusted completed file-operation progress", () => {
  function registerProgressFixture(name: string, fail = false) {
    const executed: Record<string, unknown>[] = [];
    const catalog = new ToolCatalog();
    catalog.register({ name, exposure: "core", category: "development", trustTier: "guest",
      impact: "read-only", executor: "cloud", resultScanPolicy: "never",
      factory: () => new DynamicStructuredTool({ name, description: "Progress receipt fixture",
        schema: z.object({ command: z.enum(["read", "grep", "glob", "list", "stat", "write"]), query: z.string().optional() }),
        func: async (args: Record<string, unknown>) => {
          executed.push(args);
          if (fail) fileToolError("fixture failure");
          return new ToolMessage({ tool_call_id: "untrusted-id", content: '{"ok":true,"command":"grep","matches":[]}',
            additional_kwargs: { nautilo_file_operation: "write", fixture_retained: true } });
        },
      }),
    });
    initToolCatalog(catalog);
    return executed;
  }

  test("successful repaired arguments mint only the executed operation and preserve exact content", async () => {
    const executed = registerProgressFixture("file");
    const raw = { command: "grep<arg_key>query</arg_key><arg_value>caller|callee" };
    const result = await createNautiloToolInvocationSession(createServerToolInvocationContext(state(),
      () => ({ status: "allowed" }))).invoke(call("file", raw));
    expect(executed).toEqual([{ command: "grep", query: "caller|callee" }]);
    expect(raw.command).toContain("<arg_key>");
    expect(result.status).toBe("success");
    expect(result.additionalKwargs?.["nautilo_file_operation"]).toBe("grep");
    expect(result.additionalKwargs?.["fixture_retained"]).toBe(true);
    expect(JSON.stringify(result.additionalKwargs)).not.toContain("caller|callee");
    expect(result.content).toBe('{"ok":true,"command":"grep","matches":[]}');
  });

  test("read content cannot impersonate a search receipt", async () => {
    registerProgressFixture("file");
    const result = await createNautiloToolInvocationSession(createServerToolInvocationContext(state(),
      () => ({ status: "allowed" }))).invoke(call("file", { command: "read" }));
    expect(result.additionalKwargs?.["nautilo_file_operation"]).toBe("read");
    expect(result.content).toContain('"command":"grep"');
  });

  for (const [name, command, fail] of [["file", "grep", true], ["file", "write", false], ["progress_fixture", "grep", false]] as const) {
    test(`${name}/${command}/${fail} cannot supply its own successful file-operation metadata`, async () => {
      registerProgressFixture(name, fail);
      const result = await createNautiloToolInvocationSession(createServerToolInvocationContext(state(),
        () => ({ status: "allowed" }))).invoke(call(name, { command }));
      expect(result.status).toBe(fail ? "error" : "success");
      expect(result.additionalKwargs?.["nautilo_file_operation"]).toBeUndefined();
      expect(result.additionalKwargs?.["fixture_retained"]).toBe(true);
    });
  }

  test("denied authority and invalid repair never attest execution", async () => {
    const executed = registerProgressFixture("file");
    const denied = await createNautiloToolInvocationSession(createServerToolInvocationContext(state(),
      () => ({ status: "denied", reason: "fixture authority denial" }))).invoke(call("file", { command: "read" }));
    expect(denied.status).toBe("error");
    expect(denied.additionalKwargs?.["nautilo_file_operation"]).toBeUndefined();
    const invalid = await createNautiloToolInvocationSession(createServerToolInvocationContext(state(),
      () => ({ status: "allowed" }))).invoke(call("file", {
        command: "grep<arg_key>query</arg_key><arg_value>caller", query: "conflicting-query",
      }));
    expect(invalid.status).toBe("error");
    expect(invalid.additionalKwargs?.["nautilo_file_operation"]).toBeUndefined();
    expect(executed).toEqual([]);
  });
});

test("recovery-blocked finalization persists explicit error status without executing or losing the pending recovery", async () => {
  let executions = 0;
  register("security_scan", async () => { executions++; return "must not finalize"; });
  const events: ServerEvent[] = [];
  setAgentEventSink({ emit: (event) => events.push(event) });
  const finalize = { id: "finalize-during-recovery", name: "security_scan", args: { version: "security-scan-v1", operation: "results", category: "all", finalize: true }, type: "tool_call" as const };
  const initial = state({
    currentTaskId: "11111111-1111-4111-8111-111111111111", currentTaskRunId: "22222222-2222-4222-8222-222222222222",
    subagentRun: true, toolWhitelist: ["security_scan"], approvedToolCalls: [finalize],
    messages: [new AIMessage({ content: "Inspect source", tool_calls: [{ id: "source", name: "file", args: { command: "read", path: "access.js" } }] }),
      new ToolMessage({ content: "Retained source bytes", name: "file", tool_call_id: "source" }),
      new AIMessage({ content: "", tool_calls: [finalize] })],
  });
  const index = describeResearchContextIndex(initial, 1)!;
  const pending = describeResearchContextMessage(initial, 1)!;
  initial.researchContextRecovery = { taskRunId: initial.currentTaskRunId!, throughIndex: 1, indexRef: index.ref, pendingRefs: [pending.ref] };
  const before = JSON.stringify(initial.researchContextRecovery);
  const result = await toolsNode(initial);
  const receipt = result.messages?.at(-1) as ToolMessage;
  expect(executions).toBe(0);
  expect(receipt.tool_call_id).toBe(finalize.id);
  expect(receipt.status).toBe("error");
  expect(receipt.additional_kwargs["nautilo_tool_status"]).toBe("error");
  expect(receipt.content).toContain("Context recovery is active");
  expect(receipt.content).toContain("New investigation and finalization have not executed");
  expect(receipt.toDict()).toMatchObject({ data: { status: "error" } });
  expect(JSON.stringify(initial.researchContextRecovery)).toBe(before);
  expect([...result.noProgressStreaks!.values()].map((entry) => entry.count)).toEqual([1]);
  expect(events.filter((event) => event.type === "tool.end")).toMatchObject([{ status: "error" }]);
});

test("canonical status agrees with command denial and preserves successful Error-prefixed content", async () => {
  let executions = 0;
  register("run_shell", async () => { executions++; return "must not run"; });
  const denied = await toolsNode(state({ approvedToolCalls: [{ id: "blocked-shell", name: "run_shell", args: { command: "rm -rf /" }, type: "tool_call" }] }));
  const deniedReceipt = denied.messages?.at(-1) as ToolMessage;
  expect(deniedReceipt.status).toBe("error");
  expect(deniedReceipt.additional_kwargs["nautilo_tool_status"]).toBe("error");
  expect(executions).toBe(0);
  register("core", async () => "Error: this is successfully retrieved source text");
  const success = await toolsNode(state({ approvedToolCalls: [{ id: "source-text", name: "core", args: {}, type: "tool_call" }] }));
  const successReceipt = success.messages?.at(-1) as ToolMessage;
  expect(successReceipt.status).toBe("success");
  expect(successReceipt.additional_kwargs["nautilo_tool_status"]).toBe("success");
  expect(successReceipt.content).toBe("Error: this is successfully retrieved source text");
  expect(success.noProgressStreaks?.size).toBe(0);
});
