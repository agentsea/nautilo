CREATE TABLE "content_access_operations" (
	"operation_id" uuid PRIMARY KEY NOT NULL,
	"request_digest" varchar(64) NOT NULL,
	"requester_user_id" uuid,
	"requester_actor_id" uuid,
	"memory_id" uuid,
	"artifact_id" uuid,
	"outcome" text NOT NULL,
	"changed" boolean NOT NULL,
	"attached_count" integer NOT NULL,
	"detached_count" integer NOT NULL,
	"skipped_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_access_operations_request_digest_canonical" CHECK ("content_access_operations"."request_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "content_access_operations_one_object" CHECK (num_nonnulls("content_access_operations"."memory_id", "content_access_operations"."artifact_id") = 1),
	CONSTRAINT "content_access_operations_outcome_check" CHECK ("content_access_operations"."outcome" in ('applied', 'already_applied', 'partial', 'denied', 'stale', 'failed')),
	CONSTRAINT "content_access_operations_counts_nonnegative" CHECK ("content_access_operations"."attached_count" >= 0 and "content_access_operations"."detached_count" >= 0 and "content_access_operations"."skipped_count" >= 0),
	CONSTRAINT "content_access_operations_changed_coherent" CHECK ("content_access_operations"."changed" = ("content_access_operations"."attached_count" > 0 or "content_access_operations"."detached_count" > 0)),
	CONSTRAINT "content_access_operations_outcome_coherent" CHECK ((
        ("content_access_operations"."outcome" = 'applied' and "content_access_operations"."changed")
        or "content_access_operations"."outcome" = 'partial'
        or (
          "content_access_operations"."outcome" in ('already_applied', 'denied', 'stale', 'failed')
          and not "content_access_operations"."changed"
        )
      ))
);
--> statement-breakpoint
ALTER TABLE "content_access_operations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "content_access_operations" ADD CONSTRAINT "content_access_operations_requester_user_id_users_id_fk" FOREIGN KEY ("requester_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_access_operations" ADD CONSTRAINT "content_access_operations_requester_actor_id_actors_id_fk" FOREIGN KEY ("requester_actor_id") REFERENCES "public"."actors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_access_operations" ADD CONSTRAINT "content_access_operations_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_access_operations" ADD CONSTRAINT "content_access_operations_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_content_access_operations_memory" ON "content_access_operations" USING btree ("memory_id");--> statement-breakpoint
CREATE INDEX "idx_content_access_operations_artifact" ON "content_access_operations" USING btree ("artifact_id");--> statement-breakpoint
CREATE POLICY "content_access_operations_product_read" ON "content_access_operations" AS PERMISSIVE FOR SELECT TO "nautilo" USING (true);--> statement-breakpoint
CREATE POLICY "content_access_operations_product_append" ON "content_access_operations" AS PERMISSIVE FOR INSERT TO "nautilo" WITH CHECK (true);
--> statement-breakpoint
-- CONTENT_ACCESS_OPERATIONS_AUTHORITY
ALTER TABLE "content_access_operations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "content_access_operations" FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "content_access_operations" FROM "nautilo";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "content_access_operations" TO "nautilo";
