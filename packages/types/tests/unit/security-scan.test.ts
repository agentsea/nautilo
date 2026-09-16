import { describe, expect, test } from "bun:test";

import {
  SECURITY_SCAN_INITIAL_LANES,
  SECURITY_SCAN_VERSION,
  securityScanOperationSchema,
  securityScanLedgerRecordSchema,
  securityScanRelayRequestSchema,
  securityScanResultEnvelopeSchema,
  securityScanResultEnvelopeToJson,
  securityScanResultEnvelopeToMarkdown,
  securityScanTrustedContextSchema,
} from "../../src/security-scan";

const status = {
  version: SECURITY_SCAN_VERSION,
  scanId: "scan_demo-1",
  state: "active",
  phase: "researching",
  terminalState: null,
  mode: "deep_research",
  modelId: "fireworks:accounts/fireworks/models/eligible-model",
  modelState: "running",
  completedSteps: 2,
  totalSteps: 5,
  lanes: SECURITY_SCAN_INITIAL_LANES,
  coverage: [{
    surfaceKey: "auth_boundary",
    label: "Authentication boundary",
    state: "in_progress",
    rationale: "Routes and token verification are under review.",
  }],
  hypotheses: [{
    id: "record_hypothesis-1",
    state: "investigating",
    summary: "Untrusted request input may reach a privileged sink.",
  }],
} as const;

const envelope = {
  version: SECURITY_SCAN_VERSION,
  status,
  observations: [{
    id: "observation_2",
    probe: "trivy",
    sourceScope: "current_tree",
    ruleId: null,
    advisoryId: "CVE-2026-1234",
    packageName: "example-package",
    relativePath: "package-lock.json",
    startLine: 12,
    endLine: 12,
    severity: "high",
    summary: "Dependency advisory detected.",
    secretRedacted: false,
  }, {
    id: "observation_1",
    probe: "gitleaks",
    sourceScope: "git_history",
    ruleId: "generic-api-key",
    advisoryId: null,
    packageName: null,
    relativePath: "src/config.ts",
    startLine: 4,
    endLine: 4,
    severity: "high",
    summary: "Potential credential was redacted.",
    secretRedacted: true,
  }],
  codeEvidence: [{
    id: "code_evidence_1",
    relativePath: "src/auth/policy.ts",
    startLine: 20,
    endLine: 24,
    fileSha256: "a".repeat(64),
    rangeSha256: "b".repeat(64),
    rootFingerprint: "c".repeat(64),
    capturedAt: "2026-08-27T11:30:00.000Z",
    gitHead: "d".repeat(40),
    gitDirty: true,
  }],
  records: [{
    id: "record_2",
    revision: 1,
    createdAt: "2026-08-27T12:00:00.000Z",
    updatedAt: "2026-08-27T12:00:00.000Z",
    createdBy: {
      taskId: "00000000-0000-4000-8000-000000000001",
      taskRunId: "00000000-0000-4000-8000-000000000002",
      modelId: "fireworks:accounts/fireworks/models/eligible-model",
    },
    updatedBy: {
      taskId: "00000000-0000-4000-8000-000000000001",
      taskRunId: "00000000-0000-4000-8000-000000000002",
      modelId: "fireworks:accounts/fireworks/models/eligible-model",
    },
    entry: {
      kind: "finding",
      title: "Input reaches privileged sink",
      summary: "Trace should be reviewed with its callers and tests.",
      confidence: "medium",
      impact: "Potential authority boundary bypass.",
      exploitPreconditions: "An attacker controls the request parameter.",
      evidenceRefs: [{ kind: "scanner_observation", id: "observation_1" }],
      counterevidenceRefs: [],
    },
  }, {
    id: "record_1",
    revision: 1,
    createdAt: "2026-08-27T11:00:00.000Z",
    updatedAt: "2026-08-27T11:00:00.000Z",
    createdBy: {
      taskId: "00000000-0000-4000-8000-000000000001",
      taskRunId: "00000000-0000-4000-8000-000000000002",
      modelId: "fireworks:accounts/fireworks/models/eligible-model",
    },
    updatedBy: {
      taskId: "00000000-0000-4000-8000-000000000001",
      taskRunId: "00000000-0000-4000-8000-000000000002",
      modelId: "fireworks:accounts/fireworks/models/eligible-model",
    },
    entry: {
      kind: "coverage",
      surfaceKey: "auth_boundary",
      state: "in_progress",
      rationale: "Authentication routes are still being traced.",
      evidenceRefs: [],
    },
  }],
  nextCursor: null,
} as const;

