import { describe, expect, test } from "bun:test";
import {
  APPLY_PATCH_ERROR_CODES,
  applyPatchChildExecutionReportSchema,
  applyPatchErrorSchema,
  applyPatchPathResultSchema,
  applyPatchRequestSchema,
  applyPatchResultSchema,
  applyPatchTrustedContextSchema,
  hasApplyPatchEnvelope,
  normalizeApplyPatchResult,
  validateApplyPatchPreflight,
  validateApplyPatchProcessOutput,
  validateApplyPatchRequest,
} from "../../src/tools/apply-patch/contract";

const VALID_PATCH = [
  "*** Begin Patch",
  "*** Update File: src/example.ts",
  "@@",
  "-old",
  "+new",
  "*** End Patch",
].join("\n");

const BASIC_PREFLIGHT = {
  operations: [{ operation: "add", path: "src/example.ts" }],
};

function completeChild(overrides: Record<string, unknown> = {}) {
  return {
    status: "applied",
    partial: false,
    operationCounts: { add: 1, update: 0, move: 0, delete: 0 },
    pathResults: [
      { operation: "add", path: "src/example.ts", status: "applied", bytesTouched: 12 },
    ],
    unifiedDiff: "--- /dev/null\n+++ b/src/example.ts\n+new\n",
    ...overrides,
  };
}

function trustedMetadata(
  preflight: unknown = BASIC_PREFLIGHT,
  revisions: unknown = [{ path: "src/example.ts", revisionId: "rev-1" }],
  context: unknown = {
    zone: "workspace",
    workspaceId: "room-1",
    relayId: null,
    agentId: "agent-1",
    turnId: "turn-1",
  },
) {
  return {
    context,
    ...(typeof context === "object" && context !== null && (context as { zone?: unknown }).zone === "workspace"
      ? { redactionRoot: "/private/work/project" }
      : {}),
    runtimeVersion: "codex-apply-patch@pinned",
    preflight,
    revisions,
  };
}

function processOutput(overrides: Record<string, unknown> = {}) {
  return {
    stdout: "{}",
    stderr: "",
    exitCode: 0,
    signal: null,
    cancelled: false,
    ...overrides,
  };
}

describe("D448 apply_patch model request and trusted context", () => {
  test("accepts an optional non-authoritative target selector and rejects model-authored authority", () => {
    expect(validateApplyPatchRequest({ patch: VALID_PATCH }).ok).toBe(true);
    expect(validateApplyPatchRequest({ patch: VALID_PATCH, target: "workspace" }).ok).toBe(true);
    expect(validateApplyPatchRequest({ patch: VALID_PATCH, target: "current" }).ok).toBe(true);
    expect(validateApplyPatchRequest({ patch: VALID_PATCH, target: "absolute" }).ok).toBe(false);
    for (const authority of [
      { zone: "current" },
      { root: "/private/work/project" },
      { relayId: "relay-1" },
      { workspaceId: "room-1" },
      { roomId: "room-1" },
      { grantId: "grant-1" },
      { artifactId: "artifact-1" },
      { storagePath: "/private/store" },
      { agentId: "agent-1" },
      { turnId: "turn-1" },
      { context: { zone: "workspace" } },
    ]) {
      expect(applyPatchRequestSchema.safeParse({ patch: VALID_PATCH, ...authority }).success).toBe(false);
    }
  });

  test("publishes ambiguous_target as a stable public failure", () => {
    expect(APPLY_PATCH_ERROR_CODES).toContain("ambiguous_target");
    expect(applyPatchErrorSchema.safeParse({
      code: "ambiguous_target",
      message: "Choose workspace or current.",
      retryable: false,
    }).success).toBe(true);
  });

  test("uses pinned gross marker behavior while leaving operation grammar to the extractor", () => {
    expect(hasApplyPatchEnvelope("  *** Begin Patch  \n  *** End Patch  \n")).toBe(true);
    expect(hasApplyPatchEnvelope("*** Begin Patch\r\n*** End Patch\r\n")).toBe(true);
    expect(hasApplyPatchEnvelope("\n*** Begin Patch\n*** End Patch")).toBe(false);
    expect(hasApplyPatchEnvelope("*** Begin Patch\n*** End Patch\nextra")).toBe(false);
    expect(validateApplyPatchRequest({ patch: "*** Begin Patch\n*** End Patch" }).ok).toBe(true);
  });

  test("accepts well-formed UTF-8 text", () => {
    const patch = "*** Begin Patch\n+é🚀\n*** End Patch";
    expect(validateApplyPatchRequest({ patch }).ok).toBe(true);
    expect(validateApplyPatchRequest({ patch: `*** Begin Patch\n${"\ud800"}\n*** End Patch` })).toMatchObject({
      ok: false,
      error: { code: "parse_error" },
    });
  });

  test("zone-discriminates trusted server and workstation execution", () => {
    const base = { root: "/private/work/project", agentId: "agent-1", turnId: "turn-1" };
    expect(applyPatchTrustedContextSchema.safeParse({ zone: "workspace", workspaceId: "room-1", agentId: base.agentId, turnId: base.turnId, relayId: null }).success).toBe(true);
    expect(applyPatchTrustedContextSchema.safeParse({ zone: "workspace", workspaceId: "room-1", agentId: base.agentId, turnId: base.turnId, relayId: "relay-1" }).success).toBe(false);
    expect(applyPatchTrustedContextSchema.safeParse({ zone: "current", ...base, relayId: "relay-1" }).success).toBe(true);
    expect(applyPatchTrustedContextSchema.safeParse({ zone: "current", ...base, relayId: null }).success).toBe(false);
    expect(applyPatchTrustedContextSchema.safeParse({ zone: "absolute", ...base, relayId: "relay-1" }).success).toBe(true);
    expect(applyPatchTrustedContextSchema.safeParse({ zone: "workspace", workspaceId: "room-1", root: "/", agentId: base.agentId, turnId: base.turnId, relayId: null }).success).toBe(false);
  });
});

