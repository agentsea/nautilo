import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { DesktopShellResult } from "@nautilo/relay";
import type {
  WorkstationShellConsentStore,
  WorkstationShellFolderIdentity,
  WorkstationShellSubject,
} from "./workstation-shell-consent-store.ts";

const MAX_CAPTURE_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 14_400_000;
const WORKSTATION_SHELL = process.platform === "darwin" ? "/bin/zsh" : "/bin/sh";

export interface WorkstationShellRequest {
  readonly command: string;
  readonly cwd: string;
  /**
   * D538 only: Electron already revalidated the exact live uncontained
   * session immediately before entering this runner. This skips D486's
   * separate folder-consent prompt; it changes no process behavior.
   */
  readonly consentMode?: "verified_uncontained_session" | undefined;
  /** Canonical Electron-selected Current Folder, distinct from a child cwd. */
  readonly workspacePath?: string | undefined;
  /** Electron-owned live Current Folder revalidation immediately before spawn. */
  readonly isCurrentWorkspace?: (() => boolean) | undefined;
  readonly timeoutMs?: number | undefined;
  /** Relay-owned cancellation; it kills this detached process group. */
  readonly abortSignal?: AbortSignal | undefined;
  /** Relay-owned bounded observers; they never change host execution. */
  readonly onStdoutChunk?: ((chunk: Buffer) => void) | undefined;
  readonly onStderrChunk?: ((chunk: Buffer) => void) | undefined;
}

export interface WorkstationShellResult {
  readonly status: "ok" | "error";
  readonly result?: DesktopShellResult;
  readonly error?: string;
  readonly errorCode?: string;
}

export type WorkstationConsentLifetime = "session" | "durable";
export type WorkstationConsentRequest = (
  workspacePath: string,
) => Promise<WorkstationConsentLifetime | boolean | null>;

/** Bounded byte capture: pipe drainage never waits on output retention. */
class StreamCapture {
  private complete: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private head: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private tail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private totalBytes = 0;
  private overflowed = false;
  private readonly headBudget = Math.floor(MAX_CAPTURE_BYTES / 2);
  private readonly tailBudget = MAX_CAPTURE_BYTES - this.headBudget;

  append(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.totalBytes += chunk.length;
    if (!this.overflowed) {
      const complete = Buffer.concat([this.complete, chunk]);
      if (complete.length <= MAX_CAPTURE_BYTES) {
        this.complete = complete;
        return;
      }
      this.overflowed = true;
      this.head = complete.subarray(0, this.headBudget);
      this.tail = complete.subarray(complete.length - this.tailBudget);
      this.complete = Buffer.alloc(0);
      return;
    }
    const retained = Buffer.concat([this.tail, chunk]);
    this.tail = retained.length > this.tailBudget
      ? retained.subarray(retained.length - this.tailBudget)
      : retained;
  }

  finalize(): { text: string; truncated: boolean } {
    if (!this.overflowed) return { text: this.complete.toString("utf8"), truncated: false };
    const omitted = Math.max(0, this.totalBytes - this.head.length - this.tail.length);
    return {
      text: `${this.head.toString("utf8")}\n…[${omitted} bytes truncated by Nautilo]…\n${this.tail.toString("utf8")}`,
      truncated: true,
    };
  }
}

/**
 * Electron-owned real-workstation shell authority.
 *
 * Consent is scoped to the canonical Current Folder. Session consent lives
 * only for this host object's lifetime; optional durable consent is resolved
 * from the Electron-local receipt store against the exact instance, Human,
 * relay, and filesystem identity. Server cwd/env values are never accepted:
 * callers must supply the locally selected Current Folder.
 */
