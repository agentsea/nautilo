import { reviewUnitCompletionIssue, latestResearchCheckpoint, researchProgress, researchSectionCoverage, terminalEvidenceOwners, unfinishedScannerTriage } from "./review-work";
import { securityInventoryFingerprint } from "./inventory";
import { unfinishedResearch } from "./research-completion";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  SECURITY_SCAN_INITIAL_LANES,
  SECURITY_SCAN_MAX_FILE_CITATIONS_PER_CALL,
  SECURITY_SCAN_MAX_STATUS_COVERAGE,
  SECURITY_SCAN_VERSION,
  securityScanIdSchema,
  securityScanInventoryEntrySchema,
  type SecurityScanInventoryEntry,
  securityScanCodeEvidenceSchema,
  securityScanLedgerRecordSchema,
  securityScanObservationSchema,
  securityScanOperationSchema,
  securityScanRecordInputSchema,
  securityScanStatusSchema,
  securityScanHypothesisStatusPreview,
  securityScanTrustedContextSchema,
  type SecurityScanErrorCode,
  type SecurityScanCodeEvidence,
  type SecurityScanFileCitationInput,
  type SecurityScanLedgerRecord,
  type SecurityScanObservation,
  type SecurityScanOperation,
  type SecurityScanRecordAcknowledgement,
  type SecurityScanRecordInput,
  type SecurityScanResultEnvelope,
  type SecurityScanStatus,
  type SecurityScanTrustedContext,
} from "@nautilo/types";

const LEDGER_VERSION = 1 as const;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ROOT_MARKER = "nautilo-security-research-v1\n";

function codeEvidenceIdForToolCall(toolCallId: string, index: number): string {
  return `evidence_${createHash("sha256").update(`${toolCallId}:${index}`).digest("hex").slice(0, 24)}`;
}

export class SecurityScanLedgerError extends Error {
  constructor(readonly code: SecurityScanErrorCode, message: string, readonly continuation?: string) {
    super(message);
    this.name = "SecurityScanLedgerError";
  }
}

/**
 * A root identity is assembled by the authorized-root owner. It intentionally
 * contains no source path: a hash/fingerprint can combine realpath, device,
 * inode, and optional git metadata before it reaches this store.
 */
export interface SecurityScanLedgerRootIdentity {
  /** SHA-256 fingerprint of the live authorized root identity, never its path. */
  readonly fingerprint: string;
  readonly device?: string | undefined;
  readonly inode?: string | undefined;
  readonly gitHead?: string | null | undefined;
  readonly gitDirty?: boolean | null | undefined;
}

export interface SecurityScanCitationDigest {
  readonly sourceVersion?: string;
  readonly relativePath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly fileSha256: string;
  readonly rangeSha256: string;
  readonly rootFingerprint: string;
  readonly gitHead: string | null;
  readonly gitDirty: boolean | null;
}

/** The only route by which the ledger may verify a model-supplied citation. */
export interface SecurityScanCitationReader {
  revalidateAndHash(
    citation: SecurityScanFileCitationInput,
    expectedRoot: SecurityScanLedgerRootIdentity,
  ): Promise<SecurityScanCitationDigest>;
}

/** Rechecks the live Current Folder identity before a ledger mutation commits. */
export interface SecurityScanRootIdentityReader {
  revalidate(expectedRoot: SecurityScanLedgerRootIdentity): Promise<SecurityScanLedgerRootIdentity>;
}

export interface DesktopSecurityScanLedgerOptions {
  /** Electron userData path supplied by the app, never a tool-call argument. */
  readonly userDataRoot: string;
  readonly citationReader: SecurityScanCitationReader;
  readonly rootIdentityReader: SecurityScanRootIdentityReader;
  readonly now?: () => Date;
}

interface StoredTaskRun {
  readonly taskId: string;
  readonly taskRunId: string;
  readonly modelId: string | null;
  readonly openedAt: string;
}

interface StoredReceipt {
  readonly toolCallId: string;
  readonly operationSha256: string;
}

interface StoredLedger {
  readonly version: typeof LEDGER_VERSION;
  readonly scanId: string;
  /** Injected local relay owner; never a model or tool-wire value. */
  readonly localOwnerId: string;
  readonly rootIdentity: SecurityScanLedgerRootIdentity;
  readonly origin: StoredTaskRun;
  readonly continuations: readonly StoredTaskRun[];
  readonly status: SecurityScanStatus;
  readonly observations: readonly SecurityScanObservation[];
  readonly codeEvidence: readonly SecurityScanCodeEvidence[];
  readonly records: readonly SecurityScanLedgerRecord[];
  /** Absent in legacy artifacts; never treated as an empty completed inventory. */
  readonly inventory?: readonly SecurityScanInventoryEntry[];
  /** Durable trusted-tool receipts prevent a retry from replaying a mutation. */
  readonly receipts: readonly StoredReceipt[];
}

export interface CreateSecurityScanLedgerInput {
  readonly scanId: string;
  readonly mode: "deep_research" | "scanners_only";
  readonly targetDirectory?: string;
  readonly targetFingerprint?: string;
  readonly trusted: SecurityScanTrustedContext;
  readonly localOwnerId: string;
  readonly rootIdentity: SecurityScanLedgerRootIdentity;
}

export interface SecurityScanLedgerAccess {
  readonly scanId: string;
  readonly trusted: SecurityScanTrustedContext;
  readonly localOwnerId: string;
  readonly rootIdentity: SecurityScanLedgerRootIdentity;
}

export type SecurityScanLedgerBindingInput = Omit<SecurityScanLedgerAccess, "scanId">;

export type ReopenSecurityScanLedgerInput = SecurityScanLedgerAccess & {
  readonly targetDirectory?: string;
  readonly targetFingerprint?: string;
};

export interface AppendSecurityScanLedgerRecordInput {
  readonly operation: Extract<SecurityScanOperation, { readonly operation: "record" }>;
  readonly trusted: SecurityScanTrustedContext;
  readonly localOwnerId: string;
  readonly rootIdentity: SecurityScanLedgerRootIdentity;
}

export interface AppendSecurityScanObservationInput {
  readonly scanId: string;
  readonly observation: SecurityScanObservation;
  readonly trusted: SecurityScanTrustedContext;
  readonly localOwnerId: string;
  readonly rootIdentity: SecurityScanLedgerRootIdentity;
}

export interface UpdateSecurityScanStatusInput {
  readonly status: SecurityScanStatus;
  readonly trusted: SecurityScanTrustedContext;
  readonly localOwnerId: string;
  readonly rootIdentity: SecurityScanLedgerRootIdentity;
}

export type CancelSecurityScanLedgerInput = SecurityScanLedgerAccess;
export type FinalizeSecurityScanLedgerInput = SecurityScanLedgerAccess;

export interface SecurityScanLedgerResultsInput {
  readonly operation: Extract<SecurityScanOperation, { readonly operation: "results" }>;
  readonly trusted: SecurityScanTrustedContext;
  readonly localOwnerId: string;
  readonly rootIdentity: SecurityScanLedgerRootIdentity;
}

function safeError(code: SecurityScanErrorCode, message: string): SecurityScanLedgerError {
  return new SecurityScanLedgerError(code, message);
}

function canonicalTime(now: () => Date): string {
  return now().toISOString();
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function onlyKnownKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function parseRootIdentity(value: unknown): SecurityScanLedgerRootIdentity {
  if (!isRecord(value) || !onlyKnownKeys(value, ["fingerprint", "device", "inode", "gitHead", "gitDirty"])) {
    throw safeError("artifact_corrupt", "Security research ledger root identity is invalid.");
  }
  const fingerprint = sha256(value["fingerprint"]);
  const device = value["device"] === undefined ? undefined : identityToken(value["device"]);
  const inode = value["inode"] === undefined ? undefined : identityToken(value["inode"]);
  const rawGitHead = value["gitHead"];
  const gitHead = rawGitHead === undefined || rawGitHead === null ? rawGitHead : gitHeadToken(rawGitHead);
  const rawGitDirty = value["gitDirty"];
  const gitDirty = rawGitDirty === undefined || rawGitDirty === null ? rawGitDirty : typeof rawGitDirty === "boolean" ? rawGitDirty : null;
  if (fingerprint === null || device === null || inode === null || (gitHead === null && rawGitHead !== null)
    || (gitDirty === null && rawGitDirty !== null)) {
    throw safeError("artifact_corrupt", "Security research ledger root identity is invalid.");
  }
  return {
    fingerprint,
    ...(device === undefined ? {} : { device }),
    ...(inode === undefined ? {} : { inode }),
    ...(gitHead === undefined ? {} : { gitHead }),
    ...(gitDirty === undefined ? {} : { gitDirty }),
  };
}

function zToken(value: unknown, maximum: number): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || /\p{Cc}/u.test(value)) return null;
  return value;
}

