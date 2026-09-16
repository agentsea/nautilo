CREATE TABLE "session_message_artifacts" (
	"message_id" integer NOT NULL,
	"artifact_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "session_message_artifacts_message_id_artifact_id_pk" PRIMARY KEY("message_id","artifact_id")
);
--> statement-breakpoint
ALTER TABLE "session_message_artifacts" ADD CONSTRAINT "session_message_artifacts_message_id_session_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."session_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_message_artifacts" ADD CONSTRAINT "session_message_artifacts_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_session_message_artifacts_position" ON "session_message_artifacts" USING btree ("message_id","position");