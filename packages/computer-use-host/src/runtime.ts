import {
  COMPUTER_USE_HOST_PROTOCOL_MAJOR,
  COMPUTER_USE_HOST_PROTOCOL_MINOR,
  parseComputerUseHostControlMessage,
  type ComputerUseHostAuthorityScope,
  type ComputerUseHostAttachmentMetadata,
  type ComputerUseHostCancel,
  type ComputerUseHostContract,
  type ComputerUseHostControlMessage,
  type ComputerUseHostGenerationFence,
  type ComputerUseHostReady,
  type ComputerUseHostRequest,
  type ComputerUseHostResult,
  type ComputerUseJson,
  type ComputerUseSettlement,
} from "@nautilo/computer-use-host-protocol";
import { createHash, randomBytes } from "node:crypto";

export type ComputerUseContractHandlerContext = Readonly<{
  authority: ComputerUseHostAuthorityScope;
  contract: ComputerUseHostContract;
  signal: AbortSignal;
}>;

export type ComputerUseContractHandlerResult = Readonly<{
  settlement: ComputerUseSettlement;
  result: Readonly<Record<string, ComputerUseJson>>;
  attachment?: Readonly<{
    bytes: Uint8Array;
    width: number;
    height: number;
    coordinateSpace: ComputerUseHostAttachmentMetadata["coordinateSpace"];
  }>;
}>;

export type ComputerUseHostPngOutput = Readonly<{
  metadata: ComputerUseHostAttachmentMetadata;
  bytes: Uint8Array;
}>;

export type ComputerUseContractHandler = Readonly<{
  contract: ComputerUseHostContract;
  execute(argumentsValue: Readonly<Record<string, ComputerUseJson>>, context: ComputerUseContractHandlerContext): Promise<ComputerUseContractHandlerResult>;
}>;

export type ComputerUseHostOptions = Readonly<{
  hostGeneration: string;
  driverGeneration: string;
  handlers: readonly ComputerUseContractHandler[];
}>;

type ActiveRequest = Readonly<{ authority: ComputerUseHostAuthorityScope; fence: ComputerUseHostGenerationFence; abort: AbortController }>;

function sameAuthority(left: ComputerUseHostAuthorityScope, right: ComputerUseHostAuthorityScope): boolean {
  return left.authorityLeaseId === right.authorityLeaseId
    && left.authorityGeneration === right.authorityGeneration;
}

function contractKey(contract: ComputerUseHostContract): string {
  return `${contract.contractNamespace}\u0000${contract.contractId}\u0000${contract.contractVersion}`;
}

function sameContract(left: ComputerUseHostContract, right: ComputerUseHostContract): boolean {
  return contractKey(left) === contractKey(right)
    && left.schemaDigest === right.schemaDigest
    && left.effectClass === right.effectClass
    && left.replayClass === right.replayClass
    && left.authorityClass === right.authorityClass
    && left.attachmentClass === right.attachmentClass
    && left.disclosureClass === right.disclosureClass;
}

function rejected(request: ComputerUseHostRequest, settlement: ComputerUseSettlement, reason: string): ComputerUseHostResult {
  return {
    kind: "result",
    protocol: { major: COMPUTER_USE_HOST_PROTOCOL_MAJOR, minor: COMPUTER_USE_HOST_PROTOCOL_MINOR },
    requestId: request.requestId,
    fence: request.fence,
    contract: request.contract,
    settlement,
    result: { status: "host_rejected", reason },
  };
}

export class ComputerUseHost {
  readonly #handlers: ReadonlyMap<string, ComputerUseContractHandler>;
  readonly #active = new Map<string, ActiveRequest>();
  readonly #attachments = new Map<string, ComputerUseHostPngOutput>();
  #revoked = false;

  constructor(readonly options: ComputerUseHostOptions) {
    const handlers = new Map<string, ComputerUseContractHandler>();
    for (const handler of options.handlers) {
      const key = contractKey(handler.contract);
      if (handlers.has(key)) throw new Error("duplicate Computer Use Host contract");
      handlers.set(key, handler);
    }
    if (handlers.size === 0) throw new Error("Computer Use Host requires at least one contract handler");
    this.#handlers = handlers;
  }

