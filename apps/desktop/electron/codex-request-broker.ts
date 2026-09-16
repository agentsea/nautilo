import { randomUUID } from "node:crypto";
import type {
  ServerRequestContext,
} from "@nautilo/codex-app-server";
import type {
  ChildIdentity,
  PersistedBindingRecord,
} from "@nautilo/codex-app-server-host/internal";
import { toRelayWorkspaceReceipt } from "@nautilo/codex-app-server-host/internal";
import {
  type RelayCodexHostTransport,
  type RelayCodexRequestMessage,
  type RelayCodexRequestResponseMessage,
  type RelayCodexSession,
  type RequestScope,
} from "@nautilo/relay";
import { type ProjectedCodexHumanRequest } from "./codex-request-proxy.ts";

type RelayHumanResponse = RelayCodexRequestResponseMessage["response"];
type RelayHumanRequest = RelayCodexRequestMessage["request"];

type HostTimer = {
  readonly setTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
};

export interface ElectronCodexRequestBrokerOptions {
  readonly session: () => RelayCodexSession | null;
  readonly transport: () => RelayCodexHostTransport | null;
  readonly now?: () => number;
  readonly timer?: HostTimer;
  readonly mintRequestRef?: () => string;
  readonly maxPendingRequests?: number;
}

/** Bounded Electron-main state; this is not a durable queue. */
const CODEX_LOCAL_MAX_PENDING_REQUESTS = 32;
/** A broken/injected UUID source must not spin the Electron main process. */
export const CODEX_REQUEST_REF_MAX_ATTEMPTS = 8;

interface PendingCodexRequest {
  readonly scope: RequestScope;
  readonly kind: RelayHumanResponse["kind"];
  readonly resolve: (response: RelayHumanResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
  settled: boolean;
}

/**
 * Electron-main-only correlation authority for native Codex human requests.
 *
 * Nothing here is durable. The app-server request id and decoded parameters
 * remain inside the request handler closure; only a semantic projection plus
 * an opaque random requestRef crosses the relay.
 */
export class ElectronCodexRequestBroker {
  private readonly pending = new Map<string, PendingCodexRequest>();
  private readonly now: () => number;
  private readonly timer: HostTimer;
  private readonly mintRequestRef: () => string;
  private readonly maxPendingRequests: number;

  constructor(private readonly options: ElectronCodexRequestBrokerOptions) {
    this.now = options.now ?? (() => Date.now());
    this.timer = options.timer ?? defaultTimer;
    this.mintRequestRef = options.mintRequestRef ?? randomUUID;
    this.maxPendingRequests = options.maxPendingRequests ?? CODEX_LOCAL_MAX_PENDING_REQUESTS;
    if (!Number.isSafeInteger(this.maxPendingRequests) || this.maxPendingRequests <= 0) {
      throw new Error("Codex pending request limit must be a positive integer");
    }
  }

  request(input: {
    readonly child: ChildIdentity;
    readonly binding: PersistedBindingRecord;
    readonly context: ServerRequestContext;
    readonly projected: ProjectedCodexHumanRequest;
  }): Promise<RelayHumanResponse> {
    // Legacy callbacks provide a conversation id/call id but no exact turn.
    // Do not guess from "active" state: that would cross a turn authority.
    const turnId = input.projected.turnId;
    if (turnId === null) {
      return Promise.reject(new Error("Codex legacy request lacks exact turn authority"));
    }
    const session = this.options.session();
    const transport = this.options.transport();
    if (!session || !transport) return Promise.reject(new Error("Codex relay is unavailable"));
    if (input.projected.threadId !== input.binding.threadId) {
      return Promise.reject(new Error("Codex request thread is not bound"));
    }

    const expiresAtMs = Date.parse(input.context.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= this.now()) {
      return Promise.reject(new Error("Codex request has expired"));
    }
    if (this.pending.size >= this.maxPendingRequests) {
      return Promise.reject(new Error("Codex request queue is full"));
    }
    const requestRef = this.nextRequestRef();
    if (!requestRef) return Promise.reject(new Error("Codex request correlation is unavailable"));
    const scope = this.scopeFor(input.child, input.binding, {
      threadId: input.projected.threadId,
      turnId,
      itemId: input.projected.itemId,
    }, requestRef);
    const delayMs = Math.max(1, Math.ceil(expiresAtMs - this.now()));

    return new Promise<RelayHumanResponse>((resolve, reject) => {
      const onAbort = () => this.reject(requestRef, new Error("Codex request was cancelled"));
      const timer = this.timer.setTimeout(
        () => this.reject(requestRef, new Error("Codex request has expired")),
        delayMs,
      );
      const pending: PendingCodexRequest = {
        scope,
        kind: input.projected.request.kind,
        resolve,
        reject,
        timer,
        signal: input.context.signal,
        onAbort,
        settled: false,
      };
      this.pending.set(requestRef, pending);
      input.context.signal.addEventListener("abort", onAbort, { once: true });
      if (input.context.signal.aborted) {
        onAbort();
        return;
      }
      const accepted = sendHumanRequest(transport, scope, input.projected.request);
      if (!accepted) this.reject(requestRef, new Error("Codex relay is unavailable"));
    });
  }

  respond(message: RelayCodexRequestResponseMessage): boolean {
    const pending = this.pending.get(message.scope.requestRef);
    if (!pending || pending.settled) return false;
    if (!sameRequestScope(pending.scope, message.scope)) return false;
    if (pending.kind !== message.response.kind) return false;
    this.resolve(message.scope.requestRef, message.response);
    return true;
  }

