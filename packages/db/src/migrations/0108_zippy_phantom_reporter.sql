UPDATE "subthread_user_focus" AS "focus"
SET "established_message_id" = NULL
WHERE "focus"."established_message_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "session_messages" AS "message"
    WHERE "message"."id" = "focus"."established_message_id"
  );
--> statement-breakpoint
ALTER TABLE "subthread_user_focus" ADD CONSTRAINT "subthread_user_focus_established_message_id_session_messages_id_fk" FOREIGN KEY ("established_message_id") REFERENCES "public"."session_messages"("id") ON DELETE set null ON UPDATE no action;
