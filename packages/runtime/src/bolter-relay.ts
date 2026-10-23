import { randomUUID } from "node:crypto";
import {
  BOLTER_RELAY_PROTOCOL_VERSION, BOLTER_FILES_PROTOCOL_VERSION, parseRelayBolterDesktopMessage, parseRelayBolterServerMessage, sameRelayBolterScope,
  type RelayBolterScope, type RelayBolterCommand, type RelayBolterDesktopMessage, type RelayBolterServerMessage,
  type RelayBolterObservation, type RelayBolterBatch, type BolterAuthorizedContent,
} from "@nautilo/relay";
import type { BolterNativeCommand, BolterNativeResult } from "@nautilo/types";

export type BolterRelaySession = RelayBolterScope & Readonly<{ userId: string }>;
export type BolterObservationListener = (input: { userId: string; message: RelayBolterObservation }) => void;
export type BolterBatchListener = (input: { userId: string; message: RelayBolterBatch }) => Promise<"accepted" | "blocked">;
export type BolterContextListener = (relayId: string, userId: string, session: BolterRelaySession | null) => void;
type Pending = { authorize?: (() => Promise<BolterAuthorizedContent | null>) | undefined; authorizationUsed: boolean; authorizing?: boolean; session: BolterRelaySession; command: RelayBolterCommand; resolve(result: BolterNativeResult): void; reject(error: Error): void; cleanup(): void };

