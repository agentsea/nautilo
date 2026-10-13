import { randomUUID } from "node:crypto";
import { rejects } from "node:assert/strict";

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  agentScopes,
  and,
  createDirectDb,
  cryptoObjects,
  encryptionTransitionPolicy,
  foregroundMemoryCryptoPublicationReceipts,
  humanCryptoDevices,
  humanCryptoDeviceAdmissions,
  humanCryptoDeviceAdmissionChallenges,
  eq,
  getSharedDirectDb,
  inArray,
  objectCryptoAccessHeads,
  objectCryptoAccessManifests,
  objectCryptoNamespaceEnvelopes,
  sql,
  taskCancellationCryptoStagingReceipts,
  taskDefinitionCryptoRevisions,
  taskHistoricalContentCryptoStagingReceipts,
  taskTerminalMessageCryptoStagingReceipts,
  tasks,
  type DirectDatabase,
} from "@nautilo/db";
import { assertFixtureDbMutationAllowed } from "@nautilo/db/testing";
import {
  bindEncryptionDataOperationOwner,
  createDeviceAdmissionProof,
  deriveTaskContentCryptoObjectIdV1,
} from "@nautilo/lattice-bridge";
import {
  createDomainCompressedLiveShadowSessionCapability,
  PostgresDeviceAdmissionRepository,
  verifyCryptoPostgresHandle,
  type LiveShadowForegroundAuthorizationScope,
} from "@nautilo/lattice-bridge/server";
import {
  deriveAgentRuntimeObjectSignerPublic,
  accessRevision,
  authorizationRevision,
  createCommonHumanObjectAccessManifest,
  cryptoDeviceId,
  humanId,
  objectId as cryptoObjectId,
  withOpenedDomainForegroundAuthorization,
} from "@nautilo/lattice-crypto";
import {
  destroyDomainForegroundAuthorizationPlanV2,
  parseDomainForegroundAuthorizationPlanV2,
} from "@nautilo/lattice-crypto/wire";
import {
  createAgentTurnTaskCreationProvenance,
  createTask,
  type ProtectedTaskCreationPlanV1,
  type TaskCreateInput,
} from "@nautilo/runtime";
import { createAcceptedInvocationAuthority } from "@nautilo/trust";
import {
  closeVisibilityGrantFixtureConnections,
  createVisibilityGrantCurrentAuthority,
  createVisibilityGrantFixture,
  destroyVisibilityGrant,
  destroyVisibilityGrantFixture,
  inspectVisibilityGrantDomains,
  mintReusableVisibilityGrant,
  planWithReusableVisibilityGrantAndRuntime,
  type PublicRoomGrantVisibilityFixture,
} from "../../../lattice-bridge/tests/fixtures/public-room-grant-visibility.ts";
import {
  createForegroundAgentEntityCryptoGateway,
} from "../../src/routes/foreground-agent-entity-crypto-gateway.ts";
import {
  createForegroundProductTransactionContext,
} from "../../src/routes/foreground-message-product-store.ts";
import {
  withProtectedTaskForegroundCreationContext,
} from "../../src/routes/protected-task-foreground-creation-context.ts";
import {
  protectedTaskForegroundCreationIdentity,
  protectedTaskForegroundCreationCandidateIdentity,
} from "../../src/routes/protected-task-foreground-creation-identity.ts";
import {
  createProtectedTaskForegroundCreationOwner,
} from "../../src/routes/protected-task-foreground-creation-owner.ts";
import {
  LiveShadowForegroundAuthorizationSessions,
} from "../../src/routes/live-shadow-foreground-authorization-sessions.ts";

import { createProductionProtectedTaskComposition } from "../../src/routes/task-protected-composition.ts";

afterAll(closeVisibilityGrantFixtureConnections);
beforeEach(() => {
  assertExactCleanupTarget();
});

const PRODUCT_ROLLBACK = new Error("synthetic foreground product rollback");

type PolicyMode = "encrypted_only" | "shadow_encryption";

function copyBytes(value: Uint8Array): Uint8Array {
  return Uint8Array.from(value);
}

function assertExactCleanupTarget(): void {
  const instance = process.env["NAUTILO_PROTECTED_TASK_QA_INSTANCE"];
  const port = process.env["NAUTILO_PROTECTED_TASK_QA_POSTGRES_PORT"];
  if (
    !instance
    || !/^qa-[a-z0-9-]+$/.test(instance)
    || process.env["NAUTILO_INSTANCE_ID"] !== instance
    || !port
  ) {
    throw new Error(
      "Foreground Task cleanup requires an explicitly bound disposable QA instance and port",
    );
  }
  assertFixtureDbMutationAllowed();
  for (const [name, role] of [
    ["LATTICE_BRIDGE_TEST_ADMIN_DATABASE_URL", null],
    ["LATTICE_BRIDGE_TEST_APP_DATABASE_URL", "nautilo"],
    ["LATTICE_BRIDGE_TEST_DATABASE_URL", "nautilo_crypto"],
  ] as const) {
    const value = process.env[name];
    if (!value) throw new Error(`Foreground Task cleanup requires ${name}`);
    const url = new URL(value);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol)
      || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)
      || url.port !== port
      || url.pathname !== "/nautilo"
      || !url.username
      || !url.password
      || (role !== null && url.username !== role)
    ) {
      throw new Error(
        "Foreground Task cleanup requires the exact local QA role connections",
      );
    }
  }
}

