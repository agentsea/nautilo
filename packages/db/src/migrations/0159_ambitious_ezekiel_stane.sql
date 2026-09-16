CREATE TABLE "member_rollout_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rollout_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"handle" varchar(64) NOT NULL,
	"role_slug" varchar(32) NOT NULL,
	"target_group_id" uuid NOT NULL,
	"state" varchar(32) DEFAULT 'planned' NOT NULL,
	"receipt_id" uuid,
	"member_id" uuid,
	"error_code" varchar(64),
	"credential_disposition" varchar(32) DEFAULT 'none' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_rollout_items_sequence_check" CHECK ("member_rollout_items"."sequence" >= 0),
	CONSTRAINT "member_rollout_items_state_check" CHECK ("member_rollout_items"."state" IN ('planned', 'external_pending', 'nautilo_committed', 'credential_delivered', 'repair_required', 'complete', 'failed_before_change', 'unknown')),
	CONSTRAINT "member_rollout_items_credential_disposition_check" CHECK ("member_rollout_items"."credential_disposition" IN ('none', 'issued', 'not_reissued'))
);
--> statement-breakpoint
CREATE TABLE "member_rollouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_instance_id" uuid NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"manifest" jsonb NOT NULL,
	"status" varchar(32) DEFAULT 'applying' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_rollouts_fingerprint_check" CHECK ("member_rollouts"."fingerprint" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "member_rollouts_status_check" CHECK ("member_rollouts"."status" IN ('applying', 'complete', 'partial', 'repair_required'))
);
--> statement-breakpoint
ALTER TABLE "member_rollout_items" ADD CONSTRAINT "member_rollout_items_rollout_id_member_rollouts_id_fk" FOREIGN KEY ("rollout_id") REFERENCES "public"."member_rollouts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_rollout_items" ADD CONSTRAINT "member_rollout_items_member_id_users_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_rollouts" ADD CONSTRAINT "member_rollouts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_member_rollout_items_sequence" ON "member_rollout_items" USING btree ("rollout_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_member_rollout_items_handle" ON "member_rollout_items" USING btree ("rollout_id","handle");--> statement-breakpoint
CREATE INDEX "idx_member_rollout_items_state" ON "member_rollout_items" USING btree ("rollout_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_member_rollouts_instance_idempotency" ON "member_rollouts" USING btree ("server_instance_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_member_rollouts_created_by_created_at" ON "member_rollouts" USING btree ("created_by","created_at");