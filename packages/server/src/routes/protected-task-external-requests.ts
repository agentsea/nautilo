import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import { LIVE_SHADOW_FOREGROUND_AUTHORIZATION_TTL_MS, type LiveShadowRecipientRegistry } from "@nautilo/lattice-bridge/server";
import { assertAcceptedInvocationAuthoritySubject, type AcceptedInvocationAuthority } from "@nautilo/trust";
import type { HarnessRequestResponse } from "@nautilo/runtime";
import { codexRequestEventSchema, type CodexRequestEvent } from "@nautilo/types";
import {
  createDomainForegroundReadAuthority, wipeDomainForegroundReadSnapshot,
  type DomainForegroundReadBinding, type DomainForegroundReadSnapshot,
} from "./foreground-domain-read-authority";

export type ProtectedTaskExternalRequestIdentity = Readonly<{
  taskId: string; taskRunId: string; jobId: string; sourceRoomId: string; namespaceId: string;
  requestorId: string; humanActorId: string; agentId: string; roomId: string; requestId: string;
}>;
export type ProtectedTaskExternalRequestChange = Readonly<{
  requestId: string; taskId: string; taskRunId: string; jobId: string; roomId: string;
  ownerId: string; state: "available" | "unavailable";
}>;
export type ProtectedTaskExternalRequestRegistration = Readonly<{
  identity: ProtectedTaskExternalRequestIdentity;
  deadlineAt: number;
  signal: AbortSignal;
  assertCurrentExecutionAuthority(): Promise<void>;
  read(): Promise<CodexRequestEvent | null>;
  respond(response: HarnessRequestResponse, authority: AcceptedInvocationAuthority, options?: Readonly<{ signal?: AbortSignal }>): Promise<void>;
}>;
/** Random, one-use reference. Only this registry can create an actionable value. */
export type ProtectedTaskExternalResponseCapability = string & { readonly __protectedTaskExternalResponseCapability: unique symbol };

type Locator = Readonly<{ requestId: string; topLevelRoomId: string; namespaceId: string }>;
type Reader = ReturnType<typeof createDomainForegroundReadAuthority<Locator, DomainForegroundReadSnapshot>>;
type Entry = {
  identity: ProtectedTaskExternalRequestIdentity; deadlineAt: number; signal: AbortSignal;
  event: CodexRequestEvent | null; reader: Reader; closed: boolean; responding: boolean;
  assertCurrent(): Promise<void>; read(): Promise<CodexRequestEvent | null>;
  respond(response: HarnessRequestResponse, authority: AcceptedInvocationAuthority, options?: Readonly<{ signal?: AbortSignal }>): Promise<void>;
  detach(): void; timer: ReturnType<typeof setTimeout> | undefined;
};
type Capability = Readonly<{
  entry: Entry; binding: DomainForegroundReadBinding; snapshot: DomainForegroundReadSnapshot; deadlineAt: number;
}>;
const unavailable = Object.freeze({ status: "unavailable" as const });

