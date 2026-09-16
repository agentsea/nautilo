import { describe, test, expect } from "bun:test";
import {
  resolveSeverity,
  resolveVerb,
  coerceHybridSensitivity,
  resolveHybridVerb,
  resolveApproval,
  type ApprovalVerb,
  type CombinedSeverity,
  type ToolImpact,
} from "../../src/severity-resolver";
import type { SecurityLevel } from "../../src/security-config";
import type { CommandScanResult } from "../../src/command-scanner";

const LEVELS: SecurityLevel[] = ["yolo", "permissive", "standard", "cautious", "paranoid"];

function mkScan(severity?: "critical" | "high" | "medium"): CommandScanResult {
  if (!severity) {
    return { allowed: true, matchedPatterns: [], normalizedCommand: "" };
  }
  return {
    allowed: false,
    severity,
    matchedPatterns: [{ key: "test", description: "test pattern", severity }],
    normalizedCommand: "",
  };
}

// ---------------------------------------------------------------------------
// resolveSeverity — fusion logic
// ---------------------------------------------------------------------------

describe("resolveSeverity", () => {
  test("scanner critical wins regardless of tool impact", () => {
    expect(resolveSeverity({ toolImpact: "destructive", commandScan: mkScan("critical") })).toBe("critical");
    expect(resolveSeverity({ toolImpact: "low", commandScan: mkScan("critical") })).toBe("critical");
    expect(resolveSeverity({ toolImpact: "read-only", commandScan: mkScan("critical") })).toBe("critical");
  });

  test("scanner high produces destructive-high", () => {
    expect(resolveSeverity({ toolImpact: "destructive", commandScan: mkScan("high") })).toBe("destructive-high");
  });

  test("scanner medium produces destructive-medium", () => {
    expect(resolveSeverity({ toolImpact: "destructive", commandScan: mkScan("medium") })).toBe("destructive-medium");
  });

  test("scanner-allowed (no hit) falls through to tool impact", () => {
    const scan = mkScan();
    expect(resolveSeverity({ toolImpact: "destructive", commandScan: scan })).toBe("destructive-low");
    expect(resolveSeverity({ toolImpact: "high", commandScan: scan })).toBe("high-impact");
    expect(resolveSeverity({ toolImpact: "low", commandScan: scan })).toBe("low");
    expect(resolveSeverity({ toolImpact: "read-only", commandScan: scan })).toBe("low");
  });

  test("no commandScan at all falls through to tool impact", () => {
    expect(resolveSeverity({ toolImpact: "destructive" })).toBe("destructive-low");
    expect(resolveSeverity({ toolImpact: "high" })).toBe("high-impact");
    expect(resolveSeverity({ toolImpact: "low" })).toBe("low");
    expect(resolveSeverity({ toolImpact: "read-only" })).toBe("low");
  });

  test("external-binary flag does NOT affect severity (only verb)", () => {
    // Kept pure on purpose — severity is an audit signal, verb is a UX signal.
    expect(resolveSeverity({ toolImpact: "low", isExternalUnknownBinary: true })).toBe("low");
    expect(resolveSeverity({ toolImpact: "destructive", isExternalUnknownBinary: true })).toBe("destructive-low");
  });

  test("unknown impact value fails closed to destructive-high", () => {
    // Protects against schema drift / untrusted MCP registrations passing
    // a value outside the ToolImpactLevel union via JSON. The TS-exhaustive
    // path is unreachable at compile time; this test exercises the
    // runtime-unsafe caller case.
    const result = resolveSeverity({
      // @ts-expect-error — deliberately passing an unknown impact string
      toolImpact: "totally-unknown-value",
    });
    expect(result).toBe("destructive-high");
  });
});

// ---------------------------------------------------------------------------
// resolveVerb — full matrix from the §unified tier map
// ---------------------------------------------------------------------------

