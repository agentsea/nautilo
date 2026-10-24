import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres, { type Sql } from "postgres";
import { buildBolterBridgeRoleGrantsSql } from "../../src/utils/agent-role-grants";

// Explicit disposable cluster only; never resolves a configured instance.
const adminUrl = process.env["NAUTILO_CONTROL_ARCHIVE_TEST_ADMIN_URL"];
const suite = adminUrl ? describe : describe.skip;
const suffix = randomUUID().replaceAll("-", "");
const database = `control_archive_${suffix}`;
const productRole = `archive_product_${suffix}`;
const agentRole = `archive_agent_${suffix}`;
const cryptoRole = `archive_crypto_${suffix}`;
const owner = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
let admin: Sql;
let db: Sql;
let product: Sql;
let databaseCreated = false;
const createdRoles: string[] = [];
const mapRoles = (source: string): string => source
  .replaceAll(/\bnautilo_agent\b/g, agentRole)
  .replaceAll(/\bnautilo_crypto\b/g, cryptoRole)
  .replaceAll(/\bnautilo\b/g, productRole);
const migration = readFileSync(new URL("../../src/migrations/0385_operator_control_archive_cascade.sql", import.meta.url), "utf8");
const predecessor = readFileSync(new URL("../../src/migrations/0384_heavy_saracen.sql", import.meta.url), "utf8")
  .split("-- EXTERNAL_OPERATOR_LEGACY_ARCHIVE")[0]!;
const repair = mapRoles(buildBolterBridgeRoleGrantsSql());

async function rejects(operation: PromiseLike<unknown>, code: string): Promise<void> {
  let caught: unknown;
  try { await operation; } catch (error) { caught = error; }
  expect(caught).toMatchObject({ code });
}

