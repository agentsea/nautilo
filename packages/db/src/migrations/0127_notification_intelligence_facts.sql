CREATE TABLE "room_notification_settings" (
	"user_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"level" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_notification_settings_user_id_room_id_pk" PRIMARY KEY("user_id","room_id"),
	CONSTRAINT "room_notification_settings_level_check" CHECK ("room_notification_settings"."level" IN ('none', 'direct', 'all'))
);
--> statement-breakpoint
CREATE TABLE "session_message_directed_recipients" (
	"message_id" integer NOT NULL,
	"recipient_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_message_directed_recipients_message_id_recipient_id_reason_pk" PRIMARY KEY("message_id","recipient_id","reason"),
	CONSTRAINT "session_message_directed_recipients_reason_check" CHECK ("session_message_directed_recipients"."reason" IN ('direct_room', 'mention', 'explicit_reply', 'agent_response'))
);
--> statement-breakpoint
CREATE TABLE "subthread_notification_participants" (
	"subthread_room_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"from_message_id" integer NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subthread_notification_participants_subthread_room_id_user_id_pk" PRIMARY KEY("subthread_room_id","user_id"),
	CONSTRAINT "subthread_notification_participants_reason_check" CHECK ("subthread_notification_participants"."reason" IN ('posted', 'mention', 'explicit_reply'))
);
--> statement-breakpoint
CREATE TABLE "user_notification_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"default_level" text DEFAULT 'direct' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_notification_settings_level_check" CHECK ("user_notification_settings"."default_level" IN ('none', 'direct', 'all'))
);
--> statement-breakpoint
ALTER TABLE "session_messages" ADD COLUMN "human_turn_id" text;--> statement-breakpoint
ALTER TABLE "room_notification_settings" ADD CONSTRAINT "room_notification_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_notification_settings" ADD CONSTRAINT "room_notification_settings_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_message_directed_recipients" ADD CONSTRAINT "session_message_directed_recipients_message_id_session_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."session_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_message_directed_recipients" ADD CONSTRAINT "session_message_directed_recipients_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subthread_notification_participants" ADD CONSTRAINT "subthread_notification_participants_subthread_room_id_rooms_id_fk" FOREIGN KEY ("subthread_room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subthread_notification_participants" ADD CONSTRAINT "subthread_notification_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subthread_notification_participants" ADD CONSTRAINT "subthread_notification_participants_from_message_id_session_messages_id_fk" FOREIGN KEY ("from_message_id") REFERENCES "public"."session_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_notification_settings" ADD CONSTRAINT "user_notification_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_room_notification_settings_room" ON "room_notification_settings" USING btree ("room_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_smdr_recipient_message" ON "session_message_directed_recipients" USING btree ("recipient_id","message_id");--> statement-breakpoint
CREATE INDEX "idx_snp_user_room_message" ON "subthread_notification_participants" USING btree ("user_id","subthread_room_id","from_message_id");--> statement-breakpoint
CREATE INDEX "idx_session_messages_human_turn_id" ON "session_messages" USING btree ("human_turn_id") WHERE "session_messages"."human_turn_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "session_messages" ADD CONSTRAINT "session_messages_human_turn_id_role_check" CHECK ("session_messages"."human_turn_id" IS NULL OR "session_messages"."role" = 'user');--> statement-breakpoint

-- M233 historical direct-Room materialization. Room shape is intentionally
-- evaluated at rollout time because membership-at-message-time is unavailable.
WITH two_actor_rooms AS (
	SELECT "room_id"
	FROM "room_members"
	GROUP BY "room_id"
	HAVING count(*) = 2
)
INSERT INTO "session_message_directed_recipients"
	("message_id", "recipient_id", "reason")
SELECT
	sm."id",
	recipient_actor."owner_id",
	'direct_room'
FROM "session_messages" sm
INNER JOIN "sessions" s ON s."id" = sm."session_id"
INNER JOIN two_actor_rooms two ON two."room_id" = s."room_id"
INNER JOIN "room_members" recipient_member
	ON recipient_member."room_id" = s."room_id"
INNER JOIN "actors" recipient_actor
	ON recipient_actor."id" = recipient_member."actor_id"
	AND recipient_actor."kind" = 'user'
WHERE sm."role" IN ('user', 'assistant')
	AND sm."transcript_origin" = 'main'
	AND (sm."metadata"->>'originatedBy') IS DISTINCT FROM 'task'
	AND (sm."role" <> 'assistant' OR sm."content" <> '')
	AND (sm."role" <> 'user' OR s."owner_id" <> recipient_actor."owner_id")
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- M233 historical explicit replies derive only from the durable same-Room
-- reply edge and Human authorship. Plaintext mention and Agent causality are
-- deliberately never reconstructed.
INSERT INTO "session_message_directed_recipients"
	("message_id", "recipient_id", "reason")
SELECT
	reply_message."id",
	parent_session."owner_id",
	'explicit_reply'
FROM "session_messages" reply_message
INNER JOIN "sessions" reply_session
	ON reply_session."id" = reply_message."session_id"
INNER JOIN "session_messages" parent_message
	ON parent_message."id" = reply_message."reply_to_message_id"
INNER JOIN "sessions" parent_session
	ON parent_session."id" = parent_message."session_id"
WHERE reply_message."role" IN ('user', 'assistant')
	AND reply_message."transcript_origin" = 'main'
	AND (reply_message."metadata"->>'originatedBy') IS DISTINCT FROM 'task'
	AND (reply_message."role" <> 'assistant' OR reply_message."content" <> '')
	AND parent_message."role" = 'user'
	AND parent_message."transcript_origin" = 'main'
	AND (parent_message."metadata"->>'originatedBy') IS DISTINCT FROM 'task'
	AND parent_session."room_id" = reply_session."room_id"
	AND (
		reply_message."role" <> 'user'
		OR reply_session."owner_id" <> parent_session."owner_id"
	)
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- M233 exact nautilo_agent authority. Broad public-table defaults are
-- reconciled after the new tables exist.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nautilo_agent') THEN
		REVOKE ALL ON TABLE "user_notification_settings" FROM "nautilo_agent";
		REVOKE ALL ON TABLE "room_notification_settings" FROM "nautilo_agent";
		REVOKE ALL ON TABLE "session_message_directed_recipients" FROM "nautilo_agent";
		REVOKE ALL ON TABLE "subthread_notification_participants" FROM "nautilo_agent";
		GRANT SELECT, INSERT ON TABLE "session_message_directed_recipients" TO "nautilo_agent";
		GRANT SELECT, INSERT ON TABLE "subthread_notification_participants" TO "nautilo_agent";
	END IF;
END $$;
