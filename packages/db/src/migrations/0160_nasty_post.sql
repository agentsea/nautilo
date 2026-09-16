CREATE TABLE "agent_scope_close_operations" (
	"sequence" serial PRIMARY KEY NOT NULL,
	"operation_id" text NOT NULL,
	"scope_id" uuid NOT NULL,
	"parent_agent_id" uuid NOT NULL,
	"speaker_user_id" uuid NOT NULL,
	"source_scope_revision" integer NOT NULL,
	"captured_item_count" integer NOT NULL,
	"inventory_digest" "bytea" NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"terminal_at" timestamp with time zone,
	CONSTRAINT "uq_agent_scope_close_operations_id" UNIQUE("operation_id"),
	CONSTRAINT "uq_agent_scope_close_operations_scope" UNIQUE("scope_id"),
	CONSTRAINT "agent_scope_close_operations_id_portable" CHECK (octet_length("agent_scope_close_operations"."operation_id") between 1 and 128
        and "agent_scope_close_operations"."operation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "agent_scope_close_operations_source_revision_nonnegative" CHECK ("agent_scope_close_operations"."source_scope_revision" >= 0),
	CONSTRAINT "agent_scope_close_operations_item_count_bounded" CHECK ("agent_scope_close_operations"."captured_item_count" between 0 and 256),
	CONSTRAINT "agent_scope_close_operations_inventory_digest_size" CHECK (octet_length("agent_scope_close_operations"."inventory_digest") = 32),
	CONSTRAINT "agent_scope_close_operations_state_check" CHECK ("agent_scope_close_operations"."state" in ('active', 'complete', 'quarantined')),
	CONSTRAINT "agent_scope_close_operations_failure_code_check" CHECK ("agent_scope_close_operations"."failure_code" is null or "agent_scope_close_operations"."failure_code" in (
        'scope_state_conflict',
        'inventory_conflict',
        'uncaptured_item',
        'item_quarantined'
      )),
	CONSTRAINT "agent_scope_close_operations_terminal_coherent" CHECK ((
        "agent_scope_close_operations"."state" = 'active'
        and "agent_scope_close_operations"."failure_code" is null
        and "agent_scope_close_operations"."terminal_at" is null
      ) or (
        "agent_scope_close_operations"."state" = 'complete'
        and "agent_scope_close_operations"."failure_code" is null
        and "agent_scope_close_operations"."terminal_at" is not null
      ) or (
        "agent_scope_close_operations"."state" = 'quarantined'
        and "agent_scope_close_operations"."failure_code" is not null
        and "agent_scope_close_operations"."terminal_at" is not null
      ))
);
--> statement-breakpoint
CREATE TABLE "agent_scope_close_items" (
	"operation_id" text NOT NULL,
	"ordinal" smallint NOT NULL,
	"memory_id" uuid NOT NULL,
	"origin" text NOT NULL,
	"crypto_object_id" text NOT NULL,
	"expected_content_revision" integer NOT NULL,
	"expected_access_revision" integer NOT NULL,
	"expected_required_namespace_fingerprint" "bytea" NOT NULL,
	"source_origin_namespace_id" uuid,
	"action" text NOT NULL,
	"target_namespace_id" uuid,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempt_count" smallint DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claim_token" uuid,
	"claim_owner" text,
	"claim_expires_at" timestamp with time zone,
	"failure_code" text,
	"product_receipt_ref" text,
	"crypto_receipt_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"terminal_at" timestamp with time zone,
	CONSTRAINT "agent_scope_close_items_operation_id_ordinal_pk" PRIMARY KEY("operation_id","ordinal"),
	CONSTRAINT "uq_agent_scope_close_items_memory" UNIQUE("operation_id","memory_id"),
	CONSTRAINT "agent_scope_close_items_ordinal_bounded" CHECK ("agent_scope_close_items"."ordinal" between 0 and 255),
	CONSTRAINT "agent_scope_close_items_origin_check" CHECK ("agent_scope_close_items"."origin" in ('seed', 'scope')),
	CONSTRAINT "agent_scope_close_items_crypto_object_portable" CHECK (octet_length("agent_scope_close_items"."crypto_object_id") between 1 and 128
        and "agent_scope_close_items"."crypto_object_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "agent_scope_close_items_revisions_nonnegative" CHECK ("agent_scope_close_items"."expected_content_revision" > 0
        and "agent_scope_close_items"."expected_access_revision" >= 0),
	CONSTRAINT "agent_scope_close_items_fingerprint_size" CHECK (octet_length("agent_scope_close_items"."expected_required_namespace_fingerprint") = 32),
	CONSTRAINT "agent_scope_close_items_action_coherent" CHECK ((
        "agent_scope_close_items"."origin" = 'seed'
        and "agent_scope_close_items"."action" = 'detach_seed'
        and "agent_scope_close_items"."source_origin_namespace_id" is null
        and "agent_scope_close_items"."target_namespace_id" is null
      ) or (
        "agent_scope_close_items"."origin" = 'scope'
        and "agent_scope_close_items"."action" = 'promote_origin'
        and "agent_scope_close_items"."source_origin_namespace_id" is not null
        and "agent_scope_close_items"."target_namespace_id" is not null
      )),
	CONSTRAINT "agent_scope_close_items_attempt_bound" CHECK ("agent_scope_close_items"."attempt_count" between 0 and 8),
	CONSTRAINT "agent_scope_close_items_failure_code_check" CHECK ("agent_scope_close_items"."failure_code" is null or "agent_scope_close_items"."failure_code" in (
        'scope_state_conflict',
        'memory_state_conflict',
        'authorization_unavailable',
        'target_encryption_not_ready',
        'storage_transient',
        'retry_exhausted'
      )),
	CONSTRAINT "agent_scope_close_items_claim_owner_portable" CHECK ("agent_scope_close_items"."claim_owner" is null or (
        octet_length("agent_scope_close_items"."claim_owner") between 1 and 128
        and "agent_scope_close_items"."claim_owner" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
      )),
	CONSTRAINT "agent_scope_close_items_receipts_portable" CHECK (("agent_scope_close_items"."product_receipt_ref" is null or (
          octet_length("agent_scope_close_items"."product_receipt_ref") between 1 and 128
          and "agent_scope_close_items"."product_receipt_ref" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        )) and ("agent_scope_close_items"."crypto_receipt_ref" is null or (
          octet_length("agent_scope_close_items"."crypto_receipt_ref") between 1 and 128
          and "agent_scope_close_items"."crypto_receipt_ref" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        ))),
	CONSTRAINT "agent_scope_close_items_lifecycle_coherent" CHECK ((
        "agent_scope_close_items"."state" = 'pending'
        and "agent_scope_close_items"."claim_token" is null
        and "agent_scope_close_items"."claim_owner" is null
        and "agent_scope_close_items"."claim_expires_at" is null
        and "agent_scope_close_items"."failure_code" is null
        and "agent_scope_close_items"."product_receipt_ref" is null
        and "agent_scope_close_items"."crypto_receipt_ref" is null
        and "agent_scope_close_items"."terminal_at" is null
      ) or (
        "agent_scope_close_items"."state" = 'claimed'
        and "agent_scope_close_items"."claim_token" is not null
        and "agent_scope_close_items"."claim_owner" is not null
        and "agent_scope_close_items"."claim_expires_at" is not null
        and "agent_scope_close_items"."failure_code" is null
        and "agent_scope_close_items"."product_receipt_ref" is null
        and "agent_scope_close_items"."crypto_receipt_ref" is null
        and "agent_scope_close_items"."terminal_at" is null
      ) or (
        "agent_scope_close_items"."state" = 'complete'
        and "agent_scope_close_items"."claim_token" is null
        and "agent_scope_close_items"."claim_owner" is null
        and "agent_scope_close_items"."claim_expires_at" is null
        and "agent_scope_close_items"."failure_code" is null
        and "agent_scope_close_items"."product_receipt_ref" is not null
        and "agent_scope_close_items"."crypto_receipt_ref" is not null
        and "agent_scope_close_items"."terminal_at" is not null
      ) or (
        "agent_scope_close_items"."state" in ('stale', 'quarantined')
        and "agent_scope_close_items"."claim_token" is null
        and "agent_scope_close_items"."claim_owner" is null
        and "agent_scope_close_items"."claim_expires_at" is null
        and "agent_scope_close_items"."failure_code" is not null
        and "agent_scope_close_items"."product_receipt_ref" is null
        and "agent_scope_close_items"."crypto_receipt_ref" is null
        and "agent_scope_close_items"."terminal_at" is not null
      ))
);
--> statement-breakpoint
ALTER TABLE "agent_scopes" ADD COLUMN "lifecycle_state" text DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_scopes" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_scopes" ADD COLUMN "close_operation_id" text;--> statement-breakpoint
ALTER TABLE "agent_scope_close_operations" ADD CONSTRAINT "agent_scope_close_operations_parent_agent_id_agents_id_fk" FOREIGN KEY ("parent_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_scope_close_operations" ADD CONSTRAINT "agent_scope_close_operations_speaker_user_id_users_id_fk" FOREIGN KEY ("speaker_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_scope_close_items" ADD CONSTRAINT "agent_scope_close_items_operation_id_agent_scope_close_operations_operation_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."agent_scope_close_operations"("operation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_scope_close_operations_owner" ON "agent_scope_close_operations" USING btree ("parent_agent_id","speaker_user_id","sequence");--> statement-breakpoint
CREATE INDEX "idx_agent_scope_close_items_due" ON "agent_scope_close_items" USING btree ("state","next_attempt_at","operation_id","ordinal") WHERE "agent_scope_close_items"."state" in ('pending', 'claimed');--> statement-breakpoint
ALTER TABLE "agent_scopes" ADD CONSTRAINT "agent_scopes_lifecycle_state_check" CHECK ("agent_scopes"."lifecycle_state" in ('open', 'closing'));--> statement-breakpoint
ALTER TABLE "agent_scopes" ADD CONSTRAINT "agent_scopes_revision_nonnegative" CHECK ("agent_scopes"."revision" >= 0);--> statement-breakpoint
ALTER TABLE "agent_scopes" ADD CONSTRAINT "agent_scopes_close_operation_portable" CHECK ("agent_scopes"."close_operation_id" is null or (
        octet_length("agent_scopes"."close_operation_id") between 1 and 128
        and "agent_scopes"."close_operation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
      ));--> statement-breakpoint
ALTER TABLE "agent_scopes" ADD CONSTRAINT "agent_scopes_close_lifecycle_coherent" CHECK (("agent_scopes"."lifecycle_state" = 'open' and "agent_scopes"."close_operation_id" is null)
        or ("agent_scopes"."lifecycle_state" = 'closing' and "agent_scopes"."close_operation_id" is not null));