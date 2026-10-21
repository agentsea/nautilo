import { afterEach, expect, test } from "bun:test";
import { authorizationRevision, LatticeCrypto, mintDomainForegroundAuthorization } from "@nautilo/lattice-crypto";
import { destroyDomainForegroundAuthorizationPlanV2, destroyDomainForegroundAuthorizationV2,
  parseDomainForegroundAuthorizationPlanV2, serializeDomainForegroundAuthorizationV2 } from "@nautilo/lattice-crypto/wire";
import { LIVE_SHADOW_FOREGROUND_AUTHORIZATION_TTL_MS, LiveShadowRecipientRegistry } from "@nautilo/lattice-bridge/server";
import { createAcceptedInvocationAuthority } from "@nautilo/trust";
import type { HarnessRequestResponse } from "@nautilo/runtime";
import type { CodexRequestEvent } from "@nautilo/types";
import { createProtectedTaskExternalRequests, type ProtectedTaskExternalRequestChange } from "../../src/routes/protected-task-external-requests";
import type { DomainForegroundReadSnapshot } from "../../src/routes/foreground-domain-read-authority";

const bytes = (value: number) => new Uint8Array(32).fill(value);
const binding = { userId: "user", humanActorId: "human", clientDeviceId: "device", clientActionSessionId: "client-session" };
const identity = { taskId: "task", taskRunId: "run", jobId: "job", sourceRoomId: "private-room", namespaceId: "namespace",
  requestorId: "user", humanActorId: "human", agentId: "agent", roomId: "display-room", requestId: "request" };
const event: CodexRequestEvent = { type: "codex.request", ownerId: "user", requestId: "request", taskId: "task", jobId: "job",
  roomId: "display-room", expiresAt: null, request: { kind: "permission_selection_required",
    options: [{ id: "allow_once", label: "Allow once", semanticHint: null }, { id: "deny", label: "Deny", semanticHint: null }],
    tool: { title: "Edit private file", kind: null } } };
