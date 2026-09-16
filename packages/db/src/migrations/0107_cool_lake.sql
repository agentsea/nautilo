CREATE TABLE "subthread_user_focus" (
	"subthread_room_id" uuid NOT NULL,
	"user_actor_id" uuid NOT NULL,
	"bot_actor_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"source" text,
	"established_message_id" integer,
	"established_at" timestamp with time zone,
	"revision" integer DEFAULT 0 NOT NULL,
	"invalidated_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subthread_user_focus_subthread_room_id_user_actor_id_pk" PRIMARY KEY("subthread_room_id","user_actor_id"),
	CONSTRAINT "subthread_user_focus_status_check" CHECK ("subthread_user_focus"."status" IN ('active', 'cleared', 'invalidated')),
	CONSTRAINT "subthread_user_focus_source_check" CHECK ("subthread_user_focus"."source" IS NULL OR "subthread_user_focus"."source" IN ('mention', 'reply', 'ui', 'inferred', 'affinity'))
);
--> statement-breakpoint
ALTER TABLE "subthread_user_focus" ADD CONSTRAINT "subthread_user_focus_subthread_room_id_rooms_id_fk" FOREIGN KEY ("subthread_room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subthread_user_focus" ADD CONSTRAINT "subthread_user_focus_user_actor_id_actors_id_fk" FOREIGN KEY ("user_actor_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subthread_user_focus" ADD CONSTRAINT "subthread_user_focus_bot_actor_id_actors_id_fk" FOREIGN KEY ("bot_actor_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_subthread_user_focus_bot" ON "subthread_user_focus" USING btree ("bot_actor_id");--> statement-breakpoint
CREATE INDEX "idx_subthread_user_focus_user" ON "subthread_user_focus" USING btree ("user_actor_id");