function identityToken(value: unknown): string | null {
  const token = zToken(value, 128);
  return token === null || /[/\\]/.test(token) ? null : token;
}

function sha256(value: unknown): string | null {
  return typeof value === "string" && SHA256_PATTERN.test(value) ? value : null;
}

function gitHeadToken(value: unknown): string | null {
  return typeof value === "string" && /^[a-f0-9]{40,64}$/.test(value) ? value : null;
}

function rootIdentityEquals(a: SecurityScanLedgerRootIdentity, b: SecurityScanLedgerRootIdentity): boolean {
  return a.fingerprint === b.fingerprint
    && a.device === b.device
    && a.inode === b.inode
    && a.gitHead === b.gitHead
    && a.gitDirty === b.gitDirty;
}

function parseTrusted(value: SecurityScanTrustedContext): SecurityScanTrustedContext {
  const parsed = securityScanTrustedContextSchema.safeParse(value);
  if (!parsed.success) throw safeError("invalid_request", "Security research trusted context is invalid.");
  return parsed.data;
}

function parseTaskRun(value: unknown): StoredTaskRun {
  if (!isRecord(value) || !exactKeys(value, ["taskId", "taskRunId", "modelId", "openedAt"])) {
    throw safeError("artifact_corrupt", "Security research task lineage is invalid.");
  }
  const trusted = securityScanTrustedContextSchema.safeParse({
    taskId: value["taskId"],
    taskRunId: value["taskRunId"],
    toolCallId: "ledger-read",
    modelId: value["modelId"],
  });
  if (!trusted.success || typeof value["openedAt"] !== "string" || !Number.isFinite(Date.parse(value["openedAt"]))) {
    throw safeError("artifact_corrupt", "Security research task lineage is invalid.");
  }
  return {
    taskId: trusted.data.taskId,
    taskRunId: trusted.data.taskRunId,
    modelId: trusted.data.modelId,
    openedAt: value["openedAt"],
  };
}

function parseLedger(value: unknown): StoredLedger {
  if (!isRecord(value) || !exactKeys(value, [
    "version", "scanId", "localOwnerId", "rootIdentity", "origin", "continuations", "status", "observations", "codeEvidence", "records", "receipts", ...(isRecord(value) && value["inventory"] !== undefined ? ["inventory"] : []),
  ])) throw safeError("artifact_corrupt", "Security research ledger is invalid.");
  if (value["version"] !== LEDGER_VERSION || !Array.isArray(value["continuations"]) || !Array.isArray(value["observations"])
    || !Array.isArray(value["codeEvidence"]) || !Array.isArray(value["records"]) || !Array.isArray(value["receipts"])) {
    throw safeError("artifact_corrupt", "Security research ledger is invalid.");
  }
  const scanId = securityScanIdSchema.safeParse(value["scanId"]);
  const localOwnerId = identityToken(value["localOwnerId"]);
  const status = securityScanStatusSchema.safeParse(value["status"]);
  if (!scanId.success || localOwnerId === null || !status.success || status.data.scanId !== scanId.data) {
    throw safeError("artifact_corrupt", "Security research ledger is invalid.");
  }
  const observations = value["observations"].map((item) => {
    const parsed = securityScanObservationSchema.safeParse(item);
    if (!parsed.success) throw safeError("artifact_corrupt", "Security research observation is invalid.");
    return parsed.data;
  });
  const receipts = value["receipts"].map(parseReceipt);
  if (new Set(receipts.map((item) => item.toolCallId)).size !== receipts.length) {
    throw safeError("artifact_corrupt", "Security research idempotency state is invalid.");
  }
  const codeEvidence = value["codeEvidence"].map((item) => {
    const parsed = securityScanCodeEvidenceSchema.safeParse(item);
    if (!parsed.success) throw safeError("artifact_corrupt", "Security research code evidence is invalid.");
    return parsed.data;
  });
  const records = value["records"].map((item) => {
    const parsed = securityScanLedgerRecordSchema.safeParse(item);
    if (!parsed.success) throw safeError("artifact_corrupt", "Security research record is invalid.");
    return parsed.data;
  });
  const inventory = value["inventory"] === undefined ? undefined : Array.isArray(value["inventory"])
    ? value["inventory"].map((item) => securityScanInventoryEntrySchema.parse(item))
    : (() => { throw safeError("artifact_corrupt", "Security research inventory is invalid."); })();
  const identifiers = [...(inventory ?? []).map((item) => item.id), ...observations.map((item) => item.id), ...codeEvidence.map((item) => item.id), ...records.map((item) => item.id)];
  if (new Set(identifiers).size !== identifiers.length) throw safeError("artifact_corrupt", "Security research identifiers are invalid.");
  return {
    version: LEDGER_VERSION,
    scanId: scanId.data,
    localOwnerId,
    rootIdentity: parseRootIdentity(value["rootIdentity"]),
    origin: parseTaskRun(value["origin"]),
    continuations: value["continuations"].map(parseTaskRun),
    status: status.data,
    observations,
    codeEvidence,
    records,
    ...(inventory === undefined ? {} : { inventory }),
    receipts,
  };
}

function initialStatus(scanId: string, mode: "deep_research" | "scanners_only", modelId: string | null): SecurityScanStatus {
  return securityScanStatusSchema.parse({
    version: SECURITY_SCAN_VERSION,
    scanId,
    state: "active",
    phase: "admitting",
    terminalState: null,
    mode,
    modelId,
    modelState: mode === "scanners_only" ? "disabled" : "pending",
    completedSteps: 0,
    totalSteps: 1,
    lanes: SECURITY_SCAN_INITIAL_LANES,
    coverage: [],
    hypotheses: [],
  });
}

function finalResearchStatus(ledger: StoredLedger): SecurityScanStatus {
  const coverageBySurface = new Map<string, SecurityScanStatus["coverage"][number]>();
  for (const record of ledger.records) {
    if (record.entry.kind === "repository_map") {
      for (const surface of record.entry.surfaces) {
        coverageBySurface.set(surface.key, {
          surfaceKey: surface.key,
          label: surface.label,
          // Map labels are a plan, never evidence of completed investigation.
          state: "unreviewed",
          rationale: surface.rationale.slice(0, 500),
        });
      }
    }
  }
  // Explicit decisions take precedence; completed review units provide the
  // same derived section view used by evidence closure and finalization.
  for (const section of researchSectionCoverage(ledger.records, ledger.codeEvidence, ledger.inventory ?? null).values()) {
    const prior = coverageBySurface.get(section.surfaceKey);
    coverageBySurface.set(section.surfaceKey, {
      surfaceKey: section.surfaceKey, label: prior?.label ?? section.surfaceKey,
      state: section.state, rationale: section.rationale.slice(0, 500),
    });
  }
  const allCoverage = [...coverageBySurface.values()]
    .sort((a, b) => a.surfaceKey.localeCompare(b.surfaceKey));
  const allHypotheses = ledger.records
    .filter((record): record is SecurityScanLedgerRecord & { entry: Extract<SecurityScanRecordInput, { kind: "hypothesis" }> } => record.entry.kind === "hypothesis")
    .map((record) => ({ id: record.id, state: record.entry.state, summary: securityScanHypothesisStatusPreview(record.entry.summary) }));
  const coverage = allCoverage.slice(0, SECURITY_SCAN_MAX_STATUS_COVERAGE);
  const hypotheses = allHypotheses.slice(-20);
  const incompleteCoverage = allCoverage.length === 0
    || allCoverage.some((surface) => surface.state === "unreviewed" || surface.state === "in_progress" || surface.state === "limited");
  // A repository map and scanner receipts alone never establish model-led code research.
  const unresolvedResearch = (allHypotheses.length === 0 && !ledger.records.some((record) => record.entry.kind === "review_unit")) || allHypotheses.some((hypothesis) =>
    hypothesis.state === "planned" || hypothesis.state === "investigating" || hypothesis.state === "unresolved")
    || ledger.records.some((record) => record.entry.kind === "open_question" && !record.entry.resolution)
    || (() => {
      const latest = latestResearchCheckpoint(ledger.records);
      return latest?.entry.kind === "checkpoint" && latest.entry.openRecordIds.some((id) => {
        const record = ledger.records.find((candidate) => candidate.id === id);
        return !record || (record.entry.kind === "hypothesis"
          ? ["planned", "investigating", "unresolved"].includes(record.entry.state)
          : record.entry.kind === "open_question" ? !record.entry.resolution
          : record.entry.kind === "review_unit" ? !["reviewed", "not_applicable"].includes(record.entry.state) : true);
      });
    })();
  const incompleteProbes = ledger.status.lanes.some((lane) => lane.state !== "completed" && lane.state !== "skipped");
  const nextResearchWork = ledger.status.mode === "deep_research"
    ? unfinishedResearch(ledger.records, ledger.codeEvidence, ledger.inventory ?? null)
      ?? unfinishedScannerTriage(ledger.records, ledger.observations)
    : null;
  const accountableWork = nextResearchWork !== null;
  const terminalState = incompleteCoverage || unresolvedResearch || incompleteProbes || accountableWork ? "partial" : "completed";
  return securityScanStatusSchema.parse({
    ...ledger.status,
    state: terminalState,
    phase: null,
    terminalState,
    modelState: ledger.status.mode === "scanners_only" ? "disabled" : "completed",
    completedSteps: ledger.status.totalSteps,
    coverage,
    hypotheses,
    researchProgress: {
      ...researchProgress(ledger.records, ledger.codeEvidence, ledger.inventory ?? null, allCoverage.length, allHypotheses.length, coverage.length, hypotheses.length),
      nextResearchWork,
    },
  });
}

