import { describe, expect, test } from "bun:test";
import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { securityResearchAppendix } from "../../../../packages/agent/src/tools/security/research-appendix";
import { collectFinalizedSecurityResearch } from "../../../../packages/agent/src/tools/security/research-export";
import { parseGitleaksReport, parseSemgrepReport, parseTrivyReport } from "../../electron/security-scan/probes";
import type { NautiloState } from "../../../../packages/agent/src/agent/state";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  securityScanRecordAcknowledgementSchema,
  securityScanStatusSchema,
  securityScanHypothesisStatusPreview,
  type SecurityScanFileCitationInput,
  type SecurityScanRecordInput,
  type SecurityScanTrustedContext,
} from "@nautilo/types";

import {
  DesktopSecurityScanLedger,
  SecurityScanLedgerError,
  type SecurityScanLedgerRootIdentity,
} from "../../electron/security-scan/ledger";

const ROOT: SecurityScanLedgerRootIdentity = {
  fingerprint: "a".repeat(64),
  device: "device-1",
  inode: "inode-1",
  gitHead: "b".repeat(40),
  gitDirty: false,
};

const TASK_ID = "00000000-0000-4000-8000-000000000001";

function trusted(
  toolCallId: string,
  taskRunId = "00000000-0000-4000-8000-000000000002",
  taskId = TASK_ID,
): SecurityScanTrustedContext {
  return {
    taskId,
    taskRunId,
    toolCallId,
    modelId: "fireworks:accounts/fireworks/models/eligible-model",
  };
}

function createLedger(userDataRoot: string, liveRoot = ROOT, sourceHash: (path: string) => string = () => "c".repeat(64)) {
  return new DesktopSecurityScanLedger({
    userDataRoot,
    rootIdentityReader: { async revalidate() { return liveRoot; } },
    citationReader: {
      async revalidateAndHash(citation: SecurityScanFileCitationInput) {
        return {
          sourceVersion: "f".repeat(64),
          relativePath: citation.relativePath,
          startLine: citation.startLine,
          endLine: citation.endLine,
          fileSha256: sourceHash(citation.relativePath),
          rangeSha256: "d".repeat(64),
          rootFingerprint: liveRoot.fingerprint,
          gitHead: liveRoot.gitHead ?? null,
          gitDirty: liveRoot.gitDirty ?? null,
        };
      },
    },
    now: () => new Date("2026-08-27T12:00:00.000Z"),
  });
}

async function createDeepLedger(root: string) {
  const ledger = createLedger(root);
  await ledger.create({ scanId: "scan_demo-1", mode: "deep_research", trusted: trusted("tool-create"), localOwnerId: "owner-1", rootIdentity: ROOT });
  return ledger;
}

