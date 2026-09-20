import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  COMPUTER_USE_HOST_PROTOCOL_MAJOR,
  COMPUTER_USE_HOST_PROTOCOL_MINOR,
  ComputerUseHostResultGate,
  parseComputerUseHostControlMessage,
  type ComputerUseHostAuthorityScope,
  type ComputerUseHostCancel,
  type ComputerUseHostContract,
  type ComputerUseHostGenerationFence,
  type ComputerUseHostReady,
  type ComputerUseHostRequest,
  type ComputerUseHostResult,
  type ComputerUseJson,
} from "@nautilo/computer-use-host-protocol";
import { AttachmentFrameDecoder, ControlFrameDecoder, encodeControlFrame, type ComputerUseHostPngAttachment } from "@nautilo/computer-use-host-protocol/node";
import type { ComputerUseHostLease } from "./contracts.ts";

/**
 * The broker needs only an already-attested executable and a lifecycle lease.
 * It deliberately does not depend on the release/update implementation: a
 * bundled bootstrap and a future managed updater have the same narrow launch
 * boundary.
 */
export interface ComputerUseHostRuntimeLaunch {
  readonly entrypoint: string;
  readonly generation: number;
  readonly lease: ComputerUseHostLease;
}

/** Immutable launch inputs. Host, not Electron, owns the Cua process/session. */
export interface ComputerUseHostLaunchInputs {
  readonly driverPath: string;
  readonly runtimeRoot: string;
  readonly hostBundleId: string;
}

/** A generic contract request after Agent-side catalogue admission. */
export interface ComputerUseHostBrokerRequest {
  readonly authority: ComputerUseHostAuthorityScope;
  readonly cancellationGeneration: number;
  readonly contract: ComputerUseHostContract;
  readonly arguments: Readonly<Record<string, ComputerUseJson>>;
  readonly requestId?: string;
  readonly signal?: AbortSignal;
}

export interface ComputerUseHostProtocolSession {
  readonly ready: ComputerUseHostReady;
  request(message: ComputerUseHostRequest, signal?: AbortSignal): Promise<ComputerUseHostSessionResult>;
  cancel(message: ComputerUseHostCancel): Promise<void>;
  close(): Promise<void>;
}

export interface ComputerUseHostLauncher {
  launch(launch: ComputerUseHostRuntimeLaunch, input: ComputerUseHostLaunchInputs, signal?: AbortSignal): Promise<ComputerUseHostProtocolSession>;
}

export type ComputerUseHostSessionResult = Readonly<{
  result: ComputerUseHostResult;
  attachment?: import("@nautilo/computer-use-host-protocol/node").ComputerUseHostPngAttachment;
}>;

export interface ComputerUseHostRuntimePort {
  bootstrap(signal?: AbortSignal): Promise<Readonly<{ state: "ready" | "unavailable" }>>;
  acquireLaunch(): ComputerUseHostRuntimeLaunch | null;
}

export type ComputerUseHostBrokerResult =
  | Readonly<{ ok: true; result: ComputerUseHostResult; attachment?: import("@nautilo/computer-use-host-protocol/node").ComputerUseHostPngAttachment }>
  | Readonly<{ ok: false; code: "host_unavailable" | "host_protocol_rejected" | "host_cancelled" }>;

function sameContract(left: ComputerUseHostContract, right: ComputerUseHostContract): boolean {
  return left.contractNamespace === right.contractNamespace
    && left.contractId === right.contractId
    && left.contractVersion === right.contractVersion
    && left.schemaDigest === right.schemaDigest
    && left.effectClass === right.effectClass
    && left.replayClass === right.replayClass
    && left.authorityClass === right.authorityClass
    && left.attachmentClass === right.attachmentClass
    && left.disclosureClass === right.disclosureClass;
}

function validOpaque(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(value);
}

function validLaunchInputs(input: ComputerUseHostLaunchInputs): boolean {
  return isAbsolute(input.driverPath) && isAbsolute(input.runtimeRoot)
    && !input.driverPath.includes("\0") && !input.runtimeRoot.includes("\0")
    && /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u.test(input.hostBundleId);
}

