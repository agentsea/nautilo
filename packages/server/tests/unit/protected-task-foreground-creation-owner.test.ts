import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { bindEncryptionDataOperationOwner } from "@nautilo/lattice-bridge";
import { LatticeCrypto, agentId, agentRuntimeGeneration } from "@nautilo/lattice-crypto";
import type { DomainKeyV2LiveShadowCurrentAuthority } from "@nautilo/lattice-bridge/server";
import { createAcceptedInvocationAuthority, type CanonicalTranscriptTx } from "@nautilo/trust";
import { createAgentTurnTaskCreationProvenance,
  createLiveShadowDataOperationPolicyBinding } from "@nautilo/runtime";
import { tasks, type PostgresJsBridgeConnection, type PostgresJsBridgeExecutor } from "@nautilo/db";
import { createProtectedTaskForegroundCreationOwner,
  type TaskDefinitionProductLoan } from "../../src/routes/protected-task-foreground-creation-owner";
import { readProtectedTaskForegroundCreationPolicy,
  withProtectedTaskForegroundCreationContext } from
  "../../src/routes/protected-task-foreground-creation-context";
import { createGrantedForegroundReadableNamespaceResolver } from
  "../../src/routes/live-shadow-message-composition";

test.each(["turn", "shared_execution", "shared_resume"] as const)("%s repair and creation revalidation nominate only the captured grant Namespace set", async source => {
  const namespaceIds = [
    "30000000-0000-4000-8000-000000000001",
    "30000000-0000-4000-8000-000000000002",
  ];
  const admittedNamespaces = [...namespaceIds];
  const sourceRoomId = source === "turn"
    ? "20000000-0000-4000-8000-000000000002"
    : "20000000-0000-4000-8000-000000000001";
  const resolve = createGrantedForegroundReadableNamespaceResolver({
    source,
    plan: {
      subjectHumanId: "10000000-0000-4000-8000-000000000001",
      roomId: "20000000-0000-4000-8000-000000000002",
      recipientAgentId: "40000000-0000-4000-8000-000000000001",
      namespaceId: namespaceIds[0]!,
    },
    grant: {
      subjectHumanId: "10000000-0000-4000-8000-000000000001",
      roomId: sourceRoomId,
      namespaceIds,
    },
  });

  const resolved = await resolve({
    humanActorId: "10000000-0000-4000-8000-000000000001",
    roomId: sourceRoomId,
    agentId: "40000000-0000-4000-8000-000000000001",
  });
  expect(resolved).toEqual(admittedNamespaces);
  // A second current-authority load in the held repair transaction must not
  // expand its lock set if the caller's original nominations change.
  namespaceIds.push("30000000-0000-4000-8000-000000000009");
  expect(await resolve({
    humanActorId: "10000000-0000-4000-8000-000000000001",
    roomId: sourceRoomId,
    agentId: "40000000-0000-4000-8000-000000000001",
  })).toBe(resolved);
  expect(resolved).toEqual(admittedNamespaces);
  expect(resolved).not.toBe(namespaceIds);
  expect(Object.isFrozen(resolved)).toBe(true);

  for (const coordinates of [
    {
      humanActorId: "10000000-0000-4000-8000-000000000009",
      roomId: sourceRoomId,
      agentId: "40000000-0000-4000-8000-000000000001",
    },
    {
      humanActorId: "10000000-0000-4000-8000-000000000001",
      roomId: source === "turn"
        ? "20000000-0000-4000-8000-000000000001"
        : "20000000-0000-4000-8000-000000000002",
      agentId: "40000000-0000-4000-8000-000000000001",
    },
    {
      humanActorId: "10000000-0000-4000-8000-000000000001",
      roomId: sourceRoomId,
      agentId: "40000000-0000-4000-8000-000000000009",
    },
  ]) {
    await Promise.resolve(expect(resolve(coordinates)).rejects.toThrow(
      "Foreground readable Namespace coordinates changed",
    ));
  }
});

test("Task creation rejects a foreground grant that omits its planned Namespace", () => {
  expect(() => createGrantedForegroundReadableNamespaceResolver({
    source: "shared_execution",
    plan: {
      subjectHumanId: "10000000-0000-4000-8000-000000000001",
      roomId: "20000000-0000-4000-8000-000000000002",
      recipientAgentId: "40000000-0000-4000-8000-000000000001",
      namespaceId: "30000000-0000-4000-8000-000000000001",
    },
    grant: {
      subjectHumanId: "10000000-0000-4000-8000-000000000001",
      roomId: "20000000-0000-4000-8000-000000000001",
      namespaceIds: ["30000000-0000-4000-8000-000000000002"],
    },
  })).toThrow("Foreground readable Namespace grant is inconsistent");
});

