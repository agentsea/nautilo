import { describe, expect, spyOn, test } from "bun:test";
import {
  authorizationRevision, LatticeCrypto, mintDomainForegroundAuthorization,
} from "@nautilo/lattice-crypto";
import {
  destroyDomainForegroundAuthorizationPlanV2,
  destroyDomainForegroundAuthorizationV2,
  parseDomainForegroundAuthorizationPlanV2,
  serializeDomainForegroundAuthorizationV2,
} from "@nautilo/lattice-crypto/wire";
import { createProtectedCheckpointCellCrypto } from "@nautilo/lattice-bridge";
import { LiveShadowRecipientRegistry, LIVE_SHADOW_RECIPIENTS_PER_CLIENT_SESSION,
  withProtectedInvocationRecipientPrivateKey } from "@nautilo/lattice-bridge/server";
import {
  createForegroundCheckpointReadAuthority,
  type ForegroundCheckpointReadBinding,
  type ForegroundCheckpointReadLocator,
  type ForegroundCheckpointReadSnapshot,
} from "../../src/routes/foreground-checkpoint-read-authority";

const binding: ForegroundCheckpointReadBinding = {
  userId: "user-1", humanActorId: "human-1", clientDeviceId: "device-1",
  clientActionSessionId: "browser-1",
};
const locator: ForegroundCheckpointReadLocator = {
  reviewTurnId: "review-1", turnId: "turn-1", checkpointThreadId: "checkpoint-thread-1",
  generationId: "generation-1", accessScope: "scope-1", firstMessageId: 1,
  threadId: "thread-1", laneKey: "room:room-1",
  createdAt: new Date("2026-09-09T00:00:00Z"),
  sessionId: "session-1", roomId: "room-1", topLevelRoomId: "room-1",
  agentId: "agent-1", namespaceId: "namespace-1", entrypointId: "foreground.main",
};
const bytes = (value: number) => new Uint8Array(32).fill(value);
const namespaceKey = bytes(21);

