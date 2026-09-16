import { runWithTaskCreationReturnContext } from "../../src/runtime/task-creation-return-context";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as db from "@nautilo/db";
import { createInScopeTool } from "../../src/tools/tasks/shortcuts/in-scope";
import { createInPrivateNamespaceTool } from "../../src/tools/tasks/shortcuts/in-private-namespace";
import { createInBackgroundTool } from "../../src/tools/tasks/shortcuts/in-background";
import { createAskPeerTool } from "../../src/tools/tasks/shortcuts/ask-peer";
import { createScheduleTool } from "../../src/tools/tasks/shortcuts/schedule";
import { createGenerateRepoDocsTool } from "../../src/tools/tasks/shortcuts/generate-repo-docs";
import * as shareArtifact from "../../src/tools/file/share-artifact";
import {
  setTaskToolRuntime,
  type TaskToolCreateInput,
  type TaskToolHarnessCreateInput,
} from "../../src/tools/tasks/task-tool-runtime";

const OWNER_ID = "10000000-0000-4000-8000-000000000001";
const AGENT_ID = "20000000-0000-4000-8000-000000000002";
const ROOM_ID = "30000000-0000-4000-8000-000000000003";

const CTX = { ownerId: OWNER_ID, agentId: AGENT_ID, roomId: ROOM_ID };

