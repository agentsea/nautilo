CREATE TABLE "room_event_rollups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"through_event_sequence" integer NOT NULL,
	"content" text NOT NULL,
	"source_event_count" integer NOT NULL,
	"model_id" text NOT NULL,
	"compactor_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_event_rollups_sequence_positive" CHECK ("room_event_rollups"."through_event_sequence" > 0),
	CONSTRAINT "room_event_rollups_source_count_positive" CHECK ("room_event_rollups"."source_event_count" > 0),
	CONSTRAINT "room_event_rollups_content_size" CHECK (char_length("room_event_rollups"."content") BETWEEN 1 AND 12000)
);
--> statement-breakpoint
CREATE TABLE "room_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"kind" text NOT NULL,
	"statement" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"supersedes_event_id" uuid,
	"resolves_event_id" uuid,
	"source_message_ids" integer[] NOT NULL,
	"source_batch_id" uuid NOT NULL,
	"batch_local_ordinal" integer NOT NULL,
	"extractor_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_events_sequence_positive" CHECK ("room_events"."sequence" > 0),
	CONSTRAINT "room_events_kind" CHECK ("room_events"."kind" IN ('decision', 'commitment', 'goal', 'state_change', 'fact', 'preference_or_norm', 'open_question', 'risk')),
	CONSTRAINT "room_events_statement_size" CHECK (char_length("room_events"."statement") BETWEEN 1 AND 500),
	CONSTRAINT "room_events_status" CHECK ("room_events"."status" IN ('active', 'superseded', 'resolved')),
	CONSTRAINT "room_events_source_cardinality" CHECK (cardinality("room_events"."source_message_ids") BETWEEN 1 AND 16),
	CONSTRAINT "room_events_batch_ordinal_nonnegative" CHECK ("room_events"."batch_local_ordinal" >= 0),
	CONSTRAINT "room_events_single_transition_link" CHECK (NOT ("room_events"."supersedes_event_id" IS NOT NULL AND "room_events"."resolves_event_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "room_journal_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"from_message_id_exclusive" integer NOT NULL,
	"through_message_id_inclusive" integer NOT NULL,
	"extractor_version" text NOT NULL,
	"status" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"operation_count" integer,
	"model_id" text,
	"error_code" text,
	"last_error_at" timestamp with time zone,
	"last_error_attempt" integer,
	"last_error_model_id" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_journal_batches_valid_range" CHECK ("room_journal_batches"."through_message_id_inclusive" > "room_journal_batches"."from_message_id_exclusive"),
	CONSTRAINT "room_journal_batches_attempt_nonnegative" CHECK ("room_journal_batches"."attempt_count" >= 0),
	CONSTRAINT "room_journal_batches_operation_count" CHECK ("room_journal_batches"."operation_count" IS NULL OR "room_journal_batches"."operation_count" BETWEEN 0 AND 5),
	CONSTRAINT "room_journal_batches_status" CHECK ("room_journal_batches"."status" IN ('pending', 'running', 'completed', 'failed')),
	CONSTRAINT "room_journal_batches_error_code" CHECK ("room_journal_batches"."error_code" IS NULL OR "room_journal_batches"."error_code" IN ('provider', 'timeout', 'invalid_output', 'input_too_large', 'lease_lost', 'persistence', 'unknown')),
	CONSTRAINT "room_journal_batches_last_error_attempt_nonnegative" CHECK ("room_journal_batches"."last_error_attempt" IS NULL OR "room_journal_batches"."last_error_attempt" >= 0)
);
--> statement-breakpoint
CREATE TABLE "room_journal_state" (
	"room_id" uuid PRIMARY KEY NOT NULL,
	"last_processed_message_id" integer DEFAULT 0 NOT NULL,
	"last_processed_at" timestamp with time zone,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"compaction_lease_token" uuid,
	"compaction_lease_expires_at" timestamp with time zone,
	"extraction_failure_count" integer DEFAULT 0 NOT NULL,
	"extraction_retry_after" timestamp with time zone,
	"last_extraction_error_code" text,
	"last_extraction_error_at" timestamp with time zone,
	"last_extraction_completed_at" timestamp with time zone,
	"compaction_due_at" timestamp with time zone,
	"compaction_failure_count" integer DEFAULT 0 NOT NULL,
	"compaction_retry_after" timestamp with time zone,
	"last_compaction_error_code" text,
	"last_compaction_error_at" timestamp with time zone,
	"last_compaction_error_attempt" integer,
	"last_compaction_error_model_id" text,
	"last_compaction_completed_at" timestamp with time zone,
	"extractor_version" text NOT NULL,
	"suspended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_journal_state_cursor_nonnegative" CHECK ("room_journal_state"."last_processed_message_id" >= 0),
	CONSTRAINT "room_journal_state_extraction_failures_nonnegative" CHECK ("room_journal_state"."extraction_failure_count" >= 0),
	CONSTRAINT "room_journal_state_compaction_failures_nonnegative" CHECK ("room_journal_state"."compaction_failure_count" >= 0),
	CONSTRAINT "room_journal_state_extraction_lease_pair" CHECK (("room_journal_state"."lease_token" IS NULL) = ("room_journal_state"."lease_expires_at" IS NULL)),
	CONSTRAINT "room_journal_state_compaction_lease_pair" CHECK (("room_journal_state"."compaction_lease_token" IS NULL) = ("room_journal_state"."compaction_lease_expires_at" IS NULL)),
	CONSTRAINT "room_journal_state_extraction_error_code" CHECK ("room_journal_state"."last_extraction_error_code" IS NULL OR "room_journal_state"."last_extraction_error_code" IN ('provider', 'timeout', 'invalid_output', 'input_too_large', 'lease_lost', 'persistence', 'unknown')),
	CONSTRAINT "room_journal_state_compaction_error_code" CHECK ("room_journal_state"."last_compaction_error_code" IS NULL OR "room_journal_state"."last_compaction_error_code" IN ('provider', 'timeout', 'invalid_output', 'input_too_large', 'lease_lost', 'persistence', 'unknown')),
	CONSTRAINT "room_journal_state_compaction_error_attempt_nonnegative" CHECK ("room_journal_state"."last_compaction_error_attempt" IS NULL OR "room_journal_state"."last_compaction_error_attempt" >= 0)
);
--> statement-breakpoint
ALTER TABLE "room_event_rollups" ADD CONSTRAINT "room_event_rollups_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_events" ADD CONSTRAINT "room_events_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_events" ADD CONSTRAINT "room_events_supersedes_event_id_room_events_id_fk" FOREIGN KEY ("supersedes_event_id") REFERENCES "public"."room_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_events" ADD CONSTRAINT "room_events_resolves_event_id_room_events_id_fk" FOREIGN KEY ("resolves_event_id") REFERENCES "public"."room_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_events" ADD CONSTRAINT "room_events_source_batch_id_room_journal_batches_id_fk" FOREIGN KEY ("source_batch_id") REFERENCES "public"."room_journal_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_journal_batches" ADD CONSTRAINT "room_journal_batches_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_journal_state" ADD CONSTRAINT "room_journal_state_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_room_event_rollups_cursor" ON "room_event_rollups" USING btree ("room_id","through_event_sequence","compactor_version");--> statement-breakpoint
CREATE INDEX "idx_room_event_rollups_latest" ON "room_event_rollups" USING btree ("room_id","through_event_sequence");--> statement-breakpoint
CREATE INDEX "idx_room_event_rollups_created_at" ON "room_event_rollups" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_room_events_sequence" ON "room_events" USING btree ("room_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_room_events_batch_ordinal" ON "room_events" USING btree ("source_batch_id","batch_local_ordinal");--> statement-breakpoint
CREATE INDEX "idx_room_events_effective" ON "room_events" USING btree ("room_id","status","sequence");--> statement-breakpoint
CREATE INDEX "idx_room_events_created_at" ON "room_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_room_journal_batches_range" ON "room_journal_batches" USING btree ("room_id","from_message_id_exclusive","through_message_id_inclusive","extractor_version");--> statement-breakpoint
CREATE INDEX "idx_room_journal_batches_room_status" ON "room_journal_batches" USING btree ("room_id","status");--> statement-breakpoint
CREATE INDEX "idx_room_journal_batches_last_error" ON "room_journal_batches" USING btree ("last_error_at");--> statement-breakpoint
CREATE INDEX "idx_room_journal_state_extraction_retry" ON "room_journal_state" USING btree ("extraction_retry_after");--> statement-breakpoint
CREATE INDEX "idx_room_journal_state_compaction_due" ON "room_journal_state" USING btree ("compaction_due_at");--> statement-breakpoint
-- M219 bootstrap is data-dependent and cannot be expressed in the Drizzle
-- schema: existing Rooms begin at their complete current transcript head so
-- pre-M219 history is never processed. Human-only/non-conversational Rooms
-- start suspended; membership reconciliation clears that marker when eligible.
INSERT INTO "room_journal_state" (
	"room_id",
	"last_processed_message_id",
	"last_processed_at",
	"extractor_version",
	"suspended_at"
)
SELECT
	r."id",
	COALESCE(MAX(sm."id"), 0),
	now(),
	'm219-v1',
	CASE
		WHEN r."kind" NOT IN ('task', 'access')
			AND EXISTS (
				SELECT 1
				FROM "room_members" rm
				INNER JOIN "actors" a ON a."id" = rm."actor_id"
				WHERE rm."room_id" = r."id" AND a."kind" = 'agent'
			)
		THEN NULL
		ELSE now()
	END
FROM "rooms" r
LEFT JOIN "sessions" s ON s."room_id" = r."id"
LEFT JOIN "session_messages" sm ON sm."session_id" = s."id"
GROUP BY r."id", r."kind";