describe("resolveVerb — full matrix", () => {
  const MATRIX: Record<CombinedSeverity, Record<SecurityLevel, ApprovalVerb>> = {
    critical:             { yolo: "block",  permissive: "block",  standard: "block",    cautious: "block",    paranoid: "block" },
    "destructive-high":   { yolo: "auto",   permissive: "ask",    standard: "prove_it", cautious: "prove_it", paranoid: "prove_it" },
    "destructive-medium": { yolo: "auto",   permissive: "ask",    standard: "ask",      cautious: "ask",      paranoid: "prove_it" },
    "destructive-low":    { yolo: "auto",   permissive: "auto",   standard: "ask",      cautious: "ask",      paranoid: "ask" },
    "high-impact":        { yolo: "auto",   permissive: "auto",   standard: "auto",     cautious: "ask",      paranoid: "ask" },
    low:                  { yolo: "auto",   permissive: "auto",   standard: "auto",     cautious: "auto",     paranoid: "auto" },
  };

  for (const severity of Object.keys(MATRIX) as CombinedSeverity[]) {
    for (const level of LEVELS) {
      const expected = MATRIX[severity][level];
      test(`${severity} @ ${level} → ${expected}`, () => {
        expect(resolveVerb(severity, level)).toBe(expected);
      });
    }
  }

  test("critical blocks at every level (never approvable)", () => {
    for (const level of LEVELS) {
      expect(resolveVerb("critical", level)).toBe("block");
    }
  });

  test("low is auto at every level (never prompts)", () => {
    for (const level of LEVELS) {
      expect(resolveVerb("low", level)).toBe("auto");
    }
  });
});

// ---------------------------------------------------------------------------
// resolveApproval — combined entry point with external-binary override
// ---------------------------------------------------------------------------

describe("resolveApproval — combined", () => {
  test("passes through verb when external-binary is false", () => {
    const r = resolveApproval({ toolImpact: "low" }, "standard");
    expect(r.verb).toBe("auto");
    expect(r.severity).toBe("low");
  });

  test("external-binary upgrades auto → ask", () => {
    const r = resolveApproval(
      { toolImpact: "low", isExternalUnknownBinary: true },
      "standard",
    );
    expect(r.verb).toBe("ask");
    expect(r.severity).toBe("low");
  });

  test("external-binary leaves ask as ask", () => {
    const r = resolveApproval(
      { toolImpact: "destructive", isExternalUnknownBinary: true },
      "standard",
    );
    expect(r.verb).toBe("ask");
  });

  test("external-binary does NOT downgrade prove_it", () => {
    // destructive-high @ standard = prove_it. Attribution doesn't matter
    // when PIN is already required.
    const r = resolveApproval(
      { toolImpact: "destructive", commandScan: mkScan("high"), isExternalUnknownBinary: true },
      "standard",
    );
    expect(r.verb).toBe("prove_it");
  });

  test("external-binary does NOT unblock critical", () => {
    const r = resolveApproval(
      { toolImpact: "destructive", commandScan: mkScan("critical"), isExternalUnknownBinary: true },
      "yolo",
    );
    expect(r.verb).toBe("block");
  });

  test("reason mentions scanner pattern when scan fired", () => {
    const scan = mkScan("high");
    const r = resolveApproval({ toolImpact: "destructive", commandScan: scan }, "standard");
    expect(r.reason).toContain("test pattern");
    expect(r.reason).toContain("requires PIN");
    expect(r.reason).not.toContain("severity:");
  });

  test("reason mentions external-binary when flag set", () => {
    const r = resolveApproval(
      { toolImpact: "low", isExternalUnknownBinary: true },
      "standard",
    );
    expect(r.reason).toContain("external script");
  });

  test("generic approval copy does not present internal impact as invocation truth", () => {
    const r = resolveApproval({ toolImpact: "destructive" }, "standard");
    expect(r.reason).toBe("This tool — needs approval");
    expect(r.reason).not.toContain("destructive");
    expect(r.reason).not.toContain("severity");
  });

  test("uses narrow static copy for shell and private-context approval", () => {
    const fileReason = resolveApproval(
      { toolImpact: "destructive", toolName: "file" },
      "standard",
    ).reason;
    expect(fileReason).toBe("This tool — needs approval");

    const shellReason = resolveApproval(
      { toolImpact: "destructive", toolName: "run_shell" },
      "standard",
    ).reason;
    expect(shellReason).toBe("Shell execution — needs approval");
    expect(shellReason).not.toContain("changes your system");

    const privateReason = resolveApproval(
      { toolImpact: "destructive", toolName: "in_private_namespace" },
      "standard",
    ).reason;
    expect(privateReason).toBe("Starting work in a private context — needs approval");
  });
});

