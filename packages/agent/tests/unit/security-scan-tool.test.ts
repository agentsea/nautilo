import { afterEach, describe, expect, test } from "bun:test";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import { ToolCatalog, clearToolCatalog, initToolCatalog } from "@nautilo/catalog";
import { getToolPolicy } from "@nautilo/trust";
import {
  SECURITY_SCAN_MAX_FILE_CITATIONS_PER_CALL,
  SECURITY_SCAN_INITIAL_LANES,
  localToolControlReceiptSchema,
  securityScanOperationSchema,
} from "@nautilo/types";
import type { NautiloState } from "../../src/agent/state";
import { classifyHostScope } from "../../src/runtime/host-scoped-tools";
import {
  assertResearchDesktopAvailable,
  RelayUnavailableError,
  createNautiloToolInvocationSession,
  createServerToolInvocationContext,
  normalizeSecurityScanOperationArgs,
  latestSecurityScanResultsCursor,
  setRelayRegistry,
  type ToolRelayRegistry,
} from "../../src/tools/invocation-service";
import { registerAllTools } from "../../src/tools/register-all";
import {
  createSecurityScanTool,
  SECURITY_SCAN_TOOL_DESCRIPTION,
} from "../../src/tools/security/security-scan";
import { restoreResearchContextControlCycle } from "../../src/tools/security/research-context-rollover";
import { describeResearchContextIndex, describeResearchContextMessage, readResearchContext, serializeResearchContextMessage } from "../../src/tools/security/research-context";

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const TASK_RUN_ID = "22222222-2222-4222-8222-222222222222";
const CALL_ID = "call-security-scan";
const MODEL_ID = "openrouter:z-ai/glm-5.3";

function taskState(overrides: Partial<NautiloState> = {}): NautiloState {
  return {
    messages: [],
    approvedToolCalls: [],
    actorRole: "owner",
    userId: "owner",
    personaId: "owner",
    turnId: "turn-security-scan",
    agentId: "agent",
    roomId: "room",
    model: MODEL_ID,
    currentTaskId: TASK_ID,
    currentTaskRunId: TASK_RUN_ID,
    currentFolder: "/Users/owner/project",
    taskReportBackContinuation: {
      status: "available",
      relayId: "relay-security",
      relaySessionId: "relay-session-security",
      desktopSessionId: "desktop-security",
      pairingGeneration: "pairing-security",
      currentFolder: "/Users/owner/project",
      workspacePath: "/Users/owner/workspace",
    },
    activatedToolNames: ["security_scan"],
    activatedToolLeases: [],
    engagedSkillNames: [],
    memoryAccessEnvelope: null,
    relayCapabilities: { canReadWorkspace: true },
    requiredHostRelays: { [CALL_ID]: "relay-security" },
    verifiedOrdinaryOrigin: {
      kind: "local_electron",
      userId: "owner",
      actorId: "owner",
      relayId: "relay-security",
      desktopSessionId: "desktop-security",
      pairingGeneration: "pairing-security",
      requestId: "request-security",
    },
    ...overrides,
  } as unknown as NautiloState;
}

function operation(): Record<string, unknown> {
  return {
    version: "security-scan-v1",
    operation: "start",
    targetDirectory: ".", mode: "deep_research",
  };
}

afterEach(() => {
  setRelayRegistry(null);
  clearToolCatalog();
});

