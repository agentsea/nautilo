import { afterEach, describe, expect, test } from "bun:test";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { ToolCatalog, clearToolCatalog, initToolCatalog } from "@nautilo/catalog";
import { setConfigOverrides } from "@nautilo/config";
import { z } from "zod";
import { createActivateToolsTool } from "../../src/tools/meta/activate-tools";
import { createDeactivateToolsTool } from "../../src/tools/meta/deactivate-tools";
import { createActivatedToolsHandle } from "../../src/tools/meta/activated-tools-handle";
import { registerAllTools } from "../../src/tools/register-all";

afterEach(() => {
  clearToolCatalog();
  setConfigOverrides({ nautilo_office_enabled: false });
});

function registerTool(
  catalog: ToolCatalog,
  name: string,
  exposure: "core" | "discoverable",
  options: {
    executor?: "relay";
    requiredCapabilities?: string[];
  } = {},
) {
  catalog.register({
    name,
    exposure,
    category: "meta",
    trustTier: "guest",
    impact: "read-only",
    ...options,
    factory: () => new DynamicStructuredTool({
      name,
      description: name,
      schema: z.object({}),
      func: async () => "ok",
    }),
  });
}

const localOrigin = {
  kind: "local_electron" as const,
  userId: "user-1",
  actorId: "actor-1",
  relayId: "relay-1",
  desktopSessionId: "desktop-session-1",
  pairingGeneration: "pairing-1",
  requestId: "request-1",
};

