import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  actors,
  agents,
  and,
  eq,
  inArray,
  namespaces,
  protectedTaskRunOutputBindingId,
  protectedTaskRunResultObjectId,
  protectedTaskRunWakeJobId,
  protectedTaskRunWakeOperationId,
  roomMembers,
  rooms,
  serverAdmission,
  sessions,
  users,
  type DirectDatabase,
  type PostgresJsBridgeConnection,
} from "@nautilo/db";
import { assertFixtureDbMutationAllowed } from "@nautilo/db/testing";
import {
  PostgresNamespaceProductAuthority,
} from "@nautilo/lattice-bridge/server";
import type { PolicyResolver } from "@nautilo/trust";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@nautilo/db/schema";
import postgres from "postgres";

import {
  createHumanProductTransactionContext,
} from "../../src/routes/human-message-product-store";
import {
  createProtectedTaskWakeForegroundAdmission,
} from "../../src/routes/protected-task-wake-foreground-admission";
import type {
  ProtectedTaskOutputReadIntent,
} from "../../src/routes/protected-task-output-read-product";

type Fixture = Readonly<{
  userId: string;
  humanActorId: string;
  agentId: string;
  agentActorId: string;
  sourceRoomId: string;
  alternateSourceRoomId: string;
  destinationRoomId: string;
  namespaceId: string;
  alternateNamespaceId: string;
  sessionId: string;
  taskId: string;
  taskRunId: string;
}>;

const ENABLE_ENV = "NAUTILO_PROTECTED_TASK_WAKE_ADMISSION_INTEGRATION";
const integrationEnabled = process.env[ENABLE_ENV] === "1";
const describePostgres = integrationEnabled ? describe : describe.skip;

let adminClient: postgres.Sql | undefined;
let appClient: postgres.Sql | undefined;
let adminDb: ReturnType<typeof drizzle<typeof schema>> | undefined;
let appDb: DirectDatabase | undefined;

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assertExactCleanupTarget(): Readonly<{
  adminUrl: string;
  appUrl: string;
  port: string;
}> {
  const instance = process.env["NAUTILO_PROTECTED_TASK_QA_INSTANCE"];
  const port = process.env["NAUTILO_PROTECTED_TASK_QA_POSTGRES_PORT"];
  if (
    !instance
    || !/^qa-[a-z0-9-]+$/u.test(instance)
    || process.env["NAUTILO_INSTANCE_ID"] !== instance
    || !port
  ) {
    throw new Error(
      "Protected Task wake admission integration requires an explicitly bound disposable QA instance and port",
    );
  }
  assertFixtureDbMutationAllowed();
  const adminUrl = requiredEnvironment("LATTICE_BRIDGE_TEST_ADMIN_DATABASE_URL");
  const appUrl = requiredEnvironment("LATTICE_BRIDGE_TEST_APP_DATABASE_URL");
  for (const [name, raw, role] of [
    ["LATTICE_BRIDGE_TEST_ADMIN_DATABASE_URL", adminUrl, null],
    ["LATTICE_BRIDGE_TEST_APP_DATABASE_URL", appUrl, "nautilo"],
  ] as const) {
    const url = new URL(raw);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol)
      || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)
      || url.port !== port
      || url.pathname !== "/nautilo"
      || !url.username
      || !url.password
      || role !== null && url.username !== role
    ) {
      throw new Error(`${name} must identify the exact local disposable QA role`);
    }
  }
  return Object.freeze({ adminUrl, appUrl, port });
}

async function within<Value>(promise: Promise<Value>): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(
          new Error("Protected Task wake admission timed out on the one-connection pool"),
        ), 5_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function requireDatabases(): Readonly<{
  admin: NonNullable<typeof adminDb>;
  app: NonNullable<typeof appDb>;
  appSql: NonNullable<typeof appClient>;
}> {
  if (adminDb === undefined || appDb === undefined || appClient === undefined) {
    throw new Error("Protected Task wake admission integration is not initialized");
  }
  return { admin: adminDb, app: appDb, appSql: appClient };
}

