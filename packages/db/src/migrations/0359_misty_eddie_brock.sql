CREATE TABLE "chatgpt_registrations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"server_instance_id" uuid NOT NULL,
	"host_id" text NOT NULL,
	"authority_revision" integer NOT NULL,
	"token_generation" integer NOT NULL,
	"selected" boolean DEFAULT false NOT NULL,
	"state" text NOT NULL,
	"identity_envelope" jsonb NOT NULL,
	"envelope" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chatgpt_registrations_versions" CHECK ("chatgpt_registrations"."authority_revision" >= 1 and "chatgpt_registrations"."token_generation" >= 1),
	CONSTRAINT "chatgpt_registrations_state" CHECK ("chatgpt_registrations"."state" in ('connected', 'reconnect_required', 'disconnected')),
	CONSTRAINT "chatgpt_registrations_envelope" CHECK (("chatgpt_registrations"."state" = 'connected' and "chatgpt_registrations"."envelope" is not null) or ("chatgpt_registrations"."state" <> 'connected' and "chatgpt_registrations"."envelope" is null))
);
--> statement-breakpoint
ALTER TABLE "chatgpt_registrations" ADD CONSTRAINT "chatgpt_registrations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_chatgpt_registrations_user_client" ON "chatgpt_registrations" USING btree ("user_id","client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_chatgpt_registrations_selected" ON "chatgpt_registrations" USING btree ("user_id") WHERE "chatgpt_registrations"."selected" = true;
--> statement-breakpoint
-- ChatGPT registration custody permissions
REVOKE ALL PRIVILEGES ON TABLE "chatgpt_registrations"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chatgpt_registrations"
  TO "nautilo";