function fixture(beforeResolve?: () => Promise<void>) {
  let clock = Date.now();
  const crypto = new LatticeCrypto();
  const signer = crypto.generateSigningKeyPair();
  const snapshot: ForegroundCheckpointReadSnapshot = {
    policyRevision: 8, agentAuthorizationRevision: 0,
    committerDeviceId: binding.clientDeviceId,
    committerDeviceSigningKeyGeneration: 2,
    committerDeviceSigningPublicKey: signer.publicKey,
    hostAuthorizationRevision: 3,
    room: {
      namespaceId: locator.namespaceId, namespaceAccessRevision: 4,
      namespaceKeyGeneration: 5, namespaceHeadDigest: bytes(1),
      namespacePublicationDigest: bytes(2), namespacePublicationSetDigest: bytes(3),
      namespaceAudienceFingerprint: bytes(4), domainId: "domain-1",
      domainKeyGeneration: 6, domainAuthorizationRevision: 7,
      domainHeadDigest: bytes(5), bundleRevision: 9, bundleDigest: bytes(6),
    },
    domains: [{
      domainId: "domain-1", sourceNamespaceId: locator.namespaceId,
      participantDigest: bytes(7), participantCount: 1, keyClass: "ai",
      domainKeyGeneration: 6, authorizationRevision: authorizationRevision(7),
      headDigest: bytes(5), activeNamespaceBindingSetDigest: bytes(8),
      activeNamespaceBindingCount: 1,
    }],
  };
  let available = true;
  let revision = snapshot.policyRevision;
  const returnedSnapshots: ForegroundCheckpointReadSnapshot[] = [];
  const borrowedKeys: Uint8Array[] = [];
  const recipients = new LiveShadowRecipientRegistry(() => clock);
  const service = createForegroundCheckpointReadAuthority({
    crypto, recipients, now: () => clock,
    resolveCurrent: async (actualBinding, actualLocator) => {
      await beforeResolve?.();
      expect(actualBinding).toEqual(binding);
      expect(actualLocator).toEqual(locator);
      if (!available) return null;
      const value = structuredClone({ ...snapshot, policyRevision: revision });
      returnedSnapshots.push(value);
      return value;
    },
    namespaceKeys: {
      inspectForegroundNamespaceAuthority: async () => ({
        status: "ready", ...structuredClone(snapshot.room),
      }),
      withOpenedForegroundNamespaceKey: async (request) => {
        const key = namespaceKey.slice();
        borrowedKeys.push(key, request.domainKey);
        try { return await request.use(key); }
        finally { key.fill(0); }
      },
    },
  });
  const plan = async () => {
    const result = await service.plan({ binding, locator, deadlineAt: clock + 300_000 });
    if (result.status !== "authorization_required") throw new Error("plan unavailable");
    return result;
  };
  const sign = async (
    challenge: Awaited<ReturnType<typeof plan>>,
    operations?: readonly ("decrypt" | "encrypt")[],
  ) => {
    const decoded = parseDomainForegroundAuthorizationPlanV2(challenge.authorizationPlanBytes);
    if (decoded === null) throw new Error("plan invalid");
    try {
      expect(decoded.operations).toEqual(["decrypt"]);
      expect(decoded.domains).toHaveLength(1);
      const authorization = await mintDomainForegroundAuthorization(crypto, {
        plan: operations === undefined ? decoded : { ...decoded, operations },
        domains: snapshot.domains.map((domain) => ({ ...domain, domainKey: bytes(20) })),
        committerDeviceSigningPrivateKey: signer.privateKey,
        recipientEncryptionPublicKey: challenge.recipientPublicKey,
      });
      try { return serializeDomainForegroundAuthorizationV2(authorization); }
      finally { destroyDomainForegroundAuthorizationV2(authorization); }
    } finally { destroyDomainForegroundAuthorizationPlanV2(decoded); }
  };
  const read = async (
    challenge: Awaited<ReturnType<typeof plan>>,
    execute: Parameters<typeof service.read<string>>[0]["execute"] = async () => "pending approval",
    authorizationBytes?: Uint8Array,
  ) => service.read({
    binding, challengeId: challenge.challengeId,
    authorizationBytes: authorizationBytes ?? await sign(challenge), execute,
  });
  return {
    crypto, snapshot, recipients, service, plan, sign, read, returnedSnapshots, borrowedKeys,
    revoke: () => { available = false; },
    drift: () => { revision++; },
    expire: () => { clock += 300_000; },
    now: () => clock,
  };
}

