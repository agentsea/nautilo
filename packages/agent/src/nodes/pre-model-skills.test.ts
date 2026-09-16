import { describe, test, expect, beforeAll } from "bun:test";
import {
  HumanMessage,
  SystemMessage,
  ToolMessage,
  AIMessage,
} from "@langchain/core/messages";
import { getToolCatalog, ToolCatalog, initToolCatalog } from "@nautilo/catalog";
import { preModelNode } from "./pre-model";
import {
  buildAvailableSkillsBlock,
  buildSkillBodyBlock,
  SKILL_BODY_HEADER_PREFIX,
} from "../prompts/templates";
import { registerAllTools } from "../tools/register-all";
import type { NautiloState } from "../agent/state";
import { MAX_SUBAGENT_DEPTH } from "../agent/state";
import { MAX_ACTIVATED_TOOL_NAMES } from "../tools/meta/activated-tools-handle";
import type { SkillBody } from "../skills/select-skills-for-turn";
import { runWithInitiatingClientSurface } from "../runtime/initiating-client-surface-context";
import { COMPUTER_RESULT_DURABLE_SIDECAR_KEY } from "../tools/computer/model-result-projector";

beforeAll(() => {
  const catalog = new ToolCatalog();
  registerAllTools(catalog);
  initToolCatalog(catalog);
});

function skill(name: string, body: string, requiresTools: string[] = []): SkillBody {
  return {
    id: `id-${name}`,
    name,
    description: `${name} description`,
    body,
    requiresTools,
  };
}

function makeState(overrides: Partial<NautiloState>): NautiloState {
  return {
    messages: [new HumanMessage("hello")],
    threadId: 0,
    langgraphThreadId: "",
    model: null,
    userId: "owner-1",
    personaId: "owner",
    voiceMode: false,
    source: "tui",
    assistantName: "Genie",
    soulFile: "",
    memoryBrief: "",
    memoryDelta: "",
    currentThreadId: "",
    preparedMessages: [],
    toolNames: [],
    approvedToolCalls: [],
    pendingApproval: [],
    memoryAccessEnvelope: null,
    actorRole: "owner",
    agentId: "agent-genie",
    roomId: "",
    roomRoster: [],
    approvalDenied: false,
    turnId: "",
    explicitlySelected: false,
    currentFolder: "",
    currentFolderRelayId: "",
    workspacePath: "",
    activeMiniApp: null,
    artifactRefs: [],
    userTimezone: "UTC",
    previousUserMessageAt: null,
    securityAuditClientMeta: null,
    toolWhitelist: undefined,
    activatedToolNames: [],
    relayCapabilities: undefined,
    subagentDepth: 0,
    subagentMaxDepth: MAX_SUBAGENT_DEPTH,
    suppressToolLifecycleEvents: false,
    subagentRun: false,
    taskRun: false,
    skills: [],
    engagedSkillNames: [],
    awaitResponse: false,
    awaitRoomId: "",
    awaitFromUserIds: [],
    awaitTaskId: "",
    awaitTaskRunId: "",
    awaitOwnerId: "",
    ...overrides,
  };
}

async function systemPromptOf(state: NautiloState): Promise<string> {
  const envelopeBefore = state.memoryAccessEnvelope
    ? JSON.stringify(state.memoryAccessEnvelope)
    : null;
  const patch = await preModelNode(state);
  const envelopeAfter = state.memoryAccessEnvelope
    ? JSON.stringify(state.memoryAccessEnvelope)
    : null;
  expect(envelopeAfter).toBe(envelopeBefore);

  const prepared = patch.preparedMessages ?? [];
  const first = prepared[0];
  if (!first || !(first instanceof SystemMessage)) {
    throw new Error(
      `expected first prepared message to be SystemMessage, got ${first?.constructor.name ?? "undefined"}`,
    );
  }
  if (typeof first.content === "string") return first.content;
  if (Array.isArray(first.content)) {
    return first.content
      .map((block) =>
        block && typeof block === "object" && "text" in block
          ? String((block as { text: unknown }).text)
          : "",
      )
      .join("");
  }
  return JSON.stringify(first.content);
}

