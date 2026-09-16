CREATE TABLE "workspace_document_mutation_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mutation_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"mutation_kind" text NOT NULL,
	"artifact_internal_id" uuid NOT NULL,
	"before_logical_path" text,
	"after_logical_path" text,
	"before_revision" integer,
	"after_revision" integer,
	"before_sha256" text,
	"after_sha256" text,
	"before_size" bigint,
	"after_size" bigint,
	"before_storage_uri" text,
	"after_storage_uri" text,
	"destination_before_artifact_internal_id" uuid,
	"destination_before_logical_path" text,
	"destination_before_revision" integer,
	"destination_before_sha256" text,
	"destination_before_size" bigint,
	"destination_before_storage_uri" text,
	"checkpoint" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_workspace_document_mutation_entries_sequence" UNIQUE("mutation_id","sequence"),
	CONSTRAINT "workspace_document_mutation_entries_sequence_check" CHECK ("workspace_document_mutation_entries"."sequence" >= 0),
	CONSTRAINT "workspace_document_mutation_entries_kind_check" CHECK ("workspace_document_mutation_entries"."mutation_kind" in ('create', 'update', 'move', 'delete')),
	CONSTRAINT "workspace_document_mutation_entries_before_sha_check" CHECK ("workspace_document_mutation_entries"."before_sha256" is null or "workspace_document_mutation_entries"."before_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "workspace_document_mutation_entries_after_sha_check" CHECK ("workspace_document_mutation_entries"."after_sha256" is null or "workspace_document_mutation_entries"."after_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "workspace_document_mutation_entries_destination_sha_check" CHECK ("workspace_document_mutation_entries"."destination_before_sha256" is null or "workspace_document_mutation_entries"."destination_before_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "workspace_document_mutation_entries_storage_uri_check" CHECK ((
        ("workspace_document_mutation_entries"."before_storage_uri" is null or length(trim("workspace_document_mutation_entries"."before_storage_uri")) > 0) and
        ("workspace_document_mutation_entries"."after_storage_uri" is null or length(trim("workspace_document_mutation_entries"."after_storage_uri")) > 0) and
        ("workspace_document_mutation_entries"."destination_before_storage_uri" is null or length(trim("workspace_document_mutation_entries"."destination_before_storage_uri")) > 0)
      )),
	CONSTRAINT "workspace_document_mutation_entries_nonnegative_values_check" CHECK ((
        ("workspace_document_mutation_entries"."before_revision" is null or "workspace_document_mutation_entries"."before_revision" >= 0) and
        ("workspace_document_mutation_entries"."after_revision" is null or "workspace_document_mutation_entries"."after_revision" >= 0) and
        ("workspace_document_mutation_entries"."destination_before_revision" is null or "workspace_document_mutation_entries"."destination_before_revision" >= 0) and
        ("workspace_document_mutation_entries"."before_size" is null or "workspace_document_mutation_entries"."before_size" >= 0) and
        ("workspace_document_mutation_entries"."after_size" is null or "workspace_document_mutation_entries"."after_size" >= 0) and
        ("workspace_document_mutation_entries"."destination_before_size" is null or "workspace_document_mutation_entries"."destination_before_size" >= 0)
      )),
	CONSTRAINT "workspace_document_mutation_entries_exact_size_check" CHECK ((
        ("workspace_document_mutation_entries"."before_size" is null or "workspace_document_mutation_entries"."before_size" <= 9007199254740991) and
        ("workspace_document_mutation_entries"."after_size" is null or "workspace_document_mutation_entries"."after_size" <= 9007199254740991) and
        ("workspace_document_mutation_entries"."destination_before_size" is null or "workspace_document_mutation_entries"."destination_before_size" <= 9007199254740991)
      )),
	CONSTRAINT "workspace_document_mutation_entries_proof_shape_check" CHECK ((
        (
          "workspace_document_mutation_entries"."mutation_kind" = 'create' and
          "workspace_document_mutation_entries"."before_logical_path" is null and "workspace_document_mutation_entries"."before_revision" is null and
          "workspace_document_mutation_entries"."before_sha256" is null and "workspace_document_mutation_entries"."before_size" is null and
          "workspace_document_mutation_entries"."before_storage_uri" is null and
          "workspace_document_mutation_entries"."after_logical_path" is not null and "workspace_document_mutation_entries"."after_revision" is not null and
          "workspace_document_mutation_entries"."after_sha256" is not null and "workspace_document_mutation_entries"."after_size" is not null and
          "workspace_document_mutation_entries"."after_storage_uri" is not null and
          "workspace_document_mutation_entries"."destination_before_artifact_internal_id" is null and
          "workspace_document_mutation_entries"."destination_before_logical_path" is null and
          "workspace_document_mutation_entries"."destination_before_revision" is null and
          "workspace_document_mutation_entries"."destination_before_sha256" is null and
          "workspace_document_mutation_entries"."destination_before_size" is null and
          "workspace_document_mutation_entries"."destination_before_storage_uri" is null
        ) or (
          "workspace_document_mutation_entries"."mutation_kind" = 'update' and
          "workspace_document_mutation_entries"."before_logical_path" is not null and "workspace_document_mutation_entries"."before_revision" is not null and
          "workspace_document_mutation_entries"."before_sha256" is not null and "workspace_document_mutation_entries"."before_size" is not null and
          "workspace_document_mutation_entries"."before_storage_uri" is not null and
          "workspace_document_mutation_entries"."after_logical_path" is not null and "workspace_document_mutation_entries"."after_revision" is not null and
          "workspace_document_mutation_entries"."after_sha256" is not null and "workspace_document_mutation_entries"."after_size" is not null and
          "workspace_document_mutation_entries"."after_storage_uri" is not null and
          "workspace_document_mutation_entries"."destination_before_artifact_internal_id" is null and
          "workspace_document_mutation_entries"."destination_before_logical_path" is null and
          "workspace_document_mutation_entries"."destination_before_revision" is null and
          "workspace_document_mutation_entries"."destination_before_sha256" is null and
          "workspace_document_mutation_entries"."destination_before_size" is null and
          "workspace_document_mutation_entries"."destination_before_storage_uri" is null
        ) or (
          "workspace_document_mutation_entries"."mutation_kind" = 'move' and
          "workspace_document_mutation_entries"."before_logical_path" is not null and "workspace_document_mutation_entries"."before_revision" is not null and
          "workspace_document_mutation_entries"."before_sha256" is not null and "workspace_document_mutation_entries"."before_size" is not null and
          "workspace_document_mutation_entries"."before_storage_uri" is not null and
          "workspace_document_mutation_entries"."after_logical_path" is not null and "workspace_document_mutation_entries"."after_revision" is not null and
          "workspace_document_mutation_entries"."after_sha256" is not null and "workspace_document_mutation_entries"."after_size" is not null and
          "workspace_document_mutation_entries"."after_storage_uri" is not null and
          (
            (
              "workspace_document_mutation_entries"."destination_before_artifact_internal_id" is null and
              "workspace_document_mutation_entries"."destination_before_logical_path" is null and
              "workspace_document_mutation_entries"."destination_before_revision" is null and
              "workspace_document_mutation_entries"."destination_before_sha256" is null and
              "workspace_document_mutation_entries"."destination_before_size" is null and
              "workspace_document_mutation_entries"."destination_before_storage_uri" is null
            ) or (
              "workspace_document_mutation_entries"."destination_before_artifact_internal_id" is not null and
              "workspace_document_mutation_entries"."destination_before_logical_path" is not null and
              "workspace_document_mutation_entries"."destination_before_revision" is not null and
              "workspace_document_mutation_entries"."destination_before_sha256" is not null and
              "workspace_document_mutation_entries"."destination_before_size" is not null and
              "workspace_document_mutation_entries"."destination_before_storage_uri" is not null
            )
          )
        ) or (
          "workspace_document_mutation_entries"."mutation_kind" = 'delete' and
          "workspace_document_mutation_entries"."before_logical_path" is not null and "workspace_document_mutation_entries"."before_revision" is not null and
          "workspace_document_mutation_entries"."before_sha256" is not null and "workspace_document_mutation_entries"."before_size" is not null and
          "workspace_document_mutation_entries"."before_storage_uri" is not null and
          "workspace_document_mutation_entries"."after_logical_path" is null and "workspace_document_mutation_entries"."after_revision" is null and
          "workspace_document_mutation_entries"."after_sha256" is null and "workspace_document_mutation_entries"."after_size" is null and
          "workspace_document_mutation_entries"."after_storage_uri" is null and
          "workspace_document_mutation_entries"."destination_before_artifact_internal_id" is null and
          "workspace_document_mutation_entries"."destination_before_logical_path" is null and
          "workspace_document_mutation_entries"."destination_before_revision" is null and
          "workspace_document_mutation_entries"."destination_before_sha256" is null and
          "workspace_document_mutation_entries"."destination_before_size" is null and
          "workspace_document_mutation_entries"."destination_before_storage_uri" is null
        )
      ))
);
--> statement-breakpoint
CREATE TABLE "workspace_document_mutation_entry_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mutation_entry_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"sequence" integer NOT NULL,
	"value" text NOT NULL,
	CONSTRAINT "uq_workspace_document_mutation_entry_identities_sequence" UNIQUE("mutation_entry_id","kind","sequence"),
	CONSTRAINT "workspace_document_mutation_entry_identities_kind_check" CHECK ("workspace_document_mutation_entry_identities"."kind" in ('revision', 'undo_record')),
	CONSTRAINT "workspace_document_mutation_entry_identities_sequence_check" CHECK ("workspace_document_mutation_entry_identities"."sequence" >= 0),
	CONSTRAINT "workspace_document_mutation_entry_identities_value_check" CHECK (length(trim("workspace_document_mutation_entry_identities"."value")) > 0)
);
--> statement-breakpoint
CREATE TABLE "workspace_document_mutation_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mutation_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"batch_idempotency_key" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"dispatch_state" text DEFAULT 'pending' NOT NULL,
	"dispatch_attempts" integer DEFAULT 0 NOT NULL,
	"claimed_by" text,
	"claimed_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_workspace_document_mutation_outbox_sequence" UNIQUE("mutation_id","sequence"),
	CONSTRAINT "uq_workspace_document_mutation_outbox_batch_sequence" UNIQUE("batch_idempotency_key","sequence"),
	CONSTRAINT "workspace_document_mutation_outbox_sequence_check" CHECK ("workspace_document_mutation_outbox"."sequence" >= 0),
	CONSTRAINT "workspace_document_mutation_outbox_state_check" CHECK ("workspace_document_mutation_outbox"."dispatch_state" in ('pending', 'claimed', 'dispatched')),
	CONSTRAINT "workspace_document_mutation_outbox_event_type_check" CHECK ("workspace_document_mutation_outbox"."event_type" = 'document.mutation.committed'),
	CONSTRAINT "workspace_document_mutation_outbox_payload_type_check" CHECK ("workspace_document_mutation_outbox"."payload"->>'type' = 'document.mutation.committed'),
	CONSTRAINT "workspace_document_mutation_outbox_dispatch_attempts_check" CHECK ("workspace_document_mutation_outbox"."dispatch_attempts" >= 0),
	CONSTRAINT "workspace_document_mutation_outbox_batch_idempotency_check" CHECK (length(trim("workspace_document_mutation_outbox"."batch_idempotency_key")) > 0),
	CONSTRAINT "workspace_document_mutation_outbox_state_timestamps_check" CHECK ((
        ("workspace_document_mutation_outbox"."dispatch_state" = 'pending' and "workspace_document_mutation_outbox"."claimed_by" is null and "workspace_document_mutation_outbox"."claimed_at" is null and "workspace_document_mutation_outbox"."dispatched_at" is null) or
        ("workspace_document_mutation_outbox"."dispatch_state" = 'claimed' and "workspace_document_mutation_outbox"."claimed_by" is not null and "workspace_document_mutation_outbox"."claimed_at" is not null and "workspace_document_mutation_outbox"."dispatched_at" is null) or
        ("workspace_document_mutation_outbox"."dispatch_state" = 'dispatched' and "workspace_document_mutation_outbox"."claimed_by" is null and "workspace_document_mutation_outbox"."claimed_at" is null and "workspace_document_mutation_outbox"."dispatched_at" is not null)
      ))
);
--> statement-breakpoint
CREATE TABLE "workspace_document_mutations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation_id" text NOT NULL,
	"request_digest" text NOT NULL,
	"revision_group_id" text NOT NULL,
	"owner_id" uuid,
	"user_id" uuid,
	"agent_id" uuid,
	"room_id" uuid,
	"actor_kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"lane" text NOT NULL,
	"client_mutation_id" text,
	"request_id" text,
	"outbox_batch_idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_workspace_document_mutations_outbox_binding" UNIQUE("id","outbox_batch_idempotency_key"),
	CONSTRAINT "workspace_document_mutations_actor_kind_check" CHECK ("workspace_document_mutations"."actor_kind" in ('human', 'agent')),
	CONSTRAINT "workspace_document_mutations_lane_check" CHECK ("workspace_document_mutations"."lane" in ('editor_save', 'apply_patch', 'file_tool', 'officecli', 'artifact_lifecycle', 'desktop_files_ui')),
	CONSTRAINT "workspace_document_mutations_operation_id_check" CHECK (length(trim("workspace_document_mutations"."operation_id")) > 0),
	CONSTRAINT "workspace_document_mutations_revision_group_id_check" CHECK (length(trim("workspace_document_mutations"."revision_group_id")) > 0),
	CONSTRAINT "workspace_document_mutations_actor_id_check" CHECK (length(trim("workspace_document_mutations"."actor_id")) > 0),
	CONSTRAINT "workspace_document_mutations_request_digest_check" CHECK ("workspace_document_mutations"."request_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "workspace_document_mutations_outbox_binding_check" CHECK (length(trim("workspace_document_mutations"."outbox_batch_idempotency_key")) > 0)
);
--> statement-breakpoint
ALTER TABLE "workspace_document_mutation_entries" ADD CONSTRAINT "workspace_document_mutation_entries_mutation_id_workspace_document_mutations_id_fk" FOREIGN KEY ("mutation_id") REFERENCES "public"."workspace_document_mutations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_document_mutation_entries" ADD CONSTRAINT "workspace_document_mutation_entries_artifact_internal_id_artifacts_id_fk" FOREIGN KEY ("artifact_internal_id") REFERENCES "public"."artifacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_document_mutation_entries" ADD CONSTRAINT "workspace_document_mutation_entries_destination_before_artifact_internal_id_artifacts_id_fk" FOREIGN KEY ("destination_before_artifact_internal_id") REFERENCES "public"."artifacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_document_mutation_entry_identities" ADD CONSTRAINT "workspace_document_mutation_entry_identities_mutation_entry_id_workspace_document_mutation_entries_id_fk" FOREIGN KEY ("mutation_entry_id") REFERENCES "public"."workspace_document_mutation_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_document_mutation_outbox" ADD CONSTRAINT "workspace_document_mutation_outbox_committed_mutation_fk" FOREIGN KEY ("mutation_id","batch_idempotency_key") REFERENCES "public"."workspace_document_mutations"("id","outbox_batch_idempotency_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_document_mutations" ADD CONSTRAINT "workspace_document_mutations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_document_mutations" ADD CONSTRAINT "workspace_document_mutations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_document_mutations" ADD CONSTRAINT "workspace_document_mutations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_document_mutations" ADD CONSTRAINT "workspace_document_mutations_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_workspace_document_mutation_entries_artifact" ON "workspace_document_mutation_entries" USING btree ("artifact_internal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_workspace_document_mutation_entry_identities_value" ON "workspace_document_mutation_entry_identities" USING btree ("value");--> statement-breakpoint
CREATE INDEX "idx_workspace_document_mutation_outbox_claim" ON "workspace_document_mutation_outbox" USING btree ("dispatch_state","next_attempt_at","created_at");--> statement-breakpoint
CREATE INDEX "idx_workspace_document_mutation_outbox_batch" ON "workspace_document_mutation_outbox" USING btree ("batch_idempotency_key","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_workspace_document_mutations_operation" ON "workspace_document_mutations" USING btree ("operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_workspace_document_mutations_outbox_batch_idempotency" ON "workspace_document_mutations" USING btree ("outbox_batch_idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_workspace_document_mutations_request_digest" ON "workspace_document_mutations" USING btree ("request_digest");--> statement-breakpoint
CREATE INDEX "idx_workspace_document_mutations_revision_group" ON "workspace_document_mutations" USING btree ("revision_group_id");