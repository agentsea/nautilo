import { describe, expect, test } from "bun:test";
import type { DirectDatabase, PostgresJsBridgeConnection } from "@nautilo/db";
import { deriveMessageCryptoObjectIdV2, type EncryptionDataOperationOwner } from "@nautilo/lattice-bridge";
import { verifyCryptoPostgresHandle, type PostgresConversationProductStore,
  type VerifiedStagedTaskTerminalMessagePublication } from "@nautilo/lattice-bridge/server";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import type { CanonicalTranscriptTx } from "@nautilo/trust";
import { createProtectedTaskTerminalMessageRecovery,
  type ProtectedTaskTerminalMessageRecoveryDependencies,
  type TerminalMessageRecoverySettlementInput } from "../../src/routes/protected-task-terminal-message-recovery";
import type { ProtectedTaskTerminalMessageIntent } from "../../src/routes/protected-task-terminal-message-product";
import type { ProtectedTaskTerminalMessagePlan } from "../../src/routes/protected-task-terminal-message-plan";

const uuid = (part: string) => `${part.repeat(8)}-${part.repeat(4)}-4${part.repeat(3)}-8${part.repeat(3)}-${part.repeat(12)}`;
const TASK = uuid("1"), RUN = uuid("2"), USER = uuid("3"), ROOM = uuid("4"), NS = uuid("5"), SESSION = uuid("6");
const intent: ProtectedTaskTerminalMessageIntent = {
  taskId: TASK, taskRunId: RUN, requesterUserId: USER, agentId: "agent", contentNamespaceId: uuid("7"),
  representation: "protected", bindingId: `task-run-output:${RUN}`,
  resultObjectId: "cancelled-result", resultRevision: 2, acceptedPolicyRevision: 7,
  terminalAt: new Date(10), attachedAt: new Date(20), destinationRoomId: ROOM,
  destinationNamespaceId: NS, messageOperationId: `task-run-delivery-message:${RUN}`,
};
const allocation = { sessionId: SESSION, messageId: 17, revision: 0 as const,
  objectId: deriveMessageCryptoObjectIdV2({ sessionId: SESSION, messageId: 17, revision: 0 }),
  createdAt: 30, publicationPolicyRevision: 7 as number | null };

