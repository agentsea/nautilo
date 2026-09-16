CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"namespace_id" uuid,
	"scope_id" uuid,
	"agent_id" uuid NOT NULL,
	"artifact_id" text NOT NULL,
	"path" text NOT NULL,
	"mime_type" text DEFAULT 'application/octet-stream' NOT NULL,
	"size" bigint DEFAULT 0 NOT NULL,
	"storage_uri" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_namespace_id_namespaces_id_fk" FOREIGN KEY ("namespace_id") REFERENCES "public"."namespaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_scope_id_agent_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."agent_scopes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_artifacts_namespace_agent_artifact" ON "artifacts" USING btree ("namespace_id","agent_id","artifact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_artifacts_scope_agent_artifact" ON "artifacts" USING btree ("scope_id","agent_id","artifact_id");--> statement-breakpoint
CREATE INDEX "idx_artifacts_namespace" ON "artifacts" USING btree ("namespace_id");--> statement-breakpoint
CREATE INDEX "idx_artifacts_scope" ON "artifacts" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "idx_artifacts_namespace_path" ON "artifacts" USING btree ("namespace_id","path");--> statement-breakpoint
-- M088A: an artifact row is either namespace-scoped OR scope-scoped, never both and never neither.
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_namespace_xor_scope" CHECK (
  ((namespace_id IS NOT NULL)::int + (scope_id IS NOT NULL)::int) = 1
);