describe("D560 security_scan agent tool", () => {
  test("result continuation selects the exact paired query and respects exhaustion", () => {
    const pair = (id: string, args: Record<string, unknown>, nextCursor: string | null) => [
      new AIMessage({ content: "", tool_calls: [{ id, name: "security_scan", args: { operation: "results", ...args } }] }),
      new ToolMessage({ name: "security_scan", tool_call_id: id, content: JSON.stringify({
        ok: true, operation: "results", result: {
          version: "security-scan-v1", status: {
            version: "security-scan-v1", scanId: "scan_test", state: "active", phase: "researching",
            terminalState: null, mode: "deep_research", modelId: MODEL_ID, modelState: "running",
            completedSteps: 1, totalSteps: 2, lanes: SECURITY_SCAN_INITIAL_LANES, coverage: [], hypotheses: [],
          }, observations: [], codeEvidence: [], records: [], nextCursor,
        },
      }) }),
    ];
    const messages = [
      ...pair("all", { category: "all", finalize: true }, "cursor_all"),
      ...pair("inventory", { category: "inventory" }, "cursor_inventory"),
      ...pair("notes", { category: "research", recordIds: ["record_b", "record_a"] }, "cursor_notes"),
    ];
    expect(latestSecurityScanResultsCursor(messages, { category: "all", finalize: true })).toBe("cursor_all");
    expect(latestSecurityScanResultsCursor(messages, { category: "all", finalize: false })).toBeUndefined();
    expect(latestSecurityScanResultsCursor(messages, { category: "research", recordIds: ["record_a", "record_b"] })).toBe("cursor_notes");
    expect(latestSecurityScanResultsCursor(messages, { category: "research", recordIds: ["record_a"] })).toBeUndefined();
    expect(latestSecurityScanResultsCursor([...messages, ...pair("end", { category: "all", finalize: true }, null)], { category: "all", finalize: true })).toBeNull();
    expect(latestSecurityScanResultsCursor([pair("orphan", { category: "all", finalize: true }, "cursor_forged")[1]!], { category: "all", finalize: true })).toBeUndefined();
  });
  test("is registered as a trust-governed, host-required Desktop tool", () => {
    const catalog = new ToolCatalog();
    registerAllTools(catalog, { officeCliAvailable: () => false });
    const entry = catalog.get("security_scan");

    expect(entry).toMatchObject({
      executor: "relay",
      trustTier: "high",
      impact: "read-only",
      exposure: "discoverable",
      requiredCapabilities: ["use_project_content"],
      relayCapabilities: ["canReadWorkspace"],
      resultScanPolicy: "never",
    });
    expect(getToolPolicy("security_scan")).toMatchObject({
      requiredCapability: "use_project_content",
      executor: "relay",
      relayCapability: "canReadWorkspace",
    });
    expect(classifyHostScope({ toolName: "security_scan", executor: "relay" })).toBe("required");
    expect(entry?.description).toContain("TASK-INTERNAL WORKER TOOL");
    expect(entry?.description).toContain("call in_background");
    expect(entry?.description).toContain("never request file.write");
    expect(entry?.description).toContain("runtime creates the Workspace report artifact");
    expect(SECURITY_SCAN_TOOL_DESCRIPTION).toContain("no shell or source mutation");
  });

  test("exposes an ordinary provider object instead of a root union that gateways can erase", () => {
    const descriptor = convertToOpenAITool(createSecurityScanTool()) as {
      function: { parameters: Record<string, unknown> };
    };
    const parameters = descriptor.function.parameters;
    expect(parameters["type"]).toBe("object");
    expect(parameters["oneOf"]).toBeUndefined();
    expect(parameters["required"]).toEqual(["version", "operation"]);
    expect(parameters["properties"]).toMatchObject({
      version: { const: "security-scan-v1" },
      operation: { enum: ["start", "status", "results", "record", "cancel", "context", "handoff"] },
      mode: { enum: ["deep_research", "scanners_only"] },
      finalize: { type: "boolean" },
    });
    const entrySchema = (parameters["properties"] as Record<string, { required?: string[] }>)["entry"];
    expect(entrySchema?.required).toContain("kind");
    expect(entrySchema?.required).not.toContain("summary");
    expect((parameters["properties"] as Record<string, unknown>)["scanId"]).toBeUndefined();
  });

  test("repairs harmless flat-schema drift without inventing research claims", () => {
    expect(normalizeSecurityScanOperationArgs({
      version: "security-scan-v1",
      operation: "record",
      scanId: "scan_demo-1",
      action: "create",
      category: "research",
      entry: {
        kind: "evidence",
        summary: "The cited code establishes the authorization boundary.",
        fileCitations: [{ relativePath: "src/auth.ts", startLine: 4, endLine: 9 }],
        counterevidenceRefs: [],
      },
    })).toEqual({
      version: "security-scan-v1",
      operation: "record",
      scanId: "scan_task_bound",
      action: "append",
      entry: {
        kind: "evidence",
        summary: "The cited code establishes the authorization boundary.",
        evidenceRefs: [],
      },
      fileCitations: [{ relativePath: "src/auth.ts", startLine: 4, endLine: 9 }],
    });
    expect(normalizeSecurityScanOperationArgs({
      version: "security-scan-v1",
      operation: "finding",
    })).toEqual({ version: "security-scan-v1", operation: "finding" });
    expect(normalizeSecurityScanOperationArgs({
      version: "security-scan-v1",
      operation: "results",
      scanId: "scan_corrupted-copy",
      category: "all",
      probes: ["gitleak\n}", "trivy"],
      recordKinds: ["finding", "not-a-record-kind"],
      finalize: false,
    })).toEqual({
      version: "security-scan-v1",
      operation: "results",
      scanId: "scan_task_bound",
      category: "all",
      probes: ["trivy"],
      recordKinds: ["finding"],
      finalize: false,
    });
    expect(normalizeSecurityScanOperationArgs({
      version: "security-scan-v1",
      operation: "results",
      category: "all",
      cursor: "model-copied-wrong-cursor",
      continueResults: true,
    }, {
      nextResultsCursor: "observation_server-bound-next-1",
    })).toEqual({
      version: "security-scan-v1",
      operation: "results",
      scanId: "scan_task_bound",
      category: "all",
      cursor: "observation_server-bound-next-1",
    });
    expect(normalizeSecurityScanOperationArgs({
      version: "security-scan-v1",
      operation: "results",
      category: "observations",
      limit: 100,
      finalize: false,
      recordId: "observation_model-copied-next-1",
      entry: { kind: "evidence", summary: "cursor marker", evidenceRefs: [] },
      reason: "noop",
    }, {
      nextResultsCursor: "observation_server-bound-next-2",
    })).toEqual({
      version: "security-scan-v1",
      operation: "results",
      scanId: "scan_task_bound",
      category: "observations",
      limit: 100,
      finalize: false,
      cursor: "observation_server-bound-next-2",
    });
    expect(normalizeSecurityScanOperationArgs({
      version: "security-scan-v1",
      operation: "record",
      action: "append",
      entry: {
        kind: "coverage",
        surfaceKey: "agents",
        rationale: "Only representative agent entry points were reviewed.",
      },
      fileCitations: [],
    })).toEqual({
      version: "security-scan-v1",
      operation: "record",
      scanId: "scan_task_bound",
      action: "append",
      entry: {
        kind: "coverage",
        surfaceKey: "agents",
        state: "limited",
        rationale: "Only representative agent entry points were reviewed.",
        evidenceRefs: [],
      },
      fileCitations: [],
    });
    expect(normalizeSecurityScanOperationArgs({
      version: "security-scan-v1",
      operation: "record",
      action: "append",
      entry: {
        kind: "coverage",
        summary: "Only representative agent entry points were reviewed.",
        surfaceKey: "agents",
        state: "limited",
      },
      fileCitations: [],
    })).toEqual({
      version: "security-scan-v1",
      operation: "record",
      scanId: "scan_task_bound",
      action: "append",
      entry: {
        kind: "coverage",
        surfaceKey: "agents",
        state: "limited",
        rationale: "Only representative agent entry points were reviewed.",
        evidenceRefs: [],
      },
      fileCitations: [],
    });
    expect(normalizeSecurityScanOperationArgs({
      version: "security-scan-v1",
      operation: "record",
      action: "append",
      entry: {
        kind: "evidence",
        summary: "The immediately preceding read proves the ownership predicate.",
        evidenceRefs: [],
      },
      fileCitations: [],
    }, {
      recentFileReadCitations: [{
        relativePath: "packages/db/src/queries/threads.ts",
        startLine: 1,
        endLine: 60,
      }],
    })).toEqual({
      version: "security-scan-v1",
      operation: "record",
      scanId: "scan_task_bound",
      action: "append",
      entry: {
        kind: "evidence",
        summary: "The immediately preceding read proves the ownership predicate.",
        evidenceRefs: [],
      },
      fileCitations: [{
        relativePath: "packages/db/src/queries/threads.ts",
        startLine: 1,
        endLine: 60,
      }],
    });
    const overflowCitations = Array.from(
      { length: SECURITY_SCAN_MAX_FILE_CITATIONS_PER_CALL + 1 },
      (_, index) => ({
        relativePath: `src/evidence-${index + 1}.ts`,
        startLine: 1,
        endLine: 10,
      }),
    );
    const normalizedOverflow = normalizeSecurityScanOperationArgs({
      version: "security-scan-v1",
      operation: "record",
      action: "append",
      entry: {
        kind: "evidence",
        summary: "All preceding bounded reads are material to this evidence record.",
        evidenceRefs: [],
      },
      fileCitations: [],
    }, { recentFileReadCitations: overflowCitations });
    expect(normalizedOverflow["fileCitations"]).toHaveLength(SECURITY_SCAN_MAX_FILE_CITATIONS_PER_CALL + 1);
    expect(securityScanOperationSchema.safeParse(normalizedOverflow).success).toBe(false);
    expect(normalizeSecurityScanOperationArgs({
      version: "security-scan-v1",
      operation: "record",
      action: "append",
      entry: {
        kind: "evidence",
        summary: "Two exact prior reads establish the route and its ownership guard.",
        evidenceRefs: [
          { kind: "code_evidence", id: "route_ts" },
          { kind: "ledger_record", id: "record_seen" },
        ],
      },
      fileCitations: [],
    }, {
      knownEvidenceReferenceKeys: new Set(["ledger_record:record_seen"]),
      recentFileReadCitations: [{
        relativePath: "services/ai/src/app.ts",
        startLine: 1,
        endLine: 100,
      }, {
        relativePath: "services/ai/src/middleware/auth.ts",
        startLine: 1,
        endLine: 60,
      }],
    })).toEqual({
      version: "security-scan-v1",
      operation: "record",
      scanId: "scan_task_bound",
      action: "append",
      entry: {
        kind: "evidence",
        summary: "Two exact prior reads establish the route and its ownership guard.",
        evidenceRefs: [],
      },
      fileCitations: [{
        relativePath: "services/ai/src/app.ts",
        startLine: 1,
        endLine: 100,
      }, {
        relativePath: "services/ai/src/middleware/auth.ts",
        startLine: 1,
        endLine: 60,
      }],
    });
    expect(normalizeSecurityScanOperationArgs({
      version: "security-scan-v1",
      operation: "record",
      action: "update",
      recordId: "record_hypothesis-1",
      expectedRevision: 1,
      entry: {
        kind: "hypothesis",
        state: "supported",
      },
      fileCitations: [],
    })).toEqual({
      version: "security-scan-v1",
      operation: "record",
      scanId: "scan_task_bound",
      action: "update",
      recordId: "record_hypothesis-1",
      expectedRevision: 1,
      entry: {
        kind: "hypothesis",
        state: "supported",
      },
      fileCitations: [],
    });
    expect(normalizeSecurityScanOperationArgs({
      version: "security-scan-v1",
      operation: "record",
      action: "update",
      recordId: "record_hypothesis-2",
      expectedRevision: 1,
      entry: {
        kind: "hypothesis",
        state: "rejected",
      },
      fileCitations: [],
    }, {
      latestLedgerRecord: {
        id: "record_counterevidence-1",
        kind: "counterevidence",
      },
    })).toEqual({
      version: "security-scan-v1",
      operation: "record",
      scanId: "scan_task_bound",
      action: "update",
      recordId: "record_hypothesis-2",
      expectedRevision: 1,
      entry: {
        kind: "hypothesis",
        state: "rejected",
        counterevidenceRefs: [{
          kind: "ledger_record",
          id: "record_counterevidence-1",
        }],
      },
      fileCitations: [],
    });
  });

  test("rejects direct invocation instead of accepting a model-supplied authority envelope", async () => {
    const tool = createSecurityScanTool();
    const invoke = (args: Record<string, unknown>): Promise<unknown> =>
      Promise.resolve().then((): unknown => tool.invoke(args));

    let spoofError: unknown = null;
    try {
      await invoke({
        ...operation(),
        taskId: "attacker-task",
        taskRunId: "attacker-run",
        modelId: "attacker-model",
        relayId: "attacker-relay",
      });
    } catch (error) {
      spoofError = error;
    }
    expect(spoofError).not.toBeNull();

    let directError: unknown = null;
    try {
      await invoke(operation());
    } catch (error) {
      directError = error;
    }
    expect(directError).toBeInstanceOf(Error);
    expect((directError as Error).message).toContain("security_scan is a Desktop relay tool");
  });

  test("injects only server-authored Task context and forwards Task cancellation", async () => {
    const catalog = new ToolCatalog();
    registerAllTools(catalog, { officeCliAvailable: () => false });
    initToolCatalog(catalog);
    const abortController = new AbortController();
    let captured: Record<string, unknown> | null = null;
    const registry = {
      findByCapabilityForUser: () => ["relay-security"],
      getCapabilities: () => ({
        profile: "desktop-agent",
        canReadWorkspace: true,
        canRunShell: true,
        allowedRoots: ["/Users/owner/project"],
        currentFolderRoot: "/Users/owner/project",
        workspaceRoot: "/Users/owner/workspace",
        securityLevel: "standard",
      }),
      isRelayHeartbeatFresh: () => true,
      getUserId: () => "owner",
      getRelaySessionId: () => "relay-session-security",
      getDesktopSessionId: () => "desktop-security",
      getPairingGeneration: () => "pairing-security",
      dispatch: async (_relayId: string, request: Record<string, unknown>) => {
        captured = request;
        return {
          status: "ok",
          result: {
            ok: false,
            operation: "start",
            error: {
              code: "model_unavailable",
              retryable: true,
              message: "The selected model is unavailable.",
            },
          },
        };
      },
    } as unknown as ToolRelayRegistry;
    setRelayRegistry(registry);
    const context = createServerToolInvocationContext(taskState(), () => ({ status: "allowed" }));

    const result = await createNautiloToolInvocationSession(context, {
      signal: abortController.signal,
    }).invoke({
      callId: CALL_ID,
      toolName: "security_scan",
      args: operation(),
      authorityRef: "receipt-security-scan",
    });

    expect(result.status).toBe("error");
    if (typeof result.content !== "string") throw new Error("expected a structured error receipt");
    expect(JSON.parse(result.content)).toMatchObject({ ok: false, error: { code: "model_unavailable" } });
    if (captured === null) throw new Error("expected security_scan relay dispatch");
    const request = captured as Record<string, unknown>;
    expect(request["args"]).toEqual({
      operation: operation(),
      trustedContext: {
        taskId: TASK_ID,
        taskRunId: TASK_RUN_ID,
        toolCallId: CALL_ID,
        modelId: MODEL_ID,
      },
      expectedCurrentFolder: "/Users/owner/project",
    });
    expect(request["signal"]).toBe(abortController.signal);
  });

  test("binds direct evidence to every bounded read since the last successful record", async () => {
    const catalog = new ToolCatalog();
    registerAllTools(catalog, { officeCliAvailable: () => false });
    initToolCatalog(catalog);
    let captured: Record<string, unknown> | null = null;
    setRelayRegistry({
      findByCapabilityForUser: () => ["relay-security"],
      getCapabilities: () => ({
        canReadWorkspace: true,
        currentFolderRoot: "/Users/owner/project",
        workspaceRoot: "/Users/owner/workspace",
      }),
      isRelayHeartbeatFresh: () => true,
      getUserId: () => "owner",
      getRelaySessionId: () => "relay-session-security",
      getDesktopSessionId: () => "desktop-security",
      getPairingGeneration: () => "pairing-security",
      dispatch: async (_relayId: string, request: Record<string, unknown>) => {
        captured = request;
        return {
          status: "ok",
          result: {
            ok: false,
            operation: "record",
            error: {
              code: "model_unavailable",
              retryable: true,
              message: "Fixture stopped after request capture.",
            },
          },
        };
      },
    } as unknown as ToolRelayRegistry);
    const messages = [
      new ToolMessage({
        name: "security_scan",
        tool_call_id: "record-before-reads",
        content: JSON.stringify({
          ok: true,
          operation: "record",
          result: { record: { id: "record_known" } },
        }),
      }),
      new AIMessage({
        content: "",
        tool_calls: [{ id: "read-auth", name: "file", args: { command: "read", path: "src/auth.ts", zone: "current" } }],
      }),
      new ToolMessage({
        name: "file",
        tool_call_id: "read-auth",
        content: "auth source\n<<< lines 1-40 of 90; metadata, not source >>>",
      }),
      new AIMessage({
        content: "",
        tool_calls: [{ id: "read-route", name: "file", args: { command: "read", path: "src/routes/jobs.ts", zone: "current" } }],
      }),
      new ToolMessage({
        name: "file",
        tool_call_id: "read-route",
        content: "route source\n<<< lines 20-80 of 140; metadata, not source >>>",
      }),
    ];
    const context = createServerToolInvocationContext(taskState({ messages }), () => ({ status: "allowed" }));

    await createNautiloToolInvocationSession(context).invoke({
      callId: CALL_ID,
      toolName: "security_scan",
      args: {
        version: "security-scan-v1",
        operation: "record",
        action: "append",
        entry: {
          kind: "evidence",
          summary: "The bounded reads establish the route authorization path.",
          evidenceRefs: [
            { kind: "code_evidence", id: "friendly_auth_name" },
          { kind: "ledger_record", id: "record_known" },
          ],
        },
      },
      authorityRef: "receipt-security-scan",
    });

    if (captured === null) throw new Error("expected security_scan relay dispatch");
    const request = captured as { args?: { operation?: Record<string, unknown> } };
    expect(request.args?.operation).toMatchObject({
      operation: "record",
      action: "append",
      entry: {
        kind: "evidence",
        summary: "The bounded reads establish the route authorization path.",
        evidenceRefs: [],
      },
      fileCitations: [{
        relativePath: "src/auth.ts",
        startLine: 1,
        endLine: 40,
      }, {
        relativePath: "src/routes/jobs.ts",
        startLine: 20,
        endLine: 80,
      }],
    });
  });

  test("refuses an absent durable Task context before any Desktop dispatch", async () => {
    const catalog = new ToolCatalog();
    registerAllTools(catalog, { officeCliAvailable: () => false });
    initToolCatalog(catalog);
    let dispatched = false;
    setRelayRegistry({
      findByCapabilityForUser: () => ["relay-security"],
      getCapabilities: () => ({
        canReadWorkspace: true,
        currentFolderRoot: "/Users/owner/project",
        workspaceRoot: "/Users/owner/workspace",
      }),
      isRelayHeartbeatFresh: () => true,
      getUserId: () => "owner",
      getRelaySessionId: () => "relay-session-security",
      getDesktopSessionId: () => "desktop-security",
      getPairingGeneration: () => "pairing-security",
      dispatch: async () => {
        dispatched = true;
        return { status: "ok", result: "unexpected" };
      },
    } as unknown as ToolRelayRegistry);
    const context = createServerToolInvocationContext(taskState({
      currentTaskId: "",
      currentTaskRunId: "",
    }), () => ({ status: "allowed" }));

    const result = await createNautiloToolInvocationSession(context).invoke({
      callId: CALL_ID,
      toolName: "security_scan",
      args: operation(),
      authorityRef: "receipt-security-scan",
    });

    expect(result.status).toBe("error");
    expect(result.content).toContain("Task-internal worker tool");
    expect(result.content).toContain("in_background");
    expect(dispatched).toBe(false);
  });

  test("returns operation-specific correction for invalid model arguments", async () => {
    const catalog = new ToolCatalog();
    registerAllTools(catalog, { officeCliAvailable: () => false });
    initToolCatalog(catalog);
    let dispatched = false;
    let dispatchedRequest: Record<string, unknown> | null = null;
    setRelayRegistry({
      findByCapabilityForUser: () => ["relay-security"],
      getCapabilities: () => ({
        canReadWorkspace: true,
        currentFolderRoot: "/Users/owner/project",
        workspaceRoot: "/Users/owner/workspace",
      }),
      isRelayHeartbeatFresh: () => true,
      getUserId: () => "owner",
      getRelaySessionId: () => "relay-session-security",
      getDesktopSessionId: () => "desktop-security",
      getPairingGeneration: () => "pairing-security",
      dispatch: async (_relayId: string, request: Record<string, unknown>) => {
        dispatched = true;
        dispatchedRequest = request;
        return { status: "ok", result: "unexpected" };
      },
    } as unknown as ToolRelayRegistry);

    const state = taskState({
        requiredHostRelays: {
          [CALL_ID]: "relay-security",
          "call-security-scan-invalid-record": "relay-security",
          "call-security-scan-invalid-unit": "relay-security",
          "call-security-scan-valid-unit": "relay-security",
        },
      });
    const invocation = createNautiloToolInvocationSession(
      createServerToolInvocationContext(state, () => ({ status: "allowed" })),
    );
    const result = await invocation.invoke({
      callId: CALL_ID,
      toolName: "security_scan",
      args: {},
      authorityRef: "receipt-security-scan",
    });

    expect(result.status).toBe("error");
    if (typeof result.content !== "string") throw new Error("Expected a serialized control receipt");
    const correction = JSON.parse(result.content) as { error: { message: string } };
    expect(correction).toMatchObject({ ok: false, operation: "local_tool_control", toolName: "security_scan", notDispatched: true });
    expect(correction.error.message).toContain("security_scan received invalid arguments");
    expect(correction.error.message).toContain("Choose the operation matching your intended action");
    expect(correction.error.message).not.toContain('"operation":"start"');

    const invalidRecord = await invocation.invoke({
      callId: "call-security-scan-invalid-record",
      toolName: "security_scan",
      args: {
        version: "security-scan-v1",
        operation: "record",
        scanId: "scan_demo-1",
        action: "append",
        entry: { kind: "dismissal", evidenceRefs: [], counterevidenceRefs: [] },
      },
      authorityRef: "receipt-security-scan-invalid-record",
    });
    expect(invalidRecord.status).toBe("error");
    expect(invalidRecord.content).toContain("retry the corrected record operation");
    expect(invalidRecord.content).toContain("Do not send scanId; the server binds this TaskRun to its scan");
    expect(invalidRecord.content).toContain("Do not start, finalize, or reopen a scan");

    const unitArgs = { version: "security-scan-v1", operation: "record", action: "append", entry: {
      kind: "review_unit",
      trace: "Request identity -> permission decision -> document lookup.",
      notes: "Preserve this causal analysis and its counterevidence without shortening it. ".repeat(100),
    } };
    const originalArgs = JSON.stringify(unitArgs);
    const unitCallId = "call-security-scan-invalid-unit";
    const invalidUnit = await invocation.invoke({ callId: unitCallId, toolName: "security_scan", args: unitArgs, authorityRef: "receipt-security-scan-invalid-unit" });
    expect(invalidUnit.status).toBe("error");
    if (typeof invalidUnit.content !== "string") throw Error("Expected the exact validation correction");
    const unitCorrection = localToolControlReceiptSchema.parse(JSON.parse(invalidUnit.content));
    expect(unitCorrection).toMatchObject({ requestedOperation: "record", notDispatched: true, error: { code: "invalid_request" } });
    // Four failures prove the invocation does not silently discard diagnostics
    // after the first three; harmless append defaults do not hide substantive omissions.
    for (const field of ["summary", "surfaceKey", "paths", "state"]) expect(unitCorrection.error.message).toContain(`entry.${field}:`);
    for (const field of ["evidenceRefs", "counterevidenceRefs", "openRecordIds"]) expect(unitCorrection.error.message).not.toContain(`entry.${field}:`);
    expect(unitCorrection.error.message).not.toContain("appends require a complete kind-valid entry");
    expect(JSON.stringify(unitArgs)).toBe(originalArgs);
    state.subagentRun = true; state.toolWhitelist = ["security_scan"];
    const rejectedCall = new AIMessage({ id: "rejected-unit-ai", content: "Additional unresolved reasoning remains part of this draft.",
      tool_calls: [{ id: unitCallId, name: "security_scan", args: unitArgs }] });
    const rejectedReceipt = new ToolMessage({ id: "rejected-unit-result", tool_call_id: invalidUnit.callId, name: invalidUnit.toolName,
      content: invalidUnit.content, status: invalidUnit.status, ...(invalidUnit.additionalKwargs ? { additional_kwargs: invalidUnit.additionalKwargs } : {}) });
    state.messages.push(rejectedCall, rejectedReceipt);
    const canonical = JSON.stringify(state.messages);
    const restored = restoreResearchContextControlCycle(state, []);
    expect(restored).toContain(rejectedCall); expect(restored).toContain(rejectedReceipt);
    const descriptor = describeResearchContextMessage(state, state.messages.indexOf(rejectedCall))!;
    const exact = readResearchContext(state, { version: "security-scan-v1", operation: "context", contextRef: descriptor.ref }, { maxPageBytes: 24000 });
    expect(exact.ok && exact.result.text).toBe(serializeResearchContextMessage(rejectedCall)!);
    expect(JSON.stringify(state.messages)).toBe(canonical);
    expect(dispatched).toBe(false);
    const validEntry = { ...unitArgs.entry, summary: "Trace project sharing authorization", surfaceKey: "sharing", paths: ["sharing.ts"], state: "in_progress" };
    await invocation.invoke({ callId: "call-security-scan-valid-unit", toolName: "security_scan", args: { ...unitArgs, entry: validEntry }, authorityRef: "receipt-security-scan-valid-unit" });
    expect(dispatched).toBe(true);
    expect(dispatchedRequest).toMatchObject({ args: { operation: { operation: "record", action: "append", entry: {
      ...validEntry, evidenceRefs: [], counterevidenceRefs: [], openRecordIds: [],
    } } } });
  });
});


