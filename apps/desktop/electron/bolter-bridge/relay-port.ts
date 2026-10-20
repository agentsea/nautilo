import {
  BOLTER_RELAY_PROTOCOL_VERSION, BOLTER_FILES_PROTOCOL_VERSION, parseRelayBolterServerMessage, sameRelayBolterScope,
  type RelayBolterAuthorized, type RelayBolterBatchAck, type RelayBolterCommand, type RelayBolterHostPort,
  type RelayBolterHostTransport, type RelayBolterScope,
} from "@nautilo/relay";
import type { BolterConnectionObservation, BolterNativeResult, BolterReceivedMessage } from "@nautilo/types";

export interface BolterNativeConnectionDriver {
  connect(onLink: (auth: { url: string; code: string }) => void): Promise<BolterConnectionObservation>;
  check(): Promise<BolterConnectionObservation>;
  conversations(): Promise<BolterNativeResult>;
  start(accept: (messages: readonly BolterReceivedMessage[], batchId: string) => Promise<boolean>,
    onObservation?: (observation: BolterConnectionObservation) => void): Promise<BolterConnectionObservation>;
  pause(): Promise<BolterConnectionObservation>;
  prepareSend(): Promise<((content: NonNullable<RelayBolterAuthorized["content"]>, reauthorize?: () => Promise<boolean>) => Promise<BolterNativeResult>) | null>;
  retire(): Promise<void>;
}
type Connection = { id: string; generation: number; active: boolean; driver: BolterNativeConnectionDriver };
type Session = { scope: RelayBolterScope; transport: RelayBolterHostTransport;
  commands: Map<string, { fingerprint: string; result: Promise<BolterNativeResult> }>;
  sends: Map<string, { fingerprint: string; result: Promise<BolterNativeResult> }>;
  generations: Map<string, number>;
  connections: Map<string, { generation: number; pending: Promise<Connection> }>; operations: Map<string, Promise<Connection>>;
  authorizations: Map<string, { connectionId: string; outboxId: string; resolve(value: RelayBolterAuthorized["content"]): void }>;
  batches: Map<string, { connectionId: string; generation: number; resolve(value: boolean): void }> };
const unavailable = (reason: Extract<BolterNativeResult, { kind: "unavailable" }>["reason"]): BolterNativeResult => ({ kind: "unavailable", reason });