/** No event payload, answer, key or capability is persisted or broadcast by this owner. */
export function createProtectedTaskExternalRequests(input: Readonly<{
  crypto: LatticeCrypto; recipients: LiveShadowRecipientRegistry;
  inspectCurrent(binding: DomainForegroundReadBinding, identity: ProtectedTaskExternalRequestIdentity): Promise<DomainForegroundReadSnapshot | null>;
  onChanged(change: ProtectedTaskExternalRequestChange): void;
  now?: () => number;
}>) {
  const now = input.now ?? Date.now;
  const entries = new Map<string, Entry>();
  const challenges = new Map<string, Readonly<{ entry: Entry; binding: DomainForegroundReadBinding; deadlineAt: number }>>();
  const capabilities = new Map<string, Capability>();
  const activeActions = new Set<{ binding: DomainForegroundReadBinding; entry: Entry; deadlineAt: number; cancelled: boolean; cancel?(): void }>();
  let closed = false;
  const changed = (entry: Entry, state: ProtectedTaskExternalRequestChange["state"]) => {
    const i = entry.identity;
    try { input.onChanged(Object.freeze({ requestId: i.requestId, taskId: i.taskId, taskRunId: i.taskRunId,
      jobId: i.jobId, roomId: i.roomId, ownerId: i.requestorId, state })); } catch { /* Notifications confer no authority. */ }
  };
  const discardCapability = (key: string, value: Capability) => {
    capabilities.delete(key);
    wipeDomainForegroundReadSnapshot(value.snapshot);
  };
  const replaceChallengeForBinding = (
    entry: Entry,
    binding: DomainForegroundReadBinding,
  ) => {
    for (const [id, value] of challenges) {
      if (value.entry === entry && isDeepStrictEqual(value.binding, binding)) {
        challenges.delete(id);
        value.entry.reader.cancelChallenge(id);
      }
    }
  };
  const replaceCapabilityForBinding = (
    entry: Entry,
    binding: DomainForegroundReadBinding,
  ) => {
    for (const [id, value] of capabilities) {
      if (value.entry === entry && isDeepStrictEqual(value.binding, binding)) {
        discardCapability(id, value);
      }
    }
  };
  const closeEntry = (entry: Entry) => {
    if (entry.closed) return;
    entry.closed = true;
    if (entries.get(entry.identity.requestId) === entry) entries.delete(entry.identity.requestId);
    entry.reader.close();
    entry.detach();
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.event = null;
    for (const action of activeActions) if (action.entry === entry) {
      action.cancelled = true; action.cancel?.();
    }
    for (const [id, challenge] of challenges) if (challenge.entry === entry) challenges.delete(id);
    for (const [id, cap] of capabilities) if (cap.entry === entry) discardCapability(id, cap);
    changed(entry, "unavailable");
  };
  const alive = (entry: Entry) => !closed && !entry.closed && !entry.signal.aborted
    && now() < entry.deadlineAt && entries.get(entry.identity.requestId) === entry;
  const prune = () => {
    for (const action of activeActions) if (action.deadlineAt <= now()) {
      action.cancelled = true; action.cancel?.();
    }
    for (const entry of entries.values()) if (!alive(entry)) closeEntry(entry);
    for (const [id, challenge] of challenges) if (challenge.deadlineAt <= now()) {
      challenges.delete(id); challenge.entry.reader.cancelChallenge(id);
    }
    for (const [id, cap] of capabilities) if (!alive(cap.entry) || cap.deadlineAt <= now()) discardCapability(id, cap);
  };
  const armExpiry = (entry: Entry) => {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    if (!alive(entry)) { closeEntry(entry); return; }
    let deadline = entry.deadlineAt;
    for (const value of challenges.values()) if (value.entry === entry) deadline = Math.min(deadline, value.deadlineAt);
    for (const value of capabilities.values()) if (value.entry === entry) deadline = Math.min(deadline, value.deadlineAt);
    for (const action of activeActions) if (action.entry === entry && !action.cancelled) deadline = Math.min(deadline, action.deadlineAt);
    entry.timer = setTimeout(() => { prune(); armExpiry(entry); },
      Math.min(deadline - now(), LIVE_SHADOW_FOREGROUND_AUTHORIZATION_TTL_MS));
    entry.timer.unref();
  };
  const exactEvent = (event: CodexRequestEvent, identity: ProtectedTaskExternalRequestIdentity) =>
    event.requestId === identity.requestId && event.ownerId === identity.requestorId
    && event.taskId === identity.taskId && event.jobId === identity.jobId && event.roomId === identity.roomId;
  const currentEvent = async (entry: Entry): Promise<CodexRequestEvent | null> => {
    if (!alive(entry)) { closeEntry(entry); return null; }
    try {
      await entry.assertCurrent();
      const parsed = codexRequestEventSchema.safeParse(await entry.read());
      if (!alive(entry) || !parsed.success || !exactEvent(parsed.data, entry.identity)
        || !isDeepStrictEqual(parsed.data, entry.event)) { closeEntry(entry); return null; }
      return parsed.data;
    } catch { closeEntry(entry); return null; }
  };
  const inspect = async (entry: Entry, binding: DomainForegroundReadBinding) => {
    if (binding.userId !== entry.identity.requestorId || binding.humanActorId !== entry.identity.humanActorId
      || await currentEvent(entry) === null) return null;
    const snapshot = await input.inspectCurrent(binding, entry.identity);
    if (snapshot === null) return null;
    if (await currentEvent(entry) === null || snapshot.committerDeviceId !== binding.clientDeviceId
      || snapshot.namespaceAuthority.namespaceId !== entry.identity.namespaceId) {
      wipeDomainForegroundReadSnapshot(snapshot); return null;
    }
    return snapshot;
  };
  const cancelBindings = (matches: (binding: DomainForegroundReadBinding) => boolean) => {
    for (const action of activeActions) if (matches(action.binding)) {
      action.cancelled = true; action.cancel?.();
    }
    for (const [id, value] of challenges) if (matches(value.binding)) {
      challenges.delete(id); value.entry.reader.cancelChallenge(id);
    }
    for (const [id, value] of capabilities) if (matches(value.binding)) discardCapability(id, value);
  };
  return Object.freeze({
    async register(registration: ProtectedTaskExternalRequestRegistration) {
      prune();
      const identity = Object.freeze({ ...registration.identity });
      const { signal, assertCurrentExecutionAuthority, read, respond } = registration;
      if (closed || signal.aborted || entries.has(identity.requestId)
        || Object.values(identity).some(value => typeof value !== "string" || value.length === 0)
        || !Number.isSafeInteger(registration.deadlineAt) || registration.deadlineAt <= now()) return null;
      await assertCurrentExecutionAuthority();
      const parsed = codexRequestEventSchema.safeParse(await read());
      if (!parsed.success || !exactEvent(parsed.data, identity)) return null;
      const deadlineAt = Math.min(registration.deadlineAt,
        parsed.data.expiresAt === null ? registration.deadlineAt : Date.parse(parsed.data.expiresAt));
      if (closed || signal.aborted || deadlineAt <= now() || entries.has(identity.requestId)) return null;
      const reader = createDomainForegroundReadAuthority<Locator, DomainForegroundReadSnapshot>({
        crypto: input.crypto, recipients: input.recipients, now,
        resolveCurrent: (binding, locator) => locator.requestId === identity.requestId
          && locator.namespaceId === identity.namespaceId && locator.topLevelRoomId === identity.sourceRoomId
          ? inspect(entry, binding) : Promise.resolve(null),
        withAuthority: async (context, use) => {
          // Reading a live buffer requires fresh decrypt authority, but no content keys escape.
          context.domains.forEach(domain => domain.domainKey.fill(0));
          await context.assertCurrentAuthority();
          return use(context.snapshot);
        },
      });
      const onAbort = () => closeEntry(entry);
      const entry: Entry = { identity, deadlineAt, signal, event: structuredClone(parsed.data), reader, closed: false, responding: false,
        assertCurrent: assertCurrentExecutionAuthority, read, respond,
        detach: () => signal.removeEventListener("abort", onAbort), timer: undefined };
      entries.set(identity.requestId, entry);
      signal.addEventListener("abort", onAbort, { once: true });
      armExpiry(entry);
      if (await currentEvent(entry) === null) return null;
      changed(entry, "available");
      return Object.freeze({ close: () => closeEntry(entry) });
    },
    async list(suppliedBinding: DomainForegroundReadBinding): Promise<readonly ProtectedTaskExternalRequestChange[]> {
      prune();
      const binding = Object.freeze({ ...suppliedBinding });
      const found: ProtectedTaskExternalRequestChange[] = [];
      for (const entry of entries.values()) {
        const snapshot = await inspect(entry, binding);
        if (snapshot === null) continue;
        wipeDomainForegroundReadSnapshot(snapshot);
        const i = entry.identity;
        found.push({ requestId: i.requestId, taskId: i.taskId, taskRunId: i.taskRunId,
          jobId: i.jobId, roomId: i.roomId, ownerId: i.requestorId, state: "available" });
      }
      return Object.freeze(found);
    },
    async plan(request: Readonly<{ binding: DomainForegroundReadBinding; requestId: string }>) {
      prune();
      const binding = Object.freeze({ ...request.binding });
      const entry = entries.get(request.requestId);
      if (entry === undefined || entry.responding || await currentEvent(entry) === null) return unavailable;
      const result = await entry.reader.plan({ binding,
        locator: { requestId: entry.identity.requestId, topLevelRoomId: entry.identity.sourceRoomId, namespaceId: entry.identity.namespaceId },
        deadlineAt: Math.min(entry.deadlineAt, now() + LIVE_SHADOW_FOREGROUND_AUTHORIZATION_TTL_MS) });
      if (result.status !== "authorization_required") return result;
      if (!alive(entry)) {
        entry.reader.cancelChallenge(result.challengeId);
        result.authorizationPlanBytes.fill(0); result.recipientPublicKey.fill(0); return unavailable;
      }
      replaceChallengeForBinding(entry, binding);
      challenges.set(result.challengeId, { entry, binding, deadlineAt: result.deadlineAt });
      armExpiry(entry);
      return Object.freeze({ ...result, requestDeadlineAt: entry.deadlineAt });
    },
    async read(request: Readonly<{ binding: DomainForegroundReadBinding; challengeId: string; authorizationBytes: Uint8Array }>) {
      prune();
      const challenge = challenges.get(request.challengeId);
      if (challenge === undefined || !isDeepStrictEqual(challenge.binding, request.binding)) return unavailable;
      challenges.delete(request.challengeId);
      const action = { binding: challenge.binding, entry: challenge.entry, deadlineAt: challenge.deadlineAt, cancelled: false,
        cancel: () => challenge.entry.reader.cancelChallenge(request.challengeId) };
      activeActions.add(action);
      let retained: DomainForegroundReadSnapshot | undefined;
      try {
        const result = await challenge.entry.reader.read({ ...request, execute: async snapshot => {
          const event = await currentEvent(challenge.entry);
          if (event === null) return null;
          retained = structuredClone(snapshot);
          return structuredClone(event);
        } });
        if (result.status !== "read" || result.value === null || retained === undefined || action.cancelled || challenge.entry.responding || !alive(challenge.entry)) return unavailable;
        const responseCapability = randomUUID() as ProtectedTaskExternalResponseCapability;
        replaceCapabilityForBinding(challenge.entry, challenge.binding);
        capabilities.set(responseCapability, { entry: challenge.entry, binding: challenge.binding,
          snapshot: retained, deadlineAt: challenge.deadlineAt });
        retained = undefined;
        armExpiry(challenge.entry);
        return Object.freeze({ status: "read" as const, event: { ...result.value,
          expiresAt: new Date(challenge.entry.deadlineAt).toISOString() }, responseCapability });
      } finally { activeActions.delete(action); if (retained !== undefined) wipeDomainForegroundReadSnapshot(retained); }
    },
    async respond(request: Readonly<{ binding: DomainForegroundReadBinding;
      responseCapability: string; response: HarnessRequestResponse;
      invocationAuthority: AcceptedInvocationAuthority }>) {
      prune();
      const capability = capabilities.get(request.responseCapability);
      if (capability === undefined) return unavailable;
      // Consume before the first await, including malformed or failed attempts.
      capabilities.delete(request.responseCapability);
      const { entry } = capability;
      if (entry.responding) { wipeDomainForegroundReadSnapshot(capability.snapshot); return unavailable; }
      entry.responding = true;
      // Several devices may read one request, but only one response attempt may run.
      for (const [id, other] of capabilities) if (other.entry === entry) discardCapability(id, other);
      const responseController = new AbortController();
      const action = { binding: capability.binding, entry, deadlineAt: capability.deadlineAt, cancelled: false,
        cancel: () => responseController.abort(new Error("Protected response authority ended")) };
      const binding = Object.freeze({ ...request.binding });
      let sendBegan = false;
      activeActions.add(action);
      try {
        assertAcceptedInvocationAuthoritySubject(request.invocationAuthority, entry.identity.requestorId);
        const response = structuredClone(request.response);
        if (!isDeepStrictEqual(capability.binding, binding) || !alive(entry)
          || capability.deadlineAt <= now() || response.ownerId !== entry.identity.requestorId
          || response.requestId !== entry.identity.requestId || response.kind !== entry.event?.request.kind) return unavailable;
        const current = await inspect(entry, binding);
        try { if (current === null || !isDeepStrictEqual(current, capability.snapshot)) return unavailable; }
        finally { if (current !== null) wipeDomainForegroundReadSnapshot(current); }
        if (action.cancelled || !alive(entry)) return unavailable;
        sendBegan = true;
        await entry.respond(response, request.invocationAuthority, { signal: responseController.signal });
        // A send may already have happened. Never re-arm on failure or a changed postcondition.
        await entry.assertCurrent();
        const after = await input.inspectCurrent(binding, entry.identity);
        try {
          if (after === null || !isDeepStrictEqual(after, capability.snapshot)) return unavailable;
          await entry.assertCurrent();
          return !action.cancelled && alive(entry) ? Object.freeze({ status: "responded" as const }) : unavailable;
        } finally { if (after !== null) wipeDomainForegroundReadSnapshot(after); }
      } catch (error) {
        if (action.cancelled || responseController.signal.aborted) return unavailable;
        throw error;
      } finally {
        activeActions.delete(action); wipeDomainForegroundReadSnapshot(capability.snapshot);
        if (sendBegan) closeEntry(entry); else entry.responding = false;
      }
    },
    cancelForDevice(binding: Readonly<{ subjectHumanId: string; issuingDeviceId: string }>) {
      for (const entry of entries.values()) entry.reader.cancelForDevice(binding);
      cancelBindings(value => value.humanActorId === binding.subjectHumanId && value.clientDeviceId === binding.issuingDeviceId);
    },
    cancelForClientSession(sessionId: string) {
      for (const entry of entries.values()) entry.reader.cancelForClientSession(sessionId);
      cancelBindings(value => value.clientActionSessionId === sessionId);
    },
    cancelForHuman(humanActorId: string) {
      for (const entry of entries.values()) if (entry.identity.humanActorId === humanActorId) closeEntry(entry);
    },
    close() { closed = true; for (const entry of entries.values()) closeEntry(entry); },
  });
}
