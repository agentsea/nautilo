CREATE TABLE "connected_web_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"service" varchar(128) NOT NULL,
	"origin" varchar(2048) NOT NULL,
	"label" varchar(256) NOT NULL,
	"status" varchar(32) DEFAULT 'connecting' NOT NULL,
	"profile_ref" text,
	"last_verified_at" timestamp with time zone,
	"execution_checkpoint" jsonb,
	"cleanup_state" varchar(16) DEFAULT 'not_required' NOT NULL,
	"cleanup_failure_code" varchar(128),
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connected_web_accounts_service_nonempty" CHECK (octet_length("connected_web_accounts"."service") between 1 and 128),
	CONSTRAINT "connected_web_accounts_origin_nonempty" CHECK (octet_length("connected_web_accounts"."origin") between 1 and 2048),
	CONSTRAINT "connected_web_accounts_label_nonempty" CHECK (octet_length("connected_web_accounts"."label") between 1 and 256),
	CONSTRAINT "connected_web_accounts_status_check" CHECK ("connected_web_accounts"."status" in ('connecting', 'connected', 'busy', 'attention_needed', 'expired', 'revoked', 'provider_unavailable', 'error')),
	CONSTRAINT "connected_web_accounts_cleanup_check" CHECK ("connected_web_accounts"."cleanup_state" in ('not_required', 'pending', 'failed', 'completed')),
	CONSTRAINT "connected_web_accounts_revocation_shape" CHECK (("connected_web_accounts"."status" = 'revoked' and "connected_web_accounts"."revoked_at" is not null) or ("connected_web_accounts"."status" <> 'revoked' and "connected_web_accounts"."revoked_at" is null))
);
--> statement-breakpoint
ALTER TABLE "connected_web_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "connected_web_accounts" ADD CONSTRAINT "connected_web_accounts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_connected_web_accounts_owner_updated" ON "connected_web_accounts" USING btree ("owner_user_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_connected_web_accounts_stale_execution" ON "connected_web_accounts" USING btree ("status","updated_at") WHERE "connected_web_accounts"."execution_checkpoint" IS NOT NULL;--> statement-breakpoint
CREATE POLICY "connected_web_accounts_product_all" ON "connected_web_accounts" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);