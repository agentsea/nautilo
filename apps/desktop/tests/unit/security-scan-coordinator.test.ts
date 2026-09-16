import { securityScanToolResultSchema } from "@nautilo/types";
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProtectedPathPolicy } from "@nautilo/security";
import type { SecurityScanToolResult, SecurityScanTrustedContext } from "@nautilo/types";
import { DesktopSecurityScanLedger } from "../../electron/security-scan/ledger";
import { DesktopSecurityScanCoordinator } from "../../electron/security-scan/coordinator";

const TASK_ID = "00000000-0000-4000-8000-000000000001";
const RUN_ID = "00000000-0000-4000-8000-000000000002";

function trusted(toolCallId: string): SecurityScanTrustedContext {
  return { taskId: TASK_ID, taskRunId: RUN_ID, toolCallId, modelId: "openrouter:z-ai/glm-5.3" };
}

async function coordinatorFor(root: string, dataRoot: string, probeOverrides: Partial<import("../../electron/security-scan/probes").SecurityProbeSuiteDeps> = {}, allowed = (_path: string) => true) {
  let selected = root;
  const holder: { coordinator: DesktopSecurityScanCoordinator | undefined } = { coordinator: undefined };
  const ledger = new DesktopSecurityScanLedger({
    userDataRoot: dataRoot,
    citationReader: { revalidateAndHash: (citation, identity) => holder.coordinator!.revalidateAndHash(citation, identity) },
    rootIdentityReader: { revalidate: (identity) => holder.coordinator!.revalidateRoot(identity) },
  });
  const coordinator = new DesktopSecurityScanCoordinator({
    ledger,
    getLocalWorkspacePath: () => selected,
    protectedPathPolicy: { check: (path: string) => ({ allowed: allowed(path) }) } as unknown as ProtectedPathPolicy,
    localOwnerIdentity: "https://example.test\u0000user-1",
    probeDeps: {
      scratchRoot: join(dataRoot, "scratch"),
      cacheRoot: join(dataRoot, "cache"),
      resolveGitleaks: async () => ({ state: "unavailable", internalPath: null }),
      resolveOsvScanner: async () => ({ state: "unavailable", internalPath: null }),
      resolveTrivy: async () => ({ state: "unavailable", internalPath: null }),
      resolveSemgrep: async () => ({ state: "unavailable", internalPath: null }),
      resolveSemgrepRules: async () => ({ state: "unavailable", internalPath: null }),
      ...probeOverrides,
    },
  });
  holder.coordinator = coordinator;
  return { coordinator, setSelected: (value: string) => { selected = value; } };
}

function successful(result: SecurityScanToolResult) {
  if (!result.ok) throw new Error(`Security scan failed: ${result.error.code}`);
  return result;
}

function startedScanId(result: SecurityScanToolResult): string {
  const success = successful(result);
  if (success.operation !== "start") throw new Error("Expected security scan start result.");
  return success.result.scanId;
}

function start(mode: "deep_research" | "scanners_only", toolCallId: string, root: string) {
  return {
    operation: { version: "security-scan-v1" as const, operation: "start" as const, targetDirectory: ".", mode },
    trustedContext: trusted(toolCallId),
    expectedCurrentFolder: root,
  };
}

