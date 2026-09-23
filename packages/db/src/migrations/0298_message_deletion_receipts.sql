CREATE TABLE "message_deletion_receipts" (
	"operation_id" uuid PRIMARY KEY NOT NULL,
	"room_id" uuid NOT NULL,
	"message_id" integer NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"actor_id" uuid,
	"source" text NOT NULL,
	"authority" text NOT NULL,
	"report_id" uuid,
	"outcome" text NOT NULL,
	"committed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_deletion_receipts_message_positive" CHECK ("message_deletion_receipts"."message_id" > 0),
	CONSTRAINT "message_deletion_receipts_source_valid" CHECK ("message_deletion_receipts"."source" in ('room_message', 'content_report')),
	CONSTRAINT "message_deletion_receipts_authority_valid" CHECK ("message_deletion_receipts"."authority" in ('author', 'room_owner', 'room_steward', 'manage_rooms', 'report_action')),
	CONSTRAINT "message_deletion_receipts_outcome_valid" CHECK ("message_deletion_receipts"."outcome" = 'deleted'),
	CONSTRAINT "message_deletion_receipts_report_source" CHECK (("message_deletion_receipts"."source" = 'content_report') = ("message_deletion_receipts"."report_id" is not null)),
	CONSTRAINT "message_deletion_receipts_report_authority" CHECK (("message_deletion_receipts"."source" = 'content_report') = ("message_deletion_receipts"."authority" = 'report_action'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "message_deletion_receipts_message" ON "message_deletion_receipts" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_deletion_receipts_report" ON "message_deletion_receipts" USING btree ("report_id");--> statement-breakpoint
CREATE INDEX "message_deletion_receipts_room_time" ON "message_deletion_receipts" USING btree ("room_id","committed_at","operation_id");--> statement-breakpoint
CREATE INDEX "message_deletion_receipts_actor_time" ON "message_deletion_receipts" USING btree ("actor_id","committed_at","operation_id");
