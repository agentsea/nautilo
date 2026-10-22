import { describe, expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { TaskContentCryptoCompletionConflictError } from "../../src/server/task/postgres-task-content-crypto-completion.ts";
import type { TaskContentCryptoRevisionReferenceV1 } from "../../src/task/task-content-repository.ts";
import { fixture, authority, coordinate, NAMESPACE_ID, OTHER_TASK_ID } from "../fixtures/task-content-crypto-completion.ts";

describe("Postgres Task content crypto completion", () => {
  test("foreground definitions complete and restart through retained execution without persistent Runtime signer", async () => {
    const state = await fixture("foreground", true, true);
    expect(state.connection.signer).toBeNull();
    expect(await state.adapter.complete(state.prepared)).toBe("created");
    expect(await state.adapter.verify(state.reference)).not.toBeNull();
    expect(await state.adapter.complete(state.prepared)).toBe("duplicate");
    state.rewrapHuman(3);
    expect(await state.adapter.verify({ ...state.reference, expectedAccessRevision: 1 })).not.toBeNull();
    state.invalidateAcceptedPlan();
    await rejects(state.adapter.verify({ ...state.reference, expectedAccessRevision: 1 }), /Selected foreground Agent execution evidence is invalid/);
  });

  test("completes and verifies Human-device and Agent-runtime publications", async () => {
    for (const kind of ["human", "agent"] as const) {
      const state = await fixture(kind);
      expect(await state.adapter.complete(state.prepared)).toBe("created");
      expect(await state.adapter.verify(state.reference)).toMatchObject({
        coordinate,
        objectId: state.prepared.objectId,
        objectType: "nautilo-task-definition-v1",
        payloadVersion: 1,
        namespaceId: NAMESPACE_ID,
      });
    }
  });

  test("accepts exact replay and rejects an object-ID byte collision", async () => {
    const state = await fixture("human");
    expect(await state.adapter.complete(state.prepared)).toBe("created");
    expect(await state.adapter.complete(state.prepared)).toBe("duplicate");
    const object = state.connection.state.object;
    if (object === null) throw new Error("missing stored object");
    (object["payload_bytes"] as Uint8Array)[0]! ^= 1;
    expect(state.adapter.complete(state.prepared)).rejects.toBeInstanceOf(
      TaskContentCryptoCompletionConflictError,
    );
  });

  test("accepts exact replay and verification after a valid Namespace rewrap", async () => {
    const state = await fixture("human");
    expect(await state.adapter.complete(state.prepared)).toBe("created");
    state.rewrapHuman(3);
    expect(await state.adapter.complete(state.prepared)).toBe("duplicate");
    expect(await state.adapter.verify({
      ...state.reference,
      expectedAccessRevision: 1,
    })).toMatchObject({
      coordinate,
      objectId: state.prepared.objectId,
      namespaceId: NAMESPACE_ID,
    });
  });

  test("binds recovery to the exact genesis manifest, including after rewrap", async () => {
    const state = await fixture("human");
    await state.adapter.complete(state.prepared);
    const genesis = state.connection.state.manifests.get(0)?.["manifest_hash"] as Uint8Array;
    expect(genesis).toBeInstanceOf(Uint8Array);
    const expectedGenesisManifestHash = genesis.slice();
    expect(await state.adapter.verify({ ...state.reference, expectedGenesisManifestHash }))
      .not.toBeNull();
    state.rewrapHuman(3);
    expect(await state.adapter.verify({ ...state.reference, expectedAccessRevision: 1,
      expectedGenesisManifestHash })).not.toBeNull();
    const wrongHash = expectedGenesisManifestHash.slice();
    wrongHash[0]! ^= 1;
    expect(state.adapter.verify({ ...state.reference, expectedAccessRevision: 1,
      expectedGenesisManifestHash: wrongHash })).rejects.toBeInstanceOf(
      TaskContentCryptoCompletionConflictError,
    );
    expect(state.adapter.verify({ ...state.reference,
      expectedGenesisManifestHash: new Uint8Array(31) })).rejects.toThrow("reference is invalid");
  });

  test("snapshots the expected genesis hash before awaiting authority", async () => {
    const state = await fixture("agent");
    await state.adapter.complete(state.prepared);
    const genesis = state.connection.state.manifests.get(0)?.["manifest_hash"] as Uint8Array;
    const expectedGenesisManifestHash = genesis.slice();
    const pending = state.adapter.verify({ ...state.reference, expectedGenesisManifestHash });
    expectedGenesisManifestHash.fill(0);
    expect(await pending).not.toBeNull();
  });

  test("rejects cross-coordinate, cross-kind, and wrong access references", async () => {
    const state = await fixture("human");
    await state.adapter.complete(state.prepared);
    expect(state.adapter.verify({
      ...state.reference,
      coordinate: { ...coordinate, taskId: OTHER_TASK_ID },
    })).rejects.toThrow("reference is invalid");
    expect(state.adapter.verify({
      ...state.reference,
      objectType: "nautilo-task-run-result-v1",
    })).rejects.toThrow("reference is invalid");
    expect(state.adapter.verify({
      ...state.reference,
      expectedAccessRevision: 1,
    })).rejects.toBeInstanceOf(TaskContentCryptoCompletionConflictError);
  });

  test("rejects substituted Namespace authority and unavailable signer history", async () => {
    const state = await fixture("human");
    await state.adapter.complete(state.prepared);
    state.setCurrentAuthority({
      ...authority,
      namespaceId: "40000000-0000-4000-8000-000000000002",
    });
    expect(await state.adapter.verify(state.reference)).toBeNull();
    state.setCurrentAuthority(authority);
    state.setSignerHistoryAvailable(false);
    expect(state.adapter.verify(state.reference)).rejects.toThrow(
      "signer history is unavailable",
    );

    const agent = await fixture("agent");
    await agent.adapter.complete(agent.prepared);
    agent.setSignerHistoryAvailable(false);
    expect(agent.adapter.verify(agent.reference)).rejects.toThrow();
  });
});


test("historical completion binds source identity and the signed exact genesis across restart and rewrap", async () => {
  const state = await fixture("historical");
  expect(await state.adapter.complete(state.prepared)).toBe("created");
  expect(await state.adapter.complete(state.prepared)).toBe("duplicate");
  expect(await state.adapter.verify(state.reference)).toMatchObject({ objectId: state.prepared.objectId });
  const historical = state.reference.historicalRepair!;
  for (const patch of [
    { historicalRepair: undefined },
    { expectedGenesisManifestHash: undefined },
    { expectedGenesisManifestHash: new Uint8Array(32) },
    { historicalRepair: { ...historical, namespaceId: OTHER_TASK_ID } },
    { historicalRepair: { ...historical, provenance: { ...historical.provenance, sourceDigest: "00".repeat(32) } } },
    { historicalRepair: { ...historical, provenance: { ...historical.provenance, version: 1 } } },
  ]) {
    expect(state.adapter.verify({ ...state.reference, ...patch } as TaskContentCryptoRevisionReferenceV1)).rejects.toThrow();
  }
  state.rewrapHuman(3);
  expect(await state.adapter.verify({ ...state.reference, expectedAccessRevision: 1 }))
    .toMatchObject({ objectId: state.prepared.objectId });
  const forgedHash = "23".repeat(32);
  expect(state.adapter.verify({ ...state.reference, expectedAccessRevision: 1,
    expectedGenesisManifestHash: new Uint8Array(32).fill(0x23),
    historicalRepair: { ...historical, provenance: { ...historical.provenance, version: 2,
      genesisManifestHash: forgedHash } } })).rejects.toBeInstanceOf(TaskContentCryptoCompletionConflictError);
});


describe("foreground device-wrapped native Task completion", () => {
  test("generic Task current authority cannot substitute for the foreground verifier", async () => {
    const f = await fixture("foreground", false);
    await rejects(f.adapter.complete(f.prepared), /requires current foreground authorization/);
    expect(f.connection.state.object).toBeNull();
  });
  test("uses the foreground verifier and persists an exact new definition", async () => {
    const f = await fixture("foreground");
    expect(await f.adapter.complete(f.prepared)).toBe("created");
    expect(await f.adapter.complete(f.prepared)).toBe("duplicate");
    expect(await f.adapter.verify(f.reference)).not.toBeNull();
    f.denyForeground();
    await rejects(f.adapter.complete(f.prepared), /grant is stale/);
  });
  test("grant denial and post-write current policy loss roll back all crypto rows", async () => {
    for (const after of [false, true]) {
      const f = await fixture("foreground");
      if (after) f.changeAuthorityAfterForeground(); else f.denyForeground();
      await rejects(f.adapter.complete(f.prepared));
      expect(f.connection.state.object).toBeNull();
      expect(f.connection.state.head).toBeNull();
      expect(f.connection.state.manifests.size).toBe(0);
    }
  });
  test("current Namespace/Domain drift is rejected by the actual foreground storage fence", async () => {
    for (const field of ["domain_id", "namespace_access_revision", "state"]) {
      const f = await fixture("foreground");
      f.connection.namespaceHead = { ...f.connection.namespaceHead!, [field]: field === "namespace_access_revision" ? 3 : "changed" };
      await rejects(f.adapter.complete(f.prepared));
      expect(f.connection.state.object).toBeNull();
    }
  });
});
