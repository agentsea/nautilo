CREATE TABLE "content_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"reporter_user_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_message_id" integer,
	"target_user_id" uuid,
	"reason" text NOT NULL,
	"comment" varchar(500),
	"preview_text" varchar(4000),
	"preview_display_name" varchar(255),
	"preview_handle" text,
	"preview_attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_by_user_id" uuid,
	"closed_at" timestamp with time zone,
	CONSTRAINT "content_reports_target_check" CHECK ((
        ("content_reports"."target_type" = 'message' AND "content_reports"."target_message_id" IS NOT NULL AND "content_reports"."target_user_id" IS NULL)
        OR
        ("content_reports"."target_type" = 'person' AND "content_reports"."target_message_id" IS NULL AND "content_reports"."target_user_id" IS NOT NULL)
      )),
	CONSTRAINT "content_reports_reason_check" CHECK ("content_reports"."reason" IN ('abuse_hate_harassment', 'sexual_exploitative', 'violence_threats', 'spam_scam', 'other')),
	CONSTRAINT "content_reports_status_check" CHECK ("content_reports"."status" IN ('open', 'closed')),
	CONSTRAINT "content_reports_close_state_check" CHECK ((
        ("content_reports"."status" = 'open' AND "content_reports"."closed_at" IS NULL AND "content_reports"."closed_by_user_id" IS NULL)
        OR
        ("content_reports"."status" = 'closed' AND "content_reports"."closed_at" IS NOT NULL AND "content_reports"."closed_by_user_id" IS NOT NULL)
      ))
);
--> statement-breakpoint
ALTER TABLE "content_reports" ADD CONSTRAINT "content_reports_reporter_user_id_users_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_reports" ADD CONSTRAINT "content_reports_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_content_reports_status_created" ON "content_reports" USING btree ("status","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_content_reports_reporter_created" ON "content_reports" USING btree ("reporter_user_id","created_at");