/**
 * The one Desktop-side protocol broker. It starts only an immutable,
 * runtime-acquired Host and forwards a catalogue-admitted descriptor unchanged.
 * It has no tool-name routing, Cua operation parser, URL, PATH, or shell fallback.
 */
export class ComputerUseHostBroker {
  private active: Readonly<{ launch: ComputerUseHostRuntimeLaunch; session: ComputerUseHostProtocolSession }> | null = null;
  private starting: Promise<Readonly<{ launch: ComputerUseHostRuntimeLaunch; session: ComputerUseHostProtocolSession }> | null> | null = null;
  constructor(
    private readonly runtime: ComputerUseHostRuntimePort,
    private readonly launcher: ComputerUseHostLauncher,
    private readonly hostInputs: () => ComputerUseHostLaunchInputs | null,
    private readonly createRequestId: () => string = () => `cuhr:${randomUUID()}`,
  ) {}

  /** Readiness only: starts the attested Host, never dispatches a GUI operation. */
  async supportedContracts(): Promise<readonly ComputerUseHostContract[]> {
    const state = await this.runtime.bootstrap().catch(() => ({ state: "unavailable" as const }));
    if (state.state !== "ready") return [];
    const active = await this.ensureSession();
    if (active === null) return [];
    const ready = parseComputerUseHostControlMessage(active.session.ready);
    return ready.kind === "ready" && ready.protocol.major === COMPUTER_USE_HOST_PROTOCOL_MAJOR
      && ready.protocol.minor === COMPUTER_USE_HOST_PROTOCOL_MINOR ? ready.contracts : [];
  }

