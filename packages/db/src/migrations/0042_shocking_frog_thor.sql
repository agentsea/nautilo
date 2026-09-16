CREATE TABLE "artifact_namespaces" (
	"artifact_id" uuid NOT NULL,
	"namespace_id" uuid NOT NULL,
	"attached_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_namespaces_artifact_id_namespace_id_pk" PRIMARY KEY("artifact_id","namespace_id")
);
--> statement-breakpoint
CREATE TABLE "artifact_scopes" (
	"artifact_id" uuid NOT NULL,
	"scope_id" uuid NOT NULL,
	"origin" text DEFAULT 'seed' NOT NULL,
	"attached_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_scopes_artifact_id_scope_id_pk" PRIMARY KEY("artifact_id","scope_id")
);
--> statement-breakpoint
-- M088B: drop the M088A hand-edited CHECK that required exactly one of
-- (namespace_id, scope_id) to be set; both columns are about to disappear.
-- Drizzle doesn't know about this constraint because M088A added it
-- after `db:generate`. IF EXISTS guards a re-applied migration on a
-- previously-cleaned DB.
ALTER TABLE "artifacts" DROP CONSTRAINT IF EXISTS "artifacts_namespace_xor_scope";--> statement-breakpoint
ALTER TABLE "artifacts" DROP CONSTRAINT "artifacts_namespace_id_namespaces_id_fk";
--> statement-breakpoint
ALTER TABLE "artifacts" DROP CONSTRAINT "artifacts_scope_id_agent_scopes_id_fk";
--> statement-breakpoint
DROP INDEX "uniq_artifacts_namespace_agent_artifact";--> statement-breakpoint
DROP INDEX "uniq_artifacts_scope_agent_artifact";--> statement-breakpoint
DROP INDEX "idx_artifacts_namespace";--> statement-breakpoint
DROP INDEX "idx_artifacts_scope";--> statement-breakpoint
DROP INDEX "idx_artifacts_namespace_path";--> statement-breakpoint
ALTER TABLE "artifact_namespaces" ADD CONSTRAINT "artifact_namespaces_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_namespaces" ADD CONSTRAINT "artifact_namespaces_namespace_id_namespaces_id_fk" FOREIGN KEY ("namespace_id") REFERENCES "public"."namespaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_scopes" ADD CONSTRAINT "artifact_scopes_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_scopes" ADD CONSTRAINT "artifact_scopes_scope_id_agent_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."agent_scopes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_artifact_namespaces_namespace" ON "artifact_namespaces" USING btree ("namespace_id");--> statement-breakpoint
CREATE INDEX "idx_artifact_namespaces_artifact" ON "artifact_namespaces" USING btree ("artifact_id");--> statement-breakpoint
CREATE INDEX "idx_artifact_scopes_scope" ON "artifact_scopes" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "idx_artifact_scopes_artifact" ON "artifact_scopes" USING btree ("artifact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_artifacts_agent_artifact_id" ON "artifacts" USING btree ("agent_id","artifact_id");--> statement-breakpoint
-- M088B: back-fill the new junction tables from the legacy single-column
-- attachment BEFORE dropping `namespace_id` / `scope_id`. This is the
-- only point where the legacy mapping is still readable; the operator
-- CLI migrator (`bun run dev:migrate-artifacts`) only handles byte
-- relocation + flat-tree ingest and CANNOT recover this mapping after
-- the columns are gone. ON CONFLICT DO NOTHING keeps the migration
-- re-runnable and tolerant of partial pre-seeded junction rows.
INSERT INTO "artifact_namespaces" ("artifact_id", "namespace_id")
  SELECT "id", "namespace_id" FROM "artifacts" WHERE "namespace_id" IS NOT NULL
  ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "artifact_scopes" ("artifact_id", "scope_id", "origin")
  SELECT "id", "scope_id", 'seed' FROM "artifacts" WHERE "scope_id" IS NOT NULL
  ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "artifacts" DROP COLUMN "namespace_id";--> statement-breakpoint
ALTER TABLE "artifacts" DROP COLUMN "scope_id";