/** Socket correlation only. Durable inbox/outbox and authority stay in the server bridge. */
export class BolterRelayTransport {
  private readonly contexts = new Map<string, BolterRelaySession>();
  private readonly pending = new Map<string, Pending>();
  private readonly observers = new Set<BolterObservationListener>();
  private readonly contextListeners = new Set<BolterContextListener>();
  private batchListener: BolterBatchListener | null = null;
  private readonly receiving = new Set<string>();
  constructor(private readonly current: (relayId: string, userId: string) => BolterRelaySession | null,
    private readonly send: (session: BolterRelaySession, message: RelayBolterServerMessage) => boolean) {}
  session(relayId: string, userId: string): BolterRelaySession | null {
    const published = this.contexts.get(relayId);
    const current = this.current(relayId, userId);
    return published?.userId === userId && current && sameRelayBolterScope(published, current) ? { ...current } : null;
  }
  sessions(userId: string): BolterRelaySession[] {
    return [...this.contexts.keys()].flatMap(relayId => { const value = this.session(relayId, userId); return value ? [value] : []; });
  }
  publish(relayId: string, userId: string): boolean {
    const session = this.current(relayId, userId);
    if (!session) return false;
    const prior = this.contexts.get(relayId);
    if (prior?.userId === userId && sameRelayBolterScope(prior, session)) return true;
    this.invalidate(relayId);
    this.contexts.set(relayId, Object.freeze({ ...session }));
    for (const listener of this.contextListeners) { try { listener(relayId, userId, { ...session }); } catch { /* observer only */ } }
    return true;
  }
  invalidate(relayId: string): void {
    const previous = this.contexts.get(relayId);
    this.contexts.delete(relayId);
    for (const [id, pending] of this.pending) if (pending.session.relayId === relayId) {
      this.pending.delete(id); pending.cleanup(); pending.reject(new Error("BOLTER_CONTEXT_STALE"));
    }
    if (previous) for (const listener of this.contextListeners) { try { listener(relayId, previous.userId, null); } catch { /* observer only */ } }
  }
  close(): void { for (const relayId of this.contexts.keys()) this.invalidate(relayId); }
  onContext(listener: BolterContextListener): () => void { this.contextListeners.add(listener); return () => { this.contextListeners.delete(listener); }; }
  onObservation(listener: BolterObservationListener): () => void { this.observers.add(listener); return () => { this.observers.delete(listener); }; }
  onBatch(listener: BolterBatchListener): () => void {
    if (this.batchListener) throw new Error("BOLTER_RECEIVER_ALREADY_REGISTERED");
    this.batchListener = listener;
    return () => { if (this.batchListener === listener) this.batchListener = null; };
  }
  request(input: { relayId: string; userId: string; command: BolterNativeCommand; signal: AbortSignal; authorize?: (() => Promise<BolterAuthorizedContent | null>) | undefined }): Promise<BolterNativeResult> {
    const session = this.session(input.relayId, input.userId);
    if (!session || input.signal.aborted) return Promise.reject(new Error("BOLTER_UNAVAILABLE"));
    const { userId: _userId, ...scope } = session;
    const parsed = parseRelayBolterServerMessage({ type: "relay:bolter-command", version: BOLTER_RELAY_PROTOCOL_VERSION,
      scope, correlationId: randomUUID(), command: input.command });
    if (parsed?.type !== "relay:bolter-command") return Promise.reject(new Error("BOLTER_INVALID_COMMAND"));
    const command = structuredClone(parsed);
    return new Promise((resolve, reject) => {
      const abort = () => {
        if (!this.pending.delete(command.correlationId)) return;
        cleanup(); reject(new Error("BOLTER_COMMAND_INTERRUPTED"));
      };
      const cleanup = () => input.signal.removeEventListener("abort", abort);
      this.pending.set(command.correlationId, { session, command, resolve, reject, cleanup, authorize: input.authorize, authorizationUsed: false });
      input.signal.addEventListener("abort", abort, { once: true });
      // No retry: even a thrown send can have crossed the transport boundary.
      try {
        if (!this.send(session, command)) throw new Error("BOLTER_UNAVAILABLE");
      } catch {
        this.pending.delete(command.correlationId); cleanup(); reject(new Error("BOLTER_COMMAND_INTERRUPTED"));
      }
    });
  }
  async accept(input: { relayId: string; userId: string; message: RelayBolterDesktopMessage }): Promise<{ ok: true } | { ok: false; error: string }> {
    const parsed = parseRelayBolterDesktopMessage(input.message);
    const session = this.session(input.relayId, input.userId);
    if (!parsed || !session || !sameRelayBolterScope(parsed.scope, session)) return { ok: false, error: "BOLTER_CONTEXT_STALE" };
    const message = structuredClone(parsed);
    if (message.type === "relay:bolter-authorize") {
      const pending = this.pending.get(message.correlationId);
      if (!pending || pending.authorizing || (pending.authorizationUsed && session.selectedProtocolVersion < BOLTER_FILES_PROTOCOL_VERSION) || !pending.authorize || pending.command.command.action !== "send"
        || pending.command.command.outboxId !== message.outboxId || pending.session.userId !== input.userId
        || !sameRelayBolterScope(pending.session, session)) return { ok: false, error: "BOLTER_AUTHORIZATION_STALE" };
      pending.authorizationUsed = true;
      pending.authorizing = true;
      let content: BolterAuthorizedContent | null = null;
      try { content = await pending.authorize(); } catch { /* deny disclosure */ }
      finally { pending.authorizing = false; }
      const current = this.session(input.relayId, input.userId);
      if (this.pending.get(message.correlationId) !== pending || !current || !sameRelayBolterScope(session, current)) return { ok: false, error: "BOLTER_CONTEXT_STALE" };
      const response = parseRelayBolterServerMessage({ type: "relay:bolter-authorized", version: BOLTER_RELAY_PROTOCOL_VERSION,
        scope: message.scope, correlationId: message.correlationId, outboxId: message.outboxId,
        content: content ? { chatId: content.chatId, threadRootId: content.threadRootId, content: content.content,
          ...(content.files ? { files: content.files } : {}) } : null });
      try {
        if (!response) {
          // A denied oversized disclosure still releases the waiting native preparation.
          this.send(current, { type: "relay:bolter-authorized", version: BOLTER_RELAY_PROTOCOL_VERSION,
            scope: message.scope, correlationId: message.correlationId, outboxId: message.outboxId, content: null });
          throw new Error("BOLTER_UNAVAILABLE");
        }
        if (!this.send(current, response)) throw new Error("BOLTER_UNAVAILABLE");
      } catch {
        // Disclosure may have crossed the socket boundary. Retire without replay.
        if (this.pending.get(message.correlationId) === pending) {
          this.pending.delete(message.correlationId);
          pending.cleanup();
          pending.reject(new Error("BOLTER_COMMAND_INTERRUPTED"));
        }
        return { ok: false, error: "BOLTER_UNAVAILABLE" };
      }
      return { ok: true };
    }
    if (message.type === "relay:bolter-result") {
      const pending = this.pending.get(message.correlationId);
      if (!pending || pending.session.userId !== input.userId || !sameRelayBolterScope(pending.session, session)) return { ok: false, error: "BOLTER_CORRELATION_STALE" };
      this.pending.delete(message.correlationId); pending.cleanup(); pending.resolve(message.result);
    } else if (message.type === "relay:bolter-observation") {
      for (const observer of this.observers) { try { observer({ userId: input.userId, message }); } catch { /* observer only */ } }
    } else {
      // One in-flight handover per socket: extra frames receive blocked, never an acceptance ACK.
      const key = JSON.stringify([session.relayId, session.relaySessionId]);
      let status: "accepted" | "blocked" = "blocked";
      if (!this.receiving.has(key) && this.batchListener) {
        this.receiving.add(key);
        try { status = await this.batchListener({ userId: input.userId, message }); } catch { /* retained by Desktop spool */ }
        finally { this.receiving.delete(key); }
      }
      const current = this.session(input.relayId, input.userId);
      if (!current || !sameRelayBolterScope(session, current)) return { ok: false, error: "BOLTER_CONTEXT_STALE" };
      this.send(current, { type: "relay:bolter-batch-ack", version: BOLTER_RELAY_PROTOCOL_VERSION, scope: message.scope,
        connectionId: message.connectionId, generation: message.generation, batchId: message.batchId, status });
    }
    return { ok: true };
  }
}