test("review units preserve behavioral scope, notes and follow-ups through normalization", () => {
  const entry = { kind: "review_unit", summary: "Export authorization", surfaceKey: "exports",
    paths: ["src/api.ts", "src/worker.ts"], state: "in_progress", trace: "Following queued caller into worker",
    notes: "Worker authority remains to inspect", evidenceRefs: [], counterevidenceRefs: [], openRecordIds: ["record_followup"] };
  expect(normalizeSecurityScanOperationArgs({ version: "security-scan-v1", operation: "record", action: "append", entry }))
    .toEqual({ version: "security-scan-v1", operation: "record", action: "append", scanId: "scan_task_bound", entry });
  expect(normalizeSecurityScanOperationArgs({ version: "security-scan-v1", operation: "results", category: "inventory", continueResults: true }, { nextResultsCursor: "cursor_inventory" }))
    .toMatchObject({ category: "inventory", cursor: "cursor_inventory" });
});


test("provider and canonical record schemas preserve accumulated evidence links without a count ceiling", () => {
  const refs = Array.from({ length: 47 }, (_, index) => ({ kind: "ledger_record" as const, id: `record_note_${index}` }));
  const args = { version: "security-scan-v1", operation: "record", action: "update", recordId: "record_review",
    expectedRevision: 2, entry: { kind: "review_unit", summary: "Continue the same behavior trace.", evidenceRefs: refs, counterevidenceRefs: refs } };
  const modelParsed = (createSecurityScanTool().schema as { parse(input: unknown): unknown }).parse(args) as typeof args;
  expect(modelParsed.entry.evidenceRefs).toEqual(refs);
  expect(modelParsed.entry.counterevidenceRefs).toEqual(refs);
  const canonical = securityScanOperationSchema.parse(normalizeSecurityScanOperationArgs(modelParsed));
  if (canonical.operation !== "record") throw new Error("Expected record");
  expect(canonical.entry.evidenceRefs).toEqual(refs);
  expect(canonical.entry.counterevidenceRefs).toEqual(refs);
  const overflow = securityScanOperationSchema.safeParse({ ...canonical, fileCitations: Array.from({ length: SECURITY_SCAN_MAX_FILE_CITATIONS_PER_CALL + 1 },
    (_, index) => ({ relativePath: `src/source-${index}.ts`, startLine: 1, endLine: 1 })) });
  expect(overflow.success).toBe(false);
  if (!overflow.success) expect(overflow.error.issues[0]?.message).toContain("successive record updates");
});