const response: HarnessRequestResponse = { kind: "permission_selection_required", requestId: "request", ownerId: "user",
  outcome: { kind: "selected", optionId: "allow_once" } };
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
function fixture(requestLifetimeMs = 60_000) {
  let clock = Date.now();
  const crypto = new LatticeCrypto();
  const signer = crypto.generateSigningKeyPair();
  const snapshot: DomainForegroundReadSnapshot = { policyRevision: 8, committerDeviceId: "device",
    committerDeviceSigningKeyGeneration: 2, committerDeviceSigningPublicKey: signer.publicKey,
    hostAuthorizationRevision: 3,
    namespaceAuthority: { namespaceId: "namespace", namespaceAccessRevision: 4, namespaceKeyGeneration: 5,
      namespaceHeadDigest: bytes(1), namespacePublicationDigest: bytes(2), namespacePublicationSetDigest: bytes(3),
      namespaceAudienceFingerprint: bytes(4), domainId: "domain", domainKeyGeneration: 6, domainAuthorizationRevision: 7,
      domainHeadDigest: bytes(5), bundleRevision: 9, bundleDigest: bytes(6) },
    domains: [{ domainId: "domain", sourceNamespaceId: "namespace", participantDigest: bytes(7), participantCount: 1,
      keyClass: "ai", domainKeyGeneration: 6, authorizationRevision: authorizationRevision(7), headDigest: bytes(5),
      activeNamespaceBindingSetDigest: bytes(8), activeNamespaceBindingCount: 1 }] };
  const controller = new AbortController();
  const recipients = new LiveShadowRecipientRegistry(() => clock);
  const changes: ProtectedTaskExternalRequestChange[] = [];
  const snapshots: DomainForegroundReadSnapshot[] = [];
  let currentEvent: CodexRequestEvent | null = structuredClone(event);
  let currentClaim = true;
  let currentReader = true;
  let revision = 8;
  let namespaceRevision = 4;
  let sends = 0;
  let send: (signal?: AbortSignal) => Promise<void> = async () => {};
  let inspectHook: () => Promise<void> = async () => {};
  const acceptedBindings = new Set([JSON.stringify(binding)]);
  const service = createProtectedTaskExternalRequests({ crypto, recipients, now: () => clock,
    onChanged: change => changes.push(change),
    inspectCurrent: async actual => {
      await inspectHook();
      if (!currentReader || !acceptedBindings.has(JSON.stringify(actual))) return null;
      const owned = structuredClone({ ...snapshot, policyRevision: revision,
        committerDeviceId: actual.clientDeviceId,
        namespaceAuthority: { ...snapshot.namespaceAuthority, namespaceAccessRevision: namespaceRevision } });
      snapshots.push(owned); return owned;
    } });
  cleanup.push(() => { service.close(); signer.privateKey.fill(0); signer.publicKey.fill(0); });
  const registration = { identity: { ...identity }, deadlineAt: clock + requestLifetimeMs, signal: controller.signal,
    assertCurrentExecutionAuthority: async () => { if (!currentClaim) throw new Error("claim changed"); },
    read: async () => currentEvent,
    respond: async (actual: HarnessRequestResponse, _authority: unknown, options?: Readonly<{ signal?: AbortSignal }>) => {
      expect(actual).toEqual(response); sends++; await send(options?.signal);
    } };
  const register = () => service.register(registration);
  const plan = async (actualBinding = binding) => {
    const result = await service.plan({ binding: actualBinding, requestId: identity.requestId });
    if (result.status !== "authorization_required") throw new Error("missing challenge");
    return result;
  };
  const sign = async (challenge: Awaited<ReturnType<typeof plan>>) => {
    const plan = parseDomainForegroundAuthorizationPlanV2(challenge.authorizationPlanBytes);
    if (plan === null) throw new Error("bad plan");
    try {
      expect(plan.operations).toEqual(["decrypt"]);
      expect(plan.roomId).toBe(identity.sourceRoomId);
      const authorization = await mintDomainForegroundAuthorization(crypto, { plan,
        domains: snapshot.domains.map(domain => ({ ...domain, domainKey: bytes(20) })),
        committerDeviceSigningPrivateKey: signer.privateKey, recipientEncryptionPublicKey: challenge.recipientPublicKey });
      try { return serializeDomainForegroundAuthorizationV2(authorization); }
      finally { destroyDomainForegroundAuthorizationV2(authorization); }
    } finally { destroyDomainForegroundAuthorizationPlanV2(plan); }
  };
  const read = async (actualBinding = binding) => {
    const challenge = await plan(actualBinding);
    const auth = await sign(challenge);
    try {
      const result = await service.read({ binding: actualBinding, challengeId: challenge.challengeId, authorizationBytes: auth });
      if (result.status !== "read") throw new Error("read denied");
      return result;
    } finally { auth.fill(0); }
  };
  return { service, registration, register, plan, read, sign, recipients, changes, snapshots, controller,
    sends: () => sends, event: () => currentEvent,
    hide: () => { currentEvent = null; }, revokeClaim: () => { currentClaim = false; },
    revokeReader: () => { currentReader = false; }, policyDrift: () => { revision++; },
    namespaceDrift: () => { namespaceRevision++; }, expire: () => { clock += requestLifetimeMs; },
    allowBinding: (value: typeof binding) => { acceptedBindings.add(JSON.stringify(value)); },
    now: () => clock, advance: (milliseconds: number) => { clock += milliseconds; },
    setSend: (value: typeof send) => { send = value; }, setInspect: (value: typeof inspectHook) => { inspectHook = value; } };
}
async function expectFailure(pending: Promise<unknown>) {
  let rejected = false;
  try { await pending; } catch { rejected = true; }
  expect(rejected).toBe(true);
}
const invocation = () => createAcceptedInvocationAuthority(binding.userId, { originTaskId: identity.taskId });

test("genuine signed read discloses only after custody, responds once, and wipes owned snapshots", async () => {
  const f = fixture();
  expect(await f.register()).not.toBeNull();
  expect(f.changes).toEqual([{ requestId: "request", taskId: "task", taskRunId: "run",
    jobId: "job", roomId: "display-room", ownerId: "user", state: "available" }]);
  const value = await f.read();
  expect(value.event.request).toEqual(event.request);
  expect(value.event.expiresAt).not.toBeNull();
  expect(await f.service.respond({ binding, responseCapability: value.responseCapability, response, invocationAuthority: invocation() }))
    .toEqual({ status: "responded" });
  expect(await f.service.respond({ binding, responseCapability: value.responseCapability, response, invocationAuthority: invocation() }))
    .toEqual({ status: "unavailable" });
  expect(f.sends()).toBe(1);
  expect(f.changes.at(-1)?.state).toBe("unavailable");
  expect(f.snapshots.every(value => value.committerDeviceSigningPublicKey.every(byte => byte === 0))).toBe(true);
});