function parseReceipt(value: unknown): StoredReceipt {
  if (!isRecord(value) || !exactKeys(value, ["toolCallId", "operationSha256"])) {
    throw safeError("artifact_corrupt", "Security research idempotency state is invalid.");
  }
  const toolCallId = zToken(value["toolCallId"], 512);
  const operationSha256 = sha256(value["operationSha256"]);
  if (toolCallId === null || operationSha256 === null) {
    throw safeError("artifact_corrupt", "Security research idempotency state is invalid.");
  }
  return { toolCallId, operationSha256 };
}

function operationSha256(operation: unknown): string {
  return createHash("sha256").update(JSON.stringify(operation)).digest("hex");
}

function receiptWasApplied(ledger: StoredLedger, toolCallId: string, digest: string): boolean {
  const receipt = ledger.receipts.find((item) => item.toolCallId === toolCallId);
  if (receipt === undefined) return false;
  if (receipt.operationSha256 !== digest) throw safeError("record_conflict", "Security research tool-call receipt conflicts with this operation.");
  return true;
}

function appendReceipt(ledger: StoredLedger, toolCallId: string, digest: string): readonly StoredReceipt[] {
  if (receiptWasApplied(ledger, toolCallId, digest)) return ledger.receipts;
  return [...ledger.receipts, { toolCallId, operationSha256: digest }];
}

function recordIdForToolCall(toolCallId: string): string {
  return `record_${createHash("sha256").update(toolCallId).digest("hex").slice(0, 24)}`;
}