test("provider handoff schema preserves exact assignments, review decisions and complete report drafts without a text cap", () => {
  const schema = createSecurityScanTool().schema as { parse(input: unknown): unknown };
  const handoff = { version: "security-scan-v1", operation: "handoff", role: "investigator", handoffRecordId: "checkpoint_current",
    unitRecordId: "unit_identity", expectedRevision: 3, seedRecordIds: ["evidence_guard"] };
  expect(schema.parse(handoff)).toEqual(handoff);
  const draft = "# Full report\nDetailed verified findings, counterevidence and limitations.\n".repeat(2000).trim();
  const review = { version: "security-scan-v1", operation: "handoff", role: "reviewer", handoffRecordId: "checkpoint_report", reportDraft: draft };
  expect(schema.parse(review)).toEqual(review);
  expect(schema.parse({ version: "security-scan-v1", operation: "handoff", role: "coordinator", handoffRecordId: "checkpoint_review", reviewDecision: "follow_up" }))
    .toMatchObject({ reviewDecision: "follow_up" });
  const wire = convertToOpenAITool(createSecurityScanTool()).function.parameters as { properties: Record<string, Record<string, unknown>> };
  expect(wire.properties["reportDraft"]?.["maxLength"]).toBeUndefined();
  expect(wire.properties["role"]?.["enum"]).toEqual(["coordinator", "investigator", "reviewer"]);
});

