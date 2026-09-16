import { describe, expect, test } from "bun:test";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { clearToolCatalog, initToolCatalog, ToolCatalog } from "@nautilo/catalog";
import { buildGuestToolPolicy } from "@nautilo/trust";
import { z } from "zod";
import { registerAllTools } from "../../src/tools/register-all";
import { createDiscoverToolsTool } from "../../src/tools/meta/discover-tools";

function registerDiscoveryFixture(catalog: ToolCatalog): void {
  const register = (
    name: string,
    tags: string[],
    options: { discovery?: { preferredReviewWorkflow?: boolean }; guidance?: string } = {},
  ) => catalog.register({
    name,
    factory: () => new DynamicStructuredTool({
      name,
      description: `${name} fixture`,
      schema: z.object({}),
      func: async () => "ok",
    }),
    category: "documents",
    trustTier: "standard",
    impact: "low",
    exposure: "discoverable",
    tags,
    ...options,
  });

  register("transcribe_audio", ["audio", "transcription", "stt", "voice"]);
  register("google_workspace", ["google", "email", "mail", "calendar"]);
  register("officecli", ["officecli", "office", "docx", "xlsx", "pptx", "document", "read", "render"]);
  register(
    "office",
    ["office", "proposal", "suggest", "suggestion", "review", "track-changes", "writer", "edit", "proofread", "proofreading"],
    {
      discovery: { preferredReviewWorkflow: true },
      guidance: "For reviewable proposals and edits, use office track_changes, then office review_changes. Direct Writer edits are not reviewable.",
    },
  );
  register("edit_doc", ["office", "edit", "writer"]);
}