function fixture(): Fixture {
  return Object.freeze({
    userId: randomUUID(),
    humanActorId: randomUUID(),
    agentId: randomUUID(),
    agentActorId: randomUUID(),
    sourceRoomId: randomUUID(),
    alternateSourceRoomId: randomUUID(),
    destinationRoomId: randomUUID(),
    namespaceId: randomUUID(),
    alternateNamespaceId: randomUUID(),
    sessionId: randomUUID(),
    taskId: randomUUID(),
    taskRunId: randomUUID(),
  });
}

function destinationThreadId(value: Fixture): string {
  return `room:${value.destinationRoomId}`;
}

async function insertFixture(value: Fixture): Promise<void> {
  const { admin } = requireDatabases();
  const suffix = value.userId.slice(0, 8);
  await admin.transaction(async tx => {
    await tx.insert(users).values({
      id: value.userId,
      name: `Wake admission ${suffix}`,
      handle: `wake-admission-${suffix}`,
    });
    await tx.insert(serverAdmission).values({
      userId: value.userId,
      admitted: true,
    });
    await tx.insert(agents).values({
      id: value.agentId,
      handle: `wake-admission-agent-${suffix}`,
    });
    await tx.insert(actors).values([
      {
        id: value.humanActorId,
        ownerId: value.userId,
        displayName: `Wake human ${suffix}`,
        trustState: "verified",
        kind: "user",
      },
      {
        id: value.agentActorId,
        ownerId: value.userId,
        displayName: `Wake agent ${suffix}`,
        trustState: "verified",
        kind: "agent",
        agentId: value.agentId,
      },
    ]);
    await tx.insert(namespaces).values([
      { id: value.namespaceId, scope: "room", label: `Wake ${suffix}` },
      {
        id: value.alternateNamespaceId,
        scope: "room",
        label: `Wake alternate ${suffix}`,
      },
    ]);
    await tx.insert(rooms).values([
      {
        id: value.sourceRoomId,
        ownerId: value.userId,
        type: "private",
        kind: "private",
        label: `Wake source ${suffix}`,
        graphThreadId: `room:${value.sourceRoomId}`,
        namespaceId: value.namespaceId,
        humanActorIds: [value.humanActorId],
        createdBy: value.humanActorId,
      },
      {
        id: value.alternateSourceRoomId,
        ownerId: value.userId,
        type: "private",
        kind: "private",
        label: `Wake alternate ${suffix}`,
        graphThreadId: `room:${value.alternateSourceRoomId}`,
        namespaceId: value.alternateNamespaceId,
        humanActorIds: [value.humanActorId],
        createdBy: value.humanActorId,
      },
      {
        id: value.destinationRoomId,
        ownerId: value.userId,
        type: "private",
        kind: "subthread",
        label: `Wake destination ${suffix}`,
        graphThreadId: destinationThreadId(value),
        namespaceId: value.namespaceId,
        humanActorIds: [value.humanActorId],
        parentRoomId: value.sourceRoomId,
        deletedThreadRootMessageId: 2_000_000_000,
        createdBy: value.humanActorId,
      },
    ]);
    await tx.insert(roomMembers).values([
      ...[value.sourceRoomId, value.alternateSourceRoomId, value.destinationRoomId]
        .flatMap(roomId => [
          {
            roomId,
            actorId: value.humanActorId,
            roomRole: "admin" as const,
            agentResponseMode: null,
          },
          {
            roomId,
            actorId: value.agentActorId,
            roomRole: "member" as const,
            agentResponseMode: "active" as const,
          },
        ]),
    ]);
    await tx.insert(sessions).values({
      id: value.sessionId,
      threadId: destinationThreadId(value),
      ownerId: value.userId,
      personaId: "owner",
      agentId: value.agentId,
      roomId: value.destinationRoomId,
      channel: "electron",
    });
  });
}

async function cleanupFixture(value: Fixture): Promise<void> {
  assertExactCleanupTarget();
  const { admin } = requireDatabases();
  await admin.transaction(async tx => {
    await tx.delete(sessions).where(eq(sessions.id, value.sessionId));
    await tx.delete(roomMembers).where(inArray(roomMembers.roomId, [
      value.destinationRoomId,
      value.sourceRoomId,
      value.alternateSourceRoomId,
    ]));
    await tx.delete(rooms).where(inArray(rooms.id, [
      value.destinationRoomId,
      value.sourceRoomId,
      value.alternateSourceRoomId,
    ]));
    await tx.delete(namespaces).where(inArray(namespaces.id, [
      value.namespaceId,
      value.alternateNamespaceId,
    ]));
    await tx.delete(actors).where(inArray(actors.id, [
      value.humanActorId,
      value.agentActorId,
    ]));
    await tx.delete(agents).where(eq(agents.id, value.agentId));
    await tx.delete(serverAdmission).where(eq(
      serverAdmission.userId,
      value.userId,
    ));
    await tx.delete(users).where(eq(users.id, value.userId));
  });
}