test("provider and durable record schemas preserve substantive multiline notes without semantic text ceilings", () => {
  const note = "\n\tObserved caller → queue → authorization → output. π Counterexamples and unresolved assumptions remain explicit.\n".repeat(80);
  expect(note.length).toBeGreaterThan(2475);
  const schema = createSecurityScanTool().schema as { parse(input: unknown): unknown };
  for (const entry of [
    { kind: "checkpoint", summary: note, nextWork: note, openRecordIds: [], evidenceRefs: [] },
    { kind: "review_unit", summary: note, surfaceKey: "identity", paths: ["src/identity.ts"], state: "in_progress", trace: note,
      notes: note, blocker: note, evidenceRefs: [], counterevidenceRefs: [], openRecordIds: [] },
    { kind: "repository_map", summary: note, surfaces: [{ key: "identity", label: note, coverage: "unreviewed", rationale: note }], evidenceRefs: [] },
    { kind: "open_question", question: note, resolution: note, evidenceRefs: [] },
    { kind: "finding", title: note, summary: note, confidence: "high", impact: note, exploitPreconditions: note,
      evidenceRefs: [{ kind: "ledger_record", id: "evidence_observed" }], counterevidenceRefs: [] },
  ]) {
    const args = { version: "security-scan-v1", operation: "record", action: "append", entry };
    expect(schema.parse(args)).toEqual(args);
    expect(securityScanOperationSchema.parse(normalizeSecurityScanOperationArgs(args))).toMatchObject({ entry });
  }
  const wire = convertToOpenAITool(createSecurityScanTool()).function.parameters as {
    properties: { entry: { properties: Record<string, { maxLength?: number; items?: { properties: Record<string, { maxLength?: number }> } }> } };
  };
  for (const field of ["title", "summary", "question", "impact", "exploitPreconditions", "rationale", "resolution", "blocker", "nextWork", "trace", "notes"]) {
    expect(wire.properties.entry.properties[field]?.maxLength).toBeUndefined();
  }
  expect(wire.properties.entry.properties["surfaces"]?.items?.properties["label"]?.maxLength).toBeUndefined();
  expect(wire.properties.entry.properties["surfaces"]?.items?.properties["rationale"]?.maxLength).toBeUndefined();
  const checkpoint = { version: "security-scan-v1", operation: "record", action: "append",
    entry: { kind: "checkpoint", summary: " \n\t", nextWork: note, openRecordIds: [], evidenceRefs: [] } };
  expect(() => schema.parse(checkpoint)).toThrow();
  expect(() => schema.parse({ ...checkpoint, entry: { ...checkpoint.entry, summary: "text\u0000hidden" } })).toThrow();
  expect(() => schema.parse({ ...checkpoint, entry: { ...checkpoint.entry, summary: note, openRecordIds: ["not an identifier"] } })).toThrow();
});