describe("D560 security scan contract", () => {
  test("allows only the five model-facing operations and keeps trusted context separate", () => {
    expect(securityScanOperationSchema.parse({
      version: SECURITY_SCAN_VERSION,
      operation: "start",
      targetDirectory: ".", mode: "deep_research",
      priorScanId: "scan_previous-1",
    })).toMatchObject({ operation: "start", targetDirectory: ".", priorScanId: "scan_previous-1" });
    expect(securityScanOperationSchema.parse({
      version: SECURITY_SCAN_VERSION,
      operation: "status",
      scanId: "scan_previous-1",
    })).toMatchObject({ operation: "status", scanId: "scan_previous-1" });
    expect(securityScanOperationSchema.safeParse({
      version: SECURITY_SCAN_VERSION,
      operation: "start",
      targetDirectory: ".", mode: "deep_research",
      model: { kind: "catalog_model", modelId: "catalog:models/eligible-model" },
      taskRunId: "00000000-0000-4000-8000-000000000001",
      root: "/private/source",
      relayId: "relay-1",
    }).success).toBe(false);
    expect(securityScanOperationSchema.safeParse({
      version: SECURITY_SCAN_VERSION,
      operation: "record",
      scanId: "scan_demo-1",
      action: "append",
      entry: {
        kind: "finding",
        title: "Unsafe propagation",
        summary: "A value crosses a trust boundary.",
        confidence: "high",
        impact: "Privilege escalation is possible.",
        exploitPreconditions: "Attacker controls a request field.",
        evidenceRefs: [],
        counterevidenceRefs: [],
      },
      fileCitations: [{ relativePath: "src/auth.ts", startLine: 8, endLine: 12 }],
    }).success).toBe(true);
    expect(securityScanLedgerRecordSchema.safeParse({
      ...envelope.records[0],
      entry: { ...envelope.records[0].entry, evidenceRefs: [] },
    }).success).toBe(false);
    expect(securityScanOperationSchema.safeParse({
      version: SECURITY_SCAN_VERSION,
      operation: "delete",
    }).success).toBe(false);
    expect(securityScanTrustedContextSchema.parse({
      taskId: "00000000-0000-4000-8000-000000000001",
      taskRunId: "00000000-0000-4000-8000-000000000002",
      toolCallId: "tool-call-1",
      modelId: "fireworks:accounts/fireworks/models/eligible-model",
    })).toMatchObject({ toolCallId: "tool-call-1" });
    expect(securityScanRelayRequestSchema.parse({
      operation: {
        version: SECURITY_SCAN_VERSION,
        operation: "start",
        targetDirectory: ".", mode: "deep_research",
      },
      trustedContext: {
        taskId: "00000000-0000-4000-8000-000000000001",
        taskRunId: "00000000-0000-4000-8000-000000000002",
        toolCallId: "tool-call-1",
        modelId: "fireworks:accounts/fireworks/models/eligible-model",
      },
      expectedCurrentFolder: "/private/project",
    }).expectedCurrentFolder).toBe("/private/project");
    expect(securityScanRelayRequestSchema.safeParse({
      operation: {
        version: SECURITY_SCAN_VERSION,
        operation: "start",
        targetDirectory: ".", mode: "deep_research",
      },
      trustedContext: {
        taskId: "00000000-0000-4000-8000-000000000001",
        taskRunId: "00000000-0000-4000-8000-000000000002",
        toolCallId: "tool-call-1",
        modelId: "fireworks:accounts/fireworks/models/eligible-model",
      },
      expectedCurrentFolder: "relative/project",
    }).success).toBe(false);
  });

  test("requires exact typed record branches, evidence refs, and update identity", () => {
    expect(securityScanOperationSchema.safeParse({
      version: SECURITY_SCAN_VERSION,
      operation: "record",
      scanId: "scan_demo-1",
      action: "append",
      entry: {
        kind: "repository_map",
        summary: "Initial repository map; detailed surfaces will follow.",
        evidenceRefs: [],
      },
      fileCitations: [],
    }).success).toBe(true);
    expect(securityScanOperationSchema.safeParse({
      version: SECURITY_SCAN_VERSION,
      operation: "record",
      scanId: "scan_demo-1",
      action: "append",
      entry: {
        kind: "dismissal",
        summary: "The scanner matched encrypted Pulumi ciphertext, not a plaintext credential.",
        evidenceRefs: [{ kind: "scanner_observation", id: "observation_gitleaks-1" }],
        counterevidenceRefs: [],
      },
      fileCitations: [],
    }).success).toBe(true);
    expect(securityScanOperationSchema.safeParse({
      version: SECURITY_SCAN_VERSION,
      operation: "record",
      scanId: "scan_demo-1",
      action: "append",
      entry: {
        kind: "finding",
        title: "Unsafe propagation",
        summary: "A value crosses a trust boundary.",
        confidence: "high",
        impact: "Privilege escalation is possible.",
        exploitPreconditions: "Attacker controls a request field.",
        evidenceRefs: [],
        counterevidenceRefs: [],
      },
    }).success).toBe(false);
    expect(securityScanOperationSchema.safeParse({
      version: SECURITY_SCAN_VERSION,
      operation: "record",
      scanId: "scan_demo-1",
      action: "update",
      entry: {
        kind: "open_question",
        question: "Does the sanitizer cover all callers?",
        evidenceRefs: [],
      },
    }).success).toBe(false);
    expect(securityScanOperationSchema.parse({
      version: SECURITY_SCAN_VERSION,
      operation: "record",
      scanId: "scan_demo-1",
      action: "update",
      recordId: "record_question-1",
      expectedRevision: 1,
      entry: {
        kind: "open_question",
        question: "Does the sanitizer cover all callers?",
        evidenceRefs: [{ kind: "ledger_record", id: "record_hypothesis-1" }],
      },
      fileCitations: [{
        relativePath: "src/(auth)/policy ü.ts",
        startLine: 20,
        endLine: 24,
        searchQuery: "sanitize(value)",
      }],
    }).operation).toBe("record");
    expect(securityScanOperationSchema.parse({
      version: SECURITY_SCAN_VERSION,
      operation: "record",
      scanId: "scan_demo-1",
      action: "update",
      recordId: "record_hypothesis-1",
      expectedRevision: 2,
      entry: {
        kind: "hypothesis",
        state: "supported",
      },
      fileCitations: [],
    })).toMatchObject({
      operation: "record",
      entry: { kind: "hypothesis", state: "supported" },
    });
    expect(securityScanOperationSchema.parse({
      version: SECURITY_SCAN_VERSION,
      operation: "record",
      scanId: "scan_demo-1",
      action: "append",
      entry: {
        kind: "evidence",
        summary: "A request value reaches the privileged call without validation.",
        evidenceRefs: [],
      },
      fileCitations: [{
        relativePath: "src/(auth)/policy ü.ts",
        startLine: 20,
        endLine: 24,
      }],
    }).operation).toBe("record");
    expect(securityScanOperationSchema.safeParse({
      version: SECURITY_SCAN_VERSION,
      operation: "record",
      scanId: "scan_demo-1",
      action: "append",
      entry: {
        kind: "evidence",
        summary: "An unsupported assertion has no durable source.",
        evidenceRefs: [],
      },
      fileCitations: [],
    }).success).toBe(false);
    expect(securityScanOperationSchema.safeParse({
      version: SECURITY_SCAN_VERSION,
      operation: "record",
      scanId: "scan_demo-1",
      action: "append",
      entry: {
        kind: "open_question",
        question: "Does the sanitizer cover all callers?",
        evidenceRefs: [],
      },
      fileCitations: [{ relativePath: "/private/source.ts", startLine: 8, endLine: 7 }],
    }).success).toBe(false);
  });

  test("makes all four lanes visible, including an unavailable Semgrep lane", () => {
    expect(SECURITY_SCAN_INITIAL_LANES).toEqual([
      expect.objectContaining({ probe: "gitleaks", state: "pending" }),
      expect.objectContaining({ probe: "osv_scanner", state: "pending" }),
      expect.objectContaining({ probe: "trivy", state: "pending" }),
      expect.objectContaining({ probe: "semgrep", state: "unavailable", coverage: "limited" }),
    ]);
    const semgrep = SECURITY_SCAN_INITIAL_LANES.find((lane) => lane.probe === "semgrep");
    expect(semgrep?.error?.code).toBe("rules_unavailable");
  });

  test("keeps result pages bounded, relative, and terminally truthful", () => {
    const parsed = securityScanResultEnvelopeSchema.parse(envelope);
    expect(parsed.status.state).toBe("active");
    expect(parsed.observations.find((observation) => observation.sourceScope === "git_history")).toMatchObject({
      relativePath: null,
      historyOnlyPath: "src/config.ts",
    });
    expect(securityScanResultEnvelopeSchema.safeParse({
      ...envelope,
      observations: Array.from({ length: 101 }, () => envelope.observations[0]),
    }).success).toBe(false);
    expect(securityScanResultEnvelopeSchema.safeParse({
      ...envelope,
      observations: Array.from({ length: 50 }, () => envelope.observations[0]),
      codeEvidence: Array.from({ length: 50 }, () => envelope.codeEvidence[0]),
      records: [envelope.records[0]],
    }).success).toBe(false);
    expect(securityScanResultEnvelopeSchema.safeParse({
      ...envelope,
      observations: [{ ...envelope.observations[0], relativePath: "/private/source.ts" }],
    }).success).toBe(false);
    expect(securityScanResultEnvelopeSchema.safeParse({
      ...envelope,
      observations: [{ ...envelope.observations[0], relativePath: "src/../private/source.ts" }],
    }).success).toBe(false);
    expect(securityScanResultEnvelopeSchema.safeParse({
      ...envelope,
      observations: [{ ...envelope.observations[0], relativePath: "src/(shared)/π config.ts", startLine: 8, endLine: 7 }],
    }).success).toBe(false);
    expect(securityScanResultEnvelopeSchema.safeParse({
      ...envelope,
      status: {
        ...status,
        lanes: status.lanes.map((lane) => lane.probe === "semgrep" ? { ...lane, error: null } : lane),
      },
    }).success).toBe(false);
    expect(securityScanResultEnvelopeSchema.safeParse({
      ...envelope,
      status: { ...status, state: "completed", terminalState: null },
    }).success).toBe(false);
    expect(securityScanResultEnvelopeSchema.parse({
      ...envelope,
      status: { ...status, mode: "scanners_only", modelId: null, modelState: "disabled" },
    }).status.modelId).toBeNull();
    expect(securityScanResultEnvelopeSchema.safeParse({
      ...envelope,
      status: { ...status, mode: "scanners_only", modelState: "disabled" },
    }).success).toBe(false);
    expect(securityScanResultEnvelopeSchema.safeParse({
      ...envelope,
      status: { ...status, modelId: null },
    }).success).toBe(false);
  });

  test("produces stable JSON and Markdown projections without raw source or secrets", () => {
    const parsed = securityScanResultEnvelopeSchema.parse(envelope);
    const json = securityScanResultEnvelopeToJson(parsed);
    const markdown = securityScanResultEnvelopeToMarkdown(parsed);
    expect(json.indexOf("observation_1")).toBeLessThan(json.indexOf("observation_2"));
    expect(json.indexOf("record_1")).toBeLessThan(json.indexOf("record_2"));
    expect(markdown).toContain("semgrep: unavailable");
    expect(markdown).toContain("fireworks:accounts/fireworks/models/eligible-model");
    expect(markdown).toContain("Potential credential was redacted.");
    expect(markdown).toContain("gitleaks/high/git_history");
    expect(markdown).toContain("src/auth/policy.ts:20-24");
    expect(markdown).not.toContain("/private/");
    const injectionSafe = securityScanResultEnvelopeToMarkdown(securityScanResultEnvelopeSchema.parse({
      ...envelope,
      status: {
        ...status,
        coverage: [{ ...status.coverage[0], rationale: "[click](https://untrusted.invalid)" }],
      },
    }));
    expect(injectionSafe).toContain("\\[click\\]\\(https://untrusted.invalid\\)");
  });
});