async function deleteForegroundTaskFixtureGraph(
  database: DirectDatabase,
  input: Readonly<{
    taskId: string | null;
    scopeId: string | null;
    cryptoObjectId: string | null;
    deviceId: string;
  }>,
): Promise<void> {
  assertExactCleanupTarget();
  await database.transaction(async tx => {
    if (input.taskId !== null) {
      await tx.delete(tasks).where(eq(tasks.id, input.taskId));
      await tx.delete(taskDefinitionCryptoRevisions).where(eq(
        taskDefinitionCryptoRevisions.taskId,
        input.taskId,
      ));
    }
    if (input.scopeId !== null) {
      await tx.delete(agentScopes).where(eq(agentScopes.id, input.scopeId));
    }
    if (input.cryptoObjectId !== null) {
      const objectIds = [input.cryptoObjectId];
      await tx.select({ objectId: cryptoObjects.objectId }).from(cryptoObjects)
        .where(inArray(cryptoObjects.objectId, objectIds)).for("update");
      const children = await tx.select({
        operationId: foregroundMemoryCryptoPublicationReceipts.operationId,
      }).from(foregroundMemoryCryptoPublicationReceipts).where(inArray(
        foregroundMemoryCryptoPublicationReceipts.cryptoObjectId,
        objectIds,
      )).limit(1);
      if (children.length !== 0) {
        throw new Error("Foreground Task fixture receipt cleanup is incomplete");
      }
      const cancellationChildren = await tx.select({
        requestId: taskCancellationCryptoStagingReceipts.requestId,
      }).from(taskCancellationCryptoStagingReceipts).where(inArray(
        taskCancellationCryptoStagingReceipts.cryptoObjectId,
        objectIds,
      )).limit(1);
      const terminalMessageChildren = await tx.select({
        requestId: taskTerminalMessageCryptoStagingReceipts.requestId,
      }).from(taskTerminalMessageCryptoStagingReceipts).where(inArray(
        taskTerminalMessageCryptoStagingReceipts.cryptoObjectId,
        objectIds,
      )).limit(1);
      const historicalChildren = await tx.select({
        operationId: taskHistoricalContentCryptoStagingReceipts.operationId,
      }).from(taskHistoricalContentCryptoStagingReceipts).where(inArray(
        taskHistoricalContentCryptoStagingReceipts.cryptoObjectId,
        objectIds,
      )).limit(1);
      if (
        cancellationChildren.length !== 0
        || terminalMessageChildren.length !== 0
        || historicalChildren.length !== 0
      ) {
        throw new Error("Foreground Task fixture staging cleanup is incomplete");
      }
      const [original] = await tx.execute<{
        parent_owner: string;
        cancellation_delete: boolean;
        cancellation_select: boolean;
        terminal_delete: boolean;
        terminal_select: boolean;
        historical_delete: boolean;
        historical_select: boolean;
        foreground_delete: boolean;
        foreground_select: boolean;
      }>(sql`
        select pg_get_userbyid(relowner) as parent_owner,
          has_table_privilege('nautilo', 'public.task_cancellation_crypto_staging_receipts', 'DELETE') as cancellation_delete,
          has_table_privilege('nautilo', 'public.task_cancellation_crypto_staging_receipts', 'SELECT') as cancellation_select,
          has_table_privilege('nautilo', 'public.task_terminal_message_crypto_staging_receipts', 'DELETE') as terminal_delete,
          has_table_privilege('nautilo', 'public.task_terminal_message_crypto_staging_receipts', 'SELECT') as terminal_select,
          has_table_privilege('nautilo', 'public.task_historical_content_crypto_staging_receipts', 'DELETE') as historical_delete,
          has_table_privilege('nautilo', 'public.task_historical_content_crypto_staging_receipts', 'SELECT') as historical_select,
          has_table_privilege('nautilo', 'public.foreground_memory_crypto_publication_receipts', 'DELETE') as foreground_delete,
          has_table_privilege('nautilo', 'public.foreground_memory_crypto_publication_receipts', 'SELECT') as foreground_select
        from pg_class where oid = 'public.crypto_objects'::regclass
      `);
      if (original?.parent_owner !== "nautilo") {
        throw new Error("Foreground Task fixture crypto owner is unexpected");
      }
      // PostgreSQL invokes every incoming cascade trigger for a parent delete,
      // even when its child table has no matching row. Those triggers execute
      // as the parent owner, nautilo. Any failure rolls back both these exact
      // temporary privileges and the tracked fixture graph deletion.
      if (!original.cancellation_delete) {
        await tx.execute(sql`
          grant delete on public.task_cancellation_crypto_staging_receipts to nautilo
        `);
      }
      if (!original.cancellation_select) {
        await tx.execute(sql`
          grant select on public.task_cancellation_crypto_staging_receipts to nautilo
        `);
      }
      if (!original.terminal_delete) {
        await tx.execute(sql`
          grant delete on public.task_terminal_message_crypto_staging_receipts to nautilo
        `);
      }
      if (!original.terminal_select) {
        await tx.execute(sql`
          grant select on public.task_terminal_message_crypto_staging_receipts to nautilo
        `);
      }
      if (!original.historical_delete) {
        await tx.execute(sql`
          grant delete on public.task_historical_content_crypto_staging_receipts to nautilo
        `);
      }
      if (!original.historical_select) {
        await tx.execute(sql`
          grant select on public.task_historical_content_crypto_staging_receipts to nautilo
        `);
      }
      if (!original.foreground_delete) {
        await tx.execute(sql`
          grant delete on public.foreground_memory_crypto_publication_receipts to nautilo
        `);
      }
      if (!original.foreground_select) {
        await tx.execute(sql`
          grant select on public.foreground_memory_crypto_publication_receipts to nautilo
        `);
      }
      await tx.delete(objectCryptoAccessHeads).where(inArray(
        objectCryptoAccessHeads.objectId,
        objectIds,
      ));
      await tx.delete(objectCryptoNamespaceEnvelopes).where(inArray(
        objectCryptoNamespaceEnvelopes.objectId,
        objectIds,
      ));
      await tx.delete(objectCryptoAccessManifests).where(inArray(
        objectCryptoAccessManifests.objectId,
        objectIds,
      ));
      await tx.delete(cryptoObjects).where(inArray(
        cryptoObjects.objectId,
        objectIds,
      ));
      if (!original.cancellation_delete) {
        await tx.execute(sql`
          revoke delete on public.task_cancellation_crypto_staging_receipts from nautilo
        `);
      }
      if (!original.cancellation_select) {
        await tx.execute(sql`
          revoke select on public.task_cancellation_crypto_staging_receipts from nautilo
        `);
      }
      if (!original.terminal_delete) {
        await tx.execute(sql`
          revoke delete on public.task_terminal_message_crypto_staging_receipts from nautilo
        `);
      }
      if (!original.terminal_select) {
        await tx.execute(sql`
          revoke select on public.task_terminal_message_crypto_staging_receipts from nautilo
        `);
      }
      if (!original.historical_delete) {
        await tx.execute(sql`
          revoke delete on public.task_historical_content_crypto_staging_receipts from nautilo
        `);
      }
      if (!original.historical_select) {
        await tx.execute(sql`
          revoke select on public.task_historical_content_crypto_staging_receipts from nautilo
        `);
      }
      if (!original.foreground_delete) {
        await tx.execute(sql`
          revoke delete on public.foreground_memory_crypto_publication_receipts from nautilo
        `);
      }
      if (!original.foreground_select) {
        await tx.execute(sql`
          revoke select on public.foreground_memory_crypto_publication_receipts from nautilo
        `);
      }
      const [restored] = await tx.execute<{
        cancellation_delete: boolean;
        cancellation_select: boolean;
        terminal_delete: boolean;
        terminal_select: boolean;
        historical_delete: boolean;
        historical_select: boolean;
        foreground_delete: boolean;
        foreground_select: boolean;
      }>(sql`
        select has_table_privilege('nautilo', 'public.task_cancellation_crypto_staging_receipts', 'DELETE') as cancellation_delete,
          has_table_privilege('nautilo', 'public.task_cancellation_crypto_staging_receipts', 'SELECT') as cancellation_select,
          has_table_privilege('nautilo', 'public.task_terminal_message_crypto_staging_receipts', 'DELETE') as terminal_delete,
          has_table_privilege('nautilo', 'public.task_terminal_message_crypto_staging_receipts', 'SELECT') as terminal_select,
          has_table_privilege('nautilo', 'public.task_historical_content_crypto_staging_receipts', 'DELETE') as historical_delete,
          has_table_privilege('nautilo', 'public.task_historical_content_crypto_staging_receipts', 'SELECT') as historical_select,
          has_table_privilege('nautilo', 'public.foreground_memory_crypto_publication_receipts', 'DELETE') as foreground_delete,
          has_table_privilege('nautilo', 'public.foreground_memory_crypto_publication_receipts', 'SELECT') as foreground_select
      `);
      if (
        restored?.cancellation_delete !== original.cancellation_delete
        || restored.cancellation_select !== original.cancellation_select
        || restored.terminal_delete !== original.terminal_delete
        || restored.terminal_select !== original.terminal_select
        || restored.historical_delete !== original.historical_delete
        || restored.historical_select !== original.historical_select
        || restored.foreground_delete !== original.foreground_delete
        || restored.foreground_select !== original.foreground_select
      ) {
        throw new Error("Foreground Task fixture receipt privileges were not restored");
      }
      const remaining = await tx.select({ objectId: cryptoObjects.objectId })
        .from(cryptoObjects).where(inArray(cryptoObjects.objectId, objectIds))
        .limit(1);
      if (remaining.length !== 0) {
        throw new Error("Foreground Task fixture crypto cleanup is incomplete");
      }
    }
    await tx.delete(humanCryptoDeviceAdmissions).where(eq(
      humanCryptoDeviceAdmissions.deviceId,
      input.deviceId,
    ));
    await tx.delete(humanCryptoDeviceAdmissionChallenges).where(eq(
      humanCryptoDeviceAdmissionChallenges.deviceId,
      input.deviceId,
    ));
  });
}