test("provider record patches do not require unchanged summary or a summary belonging to another kind", () => {
  const schema = createSecurityScanTool().schema as { parse(input: unknown): unknown };
  const patch = { version: "security-scan-v1", operation: "record", action: "update", recordId: "hypothesis_identity", expectedRevision: 2,
    entry: { kind: "hypothesis", state: "rejected" } };
  expect(schema.parse(patch)).toEqual(patch);
  expect(securityScanOperationSchema.parse(normalizeSecurityScanOperationArgs(patch))).toMatchObject({ entry: patch.entry });
  const coverage = { version: "security-scan-v1", operation: "record", action: "append", entry: { kind: "coverage", surfaceKey: "identity", state: "in_progress", rationale: "More callers remain", evidenceRefs: [] } };
  expect(schema.parse(coverage)).toEqual(coverage);
  expect(securityScanOperationSchema.parse(normalizeSecurityScanOperationArgs(coverage))).toMatchObject({ entry: coverage.entry });
});

test("repository maps preserve more than thirty-two sections in provider append and patch contracts", () => {
  const surfaces = Array.from({ length: 40 }, (_, index) => ({ key: `section_${index}`, label: `Behavior ${index}`,
    coverage: "unreviewed", rationale: "Investigate this behavior and its linked dependencies." }));
  const schema = createSecurityScanTool().schema as { parse(input: unknown): unknown };
  for (const action of ["append", "update"]) {
    const args = { version: "security-scan-v1", operation: "record", action,
      ...(action === "update" ? { recordId: "map_current", expectedRevision: 1 } : {}),
      entry: { kind: "repository_map", summary: "Behavior plan across the repository.", surfaces, evidenceRefs: [] } };
    expect(schema.parse(args)).toEqual(args);
    expect(securityScanOperationSchema.parse(normalizeSecurityScanOperationArgs(args))).toMatchObject({ entry: { surfaces } });
  }
  const wire = convertToOpenAITool(createSecurityScanTool()).function.parameters as {
    properties: { entry: { properties: { surfaces: { maxItems?: number } } } };
  };
  expect(wire.properties.entry.properties.surfaces.maxItems).toBeUndefined();
});