export function createWorkstationShellHost(options: {
  readonly requestConsent: WorkstationConsentRequest;
  readonly consentStore?: WorkstationShellConsentStore | undefined;
  readonly resolveSubject: () => Promise<WorkstationShellSubject | null>;
  readonly spawnProcess?: typeof spawn;
}) {
  const sessionConsents = new Map<
    string,
    {
      readonly subject: WorkstationShellSubject;
      readonly identity: WorkstationShellFolderIdentity;
    }
  >();
  const activeByWorkspace = new Map<
    string,
    Set<{ readonly child: ChildProcess; readonly revoke: () => void }>
  >();
  const spawnProcess = options.spawnProcess ?? spawn;
  const folderIdentity = (cwd: string): WorkstationShellFolderIdentity => {
    const stat = fs.statSync(cwd);
    return {
      canonicalRoot: cwd,
      ...(Number.isSafeInteger(stat.dev) &&
      stat.dev >= 0 &&
      Number.isSafeInteger(stat.ino) &&
      stat.ino >= 0
        ? { device: stat.dev, inode: stat.ino }
        : {}),
    };
  };
  const resolveExecutionPaths = (
    request: WorkstationShellRequest,
  ):
    | {
        readonly ok: true;
        readonly workspace: string;
        readonly cwd: string;
        readonly identity: WorkstationShellFolderIdentity;
      }
    | { readonly ok: false; readonly errorCode: string; readonly error: string } => {
    let workspace: string;
    try {
      workspace = fs.realpathSync(request.workspacePath ?? request.cwd);
      if (!fs.statSync(workspace).isDirectory()) throw new Error("not a directory");
    } catch {
      return {
        ok: false,
        errorCode: "WORKSTATION_CURRENT_FOLDER_INVALID",
        error: "Current Folder is unavailable for workstation execution.",
      };
    }
    let cwd: string;
    try {
      cwd = fs.realpathSync(request.cwd);
      if (!fs.statSync(cwd).isDirectory()) throw new Error("not a directory");
    } catch {
      return {
        ok: false,
        errorCode: "WORKSTATION_CWD_INVALID",
        error: "Requested workstation directory is unavailable.",
      };
    }
    const relative = path.relative(workspace, cwd);
    if (
      relative !== "" &&
      (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    ) {
      return {
        ok: false,
        errorCode: "WORKSTATION_CWD_OUTSIDE_CURRENT_FOLDER",
        error: "Requested workstation directory is outside the selected Current Folder.",
      };
    }
    return { ok: true, workspace, cwd, identity: folderIdentity(workspace) };
  };
  const sameSubject = (
    left: WorkstationShellSubject,
    right: WorkstationShellSubject,
  ): boolean =>
    left.instanceId === right.instanceId &&
    left.userId === right.userId &&
    left.relayId === right.relayId &&
    left.serverOrigin === right.serverOrigin &&
    left.pairingFingerprint === right.pairingFingerprint;
  const sameIdentity = (
    left: WorkstationShellFolderIdentity,
    right: WorkstationShellFolderIdentity,
  ): boolean =>
    left.canonicalRoot === right.canonicalRoot &&
    left.device === right.device &&
    left.inode === right.inode;
  const resolveAuthority = async (
    identity: WorkstationShellFolderIdentity,
  ): Promise<
    | {
        readonly ok: true;
        readonly subject: WorkstationShellSubject;
        readonly durable: boolean;
      }
    | {
        readonly ok: false;
        readonly errorCode:
          | "WORKSTATION_IDENTITY_UNAVAILABLE"
          | "WORKSTATION_CONSENT_STORE_UNAVAILABLE";
        readonly error: string;
      }
  > => {
    let subject: WorkstationShellSubject | null;
    try {
      subject = await options.resolveSubject();
    } catch {
      return {
        ok: false,
        errorCode: "WORKSTATION_IDENTITY_UNAVAILABLE",
        error: "Host command identity could not be resolved.",
      };
    }
    if (subject === null) {
      return {
        ok: false,
        errorCode: "WORKSTATION_IDENTITY_UNAVAILABLE",
        error: "Sign in and connect this desktop before allowing host commands.",
      };
    }
    if (!options.consentStore) {
      return { ok: true, subject, durable: false };
    }
    const stored = await options.consentStore.has({ subject, identity });
    if (!stored.ok) {
      return {
        ok: false,
        errorCode: "WORKSTATION_CONSENT_STORE_UNAVAILABLE",
        error: `Host command consent could not be read (${stored.code}).`,
      };
    }
    return { ok: true, subject, durable: stored.data };
  };
  const terminate = (child: ChildProcess) => {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  };

  return {
    async execute(request: WorkstationShellRequest): Promise<WorkstationShellResult> {
      if (!request.command.trim()) {
        return { status: "error", errorCode: "WORKSTATION_COMMAND_REQUIRED", error: "No command provided" };
      }

      const resolved = resolveExecutionPaths(request);
      if (!resolved.ok) {
        return { status: "error", errorCode: resolved.errorCode, error: resolved.error };
      }
      const { workspace, cwd, identity } = resolved;

      if (request.consentMode !== "verified_uncontained_session") {
        const authority = await resolveAuthority(identity);
        if (!authority.ok) {
          return {
            status: "error",
            errorCode: authority.errorCode,
            error: authority.error,
          };
        }
        const session = sessionConsents.get(workspace);
        const sessionAuthorized =
          session !== undefined &&
          sameSubject(session.subject, authority.subject) &&
          sameIdentity(session.identity, identity);
        if (session !== undefined && !sessionAuthorized) {
          sessionConsents.delete(workspace);
        }
        let authorized = sessionAuthorized || authority.durable;
        if (!authorized) {
          const response = await options.requestConsent(workspace);
          const lifetime: WorkstationConsentLifetime | null =
            response === true ? "session" : response === false ? null : response;
          if (lifetime === null) {
            return {
              status: "error",
              errorCode: "WORKSTATION_CONSENT_REQUIRED",
              error: "Workstation execution was not allowed for this Current Folder.",
            };
          }
          if (lifetime === "durable") {
            if (!options.consentStore) {
              return {
                status: "error",
                errorCode: "WORKSTATION_CONSENT_STORE_UNAVAILABLE",
                error: "Durable host command consent is unavailable.",
              };
            }
            const saved = await options.consentStore.grant({
              subject: authority.subject,
              identity,
            });
            if (!saved.ok) {
              return {
                status: "error",
                errorCode: "WORKSTATION_CONSENT_STORE_UNAVAILABLE",
                error: `Host command consent could not be saved (${saved.code}).`,
              };
            }
            authorized = true;
          } else {
            sessionConsents.set(workspace, { subject: authority.subject, identity });
            authorized = true;
          }
        }

        if (!authorized) {
          return {
            status: "error",
            errorCode: "WORKSTATION_CONSENT_REQUIRED",
            error: "Workstation execution was not allowed for this Current Folder.",
          };
        }
      }

      const timeoutMs = Math.min(
        Math.max(request.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000),
        MAX_TIMEOUT_MS,
      );

      // Consent may have involved an asynchronous Human decision. Re-read the
      // selected workspace and child immediately before launch so a replaced
      // Current Folder or a changed symlink cannot inherit that consent.
      const beforeSpawn = resolveExecutionPaths(request);
      let currentWorkspace = true;
      try {
        currentWorkspace = request.isCurrentWorkspace?.() ?? true;
      } catch {
        currentWorkspace = false;
      }
      if (
        !currentWorkspace ||
        !beforeSpawn.ok ||
        beforeSpawn.workspace !== workspace ||
        beforeSpawn.cwd !== cwd ||
        !sameIdentity(beforeSpawn.identity, identity)
      ) {
        return {
          status: "error",
          errorCode: "WORKSTATION_CURRENT_FOLDER_STALE",
          error: "Current Folder changed before workstation execution could start.",
        };
      }

      return await new Promise<WorkstationShellResult>((resolve) => {
        const startedAt = Date.now();
        let child: ChildProcess;
        try {
          child = spawnProcess(WORKSTATION_SHELL, ["-l", "-c", request.command], {
            cwd,
            env: { ...process.env },
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch (error) {
          resolve({
            status: "error",
            errorCode: "WORKSTATION_SPAWN_FAILED",
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        const stdout = new StreamCapture();
        const stderr = new StreamCapture();
        let settled = false;
        let timedOut = false;
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let terminationFallback: ReturnType<typeof setTimeout> | null = null;
        let onAbort: () => void = () => undefined;
        const finalizeProcess = (input: {
          readonly exitCode: number | null;
          readonly signal: NodeJS.Signals | null;
        }): WorkstationShellResult => {
          const out = stdout.finalize();
          const err = stderr.finalize();
          return {
            status: "ok",
            result: {
              version: 1,
              execution: "workstation",
              exitCode: input.exitCode,
              signal: input.signal,
              timedOut,
              cancelled,
              durationMs: Date.now() - startedAt,
              stdout: out.text,
              stderr: err.text,
              stdoutTruncated: out.truncated,
              stderrTruncated: err.truncated,
              sideEffectsMayHaveStarted: true,
              profileRevision: null,
            },
          };
        };
        const finish = (result: WorkstationShellResult) => {
          if (settled) return;
          settled = true;
          if (timer !== null) clearTimeout(timer);
          if (terminationFallback !== null) clearTimeout(terminationFallback);
          request.abortSignal?.removeEventListener("abort", onAbort);
          const entries = activeByWorkspace.get(workspace);
          entries?.delete(activeEntry);
          if (entries?.size === 0) activeByWorkspace.delete(workspace);
          resolve(result);
        };
        const requestTermination = (): void => {
          terminate(child);
          // Real detached process groups normally emit close promptly. A
          // bounded fallback prevents a broken child/mock from stranding the
          // relay forever, while giving stdout/stderr a chance to drain first.
          if (terminationFallback === null) {
            terminationFallback = setTimeout(() => {
              finish(finalizeProcess({ exitCode: null, signal: null }));
            }, 500);
            terminationFallback.unref();
          }
        };
        const activeEntry = {
          child,
          revoke: () => {
            cancelled = true;
            requestTermination();
          },
        };
        const entries = activeByWorkspace.get(workspace) ?? new Set();
        entries.add(activeEntry);
        activeByWorkspace.set(workspace, entries);
        child.stdout?.on("data", (chunk: Buffer) => {
          if (settled) return;
          stdout.append(chunk);
          try {
            request.onStdoutChunk?.(chunk);
          } catch {
            // Progress is observational; pipe drainage and final outcome win.
          }
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          if (settled) return;
          stderr.append(chunk);
          try {
            request.onStderrChunk?.(chunk);
          } catch {
            // Progress is observational; pipe drainage and final outcome win.
          }
        });
        child.once("error", (error) => {
          finish({ status: "error", errorCode: "WORKSTATION_SPAWN_FAILED", error: error.message });
        });
        child.once("close", (code, signal) => {
          finish(finalizeProcess({ exitCode: code, signal }));
        });
        timer = setTimeout(() => {
          timedOut = true;
          requestTermination();
        }, timeoutMs);
        timer.unref();
        onAbort = () => {
          cancelled = true;
          requestTermination();
        };
        request.abortSignal?.addEventListener("abort", onAbort, { once: true });
        if (request.abortSignal?.aborted) onAbort();
      });
    },
    async revoke(workspacePath: string, subject?: WorkstationShellSubject | null): Promise<void> {
      let canonicalWorkspace = workspacePath;
      try {
        canonicalWorkspace = fs.realpathSync(workspacePath);
      } catch {
        // A removed workspace still has the original string identity.
      }
      sessionConsents.delete(canonicalWorkspace);
      for (const entry of [...(activeByWorkspace.get(canonicalWorkspace) ?? [])]) {
        entry.revoke();
      }
      if (options.consentStore && subject) {
        await options.consentStore.revoke({
          instanceId: subject.instanceId,
          userId: subject.userId,
          canonicalRoot: canonicalWorkspace,
        });
      }
    },
    deactivate(workspacePath: string): void {
      let canonicalWorkspace = workspacePath;
      try {
        canonicalWorkspace = fs.realpathSync(workspacePath);
      } catch {
        // A removed workspace still has the original string identity.
      }
      for (const entry of [...(activeByWorkspace.get(canonicalWorkspace) ?? [])]) {
        entry.revoke();
      }
    },
    dispose(): void {
      sessionConsents.clear();
      for (const entries of [...activeByWorkspace.values()]) {
        for (const entry of [...entries]) entry.revoke();
      }
    },
    async consentStatus(
      workspacePath: string,
    ): Promise<"none" | WorkstationConsentLifetime> {
      let canonicalWorkspace: string;
      let identity: WorkstationShellFolderIdentity;
      try {
        canonicalWorkspace = fs.realpathSync(workspacePath);
        identity = folderIdentity(canonicalWorkspace);
      } catch {
        return "none";
      }
      const authority = await resolveAuthority(identity);
      if (!authority.ok) return "none";
      const session = sessionConsents.get(canonicalWorkspace);
      if (
        session !== undefined &&
        sameSubject(session.subject, authority.subject) &&
        sameIdentity(session.identity, identity)
      ) {
        return "session";
      }
      return authority.durable ? "durable" : "none";
    },
  };
}