function fixture() {
  const events: string[] = [];
  const policyTimestamp = new Date(0);
  let policy = {
    mode: "encrypted_only",
    shadowBehavior: "strict",
    revision: 3,
    shadowEncryptionStartedAt: policyTimestamp,
    observationBoundsRevision: 1,
    observationBucketWidthMs: 60 * 60 * 1_000,
    observationRetentionMs: 30 * 24 * 60 * 60 * 1_000,
    observationStorageLimitRows: 10_000,
    observationLatencyUpperBoundsMs: [50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000],
    observationBoundsConfiguredAt: policyTimestamp,
    createdAt: policyTimestamp,
    updatedAt: policyTimestamp,
  };
  let policyAfterNextRead: Readonly<Pick<typeof policy, "mode" | "revision">> | null = null;
  let authorized = true;
  let borrowed: PostgresJsBridgeConnection | null = null;
  let originalProofs = 0;
  let taskCurrentProofs = 0;
  let borrowedEntityProofs = 0;
  const borrowedEntityContexts: unknown[] = [];
  const borrowedEntityDecision = Object.freeze({ marker: "borrowed-entity-decision" }) as unknown as
    Awaited<ReturnType<DomainKeyV2LiveShadowCurrentAuthority["resolveCurrentForegroundEntityObjectWrite"]>>;
  let probeCurrentProduct: (() => Promise<TaskDefinitionProductLoan | null>) | null = null;
  const taskProductLoans: Array<TaskDefinitionProductLoan | null> = [];
  const controller = new AbortController();
  const transaction = {
    execute: async () => {
      events.push(events.includes("policy-fence") ? "creation-identity-lock" : "policy-fence");
      return [];
    },
    select: () => ({ from: (table: unknown) => ({ where: () => {
      if (table === tasks) return { for: () => ({ limit: async () => { events.push("task-lock"); return []; } }) };
      const rows = Promise.resolve([{ ...policy }]);
      return Object.assign(rows, { limit: () => {
        if (policyAfterNextRead !== null) {
          policy = { ...policy, ...policyAfterNextRead };
          policyAfterNextRead = null;
        }
        return rows;
      } });
    } }) }),
  } as unknown as CanonicalTranscriptTx;
  const executor: PostgresJsBridgeExecutor = { query: async () => { events.push("borrowed-query"); return []; } };
  const authority: DomainKeyV2LiveShadowCurrentAuthority = {
    causalHumanUserId: "user", verifyCurrentPlan: async () => { events.push("current-proof"); return authorized; },
    resolveCurrentHumanAuthority: () => null, resolveCurrentForegroundAuthorization: async () => null,
    withCurrentRoomNamespaceKey: async () => null, resolveCurrentHumanObjectWrite: async () => null,
    resolveCurrentAgentObjectWrite: async () => null,
    resolveCurrentForegroundEntityObjectWrite: async context => {
      borrowedEntityProofs += 1;
      borrowedEntityContexts.push(context);
      return borrowedEntityDecision;
    },
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
    authorizeTaskDefinition: async input => {
      probeCurrentProduct = () => input.withCurrentProduct(current => Promise.resolve(current));
      taskProductLoans.push(await probeCurrentProduct());
      return input.use({
        authority: {
          authorityVersion: 1, kind: "requester_private_namespace", keyClass: "ai",
          requesterHumanId: "actor", namespaceId: "namespace", domainId: "domain",
          expectedAccessRevision: 1, expectedPolicyRevision: 3,
        },
        entities: { signal: controller.signal,
          use: async () => { throw new Error("No Task entity key expected"); },
          useCurrentSet: async () => { throw new Error("No Task entity key expected"); } },
        publication: { operationId: input.operationId, grantId: input.operationId,
          grantDigest: new Uint8Array(32), recipientKeyId: "task-recipient" },
        resolveCurrentForegroundDefinitionAuthorization: async () => null,
        assertCurrent: () => input.withCurrentProduct(async current => {
          taskCurrentProofs += 1;
          taskProductLoans.push(current);
        }),
      });
    },
    createCurrentAuthority: async product => { borrowed = product; events.push("borrow-authority"); return authority; },
  });
  return { ...owner, transaction, executor, controller, events,
    borrowed: () => borrowed, originalProofs: () => originalProofs,
    taskCurrentProofs: () => taskCurrentProofs,
    borrowedEntityProofs: () => borrowedEntityProofs,
    borrowedEntityContexts,
    borrowedEntityDecision,
    taskProductLoans,
    probeCurrentProduct: () => probeCurrentProduct,
    revoke: () => { authorized = false; },
    changePolicyAfterNextRead: (next: Readonly<Pick<typeof policy, "mode" | "revision">>) => {
      policyAfterNextRead = next;
    },
    setPolicy: (next: Readonly<Pick<typeof policy, "mode" | "revision">>) => { policy = { ...policy, ...next }; } };
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