describe("D448 apply_patch preflight plan", () => {

  test("accepts representation-only paths and operation-discriminates moves", () => {
    const move = {
      operations: [{ operation: "move", fromPath: "src/old.ts", path: "src/new.ts" }],
    };
    expect(validateApplyPatchPreflight(move).ok).toBe(true);
    expect(validateApplyPatchPreflight({ ...move, operations: [{ operation: "move", path: "src/new.ts" }] }).ok).toBe(false);
    expect(validateApplyPatchPreflight({ ...move, operations: [{ operation: "add", fromPath: "src/old.ts", path: "src/new.ts" }] }).ok).toBe(false);
  });

  test("accepts delete-only plans and rejects empty plans", () => {
    const deleteOnly = {
      operations: [{ operation: "delete", path: "obsolete.txt" }],
    };
    expect(validateApplyPatchPreflight(deleteOnly).ok).toBe(true);
    expect(validateApplyPatchPreflight({ ...deleteOnly, operations: [] }).ok).toBe(false);
  });

  test("leaves path policy and duplicate operation handling to the authority and native engine", () => {
    for (const path of [".", "..", "src/./a.ts", "src/../a.ts", "src//a.ts", "src\\a.ts", "/src/a.ts", "C:a.ts", "src/e\u0301.ts"]) {
      expect(
        validateApplyPatchPreflight({
          operations: [{ operation: "add", path }],
        }).ok,
      ).toBe(true);
    }
    expect(
      validateApplyPatchPreflight({
        operations: [
          { operation: "move", fromPath: "src/a.ts", path: "src/b.ts" },
          { operation: "delete", path: "src/a.ts" },
        ],
      }).ok,
    ).toBe(true);
  });

});

describe("D448 apply_patch process-output facts", () => {
  test("requires explicit terminal and cancellation facts", () => {
    expect(validateApplyPatchProcessOutput(processOutput()).ok).toBe(true);
    expect(validateApplyPatchProcessOutput({ stdout: "{}", stderr: "" }).ok).toBe(false);
    expect(validateApplyPatchProcessOutput(processOutput({ extra: true })).ok).toBe(false);
    expect(validateApplyPatchProcessOutput(processOutput({ exitCode: 1, signal: "SIGTERM" })).ok).toBe(false);
    expect(validateApplyPatchProcessOutput(processOutput({ exitCode: null })).ok).toBe(false);
  });

  test("classifies cancellation", () => {
    expect(validateApplyPatchProcessOutput(processOutput({ cancelled: true, exitCode: null }))).toMatchObject({ ok: false, error: { code: "cancelled" } });
  });
});