async function fixture(settlement?: "success" | "false" | "throw" | "tamper") {
  let held = false;
  const mutations: string[] = [];
  const events: string[] = [];
  const settlements: TerminalMessageRecoverySettlementInput[] = [];
  const state = { deny: false, destinationDenied: false, failCommit: false, missing: false,
    bare: false, forged: false, tamper: false, mapped: false, rejectReceipt: false,
    requestMissing: false, retainedPolicy: 7 as number | null, cleanupCount: 0, policy: 8, mode: "encrypted_only", representation: "protected" as "protected" | "dual" };
  const tx = {} as CanonicalTranscriptTx;
  const connection = {
    query: async () => [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }],
    transaction: async (use: (connection: unknown) => Promise<unknown>) => use(connection),
  };
  const handle = await verifyCryptoPostgresHandle(connection as never);
  const scoped = connection as unknown as PostgresJsBridgeConnection;
  const db = { transaction: async (use: (transaction: CanonicalTranscriptTx) => Promise<unknown>) => use(tx) } as unknown as DirectDatabase;
  const owner = { runMutation: async (operation: { protected(): Promise<unknown>; dual(): Promise<unknown> }) => {
    if (state.mode === "plaintext_only") throw new Error("Plain unsupported");
    return state.representation === "dual" ? operation.dual() : operation.protected();
  } } as EncryptionDataOperationOwner;
  const currentIntent = () => ({ ...intent, representation: state.representation });
  let inspections = 0;
  const tokens = new WeakSet<object>();
  const snapshots = new WeakMap<object, string>();
  const dependencies: Partial<ProtectedTaskTerminalMessageRecoveryDependencies> = {
    readIntent: async () => currentIntent(),
    readPolicy: async () => ({ revision: state.policy, mode: state.mode } as never),
    resolveHuman: async () => ({ id: uuid("8") } as never),
    resolveRoom: async () => ({ roomId: uuid("9"), namespaceId: intent.contentNamespaceId }),
    productContext: async () => ({ canonicalRunner: {}, handle: {} } as never),
    withAuthority: async input => {
      if (state.deny) return null;
      const before = mutations.length;
      held = true;
      try {
        expect(await input.validateCurrentTaskRun(scoped, tx, {} as never)).toBe(true);
        const value = await input.use({ sourceRoomId: ROOM, sourceNamespaceId: intent.contentNamespaceId,
          facts: [{ namespaceId: NS, domainId: "domain", expectedAccessRevision: 4,
            expectedPolicyRevision: state.policy, expectedDomainEpoch: 2, expectedAuthorizationRevision: 3 }] }, scoped, tx, scoped);
        if (state.failCommit) throw new Error("Commit failed");
        return value;
      } catch (error) { mutations.splice(before); throw error; }
      finally { held = false; }
    },
    resolveDestination: async () => {
      expect(held).toBe(true);
      return state.destinationDenied ? null : { sessionId: SESSION, sessionOwnerId: USER, graphThreadId: "thread" };
    },
    readAllocation: async () => {
      expect(held).toBe(true);
      return { ...allocation, publicationPolicyRevision: state.representation === "dual" ? null : 7 };
    },
    readRequest: async () => {
      expect(held).toBe(true);
      return state.requestMissing ? null : { requestId: `task-run-delivery-message-authorization:${RUN}`,
        workId: RUN, kind: "task.deliver_message", purpose: "task.deliver_message", namespaceId: NS,
        domainId: "domain", policyRevision: 7, accessRevision: 4 };
    },
    readStagedPolicy: async (_handle, coordinates) => {
      expect(held).toBe(true);
      expect(coordinates).toEqual({ requestId: `task-run-delivery-message-authorization:${RUN}`,
        objectId: allocation.objectId, acceptedPolicyRevision: 7 });
      return state.retainedPolicy;
    },
    cryptoHandle: async () => { expect(held).toBe(true); return handle; },
    inspect: async input => {
      expect(held).toBe(true);
      expect(input.intent.publicationPolicyRevision).toBe(7);
      expect(input.currentAuthority.currentPolicyRevision).toBe(8);
      inspections += 1;
      events.push("inspect");
      if (state.missing) return null;
      const token = Object.freeze({ intent: input.intent, requestId: input.intent.requestId,
        recipientGeneration: 1, claimId: "expired-claim", authorizationDigest: new Uint8Array(32).fill(1),
        genesisManifestHash: new Uint8Array(32).fill(state.tamper && inspections > 2 ? 9 : 2),
        authorityFingerprint: new Uint8Array(32).fill(3) }) as VerifiedStagedTaskTerminalMessagePublication;
      if (!state.forged) { tokens.add(token); snapshots.set(token, JSON.stringify(token)); }
      return token;
    },
    assertStaged: token => {
      expect(held).toBe(true);
      if (!tokens.has(token) || snapshots.get(token) !== JSON.stringify(token)) throw new Error("Forged token");
    },
    hasPublication: async () => !state.missing || state.bare,
    mappedAssociation: async () => { expect(held).toBe(true); return state.mapped; },
    withStore: async input => {
      expect(held).toBe(true);
      expect(input.transaction).toBe(tx);
      expect(input.publicationPolicyRevision).toBe(7);
      events.push("store");
      const mutate = async (kind: string, value: { publicationPolicy?: { expectedRevision: number } | undefined }) => {
        expect(held).toBe(true);
        expect(value.publicationPolicy?.expectedRevision).toBe(8);
        mutations.push(kind);
        return "applied" as const;
      };
      return input.use({ markCryptoComplete: value => mutate("complete", value),
        compareAndSwapCryptoMapping: async value => {
          const result = await mutate("map", value);
          mutations.push("association");
          return result;
        } } as PostgresConversationProductStore);
    },
    recordPublished: async (borrowed, input) => {
      expect(held).toBe(true);
      expect(input.messageId).toBe(17);
      await borrowed.transaction(async borrowedTx => { expect(borrowedTx).toBe(tx); });
      mutations.push("receipt");
      if (state.rejectReceipt) throw new Error("Receipt failed");
      return { status: "recorded", binding: {} } as never;
    },
  };
  const recovery = createProtectedTaskTerminalMessageRecovery({ db, restricted: scoped,
    crypto: new LatticeCrypto(), owner, serverScope: "test", now: () => 100, dependencies,
    ...(settlement === undefined ? {} : { settle: async (input: TerminalMessageRecoverySettlementInput) => {
      expect(held).toBe(true);
      expect(mutations.at(-1)).toBe("receipt");
      expect(input.transaction).toBe(tx);
      expect(input.restricted).toBe(scoped);
      expect(input.requesterHumanId).toBe(uuid("8"));
      expect(input.proof.intent.publicationPolicyRevision).toBe(7);
      expect(input.currentAuthority.currentPolicyRevision).toBe(8);
      dependencies.assertStaged!(input.proof, input.currentAuthority);
      settlements.push(input);
      mutations.push("settle");
      input.deferRecipientCleanup(() => {
        expect(held).toBe(false);
        state.cleanupCount += 1;
      });
      if (settlement === "throw") throw new Error("Settlement failed");
      if (settlement === "tamper") input.proof.genesisManifestHash.fill(9);
      return settlement !== "false";
    } }),
  });
  return { state, recovery, mutations, events, dependencies, db, scoped, owner, handle, settlements };
}