test("the shared Task owner resolves and revalidates policy on the held product transaction", async () => {
  const f = fixture();
  let fallbackReads = 0;
  let releaseEscapedRead!: () => void;
  const escapedReadGate = new Promise<void>(resolve => { releaseEscapedRead = resolve; });
  let escapedRead: Promise<unknown> | null = null;
  const sharedOwner = bindEncryptionDataOperationOwner({
    policy: createLiveShadowDataOperationPolicyBinding(
      () => readProtectedTaskForegroundCreationPolicy(async () => {
        fallbackReads += 1;
        return { mode: "plaintext_only", shadowBehavior: "fallback", revision: 1 };
      }),
    ),
  });
  await withProtectedTaskForegroundCreationContext(f.context, async () => {
    await f.context.withProduct({
      taskId: "11111111-1111-4111-8111-111111111111",
      transaction: f.transaction,
      executor: f.executor,
      use: async () => {
        escapedRead = (async () => {
          await escapedReadGate;
          return readProtectedTaskForegroundCreationPolicy(async () => {
            fallbackReads += 1;
            return { mode: "plaintext_only", shadowBehavior: "fallback", revision: 1 };
          });
        })();
        void escapedRead.catch(() => undefined);
        f.changePolicyAfterNextRead({ mode: "encrypted_only", revision: 4 });
        await rejects(sharedOwner.runMutation({
          ordinary: () => Promise.reject(new Error("Unexpected ordinary policy")),
          dual: () => Promise.reject(new Error("Unexpected dual policy")),
          protected: () => Promise.reject(new Error("Policy drift reached publication")),
        }), /Protected Runtime policy changed/u);
      },
    });
    releaseEscapedRead();
    if (escapedRead === null) throw new Error("Missing escaped policy read");
    await rejects(escapedRead, /foreground authority is unavailable/u);
  });
  expect(fallbackReads).toBe(0);
  f.dispose();
});

