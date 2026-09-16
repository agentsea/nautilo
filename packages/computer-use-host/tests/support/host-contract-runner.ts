import { createHash } from "node:crypto";

import {
  COMPUTER_USE_HOST_PROTOCOL_MAJOR,
  COMPUTER_USE_HOST_PROTOCOL_MINOR,
  ComputerUseHostProtocolError,
  ComputerUseHostResultGate,
  assertComputerUseHostAttachmentMatchesResult,
  stringifyCanonicalComputerUseJson,
  type ComputerUseHostAuthorityScope,
  type ComputerUseHostContract,
  type ComputerUseHostGenerationFence,
  type ComputerUseHostResult,
  type ComputerUseJson,
} from "@nautilo/computer-use-host-protocol";

import type { ComputerUseHost, ComputerUseHostPngOutput } from "../../src/runtime.ts";

export type HostContractEvidenceMode = "simulated" | "source-live";
export type HostContractCallOutcome =
  | "accepted"
  | "cancelled"
  | "dispatch_rejected"
  | "invalid_result"
  | "invalid_attachment";

export type HostContractCallEvidence = Readonly<{
  evidenceMode: HostContractEvidenceMode;
  qualification: "unverified";
  requestId: string;
  startedAtMs: number;
  completedAtMs: number;
  durationMs: number;
  requestCount: 1;
  resultCount: 0 | 1;
  argumentBytes: number;
  resultPayloadBytes: number;
  imageBytes: number;
  outcome: HostContractCallOutcome;
  settlement: ComputerUseHostResult["settlement"] | null;
}>;

export type DisposablePngAttachment = Readonly<{
  metadata: ComputerUseHostPngOutput["metadata"];
  bytes: Uint8Array;
  dispose(): void;
}>;

export type HostContractCallResult = Readonly<{
  result: ComputerUseHostResult;
  attachment: DisposablePngAttachment | null;
  evidence: HostContractCallEvidence;
}>;

export type HostContractCall = Readonly<{
  requestId: string;
  result: Promise<HostContractCallResult>;
  cancel(): boolean;
}>;

type DispatchHost = Pick<ComputerUseHost, "cancel" | "dispatch" | "takeAttachment">;

export type HostContractRunnerOptions = Readonly<{
  host: DispatchHost;
  authority: ComputerUseHostAuthorityScope;
  fence: ComputerUseHostGenerationFence;
  evidenceMode: HostContractEvidenceMode;
  now?: () => number;
  recordEvidence?: (evidence: HostContractCallEvidence) => void;
}>;

export type HostContractInvocation = Readonly<{
  requestId: string;
  contract: ComputerUseHostContract;
  arguments: Readonly<Record<string, ComputerUseJson>>;
}>;

const encoder = new TextEncoder();

function canonicalBytes(value: ComputerUseJson): number {
  return encoder.encode(stringifyCanonicalComputerUseJson(value)).byteLength;
}

function checkedAttachment(
  output: ComputerUseHostPngOutput,
  result: ComputerUseHostResult,
  onDispose: (attachment: DisposablePngAttachment) => void,
): DisposablePngAttachment {
  const { metadata, bytes } = output;
  try {
    assertComputerUseHostAttachmentMatchesResult(metadata, result);
    if (result.attachment === undefined
      || metadata.attachmentId !== result.attachment.attachmentId
      || metadata.byteLength !== bytes.byteLength
      || metadata.byteLength !== result.attachment.byteLength
      || metadata.sha256 !== result.attachment.sha256
      || metadata.sha256 !== createHash("sha256").update(bytes).digest("hex")) {
      throw new ComputerUseHostProtocolError("invalid_attachment");
    }
  } catch (error) {
    bytes.fill(0);
    throw error;
  }

  let disposed = false;
  const attachment: DisposablePngAttachment = {
    metadata,
    bytes,
    dispose() {
      if (disposed) return;
      disposed = true;
      bytes.fill(0);
      onDispose(attachment);
    },
  };
  return attachment;
}

/** Thin test-only caller for the real Host dispatch and protocol validation path. */
export class HostContractRunner {
  readonly #host: DispatchHost;
  readonly #authority: ComputerUseHostAuthorityScope;
  readonly #fence: ComputerUseHostGenerationFence;
  readonly #evidenceMode: HostContractEvidenceMode;
  readonly #now: () => number;
  readonly #recordEvidence: ((evidence: HostContractCallEvidence) => void) | undefined;
  readonly #active = new Map<string, HostContractCall>();
  readonly #attachments = new Set<DisposablePngAttachment>();
  #disposed = false;

