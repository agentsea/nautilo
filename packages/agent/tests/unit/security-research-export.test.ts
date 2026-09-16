import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { SECURITY_SCAN_INITIAL_LANES, securityScanToolResultSchema, securityScanLedgerRecordSchema } from "@nautilo/types";
import type { NautiloState } from "../../src/agent/state";
import { collectFinalizedSecurityResearch, type SecurityResearchExportInput } from "../../src/tools/security/research-export";
import { readSecurityResearchExportPage, setRelayRegistry, type ToolRelayRegistry } from "../../src/tools/invocation-service";

const taskId = "00000000-0000-4000-8000-000000000001";
const taskRunId = "00000000-0000-4000-8000-000000000002";
const input: SecurityResearchExportInput = { threadId: "thread", taskId, taskRunId, userId: "owner", modelId: "openai:test" };
const author = { taskId, taskRunId, modelId: input.modelId };
const status = { version: "security-scan-v1", scanId: "scan_test", state: "completed", phase: null, terminalState: "completed",
  mode: "deep_research", modelId: input.modelId, modelState: "completed", completedSteps: 2, totalSteps: 2, lanes: SECURITY_SCAN_INITIAL_LANES,
  coverage: [{ surfaceKey: "auth", label: "Auth", state: "reviewed", rationale: "Traced behavior and guards." }], hypotheses: [],
  researchProgress: { inventoryState: "complete", inventoryFingerprint: "d".repeat(64), filesTotal: 1, filesAssigned: 1, filesUnassigned: 0,
    unitsTotal: 1, unitsCompleted: 1, unitsPending: 0, excludedEntriesTotal: 0, coverageTotal: 1, hypothesesTotal: 1,
    coverageOmitted: 0, hypothesesOmitted: 0, latestCheckpoint: null } };
const note = (id: string) => ({ id, revision: 1, createdAt: "2026-09-07T00:00:00.000Z", updatedAt: "2026-09-07T00:00:00.000Z",
  createdBy: author, updatedBy: author, entry: { kind: "evidence", summary: `Detailed preserved investigation ${id}.`, evidenceRefs: [] } });
const digest = createHash("sha256");
for (const id of ["record_a", "record_b", "record_c"]) digest.update(id).update("\0").update(JSON.stringify(securityScanLedgerRecordSchema.parse(note(id)))).update("\0");
const snapshot = { sha256: digest.digest("hex"), itemCount: 3 };
function receipt(ids: string[], nextCursor: string | null, changes: Record<string, unknown> = {}) {
  return { ok: true, operation: "results", result: { version: "security-scan-v1", status, observations: [], codeEvidence: [],
    records: ids.map(note), inventory: [], nextCursor, reportReady: false, exportSnapshot: snapshot, ...changes } };
}
function stateWithSeal() {
  return { messages: [new AIMessage({ content: "Draft reviewed. Seal the evidence.", tool_calls: [{ id: "seal", name: "security_scan",
    args: { version: "security-scan-v1", operation: "results", category: "all", finalize: true, limit: 1 } }] }),
    new ToolMessage({ name: "security_scan", tool_call_id: "seal", content: JSON.stringify(receipt(["record_a"], "cursor_b")) })],
    model: input.modelId, subagentRun: true, toolWhitelist: ["security_scan"], userId: input.userId,
    currentTaskId: taskId, currentTaskRunId: taskRunId,
    taskReportBackContinuation: { status: "available", relayId: "relay", relaySessionId: "session", desktopSessionId: "desktop",
      pairingGeneration: "generation", currentFolder: "/authorized", workspacePath: "/workspace" },
  } as unknown as NautiloState;
}

afterEach(() => setRelayRegistry(null));

test("collects the complete sealed export without any model-operated tail or canonical message mutation", async () => {
  const state = stateWithSeal();
  const before = state.messages.map((message) => message.toDict());
  const cursors: Array<string | undefined> = [];
  const result = await collectFinalizedSecurityResearch(state, input, async (cursor) => {
    cursors.push(cursor);
    return cursor === undefined ? receipt(["record_a"], "cursor_b")
      : cursor === "cursor_b" ? receipt(["record_b"], "cursor_c") : receipt(["record_c"], null);
  });
  expect(cursors).toEqual([undefined, "cursor_b", "cursor_c"]);
  expect(result.reportState).toBe("completed");
  for (const id of ["record_a", "record_b", "record_c"]) expect(result.researchAppendix).toContain(note(id).entry.summary);
  expect(state.messages.map((message) => message.toDict())).toEqual(before);
});