test("Task definition revalidation borrows only the active product loan", async () => {
  const f = fixture();
  const entityContext = Object.freeze({ marker: "entity-context" }) as unknown as Parameters<
    TaskDefinitionProductLoan["resolveCurrentForegroundEntityObjectWrite"]
  >[0];
  await f.context.withTaskDefinitionAuthorization({
    taskId: "11111111-1111-4111-8111-111111111111",
    taskExecutorAgentId: "agent",
    operation: "create",
    targetContentRevision: 1,
    operationId: "task-operation",
    workDescriptorDigest: new Uint8Array(32),
    use: async () => {
      await f.context.withProduct({
        taskId: "11111111-1111-4111-8111-111111111111",
        transaction: f.transaction,
        executor: f.executor,
        use: async () => {
          await f.context.assertCurrent();
          const probe = f.probeCurrentProduct();
          if (probe === null) throw new Error("Missing Task product loan probe");
          const loan = await probe();
          if (loan === null) throw new Error("Missing active Task product loan");
          await loan.assertCurrent();
          expect(await loan.resolveCurrentForegroundEntityObjectWrite(entityContext))
            .toBe(f.borrowedEntityDecision);
        },
      });
      await f.context.assertCurrent();
    },
  });

  const probe = f.probeCurrentProduct();
  if (probe === null) throw new Error("Missing Task product loan probe");
  expect(await probe()).toBeNull();
  expect(f.taskCurrentProofs()).toBe(2);
  expect(f.taskProductLoans).toHaveLength(3);
  expect(f.taskProductLoans[0]).toBeNull();
  const retained = f.taskProductLoans[1];
  const borrowed = f.borrowed();
  if (retained === undefined || retained === null || borrowed === null) {
    throw new Error("Missing Task product loan");
  }
  expect(retained.transaction).toBe(f.transaction);
  expect(retained.product).toBe(borrowed);
  expect(f.borrowedEntityProofs()).toBe(1);
  expect(f.borrowedEntityContexts).toEqual([entityContext]);
  expect(f.taskProductLoans[2]).toBeNull();
  await rejects(retained.product.transactionOnce(() => Promise.resolve(true)),
    /foreground authority is unavailable/u);
  await rejects(retained.assertCurrent(), /foreground authority is unavailable/u);
  await rejects(async () => await retained.resolveCurrentForegroundEntityObjectWrite(entityContext),
    /foreground authority is unavailable/u);
  expect(f.borrowedEntityProofs()).toBe(1);
  f.dispose();
  await rejects(probe(), /foreground authority is unavailable/u);
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


test("Claude shape admission cannot escape the held foreground identity or substitute requester, Agent or calling Room", async () => {
  for (const patch of [{ requestorId: "other-user" }, { agentId: "other-agent" }, { callingRoomId: "other-room" }]) {
    const f = fixture();
    const candidate = { ownerId: "user", requestorId: "user", agentId: "agent", callingRoomId: "room", prompt: "private", ...patch,
      metadata: { execution: { version: 1, harnessId: "claude-code", source: "genie", profileRef: "profile", catalogModelId: "catalog", selectedModel: "model" } } };
    const request = { db: {} as Parameters<typeof f.context.admission.admit>[0]["db"], candidate,
      provenance: createAgentTurnTaskCreationProvenance({ ownerId: "user", invocation: { ownerId: "user", roomId: "room", entrypoint: "foreground.main" } }),
      invocationAuthority: createAcceptedInvocationAuthority(candidate.requestorId) };
    await rejects(f.context.admission.admit(request), /foreground authority is unavailable/u);
    await rejects(f.context.withProduct({ taskId: "11111111-1111-4111-8111-111111111111", transaction: f.transaction, executor: f.executor,
      use: () => f.context.admission.admit(request) }), /foreground authority is unavailable/u);
    expect(f.events).not.toContain("borrowed-query");
    f.dispose();
  }
});

for (const execution of [
  { version: 1, harnessId: "codex", source: "genie", collaborationMode: "work", harnessModelId: "model",
    readiness: { relayId: "relay", pairingGenerationRef: "pairing", capabilityRevision: 4 }, workingDirectory: "/private/workspace" },
  { version: 1, harnessId: "hermes-acp", source: "genie", readiness: { relayId: "relay", relaySessionId: "socket",
    pairingGenerationRef: "pairing", desktopSessionId: "desktop", selectedProtocolVersion: 14, capabilityRevision: 4 } },
  { version: 1, harnessId: "opencode-acp", source: "genie", executionProfile: "autonomous", readiness: {
    relayId: "relay", relaySessionId: "socket", pairingGenerationRef: "pairing", desktopSessionId: "desktop",
    selectedProtocolVersion: 15, capabilityRevision: 4 } },
]) test(`${execution.harnessId} shape cannot substitute foreground ownership or calling Room`, async () => {
  for (const patch of [{ requestorId: "other-user" }, { ownerId: "other-user" }, { agentId: "other-agent" }, { callingRoomId: "other-room" }]) {
    const f = fixture();
    const candidate = { ownerId: "user", requestorId: "user", agentId: "agent", callingRoomId: "room", prompt: "private",
      metadata: { execution }, ...patch };
    const request = { db: {} as Parameters<typeof f.context.admission.admit>[0]["db"], candidate,
      provenance: createAgentTurnTaskCreationProvenance({ ownerId: "user", invocation: { ownerId: "user", roomId: "room", entrypoint: "foreground.main" } }),
      invocationAuthority: createAcceptedInvocationAuthority(candidate.requestorId) };
    const refusal = "ownerId" in patch ? /server-authored provenance/u : /foreground authority is unavailable/u;
    await rejects(f.context.admission.admit(request), refusal);
    await rejects(f.context.withProduct({ taskId: "11111111-1111-4111-8111-111111111111", transaction: f.transaction, executor: f.executor,
      use: () => f.context.admission.admit(request) }), refusal);
    expect(f.events).not.toContain("borrowed-query"); f.dispose();
  }
});
