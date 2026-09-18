import { afterEach, describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { ToolCatalog, clearToolCatalog, initToolCatalog } from "@nautilo/catalog";
import { setConfigOverrides } from "@nautilo/config";
import { buildGuestToolPolicy, type PolicyResolver } from "@nautilo/trust";
import { z } from "zod";
import { createNautiloGraph } from "../../src/agent/graph";
import type { NautiloState } from "../../src/agent/state";
import { preModelNode } from "../../src/nodes/pre-model";
import { __setStubModelForTests } from "../../src/providers/universal";
import type { ChatModel } from "../../src/providers/types";
import { createActivateToolsTool } from "../../src/tools/meta/activate-tools";
import { createDeactivateToolsTool } from "../../src/tools/meta/deactivate-tools";
import { createDiscoverToolsTool } from "../../src/tools/meta/discover-tools";
import { EMBEDDED_BROWSER_TOOL_NAMES } from "../../src/tools/exposure/manifest";
import { registerAllTools } from "../../src/tools/register-all";

interface ScriptedResponse {
  type: "text" | "tool";
  content?: string;
  name?: string;
  args?: Record<string, unknown>;
  calls?: Array<{ name: string; args?: Record<string, unknown> }>;
}

function createScriptedModel(script: ScriptedResponse[]) {
  const remaining = [...script];
  const bindings: string[][] = [];
  const messageBatches: BaseMessage[][] = [];
  const model: ChatModel = {
    bindTools(tools) {
      bindings.push(
        tools.flatMap((tool) => (
          tool !== null &&
          typeof tool === "object" &&
          "name" in tool &&
          typeof tool.name === "string"
            ? [tool.name]
            : []
        )),
      );
      return model;
    },
    async invoke(messages: BaseMessage[]) {
      messageBatches.push(messages);
      const next = remaining.shift();
      if (!next) throw new Error("script exhausted");
      if (next.type === "text") return new AIMessage(next.content ?? "");
      const calls = next.calls ?? (next.name ? [{ name: next.name, args: next.args }] : []);
      if (calls.length === 0) throw new Error("tool response missing name");
      return new AIMessage({
        content: "",
        tool_calls: calls.map((call, index) => ({
          id: `call-${bindings.length}-${index}`,
          name: call.name,
          args: call.args ?? {},
        })),
      });
    },
  };
  return {
    model,
    bindings,
    messageBatches,
    get remaining() {
      return remaining.length;
    },
  };
}

function createPolicyResolver(): PolicyResolver {
  return {
    resolveContext: async () => {
      throw new Error("not used by direct graph invocation");
    },
    buildEnvelope: async () => {
      throw new Error("not used by direct graph invocation");
    },
    checkToolAccess: async (_actorId, tool, envelope) => {
      return envelope?.toolPolicy?.[tool.name] === "forbidden"
        ? { type: "forbidden", reason: "forbidden fixture" }
        : { type: "allow" };
    },
    routeApproval: async () => ({ type: "prove_it", approvers: [] }),
  };
}

function registerGraphFixture(
  executions: string[],
  fixtureName: string,
) {
  const catalog = new ToolCatalog();
  catalog.register({
    name: "discover_tools",
    factory: (context) => createDiscoverToolsTool(context),
    category: "meta",
    trustTier: "guest",
    impact: "read-only",
    exposure: "core",
  });
  catalog.register({
    name: "activate_tools",
    factory: (context) => createActivateToolsTool(context),
    category: "meta",
    trustTier: "guest",
    impact: "read-only",
    exposure: "core",
  });
  catalog.register({
    name: fixtureName,
    factory: () => new DynamicStructuredTool({
      name: fixtureName,
      description: "Deferred graph fixture",
      schema: z.object({ value: z.string() }),
      func: async (input) => {
        const { value } = z.object({ value: z.string() }).parse(input);
        executions.push(value);
        return `fixture:${value}`;
      },
    }),
    category: "development",
    trustTier: "guest",
    impact: "read-only",
    exposure: "discoverable",
  });
  initToolCatalog(catalog);
}

function registerWriterReviewGraphFixture(executions: string[]) {
  const catalog = new ToolCatalog();
  catalog.register({
    name: "discover_tools",
    factory: (context) => createDiscoverToolsTool(context),
    category: "meta",
    trustTier: "guest",
    impact: "read-only",
    exposure: "core",
  });
  catalog.register({
    name: "activate_tools",
    factory: (context) => createActivateToolsTool(context),
    category: "meta",
    trustTier: "guest",
    impact: "read-only",
    exposure: "core",
  });
  const register = (
    name: string,
    options: { review?: boolean; impact?: "read-only" | "high" } = {},
  ) => catalog.register({
    name,
    factory: () => new DynamicStructuredTool({
      name,
      description: `${name} Writer fixture`,
      schema: z.object({
        sessionToken: z.string().optional(),
        baseRevision: z.number().int().optional(),
        blockId: z.string().optional(),
        target: z.string().optional(),
        operations: z.array(z.unknown()).optional(),
      }),
      func: async () => {
        executions.push(name);
        return `${name}:ok`;
      },
    }),
    category: "documents",
    trustTier: "standard",
    impact: options.impact ?? "read-only",
    exposure: "discoverable",
    tags: [
      "app",
      "mini-app",
      "nautilo-writer",
      ...(options.review ? ["live-review", "review", "proposal"] : []),
    ],
    ...(options.review
      ? {
          discovery: { preferredReviewWorkflow: true },
          guidance: "Use this validated live Writer review surface for reviewable proposals.",
        }
      : {}),
  });
  register("app_nautilo_writer__edit_open_writer", { review: true });
  register("app_nautilo_writer__read_open_writer_range", { review: true });
  register("app_nautilo_writer__locate_open_writer_text", { review: true });
  register("app_nautilo_writer__replace_text", { impact: "high" });
  register("app_nautilo_writer__delete_blocks", { impact: "high" });
  initToolCatalog(catalog);
}

function registerGuestDeactivationFixture() {
  const catalog = new ToolCatalog();
  catalog.register({
    name: "deactivate_tools",
    factory: (context) => createDeactivateToolsTool(context),
    category: "meta",
    trustTier: "guest",
    impact: "read-only",
    exposure: "core",
  });
  initToolCatalog(catalog);
}

function registerCapFixtures(executions: string[]) {
  const catalog = new ToolCatalog();
  const register = (name: string, exposure: "core" | "discoverable") => {
    catalog.register({
      name,
      factory: () => new DynamicStructuredTool({
        name,
        description: `Cap fixture ${name}`,
        schema: z.object({ value: z.string() }),
        func: async (input) => {
          const { value } = z.object({ value: z.string() }).parse(input);
          executions.push(name);
          return `${name}:${value}`;
        },
      }),
      category: "development",
      trustTier: "guest",
      impact: "read-only",
      exposure,
    });
  };
  register("fixture_core", "core");
  for (let index = 0; index < 32; index += 1) {
    register(`fixture_${index}`, "discoverable");
  }
  // This manifest browser member is the 33rd deferred candidate and must be
  // excluded deterministically once retained activation fills the cap.
  register("browser_click", "discoverable");
  initToolCatalog(catalog);
}

function graphInput(
  policy: Record<string, "allow" | "read_only" | "require_prove_it" | "forbidden">,
  toolWhitelist?: string[],
  message = "Use the deferred fixture.",
) {
  return {
    messages: [new HumanMessage(message)],
    model: "openai:gpt-5.5-2026-04-23",
    userId: "owner",
    actorRole: "owner",
    memoryAccessEnvelope: {
      ownerId: "owner",
      actorId: "actor",
      agentId: "agent",
      roomId: "room",
      readableNamespaces: [],
      mutableNamespaces: [],
      writableNamespaces: [],
      toolPolicy: policy,
    },
    ...(toolWhitelist !== undefined ? { toolWhitelist } : {}),
  };
}

function systemMessageText(message: SystemMessage): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((block) =>
        block && typeof block === "object" && "text" in block
          ? String((block as { text: unknown }).text)
          : "",
      )
      .join("");
  }
  return JSON.stringify(message.content);
}