describe("fresh foreground checkpoint read authority", () => {
  test("prunes expired stalled lookup controllers before re-admission and removes cancelled active entries immediately", async () => {
    const release = Promise.withResolvers<void>();
    const firstEntered = Promise.withResolvers<void>();
    const secondEntered = Promise.withResolvers<void>();
    let lookups = 0;
    const f = fixture(() => {
      if (++lookups === 1) firstEntered.resolve();
      else secondEntered.resolve();
      return release.promise;
    });
    const first = f.service.plan({binding, locator, deadlineAt: f.now() + 300_000});
    await firstEntered.promise;
    const abort = spyOn(AbortController.prototype, "abort");
    try {
      f.expire();
      const second = f.service.plan({binding, locator, deadlineAt: f.now() + 300_000});
      await secondEntered.promise;
      expect(abort).toHaveBeenCalledTimes(1);
      expect(f.recipients.size()).toBe(1);
      // Expiry removed the first stalled controller; cancellation must visit
      // only the second, and subsequent cancellation/close must visit neither.
      f.service.cancelForHuman(binding.humanActorId);
      expect(abort).toHaveBeenCalledTimes(2);
      expect(f.recipients.size()).toBe(0);
      f.service.cancelForHuman(binding.humanActorId);
      f.service.close();
      expect(abort).toHaveBeenCalledTimes(2);
      abort.mockRestore();
      release.resolve();
      expect(await first).toEqual({status: "unavailable"});
      expect(await second).toEqual({status: "unavailable"});
    } finally {
      abort.mockRestore();
      release.resolve();
      f.service.close();
    }
  });
  test("reserves bounded admission before key generation and releases every cancelled pending slot", async () => {
    const f = fixture();
    const keys = await f.crypto.generateEncryptionKeyPair();
    const deferred = Promise.withResolvers<typeof keys>();
    const generation = spyOn(f.crypto, "generateEncryptionKeyPair").mockImplementation(() => deferred.promise);
    const request = {binding, locator, deadlineAt: Date.now() + 300_000};
    const pending = Array.from({length: LIVE_SHADOW_RECIPIENTS_PER_CLIENT_SESSION}, () => f.service.plan(request));
    expect(f.recipients.size()).toBe(LIVE_SHADOW_RECIPIENTS_PER_CLIENT_SESSION);
    expect(await f.service.plan(request)).toEqual({status: "unavailable"});
    expect(generation).toHaveBeenCalledTimes(LIVE_SHADOW_RECIPIENTS_PER_CLIENT_SESSION);
    f.service.cancelForHuman(binding.humanActorId);
    expect(f.recipients.size()).toBe(0);
    deferred.resolve(keys);
    expect((await Promise.all(pending)).every(result => result.status === "unavailable")).toBe(true);
    expect(keys.privateKey.every(byte => byte === 0)).toBe(true);
    generation.mockRestore();
    f.service.close();
  });

  test("disposes admission after failed key generation, failed authority lookup, and cancellation during lookup", async () => {
    const failedKeys = fixture();
    const generation = spyOn(failedKeys.crypto, "generateEncryptionKeyPair").mockRejectedValue(new Error("key generation failed"));
    expect(await failedKeys.plan().catch((error: unknown) => error)).toBeInstanceOf(Error);
    expect(failedKeys.recipients.size()).toBe(0);
    generation.mockRestore();
    failedKeys.service.close();
    const failedLookup = fixture(() => Promise.reject(new Error("authority failed")));
    expect(await failedLookup.plan().catch((error: unknown) => error)).toBeInstanceOf(Error);
    expect(failedLookup.recipients.size()).toBe(0);
    failedLookup.service.close();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const cancelled = fixture(() => {entered.resolve(); return release.promise;});
    const pending = cancelled.service.plan({binding, locator, deadlineAt: Date.now() + 300_000});
    await entered.promise;
    expect(cancelled.recipients.size()).toBe(1);
    cancelled.service.cancelForClientSession(binding.clientActionSessionId);
    expect(cancelled.recipients.size()).toBe(0);
    release.resolve();
    expect(await pending).toEqual({status: "unavailable"});
    cancelled.service.close();
  });

  test("keeps the admitted slot until an in-flight read settles", async () => {
    const f = fixture();
    const challenge = await f.plan();
    expect(await f.read(challenge, async () => {
      for (let index = 1; index < LIVE_SHADOW_RECIPIENTS_PER_CLIENT_SESSION; index++) {
        expect(f.recipients.reserveRuntime({operationId: `other-${index}`,
          clientActionSessionId: binding.clientActionSessionId, actorId: binding.humanActorId,
          deadlineAt: Date.now() + 300_000})).toBe(true);
      }
      expect(f.recipients.size()).toBe(LIVE_SHADOW_RECIPIENTS_PER_CLIENT_SESSION);
      expect(await f.service.plan({binding, locator, deadlineAt: Date.now() + 300_000})).toEqual({status: "unavailable"});
      return "read";
    })).toEqual({status: "read", value: "read"});
    expect(f.recipients.size()).toBe(LIVE_SHADOW_RECIPIENTS_PER_CLIENT_SESSION - 1);
    for (let index = 1; index < LIVE_SHADOW_RECIPIENTS_PER_CLIENT_SESSION; index++) f.recipients.delete(`other-${index}`);
    f.service.close();
  });

  test("cancellation wipes transferred recipient while pre-read authority lookup is suspended", async () => {
    let lookups = 0;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const f = fixture(() => {
      if (++lookups === 1) return Promise.resolve();
      entered.resolve();
      return release.promise;
    });
    const challenge = await f.plan();
    const taken: {value: ReturnType<LiveShadowRecipientRegistry["takeRuntime"]>} = {value: null};
    const take = f.recipients.takeRuntime.bind(f.recipients);
    const spy = spyOn(f.recipients, "takeRuntime").mockImplementation(request => {
      taken.value = take(request);
      return taken.value;
    });
    const pending = f.read(challenge);
    await entered.promise;
    f.service.cancelForHuman(binding.humanActorId);
    if (taken.value === null) throw new Error("Missing admitted recipient");
    expect(await withProtectedInvocationRecipientPrivateKey(taken.value.recipient, () => true)).toBeNull();
    expect(f.recipients.size()).toBe(1);
    release.resolve();
    expect(await pending).toEqual({status: "unavailable"});
    expect(f.recipients.size()).toBe(0);
    spy.mockRestore();
    f.service.close();
  });
  test("opens a cell under a fresh opaque authorization and exact thread, then disposes custody", async () => {
    const f = fixture();
    const originalSession = {};
    const coordinate = {
      kind: "write" as const, threadId: "physical-thread-1", checkpointNs: "physical-ns-1",
      checkpointId: "checkpoint-1", taskId: "task-1", index: 0, channel: "__interrupt__",
    };
    const originalScope = {
      logicalThreadId: locator.checkpointThreadId, namespaceId: locator.namespaceId,
      keyClass: "ai" as const, expectedAccessRevision: 4, expectedPolicyRevision: 0,
      authorizationSession: originalSession,
    };
    const oldCrypto = createProtectedCheckpointCellCrypto({
      crypto: f.crypto, domainId: "domain-1", entrypointId: "foreground.main",
      authority: {
        execute: async (operation) => operation.execute({
          signal: new AbortController().signal, assertActive: () => {},
          assertCommitAllowed: async () => {}, remainingMs: () => 300_000,
          material: {
            namespaceId: locator.namespaceId, domainId: "domain-1",
            accessRevision: 4, agentAuthorizationRevision: 0,
            currentGeneration: 5,
            generations: [{ generation: 5, key: namespaceKey }],
          },
        }),
      },
    });
    const ciphertext = await oldCrypto.executeAuthorizedOperation({
      operation: "write", scope: originalScope,
      execute: (context) => oldCrypto.seal({
        scope: originalScope, coordinate, plaintext: new TextEncoder().encode("pending approval"),
        signal: context.signal,
      }),
    });
    const challenge = await f.plan();
    let afterClose: (() => Promise<unknown>) | undefined;
    const result = await f.read(challenge, async (checkpoint, actualLocator) => {
      expect(actualLocator).toEqual(locator);
      expect(checkpoint.authorizationSession).not.toBe(originalSession);
      const scope = { ...originalScope, authorizationSession: checkpoint.authorizationSession };
      afterClose = () => checkpoint.crypto.executeAuthorizedOperation({
        operation: "read", scope,
        execute: (context) => checkpoint.crypto.open({ scope, coordinate, ciphertext, signal: context.signal }),
      });
      expect(checkpoint.crypto.executeAuthorizedOperation({
        operation: "write", scope, execute: async () => "forbidden",
      })).rejects.toBeDefined();
      expect(checkpoint.crypto.executeAuthorizedOperation({
        operation: "read", scope: { ...scope, logicalThreadId: "other-thread" },
        execute: async () => "forbidden",
      })).rejects.toBeDefined();
      return new TextDecoder().decode(await afterClose() as Uint8Array);
    });
    expect(result).toEqual({ status: "read", value: "pending approval" });
    expect(afterClose).toBeDefined();
    expect(afterClose!()).rejects.toBeDefined();
    expect(f.recipients.hasOperation({ operationId: challenge.challengeId,
      clientActionSessionId: binding.clientActionSessionId, actorId: binding.humanActorId })).toBe(false);
    expect(f.returnedSnapshots.every((value) => value.committerDeviceSigningPublicKey.every((byte) => byte === 0))).toBe(true);
    f.service.close();
  });

  test("rejects signed operation widening and consumes failed challenges", async () => {
    const f = fixture();
    const challenge = await f.plan();
    let reads = 0;
    expect(await f.read(challenge, async () => { reads++; return "secret"; },
      await f.sign(challenge, ["decrypt", "encrypt"]))).toEqual({ status: "unavailable" });
    expect(await f.read(challenge)).toEqual({ status: "unavailable" });
    expect(reads).toBe(0);
    f.service.close();
  });

  test("rejects current policy drift before decrypt and authority revocation after read", async () => {
    const f = fixture();
    const challenge = await f.plan();
    f.drift();
    let calls = 0;
    expect(await f.read(challenge, async () => { calls++; return "secret"; })).toEqual({ status: "unavailable" });
    expect(calls).toBe(0);
    const next = await f.plan();
    expect(await f.read(next, async () => { f.revoke(); return "secret"; })).toEqual({ status: "unavailable" });
    f.service.close();
  });

  test("consumes a challenge before concurrent replay and rejects a foreign binding without consuming", async () => {
    const f = fixture();
    const challenge = await f.plan();
    const authorizationBytes = await f.sign(challenge);
    expect(await f.service.read({ binding: { ...binding, clientDeviceId: "other-device" },
      challengeId: challenge.challengeId, authorizationBytes, execute: async () => "secret" })).toEqual({ status: "unavailable" });
    const results = await Promise.all([f.read(challenge, undefined, authorizationBytes), f.read(challenge, undefined, authorizationBytes)]);
    expect(results.filter((result) => result.status === "read")).toHaveLength(1);
    f.service.close();
  });

  for (const action of ["expire", "device", "human", "session", "close"] as const) {
    test(`rejects completion after ${action} and disposes pending custody`, async () => {
      const f = fixture();
      const challenge = await f.plan();
      const cancel = () => {
        if (action === "expire") f.expire();
        else if (action === "device") f.service.cancelForDevice({ subjectHumanId: binding.humanActorId, issuingDeviceId: binding.clientDeviceId });
        else if (action === "human") f.service.cancelForHuman(binding.humanActorId);
        else if (action === "session") f.service.cancelForClientSession(binding.clientActionSessionId);
        else f.service.close();
      };
      expect(await f.read(challenge, async () => { cancel(); return "secret"; })).toEqual({ status: "unavailable" });
      f.service.close();
      expect(await f.read(challenge)).toEqual({ status: "unavailable" });
    });
  }

  test("callback failure destroys recipient and fresh authority, without replay", async () => {
    const f = fixture();
    const challenge = await f.plan();
    expect(f.read(challenge, async () => { throw new Error("storage unavailable"); })).rejects.toThrow("storage unavailable");
    expect(await f.read(challenge)).toEqual({ status: "unavailable" });
    expect(f.returnedSnapshots.every((value) => value.committerDeviceSigningPublicKey.every((byte) => byte === 0))).toBe(true);
    f.service.close();
  });

  test("teardown immediately wipes borrowed keys while an asynchronous checkpoint read is suspended", async () => {
    const f = fixture();
    const challenge = await f.plan();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const pending = f.read(challenge, async (checkpoint) => checkpoint.crypto.executeAuthorizedOperation({
      operation: "read",
      scope: {
        logicalThreadId: locator.checkpointThreadId, namespaceId: locator.namespaceId,
        keyClass: "ai", expectedAccessRevision: 4, expectedPolicyRevision: 0,
        authorizationSession: checkpoint.authorizationSession,
      },
      execute: async () => {
        entered.resolve();
        await release.promise;
        return "secret";
      },
    }));
    await entered.promise;
    expect(f.borrowedKeys.some((key) => key.some((byte) => byte !== 0))).toBe(true);
    f.service.close();
    expect(f.borrowedKeys.every((key) => key.every((byte) => byte === 0))).toBe(true);
    release.resolve();
    expect(await pending).toEqual({ status: "unavailable" });
  });
});