  async dispatch(input: ComputerUseHostBrokerRequest): Promise<ComputerUseHostBrokerResult> {
    if (input.signal?.aborted) return { ok: false, code: "host_cancelled" };
    const state = await this.runtime.bootstrap(input.signal).catch(() => ({ state: "unavailable" as const }));
    if (state.state !== "ready") return { ok: false, code: "host_unavailable" };
    const active = await this.ensureSession(input.signal);
    if (active === null) return { ok: false, code: "host_unavailable" };
    if (input.signal?.aborted) return { ok: false, code: "host_cancelled" };
    const { session } = active;
    try {
      const ready = parseComputerUseHostControlMessage(session.ready);
      if (ready.kind !== "ready"
        || ready.protocol.major !== COMPUTER_USE_HOST_PROTOCOL_MAJOR
        || ready.protocol.minor !== COMPUTER_USE_HOST_PROTOCOL_MINOR
        || !ready.contracts.some((contract) => sameContract(contract, input.contract))) {
        return { ok: false, code: "host_protocol_rejected" };
      }
      const requestId = input.requestId ?? this.createRequestId();
      if (!validOpaque(requestId)) return { ok: false, code: "host_protocol_rejected" };
      const fence: ComputerUseHostGenerationFence = {
        hostGeneration: ready.hostGeneration,
        driverGeneration: ready.driverGeneration,
        cancellationGeneration: input.cancellationGeneration,
      };
      const request: ComputerUseHostRequest = {
        kind: "request",
        protocol: { major: COMPUTER_USE_HOST_PROTOCOL_MAJOR, minor: COMPUTER_USE_HOST_PROTOCOL_MINOR },
        requestId,
        authority: input.authority,
        fence,
        contract: input.contract,
        arguments: input.arguments,
      };
      const gate = new ComputerUseHostResultGate({
        requestId,
        hostGeneration: fence.hostGeneration,
        driverGeneration: fence.driverGeneration,
        cancellationGeneration: fence.cancellationGeneration,
        authority: input.authority,
        contract: input.contract,
      });
      let cancelSent = false;
      const cancel = async () => {
        if (cancelSent) return;
        cancelSent = true;
        await session?.cancel({
          kind: "cancel",
          protocol: { major: COMPUTER_USE_HOST_PROTOCOL_MAJOR, minor: COMPUTER_USE_HOST_PROTOCOL_MINOR },
          requestId,
          authority: input.authority,
          fence,
        });
      };
      const onAbort = () => { void cancel(); };
      input.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const response = await session.request(request, input.signal);
        const result = gate.accept(response.result);
        if (this.active?.session !== session) {
          response.attachment?.bytes.fill(0);
          return { ok: false, code: "host_protocol_rejected" };
        }
        // An abort requests cleanup, not a replacement for the executor's
        // checked receipt. Preserve cancelled/partial/completed settlement and
        // delivery evidence; only transport or generation loss discards it.
        return { ok: true, result, ...(response.attachment === undefined ? {} : { attachment: response.attachment }) };
      } catch {
        await this.retireActive(session);
        return input.signal?.aborted === true ? { ok: false, code: "host_cancelled" } : { ok: false, code: "host_protocol_rejected" };
      } finally {
        input.signal?.removeEventListener("abort", onAbort);
      }
    } catch {
      await this.retireActive(session);
      return input.signal?.aborted === true ? { ok: false, code: "host_cancelled" } : { ok: false, code: "host_unavailable" };
    }
  }

  /** Explicit lifecycle teardown/revoke only; ordinary cancellation retains refs. */
  async close(): Promise<void> { await this.retireActive(); }

  private async ensureSession(signal?: AbortSignal): Promise<Readonly<{ launch: ComputerUseHostRuntimeLaunch; session: ComputerUseHostProtocolSession }> | null> {
    const current = this.active;
    const candidate = this.runtime.acquireLaunch();
    const inputs = this.hostInputs();
    if (candidate === null || inputs === null || !validLaunchInputs(inputs)) return null;
    if (current !== null && current.launch.generation === candidate.generation) {
      candidate.lease.release();
      return current;
    }
    candidate.lease.release();
    if (this.starting !== null) return await this.starting;
    this.starting = (async () => {
      const launch = this.runtime.acquireLaunch();
      const nextInputs = this.hostInputs();
      if (launch === null || nextInputs === null || !validLaunchInputs(nextInputs)) return null;
      if (this.active !== null && this.active.launch.generation === launch.generation) {
        launch.lease.release(); return this.active;
      }
      await this.retireActive();
      try {
        const session = await this.launcher.launch(launch, nextInputs, signal);
        this.active = { launch, session };
        return this.active;
      } catch { launch.lease.release(); return null; }
    })();
    try { return await this.starting; } finally { this.starting = null; }
  }

  private async retireActive(expected?: ComputerUseHostProtocolSession): Promise<void> {
    const active = this.active;
    if (active === null || (expected !== undefined && active.session !== expected)) return;
    this.active = null;
    try { await active.session.close(); } catch { /* process may already be gone */ }
    active.launch.lease.release();
  }
}

type PendingResult = {
  resolve(value: ComputerUseHostSessionResult): void;
  reject(reason?: unknown): void;
  result?: ComputerUseHostResult;
  attachment?: ComputerUseHostPngAttachment;
};

function matchingAttachment(result: ComputerUseHostResult, attachment: ComputerUseHostPngAttachment): boolean {
  const expected = result.attachment;
  const actual = attachment.metadata;
  return expected !== undefined
    && expected.attachmentId === actual.attachmentId
    && expected.requestId === actual.requestId
    && expected.hostGeneration === actual.hostGeneration
    && expected.driverGeneration === actual.driverGeneration
    && expected.sha256 === actual.sha256
    && expected.byteLength === actual.byteLength
    && expected.width === actual.width
    && expected.height === actual.height
    && expected.coordinateSpace === actual.coordinateSpace;
}