test("one-use authorization stays short while the displayed request retains its provider deadline", async () => {
  const requestLifetimeMs = 20 * 60_000;
  const f = fixture(requestLifetimeMs);
  expect(await f.register()).not.toBeNull();
  const challenge = await f.plan();
  expect(challenge.deadlineAt).toBe(f.now() + LIVE_SHADOW_FOREGROUND_AUTHORIZATION_TTL_MS);
  expect(challenge.requestDeadlineAt).toBe(f.now() + requestLifetimeMs);
  const authorization = await f.sign(challenge);
  try {
    const value = await f.service.read({ binding, challengeId: challenge.challengeId,
      authorizationBytes: authorization });
    expect(value.status).toBe("read");
    if (value.status !== "read") throw new Error("read denied");
    expect(value.event.expiresAt).toBe(new Date(f.now() + requestLifetimeMs).toISOString());
    f.advance(LIVE_SHADOW_FOREGROUND_AUTHORIZATION_TTL_MS);
    expect(await f.service.respond({ binding, responseCapability: value.responseCapability,
      response, invocationAuthority: invocation() })).toEqual({ status: "unavailable" });
    const refreshed = await f.plan();
    expect(refreshed.requestDeadlineAt).toBe(f.now() + requestLifetimeMs
      - LIVE_SHADOW_FOREGROUND_AUTHORIZATION_TTL_MS);
  } finally { authorization.fill(0); }
});

test("registration copies identity and event, and rejects substituted event coordinates", async () => {
  const f = fixture();
  await f.register();
  f.registration.identity.taskId = "forged";
  expect((await f.read()).event.taskId).toBe("task");
  f.event()!.jobId = "other";
  expect(await f.service.plan({ binding, requestId: "request" })).toEqual({ status: "unavailable" });
  const other = fixture(); other.registration.identity.taskId = "other";
  expect(await other.register()).toBeNull();
  expect(other.changes).toEqual([]);
});

test("mismatched owner, Human, device and client session cannot read a live request", async () => {
  const f = fixture(); await f.register();
  for (const actual of [{ ...binding, userId: "other" }, { ...binding, humanActorId: "other" },
    { ...binding, clientDeviceId: "other" }, { ...binding, clientActionSessionId: "other" }]) {
    expect(await f.service.plan({ binding: actual, requestId: "request" })).toEqual({ status: "unavailable" });
    expect(await f.service.list(actual)).toEqual([]);
  }
  const challenge = await f.plan();
  expect(await f.service.read({ binding: { ...binding, clientDeviceId: "other" }, challengeId: challenge.challengeId,
    authorizationBytes: await f.sign(challenge) })).toEqual({ status: "unavailable" });
  expect(f.sends()).toBe(0);
});

test("policy, Namespace and original claim changes deny response without effects", async () => {
  for (const change of ["policyDrift", "namespaceDrift", "revokeClaim", "revokeReader", "expire", "hide"] as const) {
    const f = fixture(); await f.register(); const value = await f.read(); f[change]();
    expect(await f.service.respond({ binding, responseCapability: value.responseCapability, response, invocationAuthority: invocation() }))
      .toEqual({ status: "unavailable" });
    expect(f.sends()).toBe(0);
  }
});

test("a repeated signed read replaces the exact binding capability before one response", async () => {
  const f = fixture(); await f.register(); const first = await f.read(); const second = await f.read();
  expect(await f.service.respond({ binding, responseCapability: first.responseCapability, response,
    invocationAuthority: invocation() })).toEqual({ status: "unavailable" });
  let release!: () => void; f.setSend(() => new Promise(resolve => { release = resolve; }));
  const one = f.service.respond({ binding, responseCapability: second.responseCapability, response, invocationAuthority: invocation() });
  while (release === undefined) await Promise.resolve();
  release(); expect(await one).toEqual({ status: "responded" }); expect(f.sends()).toBe(1);
});

test("replaces only the outstanding challenge for the exact device and client session", async () => {
  const f = fixture(); await f.register();
  const first = await f.plan();
  const replacement = await f.plan();
  expect(f.recipients.hasOperation({ operationId: first.challengeId,
    clientActionSessionId: binding.clientActionSessionId,
    actorId: binding.humanActorId })).toBe(false);
  expect(f.recipients.hasOperation({ operationId: replacement.challengeId,
    clientActionSessionId: binding.clientActionSessionId,
    actorId: binding.humanActorId })).toBe(true);
  const firstAuthorization = await f.sign(first);
  const replacementAuthorization = await f.sign(replacement);
  try {
    expect(await f.service.read({ binding, challengeId: first.challengeId,
      authorizationBytes: firstAuthorization })).toEqual({ status: "unavailable" });
    expect((await f.service.read({ binding, challengeId: replacement.challengeId,
      authorizationBytes: replacementAuthorization })).status).toBe("read");
  } finally {
    firstAuthorization.fill(0);
    replacementAuthorization.fill(0);
  }
});

