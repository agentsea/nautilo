CREATE TABLE "conversation_shadow_turn_agent_signers" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"agent_runtime_generation" bigint NOT NULL,
	"agent_signer_key_id" text NOT NULL,
	"agent_signer_public_key" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_shadow_turn_agent_signers_shape" CHECK ("conversation_shadow_turn_agent_signers"."agent_runtime_generation" >= 0
        and octet_length("conversation_shadow_turn_agent_signers"."agent_signer_key_id") between 1 and 128
        and "conversation_shadow_turn_agent_signers"."agent_signer_key_id" ~ '^agent_runtime_signer_[0-9a-f]{64}$'
        and octet_length("conversation_shadow_turn_agent_signers"."agent_signer_public_key") = 32)
);
--> statement-breakpoint
ALTER TABLE "conversation_shadow_turn_agent_signers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "conversation_shadow_turn_plan_attempts" (
	"sequence" serial PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"client_idempotency_key" text NOT NULL,
	"policy_revision" integer NOT NULL,
	"subject_user_id" uuid NOT NULL,
	"subject_human_actor_id" uuid NOT NULL,
	"state" text DEFAULT 'checking' NOT NULL,
	"unavailable_reason" text,
	"operation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_shadow_turn_plan_attempts_shape" CHECK ("conversation_shadow_turn_plan_attempts"."policy_revision" > 0
        and octet_length("conversation_shadow_turn_plan_attempts"."client_idempotency_key") between 1 and 128
        and "conversation_shadow_turn_plan_attempts"."client_idempotency_key" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and (
          ("conversation_shadow_turn_plan_attempts"."state" = 'checking'
            and "conversation_shadow_turn_plan_attempts"."unavailable_reason" is null
            and "conversation_shadow_turn_plan_attempts"."operation_id" is null)
          or ("conversation_shadow_turn_plan_attempts"."state" = 'unavailable'
            and "conversation_shadow_turn_plan_attempts"."unavailable_reason" is not null
            and "conversation_shadow_turn_plan_attempts"."operation_id" is null)
          or ("conversation_shadow_turn_plan_attempts"."state" = 'planned'
            and "conversation_shadow_turn_plan_attempts"."unavailable_reason" is null
            and "conversation_shadow_turn_plan_attempts"."operation_id" is not null)
        )),
	CONSTRAINT "conversation_shadow_turn_plan_attempts_time_order" CHECK ("conversation_shadow_turn_plan_attempts"."updated_at" >= "conversation_shadow_turn_plan_attempts"."created_at")
);
--> statement-breakpoint
ALTER TABLE "conversation_shadow_turn_plan_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversation_shadow_turn_agent_signers" ADD CONSTRAINT "conversation_shadow_turn_agent_signers_operation_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."conversation_shadow_turn_operations"("operation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_shadow_turn_plan_attempts" ADD CONSTRAINT "conversation_shadow_turn_plan_attempts_session_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_shadow_turn_plan_attempts" ADD CONSTRAINT "conversation_shadow_turn_plan_attempts_room_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_shadow_turn_plan_attempts" ADD CONSTRAINT "conversation_shadow_turn_plan_attempts_operation_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."conversation_shadow_turn_operations"("operation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_conversation_shadow_turn_plan_attempts_request" ON "conversation_shadow_turn_plan_attempts" USING btree ("session_id","client_idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_conversation_shadow_turn_plan_attempts_operation" ON "conversation_shadow_turn_plan_attempts" USING btree ("operation_id") WHERE "conversation_shadow_turn_plan_attempts"."operation_id" is not null;--> statement-breakpoint
CREATE POLICY "conversation_shadow_turn_agent_signers_product_all" ON "conversation_shadow_turn_agent_signers" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "conversation_shadow_turn_plan_attempts_product_all" ON "conversation_shadow_turn_plan_attempts" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- M282_LIVE_SHADOW_FOLLOWUP_AUTHORITY
ALTER TABLE "conversation_shadow_turn_agent_signers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "conversation_shadow_turn_agent_signers"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "conversation_shadow_turn_agent_signers"
  TO "nautilo";--> statement-breakpoint
ALTER TABLE "conversation_shadow_turn_plan_attempts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "conversation_shadow_turn_plan_attempts"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "conversation_shadow_turn_plan_attempts"
  TO "nautilo";--> statement-breakpoint
REVOKE ALL PRIVILEGES ON SEQUENCE "conversation_shadow_turn_plan_attempts_sequence_seq"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT USAGE ON SEQUENCE "conversation_shadow_turn_plan_attempts_sequence_seq" TO "nautilo";