  ready(): ComputerUseHostReady {
    return parseComputerUseHostControlMessage({
      kind: "ready",
      protocol: { major: COMPUTER_USE_HOST_PROTOCOL_MAJOR, minor: COMPUTER_USE_HOST_PROTOCOL_MINOR },
      hostGeneration: this.options.hostGeneration,
      driverGeneration: this.options.driverGeneration,
      contracts: [...this.#handlers.values()].map((handler) => handler.contract),
    }) as ComputerUseHostReady;
  }

  cancel(message: ComputerUseHostCancel): boolean {
    const active = this.#active.get(message.requestId);
    if (active === undefined || !sameAuthority(active.authority, message.authority)
      || message.fence.hostGeneration !== this.options.hostGeneration
      || message.fence.driverGeneration !== this.options.driverGeneration
      || active.fence.hostGeneration !== message.fence.hostGeneration
      || active.fence.driverGeneration !== message.fence.driverGeneration
      || active.fence.cancellationGeneration !== message.fence.cancellationGeneration) return false;
    active.abort.abort();
    return true;
  }

  /** Host transport teardown revokes every in-flight request in this generation. */
  cancelAll(): number {
    const active = [...this.#active.values()];
    for (const request of active) request.abort.abort();
    return active.length;
  }

  /** This Host generation cannot be reopened after its checked driver is lost. */
  revoke(): void {
    this.#revoked = true;
    this.cancelAll();
    for (const attachment of this.#attachments.values()) attachment.bytes.fill(0);
    this.#attachments.clear();
  }

  /** Destructive attachment handoff; PNG bytes can never be replayed by request id. */
  takeAttachment(requestId: string): ComputerUseHostPngOutput | null {
    const attachment = this.#attachments.get(requestId) ?? null;
    this.#attachments.delete(requestId);
    return attachment;
  }

  async dispatch(messageValue: ComputerUseHostControlMessage): Promise<ComputerUseHostResult | null> {
    const message = parseComputerUseHostControlMessage(messageValue);
    if (message.kind === "cancel") {
      this.cancel(message);
      return null;
    }
    if (message.kind !== "request") return null;
    if (this.#revoked) return rejected(message, "stale", "stale_generation");
    this.#attachments.delete(message.requestId);
    if (message.fence.hostGeneration !== this.options.hostGeneration || message.fence.driverGeneration !== this.options.driverGeneration) {
      return rejected(message, "stale", "stale_generation");
    }
    if (this.#active.has(message.requestId)) return rejected(message, "fenced", "duplicate_request");
    const handler = this.#handlers.get(contractKey(message.contract));
    if (handler === undefined || !sameContract(message.contract, handler.contract)) {
      return rejected(message, "fenced", "unsupported_contract");
    }
    const abort = new AbortController();
    this.#active.set(message.requestId, { authority: message.authority, fence: message.fence, abort });
    try {
      const settled = await handler.execute(message.arguments, { authority: message.authority, contract: message.contract, signal: abort.signal });
      if (this.#revoked) {
        settled.attachment?.bytes.fill(0);
        return message.contract.replayClass === "at_most_once"
          ? rejected(message, "unknown_completion", "host_failure")
          : rejected(message, "stale", "stale_generation");
      }
      const attachment = settled.attachment === undefined ? undefined : {
        attachmentId: `png:${randomBytes(18).toString("base64url")}`,
        requestId: message.requestId,
        hostGeneration: message.fence.hostGeneration,
        driverGeneration: message.fence.driverGeneration,
        mime: "image/png" as const,
        byteLength: settled.attachment.bytes.byteLength,
        sha256: createHash("sha256").update(settled.attachment.bytes).digest("hex"),
        width: settled.attachment.width,
        height: settled.attachment.height,
        coordinateSpace: settled.attachment.coordinateSpace,
      };
      if (attachment !== undefined) {
        this.#attachments.set(message.requestId, {
          metadata: attachment,
          bytes: settled.attachment!.bytes.slice(),
        });
      }
      return parseComputerUseHostControlMessage({
        kind: "result",
        protocol: { major: COMPUTER_USE_HOST_PROTOCOL_MAJOR, minor: COMPUTER_USE_HOST_PROTOCOL_MINOR },
        requestId: message.requestId,
        fence: message.fence,
        contract: message.contract,
        settlement: settled.settlement,
        result: settled.result,
        ...(attachment === undefined ? {} : { attachment }),
      }) as ComputerUseHostResult;
    } catch {
      this.#attachments.delete(message.requestId);
      return rejected(message, abort.signal.aborted ? "cancelled" : "failed", abort.signal.aborted ? "cancelled" : "host_failure");
    } finally {
      this.#active.delete(message.requestId);
    }
  }
}