describe("D448 child/trusted normalization boundary", () => {
  test("rejects child-authored turn, runtime, and revision claims", () => {
    expect(applyPatchChildExecutionReportSchema.safeParse({ ...completeChild(), turnId: "forged" }).success).toBe(false);
    expect(applyPatchChildExecutionReportSchema.safeParse({ ...completeChild(), runtimeVersion: "forged" }).success).toBe(false);
    expect(applyPatchChildExecutionReportSchema.safeParse({ ...completeChild(), revisionIds: ["forged"] }).success).toBe(false);
    expect(
      applyPatchChildExecutionReportSchema.safeParse({
        ...completeChild(),
        pathResults: [{ ...completeChild().pathResults[0], revisionId: "forged" }],
      }).success,
    ).toBe(false);
  });

  test("injects verified turn/runtime and locally recorded revisions", () => {
    const normalized = normalizeApplyPatchResult(completeChild(), trustedMetadata());
    expect(normalized.ok).toBe(true);
    if (normalized.ok) {
      expect(normalized.result).toMatchObject({
        status: "applied",
        partial: false,
        turnId: "turn-1",
        runtimeVersion: "codex-apply-patch@pinned",
        revisionIds: ["rev-1"],
      });
      expect(normalized.result.changedFiles[0]).toMatchObject({ path: "src/example.ts", revisionId: "rev-1" });
      expect(applyPatchResultSchema.safeParse(normalized.result).success).toBe(true);
    }
  });

  test("requires exact plan agreement and exact unique revision coverage", () => {
    const stalePlan = { ...BASIC_PREFLIGHT, operations: [{ operation: "add", path: "src/other.ts" }] };
    expect(normalizeApplyPatchResult(completeChild(), trustedMetadata(stalePlan))).toMatchObject({ ok: false, error: { code: "stale_context" } });
    expect(normalizeApplyPatchResult(completeChild({ pathResults: [{ operation: "add", path: "src/example.ts", status: "applied", bytesTouched: 11 }] }), trustedMetadata()).ok).toBe(true);
    expect(normalizeApplyPatchResult(completeChild(), trustedMetadata(BASIC_PREFLIGHT, []))).toMatchObject({ ok: false, error: { code: "missing_context" } });
    expect(
      normalizeApplyPatchResult(
        completeChild(),
        trustedMetadata(BASIC_PREFLIGHT, [
          { path: "src/example.ts", revisionId: "rev-1" },
          { path: "src/other.ts", revisionId: "rev-1" },
        ]),
      ),
    ).toMatchObject({ ok: false, error: { code: "missing_context" } });
  });

  test("requires fromPath for moves and forbids it on non-moves in child/public results", () => {
    expect(applyPatchChildExecutionReportSchema.safeParse({ ...completeChild(), pathResults: [{ operation: "move", path: "b", status: "applied", bytesTouched: 1 }] }).success).toBe(false);
    expect(applyPatchChildExecutionReportSchema.safeParse({ ...completeChild(), pathResults: [{ operation: "add", fromPath: "a", path: "b", status: "applied", bytesTouched: 1 }] }).success).toBe(false);
    expect(applyPatchPathResultSchema.safeParse({ operation: "move", path: "b", status: "applied", bytesTouched: 1, revisionId: "rev-1" }).success).toBe(false);
  });

  test("uses null touched bytes only for unknown state and zero for definite non-application", () => {
    const partialBase = {
      status: "partial",
      partial: true,
      operationCounts: { add: 1, update: 0, move: 0, delete: 0 },
      unifiedDiff: "diff",
      diagnostic: "partial",
    };
    const applied = { operation: "add", path: "a", status: "applied", bytesTouched: 1 };
    const unknown = { operation: "delete", path: "b", status: "unknown", bytesTouched: null, diagnostic: "indeterminate" };
    const failed = { operation: "delete", path: "b", status: "failed", bytesTouched: 0, diagnostic: "not committed" };
    expect(applyPatchChildExecutionReportSchema.safeParse({ ...partialBase, pathResults: [applied, unknown] }).success).toBe(true);
    expect(applyPatchChildExecutionReportSchema.safeParse({ ...partialBase, pathResults: [applied, { ...unknown, bytesTouched: 0 }] }).success).toBe(false);
    expect(applyPatchChildExecutionReportSchema.safeParse({ ...partialBase, pathResults: [applied, failed] }).success).toBe(true);
    expect(applyPatchChildExecutionReportSchema.safeParse({ ...partialBase, pathResults: [applied, { ...failed, bytesTouched: null }] }).success).toBe(false);
    expect(applyPatchPathResultSchema.safeParse({ operation: "delete", path: "b", status: "unknown", bytesTouched: 0, revisionId: null, error: { code: "partial_execution", message: "indeterminate", retryable: false } }).success).toBe(false);
    expect(applyPatchPathResultSchema.safeParse({ operation: "delete", path: "b", status: "unknown", bytesTouched: null, revisionId: null, error: { code: "partial_execution", message: "indeterminate", retryable: false } }).success).toBe(true);
  });
});