test("retains independent challenge and response custody for another current client binding", async () => {
  const f = fixture(); await f.register();
  const otherBinding = { ...binding, clientDeviceId: "other-device",
    clientActionSessionId: "other-client-session" };
  f.allowBinding(otherBinding);
  const firstChallenge = await f.plan();
  await f.plan(otherBinding);
  const firstAuthorization = await f.sign(firstChallenge);
  try {
    expect((await f.service.read({ binding, challengeId: firstChallenge.challengeId,
      authorizationBytes: firstAuthorization })).status).toBe("read");
  } finally { firstAuthorization.fill(0); }

  const first = await f.read();
  await f.read(otherBinding);
  expect(await f.service.respond({ binding, responseCapability: first.responseCapability,
    response, invocationAuthority: invocation() })).toEqual({ status: "responded" });
  expect(f.sends()).toBe(1);
});

test("device, session, grant, registration close and deadline cancellation release a stalled response once", async () => {
  for (const ending of ["device", "session", "grant", "close", "deadline"] as const) {
    const f = fixture();
    const registration = await f.register();
    if (registration === null) throw new Error("registration denied");
    const value = await f.read();
    let acknowledge!: () => void;
    const acknowledgment = new Promise<void>(resolve => { acknowledge = resolve; });
    let sent!: () => void;
    const sendStarted = new Promise<void>(resolve => { sent = resolve; });
    f.setSend(signal => {
      if (signal === undefined) throw new Error("response action signal missing");
      sent();
      return new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(signal.reason instanceof Error
          ? signal.reason : new Error("response action aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
        void acknowledgment.then(resolve).finally(() => signal.removeEventListener("abort", onAbort));
        if (signal.aborted) onAbort();
      });
    });
    const pending = f.service.respond({ binding, responseCapability: value.responseCapability,
      response, invocationAuthority: invocation() });
    await sendStarted;
    if (ending === "device") {
      f.service.cancelForDevice({ subjectHumanId: binding.humanActorId, issuingDeviceId: binding.clientDeviceId });
    } else if (ending === "session") {
      f.service.cancelForClientSession(binding.clientActionSessionId);
    } else if (ending === "grant") {
      f.controller.abort();
    } else if (ending === "close") {
      registration.close();
    } else {
      f.expire();
      await f.service.list(binding);
    }
    expect(await Promise.race([pending, Bun.sleep(50).then(() => "timed_out" as const)]))
      .toEqual({ status: "unavailable" });
    expect(f.sends()).toBe(1);
    expect(await f.service.respond({ binding, responseCapability: value.responseCapability,
      response, invocationAuthority: invocation() })).toEqual({ status: "unavailable" });
    acknowledge();
    await Promise.resolve();
    expect(f.sends()).toBe(1);
  }
});

test("provider failure and post-send revocation consume the response without replay", async () => {
  for (const fail of [true, false]) {
    const f = fixture(); await f.register(); const value = await f.read();
    f.setSend(async () => { if (fail) throw new Error("provider unavailable"); f.revokeClaim(); });
    await expectFailure(f.service.respond({ binding, responseCapability: value.responseCapability, response, invocationAuthority: invocation() }));
    expect(await f.service.respond({ binding, responseCapability: value.responseCapability, response, invocationAuthority: invocation() }))
      .toEqual({ status: "unavailable" });
    expect(f.sends()).toBe(1);
  }
});

test("wrong invocation subject never forwards and cannot reuse the capability", async () => {
  const f = fixture(); await f.register(); const value = await f.read();
  await expectFailure(f.service.respond({ binding, responseCapability: value.responseCapability, response,
    invocationAuthority: createAcceptedInvocationAuthority("other") }));
  expect(f.sends()).toBe(0);
});