  cancelTurn(turn: Pick<RequestScope, "relayId" | "relaySessionId" | "desktopSessionId" | "pairingGenerationRef" | "capabilityRevision" | "selectedProtocolVersion" | "profileHandle" | "profileGeneration" | "accountGeneration" | "runtimeGeneration" | "childGeneration" | "bindingId" | "bindingGeneration" | "taskId" | "jobId" | "threadId" | "workspace" | "turnId">): void {
    for (const [requestRef, pending] of this.pending) {
      if (sameTurnScope(pending.scope, turn)) {
        this.reject(requestRef, new Error("Codex request was cancelled"));
      }
    }
  }

  cancelAll(): void {
    for (const requestRef of this.pending.keys()) {
      this.reject(requestRef, new Error("Codex request was cancelled"));
    }
  }

  private nextRequestRef(): string | null {
    for (let attempt = 0; attempt < CODEX_REQUEST_REF_MAX_ATTEMPTS; attempt += 1) {
      const value = this.mintRequestRef();
      if (!this.pending.has(value)) return value;
    }
    return null;
  }

  private scopeFor(
    child: ChildIdentity,
    binding: PersistedBindingRecord,
    projected: { readonly threadId: string; readonly turnId: string; readonly itemId: string },
    requestRef: string,
  ): RequestScope {
    const session = this.options.session();
    if (!session) throw new Error("Codex relay is unavailable");
    return {
      ...session,
      profileHandle: child.profile.profileHandle,
      profileGeneration: child.profile.profileGeneration,
      accountGeneration: child.accountGeneration,
      runtimeGeneration: child.runtimeGeneration,
      childGeneration: child.childGeneration,
      bindingId: binding.bindingId,
      bindingGeneration: binding.bindingGeneration,
      taskId: binding.taskId,
      jobId: binding.jobId,
      threadId: binding.threadId,
      workspace: toRelayWorkspaceReceipt(binding.workspace),
      turnId: projected.turnId,
      eventId: randomUUID(),
      itemId: projected.itemId,
      requestRef,
    };
  }

  private resolve(requestRef: string, response: RelayHumanResponse): void {
    const pending = this.take(requestRef);
    if (pending) pending.resolve(response);
  }

  private reject(requestRef: string, error: Error): void {
    const pending = this.take(requestRef);
    if (pending) pending.reject(error);
  }

  private take(requestRef: string): PendingCodexRequest | null {
    const pending = this.pending.get(requestRef);
    if (!pending || pending.settled) return null;
    pending.settled = true;
    this.pending.delete(requestRef);
    this.timer.clearTimeout(pending.timer);
    pending.signal.removeEventListener("abort", pending.onAbort);
    return pending;
  }
}

const defaultTimer: HostTimer = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

function sameRequestScope(left: RequestScope, right: RequestScope): boolean {
  return sameTurnScope(left, right)
    && left.eventId === right.eventId
    && left.itemId === right.itemId
    && left.requestRef === right.requestRef
    && (!("callRef" in left) || !("callRef" in right) || left.callRef === right.callRef);
}

function sameTurnScope(
  left: Pick<RequestScope, "relayId" | "relaySessionId" | "desktopSessionId" | "pairingGenerationRef" | "capabilityRevision" | "selectedProtocolVersion" | "profileHandle" | "profileGeneration" | "accountGeneration" | "runtimeGeneration" | "childGeneration" | "bindingId" | "bindingGeneration" | "taskId" | "jobId" | "threadId" | "workspace" | "turnId">,
  right: Pick<RequestScope, "relayId" | "relaySessionId" | "desktopSessionId" | "pairingGenerationRef" | "capabilityRevision" | "selectedProtocolVersion" | "profileHandle" | "profileGeneration" | "accountGeneration" | "runtimeGeneration" | "childGeneration" | "bindingId" | "bindingGeneration" | "taskId" | "jobId" | "threadId" | "workspace" | "turnId">,
): boolean {
  return left.relayId === right.relayId
    && left.relaySessionId === right.relaySessionId
    && left.desktopSessionId === right.desktopSessionId
    && left.pairingGenerationRef === right.pairingGenerationRef
    && left.capabilityRevision === right.capabilityRevision
    && left.selectedProtocolVersion === right.selectedProtocolVersion
    && left.profileHandle === right.profileHandle
    && left.profileGeneration === right.profileGeneration
    && left.accountGeneration === right.accountGeneration
    && left.runtimeGeneration === right.runtimeGeneration
    && left.childGeneration === right.childGeneration
    && left.bindingId === right.bindingId
    && left.bindingGeneration === right.bindingGeneration
    && left.taskId === right.taskId
    && left.jobId === right.jobId
    && left.threadId === right.threadId
    && left.turnId === right.turnId
    && sameWorkspace(left.workspace, right.workspace);
}

function sameWorkspace(
  left: RequestScope["workspace"],
  right: RequestScope["workspace"],
): boolean {
  return left.workspaceRef === right.workspaceRef
    && left.revision === right.revision
    && left.fingerprint === right.fingerprint
    && left.issuedAt === right.issuedAt
    && left.expiresAt === right.expiresAt;
}

function sendHumanRequest(
  transport: RelayCodexHostTransport,
  scope: RequestScope,
  request: RelayHumanRequest,
): boolean {
  switch (request.kind) {
    case "command_approval":
      return transport.send({ type: "relay:codex-request", scope, request });
    case "network_approval":
      return transport.send({ type: "relay:codex-request", scope, request });
    case "file_change_approval":
      return transport.send({ type: "relay:codex-request", scope, request });
    case "permissions_approval":
      return transport.send({ type: "relay:codex-request", scope, request });
    case "user_input":
      return transport.send({ type: "relay:codex-request", scope, request });
  }
}
