import { describe, test, expect } from "bun:test";
import type { ToolCall } from "@langchain/core/messages/tool";
import type { ResolvedApproval, CombinedSeverity } from "@nautilo/security";
import {
  buildAskPayload,
  classifyReasonCodeForEntry,
  classifyReasonCodeForBatch,
  extractStaticNetworkApproval,
} from "../../src/nodes/post-model";

/**
 * D061 PR #58 follow-up M-3 — assert the `approval_ask` interrupt
 * payload SHAPE directly, not indirectly via "did the node throw?".
 * Tests the pure helpers extracted from post-model's interrupt path.
 */

function mkEntry(
  name: string,
  severity: CombinedSeverity,
  reason: string,
  args: Record<string, unknown> = {},
  id?: string,
): { tc: ToolCall; approval: ResolvedApproval } {
  const tc: ToolCall = { name, args, ...(id ? { id } : {}) };
  const approval: ResolvedApproval = {
    severity,
    verb: "ask",
    reason,
  };
  return { tc, approval };
}

// ===========================================================================
// classifyReasonCodeForEntry — per-tool mapping
// ===========================================================================

describe("classifyReasonCodeForEntry", () => {
  test("destructive-high severity → command-scanner-high", () => {
    const entry = mkEntry("run_shell", "destructive-high", "high");
    expect(classifyReasonCodeForEntry(entry)).toBe("command-scanner-high");
  });

  test("destructive-medium severity → command-scanner-medium", () => {
    const entry = mkEntry("run_shell", "destructive-medium", "medium");
    expect(classifyReasonCodeForEntry(entry)).toBe("command-scanner-medium");
  });

  test("run_shell with external-binary path → external-binary", () => {
    const entry = mkEntry(
      "run_shell",
      "destructive-low",
      "external script",
      { command: "./install.sh" },
    );
    expect(classifyReasonCodeForEntry(entry)).toBe("external-binary");
  });

  test("run_shell with /usr/bin/git (trusted prefix) → NOT external-binary", () => {
    const entry = mkEntry(
      "run_shell",
      "destructive-low",
      "destructive tool",
      { command: "/usr/bin/git status" },
    );
    expect(classifyReasonCodeForEntry(entry)).toBe("destructive-tool");
  });

  test("destructive-low severity (no external) → destructive-tool", () => {
    const entry = mkEntry("run_shell", "destructive-low", "benign", { command: "ls" });
    expect(classifyReasonCodeForEntry(entry)).toBe("destructive-tool");
  });

  test("high-impact severity → destructive-tool", () => {
    const entry = mkEntry("update_config", "high-impact", "high-impact tool");
    expect(classifyReasonCodeForEntry(entry)).toBe("destructive-tool");
  });

  test("low severity → tier-bump (fallback)", () => {
    const entry = mkEntry("manage_memory", "low", "low-impact tool");
    expect(classifyReasonCodeForEntry(entry)).toBe("tier-bump");
  });
});

// ===========================================================================
// classifyReasonCodeForBatch — worst-severity-wins
// ===========================================================================

describe("classifyReasonCodeForBatch", () => {
  test("empty batch → tier-bump fallback", () => {
    expect(classifyReasonCodeForBatch([])).toBe("tier-bump");
  });

  test("single-entry batch behaves like classifyReasonCodeForEntry", () => {
    const entry = mkEntry("run_shell", "destructive-medium", "medium");
    expect(classifyReasonCodeForBatch([entry])).toBe("command-scanner-medium");
  });

  test("batch picks MAX severity — destructive-tool + external-binary → external-binary", () => {
    const batch = [
      mkEntry("update_config", "high-impact", "high-impact tool"),
      mkEntry(
        "run_shell",
        "destructive-low",
        "external script",
        { command: "./install.sh" },
      ),
    ];
    expect(classifyReasonCodeForBatch(batch)).toBe("external-binary");
  });

  test("batch picks MAX severity — medium + high → high", () => {
    const batch = [
      mkEntry("run_shell", "destructive-medium", "npm install"),
      mkEntry("run_shell", "destructive-high", "sudo"),
    ];
    expect(classifyReasonCodeForBatch(batch)).toBe("command-scanner-high");
  });

  test("batch order does not affect result", () => {
    const mild = mkEntry("manage_memory", "low", "low");
    const strong = mkEntry("run_shell", "destructive-high", "high");
    const ordered = classifyReasonCodeForBatch([mild, strong]);
    const reversed = classifyReasonCodeForBatch([strong, mild]);
    expect(ordered).toBe(reversed);
    expect(ordered).toBe("command-scanner-high");
  });
});

// ===========================================================================
// buildAskPayload — full interrupt-payload shape
// ===========================================================================