test("original abort, grant expiry and shutdown destroy pending recipient custody", async () => {
  for (const end of ["abort", "expire", "close"] as const) {
    const f = fixture(); await f.register(); const challenge = await f.plan();
    if (end === "abort") f.controller.abort(); else if (end === "expire") f.expire(); else f.service.close();
    expect(await f.service.list(binding)).toEqual([]);
    expect(f.recipients.hasOperation({ operationId: challenge.challengeId,
      clientActionSessionId: binding.clientActionSessionId, actorId: binding.humanActorId })).toBe(false);
    expect(await f.service.read({ binding, challengeId: challenge.challengeId, authorizationBytes: await f.sign(challenge) }))
      .toEqual({ status: "unavailable" });
    expect(f.sends()).toBe(0);
  }
});

test("device and client-session invalidation retire challenges and response capabilities", async () => {
  for (const device of [true, false]) {
    const f = fixture(); await f.register(); const value = await f.read(); const challenge = await f.plan();
    if (device) f.service.cancelForDevice({ subjectHumanId: binding.humanActorId, issuingDeviceId: binding.clientDeviceId });
    else f.service.cancelForClientSession(binding.clientActionSessionId);
    expect(await f.service.respond({ binding, responseCapability: value.responseCapability, response, invocationAuthority: invocation() }))
      .toEqual({ status: "unavailable" });
    expect(f.recipients.hasOperation({ operationId: challenge.challengeId,
      clientActionSessionId: binding.clientActionSessionId, actorId: binding.humanActorId })).toBe(false);
    expect(f.sends()).toBe(0);
  }
});

test("device invalidation during a response authority await prevents provider dispatch", async () => {
  const f = fixture(); await f.register(); const value = await f.read();
  let entered!: () => void; const reached = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  f.setInspect(async () => { entered(); await held; });
  const pending = f.service.respond({ binding, responseCapability: value.responseCapability, response, invocationAuthority: invocation() });
  await reached;
  f.service.cancelForDevice({ subjectHumanId: binding.humanActorId, issuingDeviceId: binding.clientDeviceId });
  release(); expect(await pending).toEqual({ status: "unavailable" }); expect(f.sends()).toBe(0);
});

test("invalid signed material consumes only its challenge and releases recipient custody", async () => {
  const f = fixture(); await f.register(); const challenge = await f.plan();
  expect(await f.service.read({ binding, challengeId: challenge.challengeId, authorizationBytes: bytes(1) }))
    .toEqual({ status: "unavailable" });
  expect(f.recipients.hasOperation({ operationId: challenge.challengeId,
    clientActionSessionId: binding.clientActionSessionId, actorId: binding.humanActorId })).toBe(false);
  expect(await f.service.read({ binding, challengeId: challenge.challengeId, authorizationBytes: await f.sign(challenge) }))
    .toEqual({ status: "unavailable" });
  expect((await f.read()).event.requestId).toBe("request");
});

test("failed reader authority requires a fresh read but does not silently deny the provider request", async () => {
  const f = fixture(); await f.register(); const value = await f.read();
  expect(await f.service.respond({ binding: { ...binding, clientActionSessionId: "other" },
    responseCapability: value.responseCapability, response, invocationAuthority: invocation() })).toEqual({ status: "unavailable" });
  expect(f.sends()).toBe(0);
  expect((await f.read()).event.requestId).toBe("request");
});

test("resolved and concurrently cancelled reads never mint a response capability", async () => {
  for (const resolve of [true, false]) {
    const f = fixture(); await f.register(); const challenge = await f.plan(); const signed = await f.sign(challenge);
    let entered!: () => void; const reached = new Promise<void>(done => { entered = done; });
    let release!: () => void; const held = new Promise<void>(done => { release = done; });
    f.setInspect(async () => { entered(); await held; });
    const reading = f.service.read({ binding, challengeId: challenge.challengeId, authorizationBytes: signed });
    await reached;
    if (resolve) f.hide(); else f.service.cancelForClientSession(binding.clientActionSessionId);
    release(); expect(await reading).toEqual({ status: "unavailable" });
    expect(f.sends()).toBe(0); signed.fill(0);
  }
});

test("reader revocation after provider send reports unavailable without retrying the effect", async () => {
  const f = fixture(); await f.register(); const value = await f.read();
  f.setSend(async () => { f.namespaceDrift(); });
  expect(await f.service.respond({ binding, responseCapability: value.responseCapability, response, invocationAuthority: invocation() }))
    .toEqual({ status: "unavailable" });
  expect(await f.service.respond({ binding, responseCapability: value.responseCapability, response, invocationAuthority: invocation() }))
    .toEqual({ status: "unavailable" });
  expect(f.sends()).toBe(1);
});
