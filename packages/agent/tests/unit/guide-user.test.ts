import { describe, expect, test } from "bun:test";
import { clearToolCatalog, initToolCatalog, ToolCatalog } from "@nautilo/catalog";
import { buildGuestToolPolicy } from "@nautilo/trust";
import {
  GENIE_APPLICATION_BRIDGE_VERSION_V1,
  BUNDLED_APPLICATION_CATALOGUE_V1,
  UI_TARGET_IDS_V1,
  guideUserArgsV1Schema,
  guideUserResultV1Schema,
  type UiPresentation,
} from "@nautilo/types";
import {
  createGuideUserTool,
  discoverGuideUserTargets,
} from "../../src/tools/config/guide-user";
import { registerAllTools } from "../../src/tools/register-all";

const actionId = "guide-user-action-1";

function parseGuideUserToolResult(value: unknown) {
  if (typeof value !== "string") throw new Error("guide_user returned a non-string result");
  return guideUserResultV1Schema.parse(JSON.parse(value) as unknown);
}

async function invoke(
  input: Record<string, unknown>,
  context: Parameters<typeof createGuideUserTool>[0] = {},
) {
  const tool = createGuideUserTool({ actionIdFactory: () => actionId, ...context });
  return parseGuideUserToolResult(await tool.invoke(input));
}

