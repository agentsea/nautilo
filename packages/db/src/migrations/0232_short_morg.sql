CREATE TABLE "connected_web_action_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"delivery_id" varchar(256) NOT NULL,
	"request_digest" varchar(64) NOT NULL,
	"action_type" varchar(32) DEFAULT 'save_item' NOT NULL,
	"target" varchar(1024) NOT NULL,
	"status" varchar(32) NOT NULL,
	"opaque_run_ref" text,
	"receipt" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connected_web_action_operations_delivery_nonempty" CHECK (octet_length("connected_web_action_operations"."delivery_id") between 1 and 256),
	CONSTRAINT "connected_web_action_operations_digest" CHECK ("connected_web_action_operations"."request_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "connected_web_action_operations_type" CHECK ("connected_web_action_operations"."action_type" = 'save_item'),
	CONSTRAINT "connected_web_action_operations_target_nonempty" CHECK (octet_length("connected_web_action_operations"."target") between 1 and 1024),
	CONSTRAINT "connected_web_action_operations_status" CHECK ("connected_web_action_operations"."status" in ('reserving', 'running', 'verifying', 'completed', 'ambiguous', 'cancelled', 'authentication_required', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "connected_web_action_operations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "connected_web_operation_activity_entries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"operation_id" uuid NOT NULL,
	"control_epoch" bigint NOT NULL,
	"provider_event_id" bigint NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"status" varchar(16) NOT NULL,
	"summary" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connected_web_operation_activity_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "connected_web_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"initiating_agent_id" uuid NOT NULL,
	"initiating_room_id" uuid NOT NULL,
	"initiating_thread_id" varchar(512) NOT NULL,
	"initiating_lane" varchar(128) NOT NULL,
	"delivery_id" varchar(256) NOT NULL,
	"request_digest" varchar(64) NOT NULL,
	"sealed_intent" text NOT NULL,
	"action_operation_id" uuid,
	"effect_idempotency_key" varchar(256),
	"driver" varchar(16) DEFAULT 'hosted' NOT NULL,
	"lifecycle" varchar(16) DEFAULT 'admitted' NOT NULL,
	"control_epoch" bigint DEFAULT 1 NOT NULL,
	"control_lease_token" uuid DEFAULT gen_random_uuid() NOT NULL,
	"control_lease_expires_at" timestamp with time zone,
	"sealed_provider_refs" jsonb DEFAULT '{"version":1}'::jsonb NOT NULL,
	"event_cursor" bigint DEFAULT 0 NOT NULL,
	"safe_activity" jsonb NOT NULL,
	"wake_fingerprint" varchar(128),
	"next_check_at" timestamp with time zone,
	"supervisor_claim_owner" varchar(128),
	"supervisor_claim_expires_at" timestamp with time zone,
	"wake_claim_owner" varchar(128),
	"wake_claim_expires_at" timestamp with time zone,
	"wake_attempts" bigint DEFAULT 0 NOT NULL,
	"wake_delivered_at" timestamp with time zone,
	"cumulative_cost_usd_micros" bigint DEFAULT 0 NOT NULL,
	"remaining_budget_usd_micros" bigint NOT NULL,
	"terminal_receipt" jsonb,
	"terminal_read_result" jsonb,
	"terminal_at" timestamp with time zone,
	"browser_idle_until" timestamp with time zone,
	"browser_cleanup_started_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connected_web_operations_thread_nonempty" CHECK (octet_length("connected_web_operations"."initiating_thread_id") between 1 and 512),
	CONSTRAINT "connected_web_operations_lane_nonempty" CHECK (octet_length("connected_web_operations"."initiating_lane") between 1 and 128),
	CONSTRAINT "connected_web_operations_delivery_nonempty" CHECK (octet_length("connected_web_operations"."delivery_id") between 1 and 256),
	CONSTRAINT "connected_web_operations_digest" CHECK ("connected_web_operations"."request_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "connected_web_operations_sealed_intent_nonempty" CHECK (octet_length("connected_web_operations"."sealed_intent") between 1 and 16384),
	CONSTRAINT "connected_web_operations_effect_key_shape" CHECK ("connected_web_operations"."effect_idempotency_key" is null or octet_length("connected_web_operations"."effect_idempotency_key") between 1 and 256),
	CONSTRAINT "connected_web_operations_driver" CHECK ("connected_web_operations"."driver" in ('hosted', 'checking', 'direct', 'human')),
	CONSTRAINT "connected_web_operations_lifecycle" CHECK ("connected_web_operations"."lifecycle" in ('admitted', 'running', 'attention', 'terminal')),
	CONSTRAINT "connected_web_operations_epoch" CHECK ("connected_web_operations"."control_epoch" >= 1),
	CONSTRAINT "connected_web_operations_cursor" CHECK ("connected_web_operations"."event_cursor" >= 0),
	CONSTRAINT "connected_web_operations_cost" CHECK ("connected_web_operations"."cumulative_cost_usd_micros" >= 0 and "connected_web_operations"."remaining_budget_usd_micros" >= 0),
	CONSTRAINT "connected_web_operations_supervisor_claim" CHECK (("connected_web_operations"."supervisor_claim_owner" is null) = ("connected_web_operations"."supervisor_claim_expires_at" is null)),
	CONSTRAINT "connected_web_operations_wake_claim" CHECK (("connected_web_operations"."wake_claim_owner" is null) = ("connected_web_operations"."wake_claim_expires_at" is null)),
	CONSTRAINT "connected_web_operations_wake_attempts" CHECK ("connected_web_operations"."wake_attempts" >= 0),
	CONSTRAINT "connected_web_operations_terminal_shape" CHECK (("connected_web_operations"."lifecycle" = 'terminal') = ("connected_web_operations"."terminal_at" is not null) and ("connected_web_operations"."lifecycle" = 'terminal') = ("connected_web_operations"."terminal_receipt" is not null)),
	CONSTRAINT "connected_web_operations_provider_refs_shape" CHECK (
      jsonb_typeof("connected_web_operations"."sealed_provider_refs") = 'object'
      and "connected_web_operations"."sealed_provider_refs" ? 'version'
      and "connected_web_operations"."sealed_provider_refs" - 'version' - 'sessionRef' - 'runRef' - 'workspaceRef' - 'browserRef' = '{}'::jsonb
      and "connected_web_operations"."sealed_provider_refs"->>'version' = '1'
      and (not ("connected_web_operations"."sealed_provider_refs" ? 'sessionRef') or jsonb_typeof("connected_web_operations"."sealed_provider_refs"->'sessionRef') = 'string')
      and (not ("connected_web_operations"."sealed_provider_refs" ? 'runRef') or jsonb_typeof("connected_web_operations"."sealed_provider_refs"->'runRef') = 'string')
      and (not ("connected_web_operations"."sealed_provider_refs" ? 'workspaceRef') or jsonb_typeof("connected_web_operations"."sealed_provider_refs"->'workspaceRef') = 'string')
      and (not ("connected_web_operations"."sealed_provider_refs" ? 'browserRef') or jsonb_typeof("connected_web_operations"."sealed_provider_refs"->'browserRef') = 'string')
    ),
	CONSTRAINT "connected_web_operations_safe_activity_shape" CHECK (
      jsonb_typeof("connected_web_operations"."safe_activity") = 'object'
      and "connected_web_operations"."safe_activity" ?& array['version', 'phase', 'code', 'summary']
      and "connected_web_operations"."safe_activity" - 'version' - 'phase' - 'code' - 'summary' = '{}'::jsonb
      and "connected_web_operations"."safe_activity"->>'version' = '1'
      and "connected_web_operations"."safe_activity"->>'phase' in ('starting', 'working', 'checking', 'attention', 'finishing')
      and jsonb_typeof("connected_web_operations"."safe_activity"->'code') = 'string'
      and jsonb_typeof("connected_web_operations"."safe_activity"->'summary') = 'string'
    ),
	CONSTRAINT "connected_web_operations_terminal_receipt_shape" CHECK (
      "connected_web_operations"."terminal_receipt" is null or (
        jsonb_typeof("connected_web_operations"."terminal_receipt") = 'object'
        and "connected_web_operations"."terminal_receipt" ?& array['version', 'outcome', 'code', 'summary']
        and "connected_web_operations"."terminal_receipt" - 'version' - 'outcome' - 'code' - 'summary' - 'actionOperationId' = '{}'::jsonb
        and "connected_web_operations"."terminal_receipt"->>'version' = '1'
        and "connected_web_operations"."terminal_receipt"->>'outcome' in ('completed', 'cancelled', 'failed', 'attention_required', 'ambiguous')
      )
    ),
	CONSTRAINT "connected_web_operations_terminal_read_result_shape" CHECK (
      "connected_web_operations"."terminal_read_result" is null or (
        jsonb_typeof("connected_web_operations"."terminal_read_result") = 'object'
        and "connected_web_operations"."terminal_read_result"->>'version' = '1'
        and "connected_web_operations"."terminal_read_result" ?& array['version', 'account', 'page', 'read', 'cost', 'outputs', 'outputsTruncated']
        and "connected_web_operations"."terminal_read_result" - 'version' - 'account' - 'page' - 'read' - 'cost' - 'outputs' - 'outputsTruncated' = '{}'::jsonb
        and jsonb_typeof("connected_web_operations"."terminal_read_result"->'account') = 'object'
        and jsonb_typeof("connected_web_operations"."terminal_read_result"->'page') = 'object'
        and jsonb_typeof("connected_web_operations"."terminal_read_result"->'read') in ('null', 'object')
        and jsonb_typeof("connected_web_operations"."terminal_read_result"->'cost') = 'object'
        and "connected_web_operations"."terminal_read_result"->'outputs' = '[]'::jsonb
        and "connected_web_operations"."terminal_read_result"->>'outputsTruncated' = 'false'
      )
    ),
	CONSTRAINT "connected_web_operations_terminal_read_result_owner" CHECK (
      "connected_web_operations"."terminal_read_result" is null or ("connected_web_operations"."lifecycle" = 'terminal' and "connected_web_operations"."action_operation_id" is null)
    )
);
--> statement-breakpoint
ALTER TABLE "connected_web_operations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "connected_web_action_operations" ADD CONSTRAINT "connected_web_action_operations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connected_web_action_operations" ADD CONSTRAINT "connected_web_action_operations_account_id_connected_web_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_web_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connected_web_operation_activity_entries" ADD CONSTRAINT "connected_web_operation_activity_entries_operation_id_connected_web_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."connected_web_operations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connected_web_operations" ADD CONSTRAINT "connected_web_operations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connected_web_operations" ADD CONSTRAINT "connected_web_operations_account_id_connected_web_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_web_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connected_web_operations" ADD CONSTRAINT "connected_web_operations_initiating_agent_id_agents_id_fk" FOREIGN KEY ("initiating_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connected_web_operations" ADD CONSTRAINT "connected_web_operations_initiating_room_id_rooms_id_fk" FOREIGN KEY ("initiating_room_id") REFERENCES "public"."rooms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connected_web_operations" ADD CONSTRAINT "connected_web_operations_action_operation_id_connected_web_action_operations_id_fk" FOREIGN KEY ("action_operation_id") REFERENCES "public"."connected_web_action_operations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_connected_web_action_operations_account_updated" ON "connected_web_action_operations" USING btree ("account_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_connected_web_action_operations_owner_delivery" ON "connected_web_action_operations" USING btree ("owner_user_id","delivery_id");--> statement-breakpoint
CREATE INDEX "idx_connected_web_action_operations_reconcile" ON "connected_web_action_operations" USING btree ("status","updated_at") WHERE "connected_web_action_operations"."status" in ('reserving', 'running', 'verifying');--> statement-breakpoint
CREATE UNIQUE INDEX "uq_connected_web_activity_event" ON "connected_web_operation_activity_entries" USING btree ("operation_id","control_epoch","provider_event_id");--> statement-breakpoint
CREATE INDEX "idx_connected_web_activity_page" ON "connected_web_operation_activity_entries" USING btree ("operation_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_connected_web_operations_owner_delivery" ON "connected_web_operations" USING btree ("owner_user_id","delivery_id");--> statement-breakpoint
CREATE INDEX "idx_connected_web_operations_account_updated" ON "connected_web_operations" USING btree ("account_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_connected_web_operations_browser_idle" ON "connected_web_operations" USING btree ("browser_idle_until") WHERE "connected_web_operations"."browser_idle_until" is not null;--> statement-breakpoint
CREATE INDEX "idx_connected_web_operations_supervisor_due" ON "connected_web_operations" USING btree ("lifecycle","next_check_at","updated_at") WHERE "connected_web_operations"."lifecycle" in ('admitted', 'running', 'attention');--> statement-breakpoint
CREATE INDEX "idx_connected_web_operations_wake_due" ON "connected_web_operations" USING btree ("wake_delivered_at","updated_at") WHERE "connected_web_operations"."wake_fingerprint" is not null and "connected_web_operations"."wake_delivered_at" is null;--> statement-breakpoint
CREATE POLICY "connected_web_action_operations_product_all" ON "connected_web_action_operations" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "connected_web_activity_product_all" ON "connected_web_operation_activity_entries" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "connected_web_operations_product_all" ON "connected_web_operations" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);