test("review-unit append defaults carry empty references while updates remain sparse and reviewed remains an explicit claim", () => {
  const entry = { kind: "review_unit", summary: "Investigate project sharing", surfaceKey: "sharing", paths: ["sharing.ts"], state: "in_progress",
    trace: "Caller identity -> membership -> sharing lookup", notes: "Unverified hypothesis and remaining caller review." };
  const args = { version: "security-scan-v1", operation: "record", action: "append", entry };
  const original = JSON.stringify(args);
  const normalized = securityScanOperationSchema.parse(normalizeSecurityScanOperationArgs(args));
  expect(normalized).toMatchObject({ entry: { ...entry, evidenceRefs: [], counterevidenceRefs: [], openRecordIds: [] } });
  expect(JSON.stringify(args)).toBe(original);
  const patch = { version: "security-scan-v1", operation: "record", action: "update", recordId: "unit_sharing", expectedRevision: 2, entry: { kind: "review_unit", notes: "Additional observed counterexample." } };
  expect(securityScanOperationSchema.parse(normalizeSecurityScanOperationArgs(patch))).toMatchObject({ entry: patch.entry });
  const normalizedPatch = normalizeSecurityScanOperationArgs(patch)["entry"];
  for (const field of ["evidenceRefs", "counterevidenceRefs", "openRecordIds", "state"]) expect(normalizedPatch).not.toHaveProperty(field);
  const missingState = { ...entry } as Record<string, unknown>; delete missingState["state"];
  expect(securityScanOperationSchema.safeParse(normalizeSecurityScanOperationArgs({ ...args, entry: missingState })).success).toBe(false);
});

test("invalid operation feedback preserves an existing scan and local context/handoff intent", async () => {
  const catalog = new ToolCatalog(); registerAllTools(catalog, { officeCliAvailable: () => false }); initToolCatalog(catalog);
  let dispatches = 0;
  setRelayRegistry({ findByCapabilityForUser: () => ["relay-security"],
    getCapabilities: () => ({ canReadWorkspace: true, currentFolderRoot: "/Users/owner/project", workspaceRoot: "/Users/owner/workspace" }),
    isRelayHeartbeatFresh: () => true, getUserId: () => "owner", getRelaySessionId: () => "relay-session-security",
    getDesktopSessionId: () => "desktop-security", getPairingGeneration: () => "pairing-security",
    dispatch: async () => { dispatches++; return { status: "ok", result: "unexpected" }; },
  } as unknown as ToolRelayRegistry);
  const messages = [new AIMessage({ id: "bound-start-ai", content: "", tool_calls: [{ id: "bound-start", name: "security_scan", args: operation() }] }),
    new ToolMessage({ id: "bound-start-result", tool_call_id: "bound-start", name: "security_scan", status: "success", content: JSON.stringify({ ok: true, operation: "start", result: {
      version: "security-scan-v1", scanId: "scan_existing", state: "active", phase: "researching", terminalState: null, mode: "deep_research", modelId: MODEL_ID,
      modelState: "running", completedSteps: 1, totalSteps: 2, lanes: SECURITY_SCAN_INITIAL_LANES, coverage: [], hypotheses: [],
    } }) })];
  const state = taskState({ messages, subagentRun: true, toolWhitelist: ["security_scan"] });
  const original = JSON.stringify(messages);
  const invoke = (args: Record<string, unknown>, target = state) => createNautiloToolInvocationSession(createServerToolInvocationContext(target, () => ({ status: "allowed" })))
    .invoke({ callId: CALL_ID, toolName: "security_scan", args, authorityRef: "receipt-operation-correction" });
  for (const args of [{ version: "security-scan-v1", operation: "review" }, {},
    { action: "append", entry: { kind: "review_unit", notes: "Keep these substantive notes while correcting the missing operation." } }]) {
    const originalArgs = JSON.stringify(args);
    const result = await invoke(args);
    expect(result.status).toBe("error");
    const receipt = localToolControlReceiptSchema.parse(JSON.parse(result.content as string));
    expect(receipt).toMatchObject({ notDispatched: true, error: { code: "invalid_request" } });
    expect(receipt.error.message).toContain("operation:");
    expect(receipt.error.message).toContain("Choose the operation matching your intended action");
    for (const name of [...securityScanOperationSchema.options.map((schema) => schema.shape.operation.value), "context", "handoff"]) expect(receipt.error.message).toContain(name);
    expect(receipt.error.message).not.toContain('"operation":"start"');
    expect(receipt.error.message).not.toContain("To begin");
    expect(JSON.stringify(args)).toBe(originalArgs);
  }
  for (const args of [{ version: "security-scan-v1", operation: "context", contextBytes: 0 }, { version: "security-scan-v1", operation: "handoff", role: "invalid" }]) {
    const result = await invoke(args);
    expect(result.status).toBe("error");
    const receipt = JSON.parse(result.content as string) as { operation: string; error: { message: string } };
    expect(receipt.operation).toBe(args.operation);
    expect(receipt.error.message).toContain(args.operation === "context" ? "contextRef" : "handoffRecordId");
    expect(receipt.error.message).not.toContain('"operation":"start"');
    expect(receipt.error.message).not.toContain("To begin");
  }
  const started = await invoke({ version: "security-scan-v1", operation: "start", mode: "deep_research" }, taskState());
  expect(started.status).toBe("error");
  const starter = localToolControlReceiptSchema.parse(JSON.parse(started.content as string));
  expect(starter.error.message).toContain("targetDirectory:");
  expect(starter.error.message).toContain("for the requested start operation");
  expect(starter.error.message).toContain('"operation":"start"');
  expect(starter.error.message).not.toContain("once");

  // The provider put operation/version inside the checkpoint entry. Recovery
  // cannot be resolved by this malformed call; expose the real correction.
  const malformed = { action: "append", entry: { kind: "checkpoint", operation: "record", version: "security-scan-v1",
    summary: "Preserve the complete investigation and unresolved questions.\n".repeat(100),
    nextWork: "Continue the assigned behavior after consolidating source.", evidenceRefs: [], openRecordIds: [] } };
  const rejectedCall = new AIMessage({ id: "malformed-checkpoint", content: "Keep these notes intact while correcting the call.",
    tool_calls: [{ id: CALL_ID, name: "security_scan", args: malformed }] });
  const recovering = taskState({ messages: [...messages, new AIMessage({ id: "unread-research", content: "Unsaved historical source analysis." }), rejectedCall],
    subagentRun: true, toolWhitelist: ["security_scan", "file"], activatedToolNames: ["security_scan", "file"] });
  recovering.researchContextRecovery = { taskRunId: TASK_RUN_ID, throughIndex: 2,
    indexRef: describeResearchContextIndex(recovering, 2)!.ref, pendingRefs: [describeResearchContextMessage(recovering, 2)!.ref] };
  const beforeRecovery = JSON.stringify(recovering.messages);
  const rawArguments = JSON.stringify(malformed);
  const invalid = await invoke(malformed, recovering);
  expect(invalid.status).toBe("error");
  const invalidReceipt = localToolControlReceiptSchema.parse(JSON.parse(invalid.content as string));
  expect(invalidReceipt).toMatchObject({ notDispatched: true, error: { code: "invalid_request" } });
  expect(invalidReceipt.error.message).toContain("operation:");
  expect(invalidReceipt.error.message).toContain("Choose the operation matching your intended action");
  expect(invalidReceipt.error.message).not.toContain('"operation":"start"');
  expect(JSON.stringify(malformed)).toBe(rawArguments);
  expect(JSON.stringify(recovering.messages)).toBe(beforeRecovery);
  const exact = readResearchContext(recovering, { version: "security-scan-v1", operation: "context", contextRef: describeResearchContextMessage(recovering, 3)!.ref }, { maxPageBytes: 20000 });
  expect(exact.ok && exact.result.text).toBe(serializeResearchContextMessage(rejectedCall)!);
  expect(exact.ok && exact.result.text).toContain(malformed.entry.summary.replaceAll("\n", "\\n"));
  // A real provider added the record-only action field to an otherwise valid
  // handoff. Its shape correction must not be hidden behind unrelated recovery.
  const malformedHandoff = { version: "security-scan-v1", operation: "handoff", action: "handoff",
    role: "investigator", handoffRecordId: "current_plan", unitRecordId: "unit_known", expectedRevision: 1 };
  const handoffState = { ...recovering, messages: [...recovering.messages.slice(0, -1), new AIMessage({ id: "malformed-handoff",
    content: "Assign the planned behavior.", tool_calls: [{ id: CALL_ID, name: "security_scan", args: malformedHandoff }] })] };
  const handoffBefore = JSON.stringify(handoffState);
  const handoffRejected = await invoke(malformedHandoff, handoffState);
  const handoffError = localToolControlReceiptSchema.parse(JSON.parse(handoffRejected.content as string));
  expect(handoffRejected.status).toBe("error");
  expect(handoffError).toMatchObject({ notDispatched: true, error: { code: "invalid_request" } });
  expect(handoffError.error.message).toContain('Unrecognized key: "action"');
  expect(handoffError.error.message).not.toContain("Context recovery is active");
  expect(JSON.stringify(handoffState)).toBe(handoffBefore);
  expect(malformedHandoff.action).toBe("handoff");
  for (const args of [operation(), { version: "security-scan-v1", operation: "results", category: "all", finalize: true },
    { version: "security-scan-v1", operation: "handoff", role: "investigator", handoffRecordId: "current_plan", unitRecordId: "unit_known", expectedRevision: 1 }]) {
    const blocked = await invoke(args, recovering);
    expect(blocked.status).toBe("error");
    expect(localToolControlReceiptSchema.parse(JSON.parse(blocked.content as string))).toMatchObject({ notDispatched: true, error: { code: "context_recovery_pending" } });
  }
  const blockedRead = await createNautiloToolInvocationSession(createServerToolInvocationContext(recovering, () => ({ status: "allowed" })))
    .invoke({ callId: CALL_ID, toolName: "file", args: { command: "read", path: "source.ts" }, authorityRef: "receipt-blocked-read" });
  expect(blockedRead.status).toBe("error");
  expect(localToolControlReceiptSchema.parse(JSON.parse(blockedRead.content as string)).error.code).toBe("context_recovery_pending");
  const invalidContext = await invoke({ version: "security-scan-v1", operation: "context", contextBytes: 0 }, recovering);
  expect(invalidContext.status).toBe("error");
  expect(JSON.parse(invalidContext.content as string)).toMatchObject({ operation: "context", ok: false, error: { code: "invalid_request" } });
  expect(JSON.stringify(recovering.messages)).toBe(beforeRecovery);
  expect(JSON.stringify(messages)).toBe(original);
  expect(dispatches).toBe(0);
});