function intent(value: Fixture): ProtectedTaskOutputReadIntent {
  return Object.freeze({
    requesterUserId: value.userId,
    requesterHumanId: value.humanActorId,
    agentId: value.agentId,
    contentNamespaceId: value.namespaceId,
    representation: "protected" as const,
    expectedPolicyRevision: 9,
    acceptedPolicyRevision: 8,
    initialState: "wake_queued" as const,
    result: Object.freeze({
      taskId: value.taskId,
      taskRunId: value.taskRunId,
      terminalStatus: "completed" as const,
      contentRevision: 1 as const,
      objectId: protectedTaskRunResultObjectId(value.taskId, value.taskRunId),
      cryptoAccessRevision: 0 as const,
      genesisManifestHash: new Uint8Array(32).fill(7),
      signerAgentId: value.agentId,
    }),
    invocation: Object.freeze({
      kind: "wake" as const,
      bindingId: protectedTaskRunOutputBindingId(value.taskRunId),
      operationId: protectedTaskRunWakeOperationId(value.taskRunId),
      roomId: value.destinationRoomId,
      sessionId: value.sessionId,
      jobId: protectedTaskRunWakeJobId(value.taskRunId),
      reference: Object.freeze({
        kind: "protected_task_delivery_v1" as const,
        taskId: value.taskId,
        taskRunId: value.taskRunId,
        bindingId: protectedTaskRunOutputBindingId(value.taskRunId),
        resultObjectId: protectedTaskRunResultObjectId(value.taskId, value.taskRunId),
        wakeOperationId: protectedTaskRunWakeOperationId(value.taskRunId),
      }),
    }),
  });
}

function inTransaction(
  executor: Pick<PostgresJsBridgeConnection, "query">,
): PostgresJsBridgeConnection {
  return {
    query: executor.query.bind(executor),
    transaction: use => use(executor),
    transactionOnce: use => use(executor),
  };
}

function resolverFor(value: Fixture, input: Readonly<{
  afterSamePoolQuery?: () => Promise<void>;
  onCall?: () => void;
}> = {}): PolicyResolver {
  const { appSql } = requireDatabases();
  return {
    buildEnvelope: async (actorId: string, _lane: string, agentId: string,
      roomId: string) => {
      input.onCall?.();
      // This same-pool query supplements the deadlock regression. The real
      // PostgresNamespaceProductAuthority below remains the admission owner.
      const rows = await appSql.begin(async tx => {
        await tx`SELECT set_config('app.current_user_id', ${value.userId}, true)`;
        return tx<{ id: string; namespaceId: string }[]>`
          SELECT id::text AS id, namespace_id::text AS "namespaceId"
            FROM rooms
           WHERE id = ${value.sourceRoomId}::uuid
           LIMIT 2
        `;
      });
      if (rows.length !== 1
        || rows[0]?.id !== value.sourceRoomId
        || rows[0]?.namespaceId !== value.namespaceId) {
        throw new Error("same-pool resolver probe could not read the source Room");
      }
      await input.afterSamePoolQuery?.();
      return {
        memoryMode: "namespace" as const,
        ownerId: value.userId,
        actorId,
        agentId,
        roomId,
        readableNamespaces: [value.namespaceId],
        mutableNamespaces: [],
        writableNamespaces: [value.namespaceId],
        toolPolicy: {},
      };
    },
  } as unknown as PolicyResolver;
}

const subject = (value: Fixture) => Object.freeze({
  userId: value.userId,
  humanActorId: value.humanActorId,
});

