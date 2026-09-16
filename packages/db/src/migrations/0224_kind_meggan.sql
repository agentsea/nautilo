CREATE TABLE "human_crypto_device_group_join_requests" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"human_id" text NOT NULL,
	"lineage_generation" bigint NOT NULL,
	"target_device_id" text NOT NULL,
	"target_device_generation" bigint NOT NULL,
	"expected_head_digest" "bytea" NOT NULL,
	"request_bytes" "bytea" NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "human_crypto_device_group_join_requests_operation_id_portable" CHECK (octet_length("human_crypto_device_group_join_requests"."operation_id") between 1
      and 128
      and "human_crypto_device_group_join_requests"."operation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "human_crypto_device_group_join_requests_human_id_portable" CHECK (octet_length("human_crypto_device_group_join_requests"."human_id") between 1
      and 128
      and "human_crypto_device_group_join_requests"."human_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "human_crypto_device_group_join_requests_target_id_portable" CHECK (octet_length("human_crypto_device_group_join_requests"."target_device_id") between 1
      and 128
      and "human_crypto_device_group_join_requests"."target_device_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "human_crypto_device_group_join_requests_lineage_safe" CHECK ("human_crypto_device_group_join_requests"."lineage_generation" between 0 and 9007199254740991),
	CONSTRAINT "human_crypto_device_group_join_requests_target_generation_safe" CHECK ("human_crypto_device_group_join_requests"."target_device_generation" between 0 and 9007199254740991),
	CONSTRAINT "human_crypto_device_group_join_requests_head_digest_size" CHECK (octet_length("human_crypto_device_group_join_requests"."expected_head_digest") = 32),
	CONSTRAINT "human_crypto_device_group_join_requests_request_size" CHECK (octet_length("human_crypto_device_group_join_requests"."request_bytes") between 1
      and 1048616),
	CONSTRAINT "human_crypto_device_group_join_requests_state" CHECK ("human_crypto_device_group_join_requests"."state" in ('pending', 'consumed')),
	CONSTRAINT "human_crypto_device_group_join_requests_lifecycle" CHECK (("human_crypto_device_group_join_requests"."state" = 'pending' and "human_crypto_device_group_join_requests"."consumed_at" is null)
        or ("human_crypto_device_group_join_requests"."state" = 'consumed'
          and "human_crypto_device_group_join_requests"."consumed_at" >= "human_crypto_device_group_join_requests"."created_at"))
);
--> statement-breakpoint
ALTER TABLE "human_crypto_device_group_join_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "human_crypto_device_group_join_requests" ADD CONSTRAINT "human_crypto_device_group_join_requests_custody_fk" FOREIGN KEY ("human_id") REFERENCES "public"."human_crypto_custodies"("human_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_crypto_device_group_join_requests" ADD CONSTRAINT "human_crypto_device_group_join_requests_target_fk" FOREIGN KEY ("target_device_id","target_device_generation") REFERENCES "public"."human_crypto_devices"("device_id","device_generation") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_human_crypto_device_group_join_requests_pending" ON "human_crypto_device_group_join_requests" USING btree ("human_id","state","created_at");--> statement-breakpoint
CREATE POLICY "human_crypto_device_group_join_requests_crypto_sel" ON "human_crypto_device_group_join_requests" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "human_crypto_device_group_join_requests_crypto_ins" ON "human_crypto_device_group_join_requests" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "human_crypto_device_group_join_requests_crypto_upd" ON "human_crypto_device_group_join_requests" AS PERMISSIVE FOR UPDATE TO "nautilo_crypto" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "human_crypto_device_group_join_requests_crypto_del" ON "human_crypto_device_group_join_requests" AS PERMISSIVE FOR DELETE TO "nautilo_crypto" USING (true);
--> statement-breakpoint
-- M232_CRYPTO_DELIVERY_AUTHORITY--> statement-breakpoint
ALTER TABLE "human_crypto_device_group_join_requests" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE
  "human_crypto_device_group_join_requests"
FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  "human_crypto_device_group_join_requests"
TO "nautilo_crypto";