describe("terminal Task Message receipt recovery", () => {
  test.each(["protected", "dual"] as const)("maps retained %s bytes at newer compatible policy atomically", async representation => {
    const value = await fixture();
    value.state.representation = representation;
    if (representation === "dual") value.state.mode = "shadow_encryption";
    expect(await value.recovery.recoverCoordinates(intent)).toBe("mapped");
    expect(value.mutations).toEqual(["complete", "map", "association", "receipt"]);
    expect(allocation.publicationPolicyRevision).toBe(7);
    expect(value.events.filter(event => event === "inspect").length).toBeGreaterThan(2);
  });
  test("completed mapped replay verifies receipt without active product mutation guard", async () => {
    const value = await fixture(); value.state.mapped = true;
    expect(await value.recovery.recoverCoordinates(intent)).toBe("mapped");
    expect(value.events).not.toContain("store");
    expect(value.mutations).toEqual(["receipt"]);
  });
  test.each(["deny", "destinationDenied", "forged", "tamper"] as const)("%s never publishes", async field => {
    const value = await fixture(); value.state[field] = true;
    expect(await value.recovery.recoverCoordinates(intent)).not.toBe("mapped");
    expect(value.mutations).toEqual([]);
  });
  test.each(["failCommit", "rejectReceipt"] as const)("%s rolls back mapping and association", async field => {
    const value = await fixture(); value.state[field] = true;
    expect(await value.recovery.recoverCoordinates(intent)).toBe("pending");
    expect(value.mutations).toEqual([]);
  });
  test("real bridge brand check refuses a structural token before product effects", async () => {
    const value = await fixture();
    const { assertStaged: _assertStaged, ...dependencies } = value.dependencies;
    const recovery = createProtectedTaskTerminalMessageRecovery({ db: value.db,
      restricted: value.scoped, crypto: new LatticeCrypto(), owner: value.owner,
      serverScope: "test", now: () => 100, dependencies });
    expect(await recovery.recoverCoordinates(intent)).toBe("pending");
    expect(value.events).not.toContain("store");
    expect(value.mutations).toEqual([]);
  });
  test("receipt substitution after completion rolls its product mutation back", async () => {
    const value = await fixture(); value.state.tamper = true;
    expect(await value.recovery.recoverCoordinates(intent)).toBe("quarantined");
    expect(value.events).toContain("store");
    expect(value.mutations).toEqual([]);
  });
  test("missing ciphertext permits preparation while bare bytes are quarantined", async () => {
    const value = await fixture(); value.state.missing = true;
    expect(await value.recovery.recoverCoordinates(intent)).toBe("missing");
    value.state.bare = true;
    expect(await value.recovery.recoverCoordinates(intent)).toBe("quarantined");
    expect(value.mutations).toEqual([]);
  });
  test("Shadow and Full recover retained bytes after the request is pruned", async () => {
    const value = await fixture(); value.state.requestMissing = true;
    expect(await value.recovery.recoverCoordinates(intent)).toBe("mapped");
    value.mutations.splice(0); value.state.representation = "dual"; value.state.mode = "shadow_encryption";
    expect(await value.recovery.recoverCoordinates(intent)).toBe("mapped");
    expect(value.mutations).toEqual(["complete", "map", "association", "receipt"]);
    value.mutations.splice(0); value.state.retainedPolicy = null;
    expect(await value.recovery.recoverCoordinates(intent)).toBe("pending");
    expect(value.mutations).toEqual([]);
    value.state.missing = true;
    expect(await value.recovery.recoverCoordinates(intent)).toBe("missing");
  });
  test("conflicting retained receipt policy cannot map even with a live request", async () => {
    const value = await fixture(); value.state.retainedPolicy = 8;
    expect(await value.recovery.recoverCoordinates(intent)).toBe("quarantined");
    expect(value.mutations).toEqual([]);
  });
  test.each(["plaintext_only", "shadow_encryption"])("incompatible %s waits without mutations", async mode => {
    const value = await fixture(); value.state.mode = mode;
    expect(await value.recovery.recoverCoordinates(intent)).toBe("pending");
    expect(value.mutations).toEqual([]);
  });
  test("publisher port ignores supplied grant details and returns pending for unavailable recovery", async () => {
    const value = await fixture(); value.state.deny = true;
    expect(await value.recovery.recover({ intent } as ProtectedTaskTerminalMessagePlan)).toBe("pending");
  });
  test.each([false, true])("observer settles mapped replay=%s under authority and cleans up after commit", async mapped => {
    const value = await fixture("success"); value.state.mapped = mapped;
    expect(await value.recovery.recoverCoordinates(intent)).toBe("mapped");
    expect(value.settlements).toHaveLength(1);
    expect(value.mutations).toEqual(mapped ? ["receipt", "settle"]
      : ["complete", "map", "association", "receipt", "settle"]);
    expect(value.state.cleanupCount).toBe(1);
    expect(() => value.settlements[0]!.deferRecipientCleanup(() => undefined)).toThrow("closed");
  });
  test("active publisher recovery leaves its live claim settlement to the caller", async () => {
    const value = await fixture("success");
    expect(await value.recovery.recover({ intent } as ProtectedTaskTerminalMessagePlan)).toBe("mapped");
    expect(value.settlements).toEqual([]);
    expect(value.state.cleanupCount).toBe(0);
    expect(value.mutations).toEqual(["complete", "map", "association", "receipt"]);
  });
  test.each(["false", "throw", "tamper"] as const)("settlement %s rolls back and never cleans custody", async failure => {
    const value = await fixture(failure);
    expect(await value.recovery.recoverCoordinates(intent)).toBe("pending");
    expect(value.settlements).toHaveLength(1);
    expect(value.mutations).toEqual([]);
    expect(value.state.cleanupCount).toBe(0);
  });
  test("outer commit failure preserves recipient custody after successful settlement", async () => {
    const value = await fixture("success"); value.state.failCommit = true;
    expect(await value.recovery.recoverCoordinates(intent)).toBe("pending");
    expect(value.settlements).toHaveLength(1);
    expect(value.mutations).toEqual([]);
    expect(value.state.cleanupCount).toBe(0);
  });
});