beforeAll(async () => {
  if (!integrationEnabled) return;
  const target = assertExactCleanupTarget();
  adminClient = postgres(target.adminUrl, { max: 1, prepare: false });
  appClient = postgres(target.appUrl, { max: 1, prepare: false });
  const [adminIdentity, appIdentity] = await Promise.all([
    adminClient<{ database: string; role: string }[]>`
      SELECT current_database() AS database, current_user AS role
    `,
    appClient<{ database: string; role: string }[]>`
      SELECT current_database() AS database, current_user AS role
    `,
  ]);
  if (adminIdentity[0]?.database !== "nautilo"
    || adminIdentity[0]?.role !== "postgres"
    || appIdentity[0]?.database !== "nautilo"
    || appIdentity[0]?.role !== "nautilo") {
    throw new Error("Protected Task wake admission database role is invalid");
  }
  adminDb = drizzle(adminClient, { schema });
  appDb = drizzle(appClient, { schema }) as DirectDatabase;
});

afterAll(async () => {
  await Promise.all([
    adminClient?.end(),
    appClient?.end(),
  ]);
});

describePostgres("protected Task wake foreground admission against PostgreSQL", () => {
  test("completes discovery on one connection without resolving inside the held transaction and keeps current reads resolver-free", async () => {
    const value = fixture();
    await insertFixture(value);
    let resolverCalls = 0;
    let namespaceAuthorityCalls = 0;
    let namespaceAuthorityUseCalls = 0;
    try {
      const { app } = requireDatabases();
      const admission = createProtectedTaskWakeForegroundAdmission({
        db: app,
        resolver: resolverFor(value, {
          onCall: () => { resolverCalls += 1; },
        }),
      }, {
        createNamespaceAuthority: product => {
          const authority = new PostgresNamespaceProductAuthority(product);
          return {
            withCurrentReadableNamespaceSet: operation => {
              namespaceAuthorityCalls += 1;
              return authority.withCurrentReadableNamespaceSet({
                ...operation,
                use: async entries => {
                  namespaceAuthorityUseCalls += 1;
                  return operation.use(entries);
                },
              });
            },
          };
        },
      });
      const discovered = await within(admission.discover({
        intent: intent(value),
        subject: subject(value),
      }));
      expect(resolverCalls).toBe(1);
      expect(namespaceAuthorityCalls).toBe(1);
      expect(namespaceAuthorityUseCalls).toBe(1);
      expect(discovered).toEqual({ namespaceIds: [value.namespaceId] });

      const context = await within(createHumanProductTransactionContext(
        value.userId,
        app,
      ));
      const current = await within(context.canonicalRunner.transaction(
        (transaction, executor) => admission.readCurrent({
          intent: intent(value),
          subject: subject(value),
          product: inTransaction(executor),
          transaction,
          expectedNamespaceIds: discovered!.namespaceIds,
        }),
        { isolationLevel: "read committed" },
      ));
      expect(current).toEqual(discovered);
      expect(resolverCalls).toBe(1);
    } finally {
      await cleanupFixture(value);
    }
  });

  test("rejects a destination Room coordinate changed after discovery", async () => {
    const value = fixture();
    await insertFixture(value);
    try {
      const { admin, app } = requireDatabases();
      const admission = createProtectedTaskWakeForegroundAdmission({
        db: app,
        resolver: resolverFor(value, {
          afterSamePoolQuery: async () => {
            await admin.update(rooms).set({
              parentRoomId: value.alternateSourceRoomId,
            }).where(eq(rooms.id, value.destinationRoomId));
          },
        }),
      });
      expect(await within(admission.discover({
        intent: intent(value),
        subject: subject(value),
      }))).toBeNull();
    } finally {
      await cleanupFixture(value);
    }
  });

  test("rejects destination audience drift after discovery", async () => {
    const value = fixture();
    await insertFixture(value);
    try {
      const { admin, app } = requireDatabases();
      const admission = createProtectedTaskWakeForegroundAdmission({
        db: app,
        resolver: resolverFor(value, {
          afterSamePoolQuery: async () => {
            await admin.delete(roomMembers).where(and(
              eq(roomMembers.roomId, value.destinationRoomId),
              eq(roomMembers.actorId, value.humanActorId),
            ));
          },
        }),
      });
      expect(await within(admission.discover({
        intent: intent(value),
        subject: subject(value),
      }))).toBeNull();
    } finally {
      await cleanupFixture(value);
    }
  });
});