describe("D448 complete and partial result invariants", () => {
  const partialPreflight = {
    operations: [
      { operation: "add", path: "src/one.ts" },
      { operation: "move", fromPath: "src/old.ts", path: "src/new.ts" },
      { operation: "delete", path: "src/later.ts" },
    ],
  };

  function partialChild(pathResults: unknown[]) {
    return {
      status: "partial",
      partial: true,
      operationCounts: { add: 1, update: 0, move: 0, delete: 0 },
      pathResults,
      unifiedDiff: "diff",
      diagnostic: "A committed prefix remains.",
    };
  }

  const appliedPrefix = { operation: "add", path: "src/one.ts", status: "applied", bytesTouched: 4 };
  const unknownMove = { operation: "move", fromPath: "src/old.ts", path: "src/new.ts", status: "unknown", bytesTouched: null, diagnostic: "state unknown" };
  const notAppliedTail = { operation: "delete", path: "src/later.ts", status: "not_applied", bytesTouched: 0, diagnostic: "not attempted" };

  test("accepts only a contiguous applied prefix followed by a non-applied remainder", () => {
    const metadata = trustedMetadata(partialPreflight, [{ path: "src/one.ts", revisionId: "rev-1" }]);
    expect(normalizeApplyPatchResult(partialChild([appliedPrefix, unknownMove, notAppliedTail]), metadata).ok).toBe(true);
    const noPrefixPlan = {
      operations: partialPreflight.operations.slice(1),
    };
    const noPrefix = partialChild([unknownMove, notAppliedTail]);
    noPrefix.operationCounts = { add: 0, update: 0, move: 0, delete: 0 };
    const normalizedNoPrefix = normalizeApplyPatchResult(noPrefix, trustedMetadata(noPrefixPlan, []));
    expect(normalizedNoPrefix).toMatchObject({
      ok: true,
      result: { status: "partial", changedFiles: [], revisionIds: [] },
    });
    if (normalizedNoPrefix.ok) {
      expect(applyPatchResultSchema.safeParse(normalizedNoPrefix.result).success).toBe(true);
    }

    const appliedAfterRemainder = partialChild([
      appliedPrefix,
      unknownMove,
      { operation: "delete", path: "src/later.ts", status: "applied", bytesTouched: 1 },
    ]);
    appliedAfterRemainder.operationCounts = { add: 1, update: 0, move: 0, delete: 1 };
    expect(normalizeApplyPatchResult(appliedAfterRemainder, trustedMetadata(partialPreflight, [
      { path: "src/one.ts", revisionId: "rev-1" },
      { path: "src/later.ts", revisionId: "rev-2" },
    ]))).toMatchObject({ ok: false, error: { code: "parse_error" } });
  });

  test("rejects all-applied partials and complete reports with a remainder", () => {
    const twoPlan = {
      operations: [
        { operation: "add", path: "src/a.ts" },
        { operation: "delete", path: "src/b.ts" },
      ],
    };
    const allApplied = partialChild([
      { operation: "add", path: "src/a.ts", status: "applied", bytesTouched: 1 },
      { operation: "delete", path: "src/b.ts", status: "applied", bytesTouched: 1 },
    ]);
    allApplied.operationCounts = { add: 1, update: 0, move: 0, delete: 1 };
    expect(normalizeApplyPatchResult(allApplied, trustedMetadata(twoPlan, [
      { path: "src/a.ts", revisionId: "rev-a" },
      { path: "src/b.ts", revisionId: "rev-b" },
    ]))).toMatchObject({ ok: false, error: { code: "parse_error" } });

    const completeWithRemainder = {
      ...partialChild([appliedPrefix, unknownMove, notAppliedTail]),
      status: "applied",
      partial: false,
    };
    delete (completeWithRemainder as { diagnostic?: string }).diagnostic;
    expect(normalizeApplyPatchResult(completeWithRemainder, trustedMetadata(partialPreflight, [{ path: "src/one.ts", revisionId: "rev-1" }]))).toMatchObject({ ok: false, error: { code: "parse_error" } });
  });

  test("allows a zero-applied partial but never a zero-applied complete result", () => {
    const noAppliedPartial = {
      status: "partial",
      partial: true,
      operationCounts: { add: 0, update: 0, move: 0, delete: 0 },
      pathResults: [{
        operation: "delete",
        path: "src/missing.ts",
        status: "not_applied",
        bytesTouched: 0,
        diagnostic: "not attempted",
      }],
      unifiedDiff: "",
      diagnostic: "nothing committed",
    };
    const noAppliedPlan = { operations: [{ operation: "delete", path: "src/missing.ts" }] };
    const normalized = normalizeApplyPatchResult(noAppliedPartial, trustedMetadata(noAppliedPlan, []));
    expect(normalized).toMatchObject({ ok: true, result: { changedFiles: [], revisionIds: [] } });

    expect(applyPatchResultSchema.safeParse({
      status: "applied",
      partial: false,
      operationCounts: { add: 0, update: 0, move: 0, delete: 0 },
      pathResults: [{
        operation: "delete",
        path: "src/missing.ts",
        status: "not_applied",
        bytesTouched: 0,
        revisionId: null,
        error: { code: "partial_execution", message: "not attempted", retryable: false },
      }],
      changedFiles: [],
      revisionIds: [],
      unifiedDiff: "",
      runtimeVersion: "runtime",
      turnId: "turn-1",
    }).success).toBe(false);
  });

  test("does not make filesystem-policy decisions for duplicate child candidates", () => {
    const child = partialChild([
      appliedPrefix,
      unknownMove,
      { operation: "delete", path: "src/old.ts", status: "not_applied", bytesTouched: 0, diagnostic: "not attempted" },
    ]);
    expect(applyPatchChildExecutionReportSchema.safeParse(child).success).toBe(true);
  });
});