function registerWriterReviewDiscoveryFixture(catalog: ToolCatalog): void {
  const register = (
    name: string,
    options: { review?: boolean; impact?: "read-only" | "high" } = {},
  ) => catalog.register({
    name,
    factory: () => new DynamicStructuredTool({
      name,
      description: `${name} Writer fixture`,
      schema: z.object({}),
      func: async () => "ok",
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
  register("app_nautilo_writer__create_file", { impact: "high" });
  register("app_nautilo_writer__inspect_document");
}

describe("discover_tools policy filtering", () => {
  test("guides Genie to the Human SSH toggle when the connected Mac is ready but access is off", async () => {
    const catalog = new ToolCatalog();
    registerAllTools(catalog);
    initToolCatalog(catalog);
    const tool = createDiscoverToolsTool({
      relayCapabilities: {
        use_high_impact_tools: true,
        canConfigureStructuredSsh: true,
        canConfigureStructuredSshCopy: true,
      },
      memoryAccessEnvelope: {
        ownerId: "owner-user",
        actorId: "actor-owner",
        agentId: "agent-genie",
        roomId: "room-owner",
        readableNamespaces: [],
        mutableNamespaces: [],
        writableNamespaces: [],
        toolPolicy: {},
      },
    });

    const result = JSON.parse(await tool.invoke({ query: "SSH" })) as Array<Record<string, unknown>>;
    expect(result).not.toHaveLength(0);
    for (const entry of result) {
      expect(entry).toMatchObject({
        family: "structured_ssh",
        activatable: false,
        availability: "needs_human_enablement",
      });
      expect(entry["guidance"]).toBe(
        "SSH access is off on the connected Mac. Ask the authorized Human to open SSH setup, turn it on with their PIN, then retry the request.",
      );
      expect(entry["recovery"]).toMatchObject({ recovery: { target: "connections.ssh", requirement: "pin", domainTool: entry["name"] } });
    }
    clearToolCatalog();
  });

  test("does not reveal run_shell to non-owner actors", async () => {
    const catalog = new ToolCatalog();
    registerAllTools(catalog);
    initToolCatalog(catalog);

    const tool = createDiscoverToolsTool({
      actorRole: "household",
      memoryAccessEnvelope: {
        ownerId: "household-user",
        actorId: "actor-household",
        agentId: "agent-genie",
        roomId: "room-household",
        readableNamespaces: [],
        mutableNamespaces: [],
        writableNamespaces: [],
        toolPolicy: { run_shell: "forbidden" },
      },
    });

    const result = await tool.invoke({ query: "shell", category: "development" });

    expect(result).not.toContain("run_shell");
    expect(result).toContain("No tools found");
    clearToolCatalog();
  });

  test("still reveals allowed standard tools", async () => {
    const catalog = new ToolCatalog();
    registerAllTools(catalog);
    initToolCatalog(catalog);

    const tool = createDiscoverToolsTool({
      actorRole: "household",
      memoryAccessEnvelope: {
        ownerId: "household-user",
        actorId: "actor-household",
        agentId: "agent-genie",
        roomId: "room-household",
        readableNamespaces: ["ns-household"],
        mutableNamespaces: ["ns-household"],
        writableNamespaces: ["ns-household"],
        toolPolicy: { search_memory: "read_only" },
      },
    });

    const result = await tool.invoke({ query: "memory", category: "knowledge" });

    expect(result).toContain("search_memory");
    expect(result).not.toContain("run_shell");
    clearToolCatalog();
  });

  test("reports core tools as active and eligible deferred tools as activatable without schemas", async () => {
    const catalog = new ToolCatalog();
    registerAllTools(catalog);
    initToolCatalog(catalog);

    const tool = createDiscoverToolsTool({
      activeModelCapabilities: ["file"],
      memoryAccessEnvelope: {
        ownerId: "owner-user",
        actorId: "actor-owner",
        agentId: "agent-genie",
        roomId: "room-owner",
        readableNamespaces: ["ns-owner"],
        mutableNamespaces: ["ns-owner"],
        writableNamespaces: ["ns-owner"],
        toolPolicy: {},
      },
    });

    const result = JSON.parse(await tool.invoke({ query: "search" })) as Array<Record<string, unknown>>;
    const core = result.find((entry) => entry["name"] === "search_memory");
    const deferred = result.find((entry) => entry["name"] === "session_search");

    expect(core).toMatchObject({
      exposure: "core",
      active: true,
      activatable: false,
      availability: "active",
      family: null,
      approval: "none",
    });
    expect(deferred).toMatchObject({
      exposure: "discoverable",
      active: false,
      activatable: true,
      availability: "activatable",
      family: "memory",
    });
    expect(deferred).not.toHaveProperty("schema");
    expect(deferred).not.toHaveProperty("tags");
    clearToolCatalog();
  });

  test("reports security_scan as Task-only in a Room and activatable inside its Task", async () => {
    const catalog = new ToolCatalog();
    registerAllTools(catalog, { officeCliAvailable: () => false });
    initToolCatalog(catalog);
    const baseContext = {
      actorRole: "owner",
      relayCapabilities: { canReadWorkspace: true },
      memoryAccessEnvelope: {
        ownerId: "owner-user",
        actorId: "actor-owner",
        agentId: "agent-genie",
        roomId: "room-owner",
        readableNamespaces: [],
        mutableNamespaces: [],
        writableNamespaces: [],
        toolPolicy: { security_scan: "allow" as const },
      },
    };

    const roomResult = JSON.parse(await createDiscoverToolsTool(baseContext).invoke({
      query: "security scanner",
    })) as Array<Record<string, unknown>>;
    const roomSecurityScan = roomResult.find((entry) => entry["name"] === "security_scan");
    expect(roomSecurityScan).toMatchObject({
      active: false,
      activatable: false,
      availability: "task_only",
    });
    expect(roomSecurityScan?.["guidance"]).toBeString();
    expect(roomSecurityScan?.["guidance"] as string).toContain("in_background");

    const taskResult = JSON.parse(await createDiscoverToolsTool({
      ...baseContext,
      taskReportBackContinuation: {
        status: "available",
        relayId: "relay-1",
        relaySessionId: "socket-1",
        desktopSessionId: "desktop-1",
        pairingGeneration: "pairing-1",
        currentFolder: "/repo",
        workspacePath: "/workspace",
      },
    }).invoke({ query: "security scanner" })) as Array<Record<string, unknown>>;
    expect(taskResult.find((entry) => entry["name"] === "security_scan")).toMatchObject({
      active: false,
      activatable: true,
      availability: "activatable",
    });
    clearToolCatalog();
  });

  test("uses namespace and model gates before listing discoverable MCP metadata", async () => {
    const catalog = new ToolCatalog();
    registerAllTools(catalog);
    catalog.register({
      name: "mcp_fixture",
      factory: () => new DynamicStructuredTool({
        name: "mcp_fixture",
        description: "Namespace and vision guarded MCP fixture",
        schema: z.object({}),
        func: async () => "ok",
      }),
      category: "development",
      trustTier: "standard",
      impact: "read-only",
      exposure: "discoverable",
      source: "mcp",
      namespaceId: "fixture-namespace",
      requiredModelCapabilities: ["image"],
    });
    initToolCatalog(catalog);

    const unavailable = createDiscoverToolsTool({
      activeModelCapabilities: ["file"],
      memoryAccessEnvelope: {
        ownerId: "owner-user",
        actorId: "actor-owner",
        agentId: "agent-genie",
        roomId: "room-owner",
        readableNamespaces: ["other-namespace"],
        mutableNamespaces: [],
        writableNamespaces: [],
        toolPolicy: {},
      },
    });
    const unavailableResult = JSON.parse(
      await unavailable.invoke({ query: "MCP fixture" }),
    ) as Array<Record<string, unknown>>;
    expect(unavailableResult.map((entry) => entry["name"])).not.toContain("mcp_fixture");

    const available = createDiscoverToolsTool({
      activeModelCapabilities: ["image"],
      memoryAccessEnvelope: {
        ownerId: "owner-user",
        actorId: "actor-owner",
        agentId: "agent-genie",
        roomId: "room-owner",
        readableNamespaces: ["fixture-namespace"],
        mutableNamespaces: [],
        writableNamespaces: [],
        toolPolicy: {},
      },
    });
    const result = JSON.parse(await available.invoke({ query: "MCP fixture" })) as Array<Record<string, unknown>>;
    expect(result.find((entry) => entry["name"] === "mcp_fixture")).toMatchObject({
      name: "mcp_fixture",
      family: null,
      active: false,
      activatable: true,
      availability: "activatable",
    });
    clearToolCatalog();
  });

  test("finds file tool for natural interactive HTML artifact query", async () => {
    const catalog = new ToolCatalog();
    registerAllTools(catalog);
    initToolCatalog(catalog);

    const tool = createDiscoverToolsTool({
      actorRole: "owner",
      memoryAccessEnvelope: {
        ownerId: "owner-user",
        actorId: "actor-owner",
        agentId: "agent-genie",
        roomId: "room-owner",
        readableNamespaces: ["ns-owner"],
        mutableNamespaces: ["ns-owner"],
        writableNamespaces: ["ns-owner"],
        toolPolicy: { file: "allow" },
      },
    });

    const result = await tool.invoke({ query: "interactive HTML artifact workspace" });

    expect(result).toContain("\"name\": \"file\"");
    expect(result).toContain("interactive HTML artifact workspace");
    clearToolCatalog();
  });

  test("finds peer contact, exact sharing, and lookup across category hints with an entity name", async () => {
    const catalog = new ToolCatalog();
    registerAllTools(catalog);
    initToolCatalog(catalog);

    const result = JSON.parse(await createDiscoverToolsTool({
      actorRole: "standard",
      memoryAccessEnvelope: {
        ownerId: "malik-user",
        actorId: "actor-malik",
        agentId: "agent-rook",
        roomId: "room-malik-rook",
        readableNamespaces: ["ns-malik-rook"],
        mutableNamespaces: ["ns-malik-rook"],
        writableNamespaces: ["ns-malik-rook"],
        toolPolicy: {
          ask_peer: "allow",
          share_artifact: "allow",
          list_my_users: "read_only",
          get_room_members: "read_only",
        },
      },
    }).invoke({
      query: "contact Elias and get feedback on this document",
      category: "communication",
    })) as Array<Record<string, unknown>>;

    const names = result.map((entry) => entry["name"]);
    expect(names).toContain("ask_peer");
    expect(names).toContain("share_artifact");
    expect(names).toContain("list_my_users");
    expect(result.find((entry) => entry["name"] === "share_artifact")).toMatchObject({
      category: "documents",
      discoveryCategories: ["communication", "files"],
      requiredCapabilities: ["use_share_artifact"],
      searchScope: "category",
    });
    expect(result.find((entry) => entry["name"] === "ask_peer")).toMatchObject({
      category: "communication",
      requiredCapabilities: ["invoke_agents"],
      conditionalCapabilities: ["use_share_artifact"],
    });
    clearToolCatalog();
  });

  test("ranks multi-token semantic discovery results and prefers Office review workflows", async () => {
    const catalog = new ToolCatalog();
    registerDiscoveryFixture(catalog);
    initToolCatalog(catalog);
    const tool = createDiscoverToolsTool();

    const audioTranscription = JSON.parse(await tool.invoke({ query: "audio transcription" })) as Array<Record<string, unknown>>;
    const calendarEmail = JSON.parse(await tool.invoke({ query: "calendar email" })) as Array<Record<string, unknown>>;
    expect(audioTranscription[0]?.["name"]).toBe("transcribe_audio");
    expect(calendarEmail[0]?.["name"]).toBe("google_workspace");
    expect(await tool.invoke({ query: "video" })).toContain("No tools found");
    expect(await tool.invoke({ query: "extract" })).toContain("No tools found");

    const explicitlyNamed = JSON.parse(
      await tool.invoke({ query: "list and read Workspace artifacts DOCX officecli document inspection" }),
    ) as Array<Record<string, unknown>>;
    expect(explicitlyNamed[0]?.["name"]).toBe("officecli");

    const proposal = JSON.parse(await tool.invoke({ query: "proposal" })) as Array<Record<string, unknown>>;
    expect(proposal[0]).toMatchObject({
      name: "office",
      guidance: "For reviewable proposals and edits, use office track_changes, then office review_changes. Direct Writer edits are not reviewable.",
    });
    expect(proposal[0]?.["name"]).not.toBe("edit_doc");

    const proofreadWriter = JSON.parse(await tool.invoke({ query: "proofread writer" })) as Array<Record<string, unknown>>;
    expect(proofreadWriter[0]).toMatchObject({
      name: "office",
      guidance: "For reviewable proposals and edits, use office track_changes, then office review_changes. Direct Writer edits are not reviewable.",
    });
    expect(proofreadWriter.map((entry) => entry["name"])).toContain("edit_doc");
    clearToolCatalog();
  });

  test("prefers deferred Writer review without hiding eligible complementary tools", async () => {
    const catalog = new ToolCatalog();
    registerWriterReviewDiscoveryFixture(catalog);
    initToolCatalog(catalog);

    const result = JSON.parse(
      await createDiscoverToolsTool().invoke({ query: "Writer review", category: "documents" }),
    ) as Array<Record<string, unknown>>;

    expect(result.slice(0, 3).map((entry) => entry["name"])).toEqual([
      "app_nautilo_writer__edit_open_writer",
      "app_nautilo_writer__locate_open_writer_text",
      "app_nautilo_writer__read_open_writer_range",
    ]);
    for (const entry of result) {
      expect(entry).toMatchObject({
        exposure: "discoverable",
        active: false,
        activatable: true,
        availability: "activatable",
      });
    }
    expect(result.slice(0, 3).every(entry => String(entry["guidance"]).includes("validated live Writer review surface"))).toBe(true);
    expect(result.map(entry => entry["name"])).toContain("app_nautilo_writer__create_file");
    expect(result.map(entry => entry["name"])).toContain("app_nautilo_writer__inspect_document");
    const creation = JSON.parse(await createDiscoverToolsTool().invoke({
      query: "create and populate a new Writer document then review it",
    })) as Array<Record<string, unknown>>;
    expect(creation.map(entry => entry["name"])).toContain("app_nautilo_writer__create_file");
    expect(creation.map(entry => entry["name"])).toContain("app_nautilo_writer__inspect_document");
    clearToolCatalog();
  });

  test("does not leak a whitelisted-out Office tool through semantic discovery", async () => {
    const catalog = new ToolCatalog();
    registerDiscoveryFixture(catalog);
    initToolCatalog(catalog);

    const tool = createDiscoverToolsTool({ toolWhitelist: ["edit_doc"] });
    const result = await tool.invoke({ query: "proposal review" });

    expect(result).not.toContain('"name": "office"');
    expect(result).toContain("No tools found");
    clearToolCatalog();
  });

  test("does not leak an ineligible Office tool through semantic discovery", async () => {
    const catalog = new ToolCatalog();
    registerDiscoveryFixture(catalog);
    initToolCatalog(catalog);

    const tool = createDiscoverToolsTool({
      memoryAccessEnvelope: {
        ownerId: "owner-user",
        actorId: "actor-owner",
        agentId: "agent-genie",
        roomId: "room-owner",
        readableNamespaces: [],
        mutableNamespaces: [],
        writableNamespaces: [],
        toolPolicy: { office: "forbidden" },
      },
    });
    const result = await tool.invoke({ query: "proposal review" });

    expect(result).not.toContain('"name": "office"');
    expect(result).toContain("No tools found");
    clearToolCatalog();
  });

  test("D516: discover_tools reports the active signed-catalogue description", async () => {
    const catalog = new ToolCatalog();
    registerAllTools(catalog);
    initToolCatalog(catalog);
    const relayCapabilities = {
      use_high_impact_tools: true,
      canUseComputer: true,
      canComputerDo: true,
      canComputerFocus: true,
    };
    const memoryAccessEnvelope = {
      ownerId: "owner-user",
      actorId: "actor-owner",
      agentId: "agent-genie",
      roomId: "room-owner",
      readableNamespaces: ["ns-owner"],
      mutableNamespaces: ["ns-owner"],
      writableNamespaces: ["ns-owner"],
      toolPolicy: {
        computer_observe: "allow" as const,
        computer_do: "allow" as const,
      },
    };
    const discover = createDiscoverToolsTool({
      actorRole: "owner",
      memoryAccessEnvelope,
      relayCapabilities,
    });

    const result = JSON.parse(await discover.invoke({ category: "computer" })) as Array<{
      name: string;
      description: string;
    }>;
    const computerDo = result.find((entry) => entry.name === "computer_do");
    expect(computerDo?.description).toContain("one exact context-bound native Computer Use action");
    clearToolCatalog();
  });

  test("google workspace relay capability makes gog, Google Docs, and Drive discoverable", async () => {
    const catalog = new ToolCatalog();
    registerAllTools(catalog);
    initToolCatalog(catalog);

    const relayCapabilities = {
      use_high_impact_tools: true,
      canUseGoogleWorkspace: true,
      use_google_workspace: true,
    };
    const memoryAccessEnvelope = {
      ownerId: "owner-user",
      actorId: "actor-owner",
      agentId: "agent-genie",
      roomId: "room-owner",
      readableNamespaces: ["ns-owner"],
      mutableNamespaces: ["ns-owner"],
      writableNamespaces: ["ns-owner"],
      toolPolicy: { google_workspace: "allow" },
    };
    const discover = catalog
      .getToolsForActor(
        { actorRole: "owner", memoryAccessEnvelope, relayCapabilities },
        memoryAccessEnvelope.toolPolicy,
        relayCapabilities,
      )
      .find((tool) => tool.name === "discover_tools");
    expect(discover).toBeDefined();

    for (const query of ["gog", "Google Docs", "Drive"]) {
      const result = String(await discover!.invoke({ query }));
      expect(result).toContain('"name": "google_workspace"');
    }
    clearToolCatalog();
  });

  test("guide_user is an authenticated discoverable configuration action", async () => {
    const catalog = new ToolCatalog();
    registerAllTools(catalog);
    initToolCatalog(catalog);
    const tool = createDiscoverToolsTool({
      actorRole: "owner",
      memoryAccessEnvelope: {
        ownerId: "owner-user",
        actorId: "actor-owner",
        agentId: "agent-genie",
        roomId: "room-owner",
        readableNamespaces: [],
        mutableNamespaces: [],
        writableNamespaces: [],
        toolPolicy: {},
      },
    });

    const rawResult = await tool.invoke({ query: "help settings config navigation" });
    if (typeof rawResult !== "string") throw new Error("discover_tools returned a non-string result");
    const result = JSON.parse(rawResult) as Array<Record<string, unknown>>;
    const guide = result.find((candidate) => candidate["name"] === "guide_user");
    expect(guide).toMatchObject({
      name: "guide_user",
      family: "configuration",
      exposure: "discoverable",
      active: false,
      activatable: true,
    });
    clearToolCatalog();
  });

  test("guest discovery includes public web tools but hides private/runtime tools", async () => {
    const catalog = new ToolCatalog();
    registerAllTools(catalog);
    initToolCatalog(catalog);

    const guestPolicy = buildGuestToolPolicy();
    const relayCapabilities = { control_browser: true, canControlBrowser: true };

    const tool = createDiscoverToolsTool({
      actorRole: "guest",
      memoryAccessEnvelope: {
        ownerId: "guest-user",
        actorId: "actor-guest",
        agentId: "agent-genie",
        roomId: "room-public",
        readableNamespaces: [],
        mutableNamespaces: [],
        writableNamespaces: [],
        toolPolicy: guestPolicy,
      },
      relayCapabilities,
    });

    const rawResult = await tool.invoke({ query: "" });
    if (typeof rawResult !== "string") throw new Error("discover_tools returned a non-string result");
    const result = JSON.parse(rawResult) as Array<Record<string, unknown>>;
    const toolNames = result.map((candidate) => candidate["name"]);

    expect(toolNames).toContain("run_web_search");
    expect(toolNames).toContain("read_webpage");
    expect(toolNames).toContain("verify_identity");
    expect(toolNames).toContain("discover_tools");
    expect(toolNames).toContain("browser_read_page");
    expect(result.some((candidate) => candidate["active"] === true)).toBe(true);
    expect(toolNames).not.toContain("search_memory");
    expect(toolNames).not.toContain("check_config");
    expect(toolNames).not.toContain("file");
    expect(toolNames).not.toContain("run_shell");
    expect(toolNames).not.toContain("guide_user");
    clearToolCatalog();
  });
});
