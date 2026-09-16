import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import {
  ensureDatabase,
  resolveDirectDatabaseConnectionString,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";

const FIXTURE_PREFIX = "m322-content-access-operation";
const ROLLBACK_SENTINEL = "__m322_content_access_operation_rollback__";

type DatabaseRole = "nautilo" | "nautilo_agent" | "nautilo_crypto";

interface Fixture {
  userId: string;
  actorId: string;
  memoryId: string;
  artifactId: string;
}

let connection: ReturnType<typeof postgres>;
let savepointSequence = 0;

function nextSavepoint(label: string): string {
  savepointSequence += 1;
  return `m322_${label}_${savepointSequence}`;
}

async function withRole<T>(
  tx: postgres.TransactionSql,
  role: DatabaseRole,
  operation: (roleTx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  const savepoint = nextSavepoint(`role_${role}`);
  await tx.unsafe(`SAVEPOINT ${savepoint}`);
  try {
    await tx.unsafe(`SET LOCAL ROLE "${role}"`);
    const [identity] = await tx<{ current_user: string }[]>`select current_user`;
    expect(identity?.current_user).toBe(role);
    const result = await operation(tx);
    await tx.unsafe("RESET ROLE");
    await tx.unsafe(`RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (error) {
    await tx.unsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await tx.unsafe(`RELEASE SAVEPOINT ${savepoint}`);
    throw error;
  }
}

async function expectDatabaseError(
  tx: postgres.TransactionSql,
  expected: { code: string; constraint?: string },
  operation: () => Promise<unknown>,
): Promise<void> {
  const savepoint = nextSavepoint("expected_error");
  await tx.unsafe(`SAVEPOINT ${savepoint}`);
  try {
    await operation();
  } catch (error) {
    await tx.unsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await tx.unsafe(`RELEASE SAVEPOINT ${savepoint}`);
    const databaseError = error as { code?: string; constraint_name?: string };
    expect(databaseError.code).toBe(expected.code);
    if (expected.constraint !== undefined) {
      expect(databaseError.constraint_name).toBe(expected.constraint);
    }
    return;
  }
  await tx.unsafe(`RELEASE SAVEPOINT ${savepoint}`);
  throw new Error(`expected database error ${expected.code}`);
}

async function createFixture(tx: postgres.TransactionSql): Promise<Fixture> {
  const suffix = randomUUID();
  const [user] = await tx<{ id: string }[]>`
    insert into users (name)
    values (${`${FIXTURE_PREFIX}:${suffix}`})
    returning id
  `;
  if (!user) throw new Error("M322 fixture user was not created");

  const [actor] = await tx<{ id: string }[]>`
    insert into actors (owner_id, display_name, kind)
    values (${user.id}, ${`${FIXTURE_PREFIX}:${suffix}`}, 'user')
    returning id
  `;
  if (!actor) throw new Error("M322 fixture actor was not created");

  const [memory] = await tx<{ id: string }[]>`
    insert into memories (content)
    values (${`${FIXTURE_PREFIX}:${suffix}`})
    returning id
  `;
  if (!memory) throw new Error("M322 fixture Memory was not created");

  const [artifact] = await tx<{ id: string }[]>`
    insert into artifacts (artifact_id, path, mime_type, size, storage_uri)
    values (
      ${randomUUID()},
      ${`${FIXTURE_PREFIX}-${suffix}.txt`},
      'text/plain',
      1,
      ${`file:///m322-fixture/${suffix}.txt`}
    )
    returning id
  `;
  if (!artifact) throw new Error("M322 fixture Artifact was not created");

  return {
    userId: user.id,
    actorId: actor.id,
    memoryId: memory.id,
    artifactId: artifact.id,
  };
}

async function withFixture(
  assertion: (tx: postgres.TransactionSql, fixture: Fixture) => Promise<void>,
): Promise<void> {
  try {
    await connection.begin(async (tx) => {
      const fixture = await createFixture(tx);
      await assertion(tx, fixture);
      throw new Error(ROLLBACK_SENTINEL);
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== ROLLBACK_SENTINEL) {
      throw error;
    }
  }
}

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  connection = postgres(resolveDirectDatabaseConnectionString(), {
    max: 1,
    prepare: false,
  });
}, 120_000);

afterAll(async () => {
  await connection?.end({ timeout: 1 });
});

describe("M322 terminal content-access operation receipts", () => {
  test("inserts and reads one terminal receipt, rejects duplicate identity, and follows FK lifetime", async () => {
    await withFixture(async (tx, fixture) => {
      const operationId = randomUUID();
      const memoryOperationId = randomUUID();
      const digest = "a".repeat(64);

      await withRole(tx, "nautilo", async (productTx) => {
        await productTx`
          insert into content_access_operations (
            operation_id, request_digest, requester_user_id,
            requester_actor_id, artifact_id, outcome, changed,
            attached_count, detached_count, skipped_count
          ) values (
            ${operationId}, ${digest}, ${fixture.userId},
            ${fixture.actorId}, ${fixture.artifactId}, 'applied', true,
            1, 0, 0
          )
        `;
        const rows = await productTx<{
          operation_id: string;
          request_digest: string;
          outcome: string;
          changed: boolean;
        }[]>`
          select operation_id, request_digest, outcome, changed
          from content_access_operations
          where operation_id = ${operationId}
        `;
        expect([...rows]).toEqual([{
          operation_id: operationId,
          request_digest: digest,
          outcome: "applied",
          changed: true,
        }]);
        await productTx`
          insert into content_access_operations (
            operation_id, request_digest, requester_user_id,
            requester_actor_id, memory_id, outcome, changed,
            attached_count, detached_count, skipped_count
          ) values (
            ${memoryOperationId}, ${"9".repeat(64)}, ${fixture.userId},
            ${fixture.actorId}, ${fixture.memoryId}, 'denied', false,
            0, 0, 0
          )
        `;
      });

      await expectDatabaseError(
        tx,
        { code: "23505", constraint: "content_access_operations_pkey" },
        () => withRole(tx, "nautilo", async (productTx) => {
          await productTx`
            insert into content_access_operations (
              operation_id, request_digest, artifact_id, outcome, changed,
              attached_count, detached_count, skipped_count
            ) values (
              ${operationId}, ${digest}, ${fixture.artifactId},
              'already_applied', false, 0, 0, 1
            )
          `;
        }),
      );

      await tx`delete from users where id = ${fixture.userId}`;
      const anonymized = await withRole(tx, "nautilo", (productTx) =>
        productTx<{
          operation_id: string;
          requester_user_id: string | null;
          requester_actor_id: string | null;
        }[]>`
          select operation_id, requester_user_id, requester_actor_id
          from content_access_operations
          where operation_id in (${operationId}, ${memoryOperationId})
          order by operation_id
        `,
      );
      expect([...anonymized]).toEqual([
        operationId,
        memoryOperationId,
      ].sort().map((id) => ({
        operation_id: id,
        requester_user_id: null,
        requester_actor_id: null,
      })));

      await tx`delete from artifacts where id = ${fixture.artifactId}`;
      const afterArtifactDeletion = await withRole(tx, "nautilo", (productTx) =>
        productTx<{ operation_id: string }[]>`
          select operation_id from content_access_operations
          where operation_id in (${operationId}, ${memoryOperationId})
        `,
      );
      expect([...afterArtifactDeletion]).toEqual([{
        operation_id: memoryOperationId,
      }]);

      await tx`delete from memories where id = ${fixture.memoryId}`;
      const afterMemoryDeletion = await withRole(tx, "nautilo", (productTx) =>
        productTx<{ operation_id: string }[]>`
          select operation_id from content_access_operations
          where operation_id = ${memoryOperationId}
        `,
      );
      expect([...afterMemoryDeletion]).toEqual([]);
    });
  });

  test("enforces exact object, nonnegative count, and terminal outcome constraints", async () => {
    await withFixture(async (tx, fixture) => {
      await expectDatabaseError(
        tx,
        { code: "23514", constraint: "content_access_operations_one_object" },
        () => withRole(tx, "nautilo", async (productTx) => {
          await productTx`
            insert into content_access_operations (
              operation_id, request_digest, memory_id, artifact_id,
              outcome, changed, attached_count, detached_count, skipped_count
            ) values (
              ${randomUUID()}, ${"b".repeat(64)}, null, null,
              'denied', false, 0, 0, 0
            )
          `;
        }),
      );
      await expectDatabaseError(
        tx,
        { code: "23514", constraint: "content_access_operations_one_object" },
        () => withRole(tx, "nautilo", async (productTx) => {
          await productTx`
            insert into content_access_operations (
              operation_id, request_digest, memory_id, artifact_id,
              outcome, changed, attached_count, detached_count, skipped_count
            ) values (
              ${randomUUID()}, ${"c".repeat(64)}, ${fixture.memoryId},
              ${fixture.artifactId}, 'denied', false, 0, 0, 0
            )
          `;
        }),
      );
      await expectDatabaseError(
        tx,
        { code: "23514", constraint: "content_access_operations_counts_nonnegative" },
        () => withRole(tx, "nautilo", async (productTx) => {
          await productTx`
            insert into content_access_operations (
              operation_id, request_digest, memory_id, outcome, changed,
              attached_count, detached_count, skipped_count
            ) values (
              ${randomUUID()}, ${"d".repeat(64)}, ${fixture.memoryId},
              'denied', false, 0, 0, -1
            )
          `;
        }),
      );
      await expectDatabaseError(
        tx,
        { code: "23514", constraint: "content_access_operations_outcome_check" },
        () => withRole(tx, "nautilo", async (productTx) => {
          await productTx`
            insert into content_access_operations (
              operation_id, request_digest, memory_id, outcome, changed,
              attached_count, detached_count, skipped_count
            ) values (
              ${randomUUID()}, ${"e".repeat(64)}, ${fixture.memoryId},
              'pending', false, 0, 0, 0
            )
          `;
        }),
      );
      await expectDatabaseError(
        tx,
        { code: "23514", constraint: "content_access_operations_outcome_coherent" },
        () => withRole(tx, "nautilo", async (productTx) => {
          await productTx`
            insert into content_access_operations (
              operation_id, request_digest, memory_id, outcome, changed,
              attached_count, detached_count, skipped_count
            ) values (
              ${randomUUID()}, ${"f".repeat(64)}, ${fixture.memoryId},
              'applied', false, 0, 0, 0
            )
          `;
        }),
      );
    });
  });

  test("denies Agent and crypto access and keeps product receipts append-only", async () => {
    await withFixture(async (tx, fixture) => {
      const operationId = randomUUID();
      await withRole(tx, "nautilo", async (productTx) => {
        await productTx`
          insert into content_access_operations (
            operation_id, request_digest, memory_id, outcome, changed,
            attached_count, detached_count, skipped_count
          ) values (
            ${operationId}, ${"1".repeat(64)}, ${fixture.memoryId},
            'partial', true, 1, 0, 1
          )
        `;
      });

      const [security] = await tx<{
        force_rls: boolean;
        policy_commands: string[];
      }[]>`
        select c.relforcerowsecurity as force_rls,
               array_agg(p.polcmd order by p.polcmd) as policy_commands
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_policy p on p.polrelid = c.oid
        where n.nspname = 'public' and c.relname = 'content_access_operations'
        group by c.relforcerowsecurity
      `;
      expect(security).toEqual({ force_rls: true, policy_commands: ["a", "r"] });

      for (const role of ["nautilo_agent", "nautilo_crypto"] as const) {
        const [privileges] = await tx<{
          can_select: boolean;
          can_insert: boolean;
          can_update: boolean;
          can_delete: boolean;
        }[]>`
          select
            has_table_privilege(${role}, 'public.content_access_operations', 'SELECT') as can_select,
            has_table_privilege(${role}, 'public.content_access_operations', 'INSERT') as can_insert,
            has_table_privilege(${role}, 'public.content_access_operations', 'UPDATE') as can_update,
            has_table_privilege(${role}, 'public.content_access_operations', 'DELETE') as can_delete
        `;
        expect(privileges).toEqual({
          can_select: false,
          can_insert: false,
          can_update: false,
          can_delete: false,
        });
        await expectDatabaseError(tx, { code: "42501" }, () =>
          withRole(tx, role, async (restrictedTx) => {
            await restrictedTx`select operation_id from content_access_operations`;
          }),
        );
        await expectDatabaseError(tx, { code: "42501" }, () =>
          withRole(tx, role, async (restrictedTx) => {
            await restrictedTx`
              insert into content_access_operations (
                operation_id, request_digest, memory_id, outcome, changed,
                attached_count, detached_count, skipped_count
              ) values (
                ${randomUUID()}, ${"2".repeat(64)}, ${fixture.memoryId},
                'denied', false, 0, 0, 0
              )
            `;
          }),
        );
      }

      const [productPrivileges] = await tx<{
        can_select: boolean;
        can_insert: boolean;
        can_update: boolean;
        can_delete: boolean;
      }[]>`
        select
          has_table_privilege('nautilo', 'public.content_access_operations', 'SELECT') as can_select,
          has_table_privilege('nautilo', 'public.content_access_operations', 'INSERT') as can_insert,
          has_table_privilege('nautilo', 'public.content_access_operations', 'UPDATE') as can_update,
          has_table_privilege('nautilo', 'public.content_access_operations', 'DELETE') as can_delete
      `;
      expect(productPrivileges).toEqual({
        can_select: true,
        can_insert: true,
        // PostgreSQL table owners retain inherent privileges even after an
        // explicit REVOKE. FORCE RLS plus the absent policies are the actual
        // product-role mutation boundary exercised below.
        can_update: true,
        can_delete: true,
      });
      await expectDatabaseError(tx, { code: "23514" }, () =>
        withRole(tx, "nautilo", async (productTx) => {
          await productTx`
            update content_access_operations
            set skipped_count = 2
            where operation_id = ${operationId}
          `;
        }),
      );
      await expectDatabaseError(tx, { code: "23514" }, () =>
        withRole(tx, "nautilo", async (productTx) => {
          await productTx`
            update content_access_operations
            set requester_user_id = null, requester_actor_id = null
            where operation_id = ${operationId}
          `;
        }),
      );
      await expectDatabaseError(tx, { code: "23514" }, () =>
        withRole(tx, "nautilo", async (productTx) => {
          await productTx`
            delete from content_access_operations
            where operation_id = ${operationId}
          `;
        }),
      );
      await expectDatabaseError(tx, { code: "23514" }, () =>
        withRole(tx, "nautilo", async (productTx) => {
          await productTx`truncate table content_access_operations`;
        }),
      );

      const [unchanged] = await withRole(tx, "nautilo", (productTx) =>
        productTx<{ skipped_count: number }[]>`
          select skipped_count from content_access_operations
          where operation_id = ${operationId}
        `,
      );
      expect(unchanged?.skipped_count).toBe(1);
    });
  });
});
