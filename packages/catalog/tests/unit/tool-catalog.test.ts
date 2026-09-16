import { describe, test, expect, beforeEach } from "bun:test";
import { ToolCatalog } from "../../src/tool-catalog";
import type { ToolRegistration } from "../../src/tool-catalog";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

function makeTool(name: string, desc?: string) {
  return new DynamicStructuredTool({
    name,
    description: desc ?? `Test tool: ${name}`,
    schema: z.object({}),
     
    func: async () => "ok",
  });
}

function makeReg(overrides: Partial<ToolRegistration> & { name: string }): ToolRegistration {
  return {
    factory: () => makeTool(overrides.name),
    category: "meta",
    trustTier: "standard",
    impact: "read-only",
    ...overrides,
  };
}

describe("ToolCatalog", () => {
  let catalog: ToolCatalog;

  beforeEach(() => {
    catalog = new ToolCatalog();
  });

  test("live prerequisites remove discovery and execution eligibility without re-registration", () => {
    let ready = false;
    catalog.register(makeReg({
      name: "needs-provider",
      isAvailable: () => ready,
      unavailableReason: "Configure the provider, then retry.",
      exposure: "core",
      namespaceId: "private",
    }));
    expect(catalog.query({})).toHaveLength(0);
    expect(catalog.getFiltered().entries).toHaveLength(0);
    expect(catalog.getUnavailableReasonForExposure("needs-provider", {
      readableNamespaces: ["private"],
    })).toBe("Configure the provider, then retry.");
    expect(catalog.getUnavailableReasonForExposure("needs-provider", {
      readableNamespaces: [],
    })).toBeNull();
    expect(catalog.getUnavailableReasonForExposure("needs-provider", {
      readableNamespaces: ["private"],
      toolNameWhitelist: [],
    })).toBeNull();
    ready = true;
    expect(catalog.query({}).map((tool) => tool.name)).toEqual(["needs-provider"]);
    expect(catalog.getFiltered().entries).toHaveLength(1);
    expect(catalog.getUnavailableReasonForExposure("needs-provider", {
      readableNamespaces: ["private"],
    })).toBeNull();
    ready = false;
    expect(catalog.getFiltered().exclusions[0]?.reason).toBe("server prerequisite unavailable");
    expect(catalog.get("needs-provider")).not.toHaveProperty("unavailableReason");
    expect(catalog.getUnavailableReasonForExposure("missing")).toBeNull();
  });

  // -- register / unregister --

  test("turn prerequisites narrow fresh exposure without leaking recovery across authorization gates", () => {
    let instantiated = 0;
    catalog.register(makeReg({
      name: "needs-foreground",
      exposure: "core",
      namespaceId: "private",
      unavailableInContext: (context) => context?.["foreground"] === true
        ? null : "Wait for the current reply, then start a new request.",
      factory: () => { instantiated++; return makeTool("needs-foreground"); },
    }));
    instantiated = 0; // Registration owns one description probe.
    const unavailable = { context: { foreground: false }, readableNamespaces: ["private"] };
    expect(catalog.resolveProgressiveTools(unavailable).tools).toHaveLength(0);
    expect(instantiated).toBe(0);
    expect(catalog.getUnavailableReasonForExposure("needs-foreground", unavailable))
      .toContain("Wait for the current reply");
    expect(catalog.getUnavailableReasonForExposure("needs-foreground", {
      ...unavailable, readableNamespaces: [],
    })).toBeNull();
    expect(catalog.getUnavailableReasonForExposure("needs-foreground", {
      ...unavailable, toolPolicy: { "needs-foreground": "forbidden" },
    })).toBeNull();
    expect(catalog.resolveProgressiveTools({
      ...unavailable, context: { foreground: true },
    }).tools).toHaveLength(1);
    expect(catalog.resolveProgressiveTools(unavailable).tools).toHaveLength(0);
    expect(catalog.get("needs-foreground")).not.toHaveProperty("unavailableInContext");
  });

  describe("register", () => {
    test("registers and retrieves", () => {
      expect(catalog.register(makeReg({ name: "t" }))).toBe(true);
      expect(catalog.get("t")).toBeDefined();
      expect(catalog.size).toBe(1);
    });

    test("replaces same-source on re-register", () => {
      catalog.register(makeReg({ name: "t" }));
      catalog.register(makeReg({ name: "t" }));
      expect(catalog.size).toBe(1);
    });

    test("rejects MCP shadowing builtin", () => {
      catalog.register(makeReg({ name: "run_shell" }));
      const ok = catalog.register(makeReg({ name: "run_shell", source: "mcp" }));
      expect(ok).toBe(false);
      expect(catalog.get("run_shell")?.source).toBe("builtin");
    });

    test("rejects plugin shadowing builtin", () => {
      catalog.register(makeReg({ name: "x" }));
      expect(catalog.register(makeReg({ name: "x", source: "plugin" }))).toBe(false);
    });

    test("rejects relay shadowing builtin", () => {
      catalog.register(makeReg({ name: "x" }));
      expect(catalog.register(makeReg({ name: "x", source: "relay" }))).toBe(false);
    });

    test("allows MCP-to-MCP overwrite", () => {
      catalog.register(makeReg({ name: "m", source: "mcp", sourceServer: "a" }));
      expect(catalog.register(makeReg({ name: "m", source: "mcp", sourceServer: "b" }))).toBe(true);
      expect(catalog.get("m")?.sourceServer).toBe("b");
    });

    test("allows builtin to overwrite MCP", () => {
      catalog.register(makeReg({ name: "t", source: "mcp" }));
      expect(catalog.register(makeReg({ name: "t" }))).toBe(true);
      expect(catalog.get("t")?.source).toBe("builtin");
    });

    test("D069 — requiredModelCapabilities plumbs from registration to entry", () => {
      catalog.register(
        makeReg({
          name: "needs_vision",
          requiredModelCapabilities: ["image"],
        }),
      );
      expect(catalog.get("needs_vision")?.requiredModelCapabilities).toEqual([
        "image",
      ]);

      catalog.register(makeReg({ name: "no_modality_gate" }));
      expect(
        catalog.get("no_modality_gate")?.requiredModelCapabilities,
      ).toBeUndefined();
    });

    test("D419 — exposure plumbs from registration to metadata snapshots", () => {
      catalog.register(makeReg({ name: "core_tool", exposure: "core" }));
      catalog.register(makeReg({ name: "discoverable_tool", exposure: "discoverable" }));
      catalog.register(makeReg({ name: "unmigrated_tool" }));

      expect(catalog.get("core_tool")?.exposure).toBe("core");
      expect(catalog.get("discoverable_tool")?.exposure).toBe("discoverable");
      expect(catalog.get("unmigrated_tool")?.exposure).toBeUndefined();
      expect(
        catalog.getFiltered().entries.find((entry) => entry.name === "discoverable_tool")?.exposure,
      ).toBe("discoverable");
      expect(
        catalog.query({}).find((entry) => entry.name === "core_tool")?.exposure,
      ).toBe("core");
    });

    test("D419 — discovery metadata remains descriptive catalog metadata", () => {
      catalog.register(makeReg({
        name: "office",
        discovery: { preferredReviewWorkflow: true },
      }));

      expect(catalog.get("office")?.discovery).toEqual({
        preferredReviewWorkflow: true,
      });
      expect(catalog.getFiltered().entries.find((entry) => entry.name === "office")?.discovery)
        .toEqual({ preferredReviewWorkflow: true });
    });

    test("extracts description from factory", () => {
      catalog.register({
        name: "d",
        factory: () => makeTool("d", "My description"),
        category: "meta",
        trustTier: "standard",
        impact: "read-only",
      });
      expect(catalog.get("d")?.description).toBe("My description");
    });

    test("preserves Connection requirements as metadata only", () => {
      catalog.register(makeReg({
        name: "needs_connection",
        connections: [{
          service: "github",
          field: "api_key",
          category: "user",
          required: false,
          authShape: "api_key",
          displayLabel: "GitHub API key",
        }],
      }));

      expect(catalog.get("needs_connection")?.connections).toEqual([{
        service: "github",
        field: "api_key",
        category: "user",
        required: false,
        authShape: "api_key",
        displayLabel: "GitHub API key",
      }]);
    });

    test("throws if factory produces no description", () => {
      expect(() => catalog.register({
        name: "bad",
        factory: () => makeTool("bad", ""),
        category: "meta",
        trustTier: "standard",
        impact: "read-only",
      })).toThrow("no description");
    });

    test("increments generation", () => {
      const g0 = catalog.currentGeneration;
      catalog.register(makeReg({ name: "a" }));
      expect(catalog.currentGeneration).toBe(g0 + 1);
    });
  });

  describe("unregister", () => {
    test("removes tool", () => {
      catalog.register(makeReg({ name: "t" }));
      expect(catalog.unregister("t")).toBe(true);
      expect(catalog.has("t")).toBe(false);
    });

    test("returns false for unknown", () => {
      expect(catalog.unregister("nope")).toBe(false);
    });
  });

  describe("unregisterByServer", () => {
    test("removes all tools from server", () => {
      catalog.register(makeReg({ name: "a", source: "mcp", sourceServer: "s1" }));
      catalog.register(makeReg({ name: "b", source: "mcp", sourceServer: "s1" }));
      catalog.register(makeReg({ name: "c", source: "mcp", sourceServer: "s2" }));
      expect(catalog.unregisterByServer("s1")).toBe(2);
      expect(catalog.has("a")).toBe(false);
      expect(catalog.has("c")).toBe(true);
    });
  });

  describe("dynamic registration lifecycle", () => {
    test("removing an activated dynamic tool leaves no schema or executable capability", () => {
      let calls = 0;
      catalog.register(makeReg({
        name: "dynamic_tool",
        source: "mcp",
        sourceServer: "dynamic-server",
        exposure: "discoverable",
        factory: () => new DynamicStructuredTool({
          name: "dynamic_tool",
          description: "A dynamically registered tool",
          schema: z.object({ path: z.string() }),
          func: async () => {
            calls += 1;
            return "called";
          },
        }),
      }));

      const active = catalog.resolveProgressiveTools({
        activatedToolNames: ["dynamic_tool"],
      });
      expect(active.snapshot.entries.map((entry) => entry.name)).toEqual(["dynamic_tool"]);
      expect(active.tools).toHaveLength(1);

      const beforeRemovalGeneration = catalog.currentGeneration;
      catalog.refresh("dynamic-server", []);

      const staleActivation = catalog.resolveProgressiveTools({
        activatedToolNames: ["dynamic_tool"],
      });
      expect(catalog.currentGeneration).toBeGreaterThan(beforeRemovalGeneration);
      expect(catalog.get("dynamic_tool")).toBeUndefined();
      expect(staleActivation.snapshot.entries).toEqual([]);
      expect(staleActivation.tools).toEqual([]);
      expect(calls).toBe(0);
    });
  });

  // -- query --

  describe("query", () => {
    beforeEach(() => {
      catalog.register(makeReg({ name: "mem_a", category: "knowledge", tags: ["search"] }));
      catalog.register(makeReg({ name: "mem_b", category: "knowledge", tags: ["write"] }));
      catalog.register(makeReg({ name: "file_a", category: "files" }));
      catalog.register(makeReg({ name: "shell_a", category: "development", trustTier: "admin" }));
    });

    test("by category", () => {
      const r = catalog.query({ category: "knowledge" });
      expect(r.map((e) => e.name)).toEqual(["mem_a", "mem_b"]);
    });

    test("by discovery category", () => {
      catalog.register(makeReg({
        name: "document_search",
        category: "integrations",
        discoveryCategories: ["documents", "knowledge"],
      }));
      expect(catalog.query({ category: "documents" }).map((entry) => entry.name))
        .toEqual(["document_search"]);
      expect(catalog.query({ category: "knowledge" }).map((entry) => entry.name))
        .toEqual(["document_search", "mem_a", "mem_b"]);
    });

    test("by tag", () => {
      expect(catalog.query({ tag: "search" }).map((e) => e.name)).toEqual(["mem_a"]);
    });

    test("by keyword", () => {
      expect(catalog.query({ keyword: "shell" }).map((e) => e.name)).toEqual(["shell_a"]);
    });

    test("combined", () => {
      expect(catalog.query({ category: "knowledge", tag: "write" }).map((e) => e.name)).toEqual(["mem_b"]);
    });
  });

  // -- getFiltered --

  describe("getFiltered", () => {
    beforeEach(() => {
      catalog.register(makeReg({ name: "g", trustTier: "guest" }));
      catalog.register(makeReg({ name: "s", trustTier: "standard" }));
      catalog.register(makeReg({ name: "h", trustTier: "high" }));
      catalog.register(makeReg({ name: "a", trustTier: "admin" }));
    });

    test("admin trustTier tool included without toolPolicy (M133 — tier is metadata only)", () => {
      expect(catalog.getFiltered(undefined).entries.map((e) => e.name)).toContain("a");
    });

    test("forbidden toolPolicy excludes regardless of trustTier", () => {
      const snap = catalog.getFiltered({ a: "forbidden" });
      expect(snap.entries.find((e) => e.name === "a")).toBeUndefined();
      expect(snap.exclusions.some((e) => e.tool === "a" && e.reason.includes("forbidden"))).toBe(true);
    });

    test("forbidden policy excludes", () => {
      const snap = catalog.getFiltered({ g: "forbidden" });
      expect(snap.entries.find((e) => e.name === "g")).toBeUndefined();
    });

    test("relay tools excluded without relay", () => {
      catalog.register(makeReg({ name: "r", executor: "relay", requiredCapabilities: ["cap"] }));
      expect(catalog.getFiltered().entries.find((e) => e.name === "r")).toBeUndefined();
    });

    test("relay tools included with capability", () => {
      catalog.register(makeReg({ name: "r", executor: "relay", requiredCapabilities: ["cap"] }));
      expect(catalog.getFiltered(undefined, { cap: true }).entries.find((e) => e.name === "r")).toBeDefined();
    });

    test("relay capability can differ from actor capability", () => {
      catalog.register(makeReg({
        name: "r",
        executor: "relay",
        requiredCapabilities: ["control_desktop"],
        relayCapabilities: ["canRunShell"],
      }));

      const included = catalog.getFiltered(
        { r: "allow" },
        { canRunShell: true },
      );
      expect(included.entries.find((e) => e.name === "r")).toMatchObject({
        requiredCapabilities: ["control_desktop"],
        relayCapabilities: ["canRunShell"],
      });

      const excluded = catalog.getFiltered({ r: "allow" }, { control_desktop: true });
      expect(excluded.entries.find((e) => e.name === "r")).toBeUndefined();
      expect(excluded.exclusions).toContainEqual({
        tool: "r",
        reason: 'requires relay capability "canRunShell" not available',
      });
    });

    test("an explicit relay capability gates a cloud entrypoint without changing its executor", () => {
      catalog.register(makeReg({
        name: "cloud_entrypoint",
        executor: "cloud",
        relayCapabilities: ["canUseComputer"],
      }));

      expect(catalog.getFiltered().entries.map((entry) => entry.name))
        .not.toContain("cloud_entrypoint");
      expect(catalog.getFiltered(undefined, { canUseComputer: true }).entries.map((entry) => entry.name))
        .toContain("cloud_entrypoint");
      expect(catalog.get("cloud_entrypoint")?.executor).toBe("cloud");
    });

    test("connected-app eligibility requires the exact server-stamped provider snapshot", () => {
      catalog.register(makeReg({
        name: "notion_search",
        exposure: "discoverable",
        connectedAppProviderId: "notion",
      }));

      const disconnected = catalog.resolveProgressiveTools({
        context: { connectedAppProviderIds: [] },
        activatedToolNames: ["notion_search"],
      });
      expect(disconnected.eligible.entries.map((entry) => entry.name)).not.toContain("notion_search");
      expect(disconnected.snapshot.exclusions).toContainEqual({
        tool: "notion_search",
        reason: 'connected app provider "notion" is not connected in this Human×Namespace',
      });

      const connected = catalog.resolveProgressiveTools({
        context: { connectedAppProviderIds: ["notion"] },
        activatedToolNames: ["notion_search"],
      });
      expect(connected.snapshot.entries.map((entry) => entry.name)).toContain("notion_search");
      expect(connected.tools.map((tool) => tool.name)).toContain("notion_search");
    });

    test("preserves declarative connected-app async lifecycle metadata without polling", () => {
      catalog.register(makeReg({
        name: "canva_create_export",
        connectedAppProviderId: "canva",
        asyncLifecycle: {
          startActionId: "canva.create_design_export_job",
          statusActionId: "canva.get_design_export_job",
          statusInput: { exportId: "/job/id" },
        },
      }));
      expect(catalog.get("canva_create_export")?.asyncLifecycle).toEqual({
        startActionId: "canva.create_design_export_job",
        statusActionId: "canva.get_design_export_job",
        statusInput: { exportId: "/job/id" },
      });
    });

    test("snapshot is frozen", () => {
      const snap = catalog.getFiltered();
      expect(Object.isFrozen(snap)).toBe(true);
      expect(Object.isFrozen(snap.entries)).toBe(true);
    });
  });

  // -- D384 C6: namespace-scoped visibility --

  describe("getFiltered namespace scope (C6)", () => {
    beforeEach(() => {
      // global built-in (no namespace) + two namespace-scoped MCP tools
      catalog.register(makeReg({ name: "global_tool" }));
      catalog.register(makeReg({ name: "ns_a_tool", source: "mcp", sourceServer: "a", namespaceId: "ns-a" }));
      catalog.register(makeReg({ name: "ns_b_tool", source: "mcp", sourceServer: "b", namespaceId: "ns-b" }));
    });

    test("no readableNamespaces => no namespace filtering (backward compatible)", () => {
      const names = catalog.getFiltered(undefined, undefined, undefined).entries.map((e) => e.name);
      expect(names).toContain("global_tool");
      expect(names).toContain("ns_a_tool");
      expect(names).toContain("ns_b_tool");
    });

    test("readableNamespaces hides tools in non-readable namespaces", () => {
      const names = catalog
        .getFiltered(undefined, undefined, { readableNamespaces: ["ns-a"] })
        .entries.map((e) => e.name);
      expect(names).toContain("ns_a_tool");
      expect(names).not.toContain("ns_b_tool");
    });

    test("global (namespaceId null) tools are always visible even with a namespace filter", () => {
      const names = catalog
        .getFiltered(undefined, undefined, { readableNamespaces: ["ns-a"] })
        .entries.map((e) => e.name);
      expect(names).toContain("global_tool");
    });

    test("empty readableNamespaces hides ALL namespace-scoped tools, keeps globals", () => {
      const snap = catalog.getFiltered(undefined, undefined, { readableNamespaces: [] });
      const names = snap.entries.map((e) => e.name);
      expect(names).toContain("global_tool");
      expect(names).not.toContain("ns_a_tool");
      expect(names).not.toContain("ns_b_tool");
    });

    test("multiple readable namespaces union", () => {
      const names = catalog
        .getFiltered(undefined, undefined, { readableNamespaces: ["ns-a", "ns-b"] })
        .entries.map((e) => e.name);
      expect(names).toContain("global_tool");
      expect(names).toContain("ns_a_tool");
      expect(names).toContain("ns_b_tool");
    });

    test("getToolsForActor honors the namespace filter", () => {
      const tools = catalog.getToolsForActor({}, undefined, undefined, undefined, {
        readableNamespaces: ["ns-b"],
      });
      const names = tools.map((t) => t.name);
      expect(names).toContain("global_tool");
      expect(names).toContain("ns_b_tool");
      expect(names).not.toContain("ns_a_tool");
    });

    test("registered entry carries namespaceId; global defaults to null", () => {
      expect(catalog.get("ns_a_tool")?.namespaceId).toBe("ns-a");
      expect(catalog.get("global_tool")?.namespaceId).toBeNull();
    });
  });

  // -- D384 Phase 5 Slice A: hostedBy field threading (no filtering/routing yet) --

  describe("register hostedBy (D384 Phase 5 Slice A)", () => {
    test("registering with hostedBy threads it onto the entry", () => {
      catalog.register(makeReg({ name: "relay_tool", source: "relay", hostedBy: "relay-x" }));
      expect(catalog.get("relay_tool")?.hostedBy).toBe("relay-x");
    });

    test("omitted hostedBy defaults to null", () => {
      catalog.register(makeReg({ name: "builtin_tool" }));
      expect(catalog.get("builtin_tool")?.hostedBy).toBeNull();
    });

    test("getFiltered snapshot entry carries hostedBy", () => {
      catalog.register(makeReg({ name: "relay_tool", source: "relay", hostedBy: "relay-x" }));
      catalog.register(makeReg({ name: "builtin_tool" }));
      const snap = catalog.getFiltered();
      const relayEntry = snap.entries.find((e) => e.name === "relay_tool");
      const builtinEntry = snap.entries.find((e) => e.name === "builtin_tool");
      expect(relayEntry?.hostedBy).toBe("relay-x");
      expect(builtinEntry?.hostedBy).toBeNull();
    });
  });

  // -- D419: opt-in progressive exposure --

  describe("resolveProgressiveTools", () => {
    test("Full encryption exposes only explicitly reviewed tools", () => {
      catalog.register(makeReg({
        name: "protected",
        exposure: "core",
        fullEncryptionSupport: "supported",
      }));
      catalog.register(makeReg({ name: "ordinary", exposure: "core" }));

      const full = catalog.resolveProgressiveTools({ fullEncryptionOnly: true });
      expect(full.snapshot.entries.map((entry) => entry.name)).toEqual(["protected"]);
      expect(full.tools.map((tool) => tool.name)).toEqual(["protected"]);
      expect(full.snapshot.exclusions).toContainEqual({
        tool: "ordinary",
        reason: "unsupported while Full encryption is active",
      });
      expect(catalog.resolveProgressiveTools().tools.map((tool) => tool.name)).toEqual([
        "protected",
        "ordinary",
      ]);
    });

    test("exposes core, activated, and intent-pack tools with metadata, tools, and counts", () => {
      catalog.register(makeReg({ name: "core", exposure: "core" }));
      catalog.register(makeReg({ name: "activated", exposure: "discoverable" }));
      catalog.register(makeReg({ name: "intent", exposure: "discoverable" }));
      catalog.register(makeReg({ name: "unselected", exposure: "discoverable" }));

      const result = catalog.resolveProgressiveTools({
        context: { actorId: "actor-1" },
        activatedToolNames: ["activated"],
        intentPackToolNames: ["intent"],
      });

      expect(result.eligible.entries.map((entry) => entry.name)).toEqual([
        "core",
        "activated",
        "intent",
        "unselected",
      ]);
      expect(result.snapshot.entries.map((entry) => entry.name)).toEqual([
        "core",
        "activated",
        "intent",
      ]);
      expect(result.tools.map((tool) => tool.name)).toEqual(["core", "activated", "intent"]);
      expect(result.counts).toEqual({ eligible: 4, exposed: 3, instantiated: 3 });
    });

    test("never exposes an activated tool forbidden by actor policy", () => {
      catalog.register(makeReg({ name: "forbidden", exposure: "discoverable" }));

      const result = catalog.resolveProgressiveTools({
        toolPolicy: { forbidden: "forbidden" },
        activatedToolNames: ["forbidden"],
      });

      expect(result.snapshot.entries.map((entry) => entry.name)).not.toContain("forbidden");
      expect(result.tools.map((tool) => tool.name)).not.toContain("forbidden");
      expect(result.eligible.exclusions.some(
        (exclusion) => exclusion.tool === "forbidden" && exclusion.reason.includes("forbidden"),
      )).toBe(true);
    });

    test("never exposes an activated relay tool without its capability", () => {
      catalog.register(makeReg({
        name: "relay_only",
        exposure: "discoverable",
        executor: "relay",
        requiredCapabilities: ["filesystem"],
      }));

      const result = catalog.resolveProgressiveTools({
        relayCapabilities: { filesystem: false },
        activatedToolNames: ["relay_only"],
      });

      expect(result.snapshot.entries.map((entry) => entry.name)).not.toContain("relay_only");
      expect(result.eligible.exclusions.some(
        (exclusion) => exclusion.tool === "relay_only" && exclusion.reason.includes("relay capability"),
      )).toBe(true);
    });

    test("never exposes an activated tool outside the actor's readable namespaces", () => {
      catalog.register(makeReg({
        name: "private_namespace",
        exposure: "discoverable",
        namespaceId: "private",
      }));

      const result = catalog.resolveProgressiveTools({
        readableNamespaces: ["public"],
        activatedToolNames: ["private_namespace"],
      });

      expect(result.snapshot.entries.map((entry) => entry.name)).not.toContain("private_namespace");
      expect(result.eligible.exclusions.some(
        (exclusion) => exclusion.tool === "private_namespace" && exclusion.reason.includes("not readable"),
      )).toBe(true);
    });

    test("uses an explicit whitelist as a hard ceiling over core and activation", () => {
      catalog.register(makeReg({ name: "core", exposure: "core" }));
      catalog.register(makeReg({ name: "activated", exposure: "discoverable" }));

      const result = catalog.resolveProgressiveTools({
        toolNameWhitelist: ["activated"],
        activatedToolNames: ["activated"],
      });

      expect(result.snapshot.entries.map((entry) => entry.name)).toEqual(["activated"]);
      expect(result.snapshot.exclusions.some(
        (exclusion) => exclusion.tool === "core" && exclusion.reason.includes("explicit tool whitelist"),
      )).toBe(true);
    });

    test("never exposes an activated tool incompatible with the active model", () => {
      catalog.register(makeReg({
        name: "vision_only",
        exposure: "discoverable",
        requiredModelCapabilities: ["image"],
      }));

      const result = catalog.resolveProgressiveTools({
        activeModelCapabilities: ["file"],
        activatedToolNames: ["vision_only"],
      });

      expect(result.snapshot.entries.map((entry) => entry.name)).not.toContain("vision_only");
      expect(result.snapshot.exclusions.some(
        (exclusion) => exclusion.tool === "vision_only" && exclusion.reason.includes("model capability"),
      )).toBe(true);
    });

    test("core tools still require normal actor authorization", () => {
      catalog.register(makeReg({ name: "core", exposure: "core" }));

      const result = catalog.resolveProgressiveTools({
        toolPolicy: { core: "forbidden" },
      });

      expect(result.snapshot.entries.map((entry) => entry.name)).not.toContain("core");
      expect(result.tools.map((tool) => tool.name)).not.toContain("core");
    });

    test("D419 authorization matrix only narrows core and deferred exposure", () => {
      catalog.register(makeReg({ name: "public_core", exposure: "core" }));
      catalog.register(makeReg({ name: "memory_core", exposure: "core" }));
      catalog.register(makeReg({
        name: "relay_deferred",
        exposure: "discoverable",
        executor: "relay",
        requiredCapabilities: ["canRunShell"],
      }));
      catalog.register(makeReg({
        name: "vision_mcp",
        exposure: "discoverable",
        source: "mcp",
        sourceServer: "fixture-server",
        namespaceId: "visible",
        requiredModelCapabilities: ["image"],
      }));

      const namesFor = (options: Parameters<ToolCatalog["resolveProgressiveTools"]>[0]) =>
        catalog.resolveProgressiveTools(options).snapshot.entries.map((entry) => entry.name);

      // Owner with memory capability, but no relay and no image model: the
      // core remains eager; deferred tools are unavailable until authorized.
      expect(namesFor({
        toolPolicy: {},
        readableNamespaces: ["visible"],
        activeModelCapabilities: [],
      })).toEqual(["public_core", "memory_core"]);

      // A missing memory capability is represented by the policy resolver as
      // forbidden and must remove even a core tool rather than be bypassed by
      // progressive selection.
      expect(namesFor({
        toolPolicy: { memory_core: "forbidden" },
        readableNamespaces: ["visible"],
        activeModelCapabilities: ["image"],
        activatedToolNames: ["memory_core", "vision_mcp"],
      })).toEqual(["public_core", "vision_mcp"]);

      // Guest policy is a stricter ceiling, not a different activation path.
      expect(namesFor({
        toolPolicy: {
          memory_core: "forbidden",
          relay_deferred: "forbidden",
          vision_mcp: "forbidden",
        },
        readableNamespaces: ["visible"],
        activeModelCapabilities: ["image"],
        relayCapabilities: { canRunShell: true },
        activatedToolNames: ["relay_deferred", "vision_mcp"],
      })).toEqual(["public_core"]);

      // Relay, namespace, model, and activation must ALL be present before a
      // deferred schema can surface. Activation alone grants none of them.
      expect(namesFor({
        toolPolicy: {},
        readableNamespaces: ["hidden"],
        activeModelCapabilities: ["image"],
        relayCapabilities: { canRunShell: true },
        activatedToolNames: ["relay_deferred", "vision_mcp"],
      })).toEqual(["public_core", "memory_core", "relay_deferred"]);
      expect(namesFor({
        toolPolicy: {},
        readableNamespaces: ["visible"],
        activeModelCapabilities: ["image"],
        relayCapabilities: { canRunShell: true },
        activatedToolNames: ["relay_deferred", "vision_mcp"],
      })).toEqual(["public_core", "memory_core", "relay_deferred", "vision_mcp"]);
    });
  });

  // -- getToolsForActor --

  describe("getToolsForActor", () => {
    test("returns StructuredTool instances", () => {
      catalog.register(makeReg({ name: "t" }));
      const tools = catalog.getToolsForActor({});
      expect(tools.length).toBe(1);
      expect(tools[0]!.name).toBe("t");
    });

    test("trust tier does not gate instantiation (M133)", () => {
      catalog.register(makeReg({ name: "g", trustTier: "guest" }));
      catalog.register(makeReg({ name: "a", trustTier: "admin" }));
      expect(catalog.getToolsForActor({}).length).toBe(2);
    });
  });

  // -- getToolPolicy --

  describe("getToolPolicy", () => {
    test("returns impact and capability", () => {
      catalog.register(makeReg({ name: "t", impact: "destructive", requiredCapabilities: ["cap_a"] }));
      const p = catalog.getToolPolicy("t");
      expect(p.impact).toBe("destructive");
      expect(p.requiredCapability).toBe("cap_a");
    });

    test("unknown tool defaults to destructive", () => {
      const p = catalog.getToolPolicy("unknown");
      expect(p.impact).toBe("destructive");
      expect(p.requiredCapability).toBe("__unregistered_tool_forbidden__");
    });

    test("M079 — preserves approvalMode hybrid and exposes via get()", () => {
      catalog.register(makeReg({ name: "hybrid_only", approvalMode: "hybrid", impact: "destructive" }));
      expect(catalog.get("hybrid_only")?.approvalMode).toBe("hybrid");
      expect(catalog.getToolPolicy("hybrid_only").approvalMode).toBe("hybrid");
    });

    test("M079 — omitted approvalMode is undefined (static behavior)", () => {
      catalog.register(makeReg({ name: "static_tool" }));
      expect(catalog.get("static_tool")?.approvalMode).toBeUndefined();
      expect(catalog.getToolPolicy("static_tool").approvalMode).toBeUndefined();
    });
  });

  // -- refresh --

  describe("refresh", () => {
    test("adds, removes, updates", () => {
      catalog.register(makeReg({ name: "keep", source: "mcp", sourceServer: "s" }));
      catalog.register(makeReg({ name: "gone", source: "mcp", sourceServer: "s" }));

      catalog.refresh("s", [
        makeReg({ name: "keep", source: "mcp", sourceServer: "s" }),
        makeReg({ name: "new", source: "mcp", sourceServer: "s" }),
      ]);

      expect(catalog.has("keep")).toBe(true);
      expect(catalog.has("new")).toBe(true);
      expect(catalog.has("gone")).toBe(false);
    });

    test("D526 characterization — same-name refresh preserves the existing Map slot", () => {
      catalog.register(makeReg({ name: "before" }));
      catalog.register(makeReg({ name: "dynamic", source: "mcp", sourceServer: "server" }));
      catalog.register(makeReg({ name: "after" }));
      const beforeRefresh = catalog.currentGeneration;

      catalog.refresh("server", [
        makeReg({ name: "dynamic", source: "mcp", sourceServer: "server" }),
      ]);

      expect(catalog.getFiltered().entries.map((entry) => entry.name)).toEqual([
        "before",
        "dynamic",
        "after",
      ]);
      expect(catalog.currentGeneration).toBe(beforeRefresh + 1);
    });

    test("D526 characterization — deleting then reinserting moves a tool to the Map tail", () => {
      catalog.register(makeReg({ name: "before" }));
      catalog.register(makeReg({ name: "dynamic", source: "mcp", sourceServer: "server" }));
      catalog.register(makeReg({ name: "after" }));
      const beforeRemoval = catalog.currentGeneration;

      catalog.refresh("server", []);
      expect(catalog.currentGeneration).toBe(beforeRemoval + 1);

      catalog.refresh("server", [
        makeReg({ name: "dynamic", source: "mcp", sourceServer: "server" }),
      ]);

      expect(catalog.getFiltered().entries.map((entry) => entry.name)).toEqual([
        "before",
        "after",
        "dynamic",
      ]);
      expect(catalog.currentGeneration).toBe(beforeRemoval + 2);
    });

    test("D526 characterization — hazardous failed refresh partially removes and replaces a contribution", () => {
      catalog.register(makeReg({ name: "old", source: "mcp", sourceServer: "server" }));
      const beforeRefresh = catalog.currentGeneration;

      expect(() => catalog.refresh("server", [
        makeReg({ name: "replacement", source: "mcp", sourceServer: "server" }),
        {
          name: "invalid_later",
          factory: () => makeTool("invalid_later", ""),
          category: "meta",
          trustTier: "standard",
          impact: "read-only",
          source: "mcp",
          sourceServer: "server",
        },
      ])).toThrow("no description");

      // Current refresh is intentionally characterized, not endorsed: it
      // deletes first and registers serially, so no rollback restores "old".
      expect(catalog.has("old")).toBe(false);
      expect(catalog.has("replacement")).toBe(true);
      expect(catalog.has("invalid_later")).toBe(false);
      expect(catalog.currentGeneration).toBe(beforeRefresh + 2);
    });

    test("D526 characterization — hazardous external collisions overwrite across external sources", () => {
      catalog.register(makeReg({
        name: "shared",
        source: "mcp",
        sourceServer: "mcp-server",
      }));
      const beforeOverwrite = catalog.currentGeneration;

      expect(catalog.register(makeReg({
        name: "shared",
        source: "relay",
        sourceServer: "relay-server",
      }))).toBe(true);

      expect(catalog.get("shared")).toMatchObject({
        source: "relay",
        sourceServer: "relay-server",
      });
      expect(catalog.currentGeneration).toBe(beforeOverwrite + 1);
    });

    test("D526 characterization — hazardous stale string-source cleanup can remove a newer replacement", () => {
      catalog.refresh("server", [
        makeReg({ name: "dynamic", source: "mcp", sourceServer: "server" }),
      ]);
      catalog.refresh("server", [
        makeReg({ name: "dynamic", source: "mcp", sourceServer: "server" }),
      ]);
      const beforeStaleCleanup = catalog.currentGeneration;

      // The public API has only the server-name string: a stale lifecycle
      // caller is indistinguishable from the newer replacement's owner.
      catalog.refresh("server", []);

      expect(catalog.has("dynamic")).toBe(false);
      expect(catalog.currentGeneration).toBe(beforeStaleCleanup + 1);
    });
  });

  describe("replaceServerContribution", () => {
    test("publishes a valid replacement as one visible generation", () => {
      catalog.register(makeReg({ name: "old", sourceServer: "signed-catalogue" }));
      const beforeReplacement = catalog.currentGeneration;

      catalog.replaceServerContribution("signed-catalogue", [
        makeReg({ name: "new_a", sourceServer: "signed-catalogue" }),
        makeReg({ name: "new_b", sourceServer: "signed-catalogue" }),
      ]);

      expect(catalog.has("old")).toBe(false);
      expect(catalog.has("new_a")).toBe(true);
      expect(catalog.has("new_b")).toBe(true);
      expect(catalog.currentGeneration).toBe(beforeReplacement + 1);
    });

    test("a bad later factory leaves the live contribution untouched", () => {
      catalog.register(makeReg({ name: "old", sourceServer: "signed-catalogue" }));
      const beforeReplacement = catalog.currentGeneration;

      expect(() => catalog.replaceServerContribution("signed-catalogue", [
        makeReg({ name: "new", sourceServer: "signed-catalogue" }),
        {
          name: "invalid_later",
          factory: () => makeTool("invalid_later", ""),
          category: "meta",
          trustTier: "standard",
          impact: "read-only",
          sourceServer: "signed-catalogue",
        },
      ])).toThrow("no description");

      expect(catalog.has("old")).toBe(true);
      expect(catalog.has("new")).toBe(false);
      expect(catalog.currentGeneration).toBe(beforeReplacement);
    });

    test("mismatched ownership, duplicates, and foreign collisions fail closed", () => {
      catalog.register(makeReg({ name: "foreign" }));
      const beforeReplacement = catalog.currentGeneration;

      expect(() => catalog.replaceServerContribution("signed-catalogue", [
        makeReg({ name: "wrong-owner", sourceServer: "elsewhere" }),
      ])).toThrow("mismatched sourceServer");
      expect(() => catalog.replaceServerContribution("signed-catalogue", [
        makeReg({ name: "duplicate", sourceServer: "signed-catalogue" }),
        makeReg({ name: "duplicate", sourceServer: "signed-catalogue" }),
      ])).toThrow("duplicate tool");
      expect(() => catalog.replaceServerContribution("signed-catalogue", [
        makeReg({ name: "foreign", sourceServer: "signed-catalogue" }),
      ])).toThrow("owned by another contribution");

      expect(catalog.has("foreign")).toBe(true);
      expect(catalog.currentGeneration).toBe(beforeReplacement);
    });
  });

  // -- get immutability --

  describe("get", () => {
    test("returns frozen copy", () => {
      catalog.register(makeReg({ name: "t" }));
      const entry = catalog.get("t");
      expect(Object.isFrozen(entry)).toBe(true);
    });
  });

  // -- stats + validate --

  describe("stats", () => {
    test("accurate counts", () => {
      catalog.register(makeReg({ name: "a", category: "knowledge", trustTier: "standard" }));
      catalog.register(makeReg({ name: "b", category: "research", trustTier: "admin", source: "mcp" }));
      const stats = catalog.getStats();
      expect(stats.total).toBe(2);
      expect(stats.bySource.builtin).toBe(1);
      expect(stats.bySource.mcp).toBe(1);
      expect(stats.byTier.standard).toBe(1);
      expect(stats.byTier.admin).toBe(1);
    });
  });

  describe("validate", () => {
    test("passes for valid entries", () => {
      catalog.register(makeReg({ name: "ok" }));
      expect(() => catalog.validate()).not.toThrow();
    });

    test("D419 — strict exposure mode rejects unmigrated builtin registrations", () => {
      catalog.register(makeReg({ name: "unmigrated" }));
      catalog.register(makeReg({ name: "migrated", exposure: "core" }));

      expect(() => catalog.validate({ requireExposure: true })).toThrow(
        "unmigrated: missing exposure",
      );
    });

    test("D419 — default validation does not force external registrations during migration", () => {
      catalog.register(makeReg({ name: "external_unmigrated", source: "mcp" }));

      expect(() => catalog.validate()).not.toThrow();
    });

    test("rejects malformed Connection metadata", () => {
      catalog.register(makeReg({
        name: "bad_connection",
        connections: [{
          service: "",
          field: "api_key",
          category: "user",
          required: true,
          authShape: "api_key",
          displayLabel: "Broken",
        }],
      }));

      expect(() => catalog.validate()).toThrow("Connection service is empty");
    });
  });
});