async function fsync(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function fsyncDirectory(path: string): Promise<void> {
  try { await fsync(path); } catch { /* Filesystem-specific directory fsync is best effort. */ }
}

/**
 * One JSON artifact per scan. The class intentionally has no method accepting
 * a ledger path, root path, executable, output stream, or source excerpt.
 */
export class DesktopSecurityScanLedger {
  readonly #userDataRoot: string;
  readonly #citationReader: SecurityScanCitationReader;
  readonly #rootIdentityReader: SecurityScanRootIdentityReader;
  readonly #now: () => Date;
  readonly #tails = new Map<string, Promise<void>>();

  constructor(options: DesktopSecurityScanLedgerOptions) {
    this.#userDataRoot = options.userDataRoot;
    this.#citationReader = options.citationReader;
    this.#rootIdentityReader = options.rootIdentityReader;
    this.#now = options.now ?? (() => new Date());
  }

  async create(input: CreateSecurityScanLedgerInput): Promise<SecurityScanStatus> {
    const scanId = this.#parseScanId(input.scanId);
    const trusted = parseTrusted(input.trusted);
    const localOwnerId = this.#parseLocalOwnerId(input.localOwnerId);
    const rootIdentity = parseRootIdentity({
      fingerprint: input.rootIdentity.fingerprint,
      device: input.rootIdentity.device,
      inode: input.rootIdentity.inode,
      gitHead: input.rootIdentity.gitHead,
      gitDirty: input.rootIdentity.gitDirty,
    });
    const receiptDigest = operationSha256({ kind: "create", scanId, mode: input.mode, targetDirectory: input.targetDirectory ?? ".", targetFingerprint: input.targetFingerprint, localOwnerId, rootIdentity, trusted });
    if (input.mode === "deep_research" && trusted.modelId === null) {
      throw safeError("model_unavailable", "Deep security research requires the Task-resolved model.");
    }
    return this.#withWriter(scanId, async () => {
      const existing = await this.#readIfPresent(scanId);
      if (existing) {
        if (receiptWasApplied(existing, trusted.toolCallId, receiptDigest)) return existing.status;
        throw safeError("record_conflict", "Security research ledger already exists.");
      }
      const openedAt = canonicalTime(this.#now);
      const origin: StoredTaskRun = {
        taskId: trusted.taskId,
        taskRunId: trusted.taskRunId,
        modelId: trusted.modelId,
        openedAt,
      };
      const ledger: StoredLedger = {
        version: LEDGER_VERSION,
        scanId,
        localOwnerId,
        rootIdentity,
        origin,
        continuations: [],
        status: { ...initialStatus(scanId, input.mode, input.mode === "scanners_only" ? null : trusted.modelId), targetDirectory: input.targetDirectory ?? ".", ...(input.targetFingerprint ? { targetFingerprint: input.targetFingerprint } : {}) },
        observations: [],
        codeEvidence: [],
        records: [],
        receipts: [{ toolCallId: trusted.toolCallId, operationSha256: receiptDigest }],
      };
      await this.#write(scanId, ledger);
      return ledger.status;
    });
  }

  async reopen(input: ReopenSecurityScanLedgerInput): Promise<SecurityScanStatus> {
    const scanId = this.#parseScanId(input.scanId);
    const trusted = parseTrusted(input.trusted);
    const localOwnerId = this.#parseLocalOwnerId(input.localOwnerId);
    const rootIdentity = parseRootIdentity({
      fingerprint: input.rootIdentity.fingerprint,
      device: input.rootIdentity.device,
      inode: input.rootIdentity.inode,
      gitHead: input.rootIdentity.gitHead,
      gitDirty: input.rootIdentity.gitDirty,
    });
    const receiptDigest = operationSha256({ kind: "reopen", scanId, localOwnerId, rootIdentity, trusted });
    return this.#withWriter(scanId, async () => {
      const ledger = await this.#readRequired(scanId);
      if ((input.targetDirectory !== undefined && input.targetDirectory !== (ledger.status.targetDirectory ?? "."))
        || (input.targetFingerprint !== undefined && ledger.status.targetFingerprint !== undefined && input.targetFingerprint !== ledger.status.targetFingerprint)) {
        throw safeError("root_not_authorized", "The scan target cannot change when resuming a ledger.");
      }
      await this.#authorize(ledger, trusted, localOwnerId, rootIdentity, { allowNewTaskRun: true });
      if (receiptWasApplied(ledger, trusted.toolCallId, receiptDigest)) return ledger.status;
      if (this.#hasTaskRun(ledger, trusted)) {
        throw safeError("record_conflict", "This TaskRun already has security research lineage.");
      }
      const nextStatus = securityScanStatusSchema.parse({
        ...ledger.status,
        state: "active",
        phase: "admitting",
        terminalState: null,
        modelId: ledger.status.mode === "scanners_only" ? null : trusted.modelId,
        modelState: ledger.status.mode === "scanners_only" ? "disabled" : "pending",
      });
      const next: StoredLedger = {
        ...ledger,
        continuations: [...ledger.continuations, {
          taskId: trusted.taskId,
          taskRunId: trusted.taskRunId,
          modelId: trusted.modelId,
          openedAt: canonicalTime(this.#now),
        }],
        status: nextStatus,
        receipts: appendReceipt(ledger, trusted.toolCallId, receiptDigest),
      };
      await this.#write(scanId, next);
      return next.status;
    });
  }

  /** Trusted Desktop metadata, never accepted from model record arguments. */
  async updateInventory(input: SecurityScanLedgerAccess & { inventory: readonly SecurityScanInventoryEntry[] }): Promise<void> {
    const scanId = this.#parseScanId(input.scanId);
    const trusted = parseTrusted(input.trusted);
    const localOwnerId = this.#parseLocalOwnerId(input.localOwnerId);
    const rootIdentity = this.#parseRootIdentityInput(input.rootIdentity);
    const inventory = input.inventory.map((entry) => securityScanInventoryEntrySchema.parse(entry));
    if (new Set(inventory.map((entry) => entry.relativePath)).size !== inventory.length) throw safeError("invalid_request", "Inventory paths must be unique.");
    await this.#withWriter(scanId, async () => {
      const ledger = await this.#readRequired(scanId);
      await this.#authorize(ledger, trusted, localOwnerId, rootIdentity);
      this.#assertActive(ledger);
      if (ledger.inventory && securityInventoryFingerprint(ledger.inventory) === securityInventoryFingerprint(inventory)) return;
      const priorByPath = new Map(ledger.inventory?.map((entry) => [entry.relativePath, entry]) ?? []);
      const nextByPath = new Map(inventory.map((entry) => [entry.relativePath, entry]));
      const changed = (path: string) => {
        const before = priorByPath.get(path);
        const after = nextByPath.get(path);
        return !before || !after || before.sourceVersion !== after.sourceVersion || before.kind !== after.kind;
      };
      const records = ledger.records.map((record): SecurityScanLedgerRecord => {
        if (record.entry.kind !== "review_unit" || !record.entry.paths.some(changed)) return record;
        return { ...record, revision: record.revision + 1, updatedAt: canonicalTime(this.#now),
          updatedBy: { taskId: trusted.taskId, taskRunId: trusted.taskRunId, modelId: trusted.modelId },
          entry: { ...record.entry, state: "in_progress", evidenceRefs: [], counterevidenceRefs: [] } };
      });
      await this.#write(scanId, { ...ledger, inventory, records });
    });
  }

  /** Resolve the one ledger already authorized for this exact durable TaskRun. */
  async scanIdForTaskRun(input: SecurityScanLedgerBindingInput): Promise<string> {
    const trusted = parseTrusted(input.trusted);
    const localOwnerId = this.#parseLocalOwnerId(input.localOwnerId);
    const rootIdentity = this.#parseRootIdentityInput(input.rootIdentity);
    const ownedRoot = await this.#ensureOwnedRoot();
    const entries = (await readdir(ownedRoot, { withFileTypes: true }))
      .filter((entry) => securityScanIdSchema.safeParse(entry.name).success)
      .sort((a, b) => a.name.localeCompare(b.name));
    const matches: StoredLedger[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw safeError("artifact_corrupt", "Security research ledger directory is invalid.");
      }
      const ledger = await this.#readRequired(entry.name);
      if (ledger.localOwnerId !== localOwnerId || !rootIdentityEquals(ledger.rootIdentity, rootIdentity)) continue;
      const taskRun = this.#findTaskRun(ledger, trusted);
      if (taskRun === undefined) continue;
      if (taskRun.modelId !== trusted.modelId) {
        throw safeError("model_unavailable", "The TaskRun model does not match this security research ledger.");
      }
      matches.push(ledger);
    }
    if (matches.length === 0) {
      throw safeError("scan_not_found", "This TaskRun has no security research ledger. Start security research first.");
    }
    if (matches.length > 1) {
      throw safeError("record_conflict", "This TaskRun has more than one security research ledger.");
    }
    await this.#authorize(matches[0]!, trusted, localOwnerId, rootIdentity);
    return matches[0]!.scanId;
  }

  async status(input: SecurityScanLedgerAccess): Promise<SecurityScanStatus> {
    const scanId = this.#parseScanId(input.scanId);
    const trusted = parseTrusted(input.trusted);
    const localOwnerId = this.#parseLocalOwnerId(input.localOwnerId);
    const rootIdentity = this.#parseRootIdentityInput(input.rootIdentity);
    const ledger = await this.#readRequired(scanId);
    await this.#authorize(ledger, trusted, localOwnerId, rootIdentity);
    return { ...finalResearchStatus(ledger), state: ledger.status.state,
      terminalState: ledger.status.terminalState, phase: ledger.status.phase,
      modelState: ledger.status.modelState, completedSteps: ledger.status.completedSteps };
  }

  async results(input: SecurityScanLedgerResultsInput): Promise<SecurityScanResultEnvelope> {
    const operation = securityScanOperationSchema.parse(input.operation);
    if (operation.operation !== "results") throw safeError("invalid_request", "Security research results request is invalid.");
    const trusted = parseTrusted(input.trusted);
    const localOwnerId = this.#parseLocalOwnerId(input.localOwnerId);
    const rootIdentity = this.#parseRootIdentityInput(input.rootIdentity);
    const ledger = await this.#readRequired(operation.scanId);
    await this.#authorize(ledger, trusted, localOwnerId, rootIdentity);
    const records = ledger.records
      .filter((item) => (operation.recordKinds === undefined || operation.recordKinds.includes(item.entry.kind))
        && (operation.recordIds === undefined || operation.recordIds.includes(item.id)));
    const observations = ledger.observations
      .filter((item) => operation.probes === undefined || operation.probes.includes(item.probe));
    const selectedCode = new Set(records.flatMap((record) => [...record.entry.evidenceRefs, ...("counterevidenceRefs" in record.entry ? record.entry.counterevidenceRefs : [])])
      .filter((ref) => ref.kind === "code_evidence").map((ref) => ref.id));
    const codeEvidence = ledger.codeEvidence.filter((entry) => operation.recordIds === undefined || selectedCode.has(entry.id));
    const all = [
      ...(operation.category === "research" || operation.category === "inventory" || operation.recordIds !== undefined ? [] : observations.map((item) => ({ id: item.id, kind: "observation" as const, value: item }))),
      ...(operation.category === "observations" || operation.category === "inventory" ? [] : codeEvidence.map((item) => ({ id: item.id, kind: "code_evidence" as const, value: item }))),
      ...(operation.category === "observations" || operation.category === "inventory" ? [] : records.map((item) => ({ id: item.id, kind: "record" as const, value: item }))),
      ...(operation.category === "observations" || operation.recordKinds !== undefined || operation.recordIds !== undefined ? [] : (ledger.inventory ?? []).map((item) => ({ id: item.id, kind: "inventory" as const, value: item }))),
    ].sort((a, b) => a.id.localeCompare(b.id));
    // Stateless cursor binds the exact authorized query and selected evidence version.
    // A cursor from inventory, a filtered note lookup, or an earlier revision can
    // never skip items in another query and still qualify its tail as a report.
    const resultHash = createHash("sha256");
    for (const item of all) resultHash.update(item.id).update("\0").update(JSON.stringify(item.value)).update("\0");
    const resultVersion = resultHash.digest("hex");
    const cursorBinding = operationSha256({
      scanId: ledger.scanId, taskId: trusted.taskId, taskRunId: trusted.taskRunId,
      category: operation.category, finalize: operation.finalize,
      probes: operation.probes === undefined ? null : [...new Set(operation.probes)].sort(),
      recordKinds: operation.recordKinds === undefined ? null : [...new Set(operation.recordKinds)].sort(),
      recordIds: operation.recordIds === undefined ? null : [...new Set(operation.recordIds)].sort(),
      resultVersion,
    });
    const cursorFor = (id: string) => `cursor_${operationSha256({ cursorBinding, id })}`;
    const cursorIndex = operation.cursor === undefined ? -1 : all.findIndex((item) => cursorFor(item.id) === operation.cursor);
    if (operation.cursor !== undefined && cursorIndex === -1) {
      throw safeError("invalid_request", "Results cursor is stale or belongs to a different query. Restart this exact results query without continueResults or cursor, then follow its newly returned pages.");
    }
    const afterCursor = all.slice(cursorIndex + 1);
    const page = afterCursor.slice(0, operation.limit);
    return {
      version: SECURITY_SCAN_VERSION,
      ...(operation.category === "all" && operation.probes === undefined && operation.recordKinds === undefined
        && operation.recordIds === undefined && ledger.status.modelState === "completed"
        && (ledger.status.state === "completed" || ledger.status.state === "partial")
        ? { exportSnapshot: { sha256: resultVersion, itemCount: all.length } } : {}),
      status: { ...finalResearchStatus(ledger), state: ledger.status.state,
        terminalState: ledger.status.terminalState, phase: ledger.status.phase,
        modelState: ledger.status.modelState, completedSteps: ledger.status.completedSteps },
      reportReady: operation.finalize && operation.category === "all"
        && operation.probes === undefined && operation.recordKinds === undefined && operation.recordIds === undefined
        && afterCursor.length <= page.length && ledger.codeEvidence.length > 0
        && ledger.status.coverage.length > 0 && ledger.status.modelState === "completed"
        && (ledger.status.state === "completed" || ledger.status.state === "partial"),
      observations: page.filter((item) => item.kind === "observation").map((item) => item.value),
      codeEvidence: page.filter((item) => item.kind === "code_evidence").map((item) => item.value),
      records: page.filter((item) => item.kind === "record").map((item) => item.value),
      inventory: page.filter((item) => item.kind === "inventory").map((item) => item.value),
      nextCursor: afterCursor.length > page.length ? cursorFor(page.at(-1)!.id) : null,
    };
  }

  async appendOrUpdate(input: AppendSecurityScanLedgerRecordInput): Promise<SecurityScanRecordAcknowledgement> {
    const operation = securityScanOperationSchema.parse(input.operation);
    if (operation.operation !== "record") throw safeError("invalid_request", "Security research record request is invalid.");
    const trusted = parseTrusted(input.trusted);
    const localOwnerId = this.#parseLocalOwnerId(input.localOwnerId);
    const rootIdentity = this.#parseRootIdentityInput(input.rootIdentity);
    const receiptDigest = operationSha256({ kind: "record", operation, localOwnerId, rootIdentity, trusted });
    return this.#withWriter(operation.scanId, async () => {
      const ledger = await this.#readRequired(operation.scanId);
      await this.#authorize(ledger, trusted, localOwnerId, rootIdentity);
      if (receiptWasApplied(ledger, trusted.toolCallId, receiptDigest)) {
        const id = recordIdForToolCall(trusted.toolCallId);
        const existing = ledger.records.find((item) => item.id === id || item.id === operation.recordId);
        if (existing) {
          // A retry acknowledges only this invocation's minted citation batch.
          // Accumulated links remain in the record and full results, not this batch.
          const mintedIds = new Set(operation.fileCitations.map((_citation, index) => codeEvidenceIdForToolCall(trusted.toolCallId, index)));
          return {
            researchProgress: finalResearchStatus(ledger).researchProgress,
            record: existing,
            codeEvidence: ledger.codeEvidence.filter((item) => mintedIds.has(item.id)),
          };
        }
        throw safeError("record_conflict", "Security research write was already applied.");
      }
      this.#assertActive(ledger);
      const codeEvidence = await this.#mintCodeEvidence(operation.fileCitations, trusted.toolCallId, ledger.rootIdentity);
      const timestamp = canonicalTime(this.#now);
      const recordId = operation.action === "append" ? recordIdForToolCall(trusted.toolCallId) : operation.recordId!;
      const existingIndex = ledger.records.findIndex((item) => item.id === recordId);
      if (operation.action === "append" && existingIndex !== -1) {
        throw safeError("record_conflict", "Security research record identifier already exists.");
      }
      if (operation.action === "update" && existingIndex === -1) {
        throw safeError("evidence_not_found", "Security research record was not found.");
      }
      const prior = existingIndex === -1 ? null : ledger.records[existingIndex]!;
      if (operation.action === "update" && prior!.revision !== operation.expectedRevision) {
        throw safeError("record_conflict", "Security research record revision is stale.");
      }
      if (prior !== null && prior.entry.kind !== operation.entry.kind) {
        throw safeError("record_conflict", "Security research record kind cannot change during an update.");
      }
      const baseEntry = prior?.entry ?? {};
      const evidenceRefs = operation.entry.evidenceRefs ?? prior?.entry.evidenceRefs ?? [];
      const mergedEntry = {
        ...baseEntry,
        ...operation.entry,
        evidenceRefs: [...evidenceRefs, ...codeEvidence.map((item) => ({ kind: "code_evidence" as const, id: item.id }))],
      };
      const parsedEntry = securityScanRecordInputSchema.safeParse(this.#normalizeAdvisoryReferences(
        mergedEntry,
        recordId,
        ledger,
        codeEvidence,
      ));
      if (!parsedEntry.success) {
        // Only fixed schema field names enter guidance, never raw model values or
        // exception text. A rejected merge has not changed the durable record.
        const fields = ["kind", "summary", "surfaceKey", "paths", "state", "trace", "notes", "blocker",
          "evidenceRefs", "counterevidenceRefs", "openRecordIds", "surfaces", "title", "confidence",
          "impact", "exploitPreconditions", "rationale", "question", "resolution", "nextWork"];
        const invalidFields = fields.filter((field) => parsedEntry.error.issues.some((issue) => issue.path[0] === field));
        throw new SecurityScanLedgerError("invalid_request", "Security research record fields are invalid after merging the update.",
          `Reload this record and correct ${invalidFields.length > 0 ? invalidFields.join(", ") : "the fields required by entry.kind"}. Preserve required fields and retry with its current expectedRevision. Nothing was written.`);
      }
      const entry = parsedEntry.data;
      if (prior?.entry.kind === "repository_map" && entry.kind === "repository_map"
        && prior.entry.surfaces.some((surface) => !entry.surfaces.some((next) => next.key === surface.key))) {
        throw safeError("record_conflict", "A repository map update cannot remove requested sections; record a supported not_applicable coverage decision instead.");
      }
      if (entry.kind === "review_unit") {
        const unchanged = prior === null ? "Nothing was written."
          : `Nothing was written. The existing record and revision ${prior.revision} are unchanged.`;
        if (!ledger.inventory) {
          throw new SecurityScanLedgerError("evidence_not_found", `Trusted source inventory is not available. ${unchanged}`,
            "Check this scan's status and wait for its trusted inventory before submitting review unit paths. Do not start a replacement scan.");
        }
        const inventoryPaths = new Set(ledger.inventory.filter((item) => item.kind === "file").map((item) => item.relativePath));
        // Diagnostics identify every rejected field, never echo model-supplied
        // path text. Validation remains atomic; valid siblings are not applied.
        const invalidPathFields = entry.paths.flatMap((path, index) => inventoryPaths.has(path) ? [] : [`entry.paths[${index}]`]);
        if (invalidPathFields.length > 0) {
          throw new SecurityScanLedgerError("evidence_not_found",
            `These zero-based fields do not name files in this scan's trusted inventory: ${invalidPathFields.join(", ")}. ${unchanged}`,
            "Correct the identified fields using exact inventory paths and retry the intended record update. If those paths are unknown, request results with category inventory and a smaller limit; use continueResults:true on subsequent pages. Preserve the other intended fields and the unchanged expectedRevision for an update.");
        }
        for (const id of entry.openRecordIds) {
          if (id === recordId || !ledger.records.some((record) => record.id === id)) throw safeError("evidence_not_found", "Review follow-ups must reference existing records in this scan.");
        }
        if (prior?.entry.kind === "review_unit") {
          const removed = prior.entry.openRecordIds.filter((id) => !entry.openRecordIds.includes(id));
          for (const id of removed) {
            const previous = ledger.records.find((record) => record.id === id)?.entry;
            const resolved = previous?.kind === "hypothesis" ? ["supported", "rejected"].includes(previous.state)
              : previous?.kind === "open_question" ? Boolean(previous.resolution)
              : previous?.kind === "review_unit" ? ["reviewed", "not_applicable"].includes(previous.state) : false;
            if (!resolved) throw safeError("record_conflict", "A review unit cannot drop an unresolved follow-up; resolve that exact record first.");
          }
        }
      }
      this.#assertEvidenceReferences(entry, recordId, ledger, codeEvidence);
      const author = { taskId: trusted.taskId, taskRunId: trusted.taskRunId, modelId: trusted.modelId };
      const record = securityScanLedgerRecordSchema.parse({
        id: recordId,
        revision: (prior?.revision ?? 0) + 1,
        createdAt: prior?.createdAt ?? timestamp,
        updatedAt: timestamp,
        createdBy: prior?.createdBy ?? author,
        updatedBy: author,
        entry,
      });
      const records = existingIndex === -1
        ? [...ledger.records, record]
        : entry.kind === "checkpoint"
          ? [...ledger.records.filter((item) => item.id !== record.id), record]
          : ledger.records.map((item, index) => index === existingIndex ? record : item);
      const existingIds = new Set([
        ...ledger.observations.map((item) => item.id),
        ...ledger.codeEvidence.map((item) => item.id),
        ...ledger.records.map((item) => item.id),
      ]);
      if (codeEvidence.some((item) => existingIds.has(item.id))) {
        throw safeError("record_conflict", "Security research code evidence identifier already exists.");
      }
      const next: StoredLedger = {
        ...ledger,
        records,
        codeEvidence: [...ledger.codeEvidence, ...codeEvidence],
        receipts: appendReceipt(ledger, trusted.toolCallId, receiptDigest),
      };
      if (entry.kind === "review_unit" && ["reviewed", "not_applicable"].includes(entry.state)) {
        const issue = reviewUnitCompletionIssue(record.id, next.records, next.codeEvidence, next.inventory ?? null);
        if (issue) throw safeError("record_conflict", issue);
      }
      await this.#write(operation.scanId, next, async () => {
        await this.#verifyMintedEvidence(operation.fileCitations, codeEvidence, ledger.rootIdentity);
      });
      return { record, codeEvidence, researchProgress: finalResearchStatus(next).researchProgress };
    });
  }

  async appendObservation(input: AppendSecurityScanObservationInput): Promise<SecurityScanObservation> {
    const scanId = this.#parseScanId(input.scanId);
    const observation = securityScanObservationSchema.parse(input.observation);
    const trusted = parseTrusted(input.trusted);
    const localOwnerId = this.#parseLocalOwnerId(input.localOwnerId);
    const rootIdentity = this.#parseRootIdentityInput(input.rootIdentity);
    const receiptDigest = operationSha256({ kind: "observation", scanId, observation, localOwnerId, rootIdentity, trusted });
    return this.#withWriter(scanId, async () => {
      const ledger = await this.#readRequired(scanId);
      await this.#authorize(ledger, trusted, localOwnerId, rootIdentity);
      if (receiptWasApplied(ledger, trusted.toolCallId, receiptDigest)) {
        const existing = ledger.observations.find((item) => item.id === observation.id);
        if (existing) return existing;
        throw safeError("record_conflict", "Security research write was already applied.");
      }
      this.#assertActive(ledger);
      if (ledger.observations.some((item) => item.id === observation.id)
        || ledger.codeEvidence.some((item) => item.id === observation.id)
        || ledger.records.some((item) => item.id === observation.id)) {
        throw safeError("record_conflict", "Security research observation identifier already exists.");
      }
      const next: StoredLedger = {
        ...ledger,
        observations: [...ledger.observations, observation],
        receipts: appendReceipt(ledger, trusted.toolCallId, receiptDigest),
      };
      await this.#write(scanId, next);
      return observation;
    });
  }

  /** Admit one completed probe suite atomically instead of rewriting the ledger per finding. */
  async appendObservations(input: Omit<AppendSecurityScanObservationInput, "observation"> & {
    observations: readonly SecurityScanObservation[];
  }): Promise<void> {
    const scanId = this.#parseScanId(input.scanId);
    const observations = input.observations.map((observation) => securityScanObservationSchema.parse(observation));
    const trusted = parseTrusted(input.trusted);
    const localOwnerId = this.#parseLocalOwnerId(input.localOwnerId);
    const rootIdentity = this.#parseRootIdentityInput(input.rootIdentity);
    const receiptDigest = operationSha256({ kind: "observations", scanId, observations, localOwnerId, rootIdentity, trusted });
    await this.#withWriter(scanId, async () => {
      const ledger = await this.#readRequired(scanId);
      await this.#authorize(ledger, trusted, localOwnerId, rootIdentity);
      if (receiptWasApplied(ledger, trusted.toolCallId, receiptDigest)) return;
      this.#assertActive(ledger);
      const ids = new Set([...ledger.observations, ...ledger.codeEvidence, ...ledger.records].map((item) => item.id));
      for (const observation of observations) {
        if (ids.has(observation.id)) throw safeError("record_conflict", "Security research observation identifier already exists.");
        ids.add(observation.id);
      }
      await this.#write(scanId, { ...ledger,
        observations: [...ledger.observations, ...observations],
        receipts: appendReceipt(ledger, trusted.toolCallId, receiptDigest),
      });
    });
  }

  async updateStatus(input: UpdateSecurityScanStatusInput): Promise<SecurityScanStatus> {
    const status = securityScanStatusSchema.parse(input.status);
    const trusted = parseTrusted(input.trusted);
    const localOwnerId = this.#parseLocalOwnerId(input.localOwnerId);
    const rootIdentity = this.#parseRootIdentityInput(input.rootIdentity);
    const receiptDigest = operationSha256({ kind: "status", status, localOwnerId, rootIdentity, trusted });
    return this.#withWriter(status.scanId, async () => {
      const ledger = await this.#readRequired(status.scanId);
      await this.#authorize(ledger, trusted, localOwnerId, rootIdentity);
      if (receiptWasApplied(ledger, trusted.toolCallId, receiptDigest)) return ledger.status;
      this.#assertActive(ledger);
      if (status.modelId !== ledger.status.modelId) {
        throw safeError("model_unavailable", "Security research status cannot change the Task model.");
      }
      const next: StoredLedger = {
        ...ledger,
        status,
        receipts: appendReceipt(ledger, trusted.toolCallId, receiptDigest),
      };
      await this.#write(status.scanId, next);
      return status;
    });
  }

  async finalize(input: FinalizeSecurityScanLedgerInput): Promise<SecurityScanStatus> {
    const scanId = this.#parseScanId(input.scanId);
    const trusted = parseTrusted(input.trusted);
    const localOwnerId = this.#parseLocalOwnerId(input.localOwnerId);
    const rootIdentity = this.#parseRootIdentityInput(input.rootIdentity);
    const receiptDigest = operationSha256({ kind: "finalize", scanId, localOwnerId, rootIdentity, trusted });
    return this.#withWriter(scanId, async () => {
      const ledger = await this.#readRequired(scanId);
      await this.#authorize(ledger, trusted, localOwnerId, rootIdentity);
      if (receiptWasApplied(ledger, trusted.toolCallId, receiptDigest) || ledger.status.state !== "active") {
        return ledger.status;
      }
      if (ledger.status.mode === "deep_research") {
        const remaining = unfinishedResearch(ledger.records, ledger.codeEvidence, ledger.inventory ?? null)
          ?? unfinishedScannerTriage(ledger.records, ledger.observations);
        if (remaining) throw new SecurityScanLedgerError("research_incomplete", "Research remains incomplete. Continue this same active scan.",
          remaining + " Use status or paged research results for the complete plan.");
        await this.#verifyTerminalEvidence(ledger);
      }
      const status = finalResearchStatus(ledger);
      const next: StoredLedger = {
        ...ledger,
        status,
        receipts: appendReceipt(ledger, trusted.toolCallId, receiptDigest),
      };
      await this.#write(scanId, next);
      return status;
    });
  }

  async cancel(input: CancelSecurityScanLedgerInput): Promise<SecurityScanStatus> {
    const scanId = this.#parseScanId(input.scanId);
    const trusted = parseTrusted(input.trusted);
    const localOwnerId = this.#parseLocalOwnerId(input.localOwnerId);
    const rootIdentity = this.#parseRootIdentityInput(input.rootIdentity);
    const receiptDigest = operationSha256({ kind: "cancel", scanId, localOwnerId, rootIdentity, trusted });
    return this.#withWriter(scanId, async () => {
      const ledger = await this.#readRequired(scanId);
      await this.#authorize(ledger, trusted, localOwnerId, rootIdentity);
      if (receiptWasApplied(ledger, trusted.toolCallId, receiptDigest)) return ledger.status;
      this.#assertActive(ledger);
      const status = securityScanStatusSchema.parse({
        ...ledger.status,
        state: "cancelled",
        phase: null,
        terminalState: "cancelled",
        modelState: ledger.status.mode === "scanners_only" ? "disabled" : "cancelled",
      });
      const next: StoredLedger = {
        ...ledger,
        status,
        receipts: appendReceipt(ledger, trusted.toolCallId, receiptDigest),
      };
      await this.#write(scanId, next);
      return status;
    });
  }

  #parseScanId(scanId: string): string {
    const parsed = securityScanIdSchema.safeParse(scanId);
    if (!parsed.success) throw safeError("invalid_request", "Security research scan identifier is invalid.");
    return parsed.data;
  }

  #parseLocalOwnerId(localOwnerId: string): string {
    const parsed = identityToken(localOwnerId);
    if (parsed === null) throw safeError("invalid_request", "Security research local owner is invalid.");
    return parsed;
  }

  #parseRootIdentityInput(value: SecurityScanLedgerRootIdentity): SecurityScanLedgerRootIdentity {
    return parseRootIdentity({
      fingerprint: value.fingerprint,
      device: value.device,
      inode: value.inode,
      gitHead: value.gitHead,
      gitDirty: value.gitDirty,
    });
  }

  async #authorize(
    ledger: StoredLedger,
    trusted: SecurityScanTrustedContext,
    localOwnerId: string,
    rootIdentity: SecurityScanLedgerRootIdentity,
    options: { readonly allowNewTaskRun?: boolean } = {},
  ): Promise<void> {
    if (ledger.localOwnerId !== localOwnerId || !rootIdentityEquals(ledger.rootIdentity, rootIdentity)) {
      throw safeError("root_revoked", "The authorized working folder identity changed.");
    }
    const knownTaskRun = this.#findTaskRun(ledger, trusted);
    if (knownTaskRun !== undefined && knownTaskRun.modelId !== trusted.modelId) {
      throw safeError("model_unavailable", "The TaskRun model does not match this security research ledger.");
    }
    if (knownTaskRun === undefined && !options.allowNewTaskRun) {
      throw safeError("scan_not_active", "This TaskRun is not authorized for the security research ledger.");
    }
    const liveRoot = this.#parseRootIdentityInput(await this.#rootIdentityReader.revalidate(ledger.rootIdentity));
    if (!rootIdentityEquals(ledger.rootIdentity, liveRoot)) {
      throw safeError("root_revoked", "The authorized working folder identity changed.");
    }
  }

  #findTaskRun(ledger: StoredLedger, trusted: SecurityScanTrustedContext): StoredTaskRun | undefined {
    return [ledger.origin, ...ledger.continuations].find((item) => item.taskId === trusted.taskId
      && item.taskRunId === trusted.taskRunId);
  }

  #hasTaskRun(ledger: StoredLedger, trusted: SecurityScanTrustedContext): boolean {
    return this.#findTaskRun(ledger, trusted) !== undefined;
  }

  #assertActive(ledger: StoredLedger): void {
    if (ledger.status.state !== "active") {
      throw safeError("scan_not_active", "Security research is terminal; reopen it before making another mutation.");
    }
  }

  #assertEvidenceReferences(
    entry: SecurityScanRecordInput,
    targetRecordId: string,
    ledger: StoredLedger,
    mintedCodeEvidence: readonly SecurityScanCodeEvidence[],
  ): void {
    const observationIds = new Set(ledger.observations.map((item) => item.id));
    const codeEvidenceIds = new Set([...ledger.codeEvidence, ...mintedCodeEvidence].map((item) => item.id));
    const recordIds = new Set(ledger.records.map((item) => item.id));
    const references = [
      ...entry.evidenceRefs,
      ...("counterevidenceRefs" in entry ? entry.counterevidenceRefs : []),
    ];
    for (const reference of references) {
      if (reference.kind === "ledger_record" && reference.id === targetRecordId) {
        throw safeError("record_conflict", "Security research records cannot cite themselves as evidence.");
      }
      const exists = reference.kind === "scanner_observation"
        ? observationIds.has(reference.id)
        : reference.kind === "code_evidence"
          ? codeEvidenceIds.has(reference.id)
          : recordIds.has(reference.id);
      if (!exists) {
        throw safeError("evidence_not_found", "Security research evidence reference was not found in this ledger.");
      }
    }
  }

  #normalizeAdvisoryReferences(
    entry: Record<string, unknown>,
    targetRecordId: string,
    ledger: StoredLedger,
    mintedCodeEvidence: readonly SecurityScanCodeEvidence[],
  ): Record<string, unknown> {
    const kind = entry["kind"];
    if (
      kind !== "repository_map"
      && kind !== "hypothesis"
      && kind !== "coverage"
      && kind !== "checkpoint"
      && kind !== "open_question"
    ) return entry;

    const observationIds = new Set(ledger.observations.map((item) => item.id));
    const codeEvidenceIds = new Set([...ledger.codeEvidence, ...mintedCodeEvidence].map((item) => item.id));
    const recordIds = new Set(ledger.records.map((item) => item.id));
    const referenceExists = (reference: { readonly kind: string; readonly id: string }): boolean =>
      reference.id === targetRecordId
      || (reference.kind === "scanner_observation"
        ? observationIds.has(reference.id)
        : reference.kind === "code_evidence"
          ? codeEvidenceIds.has(reference.id)
          : recordIds.has(reference.id));
    const filterReferences = (value: unknown): unknown => Array.isArray(value)
      ? value.filter((reference): reference is { readonly kind: string; readonly id: string } =>
          reference !== null
          && typeof reference === "object"
          && typeof (reference as { kind?: unknown }).kind === "string"
          && typeof (reference as { id?: unknown }).id === "string"
          && referenceExists(reference as { readonly kind: string; readonly id: string }))
      : value;
    const normalized: Record<string, unknown> = {
      ...entry,
      evidenceRefs: filterReferences(entry["evidenceRefs"]),
      ...(entry["counterevidenceRefs"] === undefined
        ? {}
        : { counterevidenceRefs: filterReferences(entry["counterevidenceRefs"]) }),
    };
    if (kind === "checkpoint" && Array.isArray(entry["openRecordIds"])) {
      normalized["openRecordIds"] = entry["openRecordIds"].filter((id): id is string =>
        typeof id === "string" && id !== targetRecordId && recordIds.has(id));
    }
    if (
      kind === "hypothesis"
      && (entry["state"] === "supported" || entry["state"] === "rejected")
      && Array.isArray(normalized["evidenceRefs"])
      && normalized["evidenceRefs"].length === 0
      && Array.isArray(normalized["counterevidenceRefs"])
      && normalized["counterevidenceRefs"].length === 0
    ) normalized["state"] = "investigating";
    return normalized;
  }

  async #verifyTerminalEvidence(ledger: StoredLedger): Promise<void> {
    const owners = terminalEvidenceOwners(ledger.records);
    const files = new Map<string, SecurityScanCodeEvidence[]>();
    for (const evidence of ledger.codeEvidence) {
      if (!owners.has(evidence.id)) continue;
      const group = files.get(evidence.relativePath) ?? [];
      group.push(evidence);
      files.set(evidence.relativePath, group);
    }
    // One full-file digest per cited source, including explicitly inspected dependencies
    // outside the default inventory. Many citation ranges do not cause repeated reads.
    for (const [relativePath, evidence] of files) {
      const first = evidence[0]!;
      const fail = (item: SecurityScanCodeEvidence): never => {
        throw new SecurityScanLedgerError("research_incomplete", "A current conclusion relies on changed or unavailable source.",
          `Record ${owners.get(item.id)} cites ${item.id} (${relativePath}). Reread this source and update the exact conclusion and its linked evidence; historical notes remain preserved. Continue this same scan.`);
      };
      let current: SecurityScanCitationDigest;
      try { current = await this.#readCitation({ relativePath, startLine: 1, endLine: 1 }, ledger.rootIdentity); }
      catch (error) {
        if (error instanceof SecurityScanLedgerError && ["root_revoked", "root_unavailable"].includes(error.code)) throw error;
        fail(first);
      }
      for (const item of evidence) if (item.fileSha256 !== current!.fileSha256) fail(item);
    }
  }

  async #mintCodeEvidence(
    citations: readonly SecurityScanFileCitationInput[],
    toolCallId: string,
    rootIdentity: SecurityScanLedgerRootIdentity,
  ): Promise<SecurityScanCodeEvidence[]> {
    if (citations.length > SECURITY_SCAN_MAX_FILE_CITATIONS_PER_CALL) throw safeError("invalid_request", "Supply citations in successive record updates; omit evidenceRefs to retain prior links.");
    await this.#assertLiveRoot(rootIdentity);
    return Promise.all(citations.map(async (citation, index) => {
      const verified = await this.#readCitation(citation, rootIdentity);
      const evidence = securityScanCodeEvidenceSchema.safeParse({
        id: codeEvidenceIdForToolCall(toolCallId, index),
        relativePath: verified.relativePath,
        startLine: verified.startLine,
        endLine: verified.endLine,
        ...(verified.sourceVersion === undefined ? {} : { sourceVersion: verified.sourceVersion }),
        fileSha256: verified.fileSha256,
        rangeSha256: verified.rangeSha256,
        rootFingerprint: verified.rootFingerprint,
        capturedAt: canonicalTime(this.#now),
        gitHead: verified.gitHead,
        gitDirty: verified.gitDirty,
      });
      if (!evidence.success || verified.relativePath !== citation.relativePath || verified.startLine !== citation.startLine
        || verified.endLine !== citation.endLine || verified.rootFingerprint !== rootIdentity.fingerprint) {
        throw safeError("evidence_not_authorized", "Security research citation could not be revalidated.");
      }
      return evidence.data;
    }));
  }

  async #assertLiveRoot(expectedRoot: SecurityScanLedgerRootIdentity): Promise<void> {
    const live = this.#parseRootIdentityInput(await this.#rootIdentityReader.revalidate(expectedRoot));
    if (!rootIdentityEquals(expectedRoot, live)) {
      throw safeError("root_revoked", "The authorized working folder identity changed.");
    }
  }

  async #readCitation(
    citation: SecurityScanFileCitationInput,
    rootIdentity: SecurityScanLedgerRootIdentity,
  ): Promise<SecurityScanCitationDigest> {
    const verified = await this.#citationReader.revalidateAndHash(citation, rootIdentity);
    const candidate = securityScanCodeEvidenceSchema.safeParse({
      id: "evidence_verification-1",
      relativePath: verified.relativePath,
      startLine: verified.startLine,
      endLine: verified.endLine,
      fileSha256: verified.fileSha256,
      rangeSha256: verified.rangeSha256,
      rootFingerprint: verified.rootFingerprint,
      capturedAt: canonicalTime(this.#now),
      gitHead: verified.gitHead,
      gitDirty: verified.gitDirty,
    });
    if (!candidate.success || verified.relativePath !== citation.relativePath || verified.startLine !== citation.startLine
      || verified.endLine !== citation.endLine || verified.rootFingerprint !== rootIdentity.fingerprint) {
      throw safeError("evidence_not_authorized", "Security research citation could not be revalidated.");
    }
    return verified;
  }

  async #verifyMintedEvidence(
    citations: readonly SecurityScanFileCitationInput[],
    evidence: readonly SecurityScanCodeEvidence[],
    rootIdentity: SecurityScanLedgerRootIdentity,
  ): Promise<void> {
    await this.#assertLiveRoot(rootIdentity);
    const rechecked = await Promise.all(citations.map((citation) => this.#readCitation(citation, rootIdentity)));
    if (rechecked.some((item, index) => item.fileSha256 !== evidence[index]!.fileSha256
      || item.rangeSha256 !== evidence[index]!.rangeSha256
      || item.rootFingerprint !== evidence[index]!.rootFingerprint
      || item.gitHead !== evidence[index]!.gitHead
      || item.gitDirty !== evidence[index]!.gitDirty)) {
      throw safeError("evidence_not_authorized", "Security research citation changed before it could be committed.");
    }
  }

  async #readIfPresent(scanId: string): Promise<StoredLedger | null> {
    try {
      const ownedRoot = await this.#ensureOwnedRoot();
      const directory = join(ownedRoot, scanId);
      const directoryMeta = await lstat(directory);
      if (!directoryMeta.isDirectory() || directoryMeta.isSymbolicLink()) {
        throw safeError("artifact_corrupt", "Security research ledger directory is invalid.");
      }
      const file = join(directory, "ledger.json");
      const metadata = await lstat(file);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw safeError("artifact_corrupt", "Security research ledger is invalid.");
      }
      const bytes = await readFile(file, "utf8");
      let value: unknown;
      try { value = JSON.parse(bytes) as unknown; } catch { throw safeError("artifact_corrupt", "Security research ledger is unreadable."); }
      return parseLedger(value);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return null;
      if (error instanceof SecurityScanLedgerError) throw error;
      throw safeError("artifact_corrupt", "Security research ledger is unreadable.");
    }
  }

  async #readRequired(scanId: string): Promise<StoredLedger> {
    const ledger = await this.#readIfPresent(scanId);
    if (ledger === null) throw safeError("scan_not_found", "Security research ledger was not found.");
    return ledger;
  }

  async #write(scanId: string, ledger: StoredLedger, beforeCommit?: () => Promise<void>): Promise<void> {
    const ownedRoot = await this.#ensureOwnedRoot();
    const directory = join(ownedRoot, scanId);
    const file = join(directory, "ledger.json");
    await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
    const directoryMeta = await lstat(directory);
    if (!directoryMeta.isDirectory() || directoryMeta.isSymbolicLink()) {
      throw safeError("artifact_corrupt", "Security research ledger directory is invalid.");
    }
    await chmod(directory, DIRECTORY_MODE);
    const temporary = join(directory, `.ledger-${randomUUID()}.tmp`);
    try {
      const serialized = JSON.stringify(ledger);
      await writeFile(temporary, serialized, { encoding: "utf8", mode: FILE_MODE, flag: "wx" });
      await chmod(temporary, FILE_MODE);
      await fsync(temporary);
      await beforeCommit?.();
      await this.#assertLiveRoot(ledger.rootIdentity);
      await rename(temporary, file);
      await chmod(file, FILE_MODE);
      await fsync(file);
      await fsyncDirectory(directory);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      if (error instanceof SecurityScanLedgerError) throw error;
      throw safeError("internal", "Security research ledger could not be persisted.");
    }
  }

  async #ensureOwnedRoot(): Promise<string> {
    let userDataRoot: string;
    try { userDataRoot = await realpath(this.#userDataRoot); } catch {
      throw safeError("internal", "Security research storage is unavailable.");
    }
    const root = join(userDataRoot, "security-research");
    const versionRoot = join(root, "v1");
    await mkdir(root, { recursive: true, mode: DIRECTORY_MODE });
    const rootMeta = await lstat(root);
    if (!rootMeta.isDirectory() || rootMeta.isSymbolicLink()) {
      throw safeError("artifact_corrupt", "Security research storage root is invalid.");
    }
    await chmod(root, DIRECTORY_MODE);
    const marker = join(root, ".nautilo-security-research-root");
    try {
      const markerMeta = await lstat(marker);
      if (!markerMeta.isFile() || markerMeta.isSymbolicLink() || markerMeta.size !== ROOT_MARKER.length
        || await readFile(marker, "utf8") !== ROOT_MARKER) {
        throw safeError("artifact_corrupt", "Security research storage marker is invalid.");
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      if ((await readdir(root)).length !== 0) {
        throw safeError("artifact_corrupt", "Security research storage root is unowned.");
      }
      try {
        await writeFile(marker, ROOT_MARKER, { encoding: "utf8", mode: FILE_MODE, flag: "wx" });
      } catch (writeError) {
        if (!isNodeError(writeError, "EEXIST")) throw writeError;
        const markerMeta = await lstat(marker);
        if (!markerMeta.isFile() || markerMeta.isSymbolicLink() || markerMeta.size !== ROOT_MARKER.length
          || await readFile(marker, "utf8") !== ROOT_MARKER) {
          throw safeError("artifact_corrupt", "Security research storage marker is invalid.");
        }
      }
    }
    await chmod(marker, FILE_MODE);
    await mkdir(versionRoot, { recursive: true, mode: DIRECTORY_MODE });
    const versionMeta = await lstat(versionRoot);
    if (!versionMeta.isDirectory() || versionMeta.isSymbolicLink()) {
      throw safeError("artifact_corrupt", "Security research storage root is invalid.");
    }
    await chmod(versionRoot, DIRECTORY_MODE);
    return versionRoot;
  }

  async #withWriter<T>(scanId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(scanId) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.#tails.set(scanId, tail);
    await previous.catch(() => undefined);
    try {
      return await action();
    } finally {
      release!();
      if (this.#tails.get(scanId) === tail) this.#tails.delete(scanId);
    }
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
