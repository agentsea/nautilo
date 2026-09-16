import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { artifactRelocationMutationSql, relocatedSnapshot, type ArtifactRelocationPlan, type StorageSnapshot } from "../../src/artifact-relocation.ts";

const enabled = process.env["NAUTILO_ARTIFACT_RELOCATION_INTEGRATION"] === "1";
const container = `nautilo-relocation-test-${randomUUID()}`;
let owned = false;
async function run(args: string[], input?: string) {
  const child = Bun.spawn(args, { stdin: input === undefined ? "ignore" : new Blob([input]), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}
afterAll(async () => { if (owned) await run(["docker", "rm", "-f", container]); });

test.skipIf(!enabled)("owned PostgreSQL proves exact five-column repair, inverse rollback and transactional rejection", async () => {
  const start = await run(["docker", "run", "-d", "--name", container, "--network", "none", "--tmpfs", "/var/lib/postgresql/data", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "pgvector/pgvector:pg17"]);
  expect(start.code, start.stderr).toBe(0); owned = true;
  // PostgreSQL readiness owns its own bounded wait; there is no product retry policy here.
  const ready = await run(["docker", "exec", container, "sh", "-c", "until pg_isready -h 127.0.0.1 -U postgres >/dev/null; do sleep 0.1; done"]);
  expect(ready.code).toBe(0);
  const sql = (input: string) => run(["docker", "exec", "-i", "-u", "postgres", container, "psql", "-X", "-q", "-At", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-f", "-"], input);
  const setup = await sql(`
CREATE TABLE nautilo_instance_identity(id text primary key, instance_id text, server_instance_id uuid);
INSERT INTO nautilo_instance_identity VALUES ('self','fixture','f0000000-0000-4000-8000-000000000000');
CREATE TABLE artifacts(id uuid primary key, storage_uri text, size bigint, revision integer, path text, crypto_object_id text);
INSERT INTO artifacts VALUES ('a0000000-0000-4000-8000-000000000000','file:///old/artifacts/head',8,7,'quote'' $relocation$ ; COMMIT; --',null);
CREATE TABLE message_attachments(id uuid primary key, storage_uri text, size_bytes bigint);
INSERT INTO message_attachments VALUES ('b0000000-0000-4000-8000-000000000000','file:///old/artifacts/attachment',8);
CREATE TABLE workspace_document_mutation_entries(id uuid primary key, before_storage_uri text, after_storage_uri text, destination_before_storage_uri text, before_size bigint, after_size bigint, destination_before_size bigint, before_sha256 text, after_sha256 text, destination_before_sha256 text, mutation_id text);
INSERT INTO workspace_document_mutation_entries VALUES ('c0000000-0000-4000-8000-000000000000','file:///old/artifacts/history','file:///old/artifacts/history','file:///old/artifacts/history',8,8,8,repeat('a',64),repeat('a',64),repeat('a',64),'retained-history');
`);
  expect(setup.code, setup.stderr).toBe(0);
  const read = async () => { const result = await sql(`SELECT jsonb_build_object(
'identity', (SELECT to_jsonb(t) FROM nautilo_instance_identity t WHERE id='self'),
'artifacts', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM artifacts t),
'message_attachments', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM message_attachments t),
'workspace_document_mutation_entries', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM workspace_document_mutation_entries t));`); expect(result.code, result.stderr).toBe(0); return JSON.parse(result.stdout) as StorageSnapshot; };
  const before = await read();
  const plan: ArtifactRelocationPlan = { schemaVersion: 1, sourceRoot: "/old/artifacts", targetRoot: "/new/artifacts", target: { instanceId: "fixture", project: "fixture", serverContainer: "server", databaseContainer: "db", imageId: "image", artifactsRoot: "/new/artifacts" }, before, files: [], source: { bundlePath: "/backup", manifestSha256: "a".repeat(64), archiveSha256: "b".repeat(64), files: [] } };
  const applied = await sql(artifactRelocationMutationSql(plan)); expect(applied.code, applied.stderr).toBe(0);
  expect(await read()).toEqual(relocatedSnapshot(plan));
  const rollback = await sql(artifactRelocationMutationSql(plan, true)); expect(rollback.code, rollback.stderr).toBe(0);
  expect(await read()).toEqual(before);
  await sql("UPDATE artifacts SET revision=8;");
  const concurrent = await sql(artifactRelocationMutationSql(plan)); expect(concurrent.code).not.toBe(0);
  expect((await read()).artifacts[0]!["storage_uri"]).toBe(before.artifacts[0]!["storage_uri"]);
  await sql("UPDATE artifacts SET revision=7;");
  // Fail after the first table's update: every earlier update must roll back.
  await sql("CREATE FUNCTION reject_relocation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure'; END $$; CREATE TRIGGER rejection BEFORE UPDATE ON message_attachments FOR EACH ROW EXECUTE FUNCTION reject_relocation();");
  const failed = await sql(artifactRelocationMutationSql(plan)); expect(failed.code).not.toBe(0); expect(await read()).toEqual(before);
}, 30_000);
