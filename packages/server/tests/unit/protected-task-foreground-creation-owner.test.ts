import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { bindEncryptionDataOperationOwner } from "@nautilo/lattice-bridge";
import { LatticeCrypto, agentId, agentRuntimeGeneration } from "@nautilo/lattice-crypto";
import type { DomainKeyV2LiveShadowCurrentAuthority } from "@nautilo/lattice-bridge/server";
import type { CanonicalTranscriptTx } from "@nautilo/trust";
import { tasks, type PostgresJsBridgeConnection, type PostgresJsBridgeExecutor } from "@nautilo/db";
import { createProtectedTaskForegroundCreationOwner } from "../../src/routes/protected-task-foreground-creation-owner";

function fixture() {
  const events: string[] = [];
  let policy = { mode: "encrypted_only", revision: 3 };
  let authorized = true;
  let borrowed: PostgresJsBridgeConnection | null = null;
  let originalProofs = 0;
  const controller = new AbortController();
  const transaction = {
    execute: async () => {
      events.push(events.includes("policy-fence") ? "creation-identity-lock" : "policy-fence");
      return [];
    },
    select: () => ({ from: (table: unknown) => ({ where: () => table === tasks
      ? { for: () => ({ limit: async () => { events.push("task-lock"); return []; } }) }
      : Promise.resolve([{ ...policy }]) }) }),
  } as unknown as CanonicalTranscriptTx;
  const executor: PostgresJsBridgeExecutor = { query: async () => { events.push("borrowed-query"); return []; } };
  const authority: DomainKeyV2LiveShadowCurrentAuthority = {
    causalHumanUserId: "user", verifyCurrentPlan: async () => { events.push("current-proof"); return authorized; },
    resolveCurrentHumanAuthority: () => null, resolveCurrentForegroundAuthorization: async () => null,
    withCurrentRoomNamespaceKey: async () => null, resolveCurrentHumanObjectWrite: async () => null,
    resolveCurrentAgentObjectWrite: async () => null, resolveCurrentForegroundEntityObjectWrite: async () => null,
    signingPublicKey: () => null, destroy: () => { events.push("destroy"); },
  };
  const restricted: PostgresJsBridgeConnection = {
    query: () => { throw new Error("No crypto query expected in a product-lifetime test"); },
    transaction: () => { throw new Error("No crypto transaction expected in a product-lifetime test"); },
    transactionOnce: () => { throw new Error("No crypto transaction expected in a product-lifetime test"); },
  };
  const owner = createProtectedTaskForegroundCreationOwner({
    crypto: new LatticeCrypto(), owner: bindEncryptionDataOperationOwner({ policy: {
      resolve: async () => ({ policy: { mode: "encrypted_only", shadowBehavior: "strict" }, revalidationToken: 3 }),
      revalidate: async () => {},
    } }), restricted, serverScope: "server", representation: "protected",
    subject: { userId: "user", humanId: "actor", agentId: "agent", roomId: "room", namespaceIds: ["namespace"], policyRevision: 3 },
    publication: { operationId: "foreground", grantId: "grant", grantDigest: new Uint8Array(32), recipientKeyId: "recipient",
      runtime: { agentId: agentId("agent"), generation: agentRuntimeGeneration(1), keyClass: "runtime", key: new Uint8Array(32) },
      signerKeyId: "signer", signerPublicKey: new Uint8Array(32), policyRevision: 3, agentAuthorizationRevision: 1 },
    entities: { signal: controller.signal, use: async () => { throw new Error("No entity key expected"); },
      useCurrentSet: async () => { throw new Error("No entity key expected"); } },
    assertCurrentForeground: async () => { originalProofs += 1; },
    createCurrentAuthority: async product => { borrowed = product; events.push("borrow-authority"); return authority; },
  });
  return { ...owner, transaction, executor, controller, events,
    borrowed: () => borrowed, originalProofs: () => originalProofs,
    revoke: () => { authorized = false; }, setPolicy: (next: typeof policy) => { policy = next; } };
}

test("creation loans fence policy before Room proof and use only the existing executor through return binding", async () => {
  const f = fixture();
  await f.context.assertCurrent();
  await f.context.withProduct({ taskId: "11111111-1111-4111-8111-111111111111", transaction: f.transaction, executor: f.executor, use: async () => {
    await f.context.assertCurrent();
    const borrowed = f.borrowed();
    if (borrowed === null) throw new Error("Missing borrowed authority");
    await borrowed.transactionOnce(tx => tx.query("SELECT 1"));
    f.events.push("return-binding");
  } });
  expect(f.originalProofs()).toBe(1);
  expect(f.events.slice(0, 4)).toEqual(["policy-fence", "creation-identity-lock", "task-lock", "borrow-authority"]);
  expect(f.events.indexOf("return-binding")).toBeLessThan(f.events.lastIndexOf("current-proof"));
  expect(f.events.at(-1)).toBe("destroy");
  await rejects(f.borrowed()!.query("SELECT 1"), /foreground authority is unavailable/u);
  f.dispose();
});

test("policy drift prevents even opening foreground product authority", async () => {
  const f = fixture();
  f.setPolicy({ mode: "plaintext_only", revision: 4 });
  await rejects(f.context.withProduct({ taskId: "11111111-1111-4111-8111-111111111111", transaction: f.transaction, executor: f.executor,
    use: () => Promise.reject(new Error("Unexpected work")) }), /revision 3 is stale/u);
  expect(f.events).toEqual(["policy-fence"]);
  f.dispose();
});

test("revocation before return makes the existing outer transaction fail without a second authority transaction", async () => {
  const f = fixture();
  await rejects(f.context.withProduct({ taskId: "11111111-1111-4111-8111-111111111111", transaction: f.transaction, executor: f.executor,
    use: async () => { f.revoke(); return "created"; } }), /foreground authority is unavailable/u);
  expect(f.events.at(-1)).toBe("destroy");
  expect(f.originalProofs()).toBe(0);
  f.dispose();
});

test("nested creation and retained disposed ports have no product custody", async () => {
  const f = fixture();
  await f.context.withProduct({ taskId: "11111111-1111-4111-8111-111111111111", transaction: f.transaction, executor: f.executor, use: async () => {
    await rejects(f.context.withProduct({ taskId: "11111111-1111-4111-8111-111111111111", transaction: f.transaction, executor: f.executor,
      use: async () => {} }), /cannot nest/u);
  } });
  f.dispose();
  await rejects(f.context.assertCurrent(), /foreground authority is unavailable/u);
});
