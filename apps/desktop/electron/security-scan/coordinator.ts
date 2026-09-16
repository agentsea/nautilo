import { captureSecurityInventory, securityInventorySourceVersion } from "./inventory";
import type { SecurityScanProgress } from "@nautilo/relay";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { lstat, mkdir, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  securityScanRelayRequestSchema,
  securityScanObservationSchema,
  securityScanStatusSchema,
  type SecurityScanErrorCode,
  type SecurityScanFileCitationInput,
  type SecurityScanProbeLane,
  type SecurityScanRelayRequest,
  type SecurityScanToolResult,
  type SecurityScanTrustedContext,
  type SecurityScanStatus,
} from "@nautilo/types";
import type { ProtectedPathPolicy } from "@nautilo/security";
import {
  DesktopSecurityScanLedger,
  SecurityScanLedgerError,
  type SecurityScanCitationDigest,
  type SecurityScanLedgerRootIdentity,
} from "./ledger.ts";
import { runSecurityProbeSuite, type SecurityProbeSuiteDeps } from "./probes.ts";

export interface DesktopSecurityScanCoordinatorOptions {
  readonly ledger: DesktopSecurityScanLedger;
  readonly getLocalWorkspacePath: () => string | undefined;
  readonly protectedPathPolicy: ProtectedPathPolicy;
  /** Hashed before it is ever persisted; do not pass a raw user identity to the ledger. */
  readonly localOwnerIdentity: string;
  readonly probeDeps: SecurityProbeSuiteDeps;
}

interface LiveRoot {
  readonly canonicalPath: string;
  readonly identity: SecurityScanLedgerRootIdentity;
}

type SecurityScanRecordOperation = Extract<
  SecurityScanRelayRequest["operation"],
  { operation: "record" }
>;

function digest(...parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part, "utf8").update("\0", "utf8");
  return hash.digest("hex");
}

function operationError(operation: SecurityScanRelayRequest["operation"]["operation"], code: SecurityScanErrorCode, message: string, continuation?: string): SecurityScanToolResult {
  return {
    ok: false,
    operation,
    error: {
      code,
      retryable: code === "research_incomplete" || code === "probe_unavailable" || code === "probe_failed" || code === "probe_capped" || code === "evidence_not_found",
      message,
      ...(continuation === undefined ? {} : { continuation }),
    },
  };
}

