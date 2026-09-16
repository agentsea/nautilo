/**
 * Repairs Drizzle meta snapshot chain for hand-written migrations
 * 0028–0030 (M066 invites + ambitious_betty_brant) layered on top of
 * main's 0027 snapshot (D104 logto account security / recovery codes).
 *
 * Without these snapshots, `drizzle-kit generate` diffs main's 0027
 * against the current schema (`invites` table + `uq_groups_agent_id_type`)
 * and prompts spurious changes — blocking CI and agents.
 *
 * Run from repo root:
 *   cd packages/db && bun scripts/repair-migration-meta-snapshots.mjs
 *
 * By default only writes `0034_snapshot.json` from `0033_snapshot.json`
 * plus `uq_sessions_owner_thread` (M075 hand migration). Keeps
 * `drizzle-kit check` green without running `db:generate` for SQL-only
 * migrations.
 *
 * Optional: pass `--regenerate-m066-0028-0030` to rebuild 0028–0030 from
 * `0027_snapshot.json` (new random snapshot ids each run — only use when
 * you intentionally need to repair those files).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const metaDir = join(__dirname, "../src/migrations/meta");

/** @param {string} prevId @param {object} snap */
function assignSnapshotChain(prevId, snap) {
  const id = randomUUID();
  snap.id = id;
  snap.prevId = prevId;
  return id;
}

/** Matches `invites.ts` (CHECK / partial unique live only in 0029 SQL). */
function invitesTable() {
  return {
    name: "invites",
    schema: "",
    columns: {
      id: {
        name: "id",
        type: "uuid",
        primaryKey: true,
        notNull: true,
        default: "gen_random_uuid()",
      },
      token_hash: {
        name: "token_hash",
        type: "text",
        primaryKey: false,
        notNull: true,
      },
      kind: {
        name: "kind",
        type: "text",
        primaryKey: false,
        notNull: true,
      },
      target_agent_id: {
        name: "target_agent_id",
        type: "uuid",
        primaryKey: false,
        notNull: false,
      },
      target_group_id: {
        name: "target_group_id",
        type: "uuid",
        primaryKey: false,
        notNull: false,
      },
      target_room_id: {
        name: "target_room_id",
        type: "uuid",
        primaryKey: false,
        notNull: false,
      },
      max_uses: {
        name: "max_uses",
        type: "integer",
        primaryKey: false,
        notNull: false,
      },
      used_count: {
        name: "used_count",
        type: "integer",
        primaryKey: false,
        notNull: true,
        default: 0,
      },
      created_by: {
        name: "created_by",
        type: "uuid",
        primaryKey: false,
        notNull: false,
      },
      display_name: {
        name: "display_name",
        type: "text",
        primaryKey: false,
        notNull: false,
      },
      expires_at: {
        name: "expires_at",
        type: "timestamp",
        primaryKey: false,
        notNull: false,
      },
      revoked_at: {
        name: "revoked_at",
        type: "timestamp",
        primaryKey: false,
        notNull: false,
      },
      created_at: {
        name: "created_at",
        type: "timestamp",
        primaryKey: false,
        notNull: true,
        default: "now()",
      },
    },
    indexes: {
      uq_invites_token_hash: {
        name: "uq_invites_token_hash",
        columns: [
          {
            expression: "token_hash",
            isExpression: false,
            asc: true,
            nulls: "last",
          },
        ],
        isUnique: true,
        concurrently: false,
        method: "btree",
        with: {},
      },
      idx_invites_created_by: {
        name: "idx_invites_created_by",
        columns: [
          {
            expression: "created_by",
            isExpression: false,
            asc: true,
            nulls: "last",
          },
        ],
        isUnique: false,
        concurrently: false,
        method: "btree",
        with: {},
      },
    },
    foreignKeys: {
      invites_target_agent_id_agents_id_fk: {
        name: "invites_target_agent_id_agents_id_fk",
        tableFrom: "invites",
        tableTo: "agents",
        columnsFrom: ["target_agent_id"],
        columnsTo: ["id"],
        onDelete: "cascade",
        onUpdate: "no action",
      },
      invites_target_group_id_groups_id_fk: {
        name: "invites_target_group_id_groups_id_fk",
        tableFrom: "invites",
        tableTo: "groups",
        columnsFrom: ["target_group_id"],
        columnsTo: ["id"],
        onDelete: "cascade",
        onUpdate: "no action",
      },
      invites_target_room_id_rooms_id_fk: {
        name: "invites_target_room_id_rooms_id_fk",
        tableFrom: "invites",
        tableTo: "rooms",
        columnsFrom: ["target_room_id"],
        columnsTo: ["id"],
        onDelete: "cascade",
        onUpdate: "no action",
      },
      invites_created_by_users_id_fk: {
        name: "invites_created_by_users_id_fk",
        tableFrom: "invites",
        tableTo: "users",
        columnsFrom: ["created_by"],
        columnsTo: ["id"],
        onDelete: "cascade",
        onUpdate: "no action",
      },
    },
    compositePrimaryKeys: {},
    uniqueConstraints: {},
    policies: {},
    checkConstraints: {},
    isRLSEnabled: false,
  };
}