describe("guide_user", () => {
  test("uses the shared strict union for every valid target and presentation", () => {
    expect(guideUserArgsV1Schema.parse({
      version: GENIE_APPLICATION_BRIDGE_VERSION_V1,
      query: "google workspace",
    })).toMatchObject({ query: "google workspace" });
    for (const target of UI_TARGET_IDS_V1) {
      for (const presentation of ["link", "reveal", "spotlight"] satisfies UiPresentation[]) {
        expect(guideUserArgsV1Schema.parse({
          version: GENIE_APPLICATION_BRIDGE_VERSION_V1,
          target,
          presentation,
          confirmed: true,
        })).toMatchObject({ target, presentation, confirmed: true });
      }
    }
  });

  test("rejects extra fields, route, selector, and generic-click input attempts", () => {
    for (const invalid of [
      { version: 1, query: "google", target: "connections.google", presentation: "link", confirmed: true },
      { version: 1, query: "/connections#google" },
      { version: 1, query: "click #google" },
      { version: 1, query: "google\nworkspace" },
      { version: 1, query: "Cafe\u0301" },
      { version: 1, query: "😀".repeat(41) },
      { version: 1, target: "/settings#integrations", presentation: "link", confirmed: true },
      { version: 1, target: "connections.unknown", presentation: "link", confirmed: true },
      { version: 1, target: "connections.google", presentation: "click", confirmed: true },
      { version: 1, target: "connections.google", presentation: "link", confirmed: true, selector: "#google" },
      { version: 1, target: "connections.google", presentation: "link", confirmed: true, initiatingClientSurface: "workbench.desktop" },
    ]) {
      expect(() => guideUserArgsV1Schema.parse(invalid)).toThrow();
    }
  });

  test("ranks exact semantic matches first, requires every token, and keeps target-ID ties stable", () => {
    expect(discoverGuideUserTargets("connections.codex").map(({ target }) => target))
      .toEqual(["connections.codex"]);
    expect(discoverGuideUserTargets("Google Workspace").map(({ target }) => target))
      .toEqual(["connections.google"]);
    expect(discoverGuideUserTargets("Connections Google Workspace").map(({ target }) => target))
      .toEqual(["connections.google"]);
    expect(discoverGuideUserTargets("openai codex").map(({ target }) => target))
      .toEqual(["connections.codex"]);
    expect(discoverGuideUserTargets("moderation queue").map(({ target }) => target))
      .toEqual(["admin.reports"]);
    expect(discoverGuideUserTargets("server costs").map(({ target }) => target))
      .toEqual(["admin.costs"]);
    expect(discoverGuideUserTargets("work computers").map(({ target }) => target))
      .toEqual(["settings.devices"]);
    expect(discoverGuideUserTargets("web research provider").map(({ target }) => target))
      .toEqual(["admin.search"]);
    expect(discoverGuideUserTargets("mobile controllers").map(({ target }) => target))
      .toEqual(["settings.mobile_access"]);
    expect(discoverGuideUserTargets("connections").map(({ target }) => target)).toEqual([
      "connections",
      "connections.codex",
      "connections.github_cli",
      "connections.google",
      "connections.local_mcp",
    ]);
    expect(discoverGuideUserTargets("google ssh")).toEqual([]);
    expect(discoverGuideUserTargets("")).toEqual([]);
    expect(discoverGuideUserTargets("connections").length).toBeLessThanOrEqual(5);
  });

  test("returns a shared discovery record without routes or control semantics", async () => {
    const result = await invoke({ version: 1, query: "google" });
    expect(result).toEqual({
      version: 1,
      kind: "discovery",
      targets: [{
        target: "connections.google",
        label: "Google Workspace",
        menuPath: ["Connections", "Google Workspace"],
        description: "Configure, connect, or repair Google Workspace access.",
      }],
    });
    expect(JSON.stringify(result)).not.toMatch(/\/connections|#google|click/i);
  });

  test("normalizes non-foreground, subagent, system, and unconfirmed guidance to a durable link", async () => {
    for (const context of [
      {},
      { trustedExecutionEntrypoint: null },
      { trustedExecutionEntrypoint: "background.task" as const },
      { trustedExecutionEntrypoint: "foreground.task_report_back" as const },
      { trustedExecutionEntrypoint: "foreground.subagent" as const },
      { trustedExecutionEntrypoint: "foreground.fork" as const },
    ]) {
      const result = await invoke({
        version: 1,
        target: "connections.ssh",
        presentation: "spotlight",
        confirmed: true,
      }, context);
      expect(result).toMatchObject({
        kind: "guidance",
        actionId,
        target: "connections.ssh",
        presentation: "link",
        fallbackText: "Use Connections then SSH to continue.",
      });
    }
    const unconfirmed = await invoke({
      version: 1,
      target: "connections.codex",
      presentation: "reveal",
      confirmed: false,
    }, { trustedExecutionEntrypoint: "foreground.main" });
    expect(unconfirmed).toMatchObject({ kind: "guidance", presentation: "link" });
  });

  test("keeps Workbench and unknown confirmed foreground guidance unchanged", async () => {
    for (const initiatingClientSurface of ["workbench.desktop", "workbench.browser", "unknown"] as const) {
      for (const presentation of ["reveal", "spotlight"] satisfies UiPresentation[]) {
        const result = await invoke({
          version: 1,
          target: "connections.local_mcp",
          presentation,
          confirmed: true,
        }, { trustedExecutionEntrypoint: "foreground.main", initiatingClientSurface });
        expect(result).toMatchObject({
          version: 1,
          kind: "guidance",
          actionId,
          target: "connections.local_mcp",
          presentation,
          fallbackText: "Use Connections then Local MCP to continue.",
        });
        expect(JSON.stringify(result)).not.toMatch(/opened|revealed|spotlighted|ui\.action/i);
      }
    }
  });

  test("emits a strict route-free durable spotlight result for every bundled Workbench target", async () => {
    for (const target of UI_TARGET_IDS_V1) {
      const result = await invoke({
        version: GENIE_APPLICATION_BRIDGE_VERSION_V1,
        target,
        presentation: "spotlight",
        confirmed: true,
      }, {
        trustedExecutionEntrypoint: "foreground.main",
        initiatingClientSurface: "workbench.browser",
      });
      expect(result).toMatchObject({
        version: GENIE_APPLICATION_BRIDGE_VERSION_V1,
        kind: "guidance",
        actionId,
        target,
        presentation: "spotlight",
      });
      expect(JSON.stringify(result)).not.toMatch(/(?:\/|#|selector|href|route)/iu);
    }
  });

  test("Mobile always normalizes guidance and offers a truthful Desktop continuation", async () => {
    for (const initiatingClientSurface of ["mobile.native", "mobile.web"] as const) {
      for (const presentation of ["link", "reveal", "spotlight"] satisfies UiPresentation[]) {
        const result = await invoke({
          version: 1,
          target: "connections.local_mcp",
          presentation,
          confirmed: true,
        }, { trustedExecutionEntrypoint: "foreground.main", initiatingClientSurface });
        expect(result).toMatchObject({ kind: "guidance", presentation: "link" });
        if (result.kind !== "guidance") throw new Error("expected guidance");
        expect(result.fallbackText).toBe(
          "This Mobile client cannot open or map Local MCP. To continue this conversation in Nautilo Desktop, use Connections then Local MCP.",
        );
        expect(JSON.stringify(result)).not.toMatch(/opened|highlighted|ui\.action/i);
      }
    }
  });

  test("generates an action ID only for guidance and validates injected IDs", async () => {
    let created = 0;
    const noDiscoveryId = createGuideUserTool({
      actionIdFactory: () => {
        created += 1;
        return actionId;
      },
    });
    await noDiscoveryId.invoke({ version: 1, query: "google" });
    expect(created).toBe(0);

    await noDiscoveryId.invoke({
      version: 1,
      target: "connections.google",
      presentation: "link",
      confirmed: true,
    });
    expect(created).toBe(1);

    const invalidId = createGuideUserTool({ actionIdFactory: () => "not an opaque ID" });
    expect(() => invalidId.invoke({
      version: 1,
      target: "connections.google",
      presentation: "link",
      confirmed: true,
    })).toThrow();
  });

  test("uses one injected metadata snapshot for discovery and fallback copy", async () => {
    const targets = BUNDLED_APPLICATION_CATALOGUE_V1.targets.map((target) => target.target === "connections.ssh"
      ? { ...target, label: "Remote SSH", menuPath: ["Remote Connections", "Remote SSH"] }
      : target);
    const catalogueSnapshot = { ...BUNDLED_APPLICATION_CATALOGUE_V1, provenance: "remote" as const, catalogueVersion: "2026-08-12.2", publishedAt: "2026-08-13T00:00:00.000Z", targets };
    const discovery = await invoke({ version: 1, query: "remote ssh" }, { catalogueSnapshot });
    expect(discovery).toMatchObject({ kind: "discovery", targets: [{ target: "connections.ssh", label: "Remote SSH" }] });
    const guidance = await invoke({
      version: 1,
      target: "connections.ssh",
      presentation: "link",
      confirmed: true,
    }, { catalogueSnapshot });
    expect(guidance).toMatchObject({ fallbackText: "Use Remote Connections then Remote SSH to continue." });
  });

  test("uses catalog context for authenticated guidance while guest and background paths stay truthful", async () => {
    const catalog = new ToolCatalog();
    registerAllTools(catalog);
    initToolCatalog(catalog);
    const entry = catalog.get("guide_user");
    expect(entry).toMatchObject({
      trustTier: "standard",
      impact: "read-only",
      exposure: "discoverable",
      requiresApproval: false,
    });
    expect(entry?.description).toBe(
      "Find a supported Nautilo destination or record confirmed guidance for the user. Use the query branch when the target is uncertain. Set confirmed true only when the current direct Human message explicitly requests that presentation or clearly accepts an earlier offer; otherwise set confirmed false and the durable result will be a link. When useful, accompany the card with concise conversational help: explain why the destination matters, state the Human-owned steps, and say what you can do after the Human finishes, such as retrying the blocked task. The current client surface is server-bound; it is not a tool argument and cannot be overridden. On Mobile, this tool always records a durable guidance card rather than a reveal or spotlight. Do not merely emit a card, invent controls or steps, imply a Human-owned step is complete, claim a UI opened, click controls, navigate a browser, enter credentials, or change settings.",
    );
    expect(catalog.getFiltered().entries.map((candidate) => candidate.name)).toContain("guide_user");
    expect(catalog.getFiltered(buildGuestToolPolicy()).entries.map((candidate) => candidate.name))
      .not.toContain("guide_user");

    const backgroundTool = catalog.getToolsForActor({
      trustedExecutionEntrypoint: "background.task",
    }).find((tool) => tool.name === "guide_user");
    expect(backgroundTool).toBeDefined();
    const result = parseGuideUserToolResult(await backgroundTool!.invoke({
      version: 1,
      target: "connections.codex",
      presentation: "reveal",
      confirmed: true,
    }));
    expect(result).toMatchObject({ kind: "guidance", presentation: "link" });
    clearToolCatalog();
  });
});


test("Memory health discovery resolves the operational card without replacing remembered information", () => {
  expect(discoverGuideUserTargets("memory health")[0]?.target).toBe("admin.memory");
  expect(discoverGuideUserTargets("automatic memory review")[0]?.target).toBe("admin.memory");
  expect(discoverGuideUserTargets("remembered information")[0]?.target).toBe("memory");
});

test("community moderation and joining review discover the installed admin destination", () => {
  for (const query of ["ban member", "pause joins", "joining requests", "enrollment approval"]) {
    expect(discoverGuideUserTargets(query)[0]?.target).toBe("admin.moderation");
  }
});