describe("D448 public output redaction and stable errors", () => {
  test("exported result schema independently enforces all applied-result projections", () => {
    const preflight = {
      operations: [
        { operation: "add", path: "src/a.ts" },
        { operation: "update", path: "src/b.ts" },
      ],
    };
    const child = completeChild({
      operationCounts: { add: 1, update: 1, move: 0, delete: 0 },
      pathResults: [
        { operation: "add", path: "src/a.ts", status: "applied", bytesTouched: 1 },
        { operation: "update", path: "src/b.ts", status: "applied", bytesTouched: 2 },
      ],
    });
    const normalized = normalizeApplyPatchResult(
      child,
      trustedMetadata(preflight, [
        { path: "src/a.ts", revisionId: "rev-a" },
        { path: "src/b.ts", revisionId: "rev-b" },
      ]),
    );
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    const result = normalized.result;
    expect(applyPatchResultSchema.safeParse(result).success).toBe(true);
    expect(applyPatchResultSchema.safeParse({
      ...result,
      operationCounts: { add: 2, update: 0, move: 0, delete: 0 },
    }).success).toBe(false);
    expect(applyPatchResultSchema.safeParse({
      ...result,
      changedFiles: [...result.changedFiles].reverse(),
    }).success).toBe(false);
    expect(applyPatchResultSchema.safeParse({
      ...result,
      changedFiles: [{ ...result.changedFiles[0], revisionId: "rev-other" }, result.changedFiles[1]],
    }).success).toBe(false);
    expect(applyPatchResultSchema.safeParse({
      ...result,
      revisionIds: [...result.revisionIds].reverse(),
    }).success).toBe(false);
  });

  test("redacts the configured root from child diff and diagnostics before publication", () => {
    const root = "/private/work/project";
    const preflight = {
      operations: [
        { operation: "add", path: "src/one.ts" },
        { operation: "delete", path: "src/two.ts" },
      ],
    };
    const child = {
      status: "partial",
      partial: true,
      operationCounts: { add: 1, update: 0, move: 0, delete: 0 },
      pathResults: [
        { operation: "add", path: "src/one.ts", status: "applied", bytesTouched: 1 },
        { operation: "delete", path: "src/two.ts", status: "failed", bytesTouched: 0, diagnostic: `failed under ${root}/src/two.ts` },
      ],
      unifiedDiff: `--- ${root}/src/two.ts\n+++ ${root}/src/two.ts\n`,
      diagnostic: `partial write under ${root}`,
    };
    const normalized = normalizeApplyPatchResult(
      child,
      trustedMetadata(preflight, [{ path: "src/one.ts", revisionId: "rev-1" }]),
    );
    expect(normalized.ok).toBe(true);
    if (normalized.ok) {
      const serialized = JSON.stringify(normalized.result);
      expect(serialized).not.toContain(root);
      expect(serialized).toContain("[authorized-root]");
    }
  });

  test("redacts slash aliases and case variants for a Windows configured root", () => {
    const context = {
      zone: "current",
      root: "C:\\Secret\\Repo",
      relayId: "relay-1",
      agentId: "agent-1",
      turnId: "turn-1",
    };
    const child = completeChild({ unifiedDiff: "--- c:/secret/repo/src/example.ts\n" });
    const normalized = normalizeApplyPatchResult(child, trustedMetadata(BASIC_PREFLIGHT, undefined, context));
    expect(normalized.ok).toBe(true);
    if (normalized.ok) expect(JSON.stringify(normalized.result).toLowerCase()).not.toContain("c:/secret/repo");
  });

  test("redacts absolute applied paths after raw plan and revision reconciliation", () => {
    const root = "/private/work/project";
    const context = { zone: "current", root, relayId: "relay-1", agentId: "agent-1", turnId: "turn-1" };
    const plan = { operations: [{ operation: "move", fromPath: `${root}/old.ts`, path: `${root}/new.ts` }] };
    const child = {
      status: "applied", partial: false,
      operationCounts: { add: 0, update: 0, move: 1, delete: 0 },
      pathResults: [{ operation: "move", fromPath: `${root}/old.ts`, path: `${root}/new.ts`, status: "applied" }],
      unifiedDiff: "",
    };
    const normalized = normalizeApplyPatchResult(child, trustedMetadata(plan, [{ path: `${root}/new.ts`, revisionId: "rev-1" }], context));
    expect(normalized.ok).toBe(true);
    if (normalized.ok) {
      expect(JSON.stringify(normalized.result)).not.toContain(root);
      expect(normalized.result.revisionIds).toEqual(["rev-1"]);
      expect(normalized.result.changedFiles[0]).toMatchObject({ path: "[authorized-root]/new.ts", fromPath: "[authorized-root]/old.ts" });
    }
  });

  test("pins the stable error taxonomy", () => {
    expect(APPLY_PATCH_ERROR_CODES).toEqual([
      "invalid_request",
      "parse_error",
      "missing_context",
      "ambiguous_target",
      "unsupported_target",
      "stale_context",
      "human_edit_conflict",
      "reapply_required",
      "unsupported_encoding_or_type",
      "denied_path",
      "runtime_unavailable",
      "runtime_corrupt",
      "cancelled",
      "partial_execution",
    ]);
    expect(applyPatchErrorSchema.safeParse({ code: "denied_path", message: "no", retryable: false }).success).toBe(true);
    expect(normalizeApplyPatchResult(completeChild({ unifiedDiff: "x".repeat(20) }), trustedMetadata()).ok).toBe(true);
  });
});
