import {
  destroyProtectedInvocationRecipient,
  type EphemeralForegroundRecipient,
  type ForegroundRuntimeRecipient,
  type ProtectedInvocationRecipient,
} from "../../invocation/protected-grant-invocation.ts";
import type { AgentRuntimeKeyGeneration } from "@nautilo/lattice-crypto";

export const LIVE_SHADOW_RECIPIENTS_PER_CLIENT_SESSION = 60;
const LIVE_SHADOW_RECIPIENTS_TOTAL = 1_024;

export interface LiveShadowRecipientEntry {
  readonly operationId: string;
  readonly clientActionSessionId: string;
  readonly actorId: string;
  readonly deadlineAt: number;
  readonly publicKey: Uint8Array;
  readonly recipient: ProtectedInvocationRecipient;
}

export interface LiveShadowRuntimeRecipientEntry extends Omit<
  LiveShadowRecipientEntry,
  "recipient"
> {
  readonly recipient: ForegroundRuntimeRecipient;
}

type StoredLiveShadowRecipientEntry = Omit<
  LiveShadowRecipientEntry,
  "recipient"
> & Readonly<{
  recipient: EphemeralForegroundRecipient | null;
  agentRuntime: AgentRuntimeKeyGeneration | null;
  pendingRuntime?: true;
}>;

function destroy(entry: StoredLiveShadowRecipientEntry): void {
  entry.publicKey.fill(0);
  entry.agentRuntime?.key.fill(0);
  if (entry.recipient !== null) {
    destroyProtectedInvocationRecipient(entry.recipient);
  }
}

function copyEntry(
  entry: StoredLiveShadowRecipientEntry,
): LiveShadowRecipientEntry | null {
  if (entry.recipient === null || !("recipientAgentId" in entry.recipient)) {
    return null;
  }
  return Object.freeze({
    operationId: entry.operationId,
    clientActionSessionId: entry.clientActionSessionId,
    actorId: entry.actorId,
    deadlineAt: entry.deadlineAt,
    publicKey: entry.publicKey.slice(),
    recipient: entry.recipient,
  });
}

/**
 * Bounded, process-local custody for one live turn's HPKE recipient. The
 * private scalar is never serialised or persisted. Expiry, disconnect cleanup,
 * explicit removal, and shutdown all wipe the owned bytes.
 */