describe("task intent shortcuts (M144)", () => {
  let capturedCreate: TaskToolCreateInput | null = null;
  let capturedHarnessCreate: TaskToolHarnessCreateInput | null = null;
  const restores: Array<() => void> = [];

  afterEach(() => {
    setTaskToolRuntime(null);
    capturedCreate = null;
    capturedHarnessCreate = null;
    while (restores.length) restores.pop()!();
  });

  function stubRuntime(options?: {
    harnessFailure?: string;
    omitHarness?: boolean;
    createFailure?: string;
  }) {
    setTaskToolRuntime({
      db: {} as never,
      createTask: async (input) => {
        capturedCreate = input;
        if (options?.createFailure) throw new Error(options.createFailure);
        return { taskId: "t1", status: "pending" };
      },
      ...(options?.omitHarness
        ? {}
        : {
            createHarnessTask: async (input: TaskToolHarnessCreateInput) => {
              capturedHarnessCreate = input;
              if (options?.harnessFailure) throw new Error(options.harnessFailure);
              return { taskId: "codex-t1", status: "pending", execution: "codex" as const };
            },
          }),
      computeNextFireAt: () => new Date(),
      pauseTask: async () => ({ ok: true, status: "paused", message: "" }),
      unpauseTask: async () => ({ ok: true, status: "pending", message: "" }),
      stopTask: async () => ({ ok: true, status: "cancelled", message: "" }),
    });
  }

  test("security retry without a fresh Desktop origin creates no task", async () => {
    stubRuntime();
    const result = await createInBackgroundTool(CTX).invoke({ brief: "retry scan", tools: ["file", "security_scan"] });
    expect(result).toContain("No task was created");
    expect(result).toContain("fresh request");
    expect(capturedCreate).toBeNull();
  });

  test("security scan scope mismatch cannot suggest dropping the target; acceptance is not scan startup", async () => {
    stubRuntime();
    await runWithTaskCreationReturnContext({ ownerId: OWNER_ID, relayId: "relay", relaySessionId: "session",
      desktopSessionId: "desktop", pairingGeneration: "pairing", currentFolder: "/projects", workspacePath: "/workspace" }, async () => {
      const tool = createInBackgroundTool({ ...CTX, currentFolder: "/projects" });
      const mismatch = await tool.invoke({ brief: "scan repo", tools: ["file", "security_scan"], working_directory: "/projects/repo" });
      expect(mismatch).toContain("targetDirectory");
      expect(capturedCreate).toBeNull();
      const accepted = JSON.parse(await tool.invoke({ brief: "scan projects", tools: ["file", "security_scan"], working_directory: "/projects" })) as { message: string };
      expect(accepted.message).toContain("does not confirm that scanners started");
      expect(capturedCreate).not.toBeNull();
    });
  });

  test("in_scope name", () => {
    expect(createInScopeTool().name).toBe("in_scope");
  });

  test("in_scope input shape", async () => {
    stubRuntime();
    await createInScopeTool(CTX).invoke({
      brief: "do x",
      tools: ["search_memory"],
    });
    expect(capturedCreate).toMatchObject({
      ownerId: OWNER_ID,
      requestorId: OWNER_ID,
      agentId: AGENT_ID,
      prompt: "do x",
      preset: "in_scope",
      scheduleKind: "now",
      useScope: true,
      scopeId: null,
      toolsMode: "whitelist",
      toolsWhitelist: ["search_memory"],
      targetChat: "orphan",
      awaitResponse: false,
      callingRoomId: ROOM_ID,
      targetUserIds: [OWNER_ID],
      depth: 0,
    });
  });

  test("in_scope passes scope_id when provided", async () => {
    stubRuntime();
    await createInScopeTool(CTX).invoke({
      brief: "x",
      tools: [],
      scope_id: "scope-123",
    });
    expect(capturedCreate?.scopeId).toBe("scope-123");
    expect(capturedCreate?.toolsWhitelist).toEqual([]);
    expect(capturedCreate?.toolsMode).toBe("whitelist");
  });

  test("in_scope expected_output", async () => {
    stubRuntime();
    await createInScopeTool(CTX).invoke({
      brief: "x",
      tools: [],
      expected_output: "a summary",
    });
    expect(capturedCreate?.expectedOutput).toBe("a summary");
  });

  test("in_private_namespace name", () => {
    expect(createInPrivateNamespaceTool().name).toBe("in_private_namespace");
  });

  test("in_private_namespace default bring_back true", async () => {
    stubRuntime();
    await createInPrivateNamespaceTool(CTX).invoke({ brief: "find passport" });
    expect(capturedCreate).toMatchObject({
      preset: "in_private_namespace",
      useScope: false,
      toolsMode: "auto",
      targetChat: "orphan",
      callingRoomId: ROOM_ID,
      targetUserIds: [OWNER_ID],
      metadata: { bringBack: true },
    });
  });

  test("in_private_namespace bring_back false", async () => {
    stubRuntime();
    await createInPrivateNamespaceTool(CTX).invoke({
      brief: "x",
      bring_back: false,
    });
    expect(capturedCreate?.metadata).toEqual({ bringBack: false });
  });

  test("in_background name", () => {
    expect(createInBackgroundTool().name).toBe("in_background");
  });

  test("in_background remains Codex-only and does not widen to Hermes ACP", () => {
    expect(createInBackgroundTool().schema.safeParse({
      brief: "x",
      harness: "hermes-acp",
    }).success).toBe(false);
  });

  test("in_background default (no tools)", async () => {
    stubRuntime();
    const raw = await createInBackgroundTool(CTX).invoke({ brief: "summarize email" });
    expect(capturedCreate).toMatchObject({
      preset: "in_background",
      useScope: false,
      toolsMode: "auto",
      targetChat: "orphan",
      resultDelivery: "raw_and_wake",
      callingRoomId: ROOM_ID,
      targetUserIds: [OWNER_ID],
      depth: 0,
    });
    expect(capturedCreate?.toolsWhitelist).toBeUndefined();
    expect(capturedHarnessCreate).toBeNull();
    expect(JSON.parse(String(raw))).toMatchObject({
      taskId: "t1",
      execution: "native",
    });
  });

  test("in_background keeps root lineage unchanged outside a Task", async () => {
    stubRuntime();
    await createInBackgroundTool(CTX).invoke({ brief: "root work" });
    expect(capturedCreate).toMatchObject({ depth: 0 });
    expect(capturedCreate?.parentTaskId).toBeUndefined();
  });

  test("in_background derives nested lineage from the canonical current Task", async () => {
    stubRuntime();
    const parentSp = spyOn(db, "getTaskById").mockResolvedValue({
      id: "parent-task",
      ownerId: OWNER_ID,
      depth: 2,
    } as never);
    restores.push(() => parentSp.mockRestore());
    await createInBackgroundTool({
      ...CTX,
      currentTaskId: "parent-task",
      currentTaskRunId: "parent-run",
    }).invoke({ brief: "nested work" });
    expect(parentSp).toHaveBeenCalledWith(expect.anything(), "parent-task");
    expect(capturedCreate).toMatchObject({ parentTaskId: "parent-task", depth: 3 });
  });

  test("in_background routes exact Codex selection through server-owned harness admission", async () => {
    stubRuntime();
    const raw = await createInBackgroundTool(CTX).invoke({
      brief: "refactor the parser",
      harness: "codex",
      working_directory: "/projects/nautilo",
    });

    expect(capturedCreate).toBeNull();
    expect(capturedHarnessCreate).toEqual({
      ownerId: OWNER_ID,
      requestorId: OWNER_ID,
      agentId: AGENT_ID,
      prompt: "refactor the parser",
      preset: "in_background",
      scheduleKind: "now",
      callingRoomId: ROOM_ID,
      awaitResponse: false,
      depth: 0,
      harness: "codex",
      collaborationMode: "work",
      workingDirectory: "/projects/nautilo",
    });
    expect(JSON.parse(raw)).toMatchObject({
      taskId: "codex-t1",
      status: "pending",
      execution: "codex",
    });
  });

  test.each([
    [{ tools: [] }, "tools"],
    [{ result_delivery: "raw" as const }, "result_delivery"],
    [{ model_selection: "cheapest" as const }, "model_selection"],
    [{ model_id: "anthropic/claude-sonnet-4.5" }, "model_id"],
  ])("in_background rejects Native-only %s for Codex without invoking either executor", async (extra, field) => {
    stubRuntime();
    const raw = await createInBackgroundTool(CTX).invoke({
      brief: "x",
      harness: "codex",
      ...extra,
    });

    expect(raw).toContain(`${field}`);
    expect(raw).toContain("Native-only");
    expect(capturedCreate).toBeNull();
    expect(capturedHarnessCreate).toBeNull();
  });

  test("in_background accepts the exact Native Current Folder as an assertion", async () => {
    stubRuntime();
    const raw = await createInBackgroundTool({
      ...CTX,
      currentFolder: "/projects/nautilo",
    }).invoke({
      brief: "x",
      working_directory: "/projects/nautilo",
    });
    expect(JSON.parse(raw)).toMatchObject({ taskId: "t1", execution: "native" });
    expect(capturedCreate).toMatchObject({ prompt: "x", preset: "in_background" });
  });

  test("in_background rejects a different working directory on Native", async () => {
    stubRuntime();
    const raw = await createInBackgroundTool({
      ...CTX,
      currentFolder: "/projects/current",
    }).invoke({
      brief: "x",
      working_directory: "/projects/other",
    });
    expect(raw).toContain("must exactly match the selected Current Folder");
    expect(capturedCreate).toBeNull();
  });

  test("in_background never falls back to Native when Codex is unavailable", async () => {
    stubRuntime({ omitHarness: true });
    const raw = await createInBackgroundTool(CTX).invoke({ brief: "x", harness: "codex" });

    expect(JSON.parse(raw)).toMatchObject({ recovery: { target: "connections.codex", requirement: "desktop", domainTool: "in_background" } });
    expect(capturedCreate).toBeNull();
  });

  test("in_background translates typed Codex admission failures into Human-owned setup guidance", async () => {
    stubRuntime({ harnessFailure: "CODEX_NOT_ENABLED" });
    const raw = await createInBackgroundTool(CTX).invoke({ brief: "x", harness: "codex" });

    expect(JSON.parse(raw)).toMatchObject({ recovery: { target: "connections.codex", requirement: "human_enablement", domainTool: "in_background" } });
    expect(capturedCreate).toBeNull();
  });

  test("in_background tools=[] → none", async () => {
    stubRuntime();
    await createInBackgroundTool(CTX).invoke({ brief: "x", tools: [] });
    expect(capturedCreate?.toolsMode).toBe("none");
  });

  test("in_background tools=['x'] → whitelist", async () => {
    stubRuntime();
    await createInBackgroundTool(CTX).invoke({
      brief: "x",
      tools: ["search_memory"],
    });
    expect(capturedCreate?.toolsMode).toBe("whitelist");
    expect(capturedCreate?.toolsWhitelist).toEqual(["search_memory"]);
  });

  test("in_background result_delivery raw", async () => {
    stubRuntime();
    await createInBackgroundTool(CTX).invoke({
      brief: "x",
      result_delivery: "raw",
    });
    expect(capturedCreate?.resultDelivery).toBe("raw");
  });

  test.each(["wake", "raw_and_wake"] as const)(
    "in_background result_delivery %s",
    async (resultDelivery) => {
      stubRuntime();
      await createInBackgroundTool(CTX).invoke({
        brief: "x",
        result_delivery: resultDelivery,
      });
      expect(capturedCreate?.resultDelivery).toBe(resultDelivery);
    },
  );

  test("ask_peer name", () => {
    expect(createAskPeerTool().name).toBe("ask_peer");
  });

  test("ask_peer input shape (M151) — await_response, last_dm, handle normalized, no tools → none", async () => {
    stubRuntime();
    await createAskPeerTool(CTX).invoke({
      peer_handle: "@alex",
      message_to_peer: "Is the report ready?",
    });
    expect(capturedCreate).toMatchObject({
      ownerId: OWNER_ID,
      requestorId: OWNER_ID,
      agentId: AGENT_ID,
      preset: "ask_peer",
      scheduleKind: "now",
      useScope: false,
      toolsMode: "none",
      targetChat: "last_dm",
      // leading @ is stripped before re-prefixing.
      targetChatHandle: "@alex",
      awaitResponse: true,
      callingRoomId: ROOM_ID,
      // requester is element 0; the peer is appended at dispatch (resolveDm).
      targetUserIds: [OWNER_ID],
      depth: 0,
    });
    expect(capturedCreate?.toolsWhitelist).toEqual([]);
    expect(capturedCreate?.metadata).toBeUndefined();
    // The composed brief embeds the exact message verbatim AND frames the turn
    // as talking directly to the peer (no tool needed) without answering it.
    expect(capturedCreate?.prompt).toContain("Is the report ready?");
    expect(capturedCreate?.prompt).toContain("@alex");
    expect(capturedCreate?.prompt.toLowerCase()).toContain("directly");
    expect(capturedCreate?.prompt.toLowerCase()).toContain("do not answer");
  });

  test("ask_peer return_instructions are woven into the brief", async () => {
    stubRuntime();
    await createAskPeerTool(CTX).invoke({
      peer_handle: "alex",
      message_to_peer: "How are you?",
      return_instructions: "summarize their mood in one line",
    });
    expect(capturedCreate?.prompt).toContain("How are you?");
    expect(capturedCreate?.prompt).toContain("summarize their mood in one line");
  });

  test("ask_peer tools=['search_memory'] → whitelist", async () => {
    stubRuntime();
    await createAskPeerTool(CTX).invoke({
      peer_handle: "alex",
      message_to_peer: "q",
      tools: ["search_memory"],
    });
    expect(capturedCreate?.toolsMode).toBe("whitelist");
    expect(capturedCreate?.toolsWhitelist).toEqual(["search_memory"]);
    expect(capturedCreate?.targetChatHandle).toBe("@alex");
  });

  test("ask_peer focused Artifact handoff grants exact access and authors sealed task metadata", async () => {
    stubRuntime();
    const artifactGrantSpy = spyOn(shareArtifact, "grantArtifactExactUserAccess").mockResolvedValue({
      ok: true,
      alreadyGranted: false,
      namespaceId: "ns-exact",
      targetUserId: "peer-user",
      targetActorId: "peer-actor",
      artifact: {
        artifactId: "doc-1",
        path: "drafts/plan.md",
        mimeType: "text/markdown",
        size: 42,
      },
    });
    restores.push(() => artifactGrantSpy.mockRestore());
    const raw = await createAskPeerTool({
      ...CTX,
      turnId: "turn-1",
      memoryAccessEnvelope: {
        memoryMode: "namespace",
        ownerId: OWNER_ID,
        actorId: "owner-actor",
        agentId: AGENT_ID,
        roomId: ROOM_ID,
        readableNamespaces: ["ns-source"],
        mutableNamespaces: ["ns-source"],
        writableNamespaces: ["ns-source"],
        toolPolicy: { share_artifact: "allow" },
      },
      focusedResources: [{
        kind: "workspace-artifact",
        displayName: "plan.md",
        location: "server",
        lifetime: "workspace",
        capabilities: ["read"],
        locator: { artifactId: "doc-1" },
      }],
    }).invoke({
      peer_handle: "@elias",
      message_to_peer: "Please review this plan and send feedback.",
      include_focused_artifacts: true,
      sensitivity: "normal",
    });

    expect(artifactGrantSpy).toHaveBeenCalledWith({
      userId: OWNER_ID,
      agentId: AGENT_ID,
      readableNamespaces: ["ns-source"],
      artifactId: "doc-1",
      targetHandle: "elias",
    });
    expect(capturedCreate).toMatchObject({
      preset: "ask_peer",
      targetChatHandle: "@elias",
      metadata: {
        artifactAwareAskPeer: true,
        artifactRefs: [{ artifactId: "doc-1", path: "drafts/plan.md" }],
      },
    });
    expect(capturedCreate?.metadata?.["artifactOperationId"]).toContain("turn-1:elias:doc-1");
    expect(JSON.parse(String(raw))).toMatchObject({
      status: "pending",
      sharedArtifactIds: ["doc-1"],
    });
  });

  test("ask_peer refuses Artifact handoff when conditional share authority is absent", async () => {
    stubRuntime();
    const raw = await createAskPeerTool({
      ...CTX,
      memoryAccessEnvelope: {
        memoryMode: "namespace",
        ownerId: OWNER_ID,
        actorId: "owner-actor",
        agentId: AGENT_ID,
        roomId: ROOM_ID,
        readableNamespaces: ["ns-source"],
        mutableNamespaces: ["ns-source"],
        writableNamespaces: ["ns-source"],
        toolPolicy: { share_artifact: "forbidden" },
      },
      focusedResources: [{
        kind: "workspace-artifact",
        displayName: "plan.md",
        location: "server",
        lifetime: "workspace",
        capabilities: ["read"],
        locator: { artifactId: "doc-1" },
      }],
    }).invoke({
      peer_handle: "elias",
      message_to_peer: "Review this.",
      include_focused_artifacts: true,
      sensitivity: "normal",
    });

    expect(JSON.parse(String(raw))).toMatchObject({ status: "not_contacted" });
    expect(capturedCreate).toBeNull();
  });

  test("ask_peer ordinary handoff uses only frozen committed Artifact refs", async () => {
    stubRuntime();
    const commit = mock(async () => ({
      status: "success" as const,
      peerActorId: "10000000-0000-4000-8000-000000000099",
      receipts: [],
      artifacts: [{ artifactId: "doc-frozen", path: "frozen/plan.md",
        mimeType: "text/markdown", size: 10 }],
      message: "Content access granted.",
    }));
    const directGrant = spyOn(shareArtifact, "grantArtifactExactUserAccess");
    restores.push(() => directGrant.mockRestore());
    const raw = await createAskPeerTool({
      ...CTX,
      turnId: "turn-ordinary",
      ordinaryContentAccessRequired: true,
      ordinaryContentAccess: { commit },
      memoryAccessEnvelope: {
        memoryMode: "namespace",
        ownerId: OWNER_ID,
        actorId: "owner-actor",
        agentId: AGENT_ID,
        roomId: ROOM_ID,
        readableNamespaces: ["ns-source"],
        mutableNamespaces: ["ns-source"],
        writableNamespaces: ["ns-source"],
        toolPolicy: { share_artifact: "allow" },
      },
      focusedResources: [{
        kind: "workspace-artifact",
        displayName: "current.md",
        location: "server",
        lifetime: "workspace",
        capabilities: ["read"],
        locator: { artifactId: "doc-current" },
      }],
    }).invoke({
      peer_handle: "elias",
      message_to_peer: "Review this.",
      include_focused_artifacts: true,
      sensitivity: "normal",
    });
    expect(commit).toHaveBeenCalledWith();
    expect(directGrant).not.toHaveBeenCalled();
    expect(capturedCreate?.metadata).toMatchObject({
      ordinaryArtifactPeer: true,
      expectedArtifactPeerActorId: "10000000-0000-4000-8000-000000000099",
      artifactRefs: [{ artifactId: "doc-frozen", path: "frozen/plan.md" }],
    });
    expect(JSON.parse(String(raw))).toMatchObject({
      status: "pending",
      sharedArtifactIds: ["doc-frozen"],
    });
  });

  test("ask_peer ordinary success without an exact peer pin cannot create a contact Task", async () => {
    stubRuntime();
    const raw = await createAskPeerTool({ ...CTX,
      ordinaryContentAccessRequired: true,
      ordinaryContentAccess: { commit: async () => ({ status: "success", receipts: [], artifacts: [], message: "Granted" }) },
      memoryAccessEnvelope: { memoryMode: "namespace", ownerId: OWNER_ID, actorId: "owner-actor", agentId: AGENT_ID,
        roomId: ROOM_ID, readableNamespaces: [], mutableNamespaces: [], writableNamespaces: [], toolPolicy: { share_artifact: "allow" } },
    }).invoke({ peer_handle: "elias", message_to_peer: "Review this.", artifact_ids: ["doc"], sensitivity: "normal" });
    expect(JSON.parse(String(raw))).toMatchObject({ status: "shared_but_not_contacted" });
    expect(capturedCreate).toBeNull();
  });

  test("ask_peer reports partial ordinary grants without contacting the peer", async () => {
    stubRuntime();
    const commit = mock(async () => ({
      status: "error" as const,
      receipts: [],
      artifacts: [{ artifactId: "doc-granted", path: "granted.md",
        mimeType: "text/markdown", size: 10 }],
      recovery: "prepare_new_call" as const,
      message: "A later Artifact grant failed.",
    }));
    const raw = await createAskPeerTool({
      ...CTX,
      ordinaryContentAccessRequired: true,
      ordinaryContentAccess: { commit },
      memoryAccessEnvelope: {
        memoryMode: "namespace",
        ownerId: OWNER_ID,
        actorId: "owner-actor",
        agentId: AGENT_ID,
        roomId: ROOM_ID,
        readableNamespaces: ["ns-source"],
        mutableNamespaces: ["ns-source"],
        writableNamespaces: ["ns-source"],
        toolPolicy: { share_artifact: "allow" },
      },
    }).invoke({
      peer_handle: "elias",
      message_to_peer: "Review these.",
      artifact_ids: ["doc-granted", "doc-failed"],
      sensitivity: "normal",
    });
    expect(JSON.parse(String(raw))).toEqual({
      status: "shared_but_not_contacted",
      sharedArtifactIds: ["doc-granted"],
      recovery: "prepare_new_call",
      message: "A later Artifact grant failed.",
    });
    expect(capturedCreate).toBeNull();
  });

  test("ask_peer preserves shared_but_not_contacted when contact fails after ordinary success", async () => {
    stubRuntime({ createFailure: "task queue unavailable" });
    const commit = mock(async () => ({
      status: "success" as const,
      peerActorId: "10000000-0000-4000-8000-000000000099",
      receipts: [],
      artifacts: [{ artifactId: "doc-shared", path: "shared.md",
        mimeType: "text/markdown", size: 10 }],
      message: "Content access granted.",
    }));
    const raw = await createAskPeerTool({
      ...CTX,
      ordinaryContentAccessRequired: true,
      ordinaryContentAccess: { commit },
      memoryAccessEnvelope: {
        memoryMode: "namespace",
        ownerId: OWNER_ID,
        actorId: "owner-actor",
        agentId: AGENT_ID,
        roomId: ROOM_ID,
        readableNamespaces: ["ns-source"],
        mutableNamespaces: ["ns-source"],
        writableNamespaces: ["ns-source"],
        toolPolicy: { share_artifact: "allow" },
      },
    }).invoke({
      peer_handle: "elias",
      message_to_peer: "Review this.",
      artifact_ids: ["doc-shared"],
      sensitivity: "normal",
    });
    const result = JSON.parse(String(raw)) as {
      status: string;
      sharedArtifactIds: string[];
      message: string;
    };
    expect(result).toMatchObject({
      status: "shared_but_not_contacted",
      sharedArtifactIds: ["doc-shared"],
    });
    expect(result.message).toContain("task queue unavailable");
  });

  test("ask_peer missing context returns error string (no execution)", async () => {
    const raw = await createAskPeerTool({
      ownerId: "",
      agentId: "",
      roomId: "",
    }).invoke({ peer_handle: "alex", message_to_peer: "q" });
    expect(String(raw)).toContain("missing owner or agent context");
    expect(capturedCreate).toBeNull();
  });

  test("missing context returns error string (no execution)", async () => {
    const raw = await createInScopeTool({
      ownerId: "",
      agentId: "",
      roomId: "",
    }).invoke({ brief: "x", tools: [] });
    expect(String(raw)).toContain("missing owner or agent context");
    expect(capturedCreate).toBeNull();
  });

  // M152 — model_selection threads into selectionProfile on every shortcut.
  describe("M152 model_selection", () => {
    const SEL_KEYS = ["ANTHROPIC_API_KEY", "FIREWORKS_API_KEY", "OPENROUTER_API_KEY", "VENICE_API_KEY"];
    const savedSel: Record<string, string | undefined> = {};
    function withAnthropicOnly() {
      for (const k of SEL_KEYS) {
        savedSel[k] = process.env[k];
        if (k === "ANTHROPIC_API_KEY") process.env[k] = "x";
        else delete process.env[k];
      }
    }
    afterEach(() => {
      for (const [k, v] of Object.entries(savedSel)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    test("in_background threads model_selection → selectionProfile", async () => {
      stubRuntime();
      withAnthropicOnly();
      await createInBackgroundTool(CTX).invoke({ brief: "do x", model_selection: "cheapest" });
      expect(capturedCreate?.selectionProfile).toBe("cheapest");
    });

    test("in_scope threads model_selection → selectionProfile", async () => {
      stubRuntime();
      withAnthropicOnly();
      await createInScopeTool(CTX).invoke({ brief: "x", tools: [], model_selection: "smartest" });
      expect(capturedCreate?.selectionProfile).toBe("smartest");
    });

    test("in_private_namespace threads model_selection → selectionProfile", async () => {
      stubRuntime();
      withAnthropicOnly();
      await createInPrivateNamespaceTool(CTX).invoke({ brief: "x", model_selection: "smartest" });
      expect(capturedCreate?.selectionProfile).toBe("smartest");
    });

    test("ask_peer threads model_selection → selectionProfile", async () => {
      stubRuntime();
      withAnthropicOnly();
      await createAskPeerTool(CTX).invoke({ peer_handle: "alex", message_to_peer: "q", model_selection: "cheapest" });
      expect(capturedCreate?.selectionProfile).toBe("cheapest");
    });

    test("omitting model_selection leaves selectionProfile undefined (defaults to balanced at the row)", async () => {
      stubRuntime();
      await createInBackgroundTool(CTX).invoke({ brief: "do x" });
      expect(capturedCreate?.selectionProfile).toBeUndefined();
    });

    test("unsatisfiable private profile returns the error and does NOT create", async () => {
      stubRuntime();
      withAnthropicOnly();
      const raw = await createInBackgroundTool(CTX).invoke({
        brief: "do x privately",
        model_selection: "private_cheap",
      });
      expect(String(raw)).toContain("privacy grade");
      expect(capturedCreate).toBeNull();
    });
  });

  // D429 Phase 3 — exact model_id pin threads into requestedModelId on every
  // shortcut, and the mutual-exclusion + capability guards fire.
  describe("D429 Phase 3 — exact model_id", () => {
    const KEYS = ["ANTHROPIC_API_KEY", "GOOGLE_API_KEY"];
    const saved: Record<string, string | undefined> = {};
    function withKeys(present: string[]) {
      for (const k of KEYS) {
        saved[k] = process.env[k];
        if (present.includes(k)) process.env[k] = "x";
        else delete process.env[k];
      }
    }
    afterEach(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    test("in_background threads model_id → requestedModelId", async () => {
      stubRuntime();
      withKeys(["ANTHROPIC_API_KEY"]);
      await createInBackgroundTool(CTX).invoke({
        brief: "do x",
        model_id: "anthropic:claude-sonnet-4-6",
      });
      expect(capturedCreate?.requestedModelId).toBe("anthropic:claude-sonnet-4-6");
    });

    test("in_scope threads model_id → requestedModelId", async () => {
      stubRuntime();
      withKeys(["ANTHROPIC_API_KEY"]);
      await createInScopeTool(CTX).invoke({
        brief: "x",
        tools: ["search_memory"],
        model_id: "anthropic:claude-sonnet-4-6",
      });
      expect(capturedCreate?.requestedModelId).toBe("anthropic:claude-sonnet-4-6");
    });

    test("in_private_namespace threads model_id → requestedModelId", async () => {
      stubRuntime();
      withKeys(["ANTHROPIC_API_KEY"]);
      await createInPrivateNamespaceTool(CTX).invoke({
        brief: "x",
        model_id: "anthropic:claude-sonnet-4-6",
      });
      expect(capturedCreate?.requestedModelId).toBe("anthropic:claude-sonnet-4-6");
    });

    test("schedule threads model_id → requestedModelId", async () => {
      stubRuntime();
      withKeys(["ANTHROPIC_API_KEY"]);
      await createScheduleTool(CTX).invoke({
        message: "remind me",
        when: { kind: "once", at: "2035-01-01T00:00:00Z" },
        model_id: "anthropic:claude-sonnet-4-6",
      });
      expect(capturedCreate?.requestedModelId).toBe("anthropic:claude-sonnet-4-6");
    });

    test("ask_peer threads model_id → requestedModelId (tool-free default allows null-tools model)", async () => {
      stubRuntime();
      withKeys(["GOOGLE_API_KEY"]);
      // ask_peer defaults to tool-free (tools_mode none), so a null-tools model
      // (google:gemini-2.5-pro) is allowed.
      await createAskPeerTool(CTX).invoke({
        peer_handle: "alex",
        message_to_peer: "q",
        model_id: "google:gemini-2.5-pro",
      });
      expect(capturedCreate?.requestedModelId).toBe("google:gemini-2.5-pro");
    });

    test("generate_repo_docs threads exact model_id without adding the implicit smart_cheap profile", async () => {
      stubRuntime();
      withKeys(["ANTHROPIC_API_KEY"]);
      await createGenerateRepoDocsTool(CTX).invoke({
        target: "/repo",
        model_id: "anthropic:claude-sonnet-4-6",
      });
      expect(capturedCreate?.requestedModelId).toBe(
        "anthropic:claude-sonnet-4-6",
      );
      expect(capturedCreate?.selectionProfile).toBeUndefined();
      expect(capturedCreate?.toolsMode).toBe("whitelist");
      expect(capturedCreate?.toolsWhitelist).toEqual(["file"]);
    });

    test("generate_repo_docs preserves smart_cheap default when model_id is absent", async () => {
      stubRuntime();
      withKeys(["ANTHROPIC_API_KEY"]);
      await createGenerateRepoDocsTool(CTX).invoke({ target: "/repo" });
      expect(capturedCreate?.requestedModelId).toBeUndefined();
      expect(capturedCreate?.selectionProfile).toBe("smart_cheap");
    });

    test("generate_repo_docs rejects explicit model_id + model_selection", async () => {
      stubRuntime();
      withKeys(["ANTHROPIC_API_KEY"]);
      const raw = await createGenerateRepoDocsTool(CTX).invoke({
        target: "/repo",
        model_id: "anthropic:claude-sonnet-4-6",
        model_selection: "cheapest",
      });
      expect(String(raw)).toContain("combine");
      expect(capturedCreate).toBeNull();
    });

    test("generate_repo_docs requires confirmed tool support for its file whitelist", async () => {
      stubRuntime();
      withKeys(["GOOGLE_API_KEY"]);
      const raw = await createGenerateRepoDocsTool(CTX).invoke({
        target: "/repo",
        model_id: "google:gemini-2.5-pro",
      });
      expect(String(raw)).toContain("tool");
      expect(capturedCreate).toBeNull();
    });

    test("in_background rejects model_id + model_selection together (conflict)", async () => {
      stubRuntime();
      withKeys(["ANTHROPIC_API_KEY"]);
      const raw = await createInBackgroundTool(CTX).invoke({
        brief: "do x",
        model_id: "anthropic:claude-sonnet-4-6",
        model_selection: "cheapest",
      });
      expect(String(raw)).toContain("combine");
      expect(capturedCreate).toBeNull();
    });

    test("in_background rejects a dynamic openrouter: model_id (v1: curated ids only)", async () => {
      stubRuntime();
      withKeys(["ANTHROPIC_API_KEY"]);
      const raw = await createInBackgroundTool(CTX).invoke({
        brief: "do x",
        model_id: "openrouter:somevendor/unknown-model-v1",
      });
      expect(String(raw)).toContain("curated");
      expect(capturedCreate).toBeNull();
    });

    test("omitting model_id leaves requestedModelId undefined (unchanged default behavior)", async () => {
      stubRuntime();
      withKeys(["ANTHROPIC_API_KEY"]);
      await createInBackgroundTool(CTX).invoke({ brief: "do x" });
      expect(capturedCreate?.requestedModelId).toBeUndefined();
    });
  });
});