test("rejects changed snapshots, mixed scans, duplicate or missing items, repeated cursors, and failed receipts", async () => {
  for (const variant of ["snapshot", "scan", "duplicate", "missing", "cursor", "error"] as const) {
    let calls = 0;
    const error = await collectFinalizedSecurityResearch(stateWithSeal(), input, async () => {
      calls++;
      if (calls === 1) return receipt(["record_a"], "cursor_b");
      if (variant === "error") return { ok: false, operation: "results", error: { code: "root_revoked", message: "Folder changed", retryable: false } };
      return receipt(variant === "duplicate" ? ["record_a"] : ["record_b"], variant === "cursor" ? "cursor_b" : null,
        variant === "snapshot" ? { exportSnapshot: { ...snapshot, sha256: "f".repeat(64) } }
          : variant === "scan" ? { status: { ...status, scanId: "scan_other" } } : {});
    }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(calls).toBe(2);
  }
});

test("rechecks scope and cancellation and restarts a failed read-only export from its first page", async () => {
  for (const mismatch of [{ taskId: "other" }, { taskRunId: "other" }, { userId: "other" }, { modelId: "other" }]) {
    let reads = 0;
    const error = await collectFinalizedSecurityResearch(stateWithSeal(), { ...input, ...mismatch }, async () => { reads++; return {}; }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(reads).toBe(0);
  }
  const controller = new AbortController();
  let reads = 0;
  const error = await collectFinalizedSecurityResearch(stateWithSeal(), { ...input, signal: controller.signal }, async () => {
    reads++; controller.abort(); return receipt(["record_a"], "cursor_b");
  }).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  expect(reads).toBe(1);
  const cursors: Array<string | undefined> = [];
  await collectFinalizedSecurityResearch(stateWithSeal(), input, async (cursor) => {
    cursors.push(cursor); return receipt(["record_a", "record_b", "record_c"], null);
  });
  expect(cursors).toEqual([undefined]);
});

test("unchanged item counts cannot hide changed content and a native-error seal cannot authorize export", async () => {
  const error = await collectFinalizedSecurityResearch(stateWithSeal(), input, async () => receipt(["record_a", "record_b", "record_c"], null,
    { records: [note("record_a"), note("record_b"), { ...note("record_c"), revision: 2 }] })).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe("SECURITY_RESEARCH_EXPORT_CONTENT_MISMATCH");
  const state = stateWithSeal();
  (state.messages[1] as ToolMessage).status = "error";
  let reads = 0;
  const rejected = await collectFinalizedSecurityResearch(state, input, async () => { reads++; return {}; }).catch((error: unknown) => error);
  expect(rejected).toBeInstanceOf(Error);
  expect(reads).toBe(0);
});

test("export relay wrapper revalidates owner, exact session, pairing, folder and capability for every read", async () => {
  const state = stateWithSeal();
  const capabilities = { canReadWorkspace: true, currentFolderRoot: "/authorized", workspaceRoot: "/workspace", allowedRoots: ["/authorized"] };
  let owner = "owner", session = "session", desktop = "desktop", generation = "generation", fresh = true;
  const dispatched: Array<{ relayId: string; request: Record<string, unknown> }> = [];
  setRelayRegistry({ getCapabilities: () => capabilities, getUserId: () => owner, getRelaySessionId: () => session,
    getDesktopSessionId: () => desktop, getPairingGeneration: () => generation, isRelayHeartbeatFresh: () => fresh,
    dispatch: async (relayId: string, request: Record<string, unknown>) => { dispatched.push({ relayId, request }); return { status: "success", result: receipt(["record_a"], null) }; },
  } as unknown as ToolRelayRegistry);
  const controller = new AbortController();
  const received = await readSecurityResearchExportPage(state, "cursor_exact", controller.signal);
  expect(securityScanToolResultSchema.safeParse(received).success).toBe(true);
  const sent = dispatched[0]!.request;
  expect(dispatched[0]!.relayId).toBe("relay");
  expect(sent["requiredRelaySessionId"]).toBe("session");
  expect(sent["requiredDesktopSessionId"]).toBe("desktop");
  expect(sent["requiredPairingGeneration"]).toBe("generation");
  expect(sent["signal"]).toBe(controller.signal);
  expect(sent["args"]).toMatchObject({ operation: { operation: "results", category: "all", finalize: false, cursor: "cursor_exact" },
    trustedContext: { taskId, taskRunId, modelId: input.modelId }, expectedCurrentFolder: "/authorized" });
  for (const revoke of [() => { owner = "other"; }, () => { session = "new"; }, () => { desktop = "new"; },
    () => { generation = "new"; }, () => { fresh = false; }, () => { capabilities.canReadWorkspace = false; },
    () => { capabilities.currentFolderRoot = "/other"; }]) {
    revoke();
    const rejected = await readSecurityResearchExportPage(state, undefined).catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(Error);
    owner = "owner"; session = "session"; desktop = "desktop"; generation = "generation"; fresh = true;
    capabilities.canReadWorkspace = true; capabilities.currentFolderRoot = "/authorized";
  }
  expect(dispatched).toHaveLength(1);
});
