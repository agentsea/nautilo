import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTableConfig } from "drizzle-orm/pg-core";
import { BOLTER_BRIDGE_MARKER, BOLTER_BRIDGE_TABLES, finalizeBolterBridgeMigration } from "../../scripts/finalize-bolter-bridge";
import { bolterConnections, bolterRoomBindings, bolterInboxReceipts, bolterOutbox } from "../../src/schema/bolter-bridge";
import { buildAgentRoleGrantsSql, buildBolterBridgeRoleGrantsSql } from "../../src/utils/agent-role-grants";
import { buildAppRoleOwnershipRepairSql } from "../../src/utils/legacy-role-repair";
import { BOLTER_EXECUTION_MARKER, finalizeBolterExecutionMigration, finalizeBolterExecutionGuardCorrection, BOLTER_EXECUTION_CORRECTION_MARKER, finalizeBolterAssistantTurnCorrection, BOLTER_ASSISTANT_TURN_MARKER, finalizeExternalAuthorshipMigration, EXTERNAL_AUTHORSHIP_MARKER } from "../../scripts/finalize-bolter-execution";
import { BOLTER_FK_MARKER, finalizeBolterFactoryMigration, finalizeBolterForeignKeyMigration } from "../../scripts/finalize-bolter-factory";

const directory = resolve(import.meta.dir, "../../src/migrations");
const journal = JSON.parse(readFileSync(resolve(directory, "meta/_journal.json"), "utf8")) as { entries: { idx: number; tag: string; when: number }[] };
const tag = journal.entries.find(entry => entry.idx === 341)?.tag;
if (!tag) throw new Error("Bolter migration journal entry is missing");
const migration = readFileSync(resolve(directory, `${tag}.sql`), "utf8");
const factoryTag = journal.entries.find(entry => entry.idx === 342)?.tag;
if (!factoryTag) throw new Error("Bolter factory migration journal entry is missing");
const factoryMigration = readFileSync(resolve(directory, `${factoryTag}.sql`), "utf8");
const fkTag = journal.entries.find(entry => entry.idx === 343)?.tag;
if (!fkTag) throw new Error("Bolter FK migration journal entry is missing");
const fkMigration = readFileSync(resolve(directory, `${fkTag}.sql`), "utf8");
type Snapshot = { id: string; prevId: string; tables: Record<string, { columns: Record<string, unknown>; policies: Record<string, { to: string[] }> }> };
const readSnapshot = (index: number) => JSON.parse(readFileSync(resolve(directory, `meta/${index.toString().padStart(4, "0")}_snapshot.json`), "utf8")) as Snapshot;
const snapshot = readSnapshot(341);