suite("operator archive immutable owner cascade", () => {
  beforeAll(async () => {
    admin = postgres(adminUrl!, { max: 1 });
    await admin.unsafe(`CREATE DATABASE ${database}`);
    databaseCreated = true;
    for (const role of [productRole, agentRole, cryptoRole]) {
      await admin.unsafe(`CREATE ROLE ${role} ${role === productRole ? "BYPASSRLS" : "NOBYPASSRLS"}`);
      createdRoles.push(role);
    }
    const url = new URL(adminUrl!);
    url.pathname = `/${database}`;
    db = postgres(url.toString(), { max: 1 });
    await db.unsafe(`GRANT USAGE, CREATE ON SCHEMA public TO ${productRole}`);
    await db`CREATE TABLE public.users(id uuid PRIMARY KEY)`;
    await db`INSERT INTO public.users VALUES (${owner}), (${other})`;
    await db.unsafe(mapRoles(predecessor));
    await db.unsafe(`ALTER TABLE public.external_operator_control_archive OWNER TO ${productRole}`);
    await db.unsafe(`GRANT SELECT, DELETE ON public.users TO ${productRole}`);
    await db`INSERT INTO public.external_operator_control_archive
      (message_id,user_id,receipt_id,binding_id,session_id,kind,evidence) VALUES
      (1,${owner},${owner},${owner},${owner},'input','{"message":{"content":"synthetic owner evidence"}}'),
      (2,${other},${other},${other},${other},'result','{"message":{"content":"synthetic other evidence"}}')`;
    await db.unsafe(`REVOKE INSERT, UPDATE, DELETE ON public.external_operator_control_archive FROM ${productRole}`);
    product = postgres(url.toString(), { max: 1 });
    await product.unsafe(`SET ROLE ${productRole}`);
  });

  afterAll(async () => {
    await product?.end();
    await db?.end();
    if (databaseCreated) await admin.unsafe(`DROP DATABASE ${database}`);
    for (const role of createdRoles) await admin.unsafe(`DROP ROLE ${role}`);
    await admin?.end();
  });

  test("corrective migration preserves evidence and permits only canonical owner cleanup", async () => {
    const before = await db`SELECT * FROM public.external_operator_control_archive ORDER BY message_id`;
    // The deployed predecessor revokes the DELETE needed by its FK cascade.
    await rejects(product`DELETE FROM public.users WHERE id = ${owner}`, "42501");
    await product.unsafe(mapRoles(migration));
    expect(await db`SELECT * FROM public.external_operator_control_archive ORDER BY message_id`).toEqual(before);

    const assertImmutable = async (): Promise<void> => {
      await product`SELECT set_config('app.current_user_id', ${owner}, false)`;
      for (const id of [1, 2]) await rejects(product`DELETE FROM public.external_operator_control_archive WHERE message_id = ${id}`, "23514");
      await rejects(product`UPDATE public.external_operator_control_archive SET evidence = '{}' WHERE message_id = 1`, "42501");
      await rejects(product`INSERT INTO public.external_operator_control_archive SELECT * FROM public.external_operator_control_archive WHERE message_id = 1`, "42501");
      await rejects(product`TRUNCATE public.external_operator_control_archive`, "42501");
    };
    await assertImmutable();
    // Reproduce restore's broad grants, then apply the actual shared reconciler.
    await db.unsafe(`GRANT ALL ON public.external_operator_control_archive TO ${productRole}, ${agentRole}, ${cryptoRole}, PUBLIC`);
    await db.unsafe(repair);
    await db.unsafe(repair);
    await assertImmutable();
    // Legacy restore runs COPY as the privileged database administrator after
    // migrations. Preserve exact audit rows without disabling FK/guard triggers.
    const copy = await db`COPY public.external_operator_control_archive
      (message_id,user_id,receipt_id,binding_id,session_id,kind,evidence) FROM STDIN`.writable();
    await new Promise<void>((resolve, reject) => {
      copy.on("finish", resolve).on("error", reject);
      copy.end(`3\t${owner}\t${owner}\t${owner}\t${owner}\tinput\t{"message":{"content":"synthetic restored evidence"}}\n`);
    });
    expect((await db`SELECT evidence FROM public.external_operator_control_archive WHERE message_id = 3`)[0]?.["evidence"])
      .toEqual({ message: { content: "synthetic restored evidence" } });
    for (const role of [agentRole, cryptoRole]) {
      expect((await db`SELECT has_table_privilege(${role}, 'public.external_operator_control_archive', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS allowed`)[0]?.["allowed"]).toBe(false);
      expect((await db`SELECT has_function_privilege(${role}, 'public.guard_external_operator_control_archive()', 'EXECUTE') AS allowed`)[0]?.["allowed"]).toBe(false);
    }
    // Forced RLS protects non-bypass callers; the actual product role above
    // bypasses RLS, so direct-mutation safety must come from the trigger.
    await admin.unsafe(`ALTER ROLE ${productRole} NOBYPASSRLS`);
    expect([...(await product`SELECT message_id FROM public.external_operator_control_archive ORDER BY message_id`)]).toEqual([{ message_id: 1 }, { message_id: 3 }]);
    await product`SELECT set_config('app.current_user_id', '', false)`;
    expect((await product`SELECT message_id FROM public.external_operator_control_archive`)).toHaveLength(0);
    await admin.unsafe(`ALTER ROLE ${productRole} BYPASSRLS`);
    // Missing/disabled guards must never reopen DELETE during older restores.
    await db`ALTER TABLE public.external_operator_control_archive DISABLE TRIGGER external_control_archive_immutable_row`;
    await db.unsafe(repair);
    await rejects(product`DELETE FROM public.external_operator_control_archive WHERE message_id = 1`, "42501");
    await db`ALTER TABLE public.external_operator_control_archive ENABLE TRIGGER external_control_archive_immutable_row`;
    await db.unsafe(repair);
    await product`SELECT set_config('app.current_user_id', ${owner}, false)`;
    await product`DELETE FROM public.users WHERE id = ${owner}`;
    expect([...(await db`SELECT message_id FROM public.external_operator_control_archive`)]).toEqual([{ message_id: 2 }]);
    expect([...(await db`SELECT id FROM public.users`)]).toEqual([{ id: other }]);
  });
});