test("malformed update identity is rejected rather than silently appended", () => {
  const entry = { kind: "hypothesis", summary: "Existing supported claim", state: "supported", evidenceRefs: [], counterevidenceRefs: [] };
  for (const args of [
    { entry: { ...entry, recordId: "record_original", expectedRevision: 1 } },
    { entry, recordId: "record_original", expectedRevision: 1 },
    { action: "append", entry, recordId: "record_original", expectedRevision: 1 },
    { action: "update", recordId: "record_original", expectedRevision: 1, entry: { ...entry, recordId: "record_other" } },
  ]) {
    expect(securityScanOperationSchema.safeParse(normalizeSecurityScanOperationArgs({ version: "security-scan-v1", operation: "record", ...args })).success).toBe(false);
  }
  expect(securityScanOperationSchema.parse(normalizeSecurityScanOperationArgs({ version: "security-scan-v1", operation: "record",
    action: "update", recordId: "record_original", expectedRevision: 1, entry: { kind: "hypothesis", counterevidenceRefs: [] } })))
    .toMatchObject({ action: "update", recordId: "record_original", expectedRevision: 1 });
});

test("a lost research Desktop interrupts before model/tool retries without changing saved work", () => {
  const state = taskState({ taskRun: true, researchWorkEnabled: true });
  setRelayRegistry(null);
  expect(() => assertResearchDesktopAvailable(state)).toThrow(RelayUnavailableError);
  expect(state.messages).toEqual([]);
  expect(() => assertResearchDesktopAvailable({ ...state, taskRun: false })).not.toThrow();
  setRelayRegistry({ isRelayHeartbeatFresh: () => false, getRelaySessionId: () => "stale-session" } as unknown as ToolRelayRegistry);
  expect(() => assertResearchDesktopAvailable(state)).toThrow("heartbeat expired");
});


test("disconnected research dispatch rejects before invoking any tool or producing a retry error", async () => {
  const catalog = new ToolCatalog();
  registerAllTools(catalog, { officeCliAvailable: () => false });
  initToolCatalog(catalog);
  const state = taskState({ taskRun: true, researchWorkEnabled: true });
  setRelayRegistry(null);
  let authorityCalls = 0;
  const session = createNautiloToolInvocationSession(createServerToolInvocationContext(state, () => {
    authorityCalls++; return { status: "allowed" };
  }));
  const failure = await session.invoke({ callId: CALL_ID, toolName: "security_scan", args: operation(), authorityRef: "saved-admission" }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(RelayUnavailableError);
  expect(authorityCalls).toBe(0);
});