describe("activate_tools", () => {
  test("activates only eligible deferred tools and reports rejections", async () => {
    const catalog = new ToolCatalog();
    registerTool(catalog, "discover_tools", "core");
    registerTool(catalog, "file", "discoverable");
    registerTool(catalog, "blocked", "discoverable");
    initToolCatalog(catalog);

    const activatedTools = createActivatedToolsHandle();
    const tool = createActivateToolsTool({
      activatedTools,
      memoryAccessEnvelope: {
        ownerId: "owner",
        actorId: "actor",
        agentId: "agent",
        roomId: "room",
        readableNamespaces: [],
        mutableNamespaces: [],
        writableNamespaces: [],
        toolPolicy: { file: "allow", blocked: "forbidden" },
      },
    });

    const result = z.object({
      accepted: z.array(z.string()),
      rejected: z.array(z.object({ selection: z.string(), reason: z.string() })),
      activeToolNames: z.array(z.string()),
      note: z.string(),
    }).parse(JSON.parse(await tool.invoke({
      names: ["file", "blocked", "missing"],
      families: [],
    })));

    expect(result.accepted).toEqual(["file"]);
    expect(result.rejected).toEqual([
      { selection: "blocked", reason: "not authorized or unavailable in this runtime" },
      { selection: "missing", reason: "unknown tool" },
    ]);
    expect(activatedTools.snapshot()).toEqual(["file"]);
    expect(activatedTools.snapshotLeases()).toEqual([{ name: "file", idleTurns: 0 }]);
    expect(result.note).toContain("next model step");
  });

  test("activates only the discovered Writer review tools, not direct Writer mutations", async () => {
    const catalog = new ToolCatalog();
    const reviewTools = [
      "app_nautilo_writer__edit_open_writer",
      "app_nautilo_writer__read_open_writer_range",
      "app_nautilo_writer__locate_open_writer_text",
    ];
    const directMutationTools = [
      "app_nautilo_writer__replace_text",
      "app_nautilo_writer__delete_blocks",
    ];
    for (const name of [...reviewTools, ...directMutationTools]) {
      registerTool(catalog, name, "discoverable");
    }
    initToolCatalog(catalog);

    const activatedTools = createActivatedToolsHandle();
    const result = z.object({
      accepted: z.array(z.string()),
      rejected: z.array(z.object({ selection: z.string(), reason: z.string() })),
      activeToolNames: z.array(z.string()),
    }).parse(JSON.parse(await createActivateToolsTool({
      activatedTools,
      memoryAccessEnvelope: {
        ownerId: "owner",
        actorId: "actor",
        agentId: "agent",
        roomId: "room",
        readableNamespaces: [],
        mutableNamespaces: [],
        writableNamespaces: [],
        toolPolicy: Object.fromEntries(
          [...reviewTools, ...directMutationTools].map((name) => [name, "allow"]),
        ),
      },
    }).invoke({ names: reviewTools, families: [] })));

    expect(result.accepted).toEqual(reviewTools);
    expect(result.rejected).toEqual([]);
    expect(result.activeToolNames).toEqual(reviewTools);
    expect(result.activeToolNames).not.toContain("app_nautilo_writer__replace_text");
    expect(result.activeToolNames).not.toContain("app_nautilo_writer__delete_blocks");
  });

  test("rejects a required relay schema that post-model would categorically forbid", async () => {
    const catalog = new ToolCatalog();
    registerTool(catalog, "terminal", "discoverable", { executor: "relay" });
    initToolCatalog(catalog);

    const result = JSON.parse(await createActivateToolsTool({
      activatedTools: createActivatedToolsHandle(),
      relayCapabilities: {},
    }).invoke({ names: ["terminal"], families: [] })) as {
      accepted: string[];
      rejected: Array<{ selection: string; reason: string }>;
    };
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([{
      selection: "terminal",
      reason: "host-scoped tools require a verified authorized-computer origin",
    }]);
  });

  test("allows a required relay schema with local Electron origin, but keeps invocation revalidation explicit", async () => {
    const catalog = new ToolCatalog();
    registerTool(catalog, "terminal", "discoverable", { executor: "relay" });
    initToolCatalog(catalog);

    const result = JSON.parse(await createActivateToolsTool({
      activatedTools: createActivatedToolsHandle(),
      relayCapabilities: {},
      verifiedOrdinaryOrigin: localOrigin,
    }).invoke({ names: ["terminal"], families: [] })) as {
      accepted: string[];
      note: string;
    };
    expect(result.accepted).toEqual(["terminal"]);
    expect(result.note).toContain("revalidated at invocation");
  });

  test("keeps security_scan inside a durable Task even for a live Desktop Room", async () => {
    const catalog = new ToolCatalog();
    registerAllTools(catalog, { officeCliAvailable: () => false });
    initToolCatalog(catalog);

    const roomResult = JSON.parse(await createActivateToolsTool({
      activatedTools: createActivatedToolsHandle(),
      relayCapabilities: { canReadWorkspace: true },
      verifiedOrdinaryOrigin: localOrigin,
    }).invoke({ names: ["security_scan"], families: [] })) as {
      accepted: string[];
      rejected: Array<{ selection: string; reason: string }>;
    };
    expect(roomResult.accepted).toEqual([]);
    expect(roomResult.rejected).toEqual([{
      selection: "security_scan",
      reason: "Task-internal worker tool; from a Room call in_background with tools [\"file\", \"security_scan\"]",
    }]);

    const taskResult = JSON.parse(await createActivateToolsTool({
      activatedTools: createActivatedToolsHandle(),
      relayCapabilities: { canReadWorkspace: true },
      taskReportBackContinuation: {
        status: "available",
        relayId: "relay-1",
        relaySessionId: "socket-1",
        desktopSessionId: "desktop-1",
        pairingGeneration: "pairing-1",
        currentFolder: "/repo",
        workspacePath: "/workspace",
      },
    }).invoke({ names: ["security_scan"], families: [] })) as { accepted: string[] };
    expect(taskResult.accepted).toEqual(["security_scan"]);
  });

  test("allows exact Task report-back continuation without manufacturing a Human origin", async () => {
    const catalog = new ToolCatalog();
    registerTool(catalog, "terminal", "discoverable", { executor: "relay" });
    registerTool(catalog, "browser_snapshot", "discoverable", { executor: "relay" });
    initToolCatalog(catalog);

    const continuation = {
      status: "available" as const,
      relayId: "relay-1",
      relaySessionId: "socket-1",
      desktopSessionId: "desktop-1",
      pairingGeneration: "pairing-1",
      currentFolder: "/repo",
      workspacePath: "/workspace",
      browserSessionId: "browser-1",
    };
    const available = JSON.parse(await createActivateToolsTool({
      activatedTools: createActivatedToolsHandle(),
      relayCapabilities: {},
      verifiedOrdinaryOrigin: null,
      taskReportBackContinuation: continuation,
    }).invoke({ names: ["terminal", "browser_snapshot"], families: [] })) as {
      accepted: string[];
    };
    expect(available.accepted).toEqual(["terminal", "browser_snapshot"]);

    const { browserSessionId: _expiredBrowserSession, ...continuationWithoutBrowser } = continuation;
    const expiredBrowser = JSON.parse(await createActivateToolsTool({
      activatedTools: createActivatedToolsHandle(),
      relayCapabilities: {},
      verifiedOrdinaryOrigin: null,
      taskReportBackContinuation: continuationWithoutBrowser,
    }).invoke({ names: ["terminal", "browser_snapshot"], families: [] })) as {
      accepted: string[];
      rejected: Array<{ selection: string; reason: string }>;
    };
    expect(expiredBrowser.accepted).toEqual(["terminal"]);
    expect(expiredBrowser.rejected).toEqual([{
      selection: "browser_snapshot",
      reason: "the original embedded Browser session is no longer available",
    }]);
  });

  test("rejects paired-mobile browser schemas but leaves cloud and reviewed connection tools unaffected", async () => {
    const catalog = new ToolCatalog();
    registerTool(catalog, "browser_snapshot", "discoverable", { executor: "relay" });
    registerTool(catalog, "google_workspace", "discoverable", { executor: "relay" });
    registerTool(catalog, "search_memory", "discoverable");
    initToolCatalog(catalog);

    const result = JSON.parse(await createActivateToolsTool({
      activatedTools: createActivatedToolsHandle(),
      relayCapabilities: {},
      verifiedOrdinaryOrigin: {
        kind: "paired_mobile",
        serverInstanceId: "server-1",
        serverBindingGeneration: 1,
        userId: "user-1",
        actorId: "actor-1",
        controllerInstallationId: "controller-1",
        installationGeneration: 1,
        requestId: "request-1",
      },
    }).invoke({ names: ["browser_snapshot", "google_workspace", "search_memory"], families: [] })) as {
      accepted: string[];
      rejected: Array<{ selection: string; reason: string }>;
    };
    expect(result.accepted).toEqual(["google_workspace", "search_memory"]);
    expect(result.rejected).toEqual([{
      selection: "browser_snapshot",
      reason: "browser tools are not available from paired mobile in this release",
    }]);
  });

  test("reports the handle's atomic capacity rejection", async () => {
    const catalog = new ToolCatalog();
    registerTool(catalog, "already_active", "discoverable");
    registerTool(catalog, "file", "discoverable");
    initToolCatalog(catalog);

    const activatedTools = createActivatedToolsHandle(["already_active"], 1);
    const result = z.object({
      accepted: z.array(z.string()),
      rejected: z.array(z.object({ selection: z.string(), reason: z.string() })),
      activeToolNames: z.array(z.string()),
    }).parse(JSON.parse(await createActivateToolsTool({ activatedTools }).invoke({
      names: ["file"],
      families: [],
    })));

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([
      { selection: "file", reason: "activation limit reached" },
    ]);
    expect(result.activeToolNames).toEqual(["already_active"]);
  });

  test("productivity family follows office and OfficeCLI registration gates", async () => {
    setConfigOverrides({ nautilo_office_enabled: false });
    const withoutOffice = new ToolCatalog();
    registerAllTools(withoutOffice, { officeCliAvailable: () => false });
    initToolCatalog(withoutOffice);

    const absentResult = JSON.parse(await createActivateToolsTool({
      activatedTools: createActivatedToolsHandle(),
    }).invoke({ names: [], families: ["productivity"] })) as {
      accepted: string[];
      rejected: Array<{ selection: string }>;
    };
    expect(absentResult.accepted).not.toContain("office");
    expect(absentResult.accepted).not.toContain("edit_doc");
    expect(absentResult.accepted).not.toContain("officecli");
    const absentSelections = absentResult.rejected.map(({ selection }) => selection);
    expect(absentSelections).not.toContain("office");
    expect(absentSelections).not.toContain("edit_doc");
    expect(absentSelections).not.toContain("officecli");

    setConfigOverrides({ nautilo_office_enabled: true });
    const availableOffice = new ToolCatalog();
    registerAllTools(availableOffice, { officeCliAvailable: () => true });
    initToolCatalog(availableOffice);
    const availableResult = JSON.parse(await createActivateToolsTool({
      activatedTools: createActivatedToolsHandle(),
    }).invoke({ names: [], families: ["productivity"] })) as { accepted: string[] };
    expect(availableResult.accepted).toContain("office");
    expect(availableResult.accepted).toContain("edit_doc");
    expect(availableResult.accepted).toContain("officecli");
    setConfigOverrides({ nautilo_office_enabled: false });
  });

  test("rejects unknown family input before activation", () => {
    const tool = createActivateToolsTool({ activatedTools: createActivatedToolsHandle() });
    const parsed = tool.schema.safeParse({ names: [], families: ["not-reviewed"] });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.path).toEqual(["families", 0]);
    }
  });
});

describe("deactivate_tools", () => {
  test("removes active deferred tools without changing an external whitelist", async () => {
    const activatedTools = createActivatedToolsHandle(
      ["file", "run_shell"],
      undefined,
      [{ name: "file", idleTurns: 0 }, { name: "run_shell", idleTurns: 0 }],
    );
    const toolWhitelist = ["discover_tools"];
    const tool = createDeactivateToolsTool({ activatedTools });

    const result = z.object({
      deactivated: z.array(z.string()),
      activeToolNames: z.array(z.string()),
      note: z.string(),
    }).parse(JSON.parse(await tool.invoke({
      names: ["file", "not-active"],
      families: [],
    })));

    expect(result.deactivated).toEqual(["file"]);
    expect(result.activeToolNames).toEqual(["run_shell"]);
    expect(activatedTools.snapshot()).toEqual(["run_shell"]);
    expect(activatedTools.snapshotLeases()).toEqual([{ name: "run_shell", idleTurns: 0 }]);
    expect(toolWhitelist).toEqual(["discover_tools"]);
    expect(result.note).toContain("next model step");
  });
});