/** Fixed native adapter lane. Generation retirement, never a second WebSocket, owns cancellation. */
export function createBolterNativeRelayPort(options: {
  readonly isCurrent: () => boolean;
  readonly createConnection: (input: { connectionId: string; generation: number; homeHandle?: string;
    isCurrent: () => boolean }) => Promise<BolterNativeConnectionDriver>;
}): RelayBolterHostPort & { retire(): Promise<void> } {
  const factory = options.createConnection;
  const fence = options.isCurrent;
  let session: Session | null = null;
  let retirement = Promise.resolve();
  const current = (s: Session) => { try { return session === s && fence(); } catch { return false; } };
  const projectedObservation = (s: Session, value: BolterConnectionObservation): BolterConnectionObservation => {
    if (s.scope.selectedProtocolVersion >= BOLTER_FILES_PROTOCOL_VERSION) return value;
    const { attachments: _attachments, ...legacy } = value;
    return legacy;
  };
  const observation = (s: Session, connection: Connection, value: BolterConnectionObservation) => {
    if (current(s) && connection.active && s.connections.get(connection.id)?.generation === connection.generation
      && s.generations.get(connection.id) === connection.generation) s.transport.send({ type: "relay:bolter-observation", version: BOLTER_RELAY_PROTOCOL_VERSION,
      scope: s.scope, connectionId: connection.id, generation: connection.generation, observation: projectedObservation(s, value) });
  };
  const disconnect = () => {
    const old = session; session = null;
    if (!old) return;
    for (const pending of old.authorizations.values()) pending.resolve(null);
    for (const pending of old.batches.values()) pending.resolve(false);
    retirement = Promise.allSettled([retirement, ...[...old.connections.values()].map(async entry => {
      const connection = await entry.pending; connection.active = false; await connection.driver.retire();
    })]).then(() => undefined);
  };
  async function connection(s: Session, id: string, generation: number, homeHandle?: string): Promise<Connection> {
    if (generation < (s.generations.get(id) ?? generation)) throw new Error("Bolter authority changed.");
    s.generations.set(id, generation);
    const previous = s.connections.get(id);
    if (previous && previous.generation >= generation) {
      if (previous.generation !== generation) throw new Error("Bolter authority changed.");
      const value = await previous.pending;
      if (!value.active || !current(s)) throw new Error("Bolter authority changed.");
      return value;
    }
    // A newer durable generation fences the previous receiver immediately, including an unacknowledged batch.
    for (const [batchId, batch] of s.batches) {
      if (batch.connectionId === id) { s.batches.delete(batchId); batch.resolve(false); }
    }
    for (const [correlationId, authorization] of s.authorizations) {
      if (authorization.connectionId === id) { s.authorizations.delete(correlationId); authorization.resolve(null); }
    }
    const entry = { generation, pending: null as unknown as Promise<Connection> };
    const live = () => current(s) && s.connections.get(id) === entry;
    const work = (async () => {
      await retirement;
      if (previous) {
        const old = await previous.pending.catch(() => null);
        if (old) { old.active = false; await old.driver.retire(); }
      }
      if (!live()) throw new Error("Bolter authority changed.");
      const value: Connection = { id, generation, active: true, driver: await factory({ connectionId: id, generation,
        ...(homeHandle === undefined ? {} : { homeHandle }), isCurrent: live }) };
      if (!live()) { value.active = false; await value.driver.retire(); throw new Error("Bolter authority changed."); }
      return value;
    })();
    entry.pending = work;
    s.connections.set(id, entry);
    void work.catch(() => { if (s.connections.get(id) === entry) s.connections.delete(id); });
    return work;
  }
  async function execute(s: Session, message: RelayBolterCommand): Promise<BolterNativeResult> {
    const command = message.command;
    if (!current(s)) return unavailable("authority_changed");
    if (command.action === "cancel_connect") {
      const pending = s.operations.get(command.operationId);
      if (!pending) return unavailable("not_found");
      const value = await pending; value.active = false;
      await value.driver.retire(); return unavailable("operation_cancelled");
    }
    const pending = connection(s, command.connectionId, command.action === "connect" ? 1 : command.generation,
      command.action === "connect" ? command.homeHandle : undefined);
    if (command.action === "connect") s.operations.set(command.operationId, pending);
    const value = await pending;
    if (!current(s) || !value.active) return unavailable("authority_changed");
    if (command.action === "connect") {
      return new Promise(resolveResult => {
        let settled = false;
        const finish = (result: BolterNativeResult) => { if (!settled) { settled = true; resolveResult(result); } };
        void value.driver.connect(auth => {
          if (current(s) && value.active) finish({ kind: "auth_pending", auth });
        }).then(result => {
          if (!current(s) || !value.active) { finish(unavailable("authority_changed")); return; }
          observation(s, value, result); finish({ kind: "observation", observation: result });
        }, () => finish(unavailable("runtime_unavailable")));
      });
    }
    if (command.action === "check") return { kind: "observation", observation: await value.driver.check() };
    if (command.action === "list_conversations") return value.driver.conversations();
    if (command.action === "pause" || command.action === "revoke") {
      const result = await value.driver.pause();
      if (command.action === "revoke") { value.active = false; await value.driver.retire(); }
      return { kind: "observation", observation: result };
    }
    if (command.action === "start_receiver") {
      const result = await value.driver.start(async (messages, batchId) => {
        if (!current(s) || !value.active || s.batches.has(batchId)) return false;
        let settle!: (accepted: boolean) => void;
        const accepted = new Promise<boolean>(resolve => { settle = resolve; });
        s.batches.set(batchId, { connectionId: value.id, generation: value.generation, resolve: settle });
        try {
          if (!s.transport.send({ type: "relay:bolter-batch", version: BOLTER_RELAY_PROTOCOL_VERSION, scope: s.scope,
            connectionId: value.id, generation: value.generation, batchId, messages: [...messages] })) return false;
          return await accepted && current(s) && value.active;
        } finally { s.batches.delete(batchId); }
      }, result => observation(s, value, result));
      return { kind: "observation", observation: result };
    }
    if (command.action !== "send") return unavailable("invalid_request");
    const prepared = await value.driver.prepareSend();
    if (!prepared) return unavailable("qualification_required");
    if (!current(s) || !value.active) return unavailable("authority_changed");
    const authorize = async () => {
      if (!current(s) || !value.active) return null;
      let resolveAuthorization!: (content: RelayBolterAuthorized["content"]) => void;
      const authorized = new Promise<RelayBolterAuthorized["content"]>(resolve => { resolveAuthorization = resolve; });
      s.authorizations.set(message.correlationId, { connectionId: value.id, outboxId: command.outboxId, resolve: resolveAuthorization });
      if (!s.transport.send({ type: "relay:bolter-authorize", version: BOLTER_RELAY_PROTOCOL_VERSION, scope: s.scope,
        correlationId: message.correlationId, outboxId: command.outboxId })) { s.authorizations.delete(message.correlationId); return null; }
      const content = await authorized;
      return current(s) && value.active ? content : null;
    };
    try {
      const content = await authorize();
      if (!content || !current(s) || !value.active) return unavailable("authority_changed");
      // Text spawns immediately. File preparation reauthorizes before every later dispatch.
      return await prepared(content, async () => {
        const fresh = await authorize();
        return !!fresh && fresh.chatId === content.chatId && fresh.threadRootId === content.threadRootId && fresh.content === content.content;
      });
    } catch { return { kind: "uncertain" }; }
    finally { s.authorizations.delete(message.correlationId); }
  }
  return {
    isReady() { try { return fence(); } catch { return false; } },
    onRegistered(scope, transport) {
      disconnect();
      session = { scope: Object.freeze({ ...scope }), transport, commands: new Map(), sends: new Map(),
        generations: new Map(), connections: new Map(), operations: new Map(), authorizations: new Map(), batches: new Map() };
    },
    async onCommand(raw) {
      const s = session;
      const parsed = parseRelayBolterServerMessage(JSON.parse(JSON.stringify(raw)) as unknown);
      if (!s || !current(s) || parsed?.type !== "relay:bolter-command" || !sameRelayBolterScope(s.scope, parsed.scope)) return;
      const fingerprint = JSON.stringify(parsed.command);
      let work = s.commands.get(parsed.correlationId);
      if (work && work.fingerprint !== fingerprint) return;
      if (!work) {
        let result: Promise<BolterNativeResult>;
        if (parsed.command.action === "send") {
          const key = parsed.command.outboxId;
          const previous = s.sends.get(key);
          result = previous ? previous.fingerprint === fingerprint ? previous.result : Promise.resolve({ kind: "uncertain" })
            : execute(s, parsed).catch(() => ({ kind: "uncertain" } as const));
          if (!previous) {
            const send = { fingerprint, result };
            s.sends.set(key, send);
            void result.then(value => {
              // Unavailable proves no dispatch. Ambiguous and delivered outcomes remain replay fences.
              if (value.kind === "unavailable" && s.sends.get(key) === send) s.sends.delete(key);
            });
          }
        } else result = execute(s, parsed).catch(() => unavailable("runtime_unavailable"));
        work = { fingerprint, result }; s.commands.set(parsed.correlationId, work);
      }
      const result = await work.result;
      if (current(s)) s.transport.send({ type: "relay:bolter-result", version: BOLTER_RELAY_PROTOCOL_VERSION,
        scope: s.scope, correlationId: parsed.correlationId,
        result: result.kind === "observation" ? { ...result, observation: projectedObservation(s, result.observation) } : result });
    },
    onAuthorized(message: RelayBolterAuthorized) {
      const s = session;
      if (!s || !current(s) || !sameRelayBolterScope(s.scope, message.scope)) return;
      const pending = s.authorizations.get(message.correlationId);
      if (!pending || pending.outboxId !== message.outboxId) return;
      s.authorizations.delete(message.correlationId); pending.resolve(message.content ? Object.freeze({ ...message.content,
        ...(message.content.files ? { files: Object.freeze(message.content.files.map(file => Object.freeze({ ...file }))) } : {}) }) : null);
    },
    onBatchAck(message: RelayBolterBatchAck) {
      const s = session;
      if (!s || !current(s) || !sameRelayBolterScope(s.scope, message.scope)) return;
      const pending = s.batches.get(message.batchId);
      if (!pending || pending.connectionId !== message.connectionId || pending.generation !== message.generation) return;
      s.batches.delete(message.batchId); pending.resolve(message.status === "accepted");
    },
    onDisconnected: disconnect,
    async retire() { disconnect(); await retirement; },
  };
}