describe("buildAskPayload", () => {
  test("single-tool batch: reason emitted verbatim, no numeric prefix", () => {
    const payload = buildAskPayload([
      mkEntry(
        "run_shell",
        "destructive-medium",
        "Global npm install (medium severity) — needs approval",
        { command: "npm install -g typescript" },
        "tc-1",
      ),
    ]);

    expect(payload.type).toBe("approval_ask");
    expect(payload.tools).toHaveLength(1);
    expect(payload.tools[0]).toEqual({
      name: "run_shell",
      args: { command: "npm install -g typescript" },
      id: "tc-1",
    });
    expect(payload.reason).toBe("Global npm install (medium severity) — needs approval");
    expect(payload.reasonCode).toBe("command-scanner-medium");
    expect(payload.allowedVerbs).toEqual(["once", "room", "always", "deny"]);
  });

  test("mixed-reason batch: reasons numbered and joined with '; '", () => {
    const payload = buildAskPayload([
      mkEntry("run_shell", "destructive-low", "destructive tool", { command: "ls" }, "tc-a"),
      mkEntry(
        "run_shell",
        "destructive-low",
        "external script",
        { command: "./install.sh" },
        "tc-b",
      ),
    ]);

    expect(payload.reason).toBe("(1) destructive tool; (2) external script");
    // reasonCode picks the stronger of the two per worst-severity-wins.
    expect(payload.reasonCode).toBe("external-binary");
    expect(payload.tools).toHaveLength(2);
  });

  test("duplicate reasons de-duplicated (single unique reason → no numbering)", () => {
    const payload = buildAskPayload([
      mkEntry("run_shell", "destructive-low", "destructive tool", { command: "ls" }),
      mkEntry("run_shell", "destructive-low", "destructive tool", { command: "pwd" }),
    ]);
    expect(payload.reason).toBe("destructive tool");
    expect(payload.reason).not.toContain("(1)");
  });

  test("allowedVerbs is always the full four-verb set (today)", () => {
    const payload = buildAskPayload([
      mkEntry("update_config", "high-impact", "high-impact tool"),
    ]);
    expect(payload.allowedVerbs).toEqual(["once", "room", "always", "deny"]);
  });

  test("tool id is omitted when tc.id is undefined", () => {
    const payload = buildAskPayload([
      mkEntry("manage_memory", "low", "low", { action: "save" }),
    ]);
    expect(payload.tools[0]).toEqual({
      name: "manage_memory",
      args: { action: "save" },
    });
    expect(payload.tools[0]).not.toHaveProperty("id");
  });

  test("args default to empty object when tc.args is null-ish", () => {
    const payload = buildAskPayload([
      { tc: { name: "discover_tools", args: undefined } as unknown as ToolCall,
        approval: { severity: "low", verb: "ask", reason: "x" } },
    ]);
    expect(payload.tools[0]!.args).toEqual({});
  });

  test("single run_shell command with one literal URL bundles network context", () => {
    const payload = buildAskPayload([
      mkEntry(
        "run_shell",
        "destructive-low",
        "destructive tool",
        { command: "curl --silent https://example.com/path?token=secret" },
      ),
    ]);

    expect(payload.network).toEqual({
      host: "example.com",
      port: 443,
      reason: "static URL in approved shell command",
      suggestedRule: {
        type: "domain",
        host: "example.com",
        ports: [443],
      },
    });
    expect(JSON.stringify(payload.network)).not.toContain("path");
    expect(JSON.stringify(payload.network)).not.toContain("secret");
  });

  test("multiple literal destinations do not bundle network context", () => {
    const payload = buildAskPayload([
      mkEntry(
        "run_shell",
        "destructive-low",
        "destructive tool",
        { command: "curl https://example.com && curl https://wikipedia.org" },
      ),
    ]);

    expect(payload.network).toBeUndefined();
  });
});

describe("extractStaticNetworkApproval", () => {
  test("extracts a single http URL with default port 80", () => {
    expect(
      extractStaticNetworkApproval(
        { name: "run_shell", args: { command: "curl http://example.com/docs" } } as ToolCall,
      ),
    ).toEqual({
      host: "example.com",
      port: 80,
      reason: "static URL in approved shell command",
      suggestedRule: {
        type: "domain",
        host: "example.com",
        ports: [80],
      },
    });
  });

  test("returns null for variable URLs or non-shell tools", () => {
    expect(
      extractStaticNetworkApproval(
        { name: "run_shell", args: { command: "curl \"$URL\"" } } as ToolCall,
      ),
    ).toBeNull();
    expect(
      extractStaticNetworkApproval(
        { name: "read_webpage", args: { url: "https://example.com" } } as ToolCall,
      ),
    ).toBeNull();
  });
});
