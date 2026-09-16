CREATE TABLE "room_silence_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"bot_actor_id" uuid,
	"kind" text NOT NULL,
	"set_by_user_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "room_silence_state_kind_check" CHECK ("room_silence_state"."kind" IN ('mute', 'deaf'))
);
--> statement-breakpoint
ALTER TABLE "room_silence_state" ADD CONSTRAINT "room_silence_state_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_silence_state" ADD CONSTRAINT "room_silence_state_bot_actor_id_actors_id_fk" FOREIGN KEY ("bot_actor_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_silence_state" ADD CONSTRAINT "room_silence_state_set_by_user_id_users_id_fk" FOREIGN KEY ("set_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_room_silence_state_room_expires" ON "room_silence_state" USING btree ("room_id","expires_at");