afterEach(() => {
  __setStubModelForTests(null);
  clearToolCatalog();
  setConfigOverrides({});
  delete process.env["NAUTILO_TEST_MODE"];
});

describe("D419 progressive activation graph integration", () => {
  test("guest deactivation cannot overwrite owner activation state on a shared thread", async () => {
    process.env["NAUTILO_TEST_MODE"] = "stub";
    registerGuestDeactivationFixture();
    const scripted = createScriptedModel([
      {
        type: "tool",
        name: "deactivate_tools",
        args: { names: ["owner_deferred_tool"], families: [] },
      },
      { type: "text", content: "complete" },
    ]);
    __setStubModelForTests(scripted.model);

    const result = await createNautiloGraph(undefined, createPolicyResolver()).invoke({
      ...graphInput({ deactivate_tools: "allow" }),
      actorRole: "guest",
      langgraphThreadId: "shared-deactivation-thread",
      activatedToolNames: ["owner_deferred_tool"],
    }) as NautiloState;

    expect(result.activatedToolNames).toEqual(["owner_deferred_tool"]);
  });

  test("guest receives real core browser schemas without persisting actor-dependent activation", async () => {
    process.env["NAUTILO_TEST_MODE"] = "stub";
    const catalog = new ToolCatalog();
    registerAllTools(catalog);
    initToolCatalog(catalog);
    const scripted = createScriptedModel([{ type: "text", content: "complete" }]);
    __setStubModelForTests(scripted.model);

    const input = {
      ...graphInput(buildGuestToolPolicy(), undefined, "Read the currently visible browser page."),
      actorRole: "guest",
      langgraphThreadId: "shared-browser-thread",
      relayCapabilities: { control_browser: true, canControlBrowser: true },
    } as unknown as NautiloState;
    const result = await createNautiloGraph(undefined, createPolicyResolver()).invoke(input) as NautiloState;

    expect(scripted.bindings).toHaveLength(1);
    for (const name of EMBEDDED_BROWSER_TOOL_NAMES) {
      expect(scripted.bindings[0]).toContain(name);
    }
    expect(result.activatedToolNames ?? []).not.toContain("browser_read_page");

    const withoutRelay = await preModelNode({
      ...input,
      relayCapabilities: undefined,
    });
    for (const name of EMBEDDED_BROWSER_TOOL_NAMES) {
      expect(withoutRelay.toolNames).not.toContain(name);
    }

    const ownerPatch = await preModelNode({
      ...graphInput({ browser_click: "allow" }, undefined, "Hello."),
      actorRole: "owner",
      langgraphThreadId: "shared-browser-thread",
      activatedToolNames: result.activatedToolNames ?? [],
    } as unknown as NautiloState);

    expect(result.activatedToolNames ?? []).not.toContain("browser_click");
    expect(ownerPatch.toolNames).not.toContain("browser_click");
  });

  test("caps intent activation consistently across prompt, provider, and executable schemas", async () => {
    process.env["NAUTILO_TEST_MODE"] = "stub";
    const executions: string[] = [];
    registerCapFixtures(executions);
    const activated = Array.from({ length: 32 }, (_, index) => `fixture_${index}`);
    const expectedNames = ["fixture_core", ...activated];
    const scripted = createScriptedModel([
      {
        type: "tool",
        calls: expectedNames.map((name) => ({ name, args: { value: "run" } })),
      },
      { type: "text", content: "complete" },
    ]);
    __setStubModelForTests(scripted.model);

    await createNautiloGraph(undefined, createPolicyResolver()).invoke(
      {
        ...graphInput({ browser_click: "allow" }, undefined, "Click Submit in the embedded browser panel."),
        activatedToolNames: activated,
      },
      { recursionLimit: 96 },
    );

    const firstPrompt = scripted.messageBatches[0]?.[0];
    expect(firstPrompt).toBeInstanceOf(SystemMessage);
    const prompt = systemMessageText(firstPrompt as SystemMessage);
    const providerNames = scripted.bindings[0] ?? [];

    expect(providerNames).toEqual(expectedNames);
    expect(executions).toEqual(expectedNames);
    expect(providerNames).not.toContain("browser_click");
    for (const name of expectedNames) {
      expect(prompt).toContain(`**${name}**:`);
    }
    expect(prompt).not.toContain("**browser_click**:");
  });

  test("pre-activates an explicit filesystem edit before the first model call", async () => {
    process.env["NAUTILO_TEST_MODE"] = "stub";
    const executions: string[] = [];
    registerGraphFixture(executions, "file");
    const scripted = createScriptedModel([
      { type: "tool", name: "file", args: { value: "edited" } },
      { type: "text", content: "complete" },
    ]);
    __setStubModelForTests(scripted.model);

    await createNautiloGraph(undefined, createPolicyResolver()).invoke(
      graphInput({ file: "allow" }, undefined, "Edit the README file in my workspace."),
    );

    expect(scripted.bindings[0]).toContain("file");
    expect(executions).toEqual(["edited"]);
    expect(scripted.remaining).toBe(0);
  });

  test("does not re-apply same-turn intent after explicit deactivation", async () => {
    process.env["NAUTILO_TEST_MODE"] = "stub";
    const executions: string[] = [];
    registerGraphFixture(executions, "file");
    const input = {
      ...graphInput({ file: "allow" }, undefined, "Edit the README file in my workspace."),
      turnId: "intent-deactivation-turn",
      activationLeasesInitialized: true,
      activatedToolLeases: [],
      activatedToolNames: [],
    } as unknown as NautiloState;

    const first = await preModelNode(input);
    expect(first.activatedToolNames).toContain("file");
    expect(first.activatedToolLeases).toEqual([]);
    expect(first.activationIntentAppliedForTurnId).toBe("intent-deactivation-turn");

    const afterDeactivation = await preModelNode({
      ...input,
      ...first,
      activatedToolNames: [],
      activatedToolLeases: [],
    } as NautiloState);
    expect(afterDeactivation.activatedToolNames).not.toContain("file");
    expect(afterDeactivation.toolNames).not.toContain("file");
    expect(afterDeactivation.activatedToolLeases).toEqual([]);
  });

  test("same-turn config reduction prunes over-age leases without dropping mutations", async () => {
    process.env["NAUTILO_TEST_MODE"] = "stub";
    registerCapFixtures([]);
    setConfigOverrides({ nautilo_tool_activation_retention_turns: 2 });
    const input = {
      ...graphInput({ fixture_0: "allow", fixture_1: "allow" }),
      turnId: "same-turn-config-reduction",
      activationLeasesInitialized: true,
      activationLeasesAgedForTurnId: "same-turn-config-reduction",
      activatedToolNames: ["fixture_0", "fixture_1"],
      activatedToolLeases: [{ name: "fixture_0", idleTurns: 3 }],
      activationIntentAppliedForTurnId: "same-turn-config-reduction",
    } as unknown as NautiloState;

    const patch = await preModelNode(input);

    expect(patch.activatedToolNames).toEqual(["fixture_1"]);
    expect(patch.activatedToolLeases).toEqual([]);
    expect(patch.toolNames).toContain("fixture_1");
    expect(patch.toolNames).not.toContain("fixture_0");
  });

  test("auto mode discovers, activates, then executes a deferred schema on the next tools → pre_model → agent step", async () => {
    process.env["NAUTILO_TEST_MODE"] = "stub";
    const executions: string[] = [];
    registerGraphFixture(executions, "fixture_deferred");
    const scripted = createScriptedModel([
      { type: "tool", name: "discover_tools", args: { query: "deferred fixture" } },
      { type: "tool", name: "activate_tools", args: { names: ["fixture_deferred"], families: [] } },
      { type: "tool", name: "fixture_deferred", args: { value: "executed" } },
      { type: "text", content: "complete" },
    ]);
    __setStubModelForTests(scripted.model);

    await createNautiloGraph(undefined, createPolicyResolver()).invoke(
      graphInput({ fixture_deferred: "allow" }),
      { recursionLimit: 64 },
    );

    expect(scripted.bindings).toHaveLength(4);
    expect(scripted.bindings[0]).toContain("discover_tools");
    expect(scripted.bindings[0]).toContain("activate_tools");
    expect(scripted.bindings[0]).not.toContain("fixture_deferred");
    expect(scripted.bindings[1]).not.toContain("fixture_deferred");
    expect(scripted.bindings[2]).toContain("fixture_deferred");
    expect(scripted.bindings[3]).toContain("fixture_deferred");
    expect(executions).toEqual(["executed"]);
    expect(scripted.remaining).toBe(0);
  });

  test("eager mode admits and executes a deferred call through graph preflight, then persists its lease", async () => {
    process.env["NAUTILO_TEST_MODE"] = "stub";
    setConfigOverrides({
      nautilo_tool_exposure_mode: "eager",
      nautilo_tool_activation_retention_turns: 3,
    });
    const executions: string[] = [];
    registerGraphFixture(executions, "fixture_deferred");
    const scripted = createScriptedModel([
      { type: "tool", name: "fixture_deferred", args: { value: "eager-executed" } },
      { type: "text", content: "complete" },
    ]);
    __setStubModelForTests(scripted.model);

    const result = await createNautiloGraph(undefined, createPolicyResolver()).invoke({
      ...graphInput({ fixture_deferred: "allow" }),
      turnId: "eager-graph-turn",
    }) as NautiloState;

    expect(scripted.bindings).toHaveLength(2);
    expect(scripted.bindings.every((names) => names.includes("fixture_deferred"))).toBe(true);
    expect(executions).toEqual(["eager-executed"]);
    expect(result.activatedToolNames).toContain("fixture_deferred");
    expect(result.activatedToolLeases).toContainEqual({
      name: "fixture_deferred",
      idleTurns: 0,
    });
    expect(scripted.remaining).toBe(0);
  });

  test("an active Writer request discovers and activates only its live-review surface before use", async () => {
    process.env["NAUTILO_TEST_MODE"] = "stub";
    const executions: string[] = [];
    const reviewTools = [
      "app_nautilo_writer__edit_open_writer",
      "app_nautilo_writer__read_open_writer_range",
      "app_nautilo_writer__locate_open_writer_text",
    ];
    registerWriterReviewGraphFixture(executions);
    const scripted = createScriptedModel([
      {
        type: "tool",
        name: "discover_tools",
        args: { query: "Writer review", category: "documents" },
      },
      { type: "tool", name: "activate_tools", args: { names: reviewTools, families: [] } },
      {
        type: "tool",
        name: "app_nautilo_writer__read_open_writer_range",
        args: { sessionToken: "opaque-session-token", baseRevision: 7, blockId: "block-1" },
      },
      {
        type: "tool",
        name: "app_nautilo_writer__locate_open_writer_text",
        args: { sessionToken: "opaque-session-token", baseRevision: 7, blockId: "block-1", target: "ambiguous text" },
      },
      {
        type: "tool",
        name: "app_nautilo_writer__edit_open_writer",
        args: { sessionToken: "opaque-session-token", baseRevision: 7, operations: [] },
      },
      { type: "text", content: "Review proposal prepared." },
    ]);
    __setStubModelForTests(scripted.model);

    await createNautiloGraph(undefined, createPolicyResolver()).invoke(
      graphInput(
        Object.fromEntries([
          ...reviewTools,
          "app_nautilo_writer__replace_text",
          "app_nautilo_writer__delete_blocks",
        ].map((name) => [name, "allow"])),
        undefined,
        "Review the active Writer document and prepare a suggestion.",
      ),
      { recursionLimit: 64 },
    );

    expect(scripted.bindings[0]).not.toEqual(expect.arrayContaining(reviewTools));
    expect(scripted.bindings[1]).not.toEqual(expect.arrayContaining(reviewTools));
    const activatedBinding = scripted.bindings.find((names) =>
      reviewTools.every((name) => names.includes(name)),
    );
    expect(activatedBinding).toBeDefined();
    expect(activatedBinding).not.toContain("app_nautilo_writer__replace_text");
    expect(activatedBinding).not.toContain("app_nautilo_writer__delete_blocks");
    expect(executions).toEqual([
      "app_nautilo_writer__read_open_writer_range",
      "app_nautilo_writer__locate_open_writer_text",
      "app_nautilo_writer__edit_open_writer",
    ]);
    expect(scripted.remaining).toBe(0);
  });

  test("none mode binds no core or deferred tool schemas", async () => {
    process.env["NAUTILO_TEST_MODE"] = "stub";
    const executions: string[] = [];
    registerGraphFixture(executions, "fixture_deferred");
    const scripted = createScriptedModel([{ type: "text", content: "complete without tools" }]);
    __setStubModelForTests(scripted.model);

    await createNautiloGraph(undefined, createPolicyResolver()).invoke(
      graphInput({ fixture_deferred: "allow" }, []),
    );

    expect(scripted.bindings).toEqual([[]]);
    expect(executions).toEqual([]);
    expect(scripted.remaining).toBe(0);
  });

  test("an explicit whitelist prevents activation from exposing an omitted deferred tool", async () => {
    process.env["NAUTILO_TEST_MODE"] = "stub";
    const executions: string[] = [];
    registerGraphFixture(executions, "fixture_deferred");
    const scripted = createScriptedModel([
      { type: "tool", name: "activate_tools", args: { names: ["fixture_deferred"], families: [] } },
      { type: "text", content: "activation rejected" },
    ]);
    __setStubModelForTests(scripted.model);

    await createNautiloGraph(undefined, createPolicyResolver()).invoke(
      graphInput(
        { fixture_deferred: "allow" },
        ["discover_tools", "activate_tools"],
      ),
    );

    expect(scripted.bindings).toHaveLength(2);
    expect(scripted.bindings.every((names) => !names.includes("fixture_deferred"))).toBe(true);
    expect(executions).toEqual([]);
    expect(scripted.remaining).toBe(0);
  });

  test("rejects a forbidden deferred fixture without changing policy or exposing its schema", async () => {
    process.env["NAUTILO_TEST_MODE"] = "stub";
    const executions: string[] = [];
    const policy = Object.freeze({ fixture_forbidden: "forbidden" as const });
    registerGraphFixture(executions, "fixture_forbidden");
    const scripted = createScriptedModel([
      { type: "tool", name: "activate_tools", args: { names: ["fixture_forbidden"], families: [] } },
      { type: "text", content: "activation denied" },
    ]);
    __setStubModelForTests(scripted.model);

    await createNautiloGraph(undefined, createPolicyResolver()).invoke(graphInput(policy));

    expect(scripted.bindings).toHaveLength(2);
    expect(scripted.bindings[0]).toContain("activate_tools");
    expect(scripted.bindings.every((names) => !names.includes("fixture_forbidden"))).toBe(true);
    expect(executions).toEqual([]);
    expect(policy).toEqual({ fixture_forbidden: "forbidden" });
    expect(scripted.remaining).toBe(0);
  });
});