async function restoreFixturePolicy(
  database: DirectDatabase,
  fixture: PublicRoomGrantVisibilityFixture,
): Promise<void> {
  const { mode, shadowBehavior } = fixture.originalPolicy;
  if ((mode !== "plaintext_only" && mode !== "shadow_encryption" && mode !== "encrypted_only")
    || (shadowBehavior !== "fallback" && shadowBehavior !== "strict")) {
    throw new Error("Foreground Task fixture policy is invalid");
  }
  await database.update(encryptionTransitionPolicy).set({
    mode,
    shadowBehavior,
    shadowEncryptionStartedAt:
      fixture.originalPolicy.shadowEncryptionStartedAt,
    revision: sql`${encryptionTransitionPolicy.revision} + 1`,
    updatedAt: new Date(),
  }).where(eq(encryptionTransitionPolicy.id, "server"));
}

async function withFreshForeground<Value>(input: Readonly<{
  fixture: PublicRoomGrantVisibilityFixture;
  mode: PolicyMode;
  suffix: string;
  execute(context: Readonly<{
    plan: Awaited<ReturnType<
      typeof planWithReusableVisibilityGrantAndRuntime
    >>["plan"];
    runtime: Awaited<ReturnType<
      typeof planWithReusableVisibilityGrantAndRuntime
    >>["runtime"];
    entities: Parameters<typeof createProtectedTaskForegroundCreationOwner>[0]["entities"];
    grant: Readonly<{
      authorizationId: string;
      authorizationDigest: Uint8Array;
      recipientKeyId: string;
    }>;
  }>): Promise<Value>;
}>): Promise<Value> {
  const { fixture, mode, suffix } = input;
  const namespaceIds = Object.freeze([
    fixture.namespaceId,
    fixture.targetNamespaceId,
  ].sort());
  const domains = await inspectVisibilityGrantDomains(fixture, namespaceIds);
  const authorization = await mintReusableVisibilityGrant(
    fixture,
    domains,
    suffix,
  );
  const planned = await planWithReusableVisibilityGrantAndRuntime(
    fixture,
    namespaceIds,
    authorization,
    suffix,
  );
  const { plan, runtime } = planned;
  const current = await createVisibilityGrantCurrentAuthority(
    fixture,
    plan,
    () => namespaceIds,
    mode === "encrypted_only" ? "full_encryption" : "shadow_encryption",
  );
  if (current === null) {
    runtime.key.fill(0);
    destroyVisibilityGrant(authorization);
    throw new Error("Foreground current authority missing");
  }
  const sessions = new LiveShadowForegroundAuthorizationSessions({
    now: () => fixture.now + 25,
    startSweep: false,
  });
  const parsed = parseDomainForegroundAuthorizationPlanV2(
    authorization.reusable.authorizationPlanBytes,
  );
  if (parsed === null) {
    runtime.key.fill(0);
    current.destroy();
    destroyVisibilityGrant(authorization);
    throw new Error("Foreground Grant plan is invalid");
  }
  const currentGrant = await current.resolveCurrentForegroundAuthorization();
  if (currentGrant === null) {
    runtime.key.fill(0);
    current.destroy();
    destroyDomainForegroundAuthorizationPlanV2(parsed);
    destroyVisibilityGrant(authorization);
    throw new Error("Foreground Grant is stale");
  }
  try {
    const opened = await withOpenedDomainForegroundAuthorization(
      fixture.crypto,
      {
        authorizationBytes: authorization.authorizationBytes,
        now: fixture.now + 25,
        current: Object.freeze({
          ...currentGrant,
          recipientEncryptionPrivateKey: authorization.recipientPrivateKey,
        }),
        operation: entries => {
          const authorizationDigest = fixture.crypto.hash(
            authorization.authorizationBytes,
          );
          const scope = Object.freeze({
            subjectHumanId: fixture.humanId,
            issuingDeviceId: fixture.deviceId,
            recipientKind: "nautilo_foreground_runtime" as const,
            browserSessionId: authorization.clientActionSessionId,
            topLevelRoomId: fixture.roomId,
            policyRevision: fixture.policyRevision,
            hostAuthorizationRevision: fixture.hostAuthorizationRevision,
            namespaceIds,
            grantDomainIds: Object.freeze(
              parsed.domains.map(domain => domain.domainId).sort(),
            ),
            domainAuthoritySetDigest:
              copyBytes(parsed.domainAuthoritySetDigest),
          }) satisfies LiveShadowForegroundAuthorizationScope;
          const capability = createDomainCompressedLiveShadowSessionCapability({
            description: {
              authorizationId: parsed.authorizationId,
              subjectHumanId: fixture.humanId,
              issuingDeviceId: fixture.deviceId,
              recipientKind: "nautilo_foreground_runtime",
              browserSessionId: authorization.clientActionSessionId,
              topLevelRoomId: fixture.roomId,
              recipientKeyId: parsed.recipientKeyId,
              policyRevision: fixture.policyRevision,
              hostAuthorizationRevision: fixture.hostAuthorizationRevision,
              namespaceIds,
              grantDomainIds: scope.grantDomainIds,
              issuedAt: parsed.issuedAt,
              expiresAt: parsed.deadlineAt,
              authorizationDigest,
            },
            entries: Object.freeze(entries.map(entry => Object.freeze({
              grantDomainId: entry.domainId,
              domainKeyGeneration: entry.domainKeyGeneration,
              participantDigest: entry.participantDigest,
              headDigest: entry.headDigest,
              authorizationRevision: entry.authorizationRevision,
              domainAiGrantKey: entry.domainKey,
            }))),
          });
          const registered = sessions.register({
            capability,
            scope,
            publicEvidence: {
              authorizationDigest,
              authorizationPlanBytes:
                authorization.reusable.authorizationPlanBytes,
              authorizationPlanDigest:
                authorization.reusable.authorizationPlanDigest,
              recipientId: authorization.reusable.recipientId,
              recipientKeyId: authorization.reusable.recipientKeyId,
              recipientPublicKey: authorization.reusable.recipientPublicKey,
            },
            now: fixture.now + 25,
          });
          authorizationDigest.fill(0);
          if (registered === null) {
            throw new Error("Foreground Grant registration failed");
          }
          return Object.freeze({
            scope,
            sessionReference: registered.sessionReference,
            authorizationId: parsed.authorizationId,
            authorizationDigest: copyBytes(
              registered.authorizationDigest,
            ),
            recipientKeyId: parsed.recipientKeyId,
          });
        },
      },
    );
    if (opened.status !== "opened") {
      throw new Error(`Foreground Grant open failed: ${opened.reason}`);
    }
    const gateway = createForegroundAgentEntityCryptoGateway({
      authorizations: sessions,
      namespaceKeys: fixture.repository,
    });
    let executionFailure: unknown;
    const executed = await gateway.execute({
      sessionReference: opened.value.sessionReference,
      scope: opened.value.scope,
      operationDeadline: parsed.deadlineAt,
      entrypointId: "foreground.main",
      operations: Object.freeze(["decrypt", "encrypt"]),
      execute: async ({ entities }) => {
        try {
          return await input.execute({
            plan,
            runtime,
            entities,
            grant: opened.value,
          });
        } catch (error) {
          executionFailure = error;
          throw error;
        }
      },
    });
    if (executed.status !== "executed") {
      if (executionFailure !== undefined) {
        throw executionFailure instanceof Error
          ? executionFailure
          : new Error("Foreground execution failed", {
            cause: executionFailure,
          });
      }
      throw new Error(`Foreground entity Grant failed: ${executed.reason}`);
    }
    return executed.value;
  } finally {
    sessions.close();
    current.destroy();
    runtime.key.fill(0);
    destroyDomainForegroundAuthorizationPlanV2(parsed);
    destroyVisibilityGrant(authorization);
  }
}

