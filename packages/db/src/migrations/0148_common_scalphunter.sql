CREATE TABLE "push_message_candidates" (
	"message_id" integer PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_message_candidates_state_check" CHECK ("push_message_candidates"."state" IN ('pending', 'terminal'))
);
--> statement-breakpoint
ALTER TABLE "push_message_candidates" ADD CONSTRAINT "push_message_candidates_message_id_session_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."session_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_push_message_candidates_pending" ON "push_message_candidates" USING btree ("created_at","message_id") WHERE "push_message_candidates"."state" = 'pending';
--> statement-breakpoint
-- Canonical append also runs through the restricted agent role. It may create
-- its own content-free admission marker, but it must never inspect or mutate
-- worker state.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nautilo_agent') THEN
		REVOKE ALL ON TABLE "push_message_candidates" FROM "nautilo_agent";
		GRANT INSERT ON TABLE "push_message_candidates" TO "nautilo_agent";
	END IF;
END $$;