// ---------------------------------------------------------------------------
// Canon smoke tests — representative named scenarios from the issue
// ---------------------------------------------------------------------------

describe("canonical scenarios from D061 issue", () => {
  const runShell = (sev?: "critical" | "high" | "medium", ext = false): { toolImpact: ToolImpact; commandScan: CommandScanResult; isExternalUnknownBinary?: boolean } => ({
    toolImpact: "destructive",
    commandScan: mkScan(sev),
    ...(ext ? { isExternalUnknownBinary: true } : {}),
  });

  test("sudo apt update @ standard → prove_it (was: blocked outright)", () => {
    // scanner classifies sudo as "high"
    const r = resolveApproval(runShell("high"), "standard");
    expect(r.verb).toBe("prove_it");
  });

  test("sudo apt update @ permissive → ask", () => {
    const r = resolveApproval(runShell("high"), "permissive");
    expect(r.verb).toBe("ask");
  });

  test("npm install -g @ standard → ask (was: prove_it pre-D061)", () => {
    // scanner classifies `npm install -g` as "medium"
    const r = resolveApproval(runShell("medium"), "standard");
    expect(r.verb).toBe("ask");
  });

  test("rm -rf ~/Documents @ standard → prove_it (irreversible)", () => {
    // scanner classifies recursive rm of user paths as "high"
    const r = resolveApproval(runShell("high"), "standard");
    expect(r.verb).toBe("prove_it");
  });

  test("fork bomb @ any level → block", () => {
    for (const level of LEVELS) {
      const r = resolveApproval(runShell("critical"), level);
      expect(r.verb).toBe("block");
    }
  });

  test("./install_boho.sh (no scan hit) @ standard → ask (external-binary gate)", () => {
    const r = resolveApproval(runShell(undefined, true), "standard");
    expect(r.verb).toBe("ask");
  });

  test("read-only impact tier @ any level → auto", () => {
    for (const level of LEVELS) {
      const r = resolveApproval({ toolImpact: "read-only" }, level);
      expect(r.verb).toBe("auto");
    }
  });

  test("high-impact tier: auto @ standard, ask @ cautious/paranoid", () => {
    // Generic check of the `high` impact tier — not tied to a specific
    // tool. `high` is currently unused by any built-in after D061-1b
    // flipped write_file/update_config/regenerate_soul to destructive,
    // but the tier still applies to any future tool registered with
    // `impact: "high"` and to MCP-registered tools that choose it.
    expect(resolveApproval({ toolImpact: "high" }, "standard").verb).toBe("auto");
    expect(resolveApproval({ toolImpact: "high" }, "cautious").verb).toBe("ask");
    expect(resolveApproval({ toolImpact: "high" }, "paranoid").verb).toBe("ask");
  });
});

// ---------------------------------------------------------------------------
// M079 — hybrid approval (LLM-declared sensitivity)
// ---------------------------------------------------------------------------

describe("resolveHybridVerb — M079 matrix", () => {
  const expected: Record<"normal" | "sensitive", Record<SecurityLevel, ApprovalVerb>> = {
    normal: {
      yolo: "auto",
      permissive: "ask",
      standard: "ask",
      cautious: "ask",
      paranoid: "ask",
    },
    sensitive: {
      yolo: "auto",
      permissive: "prove_it",
      standard: "prove_it",
      cautious: "prove_it",
      paranoid: "prove_it",
    },
  };

  for (const level of LEVELS) {
    test(`normal @ ${level} → ${expected.normal[level]}`, () => {
      expect(resolveHybridVerb("normal", level)).toBe(expected.normal[level]);
    });
    test(`sensitive @ ${level} → ${expected.sensitive[level]}`, () => {
      expect(resolveHybridVerb("sensitive", level)).toBe(expected.sensitive[level]);
    });
    test(`garbage @ ${level} → same as sensitive (fail-closed)`, () => {
      expect(resolveHybridVerb("totally_invalid", level)).toBe(expected.sensitive[level]);
    });
  }
});

