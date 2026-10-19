import { assertProtectedTaskOperationalMetadataProjectionV1, classifyProtectedTaskMetadataV1 } from "@nautilo/types";
import { describe, expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { authority, coordinate, fixture } from "../fixtures/task-content-crypto-completion.ts";
import { withVerifiedForegroundTaskDefinitionPublication, publishVerifiedForegroundTaskDefinition,
  withOpenForegroundTaskDefinition,
  readVerifiedForegroundTaskDefinitionAccessRevision,
  type VerifiedForegroundTaskDefinitionPublication } from "../../src/server/task/postgres-foreground-task-definition-inspector.ts";
import { fingerprintTaskContentAuthorityV1, type TaskContentProductStorePort,
  type TaskContentRevisionStateV1 } from "../../src/task/task-content-repository.ts";
import type { AgentEntityCryptoInvocation } from "../../src/object/agent-entity-crypto.ts";

async function setup(ephemeral = false, contentRevision = 1,
  source: "foreground" | "human" = "foreground", retainedHistoricalError?: string) {
  const selectedCoordinate = { ...coordinate, contentRevision };
  const f = await fixture(source, true, ephemeral, selectedCoordinate,
    retainedHistoricalError === undefined ? undefined : {
      formatVersion: 2, prompt: "Private definition", expectedOutput: null,
      protectedMetadata: {}, retainedHistoricalError,
    });
  await f.adapter.complete(f.prepared);
  const abort = new AbortController();
  let denied = false;
  let currentProof = true;
  let loans = 0;
  let keyGeneration = 4;
  let current = { ...authority };
  const namespaceKeyByte = source === "foreground" ? 51 : 0x51;
  let borrowedKey: Uint8Array | null = null;
  const entities: AgentEntityCryptoInvocation = {
    signal: abort.signal,
    useCurrentSet: async () => { throw new Error("Recovery must never prepare or encrypt"); },
    use: async request => {
      expect(request.operations).toEqual(["decrypt"]);
      expect(request.entity).toEqual({ namespaceId: current.namespaceId, keyGeneration,
        accessRevision: current.expectedAccessRevision });
      if (denied) return { status: "unavailable", reason: "authorization_unavailable" };
      loans += 1;
      const key = new Uint8Array(32).fill(keyGeneration === 4 ? namespaceKeyByte : 0x52); borrowedKey = key;
      try { return { status: "executed", value: await request.execute({ namespaceKey: key, authority: {
        namespaceId: current.namespaceId, domainId: current.domainId, namespaceAccessRevision: current.expectedAccessRevision,
        namespaceKeyGeneration: keyGeneration, domainKeyGeneration: 1, domainAuthorizationRevision: 2,
        domainHeadDigest: new Uint8Array(32), namespaceHeadDigest: new Uint8Array(32),
        namespacePublicationDigest: new Uint8Array(32), namespacePublicationSetDigest: new Uint8Array(32),
        namespaceAudienceFingerprint: new Uint8Array(32),
      } }) }; } finally { key.fill(0); }
    },
  };
  const input = () => ({ handle: f.handle, crypto: f.crypto, taskId: coordinate.taskId, contentRevision,
    expectedAgentId: "task-agent", payload: { formatVersion: 1 as const, prompt: "Native definition", expectedOutput: null, protectedMetadata: {} },
    currentAuthority: current, entities, ...f.history, assertCurrent: () => {
      abort.signal.throwIfAborted();
      if (!currentProof) throw new Error("Foreground authority revoked");
    } });
  return { f, input, abort, key: () => borrowedKey, loans: () => loans,
    deny: () => { denied = true; }, rewrap: () => { f.rewrapHuman(3); keyGeneration = 5;
      current = { ...authority, expectedAccessRevision: 3, expectedPolicyRevision: 4 }; },
    drift: () => { current = { ...current, domainId: "changed" }; },
    revoke: () => { currentProof = false; } };
}
function product(current: ReturnType<Awaited<ReturnType<typeof setup>>["input"]>["currentAuthority"]) {
  let state: TaskContentRevisionStateV1 | null = null;
  let access = -1;
  let maps = 0;
  const unreachable = async (): Promise<never> => { throw new Error("Unexpected product call"); };
  const port: TaskContentProductStorePort = {
    reserveRevision: async request => {
      state = { authority: current, product: null, lifecycle: { sequence: 1, ...request,
        completion: "pending", disposition: "active", attemptCount: 0, nextAttemptAt: null,
        leaseToken: null, leaseExpiresAt: null, failureCode: null, cryptoCompletedAt: null } };
      return { status: "reserved", state };
    },
    getRevision: async () => state,
    markCryptoComplete: async () => {
      if (state === null) throw new Error("No reservation");
      state = { ...state, lifecycle: { ...state.lifecycle, completion: "complete", cryptoCompletedAt: new Date(1) } };
      return "applied";
    },
    compareAndSwapCryptoMapping: async request => {
      if (state === null || request.foregroundDefinitionProof === undefined) throw new Error("Missing verified proof");
      access = readVerifiedForegroundTaskDefinitionAccessRevision(request.foregroundDefinitionProof, { lifecycle: state.lifecycle, currentAuthority: current });
      maps += 1;
      const status = state.lifecycle.disposition === "mapped" ? "duplicate" : "applied";
      state = { ...state, lifecycle: { ...state.lifecycle, disposition: "mapped" }, product: {
        coordinate: state.lifecycle.coordinate, namespaceId: state.lifecycle.namespaceId,
        representation: state.lifecycle.representation, cryptoObjectId: state.lifecycle.cryptoObjectId,
        cryptoAccessRevision: access, cryptoRequiredNamespaceFingerprint: state.lifecycle.requiredNamespaceFingerprint,
        cryptoMappingState: "verified" } };
      return status;
    },
    getRevisionByOperation: unreachable, quarantineRevision: unreachable, markAuthorityStale: unreachable,
    claimReconciliationCandidates: unreachable, failReconciliationClaim: unreachable,
  };
  return { port, state: () => state!, removeProduct: () => { if (state !== null) state = { ...state, product: null }; }, access: () => access, maps: () => maps };
}

describe("foreground Task definition restart inspection", () => {
  test("opens one exact later revision only inside the current callback", async () => {
    const f = await setup(false, 2);
    let callbacks = 0;
    expect(await withOpenForegroundTaskDefinition({ ...f.input(), use: async payload => {
      callbacks += 1;
      expect(payload.payload.prompt).toBe("Native definition");
      expect(payload.retainedHistoricalError).toBeNull();
      return payload.payload.expectedOutput;
    } })).toEqual({ status: "opened", value: null });
    expect(callbacks).toBe(1);
    expect(f.key()?.every(byte => byte === 0)).toBe(true);
    await rejects(withOpenForegroundTaskDefinition({ ...f.input(), contentRevision: 1,
      use: async () => { throw new Error("wrong revision opened"); } }), /substituted|identity|authority/);
  });
  test("revalidates current authority after an open-definition callback", async () => {
    const f = await setup(false, 2);
    await rejects(withOpenForegroundTaskDefinition({ ...f.input(), use: async () => {
      f.revoke();
      return "must not escape";
    } }), /Foreground authority revoked/u);
  });
  test("opens an authenticated current Human-device definition without weakening creation proof", async () => {
    const f = await setup(false, 2, "human");
    expect(await withOpenForegroundTaskDefinition({ ...f.input(), use: async payload => payload.payload.prompt }))
      .toEqual({ status: "opened", value: "Private definition" });
    await rejects(withVerifiedForegroundTaskDefinitionPublication({ ...f.input(),
      use: async () => { throw new Error("Human source must not mint creation proof"); } }), /identity|authority/u);
  });
  test("opens an authenticated V2 definition with its retained historical display error", async () => {
    const f = await setup(false, 2, "human", "provider unavailable");
    expect(await withOpenForegroundTaskDefinition({ ...f.input(), use: async content => content }))
      .toEqual({ status: "opened", value: {
        payload: { formatVersion: 1, prompt: "Private definition", expectedOutput: null,
          protectedMetadata: {} },
        retainedHistoricalError: "provider unavailable",
      } });
  });
  test("retains genuine classifier authority during orphan adoption rather than cloning its brand", async () => {
    const f = await setup();
    const p = product(f.input().currentAuthority);
    const classified = classifyProtectedTaskMetadataV1({});
    if (classified.status !== "supported") throw new Error("Expected metadata");
    const projection = classified.operational;
    const reserve = p.port.reserveRevision;
    p.port.reserveRevision = async input => {
      expect(input.operationalMetadata).toBe(projection);
      assertProtectedTaskOperationalMetadataProjectionV1(input.operationalMetadata);
      return reserve(input);
    };
    expect(await withVerifiedForegroundTaskDefinitionPublication({ ...f.input(), use: proof =>
      publishVerifiedForegroundTaskDefinition({ proof, product: p.port, operationId: "branded-adoption", representation: "protected", operationalMetadata: projection }),
    })).toEqual({ status: "verified", value: "mapped" });
  });

  test("recovers ephemeral foreground genesis from retained accepted execution after restart and rewrap", async () => {
    const f = await setup(true);
    expect(f.f.connection.signer).toBeNull();
    f.rewrap();
    const p = product(f.input().currentAuthority);
    expect(await withVerifiedForegroundTaskDefinitionPublication({ ...f.input(), use: proof =>
      publishVerifiedForegroundTaskDefinition({ proof, product: p.port, operationId: "retained-creation", representation: "protected", operationalMetadata: null }),
    })).toEqual({ status: "verified", value: "mapped" });
    expect(p.access()).toBe(1);
    f.f.invalidateAcceptedPlan();
    await rejects(withVerifiedForegroundTaskDefinitionPublication({ ...f.input(), use: async () => { throw new Error("Must not expose proof"); } }), /Selected foreground Agent execution evidence is invalid/);
  });

  test("real Agent ciphertext survives rollback/restart and maps its inspected rewrapped head", async () => {
    const f = await setup();
    const ciphertext = Uint8Array.from(f.f.connection.state.object!["payload_bytes"] as Uint8Array);
    // postgres-js bytea values can be Buffers: cleanup must not wipe aliased storage.
    f.f.connection.state.object = { ...f.f.connection.state.object!, payload_bytes: Buffer.from(ciphertext) };
    f.rewrap();
    const p = product(f.input().currentAuthority);
    let escaped: VerifiedForegroundTaskDefinitionPublication | undefined;
    for (const expected of ["mapped", "replayed"] as const) {
      expect(await withVerifiedForegroundTaskDefinitionPublication({ ...f.input(), use: async proof => {
        escaped = proof;
        return publishVerifiedForegroundTaskDefinition({ proof, product: p.port,
          operationId: "task-create:effect", representation: "protected", operationalMetadata: null });
      } })).toEqual({ status: "verified", value: expected });
    }
    expect(p.access()).toBe(1); expect(p.maps()).toBe(2);
    expect(p.state().lifecycle.requestDigest).toEqual(
      Uint8Array.from(f.f.connection.state.manifests.get(0)!["manifest_hash"] as Uint8Array),
    );
    expect(Uint8Array.from(f.f.connection.state.object["payload_bytes"] as Uint8Array)).toEqual(ciphertext);
    expect(f.key()?.every(byte => byte === 0)).toBe(true);
    expect(() => readVerifiedForegroundTaskDefinitionAccessRevision(escaped!, {
      lifecycle: p.state().lifecycle, currentAuthority: f.input().currentAuthority })).toThrow(/closed/);
  });
  test("recovered update reservation retains its detached operation digest across exact replay", async () => {
    const f = await setup(false, 2);
    const p = product(f.input().currentAuthority);
    const expectedDigest = new Uint8Array(32).fill(41);
    for (const expected of ["mapped", "replayed"] as const) {
      const suppliedDigest = Uint8Array.from(expectedDigest);
      expect(await withVerifiedForegroundTaskDefinitionPublication({ ...f.input(),
        expectedRequestDigest: suppliedDigest,
        use: proof => {
          suppliedDigest.fill(99);
          return publishVerifiedForegroundTaskDefinition({ proof, product: p.port,
            operationId: "task-update:effect", representation: "protected", operationalMetadata: null });
        },
      })).toEqual({ status: "verified", value: expected });
      expect(p.state().lifecycle.requestDigest).toEqual(expectedDigest);
    }
    expect(p.maps()).toBe(2);
    await rejects(withVerifiedForegroundTaskDefinitionPublication({ ...f.input(),
      expectedRequestDigest: new Uint8Array(32).fill(42),
      use: proof => publishVerifiedForegroundTaskDefinition({ proof, product: p.port,
        operationId: "task-update:effect", representation: "protected", operationalMetadata: null }),
    }), /reservation/u);
    expect(p.maps()).toBe(2);
    await rejects(withVerifiedForegroundTaskDefinitionPublication({ ...f.input(),
      expectedRequestDigest: new Uint8Array(31),
      use: async () => { throw new Error("Invalid request digest must not lend a proof"); },
    }), /request digest/u);
  });
  test("forged tokens and source, signer, Namespace and ciphertext substitutions never map", async () => {
    const p = product(authority);
    await rejects(publishVerifiedForegroundTaskDefinition({ proof: { kind: "verified_foreground_task_definition" },
      product: p.port, operationId: "task-create:effect", representation: "protected", operationalMetadata: null }), /foreign/);
    for (const kind of ["source", "signer", "namespace", "ciphertext", "history"] as const) {
      const f = await setup();
      const input = f.input();
      if (kind === "ciphertext") (f.f.connection.state.object!["payload_bytes"] as Uint8Array)[0]! ^= 1;
      if (kind === "history") f.f.setSignerHistoryAvailable(false);
      let invoked = false;
      await rejects(withVerifiedForegroundTaskDefinitionPublication({ ...input,
        ...(kind === "source" ? { payload: { ...input.payload, prompt: "Other source" } } : {}),
        ...(kind === "signer" ? { expectedAgentId: "another-agent" } : {}),
        ...(kind === "namespace" ? { currentAuthority: { ...input.currentAuthority, namespaceId: "40000000-0000-4000-8000-000000000002" } } : {}),
        use: async () => { invoked = true; } }));
      expect(invoked).toBe(false);
    }
    expect(p.maps()).toBe(0);
  });
  test("missing bytes and denied fresh grant are distinct and never invoke publication", async () => {
    const missing = await setup(); missing.f.connection.state = { object: null, head: null, manifests: new Map(), envelopes: [] };
    expect(await withVerifiedForegroundTaskDefinitionPublication({ ...missing.input(), use: async () => { throw new Error("No bytes"); } }))
      .toEqual({ status: "missing" });
    const denied = await setup(); denied.deny();
    expect(await withVerifiedForegroundTaskDefinitionPublication({ ...denied.input(), use: async () => { throw new Error("No grant"); } }))
      .toEqual({ status: "unavailable" });
    expect(denied.loans()).toBe(0);
  });
  test("revocation, changed current authority and callback failure close all custody", async () => {
    for (const revoke of [false, true]) {
      const f = await setup(); let escaped: VerifiedForegroundTaskDefinitionPublication | undefined;
      const p = product(authority);
      await rejects(withVerifiedForegroundTaskDefinitionPublication({ ...f.input(), use: async proof => {
        escaped = proof;
        if (revoke) { f.abort.abort(); return; }
        throw new Error("Product transaction rejected");
      } }));
      expect(f.key()?.every(byte => byte === 0)).toBe(true);
      await rejects(publishVerifiedForegroundTaskDefinition({ proof: escaped!, product: p.port,
        operationId: "task-create:effect", representation: "protected", operationalMetadata: null }), /closed/);
    }
    const f = await setup(); const captured = f.input(); f.drift();
    await rejects(withVerifiedForegroundTaskDefinitionPublication({ ...captured, use: async () => {} }), /Namespace changed/);
  });
  test("an unawaited publication cannot retain custody after its inspector callback returns", async () => {
    const f = await setup(); const p = product(authority);
    let escaped: Promise<unknown> | undefined;
    await withVerifiedForegroundTaskDefinitionPublication({ ...f.input(), use: async proof => {
      escaped = publishVerifiedForegroundTaskDefinition({ proof, product: p.port,
        operationId: "task-create:effect", representation: "protected", operationalMetadata: null });
      void escaped.catch(() => {});
    } });
    await rejects(escaped!, /closed/);
    expect(p.maps()).toBe(0);
  });
  test("a live token cannot authorize another reservation or a changed current policy", async () => {
    const f = await setup(); const p = product(authority);
    await withVerifiedForegroundTaskDefinitionPublication({ ...f.input(), use: async proof => {
      await publishVerifiedForegroundTaskDefinition({ proof, product: p.port,
        operationId: "task-create:effect", representation: "protected", operationalMetadata: null });
      for (const lifecycle of [{ ...p.state().lifecycle, requestDigest: new Uint8Array(32) },
        { ...p.state().lifecycle, coordinate: { ...coordinate, taskId: "10000000-0000-4000-8000-000000000002" } }]) {
        expect(() => readVerifiedForegroundTaskDefinitionAccessRevision(proof, { lifecycle, currentAuthority: authority })).toThrow(/reservation/);
      }
      expect(() => readVerifiedForegroundTaskDefinitionAccessRevision(proof, { lifecycle: p.state().lifecycle,
        currentAuthority: { ...authority, expectedPolicyRevision: 4 } })).toThrow(/authority/);
      p.removeProduct();
      await rejects(publishVerifiedForegroundTaskDefinition({ proof, product: p.port,
        operationId: "task-create:effect", representation: "protected", operationalMetadata: null }), /no longer exists/);
      expect(p.state().lifecycle.authorityFingerprint).toEqual(fingerprintTaskContentAuthorityV1(authority));
    } });
  });
});
