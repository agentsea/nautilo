ALTER TABLE "focus_events" ADD COLUMN "anchor_message_id" integer;
--> statement-breakpoint
ALTER TABLE "focus_events" ADD CONSTRAINT "focus_events_anchor_message_id_session_messages_id_fk" FOREIGN KEY ("anchor_message_id") REFERENCES "public"."session_messages"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
