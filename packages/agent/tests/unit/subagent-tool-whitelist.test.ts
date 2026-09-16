import { describe, expect, test, beforeAll } from "bun:test";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { ToolCatalog, initToolCatalog } from "@nautilo/catalog";
import { registerAllTools } from "../../src/tools/register-all";
import {
  validateSubagentToolWhitelist,
  clampSubagentBranchMax,
} from "../../src/tools/subagents/validate-subagent-whitelist";
import { MAX_SUBAGENT_DEPTH } from "../../src/agent/state";
import { scopeSubagentToolComposition } from "../../src/subagents/scope-subagent/run";
import type { NamespaceMemoryEnvelope } from "@nautilo/trust";

const env: NamespaceMemoryEnvelope = {
  ownerId: "o",
  actorId: "a",
  agentId: "g",
  roomId: "r",
  readableNamespaces: ["n1"],
  mutableNamespaces: ["n1"],
  writableNamespaces: ["n1"],
  toolPolicy: {},
};

describe("M084 — subagent tool whitelist validation", () => {
  beforeAll(() => {
    const c = new ToolCatalog();
    registerAllTools(c);
    initToolCatalog(c);
  });

  test("rejects unknown tool names", () => {
    const r = validateSubagentToolWhitelist({
      requestedTools: ["not_a_real_tool"],
      parentEnvelope: env,
      actorRole: "owner",
      toolPolicy: env.toolPolicy,
      subagentDepth: 1,
      subagentMaxDepth: 3,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("Unknown tool");
  });

  test("rejects tools the parent tier cannot access", () => {
    const r = validateSubagentToolWhitelist({
      requestedTools: ["run_shell"],
      parentEnvelope: env,
      actorRole: "guest",
      toolPolicy: env.toolPolicy,
      subagentDepth: 1,
      subagentMaxDepth: 3,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("unavailable in this context");
  });

  test("M150: relay tool rejected by default (live relay-presence check on)", () => {
    const r = validateSubagentToolWhitelist({
      requestedTools: ["run_shell"],
      parentEnvelope: env,
      actorRole: "owner",
      toolPolicy: env.toolPolicy,
      subagentDepth: 1,
      subagentMaxDepth: 3,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("unavailable in this context");
  });

  test("M150: relay tool ACCEPTED with skipRelayLiveCheck (authorization-only)", () => {
    const r = validateSubagentToolWhitelist({
      requestedTools: ["run_shell"],
      parentEnvelope: env,
      actorRole: "owner",
      toolPolicy: env.toolPolicy,
      skipRelayLiveCheck: true,
      subagentDepth: 1,
      subagentMaxDepth: 3,
    });
    expect(r).toEqual({ ok: true, whitelist: ["run_shell"] });
  });

  test("M150: skipRelayLiveCheck still rejects a forbidden tool (RBAC enforced)", () => {
    const r = validateSubagentToolWhitelist({
      requestedTools: ["run_shell"],
      parentEnvelope: env,
      actorRole: "owner",
      toolPolicy: { run_shell: "forbidden" },
      skipRelayLiveCheck: true,
      subagentDepth: 1,
      subagentMaxDepth: 3,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("unavailable in this context");
  });

  test("allows empty whitelist (chat-only subagent)", () => {
    const r = validateSubagentToolWhitelist({
      requestedTools: [],
      parentEnvelope: env,
      actorRole: "owner",
      toolPolicy: env.toolPolicy,
      subagentDepth: 1,
      subagentMaxDepth: 3,
    });
    expect(r).toEqual({ ok: true, whitelist: [] });
  });

  test("preserves an explicit whitelist without promoting other authorized tools", () => {
    const r = validateSubagentToolWhitelist({
      requestedTools: ["search_memory"],
      parentEnvelope: env,
      actorRole: "owner",
      toolPolicy: env.toolPolicy,
      subagentDepth: 1,
      subagentMaxDepth: 3,
    });
    expect(r).toEqual({ ok: true, whitelist: ["search_memory"] });
  });

  test("an explicit discoverable whitelist is the initial set and exact ceiling", () => {
    const composition = scopeSubagentToolComposition(["share_memory"]);
    expect(composition).toEqual({
      toolWhitelist: ["share_memory"],
      activatedToolNames: ["share_memory"],
    });

    const catalog = new ToolCatalog();
    registerAllTools(catalog);
    const resolved = catalog.resolveProgressiveTools({
      toolPolicy: { share_memory: "require_prove_it" },
      toolNameWhitelist: composition.toolWhitelist,
      activatedToolNames: composition.activatedToolNames,
    });
    expect(resolved.snapshot.entries.map((entry) => entry.name)).toEqual([
      "share_memory",
    ]);
    expect(resolved.tools.map((tool) => tool.name)).toEqual(["share_memory"]);
  });

  test("omitted and empty tool modes remain distinct", () => {
    expect(scopeSubagentToolComposition(undefined)).toEqual({});
    expect(scopeSubagentToolComposition([])).toEqual({
      toolWhitelist: [],
      activatedToolNames: [],
    });
  });

  test("an auto live-task activation seed exposes its first-step schemas without a ceiling", () => {
    const liveToolNames = [
      "app_nautilo_writer__edit_open_writer",
      "app_nautilo_writer__read_open_writer_range",
      "app_nautilo_writer__locate_open_writer_text",
    ];
    const composition = scopeSubagentToolComposition(undefined, liveToolNames);
    expect(composition).toEqual({
      activatedToolNames: liveToolNames,
    });
    expect(composition).not.toHaveProperty("toolWhitelist");

    const catalog = new ToolCatalog();
    for (const name of liveToolNames) {
      catalog.register({
        name,
        factory: () => new DynamicStructuredTool({
          name,
          description: `Live Writer ${name}`,
          schema: z.object({}),
          func: async () => "ok",
        }),
        category: "documents",
        trustTier: "guest",
        impact: "read-only",
        exposure: "discoverable",
      });
    }
    const resolved = catalog.resolveProgressiveTools({
      toolPolicy: {},
      activatedToolNames: composition.activatedToolNames,
    });
    expect(resolved.tools.map((tool) => tool.name)).toEqual(liveToolNames);
  });

  test("clampSubagentBranchMax respects server ceiling", () => {
    expect(clampSubagentBranchMax(undefined)).toBe(3);
    expect(clampSubagentBranchMax(10)).toBe(MAX_SUBAGENT_DEPTH);
  });
});