function pathInside(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function scanIdFor(trusted: SecurityScanTrustedContext): string {
  return `scan_${digest("nautilo-d560-security-scan", trusted.taskRunId, trusted.toolCallId).slice(0, 48)}`;
}

function statusTrusted(trusted: SecurityScanTrustedContext, scanId: string): SecurityScanTrustedContext {
  return {
    ...trusted,
    toolCallId: `security_scan_status_${digest(scanId, trusted.taskRunId, trusted.toolCallId).slice(0, 40)}`,
  };
}

function scannerOnlyTerminal(lanes: readonly SecurityScanProbeLane[]): "completed" | "partial" {
  return lanes.every((lane) => lane.state === "completed" || lane.state === "skipped") ? "completed" : "partial";
}

export class DesktopSecurityScanCoordinator {
  readonly #ledger: DesktopSecurityScanLedger;
  readonly #getLocalWorkspacePath: () => string | undefined;
  readonly #protectedPathPolicy: ProtectedPathPolicy;
  readonly #localOwnerId: string;
  readonly #probeDeps: SecurityProbeSuiteDeps;

  constructor(options: DesktopSecurityScanCoordinatorOptions) {
    this.#ledger = options.ledger;
    this.#getLocalWorkspacePath = options.getLocalWorkspacePath;
    this.#protectedPathPolicy = options.protectedPathPolicy;
    this.#localOwnerId = digest("nautilo-d560-security-owner", options.localOwnerIdentity);
    this.#probeDeps = options.probeDeps;
  }

  async dispatch(request: unknown, signal?: AbortSignal, reportProgress?: (progress: SecurityScanProgress) => void): Promise<SecurityScanToolResult> {
    const notify = reportProgress ? (progress: SecurityScanProgress) => {
      try { reportProgress(progress); } catch { /* Progress observers cannot fail the scan. */ }
    } : undefined;
    const parsed = securityScanRelayRequestSchema.safeParse(request);
    if (!parsed.success) return operationError("status", "invalid_request", "Security research request is invalid.");
    const { trustedContext } = parsed.data;
    const requestedOperation = parsed.data.operation;
    try {
      const root = await this.#liveRoot(parsed.data.expectedCurrentFolder);
      const access = { trusted: trustedContext, localOwnerId: this.#localOwnerId, rootIdentity: root.identity };
      const operation = requestedOperation.operation === "start"
        ? requestedOperation
        : {
            ...requestedOperation,
            scanId: await this.#ledger.scanIdForTaskRun(access),
          };
      if (operation.operation !== "start") {
        await this.#validateStoredTarget(await this.#ledger.status({ scanId: operation.scanId, ...access }), root);
      }
      switch (operation.operation) {
        case "status":
          return { ok: true, operation: "status", result: await this.#ledger.status({ scanId: operation.scanId, ...access }) };
        case "results":
          if (operation.category === "inventory" && operation.cursor === undefined && !operation.finalize) {
            const current = await this.#ledger.status({ scanId: operation.scanId, ...access });
            if (current.state === "active" && current.mode === "deep_research") await this.#captureInventory(current, trustedContext, root, signal, notify);
          }
          if (operation.finalize) {
            const current = await this.#ledger.status({ scanId: operation.scanId, ...access });
            if (current.state === "active" && current.mode === "deep_research") await this.#captureInventory(current, trustedContext, root, signal, notify);
            await this.#ledger.finalize({ scanId: operation.scanId, ...access });
          }
          return { ok: true, operation: "results", result: await this.#ledger.results({ operation, ...access }) };
        case "record":
          return {
            ok: true,
            operation: "record",
            result: await this.#ledger.appendOrUpdate({
              operation: await this.#normalizeRecordCitations(operation, root),
              ...access,
            }),
          };
        case "cancel":
          return { ok: true, operation: "cancel", result: await this.#ledger.cancel({ scanId: operation.scanId, ...access }) };
        case "start": {
          const result = await this.#start(operation, trustedContext, root, signal, notify);
          if (result.ok && result.operation === "start" && result.result.state === "active" && operation.mode === "deep_research") notify?.({ stage: "research_ready" });
          return result;
        }
      }
    } catch (error) {
      const code = this.#errorCode(error);
      // Ledger errors contain deliberately bounded, model-safe guidance. In
      // particular, citation failures must tell the Task how to recover or it
      // will retry the same stale range indefinitely.
      const message = error instanceof SecurityScanLedgerError
        ? error.message
        : "Security research could not be completed safely.";
      return operationError(requestedOperation.operation, code, message, error instanceof SecurityScanLedgerError ? error.continuation : undefined);
    }
  }

  async #start(
    operation: Extract<SecurityScanRelayRequest["operation"], { operation: "start" }>,
    trusted: SecurityScanTrustedContext,
    initialRoot: LiveRoot,
    signal?: AbortSignal,
    reportProgress?: (progress: SecurityScanProgress) => void,
  ): Promise<SecurityScanToolResult> {
    const candidate = resolve(initialRoot.canonicalPath, operation.targetDirectory);
    const target = await realpath(candidate).catch(() => null);
    if (target === null || (!pathInside(initialRoot.canonicalPath, target) && target !== initialRoot.canonicalPath)
      || !(await stat(target)).isDirectory() || !this.#protectedPathPolicy.check(target).allowed) {
      throw new SecurityScanLedgerError("root_not_authorized", "Scan target is not an authorized directory inside Current Folder.");
    }
    const targetDirectory = relative(initialRoot.canonicalPath, target).split(sep).join("/") || ".";
    const targetInfo = await stat(target);
    const targetFingerprint = digest("nautilo-security-target", target, String(targetInfo.dev), String(targetInfo.ino));
    const scanId = operation.priorScanId ?? scanIdFor(trusted);
    const access = { trusted, localOwnerId: this.#localOwnerId, rootIdentity: initialRoot.identity };
    const initial = operation.priorScanId === undefined
      ? await this.#ledger.create({ scanId, mode: operation.mode, targetDirectory, targetFingerprint, ...access })
      : await this.#ledger.reopen({ scanId, targetDirectory, targetFingerprint, ...access });
    if ((initial.targetDirectory ?? ".") !== targetDirectory) {
      throw new SecurityScanLedgerError("root_not_authorized", "The scan target cannot change when resuming a ledger.");
    }
    if (initial.mode === "deep_research") await this.#captureInventory(initial, trusted, initialRoot, signal, reportProgress);
    // Same Task tool-call retry has already completed this durable transition.
    if (initial.phase !== "admitting") return { ok: true, operation: "start", result: await this.#ledger.status({ scanId, ...access }) };

    await mkdir(this.#probeDeps.scratchRoot, { recursive: true, mode: 0o700 });
    const probes = await runSecurityProbeSuite(target, this.#probeDeps, signal, reportProgress);
    await this.#validateStoredTarget(initial, initialRoot);
    reportProgress?.({ stage: "recording_evidence" });
    const admissionRoot = await this.#liveRootForFingerprint(initialRoot.identity.fingerprint);
    await this.#ledger.appendObservations({
      scanId,
      observations: probes.observations.map((observation) => securityScanObservationSchema.parse({
        ...observation,
        relativePath: observation.relativePath === null || targetDirectory === "."
          ? observation.relativePath : `${targetDirectory}/${observation.relativePath}`,
      })),
      trusted: { ...trusted, toolCallId: `security_scan_observations_${digest(scanId, trusted.taskRunId).slice(0, 40)}` },
      localOwnerId: this.#localOwnerId,
      rootIdentity: admissionRoot.identity,
    });
    const root = await this.#liveRootForFingerprint(initialRoot.identity.fingerprint);
    const mode = initial.mode;
    const terminal = signal?.aborted === true
      ? "cancelled"
      : mode === "scanners_only" ? scannerOnlyTerminal(probes.lanes) : null;
    const status = securityScanStatusSchema.parse({
      ...initial,
      state: terminal ?? "active",
      phase: terminal === null ? "researching" : null,
      terminalState: terminal,
      modelState: mode === "scanners_only" ? "disabled" : terminal === "cancelled" ? "cancelled" : "running",
      completedSteps: terminal === null ? 1 : 1,
      totalSteps: terminal === null ? 2 : 1,
      lanes: probes.lanes,
    });
    await this.#ledger.updateStatus({
      status,
      trusted: statusTrusted(trusted, scanId),
      localOwnerId: this.#localOwnerId,
      rootIdentity: root.identity,
    });
    return { ok: true, operation: "start", result: await this.#ledger.status({ scanId, trusted, localOwnerId: this.#localOwnerId, rootIdentity: root.identity }) };
  }

  async #captureInventory(status: SecurityScanStatus, trusted: SecurityScanTrustedContext, root: LiveRoot, signal?: AbortSignal, reportProgress?: (progress: SecurityScanProgress) => void): Promise<void> {
    await this.#validateStoredTarget(status, root);
    const inventory = await captureSecurityInventory({
      currentFolder: root.canonicalPath,
      target: resolve(root.canonicalPath, status.targetDirectory ?? "."),
      allowed: (path) => this.#protectedPathPolicy.check(path).allowed,
      assertLive: async () => { await this.#liveRootForFingerprint(root.identity.fingerprint); },
      signal,
      onProgress: (counts) => reportProgress?.({ stage: "inventory_progress", ...counts }),
    });
    await this.#validateStoredTarget(status, root);
    await this.#ledger.updateInventory({ scanId: status.scanId, trusted, localOwnerId: this.#localOwnerId, rootIdentity: root.identity, inventory });
  }

  async #validateStoredTarget(status: SecurityScanStatus, root: LiveRoot): Promise<void> {
    if (status.targetFingerprint === undefined) return; // Legacy Current Folder ledger.
    const candidate = resolve(root.canonicalPath, status.targetDirectory ?? ".");
    const target = await realpath(candidate).catch(() => null);
    if (target === null || (!pathInside(root.canonicalPath, target) && target !== root.canonicalPath)
      || !this.#protectedPathPolicy.check(target).allowed) {
      throw new SecurityScanLedgerError("root_revoked", "The scan target is no longer authorized.");
    }
    const info = await stat(target);
    if (!info.isDirectory() || digest("nautilo-security-target", target, String(info.dev), String(info.ino)) !== status.targetFingerprint) {
      throw new SecurityScanLedgerError("root_revoked", "The scan target directory changed during research.");
    }
  }

  async #liveRoot(expectedCurrentFolder: string): Promise<LiveRoot> {
    const selected = this.#getLocalWorkspacePath();
    if (selected === undefined || selected !== expectedCurrentFolder) {
      throw new SecurityScanLedgerError("root_revoked", "Current Folder changed before security research began.");
    }
    let canonicalPath: string;
    try {
      canonicalPath = await realpath(selected);
      const info = await stat(canonicalPath);
      if (!info.isDirectory() || !this.#protectedPathPolicy.check(canonicalPath).allowed) {
        throw new SecurityScanLedgerError("root_not_authorized", "Current Folder is unavailable for security research.");
      }
      return { canonicalPath, identity: { fingerprint: digest("nautilo-d560-security-root", canonicalPath, String(info.dev), String(info.ino)) } };
    } catch (error) {
      if (error instanceof SecurityScanLedgerError) throw error;
      throw new SecurityScanLedgerError("root_unavailable", "Current Folder is unavailable for security research.");
    }
  }

  async #liveRootForFingerprint(expectedFingerprint: string): Promise<LiveRoot> {
    const selected = this.#getLocalWorkspacePath();
    if (selected === undefined) throw new SecurityScanLedgerError("root_revoked", "Current Folder changed during security research.");
    const root = await this.#liveRoot(selected);
    if (root.identity.fingerprint !== expectedFingerprint) {
      throw new SecurityScanLedgerError("root_revoked", "Current Folder identity changed during security research.");
    }
    return root;
  }

  async revalidateAndHash(citation: SecurityScanFileCitationInput, expectedRoot: SecurityScanLedgerRootIdentity): Promise<SecurityScanCitationDigest> {
    const root = await this.#liveRootForFingerprint(expectedRoot.fingerprint);
    const candidate = resolve(root.canonicalPath, citation.relativePath);
    if (!pathInside(root.canonicalPath, candidate)) {
      throw new SecurityScanLedgerError("evidence_not_authorized", "Code citation is outside Current Folder.");
    }
    const entry = await lstat(candidate).catch(() => null);
    if (entry === null || !entry.isFile() || entry.isSymbolicLink()) {
      throw new SecurityScanLedgerError("evidence_not_authorized", "Code citation is not a safe regular file.");
    }
    const canonicalFile = await realpath(candidate);
    if (!pathInside(root.canonicalPath, canonicalFile) || !this.#protectedPathPolicy.check(canonicalFile).allowed) {
      throw new SecurityScanLedgerError("evidence_not_authorized", "Code citation escaped Current Folder.");
    }
    const fileHash = createHash("sha256");
    const rangeHash = createHash("sha256");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let currentLine = 1;
    const handle = await open(canonicalFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || securityInventorySourceVersion(entry) !== securityInventorySourceVersion(opened)) {
        throw new SecurityScanLedgerError("evidence_not_found", "Source changed before citation capture. Reread the current source.");
      }
      await this.#liveRootForFingerprint(expectedRoot.fingerprint);
      for await (const rawChunk of handle.createReadStream({ autoClose: false })) {
        const chunk = rawChunk as Buffer;
        if (chunk.includes(0)) {
          throw new SecurityScanLedgerError("evidence_not_authorized", "Binary files cannot be cited as code evidence.");
        }
        fileHash.update(chunk);
        decoder.decode(chunk, { stream: true });
        let rangeStart = -1;
        for (let index = 0; index < chunk.length; index += 1) {
          const inRange = currentLine >= citation.startLine && currentLine <= citation.endLine;
          if (inRange && rangeStart < 0) rangeStart = index;
          if (!inRange && rangeStart >= 0) {
            rangeHash.update(chunk.subarray(rangeStart, index));
            rangeStart = -1;
          }
          if (chunk[index] === 0x0a) currentLine += 1;
        }
        if (rangeStart >= 0) rangeHash.update(chunk.subarray(rangeStart));
      }
      decoder.decode();
    } catch (error) {
      if (error instanceof SecurityScanLedgerError) throw error;
      throw new SecurityScanLedgerError("evidence_not_authorized", "Code citation is not valid UTF-8 source text.");
    } finally { await handle.close(); }
    if (citation.endLine > currentLine) {
      throw new SecurityScanLedgerError(
        "evidence_not_found",
        `Code citation range ${citation.startLine}-${citation.endLine} exceeds the file's current ${currentLine} lines. Reread the file and retry with a range within 1-${currentLine}.`,
      );
    }
    const finalInfo = await lstat(canonicalFile);
    if (!finalInfo.isFile() || securityInventorySourceVersion(entry) !== securityInventorySourceVersion(finalInfo)) {
      throw new SecurityScanLedgerError("evidence_not_found", "Source changed during citation capture. Reread the current source before recording its evidence.");
    }
    await this.#liveRootForFingerprint(expectedRoot.fingerprint);
    return {
      sourceVersion: securityInventorySourceVersion(finalInfo),
      relativePath: citation.relativePath,
      startLine: citation.startLine,
      endLine: citation.endLine,
      fileSha256: fileHash.digest("hex"),
      rangeSha256: rangeHash.digest("hex"),
      rootFingerprint: root.identity.fingerprint,
      gitHead: null,
      gitDirty: null,
    };
  }

  async revalidateRoot(expectedRoot: SecurityScanLedgerRootIdentity): Promise<SecurityScanLedgerRootIdentity> {
    return (await this.#liveRootForFingerprint(expectedRoot.fingerprint)).identity;
  }

  /**
   * A repository map may legitimately be derived from `file.list` directory
   * inventory, but the durable code-evidence ledger only admits regular-file
   * line ranges. Provider flat schemas occasionally put that directory path
   * into `fileCitations`. Drop only a path proven to be an ordinary directory
   * inside the already-authorized root. For a regular file, an end line just
   * past EOF is reduced to the exact live EOF when the start remains valid;
   * this can only narrow the cited range. Missing paths, starts past EOF,
   * symlinks, escapes, binaries, and every directory citation on an
   * evidence-bearing record still travel through the strict ledger verifier
   * and fail closed.
   */
  async #normalizeRecordCitations(
    operation: SecurityScanRecordOperation,
    root: LiveRoot,
  ): Promise<SecurityScanRecordOperation> {
    if (operation.fileCitations.length === 0) return operation;
    const fileCitations: SecurityScanFileCitationInput[] = [];
    for (const citation of operation.fileCitations) {
      const candidate = resolve(root.canonicalPath, citation.relativePath);
      if (!pathInside(root.canonicalPath, candidate)) {
        fileCitations.push(citation);
        continue;
      }
      const entry = await lstat(candidate).catch(() => null);
      if (entry?.isDirectory() === true && !entry.isSymbolicLink()) {
        if (operation.entry.kind === "repository_map") continue;
        fileCitations.push(citation);
        continue;
      }
      if (entry?.isFile() !== true || entry.isSymbolicLink()) {
        fileCitations.push(citation);
        continue;
      }
      const canonicalFile = await realpath(candidate).catch(() => null);
      if (canonicalFile === null || !pathInside(root.canonicalPath, canonicalFile) || !this.#protectedPathPolicy.check(canonicalFile).allowed) {
        fileCitations.push(citation);
        continue;
      }
      let currentLine = 1;
      let binary = false;
      try {
        for await (const rawChunk of createReadStream(canonicalFile)) {
          const chunk = rawChunk as Buffer;
          if (chunk.includes(0)) {
            binary = true;
            break;
          }
          for (const byte of chunk) if (byte === 0x0a) currentLine += 1;
        }
      } catch {
        fileCitations.push(citation);
        continue;
      }
      fileCitations.push(
        !binary && citation.startLine <= currentLine && citation.endLine > currentLine
          ? { ...citation, endLine: currentLine }
          : citation,
      );
    }
    return fileCitations.length === operation.fileCitations.length
      && fileCitations.every((citation, index) => citation === operation.fileCitations[index])
        ? operation
        : { ...operation, fileCitations };
  }

  #errorCode(error: unknown): SecurityScanErrorCode {
    return error instanceof SecurityScanLedgerError ? error.code : "internal";
  }
}
