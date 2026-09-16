import { afterEach, describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { DynamicStructuredTool } from "@langchain/core/tools";
import {
  ToolCatalog,
  clearToolCatalog,
  initToolCatalog,
  type ToolContext,
  type ToolRegistration,
} from "@nautilo/catalog";
import { setConfigOverrides } from "@nautilo/config";
import { z } from "zod";
import type { NautiloState } from "../../src/agent/state";
import { preModelNode } from "../../src/nodes/pre-model";
import { toolsNode } from "../../src/nodes/tools";

const RETAINED_TOOL = "retained_fixture";
const CORE_TOOL = "core_fixture";

type StateOverrides = Omit<Partial<NautiloState>, "memoryAccessEnvelope"> & {
  memoryAccessEnvelope?: Partial<NonNullable<NautiloState["memoryAccessEnvelope"]>>;
  readableNamespaces?: readonly string[];
};

function registration(
  name: string,
  overrides: Partial<ToolRegistration> = {},
  onExecute: () => void = () => {},
  onContext: (context: ToolContext) => void = () => {},
): ToolRegistration {
  return {
    name,
    exposure: "discoverable",
    category: "development",
    trustTier: "guest",
    impact: "read-only",
    factory: (context) => {
      if (context !== undefined) onContext(context);
      return new DynamicStructuredTool({
        name,
        description: `${name} D447 eligibility fixture`,
        schema: z.object({}),
        func: async () => {
          onExecute();
          return "ok";
        },
      });
    },
    ...overrides,
  };
}

function installCatalog(
  retainedOverrides: Partial<ToolRegistration> = {},
  onExecute: () => void = () => {},
  onContext: (context: ToolContext) => void = () => {},
): ToolCatalog {
  const catalog = new ToolCatalog();
  catalog.register(registration(CORE_TOOL, { exposure: "core" }));
  catalog.register(registration(RETAINED_TOOL, retainedOverrides, onExecute, onContext));
  initToolCatalog(catalog);
  return catalog;
}

function state(turnId: string, overrides: StateOverrides = {}): NautiloState {
  const {
    readableNamespaces = [],
    memoryAccessEnvelope: envelopeOverrides,
    ...stateOverrides
  } = overrides;
  const toolPolicy = envelopeOverrides?.toolPolicy ?? {
    [CORE_TOOL]: "allow",
    [RETAINED_TOOL]: "allow",
  };
  const memoryAccessEnvelope = {
    ownerId: "owner",
    actorId: "owner",
    agentId: "agent",
    roomId: "room",
    readableNamespaces: [...readableNamespaces],
    mutableNamespaces: [],
    writableNamespaces: [],
    toolPolicy,
    ...envelopeOverrides,
  };

  return {
    messages: [new HumanMessage("Hello there.")],
    model: "openai:gpt-5.5-2026-04-23",
    userId: "owner",
    personaId: "owner",
    actorRole: "owner",
    agentId: "agent",
    roomId: "room",
    turnId,
    relayCapabilities: {},
    activatedToolNames: [RETAINED_TOOL],
    activatedToolLeases: [{ name: RETAINED_TOOL, idleTurns: 0 }],
    activationLeasesInitialized: true,
    activationLeasesAgedForTurnId: "prior-turn",
    activationIntentAppliedForTurnId: "prior-turn",
    engagedSkillNames: [],
    ...stateOverrides,
    memoryAccessEnvelope,
  } as unknown as NautiloState;
}

function persistedActivation(patch: Partial<NautiloState>) {
  expect(patch.activatedToolNames).toBeDefined();
  expect(patch.activatedToolLeases).toBeDefined();
  expect(patch.activationLeasesInitialized).toBeDefined();
  return {
    activatedToolNames: patch.activatedToolNames ?? [],
    activatedToolLeases: patch.activatedToolLeases ?? [],
    activationLeasesInitialized: patch.activationLeasesInitialized ?? false,
    activationLeasesAgedForTurnId: patch.activationLeasesAgedForTurnId ?? "",
    activationIntentAppliedForTurnId: patch.activationIntentAppliedForTurnId ?? "",
  };
}

function systemPrompt(patch: Partial<NautiloState>): string {
  const first = patch.preparedMessages?.[0];
  expect(first).toBeInstanceOf(SystemMessage);
  return typeof first?.content === "string"
    ? first.content
    : JSON.stringify(first?.content);
}

function expectPromptProviderParity(
  patch: Partial<NautiloState>,
  name: string,
  exposed: boolean,
): void {
  expect(patch.toolNames?.includes(name)).toBe(exposed);
  expect(systemPrompt(patch).includes(`**${name}**:`)).toBe(exposed);
}

async function expectLossThenRecovery(
  lossOverrides: StateOverrides,
  recoveryOverrides: StateOverrides,
): Promise<void> {
  const loss = await preModelNode(state("loss-turn", lossOverrides));

  expect(loss.activatedToolNames).not.toContain(RETAINED_TOOL);
  expect(loss.activatedToolLeases).toEqual([{ name: RETAINED_TOOL, idleTurns: 1 }]);
  expectPromptProviderParity(loss, RETAINED_TOOL, false);

  const recovery = await preModelNode(state("recovery-turn", {
    ...recoveryOverrides,
    ...persistedActivation(loss),
  }));

  expect(recovery.activatedToolNames).toContain(RETAINED_TOOL);
  expect(recovery.activatedToolLeases).toEqual([{ name: RETAINED_TOOL, idleTurns: 2 }]);
  expectPromptProviderParity(recovery, RETAINED_TOOL, true);
}

afterEach(() => {
  clearToolCatalog();
  setConfigOverrides({});
});

describe("D447 retained-tool eligibility transitions", () => {
  test("policy loss withholds a retained schema and policy recovery restores it", async () => {
    installCatalog();
    await expectLossThenRecovery(
      {
        memoryAccessEnvelope: {
          toolPolicy: { [RETAINED_TOOL]: "forbidden" },
        },
      },
      {},
    );
  });

  test("relay loss withholds a retained schema and relay recovery restores it", async () => {
    installCatalog({
      executor: "relay",
      requiredCapabilities: ["canUseFixture"],
    });
    await expectLossThenRecovery(
      { relayCapabilities: {} },
      { relayCapabilities: { canUseFixture: true } },
    );
  });

  test("namespace loss withholds a retained schema and namespace recovery restores it", async () => {
    installCatalog({ namespaceId: "fixture-namespace" });
    await expectLossThenRecovery(
      { readableNamespaces: [] },
      { readableNamespaces: ["fixture-namespace"] },
    );
  });

  test("whitelist loss withholds a retained schema and whitelist recovery restores it", async () => {
    installCatalog();
    await expectLossThenRecovery(
      { toolWhitelist: [CORE_TOOL] },
      { toolWhitelist: [CORE_TOOL, RETAINED_TOOL] },
    );
  });

  test("model-capability loss withholds a retained schema and model recovery restores it", async () => {
    installCatalog({ requiredModelCapabilities: ["image"] });
    await expectLossThenRecovery(
      { model: "fireworks:accounts/fireworks/models/glm-5p2" },
      { model: "fireworks:accounts/fireworks/models/minimax-m3" },
    );
  });

  test("dynamic catalog removal withholds a retained schema and re-registration restores it", async () => {
    const retainedRegistration = registration(RETAINED_TOOL, {
      source: "mcp",
      sourceServer: "fixture-server",
    });
    const catalog = installCatalog({
      source: "mcp",
      sourceServer: "fixture-server",
    });
    catalog.refresh("fixture-server", []);

    const loss = await preModelNode(state("catalog-loss-turn"));
    expect(loss.activatedToolNames).not.toContain(RETAINED_TOOL);
    expect(loss.activatedToolLeases).toEqual([{ name: RETAINED_TOOL, idleTurns: 1 }]);
    expectPromptProviderParity(loss, RETAINED_TOOL, false);

    catalog.register(retainedRegistration);
    const recovery = await preModelNode(state("catalog-recovery-turn", {
      ...persistedActivation(loss),
    }));
    expect(recovery.activatedToolNames).toContain(RETAINED_TOOL);
    expect(recovery.activatedToolLeases).toEqual([{ name: RETAINED_TOOL, idleTurns: 2 }]);
    expectPromptProviderParity(recovery, RETAINED_TOOL, true);
  });

  test("an eager-exposed deferred tool gains a lease on use and survives a progressive transition", async () => {
    let executions = 0;
    const factoryContexts: ToolContext[] = [];
    installCatalog({}, () => {
      executions += 1;
    }, (context) => {
      factoryContexts.push(context);
    });
    setConfigOverrides({
      nautilo_tool_exposure_mode: "eager",
      nautilo_tool_activation_retention_turns: 3,
    });

    const eager = await preModelNode(state("eager-turn", {
      activatedToolNames: [],
      activatedToolLeases: [],
    }));
    expectPromptProviderParity(eager, RETAINED_TOOL, true);
    expect(factoryContexts.length).toBeGreaterThan(0);
    expect(factoryContexts.every((context) =>
      (context["activatedToolNames"] as string[]).includes(RETAINED_TOOL)
    )).toBe(true);

    const call = {
      id: "call-retained",
      name: RETAINED_TOOL,
      args: {},
      type: "tool_call" as const,
    };
    const used = await toolsNode(state("eager-turn", {
      messages: [new AIMessage({ content: "", tool_calls: [call] })],
      approvedToolCalls: [call],
      toolNames: eager.toolNames ?? [],
      ...persistedActivation(eager),
    }));
    expect(executions).toBe(1);
    expect(used.activatedToolNames).toContain(RETAINED_TOOL);
    expect(used.activatedToolLeases).toContainEqual({ name: RETAINED_TOOL, idleTurns: 0 });

    setConfigOverrides({
      nautilo_tool_exposure_mode: "progressive",
      nautilo_tool_activation_retention_turns: 3,
    });
    const progressive = await preModelNode(state("progressive-turn", {
      ...persistedActivation(used),
      activationLeasesAgedForTurnId: eager.activationLeasesAgedForTurnId ?? "",
      activationIntentAppliedForTurnId: eager.activationIntentAppliedForTurnId ?? "",
    }));
    expectPromptProviderParity(progressive, RETAINED_TOOL, true);
    expect(progressive.activatedToolLeases).toContainEqual({
      name: RETAINED_TOOL,
      idleTurns: 1,
    });
  });
});