  constructor(options: HostContractRunnerOptions) {
    this.#host = options.host;
    this.#authority = options.authority;
    this.#fence = options.fence;
    this.#evidenceMode = options.evidenceMode;
    this.#now = options.now ?? performance.now.bind(performance);
    this.#recordEvidence = options.recordEvidence;
  }

  start(invocation: HostContractInvocation): HostContractCall {
    if (this.#disposed) throw new Error("host contract runner disposed");
    if (this.#active.has(invocation.requestId)) throw new Error("host contract request already active");

    const request = {
      kind: "request",
      protocol: { major: COMPUTER_USE_HOST_PROTOCOL_MAJOR, minor: COMPUTER_USE_HOST_PROTOCOL_MINOR },
      requestId: invocation.requestId,
      authority: this.#authority,
      fence: this.#fence,
      contract: invocation.contract,
      arguments: invocation.arguments,
    } as const;
    const gate = new ComputerUseHostResultGate({
      requestId: request.requestId,
      hostGeneration: this.#fence.hostGeneration,
      driverGeneration: this.#fence.driverGeneration,
      cancellationGeneration: this.#fence.cancellationGeneration,
      authority: this.#authority,
      contract: invocation.contract,
    });
    const startedAtMs = this.#now();
    let cancellationAccepted = false;

    let call!: HostContractCall;
    const result = (async () => {
      let settled: ComputerUseHostResult | null = null;
      let output: ComputerUseHostPngOutput | null = null;
      let attachment: DisposablePngAttachment | null = null;
      let failureOutcome: Exclude<HostContractCallOutcome, "accepted"> = "dispatch_rejected";
      const finish = (outcome: HostContractCallOutcome): HostContractCallEvidence => {
        const completedAtMs = Math.max(startedAtMs, this.#now());
        const evidence: HostContractCallEvidence = {
          evidenceMode: this.#evidenceMode,
          qualification: "unverified",
          requestId: request.requestId,
          startedAtMs,
          completedAtMs,
          durationMs: completedAtMs - startedAtMs,
          requestCount: 1,
          resultCount: settled === null ? 0 : 1,
          argumentBytes: canonicalBytes(request.arguments),
          resultPayloadBytes: settled === null ? 0 : canonicalBytes(settled.result),
          imageBytes: output?.bytes.byteLength ?? 0,
          outcome,
          settlement: settled?.settlement ?? null,
        };
        try {
          this.#recordEvidence?.(evidence);
        } catch {
          // Measurement is best-effort and must not alter the Host outcome.
        }
        return evidence;
      };
      try {
        const raw = await this.#host.dispatch(request);
        failureOutcome = "invalid_attachment";
        output = this.#host.takeAttachment(request.requestId);
        failureOutcome = "invalid_result";
        if (raw === null) throw new ComputerUseHostProtocolError("invalid_message");
        const checkedResult = gate.accept(raw);
        failureOutcome = "invalid_attachment";
        if (checkedResult.attachment === undefined) {
          if (output !== null) {
            throw new ComputerUseHostProtocolError("invalid_attachment");
          }
        } else {
          if (output === null) throw new ComputerUseHostProtocolError("invalid_attachment");
          attachment = checkedAttachment(output, checkedResult, (disposed) => this.#attachments.delete(disposed));
          this.#attachments.add(attachment);
        }
        settled = checkedResult;
        return { result: settled, attachment, evidence: finish("accepted") };
      } catch (error) {
        output?.bytes.fill(0);
        finish(cancellationAccepted ? "cancelled" : failureOutcome);
        throw error;
      }
    })().finally(() => this.#active.delete(request.requestId));

    const cancellation = {
      kind: "cancel",
      protocol: request.protocol,
      requestId: request.requestId,
      authority: this.#authority,
      fence: this.#fence,
    } as const;
    call = {
      requestId: request.requestId,
      result,
      cancel: () => {
        if (cancellationAccepted) return true;
        if (!this.#host.cancel(cancellation)) return false;
        gate.cancel(cancellation);
        cancellationAccepted = true;
        return true;
      },
    };
    this.#active.set(request.requestId, call);
    return call;
  }

  execute(invocation: HostContractInvocation): Promise<HostContractCallResult> {
    return this.start(invocation).result;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const call of this.#active.values()) call.cancel();
    await Promise.allSettled([...this.#active.values()].map((call) => call.result));
    for (const attachment of this.#attachments) attachment.dispose();
    this.#attachments.clear();
  }
}