/** Partial unique index added by 0030_ambitious_betty_brant. */
function uqGroupsAgentIdTypeIndex() {
  return {
    name: "uq_groups_agent_id_type",
    columns: [
      {
        expression: "agent_id",
        isExpression: false,
        asc: true,
        nulls: "last",
      },
      {
        expression: "type",
        isExpression: false,
        asc: true,
        nulls: "last",
      },
    ],
    isUnique: true,
    where: '"groups"."agent_id" IS NOT NULL',
    concurrently: false,
    method: "btree",
    with: {},
  };
}

const regenerateM066 = process.argv.includes("--regenerate-m066-0028-0030");
if (regenerateM066) {
  const snap27 = JSON.parse(readFileSync(join(metaDir, "0027_snapshot.json"), "utf8"));
  let prevId = snap27.id;

  // --- 0028 M066 invites (table + FKs + indexes from schema) ---
  const s28 = structuredClone(snap27);
  prevId = assignSnapshotChain(prevId, s28);
  s28.tables["public.invites"] = invitesTable();
  writeFileSync(join(metaDir, "0028_snapshot.json"), `${JSON.stringify(s28, null, 2)}\n`);

  // --- 0029 CHECK constraints + partial unique: not modeled in Drizzle schema → snapshot unchanged vs 0028 ---
  const s29 = structuredClone(s28);
  prevId = assignSnapshotChain(prevId, s29);
  writeFileSync(join(metaDir, "0029_snapshot.json"), `${JSON.stringify(s29, null, 2)}\n`);

  // --- 0030 ambitious_betty_brant: partial unique index on groups(agent_id, type) ---
  const s30 = structuredClone(s29);
  prevId = assignSnapshotChain(prevId, s30);
  s30.tables["public.groups"].indexes.uq_groups_agent_id_type = uqGroupsAgentIdTypeIndex();
  writeFileSync(join(metaDir, "0030_snapshot.json"), `${JSON.stringify(s30, null, 2)}\n`);

  console.log(
    `Wrote 0028–0030 from 0027 (chain ends 0030 id=${prevId.slice(0, 8)}…). ` +
      `You must fix 0031_snapshot.json prevId → that 0030 id if the chain broke.`,
  );
}

// --- 0034 M075 — unique index uq_sessions_owner_thread (see sessions.ts) ---
const snap33 = JSON.parse(readFileSync(join(metaDir, "0033_snapshot.json"), "utf8"));
const s34 = structuredClone(snap33);
const id34 = assignSnapshotChain(snap33.id, s34);
s34.tables["public.sessions"].indexes.uq_sessions_owner_thread = {
  name: "uq_sessions_owner_thread",
  columns: [
    {
      expression: "owner_id",
      isExpression: false,
      asc: true,
      nulls: "last",
    },
    {
      expression: "thread_id",
      isExpression: false,
      asc: true,
      nulls: "last",
    },
  ],
  isUnique: true,
  concurrently: false,
  method: "btree",
  with: {},
};
writeFileSync(join(metaDir, "0034_snapshot.json"), `${JSON.stringify(s34, null, 2)}\n`);

console.log(
  `Wrote 0034 from 0033 + uq_sessions_owner_thread (id=${id34.slice(0, 8)}…).`,
);
