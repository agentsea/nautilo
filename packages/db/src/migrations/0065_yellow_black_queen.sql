-- M131: IF NOT EXISTS so the migration reconciles a stray junction left by
-- an out-of-band `drizzle-kit push` (composite PK, no FKs) on dev DBs; the
-- ADD CONSTRAINT statements below then attach the FKs. Harmless on clean
-- instances where the table is brand-new to this migration.
CREATE TABLE IF NOT EXISTS "group_roles" (
	"group_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	CONSTRAINT "group_roles_group_id_role_id_pk" PRIMARY KEY("group_id","role_id")
);
--> statement-breakpoint
-- M131: drop the groups→roles FK before dropping role_id. The constraint
-- name drifts across instances: drizzle-clean DBs name it
-- `groups_role_id_roles_id_fk`, while DBs where role_id was added via an
-- inline REFERENCES carry Postgres's default `groups_role_id_fkey`. Guard
-- both with IF EXISTS so the migration is name-agnostic; the trailing
-- `DROP COLUMN "role_id"` removes any remaining dependent FK regardless.
ALTER TABLE "groups" DROP CONSTRAINT IF EXISTS "groups_role_id_roles_id_fk";--> statement-breakpoint
ALTER TABLE "groups" DROP CONSTRAINT IF EXISTS "groups_role_id_fkey";
--> statement-breakpoint
ALTER TABLE "group_roles" ADD CONSTRAINT "group_roles_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_roles" ADD CONSTRAINT "group_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- M131 data-preserving backfill: carry every existing 1:1 groups.role_id
-- mapping into the new group_roles junction BEFORE the column is dropped,
-- so no Human loses their Role on migrate. (Drizzle does not generate this.)
INSERT INTO "group_roles" ("group_id", "role_id")
SELECT "id", "role_id" FROM "groups"
ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "groups" DROP COLUMN "role_id";