describe("Bolter generated database boundary", () => {
  test("execution schema and guard finalizer are exactly reproducible after the applied tail", () => {
    const entry = journal.entries.find(row => row.idx === 344)!;
    const execution = readFileSync(resolve(directory, `${entry.tag}.sql`), "utf8");
    const prefix = execution.slice(0, execution.indexOf(`\n--> statement-breakpoint\n${BOLTER_EXECUTION_MARKER}`));
    expect(finalizeBolterExecutionMigration(prefix, { historicalAlias: true, historicalAssistantTurn: true })).toBe(execution);
    expect(entry.when).toBeGreaterThan(journal.entries.find(row => row.idx === 343)!.when);
    const executionSnapshot = readSnapshot(344);
    expect(executionSnapshot.prevId).toBe(readSnapshot(343).id);
    expect(executionSnapshot.tables["public.bolter_room_bindings"]?.columns["model_sponsorship_accepted_at"]).toMatchObject({ notNull: false });
    expect(execution).toContain('CREATE UNIQUE INDEX "bolter_outbox_final_reply"');
    expect(execution).toContain('WHERE "bolter_outbox"."source_inbox_id" IS NOT NULL');
  });

  test("corrective migration changes only the inbox function alias after the applied execution migration", () => {
    const entry = journal.entries.find(row => row.idx === 345)!;
    const correction = readFileSync(resolve(directory, `${entry.tag}.sql`), "utf8");
    const prefix = correction.slice(0, correction.indexOf(`\n--> statement-breakpoint\n${BOLTER_EXECUTION_CORRECTION_MARKER}`));
    expect(finalizeBolterExecutionGuardCorrection(prefix)).toBe(correction);
    expect(correction).toContain("public.jobs canonical_job WHERE canonical_job.id = NEW.job_id");
    expect(correction).not.toContain("public.jobs j WHERE j.id = NEW.job_id");
    expect(correction.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(1);
    expect(correction).not.toContain("CREATE TRIGGER");
    expect(readSnapshot(345).tables).toEqual(readSnapshot(344).tables);
    expect(readSnapshot(345).prevId).toBe(readSnapshot(344).id);
    expect(entry.when).toBeGreaterThan(journal.entries.find(row => row.idx === 344)!.when);
  });

  test("assistant compatibility preserves canonical role semantics and restrictive provenance persists independently", () => {
    const assistantEntry = journal.entries.find(row => row.idx === 346)!;
    const assistant = readFileSync(resolve(directory, `${assistantEntry.tag}.sql`), "utf8");
    expect(finalizeBolterAssistantTurnCorrection(assistant.slice(0, assistant.indexOf(`\n--> statement-breakpoint\n${BOLTER_ASSISTANT_TURN_MARKER}`)))).toBe(assistant);
    expect(assistant).toContain("m.human_turn_id IS NULL");
    expect(assistant).not.toContain("m.human_turn_id = i.turn_id");
    const markerEntry = journal.entries.find(row => row.idx === 347)!;
    const marker = readFileSync(resolve(directory, `${markerEntry.tag}.sql`), "utf8");
    expect(finalizeExternalAuthorshipMigration(marker.slice(0, marker.indexOf(`\n--> statement-breakpoint\n${EXTERNAL_AUTHORSHIP_MARKER}`)))).toBe(marker);
    expect(marker).toContain('ADD COLUMN "external_authorship" boolean DEFAULT false NOT NULL');
    expect(marker).toContain("OLD.external_authorship AND NOT NEW.external_authorship");
    expect(marker).toContain("m.external_authorship");
    expect(marker).toContain("OR EXISTS (SELECT 1 FROM public.bolter_inbox_receipts i WHERE i.session_message_id = m.id)");
    expect(readSnapshot(347).prevId).toBe(readSnapshot(346).id);
    expect(markerEntry.when).toBeGreaterThan(assistantEntry.when);
  });

  test("rebased migrations preserve SQL identities after the complete main watermark", () => {
    const identities = [
      [341, "0341_bent_dust", "a8ec1bf41169f027549ad0381bb61387b7a4e5c413499b2ecb53922cfd671989"],
      [342, "0342_stale_vermin", "79fbe2b2518d080228902f4adbea6e8b7a4e57e87a69751ba1f478cc7970b6fc"],
      [343, "0343_bolter_fk_permissions", "14d0d6b2a7faea6accd021c3dc23a7ddb2487468e652153d37f9946af379819b"],
      [344, "0344_mysterious_runaways", "e80e583c0ab40db13668a6e98fea9bd838d227ac2286ac3d8dd8371cdb15936a"],
      [345, "0345_bolter_execution_guard", "ca65fd45bed7d6e938d2bd98e4e79f452e35f7eb3eb99a6f27d79c9a96606c34"],
      [346, "0346_bolter_assistant_turn", "36c3d2f592e8e2cf24e069d72d6db5abe911bb45c1b7a8e05731eb0a096ff718"],
      [347, "0347_steep_wendell_vaughn", "5bd30ed1ff196653e9bc3ab1d859164257b9b213752f1bb93c6a33f9fb36d46e"],
      [348, "0348_lumpy_spot", "4736e2ab44cb61ff4cbf9c59d8e70f502e7a527c1e29a41f72deb61caa19cc54"],
      [349, "0349_external_room_namespace_claim", "7d54a1fc36d793604b3a5bb9b9bab3a9493fc7c68c15e6448d66a9097f34c857"],
    ] as const;
    const mainTail = journal.entries.find(entry => entry.idx === 340)!;
    expect(mainTail.tag).toBe("0340_omniscient_norman_osborn");
    let previous = mainTail;
    for (const [idx, tag, hash] of identities) {
      const entry = journal.entries.find(entry => entry.idx === idx)!;
      expect(entry).toMatchObject({ idx, tag });
      expect(createHash("sha256").update(readFileSync(resolve(directory, `${tag}.sql`))).digest("hex")).toBe(hash);
      expect(entry.when).toBeGreaterThan(previous.when);
      expect(readSnapshot(idx).prevId).toBe(readSnapshot(previous.idx).id);
      previous = entry;
    }
  });

  test("cumulative snapshots retain main tables and each Bolter policy stage in one ancestry", () => {
    const mainSnapshot = readSnapshot(340);
    let previous = mainSnapshot;
    for (const index of [341, 342, 343]) {
      const stage = readSnapshot(index);
      expect(stage.prevId).toBe(previous.id);
      expect(stage.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
      for (const [name, table] of Object.entries(mainSnapshot.tables)) {
        if (name !== "public.rooms") expect(stage.tables[name]).toEqual(table);
      }
      expect(stage.tables["public.rooms"]?.columns["external_context"]).toBeDefined();
      const expectedRoles = index === 341 ? ["nautilo_agent"] : ["nautilo", "nautilo_agent"];
      expect(stage.tables["public.bolter_connections"]?.policies["bolter_connections_owner"]?.to).toEqual(expectedRoles);
      expect(stage.tables["public.bolter_room_bindings"]?.policies["bolter_bindings_owner"]?.to).toEqual(expectedRoles);
      previous = stage;
    }
    expect(readSnapshot(343).tables).toEqual(readSnapshot(342).tables);
  });

  test("generator captured four metadata tables and the canonical Room marker", () => {
    expect(migration).toContain('ALTER TABLE "rooms" ADD COLUMN "external_context" boolean DEFAULT false NOT NULL');
    expect(snapshot.tables["public.rooms"]?.columns['external_context']).toBeDefined();
    for (const table of BOLTER_BRIDGE_TABLES) expect(snapshot.tables[`public.${table}`]).toBeDefined();
    for (const table of [bolterConnections, bolterRoomBindings, bolterInboxReceipts, bolterOutbox]) {
      const config = getTableConfig(table);
      expect(config.enableRLS).toBe(true);
      expect(config.policies).toHaveLength(1);
      if (config.name === "bolter_connections" || config.name === "bolter_room_bindings") expect(config.policies[0]?.to).toEqual(["nautilo_agent", "nautilo"]);
      else expect(config.policies[0]?.to).toBe("nautilo_agent");
      for (const column of config.columns) expect(["content", "body", "payload", "raw_message", "credentials", "home_path", "external_sender_label"]).not.toContain(column.name);
    }
  });

  test("composite foreign keys retain owner and exact routing scope", () => {
    const bindings = getTableConfig(bolterRoomBindings);
    const inbox = getTableConfig(bolterInboxReceipts);
    const outbox = getTableConfig(bolterOutbox);
    expect(bindings.foreignKeys.map(key => key.getName())).toContain("bolter_bindings_connection_owner");
    expect(bindings.foreignKeys.map(key => key.getName())).toContain("bolter_bindings_exact_namespace");
    expect(inbox.foreignKeys.map(key => key.getName())).toContain("bolter_inbox_binding_owner");
    expect(outbox.foreignKeys.map(key => key.getName())).toContain("bolter_outbox_reply_owner");
    expect(migration).toContain('FOREIGN KEY ("user_id","binding_id","source_inbox_id")');
    const scope = bindings.indexes.find(index => index.config.name === "bolter_bindings_external_identity")!;
    expect(scope.config.columns.map(column => "name" in column ? column.name : "expression")).toEqual(["connection_id", "origin", "provider_agent_id", "chat_id", "thread_id"]);
    // Identical short chat/agent/message IDs in two connections have distinct keys;
    // conflicting message fingerprints within one binding quarantine in query tests.
    expect(migration).toContain('"bolter_inbox_provider_message" ON "bolter_inbox_receipts"');
    expect(bolterRoomBindings.threadId.notNull).toBe(true);
  });

  test("forces owner RLS and grants only the restricted agent role table access", () => {
    for (const table of BOLTER_BRIDGE_TABLES) {
      expect(migration).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      expect(migration).toContain(`GRANT SELECT, INSERT, UPDATE ON TABLE "${table}" TO "nautilo_agent"`);
      expect(migration).toContain(`REVOKE ALL PRIVILEGES ON TABLE "${table}" FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto"`);
    }
    expect(migration.match(/SECURITY DEFINER/gu)).toHaveLength(1);
    expect(migration).toContain("RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog");
    expect(migration).toContain("public.bolter_room_admission(uuid,uuid,uuid,uuid) OWNER TO nautilo");
    expect(migration).toContain("::uuid = p_user AND EXISTS");
    expect(migration).toContain("app.current_user_id");
  });

  test("finalization is reproducible, idempotent, and leaves unrelated migrations alone", () => {
    const unrelated = 'CREATE TABLE "unrelated" (id integer);';
    expect(finalizeBolterBridgeMigration(unrelated)).toBe(unrelated);
    expect(finalizeBolterBridgeMigration(migration)).toBe(migration);
    const boundary = migration.indexOf(`\n--> statement-breakpoint\n${BOLTER_BRIDGE_MARKER}`);
    expect(boundary).toBeGreaterThan(0);
    expect(finalizeBolterBridgeMigration(migration.slice(0, boundary))).toBe(migration);
  });

  test("both startup role repairs restore the exact Bolter contract after broad grants", () => {
    const bounded = buildBolterBridgeRoleGrantsSql();
    for (const source of [buildAgentRoleGrantsSql(), buildAppRoleOwnershipRepairSql()]) {
      expect(source).toContain(bounded);
      expect(source.indexOf(bounded)).toBeGreaterThan(source.indexOf("ON ALL TABLES IN SCHEMA public"));
    }
    expect(bounded).toContain("GRANT SELECT, INSERT, UPDATE ON TABLE");
    expect(bounded).not.toContain("GRANT SELECT, INSERT, UPDATE, DELETE");
    expect(bounded).toContain("pg_get_functiondef(to_regprocedure('public.guard_bolter_connection()'))");
    expect(bounded).toContain("GRANT SELECT, UPDATE ON TABLE public.bolter_connections TO nautilo");
  });

  test("corrective factory is reproducible and removes the unreliable transaction heuristic", () => {
    expect(factoryMigration).toContain("GRANT SELECT, INSERT ON TABLE public.bolter_room_bindings TO nautilo");
    expect(factoryMigration).toContain("IS DISTINCT FROM NEW.user_id");
    expect(factoryMigration).not.toContain("pg_current_xact_id");
    expect(factoryMigration).not.toContain("minted_room");
    expect(factoryMigration).toContain("BYPASSRLS; explicit owner query predicates");
    expect(finalizeBolterFactoryMigration(factoryMigration)).toBe(factoryMigration);
    const boundary = factoryMigration.indexOf("\n--> statement-breakpoint\n-- BOLTER_FACTORY_PRODUCT_AUTHORITY");
    expect(finalizeBolterFactoryMigration(factoryMigration.slice(0, boundary))).toBe(factoryMigration);
  });

  test("foreign-key correction grants structural columns and owner deletion only", () => {
    expect(fkMigration).toContain("GRANT SELECT(id,user_id,binding_id,session_message_id,job_id), UPDATE(id)");
    expect(fkMigration).toContain("GRANT SELECT(user_id,binding_id,source_inbox_id,session_message_id), UPDATE(id)");
    expect(fkMigration).toContain("GRANT DELETE ON TABLE public.bolter_outbox, public.bolter_inbox_receipts");
    expect(fkMigration).not.toContain("TO nautilo_agent");
    expect(fkMigration).not.toContain("GRANT UPDATE ON");
    expect(finalizeBolterForeignKeyMigration(fkMigration)).toBe(fkMigration);
    const boundary = fkMigration.indexOf(`\n-- ${BOLTER_FK_MARKER}`);
    expect(finalizeBolterForeignKeyMigration(fkMigration.slice(0, boundary))).toBe(fkMigration);
    expect(buildBolterBridgeRoleGrantsSql()).toContain(`= '${BOLTER_FK_MARKER}'`);
  });

  test("keeps Room marker and binding tuple immutable while canonical factory establishes mint freshness", () => {
    expect(migration).toContain("OLD.external_context IS DISTINCT FROM NEW.external_context");
    expect(migration).toContain("to_jsonb(OLD) - ARRAY['state','revision','updated_at']");
    expect(migration).toContain("OLD.state = 'revoked'");
    expect(migration).toContain("NEW.revision <> OLD.revision + 1");
    expect(migration).toContain("r.owner_id <> NEW.user_id");
    expect(migration).toContain("public.room_event_rollups WHERE room_id = r.id");
    expect(migration).toContain("public.room_journal_batches WHERE room_id = r.id");
    // xmin also changes on UPDATE. It is only a transaction/empty-context
    // cross-check: the server-owned creation callback is the mint guarantee.
    expect(migration).toContain("pg_current_xact_id()");
    const finalizer = readFileSync(resolve(import.meta.dir, "../../scripts/finalize-bolter-bridge.ts"), "utf8");
    expect(finalizer).toContain("xmin only proves insertion OR update");
  });

  test("canonical source ownership and terminal uncertainty are checked in database triggers", () => {
    expect(migration).toContain("s.owner_id = NEW.user_id AND s.room_id = b.room_id");
    expect(migration).toContain("s.agent_id = b.agent_id AND m.role = 'user'");
    expect(migration).toContain("j.requestor_id = NEW.user_id AND j.room_id = b.room_id");
    expect(migration).toContain("i.state = 'accepted' AND i.binding_revision = NEW.binding_revision");
    expect(migration).toContain("OLD.claim_token IS DISTINCT FROM NEW.claim_token");
    expect(migration).toContain("OLD.state = 'pending' AND NEW.state IN ('publishing','cancelled')");
    expect(migration).toContain("OLD.state = 'publishing' AND NEW.state IN ('published','uncertain','cancelled')");
    expect(migration).not.toContain("OLD.state = 'uncertain' AND NEW.state = 'pending'");
  });
});