describe("protected foreground Task creation", () => {
  for (const mode of ["encrypted_only", "shadow_encryption"] as const) {
    test(`recovers one ${mode} definition after product rollback`, async () => {
      const fixture = await createVisibilityGrantFixture({
        mode,
        canonicalRequesterPrivateSource: true,
        grantServerFunding: true,
      });
      const admin = createDirectDb(2);
      let taskId: string | null = null;
      let scopeId: string | null = null;
      let objectId: string | null = null;
      const invocation = Object.freeze({
        ownerId: fixture.userId,
        roomId: fixture.roomId,
        entrypoint: "foreground.main" as const,
        effect: Object.freeze({
          turnId: `foreground-turn:${randomUUID()}`,
          toolCallId: `task-create:${randomUUID()}`,
          timeReferenceMs: fixture.now + 30,
        }),
      });
      const taskInput: TaskCreateInput = {
        ownerId: fixture.userId,
        requestorId: fixture.userId,
        agentId: fixture.agentId,
        prompt: "Create a private foreground Task",
        expectedOutput: "A private result",
        metadata: {},
        preset: "task",
        scheduleKind: "now",
        timezone: "UTC",
        callingRoomId: fixture.roomId,
        targetChat: "orphan",
        resultDelivery: "raw",
        targetUserIds: [fixture.userId],
        useScope: true,
        scopeId: null,
        toolsMode: "none",
        awaitResponse: false,
        depth: 0,
      };
      const stableIdentity = protectedTaskForegroundCreationCandidateIdentity({
        invocation,
        candidate: taskInput,
      });
      const product = await createForegroundProductTransactionContext(
        { userId: fixture.userId, agentId: fixture.agentId },
        getSharedDirectDb(),
      );
      const publish = async (suffix: string, rollback: boolean) =>
        withFreshForeground({ fixture, mode, suffix,
          execute: async ({ plan, runtime, entities, grant }) => {
            const signer = deriveAgentRuntimeObjectSignerPublic(
              fixture.crypto,
              runtime,
            );
            expect(String(plan.recipientAgentId)).toBe(fixture.agentId);
            expect(plan.agentRuntimeGeneration).toBe(
              runtime.generation,
            );
            expect(plan.agentSignerKeyId).toBe(signer.principal.signerKeyId);
            expect(plan.agentSignerPublicKey).toEqual(signer.publicKey);
            signer.publicKey.fill(0);
            const representation = mode === "encrypted_only"
              ? "protected" as const
              : "dual" as const;
            const freshAuthority = async () => {
              const current = await createVisibilityGrantCurrentAuthority(
                fixture,
                plan,
                () => [fixture.namespaceId, fixture.targetNamespaceId].sort(),
                mode === "encrypted_only"
                  ? "full_encryption"
                  : "shadow_encryption",
              );
              try {
                if (current === null || !await current.verifyCurrentPlan()) {
                  throw new Error("Foreground authority changed");
                }
              } finally {
                current?.destroy();
              }
            };
            const owner = createProtectedTaskForegroundCreationOwner({
              owner: bindEncryptionDataOperationOwner({
                policy: {
                  resolve: async () => ({
                    policy: { mode, shadowBehavior: "strict" },
                    revalidationToken: fixture.policyRevision,
                  }),
                  revalidate: async token => {
                    if (token !== fixture.policyRevision) {
                      throw new Error("Foreground Task policy changed");
                    }
                  },
                },
              }),
              crypto: fixture.crypto,
              entities,
              restricted: fixture.restricted,
              serverScope: fixture.serverId,
              representation,
              subject: {
                userId: fixture.userId,
                humanId: fixture.humanId,
                agentId: fixture.agentId,
                roomId: fixture.roomId,
                policyRevision: fixture.policyRevision,
                namespaceIds: [
                  fixture.namespaceId,
                  fixture.targetNamespaceId,
                ].sort(),
              },
              publication: {
                operationId: plan.operationId,
                policyRevision: fixture.policyRevision,
                grantId: grant.authorizationId,
                grantDigest: grant.authorizationDigest,
                recipientKeyId: grant.recipientKeyId,
                agentAuthorizationRevision:
                  Number(plan.agentAuthorizationRevision),
                signerKeyId: plan.agentSignerKeyId,
                signerPublicKey: plan.agentSignerPublicKey,
                runtime,
              },
              assertCurrentForeground: freshAuthority,
              createCurrentAuthority: currentProduct =>
                createVisibilityGrantCurrentAuthority(
                  fixture,
                  plan,
                  () => [
                    fixture.namespaceId,
                    fixture.targetNamespaceId,
                  ].sort(),
                  mode === "encrypted_only"
                    ? "full_encryption"
                    : "shadow_encryption",
                  currentProduct,
                ),
            });
            try {
              return await product.canonicalRunner.transaction(
                async (transaction, executor) => owner.context.withProduct({
                  taskId: stableIdentity.taskId,
                  transaction,
                  executor,
                  use: () => withProtectedTaskForegroundCreationContext(
                    owner.context,
                    async () => {
                      const result = await createTask<ProtectedTaskCreationPlanV1>({
                        db: transaction as unknown as DirectDatabase,
                        observer: { kick() {} },
                        invocationAuthority:
                          createAcceptedInvocationAuthority(fixture.userId),
                        provenance: createAgentTurnTaskCreationProvenance({
                          ownerId: fixture.userId,
                          invocation,
                        }),
                        admission: owner.context.admission,
                        captureLocalExecution: async () => null,
                        resolveProtectedIdentity: operation =>
                          protectedTaskForegroundCreationIdentity({
                            ...operation,
                            invocation,
                          }),
                        publishProtected: operation => {
                          const identity = protectedTaskForegroundCreationIdentity({
                            ...operation,
                            invocation,
                          });
                          return owner.context.publishProtected({
                            ...operation,
                            transaction,
                            executor,
                            operationId: identity.operationId,
                          });
                        },
                      }, taskInput);
                      taskId ??= result.taskId;
                      expect(result.taskId).toBe(taskId);
                      if (rollback) throw PRODUCT_ROLLBACK;
                      return result;
                    },
                  ),
                }),
                { isolationLevel: "read committed" },
              );
            } finally {
              owner.dispose();
            }
          },
        });

      try {
        expect(fixture.userId).not.toBe(fixture.humanId);
        await rejects(
          publish("rollback", true),
          error => error === PRODUCT_ROLLBACK,
        );
        if (taskId === null) throw new Error("Stable Task identity missing");
        objectId = deriveTaskContentCryptoObjectIdV1({
          kind: "definition",
          taskId,
          contentRevision: 1,
        });
        expect(await admin.select({ id: tasks.id }).from(tasks).where(eq(
          tasks.id,
          taskId,
        ))).toEqual([]);
        const [orphan, orphanManifest, orphanEnvelope] = await Promise.all([
          admin.select({
            bytes: cryptoObjects.payloadBytes,
            hash: cryptoObjects.payloadHash,
          }).from(cryptoObjects).where(eq(
            cryptoObjects.objectId,
            objectId,
          )).then(rows => rows[0]),
          admin.select({
            bytes: objectCryptoAccessManifests.manifestBytes,
          }).from(objectCryptoAccessManifests).where(eq(
            objectCryptoAccessManifests.objectId,
            objectId,
          )).then(rows => rows[0]),
          admin.select({
            bytes: objectCryptoNamespaceEnvelopes.envelopeBytes,
          }).from(objectCryptoNamespaceEnvelopes).where(eq(
            objectCryptoNamespaceEnvelopes.objectId,
            objectId,
          )).then(rows => rows[0]),
        ]);
        expect(orphan?.bytes.byteLength).toBeGreaterThan(0);
        expect(orphan?.hash.byteLength).toBe(32);
        expect(orphanManifest?.bytes.byteLength).toBeGreaterThan(0);
        expect(orphanEnvelope?.bytes.byteLength).toBeGreaterThan(0);
        const orphanBytes = copyBytes(orphan!.bytes);
        const orphanHash = copyBytes(orphan!.hash);
        const orphanManifestBytes = copyBytes(orphanManifest!.bytes);
        const orphanEnvelopeBytes = copyBytes(orphanEnvelope!.bytes);
        try {
          const recovered = await Promise.all([
            publish("recovery-one", false),
            publish("recovery-two", false),
          ]);
          for (const result of recovered) {
            expect(result.taskId).toBe(taskId);
            expect(result.status).toBe("pending");
          }
          const [mapped] = await admin.select({
            id: tasks.id,
            status: tasks.status,
            prompt: tasks.prompt,
            expectedOutput: tasks.expectedOutput,
            representation: tasks.contentRepresentation,
            namespaceId: tasks.contentNamespaceId,
            revision: tasks.contentRevision,
            objectId: tasks.cryptoObjectId,
            mapping: tasks.cryptoMappingState,
            scopeId: tasks.scopeId,
          }).from(tasks).where(eq(tasks.id, taskId));
          expect(mapped).toMatchObject({
            id: taskId,
            status: "pending",
            prompt: mode === "encrypted_only"
              ? ""
              : taskInput.prompt,
            expectedOutput: mode === "encrypted_only"
              ? null
              : taskInput.expectedOutput,
            representation: mode === "encrypted_only" ? "protected" : "dual",
            namespaceId: fixture.namespaceId,
            revision: 1,
            objectId,
            mapping: "verified",
          });
          scopeId = mapped?.scopeId ?? null;
          expect(scopeId).not.toBeNull();
          const [revision, stored, storedManifest, storedEnvelope] = await Promise.all([
            admin.select({
              completion: taskDefinitionCryptoRevisions.completion,
              disposition: taskDefinitionCryptoRevisions.disposition,
              objectId: taskDefinitionCryptoRevisions.cryptoObjectId,
            }).from(taskDefinitionCryptoRevisions).where(eq(
              taskDefinitionCryptoRevisions.taskId,
              taskId,
            )).then(rows => rows[0]),
            admin.select({
              bytes: cryptoObjects.payloadBytes,
              hash: cryptoObjects.payloadHash,
            }).from(cryptoObjects).where(eq(
              cryptoObjects.objectId,
              objectId,
            )).then(rows => rows[0]),
            admin.select({
              bytes: objectCryptoAccessManifests.manifestBytes,
            }).from(objectCryptoAccessManifests).where(eq(
              objectCryptoAccessManifests.objectId,
              objectId,
            )).then(rows => rows[0]),
            admin.select({
              bytes: objectCryptoNamespaceEnvelopes.envelopeBytes,
            }).from(objectCryptoNamespaceEnvelopes).where(eq(
              objectCryptoNamespaceEnvelopes.objectId,
              objectId,
            )).then(rows => rows[0]),
          ]);
          expect(revision).toEqual({
            completion: "complete",
            disposition: "mapped",
            objectId,
          });
          expect(stored?.bytes).toEqual(orphanBytes);
          expect(stored?.hash).toEqual(orphanHash);
          expect(storedManifest?.bytes).toEqual(orphanManifestBytes);
          expect(storedEnvelope?.bytes).toEqual(orphanEnvelopeBytes);

          const [device] = await admin.select({ generation: humanCryptoDevices.deviceGeneration })
            .from(humanCryptoDevices).where(eq(humanCryptoDevices.deviceId, fixture.deviceId));
          if (device === undefined) throw new Error("Fixture device is unavailable");
          const reader = createProductionProtectedTaskComposition({
            db: getSharedDirectDb(),
            restricted: fixture.restricted,
            crypto: fixture.crypto,
            serverScope: fixture.serverId,
            owner: bindEncryptionDataOperationOwner({ policy: {
              resolve: async () => ({ policy: { mode, shadowBehavior: "strict" }, revalidationToken: fixture.policyRevision }),
              revalidate: async () => {},
            } }),
            observer: { kick() {} },
            now: () => fixture.now + 25,
          });
          // Occupy the other four slots without acquiring product row locks.
          // This read must finish with the single remaining app connection.
          const poolReady = Array.from({ length: 4 }, () => Promise.withResolvers<void>());
          const poolRelease = Promise.withResolvers<void>();
          const holders = poolReady.map(gate => getSharedDirectDb().transaction(async tx => {
            await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId!)).limit(1);
            gate.resolve();
            await poolRelease.promise;
          }));
          await Promise.all(poolReady.map(gate => gate.promise));
          let timeout: ReturnType<typeof setTimeout> | undefined;
          const reading = reader.ports.readDefinition({
            authority: { userId: fixture.userId, subjectHumanId: fixture.humanId,
              actorId: fixture.humanId, agentId: fixture.agentId, deviceId: fixture.deviceId,
              deviceGeneration: device.generation },
            taskId, objectId, contentRevision: 1, cryptoAccessRevision: 0,
          });
          const ready = await Promise.race([reading, new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error("Task read borrowed a nested app connection")), 10_000);
          })]).finally(async () => {
            clearTimeout(timeout);
            poolRelease.resolve();
            await Promise.all(holders);
            await reading.catch(() => undefined);
          });
          expect(ready.status).toBe("ready");
          expect(ready.signerEvidence).toMatchObject([{ kind: "foreground_agent_accepted_execution" }]);
          const rewrappedObjectId = ready.objectId;

          // A genuine Human-signed access update keeps the original payload and
          // allocation receipt immutable. The Human read repairs only its head.
          const envelopes = await admin.select().from(objectCryptoNamespaceEnvelopes)
            .where(and(eq(objectCryptoNamespaceEnvelopes.objectId, objectId),
              eq(objectCryptoNamespaceEnvelopes.accessRevision, 0)))
            .orderBy(objectCryptoNamespaceEnvelopes.ordinal);
          const accessUpdate = createCommonHumanObjectAccessManifest(fixture.crypto, {
            objectId: cryptoObjectId(objectId), payloadHash: orphanHash,
            accessRevision: accessRevision(1), previousManifestHash: fixture.crypto.hash(orphanManifestBytes),
            envelopeHashes: envelopes.map(envelope => envelope.envelopeHash),
            signer: { kind: "human_device", subjectHumanId: humanId(fixture.humanId),
              committerDeviceId: cryptoDeviceId(fixture.deviceId) },
            signerAuthorizationHash: null,
            hostAuthorizationRevision: authorizationRevision(fixture.hostAuthorizationRevision),
          }, fixture.signing.privateKey);
          await admin.transaction(async transaction => {
            await transaction.insert(objectCryptoAccessManifests).values({ objectId: rewrappedObjectId,
              accessRevision: 1, manifestHash: accessUpdate.hash,
              previousManifestHash: fixture.crypto.hash(orphanManifestBytes), payloadHash: orphanHash,
              manifestBytes: accessUpdate.bytes });
            await transaction.insert(objectCryptoNamespaceEnvelopes).values(envelopes.map(envelope => ({
              ...envelope, accessRevision: 1,
            })));
            const advanced = await transaction.update(objectCryptoAccessHeads)
              .set({ accessRevision: 1, manifestHash: accessUpdate.hash })
              .where(and(eq(objectCryptoAccessHeads.objectId, rewrappedObjectId),
                eq(objectCryptoAccessHeads.accessRevision, 0)))
              .returning({ objectId: objectCryptoAccessHeads.objectId });
            expect(advanced).toHaveLength(1);
          });
          const admissions = new PostgresDeviceAdmissionRepository(
            await verifyCryptoPostgresHandle(fixture.restricted), fixture.crypto,
          );
          const credentialDigest = fixture.crypto.hash(new TextEncoder().encode(`creation-read:${randomUUID()}`));
          const credentialExpiresAt = fixture.now + 60_000;
          const admissionInput = { credentialDigest, credentialExpiresAt, userId: fixture.userId,
            humanActorId: fixture.humanId, deviceId: fixture.deviceId, now: fixture.now + 10 };
          const challenge = await admissions.issueChallenge(admissionInput);
          if (challenge === null) throw new Error("Fixture device challenge unavailable");
          expect(await admissions.admit({ ...admissionInput,
            now: fixture.now + 11,
            proof: createDeviceAdmissionProof({ crypto: fixture.crypto, challenge,
              signingPrivateKey: fixture.signing.privateKey }),
          })).toBe("admitted");
          const admission = await admissions.status({ ...admissionInput, now: fixture.now + 25 });
          if (admission.status !== "admitted") throw new Error("Fixture device admission unavailable");
          const readAuthority = { userId: fixture.userId, subjectHumanId: fixture.humanId,
            actorId: fixture.humanId, agentId: fixture.agentId, deviceId: fixture.deviceId,
            deviceGeneration: device.generation, admission };
          const updatedRead = await reader.ports.readDefinition({ authority: readAuthority,
            taskId, objectId, contentRevision: 1, cryptoAccessRevision: 1 });
          expect(updatedRead.status).toBe("ready");
          expect(updatedRead.accessManifestProofBytesBase64url).toHaveLength(1);
          const [updatedTask] = await admin.select({ head: tasks.cryptoAccessRevision,
            revision: tasks.contentRevision }).from(tasks).where(eq(tasks.id, taskId));
          expect(updatedTask).toEqual({ head: 1, revision: 1 });
          const [immutableRevision] = await admin.select({ head: taskDefinitionCryptoRevisions.cryptoAccessRevision })
            .from(taskDefinitionCryptoRevisions).where(eq(taskDefinitionCryptoRevisions.taskId, taskId));
          expect(immutableRevision?.head).toBe(0);
          expect((await admin.select({ bytes: cryptoObjects.payloadBytes }).from(cryptoObjects)
            .where(eq(cryptoObjects.objectId, objectId)))[0]?.bytes).toEqual(orphanBytes);
          accessUpdate.bytes.fill(0); accessUpdate.hash.fill(0); credentialDigest.fill(0);
          admission.headDigest.fill(0);

          await admin.update(tasks).set({ status: "completed" }).where(eq(
            tasks.id,
            taskId,
          ));
          const replay = await publish("committed-replay", false);
          expect(replay).toMatchObject({ taskId, status: "completed" });
          expect(await admin.select({
            id: tasks.id,
            status: tasks.status,
            objectId: tasks.cryptoObjectId,
          }).from(tasks).where(eq(tasks.id, taskId))).toEqual([{
            id: taskId,
            status: "completed",
            objectId,
          }]);
          expect(await admin.select({ id: tasks.id }).from(tasks).where(eq(
            tasks.id,
            taskId,
          ))).toHaveLength(1);
        } finally {
          orphanBytes.fill(0);
          orphanHash.fill(0);
          orphanManifestBytes.fill(0);
          orphanEnvelopeBytes.fill(0);
        }
      } finally {
        try {
          await deleteForegroundTaskFixtureGraph(admin, {
            taskId,
            scopeId,
            cryptoObjectId: objectId,
            deviceId: fixture.deviceId,
          });
        } finally {
          let fixtureDestroyed = false;
          try {
            await destroyVisibilityGrantFixture(fixture);
            fixtureDestroyed = true;
          } finally {
            try {
              // The shared fixture restores policy in its deletion transaction.
              // If that transaction failed, restore the exact saved values with
              // the still-open local admin connection before releasing it.
              if (!fixtureDestroyed) await restoreFixturePolicy(admin, fixture);
            } finally {
              await admin.end();
            }
          }
        }
      }
    }, 120_000);
  }
});
