CREATE TABLE "room_agent_model_control_selections" (
	"room_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"selection" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_agent_model_control_selections_room_id_agent_id_pk" PRIMARY KEY("room_id","agent_id")
);
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "default_model_control_selection" jsonb;--> statement-breakpoint
ALTER TABLE "room_agent_model_control_selections" ADD CONSTRAINT "room_agent_model_control_selections_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_agent_model_control_selections" ADD CONSTRAINT "room_agent_model_control_selections_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_room_agent_model_control_selections_agent" ON "room_agent_model_control_selections" USING btree ("agent_id");