describe("coerceHybridSensitivity — M079", () => {
  test("only normal and sensitive are valid", () => {
    expect(coerceHybridSensitivity("normal")).toEqual({ value: "normal", wasInvalid: false });
    expect(coerceHybridSensitivity("sensitive")).toEqual({ value: "sensitive", wasInvalid: false });
  });

  test("everything else → sensitive + wasInvalid", () => {
    expect(coerceHybridSensitivity("")).toEqual({ value: "sensitive", wasInvalid: true });
    expect(coerceHybridSensitivity("maybe")).toEqual({ value: "sensitive", wasInvalid: true });
    expect(coerceHybridSensitivity(1)).toEqual({ value: "sensitive", wasInvalid: true });
    expect(coerceHybridSensitivity(null)).toEqual({ value: "sensitive", wasInvalid: true });
    expect(coerceHybridSensitivity(undefined)).toEqual({ value: "sensitive", wasInvalid: true });
  });
});

describe("resolveApproval — M079 hybrid path", () => {
  test("hybrid normal: reason mentions LLM marked and needs approval @ standard", () => {
    const r = resolveApproval(
      {
        toolImpact: "destructive",
        toolName: "share_memory",
        hybridSensitivity: "normal",
      },
      "standard",
    );
    expect(r.verb).toBe("ask");
    expect(r.severity).toBe("destructive-low");
    expect(r.reason).toContain("LLM marked");
    expect(r.reason).toContain("needs approval");
  });

  test("hybrid sensitive: reason mentions LLM marked and requires PIN @ standard", () => {
    const r = resolveApproval(
      {
        toolImpact: "destructive",
        toolName: "share_memory",
        hybridSensitivity: "sensitive",
      },
      "standard",
    );
    expect(r.verb).toBe("prove_it");
    expect(r.severity).toBe("destructive-high");
    expect(r.reason).toContain("LLM marked");
    expect(r.reason).toContain("requires PIN");
  });

  test("hybrid bypasses static impact — read-only tool + sensitive → prove_it @ standard", () => {
    const r = resolveApproval(
      {
        toolImpact: "read-only",
        toolName: "hybrid_test_tool",
        hybridSensitivity: "sensitive",
      },
      "standard",
    );
    expect(r.verb).toBe("prove_it");
    expect(r.severity).toBe("destructive-high");
  });

  test("hybrid path: runtime garbage on hybridSensitivity → prove_it @ standard (fail-closed)", () => {
    const r = resolveApproval(
      {
        toolImpact: "destructive",
        toolName: "hybrid_test_tool",
        // @ts-expect-error — exercise runtime fail-closed for malformed hybrid sensitivity
        hybridSensitivity: "bogus",
      },
      "standard",
    );
    expect(r.verb).toBe("prove_it");
    expect(r.severity).toBe("destructive-high");
    expect(r.reason).toContain("missing or invalid sensitivity");
    expect(r.reason).toContain("treated as sensitive");
  });

  test("hybrid invalid flag: reason includes treated as sensitive", () => {
    const r = resolveApproval(
      {
        toolImpact: "destructive",
        toolName: "hybrid_test_tool",
        hybridSensitivity: "sensitive",
        hybridSensitivityWasInvalid: true,
      },
      "standard",
    );
    expect(r.reason).toContain("missing or invalid sensitivity");
    expect(r.reason).toContain("treated as sensitive");
    expect(r.reason).toContain("requires PIN");
  });

  test("hybrid yolo → auto for both sensitivities", () => {
    expect(
      resolveApproval(
        { toolImpact: "destructive", hybridSensitivity: "normal" },
        "yolo",
      ).verb,
    ).toBe("auto");
    expect(
      resolveApproval(
        { toolImpact: "destructive", hybridSensitivity: "sensitive" },
        "yolo",
      ).verb,
    ).toBe("auto");
  });
});