describe("D560 Desktop security research coordinator", () => {
  test("citation capture applies the same protected-path authority as the inventory", async () => {
    const root = await mkdtemp(join(tmpdir(), "scan-citation-authority-"));
    const data = await mkdtemp(join(tmpdir(), "scan-data-"));
    try {
      await writeFile(join(root, "restricted.ts"), "export const restricted = true;\n");
      const { coordinator } = await coordinatorFor(root, data, {}, (path) => !path.endsWith("/restricted.ts"));
      const scanId = startedScanId(await coordinator.dispatch(start("deep_research", "start", root)));
      expect(await coordinator.dispatch({ expectedCurrentFolder: root, trustedContext: trusted("restricted-citation"), operation: {
        version: "security-scan-v1", operation: "record", scanId, action: "append", fileCitations: [{ relativePath: "restricted.ts", startLine: 1, endLine: 1 }],
        entry: { kind: "evidence", summary: "A model-supplied citation must not override path authority", evidenceRefs: [] },
      } })).toMatchObject({ ok: false, error: { code: "evidence_not_authorized" } });
    } finally { await rm(root, { recursive: true, force: true }); await rm(data, { recursive: true, force: true }); }
  });

  test("scans only an explicit subfolder, returns readable prefixed paths, and rejects escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "scan-target-"));
    const data = await mkdtemp(join(tmpdir(), "scan-data-"));
    const outside = await mkdtemp(join(tmpdir(), "scan-outside-"));
    try {
      const repo = join(root, "repo");
      await mkdir(repo);
      await writeFile(join(repo, "auth.ts"), "export const ok = true;\n");
      await symlink(outside, join(root, "escape"));
      const scanned: string[] = [];
      const { coordinator } = await coordinatorFor(root, data, {
        resolveGitleaks: async () => ({ state: "ready", internalPath: "/managed/gitleaks" }),
        runProcess: async (request) => {
          scanned.push(request.cwd);
          const report = request.argv[request.argv.indexOf("--report-path") + 1]!;
          await writeFile(report, JSON.stringify([{ RuleID: "example", File: "auth.ts", StartLine: 1, EndLine: 1 }]));
          return { exitCode: 0, cancelled: false, timedOut: false };
        },
      });
      for (const targetDirectory of [outside, "../outside", "escape", "repo/auth.ts"]) {
        const request = start("deep_research", "rejected", root);
        request.operation.targetDirectory = targetDirectory;
        expect(await coordinator.dispatch(request)).toMatchObject({ ok: false, error: { code: "root_not_authorized" } });
      }
      expect(scanned).toEqual([]);
      const request = start("deep_research", "target", root);
      request.operation.targetDirectory = repo;
      const result = successful(await coordinator.dispatch(request));
      expect(result).toMatchObject({ operation: "start", result: { targetDirectory: "repo" } });
      expect(scanned).toEqual([await realpath(repo)]);
      const results = await coordinator.dispatch({ operation: { version: "security-scan-v1", operation: "results", scanId: startedScanId(result), category: "all" }, trustedContext: trusted("results"), expectedCurrentFolder: root });
      expect(results).toMatchObject({ ok: true, operation: "results", result: { observations: [{ relativePath: "repo/auth.ts" }] } });
      await rm(repo, { recursive: true });
      await symlink(outside, repo);
      expect(await coordinator.dispatch({ operation: { version: "security-scan-v1", operation: "status", scanId: startedScanId(result) }, trustedContext: trusted("status"), expectedCurrentFolder: root })).toMatchObject({ ok: false, error: { code: "root_revoked" } });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(data, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("rejects a stale Current Folder and keeps scanners-only completion truthful and idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-security-root-"));
    const data = await mkdtemp(join(tmpdir(), "nautilo-security-data-"));
    try {
      const { coordinator, setSelected } = await coordinatorFor(root, data);
      const request = start("scanners_only", "tool-start", root);
      setSelected(`${root}-different`);
      const denied = await coordinator.dispatch(request);
      expect(denied).toMatchObject({ ok: false, operation: "start", error: { code: "root_revoked" } });

      setSelected(root);
      const first = await coordinator.dispatch(request);
      expect(first).toMatchObject({ ok: true, operation: "start", result: { state: "partial", terminalState: "partial" } });
      const second = await coordinator.dispatch(request);
      expect(second).toEqual(first);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(data, { recursive: true, force: true });
    }
  });

  test("mints citation digests without source bytes and rejects a symlink escape", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-security-root-"));
    const data = await mkdtemp(join(tmpdir(), "nautilo-security-data-"));
    const outside = await mkdtemp(join(tmpdir(), "nautilo-security-outside-"));
    try {
      const source = Buffer.from("const secret = 'do-not-leak';\r\nexport const safe = true;\r\n", "utf8");
      await writeFile(join(root, "safe.ts"), source);
      await writeFile(join(outside, "outside.ts"), "const escaped = true;\n");
      await symlink(join(outside, "outside.ts"), join(root, "escape.ts"));
      const { coordinator } = await coordinatorFor(root, data);
      const opened = await coordinator.dispatch(start("deep_research", "tool-deep", root));
      expect(opened).toMatchObject({ ok: true, result: { state: "active", phase: "researching" } });
      const scanId = startedScanId(opened);

      const recorded = await coordinator.dispatch({
        operation: {
          version: "security-scan-v1", operation: "record", scanId: "scan_model-copy-is-ignored", action: "append",
          entry: { kind: "evidence", summary: "The local file establishes a safe data-flow boundary.", evidenceRefs: [] },
          fileCitations: [{ relativePath: "safe.ts", startLine: 1, endLine: 2 }],
        },
        trustedContext: trusted("tool-record"), expectedCurrentFolder: root,
      });
      expect(recorded).toMatchObject({ ok: true, operation: "record" });
      expect(JSON.stringify(recorded)).not.toContain("do-not-leak");
      expect(JSON.stringify(recorded)).toMatch(/[a-f0-9]{64}/);
      const acknowledgement = successful(recorded);
      if (acknowledgement.operation !== "record") throw new Error("Expected a record acknowledgement.");
      expect(acknowledgement.result.codeEvidence[0]!.rangeSha256).toBe(
        createHash("sha256").update(source).digest("hex"),
      );

      await mkdir(join(root, "mapped-directory"));
      const mappedDirectory = await coordinator.dispatch({
        operation: {
          version: "security-scan-v1", operation: "record", scanId, action: "append",
          entry: {
            kind: "repository_map",
            summary: "Directory inventory established this repository surface.",
            surfaces: [],
            evidenceRefs: [],
          },
          fileCitations: [{ relativePath: "mapped-directory", startLine: 1, endLine: 1 }],
        },
        trustedContext: trusted("tool-record-directory-map"), expectedCurrentFolder: root,
      });
      expect(mappedDirectory).toMatchObject({
        ok: true,
        operation: "record",
        result: { codeEvidence: [] },
      });

      const largePrefix = Buffer.alloc(9 * 1024 * 1024, 0x61);
      const largeTail = Buffer.from("\nexport const stillCitable = true;\n", "utf8");
      const largeSource = Buffer.concat([largePrefix, largeTail]);
      await writeFile(join(root, "large.ts"), largeSource);
      const largeRecorded = await coordinator.dispatch({
        operation: {
          version: "security-scan-v1", operation: "record", scanId, action: "append",
          entry: { kind: "evidence", summary: "Large source files remain citable without loading them as one buffer.", evidenceRefs: [] },
          fileCitations: [{ relativePath: "large.ts", startLine: 2, endLine: 2 }],
        },
        trustedContext: trusted("tool-record-large"), expectedCurrentFolder: root,
      });
      const largeAcknowledgement = successful(largeRecorded);
      if (largeAcknowledgement.operation !== "record") throw new Error("Expected a record acknowledgement.");
      expect(largeAcknowledgement.result.codeEvidence[0]).toMatchObject({
        fileSha256: createHash("sha256").update(largeSource).digest("hex"),
        rangeSha256: createHash("sha256").update(largeTail.subarray(1)).digest("hex"),
      });

      const escaped = await coordinator.dispatch({
        operation: {
          version: "security-scan-v1", operation: "record", scanId, action: "append",
          entry: { kind: "evidence", summary: "This should never be admitted.", evidenceRefs: [] },
          fileCitations: [{ relativePath: "escape.ts", startLine: 1, endLine: 1 }],
        },
        trustedContext: trusted("tool-escape"), expectedCurrentFolder: root,
      });
      expect(escaped).toMatchObject({ ok: false, operation: "record", error: { code: "evidence_not_authorized" } });

      const clampedRange = await coordinator.dispatch({
        operation: {
          version: "security-scan-v1", operation: "record", scanId, action: "append",
          entry: { kind: "evidence", summary: "This citation needs a corrected current range.", evidenceRefs: [] },
          fileCitations: [{ relativePath: "safe.ts", startLine: 2, endLine: 12 }],
        },
        trustedContext: trusted("tool-stale-range"), expectedCurrentFolder: root,
      });
      expect(clampedRange).toMatchObject({
        ok: true,
        operation: "record",
        result: {
          codeEvidence: [{ relativePath: "safe.ts", startLine: 2, endLine: 3 }],
        },
      });

      const impossibleStart = await coordinator.dispatch({
        operation: {
          version: "security-scan-v1", operation: "record", scanId, action: "append",
          entry: { kind: "evidence", summary: "A start past EOF cannot be repaired.", evidenceRefs: [] },
          fileCitations: [{ relativePath: "safe.ts", startLine: 12, endLine: 15 }],
        },
        trustedContext: trusted("tool-impossible-start"), expectedCurrentFolder: root,
      });
      expect(impossibleStart).toEqual({
        ok: false,
        operation: "record",
        error: {
          code: "evidence_not_found",
          retryable: true,
          message: "Code citation range 12-15 exceeds the file's current 3 lines. Reread the file and retry with a range within 1-3.",
        },
      });

      const finalized = await coordinator.dispatch({
        operation: {
          version: "security-scan-v1", operation: "results", scanId, category: "all", limit: 50, finalize: true,
        },
        trustedContext: trusted("tool-final-results"), expectedCurrentFolder: root,
      });
      expect(finalized).toMatchObject({ ok: false, error: { code: "research_incomplete", retryable: true } });
      expect(securityScanToolResultSchema.safeParse(finalized).success).toBe(true);
      const progress = await coordinator.dispatch({ operation: {
        version: "security-scan-v1", operation: "results", scanId, category: "all", limit: 50, finalize: false,
      }, trustedContext: trusted("tool-unfinished-results"), expectedCurrentFolder: root });
      expect(progress).toMatchObject({
        ok: true,
        operation: "results",
        result: {
          status: { state: "active", phase: "researching", terminalState: null, modelState: "running", completedSteps: 1, totalSteps: 2 },
          codeEvidence: [
            { relativePath: "safe.ts", startLine: 1, endLine: 2 },
            { relativePath: "large.ts", startLine: 2, endLine: 2 },
            { relativePath: "safe.ts", startLine: 2, endLine: 3 },
          ],
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(data, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("cancels an active deep-research ledger and the relay branch precedes sandbox construction", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-security-root-"));
    const data = await mkdtemp(join(tmpdir(), "nautilo-security-data-"));
    try {
      const { coordinator } = await coordinatorFor(root, data);
      const opened = await coordinator.dispatch(start("deep_research", "tool-deep", root));
      const scanId = startedScanId(opened);
      const cancelled = await coordinator.dispatch({
        operation: { version: "security-scan-v1", operation: "cancel", scanId },
        trustedContext: trusted("tool-cancel"), expectedCurrentFolder: root,
      });
      expect(cancelled).toMatchObject({ ok: true, operation: "cancel", result: { state: "cancelled", terminalState: "cancelled" } });
      const controller = new AbortController();
      controller.abort();
      const interrupted = await coordinator.dispatch(start("deep_research", "tool-aborted", root), controller.signal);
      expect(interrupted).toMatchObject({ ok: true, operation: "start", result: { state: "cancelled", terminalState: "cancelled", modelState: "cancelled" } });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(data, { recursive: true, force: true });
    }

    const relay = readFileSync(join(import.meta.dir, "../../electron/relay.ts"), "utf8");
    expect(relay.indexOf('if (req.toolName === "security_scan")')).toBeLessThan(relay.indexOf("let sandbox: Sandbox | null = null"));
    expect(relay).toContain("securityScanRelayRequestSchema.safeParse(req.args)");
  });
});
