CREATE TABLE "focus_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"room_id" uuid NOT NULL,
	"user_actor_id" uuid NOT NULL,
	"bot_actor_id" uuid NOT NULL,
	"focus_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"source" text,
	"reason" text,
	"expires_at" timestamp with time zone,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "focus_events" ADD CONSTRAINT "focus_events_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "focus_events" ADD CONSTRAINT "focus_events_user_actor_id_actors_id_fk" FOREIGN KEY ("user_actor_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "focus_events" ADD CONSTRAINT "focus_events_bot_actor_id_actors_id_fk" FOREIGN KEY ("bot_actor_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_focus_events_room_user" ON "focus_events" USING btree ("room_id","user_actor_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_focus_events_focus_id" ON "focus_events" USING btree ("focus_id");--> statement-breakpoint
-- M134 — hand-added CHECK constraints (drizzle `text({enum})` is TS-only and
-- does not emit SQL CHECKs). Keep in lock-step with the enum lists in
-- packages/db/src/schema/focus.ts.
ALTER TABLE "focus_events"
  ADD CONSTRAINT "focus_events_event_type_check"
  CHECK ("event_type" IN ('opened','extended','expired','cleared'));--> statement-breakpoint
ALTER TABLE "focus_events"
  ADD CONSTRAINT "focus_events_source_check"
  CHECK ("source" IS NULL OR "source" IN ('mention','reply','ui','inferred'));