describe("D560 Desktop security research ledger", () => {
  test.each(["worker.ts", "node_modules/policy/guard.ts"])("rechecks cross-file conclusions for %s while preserving unreferenced historical notes", async (guardPath) => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-security-freshness-"));
    try {
      const hashes = new Map<string, string>();
      const reads = new Map<string, number>();
      const ledger = createLedger(root, ROOT, (path) => {
        reads.set(path, (reads.get(path) ?? 0) + 1);
        return hashes.get(path) ?? "c".repeat(64);
      });
      const access = { scanId: "scan_freshness", localOwnerId: "owner-1", rootIdentity: ROOT };
      await ledger.create({ ...access, mode: "deep_research", trusted: trusted("create") });
      const append = (id: string, entry: SecurityScanRecordInput, paths: string[] = []) => ledger.appendOrUpdate({
        ...access, trusted: trusted(id), operation: { version: "security-scan-v1", operation: "record", scanId: access.scanId,
          action: "append", entry, fileCitations: paths.map((relativePath) => ({ relativePath, startLine: 1, endLine: 1 })) },
      });
      const old = await append("old-notes", { kind: "evidence", summary: "Historical cross-file guard inspection", evidenceRefs: [] }, ["api.ts", guardPath]);
      const primary = { kind: "code_evidence" as const, id: old.codeEvidence[0]!.id };
      const stale = { kind: "code_evidence" as const, id: old.codeEvidence[1]!.id };
      const support = await append("old-counter", { kind: "counterevidence", summary: "Guard membership check prevented the request", evidenceRefs: [stale] });
      const hypothesis = await append("conclusion", { kind: "hypothesis", summary: "API authorization cannot be bypassed", state: "rejected",
        evidenceRefs: [primary], counterevidenceRefs: [{ kind: "ledger_record", id: support.record.id }] });
      hashes.set(guardPath, "e".repeat(64));
      const fresh = await append("fresh-guard", { kind: "evidence", summary: "The changed guard has now been inspected", evidenceRefs: [] }, [guardPath]);
      const files = guardPath.startsWith("node_modules/") ? ["api.ts"] : ["api.ts", guardPath];
      await ledger.updateInventory({ ...access, trusted: trusted("inventory"), inventory: files.map((relativePath, index) => ({
        id: `inventory_${index}`, relativePath, kind: "file", sizeBytes: 42, sourceVersion: "f".repeat(64), reason: null,
      })) });
      const conclusion = { kind: "ledger_record" as const, id: hypothesis.record.id };
      await append("coverage", { kind: "coverage", surfaceKey: "api", state: "reviewed", rationale: "Request and guard behavior inspected", evidenceRefs: [conclusion] });
      await append("unit", { kind: "review_unit", surfaceKey: "api", summary: "API and guard behavior", paths: files, state: "reviewed",
        trace: "Request flows into the guard before output", notes: "Compared denial and permitted requests", openRecordIds: [],
        evidenceRefs: [conclusion, { kind: "code_evidence", id: fresh.codeEvidence[0]!.id }], counterevidenceRefs: [primary] });
      const failure = await ledger.finalize({ ...access, trusted: trusted("stale-finalize") }).then(() => null, (error: unknown) => error);
      if (!(failure instanceof SecurityScanLedgerError)) throw new Error("Expected source freshness to block finalization");
      expect(failure.code).toBe("research_incomplete");
      expect(failure.continuation).toContain(stale.id);
      expect((await ledger.status({ ...access, trusted: trusted("still-active") })).state).toBe("active");
      await ledger.appendOrUpdate({ ...access, trusted: trusted("repair-conclusion"), operation: {
        version: "security-scan-v1", operation: "record", scanId: access.scanId, action: "update", recordId: hypothesis.record.id,
        expectedRevision: 1, entry: { kind: "hypothesis", counterevidenceRefs: [{ kind: "code_evidence", id: fresh.codeEvidence[0]!.id }] }, fileCitations: [],
      } });
      reads.clear();
      await ledger.finalize({ ...access, trusted: trusted("fresh-finalize") });
      expect(reads.get("api.ts")).toBe(1);
      expect(reads.get(guardPath)).toBe(1);
      const historical = await ledger.results({ ...access, trusted: trusted("historical"), operation: {
        version: "security-scan-v1", operation: "results", scanId: access.scanId, category: "research", recordIds: [support.record.id], limit: 50,
      } });
      expect(historical.records[0]?.entry.evidenceRefs).toContainEqual(stale);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("persists one private atomic ledger and mints cited code evidence without source bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-security-ledger-"));
    try {
      const ledger = await createDeepLedger(root);
      expect(await ledger.scanIdForTaskRun({
        trusted: trusted("tool-bind"),
        localOwnerId: "owner-1",
        rootIdentity: ROOT,
      })).toBe("scan_demo-1");
      const result = await ledger.appendOrUpdate({
        trusted: trusted("tool-record"),
        localOwnerId: "owner-1",
        rootIdentity: ROOT,
        operation: {
          version: "security-scan-v1",
          operation: "record",
          scanId: "scan_demo-1",
          action: "append",
          entry: {
            kind: "evidence",
            summary: "The cited range establishes the current data flow.",
            evidenceRefs: [],
          },
          fileCitations: [{ relativePath: "src/(auth)/policy ü.ts", startLine: 7, endLine: 11 }],
        },
      });
      expect(result.record.revision).toBe(1);
      expect(result.codeEvidence).toHaveLength(1);
      expect(result.record.entry.evidenceRefs).toContainEqual({ kind: "code_evidence", id: result.codeEvidence[0]!.id });

      const status = await ledger.status({ scanId: "scan_demo-1", trusted: trusted("tool-read"), localOwnerId: "owner-1", rootIdentity: ROOT });
      expect(status.modelId).toContain("fireworks:");
      const page = await ledger.results({
        trusted: trusted("tool-results"),
        localOwnerId: "owner-1",
        rootIdentity: ROOT,
        operation: { version: "security-scan-v1", operation: "results", scanId: "scan_demo-1", category: "all", limit: 50 },
      });
      expect(page.codeEvidence).toHaveLength(1);
      expect(page.records).toHaveLength(1);
      expect(page.reportReady).toBe(false);
      const access = { scanId: "scan_demo-1", localOwnerId: "owner-1", rootIdentity: ROOT };
      await ledger.appendOrUpdate({ ...access, trusted: trusted("map"), operation: {
        version: "security-scan-v1", operation: "record", scanId: "scan_demo-1", action: "append",
        entry: { kind: "repository_map", summary: "Reviewed the authentication boundary.", evidenceRefs: [],
          surfaces: [{ key: "auth", label: "Auth", coverage: "reviewed", rationale: "Cited source reviewed." }] },
        fileCitations: [],
      } });
      expect(ledger.finalize({ ...access, trusted: trusted("premature-finalize") })).rejects.toMatchObject({ code: "research_incomplete" });
      expect((await ledger.status({ ...access, trusted: trusted("still-active") })).state).toBe("active");
      const hypothesis = await ledger.appendOrUpdate({ ...access, trusted: trusted("hypothesis"), operation: {
        version: "security-scan-v1", operation: "record", scanId: "scan_demo-1", action: "append",
        entry: { kind: "hypothesis", summary: "The local identity consumer protects the inspected authority boundary.", state: "rejected",
          evidenceRefs: [{ kind: "code_evidence", id: result.codeEvidence[0]!.id }],
          counterevidenceRefs: [{ kind: "code_evidence", id: result.codeEvidence[0]!.id }] }, fileCitations: [],
      } });
      await ledger.appendOrUpdate({ ...access, trusted: trusted("coverage"), operation: {
        version: "security-scan-v1", operation: "record", scanId: "scan_demo-1", action: "append",
        entry: { kind: "coverage", surfaceKey: "auth", state: "limited", rationale: "Reviewed the local identity consumer; external issuer is absent.",
          blocker: "The identity issuer implementation is external to this repository.",
          evidenceRefs: [{ kind: "ledger_record", id: hypothesis.record.id }] }, fileCitations: [],
      } });
      await ledger.updateInventory({ ...access, trusted: trusted("inventory"), inventory: [{
        id: "inventory_policy", relativePath: "src/(auth)/policy ü.ts", kind: "file", sizeBytes: 42,
        sourceVersion: "f".repeat(64), reason: null,
      }] });
      await ledger.appendOrUpdate({ ...access, trusted: trusted("unit"), operation: {
        version: "security-scan-v1", operation: "record", scanId: "scan_demo-1", action: "append",
        entry: { kind: "review_unit", surfaceKey: "auth", summary: "Local identity consumer",
          paths: ["src/(auth)/policy ü.ts"], state: "reviewed", trace: "Identity input reaches the checked local consumer.",
          notes: "The local guard was inspected; the external issuer is a retained deployment assumption.",
          evidenceRefs: [{ kind: "ledger_record", id: hypothesis.record.id }],
          counterevidenceRefs: [{ kind: "code_evidence", id: result.codeEvidence[0]!.id }], openRecordIds: [] }, fileCitations: [],
      } });
      await ledger.finalize({ ...access, trusted: trusted("finalize") });
      let finalPage = await ledger.results({ ...access, trusted: trusted("final-results"), operation: {
        version: "security-scan-v1", operation: "results", scanId: "scan_demo-1", category: "all", finalize: true, limit: 1,
      } });
      expect(finalPage.reportReady).toBe(false);
      const sealedSnapshot = finalPage.exportSnapshot;
      const sealedFirstPage = finalPage;
      expect(sealedSnapshot?.itemCount).toBeGreaterThan(1);
      while (finalPage.nextCursor !== null) {
        finalPage = await ledger.results({ ...access, trusted: trusted("next-page"), operation: {
          version: "security-scan-v1", operation: "results", scanId: "scan_demo-1", category: "all", finalize: true, limit: 1,
          cursor: finalPage.nextCursor,
        } });
      }
      expect(finalPage.codeEvidence).toHaveLength(0);
      expect(finalPage.reportReady).toBe(true);
      expect(finalPage.status.state).toBe("partial");
      expect(finalPage.exportSnapshot).toEqual(sealedSnapshot);
      // Artifact export is read-only: it must expose the identical immutable
      // selection without invoking finalize again or requiring model paging.
      const exportedItems: Array<{ id: string }> = [];
      let exportCursor: string | undefined;
      do {
        const exported = await ledger.results({ ...access, trusted: trusted("runtime-export"), operation: {
          version: "security-scan-v1", operation: "results", scanId: "scan_demo-1", category: "all", finalize: false, limit: 1,
          ...(exportCursor === undefined ? {} : { cursor: exportCursor }),
        } });
        expect(exported.reportReady).toBe(false);
        expect(exported.exportSnapshot).toEqual(sealedSnapshot);
        exportedItems.push(...exported.records, ...exported.codeEvidence, ...exported.observations, ...(exported.inventory ?? []));
        exportCursor = exported.nextCursor ?? undefined;
      } while (exportCursor !== undefined);
      expect(exportedItems).toHaveLength(sealedSnapshot!.itemCount);
      const exportDigest = createHash("sha256");
      for (const item of exportedItems.sort((a, b) => a.id.localeCompare(b.id))) {
        exportDigest.update(item.id).update("\0").update(JSON.stringify(item)).update("\0");
      }
      expect(exportDigest.digest("hex")).toBe(sealedSnapshot!.sha256);
      const exportState = { currentTaskId: TASK_ID, currentTaskRunId: trusted("export").taskRunId,
        userId: "owner-1", model: trusted("export").modelId, subagentRun: true, toolWhitelist: ["security_scan"],
        messages: [new AIMessage({ content: "Seal reviewed research.", tool_calls: [{ id: "seal-export", name: "security_scan",
          args: { operation: "results", category: "all", finalize: true } }] }),
        new ToolMessage({ name: "security_scan", tool_call_id: "seal-export", content: JSON.stringify({ ok: true, operation: "results", result: sealedFirstPage }) })],
      } as unknown as NautiloState;
      const runtimeExport = await collectFinalizedSecurityResearch(exportState, { threadId: "export-thread", taskId: TASK_ID,
        taskRunId: trusted("export").taskRunId, userId: "owner-1", modelId: trusted("export").modelId }, async (cursor) => ({
        ok: true, operation: "results", result: await ledger.results({ ...access, trusted: trusted("artifact-export"), operation: {
          version: "security-scan-v1", operation: "results", scanId: "scan_demo-1", category: "all", finalize: false, limit: 1,
          ...(cursor === undefined ? {} : { cursor }),
        } }),
      }));
      expect(runtimeExport.reportState).toBe("partial");
      expect(runtimeExport.researchAppendix).toContain("src/(auth)/policy ü.ts");
      expect(exportState.messages).toHaveLength(2);
      expect((await ledger.results({ ...access, trusted: trusted("filtered"), operation: {
        version: "security-scan-v1", operation: "results", scanId: "scan_demo-1", category: "observations", finalize: true, limit: 50,
      } })).reportReady).toBe(false);


      const file = join(root, "security-research", "v1", "scan_demo-1", "ledger.json");
      const bytes = await readFile(file, "utf8");
      expect(bytes).not.toContain("/private/");
      expect(bytes).not.toContain("source excerpt");
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(join(root, "security-research"))).mode & 0o777).toBe(0o700);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("uses durable operation receipts and revision checks rather than replaying a model mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-security-ledger-"));
    try {
      const ledger = await createDeepLedger(root);
      const input = {
        trusted: trusted("tool-record"), localOwnerId: "owner-1", rootIdentity: ROOT,
        operation: {
          version: "security-scan-v1" as const, operation: "record" as const, scanId: "scan_demo-1",
          action: "append" as const,
          entry: { kind: "open_question" as const, question: "Does every caller sanitize input?", evidenceRefs: [] },
          fileCitations: [],
        },
      };
      const first = await ledger.appendOrUpdate(input);
      // A lost reply followed by process recreation must reuse the persisted receipt.
      const retry = await createLedger(root).appendOrUpdate(input);
      expect(retry.record.id).toBe(first.record.id);
      expect(ledger.appendOrUpdate({
        ...input,
        trusted: trusted("tool-update"),
        operation: {
          ...input.operation,
          action: "update",
          recordId: first.record.id,
          expectedRevision: first.record.revision + 1,
        },
      })).rejects.toMatchObject({ code: "record_conflict" });
      expect(ledger.appendOrUpdate({
        ...input,
        trusted: trusted("tool-self-reference"),
        operation: {
          ...input.operation,
          action: "update",
          recordId: first.record.id,
          expectedRevision: first.record.revision,
          entry: {
            kind: "open_question",
            question: "Can a ledger entry prove itself?",
            evidenceRefs: [{ kind: "ledger_record", id: first.record.id }],
          },
        },
      })).rejects.toMatchObject({ code: "record_conflict" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("merges a model update patch into the server-owned record before validation", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-security-ledger-"));
    try {
      const ledger = await createDeepLedger(root);
      const created = await ledger.appendOrUpdate({
        trusted: trusted("tool-patch-source"), localOwnerId: "owner-1", rootIdentity: ROOT,
        operation: {
          version: "security-scan-v1", operation: "record", scanId: "scan_demo-1",
          action: "append",
          entry: {
            kind: "hypothesis",
            summary: "The authorization boundary may be missing.",
            state: "investigating",
            evidenceRefs: [],
            counterevidenceRefs: [],
          },
          fileCitations: [],
        },
      });
      const updated = await ledger.appendOrUpdate({
        trusted: trusted("tool-patch-update"), localOwnerId: "owner-1", rootIdentity: ROOT,
        operation: {
          version: "security-scan-v1", operation: "record", scanId: "scan_demo-1",
          action: "update",
          recordId: created.record.id,
          expectedRevision: created.record.revision,
          entry: { kind: "hypothesis", state: "unresolved" },
          fileCitations: [],
        },
      });
      expect(updated.record).toMatchObject({
        revision: 2,
        entry: {
          kind: "hypothesis",
          summary: "The authorization boundary may be missing.",
          state: "unresolved",
          evidenceRefs: [],
          counterevidenceRefs: [],
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("drops invented references from advisory research records without weakening conclusions", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-security-ledger-"));
    try {
      const ledger = await createDeepLedger(root);
      const hypothesis = await ledger.appendOrUpdate({
        trusted: trusted("tool-advisory-reference"), localOwnerId: "owner-1", rootIdentity: ROOT,
        operation: {
          version: "security-scan-v1", operation: "record", scanId: "scan_demo-1", action: "append",
          entry: {
            kind: "hypothesis",
            summary: "The job route may omit its document authorization check.",
            state: "supported",
            evidenceRefs: [{ kind: "code_evidence", id: "services_ai_jobs_route" }],
            counterevidenceRefs: [],
          },
          fileCitations: [],
        },
      });
      expect(hypothesis.record.entry).toMatchObject({
        kind: "hypothesis",
        state: "investigating",
        evidenceRefs: [],
        counterevidenceRefs: [],
      });
      expect(ledger.appendOrUpdate({
        trusted: trusted("tool-conclusion-reference"), localOwnerId: "owner-1", rootIdentity: ROOT,
        operation: {
          version: "security-scan-v1", operation: "record", scanId: "scan_demo-1", action: "append",
          entry: {
            kind: "evidence",
            summary: "This conclusion must not accept an invented reference.",
            evidenceRefs: [{ kind: "code_evidence", id: "services_ai_jobs_route" }],
          },
          fileCitations: [],
        },
      })).rejects.toMatchObject({ code: "evidence_not_found" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps scanner-only status model-free even when its Task has a model for provenance", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-security-ledger-"));
    try {
      const ledger = createLedger(root);
      const task = trusted("tool-create-scanners");
      const created = await ledger.create({ scanId: "scan_scanners-1", mode: "scanners_only", trusted: task, localOwnerId: "owner-1", rootIdentity: ROOT });
      expect(created).toMatchObject({ modelId: null, modelState: "disabled" });
      expect(ledger.status({ scanId: "scan_scanners-1", trusted: task, localOwnerId: "owner-2", rootIdentity: ROOT })).rejects.toBeInstanceOf(SecurityScanLedgerError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects fabricated evidence and only reopens a terminal scan through a new authorized lineage", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-security-ledger-"));
    try {
      const ledger = await createDeepLedger(root);
      expect(ledger.appendOrUpdate({
        trusted: trusted("tool-fabricated"), localOwnerId: "owner-1", rootIdentity: ROOT,
        operation: {
          version: "security-scan-v1", operation: "record", scanId: "scan_demo-1", action: "append",
          entry: {
            kind: "evidence", summary: "This must not accept an invented reference.",
            evidenceRefs: [{ kind: "code_evidence", id: "evidence_not-in-this-ledger" }],
          },
          fileCitations: [],
        },
      })).rejects.toMatchObject({ code: "evidence_not_found" });

      await ledger.cancel({ scanId: "scan_demo-1", trusted: trusted("tool-cancel"), localOwnerId: "owner-1", rootIdentity: ROOT });
      expect(ledger.appendObservation({
        scanId: "scan_demo-1", observation: {
          id: "observation_after-terminal", probe: "gitleaks", sourceScope: "current_tree", ruleId: null, advisoryId: null,
          packageName: null, relativePath: null, startLine: null, endLine: null,
          severity: "unknown", summary: "This observation must not be written after cancellation.", secretRedacted: false,
        },
        trusted: trusted("tool-after-terminal"), localOwnerId: "owner-1", rootIdentity: ROOT,
      })).rejects.toMatchObject({ code: "scan_not_active" });
      const cancelled = await ledger.status({
        scanId: "scan_demo-1", trusted: trusted("tool-read-cancelled"), localOwnerId: "owner-1", rootIdentity: ROOT,
      });
      expect(ledger.updateStatus({
        status: { ...cancelled, state: "active", phase: "admitting", terminalState: null, modelState: "pending" },
        trusted: trusted("tool-resurrect"), localOwnerId: "owner-1", rootIdentity: ROOT,
      })).rejects.toMatchObject({ code: "scan_not_active" });

      const continuation = trusted(
        "tool-reopen",
        "00000000-0000-4000-8000-000000000012",
        "00000000-0000-4000-8000-000000000011",
      );
      const reopened = await ledger.reopen({ scanId: "scan_demo-1", trusted: continuation, localOwnerId: "owner-1", rootIdentity: ROOT });
      expect(reopened).toMatchObject({ state: "active", terminalState: null });
      expect(ledger.status({
        scanId: "scan_demo-1", trusted: trusted(
          "tool-unknown-task",
          "00000000-0000-4000-8000-000000000022",
          "00000000-0000-4000-8000-000000000021",
        ), localOwnerId: "owner-1", rootIdentity: ROOT,
      })).rejects.toMatchObject({ code: "scan_not_active" });
      expect(ledger.status({ scanId: "scan_demo-1", trusted: continuation, localOwnerId: "owner-1", rootIdentity: ROOT })).resolves.toMatchObject({ state: "active" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses to adopt a pre-existing unmarked storage root", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-security-ledger-"));
    try {
      const unowned = join(root, "security-research");
      await mkdir(unowned, { recursive: true, mode: 0o700 });
      await writeFile(join(unowned, "foreign.json"), "{}", { mode: 0o600 });
      const ledger = createLedger(root);
      expect(ledger.create({ scanId: "scan_unowned-1", mode: "deep_research", trusted: trusted("tool-unowned"), localOwnerId: "owner-1", rootIdentity: ROOT })).rejects.toMatchObject({ code: "artifact_corrupt" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a corrupt persisted ledger regardless of its size", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-security-ledger-"));
    try {
      const ledger = await createDeepLedger(root);
      const file = join(root, "security-research", "v1", "scan_demo-1", "ledger.json");
      await writeFile(file, "x".repeat(4 * 1024 * 1024 + 1), { mode: 0o600 });
      await chmod(file, 0o600);
      expect(ledger.status({ scanId: "scan_demo-1", trusted: trusted("tool-read-large"), localOwnerId: "owner-1", rootIdentity: ROOT })).rejects.toMatchObject({ code: "artifact_corrupt" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});


test("record receipts expose section, hypothesis and scanner repairs before finalization", async () => {
  const root = await mkdtemp(join(tmpdir(), "nautilo-next-research-work-"));
  try {
    const ledger = await createDeepLedger(root);
    const access = { scanId: "scan_demo-1", localOwnerId: "owner-1", rootIdentity: ROOT };
    const append = (id: string, entry: SecurityScanRecordInput, fileCitations: SecurityScanFileCitationInput[] = []) =>
      ledger.appendOrUpdate({ ...access, trusted: trusted(id), operation: {
        version: "security-scan-v1", operation: "record", scanId: access.scanId, action: "append", entry, fileCitations,
      } });
    const status = async () => securityScanStatusSchema.parse(await createLedger(root).status({ ...access, trusted: trusted("restarted-status") }));
    await ledger.updateInventory({ ...access, trusted: trusted("inventory"), inventory: [{
      id: "inventory_router", relativePath: "src/router.ts", kind: "file", sizeBytes: 42, sourceVersion: "f".repeat(64), reason: null,
    }] });
    expect((await status()).researchProgress?.nextResearchWork).toContain("Record the requested repository sections");
    await append("map", { kind: "repository_map", summary: "HTTP authorization", surfaces: [{
      key: "http_router", label: "HTTP router", coverage: "unreviewed", rationale: "Trace request membership before private output.",
    }], evidenceRefs: [] });
    const hypothesis = await append("hypothesis", { kind: "hypothesis", state: "rejected",
      summary: "Current membership prevents outsider output.", evidenceRefs: [], counterevidenceRefs: [],
    }, [{ relativePath: "src/router.ts", startLine: 1, endLine: 4 }]);
    const source = { kind: "code_evidence" as const, id: hypothesis.codeEvidence[0]!.id };
    const hypothesisRef = { kind: "ledger_record" as const, id: hypothesis.record.id };
    await append("coverage", { kind: "coverage", surfaceKey: "http_router", state: "reviewed",
      rationale: "Membership precedes private output.", evidenceRefs: [hypothesisRef] });
    await ledger.appendObservations({ ...access, trusted: trusted("observations"), observations: [{
      id: "observation_router", probe: "semgrep", sourceScope: "current_tree", ruleId: "test-rule", advisoryId: null,
      packageName: null, relativePath: "src/router.ts", startLine: 1, endLine: 4, severity: "high",
      summary: "Synthetic route lead", secretRedacted: true,
    }] });
    const pending = securityScanRecordAcknowledgementSchema.parse(await append("unit", {
      kind: "review_unit", surfaceKey: "http", summary: "Membership output", paths: ["src/router.ts"], state: "in_progress",
      trace: "Request identity reaches the current membership check before output.", notes: "Compared denied outsider and permitted member branches.",
      evidenceRefs: [hypothesisRef], counterevidenceRefs: [source], openRecordIds: [],
    }));
    expect(pending.researchProgress?.nextResearchWork).toContain(`Review unit ${pending.record.id} (revision 1): accessible review work remains (in_progress)`);
    expect((await status()).researchProgress?.nextResearchWork).toBe(pending.researchProgress?.nextResearchWork);
    const reviewed = securityScanRecordAcknowledgementSchema.parse(await ledger.appendOrUpdate({ ...access, trusted: trusted("review-unit"), operation: {
      version: "security-scan-v1", operation: "record", scanId: access.scanId, action: "update", recordId: pending.record.id, expectedRevision: 1,
      entry: { kind: "review_unit", state: "reviewed" }, fileCitations: [],
    } }));
    // Reproduce the live mismatch: all units count complete, but the reviewed
    // unit belongs to http while the requested coverage section is http_router.
    expect(reviewed.researchProgress).toMatchObject({ unitsCompleted: 1, unitsPending: 0,
      nextResearchWork: "Section http_router: complete concrete review units for this section before marking its coverage reviewed." });
    expect((await status()).researchProgress?.nextResearchWork).toBe(reviewed.researchProgress?.nextResearchWork);
    const scoped = securityScanRecordAcknowledgementSchema.parse(await ledger.appendOrUpdate({ ...access, trusted: trusted("repair-section"), operation: {
      version: "security-scan-v1", operation: "record", scanId: access.scanId, action: "update", recordId: pending.record.id, expectedRevision: 2,
      entry: { kind: "review_unit", surfaceKey: "http_router" }, fileCitations: [],
    } }));
    expect(scoped.researchProgress?.nextResearchWork).toContain("Scanner observation observation_router");
    const supported = securityScanRecordAcknowledgementSchema.parse(await ledger.appendOrUpdate({ ...access, trusted: trusted("repair-hypothesis"), operation: {
      version: "security-scan-v1", operation: "record", scanId: access.scanId, action: "update", recordId: hypothesis.record.id, expectedRevision: 1,
      entry: { kind: "hypothesis", counterevidenceRefs: [source] }, fileCitations: [],
    } }));
    expect(supported.researchProgress?.nextResearchWork).toContain("Scanner observation observation_router has no exact recorded disposition");
    const repaired = securityScanRecordAcknowledgementSchema.parse(await append("triage", {
      kind: "dismissal", summary: "The inspected current membership guard rejects outsiders before output.",
      evidenceRefs: [source, { kind: "scanner_observation", id: "observation_router" }], counterevidenceRefs: [source],
    }));
    expect(repaired.researchProgress?.nextResearchWork).toBeNull();
    const after = await status();
    expect(after.researchProgress?.nextResearchWork).toBeNull();
    expect(after.state).toBe("active"); // No finalize call, source freshness check or report export occurred.
    const legacy = { ...after.researchProgress };
    delete legacy.nextResearchWork;
    expect(securityScanStatusSchema.safeParse({ ...after, researchProgress: legacy }).success).toBe(true);
    expect(securityScanRecordAcknowledgementSchema.safeParse({ ...repaired, researchProgress: legacy }).success).toBe(true);
    expect(securityScanStatusSchema.safeParse({ ...after, researchProgress: { ...legacy, nextResearchWork: 42 } }).success).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("atomic observation batches retry exactly and reject conflicting or foreign batches", async () => {
  const root = await mkdtemp(join(tmpdir(), "nautilo-security-batch-"));
  try {
    const ledger = await createDeepLedger(root);
    const observation = { id: "observation_batch_1", probe: "gitleaks" as const, sourceScope: "current_tree" as const,
      ruleId: "test", advisoryId: null, packageName: null, relativePath: "src/a.ts", startLine: 1, endLine: 1,
      severity: "high" as const, summary: "Redacted test observation", secretRedacted: true };
    const batch = { scanId: "scan_demo-1", observations: [observation], trusted: trusted("batch"),
      localOwnerId: "owner-1", rootIdentity: ROOT };
    await ledger.appendObservations(batch);
    await ledger.appendObservations(batch);
    expect(ledger.appendObservations({ ...batch, observations: [{ ...observation, summary: "changed" }] })).rejects.toThrow();
    expect(ledger.appendObservations({ ...batch, trusted: trusted("foreign", "00000000-0000-4000-8000-000000000003") })).rejects.toThrow();
    const page = await ledger.results({ ...batch, trusted: trusted("read-batch"), operation: {
      version: "security-scan-v1", operation: "results", scanId: "scan_demo-1", category: "all", limit: 50,
    } });
    expect(page.observations).toEqual([{ ...observation, historyOnlyPath: null }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.each(["explicit", "derived", "linked"])("current evidence decisions survive later maps and resolved checkpoint references (%s)", async (coverageMode) => {
  const root = await mkdtemp(join(tmpdir(), "nautilo-security-completion-"));
  try {
    const ledger = await createDeepLedger(root);
    const access = { scanId: "scan_demo-1", localOwnerId: "owner-1", rootIdentity: ROOT };
    const append = (id: string, entry: SecurityScanRecordInput) => ledger.appendOrUpdate({ ...access, trusted: trusted(id), operation: {
      version: "security-scan-v1", operation: "record", scanId: "scan_demo-1", action: "append", entry,
      fileCitations: [{ relativePath: "src/policy.ts", startLine: 1, endLine: 4 }],
    } });
    const evidence = await append("source", { kind: "evidence", summary: "Inspected current membership guard and output.", evidenceRefs: [] });
    const codeRefs = [{ kind: "code_evidence" as const, id: evidence.codeEvidence[0]!.id }];
    const hypothesis = await append("hyp", { kind: "hypothesis", state: "investigating", summary: "Can an outsider receive private output?", evidenceRefs: codeRefs, counterevidenceRefs: codeRefs });
    const checkpoint = await append("cp", { kind: "checkpoint", summary: "Investigating membership.", nextWork: "Resolve the hypothesis.", openRecordIds: [hypothesis.record.id], evidenceRefs: [] });
    await append("newer-cp", { kind: "checkpoint", summary: "Temporary follow-up inventory.", nextWork: "Classify the follow-up.", openRecordIds: [evidence.record.id], evidenceRefs: [] });
    await ledger.appendOrUpdate({ ...access, trusted: trusted("resolve-hyp"), operation: {
      version: "security-scan-v1", operation: "record", scanId: "scan_demo-1", action: "update", recordId: hypothesis.record.id, expectedRevision: 1,
      entry: { kind: "hypothesis", state: "rejected" }, fileCitations: [],
    } });
    if (coverageMode === "explicit") await append("coverage", { kind: "coverage", surfaceKey: "identity", state: "reviewed", rationale: "Traced identity through storage to guarded output.", evidenceRefs: [{ kind: "ledger_record", id: hypothesis.record.id }] });
    await ledger.updateInventory({ ...access, trusted: trusted("inventory"), inventory: [{
      id: "inventory_policy", relativePath: "src/policy.ts", kind: "file", sizeBytes: 42, sourceVersion: "f".repeat(64), reason: null,
    }] });
    const unit = await append("unit", { kind: "review_unit", surfaceKey: "identity", summary: "Membership output",
      paths: ["src/policy.ts"], state: "reviewed", trace: "Identity reaches membership guard before private output.",
      notes: "An outsider is rejected by the live membership branch.",
      evidenceRefs: [{ kind: "ledger_record", id: hypothesis.record.id }], counterevidenceRefs: codeRefs, openRecordIds: [hypothesis.record.id] });
    // Repeated discovery must not turn an already evidenced section back into an unreviewed label.
    await append("late-map", { kind: "repository_map", summary: "Identity section", surfaces: [{ key: "identity", label: "Identity", coverage: "unreviewed", rationale: "Mapped authority boundary" }], evidenceRefs: [] });
    if (coverageMode === "linked") {
      await append("original-map", { kind: "repository_map", summary: "Original broader section", surfaces: [{ key: "original_identity", label: "Original identity", coverage: "unreviewed", rationale: "Scope covered by the completed focused unit" }], evidenceRefs: [] });
      await append("section-link", { kind: "coverage", surfaceKey: "original_identity", state: "reviewed", rationale: "The focused unit covers this original section.", evidenceRefs: [{ kind: "ledger_record", id: unit.record.id }] });
      await append("rediscovered-map", { kind: "repository_map", summary: "Repeated map", surfaces: [{ key: "original_identity", label: "Original identity", coverage: "unreviewed", rationale: "Rediscovered label" }], evidenceRefs: [] });
      const restored = await createLedger(root).status({ ...access, trusted: trusted("restored-linked-status") });
      expect(restored.coverage.find((section) => section.surfaceKey === "original_identity")?.state).toBe("reviewed");
      expect(restored.researchProgress).toMatchObject({ unitsCompleted: 1, unitsPending: 0, nextResearchWork: null });
      const savedUnit = await createLedger(root).results({ ...access, trusted: trusted("restored-unit"), operation: { version: "security-scan-v1", operation: "results", scanId: access.scanId, category: "research", recordIds: [unit.record.id] } });
      expect(savedUnit.records[0]).toEqual(unit.record);
    }
    // Every accepted operation uses the same fixed timestamp in this fixture.
    const updated = await ledger.appendOrUpdate({ ...access, trusted: trusted("update-older-checkpoint"), operation: {
      version: "security-scan-v1", operation: "record", scanId: "scan_demo-1", action: "update", recordId: checkpoint.record.id, expectedRevision: 1,
      entry: { kind: "checkpoint", summary: "Membership review complete.", nextWork: "Write the report.", openRecordIds: [] }, fileCitations: [],
    } });
    expect(updated.researchProgress?.latestCheckpoint?.id).toBe(checkpoint.record.id);
    expect((await createLedger(root).status({ ...access, trusted: trusted("restart-status") })).researchProgress?.latestCheckpoint?.nextWork).toBe("Write the report.");
    const live = await ledger.status({ ...access, trusted: trusted("live") });
    expect(live).toMatchObject({ state: "active", terminalState: null });
    expect(live.coverage[0]?.state).toBe("reviewed");
    await ledger.updateStatus({ ...access, trusted: trusted("probes-finished"), status: { ...live, phase: "researching", lanes: live.lanes.map((lane) => ({ ...lane, state: "completed", error: null })) } });
    expect((await ledger.finalize({ ...access, trusted: trusted("final") })).state).toBe("completed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("inventory pages, exact-note recovery and source changes remain accountable across persistence", async () => {
  const root = await mkdtemp(join(tmpdir(), "nautilo-security-accountability-"));
  try {
    const ledger = await createDeepLedger(root);
    const access = { scanId: "scan_demo-1", localOwnerId: "owner-1", rootIdentity: ROOT };
    expect((await ledger.status({ ...access, trusted: trusted("legacy-status") })).researchProgress?.inventoryState).toBe("legacy");
    const inventory = ["api.ts", "worker.ts"].map((relativePath, index) => ({ id: `inventory_${index}`, relativePath, kind: "file" as const, sizeBytes: 42, sourceVersion: "f".repeat(64), reason: null }));
    await ledger.updateInventory({ ...access, trusted: trusted("inventory"), inventory });
    let page = await ledger.results({ ...access, trusted: trusted("inventory-page"), operation: {
      version: "security-scan-v1", operation: "results", scanId: access.scanId, category: "inventory", limit: 1,
    } });
    expect(page.inventory).toHaveLength(1);
    expect(page.records).toHaveLength(0);
    expect(page.nextCursor).not.toBeNull();
    page = await ledger.results({ ...access, trusted: trusted("inventory-page-next"), operation: {
      version: "security-scan-v1", operation: "results", scanId: access.scanId, category: "inventory", limit: 1, cursor: page.nextCursor!,
    } });
    expect(page.inventory?.[0]?.relativePath).toBe("worker.ts");
    expect(page.nextCursor).toBeNull();
    const note = await ledger.appendOrUpdate({ ...access, trusted: trusted("note"), operation: {
      version: "security-scan-v1", operation: "record", scanId: access.scanId, action: "append",
      entry: { kind: "evidence", summary: "Detailed local authority trace retained beyond provider context.", evidenceRefs: [] },
      fileCitations: [{ relativePath: "api.ts", startLine: 1, endLine: 3 }],
    } });
    const question = await ledger.appendOrUpdate({ ...access, trusted: trusted("question"), operation: {
      version: "security-scan-v1", operation: "record", scanId: access.scanId, action: "append",
      entry: { kind: "open_question", question: "Does the queued path recheck membership?", evidenceRefs: [] }, fileCitations: [],
    } });
    const unit = await ledger.appendOrUpdate({ ...access, trusted: trusted("unit"), operation: {
      version: "security-scan-v1", operation: "record", scanId: access.scanId, action: "append",
      entry: { kind: "review_unit", surfaceKey: "api", paths: ["api.ts"], state: "in_progress", summary: "Identity disclosure path", trace: "Investigating membership through output", notes: "Queued revocation remains to be checked", evidenceRefs: [{ kind: "ledger_record", id: note.record.id }], counterevidenceRefs: [], openRecordIds: [question.record.id] }, fileCitations: [],
    } });
    expect(unit.researchProgress).toMatchObject({ filesAssigned: 1, filesUnassigned: 1, unitsPending: 1 });
    expect(ledger.appendOrUpdate({ ...access, trusted: trusted("drop-followup"), operation: {
      version: "security-scan-v1", operation: "record", scanId: access.scanId, action: "update", recordId: unit.record.id, expectedRevision: unit.record.revision,
      entry: { kind: "review_unit", openRecordIds: [] }, fileCitations: [],
    } })).rejects.toMatchObject({ code: "record_conflict" });
    const recovered = await createLedger(root).results({ ...access, trusted: trusted("recover-note"), operation: {
      version: "security-scan-v1", operation: "results", scanId: access.scanId, category: "all", recordIds: [note.record.id], limit: 50,
    } });
    expect(recovered.records.map((record) => record.id)).toEqual([note.record.id]);
    expect(recovered.inventory).toEqual([]);
    expect(recovered.codeEvidence).toHaveLength(1);
    expect(recovered.reportReady).toBe(false);
    await ledger.updateInventory({ ...access, trusted: trusted("source-change"), inventory: [{ ...inventory[0]!, sourceVersion: "e".repeat(64) }, inventory[1]!] });
    const changed = await ledger.results({ ...access, trusted: trusted("changed-unit"), operation: {
      version: "security-scan-v1", operation: "results", scanId: access.scanId, category: "research", recordIds: [unit.record.id], limit: 50,
    } });
    expect(changed.records[0]).toMatchObject({ revision: 2, entry: { state: "in_progress", evidenceRefs: [], counterevidenceRefs: [], openRecordIds: [question.record.id] } });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("stateless evidence cursors reject other queries, forged ids and changed record versions", async () => {
  const root = await mkdtemp(join(tmpdir(), "nautilo-security-cursors-"));
  try {
    const ledger = await createDeepLedger(root);
    const access = { scanId: "scan_demo-1", localOwnerId: "owner-1", rootIdentity: ROOT };
    await ledger.updateInventory({ ...access, trusted: trusted("inventory"), inventory: ["api.ts", "worker.ts"].map((relativePath, index) => ({
      id: `inventory_${index}`, relativePath, kind: "file", sizeBytes: 42, sourceVersion: "f".repeat(64), reason: null,
    })) });
    const query = (operation: Record<string, unknown>) => ledger.results({ ...access, trusted: trusted("query"), operation: {
      version: "security-scan-v1", operation: "results", scanId: access.scanId, category: "all", limit: 1, ...operation,
    } as Parameters<DesktopSecurityScanLedger["results"]>[0]["operation"] });
    const first = await query({ category: "inventory" });
    expect(first.nextCursor).toStartWith("cursor_");
    expect(query({ cursor: first.nextCursor })).rejects.toMatchObject({ code: "invalid_request" });
    expect(query({ category: "inventory", cursor: "inventory_0" })).rejects.toMatchObject({ code: "invalid_request" });
    const inventoryTail = await query({ category: "inventory", cursor: first.nextCursor });
    expect(inventoryTail.nextCursor).toBeNull();
    const note = await ledger.appendOrUpdate({ ...access, trusted: trusted("note"), operation: {
      version: "security-scan-v1", operation: "record", scanId: access.scanId, action: "append",
      entry: { kind: "evidence", summary: "Current scoped input-to-output trace.", evidenceRefs: [] },
      fileCitations: [{ relativePath: "api.ts", startLine: 1, endLine: 3 }],
    } });
    const targeted = await query({ recordIds: [note.record.id] });
    expect(targeted.nextCursor).not.toBeNull();
    expect(query({ cursor: targeted.nextCursor })).rejects.toMatchObject({ code: "invalid_request" });
    const allFirst = await query({});
    expect(query({ finalize: true, cursor: allFirst.nextCursor })).rejects.toMatchObject({ code: "invalid_request" });
    await ledger.appendOrUpdate({ ...access, trusted: trusted("update-note"), operation: {
      version: "security-scan-v1", operation: "record", scanId: access.scanId, action: "update", recordId: note.record.id, expectedRevision: 1,
      entry: { kind: "evidence", summary: "Updated trace with the guarded alternative." }, fileCitations: [],
    } });
    expect(query({ cursor: allFirst.nextCursor })).rejects.toMatchObject({ code: "invalid_request" });
    const restarted = await query({});
    expect(restarted.nextCursor).not.toBe(allFirst.nextCursor);
    expect((await query({ cursor: restarted.nextCursor, limit: 100 })).nextCursor).toBeNull();
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("section maps beyond the status preview survive restart and paging and every section gates finalization", async () => {
  const root = await mkdtemp(join(tmpdir(), "nautilo-large-section-map-"));
  try {
    const access = { scanId: "scan_demo-1", localOwnerId: "owner-1", rootIdentity: ROOT };
    const ledger = await createDeepLedger(root);
    const append = (id: string, entry: SecurityScanRecordInput, fileCitations: SecurityScanFileCitationInput[] = []) => ledger.appendOrUpdate({
      ...access, trusted: trusted(id), operation: { version: "security-scan-v1", operation: "record", scanId: access.scanId, action: "append", entry, fileCitations },
    });
    const surfaces = Array.from({ length: 40 }, (_, index) => ({ key: `section_${index.toString().padStart(2, "0")}`,
      label: `Behavior ${index}`, coverage: "unreviewed" as const, rationale: `Trace behavior ${index} and its boundary.` }));
    const map = await append("large-map", { kind: "repository_map", summary: "Complete behavior plan", surfaces, evidenceRefs: [] });
    expect(map.record.entry).toMatchObject({ surfaces });
    const patched = await ledger.appendOrUpdate({ ...access, trusted: trusted("large-map-update"), operation: {
      version: "security-scan-v1", operation: "record", scanId: access.scanId, action: "update", recordId: map.record.id,
      expectedRevision: map.record.revision, entry: { kind: "repository_map", surfaces }, fileCitations: [],
    } });
    expect(patched.record).toMatchObject({ revision: 2, entry: { surfaces } });
    const source = await append("source", { kind: "evidence", summary: "Shared boundary source inspected", evidenceRefs: [] },
      [{ relativePath: "src/boundary.ts", startLine: 1, endLine: 1 }]);
    const code = { kind: "code_evidence" as const, id: source.codeEvidence[0]!.id };
    const hypothesis = await append("hypothesis", { kind: "hypothesis", summary: "The boundary rejects unauthorized requests", state: "supported",
      evidenceRefs: [code], counterevidenceRefs: [code] });
    await ledger.updateInventory({ ...access, trusted: trusted("inventory"), inventory: [{ id: "inventory_boundary", relativePath: "src/boundary.ts",
      kind: "file", sizeBytes: 42, sourceVersion: "f".repeat(64), reason: null }] });
    const unit = (surfaceKey: string): SecurityScanRecordInput => ({ kind: "review_unit", surfaceKey, summary: `Investigated ${surfaceKey}`,
      paths: ["src/boundary.ts"], state: "reviewed", trace: "Caller reaches the shared authority guard before output", notes: "Checked permitted and denied requests",
      evidenceRefs: [{ kind: "ledger_record", id: hypothesis.record.id }], counterevidenceRefs: [code], openRecordIds: [] });
    for (const surface of surfaces.slice(0, -1)) await append(`unit-${surface.key}`, unit(surface.key));
    const restarted = createLedger(root);
    const preview = await restarted.status({ ...access, trusted: trusted("status-after-restart") });
    expect(preview.coverage).toHaveLength(32);
    expect(preview.researchProgress).toMatchObject({ coverageTotal: 40, coverageOmitted: 8 });
    expect(await restarted.finalize({ ...access, trusted: trusted("unfinished-tail") }).catch((error: unknown) => error))
      .toMatchObject({ code: "research_incomplete" });
    await append("unit-tail", unit(surfaces.at(-1)!.key));
    await restarted.finalize({ ...access, trusted: trusted("finish-all-sections") });
    const records = [];
    let cursor: string | undefined;
    do {
      const page = await createLedger(root).results({ ...access, trusted: trusted("read-page"), operation: {
        version: "security-scan-v1", operation: "results", scanId: access.scanId, category: "all", limit: 1, finalize: false,
        ...(cursor ? { cursor } : {}),
      } });
      records.push(...page.records);
      expect(page.status.researchProgress).toMatchObject({ coverageTotal: 40, coverageOmitted: 8, unitsCompleted: 40, unitsPending: 0 });
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(records.find((record) => record.id === map.record.id)?.entry).toMatchObject({ surfaces });
    expect(records.filter((record) => record.entry.kind === "review_unit")).toHaveLength(40);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("citation batches accumulate losslessly beyond twenty refs through restart, replay and final appendix", async () => {
  const root = await mkdtemp(join(tmpdir(), "nautilo-evidence-accumulation-"));
  try {
    const ledger = await createDeepLedger(root);
    const access = { scanId: "scan_demo-1", localOwnerId: "owner-1", rootIdentity: ROOT };
    const paths = Array.from({ length: 21 }, (_, index) => `src/flow-${index}.ts`);
    await ledger.updateInventory({ ...access, trusted: trusted("inventory-batch"), inventory: paths.map((relativePath, index) => ({
      id: `inventory_${index}`, relativePath, kind: "file" as const, sizeBytes: 40, sourceVersion: "f".repeat(64), reason: null,
    })) });
    const append = (id: string, entry: SecurityScanRecordInput, fileCitations: SecurityScanFileCitationInput[] = []) => ledger.appendOrUpdate({
      ...access, trusted: trusted(id), operation: { version: "security-scan-v1", operation: "record", scanId: access.scanId, action: "append", entry, fileCitations },
    });
    const detailedNote = "\n\tCaller authority is checked before the queued action. Compare revocation, stale cache identity and the π output boundary.\n".repeat(80);
    expect(detailedNote.length).toBeGreaterThan(2475);
    const checkpoint = await append("substantive-checkpoint", { kind: "checkpoint", summary: detailedNote,
      nextWork: `Verify the unresolved producer and consumer paths.\n${detailedNote}`, openRecordIds: [], evidenceRefs: [] });
    expect(checkpoint.record.entry).toMatchObject({ summary: detailedNote });
    const source = await append("source-note", { kind: "evidence", summary: detailedNote, evidenceRefs: [] },
      [{ relativePath: paths[0]!, startLine: 1, endLine: 1 }]);
    const scannerExplanation = "The scanner traces the unsafe branch, its preconditions and the required remediation. π ".repeat(80).trim();
    const rawSecret = "fixture-secret-not-for-ledger";
    const scannerObservations = [
      ...parseSemgrepReport(root, JSON.stringify({ results: [{ check_id: "policy-flow", path: "src/flow-0.ts", start: { line: 1 },
        end: { line: 1 }, extra: { message: scannerExplanation, severity: "ERROR" } }] })).observations,
      ...parseTrivyReport(root, JSON.stringify({ Results: [{ Target: "src/flow-0.ts", Misconfigurations: [{ ID: "policy-rule",
        Title: scannerExplanation, Severity: "HIGH", CauseMetadata: { StartLine: 1, EndLine: 1 } }] }] })).observations,
      ...parseGitleaksReport(root, JSON.stringify([{ RuleID: "generic-token", File: "src/flow-0.ts", StartLine: 1, EndLine: 1,
        Secret: rawSecret, Match: rawSecret, Description: rawSecret }])).observations,
    ];
    expect(scannerObservations.filter((item) => item.probe !== "gitleaks").map((item) => item.summary)).toEqual([scannerExplanation, scannerExplanation]);
    await ledger.appendObservations({ ...access, trusted: trusted("scanner-notes"), observations: scannerObservations });
    for (const [index, observation] of scannerObservations.entries()) await append(`scanner-disposition-${index}`, {
      kind: "dismissal", summary: "Inspected this fixture's scanner premise and retained its full explanation.",
      evidenceRefs: [{ kind: "scanner_observation", id: observation.id }, { kind: "code_evidence", id: source.codeEvidence[0]!.id }], counterevidenceRefs: [],
    });
    const hypotheses = await Promise.all(["first", "second"].map((id) => append(`hypothesis-${id}`, {
      kind: "hypothesis", summary: `Test the ${id} authority boundary.`, state: "rejected",
      evidenceRefs: [{ kind: "ledger_record", id: source.record.id }], counterevidenceRefs: [{ kind: "ledger_record", id: source.record.id }],
    })));
    const references = hypotheses.map((item) => ({ kind: "ledger_record" as const, id: item.record.id }));
    const firstInput = { ...access, trusted: trusted("twenty-source-citations"), operation: {
      version: "security-scan-v1" as const, operation: "record" as const, scanId: access.scanId, action: "append" as const,
      entry: { kind: "review_unit" as const, summary: "Trace a boundary across its supporting sources.", surfaceKey: "flow", paths,
        state: "in_progress" as const, trace: detailedNote, notes: detailedNote,
        evidenceRefs: references, counterevidenceRefs: references, openRecordIds: [] },
      fileCitations: paths.slice(0, 20).map((relativePath) => ({ relativePath, startLine: 1, endLine: 1 })),
    } };
    const first = securityScanRecordAcknowledgementSchema.parse(await ledger.appendOrUpdate(firstInput));
    expect(first.record.entry.evidenceRefs).toHaveLength(22);
    expect(first.codeEvidence).toHaveLength(20);
    const updatedInput = { ...access, trusted: trusted("further-source-citation"), operation: {
      version: "security-scan-v1" as const, operation: "record" as const, scanId: access.scanId, action: "update" as const,
      recordId: first.record.id, expectedRevision: first.record.revision,
      entry: { kind: "review_unit" as const, state: "reviewed" as const, notes: `All assigned callers and protections inspected.\n${detailedNote}`, counterevidenceRefs: first.record.entry.evidenceRefs },
      fileCitations: [{ relativePath: paths[20]!, startLine: 1, endLine: 1 }],
    } };
    const updated = securityScanRecordAcknowledgementSchema.parse(await ledger.appendOrUpdate(updatedInput));
    expect(updated.record.entry.evidenceRefs).toHaveLength(23);
    expect(updated.record.entry.evidenceRefs.slice(0, 22)).toEqual(first.record.entry.evidenceRefs);
    if (updated.record.entry.kind !== "review_unit") throw new Error("Expected review unit");
    expect(updated.record.entry.counterevidenceRefs).toHaveLength(22);
    expect(updated.codeEvidence).toHaveLength(1);
    const restarted = createLedger(root);
    const scannerReload = await restarted.results({ ...access, trusted: trusted("scanner-notes-after-restart"), operation: {
      version: "security-scan-v1", operation: "results", scanId: access.scanId, category: "observations", limit: 50, finalize: false,
    } });
    expect(scannerReload.observations).toEqual([...scannerObservations].sort((a, b) => a.id.localeCompare(b.id)));
    expect(JSON.stringify(scannerReload)).not.toContain(rawSecret);
    expect((await restarted.status({ ...access, trusted: trusted("checkpoint-after-restart") })).researchProgress?.latestCheckpoint)
      .toMatchObject({ id: checkpoint.record.id, summary: detailedNote, nextWork: `Verify the unresolved producer and consumer paths.\n${detailedNote}` });
    const replay = securityScanRecordAcknowledgementSchema.parse(await restarted.appendOrUpdate(firstInput));
    expect(replay.record.entry.evidenceRefs).toEqual(updated.record.entry.evidenceRefs);
    expect(replay.codeEvidence).toEqual(first.codeEvidence);
    const replayUpdate = securityScanRecordAcknowledgementSchema.parse(await restarted.appendOrUpdate(updatedInput));
    expect(replayUpdate.record.entry).toMatchObject({ trace: detailedNote, notes: updatedInput.operation.entry.notes });
    expect(replayUpdate.codeEvidence).toEqual(updated.codeEvidence);
    const staleError = await restarted.appendOrUpdate({ ...updatedInput, trusted: trusted("stale-update") }).catch((error: unknown) => error);
    expect(staleError).toMatchObject({ code: "record_conflict" });
    const foreignError = await restarted.appendOrUpdate({ ...updatedInput, trusted: trusted("wrong-run", "00000000-0000-4000-8000-000000000099") }).catch((error: unknown) => error);
    expect(foreignError).toMatchObject({ code: "scan_not_active" });
    const referenceError = await restarted.appendOrUpdate({ ...updatedInput, trusted: trusted("unowned-reference"), operation: { ...updatedInput.operation,
      expectedRevision: updated.record.revision, entry: { kind: "review_unit", evidenceRefs: [...updated.record.entry.evidenceRefs, { kind: "ledger_record", id: "record_absent" }] }, fileCitations: [] },
    }).catch((error: unknown) => error);
    expect(referenceError).toMatchObject({ code: "evidence_not_found" });
    const invalidError = await restarted.appendOrUpdate({ ...updatedInput, trusted: trusted("invalid-merged-kind-fields"), operation: { ...updatedInput.operation,
      expectedRevision: updated.record.revision, entry: { kind: "review_unit", state: "supported" }, fileCitations: [] },
    }).catch((error: unknown) => error);
    if (!(invalidError instanceof SecurityScanLedgerError)) throw new Error("Expected safe validation failure");
    expect(invalidError.code).toBe("invalid_request");
    expect(invalidError.continuation).toContain("correct state");
    await append("section-map", { kind: "repository_map", summary: "Requested flow boundary.", evidenceRefs: [],
      surfaces: [{ key: "flow", label: "Flow", coverage: "reviewed", rationale: "All accessible sources traced." }] });
    await append("section-coverage", { kind: "coverage", surfaceKey: "flow", state: "reviewed", rationale: "Callers, consumer and counterexamples inspected.", evidenceRefs: references });
    const changedSource = createLedger(root, ROOT, (path) => path === paths[20] ? "e".repeat(64) : "c".repeat(64));
    const freshnessError = await changedSource.finalize({ ...access, trusted: trusted("changed-tail-source") }).catch((error: unknown) => error);
    expect(freshnessError).toMatchObject({ code: "research_incomplete" });
    if (!(freshnessError instanceof SecurityScanLedgerError)) throw new Error("Expected stale-source rejection");
    expect(freshnessError.continuation).toContain(paths[20]);
    expect((await restarted.status({ ...access, trusted: trusted("still-active-after-rejection") })).state).toBe("active");
    await restarted.finalize({ ...access, trusted: trusted("finish") });
    const messages: BaseMessage[] = [];
    let cursor: string | undefined;
    let pageIndex = 0;
    do {
      const id = `final-page-${pageIndex++}`;
      const args = { version: "security-scan-v1" as const, operation: "results" as const, scanId: access.scanId,
        category: "all" as const, limit: 4, finalize: true, ...(cursor === undefined ? {} : { cursor }) };
      const page = await createLedger(root).results({ ...access, trusted: trusted(id), operation: args });
      messages.push(new AIMessage({ content: "", tool_calls: [{ id, name: "security_scan", args }] }),
        new ToolMessage({ name: "security_scan", tool_call_id: id, content: JSON.stringify({ ok: true, operation: "results", result: page }) }));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    const appendix = securityResearchAppendix(messages);
    expect(appendix).not.toBeNull();
    expect(appendix).toContain(JSON.stringify(detailedNote));
    expect(appendix).toContain(scannerExplanation);
    expect(appendix).not.toContain(rawSecret);
    expect(appendix).toContain(JSON.stringify(updatedInput.operation.entry.notes));
    for (const ref of updated.record.entry.evidenceRefs) expect(appendix).toContain(ref.id);
    for (const path of paths) expect(appendix).toContain(path);
    let targetedCursor: string | undefined;
    let reloadedEntry: SecurityScanRecordInput | undefined;
    do {
      const finalRecord = await restarted.results({ ...access, trusted: trusted("targeted-review"), operation: {
        version: "security-scan-v1", operation: "results", scanId: access.scanId, category: "research", recordIds: [first.record.id], limit: 1, finalize: false,
        ...(targetedCursor === undefined ? {} : { cursor: targetedCursor }),
      } });
      reloadedEntry = finalRecord.records[0]?.entry ?? reloadedEntry;
      targetedCursor = finalRecord.nextCursor ?? undefined;
    } while (targetedCursor !== undefined);
    expect(reloadedEntry).toEqual(updated.record.entry);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("hypothesis status uses the shared preview while full Unicode notes survive restart and retrieval", async () => {
  const root = await mkdtemp(join(tmpdir(), "nautilo-hypothesis-status-preview-"));
  try {
    const ledger = await createDeepLedger(root);
    const access = { scanId: "scan_demo-1", localOwnerId: "owner-1", rootIdentity: ROOT };
    const summary = "Inspect producer and deferred consumer authorization — preserve distinct uncertainty.\n".repeat(12) + "Full trailing hypothesis detail 🔒.";
    const receipt = await ledger.appendOrUpdate({ ...access, trusted: trusted("long-hypothesis"), operation: {
      version: "security-scan-v1", operation: "record", scanId: access.scanId, action: "append",
      entry: { kind: "hypothesis", summary, state: "investigating", evidenceRefs: [], counterevidenceRefs: [] }, fileCitations: [],
    } });
    expect(receipt.record.entry.summary).toBe(summary);
    const restarted = createLedger(root);
    const status = await restarted.status({ ...access, trusted: trusted("preview") });
    expect(status.hypotheses).toEqual([{ id: receipt.record.id, state: "investigating", summary: securityScanHypothesisStatusPreview(summary) }]);
    expect(status.hypotheses[0]!.summary.length).toBeLessThan(summary.length);
    const page = await restarted.results({ ...access, trusted: trusted("full-note"), operation: {
      version: "security-scan-v1", operation: "results", scanId: access.scanId, category: "research", recordIds: [receipt.record.id], finalize: false, limit: 1,
    } });
    expect(page.records[0]!.entry.summary).toBe(summary);
    expect(page.records[0]!.revision).toBe(receipt.record.revision);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("review unit path feedback identifies every invalid field and preserves the prior record across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "nautilo-security-unit-path-feedback-"));
  try {
    const ledger = await createDeepLedger(root);
    const access = { scanId: "scan_demo-1", localOwnerId: "owner-1", rootIdentity: ROOT };
    const entry = { kind: "review_unit" as const, surfaceKey: "uploads", paths: ["folders.ts", "complete.ts"],
      state: "unreviewed" as const, summary: "Trace upload completion", trace: "Trace folder ownership through completion",
      notes: "Check namespace binding", evidenceRefs: [], counterevidenceRefs: [], openRecordIds: [] };
    const missing = await ledger.appendOrUpdate({ ...access, trusted: trusted("missing-inventory"), operation: {
      version: "security-scan-v1", operation: "record", scanId: access.scanId, action: "append", entry, fileCitations: [],
    } }).catch((error: unknown) => error);
    if (!(missing instanceof SecurityScanLedgerError)) throw new Error("Expected missing inventory rejection");
    expect(missing.code).toBe("evidence_not_found");
    expect(missing.message).toContain("inventory is not available");
    expect(missing.message).toContain("Nothing was written");
    expect(missing.message).not.toContain("entry.paths[");
    await ledger.updateInventory({ ...access, trusted: trusted("inventory"), inventory: entry.paths.map((relativePath, index) => ({
      id: `inventory_${index}`, relativePath, kind: "file", sizeBytes: 42, sourceVersion: "f".repeat(64), reason: null,
    })) });
    const accepted = await ledger.appendOrUpdate({ ...access, trusted: trusted("valid-unit"), operation: {
      version: "security-scan-v1", operation: "record", scanId: access.scanId, action: "append", entry, fileCitations: [],
    } });
    const rejectedPaths = ["folders.ts", "private-do-not-echo-a.ts", "complete.ts", "private-do-not-echo-b.ts"];
    const rejected = await ledger.appendOrUpdate({ ...access, trusted: trusted("invalid-unit-update"), operation: {
      version: "security-scan-v1", operation: "record", scanId: access.scanId, action: "update",
      recordId: accepted.record.id, expectedRevision: accepted.record.revision,
      entry: { kind: "review_unit", paths: rejectedPaths, notes: "This rejected note must not replace the accepted note" }, fileCitations: [],
    } }).catch((error: unknown) => error);
    if (!(rejected instanceof SecurityScanLedgerError)) throw new Error("Expected invalid path rejection");
    expect(rejected.code).toBe("evidence_not_found");
    expect(rejected.message).toContain("entry.paths[1], entry.paths[3]");
    expect(rejected.message).not.toContain("entry.paths[0]");
    expect(rejected.message).not.toContain("entry.paths[2]");
    expect(rejected.message).toContain(`revision ${accepted.record.revision} are unchanged`);
    expect(rejected.message).toContain("Nothing was written");
    expect(`${rejected.message} ${rejected.continuation}`).not.toContain("private-do-not-echo");
    expect(rejected.continuation).toContain("smaller limit");
    expect(rejected.continuation).toContain("continueResults:true on subsequent pages");
    const restarted = createLedger(root);
    const saved = await restarted.results({ ...access, trusted: trusted("read-unchanged"), operation: {
      version: "security-scan-v1", operation: "results", scanId: access.scanId, category: "research", recordIds: [accepted.record.id],
    } });
    expect(saved.records).toEqual([accepted.record]);
    const repaired = await restarted.appendOrUpdate({ ...access, trusted: trusted("correct-unit-update"), operation: {
      version: "security-scan-v1", operation: "record", scanId: access.scanId, action: "update",
      recordId: accepted.record.id, expectedRevision: accepted.record.revision,
      entry: { kind: "review_unit", paths: entry.paths, notes: "Exact paths confirmed in inventory" }, fileCitations: [],
    } });
    expect(repaired.record.revision).toBe(accepted.record.revision + 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("sampled behavior closes, seals and exports without assigning every inventory file and survives restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "nautilo-sampled-review-"));
  const access = { scanId: "scan_sampled", localOwnerId: "owner-1", rootIdentity: ROOT };
  try {
    let ledger = createLedger(root);
    await ledger.create({ ...access, trusted: trusted("create"), mode: "deep_research" });
    const inventory = ["api.ts", "support.ts", "fixture.ts"].map((relativePath, index) => ({
      id: `inventory_${index}`, relativePath, kind: "file" as const, sizeBytes: 64, sourceVersion: "f".repeat(64), reason: null,
    }));
    await ledger.updateInventory({ ...access, trusted: trusted("inventory"), inventory });
    const entry = { kind: "review_unit" as const, summary: "Request authorization", surfaceKey: "api", paths: ["api.ts", "support.ts"],
      state: "in_progress" as const, trace: "Trace the public handler and actor check.", notes: "Support wrappers are assigned scope, not yet inspected.", evidenceRefs: [], counterevidenceRefs: [], openRecordIds: [] };
    const saved = await ledger.appendOrUpdate({ ...access, trusted: trusted("plan"), operation: { version: "security-scan-v1", operation: "record", scanId: access.scanId, action: "append", entry, fileCitations: [] } });
    const operation = { version: "security-scan-v1" as const, operation: "record" as const, scanId: access.scanId, action: "update" as const,
      recordId: saved.record.id, expectedRevision: 1, entry: { kind: "review_unit" as const, state: "reviewed" as const,
        trace: "The handler checks the request actor before output.", notes: "Deeply traced api.ts. Supporting wrappers were not read; representative handler evidence establishes this bounded conclusion, not all wrapper behavior." }, fileCitations: [] };
    const rejection = await ledger.appendOrUpdate({ ...access, trusted: trusted("reject_without_evidence"), operation }).catch((error: unknown) => error);
    expect(rejection).toMatchObject({ code: "record_conflict" });
    ledger = createLedger(root);
    const page = await ledger.results({ ...access, trusted: trusted("reload"), operation: { version: "security-scan-v1", operation: "results", scanId: access.scanId, category: "research", recordIds: [saved.record.id] } });
    expect(page.records[0]).toMatchObject({ revision: 1, entry: { state: "in_progress" } });
    const closed = await ledger.appendOrUpdate({ ...access, trusted: trusted("close"), operation: { ...operation, fileCitations: [{ relativePath: "api.ts", startLine: 1, endLine: 3 }] } });
    expect(closed.researchProgress).toMatchObject({ unitsCompleted: 1, unitsPending: 0, filesAssigned: 2, filesUnassigned: 1 });
    expect(closed.record.entry).toMatchObject(operation.entry);
    await ledger.appendOrUpdate({ ...access, trusted: trusted("exclude_fixture"), operation: { version: "security-scan-v1", operation: "record", scanId: access.scanId, action: "append",
      entry: { kind: "coverage", surfaceKey: "fixtures", state: "not_applicable", rationale: "Fixture-only input is outside the requested runtime scope; its contents were not reviewed.", evidenceRefs: [] }, fileCitations: [] } });
    const status = await ledger.status({ ...access, trusted: trusted("status") });
    await ledger.updateStatus({ ...access, trusted: trusted("probes"), status: { ...status, phase: "researching", lanes: status.lanes.map((lane) => ({ ...lane, state: "completed", error: null })) } });
    ledger = createLedger(root);
    expect((await ledger.finalize({ ...access, trusted: trusted("finalize") })).state).toBe("completed");
    const sealed = await ledger.results({ ...access, trusted: trusted("seal_receipt"), operation: {
      version: "security-scan-v1", operation: "results", scanId: access.scanId, category: "all", finalize: true, limit: 1,
    } });
    expect(sealed.status.researchProgress).toMatchObject({ unitsTotal: 1, unitsCompleted: 1, filesUnassigned: 1, nextResearchWork: null });
    const exportState = { currentTaskId: TASK_ID, currentTaskRunId: trusted("export").taskRunId,
      userId: "owner-1", model: trusted("export").modelId, subagentRun: true, toolWhitelist: ["security_scan"],
      messages: [new AIMessage({ content: "Seal the bounded research plan.", tool_calls: [{ id: "seal", name: "security_scan",
        args: { operation: "results", category: "all", finalize: true } }] }),
      new ToolMessage({ name: "security_scan", tool_call_id: "seal", content: JSON.stringify({ ok: true, operation: "results", result: sealed }) })],
    } as unknown as NautiloState;
    const exported = await collectFinalizedSecurityResearch(exportState, { threadId: "export-thread", taskId: TASK_ID,
      taskRunId: trusted("export").taskRunId, userId: "owner-1", modelId: trusted("export").modelId }, async (cursor) => ({
      ok: true, operation: "results", result: await ledger.results({ ...access, trusted: trusted("runtime_export"), operation: {
        version: "security-scan-v1", operation: "results", scanId: access.scanId, category: "all", finalize: false, limit: 1,
        ...(cursor === undefined ? {} : { cursor }),
      } }),
    }));
    expect(exported.reportState).toBe("completed");
    expect(exported.researchAppendix).toContain("Fixture-only input is outside the requested runtime scope");
    expect(exported.researchAppendix).toContain("fixture.ts");
    expect(exported.researchAppendix).toContain("Supporting wrappers were not read");
    // No new units or changed revisions were needed to seal and export.
    const retained = await ledger.results({ ...access, trusted: trusted("verify_closed"), operation: {
      version: "security-scan-v1", operation: "results", scanId: access.scanId, category: "research", recordIds: [saved.record.id],
    } });
    expect(retained.records).toEqual([closed.record]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