export class LiveShadowRecipientRegistry {
  readonly #entries = new Map<string, StoredLiveShadowRecipientEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Admit custody synchronously before asynchronous key generation or authority
   * lookup. This consumes the same existing recipient budget, not a new quota. */
  reserveRuntime(input: Readonly<{
    operationId: string; clientActionSessionId: string; actorId: string; deadlineAt: number;
  }>): boolean {
    this.prune();
    if (this.#entries.has(input.operationId)
      || this.#entries.size >= LIVE_SHADOW_RECIPIENTS_TOTAL
      || !Number.isSafeInteger(input.deadlineAt) || input.deadlineAt <= this.now()) return false;
    let count = 0;
    for (const entry of this.#entries.values()) {
      if (entry.clientActionSessionId === input.clientActionSessionId) count++;
    }
    if (count >= LIVE_SHADOW_RECIPIENTS_PER_CLIENT_SESSION) return false;
    this.#entries.set(input.operationId, Object.freeze({...input,
      publicKey: new Uint8Array(0), recipient: null, agentRuntime: null, pendingRuntime: true}));
    return true;
  }

  /** Complete only the exact still-live reservation; never recreate cancelled
   * or expired custody, overwrite a recipient, or consume a second slot. */
  completeReservedRuntime(input: Readonly<{
    operationId: string; clientActionSessionId: string; actorId: string; deadlineAt: number;
    publicKey: Uint8Array; recipient: ForegroundRuntimeRecipient;
  }>): boolean {
    this.prune();
    const entry = this.#entries.get(input.operationId);
    if (entry?.pendingRuntime !== true || entry.clientActionSessionId !== input.clientActionSessionId
      || entry.actorId !== input.actorId || entry.deadlineAt !== input.deadlineAt) return false;
    this.#entries.set(input.operationId, Object.freeze({...input,
      publicKey: input.publicKey.slice(), agentRuntime: null}));
    return true;
  }

  put(input: Readonly<{
    operationId: string;
    clientActionSessionId: string;
    actorId: string;
    deadlineAt: number;
    publicKey: Uint8Array;
    recipient: ProtectedInvocationRecipient;
    agentRuntime: AgentRuntimeKeyGeneration;
  }>): boolean {
    this.prune();
    if (
      this.#entries.has(input.operationId)
      || this.#entries.size >= LIVE_SHADOW_RECIPIENTS_TOTAL
      || !Number.isSafeInteger(input.deadlineAt)
      || input.deadlineAt <= this.now()
    ) return false;
    let count = 0;
    for (const entry of this.#entries.values()) {
      if (entry.clientActionSessionId === input.clientActionSessionId) count++;
    }
    if (count >= LIVE_SHADOW_RECIPIENTS_PER_CLIENT_SESSION) return false;
    this.#entries.set(input.operationId, Object.freeze({
      operationId: input.operationId,
      clientActionSessionId: input.clientActionSessionId,
      actorId: input.actorId,
      deadlineAt: input.deadlineAt,
      publicKey: input.publicKey.slice(),
      recipient: input.recipient,
      agentRuntime: Object.freeze({
        ...input.agentRuntime,
        key: input.agentRuntime.key.slice(),
      }),
    }));
    return true;
  }

  putRuntime(input: Readonly<{
    operationId: string;
    clientActionSessionId: string;
    actorId: string;
    deadlineAt: number;
    publicKey: Uint8Array;
    recipient: ForegroundRuntimeRecipient;
    agentRuntime?: AgentRuntimeKeyGeneration;
  }>): boolean {
    this.prune();
    if (
      this.#entries.has(input.operationId)
      || this.#entries.size >= LIVE_SHADOW_RECIPIENTS_TOTAL
      || !Number.isSafeInteger(input.deadlineAt)
      || input.deadlineAt <= this.now()
    ) return false;
    let count = 0;
    for (const entry of this.#entries.values()) {
      if (entry.clientActionSessionId === input.clientActionSessionId) count++;
    }
    if (count >= LIVE_SHADOW_RECIPIENTS_PER_CLIENT_SESSION) return false;
    this.#entries.set(input.operationId, Object.freeze({
      operationId: input.operationId,
      clientActionSessionId: input.clientActionSessionId,
      actorId: input.actorId,
      deadlineAt: input.deadlineAt,
      publicKey: input.publicKey.slice(),
      recipient: input.recipient,
      agentRuntime: input.agentRuntime === undefined
        ? null
        : Object.freeze({
          ...input.agentRuntime,
          key: input.agentRuntime.key.slice(),
        }),
    }));
    return true;
  }

  /**
   * Retain only the fresh per-turn Agent Runtime when the HPKE recipient is
   * already owned by a reusable foreground authorization session.
   */
  putAgentRuntime(input: Readonly<{
    operationId: string;
    clientActionSessionId: string;
    actorId: string;
    deadlineAt: number;
    agentRuntime: AgentRuntimeKeyGeneration;
  }>): boolean {
    this.prune();
    if (
      this.#entries.has(input.operationId)
      || this.#entries.size >= LIVE_SHADOW_RECIPIENTS_TOTAL
      || !Number.isSafeInteger(input.deadlineAt)
      || input.deadlineAt <= this.now()
    ) return false;
    let count = 0;
    for (const entry of this.#entries.values()) {
      if (entry.clientActionSessionId === input.clientActionSessionId) count++;
    }
    if (count >= LIVE_SHADOW_RECIPIENTS_PER_CLIENT_SESSION) return false;
    this.#entries.set(input.operationId, Object.freeze({
      operationId: input.operationId,
      clientActionSessionId: input.clientActionSessionId,
      actorId: input.actorId,
      deadlineAt: input.deadlineAt,
      publicKey: new Uint8Array(0),
      recipient: null,
      agentRuntime: Object.freeze({
        ...input.agentRuntime,
        key: input.agentRuntime.key.slice(),
      }),
    }));
    return true;
  }

  get(input: Readonly<{
    operationId: string;
    clientActionSessionId: string;
    actorId: string;
  }>): LiveShadowRecipientEntry | null {
    this.prune();
    const entry = this.#entries.get(input.operationId);
    if (
      entry === undefined
      || entry.clientActionSessionId !== input.clientActionSessionId
      || entry.actorId !== input.actorId
    ) return null;
    return copyEntry(entry);
  }

  hasOperation(input: Readonly<{
    operationId: string;
    clientActionSessionId: string;
    actorId: string;
  }>): boolean {
    this.prune();
    const entry = this.#entries.get(input.operationId);
    return entry !== undefined
      && entry.clientActionSessionId === input.clientActionSessionId
      && entry.actorId === input.actorId;
  }

  peekRuntimePublicKey(input: Readonly<{
    operationId: string;
    clientActionSessionId: string;
    actorId: string;
  }>): Uint8Array | null {
    this.prune();
    const entry = this.#entries.get(input.operationId);
    if (
      entry === undefined
      || entry.clientActionSessionId !== input.clientActionSessionId
      || entry.actorId !== input.actorId
      || entry.recipient === null
      || !("recipientKind" in entry.recipient)
    ) return null;
    return entry.publicKey.slice();
  }

  /**
   * Transfer the exact opaque recipient into an admitted execution. The
   * registry removes its ownership without destroying the capability; every
   * failed lookup remains non-consuming.
   */
  take(input: Readonly<{
    operationId: string;
    clientActionSessionId: string;
    actorId: string;
  }>): LiveShadowRecipientEntry | null {
    this.prune();
    const entry = this.#entries.get(input.operationId);
    if (
      entry === undefined
      || entry.clientActionSessionId !== input.clientActionSessionId
      || entry.actorId !== input.actorId
    ) return null;
    const transferred = copyEntry(entry);
    if (transferred === null) return null;
    this.#entries.set(input.operationId, Object.freeze({
      ...entry,
      recipient: null,
    }));
    entry.publicKey.fill(0);
    return transferred;
  }

  takeRuntime(input: Readonly<{
    operationId: string;
    clientActionSessionId: string;
    actorId: string;
  }>): LiveShadowRuntimeRecipientEntry | null {
    this.prune();
    const entry = this.#entries.get(input.operationId);
    if (
      entry === undefined
      || entry.clientActionSessionId !== input.clientActionSessionId
      || entry.actorId !== input.actorId
      || entry.recipient === null
      || !("recipientKind" in entry.recipient)
    ) return null;
    const transferred = Object.freeze({
      operationId: entry.operationId,
      clientActionSessionId: entry.clientActionSessionId,
      actorId: entry.actorId,
      deadlineAt: entry.deadlineAt,
      publicKey: entry.publicKey.slice(),
      recipient: entry.recipient,
    });
    this.#entries.set(input.operationId, Object.freeze({
      ...entry,
      recipient: null,
    }));
    entry.publicKey.fill(0);
    return transferred;
  }

  /** Transfer the exact turn-scoped Runtime only after Human admission. */
  takeAgentRuntime(operationId: string): AgentRuntimeKeyGeneration | null {
    this.prune();
    const entry = this.#entries.get(operationId);
    if (entry === undefined || entry.recipient !== null) return null;
    this.#entries.delete(operationId);
    if (entry.agentRuntime === null) {
      entry.publicKey.fill(0);
      return null;
    }
    const runtime = Object.freeze({
      ...entry.agentRuntime,
      key: entry.agentRuntime.key.slice(),
    });
    entry.publicKey.fill(0);
    entry.agentRuntime.key.fill(0);
    return runtime;
  }

  delete(operationId: string): void {
    const entry = this.#entries.get(operationId);
    if (entry !== undefined) destroy(entry);
    this.#entries.delete(operationId);
  }

  deleteClientSession(clientActionSessionId: string): void {
    for (const [operationId, entry] of this.#entries) {
      if (entry.clientActionSessionId === clientActionSessionId) {
        this.delete(operationId);
      }
    }
  }

  prune(): void {
    const now = this.now();
    for (const [operationId, entry] of this.#entries) {
      if (entry.deadlineAt <= now) this.delete(operationId);
    }
  }

  size(): number {
    this.prune();
    return this.#entries.size;
  }

  shutdown(): readonly string[] {
    const operationIds = [...this.#entries.keys()];
    for (const operationId of operationIds) this.delete(operationId);
    return Object.freeze(operationIds);
  }
}