/** Exact stdio launcher for the signed Host artifact. No caller can append argv. */
export function createStdioComputerUseHostLauncher(
  spawnHost: (command: string, args: readonly string[]) => ChildProcess = (command, args) => spawn(command, args, {
    shell: false,
    stdio: ["pipe", "pipe", "pipe", "pipe"],
    windowsHide: true,
  }),
): ComputerUseHostLauncher {
  return {
    async launch(launch, input, signal) {
      if (!isAbsolute(launch.entrypoint) || launch.entrypoint.includes("\0") || !validLaunchInputs(input)) {
        throw new Error("computer_use_host_launch_untrusted");
      }
      if (signal?.aborted) throw new Error("computer_use_host_launch_cancelled");
      const child = spawnHost(launch.entrypoint, [
        "--cua-driver", input.driverPath,
        "--runtime-root", input.runtimeRoot,
        "--host-bundle-id", input.hostBundleId,
        "--attachment-fd", "3",
      ]);
      if (child.stdin === null || child.stdout === null || child.stderr === null || child.stdio[3] === null) {
        try { child.kill(); } catch { /* unavailable child */ }
        throw new Error("computer_use_host_pipes_unavailable");
      }
      const stdin = child.stdin;
      // Stderr is intentionally not a protocol or diagnostic channel. Drain it
      // only so a hostile/broken child cannot block its own stdout framing.
      child.stderr.resume();
      const decoder = new ControlFrameDecoder();
      const attachmentDecoder = new AttachmentFrameDecoder();
      const pending = new Map<string, PendingResult>();
      let readyResolve!: (ready: ComputerUseHostReady) => void;
      let readyReject!: (reason?: unknown) => void;
      const ready = new Promise<ComputerUseHostReady>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
      let closed = false;
      const rejectAll = (reason: unknown) => {
        readyReject(reason);
        for (const request of pending.values()) request.reject(reason);
        pending.clear();
      };
      const settle = (requestId: string, item: PendingResult) => {
        const result = item.result;
        if (result === undefined) return;
        if (result.attachment === undefined) {
          pending.delete(requestId);
          item.resolve({ result });
          return;
        }
        if (item.attachment === undefined) return;
        if (!matchingAttachment(result, item.attachment)) {
          pending.delete(requestId);
          item.reject(new Error("computer_use_host_attachment_mismatch"));
          return;
        }
        pending.delete(requestId);
        item.resolve({ result, attachment: item.attachment });
      };
      child.stdout.on("data", (chunk: Buffer) => {
        try {
          for (const message of decoder.push(Uint8Array.from(chunk))) {
            if (message.kind === "ready") readyResolve(message);
            else if (message.kind === "result") {
              const item = pending.get(message.requestId);
              if (item !== undefined) {
                item.result = message;
                settle(message.requestId, item);
              }
            }
          }
        } catch (error) { rejectAll(error); }
      });
      (child.stdio[3] as import("node:stream").Readable).on("data", (chunk: Buffer) => {
        try {
          for (const attachment of attachmentDecoder.push(Uint8Array.from(chunk))) {
            const item = pending.get(attachment.metadata.requestId);
            if (item === undefined || item.attachment !== undefined) throw new Error("computer_use_host_attachment_unexpected");
            item.attachment = attachment;
            settle(attachment.metadata.requestId, item);
          }
        } catch (error) { rejectAll(error); }
      });
      child.once("error", rejectAll);
      child.once("exit", () => {
        try { decoder.finish(); attachmentDecoder.finish(); } catch (error) { rejectAll(error); return; }
        rejectAll(new Error("computer_use_host_exited"));
      });
      const onAbort = () => { try { child.kill(); } catch { /* startup cancellation is best effort */ } };
      signal?.addEventListener("abort", onAbort, { once: true });
      let hostReady: ComputerUseHostReady;
      try { hostReady = await ready; } finally { signal?.removeEventListener("abort", onAbort); }
      return {
        ready: hostReady,
        request(message) {
          if (closed || stdin.destroyed) return Promise.reject(new Error("computer_use_host_closed"));
          return new Promise<ComputerUseHostSessionResult>((resolve, reject) => {
            pending.set(message.requestId, { resolve, reject });
            try { stdin.write(encodeControlFrame(message)); } catch (error) {
              pending.delete(message.requestId);
              reject(error instanceof Error ? error : new Error("computer_use_host_write_failed"));
            }
          });
        },
        cancel(message) {
          if (!closed && !stdin.destroyed) stdin.write(encodeControlFrame(message));
          return Promise.resolve();
        },
        close() {
          if (!closed) {
            closed = true;
            try { stdin.end(); } catch { /* closing an exited child is inert */ }
            try { child.kill(); } catch { /* host exit is best effort */ }
          }
          return Promise.resolve();
        },
      };
    },
  };
}