test("scan start requires an explicit target rather than defaulting to Current Folder", () => {
  expect(securityScanOperationSchema.safeParse({ version: "security-scan-v1", operation: "start", mode: "deep_research" }).success).toBe(false);
  for (const targetDirectory of [".", "repo/subfolder", "/projects/repo"]) {
    expect(securityScanOperationSchema.safeParse({ version: "security-scan-v1", operation: "start", mode: "deep_research", targetDirectory }).success).toBe(true);
  }
});

test("append validation reports each missing kind-specific reference field without changing substantive notes", () => {
  const entry = { kind: "review_unit", summary: "Trace session authorization into project sharing", surfaceKey: "sharing", paths: ["sharing.ts"], state: "in_progress",
    trace: "Request identity -> project access decision -> shared document lookup.", notes: "Preserve the complete observed behavior, uncertainty and counterevidence. ".repeat(100) };
  const args = { version: SECURITY_SCAN_VERSION, operation: "record", scanId: "scan_demo-1", action: "append", entry };
  const original = JSON.stringify(args);
  const failed = securityScanOperationSchema.safeParse(args);
  expect(failed.success).toBe(false);
  if (failed.success) throw Error("Expected incomplete append to fail");
  expect(failed.error.issues.map((issue) => ({ code: issue.code, path: issue.path.join(".") }))).toEqual([
    { code: "invalid_type", path: "entry.evidenceRefs" },
    { code: "invalid_type", path: "entry.counterevidenceRefs" },
    { code: "invalid_type", path: "entry.openRecordIds" },
  ]);
  expect(JSON.stringify(args)).toBe(original);
  const repaired = securityScanOperationSchema.parse({ ...args, entry: { ...entry, evidenceRefs: [], counterevidenceRefs: [], openRecordIds: [] } });
  expect(repaired).toMatchObject({ entry: { ...entry, evidenceRefs: [], counterevidenceRefs: [], openRecordIds: [] } });
  const patch = securityScanOperationSchema.parse({ ...args, action: "update", recordId: "unit_sharing", expectedRevision: 1,
    entry: { kind: "review_unit", notes: entry.notes } });
  expect(patch).toMatchObject({ entry: { kind: "review_unit", notes: entry.notes } });
  expect(patch).not.toHaveProperty("entry.evidenceRefs");
});