describe("preModelNode — skills v1 (catalog + engaged re-inject)", () => {
  test("reads Mobile Web guidance from the execution-local surface", async () => {
    const prompt = await runWithInitiatingClientSurface("mobile.web", () =>
      systemPromptOf(makeState({})),
    );
    expect(prompt).toContain("Current client: Mobile Web");
    expect(prompt).toContain("mobile web browser, not the native app");
  });

  test("includes catalog with zero auto-injected bodies", async () => {
    const skills = [
      skill("alpha", "alpha secret body"),
      skill("beta", "beta secret body"),
    ];
    const prompt = await systemPromptOf(makeState({ skills }));

    expect(prompt).toContain(buildAvailableSkillsBlock([
      { name: "alpha", description: "alpha description" },
      { name: "beta", description: "beta description" },
    ]));
    expect(prompt).not.toContain("alpha secret body");
    expect(prompt).not.toContain("beta secret body");
    expect(prompt).not.toContain(`${SKILL_BODY_HEADER_PREFIX}alpha`);
    expect(prompt).not.toContain(`${SKILL_BODY_HEADER_PREFIX}beta`);
  });

  test("guest turns omit catalog and bodies", async () => {
    const skills = [skill("alpha", "alpha secret body")];
    const prompt = await systemPromptOf(
      makeState({ skills, actorRole: "guest" }),
    );

    expect(prompt).not.toContain("## Available skills");
    expect(prompt).not.toContain("alpha secret body");
  });

  test("requiresTools-gated skills omitted from catalog when tool absent", async () => {
    const skills = [
      skill("teach", "teach body", ["file"]),
      skill("chat", "chat body"),
    ];
    const prompt = await systemPromptOf(
      makeState({
        skills,
        toolWhitelist: ["search_memory"],
        memoryAccessEnvelope: {
          ownerId: "owner-1",
          actorId: "actor-owner-1",
          agentId: "agent-genie",
          roomId: "room-1",
          readableNamespaces: [],
          mutableNamespaces: [],
          writableNamespaces: [],
          toolPolicy: { search_memory: "read_only" },
        },
      }),
    );

    expect(prompt).toContain("- chat — chat description");
    expect(prompt).not.toContain("- teach — teach description");
    expect(prompt).not.toContain("teach body");
  });

  test("lists an authorized deferred skill with activation guidance without binding its schema", async () => {
    const deferred = skill("artifact-authoring", "Create an artifact", [
      "file",
      "read_artifact_events",
    ]);
    const state = makeState({ skills: [deferred] });

    const patch = await preModelNode(state);
    const prompt = await systemPromptOf(state);

    expect(patch.toolNames).not.toContain("file");
    expect(patch.toolNames).not.toContain("read_artifact_events");
    expect(prompt).toContain(
      "- artifact-authoring — artifact-authoring description (activate filesystem: file, read_artifact_events)",
    );
    expect(prompt).not.toContain("artifact-authoring body");
    expect(prompt).not.toContain(`${SKILL_BODY_HEADER_PREFIX}artifact-authoring`);
  });

  test("an explicitly whitelisted and seeded artifact-event reader is callable immediately", async () => {
    const patch = await preModelNode(makeState({
      messages: [
        new HumanMessage(
          '[ARTIFACT EVENT @artifact-1] path="artifacts/quiz.html" topic="exercise_completed".',
        ),
      ],
      toolWhitelist: ["read_artifact_events"],
      activatedToolNames: ["read_artifact_events"],
    }));

    expect(patch.toolNames).toEqual(["read_artifact_events"]);
  });

  test("a focused workspace artifact makes only its file target callable without an explicit file request", async () => {
    const state = makeState({
      messages: [new HumanMessage("Can you see the file I have open?")],
      memoryDelta: "An older persistent-memory note.",
      focusedResources: [
        {
          kind: "workspace-artifact",
          displayName: "nautilo_vision.md",
          location: "server",
          lifetime: "workspace",
          capabilities: ["read"],
          toolTarget: {
            tool: "file",
            zone: "workspace",
            path: "notes/nautilo_vision.md",
          },
          locator: { artifactId: "notes/nautilo_vision.md" },
        },
      ],
    });

    const patch = await preModelNode(state);
    const prompt = await systemPromptOf(state);

    expect(patch.activatedToolNames).toContain("file");
    expect(patch.toolNames).toContain("file");
    expect(prompt).toContain("**file**:");
    expect(prompt).toContain(
      `Resolve references such as "this file", "this document", "the current file", "what I have open", or "discuss this file" directly against this list.`,
    );
    expect(prompt).toContain(
      "Do NOT search memory, discover or activate tools, or inspect a Writer/app session merely to identify a focused resource.",
    );
    expect(prompt).toContain(
      "use its exact listed `file` target and NEVER call `browser_snapshot` or another `browser_*` tool to read it.",
    );
    expect(prompt.indexOf("## Focused resources")).toBeGreaterThan(
      prompt.indexOf("An older persistent-memory note."),
    );
    // Focus is a pointer to this file, not an excuse to expose the rest of
    // the filesystem family.
    expect(patch.toolNames).not.toContain("share_artifact");
    expect(patch.toolNames).not.toContain("read_artifact_events");
    expect(patch.toolNames).not.toContain("convert");
    expect(patch.toolNames).not.toContain("execute_artifact");
  });

  test("a validated local focused-file target also activates file", async () => {
    const patch = await preModelNode(makeState({
      messages: [new HumanMessage("What is this about?")],
      focusedResources: [
        {
          kind: "local-file",
          displayName: "draft.md",
          location: "relay",
          lifetime: "turn",
          capabilities: ["read"],
          toolTarget: { tool: "file", zone: "current", path: "draft.md" },
          locator: { relayId: "validated-relay", path: "/workspace/draft.md" },
        },
      ],
    }));

    expect(patch.toolNames).toContain("file");
  });

  test("focused-resource activation still honors the tool whitelist and policy", async () => {
    const focusedResources = [
      {
        kind: "workspace-artifact" as const,
        displayName: "private.md",
        location: "server" as const,
        lifetime: "workspace" as const,
        capabilities: ["read" as const],
        toolTarget: { tool: "file" as const, zone: "workspace" as const, path: "private.md" },
        locator: { artifactId: "private.md" },
      },
    ];
    const whitelistedAway = await preModelNode(makeState({
      focusedResources,
      toolWhitelist: ["discover_tools"],
    }));
    const forbiddenByPolicy = await preModelNode(makeState({
      focusedResources,
      memoryAccessEnvelope: {
        ownerId: "owner-1",
        actorId: "actor-owner-1",
        agentId: "agent-genie",
        roomId: "room-1",
        readableNamespaces: [],
        mutableNamespaces: [],
        writableNamespaces: [],
        toolPolicy: { file: "forbidden" },
      },
    }));

    expect(whitelistedAway.toolNames).not.toContain("file");
    expect(forbiddenByPolicy.toolNames).not.toContain("file");
  });

  test("a focused file displaces the lowest-priority retained activation at full capacity", async () => {
    const catalog = getToolCatalog();
    if (!catalog) throw new Error("expected initialized tool catalog");
    const retained = catalog
      .getFiltered()
      .entries
      .filter((entry) => entry.exposure === "discoverable" && entry.name !== "file")
      .slice(0, MAX_ACTIVATED_TOOL_NAMES)
      .map((entry) => entry.name);
    expect(retained).toHaveLength(MAX_ACTIVATED_TOOL_NAMES);

    const patch = await preModelNode(makeState({
      activatedToolNames: retained,
      focusedResources: [
        {
          kind: "workspace-artifact",
          displayName: "nautilo_vision.md",
          location: "server",
          lifetime: "workspace",
          capabilities: ["read"],
          toolTarget: { tool: "file", zone: "workspace", path: "notes/nautilo_vision.md" },
          locator: { artifactId: "notes/nautilo_vision.md" },
        },
      ],
    }));

    expect(patch.activatedToolNames).toHaveLength(MAX_ACTIVATED_TOOL_NAMES);
    expect(patch.activatedToolNames).toContain("file");
    expect(patch.activatedToolNames).not.toContain(retained.at(-1));
    // A focused file is intentionally current-turn-only; automatic focus
    // activation must not manufacture a durable lease.
    expect(patch.activatedToolLeases).toEqual([]);
  });

  test("dedup: headered pull in history suppresses engaged re-inject", async () => {
    const alpha = skill("alpha", "engaged body text");
    const headered = buildSkillBodyBlock(alpha);

    const prompt = await systemPromptOf(
      makeState({
        skills: [alpha],
        engagedSkillNames: ["alpha"],
        messages: [
          new HumanMessage("hello"),
          new AIMessage({
            content: "",
            tool_calls: [{ id: "tc1", name: "view_skill", args: { name: "alpha" } }],
          }),
          new ToolMessage({
            content: headered,
            tool_call_id: "tc1",
            name: "view_skill",
          }),
        ],
      }),
    );

    expect(prompt).not.toContain(`${SKILL_BODY_HEADER_PREFIX}alpha`);
    expect(prompt).not.toContain("engaged body text");
  });

  test("re-injects engaged body when not yet in message history", async () => {
    const alpha = skill("alpha", "fresh engaged body");
    const prompt = await systemPromptOf(
      makeState({
        skills: [alpha],
        engagedSkillNames: ["alpha"],
      }),
    );

    expect(prompt).toContain(buildSkillBodyBlock(alpha));
  });

  test("ejected skill omitted on next rebuild", async () => {
    const alpha = skill("alpha", "should not appear");
    const prompt = await systemPromptOf(
      makeState({
        skills: [alpha],
        engagedSkillNames: [],
      }),
    );

    expect(prompt).not.toContain("should not appear");
    expect(prompt).toContain("- alpha — alpha description");
  });

  test("ejected pull is tombstoned in message history (body evicted, pairing kept)", async () => {
    const alpha = skill("alpha", "ejected body text here");
    const state = makeState({
      skills: [alpha],
      engagedSkillNames: [], // ejected on the prior turn
      messages: [
        new HumanMessage("hello"),
        new AIMessage({
          content: "",
          tool_calls: [{ id: "tc1", name: "view_skill", args: { name: "alpha" } }],
        }),
        new ToolMessage({
          content: buildSkillBodyBlock(alpha),
          tool_call_id: "tc1",
          name: "view_skill",
        }),
        new HumanMessage("you still there?"),
      ],
    });

    const patch = await preModelNode(state);

    const toolMsg = (patch.messages ?? []).find(
      (m): m is ToolMessage => m instanceof ToolMessage && m.name === "view_skill",
    );
    expect(toolMsg).toBeDefined();
    const content =
      typeof toolMsg!.content === "string"
        ? toolMsg!.content
        : JSON.stringify(toolMsg!.content);
    expect(content).toContain('[skill "alpha" ejected');
    expect(content).not.toContain("ejected body text here");
    // tool-call/result pairing preserved (no RemoveMessage).
    expect(toolMsg!.tool_call_id).toBe("tc1");

    // Body is gone from what the model sees this turn too.
    const preparedText = (patch.preparedMessages ?? [])
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");
    expect(preparedText).not.toContain("ejected body text here");
  });

  test("still-engaged pull is NOT tombstoned", async () => {
    const alpha = skill("alpha", "kept body text");
    const state = makeState({
      skills: [alpha],
      engagedSkillNames: ["alpha"],
      messages: [
        new HumanMessage("hello"),
        new AIMessage({
          content: "",
          tool_calls: [{ id: "tc1", name: "view_skill", args: { name: "alpha" } }],
        }),
        new ToolMessage({
          content: buildSkillBodyBlock(alpha),
          tool_call_id: "tc1",
          name: "view_skill",
        }),
      ],
    });

    const patch = await preModelNode(state);
    const toolMsg = (patch.messages ?? []).find(
      (m): m is ToolMessage => m instanceof ToolMessage && m.name === "view_skill",
    );
    const content =
      typeof toolMsg!.content === "string"
        ? toolMsg!.content
        : JSON.stringify(toolMsg!.content);
    expect(content).toContain("kept body text");
    expect(content).not.toContain("ejected");
  });

  test("strips host-only Computer Use diagnostics from provider messages without mutating checkpoint history", async () => {
    const full = JSON.stringify({
      ok: true,
      provider: { privateDiagnostic: "HOST_ONLY_SENTINEL" },
      result: { kind: "observation", observation: { operation: "desktop_state" } },
    });
    const compact = JSON.stringify({
      version: 1,
      ok: true,
      result: { kind: "observation", observation: { operation: "desktop_state" } },
    });
    const checkpointToolMessage = new ToolMessage({
      content: [
        { type: "text", text: compact },
        { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } },
      ],
      tool_call_id: "computer-call-1",
      name: "computer_observe",
      additional_kwargs: {
        [COMPUTER_RESULT_DURABLE_SIDECAR_KEY]: full,
        nautilo_tool_status: "success",
      },
    });
    const state = makeState({
      model: "anthropic:claude-sonnet-4-6",
      messages: [
        new HumanMessage("inspect the desktop"),
        new AIMessage({
          content: "",
          tool_calls: [{ id: "computer-call-1", name: "computer_observe", args: { operation: "desktop_state" } }],
        }),
        checkpointToolMessage,
      ],
    });

    const patch = await preModelNode(state);
    const providerToolMessage = (patch.preparedMessages ?? []).find(
      (message): message is ToolMessage => message instanceof ToolMessage && message.name === "computer_observe",
    );

    expect(providerToolMessage).toBeDefined();
    const providerBlocks = Array.isArray(providerToolMessage?.content)
      ? providerToolMessage.content as Array<Record<string, unknown>>
      : [];
    expect(providerBlocks.find((block) => block["type"] === "text")?.["text"]).toBe(compact);
    expect(JSON.stringify(providerToolMessage?.content)).toContain("data:image/png;base64,aW1hZ2U=");
    expect(providerToolMessage?.additional_kwargs?.[COMPUTER_RESULT_DURABLE_SIDECAR_KEY]).toBeUndefined();
    expect(providerToolMessage?.additional_kwargs?.["nautilo_tool_status"]).toBe("success");
    expect(JSON.stringify(patch.preparedMessages)).not.toContain("HOST_ONLY_SENTINEL");
    expect(checkpointToolMessage.additional_kwargs?.[COMPUTER_RESULT_DURABLE_SIDECAR_KEY]).toBe(full);
    expect(state.messages[2]).toBe(checkpointToolMessage);
  });

  test("keeps Computer Use schemas discoverable after a recoverable Host result", async () => {
    const ready = makeState({
      turnId: "computer-drift-turn",
      relayCapabilities: {
        canUseComputer: true,
        canComputerDo: true,
        canComputerVerify: true,
        canComputerFocus: true,
      },
    });
    const beforeWithdrawal = await preModelNode(ready);
    expect(beforeWithdrawal.toolNames).toContain("computer_observe");
    expect(beforeWithdrawal.toolNames).toContain("computer_do");
    expect(beforeWithdrawal.toolNames).toContain("computer_verify");

    const patch = await preModelNode(ready);
    expect(patch.toolNames).toContain("computer_observe");
    expect(patch.toolNames).toContain("computer_do");
    expect(patch.toolNames).toContain("computer_verify");
    expect(ready.relayCapabilities).toEqual({
      canUseComputer: true,
      canComputerDo: true,
      canComputerVerify: true,
      canComputerFocus: true,
    });
  });
});
